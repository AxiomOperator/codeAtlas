/**
 * Go scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { UnresolvedRef, ResolvedRef, ResolutionContext } from '../../types';
import { contextGoModules, goImportPackageDir } from '../../go-module';
import { inferLocalReceiverType } from '../receiver-inference';
import { resolveMethodOnType } from '../strategies/method-call';
import { preferCallSiteFile } from '../strategies/qualified';

export const GO_EXTERNAL_QUALIFIED = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * Whether a Go reference is written through an imported package from outside
 * the module — `context.Context`, `fmt.Errorf`, a third-party `gin.H` — read
 * from its line, since the index keeps only the name.
 */
export function isGoExternalQualified(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.referenceKind === 'imports') return false;
  const name = ref.referenceName.split('.').pop()!;
  if (!/^[A-Za-z_]\w*$/.test(name)) return false;
  let memo = GO_EXTERNAL_QUALIFIED.get(context);
  if (!memo) GO_EXTERNAL_QUALIFIED.set(context, (memo = new Map()));
  const key = `${ref.filePath}\0${ref.line}\0${ref.column}\0${ref.referenceName}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let external = false;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split(/\r?\n/)[ref.line - 1] ?? '';
  const at = Math.max(0, ref.column);
  // The qualifier right before the name at the reference's column, or the
  // line's only spelling of the name.
  const before = line.startsWith(name, at) ? /(?:^|[^\w.])([A-Za-z_]\w*)\.$/.exec(line.slice(0, at))?.[1]
    : !new RegExp(`(?<![\\w.])${name}\\b`).test(line) ? new RegExp(`(?:^|[^\\w.])([A-Za-z_]\\w*)\\.${name}\\b`).exec(line)?.[1] : undefined;
  if (before) {
    const imported = context.getImportMappings(ref.filePath, 'go').find((m) => m.localName === before);
    if (imported) {
      const local = imported.source.startsWith('.') || imported.source.includes('/internal/') ||
        goImportPackageDir(imported.source, contextGoModules(context)) !== null;
      external = !local;
    }
  }
  memo.set(key, external);
  return external;
}

/** Go builtin/primitive field types that can never carry a project method. */
const GO_BUILTIN_FIELD_TYPES = new Set([
  'string', 'bool', 'byte', 'rune', 'error', 'any',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
  'chan', 'map', 'func', 'struct', 'interface',
]);

/**
 * Resolve a Go 2-hop field-chain call `base.field.Method(...)` (#1276):
 * `target.conn.Exec("insert")` where `func (target *Target) Write()` and
 * `type Target struct { conn *sql.DB }`. Two inference hops, both read from
 * source the same way #1108 does:
 *   1. `base`'s type from the enclosing scope (method receiver, typed
 *      parameter, or local declaration) via inferLocalReceiverType;
 *   2. `field`'s declared type from the struct's own declaration lines.
 * The method is then resolved AND VALIDATED on the field's type. A field
 * whose type has no project node (`sql.DB`, any external dependency) yields
 * null — the caller treats this branch as exclusive for chained Go
 * receivers, so the ref stays unresolved instead of name-guessing.
 */
export function matchGoFieldChainCall(
  receiverChain: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const segs = receiverChain.split('.');
  if (segs.length !== 2 || !segs[0] || !segs[1]) return null;
  const [base, field] = segs;

  const baseType = inferLocalReceiverType(base!, ref, context);
  if (!baseType) return null;

  const fieldEsc = field!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldTypeRe = new RegExp(`\\b${fieldEsc}\\s+\\*?\\[?\\]?([A-Za-z_][\\w.]*)`);

  const structs = preferCallSiteFile(context.getNodesByName(baseType), ref.filePath).filter(
    (n) => (n.kind === 'struct' || n.kind === 'class') && n.language === 'go'
  );
  for (const s of structs) {
    const source = context.readFile(s.filePath);
    if (!source) continue;
    // Only the struct's own declaration lines — a same-named identifier
    // elsewhere in the file can't donate a type. Matched LINE BY LINE with
    // comments stripped: chi's `Mux` has a doc comment reading "the tree
    // router" right above `tree *node`, and a whole-block match captured
    // `router` from the prose instead of `node` from the field.
    const declLines = source.split('\n').slice(Math.max(0, s.startLine - 1), s.endLine);
    for (const rawLine of declLines) {
      const line = rawLine.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      const m = line.match(fieldTypeRe);
      if (!m || !m[1]) continue;
      const rawType = m[1];
      // A package-qualified field type (`http.Handler`, `sql.DB`) is only
      // followed when the package is IN-MODULE: stripping the qualifier and
      // matching the bare name would conflate a stdlib/third-party type with
      // any same-named project type — on chi, `handler http.Handler` bound
      // to an example app's unrelated local `Handler`. That is the exact
      // fabrication this matcher exists to prevent (#1276).
      if (rawType.includes('.')) {
        const pkg = rawType.split('.')[0]!;
        const imp = context
          .getImportMappings(s.filePath, 'go')
          .find((i) => i.localName === pkg);
        const inModule = !!imp && goImportPackageDir(imp.source, contextGoModules(context)) !== null;
        if (!inModule) continue;
      }
      // Unexported (lowercase) types are idiomatic Go and stay eligible —
      // chi's `mx.tree.FindRoute()` chains through `tree *node`. A
      // mis-capture is harmless: resolveMethodOnType only returns a
      // validated `<type>::<method>` match.
      const fieldType = rawType.split('.').pop();
      if (!fieldType || !/^[A-Za-z_]/.test(fieldType) || GO_BUILTIN_FIELD_TYPES.has(fieldType)) continue;
      const resolved = resolveMethodOnType(fieldType, methodName, ref, context, 0.85, 'instance-method');
      if (resolved) return resolved;
    }
  }
  return null;
}
