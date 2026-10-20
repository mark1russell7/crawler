// The site of polite-crawler: the guide, the tools and the reference. GitHub Pages serves it at /crawler/.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import preact from "@astrojs/preact";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { pureCrawler } from "./pure-crawler.mjs";

const base = process.env.SITE_BASE ?? "/crawler";
const site = "https://mark1russell7.github.io";
// The share card of each page (Open Graph and Twitter). scripts/og-image.mjs renders it.
const card = `${site}${base}/og.png`;

const docs = fileURLToPath(new URL("./src/content/docs/", import.meta.url));

/**
 * This function gives the date of the last commit of the page of a URL, as "Last updated" shows it.
 * With no git history (a shallow clone), it gives no date, and the sitemap has no lastmod.
 */
const lastmodOf = (url) => {
  const path = new URL(url).pathname.slice(base.length).replace(/^\/+|\/+$/g, "") || "index";
  for (const file of [`${path}.mdx`, `${path}.md`, `${path}/index.mdx`, `${path}/index.md`]) {
    const full = join(docs, file);
    if (!existsSync(full)) continue;
    try {
      return (
        execFileSync("git", ["log", "-1", "--format=%cI", "--", full], {
          encoding: "utf8",
        }).trim() || undefined
      );
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/** This function tells if a node of the HTML tree is in an element of one of these names. */
const isIn = (node, names, ctx) => {
  for (let parent = ctx.parent(node); parent !== undefined; parent = ctx.parent(parent)) {
    if (parent.type === "element" && names.includes(parent.tagName)) return true;
  }
  return false;
};

/**
 * A break is good after these characters of a long name: `$POLITE_CRAWLER_DIR`, a path, `A=1`, and
 * a "-" inside a word (`--allow-user-provided`), but not between the two "-" at the start.
 */
const BREAK_AFTER = /(?<=[_/=]|[^-]-)/;

/** The children of a code element: the parts of its text, with a <wbr> between two parts. */
const withBreaks = (parts) => {
  const children = [];
  for (const [index, part] of parts.entries()) {
    if (index > 0) children.push({ type: "element", tagName: "wbr", properties: {}, children: [] });
    children.push({ type: "text", value: part });
  }
  return children;
};

/**
 * This Sätteri plugin sets how the code and the tables of the prose break:
 * - A short code name with no space, for example `--allow-user-provided`, gets the class `pc-name`.
 *   The CSS keeps it on one line on a wide screen, so a line does not end with a lone "-".
 * - An option in a table cell (it starts with "-") gets the class `pc-option`, and it stays whole.
 * - In a table cell, a long name gets a <wbr> after each "_", "/", "=" and inner "-", so it breaks
 *   there and not in the middle of a word.
 */
const proseCode = {
  name: "polite-crawler-prose-code",
  element: [
    {
      filter: ["code"],
      visit(node, ctx) {
        if (isIn(node, ["pre"], ctx)) return undefined;
        const text = ctx.textContent(node);
        const inCell = isIn(node, ["td", "th"], ctx);
        const classes = [];
        if (text.length <= 40 && !/\s/.test(text)) classes.push("pc-name");
        if (inCell && text.startsWith("-") && text.length <= 28) classes.push("pc-option");
        if (classes.length === 0 && !inCell) return undefined;
        const parts = inCell ? text.split(BREAK_AFTER) : [text];
        return {
          type: "element",
          tagName: "code",
          properties: { ...node.properties, class: classes.join(" ") },
          children: withBreaks(parts),
        };
      },
    },
  ],
};

/** A table of this number of columns or more is a card table: a phone shows each row as a card. */
const CARD_COLUMNS = 3;

/**
 * The class of a card table. Do not use a class of a figure here: the class `pc-stack` of the
 * stacked bars (`display: flex` and a height of 28px) once made the rows of the tables disappear.
 */
const CARDS = "pc-cards";

/**
 * The roles of the parts of a card table. A phone shows a card table with `display: block`, and some
 * browsers then do not tell a screen reader that it is a table. The roles keep the table for them.
 */
const ROLES = {
  table: "table",
  thead: "rowgroup",
  tbody: "rowgroup",
  tr: "row",
  th: "columnheader",
  td: "cell",
};

/** The element children of a node of the HTML tree (hast), all of them or those of one tag name. */
const elementsOf = (node, tagName) =>
  (node?.children ?? []).filter(
    (child) => child.type === "element" && (tagName === undefined || child.tagName === tagName),
  );

/** The names of the columns of a table: the text of each cell of the first row of its head. */
const columnsOf = (table, ctx) => {
  const head = elementsOf(elementsOf(table, "thead")[0], "tr")[0];
  return elementsOf(head, "th").map((th) => ctx.textContent(th).trim());
};

/** The nearest table around a node of the HTML tree, or undefined. */
const tableOf = (node, ctx) => {
  for (let parent = ctx.parent(node); parent !== undefined; parent = ctx.parent(parent)) {
    if (parent.type === "element" && parent.tagName === "table") return parent;
  }
  return undefined;
};

/**
 * This Sätteri plugin makes card tables: the tables of the prose with three or more columns.
 * - The table gets the class `pc-cards`. On a phone, the CSS of theme.css shows each row as a card.
 * - Each cell gets the name of its column in `data-label`. The card shows it before the value.
 * - Each part of the table gets its role (ROLES).
 * At each other width, a card table looks as a table with no class. A table of two columns stays a table.
 */
const proseTables = {
  name: "polite-crawler-prose-tables",
  element: [
    {
      filter: ["table"],
      visit(node, ctx) {
        if (columnsOf(node, ctx).length < CARD_COLUMNS) return;
        ctx.setProperty(node, "class", CARDS);
        ctx.setProperty(node, "role", ROLES.table);
      },
    },
    {
      filter: ["thead", "tbody", "tr", "th", "td"],
      visit(node, ctx) {
        const table = tableOf(node, ctx);
        if (table === undefined) return;
        const columns = columnsOf(table, ctx);
        if (columns.length < CARD_COLUMNS) return;
        ctx.setProperty(node, "role", ROLES[node.tagName]);
        if (node.tagName !== "td") return;
        // the column of the cell: the number of the element cells before it in its row
        const before = (ctx.parent(node).children ?? []).slice(0, ctx.indexOf(node) ?? 0);
        const column = before.filter((child) => child.type === "element").length;
        ctx.setProperty(node, "data-label", columns[column] ?? "");
      },
    },
  ],
};

const NO_PLUGINS =
  "the Markdown processor has no hastPlugins: the code of the prose wraps as before, and no table is a card table";

/** This integration adds `proseCode` and `proseTables` to the Markdown processor (Sätteri), as Starlight does. */
const proseCodeIntegration = {
  name: "polite-crawler-prose-code",
  hooks: {
    "astro:config:setup": ({ config, logger }) => {
      const plugins = config.markdown?.processor?.options?.hastPlugins;
      if (Array.isArray(plugins)) plugins.push(proseCode, proseTables);
      else logger.warn(NO_PLUGINS);
    },
  },
};

export default defineConfig({
  site,
  base,
  trailingSlash: "ignore",
  // the islands and their workers use the pure parts of polite-crawler, with no Node.js part (pure-crawler.mjs)
  // the workers are ES modules ({ type: "module" }), so a worker can have chunks of its own
  vite: { plugins: [pureCrawler()], worker: { format: "es", plugins: () => [pureCrawler()] } },
  integrations: [
    // the sitemap of the site, with the date of each page: Starlight adds no second one when this one is here
    sitemap({
      serialize: (item) => {
        const lastmod = lastmodOf(item.url);
        return lastmod === undefined ? item : { ...item, lastmod };
      },
    }),
    starlight({
      title: "polite-crawler",
      description:
        "A polite web crawler and MCP server for AI agents. It obeys robots.txt, sends one request at a time to each site, and keeps each page for search and citations.",
      head: [
        { tag: "meta", attrs: { property: "og:image", content: card } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content:
              "polite-crawler: fetch once, read many times. Request bars on graph paper, one lane for each site.",
          },
        },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: card } },
        { tag: "meta", attrs: { name: "theme-color", content: "#2346c4" } },
        {
          tag: "meta",
          attrs: {
            name: "keywords",
            content:
              "web crawler, polite crawler, robots.txt, robots.txt tester, RFC 9309, web scraping, MCP server, Model Context Protocol, Claude, AI agent, LLM research, full-text search, SQLite FTS5, headless browser, Playwright, JSON-LD, opening hours parser, content signals, Node.js, TypeScript",
          },
        },
      ],
      logo: { src: "./src/assets/mark.svg", replacesTitle: false },
      favicon: "/favicon.svg",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/mark1russell7/crawler" },
        { icon: "npm", label: "npm", href: "https://www.npmjs.com/package/polite-crawler" },
      ],
      editLink: { baseUrl: "https://github.com/mark1russell7/crawler/edit/main/packages/site/" },
      customCss: [
        "@fontsource-variable/atkinson-hyperlegible-next",
        "@fontsource-variable/atkinson-hyperlegible-mono",
        "./src/styles/tokens.css",
        "./src/styles/theme.css",
        "./src/styles/study.css",
        "./src/styles/home.css",
        "./src/styles/visuals.css",
      ],
      // the search loads the Pagefind UI at the first use (src/components/Search.astro)
      components: { Hero: "./src/components/Hero.astro", Search: "./src/components/Search.astro" },
      // a long line of code wraps, so a code block never scrolls sideways on a phone
      expressiveCode: { defaultProps: { wrap: true } },
      // the title for search, the structured data and the description of the study (src/routeData.ts)
      routeMiddleware: "./src/routeData.ts",
      // the date of the last commit of each page (the Pages workflow needs the full history for it)
      lastUpdated: true,
      sidebar: [
        {
          label: "Start",
          items: [
            "guide/quick-start",
            "guide/mcp",
            "guide/how-it-works",
            "guide/search",
            "guide/recipes",
            "guide/daemon",
            "guide/politeness",
            "guide/compare",
          ],
        },
        {
          label: "Tools",
          items: [
            "tools/robots-txt-tester",
            "tools/page-reader",
            "tools/opening-hours",
            "tools/recipe-reader",
          ],
        },
        {
          label: "Field notes",
          items: [
            "notes/robots-txt-ai-agents",
            "notes/restaurant-websites",
            "notes/tokens-per-claim",
          ],
        },
        { label: "Reference", items: ["reference/api", "reference/cli", "reference/standards"] },
        { label: "For site owners", items: ["bot", "block-ai-training-crawlers"] },
        // the pages of @mark1russell7/site-pages: the Pages workflow writes them at deploy time
        {
          label: "Project",
          items: [
            { label: "Releases", link: "https://mark1russell7.github.io/crawler/releases/" },
            { label: "Status", link: "https://mark1russell7.github.io/crawler/status/" },
          ],
        },
      ],
    }),
    // the islands are React code that runs on Preact (preact/compat): 9 KB of runtime in place of 69 KB (gzip)
    preact({ compat: true }),
    // after Starlight, which sets the Markdown processor
    proseCodeIntegration,
  ],
});
