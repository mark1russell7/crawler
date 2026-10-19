#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Embedder, OpenOptions } from "polite-crawler";
import { VERSION } from "./version.ts";

// This file imports only Node.js and the version at start, so `--version` and `--help` answer at
// once. The server loads the crawler and the MCP host.

// node:sqlite of Node.js 22 writes "SQLite is an experimental feature" to the standard error at
// each start. The command removes only that warning, before the store loads node:sqlite.
const emitWarning = process.emitWarning.bind(process) as (
  warning: string | Error,
  ...rest: unknown[]
) => void;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
  const first: unknown = rest[0];
  const kind =
    typeof first === "string"
      ? first
      : typeof first === "object" && first !== null && "type" in first
        ? first.type
        : warning instanceof Error
          ? warning.name
          : undefined;
  const text = typeof warning === "string" ? warning : warning.message;
  if (kind === "ExperimentalWarning" && text.startsWith("SQLite is an experimental feature"))
    return;
  emitWarning(warning, ...rest);
}) as typeof process.emitWarning;

const HELP = `polite-crawler-mcp ${VERSION}: the MCP server of polite-crawler, on standard input and output.

Usage:
  polite-crawler-mcp [options]

The server gives nine tools: crawl_fetch, crawl_find, crawl_read, crawl_verify, crawl_extract,
crawl_discover, crawl_site, crawl_diff and crawl_watch_list. Each fetch obeys robots.txt (the
rules for Claude-User too), with one request at a time to each site.

Options:
  --dir <folder>          the store (default ~/.polite-crawler, or POLITE_CRAWLER_DIR)
  --contact <mail|url>    an email address or URL for the From header (or POLITE_CRAWLER_CONTACT)
  --no-browser            render no page, also when a browser is installed
  --allow-private         fetch loopback, private and link-local addresses (or POLITE_CRAWLER_ALLOW_PRIVATE=1)
  --allow-user-provided   let user_provided work when the client cannot ask you (or POLITE_CRAWLER_ALLOW_USER_PROVIDED=1)
  --embedder <name>       the local model of hybrid search: transformers or ollama (or POLITE_CRAWLER_EMBEDDER)
  --embed-model <model>   the model of the embedder (or POLITE_CRAWLER_EMBED_MODEL)
  --ollama-url <url>      the URL of Ollama (or POLITE_CRAWLER_OLLAMA_URL)
  --allow-remote-ollama   permit an Ollama that is not on this computer (or POLITE_CRAWLER_ALLOW_REMOTE_OLLAMA=1)
  --sign-key <file>       sign each request with this Ed25519 key, Web Bot Auth (or POLITE_CRAWLER_SIGN_KEY)
  --signature-agent <url> where a site finds the public key (or POLITE_CRAWLER_SIGNATURE_AGENT)
  --help, --version

The command line of polite-crawler has the other commands: npx polite-crawler --help.
`;

/** This error is a mistake in the command line. The exit code is 2. */
class UsageError extends Error {}

type Env = Readonly<Record<string, string | undefined>>;

/** This function reads a flag of the environment: 1 or 0, true or false, yes or no, on or off. */
const envFlag = (env: Env, name: string): boolean => {
  const raw = env[name];
  const value = raw?.trim().toLowerCase() ?? "";
  if (["", "0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  throw new UsageError(`${name} is 1 or 0, not "${raw ?? ""}"`);
};

/** The store: a leading `~` is the home folder, and a relative path starts at the working folder. */
const storeDir = (text: string | undefined): string => {
  if (text === undefined) return join(homedir(), ".polite-crawler");
  if (text.trim() === "") throw new UsageError("--dir wants a folder");
  if (text === "~") return homedir();
  if (/^~[\\/]/.test(text)) return resolve(homedir(), text.slice(2));
  return resolve(text);
};

/** This function reads the key file of `--sign-key`. An error names the file, and not the key. */
const keyFile = (path: string): string => {
  const file =
    path === "~"
      ? homedir()
      : /^~[\\/]/.test(path)
        ? resolve(homedir(), path.slice(2))
        : resolve(path);
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new UsageError(
      `--sign-key: the file ${file} does not open (${typeof code === "string" ? code : "error"})`,
      { cause: error },
    );
  }
};

/** An origin names a key directory at the well-known path. A URL with a path names a JSON Web Key Set. */
const agentTypeOf = (url: string): "directory" | "jwks_uri" => {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" && parsed.search === "" ? "directory" : "jwks_uri";
  } catch {
    // the signer gives the error of a URL that does not parse
    return "directory";
  }
};

/** This function reads the options of the server from the command line and the environment. */
const optionsOf = async (
  args: readonly string[],
  env: Env,
): Promise<{ readonly options: OpenOptions; readonly allowUserProvided: boolean } | string> => {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        dir: { type: "string" },
        contact: { type: "string" },
        "no-browser": { type: "boolean" },
        "allow-private": { type: "boolean" },
        "allow-user-provided": { type: "boolean" },
        embedder: { type: "string" },
        "embed-model": { type: "string" },
        "ollama-url": { type: "string" },
        "allow-remote-ollama": { type: "boolean" },
        "sign-key": { type: "string" },
        "signature-agent": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError((error as Error).message, { cause: error });
  }
  if (values.help === true) return HELP;
  if (values.version === true) return VERSION;
  const fromEnv = (name: string): string | undefined => env[name] || undefined;
  const dir = storeDir(values.dir ?? fromEnv("POLITE_CRAWLER_DIR"));
  const allowPrivate =
    values["allow-private"] === true || envFlag(env, "POLITE_CRAWLER_ALLOW_PRIVATE");
  const allowUserProvided =
    values["allow-user-provided"] === true || envFlag(env, "POLITE_CRAWLER_ALLOW_USER_PROVIDED");
  const signKey = values["sign-key"] ?? fromEnv("POLITE_CRAWLER_SIGN_KEY");
  const signatureAgent = values["signature-agent"] ?? fromEnv("POLITE_CRAWLER_SIGNATURE_AGENT");
  if ((signKey === undefined) !== (signatureAgent === undefined)) {
    throw new UsageError(
      "--sign-key and --signature-agent go together: the key signs, and the agent tells a site where its public key is",
    );
  }
  const embedder = await embedderOf(values, env, dir);
  let signer;
  if (signKey !== undefined && signatureAgent !== undefined) {
    const { createWebBotAuthSigner } = await import("polite-crawler");
    try {
      signer = createWebBotAuthSigner({
        privateKey: keyFile(signKey),
        signatureAgent,
        agentType: agentTypeOf(signatureAgent),
      });
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError(`--sign-key: ${(error as Error).message}`, { cause: error });
    }
  }
  const contact = values.contact ?? fromEnv("POLITE_CRAWLER_CONTACT");
  return {
    options: {
      dir,
      ...(contact === undefined ? {} : { contact }),
      ...(values["no-browser"] === true ? { renderer: false as const } : {}),
      ...(allowPrivate ? { egress: { allowPrivate: true } } : {}),
      ...(signer === undefined ? {} : { signer }),
      ...(embedder === undefined ? {} : { embedder }),
    },
    allowUserProvided,
  };
};

/** This function makes the embedder of hybrid search, when the command line or the environment names one. */
const embedderOf = async (
  values: {
    readonly embedder?: string | undefined;
    readonly "embed-model"?: string | undefined;
    readonly "ollama-url"?: string | undefined;
    readonly "allow-remote-ollama"?: boolean | undefined;
  },
  env: Env,
  dir: string,
): Promise<Embedder | undefined> => {
  const name = values.embedder ?? (env["POLITE_CRAWLER_EMBEDDER"] || undefined);
  const model = values["embed-model"] ?? (env["POLITE_CRAWLER_EMBED_MODEL"] || undefined);
  const url = values["ollama-url"] ?? (env["POLITE_CRAWLER_OLLAMA_URL"] || undefined);
  const allowRemote =
    values["allow-remote-ollama"] === true || envFlag(env, "POLITE_CRAWLER_ALLOW_REMOTE_OLLAMA");
  if (name === undefined) {
    if (values["embed-model"] !== undefined || values["ollama-url"] !== undefined)
      throw new UsageError(
        "--embed-model and --ollama-url go with --embedder transformers or ollama",
      );
    return undefined;
  }
  if (name !== "transformers" && name !== "ollama")
    throw new UsageError(`--embedder is transformers or ollama, not "${name}"`);
  if (model !== undefined && model.trim() === "")
    throw new UsageError("--embed-model wants a model");
  if (values["ollama-url"] !== undefined && name !== "ollama")
    throw new UsageError("--ollama-url goes with --embedder ollama");
  const { ollamaEmbedder, transformersEmbedder } = await import("polite-crawler");
  try {
    if (name === "ollama") {
      return ollamaEmbedder({
        ...(model === undefined ? {} : { model }),
        ...(url === undefined ? {} : { baseUrl: url }),
        allowRemote,
      });
    }
    return transformersEmbedder({
      ...(model === undefined ? {} : { model }),
      cacheDir: join(dir, "models"),
    });
  } catch (error) {
    throw new UsageError(`--embedder ${name}: ${(error as Error).message}`, { cause: error });
  }
};

const main = async (args: readonly string[]): Promise<number> => {
  const parsed = await optionsOf(args, process.env);
  if (typeof parsed === "string") {
    process.stdout.write(`${parsed}\n`);
    return 0;
  }
  const { startMcpServer } = await import("./server.ts");
  await startMcpServer({ ...parsed.options, allowUserProvided: parsed.allowUserProvided });
  return 0;
};

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const usage = error instanceof UsageError;
    process.stderr.write(
      `polite-crawler-mcp: ${message}${usage ? " (polite-crawler-mcp --help lists the options)" : ""}\n`,
    );
    process.exitCode = usage ? 2 : 1;
  },
);
