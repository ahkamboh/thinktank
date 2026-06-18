// Background service worker. It owns ALL network I/O so that content scripts
// (which run under the host page's strict CSP) never get their localhost call
// blocked. It only ever talks to 127.0.0.1 - there is no remote endpoint
// anywhere in this extension.

import { getConfig, baseUrl, type BgMessage, type IngestResponse } from './common';

async function handle(msg: BgMessage): Promise<IngestResponse> {
  const cfg = await getConfig();

  if (msg.type === 'health') {
    try {
      const r = await fetch(`${baseUrl(cfg.port)}/health`, { method: 'GET' });
      return { ok: r.ok };
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
    return { ok: r.ok, ...json };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
}

chrome.runtime.onMessage.addListener((msg: BgMessage, _sender, sendResponse) => {
  handle(msg).then(sendResponse);
  return true; // keep the message channel open for the async response
});
