import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { DaemonMcpHost } from "./daemon.ts";
import type { OpenOptions } from "./open.ts";

/*
 * The MCP server of polite-crawler is the package polite-crawler-mcp since polite-crawler 0.2.0.
 * polite-crawler does not depend on it, so the library loads no MCP SDK and no zod. The command
 * `polite-crawler mcp` and the MCP server of the daemon load the package when it is there: next to
 * polite-crawler. They do not look in the working folder: an MCP client can start the command in any
 * project, and the code of that project must not start.
 */

/** The name of the package of the MCP server. */
export const MCP_PACKAGE = "polite-crawler-mcp";

/** This text tells where the MCP server is. */
export const MCP_POINTER =
  "The MCP server of polite-crawler is the package polite-crawler-mcp since 0.2.0. Start it with npx polite-crawler-mcp, or install polite-crawler-mcp next to polite-crawler.";

/** The parts of polite-crawler-mcp that polite-crawler uses. */
export interface McpPackage {
  startMcpServer(
    options: OpenOptions & {
      readonly allowUserProvided?: boolean | undefined;
      readonly log?: ((line: string) => void) | undefined;
    },
  ): Promise<void>;
  readonly mcpHttpHost: DaemonMcpHost;
}

/** This error tells that polite-crawler-mcp is not there. Its message is the pointer. */
export class McpPackageMissing extends Error {
  constructor() {
    super(MCP_POINTER);
    this.name = "McpPackageMissing";
  }
}

/**
 * This function gives the places where polite-crawler looks for polite-crawler-mcp, as file URLs:
 * only next to polite-crawler.
 */
export const mcpPackagePlaces = (): string[] => [import.meta.url];

/**
 * This function loads polite-crawler-mcp from the first place that has it. It throws
 * `McpPackageMissing` when no place has it. A test gives another `name`: Node.js also looks in the
 * folders of `NODE_PATH`, and pnpm sets it to the packages of the workspace.
 */
export const loadMcpPackage = async (
  places: readonly string[] = mcpPackagePlaces(),
  name: string = MCP_PACKAGE,
): Promise<McpPackage> => {
  for (const from of places) {
    let path: string;
    try {
      path = createRequire(from).resolve(name);
    } catch {
      continue;
    }
    return (await import(pathToFileURL(path).href)) as McpPackage;
  }
  throw new McpPackageMissing();
};
