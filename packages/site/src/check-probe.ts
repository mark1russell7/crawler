/**
 * The probe of the home page. The site check of the Pages workflow starts it in a browser at each width, before the
 * deploy. A failed check stops the deploy.
 *
 * The probe drives the live crawl of the hero. A polite crawl sends one request at a time to a site. The store answers
 * the second crawl. An impolite crawl sends many requests at once and gets refusals.
 *
 * The site check reads this TypeScript file directly. It removes the types and the `export` line, and it starts the
 * result as the body of an async function.
 */

// The site check gives these helpers to the probe.
declare const check: (name: string, ok: unknown, detail?: unknown) => boolean;
declare const until: <T>(fn: () => T | Promise<T>, ms?: number) => Promise<T>;
declare const $: (selector: string) => Element | null;
declare const $$: (selector: string) => Element[];
declare const click: (target: string | Element) => void;

/** The crawl takes 13 seconds at its speed of 2, so a slow runner gets twice that time. */
const CRAWL_MS = 30000;

const verdict = (): string => $(".pc-crawl-verdict")?.textContent ?? "";
/** This function gives one statistic, by its place on the page: requests, stored, peak, time. */
const stat = (index: number): number => Number($$(".pc-stats dd")[index]?.textContent ?? "");
const button = (name: string): HTMLButtonElement | undefined =>
  $$(".pc-crawl button").find((el) => el.textContent?.trim() === name) as
    HTMLButtonElement | undefined;

check("the home page has the live crawl", await until(() => $(".pc-crawl") !== null), "no crawl");
// The island starts when it comes into view.
$(".pc-crawl")?.scrollIntoView();
check(
  "the page shows a lane for each of the eight sites",
  await until(() => $$(".pc-lane").length === 8),
  $$(".pc-lane").length,
);

check(
  "the polite crawl ends",
  await until(() => verdict().includes("Select Ask again"), CRAWL_MS),
  verdict(),
);
check("the polite crawl sent requests", stat(0) > 0, $(".pc-stats")?.textContent);
check(
  "the polite crawl sent one request at a time to a site",
  stat(2) === 1,
  $(".pc-stats")?.textContent,
);

const again = button("Ask again");
check(
  "Ask again is ready after the crawl",
  again !== undefined && !again.disabled,
  again?.outerHTML,
);
if (again !== undefined) click(again);
check(
  "the second crawl comes from the store",
  await until(() => /The second time, [1-9]\d* answers came from the store/.test(verdict())),
  verdict(),
);
check(
  "the statistics count the stored answers",
  await until(() => stat(1) > 0),
  $(".pc-stats")?.textContent,
);

const impolite = button("Impolite");
if (impolite !== undefined) click(impolite);
check(
  "Impolite starts a new crawl",
  await until(() => button("Impolite")?.getAttribute("aria-pressed") === "true"),
  button("Impolite")?.outerHTML,
);
check(
  "the impolite crawl ends with refusals",
  await until(() => /got [1-9]\d* refusals/.test(verdict()), CRAWL_MS),
  verdict(),
);
check(
  "the impolite crawl sent more than one request at once to a site",
  stat(2) > 1,
  $(".pc-stats")?.textContent,
);

export {};
