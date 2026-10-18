import { afterEach, describe, expect, it, vi } from "vitest";
import { appOrigin, authCallback } from "../src/auth";
import type { Env } from "../src/types";
import { ValidationError } from "../src/util";

/* Міні-D1 shim: authCallback only writes (users upsert, sessions insert/delete). */
function fakeDb() {
  const stmt = {
    bind: () => stmt,
    run: async () => ({ success: true, meta: { changes: 1 } }),
    first: async () => null,
    all: async () => ({ results: [] }),
  };
  return {
    prepare: () => stmt,
    batch: async () => [],
  } as unknown as Env["DB"];
}

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

async function makeKeys(): Promise<{
  publicJwk: Record<string, string>;
  idTokenFor(payload: Record<string, unknown>): Promise<string>;
}> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pubJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as unknown as Record<
    string,
    string
  >;
  pubJwk.kid = "test-kid";
  return {
    publicJwk: pubJwk,
    async idTokenFor(payload) {
      const header = b64url(JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "JWT" }));
      const body = b64url(JSON.stringify(payload));
      const signature = await crypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5" },
        keyPair.privateKey,
        new TextEncoder().encode(`${header}.${body}`) as unknown as BufferSource,
      );
      return `${header}.${body}.${Buffer.from(signature).toString("base64url")}`;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubTokenFetch(jwks: unknown, idToken: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2/v3/certs")) {
        return new Response(JSON.stringify(jwks), { status: 200 });
      }
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }),
  );
}

function testEnv(): { env: Env; verifier: string; state: string } {
  const verifier = "a".repeat(64);
  const state = "b".repeat(32);
  const env = {
    DB: fakeDb(),
    APP_ORIGIN: "https://app.test",
    ENVIRONMENT: "local",
    GOOGLE_CLIENT_ID: "cid",
    GOOGLE_CLIENT_SECRET: "csecret",
  } as unknown as Env;
  return { env, verifier, state };
}

describe("authCallback Set-Cookie", () => {
  it("returns two SEPARATE Secure set-cookie rows after a successful login", async () => {
    const keys = await makeKeys();
    const now = Math.floor(Date.now() / 1000);
    const idToken = await keys.idTokenFor({
      iss: "https://accounts.google.com",
      aud: "cid",
      sub: "1234567890",
      email: "user@example.com",
      email_verified: true,
      name: "Tester",
      iat: now,
      exp: now + 600,
    });
    stubTokenFetch({ keys: [keys.publicJwk] }, idToken);

    const { env, verifier, state } = testEnv();
    const request = new Request(
      `https://app.test/api/auth/callback?code=abc&state=${state}`,
      { headers: { cookie: `px_oauth=${state}.${verifier}` } },
    );
    const res = await authCallback(env, request);

    expect(res.status).toBe(303);
    // Core regression: Set-Cookie must stay two header lines, not one comma-merged.
    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBe(2);
    const names = new Set(cookies.map((c) => c.split("=")[0]!.trim()));
    expect(names).toEqual(new Set(["px_session", "px_oauth"]));
    for (const cookie of cookies) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure"); // request is https -> both must be Secure
    }
    expect(res.headers.get("Location")).toBe("/?auth=ok");
  });

  it("returns a GENERIC message when token verification fails (no internals leaked)", async () => {
    const keys = await makeKeys();
    const now = Math.floor(Date.now() / 1000);
    // wrong audience -> verification must fail
    const idToken = await keys.idTokenFor({
      iss: "https://accounts.google.com",
      aud: "some-other-client",
      sub: "x",
      email: "u@example.com",
      email_verified: true,
      iat: now,
      exp: now + 600,
    });
    stubTokenFetch({ keys: [keys.publicJwk] }, idToken);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { env, verifier, state } = testEnv();
    const request = new Request(
      `https://app.test/api/auth/callback?code=abc&state=${state}`,
      { headers: { cookie: `px_oauth=${state}.${verifier}` } },
    );
    const res = await authCallback(env, request);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // The internal reason ("bad audience") must NOT reach the client.
    expect(body.error).toBe("Не вдалося перевірити токен входу. Спробуйте ще раз.");
    expect(body.error).not.toContain("audience");
  });
});

describe("appOrigin APP_ORIGIN requirement", () => {
  const request = new Request("https://req-host.example/api/auth/login");

  it("falls back to the request origin in local dev", () => {
    const url = appOrigin(
      { ENVIRONMENT: "local" } as unknown as Env,
      new Request("http://localhost:8787/api/auth/login"),
    );
    expect(url).toBe("http://localhost:8787");
  });

  it("REQUIRES APP_ORIGIN outside local (fails closed with 503)", () => {
    try {
      appOrigin({} as unknown as Env, request);
      expect.unreachable("appOrigin must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).status).toBe(503);
      expect((err as ValidationError).message).toContain("APP_ORIGIN");
    }
  });

  it("uses the configured APP_ORIGIN outside local when https", () => {
    const url = appOrigin(
      { ENVIRONMENT: "production", APP_ORIGIN: "https://pixel.example/" } as unknown as Env,
      request,
    );
    expect(url).toBe("https://pixel.example");
  });
});
