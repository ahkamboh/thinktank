/**
 * Secret redaction. Runs on every ingest path BEFORE extraction, embedding, or
 * storage, so no credential is ever embedded, indexed, or written to disk.
 *
 * Design goals:
 *   - Catch the common, high-confidence secret shapes (provider API keys, AWS
 *     keys, tokens, private-key blocks, credentialed URLs, KEY=secret pairs).
 *   - Keep false positives LOW. We prefer leaking a low-risk string over
 *     mangling ordinary prose, so the generic high-entropy catch-all is
 *     deliberately conservative (long, mixed-charset, high-entropy only).
 *   - Never include the raw secret in the returned `found` metadata: previews
 *     are masked so findings can be logged safely.
 */

export interface RedactionFinding {
  /** A short label for what kind of secret was found, e.g. "apikey". */
  type: string;
  /** A masked, non-reversible preview of the matched value (safe to log). */
  preview: string;
}

export interface RedactionResult {
  /** The input with every detected secret replaced by a `[REDACTED:type]` tag. */
  text: string;
  /** One entry per redaction performed (masked). Empty if nothing matched. */
  found: RedactionFinding[];
}

/** Mask a secret down to a safe, non-reversible preview. */
function mask(secret: string): string {
  const s = secret.replace(/\s+/g, ' ').trim();
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 3)}…${s.slice(-2)} (${s.length} chars)`;
}

/** Shannon entropy in bits per character. */
function shannonPerChar(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Conservative test for a generic high-entropy secret: long, mixed letters and
 * digits, and high per-character entropy. Avoids matching ordinary words
 * (low entropy) and pure number/letter runs.
 */
function looksLikeHighEntropySecret(s: string): boolean {
  if (s.length < 40) return false;
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return false;
  return shannonPerChar(s) >= 4.0;
}

/**
 * One piece of a path, URL or identifier that reads like a word: lowercase,
 * Capitalized / camelCase, ALL-CAPS, or digits, at most 24 chars, with few
 * letter/digit switches ("plot33", "GitHub", "v3", "12oct2026"). Random
 * base62/base64 runs switch case mid-word ("wJalrXUtnFEMI") or flip between
 * letters and digits constantly ("Zk8QwP3nR7tY") and fail this. The regex has
 * no nested quantifiers, so it can't backtrack badly.
 */
const WORDY_PIECE_RE = /^(?:[A-Za-z0-9]?[a-z0-9]*(?:[A-Z][a-z0-9]+)*|[A-Z0-9]+)$/;

function letterDigitSwitches(p: string): number {
  let n = 0;
  for (let i = 1; i < p.length; i++) {
    if (/[0-9]/.test(p[i - 1]!) !== /[0-9]/.test(p[i]!)) n++;
  }
  return n;
}

function isWordyPiece(p: string): boolean {
  return p.length <= 24 && WORDY_PIECE_RE.test(p) && letterDigitSwitches(p) <= 4;
}

/** Made only of word-like pieces joined by separators (a path, slug, file name)? */
function isWordy(s: string): boolean {
  const pieces = s.split(/[/_+=-]+/).filter(Boolean);
  return pieces.length >= 2 && pieces.every(isWordyPiece);
}

/** One path/URL segment that is itself an embedded token (webhook id, reset key). */
function looksLikeSecretSegment(seg: string): boolean {
  if (seg.length < 20 || isWordy(seg) || isWordyPiece(seg)) return false;
  if (!/[A-Za-z]/.test(seg) || !/[0-9]/.test(seg)) return false;
  // Strictly above 4 bits/char: hex (commit SHAs) can't exceed it.
  return shannonPerChar(seg) > 4.0;
}

/**
 * Generic catch-all for one HIGH_ENTROPY_RE match. Ordinary file paths, URLs,
 * slugs and file names are long and mixed letters+digits too, so:
 *  - a match made only of word-like pieces is left alone;
 *  - a "/"-separated match that is mostly word-like segments is a path/URL,
 *    and only its token-looking segments are redacted;
 *  - anything else (a random base62/base64 blob, "/" or not) is redacted whole.
 */
function redactGeneric(m: string, found: RedactionFinding[]): string {
  if (m.includes('/')) {
    const segs = m.split('/');
    const nonEmpty = segs.filter(Boolean);
    const plain = nonEmpty.filter(
      (s) => s.length < 8 || isWordyPiece(s) || isWordy(s),
    ).length;
    if (plain * 2 >= nonEmpty.length) {
      return segs
        .map((s) => {
          if (!looksLikeSecretSegment(s)) return s;
          found.push({ type: 'high-entropy', preview: mask(s) });
          return '[REDACTED:token]';
        })
        .join('/');
    }
  }
  if (!looksLikeHighEntropySecret(m) || isWordy(m)) return m;
  found.push({ type: 'high-entropy', preview: mask(m) });
  return '[REDACTED:token]';
}

// -- Private key blocks (multi-line). Redact the whole armored block. --------
const PRIVATE_KEY_RE =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g;

// -- Credentialed connection strings: scheme://user:PASSWORD@host -----------
const CONN_STRING_RE = /\b([a-z][a-z0-9+.\-]*:\/\/)([^\s:/@]+):([^\s:/@]+)@/gi;

// -- Authorization: Bearer <token> (preserve the scheme word) ----------------
const BEARER_RE = /\b([Bb]earer)\s+([A-Za-z0-9._\-+/=]{8,})/g;

// -- KEY=secret / KEY: "secret" for sensitive-looking keys -------------------
// Value class excludes brackets so we never re-redact an existing placeholder.
const KV_SECRET_RE =
  /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|API[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|AUTH[_-]?KEY)[A-Za-z0-9_]*)\s*[:=]\s*"?([^\s"'\][]{4,})"?/gi;

// -- JSON Web Tokens ---------------------------------------------------------
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;

// -- AWS access key ids ------------------------------------------------------
const AWS_KEY_RE = /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g;

// -- GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_) ----------------------------
const GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g;

// -- Slack tokens ------------------------------------------------------------
const SLACK_TOKEN_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;

// -- Google API keys ---------------------------------------------------------
const GOOGLE_API_RE = /\bAIza[0-9A-Za-z_-]{20,}\b/g;

// -- OpenAI / Anthropic style keys: sk-..., sk-ant-..., sk-proj-... ----------
const PROVIDER_KEY_RE = /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g;

// -- Generic high-entropy token (last; gated by looksLikeHighEntropySecret) --
const HIGH_ENTROPY_RE = /\b[A-Za-z0-9+/_=-]{40,}\b/g;

/**
 * Redact secrets from a string. Order matters: armored blocks and structured
 * (scheme://, Bearer, KEY=value) forms run first so token-shaped patterns and
 * the generic high-entropy catch-all don't double-redact or fight them.
 */
export function redactSecrets(input: string): RedactionResult {
  if (!input) return { text: input, found: [] };

  let text = input;
  const found: RedactionFinding[] = [];

  // 1) Structured forms with custom, structure-preserving replacements.
  text = text.replace(PRIVATE_KEY_RE, (m) => {
    found.push({ type: 'private-key', preview: mask(m) });
    return '[REDACTED:private-key]';
  });

  text = text.replace(CONN_STRING_RE, (_m, scheme: string, user: string, pass: string) => {
    found.push({ type: 'connection-password', preview: mask(pass) });
    return `${scheme}${user}:[REDACTED:password]@`;
  });

  text = text.replace(BEARER_RE, (_m, scheme: string, tok: string) => {
    found.push({ type: 'bearer-token', preview: mask(tok) });
    return `${scheme} [REDACTED:bearer-token]`;
  });

  text = text.replace(KV_SECRET_RE, (_m, key: string, val: string) => {
    found.push({ type: 'secret-assignment', preview: mask(val) });
    return `${key}=[REDACTED:secret]`;
  });

  // 2) Token-shaped secrets.
  const tokenPatterns: Array<{ type: string; re: RegExp }> = [
    { type: 'jwt', re: JWT_RE },
    { type: 'aws-key', re: AWS_KEY_RE },
    { type: 'github-token', re: GITHUB_TOKEN_RE },
    { type: 'slack-token', re: SLACK_TOKEN_RE },
    { type: 'google-api-key', re: GOOGLE_API_RE },
    { type: 'apikey', re: PROVIDER_KEY_RE },
  ];
  for (const { type, re } of tokenPatterns) {
    text = text.replace(re, (m) => {
      found.push({ type, preview: mask(m) });
      return `[REDACTED:${type}]`;
    });
  }

  // 3) Conservative generic catch-all for anything secret-shaped we missed.
  text = text.replace(HIGH_ENTROPY_RE, (m) => redactGeneric(m, found));

  return { text, found };
}
