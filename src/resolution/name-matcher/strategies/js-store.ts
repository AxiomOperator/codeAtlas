/**
 * JS store-binding strategies (zustand-style stores: selectors, destructured state, accessor chains).
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from '../../types';
import { blankStringContents, stripCommentsForRegex } from '../../strip-comments';
import { JS_FAMILY, JS_TS, isBareJsCall } from '../call-shape';
import { sameLanguageFamily } from '../language-family';
import { rangeWithin, resolveObjectLiteralMember, sameRange } from '../object-literal';
import { enclosingScopeStartLine } from '../receiver-inference';
import { isLexicallyReachable } from '../visibility';

/**
 * The one fallback a TS/JS/Python call-receiver chain keeps (#1683): a STORE
 * ACCESSOR. Zustand's `get()` inside the store factory and
 * `useStore.getState()` outside it hand back the store whose actions are
 * indexed as functions (#1573). JS/TS resolves the member within that store;
 * the existing Python fallback still requires a unique callable. Nothing else
 * qualifies: a chain rooted in a project value still says nothing about what
 * the inner call RETURNS — `db.prepare(sql).all()` would bind to any project
 * function named `all` — so it resolves to nothing, exactly like a chain
 * rooted in a parameter (`d.setdefault(k, []).append(v)`).
 */
export function matchStoreAccessorChain(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const m = ref.referenceName.match(/^([\w$.]+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const inner = m[1];
  const method = m[2];
  if (!(inner === 'get' || inner === 'getState' || inner.endsWith('.getState'))) return null;
  if (JS_FAMILY.has(ref.language)) {
    return resolveStoreAction(inner, method, ref, context);
  }
  const callables = context
    .getNodesByName(method)
    .filter((n) => (n.kind === 'function' || n.kind === 'method') && sameLanguageFamily(n.language, ref.language) && n.id !== ref.fromNodeId);
  if (callables.length !== 1) return null;
  return { original: ref, targetNodeId: callables[0]!.id, confidence: 0.6, resolvedBy: 'exact-match' };
}

/** Resolve the implementation inside the identified store, not a namesake or
 * an interface signature elsewhere in the project. Import resolution already
 * follows aliases/barrels; containment already excludes nested action locals. */
function resolveStoreAction(inner: string, member: string, ref: UnresolvedRef, context: ResolutionContext, selector = false): ResolvedRef | null {
  let holders: Node[];
  if (inner === 'get' || inner === 'getState') {
    const caller = context.getNodeById?.(ref.fromNodeId);
    if (!caller) return null;
    holders = context.getNodesInFile(ref.filePath).filter((n) => {
      if ((n.kind !== 'constant' && n.kind !== 'variable') || !rangeWithin(caller, n)) return false;
      const source = context.readFile(n.filePath)?.split('\n').slice(n.startLine - 1, caller.startLine).join('\n') ?? '';
      // The accessor must actually be a parameter of the enclosing factory.
      return new RegExp(`\\(\\s*[\\w$]+\\s*,\\s*${inner}\\s*(?:,\\s*[\\w$]+\\s*)?\\)\\s*=>`).test(source);
    });
  } else {
    const name = inner.slice(0, -'.getState'.length);
    if (!/^[\w$]+$/.test(name)) return null;
    const imported = context.resolveImport?.({ ...ref, referenceName: name, referenceKind: 'references' });
    const node = imported && context.getNodeById?.(imported.targetNodeId);
    if (node && importShadowedAt(name, ref, context)) return null;
    holders = node ? [node] : context.getNodesByName(name).filter((n) =>
      n.filePath === ref.filePath && isLexicallyReachable(n, ref, context));
  }
  if (holders.length !== 1) return null;
  const holder = holders[0]!;
  if (selector) {
    // Only a Zustand hook promises to return the selector's result. An
    // arbitrary function accepting that callback is not a store binding.
    const text = context.readFile(holder.filePath)?.split('\n').slice(holder.startLine - 1, holder.endLine).join('\n') ?? '';
    const escaped = holder.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const factory = new RegExp(`\\b(?:const|let)\\s+${escaped}\\s*=\\s*([\\w$]+)\\s*[<(]`).exec(text)?.[1];
    if (!factory || !context.getImportMappings(holder.filePath, holder.language).some(m =>
      m.localName === factory && m.source === 'zustand' && (m.exportedName === 'create' || m.isDefault))) return null;
  }
  return resolveObjectLiteralMember(holder, member, ref, context, 0.9, 'instance-method');
}

// Eligibility is a file property, not a call-site property. Cache both answers
// within the same stable-source window as the resolver's file cache; sync drops
// it via clearNameMatcherMemos. Keep only booleans, FIFO-capped like PATTERN_MEMO
// to avoid per-hit LRU churn. Eviction merely repeats the source scan.
export const GET_STATE_FILES = new WeakMap<ResolutionContext, Map<string, boolean>>();
const GET_STATE_FILES_CAP = 8192;

/** A const destructuring is a bound reference, so it is eligible even though
 * arbitrary locally-bound bare calls must never guess a cross-file target. */
function matchDestructuredStoreCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  let files = GET_STATE_FILES.get(context);
  if (!files) { files = new Map(); GET_STATE_FILES.set(context, files); }
  let eligible = files.get(ref.filePath);
  let source: string | null | undefined;
  if (eligible === undefined) {
    source = context.readFile(ref.filePath);
    eligible = source?.includes('.getState') ?? false;
    if (files.size >= GET_STATE_FILES_CAP) {
      const oldest = files.keys().next().value;
      if (oldest !== undefined) files.delete(oldest);
    }
    files.set(ref.filePath, eligible);
  }
  if (!eligible) return null;
  source ??= context.readFile(ref.filePath);
  if (!source) return null;
  const lines = source.split('\n');
  const start = enclosingScopeStartLine(ref, context) - 1;
  const before = lines.slice(start, ref.line - 1).concat(lines[ref.line - 1]!.slice(0, ref.column)).join('\n');
  const code = blankStringContents(stripCommentsForRegex(before, 'typescript'));
  const name = ref.referenceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const binding = /\bconst\s*\{([^{}]*)\}\s*=\s*([\w$]+)\.getState\s*\(\s*\)/g;
  // Compare block identities, not just nesting depth: a binding in a sibling
  // or already-closed block is not in scope at this call.
  const stackAt = (end: number): number[] => {
    const stack: number[] = [];
    for (let i = 0; i < end; i++) {
      if (code[i] === '{') stack.push(i);
      else if (code[i] === '}') stack.pop();
    }
    return stack;
  };
  const callScope = stackAt(code.length);
  for (const m of [...code.matchAll(binding)].reverse()) {
    // Plain named bindings only; defaults, rest and computed keys need their
    // own value tracing rather than a same-name guess.
    if (!m[1]!.split(',').some(part => part.trim() === ref.referenceName)) continue;
    const scope = stackAt(m.index!);
    if (!scope.every((pos, i) => callScope[i] === pos)) continue;
    const rest = code.slice(m.index! + m[0].length);
    // Keep the guard when another declaration shadows the captured const.
    if (new RegExp(`\\b(?:const|let|var|function|class)\\s+(?:${name}\\b|\\{[^}]*\\b${name}\\b)`).test(rest)) return null;
    return resolveStoreAction(`${m[2]}.getState`, ref.referenceName, ref, context);
  }
  return null;
}

interface DestructuredBinding {
  index: number;
  end: number;
  callee: string;
  /** Local name → the key it is destructured from (the last plain part wins). */
  names: Map<string, string>;
}

/** Every `const { a, b: c } = f(…)` binding in comment- and string-blanked JS text. */
function destructuredBindings(code: string): DestructuredBinding[] {
  const binding = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g;
  const out: DestructuredBinding[] = [];
  for (const m of code.matchAll(binding)) {
    const names = new Map<string, string>();
    for (const part of m[1]!.split(',')) {
      const [k, v] = part.split(':').map((x) => x.trim().replace(/\s*=.*$/, ''));
      // Flat copies: a slice of the match would pin the whole file's text.
      if (/^[A-Za-z_$][\w$]*$/.test(k ?? '')) names.set(Buffer.from((v ?? k)!).toString(), Buffer.from(k!).toString());
    }
    out.push({ index: m.index!, end: m.index! + m[0].length, callee: Buffer.from(m[2]!).toString(), names });
  }
  return out;
}

/** Positions of the `{` still open at `end` — a block's identity, not only its depth. */
function braceStackAt(code: string, end: number): number[] {
  const stack: number[] = [];
  for (let i = 0; i < end; i++) {
    if (code[i] === '{') stack.push(i);
    else if (code[i] === '}') stack.pop();
  }
  return stack;
}

interface DestructuredFile {
  source: string;
  /** The whole file, comments and string contents blanked; null without a destructuring. */
  code: string | null;
  lineStarts: number[];
  /** Start and closing-slash offsets of the regex literals the blanking skipped. */
  regexSpans: number[];
  bindings: DestructuredBinding[];
  names: Set<string>;
}

/**
 * matchDestructuredCallResult's per-file scan, done once per file instead of
 * once per bare call over every line above it (#2334: quadratic in the file's
 * size on bundled libraries). Refs arrive grouped by file, so a few recent
 * files per context suffice.
 */
const DESTRUCTURED_FILES = new WeakMap<ResolutionContext, Map<string, DestructuredFile>>();
const DESTRUCTURED_FILES_CAP = 4;

function destructuredFile(filePath: string, source: string, context: ResolutionContext): DestructuredFile {
  let files = DESTRUCTURED_FILES.get(context);
  if (!files) DESTRUCTURED_FILES.set(context, (files = new Map()));
  const cached = files.get(filePath);
  if (cached && cached.source === source) return cached;
  const file: DestructuredFile = { source, code: null, lineStarts: [], regexSpans: [], bindings: [], names: new Set() };
  if (/\b(?:const|let|var)\s*\{/.test(source)) {
    file.code = blankStringContents(stripCommentsForRegex(source, 'typescript'), file.regexSpans);
    file.lineStarts.push(0);
    for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) file.lineStarts.push(i + 1);
    file.bindings = destructuredBindings(file.code);
    for (const b of file.bindings) for (const local of b.names.keys()) file.names.add(local);
  }
  files.delete(filePath);
  if (files.size >= DESTRUCTURED_FILES_CAP) files.delete(files.keys().next().value!);
  files.set(filePath, file);
  return file;
}

/**
 * Whether blanking only the text above `cut` would differ from the whole
 * file's blanking cut there. Both passes run left to right and only blank, so
 * they agree up to the cut except where they looked past it: a `//` or `/*`
 * whose second character is the first one cut, or a regex literal that opens
 * above the cut and closes at or after it.
 */
function destructuredCutDiverges(file: DestructuredFile, source: string, cut: number): boolean {
  if (cut > 0 && source[cut - 1] === '/' && (source[cut] === '/' || source[cut] === '*')) return true;
  const spans = file.regexSpans;
  let lo = 0;
  let hi = spans.length / 2;
  // The last regex literal opening above the cut.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[2 * mid]! < cut) lo = mid + 1; else hi = mid;
  }
  return lo > 0 && spans[2 * (lo - 1) + 1]! >= cut;
}

/**
 * A bare call through a name destructured from a call's result — a composable
 * or custom hook, `const { getDefaultActivityRoute } = useDefaultActivity()`
 * (mealie), `const { login } = useAuth()` — is the function the callee returns
 * under that key: one declared in the callee's own body, else a top-level one
 * of the callee's module (returned as `{ getDefaultActivityRoute, … }`). The
 * callee is resolved through the file's imports (or found in the same file),
 * and its source must return the key; a later declaration of the name at the
 * call's scope shadows the binding. The local binding otherwise ruled out
 * every cross-file candidate, so the call resolved to nothing.
 */
export function matchDestructuredCallResult(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const source = context.readFile(ref.filePath);
  if (!source) return null;
  const file = destructuredFile(ref.filePath, source, context);
  if (!file.code) return null;
  // The text above the call, as the scan sees it: the file's, cut at the call,
  // unless a regex literal the file scan skipped runs past the cut (#2334).
  const lineStart = file.lineStarts[ref.line - 1];
  let code = file.code;
  let bindings = file.bindings;
  let cut: number;
  if (lineStart === undefined || ref.line < 1 || ref.column < 0) {
    cut = -1;
  } else {
    const lineEnd = file.lineStarts[ref.line] !== undefined ? file.lineStarts[ref.line]! - 1 : source.length;
    cut = lineStart + Math.min(Math.max(ref.column, 0), lineEnd - lineStart);
  }
  if (cut < 0 || destructuredCutDiverges(file, source, cut)) {
    const lines = source.split('\n');
    const before = lines.slice(0, ref.line - 1).concat(lines[ref.line - 1]?.slice(0, ref.column) ?? '').join('\n');
    code = blankStringContents(stripCommentsForRegex(before, 'typescript'));
    bindings = destructuredBindings(code);
    cut = code.length;
  } else if (!file.names.has(ref.referenceName)) {
    // No binding in the file introduces the name: the common case, at no cost.
    return null;
  }
  const name = ref.referenceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let callScope: number[] | null = null;
  for (let b = bindings.length - 1; b >= 0; b--) {
    const m = bindings[b]!;
    if (m.end > cut) continue;
    const key = m.names.get(ref.referenceName);
    if (!key) continue;
    callScope ??= braceStackAt(code, cut);
    if (!braceStackAt(code, m.index).every((pos, i) => callScope![i] === pos)) continue;
    const rest = code.slice(m.end, cut);
    if (new RegExp(`\\b(?:const|let|var|function|class)\\s+(?:${name}\\b|\\{[^}]*\\b${name}\\b)`).test(rest)) return null;
    const calleeName = m.callee;
    const imported = context.resolveImport?.({ ...ref, referenceName: calleeName, referenceKind: 'calls' });
    // Through the import; else the same file's; else the one function of that
    // name in the project (an alias the import resolver can't follow, like
    // Nuxt's `~/composables/…`) — the returned key is checked below either way.
    const holders = context.getNodesByName(calleeName).filter((n) =>
      (n.kind === 'function' || n.kind === 'constant' || n.kind === 'variable') && sameLanguageFamily(n.language, ref.language));
    const callee = (imported && context.getNodeById?.(imported.targetNodeId)) ??
      holders.find((n) => n.filePath === ref.filePath) ??
      (holders.length === 1 ? holders[0] : undefined);
    if (!callee || !sameLanguageFamily(callee.language, ref.language)) return null;
    const calleeText = (context.getFileLines?.(callee.filePath) ?? context.readFile(callee.filePath)?.split('\n') ?? [])
      .slice(callee.startLine - 1, callee.endLine).join('\n');
    if (!new RegExp(`\\breturn\\s*\\{[^]*?\\b${key}\\b`).test(calleeText)) return null;
    const callable = (n: Node) => n.kind === 'function' || n.kind === 'method' || n.kind === 'constant' || n.kind === 'variable';
    const inFile = context.getNodesInFile(callee.filePath);
    const inner = inFile.filter((n) => n.name === key && callable(n) && n.id !== callee.id && rangeWithin(n, callee) &&
      !inFile.some((f) => f.id !== callee.id && f.id !== n.id && (f.kind === 'function' || f.kind === 'method') &&
        rangeWithin(f, callee) && rangeWithin(n, f) && !sameRange(f, n)));
    const top = inner.length > 0 ? inner : inFile.filter((n) => n.name === key && callable(n) && !n.qualifiedName.includes('::') &&
      !inFile.some((f) => (f.kind === 'function' || f.kind === 'method') && f.id !== n.id && rangeWithin(n, f) && !sameRange(f, n)));
    const target = top.sort((a, b) => Number(b.kind === 'function') - Number(a.kind === 'function'))[0];
    if (!target) return null;
    return { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'instance-method' };
  }
  return null;
}

/** Bound action names need not have a same-named definition (selectors may
 * rename them). The resolver's symbol-existence prefilter must allow them. */
export function matchJsStoreBindingCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!isBareJsCall(ref, context)) return null;
  return matchDestructuredStoreCall(ref, context) ?? matchSelectedStoreCall(ref, context);
}

/** A qualified untyped chain is useful source evidence, not permission to
 * infer a property type. Framework resolution runs before this guard. Vue,
 * Svelte and Astro files keep resolving them: there `api.groupReports.getAll()`
 * reaches its API client class far more often than a wrong namesake. */
export function isUnresolvedJsMemberCall(ref: UnresolvedRef): boolean {
  return ref.referenceKind === 'calls' && JS_TS.has(ref.language) &&
    !/^(?:this|window)\./.test(ref.referenceName) &&
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){2,}$/.test(ref.referenceName);
}

export const SELECTOR_NAMES = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/** A selector returns the named action from one identified store. Keep the
 * lexical block identity so closures may capture it but sibling scopes and
 * shadowing parameters/declarations cannot donate a binding. */
function matchSelectedStoreCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const source = context.readFile(ref.filePath);
  if (!source?.includes('=>')) return null;
  let files = SELECTOR_NAMES.get(context);
  if (!files) { files = new Map(); SELECTOR_NAMES.set(context, files); }
  let names = files.get(ref.filePath);
  if (!names) {
    names = new Set([...source.matchAll(/\bconst\s+([\w$]+)\s*=\s*[\w$]+\s*\(\s*(?:\(\s*[\w$]+\s*\)|[\w$]+)\s*=>/g)].map(m => m[1]!));
    files.set(ref.filePath, names);
  }
  if (!names.has(ref.referenceName)) return null;
  const name = ref.referenceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = source.split('\n');
  const before = lines.slice(0, ref.line - 1).concat(lines[ref.line - 1]!.slice(0, ref.column)).join('\n');
  const code = blankStringContents(stripCommentsForRegex(before, 'typescript'));
  const binding = new RegExp(`\\bconst\\s+${name}\\s*=\\s*([\\w$]+)\\s*\\(\\s*(?:\\(\\s*([\\w$]+)\\s*\\)|([\\w$]+))\\s*=>\\s*([\\w$]+)\\.([\\w$]+)\\s*\\)`, 'g');
  const stackAt = (end: number): number[] => {
    const stack: number[] = [];
    for (let i = 0; i < end; i++) {
      if (code[i] === '{') stack.push(i);
      else if (code[i] === '}') stack.pop();
    }
    return stack;
  };
  const callScope = stackAt(code.length);
  for (const m of [...code.matchAll(binding)].reverse()) {
    if ((m[2] ?? m[3]) !== m[4]) continue;
    if (!stackAt(m.index!).every((pos, i) => callScope[i] === pos)) continue;
    const rest = code.slice(m.index! + m[0].length);
    if (new RegExp(`\\b(?:const|let|var|function|class)\\s+(?:${name}\\b|\\{[^}]*\\b${name}\\b)`).test(rest) ||
        hasParameterBinding(rest, name)) return null;
    return resolveStoreAction(`${m[1]}.getState`, m[5]!, ref, context, true);
  }
  return null;
}

/** Import resolution names the module binding; a nearer parameter or block
 * declaration can shadow that binding at this particular call site. */
export function importShadowedAt(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const fn of context.getNodesInFile(ref.filePath)) {
    if ((fn.kind === 'function' || fn.kind === 'method') && fn.startLine <= ref.line && fn.endLine >= ref.line &&
        fn.signature && hasParameterBinding(`${fn.signature} {`, escaped)) return true;
  }
  const lines = (context.readFile(ref.filePath) ?? '').split('\n');
  const before = lines.slice(0, ref.line - 1).concat(lines[ref.line - 1]?.slice(0, ref.column) ?? '').join('\n');
  const code = blankStringContents(stripCommentsForRegex(before, 'typescript'));
  const stackAt = (end: number): number[] => {
    const stack: number[] = [];
    for (let i = 0; i < end; i++) {
      if (code[i] === '{') stack.push(i);
      else if (code[i] === '}') stack.pop();
    }
    return stack;
  };
  const scope = stackAt(code.length);
  const declarations = new RegExp(`\\b(?:const|let|var|function|class)\\s+(?:${escaped}\\b|\\{[^}]*\\b${escaped}\\b)`, 'g');
  return [...code.matchAll(declarations)].some(m => stackAt(m.index!).every((p, i) => scope[i] === p));
}

/** Balanced parameter lists also cover function-typed parameters, whose own
 * parentheses must not make the outer shadow invisible. Conservative when a
 * parameter's type mentions the same name: leave that call unresolved. */
export function hasParameterBinding(code: string, escapedName: string): boolean {
  const name = new RegExp(`\\b${escapedName}\\b`);
  if (new RegExp(`\\b${escapedName}\\s*=>`).test(code)) return true;
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '(' || /\b(?:if|while|for|switch|with)\s*$/.test(code.slice(0, i))) continue;
    let depth = 1, j = i + 1;
    for (; j < code.length && depth; j++) {
      if (code[j] === '(') depth++;
      else if (code[j] === ')') depth--;
    }
    if (depth === 0 && name.test(code.slice(i + 1, j - 1)) &&
        /^\s*(?::[^=;{]*)?(?:=>|\{)/.test(code.slice(j))) return true;
  }
  return false;
}

/**
 * Split a camelCase or PascalCase string into words.
 */
/**
 * Whether a receiver written as `Name` is a type in `language`'s conventions.
 * Not in Go (an exported package variable is `FormPost`), nor C / C++ / Rust
 * (their type paths use `::`); in Pascal every identifier is capitalized, so
 * only Delphi's type prefixes (`TFoo`, `EFoo`, `IFoo`) and `Exception` count —
 * `AWebRequest` / `LRequest` are a parameter and a local.
 */
export function namesExternalType(receiver: string, language: string): boolean {
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(receiver)) return false;
  if (language === 'pascal') return /^(?:[TEI][A-Z]\w*|Exception)$/.test(receiver);
  // Rust: `Vec::new()`, `String::from(…)`, `Default::default()` — but `Self::` is the impl's own type,
  // and a SCREAMING_CASE receiver (`REQ_ID.scope(…)`) a static.
  if (language === 'rust') return receiver !== 'Self' && /[a-z]/.test(receiver);
  return !['go', 'c', 'cpp', 'cuda', 'metal'].includes(language);
}
