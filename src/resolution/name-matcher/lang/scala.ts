/**
 * Scala scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolutionContext } from '../../types';
import { sharesReceiverWord } from '../strategies/fuzzy';

export const SCALA_OBJECT_PACKAGES = new WeakMap<ResolutionContext, Map<string, string | null>>();

/** The full package a Scala file's `package object X` opens (`algebra`, `cats.syntax`), or null for none. */
function scalaPackageObjectPackage(file: string, context: ResolutionContext): string | null {
  let memo = SCALA_OBJECT_PACKAGES.get(context);
  if (!memo) SCALA_OBJECT_PACKAGES.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit !== undefined) return hit;
  const text = context.readFile(file) ?? '';
  const object = /^\s*package\s+object\s+([\w$]+)/m.exec(text)?.[1];
  const pkg = object ? [...scalaPackageClauses(text), object].join('.') : null;
  memo.set(file, pkg);
  return pkg;
}

/** A Scala file's package clauses, in order (`package cats` / `package laws` → cats, laws). */
function scalaPackageClauses(text: string): string[] {
  return [...text.matchAll(/^\s*package\s+(?!object\b)([\w.]+)\s*$/gm)].flatMap((m) => m[1]!.split('.'));
}

/**
 * Whether a member of a Scala package object is in scope at `ref`: from its
 * package and the packages under it, or from a file that imports something
 * through the package (`import algebra._`, `import algebra.Eq`).
 */
export function isScalaPackageObjectMemberVisible(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const objectPkg = scalaPackageObjectPackage(candidate.filePath, context);
  if (objectPkg === null) return true;
  const text = context.readFile(ref.filePath) ?? '';
  const here = scalaPackageClauses(text).join('.');
  if (here === objectPkg || here.startsWith(`${objectPkg}.`)) return true;
  const last = objectPkg.split('.').pop()!;
  return new RegExp(`^\\s*import\\s+[^\\n]*\\b${last.replace(/\$/g, '\\$')}\\b`, 'm').test(text);
}

export const SCALA_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'trait', 'interface', 'enum', 'struct', 'module', 'namespace']);
const SCALA_MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'field', 'property', 'variable', 'constant']);
export const SCALA_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();
export const SCALA_IMPORTS = new WeakMap<ResolutionContext, Map<string, { owners: Set<string>; members: Set<string>; values: Set<string> }>>();

/**
 * Whether a bare Scala name can mean the member `n`, read at its site. Three
 * shapes:
 * - a later link of a chain (`fa.iterator.map(f)` — the extractor keeps one
 *   receiver level, the line still shows the dot): the receiver must be named
 *   after `n`'s owner (`Foo.bar` on object Foo). cats's chained `.map(…)` went
 *   to a lazy-list ops class's `map` 186 times;
 * - a name the enclosing definition binds — a parameter `f: A => B`, a
 *   `val` — is that local: `f(true)` is not a case class's field `f` (396);
 * - otherwise a member of the types around it or their `extends` / `with`
 *   supertypes, of a companion, of the same file, or of an object the file
 *   imports (`import Foo._`, `import Foo.{bar}`).
 */
export function isScalaMemberInScope(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return true;
  const name = ref.referenceName;
  const at = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}\\b`).exec(line);
  if (!at) return true;
  const before = line.slice(0, at.index);
  if (/\.\s*$/.test(before)) {
    // A later link of a chain: a member of what the receiver is named after,
    // never a package object's function — unless it is an `extension` method.
    if (n.filePath === ref.filePath) return true;
    // A type or object as a chain link (`pkg.Obj(…)`) is named by what holds it:
    // cats' `arbitrary[Int].map { … }` is no call of alleycats' `object map`.
    if (SCALA_TYPE_KINDS.has(n.kind)) {
      // Scala qualified names leave the package out: a top-level type's holder is its file's package.
      const outer = n.qualifiedName.split('::').slice(-2, -1)[0];
      const holder = outer !== undefined ? outer.split('.').pop()!
        : [...(context.readFile(n.filePath) ?? '').matchAll(/^\s*package\s+([\w.]+)\s*$/gm)].pop()?.[1]?.split('.').pop() ?? '';
      return holder !== '' && scalaReceiverName(before).split('.').pop() === holder;
    }
    if (!SCALA_MEMBER_KINDS.has(n.kind)) return n.kind !== 'function' || isScalaExtensionMethod(n, context);
    const receiver = scalaReceiverName(before);
    return receiver !== '' && sharesReceiverWord(receiver, n);
  }
  const local = scalaLocalBinder(name, ref, context);
  if (local) return n.filePath === ref.filePath && n.startLine >= local.startLine && n.endLine <= local.endLine;
  if (!SCALA_MEMBER_KINDS.has(n.kind)) return true;
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut < 0 || n.filePath === ref.filePath) return true;
  const owner = n.qualifiedName.slice(0, cut).split('::').pop()!;
  const imports = scalaImportsOf(ref.filePath, context);
  if (imports.owners.has(owner) || imports.members.has(`${owner}.${name}`)) return true;
  // `import builder._` brings in a VALUE's members, of a type the file doesn't say.
  if (imports.values.size > 0) return true;
  // An imported object's inherited members: `import sttp.client4._` is
  // `package object client4 extends SttpApi`, so `multipart(…)` is SttpApi's.
  if (scalaImportedSupertypes(ref.filePath, imports, context).has(owner)) return true;
  const around = context
    .getNodesInFile(ref.filePath)
    .filter((t) => SCALA_TYPE_KINDS.has(t.kind) && t.startLine <= ref.line && t.endLine >= ref.line);
  if (around.length === 0) return true;
  const seen = new Set<string>();
  const queue = [...around.map((t) => t.name), ...scalaAnonymousBases(ref, context)];
  while (queue.length > 0 && seen.size < 60) {
    const typeName = queue.shift()!;
    if (seen.has(typeName)) continue;
    seen.add(typeName);
    if (typeName === owner) return true;
    queue.push(...scalaSupertypesOf(typeName, context));
  }
  return false;
}

/**
 * The types an anonymous class around a Scala site instantiates — `new
 * scopt.OptionParser[Config]("scopt") { head("scopt") }` puts OptionParser's
 * members in scope. Read backwards over the open braces above the site.
 */
function scalaAnonymousBases(ref: UnresolvedRef, context: ResolutionContext): string[] {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split('\n') ?? [];
  const bases: string[] = [];
  let depth = 0;
  for (let i = ref.line - 1; i >= 0 && i >= ref.line - 400; i--) {
    const text = lines[i]!;
    for (let c = text.length - 1; c >= 0; c--) {
      if (text[c] === '}') depth++;
      else if (text[c] === '{') {
        if (depth > 0) { depth--; continue; }
        const head = /\bnew\s+([\w.]+(?:\s*\[[^\]]*\])?(?:\s*\([^)]*\))?(?:\s+with\s+[\w.]+(?:\s*\[[^\]]*\])?)*)\s*$/.exec(text.slice(0, c));
        if (head) for (const m of head[1]!.replace(/\[[^\]]*\]|\([^)]*\)/g, '').split(/\s+with\s+/)) bases.push(m.trim().split('.').pop()!);
      }
    }
  }
  return bases;
}

/**
 * The receiver a Scala `….name` is written on, as its dotted identifiers with
 * call and type arguments dropped: `proc("bash").call()` → `proc`,
 * `Alternative[List].unite` → `Alternative`, `checker.value.onWrite` →
 * `checker.value`. Read backwards to the expression's start.
 */
function scalaReceiverName(before: string): string {
  const text = before.replace(/\s*\.\s*$/, '');
  let out = '';
  let i = text.length - 1;
  while (i >= 0) {
    const ch = text[i]!;
    if (ch === ')' || ch === ']') {
      const open = ch === ')' ? '(' : '[';
      let depth = 0;
      for (; i >= 0; i--) {
        if (text[i] === ch) depth++;
        else if (text[i] === open && --depth === 0) break;
      }
      if (i < 0) return '';
      i--;
    } else if (/[\w$.]/.test(ch)) {
      out = ch + out;
      i--;
    } else break;
  }
  return out.replace(/^\.+|\.+$/g, '');
}

/** Whether a Scala function is declared in an `extension (…)` block. */
function isScalaExtensionMethod(n: Node, context: ResolutionContext): boolean {
  const lines = context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split('\n') ?? [];
  return lines.slice(Math.max(0, n.startLine - 4), n.startLine).some((l) => /^\s*extension\b/.test(l));
}

/**
 * The definition around a Scala site that binds `name` itself — a parameter, a
 * `val` / `var` / `def`, a lambda or `for` parameter — or null.
 */
function scalaLocalBinder(name: string, ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const nodes = context.getNodesInFile(ref.filePath);
  const innermost = (kinds: ReadonlySet<string>) => nodes
    .filter((f) => kinds.has(f.kind) && f.startLine <= ref.line && f.endLine >= ref.line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  const fn = innermost(SCALA_FUNCTION_KINDS);
  // A test suite's body runs in its class: `test("…") { forAll { (e: E, f: A => B) => f(1) } }`.
  const scope = fn ?? innermost(SCALA_TYPE_KINDS);
  if (!scope) return null;
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split('\n') ?? [];
  const text = lines.slice(scope.startLine - 1, ref.line).join('\n');
  const n = name.replace(/[$]/g, '\\$');
  const binder = new RegExp(`(?:[(,\\[]\\s*(?:implicit\\s+|using\\s+)?${n}\\s*:)|(?:\\b(?:val|var|def|lazy\\s+val)\\s+${n}\\b)|(?:(?<![\\w$.])${n}\\s*(?:=>|<-))|(?:\\(\\s*${n}\\s*(?:,[^)]*)?\\)\\s*=>)`, 'g');
  if (fn) return binder.test(text) ? fn : null;
  // In a class body, a binder counts only inside a block still open at the site —
  // not a sibling test's `val f`, not the class's own members at its body's depth.
  const blockAt: number[] = new Array(text.length);
  const open: number[] = [];
  let next = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') { open.push(++next); depth++; }
    else if (ch === '}') { open.pop(); depth--; }
    blockAt[i] = open.length > 1 ? open[open.length - 1]! : 0;
  }
  const live = new Set(open.slice(1));
  for (const m of text.matchAll(binder)) {
    const block = blockAt[m.index!] ?? 0;
    if (block !== 0 && live.has(block)) return scope;
  }
  return null;
}

const SCALA_FUNCTION_KINDS: ReadonlySet<string> = new Set(['method', 'function']);

/** The simple names a Scala type's declarations extend or mix in. */
export function scalaSupertypesOf(typeName: string, context: ResolutionContext): string[] {
  let memo = SCALA_SUPERS.get(context);
  if (!memo) SCALA_SUPERS.set(context, (memo = new Map()));
  const hit = memo.get(typeName);
  if (hit) return hit;
  const names: string[] = [typeName];
  for (const decl of context.getNodesByName(typeName)) {
    if (decl.language !== 'scala' || !SCALA_TYPE_KINDS.has(decl.kind)) continue;
    const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
    const text = lines.slice(decl.startLine - 1, decl.startLine + 12).join(' ');
    let depth = 0;
    let flat = '';
    for (const ch of text) {
      if (ch === '[' || ch === '(') depth++;
      else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0) {
        if (ch === '{' || ch === '=') break;
        flat += ch;
      }
    }
    const clause = /\bextends\b(.*)$/.exec(flat)?.[1] ?? '';
    for (const m of clause.matchAll(/([A-Za-z_][\w.]*)/g)) {
      const simple = m[1]!.split('.').pop()!;
      if (simple !== 'with' && simple !== 'derives' && simple !== typeName) names.push(simple);
    }
  }
  memo.set(typeName, names.slice(1));
  return names.slice(1);
}

export const SCALA_IMPORTED_SUPERS = new WeakMap<ResolutionContext, Map<string, Set<string>>>();
export const SCALA_PACKAGE_OBJECTS = new WeakMap<ResolutionContext, Map<string, string[]>>();

/** `package object client4 extends SttpApi with …` — the graph holds no node for one. */
function scalaPackageObjects(context: ResolutionContext): Map<string, string[]> {
  const hit = SCALA_PACKAGE_OBJECTS.get(context);
  if (hit) return hit;
  const out = new Map<string, string[]>();
  for (const file of context.getAllFiles()) {
    if (!file.endsWith('.scala') || (context.fileContains && !context.fileContains(file, 'package object'))) continue;
    const source = context.readFile(file) ?? '';
    for (const m of source.matchAll(/\bpackage\s+object\s+([\w$]+)\s+extends\s+([^{\n]+)/g)) {
      const names = m[2]!.replace(/\[[^\]]*\]/g, '').split(/\bwith\b/).map((t) => t.trim().split('.').pop()!.replace(/\(.*$/, '').trim()).filter(Boolean);
      out.set(m[1]!, [...(out.get(m[1]!) ?? []), ...names]);
    }
  }
  SCALA_PACKAGE_OBJECTS.set(context, out);
  return out;
}

/** Every supertype of the objects a Scala file imports wholesale (`import Obj._`). */
function scalaImportedSupertypes(file: string, imports: { owners: Set<string> }, context: ResolutionContext): Set<string> {
  let memo = SCALA_IMPORTED_SUPERS.get(context);
  if (!memo) SCALA_IMPORTED_SUPERS.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const seen = new Set<string>();
  // Code in `package sttp.client4` (or under it) sees `package object client4`'s members unimported.
  const packages = [...(context.readFile(file) ?? '').matchAll(/^\s*package\s+([\w.]+)\s*$/gm)].flatMap((m) => m[1]!.split('.'));
  const queue = [...imports.owners, ...packages];
  const packageObjects = scalaPackageObjects(context);
  while (queue.length > 0 && seen.size < 120) {
    const typeName = queue.shift()!;
    for (const sup of [...scalaSupertypesOf(typeName, context), ...(packageObjects.get(typeName) ?? [])]) {
      if (!seen.has(sup)) { seen.add(sup); queue.push(sup); }
    }
  }
  memo.set(file, seen);
  return seen;
}

/** A Scala file's `import a.b.Obj._` / `import a.b.Obj.*` owners and `import a.b.Obj.{x, y}` / `Obj.x` members. */
function scalaImportsOf(file: string, context: ResolutionContext): { owners: Set<string>; members: Set<string>; values: Set<string> } {
  let memo = SCALA_IMPORTS.get(context);
  if (!memo) SCALA_IMPORTS.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const found = { owners: new Set<string>(), members: new Set<string>(), values: new Set<string>() };
  const source = context.readFile(file) ?? '';
  for (const m of source.matchAll(/^\s*import\s+([\w.]+?)\.(?:(_|\*)|\{([^}]*)\}|([\w$]+))\s*$/gm)) {
    const owner = m[1]!.split('.').pop()!;
    // `import builder._` — rooted at a value the file declares, whose type it doesn't say.
    const root = m[1]!.split('.')[0]!;
    if (/^[a-z]/.test(root) && (root === m[1] || new RegExp(`\\b(?:val|var|lazy\\s+val)\\s+${root}\\b|[(,]\\s*${root}\\s*:`).test(source))) {
      found.values.add(owner);
    }
    if (m[2]) found.owners.add(owner);
    else for (const member of (m[3] ?? m[4] ?? '').split(',')) {
      const id = member.trim().split(/\s*=>\s*/)[0]!;
      if (id === '_' || id === '*') found.owners.add(owner);
      else if (id) found.members.add(`${owner}.${id}`);
    }
  }
  memo.set(file, found);
  return found;
}
