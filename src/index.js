// Worker のエントリ: cron（scheduled）と管理用エンドポイント（fetch）
import { json, tokenMatches } from "./http.js";
import { KEY_OAUTH, KEY_STATE, runOnce } from "./poller.js";
import { handleSetup } from "./setup.js";
import { parseState, summarizeState } from "./state.js";

/**
 * 使ってよい ADMIN_TOKEN か。短いものや、.dev.vars.example の見本（<...>）のままのものは未設定と同じ扱いにする
 * （Deploy ボタンの画面で見本を書き換え忘れたまま、だれでも /setup を使える状態にしないため）
 */
export function isUsableAdminToken(token) {
  return typeof token === "string" && token.length >= 16 && !/[<>\s]/.test(token);
}

export default {
  async scheduled(_controller, env, _ctx) {
    await runOnce({ env, kv: env.MORI_KV });
  },

  async fetch(request, env) {
    // ADMIN_TOKEN が未設定（または見本のまま）なら管理用エンドポイント（/setup を含む）は無効
    if (!isUsableAdminToken(env.ADMIN_TOKEN)) return new Response("Not Found", { status: 404 });

    const setup = await handleSetup(request, env);
    if (setup) return setup;

    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route !== "GET /status" && route !== "POST /run") return new Response("Not Found", { status: 404 });

    const auth = request.headers.get("authorization") || "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!given || !(await tokenMatches(given, env.ADMIN_TOKEN))) return json({ error: "unauthorized" }, 401);

    if (route === "GET /status") {
      const [rawState, rawOauth] = await Promise.all([env.MORI_KV.get(KEY_STATE), env.MORI_KV.get(KEY_OAUTH)]);
      return json({ loggedIn: Boolean(rawOauth), ...summarizeState(parseState(rawState)) });
    }
    try {
      const result = await runOnce({ env, kv: env.MORI_KV });
      return json(result);
    } catch (e) {
      return json({ error: `${e?.name || "Error"}: ${String(e?.message || e).slice(0, 300)}` }, 500);
    }
  },
};
