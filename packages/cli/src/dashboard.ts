import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import express from 'express';
import type { Request, Response } from 'express';
import { getBrain, closeBrain } from '@thinktank/mcp-server';
import type { MemoryKind, MemoryStatus } from '@thinktank/core';
import { DASHBOARD_HTML } from './dashboard-html.js';

/** Default dashboard port. Distinct from the MCP/ingest server (4319). */
export const DEFAULT_DASHBOARD_PORT = 4320;
/** Bound to localhost only - the brain never gets exposed off-machine. */
const HOST = '127.0.0.1';

const VALID_KINDS: MemoryKind[] = [
  'decision',
  'fact',
  'preference',
  'constraint',
  'state',
  'code',
];

export interface DashboardOptions {
  port?: number;
  /** Open the dashboard in the default browser once it's up. */
  open?: boolean;
}

export interface DashboardHandle {
  port: number;
  url: string;
  server: Server;
  stop: () => Promise<void>;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  try {
    spawn(cmd, [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    }).unref();
  } catch {
    // Non-fatal: the URL is printed regardless.
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Start the local memory dashboard: a JSON API plus a single static SPA, both
 * on 127.0.0.1 only. Reuses the shared brain (MemoryStore) for reads/writes.
 */
export async function startDashboard(
  opts: DashboardOptions = {},
): Promise<DashboardHandle> {
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const { store, dbPath } = getBrain();

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(DASHBOARD_HTML);
  });

  app.get('/api/stats', (_req: Request, res: Response) => {
    res.json({ ...store.stats(), facets: store.facets(), dbPath });
  });

  app.get('/api/projects', (_req: Request, res: Response) => {
    res.json({ projects: store.listProjects() });
  });

  app.get('/api/memories', async (req: Request, res: Response) => {
    try {
      const q = req.query;
      const result = await store.list({
        project: str(q.project),
        source: str(q.source),
        kind: str(q.kind),
        status: (str(q.status) ?? 'active') as MemoryStatus | 'all',
        query: str(q.query),
        limit: num(q.limit, 25),
        offset: num(q.offset, 0),
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/contradictions', (req: Request, res: Response) => {
    const q = req.query;
    res.json(
      store.getContradictions({
        project: str(q.project),
        limit: num(q.limit, 25),
        offset: num(q.offset, 0),
      }),
    );
  });

  app.delete('/api/memories/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const ok = store.deleteMemory(id);
    res.json({ ok, deleted: ok ? id : null });
  });

  app.patch('/api/memories/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const kind = (req.body as { kind?: string }).kind;
    if (!Number.isInteger(id) || !kind || !VALID_KINDS.includes(kind as MemoryKind)) {
      res.status(400).json({ error: 'invalid id or kind' });
      return;
    }
    const memory = store.updateKind(id, kind as MemoryKind);
    res.json({ ok: memory !== null, memory });
  });

  const httpServer = await new Promise<Server>((resolve) => {
    const s = app.listen(port, HOST, () => {
      console.error(`[thinktank] dashboard on http://${HOST}:${port}`);
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

  const url = `http://${HOST}:${port}`;
  if (opts.open) openBrowser(url);

  return {
    port,
    url,
    server: httpServer,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.split('=')[1]) : undefined;
  startDashboard({ port, open: process.argv.includes('--open') }).catch((err) => {
    console.error('[thinktank] failed to start dashboard:', err);
    process.exit(1);
  });
}
