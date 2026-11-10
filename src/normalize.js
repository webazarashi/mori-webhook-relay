// Mori MCP の応答から、ID・時刻・要約・発話を取り出す
// Mori の仕様は予告なく変わる可能性があるので、フィールド名には別名を許す

const SESSION_PREFIX = "mori://session/";
const TRANSCRIPT_PREFIX = "mori://transcript/session/";

/** "mori://session/<id>" / "mori://transcript/session/<id>" / "<id>" → "<id>" */
export function bareSessionId(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.startsWith(TRANSCRIPT_PREFIX)) return s.slice(TRANSCRIPT_PREFIX.length) || null;
  if (s.startsWith(SESSION_PREFIX)) return s.slice(SESSION_PREFIX.length) || null;
  return s;
}

export const sessionUri = (id) => `${SESSION_PREFIX}${id}`;
export const transcriptUri = (id) => `${TRANSCRIPT_PREFIX}${id}`;

function firstOf(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export const ID_KEYS = ["id", "session_id", "sessionId", "uri"];
export const STARTED_KEYS = ["started_at", "start_time", "startedAt", "startTime", "start", "recorded_at"];
export const ENDED_KEYS = ["ended_at", "end_time", "endedAt", "endTime", "end"];
export const TITLE_KEYS = ["title", "name"];

/** Mori の既定の要約の場所（fetch mori://session/<id> の結果を根とする） */
export const DEFAULT_SUMMARY_PATH = "object.session.overview_text";

export const sessionIdOf = (item) => bareSessionId(firstOf(item, ID_KEYS));
export const startedAtOf = (item) => firstOf(item, STARTED_KEYS) ?? null;
export const endedAtOf = (item) => firstOf(item, ENDED_KEYS) ?? null;
export const titleOf = (item) => firstOf(item, TITLE_KEYS) ?? null;

/**
 * list_sessions の項目の preview（要約の先頭 120 文字。要約ができるまでは空文字）。
 * フィールドがなければ undefined（その場合は fetch して確認する）
 */
export const previewOf = (item) => (item && typeof item.preview === "string" ? item.preview : undefined);

/** fetch(session) の結果からセッションのオブジェクトを取り出す */
export function extractSession(result) {
  if (!result || typeof result !== "object") return null;
  if (result.object && typeof result.object === "object") {
    if (result.object.session && typeof result.object.session === "object") return result.object.session;
    return result.object;
  }
  if (result.session && typeof result.session === "object") return result.session;
  return result;
}

/** ISO 文字列・エポック秒・エポックミリ秒 → ミリ秒（読めなければ null） */
export function toEpochMs(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** list_sessions の結果からセッションの配列を取り出す。形が想定外なら例外 */
export function extractSessionList(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") {
    for (const k of ["sessions", "items", "results", "data"]) {
      if (Array.isArray(result[k])) return result[k];
    }
  }
  throw new Error("list_sessions の結果にセッションの配列が見つかりません");
}

/** fetch(transcript) の結果から transcript オブジェクトを取り出す */
export function extractTranscript(result) {
  if (!result || typeof result !== "object") return null;
  if (result.object && typeof result.object === "object" && result.object.transcript) return result.object.transcript;
  if (result.transcript && typeof result.transcript === "object") return result.transcript;
  if (Array.isArray(result.utterances)) return result;
  return null;
}

export function utterancesOf(transcript) {
  if (Array.isArray(transcript)) return transcript;
  if (transcript && Array.isArray(transcript.utterances)) return transcript.utterances;
  return null;
}

/** "a.b.0.c" のようなパスで値を取り出す */
export function getPath(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const part of String(path).split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

// ---- 要約の検出 ----

const SUMMARY_KEY = /summary|overview/i;
/** 要約そのものではなく、状態や属性を表すキー（summary_status: "pending" などを拾わないため） */
const NON_CONTENT_KEY = /status|state|type|template|version|id$|_at$/i;
const SKIP_SUBTREE_KEY = /^(transcript|utterances)$/i;

/** 空でない文字列か、状態以外のキーの下に空でない文字列を含むオブジェクト・配列なら true */
export function hasMeaningfulContent(value, depth = 0) {
  if (typeof value === "string") return value.trim().length > 0;
  if (depth > 6 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => hasMeaningfulContent(v, depth + 1));
  for (const [k, v] of Object.entries(value)) {
    if (NON_CONTENT_KEY.test(k)) continue;
    if (hasMeaningfulContent(v, depth + 1)) return true;
  }
  return false;
}

/**
 * 要約を探す。
 * @param {object} obj 探す対象
 * @param {{path?: string, maxDepth?: number}} [opts] path を指定すればそこだけを見る
 * @returns {{path: string, value: unknown} | null}
 */
export function findSummary(obj, { path = "", maxDepth = 4 } = {}) {
  if (!obj || typeof obj !== "object") return null;
  if (path) {
    const v = getPath(obj, path);
    return hasMeaningfulContent(v) ? { path, value: v } : null;
  }
  // 浅いものを優先する（幅優先）
  let level = [{ node: obj, prefix: "" }];
  for (let depth = 1; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const { node, prefix } of level) {
      for (const [k, v] of Object.entries(node)) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (SUMMARY_KEY.test(k) && !NON_CONTENT_KEY.test(k) && hasMeaningfulContent(v)) return { path: p, value: v };
        if (v && typeof v === "object" && !Array.isArray(v) && !SKIP_SUBTREE_KEY.test(k)) {
          next.push({ node: v, prefix: p });
        }
      }
    }
    level = next;
  }
  return null;
}

/** 要約に関係しそうなキー（summary を含むもの）のパスを全部挙げる（inspect 用） */
export function listSummaryKeyPaths(obj, maxDepth = 5) {
  const out = [];
  const walk = (node, prefix, depth) => {
    if (!node || typeof node !== "object" || depth > maxDepth) return;
    for (const [k, v] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (SKIP_SUBTREE_KEY.test(k)) continue;
      if (SUMMARY_KEY.test(k)) out.push(p);
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, p, depth + 1);
    }
  };
  walk(obj, "", 1);
  return out;
}

// ---- 形の表示（本文を伏せる） ----

/** 値を見せてよいキー（末尾で判定。summary_status・started_at・speaker_id など）。title・text・name などは常に伏せる */
const SAFE_VALUE_KEY = /(^|_)(id|uri|status|state|type|format|version|lang|language|locale|duration|count|time|kind|source|at)$/i;
const SAFE_VALUE_KEY_CAMEL = /[a-z](At|Id|Uri|Time|Status|Type)$/;
const isSafeKey = (k) => SAFE_VALUE_KEY.test(k) || SAFE_VALUE_KEY_CAMEL.test(k);
const SAFE_VALUE = /^[\w:.+\-/]{0,64}$/;

/**
 * 値の「形」を返す。文字列は原則 `<str len=N>` に伏せる。
 * ID・時刻・状態のようなキーで、空白や日本語を含まない 64 文字以下の値だけを見せる。
 */
export function describeShape(value, key = "", depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const safe = key && isSafeKey(key) && SAFE_VALUE.test(value);
    return safe ? value : `<str len=${value.length}>`;
  }
  if (depth > 8) return "<…>";
  if (Array.isArray(value)) {
    const out = { "<array>": value.length };
    if (value.length === 0) return out;
    out.first = describeShape(value[0], key, depth + 1);
    if (value.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
      const counts = {};
      for (const v of value) for (const k of Object.keys(v)) counts[k] = (counts[k] || 0) + 1;
      out.keyCounts = counts;
    }
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = describeShape(v, k, depth + 1);
  return out;
}

/** 要約などの値を、伏せた説明にする */
export function describeValueBrief(v) {
  if (typeof v === "string") return { type: "string", length: v.length };
  if (Array.isArray(v)) return { type: "array", length: v.length };
  if (v && typeof v === "object") return { type: "object", keys: Object.keys(v) };
  return { type: typeof v, value: v };
}
