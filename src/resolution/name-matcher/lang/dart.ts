/**
 * Dart scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from '../../types';
import { inferLocalReceiverType } from '../receiver-inference';
import { preferCallSiteFile } from '../strategies/qualified';

const DART_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'mixin', 'extension', 'struct', 'trait']);
export const DART_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();

/**
 * Whether a bare Dart call can reach `method`: only a method of the class it
 * is written in, or of what that class extends, mixes in or implements (an
 * extension's `on` type included). riverpod's tests' `test(…)` — package:test's
 * function — went to `ProviderContainer.test` 2,360 times; shelf's `expect(…)`
 * to a test handler's `expect` method. Outside any class (`main`), no method.
 */
export function isDartMethodInScope(method: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  return dartMemberDepth(method, ref, context) < Infinity;
}

/**
 * How many supertype steps separate the class a Dart call is written in from
 * `method`'s owner: 0 for its own member, Infinity when the owner is not in
 * its hierarchy at all. An extension's member is in scope when the extension
 * is `on` a type of that hierarchy — a bare `requireElement()` inside a
 * notifier is `this.requireElement()`, the `on AnyNotifier` extension's — and
 * ranks after every real member, as Dart resolves it.
 */
function dartMemberDepth(method: Node, ref: UnresolvedRef, context: ResolutionContext): number {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut < 0) return 0;
  const owner = method.qualifiedName.slice(0, cut).split('::').pop()!;
  const hierarchy = dartHierarchyAt(ref, context);
  const own = hierarchy.get(owner);
  if (own !== undefined) return own;
  const decl = context
    .getNodesInFile(method.filePath)
    .find((n) => n.name === owner && DART_TYPE_KINDS.has(n.kind) && n.startLine <= method.startLine && n.endLine >= method.endLine);
  if (!decl) return Infinity;
  const head = dartHeadOf(decl, context);
  if (!head.extension) return Infinity;
  const on = Math.min(...head.supers.map((t) => hierarchy.get(t) ?? Infinity));
  return on === Infinity ? Infinity : DART_EXTENSION_RANK + on;
}

/** Past any real member's depth: an extension member only applies when no instance member does. */
const DART_EXTENSION_RANK = 1000;
export const DART_HIERARCHIES = new WeakMap<ResolutionContext, WeakMap<UnresolvedRef, Map<string, number>>>();

/** Every type the classes around a Dart call site are, by supertype distance (at most 40). */
function dartHierarchyAt(ref: UnresolvedRef, context: ResolutionContext): Map<string, number> {
  let memo = DART_HIERARCHIES.get(context);
  if (!memo) {
    memo = new WeakMap();
    DART_HIERARCHIES.set(context, memo);
  }
  const hit = memo.get(ref);
  if (hit) return hit;
  const depths = new Map<string, number>();
  const queue: Array<[string, number]> = context
    .getNodesInFile(ref.filePath)
    .filter((n) => DART_TYPE_KINDS.has(n.kind) && n.startLine <= ref.line && n.endLine >= ref.line)
    .map((n) => [n.name, 0]);
  while (queue.length > 0 && depths.size < 40) {
    const [name, depth] = queue.shift()!;
    if (depths.has(name)) continue;
    depths.set(name, depth);
    for (const sup of dartSupertypesOf(name, context)) queue.push([sup, depth + 1]);
  }
  memo.set(ref, depths);
  return depths;
}

/**
 * Of the in-scope members a bare Dart call could mean, the nearest: a
 * subclass's override, or the class that implements what an interface only
 * declares. bloc's `emit(…)` in a `Cubit` is `BlocBase.emit`, not the
 * `Emittable` interface's.
 */
export function nearestDartMembers(candidates: Node[], ref: UnresolvedRef, context: ResolutionContext): Node[] {
  const members = candidates.filter(isDartMember);
  if (members.length < 2) return candidates;
  const depth = new Map(members.map((n) => [n.id, dartMemberDepth(n, ref, context)]));
  const nearest = Math.min(...depth.values());
  return candidates.filter((n) => !depth.has(n.id) || depth.get(n.id) === nearest);
}

/** A member of a Dart type — a method, or an abstract member written without a body (extracted as a `function` owned by the type). */
export function isDartMember(n: Node): boolean {
  return n.kind === 'method' || (n.kind === 'function' && n.qualifiedName.includes('::'));
}

/**
 * Whether a bare Dart reference really is receiver-less at its call site. The
 * extractor keeps one receiver level, so the later links of a chain —
 * `LoginState().withEmail(e).withPassword(p)` — arrive as bare names; their
 * line shows `.withPassword(` all the same. (A Dart ref's column sits just
 * past the name; the name's start is found either way.)
 */
export function isReceiverLessDartCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return true;
  const name = ref.referenceName;
  let start = -1;
  if (line.startsWith(name, ref.column)) start = ref.column;
  else if (ref.column >= name.length && line.startsWith(name, ref.column - name.length)) start = ref.column - name.length;
  else start = line.indexOf(name);
  if (start < 0) return true;
  return !/\.\s*$/.test(line.slice(0, start));
}

/** The simple names a Dart type's declarations extend, mix in, implement, or (an extension / mixin) sit `on`. */
export function dartSupertypesOf(typeName: string, context: ResolutionContext): string[] {
  let memo = DART_SUPERS.get(context);
  if (!memo) {
    memo = new Map();
    DART_SUPERS.set(context, memo);
  }
  const hit = memo.get(typeName);
  if (hit) return hit;
  const names: string[] = [];
  for (const decl of context.getNodesByName(typeName)) {
    if (decl.language !== 'dart' || !DART_TYPE_KINDS.has(decl.kind)) continue;
    names.push(...dartHeadOf(decl, context).supers);
  }
  memo.set(typeName, names);
  return names;
}

/** Every type a value of Dart type `typeName` is, by supertype distance (at most 40). */
function dartTypeHierarchy(typeName: string, context: ResolutionContext): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: Array<[string, number]> = [[typeName, 0]];
  while (queue.length > 0 && depths.size < 40) {
    const [name, depth] = queue.shift()!;
    if (depths.has(name)) continue;
    depths.set(name, depth);
    for (const sup of dartSupertypesOf(name, context)) queue.push([sup, depth + 1]);
  }
  return depths;
}

/**
 * The member of Dart type `typeName` (its own, a supertype's, or — ranked after
 * every real member, as Dart resolves it — an extension's `on` that type or a
 * supertype) among `candidates`. An enum's extension is the case the edge
 * walk misses: `s.label` / `s.shout()` on `enum Shape` with `extension
 * ShapeInfo on Shape` (#2338). Another library's unnamed extension is out of
 * reach. Null when nothing in the hierarchy declares it.
 */
export function nearestDartMemberOfType(typeName: string, candidates: Node[], ref: UnresolvedRef, context: ResolutionContext): Node | null {
  if (candidates.length === 0) return null;
  const hierarchy = dartTypeHierarchy(typeName, context);
  let best: Node[] = [];
  let bestRank = Infinity;
  for (const m of candidates) {
    const cut = m.qualifiedName.lastIndexOf('::');
    if (cut <= 0) continue;
    const owner = m.qualifiedName.slice(0, cut).split('::').pop()!;
    let rank = hierarchy.get(owner) ?? Infinity;
    if (rank === Infinity) {
      if (m.filePath !== ref.filePath && isDartUnnamedExtensionMember(m, context)) continue;
      const decl = context.getNodesInFile(m.filePath)
        .find((n) => n.name === owner && DART_TYPE_KINDS.has(n.kind) && n.startLine <= m.startLine && n.endLine >= m.endLine);
      const head = decl ? dartHeadOf(decl, context) : null;
      if (head?.extension) {
        const on = Math.min(...head.supers.map((t) => hierarchy.get(t) ?? Infinity));
        if (on !== Infinity) rank = DART_EXTENSION_RANK + on;
      }
    }
    if (rank < bestRank) {
      bestRank = rank;
      best = [m];
    } else if (rank === bestRank && rank !== Infinity) {
      best.push(m);
    }
  }
  return best.length > 0 ? preferCallSiteFile(best, ref.filePath)[0]! : null;
}

/** Whether a Dart member node is a getter (`int get area => …`), read off its declaration line. */
function isDartGetter(n: Node, context: ResolutionContext): boolean {
  const line = (context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split(/\r?\n/) ?? [])[n.startLine - 1] ?? '';
  return new RegExp(`\\bget\\s+${n.name.replace(/\$/g, '\\$')}\\b`).test(line);
}

/**
 * A Dart getter read `receiver.member` (#2338) — emitted by the extractor as a
 * `references` ref. Resolved ONLY through the receiver's declared type onto a
 * getter of that type, a supertype, or an extension on either; a plain field
 * read, an untyped receiver, or a type that declares no such getter links
 * nothing (silent beats wrong — these refs must never reach the name-only
 * strategies).
 */
export function matchDartPropertyRead(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const dot = ref.referenceName.indexOf('.');
  const receiver = ref.referenceName.slice(0, dot);
  const member = ref.referenceName.slice(dot + 1);
  const getters = context.getNodesByName(member).filter((n) => n.language === 'dart' && isDartMember(n) && isDartGetter(n, context));
  if (getters.length === 0) return null;
  const typeName = inferLocalReceiverType(receiver, ref, context);
  if (!typeName || !/^[A-Z]/.test(typeName)) return null;
  const target = nearestDartMemberOfType(typeName, getters, ref, context);
  return target ? { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'instance-method' } : null;
}

/** A Dart getter-read ref's shape: `receiver.member`, both lowerCamel (see matchDartPropertyRead). */
export function isDartPropertyReadRef(ref: UnresolvedRef): boolean {
  return ref.language === 'dart' && ref.referenceKind === 'references' &&
    /^[a-z_$][A-Za-z0-9_$]*\.[a-z_$][A-Za-z0-9_$]*$/.test(ref.referenceName);
}

const DART_HEAD_WORDS: ReadonlySet<string> = new Set(['extends', 'with', 'implements', 'on']);

/**
 * A Dart type declaration's head, read from source up to its body: the
 * supertypes it names, and whether it is an `extension` (whose one supertype
 * is the type it extends). Comments and type arguments are dropped first, so
 * riverpod's `class $NotifierProviderElement< // … NotifierT extends
 * $Notifier<ValueT>, ValueT > extends $ClassProviderElement<…> with
 * ElementWithFuture<…>` reads as `extends $ClassProviderElement with
 * ElementWithFuture`, and `class A = B with C;` as its mixin application.
 */
function dartHeadOf(decl: Node, context: ResolutionContext): { supers: string[]; extension: boolean } {
  const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
  const text = lines
    .slice(decl.startLine - 1, Math.min(decl.endLine, decl.startLine + 40))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  let depth = 0;
  let flat = '';
  for (const ch of text) {
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (ch === '{' || ch === ';') break;
      flat += ch;
    }
  }
  const keyword = /\b(class|mixin|extension|enum)\b/.exec(flat);
  const head = keyword ? flat.slice(keyword.index) : flat;
  const clause = /(?:\b(?:extends|with|implements|on)\b|=)([\s\S]*)$/.exec(head)?.[1] ?? '';
  return {
    supers: [...clause.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]).filter((w) => !DART_HEAD_WORDS.has(w)),
    extension: keyword?.[1] === 'extension' && !/^extension\s+type\b/.test(head),
  };
}

/** The Dart `extension` declaration a class node stands for, read from its line: `named` false for `extension on X`. */
export function dartExtensionDecl(n: Node, context: ResolutionContext): { named: boolean } | null {
  if (n.language !== 'dart' || n.kind !== 'class') return null;
  const line = (context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split(/\r?\n/) ?? [])[n.startLine - 1] ?? '';
  if (!/^\s*extension\b(?!\s+type\b)/.test(line)) return null;
  return { named: !/^\s*extension\s+on\b/.test(line) };
}

/** Whether a Dart method belongs to an unnamed `extension on X`, visible only in its own library. */
export function isDartUnnamedExtensionMember(method: Node, context: ResolutionContext): boolean {
  if (method.language !== 'dart' || method.kind !== 'method') return false;
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut <= 0) return false;
  const ownerQn = method.qualifiedName.slice(0, cut);
  const owner = context.getNodesInFile(method.filePath).find((n) => n.qualifiedName === ownerQn && n.kind === 'class' &&
    n.startLine <= method.startLine && n.endLine >= method.startLine);
  return owner !== undefined && dartExtensionDecl(owner, context)?.named === false;
}
