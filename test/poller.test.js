import assert from "node:assert/strict";
import { test } from "node:test";
import { runOnce } from "../src/poller.js";
import { createMemoryKV } from "./helpers/kv.js";
import { NOW0, WEBHOOK_URL, baseEnv, createMockWorld, oauthRecord } from "./helpers/mock-mori.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

function setup({ sse = false, env = {}, state = null } = {}) {
  const world = createMockWorld({ sse });
  const kv = createMemoryKV({ oauth: oauthRecord(), ...(state ? { state: JSON.stringify(state) } : {}) });
  let now = NOW0;
  const logs = [];
  const run = (extra = {}) =>
    runOnce({ env: baseEnv(env), kv, fetch: world.fetch, now: () => now, sleep: async () => {}, log: (m, d) => logs.push({ m, d }), ...extra });
  return { world, kv, run, logs, advance: (ms) => (now += ms), state: () => JSON.parse(kv.store.get("state")) };
}

const sentBodies = (world) => world.webhookCalls.map((c) => c.body);

for (const sse of [false, true]) {
  test(`1/4. 要約のある新しいセッションは 1 回だけ送られる（${sse ? "SSE" : "JSON"}）`, async () => {
    const { world, run, advance } = setup({ sse });
    world.addSession(1, { startedAt: "2026-11-05T10:00:00+09:00" });
    const r1 = await run();
    assert.equal(r1.sent, 1);
    assert.equal(world.webhookCalls.length, 1);
    const call = world.webhookCalls[0];
    assert.equal(call.headers.Authorization, "Bearer crsr_test");
    const body = call.body;
    assert.equal(body.event, "mori.session.summary_completed");
    assert.equal(body.count, 1);
    const s = body.sessions[0];
    assert.equal(s.session_id, "00000001-0000-4000-8000-000000000000");
    assert.equal(s.session_uri, "mori://session/00000001-0000-4000-8000-000000000000");
    assert.equal(s.summary, "架空の要約です。");
    assert.equal(s.session.overview_text, undefined, "要約は session から取り除く");
    assert.deepEqual(s.session.location, { latitude: 35, longitude: 135 }, "位置情報も含める");
    assert.match(s.transcript_text, /^\[10:00:00\] 自分: 架空の発言0。/);
    assert.match(s.transcript_text.split("\n")[1], /^\[10:00:05\] 相手: /);
    assert.match(s.transcript_text.split("\n")[2], /^\[10:00:10\] 架空の発言2/);
    assert.equal(s.transcript_meta.utterances, undefined);
    assert.equal(s.transcript_omitted, false);
    assert.ok(body.safety.user_content_handling);

    advance(15 * MIN);
    const r2 = await run();
    assert.equal(r2.sent, 0);
    assert.equal(world.webhookCalls.length, 1, "2 回目は送らない");
  });
}

test("2. 要約がまだ（preview が空）のセッションは fetch せず待ち、要約が出たら送る", async () => {
  const { world, run, advance } = setup();
  world.addSession(1, { summary: null });
  const r1 = await run();
  assert.equal(r1.sent, 0);
  assert.equal(r1.waiting, 1);
  assert.equal(world.calls.fetchSession, 0);
  assert.equal(world.webhookCalls.length, 0, "新着がない回は Webhook を呼ばない");
  advance(15 * MIN);
  world.setSummary(1, "あとからできた要約");
  const r2 = await run();
  assert.equal(r2.sent, 1);
  assert.equal(sentBodies(world)[0].sessions[0].summary, "あとからできた要約");
});

test("2'. preview はあるが fetch で要約がないものは pending になり、再確認の間隔を守る", async () => {
  const { world, run, advance, state } = setup();
  const s = world.addSession(1, { summary: null });
  s.previewOverride = "途中";
  await run();
  assert.equal(world.calls.fetchSession, 1);
  assert.ok(state().pending["00000001-0000-4000-8000-000000000000"]);
  advance(60 * MIN);
  await run();
  assert.equal(world.calls.fetchSession, 1, "120 分経つまでは再確認しない");
  advance(61 * MIN);
  s.summary = "できた要約";
  await run();
  assert.equal(world.calls.fetchSession, 2);
  assert.equal(world.webhookCalls.length, 1);
  assert.equal(state().pending["00000001-0000-4000-8000-000000000000"], undefined);
});

for (const status of [500, 400]) {
  test(`3. Webhook が ${status} なら送信済みにせず、次の実行で再送する`, async () => {
    const { world, run, advance, state } = setup();
    world.addSession(1);
    world.webhookStatus = status;
    const r1 = await run();
    assert.equal(r1.sent, 0);
    assert.match(r1.error, /webhook_failed/);
    assert.deepEqual(state().sent, {});
    assert.equal(state().consecutiveFailures, 1);
    world.webhookStatus = 200;
    advance(15 * MIN);
    const r2 = await run();
    assert.equal(r2.sent, 1);
    assert.equal(state().consecutiveFailures, 0);
  });
}

test("5. リフレッシュで返った新しい refresh_token は KV に保存される", async () => {
  const { world, kv, run } = setup();
  world.addSession(1);
  await run();
  const oauth = JSON.parse(kv.store.get("oauth"));
  assert.equal(oauth.refresh_token, "rt-1");
  assert.equal(oauth.access_token, "at-1");
});

test("6. invalid_grant ならエラー通知を 1 回だけ送る（24 時間以内は再送しない）", async () => {
  const { world, run, advance, state } = setup();
  world.addSession(1);
  const bad = { status: 400, body: { error: "invalid_grant" } };
  world.tokenResponses.push(bad, bad, bad, bad);
  const r1 = await run();
  assert.match(r1.error, /AuthError/);
  assert.equal(world.webhookCalls.length, 1);
  const alert = sentBodies(world)[0];
  assert.equal(alert.event, "mori.poller.error");
  assert.equal(alert.error, "auth_expired");
  assert.match(alert.action, /login\.mjs/);
  advance(15 * MIN);
  await run();
  assert.equal(world.webhookCalls.length, 1, "24 時間以内は再送しない");
  advance(24 * HOUR);
  await run();
  assert.equal(world.webhookCalls.length, 2);
  assert.equal(state().consecutiveFailures, 3);
});

test("6'. 認証以外の失敗は ALERT_AFTER_FAILURES 回続いたら通知する", async () => {
  const { world, run, advance } = setup({ env: { ALERT_AFTER_FAILURES: "3" } });
  world.addSession(1);
  const down = { status: 503, body: {} };
  world.tokenResponses.push(down, down, down);
  await run();
  advance(15 * MIN);
  await run();
  assert.equal(world.webhookCalls.length, 0);
  advance(15 * MIN);
  await run();
  assert.equal(world.webhookCalls.length, 1);
  assert.equal(sentBodies(world)[0].error, "repeated_failures");
});

test("7a. MAX_SESSIONS_PER_RUN を守り、残りは次回に送る", async () => {
  const { world, run, advance } = setup({ env: { MAX_SESSIONS_PER_RUN: "2" } });
  for (let i = 1; i <= 5; i++) world.addSession(i, { startedAt: `2026-11-05T0${i}:00:00+09:00` });
  const r1 = await run();
  assert.equal(r1.sent, 2);
  assert.deepEqual(sentBodies(world)[0].sessions.map((s) => s.started_at), ["2026-11-05T01:00:00+09:00", "2026-11-05T02:00:00+09:00"], "古い順");
  advance(15 * MIN);
  assert.equal((await run()).sent, 2);
  advance(15 * MIN);
  assert.equal((await run()).sent, 1);
});

test("7b. RUN_TRANSCRIPT_BYTES_BUDGET を超えたらその回は止める", async () => {
  const { world, run } = setup({ env: { RUN_TRANSCRIPT_BYTES_BUDGET: "10000" } });
  for (let i = 1; i <= 3; i++) world.addSession(i, { startedAt: `2026-11-05T0${i}:00:00+09:00`, utterances: 40 });
  const r = await run();
  assert.equal(r.sent, 1);
  assert.ok(r.transcriptBytes >= 10000);
  assert.equal(world.calls.fetchTranscript, 1);
});

test("7c. サブリクエストの予算を超えない（予備で Webhook は送れる）", async () => {
  const { world, run } = setup({ env: { SUBREQUEST_BUDGET: "10" } });
  for (let i = 1; i <= 5; i++) world.addSession(i, { startedAt: `2026-11-05T0${i}:00:00+09:00` });
  const r = await run();
  assert.ok(r.subrequests <= 10, `subrequests=${r.subrequests}`);
  assert.ok(world.calls.total <= 10);
  // token 1 + initialize 2 + list 1 = 4、残り 3（予備 3）→ 1 件分（2 回）だけ
  assert.equal(r.sent, 1);
  assert.equal(world.webhookCalls.length, 1);
});

test("7d. 文字起こしで 429 が返ったら MCP の取得を打ち切り、取れた分だけ送る", async () => {
  const { world, run } = setup();
  world.addSession(1);
  world.addSession(2, { startedAt: "2026-11-05T11:00:00+09:00" });
  world.rateLimitTranscript = true;
  const r = await run();
  assert.equal(world.calls.fetchTranscript, 1);
  assert.equal(r.sent, 0);
  assert.equal(r.error, null);
});

test("8. crashGuard が MAX_ATTEMPTS 以上なら要約だけ送る。正常に終わった回は crashGuard が消える", async () => {
  const id = "00000001-0000-4000-8000-000000000000";
  const { world, run, state } = setup({ state: { crashGuard: { [id]: 3 }, startFrom: "2026-11-01T00:00:00+09:00" } });
  world.addSession(1);
  await run();
  assert.equal(world.calls.fetchTranscript, 0);
  const s = sentBodies(world)[0].sessions[0];
  assert.equal(s.transcript_omitted, true);
  assert.equal(s.transcript_omitted_reason, "too_large_for_plan");
  assert.equal(s.transcript_text, undefined);
  assert.deepEqual(state().crashGuard, {});
});

test("8'. 文字起こしの取得前に crashGuard を保存し、捕捉できた失敗では消す", async () => {
  const id = "00000001-0000-4000-8000-000000000000";
  const { world, kv, run, state } = setup();
  world.addSession(1);
  // Webhook 送信の時点で、KV に crashGuard が保存済みであることを確認する
  let guardAtSend = null;
  await run({
    send: async () => {
      guardAtSend = JSON.parse(kv.store.get("state")).crashGuard[id];
      return { ok: false, status: 500, error: "x" };
    },
  });
  assert.equal(guardAtSend, 1);
  assert.deepEqual(state().crashGuard, {}, "捕捉できた失敗なのでカウントは残らない");
});

test("8''. 前回落ちた疑いのある候補は、その回に 1 件だけで処理する", async () => {
  const id2 = "00000002-0000-4000-8000-000000000000";
  const { world, run, advance } = setup({ state: { crashGuard: { [id2]: 1 }, startFrom: "2026-11-01T00:00:00+09:00" } });
  world.addSession(1, { startedAt: "2026-11-05T09:00:00+09:00" });
  world.addSession(2, { startedAt: "2026-11-05T10:00:00+09:00" });
  world.addSession(3, { startedAt: "2026-11-05T11:00:00+09:00" });
  const r1 = await run();
  assert.equal(r1.sent, 2, "1 と 3 を送り、2 は後回し");
  assert.equal(r1.deferred, 1);
  advance(15 * MIN);
  const r2 = await run();
  assert.equal(r2.sent, 1);
  assert.equal(sentBodies(world)[1].sessions[0].session_id, id2);
});

test("8'''. 文字起こしの取得が MAX_ATTEMPTS 回続けて失敗したら要約だけ送る", async () => {
  const { world, run, advance } = setup();
  world.addSession(1, { failTranscript: true });
  for (let i = 0; i < 3; i++) {
    assert.equal((await run()).sent, 0);
    advance(15 * MIN);
  }
  const r = await run();
  assert.equal(r.sent, 1);
  assert.equal(sentBodies(world)[0].sessions[0].transcript_omitted_reason, "transcript_fetch_failed");
});

test("10. START_FROM より前に始まったセッションは無視する", async () => {
  const { world, run } = setup({ env: { START_FROM: "2026-11-05T10:30:00+09:00" } });
  world.addSession(1, { startedAt: "2026-11-05T10:00:00+09:00" });
  world.addSession(2, { startedAt: "2026-11-05T11:00:00+09:00" });
  const r = await run();
  assert.equal(r.sent, 1);
  assert.equal(sentBodies(world)[0].sessions[0].started_at, "2026-11-05T11:00:00+09:00");
});

test("START_FROM が空なら初回実行の時刻から（過去分は送らない）", async () => {
  const { world, run, state } = setup({ env: { START_FROM: "" } });
  world.addSession(1, { startedAt: "2026-11-05T10:00:00+09:00" });
  assert.equal((await run()).sent, 0);
  assert.equal(state().startFrom, new Date(NOW0).toISOString());
});

test("KV の書き込み: 新着がない回は state を保存せず、1 時間に 1 回だけ保存する", async () => {
  const { kv, run, advance } = setup();
  await run(); // 初回は保存
  const w1 = kv.writes;
  advance(15 * MIN);
  await run();
  assert.equal(kv.writes - w1, 1, "lock の 1 回だけ");
  advance(50 * MIN);
  await run();
  // 1 時間たったので lastRun を保存（lock 2 回 + state 1 回）。アクセストークンも期限切れで更新される（oauth 1 回）
  assert.equal(kv.writes - w1, 4);
});

test("lock があればスキップする", async () => {
  const { kv, run, world } = setup();
  kv.store.set("lock", "x");
  assert.deepEqual(await run(), { skipped: "locked" });
  assert.equal(world.calls.total, 0);
});

test("Webhook の送り先は GROK_WEBHOOK_URL だけ", async () => {
  const { world, run } = setup();
  world.addSession(1);
  await run();
  assert.ok(world.webhookCalls.length === 1);
  assert.equal(WEBHOOK_URL, "https://hooks.test/automations/webhook/r1");
});
