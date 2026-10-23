import { embed } from './embed.js';
import type { MemoryStore } from './db.js';
import { HeuristicExtractor, noteCandidates, splitSentences } from './extract.js';
import { redactSecrets } from './redact.js';
import type {
  Contradiction,
  Extractor,
  IngestOptions,
  IngestResult,
  Memory,
  MemoryCandidate,
  MemoryEvent,
  MemoryKind,
  Provenance,
} from './types.js';

/**
 * Cosine similarity at/above which two memories MAY be the same memory (a
 * dedupe). A hit above it still isn't merged if the new text adds information
 * (an updated note) or contradicts the old one - see mergeCandidate().
 */
export const DEFAULT_DEDUPE_THRESHOLD = 0.92;

/**
 * Minimum cosine similarity for two memories to even be *considered* for a
 * conflict. Below this they're about different things, so we never compare them.
 * The real conflict gate is the `contradicts()` heuristic; this just bounds it.
 * (Both thresholds are true cosine similarity - see distanceToCosine in db.ts.)
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
// then decide whether they assert *different values for the same thing*. A
// conflict needs the same subject, the same attribute and a materially
// different value; anything less is left alone. Missing a subtle conflict is
// cheap (both memories stay active), inventing one hides a true memory.
// --------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'we', 'i', 'you', 'they', 'it', 'our', 'my', 'your',
  'its', 'their', 'his', 'her', 'him', 'them', 'me', 'us', 'he', 'she',
  'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'and', 'or', 'but',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'will', 'shall', 'now',
  'this', 'that', 'these', 'those', 'use', 'using', 'used', 'uses', 'should',
  'would', 'could', 'do', 'does', 'did', 'have', 'has', 'had', 'instead',
  'rather', 'than', 'over', 'not', 'no', 'all', 'any', 'so', 'then', 'team',
  'project', 'repo', 'app', 'decided', 'decision', 'go', 'going', 'went',
  'prefer', 'prefers', 'preferred', 'chose', 'choose', 'pick', 'picked',
  'switch', 'switched', 'adopt', 'adopted', 'standardize', 'standardise',
  "let's", 'lets', 'always', 'never', 'must', 'only', 'about', 'regarding',
  'also', 'just', 'still', 'already', 'currently', 'new', 'old', 'here',
  'there', 'which', 'what', 'who', 'when', 'where', 'how', 'why', 'can',
  'may', 'might', 'get', 'got', 'make', 'made', 'like', 'each', 'every',
  'some', 'more', 'most', 'other', 'such', 'own', 'same', 'very', 'too',
  'via', 'into', 'from', 'as', 'if', 'because', 'since', 'while', 'up',
  'out', 'off', 'per', 'etc', 'e.g', 'i.e', 'one', 'both', 'either', 'keep',
  'need', 'needs', 'want', 'wants', 'thing', 'things', 'way',
]);

const MONTHS = new Set([
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may',
  'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september',
  'oct', 'october', 'nov', 'november', 'dec', 'december', 'today',
  'yesterday', 'tomorrow',
]);

/** Dates, numbers and ordinals say WHEN, not WHAT - never a shared subject. */
function isDateish(token: string): boolean {
  return MONTHS.has(token) || /^\d+(?:st|nd|rd|th)?$/.test(token);
}

/** Lowercase + strip punctuation + naive singularization. */
function norm(token: string): string {
  const t = token
    .toLowerCase()
    .replace(/[^a-z0-9.+#-]/g, '')
    .replace(/^[.+-]+/, '')
    .replace(/[.-]+$/, '');
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

/** Content tokens of a phrase: normalized, minus stopwords. */
function tokensOf(text: string, maxWords = Infinity): string[] {
  const out: string[] = [];
  for (const w of text.split(/\s+/).slice(0, maxWords)) {
    for (const part of w.split(/[^a-z0-9.+#-]+/i)) {
      const n = norm(part);
      if (n && !STOPWORDS.has(n)) out.push(n);
    }
  }
  return out;
}

const CHOICE_VERB_RE =
  /\b(?:use|uses|using|used|adopt|adopts|adopted|adopting|chose|choose|chooses|choosing|pick|picks|picked|picking|prefer|prefers|preferred|go with|goes with|going with|went with|switch to|switches to|switched to|switching to|move to|moved to|migrate to|migrated to|standardi[sz]e on|standardi[sz]ed on)\s+([\s\S]*)$/i;

/** Where the chosen value's phrase ends: punctuation or a clause/preposition word. */
const VALUE_END_RE =
  /[,;:!?()[\]{}"“”]|\.(?:\s|$)|\s(?:for|as|in|on|at|to|with|within|from|by|via|because|since|so|when|while|where|which|that|and|but|or|instead|rather|over|than|not|across|throughout|inside|everywhere|now|only|if|unless|until)\b/i;

const ALT_MARKER_RE =
  /\b(?:instead of|rather than|in place of|in favou?r of|replacing|not)\s+([^,;:!?()[\]{}"“”]+)/gi;

const PREFER_OVER_RE =
  /\bprefer(?:s|red)?\s+[^,;:!?]+?\s+(?:over|to)\s+([^,;:!?()[\]{}"“”]+)/i;

/** One statement reduced to what was chosen, what was rejected, and about what. */
interface Statement {
  /** Content tokens of the chosen value ("use Tailwind CSS" -> tailwind, css). */
  value: Set<string>;
  /** Content tokens of explicitly rejected values ("instead of sessions"). */
  alts: Set<string>;
  /** Subject + attribute tokens: everything else that says WHAT it is about. */
  context: Set<string>;
}

function phraseTokens(rest: string, maxWords: number): string[] {
  // Pad so a phrase that STARTS with a clause word ("used for caching") ends
  // immediately instead of swallowing what follows.
  const padded = ` ${rest}`;
  const end = padded.search(VALUE_END_RE);
  return tokensOf(end === -1 ? padded : padded.slice(0, end), maxWords);
}

function parseStatement(text: string): Statement {
  const value = new Set<string>();
  const cm = CHOICE_VERB_RE.exec(text);
  if (cm?.[1]) for (const t of phraseTokens(cm[1], 4)) value.add(t);

  const alts = new Set<string>();
  for (const m of text.matchAll(ALT_MARKER_RE)) {
    // "not" is too common to trust beyond the word right after it.
    const words = /^not\s/i.test(m[0]) ? 1 : 3;
    for (const t of phraseTokens(m[1]!, words)) alts.add(t);
  }
  const pm = PREFER_OVER_RE.exec(text);
  if (pm?.[1]) for (const t of phraseTokens(pm[1], 2)) alts.add(t);

  const context = new Set<string>();
  for (const t of tokensOf(text)) {
    if (t.length < 3 || isDateish(t) || value.has(t) || alts.has(t)) continue;
    context.add(t);
  }
  return { value, alts, context };
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

function without(set: Set<string>, token: string): Set<string> {
  const out = new Set(set);
  out.delete(token);
  return out;
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
  ['on', 'off'],
];

const PREDICATE_RE =
  /\b(?:is|are|was|were|be|should be|must be|stays?|remains?)\s+(?:now\s+|still\s+|always\s+)?(not\s+|never\s+)?([a-z][a-z-]+)/i;

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

/** Longest statement the contradiction heuristic will judge. */
const ATOMIC_MAX_CHARS = 240;

/** Subject+attribute overlap needed to call two statements "about the same thing". */
const SAME_CONTEXT_MIN = 0.5;

/** Looser overlap when one statement explicitly rejects the other's value. */
const OPPOSED_CONTEXT_MIN = 0.34;

/**
 * A single short statement. Multi-sentence notes carry several claims at once,
 * which a token heuristic can't line up, so they are never auto-superseded.
 */
function isAtomicStatement(text: string): boolean {
  return text.length <= ATOMIC_MAX_CHARS && splitSentences(text).length <= 1;
}

/**
 * Heuristic: do these two statements assert contradictory values?
 *
 * Both must be single short statements. Then either
 *  - both choose a value ("we use X"), the values don't overlap, and either
 *    one explicitly rejects the other's value ("Y instead of X") or both are
 *    about the same subject + attribute (context overlap >= 0.5); or
 *  - both state a predicate about the same subject ("the DB is read-only")
 *    with opposite polarity or antonym values.
 * Sharing one incidental word ("via", "oct", "public") is not enough.
 */
export function contradicts(aText: string, bText: string): boolean {
  if (!isAtomicStatement(aText) || !isAtomicStatement(bText)) return false;
  const a = parseStatement(aText);
  const b = parseStatement(bText);

  if (a.value.size > 0 && b.value.size > 0) {
    // Same or overlapping pick ("unique prefixed class names" both times) is
    // agreement or a refinement, not a conflict.
    if (intersects(a.value, b.value)) return false;
    const sim = jaccard(a.context, b.context);
    const opposed = intersects(b.alts, a.value) || intersects(a.alts, b.value);
    if (opposed) {
      return a.context.size === 0 || b.context.size === 0 || sim >= OPPOSED_CONTEXT_MIN;
    }
    return a.context.size > 0 && b.context.size > 0 && sim >= SAME_CONTEXT_MIN;
  }

  // Polarity / antonym contradiction on the same subject.
  const pa = predicateOf(aText);
  const pb = predicateOf(bText);
  if (!pa || !pb) return false;
  const sa = without(a.context, pa.pred);
  const sb = without(b.context, pb.pred);
  if (sa.size === 0 || sb.size === 0 || jaccard(sa, sb) < SAME_CONTEXT_MIN) return false;
  if (pa.pred === pb.pred) return pa.negated !== pb.negated;
  return antonymOf(pa.pred, pb.pred) && pa.negated === pb.negated;
}

/** Pick a short human-readable topic label shared by two statements. */
function topicLabel(aText: string, bText: string): string | null {
  const b = parseStatement(bText).context;
  return [...parseStatement(aText).context].find((t) => b.has(t)) ?? null;
}

/** Tokens that carry information, for the "does this add anything?" check. */
function infoTokens(text: string): Set<string> {
  // Any token with a digit counts, even "3" ("Section 3", "M9", "v2").
  return new Set(tokensOf(text).filter((t) => t.length >= 2 || /\d/.test(t)));
}

/**
 * Does `cand` say something `existing` doesn't? True when it introduces a new
 * number/identifier (M8 -> M9, v2 -> v3, a new date) or more than a third new
 * content words. Paraphrases and subsets of the existing text return false.
 */
export function addsInformation(cand: string, existing: string): boolean {
  const c = infoTokens(cand);
  const e = infoTokens(existing);
  const novel = [...c].filter((t) => !e.has(t));
  if (novel.length === 0) return false;
  if (novel.some((t) => /\d/.test(t))) return true;
  return novel.length / c.size > 1 / 3;
}

/**
 * Contradictions still worth surfacing: the winner is still active, the loser
 * still superseded by it, and the pair still passes `contradicts()` (so false
 * positives logged by older, looser versions of the heuristic drop out).
 */
export function openContradictions(store: MemoryStore, project?: string): Contradiction[] {
  return store
    .listContradictions(project, { openOnly: true })
    .filter((c) => contradicts(c.activeText, c.supersededText));
}

/** Strip any secrets out of an event's text before it enters the pipeline. */
function redactEvent(event: MemoryEvent): MemoryEvent {
  const r = redactSecrets(event.text);
  return r.found.length ? { ...event, text: r.text } : event;
}

/**
 * The merge engine: the single front door for capturing memories. Turns a raw
 * `MemoryEvent` into candidates, then for each candidate decides whether it is
 * a duplicate (merge the observation), a conflict (supersede the old, log the
 * contradiction), or genuinely new (insert).
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

  /**
   * Extract + merge every candidate from one inbound event. `mode: 'note'` (an
   * explicit save) stores the text as one memory; the default `chat` mode runs
   * the extractor, which splits and filters raw chat turns.
   */
  async ingest(event: MemoryEvent, opts: IngestOptions = {}): Promise<IngestResult[]> {
    // Redact secrets BEFORE anything else: nothing sensitive is ever extracted,
    // embedded, or stored. All capture paths (MCP save, /ingest, export import)
    // funnel through here, so this is the single chokepoint for redaction.
    const safeEvent = redactEvent(event);
    const candidates =
      opts.mode === 'note'
        ? noteCandidates(safeEvent)
        : await this.extractor.extract(safeEvent);
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
    const vec = await embed(cand.text);
    // Look-up + decision + write in one transaction, so two processes saving
    // the same thing at once can't both insert it.
    return this.store.transaction(() => this.mergeCandidate(event, cand, vec));
  }

  private mergeCandidate(
    event: MemoryEvent,
    cand: MemoryCandidate,
    vec: Float32Array,
  ): IngestResult {
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

    const nearest = this.store.findNearest(vec, {
      project: event.project,
      limit: 8,
    });

    // 1) DEDUPE - same meaning AND nothing new. A near-identical text that adds
    // a detail (an updated status note) or flips a value is not a duplicate.
    const dup = nearest.find(
      (h) =>
        h.cosine >= this.dedupeThreshold &&
        !addsInformation(cand.text, h.memory.text) &&
        !contradicts(cand.text, h.memory.text),
    );
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
