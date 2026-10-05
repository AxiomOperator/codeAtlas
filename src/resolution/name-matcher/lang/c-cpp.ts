/**
 * C / C++ scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from '../../types';
import { stripCommentsForRegex } from '../../strip-comments';
import { isTestPath } from '../../../search/query-utils';

/** Per-context memo: node id → "this C/C++ function is declared `static`". */
export const C_STATIC_MEMO = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * A C/C++ file that IS a translation unit. A `static` defined here is local
 * to it. A `static` (typically `static inline`) in a header is a different
 * thing: the header is textually included, so the function exists in every
 * unit that includes it and is callable from each — MAVLink's generated
 * `mavlink_msg_*.h` are nothing but such functions, 4,306 real calls on one
 * betaflight tree.
 */
export const C_SOURCE_EXT = /\.(c|cc|cpp|cxx|c\+\+|m|mm)$/i;

/**
 * Whether a C/C++ function definition carries the `static` storage class —
 * read from its first source line(s), since the extractor records no storage
 * class and the kernel arm would need the same field. `static` on the line
 * above the name (`static void\nfoo(void)`) is the common alternative layout.
 */
export function isStaticCFunction(candidate: Node, context: ResolutionContext): boolean {
  let memo = C_STATIC_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    C_STATIC_MEMO.set(context, memo);
  }
  const hit = memo.get(candidate.id);
  if (hit !== undefined) return hit;
  const lines = context.getFileLines?.(candidate.filePath) ?? context.readFile(candidate.filePath)?.split('\n') ?? [];
  const head = [lines[candidate.startLine - 2] ?? '', lines[candidate.startLine - 1] ?? ''].join('\n');
  const isStatic = /(^|[\s;}])static\s/.test(head);
  memo.set(candidate.id, isStatic);
  return isStatic;
}

// C++ keywords/control-flow tokens that can appear right before a receiver
// (e.g. `return ptr->m()`) and must NOT be treated as a type.
const CPP_NON_TYPE_TOKENS = new Set([
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'goto', 'throw', 'new', 'delete', 'co_await', 'co_yield',
  'co_return', 'static_cast', 'const_cast', 'dynamic_cast', 'reinterpret_cast',
  'sizeof', 'alignof', 'typeid', 'and', 'or', 'not', 'xor',
]);

function normalizeCppTypeName(typeName: string): string | null {
  const normalized = typeName
    .replace(/\b(const|volatile|mutable|typename|class|struct)\b/g, ' ')
    .replace(/[&*]+/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;
  const parts = normalized.split(/::/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  if (CPP_NON_TYPE_TOKENS.has(last)) return null;
  return last;
}

// Declarator regex: matches `Type receiver`, `Type* receiver`, `Type *receiver`,
// `Type*receiver`, `Type<X> receiver`, etc., REQUIRING a declarator terminator
// (`;`, `=`, `,`, `)`, `[`, `{`, `(`, or end-of-line) after the receiver. The
// terminator rules out uses like `return receiver->m()` where the preceding
// token is a keyword, not a type.
function buildDeclaratorRegex(escapedReceiver: string): RegExp {
  return new RegExp(
    `([A-Za-z_][\\w:]*(?:\\s*<[^;=(){}]+>)?(?:\\s*[*&]+)?)\\s*\\b${escapedReceiver}\\b\\s*(?=[;=,)\\[{(]|$)`,
  );
}

export function inferCppReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth = 0,
): string | null {
  // Per-file lines cache when available — this runs per `receiver->method()`
  // ref and re-splitting the file each time is the same quadratic as the
  // shared inferrer's (#1122).
  const lines = context.getFileLines
    ? context.getFileLines(ref.filePath)
    : (context.readFile(ref.filePath)?.split(/\r?\n/) ?? null);
  if (!lines || lines.length === 0) return null;

  const callLineIndex = Math.max(0, Math.min(lines.length - 1, ref.line - 1));
  const escapedReceiver = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const receiverPattern = new RegExp(`\\b${escapedReceiver}\\b`);
  const declaratorRegex = buildDeclaratorRegex(escapedReceiver);

  for (let i = callLineIndex; i >= 0; i--) {
    const line = lines[i];
    if (!line || !receiverPattern.test(line)) continue;

    const declaratorMatch = line.match(declaratorRegex);
    if (declaratorMatch) {
      const normalized = normalizeCppTypeName(declaratorMatch[1] ?? '');
      if (normalized === 'auto') {
        // `auto x = Foo::instance();` — the declared type is deduced; recover it
        // from the initializer (call return type / construction) (#645).
        const initType = inferCppAutoInitializerType(line, receiverName, ref, context, depth);
        if (initType) return initType;
        // No usable initializer on this line — keep scanning earlier ones.
      } else if (normalized) {
        return normalized;
      }
    }
  }

  const headerCandidates = [
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.h'),
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.hpp'),
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.hxx'),
  ].filter((candidate, index, arr) => arr.indexOf(candidate) === index && candidate !== ref.filePath);

  for (const headerPath of headerCandidates) {
    if (!context.fileExists(headerPath)) continue;
    const headerLines = context.getFileLines
      ? context.getFileLines(headerPath)
      : (context.readFile(headerPath)?.split(/\r?\n/) ?? null);
    if (!headerLines) continue;

    for (const line of headerLines) {
      if (!receiverPattern.test(line)) continue;
      const declaratorMatch = line.match(declaratorRegex);
      if (!declaratorMatch) continue;
      const normalized = normalizeCppTypeName(declaratorMatch[1] ?? '');
      if (normalized && normalized !== 'auto') return normalized;
    }
  }

  return null;
}

/**
 * Last `::`-separated segment of a (possibly namespace-qualified) C++ name.
 */
function cppLastSegment(name: string): string {
  const parts = name.split('::').filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

/**
 * Return type captured at extraction for `Class::method` (or a free function),
 * read off the indexed node's `returnType` — used by the C++ (#645) and PHP
 * (#608) chained-call resolvers. Language-filtered. Null when not indexed or no
 * return type was recorded (a `void`/primitive return).
 */
export function lookupCalleeReturnType(
  callee: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  let method = callee;
  let cls: string | null = null;
  if (callee.includes('::')) {
    const parts = callee.split('::').filter(Boolean);
    method = parts[parts.length - 1] ?? callee;
    cls = parts.slice(0, -1).join('::');
  }
  const candidates = context.getNodesByName(method).filter(
    (n) =>
      (n.kind === 'method' || n.kind === 'function') &&
      n.language === ref.language &&
      !!n.returnType,
  );
  if (cls) {
    const want = `${cls}::${method}`;
    // The call site may name the class with MORE namespace qualification than
    // the stored node (`details::registry::instance` at the call vs
    // `registry::instance` on the node — the receiver type only carries the
    // immediate class), or LESS. Accept an exact match or either being a
    // namespace-suffix of the other; the shared `::<class>::<method>` tail keeps
    // it specific.
    const m = candidates.find(
      (n) =>
        n.qualifiedName === want ||
        n.qualifiedName.endsWith(`::${want}`) ||
        want.endsWith(`::${n.qualifiedName}`),
    );
    return m?.returnType ?? null;
  }
  return candidates.find((n) => n.kind === 'function')?.returnType ?? null;
}

/** Does the graph contain an aggregate type named `name`'s last segment? */
function cppClassExists(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const last = cppLastSegment(name);
  return context
    .getNodesByName(last)
    .some((n) => (n.kind === 'class' || n.kind === 'struct' || n.kind === 'union') && n.language === ref.language);
}

/**
 * Infer the class produced by a C++ call/construction expression, using return
 * types captured at extraction (#645). Handles, in order:
 *   - `make_unique<T>()` / `make_shared<T>()`        → T
 *   - single-level member call `recv.method()`       → recv's type, then method's return
 *   - `Class::method()` / free `func()`              → the callee's recorded return type
 *   - direct construction `Type()` / `ns::Type()`    → Type
 * Returns null when undeterminable. Callers MUST still validate the outer method
 * exists on the result before creating an edge, so a wrong guess stays silent.
 */
export function resolveCppCallResultType(
  inner: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth = 0,
): string | null {
  if (depth > 3) return null; // guard against pathological mutual recursion
  const expr = inner.trim();

  const make = expr.match(/(?:^|::)(?:make_unique|make_shared)\s*<\s*([A-Za-z_]\w*)/);
  if (make) return make[1] ?? null;

  // Single-level member call `recv.method` (the `manager.view().render()` shape).
  const dotIdx = expr.lastIndexOf('.');
  if (dotIdx > 0) {
    const recv = expr.slice(0, dotIdx);
    const method = expr.slice(dotIdx + 1);
    if (recv.includes('.') || recv.includes('(') || recv.includes('::')) return null; // single level only
    const recvType = inferCppReceiverType(recv, ref, context, depth + 1);
    if (!recvType) return null;
    return lookupCalleeReturnType(`${recvType}::${method}`, ref, context);
  }

  const ret = lookupCalleeReturnType(expr, ref, context);
  if (ret) return ret;

  // Direct construction — the callee itself names a class/struct.
  if (cppClassExists(expr, ref, context)) return cppLastSegment(expr);

  return null;
}

/**
 * Recover the type of an `auto`-declared local from its initializer on the
 * declaration line — `auto x = Foo::instance();`, `auto w = make_unique<W>();`,
 * `auto p = new W();`, `auto w = Widget();` (#645).
 */
function inferCppAutoInitializerType(
  line: string,
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth: number,
): string | null {
  const escaped = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = line.match(new RegExp(`\\b${escaped}\\b\\s*=\\s*([^;]+)`));
  if (!m || !m[1]) return null;
  const init = m[1].trim();

  const neu = init.match(/^new\s+([A-Za-z_][\w:]*)/);
  if (neu && neu[1]) return cppLastSegment(neu[1]);

  // A call or construction: `Foo(...)`, `A::b(...)`, `make_unique<T>(...)`.
  const call = init.match(/^([A-Za-z_][\w:]*(?:\s*<[^>;]*>)?)\s*\(/);
  if (call && call[1]) return resolveCppCallResultType(call[1].replace(/\s+/g, ''), ref, context, depth + 1);

  return null;
}

export const CPP_NS_MACROS = new WeakMap<ResolutionContext, { openers: Map<string, string[]>; openerFns: Set<string>; closers: Map<string, number>; aliases: Map<string, string> }>();
export const CPP_NS_FRAMES = new WeakMap<ResolutionContext, Map<string, Array<{ start: number; end: number; path: string[] }>>>();
/** A closing macro's body: `}` / `} }`, maybe beside a pragma macro (`PYBIND11_WARNING_POP }`). */
const CPP_CLOSER_BODY = /^(?:[A-Za-z_]\w*\s+)*\}(?:\s*\})*\s*;?$/;
export const CPP_NS_ALIASES = new WeakMap<ResolutionContext, Map<string, string>>();

/** The project's namespace aliases: `namespace py = pybind11;`. */
function cppNamespaceAliases(context: ResolutionContext): Map<string, string> {
  const hit = CPP_NS_ALIASES.get(context);
  if (hit) return hit;
  const aliases = new Map<string, string>();
  for (const file of context.getAllFiles()) {
    if (!/\.(?:h|hh|hpp|hxx|inl|c|cc|cpp|cxx)$/i.test(file)) continue;
    const source = context.readFile(file);
    if (!source || !source.includes('namespace')) continue;
    for (const m of source.matchAll(/^[ \t]*namespace[ \t]+([A-Za-z_]\w*)[ \t]*=[ \t]*(?:::)?([A-Za-z_][\w:]*)[ \t]*;/gm)) {
      if (!aliases.has(m[1]!)) aliases.set(m[1]!, m[2]!);
    }
  }
  CPP_NS_ALIASES.set(context, aliases);
  return aliases;
}

/**
 * The project's namespace-opening macros — `#define FMT_BEGIN_NAMESPACE
 * namespace fmt { inline namespace v12 {`, `#define RAPIDJSON_NAMESPACE_BEGIN
 * namespace RAPIDJSON_NAMESPACE {` (through `#define RAPIDJSON_NAMESPACE
 * rapidjson`) — as the namespace path each opens (inline namespaces are
 * transparent), and the closing macros as how many scopes each closes.
 */
function cppNamespaceMacros(context: ResolutionContext): { openers: Map<string, string[]>; openerFns: Set<string>; closers: Map<string, number>; aliases: Map<string, string> } {
  const hit = CPP_NS_MACROS.get(context);
  if (hit) return hit;
  const openers = new Map<string, string[]>();
  // `#define PYBIND11_NAMESPACE_BEGIN(name) namespace name {`, used as `PYBIND11_NAMESPACE_BEGIN(detail)`.
  const openerFns = new Set<string>();
  const closers = new Map<string, number>();
  const aliases = new Map<string, string>();
  const bodies: Array<[string, string]> = [];
  for (const file of context.getAllFiles()) {
    if (!/\.(?:h|hh|hpp|hxx|h\+\+|inl|ipp|tcc)$/i.test(file)) continue;
    const raw = context.readFile(file);
    if (!raw || !raw.includes('#') || !raw.includes('define')) continue;
    const source = stripCommentsForRegex(raw.replace(/\\\r?\n/g, ' '), 'cpp');
    for (const m of source.matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)(\(\s*([A-Za-z_]\w*)?\s*\))?[ \t]+([^\n]*)$/gm)) {
      const body = m[4]!.trim();
      if (m[2] !== undefined) {
        // (a trailing pragma macro — `PYBIND11_WARNING_PUSH` — rides along)
        if (m[3] && new RegExp(`^namespace\\s+${m[3]}\\s*\\{[\\w\\s]*$`).test(body)) openerFns.add(m[1]!);
        else if (CPP_CLOSER_BODY.test(body)) closers.set(m[1]!, (body.match(/\}/g) ?? []).length);
        continue;
      }
      if (/^[A-Za-z_]\w*$/.test(body)) aliases.set(m[1]!, body);
      else if (CPP_CLOSER_BODY.test(body)) closers.set(m[1]!, (body.match(/\}/g) ?? []).length);
      // An inline namespace (transparent, and often named by a macro call) is skipped.
      else if (/^(?:inline\s+namespace\s+[^{}]*\{\s*|namespace\s+[A-Za-z_]\w*\s*\{\s*)+[\w\s]*$/.test(body)) bodies.push([m[1]!, body]);
    }
  }
  for (const [name, body] of bodies) {
    if (openers.has(name)) continue;
    const path = [...body.replace(/inline\s+namespace\s+[^{}]*\{/g, '').matchAll(/namespace\s+([A-Za-z_]\w*)/g)]
      .map((m) => aliases.get(m[1]!) ?? m[1]!);
    if (path.length > 0) openers.set(name, path);
  }
  const macros = { openers, openerFns, closers, aliases };
  CPP_NS_MACROS.set(context, macros);
  return macros;
}

/** The line ranges of a C / C++ file each namespace macro opens, with the namespace path it opens. */
function cppMacroNamespaceFrames(file: string, context: ResolutionContext): Array<{ start: number; end: number; path: string[] }> {
  let memo = CPP_NS_FRAMES.get(context);
  if (!memo) {
    memo = new Map();
    CPP_NS_FRAMES.set(context, memo);
  }
  const hit = memo.get(file);
  if (hit) return hit;
  const frames: Array<{ start: number; end: number; path: string[] }> = [];
  const { openers, openerFns, closers, aliases } = cppNamespaceMacros(context);
  if (openers.size > 0 || openerFns.size > 0) {
    const lines = context.getFileLines?.(file) ?? context.readFile(file)?.split(/\r?\n/) ?? [];
    const open: Array<{ start: number; path: string[] }> = [];
    lines.forEach((text, i) => {
      const m = /^[ \t]*([A-Z_][A-Z0-9_]*)(?:\(\s*([A-Za-z_]\w*)?\s*\))?[ \t]*;?[ \t]*(?:\/\/.*|\/\*.*\*\/[ \t]*)?\r?$/.exec(text);
      const token = m?.[1];
      if (!token) return;
      const arg = m[2];
      const path = arg !== undefined && openerFns.has(token) ? [aliases.get(arg) ?? arg] : arg === undefined ? openers.get(token) : undefined;
      if (path) open.push({ start: i + 1, path });
      else if (closers.has(token) && open.length > 0) frames.push({ ...open.pop()!, end: i + 1 });
    });
    for (const frame of open) frames.push({ ...frame, end: lines.length });
  }
  memo.set(file, frames);
  return frames;
}

/**
 * Resolve `fmt::format` / `fmt::detail::to_unsigned` to the declaration a
 * namespace macro puts there: a node named `format` (qualified `format` or
 * `detail::to_unsigned` in the index, which cannot see the macro) inside a
 * `FMT_BEGIN_NAMESPACE` … `FMT_END_NAMESPACE` range. On fmt, 1,728
 * `fmt::format(…)` calls resolved to nothing.
 */
export function matchCppMacroNamespaced(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  let target = ref.referenceName.replace(/^::/, '');
  const head = target.slice(0, target.indexOf('::'));
  const alias = cppNamespaceAliases(context).get(head);
  // `py::str` under `namespace py = pybind11;` is `pybind11::str`.
  if (alias) target = alias + target.slice(head.length);
  const name = target.slice(target.lastIndexOf('::') + 2);
  if (!/^[A-Za-z_~]\w*$/.test(name)) return null;
  const matches: Node[] = [];
  for (const n of context.getNodesByName(name)) {
    if (n.language !== 'cpp' && n.language !== 'c') continue;
    if (!['function', 'method', 'class', 'struct', 'enum', 'type_alias', 'union', 'variable', 'constant'].includes(n.kind)) continue;
    const prefix = cppMacroNamespaceFrames(n.filePath, context)
      .filter((f) => f.start <= n.startLine && f.end >= n.startLine)
      .sort((a, b) => a.start - b.start)
      .flatMap((f) => f.path);
    const effective = prefix.length > 0 ? `${prefix.join('::')}::${n.qualifiedName}` : alias ? n.qualifiedName : '';
    if (effective === target) matches.push(n);
  }
  // A declaration outside the tests over one in them; among an overload set,
  // the one the call's arguments fit: `fmt::format("{}", v)` is format.h's
  // `format(format_string, T&&...)`, not color.h's `format(const text_style&, …)`.
  const args = matches.length > 1 && ref.referenceKind === 'calls' ? cppCallArguments(ref, name, context) : null;
  let best: Node | null = null;
  let bestScore = -Infinity;
  for (const n of matches) {
    const score = (isTestPath(n.filePath) ? -10 : 0) + (args ? cppOverloadFit(n, name, args, context) : 0);
    if (score > bestScore) { best = n; bestScore = score; }
  }
  return best ? { original: ref, targetNodeId: best.id, confidence: 0.8, resolvedBy: 'qualified-name' } : null;
}

/** Split `a, f(b, c), d<e, f>` at its top-level commas. */
export function splitCppTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || (ch === '>' && text[i - 1] !== '-')) depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The balanced `( … )` after `name` from `line`/`column` of `file` (up to a dozen lines), or null. */
export function cppParenListAfter(file: string, line: number, column: number, name: string, context: ResolutionContext): string | null {
  const lines = context.getFileLines?.(file) ?? context.readFile(file)?.split(/\r?\n/) ?? [];
  const text = lines.slice(line - 1, line + 11).join('\n');
  const at = new RegExp(`\\b${name.replace(/[~]/g, '\\$&')}\\s*(?:<[^<>()]*>)?\\s*\\(`).exec(text.slice(column));
  if (!at) return null;
  const open = column + at.index + at[0].length - 1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

function cppCallArguments(ref: UnresolvedRef, name: string, context: ResolutionContext): string[] | null {
  const list = cppParenListAfter(ref.filePath, ref.line, Math.max(0, ref.column), name, context);
  return list === null ? null : splitCppTopLevel(list);
}

/** How well a call's arguments fit an overload's parameters: arity, and a string literal's first slot. */
function cppOverloadFit(n: Node, name: string, args: string[], context: ResolutionContext): number {
  if (n.kind !== 'function' && n.kind !== 'method') return -1;
  const list = cppParenListAfter(n.filePath, n.startLine, 0, name, context);
  if (list === null) return 0;
  const params = splitCppTopLevel(list).filter((p) => p !== 'void');
  // A pack is `T&&... args`, not the `...` inside `format_string<T...>`.
  const isPack = (p: string): boolean => {
    let flat = p;
    for (let prev = ''; prev !== flat;) { prev = flat; flat = flat.replace(/<[^<>]*>/g, ''); }
    return flat.includes('...');
  };
  const variadic = params.some(isPack);
  const required = params.filter((p) => !isPack(p) && !/=/.test(p)).length;
  let score = 0;
  if (args.length < required || (!variadic && args.length > params.length)) score -= 3;
  // Each string literal against its parameter: a string type by name over a
  // template parameter that might be one (`const S&`), and a narrow literal
  // never a wide parameter (`fmt::join(v, ", ")` is not xchar.h's `wstring_view`).
  for (let i = 0; i < args.length && i < params.length; i++) {
    const arg = args[i]!;
    const param = params[i]!;
    if (isPack(param)) break;
    if (!/^(?:u8|u|U|L)?"|^FMT_STRING\s*\(/.test(arg)) continue;
    const wideArg = /^L"/.test(arg);
    const wideParam = /\bw(?:string|char_t|format|string_view)|wchar_t/.test(param);
    if (wideArg !== wideParam && /string|char|Char|format/.test(param)) score -= 2;
    else score += /string|char|Char|\bstr\b/.test(param) ? 3 : /^(?:const\s+)?[A-Z]\w{0,2}\s*[&*]{0,2}\s*\w*$/.test(param) ? 1 : -2;
  }
  return score;
}
