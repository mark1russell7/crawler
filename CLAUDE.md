# Instructions for Claude

## Writing style

Write all prose of this repository in the style of ASD-STE100 Simplified Technical English (STE). This prose is the README files, this file, the TSDoc comments and the text that the site shows. The linter [`ste-lint`](https://github.com/mark1russell7/ste-lint) examines it.

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

## The package

- `packages/polite-crawler` is the published package `polite-crawler`. The workspace uses its source, and `pnpm --filter polite-crawler build` makes `build/` for npm with `tsdown`.
- `publishConfig` points `main`, `types`, `exports` and `bin` at `build/`. Publish with `pnpm publish`, because npm ignores those fields of `publishConfig`.
- The package depends on no package of the owner. Keep it so.
- A capture id is a hash of the record (`record.ts`). Do not change the hash. Old citations name these ids.
- `playwright-core` is an optional peer. The renderer loads it only when a page needs a browser.

## Publishing

- `.github/workflows/release.yml` publishes when a tag `v<version>` is pushed. The owner pushes the tag. Do not push a version tag without the approval of the owner.
