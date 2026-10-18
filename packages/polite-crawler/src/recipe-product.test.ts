import { afterEach, describe, expect, it } from "vitest";
import {
  PRODUCT_LIMITS,
  pickProduct,
  pickVariant,
  productOf,
  readAmount,
  readProduct,
} from "./recipe-product.ts";
import { FILLER, HTML, htmlPage, jsonLd, openWith, pagesOf, world } from "./test-recipes.ts";

/*
 * The product recipe, with a made-up shop on the domain `.example`: Bottega Campione, which sells
 * the olive oil Olio Esempio. The products, the codes and the prices are made up.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SHOP = "https://bottega-campione.example";
const PAGE = `${SHOP}/products/olio-esempio`;

type Json = Record<string, unknown>;

const offer = (price: string | number, availability = "InStock", extra: Json = {}): Json => ({
  "@type": "Offer",
  price,
  priceCurrency: "EUR",
  availability: `https://schema.org/${availability}`,
  seller: { "@type": "Organization", name: "Bottega Campione" },
  ...extra,
});

/** The product group of the page: three bottles, from 9.90 EUR to 18.00 EUR. */
const oil = (extra: Json = {}): Json => ({
  "@context": "https://schema.org",
  "@type": "ProductGroup",
  "@id": `${PAGE}#product`,
  url: PAGE,
  name: "Olio Esempio",
  brand: { "@type": "Brand", name: "Campione" },
  sku: "OE-GROUP",
  gtin13: "0000000000017",
  image: [{ "@type": "ImageObject", url: `${SHOP}/img/olio.jpg` }],
  hasVariant: [
    { "@type": "Product", name: "Olio Esempio 250 ml", sku: "OE-250", offers: offer("9.90") },
    {
      "@type": "Product",
      name: "Olio Esempio 500 ml",
      sku: "OE-500",
      offers: offer("12.50", "InStock", { url: `${PAGE}?variant=222` }),
    },
    {
      "@type": "Product",
      name: "Olio Esempio 1 l",
      sku: "OE-1000",
      offers: offer("18.00", "OutOfStock"),
    },
  ],
  ...extra,
});

/** A product of the box "people also bought": it has offers, and a longer description. */
const related = (name: string): Json => ({
  "@type": "Product",
  url: `${SHOP}/products/${name.toLowerCase().replace(/\s+/g, "-")}`,
  name,
  description: "A related product with a long description. ".repeat(20),
  offers: offer("5.00"),
});

describe("readAmount", () => {
  it("reads a price as a shop writes it", () => {
    expect(readAmount("19.99")).toBe(19.99);
    expect(readAmount(19.99)).toBe(19.99);
    expect(readAmount("$19.99")).toBe(19.99);
    expect(readAmount("EUR 1,299.00")).toBe(1299);
    expect(readAmount("1.299,00 €")).toBe(1299);
    expect(readAmount("1 299,50")).toBe(1299.5);
    expect(readAmount("1'299.50 CHF")).toBe(1299.5);
    expect(readAmount("12,5")).toBe(12.5);
    expect(readAmount("0.99")).toBe(0.99);
    // one kind of separator before groups of three digits: thousands
    expect(readAmount("1.299")).toBe(1299);
    expect(readAmount("1,299", "JPY")).toBe(1299);
    // a currency with three decimal digits
    expect(readAmount("1.299", "KWD")).toBe(1.299);
  });

  it("reads no price from a range, a negative amount, zero or a text that is too long", () => {
    expect(readAmount("19.99 - 24.99")).toBeUndefined();
    expect(readAmount("-5")).toBeUndefined();
    expect(readAmount("0")).toBeUndefined();
    expect(readAmount(0)).toBeUndefined();
    expect(readAmount(Number.NaN)).toBeUndefined();
    expect(readAmount("free")).toBeUndefined();
    expect(readAmount(null)).toBeUndefined();
    expect(readAmount(`1${"0".repeat(PRODUCT_LIMITS.priceChars)}`)).toBeUndefined();
  });
});

describe("the Product data of a page", () => {
  it("picks the product of the page, not a related product before it", () => {
    const records = [related("Olio Rustico"), related("Aceto Campione"), oil()];
    expect(pickProduct(records, `${PAGE}?variant=222`).product?.["name"]).toBe("Olio Esempio");
    // with no URL that names the page: the largest product that sells, not a name in a list
    const nameless = [
      { "@type": "Product", name: "A list entry" },
      related("Olio Rustico"),
      { ...oil(), url: undefined, "@id": undefined, description: "x".repeat(2000) },
    ];
    expect(pickProduct(nameless, PAGE).product?.["name"]).toBe("Olio Esempio");
    // "#product" names a part of each page: it does not make a related product the product of the page
    const fragments = [
      {
        ...related("Olio Rustico"),
        url: undefined,
        "@id": "#product",
        description: "x".repeat(5000),
      },
      { ...oil(), url: undefined, "@id": undefined },
    ];
    expect(pickProduct(fragments, PAGE).product?.["name"]).toBe("Olio Rustico");
    // the main entity of a web page
    const page = { "@type": "ItemPage", mainEntity: oil() };
    expect(pickProduct([related("Olio Rustico"), page], PAGE).product?.["name"]).toBe(
      "Olio Esempio",
    );
    expect(pickProduct([{ "@type": "Organization" }], PAGE).product).toBeUndefined();
  });

  it("reads the name, the codes, the range of the variants, the availability and the variant of the URL", () => {
    const read = productOf([related("Olio Rustico"), oil()], `${PAGE}?variant=222`);
    expect(read).toMatchObject({
      found: true,
      name: "Olio Esempio",
      brand: "Campione",
      sku: "OE-GROUP",
      gtin: "0000000000017",
      price: { amount: 9.9, currency: "EUR", raw: "9.90" },
      price_to: { amount: 18, currency: "EUR", raw: "18.00" },
      availability: "InStock",
      availabilities: ["InStock", "OutOfStock"],
      seller: "Bottega Campione",
      image: `${SHOP}/img/olio.jpg`,
      variant: {
        name: "Olio Esempio 500 ml",
        sku: "OE-500",
        price: { amount: 12.5, currency: "EUR" },
        availability: "InStock",
      },
      notes: [],
    });
    expect(productOf([oil()], `${PAGE}?sku=OE-1000`).variant).toMatchObject({
      sku: "OE-1000",
      availability: "OutOfStock",
    });
    const unknown = productOf([oil()], `${PAGE}?variant=999`);
    expect(unknown.variant).toBeNull();
    expect(unknown.notes).toContain(
      "the URL names a variant that the Product data does not list: the price is the whole range",
    );
    expect(pickVariant(oil(), "not a url")).toBeUndefined();
    expect(pickVariant(oil(), PAGE)).toBeUndefined();
  });

  it("reads an aggregate offer and a sale price, and no price with no currency or an unknown currency", () => {
    const aggregate = productOf(
      [
        {
          "@type": "Product",
          url: PAGE,
          name: "Olio Esempio",
          offers: {
            "@type": "AggregateOffer",
            lowPrice: "1.299,00",
            highPrice: "1.499,00",
            priceCurrency: "eur",
            offerCount: 2,
          },
        },
      ],
      PAGE,
    );
    expect(aggregate.price).toMatchObject({ amount: 1299, currency: "EUR" });
    expect(aggregate.price_to).toMatchObject({ amount: 1499, currency: "EUR" });
    const sale = productOf(
      [
        {
          "@type": "Product",
          url: PAGE,
          name: "Olio Esempio",
          offers: {
            "@type": "Offer",
            priceSpecification: [
              {
                "@type": "UnitPriceSpecification",
                priceType: "https://schema.org/ListPrice",
                price: 20,
                priceCurrency: "GBP",
              },
              { "@type": "UnitPriceSpecification", price: 15, priceCurrency: "£" },
            ],
          },
        },
      ],
      PAGE,
    );
    expect(sale.price).toMatchObject({ amount: 15, currency: "GBP" });
    expect(sale.price_to).toBeNull();
    const dollars = productOf(
      [
        {
          "@type": "Product",
          url: PAGE,
          name: "Olio Esempio",
          offers: { price: "12", priceCurrency: "$" },
        },
      ],
      PAGE,
    );
    expect(dollars.price).toBeNull();
    expect(dollars.notes[0]).toBe("a currency that is not an ISO 4217 code: $");
    const bare = productOf(
      [{ "@type": "Product", url: PAGE, name: "Olio Esempio", offers: { price: "12" } }],
      PAGE,
    );
    expect(bare.price).toBeNull();
    expect(bare.notes).toContain(
      "the page gives a price with no currency, so the price is not read as money",
    );
    const two = productOf(
      [
        {
          "@type": "Product",
          url: PAGE,
          name: "Olio Esempio",
          offers: [offer("9.00"), { ...offer("11.00"), priceCurrency: "USD" }],
        },
      ],
      PAGE,
    );
    expect(two.price).toMatchObject({ amount: 9, currency: "EUR" });
    expect(two.price_to).toBeNull();
    expect(two.notes).toContain("the offers have more than one currency: the prices are in EUR");
    expect(productOf([], PAGE)).toMatchObject({ found: false, price: null });
  });
});

describe("readProduct", () => {
  it("reads a product page through the crawler, and extract checks a value against the stored page", async () => {
    const hosts = world({
      [SHOP]: (path) =>
        path.startsWith("/products/olio-esempio")
          ? {
              body: htmlPage(
                "Olio Esempio",
                `<p>An olive oil of Campione.</p>${FILLER}`,
                jsonLd([related("Olio Rustico"), oil()]),
              ),
              headers: HTML,
            }
          : undefined,
    });
    const { crawler } = await openWith(hosts, cleanups);
    const url = `${PAGE}?variant=222`;
    const result = await readProduct(crawler, url);
    expect(result).toMatchObject({
      url,
      verified: true,
      wall: false,
      outcome: "ok",
      status: 200,
      held_back: false,
      name: "Olio Esempio",
      price: { amount: 9.9, currency: "EUR" },
      price_to: { amount: 18, currency: "EUR" },
      variant: { sku: "OE-500", price: { amount: 12.5 } },
      note: null,
    });
    expect(result.doc).toBe(`url:${url}`);
    expect(result.capture).toMatch(/^fetch\./);
    const checked = await crawler.extract(result.doc!, {
      price: { value: result.variant!.price!.raw, kind: "json-ld:Product.offers.price" },
      name: { value: "Olio Esempio" },
    });
    expect(checked.fields["price"]).toMatchObject({ status: "verified", capture: result.capture });
    expect(checked.fields["name"]?.status).toBe("verified");
    // the stored copy answers again
    const again = await readProduct(crawler.runtime, url);
    expect(again.from_cache).toBe(true);
    expect(pagesOf(hosts)).toHaveLength(1);
  });

  it("reads a product that is larger than the JSON-LD that the index keeps, from the stored body", async () => {
    const variants = Array.from({ length: 150 }, (_, index) => ({
      "@type": "Product",
      name: `Olio Esempio, bottle ${String(index)}`,
      sku: `OE-${String(index)}`,
      description: "A bottle of the oil of the year, pressed cold in the autumn. ".repeat(5),
      offers: offer(`${String(10 + index)}.00`),
    }));
    const hosts = world({
      [SHOP]: (path) =>
        path === "/products/olio-esempio"
          ? {
              body: htmlPage("Olio Esempio", FILLER, jsonLd(oil({ hasVariant: variants }))),
              headers: HTML,
            }
          : undefined,
    });
    const { crawler } = await openWith(hosts, cleanups);
    const result = await readProduct(crawler, PAGE);
    const stored = crawler.runtime.index.get(result.doc!);
    expect(stored?.meta["jsonld_dropped"]).toBe(1);
    expect(result).toMatchObject({
      found: true,
      price: { amount: 10 },
      price_to: { amount: 159 },
    });
  });

  it("stops cleanly at a wall, a challenge and a bot check, with a note", async () => {
    const OTHER = "https://grande-magazzino.example";
    const CHECK = "https://negozio-protetto.example";
    const OPEN = "https://bottega-aperta.example";
    const hosts = world({
      [SHOP]: (path) =>
        path.startsWith("/products/") ? { status: 403, body: "Forbidden" } : undefined,
      [OTHER]: (path) =>
        path === "/p/1"
          ? { status: 403, body: "denied", headers: { "cf-mitigated": "challenge" } }
          : undefined,
      [OPEN]: () => undefined,
      [CHECK]: (path) =>
        path === "/p/1"
          ? {
              body: htmlPage(
                "Just a moment...",
                '<script src="/cdn-cgi/challenge-platform/x.js"></script>',
              ),
              headers: HTML,
            }
          : undefined,
    });
    const { crawler } = await openWith(hosts, cleanups);
    const blocked = await readProduct(crawler, PAGE);
    expect(blocked).toMatchObject({
      wall: true,
      outcome: "blocked",
      status: 403,
      found: false,
      doc: null,
    });
    expect(blocked.note).toContain("the shop refused the crawler (blocked)");
    // the host stops after a 403: the next product of the shop costs no request
    const stopped = await readProduct(crawler, `${SHOP}/products/aceto-campione`);
    expect(stopped).toMatchObject({ wall: true, outcome: "skipped" });
    expect(stopped.note).toMatch(/host stopped/);
    expect(pagesOf(hosts).filter((hit) => hit.startsWith(SHOP))).toHaveLength(1);
    const challenge = await readProduct(crawler, `${OTHER}/p/1`);
    expect(challenge).toMatchObject({ wall: true, outcome: "challenge" });
    const check = await readProduct(crawler, `${CHECK}/p/1`);
    expect(check).toMatchObject({ wall: true, doc: null });
    expect(check.note).toMatch(/bot check/);
    // a page that is not there is not a wall
    const missing = await readProduct(crawler, `${OPEN}/p/2`);
    expect(missing).toMatchObject({ wall: false, outcome: "not-found" });
  });

  it("reads an archived copy after a wall, with the date of the copy, and keeps wall true", async () => {
    const hosts = world({
      [SHOP]: (path) =>
        path.startsWith("/products/") ? { status: 403, body: "Forbidden" } : undefined,
      "https://archive.org": (path) =>
        path.startsWith("/wayback/available")
          ? {
              body: JSON.stringify({
                archived_snapshots: {
                  closest: {
                    status: "200",
                    available: true,
                    url: `http://web.archive.org/web/20250102030405/${PAGE}`,
                    timestamp: "20250102030405",
                  },
                },
              }),
              headers: { "content-type": "application/json" },
            }
          : undefined,
      "https://web.archive.org": (path) =>
        path === `/web/20250102030405id_/${PAGE}`
          ? { body: htmlPage("Olio Esempio", FILLER, jsonLd(oil())), headers: HTML }
          : undefined,
    });
    const { crawler } = await openWith(hosts, cleanups);
    const result = await readProduct(crawler, PAGE, { fallback: "archive" });
    expect(result).toMatchObject({
      wall: true,
      outcome: "blocked",
      found: true,
      name: "Olio Esempio",
      price: { amount: 9.9 },
      archived: { source: "wayback", timestamp: "2025-01-02T03:04:05Z" },
      doc: `archive:${PAGE}`,
    });
    expect(result.note).toContain("Wayback Machine");
  });

  it("says that a page with no Product data is not a product, after it tries a render", async () => {
    const hosts = world({
      [SHOP]: (path) =>
        path === "/collections/oil"
          ? {
              body: htmlPage(
                "All our oils",
                FILLER,
                jsonLd({
                  "@type": "ItemList",
                  itemListElement: [{ "@type": "ListItem", position: 1 }],
                }),
              ),
              headers: HTML,
            }
          : undefined,
    });
    const { crawler } = await openWith(hosts, cleanups);
    const result = await readProduct(crawler, `${SHOP}/collections/oil`);
    expect(result).toMatchObject({ found: false, verified: false, wall: false, rendered: false });
    expect(result.note).toContain("no schema.org Product data on the page");
    expect(result.note).toContain("the render gave nothing more");
    const plain = await readProduct(crawler, `${SHOP}/collections/oil`, { render: "never" });
    expect(plain.note).not.toContain("render");
  });

  it("reads nothing from a page that refuses AI input, unless a person gave the URL", async () => {
    const hosts = world({
      [SHOP]: (path) =>
        path === "/products/olio-esempio"
          ? {
              body: htmlPage("Olio Esempio", FILLER, jsonLd(oil())),
              headers: { ...HTML, "content-signal": "ai-input=no" },
            }
          : undefined,
    });
    const { crawler } = await openWith(hosts, cleanups);
    const held = await readProduct(crawler, PAGE);
    expect(held).toMatchObject({ held_back: true, found: false, name: null, price: null });
    expect(held.note).toContain("asked not to be used as AI input");
    const given = await readProduct(crawler, PAGE, { userProvided: true });
    expect(given).toMatchObject({ held_back: false, found: true, name: "Olio Esempio" });
    const overrides: unknown[] = [];
    for await (const record of crawler.runtime.captures.scan({ source: "fetch" })) {
      if (record.kind === "override") overrides.push(record.payload);
    }
    expect(overrides).toMatchObject([{ action: "product" }]);
  });

  it("refuses a URL that is not http or https", async () => {
    const { crawler } = await openWith(world({}), cleanups);
    await expect(readProduct(crawler, "not a url")).rejects.toThrow(TypeError);
    await expect(readProduct(crawler, "file:///etc/passwd")).rejects.toThrow(TypeError);
  });
});

describe("the time of the product reader", () => {
  const linear = (steps: (n: number) => number): void => {
    const small = steps(100);
    const large = steps(200);
    expect(large / small).toBeGreaterThan(1.6);
    expect(large / small).toBeLessThan(2.4);
  };

  it("is linear in the products and in the size of a product", () => {
    linear(
      (n) =>
        productOf(
          Array.from({ length: n }, (_, index) => related(`Olio ${String(index)}`)),
          PAGE,
        ).steps,
    );
    linear(
      (n) =>
        productOf(
          [{ ...oil(), url: undefined, "@id": undefined, description: "olio ".repeat(n * 100) }],
          PAGE,
        ).steps,
    );
  });

  it("stays bounded on very many offers, very many variants and a deep nesting", () => {
    const offers = Array.from({ length: 100_000 }, (_, index) => offer(String(index + 1)));
    const many = productOf([{ "@type": "Product", url: PAGE, name: "Olio", offers }], PAGE);
    expect(many.steps).toBeLessThan(10 * PRODUCT_LIMITS.offers);
    expect(many.price_to?.amount).toBe(PRODUCT_LIMITS.offers);
    let deep: Json = { "@type": "Product", name: "inner", offers: offer("1.00") };
    for (let level = 0; level < 5_000; level += 1) {
      deep = {
        "@type": "Product",
        name: `level ${String(level)}`,
        hasVariant: deep,
        offers: offer("2.00"),
      };
    }
    const nested = productOf([{ ...deep, url: PAGE }], PAGE);
    expect(nested.found).toBe(true);
    expect(nested.steps).toBeLessThan(100);
    const records = Array.from({ length: 10_000 }, () => ({ "@type": "Thing" }));
    expect(productOf(records, PAGE).steps).toBe(PRODUCT_LIMITS.records);
  });
});
