import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { appRoot } from "./paths";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface Routes {
  /** POST /mcp */
  mcp?: Handler;
  /** Additional exact-match routes: [method, pathname, handler]. */
  extra?: Array<[method: string, path: string, Handler]>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const root = join(appRoot(), "dist", "web");
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = normalize(join(root, rel));
  if (file !== root && !file.startsWith(root + sep)) return send(res, 404, "Not found");
  try {
    const body = await readFile(file);
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    // The page drives deletes and restarts: no other site may frame it
    // (clickjacking). Cube's gate replaces this with its own policy for its tiles.
    const framing = extname(file) === ".html" ? { "content-security-policy": "frame-ancestors 'none'" } : {};
    res.writeHead(200, { "content-type": type, ...framing });
    res.end(body);
  } catch {
    send(res, 404, "Not found");
  }
}

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const HOST_REFUSAL = "This address is not allowed.";
export const ORIGIN_REFUSAL = "This origin is not allowed.";

/**
 * The browser reaches the app through Cube's gate, which sets `Host` to the
 * public address the browser used: a loopback name on the desktop, a
 * `.cube.site` name on the web. Any other Host is a DNS-rebinding page
 * pointing its own name at this port. `PERSONAS_ALLOWED_HOSTS`
 * (comma-separated `host[:port]`; a bare host matches any port) adds more.
 */
export function hostAllowed(host: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!host) return false;
  let hostname: string;
  try {
    const url = new URL(`http://${host}`);
    // A Host that parses to something else (a path, credentials) is not a host.
    if (url.host !== host.toLowerCase().replace(/:80$/, "")) return false;
    hostname = url.hostname;
  } catch {
    return false;
  }
  if (LOOPBACK_NAMES.has(hostname)) return true;
  if (hostname.endsWith(".cube.site") && hostname.length > ".cube.site".length) return true;
  const lower = host.toLowerCase();
  for (const raw of (env.PERSONAS_ALLOWED_HOSTS ?? "").split(",")) {
    const entry = raw.trim().toLowerCase();
    if (entry === "") continue;
    if (entry === lower || entry === hostname) return true;
  }
  return false;
}

/** An absent Origin passes (not a browser); a present one must name exactly the Host it was sent to. */
export function originMatches(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!host) return false;
  try {
    const url = new URL(origin);
    if (url.origin === "null") return false;
    return url.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Every route but POST /mcp (which has its own loopback, no-Origin and
 * ticket rules): an allowed Host, and for a request that can change
 * something (anything but GET and HEAD), an Origin matching it.
 */
function refusal(req: IncomingMessage, method: string): string | null {
  if (!hostAllowed(req.headers.host)) return HOST_REFUSAL;
  if (method !== "GET" && method !== "HEAD" && !originMatches(req.headers.origin, req.headers.host)) return ORIGIN_REFUSAL;
  return null;
}

export function createHttpServer(routes: Routes = {}): http.Server {
  const table: Array<[string, string, Handler]> = [
    ["GET", "/health", (_req, res) => send(res, 200, JSON.stringify({ ok: true }), "application/json")],
  ];
  if (routes.mcp) table.push(["POST", "/mcp", routes.mcp]);
  for (const r of routes.extra ?? []) table.push(r);

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!(method === "POST" && pathname === "/mcp")) {
      const refused = refusal(req, method);
      if (refused !== null) return send(res, 403, refused);
    }
    const route = table.find(([m, p]) => m === method && p === pathname);
    const run = route ? Promise.resolve(route[2](req, res)) : method === "GET" ? serveStatic(pathname, res) : Promise.resolve(send(res, 404, "Not found"));
    run.catch(() => {
      if (!res.headersSent) send(res, 500, "Something went wrong.");
      else res.end();
    });
  });

  // Upgrades belong to the socket (socket.ts), which listens for them on
  // this server; with no listener Node closes an upgrade request.

  return server;
}
