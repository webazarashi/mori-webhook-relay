#!/usr/bin/env node
// Mori MCP に OAuth でログインし、トークンをファイルに保存する（ローカル専用）
//
//   node scripts/login.mjs                         # → auth.local.json（調査・dry-run 用）
//   node scripts/login.mjs --out auth.worker.json  # → Worker 用（KV に入れたら削除する）
//
// オプション: --out <file> / --mcp-url <url> / --port 8976 / --no-open
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { DEFAULT_MCP_URL, DEFAULT_SCOPE, assertTrustedTokenEndpoint, discoverOAuthMetadata, postTokenRequest } from "../src/oauth.js";
import { parseArgs } from "./lib/args.mjs";
import { writePrivateFile } from "./lib/file-kv.mjs";

const args = parseArgs(process.argv.slice(2), {
  out: "auth.local.json",
  mcpUrl: DEFAULT_MCP_URL,
  port: "8976",
  open: true,
});
const PORT = Number(args.port);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // 開けなくても、URL は画面に出しているので問題ない
  }
}

function page(title, message) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;padding:2em"><h1>${title}</h1><p>${message}</p></body>`;
}

/** localhost でリダイレクトを 1 回だけ受ける */
function waitForCallback(expectedState, meta) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const p = url.searchParams;
      const finish = (err, value) => {
        clearTimeout(timer);
        server.close();
        if (err) reject(err);
        else resolve(value);
      };
      if (p.get("state") !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("ログイン失敗", "state が一致しません。もう一度やり直してください。"));
        finish(new Error("state が一致しません（別のログイン画面の応答の可能性があります）"));
        return;
      }
      const iss = p.get("iss");
      if (iss && iss !== meta.issuer) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("ログイン失敗", "発行元 (iss) が一致しません。"));
        finish(new Error(`iss が一致しません: ${iss}`));
        return;
      }
      if (!iss && meta.iss_parameter_supported) {
        console.warn("⚠️  サーバーは iss パラメーター対応を公開していますが、応答に iss がありませんでした");
      }
      if (p.get("error")) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("ログイン失敗", "認可が拒否されました。"));
        finish(new Error(`認可エラー: ${p.get("error")} ${p.get("error_description") || ""}`.trim()));
        return;
      }
      const code = p.get("code");
      if (!code) {
        res.writeHead(400).end();
        finish(new Error("認可コードがありません"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("ログインしました", "このタブは閉じてかまいません。ターミナルに戻ってください。"));
      finish(null, code);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("5 分以内にログインが完了しませんでした"));
    }, LOGIN_TIMEOUT_MS);
    server.on("error", (e) => {
      clearTimeout(timer);
      reject(e.code === "EADDRINUSE" ? new Error(`ポート ${PORT} が使用中です（lsof -i :${PORT} で確認してください）`) : e);
    });
    server.listen(PORT, "127.0.0.1");
  });
}

async function main() {
  if (existsSync(args.out)) console.warn(`⚠️  ${args.out} は上書きされます`);

  console.log(`🔎 ${args.mcpUrl} の OAuth 設定を確認しています…`);
  const meta = await discoverOAuthMetadata({ mcpUrl: args.mcpUrl });
  if (!meta.discovered) console.warn("⚠️  メタデータが取得できなかったため、既定の URL を使います");
  assertTrustedTokenEndpoint(meta.token_endpoint, meta.resource);

  // 動的クライアント登録
  const scope = DEFAULT_SCOPE;
  const regRes = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "mori-webhook-relay",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope,
    }),
  });
  if (!regRes.ok) throw new Error(`クライアント登録に失敗しました (HTTP ${regRes.status}): ${(await regRes.text()).slice(0, 200)}`);
  const reg = await regRes.json();
  if (!reg.client_id) throw new Error("クライアント登録の応答に client_id がありません");

  // PKCE と state
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope,
    resource: meta.resource,
  }).toString();

  const callback = waitForCallback(state, meta);
  console.log("\n🌐 ブラウザで Mori にログインしてください。開かない場合は次の URL を開いてください:\n");
  console.log(`   ${authUrl.toString()}\n`);
  if (args.open) openBrowser(authUrl.toString());

  const code = await callback;

  const record = {
    client_id: reg.client_id,
    client_secret: reg.client_secret ?? null,
    token_endpoint_auth_method: reg.token_endpoint_auth_method || "none",
    token_endpoint: meta.token_endpoint,
    resource: meta.resource,
    scope,
  };
  const tok = await postTokenRequest(fetch, record, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    resource: meta.resource,
  });
  if (!tok.refresh_token) throw new Error("リフレッシュトークンが返りませんでした（定期実行に必要です）");

  const now = Date.now();
  const out = {
    ...record,
    scope: typeof tok.scope === "string" ? tok.scope : scope,
    access_token: tok.access_token,
    access_expires_at: now + (Number(tok.expires_in) > 0 ? Number(tok.expires_in) : 3600) * 1000,
    refresh_token: tok.refresh_token,
    updated_at: new Date(now).toISOString(),
  };
  await writePrivateFile(args.out, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`✅ ログインしました。${args.out} に保存しました（権限 600）。`);
  console.log("   このファイルはリポジトリにコミットしないでください（.gitignore 済み）。");
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
