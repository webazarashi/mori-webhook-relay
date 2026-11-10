#!/usr/bin/env node
// Workers ランタイムでの結合テスト（Cloudflare アカウント不要）
// モックの Mori MCP と Webhook の受け口を Node で立て、`cf dev --mode test -- --test-scheduled` で
// Worker を動かして /__scheduled を叩き、受け取ったペイロードを検証する
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_URL, WEBHOOK_URL, createMockWorld } from "../helpers/mock-mori.js";

const KV_ID = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID";
const LOCAL_STATE = ".wrangler/state";

/** `cf kv keys put --local` は書き込み後も終了しないことがあるので、結果（JSON）が出たら止める */
function seedKv(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["cf", "kv", "keys", "put", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const done = (err) => {
      clearTimeout(t);
      p.kill("SIGKILL");
      err ? reject(err) : resolve();
    };
    const t = setTimeout(() => done(new Error(`cf kv keys put がタイムアウトしました: ${out}`)), 60_000);
    p.stdout.on("data", (d) => {
      out += d;
      if (/\}\s*$/.test(out)) done();
    });
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => (code === 0 ? done() : done(new Error(`cf kv keys put が失敗しました (${code}): ${out}`))));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const world = createMockWorld({ sse: true });
world.addSession(1, { startedAt: new Date(Date.now() - 3600_000).toISOString(), utterances: 5 });
world.addSession(2, { startedAt: new Date(Date.now() - 1800_000).toISOString(), summary: null });

// HTTP サーバー → world.fetch（URL を mock の URL に読み替える）
const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const path = req.url.split("?")[0];
  const target = path === "/oauth/token" ? `${MCP_URL}/oauth/token` : path === "/hook" ? WEBHOOK_URL : MCP_URL;
  try {
    const r = await world.fetch(target, { method: req.method, headers: req.headers, body: body || undefined });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const mockPort = server.address().port;
const mockBase = `http://127.0.0.1:${mockPort}`;

const dir = mkdtempSync(join(tmpdir(), "mori-relay-it-"));
const devPort = 18000 + Math.floor(Math.random() * 1000);
let dev;
let failed = false;
try {
  // KV にローカルで oauth を入れる（トークンエンドポイントはモック）
  const oauthFile = join(dir, "oauth.json");
  writeFileSync(
    oauthFile,
    JSON.stringify({
      client_id: "cid",
      client_secret: null,
      token_endpoint: `${mockBase}/oauth/token`,
      resource: mockBase,
      access_token: "at-0",
      access_expires_at: 0,
      refresh_token: "rt-0",
      updated_at: new Date().toISOString(),
    }),
  );
  // cf dev はプロジェクトの .wrangler/state をローカルの KV に使う（--persist-to は dev に渡らない）。
  // 前回の実行の state が残らないよう、oauth と state を上書きする
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, "{}");
  await seedKv(["oauth", "--namespace-id", KV_ID, "--file", oauthFile, "--local", "--persist-to", LOCAL_STATE]);
  await seedKv(["state", "--namespace-id", KV_ID, "--file", stateFile, "--local", "--persist-to", LOCAL_STATE]);

  const env = {
    ...process.env,
    MCP_URL: mockBase,
    FETCH_INTERVAL_MS: "0",
    START_FROM: new Date(Date.now() - 86400_000).toISOString(),
    GROK_WEBHOOK_URL: `${mockBase}/hook`,
    GROK_WEBHOOK_KEY: "crsr_integration",
    CLOUDFLARE_SEND_METRICS: "false",
    WRANGLER_SEND_METRICS: "false",
  };
  dev = spawn("npx", ["cf", "dev", "--mode", "test", "--port", String(devPort)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let devLog = "";
  // 全体のタイムアウト（ハングしても CI を止めない）
  const killer = setTimeout(() => {
    console.error(`❌ 結合テスト: タイムアウトしました\n${devLog.slice(-4000)}\nmock calls: ${JSON.stringify(world.calls)}`);
    dev?.kill("SIGKILL");
    process.exit(1);
  }, 120_000);
  killer.unref();
  dev.stdout.on("data", (d) => (devLog += d));
  dev.stderr.on("data", (d) => (devLog += d));

  // 起動待ち
  const base = `http://127.0.0.1:${devPort}`;
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    await sleep(500);
    up = devLog.includes("Ready on");
  }
  if (!up) throw new Error(`cf dev が起動しませんでした:\n${devLog.slice(-3000)}`);

  const trigger = () => fetch(`${base}/cdn-cgi/local/scheduled?cron=${encodeURIComponent("*/15 * * * *")}`);
  const r = await trigger();
  assert.equal(r.status, 200, await r.text());
  for (let i = 0; i < 60 && world.webhookCalls.length === 0; i++) await sleep(500);
  if (!world.webhookCalls.length) throw new Error(`Webhook が呼ばれませんでした:\n${devLog.slice(-3000)}`);

  const call = world.webhookCalls[0];
  assert.equal(call.headers.authorization, "Bearer crsr_integration");
  const body = call.body;
  assert.equal(body.event, "mori.session.summary_completed");
  assert.equal(body.count, 1, "要約がまだのセッションは送らない");
  const s = body.sessions[0];
  assert.equal(s.summary, "架空の要約です。");
  assert.equal(s.transcript_text.split("\n").length, 5);
  assert.match(s.transcript_text, /^\[\d\d:\d\d:\d\d\] 自分: /);
  assert.equal(world.calls.token, 1, "トークンを更新した");

  // 2 回目は送らない（KV の state が効いている）
  const r2 = await trigger();
  assert.equal(r2.status, 200);
  await sleep(1500);
  assert.equal(world.webhookCalls.length, 1, "2 回目は送らない");
  console.log("✅ 結合テスト: OK（Workers ランタイムで scheduled → Webhook）");
} catch (e) {
  failed = true;
  console.error(`❌ 結合テスト: ${e.stack || e}`);
} finally {
  dev?.kill("SIGINT");
  await sleep(500);
  dev?.kill("SIGKILL");
  server.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
