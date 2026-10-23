/**
 * P3 smoke test:
 *   - in-memory MCP client <-> server: list tools, save, then search it back
 *   - HTTP server: POST /ingest a tiny conversation, confirm via memory_recent,
 *     and check /health
 *
 * Run: pnpm --filter @thinktank/mcp-server test
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'thinktank-mcp-'));
process.env.THINKTANK_DB = join(dir, 'mcp.db');

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createServer } = await import('../src/server.js');
const { startHttp, DEFAULT_HTTP_PORT } = await import('../src/http.js');
const { closeBrain, getBrain } = await import('../src/store.js');

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ok   - ${msg}`);
  else {
    failures++;
    console.error(`  FAIL - ${msg}`);
  }
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
}
function textOf(r: unknown): string {
  const res = r as ToolResult;
  return (res.content ?? [])
    .map((c) => c.text ?? '')
    .join('\n');
}

const TEST_PORT = DEFAULT_HTTP_PORT + 1; // avoid clashing with a running server

async function main() {
  console.log('\nthinktank P3 mcp-server smoke test');
  console.log(`db: ${process.env.THINKTANK_DB}\n`);

  // -------------------------------------------------- in-memory MCP client
  console.log('Scenario 1: MCP tools over in-memory transport');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);

  const client = new Client({ name: 'smoke-client', version: '0.0.0' });
  await client.connect(clientTransport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();
  console.log('  tools:', toolNames.join(', '));
  const expected = [
    'memory_recent',
    'memory_resume',
    'memory_save',
    'memory_search',
    'memory_stats',
  ];
  assert(
    expected.every((n) => toolNames.includes(n)),
    'all five memory tools are listed',
  );

  // ---- auto-use: server instructions + assertive tool descriptions --------
  const instructions = client.getInstructions() ?? '';
  assert(
    /memory_resume/.test(instructions) &&
      /memory_search/.test(instructions) &&
      /memory_save/.test(instructions),
    'server surfaces auto-use instructions naming all three core tools',
  );
  const descOf = (name: string) =>
    tools.tools.find((t) => t.name === name)?.description ?? '';
  assert(/FIRST/.test(descOf('memory_search')), 'memory_search description says call it FIRST');
  assert(/START/.test(descOf('memory_resume')), 'memory_resume description says call at START');
  assert(
    /automatically/i.test(descOf('memory_save')),
    'memory_save description says call automatically',
  );

  const saveRes = await client.callTool({
    name: 'memory_save',
    arguments: {
      text: 'For authentication we use JWT, not sessions.',
      project: 'smoke-proj',
      kind: 'decision',
      tool: 'Cursor',
      source: 'cursor',
    },
  });
  console.log('  save ->', textOf(saveRes).replace(/\n/g, ' | '));
  assert(/remembered/i.test(textOf(saveRes)), 'memory_save reports it remembered');

  const searchRes = await client.callTool({
    name: 'memory_search',
    arguments: { query: 'how do we authenticate users?', project: 'smoke-proj' },
  });
  console.log('  search ->', textOf(searchRes).replace(/\n/g, ' | '));
  assert(
    /JWT/.test(textOf(searchRes)),
    'memory_search recalls the saved JWT decision (semantic match)',
  );

  const statsRes = await client.callTool({ name: 'memory_stats', arguments: {} });
  assert(/total: [1-9]/.test(textOf(statsRes)), 'memory_stats reports >=1 memory');
  assert(
    /journal_mode=wal, busy_timeout=5000ms/.test(textOf(statsRes)),
    'memory_stats shows WAL + busy_timeout',
  );

  // ------------------------------------------ memory_save stores ONE note
  console.log('\nScenario 1b: memory_save keeps a note whole');
  const note =
    'Never run the full cargo test on his Mac. Tag = version. Run only the test file you touched (e.g. tests/parser.rs).';
  const noteRes = await client.callTool({
    name: 'memory_save',
    arguments: { text: note, project: 'notes-proj', kind: 'constraint', source: 'claude-code' },
  });
  assert(
    (textOf(noteRes).match(/remembered/g) ?? []).length === 1,
    'a 3-sentence note is saved as exactly one memory',
  );
  const notesRecent = textOf(
    await client.callTool({ name: 'memory_recent', arguments: { project: 'notes-proj' } }),
  );
  assert(notesRecent.includes(note), 'the stored memory is the whole note, verbatim');

  // ---------------------------------- memory_resume: newest + standing rules
  console.log('\nScenario 1c: memory_resume keeps newest work and old rules');
  const { store } = getBrain();
  const day = 86_400_000;
  await store.save({ source: 'cursor', ts: Date.now() - 90 * day, project: 'resume-proj', text: 'Never push to main without a review.', kind: 'constraint' });
  for (let i = 40; i >= 1; i--) {
    await store.save({ source: 'cursor', ts: Date.now() - i * 60_000, project: 'resume-proj', text: `Decision log ${i}: we picked option ${i} for the importer.`, kind: 'decision' });
  }
  await store.save({ source: 'cursor', ts: Date.now(), project: 'resume-proj', text: 'Newest: the importer refactor is merged.', kind: 'state' });
  const resume = textOf(
    await client.callTool({ name: 'memory_resume', arguments: { project: 'resume-proj' } }),
  );
  console.log(`  resume ->\n${resume.split('\n').map((l) => `    ${l}`).join('\n')}`);
  const firstLine = resume.split('\n')[1] ?? '';
  assert(/Newest: the importer refactor is merged/.test(firstLine), 'the newest memory (a state) leads the resume');
  assert(/Never push to main without a review/.test(resume), 'a 90-day-old constraint is still in the resume');

  // ------------------------------- memory_search: scoped, normalized, fallback
  console.log('\nScenario 1d: memory_search scope + global fallback');
  const normalized = textOf(
    await client.callTool({ name: 'memory_search', arguments: { query: 'how do we authenticate users?', project: 'Smoke_Proj' } }),
  );
  assert(/JWT/.test(normalized), 'project "Smoke_Proj" matches memories saved under "smoke-proj"');
  const fallback = textOf(
    await client.callTool({ name: 'memory_search', arguments: { query: 'how do we authenticate users?', project: 'empty-proj' } }),
  );
  console.log('  fallback ->', fallback.replace(/\n/g, ' | '));
  assert(
    /Possibly related, from other projects:/.test(fallback) && /JWT.*\[project: smoke-proj\]/.test(fallback),
    'a scope with no hits falls back to global semantic results, labelled by project',
  );
  const offTopic = textOf(
    await client.callTool({ name: 'memory_search', arguments: { query: 'how do we authenticate users?', project: 'notes-proj' } }),
  );
  assert(
    !/cargo test/.test(offTopic) && /Possibly related, from other projects:[\s\S]*JWT/.test(offTopic),
    'a scope with only unrelated memories also falls back (no irrelevant scoped hits)',
  );

  // ------------------------------- banner: only genuinely open contradictions
  console.log('\nScenario 1e: contradiction banner');
  await client.callTool({ name: 'memory_save', arguments: { text: 'For authentication, we decided to use sessions.', project: 'banner-proj', kind: 'decision' } });
  const flip = await client.callTool({ name: 'memory_save', arguments: { text: 'For authentication, we now use JWT instead of sessions.', project: 'banner-proj', kind: 'decision' } });
  assert(/superseded older/.test(textOf(flip)), 'a real flip supersedes the older decision');
  const x = await store.save({ source: 'cursor', ts: Date.now() - day, project: 'banner-proj', text: 'Beep watch tiles: Ali chose two tiles on 19 Oct 2026.', kind: 'decision' });
  const y = await store.save({ source: 'cursor', ts: Date.now(), project: 'banner-proj', text: 'Beep request screens use a single small word as the title.', kind: 'decision' });
  store.supersede(x.id, y.id);
  store.logContradiction({ project: 'banner-proj', topic: 'beep', active: store.getById(y.id)!, superseded: store.getById(x.id)! });
  const bannerResume = textOf(
    await client.callTool({ name: 'memory_resume', arguments: { project: 'banner-proj' } }),
  );
  assert(
    /Heads up: 1 unresolved contradiction/.test(bannerResume),
    'the banner counts the real conflict only, not a logged false positive',
  );

  await client.close();
  await server.close();

  // ------------------------------------------------------- HTTP /ingest
  console.log('\nScenario 2: HTTP /ingest capture round-trip');
  const startCommand = 'node /path/to/thinktank/packages/cli/dist/cli.js serve --http';
  const http = await startHttp({ port: TEST_PORT, startCommand });

  const health = await fetch(`http://127.0.0.1:${TEST_PORT}/health`).then((r) =>
    r.json(),
  );
  assert(health.ok === true, '/health responds ok');
  assert(health.startCommand === startCommand, '/health reports how to start the server');

  // A second server on a taken port must fail, not claim to be listening.
  const second = await startHttp({ port: TEST_PORT }).then(
    () => null,
    (err: NodeJS.ErrnoException) => err,
  );
  assert(second?.code === 'EADDRINUSE', 'startHttp rejects with EADDRINUSE on a taken port');

  const ingestResp = await fetch(`http://127.0.0.1:${TEST_PORT}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'chatgpt',
      tool: 'ChatGPT web',
      project: 'smoke-proj',
      conversation: [
        { role: 'user', text: 'What database should we use for the new service?' },
        {
          role: 'assistant',
          text: 'We decided to use PostgreSQL for the new billing service.',
        },
      ],
    }),
  }).then((r) => r.json());
  console.log('  /ingest ->', JSON.stringify(ingestResp));
  assert(ingestResp.ok === true, '/ingest returns ok');
  assert(ingestResp.turns >= 1, '/ingest processed at least one turn');
  assert(
    ingestResp.inserted >= 1,
    '/ingest stored at least one new memory',
  );

  // Confirm it actually landed by reading recent via a fresh MCP client.
  const [ct2, st2] = InMemoryTransport.createLinkedPair();
  const server2 = createServer();
  await server2.connect(st2);
  const client2 = new Client({ name: 'smoke-client-2', version: '0.0.0' });
  await client2.connect(ct2);
  const recent = await client2.callTool({
    name: 'memory_recent',
    arguments: { project: 'smoke-proj', limit: 10 },
  });
  console.log('  recent ->', textOf(recent).replace(/\n/g, ' | '));
  assert(
    /PostgreSQL/i.test(textOf(recent)),
    'captured conversation is now recallable via memory_recent',
  );
  await client2.close();
  await server2.close();

  // Clean teardown: stop the HTTP server, close the DB, then let the event loop
  // drain naturally. Forcing process.exit() here can abort onnxruntime-node mid
  // teardown (mutex error), so we set exitCode instead.
  await http.stop();
  closeBrain();
  rmSync(dir, { recursive: true, force: true });

  console.log(
    failures === 0
      ? '\nP3 PASS - MCP tools + HTTP /ingest capture all work.\n'
      : `\nP3 FAIL - ${failures} assertion(s) failed.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nP3 ERROR:', err);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
