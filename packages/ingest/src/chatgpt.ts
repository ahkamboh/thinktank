import type { MemoryEvent } from '@thinktank/core';
import type { ParseOptions, ParseResult, ParsedConversation } from './types.js';

// --------------------------------------------------------------------------
// ChatGPT data export ("conversations.json").
//
// Shape (the parts we rely on):
//   [ {
//       title: string,
//       create_time: number,            // epoch SECONDS (float)
//       update_time: number,
//       current_node: string,           // id of the leaf of the active branch
//       mapping: {
//         "<id>": {
//           id: string,
//           parent: string | null,
//           children: string[],
//           message: null | {
//             author: { role: 'system'|'user'|'assistant'|'tool', ... },
//             create_time: number | null,
//             content: { content_type: 'text'|'code'|'multimodal_text'|..., parts?: ... , text?: string },
//             metadata: { is_visually_hidden_from_conversation?: boolean, ... },
//             ...
//           }
//         }, ...
//       }
//   }, ... ]
//
// We reconstruct the *active* linear thread (current_node up to root, reversed)
// rather than the full branch tree, so we capture the conversation the user
// actually kept. Everything here is defensive: real exports contain nulls,
// hidden system primers, tool calls, and multimodal content arrays.
// --------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** ChatGPT create_time is epoch seconds (float); convert to ms. */
function secondsToMs(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) : null;
}

/**
 * Pull plain text out of a ChatGPT `content` object across its content types.
 * Images / audio / non-text parts are ignored (we only remember text).
 */
function extractText(content: unknown): string {
  if (!isRecord(content)) return '';
  const parts = content['parts'];
  const pieces: string[] = [];

  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (typeof part === 'string') {
        if (part.trim()) pieces.push(part);
      } else if (isRecord(part)) {
        // multimodal_text: { content_type: 'text', text: '...' } and friends.
        const t = asString(part['text']);
        if (t && t.trim()) pieces.push(t);
      }
      // Non-string, non-record parts (e.g. image pointers) are skipped.
    }
  }

  // 'code' / 'execution_output' style content carries a top-level `text`.
  const topText = asString(content['text']);
  if (topText && topText.trim()) pieces.push(topText);

  return pieces.join('\n').trim();
}

interface MappingNode {
  id: string;
  parent: string | null;
  message: Record<string, unknown> | null;
}

/**
 * Walk the mapping tree to produce the ordered node ids of the active thread.
 * Primary: from `current_node` up via `parent` to the root, then reverse.
 * Fallback: from the root down, following the first child at each step.
 */
function orderedNodeIds(
  mapping: Record<string, unknown>,
  currentNode: string | null,
): string[] {
  const node = (id: string | null): MappingNode | null => {
    if (!id) return null;
    const raw = mapping[id];
    if (!isRecord(raw)) return null;
    return {
      id,
      parent: asString(raw['parent']),
      message: isRecord(raw['message']) ? raw['message'] : null,
    };
  };

  if (currentNode && isRecord(mapping[currentNode])) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = currentNode;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = node(cur)?.parent ?? null;
    }
    return chain.reverse();
  }

  // Fallback: find a root (no parent / parent not in mapping) and descend.
  let rootId: string | null = null;
  for (const [id, raw] of Object.entries(mapping)) {
    if (!isRecord(raw)) continue;
    const parent = asString(raw['parent']);
    if (!parent || !isRecord(mapping[parent])) {
      rootId = id;
      break;
    }
  }
  const order: string[] = [];
  const seen = new Set<string>();
  let cur = rootId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    order.push(cur);
    const raw = mapping[cur];
    const children = isRecord(raw) ? raw['children'] : null;
    cur = Array.isArray(children) ? (asString(children[0]) ?? null) : null;
  }
  return order;
}

const KEEP_ROLES = new Set(['user', 'assistant']);

/** Parse a single ChatGPT conversation object into a ParsedConversation. */
function parseConversation(
  convo: Record<string, unknown>,
  opts: ParseOptions,
): ParsedConversation {
  const title = asString(convo['title']);
  const createdAt = secondsToMs(convo['create_time']);
  const mapping = isRecord(convo['mapping']) ? convo['mapping'] : {};
  const currentNode = asString(convo['current_node']);
  const order = orderedNodeIds(mapping, currentNode);

  const project = opts.project ?? title ?? undefined;
  const events: MemoryEvent[] = [];

  for (const id of order) {
    const raw = mapping[id];
    if (!isRecord(raw)) continue;
    const message = raw['message'];
    if (!isRecord(message)) continue; // root / placeholder nodes

    const author = isRecord(message['author']) ? message['author'] : {};
    const role = asString(author['role']) ?? '';
    if (!KEEP_ROLES.has(role)) continue; // drop system + tool turns

    const meta = isRecord(message['metadata']) ? message['metadata'] : {};
    if (meta['is_visually_hidden_from_conversation'] === true) continue;

    const text = extractText(message['content']);
    if (!text) continue;

    const ts =
      secondsToMs(message['create_time']) ?? createdAt ?? Date.now();
    if (opts.since != null && ts < opts.since) continue;

    events.push({
      source: 'chatgpt',
      tool: 'chatgpt-web',
      model: asString(meta['model_slug']) ?? undefined,
      ts,
      project,
      role: role as MemoryEvent['role'],
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
    // Some exports wrap conversations; a single conversation has `mapping`.
    if (Array.isArray(json['conversations'])) {
      return json['conversations'].filter(isRecord);
    }
    if (isRecord(json['mapping'])) return [json];
  }
  return [];
}

/** Parse a ChatGPT data export into MemoryEvents. */
export function parseChatGPTExport(json: unknown, opts: ParseOptions = {}): ParseResult {
  let convos = conversationList(json);
  const conversationsFound = convos.length;

  if (opts.maxConversations != null) {
    convos = [...convos]
      .sort(
        (a, b) =>
          (secondsToMs(b['create_time']) ?? 0) - (secondsToMs(a['create_time']) ?? 0),
      )
      .slice(0, opts.maxConversations);
  }

  const conversations = convos.map((c) => parseConversation(c, opts));
  const events = conversations.flatMap((c) => c.events);

  return {
    source: 'chatgpt',
    format: 'chatgpt',
    conversationsFound,
    conversations,
    events,
  };
}
