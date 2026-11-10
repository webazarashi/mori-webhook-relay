// ポーリング本体（1 回の実行）
// 依存（kv・fetch・時計・sleep・log・送信先）は注入して、テストやローカル実行で差し替えられるようにする

import { BudgetExceededError, SubrequestBudget } from "./budget.js";
import { loadConfig } from "./config.js";
import { McpClient, RateLimitError } from "./mcp.js";
import {
  extractSession,
  extractSessionList,
  extractTranscript,
  findSummary,
  previewOf,
  sessionIdOf,
  sessionUri,
  startedAtOf,
  toEpochMs,
  transcriptUri,
} from "./normalize.js";
import { AuthError, TokenManager } from "./oauth.js";
import { buildSessionEntry, errorPayload, packPayloads } from "./payload.js";
import { fingerprint, needsSave, parseState, pruneState } from "./state.js";
import { postWebhook } from "./webhook.js";

export const KEY_STATE = "state";
export const KEY_LOCK = "lock";
export const KEY_OAUTH = "oauth";
const LOCK_TTL_SEC = 600;
const DAY = 86400_000;
const HOUR = 3600_000;

export const RELOGIN_ACTION = "scripts/login.mjs で再ログインし、KV の oauth を更新してください";

const errName = (e) => (e && e.name) || "Error";
/** ログやエラー通知に出す文言（本文やトークンは含めない） */
const errText = (e) => `${errName(e)}: ${String((e && e.message) || e).slice(0, 300)}`;

/**
 * 1 回実行する
 * @param {object} deps
 * @param {object} deps.env 環境変数（vars と secret）
 * @param {{get: Function, put: Function, delete: Function}} deps.kv
 * @param {typeof fetch} [deps.fetch]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {(msg: string, data?: object) => void} [deps.log]
 * @param {(body: string, meta: {ids: string[], kind: string}) => Promise<{ok: boolean, status: number, error?: string}>} [deps.send]
 *   送信の差し替え（dry-run 用）。省略時は GROK_WEBHOOK_URL へ POST する
 * @param {boolean} [deps.dryRun] true なら sent に記録しない
 */
export async function runOnce(deps) {
  const log = deps.log || ((msg, data) => console.log(JSON.stringify({ msg, ...data })));
  const now = deps.now || (() => Date.now());
  const kv = deps.kv;

  if (await kv.get(KEY_LOCK)) {
    log("skip: 別の実行が進行中です（lock）");
    return { skipped: "locked" };
  }
  await kv.put(KEY_LOCK, new Date(now()).toISOString(), { expirationTtl: LOCK_TTL_SEC });
  try {
    return await runLocked({ ...deps, log, now });
  } finally {
    await kv.delete(KEY_LOCK).catch(() => {});
  }
}

async function runLocked({ env, kv, fetch: fetchImpl = fetch, now, sleep = defaultSleep, log, send, dryRun = false }) {
  const cfg = loadConfig(env);
  const startMs = now();
  const nowIso = () => new Date(now()).toISOString();
  const budget = new SubrequestBudget(fetchImpl, cfg.SUBREQUEST_BUDGET, 3);
  const sendBody = send || ((body) => postWebhook(budget.reservedFetch, cfg, body));

  // 状態の読み込みと掃除
  const raw = await kv.get(KEY_STATE);
  const st = parseState(raw);
  const loadedFp = raw ? fingerprint(st) : null;
  const lastSavedRunAt = st.lastRun && st.lastRun.at;
  for (const id of pruneState(st, startMs, { sentRetentionDays: cfg.SENT_RETENTION_DAYS, windowDays: cfg.WINDOW_DAYS })) {
    log("pending を期限切れで削除しました（要約ができないまま WINDOW_DAYS を過ぎた）", { session_id: id });
  }
  if (!st.startFrom) st.startFrom = cfg.START_FROM ? new Date(Date.parse(cfg.START_FROM)).toISOString() : new Date(startMs).toISOString();
  const startFromMs = Date.parse(st.startFrom);

  const saveState = async () => {
    await kv.put(KEY_STATE, JSON.stringify(st));
  };

  const stats = {
    listed: 0,
    waiting: 0,
    checked: 0,
    completed: 0,
    sent: 0,
    transcriptBytes: 0,
    payloads: 0,
    deferred: 0,
  };
  let runError = null;
  let authError = null;
  const touchedGuards = new Set();

  try {
    const tm = new TokenManager({ kv, fetch: budget.fetch, now, key: KEY_OAUTH, log: (m) => log(m) });
    const client = new McpClient({ url: cfg.MCP_URL, fetch: budget.fetch, getToken: (o) => tm.getAccessToken(o) });
    await client.initialize();

    // 一覧（新しい順に返る。start は Session の開始時刻の下限）
    const windowStart = Math.max(startMs - cfg.WINDOW_DAYS * DAY, startFromMs);
    const items = [];
    let cursor = null;
    for (let page = 0; page < cfg.LIST_MAX_PAGES; page++) {
      const args = { start: new Date(windowStart).toISOString(), limit: cfg.LIST_PAGE_LIMIT };
      if (cursor) args.cursor = cursor;
      const res = await client.callTool("list_sessions", args);
      const pageItems = extractSessionList(res);
      items.push(...pageItems);
      cursor = res && typeof res.next_cursor === "string" && res.next_cursor ? res.next_cursor : null;
      if (!cursor || pageItems.length === 0) break;
    }
    stats.listed = items.length;

    // 一覧に出てこない ID の crashGuard / transcriptErrors は掃除する
    const listedIds = new Set(items.map(sessionIdOf).filter(Boolean));
    for (const map of [st.crashGuard, st.transcriptErrors]) {
      for (const id of Object.keys(map)) if (!listedIds.has(id)) delete map[id];
    }

    // 候補: 送信済みでなく、START_FROM 以降。開始時刻が古い順
    const candidates = [];
    for (const item of items) {
      const id = sessionIdOf(item);
      if (!id || st.sent[id]) continue;
      const t = toEpochMs(startedAtOf(item));
      if (t !== null && t < startFromMs) continue;
      candidates.push({ id, item, t: t ?? Number.MAX_SAFE_INTEGER });
    }
    candidates.sort((a, b) => a.t - b.t);

    const completed = [];
    let safetyNote = null;
    let transcriptsFetched = 0;
    let isolate = false;
    let stopFetching = false;

    for (const c of candidates) {
      if (stopFetching) break;
      if (completed.length >= cfg.MAX_SESSIONS_PER_RUN) break;
      if (stats.transcriptBytes >= cfg.RUN_TRANSCRIPT_BYTES_BUDGET) break;
      const { id, item } = c;

      // 一覧の preview が空 = 要約がまだ。fetch せずに待つ
      const preview = previewOf(item);
      if (preview !== undefined && preview.trim() === "") {
        stats.waiting++;
        continue;
      }
      // fetch で要約がなかったものは、再確認の間隔を守る
      const pend = st.pending[id];
      if (pend && startMs - Date.parse(pend.lastChecked) < cfg.PENDING_RECHECK_MIN * 60_000) {
        stats.waiting++;
        continue;
      }

      const guard = st.crashGuard[id] || 0;
      const tErrors = st.transcriptErrors[id] || 0;
      let omittedReason = null;
      if (guard >= cfg.MAX_ATTEMPTS) omittedReason = "too_large_for_plan";
      else if (tErrors >= cfg.MAX_ATTEMPTS) omittedReason = "transcript_fetch_failed";
      // 前回強制終了した疑いのある候補は、その 1 件だけを処理する
      if (!omittedReason && guard >= 1) {
        if (transcriptsFetched > 0) {
          stats.deferred++;
          continue;
        }
        isolate = true;
      }

      const need = omittedReason ? 1 : 2;
      if (!budget.canSpend(need)) {
        log("サブリクエストの予算が尽きたので、残りは次回に回します", { remaining_candidates: true });
        break;
      }

      // セッションを取得して要約を確認する
      let session;
      let summary;
      try {
        await sleep(cfg.FETCH_INTERVAL_MS);
        const res = await client.callTool("fetch", { uri: sessionUri(id) });
        if (!safetyNote && res && res.safety) safetyNote = res.safety;
        session = extractSession(res) || item;
        let found = findSummary(res, { path: cfg.SUMMARY_PATH });
        if (!found) {
          found = findSummary(res);
          if (found) log("SUMMARY_PATH で要約が見つからず、自動検出を使いました", { path: found.path });
        }
        summary = found ? found.value : null;
        stats.checked++;
      } catch (e) {
        if (e instanceof RateLimitError || e instanceof BudgetExceededError) {
          log("MCP の取得を打ち切りました", { error: errName(e) });
          break;
        }
        if (e instanceof AuthError) throw e;
        log("セッションの取得に失敗しました（次回に再試行）", { session_id: id, error: errText(e) });
        continue;
      }

      if (summary === null) {
        st.pending[id] = { firstSeen: (pend && pend.firstSeen) || nowIso(), lastChecked: nowIso() };
        stats.waiting++;
        continue;
      }

      // 文字起こし
      let transcript = null;
      if (!omittedReason) {
        st.crashGuard[id] = guard + 1;
        touchedGuards.add(id);
        await saveState(); // 強制終了したときだけカウントが残るよう、取得の前に保存する
        try {
          await sleep(cfg.FETCH_INTERVAL_MS);
          const uri = (session && typeof session.transcript_uri === "string" && session.transcript_uri) || transcriptUri(id);
          const res = await client.callTool("fetch", { uri });
          transcript = extractTranscript(res);
          if (!transcript) throw new Error("文字起こしの形が想定と違います（object.transcript がない）");
          stats.transcriptBytes += client.lastResponseBytes;
          transcriptsFetched++;
          delete st.transcriptErrors[id];
        } catch (e) {
          if (e instanceof AuthError) throw e;
          if (e instanceof RateLimitError || e instanceof BudgetExceededError) {
            log("MCP の取得を打ち切りました", { error: errName(e) });
            break;
          }
          st.transcriptErrors[id] = tErrors + 1;
          log("文字起こしの取得に失敗しました（次回に再試行）", {
            session_id: id,
            attempts: tErrors + 1,
            error: errText(e),
          });
          continue;
        }
      }

      completed.push(buildSessionEntry({ id, session, summary, transcript, omittedReason }, cfg));
      delete st.pending[id];
      if (isolate) stopFetching = true;
    }
    stats.completed = completed.length;

    // 送信
    if (completed.length) {
      const payloads = packPayloads(completed, {
        maxBytes: cfg.MAX_PAYLOAD_BYTES,
        batch: cfg.BATCH,
        sentAt: nowIso(),
        safety: safetyNote,
      });
      for (const p of payloads) {
        const r = await sendBody(p.body, { ids: p.ids, kind: "sessions" });
        stats.payloads++;
        if (r.ok) {
          if (!dryRun) for (const id of p.ids) st.sent[id] = nowIso();
          for (const id of p.ids) {
            delete st.crashGuard[id];
            delete st.transcriptErrors[id];
            touchedGuards.delete(id);
          }
          stats.sent += p.ids.length;
          if (!dryRun) await saveState(); // 二重送信の幅を小さくするため、すぐ保存する
        } else {
          runError = runError || `webhook_failed: ${r.error || `HTTP ${r.status}`}`;
          log("Webhook の送信に失敗しました（次回に再送）", { status: r.status, error: r.error, sessions: p.ids.length });
        }
      }
    }
  } catch (e) {
    if (e instanceof AuthError) authError = e;
    runError = errText(e);
    log("実行に失敗しました", { error: runError });
  }

  // 正常に終わった（捕捉できた）ので crashGuard を消す
  for (const id of touchedGuards) delete st.crashGuard[id];

  // エラー通知
  const canAlert = () => {
    const t = Date.parse(st.lastAlertAt || "");
    return !Number.isFinite(t) || now() - t >= cfg.ALERT_INTERVAL_HOURS * HOUR;
  };
  const alert = async (error, message, action) => {
    if (!canAlert()) {
      log("エラー通知は ALERT_INTERVAL_HOURS 以内に送信済みのため省略しました", { error });
      return;
    }
    const r = await sendBody(errorPayload({ error, message, action, sentAt: nowIso() }), { ids: [], kind: "alert" }).catch(
      (e) => ({ ok: false, status: 0, error: errText(e) }),
    );
    if (r.ok) st.lastAlertAt = nowIso();
    else log("エラー通知の送信に失敗しました", { status: r.status, error: r.error });
  };

  if (runError) {
    st.consecutiveFailures += 1;
    if (authError) {
      await alert("auth_expired", `Mori の認証が切れました（${authError.message}）`, RELOGIN_ACTION);
    } else if (st.consecutiveFailures >= cfg.ALERT_AFTER_FAILURES) {
      await alert(
        "repeated_failures",
        `mori-webhook-relay の実行が ${st.consecutiveFailures} 回続けて失敗しています（最後のエラー: ${runError}）`,
        "Cloudflare のダッシュボードで Worker のログを確認してください",
      );
    }
  } else {
    st.consecutiveFailures = 0;
  }

  st.lastRun = {
    at: nowIso(),
    sent: stats.sent,
    pending: stats.waiting,
    transcriptBytes: stats.transcriptBytes,
    subrequests: budget.used,
    error: runError,
  };
  if (needsSave(st, loadedFp, now(), lastSavedRunAt)) await saveState();

  const result = { ...stats, subrequests: budget.used, error: runError };
  log("run finished", result);
  return result;
}

const defaultSleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
