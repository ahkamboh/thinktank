import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

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

export interface SetupResult {
  agent: Agent;
  path: string;
  snippet: string;
  verify: string;
}

const CODEX_MARKER = '[mcp_servers.thinktank]';

function tomlValue(inv: McpInvocation): string {
  const args = inv.args.map((a) => JSON.stringify(a)).join(', ');
  return `${CODEX_MARKER}\ncommand = ${JSON.stringify(inv.command)}\nargs = [${args}]\n`;
}

/** Wire thinktank into one agent. Returns what was written + how to verify. */
export function setupAgent(agent: Agent): SetupResult {
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
