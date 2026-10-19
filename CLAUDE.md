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

- `pnpm check` does the checks of CI in sequence: `format:check`, `typecheck`, `lint` (oxlint), `test`, `lint:ste`, `build`, `api --check` and `smoke`.
- `pnpm api` (`scripts/api.mjs`) makes the reports of the public API in `packages/polite-crawler/api/` from the build, one for each entry point. CI fails when a report is not the API of the build. After a change to the API, start `pnpm build` and `pnpm api`, and commit the reports.
- An export with the TSDoc tag `@beta` is the engine: a minor version can change it. An export with no tag is stable. `docs/API-REVIEW.md` gives the tier of each export. Tag each new export of the engine.
- `pnpm smoke` (`scripts/smoke.mjs`) installs the packed tarball into an empty project and uses it the way a user does.
- CI does the tests on Ubuntu with Node.js 22.19, 24 and 26, and on Windows and macOS with Node.js 24.
- CI fails when the code is not in the format of Prettier. Start `pnpm format` before a commit.
- Pin each GitHub action to a full commit SHA, with the version in a comment. Renovate updates them (`renovate.json`): one pull request each week for the actions, and one for the minor and patch updates of npm. It merges a patch update, and a minor or patch update of a dev dependency, when CI passes.

## Roadmap

- `docs/ROADMAP.md` is the roadmap. The tracker page shows the same items, with a dependency map and a timeline.
- The files of the tracker are in the private repository of the owner, in `~/git/fleet/artifacts/crawler-roadmap`. The page is a view of these files.
- To change an item, change its file in `db/items`. Write the file to the page with the `artifact-sync` skill.
- Then start `pnpm roadmap`, and commit `docs/ROADMAP.md`. Do not edit that file by hand.

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

Since 0.2.0 the repository publishes two packages with the same version: `polite-crawler` and `polite-crawler-mcp`. The version is in these places:

- `polite-crawler`: `version` in `packages/polite-crawler/package.json`, `VERSION` in `packages/polite-crawler/src/version.ts`, and `VERSION` in its API report `packages/polite-crawler/api/index.api.md`.
- `polite-crawler-mcp`: `version` in `packages/polite-crawler-mcp/package.json`, `VERSION` in `packages/polite-crawler-mcp/src/version.ts`, and the two `version` fields of `server.json`.

`polite-crawler-mcp` depends on `polite-crawler` with `workspace:^`, so its tarball names `^<version>` of polite-crawler. The smoke test makes sure that the two versions agree and that the range is `^<version>`. Tests make sure that each package and its `version.ts` agree.

To make a release:

1. Change the version in each of these places.
2. In `CHANGELOG.md` and in `packages/polite-crawler-mcp/CHANGELOG.md`, add `## <version> - <date>` below `## Unreleased`, above the notes of the version.
3. Open a pull request with the changes. Wait until CI passes.
4. Get the approval of the owner. Then the release session merges the pull request to main.

Do not merge a version change to main without the approval of the owner. The merge starts `.github/workflows/release.yml`, which does these steps:

- It does the gates of CI again, then builds, packs and smoke-tests the two tarballs. It makes sure that each changelog has the section of the version.
- A job with no code of the repository publishes the tarballs to npm, with provenance. It skips a version that npm has already.
- It publishes `server.json` to the MCP registry. `server.json` names `polite-crawler-mcp`, and release.yml checks it against the version of that package. It makes the tag `v<version>` and the GitHub release with the section of `CHANGELOG.md` and the two tarballs.

The rules for versions:

- Before 1.0.0, a change that breaks the API increases the minor version. A new feature or a correction increases the patch version.
- The store on disk (the capture log, the blobs and the capture ids) stays the same across 0.x. A version that changes it gives the steps to move an old store.
- A prerelease version (`0.2.0-beta.1`) goes to the npm tag `next`. Each other version goes to `latest`.
- If the release fails, correct the error. Start the workflow again with `gh workflow run release.yml --ref main`, or change to the next patch version.

## npm

- Do not publish to npm, and do not change npm settings. The owner and one named Claude session do all npm work.
- Do not edit `.github/workflows/release.yml` or `scripts/release/`.
- `RELEASING.md` tells how a release and the npm trust work.

## Study

`.github/workflows/study-monthly.yml` does the robots.txt study again at 06:17 UTC on day 2 of each month.

The files of the study are in `packages/site`:

- `src/data/study/<version>.json` and `public/data/robots-study-<version>.csv` are the dataset of each run. The version is the day of the run.
- `src/data/robots-study.json` and `public/data/robots-study.csv` are a copy of the newest run. The pages read this copy.
- `src/data/study-history.json` keeps the headline numbers and the DOI of each run. `scripts/robots-study.ts` writes it. Do not edit it by hand.
- `src/data/study-doi.json` names the DOI of the newest version and the concept DOI.

The DOIs on Zenodo:

- The concept DOI `10.5281/zenodo.23443374` names the study and all its versions. Cite it for the study.
- Each version has its own DOI for the data of one run. The first version is `10.5281/zenodo.23443375`.

The steps of each month:

1. The workflow does the study and the checks of the site. It opens a pull request from the branch `study/<YYYY-MM>` and starts `ci.yml` on that branch.
2. A session or Mark reviews the pull request. Merge it when CI passes.
3. Make the new version on Zenodo: `gh workflow run study-zenodo.yml -R mark1russell7/crawler -f new_version_of=<record id>`.
4. Mark checks the draft on Zenodo and clicks Publish.
5. Record the DOI: `pnpm exec tsx packages/site/scripts/robots-study.ts doi <version> <doi>`. Commit the change on a branch and open a pull request.

The pull request of the run gives the commands of steps 3 and 5. The record id of step 3 is the number at the end of the DOI of the newest published version. Zenodo makes a new version only from the newest version.

Rules:

- Do not start the study on a laptop. The requests of the study go out only from CI.
- GitHub Actions opens the pull request only when the setting "Allow GitHub Actions to create and approve pull requests" is on. When it is off, the run pushes the branch. Its summary then gives the address to open the pull request by hand.
