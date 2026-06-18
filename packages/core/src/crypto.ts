/**
 * Optional at-rest encryption for the memory text column.
 *
 * thinktank uses Node's builtin `node:sqlite`, which has no SQLCipher, so we do
 * application-level AES-256-GCM on the sensitive `text` fields. This is OPT-IN
 * (THINKTANK_ENCRYPT=1) and OFF by default to keep the MVP transparent.
 *
 * IMPORTANT TRADEOFF (documented honestly):
 *   Embeddings and the FTS5 keyword index are derived from PLAINTEXT at write
 *   time. To avoid leaving plaintext on disk, when encryption is enabled the
 *   MemoryStore SKIPS the plaintext FTS index entirely (keyword search degrades
 *   to semantic/vector-only search). The encrypted `text` column is the durable
 *   store; the one-way embedding vector is the only plaintext-derived artifact
 *   that remains. Full index encryption (e.g. SQLCipher) is future work.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Encrypt/decrypt a single string value. */
export interface Cipher {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

const MARKER = 'ttenc1';
const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;

export const DEFAULT_KEY_DIR = join(homedir(), '.thinktank');
export const DEFAULT_KEY_PATH = join(DEFAULT_KEY_DIR, 'key');
const DEFAULT_SALT_PATH = join(DEFAULT_KEY_DIR, 'key.salt');

/** Is at-rest encryption turned on via the environment? Default: false. */
export function isEncryptionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.THINKTANK_ENCRYPT ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Does a stored value carry thinktank's ciphertext marker? */
export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(`${MARKER}:`);
}

function loadOrCreateSalt(): Buffer {
  if (existsSync(DEFAULT_SALT_PATH)) {
    return Buffer.from(readFileSync(DEFAULT_SALT_PATH, 'utf8').trim(), 'base64');
  }
  mkdirSync(dirname(DEFAULT_SALT_PATH), { recursive: true });
  const salt = randomBytes(16);
  writeFileSync(DEFAULT_SALT_PATH, salt.toString('base64'), { mode: 0o600 });
  return salt;
}

function readKeyFile(path: string): Buffer {
  const raw = readFileSync(path, 'utf8').trim();
  for (const enc of ['base64', 'hex'] as const) {
    try {
      const buf = Buffer.from(raw, enc);
      if (buf.length === KEY_BYTES) return buf;
    } catch {
      /* try next encoding */
    }
  }
  // Not a raw 32-byte key: treat file contents as a passphrase.
  return scryptSync(raw, loadOrCreateSalt(), KEY_BYTES);
}

/**
 * Resolve the encryption key:
 *   1. THINKTANK_KEY passphrase  -> scrypt(passphrase, persisted salt)
 *   2. key file (THINKTANK_KEY_FILE or ~/.thinktank/key)
 *   3. generate a fresh random 32-byte key and persist it (0600)
 */
export function loadOrCreateKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const passphrase = env.THINKTANK_KEY?.trim();
  if (passphrase) {
    return scryptSync(passphrase, loadOrCreateSalt(), KEY_BYTES);
  }

  const keyPath = env.THINKTANK_KEY_FILE?.trim() || DEFAULT_KEY_PATH;
  if (existsSync(keyPath)) {
    return readKeyFile(keyPath);
  }

  const key = randomBytes(KEY_BYTES);
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* best effort on platforms without POSIX perms */
  }
  return key;
}

/** Build a Cipher from a 32-byte key. */
export function createCipher(key: Buffer): Cipher {
  if (key.length !== KEY_BYTES) {
    throw new Error(`thinktank cipher: key must be ${KEY_BYTES} bytes`);
  }
  return {
    encrypt(plain: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv(ALGO, key, iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      const tag = c.getAuthTag();
      return [
        MARKER,
        iv.toString('base64'),
        tag.toString('base64'),
        ct.toString('base64'),
      ].join(':');
    },
    decrypt(stored: string): string {
      const parts = stored.split(':');
      if (parts.length !== 4 || parts[0] !== MARKER) {
        throw new Error('thinktank cipher: value is not thinktank ciphertext');
      }
      const iv = Buffer.from(parts[1]!, 'base64');
      const tag = Buffer.from(parts[2]!, 'base64');
      const ct = Buffer.from(parts[3]!, 'base64');
      const d = createDecipheriv(ALGO, key, iv);
      d.setAuthTag(tag);
      // Wrong key / tampered data -> GCM auth fails here and throws.
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    },
  };
}

/**
 * The active cipher for this process, or null if encryption is disabled.
 * Callers (e.g. the MCP server's brain) pass the result into MemoryStore.
 */
export function resolveCipher(env: NodeJS.ProcessEnv = process.env): Cipher | null {
  if (!isEncryptionEnabled(env)) return null;
  return createCipher(loadOrCreateKey(env));
}
