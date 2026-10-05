/**
 * Name Matcher
 *
 * Handles symbol name matching for reference resolution.
 *
 * The implementation lives under ./name-matcher/ — per-language scope and
 * visibility rules in lang/, the matching strategies in strategies/, and the
 * receiver-type inference in receiver-inference.ts. This file is the public
 * entry: it re-exports everything other modules import.
 */

export { CASE_INSENSITIVE_LANGUAGES } from './name-matcher/call-shape';
export { isDartPropertyReadRef, matchDartPropertyRead } from './name-matcher/lang/dart';
export { isPythonSelfCall } from './name-matcher/lang/python';
export { isRustNameInScope, rustFieldTypeName } from './name-matcher/lang/rust';
export { crossesCodeBoundary, gateLanguageMatch, sameLanguageFamily } from './name-matcher/language-family';
export { objectLiteralMemberBinding, resolveObjectLiteralBinding, resolveObjectLiteralMember } from './name-matcher/object-literal';
export { dumpNameMatcherProfile } from './name-matcher/profile';
export { clearNameMatcherMemos, localReceiverTypePatterns, normalizeInferredTypeName } from './name-matcher/receiver-inference';
export { matchCppCallChain, matchDottedCallChain, matchScopedCallChain } from './name-matcher/strategies/chains';
export { matchByExactName } from './name-matcher/strategies/exact';
export { matchByFilePath } from './name-matcher/strategies/file-path';
export { matchFunctionRef } from './name-matcher/strategies/function-ref';
export { matchFuzzy } from './name-matcher/strategies/fuzzy';
export { isUnresolvedJsMemberCall, matchJsStoreBindingCall } from './name-matcher/strategies/js-store';
export { matchMethodCall, resolveMethodOnType } from './name-matcher/strategies/method-call';
export { matchByQualifiedName, preferCallSiteFile } from './name-matcher/strategies/qualified';
export { matchReference } from './name-matcher/strategies/reference';
export { isLexicallyReachable, isVisibleAcrossFiles } from './name-matcher/visibility';
