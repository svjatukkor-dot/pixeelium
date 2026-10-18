/**
 * Дошка на ~1 млрд пікселів: 40 000 × 25 000 = 1e9.
 * Координати до 5 цифр — безпечно лізуть у SQLite INTEGER.
 */
export const GRID_W = 40_000;
export const GRID_H = 25_000;

/** 0.05 USDT per 1 pixel per 1 hour, in micro-USDT (1e6) */
export const PRICE_MICRO_PER_PIXEL_HOUR = 50_000;

/** 2.50 USDT to buy a pixel forever, in micro-USDT (1e6) */
export const PRICE_MICRO_PER_PIXEL_BUY = 2_500_000;

/** Top rows of the board are reserved (logo/brand zone); not rentable or buyable. */
export const RESERVED_TOP_ROWS = 10;

/**
 * Sentinel expiry for purchased cells. Node core Date max (275760-10) and
 * a safe small SQLite integer far beyond any real lifetime.
 */
export const BUY_UNTIL = 8_640_000_000_000_000;

export const MIN_HOURS = 1;
export const MAX_HOURS = 720; // 30 days
export const MAX_CELLS_PER_ORDER = 10_000;

export const ORDER_TTL_MS = 30 * 60 * 1000;

/**
 * Anti-theft: every order amount gets a random surcharge of 1..9999 micro-USDT,
 * so the exact amount on chain uniquely identifies the order and a stolen TXID
 * cannot activate somebody else's order.
 */
export const AMOUNT_SUFFIX_MAX = 9999;

/** Blocks a TRC-20 transfer must be buried in before we accept it. */
export const MIN_CONFIRMATIONS = 19;

/** How long a /api/grid payload may be served from the isolate cache. */
export const GRID_CACHE_MS = 10_000;

/** Cron cadence of the auto-payment scanner (TronGrid trc20 poll). */
export const AUTO_PAY_CRON = "* * * * *";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const OAUTH_TTL_MS = 10 * 60 * 1000;

/** Official Tether TRC-20 contract on Tron */
export const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
export const TRON_API_BASE = "https://api.trongrid.io";

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_EVENT_TOPIC =
  "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export const SESSION_COOKIE = "px_session";
export const OAUTH_COOKIE = "px_oauth";
