/**
 * P1 smoke test: prove a memory can be saved and recalled by meaning.
 *
 * Run: pnpm --filter @thinktank/core test
 *
 * Steps:
 *   1. Open a fresh on-disk DB (proves node:sqlite + sqlite-vec + FTS5 load).
 *   2. Save a handful of memories from different "sources".
 *   3. Run a semantic query that shares NO keywords with the target memory,
 *      to prove vector search works (not just keyword matching).
 *   4. Run a keyword query to prove FTS works.
 *   5. Reopen the DB to prove persistence.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'thinktank-test-'));
const dbPath = join(dir, 'test.db');

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ok   - ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL - ${msg}`);
  }
}

async function main() {
  console.log(`\nthinktank P1 round-trip test`);
  console.log(`db: ${dbPath}\n`);

  const store = new MemoryStore(dbPath);

  console.log('Saving memories...');
  await store.save({
    source: 'chatgpt',
    tool: 'ChatGPT web',
    ts: Date.now() - 86_400_000,
    project: 'acme-api',
    role: 'user',
    text: 'For the acme-api we decided to use JWT access tokens instead of server sessions.',
    kind: 'decision',
  });
  await store.save({
    source: 'cursor',
    tool: 'Cursor',
    ts: Date.now() - 3_600_000,
    project: 'acme-api',
    text: 'The team prefers pnpm over npm for all repos.',
    kind: 'preference',
  });
  await store.save({
    source: 'claude',
    tool: 'Claude.ai',
    ts: Date.now() - 7_200_000,
    project: 'acme-api',
    text: 'The staging database is read-only; never run migrations against it.',
    kind: 'constraint',
  });
  await store.save({
    source: 'manual',
    ts: Date.now(),
    project: 'other-project',
    text: 'We use Tailwind for styling on the marketing site.',
    kind: 'fact',
  });

  const stats = store.stats();
  console.log('Stats:', JSON.stringify(stats));
  assert(stats.total === 4, 'saved 4 memories');
  assert(stats.byKind['decision'] === 1, 'one decision memory');

  // 1) SEMANTIC query - shares no literal keywords with the JWT memory.
  console.log('\nSemantic search: "how do we authenticate users?"');
  const sem = await store.search('how do we authenticate users?', {
    project: 'acme-api',
    limit: 3,
  });
  sem.forEach((r, i) =>
    console.log(
      `  #${i + 1} [${r.kind}/${r.source}] score=${r.score.toFixed(4)} :: ${r.text}`,
    ),
  );
  assert(sem.length > 0, 'semantic search returned results');
  assert(
    !!sem[0] && sem[0].text.includes('JWT'),
    'top semantic hit is the JWT auth decision (vector match, no shared keywords)',
  );

  // 2) KEYWORD query - exact term present in one memory.
  console.log('\nKeyword search: "migrations"');
  const kw = await store.search('migrations', { limit: 3 });
  kw.forEach((r, i) =>
    console.log(`  #${i + 1} [${r.kind}] score=${r.score.toFixed(4)} :: ${r.text}`),
  );
  assert(
    !!kw[0] && kw[0].text.includes('read-only'),
    'top keyword hit is the staging-db constraint',
  );

  // 3) PROJECT scoping - the Tailwind fact is in another project.
  const scoped = await store.search('styling framework', {
    project: 'acme-api',
    limit: 5,
  });
  assert(
    scoped.every((r) => r.project === 'acme-api'),
    'project scoping excludes other-project memories',
  );

  store.close();

  // 4) PERSISTENCE - reopen and confirm data survived.
  console.log('\nReopening DB to verify persistence...');
  const store2 = new MemoryStore(dbPath);
  assert(store2.stats().total === 4, 'memories persisted across reopen');
  const again = await store2.search('authentication strategy', {
    project: 'acme-api',
    limit: 1,
  });
  assert(
    !!again[0] && again[0].text.includes('JWT'),
    'semantic recall still works after reopen',
  );
  store2.close();

  rmSync(dir, { recursive: true, force: true });

  console.log(
    failures === 0
      ? '\nP1 PASS - save + semantic recall + keyword + scope + persistence all work.\n'
      : `\nP1 FAIL - ${failures} assertion(s) failed.\n`,
  );
  // Set the exit code but let the event loop drain naturally. Calling
  // process.exit() here races with the onnxruntime native thread pool
  // teardown and aborts the process (SIGABRT) after the test has passed.
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nP1 ERROR:', err);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
  process.exitCode = 1;
});
