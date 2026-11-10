// Grok Bot のルーティン Webhook への送信（送り先は GROK_WEBHOOK_URL だけ）

const WEBHOOK_TIMEOUT_MS = 30_000;

/**
 * @returns {Promise<{ok: boolean, status: number, error?: string}>}
 *   ok は HTTP 200 のときだけ true（200 =「受け付けて実行を開始した」）
 */
export async function postWebhook(fetchImpl, cfg, body) {
  if (!cfg.GROK_WEBHOOK_URL || !cfg.GROK_WEBHOOK_KEY) {
    return { ok: false, status: 0, error: "GROK_WEBHOOK_URL / GROK_WEBHOOK_KEY が設定されていません" };
  }
  let res;
  try {
    res = await fetchImpl(cfg.GROK_WEBHOOK_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.GROK_WEBHOOK_KEY}`,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, status: 0, error: `Webhook に接続できません (${e?.name || "Error"}: ${String(e?.message || "").slice(0, 120)})` };
  }
  // 応答の本文はエラーの手がかりとして先頭だけ読む（無効化されたルーティンは 400 "Automation <id> is disabled"）
  const snippet = res.status === 200 ? "" : (await res.text().catch(() => "")).slice(0, 200);
  if (res.status === 200) {
    await res.body?.cancel().catch(() => {});
    return { ok: true, status: 200 };
  }
  return { ok: false, status: res.status, error: `Webhook が HTTP ${res.status} を返しました${snippet ? `: ${snippet}` : ""}` };
}
