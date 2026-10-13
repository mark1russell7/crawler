import { readFileSync } from "node:fs";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import type { Renderer } from "./render.ts";
import { createRuntime } from "./open.ts";
import type { CaptureRecord } from "./record.ts";
import { fetchAndIndex, fetchPage, readDocument, renderAndIndex } from "./runtime.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";

/** The published schema of a capture record: `polite-crawler/record.schema.json`. */
const SCHEMA = JSON.parse(readFileSync(new URL("../record.schema.json", import.meta.url), "utf8")) as Schema;

type Schema = { readonly [key: string]: unknown };

const typeOf = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;

/**
 * This function checks a value against the part of JSON Schema 2020-12 that the schema uses: type,
 * const, enum, pattern, minLength, minimum, required, properties, additionalProperties, items,
 * allOf, if and then, and a $ref into $defs. It gives the errors, with the path of each.
 */
const validate = (schema: Schema, value: unknown, path = "$"): string[] => {
  if (typeof schema["$ref"] === "string") {
    const name = schema["$ref"].replace("#/$defs/", "");
    return validate((SCHEMA["$defs"] as Record<string, Schema>)[name]!, value, path);
  }
  const errors: string[] = [];
  const type = schema["type"] as string | string[] | undefined;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    const actual = typeOf(value);
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
      return [`${path}: ${actual} is not ${types.join(" or ")}`];
    }
  }
  if ("const" in schema && value !== schema["const"]) errors.push(`${path}: not ${JSON.stringify(schema["const"])}`);
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not in the enum`);
  if (typeof value === "string") {
    if (typeof schema["pattern"] === "string" && !new RegExp(schema["pattern"], "u").test(value)) errors.push(`${path}: does not match ${schema["pattern"]}`);
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) errors.push(`${path}: too short`);
  }
  if (typeof value === "number" && typeof schema["minimum"] === "number" && value < schema["minimum"]) errors.push(`${path}: below the minimum`);
  if (typeOf(value) === "object") {
    const object = value as Record<string, unknown>;
    for (const key of (schema["required"] as string[] | undefined) ?? []) {
      if (!(key in object)) errors.push(`${path}: no ${key}`);
    }
    const properties = (schema["properties"] as Record<string, Schema> | undefined) ?? {};
    for (const [key, item] of Object.entries(object)) {
      if (properties[key] !== undefined) errors.push(...validate(properties[key], item, `${path}.${key}`));
      else if (schema["additionalProperties"] === false) errors.push(`${path}: ${key} is not in the schema`);
      else if (typeof schema["additionalProperties"] === "object") {
        errors.push(...validate(schema["additionalProperties"] as Schema, item, `${path}.${key}`));
      }
    }
  }
  if (Array.isArray(value) && schema["items"] !== undefined) {
    value.forEach((item, at) => errors.push(...validate(schema["items"] as Schema, item, `${path}[${String(at)}]`)));
  }
  for (const part of (schema["allOf"] as Schema[] | undefined) ?? []) errors.push(...validate(part, value, path));
  if (schema["if"] !== undefined && validate(schema["if"] as Schema, value, path).length === 0 && schema["then"] !== undefined) {
    errors.push(...validate(schema["then"] as Schema, value, path));
  }
  return errors;
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PAGE = `<!doctype html><html><head><title>Forno</title><meta name="tdm-reservation" content="1"></head><body><p>${"Wood-fired bread every morning. ".repeat(10)}</p></body></html>`;

describe("the schema of a capture record", () => {
  it("describes each record that the crawler writes: each kind, each recipe, a render and an override", async () => {
    const dir = await tempDir("schema");
    cleanups.push(() => removeDir(dir));
    const agent = new MockAgent();
    agent.disableNetConnect();
    const site = agent.get("https://bakery.example");
    site.intercept({ path: "/robots.txt" }).reply(200, "User-agent: *\nDisallow: /private\nLicense: https://bakery.example/license.xml\n").persist();
    site
      .intercept({ path: "/" })
      .reply((request) =>
        (request.headers as Record<string, string>)["if-none-match"] === '"v1"'
          ? { statusCode: 304, data: "" }
          : { statusCode: 200, data: PAGE, responseOptions: { headers: { "content-type": "text/html", etag: '"v1"', "cache-control": "max-age=60" } } },
      )
      .persist();
    site.intercept({ path: "/old" }).reply(301, "", { headers: { location: "/?utm_source=x" } }).persist();
    site.intercept({ path: "/broken" }).reply(500, "no").persist();
    site.intercept({ path: "/held" }).reply(200, PAGE, { headers: { "content-type": "text/html", "content-signal": "ai-input=no" } }).persist();
    const api = agent.get("https://api.example");
    api.intercept({ path: (path) => path.startsWith("/search") }).reply(200, '{"title":"Bread"}', { headers: { "content-type": "application/json" } }).persist();
    const renderer: Renderer = {
      render: async (url, options) => {
        await options.allowRequest?.("https://bakery.example/private/cart");
        return { html: PAGE, finalUrl: url, status: 200, headers: { "content-type": "text/html" } };
      },
      close: () => Promise.resolve(),
    };
    const runtime = createRuntime({
      dir,
      renderer,
      dispatcher: agent,
      clock: fakeClock(),
      scope: "research",
      contact: "ops@example.com",
      extractors: {
        papers: (body) => {
          const parsed = JSON.parse(new TextDecoder().decode(body)) as { title: string };
          return [{ doc: "doi:1", kind: "paper", title: parsed.title, text: parsed.title, url: null, meta: {} }];
        },
      },
    });
    cleanups.push(() => runtime.close());
    await fetchPage(runtime, "https://bakery.example/", { render: "never", job: "menu", labels: { lineage: "test" } });
    await fetchPage(runtime, "https://bakery.example/", { render: "never", maxAgeMs: 0 });
    await fetchPage(runtime, "https://bakery.example/old", { render: "never" });
    await fetchPage(runtime, "https://bakery.example/private", { render: "never" });
    await fetchPage(runtime, "https://bakery.example/broken", { render: "never" });
    await fetchPage(runtime, "not a url", { render: "never" });
    const held = await fetchPage(runtime, "https://bakery.example/held", { render: "never" });
    await readDocument(runtime, held.doc!, { userProvided: true });
    await fetchAndIndex(runtime, { url: "https://api.example/search?q=bread&api_key=secret", mode: "api", recipe: "papers" });
    await renderAndIndex(runtime, { url: "https://bakery.example/", recipe: "page", maxAgeMs: 0 });
    await runtime.log.flush();

    const records: CaptureRecord[] = [];
    for await (const record of runtime.captures.scan({ source: "fetch" })) records.push(record);
    const kinds = new Set(records.map((record) => `${record.kind}:${(record.payload as { recipe?: string }).recipe ?? ""}`));
    expect([...kinds].sort()).toEqual(
      expect.arrayContaining(["capture:page", "capture:papers", "capture:robots.txt", "override:", "revisit:page", "skipped:page"]),
    );
    expect(records.some((record) => (record.payload as { rendered?: boolean }).rendered === true)).toBe(true);
    for (const record of records) expect(validate(SCHEMA, JSON.parse(JSON.stringify(record)) as unknown), record.id).toEqual([]);
    // the schema finds a wrong record
    const [first] = records;
    expect(validate(SCHEMA, { ...first, payload: { ...(first!.payload as object), mode: "web" } })).toEqual([
      "$.payload.mode: \"web\" is not in the enum",
    ]);
    expect(validate(SCHEMA, { ...first, id: "fetch.xyz" })).toEqual(["$.id: does not match ^.+\\.[0-9a-f]{12}$"]);
  });
});
