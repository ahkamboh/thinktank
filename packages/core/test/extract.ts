/**
 * Extraction-quality test: the improved heuristic must DROP non-durable noise
 * (greetings, emoji, one-off requests, bare questions) while KEEPING real
 * decisions/preferences/constraints with the right kind.
 *
 * Run: pnpm --filter @thinktank/core test:extract
 */
import { HeuristicExtractor, isNoise, HeuristicClassifier } from '../src/index.js';
import type { MemoryEvent } from '../src/index.js';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ok   - ${msg}`);
  else {
    failures++;
    console.error(`  FAIL - ${msg}`);
  }
}

function ev(text: string): MemoryEvent {
  return { source: 'chatgpt', tool: 'chatgpt-web', ts: Date.now(), project: 'p', text };
}

async function main() {
  console.log('\nthinktank extraction-quality test\n');
  const ex = new HeuristicExtractor();

  // ---- Noise that must be DROPPED -------------------------------------------
  console.log('Noise (should be dropped):');
  const noise = [
    'hi',
    'thanks!',
    'ok cool 👍',
    '😂😂😂',
    'Let me know when you’re free.',
    'Reduce my beard feel like trim',
    'Change pic cloth into black t shirt',
    'Give more young look',
    'how do I do this?',
    'ok thanks a lot',
  ];
  for (const t of noise) {
    assert(isNoise(t), `isNoise drops: "${t}"`);
    assert((await Promise.resolve(ex.extract(ev(t)))).length === 0, `extract yields nothing: "${t}"`);
  }

  // ---- Durable memories that must be KEPT (with correct kind) ----------------
  console.log('\nDurable (should be kept + classified):');
  const keep: Array<[string, string]> = [
    ['We decided to use JWT, not sessions, for auth.', 'decision'],
    ['Prefer pnpm over npm for all repos.', 'preference'],
    ['The app must support Node 18 and never commit secrets.', 'constraint'],
    ['The staging database is read-only and lives in us-east-1.', 'fact'],
  ];
  for (const [t, kind] of keep) {
    assert(!isNoise(t), `isNoise keeps: "${t}"`);
    const cands = await Promise.resolve(ex.extract(ev(t)));
    assert(cands.length >= 1, `extract yields a candidate: "${t}"`);
    assert(
      cands.some((c) => c.kind === kind),
      `classified as ${kind}: "${t}"`,
    );
  }

  // ---- Mixed message: keep the decision, drop the pleasantry -----------------
  console.log('\nMixed message:');
  const mixed = await Promise.resolve(
    ex.extract(ev('Hey! Thanks. We will use Postgres for the main database. Cheers 🎉')),
  );
  assert(
    mixed.length === 1 && /postgres/i.test(mixed[0]!.text),
    'mixed message keeps only the durable Postgres decision',
  );

  // ---- Classifier (offline) round-trips the same judgement ------------------
  console.log('\nHeuristicClassifier:');
  const clf = new HeuristicClassifier();
  const judged = await clf.classify(['thanks!', 'We use JWT for auth.']);
  assert(judged[0]!.drop === true, 'classifier drops "thanks!"');
  assert(judged[1]!.drop === false, 'classifier keeps the JWT decision');

  console.log(
    failures === 0
      ? '\nEXTRACT PASS - noise dropped, durable memories kept & classified.\n'
      : `\nEXTRACT FAIL - ${failures} assertion(s) failed.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nEXTRACT ERROR:', err);
  process.exitCode = 1;
});
