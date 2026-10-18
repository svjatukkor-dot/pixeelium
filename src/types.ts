export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT?: string;
  APP_ORIGIN?: string;
  /** Public Freebuff OIDC client ID — injected by Sites deploy (not a secret). */
  FREEBUFF_CLIENT_ID?: string;
  /** Freebuff OIDC issuer, injected by Sites deploy. */
  FREEBUFF_ISSUER?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PAY_ADDRESS?: string;
  TRONGRID_API_KEY?: string;
  /** Comma/space separated admin emails (secret, never logged). */
  ADMIN_EMAILS?: string;
  /** Test hook: local mock of the TronGrid API. Never set in production. */
  TRON_API_BASE?: string;
}

export interface User {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RentalRow {
  id: string;
  sub: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  image_url: string;
  link_url: string;
  color: string;
  expires_at: number;
  created_at: number;
  /** 'image' (default) or 'art' — which content the cell renders. */
  content_mode: string;
}

export interface OrderRow {
  id: string;
  sub: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hours: number;
  cells: number;
  amount_micro: number;
  title: string;
  image_url: string;
  link_url: string;
  color: string;
  status: string;
  tx_hash: string | null;
  rental_id: string | null;
  /** When set, activation prolongs this existing rental instead of inserting a new one. */
  extends_rental: string | null;
  created_at: number;
  expires_at: number;
  paid_at: number | null;
}
