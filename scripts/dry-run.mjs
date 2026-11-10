#!/usr/bin/env node
// ポーラー本体をローカルで 1 回動かす。Webhook には送らず out/payload-*.json に書き出す（送信済みにもしない）
//
//   node scripts/dry-run.mjs [--since 3d | --since 2026-11-01T00:00:00+09:00]
//                            [--auth auth.local.json] [--state state.local.json] [--out out]
//
// 設定（TRANSCRIPT_FORMAT など）は環境変数で変えられる: TRANSCRIPT_FORMAT=both node scripts/dry-run.mjs
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runOnce } from "../src/poller.js";
import { parseArgs } from "./lib/args.mjs";
import { createFileKV, writePrivateFile } from "./lib/file-kv.mjs";

const args = parseArgs(process.argv.slice(2), {
  since: "3d",
  auth: "auth.local.json",
  state: "state.local.json",
  out: "out",
});

function sinceToIso(s) {
  const m = /^(\d+)([dh])$/.exec(String(s));
  if (m) return new Date(Date.now() - Number(m[1]) * (m[2] === "d" ? 86400_000 : 3600_000)).toISOString();
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`--since は 3d / 12h / ISO 日時のどれかにしてください: ${s}`);
  return new Date(t).toISOString();
}

const startFrom = sinceToIso(args.since);
const fileKv = createFileKV({ oauth: args.auth, state: args.state });
// --since を毎回効かせるため、保存済みの startFrom は読み込み時に捨てる
const kv = {
  ...fileKv,
  async get(key) {
    const v = await fileKv.get(key);
    if (key !== "state" || !v) return v;
    try {
      const st = JSON.parse(v);
      delete st.startFrom;
      return JSON.stringify(st);
    } catch {
      return v;
    }
  },
};

await mkdir(args.out, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
let n = 0;
const written = [];

const result = await runOnce({
  env: { ...process.env, START_FROM: startFrom, GROK_WEBHOOK_URL: "", GROK_WEBHOOK_KEY: "" },
  kv,
  dryRun: true,
  send: async (body, meta) => {
    const file = join(args.out, `payload-${stamp}-${++n}-${meta.kind}.json`);
    await writePrivateFile(file, `${JSON.stringify(JSON.parse(body), null, 2)}\n`);
    written.push({ file, bytes: Buffer.byteLength(body), sessions: meta.ids.length });
    return { ok: true, status: 200 };
  },
  log: (msg, data) => console.log(`· ${msg}${data ? ` ${JSON.stringify(data)}` : ""}`),
});

console.log(`\n対象: ${startFrom} 以降に始まったセッション`);
console.log("結果:", JSON.stringify(result));
for (const w of written) console.log(`  → ${w.file}（${w.sessions} 件, ${w.bytes} バイト）`);
if (!written.length) console.log("  （送る対象はありませんでした）");
console.log("\n⚠️  out/ には本物の会話が含まれます。共有・コミットしないでください。");
