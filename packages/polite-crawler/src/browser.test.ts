import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_BROWSER, browserMissing } from "./browser.ts";
import { NO_PLAYWRIGHT } from "./render.ts";
import { removeDir, tempDir } from "./test-surfaces.ts";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await removeDir(dir);
  dir = undefined;
});

const chromiumAt = (executable: string) => () =>
  Promise.resolve({ chromium: { executablePath: () => executable } });

describe("browserMissing", () => {
  it("names playwright-core when the package does not load", async () => {
    expect(await browserMissing(() => Promise.reject(new Error("Cannot find package")))).toBe(
      NO_PLAYWRIGHT,
    );
  });

  it("gives no reason when the full browser is on the disk", async () => {
    dir = await tempDir("browser");
    const executable = join(dir, "chromium-1248", "chrome-linux", "chrome");
    await mkdir(join(dir, "chromium-1248", "chrome-linux"), { recursive: true });
    await writeFile(executable, "");
    expect(await browserMissing(chromiumAt(executable))).toBeUndefined();
  });

  it("gives no reason when only the headless shell of the same revision is on the disk", async () => {
    dir = await tempDir("browser");
    await mkdir(join(dir, "chromium_headless_shell-1248", "chrome-headless-shell-linux64"), {
      recursive: true,
    });
    const executable = join(
      dir,
      "chromium-1248",
      "chrome-mac",
      "Chromium.app",
      "Contents",
      "MacOS",
      "Chromium",
    );
    expect(await browserMissing(chromiumAt(executable))).toBeUndefined();
  });

  it("names the install command when no browser is on the disk", async () => {
    dir = await tempDir("browser");
    expect(
      await browserMissing(chromiumAt(join(dir, "chromium-1248", "chrome-linux", "chrome"))),
    ).toBe(NO_BROWSER);
  });

  it("gives no reason when it cannot find the answer", async () => {
    expect(await browserMissing(chromiumAt("/opt/custom/chrome"))).toBeUndefined();
    const throwing = () =>
      Promise.resolve({
        chromium: {
          executablePath: (): string => {
            throw new Error("no");
          },
        },
      });
    expect(await browserMissing(throwing)).toBeUndefined();
  });
});
