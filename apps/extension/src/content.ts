// Content script injected into ChatGPT and Claude.ai. It:
//   1. injects a floating "Import to memory" button,
//   2. scrapes the open conversation on click and ships it to thinktank
//      (via the background worker, never directly),
//   3. responds to popup commands (import current / import all history).
//
// We use a floating action button rather than splicing into the site's own
// toolbar so a single CSS change on their side can't hide our entry point.

import {
  type BgMessage,
  type CapturePayload,
  type IngestResponse,
  type Site,
  type TabMessage,
  type Turn,
} from './common';
import { scrapeChatGPT, chatGPTHistoryLinks } from './scrape-chatgpt';
import { scrapeClaude, claudeHistoryLinks } from './scrape-claude';
import { sleep, uniq } from './scrape-util';

function detectSite(): Site | null {
  const h = location.hostname;
  if (h.includes('chatgpt.com') || h.includes('openai.com')) return 'chatgpt';
  if (h.includes('claude.ai')) return 'claude';
  return null;
}

const SITE = detectSite();

function scrapeCurrent(): Turn[] {
  if (SITE === 'chatgpt') return scrapeChatGPT();
  if (SITE === 'claude') return scrapeClaude();
  return [];
}

function historyLinks(): string[] {
  const els =
    SITE === 'chatgpt'
      ? chatGPTHistoryLinks()
      : SITE === 'claude'
        ? claudeHistoryLinks()
        : [];
  return uniq(els.map((a) => a.href).filter(Boolean));
}

function buildPayload(turns: Turn[]): CapturePayload {
  return {
    source: SITE as Site,
    tool: SITE === 'chatgpt' ? 'chatgpt-web' : 'claude-web',
    title: document.title,
    url: location.href,
    conversation: turns,
  };
}

function sendToBackground(msg: BgMessage): Promise<IngestResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp: IngestResponse | undefined) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp ?? { ok: false, error: 'no response' });
    });
  });
}

/** Capture and ingest the currently-open chat. Returns the response. */
async function ingestCurrent(): Promise<IngestResponse> {
  const turns = scrapeCurrent();
  if (turns.length === 0) {
    toast('No messages found on this chat.', 'warn');
    return { ok: false, error: 'empty' };
  }
  const resp = await sendToBackground({ type: 'ingest', payload: buildPayload(turns) });
  if (resp.ok) {
    toast(
      `Imported ${turns.length} turns -> +${resp.inserted ?? 0} new, ${resp.deduped ?? 0} merged`,
      'ok',
    );
  } else if (resp.error === 'unreachable') {
    toast('thinktank is not running. Start it with: thinktank serve --http', 'err');
  } else {
    toast(`Import failed: ${resp.error ?? 'unknown error'}`, 'err');
  }
  return resp;
}

// --- best-effort "import all history" --------------------------------------
// We walk the visible sidebar links, navigate to each via the SPA router (so
// the page never fully reloads and this content script survives), wait for the
// conversation to settle, scrape, and ingest. This is intentionally gentle
// (delays between chats) and is explicitly best-effort: the sidebar may lazy
// load, reorder, or virtualize, and a UI change can break it. The reliable,
// complete path is the export-file import (`thinktank ingest conversations.json`).

async function waitForConversation(timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  let lastCount = -1;
  let stableFor = 0;
  while (Date.now() - start < timeoutMs) {
    const count = scrapeCurrent().length;
    if (count > 0 && count === lastCount) {
      stableFor += 1;
      if (stableFor >= 2) return true; // count held steady across polls
    } else {
      stableFor = 0;
    }
    lastCount = count;
    await sleep(350);
  }
  return scrapeCurrent().length > 0;
}

async function importAll(): Promise<void> {
  const links = historyLinks();
  if (links.length === 0) {
    toast('No chats found in the sidebar to import.', 'warn');
    return;
  }
  let done = 0;
  let inserted = 0;
  for (const href of links) {
    // Re-find the anchor each iteration; the sidebar re-renders on navigation.
    const anchor =
      document.querySelector<HTMLAnchorElement>(`a[href="${new URL(href).pathname}"]`) ??
      document.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
    if (anchor) {
      anchor.click();
    } else {
      // Fall back to SPA history navigation if the element is gone.
      history.pushState({}, '', href);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    await sleep(600);
    await waitForConversation();
    const resp = await ingestCurrentQuietly();
    if (resp.ok) inserted += resp.inserted ?? 0;
    done += 1;
    toast(`Importing all: ${done}/${links.length} (+${inserted} new)`, 'ok', 1500);
    await sleep(800); // be gentle; avoid hammering the site
  }
  toast(`Done. Imported ${done} chats, +${inserted} new memories.`, 'ok', 4000);
}

/** Like ingestCurrent but without its own success toast (caller shows progress). */
async function ingestCurrentQuietly(): Promise<IngestResponse> {
  const turns = scrapeCurrent();
  if (turns.length === 0) return { ok: false, error: 'empty' };
  return sendToBackground({ type: 'ingest', payload: buildPayload(turns) });
}

// --- UI: floating button + toast -------------------------------------------

const STYLE_ID = 'thinktank-style';
function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #thinktank-fab {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
      display: inline-flex; align-items: center; gap: 8px;
      padding: 10px 14px; border: none; border-radius: 9999px; cursor: pointer;
      background: #14b8a6; color: #fff; font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,.25); transition: transform .12s ease, opacity .12s ease;
    }
    #thinktank-fab:hover { transform: translateY(-1px); }
    #thinktank-fab:active { transform: translateY(0); opacity: .9; }
    #thinktank-fab[disabled] { opacity: .6; cursor: progress; }
    #thinktank-fab .tt-dot { width: 8px; height: 8px; border-radius: 50%; background: #d1fae5; }
    #thinktank-toast {
      position: fixed; right: 20px; bottom: 72px; z-index: 2147483647;
      max-width: 320px; padding: 10px 14px; border-radius: 10px;
      font: 500 13px/1.4 ui-sans-serif, system-ui, sans-serif; color: #fff;
      box-shadow: 0 4px 16px rgba(0,0,0,.25); opacity: 0; transform: translateY(6px);
      transition: opacity .15s ease, transform .15s ease; pointer-events: none;
    }
    #thinktank-toast.show { opacity: 1; transform: translateY(0); }
    #thinktank-toast.ok { background: #0f766e; }
    #thinktank-toast.warn { background: #b45309; }
    #thinktank-toast.err { background: #b91c1c; }
  `;
  document.documentElement.appendChild(style);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string, kind: 'ok' | 'warn' | 'err', ms = 3000): void {
  injectStyles();
  let el = document.getElementById('thinktank-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'thinktank-toast';
    document.body.appendChild(el);
  }
  el.className = '';
  el.classList.add(kind);
  el.textContent = message;
  // force reflow so the transition replays
  void el.offsetWidth;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el?.classList.remove('show'), ms);
}

function injectFab(): void {
  if (document.getElementById('thinktank-fab')) return;
  injectStyles();
  const btn = document.createElement('button');
  btn.id = 'thinktank-fab';
  btn.type = 'button';
  btn.innerHTML = '<span class="tt-dot"></span><span>Import to memory</span>';
  btn.addEventListener('click', async () => {
    btn.setAttribute('disabled', 'true');
    try {
      await ingestCurrent();
    } finally {
      btn.removeAttribute('disabled');
    }
  });
  document.body.appendChild(btn);
}

// --- popup command channel --------------------------------------------------
chrome.runtime.onMessage.addListener((msg: TabMessage, _sender, sendResponse) => {
  if (msg.type === 'popup:importCurrent') {
    ingestCurrent().then(sendResponse);
    return true;
  }
  if (msg.type === 'popup:importAll') {
    importAll().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// --- boot -------------------------------------------------------------------
if (SITE) {
  const boot = () => injectFab();
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
  // SPA route changes can wipe our node; re-inject periodically (cheap, idempotent).
  setInterval(() => {
    if (SITE && !document.getElementById('thinktank-fab')) injectFab();
  }, 2000);
}
