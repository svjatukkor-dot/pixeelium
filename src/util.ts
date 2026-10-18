import {
  AMOUNT_SUFFIX_MAX,
  BUY_UNTIL,
  GRID_H,
  GRID_W,
  PRICE_MICRO_PER_PIXEL_BUY,
  PRICE_MICRO_PER_PIXEL_HOUR,
  RESERVED_TOP_ROWS,
} from "./config";
import type { Rect } from "./types";

/* ---------------------------------- grid ---------------------------------- */

/** True when the rectangle dips into the reserved top zone of the board. */
export function touchesReservedTop(r: Rect): boolean {
  return r.y < RESERVED_TOP_ROWS;
}

export function isInBounds(r: Rect): boolean {
  return (
    Number.isInteger(r.x) &&
    Number.isInteger(r.y) &&
    Number.isInteger(r.w) &&
    Number.isInteger(r.h) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.w >= 1 &&
    r.h >= 1 &&
    r.x + r.w <= GRID_W &&
    r.y + r.h <= GRID_H
  );
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function cellsOf(r: Rect): number {
  return r.w * r.h;
}

/** Price in micro-USDT (1e6 = 1 USDT). Integer math only, no floats. */
export function priceMicro(cells: number, hours: number): number {
  if (!Number.isSafeInteger(cells) || !Number.isSafeInteger(hours)) {
    throw new Error("bad numbers");
  }
  const total = cells * hours * PRICE_MICRO_PER_PIXEL_HOUR;
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error("bad price");
  return total;
}

/** One-time purchase price for cells bought forever. */
export function priceBuyMicro(cells: number): number {
  if (!Number.isSafeInteger(cells) || cells <= 0) throw new Error("bad numbers");
  const total = cells * PRICE_MICRO_PER_PIXEL_BUY;
  if (!Number.isSafeInteger(total)) throw new Error("bad price");
  return total;
}

/**
 * Anti-theft surcharge: every order pays base + a random 1..9999 micro-USDT
 * suffix, so the exact on-chain amount identifies one specific order and a
 * stolen TXID cannot activate anybody else's order.
 */
export function amountWithSuffix(baseMicro: number, suffix: number): number {
  if (!Number.isSafeInteger(baseMicro) || baseMicro <= 0) throw new Error("bad base");
  if (!Number.isInteger(suffix) || suffix < 1 || suffix > AMOUNT_SUFFIX_MAX) {
    throw new Error("bad suffix");
  }
  const total = baseMicro + suffix;
  if (!Number.isSafeInteger(total)) throw new Error("bad price");
  return total;
}

/** Cryptographically random surcharge in 1..AMOUNT_SUFFIX_MAX. */
export function randomAmountSuffix(): number {
  const buf = crypto.getRandomValues(new Uint8Array(2));
  const n = ((buf[0]! << 8) | buf[1]!) % AMOUNT_SUFFIX_MAX; // 0..9998
  return n + 1; // 1..9999
}

/** Purchases never expire; used as the rentals.expires_at sentinel. */
export const BUY_EXPIRES = BUY_UNTIL;

export function formatUsdt(micro: number): string {
  const whole = Math.floor(micro / 1_000_000);
  const frac = Math.abs(micro % 1_000_000)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/* --------------------------------- random --------------------------------- */

const HEX = "0123456789abcdef";

export function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let out = "";
  for (const b of buf) out += HEX.charAt(b >> 4) + HEX.charAt(b & 15);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX.charAt(b >> 4) + HEX.charAt(b & 15);
  return out;
}

export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  return new Uint8Array(buf);
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await sha256Bytes(new TextEncoder().encode(text)));
}

/* -------------------------------- base58 ---------------------------------- */

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(input: string): Uint8Array {
  let num = 0n;
  for (const ch of input) {
    const idx = B58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base58 character");
    num = num * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const ch of input) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

/**
 * Accepts a TRON base58 address (T...) or a 41-prefixed hex address and
 * returns the lowercase hex form (41 + 40 hex chars). Validates the
 * base58check checksum so a mistyped wallet address cannot be configured.
 */
export async function tronAddressToHex(input: string): Promise<string> {
  const value = String(input ?? "").trim();
  if (/^41[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  if (!/^[1-9A-HJ-NP-Za-km-z]{33,34}$/.test(value)) {
    throw new Error("not a TRON address");
  }
  const raw = base58Decode(value);
  if (raw.length !== 25) throw new Error("not a TRON address");
  const payload = raw.slice(0, 21);
  const checksum = raw.slice(21);
  if (payload[0] !== 0x41) throw new Error("not a TRON address");
  const first = await sha256Bytes(payload);
  const second = await sha256Bytes(first);
  for (let i = 0; i < 4; i++) {
    if (second[i] !== checksum[i]) throw new Error("address checksum mismatch");
  }
  return toHex(payload);
}

export function sameTronAddress(a: string, b: string): boolean {
  return a.length === 42 && b.length === 42 && a === b;
}

/* --------------------------------- strings -------------------------------- */

export function clampInt(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < min || i > max) return null;
  return i;
}

/** Keep printable text, drop control characters, cap the length. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function optionalHttpUrl(value: unknown, field: string): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 2048) {
    throw new ValidationError(`${field}: недопустиме значення`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError(`${field}: некоректне посилання`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError(`${field}: дозволені лише http/https`);
  }
  if (url.username || url.password) {
    throw new ValidationError(`${field}: некоректне посилання`);
  }
  if (url.hash.length > 2048) throw new ValidationError(`${field}: занадто довге посилання`);
  return url.toString();
}

export function cleanColor(value: unknown): string {
  const v = typeof value === "string" ? value.trim() : "";
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : "";
}

export const TX_HASH_RE = /^[0-9a-f]{64}$/i;

/**
 * Constant-time comparison of two strings (XOR-accumulate, no early exit).
 * Length difference still returns false, but the byte content never leaks
 * through timing — used for OAuth state and tx-hash equality checks.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------- env helpers ------------------------------- */

/**
 * The TronGrid endpoint override (TRON_API_BASE) is a TEST hook for the local
 * mock-tron server. It is honored only when ENVIRONMENT === "local"; in any
 * production deploy (ENVIRONMENT unset or any other value) it is ignored so a
 * leaked/unset dev var can never redirect payment verification.
 */
export function resolveTronApiBase(env: { ENVIRONMENT?: string; TRON_API_BASE?: string }):
  | string
  | undefined {
  const base = env.TRON_API_BASE?.trim();
  if (!base || env.ENVIRONMENT !== "local") return undefined;
  return base;
}
/* ----------------------- pixel-art RLE codec (item 2) --------------------- */

/** transparent + 32 palette colors -> 33 possible cell values (0..32) */
export const ART_PALETTE_SIZE = 33;
export const TRANSPARENT_INDEX = 0;
/** Max length of the RLE payload (base64) accepted and produced. */
export const ART_PAYLOAD_MAX = 16 * 1024;

/**
 * Escape-based Run-Length encoding over palette indexes.
 *   [idx, n]         -> n repeats of idx, capped at 255
 *   [0, high, n]     -> n repeats of a palette value >= 200 (escape)
 * Palette values 200..255 are never stored directly: see encodeArtRle for
 * the format contract shared with the board renderer.
 */
export function encodeArtRle(indexes: Uint8Array): string {
  const out: number[] = [];
  let i = 0;
  while (i < indexes.length) {
    const v = indexes[i]!;
    if (v >= ART_PALETTE_SIZE) throw new Error("art palette index out of range");
    let run = 1;
    while (i + run < indexes.length && indexes[i + run] === v && run < 255) run++;
    out.push(v, run);
    i += run;
  }
  return b64urlEncode(new Uint8Array(out));
}

/** Inverse of encodeArtRle. Must decode to exactly expectedLen cells. */
export function decodeArtRle(encoded: string, expectedLen: number): Uint8Array {
  const bytes = b64urlDecode(encoded);
  const out = new Uint8Array(expectedLen);
  let pos = 0;
  let i = 0;
  while (i < bytes.length) {
    const v = bytes[i]!;
    const run = bytes[i + 1]!;
    if (v >= ART_PALETTE_SIZE) throw new Error("art cell value out of range");
    if (run < 1 || pos + run > expectedLen) throw new Error("art run past end");
    out.fill(v, pos, pos + run);
    pos += run;
    i += 2;
  }
  if (pos !== expectedLen) throw new Error("art payload length mismatch");
  return out;
}

/**
 * Server-side payload validation for PUT /api/rentals/:id/art.
 * Throws ValidationError when anything is off: length, palette bounds,
 * RLE structure or encoded size.
 */
export function validateArtPayload(
  data: unknown,
  w: number,
  h: number,
): Uint8Array {
  if (typeof data !== "string") throw new ValidationError("art.data: очікується рядок");
  if (data.length === 0) throw new ValidationError("art.data: порожній payload");
  if (data.length > ART_PAYLOAD_MAX) {
    throw new ValidationError("art.data: перевищено ліміт 16 КБ", 413);
  }
  const expectedLen = w * h;
  const cells = decodeArtRle(data, expectedLen);
  for (const c of cells) {
    if (c !== TRANSPARENT_INDEX && c >= ART_PALETTE_SIZE) {
      throw new ValidationError("art.data: колір поза палітрою");
    }
  }
  return cells;
}

export class ValidationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
  }
}

/* -------------------------------- base64url -------------------------------- */

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeJsonSegment<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(segment))) as T;
}
