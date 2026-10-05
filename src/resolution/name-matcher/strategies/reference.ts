/**
 * matchReference: the strategy dispatcher, plus overload selection.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext, isSupertypeTarget, isInheritanceRef } from '../../types';
import { SWIFT_TYPE_PATH_CALL, resolveSwiftTypePathCall } from '../../swift-type-visibility';
import { isCollapsedNonRecursion } from '../call-shape';
import { cppParenListAfter, matchCppMacroNamespaced, splitCppTopLevel } from '../lang/c-cpp';
import { erlangImportedModule } from '../lang/erlang';
import { isJavaOutsideImport } from '../lang/java';
import { isOutsideJsLocal } from '../lang/javascript';
import { LUA_GLOBAL_FUNCTIONS, luaAliasTarget } from '../lang/lua';
import { SCALA_TYPE_KINDS } from '../lang/scala';
import { gateLanguageMatch, sameLanguageFamily } from '../language-family';
import { nmTimed } from '../profile';
import { matchCppCallChain, matchDottedCallChain, matchScopedCallChain } from './chains';
import { matchByExactName } from './exact';
import { matchByFilePath } from './file-path';
import { matchFunctionRef } from './function-ref';
import { computePathProximity, findBestMatch, matchFuzzy } from './fuzzy';
import { isUnresolvedJsMemberCall, matchStoreAccessorChain } from './js-store';
import { matchMethodCall } from './method-call';
import { matchByQualifiedName, preferCallSiteFile } from './qualified';

/**
 * Match all strategies in order of confidence
 */
/** ArkUI attribute-helper decorators a `.attr(...)` chain may resolve to. */
const ARKUI_ATTRIBUTE_DECORATORS = new Set(['Extend', 'Styles', 'AnimatableExtend', 'Builder']);

export function matchReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const result = gateLanguageMatch(matchReferenceInner(ref, context), ref, context);
  // `this.container.classList.toggle()` inside `toggle()`, `window.$events
  // .listen()` inside `listen()`, Scala's `requestToArmeria(request).execute()`
  // inside `execute()`: a member of what the receiver is, which is the calling
  // method only through a TS/JS field of the caller's own type.
  if (result && result.targetNodeId === ref.fromNodeId && isCollapsedNonRecursion(ref, context)) return null;
  // A name the calling JS/TS function binds itself shadows the file's own:
  // lodash's `mixin(object, …)` calling `object(this.__wrapped__)` is its
  // parameter, whichever strategy (fuzzy included) found a `function object`.
  if (result && JS_LOCAL_REF_KINDS.has(ref.referenceKind)) {
    const target = context.getNodeById?.(result.targetNodeId);
    // (A target of another name is what the local was followed to: `const
    // selected = useStore(s => s.reset); selected()` is the store's `reset`.)
    if (target && target.name === ref.referenceName && isOutsideJsLocal(target, ref, context)) return null;
  }
  // R looks a call's name up among FUNCTIONS only, skipping other bindings:
  // ggplot2's tests' `c <- data_frame(b = 3)` is never what `c(1, 2)` calls —
  // base R's `c` is. (A project binding made by a function factory, ggplot2's
  // `geom_point <- make_constructor(…)`, is a function, and stays.)
  if (result && ref.language === 'r' && ref.referenceKind === 'calls' && R_BASE_FUNCTIONS.has(ref.referenceName)) {
    const target = context.getNodeById?.(result.targetNodeId);
    if (target && (target.kind === 'variable' || target.kind === 'constant') && !isRFunctionValue(target, context)) return null;
  }
  // C has no methods, and C code cannot call a C++ one: hiredis' function
  // pointer `c->funcs->read(c, buf, …)` is no Qt adapter's `read`.
  if (result && ref.language === 'c' && ref.referenceKind === 'calls' &&
      context.getNodeById?.(result.targetNodeId)?.kind === 'method') return null;
  // A type never inherits from itself: cats' `trait BigDecimalInstances extends
  // cats.kernel.instances.BigDecimalInstances` and `trait AllOps … with
  // Bifoldable.AllOps` name another type of their own name.
  if (result && result.targetNodeId === ref.fromNodeId && isInheritanceRef(ref)) return otherSupertypeNamed(ref, context);
  // Nor does a value's initializer call the value: sttp's `val response =
  // basicRequest.get(…).response(asStringAlways)` is a request's `response`.
  if (result && result.targetNodeId === ref.fromNodeId && ref.referenceKind === 'calls' &&
      VALUE_KINDS.has(context.getNodeById?.(ref.fromNodeId)?.kind ?? '')) return null;
  return result ? retargetSelfOverload(result, ref, context) : result;
}

/**
 * The supertype an inheritance ref names when the name is the declaring
 * type's own: another type of that name — the one the written qualifier
 * (`cats.kernel.instances.`, `Bifoldable.`) leads to, by its owner and its
 * file's package. Null unless exactly one fits.
 */
function otherSupertypeNamed(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName.split(/::|\./).pop()!;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split(/\r?\n/)[ref.line - 1] ?? '';
  const written = new RegExp(`^\\s*((?:[\\w$]+\\.)+)${name.replace(/\$/g, '\\$')}\\b`).exec(line.slice(Math.max(0, ref.column)));
  const qualifier = written ? written[1]!.slice(0, -1) : '';
  const candidates = context.getNodesByName(name).filter((n) =>
    n.id !== ref.fromNodeId && isSupertypeTarget(n) && sameLanguageFamily(n.language, ref.language) &&
    (qualifier === '' || ownerPathOf(n, context) === qualifier || ownerPathOf(n, context).endsWith(`.${qualifier}`)));
  // Among several, the declaring file's own, then (for `implements`) a protocol / interface / trait:
  // SDWebImage's `@interface SDWebImageCacheKeyFilter : NSObject <SDWebImageCacheKeyFilter>`.
  let pool = candidates;
  if (pool.length > 1) {
    const sameFile = pool.filter((n) => n.filePath === ref.filePath);
    if (sameFile.length > 0) pool = sameFile;
  }
  if (pool.length > 1 && ref.referenceKind === 'implements') {
    const conformable = pool.filter((n) => n.kind === 'protocol' || n.kind === 'interface' || n.kind === 'trait');
    if (conformable.length > 0) pool = conformable;
  }
  return pool.length === 1 ? { original: ref, targetNodeId: pool[0]!.id, confidence: 0.8, resolvedBy: 'qualified-name' } : null;
}

/** A declaration's dotted owner path — its file's package clauses, then its enclosing types (`cats.kernel.instances`, `cats.Bifoldable`). */
function ownerPathOf(n: Node, context: ResolutionContext): string {
  const text = context.readFile(n.filePath) ?? '';
  const pkg = [...text.matchAll(/^\s*package\s+([\w.]+)\s*;?\s*$/gm)].map((m) => m[1]!).join('.');
  const cut = n.qualifiedName.lastIndexOf('::');
  const owners = cut > 0 ? n.qualifiedName.slice(0, cut).replace(/::/g, '.') : '';
  return [pkg, owners].filter((p) => p !== '' && !(pkg !== '' && p === owners && owners.startsWith(pkg))).join('.');
}

/** Reference kinds a bare JS/TS local can be: a call, a value, a construction. */
const JS_LOCAL_REF_KINDS: ReadonlySet<string> = new Set(['calls', 'references', 'function_ref', 'instantiates']);

/** Base R functions whose names data often shadows (`c <- data_frame(…)`, `df <- …`, `t <- 1`). */
const R_BASE_FUNCTIONS: ReadonlySet<string> = new Set([
  'c', 't', 'q', 'df', 'dt', 'data', 'list', 'length', 'names', 'max', 'min', 'sum', 'mean', 'range', 'rev', 'sort',
  'order', 'rep', 'seq', 'cat', 'print', 'paste', 'paste0', 'format', 'levels', 'factor', 'matrix', 'vector', 'table',
  'scale', 'sample', 'exp', 'log', 'abs', 'all', 'any', 'which', 'nchar', 'summary', 'file', 'dir', 'identity', 'unique',
  'nrow', 'ncol', 'rownames', 'colnames', 'array', 'character', 'numeric', 'integer', 'logical', 'mode', 'class', 'body',
  'args', 'environment', 'search', 'diff', 'round', 'sign', 'trunc', 'var', 'sd', 'median', 'quantile', 'weights',
]);

/** Whether an R binding holds a function: `f <- function(…)`, `f = \\(x) …`, a `purrr::partial(…)` aside. */
function isRFunctionValue(n: Node, context: ResolutionContext): boolean {
  const line = (context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split(/\r?\n/) ?? [])[n.startLine - 1] ?? '';
  return /(?:<<?-|=)\s*(?:function\b|\\\s*\()/.test(line);
}

/** Node kinds that hold a value rather than run code. */
const VALUE_KINDS: ReadonlySet<string> = new Set(['variable', 'constant', 'field', 'property']);

/** Languages whose methods overload by arity. */
const OVERLOADING_LANGUAGES: ReadonlySet<string> = new Set(['csharp', 'java', 'kotlin', 'swift', 'cpp', 'scala', 'dart', 'vbnet', 'solidity']);

/**
 * A call a method makes to its own name, with arguments its own parameters
 * cannot take, is to another overload of it: Newtonsoft's
 * `DeserializeXNode(value)` body `return DeserializeXNode(value, null);`
 * bound to itself, so the two-argument overload never saw the one-argument
 * one among its callers. The same-owner overload the argument count fits.
 */
type Arity = { min: number; max: number } | null;
/** Per context: node id → its same-owner overloads with their arities (null: none). */
export const OVERLOAD_SETS = new WeakMap<ResolutionContext, Map<string, { name: string; own: Arity; siblings: Array<{ id: string; arity: Arity }> } | null>>();

function retargetSelfOverload(result: ResolvedRef, ref: UnresolvedRef, context: ResolutionContext): ResolvedRef {
  if (ref.referenceKind !== 'calls' || !OVERLOADING_LANGUAGES.has(ref.language)) return result;
  // C++ overload sets (templates, SFINAE tags, a `data()` on any container) are
  // only trusted for a method's call to itself.
  if (ref.language === 'cpp' && result.targetNodeId !== ref.fromNodeId) return result;
  let memo = OVERLOAD_SETS.get(context);
  if (!memo) OVERLOAD_SETS.set(context, (memo = new Map()));
  let set = memo.get(result.targetNodeId);
  if (set === undefined) {
    set = overloadSetOf(result.targetNodeId, context);
    memo.set(result.targetNodeId, set);
  }
  // Only an overload set has a sibling to move to.
  if (!set || set.own === null) return result;
  const args = cppParenListAfter(ref.filePath, ref.line, Math.max(0, ref.column), set.name, context);
  if (args === null) return result;
  // Swift overloads by argument label as much as by count: Alamofire's
  // `self.tableView(tableView, numberOfRowsInSection: section)` inside
  // `tableView(_:titleForHeaderInSection:)` is the other `tableView`.
  if (ref.language === 'swift') {
    const labels = args.trim() === '' ? [] : splitCppTopLevel(args).map((a) => /^\s*([A-Za-z_]\w*)\s*:(?!:)/.exec(a)?.[1] ?? '_');
    const fitsLabels = (id: string): boolean | null => {
      const decl = context.getNodeById?.(id);
      const list = decl ? cppParenListAfter(decl.filePath, decl.startLine, 0, set!.name, context) : null;
      return list === null ? null : swiftLabelsFit(labels, list);
    };
    if (fitsLabels(result.targetNodeId) !== false) return result;
    const fit = set.siblings.filter((sib) => fitsLabels(sib.id) === true);
    return fit.length === 1 ? { ...result, targetNodeId: fit[0]!.id } : result;
  }
  const argc = args.trim() === '' ? 0 : splitCppTopLevel(args).length;
  if (argc >= set.own.min && argc <= set.own.max) return result;
  const fits = set.siblings.filter((s) => s.arity !== null && argc >= s.arity.min && argc <= s.arity.max);
  return fits.length === 1 ? { ...result, targetNodeId: fits[0]!.id } : result;
}

/**
 * Whether a Swift call's argument labels (`_` for none) fit a declaration's
 * parameter list: each parameter's external label in order, one with a
 * default value or a variadic one free to be left out.
 */
function swiftLabelsFit(labels: string[], paramList: string): boolean {
  const params = paramList.trim() === '' ? [] : splitCppTopLevel(paramList).map((p) => {
    const head = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:inout\s+)?([A-Za-z_]\w*)(?:\s+([A-Za-z_]\w*))?\s*:/.exec(p);
    return { label: head?.[1] ?? '_', optional: /=/.test(p) || /\.\.\./.test(p) };
  });
  let i = 0;
  for (const param of params) {
    if (i < labels.length && labels[i] === param.label) { i++; continue; }
    if (!param.optional) return false;
  }
  return i === labels.length;
}

/** A method's same-owner overloads and every one's arity, read from its declaration. */
function overloadSetOf(id: string, context: ResolutionContext): { name: string; own: Arity; siblings: Array<{ id: string; arity: Arity }> } | null {
  const self = context.getNodeById?.(id);
  if (!self || (self.kind !== 'method' && self.kind !== 'function')) return null;
  const name = self.name;
  const owner = self.qualifiedName.slice(0, Math.max(0, self.qualifiedName.lastIndexOf('::')));
  const siblings = (context.getNodesInFileNamed?.(self.filePath, name) ?? context.getNodesInFile(self.filePath).filter((n) => n.name === name))
    .filter((n) => n.id !== self.id && (n.kind === 'method' || n.kind === 'function') &&
      n.qualifiedName.slice(0, Math.max(0, n.qualifiedName.lastIndexOf('::'))) === owner);
  if (siblings.length === 0) return null;
  const arity = (n: Node): Arity => {
    const list = cppParenListAfter(n.filePath, n.startLine, 0, name, context);
    if (list === null) return null;
    const params = splitCppTopLevel(list).filter((p) => p !== '' && p !== 'void');
    const pack = (p: string) => /\.\.\.|\bparams\s|\bvararg\s/.test(p.replace(/<[^<>]*>/g, ''));
    const min = params.filter((p) => !/=/.test(p) && !pack(p)).length;
    return { min, max: params.some(pack) ? Infinity : params.length };
  };
  return { name, own: arity(self), siblings: siblings.map((n) => ({ id: n.id, arity: arity(n) })) };
}

function matchReferenceInner(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Function-as-value refs (#756) resolve ONLY through the dedicated matcher —
  // never the fuzzy/qualified fallthrough below (a wrong callback edge is
  // worse than none).
  if (ref.referenceKind === 'function_ref') {
    return matchFunctionRef(ref, context);
  }

  // ArkTS chained UI attributes — emitted with a leading dot (`.titleStyle`,
  // `.width`) by the extractor — resolve ONLY to decorator-marked attribute
  // helpers: `@Extend`/`@Styles`/`@AnimatableExtend` functions (and global
  // `@Builder`s used attribute-position). Framework attributes (`.width`,
  // `.fontSize` — on nearly every UI line) match no such helper and stay
  // unresolved, NEVER falling through to bare-name matching: on a samples
  // monorepo that fallthrough manufactured 36k wrong edges, giving single
  // same-named properties thousands of false callers. Ambiguity rule matches
  // the rest of the file: several same-named helpers → prefer the call-site
  // file, still ambiguous → drop the ref rather than guess.
  if (ref.language === 'arkts' && ref.referenceName.startsWith('.')) {
    const base = ref.referenceName.slice(1);
    const candidates = context
      .getNodesByName(base)
      .filter(
        (n) =>
          n.language === 'arkts' &&
          n.kind === 'function' &&
          (n.decorators ?? []).some((d) => ARKUI_ATTRIBUTE_DECORATORS.has(d))
      );
    const chosen =
      candidates.length > 1 ? preferCallSiteFile(candidates, ref.filePath) : candidates;
    if (chosen.length !== 1) return null;
    return {
      original: ref,
      targetNodeId: chosen[0]!.id,
      confidence: 0.85,
      resolvedBy: 'exact-match',
    };
  }

  // `import java.lang.reflect.Field;` — the file's `Field` is the JDK's, never
  // a project class of that name (gson's production code bound it to a test's
  // nested `ParameterizedTypesTest.Field`).
  if ((ref.language === 'java' || ref.language === 'kotlin') && ref.referenceKind !== 'imports' &&
      isJavaOutsideImport(ref.referenceName.split('.')[0]!, ref, context)) {
    return null;
  }

  // A symbolic name in a Scala type is a type (`F ~> G`) or a kind-projector
  // placeholder (`Either[A, *]`) — never an operator method, by any strategy.
  if (ref.language === 'scala' && ref.referenceKind === 'references' && /^[^\w\s]+$/.test(ref.referenceName)) {
    const types = context.getNodesByName(ref.referenceName).filter((n) => n.language === 'scala' && (SCALA_TYPE_KINDS.has(n.kind) || n.kind === 'type_alias'));
    const chosen = types.length > 1 ? preferCallSiteFile(types, ref.filePath) : types;
    return chosen.length === 1 ? { original: ref, targetNodeId: chosen[0]!.id, confidence: 0.8, resolvedBy: 'exact-match' } : null;
  }

  // A bare Lua call through a `local` alias reaches what the alias names.
  if ((ref.language === 'lua' || ref.language === 'luau') && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName)) {
    const aliased = luaAliasTarget(ref, context);
    if (aliased !== undefined) return aliased;
    // `ipairs(t)` is Lua's, unless the file defines its own: telescope's 122
    // `for _, v in ipairs(…)` went to a linked list's `ipairs` method.
    if (LUA_GLOBAL_FUNCTIONS.has(ref.referenceName) &&
        !context.getNodesInFile(ref.filePath).some((n) => n.name === ref.referenceName && n.kind === 'function')) return null;
  }

  // Erlang `-behaviour(m)` refs target a MODULE. Letting them fall through to
  // bare-name matching grabs any same-named symbol — on emqx,
  // `-behaviour(supervisor)` resolved to a `-define(supervisor, …)` macro
  // constant in an unrelated app. Resolve only to the behaviour module's
  // namespace; an out-of-repo behaviour (OTP's gen_server/supervisor) stays
  // unresolved rather than guessed. The same module-only rule applies to every
  // ref an `.app`/`.app.src` resource file emits — its `{mod, …}` callback and
  // `{applications, …}` dependency names can only mean modules, and on emqx
  // the `ssl` OTP app otherwise resolved to a test helper FUNCTION named ssl.
  if (
    ref.language === 'erlang' &&
    (ref.referenceKind === 'implements' || /\.app(?:\.src)?$/i.test(ref.filePath))
  ) {
    const modules = context
      .getNodesByName(ref.referenceName)
      .filter((n) => n.language === 'erlang' && n.kind === 'namespace');
    const chosen = preferCallSiteFile(modules, ref.filePath)[0];
    if (!chosen) return null;
    return {
      original: ref,
      targetNodeId: chosen.id,
      confidence: 0.9,
      resolvedBy: 'exact-match',
    };
  }

  // Erlang call/fun refs carry the call-site arity (`f/1` — #1610) because
  // arity is part of the function's identity and every erlang function's
  // qualifiedName carries it (`mod::f/1`). Resolve ONLY to a definition of
  // that exact arity: the call site's own file first (a local call targets its
  // own module by language semantics; `-import`ed functions ride the
  // cross-file branch), and when no definition of that arity exists anywhere,
  // resolve to NOTHING rather than a sibling arity — the real target may be
  // macro-generated or out of repo, and a wrong-arity edge is worse than none.
  if (
    ref.language === 'erlang' &&
    !ref.referenceName.includes('::') &&
    (ref.referenceKind === 'calls' || ref.referenceKind === 'references')
  ) {
    const am = /^(.+)\/(\d{1,3})$/.exec(ref.referenceName);
    if (am) {
      // endsWith is length-anchored, so `/1` cannot match `…/11`.
      const arityTail = `/${am[2]}`;
      const candidates = context
        .getNodesByName(am[1]!)
        .filter(
          (n) =>
            n.language === 'erlang' && n.kind === 'function' && n.qualifiedName.endsWith(arityTail),
        );
      if (candidates.length > 0) {
        const sameFile = candidates.find((n) => n.filePath === ref.filePath);
        if (sameFile) {
          return { original: ref, targetNodeId: sameFile.id, confidence: 0.95, resolvedBy: 'exact-match' };
        }
        // Another module's function is called bare only through `-import(Mod,
        // [f/N])` (or from a `.hrl` a module includes): cowboy's
        // `-import(req_SUITE, [do_get/3])` went to compress_SUITE's `do_get/3`.
        const imported = erlangImportedModule(am[1]!, am[2]!, ref, context);
        if (imported !== undefined) {
          const chosen = candidates.find((n) => n.qualifiedName.startsWith(`${imported}::`));
          return chosen ? { original: ref, targetNodeId: chosen.id, confidence: 0.9, resolvedBy: 'exact-match' } : null;
        }
        if (!/\.hrl$/.test(ref.filePath)) {
          const included = candidates.filter((n) => /\.hrl$/.test(n.filePath));
          if (included.length === 0) return null;
          candidates.splice(0, candidates.length, ...included);
        }
        if (candidates.length === 1) {
          return { original: ref, targetNodeId: candidates[0]!.id, confidence: 0.8, resolvedBy: 'exact-match' };
        }
        const best = findBestMatch(ref, candidates, context);
        if (best) {
          const proximity = computePathProximity(ref.filePath, best.filePath);
          return {
            original: ref,
            targetNodeId: best.id,
            confidence: proximity >= 30 ? 0.7 : 0.4,
            resolvedBy: 'exact-match',
          };
        }
      }
      return null;
    }
  }

  if (isUnresolvedJsMemberCall(ref)) return null;

  // A Swift call through a type path (`API.PackageController.GetRoute.query`)
  // resolves on the type the path names, or not at all: the strategies below
  // would bind it by the member's name alone.
  if (ref.language === 'swift' && ref.referenceKind === 'calls' && SWIFT_TYPE_PATH_CALL.test(ref.referenceName)) {
    return nmTimed('swiftTypePath', ref, () => resolveSwiftTypePathCall(ref, context));
  }

  // Try strategies in order of confidence
  let result: ResolvedRef | null;

  // 0. File path match (e.g., "snippets/drawer-menu.liquid" → file node)
  result = nmTimed('filePath', ref, () => matchByFilePath(ref, context));
  if (result) return result;

  // 1. Qualified name match (highest confidence)
  result = nmTimed('qualifiedName', ref, () => matchByQualifiedName(ref, context));
  if (result) return result;

  // 1b. C++ chained call whose receiver is another call — `Foo::instance().bar()`
  // encoded as `Foo::instance().bar` by the extractor (#645). Resolve the
  // receiver's type from what the inner call returns, then the method on it.
  if (ref.language === 'cpp' || ref.language === 'c') {
    result = nmTimed('cppChain', ref, () => matchCppCallChain(ref, context));
    if (result) return result;
  }

  // 1c. `::`-scoped factory chain — PHP `Cls::for($x)->method()` (#608) or Rust
  // `Foo::new().bar()`, both encoded as `Cls::factory().method`. The receiver's
  // type is the factory's `self` (PHP `: self`/`: static`, Rust `-> Self`) or
  // concrete return type.
  if (ref.language === 'php' || ref.language === 'rust') {
    result = nmTimed('scopedChain', ref, () => matchScopedCallChain(ref, context));
    if (result) return result;
  }

  // 1d. Dotted chained static-factory / fluent call (Java / Kotlin / C# / Swift /
  // Go / Scala / Dart / Objective-C) — `Foo.getInstance().bar()` encoded as
  // `Foo.getInstance().bar`, Go's bare-factory `New().Method()` as `New().Method`,
  // Scala's companion factory, Dart's static factory / factory-constructor, or
  // ObjC's chained message send `[[Foo create] doIt]` encoded as `Foo.create().doIt`
  // (#645/#608 mechanism). Resolve the method's class from the inner call's
  // declared return type, then validate it.
  if (
    ref.language === 'java' ||
    ref.language === 'kotlin' ||
    ref.language === 'csharp' ||
    ref.language === 'swift' ||
    ref.language === 'go' ||
    ref.language === 'scala' ||
    ref.language === 'dart' ||
    ref.language === 'objc' ||
    ref.language === 'pascal'
  ) {
    result = nmTimed('dottedChain', ref, () => matchDottedCallChain(ref, context));
    if (result) return result;
  }

  // A call-receiver chain the extractor encoded as `<inner>().<method>` for a
  // language with no chain resolver above (TS/JS, Python — #1683) is a
  // receiver whose type is unknown. Nothing below may guess for it: the
  // method-call pattern rejects the parens, exact name never matches, but the
  // fuzzy strategy splits on `.` and would hand `make().run` to any `run` —
  // the fabricated edge the encoding exists to prevent.
  if (
    ref.referenceName.includes('().') &&
    (ref.language === 'typescript' || ref.language === 'javascript' || ref.language === 'tsx' || ref.language === 'jsx' || ref.language === 'python')
  ) {
    return nmTimed('storeAccessorChain', ref, () => matchStoreAccessorChain(ref, context));
  }

  // 2. Method call pattern
  result = nmTimed('methodCall', ref, () => matchMethodCall(ref, context));
  if (result) return result;

  // 3. Exact name match
  result = nmTimed('exactName', ref, () => matchByExactName(ref, context));
  if (result) return result;

  // 4. Fuzzy match (lowest confidence)
  result = nmTimed('fuzzy', ref, () => matchFuzzy(ref, context));
  if (result) return result;

  // 5. A C / C++ name qualified by a namespace the project opens with a macro
  // (`fmt::format` — `FMT_BEGIN_NAMESPACE`), which the index cannot see.
  if ((ref.language === 'cpp' || ref.language === 'c') && ref.referenceName.includes('::')) {
    return matchCppMacroNamespaced(ref, context);
  }

  return null;
}
