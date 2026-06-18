import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import * as sqliteVec from 'sqlite-vec';
import { EMBED_DIM, embed, embeddingToBlob, configureModelCache } from './embed.js';
import { baseImportance, recencyBoost } from './score.js';
import { isEncrypted, type Cipher } from './crypto.js';
import { redactSecrets } from './redact.js';
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

/**
 * Turn an arbitrary user query into a safe FTS5 MATCH expression: split on
 * non-word characters and OR the tokens together. Returns null if no usable
 * tokens (caller then skips keyword search).
 */
function toFtsQuery(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

/**
 * sqlite-vec returns squared-L2 distance. Our embeddings are L2-normalized, so
 * cosine similarity = 1 - distance/2. Clamp for numerical safety.
 */
function distanceToCosine(distance: number): number {
  const cos = 1 - distance / 2;
  return Math.max(-1, Math.min(1, cos));
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

  constructor(
    dbPath: string = DEFAULT_DB_PATH,
    opts: { modelCacheDir?: string; cipher?: Cipher | null } = {},
  ) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    configureModelCache(opts.modelCacheDir ?? join(DEFAULT_DB_DIR, 'models'));

    this.cipher = opts.cipher ?? null;
    this.encrypted = this.cipher !== null;

    this.db = new DatabaseSync(dbPath, { allowExtension: true });
    sqliteVec.load(this.db);
    this.init();
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
    for (const [name, def] of add) {
      if (!cols.has(name)) {
        this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${def}`);
      }
    }
    // Backfill last_seen for rows created before this column existed.
    this.db.exec(
      'UPDATE memories SET last_seen = ts WHERE last_seen = 0 OR last_seen IS NULL',
    );
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
      event.project ?? null,
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
   * similarity. Pulls a wider vector pool then applies scope/status filters in
   * JS (the vec0 KNN itself is project-agnostic).
   */
  findNearest(vec: Float32Array, opts: NearestOptions = {}): NearestHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const activeOnly = opts.activeOnly !== false;
    const pool = Math.max(limit * 6, 24);

    const hits = this.db
      .prepare(
        `SELECT rowid AS id, distance
         FROM memories_vec
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ${pool}`,
      )
      .all(embeddingToBlob(vec)) as Array<{ id: number; distance: number }>;

    if (hits.length === 0) return [];

    const byId = new Map(hits.map((h) => [h.id, h.distance]));
    const ids = [...byId.keys()];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as unknown as MemoryRow[];

    const out: NearestHit[] = [];
    for (const row of rows) {
      if (opts.excludeId && row.id === opts.excludeId) continue;
      if (activeOnly && row.status !== 'active') continue;
      if (opts.project !== undefined && row.project !== opts.project) continue;
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
   */
  recordObservation(id: number, prov: Provenance): Memory {
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
        c.project ?? c.active.project ?? null,
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

  /** All recorded contradictions, newest first, optionally scoped. */
  listContradictions(project?: string): Contradiction[] {
    const rows = (
      project
        ? this.db
            .prepare(
              'SELECT * FROM contradictions WHERE project = ? ORDER BY created_at DESC',
            )
            .all(project)
        : this.db
            .prepare('SELECT * FROM contradictions ORDER BY created_at DESC')
            .all()
    ) as unknown as ContradictionRow[];
    return rows.map((r) => this.toContradiction(r));
  }

  /**
   * Hybrid search: vector KNN (semantic) fused with FTS5 (keyword) via
   * Reciprocal Rank Fusion, nudged by stored importance and recency. Returns
   * the top `limit` memories ranked by combined relevance.
   */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 8, 100));
    const pool = limit * 4;
    const now = Date.now();

    const qvec = await embed(query);
    const vecRows = this.db
      .prepare(
        `SELECT rowid AS id, distance
         FROM memories_vec
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ${pool}`,
      )
      .all(embeddingToBlob(qvec)) as Array<{ id: number; distance: number }>;

    const ftsExpr = toFtsQuery(query);
    const kwRows = ftsExpr
      ? (this.db
          .prepare(
            `SELECT rowid AS id, bm25(memories_fts) AS score
             FROM memories_fts
             WHERE memories_fts MATCH ?
             ORDER BY score
             LIMIT ${pool}`,
          )
          .all(ftsExpr) as Array<{ id: number; score: number }>)
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

    const ids = [...fused.keys()];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as unknown as MemoryRow[];

    const results: SearchResult[] = [];
    for (const row of rows) {
      if (!opts.includeSuperseded && row.status !== 'active') continue;
      if (opts.project && row.project !== opts.project) continue;
      const f = fused.get(row.id)!;
      const mem = this.toMemory(row);
      // importance + recency are soft tiebreakers, not dominant factors.
      const score =
        f.rrf + 0.01 * mem.importance + 0.01 * recencyBoost(mem.lastSeen, now);
      results.push({ ...mem, score, distance: f.distance });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** Most recently observed memories, optionally scoped to a project. */
  recent(limit = 10, project?: string): Memory[] {
    const rows = (
      project
        ? this.db
            .prepare(
              `SELECT * FROM memories WHERE status = 'active' AND project = ?
               ORDER BY last_seen DESC LIMIT ?`,
            )
            .all(project, limit)
        : this.db
            .prepare(
              `SELECT * FROM memories WHERE status = 'active'
               ORDER BY last_seen DESC LIMIT ?`,
            )
            .all(limit)
    ) as unknown as MemoryRow[];
    return rows.map((r) => this.toMemory(r));
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
      where.push('project = ?');
      params.push(opts.project);
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
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(rowid);
    // FTS rows only exist when encryption is off (see insertMemory); the delete
    // is a harmless no-op otherwise.
    this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rowid);
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
    const where = opts.project ? 'WHERE project = ?' : '';
    const params: string[] = opts.project ? [opts.project] : [];

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
