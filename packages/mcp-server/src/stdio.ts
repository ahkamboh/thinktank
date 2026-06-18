import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { closeBrain } from './store.js';

/**
 * Start the thinktank MCP server over stdio. This is the transport IDEs
 * (Cursor, Claude Code, Codex) spawn as a child process. Note: never write to
 * stdout here except via the transport - stdout is the JSON-RPC channel. Use
 * stderr for any diagnostics.
 */
export async function startStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[thinktank] MCP server ready on stdio.');

  const shutdown = async () => {
    try {
      await server.close();
    } finally {
      closeBrain();
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  startStdio().catch((err) => {
    console.error('[thinktank] failed to start stdio server:', err);
    process.exit(1);
  });
}
