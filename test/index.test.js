import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.js";
import { createMemoryKV } from "./helpers/kv.js";

const req = (method, path, token) =>
  new Request(`https://w.test${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });

test("管理用: ADMIN_TOKEN が未設定なら 404", async () => {
  const res = await worker.fetch(req("GET", "/status", "x"), { MORI_KV: createMemoryKV() });
  assert.equal(res.status, 404);
});

test("管理用: トークンが違えば 401、正しければ /status は概要だけを返す", async () => {
  const kv = createMemoryKV({
    state: JSON.stringify({ sent: { a: "2026-11-05T00:00:00Z" }, pending: {}, crashGuard: {}, startFrom: "2026-11-01T00:00:00Z" }),
    oauth: JSON.stringify({ refresh_token: "secret-rt", access_token: "secret-at" }),
  });
  const env = { MORI_KV: kv, ADMIN_TOKEN: "admin-token-0123456789" };
  assert.equal((await worker.fetch(req("GET", "/status", "wrong"), env)).status, 401);
  assert.equal((await worker.fetch(req("GET", "/status"), env)).status, 401);
  const res = await worker.fetch(req("GET", "/status", "admin-token-0123456789"), env);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes("secret"), "トークンは返さない");
  const body = JSON.parse(text);
  assert.equal(body.sentCount, 1);
  assert.equal(body.startFrom, "2026-11-01T00:00:00Z");
  assert.equal((await worker.fetch(req("GET", "/other", "admin-token-0123456789"), env)).status, 404);
});

test("管理用: 短い ADMIN_TOKEN や .dev.vars.example の見本のままなら 404（未設定と同じ）", async () => {
  for (const token of ["short", "<16 文字以上のランダムな文字列>"]) {
    const res = await worker.fetch(req("GET", "/setup"), { MORI_KV: createMemoryKV(), ADMIN_TOKEN: token });
    assert.equal(res.status, 404, token);
  }
});
