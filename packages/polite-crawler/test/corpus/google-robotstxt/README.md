# The conformance cases of the robots.txt parser of Google

This folder holds `robots_test.cc` of [google/robotstxt](https://github.com/google/robotstxt), the robots.txt parser of Google. The file is byte for byte as it was at commit `a67394c800908229d21e58b0ae802830608c9a5e`. It keeps its license header: Copyright 2019 Google LLC, under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). The file `LICENSE` in this folder is the license text of the same commit. The project of Google has no `NOTICE` file.

## The test

`src/test-google.ts` reads the file, and `src/robots.conformance.test.ts` checks each case. Each EXPECT of the file is one case for `parseRobots`, `decide`, `isProductToken` and `normalizePath`. The file has 201 cases:

- 172 cases give the result of Google.
- 12 cases differ on purpose. The test lists each one with its reason, and RFC 9309 gives most of the reasons. For example, polite-crawler reads no line without a colon, and it does not cut a long line.
- 12 inputs of `GetPathParamsQuery` are not absolute URLs. polite-crawler decides only the path of an absolute URL.
- 5 cases count the lines that the parser does not know. `parseRobots` ignores such a line and keeps no count.

The test also checks that the number of cases agrees with the number of EXPECTs in the file. Thus no case can go out of the test with no reason.

The [Standards page](https://mark1russell7.github.io/crawler/reference/standards/) of the site reads the same cases with `src/test-google.ts` when the site builds. Thus the page shows the numbers and the differences of the test.

## A new version of the file

To use a newer version, copy the file again from GitHub. Write its commit here and in `GOOGLE_COMMIT` of `src/test-google.ts`. Then start the test, and update the list of differences with a reason for each one.
