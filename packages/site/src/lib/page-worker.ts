/**
 * The worker of the page reader. It reads each page that the tool sends, and it sends the result
 * back with the number of the request.
 */
import { readPage } from "./page-read.ts";

interface Job {
  readonly id: number;
  readonly html: string;
  readonly url: string;
}

// the global scope of a worker: the DOM types of the site describe a window
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Job>) => void) | null;
  postMessage: (message: unknown) => void;
};

scope.onmessage = (event) => {
  const { id, html, url } = event.data;
  scope.postMessage({ id, result: readPage(html, url) });
};
