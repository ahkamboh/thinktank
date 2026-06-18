#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { startStdio, startHttp, ingestConversation, getBrain, closeBrain } from '@thinktank/mcp-server';
import type { IngestBody } from '@thinktank/mcp-server';
import { resolveDbPath } from '@thinktank/mcp-server';
import { parseExport, UnknownExportError } from '@thinktank/ingest';
import type { ExportFormat } from '@thinktank/ingest';
import { setupAgent, type Agent } from './setup.js';
import { runDemo } from './demo.js';
import { startDashboard, DEFAULT_DASHBOARD_PORT } from './dashboard.js';
import { runReprocess } from './reprocess.js';

const HELP = `thinktank - one private memory brain for all your AI agents

Usage:
  thinktank serve                 Start the MCP server over stdio (for IDEs).
  thinktank serve --http [--port=N]
                                  Start the local HTTP server (MCP + /ingest
                                  capture endpoint for the browser extension).
  thinktank setup --cursor|--claude|--codex [...]
                                  Wire thinktank into one or more agents' MCP
                                  config so they share this memory.
  thinktank ingest <file.json> [--project=NAME] [--source=chatgpt|claude]
                                  Import a ChatGPT or Claude.ai data export (or
                                  a captured-conversation JSON) into memory.
  thinktank dashboard [--port=N] [--open]
                                  Open the local web dashboard to browse, search,
                                  and manage memories (default port ${DEFAULT_DASHBOARD_PORT}).
  thinktank reprocess [--apply] [--sample=N] [--limit=N] [--project=NAME]
                                  Re-judge stored memories: drop non-durable
                                  noise and fix kinds. DRY RUN by default;
                                  pass --apply to write. Uses the LLM extractor
                                  when an API key is set, else the heuristic.
  thinktank demo                  Run a narrated, self-contained end-to-end demo
                                  (uses a throwaway db; touches nothing real).
  thinktank help                  Show this help.

Env:
  THINKTANK_DB                    Override the database path
                                  (default: ${resolveDbPath()}).
  ANTHROPIC_API_KEY / OPENAI_API_KEY
                                  Enable high-quality LLM extraction/reprocess.
  THINKTANK_EXTRACT_MODEL         Override the extraction model.
`;

function getFlagNumber(args: string[], name: string): number | undefined {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? Number(p.split('=')[1]) : undefined;
}

function getFlagString(args: string[], name: string): string | undefined {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(`--${name}=`.length) : undefined;
}

async function cmdServe(args: string[]): Promise<void> {
  if (args.includes('--http')) {
    await startHttp({ port: getFlagNumber(args, 'port') });
  } else {
    await startStdio();
  }
}

async function cmdDashboard(args: string[]): Promise<void> {
  const handle = await startDashboard({
    port: getFlagNumber(args, 'port'),
    open: args.includes('--open'),
  });
  console.error(
    `thinktank dashboard ready -> ${handle.url}\nPress Ctrl+C to stop.`,
  );
  // Keep the process alive; the server's SIGINT/SIGTERM handlers stop it.
}

function cmdSetup(args: string[]): void {
  const agents: Agent[] = [];
  if (args.includes('--cursor')) agents.push('cursor');
  if (args.includes('--claude')) agents.push('claude');
  if (args.includes('--codex')) agents.push('codex');

  if (agents.length === 0) {
    console.error('setup: specify at least one of --cursor --claude --codex\n');
    console.error(HELP);
    process.exit(1);
  }

  for (const agent of agents) {
    const r = setupAgent(agent);
    console.log(`\n[${r.agent}] wrote MCP config -> ${r.path}`);
    console.log(r.snippet);
    console.log(`Verify: ${r.verify}`);
  }
  console.log(
    `\nMemory database: ${resolveDbPath()}\nDone. Restart the agent(s) to pick up thinktank.`,
  );
}

async function cmdIngest(args: string[]): Promise<void> {
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) {
    console.error('ingest: provide a JSON file path.');
    process.exit(1);
  }
  const project = getFlagString(args, 'project');
  const sourceFlag = getFlagString(args, 'source') as ExportFormat | undefined;
  if (sourceFlag && sourceFlag !== 'chatgpt' && sourceFlag !== 'claude') {
    console.error(`ingest: --source must be 'chatgpt' or 'claude'.`);
    process.exit(1);
  }

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`ingest: could not read/parse ${file}: ${String(err)}`);
    process.exit(1);
  }

  // First try the official ChatGPT/Claude export formats (auto-detected, or
  // forced via --source). Fall back to the captured-conversation shape the
  // browser extension posts if the payload isn't a recognized export.
  try {
    const parsed = parseExport(json, { project, format: sourceFlag });
    const { engine, store } = getBrain();
    const before = store.stats().contradictions;
    let candidates = 0;
    let inserted = 0;
    let deduped = 0;
    let superseded = 0;
    for (const event of parsed.events) {
      const results = await engine.ingest(event);
      candidates += results.length;
      for (const r of results) {
        if (r.action === 'inserted') inserted++;
        else if (r.action === 'deduped') deduped++;
        else superseded++;
      }
    }
    const newConflicts = store.stats().contradictions - before;
    console.log(
      `Imported ${parsed.source} export: ${parsed.conversations.length} ` +
        `conversation(s), ${parsed.events.length} turn(s).`,
    );
    console.log(
      `Extracted ${candidates} memory candidate(s): ` +
        `${inserted} new, ${deduped} merged, ${superseded} updated` +
        (newConflicts > 0 ? `, ${newConflicts} contradiction(s) found.` : '.'),
    );
  } catch (err) {
    if (!(err instanceof UnknownExportError)) throw err;
    // Not a known export - treat as a captured-conversation payload.
    const summary = await ingestConversation(json as IngestBody);
    console.log(
      `Ingested ${summary.turns} captured turn(s): ` +
        `${summary.inserted} new, ${summary.deduped} merged, ${summary.superseded} updated.`,
    );
  }
  // Close the brain and let the process exit naturally. Calling process.exit()
  // here can abort the native embedding runtime mid-teardown (SIGABRT).
  closeBrain();
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'serve':
      await cmdServe(rest);
      break;
    case 'setup':
      cmdSetup(rest);
      break;
    case 'ingest':
      await cmdIngest(rest);
      break;
    case 'dashboard':
      await cmdDashboard(rest);
      break;
    case 'reprocess':
      await runReprocess({
        apply: rest.includes('--apply'),
        limit: getFlagNumber(rest, 'limit'),
        sample: getFlagNumber(rest, 'sample'),
        project: getFlagString(rest, 'project'),
      });
      break;
    case 'demo':
      await runDemo();
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('thinktank error:', err);
  process.exit(1);
});
