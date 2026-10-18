import { createHash } from "node:crypto";
import type { EmbedCallOptions, Embedder } from "./embed.ts";

/**
 * The Ollama embedder sends texts to the local HTTP API of Ollama (`POST /api/embed`). The package
 * has no dependency for it: you install Ollama, start it (`ollama serve`) and pull a model
 * (`ollama pull nomic-embed-text`).
 *
 * The page text goes to the Ollama server. Thus the embedder accepts only a server on this
 * computer (a loopback address), unless `allowRemote` is true.
 */

/** These are the facts of the embedding models that the Ollama library has. */
export interface EmbeddingModel {
  readonly dimensions: number;
  readonly maxInputTokens: number;
  /** This prefix goes before the text of a question. */
  readonly queryPrefix?: string | undefined;
  /** This prefix goes before each chunk of a stored text. */
  readonly documentPrefix?: string | undefined;
}

/** These are the facts of three embedding models of Ollama. The name has no tag (`nomic-embed-text`, not `nomic-embed-text:latest`). */
export const OLLAMA_MODELS: Readonly<Record<string, EmbeddingModel>> = {
  "nomic-embed-text": {
    dimensions: 768,
    maxInputTokens: 8192,
    queryPrefix: "search_query: ",
    documentPrefix: "search_document: ",
  },
  "all-minilm": { dimensions: 384, maxInputTokens: 256 },
  "mxbai-embed-large": {
    dimensions: 1024,
    maxInputTokens: 512,
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
};

/** These options make an Ollama embedder. */
export interface OllamaEmbedderOptions {
  /** This value is the model of Ollama, with a tag when you want one. The default is `nomic-embed-text`. */
  readonly model?: string | undefined;
  /** This URL is the Ollama server. The default is `http://127.0.0.1:11434`. */
  readonly baseUrl?: string | undefined;
  /** This value is the number of texts in one request. The default is 32. */
  readonly batch?: number | undefined;
  /**
   * The value true lets `baseUrl` be a server on a different computer. The default is false,
   * because the embedder sends the text of the stored pages to the server.
   */
  readonly allowRemote?: boolean | undefined;
  /** This value is the length of each vector. The default comes from `OLLAMA_MODELS`, or from the first answer. */
  readonly dimensions?: number | undefined;
  /** This value is the input limit of the model in tokens. The default comes from `OLLAMA_MODELS`, or it is 256. */
  readonly maxInputTokens?: number | undefined;
  /** This prefix goes before the text of a question. The default comes from `OLLAMA_MODELS`. */
  readonly queryPrefix?: string | undefined;
  /** This prefix goes before each chunk of a stored text. The default comes from `OLLAMA_MODELS`. */
  readonly documentPrefix?: string | undefined;
  /** This value is the longest time of one request in milliseconds. The default is 2 minutes, because the first request loads the model. */
  readonly timeoutMs?: number | undefined;
}

/** The text of the error when no Ollama server answers. */
export const NO_OLLAMA =
  "Ollama does not answer: install it from https://ollama.com, then start it with ollama serve";

/** This function tells if a host name is a loopback address: `localhost`, `127.0.0.0/8` or `::1`. */
export const isLoopback = (host: string): boolean => {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(name) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(name)
  );
};

/** This function gives the name of a model with no tag, for `OLLAMA_MODELS`. */
const baseName = (model: string): string => {
  const slash = model.lastIndexOf("/");
  const colon = model.indexOf(":", slash + 1);
  return colon === -1 ? model : model.slice(0, colon);
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** This function gives the code of a network error, also when it is the cause of the error of `fetch`. */
const codeOf = (error: unknown): string | undefined => {
  for (
    let at: unknown = error, depth = 0;
    at !== undefined && at !== null && depth < 4;
    depth += 1
  ) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string") return code;
    at = (at as { cause?: unknown }).cause;
  }
  return undefined;
};

const NETWORK = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * This function makes an embedder that sends texts to Ollama (`POST {baseUrl}/api/embed`). It
 * sends `batch` texts in each request, and it stops when the signal aborts. The errors tell what
 * to do: `ollama serve` when no server answers, and `ollama pull <model>` when the model is not
 * there. A `baseUrl` on a different computer throws a `RangeError`, unless `allowRemote` is true.
 */
export const ollamaEmbedder = (options: OllamaEmbedderOptions = {}): Embedder => {
  const model = options.model ?? "nomic-embed-text";
  if (model.trim() === "") throw new RangeError("the Ollama model must have a name");
  const base = options.baseUrl ?? "http://127.0.0.1:11434";
  let url: URL;
  try {
    url = new URL(base);
  } catch (cause) {
    throw new RangeError(`the Ollama URL ${base} is not a URL`, { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new RangeError(`the Ollama URL ${base} must be an http or https URL`);
  if (url.username !== "" || url.password !== "")
    throw new RangeError("the Ollama URL must not hold a user name or a password");
  if (!isLoopback(url.hostname) && options.allowRemote !== true) {
    throw new RangeError(
      `the Ollama URL ${url.origin} is not on this computer, and the embedder sends the text of the stored pages to it: give allowRemote: true (--allow-remote-ollama) to permit it`,
    );
  }
  const endpoint = new URL("api/embed", url.href.endsWith("/") ? url.href : `${url.href}/`).href;
  const known = OLLAMA_MODELS[baseName(model)];
  const batch = Math.max(1, Math.floor(options.batch ?? 32));
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 120_000));
  const queryPrefix = options.queryPrefix ?? known?.queryPrefix ?? "";
  const documentPrefix = options.documentPrefix ?? known?.documentPrefix ?? "";
  // a document prefix of your own changes each stored vector, so it changes the id
  const custom =
    options.documentPrefix !== undefined && options.documentPrefix !== (known?.documentPrefix ?? "")
      ? `#${createHash("sha256").update(options.documentPrefix).digest("hex").slice(0, 8)}`
      : "";
  let dimensions = options.dimensions ?? known?.dimensions ?? 0;
  const maxInputTokens = options.maxInputTokens ?? known?.maxInputTokens ?? 256;

  const request = async (
    input: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<number[][]> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const both = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input, truncate: true }),
        signal: both,
      });
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      if (timeout.aborted)
        throw new Error(`Ollama at ${url.origin} did not answer in ${String(timeoutMs)} ms`, {
          cause: error,
        });
      const code = codeOf(error);
      if (code !== undefined && NETWORK.has(code))
        throw new Error(`${NO_OLLAMA} (no answer at ${url.origin}: ${code})`, { cause: error });
      // fetch says only "fetch failed": the cause tells why
      const cause = (error as { cause?: unknown }).cause;
      throw new Error(
        `the request to Ollama at ${url.origin} failed: ${messageOf(error)}${cause === undefined ? "" : ` (${messageOf(cause)})`}`,
        { cause: error },
      );
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      throw new Error(`the answer of Ollama at ${url.origin} stopped: ${messageOf(error)}`, {
        cause: error,
      });
    }
    let body: { embeddings?: unknown; error?: unknown } | undefined;
    try {
      body = JSON.parse(text) as { embeddings?: unknown; error?: unknown };
    } catch {
      body = undefined;
    }
    const said = typeof body?.error === "string" ? body.error : undefined;
    if (!response.ok) {
      if (said !== undefined && /not found|pull/i.test(said))
        throw new Error(
          `the model ${model} is not in Ollama: ollama pull ${model} (Ollama said: ${said})`,
        );
      if (response.status === 404)
        throw new Error(
          `the server at ${url.origin} has no /api/embed: update Ollama to version 0.3.0 or later`,
        );
      if (said !== undefined && /embed/i.test(said))
        throw new Error(
          `the model ${model} does not make embeddings: use an embedding model, such as nomic-embed-text (Ollama said: ${said})`,
        );
      throw new Error(
        `Ollama answered ${String(response.status)}${said === undefined ? "" : `: ${said}`}`,
      );
    }
    const embeddings = body?.embeddings;
    if (
      !Array.isArray(embeddings) ||
      embeddings.length !== input.length ||
      !embeddings.every((vector) => Array.isArray(vector))
    ) {
      throw new Error(
        `Ollama gave no embedding for each text (${String(input.length)} texts): its answer is not the answer of /api/embed`,
      );
    }
    return embeddings as number[][];
  };

  return {
    id: `ollama:${model}${custom}`,
    get dimensions() {
      return dimensions;
    },
    maxInputTokens,
    async embed(texts: readonly string[], call: EmbedCallOptions = {}): Promise<Float32Array[]> {
      const prefix = call.purpose === "query" ? queryPrefix : documentPrefix;
      const out: Float32Array[] = [];
      for (let at = 0; at < texts.length; at += batch) {
        call.signal?.throwIfAborted();
        const part = texts.slice(at, at + batch).map((text) => `${prefix}${text}`);
        for (const vector of await request(part, call.signal)) {
          if (dimensions === 0) dimensions = vector.length;
          if (vector.length !== dimensions) {
            throw new Error(
              `the model ${model} gave a vector of ${String(vector.length)} dimensions, not ${String(dimensions)}`,
            );
          }
          out.push(Float32Array.from(vector));
        }
      }
      return out;
    },
  };
};
