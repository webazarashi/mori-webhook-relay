// 最小の MCP クライアント（Streamable HTTP。fetch だけで実装し、Workers と Node の両方で動く）

export const REQUESTED_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 60_000;

export class McpHttpError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = "McpHttpError";
    this.status = status;
  }
}

/** HTTP 429。その回の fetch は打ち切る */
export class RateLimitError extends McpHttpError {
  constructor(message) {
    super(message, { status: 429 });
    this.name = "RateLimitError";
  }
}

/** JSON-RPC のエラー応答 */
export class McpRpcError extends Error {
  constructor(message, { code = null } = {}) {
    super(message);
    this.name = "McpRpcError";
    this.code = code;
  }
}

/** tools/call の結果が isError: true */
export class McpToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "McpToolError";
  }
}

/**
 * SSE の応答を読み、指定した id の JSON-RPC 応答を返す。
 * 見つかった時点で読むのをやめる（サーバーがストリームを閉じなくても待たない）。
 */
export async function readSseResponse(body, id, stats = null) {
  if (!body) throw new McpHttpError("SSE の本文がありません");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const boundary = /\r?\n\r?\n/g;
  let buffer = "";
  let scanFrom = 0;
  let found = null;

  const handleEvent = (raw) => {
    let data = null;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const v = line.charCodeAt(5) === 32 ? line.slice(6) : line.slice(5);
      data = data === null ? v : `${data}\n${v}`;
    }
    if (data === null || data === "") return null;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return null;
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    for (const m of msgs) {
      if (m && m.id === id && ("result" in m || "error" in m)) return m;
    }
    return null;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) found = handleEvent(buffer);
        break;
      }
      if (stats) stats.bytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      boundary.lastIndex = scanFrom;
      let m;
      let consumed = 0;
      while ((m = boundary.exec(buffer)) !== null) {
        const ev = buffer.slice(consumed, m.index);
        consumed = m.index + m[0].length;
        found = handleEvent(ev);
        if (found) break;
      }
      if (found) break;
      if (consumed > 0) buffer = buffer.slice(consumed);
      scanFrom = Math.max(0, buffer.length - 3);
    }
  } finally {
    if (found) reader.cancel().catch(() => {});
  }
  if (!found) throw new McpHttpError(`SSE に id=${id} の応答がありませんでした`);
  return found;
}

/** tools/call の result から構造化データを取り出す */
export function parseToolResult(name, result) {
  if (!result || typeof result !== "object") throw new McpToolError(`ツール ${name} の結果が空です`);
  const texts = Array.isArray(result.content)
    ? result.content.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text)
    : [];
  if (result.isError) {
    throw new McpToolError(`ツール ${name} がエラーを返しました: ${texts.join(" / ").slice(0, 300) || "（詳細なし）"}`);
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  for (const t of texts) {
    try {
      return JSON.parse(t);
    } catch {
      // 次の text を試す
    }
  }
  throw new McpToolError(`ツール ${name} の結果を JSON として読めませんでした`);
}

export class McpClient {
  /**
   * @param {object} o
   * @param {string} o.url MCP エンドポイント
   * @param {(opts?: {force?: boolean}) => Promise<string>} o.getToken アクセストークンを返す（force で強制更新）
   */
  constructor({ url, getToken, fetch: fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, clientVersion = "0.1.0" }) {
    this.url = url;
    this.getToken = getToken;
    this.fetch = (url, init) => fetchImpl(url, init); // メソッド呼び出しにしない（Workers の Illegal invocation 対策）
    this.timeoutMs = timeoutMs;
    this.clientVersion = clientVersion;
    this.nextId = 1;
    this.sessionId = null;
    this.protocolVersion = null;
    this.serverInfo = null;
    /** 直近の応答本文のバイト数（文字起こしの予算計算に使う） */
    this.lastResponseBytes = 0;
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: REQUESTED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mori-webhook-relay", version: this.clientVersion },
    });
    this.protocolVersion = (result && result.protocolVersion) || REQUESTED_PROTOCOL_VERSION;
    this.serverInfo = (result && result.serverInfo) || null;
    await this.notify("notifications/initialized");
    return result;
  }

  async request(method, params) {
    const id = this.nextId++;
    const msg = await this.#post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, id);
    if (msg.error) {
      const e = msg.error;
      throw new McpRpcError(`MCP ${method} がエラーを返しました: ${String(e.message || "").slice(0, 300)}`, {
        code: e.code ?? null,
      });
    }
    return msg.result;
  }

  async notify(method, params) {
    await this.#post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, null);
  }

  /** tools/call を呼び、構造化データを返す */
  async callTool(name, args) {
    const result = await this.request("tools/call", { name, arguments: args || {} });
    return parseToolResult(name, result);
  }

  async #post(payload, id, retried = false) {
    const token = await this.getToken({ force: retried });
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;

    let res;
    try {
      res = await this.fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new McpHttpError(`MCP サーバーに接続できません (${e?.name || "Error"}: ${String(e?.message || "").slice(0, 120)})`);
    }

    if (res.status === 401 && !retried) {
      await res.body?.cancel().catch(() => {});
      return this.#post(payload, id, true);
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => {});
      throw new RateLimitError("MCP サーバーのレート制限に達しました (HTTP 429)");
    }
    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 200);
      throw new McpHttpError(`MCP サーバーが HTTP ${res.status} を返しました${snippet ? `: ${snippet}` : ""}`, {
        status: res.status,
      });
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (id === null) {
      // 通知（202 Accepted、本文なし）
      await res.body?.cancel().catch(() => {});
      return null;
    }

    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (ctype.includes("text/event-stream")) {
      const stats = { bytes: 0 };
      try {
        return await readSseResponse(res.body, id, stats);
      } finally {
        this.lastResponseBytes = stats.bytes;
      }
    }

    const buf = await res.arrayBuffer();
    this.lastResponseBytes = buf.byteLength;
    const text = new TextDecoder().decode(buf);
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      throw new McpHttpError(`MCP の応答が JSON ではありません (content-type: ${ctype || "なし"})`, {
        status: res.status,
      });
    }
    if (Array.isArray(msg)) msg = msg.find((m) => m && m.id === id);
    if (!msg || msg.id !== id) throw new McpHttpError(`MCP の応答に id=${id} がありません`);
    return msg;
  }
}
