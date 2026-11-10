// ブラウザから Mori にログインする（/setup）
//
//   GET  /setup           ADMIN_TOKEN を入れるフォーム
//   POST /setup           ADMIN_TOKEN を確かめ、クライアント登録と PKCE をして Mori の認可画面へ送る
//   GET  /setup/callback  Mori から戻ってきたら、コードをトークンに換えて KV の oauth に保存する
//
// ログイン途中の情報（PKCE の verifier など）は KV の `setup:<state>` に 10 分だけ置く。
import { buildAuthorizeUrl, createPkce, exchangeCode, randomToken, readCallbackCode, registerClient } from "./login-flow.js";
import { escapeHtml, html, tokenMatches } from "./http.js";
import { DEFAULT_MCP_URL, discoverOAuthMetadata } from "./oauth.js";
import { KEY_OAUTH } from "./poller.js";

const PENDING_PREFIX = "setup:";
const PENDING_TTL_SEC = 600;
const STATE_RE = /^[A-Za-z0-9_-]{16,64}$/;

function formPage({ error = null, status = 200 } = {}) {
  const err = error ? `<p style="color:#dc2626">${escapeHtml(error)}</p>` : "";
  return html(
    "mori-webhook-relay: Mori にログイン",
    `<p>この Worker が Mori MCP を読むためのログインです。デプロイ時に決めた <code>ADMIN_TOKEN</code> を入れてください。</p>
${err}
<form method="post" action="/setup">
<label for="token">ADMIN_TOKEN</label>
<input id="token" name="token" type="password" autocomplete="current-password" required>
<button type="submit">Mori にログインする</button>
</form>
<p class="note">ログインすると、Mori のトークンはこの Worker の KV（<code>oauth</code>）にだけ保存されます。前のログインは置き換わります。</p>`,
    status,
  );
}

function errorPage(message, status = 400) {
  return html(
    "ログインできませんでした",
    `<p>${escapeHtml(message)}</p><p><a href="/setup">/setup からやり直す</a></p>`,
    status,
  );
}

async function start(request, env, fetchImpl) {
  let token = "";
  try {
    token = String((await request.formData()).get("token") || "");
  } catch {
    token = "";
  }
  if (!token || !(await tokenMatches(token, env.ADMIN_TOKEN))) {
    return formPage({ error: "ADMIN_TOKEN が違います。", status: 401 });
  }
  const mcpUrl = env.MCP_URL || DEFAULT_MCP_URL;
  const redirectUri = `${new URL(request.url).origin}/setup/callback`;
  try {
    const meta = await discoverOAuthMetadata({ fetch: fetchImpl, mcpUrl });
    const client = await registerClient({ fetch: fetchImpl, meta, redirectUri });
    const { verifier, challenge } = await createPkce();
    const state = randomToken(24);
    const pending = {
      client,
      verifier,
      redirectUri,
      issuer: meta.issuer,
      issParameterSupported: meta.iss_parameter_supported,
    };
    await env.MORI_KV.put(PENDING_PREFIX + state, JSON.stringify(pending), { expirationTtl: PENDING_TTL_SEC });
    const location = buildAuthorizeUrl({ meta, client, redirectUri, challenge, state });
    return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  } catch (e) {
    return errorPage(`Mori のログイン画面を用意できませんでした（${String(e?.message || e).slice(0, 300)}）`, 502);
  }
}

async function finish(request, env, fetchImpl) {
  const params = new URL(request.url).searchParams;
  const state = params.get("state") || "";
  if (!STATE_RE.test(state)) return errorPage("state がありません。");
  const raw = await env.MORI_KV.get(PENDING_PREFIX + state);
  if (!raw) return errorPage("ログインの有効期限（10 分）が切れたか、すでに使われたリンクです。");
  // 同じ state は 1 回しか使わない
  await env.MORI_KV.delete(PENDING_PREFIX + state);
  let pending;
  try {
    pending = JSON.parse(raw);
  } catch {
    return errorPage("ログインの途中情報が壊れています。");
  }
  try {
    const { code } = readCallbackCode(params, {
      issuer: pending.issuer,
      issParameterSupported: pending.issParameterSupported,
    });
    const record = await exchangeCode({
      fetch: fetchImpl,
      client: pending.client,
      code,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
    });
    await env.MORI_KV.put(KEY_OAUTH, JSON.stringify(record));
  } catch (e) {
    return errorPage(String(e?.message || e).slice(0, 300), 400);
  }
  return html(
    "Mori にログインしました",
    `<p>この Worker は 15 分以内の次の実行から Mori を確認します。このタブは閉じてかまいません。</p>
<p class="note">はじめての実行では、その時刻より前に始まったセッションは送りません（<code>START_FROM</code> で変えられます）。</p>`,
  );
}

/**
 * /setup 系のリクエストなら応答を返す。それ以外は null。
 * ADMIN_TOKEN が未設定のときは呼ばない（index.js で 404 にする）。
 */
export async function handleSetup(request, env, { fetch: fetchImpl = (...a) => fetch(...a) } = {}) {
  const { pathname } = new URL(request.url);
  if (pathname === "/setup") {
    if (request.method === "GET") return formPage();
    if (request.method === "POST") return start(request, env, fetchImpl);
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, POST" } });
  }
  if (pathname === "/setup/callback" && request.method === "GET") return finish(request, env, fetchImpl);
  return null;
}
