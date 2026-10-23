// Background service worker. It owns ALL network I/O so that content scripts
// (which run under the host page's strict CSP) never get their localhost call
// blocked. It only ever talks to 127.0.0.1 - there is no remote endpoint
// anywhere in this extension.

import {
  getConfig,
  baseUrl,
  START_COMMAND_KEY,
  type BgMessage,
  type IngestResponse,
} from './common';

/**
 * Ask the server how it was started and remember it, so a later "not running"
 * message can show a command that works from any folder.
 */
async function checkHealth(port: number): Promise<boolean> {
  const r = await fetch(`${baseUrl(port)}/health`, { method: 'GET' });
  if (r.ok) {
    const body = (await r.json().catch(() => ({}))) as { startCommand?: unknown };
    if (typeof body.startCommand === 'string' && body.startCommand) {
      await chrome.storage.local.set({ [START_COMMAND_KEY]: body.startCommand });
    }
  }
  return r.ok;
}

async function handle(msg: BgMessage): Promise<IngestResponse> {
  const cfg = await getConfig();

  if (msg.type === 'health') {
    try {
      return { ok: await checkHealth(cfg.port) };
    } catch {
      return { ok: false, error: 'unreachable' };
    }
  }

  // ingest
  const payload = {
    ...msg.payload,
    project: msg.payload.project || cfg.project,
  };
  try {
    const r = await fetch(`${baseUrl(cfg.port)}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = (await r.json().catch(() => ({}))) as Partial<IngestResponse>;
    if (r.ok) void checkHealth(cfg.port).catch(() => {});
    return { ok: r.ok, ...json };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
}

chrome.runtime.onMessage.addListener((msg: BgMessage, _sender, sendResponse) => {
  handle(msg).then(sendResponse);
  return true; // keep the message channel open for the async response
});
