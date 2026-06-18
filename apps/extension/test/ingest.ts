// Simulated capture test for the extension's network path.
//
// We cannot drive a real browser here, so we exercise the exact contract the
// content script relies on: POST the captured-conversation JSON shape that
// `buildPayload()` produces to thinktank's localhost /ingest, then prove the
// memory landed and is retrievable. The DOM-scraping itself still needs manual
// validation against the live sites (see README).

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the brain at a throwaway DB BEFORE importing the server (getBrain reads
// THINKTANK_DB lazily on first use).
process.env.THINKTANK_DB = join(mkdtempSync(join(tmpdir(), 'tt-ext-')), 'test.db');

const { startHttp, getBrain, closeBrain } = await import('@thinktank/mcp-server');

const TEST_PORT = 47319;

/** Mirrors apps/extension/src/content.ts buildPayload() output for ChatGPT. */
const payload = {
  source: 'chatgpt' as const,
  tool: 'chatgpt-web' as const,
  title: 'Auth design chat',
  url: 'https://chatgpt.com/c/test-123',
  project: 'demo',
  conversation: [
    { role: 'user', text: 'How should we handle authentication in the new service?' },
    {
      role: 'assistant',
      text: 'We decided to use JWT, not sessions, for authenticating users in this project.',
    },
  ],
};

async function post(body: unknown): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${TEST_PORT}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}`);
  }
}

const handle = await startHttp({ port: TEST_PORT });
try {
  console.log('[ext] simulated /ingest test');

  // 1. health
  const health = await fetch(`http://127.0.0.1:${TEST_PORT}/health`).then((r) => r.json());
  check('GET /health is ok', health.ok === true);

  // 2. first ingest inserts the decision
  const first = await post(payload);
  check('POST /ingest ok', first.ok === true);
  check('reported >=1 turn', (first.turns ?? 0) >= 1);
  check('inserted >=1 memory', (first.inserted ?? 0) >= 1);

  // 3. re-ingesting the same chat dedupes rather than duplicating
  const second = await post(payload);
  check('re-ingest dedupes (deduped >=1)', (second.deduped ?? 0) >= 1);

  // 4. the JWT decision is semantically retrievable
  const { store } = getBrain();
  const hits = await store.search('how do we authenticate users', { project: 'demo' });
  const foundJwt = hits.some((h) => /jwt/i.test(h.text));
  check('semantic search recalls the JWT decision', foundJwt);

  // 5. bare-array body shape also accepted (defensive contract)
  const bare = await post([
    { role: 'user', text: 'We must support Node 22 or newer for this repo.' },
  ]);
  check('POST /ingest accepts bare turn array', bare.ok === true);

  assert.equal(failures, 0, `${failures} check(s) failed`);
  console.log('\n[ext] all checks passed');
} finally {
  await handle.stop();
  closeBrain();
}
