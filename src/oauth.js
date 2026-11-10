// OAuth 2.1 のトークン管理（Workers / Node 共通。fetch と KV だけに依存する）
//
// KV の `oauth` キーの形:
// {
//   client_id, client_secret, token_endpoint_auth_method,
//   token_endpoint, resource, scope,
//   access_token, access_expires_at, refresh_token, updated_at
// }

export const DEFAULT_MCP_URL = "https://mcp.mori.to";
export const DEFAULT_SCOPE = "mori.sessions:read mori.transcripts:read";
const REFRESH_SKEW_MS = 60_000;
const TOKEN_TIMEOUT_MS = 30_000;

/** 再ログインが必要な認証エラー */
export class AuthError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

/** 一時的な障害（5xx・通信失敗など）。再ログインは不要 */
export class TokenEndpointError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = "TokenEndpointError";
    this.status = status;
  }
}

/**
 * リフレッシュトークンを送ってよい送り先か確認する。
 * https で、MCP サーバー（resource）と同じホストのものだけを許可する。
 */
export function assertTrustedTokenEndpoint(tokenEndpoint, resource) {
  let ep;
  let res;
  try {
    ep = new URL(tokenEndpoint);
    res = new URL(resource);
  } catch {
    throw new AuthError("token_endpoint または resource が URL として不正です");
  }
  const local = ep.hostname === "127.0.0.1" || ep.hostname === "localhost";
  if (ep.protocol !== "https:" && !(local && ep.protocol === "http:")) {
    throw new AuthError(`token_endpoint が https ではありません: ${ep.origin}`);
  }
  if (ep.host !== res.host) {
    throw new AuthError(`token_endpoint のホスト (${ep.host}) が MCP サーバー (${res.host}) と異なります`);
  }
}

async function getJson(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * OAuth のエンドポイントを探す。
 * protected-resource → authorization_servers → oauth-authorization-server（→ openid-configuration）。
 * 見つからなければ Mori で実測した既定の URL を返す。
 */
export async function discoverOAuthMetadata({ fetch: fetchImpl = fetch, mcpUrl = DEFAULT_MCP_URL } = {}) {
  const base = new URL(mcpUrl);
  const origin = base.origin;
  const prm = await getJson(fetchImpl, `${origin}/.well-known/oauth-protected-resource`);
  const resource = (prm && typeof prm.resource === "string" && prm.resource) || origin;
  const issuer = (prm && Array.isArray(prm.authorization_servers) && prm.authorization_servers[0]) || origin;
  const issuerUrl = new URL(issuer);
  const suffix = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname;
  let as =
    (await getJson(fetchImpl, `${issuerUrl.origin}/.well-known/oauth-authorization-server${suffix}`)) ||
    (await getJson(fetchImpl, `${issuerUrl.origin}/.well-known/openid-configuration${suffix}`));
  const discovered = Boolean(as);
  as = as || {};
  return {
    discovered,
    resource,
    issuer: as.issuer || issuer,
    authorization_endpoint: as.authorization_endpoint || `${origin}/authorize`,
    token_endpoint: as.token_endpoint || `${origin}/oauth/token`,
    registration_endpoint: as.registration_endpoint || `${origin}/register`,
    scopes_supported: as.scopes_supported || (prm && prm.scopes_supported) || null,
    iss_parameter_supported: as.authorization_response_iss_parameter_supported === true,
  };
}

/** トークンエンドポイントの応答を、エラーの種類ごとに例外へ変換する */
async function readTokenResponse(res) {
  let body = null;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (res.ok && body && typeof body.access_token === "string") return body;
  const code = (body && body.error) || null;
  const desc = String((body && body.error_description) || "").slice(0, 200);
  const detail = `HTTP ${res.status}${code ? ` ${code}` : ""}${desc ? `: ${desc}` : ""}`;
  if (res.status === 400 || res.status === 401 || code === "invalid_grant" || code === "invalid_client") {
    throw new AuthError(`トークンの更新が拒否されました (${detail})`, { code, status: res.status });
  }
  throw new TokenEndpointError(`トークンエンドポイントの一時的な障害 (${detail})`, { status: res.status });
}

/**
 * フォーム形式で token endpoint に POST する（client 認証方式に対応）
 */
export async function postTokenRequest(fetchImpl, record, params) {
  assertTrustedTokenEndpoint(record.token_endpoint, record.resource);
  const form = new URLSearchParams(params);
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (record.client_secret && record.token_endpoint_auth_method === "client_secret_basic") {
    const raw = `${encodeURIComponent(record.client_id)}:${encodeURIComponent(record.client_secret)}`;
    headers.Authorization = `Basic ${btoa(raw)}`;
  } else {
    form.set("client_id", record.client_id);
    if (record.client_secret) form.set("client_secret", record.client_secret);
  }
  let res;
  try {
    res = await fetchImpl(record.token_endpoint, {
      method: "POST",
      headers,
      body: form.toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (e) {
    throw new TokenEndpointError(`トークンエンドポイントに接続できません (${e?.name || "Error"}: ${String(e?.message || "").slice(0, 120)})`);
  }
  return readTokenResponse(res);
}

/**
 * KV に置いた OAuth の情報を使って、有効なアクセストークンを返す。
 * 新しい refresh_token が返ってきたら、使う前に KV へ保存する（ローテーションで失わないため）。
 */
export class TokenManager {
  constructor({ kv, fetch: fetchImpl = fetch, now = () => Date.now(), key = "oauth", log = () => {} }) {
    this.kv = kv;
    this.fetch = (url, init) => fetchImpl(url, init); // メソッド呼び出しにしない（Workers の Illegal invocation 対策）
    this.now = now;
    this.key = key;
    this.log = log;
    this.record = null;
    /** 直近の更新の情報（inspect 用。トークン自体は入れない） */
    this.lastRefresh = null;
  }

  async load() {
    const raw = await this.kv.get(this.key);
    if (!raw) throw new AuthError(`KV に ${this.key} がありません。scripts/login.mjs でログインしてください`);
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      throw new AuthError(`KV の ${this.key} が JSON として読めません`);
    }
    for (const f of ["client_id", "token_endpoint", "resource", "refresh_token"]) {
      if (!rec[f]) throw new AuthError(`KV の ${this.key} に ${f} がありません。再ログインしてください`);
    }
    this.record = rec;
    return rec;
  }

  isFresh(rec) {
    return Boolean(rec.access_token) && Number(rec.access_expires_at) - REFRESH_SKEW_MS > this.now();
  }

  /** @param {{force?: boolean}} [opts] force=true なら期限内でも更新する（401 を受けたとき） */
  async getAccessToken({ force = false } = {}) {
    const rec = this.record || (await this.load());
    if (!force && this.isFresh(rec)) return rec.access_token;
    return this.refresh(rec, { force });
  }

  async refresh(rec, { force = false, reread = false } = {}) {
    const usedRefreshToken = rec.refresh_token;
    let body;
    try {
      body = await postTokenRequest(this.fetch, rec, {
        grant_type: "refresh_token",
        refresh_token: usedRefreshToken,
        resource: rec.resource,
      });
    } catch (e) {
      if (e instanceof AuthError && !reread) {
        // 別の実行がすでにローテーションしていた場合（KV の伝播遅れ）に備えて 1 回だけ読み直す
        const latest = await this.load().catch(() => null);
        if (latest && latest.refresh_token !== usedRefreshToken) {
          this.log("oauth: KV のリフレッシュトークンが更新されていたので、その値でやり直します");
          if (!force && this.isFresh(latest)) return latest.access_token;
          return this.refresh(latest, { force, reread: true });
        }
      }
      throw e;
    }
    const now = this.now();
    const rotated = typeof body.refresh_token === "string" && body.refresh_token !== usedRefreshToken;
    const next = {
      ...rec,
      access_token: body.access_token,
      access_expires_at: now + (Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600) * 1000,
      refresh_token: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : usedRefreshToken,
      updated_at: new Date(now).toISOString(),
    };
    if (typeof body.scope === "string") next.scope = body.scope;
    // 使う前に保存する。保存に失敗したら例外にして、新しいトークンは使わない
    await this.kv.put(this.key, JSON.stringify(next));
    this.record = next;
    this.lastRefresh = {
      at: next.updated_at,
      refreshTokenReturned: typeof body.refresh_token === "string",
      refreshTokenRotated: rotated,
      expiresIn: Number(body.expires_in) || null,
    };
    return next.access_token;
  }
}
