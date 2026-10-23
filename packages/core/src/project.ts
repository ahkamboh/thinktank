import { existsSync, readFileSync } from 'node:fs';

/**
 * Normalized identity of a project name, used to MATCH project scopes. Case,
 * whitespace and the common separators (- _ .) are ignored, so "Think_Tank",
 * "think-tank" and "thinktank" all address the same project. The raw name is
 * still what gets stored and displayed.
 */
export function projectKey(project: string): string {
  return project.normalize('NFKC').toLowerCase().replace(/[\s._-]+/g, '');
}

/** Alias map keyed by projectKey(alias) -> canonical project name. */
export type ProjectAliases = Record<string, string>;

/**
 * Build an alias lookup from a plain `{ alias: canonical }` object. Keys are
 * normalized with projectKey so aliases match the same way projects do.
 */
export function normalizeAliases(raw: Record<string, unknown> | undefined): ProjectAliases {
  const out: ProjectAliases = {};
  if (!raw) return out;
  for (const [alias, target] of Object.entries(raw)) {
    if (typeof target !== 'string' || !target.trim() || !alias.trim()) continue;
    out[projectKey(alias)] = target.trim();
  }
  return out;
}

/**
 * Read an optional `{ "alias": "canonical" }` JSON file (e.g. a worktree folder
 * name -> its repo). A missing or unreadable file means "no aliases".
 */
export function loadProjectAliases(path: string): ProjectAliases {
  if (!existsSync(path)) return {};
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v)
      ? normalizeAliases(v as Record<string, unknown>)
      : {};
  } catch (err) {
    console.error(`[thinktank] ignoring unreadable project alias file ${path}: ${String(err)}`);
    return {};
  }
}
