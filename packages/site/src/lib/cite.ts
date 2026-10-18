/**
 * The citation of the robots.txt study: the title of the dataset, its DOI on Zenodo, the BibTeX entry
 * and the press contact. The study page, its structured data and the dataset for Zenodo read these
 * values, so they agree.
 */
import type { Study } from "./study.ts";
import { DATA_LICENSE, STUDY_AUTHOR } from "./study.ts";

/** This address is the site of polite-crawler, with a `/` at the end. A feed and llms.txt use full addresses. */
export const SITE_URL = "https://mark1russell7.github.io/crawler/";
/** This address is the page of the study. */
export const STUDY_PAGE = `${SITE_URL}notes/robots-txt-ai-agents/`;
/** This day is the day of the first version of the study. A new run changes the date of the data, not this day. */
export const STUDY_PUBLISHED = "2026-10-12";
/** This address is the repository of the crawler and of the study script. */
export const REPOSITORY = "https://github.com/mark1russell7/crawler";
/** This text is the title of the dataset on Zenodo. */
export const DATASET_TITLE = "Robots.txt rules for AI crawlers on popular sites";
/** This name is the author, with the family name first, as a citation writes it. */
export const CITATION_AUTHOR = "Russell, Mark";

/**
 * This value is the press contact of the study. The owner chose to show this address in public. It
 * goes on the study page, in the structured data of the dataset and in the record on Zenodo. It goes
 * nowhere else: not in a User-Agent, not in the code of the package and not on the page for site owners.
 */
export const PRESS_CONTACT = { email: "marktheprogrammer17@gmail.com" } as const;

/** These words are the keywords of the dataset, in the structured data and on Zenodo. */
export const STUDY_KEYWORDS: readonly string[] = [
  "robots.txt",
  "AI crawlers",
  "GPTBot",
  "ClaudeBot",
  "Claude-User",
  "ChatGPT-User",
  "Google-Extended",
  "CCBot",
  "content signals",
  "RFC 9309",
];

/** This function gives the version of the study: the day of the run, as `YYYY-MM-DD` in UTC. */
export const studyVersion = (study: Study): string => study.fetched.from.slice(0, 10);

/**
 * The file `study-doi.json` names the DOIs of the dataset on Zenodo. Each value is null until Zenodo
 * publishes the record.
 *
 * - `doi` is the DOI of one version: the data of one run.
 * - `version` is the version of the study that `doi` names.
 * - `concept` is the concept DOI. It names the study and all its versions, and it resolves to the
 *   newest version.
 */
export interface StudyDoi {
  readonly doi: string | null;
  readonly version: string | null;
  readonly concept: string | null;
}

const DOI = /^10\.\d{4,9}\/\S+$/;

/** This function tells if a text is a DOI, for example `10.5281/zenodo.1234567`. */
export const isDoi = (value: string): boolean => DOI.test(value);

/**
 * This function gives the DOI of the dataset, or undefined. It gives the DOI only when the file names
 * one and its version is the version of the study on the page. Thus the page does not show the DOI
 * of an earlier run.
 */
export const doiOf = (study: Study, file: StudyDoi): string | undefined =>
  file.doi !== null && isDoi(file.doi) && file.version === studyVersion(study)
    ? file.doi
    : undefined;

/** This function gives the concept DOI of the study, or undefined when the file names no DOI. */
export const conceptOf = (file: StudyDoi): string | undefined =>
  file.concept !== null && isDoi(file.concept) ? file.concept : undefined;

/** This function gives the address of a DOI. */
export const doiUrl = (doi: string): string => `https://doi.org/${doi}`;

/** This function gives the title of the article on the study page. */
export const articleTitle = (study: Study): string =>
  `Who lets AI agents in? The robots.txt rules of the top ${study.sites.length.toLocaleString("en-US")} domains`;

/** This function gives the citation of the dataset as one line of text, with no publisher and no address. */
export const datasetCitation = (study: Study): string => {
  const version = studyVersion(study);
  return `${CITATION_AUTHOR}. ${version.slice(0, 4)}. "${DATASET_TITLE}." Version ${version}. Dataset.`;
};

/**
 * This function gives the citation of the study as one line of text, for the concept DOI. It names
 * no version, because the concept DOI names each version.
 */
export const studyCitation = (): string =>
  `${CITATION_AUTHOR}. ${STUDY_PUBLISHED.slice(0, 4)}. "${DATASET_TITLE}." Dataset, a new version each month.`;

/**
 * This function gives a BibTeX entry for the study. With a DOI, the entry names the dataset on
 * Zenodo. With no DOI, it names the article on the study page.
 */
export const bibtex = (study: Study, doi: string | undefined): string => {
  const version = studyVersion(study);
  const year = version.slice(0, 4);
  // braces keep the case of a word that a style can change to lowercase
  const fields: ReadonlyArray<readonly [string, string]> =
    doi === undefined
      ? [
          ["author", CITATION_AUTHOR],
          ["title", `{${articleTitle(study)}}`],
          ["howpublished", "polite-crawler field notes"],
          ["year", year],
          ["note", `Version ${version}. Data under ${DATA_LICENSE.name}`],
          ["url", STUDY_PAGE],
        ]
      : [
          ["author", CITATION_AUTHOR],
          ["title", DATASET_TITLE.replace("AI", "{AI}")],
          ["year", year],
          ["version", version],
          ["publisher", "Zenodo"],
          ["doi", doi],
          ["url", doiUrl(doi)],
        ];
  const width = Math.max(...fields.map(([key]) => key.length));
  const body = fields.map(([key, value]) => `  ${key.padEnd(width)} = {${value}}`).join(",\n");
  return `@misc{russell${year}robots,\n${body}\n}`;
};

/**
 * This function gives the creator of the dataset for the structured data: the author, with the press
 * contact as a `ContactPoint`. Schema.org puts a contact point on a person, not on a dataset.
 */
export const datasetCreator = (): Record<string, unknown> => ({
  "@type": "Person",
  name: STUDY_AUTHOR.name,
  url: STUDY_AUTHOR.url,
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "press",
    email: PRESS_CONTACT.email,
  },
});
