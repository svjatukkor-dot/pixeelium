import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyUsdtTransfer } from "../src/payments";
import { USDT_TRC20_CONTRACT } from "../src/config";
import { tronAddressToHex } from "../src/util";

const TOPIC_TRANSFER =
  "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const PAY_ADDRESS = "TY8Hn4L1iM3bnEWHw66NHczSLqZ5X7nALR";
const OTHER_ADDRESS = "TSoCaYauManApnCzbTaB75KLzJV1tis1mu";
const TX = "a".repeat(64);
const AMOUNT = 120_000; // 0.12 USDT

const pad = (hex: string) => hex.slice(-40).padStart(64, "0");
const amountHex = (value: number) => value.toString(16).padStart(64, "0");

interface Fake {
  contractHex: string;
  payHex: string;
  otherHex: string;
}

async function setup(): Promise<Fake> {
  const contractHex = await tronAddressToHex(USDT_TRC20_CONTRACT);
  const payHex = await tronAddressToHex(PAY_ADDRESS);
  const otherHex = await tronAddressToHex(OTHER_ADDRESS);
  return { contractHex, payHex, otherHex };
}

type Info = Record<string, unknown>;

function stubFetch(info: unknown, headNumber = 1020): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("getnowblock")) {
        return new Response(JSON.stringify({ block_header: { raw_data: { number: headNumber } } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(info ?? {}), { status: 200 });
    }),
  );
}

/** Records which endpoints were queried — used to prove the solidity node is preferred. */
function stubFetchWithLog(info: unknown, headNumber: number, log: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      log.push(url);
      if (url.includes("getnowblock")) {
        return new Response(JSON.stringify({ block_header: { raw_data: { number: headNumber } } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(info ?? {}), { status: 200 });
    }),
  );
}

function successInfo(
  f: Fake,
  opts: { value: number; to?: string; from?: string; contract?: string; block?: number; result?: string },
): Info {
  return {
    id: TX,
    blockNumber: opts.block ?? 990,
    blockTimeStamp: Date.now() - 60_000,
    receipt: { result: opts.result ?? "SUCCESS" },
    contract_address: opts.contract ?? f.contractHex,
    log: [
      {
        address: opts.contract ?? f.contractHex,
        topics: [TOPIC_TRANSFER, pad(opts.from ?? f.otherHex), pad(opts.to ?? f.payHex)],
        data: amountHex(opts.value),
      },
    ],
  };
}

async function run(f: Fake, info: unknown, head = 1020) {
  stubFetch(info, head);
  return verifyUsdtTransfer({
    txHash: TX,
    payAddressHex: f.payHex,
    amountMicro: AMOUNT,
    apiBase: "http://mock.local",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyUsdtTransfer", () => {
  it("accepts a confirmed USDT transfer of the exact amount", async () => {
    const f = await setup();
    const res = await run(f, successInfo(f, { value: AMOUNT }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(String(AMOUNT));
  });

  it("rejects a transfer of too little", async () => {
    const f = await setup();
    const res = await run(f, successInfo(f, { value: AMOUNT - 1 }));
    expect(res).toMatchObject({ ok: false, failure: "insufficient" });
  });

  it("rejects an overpay — the amount is the order fingerprint", async () => {
    const f = await setup();
    const res = await run(f, successInfo(f, { value: AMOUNT + 1 }));
    expect(res).toMatchObject({ ok: false, failure: "wrong_amount" });
  });

  it("rejects a transfer sent to someone else", async () => {
    const f = await setup();
    const res = await run(f, successInfo(f, { value: AMOUNT, to: f.otherHex }));
    expect(res).toMatchObject({ ok: false, failure: "wrong_recipient" });
  });

  it("rejects a token that is not the official USDT contract", async () => {
    const f = await setup();
    const info = successInfo(f, { value: AMOUNT });
    info.contract_address = f.otherHex;
    (info.log as Info[])[0]!.address = f.otherHex;
    const res = await run(f, info);
    expect(res).toMatchObject({ ok: false, failure: "wrong_contract" });
  });

  it("rejects a reverted transaction", async () => {
    const f = await setup();
    const res = await run(f, successInfo(f, { value: AMOUNT, result: "REVERT" }));
    expect(res).toMatchObject({ ok: false, failure: "reverted" });
  });

  it("rejects a transaction with no Transfer event", async () => {
    const f = await setup();
    const info = successInfo(f, { value: AMOUNT });
    (info.log as Info[])[0]!.topics = ["0000000000000000000000000000000000000000000000000000000000000001"];
    const res = await run(f, info);
    expect(res).toMatchObject({ ok: false, failure: "wrong_contract" });
  });

  it("reports an unknown transaction as not_found", async () => {
    const f = await setup();
    const res = await run(f, {});
    expect(res).toMatchObject({ ok: false, failure: "not_found" });
  });

  it("waits for the configured number of confirmations (19 by default)", async () => {
    const f = await setup();
    const info = successInfo(f, { value: AMOUNT, block: 1000 });

    stubFetch(info, 1000 + 17); // 18 confirmations — too young
    const tooYoung = await verifyUsdtTransfer({
      txHash: TX,
      payAddressHex: f.payHex,
      amountMicro: AMOUNT,
      apiBase: "http://mock.local",
    });
    expect(tooYoung).toMatchObject({ ok: false, failure: "not_confirmed" });

    stubFetch(info, 1000 + 18); // 19 confirmations — accepted
    const confirmed = await verifyUsdtTransfer({
      txHash: TX,
      payAddressHex: f.payHex,
      amountMicro: AMOUNT,
      apiBase: "http://mock.local",
    });
    expect(confirmed.ok).toBe(true);
  });

  it("honors an explicit minConfirmations override", async () => {
    const f = await setup();
    const info = successInfo(f, { value: AMOUNT, block: 1000 });
    stubFetch(info, 1000);
    const tooYoung = await verifyUsdtTransfer({
      txHash: TX,
      payAddressHex: f.payHex,
      amountMicro: AMOUNT,
      apiBase: "http://mock.local",
      minConfirmations: 6,
    });
    expect(tooYoung).toMatchObject({ ok: false, failure: "not_confirmed" });

    stubFetch(info, 1010);
    const confirmed = await verifyUsdtTransfer({
      txHash: TX,
      payAddressHex: f.payHex,
      amountMicro: AMOUNT,
      apiBase: "http://mock.local",
      minConfirmations: 6,
    });
    expect(confirmed.ok).toBe(true);
  });

  it("queries the solidity node first and falls back to the full node", async () => {
    const f = await setup();
    const info = successInfo(f, { value: AMOUNT });
    const log: string[] = [];
    stubFetchWithLog(info, 1000 + 25, log);
    const res = await verifyUsdtTransfer({
      txHash: TX,
      payAddressHex: f.payHex,
      amountMicro: AMOUNT,
      apiBase: "http://mock.local",
    });
    expect(res.ok).toBe(true);
    expect(log[0]).toContain("/walletsolidity/gettransactioninfobyid");
    expect(log.some((u) => u.includes("/walletsolidity/getnowblock"))).toBe(true);
  });

  it("ignores a Transfer log emitted by a different contract", async () => {
    const f = await setup();
    const info = successInfo(f, { value: AMOUNT });
    (info.log as Info[])[0]!.address = f.otherHex; // fake USDT contract
    info.contract_address = ""; // no top-level contract hint either
    const res = await run(f, info);
    expect(res).toMatchObject({ ok: false, failure: "wrong_contract" });
  });

  it("surfaces API outages as network errors", async () => {
    const f = await setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const res = await verifyUsdtTransfer({
      txHash: TX,
      payAddressHex: f.payHex,
      amountMicro: AMOUNT,
      apiBase: "http://mock.local",
    });
    expect(res).toMatchObject({ ok: false, failure: "network" });
  });

  it("rejects a self-payment from our own wallet", async () => {
    const f = await setup();
    const info = successInfo(f, { value: AMOUNT });
    (info.log as Info[])[0]!.topics = [
      TOPIC_TRANSFER,
      pad(f.payHex),
      pad(f.payHex),
    ];
    const res = await run(f, info);
    expect(res).toMatchObject({ ok: false, failure: "self_payment" });
  });
});
