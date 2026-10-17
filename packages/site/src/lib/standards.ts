/**
 * The numbers of the Standards page. The cases of the robots.txt test of Google come from the test of
 * polite-crawler. The page uses the same file, the same port and the same list of differences. Thus
 * the page shows what the test checks, and it cannot drift from the test.
 *
 * The imports go through the link of the workspace in node_modules, as the import of a package does.
 * Thus TypeScript reads these files as a library, not as files of the site.
 */
import source from "../../node_modules/polite-crawler/test/corpus/google-robotstxt/robots_test.cc?raw";
import type { GoogleCase } from "../../node_modules/polite-crawler/src/test-google.ts";
import {
  GOOGLE_COMMIT,
  googleCases,
  googleConformance,
} from "../../node_modules/polite-crawler/src/test-google.ts";

/** This address is the folder of the package source at main, for the links to the tests. */
export const SOURCE = "https://github.com/mark1russell7/crawler/blob/main/packages/polite-crawler";

/** One difference of the Google cases, as the page shows it. */
export interface ShownDifference {
  readonly test: string;
  readonly line: number;
  readonly what: string;
  readonly google: string;
  readonly crawler: string;
  /** This value is true when the two results are values to show in code font, not words. */
  readonly literal: boolean;
  readonly reason: string;
  /** This address is the line of the EXPECT in robots_test.cc, at the commit that the test uses. */
  readonly href: string;
}

/** The result of the Google cases, as the page shows it. */
export interface GoogleSummary {
  readonly commit: string;
  readonly total: number;
  readonly agree: number;
  readonly differences: readonly ShownDifference[];
  readonly notUrls: number;
  readonly notCounted: number;
  /** This value is the number of cases that differ with no reason. The test makes sure that it is 0. */
  readonly wrong: number;
}

/** This function gives the text of a result: the verdict, the token check or the value. */
export const shown = (kind: GoogleCase["kind"], value: unknown): string => {
  if (kind === "allowed") return value === true ? "permitted" : "refused";
  if (kind === "token") return value === true ? "a valid token" : "not a valid token";
  return JSON.stringify(value);
};

/** This function gives the result of the Google cases for the bytes of robots_test.cc. */
export const summarizeGoogle = (bytes: Uint8Array): GoogleSummary => {
  const cases = googleCases(bytes);
  const result = googleConformance(cases);
  return {
    commit: GOOGLE_COMMIT,
    total: cases.length,
    agree: result.agree.length,
    differences: result.differences.map((one) => ({
      test: one.test,
      line: one.line,
      what: one.what,
      google: shown(one.kind, one.expected),
      crawler: shown(one.kind, one.actual),
      literal: one.kind !== "allowed" && one.kind !== "token",
      reason: one.reason,
      href: `https://github.com/google/robotstxt/blob/${GOOGLE_COMMIT}/robots_test.cc#L${String(one.line)}`,
    })),
    notUrls: result.notUrls.length,
    notCounted: result.notCounted.length,
    wrong: result.wrong.length + result.unused.length,
  };
};

/**
 * This function gives the result of the Google cases for the file in the repository. The build reads
 * the file as UTF-8 text, and the function gives the cases its bytes again.
 */
export const googleSummary = (): GoogleSummary => summarizeGoogle(new TextEncoder().encode(source));
