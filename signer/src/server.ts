import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { isHex } from "viem";

import type { SignerSession } from "./session.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
};

export interface SignerServer {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

export interface ServeOptions {
  port: number;
  /** Built UI directory; when absent, only the API is served. */
  uiDir?: string;
  /** Fixed token for tests; a random one is generated otherwise. */
  token?: string;
}

/**
 * Serves the signer UI and API on 127.0.0.1 only. Every API call needs the session token (given once, in the URL
 * fragment the CLI prints), the Host header must name the loopback address (blocks DNS rebinding), and requests from
 * other origins are refused.
 */
export async function serve(session: SignerSession, options: ServeOptions): Promise<SignerServer> {
  const token = options.token ?? randomBytes(24).toString("base64url");
  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: Error) => {
      if (res.headersSent) res.destroy(error);
      else send(res, 500, { error: error.message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!req.headers.host || !allowedHosts.has(req.headers.host)) return send(res, 403, { error: "forbidden host" });
    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) return send(res, 403, { error: "forbidden origin" });

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res);

    if (!authorized(req.headers.authorization, token)) return send(res, 401, { error: "missing or wrong session token" });

    if (req.method === "GET" && url.pathname === "/api/status") return send(res, 200, await session.status());
    if (req.method === "GET" && url.pathname === "/api/queue") return send(res, 200, await session.queue());
    if (req.method === "POST" && (url.pathname === "/api/confirm" || url.pathname === "/api/execute" || url.pathname === "/api/speed-up")) {
      const body = await readJson(req);
      const hash = (body as { safeTxHash?: unknown }).safeTxHash;
      if (typeof hash !== "string" || !isHex(hash) || hash.length !== 66) return send(res, 400, { error: "safeTxHash must be a 32-byte hex string" });
      try {
        const result =
          url.pathname === "/api/confirm" ? await session.confirm(hash) : url.pathname === "/api/speed-up" ? await session.speedUp(hash) : await session.execute(hash, { untilSent: false });
        return send(res, 200, result);
      } catch (error) {
        return send(res, 409, { error: (error as Error).message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/recover") {
      const body = (await readJson(req)) as { preview?: unknown };
      try {
        return send(res, 200, await session.recover(body.preview === true));
      } catch (error) {
        return send(res, 409, { error: (error as Error).message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/propose") {
      const body = (await readJson(req)) as { input?: unknown; preview?: unknown };
      try {
        return send(res, 200, await session.propose(body.input as never, body.preview === true));
      } catch (error) {
        return send(res, 409, { error: (error as Error).message });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/draft") return send(res, 200, session.draft());
    if (req.method === "POST" && url.pathname === "/api/draft") {
      const body = (await readJson(req)) as { action?: string; input?: unknown; id?: string; offset?: number; enabled?: boolean; preview?: boolean };
      try {
        switch (body.action) {
          case "mode":
            return send(res, 200, session.setQueueMode(body.enabled === true));
          case "add":
            return send(res, 200, await session.addToDraft(body.input as never));
          case "remove":
            return send(res, 200, session.removeFromDraft(String(body.id)));
          case "move":
            return send(res, 200, session.moveInDraft(String(body.id), Number(body.offset)));
          case "clear":
            return send(res, 200, session.clearDraft());
          case "simulate":
            return send(res, 200, await session.simulateDraft());
          case "propose":
            return send(res, 200, await session.proposeDraft(body.preview === true));
          default:
            return send(res, 400, { error: "unknown queue action" });
        }
      } catch (error) {
        return send(res, 409, { error: (error as Error).message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/renew-keys") {
      try {
        return send(res, 200, (await session.renewKeys()).input);
      } catch (error) {
        return send(res, 409, { error: (error as Error).message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/skip-used-keys") {
      try {
        return send(res, 200, await session.skipUsedKeysInput());
      } catch (error) {
        return send(res, 409, { error: (error as Error).message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/refill") {
      try {
        return send(res, 200, (await session.refill()) ?? null);
      } catch (error) {
        return send(res, 409, { error: (error as Error).message });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/token") {
      try {
        return send(res, 200, await session.tokenInfo(url.searchParams.get("address") ?? ""));
      } catch (error) {
        return send(res, 404, { error: (error as Error).message });
      }
    }
    const execution = url.pathname.match(/^\/api\/executions\/(0x[0-9a-fA-F]{64})$/);
    if (req.method === "GET" && execution) {
      try {
        return send(res, 200, await session.execution(execution[1] as `0x${string}`));
      } catch (error) {
        return send(res, 404, { error: (error as Error).message });
      }
    }
    return send(res, 404, { error: "not found" });
  }

  function serveStatic(pathname: string, res: ServerResponse) {
    if (!options.uiDir) return send(res, 404, { error: "UI not built; run `npm run build -w signer`" });
    const relative = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
    let file = join(options.uiDir, relative);
    if (!file.startsWith(options.uiDir) || !existsSync(file) || !statSync(file).isFile()) file = join(options.uiDir, "index.html");
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}/#token=${token}`,
    token,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function authorized(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Serializes before writing headers, so a serialization error can never leave a response half sent. */
function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json" });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("request body too large");
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
