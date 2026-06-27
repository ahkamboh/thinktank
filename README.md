# thinktank

**One private brain for every AI.** A local-first universal memory layer that
lets every AI coding agent (Cursor, Claude Code, Codex) and consumer web chat
(ChatGPT, Claude.ai) share the same memory.

Decide something in ChatGPT today, and Cursor knows it tomorrow - without you
repeating yourself. Everything lives in a single SQLite file on your machine.
No cloud, no account, no API keys.

> Status: MVP complete (P1-P6). Works end-to-end today. The browser-extension
> DOM scraping needs validation against the live sites, and the optional LLM
> extractor is wired but not yet calling a model.

## ⚡ Set it up with your AI agent

New here? Paste this into **Claude Code, Cursor, Codex — or any AI agent** and it'll set thinktank up for you:

```
You are helping me set up thinktank — a local-first memory layer that gives all my AI
tools one shared, private brain (https://github.com/ahkamboh/thinktank). It runs 100%
on my machine (127.0.0.1) — nothing leaves my device. Set it up for me:

1. clone + build (one time):
   git clone https://github.com/ahkamboh/thinktank
   cd thinktank && pnpm install && pnpm -r build
2. wire thinktank's MCP into my coding agents (drop any flag I don't use):
   node packages/cli/dist/cli.js setup --cursor --claude --codex
3. start the local server for the browser-extension "Import to memory" button:
   node packages/cli/dist/cli.js serve --http     # localhost:4319
4. verify it works: save a test memory, then recall it in a fresh prompt.

If a step needs my input (which agents, the port, pnpm vs npm), ask me first.
```

## See it in 30 seconds

```bash
pnpm install && pnpm -r build
node packages/cli/dist/cli.js demo   # narrated, uses a throwaway db
```

The demo proves the headline: a decision made in ChatGPT is recalled
**semantically** by Cursor the next day, a pasted API key is **redacted** before
storage, and a later conflicting decision is **superseded** and logged.

## Why

Ten OSS tools already give coding agents "memory." None of them:

1. ingest your **consumer web chats** (ChatGPT / Claude.ai), and
2. truly **merge** knowledge across sources (dedupe + conflict resolution +
   one timeline).

thinktank focuses on exactly those two things. Everything else reuses boring,
proven infrastructure.

## How it works

```
Capture  ->  Merge engine            ->  One local DB     ->  Smart retrieval   ->  Any agent
(MCP /        (redact secrets,           (~/.thinktank/       (hybrid search,
 extension /   extract, dedupe,           thinktank.db)        token-budgeted)
 export)       resolve conflicts)
```

- **Capture** - coding agents write over MCP; web chats are imported via a
  browser "Import to memory" button (sends only to `localhost`) or an export
  file.
- **Redact** - every ingest path strips secrets (API keys, AWS keys, tokens,
  private keys, credentialed URLs, `KEY=secret` pairs) *before* anything is
  embedded, indexed, or stored.
- **Merge** - raw chat is distilled into atomic memories
  (`decision | fact | preference | constraint | state | code`), de-duplicated,
  and conflicts are resolved (newest wins, older marked superseded and logged).
- **Store** - a single local SQLite database. Private by design.
- **Retrieve** - hybrid semantic + keyword search returns a small,
  token-budgeted set so agents get signal, not 50k tokens of history.

## Quick start

```bash
# 1. install + build
pnpm install
pnpm -r build

# 2. wire thinktank into your agents (writes their MCP config)
node packages/cli/dist/cli.js setup --cursor --claude --codex

# 3a. run the local server for the browser extension's "Import to memory" button
node packages/cli/dist/cli.js serve --http        # localhost:4319

# 3b. ...or import a ChatGPT / Claude.ai data export directly
node packages/cli/dist/cli.js ingest conversations.json --project=my-app
```

Then load the browser extension (`apps/extension/dist`) unpacked in
`chrome://extensions` to get the "Import to memory" button on ChatGPT and
Claude.ai. See [`apps/extension/README.md`](apps/extension/README.md).

(Once published, the agent config will use `npx -y @thinktank/cli serve`.)

## Privacy

- **Local-only.** The browser extension and HTTP server talk to `127.0.0.1`
  exclusively - there is no remote endpoint, no telemetry, no account.
- **Secret redaction** runs on every ingest path; raw credentials never get
  embedded, indexed, or written to disk.
- **Optional at-rest encryption** (AES-256-GCM): set `THINKTANK_ENCRYPT=1` and
  provide a key via `THINKTANK_KEY` (passphrase) or a key file. **Default OFF**
  for a transparent MVP.
  - Honest tradeoff: the encrypted `text` column is the durable store. To avoid
    leaving plaintext on disk, the plaintext FTS keyword index is **skipped**
    when encryption is on (search degrades to semantic/vector-only). The
    embedding vector is the one remaining plaintext-derived (one-way) artifact.
    Full index encryption (SQLCipher) is future work.

## Tech

- **TypeScript** monorepo (pnpm workspaces).
- **Storage:** Node's builtin [`node:sqlite`](https://nodejs.org/api/sqlite.html)
  + [`sqlite-vec`](https://github.com/asg017/sqlite-vec) (vector KNN) + FTS5
  (keyword). No native build step.
- **Embeddings:** [`@huggingface/transformers`](https://github.com/huggingface/transformers.js)
  running `all-MiniLM-L6-v2` (384-dim) fully on-device.
- **MCP:** `@modelcontextprotocol/sdk` v1.x (stdio + Streamable HTTP).

> thinktank uses `node:sqlite` (Node >= 22.5) rather than `better-sqlite3`, so
> there is **no native compilation step** - it runs on bleeding-edge Node
> (tested on v25) out of the box.

## Packages

| Package                  | Purpose                                            | Status |
| ------------------------ | -------------------------------------------------- | ------ |
| `packages/core`          | storage, embeddings, redaction, encryption, merge engine, retrieval | done |
| `packages/mcp-server`    | MCP server (stdio + Streamable HTTP) + localhost `/ingest` | done |
| `packages/cli`           | `thinktank setup / serve / ingest / demo`          | done |
| `packages/ingest`        | ChatGPT + Claude.ai export parsers                 | done |
| `apps/extension`         | "Import to memory" browser button (MV3)            | done\* |

\* Functional and tested against simulated payloads; live-site DOM scraping
needs manual validation.

## Develop

```bash
pnpm install
pnpm -r build          # build every package (topological)
pnpm -r typecheck      # typecheck everything
pnpm --filter @thinktank/core test   # roundtrip + merge + redaction + crypto
pnpm --filter @thinktank/ingest test # export parsers
node packages/cli/dist/cli.js demo   # full end-to-end narrated demo
```

The default database lives at `~/.thinktank/thinktank.db`; the embedding model
is cached under `~/.thinktank/models/`. Override the DB path with `THINKTANK_DB`.

## License

[MIT](LICENSE) (c) ahkamboh
