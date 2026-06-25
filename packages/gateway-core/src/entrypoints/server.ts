/**
 * Self-host HTTP entrypoint — a tiny node:http wrapper around the gateway
 * router, for self-hosted (container/Postgres) deployments.
 *
 * This is intentionally a thin example, not the full hosted server: it shows a
 * host adapting node:http `req`/`res` to `routeGatewayRequest`, including the
 * SSE plumbing for the streaming routes. A real deployment composes the
 * Postgres adapters + Anthropic provider + entitlement check and passes the
 * resolved `userId` (from gateway auth) into each request.
 *
 * SSE framing: each StreamEvent is written as one `data: <json>\n\n` frame.
 * Clients (web/desktop) parse these and render text / dispatch tool calls.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import {
  routeGatewayRequest,
  type GatewayRouterDeps,
  type GatewayRequest,
  type SseEmitter,
} from "../core/router.js";
import type { StreamEvent } from "../core/ports.js";

/**
 * Resolves the authenticated caller's user id from the request. The host owns
 * auth (WorkOS bearer for desktop/CLI, cookie→bearer for web). This default
 * reads `x-gateway-user-id` for local/self-host wiring; replace with real token
 * verification in production. Returning undefined → 401.
 */
export type AuthenticateRequest = (
  req: IncomingMessage,
) => Promise<string | undefined> | string | undefined;

const DEFAULT_AUTH: AuthenticateRequest = (req) => {
  const header = req.headers["x-gateway-user-id"];
  if (typeof header === "string" && header.trim() !== "") return header;
  return undefined;
};

export interface GatewayServerOptions {
  router: GatewayRouterDeps;
  authenticate?: AuthenticateRequest;
  port?: number;
}

/**
 * Builds (does not start) a node:http server bound to the gateway router.
 * Callers `.listen(port)` themselves, or use `startServer`.
 */
export function createGatewayHttpServer(options: GatewayServerOptions): Server {
  const authenticate = options.authenticate ?? DEFAULT_AUTH;

  return createServer((req, res) => {
    void handle(req, res, options.router, authenticate).catch((err) => {
      // Last-resort error guard so a thrown handler never hangs the socket.
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(
        JSON.stringify({
          error: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  });
}

/** Builds and starts the server, resolving once it is listening. */
export async function startServer(options: GatewayServerOptions): Promise<Server> {
  const server = createGatewayHttpServer(options);
  const port = options.port ?? 8081;
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}

// ---------------------------------------------------------------------------
// node:http ⇄ router adaptation
// ---------------------------------------------------------------------------

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  router: GatewayRouterDeps,
  authenticate: AuthenticateRequest,
): Promise<void> {
  const userId = await authenticate(req);
  if (!userId) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const path = (req.url ?? "/").split("?")[0]!;
  const body = await readJsonBody(req);

  // For streaming routes, begin the SSE response BEFORE driving the router so
  // events flush to the client as they arrive. The router signals a pre-stream
  // failure by returning a JSON response while the emitter is still untouched —
  // but since we have to commit headers up front for SSE, we instead build the
  // emitter lazily: it sets SSE headers on first emit.
  let sseStarted = false;
  const emitter: SseEmitter = {
    emit(event: StreamEvent) {
      if (!sseStarted) {
        sseStarted = true;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    close() {
      if (sseStarted) res.end();
    },
  };

  const deps: GatewayRouterDeps = { ...router, createEmitter: () => emitter };

  const gatewayReq: GatewayRequest = {
    method: req.method ?? "GET",
    path,
    body,
    userId,
  };

  const response = await routeGatewayRequest(deps, gatewayReq);

  if (response.kind === "json") {
    if (sseStarted) {
      // A JSON error surfaced after the stream already started — terminate it.
      emitter.close();
      return;
    }
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(response.body === null ? "" : JSON.stringify(response.body));
    return;
  }

  // Stream response: the router already drove + closed the emitter. If nothing
  // was ever emitted (e.g. an empty stream), close out a 200 with no body.
  if (!sseStarted) {
    res.writeHead(response.status, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.end();
  } else if (!res.writableEnded) {
    res.end();
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
