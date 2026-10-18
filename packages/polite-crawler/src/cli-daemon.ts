/*
 * The command `daemon` of the command line: `daemon` runs the daemon until `SIGINT` or `SIGTERM`, and
 * `daemon status` prints the state file. `cli.ts` loads this file only for the command `daemon`.
 */
import type { DaemonLine } from "./cli-line.ts";
import { describeDaemonStatus } from "./cli-line.ts";
import type { OpenOptions } from "./open.ts";

/** These are the parts of the command line that the command `daemon` uses. */
export interface DaemonIo {
  /** The value true lets `user_provided` work when the MCP client cannot ask the user. */
  readonly allowUserProvided: boolean;
  /** The value true prints the status as JSON. */
  readonly json: boolean;
  /** This function prints a line on the standard output. */
  readonly out: (text: string) => void;
}

/**
 * This function does the command `daemon`, and gives the exit code. `daemon status` gives 0 when a
 * daemon operates on the store, and 1 when none operates. `daemon` gives 0 after a clean stop. An
 * error at start rejects, so the command exits with 1.
 */
export const daemonCommand = async (
  line: DaemonLine,
  options: OpenOptions,
  io: DaemonIo,
): Promise<number> => {
  const { changeCommand, readDaemonState, startDaemon } = await import("./daemon.ts");
  if (line.action === "status") {
    const state = readDaemonState(options.dir);
    io.out(
      io.json ? JSON.stringify(state ?? null, null, 2) : describeDaemonStatus(state, options.dir),
    );
    return state?.alive === true ? 0 : 1;
  }
  const daemon = await startDaemon({
    ...options,
    tick: line.tickMs,
    jitter: line.jitterMs,
    budget: line.budgetMs,
    maxPages: line.maxPages,
    grace: line.graceMs,
    events: line.events,
    onChange: line.onChange === undefined ? undefined : changeCommand(line.onChange),
    mcp:
      line.mcp === undefined
        ? undefined
        : {
            port: line.mcp.port,
            host: line.mcp.host,
            allowRemote: line.mcp.allowRemote,
            tokenFile: line.mcp.tokenFile,
            allowUserProvided: io.allowUserProvided,
          },
    signals: true,
  });
  await daemon.done;
  return 0;
};
