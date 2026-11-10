// プロセス内で Mori MCP・トークンエンドポイント・Grok Bot Webhook の代わりをする fetch
import { listItem, sessionResult, transcriptResult } from "../fixtures/mori.js";

export const MCP_URL = "https://mcp.test";
export const WEBHOOK_URL = "https://hooks.test/automations/webhook/r1";

export function createMockWorld({ sse = false } = {}) {
  const world = {
    sessions: [], // { item, summary: string|null, transcript: {utterances, textLength} , failTranscript }
    webhookStatus: 200,
    webhookCalls: [],
    tokenResponses: [], // 先頭から順に使う。空なら成功
    calls: { token: 0, initialize: 0, list: 0, fetchSession: 0, fetchTranscript: 0, total: 0 },
    rateLimitTranscript: false,
    refreshCounter: 0,
  };

  world.addSession = (n, opts = {}) => {
    const item = listItem(n, { startedAt: opts.startedAt, preview: opts.summary === null ? "" : undefined });
    const s = { n, item, summary: opts.summary === undefined ? "架空の要約です。" : opts.summary, utterances: opts.utterances ?? 3, textLength: opts.textLength ?? 20, failTranscript: Boolean(opts.failTranscript) };
    world.sessions.push(s);
    return s;
  };
  world.setSummary = (n, summary) => {
    const s = world.sessions.find((x) => x.n === n);
    s.summary = summary;
    s.item.preview = summary ? summary.slice(0, 120) : "";
  };

  const respond = (id, result) => {
    const json = JSON.stringify({ jsonrpc: "2.0", id, result });
    if (sse) return new Response(`event: message\ndata: ${json}\n\n`, { headers: { "content-type": "text/event-stream" } });
    return new Response(json, { headers: { "content-type": "application/json" } });
  };
  const tool = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });

  world.fetch = async (url, init = {}) => {
    world.calls.total++;
    const u = String(url);
    if (u === `${MCP_URL}/oauth/token`) {
      world.calls.token++;
      const next = world.tokenResponses.shift();
      if (next) return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
      world.refreshCounter++;
      return new Response(JSON.stringify({ access_token: `at-${world.refreshCounter}`, expires_in: 3600, refresh_token: `rt-${world.refreshCounter}` }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (u === WEBHOOK_URL) {
      world.webhookCalls.push({ headers: init.headers, body: JSON.parse(init.body) });
      return new Response(world.webhookStatus === 200 ? "" : "Automation r1 is disabled", { status: world.webhookStatus });
    }
    if (u !== MCP_URL) throw new Error(`想定外の URL: ${u}`);
    const msg = JSON.parse(init.body);
    if (msg.id === undefined) return new Response(null, { status: 202 });
    if (msg.method === "initialize") {
      world.calls.initialize++;
      return respond(msg.id, { protocolVersion: "2025-06-18", serverInfo: { name: "mock" } });
    }
    const { name, arguments: a } = msg.params;
    if (name === "list_sessions") {
      world.calls.list++;
      const start = Date.parse(a.start);
      const items = world.sessions
        .filter((s) => Date.parse(s.item.started_at) >= start)
        .sort((x, y) => Date.parse(y.item.started_at) - Date.parse(x.item.started_at))
        .map((s) => ({ ...s.item, preview: s.previewOverride ?? (s.summary ? s.summary.slice(0, 120) : "") }));
      return respond(msg.id, tool({ safety: {}, sessions: items }));
    }
    if (name === "fetch") {
      const s = world.sessions.find((x) => a.uri.endsWith(x.item.id.slice("mori://session/".length)));
      if (!s) return respond(msg.id, { isError: true, content: [{ type: "text", text: "not found" }] });
      if (a.uri.startsWith("mori://transcript/")) {
        world.calls.fetchTranscript++;
        if (world.rateLimitTranscript) return new Response("", { status: 429 });
        if (s.failTranscript) return respond(msg.id, { isError: true, content: [{ type: "text", text: "internal" }] });
        return respond(msg.id, tool(transcriptResult(s.item, { utterances: s.utterances, textLength: s.textLength })));
      }
      world.calls.fetchSession++;
      return respond(msg.id, tool(sessionResult(s.item, { overview: s.summary ?? "" })));
    }
    throw new Error(`想定外のツール: ${name}`);
  };
  return world;
}

export const NOW0 = Date.parse("2026-11-05T12:00:00+09:00");

export function oauthRecord(over = {}) {
  return JSON.stringify({
    client_id: "cid",
    client_secret: null,
    token_endpoint: `${MCP_URL}/oauth/token`,
    resource: MCP_URL,
    access_token: "at-0",
    access_expires_at: 0,
    refresh_token: "rt-0",
    updated_at: "2026-11-04T00:00:00Z",
    ...over,
  });
}

export const baseEnv = (over = {}) => ({
  MCP_URL,
  GROK_WEBHOOK_URL: WEBHOOK_URL,
  GROK_WEBHOOK_KEY: "crsr_test",
  FETCH_INTERVAL_MS: "0",
  START_FROM: "2026-11-01T00:00:00+09:00",
  ...over,
});
