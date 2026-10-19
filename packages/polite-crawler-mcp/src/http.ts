import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpHost, McpServerTransport } from "@procedures/mcp-server";
import { McpTaskStore, createMcpHost } from "@procedures/mcp-server";
import type { DaemonMcpHost, DaemonTask, PoliteCrawler } from "polite-crawler";
import { isLoopbackHost, urlHost } from "./loopback.ts";
import type { CrawlToolOptions } from "./tools.ts";
import { crawlHostOptions } from "./server.ts";

/*
 * This file serves the tools over the Streamable HTTP transport of MCP. The listener is the
 * crawler's own: it checks the host, the origin and the token, and it serves the status of the
 * daemon. The MCP endpoint is the HTTP face of the shared MCP host, mounted at /mcp: the face keeps
 * the sessions and the tasks.
 *
 * - Each request needs the bearer token. The check compares the SHA-256 digests of the two tokens
 *   in constant time.
 * - The server binds to a loopback host by default. A different host needs `allowRemote`.
 * - A request that comes to a loopback address accepts only a loopback name in the `Host` header,
 *   also on a server with `allowRemote`. An `Origin` header must name the same host. Thus a web page
 *   cannot reach the server by DNS rebinding.
 */

/** These are the defaults of the MCP server over HTTP. */
export const MCP_HTTP_DEFAULTS = {
  /** The port of the server. */
  port: 9307,
  /** The host of the server: the IPv4 loopback address. */
  host: "127.0.0.1",
  /** The path of the MCP endpoint. */
  path: "/mcp",
  /** The path of the status of the daemon. */
  statusPath: "/status",
  /** The most sessions at one time. A new session above the limit closes the session that was idle longest. */
  maxSessions: 32,
  /** The largest body of a request that starts a session: 4 MiB. */
  maxBodyBytes: 4_194_304,
  /** The shortest token: 16 characters. */
  minTokenLength: 16,
} as const;

/** These options serve MCP over HTTP. */
export interface McpHttpOptions {
  /** This value is the port. The default is 9307. The value 0 takes a free port. */
  readonly port?: number | undefined;
  /** This value is the host to bind. The default is `127.0.0.1`. A host that is not loopback needs `allowRemote`. */
  readonly host?: string | undefined;
  /** The value true permits a host that is not loopback. Then other computers can try the token. */
  readonly allowRemote?: boolean | undefined;
  /** This value is the bearer token. The default reads `tokenFile`, or makes a random token. */
  readonly token?: string | undefined;
  /** This file holds the bearer token, when `token` is not given. */
  readonly tokenFile?: string | undefined;
  /** This function gives the JSON of `GET /status`. Without it, the path gives 404. */
  readonly status?: (() => unknown) | undefined;
  /** This store keeps the tasks of each session. The default is a new `McpTaskStore`. */
  readonly tasks?: McpTaskStore | undefined;
  /** This function writes the messages of the server. The default writes nothing. */
  readonly log?: ((line: string) => void) | undefined;
}

/** This is a server that serves MCP over HTTP. */
export interface McpHttpServer {
  /** This URL is the MCP endpoint, for example `http://127.0.0.1:9307/mcp`. */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** This value is the bearer token. Give it to the client, and keep it secret. */
  readonly token: string;
  /** This store keeps the tasks of the long tools. */
  readonly tasks: McpTaskStore;
  /** This method counts the open sessions. */
  sessions(): number;
  /** This method closes each session, cancels each task and stops the server. A second close does nothing. */
  close(): Promise<void>;
}

const digest = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

/**
 * This function compares a token with the token of the server in constant time. It compares the
 * SHA-256 digests, so the time does not depend on the length or the text of either token.
 */
export const sameToken = (given: string, token: string): boolean =>
  timingSafeEqual(digest(given), digest(token));

/** This function makes a random token: 32 bytes in base64url, 43 characters. */
export const makeToken = (): string => randomBytes(32).toString("base64url");

/** A token is printable ASCII with no space, so a header holds it. */
const TOKEN = /^[\x21-\x7e]+$/;

/** This function checks a token. A token that is short or that a header cannot hold throws an error. */
export const checkToken = (token: string, source: string): string => {
  const trimmed = token.trim();
  if (!TOKEN.test(trimmed) || trimmed.length < MCP_HTTP_DEFAULTS.minTokenLength) {
    throw new Error(
      `${source}: the token must be ${String(MCP_HTTP_DEFAULTS.minTokenLength)} or more printable characters with no space`,
    );
  }
  return trimmed;
};

/** This function reads a token file. It gives a warning when other users can read the file. */
const tokenOf = (options: McpHttpOptions, log: (line: string) => void): string => {
  if (options.token !== undefined) return checkToken(options.token, "token");
  if (options.tokenFile === undefined) return makeToken();
  let text: string;
  try {
    text = readFileSync(options.tokenFile, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new Error(
      `the token file ${options.tokenFile} does not open (${typeof code === "string" ? code : "error"})`,
      { cause: error },
    );
  }
  if (process.platform !== "win32" && (statSync(options.tokenFile).mode & 0o077) !== 0)
    log(`polite-crawler: other users can read the token file ${options.tokenFile}: chmod 600 it`);
  return checkToken(text, `the token file ${options.tokenFile}`);
};

const json = (response: ServerResponse, status: number, body: unknown, headers = {}): void => {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};

/** This function gives the answer of a refusal, as a JSON-RPC error with no id. */
const refuse = (response: ServerResponse, status: number, message: string, headers = {}): void =>
  json(response, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);

/**
 * The number of open sessions of the HTTP face. The state of the face gives it when the shared host
 * has the field. Else the count of its Streamable HTTP endpoint gives it.
 */
const sessionsOf = (face: McpServerTransport): number => {
  const state = face.getState() as { sessions?: unknown };
  if (typeof state.sessions === "number") return state.sessions;
  const endpoint = (face as unknown as { http?: { sessions?: unknown } }).http;
  return typeof endpoint?.sessions === "number" ? endpoint.sessions : 0;
};

/**
 * This function serves an MCP host over HTTP. `makeHost` makes the host with its HTTP face mounted
 * at `/mcp`, with the task store of the server. Each request needs `Authorization: Bearer <token>`.
 *
 * @beta
 */
export const serveMcpHttp = async (
  makeHost: (face: { readonly token: string; readonly tasks: McpTaskStore }) => McpHost,
  options: McpHttpOptions = {},
): Promise<McpHttpServer> => {
  const log = options.log ?? (() => undefined);
  const host = options.host ?? MCP_HTTP_DEFAULTS.host;
  const port = options.port ?? MCP_HTTP_DEFAULTS.port;
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new RangeError(`the port must be an integer from 0 to 65535, not ${String(port)}`);
  const loopback = isLoopbackHost(host);
  if (!loopback && options.allowRemote !== true) {
    throw new Error(
      `the host ${host} is not a loopback address: give allowRemote (--allow-remote) to serve other computers`,
    );
  }
  const token = tokenOf(options, log);
  const tasks = options.tasks ?? new McpTaskStore();
  const mcp = makeHost({ token, tasks });
  const face = mcp.transports[0];
  if (face === undefined) throw new Error("the MCP host has no HTTP face");
  await mcp.start();
  let bound = port;
  let closing: Promise<void> | undefined;

  /**
   * A request that comes to a loopback address names only a loopback host and its port in `Host`.
   * This applies to a server on a loopback host, and to a request on the loopback interface of a
   * server with `allowRemote`. Thus DNS rebinding cannot reach the server through 127.0.0.1.
   */
  const hostAllowed = (header: string | undefined, localAddress: string | undefined): boolean => {
    if (!loopback && !isLoopbackHost(localAddress ?? "")) return true;
    if (header === undefined) return false;
    let parsed: URL;
    try {
      parsed = new URL(`http://${header}`);
    } catch {
      return false;
    }
    return isLoopbackHost(parsed.hostname) && (parsed.port === "" || Number(parsed.port) === bound);
  };

  /** An `Origin` header must name the host of the request: a page of a different site gets 403. */
  const originAllowed = (origin: string | undefined, header: string | undefined): boolean => {
    if (origin === undefined) return true;
    try {
      return new URL(origin).host === header;
    } catch {
      return false;
    }
  };

  const authorized = (header: string | undefined): boolean => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
    return match !== null && sameToken(match[1]!, token);
  };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const hostHeader = request.headers.host;
    if (
      !hostAllowed(hostHeader, request.socket.localAddress) ||
      !originAllowed(request.headers.origin, hostHeader)
    ) {
      refuse(response, 403, "the Host or the Origin header is not of this server");
      return;
    }
    if (!authorized(request.headers.authorization)) {
      refuse(response, 401, "the request needs the bearer token of the server", {
        "www-authenticate": 'Bearer realm="polite-crawler"',
      });
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === MCP_HTTP_DEFAULTS.statusPath && options.status !== undefined) {
      if (request.method !== "GET") refuse(response, 405, "the status takes GET");
      else json(response, 200, options.status(), { "cache-control": "no-store" });
      return;
    }
    // the face answers its path: the sessions, the initialize rule, the body limit and the tasks
    if (!face.handleHttp(request, response)) {
      refuse(response, 404, `no such path: the MCP endpoint is ${MCP_HTTP_DEFAULTS.path}`);
    }
  };

  const http = createServer((request, response) => {
    try {
      handle(request, response);
    } catch (error) {
      log(
        `polite-crawler: an MCP request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!response.headersSent) refuse(response, 500, "the server could not handle the request");
      else response.end();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: NodeJS.ErrnoException): void => {
        reject(
          error.code === "EADDRINUSE"
            ? new Error(`the port ${String(port)} of ${host} is in use: give a different port`, {
                cause: error,
              })
            : error,
        );
      };
      http.once("error", failed);
      http.listen(port, host, () => {
        http.removeListener("error", failed);
        resolve();
      });
    });
  } catch (error) {
    await mcp.stop();
    await tasks.close();
    throw error;
  }
  bound = (http.address() as AddressInfo).port;
  const url = `http://${urlHost(host)}:${String(bound)}${MCP_HTTP_DEFAULTS.path}`;
  if (!loopback)
    log(
      `polite-crawler: the MCP server listens on ${host}, not on a loopback address: other computers can reach it`,
    );
  return {
    url,
    host,
    port: bound,
    token,
    tasks,
    sessions: () => sessionsOf(face),
    close() {
      closing ??= (async () => {
        await tasks.close();
        await mcp.stop();
        await new Promise<void>((resolve) => {
          http.close(() => resolve());
          http.closeAllConnections();
        });
      })();
      return closing;
    },
  };
};

/** These options serve the tools over HTTP: the options of the tools, and of the HTTP server. */
export interface StartMcpHttpOptions extends McpHttpOptions, CrawlToolOptions {}

/**
 * This function serves the tools of a crawler over the Streamable HTTP transport of MCP. The
 * sessions share one MCP host with the nine tools of the server on the standard input and output.
 * The envelope, the elicitation and the opt-ins are the same. `crawl_site` and `crawl_discover` are
 * MCP tasks. Each request needs the bearer token. The function does not close the crawler.
 */
export const startMcpHttpServer = (
  crawler: PoliteCrawler,
  options: StartMcpHttpOptions = {},
): Promise<McpHttpServer> => {
  const { onBehalfOf, allowUserProvided, renderOff, ...http } = options;
  return serveMcpHttp(
    ({ tasks }) =>
      createMcpHost({
        ...crawlHostOptions(crawler, { onBehalfOf, allowUserProvided, renderOff, tasks }),
        faces: {
          // The listener checks the host, the origin and the token of each request, as in 0.1.4.
          // Thus the face checks no token and no host name: the checks have one owner.
          http: {
            mount: true,
            path: MCP_HTTP_DEFAULTS.path,
            allowedHosts: "*",
            maxSessions: MCP_HTTP_DEFAULTS.maxSessions,
            maxBodyBytes: MCP_HTTP_DEFAULTS.maxBodyBytes,
          },
        },
      }),
    http,
  );
};

/**
 * This host serves the tools of the daemon over HTTP. It is the seam between the daemon and its MCP
 * transport: a different MCP host can replace it with `DaemonOptions.mcpHost`.
 */
export const mcpHttpHost: DaemonMcpHost = {
  async start(crawler, options, hooks) {
    const tasks = new McpTaskStore({ onChange: hooks.onTasks });
    const served = await startMcpHttpServer(crawler, {
      ...options,
      tasks,
      status: hooks.status,
      log: hooks.log,
    });
    const running = (): DaemonTask[] =>
      tasks.running().map((task) => ({
        id: task.id,
        tool: task.tool,
        status: task.status,
        message: task.message,
        created_at: task.createdAt,
        updated_at: task.updatedAt,
      }));
    return { url: served.url, tasks: running, close: () => served.close() };
  },
};
