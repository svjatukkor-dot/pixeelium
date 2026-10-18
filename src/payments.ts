import {
  MIN_CONFIRMATIONS,
  TRANSFER_EVENT_TOPIC,
  TRON_API_BASE,
  USDT_TRC20_CONTRACT,
} from "./config";
import { tronAddressToHex } from "./util";

export type VerifyFailure =
  | "not_found"
  | "not_confirmed"
  | "wrong_contract"
  | "wrong_recipient"
  | "self_payment"
  | "insufficient"
  | "wrong_amount"
  | "reverted"
  | "network";

export type VerifyResult =
  | { ok: true; from: string; value: string }
  | { ok: false; failure: VerifyFailure; message: string };

interface TronLog {
  address?: string;
  topics?: string[];
  data?: string;
}

interface TxInfo {
  id?: string;
  fee?: number;
  blockNumber?: number;
  block_number?: number;
  blockTimeStamp?: number;
  block_timestamp?: number;
  receipt?: { result?: string };
  contract_address?: string;
  contractAddress?: string;
  log?: TronLog[];
}

let usdtHexCache: Promise<string> | null = null;

function usdtContractHex(): Promise<string> {
  if (!usdtHexCache) usdtHexCache = tronAddressToHex(USDT_TRC20_CONTRACT);
  return usdtHexCache;
}

/**
 * Normalizes any hex spelling of a TRON address (41-prefixed, with or without
 * the trailing 4-byte base58check checksum) to its 40-hex-char address part.
 */
function addressPart(hex: string): string {
  const v = hex.toLowerCase().replace(/^0x/, "").trim();
  if (v.startsWith("41") && v.length >= 42) return v.slice(2, 42);
  return v.slice(-40);
}

async function tronPost<T>(
  path: string,
  body: unknown,
  apiKey?: string,
  base = TRON_API_BASE,
): Promise<T | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface Trc20Transfer {
  transaction_id?: string;
  from?: string;
  to?: string;
  value?: string;
  token_info?: { address?: string };
  block_timestamp?: number;
}

/**
 * Lists recent TRC-20 transfers TO our wallet (newest first) — used by the
 * cron auto-payment scanner. Returns [] when the API is unavailable.
 */
export async function listIncomingTrc20(opts: {
  payAddress: string;
  apiKey?: string;
  apiBase?: string;
  limit?: number;
}): Promise<Trc20Transfer[]> {
  const base = opts.apiBase ?? TRON_API_BASE;
  const params = new URLSearchParams({
    only_to: opts.payAddress,
    limit: String(Math.min(200, Math.max(1, opts.limit ?? 50))),
    only_confirmed: "false",
  });
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.apiKey) headers["TRON-PRO-API-KEY"] = opts.apiKey;
  try {
    const res = await fetch(`${base}/v1/accounts/${opts.payAddress}/transactions/trc20?${params}`, {
      headers,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Trc20Transfer[] };
    return Array.isArray(body.data) ? body.data : [];
  } catch {
    return [];
  }
}

interface HeadBlock {
  block_header?: { raw_data?: { number?: number } };
}

/**
 * Verifies a TRC-20 USDT transfer on-chain:
 *  - transaction exists, is mined and belongs to the official USDT contract
 *  - Transfer event recipient is our wallet, logged by the USDT contract itself
 *  - transferred amount EQUALS the order amount exactly (anti-theft surcharge)
 *  - the transaction has at least MIN_CONFIRMATIONS confirmations,
 *    confirmed through the solidity node when available
 */
export async function verifyUsdtTransfer(opts: {
  txHash: string;
  payAddressHex: string;
  amountMicro: number;
  apiKey?: string;
  /** Test hook: overrides the TronGrid endpoint (unset in production). */
  apiBase?: string;
  minConfirmations?: number;
}): Promise<VerifyResult> {
  const { txHash, payAddressHex, amountMicro, apiKey, apiBase } = opts;
  const minConfirmations = opts.minConfirmations ?? MIN_CONFIRMATIONS;
  const usdtHex = addressPart(await usdtContractHex());

  // Prefer the solidity node (irreversible state); fall back to the full node.
  const info =
    (await tronPost<TxInfo>("/walletsolidity/gettransactioninfobyid", { value: txHash }, apiKey, apiBase)) ??
    (await tronPost<TxInfo>("/wallet/gettransactioninfobyid", { value: txHash }, apiKey, apiBase));
  if (!info) return { ok: false, failure: "network", message: "Tron API недоступна" };
  if (!info.id && !info.receipt && !(info.log && info.log.length)) {
    return { ok: false, failure: "not_found", message: "Транзакцію ще не знайдено в блокчейні" };
  }
  if (info.id && info.id.toLowerCase() !== txHash.toLowerCase()) {
    return { ok: false, failure: "not_found", message: "Не вдалося знайти транзакцію" };
  }
  if (info.receipt?.result && info.receipt.result !== "SUCCESS") {
    return { ok: false, failure: "reverted", message: "Транзакцію завершено з помилкою" };
  }

  const contractHex = addressPart(info.contract_address ?? info.contractAddress ?? "");
  if (contractHex && contractHex !== usdtHex) {
    return { ok: false, failure: "wrong_contract", message: "Це не транзакція USDT (TRC-20)" };
  }

  // The Transfer log must come from the official USDT contract itself —
  // never accept the first Transfer-shaped log of an arbitrary contract.
  const transfer = (info.log ?? []).find(
    (entry) =>
      (entry.topics?.[0] ?? "").toLowerCase() === TRANSFER_EVENT_TOPIC &&
      addressPart(entry.address ?? "") === usdtHex,
  );
  if (!transfer || !transfer.topics || transfer.topics.length < 3 || !transfer.data) {
    return {
      ok: false,
      failure: "wrong_contract",
      message: "У транзакції немає переказу USDT з офіційного контракту",
    };
  }

  const fromHex = addressPart(transfer.topics[1] ?? "");
  const toHex = addressPart(transfer.topics[2] ?? "");
  const expectedTo = addressPart(payAddressHex);
  if (toHex !== expectedTo) {
    return { ok: false, failure: "wrong_recipient", message: "Гроші надійшли не на наш гаманець" };
  }
  if (fromHex === expectedTo) {
    return { ok: false, failure: "self_payment", message: "Переказ з власного гаманця не зараховується" };
  }

  let value: bigint;
  try {
    value = BigInt(`0x${transfer.data.replace(/^0x/, "")}`);
  } catch {
    return { ok: false, failure: "wrong_contract", message: "Некоректна сума в транзакції" };
  }
  if (value < BigInt(amountMicro)) {
    return {
      ok: false,
      failure: "insufficient",
      message: `Сума менша за потрібну (${Number(value) / 1e6} USDT)`,
    };
  }
  if (value > BigInt(amountMicro)) {
    // Exact match only: the amount is the order's anti-theft fingerprint.
    return {
      ok: false,
      failure: "wrong_amount",
      message: `Сума не збігається із сумою замовлення (${Number(amountMicro) / 1e6} USDT). Перевірте суму — автоматичне зарахування можливе лише точної суми.`,
    };
  }

  const blockNumber = info.blockNumber ?? info.block_number;
  const head =
    (await tronPost<HeadBlock>("/walletsolidity/getnowblock", {}, apiKey, apiBase)) ??
    (await tronPost<HeadBlock>("/wallet/getnowblock", {}, apiKey, apiBase));
  const headNumber = head?.block_header?.raw_data?.number;
  if (typeof blockNumber === "number" && typeof headNumber === "number") {
    if (headNumber - blockNumber + 1 < minConfirmations) {
      return { ok: false, failure: "not_confirmed", message: "Транзакція ще підтверджується" };
    }
  } else {
    // No block numbers available: require the tx to be at least a minute old
    // and still refuse to auto-credit — the caller may retry later.
    const ts = info.blockTimeStamp ?? info.block_timestamp;
    if (typeof ts !== "number" || Date.now() - ts < 60_000) {
      return { ok: false, failure: "not_confirmed", message: "Транзакція ще підтверджується" };
    }
  }

  return { ok: true, from: `41${fromHex}`, value: value.toString() };
}
