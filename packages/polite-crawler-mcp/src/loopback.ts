import { isIP } from "node:net";

/**
 * This function tells if a host name or an address is a loopback host: `localhost`, an address in
 * `127.0.0.0/8`, or `::1`. The MCP server over HTTP binds to a loopback host unless the operator
 * permits a different host. The function imports only Node.js, so the command line uses it before
 * the store opens.
 */
export const isLoopbackHost = (host: string): boolean => {
  const name = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  const mapped = name.startsWith("::ffff:") ? name.slice(7) : name;
  if (isIP(mapped) === 4) return mapped.startsWith("127.");
  if (isIP(name) === 6) return /^(?:0{0,4}:){7}0{0,3}1$|^::1$/.test(name);
  return false;
};

/** This function gives a host for a URL: an IPv6 address goes in brackets. */
export const urlHost = (host: string): string => (isIP(host) === 6 ? `[${host}]` : host);
