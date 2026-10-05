/**
 * Python scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import * as path from 'path';
import { Node } from '../../../types';
import { UnresolvedRef, ResolutionContext, ImportMapping } from '../../types';
import { stripCommentsForRegex } from '../../strip-comments';
import { isTestPath } from '../../../search/query-utils';
import { bareCallReceiver } from '../call-shape';

export function pythonRefClass(name: string, ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const imports = context.getImportMappings(ref.filePath, 'python');
  // `import pkg.mod` then `pkg.mod.Cls`: the mapping keys the module by its last segment.
  const module = imports.find(i => i.isNamespace && name.startsWith(`${i.source}.`) &&
    /^\w+$/.test(name.slice(i.source.length + 1)));
  if (module) {
    // Two modules with the same last segment (`import a.foo`, `import b.foo`) share the key: refuse.
    if (imports.filter(i => i.localName === module.localName).length !== 1) return null;
    name = `${module.localName}.${name.slice(module.source.length + 1)}`;
  }
  if (imports.some(i => i.localName === name.split('.')[0])) {
    const hit = context.resolveImport?.({ ...ref, referenceName: name, referenceKind: 'references' });
    const node = hit && context.getNodeById?.(hit.targetNodeId);
    return node?.kind === 'class' && context.getNodesByQualifiedName(node.qualifiedName)
      .filter(n => n.kind === 'class' && n.filePath === node.filePath).length === 1 ? node : null;
  }
  const classes = context.getNodesByName(name).filter(n => n.kind === 'class' && n.filePath === ref.filePath);
  return classes.length === 1 ? classes[0]! : null;
}

function pythonBases(cls: Node, ref: UnresolvedRef, context: ResolutionContext): Node[] {
  const line = context.getFileLines?.(cls.filePath)?.[cls.startLine - 1]
    ?? context.readFile(cls.filePath)?.split('\n')[cls.startLine - 1] ?? '';
  const bases = line.match(/^\s*class\s+\w+\s*\(([^)]*)\)/)?.[1];
  return (bases?.split(',') ?? []).flatMap(name => {
    const base = pythonRefClass(name.trim(), { ...ref, filePath: cls.filePath }, context);
    return base ? [base] : [];
  });
}

export function pythonDerivesFrom(cls: Node, base: Node, ref: UnresolvedRef, context: ResolutionContext, seen = new Set<string>()): boolean {
  if (seen.has(cls.id) || seen.size >= 16) return false;
  seen.add(cls.id);
  return pythonBases(cls, ref, context).some(p => p.id === base.id || pythonDerivesFrom(p, base, ref, context, seen));
}

export function pythonMembers(cls: Node, member: string, ref: UnresolvedRef, context: ResolutionContext, seen = new Set<string>()): Node[] {
  if (seen.has(cls.id) || seen.size >= 16) return [];
  seen.add(cls.id);
  // Instance assignments also shadow methods, even though they are not nodes.
  const body = pythonMemberLines(cls.filePath, context).slice(cls.startLine - 1, cls.endLine).join('\n');
  if (new RegExp(`^\\s*(?:(?:self|cls)\\.)?${member}\\s*(?:=|:)`, 'm').test(body)) return [cls];
  const own = context.getNodesByQualifiedName(`${cls.qualifiedName}::${member}`).filter(n => n.filePath === cls.filePath);
  if (own.length) return own;
  return [...new Map(pythonBases(cls, ref, context).flatMap(p => pythonMembers(p, member, ref, context, seen)).map(n => [n.id, n])).values()];
}

export function isPythonProperty(node: Node, context: ResolutionContext): boolean {
  if (node.language !== 'python' || node.kind !== 'method') return false;
  const lines = context.getFileLines?.(node.filePath) ?? context.readFile(node.filePath)?.split('\n') ?? [];
  for (let i = node.startLine - 2; i >= 0 && lines[i]!.trim().startsWith('@'); i--) {
    if (/^\s*@(?:property|(?:functools\.)?cached_property)\s*$/.test(lines[i]!)) return true;
  }
  return false;
}

export const PYTHON_MEMBER_LINES = new WeakMap<ResolutionContext, Map<string, string[]>>();
function pythonMemberLines(filePath: string, context: ResolutionContext): string[] {
  let files = PYTHON_MEMBER_LINES.get(context);
  if (!files) { files = new Map(); PYTHON_MEMBER_LINES.set(context, files); }
  let lines = files.get(filePath);
  if (!lines) {
    lines = stripCommentsForRegex(context.readFile(filePath) ?? '', 'python').split('\n');
    files.set(filePath, lines);
  }
  return lines;
}

export function pythonLocalType(receiver: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  if (!/^\w+$/.test(receiver)) return null;
  const caller = context.getNodeById?.(ref.fromNodeId);
  const lines = pythonMemberLines(ref.filePath, context);
  const declaration = new RegExp(`^\\s*${receiver}\\s*(?::\\s*["']?([\\w.]+)["']?)?\\s*=\\s*(.*)$`);
  const annotation = new RegExp(`^\\s*${receiver}\\s*:\\s*["']?([\\w.]+)`);
  for (let i = ref.line - 1; i >= (caller?.startLine ?? 1) - 1; i--) {
    const line = lines[i] ?? '';
    const assigned = line.match(declaration);
    if (assigned) return assigned[1] ?? assigned[2]!.match(/^([A-Z][\w.]*)\s*\(/)?.[1] ?? '<unknown>';
    const declared = line.match(annotation)?.[1];
    if (declared) return declared;
  }
  return caller?.signature?.match(new RegExp(`\\b${receiver}\\s*:\\s*["']?([\\w.]+)`))?.[1] ?? null;
}

/** A module-scope Python variable (not a class attribute or a function local). */
export function isPythonModuleGlobal(node: Node, context: ResolutionContext): boolean {
  return node.language === 'python' && (node.kind === 'variable' || node.kind === 'constant') &&
    !context.getNodesInFile(node.filePath).some(n =>
      (n.kind === 'class' || n.kind === 'function' || n.kind === 'method') &&
      n.startLine <= node.startLine && n.endLine >= node.startLine);
}

/** How one line binds a name: `global`, a plain `name = value` / `name: T`, an import, or any other binding. */
type PythonBinding =
  | { kind: 'global' }
  | { kind: 'assign'; type: string | null; value: string; line: number }
  | { kind: 'import'; key: string }
  | { kind: 'other' };

export const PYTHON_STATEMENT_STARTS = new WeakMap<ResolutionContext, Map<string, boolean[]>>();
/** Per line: does it start a statement (bracket depth 0, no `\` continuation)? String contents are skipped. */
function pythonStatementStarts(filePath: string, context: ResolutionContext): boolean[] {
  let files = PYTHON_STATEMENT_STARTS.get(context);
  if (!files) { files = new Map(); PYTHON_STATEMENT_STARTS.set(context, files); }
  let starts = files.get(filePath);
  if (starts) return starts;
  starts = [];
  let depth = 0;
  let continued = false;
  for (const line of pythonMemberLines(filePath, context)) {
    starts.push(depth === 0 && !continued);
    let quote = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    }
    continued = /\\\s*$/.test(line);
  }
  files.set(filePath, starts);
  return starts;
}

/** Line indexes that belong to `scope` itself (null: the module), not to a def or class nested in it. */
function pythonOwnLines(scope: Node | null, filePath: string, context: ResolutionContext): number[] {
  const count = pythonMemberLines(filePath, context).length;
  const from = scope ? scope.startLine : 1;
  const to = scope ? Math.min(scope.endLine, count) : count;
  const nested = new Uint8Array(to - from + 1);
  for (const n of context.getNodesInFile(filePath)) {
    if ((n.kind !== 'function' && n.kind !== 'method' && n.kind !== 'class') || n.id === scope?.id) continue;
    if (n.startLine < from || n.endLine > to || (scope && n.startLine <= scope.startLine)) continue;
    nested.fill(1, n.startLine - from, n.endLine - from + 1);
  }
  const own: number[] = [];
  for (let l = from; l <= to; l++) if (!nested[l - from]) own.push(l - 1);
  return own;
}

/** Split `a = b = value` at its top-level assignment operators; null when the line assigns nothing. */
function pythonAssignment(line: string): { targets: string[]; value: string; augmented: boolean } | null {
  const targets: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  let augmented = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (c !== '=' || depth !== 0) continue;
    const prev = line[i - 1] ?? '';
    if (line[i + 1] === '=') { i++; continue; } // ==
    if (prev === '!' || prev === ':') continue; // != and the walrus
    if ((prev === '<' || prev === '>') && line[i - 2] !== prev) continue; // <= >=
    const op = line.slice(start, i).match(/(?:\/\/|\*\*|>>|<<|[-+*/%&|^@])$/)?.[0];
    if (op) augmented = true;
    targets.push(line.slice(start, i - (op?.length ?? 0)));
    start = i + 1;
  }
  return targets.length ? { targets, value: line.slice(start), augmented } : null;
}

/**
 * Every way the statement starting at line `index` binds `name`, read across
 * its continuation lines. Only statement lines can assign or import; any line
 * can bind through `as`, a loop, a lambda or the walrus.
 */
function pythonLineBindings(lines: string[], index: number, statements: boolean[], name: string): PythonBinding[] {
  let line = lines[index]!;
  if (statements[index]) for (let j = index + 1; j < lines.length && !statements[j]; j++) line += '\n' + lines[j];
  const out: PythonBinding[] = [];
  // An import statement can name `name` on a continuation line: `from x import (\n    name,\n)`.
  const imported = statements[index] ? line.match(/^\s*(?:from\s+([\w.]+)\s+)?import\s+([\s\S]*)$/) : null;
  if (imported) {
    const names = imported[2]!;
    // `from x import *` can bind any name.
    if (imported[1] && names.trim() === '*') return [{ kind: 'other' }];
    if (!names.includes(name)) return out;
    for (const part of names.replace(/[()\\]/g, ' ').split(',')) {
      const m = part.trim().match(/^([\w.]+)(?:\s+as\s+(\w+))?$/);
      const local = m && (m[2] ?? (imported[1] ? m[1]! : m[1]!.split('.')[0]!));
      if (local !== name) continue;
      out.push({ kind: 'import', key: imported[1] ? `${imported[1]}:${m![1]}` : `${m![2] ? m![1] : local}:*` });
    }
    return out;
  }
  if (!line.includes(name)) return out;
  const word = new RegExp(`(?<![\\w.])${name}\\b(?!\\s*[.\\[])`);
  if (!word.test(line)) return out;
  const declared = line.match(/^\s*(global|nonlocal)\s+([\w\s,]+)$/);
  if (declared) {
    return declared[2]!.split(',').some(s => s.trim() === name)
      ? [declared[1] === 'global' ? { kind: 'global' } : { kind: 'other' }] : [];
  }
  if (statements[index]) {
    // A `case` pattern binds its capture names (`case [name]:`, `case Cls(k=name):`, `case name:`).
    if (/^\s*case\b/.test(line)) return [{ kind: 'other' }];
    const assignment = pythonAssignment(line);
    if (assignment) {
      const target = assignment.targets.length === 1 && !assignment.augmented ? assignment.targets[0]!.trim() : '';
      const annotated = target.match(new RegExp(`^${name}\\s*:\\s*["']?([\\w.]+)["']?$`));
      if (target === name || annotated) {
        out.push({ kind: 'assign', type: annotated?.[1] ?? null, value: assignment.value.trim(), line: index });
      } else if (assignment.targets.some(t => word.test(t))) {
        out.push({ kind: 'other' });
      }
    } else {
      const annotated = line.match(new RegExp(`^\\s*${name}\\s*:\\s*["']?([\\w.]+)["']?\\s*$`));
      if (annotated) out.push({ kind: 'assign', type: annotated[1]!, value: '', line: index });
      else if (new RegExp(`^\\s*del\\b`).test(line)) out.push({ kind: 'other' });
    }
  }
  if (new RegExp(`\\b${name}[ \\t]*:=|\\bas[ \\t]+${name}\\b`).test(line)) out.push({ kind: 'other' });
  for (const loop of line.matchAll(/\bfor\s+([^:]+?)\s+in\b/g)) if (word.test(loop[1]!)) out.push({ kind: 'other' });
  for (const lambda of line.matchAll(/\blambda\b([^:]*):/g)) if (word.test(lambda[1]!)) out.push({ kind: 'other' });
  return out;
}

/**
 * Whether `name`, read at the ref, is bound by the calling function or one that
 * encloses it (parameter, assignment, loop, `as`, lambda, import) rather than
 * being the module global. With `importsBind` false, an import of the name is
 * not a shadow: it binds the same module the file imports.
 */
export function pythonBindsLocally(name: string, ref: UnresolvedRef, context: ResolutionContext, importsBind: boolean): boolean {
  const lines = pythonMemberLines(ref.filePath, context);
  const statements = pythonStatementStarts(ref.filePath, context);
  const param = new RegExp(`[(,]\\s*\\*{0,2}${name}\\s*[:=,)]`);
  const scopes = context.getNodesInFile(ref.filePath).filter(n =>
    (n.kind === 'function' || n.kind === 'method') && n.startLine <= ref.line && n.endLine >= ref.line)
    .sort((a, b) => b.startLine - a.startLine);
  for (const scope of scopes) {
    const own = pythonOwnLines(scope, ref.filePath, context);
    const bindings = own.flatMap(i => pythonLineBindings(lines, i, statements, name));
    if (bindings.some(b => b.kind === 'global')) return false;
    const def = own.find(i => /^\s*(?:async\s+)?def\b/.test(lines[i]!));
    let header = scope.signature ?? '';
    for (let j = def ?? lines.length; j < lines.length && (j === def || !statements[j]); j++) header += lines[j];
    if (param.test(header)) return true;
    if (bindings.some(b => b.kind !== 'global' && (b.kind !== 'import' || importsBind))) return true;
  }
  return false;
}

/** Distinct sources a file imports `name` from, at any scope (`from a import x` → `a:x`). */
export function pythonImportKeys(name: string, filePath: string, context: ResolutionContext): Set<string> {
  return pythonNameScan(context, `imports\0${filePath}\0${name}`, () => scanPythonImportKeys(name, filePath, context));
}

export const PYTHON_NAME_SCANS = new WeakMap<ResolutionContext, Map<string, unknown>>();
/** Per-file, per-name scans are shared by every ref in the file; cleared with the other memos on sync. */
function pythonNameScan<T>(context: ResolutionContext, key: string, scan: () => T): T {
  let memo = PYTHON_NAME_SCANS.get(context);
  if (!memo) { memo = new Map(); PYTHON_NAME_SCANS.set(context, memo); }
  if (!memo.has(key)) memo.set(key, scan());
  return memo.get(key) as T;
}

function scanPythonImportKeys(name: string, filePath: string, context: ResolutionContext): Set<string> {
  const lines = pythonMemberLines(filePath, context);
  const statements = pythonStatementStarts(filePath, context);
  const keys = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (!statements[i] || !/\bimport\b/.test(lines[i]!)) continue;
    for (const b of pythonLineBindings(lines, i, statements, name)) if (b.kind === 'import') keys.add(b.key);
  }
  return keys;
}

/** Every binding of module global `name` in `filePath`: at module scope, and in each function that declares it `global`. */
export function pythonGlobalBindings(name: string, filePath: string, context: ResolutionContext): PythonBinding[] {
  return pythonNameScan(context, `globals\0${filePath}\0${name}`, () => scanPythonGlobalBindings(name, filePath, context));
}

function scanPythonGlobalBindings(name: string, filePath: string, context: ResolutionContext): PythonBinding[] {
  const lines = pythonMemberLines(filePath, context);
  const statements = pythonStatementStarts(filePath, context);
  const scopes = context.getNodesInFile(filePath).filter(n => n.kind === 'class' || n.kind === 'function' || n.kind === 'method');
  const regions = [pythonOwnLines(null, filePath, context)];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*global\b/.test(lines[i]!) || !pythonLineBindings(lines, i, statements, name).length) continue;
    const scope = scopes.filter(n => n.startLine <= i + 1 && n.endLine >= i + 1).sort((a, b) => b.startLine - a.startLine)[0];
    if (scope && scope.kind !== 'class') regions.push(pythonOwnLines(scope, filePath, context));
  }
  const script = pythonMainBlockLines(filePath, context);
  return regions.flatMap(region => region.filter(i => !script.has(i)).flatMap(i => pythonLineBindings(lines, i, statements, name)))
    .filter(b => b.kind !== 'global');
}

export const PYTHON_GLOBAL_CLASSES = new WeakMap<ResolutionContext, Map<string, Node[] | null>>();
/**
 * The classes a module global can hold. It has no static type (`conn = None`,
 * rebound by `global conn; conn = Backend()`), so its type is the set of
 * classes its module assigns to it: at module scope, or in a function that
 * declares it `global`. Any other binding of it there (an opaque value, a
 * tuple target, `for`/`with`/import, a star import, a `globals()` write)
 * makes the type unknown (null). Production writes from other modules
 * (`settings.conn = X`) join the set; see pythonExternalWrites.
 */
function pythonGlobalClasses(global: Node, ref: UnresolvedRef, context: ResolutionContext): Node[] | null {
  let memo = PYTHON_GLOBAL_CLASSES.get(context);
  if (!memo) { memo = new Map(); PYTHON_GLOBAL_CLASSES.set(context, memo); }
  if (memo.has(global.id)) return memo.get(global.id)!;
  const own = pythonOwnGlobalWrites(global, context);
  const external = own && pythonExternalWrites(global, context);
  // Each type is resolved in the file that wrote it (its imports name the class).
  const writes = external && !external.unknown ? [...external.writes, ...own!] : null;
  let classes: Node[] | null = writes && [];
  const seen = new Set<string>();
  for (const write of writes ?? []) {
    const cls = pythonRefClass(write.type, { ...ref, filePath: write.file }, context);
    if (!cls) { classes = null; break; }
    if (!seen.has(cls.id)) { seen.add(cls.id); classes!.push(cls); }
  }
  memo.set(global.id, classes);
  return classes;
}

/**
 * The types the global's own module writes to it, or null when a binding
 * there leaves its type unknown — whatever other modules write, so they are
 * not read (#2332).
 */
function pythonOwnGlobalWrites(global: Node, context: ResolutionContext): Array<{ type: string; file: string }> | null {
  return pythonNameScan(context, `own\0${global.id}`, () => {
    const file = global.filePath;
    if (pythonDynamicGlobalWrite(global.name, file, context)) return null;
    const writes: Array<{ type: string; file: string }> = [];
    for (const b of pythonGlobalBindings(global.name, file, context)) {
      if (b.kind !== 'assign') return null;
      const constructor = b.value && b.value !== 'None' ? pythonConstructorCall(b.value) : null;
      if (b.type) {
        // `conn: Base = make()` trusts the annotation; `conn: A = B()` contradicts it.
        if (constructor && constructor.split('.').pop() !== b.type.split('.').pop()) return null;
        writes.push({ type: b.type, file });
        continue;
      }
      if (b.value === 'None') continue;
      if (!constructor) return null;
      writes.push({ type: constructor, file });
    }
    return writes;
  });
}

/**
 * The repo files a Python module path can name from `fromFile`. Relative
 * paths (`..settings`) resolve exactly; absolute ones match a file path
 * suffix, so a source root (`src/`) still resolves — and two files sharing
 * the tail (`x/settings.py`, `y/settings.py`) both come back.
 */
function pythonModuleFiles(dotted: string, fromFile: string, context: ResolutionContext): string[] {
  const dots = dotted.match(/^\.+/)?.[0].length ?? 0;
  const parts = dotted.slice(dots).split('.').filter(Boolean);
  if (!parts.length) return [];
  let dir = '';
  if (dots) {
    dir = path.posix.dirname(fromFile.replace(/\\/g, '/'));
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
    if (dir === '.') dir = '';
  }
  const rel = [dir, ...parts].filter(Boolean).join('/');
  const matches = (file: string, want: string) => dots ? file === want : file === want || file.endsWith(`/${want}`);
  const last = parts[parts.length - 1]!;
  return [
    ...context.getNodesByName(`${last}.py`), ...context.getNodesByName(`${last}.pyi`), ...context.getNodesByName('__init__.py'),
  ].filter(n => n.kind === 'file' && (matches(n.filePath, `${rel}.py`) || matches(n.filePath, `${rel}.pyi`) || matches(n.filePath, `${rel}/__init__.py`)))
    .map(n => n.filePath);
}

/**
 * How `filePath` spells the module `moduleFile`: `aliases` import exactly that
 * file; `ambiguous` could also be another file sharing its dotted tail.
 * `import a.b` binds `a`, so that module is spelled `a.b` (the mapping's
 * last-segment `localName` is not a binding); `import a.b as c` binds `c`.
 */
function pythonModuleAliases(filePath: string, moduleFile: string, context: ResolutionContext): { aliases: string[]; ambiguous: string[] } {
  const aliases = new Set<string>();
  const ambiguous = new Set<string>();
  for (const m of context.getImportMappings(filePath, 'python')) {
    const files = pythonImportedFiles(m, filePath, context);
    if (!files.includes(moduleFile)) continue;
    // The mapping cannot tell `import a.b` from `import a.b as b`; the source line can.
    // Exactly this module (not `other.a.b`), outside string literals.
    const explicit = new RegExp(`\\bimport\\s[^\\n]*(?<![\\w.])${m.source.replace(/\./g, '\\.')}\\s+as\\s+${m.localName}\\b`);
    const plainDotted = m.isNamespace && m.source.includes('.') && m.localName === m.source.split('.').pop() &&
      !pythonMemberLines(filePath, context).some(line => explicit.test(blankPythonStrings(line)));
    (files.length === 1 ? aliases : ambiguous).add(plainDotted ? m.source : m.localName);
  }
  return { aliases: [...aliases], ambiguous: [...ambiguous] };
}

export const PYTHON_IMPORTED_FILES = new WeakMap<ResolutionContext, WeakMap<ImportMapping, string[]>>();
/**
 * The repo files an import of `filePath` can name. Every global's write scan
 * asks again of the same files (#2332); kept for as long as the resolver keeps
 * the mapping itself, so the memo never outlives its import cache.
 */
function pythonImportedFiles(m: ImportMapping, filePath: string, context: ResolutionContext): string[] {
  let memo = PYTHON_IMPORTED_FILES.get(context);
  if (!memo) PYTHON_IMPORTED_FILES.set(context, (memo = new WeakMap()));
  let files = memo.get(m);
  if (!files) {
    const dotted = m.isNamespace ? m.source
      : /^\.+$/.test(m.source) ? `${m.source}${m.exportedName}` : `${m.source}.${m.exportedName}`;
    memo.set(m, (files = pythonModuleFiles(dotted, filePath, context)));
  }
  return files;
}

const PYTHON_MAIN_GUARD = /^if\s+(?:__name__\s*==\s*(['"])__main__\1|(['"])__main__\2\s*==\s*__name__)\s*:/;
/** Line indexes inside a top-level `if __name__ == "__main__":` block — script code, not module state. */
function pythonMainBlockLines(filePath: string, context: ResolutionContext): Set<number> {
  return pythonNameScan(context, `main\0${filePath}`, () => {
    const lines = pythonMemberLines(filePath, context);
    const inside = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      const guard = lines[i]!.match(PYTHON_MAIN_GUARD);
      if (!guard) continue;
      if (lines[i]!.slice(guard[0].length).trim()) inside.add(i); // `if __name__ == "__main__": stmt`
      for (let j = i + 1; j < lines.length && !/^\S/.test(lines[j]!); j++) inside.add(j);
    }
    return inside;
  });
}

/** Blank single-line string contents (triple-quoted strings are already blanked by the comment stripper). */
function blankPythonStrings(text: string): string {
  return text.replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, m => m[0] + ' '.repeat(m.length - 2) + m[0]);
}

/** Test code installs doubles: the narrow test-suite set, plus pytest's `conftest.py` wherever it sits. */
function isPythonTestFile(filePath: string): boolean {
  return isTestPath(filePath) || /(?:^|\/)conftest\.py$/.test(filePath.replace(/\\/g, '/'));
}

/**
 * Writes to module global `global` from OTHER files. A production write
 * `<module>.<name> = Cls(...)` adds a type; any other production write
 * (another value, a tuple target, `setattr`) makes the type unknown. Test
 * files install doubles (`settings.conn = MagicMock()`, `monkeypatch.setattr`)
 * that do not define the production type; they are recorded as `writers`, and
 * a ref inside a writer resolves nothing through the global.
 */
function pythonExternalWrites(global: Node, context: ResolutionContext): { writes: Array<{ type: string; file: string }>; unknown: boolean; writers: Set<string> } {
  return pythonNameScan(context, `external\0${global.id}`, () => {
    const out = { writes: [] as Array<{ type: string; file: string }>, unknown: false, writers: new Set<string>() };
    const name = global.name;
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const file of pythonWriteCandidates(name, context)) {
      if (file === global.filePath) continue;
      const test = isPythonTestFile(file);
      const { aliases, ambiguous } = pythonModuleAliases(file, global.filePath, context);
      if (!test && !aliases.length && !ambiguous.length) continue;
      const spell = (names: string[]) => `(?:${names.map(escape).join('|')})`;
      // Test files: any receiver (the double may sit on any spelling of the module).
      const receiver = test ? '[\\w.]+' : spell([...aliases, ...ambiguous]);
      const target = new RegExp(`(?<![\\w.])${receiver}\\.${name}\\b(?!\\s*[.\\[(])`);
      const exact = new RegExp(`^${test ? receiver : spell(aliases.length ? aliases : ['\\0'])}\\.${name}(?:\\s*:[^=]*)?$`);
      const dynamic = new RegExp(`\\b(?:setattr|patch\\.object)\\s*\\(\\s*${receiver}\\s*,\\s*['"]${name}['"]` +
        `|(?<![\\w.])${receiver}\\.__dict__\\s*(?:\\[|\\.\\s*update\\s*\\()`);
      const lines = pythonMemberLines(file, context);
      const statements = pythonStatementStarts(file, context);
      const script = pythonMainBlockLines(file, context);
      for (let i = 0; i < lines.length; i++) {
        if (!statements[i] || script.has(i)) continue;
        let statement = lines[i]!;
        for (let j = i + 1; j < lines.length && !statements[j]; j++) statement += '\n' + lines[j];
        if (!statement.includes(name)) continue;
        const assignment = pythonAssignment(statement);
        const assigned = assignment?.targets.some(t => target.test(t.trim())) ?? false;
        if (!assigned && !dynamic.test(statement)) continue;
        if (test) { out.writers.add(file); continue; }
        // A write through an ambiguous spelling may land on another module: unknown.
        const single = assignment && assignment.targets.length === 1 && !assignment.augmented && exact.test(assignment.targets[0]!.trim());
        const value = single ? assignment!.value.trim() : '';
        if (value === 'None') continue;
        const constructor = value ? pythonConstructorCall(value) : null;
        if (!constructor) { out.unknown = true; return out; }
        out.writes.push({ type: constructor, file });
      }
    }
    return out;
  });
}

/**
 * The Python files that can write a module global named `name`, in path
 * order: those that spell it after a dot (`settings.conn = X`) or a quote
 * (`setattr(settings, "conn", X)`), and those that write through `.__dict__`,
 * whose statement may spell it anywhere. Comment stripping only blanks text,
 * so whatever a stripped statement spells, the file's text spells too. The
 * files are indexed once per pass, instead of every global reading every
 * Python file (#2332).
 */
function pythonWriteCandidates(name: string, context: ResolutionContext): string[] {
  const index = pythonNameScan(context, 'write-candidates', () => {
    const files = context.getAllFiles().filter(f => /\.pyi?$/.test(f));
    const spelled = new Map<string, number[]>();
    const dict: Array<{ at: number; words: string }> = [];
    files.forEach((file, at) => {
      const source = context.readFile(file) ?? '';
      const names = new Set<string>();
      for (const m of source.matchAll(/[.'"](\w+)/g)) names.add(m[1]!);
      for (const n of names) {
        const list = spelled.get(n);
        // A capture is a sliced view that would pin the file's whole text: key a flat copy.
        if (list) list.push(at); else spelled.set(Buffer.from(n).toString(), [at]);
      }
      // A word-only name is in the text exactly when it is in one of its words.
      if (names.has('__dict__')) dict.push({ at, words: [...new Set(source.match(/\w+/g))].join('\n') });
    });
    return { files, spelled, dict };
  });
  // The index holds ASCII words; any other name is looked for in every file's text.
  if (!/^\w+$/.test(name)) return index.files.filter(f => context.readFile(f)?.includes(name));
  const hits = new Set(index.spelled.get(name));
  for (const { at, words } of index.dict) if (words.includes(name)) hits.add(at);
  return [...hits].sort((a, b) => a - b).map(at => index.files[at]!);
}

/**
 * Whether the global's own module can write it through its namespace dict:
 * `globals()` / `vars()` / `sys.modules[__name__]` used as anything but a
 * literal-key read or `.get`, or a literal-key write of this name. Read per
 * statement (continuations joined), with string contents ignored.
 */
function pythonDynamicGlobalWrite(name: string, filePath: string, context: ResolutionContext): boolean {
  const lines = pythonMemberLines(filePath, context);
  const statements = pythonStatementStarts(filePath, context);
  const script = pythonMainBlockLines(filePath, context);
  // `vars()` is the module dict only at module scope; inside a function it is the locals.
  const moduleLines = new Set(pythonOwnLines(null, filePath, context));
  for (let i = 0; i < lines.length; i++) {
    if (!statements[i] || script.has(i)) continue;
    let statement = lines[i]!;
    for (let j = i + 1; j < lines.length && !statements[j]; j++) statement += '\n' + lines[j];
    const code = blankPythonStrings(statement);
    const namespace = moduleLines.has(i)
      ? /\bglobals\(\s*\)|\bvars\(\s*\)|\bsys\.modules\s*\[\s*__name__\s*\]/g
      : /\bglobals\(\s*\)|\bsys\.modules\s*\[\s*__name__\s*\]/g;
    const uses = code.match(namespace)?.length ?? 0;
    if (!uses) continue;
    const targets = pythonAssignment(statement)?.targets ?? [];
    let safe = 0;
    for (const m of statement.matchAll(/\bglobals\(\s*\)\s*(?:\[\s*(['"])(\w+)\1\s*\]|\.\s*get\s*\()/g)) {
      const key = m[2];
      const written = key !== undefined && targets.some(t => t.includes(m[0]));
      if (written && key === name) return true;
      safe++;
    }
    if (uses > safe) return true;
  }
  return false;
}

/**
 * The method a module global's value can dispatch to: one class resolves to
 * its own method; several bind to the nearest declaration they all inherit,
 * as a base-typed receiver does. Otherwise, no edge.
 */
export function pythonGlobalMembers(global: Node, member: string, ref: UnresolvedRef, context: ResolutionContext): Node[] {
  // Unknown from its own module alone: no edge, and no other module to read.
  if (!pythonOwnGlobalWrites(global, context)) return [];
  // A test that installs its own double sees the double, not the production type.
  if (pythonExternalWrites(global, context).writers.has(ref.filePath)) return [];
  const classes = pythonGlobalClasses(global, ref, context);
  if (!classes) return [];
  const targets = [...new Map(classes.flatMap(cls => pythonMembers(cls, member, ref, context)).map(n => [n.id, n])).values()];
  if (targets.length <= 1) return targets;
  // Several targets: the nearest declaration every candidate class inherits,
  // whether or not a candidate overrides it.
  const owner = (n: Node) => context.getNodesInFile(n.filePath).find(c =>
    c.kind === 'class' && n.qualifiedName === `${c.qualifiedName}::${member}`);
  const declarations = new Map<string, { decl: Node; cls: Node }>();
  const queue = [...targets];
  while (queue.length && declarations.size < 32) {
    const decl = queue.shift()!;
    const cls = decl && owner(decl);
    if (!cls || declarations.has(decl.id)) continue;
    declarations.set(decl.id, { decl, cls });
    queue.push(...pythonBases(cls, ref, context).flatMap(base => pythonMembers(base, member, ref, context)));
  }
  const inherits = (cls: Node, base: Node) => cls.id === base.id || pythonDerivesFrom(cls, base, ref, context);
  const shared = [...declarations.values()].filter(d => classes.every(c => inherits(c, d.cls)));
  const nearest = shared.filter(d => shared.every(o => inherits(d.cls, o.cls)));
  return nearest.length === 1 ? [nearest[0]!.decl] : targets;
}

/** `Cls(...)` / `pkg.mod.Cls(...)` as the WHOLE (possibly multi-line) value; else null (`Cls() if x else y`). */
function pythonConstructorCall(text: string): string | null {
  // `(Cls())` is the same value; peel parentheses that wrap the whole expression.
  for (let wrapped = text.trim(); wrapped.startsWith('('); ) {
    let depth = 0;
    let close = -1;
    for (let i = 0; i < wrapped.length && close < 0; i++) {
      if (wrapped[i] === '(') depth++;
      else if (wrapped[i] === ')' && --depth === 0) close = i;
    }
    if (close !== wrapped.length - 1) break;
    text = wrapped = wrapped.slice(1, -1).trim();
  }
  const callee = text.match(/^((?:[A-Za-z_]\w*\.)*[A-Z]\w*)\s*\(/);
  if (!callee) return null;
  let depth = 0;
  let quote = '';
  for (let i = callee[0].length - 1; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) return /^[\s\\]*$/.test(text.slice(i + 1)) ? callee[1]! : null;
    }
  }
  return null;
}

/** Read a field's own annotation/initializer, or a constructor parameter assigned to it. */
export function pythonFieldType(receiver: string, owner: Node, ref: UnresolvedRef, context: ResolutionContext): string | null {
  const lines = pythonMemberLines(ref.filePath, context);
  const field = receiver.split('.')[1]!;
  const assignment = new RegExp(`^\\s*(?:self|cls)\\.${field}\\s*(?::\\s*["']?([\\w.]+)["']?)?\\s*=\\s*(.*)$`);
  const annotation = new RegExp(`^\\s*(?:(?:self|cls)\\.)?${field}\\s*:\\s*["']?([\\w.]+)`);
  const methods = context.getNodesInFile(ref.filePath).filter(n => n.kind === 'method' &&
    n.qualifiedName.startsWith(`${owner.qualifiedName}::`));
  const types = new Set<string>();
  for (let i = owner.startLine; i < owner.endLine; i++) {
    const method = methods.find(n => n.startLine <= i + 1 && n.endLine >= i + 1);
    if (method && method.name !== '__init__' && method.id !== ref.fromNodeId) continue;
    if (method?.id === ref.fromNodeId && i + 1 > ref.line) continue;
    const line = lines[i] ?? '';
    const declared = !method || /^\s*(?:self|cls)\./.test(line) ? line.match(annotation)?.[1] : undefined;
    if (declared) types.add(declared);
    const assigned = line.match(assignment);
    if (!assigned) continue;
    if (assigned[1]) { types.add(assigned[1]); continue; }
    const constructor = assigned[2]!.match(/^([A-Z][\w.]*)\s*\(/)?.[1];
    if (constructor) { types.add(constructor); continue; }
    const param = assigned[2]!.trim();
    if (method && /^\w+$/.test(param)) {
      const signature = method.signature ?? '';
      const type = signature.match(new RegExp(`\\b${param}\\s*:\\s*["']?([\\w.]+)`))?.[1];
      if (type) types.add(type);
    } else {
      types.add('<unknown>');
    }
  }
  // Conflicting assignments are known-but-ambiguous, never a name-only fallback.
  return types.size === 1 ? [...types][0]! : types.size > 1 ? '<ambiguous>' : null;
}

/**
 * Whether a Python call recorded by its bare name was written on the instance,
 * `self.get_ip(request)`. The extractor drops the `self.`, so a same-named name
 * the file imports would otherwise claim the method call (#2074 follow-up).
 */
export function isPythonSelfCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  return ref.language === 'python' && bareCallReceiver(ref, context)?.receiver === 'self';
}

/**
 * The shape of a Python call that reaches the resolver as a bare name — the
 * column is the call's start. `bare`: `get(1)`, which cannot mean a method
 * (Python has no implicit self). `chained`: a receiver the extractor could not
 * keep — `User.objects.get(…)`, `self.client.login(…)`, `request.POST.get(…)`
 * arrive as `get` / `login`, and can only mean a member of what the chain
 * names last (`POST`, `client`, `objects`). netbox bound 3,610 `.all()` calls
 * to one `UserConfig.all`, healthchecks 880 `objects.get` to a test case's
 * `get`. `self.x()` / `cls.x()`, and a chain split across lines, are null:
 * today's behavior.
 */
type PythonCallShape = { kind: 'bare' } | { kind: 'chained'; owner: string };

export function pythonCallShape(ref: UnresolvedRef, context: ResolutionContext): PythonCallShape | null {
  if (ref.language !== 'python' || ref.referenceKind !== 'calls') return null;
  const name = ref.referenceName;
  if (!/^[A-Za-z_]\w*$/.test(name)) return null;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return null;
  const text = line.slice(ref.column);
  if (text.startsWith(name) && /^\s*\(/.test(text.slice(name.length))) return { kind: 'bare' };
  if (new RegExp(String.raw`^(?:self|cls)\s*\.\s*${name}\s*\(`).test(text)) return null;
  // The call starts at its receiver, so everything up to `.name(` is the receiver chain.
  const chain = new RegExp(String.raw`^(.*?)\.\s*${name}\s*\(`).exec(text);
  if (!chain) return null;
  const owner = /(\w+)\s*(?:\([^()]*\)|\[[^\[\]]*\])?\s*$/.exec(chain[1]!)?.[1];
  return owner ? { kind: 'chained', owner } : null;
}

/** Can a Python call of this shape mean the candidate? */
export function fitsPythonCallShape(n: Node, shape: PythonCallShape, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (shape.kind === 'bare') {
    if (n.kind === 'method') return false;
    if (n.filePath === ref.filePath) return true;
    // `from django.shortcuts import render`: the call is the package's.
    if (isPythonNameImportedFromOutside(ref.referenceName, ref, context)) return false;
    // `view = UserView.as_view()` … `view(request)`: the file's own value —
    // unless it is a pytest fixture, which a test takes as a parameter of that name.
    return isFixtureInReach(n, ref.filePath, context) || !isPythonLocallyBound(ref.referenceName, ref, context);
  }
  // A member of what the chain names: a method of a class of that name, or a
  // function / class in a module of that name (`helpers.slugify()`).
  if (n.kind === 'method') {
    // `self.store.fetch()` on a `Store`, `self.user_service.find()` on a `UserService`.
    const cut = n.qualifiedName.lastIndexOf('::');
    const owner = cut >= 0 ? n.qualifiedName.slice(0, cut).split('::').pop()! : '';
    const plain = (s: string): string => s.replace(/_/g, '').toLowerCase();
    return owner !== '' && plain(owner) === plain(shape.owner);
  }
  const parts = n.filePath.split('/');
  const stem = parts[parts.length - 1]!.replace(/\.pyi?$/, '');
  return stem === shape.owner || (stem === '__init__' && parts[parts.length - 2] === shape.owner);
}

/**
 * A pytest fixture: `@pytest.fixture` / `@fixture`, or anything a `conftest.py`
 * defines. Python decorators are not kept on the node, so they are read from
 * the lines above its `def` (a decorator's arguments may span lines).
 */
function isPytestFixture(n: Node, context: ResolutionContext): boolean {
  if (/(?:^|\/)conftest\.py$/.test(n.filePath) || (n.decorators ?? []).some((d) => /(?:^|\.)fixture\b/.test(d))) return true;
  return isDecoratedFixture(n, context);
}

/**
 * A fixture a test at `filePath` can take by name: one its own module defines,
 * or one a `conftest.py` of its directory or a parent does. A test module's
 * fixture is that module's alone — pytest's `_run_both(func)` is handing on its
 * parameter, not a doc example's `func` fixture.
 */
export function isFixtureInReach(n: Node, filePath: string, context: ResolutionContext): boolean {
  if (n.filePath === filePath) return isPytestFixture(n, context);
  const conftest = /^(.*?)(?:^|\/)conftest\.py$/.exec(n.filePath);
  if (conftest !== null) return conftest[1] === '' || filePath.startsWith(`${conftest[1]}/`);
  // A fixture module a `conftest.py` above the test pulls in — `from
  // tests.fixtures.cli import *`, or `pytest_plugins = ["tests.fixtures.cli"]`.
  if (!isPytestFixture(n, context)) return false;
  return pluggedFixtureModules(filePath, context).some((m) => n.filePath === m || n.filePath.endsWith(`/${m}`));
}

export const PY_PLUGGED_MODULES = new WeakMap<ResolutionContext, Map<string, string[]>>();

/** The module files (`tests/fixtures/cli.py`) the `conftest.py` files above `filePath` star-import or list in `pytest_plugins`. */
function pluggedFixtureModules(filePath: string, context: ResolutionContext): string[] {
  let memo = PY_PLUGGED_MODULES.get(context);
  if (!memo) PY_PLUGGED_MODULES.set(context, (memo = new Map()));
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  const hit = memo.get(dir);
  if (hit) return hit;
  const modules: string[] = [];
  for (let d = dir; ; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
    const text = context.readFile(d ? `${d}/conftest.py` : 'conftest.py');
    if (text) {
      for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+\*/gm)) modules.push(`${m[1]!.replace(/\./g, '/')}.py`);
      const plugins = /^\s*pytest_plugins\s*=\s*[[(]([^\])]*)[\])]/m.exec(text)?.[1] ?? '';
      for (const m of plugins.matchAll(/["']([\w.]+)["']/g)) modules.push(`${m[1]!.replace(/\./g, '/')}.py`);
    }
    if (!d) break;
  }
  memo.set(dir, modules);
  return modules;
}

export const PY_FIXTURE_TYPES = new WeakMap<ResolutionContext, Map<string, string | null>>();

/**
 * The class a pytest fixture returns, for a test parameter of its name — the
 * fixture in reach (the test's module, else the nearest `conftest.py` above
 * it) whose body returns or yields `Cls(…)`, directly or through a local
 * assigned `Cls(…)`. Null for anything else (a parameter that is no fixture's,
 * a fixture returning a call of a function).
 */
export function pythonFixtureReturnType(receiver: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  if (!/^[a-z_]\w*$/.test(receiver) || receiver === 'self' || receiver === 'cls') return null;
  let memo = PY_FIXTURE_TYPES.get(context);
  if (!memo) PY_FIXTURE_TYPES.set(context, (memo = new Map()));
  const key = `${ref.fromNodeId}\0${receiver}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let type: string | null = null;
  const caller = context.getNodeById?.(ref.fromNodeId);
  const lines = caller ? context.getFileLines?.(caller.filePath) ?? context.readFile(caller.filePath)?.split(/\r?\n/) ?? [] : [];
  // The receiver must be the test's own parameter.
  const signature = caller && (caller.kind === 'function' || caller.kind === 'method')
    ? lines.slice(caller.startLine - 1, caller.startLine + 4).join(' ').split(/\)\s*(?:->[^:]*)?:/)[0] ?? '' : '';
  if (new RegExp(`[(,]\\s*${receiver}\\s*(?:[:=,)]|$)`).test(signature)) {
    const fixtures = context.getNodesByName(receiver)
      .filter((n) => n.kind === 'function' && n.language === 'python' && isFixtureInReach(n, ref.filePath, context))
      .sort((a, b) => (a.filePath === ref.filePath ? -1 : 0) - (b.filePath === ref.filePath ? -1 : 0) || b.filePath.length - a.filePath.length);
    const fixture = fixtures[0];
    if (fixture) {
      const body = (context.getFileLines?.(fixture.filePath) ?? context.readFile(fixture.filePath)?.split(/\r?\n/) ?? [])
        .slice(fixture.startLine, fixture.endLine).join('\n');
      const returned = /^\s*(?:return|yield)\s+([A-Za-z_][\w.]*)\s*(\()?/m.exec(body);
      if (returned) {
        const direct = returned[2] ? returned[1]! : new RegExp(`^\\s*${returned[1]!.replace(/\./g, '\\.')}\\s*=\\s*([A-Za-z_][\\w.]*)\\s*\\(`, 'm').exec(body)?.[1];
        const cls = direct?.split('.').pop();
        if (cls && /^[A-Z]/.test(cls)) type = cls;
      }
    }
  }
  memo.set(key, type);
  return type;
}

function isDecoratedFixture(n: Node, context: ResolutionContext): boolean {
  if (n.language !== 'python' || n.kind !== 'function') return false;
  const lines = context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split(/\r?\n/) ?? [];
  // Upward through the decorator lines: each one starts with `@`, or sits inside one's parentheses.
  let open = 0;
  for (let i = n.startLine - 2; i >= 0 && i >= n.startLine - 16; i--) {
    const text = lines[i]?.trim() ?? '';
    open += (text.match(/\)/g)?.length ?? 0) - (text.match(/\(/g)?.length ?? 0);
    if (open > 0) continue;
    if (!text.startsWith('@')) return false;
    if (/^@(?:\w+\.)*fixture\b/.test(text)) return true;
  }
  return false;
}

export const PY_LOCAL_BINDS = new WeakMap<ResolutionContext, Map<string, boolean>>();
/**
 * The file isPythonLocallyBound last read: its code lines, and per name
 * whether its module binds it. Refs arrive grouped by file, so one file per
 * context spares re-stripping the file for every function and name (#2332).
 */
export const PY_LOCAL_FILE = new WeakMap<ResolutionContext, { filePath: string; lines: string[]; module: Map<string, boolean> }>();
/** The ref isPythonLocallyBound last answered, and the answer. */
export const PY_LOCAL_LAST = new WeakMap<ResolutionContext, { ref: UnresolvedRef; name: string; bound: boolean }>();

/**
 * Whether the function around a Python call — or its module, at top level —
 * binds `name` itself: an assignment (`view = X.as_view()`, `a, view = …`,
 * `view: T = …`), a parameter, a `for` / `with … as` / `except … as` target.
 * DRF's tests write `view = SomeView.as_view()` then `view(request)`, and
 * every such call went to one test file's `def view`.
 */
export function isPythonLocallyBound(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  // fitsPythonCallShape asks once per same-named candidate, and finding the
  // function around the call reads every node in the file: answer a ref once (#2332).
  const last = PY_LOCAL_LAST.get(context);
  if (last?.ref === ref && last.name === name) return last.bound;
  const bound = pythonLocalBinding(name, ref, context);
  PY_LOCAL_LAST.set(context, { ref, name, bound });
  return bound;
}

/** isPythonLocallyBound's answer, kept per calling function and name. */
function pythonLocalBinding(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const fn = context.getNodesInFile(ref.filePath)
    .filter((f) => (f.kind === 'function' || f.kind === 'method') && f.startLine <= ref.line && f.endLine >= ref.line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  let memo = PY_LOCAL_BINDS.get(context);
  if (!memo) PY_LOCAL_BINDS.set(context, (memo = new Map()));
  const key = `${ref.filePath}\0${fn?.id ?? ''}\0${name}\0${fn ? '' : ref.line}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  // An imported name is the import's (the import resolver's to follow).
  if (pythonFromImports(ref.filePath, context).has(name)) {
    memo.set(key, false);
    return false;
  }
  // Code only: `{% user_display user as user_display %}` in a docstring binds nothing.
  let file = PY_LOCAL_FILE.get(context);
  if (file?.filePath !== ref.filePath) {
    const lines = stripCommentsForRegex(context.readFile(ref.filePath) ?? '', 'python').split(/\r?\n/);
    PY_LOCAL_FILE.set(context, (file = { filePath: ref.filePath, lines, module: new Map() }));
  }
  const lines = file.lines;
  const n = name;
  const assigns = new RegExp(`^\\s*(?:[\\w\\s,*()\\[\\]]*,\\s*)?\\(?\\*?${n}\\)?\\s*(?:,[\\w\\s,*()\\[\\]]*)?(?::[^=]+)?=(?!=)`);
  const targets = new RegExp(`\\bfor\\s+[\\w\\s,()]*\\b${n}\\b[\\w\\s,()]*\\s+in\\b|\\bas\\s+${n}\\b`);
  const params = new RegExp(`[(,]\\s*\\*{0,2}${n}\\s*(?:[:=,)]|$)`);
  let bound = false;
  if (fn) {
    // The signature up to its `:` (it may span lines), then the body above the call.
    let i = fn.startLine - 1;
    let signature = '';
    for (; i < Math.min(lines.length, fn.startLine + 20); i++) {
      signature += lines[i] ?? '';
      if (/\)\s*(?:->[^:]*)?:\s*(?:#.*)?$/.test(lines[i] ?? '')) break;
    }
    bound = params.test(signature.replace(/^[^(]*/, ''));
    for (let line = i + 1; !bound && line < ref.line - 1; line++) {
      const text = lines[line] ?? '';
      bound = assigns.test(text) || targets.test(text);
    }
  }
  // A module-level binding (`view = api_view(['GET'])(handler)`).
  if (!bound) {
    let module = file.module.get(n);
    if (module === undefined) {
      const top = new RegExp(`^(?:[\\w,\\s]*,\\s*)?${n}\\s*(?:,[\\w\\s,]*)?(?::[^=]+)?=(?!=)`);
      module = lines.some(line => top.test(line));
      file.module.set(n, module);
    }
    bound = module;
  }
  memo.set(key, bound);
  return bound;
}

export const PY_IMPORTS = new WeakMap<ResolutionContext, Map<string, Map<string, string>>>();
export const PY_MODULE_LOCAL = new WeakMap<ResolutionContext, Map<string, boolean>>();

/** `name` → the module a `from <module> import name` line takes it from, per file. */
export function pythonFromImports(filePath: string, context: ResolutionContext): Map<string, string> {
  let memo = PY_IMPORTS.get(context);
  if (!memo) {
    memo = new Map();
    PY_IMPORTS.set(context, memo);
  }
  const hit = memo.get(filePath);
  if (hit) return hit;
  const names = new Map<string, string>();
  const text = context.readFile(filePath) ?? '';
  for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^\n#]+)/gm)) {
    const module = m[1]!;
    for (const item of m[2]!.replace(/[()]/g, '').split(',')) {
      const bound = /(\w+)\s*$/.exec(item.trim())?.[1];
      if (bound && bound !== '*') names.set(bound, module);
    }
  }
  memo.set(filePath, names);
  return names;
}

function isPythonNameImportedFromOutside(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const module = pythonFromImports(ref.filePath, context).get(name);
  if (!module || module.startsWith('.')) return false;
  let memo = PY_MODULE_LOCAL.get(context);
  if (!memo) {
    memo = new Map();
    PY_MODULE_LOCAL.set(context, memo);
  }
  let local = memo.get(module);
  if (local === undefined) {
    const rel = module.replace(/\./g, '/');
    local = context.getAllFiles().some((f) =>
      f === `${rel}.py` || f.endsWith(`/${rel}.py`) || f === `${rel}/__init__.py` || f.endsWith(`/${rel}/__init__.py`));
    memo.set(module, local);
  }
  return !local;
}
