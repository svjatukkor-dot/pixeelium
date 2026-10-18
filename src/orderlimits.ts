import { GRID_H, GRID_W } from "./config";

/**
 * Anti-abuse limits for unpaid (pending) orders (item 2):
 *  - at most 3 pending orders per user,
 *  - at most 5 pending orders per IP,
 *  - the total pending hold area of one user may never exceed 25% of the board.
 */

export const MAX_PENDING_PER_USER = 3;
export const MAX_PENDING_PER_IP = 5;
export const MAX_PENDING_AREA_FRACTION = 0.25;

export type PendingLimitCode = "user" | "ip" | "area";

export type PendingLimitVerdict =
  | { ok: true }
  | { ok: false; code: PendingLimitCode; status: 429 | 400; message: string };

export interface PendingLimitInput {
  /** Active pending orders of this user (after same-rect auto-cancel). */
  userPending: number;
  /** Sum of w*h over this user's active pending orders. */
  userPendingCells: number;
  /** Active pending orders from this IP. */
  ipPending: number;
  /** Cells the new order wants to hold. */
  requestedCells: number;
  /** Board size override (defaults to GRID_W × GRID_H from config). */
  boardCells?: number;
}

export function checkPendingLimits(input: PendingLimitInput): PendingLimitVerdict {
  const boardCells = input.boardCells ?? GRID_W * GRID_H;
  const areaLimit = Math.floor(boardCells * MAX_PENDING_AREA_FRACTION);

  if (input.userPending >= MAX_PENDING_PER_USER) {
    return {
      ok: false,
      code: "user",
      status: 429,
      message: `Максимум ${MAX_PENDING_PER_USER} незавершених замовлень. Оплатіть або скасуйте попередні в «Моїх пікселях».`,
    };
  }
  if (input.userPendingCells + input.requestedCells > areaLimit) {
    return {
      ok: false,
      code: "area",
      status: 400,
      message: `Сумарна площа незавершених утримань (${input.userPendingCells} + ${input.requestedCells} пікселів) перевищує ${Math.round(MAX_PENDING_AREA_FRACTION * 100)}% дошки (${areaLimit} пікселів).`,
    };
  }
  if (input.ipPending >= MAX_PENDING_PER_IP) {
    return {
      ok: false,
      code: "ip",
      status: 429,
      message: "З цієї адреси вже забагато неоплачених замовлень. Спробуйте пізніше.",
    };
  }
  return { ok: true };
}
