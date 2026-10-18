import type { Trc20Transfer } from "./payments";

/**
 * Admin view of incoming USDT TRC-20 transfers (item 5): each transfer is
 * classified so unlinked payments (overpayments, underpayments, stray
 * transfers) can be resolved manually.
 *
 *  - "used":   the txid is already bound to some order in the database.
 *  - "pending": the amount exactly matches a pending order — the cron
 *              scanner will credit it automatically; nothing to do by hand.
 *  - "unmatched": no order corresponds to this transfer (no pending order
 *              with the exact amount AND no bound txid) — this is the list
 *              the admin needs to sort out manually.
 */

export type TransferStatus = "used" | "pending" | "unmatched";

export interface ClassifiedTransfer {
  txHash: string;
  from: string;
  to: string;
  /** Raw micro-USDT value (string per TronGrid; empty when unparseable). */
  value: string;
  blockTimestamp: number | null;
  status: TransferStatus;
  /** Order id when status is "used" or "pending". */
  orderId?: string;
}

export function classifyIncoming(
  transfers: Trc20Transfer[],
  usedTxHashes: Set<string>,
  pendingByAmount: Map<number, string>,
): ClassifiedTransfer[] {
  return transfers.map((t) => {
    const txHash = String(t.transaction_id ?? "").toLowerCase();
    const from = String(t.from ?? "");
    const to = String(t.to ?? "");
    const value = t.value === undefined || t.value === null ? "" : String(t.value);
    const blockTimestamp =
      typeof t.block_timestamp === "number" ? t.block_timestamp : null;

    if (usedTxHashes.has(txHash)) {
      return { txHash, from, to, value, blockTimestamp, status: "used" as const };
    }
    const amount = Number(value);
    if (Number.isSafeInteger(amount) && amount > 0) {
      const orderId = pendingByAmount.get(amount);
      if (orderId) {
        return {
          txHash,
          from,
          to,
          value,
          blockTimestamp,
          status: "pending" as const,
          orderId,
        };
      }
    }
    return { txHash, from, to, value, blockTimestamp, status: "unmatched" as const };
  });
}
