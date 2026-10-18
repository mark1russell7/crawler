/**
 * The recipe of the guide "Write a recipe": the menu of a made-up bakery, from its JSON API. The
 * guide shows this file, and its figure starts this recipe in the browser.
 */
import { defineRecipe, readJson } from "polite-crawler";

/** The answer of the menu API. */
interface Menu {
  readonly day: string;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly price: string;
    readonly notes?: string;
  }>;
}

export const menu = defineRecipe({
  // the name goes into each capture record: do not change it after the first capture
  name: "forno-menu",
  description: "The menu of Forno Esempio for one day",
  // an API with documented terms: robots.txt does not apply, and the pace does
  mode: "api",
  minInterval: "2s",
  maxAge: "12h",
  fetch: (day: string) => `https://api.forno-esempio.example/menu?day=${encodeURIComponent(day)}`,
  // pure: the same body always gives the same documents, and it sends no request
  extract: (body, capture) => {
    const menu = readJson(body, capture) as Menu;
    return menu.items.map((item) => ({
      doc: `menu:forno-esempio/${menu.day}/${item.id}`,
      kind: "menu-item",
      title: item.name,
      text: `${item.name}: ${item.price}${item.notes === undefined ? "" : `. ${item.notes}`}`,
      url: capture.url,
      meta: { day: menu.day, price: item.price },
    }));
  },
});
