import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

// --------------------------------------------------------------------------
// Shared helpers for locating + reading a ChatGPT/Claude export's JSON from a
// .zip (in memory) or a path. Used by both the dashboard /api/import endpoint
// (buffer in) and the CLI `ingest` command (filesystem path in), so the zip
// handling lives in exactly one place.
//
// Heap note: real exports are large (a Claude `conversations.json` can be
// ~130MB+). Parsing one needs roughly ~1GB of heap transiently. Node's default
// old-space limit is usually enough on a typical dev machine, but on a
// memory-constrained host raise it with:  NODE_OPTIONS=--max-old-space-size=4096
// --------------------------------------------------------------------------

/** A user-input problem (bad zip, missing/empty entry) -> a 4xx, never a 500. */
export class ImportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportInputError';
  }
}

/** True if the buffer starts with the ZIP "PK" local/central/spanned magic. */
export function looksLikeZip(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 && // 'P'
    buf[1] === 0x4b && // 'K'
    (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)
  );
}

/** Pull and JSON-parse conversations.json out of an export .zip (in memory). */
export function extractConversationsFromZip(buffer: Buffer): unknown {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new ImportInputError(
      'Could not read the .zip file: ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const entries = zip.getEntries();
  const entry =
    entries.find(
      (e) => !e.isDirectory && /(^|\/)conversations\.json$/i.test(e.entryName),
    ) ??
    entries.find(
      (e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.json'),
    );
  if (!entry) {
    throw new ImportInputError(
      'That .zip has no conversations.json. Upload the ChatGPT/Claude data-export zip (it contains conversations.json).',
    );
  }
  const text = zip.readAsText(entry);
  if (!text.trim()) {
    throw new ImportInputError('conversations.json inside the .zip is empty.');
  }
  return JSON.parse(text);
}

/**
 * Load export JSON from a filesystem path. Accepts:
 *   - a data-export DIRECTORY  -> reads <dir>/conversations.json
 *   - a .zip                   -> extracts conversations.json from it
 *   - any other file           -> read + JSON.parse as-is
 * Throws {@link ImportInputError} with a clear message on any of the above
 * failing (missing dir entry, unreadable zip, etc.). JSON.parse errors bubble
 * up as SyntaxError.
 */
export function loadExportFromPath(path: string): unknown {
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    throw new ImportInputError(
      `cannot access ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (stat.isDirectory()) {
    const convo = join(path, 'conversations.json');
    let text: string;
    try {
      text = readFileSync(convo, 'utf8');
    } catch {
      throw new ImportInputError(
        `${path} is a data-export directory but has no conversations.json (expected at ${convo}).`,
      );
    }
    return JSON.parse(text);
  }

  if (path.toLowerCase().endsWith('.zip')) {
    return extractConversationsFromZip(readFileSync(path));
  }

  return JSON.parse(readFileSync(path, 'utf8'));
}
