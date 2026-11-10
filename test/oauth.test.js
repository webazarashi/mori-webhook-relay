import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError, TokenEndpointError, TokenManager, assertTrustedTokenEndpoint } from "../src/oauth.js";
import { createMemoryKV } from "./helpers/kv.js";

const NOW = Date.parse("2026-11-05T00:00:00Z");
const baseRecord = (over = {}) => ({
  client_id: "cid",
  client_secret: null,
  token_endpoint: "https://mcp.test/oauth/token",
  resource: "https://mcp.test",
  access_token: "at-old",
  access_expires_at: NOW - 1000,
  refresh_token: "rt-1",
  updated_at: "2026-11-04T00:00:00Z",
  ...over,
});

const tokenFetch = (handler) => async (url, init) => handler(new URLSearchParams(init.body), url);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("期限内ならリフレッシュしない", async () => {
  const kv = createMemoryKV({ oauth: JSON.stringify(baseRecord({ access_expires_at: NOW + 3600_000 })) });
  const tm = new TokenManager({ kv, now: () => NOW, fetch: async () => assert.fail("呼ばれないはず") });
  assert.equal(await tm.getAccessToken(), "at-old");
  assert.equal(kv.writes, 0);
});

test("新しい refresh_token は使う前に KV に保存される", async () => {
  const kv = createMemoryKV({ oauth: JSON.stringify(baseRecord()) });
  let seen;
  const tm = new TokenManager({
    kv,
    now: () => NOW,
    fetch: tokenFetch((p) => {
      seen = p;
      return json({ access_token: "at-2", expires_in: 3600, refresh_token: "rt-2" });
    }),
  });
  assert.equal(await tm.getAccessToken(), "at-2");
  assert.equal(seen.get("grant_type"), "refresh_token");
  assert.equal(seen.get("resource"), "https://mcp.test");
  const saved = JSON.parse(kv.store.get("oauth"));
  assert.equal(saved.refresh_token, "rt-2");
  assert.equal(saved.access_expires_at, NOW + 3600_000);
  assert.equal(tm.lastRefresh.refreshTokenRotated, true);
});

test("refresh_token が返らなければ既存のものを保持する", async () => {
  const kv = createMemoryKV({ oauth: JSON.stringify(baseRecord()) });
  const tm = new TokenManager({ kv, now: () => NOW, fetch: tokenFetch(() => json({ access_token: "at-2", expires_in: 3600 })) });
  await tm.getAccessToken();
  assert.equal(JSON.parse(kv.store.get("oauth")).refresh_token, "rt-1");
});

test("invalid_grant は AuthError（KV が変わっていなければ）", async () => {
  const kv = createMemoryKV({ oauth: JSON.stringify(baseRecord()) });
  const tm = new TokenManager({ kv, now: () => NOW, fetch: tokenFetch(() => json({ error: "invalid_grant" }, 400)) });
  await assert.rejects(tm.getAccessToken(), AuthError);
});

test("invalid_grant でも KV が別の実行で更新済みならその値でやり直す", async () => {
  const kv = createMemoryKV({ oauth: JSON.stringify(baseRecord()) });
  const tm = new TokenManager({
    kv,
    now: () => NOW,
    fetch: tokenFetch((p) => {
      if (p.get("refresh_token") === "rt-1") {
        // 別の実行がローテーションした
        kv.store.set("oauth", JSON.stringify(baseRecord({ refresh_token: "rt-9", access_token: "at-9", access_expires_at: NOW + 3600_000 })));
        return json({ error: "invalid_grant" }, 400);
      }
      return assert.fail("期限内のトークンがあるので呼ばれないはず");
    }),
  });
  assert.equal(await tm.getAccessToken(), "at-9");
});

test("5xx は TokenEndpointError（再ログイン不要）", async () => {
  const kv = createMemoryKV({ oauth: JSON.stringify(baseRecord()) });
  const tm = new TokenManager({ kv, now: () => NOW, fetch: tokenFetch(() => json({}, 503)) });
  await assert.rejects(tm.getAccessToken(), TokenEndpointError);
});

test("token_endpoint は MCP と同じホストの https に限る", () => {
  assert.throws(() => assertTrustedTokenEndpoint("https://evil.test/token", "https://mcp.test"), AuthError);
  assert.throws(() => assertTrustedTokenEndpoint("http://mcp.test/token", "https://mcp.test"), AuthError);
  assertTrustedTokenEndpoint("https://mcp.test/oauth/token", "https://mcp.test");
});
