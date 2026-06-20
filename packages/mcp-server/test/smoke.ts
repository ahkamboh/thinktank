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
const { closeBrain } = await import('../src/store.js');

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

  await client.close();
  await server.close();

  // ------------------------------------------------------- HTTP /ingest
  console.log('\nScenario 2: HTTP /ingest capture round-trip');
  const http = await startHttp({ port: TEST_PORT });

  const health = await fetch(`http://127.0.0.1:${TEST_PORT}/health`).then((r) =>
    r.json(),
  );
  assert(health.ok === true, '/health responds ok');

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
