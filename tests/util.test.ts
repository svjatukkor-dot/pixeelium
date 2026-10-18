import { describe, expect, it } from "vitest";
import {
  TX_HASH_RE,
  amountWithSuffix,
  cleanColor,
  cleanText,
  clampInt,
  formatUsdt,
  isInBounds,
  optionalHttpUrl,
  priceBuyMicro,
  priceMicro,
  randomAmountSuffix,
  rectsOverlap,
  touchesReservedTop,
  tronAddressToHex,
} from "../src/util";
import {
  GRID_H,
  GRID_W,
  MAX_HOURS,
  MAX_CELLS_PER_ORDER,
  PRICE_MICRO_PER_PIXEL_BUY,
  PRICE_MICRO_PER_PIXEL_HOUR,
  RESERVED_TOP_ROWS,
} from "../src/config";

describe("pricing", () => {
  it("charges 0.05 USDT per pixel per hour", () => {
    expect(PRICE_MICRO_PER_PIXEL_HOUR).toBe(50_000);
    expect(priceMicro(1, 1)).toBe(50_000);
    expect(priceMicro(100, 24)).toBe(120_000_000);
    expect(formatUsdt(priceMicro(1, 1))).toBe("0.05");
    expect(formatUsdt(priceMicro(1, 24))).toBe("1.2");
    expect(formatUsdt(priceMicro(4, 1))).toBe("0.2");
  });

  it("stays in safe integer range for the largest possible order", () => {
    // Ліміт замовлення (не вся дошка!) — MAX_CELLS_PER_ORDER × MAX_HOURS.
    const max = priceMicro(MAX_CELLS_PER_ORDER, MAX_HOURS);
    expect(Number.isSafeInteger(priceMicro(MAX_CELLS_PER_ORDER, 1))).toBe(true);
    expect(max).toBe(MAX_CELLS_PER_ORDER * MAX_HOURS * PRICE_MICRO_PER_PIXEL_HOUR);
  });

  it("rejects non-integer inputs instead of silently rounding", () => {
    expect(() => priceMicro(1.5, 1)).toThrow();
    expect(() => priceMicro(0, 1)).toThrow();
    expect(() => priceMicro(1, -1)).toThrow();
  });

  it("formats without floating point drift", () => {
    expect(formatUsdt(1_000_000)).toBe("1");
    expect(formatUsdt(1_500_000)).toBe("1.5");
    expect(formatUsdt(1_234_567)).toBe("1.234567");
    expect(formatUsdt(0)).toBe("0");
  });
});

describe("rectangle math", () => {
  it("accepts only in-bounds integer rects", () => {
    expect(isInBounds({ x: 0, y: 0, w: GRID_W, h: GRID_H })).toBe(true);
    expect(isInBounds({ x: GRID_W - 1, y: 0, w: 2, h: 1 })).toBe(false);
    expect(isInBounds({ x: -1, y: 0, w: 1, h: 1 })).toBe(false);
    expect(isInBounds({ x: 0, y: 0, w: 0, h: 1 })).toBe(false);
    expect(isInBounds({ x: 0.5, y: 0, w: 1, h: 1 })).toBe(false);
  });

  it("detects overlap but not mere adjacency", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectsOverlap(a, { x: 9, y: 9, w: 5, h: 5 })).toBe(true);
    expect(rectsOverlap(a, { x: 10, y: 0, w: 5, h: 5 })).toBe(false);
    expect(rectsOverlap(a, { x: 0, y: 10, w: 5, h: 5 })).toBe(false);
    expect(rectsOverlap(a, { x: 5, y: 5, w: 1, h: 1 })).toBe(true);
  });
});

describe("tron address parsing", () => {
  const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const USDT_HEX = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";

  it("decodes a checksummed TRON address", async () => {
    await expect(tronAddressToHex(USDT)).resolves.toBe(USDT_HEX);
  });

  it("accepts an already-hex address", async () => {
    await expect(tronAddressToHex(USDT_HEX)).resolves.toBe(USDT_HEX);
    await expect(tronAddressToHex(USDT_HEX.toUpperCase())).resolves.toBe(USDT_HEX);
  });

  it("rejects a mistyped address (checksum)", async () => {
    const broken = `${USDT.slice(0, -1)}Q`;
    await expect(tronAddressToHex(broken)).rejects.toThrow();
  });

  it("rejects addresses of other chains", async () => {
    await expect(tronAddressToHex("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).rejects.toThrow();
    await expect(tronAddressToHex("not-an-address")).rejects.toThrow();
    await expect(tronAddressToHex("")).rejects.toThrow();
  });
});

describe("input hardening", () => {
  it("strips markup characters and control codes from titles", () => {
    expect(cleanText("<script>alert(1)</script> Ad", 60)).not.toMatch(/[<>]/);
    expect(cleanText("a\u0000b", 60)).toBe("a b");
    expect(cleanText("x".repeat(200), 60)).toHaveLength(60);
    expect(cleanText(42 as unknown as string, 60)).toBe("");
  });

  it("allows only http/https content urls", () => {
    expect(optionalHttpUrl("https://example.com/a.png", "imageUrl")).toBe(
      "https://example.com/a.png",
    );
    expect(() => optionalHttpUrl("javascript:alert(1)", "imageUrl")).toThrow();
    expect(() => optionalHttpUrl("data:text/html,<h1>x", "imageUrl")).toThrow();
    expect(() => optionalHttpUrl("ftp://example.com", "imageUrl")).toThrow();
    expect(() => optionalHttpUrl("https://user:pass@example.com", "imageUrl")).toThrow();
    expect(optionalHttpUrl("", "imageUrl")).toBe("");
    expect(optionalHttpUrl(undefined, "imageUrl")).toBe("");
  });

  it("validates colors and integers", () => {
    expect(cleanColor("#AABBCC")).toBe("#aabbcc");
    expect(cleanColor("red")).toBe("");
    expect(cleanColor("rgb(0,0,0)")).toBe("");
    expect(clampInt(5, 0, 10)).toBe(5);
    expect(clampInt(50, 0, 10)).toBeNull();
    expect(clampInt("abc", 0, 10)).toBeNull();
    expect(clampInt(3.9, 0, 10)).toBe(3);
  });

  it("accepts only 64-char hex transaction hashes", () => {
    expect(TX_HASH_RE.test("a".repeat(64))).toBe(true);
    expect(TX_HASH_RE.test("A".repeat(64))).toBe(true);
    expect(TX_HASH_RE.test("a".repeat(63))).toBe(false);
    expect(TX_HASH_RE.test("g".repeat(64))).toBe(false);
  });

  it("prices a one-time purchase at 2.5 USDT per pixel (buy mode)", () => {
    expect(PRICE_MICRO_PER_PIXEL_BUY).toBe(2_500_000);
    expect(priceBuyMicro(1)).toBe(2_500_000);
    expect(priceBuyMicro(100)).toBe(250_000_000);
    expect(priceBuyMicro(1234)).toBe(1234 * 2_500_000);
    expect(() => priceBuyMicro(0)).toThrow();
    expect(() => priceBuyMicro(-5)).toThrow();
    expect(() => priceBuyMicro(1.5)).toThrow();
    // Buying 1000 pixels is worth exactly 50_000 pixel-hours of rent.
    expect(priceBuyMicro(1000)).toBe(priceMicro(1000, 50));
  });

  it("adds a 1..9999 micro-USDT surcharge as the order fingerprint", () => {
    expect(amountWithSuffix(50_000, 1)).toBe(50_001);
    expect(amountWithSuffix(50_000, 9999)).toBe(59_999);
    expect(amountWithSuffix(2_500_000, 5000)).toBe(2_505_000);
    expect(() => amountWithSuffix(50_000, 0)).toThrow();
    expect(() => amountWithSuffix(50_000, 10_000)).toThrow();
    expect(() => amountWithSuffix(50_000, -1)).toThrow();
    expect(() => amountWithSuffix(0, 5)).toThrow();
    expect(() => amountWithSuffix(1.5, 5)).toThrow();
  });

  it("generates surcharges inside the allowed range", () => {
    for (let i = 0; i < 500; i++) {
      const s = randomAmountSuffix();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(9999);
    }
  });

  it("detects the reserved top zone correctly", () => {
    expect(RESERVED_TOP_ROWS).toBeGreaterThan(0);
    expect(touchesReservedTop({ x: 0, y: 0, w: 10, h: 1 })).toBe(true);
    expect(touchesReservedTop({ x: 0, y: RESERVED_TOP_ROWS - 1, w: 1, h: 1 })).toBe(true);
    expect(touchesReservedTop({ x: 0, y: RESERVED_TOP_ROWS, w: 1, h: 1 })).toBe(false);
    expect(touchesReservedTop({ x: 0, y: RESERVED_TOP_ROWS, w: 1, h: 3 })).toBe(false);
  });
});
