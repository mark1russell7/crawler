// The data of the page "Tokens to prove a claim" (src/data/eval-a.json). The functions read the result
// of one run of eval part A (eval-result.json, in the artifact `eval` of the workflow eval.yml) and the
// question set (packages/polite-crawler/eval/claims.json), and they give only what the page shows.
//
// The build of the site takes the newest green run of eval.yml on main that has the artifact `eval`
// (scripts/eval-latest.ts). To write the data of one run by hand:
//
//   gh run download <run id> -R mark1russell7/crawler -n eval -D <dir>
//   node packages/site/scripts/eval-data.ts --result <dir>/eval-result.json --run <run id> --started <ISO time>
//
// The functions fail when a claim is not verified, when a claim is not in the question set, or when a
// page has no short name in NAMES below.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Count {
  readonly chars: number;
  readonly tokens: number;
}

interface ResultClaim {
  readonly id: string;
  readonly source: string;
  readonly url: string;
  readonly find_rank: number | null;
  readonly read_window: string;
  readonly polite: {
    readonly fetch: Count;
    readonly find: Count;
    readonly read: Count;
    readonly verify: Count;
    readonly total: Count;
  };
  readonly paged: Count & { readonly reads: number };
  readonly webfetch: { readonly markdown: Count; readonly text: Count };
  readonly verified: boolean;
}

interface Totals {
  readonly median: Count;
  readonly total: Count;
}

export interface Result {
  readonly package: string;
  readonly commit: string;
  readonly tokenizer: string;
  readonly window: number;
  readonly tool_definitions: Count;
  readonly archive: { readonly start: string; readonly sha256: string };
  readonly claims: readonly ResultClaim[];
  readonly summary: {
    readonly claims: number;
    readonly verified: number;
    readonly past_cut: number;
    readonly polite: Totals;
    readonly paged: Totals;
    readonly markdown: Totals;
    readonly text: Totals;
    readonly ratio: {
      readonly markdown_total: number;
      readonly markdown_median: number;
      readonly text_total: number;
    };
  };
}

const claimsFile = fileURLToPath(new URL("../../polite-crawler/eval/claims.json", import.meta.url));
const questionSet = JSON.parse(readFileSync(claimsFile, "utf8")) as {
  readonly claims: ReadonlyArray<{ readonly id: string; readonly question: string }>;
};
const questions = new Map(questionSet.claims.map((claim) => [claim.id, claim.question]));

/** The short names of the pages that the rules of `nameOf` do not give. */
const NAMES: Record<string, string> = {
  "https://www.archives.gov/founding-docs/declaration-transcript": "Declaration of Independence",
  "https://www.archives.gov/founding-docs/constitution-transcript": "US Constitution",
  "https://www.legislation.gov.uk/ukpga/2018/12/section/1": "Data Protection Act 2018",
  "https://www.legislation.gov.uk/ukpga/1998/42/schedule/1": "Human Rights Act 1998",
  "https://www.w3.org/TR/WCAG21/": "WCAG 2.1",
  "https://peps.python.org/pep-0020/": "PEP 20",
};

/** This function gives the short name of a page, for example "RFC 9110" or "MDN: Array.map". */
const nameOf = (url: string): string => {
  const named = NAMES[url];
  if (named !== undefined) return named;
  const { hostname, pathname } = new URL(url);
  const parts = pathname.split("/").filter((part) => part !== "");
  const last = (parts.at(-1) ?? "").replace(/\.html$/, "");
  if (hostname === "www.rfc-editor.org") return last.replace(/^rfc(\d+)$/, "RFC $1");
  if (hostname === "en.wikipedia.org")
    return `Wikipedia: ${decodeURIComponent(last).replaceAll("_", " ")}`;
  if (hostname === "developer.mozilla.org") return `MDN: ${parts.at(-2) ?? ""}.${last}`;
  if (hostname === "nodejs.org") return `Node.js: ${last}`;
  if (hostname === "docs.python.org") return `Python: ${last}`;
  throw new Error(`${url}: the page has no short name. Add it to NAMES.`);
};

const pick = ({ median, total }: Totals): { median: number; total: number } => ({
  median: median.tokens,
  total: total.tokens,
});

/** The run of the workflow eval.yml that made a result. */
export interface EvalRun {
  /** The id of the run. */
  readonly id: number;
  /** The ISO time of the start of the run. */
  readonly started: string;
}

/** This function gives the data of the page from the result of one run. It fails on a claim that is not verified. */
export function evalPageData(result: Result, run: EvalRun) {
  const failed = result.claims.filter((claim) => !claim.verified);
  if (failed.length > 0) {
    throw new Error(
      `${failed.map((claim) => claim.id).join(", ")}: not verified. The page shows only a run that verifies each claim.`,
    );
  }
  return {
    run: run.id,
    started: run.started,
    commitSha: result.commit,
    commit: result.commit.slice(0, 7),
    date: result.archive.start.slice(0, 10),
    package: result.package,
    tokenizer: result.tokenizer.split(" ")[0],
    window: result.window,
    archive: result.archive.sha256.slice(0, 16),
    toolDefinitions: result.tool_definitions.tokens,
    summary: {
      claims: result.summary.claims,
      verified: result.summary.verified,
      pastCut: result.summary.past_cut,
      polite: pick(result.summary.polite),
      paged: pick(result.summary.paged),
      markdown: pick(result.summary.markdown),
      text: pick(result.summary.text),
      ratio: {
        markdownTotal: result.summary.ratio.markdown_total,
        markdownMedian: result.summary.ratio.markdown_median,
        textTotal: result.summary.ratio.text_total,
      },
    },
    claims: result.claims.map((claim) => {
      const question = questions.get(claim.id);
      if (question === undefined) throw new Error(`${claim.id}: not in ${claimsFile}`);
      return {
        id: claim.id,
        source: claim.source,
        url: claim.url,
        page: nameOf(claim.url),
        question,
        rank: claim.find_rank,
        window: claim.read_window,
        fetch: claim.polite.fetch.tokens,
        find: claim.polite.find.tokens,
        read: claim.polite.read.tokens,
        verify: claim.polite.verify.tokens,
        polite: claim.polite.total.tokens,
        paged: claim.paged.tokens,
        markdown: claim.webfetch.markdown.tokens,
        text: claim.webfetch.text.tokens,
      };
    }),
  };
}

/** The data of the page, as `evalPageData` gives it. */
export type EvalPage = ReturnType<typeof evalPageData>;

/** The file of the data of the page. */
export const EVAL_A_FILE = fileURLToPath(new URL("../src/data/eval-a.json", import.meta.url));

/** This function writes the data of the page from the file of a result, and gives the count of claims. */
export function writeEvalPage(resultFile: string, run: EvalRun, out = EVAL_A_FILE): number {
  const data = evalPageData(JSON.parse(readFileSync(resultFile, "utf8")) as Result, run);
  writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
  return data.claims.length;
}

// engines.node allows Node 23, which has no import.meta.main, so the check compares the real paths.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const option = (name: string): string | undefined => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const resultFile = option("--result");
  const run = option("--run");
  const started = option("--started");
  if (
    resultFile === undefined ||
    run === undefined ||
    !/^\d+$/.test(run) ||
    started === undefined ||
    !Number.isFinite(Date.parse(started))
  ) {
    console.error(
      "usage: node packages/site/scripts/eval-data.ts --result <eval-result.json> --run <run id> --started <ISO time> [--out <file>]",
    );
    process.exit(2);
  }
  const out = option("--out") ?? EVAL_A_FILE;
  const count = writeEvalPage(resultFile, { id: Number(run), started }, out);
  console.log(`${out}: ${String(count)} claims of run ${run}`);
}
