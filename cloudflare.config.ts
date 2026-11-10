// mori-webhook-relay の Cloudflare 設定（cf CLI 用）
//
// 1. KV の ID: `npx cf kv namespaces create` で作った ID を下の MORI_KV_NAMESPACE_ID に書くか、
//    環境変数 MORI_KV_NAMESPACE_ID に入れてから `npx cf deploy` する
// 2. 有料プラン（Workers Paid）なら PLAN を "paid" にする（または MORI_RELAY_PLAN=paid）
// 3. 個別に変えたい値は OVERRIDES に書く（一覧は README の「設定一覧」）
import { bindings, defineConfig, triggers } from "cf/config";

const MORI_KV_NAMESPACE_ID = process.env.MORI_KV_NAMESPACE_ID ?? "REPLACE_WITH_YOUR_KV_NAMESPACE_ID";
const PLAN: "free" | "paid" = process.env.MORI_RELAY_PLAN === "paid" ? "paid" : "free";

/** 無料プランの既定値は src/config.js にある。ここに書くのは変えたいものだけ */
const OVERRIDES: Record<string, string> = {
  // START_FROM: "2026-11-05T00:00:00+09:00", // これより前に始まったセッションは無視（空なら初回実行の時刻）
  // TRANSCRIPT_FORMAT: "text",               // text / raw / both
  // BATCH: "true",
};

/** 有料プランのおすすめ値（CPU 上限 30 秒・サブリクエスト 1,000 回以上） */
const PAID_PRESET: Record<string, string> = {
  MAX_SESSIONS_PER_RUN: "20",
  RUN_TRANSCRIPT_BYTES_BUDGET: "5000000",
  SUBREQUEST_BUDGET: "900",
  LIST_MAX_PAGES: "10",
};

// 結合テスト（--mode test）のときだけ、接続先などを環境変数で差し替えられる
const TEST_KEYS = ["MCP_URL", "FETCH_INTERVAL_MS", "START_FROM", "TRANSCRIPT_FORMAT", "MAX_PAYLOAD_BYTES"];

export default defineConfig((ctx) => {
  const vars: Record<string, string> = { ...(PLAN === "paid" ? PAID_PRESET : {}), ...OVERRIDES };
  if (ctx.mode === "test") {
    for (const k of TEST_KEYS) if (process.env[k] !== undefined) vars[k] = process.env[k] as string;
  }
  return {
    worker: {
      name: "mori-webhook-relay",
      compatibilityDate: "2026-10-01",
      entrypoint: "./src/index.js",
      workersDev: true,
      observability: { enabled: true },
      triggers: [triggers.scheduled({ schedule: "*/15 * * * *" })],
      env: {
        MORI_KV: bindings.kv({ id: MORI_KV_NAMESPACE_ID }),
        // 必須の secret（未設定だとデプロイが失敗する）。ADMIN_TOKEN は任意なので宣言しない
        GROK_WEBHOOK_URL: bindings.secret(),
        GROK_WEBHOOK_KEY: bindings.secret(),
        ...Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, bindings.text(v)])),
      },
    },
  };
});
