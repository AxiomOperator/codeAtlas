/**
 * Exact-name strategy (matchByExactName).
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { UnresolvedRef, ResolvedRef, ResolutionContext, isSupertypeTarget, CPP_DEFINE_SIGNATURE, isInheritanceRef, isImportableKind } from '../../types';
import { JS_FAMILY, isBareGoCall, isBareJsCall, isBarePhpCall, isBareRCall } from '../call-shape';
import { candidateScope } from '../candidate-scope';
import { CSHARP_TYPE_KINDS, isCsharpNestedTypeInScope, isCsharpTypeVisible } from '../lang/csharp';
import { dartExtensionDecl, nearestDartMembers } from '../lang/dart';
import { isJavaTypeVisible } from '../lang/java';
import { isLocallyBoundJsName } from '../lang/javascript';
import { lexicalKotlinMembers } from '../lang/kotlin';
import { isPhpClassVisible } from '../lang/php';
import { isScalaPackageObjectMemberVisible } from '../lang/scala';
import { nearestSwiftMembers } from '../lang/swift';
import { sameLanguageFamily } from '../language-family';
import { AMBIGUOUS_NAME_CEILING, computePathProximity, findBestMatch } from './fuzzy';
import { matchDestructuredCallResult, matchJsStoreBindingCall } from './js-store';
import { isOutOfRepoBinding } from './method-call';
import { ESM_FAMILY, TYPE_MEMBER_KINDS, isCrossFileReachable, isLexicallyReachable, isSealedModule } from '../visibility';

/**
 * Try to resolve a reference by exact name match
 */
export function matchByExactName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // `import`-kind nodes are import STATEMENTS, not definitions, so a reference
  // resolving to a sibling file's `import` is a meaningless edge — the real
  // import→definition resolution is the import resolver's job (resolveViaImport),
  // never name-matching here. Excluding them also removes a quadratic blow-up:
  // a ubiquitous package (`react`, `@superset-ui/core`, Python `logging`/`typing`)
  // is re-declared as an `import` node in every file that imports it, so K
  // unresolved import refs each scored K same-named import candidates through
  // findBestMatch — O(K²) per package, the dominant cost of "Resolving refs" on
  // large import-heavy (front-end + back-end) repos (#915).
  const bareJs = isBareJsCall(ref, context);
  const bareNoMembers = isBareGoCall(ref, context) || isBareRCall(ref, context);
  const barePhp = isBarePhpCall(ref, context);
  // A type, a value or an import the file binds from a package outside the
  // repository names nothing in it, whatever kind of reference it is.
  if (!bareJs && JS_FAMILY.has(ref.language) && ref.referenceKind !== 'calls' &&
      /^[A-Za-z_$][\w$]*$/.test(ref.referenceName) && isOutOfRepoBinding(ref.referenceName, ref, context)) {
    return null;
  }
  if (bareJs) {
    const storeAction = matchJsStoreBindingCall(ref, context);
    if (storeAction) return storeAction;
    const returned = matchDestructuredCallResult(ref, context);
    if (returned) return returned;
    // `import { useQuery } from '@tanstack/react-query'`: the call means the
    // package's, and no same-named project symbol.
    if (isOutOfRepoBinding(ref.referenceName, ref, context)) return null;
  }
  // Every rule below judges one candidate on its own, so they run as ONE pass,
  // the kind/language checks before the ones that read source: a common name
  // has thousands of same-named nodes, and a chain of filters copied that
  // list once per rule for every reference.
  const valueRef = ref.referenceKind === 'references' || ref.referenceKind === 'function_ref';
  const importRef = ref.referenceKind === 'imports';
  const inheritanceRef = isInheritanceRef(ref);
  const sameName = context.getNodesByName(ref.referenceName);
  // `NAME(...)` where NAME is a function-like macro somewhere in the project is
  // an expansion or a call to a same-named function — never the macro itself
  // (#1839), and never a type that happens to share the name (#2070: expat's
  // `PREFIX(scanRef)(…)` bound to an unrelated `struct PREFIX`). Keep
  // upstream's language gate on the chosen result.
  const cMacroCall = ref.referenceKind === 'calls' && (ref.language === 'c' || ref.language === 'cpp') &&
    sameName.some((n) => n.kind === 'constant' && CPP_DEFINE_SIGNATURE.test(n.signature ?? ''));
  const scope = candidateScope(ref, context);
  const { dartBare, swiftShape, kotlinBare } = scope;
  const filtered = sameName.filter((n) =>
    scope.inScope(n) &&
    !(cMacroCall && n.kind !== 'function' && n.kind !== 'method') &&
    // Type/value references retain same-family eligibility: a native namesake
    // must not hide the actual web type. Calls still gate only the winner.
    (!valueRef || sameLanguageFamily(n.language, ref.language)) &&
    n.kind !== 'import' &&
    // A receiver-less JS/TS or Go call cannot reach a member of a type — a
    // method (#1714, #1857), nor a property, field or case: mocha's global
    // `it(…)` bound to an interface's `it` property, `describe(…)` to a
    // command class's `describe` string.
    !((bareJs || bareNoMembers) && TYPE_MEMBER_KINDS.has(n.kind)) &&
    // A bare PHP call is a function call: nothing else is callable without a receiver.
    !(barePhp && n.kind !== 'function') &&
    // An `extends`/`implements` ref names a supertype, so anything that can't
    // BE one is not a candidate at all. This is eligibility, not
    // ranking: kind is only a scoring bonus below (and none is awarded for
    // inheritance refs), so without this a same-named `enum_member` outranked
    // the real `trait`, and as the sole candidate was adopted outright by the
    // single-match shortcut. Restricting the pool BEFORE ranking lets the
    // legitimate supertype win instead of merely dropping the false edge.
    (!inheritanceRef || isSupertypeTarget(n)) &&
    // Likewise for `imports`: a member that only exists inside a type is not
    // importable, so it is not a candidate. Without this a `path`/`id`/`url`
    // import resolved to some interface's same-named property.
    (!importRef || isImportableKind(n.kind)) &&
    // Nested locals are only reachable from inside their container (#1230).
    isLexicallyReachable(n, ref, context) &&
    // A C# type name is a type its namespaces can see — ahead of the ranking,
    // so a visible namesake wins where the veto after it would drop the
    // ref: eShop's `WebhookType.OrderPaid` under `using Webhooks.API.Model;`.
    // A bare PHP class name, only its namespace's or the imported one — ahead of
    // the ranking, so koel's `extends Request` under `use App\Http\Requests\API\Request;`
    // is that class, not the first `Request` indexed.
    isPhpClassVisible(n, ref, context) &&
    // Likewise a bare Java type name: retrofit's tests' `new Builder()` is not
    // a wire converter test's nested `CrashingPhone.Builder`.
    isJavaTypeVisible(n, ref, context) &&
    dartExtensionDecl(n, context)?.named !== false &&
    // A Scala package object's member, only where it is in scope — ahead of
    // the ranking, so cats.laws' `Eq` can be the `cats` package object's.
    !(ref.language === 'scala' && n.language === 'scala' && n.filePath !== ref.filePath &&
      !isScalaPackageObjectMemberVisible(n, ref, context)) &&
    // A nested type, only from inside its owner: AutoMapper's same-file `new
    // Source()` in one test class is not the previous test class's `Source`.
    !(ref.language === 'csharp' && n.language === 'csharp' && CSHARP_TYPE_KINDS.has(n.kind) && /^[A-Za-z_]\w*$/.test(ref.referenceName) &&
      (!isCsharpNestedTypeInScope(n, ref, context) || (n.filePath !== ref.filePath && !isCsharpTypeVisible(n, ref, context)))) &&
    // Preserve import ranking; calls reject the winner without promoting another.
    (!importRef || n.filePath === ref.filePath ||
      !ESM_FAMILY.has(n.language) || !isSealedModule(n.filePath, context)) &&
    // A name the file binds itself (a parameter, a const) shadows every other
    // file's symbol of that name, so a bare call has no cross-file candidate.
    !(bareJs && n.filePath !== ref.filePath && isLocallyBoundJsName(ref.referenceName, ref.filePath, context))
  );
  const candidates = dartBare ? nearestDartMembers(filtered, ref, context)
    : swiftShape && swiftShape.shape !== 'chained' ? nearestSwiftMembers(filtered, ref, context)
    : kotlinBare ? lexicalKotlinMembers(filtered, ref, context) : filtered;

  if (candidates.length === 0) {
    return null;
  }

  // If only one match, use it — but penalize cross-language matches
  if (candidates.length === 1) {
    if (!isCrossFileReachable(candidates[0]!, ref, context)) return null;
    const isCrossLanguage = candidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: isCrossLanguage ? 0.5 : 0.9,
      resolvedBy: 'exact-match',
    };
  }

  // Ubiquitous-name ceiling (#999): above it, picking one target among K
  // same-named defs by directory proximity is unreliable AND O(K) per ref — the
  // quadratic behind the "Resolving refs" wedge on theme/SDK-vendoring repos.
  // Decline; the precise strategies (qualified-name, import, class-name) already
  // ran. Falls through to fuzzy, which itself only resolves a UNIQUE candidate.
  if (candidates.length > AMBIGUOUS_NAME_CEILING) {
    return null;
  }

  // Multiple matches - try to narrow down
  const bestMatch = findBestMatch(ref, candidates, context);
  if (bestMatch && isCrossFileReachable(bestMatch, ref, context)) {
    // Lower confidence when the match is from a distant/unrelated module
    const proximity = computePathProximity(ref.filePath, bestMatch.filePath);
    const confidence = proximity >= 30 ? 0.7 : 0.4;
    return {
      original: ref,
      targetNodeId: bestMatch.id,
      confidence,
      resolvedBy: 'exact-match',
    };
  }

  return null;
}
