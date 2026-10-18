import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { isLoopbackHost, urlHost } from "./loopback.ts";
import { CrawlTaskStore } from "./mcp-tasks.ts";

/*
 * This file serves MCP servers over the Streamable HTTP transport of the MCP SDK. It does not know
 * the tools: a function makes the MCP server of each session. Thus a different MCP host can replace
 * this file and keep the tools.
 *
 * - Each request needs the bearer token. The check compares the SHA-256 digests of the two tokens
 *   in constant time.
 * - The server binds to a loopback host by default. A different host needs `allowRemote`.
 * - A server on a loopback host accepts only a loopback name in the `Host` header, and an `Origin`
 *   header must name the same host. Thus a web page cannot reach the server by DNS rebinding.
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
  /** This store keeps the tasks of each session. The default is a new `CrawlTaskStore`. */
  readonly tasks?: CrawlTaskStore | undefined;
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
  readonly tasks: CrawlTaskStore;
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

/** This function reads the body of a request to a limit, and parses its JSON. */
const readJson = async (request: IncomingMessage, limit: number): Promise<unknown> => {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = chunk as Buffer;
    size += part.length;
    if (size > limit) throw new RangeError("the body is too large");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
};

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  last: number;
}

/**
 * This function serves MCP over HTTP. `makeServer` makes the MCP server of each new session, with
 * the task store of the server. The sessions share the task store. Each request needs
 * `Authorization: Bearer <token>`.
 */
export const serveMcpHttp = async (
  makeServer: (tasks: CrawlTaskStore) => McpServer,
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
  const tasks = options.tasks ?? new CrawlTaskStore();
  const sessions = new Map<string, Session>();
  let bound = port;
  let closing: Promise<void> | undefined;

  /** A loopback server accepts only a loopback name and its port in `Host`. */
  const hostAllowed = (header: string | undefined): boolean => {
    if (!loopback) return true;
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

  /** This function closes the session that was idle longest and has no task in progress. It gives false when each session has a task. */
  const evict = async (): Promise<boolean> => {
    const busy = tasks.busySessions();
    let oldest: [string, Session] | undefined;
    for (const entry of sessions) {
      if (busy.has(entry[0])) continue;
      if (oldest === undefined || entry[1].last < oldest[1].last) oldest = entry;
    }
    if (oldest === undefined) return false;
    sessions.delete(oldest[0]);
    await oldest[1].transport.close().catch(() => undefined);
    return true;
  };

  const start = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      refuse(response, 400, "a new session starts with a POST of initialize");
      return;
    }
    let body: unknown;
    try {
      body = await readJson(request, MCP_HTTP_DEFAULTS.maxBodyBytes);
    } catch (error) {
      refuse(
        response,
        error instanceof RangeError ? 413 : 400,
        "the body is not JSON of a request",
      );
      return;
    }
    if (!isInitializeRequest(body)) {
      refuse(response, 400, "no session: send initialize first, or give the Mcp-Session-Id header");
      return;
    }
    if (sessions.size >= MCP_HTTP_DEFAULTS.maxSessions && !(await evict())) {
      refuse(response, 503, "each session of the server has a task in progress: try again later");
      return;
    }
    let id: string | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        id = sessionId;
        sessions.set(sessionId, { transport, server, last: Date.now() });
      },
    });
    const server = makeServer(tasks);
    transport.onclose = () => {
      if (id === undefined) return;
      sessions.delete(id);
      void tasks.cancelSession(id);
    };
    // the transport of the SDK leaves its optional members undefined, which exactOptionalPropertyTypes refuses
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(request, response, body);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const hostHeader = request.headers.host;
    if (!hostAllowed(hostHeader) || !originAllowed(request.headers.origin, hostHeader)) {
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
    if (path !== MCP_HTTP_DEFAULTS.path) {
      refuse(response, 404, `no such path: the MCP endpoint is ${MCP_HTTP_DEFAULTS.path}`);
      return;
    }
    const header = request.headers["mcp-session-id"];
    if (typeof header !== "string") {
      await start(request, response);
      return;
    }
    const session = sessions.get(header);
    if (session === undefined) {
      refuse(response, 404, "the session is not known: start a new session with initialize");
      return;
    }
    session.last = Date.now();
    await session.transport.handleRequest(request, response);
  };

  const http = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      log(
        `polite-crawler: an MCP request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!response.headersSent) refuse(response, 500, "the server could not handle the request");
      else response.end();
    });
  });
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
    sessions: () => sessions.size,
    close() {
      closing ??= (async () => {
        await tasks.close();
        // a close removes its session from the map: the loop goes over a copy
        for (const session of Array.from(sessions.values())) {
          await session.transport.close().catch(() => undefined);
          await session.server.close().catch(() => undefined);
        }
        sessions.clear();
        await new Promise<void>((resolve) => {
          http.close(() => resolve());
          http.closeAllConnections();
        });
      })();
      return closing;
    },
  };
};
