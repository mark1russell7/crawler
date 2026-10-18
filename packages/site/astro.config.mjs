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

/** The text of a node of the HTML tree (hast). */
const textOf = (node) =>
  node.type === "text" ? node.value : (node.children ?? []).map((child) => textOf(child)).join("");

/** This function adds a class to an element of the HTML tree (hast). */
const addClass = (node, name) => {
  const names = node.properties.className;
  node.properties.className = [...(Array.isArray(names) ? names : []), name];
};

/** A break is good after these characters of a long name: `$POLITE_CRAWLER_DIR`, a path, `A=1`. */
const BREAK_AFTER = /(?<=[_/=])/;

/** The element <wbr>: a place where a line can break, with no character. */
const wbr = () => ({ type: "element", tagName: "wbr", properties: {}, children: [] });

/** This function puts a <wbr> after each "_", "/" and "=" of the text of a code element. */
const addBreaks = (node) => {
  const children = [];
  for (const child of node.children) {
    if (child.type !== "text") {
      children.push(child);
      continue;
    }
    for (const [index, part] of child.value.split(BREAK_AFTER).entries()) {
      if (index > 0) children.push(wbr());
      children.push({ type: "text", value: part });
    }
  }
  node.children = children;
};

/**
 * This rehype plugin sets where the inline code of the prose can break:
 * - A short code name with no space, for example `--allow-user-provided`, gets the class `pc-name`.
 *   The CSS keeps it on one line on a wide screen, so a line does not end with a lone "-".
 * - An option in a table cell (it starts with "-") gets the class `pc-option`, and it stays whole.
 * - In a table cell, a long name gets a <wbr> after each "_", "/" and "=", so it breaks there and
 *   not in the middle of a word.
 */
const shortCode = () => (tree) => {
  const visit = (node, parent, inCell) => {
    if (node.type === "element" && node.tagName === "code" && parent?.tagName !== "pre") {
      const text = textOf(node);
      if (text.length <= 40 && !/\s/.test(text)) addClass(node, "pc-name");
      if (inCell && text.startsWith("-") && text.length <= 28) addClass(node, "pc-option");
      if (inCell) addBreaks(node);
      return;
    }
    const cell = inCell || ["td", "th"].includes(node.tagName);
    for (const child of node.children ?? []) visit(child, node, cell);
  };
  visit(tree, undefined, false);
};

export default defineConfig({
  site,
  base,
  trailingSlash: "ignore",
  markdown: { rehypePlugins: [shortCode] },
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
          items: ["notes/robots-txt-ai-agents", "notes/restaurant-websites"],
        },
        { label: "Reference", items: ["reference/api", "reference/cli", "reference/standards"] },
        { label: "For site owners", items: ["bot", "block-ai-training-crawlers"] },
      ],
    }),
    // the islands are React code that runs on Preact (preact/compat): 9 KB of runtime in place of 69 KB (gzip)
    preact({ compat: true }),
  ],
});
