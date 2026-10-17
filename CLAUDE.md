# Instructions for Claude

## Writing style

Write all prose of this repository in the style of ASD-STE100 Simplified Technical English (STE). This prose is the README files, this file, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, the TSDoc comments and the text that the site shows. The linter [`ste-lint`](https://github.com/mark1russell7/ste-lint) examines it.

- After a change to prose, start `pnpm lint:ste` and correct each finding. CI fails when there is an error.
- Keep each instruction to 20 words or fewer, and each description to 25 words or fewer.
- Do not use the modal verbs (`should`, `may`, `might`, `would`), semicolons or Latin abbreviations (`e.g.`, `i.e.`, `etc.`).
- Use the active voice. Start each sentence of a doc comment with its subject: "This function returns the value", not "Returns the value".
- Put code, file names and commands in code font. The linter counts each code span as one word.
- Add a word to the glossary in `ste.config.json` only if it is a real technical term of the project.

## Packages

- Make a new package with `pnpm package add <name> --preset=<preset>`. Do not write `package.json` or `tsconfig.json` by hand.
- A package is a source package. Its `main` is `src/index.ts`, so other packages import its source.
- Each package has a `tsconfig.test.json`. `pnpm typecheck` checks the source and the tests.

## Checks

- `pnpm check` does the checks of CI in sequence: `typecheck`, `lint` (oxlint), `test`, `lint:ste`, `build` and `smoke`.
- `pnpm smoke` (`scripts/smoke.mjs`) installs the packed tarball into an empty project and uses it the way a user does.
- CI does the tests on Ubuntu with Node.js 22.19, 24 and 26, and on Windows and macOS with Node.js 24.
- `pnpm format` (Prettier) is not a CI check yet, because most of the code is not formatted yet.
- Pin each GitHub action to a full commit SHA, with the version in a comment. Dependabot updates them.

## The package

- `packages/polite-crawler` is the published package `polite-crawler`. The workspace uses its source, and `pnpm --filter polite-crawler build` makes `build/` for npm with `tsdown`.
- The package needs Node.js 22.19 or later (`engines`). Older versions of Node.js 22 have no FTS5 in their SQLite, and undici 8 needs 22.19.
- `publishConfig` points `main`, `types`, `exports` and `bin` at `build/`. pnpm applies these fields when it packs, and npm ignores them.
- Thus the `prepublishOnly` guard (`scripts/publish-guard.mjs`) stops `npm publish` in the package folder. Publish the tarball of `pnpm pack`.
- The package depends on no package of the owner. Keep it so.
- A capture id is a hash of the record (`record.ts`). Do not change the hash. Old citations name these ids.
- `playwright-core` is an optional peer. The renderer loads it only when a page needs a browser.
- `mcpName` in `package.json` and `server.json` at the root make the entry of the server in the MCP registry.

## Releases

The version is in four places: `version` in `packages/polite-crawler/package.json`, `VERSION` in `src/version.ts`, and the two `version` fields of `server.json`. A test and the smoke test make sure that they agree.

To make a release:

1. Change the version in the four places.
2. In `CHANGELOG.md`, change `## Unreleased` to `## <version> - <date>`. Add a new empty `## Unreleased` above it.
3. Open a pull request with the two changes. Wait until CI passes.
4. Get the approval of the owner. Then merge the pull request to main.

Do not merge a version change to main without the approval of the owner. The merge starts `.github/workflows/release.yml`, which does these steps:

- It does the gates of CI again, then builds, packs and smoke-tests the tarball. It makes sure that `CHANGELOG.md` has the section of the version.
- A job with no code of the repository publishes that tarball to npm, with provenance. It skips a version that npm has already.
- It publishes `server.json` to the MCP registry. It makes the tag `v<version>` and the GitHub release with the section of `CHANGELOG.md`.

The rules for versions:

- Before 1.0.0, a minor version can change the API, and a patch version only corrects errors.
- The store on disk (the capture log, the blobs and the capture ids) stays the same across 0.x. A version that changes it gives the steps to move an old store.
- A prerelease version (`0.2.0-beta.1`) goes to the npm tag `next`. Each other version goes to `latest`.
- If the release fails, correct the error. Start the workflow again with `gh workflow run release.yml --ref main`, or change to the next patch version.

## npm

- Do not publish to npm, and do not change npm settings. The owner and one named Claude session do all npm work.
- Do not edit `.github/workflows/release.yml` or `scripts/release/`.
- `RELEASING.md` tells how a release and the npm trust work.
