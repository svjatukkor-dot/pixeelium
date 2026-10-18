/**
 * Local test harness helper.
 * Generates: a valid (random) TRON address for the local wallet, login session
 * tokens for two test users, and scripts/mock-env.json used by mock-tron.mjs.
 * Nothing here runs in production.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

function b58encode(bytes) {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = "";
  while (num > 0n) {
    out = B58[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

function b58decode(str) {
  let num = 0n;
  for (const ch of str) {
    const idx = B58.indexOf(ch);
    if (idx < 0) throw new Error("bad char");
    num = num * 58n + BigInt(idx);
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const ch of str) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

function base58check(payload) {
  const h1 = createHash("sha256").update(payload).digest();
  const h2 = createHash("sha256").update(h1).digest();
  return b58encode(Buffer.concat([payload, h2.subarray(0, 4)]));
}

function addressToHex(address) {
  const raw = b58decode(address);
  if (raw.length !== 25) throw new Error("bad length");
  return raw.toString("hex");
}

/** 41-prefixed 42-char hex form used by the worker and the mock. */
function addressPayloadHex(address) {
  return addressToHex(address).slice(0, 42);
}

// Random, checksum-valid TRON address used as the local "wallet".
// Pass an address as argv[2] to keep it stable across regenerations.
const givenAddress = process.argv[2];
// Стабільний гаманець: Python/dev-харнеси читають mock-env.json вже після
// рестарту, тому множинні генерації за один прогін ламають ковдру.
const seedWallet = "TRmfQxDTccjqVa9tKHMpvtSeLq5PfR3GuL";
const payload = givenAddress
  ? b58decode(givenAddress)
  : b58decode(seedWallet);
// Re-derive address bytes (strip chain tag + checksum to get the 20-byte payload)
const walletBytes = payload.subarray(1, 21);
const payAddress = givenAddress ? givenAddress : base58check(Buffer.concat([Buffer.from([0x41]), walletBytes]));
const payHex = addressPayloadHex(payAddress);
const contractHex = addressPayloadHex(USDT_CONTRACT);

// Round-trip self check (also validates a supplied address).
if (addressPayloadHex(payAddress) !== payHex) throw new Error("round trip failed");
if (payHex.length !== 42 || contractHex.length !== 42) throw new Error("bad hex length");
if (b58decode(payAddress).length !== 25) throw new Error("supplied address is not a TRON address");

function makeSession(sub) {
  const token = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  return { sub, token, hash };
}

const alice = makeSession("test-user-alice");
const bob = makeSession("test-user-bob");
const now = Date.now();
const in30d = now + 30 * 24 * 60 * 60 * 1000;

mkdirSync("scripts", { recursive: true });
writeFileSync(
  "scripts/mock-env.json",
  JSON.stringify(
    {
      payAddress,
      payHex,
      contractHex,
      fromHex: `41${"ab".repeat(20)}`,
      otherToHex: `41${"cd".repeat(20)}`,
      valueMicro: 1_000_000,
    },
    null,
    2,
  ) + "\n",
);

const rows = [
  ["test-user-alice", "alice@example.com", "Alice Tester"],
  ["test-user-bob", "bob@example.com", "Bob Tester"],
]
  .map(
    ([sub, email, name]) =>
      `INSERT OR IGNORE INTO users (sub, email, name, picture, created_at, last_login_at) VALUES ('${sub}','${email}','${name}','',${now},${now});`,
  )
  .join("\n");

const sessions = [alice, bob]
  .map(
    (s) =>
      `INSERT OR IGNORE INTO sessions (token_hash, sub, created_at, expires_at, user_agent) VALUES ('${s.hash}','${s.sub}',${now},${in30d},'smoke-test');`,
  )
  .join("\n");

writeFileSync("scripts/test-seed.sql", `${rows}\n${sessions}\n`);
writeFileSync(
  "scripts/test-cookie.txt",
  `alice=${alice.token}\nbob=${bob.token}\n`,
);

writeFileSync(
  ".dev.vars",
  [
    `GOOGLE_CLIENT_ID=1234567890-local.apps.googleusercontent.com`,
    `GOOGLE_CLIENT_SECRET=local-test-secret`,
    `PAY_ADDRESS=${payAddress}`,
    `TRON_API_BASE=http://127.0.0.1:8799`,
    `ADMIN_EMAILS=alice@example.com`,
    // Локальний dev-клієнт Sign in with Freebuff (pubлічні змінні, не секрет).
    `FREEBUFF_CLIENT_ID=a669e727-057f-4dca-bb47-b3e7db188639`,
    `FREEBUFF_ISSUER=https://freebuff.com/oidc`,
    `APP_ORIGIN=http://localhost:8787`,
    ``,
  ].join("\n"),
);

console.log(JSON.stringify({ payAddress, payHex, contractHex }, null, 2));
console.log("wrote scripts/mock-env.json, scripts/test-seed.sql, scripts/test-cookie.txt, .dev.vars");
