import { createFreebuffAuth, type FreebuffAuth, type FreebuffUser } from "@freebuff/auth";
import type { Env, User } from "./types";
import { sha256Hex } from "./util";

/**
 * Sign in with Freebuff (Google/GitHub/Apple через Freebuff OIDC).
 *
 * Провізія: sites_enable_auth інжектить FREEBUFF_CLIENT_ID, FREEBUFF_ISSUER і
 * APP_ORIGIN у деплой. Локально використовується dev-клієнт з
 * `allowInsecureLocalhost` (тільки loopback, тільки development-змінні).
 *
 * SDK тримає сесію у власному cookie `__Host-freebuff_session`; records у D1
 * ключуються за `user.sub`. Для зворотної сумісності з наявною схемою
 * (users, sessions, картки оренди) після успішного `authenticate` користувач
 * зеркалиться в таблицю users — тож уся існуюча логіка (admin-списки,
 * ownership, звіти) працює без змін.
 */
export function createSiteAuth(env: Env): FreebuffAuth {
  const clientId = env.FREEBUFF_CLIENT_ID;
  if (!clientId) {
    throw new Error("FREEBUFF_CLIENT_ID is not configured");
  }
  const isLocal = env.ENVIRONMENT === "local";
  // baseUrl: канонічний origin деплою (public variable, не секрет).
  // Локально AllowInsecureLocalhost щоб приймати http://127.0.0.1:<port>.
  const baseUrl = isLocal
    ? "http://localhost:8787"
    : env.APP_ORIGIN?.replace(/\/+$/, "") || "";

  return createFreebuffAuth({
    clientId,
    issuer: env.FREEBUFF_ISSUER,
    baseUrl: baseUrl || "http://localhost:8787",
    allowInsecureLocalhost: isLocal,
  });
}

/** Переклад Freebuff-сесії в User для наявного коду. */
export async function freebuffUserToUser(env: Env, u: FreebuffUser): Promise<User> {
  const email = String(u.email ?? "").toLowerCase().slice(0, 254);
  const name = String(u.name ?? email ?? "Користувач").slice(0, 80);
  const picture = /^https:\/\//.test(String(u.picture ?? ""))
    ? String(u.picture).slice(0, 512)
    : "";
  const now = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO users (sub, email, name, picture, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(sub) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         picture = excluded.picture,
         last_login_at = excluded.last_login_at`,
    )
    .bind(u.sub, email, name, picture, now, now)
    .run();
  return { sub: u.sub, email, name, picture };
}

/** Хеш токена для дедуплікації сесій / розширеного аудиту (unused on hot path). */
export async function sessionFingerprint(request: Request): Promise<string> {
  const ua = request.headers.get("user-agent") ?? "";
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  return sha256Hex(`${ua}|${ip}`);
}
