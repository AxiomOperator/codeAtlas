/**
 * Qualified-name strategy (matchByQualifiedName).
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from '../../types';

/**
 * Try to resolve by qualified name
 */
export function matchByQualifiedName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Check if the reference name looks qualified (contains :: or .)
  if (!ref.referenceName.includes('::') && !ref.referenceName.includes('.')) {
    return null;
  }

  // A method call `receiver.method()` can share an exact qualified name with a
  // config-file key: `service.process()` (a `calls` ref named `service.process`)
  // vs the yaml key `service.process`. Config keys are bound to their code refs
  // upstream by the framework resolvers (`@Value` → `references`); a `calls` ref
  // must never resolve to a yaml/properties config node — that's a wrong edge
  // AND it hides the real callee. Drop those from both the exact and the partial
  // candidate sets so resolution falls through to method resolution below (#1180).
  const keepForRef = (nodes: Node[]): Node[] =>
    ref.referenceKind === 'calls'
      ? nodes.filter(
          (n) => !(n.kind === 'constant' && (n.language === 'yaml' || n.language === 'properties')),
        )
      : nodes;

  let candidates = keepForRef(context.getNodesByQualifiedName(ref.referenceName));
  // A C# `using X.Y;` names a namespace: one the project declares, else it is
  // the file's own (external) using — never another file's using of that name.
  if (ref.language === 'csharp' && ref.referenceKind === 'imports') {
    const namespaces = candidates.filter((n) => n.kind === 'namespace');
    candidates = namespaces.length > 0 ? preferCallSiteFile(namespaces, ref.filePath).slice(0, 1)
      : candidates.filter((n) => n.kind !== 'import' || n.filePath === ref.filePath);
  }

  if (candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.95,
      resolvedBy: 'qualified-name',
    };
  }

  // Several symbols share this exact qualified name (e.g. `Logger::log` declared
  // in two files — an ODR clash or separate translation units): prefer the one
  // in the call site's own file before the partial-match fallback below, else
  // the first-indexed def wins and a call in `b/svc` targets `a/svc` (#1079).
  if (candidates.length > 1) {
    const ordered = preferCallSiteFile(candidates, ref.filePath);
    if (ordered[0]!.filePath === ref.filePath) {
      return {
        original: ref,
        targetNodeId: ordered[0]!.id,
        confidence: 0.95,
        resolvedBy: 'qualified-name',
      };
    }
  }

  // Erlang qualified refs (#1610): every erlang function's qualifiedName
  // carries its arity (`mod::f/2`), and refs carry the call-site arity when it
  // is statically known.
  if (ref.language === 'erlang' && ref.referenceName.includes('::')) {
    // A ref WITH arity that missed the exact lookup names an arity that isn't
    // defined (or a module out of repo). Never fall through to the partial
    // match — its "last segment" would be the arity digits — and never settle
    // for a sibling arity: silent beats wrong.
    if (/\/\d{1,3}$/.test(ref.referenceName)) return null;
    // An arity-LESS qualified ref (dynamic MFA whose args list wasn't a
    // static literal): resolve only when the module defines exactly ONE arity
    // of that function; several arities with no signal is a guess.
    const base = ref.referenceName.slice(ref.referenceName.lastIndexOf('::') + 2);
    const prefix = `${ref.referenceName}/`;
    const arityCands = keepForRef(context.getNodesByName(base)).filter(
      (n) =>
        n.qualifiedName.startsWith(prefix) && /^\d{1,3}$/.test(n.qualifiedName.slice(prefix.length)),
    );
    if (arityCands.length === 1) {
      return {
        original: ref,
        targetNodeId: arityCands[0]!.id,
        confidence: 0.85,
        resolvedBy: 'qualified-name',
      };
    }
    return null;
  }

  // Try partial qualified name match — again preferring the call site's own
  // file when more than one symbol's qualifiedName ends with the reference.
  const parts = ref.referenceName.split(/[:.]/);
  const lastName = parts[parts.length - 1];
  if (lastName) {
    const partialCandidates = keepForRef(context.getNodesByName(lastName))
      .filter((candidate) => candidate.qualifiedName.endsWith(ref.referenceName));
    const chosen = preferCallSiteFile(partialCandidates, ref.filePath)[0];
    if (chosen) {
      return {
        original: ref,
        targetNodeId: chosen.id,
        confidence: 0.85,
        resolvedBy: 'qualified-name',
      };
    }
  }

  return null;
}

/** A node a `Receiver.method()` call can name as the method's owning type. */
export function isMethodOwnerKind(n: Node): boolean {
  return n.kind === 'class' || n.kind === 'struct' || n.kind === 'union' || n.kind === 'interface' ||
    (n.language === 'scala' && n.kind === 'module');
}

/**
 * When a symbol name is ambiguous across files, prefer the candidate(s) declared
 * in the call site's own file, keeping the rest in their original order (#1079).
 * A same-file definition is the strongest language-agnostic signal for which of
 * several same-named symbols a call means; without it, resolution collapses onto
 * whichever was indexed first, so a call in `b/svc` wrongly targets `a/svc`.
 * No-op when there are <2 candidates or none share the call site's file.
 */
export function preferCallSiteFile(nodes: Node[], callSiteFile: string): Node[] {
  if (nodes.length < 2) return nodes;
  const same: Node[] = [];
  const other: Node[] = [];
  for (const n of nodes) {
    if (n.filePath === callSiteFile) same.push(n);
    else other.push(n);
  }
  return same.length ? [...same, ...other] : nodes;
}
