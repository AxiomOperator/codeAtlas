/**
 * Elixir reference resolution.
 *
 * The extractor (languages/elixir.ts) already did the scoping work: module
 * names are full dotted names, a module's functions are qualified
 * `Full.Module::fun`, and every remote call / struct literal / directive is
 * emitted with the call site's `alias`es expanded. So this rulebook is exact
 * lookup, with no name guessing:
 *
 *   - `Full.Mod::fun`  → that function (several clauses / arities share one
 *                        qualified name; the call site's file breaks ties);
 *   - `Full.Mod`       → that module or protocol (`alias`/`import`/`require`
 *                        → imports, `use`/`@behaviour`/`defimpl` →
 *                        implements, `%Mod{}` → references);
 *   - bare `fun`       → the caller's own module, else a module the file
 *                        `import`s that defines it (one, unambiguously).
 *
 * Anything else — Kernel/stdlib/dependency modules (`Enum`, `Ecto.Repo`, …) —
 * stays unresolved: a wrong edge is worse than none, and bare-name matching
 * across a Phoenix app binds every `get(conn, path)` to some unrelated `get`.
 */

import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { preferCallSiteFile } from './name-matcher';

const MODULE_KINDS = new Set<Node['kind']>(['module', 'protocol']);

function functionsNamed(qn: string, context: ResolutionContext): Node[] {
  return context.getNodesByQualifiedName(qn).filter((n) => n.language === 'elixir' && n.kind === 'function');
}

/** Module that owns `node`: a function's qualifier, or a module node itself. */
function moduleOf(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (MODULE_KINDS.has(node.kind)) return node.qualifiedName;
  const sep = node.qualifiedName.lastIndexOf('::');
  return sep > 0 ? node.qualifiedName.slice(0, sep) : null;
}

const IMPORT_RE = /^[ \t]*import[ \t]+([A-Z][\w.]*)/gm;
const ALIAS_RE = /^[ \t]*alias[ \t]+([A-Z][\w.]*)(?:[ \t]*,[ \t]*as:[ \t]*([A-Z]\w*))?/gm;

/**
 * Modules a file `import`s, alias-expanded with the file's simple
 * `alias A.B` / `alias A.B, as: C` lines. File-wide rather than per-module —
 * multi-module files almost never import conflicting names.
 */
function importedModules(file: string, context: ResolutionContext): string[] {
  const content = context.readFile(file);
  if (!content) return [];
  const aliases = new Map<string, string>();
  for (const m of content.matchAll(ALIAS_RE)) {
    const full = m[1]!;
    aliases.set(m[2] ?? full.split('.').pop()!, full);
  }
  const out: string[] = [];
  for (const m of content.matchAll(IMPORT_RE)) {
    const written = m[1]!;
    const segs = written.split('.');
    const mapped = aliases.get(segs[0]!);
    out.push(mapped ? [mapped, ...segs.slice(1)].join('.') : written);
  }
  return out;
}

function hit(ref: UnresolvedRef, node: Node, confidence: number, by: ResolvedRef['resolvedBy']): ResolvedRef {
  return { original: ref, targetNodeId: node.id, confidence, resolvedBy: by };
}

/** Resolve one Elixir reference — the whole rulebook (no fallthrough). */
export function resolveElixirReference(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName;

  // Remote: `Full.Mod::fun`
  if (name.includes('::')) {
    const fns = preferCallSiteFile(functionsNamed(name, context), ref.filePath);
    return fns[0] ? hit(ref, fns[0], 0.95, 'qualified-name') : null;
  }

  // Module reference: `Full.Mod`
  if (/^[A-Z]/.test(name)) {
    const mods = context
      .getNodesByQualifiedName(name)
      .filter((n) => n.language === 'elixir' && MODULE_KINDS.has(n.kind));
    const chosen = preferCallSiteFile(mods, ref.filePath)[0];
    if (!chosen || chosen.id === ref.fromNodeId) return null;
    return hit(ref, chosen, 0.95, 'qualified-name');
  }

  if (ref.referenceKind !== 'calls' && ref.referenceKind !== 'references') return null;

  // Bare local call: the caller's own module first (by language semantics a
  // bare call can only mean a function of the same module or an import).
  const callerModule = moduleOf(context.getNodeById?.(ref.fromNodeId));
  if (callerModule) {
    const own = preferCallSiteFile(functionsNamed(`${callerModule}::${name}`, context), ref.filePath);
    if (own[0]) return hit(ref, own[0], 0.95, 'exact-match');
  }
  // …then an `import`ed module that defines it — only when exactly one does.
  const providers = new Map<string, Node>();
  for (const mod of importedModules(ref.filePath, context)) {
    const fn = preferCallSiteFile(functionsNamed(`${mod}::${name}`, context), ref.filePath)[0];
    if (fn) providers.set(mod, fn);
  }
  if (providers.size === 1) return hit(ref, [...providers.values()][0]!, 0.85, 'import');
  return null;
}
