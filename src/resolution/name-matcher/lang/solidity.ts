/**
 * Solidity scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolutionContext } from '../../types';

export const SOLIDITY_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();
export const SOLIDITY_HIERARCHIES = new WeakMap<ResolutionContext, WeakMap<UnresolvedRef, Set<string>>>();
const SOLIDITY_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'struct', 'module', 'trait']);

/** What a Solidity contract, interface or library inherits: `contract Governor is Context, ERC165(…), IGovernor {`. */
function soliditySupertypesOf(name: string, context: ResolutionContext): string[] {
  let memo = SOLIDITY_SUPERS.get(context);
  if (!memo) SOLIDITY_SUPERS.set(context, (memo = new Map()));
  const hit = memo.get(name);
  if (hit) return hit;
  const supers: string[] = [];
  for (const decl of context.getNodesByName(name)) {
    if (decl.language !== 'solidity' || !SOLIDITY_TYPE_KINDS.has(decl.kind)) continue;
    const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
    let depth = 0;
    let head = '';
    for (const ch of lines.slice(decl.startLine - 1, decl.startLine + 10).join(' ').replace(/\/\/[^\n]*|\/\*.*?\*\//g, ' ')) {
      if (ch === '{' && depth === 0) break;
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0) head += ch;
    }
    const clause = /\bis\b([\s\S]*)$/.exec(head)?.[1] ?? '';
    for (const m of clause.matchAll(/([A-Za-z_]\w*)\s*(?=,|$)/g)) supers.push(m[1]!);
  }
  memo.set(name, supers);
  return supers;
}

/**
 * Whether a bare Solidity call can reach method `n`: a function of the
 * contract around the call or of one it inherits, or a free function.
 * OpenZeppelin's `_msgSender()` in Governor (a Context) went to
 * ERC2771Context's override 83 times.
 */
export function isSolidityMemberInScope(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (n.kind !== 'method' || n.language !== 'solidity') return true;
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut <= 0) return true;
  const owner = n.qualifiedName.slice(0, cut).split('::').pop()!;
  let memo = SOLIDITY_HIERARCHIES.get(context);
  if (!memo) SOLIDITY_HIERARCHIES.set(context, (memo = new WeakMap()));
  let names = memo.get(ref);
  if (!names) {
    names = new Set<string>();
    const queue = context.getNodesInFile(ref.filePath)
      .filter((c) => SOLIDITY_TYPE_KINDS.has(c.kind) && c.startLine <= ref.line && c.endLine >= ref.line)
      .map((c) => c.name);
    while (queue.length > 0 && names.size < 60) {
      const name = queue.shift()!;
      if (names.has(name)) continue;
      names.add(name);
      queue.push(...soliditySupertypesOf(name, context));
    }
    memo.set(ref, names);
  }
  return names.has(owner);
}

/** Whether a Solidity call is written with no receiver (`_msgSender()`, not `token._msgSender()`). */
export function isReceiverLessSolidityCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.language !== 'solidity' || ref.referenceKind !== 'calls' || !/^[A-Za-z_]\w*$/.test(ref.referenceName)) return false;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (!line) return false;
  const m = new RegExp(`(?<![\\w$])${ref.referenceName}\\s*\\(`).exec(line);
  return !!m && !/\.\s*$/.test(line.slice(0, m.index));
}
