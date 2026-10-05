import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField, getPrecedingDocstring } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import type { NodeKind, ReferenceKind } from '../../types';

// Node names follow the vendored tree-sitter-grammars/tree-sitter-zig grammar
// (1.1.2, ABI 14).
//
// Zig declares nearly everything with `const`: a container type
// (`const Point = struct {…}`), a file import (`const util =
// @import("util.zig")`), an alias (`const Allocator = std.mem.Allocator`) and a
// plain value all share `variable_declaration`, so declarations are dispatched
// from the visitNode hook:
//   - `struct`/`union`/`enum`/`opaque`/`error{…}` values mint struct / union /
//     enum nodes named by the binding, with `fn`s inside them as methods and
//     `container_field`s as fields (enum tags as enum members);
//   - `@import("x.zig")` mints an `import` node plus an `imports` ref to the
//     file; `@import("std")` and other compiler/build-system modules are
//     external and mint nothing;
//   - a generic type function (`fn List(comptime T: type) type { return
//     struct {…}; }`) also indexes the returned container under the function's
//     name — that container IS the type every caller uses;
//   - `test "name" {…}` blocks become functions named `test "name"`.
//
// Calls are emitted by zigCallRefs (the core extractCall defers to it) as the
// callee's dotted path with the receiver rewritten to a TYPE wherever the
// syntax says what it is: `self.helper()` → `Thing.helper` (self's parameter
// type), `Self.init()` → `Thing.init` (`const Self = @This()`), `t.bump()` →
// `Thing.bump` when `t` was declared `var t = Thing{}` / `Thing.init(…)` / `:
// Thing`. Calls into `std` are dropped. The Zig rulebook in
// src/resolution/zig.ts then resolves a path lexically (same file) or through
// the file's `@import` bindings — never by bare name across the project.

const CONTAINER_TYPES = new Set([
  'struct_declaration',
  'union_declaration',
  'enum_declaration',
  'opaque_declaration',
  'error_set_declaration',
]);

/**
 * Modules the compiler provides — never a file in the repo. A NAMED module
 * other than these (`@import("zls")`, `@import("clap")`) is registered by
 * build.zig and may well be this project's own root file, so it is kept for
 * the resolver to look up.
 */
const COMPILER_MODULES = new Set(['std', 'builtin', 'root']);

export function isZigExternalImport(path: string): boolean {
  return COMPILER_MODULES.has(path);
}

function collapseWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hasToken(node: SyntaxNode, token: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === token) return true;
  }
  return false;
}

function isPub(node: SyntaxNode): boolean {
  return hasToken(node, 'pub') || hasToken(node, 'export');
}

/** The declared name of a variable_declaration (first named identifier child). */
function declName(node: SyntaxNode, source: string): string | null {
  const first = node.namedChildren.find((c) => c.type !== 'comment');
  return first?.type === 'identifier' ? getNodeText(first, source) : null;
}

/** The initializer of a variable_declaration (after the name, not the `type:`). */
function declValue(node: SyntaxNode): SyntaxNode | null {
  const typeNode = getChildByField(node, 'type');
  const named = node.namedChildren.filter((c) => c.type !== 'comment');
  for (let i = named.length - 1; i >= 1; i--) {
    const c = named[i]!;
    if (typeNode && c.startIndex === typeNode.startIndex && c.endIndex === typeNode.endIndex) continue;
    return c;
  }
  return null;
}

/** A real `const`/`var` declaration — the grammar also uses this node for `x = y;` assignments. */
function isDeclaration(node: SyntaxNode): boolean {
  return node.type === 'variable_declaration' && (hasToken(node, 'const') || hasToken(node, 'var'));
}

/** `@import("x")` → `x`, else null. */
function importPath(node: SyntaxNode | null, source: string): string | null {
  if (node?.type !== 'builtin_function') return null;
  const ident = node.namedChildren.find((c) => c.type === 'builtin_identifier');
  if (!ident || getNodeText(ident, source) !== '@import') return null;
  const arg = node.namedChildren.find((c) => c.type === 'arguments')?.namedChildren.find((c) => c.type === 'string');
  const content = arg?.namedChildren.find((c) => c.type === 'string_content');
  return content ? getNodeText(content, source) : arg ? '' : null;
}

/** `@import("x")` at the root of a member chain (`@import("lsp").offsets`) → `x`. */
function rootImportPath(node: SyntaxNode | null, source: string): string | null {
  let n = node;
  while (n?.type === 'field_expression') n = getChildByField(n, 'object');
  return importPath(n, source);
}

function isThisBuiltin(node: SyntaxNode | null, source: string): boolean {
  if (node?.type !== 'builtin_function') return false;
  const ident = node.namedChildren.find((c) => c.type === 'builtin_identifier');
  return !!ident && getNodeText(ident, source) === '@This';
}

/**
 * Unwrap a container declaration from a declaration value — directly, or
 * through grouping wrappers the grammar may insert.
 */
function containerOf(value: SyntaxNode | null): SyntaxNode | null {
  if (!value) return null;
  if (CONTAINER_TYPES.has(value.type)) return value;
  if (value.type === 'parenthesized_expression') return containerOf(value.namedChildren[0] ?? null);
  return null;
}

/**
 * The container a generic type function returns (`return struct {…};`), found
 * at statement level of its body — not inside nested containers or functions.
 */
function returnedContainer(body: SyntaxNode | null): SyntaxNode | null {
  if (!body) return null;
  let found: SyntaxNode | null = null;
  const visit = (n: SyntaxNode): void => {
    if (found || CONTAINER_TYPES.has(n.type) || n.type === 'function_declaration') return;
    if (n.type === 'return_expression') {
      found = containerOf(n.namedChildren[0] ?? null);
      return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(body);
  return found;
}

// ---------------------------------------------------------------------------
// Container naming (shared by declarations and call-receiver rewriting).
// ---------------------------------------------------------------------------

/**
 * The name a container declaration is known by: the binding it is assigned to
 * (`const Point = struct {…}`), or the generic function that returns it. Null
 * for an anonymous container (a struct literal passed as an argument, …).
 */
function containerName(container: SyntaxNode, source: string): string | null {
  const parent = container.parent;
  if (parent?.type === 'variable_declaration') return declName(parent, source);
  // `return struct {…}` inside `fn List(...) type` → "List"
  let n: SyntaxNode | null = parent;
  while (n && n.type !== 'function_declaration' && !CONTAINER_TYPES.has(n.type)) n = n.parent;
  if (n?.type === 'function_declaration') {
    const body = getChildByField(n, 'body');
    const ret = returnedContainer(body);
    if (ret && ret.startIndex === container.startIndex) {
      const name = getChildByField(n, 'name');
      return name ? getNodeText(name, source) : null;
    }
  }
  return null;
}

/** Nearest enclosing container declaration of `node` (exclusive), or null at file scope. */
function enclosingContainer(node: SyntaxNode): SyntaxNode | null {
  let n = node.parent;
  while (n && !CONTAINER_TYPES.has(n.type)) n = n.parent;
  return n;
}

/**
 * Dotted path of a container from file scope (`Outer.Inner`), '' for the file
 * itself (every Zig file is a struct), or null when any level is anonymous.
 */
function containerPath(container: SyntaxNode | null, source: string): string | null {
  if (!container) return '';
  const name = containerName(container, source);
  if (!name) return null;
  const outer = containerPath(enclosingContainer(container), source);
  if (outer === null) return null;
  return outer ? `${outer}.${name}` : name;
}

/** Direct member declarations of a container (or of the file root). */
function scopeDecls(scope: SyntaxNode): SyntaxNode[] {
  return scope.namedChildren.filter((c) => c.type === 'variable_declaration');
}

/**
 * What a name means at `node`'s position, as far as call rewriting cares:
 * a container (via `const X = @This()` in an enclosing container or at file
 * scope → that container's path), or an external module binding
 * (`const std = @import("std")`, `const mem = std.mem`). Undefined otherwise.
 */
type Binding = { kind: 'container'; path: string } | { kind: 'external' };

function lookupBinding(node: SyntaxNode, name: string, source: string, depth = 0): Binding | undefined {
  if (depth > 4) return undefined;
  let scope: SyntaxNode | null = enclosingContainer(node);
  for (;;) {
    const host: SyntaxNode | null = scope ?? root(node);
    if (host) {
      for (const decl of scopeDecls(host)) {
        if (declName(decl, source) !== name) continue;
        const value = declValue(decl);
        if (isThisBuiltin(value, source)) {
          const path = containerPath(scope, source);
          return path === null ? undefined : { kind: 'container', path };
        }
        const imp = rootImportPath(value, source);
        if (imp !== null) return isZigExternalImport(imp) ? { kind: 'external' } : undefined;
        // `const mem = std.mem;` / `const log = std.log.scoped(.x);` — a
        // value rooted in an external binding.
        const rootName = value ? chainRoot(value.type === 'call_expression' ? (getChildByField(value, 'function') ?? value) : value, source) : null;
        if (rootName && rootName !== name) {
          const b = lookupBinding(decl, rootName, source, depth + 1);
          if (b?.kind === 'external') return b;
        }
        return undefined;
      }
    }
    if (!scope) return undefined;
    scope = enclosingContainer(scope);
  }
}

function root(node: SyntaxNode): SyntaxNode {
  let n = node;
  while (n.parent) n = n.parent;
  return n;
}

/** Identifier at the root of an `a.b.c` chain, or null for any other shape. */
function chainRoot(node: SyntaxNode, source: string): string | null {
  let n: SyntaxNode | null = node;
  while (n?.type === 'field_expression') n = getChildByField(n, 'object');
  return n?.type === 'identifier' ? getNodeText(n, source) : null;
}

/**
 * Flatten an `a.b.c` field chain into its segments, or null when any link is
 * not a plain identifier. An inline `@import("x.zig").f` root is kept as the
 * single segment `@import(x.zig)`.
 */
function chainSegments(node: SyntaxNode, source: string): string[] | null {
  if (node.type === 'identifier') return [getNodeText(node, source)];
  if (node.type === 'builtin_function') {
    const p = importPath(node, source);
    return p ? [`@import(${p})`] : null;
  }
  if (node.type !== 'field_expression') return null;
  const obj = getChildByField(node, 'object');
  const member = getChildByField(node, 'member');
  if (!obj || member?.type !== 'identifier') return null;
  const head = chainSegments(obj, source);
  return head ? [...head, getNodeText(member, source)] : null;
}

/**
 * Segments naming the type a type expression denotes: a plain `a.B` chain, or
 * a generic instantiation `List(u8)` / `lib.List(u8)` (the generic function's
 * returned container is indexed under the function's name).
 */
function typeExprSegments(node: SyntaxNode, source: string): string[] | null {
  if (node.type === 'call_expression') {
    const f = getChildByField(node, 'function');
    return f ? chainSegments(f, source) : null;
  }
  return chainSegments(node, source);
}

/** Strip pointer / optional / const wrappers off a type expression. */
function baseType(node: SyntaxNode | null): SyntaxNode | null {
  let n = node;
  while (n && (n.type === 'pointer_type' || n.type === 'nullable_type' || n.type === 'error_union_type')) {
    if (n.type === 'error_union_type') n = getChildByField(n, 'ok');
    else n = n.namedChildren[n.namedChildren.length - 1] ?? null;
  }
  return n;
}

/**
 * The type a local receiver name was declared with, as dotted segments: a
 * parameter `self: *Thing`, a typed local `var t: Thing`, a struct literal
 * `var t = Thing{…}`, or a constructor-style call `const s = Server.init(…)`
 * (`try` unwrapped). Null when the syntax doesn't say.
 */
function receiverType(call: SyntaxNode, name: string, source: string): string[] | null {
  let fn: SyntaxNode | null = call.parent;
  while (fn && fn.type !== 'function_declaration' && fn.type !== 'test_declaration' && !CONTAINER_TYPES.has(fn.type)) fn = fn.parent;
  if (!fn || CONTAINER_TYPES.has(fn.type)) return null;

  if (fn.type === 'function_declaration') {
    const params = fn.namedChildren.find((c) => c.type === 'parameters');
    for (const p of params?.namedChildren ?? []) {
      const pn = getChildByField(p, 'name');
      if (!pn || getNodeText(pn, source) !== name) continue;
      const t = baseType(getChildByField(p, 'type'));
      return t ? typeExprSegments(t, source) : null;
    }
  }

  // Nearest preceding local declaration of `name` in an enclosing block.
  let best: SyntaxNode | null = null;
  const visit = (n: SyntaxNode): void => {
    if (n.startIndex >= call.startIndex) return;
    if (n.type === 'variable_declaration' && isDeclaration(n) && declName(n, source) === name) {
      if (!best || n.startIndex > best.startIndex) best = n;
    }
    if (n.type === 'function_declaration' || CONTAINER_TYPES.has(n.type)) return;
    for (const c of n.namedChildren) visit(c);
  };
  const body = fn.type === 'function_declaration' ? getChildByField(fn, 'body') : fn.namedChildren.find((c) => c.type === 'block');
  if (body) for (const c of body.namedChildren) visit(c);
  if (!best) return null;
  const decl: SyntaxNode = best;
  const annotated = baseType(getChildByField(decl, 'type'));
  if (annotated) return typeExprSegments(annotated, source);
  let value = declValue(decl);
  while (value && value.type === 'try_expression') value = value.namedChildren[0] ?? null;
  if (!value) return null;
  if (value.type === 'struct_initializer') {
    const t = value.namedChildren[0];
    return t ? typeExprSegments(t, source) : null;
  }
  if (value.type === 'call_expression') {
    const f = getChildByField(value, 'function');
    if (f?.type !== 'field_expression') return null;
    // `List(u8).init(…)`: the receiver is a generic instantiation.
    const obj = getChildByField(f, 'object');
    const member = getChildByField(f, 'member');
    const segs = obj?.type === 'call_expression' && member
      ? [...(typeExprSegments(obj, source) ?? []), getNodeText(member, source)]
      : chainSegments(f, source);
    if (!segs || segs.length < 2) return null;
    const ctor = segs[segs.length - 1]!;
    const typeSegs = segs.slice(0, -1);
    // Constructor convention: `Type.init(…)` / `Type.create(…)` returns a Type.
    if (/^(init|create|new|open|from)/.test(ctor) && /^[A-Z@]/.test(typeSegs[typeSegs.length - 1]!)) return typeSegs;
  }
  return null;
}

/**
 * Rewrite a callee path so its root names a type or binding the resolver can
 * look up: `Self` / a `@This()` alias → the container path; a local receiver
 * → its declared type. Returns null when the root is an external module (the
 * call goes into `std` and is dropped).
 */
function rewritePath(at: SyntaxNode, segs: string[], source: string): string[] | null {
  const head = segs[0]!;
  if (head.startsWith('@import(')) {
    return isZigExternalImport(head.slice('@import('.length, -1)) ? null : segs;
  }
  const binding = lookupBinding(at, head, source);
  if (binding?.kind === 'external') return null;
  if (binding?.kind === 'container') {
    const rest = segs.slice(1);
    return binding.path ? [...binding.path.split('.'), ...rest] : rest;
  }
  if (segs.length >= 2) {
    const t = receiverType(at, head, source);
    if (t && t.length > 0 && t[0] !== head) {
      const rewritten = rewritePath(at, t, source);
      if (rewritten === null) return null;
      return [...rewritten, ...segs.slice(1)];
    }
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Call-site references (called from TreeSitterExtractor.extractCall).
// ---------------------------------------------------------------------------

export function zigCallRefs(node: SyntaxNode, source: string): Array<{ name: string; kind: ReferenceKind }> {
  if (node.type === 'struct_initializer') {
    const t = node.namedChildren[0];
    const segs = t ? chainSegments(t, source) : null;
    if (!segs) return [];
    const path = rewritePath(node, segs, source);
    return path && path.length > 0 ? [{ name: path.join('.'), kind: 'instantiates' }] : [];
  }
  if (node.type !== 'call_expression') return [];
  const fn = getChildByField(node, 'function');
  if (!fn) return [];
  const segs = chainSegments(fn, source);
  if (!segs) return [];
  const path = rewritePath(node, segs, source);
  return path && path.length > 0 ? [{ name: path.join('.'), kind: 'calls' }] : [];
}

// ---------------------------------------------------------------------------
// Declarations (visitNode hook).
// ---------------------------------------------------------------------------

function signatureOf(node: SyntaxNode, source: string): string {
  const body = getChildByField(node, 'body');
  const end = body ? body.startIndex : node.endIndex;
  return collapseWs(source.substring(node.startIndex, end)).replace(/[;{]\s*$/, '').trim().slice(0, 300);
}

/**
 * `comptime T: type` parameter names of every function enclosing `node` — a
 * generic's type parameters are not types anyone declares.
 */
function enclosingComptimeParams(node: SyntaxNode, source: string): Set<string> {
  const out = new Set<string>();
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    if (n.type !== 'function_declaration') continue;
    const params = n.namedChildren.find((c) => c.type === 'parameters');
    for (const p of params?.namedChildren ?? []) {
      const pn = getChildByField(p, 'name');
      const pt = getChildByField(p, 'type');
      if (pn && pt && /^(type|anytype)$/.test(getNodeText(pt, source))) out.add(getNodeText(pn, source));
    }
  }
  return out;
}

/** Emit `references` for the user type names a type expression mentions. */
function typeRefs(
  typeNode: SyntaxNode | null,
  fromId: string,
  ctx: ExtractorContext,
  seen: Set<string> = new Set(),
): void {
  if (!typeNode) return;
  const comptimeParams = enclosingComptimeParams(typeNode, ctx.source);
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'identifier' || n.type === 'field_expression') {
      const segs = chainSegments(n, ctx.source);
      if (segs && /^[A-Z]/.test(segs[segs.length - 1]!) && !comptimeParams.has(segs[0]!)) {
        const path = rewritePath(n, segs, ctx.source);
        const name = path?.join('.');
        if (name && !seen.has(name)) {
          seen.add(name);
          ctx.addUnresolvedReference({
            fromNodeId: fromId,
            referenceName: name,
            referenceKind: 'references',
            line: n.startPosition.row + 1,
            column: n.startPosition.column,
          });
        }
      }
      return;
    }
    if (n.type === 'call_expression' || CONTAINER_TYPES.has(n.type) || n.type === 'block') return;
    for (const c of n.namedChildren) walk(c);
  };
  walk(typeNode);
}

function handleContainer(
  container: SyntaxNode,
  name: string,
  position: SyntaxNode,
  pub: boolean,
  ctx: ExtractorContext,
): void {
  const isEnum = container.type === 'enum_declaration' || container.type === 'error_set_declaration';
  const kind: NodeKind = isEnum ? 'enum' : container.type === 'union_declaration' ? 'union' : 'struct';
  const node = ctx.createNode(kind, name, position, {
    docstring: getPrecedingDocstring(position, ctx.source),
    signature: collapseWs(getNodeText(position, ctx.source).split('{')[0]!).slice(0, 200) || undefined,
    visibility: pub ? 'public' : 'private',
    isExported: pub,
  });
  if (!node) return;
  ctx.pushScope(node.id);
  for (const child of container.namedChildren) {
    if (container.type === 'error_set_declaration') {
      if (child.type === 'identifier') {
        ctx.createNode('enum_member', getNodeText(child, ctx.source), child, { visibility: 'public' });
      }
      continue;
    }
    if (child.type === 'container_field') {
      handleField(child, isEnum, node.id, ctx);
      continue;
    }
    ctx.visitNode(child);
  }
  ctx.popScope();
}

function handleField(field: SyntaxNode, isEnum: boolean, ownerId: string, ctx: ExtractorContext): void {
  const nameNode = getChildByField(field, 'name');
  // Empty containers (`struct {}`) recover with a zero-width MISSING name.
  const name = nameNode ? getNodeText(nameNode, ctx.source) : '';
  if (!name || name === '_' || nameNode?.isMissing) return;
  const typeNode = getChildByField(field, 'type');
  const member = ctx.createNode(isEnum ? 'enum_member' : 'field', name, field, {
    signature: collapseWs(getNodeText(field, ctx.source)).slice(0, 200),
    visibility: 'public',
  });
  if (!member) return;
  typeRefs(typeNode, member.id, ctx);
  // A field's default value / enum tag value can call functions.
  const value = field.namedChildren.filter((c) => c.type !== 'comment').at(-1);
  if (value && value !== typeNode && value.startIndex !== nameNode?.startIndex && value.startIndex !== typeNode?.startIndex) {
    ctx.visitFunctionBody(value, ownerId);
  }
}

function handleFunction(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const name = getNodeText(nameNode, ctx.source);
  const kind: NodeKind = enclosingContainer(node) ? 'method' : 'function';
  const pub = isPub(node);
  const fn = ctx.createNode(kind, name, node, {
    docstring: getPrecedingDocstring(node, ctx.source),
    signature: signatureOf(node, ctx.source),
    visibility: pub ? 'public' : 'private',
    isExported: pub,
    decorators: hasToken(node, 'extern') ? ['extern'] : hasToken(node, 'export') ? ['export'] : undefined,
  });
  if (!fn) return true;

  const params = node.namedChildren.find((c) => c.type === 'parameters');
  const seen = new Set<string>();
  for (const p of params?.namedChildren ?? []) typeRefs(getChildByField(p, 'type'), fn.id, ctx, seen);
  typeRefs(getChildByField(node, 'type'), fn.id, ctx, seen);

  const body = getChildByField(node, 'body');
  const generic = returnedContainer(body);
  ctx.pushScope(fn.id);
  if (body) {
    if (generic) {
      // Walk everything but the returned container, which is indexed below.
      const walk = (n: SyntaxNode): void => {
        if (n.startIndex === generic.startIndex && n.type === generic.type) return;
        if (generic.startIndex >= n.startIndex && generic.endIndex <= n.endIndex) {
          for (const c of n.namedChildren) walk(c);
        } else {
          ctx.visitFunctionBody(n, fn.id);
        }
      };
      walk(body);
    } else {
      ctx.visitFunctionBody(body, fn.id);
    }
  }
  ctx.popScope();
  // The returned container is the type callers use — `List(u8)` — so index
  // it beside the function, under the same name.
  if (generic) handleContainer(generic, name, generic, pub, ctx);
  return true;
}

function handleVariable(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (!isDeclaration(node)) return false; // `x = y;` — just walk it for calls
  const name = declName(node, ctx.source);
  if (!name || name === '_') return false;
  const value = declValue(node);
  const pub = isPub(node);

  const imp = rootImportPath(value, ctx.source);
  if (imp !== null) {
    if (!imp || isZigExternalImport(imp)) return true; // std / builtin / build modules
    const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
    ctx.createNode('import', imp, node, { signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 200) });
    if (parentId) {
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: imp,
        referenceKind: 'imports',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return true;
  }
  if (isThisBuiltin(value, ctx.source)) return true; // `const Self = @This();`

  const container = containerOf(value);
  if (container) {
    handleContainer(container, name, node, pub, ctx);
    return true;
  }

  // A private alias of an imported/external member (`const Allocator =
  // std.mem.Allocator;`) is a binding, not a symbol: the resolver follows it
  // through the file's import bindings. A `pub` one is part of the file's API
  // (`pub const locToSlice = offsets.locToSlice;`) and stays a constant — the
  // resolver chases it when the target is in the repo.
  if (!pub && value && (value.type === 'field_expression' || value.type === 'identifier')) {
    const rootName = chainRoot(value, ctx.source);
    if (rootName && rootName !== name && (lookupBinding(node, rootName, ctx.source) || isImportBound(node, rootName, ctx.source))) {
      return true;
    }
  }
  // Likewise a private handle built by a std call (`const log =
  // std.log.scoped(.x);`) — a library value, not a project symbol.
  if (!pub && value?.type === 'call_expression') {
    const fn = getChildByField(value, 'function');
    const rootName = fn ? chainRoot(fn, ctx.source) : null;
    if (rootName && rootName !== name && lookupBinding(node, rootName, ctx.source)?.kind === 'external') return true;
  }

  const isConst = hasToken(node, 'const');
  const v = ctx.createNode(isConst ? 'constant' : 'variable', name, node, {
    docstring: getPrecedingDocstring(node, ctx.source),
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 200),
    visibility: pub ? 'public' : 'private',
    isExported: pub,
  });
  if (v) {
    typeRefs(getChildByField(node, 'type'), v.id, ctx);
    if (value) {
      ctx.pushScope(v.id);
      ctx.visitFunctionBody(value, v.id);
      ctx.popScope();
    }
  }
  return true;
}

/** Whether `name` is bound by a file/container-level `const name = @import("x.zig")` (or an alias of one). */
function isImportBound(at: SyntaxNode, name: string, source: string, depth = 0): boolean {
  if (depth > 4) return false;
  let scope: SyntaxNode | null = enclosingContainer(at);
  for (;;) {
    const host: SyntaxNode = scope ?? root(at);
    for (const decl of scopeDecls(host)) {
      if (declName(decl, source) !== name) continue;
      const value = declValue(decl);
      if (rootImportPath(value, source) !== null) return true;
      const r = value ? chainRoot(value, source) : null;
      return !!r && r !== name && isImportBound(decl, r, source, depth + 1);
    }
    if (!scope) return false;
    scope = enclosingContainer(scope);
  }
}

function handleTest(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const str = node.namedChildren.find((c) => c.type === 'string');
  const ident = node.namedChildren.find((c) => c.type === 'identifier');
  const label = str
    ? getNodeText(str.namedChildren.find((c) => c.type === 'string_content') ?? str, ctx.source)
    : ident
      ? getNodeText(ident, ctx.source)
      : '';
  const block = node.namedChildren.find((c) => c.type === 'block');
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!label) {
    // `test { … }` — calls attribute to the enclosing scope.
    if (block && parentId) ctx.visitFunctionBody(block, parentId);
    return true;
  }
  const t = ctx.createNode('function', `test "${label}"`, node, {
    signature: `test "${label}"`,
    decorators: ['test'],
    visibility: 'private',
  });
  if (t && block) {
    ctx.pushScope(t.id);
    ctx.visitFunctionBody(block, t.id);
    ctx.popScope();
  }
  return true;
}

export const zigExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['call_expression', 'struct_initializer'],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  callRefs: zigCallRefs,

  visitNode: (node, ctx) => {
    switch (node.type) {
      case 'function_declaration':
        return handleFunction(node, ctx);
      case 'variable_declaration':
        return handleVariable(node, ctx);
      case 'test_declaration':
        return handleTest(node, ctx);
      case 'container_field':
        // A file is a struct: top-level fields belong to the file's type.
        if (node.parent?.type === 'source_file') {
          const parentId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? '';
          handleField(node, false, parentId, ctx);
          return true;
        }
        return false;
      case 'using_namespace_declaration':
        return true;
      default:
        return false;
    }
  },
};
