/*
 * The commands `venue` and `product` of the command line. They read a venue or a product page with
 * the recipes of the package (`readVenue` and `readProduct`). `cli.ts` loads this file only for these
 * two commands, so the other commands do not load the recipes.
 */
import type { KeptWeek, RecipeLine, VenueCompare } from "./cli-line.ts";
import {
  UsageError,
  describeProduct,
  describeVenue,
  keptWeekOf,
  productCode,
  venueCode,
} from "./cli-line.ts";
import { compareHours, fromCompact } from "./hours.ts";
import type { RecipeTarget } from "./recipe.ts";
import type { ProductOptions } from "./recipe-product.ts";
import { readProduct } from "./recipe-product.ts";
import type { VenueOptions } from "./recipe-venue.ts";
import { readVenue } from "./recipe-venue.ts";

/** These are the parts of the command line that `venue` and `product` use. */
export interface RecipeIo {
  /** The value true prints the result as JSON. */
  readonly json: boolean;
  /** This function prints a line on the standard output. */
  readonly out: (text: string) => void;
  /** This text tells why rendering is off, when the computer has no browser. */
  readonly renderOff?: string | undefined;
}

/** These are the inputs of `venue` that the command reads before the store opens. */
export interface RecipeInput {
  /** This value is the kept week of `--compare`, or undefined with no `--compare`. */
  readonly kept: KeptWeek | undefined;
}

/**
 * This function checks the parts of `venue` that need a file or a reader, before the store opens.
 * They are the kept week of `--compare` and the value of `--osm`. An error is a usage error.
 */
export const prepareRecipe = (line: RecipeLine): RecipeInput => {
  if (line.osm !== undefined && fromCompact(line.osm, "osm") === undefined) {
    throw new UsageError(
      `--osm: the hours reader cannot read "${line.osm}". Write an opening_hours value, such as "Mo-Fr 08:00-18:00; Sa 09:00-13:00"`,
    );
  }
  return { kept: line.compare === undefined ? undefined : keptWeekOf(line.compare) };
};

/** This function gives the options of the recipe that `venue` and `product` share. */
const sharedOptions = (line: RecipeLine): ProductOptions => ({
  render: line.render,
  maxAge: line.maxAge,
  budget: line.budget,
  onBehalfOf: line.onBehalfOf,
  userProvided: line.userProvided,
  fallback: line.fallback,
  archiveDespiteRobots: line.archiveDespiteRobots,
});

/**
 * This function does the command `venue`, and gives the exit code. It reads the hours of the venue
 * with `readVenue`. With `--compare`, it compares the week of the site (`from_site`) with the kept
 * week through `compareHours`.
 */
export const venueCommand = async (
  target: RecipeTarget,
  line: RecipeLine,
  input: RecipeInput,
  io: RecipeIo,
): Promise<number> => {
  const options: VenueOptions = {
    ...sharedOptions(line),
    name: line.name,
    requireName: line.requireName,
    location: line.location,
    osm: line.osm,
    pages: line.pages,
  };
  const result = await readVenue(target, line.url, options);
  const site = result.from_site;
  const compare: VenueCompare | undefined =
    input.kept === undefined
      ? undefined
      : {
          file: input.kept.file,
          kept: input.kept.week,
          comparison: site === null ? null : compareHours(input.kept.week, site.week),
        };
  io.out(
    io.json
      ? JSON.stringify(compare === undefined ? result : { ...result, compare }, null, 2)
      : describeVenue(result, compare, io.renderOff).join("\n"),
  );
  return venueCode(result);
};

/** This function does the command `product`, and gives the exit code. It reads the page with `readProduct`. */
export const productCommand = async (
  target: RecipeTarget,
  line: RecipeLine,
  io: RecipeIo,
): Promise<number> => {
  const result = await readProduct(target, line.url, sharedOptions(line));
  io.out(
    io.json ? JSON.stringify(result, null, 2) : describeProduct(result, io.renderOff).join("\n"),
  );
  return productCode(result);
};
