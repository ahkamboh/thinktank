// Shared types + helpers used by the content script, background worker, and
// popup. esbuild bundles a copy into each entry, so this file must not rely on
// any one execution context's globals beyond what it actually uses.

export type Site = 'chatgpt' | 'claude';

export interface Turn {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

/** The payload POSTed to thinktank's localhost /ingest endpoint. */
export interface CapturePayload {
  source: Site;
  tool: 'chatgpt-web' | 'claude-web';
  title?: string;
  url?: string;
  project?: string;
  conversation: Turn[];
}

/** Shape of thinktank's /ingest response (plus our own transport flags). */
export interface IngestResponse {
  ok: boolean;
  turns?: number;
  inserted?: number;
  deduped?: number;
  superseded?: number;
  error?: string;
}

export interface Config {
  /** Localhost port thinktank's HTTP server is listening on. */
  port: number;
  /** Default project name to tag captured memories with. */
  project: string;
}

export const DEFAULT_CONFIG: Config = { port: 4319, project: 'web' };

export async function getConfig(): Promise<Config> {
  const stored = await chrome.storage.sync.get(DEFAULT_CONFIG);
  const port = Number(stored.port);
  return {
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_CONFIG.port,
    project: (stored.project as string) || DEFAULT_CONFIG.project,
  };
}

export async function setConfig(patch: Partial<Config>): Promise<void> {
  await chrome.storage.sync.set(patch);
}

/** thinktank only ever runs on the loopback interface. We never build a remote URL. */
export function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

// --- messages between content/popup and the background worker --------------
// The background worker owns all network I/O. Content scripts route fetches
// through it so the host page's strict CSP (ChatGPT/Claude both set a tight
// connect-src) can never block the localhost call.

export type BgMessage =
  | { type: 'ingest'; payload: CapturePayload }
  | { type: 'health' };

/** popup -> active tab content script commands. */
export type TabMessage =
  | { type: 'popup:importCurrent' }
  | { type: 'popup:importAll' };
