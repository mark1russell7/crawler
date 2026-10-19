import { createHash } from "node:crypto";
import type { EmbedCallOptions, Embedder } from "./embed.ts";
import type { EmbeddingModel } from "./ollama.ts";

/**
 * The transformers embedder uses an embedding model in this process, with transformers.js
 * (`@huggingface/transformers`). The package is an optional peer: the embedder loads it at its
 * first text, as the renderer loads `playwright-core` at its first page.
 *
 * The first use of a model downloads its files from the Hugging Face Hub (huggingface.co). That
 * download does not go through the polite crawler. transformers.js keeps the files in `cacheDir`
 * (its default is `node_modules/@huggingface/transformers/.cache/`), so the next use reads the disk.
 */

/** The text of the error when the optional package `@huggingface/transformers` is not installed. */
export const NO_TRANSFORMERS =
  "the transformers embedder needs the package @huggingface/transformers: npm install @huggingface/transformers. For the MCP server with npx, start it with npx -y -p polite-crawler-mcp -p @huggingface/transformers polite-crawler-mcp --embedder transformers";

/** The pooling of the vectors of the tokens: their mean, or the vector of the first token (`cls`). */
export type Pooling = "mean" | "cls";

/** These are the facts of the models that the embedder knows. Each one is on the Hugging Face Hub with ONNX files. */
export const TRANSFORMERS_MODELS: Readonly<
  Record<string, EmbeddingModel & { readonly pooling: Pooling }>
> = {
  "Xenova/bge-small-en-v1.5": {
    dimensions: 384,
    maxInputTokens: 512,
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
  "Xenova/bge-base-en-v1.5": {
    dimensions: 768,
    maxInputTokens: 512,
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
  "Xenova/all-MiniLM-L6-v2": { dimensions: 384, maxInputTokens: 256, pooling: "mean" },
  "nomic-ai/nomic-embed-text-v1.5": {
    dimensions: 768,
    maxInputTokens: 8192,
    pooling: "mean",
    queryPrefix: "search_query: ",
    documentPrefix: "search_document: ",
  },
};

/** These options make a transformers embedder. */
export interface TransformersEmbedderOptions {
  /** This value is the model on the Hugging Face Hub. The default is `Xenova/bge-small-en-v1.5` (384 dimensions, approximately 34 MB quantized). */
  readonly model?: string | undefined;
  /** The value true (the default) loads the 8-bit model (`dtype: "q8"`). The value false loads the 32-bit model, which is larger. */
  readonly quantized?: boolean | undefined;
  /** This folder keeps the files of the model. The default is the cache of transformers.js. */
  readonly cacheDir?: string | undefined;
  /** The value true uses only the files in the cache, with no download. The default is false. */
  readonly localOnly?: boolean | undefined;
  /** This value is the pooling of the model. The default comes from `TRANSFORMERS_MODELS`, or it is `mean`. */
  readonly pooling?: Pooling | undefined;
  /** This value is the length of each vector. The default comes from `TRANSFORMERS_MODELS`, or from the first answer. */
  readonly dimensions?: number | undefined;
  /** This value is the input limit of the model in tokens. The default comes from `TRANSFORMERS_MODELS`, or it is 256. */
  readonly maxInputTokens?: number | undefined;
  /** This prefix goes before the text of a question. The default comes from `TRANSFORMERS_MODELS`. */
  readonly queryPrefix?: string | undefined;
  /** This prefix goes before each chunk of a stored text. The default comes from `TRANSFORMERS_MODELS`. */
  readonly documentPrefix?: string | undefined;
  /** This value is the number of texts that the model reads at one time. The default is 8. */
  readonly batch?: number | undefined;
}

/** This is the part of a feature-extraction pipeline of transformers.js that the embedder uses. */
export interface FeatureExtractor {
  (
    texts: string[],
    options: { readonly pooling: Pooling; readonly normalize: boolean },
  ): Promise<{ readonly data: ArrayLike<number>; readonly dims: readonly number[] }>;
  dispose?(): Promise<unknown>;
}

/** This is the part of the module `@huggingface/transformers` that the embedder uses. */
export interface TransformersModule {
  pipeline(
    task: "feature-extraction",
    model: string,
    options: {
      readonly dtype: "q8" | "fp32";
      readonly cache_dir?: string | undefined;
      readonly local_files_only?: boolean | undefined;
    },
  ): Promise<FeatureExtractor>;
}

/** This function loads the optional peer. A test gives a module of its own. */
const loadTransformers = async (): Promise<TransformersModule> =>
  (await import("@huggingface/transformers")) as unknown as TransformersModule;

/**
 * This function makes an embedder that uses a model in this process with transformers.js. It loads
 * the package and the model at its first text, one time. It pools the vectors of the tokens as the
 * model expects (`cls` for BGE, `mean` for the others) and gives vectors with a length of 1. When
 * the package is not installed, `embed` rejects with `NO_TRANSFORMERS`. The signal stops the work
 * between two batches.
 */
export const transformersEmbedder = (
  options: TransformersEmbedderOptions = {},
  load: () => Promise<TransformersModule> = loadTransformers,
): Embedder => {
  const model = options.model ?? "Xenova/bge-small-en-v1.5";
  if (model.trim() === "") throw new RangeError("the transformers model must have a name");
  const known = TRANSFORMERS_MODELS[model];
  const quantized = options.quantized ?? true;
  const pooling = options.pooling ?? known?.pooling ?? "mean";
  if (pooling !== "mean" && pooling !== "cls")
    throw new RangeError(`pooling must be "mean" or "cls", not ${JSON.stringify(pooling)}`);
  const batch = Math.max(1, Math.floor(options.batch ?? 8));
  const queryPrefix = options.queryPrefix ?? known?.queryPrefix ?? "";
  const documentPrefix = options.documentPrefix ?? known?.documentPrefix ?? "";
  const custom =
    options.documentPrefix !== undefined && options.documentPrefix !== (known?.documentPrefix ?? "")
      ? `#${createHash("sha256").update(options.documentPrefix).digest("hex").slice(0, 8)}`
      : "";
  let dimensions = options.dimensions ?? known?.dimensions ?? 0;
  let extractor: Promise<FeatureExtractor> | undefined;

  const open = (): Promise<FeatureExtractor> => {
    extractor ??= (async () => {
      let module: TransformersModule;
      try {
        module = await load();
      } catch (cause) {
        throw new Error(NO_TRANSFORMERS, { cause });
      }
      return module.pipeline("feature-extraction", model, {
        dtype: quantized ? "q8" : "fp32",
        ...(options.cacheDir === undefined ? {} : { cache_dir: options.cacheDir }),
        ...(options.localOnly === true ? { local_files_only: true } : {}),
      });
    })();
    // a failed load is not kept: the next text tries again, for example after an install
    extractor.catch(() => {
      extractor = undefined;
    });
    return extractor;
  };

  return {
    id: `transformers:${model}:${quantized ? "q8" : "fp32"}:${pooling}${custom}`,
    get dimensions() {
      return dimensions;
    },
    maxInputTokens: options.maxInputTokens ?? known?.maxInputTokens ?? 256,
    async embed(texts: readonly string[], call: EmbedCallOptions = {}): Promise<Float32Array[]> {
      call.signal?.throwIfAborted();
      if (texts.length === 0) return [];
      const run = await open();
      const prefix = call.purpose === "query" ? queryPrefix : documentPrefix;
      const out: Float32Array[] = [];
      for (let at = 0; at < texts.length; at += batch) {
        call.signal?.throwIfAborted();
        const part = texts.slice(at, at + batch).map((text) => `${prefix}${text}`);
        const tensor = await run(part, { pooling, normalize: true });
        const width = tensor.dims.at(-1) ?? 0;
        if (tensor.dims.length !== 2 || tensor.dims[0] !== part.length || width === 0) {
          throw new Error(
            `the model ${model} gave a tensor of the shape [${tensor.dims.join(", ")}], not [${String(part.length)}, dimensions]`,
          );
        }
        if (dimensions === 0) dimensions = width;
        if (width !== dimensions) {
          throw new Error(
            `the model ${model} gave vectors of ${String(width)} dimensions, not ${String(dimensions)}`,
          );
        }
        const data = tensor.data;
        for (let row = 0; row < part.length; row += 1) {
          const vector = new Float32Array(width);
          for (let column = 0; column < width; column += 1)
            vector[column] = data[row * width + column]!;
          out.push(vector);
        }
      }
      return out;
    },
    async close() {
      const running = extractor;
      extractor = undefined;
      if (running === undefined) return;
      try {
        await (await running).dispose?.();
      } catch {
        // a model that did not load has nothing to release
      }
    },
  };
};
