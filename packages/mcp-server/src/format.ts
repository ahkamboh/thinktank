import type { Memory } from '@thinktank/core';

/** Default retrieval token budget for resume/search responses. */
export const DEFAULT_TOKEN_BUDGET = 600;

/** The newest memories always lead a resume, whatever their kind. */
export const RESUME_NEWEST_SLOTS = 4;

/**
 * Resume lines show at most this much of each memory (a whole note can be up
 * to 2k chars); memory_search returns the full text.
 */
export const RESUME_LINE_MAX_CHARS = 280;

/**
 * Rough token estimate. We deliberately avoid a tokenizer dependency; ~4 chars
 * per token is close enough for budgeting a small recall payload, and erring
 * slightly high keeps us under real model limits.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface LineOptions {
  /** Clip the memory text to this many chars (whitespace collapsed). */
  maxChars?: number;
  /** Append the memory's project, for results pulled from other projects. */
  showProject?: boolean;
}

/** One compact, model-friendly line for a memory, including provenance. */
export function formatMemoryLine(m: Memory, opts: LineOptions = {}): string {
  const tools = Array.from(
    new Set(m.sources.map((s) => s.tool || s.source).filter(Boolean)),
  );
  const via = tools.length ? ` (via ${tools.join(', ')})` : '';
  const seen = m.seenCount > 1 ? ` x${m.seenCount}` : '';
  const where = opts.showProject && m.project ? ` [project: ${m.project}]` : '';
  let body = m.text;
  if (opts.maxChars && body.length > opts.maxChars) {
    body = `${body.replace(/\s+/g, ' ').slice(0, opts.maxChars - 1).trimEnd()}…`;
  }
  return `- [${m.kind}] ${body}${via}${seen}${where}`;
}

/**
 * Pack memories into a token budget in order, skipping any that don't fit so
 * one long note can't crowd out the shorter ones after it. Always keeps at
 * least one, so a non-empty result never comes back empty purely due to a
 * tiny budget.
 */
export function packToBudget(
  memories: Memory[],
  budget: number = DEFAULT_TOKEN_BUDGET,
  opts: LineOptions = {},
  keepOne = true,
): Memory[] {
  const out: Memory[] = [];
  let used = 0;
  for (const m of memories) {
    const cost = estimateTokens(formatMemoryLine(m, opts));
    if (used + cost > budget && (out.length > 0 || !keepOne)) continue;
    out.push(m);
    used += cost;
  }
  return out;
}

/** Standing rules come right after the newest work; then decisions; then the rest. */
function resumeTier(m: Memory): number {
  if (m.kind === 'constraint' || m.kind === 'preference') return 0;
  if (m.kind === 'decision') return 1;
  return 2;
}

/**
 * Order a resume pool recency-first, kind second: the RESUME_NEWEST_SLOTS
 * newest memories lead (so the latest work is never dropped), then
 * constraints/preferences, then decisions, then everything else - each group
 * newest first.
 */
export function rankForResume(memories: Memory[]): Memory[] {
  const byRecency = [...memories].sort(
    (a, b) => b.lastSeen - a.lastSeen || b.id - a.id,
  );
  const newest = byRecency.slice(0, RESUME_NEWEST_SLOTS);
  const rest = byRecency
    .slice(RESUME_NEWEST_SLOTS)
    .sort((a, b) => resumeTier(a) - resumeTier(b)); // stable: keeps recency within a tier
  return [...newest, ...rest];
}

/** Render a list of memories as a budgeted bullet block (or a friendly empty). */
export function renderMemories(
  memories: Memory[],
  budget: number = DEFAULT_TOKEN_BUDGET,
  opts: LineOptions = {},
): string {
  const packed = packToBudget(memories, budget, opts);
  if (packed.length === 0) return 'No matching memories yet.';
  return packed.map((m) => formatMemoryLine(m, opts)).join('\n');
}

/**
 * Render scoped memories, then (with whatever budget is left) related ones
 * from other projects under their own heading. Returns '' if both are empty.
 */
export function renderWithRelated(
  scoped: Memory[],
  related: Memory[],
  budget: number = DEFAULT_TOKEN_BUDGET,
  opts: LineOptions = {},
): string {
  const lines: string[] = [];
  const packed = packToBudget(scoped, budget, opts);
  lines.push(...packed.map((m) => formatMemoryLine(m, opts)));
  const used = estimateTokens(lines.join('\n'));
  const relOpts = { ...opts, showProject: true };
  // Related items only use budget the scoped ones left over.
  const rel = packToBudget(related, budget - used, relOpts, packed.length === 0);
  if (rel.length > 0) {
    lines.push('Possibly related, from other projects:');
    lines.push(...rel.map((m) => formatMemoryLine(m, relOpts)));
  }
  return lines.join('\n');
}
