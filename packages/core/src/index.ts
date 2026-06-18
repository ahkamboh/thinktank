export * from './types.js';
export {
  EMBED_DIM,
  DEFAULT_MODEL,
  embed,
  getEmbedder,
  embeddingToBlob,
  configureModelCache,
} from './embed.js';
export {
  MemoryStore,
  DEFAULT_DB_PATH,
  DEFAULT_DB_DIR,
  type SearchOptions,
  type NearestHit,
  type NearestOptions,
} from './db.js';
export {
  KIND_BASE,
  RECENCY_HALF_LIFE_MS,
  baseImportance,
  recencyBoost,
  dynamicImportance,
} from './score.js';
export {
  HeuristicExtractor,
  LLMExtractor,
  pickExtractor,
  classify,
} from './extract.js';
export {
  MergeEngine,
  contradicts,
  DEFAULT_DEDUPE_THRESHOLD,
  DEFAULT_CONFLICT_SIM_MIN,
  type MergeOptions,
} from './merge.js';
export {
  redactSecrets,
  type RedactionResult,
  type RedactionFinding,
} from './redact.js';
export {
  createCipher,
  resolveCipher,
  loadOrCreateKey,
  isEncryptionEnabled,
  isEncrypted,
  DEFAULT_KEY_PATH,
  DEFAULT_KEY_DIR,
  type Cipher,
} from './crypto.js';
