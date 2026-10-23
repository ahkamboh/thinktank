/**
 * Merge-quality test: true cosine similarity, explicit notes stored whole,
 * updated notes not swallowed by dedupe, and contradiction detection that
 * needs the same subject + attribute + a different value.
 *
 * Run: pnpm --filter @thinktank/core test:quality
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryStore,
  MergeEngine,
  NOTE_MAX_CHARS,
  addsInformation,
  contradicts,
  distanceToCosine,
  embed,
  openContradictions,
} from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'thinktank-quality-'));
const dbPath = join(dir, 'quality.db');

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ok   - ${msg}`);
  else {
    failures++;
    console.error(`  FAIL - ${msg}`);
  }
}

const day = 86_400_000;

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

async function main() {
  console.log('\nthinktank merge-quality test');
  console.log(`db: ${dbPath}\n`);
  const store = new MemoryStore(dbPath);
  const engine = new MergeEngine(store);

  // ------------------------------------------------------- 1) true cosine
  console.log('Fix 1: vec0 distance -> cosine');
  assert(distanceToCosine(0) === 1, 'distance 0 -> cosine 1');
  assert(Math.abs(distanceToCosine(Math.SQRT2)) < 1e-9, 'orthogonal (d = sqrt 2) -> cosine 0');
  assert(distanceToCosine(2) === -1, 'opposite (d = 2) -> cosine -1');

  const pairs: Array<[string, string]> = [
    ['For authentication, we decided to use sessions.', 'For authentication, we now use JWT instead of sessions.'],
    ['The team prefers pnpm over npm for all repos.', 'We use Tailwind CSS for styling the marketing site.'],
  ];
  for (const [i, [a, b]] of pairs.entries()) {
    const va = await embed(a);
    const vb = await embed(b);
    const m = store.insertMemory({ source: 'test', ts: Date.now(), project: `cos-${i}`, text: a }, va);
    const hit = store.findNearest(vb, { project: `cos-${i}`, limit: 1 })[0];
    assert(
      !!hit && hit.id === m.id && Math.abs(hit.cosine - dot(va, vb)) < 1e-4,
      `findNearest cosine equals the real dot product (${dot(va, vb).toFixed(3)}): "${a.slice(0, 30)}..."`,
    );
  }

  // --------------------------------------------- 2) explicit notes stay whole
  console.log('\nFix 2: memory_save notes are one memory');
  const note =
    'Never run the full cargo test on his Mac. Tag = version. Use `cargo test -p core` ' +
    '(e.g. for the parser crate). Outputs go to ~/Documents/claude/plot33-house-map/output/plot33_v3_12oct2026.pdf. Keep it short.';
  const saved = await engine.ingest(
    { source: 'claude-code', ts: Date.now(), project: 'notes', text: note, kind: 'constraint' },
    { mode: 'note' },
  );
  assert(saved.length === 1 && saved[0]!.action === 'inserted', 'note -> exactly one inserted memory');
  assert(saved[0]?.memory.text === note, 'stored text is the note verbatim (rules, short sentences and path intact)');
  assert(saved[0]?.memory.kind === 'constraint', "caller's kind kept on the note");

  const chat = await engine.ingest({ source: 'chatgpt', ts: Date.now(), project: 'notes-chat', text: note });
  assert(chat.length > 1, `the same text as a chat turn is still split for bulk ingest (${chat.length} pieces)`);

  const para = (i: number) =>
    `Section ${i}: ${'the deploy pipeline builds, tests and ships each service on merge to main. '.repeat(9).trim()}`;
  const long = [1, 2, 3, 4, 5, 6, 7].map(para).join('\n\n');
  const chunks = await engine.ingest(
    { source: 'claude-code', ts: Date.now(), project: 'notes-long', text: long, kind: 'fact' },
    { mode: 'note' },
  );
  assert(long.length > 2 * NOTE_MAX_CHARS, `long note is ${long.length} chars (over 2x the cap)`);
  assert(
    chunks.length >= 2 && chunks.every((r) => r.memory.text.length <= NOTE_MAX_CHARS),
    `long note chunked into ${chunks.length} memories, each <= ${NOTE_MAX_CHARS} chars`,
  );
  assert(
    [1, 2, 3, 4, 5, 6, 7].every((i) => chunks.some((r) => r.memory.text.includes(`Section ${i}:`))),
    'every paragraph of the long note is kept',
  );
  const filler = await engine.ingest(
    { source: 'claude-code', ts: Date.now(), project: 'notes', text: 'thanks!' },
    { mode: 'note' },
  );
  assert(filler.length === 0, 'a pure-filler note ("thanks!") is still dropped');

  // ------------------------------------------ dedupe vs updated information
  console.log('\nDedupe only merges true repeats');
  const v1 =
    'Xotion Desktop: Tauri 2 Mac app on the Agent SDK. Milestones M1-M8 are built; M9 is waiting for his test.';
  const v2 =
    'Xotion Desktop: Tauri 2 Mac app on the Agent SDK. Milestones M1-M9 are built; M10 (auto-update) is next.';
  const r1 = (await engine.ingest({ source: 'claude-code', ts: Date.now() - day, project: 'xotion', text: v1, kind: 'state' }, { mode: 'note' }))[0]!;
  const r2 = (await engine.ingest({ source: 'claude-code', ts: Date.now(), project: 'xotion', text: v2, kind: 'state' }, { mode: 'note' }))[0]!;
  assert(addsInformation(v2, v1), 'v2 adds information over v1 (M9 -> M10)');
  assert(r2.action === 'inserted', 'updated note (cosine ~0.96) is inserted, not merged into v1');
  assert(store.getById(r1.memory.id)!.status === 'active', 'v1 stays active (nothing silently lost)');
  const r3 = (await engine.ingest({ source: 'cursor', ts: Date.now(), project: 'xotion', text: v2, kind: 'state' }, { mode: 'note' }))[0]!;
  assert(r3.action === 'deduped' && r3.matchedId === r2.memory.id, 'an exact repeat of v2 dedupes into v2');
  await engine.ingest({ source: 'cursor', ts: Date.now(), project: 'para', text: 'The team prefers pnpm over npm for all repos.', kind: 'preference' }, { mode: 'note' });
  const para2 = (await engine.ingest({ source: 'claude', ts: Date.now(), project: 'para', text: 'We prefer pnpm to npm in every repo.', kind: 'preference' }, { mode: 'note' }))[0]!;
  assert(para2.action === 'deduped', 'a paraphrase (cosine ~0.94, no new info) dedupes');

  // ------------------------------------------------- 3) false contradictions
  console.log('\nFix 3: contradicts() needs same subject + attribute + different value');
  const real: Array<[string, string]> = [
    ['For authentication, we decided to use sessions.', 'For authentication, we now use JWT instead of sessions.'],
    ['We use Postgres for the main database.', 'We use MySQL for the main database.'],
    ['The staging database is read-only.', 'The staging database is writable.'],
    ['The admin API is public.', 'The admin API is not public.'],
  ];
  for (const [a, b] of real) assert(contradicts(a, b), `conflict: "${a}" vs "${b}"`);

  // Pairs the old heuristic superseded in a real brain (one shared word).
  const notConflicts: Array<[string, string]> = [
    ['Use globally unique prefixed class names (e.g. opx-marks-*) as plain strings.', 'Use unique prefixed global class names (e.g. opx-cta-*) and plain string classNames.'],
    ['Use a plain co-located .css file with prefixed class names instead (e.g. wah-* for the workflow-automation hero).', 'Use globally unique prefixed class names (e.g. opx-marks-*) as plain strings.'],
    ['Do not use it to rebuild a site into a framework; that is the site-clone skill.', 'Offline site mirrors use the personal skill ~/.cursor/skills/httrack-mirror.'],
    ['Never put his gmail or phone number in anything public: sites, READMEs, commits.', "Commit to PUBLIC repos only as the noreply address; never use the gmail there."],
    ['Uses local Gemma 4 via Ollama plus nomic-embed-text embeddings to build a typed SQLite memory graph.', 'Connects Claude, ChatGPT and Cursor via browser-extension DOM injection; thinktank uses MCP for coding tools.'],
    ['The team prefers pnpm over npm for all repos.', 'We use Tailwind CSS for styling the marketing site.'],
    ['The billing service uses Postgres.', 'The analytics service uses ClickHouse.'],
    ['Redis is used for caching sessions.', 'We use Postgres for the main database.'],
  ];
  for (const [a, b] of notConflicts) {
    assert(!contradicts(a, b), `no conflict: "${a.slice(0, 40)}..." vs "${b.slice(0, 40)}..."`);
  }
  assert(
    !contradicts(
      'Auth notes. For authentication, we decided to use sessions. Cookies are httpOnly.',
      'For authentication, we now use JWT instead of sessions.',
    ),
    'a multi-sentence note is never auto-superseded',
  );

  for (const [i, [a, b]] of notConflicts.entries()) {
    await engine.ingest({ source: 'claude-code', ts: Date.now() - day, project: 'fp', text: a, kind: 'decision' }, { mode: 'note' });
    const res = await engine.ingest({ source: 'claude-code', ts: Date.now() + i, project: 'fp', text: b, kind: 'decision' }, { mode: 'note' });
    if (res[0]?.action === 'superseded') console.error(`    superseded: ${a} || ${b}`);
  }
  assert(store.listContradictions('fp').length === 0, 'ingesting those pairs supersedes nothing');

  // ------------------------------------------- open-contradiction banner
  console.log('\nOnly genuinely open contradictions are counted');
  await engine.ingest({ source: 'cursor', ts: Date.now() - 2 * day, project: 'banner', text: 'For authentication, we decided to use sessions.', kind: 'decision' });
  const jwt = (await engine.ingest({ source: 'chatgpt', ts: Date.now(), project: 'banner', text: 'For authentication, we now use JWT instead of sessions.', kind: 'decision' }))[0]!;
  assert(jwt.action === 'superseded', 'real conflict supersedes');
  assert(openContradictions(store, 'banner').length === 1, 'one open contradiction');

  // A legacy false positive, logged by the old heuristic.
  const x = await store.save({ source: 'cursor', ts: Date.now() - day, project: 'banner', text: 'Beep watch tiles: Ali chose two tiles on 19 Oct 2026.', kind: 'decision' });
  const y = await store.save({ source: 'cursor', ts: Date.now(), project: 'banner', text: 'Beep request screens use a single small word as the title.', kind: 'decision' });
  store.supersede(x.id, y.id);
  store.logContradiction({ project: 'banner', topic: 'beep', active: store.getById(y.id)!, superseded: store.getById(x.id)! });
  assert(store.listContradictions('banner').length === 2, 'two contradictions on record');
  assert(openContradictions(store, 'banner').length === 1, 'the legacy false positive is not counted as open');

  store.deleteMemory(jwt.memory.id);
  assert(openContradictions(store, 'banner').length === 0, 'once the winning memory is deleted, it is no longer open');

  store.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(
    failures === 0
      ? '\nQUALITY PASS - cosine, notes, dedupe guard and contradictions all work.\n'
      : `\nQUALITY FAIL - ${failures} assertion(s) failed.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nQUALITY ERROR:', err);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
  process.exitCode = 1;
});
