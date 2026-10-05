/**
 * Zig reference resolution.
 *
 * Zig has no implicit imports and no global namespace: a name is either
 * declared in an enclosing scope of the same file, or reached through a
 * `const x = @import("path.zig")` binding (possibly re-bound: `const Server =
 * net.Server;`). The extractor (languages/zig.ts) emits every call / type use
 * as a dotted path whose root is one of those two, with `self` / `Self` /
 * typed locals already rewritten to their type. This rulebook follows exactly
 * those two routes and nothing else — a path it can't follow stays unresolved
 * (silent beats wrong), so it never falls through to project-wide bare-name
 * matching, which would bind `list.append` to whichever `append` exists.
 */

import * as path from 'path';
import type { Node } from '../types';
import type { ImportMapping, ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

/** Modules the compiler provides — never a repo file. */
const COMPILER_MODULES = new Set(['std', 'builtin', 'root']);

const IMPORT_RE = /^[ \t]*(?:pub[ \t]+)?const[ \t]+([A-Za-z_]\w*)[ \t]*(?::[ \t]*type[ \t]*)?=[ \t]*@import\([ \t]*"([^"]+)"[ \t]*\)((?:[ \t]*\.[ \t]*[A-Za-z_]\w*)*)[ \t]*;/gm;
const ALIAS_RE = /^[ \t]*(?:pub[ \t]+)?const[ \t]+([A-Za-z_]\w*)[ \t]*(?::[ \t]*type[ \t]*)?=[ \t]*([A-Za-z_]\w*)((?:[ \t]*\.[ \t]*[A-Za-z_]\w*)+)[ \t]*;/gm;

function members(chain: string | undefined): string[] {
  return (chain ?? '').split('.').map((s) => s.trim()).filter(Boolean);
}

/**
 * A Zig file's import bindings: `const x = @import("p")` (with any trailing
 * member chain) and aliases rooted in one (`const Allocator =
 * std.mem.Allocator`). `source` is the import path; `exportedName` the member
 * chain inside it (dotted, '' for the module itself). External modules (`std`)
 * are kept so their aliases are recognized — and refused — by the resolver.
 */
export function extractZigImports(content: string): ImportMapping[] {
  const byName = new Map<string, ImportMapping>();
  for (const m of content.matchAll(IMPORT_RE)) {
    byName.set(m[1]!, {
      localName: m[1]!,
      source: m[2]!,
      exportedName: members(m[3]).join('.'),
      isDefault: false,
      isNamespace: true,
    });
  }
  // Aliases may chain (`const a = std.x; const b = a.y;`): iterate to a fixpoint.
  const aliases = [...content.matchAll(ALIAS_RE)].map((m) => ({ local: m[1]!, root: m[2]!, chain: members(m[3]) }));
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const a of aliases) {
      if (byName.has(a.local) || a.local === a.root) continue;
      const base = byName.get(a.root);
      if (!base) continue;
      byName.set(a.local, {
        localName: a.local,
        source: base.source,
        exportedName: [...members(base.exportedName), ...a.chain].join('.'),
        isDefault: false,
        isNamespace: true,
      });
      changed = true;
    }
    if (!changed) break;
  }
  return [...byName.values()];
}

function resolveZigPath(importPath: string, fromFile: string, context: ResolutionContext): string | null {
  if (COMPILER_MODULES.has(importPath)) return null;
  if (!importPath.endsWith('.zig')) return namedModuleRoot(importPath, context);
  const dir = path.posix.dirname(fromFile.replace(/\\/g, '/'));
  const joined = path.posix.normalize(dir === '.' ? importPath : `${dir}/${importPath}`);
  if (joined.startsWith('../')) return null;
  return context.fileExists(joined) ? joined : null;
}

/**
 * A named module (`@import("zls")`) is wired up in build.zig, which we don't
 * evaluate. By overwhelming convention its root file is `<name>.zig`
 * (`src/zls.zig`, `clap.zig`), so resolve to that file when exactly ONE file
 * in the project has that name; otherwise (a dependency, or ambiguous) leave
 * it unresolved.
 */
function namedModuleRoot(name: string, context: ResolutionContext): string | null {
  if (!/^[A-Za-z_][\w-]*$/.test(name)) return null;
  const files = context.getNodesByName(`${name}.zig`).filter((n) => n.kind === 'file');
  return files.length === 1 ? files[0]!.filePath : null;
}

function fileNode(file: string, context: ResolutionContext): Node | undefined {
  return context.getNodesInFile(file).find((n) => n.kind === 'file');
}

/** Kinds a dotted path step may land on (bindings and containers, not locals). */
const SYMBOL_KINDS = new Set<Node['kind']>([
  'function', 'method', 'struct', 'union', 'enum', 'enum_member', 'constant', 'variable', 'field',
]);
const CONTAINER_KINDS = new Set<Node['kind']>(['struct', 'union', 'enum']);
/** `pub const f = a.b.f;` — a constant that only re-binds a member path. */
const ALIAS_SIGNATURE = /=\s*(?:@import\("[^"]*"\)|[A-Za-z_]\w*)(?:\.[A-Za-z_]\w*)+\s*;?$/;

/**
 * Walk `segs` from a file's top-level scope: the first segment is a top-level
 * declaration (or a re-exported import binding, followed into its file), each
 * further segment a member of the previous container.
 */
function walkFile(file: string, segs: string[], context: ResolutionContext, depth: number): Node | null {
  if (depth > 6) return null;
  if (segs.length === 0) return fileNode(file, context) ?? null;
  const nodes = context.getNodesInFile(file);
  const head = segs[0]!;
  const tops = nodes.filter((n) => n.qualifiedName === head && SYMBOL_KINDS.has(n.kind));
  const top = segs.length > 1 ? (tops.find((n) => CONTAINER_KINDS.has(n.kind)) ?? tops[0]) : (tops.find((n) => n.kind !== 'struct' && n.kind !== 'union') ?? tops[0]);
  if (!top || top.kind === 'constant' || top.kind === 'variable') {
    // Re-export: `pub const Server = @import("Server.zig");` / `pub const x =
    // net.x;` — follow it into the file it names. A re-export of something
    // outside the repo ends at the re-exporting constant itself.
    const binding = context.getImportMappings(file, 'zig').find((m) => m.localName === head);
    const target = binding ? resolveZigPath(binding.source, file, context) : null;
    const chased = binding && target
      ? walkFile(target, [...members(binding.exportedName), ...segs.slice(1)], context, depth + 1)
      : null;
    if (chased) return chased;
    if (!top) return null;
  }
  return walkMembers(top, segs.slice(1), nodes);
}

function walkMembers(start: Node, rest: string[], fileNodes: Node[]): Node | null {
  let cur = start;
  for (const seg of rest) {
    const qn = `${cur.qualifiedName}::${seg}`;
    const next = fileNodes.filter((n) => n.qualifiedName === qn && SYMBOL_KINDS.has(n.kind));
    const pick = next.find((n) => CONTAINER_KINDS.has(n.kind) || n.kind === 'function' || n.kind === 'method') ?? next[0];
    if (!pick) return null;
    cur = pick;
  }
  return cur;
}

/** The `::`-scopes enclosing a node, innermost first, ending with '' (file scope). */
function scopesOf(node: Node | null): string[] {
  const out: string[] = [];
  if (node && node.kind !== 'file') {
    const parts = node.qualifiedName.split('::');
    // A function's own name is a scope too (its nested decls), but Zig
    // functions have none we index; start from its container.
    for (let i = parts.length - 1; i >= 1; i--) out.push(parts.slice(0, i).join('::'));
  }
  out.push('');
  return out;
}

/** Lexical lookup of `name` from the caller's position in its own file. */
function lexical(name: string, ref: UnresolvedRef, context: ResolutionContext, wantContainer: boolean): Node | null {
  const caller = context.getNodeById?.(ref.fromNodeId) ?? null;
  const candidates = context
    .getNodesInFile(ref.filePath)
    .filter((n) => n.name === name && SYMBOL_KINDS.has(n.kind) && n.kind !== 'field' && n.kind !== 'enum_member');
  if (candidates.length === 0) return null;
  for (const scope of scopesOf(caller)) {
    const qn = scope ? `${scope}::${name}` : name;
    const inScope = candidates.filter((n) => n.qualifiedName === qn);
    if (inScope.length === 0) continue;
    if (wantContainer) return inScope.find((n) => CONTAINER_KINDS.has(n.kind)) ?? inScope[0]!;
    return inScope.find((n) => !CONTAINER_KINDS.has(n.kind)) ?? inScope[0]!;
  }
  return null;
}

function kindFits(target: Node, ref: UnresolvedRef): boolean {
  switch (ref.referenceKind) {
    case 'calls':
      // A call lands on a function / method, or on a `pub const f = x.f;`
      // re-export whose target lies outside the repo.
      return target.kind === 'function' || target.kind === 'method' ||
        (target.kind === 'constant' && ALIAS_SIGNATURE.test(target.signature ?? ''));
    // Every Zig file is a struct: `const Uri = @import("Uri.zig")` makes the
    // FILE the type, so a type use / `Uri{…}` through that binding lands on it.
    case 'instantiates':
      return CONTAINER_KINDS.has(target.kind) || target.kind === 'file';
    case 'references':
      return true;
    default:
      return true;
  }
}

function result(ref: UnresolvedRef, target: Node | null, confidence: number, by: ResolvedRef['resolvedBy']): ResolvedRef | null {
  if (!target || !kindFits(target, ref)) return null;
  if (target.id === ref.fromNodeId && ref.referenceKind !== 'calls') return null;
  return { original: ref, targetNodeId: target.id, confidence, resolvedBy: by };
}

/** Resolve one Zig reference — the whole rulebook (no fallthrough). */
export function resolveZigReference(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  // `const x = @import("x.zig")` → the file.
  if (ref.referenceKind === 'imports') {
    const file = resolveZigPath(ref.referenceName, ref.filePath, context);
    const node = file && file !== ref.filePath ? fileNode(file, context) : undefined;
    return node ? { original: ref, targetNodeId: node.id, confidence: 0.95, resolvedBy: 'import' } : null;
  }

  const name = ref.referenceName;
  // Inline import root: `@import(x.zig).f.g`
  const inline = /^@import\(([^)]*)\)((?:\.[^.]+)*)$/.exec(name);
  if (inline) {
    const file = resolveZigPath(inline[1]!, ref.filePath, context);
    if (!file) return null;
    return result(ref, walkFile(file, members(inline[2]), context, 0), 0.9, 'import');
  }

  const segs = name.split('.');
  const head = segs[0]!;

  // Through an import binding of this file.
  const binding = context.getImportMappings(ref.filePath, 'zig').find((m) => m.localName === head);
  if (binding) {
    const file = resolveZigPath(binding.source, ref.filePath, context);
    if (!file) return null; // std / build-system module / missing file
    return result(ref, walkFile(file, [...members(binding.exportedName), ...segs.slice(1)], context, 0), 0.9, 'import');
  }

  // Lexically, in the caller's own file. (Every Zig file is a struct, so a
  // path rewritten from `Self` at file scope arrives as a bare member name.)
  const start = lexical(head, ref, context, segs.length > 1 || ref.referenceKind !== 'calls');
  if (!start) return null;
  if (segs.length === 1) return result(ref, start, 0.95, 'exact-match');
  return result(ref, walkMembers(start, segs.slice(1), context.getNodesInFile(ref.filePath)), 0.9, 'qualified-name');
}
