import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import worker from "../src/index.js";
import { handleSetup } from "../src/setup.js";
import { createMemoryKV } from "./helpers/kv.js";

const ORIGIN = "https://relay.example.workers.dev";
const MCP = "https://mcp.test";
const NOW_ISO = /^\d{4}-\d{2}-\d{2}T/;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Mori の OAuth サーバーのモック。呼ばれた内容を calls に残す */
function mockMori({ issuer = MCP, tokenStatus = 200 } = {}) {
  const calls = { register: [], token: [] };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return json({ resource: MCP, authorization_servers: [MCP] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer,
        authorization_endpoint: `${MCP}/authorize`,
        token_endpoint: `${MCP}/oauth/token`,
        registration_endpoint: `${MCP}/register`,
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.pathname === "/register") {
      calls.register.push(JSON.parse(init.body));
      return json({ client_id: "cid-1", token_endpoint_auth_method: "none" }, 201);
    }
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(init.body);
      calls.token.push(Object.fromEntries(form));
      if (tokenStatus !== 200) return json({ error: "invalid_grant" }, tokenStatus);
      return json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, token_type: "Bearer" });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchImpl, calls };
}

const env = (over = {}) => ({ MORI_KV: createMemoryKV(), ADMIN_TOKEN: "admin-token-0123456789", MCP_URL: MCP, ...over });
const post = (token) =>
  new Request(`${ORIGIN}/setup`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });

async function startLogin(e, mori) {
  const res = await handleSetup(post("admin-token-0123456789"), e, { fetch: mori.fetch });
  assert.equal(res.status, 303);
  return new URL(res.headers.get("location"));
}

test("/setup: ADMIN_TOKEN が未設定なら 404", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/setup`), { MORI_KV: createMemoryKV() });
  assert.equal(res.status, 404);
});

test("/setup: GET はフォームを返し、埋め込みとキャッシュを禁止する", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/setup`), env());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(await res.text(), /name="token"/);
});

test("/setup: ADMIN_TOKEN が違えば 401 で、Mori にも KV にも触らない", async () => {
  const e = env();
  const res = await handleSetup(post("wrong"), e, { fetch: async () => assert.fail("呼ばれないはず") });
  assert.equal(res.status, 401);
  assert.equal(e.MORI_KV.writes, 0);
});

test("/setup: 正しい ADMIN_TOKEN なら、Worker 自身の /setup/callback を戻り先にして Mori の認可画面へ送る", async () => {
  const e = env();
  const mori = mockMori();
  const loc = await startLogin(e, mori);
  assert.equal(loc.origin + loc.pathname, `${MCP}/authorize`);
  assert.equal(loc.searchParams.get("client_id"), "cid-1");
  assert.equal(loc.searchParams.get("redirect_uri"), `${ORIGIN}/setup/callback`);
  assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
  assert.equal(loc.searchParams.get("resource"), MCP);
  assert.deepEqual(mori.calls.register[0].redirect_uris, [`${ORIGIN}/setup/callback`]);
  const state = loc.searchParams.get("state");
  assert.ok(e.MORI_KV.store.has(`setup:${state}`), "途中の情報を KV に置く");
  assert.ok(!e.MORI_KV.store.has("oauth"), "まだ oauth は書かない");
});

test("/setup/callback: コードをトークンに換えて KV の oauth に保存し、同じ state は 2 回使えない", async () => {
  const e = env();
  const mori = mockMori();
  const loc = await startLogin(e, mori);
  const state = loc.searchParams.get("state");
  const cb = `${ORIGIN}/setup/callback?code=code-1&state=${state}&iss=${encodeURIComponent(MCP)}`;
  const res = await handleSetup(new Request(cb), e, { fetch: mori.fetch });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");

  const tok = mori.calls.token[0];
  assert.equal(tok.grant_type, "authorization_code");
  assert.equal(tok.code, "code-1");
  assert.equal(tok.redirect_uri, `${ORIGIN}/setup/callback`);
  const challenge = createHash("sha256").update(tok.code_verifier).digest("base64url");
  assert.equal(challenge, loc.searchParams.get("code_challenge"), "PKCE の verifier が対応している");

  const saved = JSON.parse(e.MORI_KV.store.get("oauth"));
  assert.equal(saved.client_id, "cid-1");
  assert.equal(saved.refresh_token, "rt-1");
  assert.equal(saved.token_endpoint, `${MCP}/oauth/token`);
  assert.equal(saved.resource, MCP);
  assert.match(saved.updated_at, NOW_ISO);
  assert.ok(!e.MORI_KV.store.has(`setup:${state}`), "途中の情報は消す");

  const again = await handleSetup(new Request(cb), e, { fetch: mori.fetch });
  assert.equal(again.status, 400);
  assert.equal(mori.calls.token.length, 1);
});

test("/setup/callback: 知らない state・iss の不一致・認可の拒否・トークン交換の失敗では oauth を書かない", async () => {
  const cases = [
    { name: "知らない state", query: () => "code=c&state=unknown-state-0000000" },
    { name: "iss の不一致", query: (s) => `code=c&state=${s}&iss=${encodeURIComponent("https://evil.test")}` },
    { name: "認可の拒否", query: (s) => `error=access_denied&state=${s}` },
    { name: "トークン交換の失敗", query: (s) => `code=c&state=${s}&iss=${encodeURIComponent(MCP)}`, tokenStatus: 400 },
  ];
  for (const c of cases) {
    const e = env();
    const mori = mockMori({ tokenStatus: c.tokenStatus ?? 200 });
    const state = (await startLogin(e, mori)).searchParams.get("state");
    const res = await handleSetup(new Request(`${ORIGIN}/setup/callback?${c.query(state)}`), e, { fetch: mori.fetch });
    assert.equal(res.status, 400, c.name);
    assert.ok(!e.MORI_KV.store.has("oauth"), `${c.name}: oauth は書かない`);
    const body = await res.text();
    assert.ok(!body.includes("rt-1") && !body.includes("at-1"), `${c.name}: トークンを画面に出さない`);
  }
});

test("/status: ログイン済みかどうかを返す（トークンは返さない）", async () => {
  const e = env();
  const status = () =>
    worker.fetch(new Request(`${ORIGIN}/status`, { headers: { authorization: "Bearer admin-token-0123456789" } }), e).then((r) => r.json());
  assert.equal((await status()).loggedIn, false);
  e.MORI_KV.store.set("oauth", JSON.stringify({ refresh_token: "secret" }));
  const body = await status();
  assert.equal(body.loggedIn, true);
  assert.ok(!JSON.stringify(body).includes("secret"));
});
