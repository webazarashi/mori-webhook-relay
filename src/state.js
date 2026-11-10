// KV の `state` キー（1 キーにまとめる）の読み込み・掃除・保存の判定

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** 中身が変わっていなくても、この間隔で lastRun を保存する（動いていることを確認するため） */
export const HEARTBEAT_MS = HOUR;

export function emptyState() {
  return {
    sent: {},
    pending: {},
    crashGuard: {},
    transcriptErrors: {},
    startFrom: null,
    consecutiveFailures: 0,
    lastAlertAt: null,
    lastRun: null,
  };
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export function parseState(raw) {
  const st = emptyState();
  if (!raw) return st;
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return st;
  }
  if (!isObj(v)) return st;
  for (const k of ["sent", "pending", "crashGuard", "transcriptErrors"]) if (isObj(v[k])) st[k] = v[k];
  if (typeof v.startFrom === "string") st.startFrom = v.startFrom;
  if (Number.isFinite(v.consecutiveFailures)) st.consecutiveFailures = v.consecutiveFailures;
  if (typeof v.lastAlertAt === "string") st.lastAlertAt = v.lastAlertAt;
  if (isObj(v.lastRun)) st.lastRun = v.lastRun;
  return st;
}

/** 古い記録を消す。消した pending の ID を返す（ログ用） */
export function pruneState(st, nowMs, { sentRetentionDays, windowDays }) {
  for (const [id, at] of Object.entries(st.sent)) {
    const t = Date.parse(at);
    if (!Number.isFinite(t) || nowMs - t > sentRetentionDays * DAY) delete st.sent[id];
  }
  const expired = [];
  for (const [id, p] of Object.entries(st.pending)) {
    const t = Date.parse(p && p.firstSeen);
    if (!Number.isFinite(t) || nowMs - t > windowDays * DAY) {
      delete st.pending[id];
      expired.push(id);
    }
  }
  return expired;
}

/**
 * 保存が必要かの判定用の内容。lastRun はエラーの有無だけを見る
 * （件数やサブリクエスト数だけが変わる回は保存せず、HEARTBEAT_MS ごとにまとめて保存する）
 */
export function fingerprint(st) {
  const { lastRun, ...rest } = st;
  return JSON.stringify({ ...rest, lastRunError: lastRun ? lastRun.error ?? null : null });
}

export function needsSave(st, loadedFingerprint, nowMs, lastSavedRunAt) {
  if (fingerprint(st) !== loadedFingerprint) return true;
  const t = Date.parse(lastSavedRunAt || "");
  return !Number.isFinite(t) || nowMs - t >= HEARTBEAT_MS;
}

/** /status 用の概要（本文やトークンは含めない） */
export function summarizeState(st) {
  return {
    startFrom: st.startFrom,
    sentCount: Object.keys(st.sent).length,
    pendingCount: Object.keys(st.pending).length,
    crashGuard: st.crashGuard,
    transcriptErrors: st.transcriptErrors,
    consecutiveFailures: st.consecutiveFailures,
    lastAlertAt: st.lastAlertAt,
    lastRun: st.lastRun,
  };
}
