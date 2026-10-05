/**
 * Swift scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolutionContext } from '../../types';
import { OBJC_SYSTEM_SUPERS } from './objc';
import { rustGoReceiverName } from './rust';
import { inferMemberReceiverType } from '../receiver-inference';
import { sharesReceiverWord } from '../strategies/fuzzy';

/**
 * How a Swift call is written: `bare` (implicit self, or a free function),
 * through `self.` / `super.`, or `chained` on some other receiver. The
 * extractor keeps one receiver level, so `super.init(…)`,
 * `axis.entries.removeAll()` and `min(a, b)` all arrive as bare names.
 */
export interface SwiftCallShape {
  shape: 'bare' | 'self' | 'super' | 'chained';
  /** A chained call's receiver, calls and subscripts dropped. */
  receiver: string;
  /** The first argument's label, if any. */
  label: string;
  /** `name[…]`: a subscript of a value, not a call. */
  subscript: boolean;
  /** `URLEncodedFormDecoder().decode(…)`: the type the link before the call constructs. */
  constructed?: string;
}

export function swiftCallShape(ref: UnresolvedRef, context: ResolutionContext): SwiftCallShape | null {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return null;
  const name = ref.referenceName;
  let start = line.startsWith(name, ref.column) && !/[\w$]/.test(line[ref.column - 1] ?? '') ? ref.column : -1;
  if (start < 0) {
    const m = new RegExp(`(?<![\\w$])${name}\\s*[({<[]`).exec(line);
    start = m ? m.index : -1;
  }
  if (start < 0) return null;
  const before = line.slice(0, start);
  const after = line.slice(start + name.length);
  const base = { receiver: '', label: '', subscript: /^\s*\[/.test(after) };
  if (!/\.\s*$/.test(before)) return { ...base, shape: 'bare' };
  // `self.m(` — not `self[i].m(` or `self.items.m(`, which are chains.
  const plain = /(?:^|[^\w$.)\]])(self|Self|super)\s*[?!]?\s*\.\s*$/.exec(before)?.[1];
  if (plain) return { ...base, shape: plain === 'super' ? 'super' : 'self' };
  return {
    ...base,
    shape: 'chained',
    receiver: rustGoReceiverName(before.replace(/[?!]\s*\./g, '.')),
    label: /^\s*\(\s*([A-Za-z_]\w*)\s*:(?!:)/.exec(after)?.[1] ?? '',
    constructed: /(?<![\w$.])([A-Z][\w$]*)\s*(?:<[^<>()]*>)?\s*\([^()]*\)\s*[?!]?\s*\.\s*$/.exec(before)?.[1],
  };
}

/** Argument labels the standard library's collection and string methods take. */
const SWIFT_STD_LABELS: ReadonlySet<string> = new Set([
  'contentsOf', 'where', 'by', 'at', 'keepingCapacity', 'separator', 'forKey', 'of', 'into', 'in', 'options',
  'maxSplits', 'omittingEmptySubsequences', 'with', 'after', 'before', 'upTo', 'through', 'offsetBy', 'default',
]);

/**
 * Whether a Swift method's declaration takes the argument label a call gives
 * first (`func contains(jpeg marker: JPEGMarker)` for `data.kf.contains(jpeg:
 * .SOF2)`). Labels are part of a Swift method's name, so one the standard
 * library's namesakes never take identifies the project's.
 */
function swiftDeclaresLabel(n: Node, label: string, context: ResolutionContext): boolean {
  if (label === '' || SWIFT_STD_LABELS.has(label)) return false;
  const lines = context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split(/\r?\n/) ?? [];
  const head = lines.slice(n.startLine - 1, n.startLine + 3).join(' ');
  return new RegExp(`\\bfunc\\s+${n.name}\\s*(?:<[^>]*>)?\\s*\\(\\s*${label}\\b`).test(head);
}

/**
 * What the standard library's collection types and protocols refine, so a
 * project extension of `Collection` is in reach of a type that conforms to
 * `RandomAccessCollection`. UIKit / AppKit ancestry comes from the
 * Objective-C table.
 */
const SWIFT_STD_SUPERS: Readonly<Record<string, readonly string[]>> = {
  RandomAccessCollection: ['BidirectionalCollection'], BidirectionalCollection: ['Collection'],
  MutableCollection: ['Collection'], RangeReplaceableCollection: ['Collection'], Collection: ['Sequence'],
  LazySequenceProtocol: ['Sequence'], LazyCollectionProtocol: ['Collection', 'LazySequenceProtocol'],
  StringProtocol: ['BidirectionalCollection'],
  Array: ['RandomAccessCollection', 'MutableCollection', 'RangeReplaceableCollection'],
  ArraySlice: ['RandomAccessCollection', 'MutableCollection', 'RangeReplaceableCollection'],
  ContiguousArray: ['RandomAccessCollection', 'MutableCollection', 'RangeReplaceableCollection'],
  String: ['StringProtocol', 'RangeReplaceableCollection'], Substring: ['StringProtocol', 'RangeReplaceableCollection'],
  Dictionary: ['Collection'], Set: ['Collection', 'SetAlgebra'], Range: ['RandomAccessCollection'],
  ClosedRange: ['RandomAccessCollection'],
};

/** Swift declarations a member hangs off: types, protocols, and extensions (extracted as classes). */
const SWIFT_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'enum', 'interface']);
const SWIFT_MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'field', 'enum_member']);
export const SWIFT_DECLS = new WeakMap<ResolutionContext, Map<string, { supers: string[]; projectType: boolean }>>();
export const SWIFT_HIERARCHIES = new WeakMap<ResolutionContext, WeakMap<UnresolvedRef, Map<string, number>>>();

/**
 * What the project declares a Swift type as: the supertypes and protocols
 * every declaration and extension of it names, and whether any of them is
 * the type itself rather than an extension of an outside one
 * (`extension Sequence`).
 */
export function swiftDeclOf(typeName: string, context: ResolutionContext): { supers: string[]; projectType: boolean } {
  let memo = SWIFT_DECLS.get(context);
  if (!memo) {
    memo = new Map();
    SWIFT_DECLS.set(context, memo);
  }
  const hit = memo.get(typeName);
  if (hit) return hit;
  const system = OBJC_SYSTEM_SUPERS[typeName];
  const info = { supers: [...(SWIFT_STD_SUPERS[typeName] ?? (system ? [system] : []))], projectType: false };
  for (const decl of context.getNodesByName(typeName)) {
    if (decl.language !== 'swift' || !SWIFT_TYPE_KINDS.has(decl.kind)) continue;
    const head = swiftHeadOf(decl, context);
    info.supers.push(...head.supers);
    if (!head.extension) info.projectType = true;
  }
  memo.set(typeName, info);
  return info;
}

/**
 * A Swift declaration's head, read up to its body with comments, attribute
 * arguments and generic parameters dropped: `@objc(ChartViewBase) open class
 * ChartViewBase<T>: NSUIView, ChartDataProvider where T: Equatable {` →
 * NSUIView, ChartDataProvider.
 */
function swiftHeadOf(decl: Node, context: ResolutionContext): { supers: string[]; extension: boolean } {
  const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
  const text = lines
    .slice(decl.startLine - 1, Math.min(decl.endLine, decl.startLine + 20))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  let depth = 0;
  let flat = '';
  for (const ch of text) {
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (ch === '{') break;
      flat += ch;
    }
  }
  const head = /\b(class|struct|enum|protocol|extension|actor)\s+[\w.]+\s*([\s\S]*)$/.exec(flat);
  if (!head) return { supers: [], extension: false };
  const clause = /^:([\s\S]*?)(?:\bwhere\b|$)/.exec(head[2]!.trim())?.[1] ?? '';
  return {
    supers: clause.split(',').map((item) => /([A-Za-z_]\w*)\s*$/.exec(item.trim())?.[1]).filter((w): w is string => !!w),
    extension: head[1] === 'extension',
  };
}

/** The Swift types around a call (depth 0) and what they inherit or conform to, by distance. */
function swiftHierarchyAt(ref: UnresolvedRef, context: ResolutionContext): Map<string, number> {
  let memo = SWIFT_HIERARCHIES.get(context);
  if (!memo) {
    memo = new WeakMap();
    SWIFT_HIERARCHIES.set(context, memo);
  }
  const hit = memo.get(ref);
  if (hit) return hit;
  const depths = new Map<string, number>();
  const queue: Array<[string, number]> = context
    .getNodesInFile(ref.filePath)
    .filter((n) => SWIFT_TYPE_KINDS.has(n.kind) && n.startLine <= ref.line && n.endLine >= ref.line)
    .map((n) => [n.name.split('.').pop()!, 0]);
  while (queue.length > 0 && depths.size < 40) {
    const [name, depth] = queue.shift()!;
    if (depths.has(name)) continue;
    depths.set(name, depth);
    for (const sup of swiftDeclOf(name, context).supers) queue.push([sup, depth + 1]);
  }
  memo.set(ref, depths);
  return depths;
}

/** A Swift type and every supertype and protocol the project says it has. */
function swiftTypeClosure(typeName: string, context: ResolutionContext): Set<string> {
  const seen = new Set<string>();
  const queue = [typeName];
  while (queue.length > 0 && seen.size < 40) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...swiftDeclOf(name, context).supers);
  }
  return seen;
}

/**
 * Of the in-scope members a bare / `self.` / `super.` Swift call could mean,
 * the nearest: the type's own, else its superclass's — Alamofire's
 * `self.cancel()` in a DownloadRequest extension is DownloadRequest's
 * override, not Request's.
 */
export function nearestSwiftMembers(candidates: Node[], ref: UnresolvedRef, context: ResolutionContext): Node[] {
  const hierarchy = swiftHierarchyAt(ref, context);
  const depthOf = (n: Node): number | undefined => {
    if (!SWIFT_MEMBER_KINDS.has(n.kind) && n.kind !== 'constant' && n.kind !== 'variable') return undefined;
    const cut = n.qualifiedName.lastIndexOf('::');
    return cut > 0 ? hierarchy.get(n.qualifiedName.slice(0, cut).split(/::|\./).pop()!) : undefined;
  };
  const depths = candidates.map(depthOf).filter((d): d is number => d !== undefined);
  if (depths.length < 2) return candidates;
  const nearest = Math.min(...depths);
  return candidates.filter((n) => {
    const d = depthOf(n);
    return d === undefined || d === nearest;
  });
}

/**
 * Methods of Swift's standard collections, strings and optionals and of
 * Foundation / UIKit views — names a project type rarely carries itself.
 * Ones it often does (`cancel`, `resume`, `store`, `validate`, `load`) are
 * left out: Alamofire's `request.resume()`, Kingfisher's `cache.store(…)`.
 */
const SWIFT_STD_METHODS: ReadonlySet<string> = new Set([
  'append', 'insert', 'remove', 'removeAll', 'removeFirst', 'removeLast', 'removeValue', 'contains', 'map',
  'compactMap', 'flatMap', 'filter', 'reduce', 'forEach', 'sorted', 'sort', 'first', 'last', 'min', 'max',
  'firstIndex', 'lastIndex', 'index', 'enumerated', 'reversed', 'joined', 'split', 'prefix', 'suffix',
  'dropFirst', 'dropLast', 'allSatisfy', 'randomElement', 'shuffled', 'popLast', 'replaceSubrange',
  'replacingOccurrences', 'components', 'trimmingCharacters', 'hasPrefix', 'hasSuffix', 'lowercased',
  'uppercased', 'appending', 'updateValue', 'merge', 'merging', 'union', 'intersection', 'subtracting',
  'formUnion', 'isEqual', 'addSubview', 'removeFromSuperview', 'setNeedsDisplay', 'setNeedsLayout',
  'layoutIfNeeded', 'addGestureRecognizer', 'addTarget', 'addObserver', 'removeObserver', 'eraseToAnyPublisher',
]);

/**
 * Whether a Swift file's declarations are visible from another file as far as
 * separate modules go: one under a `…Tests` directory (SwiftPM's
 * `Tests/VaporTests`, Xcode's `KingfisherTests`) or in a playground only from
 * inside it.
 */
function isSwiftTargetVisible(declFile: string, fromFile: string): boolean {
  const segments = declFile.split('/').slice(0, -1);
  const target = segments.findIndex((seg) => /Tests$|\.playground$/.test(seg));
  if (target < 0) return true;
  const prefix = segments.slice(0, target + 1).join('/') + '/';
  return fromFile.startsWith(prefix);
}

/**
 * Whether a Swift call of that shape can mean `n`. A member reached with no
 * receiver or through `self.` belongs to a type around the call or to what
 * it inherits or conforms to — `super.` to the latter only; top-level code
 * has no implicit self. Charts' `min(a, b)` went to a range type's `min`
 * field, `super.init(…)` to an Objective-C demo's `init` 170 times. A member
 * reached down a longer chain keeps its match unless its name is one the
 * standard types all carry: `axis.entries.removeAll()` is the array's, not
 * a chart data class's (unless the receiver names the owner, or the owner
 * is an outside type the project only extends).
 */
export function isSwiftCallTarget(n: Node, shape: SwiftCallShape | null, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (!shape) return true;
  // A global `let` / `var` from another file is subscripted, not called —
  // Charts' `min(a, b)` went to a playground page's `let min = 20.0`.
  if ((n.kind === 'constant' || n.kind === 'variable') && n.filePath !== ref.filePath && !shape.subscript) return false;
  // A test target imports the module it tests, never the reverse.
  if (!isSwiftTargetVisible(n.filePath, ref.filePath)) return false;
  const cut = n.qualifiedName.lastIndexOf('::');
  const owner = cut > 0 ? n.qualifiedName.slice(0, cut).split(/::|\./).pop()! : null;
  if (!SWIFT_MEMBER_KINDS.has(n.kind) && !(owner !== null && (n.kind === 'constant' || n.kind === 'variable'))) {
    if (n.kind !== 'function') return true;
    return shape.shape === 'bare' || owner !== null || (shape.shape === 'chained' && /^[A-Z]/.test(shape.receiver));
  }
  if (owner === null) return true;
  if (shape.shape === 'chained') {
    // A member of what the link before constructs, or of what that inherits:
    // vapor's `URLEncodedFormDecoder().decode(…)` is not a request's private
    // `_URLQueryContainer.decode`, `JSONDecoder().decode(…)` no project type's.
    // (A capitalized C function — realm's `RLMObjectBaseObjectSchema(obj)!` — constructs nothing.)
    if (shape.constructed && !context.getNodesByName(shape.constructed).some((f) => f.kind === 'function')) {
      return swiftTypeClosure(shape.constructed, context).has(owner);
    }
    // A property the type around the call declares with a type — Kingfisher's
    // `var cache: ImageCache!` — is that type: `cache.imageCachedType(…)` is
    // ImageCache's, not a test subclass's override.
    const typed = /^(?:self\.)?[A-Za-z_]\w*$/.test(shape.receiver) ? inferMemberReceiverType(shape.receiver, ref, context) : null;
    if (typed && /^[A-Z]/.test(typed)) return swiftTypeClosure(typed, context).has(owner);
    if (shape.receiver === '' || !SWIFT_STD_METHODS.has(n.name)) return true;
    return sharesReceiverWord(shape.receiver.split('.').pop()!, n) || !swiftDeclOf(owner, context).projectType ||
      swiftDeclaresLabel(n, shape.label, context);
  }
  const depth = swiftHierarchyAt(ref, context).get(owner);
  return depth !== undefined && (shape.shape !== 'super' || depth > 0);
}
