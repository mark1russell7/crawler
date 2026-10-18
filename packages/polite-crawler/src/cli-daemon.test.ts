import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { daemonCommand } from "./cli-daemon.ts";
import type { DaemonLine } from "./cli-line.ts";
import { UsageError, describeDaemonStatus, readLine } from "./cli-line.ts";
import type { DaemonState } from "./daemon.ts";
import { readDaemonState } from "./daemon.ts";
import { CLI, TSX, childEnv, removeDir, runCli, tempDir } from "./test-surfaces.ts";

const SLOW = 60_000;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const store = async (): Promise<string> => {
  const dir = await tempDir("cli-daemon");
  cleanups.push(() => removeDir(dir));
  return dir;
};

const daemonLine = (args: readonly string[], env: Record<string, string> = {}): DaemonLine => {
  const line = readLine(args, env);
  if (line.kind !== "command" || line.daemonLine === undefined)
    throw new Error("not a daemon line");
  return line.daemonLine;
};

const STATE: DaemonState = {
  schema: 1,
  version: "0.1.2",
  pid: 4242,
  store: "/stores/one",
  running: true,
  alive: true,
  started_at: "2026-10-07T12:00:00.000Z",
  updated_at: "2026-10-07T13:00:00.000Z",
  stopped_at: null,
  tick_ms: 60_000,
  jitter_ms: 10_000,
  budget_ms: 600_000,
  max_pages: 100,
  ticks: 61,
  checked: 3,
  changes: 1,
  last_tick: {
    started_at: "2026-10-07T13:00:00.000Z",
    ended_at: "2026-10-07T13:00:02.000Z",
    summary: {
      checked: 3,
      new: 0,
      changed: 1,
      unchanged: 2,
      gone: 0,
      refused: 0,
      error: 0,
      suspected: 0,
      confirmed: 1,
      due: 0,
      stopped: "done",
      reason: "the run checked each entry that was due",
      elapsed_ms: 2000,
    },
    error: null,
    next_at: "2026-10-07T13:01:02.000Z",
    due: [],
  },
  next_tick_at: "2026-10-07T13:01:02.000Z",
  next_due: [
    {
      url: "https://example.com/hours",
      next_at: "2026-10-07T18:00:00.000Z",
      every_ms: 21_600_000,
      last_kind: "changed",
    },
  ],
  tasks: [
    {
      id: "4f3a",
      tool: "crawl_site",
      status: "working",
      message: "3 of 10 done",
      created_at: "2026-10-07T12:59:00.000Z",
      updated_at: "2026-10-07T13:00:00.000Z",
    },
  ],
  mcp: { url: "http://127.0.0.1:9307/mcp", token_file: "/stores/one/daemon/mcp-token" },
  last_error: { at: "2026-10-07T12:30:00.000Z", message: "the on-change hook: exited with code 1" },
};

describe("the command line of the daemon", () => {
  it("reads the options of daemon, with the defaults left to the daemon", () => {
    expect(daemonLine(["daemon"])).toEqual({
      action: "run",
      tickMs: undefined,
      jitterMs: undefined,
      budgetMs: undefined,
      maxPages: undefined,
      graceMs: undefined,
      events: undefined,
      onChange: undefined,
      mcp: undefined,
    });
    const line = daemonLine([
      "daemon",
      "--tick",
      "30s",
      "--jitter",
      "0",
      "--tick-budget",
      "2m",
      "--tick-pages",
      "5",
      "--grace",
      "1s",
      "--events",
      "~/changes.jsonl",
      "--on-change",
      "jq . >> seen.jsonl",
      "--mcp-http",
      "--mcp-port",
      "0",
      "--mcp-token-file",
      "token",
    ]);
    expect(line).toMatchObject({
      tickMs: 30_000,
      jitterMs: 0,
      budgetMs: 120_000,
      maxPages: 5,
      graceMs: 1000,
      events: join(homedir(), "changes.jsonl"),
      onChange: "jq . >> seen.jsonl",
      mcp: { port: 0, host: "127.0.0.1", allowRemote: false },
    });
    expect(line.mcp?.tokenFile).toMatch(/token$/);
    expect(daemonLine(["daemon", "--mcp-http"]).mcp).toEqual({
      port: 9307,
      host: "127.0.0.1",
      allowRemote: false,
      tokenFile: undefined,
    });
    const remote = daemonLine(["daemon", "--mcp-http", "--mcp-host", "0.0.0.0", "--allow-remote"]);
    expect(remote.mcp).toMatchObject({ host: "0.0.0.0", allowRemote: true });
    expect(daemonLine(["daemon", "status"]).action).toBe("status");
  });

  it("gives a usage error for a wrong daemon line", () => {
    const wrong: Array<[readonly string[], RegExp]> = [
      [["daemon", "start"], /daemon takes no argument, or status/],
      [["daemon", "status", "now"], /daemon takes no argument, or status/],
      [["daemon", "status", "--tick", "1m"], /--tick is an option of daemon, not of daemon status/],
      [["daemon", "status", "--allow-user-provided"], /not of daemon status/],
      [["daemon", "--mcp-port", "1"], /--mcp-port goes with --mcp-http/],
      [["daemon", "--allow-remote"], /--allow-remote goes with --mcp-http/],
      [
        ["daemon", "--mcp-http", "--mcp-host", "0.0.0.0"],
        /not a loopback address: add --allow-remote/,
      ],
      [["daemon", "--mcp-http", "--mcp-host", " "], /--mcp-host wants a host/],
      [["daemon", "--mcp-http", "--mcp-port", "70000"], /from 0 to 65535/],
      [["daemon", "--mcp-http", "--mcp-port", "web"], /whole number/],
      [["daemon", "--tick", "10ms"], /--tick wants 1s or more/],
      [["daemon", "--tick", "soon"], /--tick: not a duration/],
      [["daemon", "--tick-budget", "0"], /--tick-budget wants 1s or more/],
      [["daemon", "--tick-pages", "0"], /--tick-pages wants 1 or more/],
      [["daemon", "--on-change", " "], /--on-change wants a command/],
      [["daemon", "--events", ""], /--events wants a file/],
      [["daemon", "--mcp-http", "--mcp-token-file", ""], /--mcp-token-file wants a file/],
      [["watch", "run", "--tick", "1m"], /--tick is an option of daemon/],
      [["fetch", "https://example.com/", "--mcp-http"], /--mcp-http is an option of daemon/],
    ];
    for (const [args, message] of wrong) {
      expect(() => readLine(args, {}), args.join(" ")).toThrow(UsageError);
      expect(() => readLine(args, {}), args.join(" ")).toThrow(message);
    }
  });

  it("reads the opt-in of user_provided and the signing key for daemon, and not for daemon status", () => {
    const env = {
      POLITE_CRAWLER_ALLOW_USER_PROVIDED: "1",
      POLITE_CRAWLER_SIGN_KEY: "key.pem",
      POLITE_CRAWLER_SIGNATURE_AGENT: "https://example.com",
    };
    const run = readLine(["daemon"], env);
    const status = readLine(["daemon", "status"], env);
    expect(run).toMatchObject({ allowUserProvided: true, signKey: "key.pem" });
    expect(status).toMatchObject({ allowUserProvided: false, signKey: undefined });
  });

  it("describes the status: no daemon, a daemon that runs, one that stopped, and one that ended with no clean stop", () => {
    expect(describeDaemonStatus(undefined, "/stores/none")).toBe(
      "no daemon has run on the store /stores/none",
    );
    const text = describeDaemonStatus(STATE, "/stores/one");
    expect(text.split("\n")).toEqual([
      "the daemon runs (process 4242) since 2026-10-07T12:00:00.000Z, on the store /stores/one",
      "last tick: 2026-10-07T13:00:02.000Z, 3 checked, 1 changes, 0 refused, 0 errors (done)",
      "next tick: 2026-10-07T13:01:02.000Z",
      "61 ticks, 3 checks, 1 changes",
      "next due:",
      "  2026-10-07T18:00:00.000Z  https://example.com/hours  (every 6h, last changed)",
      "MCP: http://127.0.0.1:9307/mcp (the token is in /stores/one/daemon/mcp-token)",
      "tasks: 1 running",
      "  4f3a  crawl_site  working: 3 of 10 done",
      "last error: 2026-10-07T12:30:00.000Z: the on-change hook: exited with code 1",
    ]);
    const stopped = describeDaemonStatus(
      {
        ...STATE,
        running: false,
        alive: false,
        stopped_at: "2026-10-07T14:00:00.000Z",
        last_tick: null,
        next_due: [],
        tasks: [],
        last_error: null,
      },
      "/stores/one",
    );
    expect(stopped).toContain("the daemon stopped at 2026-10-07T14:00:00.000Z");
    expect(stopped).toContain("last tick: none yet");
    expect(stopped).toContain("next due: no watch");
    expect(stopped).toContain("tasks: none running");
    expect(stopped).toContain("last error: none");
    expect(stopped).not.toContain("next tick");
    const crashed = describeDaemonStatus(
      {
        ...STATE,
        alive: false,
        mcp: null,
        last_tick: { ...STATE.last_tick!, summary: null, error: "the store is closed" },
      },
      "/stores/one",
    );
    expect(crashed).toContain("does not run: it stopped with no clean stop");
    expect(crashed).toContain("failed: the store is closed");
    expect(crashed).not.toContain("MCP:");
  });

  it("gives 0 for daemon status when a daemon runs, and 1 when none runs", async () => {
    const dir = await store();
    const printed: string[] = [];
    const io = { allowUserProvided: false, json: false, out: (text: string) => printed.push(text) };
    const status: DaemonLine = { ...daemonLine(["daemon", "status"]) };
    expect(await daemonCommand(status, { dir }, io)).toBe(1);
    expect(printed).toEqual([`no daemon has run on the store ${dir}`]);
    // the parent of this process is alive: the state says that a daemon of it runs
    mkdirSync(join(dir, "daemon"));
    writeFileSync(
      join(dir, "daemon", "state.json"),
      JSON.stringify({ ...STATE, store: dir, pid: process.ppid }),
    );
    expect(await daemonCommand(status, { dir }, { ...io, json: true })).toBe(0);
    expect(JSON.parse(printed.at(-1)!)).toMatchObject({ alive: true, pid: process.ppid });
  });
});

describe("the command daemon, in a process of its own", () => {
  it(
    "exits with 1 for daemon status when no daemon runs, and with 2 for a wrong line, with no store",
    async () => {
      const dir = await store();
      const none = await runCli(["daemon", "status", "--dir", dir]);
      expect(none).toMatchObject({ code: 1, stdout: `no daemon has run on the store ${dir}\n` });
      const never = join(dir, "never");
      const remote = await runCli([
        "daemon",
        "--mcp-http",
        "--mcp-host",
        "0.0.0.0",
        "--dir",
        never,
      ]);
      expect(remote.code).toBe(2);
      expect(remote.stderr).toMatch(/not a loopback address: add --allow-remote/);
      expect((await runCli(["daemon", "--tick", "0", "--dir", never])).code).toBe(2);
      expect(existsSync(never)).toBe(false);
      const help = await runCli(["--help"]);
      expect(help.stdout).toContain("polite-crawler daemon status");
    },
    SLOW,
  );

  it.skipIf(process.platform === "win32")(
    "runs until SIGTERM, shows its state and its MCP endpoint, and stops cleanly with code 0",
    async () => {
      const dir = await store();
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
        { env: childEnv() },
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
      expect(running.stdout).toMatch(/^the daemon runs \(process \d+\)/);
      expect(running.stdout).toMatch(/MCP: http:\/\/127\.0\.0\.1:\d+\/mcp \(the token is in /);
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect(stderr).toContain("the daemon stopped");
      const stopped = await runCli(["daemon", "status", "--dir", dir, "--json"]);
      expect(stopped.code).toBe(1);
      expect(JSON.parse(stopped.stdout)).toMatchObject({ running: false, alive: false });
    },
    SLOW,
  );
});
