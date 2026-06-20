import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IngestResult, MemoryKind } from '@thinktank/core';
import { getBrain } from './store.js';
import {
  DEFAULT_TOKEN_BUDGET,
  formatMemoryLine,
  packToBudget,
  rankForResume,
  renderMemories,
} from './format.js';

export const SERVER_NAME = 'thinktank';
export const SERVER_VERSION = '0.0.0';

/**
 * Server-level auto-use policy. The MCP SDK surfaces this `instructions` string
 * to the client during initialize, so any client (Cursor, Claude Code, Codex,
 * ...) gets the behavior even with no rules file installed. This is the
 * universal, file-free half of auto-use; the setup command's rule files are the
 * stronger, client-specific reinforcement.
 */
export const SERVER_INSTRUCTIONS = [
  'thinktank is the shared, persistent memory for this user across all their AI tools.',
  'Use these tools PROACTIVELY, without being asked:',
  '1. At the START of every session/task, call memory_resume for the active project to load prior context so you do not ask the user to repeat themselves.',
  "2. BEFORE answering anything about past decisions, preferences, setup, or architecture (\"what did we choose/use/decide\"), call memory_search FIRST and prefer stored answers over guessing.",
  '3. When the user states a durable decision, preference, constraint, or fact, call memory_save WITHOUT being asked.',
  'Never store chit-chat, transient one-off requests, or secrets (API keys, tokens, passwords, credentialed URLs).',
  'project = the repo/folder name being worked in.',
  'The user can also type "tank" or "thinktank" to explicitly ask you to check memory.',
].join('\n');

const KIND_VALUES = [
  'decision',
  'fact',
  'preference',
  'constraint',
  'state',
  'code',
] as const satisfies readonly MemoryKind[];

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

/** Summarize what `ingest()` did to one event, for the save tool's reply. */
function summarizeIngest(results: IngestResult[]): string {
  if (results.length === 0) {
    return 'Nothing durable to remember in that text (filtered as chit-chat).';
  }
  const lines = results.map((r) => {
    if (r.action === 'inserted') return `+ remembered: ${formatMemoryLine(r.memory)}`;
    if (r.action === 'deduped')
      return `= already knew this (merged observation): ${formatMemoryLine(r.memory)}`;
    return `! updated (superseded older): now ${formatMemoryLine(r.memory)}${
      r.superseded ? `\n    was: ${r.superseded.text}` : ''
    }`;
  });
  return lines.join('\n');
}

/**
 * Build a fully-wired thinktank MCP server. Tools are backed by the shared
 * local brain (MemoryStore + MergeEngine). Safe to connect to either a stdio
 * or a Streamable HTTP transport.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // ---- memory_resume -----------------------------------------------------
  server.registerTool(
    'memory_resume',
    {
      title: 'Resume project memory',
      description:
        'Call at the START of every session/task to load the user\'s prior ' +
        'context BEFORE doing substantive work. Returns a small, token-budgeted ' +
        'set of the most important things already known about a project ' +
        '(decisions, constraints, preferences) so you never ask the user to ' +
        'repeat themselves. Do this automatically without being asked.',
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe('Project / repo name to scope memories to.'),
        tokenBudget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Approx token budget (default ${DEFAULT_TOKEN_BUDGET}).`),
      },
    },
    async ({ project, tokenBudget }) => {
      const { store } = getBrain();
      const recent = store.recent(50, project);
      const ranked = rankForResume(recent);
      const body = renderMemories(ranked, tokenBudget ?? DEFAULT_TOKEN_BUDGET);

      const contradictions = store.listContradictions(project);
      const note =
        contradictions.length > 0
          ? `\n\nHeads up: ${contradictions.length} unresolved contradiction(s) on record. ` +
            `Most recent: "${contradictions[0]!.activeText}" (now) vs ` +
            `"${contradictions[0]!.supersededText}" (old).`
          : '';

      const header = project
        ? `Known memory for "${project}":`
        : 'Known memory (all projects):';
      return text(`${header}\n${body}${note}`);
    },
  );

  // ---- memory_search -----------------------------------------------------
  server.registerTool(
    'memory_search',
    {
      title: 'Search memory',
      description:
        "Call this FIRST before answering any question about prior decisions, " +
        "preferences, setup, or \"what did we choose/use/decide\". Prefer stored " +
        'answers over guessing. Semantic + keyword search over stored memories ' +
        '(a past decision, a constraint, a snippet). Returns active memories ' +
        'only, packed to a token budget.',
      inputSchema: {
        query: z.string().describe('What you want to recall.'),
        project: z.string().optional().describe('Restrict to this project.'),
        tokenBudget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Approx token budget (default ${DEFAULT_TOKEN_BUDGET}).`),
      },
    },
    async ({ query, project, tokenBudget }) => {
      const { store } = getBrain();
      const hits = await store.search(query, { project, limit: 20 });
      const packed = packToBudget(hits, tokenBudget ?? DEFAULT_TOKEN_BUDGET);
      if (packed.length === 0) return text(`No memories found for: "${query}".`);
      return text(
        `Memories for "${query}":\n${packed.map(formatMemoryLine).join('\n')}`,
      );
    },
  );

  // ---- memory_save -------------------------------------------------------
  server.registerTool(
    'memory_save',
    {
      title: 'Save to memory',
      description:
        'Call automatically whenever the user states something durable to ' +
        'remember (a decision, constraint, preference, fact, state, or code) — ' +
        'do not wait to be asked. Persists it so other tools/sessions remember ' +
        'it; runs through the merge engine (duplicates merge, conflicts ' +
        'supersede older info). Never save chit-chat or secrets.',
      inputSchema: {
        text: z.string().describe('The thing to remember.'),
        project: z.string().optional().describe('Project / repo scope.'),
        kind: z
          .enum(KIND_VALUES)
          .optional()
          .describe('Optional memory kind; auto-classified if omitted.'),
        tool: z.string().optional().describe('Tool that produced this.'),
        model: z.string().optional().describe('Model that produced this.'),
        source: z
          .string()
          .optional()
          .describe('Origin label, e.g. cursor, claude-code, codex, manual.'),
      },
    },
    async ({ text: content, project, kind, tool, model, source }) => {
      const { engine } = getBrain();
      const results = await engine.ingest({
        source: source ?? tool?.toLowerCase() ?? 'manual',
        tool,
        model,
        ts: Date.now(),
        project,
        text: content,
        kind,
      });
      return text(summarizeIngest(results));
    },
  );

  // ---- memory_recent -----------------------------------------------------
  server.registerTool(
    'memory_recent',
    {
      title: 'Recent memories',
      description: 'List the most recently observed active memories.',
      inputSchema: {
        project: z.string().optional().describe('Restrict to this project.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe('Max items (default 10).'),
      },
    },
    async ({ project, limit }) => {
      const { store } = getBrain();
      const mems = store.recent(limit ?? 10, project);
      if (mems.length === 0) return text('No memories yet.');
      return text(mems.map(formatMemoryLine).join('\n'));
    },
  );

  // ---- memory_stats ------------------------------------------------------
  server.registerTool(
    'memory_stats',
    {
      title: 'Memory stats',
      description: 'Counts by kind/status, contradictions, and the DB path.',
      inputSchema: {},
    },
    async () => {
      const { store, dbPath } = getBrain();
      const s = store.stats();
      const byKind = Object.entries(s.byKind)
        .map(([k, c]) => `${k}=${c}`)
        .join(', ');
      return text(
        [
          `db: ${dbPath}`,
          `total: ${s.total} (active ${s.active}, superseded ${s.superseded})`,
          `contradictions: ${s.contradictions}`,
          `by kind (active): ${byKind || 'none'}`,
        ].join('\n'),
      );
    },
  );

  return server;
}
