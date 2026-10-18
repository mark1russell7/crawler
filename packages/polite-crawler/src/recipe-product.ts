/*
 * The product recipe reads a product page: its schema.org Product data. Most shop systems write
 * this data on each product page. The recipe gives the name, the brand, the codes (SKU and GTIN),
 * the price as an amount and a currency, a range of prices across the variants, the availability,
 * the seller, the image, and the variant that the URL names.
 *
 * A shop that refuses the crawler is a clean stop: the result says `wall`, with a note, and the
 * crawler does not try a different identity.
 */
import type { Doc } from "./docs.ts";
import type { Duration } from "./duration.ts";
import { durationMs } from "./duration.ts";
import type { Archived } from "./fallback.ts";
import { archivedOf } from "./fallback.ts";
import { extractPage, typesOf } from "./html.ts";
import type { RecipeTarget } from "./recipe.ts";
import { deadlineOf, runtimeOf } from "./recipe.ts";
import type { CrawlRuntime, PageOptions, PageResult } from "./runtime.ts";
import { HELD_BACK, fetchPage, isHeldBack, recordOverride } from "./runtime.ts";
import { decodeBody } from "./text.ts";

type Json = Readonly<Record<string, unknown>>;

/** These are the limits of the product reader. A page with more is hostile or broken, and the reader stops there. */
export const PRODUCT_LIMITS: {
  /** The most JSON-LD records that the reader examines. */
  readonly records: number;
  /** The most offers of one product or variant. */
  readonly offers: number;
  /** The most variants of one product. */
  readonly variants: number;
  /** The levels of `hasVariant` and of nested offers that the reader follows. */
  readonly depth: number;
  /** The longest text of a price. */
  readonly priceChars: number;
} = { records: 500, offers: 200, variants: 200, depth: 2, priceChars: 64 };

/** An amount of money, as schema.org Product data gives it. */
export interface Money {
  /** This value is the amount in the unit of the currency, for example 12.5. */
  readonly amount: number;
  /** This value is the ISO 4217 code of the currency, for example `EUR`. */
  readonly currency: string;
  /** This text is the price as the page wrote it, for a check with `extract`. */
  readonly raw: string;
}

/** The variant of a product that the URL names. */
export interface ProductVariant {
  readonly name: string | null;
  readonly sku: string | null;
  readonly price: Money | null;
  readonly availability: string | null;
}

/** The result of `productOf`: what the Product data of a page says. */
export interface ProductRead {
  /** This value is true when the page has a Product record. */
  readonly found: boolean;
  readonly name: string | null;
  readonly brand: string | null;
  readonly sku: string | null;
  readonly gtin: string | null;
  /** This value is the lowest price of the offers, in the first currency of the page. */
  readonly price: Money | null;
  /** This value is the highest price, when the offers give a range (sizes, colors, variants). */
  readonly price_to: Money | null;
  /**
   * This value is the schema.org name of the availability, for example `InStock`. When the offers
   * do not agree, it is `InStock` if one offer is in stock, and `availabilities` gives each value.
   */
  readonly availability: string | null;
  readonly availabilities: readonly string[];
  /** This value is the variant that the URL names (`?variant=`, `sku` or `gtin`), read alone. */
  readonly variant: ProductVariant | null;
  readonly seller: string | null;
  readonly image: string | null;
  readonly notes: readonly string[];
  /** This value counts the work of the reader. The tests use it, because it does not change with the computer. */
  readonly steps: number;
}

const PRODUCT_TYPES = /^(?:Product|ProductGroup|IndividualProduct|ProductModel|SomeProducts)$/;

/** A list price or a struck-through price is the old price, not the price. */
const WAS_PRICE = /ListPrice|StrikethroughPrice|MSRP|SRP/i;

const GTIN_KEYS = ["gtin13", "gtin12", "gtin14", "gtin8", "gtin"] as const;

/** Two symbols that name one currency only. The other symbols (`$`, `¥`) name more than one. */
const SYMBOLS: Readonly<Record<string, string>> = { "€": "EUR", "£": "GBP" };

let knownCurrencies: ReadonlySet<string> | undefined;
/** This function tells if a code is an ISO 4217 currency that the runtime knows. */
const isCurrency = (code: string): boolean => {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  if (knownCurrencies === undefined) {
    try {
      knownCurrencies = new Set(Intl.supportedValuesOf("currency"));
    } catch {
      // a runtime with no list: each code of three capital letters counts
      knownCurrencies = new Set();
    }
  }
  return knownCurrencies.size === 0 || knownCurrencies.has(code);
};

/** This function gives the number of digits after the decimal point of a currency: 2 for EUR, 0 for JPY. */
const fractionDigits = (currency: string | undefined): number | undefined => {
  if (currency === undefined) return undefined;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits;
  } catch {
    return undefined;
  }
};

/**
 * This function reads an amount as a shop writes it: `19.99`, `1,299.00`, `1.299,00`, `$19.99` or
 * the number 19.99. The last separator is the decimal point, with one exception. One kind of
 * separator, each followed by three digits, separates thousands: `1.299` is 1299. For a
 * currency with three decimal digits, one point with three digits is the decimal point. A text
 * with two numbers (a range), a negative amount or zero gives undefined.
 */
export const readAmount = (value: unknown, currency?: string): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== "string" || value.length > PRODUCT_LIMITS.priceChars) return undefined;
  // one number, with the currency and the spaces around it
  const match = /^[^\d-]*?(\d(?:[\d.,'   ]*\d)?)[^\d]*$/.exec(value.trim());
  if (match === null) return undefined;
  let digits = match[1]!.replace(/['   ]/g, "");
  const last = Math.max(digits.lastIndexOf("."), digits.lastIndexOf(","));
  if (last !== -1) {
    const kinds = new Set(digits.match(/[.,]/g));
    const groups = kinds.size === 1 && /^[1-9]\d{0,2}(?:[.,]\d{3})+$/.test(digits);
    const decimalThree = groups && fractionDigits(currency) === 3 && /^\d+\.\d{3}$/.test(digits);
    digits =
      groups && !decimalThree
        ? digits.replace(/[.,]/g, "")
        : `${digits.slice(0, last).replace(/[.,]/g, "")}.${digits.slice(last + 1)}`;
  }
  const amount = Number(digits);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
};

const list = (value: unknown, limit: number): unknown[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).slice(
    0,
    limit,
  );

const objects = (value: unknown, limit: number): Json[] =>
  list(value, limit).filter(
    (item): item is Json => typeof item === "object" && item !== null && !Array.isArray(item),
  );

/** This function gives a name, written as a text or as an object that has one. */
const nameOf = (value: unknown): string | null => {
  for (const item of list(value, 20)) {
    if (typeof item === "string" && item.trim().length > 0) return item.trim().slice(0, 500);
    if (typeof item === "object" && item !== null) {
      const named = (item as Json)["name"];
      if (typeof named === "string" && named.trim().length > 0) return named.trim().slice(0, 500);
    }
  }
  return null;
};

const textOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 200)
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : null;

const imageOf = (value: unknown): string | null => {
  for (const item of list(value, 20)) {
    if (typeof item === "string" && /^https?:/i.test(item)) return item;
    const url = typeof item === "object" && item !== null ? (item as Json)["url"] : undefined;
    if (typeof url === "string" && /^https?:/i.test(url)) return url;
  }
  return null;
};

interface Offers {
  readonly prices: Money[];
  readonly unknownCurrencies: Set<string>;
  readonly availability: Set<string>;
  readonly sellers: Set<string>;
  /** An amount with no currency, which is not a price. */
  unstated: boolean;
  steps: number;
}

const emptyOffers = (): Offers => ({
  prices: [],
  unknownCurrencies: new Set(),
  availability: new Set(),
  sellers: new Set(),
  unstated: false,
  steps: 0,
});

/** This function reads the offers of a product into `read`, and the offers of its variants to `depth` levels. */
const readOffers = (product: Json, read: Offers, depth: number): void => {
  const money = (value: unknown, currency: unknown): void => {
    const written = typeof currency === "string" ? currency.trim() : "";
    const code = SYMBOLS[written] ?? written.toUpperCase();
    const amount = readAmount(value, code.length > 0 ? code : undefined);
    if (amount === undefined) return;
    if (code.length === 0) {
      read.unstated = true;
      return;
    }
    if (!isCurrency(code)) {
      read.unknownCurrencies.add(written.slice(0, 20));
      return;
    }
    read.prices.push({
      amount,
      currency: code,
      raw: String(value).slice(0, PRODUCT_LIMITS.priceChars),
    });
  };
  const offer = (o: Json, level: number): void => {
    read.steps += 1;
    const spec = objects(o["priceSpecification"], PRODUCT_LIMITS.offers).find((entry) => {
      const kind = entry["priceType"];
      return !(typeof kind === "string" && WAS_PRICE.test(kind));
    });
    const currency = o["priceCurrency"] ?? spec?.["priceCurrency"];
    money(o["price"] ?? spec?.["price"], currency);
    money(o["lowPrice"], currency);
    money(o["highPrice"], currency);
    const availability =
      typeof o["availability"] === "string"
        ? o["availability"]
            .trim()
            .replace(/^.*[/#:]/, "")
            .slice(0, 60)
        : undefined;
    if (availability !== undefined && availability.length > 0) read.availability.add(availability);
    const seller = nameOf(o["seller"]);
    if (seller !== null) read.sellers.add(seller);
    // an AggregateOffer can list its offers
    if (level < PRODUCT_LIMITS.depth) {
      for (const inner of objects(o["offers"], PRODUCT_LIMITS.offers)) offer(inner, level + 1);
    }
  };
  for (const o of objects(product["offers"], PRODUCT_LIMITS.offers)) offer(o, 0);
  if (depth <= 0) return;
  for (const variant of objects(product["hasVariant"], PRODUCT_LIMITS.variants)) {
    read.steps += 1;
    readOffers(variant, read, depth - 1);
  }
};

const availabilityOf = (read: Offers): string | null =>
  read.availability.size === 0
    ? null
    : read.availability.size === 1 || !read.availability.has("InStock")
      ? [...read.availability][0]!
      : "InStock";

const pathKey = (value: string, page: string): string | undefined => {
  // "#product" names a part of this page: a related product can have such an id too
  if (value.startsWith("#")) return undefined;
  try {
    const url = new URL(value, page);
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return undefined;
  }
};

/** This function gives the size of a record as JSON, or 0 for a record that JSON cannot write (a nesting too deep). */
const sizeOf = (record: Json): number => {
  try {
    return JSON.stringify(record).length;
  } catch {
    return 0;
  }
};

/**
 * This function picks the product of a page from its JSON-LD records. A page often has more
 * records of products: the related products, the products that others bought. It picks:
 *
 * 1. The product whose `url` or `@id` is the page (the path, with no query).
 * 2. Else the largest product with offers or variants.
 * 3. Else the largest product.
 *
 * It also reads the `mainEntity` of a record (a `WebPage` or an `ItemPage` that names its product).
 */
export const pickProduct = (
  records: readonly Json[],
  page: string,
): { readonly product: Json | undefined; readonly steps: number } => {
  let steps = 0;
  const products: Json[] = [];
  for (const record of records.slice(0, PRODUCT_LIMITS.records)) {
    steps += 1;
    if (typesOf(record as Record<string, unknown>).some((type) => PRODUCT_TYPES.test(type)))
      products.push(record);
    for (const inner of objects(record["mainEntity"], 20)) {
      steps += 1;
      if (typesOf(inner as Record<string, unknown>).some((type) => PRODUCT_TYPES.test(type)))
        products.push(inner);
    }
  }
  const here = pathKey(page, page);
  const own = products.find((product) =>
    [product["url"], product["@id"]].some(
      (value) => typeof value === "string" && here !== undefined && pathKey(value, page) === here,
    ),
  );
  if (own !== undefined) return { product: own, steps };
  const selling = products.filter(
    (product) => list(product["offers"], 1).length > 0 || list(product["hasVariant"], 1).length > 0,
  );
  const pool = selling.length > 0 ? selling : products;
  let best: Json | undefined;
  let size = -1;
  for (const product of pool) {
    const length = sizeOf(product);
    steps += length;
    if (length > size) {
      best = product;
      size = length;
    }
  }
  return { product: best, steps };
};

/** This function gives the variant that a URL names: the `variant` parameter of Shopify, or a `sku` or `gtin` parameter. */
export const pickVariant = (product: Json, page: string): Json | undefined => {
  let params: URLSearchParams;
  try {
    params = new URL(page).searchParams;
  } catch {
    return undefined;
  }
  const variantId = params.get("variant");
  const code = params.get("sku") ?? params.get("gtin");
  if (variantId === null && code === null) return undefined;
  const names = (value: unknown): boolean => {
    if (typeof value !== "string" || variantId === null) return false;
    try {
      return (
        new URL(value, page).searchParams.get("variant") === variantId ||
        value.endsWith(`/${variantId}`)
      );
    } catch {
      return false;
    }
  };
  return objects(product["hasVariant"], PRODUCT_LIMITS.variants).find((variant) => {
    const offers = objects(variant["offers"], PRODUCT_LIMITS.offers);
    const codes = [
      variant["sku"],
      variant["gtin"],
      variant["gtin13"],
      variant["gtin12"],
      variant["productID"],
    ]
      .map(textOf)
      .filter((one): one is string => one !== null);
    return (
      (code !== null && codes.includes(code)) ||
      [variant["@id"], variant["url"], ...offers.map((offer) => offer["url"])].some(names) ||
      (variantId !== null && codes.includes(variantId))
    );
  });
};

const byAmount = (a: Money, b: Money): number => a.amount - b.amount;

/**
 * This function reads the Product data of a page from its JSON-LD records. It is pure, and it sends
 * no request. Thus it also reads a version at a time, or the stored JSON-LD of a document.
 *
 * - The prices are in the first currency of the offers. A price with no currency is not a price.
 * - A list price or a struck-through price is not the price.
 * - A currency must be an ISO 4217 code (`€` and `£` count too). The notes name each other one.
 */
export const productOf = (records: readonly Json[], page: string): ProductRead => {
  const picked = pickProduct(records, page);
  const product = picked.product;
  if (product === undefined) {
    return {
      found: false,
      name: null,
      brand: null,
      sku: null,
      gtin: null,
      price: null,
      price_to: null,
      availability: null,
      availabilities: [],
      variant: null,
      seller: null,
      image: null,
      notes: [
        "no schema.org Product data on the page: a list of products, or a shop that does not publish it",
      ],
      steps: picked.steps,
    };
  }
  const read = emptyOffers();
  readOffers(product, read, PRODUCT_LIMITS.depth);
  const currency = read.prices[0]?.currency;
  const sorted = read.prices.filter((price) => price.currency === currency).sort(byAmount);
  const low = sorted[0] ?? null;
  const high = sorted.at(-1) ?? null;
  const gtin = GTIN_KEYS.map((key) => textOf(product[key])).find((value) => value !== null);
  const chosen = pickVariant(product, page);
  let variant: ProductVariant | null = null;
  let steps = picked.steps + read.steps;
  if (chosen !== undefined) {
    const own = emptyOffers();
    readOffers(chosen, own, 0);
    steps += own.steps;
    const prices = own.prices.filter((price) => price.currency === currency).sort(byAmount);
    variant = {
      name: nameOf(chosen["name"]),
      sku: textOf(chosen["sku"]),
      price: prices[0] ?? null,
      availability: availabilityOf(own),
    };
  }
  const notes = [
    read.unknownCurrencies.size > 0
      ? `a currency that is not an ISO 4217 code: ${[...read.unknownCurrencies].join(", ")}`
      : null,
    read.unstated && sorted.length === 0
      ? "the page gives a price with no currency, so the price is not read as money"
      : sorted.length === 0
        ? "the page names the product and gives no price"
        : null,
    new Set(read.prices.map((price) => price.currency)).size > 1
      ? `the offers have more than one currency: the prices are in ${currency ?? ""}`
      : null,
    /[?&](?:variant|sku|gtin)=/.test(page) && chosen === undefined
      ? "the URL names a variant that the Product data does not list: the price is the whole range"
      : null,
  ].filter((note): note is string => note !== null);
  return {
    found: true,
    name: nameOf(product["name"]),
    brand: nameOf(product["brand"]),
    sku: textOf(product["sku"]),
    gtin: gtin ?? null,
    price: low,
    price_to: high !== null && low !== null && high.amount > low.amount ? high : null,
    availability: availabilityOf(read),
    availabilities: [...read.availability],
    variant,
    seller: read.sellers.size === 0 ? null : [...read.sellers].join(", "),
    image: imageOf(product["image"]),
    notes,
    steps,
  };
};

// ── the recipe ──────────────────────────────────────────────────────────────

/** These options control `readProduct`. */
export interface ProductOptions {
  /** The value `auto` (the default) renders once more when the plain page has no Product data. `never` does not render. */
  readonly render?: "auto" | "never" | "always" | undefined;
  /** A stored copy younger than this age answers with no request. The default is `24h`. */
  readonly maxAge?: Duration | undefined;
  /** These agents get their robots.txt rules applied too, for example `Claude-User`. */
  readonly onBehalfOf?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
  /** No request starts after this time from the start of the read, for example `"1m"`. */
  readonly budget?: Duration | undefined;
  readonly scope?: string | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
  /** This name connects the captures to the job that asked for them. The default is `product`. */
  readonly job?: string | undefined;
  /** This value is true when a person gave this URL directly. It is the only way to read a held-back page. The crawler logs it. */
  readonly userProvided?: boolean | undefined;
  /** The value `archive` reads an archived copy of a page that the shop refuses. Its prices are of the date of the copy. */
  readonly fallback?: "archive" | "none" | undefined;
  readonly archiveDespiteRobots?: boolean | undefined;
}

/** The result of `readProduct`. */
export interface ProductResult extends Omit<ProductRead, "steps" | "notes"> {
  readonly url: string;
  /** This value is true when the page says what it sells, in structured data: the Product has a name. */
  readonly verified: boolean;
  /**
   * This value is true when the site refused the crawler. The causes are a 401, a 402 or a 403, a
   * challenge, a bot check, a stop of the host or robots.txt. The recipe stops there, and the note
   * says why. With `fallback: "archive"`, it stays true when an archived copy answers.
   */
  readonly wall: boolean;
  readonly outcome: string;
  readonly status: number;
  readonly rendered: boolean;
  readonly doc: string | null;
  /** This id is the capture of the text that the recipe read. A citation names it. */
  readonly capture: string | null;
  readonly fetched_at: string | null;
  readonly captures: readonly string[];
  readonly from_cache: boolean;
  /** This value is true when the page asked not to be AI input, so the recipe read nothing from it. */
  readonly held_back: boolean;
  /** This value tells that the page is an archived copy, with the archive and the date of the copy. */
  readonly archived?: Archived | undefined;
  readonly note: string | null;
}

const WALLS: ReadonlySet<string> = new Set(["blocked", "challenge", "payment-required"]);

/** This function tells if the site refused the crawler. */
const wallOf = (page: PageResult): boolean =>
  WALLS.has(page.outcome) ||
  (page.outcome === "skipped" && /^(?:robots\.txt disallows|host stopped)/.test(page.note ?? "")) ||
  (page.doc === null && /\bbot check\b/.test(page.note ?? ""));

const answered = (page: PageResult): boolean =>
  page.doc !== null &&
  (page.outcome === "ok" || page.outcome === "not-modified" || page.archived !== undefined);

/**
 * This function gives the JSON-LD records of a document from its stored body. The index keeps a
 * part of the JSON-LD of a large page only, and a product with many variants can be larger. An
 * archived copy gives the JSON-LD that the index keeps.
 */
const recordsOfDoc = async (runtime: CrawlRuntime, doc: Doc): Promise<readonly Json[]> => {
  const kept = Array.isArray(doc.meta["jsonld"]) ? (doc.meta["jsonld"] as Json[]) : [];
  if (doc.blob === null || archivedOf(doc.meta) !== undefined) return kept;
  const body = await runtime.blobs.get(doc.blob);
  if (body === undefined) return kept;
  const at = doc.url ?? "";
  const type = doc.rendered
    ? "text/html; charset=utf-8"
    : (runtime.index.latest(at, "plain")?.content_type ?? null);
  try {
    return extractPage(decodeBody(body, type), at).jsonld;
  } catch {
    return kept;
  }
};

/**
 * This function reads a product page. It fetches the page through the crawler: robots.txt, the
 * pace, the stops, the capture log and the rule for a held-back page apply. When the plain page has
 * no Product data, it renders the page once, because some shops write that data with JavaScript.
 *
 * A shop that refuses the crawler gives `wall: true` and a note. The recipe writes nothing but the
 * capture log. `extract` can check each value against the stored page.
 */
export const readProduct = async (
  target: RecipeTarget,
  url: string,
  options: ProductOptions = {},
): Promise<ProductResult> => {
  const runtime = runtimeOf(target);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TypeError(url);
  } catch {
    throw new TypeError(`readProduct needs an http or https URL, not ${JSON.stringify(url)}`);
  }
  const maxAge = options.maxAge ?? "24h";
  const job = options.job ?? "product";
  const userProvided = options.userProvided ?? false;
  const render = options.render ?? "auto";
  const deadline = deadlineOf(runtime, options.budget);
  const pageOptions = (mode: "auto" | "never" | "always"): PageOptions => ({
    render: mode,
    maxAgeMs: maxAge === "auto" ? "auto" : durationMs(maxAge),
    onBehalfOf: options.onBehalfOf,
    job,
    signal: options.signal,
    scope: options.scope,
    labels: options.labels,
    deadline,
    fallback: options.fallback,
    archiveDespiteRobots: options.archiveDespiteRobots,
  });
  let page = await fetchPage(runtime, url, pageOptions(render));
  const notes: string[] = [];
  const result = (
    from: PageResult,
    read: Omit<ProductRead, "steps"> | undefined,
    more: { readonly held_back?: boolean } = {},
  ): ProductResult => {
    const all = [from.note, ...notes, ...(read?.notes ?? [])].filter(
      (part): part is string => part !== null && part !== undefined && part.length > 0,
    );
    return {
      url,
      found: read?.found ?? false,
      verified: read?.found === true && read.name !== null,
      name: read?.name ?? null,
      brand: read?.brand ?? null,
      sku: read?.sku ?? null,
      gtin: read?.gtin ?? null,
      price: read?.price ?? null,
      price_to: read?.price_to ?? null,
      availability: read?.availability ?? null,
      availabilities: read?.availabilities ?? [],
      variant: read?.variant ?? null,
      seller: read?.seller ?? null,
      image: read?.image ?? null,
      wall: wallOf(from),
      outcome: from.outcome,
      status: from.status,
      rendered: from.rendered,
      doc: from.doc,
      capture: from.capture,
      fetched_at: from.fetched_at,
      captures: [...from.captures],
      from_cache: from.from_cache,
      held_back: more.held_back ?? false,
      ...(from.archived === undefined ? {} : { archived: from.archived }),
      note: all.length > 0 ? [...new Set(all)].join("; ") : null,
    };
  };
  if (!answered(page)) {
    const wall = wallOf(page);
    notes.push(
      wall
        ? `the shop refused the crawler (${page.outcome}): the recipe read nothing, and it does not try a different identity`
        : `the page gave no document (${page.outcome})`,
    );
    return result(page, undefined);
  }
  const held = (from: PageResult): Doc | undefined => {
    const doc = from.doc === null ? undefined : runtime.index.get(from.doc);
    return doc !== undefined && isHeldBack(doc, userProvided) ? doc : undefined;
  };
  if (held(page) !== undefined) {
    notes.push(HELD_BACK);
    return result(page, undefined, { held_back: true });
  }
  const docOf = (from: PageResult): Doc | undefined =>
    from.doc === null ? undefined : runtime.index.get(from.doc);
  let doc = docOf(page);
  let read = doc === undefined ? undefined : productOf(await recordsOfDoc(runtime, doc), url);
  // some shops write their Product data with JavaScript: one render before the recipe says that the page has none
  if (read?.found !== true && !page.rendered && render === "auto" && page.archived === undefined) {
    const rendered = await fetchPage(runtime, url, pageOptions("always"));
    const shown = docOf(rendered);
    if (
      rendered.rendered &&
      answered(rendered) &&
      shown !== undefined &&
      held(rendered) === undefined
    ) {
      page = rendered;
      doc = shown;
      read = productOf(await recordsOfDoc(runtime, shown), url);
    } else if (rendered.note !== null && !rendered.rendered) {
      notes.push(`the render gave nothing more: ${rendered.note}`);
    }
  }
  if (userProvided && doc?.ai_input === "no") await recordOverride(runtime, doc, job);
  return result(page, read);
};
