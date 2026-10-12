import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "./politeness.ts";

/**
 * These helpers are for the tests of the package. They are not part of the API.
 *
 * Windows keeps a file busy for a short time after a process closes it (a SQLite `-shm` file, an
 * antivirus scan). The function `removeDir` thus tries again, so a test does not leave its folder.
 */

/** This function makes an empty temporary folder with a prefix. */
export const tempDir = (prefix: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `polite-crawler-${prefix}-`));

/** This function removes a folder and its contents. It tries again when Windows says that a file is busy. */
export const removeDir = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/** This clock moves only when the crawler sleeps, so a test measures the pace and does not wait for it. */
export const fakeClock = (
  start: string = "2026-10-07T12:00:00Z",
): Clock & { readonly slept: number[]; advance: (ms: number) => void } => {
  let now = Date.parse(start);
  const slept: number[] = [];
  return {
    slept,
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
};
