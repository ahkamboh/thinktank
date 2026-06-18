/**
 * `thinktank demo` - a self-contained, narrated walk-through of the headline
 * value, with no browser and no touching the user's real brain (it uses a
 * throwaway temp database). It proves, in order:
 *
 *   1. A ChatGPT conversation is captured -> a secret in it is REDACTED.
 *   2. Cursor (via the same retrieval the MCP tools use) recalls the decision
 *      SEMANTICALLY - the query shares no keywords with the stored memory.
 *   3. A later, conflicting decision from another tool SUPERSEDES the old one
 *      and the contradiction is logged ("you told X here but Y there").
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIVIDER = '─'.repeat(64);

function hr(): void {
  console.log(`\n${DIVIDER}`);
}

function step(n: number, title: string): void {
  hr();
  console.log(`  STEP ${n}  ${title}`);
  console.log(DIVIDER);
}

export async function runDemo(): Promise<void> {
  // Use a disposable database and force encryption OFF so the demo prints
  // readable plaintext. This must be set BEFORE the brain is first opened.
  const dir = mkdtempSync(join(tmpdir(), 'thinktank-demo-'));
  process.env.THINKTANK_DB = join(dir, 'demo.db');
  delete process.env.THINKTANK_ENCRYPT;

  // Imported after env is set so getBrain() resolves the temp DB.
  const {
    getBrain,
    closeBrain,
    ingestConversation,
    packToBudget,
    formatMemoryLine,
    rankForResume,
    renderMemories,
    estimateTokens,
    DEFAULT_TOKEN_BUDGET,
  } = await import('@thinktank/mcp-server');

  const PROJECT = 'payments-api';
  const { store, engine } = getBrain();

  console.log('\nthinktank demo - one private brain across ChatGPT and Cursor');
  console.log(`(throwaway db: ${process.env.THINKTANK_DB})`);

  // ----------------------------------------------------------------- STEP 1
  step(1, 'You brainstorm in ChatGPT (and paste a secret by accident)');
  const chatgptConversation = {
    source: 'chatgpt',
    tool: 'ChatGPT web',
    model: 'gpt-5',
    project: PROJECT,
    title: 'Auth approach for the payments API',
    conversation: [
      { role: 'user', text: 'How should we handle login for the new payments API?' },
      {
        role: 'assistant',
        text: 'Decision: we use JWT (JSON Web Tokens) signed on the server for user login, not server-side sessions. It scales better for a stateless API.',
      },
      {
        role: 'user',
        text: 'Great. Here is a test key so you can hit the endpoint: sk-proj-Demo1234567890abcdefghijklmnop and the bucket key AKIAIOSFODNN7EXAMPLE.',
      },
    ],
  };
  console.log('Captured 3 turns from ChatGPT (sent only to localhost). One turn');
  console.log('contained an API key + an AWS key.\n');

  const summary = await ingestConversation(chatgptConversation);
  console.log(
    `Ingested: ${summary.turns} turns -> ${summary.inserted} new memories, ` +
      `${summary.deduped} merged, ${summary.superseded} updated.`,
  );

  console.log('\nWhat actually got stored (note the redaction):');
  for (const m of store.recent(50, PROJECT)) {
    console.log(`   ${formatMemoryLine(m)}`);
  }

  const leak = store
    .recent(50, PROJECT)
    .some((m) => m.text.includes('sk-proj-Demo') || m.text.includes('AKIAIOSFODNN7EXAMPLE'));
  console.log(
    leak
      ? '\n   !! a raw secret leaked into the DB (this should never happen)'
      : '\n   ✓ no raw secret was embedded, indexed, or written to disk.',
  );

  // ----------------------------------------------------------------- STEP 2
  step(2, 'Next day, in Cursor - it just KNOWS (no keywords in common)');
  const query = 'how do we authenticate users?';
  console.log(`Cursor calls memory_search("${query}")`);
  console.log('Note: the stored decision never uses the word "authenticate".\n');

  const hits = await store.search(query, { project: PROJECT, limit: 20 });
  const packed = packToBudget(hits, DEFAULT_TOKEN_BUDGET);
  const rendered = packed.map(formatMemoryLine).join('\n');
  console.log('Cursor receives:');
  console.log(
    rendered
      .split('\n')
      .map((l) => `   ${l}`)
      .join('\n'),
  );

  const top = packed[0];
  console.log(
    top && top.text.includes('JWT')
      ? '\n   ✓ the JWT decision came back via meaning, not keyword match.'
      : '\n   !! expected the JWT decision to surface.',
  );
  const tokens = estimateTokens(rendered);
  console.log(
    `   ✓ delivered ~${tokens} tokens (budget ${DEFAULT_TOKEN_BUDGET}), not the whole chat history.`,
  );

  // ----------------------------------------------------------------- STEP 3
  step(3, 'Later, in Codex, the team changes its mind -> conflict caught');
  console.log('Codex reports the opposite decision. thinktank supersedes the');
  console.log('old one and logs the contradiction.\n');

  const results = await engine.ingest({
    source: 'codex',
    tool: 'Codex',
    ts: Date.now() + 5000,
    project: PROJECT,
    text: 'For authentication we now use server-side sessions instead of JWT.',
    kind: 'decision',
  });
  const conflict = results.find((r) => r.action === 'superseded');
  if (conflict) {
    console.log(`   now active : ${conflict.memory.text}`);
    console.log(`   superseded : ${conflict.superseded?.text ?? '(unknown)'}`);
  } else {
    console.log('   (no conflict detected - results:', results.map((r) => r.action).join(', '), ')');
  }

  const contradictions = store.listContradictions(PROJECT);
  if (contradictions[0]) {
    const c = contradictions[0];
    console.log(
      `\n   contradiction logged: "${c.activeText}" (via ${c.activeSource}) ` +
        `vs "${c.supersededText}" (via ${c.supersededSource}).`,
    );
  }

  console.log('\nSo a fresh Cursor session now resumes with the corrected truth:');
  const resume = renderMemories(rankForResume(store.recent(50, PROJECT)), DEFAULT_TOKEN_BUDGET);
  console.log(
    resume
      .split('\n')
      .map((l) => `   ${l}`)
      .join('\n'),
  );
  if (contradictions.length > 0) {
    console.log(`   (+ heads-up: ${contradictions.length} unresolved contradiction on record)`);
  }

  // ----------------------------------------------------------------- wrap up
  hr();
  const s = store.stats();
  console.log(
    `  Summary: ${s.active} active memories, ${s.superseded} superseded, ` +
      `${s.contradictions} contradiction(s).`,
  );
  console.log('  One brain. ChatGPT wrote it, Cursor and Codex read+corrected it.');
  hr();

  // Close the brain and remove the temp db; let the process exit naturally
  // (a hard process.exit() can abort the native embedding runtime mid-teardown).
  closeBrain();
  rmSync(dir, { recursive: true, force: true });
}
