import type { MemoryKind } from './types.js';

/**
 * Base importance per memory kind. Decisions/constraints are the most valuable
 * things to recall; transient `state` matters least.
 */
export const KIND_BASE: Record<MemoryKind, number> = {
  decision: 1.0,
  constraint: 0.9,
  preference: 0.7,
  fact: 0.6,
  code: 0.5,
  state: 0.4,
};

/** How quickly recency stops mattering. ~30 days to halve the recency boost. */
export const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Stored-at-write importance: kind weight plus a sub-linear bump for how many
 * times the memory has been re-observed. Repeated observations across tools
 * are a strong signal a memory is real and durable.
 */
export function baseImportance(kind: MemoryKind, seenCount: number): number {
  const base = KIND_BASE[kind] ?? 0.5;
  return base + Math.log1p(Math.max(0, seenCount - 1));
}

/**
 * Recency boost in [0, 1] using exponential decay from `lastSeen`. Computed at
 * read time so it always reflects "now" without rewriting rows.
 */
export function recencyBoost(
  lastSeen: number,
  now: number = Date.now(),
  halfLifeMs: number = RECENCY_HALF_LIFE_MS,
): number {
  const age = Math.max(0, now - lastSeen);
  return Math.pow(0.5, age / halfLifeMs);
}

/**
 * Read-time importance: stored base importance plus a recency component.
 * Used as a soft tiebreaker on top of relevance during retrieval.
 */
export function dynamicImportance(
  baseImp: number,
  lastSeen: number,
  now: number = Date.now(),
): number {
  return baseImp + recencyBoost(lastSeen, now);
}
