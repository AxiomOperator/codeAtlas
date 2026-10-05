/**
 * Call-shape helpers: whether a call site has a receiver, bare-call detection per language, and type-position checks.
 *
 * Part of the name matcher (see ../name-matcher.ts).
 */

import { Node } from '../../types';
import { UnresolvedRef, ResolutionContext } from '../types';

/**
 * Languages whose calls are JS/TS calls — Vue, Svelte and Astro components'
 * scripts and template expressions included: a bare `t('key')` in a `.vue`
 * file resolves lexically exactly as in a `.ts` one.
 */
export const JS_FAMILY = new Set<string>(['typescript', 'tsx', 'javascript', 'jsx', 'vue', 'svelte', 'astro']);
export const JS_TS = new Set<string>(['typescript', 'tsx', 'javascript', 'jsx']);

/** Languages whose identifiers resolve regardless of case. */
export const CASE_INSENSITIVE_LANGUAGES = new Set<string>(['php', 'pascal', 'cfml', 'cfscript', 'cfquery', 'cobol', 'vbnet']);

/**
 * Whether a JS/TS `calls` ref is a RECEIVER-LESS call — `serialize(x)`, not
 * `this.serialize(x)` / `obj.serialize(x)`. The extractor emits `this.m()`
 * and `super.m()` under the bare method name, so the receiver is read back
 * from the call site's own line: the text at the ref's column is the call
 * expression, and it starts with the name itself only when nothing precedes
 * it. In JS/TS a bare call can never bind to a class method (methods need a
 * receiver), so a `method` node is not a candidate for it (#1714) — the
 * enclosing method itself least of all, which the same-file proximity term
 * used to pick over the module-scope function the call actually means.
 */
/**
 * The receiver a call the extractor recorded by its bare name is written on,
 * read from the source: TS/JS keeps `this.container.classList.toggle()` and
 * `window.$events.listen()` bare, Scala `requestToArmeria(request).execute()`
 * and `_.get.whenRequestMatchesPartial(…)`. `'self'` for `this.m()` /
 * `self.m()` / `super.m()` / `super().m()`; null for a call written bare (or
 * not found). `links` are the member names between `this` and the method.
 */
export function bareCallReceiver(ref: UnresolvedRef, context: ResolutionContext): { receiver: string; links: string[] } | null {
  if (ref.referenceKind !== 'calls' || !/^[A-Za-z_$][\w$]*$/.test(ref.referenceName)) return null;
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/);
  if (!lines) return null;
  const text = lines.slice(ref.line - 1, ref.line + 7).join('\n').slice(Math.max(0, ref.column));
  const name = ref.referenceName.replace(/\$/g, '\\$');
  const at = new RegExp(`(?<![\\w$])${name}\\s*(?:<[^<>()]*>|\\[(?:[^\\[\\]]|\\[[^\\[\\]]*\\])*\\])?\\s*[({]`).exec(text);
  if (!at) return null;
  const before = text.slice(0, at.index).replace(/\s+$/, '');
  if (!/\??\.$/.test(before)) return null;
  const head = before.replace(/\??\.$/, '').replace(/\s+$/, '');
  if (/(?:^|[^\w$.])(?:this|self|super|Self)$/.test(head) || /(?:^|[^\w$.])super\s*\([^()]*\)$/.test(head)) return { receiver: 'self', links: [] };
  const chain = /(?:^|[^\w$.#])((?:this|super)(?:\s*\??\.\s*#?[\w$]+)+)$/.exec(head);
  const links = chain ? chain[1]!.split('.').slice(1).map((l) => l.replace(/[\s?]/g, '')) : [];
  return { receiver: head.slice(-40), links };
}

/** Whether a call recorded by its bare name is written on something other than the caller's own object. */
export function isCollapsedNonRecursion(ref: UnresolvedRef, context: ResolutionContext): boolean {
  const written = bareCallReceiver(ref, context);
  if (!written || written.receiver === 'self') return false;
  return !(JS_FAMILY.has(ref.language) && isCollapsedSelfRecursion({ root: 'this', links: written.links }, ref, context));
}

function isCollapsedSelfRecursion(chain: { root: string; links: string[] }, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (chain.root !== 'this' || chain.links.length !== 1 || chain.links[0]!.includes('(')) return false;
  const field = chain.links[0]!.replace(/^#/, '');
  const caller = context.getNodeById?.(ref.fromNodeId);
  const cut = caller ? caller.qualifiedName.lastIndexOf('::') : -1;
  if (!caller || cut <= 0) return false;
  const owner = caller.qualifiedName.slice(0, cut).split('::').pop()!;
  const cls = context.getNodesInFile(ref.filePath).find((n) =>
    n.kind === 'class' && n.name === owner && n.startLine <= ref.line && n.endLine >= ref.line);
  if (!cls) return false;
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? [];
  const body = lines.slice(cls.startLine - 1, cls.endLine).join('\n');
  const f = field.replace(/\$/g, '\\$');
  const declared = new RegExp(`(?:^|[\\s(,])#?${f}\\s*[?!]?\\s*:\\s*([A-Za-z_$][\\w$]*)`, 'm').exec(body)?.[1] ??
    new RegExp(`\\bthis\\.${f}\\s*=\\s*new\\s+([A-Za-z_$][\\w$]*)`).exec(body)?.[1];
  return declared === owner;
}

export function isBareJsCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  return JS_FAMILY.has(ref.language) && isReceiverLessCall(ref, context);
}

/**
 * Whether a Go `calls` ref is receiver-less — `relogin(ctx)`, not
 * `l.relogin(ctx)`. A Go method is only reachable through a value or a method
 * expression, so a bare call (a func parameter, a local func value, a
 * package-level function) is never a method, in its own package or in one the
 * file does not import (#1857). Read from the source line like the JS/TS
 * check, because `pkg.Factory().Method()` reaches the resolver as a bare
 * `Method` ref too.
 */
export function isBareGoCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  return ref.language === 'go' && isReceiverLessCall(ref, context);
}

/**
 * Whether an R call is a plain function call — `range(x)`, `vars(a)` — not a
 * ggproto / R6 method through `obj$m(…)` or `self$m(…)`. A method is only
 * reached through its object: ggplot2's `range(data$x)` (base R's) went to a
 * Coord's `range` method.
 */
export function isBareRCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.language !== 'r' || ref.referenceKind !== 'calls' || !/^[A-Za-z_.][\w.]*$/.test(ref.referenceName)) return false;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (!line) return false;
  const m = new RegExp(`(?<![\\w.])${ref.referenceName.replace(/\./g, '\\.')}\\s*\\(`).exec(line);
  return !!m && !/(?:\$|@|::)\s*$/.test(line.slice(0, m.index));
}

/**
 * Whether a PHP `calls` ref is a bare function call — `redirect($url)`,
 * `view('books.show')` — rather than `$this->redirect()` / `$obj->view()` /
 * `Foo::view()`. PHP has no implicit `$this`: a call written without a
 * receiver can only be a function, so a method, field or property that shares
 * the name is never what it calls. Name-matching used to bind BookStack's
 * every `return redirect(…)` to ApiDocsController::redirect and every
 * `return view(…)` to a `$view` field.
 *
 * PHP refs record the column of the call EXPRESSION — `$this->setPageTitle(`
 * sits at `$this` — so a bare call is the one whose text at its column is the
 * name itself (a leading `\` for a fully qualified function is allowed).
 */
export function isBarePhpCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.language !== 'php' || ref.referenceKind !== 'calls') return false;
  if (!/^\w+$/.test(ref.referenceName)) return false;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1]
    ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return false;
  const at = line[ref.column] === '\\' ? ref.column + 1 : ref.column;
  if (!line.startsWith(ref.referenceName, at)) return false;
  CALL_OPENER.lastIndex = at + ref.referenceName.length;
  if (!CALL_OPENER.test(line)) return false;
  let end = at;
  while (end > 0 && WHITESPACE.test(line[end - 1]!)) end--;
  // `$obj->name(` / `Foo::name(` / `$obj?->name(`, should a column ever land on
  // the name — but not `'size' => filesize($zip)` or `$x ? a : name()`.
  return !(end > 1 && ((line[end - 1] === '>' && line[end - 2] === '-') || (line[end - 1] === ':' && line[end - 2] === ':')));
}

function isReceiverLessCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.referenceKind !== 'calls') return false;
  if (ref.referenceName.includes('.')) return false;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1]
    ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return false;
  // `^<name>\s*[(<]` at the call's column, without compiling a pattern per call.
  if (!line.startsWith(ref.referenceName, ref.column)) return false;
  CALL_OPENER.lastIndex = ref.column + ref.referenceName.length;
  if (!CALL_OPENER.test(line)) return false;
  // Nothing but whitespace, an operator or an opener may precede a bare call:
  // read the text before the column backwards, past trailing whitespace,
  // instead of end-anchoring a pattern that scans the prefix from its start.
  let end = Math.min(ref.column, line.length);
  while (end > 0 && WHITESPACE.test(line[end - 1]!)) end--;
  if (end === 0 || !RECEIVER_TAIL_CHAR.test(line[end - 1]!)) return true;
  let start = end;
  while (start > 0 && WORD_CHAR.test(line[start - 1]!)) start--;
  return BARE_CALL_KEYWORDS.has(line.slice(start, end));
}

/** `\s*[(<]` from a given index (sticky) — an optional call's `?.(` too. */
const CALL_OPENER = /\s*(?:\?\.\s*)?[(<]/y;
export const WHITESPACE = /\s/;
const WORD_CHAR = /\w/;
/** A character that ends a receiver: `.`, a word character, `$`, `]` or `)`. */
const RECEIVER_TAIL_CHAR = /[.\w$\])]/;
/** Keywords after which a name starts an expression, so the call has no receiver. */
const BARE_CALL_KEYWORDS: ReadonlySet<string> = new Set([
  'return', 'await', 'yield', 'typeof', 'void', 'new', 'else', 'case', 'throw', 'in', 'of', 'instanceof', 'go', 'defer',
]);

/**
 * A C# / VB.NET reference whose site is a TYPE position: `Type sourceType`,
 * `List<int>`, `new TypeMap()`, `Exception? e`, `Dictionary<string, Type>`,
 * VB's `As Type` / `New List(Of T)`. Read from the source at the reference's
 * column; anything else — a member read (`Builder.Services`), a method group
 * (`MapGet("/x", GetItems)`), a route's handler — keeps every candidate.
 */
export function isDotNetTypeRef(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.language !== 'csharp' && ref.language !== 'vbnet') return false;
  if (ref.referenceKind !== 'references' && ref.referenceKind !== 'instantiates' &&
    ref.referenceKind !== 'type_of' && ref.referenceKind !== 'returns') return false;
  const name = ref.referenceName;
  if (!/^[A-Za-z_]\w*$/.test(name)) return false;
  // `new TypeMap()` constructs a type; the reference's column is the `new`.
  if (ref.referenceKind === 'instantiates') return true;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1]
    ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined || !line.startsWith(name, ref.column)) return false;
  const before = line.slice(0, ref.column);
  const after = line.slice(ref.column + name.length);
  if (ref.language === 'vbnet') return /\b(?:As|New|Of)\s+$/i.test(before);
  if (/\bnew\s+$/.test(before)) return true;
  // `Type name` — a declaration names its type first.
  if (/^\s+@?[A-Za-z_]/.test(after)) return !/^\s+(?:is|as|and|or|not|when|in|switch|with)\b/.test(after);
  // `List<int>`, `Type?`, `Type[]`, and the arguments of a generic.
  if (/^<|^\?(?![.?\[])|^\[\s*[,\]]/.test(after)) return true;
  return /^\s*[,>]/.test(after) && /<[^<>()]*$/.test(before);
}

/**
 * Whether a candidate can be what a .NET type position names. A property, a
 * method (a constructor is one) or an enum case shares the type's name, not
 * its meaning: AutoMapper's `Type sourceType` bound to an attribute's `Type`
 * property and `TypeMap typeMap` to a `TypeMap` property beside the `TypeMap`
 * class. A field never names a type either, nor does a constant — the kind a
 * C# `const` / `static readonly` field gets: jellyfin's `new Version(5, 18)`
 * bound to a claim-name `const string Version`, and serilog's `static
 * readonly Meter Meter = new(…)` to itself.
 */
export function canNameInTypePosition(n: Node): boolean {
  return !(n.kind === 'property' || n.kind === 'method' || n.kind === 'enum_member' || n.kind === 'field' ||
    n.kind === 'constant');
}

export const NO_RECEIVER_LINES = new WeakMap<ResolutionContext, WeakMap<UnresolvedRef, boolean>>();

/**
 * Whether a bare reference is receiver-less at its call site, name case
 * aside: the name is not preceded by a `.` on its line (true when the line
 * can't tell). An extractor that keeps one receiver level hands the later
 * links of a chain (`newFuture(f).then(g)`) over bare.
 */
export function hasNoReceiverOnLine(ref: UnresolvedRef, context: ResolutionContext): boolean {
  // Asked once per CANDIDATE by the per-language scope filters, though only
  // the ref decides it — a bare `init()` in a CFML codebase has hundreds of
  // same-named methods, each re-reading the line (#2091).
  let memo = NO_RECEIVER_LINES.get(context);
  if (!memo) NO_RECEIVER_LINES.set(context, (memo = new WeakMap()));
  let answer = memo.get(ref);
  if (answer === undefined) memo.set(ref, (answer = readNoReceiverOnLine(ref, context)));
  return answer;
}

function readNoReceiverOnLine(ref: UnresolvedRef, context: ResolutionContext): boolean {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return true;
  const lower = line.toLowerCase();
  const name = ref.referenceName.toLowerCase();
  let start = -1;
  if (lower.startsWith(name, ref.column)) start = ref.column;
  else if (ref.column >= name.length && lower.startsWith(name, ref.column - name.length)) start = ref.column - name.length;
  else start = lower.search(new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`));
  // Not on its line at all: a link of a chain written across lines.
  if (start < 0) return false;
  return !/\.\s*$/.test(line.slice(0, start));
}
