import type { MemoryEvent } from '@thinktank/core';
import type { ParseOptions, ParseResult, ParsedConversation } from './types.js';

// --------------------------------------------------------------------------
// Claude.ai data export ("conversations.json").
//
// Shape (the parts we rely on):
//   [ {
//       uuid: string,
//       name: string,
//       created_at: string,             // ISO 8601
//       updated_at: string,
//       chat_messages: [ {
//         uuid: string,
//         sender: 'human' | 'assistant',
//         text?: string,                // legacy / convenience flattened text
//         content?: [ { type: 'text', text: string }, { type: 'tool_use', ... }, ... ],
//         created_at: string,           // ISO 8601
//         attachments?: [...],
//         files?: [...],
//       }, ... ]
//   }, ... ]
//
// Defensive throughout: nulls, missing text, tool_use/structured content
// blocks, and attachments are all handled (text extracted, the rest ignored).
// --------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Claude timestamps are ISO strings; convert to epoch ms. */
function isoToMs(v: unknown): number | null {
  const s = asString(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * Extract plain text from a Claude message. Prefers a structured `content`
 * array (joining `type: 'text'` blocks) and falls back to the flattened `text`
 * field, then appends any server-extracted attachment text
 * (`attachments[].extracted_content`, e.g. uploaded PDFs/docs/code). Tool calls
 * and thinking blocks are skipped.
 */
function messageText(message: Record<string, unknown>): string {
  const parts: string[] = [];

  // Body text: structured content array (preferred), else flattened `text`.
  const content = message['content'];
  let body = '';
  if (Array.isArray(content)) {
    const pieces: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      const type = asString(block['type']);
      if (type && type !== 'text') continue; // skip tool_use, thinking, etc.
      const t = asString(block['text']);
      if (t && t.trim()) pieces.push(t);
    }
    body = pieces.join('\n').trim();
  }
  if (!body) body = (asString(message['text']) ?? '').trim();
  if (body) parts.push(body);

  // Attachment text extracted by Claude (uploaded files). This rescues messages
  // whose only content was an attachment, and enriches ones that had both.
  const attachments = message['attachments'];
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (!isRecord(att)) continue;
      const extracted = asString(att['extracted_content']);
      if (extracted && extracted.trim()) parts.push(extracted.trim());
    }
  }

  return parts.join('\n').trim();
}

function mapRole(sender: string | null): MemoryEvent['role'] {
  if (sender === 'human') return 'user';
  if (sender === 'assistant') return 'assistant';
  return (sender ?? undefined) as MemoryEvent['role'];
}

const KEEP_SENDERS = new Set(['human', 'assistant']);

/** Parse a single Claude conversation object into a ParsedConversation. */
function parseConversation(
  convo: Record<string, unknown>,
  opts: ParseOptions,
): ParsedConversation {
  // Fall back to the conversation `summary` when it has no `name` (recall).
  const title = asString(convo['name']) || asString(convo['summary']) || null;
  const createdAt = isoToMs(convo['created_at']);
  const messages = Array.isArray(convo['chat_messages']) ? convo['chat_messages'] : [];

  const project = opts.project ?? title ?? undefined;
  const events: MemoryEvent[] = [];

  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    const sender = asString(raw['sender']);
    if (!sender || !KEEP_SENDERS.has(sender)) continue;

    const text = messageText(raw);
    if (!text) continue;

    const ts = isoToMs(raw['created_at']) ?? createdAt ?? Date.now();
    if (opts.since != null && ts < opts.since) continue;

    events.push({
      source: 'claude',
      tool: 'claude-web',
      ts,
      project,
      role: mapRole(sender),
      text,
    });
  }

  return { title, createdAt, events };
}

/** Normalize the top-level export into an array of conversation records. */
function conversationList(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) {
    return json.filter(isRecord);
  }
  if (isRecord(json)) {
    if (Array.isArray(json['conversations'])) {
      return json['conversations'].filter(isRecord);
    }
    if (Array.isArray(json['chat_messages'])) return [json];
  }
  return [];
}

/** Parse a Claude.ai data export into MemoryEvents. */
export function parseClaudeExport(json: unknown, opts: ParseOptions = {}): ParseResult {
  let convos = conversationList(json);
  const conversationsFound = convos.length;

  if (opts.maxConversations != null) {
    convos = [...convos]
      .sort((a, b) => (isoToMs(b['created_at']) ?? 0) - (isoToMs(a['created_at']) ?? 0))
      .slice(0, opts.maxConversations);
  }

  const conversations = convos.map((c) => parseConversation(c, opts));
  const events = conversations.flatMap((c) => c.events);

  return {
    source: 'claude',
    format: 'claude',
    conversationsFound,
    conversations,
    events,
  };
}
