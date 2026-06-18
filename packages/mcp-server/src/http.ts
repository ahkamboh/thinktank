import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import express from 'express';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { closeBrain, getBrain } from './store.js';
import { ingestConversation } from './conversation.js';
import type { IngestBody } from './conversation.js';

/** Default local port. Bound to 127.0.0.1 only - never exposed off-machine. */
export const DEFAULT_HTTP_PORT = 4319;
const HOST = '127.0.0.1';

export interface HttpServerOptions {
  port?: number;
}

/** A running HTTP server with a clean stop (for tests / programmatic use). */
export interface HttpHandle {
  port: number;
  url: string;
  server: Server;
  /** Stop listening; does not close the shared brain. */
  stop: () => Promise<void>;
}

/**
 * Start the HTTP server. It serves two things, both on localhost only:
 *   1. POST /mcp  - the MCP Streamable HTTP transport, for web MCP clients
 *      (Claude.ai / ChatGPT connectors). Stateless: one server per request.
 *   2. POST /ingest - a plain endpoint the browser extension hits with a
 *      captured conversation. This is the web-chat capture path.
 */
export async function startHttp(opts: HttpServerOptions = {}): Promise<HttpHandle> {
  const port = opts.port ?? DEFAULT_HTTP_PORT;
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    const { dbPath } = getBrain();
    res.json({ ok: true, server: 'thinktank', dbPath });
  });

  // --- MCP Streamable HTTP (stateless) ------------------------------------
  app.post('/mcp', async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[thinktank] /mcp error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Method-not-allowed for the stateless MCP endpoint's GET/DELETE.
  const notAllowed = (_req: Request, res: Response) =>
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless server).' },
      id: null,
    });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  // --- Browser-extension capture ------------------------------------------
  app.post('/ingest', async (req: Request, res: Response) => {
    try {
      const summary = await ingestConversation(req.body as IngestBody);
      res.json({ ok: true, ...summary });
    } catch (err) {
      console.error('[thinktank] /ingest error:', err);
      res.status(400).json({ ok: false, error: String(err) });
    }
  });

  const httpServer = await new Promise<Server>((resolve) => {
    const s = app.listen(port, HOST, () => {
      console.error(
        `[thinktank] HTTP server on http://${HOST}:${port}  ` +
          `(MCP: POST /mcp, capture: POST /ingest)`,
      );
      resolve(s);
    });
  });

  const shutdown = () => {
    httpServer.close();
    closeBrain();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return {
    port,
    url: `http://${HOST}:${port}`,
    server: httpServer,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        // Remove our signal handlers so a stopped server doesn't kill the
        // process later.
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.split('=')[1]) : undefined;
  startHttp({ port }).catch((err) => {
    console.error('[thinktank] failed to start http server:', err);
    process.exit(1);
  });
}
