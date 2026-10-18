/**
 * What the recipe readers of polite-crawler find in one HTML page, as plain data. The worker of the
 * recipe reader starts this function, and the build starts it for the first example. It uses the
 * real code of the package and sends no request:
 *
 * - `extractPage` reads the page, as the crawler does for each fetch.
 * - `venueReadingsOf` reads the hours, and `locate` finds the quote of each reading, as `verify` does.
 * - `productOf` and `pickProduct` read the Product data, and `readAmount` reads each price.
 * - `compareHours` compares a reading with the hours that an application keeps.
 */
import type { Day, HoursComparison, ProductRead, Verified, Week } from "polite-crawler";
import {
  DAYS,
  compareHours,
  disagreements,
  extractPage,
  fromCompact,
  locate,
  pickProduct,
  productOf,
  readAmount,
  typesOf,
  venueReadingsOf,
} from "polite-crawler";

type Json = Readonly<Record<string, unknown>>;

/** The input of the reader: a page, and the inputs of the tool. */
export interface RecipeInput {
  readonly html: string;
  readonly url: string;
  /** This text is the address of the venue, for a page with more than one location. */
  readonly location: string;
  /** These are the kept hours, in the notation of OpenStreetMap. */
  readonly kept: string;
  /** This value is the reading to compare with the kept hours, or null for `from_site`. */
  readonly compareWith: number | null;
  readonly skipSplit: boolean;
}

/** One reading of the hours, with the quote that `verify` finds. */
export interface ReadingView {
  readonly from: "jsonld" | "osm" | "text";
  readonly rank: number;
  readonly schedule: "opening" | "other";
  readonly label: string | null;
  readonly hours: string;
  readonly week: Week;
  readonly inferred: boolean;
  readonly partial: boolean;
  readonly season: string | null;
  readonly raw: string;
  readonly path: string | null;
  /** This value is the quote check of a reading of the text, or null for a JSON-LD reading. */
  readonly quote: Pick<Verified, "found" | "start" | "end" | "count"> | null;
}

/** One day of the comparison with the kept hours. */
export interface DayCompare {
  readonly day: Day;
  readonly kept: string;
  readonly reading: string;
  readonly status: "same" | "changed" | "added" | "skipped" | "unstated";
}

/** One Product record of the page, for the view of the related-product trap. */
export interface ProductCandidate {
  readonly name: string;
  readonly url: string | null;
  readonly offers: boolean;
  /** This value is the size of the record as JSON, in characters. */
  readonly size: number;
  readonly picked: boolean;
}

/** One variant of the product, read alone with `productOf`. */
export interface VariantView {
  readonly name: string | null;
  readonly sku: string | null;
  readonly price: ProductRead["price"];
  readonly old: string | null;
  readonly availability: string | null;
  readonly named: boolean;
}

/** The result of the reader. */
export interface RecipeView {
  readonly ok: boolean;
  readonly error: string | null;
  readonly title: string;
  /** This text names the bot check or the firewall that sent its page, or it is null. */
  readonly blocked: string | null;
  readonly types: readonly string[];
  readonly venue: {
    readonly readings: readonly ReadingView[];
    /** This value is the index of the best reading of the opening hours, or null. */
    readonly best: number | null;
    /** This value is the index of the best reading of the site with no guess (`from_site`), or null. */
    readonly fromSite: number | null;
    readonly disagree: readonly Day[];
    readonly phone: string | null;
    readonly menus: ReadonlyArray<{ readonly url: string; readonly text: string }>;
    readonly notes: readonly string[];
  };
  readonly product: {
    readonly read: Omit<ProductRead, "steps">;
    readonly candidates: readonly ProductCandidate[];
    /** This value tells why the reader picked its product: the URL of the page, or the largest record. */
    readonly why: "url" | "offers" | "size" | null;
    /** This text names the product that the reader picks when no record names the page. */
    readonly without: string | null;
    readonly variants: readonly VariantView[];
    /** These are the prices as the page writes them, and the amounts that `readAmount` reads. */
    readonly amounts: ReadonlyArray<{
      readonly raw: string;
      readonly amount: number | null;
      readonly currency: string | null;
      readonly old: boolean;
    }>;
  };
  readonly compare: {
    readonly keptError: string | null;
    /** This value is the index of the reading of the comparison. */
    readonly reading: number | null;
    readonly result: HoursComparison | null;
    readonly days: readonly DayCompare[];
  };
}

const PRODUCT = /^(?:Product|ProductGroup|IndividualProduct|ProductModel|SomeProducts)$/;
const WAS = /ListPrice|StrikethroughPrice|MSRP|SRP/i;

const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
const objects = (value: unknown): Json[] =>
  list(value).filter(
    (item): item is Json => typeof item === "object" && item !== null && !Array.isArray(item),
  );
const text = (value: unknown): string | null =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : null;

const dayText = (week: Week | undefined, day: Day): string => {
  const value = week?.[day];
  if (value === undefined) return "not stated";
  if (value.length === 0) return "closed";
  return value.map(([open, close]) => `${open}–${close}`).join(", ");
};

/** This function gives the Product records of a page, with the main entities of its records. */
const productsOf = (records: readonly Json[]): Json[] =>
  records.flatMap((record) => [
    ...(typesOf(record as Record<string, unknown>).some((type) => PRODUCT.test(type))
      ? [record]
      : []),
    ...objects(record["mainEntity"]).filter((inner) =>
      typesOf(inner as Record<string, unknown>).some((type) => PRODUCT.test(type)),
    ),
  ]);

interface Written {
  readonly raw: string;
  readonly currency: string | undefined;
  readonly old: boolean;
}

/** This function gives the prices that the offers of a record write, and the old prices. */
const pricesOf = (record: Json): Written[] => {
  const out: Written[] = [];
  for (const offer of objects(record["offers"])) {
    const currency = text(offer["priceCurrency"]) ?? undefined;
    const own = text(offer["price"]);
    if (own !== null) out.push({ raw: own, currency, old: false });
    for (const spec of objects(offer["priceSpecification"])) {
      const price = text(spec["price"]);
      const kind = text(spec["priceType"]) ?? "";
      if (price !== null)
        out.push({
          raw: price,
          currency: text(spec["priceCurrency"]) ?? currency,
          old: WAS.test(kind),
        });
    }
  }
  return out;
};

/** This function gives the host and the path of a URL, as the product reader compares them. */
const pathOf = (value: string, page: string): string | undefined => {
  if (value.startsWith("#")) return undefined;
  try {
    const at = new URL(value, page);
    return `${at.hostname.toLowerCase().replace(/^www\./, "")}${at.pathname.replace(/\/$/, "")}`;
  } catch {
    return undefined;
  }
};

/** This function gives a result of `productOf` with no count of the work. */
const withoutSteps = (read: ProductRead): Omit<ProductRead, "steps"> =>
  Object.fromEntries(Object.entries(read).filter(([key]) => key !== "steps")) as Omit<
    ProductRead,
    "steps"
  >;

const failed = (error: unknown): RecipeView => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
  title: "",
  blocked: null,
  types: [],
  venue: {
    readings: [],
    best: null,
    fromSite: null,
    disagree: [],
    phone: null,
    menus: [],
    notes: [],
  },
  product: {
    read: {
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
      notes: [],
    },
    candidates: [],
    why: null,
    without: null,
    variants: [],
    amounts: [],
  },
  compare: { keptError: null, reading: null, result: null, days: [] },
});

/** This function reads one page with the readers of the recipes. */
export const readRecipes = (input: RecipeInput): RecipeView => {
  const url = input.url.trim().length > 0 ? input.url.trim() : "https://example.com/";
  try {
    const page = extractPage(input.html, url);
    const records = page.jsonld.filter(
      (record): record is Json =>
        typeof record === "object" && record !== null && !Array.isArray(record),
    );

    // the venue reader, on the document that the crawler keeps for the page
    const address = input.location.trim();
    const venue = venueReadingsOf(
      { url, text: page.text, meta: { jsonld: page.jsonld, links: page.links } },
      address.length > 0 ? { location: { address } } : {},
    );
    // one reading for each source, label and week, the best first, as readVenue gives them
    const seen = new Set<string>();
    const unique = venue.readings
      .filter((one) => {
        const key = `${one.from}|${one.label ?? ""}|${one.hours}|${one.season ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.rank - b.rank || Number(a.inferred) - Number(b.inferred));
    const readings: ReadingView[] = unique.map((one) => {
      const quote = one.from === "text" ? locate(page.text, one.raw) : null;
      return {
        from: one.from,
        rank: one.rank,
        schedule: one.schedule,
        label: one.label,
        hours: one.hours,
        week: one.week,
        inferred: one.inferred,
        partial: one.partial,
        season: one.season,
        raw: one.raw,
        path: one.path,
        quote:
          quote === null
            ? null
            : { found: quote.found, start: quote.start, end: quote.end, count: quote.count },
      };
    });
    const best = readings.findIndex((one) => one.schedule === "opening");
    const fromSite = readings.findIndex(
      (one) => one.from !== "osm" && one.schedule === "opening" && !one.inferred,
    );
    const whole = readings.filter((one) => one.rank <= 2);
    const disagree = new Set<Day>();
    for (let i = 0; i < whole.length; i += 1)
      for (let j = i + 1; j < whole.length; j += 1)
        for (const day of disagreements(whole[i]!.week, whole[j]!.week)) disagree.add(day);

    // the comparison with the kept hours
    let keptError: string | null = null;
    let kept: Week | undefined;
    if (input.kept.trim().length > 0) {
      const parsed = fromCompact(input.kept.trim());
      if (parsed === undefined)
        keptError = "The kept hours are not OpenStreetMap notation that the reader can read.";
      else kept = parsed.week;
    }
    const chosen =
      input.compareWith !== null && readings[input.compareWith] !== undefined
        ? input.compareWith
        : fromSite === -1
          ? best === -1
            ? null
            : best
          : fromSite;
    const reading = chosen === null ? undefined : readings[chosen];
    const result =
      reading === undefined || (kept === undefined && keptError !== null)
        ? null
        : compareHours(kept, reading.week, { skipSplit: input.skipSplit });
    const days: DayCompare[] =
      reading === undefined || result === null
        ? []
        : DAYS.map((day) => ({
            day,
            kept: dayText(kept, day),
            reading: dayText(reading.week, day),
            status: result.days.includes(day)
              ? result.status === "new"
                ? "added"
                : "changed"
              : result.added.includes(day)
                ? "added"
                : result.skipped.includes(day)
                  ? "skipped"
                  : reading.week[day] === undefined
                    ? "unstated"
                    : "same",
          }));

    // the product reader: the page's own product, its variants and its prices
    const read = withoutSteps(productOf(records, url));
    const picked = pickProduct(records, url).product;
    const products = productsOf(records);
    // the product that the reader picks when no record names the page
    const elsewhere = pickProduct(records, "https://elsewhere.example/").product;
    const nameOf = (record: Json | undefined): string | null =>
      record === undefined ? null : (text(record["name"]) ?? "a product with no name");
    const here = pathOf(url, url);
    const namesPage =
      picked !== undefined &&
      [picked["url"], picked["@id"]].some(
        (value) => typeof value === "string" && here !== undefined && pathOf(value, url) === here,
      );
    const why: RecipeView["product"]["why"] =
      picked === undefined
        ? null
        : namesPage
          ? "url"
          : objects(picked["offers"]).length > 0 || objects(picked["hasVariant"]).length > 0
            ? "offers"
            : "size";
    const candidates = products.map((record) => ({
      name: nameOf(record) ?? "",
      url: text(record["url"]) ?? text(record["@id"]),
      offers: objects(record["offers"]).length > 0 || objects(record["hasVariant"]).length > 0,
      size: JSON.stringify(record).length,
      picked: record === picked,
    }));
    const named = read.variant?.sku ?? null;
    const variants: VariantView[] =
      picked === undefined
        ? []
        : objects(picked["hasVariant"]).map((variant) => {
            const one = productOf([variant], url);
            const old = pricesOf(variant).find((price) => price.old)?.raw ?? null;
            return {
              name: one.name,
              sku: one.sku,
              price: one.price,
              old,
              availability: one.availability,
              named: named !== null && one.sku === named,
            };
          });
    const amounts = (picked === undefined ? [] : [picked, ...objects(picked["hasVariant"])])
      .flatMap(pricesOf)
      .map((price) => ({
        raw: price.raw,
        amount: readAmount(price.raw, price.currency) ?? null,
        currency: price.currency ?? null,
        old: price.old,
      }));

    return {
      ok: true,
      error: null,
      title: page.title,
      blocked: page.blocked,
      types: [
        ...new Set(page.jsonld.flatMap((record) => typesOf(record as Record<string, unknown>))),
      ],
      venue: {
        readings,
        best: best === -1 ? null : best,
        fromSite: fromSite === -1 ? null : fromSite,
        disagree: DAYS.filter((day) => disagree.has(day)),
        phone: venue.phone,
        menus: venue.menus,
        notes: venue.notes,
      },
      product: {
        read,
        candidates,
        why,
        without: why === "url" && elsewhere !== picked ? nameOf(elsewhere) : null,
        variants,
        amounts,
      },
      compare: { keptError, reading: chosen, result, days },
    };
  } catch (error) {
    return failed(error);
  }
};
