/**
 * The head of each page, after Starlight makes it. This middleware sets the title for search, the
 * structured data and the description of the study from the dataset. It also keeps the 404 page out of
 * the index. Starlight starts it for each page (the `routeMiddleware` of the site config).
 */
import type { StarlightRouteData } from "@astrojs/starlight/route-data";
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import pkg from "polite-crawler/package.json";
import font from "../node_modules/@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2?url";
import study from "./data/robots-study.json";
import studyDoi from "./data/study-doi.json";
import { STUDY_KEYWORDS, STUDY_PUBLISHED, datasetCreator, doiOf, doiUrl } from "./lib/cite.ts";
import { FEED_PATH, FEED_TITLE } from "./lib/feed.ts";
import type { Study } from "./lib/study.ts";
import { DATA_LICENSE, STUDY_AUTHOR, headline, summarize } from "./lib/study.ts";

const SITE = "https://mark1russell7.github.io/crawler/";
const NAME = "polite-crawler";
const STUDY_ID = "notes/robots-txt-ai-agents";
/** The base of the build, with a `/` at the end: `/crawler/`. */
const BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/`;

type HeadEntry = {
  tag: string;
  attrs?: Record<string, string | boolean | undefined>;
  content?: string;
};

const author = { "@type": "Person", name: STUDY_AUTHOR.name, url: STUDY_AUTHOR.url };

const jsonLd = (data: unknown): HeadEntry => ({
  tag: "script",
  attrs: { type: "application/ld+json" },
  content: JSON.stringify(data).replace(/</g, "\\u003c"),
});

/** The description of the study, with its numbers from the dataset. */
const studyDescription = (): string => {
  const { gpt, claudeUser } = headline(study as unknown as Study);
  return `${String(Math.round(gpt.share))}% of the top 1,000 domains that answered block GPTBot in robots.txt, and ${String(Math.round(claudeUser.share))}% block Claude-User. See the rule behind each verdict.`;
};

/**
 * The structured data of the study: the dataset and the article. The dataset names the press contact
 * on its creator, and its DOI when Zenodo has published the record.
 */
const studyData = (url: string, title: string, description: string): unknown => {
  const data = study as unknown as Study;
  const summary = summarize(data);
  const modified = data.fetched.from.slice(0, 10);
  const doi = doiOf(data, studyDoi);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        headline: title,
        description,
        url,
        mainEntityOfPage: url,
        image: `${SITE}og-robots-study.png`,
        author,
        datePublished: STUDY_PUBLISHED,
        dateModified: modified,
        license: DATA_LICENSE.url,
      },
      {
        "@type": "Dataset",
        name: "The robots.txt rules for AI agents of the top 1,000 domains",
        description: `For each of the top ${String(summary.listSize)} domains of the Tranco list ${data.list.id}: the state of the answer, the robots.txt verdict for ${String(data.agents.length)} user agents (${data.agents.map((agent) => agent.token).join(", ")}), the lines that decided, the content signals and the crawl delays.`,
        url,
        ...(doi === undefined ? {} : { identifier: doiUrl(doi) }),
        keywords: STUDY_KEYWORDS,
        creator: datasetCreator(),
        datePublished: STUDY_PUBLISHED,
        dateModified: modified,
        temporalCoverage: modified,
        isBasedOn: data.list.url,
        // the same data in the repository, and the package that made it
        sameAs: [
          "https://github.com/mark1russell7/crawler/tree/main/packages/site/src/data",
          "https://www.npmjs.com/package/polite-crawler",
        ],
        license: DATA_LICENSE.url,
        isAccessibleForFree: true,
        measurementTechnique:
          "One request for /robots.txt for each domain, decided with RFC 9309 by polite-crawler",
        variableMeasured: [
          "The state of the answer: a robots.txt file, no file, blocked at the edge, or unreachable",
          ...data.agents.map((agent) => `The verdict for ${agent.token}`),
          "Content-Signal lines",
          "Crawl-delay",
        ],
        distribution: [
          {
            "@type": "DataDownload",
            encodingFormat: "application/json",
            contentUrl: `${SITE}data/robots-study.json`,
          },
          {
            "@type": "DataDownload",
            encodingFormat: "text/csv",
            contentUrl: `${SITE}data/robots-study.csv`,
          },
        ],
      },
    ],
  };
};

const homeData = (description: string): unknown => ({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", name: NAME, url: SITE },
    {
      "@type": "SoftwareSourceCode",
      name: NAME,
      description,
      codeRepository: "https://github.com/mark1russell7/crawler",
      programmingLanguage: "TypeScript",
      runtimePlatform: "Node.js",
      license: "https://opensource.org/licenses/MIT",
      url: SITE,
      author,
    },
    {
      "@type": "SoftwareApplication",
      name: NAME,
      description,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Windows, macOS, Linux",
      softwareVersion: pkg.version,
      downloadUrl: "https://www.npmjs.com/package/polite-crawler",
      sameAs: [
        "https://github.com/mark1russell7/crawler",
        "https://www.npmjs.com/package/polite-crawler",
      ],
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      url: SITE,
      author,
    },
  ],
});

const toolData = (url: string, title: string, description: string): unknown => ({
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: title,
  description,
  url,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Any",
  browserRequirements: "Requires JavaScript",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  author,
});

const breadcrumbs = (url: string, title: string): unknown => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: NAME, item: SITE },
    { "@type": "ListItem", position: 2, name: title, item: url },
  ],
});

export const onRequest = defineRouteMiddleware((context) => {
  // the type of the locals comes from the generated types of Astro, which tsc does not read
  const route = (context.locals as { starlightRoute: StarlightRouteData }).starlightRoute;
  const head = route.head as HeadEntry[];
  const data = route.entry.data as { title: string; description?: string; seoTitle?: string };
  const id = route.id;
  const home = id === "" || id === "index";
  const url = new URL(`${id}/`.replace(/^index\/$|^\/$/, ""), SITE).href;
  const meta = (key: "name" | "property", value: string): HeadEntry | undefined =>
    head.find((entry) => entry.tag === "meta" && entry.attrs?.[key] === value);
  const setMeta = (key: "name" | "property", value: string, content: string): void => {
    const entry = meta(key, value);
    if (entry?.attrs !== undefined) entry.attrs["content"] = content;
    else head.push({ tag: "meta", attrs: { [key]: value, content } });
  };

  // the title for search: a page can set seoTitle, and the H1 keeps its title
  const title = data.seoTitle ?? data.title;
  const full = title.includes(NAME) ? title : `${title} | ${NAME}`;
  const titleTag = head.find((entry) => entry.tag === "title");
  if (titleTag !== undefined) titleTag.content = full;
  setMeta("property", "og:title", title);

  let description = data.description ?? "";
  if (id === STUDY_ID) {
    description = studyDescription();
    setMeta("name", "description", description);
    setMeta("property", "og:description", description);
    setMeta("property", "article:published_time", STUDY_PUBLISHED);
    setMeta(
      "property",
      "article:modified_time",
      (study as unknown as Study).fetched.from.slice(0, 10),
    );
    setMeta("property", "article:author", STUDY_AUTHOR.name);
    // the feed of the monthly runs, for a feed reader that finds feeds in the head of a page
    head.push({
      tag: "link",
      attrs: {
        rel: "alternate",
        type: "application/rss+xml",
        title: FEED_TITLE,
        href: `${BASE}${FEED_PATH}`,
      },
    });
  }

  // the 404 page is not a page to index, and its address is not its own
  if (id === "404") {
    for (let index = head.length - 1; index >= 0; index -= 1) {
      const entry = head[index]!;
      if (
        (entry.tag === "link" && entry.attrs?.["rel"] === "canonical") ||
        (entry.tag === "meta" && entry.attrs?.["property"] === "og:url")
      )
        head.splice(index, 1);
    }
    head.push({ tag: "meta", attrs: { name: "robots", content: "noindex" } });
    return;
  }

  // the text font, before the style sheet asks for it
  head.push({
    tag: "link",
    attrs: { rel: "preload", href: font, as: "font", type: "font/woff2", crossorigin: true },
  });

  if (home) head.push(jsonLd(homeData(description)));
  else head.push(jsonLd(breadcrumbs(url, title)));
  if (id.startsWith("tools/")) head.push(jsonLd(toolData(url, title, description)));
  if (id === STUDY_ID) head.push(jsonLd(studyData(url, title, description)));
});
