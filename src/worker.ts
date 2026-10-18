import { currentUser, logout } from "./auth";
import { createSiteAuth, freebuffUserToUser } from "./freebuff-auth";
import { isSameOriginRequest } from "@freebuff/auth";
import {
  BUY_UNTIL,
  GRID_CACHE_MS,
  GRID_H,
  GRID_W,
  MAX_CELLS_PER_ORDER,
  MAX_HOURS,
  MIN_HOURS,
  ORDER_TTL_MS,
  PRICE_MICRO_PER_PIXEL_BUY,
  PRICE_MICRO_PER_PIXEL_HOUR,
  RESERVED_TOP_ROWS,
} from "./config";
import {
  baseSecurityHeaders,
  checkSameOrigin,
  errorJson,
  json,
  purgeRateLimits,
  rateLimit,
  rateLimited,
  readJsonBody,
  clientIp,
} from "./http";
import { proxyImage } from "./imgproxy";
import { classifyIncoming } from "./incoming";
import { ART_PALETTE_VERSION } from "./palette";
import { checkPendingLimits } from "./orderlimits";
import { listIncomingTrc20, verifyUsdtTransfer } from "./payments";
import { SCHEMA_SQL } from "./schema";
import type { Env, OrderRow, Rect, RentalRow, User } from "./types";
import {
  TX_HASH_RE,
  ValidationError,
  amountWithSuffix,
  cellsOf,
  clampInt,
  cleanColor,
  cleanText,
  formatUsdt,
  isInBounds,
  optionalHttpUrl,
  priceBuyMicro,
  priceMicro,
  randomAmountSuffix,
  randomHex,
  timingSafeEqualStr,
  sha256Hex,
  touchesReservedTop,
  tronAddressToHex,
  validateArtPayload,
  resolveTronApiBase,
} from "./util";

const HOUR_MS = 3_600_000;
const ORDER_ID_RE = /^[0-9a-f]{32}$/;
const intersect = (t: string) =>
  `${t}.x < ? AND ${t}.x + ${t}.w > ? AND ${t}.y < ? AND ${t}.y + ${t}.h > ?`;

/* ------------------------------- helpers ---------------------------------- */

let schemaReady: Promise<void> | null = null;

/**
 * Additive migrations for databases created before a column existed.
 * Each statement fails harmlessly when the column is already there.
 */
const MIGRATIONS_SQL: string[] = [
  "ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN extends_rental TEXT",
  // Pending-order anti-abuse limits keyed by client IP (item 2).
  "ALTER TABLE orders ADD COLUMN ip_hash TEXT NOT NULL DEFAULT ''",
  // Pixel art feature: content mode + artwork table (additive, item 2).
  "ALTER TABLE rentals ADD COLUMN content_mode TEXT NOT NULL DEFAULT 'image'",
];

/**
 * Hosted D1 has no migration tool available here, so every isolate creates the
 * schema itself. The statements are IF NOT EXISTS, so this is a no-op once the
 * database exists; failures reset the promise so a later request can retry.
 */
async function ensureSchema(env: Env): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const statement of SCHEMA_SQL) {
        await env.DB.prepare(statement).run();
      }
      for (const statement of MIGRATIONS_SQL) {
        try {
          await env.DB.prepare(statement).run();
        } catch {
          /* duplicate column — already migrated */
        }
      }
    })().catch((err: unknown) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/**
 * Спільний резолвер користувача: спершу Freebuff-сесія (production), потім
 * легасі-сесія з D1 (локальні тести + smoke-харнес). Один запит до SDK на
 * реквест — SDK верифікує access-токен локально, без мережевого дзвінка.
 */
async function resolveUser(env: Env, request: Request): Promise<User | null> {
  if (env.FREEBUFF_CLIENT_ID) {
    try {
      const fbUser = await createSiteAuth(env).authenticate(request);
      if (fbUser.user) {
        return await freebuffUserToUser(env, fbUser.user);
      }
    } catch (err) {
      console.error("freebuff auth check failed", err instanceof Error ? err.message : err);
    }
  }
  // Легасі-paths: тестові сесії зсередини dev-харнесу.
  return currentUser(env, request);
}

async function requireUser(env: Env, request: Request): Promise<User> {
  const user = await resolveUser(env, request);
  if (!user) throw new ValidationError("Спочатку увійдіть в акаунт", 401);
  const banned = await env.DB.prepare("SELECT banned FROM users WHERE sub = ?")
    .bind(user.sub)
    .first<{ banned: number }>();
  if (banned?.banned) throw new ValidationError("Ваш акаунт заблоковано", 403);
  return user;
}

/** Admin gate: the email must appear in the ADMIN_EMAILS secret. */
async function requireAdmin(env: Env, request: Request): Promise<User> {
  const user = await requireUser(env, request);
  const admins = (env.ADMIN_EMAILS ?? "")
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!admins.includes(user.email.toLowerCase())) {
    throw new ValidationError("Доступ заборонено", 403);
  }
  return user;
}

function requireJsonContentType(request: Request): void {
  const type = request.headers.get("content-type");
  if (type && !type.toLowerCase().includes("application/json")) {
    throw new ValidationError("Очікується application/json", 415);
  }
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  requireJsonContentType(request);
  const body = await readJsonBody(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Очікується об'єкт у тілі запиту");
  }
  return body as Record<string, unknown>;
}

function parseRect(body: Record<string, unknown>): Rect {
  const x = clampInt(body.x, 0, GRID_W - 1);
  const y = clampInt(body.y, 0, GRID_H - 1);
  const w = clampInt(body.w, 1, GRID_W);
  const h = clampInt(body.h, 1, GRID_H);
  if (x === null || y === null || w === null || h === null) {
    throw new ValidationError("Некоректні координати виділення");
  }
  const rect = { x, y, w, h };
  if (!isInBounds(rect)) throw new ValidationError("Виділення виходить за межі дошки");
  if (cellsOf(rect) > MAX_CELLS_PER_ORDER) throw new ValidationError("Занадто велика область");
  return rect;
}

/**
 * Parse the deal mode. Buy is encoded as hours = 0: it takes the same order
 * pipeline (hold, payment claim, rental row) but with an infinite expiry.
 */
function parseMode(body: Record<string, unknown>): "rent" | "buy" {
  const mode = typeof body.mode === "string" ? body.mode.trim() : "rent";
  if (mode === "rent" || mode === "buy") return mode;
  throw new ValidationError("Режим має бути 'rent' або 'buy'");
}

async function purge(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM holds WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      "UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
    ).bind(now),
    env.DB.prepare("DELETE FROM rentals WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      `DELETE FROM rental_art WHERE rental_id NOT IN (SELECT id FROM rentals)`,
    ),
  ]);
}

interface Conflict {
  kind: "rental" | "hold";
  createdAt: number;
}

async function findConflict(
  env: Env,
  rect: Rect,
  opts: { now: number; mySub: string; excludeOrderId: string },
): Promise<Conflict | null> {
  const bounds = [rect.x + rect.w, rect.x, rect.y + rect.h, rect.y];
  const rental = await env.DB.prepare(
    `SELECT created_at FROM rentals r
      WHERE r.expires_at > ? AND r.sub != ? AND ${intersect("r")} LIMIT 1`,
  )
    .bind(opts.now, opts.mySub, ...bounds)
    .first<{ created_at: number }>();
  if (rental) return { kind: "rental", createdAt: rental.created_at };

  const hold = await env.DB.prepare(
    `SELECT o.created_at FROM holds h
       JOIN orders o ON o.id = h.order_id
      WHERE h.expires_at > ? AND h.order_id != ? AND ${intersect("h")} LIMIT 1`,
  )
    .bind(opts.now, opts.excludeOrderId, ...bounds)
    .first<{ created_at: number }>();
  if (hold) return { kind: "hold", createdAt: hold.created_at };
  return null;
}

/* ------------------------------ GET /api/grid ------------------------------ */

/**
 * Isolate-level response cache (10 s). Purging expired rows is cron's job now:
 * GET must not write to the database.
 */
let gridCache: { etag: string; body: string; at: number } | null = null;

function invalidateGridCache(): void {
  gridCache = null;
}

async function gridHandler(request: Request, env: Env, url: URL): Promise<Response> {
  const now = Date.now();
  if (!gridCache || now - gridCache.at >= GRID_CACHE_MS) {
    const rows = await env.DB.prepare(
      `SELECT id, x, y, w, h, title, image_url, link_url, color, expires_at, created_at, content_mode
         FROM rentals WHERE expires_at > ? ORDER BY created_at ASC`,
    )
      .bind(now)
      .all<RentalRow>();

    const cells = rows.results.map((r) => ({
      id: r.id,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      title: r.title,
      image: r.image_url,
      link: r.link_url,
      color: r.color,
      until: r.expires_at,
      mode: r.expires_at >= BUY_UNTIL ? "buy" : "rent",
      content: r.content_mode === "art" ? "art" : "image",
    }));

    const body = {
      w: GRID_W,
      h: GRID_H,
      reservedTop: RESERVED_TOP_ROWS,
      priceMicroPerPixelHour: PRICE_MICRO_PER_PIXEL_HOUR,
      priceMicroPerPixelBuy: PRICE_MICRO_PER_PIXEL_BUY,
      reservedTopRows: RESERVED_TOP_ROWS,
      serverNow: now,
      cells,
    };
    const etag = `"${await sha256Hex(JSON.stringify(cells))}"`;
    gridCache = { etag, body: JSON.stringify(body), at: now };
  }

  const headers = new Headers(baseSecurityHeaders(url, true));
  headers.set("ETag", gridCache.etag);
  if (request.headers.get("if-none-match") === gridCache.etag) {
    headers.set("Cache-Control", "no-store");
    return new Response(null, { status: 304, headers });
  }
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "public, max-age=5");
  return new Response(gridCache.body, { status: 200, headers });
}

/* ------------------------------ GET /api/config ---------------------------- */

async function configHandler(env: Env, url: URL): Promise<Response> {
  const banner = await env.DB.prepare("SELECT value FROM settings WHERE key = 'banner_hidden'")
    .first<{ value: string }>();
  let payAddress: string | null = null;
  let payAddressValid = false;
  if (env.PAY_ADDRESS) {
    payAddress = env.PAY_ADDRESS.trim();
    try {
      await tronAddressToHex(payAddress);
      payAddressValid = true;
    } catch {
      payAddressValid = false;
    }
  }
  return json(url, {
    grid: { w: GRID_W, h: GRID_H, reservedTop: RESERVED_TOP_ROWS },
    priceMicroPerPixelHour: PRICE_MICRO_PER_PIXEL_HOUR,
    priceMicroPerPixelBuy: PRICE_MICRO_PER_PIXEL_BUY,
    reservedTopRows: RESERVED_TOP_ROWS,
    minHours: MIN_HOURS,
    maxHours: MAX_HOURS,
    token: "USDT",
    chain: "TRC-20",
    payAddress: payAddressValid ? payAddress : null,
    authEnabled: Boolean(
      env.FREEBUFF_CLIENT_ID || (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    ),
    bannerHidden: banner?.value === "1",
    adminEnabled: Boolean(env.ADMIN_EMAILS?.trim()),
    serverNow: Date.now(),
  });
}

/* --------------------------------- /api/me --------------------------------- */

async function meHandler(env: Env, request: Request, url: URL): Promise<Response> {
  const user = await resolveUser(env, request);
  return json(url, {
    user: user
      ? { name: user.name, picture: user.picture, email: user.email }
      : null,
  });
}

/* ----------------------------- POST /api/orders ---------------------------- */

async function createOrderHandler(request: Request, env: Env, url: URL): Promise<Response> {
  if (!(await rateLimit(env, request, "orders", 90, 60_000))) return rateLimited(url);
  const user = await requireUser(env, request);
  if (!env.PAY_ADDRESS) throw new ValidationError("Прийом оплати ще не налаштовано", 503);

  const body = await readObject(request);
  const rect = parseRect(body);
  const mode = parseMode(body);
  const cells = cellsOf(rect);
  let hours: number | null;
  if (mode === "buy") {
    hours = 0;
  } else {
    hours = clampInt(body.hours, MIN_HOURS, MAX_HOURS);
    if (hours === null) {
      throw new ValidationError(`Термін оренди: від ${MIN_HOURS} до ${MAX_HOURS} годин`);
    }
  }
  const baseMicro = mode === "buy" ? priceBuyMicro(cells) : priceMicro(cells, hours);
  const title = cleanText(body.title, 60);
  const imageUrl = optionalHttpUrl(body.imageUrl, "imageUrl");
  const linkUrl = optionalHttpUrl(body.linkUrl, "linkUrl");
  const color = cleanColor(body.color) || "#3b82f6";

  // Field validation first, only then the reserved-zone rule.
  if (touchesReservedTop(rect)) {
    throw new ValidationError(
      `Верхні ${RESERVED_TOP_ROWS} ряди дошки зарезервовані й недоступні для оренди та викупу`,
      403,
    );
  }

  const now = Date.now();
  await purge(env, now);

  // Own rectangles: an exact match with your own active rental is treated as
  // an extension; any other overlap with your own rental is refused.
  const exactOwn = await env.DB.prepare(
    `SELECT id, expires_at FROM rentals
      WHERE sub = ? AND expires_at > ? AND x = ? AND y = ? AND w = ? AND h = ? LIMIT 1`,
  )
    .bind(user.sub, now, rect.x, rect.y, rect.w, rect.h)
    .first<{ id: string; expires_at: number }>();
  const partialOwn = exactOwn
    ? null
    : await env.DB.prepare(
        `SELECT 1 FROM rentals
          WHERE sub = ? AND expires_at > ? AND ${intersect("rentals")} LIMIT 1`,
      )
        .bind(user.sub, now, rect.x + rect.w, rect.x, rect.y + rect.h, rect.y)
        .first();
  if (partialOwn) {
    throw new ValidationError(
      "Область перетинає вашу чинну оренду. Подовжіть її (той самий прямокутник) або оберіть вільне місце.",
      409,
    );
  }
  const extendsRental = exactOwn?.id ?? null;

  // Extension arithmetic guard (item 6): a BUY order is exactly BUY_UNTIL —
  // extending it further (or renting an already-bought cell) makes no sense.
  if (exactOwn && mode === "buy") {
    throw new ValidationError(
      "Ви вже володієте цією ділянкою назавжди — повторний викуп не потрібен",
      409,
    );
  }
  if (exactOwn && exactOwn.expires_at >= BUY_UNTIL) {
    throw new ValidationError(
      "Ділянку вже викуплено назавжди — продовження не потрібне",
      409,
    );
  }

  // Same-area re-order (item 2): a NEW pending order on the exact rectangle of
  // the same user replaces (cancels) their old pending order — e.g. re-chosen
  // hours. Paid/pending-with-tx orders are never cancelled.
  const sameRect = await env.DB.prepare(
    `SELECT id FROM orders
      WHERE sub = ? AND status = 'pending'
        AND x = ? AND y = ? AND w = ? AND h = ? LIMIT 2`,
  )
    .bind(user.sub, rect.x, rect.y, rect.w, rect.h)
    .all<{ id: string }>();
  if (sameRect.results.length > 0) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE orders SET status = 'cancelled', expires_at = ?
          WHERE sub = ? AND status = 'pending' AND x = ? AND y = ? AND w = ? AND h = ?
            AND tx_hash IS NULL`,
      ).bind(now, user.sub, rect.x, rect.y, rect.w, rect.h),
      env.DB.prepare(
        "DELETE FROM holds WHERE sub = ? AND x = ? AND y = ? AND w = ? AND h = ?",
      ).bind(user.sub, rect.x, rect.y, rect.w, rect.h),
    ]);
  }

  // Pending-order anti-abuse limits (item 2): per user, per IP and the total
  // pending hold area (≤ 25% of the board). Plain IP is hashed for storage.
  const ipHash = await sha256Hex(clientIp(request));
  const userStats = await env.DB.prepare(
    `SELECT COUNT(*) AS c, COALESCE(SUM(w * h), 0) AS s
       FROM orders WHERE sub = ? AND status = 'pending' AND expires_at > ?`,
  )
    .bind(user.sub, now)
    .first<{ c: number; s: number }>();
  const ipStats = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM orders
      WHERE ip_hash = ? AND status = 'pending' AND expires_at > ?`,
  )
    .bind(ipHash, now)
    .first<{ c: number }>();
  const verdict = checkPendingLimits({
    userPending: userStats?.c ?? 0,
    userPendingCells: userStats?.s ?? 0,
    ipPending: ipStats?.c ?? 0,
    requestedCells: cells,
  });
  if (!verdict.ok) throw new ValidationError(verdict.message, verdict.status);

  const expiresAt = now + ORDER_TTL_MS;

  // Amount = base + random surcharge, unique among pending orders (enforced by
  // a partial UNIQUE index; retry with a fresh surcharge on collision). The
  // exact amount becomes the order's on-chain fingerprint — a stolen TXID can
  // only ever pay for the order it was minted for. The order row is created
  // first because the hold below references it by foreign key.
  let orderId = "";
  let amountMicro = 0;
  let placed = false;
  for (let attempt = 0; attempt < 5 && !placed; attempt++) {
    orderId = randomHex(16);
    amountMicro = amountWithSuffix(baseMicro, randomAmountSuffix());
    try {
      await env.DB.prepare(
        `INSERT INTO orders (id, sub, x, y, w, h, hours, cells, amount_micro,
                             title, image_url, link_url, color, status, ip_hash,
                             extends_rental, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
        .bind(
          orderId,
          user.sub,
          rect.x,
          rect.y,
          rect.w,
          rect.h,
          hours,
          cells,
          amountMicro,
          title,
          imageUrl,
          linkUrl,
          color,
          ipHash,
          extendsRental,
          now,
          expiresAt,
        )
        .run();
      placed = true;
    } catch (err) {
      // Amount collision with another pending order: retry with a fresh suffix.
      const message = err instanceof Error ? err.message : String(err);
      if (!/UNIQUE|unique/i.test(message)) throw err;
    }
  }
  if (!placed) {
    throw new ValidationError("Не вдалося сформувати унікальну суму замовлення. Спробуйте ще раз.", 503);
  }

  // Atomic reservation: the hold row is inserted only when neither an active
  // rental nor another active hold covers the rect — a single conditional
  // INSERT, so there is no check-then-insert race. If the area is already
  // taken, the just-created pending order is removed before refusing.
  const hold = await env.DB.prepare(
    `INSERT INTO holds (order_id, sub, x, y, w, h, expires_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM rentals r
         WHERE r.expires_at > ? AND r.id != ? AND ${intersect("r")}
      )
      AND NOT EXISTS (
        SELECT 1 FROM holds h
         WHERE h.expires_at > ? AND h.order_id != ? AND ${intersect("h")}
      )`,
  )
    .bind(
      orderId,
      user.sub,
      rect.x,
      rect.y,
      rect.w,
      rect.h,
      expiresAt,
      now,
      extendsRental ?? "",
      rect.x + rect.w,
      rect.x,
      rect.y + rect.h,
      rect.y,
      now,
      orderId,
      rect.x + rect.w,
      rect.x,
      rect.y + rect.h,
      rect.y,
    )
    .run();
  if (!hold.success || hold.meta.changes === 0) {
    await env.DB.prepare("DELETE FROM orders WHERE id = ? AND status = 'pending'")
      .bind(orderId)
      .run();
    throw new ValidationError("Ця область вже зайнята", 409);
  }

  return json(
    url,
    {
      order: {
        id: orderId,
        rect,
        cells,
        hours,
        mode,
        amountMicro,
        amount: formatUsdt(amountMicro),
        token: "USDT",
        chain: "TRC-20",
        address: env.PAY_ADDRESS,
        expiresAt,
        extensionOf: extendsRental,
      },
    },
    { status: 201 },
  );
}

/* ------------------------------- order status ------------------------------ */

function publicOrder(row: OrderRow, address: string | null) {
  return {
    id: row.id,
    rect: { x: row.x, y: row.y, w: row.w, h: row.h },
    cells: row.cells,
    hours: row.hours,
    mode: row.hours === 0 ? "buy" : "rent",
    amountMicro: row.amount_micro,
    amount: formatUsdt(row.amount_micro),
    status: row.status,
    txHash: row.tx_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    rentalId: row.rental_id,
    address,
  };
}

async function loadOwnOrder(env: Env, sub: string, orderId: string): Promise<OrderRow> {
  if (!ORDER_ID_RE.test(orderId)) throw new ValidationError("Некоректний id замовлення", 404);
  const row = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND sub = ?")
    .bind(orderId, sub)
    .first<OrderRow>();
  if (!row) throw new ValidationError("Замовлення не знайдено", 404);
  return row;
}

/** Actual end of the rented period (orders carry the payment deadline instead). */
async function rentalUntil(env: Env, row: OrderRow): Promise<number | null> {
  if (row.status !== "paid" || !row.rental_id) return null;
  const rental = await env.DB.prepare("SELECT expires_at FROM rentals WHERE id = ? AND sub = ?")
    .bind(row.rental_id, row.sub)
    .first<{ expires_at: number }>();
  return rental ? rental.expires_at : null;
}

async function getOrderHandler(env: Env, request: Request, url: URL, orderId: string) {
  const user = await requireUser(env, request);
  const row = await loadOwnOrder(env, user.sub, orderId);
  const now = Date.now();
  if (row.status === "pending" && row.expires_at <= now) {
    await env.DB.batch([
      env.DB.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(
        orderId,
      ),
      env.DB.prepare("DELETE FROM holds WHERE order_id = ?").bind(orderId),
    ]);
    row.status = "expired";
  }
  return json(url, {
    order: {
      ...publicOrder(row, env.PAY_ADDRESS ?? null),
      rentalUntil: await rentalUntil(env, row),
    },
  });
}

/* -------------------------- POST /api/orders/:id/cancel -------------------- */

/**
 * Owner cancels their own UNPAID pending order (item 2): frees the hold and
 * stops the payment deadline. Orders that already claimed a transaction
 * (or are paid/expired/refunded) can never be cancelled here.
 */
async function cancelOrderHandler(
  request: Request,
  env: Env,
  url: URL,
  orderId: string,
): Promise<Response> {
  if (!(await rateLimit(env, request, "orders-cancel", 30, 60_000))) return rateLimited(url);
  const user = await requireUser(env, request);
  const order = await loadOwnOrder(env, user.sub, orderId);
  if (order.status !== "pending") {
    throw new ValidationError(
      "Скасувати можна лише неоплачене замовлення, що ще чекає на оплату",
      409,
    );
  }
  if (order.tx_hash) {
    throw new ValidationError(
      "До замовлення вже прив'язано транзакцію — скасування неможливе, доведіть завершення перевірки",
      409,
    );
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE orders SET status = 'cancelled', expires_at = ? WHERE id = ? AND status = 'pending'",
    ).bind(now, orderId),
    env.DB.prepare("DELETE FROM holds WHERE order_id = ?").bind(orderId),
  ]);
  invalidateGridCache();
  return json(url, { ok: true, order: { id: orderId, status: "cancelled" } });
}

/* --------------------------- POST /api/orders/:id/pay ---------------------- */

const FAILURE_STATUS: Record<string, number> = {
  not_found: 404,
  not_confirmed: 409,
  wrong_contract: 400,
  wrong_recipient: 400,
  self_payment: 400,
  insufficient: 402,
  wrong_amount: 402,
  reverted: 400,
  network: 502,
};

async function payOrderHandler(
  request: Request,
  env: Env,
  url: URL,
  orderId: string,
): Promise<Response> {
  if (!(await rateLimit(env, request, "pay", 30, 60_000))) return rateLimited(url);
  const user = await requireUser(env, request);
  if (!env.PAY_ADDRESS) throw new ValidationError("Прийом оплати ще не налаштовано", 503);

  const body = await readObject(request);
  const txHash = typeof body.txHash === "string" ? body.txHash.trim().toLowerCase() : "";
  if (!TX_HASH_RE.test(txHash)) {
    throw new ValidationError("Хеш транзакції має бути 64 символи шістнадцяткової системи");
  }

  const order = await loadOwnOrder(env, user.sub, orderId);
  const address = env.PAY_ADDRESS ?? null;
  // Constant-time tx-hash equality (item 6): no early-exit byte compare.
  if (order.tx_hash && !timingSafeEqualStr(order.tx_hash.toLowerCase(), txHash)) {
    throw new ValidationError("До цього замовлення вже прив'язано іншу транзакцію", 409);
  }
  if (order.status === "paid") {
    return json(url, {
      ok: true,
      order: { ...publicOrder(order, address), rentalUntil: await rentalUntil(env, order) },
    });
  }

  // A transaction may only ever pay for one order — checked BEFORE the
  // on-chain verification, so a stolen TXID is rejected deterministically
  // (its amount belongs to the order it was minted for, not to this one).
  const used = await env.DB.prepare("SELECT id FROM orders WHERE tx_hash = ?")
    .bind(txHash)
    .first<{ id: string }>();
  if (used && used.id !== orderId) {
    throw new ValidationError("Цю транзакцію вже використано в іншому замовленні", 409);
  }

  let payHex: string;
  try {
    payHex = await tronAddressToHex(env.PAY_ADDRESS);
  } catch {
    throw new ValidationError("Адреса гаманця для оплати задана некоректно", 503);
  }

  const result = await verifyUsdtTransfer({
    txHash,
    payAddressHex: payHex,
    amountMicro: order.amount_micro,
    ...(env.TRONGRID_API_KEY ? { apiKey: env.TRONGRID_API_KEY } : {}),
    // Test-only override: honors TRON_API_BASE in local dev ONLY (item 3).
    ...(resolveTronApiBase(env) ? { apiBase: resolveTronApiBase(env) } : {}),
  });

  if (!result.ok) {
    const status = FAILURE_STATUS[result.failure] ?? 400;
    return json(url, { ok: false, failure: result.failure, error: result.message }, { status });
  }

  const now = Date.now();

  // 1. Claim the transaction id (UNIQUE constraint guarantees single use).
  let claimed = false;
  try {
    const claim = await env.DB.prepare(
      `UPDATE orders SET tx_hash = ?
        WHERE id = ? AND status IN ('pending', 'expired')
          AND (tx_hash IS NULL OR tx_hash = ?)`,
    )
      .bind(txHash, orderId, txHash)
      .run();
    claimed = claim.success && claim.meta.changes > 0;
  } catch {
    throw new ValidationError("Цю транзакцію щойно використано", 409);
  }
  if (!claimed) {
    const current = await loadOwnOrder(env, user.sub, orderId);
    if (current.status === "paid") {
      return json(url, {
        ok: true,
        order: { ...publicOrder(current, address), rentalUntil: await rentalUntil(env, current) },
      });
    }
    if (!current.tx_hash || current.tx_hash.toLowerCase() !== txHash) {
      throw new ValidationError("Цю транзакцію вже використано або замовлення неактивне", 409);
    }
  }

  // 2. The hold may have expired while the payment was confirming: re-check.
  const rect: Rect = { x: order.x, y: order.y, w: order.w, h: order.h };
  const conflict = await findConflict(env, rect, {
    now,
    mySub: user.sub,
    excludeOrderId: orderId,
  });
  if (conflict) {
    await env.DB.batch([
      env.DB.prepare("UPDATE orders SET status = 'conflict' WHERE id = ?").bind(orderId),
      env.DB.prepare("DELETE FROM holds WHERE order_id = ?").bind(orderId),
    ]);
    return json(
      url,
      {
        ok: false,
        failure: "conflict",
        error:
          "Оплата отримана, але цю область уже зайняли. Напишіть нам — повернемо кошти або запропонуємо інше місце.",
      },
      { status: 409 },
    );
  }

  // 3. Activate. An extension order prolongs the user's own rental in place;
  //    a fresh order creates a rental row whose id is the order id, so a
  //    repeated activation request is a no-op instead of a double grant.
  const rentalId = orderId;
  // Expiry arithmetic (item 6):
  //  - rent: now + paid hours;
  //  - buy: exactly the BUY_UNTIL sentinel — nothing is ever ADDED to it.
  const newExpiry = order.hours === 0 ? BUY_UNTIL : now + order.hours * HOUR_MS;
  const extendBy = order.hours === 0 ? 0 : order.hours * HOUR_MS;
  const statements: D1PreparedStatement[] = [];
  if (order.extends_rental) {
    statements.push(
      env.DB.prepare(
        `UPDATE rentals
            SET expires_at = MIN(?, MAX(expires_at, ?) + ?),
                title = ?, image_url = ?, link_url = ?, color = ?
          WHERE id = ? AND sub = ?`,
      ).bind(
        BUY_UNTIL,
        now,
        extendBy,
        order.title,
        order.image_url,
        order.link_url,
        order.color,
        order.extends_rental,
        order.sub,
      ),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO rentals (id, sub, x, y, w, h, title, image_url, link_url, color, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(
        rentalId,
        order.sub,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        order.title,
        order.image_url,
        order.link_url,
        order.color,
        newExpiry,
        now,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, ?), rental_id = ?
        WHERE id = ? AND tx_hash = ?`,
    ).bind(now, order.extends_rental ?? rentalId, orderId, txHash),
    env.DB.prepare("DELETE FROM holds WHERE order_id = ?").bind(orderId),
  );
  await env.DB.batch(statements);
  invalidateGridCache();

  const updated = await loadOwnOrder(env, user.sub, orderId);
  return json(url, {
    ok: true,
    order: { ...publicOrder(updated, address), rentalUntil: await rentalUntil(env, updated) },
    rentalId,
  });
}

/* ------------------------------ pixel art (item 2) ------------------------- */

const RENTAL_ID_RE = /^[0-9a-f]{32}$/;

/** Insert one audit row; never let logging break the request. */
async function audit(
  env: Env,
  actor: string,
  action: string,
  target: string,
  details = "",
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (actor, action, target, details, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(actor, action, target, details, Date.now())
      .run();
  } catch {
    /* audit is best-effort */
  }
}

/**
 * Load one rental and assert that it belongs to the user and is active.
 * Used by every art endpoint: artwork may only be written while the rental
 * exists on the board — buying forever sets expires_at to BUY_UNTIL, so an
 * owned cell counts as active. Expired rentals must never be editable.
 */
async function loadOwnActiveRental(
  env: Env,
  sub: string,
  rentalId: string,
): Promise<RentalRow> {
  if (!RENTAL_ID_RE.test(rentalId)) throw new ValidationError("Некоректний id ділянки", 404);
  const row = await env.DB.prepare(
    "SELECT * FROM rentals WHERE id = ? AND sub = ?",
  )
    .bind(rentalId, sub)
    .first<RentalRow>();
  if (!row) throw new ValidationError("Ділянку не знайдено або це не ваша", 404);
  if (row.expires_at <= Date.now()) {
    throw new ValidationError("Термін оренди вичерпано — продовжте її, щоб редагувати", 403);
  }
  return row;
}

/** Owner-facing GET: return the stored artwork for one of my rentals. */
async function getOwnArtHandler(
  env: Env,
  request: Request,
  url: URL,
  rentalId: string,
): Promise<Response> {
  const user = await requireUser(env, request);
  const rental = await loadOwnActiveRental(env, user.sub, rentalId);
  const art = await env.DB
    .prepare("SELECT w, h, palette_version, data, version, updated_at FROM rental_art WHERE rental_id = ?")
    .bind(rental.id)
    .first<{ w: number; h: number; palette_version: number; data: string; version: number; updated_at: number }>();
  return json(url, {
    art: art
      ? { w: art.w, h: art.h, paletteVersion: art.palette_version, data: art.data, version: art.version, updatedAt: art.updated_at }
      : null,
    rect: { x: rental.x, y: rental.y, w: rental.w, h: rental.h },
    paletteVersion: ART_PALETTE_VERSION,
  });
}

/**
 * Owner-facing PUT: store artwork for a rental. Checks ownership, active
 * status, rectangle bounds of the payload, palette validity and size, then
 * upserts with a bumped version. Concurrent saves are last-write-wins with
 * the version serving as a simple optimistic marker.
 */
async function putOwnArtHandler(
  request: Request,
  env: Env,
  url: URL,
  rentalId: string,
): Promise<Response> {
  if (!(await rateLimit(env, request, "art-save", 30, 60 * 60_000))) return rateLimited(url);
  const user = await requireUser(env, request);
  const rental = await loadOwnActiveRental(env, user.sub, rentalId);
  requireJsonContentType(request);

  const body = await readObject(request);
  const dataProvided =
    typeof body.data === "string" ||
    (typeof body.cells === "string" && typeof body.w === "number" && typeof body.h === "number");
  if (!dataProvided) {
    throw new ValidationError("Очікується поле 'data' (RLE payload)");
  }

  // The drawing must match the rental's rectangle exactly: one board pixel =
  // one art pixel, no partial covers, no out-of-bounds drawings.
  const w = typeof body.w === "number" ? body.w : rental.w;
  const h = typeof body.h === "number" ? body.h : rental.h;
  if (w !== rental.w || h !== rental.h) {
    throw new ValidationError(
      `Розмір малюнка має бути ${rental.w}×${rental.h} — у межах прямокутника ділянки`,
    );
  }
  const raw = typeof body.data === "string" ? body.data : (body.cells as unknown as string);
  const cells = validateArtPayload(raw, w, h);
  if (cells.length !== rental.w * rental.h) {
    throw new ValidationError("Малюнок не покриває рівно ділянку");
  }

  const now = Date.now();
  const existing = await env.DB
    .prepare("SELECT version FROM rental_art WHERE rental_id = ?")
    .bind(rentalId)
    .first<{ version: number }>();
  const nextVersion = (existing?.version ?? 0) + 1;

  await env.DB.prepare(
    `INSERT INTO rental_art (rental_id, w, h, palette_version, data, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(rental_id) DO UPDATE SET
       w = excluded.w, h = excluded.h, palette_version = excluded.palette_version,
       data = excluded.data, version = excluded.version, updated_at = excluded.updated_at`,
  )
    .bind(rentalId, w, h, ART_PALETTE_VERSION, raw, nextVersion, now)
    .run();

  await audit(env, user.sub, "art_save", rentalId, `${w}x${h} v${nextVersion}`);
  return json(url, { ok: true, version: nextVersion, updatedAt: now });
}

/**
 * Owner-facing DELETE: clear the artwork. Buying forever keeps the drawing;
 * expiry + cron will remove the row for expired rentals, so this is just an
 * immediate manual clear.
 */
async function deleteOwnArtHandler(
  request: Request,
  env: Env,
  url: URL,
  rentalId: string,
): Promise<Response> {
  const user = await requireUser(env, request);
  const rental = await loadOwnActiveRental(env, user.sub, rentalId);
  await env.DB.prepare("DELETE FROM rental_art WHERE rental_id = ?").bind(rental.id).run();
  await audit(env, user.sub, "art_clear", rental.id, "owner");
  return json(url, { ok: true });
}

/**
 * Public batch endpoint: the board fetches artwork metadata + payload for
 * version bump awareness, without inflating /api/grid. ETag is a hash of the
 * whole batch so a plain If-None-Match GET returns 304 when nothing changed.
 */
let artCache: { etag: string; body: string; at: number } | null = null;

async function artBatchHandler(request: Request, env: Env, url: URL): Promise<Response> {
  const now = Date.now();
  if (!artCache || now - artCache.at >= GRID_CACHE_MS) {
    const rows = await env.DB
      .prepare(
        `SELECT rental_id, w, h, palette_version, data, version
           FROM rental_art ra
          WHERE EXISTS (SELECT 1 FROM rentals r WHERE r.id = ra.rental_id AND r.expires_at > ?)`,
      )
      .bind(now)
      .all<{ rental_id: string; w: number; h: number; palette_version: number; data: string; version: number }>();

    const arts = rows.results.map((r) => ({
      id: r.rental_id,
      w: r.w,
      h: r.h,
      data: r.data,
      version: r.version,
      paletteVersion: r.palette_version,
    }));
    artCache = {
      etag: `"${await sha256Hex(JSON.stringify(arts))}"`,
      body: JSON.stringify({ arts, serverNow: now }),
      at: now,
    };
  }

  const headers = new Headers(baseSecurityHeaders(url, true));
  headers.set("ETag", artCache.etag);
  if (request.headers.get("if-none-match") === artCache.etag) {
    headers.set("Cache-Control", "no-store");
    return new Response(null, { status: 304, headers });
  }
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "public, max-age=5");
  return new Response(artCache.body, { status: 200, headers });
}

/**
 * Admin moderation of artwork: clear the drawing entirely. Audit-logged.
 * (raid/зловживання) Re-hiding the rental cell itself stays an admin action
 * on orders/rentals, unchanged.
 */
async function adminClearArtHandler(
  request: Request,
  env: Env,
  url: URL,
  rentalId: string,
): Promise<Response> {
  const admin = await requireAdmin(env, request);
  if (!RENTAL_ID_RE.test(rentalId)) throw new ValidationError("Некоректний id", 404);
  const row = await env.DB
    .prepare("SELECT rental_id FROM rental_art WHERE rental_id = ?")
    .bind(rentalId)
    .first<{ rental_id: string }>();
  if (!row) throw new ValidationError("Малюнок не знайдено", 404);
  await env.DB.prepare("DELETE FROM rental_art WHERE rental_id = ?").bind(rentalId).run();
  await audit(env, admin.email, "art_clear_admin", rentalId);
  return json(url, { ok: true });
}

/**
 * Owner-facing content mode switch: the cell renders either its image URL or
 * its pixel-art drawing — never both at once.
 */
async function putContentModeHandler(
  request: Request,
  env: Env,
  url: URL,
  rentalId: string,
): Promise<Response> {
  const user = await requireUser(env, request);
  const rental = await loadOwnActiveRental(env, user.sub, rentalId);
  const body = await readObject(request);
  const mode = typeof body.mode === "string" ? body.mode.trim() : "";
  if (mode !== "art" && mode !== "image") {
    throw new ValidationError("Режим вмісту має бути 'art' або 'image'");
  }
  if (mode === "art") {
    const hasArt = await env.DB
      .prepare("SELECT 1 FROM rental_art WHERE rental_id = ?")
      .bind(rental.id)
      .first();
    if (!hasArt) {
      throw new ValidationError("Спочатку намалюйте малюнок — збережіть його в редакторі.");
    }
  }
  await env.DB.prepare("UPDATE rentals SET content_mode = ? WHERE id = ?")
    .bind(mode, rental.id)
    .run();
  invalidateGridCache();
  return json(url, { ok: true, mode });
}

/* ------------------------------- cron (auto-pay) --------------------------- */

/**
 * Settles a confirmed on-chain payment for an order. Shared between the manual
 * /pay endpoint and the cron scanner; only ever called after the transaction
 * was verified on-chain with the order's exact amount.
 */
async function settleOrder(env: Env, order: OrderRow, txHash: string): Promise<"ok" | "conflict"> {
  const now = Date.now();
  const rect: Rect = { x: order.x, y: order.y, w: order.w, h: order.h };
  const conflict = await findConflict(env, rect, {
    now,
    mySub: order.sub,
    excludeOrderId: order.id,
  });
  if (conflict) {
    await env.DB.batch([
      env.DB.prepare("UPDATE orders SET status = 'conflict' WHERE id = ?").bind(order.id),
      env.DB.prepare("DELETE FROM holds WHERE order_id = ?").bind(order.id),
    ]);
    return "conflict";
  }

  const rentalId = order.id;
  // Extension arithmetic (item 6): rent extends by the PAID hours from the
  // later of (current expiry, payment moment), capped at BUY_UNTIL. A buy
  // order is the BUY_UNTIL sentinel itself and never gets anything added.
  const newExpiry = order.hours === 0 ? BUY_UNTIL : now + order.hours * HOUR_MS;
  const extendBy = order.hours === 0 ? 0 : order.hours * HOUR_MS;
  const statements: D1PreparedStatement[] = [];
  if (order.extends_rental) {
    statements.push(
      env.DB.prepare(
        `UPDATE rentals
            SET expires_at = MIN(?, MAX(expires_at, ?) + ?),
                title = ?, image_url = ?, link_url = ?, color = ?
          WHERE id = ? AND sub = ?`,
      ).bind(
        BUY_UNTIL,
        now,
        extendBy,
        order.title,
        order.image_url,
        order.link_url,
        order.color,
        order.extends_rental,
        order.sub,
      ),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO rentals (id, sub, x, y, w, h, title, image_url, link_url, color, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(
        rentalId,
        order.sub,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        order.title,
        order.image_url,
        order.link_url,
        order.color,
        newExpiry,
        now,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, ?), rental_id = ?
        WHERE id = ? AND (tx_hash = ? OR tx_hash IS NULL)`,
    ).bind(now, order.extends_rental ?? rentalId, order.id, txHash),
    env.DB.prepare("DELETE FROM holds WHERE order_id = ?").bind(order.id),
  );
  await env.DB.batch(statements);
  invalidateGridCache();
  return "ok";
}

/**
 * Cron (every minute): purge expired rows and rate-limit windows — including
 * artwork of deleted/expired rentals — then scan incoming USDT TRC-20
 * transfers and credit any whose EXACT amount matches a pending order
 * (the amount is the order's anti-theft fingerprint).
 */
async function autoPayScan(env: Env): Promise<{ scanned: number; credited: number }> {
  const now = Date.now();
  await purge(env, now);
  await purgeRateLimits(env, 24 * 60 * 60 * 1000);

  if (!env.PAY_ADDRESS) return { scanned: 0, credited: 0 };
  let payHex: string;
  try {
    payHex = await tronAddressToHex(env.PAY_ADDRESS);
  } catch {
    return { scanned: 0, credited: 0 };
  }

  const transfers = await listIncomingTrc20({
    payAddress: env.PAY_ADDRESS,
    ...(env.TRONGRID_API_KEY ? { apiKey: env.TRONGRID_API_KEY } : {}),
    // Test-only override: honors TRON_API_BASE in local dev ONLY (item 3).
    ...(resolveTronApiBase(env) ? { apiBase: resolveTronApiBase(env) } : {}),
    limit: 50,
  });

  let credited = 0;
  for (const transfer of transfers) {
    const txHash = String(transfer.transaction_id ?? "").toLowerCase();
    const value = Number(transfer.value);
    if (!TX_HASH_RE.test(txHash) || !Number.isSafeInteger(value) || value <= 0) continue;

    // Exact-amount match against pending orders only (UNIQUE index guarantees
    // at most one row per amount).
    const order = await env.DB.prepare(
      `SELECT * FROM orders
        WHERE amount_micro = ? AND status = 'pending' AND expires_at > ?
        LIMIT 1`,
    )
      .bind(value, now)
      .first<OrderRow>();
    if (!order) continue;

    const result = await verifyUsdtTransfer({
      txHash,
      payAddressHex: payHex,
      amountMicro: order.amount_micro,
      ...(env.TRONGRID_API_KEY ? { apiKey: env.TRONGRID_API_KEY } : {}),
      ...(resolveTronApiBase(env) ? { apiBase: resolveTronApiBase(env) } : {}),
    });
    if (!result.ok) continue; // not confirmed yet / not ours — retry next tick

    const used = await env.DB.prepare("SELECT id FROM orders WHERE tx_hash = ?")
      .bind(txHash)
      .first<{ id: string }>();
    if (used) continue;

    // Claim the tx id; skip if another order grabbed it first.
    try {
      const claim = await env.DB.prepare(
        `UPDATE orders SET tx_hash = ? WHERE id = ? AND status = 'pending' AND tx_hash IS NULL`,
      )
        .bind(txHash, order.id)
        .run();
      if (!claim.success || claim.meta.changes === 0) continue;
    } catch {
      continue;
    }

    const settled = await settleOrder(env, { ...order, tx_hash: txHash }, txHash);
    if (settled === "ok") credited += 1;
  }
  return { scanned: transfers.length, credited };
}

/* -------------------------------- /api/mine -------------------------------- */
async function mineHandler(env: Env, request: Request, url: URL): Promise<Response> {
  const user = await requireUser(env, request);
  const now = Date.now();
  const rentals = await env.DB.prepare(
    `SELECT id, x, y, w, h, title, image_url, link_url, color, expires_at, created_at, content_mode
       FROM rentals WHERE sub = ? AND expires_at > ? ORDER BY expires_at DESC`,
  )
    .bind(user.sub, now)
    .all<RentalRow>();
  const orders = await env.DB.prepare(
    `SELECT * FROM orders
      WHERE sub = ? AND status IN ('pending', 'expired')
      ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(user.sub)
    .all<OrderRow>();

  return json(url, {
    serverNow: now,
    rentals: rentals.results.map((r) => ({
      id: r.id,
      rect: { x: r.x, y: r.y, w: r.w, h: r.h },
      cells: cellsOf(r),
      title: r.title,
      until: r.expires_at,
      mode: r.expires_at >= BUY_UNTIL ? "buy" : "rent",
      content: r.content_mode === "art" ? "art" : "image",
    })),
    pending: orders.results.map((o) => publicOrder(o, env.PAY_ADDRESS ?? null)),
  });
}

/* ---------------------------------- admin ---------------------------------- */

async function adminOrdersHandler(env: Env, request: Request, url: URL): Promise<Response> {
  await requireAdmin(env, request);
  const status = url.searchParams.get("status") ?? "conflict";
  const allowed = new Set(["conflict", "pending", "paid", "expired", "refunded"]);
  if (!allowed.has(status)) throw new ValidationError("Невідомий статус");
  const rows = await env.DB.prepare(
    `SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(status)
    .all<OrderRow>();
  return json(url, {
    orders: rows.results.map((o) => ({ ...publicOrder(o, null), sub: o.sub })),
  });
}

/** Refund: mark the order refunded and free its area immediately. */
async function adminRefundHandler(env: Env, request: Request, url: URL, orderId: string) {
  const admin = await requireAdmin(env, request);
  if (!ORDER_ID_RE.test(orderId)) throw new ValidationError("Некоректний id", 404);
  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?")
    .bind(orderId)
    .first<OrderRow>();
  if (!order) throw new ValidationError("Замовлення не знайдено", 404);
  if (order.status === "refunded") return json(url, { ok: true, order: publicOrder(order, null) });
  if (!['paid', 'conflict', 'pending'].includes(order.status)) {
    throw new ValidationError(`Неможливо повернути кошти замовлення у статусі '${order.status}'`);
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").bind(orderId),
    env.DB.prepare("DELETE FROM rental_art WHERE rental_id = ?").bind(order.rental_id ?? orderId),
    env.DB.prepare("DELETE FROM rentals WHERE id = ?").bind(order.rental_id ?? orderId),
    env.DB.prepare("DELETE FROM holds WHERE order_id = ?").bind(orderId),
  ]);
  await audit(env, admin.email, "rental_deleted_refund", order.rental_id ?? orderId);
  invalidateGridCache();
  const updated = await env.DB.prepare("SELECT * FROM orders WHERE id = ?")
    .bind(orderId)
    .first<OrderRow>();
  return json(url, { ok: true, order: publicOrder(updated ?? order, null) });
}

/** Move a paid/conflict rental to a new rect (manual conflict resolution). */
async function adminMoveHandler(
  env: Env,
  request: Request,
  url: URL,
  orderId: string,
): Promise<Response> {
  await requireAdmin(env, request);
  if (!ORDER_ID_RE.test(orderId)) throw new ValidationError("Некоректний id", 404);
  const body = await readObject(request);
  const rect = parseRect(body);
  if (touchesReservedTop(rect)) throw new ValidationError("Зарезервована зона", 403);

  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?")
    .bind(orderId)
    .first<OrderRow>();
  if (!order || !['paid', 'conflict'].includes(order.status)) {
    throw new ValidationError("Замовлення не знайдено або воно не активоване", 404);
  }
  const rentalId = order.rental_id ?? order.id;
  const conflict = await findConflict(env, rect, {
    now: Date.now(),
    mySub: order.sub,
    excludeOrderId: "",
  });
  if (conflict) throw new ValidationError("Нова область зайнята", 409);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE rentals SET x = ?, y = ?, w = ?, h = ? WHERE id = ? AND sub = ?`,
    ).bind(rect.x, rect.y, rect.w, rect.h, rentalId, order.sub),
    env.DB.prepare(`UPDATE orders SET x = ?, y = ?, w = ?, h = ? WHERE id = ?`).bind(
      rect.x,
      rect.y,
      rect.w,
      rect.h,
      orderId,
    ),
    env.DB.prepare(
      `UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, ?), rental_id = ?
        WHERE id = ? AND status = 'conflict'`,
    ).bind(Date.now(), rentalId, orderId),
  ]);
  invalidateGridCache();
  const updated = await env.DB.prepare("SELECT * FROM orders WHERE id = ?")
    .bind(orderId)
    .first<OrderRow>();
  return json(url, { ok: true, order: publicOrder(updated ?? order, null) });
}

/** Ban/unban a user; optionally hide their rentals from the board. */
async function adminBanHandler(
  env: Env,
  request: Request,
  url: URL,
  sub: string,
): Promise<Response> {
  await requireAdmin(env, request);
  if (!sub || sub.length > 128) throw new ValidationError("Некоректний користувач", 404);
  const body = await readObject(request);
  const banned = body.banned !== false;
  const user = await env.DB.prepare("SELECT sub FROM users WHERE sub = ?")
    .bind(sub)
    .first<{ sub: string }>();
  if (!user) throw new ValidationError("Користувача не знайдено", 404);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE users SET banned = ? WHERE sub = ?").bind(banned ? 1 : 0, sub),
    env.DB.prepare("DELETE FROM sessions WHERE sub = ?").bind(sub),
  ];
  if (banned) {
    // Free the board space held by a banned account.
    // Artwork first: the batch runs statements in order, so the art delete
    // must precede the rental delete to see the rows it needs.
    statements.push(
      env.DB.prepare(
        "DELETE FROM rental_art WHERE rental_id IN (SELECT id FROM rentals WHERE sub = ?)",
      ).bind(sub),
    );
    statements.push(env.DB.prepare("DELETE FROM rentals WHERE sub = ?").bind(sub));
    statements.push(env.DB.prepare("DELETE FROM holds WHERE sub = ?").bind(sub));
    statements.push(
      env.DB.prepare("UPDATE orders SET status = 'expired' WHERE sub = ? AND status = 'pending'").bind(
        sub,
      ),
    );
  }
  await env.DB.batch(statements);
  invalidateGridCache();
  return json(url, { ok: true, banned });
}

/** Show/hide the marketing banner (stored in the settings table). */
async function adminBannerHandler(env: Env, request: Request, url: URL): Promise<Response> {
  await requireAdmin(env, request);
  const body = await readObject(request);
  const hidden = body.hidden === true;
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('banner_hidden', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(hidden ? "1" : "0")
    .run();
  return json(url, { ok: true, bannerHidden: hidden });
}

/* --------------------------- image proxy (item 4) ------------------------- */

/**
 * GET /api/img?url=... — the board loads rented banner images through this
 * proxy (validated type, <= 200 KB, rental-owned URL), so browser CSP can be
 * img-src 'self' data: without loading rented hosts directly.
 */
async function imageProxyHandler(request: Request, env: Env, url: URL): Promise<Response> {
  const target = url.searchParams.get("url") ?? "";
  const result = await proxyImage(target, env);
  if (!result.ok) return errorJson(url, 404, "Зображення недоступне");
  return new Response(result.bytes, {
    status: 200,
    headers: {
      ...baseSecurityHeaders(url, true),
      "Content-Type": result.contentType,
      "Cache-Control": "public, max-age=300",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/* ---------------------------- complaints (item 4) -------------------------- */

/**
 * POST /api/reports/:rentalId — logged-in users report a cell:
 * { reason: "scam" | "inappropriate" | "other", note?: string }.
 * Rate limited; one open report per (rental, user) via the UNIQUE index.
 */
const REPORT_REASONS = new Set(["scam", "inappropriate", "broken_link", "other"]);

async function createReportHandler(
  request: Request,
  env: Env,
  url: URL,
  rentalId: string,
): Promise<Response> {
  if (!(await rateLimit(env, request, "reports", 10, 60 * 60_000))) return rateLimited(url);
  const user = await requireUser(env, request);
  if (!RENTAL_ID_RE.test(rentalId)) throw new ValidationError("Некоректний id ділянки", 404);
  const rental = await env.DB
    .prepare("SELECT id, expires_at FROM rentals WHERE id = ?")
    .bind(rentalId)
    .first<{ id: string; expires_at: number }>();
  if (!rental || rental.expires_at <= Date.now()) {
    throw new ValidationError("Ділянку не знайдено на дошці", 404);
  }
  const body = await readObject(request);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!REPORT_REASONS.has(reason)) {
    throw new ValidationError("Причина: scam | inappropriate | broken_link | other");
  }
  const note = cleanText(body.note, 400);
  const now = Date.now();
  try {
    await env.DB
      .prepare(
        `INSERT INTO reports (rental_id, reporter, reason, status, created_at)
         VALUES (?, ?, ?, 'open', ?)`,
      )
      .bind(rentalId, user.sub, note ? `${reason} | ${note}` : reason, now)
      .run();
  } catch {
    throw new ValidationError("Ви вже поскаржилися на цю ділянку — скарга ще відкрита", 409);
  }
  return json(url, { ok: true }, { status: 201 });
}

/* --------------------------- unresolved incoming (item 5) ------------------*/

/**
 * GET /api/admin/incoming — recent incoming USDT TRC-20 transfers classified
 * (item 5): used / pending / unmatched. "unmatched" rows are overpayments,
 * underpayments or stray transfers that no order claims — manual review.
 */
async function adminIncomingHandler(env: Env, request: Request, url: URL): Promise<Response> {
  await requireAdmin(env, request);
  if (!env.PAY_ADDRESS) return json(url, { transfers: [], payAddress: null });
  const payAddress = env.PAY_ADDRESS;
  const [used, pending, transfers] = await Promise.all([
    env.DB
      .prepare("SELECT tx_hash FROM orders WHERE tx_hash IS NOT NULL")
      .all<{ tx_hash: string }>(),
    env.DB
      .prepare(
        `SELECT id, amount_micro FROM orders
          WHERE status = 'pending' AND expires_at > ? AND tx_hash IS NULL`,
      )
      .bind(Date.now())
      .all<{ id: string; amount_micro: number }>(),
    listIncomingTrc20({
      payAddress,
      ...(env.TRONGRID_API_KEY ? { apiKey: env.TRONGRID_API_KEY } : {}),
      ...(resolveTronApiBase(env) ? { apiBase: resolveTronApiBase(env) } : {}),
      limit: 200,
    }),
  ]);
  const usedTxHashes = new Set(used.results.map((r) => r.tx_hash.toLowerCase()));
  const pendingByAmount = new Map<number, string>();
  for (const p of pending.results) pendingByAmount.set(p.amount_micro, p.id);
  const classified = classifyIncoming(transfers, usedTxHashes, pendingByAmount);
  // Unlinked payments first — that is what the admin came for.
  classified.sort((a, b) => {
    const rank = (s: string) => (s === "unmatched" ? 0 : s === "pending" ? 1 : 2);
    return rank(a.status) - rank(b.status);
  });
  return json(url, { transfers: classified, payAddress });
}

/** GET /api/admin/reports — list open complaints (for the moderation page). */
async function adminReportsHandler(env: Env, request: Request, url: URL): Promise<Response> {
  await requireAdmin(env, request);
  const rows = await env.DB
    .prepare(
      `SELECT rp.id, rp.rental_id, rp.reporter, rp.reason, rp.created_at,
              r.x, r.y, r.w, r.h, r.title, r.image_url, r.link_url, r.sub AS owner
         FROM reports rp
         LEFT JOIN rentals r ON r.id = rp.rental_id
        WHERE rp.status = 'open'
        ORDER BY rp.created_at DESC LIMIT 100`,
    )
    .all<Record<string, unknown>>();
  return json(url, { reports: rows.results });
}

/** POST /api/admin/reports/:id/resolve — close a complaint after acting on it. */
async function adminResolveReportHandler(
  env: Env,
  request: Request,
  url: URL,
  reportId: string,
): Promise<Response> {
  const admin = await requireAdmin(env, request);
  if (!/^\d{1,10}$/.test(reportId)) throw new ValidationError("Некоректний id скарги", 404);
  const id = Number(reportId);
  const row = await env.DB.prepare("SELECT id FROM reports WHERE id = ? AND status = 'open'")
    .bind(id)
    .first<{ id: number }>();
  if (!row) throw new ValidationError("Скаргу не знайдено або вже закрито", 404);
  await env.DB
    .prepare("UPDATE reports SET status = 'resolved', resolved_at = ? WHERE id = ?")
    .bind(Date.now(), id)
    .run();
  await audit(env, admin.email, "report_resolved", String(id));
  return json(url, { ok: true });
}

/* --------------------------------- router ---------------------------------- */

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  await ensureSchema(env);

  const originProblem = checkSameOrigin(request, env);
  if (originProblem) {
    return errorJson(url, 403, "Запит відхилено: не той origin (захист від CSRF)");
  }

  if (path === "/api/health") {
    if (method !== "GET") return errorJson(url, 405, "Method not allowed");
    return json(url, { ok: true, serverNow: Date.now() });
  }
  if (path === "/api/config") {
    if (method !== "GET") return errorJson(url, 405, "Method not allowed");
    return configHandler(env, url);
  }
  if (path === "/api/grid") {
    if (method !== "GET") return errorJson(url, 405, "Method not allowed");
    return gridHandler(request, env, url);
  }
  if (path === "/api/me") {
    if (method !== "GET") return errorJson(url, 405, "Method not allowed");
    return meHandler(env, request, url);
  }
  if (path === "/api/mine") {
    if (method !== "GET") return errorJson(url, 405, "Method not allowed");
    return mineHandler(env, request, url);
  }
  if (path === "/api/art") {
    if (method !== "GET") return errorJson(url, 405, "Method not allowed");
    return artBatchHandler(request, env, url);
  }
  if (path === "/api/img") {
    if (method !== "GET") return errorJson(url, 405, "Method not allowed");
    return imageProxyHandler(request, env, url);
  }
  if (path.startsWith("/api/reports/")) {
    if (method !== "POST") return errorJson(url, 405, "Method not allowed");
    return createReportHandler(request, env, url, path.slice("/api/reports/".length));
  }
  if (path === "/api/admin/reports") {
    if (method !== "GET") return errorJson(url, 405, "Method not allowed");
    return adminReportsHandler(env, request, url);
  }
  if (path === "/api/admin/incoming") {
    if (method !== "GET") return errorJson(url, 405, "Method not allowed");
    return adminIncomingHandler(env, request, url);
  }
  if (path.startsWith("/api/admin/reports/")) {
    const rest = path.slice("/api/admin/reports/".length);
    const resolveMatch = /^(\d+)\/resolve$/.exec(rest);
    if (!resolveMatch) return errorJson(url, 404, "Not found");
    return adminResolveReportHandler(env, request, url, resolveMatch[1]!);
  }
  if (path.startsWith("/api/rentals/")) {
    const rest = path.slice("/api/rentals/".length);
    const artMatch = /^([0-9a-f]{32})\/art$/.exec(rest);
    if (artMatch) {
      if (method === "GET") return getOwnArtHandler(env, request, url, artMatch[1]!);
      if (method === "PUT") return putOwnArtHandler(request, env, url, artMatch[1]!);
      if (method === "DELETE") return deleteOwnArtHandler(request, env, url, artMatch[1]!);
      return errorJson(url, 405, "Method not allowed");
    }
    const modeMatch = /^([0-9a-f]{32})\/content-mode$/.exec(rest);
    if (modeMatch) {
      if (method !== "PUT") return errorJson(url, 405, "Method not allowed");
      return putContentModeHandler(request, env, url, modeMatch[1]!);
    }
    return errorJson(url, 404, "Not found");
  }
  if (path.startsWith("/api/admin/art/")) {
    if (method !== "DELETE") return errorJson(url, 405, "Method not allowed");
    return adminClearArtHandler(request, env, url, path.slice("/api/admin/art/".length));
  }
  if (path === "/api/admin/orders") {
    if (method !== "GET") return errorJson(url, 405, "Method not allowed");
    return adminOrdersHandler(env, request, url);
  }
  if (path.startsWith("/api/admin/orders/")) {
    const rest = path.slice("/api/admin/orders/".length);
    const refundMatch = /^([0-9a-f]{32})\/refund$/.exec(rest);
    if (refundMatch) {
      if (method !== "POST") return errorJson(url, 405, "Method not allowed");
      return adminRefundHandler(env, request, url, refundMatch[1]!);
    }
    const moveMatch = /^([0-9a-f]{32})\/move$/.exec(rest);
    if (moveMatch) {
      if (method !== "POST") return errorJson(url, 405, "Method not allowed");
      return adminMoveHandler(env, request, url, moveMatch[1]!);
    }
    return errorJson(url, 404, "Not found");
  }
  if (path.startsWith("/api/admin/users/")) {
    if (method !== "POST") return errorJson(url, 405, "Method not allowed");
    return adminBanHandler(env, request, url, path.slice("/api/admin/users/".length));
  }
  if (path === "/api/admin/banner") {
    if (method !== "POST") return errorJson(url, 405, "Method not allowed");
    return adminBannerHandler(env, request, url);
  }
  // Легасі-шляси Google-входу: перенаправляємо на Sign in with Freebuff.
  if (path === "/api/auth/login") {
    if (method !== "GET") return errorJson(url, 405, "Method not allowed");
    const res = new Response(null, {
      status: 302,
      headers: { Location: "/auth/freebuff/signin?returnTo=/", "Cache-Control": "no-store" },
    });
    return res;
  }
  if (path === "/api/auth/callback") {
    if (method !== "GET") return errorJson(url, 405, "Method not allowed");
    return new Response(null, {
      status: 302,
      headers: { Location: "/auth/freebuff/signin?returnTo=/", "Cache-Control": "no-store" },
    });
  }
  if (path === "/api/auth/logout") {
    if (method !== "POST") return errorJson(url, 405, "Method not allowed");
    if (!(await rateLimit(env, request, "logout", 30, 60_000))) return rateLimited(url);
    return logout(env, request);
  }
  if (path === "/api/orders") {
    if (method !== "POST") return errorJson(url, 405, "Method not allowed");
    return createOrderHandler(request, env, url);
  }
  if (path.startsWith("/api/orders/")) {
    const rest = path.slice("/api/orders/".length);
    const cancelMatch = /^([0-9a-f]{32})\/cancel$/.exec(rest);
    if (cancelMatch) {
      if (method !== "POST") return errorJson(url, 405, "Method not allowed");
      return cancelOrderHandler(request, env, url, cancelMatch[1]!);
    }
    const payMatch = /^([0-9a-f]{32})\/pay$/.exec(rest);
    if (payMatch) {
      if (method !== "POST") return errorJson(url, 405, "Method not allowed");
      return payOrderHandler(request, env, url, payMatch[1]!);
    }
    if (ORDER_ID_RE.test(rest)) {
      if (method !== "GET") return errorJson(url, 405, "Method not allowed");
      return getOrderHandler(env, request, url, rest);
    }
    return errorJson(url, 404, "Not found");
  }
  return errorJson(url, 404, "Not found");
}

async function serveAssets(request: Request, env: Env, url: URL): Promise<Response> {
  const resp = await env.ASSETS.fetch(request);
  const headers = new Headers(resp.headers);
  for (const [key, value] of Object.entries(baseSecurityHeaders(url, false))) {
    if (!headers.has(key)) headers.set(key, value);
  }
  if (!headers.has("Cache-Control")) {
    headers.set(
      "Cache-Control",
      url.pathname === "/" ? "public, max-age=0, must-revalidate" : "public, max-age=300",
    );
  }
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

/**
 * Автентифікація Freebuff: routes /auth/freebuff/* + постачає свіжі
 * Set-Cookie (refresh/rotate) назад у браузер. Викликається ДО /api і
 * статики, щоб сесійні куки завжди оновлювались.
 */
function wrapWithFreebuffAuth(handler: (request: Request, env: Env) => Promise<Response>) {
  return async (request: Request, env: Env): Promise<Response> => {
    if (env.FREEBUFF_CLIENT_ID) {
      try {
        const auth = createSiteAuth(env);
        const authResp = await auth.handle(request);
        if (authResp) return authResp;
        // Не-refreshуємо на статичних файлах (щоб не обтяжувати кожен GET) —
        // SDK сам refreshає на /api/* через authenticate() в resolveUser.
      } catch (err) {
        console.error("freebuff auth route failed", err instanceof Error ? err.message : err);
      }
    }
    return handler(request, env);
  };
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (env.TRON_API_BASE && env.ENVIRONMENT !== "local") {
      console.warn("TRON_API_BASE is ignored outside local (item 3 guard)");
    }
    try {
      await ensureSchema(env);
      const stats = await autoPayScan(env);
      if (stats.credited > 0) console.log(`cron: credited ${stats.credited} payment(s)`);
    } catch (err) {
      console.error("cron failed", err);
    }
  },

  fetch: wrapWithFreebuffAuth(async function (request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return errorJson(url, 405, "Method not allowed");
      }
      return await serveAssets(request, env, url);
    } catch (err) {
      if (err instanceof ValidationError) {
        return errorJson(url, err.status, err.message);
      }
      if (err instanceof SyntaxError) {
        return errorJson(url, 400, "Некоректний JSON у запиті");
      }
      if (err instanceof Error && err.message === "payload too large") {
        return errorJson(url, 413, "Завеликий запит");
      }
      console.error("unhandled error", err);
      return errorJson(url, 500, "Внутрішня помилка сервера");
    }
  }),
} satisfies ExportedHandler<Env>;
