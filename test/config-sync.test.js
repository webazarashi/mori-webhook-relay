// wrangler.jsonc（Deploy ボタン用）と cloudflare.config.ts（cf CLI 用）の内容がずれていないか確かめる
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** 行頭の // コメントだけを取り除いて JSON として読む（このファイルでは文字列の中に // を書かない） */
const wrangler = JSON.parse(read("wrangler.jsonc").replace(/^\s*\/\/.*$/gm, ""));
const cfConfig = read("cloudflare.config.ts");
const pick = (re) => {
  const m = cfConfig.match(re);
  assert.ok(m, `cloudflare.config.ts に ${re} が見つかりません`);
  return m[1];
};

test("wrangler.jsonc と cloudflare.config.ts の名前・入口・互換日・cron・KV がそろっている", () => {
  assert.equal(wrangler.name, pick(/name:\s*"([^"]+)"/));
  assert.equal(wrangler.main, pick(/entrypoint:\s*"([^"]+)"/));
  assert.equal(wrangler.compatibility_date, pick(/compatibilityDate:\s*"([^"]+)"/));
  assert.deepEqual(wrangler.triggers.crons, [pick(/schedule:\s*"([^"]+)"/)]);
  assert.deepEqual(
    wrangler.kv_namespaces.map((k) => k.binding),
    [pick(/(\w+):\s*bindings\.kv\(/)],
  );
});

test("Deploy ボタンが入力を求める secret は、Worker が読むものと一致する", () => {
  const example = read(".dev.vars.example")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => l.split("=")[0])
    .sort();
  assert.deepEqual(example, ["ADMIN_TOKEN", "GROK_WEBHOOK_KEY", "GROK_WEBHOOK_URL"]);
  const described = Object.keys(JSON.parse(read("package.json")).cloudflare.bindings).sort();
  for (const name of example) assert.ok(described.includes(name), `package.json の cloudflare.bindings に ${name} の説明がない`);
});
