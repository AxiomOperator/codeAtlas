/**
 * Query-token helpers for `codegraph_explore`: spelling normalization and the
 * fs/DB lookups `extractQueryPaths` takes. Moved out of `tools.ts` unchanged.
 */

import type CodeGraph from '../index';
import { isQualifiedSymbol, lastQualifierPart, matchesSymbol } from '../graph/symbol-lookup';
import { validatePathWithinRoot } from '../utils';
import { statSync } from 'fs';

/**
 * Normalize Erlang-native symbol spellings in an explore query into the shapes
 * the rest of the pipeline already understands. Agents working Erlang code
 * name symbols the way the language spells them — `mod:fn/3`, `init/2` — and
 * those tokens previously died in both consumers: the flow-builder's token
 * filter rejects `:` and `/arity` outright, and the search-side field parser
 * eats `mod:fn` as an unknown `field:value`. Measured on cowboy: the agent
 * named `cowboy_stream_h:request_process/3` in two queries, got no body back
 * either time, and fell back to Read.
 *
 *   - `fn/3` → `fn` (arity tail after an identifier; a path segment like
 *     `src/2fa` doesn't match because the tail must be all digits)
 *   - `mod:fn` → `mod.fn` (exactly one colon between identifiers, so it rides
 *     the existing Class.method qualified handling; `::`, URLs, drive letters,
 *     and times don't match, and the query language's own field prefixes —
 *     kind:/lang:/language:/path:/name: — are left alone)
 *
 * Safe cross-language: Lua's `t:m` spelling maps to the same `t.m` its
 * qualified names use, and no other supported spelling contains a bare
 * single-colon identifier pair.
 */
export function normalizeQuerySpelling(query: string): string {
  return query
    .replace(/\b([A-Za-z_][\w@]*)\/(\d{1,3})(?=$|[\s,()[\]/])/g, '$1')
    .replace(
      /(^|[\s,()[\]])(?!(?:kind|lang|language|path|name):)([a-z_][\w@]*):([A-Za-z_][\w@]*)(?=$|[\s,()[\]])/g,
      '$1$2.$3'
    );
}

/**
 * Does this query-named span point at a real FILE inside the project?
 *
 * The `existsOnDisk` predicate `extractQueryPaths` takes (that module is pure —
 * no DB, no fs — so the fs access lives here, where the project root is known).
 * Only a REGULAR FILE counts: a directory span (`src/search`) is not a file
 * reference and must keep flowing to the normal matching pipeline. Containment
 * is enforced by `validatePathWithinRoot`, so a `../` span in a query cannot
 * probe outside the project, and every fs error answers `false`.
 */
export function pathIsProjectFile(projectRoot: string, relPath: string): boolean {
  try {
    const abs = validatePathWithinRoot(projectRoot, relPath);
    return abs !== null && statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Kinds that name a thing without defining it in the file that holds them. */
export const NOT_A_DEFINITION = new Set(['file', 'import', 'export', 'parameter']);

/**
 * Which indexed files define a symbol spelled like this query token?
 *
 * The `symbolFiles` lookup `extractQueryPaths` takes, split out for the same
 * reason as `pathIsProjectFile`: that module stays DB-free. Exact names only —
 * and the shared matcher for a qualified token (`SQLCompiler.as_sql`) — so it
 * agrees with what explore's named-symbol seeding resolves. Lookup errors
 * answer "none", which leaves the span's pins as they were.
 */
export function filesDefiningSymbol(cg: CodeGraph, symbol: string): string[] {
  try {
    const nodes = isQualifiedSymbol(symbol)
      ? cg.getNodesByName(lastQualifierPart(symbol)).filter((n) => matchesSymbol(n, symbol))
      : cg.getNodesByName(symbol);
    return nodes.filter((n) => !NOT_A_DEFINITION.has(n.kind)).map((n) => n.filePath);
  } catch {
    return [];
  }
}
