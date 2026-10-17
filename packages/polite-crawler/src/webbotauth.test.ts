import type { KeyObject } from "node:crypto";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { FileBlobStore } from "./blobs.ts";
import type { CrawlerOptions } from "./crawler.ts";
import { Crawler } from "./crawler.ts";
import { DocIndex } from "./docs.ts";
import { CaptureLog } from "./log.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";
import {
  KEY_DIRECTORY_PATH,
  KEY_DIRECTORY_TYPE,
  createWebBotAuthSigner,
  keyDirectory,
  signParts,
  signatureBase,
  verifySignature,
} from "./webbotauth.ts";

// The Ed25519 test key of RFC 9421, appendix B.1.4 (test-key-ed25519).
const RFC_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJrQLj5P/89iXES9+vFgrIy29clF9CC/oPPsw3c5D0bs=
-----END PUBLIC KEY-----
`;
const RFC_PRIVATE_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMDoQikTmiCqirVv9mWG9qfSnF
-----END PRIVATE KEY-----
`;
const RFC_JWK = {
  kty: "OKP",
  crv: "Ed25519",
  d: "n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU",
  x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
};
/** The keyid of the RFC key in the Web Bot Auth draft, appendix E.2. */
const RFC_KEYID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";

// ── an independent verifier: RFC 9421 section 2.5 and the draft, with no code of the package ──

/** The JWK thumbprint of an Ed25519 key (RFC 7638 with the members of RFC 8037 appendix A.3). */
const thumbprint = (x: string): string =>
  createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest("base64url");

/** This function builds a signature base from the component values, as RFC 9421 section 2.5 tells. */
const baseFrom = (
  components: readonly string[],
  value: (component: string) => string,
  params: string,
): string =>
  [
    ...components.map((component) => `${component}: ${value(component)}`),
    `"@signature-params": ${params}`,
  ].join("\n");

interface Independent {
  readonly ok: boolean;
  readonly why?: string;
}

/**
 * This function verifies a Web Bot Auth request in the simple way of the profile. It reads the
 * headers with regular expressions, builds the base from the URL and `Signature-Agent`, checks the
 * tag, the times and the thumbprint, and verifies the Ed25519 signature with `node:crypto`.
 */
const independentVerify = (
  url: string,
  headers: Readonly<Record<string, string>>,
  publicKey: KeyObject,
  nowSeconds: number,
): Independent => {
  const input = /^([a-z*][a-z0-9_\-.*]*)=(\(([^)]*)\)(.*))$/.exec(headers["signature-input"] ?? "");
  if (input === null) return { ok: false, why: "no Signature-Input" };
  const [, label, params, inner, rest] = input as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  const components = inner.split(" ").filter((part) => part.length > 0);
  const named = new Map<string, string>();
  for (const match of rest.matchAll(/;([a-z]+)=("(?:[^"\\]|\\.)*"|[^;]*)/g))
    named.set(match[1]!, match[2]!.replace(/^"|"$/g, ""));
  if (named.get("tag") !== "web-bot-auth") return { ok: false, why: "tag" };
  if (named.get("alg") !== "ed25519") return { ok: false, why: "alg" };
  const created = Number(named.get("created"));
  const expires = Number(named.get("expires"));
  if (!(created <= nowSeconds && nowSeconds < expires)) return { ok: false, why: "time" };
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  if (named.get("keyid") !== thumbprint(x)) return { ok: false, why: "keyid" };
  if (!components.includes('"@authority"')) return { ok: false, why: "no @authority" };
  const agentComponent = components.find((part) => part.startsWith('"signature-agent";key='));
  if (agentComponent === undefined) return { ok: false, why: "no signature-agent" };
  const signatureMatch = new RegExp(`^${label}=:([A-Za-z0-9+/=]+):$`).exec(
    headers["signature"] ?? "",
  );
  if (signatureMatch === null) return { ok: false, why: "no Signature" };
  const value = (component: string): string => {
    if (component === '"@authority"') return new URL(url).host;
    const key = /;key="([^"]+)"$/.exec(component)?.[1] ?? "";
    const member = new RegExp(`(?:^|,\\s*)${key}=("[^"]*"(?:;[^,]*)?)`).exec(
      headers["signature-agent"] ?? "",
    );
    return member?.[1] ?? "";
  };
  const base = baseFrom(components, value, params);
  const ok = edVerify(
    null,
    Buffer.from(base, "utf8"),
    publicKey,
    Buffer.from(signatureMatch[1]!, "base64"),
  );
  return ok ? { ok } : { ok, why: "signature" };
};

const rfcPublic = createPublicKey(RFC_PUBLIC_PEM);
const rfcPrivate = createPrivateKey(RFC_PRIVATE_PEM);

describe("the vectors", () => {
  it("checks the independent verifier with the ed25519 vector of RFC 9421 (B.2.6)", () => {
    const message: Record<string, string> = {
      '"date"': "Tue, 20 Apr 2021 02:07:55 GMT",
      '"@method"': "POST",
      '"@path"': "/foo",
      '"@authority"': "example.com",
      '"content-type"': "application/json",
      '"content-length"': "18",
    };
    const components = Object.keys(message);
    const params =
      '("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"';
    const base = baseFrom(components, (component) => message[component]!, params);
    expect(base).toBe(
      [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@method": POST',
        '"@path": /foo',
        '"@authority": example.com',
        '"content-type": application/json',
        '"content-length": 18',
        `"@signature-params": ${params}`,
      ].join("\n"),
    );
    const signature =
      "wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==";
    // Ed25519 is deterministic: the key of the RFC gives the signature of the RFC
    expect(edSign(null, Buffer.from(base), rfcPrivate).toString("base64")).toBe(signature);
    expect(edVerify(null, Buffer.from(base), rfcPublic, Buffer.from(signature, "base64"))).toBe(
      true,
    );
  });

  it("gives the base, the Signature-Input and the Signature of the draft vector E.2.1", () => {
    const parts = {
      authority: "example.com",
      label: "sig2",
      agentKey: "agent2",
      agentValue: '"https://signature-agent.test"',
      keyId: RFC_KEYID,
      created: 1735689600,
      expires: 4889289600,
      nonce:
        "n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==",
    };
    const params =
      '("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"';
    expect(signatureBase(parts)).toBe(
      [
        '"@authority": example.com',
        '"signature-agent";key="agent2": "https://signature-agent.test"',
        `"@signature-params": ${params}`,
      ].join("\n"),
    );
    const headers = signParts(parts, rfcPrivate);
    expect(headers).toEqual({
      "signature-agent": 'agent2="https://signature-agent.test"',
      "signature-input": `sig2=${params}`,
      signature:
        "sig2=:RdNFx5Bj6au3YgAMQL/RzmUlZE8QZLIaXGRpw985hWnwPfMxT228NMk6ehRS1PSl4e8PhbNZACSanGdhEwYCCg==:",
    });
    // the independent verifier and the verifier of the package agree on the vector
    expect(independentVerify("https://example.com/", headers, rfcPublic, 1735689601)).toEqual({
      ok: true,
    });
    expect(
      verifySignature({ url: "https://example.com/", headers }, keyDirectory([RFC_PUBLIC_PEM]), {
        now: 1735689601_000,
      }),
    ).toMatchObject({
      verified: true,
      label: "sig2",
      keyId: RFC_KEYID,
      agent: "https://signature-agent.test",
    });
  });

  it("gives the thumbprint of the draft as the keyid of the RFC key, in each form of the key", () => {
    const der = rfcPrivate.export({ format: "der", type: "pkcs8" });
    for (const privateKey of [
      rfcPrivate,
      RFC_PRIVATE_PEM,
      RFC_JWK,
      JSON.stringify(RFC_JWK),
      new Uint8Array(der),
    ]) {
      const signer = createWebBotAuthSigner({
        privateKey,
        signatureAgent: "https://signature-agent.test",
      });
      expect(signer.keyId).toBe(RFC_KEYID);
      expect(signer.publicKey).toEqual({ kty: "OKP", crv: "Ed25519", x: RFC_JWK.x });
    }
    expect(thumbprint(RFC_JWK.x)).toBe(RFC_KEYID);
  });
});

describe("the key directory", () => {
  it("writes only the public part of each key, with its thumbprint as kid", () => {
    const other = generateKeyPairSync("ed25519");
    const directory = keyDirectory([RFC_PRIVATE_PEM, RFC_JWK, other.publicKey, RFC_PUBLIC_PEM]);
    expect(directory.keys).toEqual([
      { kty: "OKP", crv: "Ed25519", kid: RFC_KEYID, x: RFC_JWK.x, use: "sig" },
      {
        kty: "OKP",
        crv: "Ed25519",
        kid: thumbprint((other.publicKey.export({ format: "jwk" }) as { x: string }).x),
        x: (other.publicKey.export({ format: "jwk" }) as { x: string }).x,
        use: "sig",
      },
    ]);
    expect(JSON.stringify(directory)).not.toContain(RFC_JWK.d);
    expect(KEY_DIRECTORY_PATH).toBe("/.well-known/http-message-signatures-directory");
    expect(KEY_DIRECTORY_TYPE).toBe("application/http-message-signatures-directory+json");
  });

  it("refuses a key that is not Ed25519", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => keyDirectory([ec.publicKey])).toThrow(/not ed25519/);
  });
});

describe("the signer", () => {
  const signer = createWebBotAuthSigner({
    privateKey: RFC_PRIVATE_PEM,
    signatureAgent: "https://signature-agent.test",
  });

  it("signs @authority and its Signature-Agent member, with a nonce and a short life", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    const headers = signer.sign(new URL("https://Example.COM:8443/a/b?c=d"), now);
    expect(headers["signature-agent"]).toBe('sig1="https://signature-agent.test"');
    expect(headers["signature-input"]).toMatch(
      /^sig1=\("@authority" "signature-agent";key="sig1"\);created=\d+;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=\d+;nonce="[A-Za-z0-9+/=]{44}";tag="web-bot-auth"$/,
    );
    const created = Math.floor(now / 1000);
    expect(headers["signature-input"]).toContain(`;created=${String(created)};`);
    expect(headers["signature-input"]).toContain(`;expires=${String(created + 300)};`);
    expect(
      independentVerify("https://example.com:8443/a/b?c=d", headers, rfcPublic, created),
    ).toEqual({ ok: true });
    // each signature has its own nonce
    expect(signer.sign(new URL("https://example.com/"), now)["signature-input"]).not.toBe(
      signer.sign(new URL("https://example.com/"), now)["signature-input"],
    );
  });

  it("names a key set on a path with the type jwks_uri", () => {
    const own = createWebBotAuthSigner({
      privateKey: rfcPrivate,
      signatureAgent: "https://example.github.io/bot/jwks.json",
      agentType: "jwks_uri",
      label: "bot",
      lifetimeMs: 60_000,
    });
    const now = Date.parse("2026-10-17T12:00:00Z");
    const headers = own.sign(new URL("https://site.example/"), now);
    expect(headers["signature-agent"]).toBe(
      'bot="https://example.github.io/bot/jwks.json";type=jwks_uri',
    );
    expect(independentVerify("https://site.example/", headers, rfcPublic, now / 1000)).toEqual({
      ok: true,
    });
    expect(
      verifySignature({ url: "https://site.example/", headers }, keyDirectory([rfcPublic]), {
        now,
      }),
    ).toMatchObject({ verified: true, agent: "https://example.github.io/bot/jwks.json" });
  });

  it("refuses bad options with errors that hold no key", () => {
    const body = RFC_PRIVATE_PEM.split("\n")[1]!;
    const bad = (options: Parameters<typeof createWebBotAuthSigner>[0]): string => {
      try {
        createWebBotAuthSigner(options);
      } catch (error) {
        return (error as Error).message;
      }
      return "no error";
    };
    const agent = "https://signature-agent.test";
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const messages = [
      bad({ privateKey: "not a key", signatureAgent: agent }),
      bad({ privateKey: RFC_PUBLIC_PEM, signatureAgent: agent }),
      bad({ privateKey: rfcPublic, signatureAgent: agent }),
      bad({ privateKey: ec.privateKey, signatureAgent: agent }),
      bad({ privateKey: RFC_PRIVATE_PEM, signatureAgent: agent, keyId: "test-key-ed25519" }),
      bad({ privateKey: RFC_PRIVATE_PEM, signatureAgent: "http://signature-agent.test" }),
      bad({ privateKey: RFC_PRIVATE_PEM, signatureAgent: "https://example.github.io/crawler/" }),
      bad({ privateKey: RFC_PRIVATE_PEM, signatureAgent: agent, label: "Sig 1" }),
      bad({ privateKey: RFC_PRIVATE_PEM, signatureAgent: agent, lifetimeMs: 25 * 3_600_000 }),
      bad({ privateKey: RFC_PRIVATE_PEM, signatureAgent: agent, lifetimeMs: 10 }),
    ];
    expect(messages.every((message) => message !== "no error")).toBe(true);
    expect(messages[0]).toMatch(/does not parse/);
    expect(messages[3]).toMatch(/not ed25519/);
    expect(messages[4]).toMatch(/not the JWK thumbprint/);
    expect(messages[6]).toMatch(/not an origin.*jwks_uri/);
    for (const message of messages) {
      expect(message).not.toContain(body);
      expect(message).not.toContain(RFC_JWK.d);
    }
  });

  it("holds the private key in no property", () => {
    const shown = JSON.stringify(signer);
    expect(shown).not.toContain(RFC_JWK.d);
    expect(shown).not.toContain("PRIVATE KEY");
    expect(Object.keys(signer).sort()).toEqual(["keyId", "publicKey", "sign", "signatureAgent"]);
  });

  it("verifies, and tells why a request does not verify", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    const url = "https://site.example/page";
    const headers = signer.sign(new URL(url), now);
    const directory = keyDirectory([RFC_PUBLIC_PEM]);
    expect(verifySignature({ url, headers }, directory, { now })).toEqual({
      verified: true,
      label: "sig1",
      keyId: RFC_KEYID,
      agent: "https://signature-agent.test",
      reason: null,
    });
    const reasons = [
      verifySignature({ url: "https://other.example/page", headers }, directory, { now }),
      verifySignature({ url, headers }, directory, { now: now + 301_000 }),
      verifySignature({ url, headers }, directory, { now: now - 120_000 }),
      verifySignature({ url, headers }, keyDirectory([generateKeyPairSync("ed25519").publicKey]), {
        now,
      }),
      verifySignature(
        { url, headers: { ...headers, "signature-agent": 'sig1="https://evil.example"' } },
        directory,
        { now },
      ),
      verifySignature({ url, headers: {} }, directory, { now }),
    ].map((check) => check.reason);
    expect(reasons).toEqual([
      "the signature does not match the signature base",
      "the signature expired",
      "the signature was created in the future",
      "no key of the directory has the thumbprint of keyid",
      "the signature does not match the signature base",
      "the request has no Signature-Input or no Signature header",
    ]);
  });
});

// ── the crawler signs each request ──

let dir: string | undefined;
const logs: CaptureLog[] = [];
afterEach(async () => {
  for (const log of logs.splice(0)) await log.close();
  if (dir !== undefined) await removeDir(dir);
  dir = undefined;
});

interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** This function makes a crawler on mock hosts. Each host records the headers of each request. */
const setup = async (options: Partial<CrawlerOptions> = {}) => {
  dir = await tempDir("webbotauth");
  const agent = new MockAgent();
  agent.disableNetConnect();
  const seen: Seen[] = [];
  const host = (
    origin: string,
    answer: (path: string) => { status: number; body: string; headers?: Record<string, string> },
  ) =>
    agent
      .get(origin)
      .intercept({ path: () => true, method: "GET" })
      .reply((request) => {
        const headers = Object.fromEntries(
          Object.entries((request.headers ?? {}) as Record<string, string>).map(([name, value]) => [
            name.toLowerCase(),
            String(value),
          ]),
        );
        seen.push({ url: `${origin}${request.path}`, headers });
        const reply =
          request.path === "/robots.txt"
            ? {
                status: 200,
                body: "User-agent: *\nAllow: /\n",
                headers: { "content-type": "text/plain" },
              }
            : answer(request.path);
        return {
          statusCode: reply.status,
          data: reply.body,
          responseOptions: { headers: reply.headers ?? {} },
        };
      })
      .persist();
  host("https://a.example", (path) =>
    path === "/start"
      ? { status: 301, body: "", headers: { location: "https://b.example:8443/next" } }
      : { status: 200, body: "<p>a</p>", headers: { "content-type": "text/html" } },
  );
  host("https://b.example:8443", () => ({
    status: 200,
    body: "<html><body><p>The page of b.</p></body></html>",
    headers: { "content-type": "text/html" },
  }));
  const log = new CaptureLog(join(dir, "captures"));
  logs.push(log);
  const clock = fakeClock();
  const crawler = new Crawler({
    token: "PoliteCrawler",
    userAgent: "PoliteCrawler/0.1 (test)",
    log,
    blobs: new FileBlobStore(join(dir, "blobs")),
    index: new DocIndex(":memory:"),
    clock,
    random: () => 0.5,
    dispatcher: agent,
    ...options,
  });
  return { crawler, seen, clock, log, dir };
};

describe("signed requests in the crawler", () => {
  it("signs each request, robots.txt and each redirect too, for its own authority", async () => {
    const {
      crawler,
      seen,
      clock,
      log,
      dir: store,
    } = await setup({
      signer: { privateKey: RFC_PRIVATE_PEM, signatureAgent: "https://signature-agent.test" },
    });
    const page = await crawler.fetch({
      url: "https://a.example/start",
      mode: "page",
      recipe: "page",
    });
    expect(page.outcome).toBe("ok");
    await crawler.close();
    expect(seen.map((hit) => hit.url)).toEqual([
      "https://a.example/robots.txt",
      "https://a.example/start",
      "https://b.example:8443/robots.txt",
      "https://b.example:8443/next",
    ]);
    for (const hit of seen) {
      // the identity is added: the User-Agent stays as it is
      expect(hit.headers["user-agent"]).toBe("PoliteCrawler/0.1 (test)");
      expect(
        independentVerify(hit.url, hit.headers, rfcPublic, Math.floor(clock.now() / 1000)),
      ).toEqual({
        ok: true,
      });
      expect(
        verifySignature({ url: hit.url, headers: hit.headers }, keyDirectory([RFC_PUBLIC_PEM]), {
          now: clock.now(),
        }).verified,
      ).toBe(true);
    }
    // a signature of one host does not verify on a different host
    expect(
      independentVerify(
        "https://b.example:8443/next",
        seen[1]!.headers,
        rfcPublic,
        Math.floor(clock.now() / 1000),
      ).ok,
    ).toBe(false);
    // the capture log names the key and the agent, and holds no key
    await log.close();
    const text = await readFile(join(store, "captures", "fetch", "2026", "10.ndjson"), "utf8");
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { payload: Record<string, unknown> });
    expect(records.length).toBeGreaterThanOrEqual(4);
    for (const record of records)
      expect(record.payload["signed"]).toEqual({
        key_id: RFC_KEYID,
        agent: "https://signature-agent.test",
      });
    expect(text).not.toContain(RFC_JWK.d);
    expect(text).not.toContain(RFC_PRIVATE_PEM.split("\n")[1]!);
  });

  it("signs nothing without a signer, and keeps the headers of the caller", async () => {
    const { crawler, seen } = await setup();
    await crawler.fetch({
      url: "https://b.example:8443/next",
      mode: "api",
      recipe: "x",
      headers: { Signature: "own=:AAAA:", "Signature-Input": "own=();created=1" },
    });
    await crawler.close();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers["signature"]).toBe("own=:AAAA:");
    expect(seen[0]!.headers["signature-agent"]).toBeUndefined();
  });

  it("replaces the signature headers of a caller with its own", async () => {
    const { crawler, seen, clock } = await setup({
      signer: createWebBotAuthSigner({
        privateKey: RFC_JWK,
        signatureAgent: "https://signature-agent.test",
      }),
    });
    await crawler.fetch({
      url: "https://b.example:8443/next",
      mode: "api",
      recipe: "x",
      headers: { signature: "own=:AAAA:", "signature-agent": 'own="https://evil.example"' },
    });
    await crawler.close();
    expect(seen[0]!.headers["signature"]).not.toContain("own=");
    expect(seen[0]!.headers["signature-agent"]).toBe('sig1="https://signature-agent.test"');
    expect(
      independentVerify(seen[0]!.url, seen[0]!.headers, rfcPublic, Math.floor(clock.now() / 1000)),
    ).toEqual({ ok: true });
  });

  it("sends no request when a signer of its own fails", async () => {
    const { crawler, seen } = await setup({
      signer: {
        keyId: "k",
        signatureAgent: "https://signature-agent.test",
        sign: () => {
          throw new Error("the hardware key is locked");
        },
      },
    });
    const page = await crawler.fetch({
      url: "https://b.example:8443/next",
      mode: "api",
      recipe: "x",
    });
    await crawler.close();
    expect(seen).toHaveLength(0);
    expect(page.outcome).toBe("skipped");
    expect(page.note).toBe("the signer did not sign the request: the hardware key is locked");
  });

  it("refuses a bad key when the crawler is made", async () => {
    await expect(
      setup({
        signer: { privateKey: "not a key", signatureAgent: "https://signature-agent.test" },
      }),
    ).rejects.toThrow(/does not parse/);
  });
});
