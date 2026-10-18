import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_ISSUERS,
  GOOGLE_JWKS_URI,
  GOOGLE_TOKEN_ENDPOINT,
  OAUTH_COOKIE,
  OAUTH_TTL_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "./config";
import {
  appendHeader,
  buildCookie,
  errorJson,
  isSecureRequest,
  json,
  parseCookies,
} from "./http";
import type { Env, User } from "./types";
import {
  b64urlEncode,
  cleanText,
  decodeJsonSegment,
  randomHex,
  sha256Hex,
  timingSafeEqualStr,
  ValidationError,
} from "./util";

interface SessionUserRow {
  sub: string;
  email: string;
  name: string;
  picture: string;
  expires_at: number;
}

interface GoogleIdPayload {
  iss: string;
  aud: string | string[];
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  iat: number;
  exp: number;
  [k: string]: unknown;
}

export function appOrigin(env: Env, request: Request): string {
  const configured = env.APP_ORIGIN?.trim().replace(/\/+$/, "");
  const isLocal = env.ENVIRONMENT === "local";
  if (configured) {
    try {
      const u = new URL(configured);
      if (u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1") {
        return u.origin;
      }
    } catch {
      /* fall through */
    }
  }
  if (!isLocal) {
    console.error("APP_ORIGIN is required outside local (production APP_ORIGIN check)");
    throw new ValidationError("APP_ORIGIN не заданий — вхід через Google недоступний", 503);
  }
  return new URL(request.url).origin;
}

export async function currentUser(env: Env, request: Request): Promise<User | null> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.sub, u.email, u.name, u.picture, s.expires_at
       FROM sessions s JOIN users u ON u.sub = s.sub
      WHERE s.token_hash = ?`,
  )
    .bind(hash)
    .first<SessionUserRow>();
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at <= now) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
    return null;
  }
  return { sub: row.sub, email: row.email, name: row.name, picture: row.picture };
}

async function issueSession(
  env: Env,
  request: Request,
  sub: string,
): Promise<{ token: string; setCookie: string }> {
  const token = randomHex(32);
  const hash = await sha256Hex(token);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, sub, created_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(hash, sub, now, now + SESSION_TTL_MS, cleanText(request.headers.get("user-agent") ?? "", 200))
    .run();
  // drop other expired sessions for this user to keep the table small
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
  return {
    token,
    setCookie: buildCookie(SESSION_COOKIE, token, {
      maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
      httpOnly: true,
      secure: isSecureRequest(request),
    }),
  };
}

export async function loginRedirect(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return errorJson(url, 503, "Вхід через Google ще не налаштовано (немає ключів).");
  }

  const origin = appOrigin(env, request);
  const verifier = randomHex(32);
  const state = randomHex(16);
  const challenge = b64urlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/api/auth/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
    access_type: "online",
  });

  const cookie = buildCookie(OAUTH_COOKIE, `${state}.${verifier}`, {
    maxAgeSeconds: Math.floor(OAUTH_TTL_MS / 1000),
    httpOnly: true,
    secure: isSecureRequest(request),
  });

  const headers = new Headers({
    Location: `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

interface Jwk {
  kty: string;
  kid: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

async function findSigningKey(kid: string): Promise<Jwk> {
  const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < 10 * 60 * 1000;
  if (!fresh) {
    const res = await fetch(GOOGLE_JWKS_URI, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("JWKS unavailable");
    const body = (await res.json()) as { keys?: Jwk[] };
    if (!Array.isArray(body.keys)) throw new Error("JWKS malformed");
    jwksCache = { keys: body.keys, fetchedAt: Date.now() };
  }
  const keys = jwksCache?.keys ?? [];
  const key = keys.find((k) => k.kid === kid && k.kty === "RSA");
  if (!key) throw new Error("unknown signing key");
  return key;
}

async function verifyIdToken(env: Env, idToken: string): Promise<GoogleIdPayload> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");
  const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];

  const header = decodeJsonSegment<{ alg?: string; kid?: string }>(headerSeg);
  const payload = decodeJsonSegment<GoogleIdPayload>(payloadSeg);
  if (header.alg !== "RS256" || !header.kid) throw new Error("unexpected algorithm");

  const jwk = await findSigningKey(header.kid);
  const keyParam = {
    kty: jwk.kty,
    n: jwk.n,
    e: jwk.e,
    alg: "RS256",
    use: "sig",
  } as unknown as JsonWebKey;
  const key = await crypto.subtle.importKey(
    "jwk",
    keyParam,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signingInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  const signature = Uint8Array.from(atob(signatureSeg.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    signature as unknown as BufferSource,
    signingInput as unknown as BufferSource,
  );
  if (!valid) throw new Error("bad signature");

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(env.GOOGLE_CLIENT_ID ?? "missing")) throw new Error("bad audience");
  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new Error("bad issuer");
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("token expired");
  if (typeof payload.iat === "number" && payload.iat > now + 300) throw new Error("bad iat");
  if (!payload.sub || payload.sub.length > 128) throw new Error("bad subject");
  if (payload.email_verified !== true || !payload.email) throw new Error("email not verified");
  return payload;
}

export async function authCallback(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauth = parseCookies(request)[OAUTH_COOKIE];
  const clearOauth = buildCookie(OAUTH_COOKIE, "", {
    maxAgeSeconds: 0,
    httpOnly: true,
    secure: isSecureRequest(request),
  });

  /** Redirects back to the app so the user never sees a raw error page. */
  const bounce = (flag: string): Response => {
    const res = new Response(null, {
      status: 303,
      headers: {
        Location: `/?auth=${flag}`,
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    });
    appendHeader(res.headers, "Set-Cookie", clearOauth);
    return res;
  };

  const providerError = url.searchParams.get("error");
  if (providerError) return bounce("denied");

  const fail = (message: string): Response => {
    const res = errorJson(url, 400, message);
    appendHeader(res.headers, "Set-Cookie", clearOauth);
    return res;
  };

  if (!code || !state || !oauth) return fail("Немає параметрів авторизації");
  const [cookieState, verifier] = oauth.split(".") as [string, string | undefined];
  // Constant-time comparison: a byte-by-byte string diff would let an attacker
  // time-attack the CSRF state token.
  if (!verifier || !timingSafeEqualStr(cookieState, state ?? "")) {
    return fail("Невірний стан авторизації");
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return fail("Ключі Google не задані");

  const origin = appOrigin(env, request);
  const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: `${origin}/api/auth/callback`,
    }),
  });
  if (!tokenRes.ok) return fail("Google не підтвердив авторизацію");
  const tokenBody = (await tokenRes.json()) as { id_token?: string };
  if (!tokenBody.id_token) return fail("Google не повернув токен");

  let payload: GoogleIdPayload;
  try {
    payload = await verifyIdToken(env, tokenBody.id_token);
  } catch (err) {
    // Details (signature/audience/etc.) go to the logs only — never back to
    // the user, they could leak config specifics.
    console.log("verifyIdToken rejected token", err instanceof Error ? err.message : String(err));
    return fail("Не вдалося перевірити токен входу. Спробуйте ще раз.");
  }

  const now = Date.now();
  const email = String(payload.email ?? "").toLowerCase().slice(0, 254);
  const name = cleanText(payload.name ?? email, 80);
  const picture = /^https:\/\//.test(String(payload.picture ?? ""))
    ? String(payload.picture).slice(0, 512)
    : "";

  await env.DB.prepare(
    `INSERT INTO users (sub, email, name, picture, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET
       email = excluded.email,
       name = excluded.name,
       picture = excluded.picture,
       last_login_at = excluded.last_login_at`,
  )
    .bind(payload.sub, email, name, picture, now, now)
    .run();

  const session = await issueSession(env, request, payload.sub);
  const res = new Response(null, {
    status: 303,
    headers: {
      Location: "/?auth=ok",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
  appendHeader(res.headers, "Set-Cookie", session.setCookie);
  appendHeader(res.headers, "Set-Cookie", clearOauth);
  return res;
}

export async function logout(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    const hash = await sha256Hex(token);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
  }
  const res = json(url, { ok: true });
  appendHeader(
    res.headers,
    "Set-Cookie",
    buildCookie(SESSION_COOKIE, "", {
      maxAgeSeconds: 0,
      httpOnly: true,
      secure: isSecureRequest(request),
    }),
  );
  return res;
}
