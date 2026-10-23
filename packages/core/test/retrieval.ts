/**
 * Retrieval test: a scoped search ranks the project's OWN memories (the scope
 * is part of candidate generation, not a post-filter), project names match
 * across case/separators/aliases, and the resume pool keeps old standing rules.
 *
 * Run: pnpm --filter @thinktank/core test:retrieval
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, embed, projectKey } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'thinktank-retrieval-'));
const dbPath = join(dir, 'retrieval.db');

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ok   - ${msg}`);
  else {
    failures++;
    console.error(`  FAIL - ${msg}`);
  }
}

const day = 86_400_000;

async function main() {
  console.log('\nthinktank retrieval test');
  console.log(`db: ${dbPath}\n`);
  const store = new MemoryStore(dbPath, {
    projectAliases: { 'thinktank-core-fixes': 'thinktank' },
  });

  // ---------------------------------------------- scope pushed into search
  console.log('Fix 5: project scope is applied inside candidate generation');
  for (let i = 0; i < 60; i++) {
    await store.save({
      source: 'test',
      ts: Date.now() - i * 1000,
      project: 'busy',
      text: `Database migration policy ${i}: run every database migration through the migration runner in CI.`,
      kind: 'constraint',
    });
  }
  const quiet = await store.save({
    source: 'test',
    ts: Date.now() - 30 * day,
    project: 'quiet',
    text: 'Schema changes ship only through reviewed pull requests.',
    kind: 'constraint',
  });
  const query = 'database migration policy';

  const global = await store.search(query, { limit: 12 });
  assert(
    global.every((h) => h.project === 'busy'),
    'a global top-12 is all "busy" (what the old post-filter had to work with)',
  );
  const scoped = await store.search(query, { project: 'quiet', limit: 3 });
  assert(
    scoped.length === 1 && scoped[0]!.id === quiet.id,
    'scoped search still finds the only "quiet" memory',
  );
  assert(
    typeof scoped[0]?.cosine === 'number' && scoped[0]!.cosine > 0,
    'search results carry the cosine similarity',
  );
  const near = store.findNearest(await embed(query), { project: 'quiet', limit: 5 });
  assert(near.length === 1 && near[0]!.id === quiet.id, 'findNearest is scoped inside the KNN too');

  const kw = await store.search('reviewed pull requests', { project: 'busy', limit: 5 });
  assert(kw.every((h) => h.project === 'busy'), 'keyword (FTS) candidates respect the scope');

  // superseded rows don't eat the pool
  const old = await store.save({ source: 'test', ts: Date.now() - day, project: 'quiet', text: 'Schema changes were applied by hand on the server.', kind: 'fact' });
  store.supersede(old.id, quiet.id);
  const active = await store.search('schema changes', { project: 'quiet', limit: 5 });
  assert(active.every((h) => h.status === 'active'), 'superseded rows are excluded at the source');
  const all = await store.search('schema changes', { project: 'quiet', limit: 5, includeSuperseded: true });
  assert(all.some((h) => h.id === old.id), 'includeSuperseded still returns them');

  // relevance floor: an unrelated question shouldn't return the scope's rows
  const offTopic = 'which pizza topping does the team like best';
  const unfloored = await store.search(offTopic, { project: 'quiet', limit: 5 });
  const floored = await store.search(offTopic, { project: 'quiet', limit: 5, minCosine: 0.25 });
  assert(unfloored.length > 0, 'without a floor, any scoped row comes back for an unrelated question');
  assert(floored.length === 0, 'with minCosine 0.25 an unrelated question finds nothing (so callers can fall back)');
  assert(
    (await store.search('reviewed', { project: 'quiet', limit: 5, minCosine: 0.99 })).some((h) => h.id === quiet.id),
    'a keyword match is kept even below the cosine floor',
  );
  assert(
    (await store.search('how should we do it', { project: 'busy', limit: 5 })).every(
      (h) => typeof h.cosine === 'number',
    ),
    'every result carries a cosine, keyword-only hits included',
  );

  // ------------------------------------------------- project key matching
  console.log('\nFix 5: project names are normalized + aliased');
  assert(
    projectKey('Think_Tank') === projectKey('think-tank') && projectKey('thinktank') === 'thinktank',
    'projectKey ignores case and - _ . separators',
  );
  const tt = await store.save({ source: 'test', ts: Date.now(), project: 'Think_Tank', text: 'thinktank stores memories in node:sqlite with sqlite-vec.', kind: 'fact' });
  assert(
    (await store.search('where are memories stored', { project: 'thinktank' })).some((h) => h.id === tt.id),
    'search with "thinktank" finds a memory saved under "Think_Tank"',
  );
  assert(store.recent(10, 'THINK-TANK').some((m) => m.id === tt.id), 'recent() matches "THINK-TANK" too');
  const again = await store.save({ source: 'test', ts: Date.now(), project: 'think-tank', text: 'thinktank exposes an MCP server over stdio.', kind: 'fact' });
  assert(again.project === 'Think_Tank', 'a new save reuses the existing spelling instead of fragmenting the project');
  const wt = await store.save({ source: 'test', ts: Date.now(), project: 'thinktank-core-fixes', text: 'Worktree note: WAL is enabled on open.', kind: 'state' });
  assert(projectKey(wt.project ?? '') === 'thinktank', 'an aliased worktree name is stored under its repo');
  assert(
    store.recent(10, 'thinktank-core-fixes').some((m) => m.id === tt.id),
    'reading through the alias sees the repo memories',
  );

  // ----------------------------------------------------- resume candidates
  console.log('\nFix 4: resume pool = newest + all constraints/preferences');
  const rule = await store.save({ source: 'test', ts: Date.now() - 90 * day, project: 'resume', text: 'Never push to main without a review.', kind: 'constraint' });
  const pref = await store.save({ source: 'test', ts: Date.now() - 60 * day, project: 'resume', text: 'Prefers tables over paragraphs in explanations.', kind: 'preference' });
  let newest = rule;
  for (let i = 59; i >= 0; i--) {
    newest = await store.save({ source: 'test', ts: Date.now() - i * 1000, project: 'resume', text: `Status update ${i}: refactor step ${i} of the importer is done.`, kind: 'state' });
  }
  const last50 = store.recent(50, 'resume');
  assert(!last50.some((m) => m.id === rule.id), 'the old "last 50" window misses the 90-day-old constraint');
  const pool = store.resumeCandidates('resume');
  assert(pool.some((m) => m.id === rule.id), 'resumeCandidates includes the old constraint');
  assert(pool.some((m) => m.id === pref.id), 'resumeCandidates includes the old preference');
  assert(pool[0]?.id === newest.id, 'resumeCandidates starts with the newest memory');

  store.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(
    failures === 0
      ? '\nRETRIEVAL PASS - scoped search, project matching and resume pool all work.\n'
      : `\nRETRIEVAL FAIL - ${failures} assertion(s) failed.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nRETRIEVAL ERROR:', err);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
  process.exitCode = 1;
});
