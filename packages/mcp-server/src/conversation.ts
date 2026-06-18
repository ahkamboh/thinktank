import type { IngestResult, MemoryEvent, MemorySource } from '@thinktank/core';
import { getBrain } from './store.js';

/** One captured chat turn as posted by the browser extension. */
export interface CapturedTurn {
  role?: string;
  text?: string;
  content?: string;
  ts?: number;
  createdAt?: number;
}

/**
 * The /ingest request body. Either a bare array of turns or an object with a
 * `conversation`/`messages` array plus optional metadata captured from the page.
 */
export interface CapturedConversation {
  source?: string;
  tool?: string;
  model?: string;
  project?: string;
  title?: string;
  url?: string;
  conversation?: CapturedTurn[];
  messages?: CapturedTurn[];
}

export type IngestBody = CapturedConversation | CapturedTurn[];

export interface IngestSummary {
  turns: number;
  inserted: number;
  deduped: number;
  superseded: number;
}

function turnText(t: CapturedTurn): string {
  return (t.text ?? t.content ?? '').trim();
}

function turnTs(t: CapturedTurn, fallback: number): number {
  return t.ts ?? t.createdAt ?? fallback;
}

/** Best-effort source inference from a tool/url label when none is given. */
function inferSource(meta: CapturedConversation): MemorySource {
  const hay = `${meta.source ?? ''} ${meta.tool ?? ''} ${meta.url ?? ''}`.toLowerCase();
  if (meta.source) return meta.source;
  if (hay.includes('chatgpt') || hay.includes('openai')) return 'chatgpt';
  if (hay.includes('claude')) return 'claude';
  return 'web';
}

/**
 * Normalize a captured conversation into MemoryEvents and run each through the
 * merge engine. User + assistant turns are both ingested (decisions can live in
 * either); empty/system turns are skipped.
 */
export async function ingestConversation(body: IngestBody): Promise<IngestSummary> {
  const meta: CapturedConversation = Array.isArray(body) ? { conversation: body } : body;
  const turns = meta.conversation ?? meta.messages ?? [];
  const source = inferSource(meta);
  const now = Date.now();

  const { engine } = getBrain();
  const summary: IngestSummary = { turns: 0, inserted: 0, deduped: 0, superseded: 0 };

  for (const turn of turns) {
    const content = turnText(turn);
    if (!content || content.length < 15) continue;
    if (turn.role === 'system') continue;

    const event: MemoryEvent = {
      source,
      tool: meta.tool,
      model: meta.model,
      ts: turnTs(turn, now),
      project: meta.project,
      role: turn.role,
      text: content,
    };
    const results: IngestResult[] = await engine.ingest(event);
    summary.turns += 1;
    for (const r of results) {
      if (r.action === 'inserted') summary.inserted += 1;
      else if (r.action === 'deduped') summary.deduped += 1;
      else summary.superseded += 1;
    }
  }

  return summary;
}
