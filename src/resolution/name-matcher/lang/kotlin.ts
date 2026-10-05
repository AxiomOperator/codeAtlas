/**
 * Kotlin scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolutionContext } from '../../types';
import { blankStringContents, stripCommentsForRegex } from '../../strip-comments';
import { splitCppTopLevel } from './c-cpp';
import { rustGoReceiverName } from './rust';
import { MEMBER_CLASS_KINDS, classHeadSupertypes } from '../receiver-inference';
import { sharesReceiverWord } from '../strategies/fuzzy';
import { isMethodOwnerKind } from '../strategies/qualified';

/** The receiver a Kotlin chain link `….name(` / `?.name {` is written on, or null for a call with none. */
export function kotlinChainReceiver(ref: UnresolvedRef, context: ResolutionContext): string | null {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return null;
  const name = ref.referenceName;
  let start = line.startsWith(name, ref.column) ? ref.column : -1;
  if (start < 0) {
    const m = new RegExp(`(?<![\\w$])${name}\\s*[({]`).exec(line);
    start = m ? m.index : -1;
  }
  if (start < 0) {
    // An infix call on an expression — `alias(libs.x) apply false` — whose
    // receiver the extractor could not name.
    const infix = new RegExp(`(?<=[\\w)\\]"'}]\\s+)${name}\\s+(?=[^\\s=])`).exec(line);
    return infix ? rustGoReceiverName(line.slice(0, infix.index).trimEnd()) : null;
  }
  const before = line.slice(0, start);
  if (!/\.\s*$/.test(before)) return null;
  return rustGoReceiverName(before.replace(/\?\s*\.\s*$/, '').replace(/!!\s*$/, ''));
}

const KOTLIN_BITWISE_INFIX: ReadonlySet<string> = new Set(['and', 'or', 'xor', 'shl', 'shr', 'ushr', 'inv']);
const KOTLIN_NUMBER_TYPES: ReadonlySet<string> = new Set(['Byte', 'Short', 'Int', 'Long', 'UByte', 'UShort', 'UInt', 'ULong', 'Char']);

/**
 * A project's bitwise extension on a number type — okio's `infix fun
 * Byte.and(mask: Int)` — is indistinguishable, without the operand's type,
 * from the standard library's own `Int.and` / `Long.shr` members every other
 * `x and 0xff` / `h shr 8` calls; neither is a safe edge.
 */
export function isKotlinNumberBitwise(n: Node, ref: UnresolvedRef): boolean {
  if (ref.language !== 'kotlin' || !KOTLIN_BITWISE_INFIX.has(n.name)) return false;
  const cut = n.qualifiedName.lastIndexOf('::');
  return cut > 0 && KOTLIN_NUMBER_TYPES.has(n.qualifiedName.slice(0, cut).split(/::|\./).pop()!);
}

/** Whether a bare Kotlin name is written with no receiver at its call — not a later link of a chain (`….name(`). */
export function isReceiverLessKotlinCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return false;
  const name = ref.referenceName;
  let start = line.startsWith(name, ref.column) && !/[\w$]/.test(line[ref.column - 1] ?? '') ? ref.column : -1;
  if (start < 0) {
    const m = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}\\s*[({<]`).exec(line);
    start = m ? m.index : -1;
  }
  return start >= 0 && !/[.:]\s*$/.test(line.slice(0, start));
}

/**
 * Whether a bare `require(…)` / `check(…)` / `assert(…)` is Kotlin's
 * precondition: its condition is a comparison or boolean expression, or a
 * lazy message follows it.
 */
function isKotlinPreconditionCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (!/^(?:require|check|assert)$/.test(ref.referenceName)) return false;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  const at = line ? new RegExp(`(?<![\\w.])${ref.referenceName}\\s*\\(`).exec(line) : null;
  if (!line || !at) return false;
  let depth = 0;
  let args = '';
  let rest = '';
  for (let i = at.index + at[0].length; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '(') depth++;
    else if (ch === ')' && depth-- === 0) {
      rest = line.slice(i + 1);
      break;
    }
    args += ch;
  }
  return /[<>=!]=|&&|\|\||(?:^|[\s(])!|\s[<>]\s|\bis\b|\bin\b|\btrue\b|\bfalse\b/.test(args) || /^\s*\{/.test(rest);
}

export const KOTLIN_RECEIVER_TYPES = new WeakMap<ResolutionContext, Set<string>>();

/**
 * Every type a Kotlin function type in the project takes as its receiver —
 * `Module` in `typealias ModuleDeclaration = Module.() -> Unit`, `Scope` in
 * `Scope.(ParametersHolder) -> T`, `JdbcTransaction` in `statement:
 * JdbcTransaction.(TestDB) -> Unit`. A lambda of such a type runs with that
 * receiver, so a bare call inside one reaches its members.
 */
function kotlinReceiverTypes(context: ResolutionContext): Set<string> {
  const hit = KOTLIN_RECEIVER_TYPES.get(context);
  if (hit) return hit;
  const types = new Set<string>();
  const outside = new Set<string>();
  for (const file of context.getAllFiles()) {
    if (!/\.kts?$/.test(file)) continue;
    const source = stripCommentsForRegex(context.readFile(file) ?? '', 'java');
    for (const m of source.matchAll(/\b([A-Z]\w*)(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\s*\.\s*\(/g)) types.add(m[1]!);
    // An extension on a type from outside the project (`fun
    // MacrobenchmarkScope.waitForContent()`, `fun StringBuilder.padInt(…)`)
    // is written to be called inside that library's lambdas.
    for (const m of source.matchAll(/\bfun\s+(?:<[^>]*>\s*)?([A-Z]\w*(?:\.[A-Z]\w*)*)(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\??\.[A-Za-z_`][\w`]*\s*\(/g)) {
      for (const part of m[1]!.split('.')) outside.add(part);
    }
  }
  for (const name of outside) {
    if (!context.getNodesByName(name).some((n) => MEMBER_CLASS_KINDS.has(n.kind) && (n.language === 'kotlin' || n.language === 'java'))) types.add(name);
  }
  // A receiver's members include those it inherits: Exposed's `mergeFrom`
  // body runs on a MergeTableStatement, whose `whenMatchedDelete` is
  // MergeStatement's.
  const queue = [...types];
  while (queue.length > 0 && types.size < 5000) {
    const name = queue.shift()!;
    for (const decl of context.getNodesByName(name)) {
      if (decl.language !== 'kotlin' || !MEMBER_CLASS_KINDS.has(decl.kind)) continue;
      for (const sup of classHeadSupertypes(decl, context)) {
        if (!types.has(sup)) {
          types.add(sup);
          queue.push(sup);
        }
      }
    }
  }
  KOTLIN_RECEIVER_TYPES.set(context, types);
  return types;
}

/**
 * What the Android framework and AndroidX classes a Kotlin class commonly
 * extends inherit, so an extension on `ComponentCallbacks` or
 * `ComponentActivity` is in reach of an `AppCompatActivity` subclass.
 */
const KOTLIN_PLATFORM_SUPERS: Readonly<Record<string, readonly string[]>> = {
  AppCompatActivity: ['FragmentActivity'], FragmentActivity: ['ComponentActivity'],
  ComponentActivity: ['Activity', 'LifecycleOwner', 'ViewModelStoreOwner', 'SavedStateRegistryOwner'],
  Activity: ['ContextThemeWrapper', 'ComponentCallbacks2'], ContextThemeWrapper: ['ContextWrapper'],
  ContextWrapper: ['Context'], Application: ['ContextWrapper', 'ComponentCallbacks2'],
  Service: ['ContextWrapper', 'ComponentCallbacks2'], ComponentCallbacks2: ['ComponentCallbacks'],
  Fragment: ['ComponentCallbacks', 'LifecycleOwner', 'ViewModelStoreOwner', 'SavedStateRegistryOwner'],
  DialogFragment: ['Fragment'], AppCompatDialogFragment: ['DialogFragment'],
  BottomSheetDialogFragment: ['AppCompatDialogFragment'], AndroidViewModel: ['ViewModel'],
};

export const KOTLIN_HIERARCHIES = new WeakMap<ResolutionContext, WeakMap<UnresolvedRef, Set<string>>>();

/**
 * The Kotlin types a bare call is written inside — the classes and objects
 * around it and the receiver of the extension function it is in — and what
 * they inherit.
 */
function kotlinHierarchyAt(ref: UnresolvedRef, context: ResolutionContext): Set<string> {
  let memo = KOTLIN_HIERARCHIES.get(context);
  if (!memo) {
    memo = new WeakMap();
    KOTLIN_HIERARCHIES.set(context, memo);
  }
  const hit = memo.get(ref);
  if (hit) return hit;
  const queue: string[] = [];
  for (const n of context.getNodesInFile(ref.filePath)) {
    if (n.startLine > ref.line || n.endLine < ref.line) continue;
    if (MEMBER_CLASS_KINDS.has(n.kind)) queue.push(n.name);
    // `fun Foo.bar() { baz() }`: Foo is the implicit receiver.
    else if ((n.kind === 'method' || n.kind === 'function') && n.qualifiedName.includes('::')) {
      queue.push(n.qualifiedName.slice(0, n.qualifiedName.lastIndexOf('::')).split(/::|\./).pop()!);
    }
  }
  // A Gradle build script runs on the Project (a settings script on Settings).
  if (ref.filePath.endsWith('.gradle.kts')) queue.push(/(?:^|\/)settings\.gradle\.kts$/.test(ref.filePath) ? 'Settings' : 'Project');
  // The same read from the source's braces, which also sees an anonymous
  // `object : Table("t") { … }` and survives a class the parser lost.
  for (const frame of kotlinBraceFrames(ref.filePath, context)) {
    if (frame.start <= ref.line && frame.end >= ref.line) queue.push(...frame.names);
  }
  const names = new Set<string>();
  while (queue.length > 0 && names.size < 60) {
    const name = queue.shift()!;
    if (names.has(name)) continue;
    names.add(name);
    queue.push(...(KOTLIN_PLATFORM_SUPERS[name] ?? []));
    for (const decl of context.getNodesByName(name)) {
      if (decl.language === 'kotlin' && MEMBER_CLASS_KINDS.has(decl.kind)) queue.push(...classHeadSupertypes(decl, context));
    }
  }
  memo.set(ref, names);
  return names;
}

export const KOTLIN_FRAMES = new WeakMap<ResolutionContext, Map<string, Array<{ start: number; end: number; names: string[] }>>>();

/**
 * The type bodies of a Kotlin file by line range, read from its braces: each
 * `class` / `object` / `interface` body with its name and supertypes, an
 * anonymous `object : Base(…)` with its base, and an extension function's
 * body with its receiver type.
 */
function kotlinBraceFrames(file: string, context: ResolutionContext): Array<{ start: number; end: number; names: string[] }> {
  let memo = KOTLIN_FRAMES.get(context);
  if (!memo) {
    memo = new Map();
    KOTLIN_FRAMES.set(context, memo);
  }
  const hit = memo.get(file);
  if (hit) return hit;
  const frames: Array<{ start: number; end: number; names: string[] }> = [];
  const source = blankStringContents(stripCommentsForRegex(context.readFile(file) ?? '', 'java'));
  const stack: Array<{ start: number; names: string[] | null }> = [];
  let line = 1;
  let pending = '';
  for (const ch of source) {
    if (ch === '\n') line++;
    if (ch === '{') {
      // `with(x) {`, `x.apply {`, `x.run {`: a receiver of whatever type x is.
      const scoped = /(?:\bwith\s*\([^{}]*\)|\.\s*(?:apply|run)(?:\s*<[^<>]*>)?)\s*$/.test(pending);
      let names = scoped ? ['*'] : kotlinHeadNames(pending);
      // `single { get() }`: a lambda runs on the receiver its function's parameter type names.
      if (!scoped && (!names || names.length === 0)) {
        const call = /(?:^|[^\w$])([a-z_]\w*)\s*(?:<[^<>{}]*>)?\s*(?:\([^(){}]*\))?\s*$/.exec(pending)?.[1];
        const receiver = call && !KOTLIN_BLOCK_WORDS.has(call) ? kotlinLambdaReceiver(call, context) : null;
        if (receiver) names = [receiver];
      }
      stack.push({ start: line, names });
      pending = '';
    } else if (ch === '}') {
      const open = stack.pop();
      if (open?.names && open.names.length > 0) frames.push({ start: open.start, end: line, names: open.names });
      pending = '';
    } else if (ch === ';') pending = '';
    else if (pending.length < 600) pending += ch;
    else pending = pending.slice(300) + ch;
  }
  memo.set(file, frames);
  return frames;
}

/** Words before a `{` that open a block, not a lambda argument. */
const KOTLIN_BLOCK_WORDS: ReadonlySet<string> = new Set([
  'if', 'else', 'for', 'while', 'do', 'when', 'try', 'catch', 'finally', 'init', 'get', 'set', 'constructor',
  'fun', 'class', 'object', 'interface', 'return', 'by', 'lazy', 'apply', 'run', 'also', 'let', 'with', 'use',
]);

export const KOTLIN_LAMBDA_RECEIVERS = new WeakMap<ResolutionContext, Map<string, string | null>>();

/**
 * The receiver a lambda passed to the project's `name` runs with: the type
 * before `.(` in its last parameter's function type, directly or through a
 * typealias — koin's `single(…, definition: Definition<T>)` with `typealias
 * Definition<T> = Scope.(ParametersHolder) -> T` runs its lambda on a Scope.
 * Null unless every `name` agrees.
 */
function kotlinLambdaReceiver(name: string, context: ResolutionContext): string | null {
  let memo = KOTLIN_LAMBDA_RECEIVERS.get(context);
  if (!memo) KOTLIN_LAMBDA_RECEIVERS.set(context, (memo = new Map()));
  if (memo.has(name)) return memo.get(name)!;
  const receiverOf = (type: string, depth: number): string | null => {
    const direct = /^\s*(?:suspend\s+)?([A-Z]\w*)(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?\s*\.\s*\(/.exec(type);
    if (direct) return direct[1]!;
    const alias = /^\s*([A-Z]\w*)\b/.exec(type)?.[1];
    if (!alias || depth > 2) return null;
    for (const decl of context.getNodesByName(alias)) {
      if (decl.language !== 'kotlin' || decl.kind !== 'type_alias') continue;
      const text = (context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [])[decl.startLine - 1] ?? '';
      const rhs = /=\s*(.+)$/.exec(text)?.[1];
      if (rhs) return receiverOf(rhs, depth + 1);
    }
    return null;
  };
  const found = new Set<string>();
  for (const fn of context.getNodesByName(name)) {
    if (fn.language !== 'kotlin' || (fn.kind !== 'function' && fn.kind !== 'method')) continue;
    const lines = context.getFileLines?.(fn.filePath) ?? context.readFile(fn.filePath)?.split(/\r?\n/) ?? [];
    const head = lines.slice(fn.startLine - 1, fn.startLine + 11).join(' ');
    const open = head.search(new RegExp(`\\b${name}\\s*\\(`));
    if (open < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = head.indexOf('(', open); i < head.length; i++) {
      if (head[i] === '(') depth++;
      else if (head[i] === ')' && --depth === 0) { end = i; break; }
    }
    if (end < 0) continue;
    const params = splitCppTopLevel(head.slice(head.indexOf('(', open) + 1, end));
    const last = params[params.length - 1];
    const type = last ? /:\s*([\s\S]+?)(?:\s*=\s*[^=>][\s\S]*)?$/.exec(last.replace(/^\s*(?:noinline|crossinline)\s+/, ''))?.[1] : undefined;
    const receiver = type ? receiverOf(type, 0) : null;
    if (receiver) found.add(receiver);
  }
  const result = found.size === 1 ? [...found][0]! : null;
  memo.set(name, result);
  return result;
}

/** The type names a Kotlin block head introduces: a type declaration's name and supertypes, or an extension function's receiver. */
function kotlinHeadNames(head: string): string[] | null {
  let depth = 0;
  let flat = '';
  for (const ch of head) {
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) flat += ch;
  }
  const decl = /\b(?:class|interface|object)\b(?:\s+([A-Za-z_]\w*))?([^=]*)$/.exec(flat);
  if (decl) {
    const supers = /:\s*([\s\S]*)$/.exec(decl[2] ?? '')?.[1] ?? '';
    const names = [...supers.replace(/\bwhere\b[\s\S]*$/, '').matchAll(/([A-Z]\w*)\s*(?=,|$|\bby\b)/g)].map((m) => m[1]!);
    return decl[1] ? [decl[1], ...names] : names;
  }
  const receiver = /\bfun\s+(?:<[^>]*>\s*)?([A-Z]\w*)(?:<[^>]*>)?\??\.[A-Za-z_]\w*\s*\(/.exec(head)?.[1];
  return receiver ? [receiver] : null;
}

/**
 * Whether a bare Kotlin call can reach method `n`: a member of a type around
 * the call or of what it inherits, or of a type the project's function types
 * take as a lambda receiver (a DSL). koin's `error("…")` — Kotlin's — went to
 * a Logger's `error`, and `module { … }` in one test to another test class's
 * private `module`.
 */
export function isKotlinMemberReachable(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  // A Gradle script's bare calls — `plugins { }`, `dependencies { }`,
  // `api(projects.core)` — run on the build tool's own types: never a member
  // of a class the project declares (nowinandroid's `Graph.plugins()`, a lint
  // registry's `api` property). Build logic's extensions on Gradle's types
  // (`NamedDomainObjectContainer.createSourceSet(…)`) stay.
  if (ref.filePath.endsWith('.kts')) {
    if (n.kind !== 'method' && n.kind !== 'field' && n.kind !== 'property') return true;
    const cut = n.qualifiedName.lastIndexOf('::');
    const owner = cut > 0 ? n.qualifiedName.slice(0, cut).split(/::|\./).pop()! : '';
    return owner !== '' && !context.getNodesByName(owner).some((c) => isMethodOwnerKind(c) || c.kind === 'module');
  }
  // A Java class's method, too: Kotlin calls it bare only from a subclass or through a static import.
  if (n.kind !== 'method' || (n.language !== 'kotlin' && n.language !== 'java')) return true;
  // `require(n >= 0) { … }`, `check(!closed)`: Kotlin's preconditions, not a
  // member `require(byteCount: Long)` of the type around the call.
  if (isKotlinPreconditionCall(ref, context)) return false;
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut <= 0) return true;
  const path = n.qualifiedName.slice(0, cut).split(/::|\./);
  let owner = path.pop()!;
  const companion = owner === 'Companion' && path.length > 0;
  if (companion) owner = path.pop()!;
  // A (Java) constructor is the type's, called by its name.
  if (n.name === owner) return true;
  const hierarchy = kotlinHierarchyAt(ref, context);
  if (hierarchy.has('*') || kotlinReceiverTypes(context).has(owner) || hierarchy.has(owner)) return true;
  // `import okio.TestUtil.deepCopy` / `import okio.TestUtil.*` names an object's members.
  const pkg = kotlinFileScope(n.filePath, context).pkg;
  const objectPath = (pkg ? `${pkg}.${owner}` : owner) + (companion ? '.Companion' : '');
  const here = kotlinFileScope(ref.filePath, context);
  return here.imports.has(`${objectPath}.${n.name}`) || here.stars.has(objectPath);
}

/**
 * Of the members a bare Kotlin call can reach, the ones the code around it
 * reaches — its class, an extension's receiver, the lambda it is in — before
 * those only a lambda type somewhere in the project could: koin's `get()` in
 * `Scope.new(…)` is Scope's, not Koin's.
 */
export function lexicalKotlinMembers(candidates: Node[], ref: UnresolvedRef, context: ResolutionContext): Node[] {
  if (candidates.length < 2) return candidates;
  const hierarchy = kotlinHierarchyAt(ref, context);
  if (hierarchy.has('*')) return candidates;
  const lexical = candidates.filter((n) => {
    if (n.kind !== 'method') return false;
    const path = n.qualifiedName.slice(0, Math.max(0, n.qualifiedName.lastIndexOf('::'))).split(/::|\./);
    let owner = path.pop() ?? '';
    if (owner === 'Companion') owner = path.pop() ?? '';
    return hierarchy.has(owner);
  });
  return lexical.length > 0 ? lexical : candidates;
}

/** Whether a standard-named Kotlin chain link can mean `n`: only through a receiver named after its owner. */
export function isKotlinStdChainTarget(n: Node, receiver: string): boolean {
  if (n.kind !== 'method' && n.kind !== 'function') return true;
  return receiver === 'this' || (receiver !== '' && sharesReceiverWord(receiver, n));
}

export const KOTLIN_FILE_SCOPES = new WeakMap<ResolutionContext, Map<string, { pkg: string; imports: Set<string>; stars: Set<string> }>>();
/** Packages every Kotlin file imports without writing it. */
const KOTLIN_DEFAULT_IMPORTS: ReadonlySet<string> = new Set([
  'kotlin', 'kotlin.annotation', 'kotlin.collections', 'kotlin.comparisons', 'kotlin.io', 'kotlin.ranges',
  'kotlin.sequences', 'kotlin.text', 'kotlin.jvm', 'java.lang', 'kotlin.js',
]);
const KOTLIN_ENCLOSING_KINDS: ReadonlySet<string> = new Set([
  'class', 'interface', 'enum', 'struct', 'trait', 'protocol', 'module', 'namespace', 'function', 'method',
]);

/** A Kotlin file's `package` and the names and packages its `import`s bring in. */
function kotlinFileScope(file: string, context: ResolutionContext): { pkg: string; imports: Set<string>; stars: Set<string> } {
  let memo = KOTLIN_FILE_SCOPES.get(context);
  if (!memo) KOTLIN_FILE_SCOPES.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const text = (context.readFile(file) ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/`/g, '');
  const pkg = /^\s*package\s+([\w.]+)/m.exec(text)?.[1] ?? '';
  const imports = new Set<string>();
  const stars = new Set<string>();
  for (const m of text.matchAll(/^\s*import\s+([\w.]+?)(\.\*)?(?:\s+as\s+\w+)?\s*;?\s*(?:\/\/.*)?$/gm)) {
    if (m[2]) stars.add(m[1]!);
    else imports.add(m[1]!);
  }
  const scope = { pkg, imports, stars };
  memo.set(file, scope);
  return scope;
}

/**
 * Whether a top-level Kotlin declaration — a function, an extension function
 * (indexed under its receiver type, `JdbcTransaction::assertEquals`), a
 * property — can be named from the file a call is written in: its own
 * package, an `import` of it, or a star import of its package. A member of a
 * class is not judged here; a lambda's receiver can put any type's members in
 * scope. Exposed's tests call `assertEquals(…)` from kotlin.test and JUnit, or
 * import the JDBC suite's extension; the calls went to the R2DBC suite's
 * extension 3,075 times.
 */
export function isKotlinTopLevelVisible(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (n.language !== 'kotlin' || n.filePath === ref.filePath) return true;
  const enclosed = context
    .getNodesInFile(n.filePath)
    .some((o) => o.id !== n.id && KOTLIN_ENCLOSING_KINDS.has(o.kind) && o.startLine <= n.startLine && o.endLine >= n.endLine &&
      (o.startLine < n.startLine || o.endLine > n.endLine));
  if (enclosed) return true;
  const pkg = kotlinFileScope(n.filePath, context).pkg;
  const here = kotlinFileScope(ref.filePath, context);
  return pkg === here.pkg || here.stars.has(pkg) || here.imports.has(pkg ? `${pkg}.${n.name}` : n.name) || KOTLIN_DEFAULT_IMPORTS.has(pkg);
}
