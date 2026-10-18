// The islands of the site start pure parts of polite-crawler: the recipe readers, the fusion of
// hybrid search, the schedule of the daemon and the recipe SDK. The modules of these parts also
// import the Node.js parts of the crawler (the fetch, the index, the file system). This plugin
// lets the build keep only the pure code, for the browser and for the HTML of each page:
//
// - Each module of the package source is free of side effects. Thus the bundler drops each module
//   whose exports the page does not use.
// - An import of a Node.js module or of a server package (undici, the MCP SDK) from the package
//   source gets an empty stand-in. The site never calls it: the code that uses it is not in the
//   bundle. In `astro dev`, which does not drop code, the stand-in lets the modules load.
// - The HTML reader (linkedom and Readability) is real, but an island that does not read HTML
//   gets none of it.
// - A constant that a module makes with Buffer when it loads (`const CRLF2 = Buffer.from(...)` in
//   fallback.ts) is pure for the bundler, and undefined where Buffer does not exist. The browser
//   has no Buffer, and the code that uses such a constant is not in the bundle.
//
// The tests of the site (vitest) do not use this plugin: they use the real modules.
import { readFileSync } from "node:fs";

/** A module of the source of polite-crawler. */
const SOURCE = /[\\/]polite-crawler[\\/]src[\\/][^\\/]+\.ts$/;
/** A constant of a module that Node.js makes with Buffer when the module loads. */
const BUFFER_CONSTANT = /^(\s*(?:export\s+)?const\s+[\w$]+\s*=\s*)Buffer\.from\(([^()\n]*)\);$/gm;
/** A Node.js module, or a package by its name. A virtual module of Vite starts with a NUL character. */
const PACKAGE = /^(?:node:|(?:@[\w.~-]+\/)?[\w~-][\w.~-]*(?:\/|$))/;
/** The packages that the pure parts use in the browser: the HTML reader. */
const BROWSER_SAFE = new Set(["linkedom", "@mozilla/readability"]);
const STAND_IN = "\0polite-crawler-stand-in:";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The names that a module imports from a source, so that the stand-in can export each one. */
const namesOf = (file, source) => {
  let code = "";
  try {
    code = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const names = new Set();
  const from = new RegExp(
    `import\\s+(?!type\\b)([^;]*?)\\s+from\\s+["']${escape(source)}["']`,
    "g",
  );
  for (const [, clause] of code.matchAll(from)) {
    const braces = /\{([\s\S]*)\}/.exec(clause ?? "");
    for (const part of (braces?.[1] ?? "").split(",")) {
      // "a as b" imports the export a
      const words = part.trim().split(/\s+/);
      if (words[0] === "type" || words[0] === "") continue;
      names.add(words[0]);
    }
  }
  // "import * as zlib": the stand-in exports each property that the module reads
  const namespace = new RegExp(
    `import\\s+\\*\\s+as\\s+([\\w$]+)\\s+from\\s+["']${escape(source)}["']`,
  ).exec(code)?.[1];
  if (namespace !== undefined) {
    const read = new RegExp(`\\b${escape(namespace)}\\.([\\w$]+)`, "g");
    for (const [, name] of code.matchAll(read)) names.add(name);
  }
  return [...names].filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && name !== "default");
};

/**
 * The stand-in of a module: each property gives the stand-in again, and a call or a `new` throws.
 * Thus a module loads, and a use of the missing part stops with an error, not with a wrong value.
 */
const standIn = (source, names) =>
  [
    `const missing = () => { throw new Error(${JSON.stringify(`${source} is not part of the site build`)}); };`,
    "const nothing = new Proxy(function () {}, {",
    '  get: (target, key) => (key === Symbol.toPrimitive ? () => "" : nothing),',
    "  apply: missing,",
    "  construct: missing,",
    "});",
    "export default nothing;",
    ...names.map((name) => `export const ${name} = nothing;`),
  ].join("\n");

/** This plugin of Vite gives the pure parts of polite-crawler to the build, with no Node.js part. */
export const pureCrawler = () => ({
  name: "pure-crawler",
  enforce: "pre",
  async resolveId(source, importer, options) {
    const fromSite = source === "polite-crawler" || source.startsWith("polite-crawler/");
    const fromSource = importer !== undefined && SOURCE.test(importer);
    if (!fromSite && !fromSource) return null;
    if (fromSite || source.startsWith(".")) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved === null || !SOURCE.test(resolved.id)) return resolved;
      return { ...resolved, moduleSideEffects: false };
    }
    if (!PACKAGE.test(source) || source.startsWith("vite")) return null;
    // the HTML reader: an island that does not read HTML gets none of it
    if (BROWSER_SAFE.has(source)) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved === null ? null : { ...resolved, moduleSideEffects: false };
    }
    const names = namesOf(importer, source);
    return { id: `${STAND_IN}${source}?${names.join(",")}`, moduleSideEffects: false };
  },
  load(id) {
    if (!id.startsWith(STAND_IN)) return null;
    const at = id.indexOf("?");
    const names = id.slice(at + 1);
    return standIn(id.slice(STAND_IN.length, at), names === "" ? [] : names.split(","));
  },
  transform(code, id) {
    if (!SOURCE.test(id) || !code.includes("Buffer.from(")) return null;
    const next = code.replace(
      BUFFER_CONSTANT,
      (_, head, args) =>
        `${head}/* @__PURE__ */ (() => (typeof Buffer === "undefined" ? undefined : Buffer.from(${args})))();`,
    );
    return next === code ? null : { code: next, map: null };
  },
});
