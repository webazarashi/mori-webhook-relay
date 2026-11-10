// Worker のエントリ: cron（scheduled）と管理用エンドポイント（fetch）
import { KEY_STATE, runOnce } from "./poller.js";
import { parseState, summarizeState } from "./state.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** Bearer トークンを定数時間で比較する（長さの違いも漏らさないよう、SHA-256 にしてから比べる） */
async function tokenMatches(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async scheduled(_controller, env, _ctx) {
    await runOnce({ env, kv: env.MORI_KV });
  },

  async fetch(request, env) {
    // ADMIN_TOKEN が未設定なら管理用エンドポイントは無効
    if (!env.ADMIN_TOKEN) return new Response("Not Found", { status: 404 });
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route !== "GET /status" && route !== "POST /run") return new Response("Not Found", { status: 404 });

    const auth = request.headers.get("authorization") || "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!given || !(await tokenMatches(given, env.ADMIN_TOKEN))) return json({ error: "unauthorized" }, 401);

    if (route === "GET /status") {
      const st = parseState(await env.MORI_KV.get(KEY_STATE));
      return json(summarizeState(st));
    }
    try {
      const result = await runOnce({ env, kv: env.MORI_KV });
      return json(result);
    } catch (e) {
      return json({ error: `${e?.name || "Error"}: ${String(e?.message || e).slice(0, 300)}` }, 500);
    }
  },
};
