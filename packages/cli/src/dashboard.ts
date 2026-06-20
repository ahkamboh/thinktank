import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { getBrain, closeBrain } from '@thinktank/mcp-server';
import type { MemoryKind, MemoryStatus } from '@thinktank/core';
import { parseExport, UnknownExportError } from '@thinktank/ingest';
import {
  ImportInputError,
  looksLikeZip,
  extractConversationsFromZip,
} from './export-source.js';
import { DASHBOARD_HTML } from './dashboard-html.js';

/** Default dashboard port. Distinct from the MCP/ingest server (4319). */
export const DEFAULT_DASHBOARD_PORT = 4320;
/** Bound to localhost only - the brain never gets exposed off-machine. */
const HOST = '127.0.0.1';

/**
 * Hard cap on an uploaded/pasted export. Real Claude exports run large (a full
 * `conversations.json` can be ~130MB+), so this is generous; it only stops a
 * runaway upload from exhausting memory or wedging the single-process server.
 *
 * Heap note: a ~134MB JSON parses into roughly ~1GB of heap transiently. Node's
 * default old-space limit (often ~4GB on a 64-bit dev machine) handles that
 * fine; on a constrained host, launch with NODE_OPTIONS=--max-old-space-size=4096.
 */
const MAX_IMPORT_BYTES = 512 * 1024 * 1024; // 512MB

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// --------------------------------------------------------------------------
// Import support: load an official ChatGPT/Claude data export (a .zip holding
// conversations.json, a raw conversations.json, or pasted JSON) into memory.
// --------------------------------------------------------------------------

/** Minimal shape of a multer in-memory file (avoids a hard type dependency). */
interface MulterFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

// One multipart file, buffered in memory, capped at the import limit.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_BYTES, files: 1 },
});

/** Run multer's single-file middleware but answer errors as JSON, not HTML. */
function runUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    const tooBig = isRecord(err) && err['code'] === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({
      ok: false,
      error: tooBig
        ? 'File exceeds the 512MB import limit.'
        : 'Upload failed: ' + (err instanceof Error ? err.message : String(err)),
    });
  });
}

// A JSON body parser scoped to /api/import, with a far larger cap than the
// 2MB used by the rest of the API.
const importJson = express.json({ limit: MAX_IMPORT_BYTES });

/** Parse a JSON/envelope body, unless multipart (multer already handled that). */
function runImportJson(req: Request, res: Response, next: NextFunction): void {
  const ct = String(req.headers['content-type'] ?? '');
  if (ct.includes('multipart/form-data')) {
    next();
    return;
  }
  importJson(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    const tooBig =
      isRecord(err) &&
      (err['status'] === 413 || err['type'] === 'entity.too.large');
    res.status(tooBig ? 413 : 400).json({
      ok: false,
      error: tooBig
        ? 'JSON body exceeds the 512MB import limit.'
        : 'Invalid JSON body: ' +
          (err instanceof Error ? err.message : String(err)),
    });
  });
}

/**
 * Start the local memory dashboard: a JSON API plus a single static SPA, both
 * on 127.0.0.1 only. Reuses the shared brain (MemoryStore) for reads/writes.
 */
export async function startDashboard(
  opts: DashboardOptions = {},
): Promise<DashboardHandle> {
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const { store, engine, dbPath } = getBrain();

  const app = express();
  // Small bodies for the management API; the import route opts out and parses
  // its own (much larger) body below.
  const smallJson = express.json({ limit: '2mb' });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/api/import') {
      next();
      return;
    }
    smallJson(req, res, next);
  });

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

  // --- Import a ChatGPT/Claude export (zip, conversations.json, or pasted JSON).
  //
  // Accepts, in priority order:
  //   1. multipart/form-data: `file` (a .zip / .json upload) + optional
  //      `project` and `json` text fields.
  //   2. application/json: an envelope { json|data: <export>, project? }, or the
  //      raw export itself (array, or an object with conversations/mapping/
  //      chat_messages). `project` may also come from `?project=`.
  // Every event is funneled through MergeEngine.ingest (which redacts secrets,
  // dedupes, and detects contradictions). 127.0.0.1-only, like the rest of the
  // dashboard. All failures answer with JSON so the server never crashes.
  app.post(
    '/api/import',
    runUpload,
    runImportJson,
    async (req: Request, res: Response) => {
      try {
        const bodyRec = isRecord(req.body) ? req.body : {};
        const q = req.query as Record<string, unknown>;
        const project = str(q['project']) ?? str(bodyRec['project']) ?? 'web';

        let json: unknown;
        let input: 'zip' | 'json-file' | 'json-body' | 'paste';

        const file = (req as unknown as { file?: MulterFile }).file;
        if (file && file.size > 0) {
          const name = (file.originalname ?? '').toLowerCase();
          const isZip =
            looksLikeZip(file.buffer) ||
            name.endsWith('.zip') ||
            file.mimetype === 'application/zip' ||
            file.mimetype === 'application/x-zip-compressed';
          if (isZip) {
            json = extractConversationsFromZip(file.buffer);
            input = 'zip';
          } else {
            json = JSON.parse(file.buffer.toString('utf8'));
            input = 'json-file';
          }
        } else if (
          typeof bodyRec['json'] !== 'undefined' ||
          typeof bodyRec['data'] !== 'undefined'
        ) {
          const raw = bodyRec['json'] ?? bodyRec['data'];
          json = typeof raw === 'string' ? JSON.parse(raw) : raw;
          input = 'paste';
        } else if (
          Array.isArray(req.body) ||
          Array.isArray(bodyRec['conversations']) ||
          isRecord(bodyRec['mapping']) ||
          Array.isArray(bodyRec['chat_messages'])
        ) {
          json = req.body;
          input = 'json-body';
        } else {
          res.status(400).json({
            ok: false,
            error:
              'No import payload found. Drop a .zip or conversations.json file, paste the JSON, or POST the export as a JSON body.',
          });
          return;
        }

        const parsed = parseExport(json, { project });

        const before = store.stats();
        let candidates = 0;
        let inserted = 0;
        let merged = 0;
        let superseded = 0;
        for (const event of parsed.events) {
          const results = await engine.ingest(event);
          candidates += results.length;
          for (const r of results) {
            if (r.action === 'inserted') inserted++;
            else if (r.action === 'deduped') merged++;
            else superseded++;
          }
        }
        const after = store.stats();

        res.json({
          ok: true,
          input,
          source: parsed.source,
          format: parsed.format,
          project,
          conversationsFound: parsed.conversationsFound,
          conversations: parsed.conversations.length,
          turns: parsed.events.length,
          candidates,
          inserted,
          merged,
          superseded,
          contradictions: after.contradictions - before.contradictions,
          stats: {
            total: after.total,
            active: after.active,
            superseded: after.superseded,
            contradictions: after.contradictions,
          },
        });
      } catch (err) {
        if (res.headersSent) return;
        if (err instanceof UnknownExportError) {
          res.status(422).json({ ok: false, error: err.message });
          return;
        }
        const clientErr =
          err instanceof SyntaxError || err instanceof ImportInputError;
        res.status(clientErr ? 400 : 500).json({
          ok: false,
          error:
            (err instanceof SyntaxError ? 'Could not parse JSON: ' : '') +
            (err instanceof Error ? err.message : String(err)),
        });
      }
    },
  );

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
