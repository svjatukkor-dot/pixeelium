import { describe, expect, it } from "vitest";
import { classifyIncoming } from "../src/incoming";
import type { Trc20Transfer } from "../src/payments";

const TX1 = "a".repeat(64);
const TX2 = "b".repeat(64);
const TX3 = "c".repeat(64);

function t(txHash: string, value: string): Trc20Transfer {
  return {
    transaction_id: txHash,
    from: "41aa",
    to: "41bb",
    value,
    token_info: { address: "41cc" },
    block_timestamp: 1_700,
  };
}

describe("classifyIncoming (адмін-перегляд непривʼязаних переказів)", () => {
  it("marks transfers whose txid is already bound to an order as used", () => {
    const out = classifyIncoming([t(TX1, "120000")], new Set([TX1]), new Map());
    expect(out[0]).toMatchObject({ txHash: TX1, status: "used" });
  });

  it("marks transfers whose exact amount matches a pending order as pending", () => {
    const out = classifyIncoming([t(TX2, "123456")], new Set(), new Map([[123456, "orderX"]]));
    expect(out[0]).toMatchObject({ txHash: TX2, status: "pending", orderId: "orderX" });
  });

  it("classifies overpayments/underpayments as unmatched (manual review)", () => {
    const out = classifyIncoming(
      [t(TX3, "999999")],
      new Set(),
      new Map([[123456, "orderX"]]),
    );
    expect(out[0]).toMatchObject({ txHash: TX3, status: "unmatched" });
  });

  it("handles missing values and unparseable amounts as unmatched", () => {
    const out = classifyIncoming(
      [t("d".repeat(64), "not-a-number"), { transaction_id: "e".repeat(64), from: "41a", to: "41b" }],
      new Set(),
      new Map(),
    );
    expect(out[0]).toMatchObject({ status: "unmatched" });
    expect(out[1]).toMatchObject({ status: "unmatched", value: "" });
  });

  it("matches pending by amount even without exact txid in DB", () => {
    // same amount bound by amount only — pattern for OVERPAID/UNDERPAID rows
    const out = classifyIncoming(
      [t(TX1, "120000"), t(TX2, "120001")],
      new Set(),
      new Map([[120000, "o1"]]),
    );
    expect(out[0]).toMatchObject({ status: "pending", orderId: "o1" });
    expect(out[1]).toMatchObject({ status: "unmatched" });
  });
});
