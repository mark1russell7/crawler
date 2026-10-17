// Copyright 2019 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// The cases of this module are the cases of robots_test.cc of google/robotstxt, commit
// a67394c800908229d21e58b0ae802830608c9a5e, which test/corpus/google-robotstxt/ keeps byte for
// byte. The module reads that file, and each EXPECT of it is one case. The change is the port: each
// case runs against parseRobots, decide, isProductToken and normalizePath of polite-crawler.
// robots.conformance.test.ts checks the cases, and the Standards page of the site shows them.

import type { Robots } from "./robots.ts";
import {
  decide,
  isProductToken,
  normalizePath,
  parseRobots,
  robotsFromResponse,
} from "./robots.ts";

/** This text is the commit of google/robotstxt that `test/corpus/google-robotstxt/` keeps. */
export const GOOGLE_COMMIT = "a67394c800908229d21e58b0ae802830608c9a5e";

/**
 * These cases differ on purpose. In each one, polite-crawler decides as RFC 9309 says, or the case
 * tests a part of the Google parser that polite-crawler does not have. The key is the name of the
 * test and the line of the EXPECT in robots_test.cc. The test checks that polite-crawler still differs, so a
 * change of behavior shows.
 */
export const DIFFERENCES: Readonly<Record<string, string>> = {
  "ID_LineSyntax_Line:79":
    "RFC 9309 §2.1: a line is a key, a colon and a value. Google guesses the colon of 'disallow /'. polite-crawler reads no line without a colon.",
  "GoogleOnly_AcceptUserAgentUpToFirstSpace:247":
    "RFC 9309 §2.2.1: a crawler matches its product token. polite-crawler reads the token of the agent 'Foo Bar' as 'foo' (productToken), and the file names that group. Google matches the whole value 'Foo Bar' and finds no group.",
  "ID_Encoding:419":
    "RFC 9309 §2.2.2: the octets outside US-ASCII are percent-encoded before the comparison. polite-crawler reads the path of a parsed URL, which is encoded, so '/foo/bar/ツ' is '/foo/bar/%E3%83%84'. Google asks the caller to encode the URL first.",
  "ID_Encoding:430":
    "RFC 9309 §2.2.2, as above: the unencoded '/foo/bar/ツ' is the encoded path, so the allow rule matches it.",
  "ID_Encoding:441":
    "RFC 3986 §6.2.2.2: an escape of an unreserved character ('%62%61%7A') and the character ('baz') are equal, and polite-crawler normalizes both sides (normalizePath). Google compares the strings as written.",
  "GoogleOnly_IndexHTMLisDirectory:505":
    "Google-specific: Google reads 'index.html' at the end of a pattern as its directory. RFC 9309 has no such rule, so '/allowed-slash/' does not match '/allowed-slash/index.html'.",
  "GoogleOnly_LineTooLong:539":
    "Google-specific: Google cuts a line after 8 × 2083 bytes. polite-crawler reads each line whole, so the rule is not cut and does not match the path. RFC 9309 §2.5 sets a limit for the file, not for a line, and that limit is 500 KiB here.",
  "GoogleOnly_LineTooLong:565":
    "Google-specific, as above: the second allow rule is not cut, so a path that only the cut rule matches stays disallowed.",
  "ID_UTF8ByteOrderMarkIsSkipped:898":
    "RFC 9309 §2.3: the file is UTF-8. Two bytes of a byte order mark are not UTF-8, so the first line does not parse and its group is lost. Google skips a part of the mark.",
  "ID_UTF8ByteOrderMarkIsSkipped:906":
    "RFC 9309 §2.3, as above: one byte of a byte order mark is not UTF-8, so the first line does not parse.",
  "ID_UTF8ByteOrderMarkIsSkipped:916":
    "RFC 9309 §2.1: a rule outside a group is ignored. After the broken first line, the allow line is in no group, so polite-crawler does not keep it. The reporter of Google counts each line that it reads.",
  "ID_UTF8ByteOrderMarkIsSkipped:925":
    "A byte order mark in the middle of the file is the character U+FEFF, which JavaScript reads as a space (String.prototype.trim). polite-crawler thus reads the allow line that follows it. Google sees an unknown line.",
};

/** The reporter of Google counts the lines that it does not know. `parseRobots` ignores such a line (RFC 9309 §2.2.4) and keeps no count. */
export const NOT_COUNTED = "not counted";

/** This text is the result of a path case whose input is not an absolute URL. */
export const NOT_A_URL = "not a URL";

/** These inputs of GetPathParamsQuery are not absolute URLs. polite-crawler decides only the path of an absolute http or https URL (the WHATWG URL parser). These inputs have no path to compare. */
const NOT_URLS: ReadonlySet<string> = new Set([
  "example.com",
  "example.com/",
  "example.com/a",
  "example.com/a/",
  "example.com/a/b?c=d&e=f#fragment",
  "a",
  "a/",
  "/a",
  "a/b",
  "example.com?a",
  "example.com/a;b#c",
  "//a/b/c",
]);

/**
 * The kind of a case tells what it compares. `allowed`: the verdict for an agent and a URL. `token`:
 * a valid product token. `report`: a count of the parse reporter. `path`: the path of a URL.
 * `escape`: the normalized form of a pattern.
 */
export type GoogleCaseKind = "allowed" | "token" | "report" | "path" | "escape";

/** One EXPECT of robots_test.cc, with the result of Google and the result of polite-crawler. */
export interface GoogleCase {
  readonly test: string;
  readonly line: number;
  readonly kind: GoogleCaseKind;
  readonly what: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

// ── a reader of the C++ file ────────────────────────────────────────────────

/** This function gives the bytes of a C string literal, with its escapes (\n, \r, \", \\, \xHH). */
const bytesOf = (literal: string): number[] => {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let at = 0; at < literal.length; at += 1) {
    const char = literal[at]!;
    if (char !== "\\") {
      // the file is read as latin1, so each char is one byte of the UTF-8 source
      bytes.push(char.charCodeAt(0));
      continue;
    }
    const next = literal[at + 1]!;
    at += 1;
    if (next === "n") bytes.push(10);
    else if (next === "r") bytes.push(13);
    else if (next === "t") bytes.push(9);
    else if (next === "x") {
      const hex = /^[0-9a-fA-F]+/.exec(literal.slice(at + 1))![0];
      bytes.push(Number.parseInt(hex, 16) & 0xff);
      at += hex.length;
    } else bytes.push(...encoder.encode(next));
  }
  return bytes;
};

/** A value of the C++ test: the bytes of a string. */
type Value = number[];

const text = (value: Value): string => new TextDecoder().decode(new Uint8Array(value));

/** This function reads an expression of string literals and names: `"a" "b"`, `robotstxt`, `absl::string_view()`. */
const valueOf = (
  expression: string,
  scope: ReadonlyArray<Map<string, Value>>,
): Value | undefined => {
  const trimmed = expression.trim();
  if (trimmed === "absl::string_view()" || trimmed === "") return [];
  if (/^[A-Za-z_]\w*$/.test(trimmed)) {
    for (let at = scope.length - 1; at >= 0; at -= 1) {
      const found = scope[at]!.get(trimmed);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const literals = [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)];
  if (literals.length === 0 || trimmed.replace(/"((?:[^"\\]|\\.)*)"/g, "").trim() !== "")
    return undefined;
  return literals.flatMap((literal) => bytesOf(literal[1]!));
};

/** This function splits the arguments of a call at its top-level commas. */
const argumentsOf = (inside: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let at = 0; at < inside.length; at += 1) {
    const char = inside[at]!;
    if (quoted) {
      if (char === "\\") at += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      out.push(inside.slice(start, at));
      start = at + 1;
    }
  }
  out.push(inside.slice(start));
  return out;
};

interface Statement {
  readonly text: string;
  readonly line: number;
  readonly depth: number;
}

/** This function cuts a block of C++ into statements, with the line of each and the depth of its braces. */
const statementsOf = (body: string, firstLine: number): Statement[] => {
  const out: Statement[] = [];
  let depth = 0;
  let line = firstLine;
  let parts: string[] = [];
  let startLine = line;
  let begun = false;
  let quoted = false;
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at]!;
    if (quoted) {
      parts.push(char);
      if (char === "\\") {
        parts.push(body[at + 1]!);
        at += 1;
      } else if (char === '"') quoted = false;
      continue;
    }
    if (char === "/" && body[at + 1] === "/") {
      // a comment is not a part of the statement
      const end = body.indexOf("\n", at);
      at = (end === -1 ? body.length : end) - 1;
      continue;
    }
    if (char === "\n") line += 1;
    if (char === "{" || char === "}" || char === ";") {
      const textOf = parts.join("").trim();
      if (textOf.length > 0) out.push({ text: textOf, line: startLine, depth });
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      parts = [];
      begun = false;
      continue;
    }
    if (!begun && /\S/.test(char)) {
      begun = true;
      startLine = line;
    }
    if (char === '"') quoted = true;
    parts.push(char);
  }
  return out;
};

/** This function gives the path and query of a URL, as the crawler gives it to `decide`. An empty URL has no path. */
const pathOf = (url: string): string => {
  if (url === "") return "";
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

const allowedBy = (robots: string, agent: string, url: string): boolean =>
  decide(parseRobots(robots), [agent], pathOf(url)).allowed;

/** The counts of the parse reporter of Google, from what `parseRobots` keeps: the agents and the rules of each group, and the sitemaps. */
const report = (robots: Robots): Record<string, unknown> => ({
  valid_directives:
    robots.groups.reduce((sum, group) => sum + group.agents.length + group.rules.length, 0) +
    robots.sitemaps.length,
  last_line_seen: Math.max(
    0,
    ...robots.groups.flatMap((group) => [
      group.line ?? 0,
      ...group.rules.map((rule) => rule.line ?? 0),
    ]),
  ),
  unknown_directives: NOT_COUNTED,
  sitemap: robots.sitemaps.join(""),
});

/** This function does each EXPECT of one TEST of the file, and gives its cases. */
const casesOf = (test: string, body: string, firstLine: number): GoogleCase[] => {
  const cases: GoogleCase[] = [];
  const scope: Array<Map<string, Value>> = [new Map()];
  let parsed: Robots | undefined;
  for (const statement of statementsOf(body, firstLine)) {
    while (scope.length - 1 > statement.depth) scope.pop();
    while (scope.length - 1 < statement.depth) scope.push(new Map());
    const declared =
      /^(?:static\s+)?(?:const\s+)?(?:absl::string_view|std::string|char)\s+(\w+)(?:\[\])?\s*(?:=\s*([\s\S]*))?$/.exec(
        statement.text,
      );
    if (declared !== null) {
      const value = declared[2] === undefined ? [] : valueOf(declared[2], scope);
      if (value !== undefined) scope[scope.length - 1]!.set(declared[1]!, value);
      continue;
    }
    const append = /^absl::StrAppend\(&(\w+),([\s\S]*)\)$/.exec(statement.text);
    if (append !== null) {
      const owner = [...scope].reverse().find((names) => names.has(append[1]!));
      const added = argumentsOf(append[2]!).flatMap((argument) => valueOf(argument, scope) ?? []);
      owner?.set(append[1]!, [...owner.get(append[1]!)!, ...added]);
      continue;
    }
    const allowed = /^EXPECT_(TRUE|FALSE)\(\s*IsUserAgentAllowed\(([\s\S]*)\)\s*\)$/.exec(
      statement.text,
    );
    if (allowed !== null) {
      const [robots, agent, url] = argumentsOf(allowed[2]!).map((argument) =>
        valueOf(argument, scope),
      );
      if (robots === undefined || agent === undefined || url === undefined)
        throw new Error(`${test}:${String(statement.line)}: cannot read ${statement.text}`);
      cases.push({
        test,
        line: statement.line,
        kind: "allowed",
        what: `${JSON.stringify(text(agent))} on ${JSON.stringify(text(url))}`,
        expected: allowed[1] === "TRUE",
        actual: allowedBy(text(robots), text(agent), text(url)),
      });
      continue;
    }
    const valid =
      /^EXPECT_(TRUE|FALSE)\(\s*RobotsMatcher::IsValidUserAgentToObey\(([\s\S]*)\)\s*\)$/.exec(
        statement.text,
      );
    if (valid !== null) {
      const agent = valueOf(valid[2]!, scope)!;
      cases.push({
        test,
        line: statement.line,
        kind: "token",
        what: `the token ${JSON.stringify(text(agent))}`,
        expected: valid[1] === "TRUE",
        actual: isProductToken(text(agent)),
      });
      continue;
    }
    const parse = /^googlebot::ParseRobotsTxt\((\w+),\s*&report\)$/.exec(statement.text);
    if (parse !== null) {
      // the bytes of the file go through the reading of a robots.txt response: UTF-8, a byte order mark removed
      parsed = robotsFromResponse(200, "text/plain", new Uint8Array(valueOf(parse[1]!, scope)!));
      continue;
    }
    const counted = /^EXPECT_EQ\((\w+),\s*report\.(\w+)\(\)\)$/.exec(statement.text);
    if (counted !== null) {
      const expected = /^\d+$/.test(counted[1]!)
        ? Number(counted[1])
        : text(valueOf(counted[1]!, scope)!);
      cases.push({
        test,
        line: statement.line,
        kind: "report",
        what: `report.${counted[2]!}()`,
        expected,
        actual: report(parsed!)[counted[2]!],
      });
      continue;
    }
    const path = /^Test(Path|Escape)\(([\s\S]*)\)$/.exec(statement.text);
    if (path !== null) {
      const [input, output] = argumentsOf(path[2]!).map((argument) =>
        text(valueOf(argument, scope)!),
      );
      if (path[1] === "Escape") {
        cases.push({
          test,
          line: statement.line,
          kind: "escape",
          what: `the pattern ${JSON.stringify(input)}`,
          expected: output,
          actual: normalizePath(input!),
        });
      } else {
        cases.push({
          test,
          line: statement.line,
          kind: "path",
          what: `the path of ${JSON.stringify(input)}`,
          expected: output,
          actual: NOT_URLS.has(input!) ? NOT_A_URL : normalizePath(pathOf(input!) || "/"),
        });
      }
      continue;
    }
    if (/EXPECT_|ASSERT_/.test(statement.text))
      throw new Error(`${test}:${String(statement.line)}: no port for ${statement.text}`);
  }
  return cases;
};

/** The test of long lines builds its file with loops of absl::StrAppend: this is the same file, written in TypeScript. */
const longLineCases = (lines: readonly number[]): GoogleCase[] => {
  const max = 2083 * 8;
  const test = "GoogleOnly_LineTooLong";
  const cases: GoogleCase[] = [];
  const add = (line: number, what: string, expected: boolean, actual: boolean): void => {
    cases.push({ test, line, kind: "allowed", what, expected, actual });
  };
  {
    let robots = "user-agent: FooBot\n";
    let long = "/x/";
    const length = max - long.length - "disallow: ".length + 1;
    while (long.length < length) long += "a";
    robots += `disallow: ${long}/qux\n`;
    add(lines[0]!, '"FooBot" on "/fux"', true, allowedBy(robots, "FooBot", "http://foo.bar/fux"));
    add(
      lines[1]!,
      '"FooBot" on the long path',
      false,
      allowedBy(robots, "FooBot", `http://foo.bar${long}/fux`),
    );
  }
  {
    let robots = "user-agent: FooBot\ndisallow: /\n";
    let a = "/x/";
    let b = "/x/";
    const length = max - a.length - "allow: ".length + 1;
    while (a.length < length) {
      a += "a";
      b += "b";
    }
    robots += `allow: ${a}/qux\nallow: ${b}/qux\n`;
    add(lines[2]!, '"FooBot" on "/"', false, allowedBy(robots, "FooBot", "http://foo.bar/"));
    add(
      lines[3]!,
      '"FooBot" on the first long path',
      true,
      allowedBy(robots, "FooBot", `http://foo.bar${a}/qux`),
    );
    add(
      lines[4]!,
      '"FooBot" on the second long path',
      true,
      allowedBy(robots, "FooBot", `http://foo.bar${b}/fux`),
    );
  }
  return cases;
};

/** This function reads the bytes as latin1, so each char of the text is one byte. */
const latin1 = (bytes: Uint8Array): string => {
  let out = "";
  for (let at = 0; at < bytes.length; at += 8192)
    out += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return out;
};

/** This function gives the cases of the bytes of robots_test.cc, in the sequence of the file. */
export const googleCases = (bytes: Uint8Array): GoogleCase[] => {
  const source = latin1(bytes);
  const lineOf = (offset: number): number => source.slice(0, offset).split("\n").length;
  const cases: GoogleCase[] = [];
  for (const match of source.matchAll(/^TEST\(RobotsUnittest, (\w+)\) \{\n([\s\S]*?)^\}$/gm)) {
    const [, test, body] = match;
    const first = lineOf(match.index) + 1;
    if (test === "GoogleOnly_LineTooLong") {
      const expects = [...body!.matchAll(/EXPECT_/g)].map(
        (found) => first + body!.slice(0, found.index).split("\n").length - 1,
      );
      cases.push(...longLineCases(expects));
    } else {
      cases.push(...casesOf(test!, body!, first));
    }
  }
  return cases;
};

/**
 * This function gives the number of cases of the file. Each EXPECT is one case, and each call of
 * the helpers TestPath and TestEscape is one case. The two EXPECTs in these helpers are not cases.
 */
export const expectedCaseCount = (bytes: Uint8Array): number => {
  const source = latin1(bytes);
  const expects = (source.match(/\bEXPECT_(?:TRUE|FALSE|EQ)\(/g) ?? []).length - 2;
  const calls = (source.match(/^\s*Test(?:Path|Escape)\(/gm) ?? []).length;
  return expects + calls;
};

/** A case that differs on purpose, with its reason. */
export interface GoogleDifference extends GoogleCase {
  readonly reason: string;
}

/** The cases in four parts, and the problems that the test reports. */
export interface GoogleConformance {
  /** These cases give the result of Google. */
  readonly agree: readonly GoogleCase[];
  /** These cases differ on purpose, each with its reason in `DIFFERENCES`. */
  readonly differences: readonly GoogleDifference[];
  /** These path cases have an input that is not an absolute URL. */
  readonly notUrls: readonly GoogleCase[];
  /** These cases count the lines that the parser does not know. */
  readonly notCounted: readonly GoogleCase[];
  /** Each text tells a case that differs with no reason, or a listed difference that gives the result of Google. */
  readonly wrong: readonly string[];
  /** These keys of `DIFFERENCES` name no case of the file. */
  readonly unused: readonly string[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** This function puts each case into its part, and finds the cases that differ with no reason. */
export const googleConformance = (cases: readonly GoogleCase[]): GoogleConformance => {
  const agree: GoogleCase[] = [];
  const differences: GoogleDifference[] = [];
  const notUrls: GoogleCase[] = [];
  const notCounted: GoogleCase[] = [];
  const wrong: string[] = [];
  const listed = new Set<string>();
  for (const one of cases) {
    const key = `${one.test}:${String(one.line)}`;
    const reason = DIFFERENCES[key];
    const unported = one.actual === NOT_A_URL || one.actual === NOT_COUNTED;
    if (reason !== undefined || unported) {
      if (reason !== undefined) listed.add(key);
      // a difference stays a difference, or the list needs an update
      if (same(one.actual, one.expected))
        wrong.push(`${key} ${one.what}: now as Google, take it out of DIFFERENCES`);
      else if (reason !== undefined) differences.push({ ...one, reason });
      else if (one.actual === NOT_A_URL) notUrls.push(one);
      else notCounted.push(one);
      continue;
    }
    if (same(one.actual, one.expected)) agree.push(one);
    else
      wrong.push(
        `${key} ${one.what}: Google ${JSON.stringify(one.expected)}, polite-crawler ${JSON.stringify(one.actual)}`,
      );
  }
  const unused = Object.keys(DIFFERENCES).filter((key) => !listed.has(key));
  return { agree, differences, notUrls, notCounted, wrong, unused };
};
