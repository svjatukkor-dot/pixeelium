/**
 * Idempotent schema, executed lazily by the Worker on first use.
 * There is no SQL migration tool on the hosted D1 instance, so the schema has
 * to be creatable from server-side code. Safe to run on every isolate start.
 */
export const SCHEMA_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     sub           TEXT PRIMARY KEY,
     email         TEXT NOT NULL,
     name          TEXT NOT NULL DEFAULT '',
     picture       TEXT NOT NULL DEFAULT '',
     created_at    INTEGER NOT NULL,
     last_login_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash  TEXT PRIMARY KEY,
     sub         TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
     created_at  INTEGER NOT NULL,
     expires_at  INTEGER NOT NULL,
     user_agent  TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_sub ON sessions(sub)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,

  `CREATE TABLE IF NOT EXISTS orders (
     id            TEXT PRIMARY KEY,
     sub           TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
     x             INTEGER NOT NULL,
     y             INTEGER NOT NULL,
     w             INTEGER NOT NULL,
     h             INTEGER NOT NULL,
     hours         INTEGER NOT NULL,
     cells         INTEGER NOT NULL,
     amount_micro  INTEGER NOT NULL,
     title         TEXT NOT NULL DEFAULT '',
     image_url     TEXT NOT NULL DEFAULT '',
     link_url      TEXT NOT NULL DEFAULT '',     color        TEXT NOT NULL DEFAULT '#3b82f6',
     status        TEXT NOT NULL DEFAULT 'pending',
     /** sha256 of the client IP that created the order (item 2 per-IP limit). */
     ip_hash       TEXT NOT NULL DEFAULT '',
     tx_hash       TEXT UNIQUE,
     rental_id     TEXT,
     created_at    INTEGER NOT NULL,
     expires_at    INTEGER NOT NULL,
     paid_at       INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_sub ON orders(sub)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_expires ON orders(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_ip_hash ON orders(ip_hash, status)`,

  `CREATE TABLE IF NOT EXISTS rentals (
     id          TEXT PRIMARY KEY,
     sub         TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
     x           INTEGER NOT NULL,
     y           INTEGER NOT NULL,
     w           INTEGER NOT NULL,
     h           INTEGER NOT NULL,
     title       TEXT NOT NULL DEFAULT '',
     image_url   TEXT NOT NULL DEFAULT '',
     link_url    TEXT NOT NULL DEFAULT '',
     color       TEXT NOT NULL DEFAULT '#3b82f6',
     expires_at  INTEGER NOT NULL,
     created_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rentals_sub ON rentals(sub)`,
  `CREATE INDEX IF NOT EXISTS idx_rentals_expires ON rentals(expires_at)`,

  `CREATE TABLE IF NOT EXISTS holds (
     order_id   TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
     sub        TEXT NOT NULL,
     x          INTEGER NOT NULL,
     y          INTEGER NOT NULL,
     w          INTEGER NOT NULL,
     h          INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_holds_expires ON holds(expires_at)`,

  // D1-backed rate limiting: survives isolate restarts and deploys.
  `CREATE TABLE IF NOT EXISTS rate_limits (
     key          TEXT PRIMARY KEY,
     window_start INTEGER NOT NULL,
     count        INTEGER NOT NULL
   )`,

  // Small key/value store (e.g. banner_hidden).
  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  // A payment amount may only ever belong to one pending order at a time.
  // The random surcharge in the amount makes collisions unlikely; the index
  // makes them impossible, and the order endpoint retries on conflict.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pending_amount
     ON orders(amount_micro) WHERE status = 'pending'`,

  // Pixel artwork (item 2): one row per rental, additive.
  // data = base64url(RLE(palette indexes)), version bumps on every save for
  // optimistic concurrency; palette_version ties data to the board palette.
  `CREATE TABLE IF NOT EXISTS rental_art (
     rental_id       TEXT PRIMARY KEY,
     w               INTEGER NOT NULL,
     h               INTEGER NOT NULL,
     palette_version INTEGER NOT NULL,
     data            TEXT NOT NULL,
     version         INTEGER NOT NULL,
     updated_at      INTEGER NOT NULL
   )`,

  // Append-only audit trail for moderation actions (art cleared/hidden/banned).
  `CREATE TABLE IF NOT EXISTS audit_log (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     actor      TEXT NOT NULL,
     action     TEXT NOT NULL,
     target     TEXT NOT NULL,
     details    TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
  )`,

  // Moderation: user complaints about a cell (item 4). One report per user
  // and rental; admins list open reports and close them after acting.
  `CREATE TABLE IF NOT EXISTS reports (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     rental_id   TEXT NOT NULL,
     reporter    TEXT NOT NULL,
     reason      TEXT NOT NULL DEFAULT '',
     status      TEXT NOT NULL DEFAULT 'open',
     created_at  INTEGER NOT NULL,
     resolved_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_open_unique
     ON reports(rental_id, reporter) WHERE status = 'open'`,
];
