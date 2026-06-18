import { dynamicImportance } from '@thinktank/core';
import type { Memory } from '@thinktank/core';

/** Default retrieval token budget for resume/search responses. */
export const DEFAULT_TOKEN_BUDGET = 600;

/**
 * Rough token estimate. We deliberately avoid a tokenizer dependency; ~4 chars
 * per token is close enough for budgeting a small recall payload, and erring
 * slightly high keeps us under real model limits.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** One compact, model-friendly line for a memory, including provenance. */
export function formatMemoryLine(m: Memory): string {
  const tools = Array.from(
    new Set(m.sources.map((s) => s.tool || s.source).filter(Boolean)),
  );
  const via = tools.length ? ` (via ${tools.join(', ')})` : '';
  const seen = m.seenCount > 1 ? ` x${m.seenCount}` : '';
  return `- [${m.kind}] ${m.text}${via}${seen}`;
}

/**
 * Greedily pack memories into a token budget, always keeping at least one so a
 * non-empty result never comes back empty purely due to a tiny budget.
 */
export function packToBudget(
  memories: Memory[],
  budget: number = DEFAULT_TOKEN_BUDGET,
): Memory[] {
  const out: Memory[] = [];
  let used = 0;
  for (const m of memories) {
    const cost = estimateTokens(formatMemoryLine(m));
    if (used + cost > budget && out.length > 0) break;
    out.push(m);
    used += cost;
  }
  return out;
}

/** Rank active memories for a context-free "resume" by importance + recency. */
export function rankForResume(memories: Memory[], now: number = Date.now()): Memory[] {
  return [...memories].sort(
    (a, b) =>
      dynamicImportance(b.importance, b.lastSeen, now) -
      dynamicImportance(a.importance, a.lastSeen, now),
  );
}

/** Render a list of memories as a budgeted bullet block (or a friendly empty). */
export function renderMemories(
  memories: Memory[],
  budget: number = DEFAULT_TOKEN_BUDGET,
): string {
  const packed = packToBudget(memories, budget);
  if (packed.length === 0) return 'No matching memories yet.';
  return packed.map(formatMemoryLine).join('\n');
}
