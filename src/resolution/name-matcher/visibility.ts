/**
 * Cross-file visibility and lexical reachability of a candidate definition.
 *
 * Part of the name matcher (see ../name-matcher.ts).
 */

import * as path from 'path';
import { Node } from '../../types';
import { UnresolvedRef, ResolutionContext } from '../types';
import { blankStringContents, stripCommentsForRegex } from '../strip-comments';
import { isTestPath } from '../../search/query-utils';
import { isMinifiedContent } from '../../extraction/generated-detection';
import { C_SOURCE_EXT, isStaticCFunction } from './lang/c-cpp';
import { CSHARP_TYPE_KINDS, isCsharpNestedTypeInScope, isCsharpTypeVisible } from './lang/csharp';
import { dartExtensionDecl, isDartUnnamedExtensionMember } from './lang/dart';
import { isGoExternalQualified } from './lang/go';
import { isJavaTypeVisible } from './lang/java';
import { isLuaLocal, luaAliasTarget } from './lang/lua';
import { isPhpClassVisible } from './lang/php';
import { isRustTraitImplMethod, rustModuleDir } from './lang/rust';
import { isScalaPackageObjectMemberVisible } from './lang/scala';

/** Languages with no nested named functions: nesting in the graph is never a scope. */
const NO_NESTED_FUNCTIONS = new Set<string>(['c', 'cpp']);
/** Types a function body can declare for itself. */
const LOCAL_TYPE_KINDS = new Set<string>(['class', 'struct', 'enum', 'interface', 'trait', 'type_alias']);

/**
 * A function nested inside another FUNCTION is only callable from within its
 * container — Python, JS/TS, and every closure language scope it lexically.
 * Resolving a bare name from elsewhere to a nested local fabricates an edge
 * scope already rules out: `join(...)` in one function must never bind to a
 * `join` defined inside a DIFFERENT function (#1230). A candidate whose
 * qualifiedName parent is a same-file function/method is kept only when the
 * ref originates inside that parent's line range. Class members are
 * unaffected (their parent resolves to a class-like node), as are top-level
 * symbols and C++ namespace-prefixed names (the prefix has no node).
 */
export function isLexicallyReachable(
  candidate: Node,
  ref: UnresolvedRef,
  context: ResolutionContext
): boolean {
  // A `val` / `const` declared in a function body is that body's alone —
  // okio's `(source as Source).buffer()` bound to a `val buffer = Buffer()`
  // inside another test file's `pipe()`.
  if (candidate.kind === 'variable' || candidate.kind === 'constant' || (candidate.kind === 'field' && candidate.language === 'scala')) {
    const scope = localDeclarationScope(candidate, context);
    return scope === null || (ref.filePath === candidate.filePath && ref.line >= scope.start && ref.line <= scope.end);
  }
  // A function — or a type (`case class B()` in a test method), or a method
  // of such a type — declared inside a function is only in scope in there.
  if (candidate.kind !== 'function' && candidate.kind !== 'method' && !LOCAL_TYPE_KINDS.has(candidate.kind)) return true;
  // C and C++ have no nested named functions, so a function the graph shows
  // inside another is an extraction artifact, not a scope: tree-sitter-c
  // cannot parse a macro call whose arguments are designated initializers
  // (betaflight's `RESET_CONFIG(pidProfile_t, pidProfile, .pid = {…})`), and
  // its error recovery runs the enclosing function_definition to the end of
  // the file, nesting every function after it. Trusting that nesting rejected
  // 117 real calls into pid.c on that tree; the functions are reachable.
  if (NO_NESTED_FUNCTIONS.has(candidate.language)) return true;
  const scope = lexicalScopeOf(candidate, context);
  return scope === null || (ref.filePath === candidate.filePath && ref.line >= scope.start && ref.line <= scope.end);
}

/** Per context: node id → the function body (or Scala block) a declaration is local to. */
export const LOCAL_DECL_MEMO = new WeakMap<ResolutionContext, Map<string, { start: number; end: number } | null>>();

/**
 * The lines a variable declaration is in scope for when it is local: the
 * innermost function or method of its file whose lines hold it — or, for a
 * Scala `val` the graph files under its class but written inside a block of
 * the class body (cats' `test("…") { val f = … }`), that block. Null for a
 * declaration at file, class or object level. A Lua global assigned inside a
 * function is still global; C and C++ nesting is not trusted (see below).
 */
function localDeclarationScope(candidate: Node, context: ResolutionContext): { start: number; end: number } | null {
  if (NO_NESTED_FUNCTIONS.has(candidate.language)) return null;
  let memo = LOCAL_DECL_MEMO.get(context);
  if (!memo) LOCAL_DECL_MEMO.set(context, (memo = new Map()));
  const hit = memo.get(candidate.id);
  if (hit !== undefined) return hit;
  let scope: { start: number; end: number } | null = null;
  if (!((candidate.language === 'lua' || candidate.language === 'luau') && !isLuaLocal(candidate, context))) {
    for (const n of context.getNodesInFile(candidate.filePath)) {
      if ((n.kind !== 'function' && n.kind !== 'method') || n.id === candidate.id) continue;
      if (n.startLine > candidate.startLine || n.endLine < candidate.startLine || n.startLine === n.endLine) continue;
      if (n.startLine === candidate.startLine && (n.startColumn ?? 0) >= (candidate.startColumn ?? 0)) continue;
      if (!scope || n.endLine - n.startLine < scope.end - scope.start) scope = { start: n.startLine, end: n.endLine };
    }
    if (!scope && candidate.kind === 'field' && candidate.language === 'scala') scope = scalaBlockOf(candidate, context);
  }
  memo.set(candidate.id, scope);
  return scope;
}

/** The `{ … }` block, deeper than its class body, that a Scala `val` is written in; null for a member. */
function scalaBlockOf(candidate: Node, context: ResolutionContext): { start: number; end: number } | null {
  const owner = candidate.qualifiedName.includes('::') ? candidate.qualifiedName.slice(0, candidate.qualifiedName.lastIndexOf('::')) : '';
  const cls = context.getNodesInFile(candidate.filePath).find((n) =>
    n.qualifiedName === owner && (n.kind === 'class' || n.kind === 'trait' || n.kind === 'struct' || n.kind === 'module'));
  if (!cls || cls.startLine >= candidate.startLine) return null;
  const lines = context.getFileLines?.(candidate.filePath) ?? context.readFile(candidate.filePath)?.split(/\r?\n/) ?? [];
  const clean = (l: string) => l.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)'/g, '""').replace(/\/\/.*$/, '');
  // Depth at the start of each line, counted from the class header; the body is depth 1.
  const opens: number[] = [];
  let depth = 0;
  for (let line = cls.startLine; line < candidate.startLine; line++) {
    for (const ch of clean(lines[line - 1] ?? '')) {
      if (ch === '{') { depth++; opens.push(line); }
      else if (ch === '}') { depth = Math.max(0, depth - 1); opens.pop(); }
    }
  }
  if (depth <= 1) return null;
  const start = opens[opens.length - 1]!;
  let d = depth;
  for (let line = candidate.startLine; line <= cls.endLine; line++) {
    for (const ch of clean(lines[line - 1] ?? '')) {
      if (ch === '{') d++;
      else if (ch === '}' && --d < depth) return { start, end: line };
    }
  }
  return { start, end: cls.endLine };
}

/** Per context: a candidate's scoping function body, or null when nothing scopes it. */
export const LEXICAL_SCOPE_MEMO = new WeakMap<ResolutionContext, Map<string, { start: number; end: number } | null>>();

/**
 * The innermost function or method BODY that scopes a declaration, walking out
 * through its qualified name (`test_x::Request::User::has_perm` → `test_x`).
 * A method directly on a class is reachable through its instances, and an
 * object-literal method a function returns through the object — neither is
 * scoped by the function it sits in.
 */
function lexicalScopeOf(candidate: Node, context: ResolutionContext): { start: number; end: number } | null {
  let memo = LEXICAL_SCOPE_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    LEXICAL_SCOPE_MEMO.set(context, memo);
  }
  const hit = memo.get(candidate.id);
  if (hit !== undefined) return hit;
  let scope: { start: number; end: number } | null = null;
  const own = candidate.qualifiedName ?? '';
  const parentQn = own.includes('::') ? own.slice(0, own.lastIndexOf('::')) : '';
  let qn = own;
  while (qn.includes('::')) {
    qn = qn.slice(0, qn.lastIndexOf('::'));
    const container = context
      .getNodesByQualifiedName(qn)
      .find(
        (p) =>
          p.filePath === candidate.filePath &&
          (p.kind === 'function' || p.kind === 'method') &&
          p.startLine <= candidate.startLine &&
          p.endLine >= candidate.endLine
      );
    if (!container) continue;
    if (candidate.kind === 'method' && qn === parentQn) break;
    scope = { start: container.startLine, end: container.endLine };
    break;
  }
  memo.set(candidate.id, scope);
  return scope;
}

/** Languages whose module boundary is `import`/`export` (or CommonJS). */
export const ESM_FAMILY = new Set<string>(['typescript', 'tsx', 'javascript', 'jsx', 'arkts']);

/**
 * A line-initial `import` statement — the marker that a JS/TS file is a MODULE
 * rather than a classic script. Line-anchored and followed by a name, brace,
 * star or quote, so a dynamic `import(` and the word inside a comment or string
 * do not match.
 */
const HAS_IMPORT_STATEMENT = /^[ \t]*import[\s{*'"]/m;

/**
 * Anything the file could offer another file, in every form the extractor's own
 * `isExported` flag misses. `^export` covers the declaration and later forms
 * (`export const`, `export { x }`, `export default x`, `export *`); the
 * CommonJS shapes cover files that never use ESM syntax at all, in both the dot
 * and the bracket form; and `declare global` contributes names to every file
 * whether or not the module exports anything of its own. Kept as a source test
 * rather than a node scan precisely because `isExported` is set only from an
 * `export_statement` ancestor, so `const x = …; export { x }` and
 * `module.exports = { x }` both read as unexported on the node.
 */
const HAS_ESM_EXPORT = /^[ \t]*export[\s{*]|^[ \t]*declare\s+global\b/m;
const HAS_CJS_EXPORT = /\bmodule\.exports\b|\bexports\s*[.[]/;

/**
 * Per-context memo of "this file is a module that exports nothing", asked once
 * per candidate FILE rather than once per reference. Derived from file source,
 * so it drops with the context's file caches — clearNameMatcherMemos deletes it
 * alongside INFER_SCAN_STATES.
 */
export const SEALED_MODULES = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * Whether `filePath` is a JS/TS module that exports NOTHING — an import
 * statement present, no export of any form. No reference from another file can
 * reach any binding in such a file, so every one of its symbols is a false
 * candidate for a cross-file name match.
 *
 * This is the general case behind a package name capturing a same-named local:
 * on `vitejs/vite`, 157 cross-file `imports` refs — every `import { defineConfig
 * } from 'vite'` in the playground and the create-vite templates — resolved onto
 * `playground/ssr-html/test-stacktrace.js::vite`, which is `const vite = await
 * createServer(…)` at module scope in a file with zero exports. The existing
 * guards cannot see it: `isLexicallyReachable` returns early for any candidate
 * that is not a `function`, and the bare-import guard correctly declines because
 * `vite` IS a workspace member, so the specifier really is project-local. What
 * is wrong is only which node the name lands on.
 *
 * Deliberately narrow on three axes, because each is a class this would
 * otherwise resolve wrongly in the opposite direction:
 *
 * - **A classic script is exempt.** Requiring an `import` statement means a
 *   non-module `.js` file — concatenated globals, a browser `<script>` — keeps
 *   its cross-file matches, where a top-level binding genuinely is reachable.
 * - **CommonJS is exempt.** `module.exports` and `exports.x` are matched as
 *   exports, so a CJS file is never sealed.
 * - **Other languages are exempt.** Go, Python, Java and the rest have no
 *   equivalent boundary, and several extractors hardcode `isExported`.
 */
export function isSealedModule(filePath: string, context: ResolutionContext): boolean {
  let memo = SEALED_MODULES.get(context);
  if (!memo) {
    memo = new Map();
    SEALED_MODULES.set(context, memo);
  }
  const hit = memo.get(filePath);
  if (hit !== undefined) return hit;
  // CommonJS assignments can execute inside template interpolations, which the
  // masker blanks. Keep the conservative raw-source exemption for those forms.
  // Cheapest disqualifiers first: nearly every module exports a node (asked
  // without reading or decoding the file), and masking the source is only
  // needed to rule out the ones that don't. (The masker only blanks text, so
  // no `import` in the source means none in code.)
  const exportsNode = context.fileHasExportedNode
    ? context.fileHasExportedNode(filePath)
    : context.getNodesInFile(filePath).some((n) => n.isExported);
  const source = exportsNode ? null : context.readFile(filePath);
  const sealed =
    !exportsNode && source !== null && source.includes('import') &&
    !HAS_CJS_EXPORT.test(source) &&
    (() => {
      const code = blankStringContents(stripCommentsForRegex(source, 'typescript'));
      return HAS_IMPORT_STATEMENT.test(code) && !HAS_ESM_EXPORT.test(code);
    })();
  memo.set(filePath, sealed);
  return sealed;
}

/**
 * Whether `candidate` can be named by a reference in `ref`'s file at all.
 * Both name-based strategies validate their chosen candidate. Removing an
 * unreachable candidate before ranking can promote an unrelated runner-up;
 * rejecting the chosen target must leave the reference unresolved instead.
 */
export function isCrossFileReachable(
  candidate: Node,
  ref: UnresolvedRef,
  context: ResolutionContext
): boolean {
  if ((ref.language as string) !== 'markdown' && (candidate.language as string) === 'markdown') return false;
  if (ref.referenceKind === 'calls' && ESM_FAMILY.has(candidate.language) &&
    (candidate.kind === 'constant' || candidate.kind === 'variable') &&
    /^=\s*require\s*\(\s*(['"])[^'"]+\.json\1\s*\)\s*;?\s*$/.test(candidate.signature ?? '')) return false;
  return (
    candidate.filePath === ref.filePath ||
    !ESM_FAMILY.has(candidate.language) ||
    (!isSealedModule(candidate.filePath, context) && !isUnexportedModuleBinding(candidate, context))
  );
}

const ESM_BINDING_KINDS: ReadonlySet<string> = new Set(['function', 'variable', 'constant', 'class', 'interface', 'type_alias', 'enum', 'component']);
export const ESM_EXPORT_LISTS = new WeakMap<ResolutionContext, Map<string, { module: boolean; names: Set<string> }>>();

/**
 * Whether `candidate` is a top-level binding of an ES module that the module
 * doesn't export — declared without `export` and absent from its `export { … }`
 * / `export default x` lists. No other file can name it. The sealed-module
 * rule above covers files that export nothing; this is the same boundary per
 * symbol: sveltekit's `generate_manifest.js` keeps an unexported `resolve`
 * that twenty other files' `resolve(…)` calls went to. Classic scripts,
 * CommonJS, `declare global` and `.d.ts` files, members of a class or
 * namespace (qualified names), names a default-exported or returned object
 * literal lists,
 * and anything not declared by a statement of its own (an object literal's
 * member, `proto.x = function x() {}`) are exempt.
 */
function isUnexportedModuleBinding(candidate: Node, context: ResolutionContext): boolean {
  if (candidate.isExported || !ESM_BINDING_KINDS.has(candidate.kind)) return false;
  if (candidate.qualifiedName.includes('::') || /\.d\.[cm]?ts$/.test(candidate.filePath)) return false;
  let memo = ESM_EXPORT_LISTS.get(context);
  if (!memo) ESM_EXPORT_LISTS.set(context, (memo = new Map()));
  let info = memo.get(candidate.filePath);
  if (!info) {
    const source = context.readFile(candidate.filePath) ?? '';
    const code = blankStringContents(stripCommentsForRegex(source, 'typescript'));
    const module = (HAS_IMPORT_STATEMENT.test(code) || HAS_ESM_EXPORT.test(code)) &&
      !HAS_CJS_EXPORT.test(source) && !/\bdeclare\s+global\b/.test(code);
    const names = new Set<string>();
    if (module) {
      for (const m of source.matchAll(/^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
        for (const item of m[1]!.split(',')) {
          const local = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
          if (local) names.add(local);
        }
      }
      for (const m of source.matchAll(/^[ \t]*export\s+(?:default|=)\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm)) names.add(m[1]!);
      // `export default { getAdapter, adapters: known }` exposes its shorthand and
      // value names; so does a `return { getDefaultActivityRoute, … }` (a
      // composable hands the function out through its result).
      for (const m of code.matchAll(/^[ \t]*export\s+default\s+\{([^}]*)\}|\breturn\s*\{([^{}]*)\}/gm)) {
        for (const item of (m[1] ?? m[2])!.split(',')) {
          const value = item.includes(':') ? item.split(':').pop()! : item;
          const id = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(value)?.[1];
          if (id) names.add(id);
        }
      }
    }
    info = { module, names };
    memo.set(candidate.filePath, info);
  }
  if (!info.module || info.names.has(candidate.name)) return false;
  const line = (context.getFileLines?.(candidate.filePath) ?? context.readFile(candidate.filePath)?.split('\n'))?.[candidate.startLine - 1] ?? '';
  // Its own line says `export` (a node's flag can miss a form), or it is
  // `prototype.toString = function toString() {…}`, reached through instances.
  if (/^\s*export\b/.test(line)) return false;
  // Only a declaration statement is a module binding: an object literal's
  // member (a zustand store action `setZipUri: (v) => set(…)`) is reached
  // through the object, and so is `proto.x = function x() {}`.
  return /^\s*(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|(?:abstract\s+)?class|interface|type|enum)\s/.test(line);
}

/**
 * A test suite — a test source set, a `tests/` / `__tests__/` / `spec/`
 * directory, a `FooTest.kt` / `test_foo.py` / `foo.test.ts` file — as opposed
 * to test-support code a project ships (`testing/`, `fakes/`, a `*-test`
 * module like kotlinx-coroutines-test), which its own code may use.
 */
function isTestSuitePath(filePath: string): boolean {
  if (!isTestPath(filePath)) return false;
  const lower = filePath.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  const original = filePath.slice(filePath.lastIndexOf('/') + 1);
  // (`…Spec.java` alone is no test: halo's `IndexSpecs`, okhttp's `ConnectionSpec`.)
  if (name.startsWith('test_') || /[._-](?:test|tests)\.[a-z0-9]+$|[._](?:spec|specs)\.[a-z0-9]+$/.test(name) ||
      // CamelCase suffixes where the language names tests so: not `useTests.ts`, a React hook.
      /(?:Test|Tests|TestCase)\.(?:java|kt|kts|swift|cs|scala|groovy|m|mm|vb|fs)$/.test(original) || name === 'conftest.py') return true;
  return /(?:^|\/)(?:tests?|__tests__|specs?|e2e)\//.test(lower) || /(?:^|\/)[A-Za-z0-9]*(?:Test|Tests|Spec)\//.test(filePath);
}

export const MINIFIED_SCRIPTS = new WeakMap<ResolutionContext, Map<string, boolean>>();

/** A minified / bundled script, by name (`jquery.min.js`) or by its text. */
function isMinifiedScript(filePath: string, context: ResolutionContext): boolean {
  if (!/\.(?:m?js|cjs)$/i.test(filePath)) return false;
  let memo = MINIFIED_SCRIPTS.get(context);
  if (!memo) MINIFIED_SCRIPTS.set(context, (memo = new Map()));
  let hit = memo.get(filePath);
  if (hit === undefined) {
    hit = /[.-]min\.m?js$/i.test(filePath) || isMinifiedContent(filePath, context.readFile(filePath) ?? '');
    memo.set(filePath, hit);
  }
  return hit;
}

/**
 * Languages in which `visibility: 'private'` on a definition means no other
 * FILE can name it: a Kotlin `private fun` is file- or class-local, and the
 * same holds for Java, C#, Swift, Scala, Dart and PHP members.
 */
const PRIVATE_IS_FILE_LOCAL = new Set<string>(['kotlin', 'java', 'csharp', 'swift', 'scala', 'dart', 'php']);

const SFC_SCRIPT_RANGES = new WeakMap<ResolutionContext, Map<string, Array<{ start: number; end: number; exported: boolean }>>>();

/**
 * Whether a declaration in a `.svelte` / `.vue` file is the component's own:
 * anything but the component itself, unless it sits in a block that can export
 * — Svelte's `<script module>` (`context="module"`), or a Vue `<script>` that
 * is not `setup` — or is a type a Vue `<script setup>` exports.
 */
function isSfcPrivate(n: Node, context: ResolutionContext): boolean {
  const svelte = n.filePath.endsWith('.svelte');
  if ((!svelte && !n.filePath.endsWith('.vue')) || n.kind === 'component' || n.kind === 'file') return false;
  let memo = SFC_SCRIPT_RANGES.get(context);
  if (!memo) SFC_SCRIPT_RANGES.set(context, (memo = new Map()));
  let ranges = memo.get(n.filePath);
  if (!ranges) {
    ranges = [];
    const lines = context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split(/\r?\n/) ?? [];
    let open: { start: number; exported: boolean } | null = null;
    lines.forEach((text, i) => {
      const tag = /<script\b([^>]*)>/i.exec(text);
      if (tag && !open) {
        const attrs = tag[1] ?? '';
        open = { start: i + 1, exported: svelte ? /\bmodule\b|context\s*=\s*["']module["']/.test(attrs) : !/\bsetup\b/.test(attrs) };
      }
      if (open && /<\/script\s*>/i.test(text)) {
        ranges!.push({ ...open, end: i + 1 });
        open = null;
      }
    });
    memo.set(n.filePath, ranges);
  }
  const block = ranges.find((r) => n.startLine >= r.start && n.startLine <= r.end);
  if (block?.exported) return false;
  // Vue hoists the types `<script setup>` exports: mealie imports CrudTable.vue's `TableConfig`.
  if (!svelte && block) {
    const line = context.getFileLines?.(n.filePath)?.[n.startLine - 1] ?? context.readFile(n.filePath)?.split(/\r?\n/)[n.startLine - 1] ?? '';
    if (/^\s*export\s+(?:declare\s+)?(?:interface|type|enum)\b/.test(line)) return false;
  }
  return true;
}

/**
 * Whether `candidate` can be NAMED from a reference in `ref`'s file at all,
 * given what its language says about the definition's visibility. A
 * definition the language makes file-local is not a candidate for a
 * cross-file name match, however well the names agree:
 *
 * - **C / C++**: a `static` function defined in a SOURCE file is local to
 *   that translation unit; one in a header is part of every unit that
 *   includes it and stays visible. On a 2,109-file betaflight tree 145
 *   cross-file calls resolved onto a `static` in another `.c` (#1730) —
 *   `usbd_get_descriptor` onto the `static get_device_descriptor` of
 *   whichever USB class file ranked first.
 * - **Kotlin, Java, C#, Swift, Scala, Dart, PHP**: `private` is class- or
 *   file-local. An Android `editor.apply()` resolved onto an unrelated class's
 *   `private fun apply`.
 * - **Go**: an unexported (lowercase) identifier is package-local, and a
 *   package is a directory. Judged by the name's case: the extractor's
 *   `isExported` is unset for every Go method.
 * - **Rust**: a non-`pub` item is visible to its module and that module's
 *   descendants, never to a sibling module or another crate — `.count()` on
 *   an iterator resolved onto a `fn count` in a different crate. A method in
 *   an `impl Trait for Type` block has the trait's visibility, not `private`.
 * - **JS / TS / ArkTS**: a binding in a module that exports nothing (an
 *   `import` present, no `export` / CommonJS / `declare global`) is sealed —
 *   the vite playground's `const vite = await createServer(…)` took 157
 *   `import { defineConfig } from 'vite'` edges (#1719). Classic scripts,
 *   CommonJS, later `export { … }`, and ambient globals stay visible.
 *
 * Same-file candidates are always visible. Applied by ReferenceResolver to
 * the target the whole name-matching pipeline settled on, so a rejection ends
 * the reference unresolved: declining inside matchByExactName instead let the
 * ref fall through to matchFuzzy, which then committed to a same-language
 * namesake the ranking had passed over — eight such edges on one tree, all
 * onto a local `const fail = …` arrow the graph does not hold. matchFuzzy
 * checks its own survivor as well, since nothing runs after it.
 */
export function isVisibleAcrossFiles(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  // Go's `context.Context`, `http.Handler`: written through a package from
  // outside the module, so nothing in it — not even the same file's method
  // `Stream.Context` (fiber's 85 `context.Context` parameters went there).
  if (ref.language === 'go' && candidate.language === 'go' && isGoExternalQualified(ref, context)) return false;
  if (candidate.filePath === ref.filePath) return true;
  // A vendored minified bundle's names are mangled: healthchecks' 369 `$(…)`
  // (jQuery, a global) went to a one-letter helper inside bootstrap-native.min.js.
  if (isMinifiedScript(candidate.filePath, context)) return false;
  // A test suite is not linked into the program: typeorm's `Record<K, V>` is
  // not a test entity `Record`, tokio's `Output` not a `runtime/tests` type.
  if (isTestSuitePath(candidate.filePath) && !isTestPath(ref.filePath)) return false;
  // A Svelte component's instance script, or a Vue SFC's `<script setup>`, is
  // private to the component: shadcn-svelte's 838 `<Item.Root>` (a namespace
  // import) went to a `type Item` one example component declares for itself.
  if (isSfcPrivate(candidate, context)) return false;
  // A bare PHP class name is its namespace's class, or the one a `use` names.
  if (!isPhpClassVisible(candidate, ref, context)) return false;
  // A bare Java type name is its package's, an import's, or a nested type in reach.
  if (!isJavaTypeVisible(candidate, ref, context)) return false;
  // A Dart `extension on Token { … }` has no name: `Token` is analyzer's type,
  // not bloc_lint's extension block (84 refs went there).
  if (dartExtensionDecl(candidate, context)?.named === false) return false;
  // And it applies only in its own library: flutter_test's `find.text(…)` is
  // no other file's `extension on TaskStatus { String get text }`.
  if (candidate.filePath !== ref.filePath && isDartUnnamedExtensionMember(candidate, context)) return false;
  // A Scala package object's member is in scope in its package and those under
  // it, or through an import: cats.laws' `Eq` is the `cats` package object's
  // alias, not the `algebra` one's (752 refs went there).
  if (candidate.language === 'scala' && ref.language === 'scala' && !isScalaPackageObjectMemberVisible(candidate, ref, context)) return false;
  if (candidate.language === 'csharp' && ref.language === 'csharp' && CSHARP_TYPE_KINDS.has(candidate.kind) &&
      /^[A-Za-z_]\w*$/.test(ref.referenceName) &&
      (!isCsharpTypeVisible(candidate, ref, context) || !isCsharpNestedTypeInScope(candidate, ref, context))) return false;
  const lang = candidate.language as string;
  if (lang === 'c' || lang === 'cpp') {
    return (
      candidate.kind !== 'function' ||
      !C_SOURCE_EXT.test(candidate.filePath) ||
      !isStaticCFunction(candidate, context)
    );
  }
  if (lang === 'go') {
    // By the name's first letter, not the extractor's flag: the flag is unset
    // for every Go method, exported or not.
    return /^[A-Z]/.test(candidate.name) || path.posix.dirname(candidate.filePath) === path.posix.dirname(ref.filePath);
  }
  if (lang === 'rust') {
    if (candidate.visibility !== 'private') return true;
    if (isRustTraitImplMethod(candidate, context)) return true;
    const owner = rustModuleDir(candidate.filePath);
    return ref.filePath.startsWith(owner + '/');
  }
  if (PRIVATE_IS_FILE_LOCAL.has(lang)) return candidate.visibility !== 'private';
  // An R test file runs in an environment of its own (testthat): its top-level
  // `c <- ggplot(…)` is not what the package's 2,843 `c(…)` calls mean. The
  // `helper-*.R` / `setup-*.R` files are sourced for every test, so theirs are shared.
  if (lang === 'r' && (candidate.kind === 'variable' || candidate.kind === 'constant') &&
      /(?:^|\/)tests?\//.test(candidate.filePath) && !/(?:^|\/)(?:helper|setup)[^/]*\.[rR]$/.test(candidate.filePath)) return false;
  // A Lua `local` belongs to its chunk: kong's spec helpers' `local it = it`
  // took busted's `it(…)` in every other spec file, 4,166 times. Its module
  // can still hand it out — `return { check = check_phase }` — to a file that
  // names it through a `require` alias.
  if ((lang === 'lua' || lang === 'luau') && isLuaLocal(candidate, context)) {
    return ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName) &&
      luaAliasTarget(ref, context)?.targetNodeId === candidate.id;
  }
  // JS/TS/ArkTS sealed modules + markdown/JSON call-target guards (#1719).
  // Same predicate matchByExactName / matchFuzzy apply to their survivors so a
  // rejection here cannot fall through to a promoted runner-up.
  return isCrossFileReachable(candidate, ref, context);
}

/** What only exists inside a type, reachable through a receiver alone. */
export const TYPE_MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'field', 'enum_member']);
