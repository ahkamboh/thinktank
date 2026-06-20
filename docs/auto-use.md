# Auto-use: make AI agents use thinktank memory automatically

MCP tools are only invoked when an agent *decides* to call them. There is no
built-in "always call this tool" switch. The reliable lever we have today is
**instructions/rules** that tell each agent to use thinktank on every
conversation — at task start (`memory_resume`), before answering from memory
(`memory_search`), and when the user states something durable (`memory_save`).

This doc records what was wired up and what you must still do by hand.

## (a) Cursor & Claude Code — already wired (rules)

These were added for you and apply automatically:

- **Cursor** — `/.cursor/rules/thinktank-memory.mdc` (workspace root) with
  `alwaysApply: true`. It loads into every Cursor chat in this workspace and
  instructs the agent to call `memory_resume` / `memory_search` / `memory_save`
  without being asked.
- **Claude Code** — a delimited section appended to the user-global
  `~/.claude/CLAUDE.md`. Claude Code reads this on every session, so the same
  auto-use behavior applies to all repos.

Both reference the same MCP tools:
`memory_resume({ project })`, `memory_search({ query, project })`,
`memory_save({ text, project, kind, tool, source })`, plus `memory_recent` and
`memory_stats`. The shared DB lives at `~/.thinktank/thinktank.db`.

## (b) Claude Desktop — manual step (paste custom instructions)

Claude Desktop has **no per-project rules file**. To get the same auto-use
behavior, paste the text below into:

> **Settings → Profile → Custom / Personal Instructions** (the "What personal
> preferences should Claude consider?" box, a.k.a. custom instructions).

Paste-ready text:

```text
I run a local MCP server named "thinktank" — my shared memory across all my AI tools. Use it automatically; I should never have to say "use thinktank".

- At the START of a task, call thinktank's memory_resume with the current project (the repo/folder name) to load prior context.
- BEFORE answering anything about past decisions, preferences, architecture, or "what did we decide/use/choose", call thinktank's memory_search first and prefer the stored answer over guessing.
- When I state a durable decision, preference, constraint, or fact, call thinktank's memory_save WITHOUT being asked. Set project = the repo/folder name and pick kind from: decision, fact, preference, constraint, state, code.
- Do NOT save chit-chat, transient one-off requests, or secrets (API keys, tokens, passwords, credentialed URLs).
```

(The thinktank MCP server must also be enabled in Claude Desktop's MCP/connector
settings for these tools to be available.)

## (c) Honest note on reliability

Rule/instruction following for MCP tools is **high but not 100% deterministic**.
A capable model with an `alwaysApply` rule or global instructions will call
`memory_resume` / `memory_search` / `memory_save` the large majority of the time
(~90%), but it can still skip a call on a given turn — instructions bias
behavior, they do not hard-enforce it.

The **future deterministic option** is a proxy / auto-inject layer that sits
between the agent and the model (or between the client and the MCP server) and
*mechanically* injects resumed memory into context at the start of every turn
and captures durable statements — independent of whether the model chose to
call a tool. That approach is ~100% reliable because it does not depend on the
model's judgment. Rules are the pragmatic 90% solution available right now;
the proxy is the path to 100%.
