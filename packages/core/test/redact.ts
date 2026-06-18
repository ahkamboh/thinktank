/**
 * P6 redaction test: prove common secrets are stripped before storage, that
 * benign prose is left untouched (low false positives), and that redaction is
 * actually wired into the ingest pipeline (nothing secret reaches the DB).
 *
 * Run: pnpm --filter @thinktank/core test:redact
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactSecrets } from '../src/redact.js';
import { MemoryStore, MergeEngine } from '../src/index.js';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ok   - ${msg}`);
  else {
    failures++;
    console.error(`  FAIL - ${msg}`);
  }
}

function redactsTo(label: string, input: string, mustContain: string, mustNotContain: string) {
  const r = redactSecrets(input);
  assert(r.found.length > 0, `${label}: detected a secret`);
  assert(r.text.includes(mustContain), `${label}: emits ${mustContain}`);
  assert(
    !r.text.includes(mustNotContain),
    `${label}: original secret removed`,
  );
  // Findings never leak the raw secret.
  assert(
    r.found.every((f) => !f.preview.includes(mustNotContain)),
    `${label}: finding preview is masked`,
  );
}

async function main() {
  console.log('\nthinktank P6 redaction test\n');

  // ---------------------------------------------------------- patterns
  redactsTo(
    'OpenAI-style key',
    'here is my key sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234567890 use it',
    '[REDACTED:apikey]',
    'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx',
  );
  redactsTo(
    'Anthropic-style key',
    'ANTHROPIC: sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa done',
    '[REDACTED:',
    'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
  redactsTo(
    'AWS access key',
    'aws key AKIAIOSFODNN7EXAMPLE in the config',
    '[REDACTED:aws-key]',
    'AKIAIOSFODNN7EXAMPLE',
  );
  redactsTo(
    'GitHub token',
    'token ghp_1234567890abcdefghijklmnopqrstuvwxyz here',
    '[REDACTED:github-token]',
    'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
  );
  redactsTo(
    'JWT',
    'auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
    '[REDACTED:jwt]',
    'eyJhbGciOiJIUzI1NiJ9',
  );
  redactsTo(
    'Bearer token',
    'Authorization: Bearer abcDEF123456ghiJKL789mnoPQR end',
    '[REDACTED:bearer-token]',
    'abcDEF123456ghiJKL789mnoPQR',
  );
  redactsTo(
    'connection string password',
    'DATABASE_URL connect to postgres://app:s3cr3tP@ss@db.host:5432/main',
    '[REDACTED:password]',
    's3cr3tP',
  );
  redactsTo(
    'KEY=secret assignment',
    'set DB_PASSWORD=hunter2hunter2hunter2 in env',
    '[REDACTED:secret]',
    'hunter2hunter2hunter2',
  );
  {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJBAKj34GkxFhD\n9oVQ==\n-----END RSA PRIVATE KEY-----';
    const r = redactSecrets(`my key:\n${pem}\nthanks`);
    assert(
      r.text.includes('[REDACTED:private-key]') && !r.text.includes('MIIBOwIBAAJBAKj'),
      'private key block redacted',
    );
  }

  // ---------------------------------------------------------- bearer preserves scheme
  {
    const r = redactSecrets('Bearer abcDEF123456ghiJKL789mnoPQR');
    assert(r.text.startsWith('Bearer '), 'bearer scheme word preserved');
  }

  // ---------------------------------------------------------- low false positives
  const benign = [
    'We decided to use JWT, not sessions, for the auth flow.',
    'The staging database is read-only; never run migrations against it.',
    'Prefer pnpm over npm across all repos.',
    'The function getUserById returns null when the row is missing.',
    'Meeting at 3pm to discuss the Q3 roadmap and pricing.',
  ];
  for (const b of benign) {
    const r = redactSecrets(b);
    assert(r.found.length === 0 && r.text === b, `benign prose untouched: "${b.slice(0, 32)}..."`);
  }

  // ---------------------------------------------------------- pipeline wiring
  console.log('\nPipeline: a secret in an ingested message never reaches the DB');
  const dir = mkdtempSync(join(tmpdir(), 'thinktank-redact-'));
  const dbPath = join(dir, 'redact.db');
  const store = new MemoryStore(dbPath);
  const engine = new MergeEngine(store);

  await engine.ingest({
    source: 'chatgpt',
    tool: 'ChatGPT web',
    ts: Date.now(),
    project: 'redact-proj',
    text: 'For testing use my key sk-proj-LEAKED1234567890abcdefghijklmnop and call the API.',
  });

  const mems = store.recent(50, 'redact-proj');
  assert(mems.length > 0, 'message was ingested (after redaction)');
  const leaked = mems.some((m) => m.text.includes('sk-proj-LEAKED'));
  assert(!leaked, 'no stored memory contains the raw API key');
  const hasPlaceholder = mems.some((m) => m.text.includes('[REDACTED:apikey]'));
  assert(hasPlaceholder, 'stored memory shows the [REDACTED:apikey] placeholder');

  // It must not be findable by the secret text either.
  const hits = await store.search('sk-proj-LEAKED1234567890', { project: 'redact-proj' });
  assert(
    hits.every((h) => !h.text.includes('sk-proj-LEAKED')),
    'searching the secret never returns the raw secret',
  );

  store.close();
  rmSync(dir, { recursive: true, force: true });

  console.log(
    failures === 0
      ? '\nP6 redaction PASS - secrets stripped, prose preserved, pipeline clean.\n'
      : `\nP6 redaction FAIL - ${failures} assertion(s) failed.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nP6 redaction ERROR:', err);
  process.exitCode = 1;
});
