import type { MemoryEvent, MemorySource } from '@thinktank/core';

/** Which official export a payload came from. */
export type ExportFormat = 'chatgpt' | 'claude';

/** Options shared by every export parser. */
export interface ParseOptions {
  /**
   * Project/repo to scope the imported memories under. If omitted, each parser
   * falls back to the conversation's own title/name so memories stay grouped
   * per source conversation.
   */
  project?: string;
  /**
   * Only import turns at/after this epoch-ms timestamp (lets a re-import skip
   * already-seen history). Applied after timestamps are normalized to ms.
   */
  since?: number;
  /**
   * Cap on conversations to parse (newest-first by create time). Useful for
   * smoke-testing a giant export without ingesting everything.
   */
  maxConversations?: number;
}

/** One reconstructed conversation from an export. */
export interface ParsedConversation {
  /** Conversation title/name, when the export provides one. */
  title: string | null;
  /** Conversation create time in epoch ms, when known. */
  createdAt: number | null;
  /** Ordered, cleaned turns ready for the merge engine. */
  events: MemoryEvent[];
}

/** Result of parsing a whole export file. */
export interface ParseResult {
  source: MemorySource;
  format: ExportFormat;
  /** Number of conversations found (before any maxConversations cap). */
  conversationsFound: number;
  /** Conversations actually parsed (after the cap). */
  conversations: ParsedConversation[];
  /** Flattened, ordered events across all parsed conversations. */
  events: MemoryEvent[];
}
