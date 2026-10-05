/**
 * C++ operator overloads used infix (#1258).
 *
 * `a + b` and `a[i]` call `V::operator+` / `V::operator[]` when `a` is a `V`,
 * but the tree has no call there — a `binary_expression` / `subscript_expression`
 * — so the operator method had no callers. (The explicit `a.operator+(b)` form
 * is an ordinary member call, resolved by the name matcher — #1247.)
 *
 * This pass links an infix / subscript use to the operator ONLY when the left
 * operand's declared type is known and declares it:
 *
 * - the left operand is a plain name (`a`, not `a.b` / `f()` / `*p`);
 * - its declaration — the nearest one above the use in the same function (a
 *   parameter or local), else a field of the method's own class — names a
 *   project class by value or reference (`V a`, `const V& a`), not a pointer
 *   (`V* p; p + 1` is pointer arithmetic) nor an array (`V a[3]; a[i]`), and
 *   not `auto`;
 * - that class, or a base it inherits (through the resolved `extends` edges),
 *   declares a member `operator<op>` taking one argument (`operator-()` with
 *   none is unary minus, not `a - b`).
 *
 * Anything else adds nothing — a missed edge, never a wrong one. Non-member
 * operator functions (`V operator+(const V&, const V&)`) are not linked.
 */

import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import { makeLineAt } from './synth-utils';

/** Infix operators a member overload can take one argument for, longest first (so `<<=` wins over `<<` over `<`). */
const BINARY_OPS = [
  '<<=', '>>=', '<=>',
  '==', '!=', '<=', '>=', '<<', '>>', '&&', '||', '+=', '-=', '*=', '/=', '%=', '^=', '&=', '|=',
  '+', '-', '*', '/', '%', '^', '&', '|', '<', '>',
];
const OP_CHARS = /[=+\-*/%^&|<>!]/;

const CPP_KEYWORDS: ReadonlySet<string> = new Set([
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'goto',
  'throw', 'new', 'delete', 'co_await', 'co_yield', 'co_return', 'sizeof', 'alignof', 'typeid', 'decltype',
  'static_cast', 'const_cast', 'dynamic_cast', 'reinterpret_cast', 'and', 'or', 'not', 'xor', 'this',
  'true', 'false', 'nullptr', 'template', 'typename', 'class', 'struct', 'operator', 'const', 'auto',
  'using', 'namespace', 'public', 'private', 'protected', 'virtual', 'static', 'inline', 'friend',
]);

/** Number of top-level parameters in a signature's first parenthesized list; null when unreadable. */
function paramCount(signature: string | undefined): number | null {
  if (!signature) return null;
  const open = signature.indexOf('(');
  if (open < 0) return null;
  let depth = 0;
  let count = 0;
  let any = false;
  for (let i = open; i < signature.length; i++) {
    const c = signature[i]!;
    if (c === '(' || c === '<' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === '>' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return any ? count + 1 : 0;
    } else if (depth === 1) {
      if (c === ',') count++;
      else if (!/\s/.test(c)) any = true;
    }
  }
  return null;
}

/** The parameter count of operator method `m`, read from its declaration in source; null when unreadable. */
function operatorParamCount(m: Node, op: string, ctx: ResolutionContext): number | null {
  const lines = ctx.getFileLines?.(m.filePath) ?? ctx.readFile(m.filePath)?.split(/\r?\n/) ?? [];
  const head = lines.slice(m.startLine - 1, m.startLine + 4).join('\n');
  const opPattern = op.split('').map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  const at = new RegExp(`\\boperator\\s*${opPattern}\\s*\\(`).exec(head);
  return at ? paramCount(head.slice(at.index + at[0].length - 1)) : null;
}

/** `a + b` → op; the operator a member method named `operator…` overloads, spaces dropped. */
function operatorOf(name: string): string | null {
  const m = /^operator\s*(.+)$/.exec(name);
  if (!m) return null;
  const op = m[1]!.replace(/\s+/g, '');
  return op === '[]' || BINARY_OPS.includes(op) ? op : null;
}

/** Comments and string / char literal contents blanked, offsets kept. */
function codeOf(src: string): string {
  return stripCommentsForRegex(src, 'cpp')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (s) => '"' + ' '.repeat(s.length - 2) + '"')
    .replace(/'(?:[^'\\\n]|\\.){1,4}'/g, (s) => "'" + ' '.repeat(s.length - 2) + "'");
}

/** The class part of a written type: `ns::V` → `V`. */
function lastSegment(t: string): string {
  return t.split('::').filter(Boolean).pop() ?? t;
}

/**
 * The type `name` is declared with in `text` (before `before`): the nearest
 * declarator, or null for no declaration, a pointer, an array, or a
 * non-declaration (`return a;`).
 */
function declaredType(text: string, name: string, before: number, memo?: Map<string, Array<{ at: number; type: string | null }>>): string | null {
  let decls = memo?.get(name);
  if (!decls) {
    decls = [];
    const re = new RegExp(
      `(?<![\\w:.>])((?:[A-Za-z_]\\w*::)*[A-Za-z_]\\w*)\\s*(?:<[^;{}()]*>)?\\s*(?:const\\s+)?([*&]{0,2})\\s*(?:const\\s+)?\\b${name}\\s*(?=([,;=)({\\[]|$))`,
      'gm',
    );
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const type = lastSegment(m[1]!);
      if (CPP_KEYWORDS.has(type)) continue; // `return a;` declares nothing
      decls.push({ at: m.index, type: m[2]!.includes('*') || m[3] === '[' ? null : type });
    }
    memo?.set(name, decls);
  }
  let found: string | null = null;
  for (const d of decls) {
    if (d.at >= before) break;
    found = d.type;
  }
  return found;
}

/** A class's source with its member-declaration level kept and every nested `{...}` block blanked. */
function classMemberText(cls: Node, ctx: ResolutionContext): string | null {
  const lines = ctx.getFileLines?.(cls.filePath) ?? ctx.readFile(cls.filePath)?.split(/\r?\n/);
  if (!lines) return null;
  const text = codeOf(lines.slice(cls.startLine - 1, cls.endLine ?? cls.startLine).join('\n'));
  let depth = 0;
  let out = '';
  for (const c of text) {
    if (c === '{') depth++;
    out += depth > 1 && c !== '\n' ? ' ' : c;
    if (c === '}') depth--;
  }
  return out;
}

export async function cppOperatorEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  // Member operators taking one argument, by owner class name, then operator.
  const byOwner = new Map<string, Map<string, Node[]>>();
  const methods = ctx.iterateNodesByKind ? ctx.iterateNodesByKind('method') : ctx.getNodesByKind('method');
  for (const m of methods) {
    if (m.language !== 'cpp') continue;
    const op = operatorOf(m.name);
    if (!op) continue;
    if (operatorParamCount(m, op, ctx) !== 1) continue;
    const parts = m.qualifiedName.split('::');
    if (parts.length < 2) continue;
    const owner = parts[parts.length - 2]!;
    let ops = byOwner.get(owner);
    if (!ops) byOwner.set(owner, (ops = new Map()));
    const list = ops.get(op);
    if (list) list.push(m);
    else ops.set(op, [m]);
  }
  if (byOwner.size === 0) return [];

  // The operator `op` of type `t`: its own, else the nearest base's.
  const opsMemo = new Map<string, Map<string, Node[]> | null>();
  const opsOf = (t: string, depth = 0): Map<string, Node[]> | null => {
    if (opsMemo.has(t)) return opsMemo.get(t)!;
    opsMemo.set(t, null); // cycle guard
    let found: Map<string, Node[]> | null = byOwner.get(t) ?? null;
    if (depth < 4 && ctx.getSupertypes) {
      for (const sup of ctx.getSupertypes(t, 'cpp')) {
        const inherited = opsOf(lastSegment(sup), depth + 1);
        if (!inherited) continue;
        const merged = new Map(inherited);
        for (const [op, ns] of found ?? []) merged.set(op, ns); // own overloads hide the base's
        found = merged;
      }
    }
    opsMemo.set(t, found);
    return found;
  };

  // Every project type a value could have and get an operator from.
  const typeNames = new Set<string>(byOwner.keys());
  for (const kind of ['class', 'struct'] as const) {
    const it = ctx.iterateNodesByKind ? ctx.iterateNodesByKind(kind) : ctx.getNodesByKind(kind);
    for (const n of it) if (n.language === 'cpp' && !typeNames.has(n.name) && opsOf(n.name)) typeNames.add(n.name);
  }
  const mentionsType = new RegExp(`\\b(?:${[...typeNames].map((t) => t.replace(/\W/g, '\\$&')).join('|')})\\b`);

  const opAlt = BINARY_OPS.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const useRe = new RegExp(`(?<![\\w.:>])([A-Za-z_]\\w*)\\s*(${opAlt}|\\[)`, 'g');

  // A field's declared type, read from the member declarations of its class
  // (C++ fields are not indexed as nodes): the class body with every nested
  // block - inline method bodies - blanked, so a method's local can't pose as one.
  const classBodies = new Map<string, string | null>();
  const fieldType = (cls: string, name: string): string | null => {
    let body = classBodies.get(cls);
    if (body === undefined) {
      const decls = ctx.getNodesByName(cls).filter((n) => n.language === 'cpp' && (n.kind === 'class' || n.kind === 'struct'));
      body = decls.length === 1 ? classMemberText(decls[0]!, ctx) : null;
      classBodies.set(cls, body);
    }
    return body ? declaredType(body, name, body.length) : null;
  };

  const edges: Edge[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if ((++scanned & 31) === 0) await onYield();
    const nodes = ctx.getNodesInFile(file);
    const fns = nodes.filter((n) => n.language === 'cpp' && (n.kind === 'function' || n.kind === 'method'));
    if (fns.length === 0) continue;
    const raw = ctx.readFile(file);
    if (!raw || !mentionsType.test(raw)) continue;
    const code = codeOf(raw);
    const lineStarts = [0];
    for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    for (const fn of fns) {
      const from = lineStarts[fn.startLine - 1];
      const to = lineStarts[(fn.endLine ?? fn.startLine)] ?? code.length;
      if (from === undefined || to <= from) continue;
      const text = code.slice(from, to);
      const lineAt = makeLineAt(text, fn.startLine);
      const cut = fn.qualifiedName.lastIndexOf('::');
      const ownClass = cut > 0 ? lastSegment(fn.qualifiedName.slice(0, cut)) : null;
      const declMemo = new Map<string, Array<{ at: number; type: string | null }>>();
      useRe.lastIndex = 0;
      for (let m = useRe.exec(text); m; m = useRe.exec(text)) {
        const name = m[1]!;
        const op = m[2] === '[' ? '[]' : m[2]!;
        if (op !== '[]' && OP_CHARS.test(text[m.index + m[0].length] ?? '')) continue; // a longer token (`->`, `++`, `<<`)
        if (CPP_KEYWORDS.has(name) || typeNames.has(name)) continue;
        let type = declaredType(text, name, m.index, declMemo);
        if (type === null && ownClass) type = fieldType(ownClass, name);
        if (!type || !typeNames.has(type)) continue;
        const candidates = opsOf(type)?.get(op);
        if (!candidates || candidates.length === 0) continue;
        const target = candidates.find((c) => c.filePath === file) ?? candidates[0]!;
        if (target.id === fn.id) continue;
        const key = `${fn.id}>${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const line = lineAt(m.index);
        edges.push({
          source: fn.id,
          target: target.id,
          kind: 'calls',
          line,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'cpp-operator', via: `${name} ${op === '[]' ? '[…]' : op}`, registeredAt: `${file}:${line}` },
        });
      }
    }
  }
  return edges;
}
