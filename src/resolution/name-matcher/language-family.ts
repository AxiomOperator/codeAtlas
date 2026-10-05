/**
 * Language families and the cross-language gate applied to every match.
 *
 * Part of the name matcher (see ../name-matcher.ts).
 */

import { Node } from '../../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

/**
 * Language families that share a type system / runtime, so a same-language-only
 * reference may still resolve across them (a Kotlin `Foo.BAR` can name a Java
 * `Foo`). Anything not listed forms its own singleton family.
 */
const LANGUAGE_FAMILY: Record<string, string> = {
  java: 'jvm', kotlin: 'jvm', scala: 'jvm',
  swift: 'native', objc: 'native',
  // ArkTS is a TS superset — every HarmonyOS project mixes `.ets` UI with
  // `.ts` logic modules, so refs must cross freely between them.
  typescript: 'web', tsx: 'web', javascript: 'web', jsx: 'web', arkts: 'web',
  c: 'native', cpp: 'native',
  // Razor/Blazor markup names C# types — same family so `@model Foo` /
  // `<MyComponent/>` resolve to their `.cs` class through the cross-family gate.
  csharp: 'dotnet', razor: 'dotnet', vbnet: 'dotnet',
  svelte: 'web', vue: 'web', astro: 'web',
  cfml: 'cfml', cfscript: 'cfml',
};
export function sameLanguageFamily(a: string, b: string): boolean {
  if (a === b) return true;
  const fa = LANGUAGE_FAMILY[a];
  return fa !== undefined && fa === LANGUAGE_FAMILY[b];
}
/** Config/markup transitions stay open; every other code language has a family. */
const CODE_FAMILY: Record<string, string> = {
  ...LANGUAGE_FAMILY,
  python: 'python', go: 'go', rust: 'rust', php: 'php', ruby: 'ruby', dart: 'dart',
  lua: 'lua', luau: 'lua', r: 'r', erlang: 'erlang', pascal: 'pascal', solidity: 'solidity',
  nix: 'nix', cobol: 'cobol',
};

export function crossesCodeBoundary(a: string, b: string): boolean {
  return CODE_FAMILY[a] !== undefined && CODE_FAMILY[b] !== undefined &&
    CODE_FAMILY[a] !== CODE_FAMILY[b];
}

/**
 * Cross-family name matches need a framework export or an actual ABI boundary,
 * not merely a native caller. ABI evidence is scoped to the named free function.
 */
function hasBridgeEvidence(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.referenceKind !== 'calls') return false;
  // Expo's extractor creates explicit JS exports, resolved by the ordinary
  // name matcher rather than a framework resolve() branch.
  if (CODE_FAMILY[ref.language] === 'web' && candidate.id.startsWith('expo-module:') &&
      candidate.isExported && (candidate.language === 'swift' || candidate.language === 'kotlin')) return true;
  if (candidate.kind !== 'function') return false;
  const name = candidate.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (CODE_FAMILY[ref.language] === 'native') {
    const source = context.readFile(candidate.filePath);
    if (!source) return false;
    if (candidate.language === 'go') {
      const declaration = source.split('\n').slice(Math.max(0, candidate.startLine - 2), candidate.endLine).join('\n');
      return /\bimport\s+(?:\(\s*)?"C"/.test(stripCommentsForRegex(source, 'go')) &&
        new RegExp('^//export ' + name + '\\r?\\nfunc ' + name + '\\s*\\(', 'm').test(declaration);
    }
    if (candidate.language === 'rust') {
      const declaration = source.split('\n').slice(candidate.startLine - 1, candidate.endLine).join('\n');
      return new RegExp('\\bpub\\s+extern\\s+"C"\\s+fn\\s+' + name + '\\b')
        .test(stripCommentsForRegex(declaration, 'rust'));
    }
  }
  if (candidate.language === 'c' || candidate.language === 'cpp') {
    const source = context.readFile(ref.filePath);
    if (!source) return false;
    if (ref.language === 'go') {
      return /\bimport\s+(?:\(\s*)?"C"/.test(stripCommentsForRegex(source, 'go')) &&
        ref.referenceName === 'C.' + candidate.name;
    }
    if (ref.language === 'rust') {
      return new RegExp('extern\\s+"C"\\s*\\{[^}]*\\bfn\\s+' + name + '\\s*\\(')
        .test(stripCommentsForRegex(source, 'rust'));
    }
  }
  return false;
}

/**
 * Per-context memo: node id → its language, for gateLanguageMatch. Matches
 * land on ~5 refs per target on vscode, and each check otherwise fetched the
 * whole node (a point read + row decode past the query layer's small cache)
 * only to read one field. Nodes are fixed within a resolution pass; the memo
 * drops with clearNameMatcherMemos.
 */
export const TARGET_LANGUAGE = new WeakMap<ResolutionContext, Map<string, string>>();

/** Reject the chosen result without shrinking a pool or trying a replacement. */
export function gateLanguageMatch(
  result: ResolvedRef | null,
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (!result) return result;
  // No code family on the reference's side: no target can cross a boundary.
  if (CODE_FAMILY[ref.language] === undefined) return result;
  if (context.getNodeById) {
    let languages = TARGET_LANGUAGE.get(context);
    if (!languages) {
      languages = new Map();
      TARGET_LANGUAGE.set(context, languages);
    }
    let language = languages.get(result.targetNodeId);
    if (language === undefined) {
      const node = context.getNodeById(result.targetNodeId);
      if (node) {
        language = node.language as string;
        if (languages.size >= 400_000) languages.clear();
        languages.set(result.targetNodeId, language);
      }
    }
    if (language !== undefined) {
      if (!crossesCodeBoundary(ref.language, language)) return result;
      const target = context.getNodeById(result.targetNodeId);
      return target && !hasBridgeEvidence(target, ref, context) ? null : result;
    }
  }
  const target = context.getNodeById?.(result.targetNodeId) ??
    context.getNodesByName(ref.referenceName).find((n) => n.id === result.targetNodeId);
  if (target && crossesCodeBoundary(ref.language, target.language) &&
      !hasBridgeEvidence(target, ref, context)) return null;
  return result;
}
