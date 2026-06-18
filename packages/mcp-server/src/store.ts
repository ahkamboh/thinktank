import {
  MemoryStore,
  MergeEngine,
  DEFAULT_DB_PATH,
  pickExtractor,
  resolveCipher,
} from '@thinktank/core';

/**
 * The resolved location of the user's local brain. Honors THINKTANK_DB so a
 * caller (tests, multiple profiles) can point at a different file; otherwise
 * the shared default at ~/.thinktank/thinktank.db.
 */
export function resolveDbPath(): string {
  return process.env.THINKTANK_DB?.trim() || DEFAULT_DB_PATH;
}

export interface Brain {
  store: MemoryStore;
  engine: MergeEngine;
  dbPath: string;
}

let singleton: Brain | null = null;

/**
 * Open (once) the shared MemoryStore + MergeEngine for this process. The merge
 * engine uses the LLM extractor automatically if an API key is configured,
 * otherwise the dependency-free heuristic one.
 */
export function getBrain(): Brain {
  if (!singleton) {
    const dbPath = resolveDbPath();
    // resolveCipher() returns null unless THINKTANK_ENCRYPT is enabled.
    const store = new MemoryStore(dbPath, { cipher: resolveCipher() });
    const engine = new MergeEngine(store, { extractor: pickExtractor() });
    singleton = { store, engine, dbPath };
  }
  return singleton;
}

export function closeBrain(): void {
  if (singleton) {
    singleton.store.close();
    singleton = null;
  }
}
