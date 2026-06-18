import {
  getConfig,
  setConfig,
  type BgMessage,
  type IngestResponse,
  type TabMessage,
} from './common';

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const projectInput = $<HTMLInputElement>('project');
const portInput = $<HTMLInputElement>('port');
const statusEl = $<HTMLDivElement>('status');

function setStatus(msg: string, kind: 'ok' | 'err' | 'warn' | '' = ''): void {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

async function persist(): Promise<void> {
  const port = Number(portInput.value);
  await setConfig({
    project: projectInput.value.trim() || 'web',
    port: Number.isFinite(port) && port > 0 ? port : 4319,
  });
}

/** Send a command to the content script in the active tab. */
function messageActiveTab(msg: TabMessage): Promise<IngestResponse> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        resolve({ ok: false, error: 'no active tab' });
        return;
      }
      chrome.tabs.sendMessage(tab.id, msg, (resp: IngestResponse | undefined) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp ?? { ok: false, error: 'no response' });
      });
    });
  });
}

function messageBackground(msg: BgMessage): Promise<IngestResponse> {
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

async function init(): Promise<void> {
  const cfg = await getConfig();
  projectInput.value = cfg.project;
  portInput.value = String(cfg.port);

  projectInput.addEventListener('change', persist);
  portInput.addEventListener('change', persist);

  $<HTMLButtonElement>('test').addEventListener('click', async () => {
    await persist();
    setStatus('Checking...', '');
    const resp = await messageBackground({ type: 'health' });
    if (resp.ok) setStatus('Connected to thinktank.', 'ok');
    else setStatus('Not running. Start: thinktank serve --http', 'err');
  });

  $<HTMLButtonElement>('import-current').addEventListener('click', async () => {
    await persist();
    setStatus('Importing this chat...', '');
    const resp = await messageActiveTab({ type: 'popup:importCurrent' });
    if (resp.ok) {
      setStatus(`Imported +${resp.inserted ?? 0} new, ${resp.deduped ?? 0} merged.`, 'ok');
    } else if (resp.error === 'empty') {
      setStatus('No messages found. Open a chat first.', 'warn');
    } else if (resp.error === 'unreachable') {
      setStatus('Not running. Start: thinktank serve --http', 'err');
    } else {
      setStatus(`Failed: ${resp.error ?? 'open a ChatGPT/Claude tab'}`, 'err');
    }
  });

  $<HTMLButtonElement>('import-all').addEventListener('click', async () => {
    await persist();
    setStatus('Importing all history (watch the page)...', '');
    const resp = await messageActiveTab({ type: 'popup:importAll' });
    if (resp.ok) setStatus('Import all finished.', 'ok');
    else setStatus(`Could not start: ${resp.error ?? 'open a ChatGPT/Claude tab'}`, 'err');
  });
}

void init();
