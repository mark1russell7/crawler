/**
 * The worker of the recipe reader. It reads each page that the tool sends, with the readers of the
 * recipes. It sends the result back with the number of the request.
 */
import type { RecipeInput } from "./recipe-read.ts";
import { readRecipes } from "./recipe-read.ts";

interface Job {
  readonly id: number;
  readonly input: RecipeInput;
}

// the global scope of a worker: the DOM types of the site describe a window
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Job>) => void) | null;
  postMessage: (message: unknown) => void;
};

scope.onmessage = (event) => {
  const { id, input } = event.data;
  scope.postMessage({ id, result: readRecipes(input) });
};
