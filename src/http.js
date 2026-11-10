// 管理用エンドポイントの小物（応答の組み立てと ADMIN_TOKEN の照合）

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** 管理用の HTML ページ。bodyHtml は呼び出し側でエスケープ済みのもの */
export function html(title, bodyHtml, status = 200) {
  const page = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,-apple-system,"Hiragino Sans",sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.7;color:#1f2937;background:#f8fafc}
h1{font-size:1.4rem}code{background:#e2e8f0;padding:.1em .3em;border-radius:4px}
input{width:100%;box-sizing:border-box;padding:.6rem;font-size:1rem;border:1px solid #94a3b8;border-radius:6px}
button{margin-top:1rem;padding:.6rem 1.2rem;font-size:1rem;border:0;border-radius:6px;background:#1d4ed8;color:#fff;cursor:pointer}
.note{color:#475569;font-size:.9rem}
@media (prefers-color-scheme:dark){body{color:#e2e8f0;background:#0f172a}code{background:#1e293b}input{background:#1e293b;color:#e2e8f0}.note{color:#94a3b8}}
</style></head><body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`;
  return new Response(page, { status, headers: HTML_HEADERS });
}

/** トークンを定数時間で比較する（長さの違いも漏らさないよう、SHA-256 にしてから比べる） */
export async function tokenMatches(given, expected) {
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
