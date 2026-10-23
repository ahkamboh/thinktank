import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import * as sqliteVec from 'sqlite-vec';
import { EMBED_DIM, embed, embeddingToBlob, configureModelCache } from './embed.js';
import { baseImportance, recencyBoost } from './score.js';
import { isEncrypted, type Cipher } from './crypto.js';
import { redactSecrets } from './redact.js';
import { projectKey, normalizeAliases, type ProjectAliases } from './project.js';
import type {
  Contradiction,
  Memory,
  MemoryEvent,
  MemoryKind,
  MemoryStatus,
  Provenance,
  SearchResult,
} from './types.js';

/** Default location for a user's private brain. */
export const DEFAULT_DB_DIR = join(homedir(), '.thinktank');
export const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, 'thinktank.db');

/** Reciprocal-rank-fusion constant. Larger = flatter fusion. */
const RRF_K = 60;

/**
 * How long a connection waits for another process's write lock before failing
 * with SQLITE_BUSY. Many `serve` processes (one per open AI session) share one
 * database file, so short waits are normal and must not surface as errors.
 */
export const BUSY_TIMEOUT_MS = 5000;

/** How long the distinct-project list is cached before re-reading it. */
const PROJECT_CACHE_MS = 5000;

interface MemoryRow {
  id: number;
  source: string;
  tool: string | null;
  model: string | null;
  ts: number;
  project: string | null;
  role: string | null;
  text: string;
  kind: string;
  status: string;
  seen_count: number;
  importance: number;
  last_seen: number;
  sources: string | null;
  superseded_by: number | null;
  created_at: number;
  updated_at: number;
}

interface ContradictionRow {
  id: number;
  project: string | null;
  topic: string | null;
  active_id: number;
  superseded_id: number;
  active_text: string;
  superseded_text: string;
  active_source: string | null;
  superseded_source: string | null;
  active_ts: number | null;
  superseded_ts: number | null;
  created_at: number;
}

export interface SearchOptions {
  /** Max results to return. */
  limit?: number;
  /** Restrict to a project scope. */
  project?: string;
  /** Include superseded memories (default false). */
  includeSuperseded?: boolean;
  /**
   * Drop results less semantically similar to the query than this (cosine),
   * unless they also matched a query keyword. Default: keep everything.
   */
  minCosine?: number;
}

/** A nearest-neighbour hit from the vector index, with cosine similarity. */
export interface NearestHit {
  id: number;
  distance: number;
  /** Cosine similarity in [-1, 1]; ~1 = near-identical meaning. */
  cosine: number;
  memory: Memory;
}

export interface NearestOptions {
  project?: string;
  limit?: number;
  /** Only return active memories (default true). */
  activeOnly?: boolean;
  /** Exclude this memory id (e.g. the row we just inserted). */
  excludeId?: number;
}

/** Store construction options. */
export interface MemoryStoreOptions {
  modelCacheDir?: string;
  cipher?: Cipher | null;
  /**
   * `{ alias: canonical }` project aliases (e.g. a worktree folder name -> its
   * repo). Aliases are resolved on write and on every scoped read.
   */
  projectAliases?: Record<string, string>;
}

/** Caps on the memory_resume candidate pool. */
export interface ResumeCandidateOptions {
  /** Most recently observed memories of any kind (default 30). */
  recent?: number;
  /** Active constraints + preferences, newest first (default 200). */
  rules?: number;
  /** Active decisions, newest first (default 30). */
  decisions?: number;
}

/** Filters for the dashboard list view. */
export interface ListOptions {
  /** Restrict to a project. */
  project?: string;
  /** Restrict to a source (the `source` column: chatgpt, claude, cursor...). */
  source?: string;
  /** Restrict to a kind. */
  kind?: string;
  /** active | superseded | all (default active). */
  status?: MemoryStatus | 'all';
  /** When present, rank by hybrid relevance instead of recency. */
  query?: string;
  /** Page size (default 25, max 200). */
  limit?: number;
  /** Page offset. */
  offset?: number;
}

/** A page of memories plus the total count matching the filters. */
export interface ListResult {
  rows: Memory[];
  total: number;
}

/** A facet value with its row count, for dashboard filter controls. */
export interface Facet {
  value: string;
  count: number;
}

function parseSources(json: string | null): Provenance[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as Provenance[]) : [];
  } catch {
    return [];
  }
}

function rowToMemory(r: MemoryRow): Memory {
  return {
    id: r.id,
    source: r.source,
    tool: r.tool,
    model: r.model,
    ts: r.ts,
    project: r.project,
    role: r.role,
    text: r.text,
    kind: r.kind as MemoryKind,
    status: r.status as MemoryStatus,
    seenCount: r.seen_count,
    importance: r.importance,
    lastSeen: r.last_seen,
    sources: parseSources(r.sources),
    supersededBy: r.superseded_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToContradiction(r: ContradictionRow): Contradiction {
  return {
    id: r.id,
    project: r.project,
    topic: r.topic,
    activeId: r.active_id,
    supersededId: r.superseded_id,
    activeText: r.active_text,
    supersededText: r.superseded_text,
    activeSource: r.active_source,
    supersededSource: r.superseded_source,
    activeTs: r.active_ts,
    supersededTs: r.superseded_ts,
    createdAt: r.created_at,
  };
}

/** Function words dropped from keyword queries (they match nearly everything). */
const FTS_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'do', 'does', 'did', 'to', 'of', 'in', 'on', 'at', 'by',
  'for', 'with', 'from', 'as', 'it', 'its', 'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'how', 'why', 'when', 'where', 'we', 'you',
  'they', 'he', 'she', 'our', 'my', 'your', 'their', 'should', 'would',
  'could', 'can', 'will', 'shall', 'may', 'might', 'must', 'have', 'has',
  'had', 'not', 'no', 'so', 'if', 'then', 'than', 'there', 'here', 'about',
  'into', 'over', 'use', 'used', 'uses', 'using', 'me', 'us', 'any', 'all',
]);

/**
 * Turn an arbitrary user query into a safe FTS5 MATCH expression: split on
 * non-word characters and OR the tokens together. Returns null if no usable
 * tokens (caller then skips keyword search).
 */
function toFtsQuery(query: string): string | null {
  const all = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
  // OR-ing "how" / "should" / "we" would match half the store; keep content
  // words unless the query is nothing but stopwords.
  const content = all.filter((t) => !FTS_STOPWORDS.has(t));
  const tokens = content.length > 0 ? content : all;
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

/**
 * sqlite-vec's vec0 returns plain (not squared) L2 distance. Our embeddings are
 * L2-normalized, so |a-b|^2 = 2 - 2cos and cosine = 1 - d^2/2. Clamp for
 * numerical safety.
 */
export function distanceToCosine(distance: number): number {
  const cos = 1 - (distance * distance) / 2;
  return Math.max(-1, Math.min(1, cos));
}

/** `?, ?, ?` placeholders for an IN (...) list. */
function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

/**
 * A memory-id filter pushed into candidate generation, as a SQL fragment over
 * the `memories` table plus its bound params. null = no filter.
 */
interface ScopeFilter {
  where: string;
  params: string[];
}

/**
 * thinktank's local-first store. Wraps Node's builtin SQLite (`node:sqlite`)
 * with the sqlite-vec extension for vector KNN and an FTS5 table for keyword
 * search. No native build step, no server, no API keys.
 */
export class MemoryStore {
  private db: DatabaseSync;
  /** Active at-rest cipher, or null when encryption is disabled. */
  private cipher: Cipher | null;
  /** True when memory text is encrypted on disk (gates plaintext FTS index). */
  private encrypted: boolean;
  /** projectKey(alias) -> canonical project name. */
  private aliases: ProjectAliases;
  /** Distinct stored project names with row counts (short-lived cache). */
  private projectCache: { at: number; rows: Array<{ project: string; c: number }> } | null =
    null;
  /** Nesting depth of transaction() (0 = none open). */
  private txDepth = 0;

  constructor(dbPath: string = DEFAULT_DB_PATH, opts: MemoryStoreOptions = {}) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    configureModelCache(opts.modelCacheDir ?? join(DEFAULT_DB_DIR, 'models'));

    this.cipher = opts.cipher ?? null;
    this.encrypted = this.cipher !== null;
    this.aliases = normalizeAliases(opts.projectAliases);

    this.db = new DatabaseSync(dbPath, { allowExtension: true });
    sqliteVec.load(this.db);
    this.configureConnection(dbPath);
    this.init();
  }

  /**
   * Make the file safe to share between many processes: wait (instead of
   * failing) on another writer's lock, and use WAL so readers never block the
   * writer. WAL is persistent in the file; switching needs a brief exclusive
   * lock, so a failure here is logged and the store keeps working in whatever
   * mode the file is in.
   */
  private configureConnection(dbPath: string): void {
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (dbPath === ':memory:') return;
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
    } catch (err) {
      console.error(`[thinktank] could not enable WAL (${String(err)}); continuing.`);
    }
  }

  /** Effective SQLite settings for this connection (diagnostics). */
  sqliteInfo(): { journalMode: string; busyTimeoutMs: number } {
    const jm = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const bt = this.db.prepare('PRAGMA busy_timeout').get() as Record<string, number>;
    return {
      journalMode: jm.journal_mode,
      busyTimeoutMs: Number(Object.values(bt)[0] ?? 0),
    };
  }

  /**
   * Run `fn` atomically. The outermost call takes the write lock up front
   * (BEGIN IMMEDIATE) so a read-then-write sequence can't interleave with
   * another process's write; nested calls become savepoints. `fn` must be
   * synchronous (node:sqlite is), so callers do async work (embedding) first.
   */
  transaction<T>(fn: () => T): T {
    const nested = this.txDepth > 0;
    const sp = `tt_sp_${this.txDepth}`;
    this.db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const out = fn();
      if (out instanceof Promise) {
        throw new Error('MemoryStore.transaction: callback must be synchronous');
      }
      this.db.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
      } catch {
        // The original error is the useful one.
      }
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  // ----- Project scoping ---------------------------------------------------

  /** Distinct stored project names with their row counts. */
  private storedProjects(): Array<{ project: string; c: number }> {
    const now = Date.now();
    if (this.projectCache && now - this.projectCache.at < PROJECT_CACHE_MS) {
      return this.projectCache.rows;
    }
    const rows = this.db
      .prepare(
        'SELECT project, COUNT(*) AS c FROM memories WHERE project IS NOT NULL GROUP BY project',
      )
      .all() as Array<{ project: string; c: number }>;
    this.projectCache = { at: now, rows };
    return rows;
  }

  /** Apply the alias map: the canonical name for `project`. */
  resolveProject(project: string): string {
    return this.aliases[projectKey(project)] ?? project.trim();
  }

  /**
   * Every stored spelling of a project scope (after aliases), e.g.
   * "fundedroll_landingpage" also matches "fundedroll-landingpage". Always
   * includes the resolved name itself so a brand-new project still scopes.
   */
  projectVariants(project: string): string[] {
    const resolved = this.resolveProject(project);
    const key = projectKey(resolved);
    const out = new Set<string>([resolved]);
    for (const r of this.storedProjects()) {
      if (projectKey(this.resolveProject(r.project)) === key) out.add(r.project);
    }
    return [...out];
  }

  /**
   * The name to store a new memory under: the alias target, reusing the most
   * common existing spelling of the same key so one project doesn't fragment
   * into "Foo", "foo" and "foo_".
   */
  private canonicalProject(project: string | undefined): string | null {
    if (project === undefined || project === null || !project.trim()) return null;
    const resolved = this.resolveProject(project);
    const key = projectKey(resolved);
    let best: { project: string; c: number } | null = null;
    for (const r of this.storedProjects()) {
      if (projectKey(r.project) !== key) continue;
      if (!best || r.c > best.c) best = r;
    }
    return best?.project ?? resolved;
  }

  /** SQL filter over `memories` for a project scope and/or active status. */
  private scopeFilter(
    project: string | undefined,
    activeOnly: boolean,
    alias = '',
  ): ScopeFilter | null {
    const col = (c: string) => (alias ? `${alias}.${c}` : c);
    const where: string[] = [];
    const params: string[] = [];
    if (activeOnly) where.push(`${col('status')} = 'active'`);
    if (project !== undefined && project.trim()) {
      const variants = this.projectVariants(project);
      where.push(`${col('project')} IN (${placeholders(variants.length)})`);
      params.push(...variants);
    }
    return where.length ? { where: where.join(' AND '), params } : null;
  }

  /**
   * Vector KNN restricted to the scope INSIDE the index scan (sqlite-vec
   * prefilters on `rowid IN (...)`), so a small project isn't crowded out of a
   * global top-k by a large one.
   */
  private knn(
    vec: Float32Array,
    k: number,
    scope: ScopeFilter | null,
  ): Array<{ id: number; distance: number }> {
    const filter = scope
      ? `AND rowid IN (SELECT id FROM memories WHERE ${scope.where})`
      : '';
    return this.db
      .prepare(
        `SELECT rowid AS id, distance
         FROM memories_vec
         WHERE embedding MATCH ? AND k = ${Math.max(1, Math.floor(k))} ${filter}
         ORDER BY distance`,
      )
      .all(embeddingToBlob(vec), ...(scope?.params ?? [])) as Array<{
      id: number;
      distance: number;
    }>;
  }

  /** Encrypt a value for storage (no-op when encryption is off). */
  private enc(text: string): string {
    return this.cipher ? this.cipher.encrypt(text) : text;
  }

  /**
   * Decrypt a stored value (no-op when off, or when the value is plaintext -
   * e.g. rows written before encryption was enabled). A wrong key surfaces as a
   * thrown decryption error here rather than silently returning garbage.
   */
  private dec(text: string): string {
    return this.cipher && isEncrypted(text) ? this.cipher.decrypt(text) : text;
  }

  /** Row -> Memory with the text column decrypted. */
  private toMemory(r: MemoryRow): Memory {
    const m = rowToMemory(r);
    m.text = this.dec(m.text);
    return m;
  }

  /** Row -> Contradiction with both text columns decrypted. */
  private toContradiction(r: ContradictionRow): Contradiction {
    const c = rowToContradiction(r);
    c.activeText = this.dec(c.activeText);
    c.supersededText = this.dec(c.supersededText);
    return c;
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        source        TEXT NOT NULL,
        tool          TEXT,
        model         TEXT,
        ts            INTEGER NOT NULL,
        project       TEXT,
        role          TEXT,
        text          TEXT NOT NULL,
        kind          TEXT NOT NULL DEFAULT 'fact',
        status        TEXT NOT NULL DEFAULT 'active',
        seen_count    INTEGER NOT NULL DEFAULT 1,
        importance    REAL NOT NULL DEFAULT 0,
        last_seen     INTEGER NOT NULL DEFAULT 0,
        sources       TEXT,
        superseded_by INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
      CREATE INDEX IF NOT EXISTS idx_memories_status  ON memories(status);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
        embedding float[${EMBED_DIM}]
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text);

      CREATE TABLE IF NOT EXISTS contradictions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        project           TEXT,
        topic             TEXT,
        active_id         INTEGER NOT NULL,
        superseded_id     INTEGER NOT NULL,
        active_text       TEXT NOT NULL,
        superseded_text   TEXT NOT NULL,
        active_source     TEXT,
        superseded_source TEXT,
        active_ts         INTEGER,
        superseded_ts     INTEGER,
        created_at        INTEGER NOT NULL
      );
    `);

    this.migrate();
  }

  /**
   * Add columns introduced after the original P1 schema to any pre-existing
   * database. node:sqlite has no IF NOT EXISTS for columns, so we inspect
   * PRAGMA table_info and ALTER what's missing.
   */
  private migrate(): void {
    const cols = new Set(
      (
        this.db.prepare('PRAGMA table_info(memories)').all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );
    const add: Array<[string, string]> = [
      ['last_seen', 'INTEGER NOT NULL DEFAULT 0'],
      ['sources', 'TEXT'],
      ['superseded_by', 'INTEGER'],
    ];
    const missing = add.filter(([name]) => !cols.has(name));
    // Backfill last_seen for rows created before this column existed. Checked
    // first so a normal startup doesn't take the write lock at all.
    const stale =
      missing.length === 0 &&
      this.db
        .prepare('SELECT 1 FROM memories WHERE last_seen = 0 OR last_seen IS NULL LIMIT 1')
        .get() !== undefined;
    if (missing.length === 0 && !stale) return;
    this.transaction(() => {
      for (const [name, def] of missing) {
        this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${def}`);
      }
      this.db.exec(
        'UPDATE memories SET last_seen = ts WHERE last_seen = 0 OR last_seen IS NULL',
      );
    });
  }

  /**
   * Low-level insert with a precomputed embedding. Used by both `save()` and
   * the merge engine (which needs the embedding before deciding to insert).
   */
  insertMemory(
    event: MemoryEvent,
    vec: Float32Array,
    sources?: Provenance[],
  ): Memory {
    const now = Date.now();
    const kind = event.kind ?? 'fact';
    const prov: Provenance[] =
      sources ??
      ([
        {
          source: event.source,
          tool: event.tool ?? null,
          model: event.model ?? null,
          ts: event.ts,
        },
      ] as Provenance[]);
    const importance = baseImportance(kind, prov.length);
    const project = this.canonicalProject(event.project);

    // memories + memories_vec + memories_fts must land together or not at all.
    const memory = this.transaction(() => {
      const insert = this.db.prepare(`
        INSERT INTO memories
          (source, tool, model, ts, project, role, text, kind, status, seen_count,
           importance, last_seen, sources, superseded_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, ?, ?)
      `);
      const res = insert.run(
        event.source,
        event.tool ?? null,
        event.model ?? null,
        event.ts,
        project,
        event.role ?? null,
        this.enc(event.text),
        kind,
        prov.length,
        importance,
        event.ts,
        JSON.stringify(prov),
        now,
        now,
      );

      // node:sqlite binds JS numbers as REAL for virtual-table rowids, which
      // sqlite-vec rejects. Bind the rowid as a BigInt -> SQLite INTEGER.
      const id = Number(res.lastInsertRowid);
      const rowid = BigInt(id);

      this.db
        .prepare('INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)')
        .run(rowid, embeddingToBlob(vec));

      // The FTS index stores PLAINTEXT, so when encryption is on we skip it
      // (keyword search degrades to vector-only) rather than leave plaintext on
      // disk. See crypto.ts for the documented tradeoff.
      if (!this.encrypted) {
        this.db
          .prepare('INSERT INTO memories_fts(rowid, text) VALUES (?, ?)')
          .run(rowid, event.text);
      }

      return this.getById(id)!;
    });
    if (project && !this.storedProjects().some((r) => r.project === project)) {
      this.projectCache = null;
    }
    return memory;
  }

  /**
   * Persist a memory: embed it then insert. This is the simple, no-merge path
   * (used by tests and direct callers). Production capture should go through
   * the merge engine's `ingest()` for dedupe/conflict handling.
   */
  async save(event: MemoryEvent): Promise<Memory> {
    // Redact on the direct path too, so secrets never get embedded or stored
    // even when callers bypass the merge engine.
    const r = redactSecrets(event.text);
    const safe = r.found.length ? { ...event, text: r.text } : event;
    const vec = await embed(safe.text);
    return this.insertMemory(safe, vec);
  }

  getById(id: number): Memory | null {
    const row = this.db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(id) as MemoryRow | undefined;
    return row ? this.toMemory(row) : null;
  }

  /**
   * Nearest memories to a precomputed embedding, annotated with cosine
   * similarity. The project scope and active-only filter are applied inside
   * the KNN scan, so the hits are the true nearest neighbours within scope.
   */
  findNearest(vec: Float32Array, opts: NearestOptions = {}): NearestHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const activeOnly = opts.activeOnly !== false;
    // +1 so excluding `excludeId` can't leave us one short.
    const hits = this.knn(
      vec,
      limit + (opts.excludeId ? 1 : 0),
      this.scopeFilter(opts.project, activeOnly),
    );
    if (hits.length === 0) return [];

    const byId = new Map(hits.map((h) => [h.id, h.distance]));
    const ids = [...byId.keys()];
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders(ids.length)})`)
      .all(...ids) as unknown as MemoryRow[];

    const out: NearestHit[] = [];
    for (const row of rows) {
      if (opts.excludeId && row.id === opts.excludeId) continue;
      const distance = byId.get(row.id)!;
      out.push({
        id: row.id,
        distance,
        cosine: distanceToCosine(distance),
        memory: this.toMemory(row),
      });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out.slice(0, limit);
  }

  /**
   * Record that an existing memory was observed again (a dedupe hit): bump
   * seen_count, refresh last_seen, append provenance, and recompute importance.
   * Read-modify-write, so it runs in one transaction: a concurrent observation
   * from another process can't drop this provenance entry.
   */
  recordObservation(id: number, prov: Provenance): Memory {
    return this.transaction(() => {
      const mem = this.getById(id);
      if (!mem) throw new Error(`recordObservation: memory ${id} not found`);

      const sources = [...mem.sources, prov];
      const seen = mem.seenCount + 1;
      const lastSeen = Math.max(mem.lastSeen, prov.ts);
      const importance = baseImportance(mem.kind, sources.length);

      this.db
        .prepare(
          `UPDATE memories
           SET seen_count = ?, last_seen = ?, sources = ?, importance = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(seen, lastSeen, JSON.stringify(sources), importance, Date.now(), id);

      return this.getById(id)!;
    });
  }

  /** Mark `oldId` superseded by `newId`. The new row stays active. */
  supersede(oldId: number, newId: number): void {
    this.db
      .prepare(
        `UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(newId, Date.now(), oldId);
  }

  /** Persist a detected contradiction for later "X vs Y" surfacing. */
  logContradiction(c: {
    project?: string | null;
    topic?: string | null;
    active: Memory;
    superseded: Memory;
  }): Contradiction {
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO contradictions
          (project, topic, active_id, superseded_id, active_text, superseded_text,
           active_source, superseded_source, active_ts, superseded_ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.active.project ?? c.project ?? null,
        c.topic ?? null,
        c.active.id,
        c.superseded.id,
        this.enc(c.active.text),
        this.enc(c.superseded.text),
        c.active.source,
        c.superseded.source,
        c.active.ts,
        c.superseded.ts,
        now,
      );
    return this.getContradiction(Number(res.lastInsertRowid))!;
  }

  getContradiction(id: number): Contradiction | null {
    const row = this.db
      .prepare('SELECT * FROM contradictions WHERE id = ?')
      .get(id) as ContradictionRow | undefined;
    return row ? this.toContradiction(row) : null;
  }

  /**
   * Recorded contradictions, newest first, optionally scoped. With `openOnly`,
   * only those still in force: the winning memory is still active and the
   * losing one is still superseded by it (not deleted, restored, or replaced
   * again since).
   */
  listContradictions(project?: string, opts: { openOnly?: boolean } = {}): Contradiction[] {
    const where: string[] = [];
    const params: string[] = [];
    if (project !== undefined && project.trim()) {
      const variants = this.projectVariants(project);
      where.push(`c.project IN (${placeholders(variants.length)})`);
      params.push(...variants);
    }
    if (opts.openOnly) {
      where.push(
        `EXISTS (SELECT 1 FROM memories a WHERE a.id = c.active_id AND a.status = 'active')`,
        `EXISTS (SELECT 1 FROM memories s WHERE s.id = c.superseded_id
                 AND s.status = 'superseded' AND s.superseded_by = c.active_id)`,
      );
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT c.* FROM contradictions c ${clause} ORDER BY c.created_at DESC, c.id DESC`)
      .all(...params) as unknown as ContradictionRow[];
    return rows.map((r) => this.toContradiction(r));
  }

  /**
   * Hybrid search: vector KNN (semantic) fused with FTS5 (keyword) via
   * Reciprocal Rank Fusion, nudged by stored importance and recency. Returns
   * the top `limit` memories ranked by combined relevance. The project scope
   * and status filter are part of BOTH candidate queries, so a scoped search
   * ranks the project's own memories instead of post-filtering a global pool.
   */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 8, 100));
    const pool = limit * 4;
    const now = Date.now();
    const scope = this.scopeFilter(opts.project, !opts.includeSuperseded);

    const qvec = await embed(query);
    const vecRows = this.knn(qvec, pool, scope);

    const ftsExpr = toFtsQuery(query);
    const mScope = this.scopeFilter(opts.project, !opts.includeSuperseded, 'm');
    const kwRows = ftsExpr
      ? (this.db
          .prepare(
            `SELECT memories_fts.rowid AS id, bm25(memories_fts) AS score
             FROM memories_fts
             ${mScope ? 'JOIN memories m ON m.id = memories_fts.rowid' : ''}
             WHERE memories_fts MATCH ? ${mScope ? `AND ${mScope.where}` : ''}
             ORDER BY score
             LIMIT ${pool}`,
          )
          .all(ftsExpr, ...(mScope?.params ?? [])) as Array<{ id: number; score: number }>)
      : [];

    const fused = new Map<number, { rrf: number; distance?: number }>();
    vecRows.forEach((r, i) => {
      const entry = fused.get(r.id) ?? { rrf: 0 };
      entry.rrf += 1 / (RRF_K + i);
      entry.distance = r.distance;
      fused.set(r.id, entry);
    });
    kwRows.forEach((r, i) => {
      const entry = fused.get(r.id) ?? { rrf: 0 };
      entry.rrf += 1 / (RRF_K + i);
      fused.set(r.id, entry);
    });

    if (fused.size === 0) return [];

    // Keyword-only hits have no vector distance yet; measure it so every
    // result carries a comparable cosine.
    const missing = [...fused.entries()].filter(([, f]) => f.distance === undefined);
    if (missing.length > 0) {
      const dists = this.db
        .prepare(
          `SELECT rowid AS id, vec_distance_l2(embedding, ?) AS distance
           FROM memories_vec WHERE rowid IN (${placeholders(missing.length)})`,
        )
        .all(embeddingToBlob(qvec), ...missing.map(([id]) => BigInt(id))) as Array<{
        id: number;
        distance: number;
      }>;
      for (const d of dists) fused.get(d.id)!.distance = d.distance;
    }
    const keywordIds = new Set(kwRows.map((r) => r.id));

    const ids = [...fused.keys()];
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders(ids.length)})`)
      .all(...ids) as unknown as MemoryRow[];

    const results: SearchResult[] = [];
    for (const row of rows) {
      const f = fused.get(row.id)!;
      const cosine = f.distance === undefined ? undefined : distanceToCosine(f.distance);
      if (
        opts.minCosine !== undefined &&
        !keywordIds.has(row.id) &&
        (cosine ?? -1) < opts.minCosine
      ) {
        continue;
      }
      const mem = this.toMemory(row);
      // importance + recency are soft tiebreakers, not dominant factors.
      const score =
        f.rrf + 0.01 * mem.importance + 0.01 * recencyBoost(mem.lastSeen, now);
      results.push({ ...mem, score, distance: f.distance, cosine });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** Most recently observed memories, optionally scoped to a project. */
  recent(limit = 10, project?: string): Memory[] {
    const scope = this.scopeFilter(project, true)!;
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE ${scope.where}
         ORDER BY last_seen DESC, id DESC LIMIT ?`,
      )
      .all(...scope.params, limit) as unknown as MemoryRow[];
    return rows.map((r) => this.toMemory(r));
  }

  /**
   * Candidate pool for a context-free "resume": the newest memories of any
   * kind PLUS every active constraint and preference (they're standing rules,
   * however old) and recent decisions. Deduped, in that order; ranking for
   * display happens in the caller.
   */
  resumeCandidates(project?: string, opts: ResumeCandidateOptions = {}): Memory[] {
    const scope = this.scopeFilter(project, true)!;
    const pick = (extra: string, limit: number): MemoryRow[] =>
      this.db
        .prepare(
          `SELECT * FROM memories WHERE ${scope.where} ${extra}
           ORDER BY last_seen DESC, id DESC LIMIT ?`,
        )
        .all(...scope.params, limit) as unknown as MemoryRow[];

    const seen = new Set<number>();
    const out: Memory[] = [];
    for (const rows of [
      pick('', opts.recent ?? 30),
      pick(`AND kind IN ('constraint', 'preference')`, opts.rules ?? 200),
      pick(`AND kind = 'decision'`, opts.decisions ?? 30),
    ]) {
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(this.toMemory(r));
      }
    }
    return out;
  }

  /** Quick counts for diagnostics. */
  stats(): {
    total: number;
    active: number;
    superseded: number;
    contradictions: number;
    byKind: Record<string, number>;
  } {
    const total = (
      this.db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }
    ).c;
    const active = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM memories WHERE status = 'active'")
        .get() as { c: number }
    ).c;
    const superseded = total - active;
    const contradictions = (
      this.db.prepare('SELECT COUNT(*) AS c FROM contradictions').get() as {
        c: number;
      }
    ).c;
    const kinds = this.db
      .prepare("SELECT kind, COUNT(*) AS c FROM memories WHERE status = 'active' GROUP BY kind")
      .all() as Array<{ kind: string; c: number }>;
    const byKind: Record<string, number> = {};
    for (const k of kinds) byKind[k.kind] = k.c;
    return { total, active, superseded, contradictions, byKind };
  }

  // ----- Dashboard / management read + write APIs -------------------------

  /** Distinct projects with their row counts, most populated first. */
  listProjects(): Array<{ project: string | null; count: number }> {
    const rows = this.db
      .prepare(
        'SELECT project, COUNT(*) AS c FROM memories GROUP BY project ORDER BY c DESC',
      )
      .all() as Array<{ project: string | null; c: number }>;
    return rows.map((r) => ({ project: r.project, count: r.c }));
  }

  /** Facet counts powering the dashboard filter dropdowns. */
  facets(): {
    sources: Facet[];
    tools: Facet[];
    kinds: Facet[];
    projects: Array<{ value: string | null; count: number }>;
  } {
    const group = (col: string) =>
      this.db
        .prepare(
          `SELECT ${col} AS v, COUNT(*) AS c FROM memories GROUP BY ${col} ORDER BY c DESC`,
        )
        .all() as Array<{ v: string | null; c: number }>;
    const nonNull = (rows: Array<{ v: string | null; c: number }>): Facet[] =>
      rows
        .filter((r) => r.v !== null)
        .map((r) => ({ value: r.v as string, count: r.c }));
    return {
      sources: nonNull(group('source')),
      tools: nonNull(group('tool')),
      kinds: nonNull(group('kind')),
      projects: group('project').map((r) => ({ value: r.v, count: r.c })),
    };
  }

  /**
   * Filtered, paginated list for the dashboard. With `query`, ranks by hybrid
   * relevance then applies facet filters; without it, a plain recency-ordered
   * scan. Returns the page plus the total matching count (for pagination).
   */
  async list(opts: ListOptions = {}): Promise<ListResult> {
    const limit = Math.max(1, Math.min(opts.limit ?? 25, 200));
    const offset = Math.max(0, opts.offset ?? 0);
    const status: MemoryStatus | 'all' = opts.status ?? 'active';

    const q = opts.query?.trim();
    if (q) {
      // Search mode: rank by relevance, then filter + paginate in JS.
      const hits = await this.search(q, {
        limit: 200,
        includeSuperseded: status !== 'active',
        project: opts.project,
      });
      const filtered = hits.filter((m) => {
        if (opts.source && m.source !== opts.source && m.tool !== opts.source)
          return false;
        if (opts.kind && m.kind !== opts.kind) return false;
        if (status !== 'all' && m.status !== status) return false;
        return true;
      });
      return {
        rows: filtered.slice(offset, offset + limit),
        total: filtered.length,
      };
    }

    // Plain scan with SQL filters.
    const where: string[] = [];
    const params: Array<string> = [];
    if (opts.project) {
      const variants = this.projectVariants(opts.project);
      where.push(`project IN (${placeholders(variants.length)})`);
      params.push(...variants);
    }
    if (opts.source) {
      // Match either the coarse source (chatgpt) or the concrete tool
      // (chatgpt-web), so both work as a "source" filter.
      where.push('(source = ? OR tool = ?)');
      params.push(opts.source, opts.source);
    }
    if (opts.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    if (status !== 'all') {
      where.push('status = ?');
      params.push(status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM memories ${clause}`)
        .get(...params) as { c: number }
    ).c;

    const rows = this.db
      .prepare(
        `SELECT * FROM memories ${clause} ORDER BY last_seen DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as MemoryRow[];

    return { rows: rows.map((r) => this.toMemory(r)), total };
  }

  /**
   * Delete a memory and its vector + FTS index entries, keeping all three
   * tables consistent. Returns true if the memory existed.
   */
  deleteMemory(id: number): boolean {
    if (!this.getById(id)) return false;
    // Virtual-table rowids must be bound as BigInt (node:sqlite binds plain
    // numbers as REAL, which vec0/fts5 reject for rowid matching).
    const rowid = BigInt(id);
    this.transaction(() => {
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(rowid);
      // FTS rows only exist when encryption is off (see insertMemory); the
      // delete is a harmless no-op otherwise.
      this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rowid);
    });
    return true;
  }

  /** Re-classify a memory's kind (e.g. fix an over-eager "fact"). */
  updateKind(id: number, kind: MemoryKind): Memory | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const importance = baseImportance(kind, existing.seenCount);
    this.db
      .prepare(
        'UPDATE memories SET kind = ?, importance = ?, updated_at = ? WHERE id = ?',
      )
      .run(kind, importance, Date.now(), id);
    return this.getById(id);
  }

  /** Paginated contradictions for the dashboard. */
  getContradictions(
    opts: { project?: string; limit?: number; offset?: number } = {},
  ): { rows: Contradiction[]; total: number } {
    const limit = Math.max(1, Math.min(opts.limit ?? 25, 200));
    const offset = Math.max(0, opts.offset ?? 0);
    const variants = opts.project ? this.projectVariants(opts.project) : [];
    const where = variants.length
      ? `WHERE project IN (${placeholders(variants.length)})`
      : '';
    const params: string[] = variants;

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM contradictions ${where}`)
        .get(...params) as { c: number }
    ).c;

    const rows = this.db
      .prepare(
        `SELECT * FROM contradictions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as ContradictionRow[];

    return { rows: rows.map((r) => this.toContradiction(r)), total };
  }

  close(): void {
    this.db.close();
  }
}
