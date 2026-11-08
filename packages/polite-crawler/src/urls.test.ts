import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as root from "./index.ts";
import { cacheKeyOf, canonicalUrl, scopeTest, siteOf } from "./urls.ts";

/** The fields of package.json that name the entry point `polite-crawler/urls`. */
interface Manifest {
  readonly exports: Readonly<Record<string, unknown>>;
  readonly publishConfig: { readonly exports: Readonly<Record<string, unknown>> };
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as Manifest;

describe("the entry point polite-crawler/urls", () => {
  it("maps to src/urls.ts in the workspace and to build/urls.mjs in the package", () => {
    expect(manifest.exports["./urls"]).toBe("./src/urls.ts");
    expect(manifest.publishConfig.exports["./urls"]).toEqual({
      types: "./build/urls.d.mts",
      default: "./build/urls.mjs",
    });
  });

  it("imports no module, so it loads none of the dependencies of the crawler", () => {
    const source = readFileSync(new URL("urls.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\bimport\(/);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it("gives the same functions as the root entry point", () => {
    expect(root.canonicalUrl).toBe(canonicalUrl);
    expect(root.cacheKeyOf).toBe(cacheKeyOf);
    expect(root.siteOf).toBe(siteOf);
  });
});

describe("canonicalUrl", () => {
  it("gives one URL for two spellings of one page", () => {
    expect(canonicalUrl("https://Example.COM:443/a?utm_source=x&id=1#top")).toBe(
      canonicalUrl("https://example.com/a?id=1"),
    );
    expect(canonicalUrl("http://example.com:80/%7Euser")).toBe("http://example.com/~user");
    expect(canonicalUrl("https://example.com/p?fbclid=1")).toBe("https://example.com/p");
  });

  it("keeps a port that is not the default and the parameters that are not tracking", () => {
    expect(canonicalUrl("https://example.com:8443/p?page=2")).toBe(
      "https://example.com:8443/p?page=2",
    );
  });

  it("throws for a text that is not a URL", () => {
    expect(() => canonicalUrl("not a url")).toThrow(/Invalid URL/);
  });
});

describe("cacheKeyOf", () => {
  it("gives the canonical form of a URL, and keeps a text that is not a URL", () => {
    expect(cacheKeyOf("https://Example.com/a#x")).toBe("https://example.com/a");
    expect(cacheKeyOf("not a url")).toBe("not a url");
  });
});

describe("siteOf", () => {
  it("gives one site for a host with and without www. and a final dot", () => {
    expect(siteOf("WWW.Example.com.")).toBe("example.com");
    expect(siteOf("example.com")).toBe("example.com");
    expect(siteOf("shop.example.com")).toBe("shop.example.com");
  });
});

describe("scopeTest", () => {
  it("keeps the site of the start URLs and the allowed hosts", () => {
    const inScope = scopeTest([new URL("https://www.example.com/")], {
      allowHosts: ["*.cdn.example"],
    });
    expect(inScope(new URL("https://example.com/a"))).toBe(true);
    expect(inScope(new URL("https://img.cdn.example/a"))).toBe(true);
    expect(inScope(new URL("https://other.example/a"))).toBe(false);
    expect(inScope(new URL("ftp://example.com/a"))).toBe(false);
  });
});
