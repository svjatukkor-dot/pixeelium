import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_PROXY_MAX_BYTES,
  isPublicHttpUrl,
  proxyImage,
} from "../src/imgproxy";
import type { Env } from "../src/types";

function fakeDb(allowed: boolean) {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => (allowed ? { id: "r" } : null),
      }),
    }),
  } as unknown as Env["DB"];
}

function envWith(allowed: boolean): Env {
  return { DB: fakeDb(allowed), ENVIRONMENT: "local" } as unknown as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isPublicHttpUrl (SSRF guard)", () => {
  it("accepts public http(s) hosts", () => {
    expect(isPublicHttpUrl("https://cdn.example.org/a.png")).toBe(true);
    expect(isPublicHttpUrl("http://203.0.113.7/x.jpg")).toBe(true);
  });

  it("refuses non-http schemes, credentials and broken URLs", () => {
    expect(isPublicHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isPublicHttpUrl("ftp://a/b")).toBe(false);
    expect(isPublicHttpUrl("https://u:p@example.com/x")).toBe(false);
    expect(isPublicHttpUrl("not a url")).toBe(false);
  });

  it("refuses localhost and private ranges", () => {
    expect(isPublicHttpUrl("http://localhost/s")).toBe(false);
    expect(isPublicHttpUrl("http://app.localhost/s")).toBe(false);
    expect(isPublicHttpUrl("http://app.internal/s")).toBe(false);
    expect(isPublicHttpUrl("http://127.0.0.1/s")).toBe(false);
    expect(isPublicHttpUrl("http://10.1.2.3/s")).toBe(false);
    expect(isPublicHttpUrl("http://192.168.0.1/s")).toBe(false);
    expect(isPublicHttpUrl("http://172.20.5.5/s")).toBe(false);
    expect(isPublicHttpUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isPublicHttpUrl("http://0.0.0.0/s")).toBe(false);
    expect(isPublicHttpUrl("http://[::1]/s")).toBe(false);
    expect(isPublicHttpUrl("https://[fd00::5]/s")).toBe(false);
  });
});

describe("proxyImage", () => {
  it("passes a small image through with its content type", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(png, { status: 200, headers: { "Content-Type": "image/png" } })),
    );
    const res = await proxyImage("https://cdn.example.org/a.png", envWith(true));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.contentType).toBe("image/png");
      expect(res.bytes.byteLength).toBe(4);
    }
  });

  it("refuses when the URL is not owned by any active rental", async () => {
    const res = await proxyImage("https://cdn.example.org/a.png", envWith(false));
    expect(res.ok).toBe(false);
  });

  it("refuses non-image content types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } })),
    );
    const res = await proxyImage("https://cdn.example.org/a.png", envWith(true));
    expect(res.ok).toBe(false);
  });

  it("refuses images larger than 200 KB", async () => {
    const tooBig = new Uint8Array(IMAGE_PROXY_MAX_BYTES + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(tooBig, { status: 200, headers: { "Content-Type": "image/png" } })),
    );
    const res = await proxyImage("https://cdn.example.org/big.png", envWith(true));
    expect(res.ok).toBe(false);
  });

  it("accepts a body of exactly 200 KB", async () => {
    const exact = new Uint8Array(IMAGE_PROXY_MAX_BYTES);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(exact, { status: 200, headers: { "Content-Type": "image/jpeg" } })),
    );
    const res = await proxyImage("https://cdn.example.org/exact.jpg", envWith(true));
    expect(res.ok).toBe(true);
  });

  it("maps upstream errors and private hosts to ok:false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    expect(await proxyImage("https://cdn.example.org/a.png", envWith(true))).toMatchObject({
      ok: false,
    });
    expect(await proxyImage("http://10.0.0.1/a.png", envWith(true))).toMatchObject({ ok: false });
  });

  it("follows safe redirects to public image hosts", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://cdn.example.org/redirect.png") {
          return new Response(null, {
            status: 302,
            headers: { Location: "https://images.example.org/final.png" },
          });
        }
        return new Response(png, { status: 200, headers: { "Content-Type": "image/png" } });
      }),
    );
    const res = await proxyImage("https://cdn.example.org/redirect.png", envWith(true));
    expect(res.ok).toBe(true);
  });

  it("refuses redirects pointing to private addresses (SSRF prevention)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1/admin.png" },
        }),
      ),
    );
    const res = await proxyImage("https://cdn.example.org/redirect-evil.png", envWith(true));
    expect(res.ok).toBe(false);
  });
});
