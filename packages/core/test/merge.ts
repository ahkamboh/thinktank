/**
 * P2 merge-engine test: prove dedupe, conflict resolution, and that unrelated
 * memories are left alone.
 *
 * Run: pnpm --filter @thinktank/core test:merge
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, MergeEngine } from '../src/index.js';
import type { IngestResult } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'thinktank-merge-'));
const dbPath = join(dir, 'merge.db');

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ok   - ${msg}`);
  else {
    failures++;
    console.error(`  FAIL - ${msg}`);
  }
}

const day = 86_400_000;

function only(results: IngestResult[]): IngestResult {
  if (results.length !== 1) {
    throw new Error(`expected 1 candidate, got ${results.length}`);
  }
  return results[0]!;
}

async function main() {
  console.log('\nthinktank P2 merge-engine test');
  console.log(`db: ${dbPath}\n`);

  const store = new MemoryStore(dbPath);
  const engine = new MergeEngine(store);

  // ---------------------------------------------------------------- DEDUPE
  console.log('Scenario 1: identical fact from two different tools -> dedupe');
  const text1 = 'The staging database is read-only; never run migrations against it.';
  const r1a = only(
    await engine.ingest({
      source: 'cursor',
      tool: 'Cursor',
      ts: Date.now() - day,
      project: 'dedupe-proj',
      text: text1,
      kind: 'constraint',
    }),
  );
  const r1b = only(
    await engine.ingest({
      source: 'claude',
      tool: 'Claude.ai',
      ts: Date.now(),
      project: 'dedupe-proj',
      text: text1,
      kind: 'constraint',
    }),
  );
  assert(r1a.action === 'inserted', 'first observation is inserted');
  assert(r1b.action === 'deduped', 'second identical observation is deduped');
  assert(
    r1b.matchedId === r1a.memory.id,
    'dedupe merged into the original row (same id)',
  );
  const merged = store.getById(r1a.memory.id)!;
  assert(merged.seenCount === 2, 'seen_count incremented to 2');
  const srcSet = new Set(merged.sources.map((s) => s.source));
  assert(
    srcSet.has('cursor') && srcSet.has('claude'),
    'both sources (cursor + claude) recorded on the merged memory',
  );
  const dedupeActive = store
    .recent(50, 'dedupe-proj')
    .filter((m) => m.status === 'active');
  assert(dedupeActive.length === 1, 'dedupe project has exactly 1 active row');

  // -------------------------------------------------------------- CONFLICT
  console.log('\nScenario 2: "use sessions" then later "use JWT" -> conflict');
  const older = only(
    await engine.ingest({
      source: 'cursor',
      tool: 'Cursor',
      ts: Date.now() - 2 * day,
      project: 'auth-proj',
      text: 'For authentication, we decided to use sessions.',
      kind: 'decision',
    }),
  );
  assert(older.action === 'inserted', 'sessions decision inserted first');

  const newer = only(
    await engine.ingest({
      source: 'chatgpt',
      tool: 'ChatGPT web',
      ts: Date.now(),
      project: 'auth-proj',
      text: 'For authentication, we now use JWT instead of sessions.',
      kind: 'decision',
    }),
  );
  assert(newer.action === 'superseded', 'JWT decision supersedes the old one');
  assert(
    newer.memory.text.includes('JWT') && newer.memory.status === 'active',
    'JWT memory is now the active one',
  );
  const oldRow = store.getById(older.memory.id)!;
  assert(oldRow.status === 'superseded', 'sessions memory marked superseded');
  assert(
    oldRow.supersededBy === newer.memory.id,
    'superseded row points to the JWT memory',
  );

  const conflicts = store.listContradictions('auth-proj');
  assert(conflicts.length === 1, 'one contradiction logged for auth-proj');
  assert(
    !!conflicts[0] &&
      conflicts[0].activeText.includes('JWT') &&
      conflicts[0].supersededText.includes('sessions'),
    'contradiction records JWT (active) vs sessions (superseded)',
  );
  assert(
    !!conflicts[0] &&
      conflicts[0].activeSource === 'chatgpt' &&
      conflicts[0].supersededSource === 'cursor',
    'contradiction records the conflicting sources (chatgpt vs cursor)',
  );

  // active-only search should surface JWT, not sessions.
  const authHits = await store.search('what auth method do we use?', {
    project: 'auth-proj',
    limit: 3,
  });
  assert(
    !!authHits[0] && authHits[0].text.includes('JWT'),
    'retrieval returns the active JWT decision, not the superseded one',
  );
  assert(
    authHits.every((h) => h.status === 'active'),
    'retrieval excludes superseded memories by default',
  );

  // ------------------------------------------------------------- UNRELATED
  console.log('\nScenario 3: unrelated memories -> no merge, no conflict');
  const u1 = only(
    await engine.ingest({
      source: 'cursor',
      tool: 'Cursor',
      ts: Date.now(),
      project: 'misc-proj',
      text: 'The team prefers pnpm over npm for all repos.',
      kind: 'preference',
    }),
  );
  const u2 = only(
    await engine.ingest({
      source: 'claude',
      tool: 'Claude.ai',
      ts: Date.now(),
      project: 'misc-proj',
      text: 'We use Tailwind CSS for styling the marketing site.',
      kind: 'fact',
    }),
  );
  assert(u1.action === 'inserted', 'pnpm preference inserted');
  assert(u2.action === 'inserted', 'tailwind fact inserted (not deduped)');
  assert(u1.memory.id !== u2.memory.id, 'unrelated memories are distinct rows');
  assert(
    store.listContradictions('misc-proj').length === 0,
    'no contradiction logged for unrelated memories',
  );
  const miscActive = store
    .recent(50, 'misc-proj')
    .filter((m) => m.status === 'active');
  assert(miscActive.length === 2, 'misc project has 2 active rows');

  // ------------------------------------------------------------- STATS
  const stats = store.stats();
  console.log('\nStats:', JSON.stringify(stats));
  assert(stats.superseded === 1, 'exactly one superseded memory overall');
  assert(stats.contradictions === 1, 'exactly one contradiction overall');

  store.close();
  rmSync(dir, { recursive: true, force: true });

  console.log(
    failures === 0
      ? '\nP2 PASS - dedupe + conflict resolution + unrelated isolation all work.\n'
      : `\nP2 FAIL - ${failures} assertion(s) failed.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nP2 ERROR:', err);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
  process.exitCode = 1;
});
