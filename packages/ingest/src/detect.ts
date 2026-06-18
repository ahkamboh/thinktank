import type { ExportFormat, ParseOptions, ParseResult } from './types.js';
import { parseChatGPTExport } from './chatgpt.js';
import { parseClaudeExport } from './claude.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** First conversation-like record from either the array or a wrapper object. */
function firstConversation(json: unknown): Record<string, unknown> | null {
  if (Array.isArray(json)) {
    return json.find(isRecord) ?? null;
  }
  if (isRecord(json)) {
    if (Array.isArray(json['conversations'])) {
      return json['conversations'].find(isRecord) ?? null;
    }
    // The wrapper itself might be a single conversation.
    if (isRecord(json['mapping']) || Array.isArray(json['chat_messages'])) {
      return json;
    }
  }
  return null;
}

/**
 * Sniff which export a payload is by structural fingerprint:
 *   - a `mapping` object  => ChatGPT (its message tree)
 *   - a `chat_messages` array => Claude.ai
 * Returns null if neither shape is recognized.
 */
export function detectFormat(json: unknown): ExportFormat | null {
  const convo = firstConversation(json);
  if (!convo) return null;
  if (isRecord(convo['mapping'])) return 'chatgpt';
  if (Array.isArray(convo['chat_messages'])) return 'claude';
  return null;
}

export class UnknownExportError extends Error {
  constructor() {
    super(
      'Unrecognized export format: expected a ChatGPT export (conversations with a `mapping` tree) ' +
        'or a Claude.ai export (conversations with a `chat_messages` array).',
    );
    this.name = 'UnknownExportError';
  }
}

/**
 * Parse an export payload, auto-detecting the source unless `format` forces it.
 * Throws {@link UnknownExportError} when the shape matches no known export.
 */
export function parseExport(
  json: unknown,
  opts: ParseOptions & { format?: ExportFormat } = {},
): ParseResult {
  const format = opts.format ?? detectFormat(json);
  if (format === 'chatgpt') return parseChatGPTExport(json, opts);
  if (format === 'claude') return parseClaudeExport(json, opts);
  throw new UnknownExportError();
}
