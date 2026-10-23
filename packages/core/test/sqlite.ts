/**
 * SQLite sharing test: many `serve` processes share one file, so the store
 * must run in WAL mode, wait on another process's write lock instead of
 * failing, and write multi-table changes atomically.
 *
 * Run: pnpm --filter @thinktank/core test:sqlite
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BUSY_TIMEOUT_MS, MemoryStore, embed } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'thinktank-sqlite-'));
const dbPath = join(dir, 'shared.db');

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ok   - ${msg}`);
  else {
    failures++;
    console.error(`  FAIL - ${msg}`);
  }
}

/** Another process that holds the write lock for `holdMs`, then commits. */
const LOCK_HOLDER = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('BEGIN IMMEDIATE');
db.exec("UPDATE memories SET updated_at = updated_at WHERE id = 1");
process.stdout.write('locked\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[2]));
db.exec('COMMIT');
db.close();
`;

async function holdLock(holdMs: number): Promise<{ done: Promise<number> }> {
  const child = spawn(process.execPath, ['--no-warnings', '-e', LOCK_HOLDER, dbPath, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('locked')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
  return { done: new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1))) };
}

async function main() {
  console.log('\nthinktank SQLite sharing test');
  console.log(`db: ${dbPath}\n`);
  const store = new MemoryStore(dbPath);
  const vec = await embed('The deploy job runs on every merge to main.');
  const ev = (text: string) => ({ source: 'test', ts: Date.now(), project: 'sqlite', text, kind: 'fact' as const });
  store.insertMemory(ev('seed row'), vec);

  // ------------------------------------------------------------ settings
  console.log('Fix 6: WAL + busy_timeout');
  const info = store.sqliteInfo();
  assert(info.journalMode === 'wal', `journal_mode is wal (got ${info.journalMode})`);
  assert(info.busyTimeoutMs === BUSY_TIMEOUT_MS, `busy_timeout is ${BUSY_TIMEOUT_MS}ms (got ${info.busyTimeoutMs})`);
  const other = new DatabaseSync(dbPath);
  const jm = (other.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  assert(jm === 'wal', 'WAL is persistent: a plain second connection sees it too');

  // ------------------------------------------- waiting on another writer
  console.log('\nA write waits for another process instead of failing');
  const holder = await holdLock(1200);
  let rawFailed = false;
  try {
    other.exec('BEGIN IMMEDIATE'); // busy_timeout 0: fails at once
    other.exec('ROLLBACK');
  } catch (err) {
    rawFailed = /locked|busy/i.test(String(err));
  }
  assert(rawFailed, 'the lock is real: a connection without busy_timeout gets "database is locked"');
  const t0 = Date.now();
  let inserted = false;
  try {
    inserted = store.insertMemory(ev('written while another process held the lock'), vec).id > 0;
  } catch (err) {
    console.error('    insert error:', String(err));
  }
  const waited = Date.now() - t0;
  assert(inserted, 'the store insert succeeded once the lock was released');
  assert(waited >= 500, `it waited for the lock (${waited}ms) rather than erroring`);
  assert((await holder.done) === 0, 'the other process committed cleanly');
  other.close();

  // ---------------------------------------------------------- atomicity
  console.log('\nMulti-table writes are atomic');
  const before = store.stats().total;
  let threw = false;
  try {
    // Wrong-width vector: the vec0 insert fails AFTER the memories row is written.
    store.insertMemory(ev('half-written row'), new Float32Array(10));
  } catch {
    threw = true;
  }
  assert(threw, 'a bad vector makes insertMemory throw');
  assert(store.stats().total === before, 'the memories row was rolled back (no orphan without a vector)');
  assert(
    store.recent(50, 'sqlite').every((m) => m.text !== 'half-written row'),
    'the half-written row is not readable',
  );

  threw = false;
  try {
    store.transaction(() => {
      store.insertMemory(ev('inside an outer transaction'), vec);
      store.transaction(() => store.insertMemory(ev('nested savepoint row'), vec));
      throw new Error('abort');
    });
  } catch {
    threw = true;
  }
  assert(threw && store.stats().total === before, 'nested transaction work rolls back with the outer one');

  store.transaction(() => {
    store.insertMemory(ev('committed row one'), vec);
    store.insertMemory(ev('committed row two'), vec);
  });
  assert(store.stats().total === before + 2, 'a committed transaction keeps both rows');

  const id = store.recent(1, 'sqlite')[0]!.id;
  assert(store.deleteMemory(id) && store.getById(id) === null, 'deleteMemory removes the row (in one transaction)');

  store.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(
    failures === 0
      ? '\nSQLITE PASS - WAL, busy waiting and atomic writes all work.\n'
      : `\nSQLITE FAIL - ${failures} assertion(s) failed.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nSQLITE ERROR:', err);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
  process.exitCode = 1;
});
