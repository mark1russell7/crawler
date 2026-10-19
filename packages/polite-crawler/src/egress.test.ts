import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { FileBlobStore } from "./blobs.ts";
import type { CrawlerOptions } from "./crawler.ts";
import { Crawler } from "./crawler.ts";
import { DocIndex } from "./docs.ts";
import type { EgressResolve } from "./egress.ts";
import {
  addressKind,
  checkEgress,
  egressLookup,
  egressRefusal,
  parseIPv4,
  parseIPv6,
} from "./egress.ts";
import { CaptureLog } from "./log.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const serve = async () => {
  const paths: string[] = [];
  const server: Server = createServer((request, response) => {
    paths.push(request.url ?? "");
    if (request.url === "/to-loopback") {
      response.writeHead(302, { location: `http://127.0.0.2:${String(port)}/admin` });
      response.end();
      return;
    }
    if (request.url === "/to-localhost") {
      response.writeHead(302, { location: `http://localhost:${String(port)}/admin` });
      response.end();
      return;
    }
    response.end("INTERNAL-ONLY db_password=hunter2");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port, paths };
};

const make = async (options: Partial<CrawlerOptions> = {}) => {
  const dir = await mkdtemp(join(tmpdir(), "polite-crawler-egress-"));
  const log = new CaptureLog(join(dir, "crawl"));
  const index = new DocIndex(":memory:");
  const crawler = new Crawler({
    token: "PoliteCrawler",
    userAgent: "PoliteCrawler/0.1 (test)",
    log,
    blobs: new FileBlobStore(join(dir, "blobs")),
    index,
    clock: { now: () => Date.now(), sleep: () => Promise.resolve() },
    ...options,
  });
  cleanups.push(async () => {
    await crawler.close();
    index.close();
    await rm(dir, { recursive: true, force: true });
  });
  return crawler;
};

const LOOPBACK = "egress policy: 127.0.0.1 is a loopback address; set allowPrivate to fetch it";

describe("the kinds of address", () => {
  it("reads each spelling of an IPv4 address the way the URL parser does", () => {
    expect(parseIPv4("2130706433")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4("0x7f.1")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4("0177.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4("127.1")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4("example.com")).toBeUndefined();
    expect(parseIPv4("256.0.0.1")).toBeUndefined();
    expect(parseIPv6("[::ffff:127.0.0.1]")).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 127, 0, 0, 1,
    ]);
  });

  it("names each range that is not public, and nothing for a public address", () => {
    const kinds: Record<string, string | undefined> = {
      "127.0.0.1": "loopback",
      "10.1.2.3": "private",
      "172.16.0.1": "private",
      "172.32.0.1": undefined,
      "192.168.1.1": "private",
      "169.254.169.254": "metadata",
      "169.254.1.1": "link-local",
      "100.64.0.1": "carrier-grade NAT",
      "100.100.100.200": "metadata",
      "0.0.0.0": "unspecified",
      "224.0.0.1": "multicast",
      "255.255.255.255": "reserved",
      "8.8.8.8": undefined,
      "93.184.215.14": undefined,
      "::1": "loopback",
      "::": "unspecified",
      "fe80::1%eth0": "link-local",
      "fd00::1": "unique local",
      "fd00:ec2::254": "metadata",
      "::ffff:127.0.0.1": "loopback",
      "::ffff:7f00:1": "loopback",
      "::ffff:8.8.8.8": undefined,
      "64:ff9b::10.0.0.1": "private",
      "2002:7f00:1::": "loopback",
      "::127.0.0.1": "loopback",
      "2606:4700::1111": undefined,
      "2001:db8::1": "documentation",
    };
    for (const [address, kind] of Object.entries(kinds))
      expect(addressKind(address), address).toBe(kind);
  });

  it("refuses a literal host before DNS, and permits the hosts of allowHosts", () => {
    for (const host of [
      "127.0.0.1",
      "2130706433",
      "0x7f.1",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "localhost",
      "a.localhost",
      "metadata.google.internal",
    ]) {
      expect(egressRefusal({}, host), host).toMatch(/^egress policy: /);
    }
    expect(egressRefusal({}, "2130706433")).toBe(LOOPBACK);
    expect(egressRefusal({}, "example.com")).toBeUndefined();
    expect(egressRefusal({ allowPrivate: true }, "127.0.0.1")).toBeUndefined();
    expect(egressRefusal({ allowHosts: ["127.0.0.0/8"] }, "127.0.0.2")).toBeUndefined();
    expect(egressRefusal({ allowHosts: ["localhost"] }, "localhost")).toBeUndefined();
    expect(egressRefusal({ allowHosts: ["10.0.0.0/8"] }, "127.0.0.1")).toBe(LOOPBACK);
  });

  it("examines the addresses that DNS gives, for a client that does its own DNS", async () => {
    const resolve =
      (address: string): EgressResolve =>
      (_host, _options, callback) =>
        callback(null, [{ address, family: address.includes(":") ? 6 : 4 }]);
    const url = new URL("http://rebind.example/");
    expect(await checkEgress({}, url, resolve("10.0.0.5"))).toBe(
      "egress policy: 10.0.0.5 is a private address; set allowPrivate to fetch it",
    );
    expect(await checkEgress({}, url, resolve("93.184.215.14"))).toBeUndefined();
    expect(
      await checkEgress({ allowHosts: ["rebind.example"] }, url, resolve("10.0.0.5")),
    ).toBeUndefined();
    const fails: EgressResolve = (_host, _options, callback) =>
      callback(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []);
    expect(await checkEgress({}, url, fails)).toBeUndefined();
  });
});

describe("the egress policy of the crawler", () => {
  it("refuses loopback in each spelling by default, with a note and no request", async () => {
    const site = await serve();
    const crawler = await make();
    for (const host of ["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "2130706433", "0x7f.1"]) {
      const fetched = await crawler.fetch({
        url: `http://${host}:${String(site.port)}/admin`,
        mode: "page",
        recipe: "page",
      });
      expect(fetched.outcome, host).toBe("skipped");
      expect(fetched.note, host).toMatch(
        /^egress policy: .* address; set allowPrivate to fetch it$/,
      );
    }
    expect(
      await crawler.fetch({
        url: "http://169.254.169.254/latest/meta-data/",
        mode: "api",
        recipe: "t",
      }),
    ).toMatchObject({
      outcome: "skipped",
      note: "egress policy: 169.254.169.254 is a metadata address; set allowPrivate to fetch it",
    });
    expect(site.paths).toEqual([]);
  });

  it("checks each redirect hop again", async () => {
    const site = await serve();
    const crawler = await make({ egress: { allowHosts: ["127.0.0.1"] } });
    const loopback = await crawler.fetch({
      url: `http://127.0.0.1:${String(site.port)}/to-loopback`,
      mode: "api",
      recipe: "t",
    });
    expect(loopback).toMatchObject({
      outcome: "skipped",
      note: "egress policy: 127.0.0.2 is a loopback address; set allowPrivate to fetch it",
    });
    const named = await crawler.fetch({
      url: `http://127.0.0.1:${String(site.port)}/to-localhost`,
      mode: "api",
      recipe: "t",
    });
    expect(named).toMatchObject({
      outcome: "skipped",
      note: "egress policy: localhost is a loopback address; set allowPrivate to fetch it",
    });
    expect(site.paths).toEqual(["/to-loopback", "/to-localhost"]);
  });

  it("checks the address after DNS in the connection, so the address that it checks is the address that it uses", async () => {
    const site = await serve();
    const toLoopback: EgressResolve = (_host, _options, callback) =>
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    const guarded = new Agent({ connect: { lookup: egressLookup({}, toLoopback) } });
    const permitted = new Agent({
      connect: { lookup: egressLookup({ allowHosts: ["127.0.0.0/8"] }, toLoopback) },
    });
    cleanups.push(async () => {
      await guarded.close();
      await permitted.close();
    });
    const refused = await (
      await make({ dispatcher: guarded })
    ).fetch({
      url: `http://rebind.example:${String(site.port)}/admin`,
      mode: "api",
      recipe: "t",
    });
    expect(refused).toMatchObject({ outcome: "skipped", note: LOOPBACK });
    const fetched = await (
      await make({ dispatcher: permitted })
    ).fetch({
      url: `http://rebind.example:${String(site.port)}/admin`,
      mode: "api",
      recipe: "t",
    });
    expect(fetched.outcome).toBe("ok");
    expect(site.paths).toEqual(["/admin"]);
  });
});
