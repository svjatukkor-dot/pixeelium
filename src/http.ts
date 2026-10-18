import type { Env } from "./types";

export const CSP_HTML =
  "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; " +
  "style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self' https://cloudflareinsights.com; font-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export const CSP_API = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export function baseSecurityHeaders(url: URL, api: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": api ? CSP_API : CSP_HTML,
  };
  if (url.protocol === "https:") {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

export function json(
  url: URL,
  data: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(baseSecurityHeaders(url, true))) {
    if (!headers.has(k)) headers.set(k, v);
  }
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorJson(url: URL, status: number, message: string): Response {
  return json(url, { error: message }, { status });
}

/**
 * Same-origin enforcement for state-changing requests.
 * Browsers always send either Sec-Fetch-Site (modern) or Origin on POST;
 * a request carrying neither is not a normal browser navigation and is refused.
 */
export function checkSameOrigin(request: Request, env: Env): string | null {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return null;
  }
  const url = new URL(request.url);
  const allowed = new Set<string>([url.origin]);
  if (env.APP_ORIGIN) allowed.add(env.APP_ORIGIN.replace(/\/+$/, ""));

  const site = request.headers.get("sec-fetch-site");
  if (site) {
    if (site === "same-origin" || site === "none") return null;
    return `sec-fetch-site=${site}`;
  }
  const origin = request.headers.get("origin");
  if (origin) {
    if (allowed.has(origin.replace(/\/+$/, ""))) return null;
    return `origin=${origin}`;
  }
  return "missing origin";
}

/* ------------------------------- rate limits ------------------------------ */

/** Best-effort client IP for per-IP rules (rate limits, pending-order limits). */
export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * Fixed-window counter persisted in D1, so limits survive isolate restarts,
 * deploys and multiple isolates. Returns true when the request may proceed.
 */
export async function rateLimit(
  env: Env,
  request: Request,
  scope: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const ip = clientIp(request);
  const now = Date.now();
  const key = `${scope}:${ip}`;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start + ? <= excluded.window_start
                    THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start + ? <= excluded.window_start
                           THEN excluded.window_start ELSE rate_limits.window_start END
     RETURNING count`,
  )
    .bind(key, now, windowMs, windowMs)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

/** Housekeeping for cron: drop windows that can no longer be hit. */
export async function purgeRateLimits(env: Env, olderThanMs: number): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_start + ? <= ?")
    .bind(olderThanMs, Date.now())
    .run();
}

export function rateLimited(url: URL): Response {
  return json(url, { error: "Забагато запитів. Спробуйте за хвилину." }, { status: 429 });
}

/* --------------------------------- cookies -------------------------------- */

export function parseCookies(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const header = request.headers.get("cookie");
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value; // malformed percent-encoding must not break the request
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
}

export function buildCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? "/"}`,
    `Max-Age=${opts.maxAgeSeconds}`,
    `SameSite=${opts.sameSite ?? "Lax"}`,
  ];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Adds another header value next to the existing one.
 * Uses headers.append(), so multi-valued headers like Set-Cookie stay as
 * separate header lines (getSetCookie() must return one row per cookie) —
 * HTTP cookie merging via a comma would corrupt them.
 */
export function appendHeader(headers: Headers, name: string, value: string): void {
  headers.append(name, value);
}

export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

/** Reads a small JSON body, rejecting oversized payloads. */
export async function readJsonBody(request: Request, maxBytes = 8192): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error("payload too large");
  }
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("payload too large");
  if (!text.trim()) return {};
  return JSON.parse(text);
}
