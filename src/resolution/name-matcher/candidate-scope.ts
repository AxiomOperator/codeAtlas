/**
 * candidateScope: the per-language scope predicate every name-based strategy applies to a same-named candidate.
 *
 * Part of the name matcher (see ../name-matcher.ts).
 */

import { Node } from '../../types';
import { UnresolvedRef, ResolutionContext } from '../types';
import { isVbMemberInScope, isVbNestedTypeInScope, isVbTypeQualifiedBy } from '../vbnet-receivers';
import { JS_FAMILY, canNameInTypePosition, isDotNetTypeRef } from './call-shape';
import { isCfmlMethodInScope } from './lang/cfml';
import { isCsharpMemberInScope } from './lang/csharp';
import { isDartMember, isDartMethodInScope, isReceiverLessDartCall } from './lang/dart';
import { isJavaMethodInScope } from './lang/java';
import { isKotlinMemberReachable, isKotlinNumberBitwise, isKotlinStdChainTarget, isKotlinTopLevelVisible, isReceiverLessKotlinCall, kotlinChainReceiver } from './lang/kotlin';
import { OBJC_MEMBER_KINDS, isObjcSelfSendTarget, objcCallShape } from './lang/objc';
import { isPhpMethodInScope, phpSelfReceiver } from './lang/php';
import { fitsPythonCallShape, pythonCallShape } from './lang/python';
import { isRubyMethodInScope } from './lang/ruby';
import { isRustGoCallTarget, isRustNameInScope, rustGoCallShape } from './lang/rust';
import { isScalaMemberInScope } from './lang/scala';
import { isReceiverLessSolidityCall, isSolidityMemberInScope } from './lang/solidity';
import { SwiftCallShape, isSwiftCallTarget, swiftCallShape } from './lang/swift';
import { isVbMemberReachable, isVbScopedCall, isVbUnqualifiedName, vbReceiverOf } from './lang/vb';
import { KOTLIN_STD_METHODS } from './std-methods';
import { isThisCallInOwnFile, isVueComponentMethod } from './strategies/method-call';

/**
 * The per-language scope rules a same-named candidate must pass to be what
 * `ref` names, for every name-based strategy: exact and fuzzy matching both
 * apply this one predicate, so a rule added for one reaches the other.
 * The reference's shapes are computed once; `inScope` judges a candidate.
 */
export function candidateScope(ref: UnresolvedRef, context: ResolutionContext): {
  inScope: (n: Node) => boolean; dartBare: boolean; swiftShape: SwiftCallShape | null; kotlinBare: boolean;
} {
  const typeRef = isDotNetTypeRef(ref, context);
  const rustBare = ref.language === 'rust' && /^[A-Za-z_]\w*$/.test(ref.referenceName);
  const pythonShape = pythonCallShape(ref, context);
  const javaBare = ref.language === 'java' && ref.referenceKind === 'calls' && /^[A-Za-z_$][\w$]*$/.test(ref.referenceName);
  const dartBare = ref.language === 'dart' && ref.referenceKind === 'calls' && /^[A-Za-z_$][\w$]*$/.test(ref.referenceName) && isReceiverLessDartCall(ref, context);
  const kotlinCall = ref.language === 'kotlin' && ref.referenceKind === 'calls' && /^[A-Za-z_$][\w$]*$/.test(ref.referenceName);
  const kotlinBare = kotlinCall && isReceiverLessKotlinCall(ref, context);
  const rubyBare = ref.language === 'ruby' && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*[?!]?$/.test(ref.referenceName);
  const cfmlBare = (ref.language === 'cfml' || ref.language === 'cfscript') && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName);
  const vbReceiver = ref.language === 'vbnet' && (ref.referenceKind === 'calls' || ref.referenceKind === 'instantiates') && /^\w+$/.test(ref.referenceName)
    ? vbReceiverOf(ref, context) : null;
  const vbScoped = isVbScopedCall(ref, vbReceiver, context);
  const vbUnqualified = isVbUnqualifiedName(ref, vbReceiver, context);
  const objcShape = ref.language === 'objc' && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*:*(?:\w+:)*$/.test(ref.referenceName)
    ? objcCallShape(ref, context) : null;
  const csharpBare = ref.language === 'csharp' && (ref.referenceKind === 'calls' || ref.referenceKind === 'references') && /^[A-Za-z_]\w*$/.test(ref.referenceName);
  const scalaBare = ref.language === 'scala' && ref.referenceKind === 'calls' && /^[A-Za-z_$][\w$]*$/.test(ref.referenceName);
  const rustGoShape = (ref.language === 'rust' || ref.language === 'go') && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName)
    ? rustGoCallShape(ref, context) : null;
  const kotlinStdChain = ref.language === 'kotlin' && ref.referenceKind === 'calls' && KOTLIN_STD_METHODS.has(ref.referenceName)
    ? kotlinChainReceiver(ref, context) : null;
  const swiftShape = ref.language === 'swift' && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName)
    ? swiftCallShape(ref, context) : null;
  const phpSelf = phpSelfReceiver(ref, context);
  const solidityBare = isReceiverLessSolidityCall(ref, context);
  const luaBareCall = (ref.language === 'lua' || ref.language === 'luau') && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName);
  const inScope = (n: Node): boolean =>
    !(kotlinStdChain !== null && !isKotlinStdChainTarget(n, kotlinStdChain)) &&
    !(swiftShape && !isSwiftCallTarget(n, swiftShape, ref, context)) &&
    !(rustGoShape && !isRustGoCallTarget(n, rustGoShape)) &&
    !(scalaBare && !isScalaMemberInScope(n, ref, context)) &&
    !(csharpBare && !isCsharpMemberInScope(n, ref, context)) &&
    !(objcShape === 'c-call' && OBJC_MEMBER_KINDS.has(n.kind)) &&
    !(objcShape === 'self-send' && !isObjcSelfSendTarget(n, ref, context)) &&
    !(objcShape === 'super-send' && !isObjcSelfSendTarget(n, ref, context, true)) &&
    !(vbReceiver !== null && !isVbMemberReachable(n, vbReceiver)) &&
    !(vbReceiver && !/^(?:me|mybase|myclass)$/i.test(vbReceiver) && !isVbTypeQualifiedBy(n, vbReceiver, ref.filePath, context)) &&
    !(vbScoped && !isVbMemberInScope(n, ref, context)) &&
    !(vbUnqualified && !isVbNestedTypeInScope(n, ref, context)) &&
    !(rubyBare && n.kind === 'method' && !isRubyMethodInScope(n, ref, context)) &&
    !(cfmlBare && n.kind === 'method' && !isCfmlMethodInScope(n, ref, context)) &&
    !(javaBare && n.kind === 'method' && !isJavaMethodInScope(n, ref, context)) &&
    !(kotlinCall && !isKotlinTopLevelVisible(n, ref, context)) &&
    !(kotlinBare && !isKotlinMemberReachable(n, ref, context)) &&
    !isKotlinNumberBitwise(n, ref) &&
    !(solidityBare && !isSolidityMemberInScope(n, ref, context)) &&
    !(dartBare && isDartMember(n) && !isDartMethodInScope(n, ref, context)) &&
    !(phpSelf && (n.kind !== 'method' || !isPhpMethodInScope(n, ref, phpSelf, context))) &&
    !(pythonShape && !fitsPythonCallShape(n, pythonShape, ref, context)) &&
    !(rustBare && !isRustNameInScope(n, ref, context)) &&
    !(typeRef && !canNameInTypePosition(n)) &&
    // A Scala type position (`Arbitrary[B]`) never names a method: an
    // `implicit def A: Order[A]` shares its name with half of cats' type
    // parameters. Scala's value references only read a file's own vals.
    // Nor does a kind-projector placeholder (`F[*]`, `G[?]`): cats' 567 `*`
    // type arguments went to an algebra `Sign`'s `*` method.
    !(ref.language === 'scala' && ref.referenceKind === 'references' && /^(?:[A-Z]|[^\w\s]+$)/.test(ref.referenceName) &&
      (n.kind === 'method' || n.kind === 'function')) &&
    // A table's method (`function M.x`, `function M:x`) is no bare Lua call's, without its table.
    !(luaBareCall && n.kind === 'method') &&
    // A Vue component's own method is `this.m()` inside that component — not
    // `this.$refs['input'].click()` on an element another component renders.
    !(ref.referenceKind === 'calls' && JS_FAMILY.has(ref.language) && isVueComponentMethod(n) && !isThisCallInOwnFile(n, ref, context));
  return { inScope, dartBare, swiftShape, kotlinBare };
}
