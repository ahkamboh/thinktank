/**
 * P6 encryption test: prove the AES-256-GCM cipher round-trips, that a wrong
 * key fails loudly, and that with encryption enabled the MemoryStore writes
 * ciphertext to disk (and no plaintext FTS) while still reading back plaintext.
 *
 * Run: pnpm --filter @thinktank/core test:crypto
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createCipher, isEncrypted } from '../src/crypto.js';
import { MemoryStore } from '../src/index.js';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ok   - ${msg}`);
  else {
    failures++;
    console.error(`  FAIL - ${msg}`);
  }
}

async function main() {
  console.log('\nthinktank P6 encryption test\n');

  // ---------------------------------------------------------- unit: cipher
  const key = randomBytes(32);
  const cipher = createCipher(key);
  const plain = 'We use JWT, not sessions, for authentication.';
  const blob = cipher.encrypt(plain);

  assert(isEncrypted(blob), 'ciphertext carries the thinktank marker');
  assert(!blob.includes('JWT'), 'ciphertext does not contain plaintext');
  assert(cipher.decrypt(blob) === plain, 'decrypt round-trips to the original');

  const wrong = createCipher(randomBytes(32));
  let threw = false;
  try {
    wrong.decrypt(blob);
  } catch {
    threw = true;
  }
  assert(threw, 'a wrong key fails to decrypt (GCM auth error)');

  assert(createCipher(key).decrypt(cipher.encrypt('a')) === 'a', 'tiny payload round-trips');

  // ---------------------------------------------------------- store: at rest
  console.log('\nStore with encryption enabled');
  const dir = mkdtempSync(join(tmpdir(), 'thinktank-crypto-'));
  const dbPath = join(dir, 'enc.db');

  const store = new MemoryStore(dbPath, { cipher });
  const saved = await store.save({
    source: 'manual',
    ts: Date.now(),
    project: 'enc-proj',
    text: 'The production API uses JWT bearer tokens for auth.',
    kind: 'decision',
  });
  assert(saved.text.includes('JWT'), 'getById returns decrypted plaintext');

  // Semantic search still works (vector path), even though FTS is skipped.
  const hits = await store.search('how does the API authenticate requests?', {
    project: 'enc-proj',
  });
  assert(
    hits.length > 0 && hits[0]!.text.includes('JWT'),
    'vector search recalls the encrypted memory (decrypted on read)',
  );
  store.close();

  // Inspect the raw bytes on disk: text column must be ciphertext, FTS empty.
  const raw = new DatabaseSync(dbPath, { allowExtension: true });
  sqliteVec.load(raw);
  const row = raw.prepare('SELECT text FROM memories WHERE id = ?').get(saved.id) as
    | { text: string }
    | undefined;
  assert(!!row && isEncrypted(row.text), 'on-disk text column is ciphertext');
  assert(!!row && !row.text.includes('JWT'), 'on-disk text has no plaintext');
  const ftsCount = (
    raw.prepare('SELECT COUNT(*) AS c FROM memories_fts').get() as { c: number }
  ).c;
  assert(ftsCount === 0, 'plaintext FTS index is empty when encrypted');
  raw.close();

  // Opening with the WRONG key must fail loudly on read, not return garbage.
  const wrongStore = new MemoryStore(dbPath, { cipher: createCipher(randomBytes(32)) });
  let readThrew = false;
  try {
    wrongStore.getById(saved.id);
  } catch {
    readThrew = true;
  }
  assert(readThrew, 'reading with the wrong key throws (no silent corruption)');
  wrongStore.close();

  rmSync(dir, { recursive: true, force: true });

  console.log(
    failures === 0
      ? '\nP6 encryption PASS - round-trip, wrong-key failure, at-rest ciphertext.\n'
      : `\nP6 encryption FAIL - ${failures} assertion(s) failed.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nP6 encryption ERROR:', err);
  process.exitCode = 1;
});
