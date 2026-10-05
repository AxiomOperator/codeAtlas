/**
 * Ruby scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolutionContext } from '../../types';

export const RUBY_ANCESTRY = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/**
 * Whether a bare Ruby call written inside a class body can mean `method`: a
 * receiver-less call is a call on `self`, so it reaches the class's own
 * methods, its superclasses', and those of the modules any of them
 * `include`s, `extend`s or `prepend`s — read from source, resolved against
 * the lexical nesting (`class Foo < Base` inside `module RuboCop::Cop` is
 * `RuboCop::Cop::Base`). A call in a module body, a block at the top of a
 * file (a spec, a DSL) or a script is not judged: a module's methods run on
 * whatever includes it, and a block may be evaluated on anything. rubocop's
 * `format(…)` — Kernel's — went to the LSP runtime's `format` 411 times.
 */
export function isRubyMethodInScope(method: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut < 0) return true;
  const here = context
    .getNodesInFile(ref.filePath)
    .filter((n) => (n.kind === 'class' || n.kind === 'module') && n.startLine <= ref.line && n.endLine >= ref.line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  if (!here || here.kind !== 'class') return true;
  return rubyAncestry(here.qualifiedName, context).has(method.qualifiedName.slice(0, cut));
}

/** A Ruby class's qualified name, those of its superclasses, and of every module mixed into any of them. */
function rubyAncestry(qn: string, context: ResolutionContext): Set<string> {
  let memo = RUBY_ANCESTRY.get(context);
  if (!memo) RUBY_ANCESTRY.set(context, (memo = new Map()));
  const hit = memo.get(qn);
  if (hit) return hit;
  const seen = new Set<string>();
  const queue = [qn];
  while (queue.length > 0 && seen.size < 60) {
    const q = queue.shift()!;
    if (seen.has(q)) continue;
    seen.add(q);
    for (const decl of context.getNodesByQualifiedName(q)) {
      if (decl.language !== 'ruby' || (decl.kind !== 'class' && decl.kind !== 'module')) continue;
      const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
      const outer = q.includes('::') ? q.slice(0, q.lastIndexOf('::')) : '';
      const sup = /^\s*class\s+[\w:]+\s*<\s*(::)?([A-Z][\w:]*)/.exec(lines[decl.startLine - 1] ?? '');
      if (sup) queue.push(rubyConstantQn(sup[2]!, sup[1] ? '' : outer, context));
      for (const line of lines.slice(decl.startLine, decl.endLine)) {
        const mix = /^\s*(?:include|extend|prepend)\s+([A-Z:][\w:]*(?:\s*,\s*[A-Z:][\w:]*)*)/.exec(line);
        if (!mix) continue;
        for (const name of mix[1]!.split(/\s*,\s*/)) {
          queue.push(name.startsWith('::') ? rubyConstantQn(name.slice(2), '', context) : rubyConstantQn(name, q, context));
        }
      }
    }
  }
  memo.set(qn, seen);
  return seen;
}

/** The class or module a constant written inside `scope` names: the nearest enclosing namespace that has it, else the name itself. */
function rubyConstantQn(name: string, scope: string, context: ResolutionContext): string {
  for (let prefix = scope; ; prefix = prefix.includes('::') ? prefix.slice(0, prefix.lastIndexOf('::')) : '') {
    const qn = prefix ? `${prefix}::${name}` : name;
    if (context.getNodesByQualifiedName(qn).some((n) => n.language === 'ruby' && (n.kind === 'class' || n.kind === 'module'))) return qn;
    if (!prefix) return name;
  }
}
