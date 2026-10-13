import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Renderer } from "./render.ts";
import { NO_PLAYWRIGHT, RenderRefused } from "./render.ts";

/** The text of the note when `playwright-core` is installed, but its browser is not. */
export const NO_BROWSER =
  "rendering needs a browser: npx playwright-core install chromium-headless-shell";

/** This is the part of `playwright-core` that the check uses. */
interface Chromium {
  executablePath(): string;
}

/**
 * This function tells if the default renderer can start a browser. It gives no value when it can,
 * and the reason when it cannot. The command line and the MCP server use it one time at start.
 * Then a missing browser costs no wait and no error capture for each page that needs JavaScript.
 *
 * The check does not start the browser. It finds the full Chromium build or the headless shell of
 * the same revision on the disk. When the check cannot find the answer, it gives no value, and the
 * renderer then tries.
 */
export const browserMissing = async (
  load: () => Promise<{ readonly chromium: Chromium }> = () => import("playwright-core"),
): Promise<string | undefined> => {
  let chromium: Chromium;
  try {
    ({ chromium } = await load());
  } catch {
    return NO_PLAYWRIGHT;
  }
  try {
    const executable = chromium.executablePath();
    if (existsSync(executable)) return undefined;
    // the headless shell is in a folder next to the folder of the full build, with the same revision
    let folder = dirname(executable);
    while (dirname(folder) !== folder && !/^chromium-\d+$/.test(basename(folder)))
      folder = dirname(folder);
    const revision = /^chromium-(\d+)$/.exec(basename(folder))?.[1];
    if (revision === undefined) return undefined;
    return existsSync(join(dirname(folder), `chromium_headless_shell-${revision}`))
      ? undefined
      : NO_BROWSER;
  } catch {
    return undefined;
  }
};

/**
 * This function gives a renderer that checks one time, before its first page, that the browser is
 * on the disk (`browserMissing`). With no browser, each page gets a `RenderRefused` with the reason
 * `browser` at once, and the renderer opens nothing. `createRuntime` puts its default renderer in
 * it, so a library with no browser costs no wait and no error capture.
 */
export const checkedRenderer = (
  renderer: Renderer,
  check: () => Promise<string | undefined> = () => browserMissing(),
): Renderer => {
  let missing: Promise<string | undefined> | undefined;
  return {
    async render(url, options) {
      missing ??= check().catch(() => undefined);
      const reason = await missing;
      if (reason !== undefined) throw new RenderRefused("browser", reason);
      return renderer.render(url, options);
    },
    close: () => renderer.close(),
  };
};
