/**
 * P4 export-parser test: prove the ChatGPT (mapping-tree) and Claude
 * (chat_messages) parsers reconstruct ordered turns, handle messy real-world
 * nodes (system primers, hidden messages, multimodal/structured content,
 * tool-use blocks), and feed the merge engine end-to-end - including a
 * cross-source conflict (Claude "sessions" superseded by ChatGPT "JWT").
 *
 * Run: pnpm --filter @thinktank/ingest test
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, MergeEngine } from '@thinktank/core';
import type { IngestResult } from '@thinktank/core';
import {
  detectFormat,
  parseChatGPTExport,
  parseClaudeExport,
  parseExport,
} from '../src/index.js';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ok   - ${msg}`);
  else {
    failures++;
    console.error(`  FAIL - ${msg}`);
  }
}

// ----------------------------------------------------------------- fixtures
const CG_BASE = Math.floor(Date.parse('2026-03-01T00:00:00Z') / 1000); // seconds

/** A ChatGPT export: a single conversation with a realistic mapping tree. */
const chatgptExport = [
  {
    title: 'Billing service planning',
    create_time: CG_BASE,
    update_time: CG_BASE + 300,
    current_node: 'n4',
    mapping: {
      n0: { id: 'n0', parent: null, children: ['n1'], message: null },
      n1: {
        id: 'n1',
        parent: 'n0',
        children: ['n2'],
        message: {
          author: { role: 'system' },
          create_time: CG_BASE + 1,
          content: { content_type: 'text', parts: ['You are a helpful assistant.'] },
          metadata: { is_visually_hidden_from_conversation: true },
        },
      },
      n2: {
        id: 'n2',
        parent: 'n1',
        children: ['n3'],
        message: {
          author: { role: 'user' },
          create_time: CG_BASE + 2,
          content: { content_type: 'text', parts: ['We are building the billing service this quarter.'] },
          metadata: {},
        },
      },
      n3: {
        id: 'n3',
        parent: 'n2',
        children: ['n4'],
        message: {
          author: { role: 'assistant' },
          create_time: CG_BASE + 3,
          // multimodal: an image pointer (no text) plus a text part.
          content: {
            content_type: 'multimodal_text',
            parts: [
              { content_type: 'image_asset_pointer', asset_pointer: 'file-abc' },
              'Here is the plan: we should use Stripe for payments.',
            ],
          },
          metadata: { model_slug: 'gpt-5' },
        },
      },
      n4: {
        id: 'n4',
        parent: 'n3',
        children: [],
        message: {
          author: { role: 'user' },
          create_time: CG_BASE + 4,
          content: { content_type: 'text', parts: ['For authentication, we now use JWT instead of sessions.'] },
          metadata: {},
        },
      },
    },
  },
];

const CL_CREATED = '2026-02-01T00:00:00Z';

/** A Claude.ai export: a single conversation with structured content blocks. */
const claudeExport = [
  {
    uuid: 'c-1',
    name: 'Auth approach',
    created_at: CL_CREATED,
    updated_at: CL_CREATED,
    chat_messages: [
      {
        uuid: 'm1',
        sender: 'human',
        text: 'Should we use sessions or JWT for auth?',
        created_at: CL_CREATED,
      },
      {
        uuid: 'm2',
        sender: 'assistant',
        created_at: '2026-02-01T00:00:05Z',
        content: [
          { type: 'thinking', text: 'weighing the options' },
          { type: 'text', text: 'For authentication, we decided to use sessions.' },
          { type: 'tool_use', name: 'search', input: {} },
        ],
      },
      {
        uuid: 'm3',
        sender: 'assistant',
        created_at: '2026-02-01T00:00:10Z',
        // empty/structured-only message -> should be skipped (no text block).
        content: [{ type: 'tool_result', content: 'ok' }],
      },
      {
        uuid: 'm4',
        sender: 'human',
        created_at: '2026-02-01T00:00:15Z',
        content: [{ type: 'text', text: 'Sounds good, ship it.' }],
      },
    ],
  },
];

async function main() {
  console.log('\nthinktank P4 export-parser test\n');

  // ---------------------------------------------------------- detection
  console.log('Detection:');
  assert(detectFormat(chatgptExport) === 'chatgpt', 'ChatGPT export detected by `mapping`');
  assert(detectFormat(claudeExport) === 'claude', 'Claude export detected by `chat_messages`');
  assert(detectFormat([{ foo: 'bar' }]) === null, 'unknown shape detected as null');

  // ------------------------------------------------------ ChatGPT parser
  console.log('\nChatGPT parser:');
  const cg = parseChatGPTExport(chatgptExport, { project: 'billing' });
  assert(cg.conversationsFound === 1, 'one conversation found');
  assert(cg.events.length === 3, 'system + hidden node dropped -> 3 kept turns');
  assert(
    !!cg.events[0] && cg.events[0].text.includes('billing service'),
    'turn 1 is the user billing message (correct order)',
  );
  assert(
    !!cg.events[1] &&
      cg.events[1].text === 'Here is the plan: we should use Stripe for payments.',
    'turn 2 extracts only the text part of multimodal content (image ignored)',
  );
  assert(
    !!cg.events[2] && cg.events[2].text.includes('JWT instead of sessions'),
    'turn 3 is the final user JWT decision',
  );
  assert(
    cg.events.every((e) => e.source === 'chatgpt' && e.tool === 'chatgpt-web'),
    'events tagged source=chatgpt tool=chatgpt-web',
  );
  assert(cg.events[1]?.model === 'gpt-5', 'assistant model_slug captured');
  assert(
    cg.events.every((e) => e.project === 'billing'),
    'project override applied to every event',
  );
  assert(
    !!cg.events[0] && cg.events[0].ts < cg.events[2]!.ts,
    'per-message timestamps preserved in order',
  );

  // -------------------------------------------------------- Claude parser
  console.log('\nClaude parser:');
  const cl = parseClaudeExport(claudeExport, { project: 'auth' });
  assert(cl.conversationsFound === 1, 'one conversation found');
  assert(cl.events.length === 3, 'tool-only message skipped -> 3 kept turns');
  assert(cl.events[0]?.role === 'user', 'human sender mapped to role=user');
  assert(cl.events[1]?.role === 'assistant', 'assistant sender mapped to role=assistant');
  assert(
    !!cl.events[1] && cl.events[1].text === 'For authentication, we decided to use sessions.',
    'structured content: only the text block kept (thinking + tool_use dropped)',
  );
  assert(
    !!cl.events[2] && cl.events[2].text === 'Sounds good, ship it.',
    'content-array human turn flattened to text',
  );
  assert(
    cl.events.every((e) => e.source === 'claude' && e.tool === 'claude-web'),
    'events tagged source=claude tool=claude-web',
  );

  // -------------------------------------------------- parseExport dispatch
  console.log('\nDispatcher:');
  assert(parseExport(chatgptExport).format === 'chatgpt', 'parseExport auto-routes ChatGPT');
  assert(parseExport(claudeExport).format === 'claude', 'parseExport auto-routes Claude');
  let threw = false;
  try {
    parseExport([{ nope: true }]);
  } catch {
    threw = true;
  }
  assert(threw, 'parseExport throws on unrecognized payload');

  // --------------------------------------- end-to-end merge + cross-source
  console.log('\nEnd-to-end ingest + cross-source conflict:');
  const dir = mkdtempSync(join(tmpdir(), 'thinktank-ingest-'));
  const dbPath = join(dir, 'ingest.db');
  const store = new MemoryStore(dbPath);
  const engine = new MergeEngine(store);

  // Build two single-decision exports scoped to the same project. Claude says
  // "sessions" (earlier); ChatGPT says "JWT instead of sessions" (later).
  const claudeSessions = [
    {
      uuid: 'cc',
      name: 'auth',
      created_at: '2026-01-01T00:00:00Z',
      chat_messages: [
        {
          uuid: 'x',
          sender: 'assistant',
          created_at: '2026-01-01T00:00:00Z',
          text: 'For authentication, we decided to use sessions.',
        },
      ],
    },
  ];
  const claudeMs = Date.parse('2026-01-01T00:00:00Z');
  const chatgptJwt = [
    {
      title: 'auth',
      create_time: Math.floor(claudeMs / 1000) + 86_400, // a day later
      current_node: 'a1',
      mapping: {
        a0: { id: 'a0', parent: null, children: ['a1'], message: null },
        a1: {
          id: 'a1',
          parent: 'a0',
          children: [],
          message: {
            author: { role: 'assistant' },
            create_time: Math.floor(claudeMs / 1000) + 86_400,
            content: {
              content_type: 'text',
              parts: ['For authentication, we now use JWT instead of sessions.'],
            },
            metadata: {},
          },
        },
      },
    },
  ];

  const claudeParsed = parseExport(claudeSessions, { project: 'xsrc' });
  const chatgptParsed = parseExport(chatgptJwt, { project: 'xsrc' });

  let inserted = 0;
  let superseded = 0;
  const runAll = async (events: typeof claudeParsed.events) => {
    for (const ev of events) {
      const results: IngestResult[] = await engine.ingest(ev);
      for (const r of results) {
        if (r.action === 'inserted') inserted++;
        else if (r.action === 'superseded') superseded++;
      }
    }
  };

  await runAll(claudeParsed.events); // sessions first (older)
  await runAll(chatgptParsed.events); // JWT later -> should supersede

  assert(inserted >= 1, 'sessions decision inserted from the Claude export');
  assert(superseded === 1, 'JWT decision from ChatGPT export supersedes sessions');

  const conflicts = store.listContradictions('xsrc');
  assert(conflicts.length === 1, 'one cross-source contradiction logged');
  assert(
    !!conflicts[0] &&
      conflicts[0].activeSource === 'chatgpt' &&
      conflicts[0].supersededSource === 'claude',
    'contradiction records chatgpt (active) vs claude (superseded)',
  );

  const hits = await store.search('what auth method do we use?', {
    project: 'xsrc',
    limit: 3,
  });
  assert(
    !!hits[0] && hits[0].text.includes('JWT'),
    'retrieval returns the active JWT decision across sources',
  );

  store.close();
  rmSync(dir, { recursive: true, force: true });

  console.log(
    failures === 0
      ? '\nP4 PASS - ChatGPT + Claude export parsing and cross-source merge all work.\n'
      : `\nP4 FAIL - ${failures} assertion(s) failed.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nP4 ERROR:', err);
  process.exitCode = 1;
});
