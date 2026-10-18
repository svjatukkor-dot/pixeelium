/**
 * Local mock of the TronGrid / wallet endpoints used by the worker.
 * Started only during local testing; never deployed.
 *
 *   node scripts/mock-tron.mjs
 *
 * Endpoints:
 *   POST /wallet/gettransactioninfobyid          (canned + minted txs)
 *   POST /walletsolidity/gettransactioninfobyid  (same)
 *   POST /wallet/getnowblock                     (head = HEAD_BLOCK)
 *   POST /walletsolidity/getnowblock             (same)
 *   GET  /v1/accounts/:addr/transactions/trc20   (minted transfers, for cron)
 *   POST /__mint {txHash?, value, to?}           (register a payment of `value` micro-USDT)
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const cfg = JSON.parse(readFileSync(new URL("./mock-env.json", import.meta.url), "utf8"));
const PORT = Number(process.env.MOCK_PORT || 8799);

const TOPIC_TRANSFER =
  "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const TX_OK = "a".repeat(64);
const TX_LOW = "b".repeat(64);
const TX_WRONG_TO = "c".repeat(64);
const TX_REVERTED = "d".repeat(64);
const TX_OK2 = "e".repeat(64);
const TX_OK3 = "f".repeat(64);
const TX_OK4 = "0".repeat(64);
const TX_OK_BUY = "1".repeat(64);

// Old enough for the default 19-confirmation requirement (head - block + 1).
const TX_BLOCK = 990;
const HEAD_BLOCK = 1015;

const pad = (hex) => hex.slice(-40).padStart(64, "0");
const amountHex = (value) => value.toString(16).padStart(64, "0");

function transferLog({ from, to, value }) {
  return [
    {
      address: cfg.contractHex,
      topics: [TOPIC_TRANSFER, pad(from), pad(to)],
      data: amountHex(value),
    },
  ];
}

function txInfo(id, { value, to = cfg.payHex, result = "SUCCESS" } = {}) {
  return {
    id,
    blockNumber: TX_BLOCK,
    blockTimeStamp: Date.now() - 120_000,
    receipt: { result },
    contract_address: cfg.contractHex,
    log: result === "SUCCESS" ? transferLog({ from: cfg.fromHex, to, value }) : [],
  };
}

const canned = {
  [TX_OK]: txInfo(TX_OK, { value: cfg.valueMicro }),
  [TX_LOW]: txInfo(TX_LOW, { value: 10_000 }),
  [TX_WRONG_TO]: txInfo(TX_WRONG_TO, { value: cfg.valueMicro, to: cfg.otherToHex }),
  [TX_REVERTED]: txInfo(TX_REVERTED, { value: 0, result: "REVERT" }),
  [TX_OK2]: txInfo(TX_OK2, { value: cfg.valueMicro }),
  [TX_OK3]: txInfo(TX_OK3, { value: cfg.valueMicro }),
  [TX_OK4]: txInfo(TX_OK4, { value: cfg.valueMicro }),
  [TX_OK_BUY]: txInfo(TX_OK_BUY, { value: 2_500_000 }),
};

/** Payments registered through POST /__mint — used by the smoke tests. */
const minted = new Map(); // txHash -> { value, to, at }

function json(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");

    // ---- test-only helper: register a payment with an arbitrary amount ----
    if (req.method === "POST" && req.url === "/__mint") {
      let parsed = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        parsed = {};
      }
      const value = Number(parsed.value);
      if (!Number.isSafeInteger(value) || value <= 0) {
        json(res, { error: "value must be a positive integer (micro-USDT)" }, 400);
        return;
      }
      const txHash =
        typeof parsed.txHash === "string" && /^[0-9a-f]{64}$/.test(parsed.txHash)
          ? parsed.txHash
          : randomBytes(32).toString("hex");
      const to = typeof parsed.to === "string" ? parsed.to : cfg.payHex;
      minted.set(txHash, { value, to, at: Date.now() });
      canned[txHash] = txInfo(txHash, { value, to });
      json(res, { txHash, value, to });
      return;
    }

    // ---- tx info (full node + solidity node) ----
    if (
      req.method === "POST" &&
      (req.url === "/wallet/gettransactioninfobyid" ||
        req.url === "/walletsolidity/gettransactioninfobyid")
    ) {
      let parsed = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        parsed = {};
      }
      const info = canned[parsed.value] ?? {};
      json(res, info);
      return;
    }

    // ---- head block (full node + solidity node) ----
    if (
      req.method === "POST" &&
      (req.url === "/wallet/getnowblock" || req.url === "/walletsolidity/getnowblock")
    ) {
      json(res, { block_header: { raw_data: { number: HEAD_BLOCK } } });
      return;
    }

    // ---- TRC-20 transfer list (auto-payment scanner) ----
    if (req.method === "GET" && /^\/v1\/accounts\/[^/]+\/transactions\/trc20/.test(req.url)) {
      const list = [...minted.entries()]
        .sort((a, b) => b[1].at - a[1].at)
        .map(([transaction_id, m]) => ({
          transaction_id,
          from: cfg.fromHex,
          to: m.to,
          value: String(m.value),
          type: "Transfer",
          token_info: { address: cfg.contractHex },
          block_timestamp: m.at,
        }));
      json(res, { success: true, data: list, meta: { links: undefined } });
      return;
    }

    json(res, { error: "not found" }, 404);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock tron api on http://127.0.0.1:${PORT}`);
  console.log(`pay hex:  ${cfg.payHex}`);
  console.log(`head block: ${HEAD_BLOCK} (txs at ${TX_BLOCK} -> ${HEAD_BLOCK - TX_BLOCK + 1} confirmations)`);
  console.log(`txs: ok=${TX_OK} low=${TX_LOW} wrong_to=${TX_WRONG_TO} reverted=${TX_REVERTED} ok2=${TX_OK2} ok3=${TX_OK3} ok4=${TX_OK4} buy=${TX_OK_BUY}`);
});
