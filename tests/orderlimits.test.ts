import { describe, expect, it } from "vitest";
import {
  MAX_PENDING_AREA_FRACTION,
  MAX_PENDING_PER_IP,
  MAX_PENDING_PER_USER,
  checkPendingLimits,
} from "../src/orderlimits";

import { GRID_H, GRID_W } from "../src/config";

const BOARD = GRID_W * GRID_H;

describe("checkPendingLimits", () => {
  it("allows up to 3 pending orders for a user", () => {
    for (let n = 0; n < MAX_PENDING_PER_USER; n++) {
      expect(
        checkPendingLimits({ userPending: n, userPendingCells: 0, ipPending: 0, requestedCells: 1 }),
      ).toEqual({ ok: true });
    }
  });

  it("blocks the 4th pending order of the same user with 429", () => {
    const v = checkPendingLimits({
      userPending: MAX_PENDING_PER_USER,
      userPendingCells: 0,
      ipPending: MAX_PENDING_PER_USER,
      requestedCells: 1,
    });
    expect(v).toMatchObject({ ok: false, code: "user", status: 429 });
  });

  it("blocks the 6th pending order from the same IP with 429 even for a new user", () => {
    const v = checkPendingLimits({
      userPending: 0,
      userPendingCells: 0,
      ipPending: MAX_PENDING_PER_IP,
      requestedCells: 1,
    });
    expect(v).toMatchObject({ ok: false, code: "ip", status: 429 });
  });

  it("allows 5 orders per IP but not more", () => {
    expect(
      checkPendingLimits({
        userPending: 1,
        userPendingCells: 1,
        ipPending: MAX_PENDING_PER_IP - 1,
        requestedCells: 1,
      }),
    ).toEqual({ ok: true });
  });

  it("blocks when the user's pending holds would exceed 25% of the board", () => {
    const limit = Math.floor(BOARD * MAX_PENDING_AREA_FRACTION);
    const ok = checkPendingLimits({
      userPending: 2,
      userPendingCells: limit - 1,
      ipPending: 2,
      requestedCells: 1,
    });
    expect(ok).toEqual({ ok: true }); // рівно в межах ліміту

    const blocked = checkPendingLimits({
      userPending: 2,
      userPendingCells: limit - 100,
      ipPending: 2,
      requestedCells: 101,
    });
    expect(blocked).toMatchObject({ ok: false, code: "area", status: 400 });
    expect(blocked.ok === false && blocked.message).toContain(String(limit));
    void limit;
  });

  it("counts the requested order itself in the 25% budget", () => {
    const exact = checkPendingLimits({
      userPending: 1,
      userPendingCells: 0,
      ipPending: 1,
      requestedCells: Math.floor(BOARD * MAX_PENDING_AREA_FRACTION), // рівно ліміт → дозволено
    });
    expect(exact).toEqual({ ok: true });

    const oneOver = checkPendingLimits({
      userPending: 1,
      userPendingCells: 0,
      ipPending: 1,
      requestedCells: Math.floor(BOARD * MAX_PENDING_AREA_FRACTION) + 1,
    });
    expect(oneOver).toMatchObject({ ok: false, code: "area" });
  });

  it("area check runs before the IP check only after user check passes", () => {
    // user limit has priority (first in code)
    const v = checkPendingLimits({
      userPending: MAX_PENDING_PER_USER,
      userPendingCells: BOARD,
      ipPending: MAX_PENDING_PER_IP,
      requestedCells: 10_000,
    });
    expect(v).toMatchObject({ ok: false, code: "user" });
  });
});
