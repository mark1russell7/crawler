import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import type { LocalSite, McpChild } from "./test-surfaces.ts";
import {
  PLAIN_PAGE,
  childEnv,
  localSite,
  removeDir,
  seedStore,
  startMcpChild,
  tempDir,
} from "./test-surfaces.ts";
import { VERSION } from "./version.ts";

const SLOW = 60_000;
let store: string;
let site: LocalSite;

beforeAll(async () => {
  store = await tempDir("stdio-store");
  await seedStore(store);
  site = await localSite((request, response) => {
    if (request.url === "/robots.txt") response.writeHead(404).end();
    else response.writeHead(200, { "content-type": "text/html" }).end(PLAIN_PAGE);
  });
}, SLOW);

afterAll(async () => {
  await site.close();
  await removeDir(store);
});

type Content = Array<{ type: string; text: string }>;
interface ToolResult {
  readonly content: Content;
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

/** This function starts the server and does the handshake. */
const start = async (
  args: readonly string[],
  env = childEnv(),
  capabilities: Record<string, unknown> = {},
  answer?: (method: string, params: unknown) => unknown,
): Promise<{ readonly server: McpChild; readonly initialized: Record<string, unknown> }> => {
  const server = startMcpChild(args, env, answer);
  // a test that fails stops its server too, so the server does not hold the store
  onTestFinished(() => server.stop());
  const initialized = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities,
    clientInfo: { name: "stdio-test", version: "0" },
  });
  server.notify("notifications/initialized");
  return { server, initialized };
};

const callTool = async (
  server: McpChild,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const message = await server.request("tools/call", { name, arguments: args });
  expect(message["error"], JSON.stringify(message["error"])).toBeUndefined();
  return message["result"] as ToolResult;
};

/** Each line of the standard output is one JSON-RPC 2.0 message. */
const expectOnlyJsonRpc = (server: McpChild): void => {
  expect(server.lines.length).toBeGreaterThan(0);
  for (const line of server.lines) {
    const message = JSON.parse(line) as Record<string, unknown>;
    expect(message["jsonrpc"]).toBe("2.0");
  }
};

describe("the MCP server over standard input and output", () => {
  it(
    "lists the tools, answers each one, writes only JSON-RPC, and stops when its input closes",
    async () => {
      const { server, initialized } = await start(["--dir", store, "--no-browser"]);
      const result = initialized["result"] as {
        serverInfo: { name: string; version: string };
        instructions?: string;
      };
      expect(result.serverInfo).toEqual({ name: "polite-crawler", version: VERSION });
      expect(result.instructions).toContain("untrusted-web-content");

      const listed = (await server.request("tools/list"))["result"] as {
        tools: Array<{
          name: string;
          annotations?: Record<string, boolean>;
          outputSchema?: unknown;
        }>;
      };
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "crawl_fetch",
        "crawl_find",
        "crawl_read",
        "crawl_verify",
      ]);
      expect(listed.tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);

      const found = await callTool(server, "crawl_find", { q: "bread" });
      expect(found.content[0]?.text).toContain('"doc":"url:https://bakery.example/"');
      expect(found.content[1]?.text).toContain("<untrusted-web-content id=");

      const read = await callTool(server, "crawl_read", {
        doc: "url:https://bakery.example/",
        length: 200,
      });
      expect(JSON.parse(read.content[0]!.text)).toMatchObject({ from: 0, to: 200, next_from: 200 });
      expect(read.content[1]?.text).toContain("title: Forno Esempio");
      expect(read.structuredContent?.["web_content"]).toBe(read.content[1]?.text);

      const verified = await callTool(server, "crawl_verify", {
        doc: "url:https://bakery.example/",
        quote: "wood-fired bread",
      });
      expect(JSON.parse(verified.content[0]!.text)).toMatchObject({ found: true });

      // the site is shared: a different test can ask it for a page before this test
      const before = site.hits.length;
      const fetched = await callTool(server, "crawl_fetch", {
        urls: ["mailto:someone@example.com", `${site.origin}/a`],
      });
      expect(fetched.isError).toBeUndefined();
      const pages = JSON.parse(fetched.content[0]!.text) as Array<{
        outcome: string;
        note: string;
      }>;
      expect(pages.map((page) => page.outcome)).toEqual(["error", "skipped"]);
      expect(pages[1]?.note).toContain("egress policy");
      expect(site.hits.slice(before)).toEqual([]);

      const unknown = await callTool(server, "crawl_read", { doc: "url:https://nowhere.example/" });
      expect(unknown.isError).toBe(true);
      expect(unknown.content[0]?.text).toContain("no stored document");

      const wrong = await server.request("tools/call", {
        name: "crawl_find",
        arguments: { q: "" },
      });
      expect(JSON.stringify(wrong)).toMatch(/error|isError/i);

      const { code, ms } = await server.end();
      expect(code).toBe(0);
      expect(ms).toBeLessThan(5000);
      expectOnlyJsonRpc(server);
      expect(server.stderr()).toContain(`MCP server on standard input and output, store ${store}`);
    },
    SLOW,
  );

  it(
    "keeps held-back text without a person, and releases it when the user confirms over elicitation",
    async () => {
      const plain = await start(["--dir", store, "--no-browser"]);
      const refused = await callTool(plain.server, "crawl_read", {
        doc: "url:https://members.example/",
        user_provided: true,
      });
      expect(JSON.parse(refused.content[0]!.text)).toMatchObject({ held_back: true });
      expect(JSON.stringify(refused)).not.toContain("7319");
      await plain.server.end();

      const asked: unknown[] = [];
      const confirming = await start(
        ["--dir", store, "--no-browser"],
        childEnv(),
        { elicitation: {} },
        (method, params) => {
          asked.push(params);
          expect(method).toBe("elicitation/create");
          return { action: "accept", content: { gave_url: true } };
        },
      );
      const released = await callTool(confirming.server, "crawl_read", {
        doc: "url:https://members.example/",
        user_provided: true,
      });
      expect(asked).toHaveLength(1);
      expect(released.content[1]?.text).toContain("The access code is 7319.");
      await confirming.server.end();
      expectOnlyJsonRpc(confirming.server);
    },
    SLOW,
  );

  it(
    "releases held-back text with the opt-in of the operator",
    async () => {
      const { server } = await start(
        ["--dir", store, "--no-browser"],
        childEnv({ POLITE_CRAWLER_ALLOW_USER_PROVIDED: "1" }),
      );
      const read = await callTool(server, "crawl_read", {
        doc: "url:https://members.example/",
        user_provided: true,
      });
      expect(read.content[1]?.text).toContain("The access code is 7319.");
      await server.end();
    },
    SLOW,
  );

  it(
    "turns rendering off at start when no browser is installed, and says so on the standard error",
    async () => {
      const browsers = await tempDir("no-browsers");
      // the hooks of the end of a test run in the reverse order: the server stops first, then the folder goes
      onTestFinished(() => removeDir(browsers));
      const { server } = await start(
        ["--dir", store],
        childEnv({ PLAYWRIGHT_BROWSERS_PATH: browsers }),
      );
      await server.request("tools/list");
      await server.end();
      expect(server.stderr()).toContain(
        "polite-crawler: rendering is off: rendering needs a browser",
      );
      expectOnlyJsonRpc(server);
    },
    SLOW,
  );

  it(
    "fetches a private address when POLITE_CRAWLER_ALLOW_PRIVATE is 1",
    async () => {
      const dir = await tempDir("stdio-private");
      onTestFinished(() => removeDir(dir));
      const { server } = await start(
        ["--dir", dir, "--no-browser"],
        childEnv({ POLITE_CRAWLER_ALLOW_PRIVATE: "1" }),
      );
      const fetched = await callTool(server, "crawl_fetch", { urls: [`${site.origin}/b`] });
      expect(JSON.parse(fetched.content[0]!.text)).toEqual([
        expect.objectContaining({ outcome: "ok" }),
      ]);
      await server.end();
    },
    SLOW,
  );
});
