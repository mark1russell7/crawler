import { describe, expect, it } from "vitest";
import type { ExtractSource, FieldCheck, FieldClaim } from "./extract.ts";
import { checkFields } from "./extract.ts";

// special characters from their codes, so that no escape in this file changes on a write
const SHY = String.fromCharCode(0xad);
const NBSP = String.fromCharCode(0xa0);
const NNBSP = String.fromCharCode(0x202f);
const MINUS = String.fromCharCode(0x2212);
const LIGATURE_FI = String.fromCharCode(0xfb01);
const RIGHT_QUOTE = String.fromCharCode(0x2019);
const EN_DASH = String.fromCharCode(0x2013);
const fullwidth = (digits: string): string =>
  digits
    .split("")
    .map((digit) => String.fromCharCode(0xff10 + Number(digit)))
    .join("");

const PAGE = "https://forno.example/";

const check = (text: string, claim: FieldClaim, extra: Partial<ExtractSource> = {}): FieldCheck => {
  const source: ExtractSource = { text, url: PAGE, ...extra };
  const result = checkFields(source, { field: claim });
  const field = result.fields["field"]!;
  // each span maps back to the original text: the stored text of the match is the slice
  if (field.span !== null) {
    const stored = field.span.in === "text" ? text : (extra.full_text ?? "");
    expect(stored.slice(field.span.start, field.span.end)).toBe(field.raw);
    expect(field.excerpt).toContain(String(field.raw));
  }
  for (const candidate of field.candidates) {
    if (candidate.span === null) continue;
    const stored = candidate.span.in === "text" ? text : (extra.full_text ?? "");
    expect(stored.slice(candidate.span.start, candidate.span.end)).toBe(candidate.raw);
  }
  return field;
};

describe("text", () => {
  it("verifies the exact text, and gives its span in the original text", () => {
    const text = "Forno Esempio bakes bread. Forno Esempio opens at 7.";
    const field = check(text, { value: "Forno Esempio" });
    expect(field).toMatchObject({
      status: "verified",
      kind: "text",
      span: { start: 0, end: 13, in: "text" },
      raw: "Forno Esempio",
      normalization: null,
      count: 2,
    });
  });

  it("names each normalization: whitespace, case and Unicode", () => {
    expect(check("Wood-fired   bread", { value: "Wood-fired bread" })).toMatchObject({
      status: "normalized",
      normalization: "whitespace",
      raw: "Wood-fired   bread",
    });
    expect(check("WOOD-FIRED bread", { value: "wood-fired bread" })).toMatchObject({
      status: "normalized",
      normalization: "case",
    });
    expect(check(`Tom${RIGHT_QUOTE}s bakery`, { value: "Tom's bakery" })).toMatchObject({
      status: "normalized",
      normalization: "unicode",
    });
    expect(check(`Wood${EN_DASH}FIRED  bread`, { value: "wood-fired bread" })).toMatchObject({
      status: "normalized",
      normalization: "unicode+whitespace+case",
    });
  });

  it("maps a match back over soft hyphens and NFKC forms", () => {
    const text = `Our of${SHY}fice sells ${LIGATURE_FI}ne bread`;
    const office = check(text, { value: "office" });
    expect(office).toMatchObject({ status: "normalized", normalization: "unicode" });
    expect(office.raw).toBe(`of${SHY}fice`);
    const fine = check(text, { value: "fine bread" });
    expect(fine.raw).toBe(`${LIGATURE_FI}ne bread`);
    expect(fine.span).toEqual({ start: 18, end: 27, in: "text" });
  });

  it("matches only at the edges of words, and says when the text is not there", () => {
    expect(check("Annual report", { value: "Ann" }).status).toBe("not-found");
    expect(check("Ann wrote the report", { value: "Ann" }).status).toBe("verified");
    expect(check("Forno Esempio", { value: "Panificio" })).toMatchObject({
      status: "not-found",
      span: null,
      raw: null,
      count: 0,
    });
  });

  it("reads the whole text when the reader cut the text", () => {
    const field = check(
      "The first part of the page.",
      { value: "Closed on Mondays" },
      { full_text: "The first part of the page. Closed on Mondays." },
    );
    expect(field).toMatchObject({
      status: "verified",
      span: { start: 28, end: 45, in: "full_text" },
    });
  });

  it("gives invalid for a value with no text", () => {
    expect(check("text", { value: "   " })).toMatchObject({
      status: "invalid",
      note: "the value is empty",
    });
    expect(check("text", { value: SHY })).toMatchObject({ status: "invalid" });
  });
});

describe("numbers", () => {
  it("verifies a number as written", () => {
    expect(
      check("It costs 1,234.50 in total", { value: "1,234.50", kind: "number" }),
    ).toMatchObject({
      status: "verified",
      raw: "1,234.50",
      reading: "1234.5",
    });
    expect(check("A 12 inch loaf", { value: 12 })).toMatchObject({
      status: "verified",
      kind: "number",
    });
  });

  it("reads the thousands separators of either convention, and the decimal comma", () => {
    const cases: Array<[string, string]> = [
      ["1,234.50", "thousands-separator+number-form"],
      ["1.234,50", "thousands-separator+decimal-comma+number-form"],
      [`1${NBSP}234,5`, "thousands-separator+decimal-comma"],
      [`1${NNBSP}234.5`, "thousands-separator"],
      ["1'234.5", "thousands-separator"],
      [`1${RIGHT_QUOTE}234.5`, "thousands-separator"],
    ];
    for (const [written, normalization] of cases) {
      const field = check(`Price ${written} today`, { value: 1234.5 });
      expect(field, written).toMatchObject({
        status: "normalized",
        raw: written,
        reading: "1234.5",
        normalization,
      });
    }
    expect(check("Add 12,5 g of salt", { value: "12.5", kind: "number" })).toMatchObject({
      status: "normalized",
      normalization: "decimal-comma",
    });
    expect(check("It is 12.50 now", { value: "12.5", kind: "number" })).toMatchObject({
      status: "normalized",
      normalization: "number-form",
    });
    expect(check("Down to 0012 units", { value: 12 })).toMatchObject({
      status: "normalized",
      normalization: "number-form",
    });
  });

  it("names a difference of the characters only as unicode", () => {
    expect(check(`It was ${MINUS}5 degrees`, { value: -5 })).toMatchObject({
      status: "normalized",
      normalization: "unicode",
      raw: `${MINUS}5`,
    });
    const wide = check(`Room ${fullwidth("1234")}`, { value: 1234 });
    expect(wide).toMatchObject({ status: "normalized", normalization: "unicode" });
    expect(wide.raw).toBe(fullwidth("1234"));
  });

  it("gives ambiguous for three digits after one separator, and never guesses", () => {
    const field = check("Visitors: 1,234", { value: 1234 });
    expect(field.status).toBe("ambiguous");
    expect(field.candidates).toHaveLength(1);
    expect(field.candidates[0]).toMatchObject({ raw: "1,234", readings: ["1234", "1.234"] });
    expect(check("It weighs 1.234 kg", { value: 1234 }).status).toBe("ambiguous");
    // the exact text wins: the caller gives it its meaning
    expect(check("It weighs 1.234 kg", { value: 1.234 }).status).toBe("verified");
  });

  it("gives normalized when one place has one meaning, also next to an ambiguous place", () => {
    const field = check("About 1,234 people, exactly 1,234.0 people", { value: 1234 });
    expect(field).toMatchObject({ status: "normalized", raw: "1,234.0", count: 1 });
  });

  it("gives ambiguous for a value that has two meanings itself", () => {
    const field = check("Exactly 1234.0 people", { value: "1,234", kind: "number" });
    expect(field.status).toBe("ambiguous");
    expect(field.note).toContain("the value itself has more than one meaning");
  });

  it("does not read a number in a name, a fraction or a part of a longer number", () => {
    expect(check("The A320 lands", { value: 320 }).status).toBe("not-found");
    expect(check("Release v2.0", { value: 2 }).status).toBe("not-found");
    expect(check("Use .5 cup", { value: 5 }).status).toBe("not-found");
    expect(check("It costs 11,234", { value: 1234 }).status).toBe("not-found");
    expect(check("Pages 1 234 and on", { value: 1234 }).status).toBe("not-found");
    expect(check("Version 1.2.3 is out", { value: 3 })).toMatchObject({ status: "verified" });
  });

  it("gives invalid for a value that is not a number", () => {
    expect(check("1234", { value: "twelve", kind: "number" })).toMatchObject({
      status: "invalid",
      note: "the value is not a number",
    });
    expect(check("1234", { value: Number.NaN })).toMatchObject({ status: "invalid" });
    expect(check("1234", { value: "12 34", kind: "number" }).status).toBe("invalid");
  });

  it("writes a very small or a very large number of JavaScript in decimal digits", () => {
    expect(check("It is 0.0000001 m", { value: 1e-7 })).toMatchObject({ status: "verified" });
    expect(check("It is 1000000000000000000000 m", { value: 1e21 })).toMatchObject({
      status: "verified",
    });
  });
});

describe("money", () => {
  it("verifies an amount as written, and the amount alone", () => {
    const text = "The loaf is $12.99 today.";
    expect(check(text, { value: "$12.99", kind: "money" })).toMatchObject({
      status: "verified",
      raw: "$12.99",
    });
    const amount = check(text, { value: "12.99", kind: "money" });
    expect(amount).toMatchObject({ status: "verified", raw: "12.99" });
    expect(amount.span).toEqual({ start: 13, end: 18, in: "text" });
  });

  it("reads the currency symbol or code next to the amount", () => {
    expect(check("Only €12,50 each", { value: "12.50 EUR", kind: "money" })).toMatchObject({
      status: "normalized",
      raw: "€12,50",
      reading: "EUR 12.5",
      normalization: "decimal-comma+currency-symbol+currency-position",
    });
    expect(check("Only 12,50 € each", { value: "€12,50", kind: "money" })).toMatchObject({
      status: "normalized",
      normalization: "currency-position",
    });
    expect(check("Now US$12.99", { value: "USD 12.99", kind: "money" })).toMatchObject({
      status: "normalized",
      normalization: "currency-symbol",
    });
    expect(check("Price: 1.234,00 kr", { value: "1234 kr", kind: "money" })).toMatchObject({
      status: "normalized",
      normalization: "thousands-separator+decimal-comma+number-form",
    });
    expect(check("Now $ 12.99", { value: "$12.99", kind: "money" })).toMatchObject({
      status: "normalized",
      normalization: "whitespace",
    });
    expect(check("It costs 15 TRY", { value: 15.0, kind: "money" })).toMatchObject({
      status: "verified",
    });
    expect(check("It costs 15 TRY", { value: "15.00", kind: "money" })).toMatchObject({
      status: "normalized",
      normalization: "number-form+amount-only",
    });
  });

  it("gives ambiguous for a symbol of more than one currency", () => {
    const field = check("The loaf is $12.99", { value: "USD 12.99", kind: "money" });
    expect(field.status).toBe("ambiguous");
    expect(field.candidates[0]).toMatchObject({ raw: "$12.99", readings: ["$ 12.99"] });
    expect(check("Two for ¥500", { value: "JPY 500", kind: "money" }).status).toBe("ambiguous");
  });

  it("gives ambiguous for one amount in two currencies", () => {
    const field = check("It is $12.99 or €12.99", { value: "12.990", kind: "money" });
    expect(field.status).toBe("ambiguous");
    expect(field.candidates.map((candidate) => candidate.readings[0])).toEqual([
      "$ 12.99",
      "EUR 12.99",
    ]);
  });

  it("does not match a different currency, a code in small letters, or a bare number", () => {
    expect(check("Only £5", { value: "EUR 5", kind: "money" }).status).toBe("not-found");
    expect(check("Only £5", { value: "GBP 5", kind: "money" }).status).toBe("normalized");
    expect(check("Give it 15 try again", { value: 15, kind: "money" }).status).toBe("not-found");
    expect(check("It costs 12.99", { value: "$12.99", kind: "money" }).status).toBe("not-found");
    expect(check("It costs $12", { value: "dollars", kind: "money" }).status).toBe("invalid");
  });
});

describe("dates", () => {
  it("verifies a date as written", () => {
    expect(check("Open on 2026-03-04.", { value: "2026-03-04", kind: "date" })).toMatchObject({
      status: "verified",
      reading: "2026-03-04",
    });
  });

  it("reads ISO dates and the written English months", () => {
    const cases: Array<[string, string, string]> = [
      ["Open on 2026-03-04.", "March 4, 2026", "date-iso"],
      ["Open on March 4, 2026.", "2026-03-04", "date-written"],
      ["Open on Mar. 4th 2026.", "2026-03-04", "date-written"],
      ["Open on 4 March 2026.", "2026-03-04", "date-written"],
      ["Open on the 4th of March, 2026.", "2026-03-04", "date-written"],
      ["Open on Tuesday, March 4, 2026.", "2026-03-04", "date-written"],
      ["Open on 2026/03/04.", "2026-03-04", "date-ymd"],
      ["Open on March 4, 2026.", "4 Mar 2026", "date-form"],
    ];
    for (const [text, value, normalization] of cases) {
      expect(check(text, { value, kind: "date" }), text).toMatchObject({
        status: "normalized",
        reading: "2026-03-04",
        normalization,
      });
    }
  });

  it("reads a numeric date only when the order of the day and the month is clear", () => {
    expect(check("Due 17/10/2026", { value: "2026-10-17", kind: "date" })).toMatchObject({
      status: "normalized",
      normalization: "date-dmy",
    });
    expect(check("Due 10/17/2026", { value: "2026-10-17", kind: "date" })).toMatchObject({
      status: "normalized",
      normalization: "date-mdy",
    });
    expect(check("Due 05.05.2026", { value: "2026-05-05", kind: "date" })).toMatchObject({
      status: "normalized",
      normalization: "date-numeric",
    });
  });

  it("flags the order of the day and the month, and never guesses it", () => {
    const field = check("Due 03/04/2026", { value: "2026-03-04", kind: "date" });
    expect(field.status).toBe("ambiguous");
    expect(field.candidates[0]).toMatchObject({
      raw: "03/04/2026",
      readings: ["2026-03-04", "2026-04-03"],
    });
    const value = check("Due 2026-03-04", { value: "03/04/2026", kind: "date" });
    expect(value.status).toBe("ambiguous");
    expect(value.note).toContain("the value itself has more than one meaning");
  });

  it("does not add a year that the text does not give", () => {
    const field = check("Open until March 4.", { value: "2026-03-04", kind: "date" });
    expect(field.status).toBe("ambiguous");
    expect(field.candidates[0]).toMatchObject({ raw: "March 4", readings: ["--03-04"] });
  });

  it("matches a value with less detail, and flags two places with different meanings", () => {
    expect(check("Open until March 4, 2026.", { value: "March 4", kind: "date" })).toMatchObject({
      status: "normalized",
      reading: "2026-03-04",
      normalization: "date-form+date-partial",
    });
    expect(check("Open in March 2026.", { value: "2026-03", kind: "date" })).toMatchObject({
      status: "normalized",
      normalization: "date-written",
    });
    const two = check("Open March 4, 2026 and March 4, 2027.", { value: "March 4", kind: "date" });
    expect(two.status).toBe("ambiguous");
    expect(two.candidates.map((candidate) => candidate.readings[0])).toEqual([
      "2026-03-04",
      "2027-03-04",
    ]);
  });

  it("compares only the date of a value with a time, and says so", () => {
    const field = check("Starts on March 4, 2026.", {
      value: "2026-03-04T19:00:00Z",
      kind: "date",
    });
    expect(field).toMatchObject({ status: "normalized", normalization: "date-written" });
    expect(field.note).toContain("not its time");
  });

  it("does not read a time, a price or a wrong date as a date", () => {
    expect(check("Opens May 5:30", { value: "May 5", kind: "date" }).status).toBe("not-found");
    expect(check("Costs 12.50 now", { value: "2026-12-05", kind: "date" }).status).toBe(
      "not-found",
    );
    expect(check("Open on March 5, 2026", { value: "2026-03-04", kind: "date" }).status).toBe(
      "not-found",
    );
    expect(check("Due 31/02/2026", { value: "2026-02-28", kind: "date" }).status).toBe("not-found");
  });

  it("gives invalid for a value that is not a date", () => {
    expect(check("x", { value: "2026-02-30", kind: "date" })).toMatchObject({ status: "invalid" });
    expect(check("x", { value: "soon", kind: "date" })).toMatchObject({
      status: "invalid",
      note: "the value is not a date",
    });
    expect(check("x", { value: 20260304, kind: "date" }).status).toBe("invalid");
  });
});

describe("URLs", () => {
  it("verifies a URL as written, with no final point", () => {
    expect(
      check("Order at https://forno.example/order. Thanks", {
        value: "https://forno.example/order",
        kind: "url",
      }),
    ).toMatchObject({ status: "verified", raw: "https://forno.example/order" });
  });

  it("resolves a relative URL against the page URL", () => {
    expect(
      check("Order at https://forno.example/order today", { value: "/order", kind: "url" }),
    ).toMatchObject({
      status: "normalized",
      reading: "https://forno.example/order",
      normalization: "url-resolved",
    });
  });

  it("compares the canonical forms, and names a page URL with no scheme", () => {
    expect(
      check("See https://forno.example/order", {
        value: "HTTPS://FORNO.EXAMPLE/order",
        kind: "url",
      }),
    ).toMatchObject({ status: "normalized", normalization: "url-form" });
    expect(
      check("See www.forno.example/menu for more", {
        value: "https://www.forno.example/menu",
        kind: "url",
      }),
    ).toMatchObject({
      status: "normalized",
      normalization: "url-scheme",
      raw: "www.forno.example/menu",
    });
    expect(
      check("See https://forno.example/Menu", { value: "https://forno.example/menu", kind: "url" })
        .status,
    ).toBe("not-found");
  });

  it("keeps a bracket that the URL opens, and leaves out a bracket of the sentence", () => {
    const text = "(see https://wiki.example/A_(b)) and (https://x.example/c)";
    expect(check(text, { value: "https://wiki.example/A_(b)", kind: "url" }).status).toBe(
      "verified",
    );
    expect(check(text, { value: "https://x.example/c", kind: "url" }).status).toBe("verified");
  });

  it("finds a URL in the stored links, with the path of the link", () => {
    const field = check(
      "Order now",
      { value: "/order", kind: "url" },
      { meta: { links: [{ href: "https://forno.example/order", text: "Order now" }] } },
    );
    expect(field).toMatchObject({
      status: "normalized",
      span: null,
      path: "links[0]",
      raw: "https://forno.example/order",
      normalization: "url-resolved",
    });
    expect(field.excerpt).toBe("Order now (https://forno.example/order)");
  });

  it("gives invalid for a value that is not an http or https URL", () => {
    expect(check("x", { value: "mailto:a@b.example", kind: "url" }).status).toBe("invalid");
    expect(check("x", { value: "two words", kind: "url" }).status).toBe("invalid");
    expect(
      checkFields({ text: "x" }, { field: { value: "/relative", kind: "url" } }).fields["field"]
        ?.status,
    ).toBe("invalid");
  });
});

describe("email addresses", () => {
  it("verifies an address, and compares the case", () => {
    const text = "Write to Info@Forno.example. We answer.";
    expect(check(text, { value: "Info@Forno.example", kind: "email" })).toMatchObject({
      status: "verified",
      raw: "Info@Forno.example",
    });
    expect(check(text, { value: "mailto:Info@Forno.example", kind: "email" }).status).toBe(
      "verified",
    );
    expect(check(text, { value: "info@forno.example", kind: "email" })).toMatchObject({
      status: "normalized",
      normalization: "email-case",
      reading: "info@forno.example",
    });
    expect(check(text, { value: "orders@forno.example", kind: "email" }).status).toBe("not-found");
    expect(check(text, { value: "not an address", kind: "email" }).status).toBe("invalid");
  });
});

describe("phone numbers", () => {
  it("compares the digits only", () => {
    const text = "Call (617) 555-1234 today";
    expect(check(text, { value: "(617) 555-1234", kind: "phone" })).toMatchObject({
      status: "verified",
    });
    expect(check(text, { value: "617.555.1234", kind: "phone" })).toMatchObject({
      status: "normalized",
      normalization: "phone-digits",
      raw: "(617) 555-1234",
    });
    expect(check(text, { value: "tel:6175551234", kind: "phone" }).status).toBe("normalized");
  });

  it("compares by suffix: a country code, or a number with less detail", () => {
    const text = "Call (617) 555-1234 today";
    expect(check(text, { value: "+1 617 555 1234", kind: "phone" })).toMatchObject({
      status: "normalized",
      normalization: "phone-suffix",
    });
    expect(check(text, { value: "555-1234", kind: "phone" })).toMatchObject({
      status: "normalized",
      normalization: "phone-suffix",
      reading: "6175551234",
    });
    expect(
      check("Ring 020 7946 0958", { value: "+44 20 7946 0958", kind: "phone" }).normalization,
    ).toBe("phone-suffix");
    expect(
      check("Ring +44 (0)20 7946 0958", { value: "020 7946 0958", kind: "phone" }).status,
    ).toBe("normalized");
  });

  it("gives ambiguous for two numbers with the same suffix, and for a number with less detail", () => {
    const two = check("Call (617) 555-1234 or (508) 555-1234", {
      value: "555-1234",
      kind: "phone",
    });
    expect(two.status).toBe("ambiguous");
    expect(two.candidates.map((candidate) => candidate.readings[0])).toEqual([
      "6175551234",
      "5085551234",
    ]);
    const same = check("Call +1 617 555 1234 or (617) 555-1234", {
      value: "555-1234",
      kind: "phone",
    });
    expect(same).toMatchObject({ status: "normalized", count: 2 });
    const short = check("Call 555-1234", { value: "+1 617 555 1234", kind: "phone" });
    expect(short.status).toBe("ambiguous");
  });

  it("does not match a different number, and gives invalid for too few digits", () => {
    expect(check("Call (617) 555-1234", { value: "+1 999 555 1235", kind: "phone" }).status).toBe(
      "not-found",
    );
    expect(check("Call 12345", { value: "12345", kind: "phone" }).status).toBe("invalid");
    expect(check("Call 1-800-FLOWERS", { value: "1-800-FLOWERS", kind: "phone" }).status).toBe(
      "invalid",
    );
  });
});

describe("JSON-LD paths", () => {
  const meta = {
    jsonld: [
      {
        "@type": "Product",
        name: "Focaccia",
        offers: [
          { "@type": "Offer", price: 4.5, priceCurrency: "EUR" },
          { "@type": "Offer", price: "6.00", priceCurrency: "EUR" },
        ],
      },
      {
        "@type": "Event",
        startDate: "2026-03-04T19:00",
        location: { "@type": "Place", url: "/venue", name: { "@value": "The Hall" } },
      },
    ],
    jsonld_dropped: 0,
  };
  const at = (path: string, value: string | number): FieldCheck =>
    check("No text", { value, kind: `json-ld:${path}` }, { meta });

  it("verifies a value at a path, and gives the path and the raw value", () => {
    expect(at("Product.offers.price", 4.5)).toMatchObject({
      status: "verified",
      span: null,
      path: "jsonld[0].offers[0].price",
      raw: 4.5,
    });
    expect(at("Product.offers.price", "6.00")).toMatchObject({
      status: "verified",
      path: "jsonld[0].offers[1].price",
      raw: "6.00",
    });
    expect(at("Product.name", "Focaccia").status).toBe("verified");
    expect(at("*.name", "Focaccia").path).toBe("jsonld[0].name");
  });

  it("starts at an object of the type at any depth", () => {
    expect(at("Offer.price", "6.00").path).toBe("jsonld[0].offers[1].price");
    expect(at("Place.name", "The Hall")).toMatchObject({
      status: "verified",
      path: "jsonld[1].location.name.@value",
    });
  });

  it("compares as a number, a date, a URL and a text", () => {
    expect(at("Product.offers.price", "4.50")).toMatchObject({
      status: "normalized",
      normalization: "number-form",
    });
    expect(at("Product.offers.price", 6)).toMatchObject({ status: "normalized", raw: "6.00" });
    expect(at("Event.startDate", "March 4, 2026")).toMatchObject({
      status: "normalized",
      normalization: "date-iso",
    });
    expect(at("Place.url", "https://forno.example/venue")).toMatchObject({
      status: "normalized",
      normalization: "url-resolved",
    });
    expect(at("Product.name", "FOCACCIA")).toMatchObject({
      status: "normalized",
      normalization: "case",
    });
  });

  it("gives not-found for a value or a path that is not there, and says when the store left records out", () => {
    expect(at("Product.offers.price", 7).status).toBe("not-found");
    expect(at("Product.sku", "x").status).toBe("not-found");
    expect(at("Recipe.name", "Focaccia").status).toBe("not-found");
    const dropped = check(
      "No text",
      { value: "x", kind: "json-ld:Recipe.name" },
      { meta: { ...meta, jsonld_dropped: 2 } },
    );
    expect(dropped.note).toContain("2 records left out");
    expect(check("No text", { value: "x", kind: "json-ld:Product.name" }).status).toBe("not-found");
  });

  it("does not compare a word as a relative URL", () => {
    expect(at("Product.name", "Focaccia ").status).toBe("verified");
    expect(at("Product.name", "focaccia").normalization).toBe("case");
  });

  it("reads JSON-LD nested deeply with no recursion", () => {
    let deep: unknown = "bottom";
    for (let level = 0; level < 20_000; level += 1) deep = [deep];
    const field = check(
      "No text",
      { value: "bottom", kind: "json-ld:Thing.value" },
      { meta: { jsonld: [{ "@type": "Thing", value: deep }] } },
    );
    expect(field.status).toBe("verified");
  });
});

describe("the fields and their kinds", () => {
  it("checks several fields in one call, and counts the statuses", () => {
    const result = checkFields(
      { text: "Forno Esempio. Bread $4.50. Call (617) 555-1234. Since 03/04/2001.", url: PAGE },
      {
        name: { value: "Forno Esempio" },
        price: { value: "USD 4.50", kind: "money" },
        phone: { value: "617-555-1234", kind: "phone" },
        since: { value: "2001-03-04", kind: "date" },
        email: { value: "info@forno.example", kind: "email" },
        bad: { value: "x", kind: "number" },
      },
    );
    expect(
      Object.fromEntries(
        Object.entries(result.fields).map(([name, field]) => [name, field.status]),
      ),
    ).toEqual({
      name: "verified",
      price: "ambiguous",
      phone: "normalized",
      since: "ambiguous",
      email: "not-found",
      bad: "invalid",
    });
    expect(result.summary).toEqual({
      fields: 6,
      verified: 1,
      normalized: 1,
      ambiguous: 2,
      not_found: 1,
      held_back: 0,
      invalid: 1,
    });
  });

  it("refuses a kind, a value or fields that are not valid", () => {
    const text = { text: "x" };
    expect(() =>
      checkFields(text, { field: { value: "x", kind: "colour" as unknown as "text" } }),
    ).toThrow(RangeError);
    expect(() => checkFields(text, { field: { value: "x", kind: "json-ld:" } })).toThrow(
      RangeError,
    );
    expect(() => checkFields(text, { field: { value: true as unknown as string } })).toThrow(
      /a text or a number/,
    );
    expect(() => checkFields(text, { "": { value: "x" } })).toThrow(/must not be empty/);
    expect(() => checkFields(text, null as unknown as Record<string, FieldClaim>)).toThrow(
      RangeError,
    );
    expect(checkFields(text, {}).summary.fields).toBe(0);
  });
});

describe("the time of the check", () => {
  /** The work of a check of a text of n units, for n and 2n: it grows in proportion. */
  const linear = (make: (n: number) => string, fields: Record<string, FieldClaim>): void => {
    const steps = (n: number): number => checkFields({ text: make(n), url: PAGE }, fields).steps;
    const small = steps(20_000);
    const large = steps(40_000);
    expect(large / small).toBeGreaterThan(1.6);
    expect(large / small).toBeLessThan(2.4);
    expect(large / make(40_000).length).toBeLessThan(200);
  };
  const ALL: Record<string, FieldClaim> = {
    text: { value: "aaaaaaaaab" },
    number: { value: 1234.5 },
    money: { value: "USD 9.99", kind: "money" },
    date: { value: "2026-03-04", kind: "date" },
    url: { value: "https://x.example/a", kind: "url" },
    email: { value: "a@b.example", kind: "email" },
    phone: { value: "+1 617 555 1234", kind: "phone" },
  };

  it("is linear on a large page of mixed content", () => {
    const part =
      "Bread $4.50, 1,234.5 g, 03/04/2026, March 4, 2026, (617) 555-1234, https://x.example/a, a@b.example. ";
    linear((n) => part.repeat(Math.ceil(n / part.length)).slice(0, n), ALL);
  });

  it("is linear on texts that are hard for each reader", () => {
    const repeat = (unit: string) => (n: number) =>
      unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    linear(repeat("a"), ALL);
    linear(repeat("1,"), ALL);
    linear(repeat("1."), ALL);
    linear(repeat("a@"), ALL);
    linear(repeat("@a."), ALL);
    linear(repeat("("), ALL);
    linear(repeat("1-"), ALL);
    linear(repeat("march "), ALL);
    linear(repeat("4 march "), ALL);
    linear(repeat("$1 "), ALL);
    linear((n) => `http://x.example/${")".repeat(n)}`, ALL);
    linear((n) => `https://${"(".repeat(n)}`, ALL);
  });
});
