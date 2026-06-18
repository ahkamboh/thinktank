import type { Turn } from './common';
import { cleanText } from './scrape-util';

/**
 * Scrape the currently-open ChatGPT conversation into ordered turns.
 *
 * DOM signal: every message bubble carries `[data-message-author-role]` with a
 * value of "user" | "assistant" | "system" | "tool". This attribute has been
 * stable across many ChatGPT UI revisions and is the most reliable anchor we
 * have (far better than hashed class names). Document order == chat order.
 *
 * Fragility: if OpenAI renames/removes this attribute, scraping returns [] and
 * the user sees "No messages found"; the export-file import path (P4) is the
 * guaranteed fallback.
 */
export function scrapeChatGPT(): Turn[] {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>('[data-message-author-role]'),
  );
  const turns: Turn[] = [];
  for (const el of nodes) {
    const role = el.getAttribute('data-message-author-role');
    if (role !== 'user' && role !== 'assistant') continue; // drop system/tool
    const text = cleanText(el);
    if (text) turns.push({ role, text });
  }
  return turns;
}

/** Conversation links in the left sidebar, for best-effort "import all". */
export function chatGPTHistoryLinks(): HTMLAnchorElement[] {
  return Array.from(
    document.querySelectorAll<HTMLAnchorElement>('nav a[href^="/c/"]'),
  );
}
