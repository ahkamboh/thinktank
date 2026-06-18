import type { Turn } from './common';
import { cleanText } from './scrape-util';

const USER_SEL = '[data-testid="user-message"]';
// Assistant turns render inside a container with this class. Claude's markup is
// less attribute-driven than ChatGPT's, so this is the most stable hook today.
const ASSISTANT_SEL = '.font-claude-message';

/**
 * Scrape the currently-open Claude.ai conversation into ordered turns.
 *
 * DOM signal: user messages carry `[data-testid="user-message"]`; assistant
 * messages render inside `.font-claude-message`. We query both with a single
 * combined selector so querySelectorAll preserves document (chat) order, then
 * label each by which selector it matched.
 *
 * Fragility: Claude changes its DOM more often than ChatGPT and uses few stable
 * attributes, so this is the more brittle of the two scrapers. On a miss it
 * returns [] and the user falls back to export-file import (P4).
 */
export function scrapeClaude(): Turn[] {
  const els = Array.from(
    document.querySelectorAll<HTMLElement>(`${USER_SEL}, ${ASSISTANT_SEL}`),
  );
  const turns: Turn[] = [];
  for (const el of els) {
    // A user bubble can technically nest an assistant-styled child; decide role
    // by the closest matching ancestor to avoid double counting.
    const isUser = el.matches(USER_SEL) || !!el.closest(USER_SEL);
    const role: Turn['role'] = isUser ? 'user' : 'assistant';
    const text = cleanText(el);
    if (text) turns.push({ role, text });
  }
  return turns;
}

/** Conversation links in the sidebar, for best-effort "import all". */
export function claudeHistoryLinks(): HTMLAnchorElement[] {
  return Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/chat/"]'),
  );
}
