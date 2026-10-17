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
// The cases of this test are the cases of robots_test.cc of google/robotstxt, commit
// a67394c800908229d21e58b0ae802830608c9a5e, which test/corpus/google-robotstxt/ keeps byte for
// byte. test-google.ts reads that file, and each EXPECT of it is one case. The change is the port:
// each case runs against parseRobots, decide, isProductToken and normalizePath of polite-crawler.
// The Standards page of the site reads the same cases, so it shows what this test checks.

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DIFFERENCES, expectedCaseCount, googleCases, googleConformance } from "./test-google.ts";

const FILE = new URL("../test/corpus/google-robotstxt/robots_test.cc", import.meta.url);
const bytes = new Uint8Array(await readFile(FILE));
const cases = googleCases(bytes);

describe("the conformance cases of the robots.txt parser of Google", () => {
  it("has one case for each EXPECT of robots_test.cc", () => {
    expect(cases).toHaveLength(expectedCaseCount(bytes));
    expect(cases.length).toBeGreaterThan(190);
  });

  it("decides each case as Google does, except the differences that RFC 9309 asks for", () => {
    const result = googleConformance(cases);
    expect(result.wrong).toEqual([]);
    // each listed difference names a case of the file
    expect(result.unused).toEqual([]);
    expect(result.differences).toHaveLength(Object.keys(DIFFERENCES).length);
    expect(
      result.agree.length +
        result.differences.length +
        result.notUrls.length +
        result.notCounted.length,
    ).toBe(cases.length);
  });
});
