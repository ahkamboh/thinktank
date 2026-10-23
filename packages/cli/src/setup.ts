import { homedir } from 'node:os';
import { join, dirname, delimiter, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  SECTION_BEGIN,
  SECTION_END,
  cursorRuleFile,
  delimitedSection,
} from './auto-use-text.js';

export type Agent = 'cursor' | 'claude' | 'claude-desktop' | 'codex';

/** Every client `setup` knows how to wire (and `setup --repair` checks). */
export const ALL_AGENTS: readonly Agent[] = ['cursor', 'claude', 'claude-desktop', 'codex'];

export interface McpInvocation {
  command: string;
  args: string[];
}

/** Inputs for resolving the node binary; overridable so tests can fake a layout. */
export interface NodeResolveOptions {
  /** The running node binary. Default: `process.execPath`. */
  execPath?: string;
  /** PATH to search for a stable `node`. Default: `process.env.PATH`. */
  pathEnv?: string;
}

/**
 * Homebrew keeps each Node release in `<prefix>/Cellar/<formula>/<version>/`
 * and deletes that directory on `brew upgrade` / `brew cleanup`. Node reports
 * `process.execPath` with symlinks resolved, so on Homebrew it is always this
 * versioned path even when you ran the stable `<prefix>/bin/node`.
 */
const HOMEBREW_CELLAR = /^(.*)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/]bin[\\/]node(?:\.exe)?$/;

/**
 * Path fragments of node installs that are pinned to one version (or, for
 * fnm's per-shell symlinks, deleted when the shell exits). A config that points
 * at one of these breaks when that version goes away.
 */
const VERSION_PINNED = [
  /[\\/]Cellar[\\/]/,
  /[\\/]fnm_multishells[\\/]/,
  /[\\/]fnm[\\/]node-versions[\\/]/,
  /[\\/]\.nvm[\\/]versions[\\/]/,
  /[\\/]\.asdf[\\/]installs[\\/]/,
  /[\\/]\.volta[\\/]tools[\\/]image[\\/]/,
  /[\\/]mise[\\/]installs[\\/]/,
];

export function isVersionPinnedNode(path: string): boolean {
  return VERSION_PINNED.some((re) => re.test(path));
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * The node binary to write into client configs: a path that keeps working
 * after a node upgrade. We prefer a stable symlink that resolves to the very
 * binary running now, checked in this order:
 *   1. Homebrew's `<prefix>/bin/node`, then `<prefix>/opt/<formula>/bin/node`;
 *   2. each `node` on PATH, unresolved (what your shell would run).
 * Version-pinned candidates are skipped. If nothing stable matches (e.g. nvm,
 * which has no stable path), the running binary is returned as-is.
 */
export function resolveNodeCommand(opts: NodeResolveOptions = {}): string {
  const execPath = opts.execPath ?? process.execPath;
  const target = realpathOrNull(execPath);
  if (!target) return execPath;

  const candidates: string[] = [];
  const brew = HOMEBREW_CELLAR.exec(execPath);
  if (brew) {
    const [, prefix = '', formula = 'node'] = brew;
    candidates.push(join(prefix, 'bin', 'node'), join(prefix, 'opt', formula, 'bin', 'node'));
  }
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (opts.pathEnv ?? process.env.PATH ?? '').split(delimiter)) {
    if (dir) candidates.push(join(dir, exe));
  }

  for (const candidate of candidates) {
    if (isVersionPinnedNode(candidate)) continue;
    if (realpathOrNull(candidate) === target) return candidate;
  }
  return execPath;
}

/** Absolute path to the compiled CLI entry (`packages/cli/dist/cli.js`). */
export function cliEntryPath(): string {
  return fileURLToPath(new URL('./cli.js', import.meta.url));
}

/** `node <cli.js> <sub>`: a command that works without thinktank on PATH. */
export function cliCommand(sub: string): string {
  const entry = cliEntryPath();
  return `node ${/\s/.test(entry) ? `"${entry}"` : entry} ${sub}`;
}

/**
 * How an IDE should launch the thinktank stdio server: a version-stable node
 * binary plus the absolute path to the compiled CLI, so it works without a
 * global install and survives node upgrades. Once published, this could become
 * `npx -y @thinktank/cli serve`.
 */
export function mcpInvocation(nodeOpts: NodeResolveOptions = {}): McpInvocation {
  // Silence node:sqlite's ExperimentalWarning so it doesn't pollute the IDE's
  // MCP server logs. (Node flags must precede the script path.)
  return {
    command: resolveNodeCommand(nodeOpts),
    args: ['--no-warnings=ExperimentalWarning', cliEntryPath(), 'serve'],
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

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Merge a `mcpServers.thinktank` block into an existing JSON config file.
 * Other servers, other top-level keys, and extra fields already on the
 * thinktank entry (e.g. `env`, `type`) are kept.
 */
function mergeMcpServersJson(path: string, inv: McpInvocation): void {
  const cfg = readJson(path);
  if (!isObject(cfg.mcpServers)) cfg.mcpServers = {};
  const servers = cfg.mcpServers as JsonObject;
  const prev = isObject(servers.thinktank) ? servers.thinktank : {};
  servers.thinktank = { ...prev, command: inv.command, args: inv.args };
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
  /** For clients with no rules file (Claude Desktop): the manual auto-use step. */
  manualRule?: string;
  /** Set when the node path written is still tied to one node version. */
  warning?: string;
}

export interface SetupOptions {
  /** Install the behavioral auto-use rule too. Default: true. */
  installRules?: boolean;
  /**
   * Directory the Cursor project rule is written into (its `.cursor/rules/`).
   * Defaults to the process CWD so it applies to the repo setup is run in.
   */
  cwd?: string;
  /** Home directory client config paths resolve against. Default: os.homedir(). */
  home?: string;
  /** Overrides for picking the node binary (tests). */
  node?: NodeResolveOptions;
}

/**
 * Claude Desktop's config file: `~/Library/Application Support/Claude` on
 * macOS, `%APPDATA%\Claude` on Windows, `~/.config/Claude` on Linux builds.
 */
export function claudeDesktopConfigPath(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const file = 'claude_desktop_config.json';
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', file);
  if (platform === 'win32') return join(home, 'AppData', 'Roaming', 'Claude', file);
  return join(home, '.config', 'Claude', file);
}

/** Where each client keeps its MCP server config. */
export function mcpConfigPath(agent: Agent, home: string = homedir()): string {
  switch (agent) {
    case 'cursor':
      return join(home, '.cursor', 'mcp.json');
    case 'claude':
      return join(home, '.claude.json');
    case 'claude-desktop':
      return claudeDesktopConfigPath(home);
    case 'codex':
      return join(home, '.codex', 'config.toml');
  }
}

const CODEX_MARKER = '[mcp_servers.thinktank]';
// `command = "..."` / `args = [...]` lines inside the thinktank table. Codex
// writes basic ("...") strings; literal ('...') strings are accepted too.
const TOML_COMMAND = /^[ \t]*command[ \t]*=[ \t]*("(?:[^"\\]|\\.)*"|'[^']*')[^\n]*$/m;
const TOML_ARGS = /^[ \t]*args[ \t]*=[ \t]*\[([\s\S]*?)\][^\n]*$/m;
const TOML_STRING = /"(?:[^"\\]|\\.)*"|'[^']*'/g;

function parseTomlString(literal: string): string {
  if (literal.startsWith("'")) return literal.slice(1, -1);
  try {
    return JSON.parse(literal) as string;
  } catch {
    return literal.slice(1, -1);
  }
}

function tomlLines(inv: McpInvocation): { command: string; args: string } {
  const args = inv.args.map((a) => JSON.stringify(a)).join(', ');
  return { command: `command = ${JSON.stringify(inv.command)}`, args: `args = [${args}]` };
}

function tomlValue(inv: McpInvocation): string {
  const lines = tomlLines(inv);
  return `${CODEX_MARKER}\n${lines.command}\n${lines.args}\n`;
}

/** The thinktank table's body: from after its header to the next table header. */
function codexSection(text: string): { bodyStart: number; end: number } | null {
  const start = text.indexOf(CODEX_MARKER);
  if (start === -1) return null;
  const bodyStart = start + CODEX_MARKER.length;
  const next = text.slice(bodyStart).search(/^[ \t]*\[/m);
  return { bodyStart, end: next === -1 ? text.length : bodyStart + next };
}

/** Point an existing thinktank table at `inv`, keeping its other keys (e.g. env). */
function rewriteCodexSection(text: string, inv: McpInvocation): string {
  const sec = codexSection(text);
  if (!sec) return text;
  const lines = tomlLines(inv);
  let body = text.slice(sec.bodyStart, sec.end);
  body = TOML_ARGS.test(body)
    ? body.replace(TOML_ARGS, () => lines.args)
    : `\n${lines.args}${body}`;
  body = TOML_COMMAND.test(body)
    ? body.replace(TOML_COMMAND, () => lines.command)
    : `\n${lines.command}${body}`;
  return text.slice(0, sec.bodyStart) + body + text.slice(sec.end);
}

function writeCodexConfig(path: string, inv: McpInvocation): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  let next: string;
  if (codexSection(existing)) {
    next = rewriteCodexSection(existing, inv);
  } else {
    const sep = existing.length && !existing.endsWith('\n') ? '\n\n' : existing.length ? '\n' : '';
    next = existing + sep + tomlValue(inv);
  }
  if (next === existing) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, 'utf8');
}

function writeInvocation(agent: Agent, path: string, inv: McpInvocation): void {
  if (agent === 'codex') writeCodexConfig(path, inv);
  else mergeMcpServersJson(path, inv);
}

/** The thinktank entry currently in a client's config, or null if it has none. */
function readConfiguredInvocation(agent: Agent, path: string): McpInvocation | null {
  if (!existsSync(path)) return null;
  if (agent === 'codex') {
    const text = readFileSync(path, 'utf8');
    const sec = codexSection(text);
    if (!sec) return null;
    const body = text.slice(sec.bodyStart, sec.end);
    const command = TOML_COMMAND.exec(body)?.[1];
    const args = TOML_ARGS.exec(body)?.[1] ?? '';
    return {
      command: command ? parseTomlString(command) : '',
      args: [...args.matchAll(TOML_STRING)].map((m) => parseTomlString(m[0])),
    };
  }
  const servers = readJson(path).mcpServers;
  const entry = isObject(servers) ? servers.thinktank : undefined;
  if (!isObject(entry)) return null;
  return {
    command: typeof entry.command === 'string' ? entry.command : '',
    args: Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === 'string')
      : [],
  };
}

/**
 * Why a configured invocation can't start, or null if its paths exist. Bare
 * commands (`node`, `npx`) are looked up on the client's PATH, so only
 * absolute paths are checked.
 */
export function brokenReason(inv: McpInvocation): string | null {
  if (inv.command && isAbsolute(inv.command) && !existsSync(inv.command)) {
    return `command not found: ${inv.command}`;
  }
  const script = inv.args.find((a) => isAbsolute(a) && /\.[cm]?js$/.test(a));
  if (script && !existsSync(script)) return `script not found: ${script}`;
  return null;
}

const VERIFY: Record<Agent, string> = {
  cursor:
    'Restart Cursor, then open Settings -> MCP. "thinktank" should be listed ' +
    'with its tools (memory_resume, memory_search, ...).',
  claude:
    'Run `claude mcp list` (or restart Claude Code). "thinktank" should ' +
    'appear as a connected stdio server.',
  'claude-desktop':
    'Quit Claude Desktop completely and reopen it. "thinktank" should be ' +
    'listed as running under Settings -> Developer.',
  codex:
    'Restart Codex. Run `codex` and check that the "thinktank" MCP server ' +
    'connects (it will expose the memory_* tools).',
};

/** Write only the MCP server connection for one agent (no behavioral rule). */
function writeMcpConfig(agent: Agent, opts: SetupOptions): SetupResult {
  const inv = mcpInvocation(opts.node);
  const path = mcpConfigPath(agent, opts.home);
  writeInvocation(agent, path, inv);
  const snippet =
    agent === 'codex'
      ? tomlValue(inv).trimEnd()
      : JSON.stringify(
          { mcpServers: { thinktank: { command: inv.command, args: inv.args } } },
          null,
          2,
        );
  const result: SetupResult = { agent, path, snippet, verify: VERIFY[agent] };
  if (isVersionPinnedNode(inv.command)) {
    result.warning =
      `${inv.command} belongs to one node version. If that version is ` +
      `removed, run \`${cliCommand('setup --repair')}\` to point configs at the new one.`;
  }
  return result;
}

export type RepairStatus = 'repaired' | 'ok' | 'not-configured';

export interface RepairResult {
  agent: Agent;
  path: string;
  status: RepairStatus;
  /** For `repaired`: what was broken. */
  reason?: string;
  /** For `repaired`: the node command now written. */
  command?: string;
}

export interface RepairOptions {
  home?: string;
  node?: NodeResolveOptions;
}

/**
 * Fix an existing thinktank entry whose node binary or CLI script no longer
 * exists (e.g. `brew upgrade node` deleted the old Cellar directory). Only
 * clients that already have a thinktank entry are touched, working entries are
 * left alone, and no rules or new config files are written.
 */
export function repairAgent(agent: Agent, opts: RepairOptions = {}): RepairResult {
  const path = mcpConfigPath(agent, opts.home);
  const current = readConfiguredInvocation(agent, path);
  if (!current) return { agent, path, status: 'not-configured' };
  const reason = brokenReason(current);
  if (!reason) return { agent, path, status: 'ok' };
  const inv = mcpInvocation(opts.node);
  writeInvocation(agent, path, inv);
  return { agent, path, status: 'repaired', reason, command: inv.command };
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

/** Install the behavioral auto-use rule for one agent (null: no rules file). */
function installRule(agent: Agent, cwd: string, home: string): RuleResult | null {
  if (agent === 'cursor') {
    // Project-scoped: applies to the repo `setup` was run in.
    const path = join(cwd, '.cursor', 'rules', 'thinktank-memory.mdc');
    return { path, status: writeManagedFile(path, cursorRuleFile()) };
  }
  if (agent === 'claude') {
    // User-scoped, matching where Claude Code reads global guidance.
    const path = join(home, '.claude', 'CLAUDE.md');
    return { path, status: upsertDelimitedSection(path, delimitedSection('claude-code')) };
  }
  // Claude Desktop reads no rules file; its instructions live in the app.
  if (agent === 'claude-desktop') return null;
  // codex - user-scoped AGENTS.md, alongside ~/.codex/config.toml.
  const path = join(home, '.codex', 'AGENTS.md');
  return { path, status: upsertDelimitedSection(path, delimitedSection('codex')) };
}

/**
 * Wire thinktank into one agent: write the MCP server connection and (unless
 * disabled) install the behavioral auto-use rule so the agent calls the memory
 * tools automatically. Both steps are idempotent and non-clobbering.
 */
export function setupAgent(agent: Agent, opts: SetupOptions = {}): SetupResult {
  const result = writeMcpConfig(agent, opts);
  if (opts.installRules !== false) {
    const rule = installRule(agent, opts.cwd ?? process.cwd(), opts.home ?? homedir());
    if (rule) result.rule = rule;
    else {
      result.manualRule =
        'Claude Desktop has no rules file. For auto-use, paste the custom ' +
        'instructions from docs/auto-use.md (section b) into Settings -> Profile.';
    }
  }
  return result;
}
