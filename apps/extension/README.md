# thinktank browser extension

Adds an **"Import to memory"** button to every ChatGPT and Claude.ai chat. When
you click it, the open conversation is captured and sent **only** to thinktank
running on your own machine (`http://127.0.0.1:<port>`). Nothing ever leaves
your device — there is no remote endpoint anywhere in this extension.

## What it does

- Floating **Import to memory** button on `chatgpt.com` and `claude.ai`.
- Popup to set your **project** name and **local port** (default `4319`), plus a
  **Test** button to check thinktank is running.
- **Import this chat** — captures the currently open conversation.
- **Import all history** — best-effort walk of your sidebar chats (see caveat).

## Prerequisites

The thinktank HTTP server must be running locally:

```bash
# from the repo root, after `pnpm install && pnpm build`
node packages/cli/dist/cli.js serve --http
# or, once linked globally:  thinktank serve --http
```

It listens on `127.0.0.1:4319` by default (loopback only).

## Build & load

```bash
pnpm --filter @thinktank/extension build   # outputs apps/extension/dist/
```

Then in Chrome / Arc / any Chromium browser:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select `apps/extension/dist`.
4. Open ChatGPT or Claude.ai — the **Import to memory** button appears bottom-right.

## Privacy

- `host_permissions` are limited to the two chat sites plus `127.0.0.1` /
  `localhost`. The extension cannot talk to any other origin.
- All network calls go through the background worker and target localhost only.
- No analytics, no telemetry, no remote calls.

## How capture works (and its limits)

- **ChatGPT** scraping keys off the stable `[data-message-author-role]`
  attribute on each message bubble — reliable across UI revisions.
- **Claude** scraping keys off `[data-testid="user-message"]` and
  `.font-claude-message`. Claude's markup changes more often, so this scraper is
  the more fragile of the two.
- **Import all history** navigates each sidebar chat in turn and scrapes it. It
  is intentionally gentle (delays between chats) but is **best-effort**: sidebars
  lazy-load, reorder, and virtualize, and a UI change can break it.

> The fully reliable, complete path for bulk history is the **export-file
> import**: download your data from ChatGPT/Claude settings and run
> `thinktank ingest conversations.json`. Use the live scrapers for convenience;
> use the export import when you want a guaranteed full backfill.

The live-site DOM scraping is **not** covered by automated tests (no browser in
CI). The network contract (`/ingest` payload shape) is covered by
`test/ingest.ts`. Validate the scrapers manually against the live sites after
any ChatGPT/Claude UI change.
