/**
 * PHP scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolutionContext } from '../../types';
import { localReceiverTypePatterns, memoPatterns, normalizeInferredTypeName } from '../receiver-inference';
import { splitCamelCase } from '../strategies/fuzzy';

const PHP_CLASS_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'trait', 'enum']);
/**
 * Whether a bare PHP class name at `ref` can mean `candidate`. An unqualified
 * class name is the current namespace's class or the one a `use` imports —
 * PHP never falls back to another namespace for classes. koel's `extends
 * Request` (under `use Saloon\Http\Request;`, `use App\Http\Requests\API\Request;`,
 * or in `App\Http\Requests\API` itself) all went to the first `Request` indexed.
 */
export function isPhpClassVisible(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.language !== 'php' || candidate.language !== 'php' || !PHP_CLASS_KINDS.has(candidate.kind)) return true;
  const name = ref.referenceName;
  if (!/^[A-Za-z_]\w*$/.test(name) || /^(?:self|static|parent)$/i.test(name)) return true;
  const fqn = candidate.qualifiedName.replace(/::/g, '\\');
  const scope = phpFileScope(ref.filePath, context);
  const imported = scope.uses.get(name);
  if (imported !== undefined) return imported.toLowerCase() === fqn.toLowerCase();
  return fqn.toLowerCase() === (scope.namespace ? `${scope.namespace}\\${name}` : name).toLowerCase();
}

const PHP_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'trait', 'interface', 'enum']);
export const PHP_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();

/**
 * How a bare PHP method name was written at its call site: `$this->m()` /
 * `self::m()` / `static::m()` are the enclosing class's own (or inherited)
 * methods, `parent::m()` an ancestor's; null for anything else.
 */
export function phpSelfReceiver(ref: UnresolvedRef, context: ResolutionContext): 'self' | 'parent' | null {
  if (ref.language !== 'php' || ref.referenceKind !== 'calls' || !/^\w+$/.test(ref.referenceName)) return null;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (!line) return null;
  const name = ref.referenceName;
  if (new RegExp(String.raw`\$this\s*\??->\s*${name}\s*\(|\b(?:self|static)\s*::\s*${name}\s*\(`).test(line)) return 'self';
  if (new RegExp(String.raw`\bparent\s*::\s*${name}\s*\(`).test(line)) return 'parent';
  return null;
}

/**
 * Whether `method` belongs to the class the call is written in, one it
 * extends, or a trait any of them uses — read from source, since the
 * resolver's supertype edges don't exist yet on the first pass, and resolved
 * the way PHP resolves a class name: through the file's `namespace` and `use`
 * imports (aliases included) to one fully qualified class. A parent outside
 * the repository (PHPUnit's TestCase, Orchestra's) ends the chain. Drupal's
 * `$this->assertEquals()` is PHPUnit's; it went to the one in-repo
 * `assertEquals`, a comparator's, 8,832 times.
 */
export function isPhpMethodInScope(method: Node, ref: UnresolvedRef, via: 'self' | 'parent', context: ResolutionContext): boolean {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut < 0) return true;
  const ownerQn = method.qualifiedName.slice(0, cut);
  const enclosing = context
    .getNodesInFile(ref.filePath)
    .filter((n) => PHP_TYPE_KINDS.has(n.kind) && n.startLine <= ref.line && n.endLine >= ref.line)
    .sort((a, b) => b.startLine - a.startLine)[0];
  // Inside a trait, `$this` is whichever class uses it: Laravel's
  // ValidatesAttributes calls the Validator's `getValue()`.
  if (!enclosing || enclosing.kind === 'trait') return true;
  const up = phpAncestry(via === 'parent' ? phpSupertypeQns(enclosing, context) : [enclosing.qualifiedName], context);
  if (up.qns.has(ownerQn)) return true;
  // A base class may call what a subclass defines (BookStack's Entity calls
  // `$this->chapter()`, a Page method): the owner descends from the caller.
  if (via === 'self' && phpAncestry([ownerQn], context).qns.has(enclosing.qualifiedName)) return true;
  // Past an ancestor outside the repository (Orchestra's TestCase) that
  // ancestor's members are unseen — the repository's traits it uses among
  // them. A trait's method may still be the one meant; an unrelated class's
  // (Drupal's comparator `assertEquals`) never is.
  return up.leavesRepo && context.getNodesByQualifiedName(ownerQn).some((d) => d.kind === 'trait');
}

/**
 * Whether a PHP receiver is named after a class that has `method` in its
 * ancestry: `$page->save()` → Page, which extends Entity; `$newRole->users()`
 * → Role. BookStack's `$role->save()` is not Entity's (Role is a Model).
 */
export function phpReceiverReaches(receiver: string, method: Node, context: ResolutionContext): boolean {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut < 0) return false;
  const owner = method.qualifiedName.slice(0, cut);
  const last = receiver.split('.').pop()!.replace(/^\$/, '');
  if (!last) return false;
  const words = splitCamelCase(last);
  const names = new Set([last, words[words.length - 1] ?? last].map((w) => w.charAt(0).toUpperCase() + w.slice(1)));
  for (const name of names) {
    for (const decl of context.getNodesByName(name)) {
      if (decl.language !== 'php' || !PHP_TYPE_KINDS.has(decl.kind)) continue;
      if (phpAncestry([decl.qualifiedName], context).qns.has(owner)) return true;
    }
  }
  return false;
}

/** Every type `start` reaches through `extends` and trait `use`, and whether it left the repository on the way. */
function phpAncestry(start: readonly string[], context: ResolutionContext): { qns: Set<string>; leavesRepo: boolean } {
  const qns = new Set<string>();
  const queue = [...start];
  let leavesRepo = false;
  while (queue.length > 0 && qns.size < 80) {
    const qn = queue.shift()!;
    if (qns.has(qn)) continue;
    qns.add(qn);
    const decls = context.getNodesByQualifiedName(qn).filter((d) => d.language === 'php' && PHP_TYPE_KINDS.has(d.kind));
    if (decls.length === 0) leavesRepo = true;
    for (const decl of decls) queue.push(...phpSupertypeQns(decl, context));
  }
  return { qns, leavesRepo };
}

export const PHP_FILE_SCOPES = new WeakMap<ResolutionContext, Map<string, { namespace: string; uses: Map<string, string> }>>();

/** A PHP file's `namespace` and its `use A\B\C [as D];` imports, alias → fully qualified name. */
function phpFileScope(file: string, context: ResolutionContext): { namespace: string; uses: Map<string, string> } {
  let memo = PHP_FILE_SCOPES.get(context);
  if (!memo) PHP_FILE_SCOPES.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const text = context.readFile(file) ?? '';
  const namespace = /^\s*namespace\s+([\w\\]+)\s*[;{]/m.exec(text)?.[1] ?? '';
  const uses = new Map<string, string>();
  // File-level imports sit before the first type; a trait `use` inside a class body is not one.
  const header = text.slice(0, text.search(/^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|trait|interface|enum)\s/m) >>> 0 || text.length);
  for (const m of header.matchAll(/^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm)) {
    const fqn = m[1]!.replace(/^\\/, '');
    uses.set(m[2] ?? fqn.split('\\').pop()!, fqn);
  }
  const scope = { namespace, uses };
  memo.set(file, scope);
  return scope;
}

/** The qualified name (`A\B::C`) a PHP class name written in `file` refers to. */
function phpTypeQn(name: string, file: string, context: ResolutionContext): string {
  let fqn: string;
  if (name.startsWith('\\')) fqn = name.slice(1);
  else {
    const { namespace, uses } = phpFileScope(file, context);
    const [head, ...rest] = name.split('\\');
    const imported = uses.get(head!);
    fqn = imported ? [imported, ...rest].join('\\') : namespace ? `${namespace}\\${name}` : name;
  }
  const at = fqn.lastIndexOf('\\');
  return at < 0 ? fqn : `${fqn.slice(0, at)}::${fqn.slice(at + 1)}`;
}

/** The qualified names a PHP class or trait extends and the traits it uses. */
function phpSupertypeQns(decl: Node, context: ResolutionContext): string[] {
  let memo = PHP_SUPERS.get(context);
  if (!memo) {
    memo = new Map();
    PHP_SUPERS.set(context, memo);
  }
  const hit = memo.get(decl.id);
  if (hit) return hit;
  const names: string[] = [];
  const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
  const head = lines.slice(decl.startLine - 1, decl.startLine + 4).join(' ');
  const extended = /\bextends\s+([^{]*?)(?:\bimplements\b|\{)/.exec(head)?.[1] ?? '';
  for (const m of extended.matchAll(/(\\?[A-Za-z_][\w\\]*)/g)) names.push(m[1]!);
  // `use StringTranslationTrait, MessengerTrait;` at the top of the body —
  // one per line or one list across several (Laravel's Command, Model).
  const bodyLines = lines.slice(decl.startLine, Math.min(decl.endLine, decl.startLine + 80));
  const firstFunction = bodyLines.findIndex((l) => /\bfunction\b/.test(l));
  const body = bodyLines.slice(0, firstFunction < 0 ? bodyLines.length : firstFunction).join('\n');
  for (const used of body.matchAll(/^\s*use\s+([\w\\,\s]+?)\s*[;{]/gm)) {
    for (const t of used[1]!.split(',')) if (t.trim()) names.push(t.trim());
  }
  const qns = names.map((n) => phpTypeQn(n, decl.filePath, context));
  memo.set(decl.id, qns);
  return qns;
}

/**
 * Patterns that recover a PHP class property's declared type for a
 * `$this->prop` receiver. Deliberately NOT localReceiverTypePatterns: only
 * property-shaped declarations qualify —
 *   1. a modifier-prefixed typed declaration, which covers both a typed
 *      property (`private ?Foo $prop;`) and a promoted constructor parameter
 *      (`private readonly Foo $prop`), and
 *   2. the pseudoconstructor assignment (`$this->prop = new Foo(...)`).
 * A bare `X $prop` parameter or `$prop = new X()` local elsewhere in the
 * file must NOT match: those variables can never alias `$this->prop`.
 * Union-typed properties (`Foo|Bar $prop`) yield no match and thus no edge —
 * silent beats wrong. The classic untyped-property-assigned-in-constructor
 * shape is handled by inferPhpAssignedPropertyType instead.
 */
export function phpPropertyTypePatterns(r: string): RegExp[] {
  return memoPatterns(`php-prop|${r}`, () => buildPhpPropertyTypePatterns(r));
}

function buildPhpPropertyTypePatterns(r: string): RegExp[] {
  return [
    new RegExp(
      `\\b(?:(?:private|protected|public|readonly|static|final)(?:\\(set\\))?\\s+)+\\??([A-Za-z_\\\\][\\w\\\\]*)\\s+&?\\$${r}\\b`,
    ), // private readonly ?Foo $prop  (typed property / promoted param)
    new RegExp(`\\$this->${r}\\b\\s*=\\s*new\\s+([A-Za-z_\\\\][\\w\\\\]*)`), // $this->prop = new Foo()
  ];
}

/**
 * Second-chance typing for a PHP `$this->prop` receiver whose property
 * declaration carries no static type (classic pre-7.4 style): find the
 * `$this->prop = $var` assignment, then recover `$var`'s type from its own
 * declaration WITHIN the assignment's function — the constructor's (possibly
 * multi-line) parameter list, a typed setter's parameter, or a `= new X()`
 * local. The backward scan stops at the enclosing `function` line (checked
 * for a match first — a single-line `__construct(Foo $var) { ... }` carries
 * the typed parameter itself), so a same-named variable in another method
 * can never type the property.
 */
export function inferPhpAssignedPropertyType(
  escapedProp: string,
  lines: string[],
  callIdx: number,
): string | null {
  const assignRe = new RegExp(`\\$this->${escapedProp}\\b\\s*=\\s*\\$(\\w+)\\b`);
  const assignAt = (i: number): RegExpMatchArray | null => {
    const line = lines[i];
    if (!line || line.length > 10_000) return null;
    return line.match(assignRe);
  };
  // The assignment is position-independent relative to the call — nearest-
  // backward first, then sweep forward, same order as the componentScoped scan.
  let assignIdx = -1;
  let varName: string | null = null;
  for (let i = callIdx; i >= 0; i--) {
    const m = assignAt(i);
    if (m) { assignIdx = i; varName = m[1]!; break; }
  }
  if (varName === null) {
    for (let i = callIdx + 1; i < lines.length; i++) {
      const m = assignAt(i);
      if (m) { assignIdx = i; varName = m[1]!; break; }
    }
  }
  if (varName === null) return null;

  const varPatterns = localReceiverTypePatterns(
    'php',
    varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  for (let i = assignIdx; i >= 0; i--) {
    const line = lines[i];
    if (line && line.length <= 10_000) {
      for (const re of varPatterns) {
        const m = line.match(re);
        if (m && m[1]) {
          const type = normalizeInferredTypeName(m[1]);
          if (type) return type;
        }
      }
    }
    if (line && /\bfunction\b/.test(line)) break;
  }
  return null;
}
