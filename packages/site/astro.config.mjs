// The site of polite-crawler: the guide, the tools and the reference. GitHub Pages serves it at /crawler/.
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const base = process.env.SITE_BASE ?? "/crawler";
const site = "https://mark1russell7.github.io";
// The share card of each page (Open Graph and Twitter). scripts/og-image.mjs renders it.
const card = `${site}${base}/og.png`;

export default defineConfig({
  site,
  base,
  trailingSlash: "ignore",
  integrations: [
    starlight({
      title: "polite-crawler",
      description:
        "A polite web crawler for research and AI agents. It fetches a source once, keeps it, and reads it many times: robots.txt obeyed, one request per site, full-text search and an MCP server.",
      head: [
        { tag: "meta", attrs: { property: "og:image", content: card } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content: "polite-crawler: fetch once, read many times. Request bars on graph paper, one lane for each site.",
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
      ],
      components: { Hero: "./src/components/Hero.astro" },
      sidebar: [
        { label: "Start", items: ["guide/quick-start", "guide/mcp", "guide/how-it-works", "guide/politeness"] },
        { label: "Tools", items: ["tools/robots-txt-tester", "tools/page-reader", "tools/opening-hours"] },
        { label: "Field notes", items: ["notes/restaurant-websites"] },
        { label: "Reference", items: ["reference/api", "reference/cli"] },
        { label: "For site owners", items: ["bot"] },
      ],
    }),
    react(),
  ],
});
