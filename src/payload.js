// Webhook のペイロードの組み立て・分割・切り詰め
// CPU 時間（無料プランは 10ms）を節約するため、各セッションの JSON は原則 1 回だけ文字列にする

import { endedAtOf, sessionUri, startedAtOf, titleOf } from "./normalize.js";

export const EVENT_COMPLETED = "mori.session.summary_completed";
export const EVENT_ERROR = "mori.poller.error";
export const PAYLOAD_VERSION = 1;

const encoder = new TextEncoder();
export const utf8Length = (s) => encoder.encode(s).byteLength;

const JST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 86400_000;
const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

/**
 * 発話の時刻を表示用にする。
 * ISO 形式 → JST の HH:MM:SS（Intl は遅いので時差を足して計算）
 * 数値 → 開始からの秒数として H:MM:SS
 */
export function formatClock(v) {
  if (typeof v === "number" && Number.isFinite(v)) {
    const total = Math.max(0, Math.floor(v));
    return `${Math.floor(total / 3600)}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`;
  }
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) {
      const ms = (((t + JST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
      const sec = Math.floor(ms / 1000);
      return `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`;
    }
  }
  return null;
}

function speakerOf(u, labels) {
  if (u.is_own_voice === true) return labels.self;
  if (u.is_own_voice === false) return labels.other;
  const name = u.speaker_name ?? u.speaker;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** 発話の配列 → 1 発話 1 行の配列（"[HH:MM:SS] 話者: 本文"） */
export function utteranceLines(utterances, labels) {
  const lines = [];
  for (const u of utterances) {
    if (!u || typeof u !== "object") continue;
    const text = typeof u.text === "string" ? u.text.trim() : "";
    if (!text) continue;
    const clock = formatClock(u.started_at ?? u.start_time);
    const speaker = speakerOf(u, labels);
    const head = clock ? `[${clock}] ` : "";
    lines.push(speaker ? `${head}${speaker}: ${text}` : `${head}${text}`);
  }
  return lines;
}

/** セッションのオブジェクトから要約（同じ値のキー）を取り除いた浅いコピー */
function withoutSummary(sessionObj, summary) {
  const out = {};
  for (const [k, v] of Object.entries(sessionObj || {})) {
    if (v === summary) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 1 セッション分のエントリを作る
 * @param {object} o
 * @param {string} o.id
 * @param {object} o.session fetch(session) で取れたセッションのオブジェクト（なければ list の項目）
 * @param {unknown} o.summary
 * @param {object|null} o.transcript 文字起こしのオブジェクト（utterances を含む）。省略時は null
 * @param {string|null} o.omittedReason 文字起こしを入れない理由
 */
export function buildSessionEntry({ id, session, summary, transcript, omittedReason = null }, cfg) {
  const entry = {
    session_id: id,
    session_uri: sessionUri(id),
    title: titleOf(session),
    started_at: startedAtOf(session),
    ended_at: endedAtOf(session),
    summary,
    session: withoutSummary(session, summary),
  };
  if (transcript && !omittedReason) {
    const utterances = Array.isArray(transcript.utterances) ? transcript.utterances : [];
    const { utterances: _omit, ...meta } = transcript;
    if (cfg.TRANSCRIPT_FORMAT === "text" || cfg.TRANSCRIPT_FORMAT === "both") {
      entry.transcript_text = utteranceLines(utterances, {
        self: cfg.SPEAKER_SELF_LABEL,
        other: cfg.SPEAKER_OTHER_LABEL,
      }).join("\n");
    }
    if (cfg.TRANSCRIPT_FORMAT === "raw" || cfg.TRANSCRIPT_FORMAT === "both") entry.transcript = transcript;
    entry.transcript_meta = meta;
    entry.transcript_truncated = false;
    entry.transcript_omitted = false;
  } else {
    entry.transcript_truncated = false;
    entry.transcript_omitted = true;
    entry.transcript_omitted_reason = omittedReason || "unavailable";
  }
  return entry;
}

/** 末尾から切って、JSON にしたときのバイト数が maxBytes 以下になる行数を返す */
function fitCount(items, maxBytes, sizeOf) {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += sizeOf(items[i]);
    if (total > maxBytes) return i;
  }
  return items.length;
}

/**
 * 1 件だけで上限を超えるエントリの文字起こしを末尾から切り詰める（めったに通らない経路）
 * @returns {string} 切り詰めた後の JSON
 */
export function truncateEntry(entry, roomBytes) {
  const textBytes = typeof entry.transcript_text === "string" ? utf8Length(JSON.stringify(entry.transcript_text)) : 0;
  const rawUtts = entry.transcript && Array.isArray(entry.transcript.utterances) ? entry.transcript.utterances : null;
  const rawBytes = rawUtts ? utf8Length(JSON.stringify(rawUtts)) : 0;
  const base = { ...entry, transcript_truncated: true };
  if (typeof base.transcript_text === "string") base.transcript_text = "";
  if (rawUtts) base.transcript = { ...entry.transcript, utterances: [] };
  const baseBytes = utf8Length(JSON.stringify(base));
  const allowed = Math.max(0, roomBytes - baseBytes - 64);
  const total = textBytes + rawBytes || 1;

  if (typeof entry.transcript_text === "string") {
    const lines = entry.transcript_text.split("\n");
    // 各行は JSON 文字列の中で "\n"（2 バイト）でつながる
    const budget = rawUtts ? Math.floor((allowed * textBytes) / total) : allowed;
    const n = fitCount(lines, budget, (l) => utf8Length(JSON.stringify(l)) - 2 + 2);
    base.transcript_text = lines.slice(0, n).join("\n");
  }
  if (rawUtts) {
    const budget = typeof entry.transcript_text === "string" ? allowed - Math.floor((allowed * textBytes) / total) : allowed;
    const n = fitCount(rawUtts, budget, (u) => utf8Length(JSON.stringify(u)) + 1);
    base.transcript = { ...entry.transcript, utterances: rawUtts.slice(0, n) };
  }
  return JSON.stringify(base);
}

function envelopePrefix(sentAt, count, safety) {
  const head = { event: EVENT_COMPLETED, version: PAYLOAD_VERSION, sent_at: sentAt, count };
  if (safety) head.safety = safety;
  const s = JSON.stringify(head);
  return `${s.slice(0, -1)},"sessions":[`;
}

/**
 * エントリをまとめて Webhook の本文にする。上限を超えるなら複数に分ける
 * @returns {{body: string, ids: string[], bytes: number}[]}
 */
export function packPayloads(entries, { maxBytes, batch, sentAt, safety = null }) {
  // count は最大 6 桁と見積もって、包みの大きさを確保する
  const envelopeBytes = utf8Length(envelopePrefix(sentAt, 999999, safety)) + 2;
  const room = maxBytes - envelopeBytes;
  const parts = entries.map((e) => {
    let json = JSON.stringify(e);
    let bytes = utf8Length(json);
    if (bytes > room) {
      json = truncateEntry(e, room);
      bytes = utf8Length(json);
    }
    return { id: e.session_id, json, bytes };
  });

  const out = [];
  let cur = [];
  let curBytes = 0;
  const flush = () => {
    if (!cur.length) return;
    const body = `${envelopePrefix(sentAt, cur.length, safety)}${cur.map((p) => p.json).join(",")}]}`;
    out.push({ body, ids: cur.map((p) => p.id), bytes: utf8Length(body) });
    cur = [];
    curBytes = 0;
  };
  for (const p of parts) {
    const add = p.bytes + (cur.length ? 1 : 0);
    if (cur.length && (!batch || curBytes + add > room)) flush();
    cur.push(p);
    curBytes += p.bytes + (cur.length > 1 ? 1 : 0);
  }
  flush();
  return out;
}

/** エラー通知の本文 */
export function errorPayload({ error, message, action = null, sentAt }) {
  const body = { event: EVENT_ERROR, version: PAYLOAD_VERSION, sent_at: sentAt, error, message };
  if (action) body.action = action;
  return JSON.stringify(body);
}
