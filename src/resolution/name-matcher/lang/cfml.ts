/**
 * CFML scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolutionContext } from '../../types';
import { hasNoReceiverOnLine } from '../call-shape';

export const CFML_CHAINS = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/**
 * Whether a bare CFML call written in a component can mean `method`: its own
 * component's, or one of the components it `extends` (read from source — a
 * dotted path matched against the indexed files by its longest suffix). A
 * call in a `.cfm` template is not judged: a ColdBox view runs inside the
 * renderer's scope. coldbox's `now()` — the built-in — went to a date
 * helper's `now` 228 times; chained `.then()` calls arrive bare too, and keep
 * their method.
 */
export function isCfmlMethodInScope(method: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (!/\.cfc$/i.test(ref.filePath) || !hasNoReceiverOnLine(ref, context)) return true;
  return cfmlChain(ref.filePath, context).has(method.filePath);
}

/** A component file and every component file it extends. */
function cfmlChain(file: string, context: ResolutionContext): Set<string> {
  let memo = CFML_CHAINS.get(context);
  if (!memo) CFML_CHAINS.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const chain = new Set<string>();
  const queue = [file];
  while (queue.length > 0 && chain.size < 30) {
    const f = queue.shift()!;
    if (chain.has(f)) continue;
    chain.add(f);
    const text = context.readFile(f) ?? '';
    const head = text.slice(0, text.search(/\bfunction\b|<cffunction/i) >>> 0 || text.length);
    const ext = /\bextends\s*=\s*["']?([\w.\/:-]+)["']?/i.exec(head)?.[1];
    if (ext) queue.push(...cfmlComponentFiles(ext, f, context));
  }
  memo.set(file, chain);
  return chain;
}

/** The indexed `.cfc` files a component path names: the same directory first, else the longest path suffix. */
function cfmlComponentFiles(dotted: string, from: string, context: ResolutionContext): string[] {
  const segments = dotted.replace(/\//g, '.').split('.').filter(Boolean);
  const name = segments[segments.length - 1]!.toLowerCase();
  const files = [...new Set(context.getNodesByLowerName(name)
    .filter((n) => n.kind === 'class' && /\.cfc$/i.test(n.filePath))
    .map((n) => n.filePath))];
  if (files.length === 0) return [];
  const dir = from.slice(0, from.lastIndexOf('/') + 1);
  if (segments.length === 1) {
    const local = files.filter((f) => f.slice(0, f.lastIndexOf('/') + 1) === dir);
    return local.length > 0 ? local : files;
  }
  for (let take = segments.length; take >= 1; take--) {
    const suffix = '/' + segments.slice(-take).join('/').toLowerCase() + '.cfc';
    const hits = files.filter((f) => ('/' + f.toLowerCase()).endsWith(suffix));
    if (hits.length > 0) return hits;
  }
  return files;
}
