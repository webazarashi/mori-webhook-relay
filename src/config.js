// 環境変数（cloudflare.config.ts の vars と secret）を読み、既定値を補って検証する
// 既定値は Cloudflare Workers の無料プラン向け
import { DEFAULT_SUMMARY_PATH } from "./normalize.js";
import { DEFAULT_MCP_URL } from "./oauth.js";

const NUMBER_DEFAULTS = {
  WINDOW_DAYS: [8, 1, 60],
  MAX_SESSIONS_PER_RUN: [5, 1, 1000],
  RUN_TRANSCRIPT_BYTES_BUDGET: [300_000, 10_000, 1_000_000_000],
  MAX_ATTEMPTS: [3, 1, 100],
  PENDING_RECHECK_MIN: [120, 0, 100_000],
  FETCH_INTERVAL_MS: [7000, 0, 600_000],
  SUBREQUEST_BUDGET: [45, 8, 100_000],
  LIST_PAGE_LIMIT: [50, 1, 50],
  LIST_MAX_PAGES: [4, 1, 100],
  MAX_PAYLOAD_BYTES: [500_000, 10_000, 100_000_000],
  ALERT_INTERVAL_HOURS: [24, 0, 10_000],
  ALERT_AFTER_FAILURES: [6, 1, 10_000],
  SENT_RETENTION_DAYS: [14, 1, 365],
};

const ENUMS = {
  TRANSCRIPT_FORMAT: ["text", ["text", "raw", "both"]],
};

const STRING_DEFAULTS = {
  MCP_URL: DEFAULT_MCP_URL,
  START_FROM: "",
  SUMMARY_PATH: DEFAULT_SUMMARY_PATH,
  SPEAKER_SELF_LABEL: "自分",
  SPEAKER_OTHER_LABEL: "相手",
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());

export function loadConfig(env = {}) {
  const errors = [];
  const cfg = {};
  for (const [k, [def, min, max]] of Object.entries(NUMBER_DEFAULTS)) {
    const raw = str(env[k]);
    if (!raw) {
      cfg[k] = def;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) errors.push(`${k}=${raw} は ${min}〜${max} の数値にしてください`);
    else cfg[k] = Math.floor(n);
  }
  for (const [k, [def, allowed]] of Object.entries(ENUMS)) {
    const raw = str(env[k]).toLowerCase() || def;
    if (!allowed.includes(raw)) errors.push(`${k}=${raw} は ${allowed.join(" / ")} のどれかにしてください`);
    else cfg[k] = raw;
  }
  for (const [k, def] of Object.entries(STRING_DEFAULTS)) {
    const raw = str(env[k]);
    cfg[k] = raw || def;
  }
  const batch = str(env.BATCH).toLowerCase();
  if (batch && !["true", "false", "1", "0"].includes(batch)) errors.push(`BATCH=${batch} は true / false にしてください`);
  cfg.BATCH = !(batch === "false" || batch === "0");

  if (cfg.START_FROM && Number.isNaN(Date.parse(cfg.START_FROM))) {
    errors.push(`START_FROM=${cfg.START_FROM} は ISO 形式の日時にしてください（例: 2026-11-05T00:00:00+09:00）`);
  }
  try {
    new URL(cfg.MCP_URL);
  } catch {
    errors.push(`MCP_URL=${cfg.MCP_URL} が URL として不正です`);
  }

  cfg.GROK_WEBHOOK_URL = str(env.GROK_WEBHOOK_URL);
  cfg.GROK_WEBHOOK_KEY = str(env.GROK_WEBHOOK_KEY);
  cfg.ADMIN_TOKEN = str(env.ADMIN_TOKEN);
  if (cfg.GROK_WEBHOOK_URL) {
    try {
      const u = new URL(cfg.GROK_WEBHOOK_URL);
      if (u.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(u.hostname)) {
        errors.push("GROK_WEBHOOK_URL は https にしてください");
      }
    } catch {
      errors.push("GROK_WEBHOOK_URL が URL として不正です");
    }
  }

  if (errors.length) throw new ConfigError(`設定が正しくありません: ${errors.join(" / ")}`);
  return cfg;
}
