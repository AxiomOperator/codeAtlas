/**
 * Search scoping and result hygiene for `searchNodes` (#1520):
 *
 * - {@link nodeScopeSql}: one SQL predicate over a `nodes` alias for every
 *   candidate query (FTS, sub-word, LIKE, fuzzy, exact-name), so kind /
 *   language / path scoping narrows the candidate set BEFORE the limit
 *   instead of filtering an already-truncated list.
 * - {@link dedupeSearchResults}: collapse copies of the same symbol
 *   (scaffolded / vendored code) into the best-ranked one.
 */

import type { Language, NodeKind, SearchResult } from '../types';

export interface NodeScope {
  kinds?: NodeKind[];
  languages?: Language[];
  /** Keep a node when its path matches ANY of these (glob or substring). */
  includePatterns?: string[];
  /** Drop a node when its path matches ANY of these (glob or substring). */
  excludePatterns?: string[];
}

const GLOB_CHARS = /[*?[]/;

/**
 * One path pattern as a SQL predicate on `${alias}.file_path`.
 *
 * Glob patterns use SQLite GLOB (case-sensitive; `*` already crosses `/`, so
 * `**` collapses to `*` and `src/**\/x.ts` also matches `src/x.ts`). Anything
 * else is a case-insensitive substring — the same meaning the `path:` query
 * filter has always had.
 */
function pathPatternSql(alias: string, pattern: string): { sql: string; param: string } {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (GLOB_CHARS.test(p)) {
    const glob = p.replace(/\*\*\/?/g, '*').replace(/\*+/g, '*');
    return { sql: `${alias}.file_path GLOB ?`, param: glob };
  }
  return { sql: `instr(lower(${alias}.file_path), ?) > 0`, param: p.toLowerCase() };
}

/**
 * ` AND …` clause (possibly empty) plus its parameters, scoping the `nodes`
 * row aliased `alias`.
 */
export function nodeScopeSql(alias: string, scope: NodeScope): { sql: string; params: string[] } {
  let sql = '';
  const params: string[] = [];
  if (scope.kinds && scope.kinds.length > 0) {
    sql += ` AND ${alias}.kind IN (${scope.kinds.map(() => '?').join(',')})`;
    params.push(...scope.kinds);
  }
  if (scope.languages && scope.languages.length > 0) {
    sql += ` AND ${alias}.language IN (${scope.languages.map(() => '?').join(',')})`;
    params.push(...scope.languages);
  }
  const include = (scope.includePatterns ?? []).filter((p) => p.trim().length > 0);
  if (include.length > 0) {
    const parts = include.map((p) => pathPatternSql(alias, p.trim()));
    sql += ` AND (${parts.map((x) => x.sql).join(' OR ')})`;
    params.push(...parts.map((x) => x.param));
  }
  for (const p of (scope.excludePatterns ?? []).filter((x) => x.trim().length > 0)) {
    const part = pathPatternSql(alias, p.trim());
    sql += ` AND NOT (${part.sql})`;
    params.push(part.param);
  }
  return { sql, params };
}

/**
 * Collapse near-duplicate results: the same symbol copied into several files
 * (cookiecutter scaffolds, copied themes, vendored packages) shares kind,
 * name, qualified name, signature and body length. Results must arrive
 * ranked; the first (best) copy is kept and the others are recorded on its
 * `duplicates`. Distinct symbols that merely share a NAME (one `Migration`
 * class per migration file, platform-specific variants of a function) differ
 * in signature or length and are kept apart.
 */
export function dedupeSearchResults(results: SearchResult[]): SearchResult[] {
  const kept = new Map<string, SearchResult>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const n = r.node;
    const span = (n.endLine ?? n.startLine) - n.startLine;
    const key = [n.kind, n.name, n.qualifiedName, n.signature ?? '', span].join('\u0000');
    const head = kept.get(key);
    if (head && head.node.filePath !== n.filePath) {
      (head.duplicates ??= []).push({ id: n.id, filePath: n.filePath, startLine: n.startLine });
      continue;
    }
    if (!head) {
      const copy = { ...r };
      kept.set(key, copy);
      out.push(copy);
    } else {
      out.push(r);
    }
  }
  return out;
}
