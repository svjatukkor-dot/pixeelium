import type { Env } from "./types";

/**
 * Image proxy (item 4): instead of letting other people's hosts load directly
 * in the browser (CSP img-src http/https + privacy leak via Referer), the
 * board loads every rented picture through /api/img. The Worker checks:
 *  - the URL belongs to an ACTIVE rental's image_url (or a user avatar),
 *  - the upstream answer is an image/* with bytes <= 200 KB,
 *  - the target host is public (no SSRF into localhost/private ranges),
 * and then re-serves the bytes itself so CSP can be narrowed to 'self' data:.
 */

export const IMAGE_PROXY_MAX_BYTES = 200 * 1024;

export function isPublicHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal")) {
    return false;
  }
  // IPv6 loopback/link-local in brackets; plain IPv4 private ranges.
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare === "::1" || bare.startsWith("fe80:") || bare.startsWith("fc") || bare.startsWith("fd")) {
    return false;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
    const octets = bare.split(".").map(Number);
    const [a, b] = [octets[0]!, octets[1]!];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false; // multicast/reserved
  }
  return true;
}

/** Short-lived positive cache of approved proxy URLs (per isolate). */
const approved = new Map<string, number>();
const APPROVED_TTL_MS = 60_000;

async function imageAllowed(env: Env, cleanUrl: string): Promise<boolean> {
  const hit = approved.get(cleanUrl);
  if (hit && Date.now() - hit < APPROVED_TTL_MS) return true;

  // The URL must be one the board actually stores: a live rental banner
  // or a signed-in user's avatar picture.
  const rental = await env.DB
    .prepare("SELECT id FROM rentals WHERE image_url = ? AND expires_at > ? LIMIT 1")
    .bind(cleanUrl, Date.now())
    .first<{ id: string }>();
  let ok = Boolean(rental);
  if (!ok) {
    const user = await env.DB
      .prepare("SELECT sub FROM users WHERE picture = ? LIMIT 1")
      .bind(cleanUrl)
      .first<{ sub: string }>();
    ok = Boolean(user);
  }
  if (ok) {
    if (approved.size > 500) approved.clear();
    approved.set(cleanUrl, Date.now());
  }
  return ok;
}

export type ProxyResult = { ok: true; bytes: ArrayBuffer; contentType: string } | { ok: false };

/**
 * Fetches and validates a proxied image. Returns ok:false (mapped to 404 by
 * the caller) on ANY problem: never a proxy that surfaces upstream errors.
 */
export async function proxyImage(url: string, env: Env): Promise<ProxyResult> {
  if (!isPublicHttpUrl(url)) return { ok: false };
  if (!(await imageAllowed(env, url))) return { ok: false };

  let currentUrl = url;
  let upstream: Response | null = null;
  for (let hop = 0; hop < 4; hop++) {
    if (!isPublicHttpUrl(currentUrl)) return { ok: false };
    try {
      upstream = await fetch(currentUrl, {
        headers: { Accept: "image/*" },
        redirect: "manual",
      });
    } catch {
      return { ok: false };
    }
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const loc = upstream.headers.get("location");
      if (!loc) return { ok: false };
      try {
        currentUrl = new URL(loc, currentUrl).toString();
      } catch {
        return { ok: false };
      }
      continue;
    }
    break;
  }
  if (!upstream || !upstream.ok) return { ok: false };
  const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase().trim();
  if (!contentType.startsWith("image/")) return { ok: false };
  const declared = Number(upstream.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > IMAGE_PROXY_MAX_BYTES) return { ok: false };
  let bytes: ArrayBuffer;
  try {
    bytes = await upstream.arrayBuffer();
  } catch {
    return { ok: false };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_PROXY_MAX_BYTES) return { ok: false };
  return { ok: true, bytes, contentType };
}
