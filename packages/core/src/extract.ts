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
const PREFERENCE_RE = /\b(prefer|favou?r|rather than|like(?:s)? using|tend to)\b/i;
const CONSTRAINT_RE =
  /\b(must|must not|never|always|cannot|can't|do not|don't|required|requirement|need to|has to|only allow|not allowed|forbidden)\b/i;
const STATE_RE =
  /\b(currently|right now|in progress|mid-|working on|wip|todo|blocked on|next step)\b/i;

/** Any of the high-value, durable signals. If present we never treat as noise. */
const DURABLE_RE = new RegExp(
  `(${DECISION_RE.source})|(${PREFERENCE_RE.source})|(${CONSTRAINT_RE.source})`,
  'i',
);

/**
 * Greetings, sign-offs, acknowledgements and pure filler we never remember.
 * Anchored so it only fires on lines that are *mostly* the filler phrase.
 */
const FILLER_RE =
  /^(hi|hey|hello|yo|thanks|thank you|thx|ty|ok|okay|k|cool|great|nice|awesome|perfect|sounds good|sure|yes|yeah|yep|no|nope|got it|np|no problem|you're welcome|welcome|good morning|good afternoon|good night|gn|bye|goodbye|see you|cya|cheers|lol|lmao|haha+|hmm+|right|alright|fine|done|ok thanks|ok cool|thanks a lot|much appreciated|please|pls)\b[\s!.,]*$/i;

/**
 * Conversational filler phrases that can appear anywhere in a short line
 * ("let me know when you're free", "ok thanks a lot"). Caught when the line is
 * short and carries no durable marker.
 */
const FILLER_PHRASE_RE =
  /\b(let me know|feel free|no worries|talk soon|keep me posted|sounds good|thanks a lot|thank you so much|much appreciated|appreciate it|got it,? thanks|will do|on it|my bad|nvm|never ?mind)\b/i;

/**
 * One-off transient requests aimed at the assistant ("change this pic",
 * "reduce my beard", "summarize that"). These are tasks, not durable knowledge.
 * Only treated as noise when no durable marker is also present.
 */
const REQUEST_RE =
  /^(change|reduce|increase|give|make|add|remove|delete|fix|create|write|generate|draw|edit|crop|resize|rotate|translate|convert|build|show|tell|find|send|open|close|run|try|redo|regenerate|rephrase|rewrite|summari[sz]e|explain|describe|paraphrase|improve|enhance|update|adjust|set|turn|put|move|copy|paste|upload|download|attach|paint|color|colour)\b/i;

/** A fenced code block. */
const CODE_FENCE_RE = /```[\s\S]*?```/g;

/** Count emoji / pictographic codepoints in a string. */
function emojiCount(s: string): number {
  const m = s.match(/\p{Extended_Pictographic}/gu);
  return m ? m.length : 0;
}

/** Word-ish tokens (letters/numbers), used for substance checks. */
function wordCount(s: string): number {
  const m = s.match(/[\p{L}\p{N}][\p{L}\p{N}'+#.-]*/gu);
  return m ? m.length : 0;
}

/**
 * Should this text be dropped as non-durable noise? Conservative on the keep
 * side for anything carrying a durable marker, aggressive on greetings, emoji,
 * bare questions, tiny fragments, and one-off task requests.
 *
 * Exported so the reprocess/reclassify pass can reuse the exact same judgement.
 */
export function isNoise(text: string): boolean {
  const s = text.trim();
  if (!s) return true;

  const alnum = s.replace(/[^\p{L}\p{N}]/gu, '');
  // Almost no alphanumeric substance (emoji-only, punctuation, "👍", "ok").
  if (alnum.length < 6) return true;

  const words = wordCount(s);
  // Mostly an emoji with little text.
  if (emojiCount(s) > 0 && words <= 2) return true;

  // Durable, high-value statements are always kept.
  if (DURABLE_RE.test(s)) return false;

  // Greetings / acknowledgements / filler.
  if (FILLER_RE.test(s)) return true;
  if (FILLER_PHRASE_RE.test(s) && s.length < 80) return true;

  // Bare, short questions with no durable info ("how do I do this?").
  if (s.endsWith('?') && s.length < 90) return true;

  // One-off transient requests to the assistant (no durable marker, since the
  // DURABLE check above already returned for those).
  if (REQUEST_RE.test(s) && s.length < 160) return true;

  // Very short leftover fragments.
  if (s.length < 12 || words < 3) return true;

  return false;
}

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
 * Rule-based extractor. No model, no network. Pulls atomic, durable
 * candidates out of a raw event:
 *   - fenced code blocks  -> kind=code
 *   - each non-noise sentence -> classified kind
 * Noise (greetings, emoji, bare questions, one-off requests) is dropped.
 */
export class HeuristicExtractor implements Extractor {
  readonly name = 'heuristic';

  extract(event: MemoryEvent): MemoryCandidate[] {
    const raw = event.text?.trim();
    if (!raw) return [];

    // Pre-classified, single-statement events pass through *if* they carry
    // substance (so the MCP `save` tool and export parsers stay authoritative,
    // but a pre-tagged greeting still gets dropped).
    if (event.kind && raw.length <= 300 && splitSentences(raw).length <= 1) {
      return isNoise(raw) ? [] : [{ text: raw, kind: event.kind, confidence: 0.9 }];
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

    // 2) Sentence pass - keep only non-noise sentences.
    for (const sentence of splitSentences(prose)) {
      if (isNoise(sentence)) continue;
      const kind = event.kind ?? classify(sentence);
      const confidence = kind === 'fact' ? 0.5 : 0.7;
      candidates.push({ text: sentence, kind, confidence });
    }

    // Fallback: nothing matched but the whole event is itself durable - keep it
    // as a single fact rather than dropping context. Noise is still dropped.
    if (candidates.length === 0 && !isNoise(raw)) {
      candidates.push({ text: raw, kind: event.kind ?? 'fact', confidence: 0.4 });
    }

    return candidates;
  }
}

// ---------------------------------------------------------------------------
// LLM provider plumbing (shared by the LLM extractor and the reclassifier).
// Uses fetch only - no SDK dependency. Falls back gracefully on any error.
// ---------------------------------------------------------------------------

export type Provider = 'anthropic' | 'openai';

const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: 'claude-3-5-haiku-latest',
  openai: 'gpt-4o-mini',
};

const KINDS: ReadonlySet<string> = new Set<MemoryKind>([
  'decision',
  'fact',
  'preference',
  'constraint',
  'state',
  'code',
]);

function coerceKind(v: unknown): MemoryKind {
  return typeof v === 'string' && KINDS.has(v) ? (v as MemoryKind) : 'fact';
}

/**
 * Pull the first JSON array out of a model response, tolerating code fences and
 * surrounding prose. Returns [] if nothing parseable is found.
 */
function parseJsonArray(text: string): unknown[] {
  let t = text.trim();
  // Strip ```json ... ``` fences.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) t = fence[1].trim();
  // Slice from the first '[' to the last ']'.
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const v = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

interface LLMCallOpts {
  provider: Provider;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** One chat-style completion call. Throws on HTTP/timeout/parse failure. */
async function llmComplete(
  opts: LLMCallOpts,
  system: string,
  user: string,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    if (opts.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: 1024,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      return (data.content ?? [])
        .map((c) => (c.type === 'text' ? c.text ?? '' : ''))
        .join('');
    }
    // openai
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

const EXTRACT_SYSTEM = `You extract durable, reusable memories from AI chat messages for a long-term memory system.

Keep ONLY information that stays useful later:
- decision: a choice that was made ("we use JWT, not sessions")
- preference: a stated preference ("prefer pnpm over npm")
- constraint: a rule/requirement ("must support Node 18", "never commit secrets")
- fact: a stable fact about the project, system, or user ("the staging DB is read-only")
- state: current ongoing status worth remembering ("mid-refactor of auth")
- code: a reusable snippet, signature, or config

AGGRESSIVELY DROP and DO NOT return:
- greetings, thanks, acknowledgements, small talk
- emoji-only or one-line reactions
- one-off task requests ("change this image", "summarize that", "fix this bug")
- questions with no durable answer
- transient chit-chat or anything not reusable later

Prefer FEWER, higher-quality memories. Rewrite each into a concise, self-contained statement.
Return STRICT JSON only: an array of {"text": string, "kind": one of decision|preference|constraint|fact|state|code}.
If nothing is worth keeping, return [].`;

/**
 * LLM-backed extractor. Active only when an API key is present. On any error
 * (network, rate limit, bad JSON, timeout) it falls back to the heuristic so
 * ingest never breaks.
 */
export class LLMExtractor implements Extractor {
  readonly name = 'llm';
  private fallback = new HeuristicExtractor();
  private call: LLMCallOpts;

  constructor(opts: {
    provider: Provider;
    apiKey: string;
    model?: string;
    timeoutMs?: number;
  }) {
    this.call = {
      provider: opts.provider,
      apiKey: opts.apiKey,
      model: opts.model ?? DEFAULT_MODELS[opts.provider],
      timeoutMs: opts.timeoutMs ?? 20_000,
    };
  }

  async extract(event: MemoryEvent): Promise<MemoryCandidate[]> {
    const raw = event.text?.trim();
    if (!raw) return [];
    // Cheap pre-filter: obvious noise never needs an API round-trip.
    if (raw.length < 12) return [];

    try {
      const out = await llmComplete(
        this.call,
        EXTRACT_SYSTEM,
        `Role: ${event.role ?? 'user'}\nMessage:\n${raw}`,
      );
      const arr = parseJsonArray(out);
      const candidates: MemoryCandidate[] = [];
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const text = (item as { text?: unknown }).text;
        if (typeof text !== 'string' || !text.trim()) continue;
        candidates.push({
          text: text.trim(),
          kind: coerceKind((item as { kind?: unknown }).kind),
          confidence: 0.85,
        });
      }
      return candidates;
    } catch (err) {
      // Never crash ingest - degrade to the offline heuristic.
      console.error(
        `[thinktank] LLM extract failed (${String(err)}); using heuristic.`,
      );
      return this.fallback.extract(event);
    }
  }
}

/**
 * Choose an extractor. Uses the LLM extractor only when an API key is
 * configured; otherwise the dependency-free heuristic.
 */
export function pickExtractor(env: NodeJS.ProcessEnv = process.env): Extractor {
  const model = env.THINKTANK_EXTRACT_MODEL?.trim() || undefined;
  if (env.ANTHROPIC_API_KEY) {
    return new LLMExtractor({
      provider: 'anthropic',
      apiKey: env.ANTHROPIC_API_KEY,
      model,
    });
  }
  if (env.OPENAI_API_KEY) {
    return new LLMExtractor({
      provider: 'openai',
      apiKey: env.OPENAI_API_KEY,
      model,
    });
  }
  return new HeuristicExtractor();
}

// ---------------------------------------------------------------------------
// Reclassifier: judges EXISTING stored memories (drop-as-noise + better kind).
// Used by `thinktank reprocess` to clean up a brain that was filled by the old
// over-eager heuristic. Works with or without an API key.
// ---------------------------------------------------------------------------

/** A judgement about one already-stored memory. */
export interface MemoryJudgement {
  /** True if this should be removed as non-durable noise. */
  drop: boolean;
  /** The better kind to assign (ignored if drop). */
  kind: MemoryKind;
}

export interface Classifier {
  readonly name: string;
  /** Judge a batch of memory texts; result aligns 1:1 with the input order. */
  classify(texts: string[]): Promise<MemoryJudgement[]>;
}

/** Offline classifier: reuses isNoise + classify. No network. */
export class HeuristicClassifier implements Classifier {
  readonly name = 'heuristic';
  async classify(texts: string[]): Promise<MemoryJudgement[]> {
    return texts.map((t) => ({ drop: isNoise(t), kind: classify(t) }));
  }
}

const RECLASSIFY_SYSTEM = `You are cleaning a long-term memory store of AI chat snippets.
For each numbered item decide:
- "keep": true only if it is durable, reusable knowledge (a decision, preference, constraint, stable fact, ongoing state, or reusable code). Set keep:false for greetings, small talk, emoji, one-off task requests, transient questions, or anything not reusable later.
- "kind": one of decision|preference|constraint|fact|state|code (best fit).

Return STRICT JSON only: an array of {"i": number, "keep": boolean, "kind": string}, one entry per input index. No prose.`;

/** LLM classifier: batches many memories into one call. */
export class LLMClassifier implements Classifier {
  readonly name = 'llm';
  private fallback = new HeuristicClassifier();
  private call: LLMCallOpts;
  private batchSize: number;

  constructor(opts: {
    provider: Provider;
    apiKey: string;
    model?: string;
    timeoutMs?: number;
    batchSize?: number;
  }) {
    this.call = {
      provider: opts.provider,
      apiKey: opts.apiKey,
      model: opts.model ?? DEFAULT_MODELS[opts.provider],
      timeoutMs: opts.timeoutMs ?? 30_000,
    };
    this.batchSize = opts.batchSize ?? 25;
  }

  /** How many API calls a run over N memories will cost (for cost estimates). */
  callCount(n: number): number {
    return Math.ceil(n / this.batchSize);
  }

  async classify(texts: string[]): Promise<MemoryJudgement[]> {
    const out: MemoryJudgement[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      out.push(...(await this.classifyBatch(batch)));
    }
    return out;
  }

  private async classifyBatch(batch: string[]): Promise<MemoryJudgement[]> {
    try {
      const user = batch
        .map((t, i) => `${i}: ${t.replace(/\s+/g, ' ').slice(0, 400)}`)
        .join('\n');
      const res = await llmComplete(this.call, RECLASSIFY_SYSTEM, user);
      const arr = parseJsonArray(res);
      const byIndex = new Map<number, MemoryJudgement>();
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const i = (item as { i?: unknown }).i;
        if (typeof i !== 'number') continue;
        const keep = (item as { keep?: unknown }).keep;
        byIndex.set(i, {
          drop: keep === false,
          kind: coerceKind((item as { kind?: unknown }).kind),
        });
      }
      // Fill any gaps from the heuristic so the result always aligns 1:1.
      const fb = await this.fallback.classify(batch);
      return batch.map((_, i) => byIndex.get(i) ?? fb[i]!);
    } catch (err) {
      console.error(
        `[thinktank] LLM reclassify failed (${String(err)}); using heuristic.`,
      );
      return this.fallback.classify(batch);
    }
  }
}

/** Choose a classifier (LLM when a key exists, else heuristic). */
export function pickClassifier(env: NodeJS.ProcessEnv = process.env): Classifier {
  const model = env.THINKTANK_EXTRACT_MODEL?.trim() || undefined;
  if (env.ANTHROPIC_API_KEY) {
    return new LLMClassifier({
      provider: 'anthropic',
      apiKey: env.ANTHROPIC_API_KEY,
      model,
    });
  }
  if (env.OPENAI_API_KEY) {
    return new LLMClassifier({
      provider: 'openai',
      apiKey: env.OPENAI_API_KEY,
      model,
    });
  }
  return new HeuristicClassifier();
}
