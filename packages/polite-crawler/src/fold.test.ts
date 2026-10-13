import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fold, foldText, locate, parseQuery, snippetOf, tokensOf } from "./fold.ts";

describe("quote verification", () => {
  const text = "Wood-fired bread. We also cater weddings — and large events — on request.";

  it("finds a quote across case, spaces, typographic quotes and dashes, with the original positions", () => {
    const hit = locate(text, "WE ALSO   CATER weddings - and large events");
    expect(hit.found).toBe(true);
    expect(text.slice(hit.start!, hit.end!)).toBe("We also cater weddings — and large events");
    expect(locate("He said “yes” – twice.", 'he said "yes" - twice').found).toBe(true);
    expect(locate("It is 5 °C", "It is −5 °C").found).toBe(false);
    expect(locate("It is −5 °C", "it is -5 °c").found).toBe(true);
  });

  it("ignores soft hyphens and zero-width characters, and reads NFKC, NFC and NFD as one", () => {
    expect(locate("Bäcke­rei am Markt", "Bäckerei am Markt").found).toBe(true);
    expect(locate("open​ now", "open now").found).toBe(true);
    expect(locate("the ﬁnal offer", "the final offer").found).toBe(true);
    expect(locate("Café Central", "Café central").found).toBe(true);
    expect(locate("Café Central", "Café central").found).toBe(true);
    expect(locate("wait for it… done", "wait for it... done").found).toBe(true);
    expect(locate("ＡＢＣ corp", "abc corp").found).toBe(true);
    expect(locate("a b", "a b").found).toBe(true);
    // accents stay: a different word is not a match
    expect(locate("résumé", "resume").found).toBe(false);
  });

  it("maps a letter whose lowercase is longer back to the original text", () => {
    const turkish = "İstanbul is big";
    const hit = locate(turkish, "is big");
    expect(turkish.slice(hit.start!, hit.end!)).toBe("is big");
    const three = "İİİ the end";
    const end = locate(three, "the end");
    expect(end).toMatchObject({ found: true, start: 4, end: 11, count: 1 });
    expect(locate(turkish, "İstanbul")).toMatchObject({ found: true, start: 0, end: 8 });
  });

  it("counts the places of a quote, and does not cut a character in the excerpt", () => {
    expect(locate("one two one two one", "one").count).toBe(3);
    const emoji = `${"😀".repeat(50)} target ${"😀".repeat(50)}`;
    const hit = locate(emoji, "target");
    expect(hit.excerpt!.isWellFormed()).toBe(true);
  });

  it("reads a long text in linear time", () => {
    const long = `${"Lorem ipsum dolor sit amet. ".repeat(40_000)}the end`;
    const started = performance.now();
    expect(locate(long, "THE END").found).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("the positions of a folded text", () => {
  it("point each unit back at its source", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme", maxLength: 200 }),
        fc.constantFrom("quote", "search"),
        (text, mode) => {
          const folded = foldText(text, mode as "quote" | "search");
          expect(folded.start.length).toBe(folded.text.length);
          for (let index = 0; index < folded.text.length; index += 1) {
            expect(folded.start[index]!).toBeGreaterThanOrEqual(0);
            expect(folded.end[index]!).toBeLessThanOrEqual(text.length);
            expect(folded.start[index]!).toBeLessThan(folded.end[index]!);
          }
        },
      ),
    );
  });

  it("find each slice of a text after its quotes, dashes and spaces change", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme-ascii", minLength: 40, maxLength: 300 }),
        fc.nat(),
        (text, at) => {
          const start = at % (text.length - 20);
          const quote = text.slice(start, start + 20);
          fc.pre(quote.trim().length >= 3);
          const retyped = quote
            .replace(/'/g, "’")
            .replace(/-/g, "–")
            .replace(/ /g, "  ")
            .toUpperCase();
          const hit = locate(text, retyped);
          expect(hit.found).toBe(true);
          expect(fold(text.slice(hit.start!, hit.end!), "quote")).toBe(fold(quote, "quote"));
        },
      ),
    );
  });
});

describe("search queries", () => {
  it("fold accents, case and Unicode forms, and split Chinese, Japanese and Thai into characters", () => {
    expect(tokensOf("Café İstanbul STRASSE straße")).toEqual([
      "cafe",
      "istanbul",
      "strasse",
      "strasse",
    ]);
    expect(tokensOf("東京都")).toEqual(["東", "京", "都"]);
    expect(tokensOf("مَدِينَة")).toEqual(tokensOf("مدينة"));
  });

  it("read phrases, prefixes and plain words, and quote each part", () => {
    expect(parseQuery('"wood fired" bake* bread')).toEqual({
      all: '"wood fired" AND "bake" * AND "bread"',
      any: '"wood fired" OR "bake" * OR "bread"',
      terms: ["wood", "bake", "bread"],
      parts: 3,
    });
    expect(parseQuery("e-mail")?.all).toBe('"e mail"');
    expect(parseQuery("NEAR(a b) AND NOT c")?.all).toBe(
      '"near a" AND "b" AND "and" AND "not" AND "c"',
    );
    expect(parseQuery("NEAR(a b) AND NOT c")?.any).toBe('"near a" OR "b" OR "not" OR "c"');
    expect(parseQuery("東京")?.all).toBe('"東 京"');
    expect(parseQuery('"" *** ---')).toBeUndefined();
    expect(parseQuery("😀")).toBeUndefined();
  });

  it("leave the common English words out of the form that needs one part, when other words remain", () => {
    const question = parseQuery(
      "What is the best bread on the menu for a family with kids in the morning and evening",
    )!;
    expect(question.parts).toBe(16);
    expect(question.all.split(" AND ")).toHaveLength(16);
    // the question has 18 words, and the reader reads 16 parts
    expect(question.any).toBe('"best" OR "bread" OR "menu" OR "family" OR "kids" OR "morning"');
    expect(question.terms).toEqual(["best", "bread", "menu", "family", "kids", "morning"]);
    // only common words, a phrase or a prefix: each part stays
    expect(parseQuery("the of")?.any).toBe('"the" OR "of"');
    expect(parseQuery('"the who" bread')?.any).toBe('"the who" OR "bread"');
    expect(parseQuery("the* bread")?.any).toBe('"the" * OR "bread"');
  });

  it("mark the first match in a snippet", () => {
    expect(snippetOf("The bakery opens at dawn and bakes bread.", ["bread"])).toBe(
      "The bakery opens at dawn and bakes [bread].",
    );
    expect(snippetOf("Café Central serves coffee.", ["cafe"])).toBe(
      "[Café] Central serves coffee.",
    );
    expect(snippetOf("nothing here", ["zebra"])).toBe("nothing here");
  });
});
