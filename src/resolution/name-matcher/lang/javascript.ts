/**
 * JavaScript / TypeScript scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolutionContext } from '../../types';
import { stripCommentsForRegex } from '../../strip-comments';
import { JS_FAMILY, WHITESPACE, bareCallReceiver } from '../call-shape';

/** Per-context memo: `file\0name` → "the file binds this name locally". */
/** Whether `n` lies outside the function that binds the reference's name itself (see jsFunctionLocalScope). */
export function isOutsideJsLocal(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  // `const indexName = this.dataSource.namingStrategy.indexName(…)`: a member, whatever the local's name.
  if (ref.referenceKind === 'calls' && bareCallReceiver(ref, context) !== null) return false;
  const scope = jsFunctionLocalScope(ref.referenceName, ref, context);
  return scope !== null && !(n.filePath === ref.filePath && n.startLine >= scope.start && n.startLine <= scope.end);
}

const JS_FN_LOCAL_MEMO = new WeakMap<ResolutionContext, Map<string, { start: number; end: number } | null>>();

/**
 * The lines of the JS/TS function a reference sits in when that function binds
 * the name itself — a parameter, or a `var`/`let`/`const` above the reference.
 * Such a name is the local, never a same-named function declared elsewhere:
 * every lodash helper lives inside `runInContext`, so `baseHas(object, key)`'s
 * `object` and `mixin`'s `object(this.__wrapped__)` reached a `function
 * object() {}` an IIFE declares there. Null when the function does not bind it.
 */
export function jsFunctionLocalScope(name: string, ref: UnresolvedRef, context: ResolutionContext): { start: number; end: number } | null {
  if (!JS_FAMILY.has(ref.language) || !/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  let memo = JS_FN_LOCAL_MEMO.get(context);
  if (!memo) JS_FN_LOCAL_MEMO.set(context, (memo = new Map()));
  const key = `${ref.fromNodeId}\0${name}\0${ref.line}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let scope: { start: number; end: number } | null = null;
  const fn = context.getNodeById?.(ref.fromNodeId);
  if (fn && (fn.kind === 'function' || fn.kind === 'method') && fn.startLine <= ref.line && fn.endLine >= ref.line) {
    const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? [];
    const text = stripCommentsForRegex(lines.slice(fn.startLine - 1, ref.line).join('\n'), 'javascript');
    const { param } = localBindingPatterns(name, 'g');
    const n = name.replace(/\$/g, '\\$');
    // A plain declaration. Destructuring re-binds what a call returns under
    // the same name — `const { t } = useI18n()`, `const { getLabel } =
    // useProps(props)` — which is the same-named function more often than not.
    const declared = new RegExp(`\\b(?:const|let|var)\\s+${n}\\b(?!\\s*[,\\]}])`).test(text);
    // A parameter list — never a control-flow head (`if (openMarkerClose) {`).
    // A return type stays on its line, never a ternary's `: data.slice()` below `filter(canRowExpand)`.
    const parameter = new RegExp(`(?<!\\b(?:if|while|for|switch|with)\\s*)${param.source.replace('(?::[^=;{]*)?', '(?::[^=;{}()\\n]*)?')}`);
    if (declared || parameter.test(text)) scope = { start: fn.startLine, end: fn.endLine };
  }
  memo.set(key, scope);
  return scope;
}

export const LOCAL_BINDING_MEMO = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * Where a file's local bindings can start, for isLocallyBoundJsName: every
 * `const`/`let`/`var` and `function`/`class` keyword and every `=>`. Each
 * binding pattern can only match from one of these (or, for a parameter,
 * from the `(` before an occurrence of the name), so a lookup tries its
 * patterns at those offsets instead of searching the file once per pattern
 * per name. Kept for the last few files — calls arrive file by file.
 */
interface LocalBindingSites {
  varDecls: number[];
  fnDecls: number[];
  arrows: number[];
}
export const LOCAL_BINDING_SITES = new WeakMap<ResolutionContext, Map<string, LocalBindingSites>>();
const LOCAL_BINDING_SITES_KEEP = 16;
const VAR_DECL_SITE = /\b(?:const|let|var)\s/g;
const FN_DECL_SITE = /\b(?:function|class)\s/g;

function localBindingSites(filePath: string, source: string, context: ResolutionContext): LocalBindingSites {
  let cache = LOCAL_BINDING_SITES.get(context);
  if (!cache) {
    cache = new Map();
    LOCAL_BINDING_SITES.set(context, cache);
  }
  let sites = cache.get(filePath);
  if (!sites) {
    const offsets = (re: RegExp): number[] => Array.from(source.matchAll(re), (m) => m.index!);
    const arrows: number[] = [];
    for (let a = source.indexOf('=>'); a !== -1; a = source.indexOf('=>', a + 2)) arrows.push(a);
    sites = { varDecls: offsets(VAR_DECL_SITE), fnDecls: offsets(FN_DECL_SITE), arrows };
    if (cache.size >= LOCAL_BINDING_SITES_KEEP) cache.delete(cache.keys().next().value!);
    cache.set(filePath, sites);
  }
  return sites;
}

type LocalBindingPatterns = { decl: RegExp; fn: RegExp; param: RegExp };
/** Sticky binding patterns by name — the same names recur file after file. */
const LOCAL_BINDING_PATTERNS = new Map<string, LocalBindingPatterns>();
const LOCAL_BINDING_PATTERNS_CAP = 4096;
const JS_BINDING_NAME = /^[\w$]+$/;
const ARROW_HEAD_CHAR = /[\w$.]/;
const IMPORT_BINDING_VALUE = /^\s*(?:await\s+)?(?:require|import)\s*\(/;

function localBindingPatterns(name: string, flags: string): LocalBindingPatterns {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    // `const { name } = require('./m')` / `= await import('./m')` binds an IMPORT,
    // not a shadow: the symbol lives in the other file and the call means it.
    decl: new RegExp(
      '\\b(?:const|let|var)\\s+(?:' + n + '\\b|[{\\[][^;=]*?\\b' + n + '\\b[^;=]*?[}\\]])\\s*(?:=\\s*([^;\\n]*))?',
      flags
    ),
    fn: new RegExp('\\b(?:function|class)\\s+' + n + '\\b', flags),
    // a parameter: every token before the name in the list is itself a
    // parameter (identifier, optional type, optional default) — so a string
    // argument containing the word cannot match.
    // Each earlier parameter has exactly one parse: its first non-space
    // character after the identifier picks the type (`?`/`:`), default (`=`)
    // or bare alternative. Written as `(type)?(default)?\s*`, the same
    // strings split several ways per parameter, and a failing search
    // backtracked through every combination — 30-40s per name on a vscode
    // test file whose helper takes nine `name: T = value` parameters.
    param: new RegExp(
      '\\(\\s*(?:(?:\\.\\.\\.)?[\\w$]+(?:\\s*(?:\\?\\s*)?:[^,()]+|\\s*=[^,()]+|\\s*),\\s*)*' +
        n + '\\b(?:\\s*\\??\\s*:[^,()]*)?(?:\\s*=[^,()]*)?(?:\\s*,\\s*[^()]*)?\\)\\s*(?::[^=;{]*)?(?:=>|\\{)',
      flags
    ),
  };
}

/**
 * Whether a JS/TS file binds `name` itself — as a `const`/`let`/`var`/
 * `function`/`class` declaration (destructuring included) or as a parameter
 * of a function or arrow. Such a binding shadows every same-named symbol in
 * other files, so a bare call to it has no cross-file candidate: the
 * `resolve` of `new Promise((resolve, reject) => …)`, a spec's
 * `const transform = await makeTransform()`, a factory's `const now =
 * options.now || (() => new Date())`. None of these is a node the graph
 * holds (a parameter, a const bound to a call result), so without this the
 * matcher hands the call to whichever other file defines the name — and
 * once methods stop being candidates for a bare call (#1714), the function
 * that was out-ranked steps in. Read from source, memoised per file+name.
 */
export function isLocallyBoundJsName(name: string, filePath: string, context: ResolutionContext): boolean {
  let memo = LOCAL_BINDING_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    LOCAL_BINDING_MEMO.set(context, memo);
  }
  const key = filePath + '\0' + name;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const source = context.readFile(filePath) ?? '';
  const bound = JS_BINDING_NAME.test(name)
    ? bindsAtSites(source, name, localBindingSites(filePath, source, context))
    : bindsAnywhere(source, name);
  memo.set(key, bound);
  return bound;
}

/** isLocallyBoundJsName's patterns, searched through the whole source. */
function bindsAnywhere(source: string, name: string): boolean {
  const { decl, fn, param } = localBindingPatterns(name, 'g');
  for (const m of source.matchAll(decl)) {
    if (!IMPORT_BINDING_VALUE.test(m[1] ?? '')) return true;
  }
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return fn.test(source) || param.test(source) || new RegExp('(?:^|[^\\w$.])' + n + '\\s*=>').test(source);
}

/**
 * bindsAnywhere for a plain identifier, tried only where a match can start:
 * a declaration at its keyword (in order, resuming past each match exactly as
 * the global search does), a parameter at the `(` its list opens with — the
 * last `(` before an occurrence of the name, with no `)` between, since no
 * earlier parameter can hold a parenthesis — and `name =>` at each arrow.
 */
function bindsAtSites(source: string, name: string, sites: LocalBindingSites): boolean {
  let patterns = LOCAL_BINDING_PATTERNS.get(name);
  if (!patterns) {
    patterns = localBindingPatterns(name, 'y');
    if (LOCAL_BINDING_PATTERNS.size >= LOCAL_BINDING_PATTERNS_CAP) {
      LOCAL_BINDING_PATTERNS.delete(LOCAL_BINDING_PATTERNS.keys().next().value!);
    }
    LOCAL_BINDING_PATTERNS.set(name, patterns);
  }
  const { decl, fn, param } = patterns;
  let from = 0;
  for (const at of sites.varDecls) {
    if (at < from) continue;
    decl.lastIndex = at;
    const m = decl.exec(source);
    if (!m) continue;
    from = at + m[0].length;
    if (!IMPORT_BINDING_VALUE.test(m[1] ?? '')) return true;
  }
  for (const at of sites.fnDecls) {
    fn.lastIndex = at;
    if (fn.test(source)) return true;
  }
  let tried = -1;
  for (let at = source.indexOf(name); at !== -1; at = source.indexOf(name, at + 1)) {
    const open = at > 0 ? source.lastIndexOf('(', at - 1) : -1;
    if (open < 0 || open === tried || source.lastIndexOf(')', at - 1) > open) continue;
    tried = open;
    param.lastIndex = open;
    if (param.test(source)) return true;
  }
  // `name =>`: the name ends where the whitespace before the arrow starts.
  for (const arrow of sites.arrows) {
    let end = arrow;
    while (end > 0 && WHITESPACE.test(source[end - 1]!)) end--;
    const start = end - name.length;
    if (start >= 0 && source.startsWith(name, start) && (start === 0 || !ARROW_HEAD_CHAR.test(source[start - 1]!))) {
      return true;
    }
  }
  return false;
}
