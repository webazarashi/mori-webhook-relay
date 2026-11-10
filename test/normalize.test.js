import assert from "node:assert/strict";
import { test } from "node:test";
import { bareSessionId, describeShape, extractSessionList, findSummary, transcriptUri } from "../src/normalize.js";

test("ID: URI 形式・素の ID の両方を扱う", () => {
  assert.equal(bareSessionId("mori://session/abc"), "abc");
  assert.equal(bareSessionId("mori://transcript/session/abc"), "abc");
  assert.equal(bareSessionId("abc"), "abc");
  assert.equal(transcriptUri("abc"), "mori://transcript/session/abc");
});

test("要約の自動検出: summary_status: pending を要約と誤判定しない", () => {
  assert.equal(findSummary({ summary_status: "pending", title: "x" }), null);
  assert.equal(findSummary({ summary: { status: "pending" } }), null);
  assert.equal(findSummary({ summary: "" }), null);
  assert.equal(findSummary({ summary: null, summary_generated_at: "2026-11-05T00:00:00Z" }), null);
});

test("要約の自動検出: 入れ子の要約を見つけ、transcript の配下は見ない", () => {
  assert.deepEqual(findSummary({ object: { summary: "まとめ" } }), { path: "object.summary", value: "まとめ" });
  assert.equal(findSummary({ object: { transcript: { summary: "x" } } }), null);
  const obj = { object: { summary: { status: "done", text: "本文" } } };
  assert.equal(findSummary(obj).path, "object.summary");
});

test("要約の検出: SUMMARY_PATH を指定したらそこだけを見る", () => {
  const obj = { object: { summary: "A", ai_summary: "B" } };
  assert.equal(findSummary(obj, { path: "object.ai_summary" }).value, "B");
  assert.equal(findSummary(obj, { path: "object.none" }), null);
});

test("extractSessionList: {sessions:[...]} と配列を読む", () => {
  assert.equal(extractSessionList({ sessions: [{ id: 1 }] }).length, 1);
  assert.equal(extractSessionList([{ id: 1 }]).length, 1);
  assert.throws(() => extractSessionList({ foo: 1 }));
});

test("describeShape: 本文は伏せ、ID・時刻・状態だけを見せる", () => {
  const shape = describeShape({
    id: "mori://session/0b7c",
    title: "週次定例",
    started_at: "2026-11-05T01:00:00Z",
    summary_status: "pending",
    summary: "要約の本文です",
    speaker_name: "田中",
    status: "completed with notes",
  });
  assert.equal(shape.id, "mori://session/0b7c");
  assert.equal(shape.title, "<str len=4>");
  assert.equal(shape.started_at, "2026-11-05T01:00:00Z");
  assert.equal(shape.summary_status, "pending");
  assert.equal(shape.summary, "<str len=7>");
  assert.equal(shape.speaker_name, "<str len=2>");
  assert.equal(shape.status, "<str len=20>");
});
