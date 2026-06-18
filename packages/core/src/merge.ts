import { embed } from './embed.js';
import type { MemoryStore } from './db.js';
import { HeuristicExtractor } from './extract.js';
import { redactSecrets } from './redact.js';
import type {
  Extractor,
  IngestResult,
  Memory,
  MemoryCandidate,
  MemoryEvent,
  MemoryKind,
  Provenance,
} from './types.js';

/**
 * Cosine similarity at/above which two memories are treated as the SAME memory
 * (a dedupe), not two different ones.
 */
export const DEFAULT_DEDUPE_THRESHOLD = 0.92;

/**
 * Minimum cosine similarity for two memories to even be *considered* for a
 * conflict. Below this they're about different things, so we never compare them.
 * The real conflict gate is the `contradicts()` heuristic; this just bounds it.
 */
export const DEFAULT_CONFLICT_SIM_MIN = 0.4;

/** Kinds whose values can meaningfully contradict each other. */
const CONFLICTABLE: ReadonlySet<MemoryKind> = new Set<MemoryKind>([
  'decision',
  'preference',
  'constraint',
  'fact',
]);

export interface MergeOptions {
  extractor?: Extractor;
  dedupeThreshold?: number;
  conflictSimMin?: number;
}

// --------------------------------------------------------------------------
// Lightweight NLP helpers for the contradiction heuristic.
//
// This is deliberately pragmatic, not a parser. The strategy: embedding
// proximity tells us two statements are *about the same area*; these helpers
// then decide whether they assert *different values*. We gate aggressively to
// keep false positives low, accepting that subtle conflicts will be missed.
// --------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'we', 'i', 'you', 'they', 'it', 'our', 'my', 'your',
  'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'and', 'or', 'but',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'will', 'shall', 'now',
  'this', 'that', 'these', 'those', 'use', 'using', 'used', 'uses', 'should',
  'would', 'could', 'do', 'does', 'did', 'have', 'has', 'had', 'instead',
  'rather', 'than', 'over', 'not', 'no', 'all', 'any', 'so', 'then', 'team',
  'project', 'repo', 'app', 'decided', 'decision', 'go', 'going', 'went',
  'prefer', 'prefers', 'preferred', 'chose', 'choose', 'pick', 'picked',
  'switch', 'switched', 'adopt', 'adopted', 'standardize', 'standardise',
  "let's", 'lets', 'always', 'never', 'must', 'only', 'about', 'regarding',
]);

/** Lowercase + strip punctuation + naive singularization. */
function norm(token: string): string {
  const t = token.toLowerCase().replace(/[^a-z0-9.+#-]/g, '');
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

function sameToken(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

const CHOICE_VERB =
  /\b(?:use|uses|using|used|adopt|adopted|chose|choose|choosing|pick|picked|picking|prefer|prefers|preferred|go with|going with|went with|switch to|switched to|switching to|standardi[sz]e on|standardi[sz]ed on)\s+([a-z0-9][a-z0-9.+#-]*(?:\s+[a-z0-9][a-z0-9.+#-]*){0,2})/i;

const ALT_MARKER =
  /\b(?:instead of|rather than|in place of|in favou?r of|replacing|not just|not)\s+([a-z0-9][a-z0-9.+#-]*)/gi;

interface Choice {
  /** Head value chosen (first salient token after a choice verb). */
  choice?: string;
  /** Values explicitly rejected ("instead of X"). */
  alts: string[];
}

/** Extract the chosen value and any rejected alternatives from a statement. */
function choiceOf(text: string): Choice {
  const alts: string[] = [];
  let m: RegExpExecArray | null;
  const altRe = new RegExp(ALT_MARKER.source, 'gi');
  while ((m = altRe.exec(text)) !== null) {
    const v = norm(m[1]!);
    if (v && !STOPWORDS.has(v)) alts.push(v);
  }

  let choice: string | undefined;
  const cm = CHOICE_VERB.exec(text);
  if (cm && cm[1]) {
    // Take the first salient (non-stopword) token of the captured phrase.
    for (const w of cm[1].split(/\s+/)) {
      const n = norm(w);
      if (n && !STOPWORDS.has(n)) {
        choice = n;
        break;
      }
    }
  }
  return { choice, alts };
}

/** Salient subject tokens: content words minus stopwords and the choice/alt
 * values themselves. Used to confirm two statements share a subject. */
function subjectTokens(text: string, choice: Choice): Set<string> {
  const exclude = new Set<string>([...(choice.choice ? [choice.choice] : []), ...choice.alts]);
  const out = new Set<string>();
  for (const w of text.split(/[^a-z0-9.+#-]+/i)) {
    const n = norm(w);
    if (!n || n.length < 3) continue;
    if (STOPWORDS.has(n) || exclude.has(n)) continue;
    out.add(n);
  }
  return out;
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/** Minimal antonym pairs for polarity contradictions on shared subjects. */
const ANTONYMS: Array<[string, string]> = [
  ['read-only', 'writable'],
  ['readonly', 'writable'],
  ['enabled', 'disabled'],
  ['required', 'optional'],
  ['public', 'private'],
  ['sync', 'async'],
  ['synchronous', 'asynchronous'],
  ['allowed', 'forbidden'],
  ['mutable', 'immutable'],
];

const PREDICATE_RE =
  /\b(?:is|are|was|were|be|should be|must be|stays?|remains?)\s+(not\s+|never\s+)?([a-z][a-z-]+)/i;

interface Predicate {
  negated: boolean;
  pred: string;
}

function predicateOf(text: string): Predicate | null {
  const m = PREDICATE_RE.exec(text);
  if (!m) return null;
  return { negated: !!m[1], pred: norm(m[2]!) };
}

function antonymOf(a: string, b: string): boolean {
  return ANTONYMS.some(
    ([x, y]) => (a === x && b === y) || (a === y && b === x),
  );
}

/**
 * Heuristic: do these two statements assert contradictory values?
 * Conservative by design - prefers missing a conflict over inventing one.
 */
export function contradicts(aText: string, bText: string): boolean {
  const a = choiceOf(aText);
  const b = choiceOf(bText);

  if (a.choice && b.choice) {
    if (sameToken(a.choice, b.choice)) return false; // same pick = agreement
    // Explicit rejection link: one statement rejects the other's pick.
    const oppose = b.alts.includes(a.choice) || a.alts.includes(b.choice);
    if (oppose) return true;
    // Otherwise require a shared subject so we don't flag "Postgres for the DB"
    // vs "Redis for caching" as a conflict.
    const sa = subjectTokens(aText, a);
    const sb = subjectTokens(bText, b);
    if (overlaps(sa, sb)) return true;
    return false;
  }

  // Polarity / antonym contradiction on a shared subject.
  const pa = predicateOf(aText);
  const pb = predicateOf(bText);
  if (pa && pb) {
    const sa = subjectTokens(aText, a);
    const sb = subjectTokens(bText, b);
    if (!overlaps(sa, sb)) return false;
    if (sameToken(pa.pred, pb.pred) && pa.negated !== pb.negated) return true;
    if (antonymOf(pa.pred, pb.pred) && pa.negated === pb.negated) return true;
  }
  return false;
}

/** Pick a short human-readable topic label shared by two statements. */
function topicLabel(aText: string, bText: string): string | null {
  const a = choiceOf(aText);
  const b = choiceOf(bText);
  const shared = [...subjectTokens(aText, a)].find((t) =>
    subjectTokens(bText, b).has(t),
  );
  return shared ?? null;
}

/** Strip any secrets out of an event's text before it enters the pipeline. */
function redactEvent(event: MemoryEvent): MemoryEvent {
  const r = redactSecrets(event.text);
  return r.found.length ? { ...event, text: r.text } : event;
}

/**
 * The merge engine: the single front door for capturing memories. Turns a raw
 * `MemoryEvent` into atomic candidates, then for each candidate decides whether
 * it is a duplicate (merge the observation), a conflict (supersede the old,
 * log the contradiction), or genuinely new (insert).
 */
export class MergeEngine {
  private extractor: Extractor;
  private dedupeThreshold: number;
  private conflictSimMin: number;

  constructor(
    private store: MemoryStore,
    opts: MergeOptions = {},
  ) {
    this.extractor = opts.extractor ?? new HeuristicExtractor();
    this.dedupeThreshold = opts.dedupeThreshold ?? DEFAULT_DEDUPE_THRESHOLD;
    this.conflictSimMin = opts.conflictSimMin ?? DEFAULT_CONFLICT_SIM_MIN;
  }

  /** Extract + merge every candidate from one inbound event. */
  async ingest(event: MemoryEvent): Promise<IngestResult[]> {
    // Redact secrets BEFORE anything else: nothing sensitive is ever extracted,
    // embedded, or stored. All capture paths (MCP save, /ingest, export import)
    // funnel through here, so this is the single chokepoint for redaction.
    const safeEvent = redactEvent(event);
    const candidates = await this.extractor.extract(safeEvent);
    const results: IngestResult[] = [];
    for (const cand of candidates) {
      results.push(await this.ingestCandidate(safeEvent, cand));
    }
    return results;
  }

  private async ingestCandidate(
    event: MemoryEvent,
    cand: MemoryCandidate,
  ): Promise<IngestResult> {
    const candEvent: MemoryEvent = {
      ...event,
      text: cand.text,
      kind: cand.kind,
    };
    const prov: Provenance = {
      source: event.source,
      tool: event.tool ?? null,
      model: event.model ?? null,
      ts: event.ts,
    };

    const vec = await embed(cand.text);
    const nearest = this.store.findNearest(vec, {
      project: event.project,
      limit: 8,
    });

    // 1) DEDUPE - same meaning already stored.
    const dup = nearest.find((h) => h.cosine >= this.dedupeThreshold);
    if (dup) {
      const memory = this.store.recordObservation(dup.id, prov);
      return {
        action: 'deduped',
        memory,
        matchedId: dup.id,
        candidateText: cand.text,
      };
    }

    // 2) CONFLICT - related statement that asserts a different value.
    if (CONFLICTABLE.has(cand.kind)) {
      for (const h of nearest) {
        if (h.cosine < this.conflictSimMin) continue; // unrelated
        if (h.cosine >= this.dedupeThreshold) continue; // would've deduped
        if (!CONFLICTABLE.has(h.memory.kind)) continue;
        if (!contradicts(cand.text, h.memory.text)) continue;

        // Insert the incoming memory, then keep whichever is newer active.
        const inserted = this.store.insertMemory(candEvent, vec);
        const existing = h.memory;
        let active: Memory;
        let superseded: Memory;
        if (inserted.ts >= existing.ts) {
          this.store.supersede(existing.id, inserted.id);
          active = inserted;
          superseded = this.store.getById(existing.id)!;
        } else {
          this.store.supersede(inserted.id, existing.id);
          active = existing;
          superseded = this.store.getById(inserted.id)!;
        }
        this.store.logContradiction({
          project: event.project ?? null,
          topic: topicLabel(cand.text, existing.text),
          active,
          superseded,
        });
        return {
          action: 'superseded',
          memory: active,
          superseded,
          candidateText: cand.text,
        };
      }
    }

    // 3) NOVEL - store as a new memory.
    const memory = this.store.insertMemory(candEvent, vec);
    return { action: 'inserted', memory, candidateText: cand.text };
  }
}
