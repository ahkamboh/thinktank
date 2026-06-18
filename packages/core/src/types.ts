/**
 * The atomic categories of knowledge thinktank stores.
 * Used to weight importance during retrieval and to detect conflicts
 * (e.g. two `decision` memories about the same topic that disagree).
 */
export type MemoryKind =
  | 'decision' // "we use JWT, not sessions"
  | 'fact' // "the staging DB is read-only"
  | 'preference' // "prefer pnpm over npm"
  | 'constraint' // "must support Node 18"
  | 'state' // "currently mid-refactor of the auth module"
  | 'code'; // a reusable snippet / signature

/**
 * Where a memory originated. Open-ended string, but these are the known sources.
 */
export type MemorySource =
  | 'chatgpt'
  | 'claude'
  | 'cursor'
  | 'claude-code'
  | 'codex'
  | 'manual'
  | (string & {});

/**
 * A raw, un-stored unit of context coming in from any capture path
 * (MCP write, browser extension, export import). The merge engine turns
 * `MemoryEvent`s into stored `Memory` rows.
 */
export interface MemoryEvent {
  source: MemorySource;
  /** Concrete tool/app name, e.g. "Cursor", "ChatGPT web". */
  tool?: string;
  /** Model that produced/discussed this, e.g. "gpt-5", "claude-opus". */
  model?: string;
  /** Event time in epoch milliseconds. */
  ts: number;
  /** Project / repo this belongs to, for scoping retrieval. */
  project?: string;
  /** Conversational role, when applicable. */
  role?: 'user' | 'assistant' | 'system' | (string & {});
  /** The actual content to remember. */
  text: string;
  /** Optional pre-classified kind; defaults to "fact" if omitted. */
  kind?: MemoryKind;
}

export type MemoryStatus = 'active' | 'superseded';

/**
 * A single observation of a memory: which tool/source/model saw it and when.
 * A deduped memory accumulates one `Provenance` entry per time it was observed,
 * so we can answer "who told us this, and when".
 */
export interface Provenance {
  source: MemorySource;
  tool?: string | null;
  model?: string | null;
  ts: number;
}

/**
 * A stored memory row.
 */
export interface Memory {
  id: number;
  source: MemorySource;
  tool: string | null;
  model: string | null;
  ts: number;
  project: string | null;
  role: string | null;
  text: string;
  kind: MemoryKind;
  status: MemoryStatus;
  /** How many times this same memory has been (re)observed. Raises importance. */
  seenCount: number;
  /** Combined score used for ranking & pruning (recomputed on write). */
  importance: number;
  /** Epoch ms of the most recent observation (drives recency decay). */
  lastSeen: number;
  /** Every observation of this memory, across tools/sources. */
  sources: Provenance[];
  /** If superseded, the id of the memory that replaced it. */
  supersededBy: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A recorded contradiction: a newer memory replaced an older one that asserted
 * a different value for the same topic. Lets us surface
 * "you told Cursor X but Claude Y".
 */
export interface Contradiction {
  id: number;
  project: string | null;
  topic: string | null;
  activeId: number;
  supersededId: number;
  activeText: string;
  supersededText: string;
  activeSource: string | null;
  supersededSource: string | null;
  activeTs: number | null;
  supersededTs: number | null;
  createdAt: number;
}

/**
 * An atomic candidate extracted from a raw `MemoryEvent` before it is merged
 * into the store. One inbound event (e.g. a chat turn) can yield zero or more.
 */
export interface MemoryCandidate {
  text: string;
  kind: MemoryKind;
  /** Extractor confidence, 0..1. Heuristic extractor uses coarse values. */
  confidence?: number;
}

/**
 * Pluggable extraction strategy. The default is heuristic/rule-based; an
 * LLM-backed extractor can be swapped in when an API key is present.
 */
export interface Extractor {
  readonly name: string;
  extract(event: MemoryEvent): Promise<MemoryCandidate[]> | MemoryCandidate[];
}

/** What the merge engine did with a single candidate. */
export type IngestAction = 'inserted' | 'deduped' | 'superseded';

/** Outcome of merging one candidate into the store. */
export interface IngestResult {
  action: IngestAction;
  /** The resulting active memory (new row for inserted/superseded; the
   * existing row for deduped). */
  memory: Memory;
  /** The candidate text that produced this result. */
  candidateText: string;
  /** For 'deduped': the existing memory id that absorbed the observation. */
  matchedId?: number;
  /** For 'superseded': the older memory that was retired. */
  superseded?: Memory;
}

/**
 * A memory returned from a search, annotated with retrieval scores.
 */
export interface SearchResult extends Memory {
  /** Final combined rank score (higher = more relevant). */
  score: number;
  /** Raw vector L2 distance, if this candidate came from vector search. */
  distance?: number;
}

export interface SaveOptions {
  /** Skip embedding/vector indexing (rarely needed; useful for tests). */
  skipVector?: boolean;
}
