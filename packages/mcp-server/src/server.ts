import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openContradictions } from '@thinktank/core';
import type { IngestResult, Memory, MemoryKind, MemoryStore } from '@thinktank/core';
import { getBrain } from './store.js';
import {
  DEFAULT_TOKEN_BUDGET,
  RESUME_LINE_MAX_CHARS,
  formatMemoryLine,
  rankForResume,
  renderWithRelated,
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

/** A scoped resume with fewer memories than this also shows related ones. */
export const RESUME_MIN_SCOPED = 5;

/** A scoped search with fewer hits than this also searches other projects. */
export const SEARCH_MIN_SCOPED = 3;

/**
 * Search hits less similar than this (cosine) are dropped unless they matched
 * a query keyword. On MiniLM, unrelated memories score ~0.0-0.2 and relevant
 * ones ~0.3+, so a scope with nothing relevant reads as empty and falls back.
 */
export const SEARCH_MIN_COSINE = 0.25;

/** Cross-project fallback hits must be at least this semantically close. */
export const RELATED_MIN_COSINE = 0.3;

/** "fundedroll_landingpage" -> "fundedroll landingpage": a project name as a query. */
function projectAsQuery(project: string): string {
  return project.replace(/[-_./]+/g, ' ').trim();
}

/**
 * Global semantic fallback for a thin project scope: close matches from OTHER
 * projects (every spelling/alias of `project` is excluded - those were already
 * searched), so a new or misnamed project still gets useful context.
 */
async function relatedFromOtherProjects(
  store: MemoryStore,
  query: string,
  project: string,
  exclude: Set<number>,
  limit = 8,
): Promise<Memory[]> {
  const same = new Set(store.projectVariants(project));
  const hits = await store.search(query, { limit: 30, minCosine: RELATED_MIN_COSINE });
  return hits
    .filter(
      (h) =>
        !exclude.has(h.id) &&
        !(h.project !== null && same.has(h.project)) &&
        (h.cosine ?? 0) >= RELATED_MIN_COSINE,
    )
    .slice(0, limit);
}

function clip(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
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
      // Newest saves + every standing constraint/preference + recent decisions,
      // shown newest-first, then rules, then decisions.
      const ranked = rankForResume(store.resumeCandidates(project));
      const related =
        project && ranked.length < RESUME_MIN_SCOPED
          ? await relatedFromOtherProjects(
              store,
              projectAsQuery(project),
              project,
              new Set(ranked.map((m) => m.id)),
            )
          : [];
      const body =
        renderWithRelated(ranked, related, tokenBudget ?? DEFAULT_TOKEN_BUDGET, {
          maxChars: RESUME_LINE_MAX_CHARS,
        }) || 'No matching memories yet.';

      const open = openContradictions(store, project);
      const note =
        open.length > 0
          ? `\n\nHeads up: ${open.length} unresolved contradiction(s) on record. ` +
            `Most recent: "${clip(open[0]!.activeText)}" (now) vs ` +
            `"${clip(open[0]!.supersededText)}" (old).`
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
      const hits = await store.search(query, {
        project,
        limit: 20,
        minCosine: SEARCH_MIN_COSINE,
      });
      const related =
        project && hits.length < SEARCH_MIN_SCOPED
          ? await relatedFromOtherProjects(
              store,
              query,
              project,
              new Set(hits.map((h) => h.id)),
            )
          : [];
      const body = renderWithRelated(hits, related, tokenBudget ?? DEFAULT_TOKEN_BUDGET);
      if (!body) return text(`No memories found for: "${query}".`);
      return text(`Memories for "${query}":\n${body}`);
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
        'it. The text is stored as one memory, as written (write a ' +
        'self-contained note, up to ~2,000 characters); duplicates merge and ' +
        'a short statement that contradicts an older one supersedes it. Never ' +
        'save chit-chat or secrets.',
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
      // An explicit save is ONE memory, as written - not split into sentences.
      const results = await engine.ingest(
        {
          source: source ?? tool?.toLowerCase() ?? 'manual',
          tool,
          model,
          ts: Date.now(),
          project,
          text: content,
          kind,
        },
        { mode: 'note' },
      );
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
      return text(mems.map((m) => formatMemoryLine(m)).join('\n'));
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
      const sql = store.sqliteInfo();
      const byKind = Object.entries(s.byKind)
        .map(([k, c]) => `${k}=${c}`)
        .join(', ');
      return text(
        [
          `db: ${dbPath}`,
          `total: ${s.total} (active ${s.active}, superseded ${s.superseded})`,
          `contradictions: ${s.contradictions}`,
          `by kind (active): ${byKind || 'none'}`,
          `sqlite: journal_mode=${sql.journalMode}, busy_timeout=${sql.busyTimeoutMs}ms`,
        ].join('\n'),
      );
    },
  );

  return server;
}
