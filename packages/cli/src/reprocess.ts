import {
  MemoryStore,
  resolveCipher,
  pickClassifier,
  LLMClassifier,
  type Memory,
  type MemoryKind,
} from '@thinktank/core';
import { resolveDbPath } from '@thinktank/mcp-server';

interface ReprocessOpts {
  apply: boolean;
  limit?: number;
  sample?: number;
  project?: string;
}

/** Rough per-call cost (USD) for the cheap default models, for estimates only. */
const COST_PER_CALL: Record<string, number> = {
  anthropic: 0.0032, // claude-3-5-haiku-ish: ~2k in + ~400 out
  openai: 0.00055, // gpt-4o-mini-ish
};

function activeProvider(): 'anthropic' | 'openai' | null {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return null;
}

function fmtDist(d: Record<string, number>): string {
  return Object.entries(d)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join('  ');
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Load every active memory (optionally project-scoped) via paginated list(). */
async function loadActive(
  store: MemoryStore,
  project?: string,
): Promise<Memory[]> {
  const out: Memory[] = [];
  const page = 200;
  for (let offset = 0; ; offset += page) {
    const { rows, total } = await store.list({
      status: 'active',
      project,
      limit: page,
      offset,
    });
    out.push(...rows);
    if (out.length >= total || rows.length === 0) break;
  }
  return out;
}

/**
 * Re-judge existing stored memories: flag non-durable noise for deletion and
 * assign a better kind. DRY RUN by default - only `--apply` mutates the DB.
 */
export async function runReprocess(opts: ReprocessOpts): Promise<void> {
  const dbPath = resolveDbPath();
  const store = new MemoryStore(dbPath, { cipher: resolveCipher() });
  const classifier = pickClassifier();
  const provider = activeProvider();

  console.log(`\nthinktank reprocess  (db: ${dbPath})`);
  console.log(
    `Mode: ${opts.apply ? 'APPLY (will modify the database)' : 'DRY RUN (no changes)'}`,
  );
  console.log(
    `Classifier: ${classifier.name}${
      provider ? ` via ${provider}` : ' (offline, no API key)'
    }`,
  );

  // Gather the working set.
  let memories = await loadActive(store, opts.project);
  const totalActive = memories.length;
  if (opts.sample && opts.sample < memories.length) {
    memories = shuffle(memories).slice(0, opts.sample);
  } else if (opts.limit && opts.limit < memories.length) {
    memories = memories.slice(0, opts.limit);
  }
  console.log(
    `Active memories: ${totalActive}; judging ${memories.length}` +
      (opts.project ? ` (project=${opts.project})` : ''),
  );

  if (memories.length === 0) {
    console.log('Nothing to do.');
    store.close();
    return;
  }

  // Cost / call estimate (LLM path only).
  if (classifier instanceof LLMClassifier && provider) {
    const calls = classifier.callCount(memories.length);
    const cost = calls * (COST_PER_CALL[provider] ?? 0);
    console.log(
      `Estimated API calls: ${calls}  (~$${cost.toFixed(2)} on ${provider}, rough)`,
    );
  }

  // Judge.
  console.log('\nClassifying...');
  const before: Record<string, number> = {};
  for (const m of memories) before[m.kind] = (before[m.kind] ?? 0) + 1;

  const judgements = await classifier.classify(memories.map((m) => m.text));

  const after: Record<string, number> = {};
  const toDelete: Memory[] = [];
  const toReclass: Array<{ m: Memory; kind: MemoryKind }> = [];

  memories.forEach((m, i) => {
    const j = judgements[i]!;
    if (j.drop) {
      toDelete.push(m);
      return;
    }
    after[j.kind] = (after[j.kind] ?? 0) + 1;
    if (j.kind !== m.kind) toReclass.push({ m, kind: j.kind });
  });

  // Report.
  console.log('\n--- Result ---');
  console.log(`Would DELETE as noise:   ${toDelete.length}`);
  console.log(`Would RECLASSIFY kind:   ${toReclass.length}`);
  console.log(`Kept:                    ${memories.length - toDelete.length}`);
  console.log(`\nKind distribution BEFORE: ${fmtDist(before)}`);
  console.log(`Kind distribution AFTER:  ${fmtDist(after)}`);

  const sampleNoise = toDelete.slice(0, 8);
  if (sampleNoise.length) {
    console.log('\nExamples flagged as noise (would be deleted):');
    for (const m of sampleNoise) {
      console.log(`  [${m.kind}] ${m.text.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
  }
  const sampleReclass = toReclass.slice(0, 8);
  if (sampleReclass.length) {
    console.log('\nExamples reclassified:');
    for (const { m, kind } of sampleReclass) {
      console.log(
        `  ${m.kind} -> ${kind}: ${m.text.replace(/\s+/g, ' ').slice(0, 60)}`,
      );
    }
  }

  if (!opts.apply) {
    console.log(
      '\nDRY RUN complete. No changes were made. Re-run with --apply to write.\n',
    );
    store.close();
    return;
  }

  // Apply.
  console.log('\nApplying changes...');
  let deleted = 0;
  for (const m of toDelete) {
    if (store.deleteMemory(m.id)) deleted++;
    if (deleted % 50 === 0) console.log(`  deleted ${deleted}/${toDelete.length}`);
  }
  let reclassed = 0;
  for (const { m, kind } of toReclass) {
    if (store.updateKind(m.id, kind)) reclassed++;
    if (reclassed % 50 === 0)
      console.log(`  reclassified ${reclassed}/${toReclass.length}`);
  }

  const stats = store.stats();
  console.log(
    `\nApplied: deleted ${deleted}, reclassified ${reclassed}.\n` +
      `New store: total=${stats.total} active=${stats.active} ` +
      `superseded=${stats.superseded}  kinds: ${fmtDist(stats.byKind)}\n`,
  );
  store.close();
}
