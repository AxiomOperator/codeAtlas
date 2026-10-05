/**
 * Object-literal members and bindings (`const api = { fetch() {} }`, namespace objects).
 *
 * Part of the name matcher (see ../name-matcher.ts).
 */

import { Node } from '../../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { blankStringContents, stripCommentsForRegex } from '../strip-comments';
import { sameLanguageFamily } from './language-family';
import { hasParameterBinding } from './strategies/js-store';

/**
 * Languages whose object literals declare callable members — `export const
 * api = { call() {…}, get: () => {…} }` used as a namespace (#1573).
 */
export const OBJECT_LITERAL_LANGUAGES = new Set<string>(['typescript', 'tsx', 'javascript', 'jsx', 'arkts']);

/** True when `inner`'s source range lies within `outer`'s (lines, then columns on a shared line). */
export function rangeWithin(inner: Node, outer: Node): boolean {
  const innerEnd = inner.endLine ?? inner.startLine;
  const outerEnd = outer.endLine ?? outer.startLine;
  if (inner.startLine < outer.startLine || innerEnd > outerEnd) return false;
  if (inner.startLine === outer.startLine && inner.startColumn < outer.startColumn) return false;
  if (innerEnd === outerEnd && inner.endColumn > outer.endColumn) return false;
  return true;
}

export function sameRange(a: Node, b: Node): boolean {
  return (
    a.startLine === b.startLine &&
    a.startColumn === b.startColumn &&
    (a.endLine ?? a.startLine) === (b.endLine ?? b.startLine) &&
    a.endColumn === b.endColumn
  );
}

/**
 * Resolve `container.member` where `container` is a VALUE holding an object
 * literal — `export const api = { call() {…}, get: () => {…} }` used as the
 * module's namespace (#1573). The members are extracted as plain functions
 * with BARE qualified names inside the constant's source extent (there is no
 * `api::call`), so neither the `Container::member` lookup the class-shaped
 * kinds use (#825) nor the declared-type inference for singleton instances
 * (#1292) can reach them, and every such call resolved to nothing — or, via
 * an import, to the constant itself. This looks the member up by CONTAINMENT:
 * a node named `member` whose range lies inside the container's, in the
 * container's own file. A helper declared inside a member's body is not a
 * member and is skipped; nothing else in the file can donate a match. Calls
 * take callable kinds only; other references accept value members too.
 */
export function resolveObjectLiteralMember(
  container: Node,
  member: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  confidence: number,
  resolvedBy: ResolvedRef['resolvedBy'],
): ResolvedRef | null {
  if (container.kind !== 'constant' && container.kind !== 'variable') return null;
  if (!OBJECT_LITERAL_LANGUAGES.has(container.language)) return null;
  if (!sameLanguageFamily(container.language, ref.language)) return null;

  const inFile = context.getNodesInFile(container.filePath);
  const callable = (n: Node) => n.kind === 'function' || n.kind === 'method';
  const valueMember = (n: Node) =>
    callable(n) || n.kind === 'property' || n.kind === 'variable' || n.kind === 'constant';
  const accepts = ref.referenceKind === 'calls' ? callable : valueMember;

  const inside = inFile.filter((n) => n.id !== container.id && rangeWithin(n, container));
  const property = objectLiteralProperty(container, member, context);
  if (property === null || property?.binding) return null;
  let candidates = inside.filter((n) => n.name === member && accepts(n) && (!property || property.contains(n)));
  if (candidates.length === 0) return null;

  // Drop a candidate nested inside ANOTHER callable's body within the literal
  // (`{ run() { const call = () => {}; } }` — `call` is `run`'s local, not a
  // member). Strict containment: an identically-ranged sibling node for the
  // same member (a property node over an arrow function) is not a body.
  const bodies = inside.filter(callable);
  candidates = candidates.filter(
    (c) => !bodies.some((b) => b.id !== c.id && !sameRange(b, c) && rangeWithin(c, b))
  );
  if (candidates.length === 0) return null;

  // Several survivors (a property AND a function for one arrow member, say):
  // a callable first, then the earliest in source order.
  candidates.sort((a, b) => {
    const ca = callable(a) ? 0 : 1;
    const cb = callable(b) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    return a.startLine - b.startLine || a.startColumn - b.startColumn;
  });
  return {
    original: ref,
    targetNodeId: candidates[0]!.id,
    confidence,
    resolvedBy,
  };
}

/**
 * Script-tag JS (#2300): a namespace hung off a global in one file —
 * `window.api = { load() {…} }` — and called as `api.load()` from another, with
 * no import between them. Only a holder minted from such a member assignment
 * qualifies (a plain `const api` elsewhere is a module's private binding), the
 * call site must not import the name, and exactly one holder may answer.
 */
export function resolveGlobalNamespaceMember(
  holderName: string,
  member: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const candidates = context
    .getNodesByName(holderName)
    .filter((n) => n.kind === 'variable' && n.filePath !== ref.filePath && sameLanguageFamily(n.language, ref.language));
  if (candidates.length === 0) return null;
  if (context.getImportMappings?.(ref.filePath, ref.language)?.some((m) => m.localName === holderName)) return null;
  const assigned = new RegExp(`^[\\w$]+(?:\\.[\\w$]+)*\\.${holderName.replace(/\$/g, '\\$')}\\s*=`);
  const hits: ResolvedRef[] = [];
  for (const holder of candidates) {
    const line = (context.getFileLines?.(holder.filePath) ?? context.readFile(holder.filePath)?.split('\n'))?.[
      holder.startLine - 1
    ];
    if (!line || !assigned.test(line.slice(holder.startColumn))) continue;
    const hit = resolveObjectLiteralMember(holder, member, ref, context, 0.75, 'instance-method');
    if (hit) hits.push(hit);
    if (hits.length > 1) return null;
  }
  return hits[0] ?? null;
}

/**
 * The binding an object-literal member names when it is a shorthand property
 * (`{ getUser }`) or a pair whose value is a bare identifier (`{ getUser:
 * fetchUser }`) — the usual way an API module assembles its namespace from
 * standalone functions (#1932). Only the literal's own members count: a member
 * of a nested object, a word inside a member's body, a comment or a string
 * never donates one. Null when the member is absent, or when its value is not
 * a bare identifier (`{ fn: 1 }` names nothing).
 */
export function objectLiteralMemberBinding(
  container: Node,
  member: string,
  context: ResolutionContext,
): string | null {
  return objectLiteralProperty(container, member, context)?.binding ?? null;
}

/** The last own property wins; an unknown spread/computed key invalidates earlier evidence. */
function objectLiteralProperty(
  container: Node,
  member: string,
  context: ResolutionContext,
): { binding: string | null; contains: (node: Node) => boolean } | null | undefined {
  const lines = context.getFileLines?.(container.filePath) ?? context.readFile(container.filePath)?.split('\n');
  if (!lines) return undefined;
  const extentLines = lines.slice(container.startLine - 1, container.endLine);
  if (!extentLines.length) return undefined;
  extentLines[extentLines.length - 1] = extentLines[extentLines.length - 1]!.slice(0, container.endColumn);
  extentLines[0] = extentLines[0]!.slice(container.startColumn);
  const extent = stripCommentsForRegex(extentLines.join('\n'), 'typescript');
  const code = blankStringContents(extent);
  // Start at THIS declarator, including its columns, never a sibling on the same line.
  const open = /^[^=]*=\s*(?:(?:Object\.(?:freeze|seal)\s*)?\(\s*)*\{/.exec(code);
  if (!open) return undefined;

  const members: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = open[0].length;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === '}') {
      if (depth === 0) {
        members.push({ start, end: i });
        break;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      members.push({ start, end: i });
      start = i + 1;
    }
  }

  let selected: { start: number; end: number; binding: string | null } | null = null;
  for (const part of members) {
    const text = extent.slice(part.start, part.end).trim();
    if (/^(?:\.\.\.|\[)/.test(text)) { selected = null; continue; }
    const key = /^(?:(?:async|get|set)\s+)?\*?\s*(?:([A-Za-z_$][\w$]*)|['"]([^'"\\]*)['"])(?=\s*(?:[:(<,=]|$))/.exec(text);
    if ((key?.[1] ?? key?.[2]) !== member) continue;
    const value = text.slice(key![0].length).trim();
    const binding = value === '' ? member : /^:\s*([A-Za-z_$][\w$]*)$/.exec(value)?.[1] ?? null;
    selected = { ...part, binding };
  }
  if (!selected) return null;
  const offset = (node: Node): number => {
    let result = node.startColumn - container.startColumn;
    for (let line = container.startLine; line < node.startLine; line++) result += lines[line - 1]!.length + 1;
    return result;
  };
  const property = selected;
  return { binding: property.binding, contains: (node) => offset(node) >= property.start && offset(node) < property.end };
}

/**
 * Shared lexical lookup for namespace-object aliases (#1932): `api.getUser()` where
 * `api` is `const api = { getUser }` (or `{ getUser: fetchUser }`) in the
 * object's own file. The member's function is declared OUTSIDE the literal, so
 * containment (`resolveObjectLiteralMember`) finds nothing. Follow the binding
 * the member names — a symbol of this file, else one of its imports — unless a
 * parameter or nearer declaration shadows that name where the literal is
 * written (the edge would then name the wrong function).
 */
export function resolveObjectLiteralBinding(
  container: Node,
  member: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const binding = objectLiteralMemberBinding(container, member, context);
  if (!binding) return null;
  const at: UnresolvedRef = { ...ref, filePath: container.filePath, language: container.language,
    fromNodeId: container.id, line: container.startLine, column: container.startColumn };
  const inFile = context.getNodesInFile(container.filePath);
  if (inFile.some((n) => (n.kind === 'function' || n.kind === 'method') &&
      rangeWithin(container, n) && n.signature &&
      hasParameterBinding(`${n.signature} {`, binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))) return null;

  const lines = context.getFileLines?.(container.filePath) ?? context.readFile(container.filePath)?.split('\n');
  if (!lines) return null;
  const code = blankStringContents(stripCommentsForRegex(lines.join('\n'), 'typescript'));
  const offsets = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') offsets.push(i + 1);
  const scopeAt = (node: Node): number[] => {
    const end = (offsets[node.startLine - 1] ?? code.length) + node.startColumn;
    const scope: number[] = [];
    for (let i = 0; i < end; i++) {
      if (code[i] === '{') scope.push(i);
      else if (code[i] === '}') scope.pop();
    }
    return scope;
  };
  const scope = scopeAt(container);

  const callable = (n: Node) => n.kind === 'function' || n.kind === 'method' || n.kind === 'class';
  const accepts =
    ref.referenceKind === 'calls'
      ? callable
      : (n: Node) => callable(n) || n.kind === 'constant' || n.kind === 'variable' || n.kind === 'component';

  const locals = inFile
    .filter((n) => n.name === binding && n.id !== container.id &&
      ['function', 'class', 'constant', 'variable', 'component'].includes(n.kind))
    .map((node) => ({ node, scope: scopeAt(node) }))
    .filter((entry) => entry.scope.every((position, i) => scope[i] === position))
    .sort((a, b) => b.scope.length - a.scope.length);
  // Select the lexical binding BEFORE checking callability: a nearer value
  // shadows an outer function even if that value cannot be called.
  const local = locals[0]?.node;
  if (local) return accepts(local)
    ? { original: ref, targetNodeId: local.id, confidence: 0.85, resolvedBy: 'instance-method' }
    : null;

  const imported = context.resolveImport?.({ ...at, referenceName: binding });
  const target = imported ? context.getNodeById?.(imported.targetNodeId) : null;
  if (target && accepts(target)) {
    return { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'instance-method' };
  }
  return null;
}
