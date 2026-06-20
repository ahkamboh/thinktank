/**
 * Shared auto-use instruction text for thinktank.
 *
 * This is the behavioral policy that teaches an AI agent to use thinktank's
 * memory tools automatically: resume at task start, search before answering
 * from memory, and save durable facts without being asked. `thinktank setup`
 * renders this text into each client's rules/instructions file so memory
 * auto-use works for ANY installer without hand-editing CLAUDE.md or Cursor
 * rules.
 *
 * Keep ONE canonical body here (`autoUseBody`); the per-client wrappers below
 * only add the format each client expects (Cursor `.mdc` frontmatter, or an
 * append-only delimited section for CLAUDE.md / AGENTS.md). All three setup
 * targets reuse this module so the policy never drifts between clients.
 */

/**
 * Marker lines that delimit thinktank's managed section inside append-only
 * files (CLAUDE.md, AGENTS.md). Setup replaces ONLY the text between these two
 * markers, so anything else the user has written is preserved. The exact
 * strings must stay stable across versions so re-running setup stays idempotent
 * (it finds and replaces the prior block instead of appending a duplicate).
 */
export const SECTION_BEGIN =
  '<!-- ===== thinktank shared memory (auto-use) — managed section, append-only ===== -->';
export const SECTION_END = '<!-- ===== end thinktank section ===== -->';

/**
 * The canonical auto-use policy as Markdown.
 *
 * `toolLabel` is the source/tool label the agent should stamp onto saved
 * memories (e.g. "cursor", "claude-code", "codex") so provenance is correct
 * per client.
 */
export function autoUseBody(toolLabel: string): string {
  return `# thinktank — Shared AI Memory (auto-use)

\`thinktank\` is the user's shared, persistent memory across all their AI tools, exposed as the MCP server \`thinktank\`. Use it automatically — the user should never have to say "use thinktank". They can also type "tank" or "thinktank" to explicitly ask you to check memory.

## At the START of a task
- Call the \`memory_resume\` tool with \`{ project }\` to load prior context before doing substantive work.
- \`project\` = the repo/folder name you are working in.

## BEFORE answering from memory
- Before answering any question about past decisions, preferences, architecture, setup, or "what did we decide / use / choose", call \`memory_search\` with \`{ query, project }\` FIRST and prefer stored answers over guessing.

## When the user states something durable
- When the user states a durable decision, preference, constraint, or fact, call \`memory_save\` with \`{ text, project, kind, tool: "${toolLabel}", source: "${toolLabel}" }\` WITHOUT being asked.
- \`kind\` is one of: \`decision\`, \`fact\`, \`preference\`, \`constraint\`, \`state\`, \`code\` (omit to auto-classify).
- \`project\` = the repo/folder name.

## Do NOT save
- Chit-chat, transient one-off requests, or secrets (API keys, tokens, passwords, credentialed URLs).`;
}

/**
 * Full contents of the Cursor rule file
 * (`.cursor/rules/thinktank-memory.mdc`). The whole file is owned by thinktank,
 * so setup treats it as a fully-managed file: written verbatim, with `.mdc`
 * frontmatter (`alwaysApply: true`) so Cursor always injects it.
 */
export function cursorRuleFile(): string {
  const frontmatter = [
    '---',
    'description: Automatically use the thinktank MCP shared memory — resume context at task start, search before answering about past decisions/preferences, and save durable decisions without being asked.',
    'alwaysApply: true',
    '---',
    '',
  ].join('\n');
  return `${frontmatter}${autoUseBody('cursor')}\n`;
}

/**
 * The delimited, append-only section for CLAUDE.md / AGENTS.md. Setup inserts
 * this once and replaces it in place on later runs (never duplicating it or
 * clobbering surrounding user content).
 */
export function delimitedSection(toolLabel: string): string {
  return `${SECTION_BEGIN}\n${autoUseBody(toolLabel)}\n${SECTION_END}\n`;
}
