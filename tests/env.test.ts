import { describe, expect, it } from "vitest";
import { resolveTronApiBase, timingSafeEqualStr } from "../src/util";

describe("resolveTronApiBase (TRON_API_BASE is a local-only test hook)", () => {
  it("honors the override when ENVIRONMENT is local", () => {
    expect(
      resolveTronApiBase({ ENVIRONMENT: "local", TRON_API_BASE: "http://127.0.0.1:8799" }),
    ).toBe("http://127.0.0.1:8799");
  });

  it("ignores the override when ENVIRONMENT is not local (production guard)", () => {
    expect(resolveTronApiBase({ ENVIRONMENT: "production", TRON_API_BASE: "http://evil" })).toBeUndefined();
    expect(resolveTronApiBase({ TRON_API_BASE: "http://evil" })).toBeUndefined();
    expect(resolveTronApiBase({ ENVIRONMENT: "staging", TRON_API_BASE: "http://evil" })).toBeUndefined();
  });

  it("returns undefined when no override is configured", () => {
    expect(resolveTronApiBase({ ENVIRONMENT: "local" })).toBeUndefined();
    expect(resolveTronApiBase({})).toBeUndefined();
  });
});

describe("timingSafeEqualStr", () => {
  it("matches equal strings", () => {
    expect(timingSafeEqualStr("abcdef", "abcdef")).toBe(true);
    expect(timingSafeEqualStr("", "")).toBe(true);
  });

  it("rejects different strings of the same length", () => {
    expect(timingSafeEqualStr("abcdef", "abcdeg")).toBe(false);
    expect(timingSafeEqualStr("aaaa", "aaab")).toBe(false);
  });

  it("rejects different lengths without throwing", () => {
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });
});
