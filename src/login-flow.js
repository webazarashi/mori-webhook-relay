// Mori への OAuth ログイン（認可コード + PKCE + 動的クライアント登録）
// Worker の /setup とローカルの scripts/login.mjs の両方で使う。fetch と Web Crypto だけに依存する。
import { DEFAULT_SCOPE, assertTrustedTokenEndpoint, postTokenRequest } from "./oauth.js";

const REGISTER_TIMEOUT_MS = 30_000;

const b64url = (bytes) => {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** ランダムな文字列（base64url） */
export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE（S256）の verifier と challenge を作る */
export async function createPkce() {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

/** 動的クライアント登録。redirect_uri ごとに新しい client_id をもらう */
export async function registerClient({ fetch: fetchImpl = fetch, meta, redirectUri, scope = DEFAULT_SCOPE }) {
  assertTrustedTokenEndpoint(meta.token_endpoint, meta.resource);
  const res = await fetchImpl(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "mori-webhook-relay",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope,
    }),
    signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`クライアント登録に失敗しました (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const reg = await res.json();
  if (!reg.client_id) throw new Error("クライアント登録の応答に client_id がありません");
  return {
    client_id: reg.client_id,
    client_secret: reg.client_secret ?? null,
    token_endpoint_auth_method: reg.token_endpoint_auth_method || "none",
    token_endpoint: meta.token_endpoint,
    resource: meta.resource,
    scope,
  };
}

/** 認可画面の URL */
export function buildAuthorizeUrl({ meta, client, redirectUri, challenge, state }) {
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: client.scope,
    resource: meta.resource,
  }).toString();
  return url.toString();
}

/**
 * 認可サーバーから戻ってきたときのパラメーターを確かめて、認可コードを返す。
 * state の照合は呼び出し側で済ませておく。
 * missingIss: サーバーが iss 対応を公開しているのに iss が無かった（警告だけ出す。実測の Mori で止めないため）
 */
export function readCallbackCode(params, { issuer, issParameterSupported = false } = {}) {
  const iss = params.get("iss");
  if (iss && issuer && iss !== issuer) throw new Error(`発行元 (iss) が一致しません: ${iss}`);
  const error = params.get("error");
  if (error) throw new Error(`認可が拒否されました: ${error} ${params.get("error_description") || ""}`.trim());
  const code = params.get("code");
  if (!code) throw new Error("認可コードがありません");
  return { code, missingIss: !iss && issParameterSupported };
}

/** 認可コードをトークンに換えて、KV の `oauth` に入れる形にする */
export async function exchangeCode({ fetch: fetchImpl = fetch, client, code, verifier, redirectUri, now = Date.now() }) {
  const tok = await postTokenRequest(fetchImpl, client, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource: client.resource,
  });
  if (!tok.refresh_token) throw new Error("リフレッシュトークンが返りませんでした（定期実行に必要です）");
  return {
    ...client,
    scope: typeof tok.scope === "string" ? tok.scope : client.scope,
    access_token: tok.access_token,
    access_expires_at: now + (Number(tok.expires_in) > 0 ? Number(tok.expires_in) : 3600) * 1000,
    refresh_token: tok.refresh_token,
    updated_at: new Date(now).toISOString(),
  };
}
