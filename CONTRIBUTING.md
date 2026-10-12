# Contributing to polite-crawler

Thank you for your help. This file tells you how to set up the repository, which checks a change must pass, and how to write the prose.

## Set up

You need:

- **Node.js 22.19 or later.** The file `.nvmrc` names Node.js 24, the version for development. Node.js 22.19 is the oldest version that the package supports: its SQLite has FTS5.
- **pnpm 10 or later.** pnpm reads `packageManager` in `package.json` and changes to pnpm 12.10.1 itself. `corepack enable` also gives the correct version.

Then install the dependencies and the browser for the renderer test:

```sh
pnpm install
pnpm browser
```

`pnpm browser` installs `chromium-headless-shell` for `playwright-core`. Without it, the renderer test skips, and it proves nothing.

## The repository

- `packages/polite-crawler` is the package on npm. The workspace uses its source in `src/`. `pnpm build` makes `build/` for npm.
- `packages/site` is the site on GitHub Pages (Astro and Starlight). `pnpm --filter @crawler/site dev` starts it.
- `packages/cli` is the tool of the template that makes new packages (`pnpm package add`).
- `scripts/` holds the smoke test of the packed package, the publish guard and the release notes script.

## The checks

CI does these checks on each pull request. Do them before you push:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm lint:ste
pnpm build
pnpm smoke
```

`pnpm check` does all of them in this sequence.

- `pnpm lint` is `oxlint` with the type-aware rules. It finds a promise that nothing waits for, and a promise in a place that wants a value.
- `pnpm test` starts the tests of all packages with Vitest. `pnpm --filter polite-crawler test:coverage` also measures the coverage.
- `pnpm smoke` packs the package and installs the tarball into an empty project. Then it imports each entry point, starts the command and the MCP server, and examines the tarball with `attw` and `publint`.
- `pnpm format` formats the code with Prettier. CI does not examine the format yet.

CI does the tests on Ubuntu with Node.js 22.19, 24 and 26, and on Windows and macOS with Node.js 24.

## Tests

- Put a test next to its module: `src/robots.ts` has `src/robots.test.ts`.
- A test does not use the network. Use a `MockAgent` of undici, or a local `node:http` server on `127.0.0.1`.
- A test that paces requests uses a fake clock, not the real clock.
- A test that writes files makes its own folder with `mkdtemp`, and removes it in `afterEach`. On Windows, give `rm` the options `maxRetries` and `retryDelay`, because a file can stay locked for a short time.
- A change to `record.ts` must not change a capture id. Old citations name these ids.

## The writing rules

The prose of the repository follows ASD-STE100 Simplified Technical English (STE). This prose is the README files, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, the TSDoc comments in `packages/*/src` and the pages of the site. The linter [`ste-lint`](https://github.com/mark1russell7/ste-lint) examines it, and CI fails when it finds an error.

The rules:

1. Keep each instruction to 20 words or fewer, and each description to 25 words or fewer.
2. Do not use the modal verbs `should`, `may`, `might` and `would`. Write what is true, or give an instruction.
3. Do not use semicolons or Latin abbreviations (`e.g.`, `i.e.`, `etc.`). Write "for example".
4. Use the active voice. Start each sentence of a doc comment with its subject.
5. Put code, file names and commands in code font. The linter counts each code span as one word.

An example of a doc comment:

```ts
// Incorrect: the sentence has no subject, and it uses "may".
/** Returns the stored page, which may be stale. */

// Correct
/** This function returns the stored page. The page can be older than `maxAge`. */
```

Start the linter with `pnpm lint:ste`. It writes each finding with its file, line and rule. To examine one file, give its path: `pnpm lint:ste CONTRIBUTING.md`. The [README of ste-lint](https://github.com/mark1russell7/ste-lint#readme) describes each rule.

If the prose lint is the only failure of your pull request, a maintainer can correct the prose for you.

## Pull requests

- Keep each pull request to one change.
- Add an entry under "Unreleased" in `CHANGELOG.md` for a change that users of the package can see.
- Keep the crawler polite. The project does not accept a change that goes around robots.txt, a refusal, a rate limit or a bot wall.

## Releases

The maintainer makes the releases. `CLAUDE.md` tells how.
