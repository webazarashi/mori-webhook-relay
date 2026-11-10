#!/usr/bin/env node
// Mori MCP の応答の「形」を調べる（ローカル専用）
//
//   node scripts/inspect.mjs [--auth auth.local.json] [--days 3] [--limit 5] [--session <id>]
//                            [--interval 7000] [--mcp-url <url>] [--no-rotation-check]
//
// - 生の応答は inspect-output/raw-*.json に保存する（本物の会話が入るので共有しない）
// - 本文を伏せたレポートを inspect-output/report.json と画面に出す（Issue に貼るならこちら）
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpClient } from "../src/mcp.js";
import {
  describeShape,
  describeValueBrief,
  extractSessionList,
  extractTranscript,
  findSummary,
  listSummaryKeyPaths,
  sessionIdOf,
  sessionUri,
  startedAtOf,
  toEpochMs,
  transcriptUri,
  utterancesOf,
} from "../src/normalize.js";
import { DEFAULT_MCP_URL, TokenManager } from "../src/oauth.js";
import { parseArgs } from "./lib/args.mjs";
import { createFileKV } from "./lib/file-kv.mjs";

const args = parseArgs(process.argv.slice(2), {
  auth: "auth.local.json",
  days: "3",
  limit: "5",
  session: null,
  interval: "7000",
  mcpUrl: DEFAULT_MCP_URL,
  rotationCheck: true,
  outDir: "inspect-output",
});
const DAYS = Number(args.days);
const LIMIT = Math.min(50, Number(args.limit));
const INTERVAL = Number(args.interval);
const OUT = args.outDir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { generated_at: new Date().toISOString(), mcp_url: args.mcpUrl, notes: [] };

async function saveRaw(name, data) {
  await writeFile(join(OUT, `raw-${name}.json`), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

const jstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

function idForm(raw) {
  const s = String(raw ?? "");
  if (s.startsWith("mori://session/")) return "mori://session/<id>";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return "uuid";
  return s ? `other(len=${s.length})` : "missing";
}

function timeForm(v) {
  if (typeof v === "number") return v > 1e12 ? "epoch_ms" : v > 1e9 ? "epoch_s" : "number(offset_seconds?)";
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return /(Z|[+-]\d{2}:?\d{2})$/.test(v) ? "iso_with_tz" : "iso_no_tz";
    return `string(${describeShape(v, "time")})`;
  }
  return v === undefined ? "missing" : typeof v;
}

function orderOf(items) {
  const ts = items.map((it) => toEpochMs(startedAtOf(it))).filter((t) => t !== null);
  if (ts.length < 2) return "unknown(<2)";
  let asc = true;
  let desc = true;
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] < ts[i - 1]) asc = false;
    if (ts[i] > ts[i - 1]) desc = false;
  }
  return asc ? "ascending" : desc ? "descending" : "unsorted";
}

function startedKeyOf(item) {
  for (const k of ["started_at", "start_time", "startedAt", "startTime", "start", "recorded_at"]) {
    if (item && item[k] !== undefined) return k;
  }
  return null;
}

async function callToolRaw(client, name, toolArgs) {
  const raw = await client.request("tools/call", { name, arguments: toolArgs });
  let parsed = null;
  let parseNote = null;
  if (raw && raw.structuredContent !== undefined && raw.structuredContent !== null) {
    parsed = raw.structuredContent;
    parseNote = "structuredContent";
  } else if (raw && Array.isArray(raw.content)) {
    for (const c of raw.content) {
      if (c && c.type === "text" && typeof c.text === "string") {
        try {
          parsed = JSON.parse(c.text);
          parseNote = "text(JSON)";
          break;
        } catch {
          parseNote = "text(not JSON)";
        }
      }
    }
  }
  return {
    raw,
    parsed,
    isError: Boolean(raw && raw.isError),
    via: parseNote,
    contentTypes: raw && Array.isArray(raw.content) ? raw.content.map((c) => c && c.type) : [],
    bytes: new TextEncoder().encode(JSON.stringify(raw)).length,
  };
}

async function tryList(client, label, from, to) {
  const entry = { label, args: { from, to, limit: LIMIT, offset: 0 } };
  try {
    const r = await callToolRaw(client, "list_sessions", entry.args);
    await saveRaw(`list-${label}`, r.raw);
    entry.isError = r.isError;
    entry.via = r.via;
    if (r.isError) {
      entry.error = describeShape(r.raw);
      return { entry, items: null };
    }
    const items = extractSessionList(r.parsed);
    const fromMs = toEpochMs(from);
    const toMs = toEpochMs(to);
    entry.count = items.length;
    entry.top_level_shape = describeShape(r.parsed);
    entry.order_by_started = orderOf(items);
    entry.started_key = items[0] ? startedKeyOf(items[0]) : null;
    entry.started_form = items[0] ? timeForm(startedAtOf(items[0])) : null;
    entry.id_forms = [...new Set(items.map((it) => idForm(it.id ?? it.session_id ?? it.uri)))];
    entry.started_within_range = items.filter((it) => {
      const t = toEpochMs(startedAtOf(it));
      return t !== null && fromMs !== null && toMs !== null && t >= fromMs && t <= toMs;
    }).length;
    entry.summary_in_list_items = items.map((it) => {
      const f = findSummary(it);
      return f ? { path: f.path, ...describeValueBrief(f.value) } : null;
    });
    entry.summary_key_paths_in_items = [...new Set(items.flatMap((it) => listSummaryKeyPaths(it)))];
    return { entry, items };
  } catch (e) {
    entry.error = `${e.name}: ${e.message}`;
    return { entry, items: null };
  }
}

async function main() {
  await mkdir(OUT, { recursive: true, mode: 0o700 });
  const kv = createFileKV({ oauth: args.auth });
  const tm = new TokenManager({ kv, log: (m) => console.log(`  ${m}`) });

  // 1. リフレッシュ（ローテーションの有無）
  console.log("🔑 トークンを確認しています…");
  if (args.rotationCheck) {
    await tm.getAccessToken({ force: true });
    report.token_refresh = tm.lastRefresh;
  } else {
    await tm.getAccessToken();
    report.token_refresh = "skipped";
  }

  // 2. initialize と tools/list
  const client = new McpClient({ url: args.mcpUrl, getToken: (o) => tm.getAccessToken(o) });
  console.log("🔌 MCP に接続しています…");
  await client.initialize();
  report.initialize = {
    protocolVersion: client.protocolVersion,
    sessionIdHeader: Boolean(client.sessionId),
    serverInfo: client.serverInfo,
  };
  const tools = await client.request("tools/list", {});
  await saveRaw("tools-list", tools);
  report.tools = (tools.tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
  }));

  // 3. list_sessions を 2 つの日付形式で
  console.log("📋 list_sessions を確認しています…");
  const now = Date.now();
  const fromMs = now - DAYS * 86400_000;
  const a = await tryList(client, "datetime", new Date(fromMs).toISOString(), new Date(now).toISOString());
  await sleep(1000);
  const b = await tryList(client, "date", jstDate(fromMs), jstDate(now + 86400_000));
  report.list_sessions = [a.entry, b.entry];
  if (a.items && b.items) {
    const ids = (xs) => new Set(xs.map(sessionIdOf));
    const sa = ids(a.items);
    const sb = ids(b.items);
    report.notes.push(
      `datetime と date の結果で一致する ID: ${[...sa].filter((x) => sb.has(x)).length} / datetime ${sa.size} 件 / date ${sb.size} 件`,
    );
  }
  const items = a.items || b.items;
  if (!items) {
    report.notes.push("list_sessions がどちらの形式でも失敗しました");
    return;
  }

  // 4. 各セッションを fetch mori://session/<id>
  let targets = items;
  if (args.session) {
    const want = String(args.session).replace(/^mori:\/\/session\//, "");
    targets = items.filter((it) => sessionIdOf(it) === want);
    if (!targets.length) targets = [{ id: want }];
  }
  targets = targets.slice(0, LIMIT);
  report.sessions = [];
  let withSummary = null;
  for (const [i, it] of targets.entries()) {
    const id = sessionIdOf(it);
    console.log(`🧾 セッション ${i + 1}/${targets.length} を確認しています…`);
    await sleep(INTERVAL);
    const s = { index: i, id_form: idForm(it.id ?? it.session_id ?? it.uri), list_item_shape: describeShape(it) };
    try {
      const r = await callToolRaw(client, "fetch", { uri: sessionUri(id) });
      await saveRaw(`session-${i}`, r.raw);
      s.fetch_session = { ok: !r.isError, via: r.via, content_types: r.contentTypes, bytes: r.bytes };
      if (r.isError) {
        s.fetch_session.error = describeShape(r.raw);
      } else {
        s.fetch_session.shape = describeShape(r.parsed);
        const f = findSummary(r.parsed);
        s.fetch_session.summary = f ? { path: f.path, ...describeValueBrief(f.value) } : null;
        s.fetch_session.summary_key_paths = listSummaryKeyPaths(r.parsed);
        s.fetch_session.has_transcript = Boolean(extractTranscript(r.parsed));
        if (f && !withSummary) withSummary = { index: i, id };
      }
    } catch (e) {
      s.fetch_session = { ok: false, error: `${e.name}: ${e.message}` };
    }
    const fl = findSummary(it);
    s.summary_in_list_item = fl ? { path: fl.path, ...describeValueBrief(fl.value) } : null;
    if (fl && !withSummary) withSummary = { index: i, id };
    report.sessions.push(s);
  }

  // 5. 文字起こし（要約のあるセッション。なければ先頭）
  const t = withSummary || (targets[0] ? { index: 0, id: sessionIdOf(targets[0]) } : null);
  if (t) {
    console.log("🗣  文字起こしを確認しています…");
    await sleep(INTERVAL);
    const tr = { session_index: t.index, chosen_because: withSummary ? "has_summary" : "first_session" };
    try {
      const r = await callToolRaw(client, "fetch", { uri: transcriptUri(t.id) });
      await saveRaw(`transcript-${t.index}`, r.raw);
      tr.ok = !r.isError;
      tr.via = r.via;
      tr.bytes = r.bytes;
      if (r.isError) {
        tr.error = describeShape(r.raw);
      } else {
        const transcript = extractTranscript(r.parsed);
        const utts = utterancesOf(transcript);
        tr.transcript_found_at = r.parsed?.object?.transcript ? "object.transcript" : transcript ? "other" : null;
        tr.utterance_count = utts ? utts.length : null;
        if (utts && utts.length) {
          const keyCounts = {};
          for (const u of utts) for (const k of Object.keys(u || {})) keyCounts[k] = (keyCounts[k] || 0) + 1;
          tr.utterance_key_counts = keyCounts;
          const u0 = utts[0];
          tr.utterance_time_form = timeForm(u0.started_at ?? u0.start_time);
          tr.first_utterance_shape = describeShape(u0);
        }
        const rest = { ...r.parsed };
        if (rest.object && typeof rest.object === "object") {
          rest.object = { ...rest.object };
          if (rest.object.transcript && typeof rest.object.transcript === "object") {
            rest.object.transcript = { ...rest.object.transcript, utterances: `<omitted ${utts ? utts.length : 0}>` };
          }
        }
        tr.shape_without_utterances = describeShape(rest);
        const f = findSummary(r.parsed);
        tr.summary_in_transcript_result = f ? { path: f.path, ...describeValueBrief(f.value) } : null;
        tr.summary_key_paths = listSummaryKeyPaths(r.parsed);
      }
    } catch (e) {
      tr.ok = false;
      tr.error = `${e.name}: ${e.message}`;
    }
    report.transcript = tr;
  }
}

main()
  .catch((e) => {
    report.fatal = `${e.name}: ${e.message}`;
    process.exitCode = 1;
  })
  .finally(async () => {
    await mkdir(OUT, { recursive: true });
    await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log("\n===== 伏せたレポート（inspect-output/report.json）=====");
    console.log(JSON.stringify(report, null, 2));
    console.log("\n⚠️  inspect-output/raw-*.json には本物の会話が含まれます。共有・コミットしないでください。");
  });
