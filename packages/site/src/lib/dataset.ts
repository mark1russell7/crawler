/**
 * The dataset of the robots.txt study for Zenodo: the files of the study, a README and a
 * `CITATION.cff`, and the metadata of the record. The same input gives the same bytes: no file
 * contains the time of the build.
 */
import type { StudyDoi } from "./cite.ts";
import {
  CITATION_AUTHOR,
  DATASET_TITLE,
  PRESS_CONTACT,
  REPOSITORY,
  STUDY_KEYWORDS,
  STUDY_PAGE,
  articleTitle,
  datasetCitation,
  doiUrl,
  isDoi,
  studyCitation,
  studyVersion,
} from "./cite.ts";
import type { Study } from "./study.ts";
import { DATA_LICENSE, STUDY_AUTHOR, summarize, toCsv } from "./study.ts";

/** A file of the dataset: its name and its bytes. */
export interface DatasetFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** The input of the dataset: the two data files as the site has them, and the text of the study page. */
export interface DatasetInput {
  /** These bytes are `src/data/robots-study.json`. */
  readonly json: Uint8Array;
  /** These bytes are `public/data/robots-study.csv`. */
  readonly csv: Uint8Array;
  /** This text is the MDX source of the study page. The README copies its limits. */
  readonly page: string;
  /** This value is the DOI that Zenodo reserved for the record, when it is known. */
  readonly doi?: string | undefined;
  /** This value is the concept DOI of the study: it names each version. */
  readonly concept?: string | undefined;
}

const ROLE_WORDS: Readonly<Record<string, string>> = {
  training: "collects training data, or controls the use for training",
  search: "collects pages for AI search",
  user: "fetches a page when a person asks",
  control: "for comparison",
};

/**
 * This function gives the items of the list under `## The limits` of the study page, as Markdown.
 * It fails when the list is missing, or when an item has an MDX expression or a tag, because the
 * README cannot show these.
 */
export const limitsOf = (page: string): readonly string[] => {
  const section = /^## The limits\n([\s\S]*?)(?=^## )/m.exec(page)?.[1];
  if (section === undefined) throw new Error("the study page has no section '## The limits'");
  const items = section
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
  if (items.length === 0) throw new Error("the section '## The limits' has no list");
  for (const item of items) {
    if (/[{}<>]/.test(item)) throw new Error(`a limit has MDX in it: ${item}`);
  }
  return items;
};

const table = (head: readonly string[], rows: ReadonlyArray<readonly string[]>): string =>
  [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

/**
 * This function gives the section of the README about the versions on Zenodo. The concept DOI names
 * the study and each of its versions. The DOI of a version names the data of one run.
 */
const versionsOf = (version: string, doi?: string, concept?: string): string => {
  const lines = [
    "The study runs again each month. Each run is a new version of one record on Zenodo, with its own files.",
    "",
  ];
  if (concept !== undefined)
    lines.push(
      `- The concept DOI [${concept}](${doiUrl(concept)}) names the study and all its versions. It goes to the newest version. Cite it for the study.`,
    );
  lines.push(
    doi === undefined
      ? "- Each version has its own DOI. It names the data of one run. Cite it for the numbers of that month."
      : `- The DOI [${doi}](${doiUrl(doi)}) names this version (${version}) only: the data of one run. Cite it for the numbers of this month.`,
  );
  return lines.join("\n");
};

/** This function gives the README of the dataset. */
export const readme = (
  study: Study,
  limits: readonly string[],
  doi?: string,
  concept?: string,
): string => {
  const version = studyVersion(study);
  const summary = summarize(study);
  const size = summary.listSize.toLocaleString("en-US");
  const tokens = study.agents.map((agent) => `\`${agent.token}\``);
  const cite =
    doi === undefined
      ? `${datasetCitation(study)} ${STUDY_PAGE}`
      : `${datasetCitation(study)} Zenodo. ${doiUrl(doi)}`;
  const citeStudy =
    concept === undefined
      ? ""
      : `\n\nTo cite the study and all its versions: ${studyCitation()} Zenodo. ${doiUrl(concept)}`;
  return `# ${DATASET_TITLE}

Version ${version}, by ${STUDY_AUTHOR.name}. The data is under the ${DATA_LICENSE.name} license.${doi === undefined ? "" : ` DOI: [${doi}](${doiUrl(doi)}).`}

This dataset gives the robots.txt rules of the top ${size} domains of the Tranco list for ${String(study.agents.length)} AI crawlers and agents. The study page "${articleTitle(study)}" shows the findings and the charts: ${STUDY_PAGE}

## What the study measured

For each domain, the study asked one question: what does the robots.txt file of the site tell each agent? The agents are:

${table(
  ["Agent", "Company", "Role"],
  study.agents.map((agent) => [`\`${agent.token}\``, agent.owner, ROLE_WORDS[agent.role] ?? ""]),
)}

\`PoliteCrawler\` is the crawler of the study. No site names it, so it gets the rules of the group \`*\`.

## The method

1. **The list.** The study used the top ${size} domains of the Tranco list \`${study.list.id}\` (${study.list.url}), from ${study.list.date}. Tranco makes the list from the ranks of five sources across 30 days.
2. **The requests.** The crawler polite-crawler sent one request for \`https://<domain>/robots.txt\` to each domain, and followed a maximum of 5 redirects. It did not try again, and it did not try \`www.<domain>\`. All requests went out from one computer${study.runner === undefined ? "" : ` (${study.runner})`}, with a new, empty store.
3. **The User-Agent.** Each request sent \`${study.userAgent}\`, with no contact.
4. **The verdicts.** The function \`decide\` of polite-crawler decided each agent alone, as RFC 9309 specifies. The path was \`${study.pagePath}\`, a page path that no site names. Thus a refusal of this path is a refusal of the pages of the site.
5. **The answers.** The study put each answer into one of four states:
   - \`file\` (${String(summary.withFile)} domains): a robots.txt file. The verdicts come from its rules.
   - \`none\` (${String(summary.noFile)} domains): a 404 or a 410. The site states no rules, so each agent is permitted.
   - \`blocked\` (${String(summary.blocked)} domains): the server answered with a refusal, a challenge or an error in place of the file. The rules of the site are not known.
   - \`unreachable\` (${String(summary.unreachable)} domains): the crawler got no file that it could read. Examples are no address in the DNS, a TLS error, a timeout, more than 5 redirects, a body that it could not decode, or an HTML page in place of the file.

The shares on the study page count only the states \`file\` and \`none\`: ${String(summary.answered)} sites.

## The dates

- The Tranco list: ${study.list.date}.
- The requests: from \`${study.fetched.from}\` to \`${study.fetched.to}\` (UTC).
- The version of the dataset: ${version}, the day of the requests.

## The files

- \`robots-study.csv\`: one row for each domain, with its state and one column for each agent.
- \`robots-study.json\`: the same domains, with the lines of robots.txt that decided each verdict.
- \`README.md\`: this file.
- \`CITATION.cff\`: the citation, in the Citation File Format.

## The columns of robots-study.csv

${table(
  ["Column", "Meaning"],
  [
    ["`rank`", "The rank of the domain in the Tranco list, from 1."],
    ["`domain`", "The domain of the list."],
    [
      "`host`",
      "The host of the last answer. It is different from the domain when a redirect went to a different host.",
    ],
    ["`state`", "`file`, `none`, `blocked` or `unreachable`. The method above tells each state."],
    ["`status`", "The HTTP status of the last answer. The value 0 means no answer."],
    ["`html`", "`yes` when the site gave an HTML page in place of the file."],
    ["`reason`", "Why the domain is blocked or unreachable, in a maximum of 160 characters."],
    ["`bytes`", "The size of the robots.txt file in bytes. Only for the state `file`."],
    ["`groups`", "The number of groups in the file. Only for the state `file`."],
    [
      "`crawl_delay_s`",
      "The crawl delay in seconds that the file gives to `PoliteCrawler`, when it gives one.",
    ],
    [
      "`content_signals`",
      "The `Content-Signal` and `Content-Usage` lines of the file, each line one time, with a vertical bar between two lines.",
    ],
    [
      tokens.join(", "),
      "The verdict for the agent on the page path. The cell is empty when the domain is blocked or unreachable.",
    ],
  ],
)}

The verdicts:

- \`refused-named\`: a group that names the agent refuses it.
- \`refused-star\`: no group names the agent, and the group \`*\` refuses it.
- \`permitted-named\`: a group that names the agent permits it.
- \`permitted\`: no group refuses the agent.

## The fields of robots-study.json

- \`list\`: the Tranco list (\`name\`, \`id\`, \`date\`, \`url\`, \`size\`).
- \`fetched\`: the time of the first request and of the last answer (\`from\`, \`to\`), in ISO 8601 and UTC.
- \`userAgent\`, \`pagePath\` and \`license\` (an SPDX id).
- \`runner\`: the computer that sent the requests, for example a GitHub Actions runner. The first run does not have this field.
- \`agents\`: the agents, in the sequence of the codes (\`token\`, \`owner\`, \`role\`). The role is \`training\`, \`search\`, \`user\` or \`control\`.
- \`sites\`: one object for each domain, in the sequence of the ranks:
  - \`rank\`, \`domain\`, \`status\`, \`state\`, and \`host\` when it is different from the domain.
  - \`reason\` and \`html\`, as in the CSV.
  - \`bytes\`, \`groups\`, \`delay\` (the crawl delay in seconds), \`signals\` (the usage lines) and \`sitemaps\` (the number of \`Sitemap\` lines). These fields are only for the state \`file\`.
  - \`p\`: one code for each agent on the page path. \`N\`: a group that names the agent refuses it. \`S\`: the group \`*\` refuses it. \`n\`: a group that names the agent permits it. \`.\`: no group refuses it. \`B\`: blocked at the edge. \`U\`: unreachable.
  - \`h\`: the codes for the home page \`/\`, only when they are different from \`p\`.
  - \`r\`: for each agent, the line of the group and the line of the rule that decided, or 0 when no rule decided.
  - \`lines\`: the text of each line that \`r\` names, in a maximum of 160 characters.

## The limits

${limits.map((limit) => `- ${limit}`).join("\n")}

## The license

The data is under the ${DATA_LICENSE.name} license (${DATA_LICENSE.url}). You can use it for any purpose when you name the source. The code of polite-crawler and the script that made the data are under the MIT license.

## The versions

${versionsOf(version, doi, concept)}

## Each month

1. On day 2 of each month, the workflow \`study-monthly.yml\` of the repository runs the study again on a GitHub Actions runner. It opens a pull request with the new data and the checks of the site.
2. A person reviews the pull request and merges it.
3. The workflow \`study-zenodo.yml\` makes a new version of the record on Zenodo, as a draft.
4. The owner checks the draft on Zenodo and publishes it.
5. The site records the new version: its DOI goes into the history of the runs and on the study page.

## How to cite

${cite}${citeStudy}

## The source

- The script that sent the requests and wrote the data: ${REPOSITORY}/blob/main/packages/site/scripts/robots-study.ts
- The script that makes this dataset: ${REPOSITORY}/blob/main/packages/site/scripts/study-dataset.ts
`;
};

/** This function gives a YAML scalar. A JSON string is also a YAML string. */
const yaml = (value: string): string => JSON.stringify(value);

/** This function gives the `CITATION.cff` of the dataset (Citation File Format 1.2.0). */
export const citationCff = (study: Study, doi?: string, concept?: string): string => {
  const version = studyVersion(study);
  const [family, given] = CITATION_AUTHOR.split(", ");
  const lines = [
    "cff-version: 1.2.0",
    `message: ${yaml("To cite this dataset, use these metadata.")}`,
    "type: dataset",
    `title: ${yaml(DATASET_TITLE)}`,
    "authors:",
    `  - family-names: ${yaml(family ?? "")}`,
    `    given-names: ${yaml(given ?? "")}`,
    `version: ${yaml(version)}`,
    `date-released: ${yaml(version)}`,
    ...(doi === undefined ? [] : [`doi: ${yaml(doi)}`]),
    ...(concept === undefined
      ? []
      : [
          "identifiers:",
          "  - type: doi",
          `    value: ${yaml(concept)}`,
          `    description: ${yaml("The concept DOI: the study and all its versions")}`,
        ]),
    `license: ${DATA_LICENSE.id}`,
    `url: ${yaml(STUDY_PAGE)}`,
    `repository-code: ${yaml(REPOSITORY)}`,
    `abstract: ${yaml(abstractOf(study))}`,
    "keywords:",
    ...STUDY_KEYWORDS.map((keyword) => `  - ${yaml(keyword)}`),
  ];
  return `${lines.join("\n")}\n`;
};

/** This function gives one paragraph that tells what the dataset contains. */
const abstractOf = (study: Study): string =>
  `For each of the top ${study.sites.length.toLocaleString("en-US")} domains of the Tranco list ${study.list.id}, the answer to one request for /robots.txt on ${studyVersion(study)}, and the robots.txt verdict for ${String(study.agents.length)} user agents: ${study.agents.map((agent) => agent.token).join(", ")}. The data also gives the lines that decided each verdict, the content signals and the crawl delays.`;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * This function gives the files of the dataset, sorted by name. It fails when the CSV is not the CSV
 * of the JSON, so the two files always agree.
 */
export const datasetFiles = (input: DatasetInput): readonly DatasetFile[] => {
  const study = JSON.parse(decoder.decode(input.json)) as Study;
  if (decoder.decode(input.csv) !== toCsv(study))
    throw new Error("robots-study.csv is not the CSV of robots-study.json: run the derive step");
  if (input.doi !== undefined && !isDoi(input.doi)) throw new Error(`not a DOI: ${input.doi}`);
  if (input.concept !== undefined && !isDoi(input.concept))
    throw new Error(`not a DOI: ${input.concept}`);
  const limits = limitsOf(input.page);
  const files: DatasetFile[] = [
    { name: "CITATION.cff", bytes: encoder.encode(citationCff(study, input.doi, input.concept)) },
    { name: "README.md", bytes: encoder.encode(readme(study, limits, input.doi, input.concept)) },
    { name: "robots-study.csv", bytes: input.csv },
    { name: "robots-study.json", bytes: input.json },
  ];
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

/** The metadata of a record on Zenodo, in the form of the deposit API. */
export interface ZenodoMetadata {
  readonly upload_type: "dataset";
  readonly publication_date: string;
  readonly title: string;
  readonly creators: ReadonlyArray<{ readonly name: string }>;
  readonly description: string;
  readonly access_right: "open";
  readonly license: string;
  readonly keywords: readonly string[];
  readonly related_identifiers: ReadonlyArray<{
    readonly identifier: string;
    readonly relation: string;
  }>;
  readonly contributors: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  readonly notes: string;
  readonly version: string;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * This function gives the metadata of the record on Zenodo. The version and the date of publication
 * are the day of the run. The press contact goes in the notes, because the deposit API has no field
 * for an address.
 */
export const zenodoMetadata = (study: Study): ZenodoMetadata => {
  const version = studyVersion(study);
  const summary = summarize(study);
  const paragraphs = [
    abstractOf(study),
    `The crawler polite-crawler sent the requests from ${study.fetched.from} to ${study.fetched.to} (UTC), and decided each agent with RFC 9309. Of the ${String(summary.listSize)} domains, ${String(summary.withFile)} answered with a robots.txt file and ${String(summary.noFile)} with no file. ${String(summary.blocked)} blocked the request at the edge, and ${String(summary.unreachable)} were unreachable.`,
    "The files: robots-study.csv (one row for each domain), robots-study.json (the same domains, with the lines that decided), README.md (the method, the columns, the dates and the limits) and CITATION.cff.",
  ];
  const link = `<p>The study page tells the method, the findings and the limits: <a href="${STUDY_PAGE}">${escapeHtml(articleTitle(study))}</a>.</p>`;
  return {
    upload_type: "dataset",
    publication_date: version,
    title: DATASET_TITLE,
    creators: [{ name: CITATION_AUTHOR }],
    description: `${paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join("")}${link}`,
    access_right: "open",
    license: "cc-by-4.0",
    keywords: STUDY_KEYWORDS,
    related_identifiers: [
      { identifier: STUDY_PAGE, relation: "isSupplementTo" },
      { identifier: REPOSITORY, relation: "isSupplementTo" },
    ],
    contributors: [{ name: CITATION_AUTHOR, type: "ContactPerson" }],
    notes: `Press contact: ${PRESS_CONTACT.email}`,
    version,
  };
};

/** This function gives the text of `study-doi.json`: a DOI, the version that it names and the concept DOI. */
export const studyDoiFile = (doi: string, version: string, concept: string | null): string =>
  `${JSON.stringify({ doi, version, concept } satisfies StudyDoi, null, 2)}\n`;
