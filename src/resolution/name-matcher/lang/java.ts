/**
 * Java scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolutionContext } from '../../types';
import { stripCommentsForRegex } from '../../strip-comments';

const JVM_CALLABLE_KINDS: ReadonlySet<string> = new Set(['method', 'function']);
const JVM_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'struct', 'trait', 'type_alias', 'annotation']);

/** Per context: every package the project's JVM sources declare. */
export const JVM_PACKAGES = new WeakMap<ResolutionContext, Set<string>>();

/**
 * Whether a Java file binds `name` with a single-type (or static) import from
 * a package the project does not declare — `import java.lang.reflect.Field;`,
 * `import static org.junit.Assert.assertEquals;`. A nested class of a project
 * type (`import com.acme.Outer.Inner;`) is under a project package, so it is not.
 */
export function isJavaOutsideImport(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const binding = context.getImportMappings(ref.filePath, ref.language).find((m) => m.localName === name);
  if (!binding) return false;
  // A member the file declares itself is in scope before any import —
  // Exposed's `toLocalDateTime(value)` inside the column type that defines it —
  // in the same namespace only: gson's `new URI(…)` is `java.net.URI` beside
  // `TypeAdapters`' field `URI`, as a type always is beside a value.
  const call = ref.referenceKind === 'calls' && name === ref.referenceName;
  const kinds = call ? JVM_CALLABLE_KINDS : JVM_TYPE_KINDS;
  if ((context.getNodesInFileNamed?.(ref.filePath, name) ?? context.getNodesInFile(ref.filePath).filter((n) => n.name === name))
    .some((n) => kinds.has(n.kind))) return false;
  let packages = JVM_PACKAGES.get(context);
  if (!packages) {
    packages = new Set<string>();
    for (const n of context.getNodesByKind('namespace')) {
      if (n.language === 'java' || n.language === 'kotlin' || n.language === 'scala') packages.add(n.qualifiedName);
    }
    JVM_PACKAGES.set(context, packages);
  }
  const parts = binding.source.split('.');
  for (let i = 1; i < parts.length; i++) {
    if (packages.has(parts.slice(0, i).join('.'))) return false;
  }
  return true;
}

const JAVA_TYPE_KINDS_VISIBLE: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'record', 'annotation']);
export const JAVA_FILE_SCOPES = new WeakMap<ResolutionContext, Map<string, { pkg: string; single: Set<string>; demand: Set<string> }>>();
export const JAVA_ANCESTORS = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/** A Java file's package, its single-type imports and its on-demand (`.*`) imports, static ones included. */
function javaFileScope(file: string, context: ResolutionContext): { pkg: string; single: Set<string>; demand: Set<string> } {
  let memo = JAVA_FILE_SCOPES.get(context);
  if (!memo) JAVA_FILE_SCOPES.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const text = stripCommentsForRegex(context.readFile(file) ?? '', 'java');
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1] ?? '';
  const single = new Set<string>();
  const demand = new Set<string>();
  for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+?)(\.\*)?\s*;/gm)) (m[2] ? demand : single).add(m[1]!);
  const scope = { pkg, single, demand };
  memo.set(file, scope);
  return scope;
}

/** The simple names of the Java types `qn` extends or implements, a few levels up. */
function javaAncestorNames(qn: string, context: ResolutionContext, depth = 0): Set<string> {
  let memo = JAVA_ANCESTORS.get(context);
  if (!memo) JAVA_ANCESTORS.set(context, (memo = new Map()));
  const hit = memo.get(qn);
  if (hit) return hit;
  const names = new Set<string>();
  memo.set(qn, names);
  for (const decl of context.getNodesByQualifiedName(qn)) {
    if (decl.language !== 'java' || !JAVA_TYPE_KINDS_VISIBLE.has(decl.kind)) continue;
    const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
    let header = '';
    for (let i = decl.startLine - 1; i < Math.min(lines.length, decl.startLine + 6) && !header.includes('{'); i++) header += `${lines[i] ?? ''} `;
    const list = /\b(?:extends|implements)\b([^{]*)/.exec(header.split('{')[0]!)?.[1] ?? '';
    for (const m of list.replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, '').matchAll(/([A-Za-z_]\w*)\s*(?=,|$|\bimplements\b|\s*$)/g)) {
      if (m[1] !== 'implements' && m[1] !== 'extends') names.add(m[1]!);
    }
  }
  if (depth < 4) {
    for (const base of [...names]) {
      for (const t of context.getNodesByName(base)) {
        if (t.language !== 'java' || !JAVA_TYPE_KINDS_VISIBLE.has(t.kind) || t.qualifiedName === qn) continue;
        for (const up of javaAncestorNames(t.qualifiedName, context, depth + 1)) names.add(up);
      }
    }
  }
  return names;
}

/**
 * Whether a bare Java type name at `ref` can mean `candidate`. A top-level type
 * is in reach from its own package and through a single-type or on-demand
 * import; a nested type from inside its owner (or a type deriving from it) or
 * through an import of it or of its owner's members. halo's `Context`,
 * retrofit's `Builder`, jsoup's `Attribute` (meant: `Evaluator.Attribute`)
 * reached a same-named type nothing imported.
 */
export function isJavaTypeVisible(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.language !== 'java' || candidate.language !== 'java') return true;
  if (!/^[A-Za-z_$][\w$]*$/.test(ref.referenceName)) return true;
  // A constructor is in reach where its type is: lombok's `@Builder` and
  // okhttp's `new OkHttpClient.Builder()` are no project `Builder`'s constructor.
  if (candidate.kind === 'method') {
    const segs = candidate.qualifiedName.split('::');
    if (segs.length < 2 || segs[segs.length - 2] !== candidate.name || ref.referenceKind === 'calls') return true;
    const owner = context.getNodesInFile(candidate.filePath).find((n) =>
      n.qualifiedName === segs.slice(0, -1).join('::') && JAVA_TYPE_KINDS_VISIBLE.has(n.kind));
    return !owner || isJavaTypeVisible(owner, ref, context);
  }
  // An enum constant by its bare name: inside its enum, a `case` label, a
  // static import, or written through its enum — never `java.lang.Character`'s
  // `Character.MIN_SUPPLEMENTARY_CODE_POINT` (jsoup's `TokenType.Character`).
  if (candidate.kind === 'enum_member') {
    if (candidate.filePath === ref.filePath) return true;
    const segs = candidate.qualifiedName.split('::');
    const enumName = segs[segs.length - 2] ?? '';
    const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split(/\r?\n/)[ref.line - 1] ?? '';
    const name = ref.referenceName.replace(/\$/g, '\\$');
    if (new RegExp(`\\bcase\\b[^:;]*\\b${name}\\b`).test(line) || new RegExp(`\\b${enumName}\\s*\\.\\s*${name}\\b`).test(line)) return true;
    const here = javaFileScope(ref.filePath, context);
    const enumFqn = [javaFileScope(candidate.filePath, context).pkg, ...segs.slice(1, -1)].filter((p) => p !== '').join('.');
    return here.single.has(`${enumFqn}.${ref.referenceName}`) || here.demand.has(enumFqn);
  }
  if (!JAVA_TYPE_KINDS_VISIBLE.has(candidate.kind)) return true;
  const segs = candidate.qualifiedName.split('::');
  const candidateScope = javaFileScope(candidate.filePath, context);
  // The QN leads with the package when there is one.
  const typePath = candidateScope.pkg && segs[0] === candidateScope.pkg ? segs.slice(1) : segs;
  const fqn = [candidateScope.pkg, ...typePath].filter((p) => p !== '').join('.');
  const here = javaFileScope(ref.filePath, context);
  // Written with a qualifier — `RequestFactory.Builder`, `java.util.Map`, an
  // inner class's `outer.new Inner()` — the qualifier says which: the owner
  // (or the package) of this candidate.
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split(/\r?\n/)[ref.line - 1] ?? '';
  if (new RegExp(`\\.\\s*new\\s+${ref.referenceName.replace(/\$/g, '\\$')}\\b`).test(line)) return true;
  // (A type annotation may sit between them: jsoup's `Range.@Nullable Spans`.)
  const qualifiers = [...line.matchAll(new RegExp(`([A-Za-z_$][\\w$.]*)\\s*\\.\\s*(?:@[\\w.]+(?:\\([^)]*\\))?\\s+)*${ref.referenceName.replace(/\$/g, '\\$')}\\b`, 'g'))].map((m) => m[1]!);
  // Nested only inside a type the file declares; a class local to a method is
  // the lexical rule's to judge.
  const ownerQn = segs.slice(0, -1).join('::');
  const ownerNode = segs.length > 1
    ? context.getNodesInFile(candidate.filePath).find((n) => n.qualifiedName === ownerQn && n.kind !== 'namespace' && n.kind !== 'file')
    : undefined;
  if (ownerNode && !JAVA_TYPE_KINDS_VISIBLE.has(ownerNode.kind)) return true;
  const nested = ownerNode !== undefined;
  const ownerName = nested ? ownerNode.name : '';
  if (qualifiers.some((q) => (nested && (q === ownerName || q.endsWith(`.${ownerName}`))) || (!nested && q === candidateScope.pkg))) return true;
  if (!nested) {
    if (candidate.filePath === ref.filePath || candidateScope.pkg === here.pkg) return true;
    return here.single.has(fqn) || here.demand.has(candidateScope.pkg);
  }
  // Nested: inside its owner, a subtype of it, or imported.
  const enclosing = context.getNodesInFile(ref.filePath)
    .filter((p) => JAVA_TYPE_KINDS_VISIBLE.has(p.kind) && p.startLine <= ref.line && p.endLine >= ref.line);
  if (enclosing.some((p) => p.qualifiedName === ownerQn || p.qualifiedName.startsWith(`${ownerQn}::`))) return true;
  // An anonymous class (`new NodeFilter() { … }`, named `<NodeFilter$anon@N>`) derives from what it instantiates.
  const supertypesAround = (p: Node): string[] => {
    const anon = /<([A-Za-z_$][\w$]*)\$anon@\d+>$/.exec(p.name)?.[1] ?? /<([A-Za-z_$][\w$]*)\$anon@\d+>/.exec(p.qualifiedName.split('::').pop() ?? '')?.[1];
    if (!anon) return [...javaAncestorNames(p.qualifiedName, context)];
    const ups = [anon];
    for (const t of context.getNodesByName(anon)) if (t.language === 'java' && JAVA_TYPE_KINDS_VISIBLE.has(t.kind)) ups.push(...javaAncestorNames(t.qualifiedName, context));
    return ups;
  };
  if (enclosing.some((p) => supertypesAround(p).includes(ownerName))) return true;
  const ownerFqn = fqn.slice(0, fqn.lastIndexOf('.'));
  return here.single.has(fqn) || here.demand.has(ownerFqn);
}

const JAVA_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'struct', 'record', 'trait']);
export const JAVA_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();
export const JAVA_STATIC_IMPORTS = new WeakMap<ResolutionContext, Map<string, { owners: Set<string>; members: Set<string> }>>();

/**
 * A bare Java call — `verify(mock)`, `helper()`, `this.x()`, `super.x()` —
 * reaches a method of a class around it, of one of that class's supertypes, or
 * one the file imports statically. Not some other class's method of that name:
 * halo's tests' Mockito `verify(…)` and `eq(…)` bound 1,038 calls to an
 * `EmailVerificationService.verify` and 845 to a builder's `eq`. Supertypes are
 * read from the declarations — the resolved `extends` edges do not exist yet on
 * the first pass.
 */
export function isJavaMethodInScope(method: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut < 0) return true;
  const owner = method.qualifiedName.slice(0, cut).split('::').pop()!;
  const imports = javaStaticImportsOf(ref.filePath, context);
  if (imports.owners.has(owner) || imports.members.has(`${owner}.${ref.referenceName}`)) return true;
  const around = context
    .getNodesInFile(ref.filePath)
    .filter((n) => JAVA_TYPE_KINDS.has(n.kind) && n.startLine <= ref.line && n.endLine >= ref.line);
  const seen = new Set<string>();
  const queue = around.map((n) => n.name);
  while (queue.length > 0 && seen.size < 40) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === owner) return true;
    queue.push(...javaSupertypesOf(name, context));
  }
  return false;
}

/** The simple names a Java type's declarations extend or implement. */
function javaSupertypesOf(typeName: string, context: ResolutionContext): string[] {
  let memo = JAVA_SUPERS.get(context);
  if (!memo) {
    memo = new Map();
    JAVA_SUPERS.set(context, memo);
  }
  const hit = memo.get(typeName);
  if (hit) return hit;
  const names: string[] = [];
  for (const decl of context.getNodesByName(typeName)) {
    if (decl.language !== 'java' || !JAVA_TYPE_KINDS.has(decl.kind)) continue;
    const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
    const head = lines.slice(decl.startLine - 1, decl.startLine + 5).join(' ');
    const clause = /\b(?:extends|implements)\b([^{]*)\{/.exec(head)?.[1] ?? '';
    const flat = clause.replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, '');
    for (const m of flat.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)) {
      const simple = m[1]!.split('.').pop()!;
      if (simple !== 'extends' && simple !== 'implements') names.push(simple);
    }
  }
  memo.set(typeName, names);
  return names;
}

/** A Java file's `import static a.b.Owner.member;` / `import static a.b.Owner.*;`. */
function javaStaticImportsOf(filePath: string, context: ResolutionContext): { owners: Set<string>; members: Set<string> } {
  let memo = JAVA_STATIC_IMPORTS.get(context);
  if (!memo) {
    memo = new Map();
    JAVA_STATIC_IMPORTS.set(context, memo);
  }
  const hit = memo.get(filePath);
  if (hit) return hit;
  const found = { owners: new Set<string>(), members: new Set<string>() };
  const text = context.readFile(filePath) ?? '';
  for (const m of text.matchAll(/^\s*import\s+static\s+([\w.$]+)\s*\.\s*(\*|[\w$]+)\s*;/gm)) {
    const owner = m[1]!.split('.').pop()!;
    if (m[2] === '*') found.owners.add(owner);
    else found.members.add(`${owner}.${m[2]}`);
  }
  memo.set(filePath, found);
  return found;
}

/**
 * When several classes share a simple type name, the caller file's import of
 * that type is the only signal that names WHICH one (#314). Returns the imported
 * FQN for `typeName` in the ref's file, or undefined.
 */
export function importedFqnOf(
  typeName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | undefined {
  const imports = context.getImportMappings(ref.filePath, ref.language);
  return imports.find((i) => i.localName === typeName)?.source;
}

/**
 * Java/Kotlin: infer a receiver's declared type by walking field declarations
 * in the class enclosing the call site. The field's `signature` is already in
 * the form "<TypeName> <fieldName>" (set by tree-sitter.ts extractField), so we
 * pull the type from there. Handles Spring `@Resource UserBO userbo;` /
 * `@Autowired private UserService userService;` where the receiver field name
 * doesn't match the class name by Java naming convention.
 *
 * Returns the bare type name (generics stripped, dotted package stripped) or
 * null when no matching field is in the enclosing class.
 */
export function inferJavaFieldReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  const inFile = context.getNodesInFile(ref.filePath);
  if (inFile.length === 0) return null;

  // Find the class enclosing the call line (tightest match by latest start).
  let enclosing: Node | null = null;
  for (const n of inFile) {
    if (n.kind !== 'class' && n.kind !== 'interface') continue;
    if (n.language !== ref.language) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= ref.line && end >= ref.line) {
      if (!enclosing || n.startLine >= enclosing.startLine) enclosing = n;
    }
  }
  if (!enclosing) return null;

  const enclosingEnd = enclosing.endLine ?? enclosing.startLine;
  const field = inFile.find(
    (n) =>
      n.kind === 'field' &&
      n.name === receiverName &&
      n.language === ref.language &&
      n.startLine >= enclosing.startLine &&
      (n.endLine ?? n.startLine) <= enclosingEnd,
  );
  if (!field || !field.signature) return null;

  // Signature shape: "<TypeName> <fieldName>" (extractField). Pull the type,
  // strip generics + dotted package, drop array/varargs markers.
  const beforeName = field.signature.slice(
    0,
    field.signature.lastIndexOf(field.name),
  );
  const typeRaw = beforeName.trim();
  if (!typeRaw) return null;

  const typeNoGenerics = typeRaw.replace(/<[^>]*>/g, '').trim();
  const typeNoArray = typeNoGenerics.replace(/\[\s*\]/g, '').replace(/\.\.\.$/, '').trim();
  const parts = typeNoArray.split(/[.\s]+/).filter(Boolean);
  const lastPart = parts[parts.length - 1];
  if (!lastPart) return null;
  if (!/^[A-Z]/.test(lastPart)) return null; // primitives / lowercase → skip
  return lastPart;
}
