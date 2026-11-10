import assert from "node:assert/strict";
import { test } from "node:test";
import { McpClient, McpToolError, RateLimitError, parseToolResult, readSseResponse } from "../src/mcp.js";

const enc = new TextEncoder();
function streamOf(chunks) {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

test("SSE: 細切れのチャンクでも id が一致する応答を返す（前の通知は無視）", async () => {
  const big = "あ".repeat(50_000);
  const msg = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { text: big } });
  const sse = `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${msg}\n\n`;
  const chunks = [];
  for (let i = 0; i < sse.length; i += 1000) chunks.push(sse.slice(i, i + 1000));
  const got = await readSseResponse(streamOf(chunks), 7);
  assert.equal(got.result.text.length, 50_000);
});

test("SSE: CRLF 区切りと、末尾に空行がない場合も読める", async () => {
  const got = await readSseResponse(streamOf(['data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}']), 1);
  assert.deepEqual(got.result, { ok: true });
  const got2 = await readSseResponse(streamOf(['data: {"jsonrpc":"2.0",\r\n', 'data: "id":2,"result":1}\r\n\r\n']), 2);
  assert.equal(got2.result, 1);
});

test("parseToolResult: structuredContent を優先し、なければ text を JSON として読む", () => {
  assert.deepEqual(parseToolResult("x", { structuredContent: { a: 1 }, content: [{ type: "text", text: "{}" }] }), { a: 1 });
  assert.deepEqual(parseToolResult("x", { content: [{ type: "text", text: '{"b":2}' }] }), { b: 2 });
  assert.throws(() => parseToolResult("x", { isError: true, content: [{ type: "text", text: "boom" }] }), McpToolError);
});

function mockServer({ sse = false, failFirst401 = false, status429 = false } = {}) {
  const calls = [];
  let saw401 = false;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ body, headers: init.headers });
    if (status429) return new Response("", { status: 429 });
    if (failFirst401 && !saw401) {
      saw401 = true;
      return new Response("", { status: 401 });
    }
    if (body.id === undefined) return new Response(null, { status: 202 });
    let result;
    if (body.method === "initialize") result = { protocolVersion: "2025-03-26", serverInfo: { name: "mock" } };
    else result = { content: [{ type: "text", text: JSON.stringify({ echo: body.params.name }) }] };
    const json = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    const headers = { "mcp-session-id": "sess-1" };
    if (sse) return new Response(`data: ${json}\n\n`, { headers: { ...headers, "content-type": "text/event-stream" } });
    return new Response(json, { headers: { ...headers, "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

for (const sse of [false, true]) {
  test(`McpClient: ${sse ? "SSE" : "JSON"} 応答で initialize → callTool、セッション ID と版のヘッダーを付ける`, async () => {
    const { fetchImpl, calls } = mockServer({ sse });
    const c = new McpClient({ url: "https://mcp.test", fetch: fetchImpl, getToken: async () => "tok" });
    await c.initialize();
    assert.equal(c.protocolVersion, "2025-03-26");
    const r = await c.callTool("list_sessions", {});
    assert.deepEqual(r, { echo: "list_sessions" });
    const last = calls.at(-1).headers;
    assert.equal(last["Mcp-Session-Id"], "sess-1");
    assert.equal(last["MCP-Protocol-Version"], "2025-03-26");
    assert.equal(calls[1].body.method, "notifications/initialized");
  });
}

test("McpClient: 401 ならトークンを強制更新して 1 回だけやり直す", async () => {
  const { fetchImpl } = mockServer({ failFirst401: true });
  const forced = [];
  const c = new McpClient({ url: "https://mcp.test", fetch: fetchImpl, getToken: async (o) => (forced.push(Boolean(o?.force)), "tok") });
  await c.initialize();
  assert.deepEqual(forced.slice(0, 2), [false, true]);
});

test("McpClient: 429 は RateLimitError", async () => {
  const { fetchImpl } = mockServer({ status429: true });
  const c = new McpClient({ url: "https://mcp.test", fetch: fetchImpl, getToken: async () => "tok" });
  await assert.rejects(c.initialize(), RateLimitError);
});

test("fetch はメソッドとして呼ばない（Workers の Illegal invocation 対策）", async () => {
  const { SubrequestBudget } = await import("../src/budget.js");
  const { TokenManager } = await import("../src/oauth.js");
  const { fetchImpl } = mockServer();
  // this が undefined 以外なら落ちる fetch（Workers のグローバル fetch の振る舞いを真似る）
  const strictFetch = function (url, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return fetchImpl(url, init);
  };
  const budget = new SubrequestBudget(strictFetch, 10);
  const c = new McpClient({ url: "https://mcp.test", fetch: strictFetch, getToken: async () => "tok" });
  await c.initialize();
  await budget.fetch("https://mcp.test", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "x" }) });
  const tm = new TokenManager({ kv: { get: async () => null }, fetch: strictFetch });
  assert.equal(typeof tm.fetch, "function");
});
