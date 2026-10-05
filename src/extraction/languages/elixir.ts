import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import type { ReferenceKind } from '../../types';

// Node names follow the vendored elixir-lang/tree-sitter-elixir grammar
// (0.3.5, ABI 14). Elixir has no declaration keywords — `defmodule`, `def`,
// `defp`, `alias`, `@spec`, … are all MACROS, so every one of them parses as a
// `call` node (module attributes as an `@` `unary_operator`). Nothing fits the
// generic functionTypes/classTypes dispatch, so declarations are driven from
// the visitNode hook below, keyed off each call's target identifier:
//
//   defmodule Foo.Bar do … end     call(target: identifier "defmodule",
//                                       arguments → alias "Foo.Bar", do_block)
//   def name(args) when g do … end call(target: "def", arguments →
//                                       binary_operator "when" {left: head call})
//   def name(args), do: expr       no do_block; arguments → keywords → pair "do:"
//   @spec / @doc / @behaviour      unary_operator "@" {operand: call}
//   Mod.Sub.fun(x)                 call(target: dot{left: alias, right: identifier})
//
// Modules become `module` nodes named by their FULL dotted name (nested
// `defmodule Inner` inside `Outer` is `Outer.Inner`, as Elixir names it), and
// a module's functions are qualified `Full.Module::fun`. Remote calls are
// emitted (see elixirCallRefs, called from the core extractCall) as
// `Full.Module::fun` with the call site's `alias` declarations expanded, so
// they match that qualifiedName exactly; the Elixir rulebook in
// src/resolution/elixir.ts resolves them without any name guessing.
//
// Carries the design of @w0lan's Elixir PR (#1264).

const PUBLIC_DEFS = new Set(['def', 'defmacro', 'defguard', 'defdelegate']);
const PRIVATE_DEFS = new Set(['defp', 'defmacrop', 'defguardp']);
const DEF_MACROS = new Set([...PUBLIC_DEFS, ...PRIVATE_DEFS]);
const MODULE_MACROS = new Set(['defmodule', 'defprotocol', 'defimpl']);

/**
 * Declaration macros consumed by the visitNode hook; a call with one of these
 * targets never becomes a `calls` ref (defensive — the hook normally eats them
 * before the walker reaches them).
 */
const DECL_MACROS = new Set([
  ...DEF_MACROS, ...MODULE_MACROS,
  'defstruct', 'defexception', 'defoverridable', 'defrecord', 'defrecordp',
  'use', 'import', 'require', 'alias',
]);

/**
 * Kernel special forms / control-flow macros that parse as a bare `call` but
 * are never a user function. Emitting refs for them is pure noise.
 */
const SPECIAL_FORMS = new Set([
  'quote', 'unquote', 'unquote_splicing', 'super', 'receive', 'if', 'unless',
  'case', 'cond', 'with', 'for', 'raise', 'reraise', 'try', 'send', 'spawn',
  'spawn_link', 'self', 'throw', 'exit', 'fn', 'import', 'is_nil', 'is_atom',
  'is_binary', 'is_integer', 'is_list', 'is_map', 'is_tuple', 'is_function',
  'is_number', 'is_boolean', 'is_pid', 'is_struct', 'to_string', 'inspect',
  'elem', 'put_elem', 'length', 'hd', 'tl', 'map_size', 'byte_size',
  'tuple_size', 'apply', 'match?', 'binding', 'sigil_r', 'sigil_s', 'sigil_w',
]);

/**
 * Reserved/compiler module attributes whose VALUES are type positions, docs or
 * compiler metadata — not runtime code. Their subtree is consumed (a type like
 * `String.t()` in `@spec` parses as a call and would otherwise mint a bogus
 * `calls` ref). Any OTHER attribute is a custom attribute whose value is real
 * compile-time code, so it is walked for calls.
 */
const META_ATTRIBUTES = new Set([
  'spec', 'doc', 'moduledoc', 'typedoc', 'shortdoc', 'behaviour', 'behavior',
  'type', 'typep', 'opaque', 'callback', 'macrocallback', 'optional_callbacks',
  'impl', 'derive', 'enforce_keys', 'deprecated', 'dialyzer',
  'external_resource', 'compile', 'before_compile', 'after_compile',
  'after_verify', 'on_definition', 'on_load', 'nifs', 'vsn', 'file',
]);

function collapseWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `do:` → `do` (the keyword token can carry trailing space). */
function keywordKey(node: SyntaxNode, source: string): string {
  return getNodeText(node, source).trim().replace(/:$/, '');
}

/** `arguments` is a child node TYPE in tree-sitter-elixir, not a field. */
function argsOf(node: SyntaxNode): SyntaxNode | null {
  for (const child of node.namedChildren) if (child.type === 'arguments') return child;
  return null;
}

function doBlockOf(node: SyntaxNode): SyntaxNode | null {
  for (const child of node.namedChildren) if (child.type === 'do_block') return child;
  return null;
}

function firstAlias(node: SyntaxNode | null): SyntaxNode | null {
  if (!node) return null;
  for (const child of node.namedChildren) if (child.type === 'alias') return child;
  return null;
}

/** Look up a keyword value (`for:` / `as:` / `do:`) inside an arguments node. */
function keywordValue(argsNode: SyntaxNode | null, key: string, source: string): SyntaxNode | null {
  if (!argsNode) return null;
  for (const child of argsNode.namedChildren) {
    if (child.type !== 'keywords') continue;
    for (const pair of child.namedChildren) {
      if (pair.type !== 'pair') continue;
      const k = getChildByField(pair, 'key');
      if (k && keywordKey(k, source) === key) return getChildByField(pair, 'value');
    }
  }
  return null;
}

/** The identifier target of a call (`def`, `alias`, a local fn name), or ''. */
function callTargetName(node: SyntaxNode, source: string): string {
  if (node.type !== 'call') return '';
  const t = getChildByField(node, 'target');
  return t?.type === 'identifier' ? getNodeText(t, source) : '';
}

// ---------------------------------------------------------------------------
// Module naming + alias expansion. Shared by the declaration hook (module and
// impl names, implements/imports refs) and by elixirCallRefs (remote calls).
// ---------------------------------------------------------------------------

/** Local (as-written) name of a module-defining call, or null when dynamic. */
function moduleLocalName(node: SyntaxNode, source: string): string | null {
  const macro = callTargetName(node, source);
  const args = argsOf(node);
  if (macro === 'defimpl') {
    const proto = firstAlias(args);
    if (!proto) return null;
    const forValue = keywordValue(args, 'for', source);
    const forType = forValue?.type === 'alias' ? getNodeText(forValue, source) : '';
    return forType ? `${getNodeText(proto, source)}.${forType}` : getNodeText(proto, source);
  }
  const alias = firstAlias(args);
  return alias ? getNodeText(alias, source) : null;
}

/** Nearest enclosing module-defining call of `node` (exclusive). */
function enclosingModuleCall(node: SyntaxNode, source: string): SyntaxNode | null {
  let n: SyntaxNode | null = node.parent;
  while (n) {
    if (n.type === 'call' && MODULE_MACROS.has(callTargetName(n, source))) return n;
    n = n.parent;
  }
  return null;
}

/**
 * Full dotted name of a module-defining call: its local name prefixed by every
 * enclosing module's (`defmodule Outer do defmodule Inner` → `Outer.Inner`).
 * A `defimpl` inside a module is NOT prefixed when its protocol name is already
 * qualified — Elixir names an impl `Proto.Type` relative to nothing — but the
 * common nested form `defimpl Proto, for: __MODULE__` is handled by `for:`
 * resolving to the enclosing module.
 */
function moduleFullName(moduleCall: SyntaxNode, source: string): string | null {
  const local = moduleLocalName(moduleCall, source);
  if (!local) return null;
  const macro = callTargetName(moduleCall, source);
  if (macro === 'defimpl') {
    const args = argsOf(moduleCall);
    const proto = firstAlias(args);
    const forValue = keywordValue(args, 'for', source);
    const outer = enclosingModuleCall(moduleCall, source);
    const outerName = outer ? moduleFullName(outer, source) : null;
    const protoName = proto ? expandAlias(moduleCall, getNodeText(proto, source), source) : '';
    let forName = '';
    if (forValue?.type === 'alias') forName = expandAlias(moduleCall, getNodeText(forValue, source), source);
    else if (forValue?.type === 'identifier' && getNodeText(forValue, source) === '__MODULE__') forName = outerName ?? '';
    if (!protoName) return null;
    return forName ? `${protoName}.${forName}` : protoName;
  }
  const outer = enclosingModuleCall(moduleCall, source);
  const outerName = outer ? moduleFullName(outer, source) : null;
  return outerName ? `${outerName}.${local}` : local;
}

/** Per-source memo of module alias tables, keyed by module call start index. */
let aliasMemoSource: string | null = null;
const aliasMemo = new Map<number, Map<string, string>>();

/**
 * The alias table visible inside a module: `alias A.B` (→ `B`), `alias A.B,
 * as: C`, `alias A.{B, C}`, plus Elixir's implicit alias of every nested
 * `defmodule` (inside `Outer`, `defmodule Inner` is reachable as `Inner`).
 * Enclosing modules' tables are inherited (lexical scope). Aliases written
 * inside function bodies count module-wide — near-always right in practice.
 */
function aliasTable(moduleCall: SyntaxNode | null, source: string): Map<string, string> {
  if (aliasMemoSource !== source) {
    aliasMemoSource = source;
    aliasMemo.clear();
  }
  const key = moduleCall ? moduleCall.startIndex : -1;
  const hit = aliasMemo.get(key);
  if (hit) return hit;
  const outer = moduleCall ? enclosingModuleCall(moduleCall, source) : null;
  const table = new Map<string, string>(moduleCall ? aliasTable(outer, source) : []);
  aliasMemo.set(key, table);
  if (!moduleCall) return table;
  const selfName = moduleFullName(moduleCall, source);
  const doBlock = doBlockOf(moduleCall);
  if (!doBlock) return table;

  // Applied as encountered: a later `alias Bar.Baz` sees an earlier
  // `alias Foo.Bar`, as in Elixir's lexical order.
  const addAlias = (stmt: SyntaxNode): void => {
    const args = argsOf(stmt);
    if (!args) return;
    const asValue = keywordValue(args, 'as', source);
    for (const child of args.namedChildren) {
      if (child.type === 'alias') {
        const written = getNodeText(child, source);
        const full = resolveWith(table, written);
        const local = asValue?.type === 'alias' ? getNodeText(asValue, source) : written.split('.').pop()!;
        table.set(local, full);
      } else if (child.type === 'dot') {
        // alias Foo.{Alpha, Beta}
        const left = getChildByField(child, 'left');
        const right = getChildByField(child, 'right');
        if (left?.type !== 'alias' || right?.type !== 'tuple') continue;
        const prefix = resolveWith(table, getNodeText(left, source));
        for (const member of right.namedChildren) {
          if (member.type !== 'alias') continue;
          const seg = getNodeText(member, source);
          table.set(seg.split('.').pop()!, `${prefix}.${seg}`);
        }
      } else if (child.type === 'identifier' && getNodeText(child, source) === '__MODULE__' && selfName) {
        // alias __MODULE__ → the module's last segment
        table.set(selfName.split('.').pop()!, selfName);
      }
    }
  };
  const collect = (n: SyntaxNode): void => {
    for (const child of n.namedChildren) {
      if (child.type === 'call') {
        const tn = callTargetName(child, source);
        if (tn === 'alias') {
          addAlias(child);
          continue;
        }
        if (tn === 'defmodule' || tn === 'defprotocol') {
          // Implicit alias of a nested module: its first written segment.
          const written = moduleLocalName(child, source);
          if (written && selfName) {
            const head = written.split('.')[0]!;
            table.set(head, `${selfName}.${head}`);
          }
          continue; // the nested module's own aliases are its own scope
        }
        if (tn === 'defimpl') continue;
      }
      collect(child);
    }
  };
  collect(doBlock);
  return table;
}

function resolveWith(table: Map<string, string>, written: string): string {
  const segments = written.split('.');
  const mapped = table.get(segments[0]!);
  if (!mapped) return written;
  return segments.length > 1 ? `${mapped}.${segments.slice(1).join('.')}` : mapped;
}

/**
 * Expand a written module reference (`Repo`, `Accounts.User`) to its full
 * dotted name using the alias declarations in scope at `node`. Only the FIRST
 * segment is an alias key; a head that isn't aliased is already absolute.
 * `__MODULE__` (and `__MODULE__.Sub`) expands to the enclosing module.
 */
export function expandAlias(node: SyntaxNode, written: string, source: string): string {
  const moduleCall = enclosingModuleCall(node, source);
  if (written === '__MODULE__' || written.startsWith('__MODULE__.')) {
    const self = moduleCall ? moduleFullName(moduleCall, source) : null;
    if (!self) return written;
    return written === '__MODULE__' ? self : `${self}${written.slice('__MODULE__'.length)}`;
  }
  return resolveWith(aliasTable(moduleCall, source), written);
}

// ---------------------------------------------------------------------------
// Call-site references (called from TreeSitterExtractor.extractCall).
// ---------------------------------------------------------------------------

export interface ElixirRef {
  name: string;
  kind: ReferenceKind;
}

/**
 * The references a call-site node makes:
 *   - remote `Mod.fun(x)`  → `calls Full.Mod::fun` (aliases expanded)
 *   - `__MODULE__.fun(x)`  → `calls Self.Mod::fun`
 *   - local `fun(x)`       → `calls fun` (resolved in the caller's module, then
 *                            through its `import`s)
 *   - `&Mod.fun/2`, `&fun/1` captures → `references` to the function
 *   - `%Mod{…}` struct literal       → `references` to the module
 * A variable receiver (`mod.fun()`, `conn.assigns`) has no static target and
 * yields nothing — a silent miss, never a wrong edge.
 */
export function elixirCallRefs(node: SyntaxNode, source: string): ElixirRef[] {
  if (node.type === 'call') {
    // The function part of a `&Mod.fun/arity` capture is a `references`,
    // emitted from the unary_operator branch — not a call.
    const cap = node.parent;
    if (
      cap?.type === 'binary_operator' &&
      cap.parent?.type === 'unary_operator' &&
      getNodeText(cap.parent, source).startsWith('&')
    ) {
      return [];
    }
    const target = getChildByField(node, 'target');
    if (!target) return [];
    if (target.type === 'dot') {
      const qualified = dotTargetName(node, target, source);
      return qualified ? [{ name: qualified, kind: 'calls' }] : [];
    }
    if (target.type === 'identifier') {
      const name = getNodeText(target, source);
      if (DECL_MACROS.has(name) || SPECIAL_FORMS.has(name)) return [];
      return [{ name, kind: 'calls' }];
    }
    return [];
  }
  if (node.type === 'unary_operator') {
    if (!getNodeText(node, source).startsWith('&')) return [];
    const operand = getChildByField(node, 'operand');
    if (operand?.type !== 'binary_operator') return []; // `&1` arg capture
    const capLeft = getChildByField(operand, 'left');
    if (capLeft?.type === 'call') {
      const t = getChildByField(capLeft, 'target');
      if (t?.type === 'dot') {
        const qualified = dotTargetName(capLeft, t, source);
        return qualified ? [{ name: qualified, kind: 'references' }] : [];
      }
    } else if (capLeft?.type === 'identifier') {
      return [{ name: getNodeText(capLeft, source), kind: 'references' }];
    }
    return [];
  }
  if (node.type === 'map') {
    const struct = node.namedChildren.find((c) => c.type === 'struct');
    const ref = struct?.namedChildren.find(
      (c) => c.type === 'alias' || (c.type === 'identifier' && getNodeText(c, source) === '__MODULE__'),
    );
    if (!ref) return [];
    const full = expandAlias(node, getNodeText(ref, source), source);
    return full.startsWith('__MODULE__') ? [] : [{ name: full, kind: 'references' }];
  }
  return [];
}

/** `Mod.fun` / `__MODULE__.fun` call target → `Full.Mod::fun`, else null. */
function dotTargetName(call: SyntaxNode, dot: SyntaxNode, source: string): string | null {
  const left = getChildByField(dot, 'left');
  const right = getChildByField(dot, 'right');
  if (right?.type !== 'identifier' || !left) return null;
  const fn = getNodeText(right, source);
  let written: string | null = null;
  if (left.type === 'alias') written = getNodeText(left, source);
  else if (left.type === 'identifier' && getNodeText(left, source) === '__MODULE__') written = '__MODULE__';
  if (!written) return null;
  const full = expandAlias(call, written, source);
  if (full.startsWith('__MODULE__')) return null; // top-level __MODULE__: no module
  return `${full}::${fn}`;
}

// ---------------------------------------------------------------------------
// Declarations (visitNode hook).
// ---------------------------------------------------------------------------

/**
 * Clause-merge state. Elixir emits one `def` call PER CLAUSE, so consecutive
 * same-name definitions in the same module merge into one function node (span
 * extended, extra clause bodies attributed to it). Validated against the live
 * node list, so a re-extraction of the same file never merges into a node from
 * a previous pass.
 */
let lastFnModuleId = '';
let lastFnName = '';
let lastFnId = '';

function defHeadName(node: SyntaxNode, source: string): { name: string; head: SyntaxNode | null } | null {
  const first = argsOf(node)?.namedChildren[0] ?? null;
  if (!first) return null;
  let headish: SyntaxNode | null = first;
  if (first.type === 'binary_operator') headish = getChildByField(first, 'left'); // `head when guard`
  if (!headish) return null;
  if (headish.type === 'call') {
    const t = getChildByField(headish, 'target');
    return t?.type === 'identifier' ? { name: getNodeText(t, source), head: headish } : null;
  }
  if (headish.type === 'identifier') return { name: getNodeText(headish, source), head: null }; // `def hello, do: …`
  return null;
}

/** The `@spec` / `@doc` attributes directly above a def (comments skipped). */
function precedingAttrs(node: SyntaxNode, source: string): { signature?: string; docstring?: string } {
  const out: { signature?: string; docstring?: string } = {};
  let prev = node.previousNamedSibling;
  while (prev) {
    if (prev.type === 'comment') {
      prev = prev.previousNamedSibling;
      continue;
    }
    if (prev.type !== 'unary_operator') break;
    const call = attributeCall(prev);
    const name = call ? callTargetName(call, source) : '';
    if (name === 'spec' && out.signature === undefined) {
      out.signature = collapseWs(getNodeText(prev, source)).slice(0, 300);
    } else if (name === 'doc' && out.docstring === undefined) {
      out.docstring = call ? docContent(call, source) : undefined;
    } else if (name !== 'impl') {
      break;
    }
    prev = prev.previousNamedSibling;
  }
  return out;
}

function attributeCall(unary: SyntaxNode): SyntaxNode | null {
  const operand = getChildByField(unary, 'operand');
  return operand?.type === 'call' ? operand : null;
}

function docContent(call: SyntaxNode, source: string): string | undefined {
  const str = argsOf(call)?.namedChildren.find((c) => c.type === 'string');
  if (!str) return undefined;
  const content = str.namedChildren.find((c) => c.type === 'quoted_content');
  return collapseWs(content ? getNodeText(content, source) : getNodeText(str, source)) || undefined;
}

function moduledocOf(doBlock: SyntaxNode | null, source: string): string | undefined {
  if (!doBlock) return undefined;
  for (const child of doBlock.namedChildren) {
    if (child.type !== 'unary_operator') continue;
    const call = attributeCall(child);
    if (call && callTargetName(call, source) === 'moduledoc') return docContent(call, source);
  }
  return undefined;
}

/** Visit a module body: the `do_block`, or the `do:` keyword value. */
function visitModuleBody(node: SyntaxNode, ctx: ExtractorContext): void {
  const doBlock = doBlockOf(node);
  if (doBlock) {
    for (const child of doBlock.namedChildren) ctx.visitNode(child);
    return;
  }
  const doValue = keywordValue(argsOf(node), 'do', ctx.source);
  if (!doValue) return;
  if (doValue.type === 'block') for (const child of doValue.namedChildren) ctx.visitNode(child);
  else ctx.visitNode(doValue);
}

function addRef(ctx: ExtractorContext, fromNodeId: string, name: string, kind: ReferenceKind, at: SyntaxNode): void {
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: kind,
    line: at.startPosition.row + 1,
    column: at.startPosition.column,
  });
}

function handleModule(node: SyntaxNode, ctx: ExtractorContext, macro: string): boolean {
  const fullName = moduleFullName(node, ctx.source);
  if (!fullName) {
    // Dynamic module name (`defmodule unquote(name) do`): index the body's
    // definitions anyway, with no fabricated module around them.
    visitModuleBody(node, ctx);
    return true;
  }
  const kind = macro === 'defprotocol' ? 'protocol' : 'module';
  const mod = ctx.createNode(kind, fullName, node, {
    qualifiedName: fullName,
    docstring: moduledocOf(doBlockOf(node), ctx.source),
    signature: collapseWs(`${macro} ${moduleLocalName(node, ctx.source) ?? fullName}`),
    isExported: true,
    visibility: 'public',
  });
  if (!mod) return true;
  if (macro === 'defimpl') {
    // `defimpl Proto, for: Type` implements the protocol.
    const proto = firstAlias(argsOf(node));
    if (proto) addRef(ctx, mod.id, expandAlias(node, getNodeText(proto, ctx.source), ctx.source), 'implements', node);
  }
  ctx.pushScope(mod.id);
  visitModuleBody(node, ctx);
  ctx.popScope();
  return true;
}

function handleDef(node: SyntaxNode, ctx: ExtractorContext, macro: string): boolean {
  const named = defHeadName(node, ctx.source);
  if (!named) return true;
  const { name, head } = named;
  const moduleId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? '';
  const moduleNode = ctx.nodes.find((n) => n.id === moduleId);
  const modName = moduleNode && (moduleNode.kind === 'module' || moduleNode.kind === 'protocol') ? moduleNode.qualifiedName : '';

  // Continuation clause of the same function in the same module — merge.
  if (moduleId === lastFnModuleId && name === lastFnName && lastFnId) {
    const existing = ctx.nodes.find((n) => n.id === lastFnId);
    if (existing && existing.startLine <= node.startPosition.row + 1) {
      if (node.endPosition.row + 1 > existing.endLine) existing.endLine = node.endPosition.row + 1;
      ctx.pushScope(existing.id);
      visitDefBodies(node, existing.id, ctx);
      ctx.popScope();
      return true;
    }
  }

  const attrs = precedingAttrs(node, ctx.source);
  const headText = head ? collapseWs(getNodeText(head, ctx.source)) : name;
  const fn = ctx.createNode('function', name, node, {
    qualifiedName: modName ? `${modName}::${name}` : name,
    signature: (attrs.signature ?? `${macro} ${headText}`).slice(0, 300),
    docstring: attrs.docstring,
    isExported: PUBLIC_DEFS.has(macro),
    visibility: PRIVATE_DEFS.has(macro) ? 'private' : 'public',
    decorators: macro === 'def' || macro === 'defp' ? undefined : [macro],
  });
  if (!fn) return true;
  ctx.pushScope(fn.id);
  visitDefBodies(node, fn.id, ctx);
  ctx.popScope();
  lastFnModuleId = moduleId;
  lastFnName = name;
  lastFnId = fn.id;
  return true;
}

/**
 * Walk a def's guard and body for calls WITHOUT walking its head (which would
 * mint a self-call to the function's own name). `defdelegate f(x), to: Mod`
 * becomes a `calls Mod::f` (or the `as:` name) — the delegation IS the body.
 */
function visitDefBodies(node: SyntaxNode, fnId: string, ctx: ExtractorContext): void {
  const args = argsOf(node);
  const first = args?.namedChildren[0] ?? null;
  if (first?.type === 'binary_operator') {
    const right = getChildByField(first, 'right');
    if (right) ctx.visitFunctionBody(right, fnId);
  }
  if (callTargetName(node, ctx.source) === 'defdelegate') {
    const to = keywordValue(args, 'to', ctx.source);
    const as = keywordValue(args, 'as', ctx.source);
    const named = defHeadName(node, ctx.source);
    if (to?.type === 'alias' && named) {
      const target = as?.type === 'atom' ? getNodeText(as, ctx.source).replace(/^:/, '') : named.name;
      addRef(ctx, fnId, `${expandAlias(node, getNodeText(to, ctx.source), ctx.source)}::${target}`, 'calls', to);
    }
    return;
  }
  const doBlock = doBlockOf(node);
  if (doBlock) ctx.visitFunctionBody(doBlock, fnId);
  const doValue = keywordValue(args, 'do', ctx.source);
  if (doValue) ctx.visitFunctionBody(doValue, fnId);
}

function handleDefstruct(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = argsOf(node);
  if (!args) return true;
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  const parent = ctx.nodes.find((n) => n.id === parentId);
  const modName = parent?.kind === 'module' ? parent.qualifiedName : '';
  const addField = (fieldName: string, at: SyntaxNode): void => {
    if (!fieldName) return;
    ctx.createNode('field', fieldName, at, { qualifiedName: modName ? `${modName}::${fieldName}` : fieldName });
  };
  const visitPairs = (keywords: SyntaxNode): void => {
    for (const pair of keywords.namedChildren) {
      if (pair.type !== 'pair') continue;
      const key = getChildByField(pair, 'key');
      if (key) addField(keywordKey(key, ctx.source), pair);
      // Default values are real compile-time code (`ts: DateTime.utc_now()`).
      const value = getChildByField(pair, 'value');
      if (value) ctx.visitNode(value);
    }
  };
  for (const child of args.namedChildren) {
    if (child.type === 'keywords') visitPairs(child);
    else if (child.type === 'list') {
      for (const item of child.namedChildren) {
        if (item.type === 'atom') addField(getNodeText(item, ctx.source).replace(/^:/, ''), item);
        else if (item.type === 'keywords') visitPairs(item);
      }
    }
  }
  return true;
}

/** `use` → implements; `import` / `require` / `alias` → imports. */
function handleDirective(node: SyntaxNode, ctx: ExtractorContext, macro: string): boolean {
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!parentId) return true;
  const args = argsOf(node);
  if (!args) return true;
  const kind: ReferenceKind = macro === 'use' ? 'implements' : 'imports';
  const emit = (full: string): void => {
    if (full && !full.startsWith('__MODULE__')) addRef(ctx, parentId, full, kind, node);
  };
  for (const child of args.namedChildren) {
    if (child.type === 'alias') {
      emit(expandAlias(node, getNodeText(child, ctx.source), ctx.source));
    } else if (child.type === 'dot' && macro !== 'use') {
      const left = getChildByField(child, 'left');
      const right = getChildByField(child, 'right');
      if (left?.type !== 'alias' || right?.type !== 'tuple') continue;
      const prefix = expandAlias(node, getNodeText(left, ctx.source), ctx.source);
      for (const member of right.namedChildren) {
        if (member.type === 'alias') emit(`${prefix}.${getNodeText(member, ctx.source)}`);
      }
    }
    if (macro === 'use') break; // `use Mod, opts` — only the module
  }
  return true;
}

function handleAttribute(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const call = attributeCall(node);
  if (!call) return true;
  const name = callTargetName(call, ctx.source);
  if (name === 'behaviour' || name === 'behavior') {
    const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
    const alias = firstAlias(argsOf(call));
    if (parentId && alias) addRef(ctx, parentId, expandAlias(node, getNodeText(alias, ctx.source), ctx.source), 'implements', node);
    return true;
  }
  if (META_ATTRIBUTES.has(name)) return true;
  // Custom attribute: walk the VALUE (never the attribute name itself).
  const args = argsOf(call);
  if (args) for (const child of args.namedChildren) ctx.visitNode(child);
  return true;
}

/**
 * ExUnit `test "name" do … end` (optionally with a context pattern) → a
 * function named `test "name"`, so a test's calls attribute to the test rather
 * than to the whole test module. Returns false for any other `test(...)` call.
 */
function handleExUnitTest(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const doBlock = doBlockOf(node);
  const label = argsOf(node)?.namedChildren[0];
  if (!doBlock || label?.type !== 'string') return false;
  const content = label.namedChildren.find((c) => c.type === 'quoted_content');
  const text = collapseWs(content ? getNodeText(content, ctx.source) : '');
  if (!text) return false;
  const t = ctx.createNode('function', `test "${text}"`, node, {
    signature: `test "${text}"`,
    decorators: ['test'],
    visibility: 'private',
  });
  if (!t) return false;
  ctx.pushScope(t.id);
  visitKeepingModules(doBlock, t.id, ctx);
  ctx.popScope();
  return true;
}

/**
 * Walk a body for calls, but hand any `defmodule`/`defprotocol`/`defimpl`
 * inside it to the declaration hook — tests routinely define fixture modules
 * inline, and the plain body walker would flatten them into calls.
 */
function visitKeepingModules(body: SyntaxNode, fnId: string, ctx: ExtractorContext): void {
  const hasModuleCall = (n: SyntaxNode): boolean =>
    (n.type === 'call' && MODULE_MACROS.has(callTargetName(n, ctx.source))) || n.namedChildren.some(hasModuleCall);
  if (!/\bdef(module|protocol|impl)\b/.test(getNodeText(body, ctx.source)) || !hasModuleCall(body)) {
    ctx.visitFunctionBody(body, fnId);
    return;
  }
  for (const child of body.namedChildren) {
    if (child.type === 'call' && MODULE_MACROS.has(callTargetName(child, ctx.source))) ctx.visitNode(child);
    else visitKeepingModules(child, fnId, ctx);
  }
}

export const elixirExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  // Real call sites (remote/local calls, `&` captures, `%Struct{}` literals)
  // go to elixirCallRefs via the core extractCall; declaration macros are
  // intercepted by visitNode below before they reach it.
  callTypes: ['call', 'unary_operator', 'map'],
  variableTypes: [],
  nameField: 'target',
  bodyField: 'do_block',
  paramsField: 'arguments',
  callRefs: elixirCallRefs,

  visitNode: (node, ctx) => {
    if (node.type === 'unary_operator') {
      if (getNodeText(node, ctx.source).startsWith('@')) return handleAttribute(node, ctx);
      return false;
    }
    if (node.type !== 'call') return false;
    const macro = callTargetName(node, ctx.source);
    if (!macro) return false; // remote call (dot target) → extractCall
    if (MODULE_MACROS.has(macro)) return handleModule(node, ctx, macro);
    if (DEF_MACROS.has(macro)) return handleDef(node, ctx, macro);
    if (macro === 'defstruct' || macro === 'defexception') return handleDefstruct(node, ctx);
    if (macro === 'use' || macro === 'import' || macro === 'require' || macro === 'alias') {
      return handleDirective(node, ctx, macro);
    }
    if (macro === 'test' && handleExUnitTest(node, ctx)) return true;
    return false; // ordinary local call → extractCall
  },
};
