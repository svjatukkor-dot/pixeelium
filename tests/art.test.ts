import { describe, expect, it } from "vitest";
import {
  ART_PALETTE_SIZE,
  ART_PAYLOAD_MAX,
  TRANSPARENT_INDEX,
  decodeArtRle,
  encodeArtRle,
  validateArtPayload,
} from "../src/util";
import { ValidationError } from "../src/util";

const W = 16;
const H = 8;
const LEN = W * H;

describe("art RLE codec", () => {
  it("round-trips a solid transparent field", () => {
    const cells = new Uint8Array(LEN).fill(TRANSPARENT_INDEX);
    const encoded = encodeArtRle(cells);
    expect(encoded.length).toBeLessThan(16);
    expect([...decodeArtRle(encoded, LEN)]).toEqual([...cells]);
  });

  it("round-trips a checkerboard of all palette values (incl. transparent)", () => {
    const cells = new Uint8Array(LEN);
    for (let i = 0; i < LEN; i++) {
      cells[i] = (i % ART_PALETTE_SIZE) as number;
    }
    const encoded = encodeArtRle(cells);
    expect([...decodeArtRle(encoded, LEN)]).toEqual([...cells]);
  });

  it("caps runs at 255 and still round-trips", () => {
    const cells = new Uint8Array(4000).fill(5);
    const encoded = encodeArtRle(cells);
    const decoded = decodeArtRle(encoded, 4000);
    expect(decoded.every((v) => v === 5)).toBe(true);
  });

  it("rejects indexes outside the palette at encode time", () => {
    const cells = new Uint8Array([0, 1, ART_PALETTE_SIZE]);
    expect(() => encodeArtRle(cells)).toThrow(/out of range/);
  });

  it("rejects payloads that decode past or short of the expected length", () => {
    const one = encodeArtRle(new Uint8Array([3, 7]));
    expect(() => decodeArtRle(one, 15)).toThrow();
    expect(() => decodeArtRle(one, 14)).toThrow();
  });

  it("keeps payload size well under the 16 KB budget for a 10x10 area", () => {
    const noise = new Uint8Array(100);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 7) % ART_PALETTE_SIZE;
    const encoded = encodeArtRle(noise);
    expect(encoded.length).toBeLessThanOrEqual(ART_PAYLOAD_MAX);
    expect(encoded.length).toBeLessThan(300);
  });
});

describe("validateArtPayload", () => {
  const base = () => new Uint8Array(LEN).fill(TRANSPARENT_INDEX);
  const paint = (cells: Uint8Array, idx: number, v: number) => {
    cells[idx] = v;
    return encodeArtRle(cells);
  };

  it("accepts a valid payload and returns decoded cells", () => {
    const data = paint(base(), 5, 12);
    const out = validateArtPayload(data, W, H);
    expect(out[5]).toBe(12);
  });

  it("rejects a non-string payload", () => {
    expect(() => validateArtPayload(42, W, H)).toThrow(ValidationError);
    expect(() => validateArtPayload(null, W, H)).toThrow(ValidationError);
  });

  it("rejects an empty payload", () => {
    expect(() => validateArtPayload("", W, H)).toThrow(/порожній/);
  });

  it("rejects a payload over the 16 KB size budget with 413", () => {
    expect(() => validateArtPayload("A".repeat(ART_PAYLOAD_MAX + 1), W, H)).toThrow(
      ValidationError,
    );
    try {
      validateArtPayload("A".repeat(ART_PAYLOAD_MAX + 1), W, H);
    } catch (err) {
      expect((err as ValidationError).status).toBe(413);
    }
  });

  it("rejects cell values outside the palette", () => {
    expect(() => paint(base(), 0, ART_PALETTE_SIZE + 1)).toThrow();
  });

  it("rejects a payload that clashes with the rectangle dimensions", () => {
    const small = encodeArtRle(new Uint8Array(4).fill(3));
    expect(() => validateArtPayload(small, W, H)).toThrow(/length mismatch|run past end/);
  });

  it("accepts the palette-index boundary value", () => {
    const cells = base();
    cells[3] = ART_PALETTE_SIZE - 1;
    const data = encodeArtRle(cells);
    const out = validateArtPayload(data, W, H);
    expect(out[3]).toBe(ART_PALETTE_SIZE - 1);
  });
});
