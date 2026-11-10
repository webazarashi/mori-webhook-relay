import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { buildSessionEntry, formatClock, packPayloads, utf8Length } from "../src/payload.js";
import { listItem, sessionResult, transcriptResult } from "./fixtures/mori.js";

const cfg = (over = {}) => loadConfig(over);
const entryOf = (n, { utterances = 3, textLength = 20, format = "text" } = {}) => {
  const item = listItem(n, { startedAt: `2026-11-05T0${n % 10}:00:00+09:00` });
  const session = sessionResult(item).object.session;
  const transcript = transcriptResult(item, { utterances, textLength }).object.transcript;
  return buildSessionEntry({ id: `id-${n}`, session, summary: session.overview_text, transcript }, cfg({ TRANSCRIPT_FORMAT: format }));
};

test("時刻: ISO は JST の HH:MM:SS、数値は開始からの H:MM:SS", () => {
  assert.equal(formatClock("2026-11-05T01:02:03Z"), "10:02:03");
  assert.equal(formatClock("2026-11-05T23:59:59+09:00"), "23:59:59");
  assert.equal(formatClock("2026-11-05T16:00:00Z"), "01:00:00");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(formatClock("bad"), null);
});

test("TRANSCRIPT_FORMAT: text / raw / both", () => {
  const t = entryOf(1, { format: "text" });
  assert.ok(t.transcript_text && !t.transcript);
  const r = entryOf(1, { format: "raw" });
  assert.ok(!r.transcript_text && r.transcript.utterances.length === 3);
  const b = entryOf(1, { format: "both" });
  assert.ok(b.transcript_text && b.transcript.utterances.length === 3);
});

test("9a. 上限を超えるなら複数の POST に分ける（JSON として正しく、全件が 1 回ずつ入る）", () => {
  const entries = [1, 2, 3, 4, 5].map((n) => entryOf(n, { utterances: 30 }));
  const one = utf8Length(JSON.stringify(entries[0]));
  const maxBytes = one * 2 + 600;
  const payloads = packPayloads(entries, { maxBytes, batch: true, sentAt: "2026-11-05T00:00:00Z" });
  assert.ok(payloads.length >= 3);
  const ids = [];
  for (const p of payloads) {
    assert.ok(p.bytes <= maxBytes, `${p.bytes} <= ${maxBytes}`);
    const body = JSON.parse(p.body);
    assert.equal(body.count, body.sessions.length);
    assert.deepEqual(body.sessions.map((s) => s.session_id), p.ids);
    ids.push(...p.ids);
  }
  assert.deepEqual(ids, ["id-1", "id-2", "id-3", "id-4", "id-5"]);
});

test("BATCH=false なら 1 セッションにつき 1 回", () => {
  const entries = [1, 2, 3].map((n) => entryOf(n));
  const payloads = packPayloads(entries, { maxBytes: 500_000, batch: false, sentAt: "x" });
  assert.equal(payloads.length, 3);
});

for (const format of ["text", "raw", "both"]) {
  test(`9b. 1 件だけで上限を超えるなら文字起こしの末尾を切り詰める（${format}）`, () => {
    const e = entryOf(1, { utterances: 2000, textLength: 60, format });
    const maxBytes = 50_000;
    const [p] = packPayloads([e], { maxBytes, batch: true, sentAt: "2026-11-05T00:00:00Z" });
    assert.ok(p.bytes <= maxBytes, `${p.bytes} <= ${maxBytes}`);
    assert.ok(p.bytes > maxBytes * 0.8, "切りすぎない");
    const s = JSON.parse(p.body).sessions[0];
    assert.equal(s.transcript_truncated, true);
    if (format !== "raw") assert.ok(e.transcript_text.startsWith(s.transcript_text) && s.transcript_text.length > 0);
    if (format !== "text") assert.ok(s.transcript.utterances.length > 0 && s.transcript.utterances.length < 2000);
    assert.equal(s.summary, e.summary, "要約は切らない");
  });
}

test("設定: 不正な値はまとめてエラーにする", () => {
  assert.throws(() => loadConfig({ WINDOW_DAYS: "abc", TRANSCRIPT_FORMAT: "xml" }), /WINDOW_DAYS.*TRANSCRIPT_FORMAT/);
  assert.throws(() => loadConfig({ GROK_WEBHOOK_URL: "http://example.com/x" }), /https/);
  const c = loadConfig({});
  assert.equal(c.WINDOW_DAYS, 8);
  assert.equal(c.BATCH, true);
  assert.equal(c.SUMMARY_PATH, "object.session.overview_text");
});
