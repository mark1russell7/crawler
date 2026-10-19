import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
// the transport of the SDK leaves its optional members undefined, which exactOptionalPropertyTypes refuses
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Daemon, DaemonOptions } from "polite-crawler";
import { readDaemonState, startDaemon } from "polite-crawler";
import { afterEach, describe, expect, it } from "vitest";
import { removeDir, tempDir } from "../../polite-crawler/src/test-helpers.ts";
import {
  CLI,
  TSX,
  besidePoliteCrawler,
  childEnv,
  runCli,
} from "../../polite-crawler/src/test-surfaces.ts";
import { mcpHttpHost } from "./http.ts";

// The daemon of polite-crawler serves the tools of this package over HTTP. polite-crawler tests the
// daemon itself.

const SLOW = 60_000;
/** This folder holds this package, so the daemon finds polite-crawler-mcp from it. */
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const store = async (): Promise<string> => {
  const dir = await tempDir("daemon-mcp");
  cleanups.push(() => removeDir(dir));
  return dir;
};

const options = (dir: string, extra: Partial<DaemonOptions> = {}): DaemonOptions => ({
  dir,
  renderer: false,
  egress: { allowPrivate: true },
  random: () => 0,
  signals: false,
  events: false,
  log: () => undefined,
  ...extra,
});

const started = async (given: DaemonOptions): Promise<Daemon> => {
  const daemon = await startDaemon(given);
  cleanups.push(async () => {
    await daemon.stop(0);
  });
  return daemon;
};

describe("the MCP server of the daemon", () => {
  it("serves the MCP tools over HTTP, and its status route gives the status of the daemon", async () => {
    const dir = await store();
    const daemon = await started(
      options(dir, { tick: "1h", mcp: { port: 0 }, mcpHost: mcpHttpHost }),
    );
    const token = readFileSync(join(dir, "daemon", "mcp-token"), "utf8").trim();
    const url = daemon.mcp!.url;
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport as unknown as Transport);
    expect((await client.listTools()).tools).toHaveLength(9);
    const status = await fetch(url.replace(/\/mcp$/, "/status"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await status.json()) as unknown).toMatchObject({ running: true, mcp: { url } });
    await client.close();
    await daemon.stop();
    await expect(fetch(url)).rejects.toThrow(/fetch failed/);
  });

  it.skipIf(process.platform === "win32")(
    "runs polite-crawler daemon --mcp-http with this package, shows its MCP endpoint, and stops cleanly",
    async () => {
      const dir = await store();
      // the daemon finds polite-crawler-mcp next to polite-crawler: NODE_PATH names the folder of the packages
      const child = spawn(
        process.execPath,
        [
          "--import",
          TSX,
          CLI,
          "daemon",
          "--dir",
          dir,
          "--tick",
          "1h",
          "--no-browser",
          "--mcp-http",
          "--mcp-port",
          "0",
        ],
        { env: besidePoliteCrawler(), cwd: PACKAGE },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
      cleanups.push(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      const end = Date.now() + 30_000;
      while (readDaemonState(dir)?.last_tick === null || readDaemonState(dir) === undefined) {
        if (Date.now() > end) throw new Error(`the daemon did not start: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const running = await runCli(["daemon", "status", "--dir", dir]);
      expect(running.code).toBe(0);
      expect(running.stdout).toMatch(/MCP: http:\/\/127\.0\.0\.1:\d+\/mcp \(the token is in /);
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect(stderr).toContain("the daemon stopped");
    },
    SLOW,
  );
});
