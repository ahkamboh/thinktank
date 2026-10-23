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
  BUSY_TIMEOUT_MS,
  distanceToCosine,
  type MemoryStoreOptions,
  type ResumeCandidateOptions,
  type SearchOptions,
  type NearestHit,
  type NearestOptions,
  type ListOptions,
  type ListResult,
  type Facet,
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
  isNoise,
  isTrivialNote,
  splitSentences,
  chunkNote,
  noteCandidates,
  NOTE_MAX_CHARS,
  pickClassifier,
  HeuristicClassifier,
  LLMClassifier,
  type Provider,
  type Classifier,
  type MemoryJudgement,
} from './extract.js';
export {
  MergeEngine,
  contradicts,
  addsInformation,
  openContradictions,
  DEFAULT_DEDUPE_THRESHOLD,
  DEFAULT_CONFLICT_SIM_MIN,
  type MergeOptions,
} from './merge.js';
export {
  projectKey,
  normalizeAliases,
  loadProjectAliases,
  type ProjectAliases,
} from './project.js';
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
