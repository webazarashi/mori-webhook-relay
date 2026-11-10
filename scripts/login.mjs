#!/usr/bin/env node
// Mori MCP に OAuth でログインし、トークンをファイルに保存する（ローカル専用）
//
//   node scripts/login.mjs                         # → auth.local.json（調査・dry-run 用）
//   node scripts/login.mjs --out auth.worker.json  # → Worker 用（KV に入れたら削除する）
//
// オプション: --out <file> / --mcp-url <url> / --port 8976 / --no-open
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { buildAuthorizeUrl, createPkce, exchangeCode, randomToken, readCallbackCode, registerClient } from "../src/login-flow.js";
import { DEFAULT_MCP_URL, discoverOAuthMetadata } from "../src/oauth.js";
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
      let result;
      try {
        result = readCallbackCode(p, { issuer: meta.issuer, issParameterSupported: meta.iss_parameter_supported });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("ログイン失敗", "ターミナルのメッセージを確認してください。"));
        finish(e);
        return;
      }
      if (result.missingIss) console.warn("⚠️  サーバーは iss パラメーター対応を公開していますが、応答に iss がありませんでした");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("ログインしました", "このタブは閉じてかまいません。ターミナルに戻ってください。"));
      finish(null, result.code);
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
  const client = await registerClient({ meta, redirectUri: REDIRECT_URI });
  const { verifier, challenge } = await createPkce();
  const state = randomToken(16);
  const authUrl = buildAuthorizeUrl({ meta, client, redirectUri: REDIRECT_URI, challenge, state });

  const callback = waitForCallback(state, meta);
  console.log("\n🌐 ブラウザで Mori にログインしてください。開かない場合は次の URL を開いてください:\n");
  console.log(`   ${authUrl}\n`);
  if (args.open) openBrowser(authUrl);

  const code = await callback;
  const out = await exchangeCode({ client, code, verifier, redirectUri: REDIRECT_URI });
  await writePrivateFile(args.out, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`✅ ログインしました。${args.out} に保存しました（権限 600）。`);
  console.log("   このファイルはリポジトリにコミットしないでください（.gitignore 済み）。");
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
