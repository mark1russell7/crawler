/**
 * The corpus of the figure "How hybrid search ranks": fourteen short pages of made-up places on
 * `.example` hosts, and five questions. The script `scripts/search-figure.ts` puts the pages into
 * the real index of polite-crawler, and starts the real model in CI. The page shows the result.
 *
 * Each text starts with the heading of its page, as the page reader gives it. The embedder reads
 * the text only, and the index reads the title and the text.
 */

/** One page of the corpus. */
export interface CorpusDoc {
  /** This text is the short id of the page in the data of the figure. */
  readonly id: string;
  readonly title: string;
  /** This text is the name of the page in the figure: two or three words. */
  readonly label: string;
  readonly url: string;
  readonly text: string;
}

/** One question of the figure, with what it teaches. */
export interface CorpusQuestion {
  readonly id: string;
  readonly q: string;
  /** This text is the name of the question on its button. */
  readonly label: string;
  /** This id names the page that the reader looks for. */
  readonly target: string;
}

export const CORPUS: readonly CorpusDoc[] = [
  {
    id: "forno",
    title: "Forno Esempio",
    label: "Forno Esempio",
    url: "https://forno-esempio.example/",
    text: "Forno Esempio\nNeapolitan pies from a wood-fired oven, with a thin, blistered crust. On Fridays and Saturdays the kitchen takes the last order at 1 am.",
  },
  {
    id: "night-market",
    title: "The Thursday night market",
    label: "Night market",
    url: "https://citta-esempio.example/events/night-market",
    text: "The Thursday night market\nFrom June to September, Piazza Esempio fills with food stalls and a brass band each Thursday. The stalls close at 11 pm.",
  },
  {
    id: "pizza-stone",
    title: "Care of a pizza stone",
    label: "Pizza stone care",
    url: "https://cucina-campione.example/guides/pizza-stone",
    text: "Care of a pizza stone\nLet the stone cool in the oven. Scrape off burnt flour with a plastic card, and wash it with water only, because soap soaks into the stone.",
  },
  {
    id: "late-checkout",
    title: "Late checkout at Albergo Campione",
    label: "Late checkout",
    url: "https://albergo-campione.example/faq",
    text: "Late checkout at Albergo Campione\nGuests can ask the front desk for a late checkout until 2 pm. Breakfast is in the garden room from 7 to 10.",
  },
  {
    id: "fx-2207",
    title: "Water filter FX-2207",
    label: "Filter FX-2207",
    url: "https://bottega-campione.example/products/fx-2207",
    text: "Water filter FX-2207\nThe FX-2207 cartridge fits the Campione Uno espresso machine. Change it after 60 litres or two months.",
  },
  {
    id: "fx-2270",
    title: "Water filter FX-2270",
    label: "Filter FX-2270",
    url: "https://bottega-campione.example/products/fx-2270",
    text: "Water filter FX-2270\nThe FX-2270 cartridge fits the Campione table jug. Change it every four weeks.",
  },
  {
    id: "filter-guide",
    title: "When to change the filter of a coffee machine",
    label: "Filter guide",
    url: "https://cucina-campione.example/guides/coffee-filter",
    text: "When to change the filter of a coffee machine\nHard water blocks a filter cartridge in a few months. A blocked filter makes each shot slow and bitter, so change it on time.",
  },
  {
    id: "rye",
    title: "Panificio Campione",
    label: "Panificio rye loaf",
    url: "https://panificio-campione.example/",
    text: "Panificio Campione\nOur dark rye loaf has a thick, almost black crust and a moist crumb. We bake it on Tuesdays and Fridays.",
  },
  {
    id: "flour",
    title: "Bread flours, explained",
    label: "Bread flours",
    url: "https://cucina-campione.example/guides/flour",
    text: "Bread flours, explained\nRye flour has little gluten, so a rye dough is sticky. Mix it with wheat flour for a lighter bread.",
  },
  {
    id: "crust",
    title: "Crust and crumb",
    label: "Crust and crumb",
    url: "https://cucina-campione.example/guides/crust",
    text: "Crust and crumb\nA long, hot bake gives bread a dark crust. Steam in the first ten minutes keeps the crust thin and crisp.",
  },
  {
    id: "museum-visit",
    title: "Visit the Museo Esempio",
    label: "Museum visit",
    url: "https://museo-esempio.example/visit",
    text: "Visit the Museo Esempio\nA ramp leads to the side door, and a lift goes to each floor. The desk lends folding seats and large-print maps.",
  },
  {
    id: "archive",
    title: "Access to the city archive",
    label: "City archive",
    url: "https://citta-esempio.example/archive",
    text: "Access to the city archive\nAccess to the archive is by appointment. Bring a photo ID, and write to the archivist one week before your visit.",
  },
  {
    id: "museum-hours",
    title: "Museo Esempio: hours",
    label: "Museum hours",
    url: "https://museo-esempio.example/hours",
    text: "Museo Esempio: hours\nThe museum opens Tuesday to Sunday, 10 am to 6 pm. It is closed on Mondays, except on public holidays.",
  },
  {
    id: "monday-market",
    title: "The Monday farmers' market",
    label: "Monday market",
    url: "https://citta-esempio.example/events/monday-market",
    text: "The Monday farmers' market\nFarmers sell fruit, cheese and honey on Monday mornings, in the car park behind the museum.",
  },
];

export const QUESTIONS: readonly CorpusQuestion[] = [
  { id: "pizza", q: "late night pizza", label: "late night pizza", target: "forno" },
  { id: "filter", q: "FX-2207 cartridge", label: "FX-2207 cartridge", target: "fx-2207" },
  { id: "rye", q: "rye bread with a dark crust", label: "rye bread, dark crust", target: "rye" },
  {
    id: "museum",
    q: "Is the museum open on Monday?",
    label: "museum on Monday?",
    target: "museum-hours",
  },
  {
    id: "access",
    q: "wheelchair access to the museum",
    label: "wheelchair access",
    target: "museum-visit",
  },
];

/** This value is the time of the fetch of each page of the corpus. */
export const FETCHED_AT = "2026-10-18T09:00:00.000Z";

/** This function gives a page of the corpus by its id. */
export const corpusDoc = (id: string): CorpusDoc | undefined => CORPUS.find((doc) => doc.id === id);
