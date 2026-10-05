/**
 * Erlang scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { UnresolvedRef, ResolutionContext } from '../../types';

/** The module an Erlang file `-import`s `name/arity` from, or undefined. */
export function erlangImportedModule(name: string, arity: string, ref: UnresolvedRef, context: ResolutionContext): string | undefined {
  const source = context.readFile(ref.filePath);
  if (!source || !source.includes('-import')) return undefined;
  const fn = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const m of source.matchAll(/^-import\(\s*'?([A-Za-z_][\w@]*)'?\s*,\s*\[([^\]]*)\]\s*\)\s*\./gm)) {
    if (new RegExp(`(?:^|[\\s,])'?${fn}'?\\s*/\\s*${arity}\\b`).test(m[2]!)) return m[1]!;
  }
  return undefined;
}
