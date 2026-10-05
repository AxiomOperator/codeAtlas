/**
 * Standard-library method tables per language and the std-method receiver checks.
 *
 * Part of the name matcher (see ../name-matcher.ts).
 */

import { Node } from '../../types';
import { UnresolvedRef, ResolutionContext } from '../types';
import { sharesReceiverWord, splitCamelCase } from './strategies/fuzzy';

/**
 * Kotlin's scope functions and standard collection / string / conversion
 * methods: on an untyped chain link (`builder.apply { … }`, `list.map { … }`)
 * they are the standard library's, never a project type's same-named member.
 * Names project types commonly carry (`get`, `write`, `close`, `add`) are left
 * out — okio's `sink.write(…)` is its own Buffer's.
 */
export const KOTLIN_STD_METHODS: ReadonlySet<string> = new Set([
  'apply', 'also', 'let', 'run', 'takeIf', 'takeUnless', 'toString', 'equals', 'hashCode', 'map', 'mapNotNull',
  'mapIndexed', 'filter', 'filterNot', 'filterIsInstance', 'forEach', 'forEachIndexed', 'first', 'firstOrNull',
  'last', 'lastOrNull', 'single', 'singleOrNull', 'isEmpty', 'isNotEmpty', 'isNullOrEmpty', 'isNullOrBlank',
  'isBlank', 'isNotBlank', 'orEmpty', 'joinToString', 'toList', 'toMutableList', 'toSet', 'toMutableSet', 'toMap',
  'toTypedArray', 'any', 'all', 'none', 'count', 'sumOf', 'maxOf', 'minOf', 'maxOrNull', 'minOrNull', 'sortedBy',
  'sortedByDescending', 'sorted', 'sortedWith', 'reversed', 'drop', 'dropLast', 'take', 'takeLast', 'zip',
  'flatMap', 'flatten', 'distinct', 'groupBy', 'associate', 'associateBy', 'associateWith', 'partition',
  'contains', 'containsKey', 'getOrElse', 'getOrNull', 'getOrPut', 'getOrDefault', 'trim', 'trimEnd', 'trimStart',
  'split', 'substring', 'startsWith', 'endsWith', 'replace', 'lowercase', 'uppercase', 'toInt', 'toLong',
  'toDouble', 'toFloat', 'toIntOrNull', 'toLongOrNull', 'encodeToByteArray', 'decodeToString',
  'copyOf', 'copyOfRange', 'indexOf', 'lastIndexOf', 'withIndex', 'asSequence', 'asList', 'ifEmpty', 'ifBlank',
  'padStart', 'padEnd', 'repeat', 'lines', 'toCharArray', 'coerceAtLeast', 'coerceAtMost', 'coerceIn',
]);

/**
 * Methods of .NET's base types, collections, streams, strings, LINQ and
 * reflection — names a project type overrides or wraps, which a call through
 * an untyped receiver means only when the receiver is named after the owner.
 * Newtonsoft's `reader.Value.ToString()` went to its JValue's `ToString`,
 * `table.Columns.Add(…)` to a name table's `Add`.
 */
const CSHARP_STD_METHODS: ReadonlySet<string> = new Set([
  'ToString', 'Equals', 'GetHashCode', 'GetType', 'CompareTo', 'Add', 'AddRange', 'Remove', 'RemoveAt', 'RemoveAll',
  'Contains', 'ContainsKey', 'ContainsValue', 'Clear', 'Insert', 'IndexOf', 'CopyTo', 'ToArray', 'ToList',
  'ToDictionary', 'GetEnumerator', 'MoveNext', 'Reset', 'TryGetValue', 'GetValueOrDefault', 'TryAdd', 'Write',
  'WriteLine', 'WriteAsync', 'WriteLineAsync', 'Read', 'ReadAsync', 'ReadLine', 'ReadToEnd', 'Flush', 'FlushAsync',
  'Close', 'Dispose', 'DisposeAsync', 'Parse', 'TryParse', 'Format', 'Join', 'Split', 'Replace', 'Substring', 'Trim',
  'TrimStart', 'TrimEnd', 'StartsWith', 'EndsWith', 'ToUpper', 'ToLower', 'ToUpperInvariant', 'ToLowerInvariant',
  'Select', 'Where', 'First', 'FirstOrDefault', 'Single', 'SingleOrDefault', 'Last', 'LastOrDefault', 'Any', 'All',
  'Count', 'Sum', 'Max', 'Min', 'OrderBy', 'OrderByDescending', 'GroupBy', 'Skip', 'Take', 'Distinct', 'Concat',
  'Cast', 'OfType', 'Aggregate', 'Invoke', 'DynamicInvoke', 'GetMethod', 'GetProperty', 'GetField', 'GetConstructor',
  'GetCustomAttributes', 'GetGenericArguments', 'MakeGenericType', 'IsAssignableFrom', 'ConfigureAwait', 'Wait',
  'ContinueWith', 'Append', 'AppendLine', 'Peek', 'Push', 'Pop', 'Enqueue', 'Dequeue', 'HasFlag', 'Find', 'FindAll',
  'ForEach', 'Sort', 'Reverse', 'Clone', 'Seek', 'SetLength',
]);

/** The same .NET names as VB.NET writes them — in any case. */
const VBNET_STD_METHODS: ReadonlySet<string> = new Set([...CSHARP_STD_METHODS].map((m) => m.toLowerCase()));

/**
 * A request handler the web framework dispatches to: a Django / DRF / Flask
 * view's `get` / `post` / …, a controller's `index` / `store` / `update` /
 * `destroy`. Nothing calls one through an instance by name, so a guess from
 * a Django test's `client.post(…)` (allauth: 425 times on a
 * ClientRegistrationView) or an Eloquent `$page->update(…)` is never one.
 */
export const DISPATCHED_OWNER = /(?:View|ViewSet|APIView|Controller|Endpoint|ViewMixin)$/;
export const DISPATCHED_ACTIONS: ReadonlySet<string> = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'index', 'show', 'store', 'update', 'destroy',
  'create', 'edit', 'list', 'retrieve', 'partial_update',
]);

/** A test double's name: Fake…, Mock…, Stub…, Dummy…, Spy…, …Fake, …Mock, …Stub. */
export const TEST_DOUBLE_OWNER = /\b(?:fake|mock|mocked|stub|dummy|spy)\b/i;

/** A method of a test double (`MockedResponse`, `_FakeHTTPResponse`) the receiver and the calling file never name. */
export function isUnnamedTestDouble(method: Node, receiver: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut <= 0) return false;
  const owner = method.qualifiedName.slice(0, cut).split(/::|\./).pop()!;
  if (!TEST_DOUBLE_OWNER.test(splitCamelCase(owner).join(' '))) return false;
  if (splitCamelCase(receiverLink(receiver)).some((w) => TEST_DOUBLE_OWNER.test(w))) return false;
  return !(context.readFile(ref.filePath) ?? '').includes(owner);
}

/**
 * The link of a dotted receiver its value is named after: the last, or for a
 * constant (`InitializationPhase.CONTROLLERS`, `Foo.INSTANCE`) the type it
 * belongs to.
 */
export function receiverLink(receiver: string): string {
  const links = receiver.split('.');
  const last = links[links.length - 1]!;
  return links.length > 1 && /^[A-Z][A-Z0-9_]+$/.test(last) ? links[links.length - 2]! : last;
}

/** The standard-library method names of a language whose receiver-less guesses need the receiver to name the owner. */
function stdMethodNames(language: string): ReadonlySet<string> | null {
  switch (language) {
    case 'go': return GO_STD_METHODS;
    case 'rust': return RUST_STD_METHODS;
    case 'kotlin': return KOTLIN_STD_METHODS;
    case 'csharp': return CSHARP_STD_METHODS;
    case 'vbnet': return VBNET_STD_METHODS;
    case 'dart': return DART_STD_METHODS;
    default: return null;
  }
}

/** Whether `name` is one of `language`'s standard-library method names (VB.NET's in any case). */
export function isStdMethodName(language: string, name: string): boolean {
  return stdMethodNames(language)?.has(language === 'vbnet' ? name.toLowerCase() : name) ?? false;
}

/** Methods of Dart's String, List, Iterable, Map and Set — names a project type rarely carries itself. */
const DART_STD_METHODS: ReadonlySet<string> = new Set([
  'endsWith', 'startsWith', 'contains', 'split', 'substring', 'trim', 'trimLeft', 'trimRight', 'toLowerCase',
  'toUpperCase', 'replaceAll', 'replaceFirst', 'replaceRange', 'indexOf', 'lastIndexOf', 'padLeft', 'padRight',
  'codeUnitAt', 'allMatches', 'firstMatch', 'hasMatch', 'addAll', 'removeAt', 'removeWhere', 'removeLast',
  'retainWhere', 'insertAll', 'where', 'whereType', 'forEach', 'toList', 'toSet', 'join', 'reduce', 'fold',
  'any', 'every', 'firstWhere', 'lastWhere', 'singleWhere', 'containsKey', 'containsValue', 'putIfAbsent',
  'sublist', 'take', 'takeWhile', 'skip', 'skipWhile', 'expand', 'cast', 'compareTo', 'elementAt', 'followedBy',
  'asMap', 'getRange', 'setAll', 'fillRange', 'shuffle', 'sort', 'indexWhere', 'lastIndexWhere',
]);

/**
 * Whether a receiver is named after the owner of `method` — for a Dart
 * extension, after the type it is `on`: getx's `ext.endsWith(".avi")` on a
 * String shares a word with `RxStringExt`, none with its `Rx<String>`.
 */
export function receiverNamesOwner(receiver: string, method: Node, context: ResolutionContext): boolean {
  if (method.language === 'dart') {
    const cut = method.qualifiedName.lastIndexOf('::');
    const owner = cut > 0 ? method.qualifiedName.slice(0, cut).split('::').pop()! : '';
    const decl = owner ? context.getNodesByName(owner).find((n) => n.language === 'dart' && n.filePath === method.filePath) : undefined;
    const line = decl ? (context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [])[decl.startLine - 1] ?? '' : '';
    const on = /\bextension\s+\w*\s*(?:<[^>]*>)?\s*on\s+([\w<>, ?]+?)\s*\{/.exec(line)?.[1];
    if (on) return sharesReceiverWord(receiver, { ...method, qualifiedName: `${on.replace(/[<>, ?]+/g, '')}::${method.name}` });
  }
  return sharesReceiverWord(receiver, method);
}

/**
 * Methods of Rust's Option / Result / iterators / collections / strings /
 * smart pointers — names a project type rarely carries itself. Ones it often
 * does (`get`, `set`, `insert`, `next`, `call`, `read`) are left out: serde's
 * `Attr::set`, clap's own `get`.
 */
export const RUST_STD_METHODS: ReadonlySet<string> = new Set([
  'unwrap', 'unwrap_or', 'unwrap_or_else', 'unwrap_or_default', 'unwrap_err', 'unwrap_unchecked', 'expect',
  'expect_err', 'ok', 'err', 'map', 'map_err', 'map_or', 'map_or_else', 'and_then', 'or_else', 'ok_or',
  'ok_or_else', 'is_some', 'is_none', 'is_ok', 'is_err', 'is_some_and', 'as_ref', 'as_mut', 'as_deref', 'clone',
  'cloned', 'copied', 'iter', 'iter_mut', 'into_iter', 'collect', 'enumerate', 'zip', 'rev', 'chain', 'skip',
  'step_by', 'peekable', 'flat_map', 'filter_map', 'flatten', 'any', 'all', 'len', 'is_empty', 'push', 'push_str',
  'pop', 'extend', 'drain', 'clear', 'retain', 'truncate', 'reserve', 'with_capacity', 'capacity', 'sort',
  'sort_by', 'sort_by_key', 'dedup', 'split_off', 'contains_key', 'to_string', 'to_owned', 'to_vec', 'as_str',
  'as_bytes', 'as_slice', 'as_ptr', 'into', 'try_into', 'borrow', 'borrow_mut', 'deref', 'deref_mut', 'chars',
  'bytes', 'lines', 'starts_with', 'ends_with', 'trim', 'to_lowercase', 'to_uppercase', 'windows', 'chunks',
  'then', 'then_some', 'eq', 'cmp', 'partial_cmp', 'read_to_end', 'read_to_string', 'fetch_add', 'fetch_sub',
  // std::process::Command's pipes and the assert_cmd assertions tests chain
  // onto it (not `arg` / `env`, which clap's own builders carry)
  'current_dir', 'stdout', 'stderr', 'stdin', 'success', 'failure',
]);

/**
 * Methods of Go's standard types and interfaces — `fmt.Stringer`, `error`,
 * `http.ResponseWriter`, `sync` locks, `reflect`, `time`. Ones a project type
 * often carries itself (`Get`, `Set`, `Close`, `Value`, `Next`) are left out:
 * gin's `c.Set(…)` is its Context's.
 */
export const GO_STD_METHODS: ReadonlySet<string> = new Set([
  'String', 'Error', 'Unwrap', 'Is', 'As', 'Header', 'WriteHeader', 'WriteString', 'Lock', 'Unlock', 'RLock',
  'RUnlock', 'Err', 'Deadline', 'Int', 'Bool', 'Float64', 'Int64', 'Uint64', 'Bytes', 'Len', 'Cap', 'Seconds',
  'Unix', 'Before', 'After', 'Equal', 'IsNil', 'IsValid', 'Elem', 'NumField', 'Interface', 'Kind',
]);
