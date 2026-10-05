/**
 * Receiver / local type inference: the per-language patterns that recover the type of a call's receiver, plus the shared memos (clearNameMatcherMemos).
 *
 * Part of the name matcher (see ../name-matcher.ts).
 */

import { Language, Node } from '../../types';
import { UnresolvedRef, ResolutionContext } from '../types';
import { blankStringContents, stripCommentsForRegex } from '../strip-comments';
import { TS_PRIMITIVE_TYPES } from '../js-builtins';
import { NO_RECEIVER_LINES } from './call-shape';
import { CPP_NS_ALIASES, CPP_NS_FRAMES, CPP_NS_MACROS, C_STATIC_MEMO } from './lang/c-cpp';
import { CFML_CHAINS } from './lang/cfml';
import { CSHARP_ALIASES, CSHARP_ANCESTORS, CSHARP_GLOBAL_USINGS, CSHARP_NAMESPACE_SCOPES, CSHARP_PROJECT_USINGS, CSHARP_STATIC_USINGS, CSHARP_SUPERS } from './lang/csharp';
import { DART_HIERARCHIES, DART_SUPERS, dartSupertypesOf } from './lang/dart';
import { GO_EXTERNAL_QUALIFIED } from './lang/go';
import { JAVA_ANCESTORS, JAVA_FILE_SCOPES, JAVA_STATIC_IMPORTS, JAVA_SUPERS, JVM_PACKAGES } from './lang/java';
import { LOCAL_BINDING_MEMO, LOCAL_BINDING_SITES } from './lang/javascript';
import { KOTLIN_FILE_SCOPES, KOTLIN_FRAMES, KOTLIN_HIERARCHIES, KOTLIN_LAMBDA_RECEIVERS, KOTLIN_RECEIVER_TYPES } from './lang/kotlin';
import { LUA_LOCALS, LUA_MEMBERS } from './lang/lua';
import { OBJC_SUPERS, objcSupertypesOf } from './lang/objc';
import { PHP_FILE_SCOPES, PHP_SUPERS, inferPhpAssignedPropertyType, phpPropertyTypePatterns } from './lang/php';
import { PYTHON_GLOBAL_CLASSES, PYTHON_IMPORTED_FILES, PYTHON_MEMBER_LINES, PYTHON_NAME_SCANS, PYTHON_STATEMENT_STARTS, PY_FIXTURE_TYPES, PY_IMPORTS, PY_LOCAL_BINDS, PY_LOCAL_FILE, PY_LOCAL_LAST, PY_MODULE_LOCAL, PY_PLUGGED_MODULES } from './lang/python';
import { RUBY_ANCESTRY } from './lang/ruby';
import { RUST_CRATES, RUST_DEPENDENCIES, RUST_TRAIT_IMPL_MEMO, RUST_USES } from './lang/rust';
import { SCALA_IMPORTED_SUPERS, SCALA_IMPORTS, SCALA_OBJECT_PACKAGES, SCALA_PACKAGE_OBJECTS, SCALA_SUPERS, scalaSupertypesOf } from './lang/scala';
import { SOLIDITY_HIERARCHIES, SOLIDITY_SUPERS } from './lang/solidity';
import { SWIFT_DECLS, SWIFT_HIERARCHIES, swiftDeclOf } from './lang/swift';
import { TS_CLASS_LINES, TS_FIELD_DECL_MEMO } from './lang/typescript';
import { TARGET_LANGUAGE } from './language-family';
import { GET_STATE_FILES, SELECTOR_NAMES, hasParameterBinding, importShadowedAt } from './strategies/js-store';
import { isMethodOwnerKind } from './strategies/qualified';
import { OVERLOAD_SETS } from './strategies/reference';
import { ESM_EXPORT_LISTS, ESM_FAMILY, LEXICAL_SCOPE_MEMO, LOCAL_DECL_MEMO, MINIFIED_SCRIPTS, SEALED_MODULES, isLexicallyReachable } from './visibility';

// ── Local-variable receiver-type inference (#1108) ──────────────────────────
//
// Instance calls through a local variable (`const lg = new Logger(); lg.log()`)
// only resolved in C++ before this — no other language could learn the
// receiver's type. Local variables are not indexed as nodes (node-explosion),
// so, like the C++ inferrer above, we read the enclosing function's source and
// match the receiver's declaration/initializer to recover its type. The type is
// then handed to resolveMethodOnType, which VALIDATES that the type actually
// declares the method, so a mis-inference produces NO edge — the safety net
// that lets the patterns below stay simple. C++ keeps its dedicated inferrer
// (header scan + `auto`); this covers every other language.

// Tokens a loose pattern might capture that are never a user-defined type.
const NON_TYPE_RECEIVER_TOKENS = new Set([
  'this', 'self', 'super', 'new', 'return', 'await', 'yield', 'typeof',
  'null', 'nil', 'None', 'true', 'false', 'True', 'False', 'undefined',
]);

/**
 * Normalize a captured type expression to a simple type name: drop generic
 * args and pointer/ref markers, take the last `.`/`::`-qualified segment, and
 * reject obvious non-types.
 */
export function normalizeInferredTypeName(raw: string): string | null {
  const cleaned = raw.replace(/<[^>]*>/g, '').replace(/[&*]/g, '').trim();
  const seg = cleaned.split(/[.:]+/).filter(Boolean).pop();
  if (!seg) return null;
  if (NON_TYPE_RECEIVER_TOKENS.has(seg)) return null;
  return seg;
}

/**
 * A Java / C# type's optional type arguments (one level of nesting) and array
 * ranks, as a regex source: `<L, R>`, `<string, List<int>>`, `[]`, `[,]`.
 */
const TYPE_ARGS = '(?:<[^;=(){}<>]*(?:<[^;=(){}<>]*>[^;=(){}<>]*)*>)?\\s*(?:\\[[\\s,]*\\]\\s*)*';

/**
 * Per-language patterns that recover a local variable's (or typed parameter's)
 * type from its declaration/initializer. Each regex captures the type in group
 * 1; `r` is the already-escaped receiver name. Ordered most-specific first.
 * PascalCase is required in the capture where the language convention allows,
 * as a cheap false-positive guard on top of resolveMethodOnType's validation.
 */
/**
 * Compiled-pattern memo for the receiver-type pattern builders below. They
 * run for EVERY `receiver.method()` ref the matcher attempts, compiling 2–4
 * fresh RegExp objects per call — and receivers repeat massively (`self`
 * alone accounts for tens of thousands of refs on a Lua repo, measured 41µs
 * per methodCall miss on kong with compilation a large slice). The patterns
 * are a pure function of (language, receiver) and non-global (`.match()`
 * never touches lastIndex), so shared instances are behavior-identical.
 * FIFO-capped with no per-get mutation (the §7a.6 LRU-churn lesson): a hit
 * costs one Map lookup, overflow evicts oldest, and an evicted entry simply
 * recompiles exactly as every call did before this memo.
 */
const PATTERN_MEMO = new Map<string, RegExp[]>();
const PATTERN_MEMO_CAP = 8192;

/**
 * Per-context incremental receiver-scan states for inferLocalReceiverType
 * (see the memo comment there). Keyed (file, scopeStart, language, receiver);
 * entries are a few dozen bytes, count is bounded by distinct receiver uses
 * (same order as the context's other per-file caches). MUST drop whenever the
 * context's file caches drop — the states are derived from file lines — so
 * ReferenceResolver.clearCaches calls clearNameMatcherMemos alongside
 * clearImportResolverMemos.
 */
type InferScanState = { hi: number; ansIdx: number; ansType: string | null };
const INFER_SCAN_STATES = new WeakMap<ResolutionContext, Map<string, InferScanState>>();

/** Awaited inference caches are scoped to the resolver's stable-source window.
 * Negative file eligibility avoids scanning ordinary receiver misses; call-site
 * keys distinguish shadowed bindings and sibling blocks. Both caches are bounded
 * and are invalidated with file/import caches on sync. */
type AwaitedType = { name: string | null; filePath: string };
type AwaitedFile = {
  code: string; ready: boolean; offsets: number[]; names: Set<string>;
  scopes: { start: number; end: number; parent: number }[];
  declarations: Map<string, { index: number; length: number }[]>;
};
const AWAITED_TYPE_MEMO = new WeakMap<ResolutionContext, Map<string, AwaitedType | null>>();
const AWAITED_FILES = new WeakMap<ResolutionContext, Map<string, AwaitedFile | null>>();

function getInferScanStates(context: ResolutionContext): Map<string, InferScanState> {
  let m = INFER_SCAN_STATES.get(context);
  if (!m) {
    m = new Map();
    INFER_SCAN_STATES.set(context, m);
  }
  return m;
}

/** Drop the per-context scan states (see ReferenceResolver.clearCaches). */
export function clearNameMatcherMemos(context: ResolutionContext): void {
  INFER_SCAN_STATES.delete(context);
  PYTHON_MEMBER_LINES.delete(context);
  PYTHON_STATEMENT_STARTS.delete(context);
  PYTHON_GLOBAL_CLASSES.delete(context);
  PYTHON_NAME_SCANS.delete(context);
  PYTHON_IMPORTED_FILES.delete(context);
  AWAITED_TYPE_MEMO.delete(context);
  AWAITED_FILES.delete(context);
  C_STATIC_MEMO.delete(context);
  RUST_TRAIT_IMPL_MEMO.delete(context);
  RUST_USES.delete(context);
  RUST_CRATES.delete(context);
  RUST_DEPENDENCIES.delete(context);
  LEXICAL_SCOPE_MEMO.delete(context);
  KOTLIN_LAMBDA_RECEIVERS.delete(context);
  SCALA_IMPORTED_SUPERS.delete(context);
  SCALA_PACKAGE_OBJECTS.delete(context);
  LOCAL_DECL_MEMO.delete(context);
  JAVA_SUPERS.delete(context);
  PHP_SUPERS.delete(context);
  DART_SUPERS.delete(context);
  DART_HIERARCHIES.delete(context);
  SWIFT_DECLS.delete(context);
  KOTLIN_RECEIVER_TYPES.delete(context);
  KOTLIN_HIERARCHIES.delete(context);
  KOTLIN_FRAMES.delete(context);
  CPP_NS_MACROS.delete(context);
  CPP_NS_FRAMES.delete(context);
  CPP_NS_ALIASES.delete(context);
  SOLIDITY_SUPERS.delete(context);
  DECLARED_SUPERS.delete(context);
  INHERITED_METHODS.delete(context);
  MEMBER_SHADOWS.delete(context);
  MEMBER_WALKS.delete(context);
  MEMBER_LINES.delete(context);
  SOLIDITY_HIERARCHIES.delete(context);
  MEMBER_TYPE_MEMO.delete(context);
  CSHARP_ALIASES.delete(context);
  SWIFT_HIERARCHIES.delete(context);
  KOTLIN_FILE_SCOPES.delete(context);
  RUBY_ANCESTRY.delete(context);
  CFML_CHAINS.delete(context);
  NO_RECEIVER_LINES.delete(context);
  OBJC_SUPERS.delete(context);
  CSHARP_SUPERS.delete(context);
  CSHARP_STATIC_USINGS.delete(context);
  CSHARP_NAMESPACE_SCOPES.delete(context);
  CSHARP_PROJECT_USINGS.delete(context);
  CSHARP_GLOBAL_USINGS.delete(context);
  CSHARP_ANCESTORS.delete(context);
  PY_FIXTURE_TYPES.delete(context);
  PY_PLUGGED_MODULES.delete(context);
  SCALA_OBJECT_PACKAGES.delete(context);
  GO_EXTERNAL_QUALIFIED.delete(context);
  JAVA_FILE_SCOPES.delete(context);
  JAVA_ANCESTORS.delete(context);
  SCALA_SUPERS.delete(context);
  SCALA_IMPORTS.delete(context);
  ESM_EXPORT_LISTS.delete(context);
  LUA_LOCALS.delete(context);
  LUA_MEMBERS.delete(context);
  JVM_PACKAGES.delete(context);
  MINIFIED_SCRIPTS.delete(context);
  PY_LOCAL_BINDS.delete(context);
  PY_LOCAL_FILE.delete(context);
  PY_LOCAL_LAST.delete(context);
  OVERLOAD_SETS.delete(context);
  PHP_FILE_SCOPES.delete(context);
  JAVA_STATIC_IMPORTS.delete(context);
  PY_IMPORTS.delete(context);
  PY_MODULE_LOCAL.delete(context);
  SEALED_MODULES.delete(context);
  LOCAL_BINDING_MEMO.delete(context);
  LOCAL_BINDING_SITES.delete(context);
  SELECTOR_NAMES.delete(context);
  GET_STATE_FILES.delete(context);
  TS_FIELD_DECL_MEMO.delete(context);
  TS_CLASS_LINES.delete(context);
  TARGET_LANGUAGE.delete(context);
}

export function memoPatterns(key: string, build: () => RegExp[]): RegExp[] {
  const hit = PATTERN_MEMO.get(key);
  if (hit) return hit;
  const patterns = build();
  if (PATTERN_MEMO.size >= PATTERN_MEMO_CAP) {
    const oldest = PATTERN_MEMO.keys().next().value;
    if (oldest !== undefined) PATTERN_MEMO.delete(oldest);
  }
  PATTERN_MEMO.set(key, patterns);
  return patterns;
}

export function localReceiverTypePatterns(language: Language, r: string): RegExp[] {
  return memoPatterns(`${language}|${r}`, () => buildLocalReceiverTypePatterns(language, r));
}

function buildLocalReceiverTypePatterns(language: Language, r: string): RegExp[] {
  switch (language) {
    case 'typescript':
    case 'javascript':
    case 'tsx':
    case 'jsx':
    case 'arkts':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*new\\s+([A-Za-z_$][\\w.$]*)`), // = new Logger()
        // No keyword requirement, so this matches BOTH a local annotation
        // (`const lg: Logger`) and a typed parameter (`function use(lg: Logger)`
        // / `(lg: Logger) =>`) — the parameter case the old `const|let|var`
        // prefix excluded (#1125). Mirrors Kotlin/Swift/Scala; the capture stops
        // at `<` so a generic-typed param (`repo: Repository<User>`) still yields
        // `Repository`. resolveMethodOnType validates the type actually declares
        // the method, so the looser match produces no edge on a mis-inference.
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.$]*)`), // lg: Logger  (annotation or typed param)
      ];
    case 'python':
      return [
        // group = VLANGroup.objects.create(…) — a Django manager call that
        // returns one instance of the model (not `filter`/`all`, a QuerySet).
        new RegExp(`(?:^|;)\\s*${r}\\s*=(?!=)\\s*([A-Z]\\w*)\\.objects\\.(?:create|get|first|last|latest|earliest|get_by_natural_key)\\s*\\(`),
        // lg = Logger(...) — a statement of its own: `prefix=IPNetwork(…),`
        // inside a call's arguments is a keyword argument, not a binding.
        new RegExp(`(?:^|;)\\s*${r}\\s*=(?!=)\\s*([A-Z][\\w.]*)\\s*\\((?![^\\n]*,\\s*$)`),
        // A quoted forward reference (`lg: "Logger"`, `lg: 'pkg.Logger'`) is the
        // same annotation — and what every file under `from __future__ import
        // annotations` or with a not-yet-defined class writes. The unquoted
        // pattern below stopped at the quote and read no type at all, so the
        // call produced no edge (#1684). Tried first: it is the stricter shape.
        new RegExp(`\\b${r}\\b\\s*:\\s*["']([A-Z][\\w.]*)["']`), // lg: "Logger"
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)`), // lg: Logger  (PEP 526)
      ];
    case 'java':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*new\\s+([A-Za-z_][\\w.]*)`), // = new Logger()
        new RegExp(`\\b([A-Z][\\w.]*)\\s*${TYPE_ARGS}\\s+${r}\\b\\s*[=;,)]`), // Logger lg;  / Pair<L, R> pair / String[] args
        new RegExp(`\\bfor\\s*\\(\\s*(?:final\\s+)?([A-Z][\\w.]*)\\s*${TYPE_ARGS}\\s+${r}\\s*:`), // for (Element el : els)
      ];
    case 'kotlin':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w.]*)\\s*\\(`), // val lg = Logger(...)
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)`), // val lg: Logger  / param
      ];
    case 'csharp':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*new\\s+([A-Za-z_][\\w.]*)`), // = new Logger()
        new RegExp(`\\b([A-Z][\\w.]*)\\s*${TYPE_ARGS}\\??\\s+${r}\\b\\s*[=;,)]`), // Logger lg;  / List<string> names / JProperty? p
        new RegExp(`\\bforeach\\s*\\(\\s*([A-Z][\\w.]*)\\s*${TYPE_ARGS}\\??\\s+${r}\\s+in\\b`), // foreach (JProperty p in props)
      ];
    case 'objc':
      return [
        // FMResultSet *rs = …  /  NSString * _Nullable name;  /  a block's ^(FMResultSet *rs)
        new RegExp(`\\b([A-Z]\\w*)\\s*(?:<[^<>;]*>\\s*)?\\*\\s*(?:(?:_Nullable|_Nonnull|__strong|__weak|__unsafe_unretained|const)\\s+)*${r}\\b(?!\\s*\\()`),
        // a method parameter: - (void)read:(nullable FMResultSet *)rs
        new RegExp(`\\(\\s*(?:(?:nullable|nonnull|__kindof)\\s+)*([A-Z]\\w*)\\s*(?:<[^<>)]*>\\s*)?\\*[^)]*\\)\\s*${r}\\b`),
      ];
    case 'swift':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w.]*)\\s*\\(`), // let lg = Logger(...)
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)`), // let lg: Logger  / param
      ];
    case 'rust':
      return [
        new RegExp(`\\blet\\s+(?:mut\\s+)?${r}\\b(?:\\s*:[^=]+)?=\\s*&?(?:mut\\s+)?([A-Z][\\w]*)`), // let lg = Logger::new()/Logger{}/Logger
        // No `let`, so this covers a `let lg: Logger` binding AND a typed
        // parameter (`fn use(lg: &Logger)`, a closure `|lg: Logger|`) — the
        // parameter case the old `let`-anchored pattern excluded (#1125).
        new RegExp(`\\b${r}\\s*:\\s*&?(?:mut\\s+)?([A-Z][\\w]*)`), // lg: Logger  (binding or typed param)
      ];
    case 'go':
      return [
        new RegExp(`\\b${r}\\b\\s*:=\\s*&?([A-Za-z_][\\w.]*)\\s*{`), // lg := Logger{} / &Logger{}
        new RegExp(`\\bvar\\s+${r}\\s+\\*?([A-Za-z_][\\w.]*)`), // var lg Logger / *Logger
        // A method receiver, anchored on `func (` — so an UNEXPORTED type
        // (`func (s *server)`, `(s *store[T])`) is safe to accept here,
        // unlike the keyword-free pattern below (#2323).
        new RegExp(`\\bfunc\\s*\\(\\s*${r}\\s+\\*?([A-Za-z_]\\w*)\\s*(?:\\[[^\\]]*\\])?\\s*\\)`), // func (s *server)
        // A typed parameter / method receiver (`func use(lg Logger)`,
        // `func (l Logger) M()`) — name-before-type with no `var`/`:=` (#1125).
        // PascalCase-guarded (unlike the anchored patterns above) to keep the
        // keyword-free `ident Type` shape from matching unrelated pairs; the
        // enclosing-scope bound already excludes package-level struct fields.
        new RegExp(`\\b${r}\\s+\\*?([A-Z][\\w.]*)`), // func use(lg Logger) / (l Logger)
      ];
    case 'ruby':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w:]*)\\.new\\b`), // lg = Logger.new
      ];
    case 'scala':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*(?:new\\s+)?([A-Z][\\w.]*)`), // val lg = new Logger / Logger(...)
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)`), // val lg: Logger  / param
      ];
    case 'dart':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w.]*)\\s*\\(`), // var lg = Logger(...)
        // Trailing `[=;,)]` (not just `[=;]`) so a typed parameter — `Logger lg)`
        // / `Logger lg,` — matches too, not only `Logger lg = ...` / `Logger lg;`
        // (#1125). Mirrors Java/C#.
        new RegExp(`\\b([A-Z][\\w.]*)\\s+${r}\\b\\s*[=;,)]`), // Logger lg = ...  / param
      ];
    case 'php':
      return [
        new RegExp(`\\$?${r}\\b\\s*=\\s*new\\s+([A-Za-z_\\\\][\\w\\\\]*)`), // $lg = new Logger()
        // A typed parameter (`function use(Logger $lg)`, `?Logger $lg`,
        // `\\App\\Logger $lg`, `&$lg` by-ref) and a typed `catch (E $e)` — the
        // type sits before the `$`-variable (#1125). Namespace `\\` allowed.
        new RegExp(`\\b([A-Za-z_\\\\][\\w\\\\]*)\\s+&?\\$${r}\\b`), // Logger $lg  (typed param)
      ];
    case 'lua':
    case 'luau':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w]*)\\.new\\b`), // local lg = Logger.new()
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w]*)\\s*\\(`), // local lg = Logger(...)  (callable table)
        // Luau annotation (`local lg: Logger`) / typed param — but Lua's
        // method-call syntax is the IDENTICAL `receiver:Name` shape, and the
        // backward scan starts on the call's own line, so without a gate any
        // PascalCase method call (`lg:Log()`, the Roblox convention)
        // self-matches as "type = Log" before the scan reaches the real
        // declaration (#1124). The lookahead rejects a capture followed by
        // any of Lua's three call forms — `(args)`, `"s"`/`'s'`/`[[s]]`,
        // `{t}` — and its leading `[\w.]` alternative stops backtracking from
        // shrinking the capture to dodge the gate (`lg:Log()` would otherwise
        // still match, as `Lo`).
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)(?![\\w.]|\\s*[({"'\\[])`), // local lg: Logger  / typed param
      ];
    case 'r':
      return [
        new RegExp(`\\b${r}\\b\\s*(?:<-|<<-|=)\\s*([A-Z][\\w.]*)\\$new\\b`), // lg <- Logger$new()  (R6)
      ];
    case 'pascal':
      return [
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w]*)`), // var lg: TLogger  / param lg: TLogger
        new RegExp(`\\b${r}\\b\\s*:=\\s*([A-Z][\\w.]*)\\.Create\\b`), // lg := TLogger.Create
      ];
    case 'cfml':
    case 'cfscript':
      return [
        // svc = new UserService() / new path.to.UserService() — dotted component
        // paths reduce to their final segment via normalizeInferredTypeName.
        // Also matches inside tag markup (`<cfset svc = new UserService()>`)
        // since the scan reads raw source lines.
        new RegExp(`\\b${r}\\b\\s*=\\s*new\\s+([A-Za-z_][\\w.]*)`),
        // The classic form: svc = createObject("component", "path.to.UserService")
        // (casing of createObject varies in the wild), plus the modern
        // single-argument form createObject("path.to.UserService").
        new RegExp(`\\b${r}\\b\\s*=\\s*[Cc]reate[Oo]bject\\s*\\(\\s*["']component["']\\s*,\\s*["']([\\w.]+)["']`),
        new RegExp(`\\b${r}\\b\\s*=\\s*[Cc]reate[Oo]bject\\s*\\(\\s*["']([\\w.]+)["']\\s*\\)`),
        // Typed cfscript parameter: `function save(UserService svc)` /
        // `required UserService svc` — CFML's built-in types (string, numeric,
        // any, struct…) are lowercase by convention, so the PascalCase guard
        // excludes them.
        new RegExp(`\\b([A-Z][\\w.]*)\\s+${r}\\b\\s*[=;,)]`),
        // Tag-form typed argument, either attribute order:
        // <cfargument name="svc" type="path.to.UserService">
        new RegExp(`\\bcfargument[^>\\n]*\\bname\\s*=\\s*["']${r}["'][^>\\n]*\\btype\\s*=\\s*["']([\\w.]+)["']`, 'i'),
        new RegExp(`\\bcfargument[^>\\n]*\\btype\\s*=\\s*["']([\\w.]+)["'][^>\\n]*\\bname\\s*=\\s*["']${r}["']`, 'i'),
        // Component property (incl. WireBox DI): `property name="svc"
        // inject="UserService";` / `<cfproperty name="svc" type="UserService">`,
        // either attribute order. An inject DSL value with a namespace
        // (`inject="svc@core"`) captures only the leading name and simply
        // fails type-validation — no edge, never a wrong one.
        new RegExp(`\\b(?:cf)?property\\b[^;\\n]*\\bname\\s*=\\s*["']${r}["'][^;\\n]*\\b(?:type|inject)\\s*=\\s*["']([\\w.]+)["']`, 'i'),
        new RegExp(`\\b(?:cf)?property\\b[^;\\n]*\\b(?:type|inject)\\s*=\\s*["']([\\w.]+)["'][^;\\n]*\\bname\\s*=\\s*["']${r}["']`, 'i'),
      ];
    default:
      return [];
  }
}

/** Languages whose fields and properties declare their type where the class declares them. */
export const MEMBER_TYPED_LANGUAGES: ReadonlySet<string> = new Set(['csharp', 'java', 'kotlin', 'swift']);
export const MEMBER_CLASS_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'interface', 'enum', 'record']);
const MEMBER_TYPE_MEMO = new WeakMap<ResolutionContext, Map<string, string | null>>();
/** Words that can stand where a declaration's type does without being one. */
const MEMBER_TYPE_NON_TYPES: ReadonlySet<string> = new Set([
  'return', 'new', 'case', 'throw', 'else', 'in', 'out', 'ref', 'params', 'await', 'yield', 'is', 'as', 'using',
  'var', 'val', 'goto', 'nameof', 'typeof', 'sizeof', 'default', 'when', 'where', 'get', 'set', 'init',
  'class', 'interface', 'enum', 'struct', 'record', 'object', 'namespace', 'package', 'import', 'extends',
  'implements', 'fun', 'static', 'final', 'abstract', 'sealed', 'override', 'virtual', 'delegate', 'event',
]);

/**
 * The type a C# / Java / Kotlin receiver has as a field or property of the
 * class around the call — `private readonly JsonWriter _innerWriter;`,
 * `public JsonReader Reader { get; }`, `private val sink: BufferedSink` — or
 * null when the class declares no such member or the calling method binds
 * the name itself. Only the class's own lines are read, never a method body
 * or a nested type. Newtonsoft's `_innerWriter.WriteValue(…)` inside
 * TraceJsonWriter went to TraceJsonWriter's own `WriteValue` by name.
 */
export function inferMemberReceiverType(receiver: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  const name = receiver.replace(/^(?:this|self)\./, '');
  if (!/^[A-Za-z_]\w*$/.test(name)) return null;
  const inFile = context.getNodesInFile(ref.filePath).filter((n) => n.language === ref.language);
  let cls: Node | undefined;
  let fn: Node | undefined;
  for (const n of inFile) {
    if (n.startLine > ref.line || n.endLine < ref.line) continue;
    if (MEMBER_CLASS_KINDS.has(n.kind) && (!cls || n.startLine >= cls.startLine)) cls = n;
    else if ((n.kind === 'method' || n.kind === 'function') && (!fn || n.startLine >= fn.startLine)) fn = n;
  }
  if (!cls) return null;
  const found = memberTypeThroughHierarchy(cls, name, context);
  if (!found) return null;
  // A lambda parameter, `var` local, `out` variable or `foreach` binding in
  // the calling method shadows the field, and the local inference that ran
  // first cannot type those.
  return fn && bindsNameItself(fn, name, context) ? null : found;
}

const MEMBER_SHADOWS = new WeakMap<ResolutionContext, Map<string, boolean>>();
const MEMBER_WALKS = new WeakMap<ResolutionContext, Map<string, string | null>>();

/** Whether a C# / Java / Kotlin function body binds `name` itself — a `var`/`val`, an `out` or loop variable, a lambda parameter. */
function bindsNameItself(fn: Node, name: string, context: ResolutionContext): boolean {
  let memo = MEMBER_SHADOWS.get(context);
  if (!memo) MEMBER_SHADOWS.set(context, (memo = new Map()));
  const key = `${fn.id}|${name}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const lines = context.getFileLines?.(fn.filePath) ?? context.readFile(fn.filePath)?.split(/\r?\n/) ?? [];
  const body = lines.slice(fn.startLine - 1, fn.endLine).join('\n');
  const r = name.replace(/\$/g, '\\$');
  const binds = new RegExp(`\\b(?:var|val|let|out\\s+[\\w.<>?]+|foreach\\s*\\(\\s*[\\w.<>?,\\s]+?)\\s+${r}\\b|\\bfor\\s*\\([^;)]*\\s${r}\\s*:|\\b${r}\\s*=>|[(,]\\s*${r}\\s*(?:,[^()]*)?\\)\\s*=>|\\b${r}\\s*(?:,[^{}]*)?->`).test(body);
  memo.set(key, binds);
  return binds;
}

/**
 * The type `cls` declares a member `name` with, or one of its supertypes
 * does — the class's own members first, then those it inherits (a base
 * class's `internal readonly JsonSerializer Serializer;`), each inherited
 * class carrying what its type parameters stand for in the class the walk
 * came from (`: IntegrationTest<DatabaseInitializer>`).
 */
function memberTypeThroughHierarchy(cls: Node, name: string, context: ResolutionContext): string | null {
  let memo = MEMBER_WALKS.get(context);
  if (!memo) MEMBER_WALKS.set(context, (memo = new Map()));
  const key = `${cls.id}|${name}`;
  if (memo.has(key)) return memo.get(key)!;
  let result: string | null = null;
  const seen = new Set<string>();
  const queue: Array<{ type: Node; args: Map<string, string> }> = [{ type: cls, args: new Map() }];
  while (queue.length > 0 && seen.size < 8) {
    const { type, args } = queue.shift()!;
    if (seen.has(type.id)) continue;
    seen.add(type.id);
    const found = classMemberType(type, name, context);
    if (found) {
      if (type === cls) {
        result = found;
        break;
      }
      // A member typed by the declaring class's own type parameter
      // (`protected TFixture Fixture { get; }`) is the argument the subclass
      // gave it, else its bound — with neither, only `object`'s members.
      const given = args.get(found);
      if (given) {
        result = given;
        break;
      }
      const bound = typeParameterBoundIn(found, [type], context);
      result = bound === undefined ? found : bound ?? 'object';
      break;
    }
    for (const sup of classHeadSupertypes(type, context)) {
      const given = headTypeArguments(type, sup, context).map((a) => args.get(a) ?? a);
      for (const decl of context.getNodesByName(sup)) {
        if (decl.language !== type.language || !MEMBER_CLASS_KINDS.has(decl.kind)) continue;
        const params = declaredTypeParameters(decl, context);
        queue.push({ type: decl, args: new Map(params.map((p, i) => [p, given[i] ?? ''] as [string, string]).filter(([, a]) => a !== '')) });
      }
    }
  }
  memo.set(key, result);
  return result;
}

/** The first `<…>` of a declaration's head, split at its top-level commas. */
function angleArguments(text: string): string[] {
  const open = text.indexOf('<');
  if (open < 0) return [];
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text.slice(open + 1)) {
    if (ch === '<') depth++;
    else if (ch === '>' && depth-- === 0) break;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((a) => a.trim());
}

/** The type parameters a class declares: `TDbContextFixture` for `class IntegrationTest<TDbContextFixture>`. */
function declaredTypeParameters(decl: Node, context: ResolutionContext): string[] {
  const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
  const head = lines.slice(decl.startLine - 1, decl.startLine + 3).join(' ');
  const at = new RegExp(`\\b${decl.name}\\s*<`).exec(head);
  if (!at) return [];
  return angleArguments(head.slice(at.index)).map((p) => /([A-Za-z_]\w*)\s*(?:extends\b.*|:.*)?$/.exec(p.replace(/^(?:in|out|reified)\s+/, ''))?.[1] ?? '');
}

/** The type arguments a class's head gives a supertype, as simple names: `DatabaseInitializer` for `: IntegrationTest<ParameterizedQueries.DatabaseInitializer>`. */
function headTypeArguments(cls: Node, sup: string, context: ResolutionContext): string[] {
  const lines = context.getFileLines?.(cls.filePath) ?? context.readFile(cls.filePath)?.split(/\r?\n/) ?? [];
  const head = lines.slice(cls.startLine - 1, cls.startLine + 8).join(' ').split('{')[0]!;
  const at = new RegExp(`(?:[:,]|\\bextends|\\bimplements)\\s*(?:[\\w.]+\\.)?${sup}\\s*<`).exec(head);
  if (!at) return [];
  return angleArguments(head.slice(at.index)).map((a) => a.replace(/<[\s\S]*$/, '').split('.').pop()!.trim());
}

/**
 * The supertypes a class declaration names in its own head, for the
 * languages whose heads say it plainly: Pascal `TX = class(TBase, IFoo)`,
 * Python `class X(Base):`, Ruby `class X < Base`, PHP / TS / JS `extends
 * Base`, and the Java-family heads.
 */
const DECLARED_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();
const INHERITED_METHODS = new WeakMap<ResolutionContext, Map<string, Node | null>>();

function declaredSupertypes(cls: Node, context: ResolutionContext): string[] {
  let memo = DECLARED_SUPERS.get(context);
  if (!memo) DECLARED_SUPERS.set(context, (memo = new Map()));
  const hit = memo.get(cls.id);
  if (hit) return hit;
  const supers = readDeclaredSupertypes(cls, context);
  memo.set(cls.id, supers);
  return supers;
}

function readDeclaredSupertypes(cls: Node, context: ResolutionContext): string[] {
  switch (cls.language) {
    case 'java': case 'csharp': case 'kotlin': return classHeadSupertypes(cls, context);
    case 'dart': return dartSupertypesOf(cls.name, context);
    case 'swift': return swiftDeclOf(cls.name, context).supers;
    case 'objc': return objcSupertypesOf(cls.name, context);
    case 'scala': return scalaSupertypesOf(cls.name, context);
    default: break;
  }
  const lines = context.getFileLines?.(cls.filePath) ?? context.readFile(cls.filePath)?.split(/\r?\n/) ?? [];
  const head = lines.slice(cls.startLine - 1, cls.startLine + 2).join(' ');
  const names = (text: string | undefined): string[] =>
    text ? [...text.matchAll(/([A-Za-z_][\w.:\\]*)/g)].map((m) => m[1]!.split(/::|\.|\\/).pop()!).filter((w) => !/^(?:metaclass|object)$/.test(w)) : [];
  switch (cls.language) {
    case 'pascal': return names(/=\s*class\s*\(([^)]*)\)/i.exec(head)?.[1]);
    case 'python': return names(/\bclass\s+\w+\s*\(([^)]*)\)/.exec(head)?.[1]?.replace(/\w+\s*=\s*[\w.]+/g, ''));
    case 'ruby': return names(/\bclass\s+[\w:]+\s*<\s*([\w:]+)/.exec(head)?.[1]);
    case 'php': case 'typescript': case 'tsx': case 'javascript': case 'jsx':
      return names(/\bextends\s+([\w.\\]+)/.exec(head)?.[1]);
    default: return [];
  }
}

/** A method named `name` on a supertype of the given classes, nearest first. */
export function inheritedClassMethod(classes: Node[], name: string, context: ResolutionContext): Node | null {
  if (classes.length === 0) return null;
  let memo = INHERITED_METHODS.get(context);
  if (!memo) INHERITED_METHODS.set(context, (memo = new Map()));
  const key = `${classes.map((c) => c.id).join(',')}|${name}`;
  if (memo.has(key)) return memo.get(key)!;
  const found = findInheritedClassMethod(classes, name, context);
  memo.set(key, found);
  return found;
}

function findInheritedClassMethod(classes: Node[], name: string, context: ResolutionContext): Node | null {
  const seen = new Set<string>(classes.map((c) => c.id));
  let frontier = classes;
  for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
    const next: Node[] = [];
    for (const cls of frontier) {
      for (const sup of declaredSupertypes(cls, context)) {
        for (const decl of context.getNodesByName(sup)) {
          if (decl.language !== cls.language || !isMethodOwnerKind(decl) || seen.has(decl.id)) continue;
          seen.add(decl.id);
          const method = context.getNodesInFile(decl.filePath).find((n) => n.kind === 'method' && n.name === name &&
            n.qualifiedName.slice(0, Math.max(0, n.qualifiedName.lastIndexOf('::'))).split(/::|\./).pop() === decl.name);
          if (method) return method;
          next.push(decl);
        }
      }
    }
    frontier = next;
  }
  return null;
}

/** The simple names a Java / C# / Kotlin class declaration's head extends or implements. */
export function classHeadSupertypes(cls: Node, context: ResolutionContext): string[] {
  const lines = context.getFileLines?.(cls.filePath) ?? context.readFile(cls.filePath)?.split(/\r?\n/) ?? [];
  let depth = 0;
  let head = '';
  for (const ch of lines.slice(cls.startLine - 1, cls.startLine + 8).join(' ').replace(/\/\/[^\n]*|\/\*.*?\*\//g, ' ')) {
    if (ch === '{' && depth === 0) break;
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) head += ch;
  }
  const clause = /\b(?:extends|implements)\b([\s\S]*)$/.exec(head)?.[1] ??
    /\b(?:class|interface|struct|record|object)\s+\w+[^:]*:([\s\S]*)$/.exec(head)?.[1] ?? '';
  return [...clause.replace(/\bwhere\b[\s\S]*$/, '').matchAll(/([A-Z]\w*)\s*(?=,|$|\bimplements\b)/g)].map((m) => m[1]!);
}

/**
 * The type a class declares a member `name` with, read from the lines at its
 * body's own brace depth (or its header, for a primary constructor's
 * parameters) — deeper ones are method, accessor and indexer bodies or
 * nested types.
 */
function classMemberType(cls: Node, name: string, context: ResolutionContext): string | null {
  let memo = MEMBER_TYPE_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    MEMBER_TYPE_MEMO.set(context, memo);
  }
  const key = `${cls.id}|${name}`;
  if (memo.has(key)) return memo.get(key)!;
  const r = name.replace(/\$/g, '\\$');
  const pattern = cls.language === 'kotlin' || cls.language === 'swift'
    ? new RegExp(`\\b(?:val|var|let)\\s+${r}\\s*:\\s*([A-Z][\\w.]*)`)
    : new RegExp(`(?:^|[\\s(,])([A-Za-z_][\\w.]*)\\s*${TYPE_ARGS}\\??\\s+${r}\\s*(?:[=;,)]|\\{)`);
  let found: string | null = null;
  for (const { text, depth } of classMemberLines(cls, context)) {
    if (!text.includes(name)) continue;
    const m = pattern.exec(text);
    // Inside parentheses at member depth is a method's parameter list; only
    // the header's (a primary constructor's) declares members.
    const inParens = m !== null && depth === 1 &&
      (text.slice(0, m.index).match(/\(/g)?.length ?? 0) > (text.slice(0, m.index).match(/\)/g)?.length ?? 0);
    if (m && !inParens && !MEMBER_TYPE_NON_TYPES.has(m[1]!)) {
      found = normalizeInferredTypeName(m[1]!);
      break;
    }
  }
  memo.set(key, found);
  return found;
}

const MEMBER_LINES = new WeakMap<ResolutionContext, Map<string, Array<{ text: string; depth: number }>>>();

/**
 * A class's own member-declaration lines — those at its body's brace depth,
 * or its header (a primary constructor's parameters) — with comments and
 * string contents dropped; method, accessor and indexer bodies and nested
 * types are deeper and left out. Read once per class.
 */
function classMemberLines(cls: Node, context: ResolutionContext): Array<{ text: string; depth: number }> {
  let memo = MEMBER_LINES.get(context);
  if (!memo) MEMBER_LINES.set(context, (memo = new Map()));
  const hit = memo.get(cls.id);
  if (hit) return hit;
  const lines = context.getFileLines?.(cls.filePath) ?? context.readFile(cls.filePath)?.split(/\r?\n/) ?? [];
  const out: Array<{ text: string; depth: number }> = [];
  let depth = 0;
  let inComment = false;
  for (let line = cls.startLine; line <= cls.endLine; line++) {
    let raw = lines[line - 1] ?? '';
    if (inComment) {
      const close = raw.indexOf('*/');
      if (close < 0) continue;
      raw = raw.slice(close + 2);
      inComment = false;
    }
    let text = raw.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/, '');
    const open = text.indexOf('/*');
    if (open >= 0) {
      text = text.slice(0, open);
      inComment = true;
    }
    if (depth <= 1 && text.trim() !== '') out.push({ text, depth });
    for (const ch of text) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  memo.set(cls.id, out);
  return out;
}

/**
 * What a Java / C# / Kotlin type parameter of the class or method around a
 * call is bounded by: `ExceptionContext` for `T` in `class Test<T extends
 * ExceptionContext & Serializable>` / `where T : ExceptionContext` / `<T :
 * ExceptionContext>`, null when it is a type parameter with no named bound,
 * undefined when it is not a type parameter there at all.
 */
export function typeParameterBound(typeName: string, ref: UnresolvedRef, context: ResolutionContext): string | null | undefined {
  const around = context.getNodesInFile(ref.filePath).filter((n) => n.startLine <= ref.line && n.endLine >= ref.line &&
    (MEMBER_CLASS_KINDS.has(n.kind) || n.kind === 'method' || n.kind === 'function'));
  return typeParameterBoundIn(typeName, around, context);
}

/** {@link typeParameterBound}, over the heads of the given declarations. */
function typeParameterBoundIn(typeName: string, decls: Node[], context: ResolutionContext): string | null | undefined {
  if (!/^[A-Z]\w*$/.test(typeName)) return undefined;
  const t = typeName;
  let declared = false;
  for (const n of decls) {
    const lines = context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split(/\r?\n/) ?? [];
    const head = lines.slice(n.startLine - 1, n.startLine + 5).join(' ').split('{')[0]!;
    const bound = new RegExp(`[<,]\\s*(?:in\\s+|out\\s+|reified\\s+)?${t}\\s*(?:extends|:)\\s*([A-Z][\\w.]*)`).exec(head)?.[1] ??
      new RegExp(`\\bwhere\\s+${t}\\s*:\\s*([A-Z][\\w.]*)`).exec(head)?.[1];
    if (bound) return bound.split('.').pop()!;
    if (new RegExp(`[<,]\\s*(?:in\\s+|out\\s+|reified\\s+)?${t}\\s*[,>]`).test(head)) declared = true;
  }
  return declared ? null : undefined;
}

/** 1-based start line of the tightest function/method enclosing the call. */
export function enclosingScopeStartLine(ref: UnresolvedRef, context: ResolutionContext): number {
  let start = 1;
  for (const n of context.getNodesInFile(ref.filePath)) {
    if (n.kind !== 'function' && n.kind !== 'method') continue;
    if (n.language !== ref.language) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= ref.line && end >= ref.line && n.startLine >= start) {
      start = n.startLine;
    }
  }
  return start;
}

/**
 * Infer a receiver's type from its local declaration/initializer in the
 * enclosing function body. Language-dispatched; returns null for languages
 * without patterns or when no declaration is found. Bounded to the enclosing
 * scope so a same-named variable in another function can't leak in.
 */
export function inferLocalReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  // CFML scope prefixes: `variables.svc` / `this.svc` name a COMPONENT-scoped
  // field whose assignment or `property` declaration usually lives outside the
  // calling function (the init-pseudoconstructor / WireBox-injection pattern),
  // and `local.svc` is an explicit function-local. Strip the prefix so the
  // declaration patterns match (`variables.svc = new X()`, `property
  // name="svc" …`, `var svc = …` all bind the bare name), and widen the scan
  // to the whole file for the component-scoped forms — nearest-declaration-
  // backward still wins, so a function-local shadowing the field is preferred.
  let scanReceiver = receiverName;
  let componentScoped = false;
  if (ref.language === 'cfml' || ref.language === 'cfscript') {
    const scoped = receiverName.match(/^(variables|this|local|arguments)\.(.+)$/i);
    if (scoped) {
      scanReceiver = scoped[2]!;
      const scope = scoped[1]!.toLowerCase();
      componentScoped = scope === 'variables' || scope === 'this';
    }
  }
  // PHP `$this->prop` receiver — the property's declaration lives outside the
  // calling method (a promoted constructor parameter `private readonly Foo $prop`,
  // a typed property `private Foo $prop;`, or a classic constructor parameter
  // `Foo $prop` assigned in __construct). Strip the prefix and widen the scan to
  // the whole file (the constructor may sit below the calling method), but —
  // unlike CFML's scopes above — switch to PROPERTY-shaped patterns: a plain
  // `$prop` local or parameter lives in a different namespace than `$this->prop`
  // and can never shadow it, so the generic local patterns would type the
  // property from unrelated same-named variables in other methods (a wrong
  // 0.9-confidence edge, not a missing one).
  let phpProperty = false;
  if (ref.language === 'php') {
    const scoped = receiverName.match(/^this->(.+)$/);
    if (scoped) {
      scanReceiver = scoped[1]!;
      componentScoped = true;
      phpProperty = true;
    }
  }

  const escapedReceiver = scanReceiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = phpProperty
    ? phpPropertyTypePatterns(escapedReceiver)
    : localReceiverTypePatterns(ref.language, escapedReceiver);
  if (patterns.length === 0) return null;

  // Split through the context's per-file lines cache when available: this runs
  // for EVERY `receiver.method()` ref, and re-splitting the whole file per ref
  // was ~20% of total index CPU on Java-heavy repos (#1122).
  const lines = context.getFileLines
    ? context.getFileLines(ref.filePath)
    : (context.readFile(ref.filePath)?.split(/\r?\n/) ?? null);
  if (!lines || lines.length === 0) return null;

  const callIdx = Math.max(0, Math.min(lines.length - 1, ref.line - 1));
  const startIdx = componentScoped
    ? 0
    : Math.max(0, enclosingScopeStartLine(ref, context) - 1);

  const matchLine = (i: number): string | null => {
    const line = lines[i];
    if (!line) return null;
    // A generated/minified line (one multi-KB statement) is not something a
    // human-written local declaration lives on, and regexing it per ref is
    // pure waste — skip it rather than scan it.
    if (line.length > 10_000) return null;
    for (const re of patterns) {
      const m = line.match(re);
      if (m && m[1]) {
        const type = normalizeInferredTypeName(m[1]);
        if (type) return type;
      }
    }
    return null;
  };

  // Incremental-scan memo (INFER_SCAN_STATES): this scan runs for EVERY
  // `receiver.method()` ref and was measured at 61µs/ref on kong (2.4s of
  // worker time, 99% misses — `self:` calls hunting a declaration Lua never
  // writes). Refs for the same (file, scope, receiver) arrive in ~ascending
  // line order, and the scan is a pure function of the file's immutable
  // lines, so each line pays its regex matches ONCE per key instead of once
  // per ref: query(c) = highest matching line in [startIdx..c]; a monotonic
  // call extends the stored watermark by scanning only (hi..c] (the region
  // at-or-below the previous answer is already proven empty above it); a
  // non-monotonic call (rare — refs are rowid-ordered) falls back to the
  // plain bounded scan and leaves the state alone. componentScoped is keyed
  // out — its position-independent whole-file sweep below has different
  // semantics.
  if (!componentScoped) {
    const states = getInferScanStates(context);
    const key = `${ref.filePath}|${startIdx}|${ref.language}|${scanReceiver}`;
    const state = states.get(key);
    if (!state) {
      for (let i = callIdx; i >= startIdx; i--) {
        const type = matchLine(i);
        if (type) {
          states.set(key, { hi: callIdx, ansIdx: i, ansType: type });
          return type;
        }
      }
      states.set(key, { hi: callIdx, ansIdx: -1, ansType: null });
      return null;
    }
    if (callIdx >= state.hi) {
      for (let i = callIdx; i > state.hi; i--) {
        const type = matchLine(i);
        if (type) {
          state.ansIdx = i;
          state.ansType = type;
          break;
        }
      }
      state.hi = callIdx;
      return state.ansIdx >= startIdx ? state.ansType : null;
    }
    for (let i = callIdx; i >= startIdx; i--) {
      const type = matchLine(i);
      if (type) return type;
    }
    return null;
  }

  // Nearest declaration wins: scan backward from the call to the scope start.
  for (let i = callIdx; i >= startIdx; i--) {
    const type = matchLine(i);
    if (type) return type;
  }
  // A component-scoped field's declaration is position-independent — the
  // `variables.svc = new X()` pseudoconstructor assignment or `property`
  // declaration may sit BELOW the calling function in the file — so when the
  // backward pass finds nothing, sweep the remainder of the file too.
  if (componentScoped) {
    for (let i = callIdx + 1; i < lines.length; i++) {
      const type = matchLine(i);
      if (type) return type;
    }
  }
  // A PHP property with no statically-typed declaration (classic pre-7.4
  // style) may still be typed by what gets ASSIGNED to it — follow the
  // `$this->prop = $var` assignment to the assigned variable's own typed
  // declaration (a classic or multi-line constructor parameter, or a typed
  // setter's parameter).
  if (phpProperty) {
    return inferPhpAssignedPropertyType(escapedReceiver, lines, callIdx);
  }
  return null;
}

/** Infer only a visible awaited binding and its actual local/imported callee.
 * The signature already carries the return annotation in both extractors, so
 * multiline declarations and neighboring declarations cannot donate a type.
 * `null` means no awaited evidence; a null NAME means an awaited receiver whose
 * type is unknown, which must not fall back to an unrelated method name. */
export function inferEsmAwaitedCallType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): AwaitedType | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(receiverName)) return null;
  let files = AWAITED_FILES.get(context);
  if (!files) { files = new Map(); AWAITED_FILES.set(context, files); }
  let file = files.get(ref.filePath);
  if (file === undefined) {
    const source = context.readFile(ref.filePath) ?? '';
    file = null;
    // Raw eligibility is cheap; sanitize and index scopes only when a ref
    // actually uses one of these names. Comments cannot donate a binding:
    // the names are checked again after sanitizing on the first real lookup.
    const names = new Set([...source.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*await\s+[\w$]+\s*\(/g)].map(m => m[1]!));
    if (names.size) file = { code: source, ready: false, names, offsets: [], scopes: [], declarations: new Map() };
    if (files.size >= 256) files.delete(files.keys().next().value!);
    files.set(ref.filePath, file);
  }
  if (!file?.names.has(receiverName)) return null;
  if (!file.ready) {
    const code = blankStringContents(stripCommentsForRegex(file.code, 'typescript'));
    const names = new Set([...code.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*await\s+[\w$]+\s*\(/g)].map(m => m[1]!));
    const offsets = [0];
    const scopes = [{ start: -1, end: code.length, parent: -1 }];
    const stack = [0];
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '\n') offsets.push(i + 1);
      if (code[i] === '{') {
        scopes.push({ start: i, end: code.length, parent: stack[stack.length - 1]! });
        stack.push(scopes.length - 1);
      } else if (code[i] === '}' && stack.length > 1) scopes[stack.pop()!]!.end = i;
    }
    const declarations = new Map<string, { index: number; length: number }[]>();
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*/g)) {
      if (!names.has(m[1]!)) continue;
      const entries = declarations.get(m[1]!) ?? [];
      entries.push({ index: m.index!, length: m[0].length });
      declarations.set(m[1]!, entries);
    }
    Object.assign(file, { code, ready: true, names, offsets, scopes, declarations });
    if (!names.has(receiverName)) return null;
  }
  let memo = AWAITED_TYPE_MEMO.get(context);
  if (!memo) { memo = new Map(); AWAITED_TYPE_MEMO.set(context, memo); }
  const key = `${ref.filePath}|${ref.line}|${ref.column}|${receiverName}`;
  if (memo.has(key)) return memo.get(key)!;
  const result = resolveAwaitedCallType(receiverName, file, ref, context);
  if (memo.size >= PATTERN_MEMO_CAP) memo.delete(memo.keys().next().value!);
  memo.set(key, result);
  return result;
}

function resolveAwaitedCallType(
  receiverName: string,
  file: AwaitedFile,
  ref: UnresolvedRef,
  context: ResolutionContext,
): AwaitedType | null {
  const unknown: AwaitedType = { name: null, filePath: ref.filePath };
  const end = (file.offsets[ref.line - 1] ?? file.code.length) + ref.column;
  const code = file.code.slice(0, end);
  const escaped = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Locate scopes in the precomputed brace tree. Rescanning the entire file
  // for every candidate binding made large test files quadratic in refs.
  const scopeAt = (offset: number): number => {
    let lo = 0, hi = file.scopes.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (file.scopes[mid]!.start < offset) lo = mid; else hi = mid;
    }
    while (lo > 0 && file.scopes[lo]!.end < offset) lo = file.scopes[lo]!.parent;
    return lo;
  };
  const visibleAt = (declaration: number, use: number): boolean => {
    const ancestor = scopeAt(declaration);
    for (let scope = scopeAt(use); scope >= 0; scope = file.scopes[scope]!.parent) if (scope === ancestor) return true;
    return false;
  };
  const binding = [...(file.declarations.get(receiverName) ?? [])].reverse()
    .find(m => m.index < end && visibleAt(m.index, end));
  if (!binding) return null;
  const init = code.slice(binding.index + binding.length);
  if (!/^await\b/.test(init)) return null;
  // Only a bare call result, not a following member/index/conditional expression.
  const call = /^await\s+([A-Za-z_$][\w$]*)\s*\(/.exec(init);
  if (!call) return null;
  let depth = 1, callEnd = call[0].length;
  for (; callEnd < init.length && depth; callEnd++) {
    if (init[callEnd] === '(') depth++;
    else if (init[callEnd] === ')') depth--;
  }
  if (depth) return unknown;
  const tail = init.slice(callEnd);
  // A following property/index/call is not the callee's annotated value.
  if (!/^[ \t]*(?:;|\r?\n(?![ \t]*[.(\[?]))/.test(tail)) return unknown;
  const rest = tail;
  if (new RegExp(`\\b(?:const|let|var|function|class)\\s+(?:${escaped}\\b|\\{[^}]*\\b${escaped}\\b)`).test(rest) ||
      new RegExp(`\\b${escaped}\\s*=(?!=)`).test(rest) || hasParameterBinding(rest, escaped)) return unknown;

  const bindingLine = file.code.slice(0, binding.index!).split('\n').length;
  const bindingRef = { ...ref, line: bindingLine, column: binding.index! - file.offsets[bindingLine - 1]! };
  const callee = call[1]!;
  const calleeEscaped = callee.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (context.getNodesInFile(ref.filePath).some(n =>
    (n.kind === 'function' || n.kind === 'method') && n.startLine <= bindingLine && n.endLine >= bindingLine &&
    n.signature && hasParameterBinding(`${n.signature} {`, calleeEscaped))) return unknown;

  const imported = context.getImportMappings(ref.filePath, ref.language).some(m => m.localName === callee);
  let declaring: Node | undefined;
  if (imported) {
    if (importShadowedAt(callee, bindingRef, context)) return unknown;
    const resolved = context.resolveImport?.({ ...bindingRef, referenceName: callee, referenceKind: 'calls' });
    declaring = resolved ? context.getNodeById?.(resolved.targetNodeId) ?? undefined : undefined;
  } else {
    const local = context.getNodesByName(callee).filter(n => n.kind === 'function' &&
      n.filePath === ref.filePath && ESM_FAMILY.has(n.language) && isLexicallyReachable(n, bindingRef, context));
    if (local.length === 1) declaring = local[0];
  }
  if (!declaring || declaring.kind !== 'function' || !declaring.signature) return unknown;
  if (!imported) {
    const beforeBinding = code.slice(0, binding.index!);
    const shadows = new RegExp(`\\b(?:const|let|var)\\s+${calleeEscaped}\\b`, 'g');
    for (const shadow of beforeBinding.matchAll(shadows)) {
      if (!visibleAt(shadow.index!, binding.index)) continue;
      // A typed arrow function may itself be the declared local factory.
      const line = file.code.slice(0, shadow.index!).split('\n').length;
      if (line !== declaring.startLine || shadow.index! - file.offsets[line - 1]! > declaring.startColumn) return unknown;
    }
  }
  const signature = declaring.signature;
  const annotation = signature.slice(signature.lastIndexOf(')') + 1).match(/^\s*:\s*([\s\S]+)$/)?.[1]?.trim();
  if (!annotation) return unknown;
  // Do not turn unions, arrays, object/function types, or conditional types into
  // a project class. Await recursively unwraps promises, but this narrow path
  // accepts a single named Promise<T> layer only.
  const returned = annotation.match(/^Promise\s*<\s*([\w$]+)\s*>$/)?.[1] ?? annotation;
  if (!/^[A-Za-z_$][\w$]*$/.test(returned)) return unknown;
  if (TS_PRIMITIVE_TYPES.has(returned)) return { name: returned, filePath: declaring.filePath };

  const typeRef = { ...bindingRef, fromNodeId: declaring.id, filePath: declaring.filePath,
    language: declaring.language, line: declaring.startLine, column: declaring.startColumn,
    referenceName: returned, referenceKind: 'references' as const };
  const typeImport = context.getImportMappings(declaring.filePath, declaring.language).some(m => m.localName === returned);
  const resolved = typeImport ? context.resolveImport?.(typeRef) : null;
  const typeNode = resolved ? context.getNodeById?.(resolved.targetNodeId) :
    context.getNodesByName(returned).find(n => n.filePath === declaring.filePath &&
      ESM_FAMILY.has(n.language) && (n.kind === 'class' || n.kind === 'interface'));
  if (!typeNode || (typeNode.kind !== 'class' && typeNode.kind !== 'interface')) return unknown;
  return { name: typeNode.name, filePath: typeNode.filePath };
}
