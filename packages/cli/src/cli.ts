#!/usr/bin/env node
import {
  startStdio,
  startHttp,
  ingestConversation,
  getBrain,
  closeBrain,
  DEFAULT_HTTP_PORT,
} from '@thinktank/mcp-server';
import type { IngestBody } from '@thinktank/mcp-server';
import { resolveDbPath } from '@thinktank/mcp-server';
import { parseExport, UnknownExportError } from '@thinktank/ingest';
import type { ExportFormat } from '@thinktank/ingest';
import { ALL_AGENTS, cliCommand, repairAgent, setupAgent, type Agent } from './setup.js';
import { installDaemon, uninstallDaemon } from './daemon.js';
import { runDemo } from './demo.js';
import { startDashboard, DEFAULT_DASHBOARD_PORT } from './dashboard.js';
import { loadExportFromPath, ImportInputError } from './export-source.js';
import { runReprocess } from './reprocess.js';

const HELP = `thinktank - one private memory brain for all your AI agents

Usage:
  thinktank serve                 Start the MCP server over stdio (for IDEs).
  thinktank serve --http [--port=N]
                                  Start the local HTTP server (MCP + /ingest
                                  capture endpoint for the browser extension).
  thinktank setup --cursor|--claude|--claude-desktop|--codex [--no-rules]
                                  Wire thinktank into one or more agents' MCP
                                  config so they share this memory. Also installs
                                  a behavioral "auto-use" rule per agent so it
                                  calls the memory tools automatically; pass
                                  --no-rules to wire the server only.
  thinktank setup --repair [--cursor|--claude|--claude-desktop|--codex]
                                  Fix existing thinktank entries whose node or
                                  CLI path no longer exists (e.g. after
                                  \`brew upgrade node\`). Checks every client
                                  unless you name some. Leaves working entries
                                  alone.
  thinktank setup --daemon [--port=N]
                                  macOS: install a LaunchAgent that keeps
                                  \`serve --http\` running (starts at login,
                                  restarts if it exits) for the browser
                                  extension.
  thinktank setup --uninstall-daemon
                                  Stop and remove that LaunchAgent.
  thinktank ingest <path> [--project=NAME] [--source=chatgpt|claude]
                                  Import a ChatGPT or Claude.ai data export into
                                  memory. <path> may be the unzipped export
                                  DIRECTORY (reads its conversations.json), the
                                  export .zip, a conversations.json, or a
                                  captured-conversation JSON.
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
  NODE_OPTIONS=--max-old-space-size=4096
                                  Raise Node's heap for very large exports
                                  (a ~130MB conversations.json needs ~1GB heap
                                  to parse; the default is usually enough on
                                  64-bit machines).
`;

function getFlagNumber(args: string[], name: string): number | undefined {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? Number(p.split('=')[1]) : undefined;
}

function getFlagString(args: string[], name: string): string | undefined {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(`--${name}=`.length) : undefined;
}

/** The command that starts the HTTP server, as a person would type it. */
function httpStartCommand(port?: number): string {
  const portFlag = port && port !== DEFAULT_HTTP_PORT ? ` --port=${port}` : '';
  return cliCommand(`serve --http${portFlag}`);
}

async function cmdServe(args: string[]): Promise<void> {
  if (!args.includes('--http')) {
    await startStdio();
    return;
  }
  const port = getFlagNumber(args, 'port');
  try {
    await startHttp({ port, startCommand: httpStartCommand(port) });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    const p = port ?? DEFAULT_HTTP_PORT;
    console.error(
      `[thinktank] port ${p} is already in use. Is thinktank already running? ` +
        `Check: curl http://127.0.0.1:${p}/health`,
    );
    process.exit(1);
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
  if (args.includes('--claude-desktop')) agents.push('claude-desktop');
  if (args.includes('--codex')) agents.push('codex');
  const repair = args.includes('--repair');
  const daemon = args.includes('--daemon');
  const uninstall = args.includes('--uninstall-daemon');

  if (agents.length === 0 && !repair && !daemon && !uninstall) {
    console.error(
      'setup: specify at least one of --cursor --claude --claude-desktop --codex, ' +
        'or --repair, --daemon, --uninstall-daemon\n',
    );
    console.error(HELP);
    process.exit(1);
  }
  if (daemon && uninstall) {
    console.error('setup: pass either --daemon or --uninstall-daemon, not both.');
    process.exit(1);
  }

  if (repair) repairConfigs(agents.length ? agents : [...ALL_AGENTS]);
  else if (agents.length) wireAgents(agents, !args.includes('--no-rules'));
  if (daemon) setupDaemon(getFlagNumber(args, 'port'));
  if (uninstall) removeDaemon();
}

function wireAgents(agents: Agent[], installRules: boolean): void {
  const written: string[] = [];

  for (const agent of agents) {
    const r = setupAgent(agent, { installRules });
    console.log(`\n[${r.agent}] wrote MCP config -> ${r.path}`);
    console.log(r.snippet);
    console.log(`Verify: ${r.verify}`);
    if (r.warning) console.log(`Note: ${r.warning}`);
    written.push(`${r.agent} MCP config: ${r.path}`);
    if (r.rule) {
      console.log(`[${r.agent}] auto-use rule ${r.rule.status} -> ${r.rule.path}`);
      written.push(`${r.agent} auto-use rule (${r.rule.status}): ${r.rule.path}`);
    }
    if (r.manualRule) console.log(`[${r.agent}] ${r.manualRule}`);
  }

  console.log('\nFiles written:');
  for (const w of written) console.log(`  - ${w}`);

  if (installRules) {
    console.log(
      '\nAuto-use is now installed via behavioral rules + the server\'s own ' +
        'instructions, so agents resume/search/save memory without being asked. ' +
        'Honest note: this raises adherence to ~90%, not a hard guarantee ' +
        '(a transparent MCP proxy would make it 100%). Tip: type "tank" or ' +
        '"thinktank" to force a memory check.',
    );
  } else {
    console.log(
      '\nSkipped behavioral rule install (--no-rules): the memory tools are ' +
        'wired, but agents will not call them automatically. The server still ' +
        'ships auto-use instructions, so adherence is lower but non-zero.',
    );
  }

  console.log(
    `\nMemory database: ${resolveDbPath()}\nDone. Restart the agent(s) to pick up thinktank.`,
  );
}

function repairConfigs(agents: Agent[]): void {
  let repaired = 0;
  for (const agent of agents) {
    const r = repairAgent(agent);
    if (r.status === 'repaired') {
      repaired++;
      console.log(`[${r.agent}] repaired ${r.path}\n  was: ${r.reason}\n  now: ${r.command}`);
    } else if (r.status === 'ok') {
      console.log(`[${r.agent}] ok: ${r.path}`);
    } else {
      console.log(`[${r.agent}] no thinktank entry, skipped`);
    }
  }
  console.log(
    repaired
      ? `\nRepaired ${repaired} config(s). Restart those apps to reconnect thinktank.`
      : '\nNothing to repair.',
  );
}

function setupDaemon(port?: number): void {
  if (process.platform !== 'darwin') {
    console.error(
      'setup --daemon installs a macOS LaunchAgent, so it only works on macOS. ' +
        `Elsewhere, run this under your own service manager:\n  ${httpStartCommand(port)}`,
    );
    process.exit(1);
  }
  const r = installDaemon({ port });
  console.log(`\n[daemon] LaunchAgent installed -> ${r.plistPath}`);
  console.log(`  runs: ${r.programArguments.join(' ')}`);
  console.log(`  log:  ${r.logPath}`);
  console.log('  It is running now, starts at every login, and restarts if it exits.');
  console.log(`  Check:  curl http://127.0.0.1:${port ?? DEFAULT_HTTP_PORT}/health`);
  console.log(`  Remove: ${cliCommand('setup --uninstall-daemon')}`);
}

function removeDaemon(): void {
  if (process.platform !== 'darwin') {
    console.error('setup --uninstall-daemon: there is no LaunchAgent outside macOS.');
    process.exit(1);
  }
  const r = uninstallDaemon();
  console.log(
    r.removed
      ? `[daemon] stopped and removed ${r.plistPath}`
      : `[daemon] no LaunchAgent at ${r.plistPath}; made sure none is loaded.`,
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
    // Accepts an unzipped export directory (reads conversations.json), an
    // export .zip, or a JSON file. Large exports (~130MB) parse fine under
    // Node's default heap; see NODE_OPTIONS in `thinktank help` if you hit OOM.
    json = loadExportFromPath(file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      err instanceof ImportInputError
        ? `ingest: ${msg}`
        : `ingest: could not read/parse ${file}: ${msg}`,
    );
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
