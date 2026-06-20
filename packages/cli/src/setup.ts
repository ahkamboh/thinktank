import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  SECTION_BEGIN,
  SECTION_END,
  cursorRuleFile,
  delimitedSection,
} from './auto-use-text.js';

export type Agent = 'cursor' | 'claude' | 'codex';

export interface McpInvocation {
  command: string;
  args: string[];
}

/**
 * How an IDE should launch the thinktank stdio server. We use the current
 * Node binary plus the absolute path to the compiled CLI so it works without a
 * global install. Once published, this could become `npx -y @thinktank/cli serve`.
 */
export function mcpInvocation(): McpInvocation {
  const cliEntry = fileURLToPath(new URL('./cli.js', import.meta.url));
  // Silence node:sqlite's ExperimentalWarning so it doesn't pollute the IDE's
  // MCP server logs. (Node flags must precede the script path.)
  return {
    command: process.execPath,
    args: ['--no-warnings=ExperimentalWarning', cliEntry, 'serve'],
  };
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch (err) {
    throw new Error(`Could not parse ${path}: ${String(err)}`);
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** Merge a `mcpServers.thinktank` block into an existing JSON config file. */
function mergeMcpServersJson(path: string, inv: McpInvocation): void {
  const cfg = readJson(path);
  const servers = (cfg.mcpServers ??= {}) as Record<string, unknown>;
  servers.thinktank = { command: inv.command, args: inv.args };
  writeJson(path, cfg);
}

/** Outcome of writing the behavioral auto-use rule for a client. */
export type RuleStatus = 'created' | 'updated' | 'unchanged' | 'appended';

export interface RuleResult {
  /** Absolute path of the rule/instructions file that was touched. */
  path: string;
  /** What happened: created new, updated in place, appended, or no change. */
  status: RuleStatus;
}

export interface SetupResult {
  agent: Agent;
  path: string;
  snippet: string;
  verify: string;
  /** Present when the auto-use behavioral rule was installed (not --no-rules). */
  rule?: RuleResult;
}

export interface SetupOptions {
  /** Install the behavioral auto-use rule too. Default: true. */
  installRules?: boolean;
  /**
   * Directory the Cursor project rule is written into (its `.cursor/rules/`).
   * Defaults to the process CWD so it applies to the repo setup is run in.
   */
  cwd?: string;
}

const CODEX_MARKER = '[mcp_servers.thinktank]';

function tomlValue(inv: McpInvocation): string {
  const args = inv.args.map((a) => JSON.stringify(a)).join(', ');
  return `${CODEX_MARKER}\ncommand = ${JSON.stringify(inv.command)}\nargs = [${args}]\n`;
}

/** Write only the MCP server connection for one agent (no behavioral rule). */
function writeMcpConfig(agent: Agent): SetupResult {
  const inv = mcpInvocation();
  const home = homedir();

  if (agent === 'cursor') {
    const path = join(home, '.cursor', 'mcp.json');
    mergeMcpServersJson(path, inv);
    return {
      agent,
      path,
      snippet: JSON.stringify(
        { mcpServers: { thinktank: { command: inv.command, args: inv.args } } },
        null,
        2,
      ),
      verify:
        'Restart Cursor, then open Settings -> MCP. "thinktank" should be listed ' +
        'with its tools (memory_resume, memory_search, ...).',
    };
  }

  if (agent === 'claude') {
    const path = join(home, '.claude.json');
    mergeMcpServersJson(path, inv);
    return {
      agent,
      path,
      snippet: JSON.stringify(
        { mcpServers: { thinktank: { command: inv.command, args: inv.args } } },
        null,
        2,
      ),
      verify:
        'Run `claude mcp list` (or restart Claude Code). "thinktank" should ' +
        'appear as a connected stdio server.',
    };
  }

  // codex - TOML
  const path = join(home, '.codex', 'config.toml');
  const block = tomlValue(inv);
  let existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (existing.includes(CODEX_MARKER)) {
    // Already configured - leave the file untouched, just report.
  } else {
    mkdirSync(dirname(path), { recursive: true });
    const sep = existing.length && !existing.endsWith('\n') ? '\n\n' : existing.length ? '\n' : '';
    existing = existing + sep + block;
    writeFileSync(path, existing, 'utf8');
  }
  return {
    agent,
    path,
    snippet: block.trimEnd(),
    verify:
      'Restart Codex. Run `codex` and check that the "thinktank" MCP server ' +
      'connects (it will expose the memory_* tools).',
  };
}

/**
 * Write a fully-managed file idempotently (thinktank owns the whole file).
 * Returns whether it was created, updated (content changed), or left unchanged.
 */
function writeManagedFile(path: string, content: string): RuleStatus {
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === content) return 'unchanged';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    return 'updated';
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return 'created';
}

/**
 * Insert or replace thinktank's delimited managed section inside an
 * append-only file (CLAUDE.md / AGENTS.md), preserving everything else the
 * user has written. If the section already exists it is replaced in place
 * (idempotent, no duplication); otherwise it is appended.
 */
function upsertDelimitedSection(path: string, section: string): RuleStatus {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, section, 'utf8');
    return 'created';
  }
  const current = readFileSync(path, 'utf8');
  const begin = current.indexOf(SECTION_BEGIN);
  const end = begin === -1 ? -1 : current.indexOf(SECTION_END, begin);
  if (begin !== -1 && end !== -1) {
    const after = end + SECTION_END.length;
    const replaced = current.slice(0, begin) + section.trimEnd() + current.slice(after);
    if (replaced === current) return 'unchanged';
    writeFileSync(path, replaced, 'utf8');
    return 'updated';
  }
  // No managed section yet - append one, separated from existing content.
  const sep = current.length === 0 ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(path, current + sep + section, 'utf8');
  return 'appended';
}

/** Install the behavioral auto-use rule for one agent. */
function installRule(agent: Agent, cwd: string): RuleResult {
  if (agent === 'cursor') {
    // Project-scoped: applies to the repo `setup` was run in.
    const path = join(cwd, '.cursor', 'rules', 'thinktank-memory.mdc');
    return { path, status: writeManagedFile(path, cursorRuleFile()) };
  }
  if (agent === 'claude') {
    // User-scoped, matching where Claude Code reads global guidance.
    const path = join(homedir(), '.claude', 'CLAUDE.md');
    return { path, status: upsertDelimitedSection(path, delimitedSection('claude-code')) };
  }
  // codex - user-scoped AGENTS.md, alongside ~/.codex/config.toml.
  const path = join(homedir(), '.codex', 'AGENTS.md');
  return { path, status: upsertDelimitedSection(path, delimitedSection('codex')) };
}

/**
 * Wire thinktank into one agent: write the MCP server connection and (unless
 * disabled) install the behavioral auto-use rule so the agent calls the memory
 * tools automatically. Both steps are idempotent and non-clobbering.
 */
export function setupAgent(agent: Agent, opts: SetupOptions = {}): SetupResult {
  const result = writeMcpConfig(agent);
  if (opts.installRules !== false) {
    result.rule = installRule(agent, opts.cwd ?? process.cwd());
  }
  return result;
}
