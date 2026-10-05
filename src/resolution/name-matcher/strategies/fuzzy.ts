/**
 * Fuzzy strategy and the scoring helpers shared by the name-based strategies (path proximity, receiver-word overlap, the ambiguous-name ceiling).
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from '../../types';
import { sameVbProject } from '../../vbnet-receivers';
import { CASE_INSENSITIVE_LANGUAGES, JS_FAMILY, isBareGoCall, isBareJsCall, isBarePhpCall, isBareRCall } from '../call-shape';
import { candidateScope } from '../candidate-scope';
import { isLocallyBoundJsName } from '../lang/javascript';
import { sameLanguageFamily } from '../language-family';
import { isOutOfRepoBinding } from './method-call';
import { TYPE_MEMBER_KINDS, isCrossFileReachable, isLexicallyReachable, isVisibleAcrossFiles } from '../visibility';

/**
 * Ceiling on how many same-named definitions a FUZZY name-match strategy will
 * score. A name defined more times than this is "ubiquitous" — a method/symbol
 * re-declared across a vendored theme or SDK (e.g. `init`/`update`/`render` on
 * every widget of a committed Metronic theme — #999). No directory-proximity or
 * receiver-word-overlap score can reliably pick THE one true target among
 * thousands, so the fuzzy strategies (matchByExactName's findBestMatch, and
 * matchMethodCall Strategy 3) decline above the ceiling instead of emitting a
 * low-confidence, almost-certainly-wrong edge. This also caps their per-ref cost
 * at O(ceiling): without it, K same-named refs each scored K candidates — the
 * O(K²) blow-up that pinned a core for 15-28 min at "Resolving refs … 94%" on a
 * repo vendoring a large JS/TS theme (#999). The PRECISE strategies are
 * unaffected: qualified-name, import-based, and class-name (Strategy 1/2)
 * resolution all still run and resolve a ubiquitous name when the context names
 * its exact target. Real repos top out near ~40 same-named methods, so a normal
 * codebase never reaches this; only bulk-vendored code does. Tune via
 * `CODEGRAPH_AMBIGUOUS_NAME_CEILING`.
 */
const DEFAULT_AMBIGUOUS_NAME_CEILING = 500;
function resolveAmbiguousNameCeiling(): number {
  const raw = process.env.CODEGRAPH_AMBIGUOUS_NAME_CEILING;
  if (!raw) return DEFAULT_AMBIGUOUS_NAME_CEILING;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AMBIGUOUS_NAME_CEILING;
}
export const AMBIGUOUS_NAME_CEILING = resolveAmbiguousNameCeiling();

/**
 * Whether a receiver is named after the owner of `method`, case aside: the
 * receiver's last segment is the owner's name (`cbsecurity` → CBSecurity), or
 * they share a word of three letters or more (`web_push_request` →
 * WebPushRequest, `executor1` → Executor, `decodedImage` → UIImage).
 */
export function sharesReceiverWord(receiver: string, method: Node): boolean {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut < 0) return false;
  const ownerQn = method.qualifiedName.slice(0, cut);
  const flat = (w: string) => w.replace(/[^A-Za-z0-9]/g, '').replace(/\d+$/, '').toLowerCase();
  if (flat(receiver.split('.').pop()!) === flat(ownerQn.split(/::|\./).pop()!)) return true;
  // Two-letter words are class prefixes (`SD`, `NS`, `UI`), not names.
  const owner = new Set(splitCamelCase(ownerQn).map(flat).filter((w) => w.length > 2));
  return splitCamelCase(receiver).some((w) => owner.has(flat(w)));
}

export function splitCamelCase(str: string): string[] {
  return str.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s._:\/\\]+/)
    .filter(w => w.length > 1);
}

/**
 * Compute directory proximity from a pre-split list of directory segments
 * (`filePath1` minus its filename) and a second file path.
 * Returns a score based on the number of shared leading directory segments.
 * Higher score = closer in directory tree.
 *
 * Split into a pre-split variant because findBestMatch scores every candidate
 * against the SAME `ref.filePath`; re-splitting it per candidate was a hot spot
 * on large repos (#915), so the caller splits it once and passes the segments.
 */
function pathProximityFromDirs(dir1: string[], filePath2: string): number {
  const dir2 = filePath2.split('/');
  dir2.pop(); // drop filename — matches the original slice(0, -1) on both paths

  let shared = 0;
  const limit = Math.min(dir1.length, dir2.length);
  for (let i = 0; i < limit; i++) {
    if (dir1[i] === dir2[i]) {
      shared++;
    } else {
      break;
    }
  }

  // Each shared directory segment contributes 15 points, capped at 80
  return Math.min(shared * 15, 80);
}

/**
 * Compute directory proximity between two file paths.
 * Returns a score based on the number of shared directory segments.
 */
export function computePathProximity(filePath1: string, filePath2: string): number {
  const dir1 = filePath1.split('/');
  dir1.pop();
  return pathProximityFromDirs(dir1, filePath2);
}

/**
 * Find the best matching node when there are multiple candidates
 */
export function findBestMatch(
  ref: UnresolvedRef,
  candidates: Node[],
  context: ResolutionContext
): Node | null {
  // Prioritization rules:
  // 1. Same file > different file
  // 2. Directory proximity (same module/package > different module)
  // 3. Same language > different language
  // 4. Functions/methods > classes/types (for call references)
  // 5. Exported > non-exported

  let bestScore = -1;
  let bestNode: Node | null = null;

  // Split the ref's path once (it's the same across every candidate) instead of
  // re-splitting it inside computePathProximity per candidate (#915 hot spot).
  const refDirs = ref.filePath.split('/');
  refDirs.pop();

  // A same-language candidate ALWAYS outscores a cross-language one: same-language
  // scores at least +50 (language bonus), while a cross-language candidate maxes
  // out at +35 (−80 language, +80 proximity, +25 kind, +10 exported; it can never
  // be in the same file). So when any same-language candidate exists, skip the
  // cross-language ones — provably the same winner, without paying the per-candidate
  // scoring. Cuts the candidate set to same-language size on mixed front-end +
  // back-end repos (#915). When ALL candidates are cross-language (a legitimate
  // cross-language `calls` bridge), none are skipped and behavior is unchanged.
  const hasSameLanguage = candidates.some((c) => c.language === ref.language);

  for (const candidate of candidates) {
    if (hasSameLanguage && candidate.language !== ref.language) continue;

    let score = 0;

    // Same file bonus
    if (candidate.filePath === ref.filePath) {
      score += 100;
    }

    // Directory proximity bonus — strongly prefer same module/package
    score += pathProximityFromDirs(refDirs, candidate.filePath);

    // A VB.NET project compiles its own files: the caller's project weighs as
    // much as the nearest a directory can be. staxrip's `New ColorHSL(…)` went
    // to its AutoCrop tool's copy.
    if (ref.language === 'vbnet' && candidate.language === 'vbnet' && sameVbProject(candidate.filePath, ref.filePath, context)) {
      score += 80;
    }

    // Language matching: strongly prefer same language, penalize cross-language
    if (candidate.language === ref.language) {
      score += 50;
    } else {
      score -= 80;
    }

    // For call references, prefer functions/methods
    if (ref.referenceKind === 'calls') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      }
    }

    // For instantiation references (`new Foo()`), prefer class-like
    // targets — without this, a function named `Foo` in another module
    // could outscore the actual class.
    if (ref.referenceKind === 'instantiates') {
      if (
        candidate.kind === 'class' ||
        candidate.kind === 'struct' ||
        candidate.kind === 'union' ||
        candidate.kind === 'interface'
      ) {
        score += 25;
      }
    }

    // For decorator references (`@Foo`), prefer functions. Class
    // decorators (Python `@SomeClass`, Java annotation interfaces)
    // also resolve here, hence the smaller class bonus.
    if (ref.referenceKind === 'decorates') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      } else if (candidate.kind === 'class' || candidate.kind === 'interface') {
        score += 15;
      }
    }

    // Exported bonus
    if (candidate.isExported) {
      score += 10;
    }

    // Closer line number (within same file)
    if (candidate.filePath === ref.filePath && candidate.startLine) {
      const distance = Math.abs(candidate.startLine - ref.line);
      score += Math.max(0, 20 - distance / 10);
    }

    if (score > bestScore) {
      bestScore = score;
      bestNode = candidate;
    }
  }

  return bestNode;
}

/**
 * Fuzzy match - last resort with lower confidence
 */
export function matchFuzzy(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const lowerName = ref.referenceName.toLowerCase();

  // Use pre-built lowercase index for O(1) lookup instead of scanning all nodes
  const candidates = context.getNodesByLowerName(lowerName);

  // Filter to callable kinds only (function, method, class)
  const callableKinds = new Set(['function', 'method', 'class']);
  // Names are case-sensitive in every language but a handful: Rust's
  // `Bytes` is not the method `bytes`, Python's builtin `dir(…)` not a class
  // `Dir`, halo's `type RsbuildConfig` not its local `rsbuildConfig`, a Java
  // `Node` not a `node()`. Only PHP, Pascal/Delphi, CFML, COBOL and VB.NET
  // resolve a name without regard to case, which is what this fallback's
  // lowercase index is for.
  const bareR = isBareRCall(ref, context);
  const scope = candidateScope(ref, context);
  const callableCandidates = candidates.filter((n) => callableKinds.has(n.kind) &&
    !(bareR && n.kind === 'method') &&
    // `new …MockData()` makes an instance of a type; a method is never what it names.
    !(ref.referenceKind === 'instantiates' && n.kind === 'method') &&
    !(!CASE_INSENSITIVE_LANGUAGES.has(ref.language) && n.name !== ref.referenceName) &&
    scope.inScope(n))
    .filter((n) => (ref.referenceKind !== 'references' && ref.referenceKind !== 'function_ref') ||
      sameLanguageFamily(n.language, ref.language));

  // Prefer same-language matches
  const sameLanguageCandidates = callableCandidates.filter(n => n.language === ref.language);
  const finalCandidates = sameLanguageCandidates.length > 0 ? sameLanguageCandidates : callableCandidates;

  // Both post-pipeline visibility guards (#1745 language-local + #1719 sealed
  // module). The sealed-module test rejects the survivor and never filters the
  // set that produced it: removing a sealed candidate from a crowd would leave
  // a lone one and manufacture a 0.5 guess out of an ambiguity fuzzy declines.
  // Also decline a bare JS/TS call whose only survivor is a method or a
  // cross-file name the file already binds locally (#1714).
  // A function nested inside another function is only callable from inside
  // its container (#1230), so a builtin method call (`res.text()`) whose only
  // same-named project symbol is some file's closure must decline (#1708).
  // The check sits on the ONE candidate this strategy would commit to, not on
  // the candidate set: filtering the unreachable ones out of a crowd would
  // leave a single survivor and hand it every call of that name — on vite,
  // `import { resolve } from 'node:path'` in a dozen playground configs onto
  // the one reachable `resolve` method (#1709). Reachability may reject a
  // unique guess; it must never manufacture one.
  if (
    finalCandidates.length === 1 &&
    isVisibleAcrossFiles(finalCandidates[0]!, ref, context) &&
    isCrossFileReachable(finalCandidates[0]!, ref, context) &&
    !(isBareJsCall(ref, context) &&
      (TYPE_MEMBER_KINDS.has(finalCandidates[0]!.kind) ||
        (finalCandidates[0]!.filePath !== ref.filePath && isLocallyBoundJsName(ref.referenceName, ref.filePath, context)))) &&
    !(JS_FAMILY.has(ref.language) && isOutOfRepoBinding(ref.referenceName, ref, context)) &&
    !(finalCandidates[0]!.kind === 'method' && isBareGoCall(ref, context)) &&
    // A bare PHP call is a function call (case-insensitive, so fuzzy may find
    // one) — never the class `View` for `view(…)`, never a method.
    !(finalCandidates[0]!.kind !== 'function' && isBarePhpCall(ref, context)) &&
    isLexicallyReachable(finalCandidates[0]!, ref, context)
  ) {
    const isCrossLanguage = finalCandidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: finalCandidates[0]!.id,
      confidence: isCrossLanguage ? 0.3 : 0.5,
      resolvedBy: 'fuzzy',
    };
  }

  return null;
}
