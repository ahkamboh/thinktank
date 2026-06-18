import type {
  Extractor,
  MemoryCandidate,
  MemoryEvent,
  MemoryKind,
} from './types.js';

/**
 * Markers that signal a durable decision ("we use X, not Y").
 */
const DECISION_RE =
  /\b(decided|decision|we (?:use|chose|picked|went with|will use|are using)|going with|let's use|switch(?:ed)? to|adopt(?:ed)?|standardi[sz]e on)\b/i;
const PREFERENCE_RE = /\b(prefer|favou?r|rather than|over|like(?:s)? using|tend to)\b/i;
const CONSTRAINT_RE =
  /\b(must|must not|never|always|cannot|can't|do not|don't|required|requirement|need to|has to|only)\b/i;
const STATE_RE =
  /\b(currently|right now|in progress|mid-|working on|wip|todo|blocked on|next step)\b/i;

/** Greetings / filler we never want to remember. */
const CHITCHAT_RE =
  /^(hi|hey|hello|thanks|thank you|ok|okay|cool|great|sounds good|sure|yes|no|yep|nope|got it|please|can you|could you|what|how|why|when|where|who)\b/i;

/** A fenced code block. */
const CODE_FENCE_RE = /```[\s\S]*?```/g;

/**
 * Classify a single declarative sentence into a memory kind.
 * Order matters: most specific / highest-value signals win.
 */
export function classify(text: string): MemoryKind {
  if (DECISION_RE.test(text)) return 'decision';
  if (CONSTRAINT_RE.test(text)) return 'constraint';
  if (PREFERENCE_RE.test(text)) return 'preference';
  if (STATE_RE.test(text)) return 'state';
  return 'fact';
}

/** Split a block of prose into trimmed sentence-ish chunks. */
function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'`])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Is this sentence worth remembering at all? Drops questions, greetings, and
 * very short fragments so we don't pollute the store with chit-chat.
 */
function isMemorable(sentence: string): boolean {
  const s = sentence.trim();
  if (s.length < 15) return false;
  if (s.endsWith('?')) return false;
  if (CHITCHAT_RE.test(s)) return false;
  return true;
}

/**
 * Rule-based extractor. No model, no network. Pulls atomic, durable
 * candidates out of a raw event:
 *   - fenced code blocks  -> kind=code
 *   - each memorable sentence -> classified kind
 * If the event already carries an explicit `kind` and is a single short
 * statement, it is passed through verbatim (callers that pre-classify, like
 * the MCP `save` tool or export parsers, stay authoritative).
 */
export class HeuristicExtractor implements Extractor {
  readonly name = 'heuristic';

  extract(event: MemoryEvent): MemoryCandidate[] {
    const raw = event.text?.trim();
    if (!raw) return [];

    // Pre-classified, single-statement events pass straight through.
    if (event.kind && raw.length <= 300 && splitSentences(raw).length <= 1) {
      return [{ text: raw, kind: event.kind, confidence: 0.9 }];
    }

    const candidates: MemoryCandidate[] = [];

    // 1) Code fences become `code` candidates; strip them from the prose pass.
    const codeBlocks = raw.match(CODE_FENCE_RE) ?? [];
    for (const block of codeBlocks) {
      const body = block.replace(/```[\w-]*\n?/, '').replace(/```$/, '').trim();
      if (body.length >= 10) {
        candidates.push({ text: body, kind: 'code', confidence: 0.8 });
      }
    }
    const prose = raw.replace(CODE_FENCE_RE, ' ');

    // 2) Sentence pass.
    for (const sentence of splitSentences(prose)) {
      if (!isMemorable(sentence)) continue;
      const kind = event.kind ?? classify(sentence);
      // Coarse confidence: explicit decision/constraint markers are stronger.
      const confidence = kind === 'fact' ? 0.5 : 0.7;
      candidates.push({ text: sentence, kind, confidence });
    }

    // Fallback: nothing matched but the event was non-trivial - keep it as a
    // single fact rather than silently dropping context.
    if (candidates.length === 0 && raw.length >= 15) {
      candidates.push({ text: raw, kind: event.kind ?? 'fact', confidence: 0.4 });
    }

    return candidates;
  }
}

/**
 * LLM-backed extractor (wired, not yet implemented). Active only when an API
 * key is present; otherwise the factory below never selects it. For now it
 * delegates to the heuristic so the pipeline is fully functional - the real
 * model call is a deliberate TODO for a later phase.
 */
export class LLMExtractor implements Extractor {
  readonly name = 'llm';
  private fallback = new HeuristicExtractor();

  constructor(
    private opts: { provider: 'anthropic' | 'openai'; apiKey: string },
  ) {}

  async extract(event: MemoryEvent): Promise<MemoryCandidate[]> {
    // TODO(P6): call ${this.opts.provider} to extract atomic memories with
    // higher precision (better kind classification, coreference resolution,
    // topic tagging). Until then, behave exactly like the heuristic extractor.
    void this.opts;
    return this.fallback.extract(event);
  }
}

/**
 * Choose an extractor. Uses the LLM extractor only when an API key is
 * configured in the environment; otherwise the dependency-free heuristic.
 */
export function pickExtractor(
  env: NodeJS.ProcessEnv = process.env,
): Extractor {
  if (env.ANTHROPIC_API_KEY) {
    return new LLMExtractor({
      provider: 'anthropic',
      apiKey: env.ANTHROPIC_API_KEY,
    });
  }
  if (env.OPENAI_API_KEY) {
    return new LLMExtractor({ provider: 'openai', apiKey: env.OPENAI_API_KEY });
  }
  return new HeuristicExtractor();
}
