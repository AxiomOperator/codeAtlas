/**
 * TypeScript class fields scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from '../../types';
import { sameLanguageFamily } from '../language-family';
import { resolveObjectLiteralMember } from '../object-literal';
import { resolveMethodOnType } from '../strategies/method-call';
import { preferCallSiteFile } from '../strategies/qualified';

/**
 * Per-context memo for matchTsThisFieldCall's declaration scan: `classId\0field`
 * → the first line of the class that declares the field (as `: typeof X`,
 * `: X`, or `= new X`, tried in that order per line) with its captured type,
 * or null. The scan depends only on the class and the field, but ran for every
 * `this.<field>.<method>()` call — re-splitting the file and compiling three
 * patterns each time, a third of all method-call matching on vscode. Derived
 * from file source: drops with clearNameMatcherMemos.
 */
export const TS_FIELD_DECL_MEMO = new WeakMap<ResolutionContext, Map<string, { valueType: boolean; type: string } | null>>();
/** A class's comment-stripped lines, and which of them hold each `[\w$#]` token. */
interface TsClassDecl {
  lines: string[];
  /** Field lookups so far; the token index is built on the second. */
  lookups: number;
  linesByToken: Map<string, number[]> | null;
}
/** The last few classes' declarations — calls arrive file by file. */
export const TS_CLASS_LINES = new WeakMap<ResolutionContext, Map<string, TsClassDecl | null>>();
const TS_CLASS_LINES_KEEP = 32;

function tsClassDecl(cls: Node, context: ResolutionContext): TsClassDecl | null {
  let cache = TS_CLASS_LINES.get(context);
  if (!cache) {
    cache = new Map();
    TS_CLASS_LINES.set(context, cache);
  }
  const hit = cache.get(cls.id);
  if (hit !== undefined) return hit;
  const source = context.readFile(cls.filePath);
  const decl = source
    ? {
        lines: source
          .split('\n')
          .slice(Math.max(0, cls.startLine - 1), cls.endLine)
          .map((rawLine) => rawLine.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')),
        lookups: 0,
        linesByToken: null,
      }
    : null;
  if (cache.size >= TS_CLASS_LINES_KEEP) cache.delete(cache.keys().next().value!);
  cache.set(cls.id, decl);
  return decl;
}

const TS_FIELD_TOKEN = /^[\w$#]+$/;
const TS_LINE_TOKEN = /[\w$#]+/g;
const TS_TOKEN_CHAR = /[\w$#]/;

/**
 * tsFieldPatterns with the field spelled `[\w$#]+`, tried sticky at a whole-
 * token occurrence of the field. There the run consumes exactly the field (a
 * shorter prefix cannot continue: every pattern needs `\s`, `?`, `!`, `:` or
 * `=` next), so each matches exactly where the field's own pattern would —
 * without compiling three patterns for every field of every class.
 */
const TS_FIELD_PATTERNS_AT: readonly TsFieldPattern[] = [
  { re: /(?<![\w$#])[\w$#]+\b\s*[?!]?\s*:\s*(?:readonly\s+)?typeof\s+([A-Za-z_$][\w.$]*)/y, valueType: true },
  { re: /(?<![\w$#])[\w$#]+\b\s*[?!]?\s*:\s*(?:readonly\s+)?([A-Za-z_$][\w.$]*)/y, valueType: false },
  { re: /(?<![\w$#])[\w$#]+\b\s*=\s*new\s+([A-Za-z_$][\w.$]*)/y, valueType: false },
];

/** The first declaration of `field` on one line, as `line.match` of its patterns in order would find it. */
function tsFieldOnLine(line: string, field: string): { valueType: boolean; type: string } | null {
  let at: number[] | null = null;
  for (let i = line.indexOf(field); i !== -1; i = line.indexOf(field, i + 1)) {
    const end = i + field.length;
    if ((i > 0 && TS_TOKEN_CHAR.test(line[i - 1]!)) || (end < line.length && TS_TOKEN_CHAR.test(line[end]!))) continue;
    (at ??= []).push(i);
  }
  if (!at) return null;
  for (const { re, valueType } of TS_FIELD_PATTERNS_AT) {
    for (const i of at) {
      re.lastIndex = i;
      const m = re.exec(line);
      if (m && m[1]) return { valueType, type: m[1] };
    }
  }
  return null;
}

/** Indices of the class lines holding `token` as a whole `[\w$#]` run, ascending. */
function tsClassLinesWithToken(decl: TsClassDecl, token: string): readonly number[] {
  if (!decl.linesByToken) {
    const index = new Map<string, number[]>();
    for (let i = 0; i < decl.lines.length; i++) {
      for (const m of decl.lines[i]!.matchAll(TS_LINE_TOKEN)) {
        const rows = index.get(m[0]);
        if (!rows) index.set(m[0], [i]);
        else if (rows[rows.length - 1] !== i) rows.push(i);
      }
    }
    decl.linesByToken = index;
  }
  return decl.linesByToken.get(token) ?? [];
}

type TsFieldPattern = { re: RegExp; valueType: boolean };
/** Compiled declaration patterns by field name — fields recur across classes. */
const TS_FIELD_PATTERNS = new Map<string, TsFieldPattern[]>();
const TS_FIELD_PATTERNS_CAP = 4096;

function tsFieldPatterns(field: string): TsFieldPattern[] {
  const hit = TS_FIELD_PATTERNS.get(field);
  if (hit) return hit;
  const fieldEsc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A word boundary cannot open a private name; it also lets a public
  // `items` match `#items`. Keep the two field namespaces distinct (#1987).
  const fieldStart = '(?<![\\w$#])';
  const patterns: TsFieldPattern[] = [
    // `storage: typeof DraftHubStorage` — the type OF a value: an object
    // literal used as a namespace. Its members are bare-named functions inside
    // the constant's extent (#1573), so they are found by containment, not by
    // `Type::method`. Tried first: the declared-type pattern below would
    // otherwise capture the word `typeof`.
    {
      re: new RegExp(`${fieldStart}${fieldEsc}\\b\\s*[?!]?\\s*:\\s*(?:readonly\\s+)?typeof\\s+([A-Za-z_$][\\w.$]*)`),
      valueType: true,
    },
    // `private readonly mailer?: Mailer` — a class field or a constructor
    // parameter property; the capture stops at `<`, `[` or `|`, so a generic
    // or union type yields its head and resolveMethodOnType decides.
    {
      re: new RegExp(`${fieldStart}${fieldEsc}\\b\\s*[?!]?\\s*:\\s*(?:readonly\\s+)?([A-Za-z_$][\\w.$]*)`),
      valueType: false,
    },
    // `mailer = new Mailer()` / `this.mailer = new Mailer()`
    { re: new RegExp(`${fieldStart}${fieldEsc}\\b\\s*=\\s*new\\s+([A-Za-z_$][\\w.$]*)`), valueType: false },
  ];
  if (TS_FIELD_PATTERNS.size >= TS_FIELD_PATTERNS_CAP) TS_FIELD_PATTERNS.delete(TS_FIELD_PATTERNS.keys().next().value!);
  TS_FIELD_PATTERNS.set(field, patterns);
  return patterns;
}

function tsFieldDeclaration(
  cls: Node,
  field: string,
  context: ResolutionContext
): { valueType: boolean; type: string } | null {
  let memo = TS_FIELD_DECL_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    TS_FIELD_DECL_MEMO.set(context, memo);
  }
  const key = cls.id + '\0' + field;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let found: { valueType: boolean; type: string } | null = null;
  const decl = tsClassDecl(cls, context);
  if (decl && TS_FIELD_TOKEN.test(field)) {
    // Every pattern needs the field as a whole `[\w$#]` run — the lookbehind
    // bars one before it, and nothing after it but `\s`, `?`, `!`, `:` or `=`
    // can continue a match — so only lines holding that token can match. A
    // class asked about several fields is indexed by token once.
    const rows = ++decl.lookups > 1 ? tsClassLinesWithToken(decl, field) : null;
    const count = rows ? rows.length : decl.lines.length;
    for (let k = 0; k < count && !found; k++) {
      const line = decl.lines[rows ? rows[k]! : k]!;
      // Every pattern spells the field literally, so only a line that contains
      // it can match — and most of a class's lines never mention a given field.
      if (line.includes(field)) found = tsFieldOnLine(line, field);
    }
  } else if (decl) {
    const patterns = tsFieldPatterns(field);
    scan: for (const line of decl.lines) {
      if (!line.includes(field)) continue;
      for (const { re, valueType } of patterns) {
        const m = line.match(re);
        if (!m || !m[1]) continue;
        found = { valueType, type: m[1] };
        break scan;
      }
    }
  }
  memo.set(key, found);
  return found;
}

/**
 * Resolve a TS/JS `this.<field>.<method>()` call (#1496) through the field's
 * declared type, read off the ENCLOSING class's own declaration lines:
 * a field or constructor-parameter property (`private mailer: Mailer`,
 * `mailer?: Mailer`, `readonly mailer: Mailer`) or an initializer
 * (`mailer = new Mailer()`, `this.mailer = new Mailer()`). The method is then
 * VALIDATED on that type by resolveMethodOnType. Null — never a bare-name
 * fallback — when the field is not declared there or its type is external,
 * a builtin (`this.items.push()`) or not spelled out.
 */
export function matchTsThisFieldCall(
  field: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  if (!field || field.includes('.')) return null;
  const caller = context.getNodeById?.(ref.fromNodeId);
  if (!caller) return null;
  const sep = caller.qualifiedName.lastIndexOf('::');
  if (sep <= 0) return null; // not inside a class
  const owner = caller.qualifiedName.slice(0, sep).split('::').pop();
  if (!owner) return null;

  const owners = preferCallSiteFile(context.getNodesByName(owner), ref.filePath).filter(
    (n) => (n.kind === 'class' || n.kind === 'component') && sameLanguageFamily(n.language, ref.language)
  );
  for (const cls of owners) {
    const decl = tsFieldDeclaration(cls, field, context);
    if (!decl) continue;
    if (decl.valueType) {
      // The value's declaration may live in another file (it is imported);
      // the call site's file is preferred when several share the name.
      const holderName = decl.type.split('.').pop()!;
      const holders = preferCallSiteFile(context.getNodesByName(holderName), ref.filePath).filter(
        (n) => (n.kind === 'constant' || n.kind === 'variable') && sameLanguageFamily(n.language, ref.language)
      );
      for (const holder of holders) {
        const hit = resolveObjectLiteralMember(holder, methodName, ref, context, 0.85, 'instance-method');
        if (hit) return hit;
      }
      return null;
    }
    // `ns.Mailer` → `Mailer`; a primitive or builtin names no project type.
    const typeName = decl.type.split('.').pop()!;
    if (!/^[A-Z]/.test(typeName)) return null;
    // Two apps in one repo may each declare a `UserService`. The bare-name
    // path this replaces broke that tie by directory proximity, so keep the
    // same signal: among the type's declarations of the method, prefer the
    // one closest to the call site's directory (its own app), never index
    // order. resolveMethodOnType still answers the single-declaration and
    // supertype cases.
    const declared = context
      .getNodesByName(methodName)
      .filter(
        (n) =>
          n.kind === 'method' &&
          sameLanguageFamily(n.language, ref.language) &&
          (n.qualifiedName === `${typeName}::${methodName}` || n.qualifiedName.endsWith(`::${typeName}::${methodName}`))
      );
    if (declared.length > 1) {
      const callDirs = ref.filePath.split('/').slice(0, -1);
      const shared = (fp: string) => {
        const dirs = fp.split('/').slice(0, -1);
        let i = 0;
        while (i < dirs.length && i < callDirs.length && dirs[i] === callDirs[i]) i++;
        return i;
      };
      const nearest = [...declared].sort((a, b) => shared(b.filePath) - shared(a.filePath) || a.filePath.localeCompare(b.filePath))[0]!;
      return { original: ref, targetNodeId: nearest.id, confidence: 0.85, resolvedBy: 'instance-method' };
    }
    return resolveMethodOnType(typeName, methodName, ref, context, 0.85, 'instance-method');
  }
  return null;
}
