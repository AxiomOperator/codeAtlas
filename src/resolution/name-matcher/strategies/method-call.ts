/**
 * Method-call strategy (matchMethodCall) and method lookup on an inferred type (resolveMethodOnType).
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import * as path from 'path';
import { Node } from '../../../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from '../../types';
import { JS_BUILT_INS, JS_BUILTIN_METHODS, TS_PRIMITIVE_TYPES } from '../../js-builtins';
import { breakVbTie, matchVbTypedCall, preferVbProject } from '../../vbnet-receivers';
import { isTestPath } from '../../../search/query-utils';
import { JS_FAMILY } from '../call-shape';
import { inferCppReceiverType } from '../lang/c-cpp';
import { csharpUsingAlias, isCsharpTypeVisible } from '../lang/csharp';
import { isDartMember, isDartUnnamedExtensionMember, nearestDartMemberOfType } from '../lang/dart';
import { matchGoFieldChainCall } from '../lang/go';
import { importedFqnOf, inferJavaFieldReceiverType } from '../lang/java';
import { isKotlinNumberBitwise } from '../lang/kotlin';
import { isLuaLibraryCall } from '../lang/lua';
import { objcReceiverReaches } from '../lang/objc';
import { phpReceiverReaches } from '../lang/php';
import { pythonFixtureReturnType } from '../lang/python';
import { matchRustSelfCall, matchRustSelfFieldCall } from '../lang/rust';
import { matchTsThisFieldCall } from '../lang/typescript';
import { sameLanguageFamily } from '../language-family';
import { OBJECT_LITERAL_LANGUAGES, resolveGlobalNamespaceMember, resolveObjectLiteralBinding, resolveObjectLiteralMember } from '../object-literal';
import { nmTimedT } from '../profile';
import { MEMBER_TYPED_LANGUAGES, inferEsmAwaitedCallType, inferLocalReceiverType, inferMemberReceiverType, inheritedClassMethod, typeParameterBound } from '../receiver-inference';
import { DISPATCHED_ACTIONS, DISPATCHED_OWNER, TEST_DOUBLE_OWNER, isStdMethodName, isUnnamedTestDouble, receiverLink, receiverNamesOwner } from '../std-methods';
import { AMBIGUOUS_NAME_CEILING, sharesReceiverWord, splitCamelCase } from './fuzzy';
import { namesExternalType } from './js-store';
import { isMethodOwnerKind, preferCallSiteFile } from './qualified';
import { ESM_FAMILY } from '../visibility';

// Exported for the precedence unit tests (#1079): they assert the
// preferredFqn → same-file → matches[0] ordering directly.
export function resolveMethodOnType(
  typeName: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  confidence: number,
  resolvedBy: ResolvedRef['resolvedBy'],
  /**
   * Optional FQN that identifies WHICH class declaration `typeName`
   * refers to in the caller's file. When multiple candidates share
   * the same qualifiedName (`FooConverter::convert` in both
   * `dao/converter/` and `service/converter/`), the FQN's
   * file-path-suffix picks the right one — the disambiguation
   * signal Java imports carry but the call site doesn't (#314).
   */
  preferredFqn?: string,
  /** Recursion guard for the supertype/conformance walk. */
  depth = 0,
): ResolvedRef | null {
  // Look up methods by name and match by qualifiedName ending in
  // `<typeName>::<methodName>`. This works whether the method is defined
  // in-class (`class Foo { int bar() { ... } }`) or out-of-line in a separate
  // file (`int Foo::bar() { ... }` in foo.cpp while class Foo is in foo.hpp).
  // The previous same-file approach missed the latter — the typical C++ layout.
  // Prefer the context's per-(type, method) memo: the raw name lookup fetches
  // EVERY node sharing the method name — tens of thousands of rows for a
  // collision-heavy Java name like `execute` — and re-filtering that per ref
  // was a dominant term in the #1122 watchdog kill on large repos. Only the
  // ref-independent filter is memoized; per-ref disambiguation stays below.
  let matches: Node[];
  if (context.getMethodMatches) {
    matches = context.getMethodMatches(typeName, methodName, ref.language);
  } else {
    const methodCandidates = context.getNodesByName(methodName);
    const want = `${typeName}::${methodName}`;
    matches = [];
    for (const m of methodCandidates) {
      if (m.kind !== 'method') continue;
      if (!sameLanguageFamily(m.language, ref.language)) continue;
      const qn = m.qualifiedName;
      if (qn === want || qn.endsWith(`::${want}`)) {
        matches.push(m);
      }
    }
  }
  if (matches.length === 0) {
    // Conformance fallback: the method may be defined on a supertype `typeName`
    // extends, or on a protocol / trait it conforms to (e.g. a Swift protocol-
    // extension method, a C# default-interface or extension method, a Kotlin
    // extension on a supertype). Walk supertypes transitively (depth-capped) via
    // the resolved implements/extends edges — empty in the first resolution pass,
    // populated in the conformance pass. Still VALIDATED (the method must exist on
    // a supertype), so a wrong inference produces no edge.
    if (depth < 4 && context.getSupertypes) {
      const viaSupers = nmTimedT('rmot-supers', ref, (): ResolvedRef | null => {
        for (const supertype of context.getSupertypes!(typeName, ref.language)) {
          const via = resolveMethodOnType(
            supertype, methodName, ref, context, confidence, resolvedBy, preferredFqn, depth + 1,
          );
          if (via) return via;
        }
        return null;
      });
      if (viaSupers) return viaSupers;
    }
    return null;
  }

  if (matches.length > 1 && preferredFqn) {
    const ext = ref.language === 'kotlin' ? '.kt' : '.java';
    const fqnPath = preferredFqn.replace(/\./g, '/') + ext;
    const chosen = matches.find((m) => {
      const fp = m.filePath.replace(/\\/g, '/');
      return fp.endsWith(fqnPath) || fp.endsWith('/' + fqnPath);
    });
    if (chosen) {
      return {
        original: ref,
        targetNodeId: chosen.id,
        confidence,
        resolvedBy,
      };
    }
  }

  // Language-agnostic disambiguation: when several same-named methods survive
  // (e.g. two files each declaring `class Logger { void log(); }` — an ODR
  // clash, an anonymous-namespace type, or separate translation units), prefer
  // the definition in the CALL SITE's own file. Without this, every ambiguous
  // call collapses onto the first-indexed definition, so a call in `b/svc.cpp`
  // wrongly points at `a/svc.cpp` (#1079). This runs AFTER the `preferredFqn`
  // block, so Java/Kotlin import disambiguation — whose target is intentionally
  // in ANOTHER file (#314) — is unaffected: that block returns early whenever
  // an import FQN pins the class.
  if (ref.referenceKind === 'function_ref' && matches.length !== 1) return null;
  const ordered = preferCallSiteFile(matches, ref.filePath);
  return {
    original: ref,
    targetNodeId: ordered[0]!.id,
    confidence,
    resolvedBy,
  };
}

/**
 * Try to resolve by method name on a class/object
 */
export function matchMethodCall(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Parse method call patterns like "obj.method" or "Class::method". The method
  // part allows trailing `:` keywords so Objective-C selectors resolve
  // (`SDImageCache.storeImage:`, `obj.setX:y:`); colons never appear in other
  // languages' method refs, so this is a no-op for them.
  // The receiver allows dots (`builder.Services.AddCoreServices`) so a CHAINED
  // call resolves by its last segment — Strategy 3 below name-matches the method
  // (with its existing single-candidate / receiver-overlap guards). Without this
  // a multi-dot extension-method call (C# DI `builder.Services.AddCoreServices()`,
  // `Guard.Against.X()`) matched no pattern and never resolved.
  // C++ explicit operator call `a.operator+(b)` reaches the resolver as
  // `a.operator+` (#1247) — the operator's symbol chars (`+`, `==`, `[]`, `()`)
  // fail the \w method part of the plain pattern, so admit them explicitly.
  // Names like `operatorTable` stay on the plain pattern (tried first); the
  // operator form requires at least one non-word char after `operator`, and
  // every downstream strategy compares the method part by exact string
  // equality, so a stray match can't invent an edge.
  const dotMatch =
    ref.referenceName.match(/^([\w.]+)\.(\w+:?(?:\w+:)*)$/) ??
    (ref.language === 'cpp'
      ? ref.referenceName.match(/^([\w.]+)\.(operator[^\w\s.]+)$/)
      : null);
  const colonMatch = ref.referenceName.match(/^(\w+)::(\w+)$/);
  // Lua/Luau method calls use a single colon (`lg:log`); R uses `$` (`lg$log`).
  // Recognize these receiver/method separators so local-variable receiver-type
  // inference (#1108) applies to them too — extraction already emits the ref in
  // this shape, but the resolver otherwise only understood `.` and `::`.
  const luaColonMatch = (ref.language === 'lua' || ref.language === 'luau')
    ? ref.referenceName.match(/^([\w.]+):(\w+)$/)
    : null;
  const rDollarMatch = ref.language === 'r'
    ? ref.referenceName.match(/^([\w.]+)\$(\w+)$/)
    : null;

  // PHP property receiver: `$this->prop->method()` reaches the resolver as
  // `this->prop.method` (the extractor records the receiver's raw text with the
  // leading `$` stripped). Resolve it EXCLUSIVELY through declared-type
  // inference + resolveMethodOnType validation — the name-similarity strategies
  // below must never see this shape, so a property whose type can't be
  // recovered stays unlinked rather than guessed (a wrong inference produces no
  // edge rather than a wrong one). Deeper chains (`this->a->b.method`) don't
  // match the single-property pattern and stay unlinked, same as before.
  const phpThisPropMatch = ref.language === 'php'
    ? ref.referenceName.match(/^(this->\w+)\.(\w+)$/)
    : null;
  if (phpThisPropMatch) {
    const [, receiver, phpMethodName] = phpThisPropMatch;
    const inferredType = inferLocalReceiverType(receiver!, ref, context);
    if (!inferredType) return null;
    return resolveMethodOnType(
      inferredType,
      phpMethodName!,
      ref,
      context,
      0.9,
      'instance-method',
      importedFqnOf(inferredType, ref, context),
    );
  }

  // A TS/JS call through an ES private field of the enclosing class —
  // `this.#items.add()`, emitted as `this.#items.add` (#1987) — resolves
  // exactly like `this.<field>` below (#1496). `#` is outside dotMatch's
  // receiver class, so the shape is matched here.
  if (ref.language === 'typescript' || ref.language === 'javascript' || ref.language === 'tsx' || ref.language === 'jsx') {
    const privateField = ref.referenceName.match(/^this\.(#[\w$]+)\.(\w+)$/);
    if (privateField) return matchTsThisFieldCall(privateField[1]!, privateField[2]!, ref, context);
  }

  const match = dotMatch || colonMatch || luaColonMatch || rDollarMatch;
  if (!match) {
    return null;
  }

  const [, objectOrClass, methodName] = match;
  // A simple `receiver.method` / `receiver:method` / `receiver$method` shape whose
  // receiver type we can try to infer from its local declaration.
  const inferableReceiver = dotMatch || luaColonMatch || rDollarMatch;

  // Infer the receiver's type from its local declaration/initializer in the
  // enclosing scope, then resolve the method on that type (#1108). C++ keeps its
  // dedicated inferrer (header scan + `auto`); every other language uses the
  // shared source-based inferrer. resolveMethodOnType validates the method
  // exists on the inferred type, so a mis-inference produces no edge.
  if (inferableReceiver) {
    // A VB.NET receiver's declared type decides the call, or that there is no
    // project method to call: SCrawler's `ThumbnailFile.Delete(…)` on an
    // external `SFile` went to a nested class's `Delete` by a shared word.
    if (ref.language === 'vbnet' && dotMatch) {
      const typed = nmTimedT('mc-vbtyped', ref, () =>
        matchVbTypedCall(objectOrClass!, methodName!, ref, context, (name) => isStdMethodName('vbnet', name)));
      if (typed !== undefined) return typed;
    }
    let inferredType = nmTimedT('mc-infer', ref, () =>
      ref.language === 'cpp'
        ? inferCppReceiverType(objectOrClass!, ref, context)
        : inferLocalReceiverType(objectOrClass!, ref, context));
    // A pytest test's parameter is what its fixture returns: flaskbb's
    // `cli_runner.invoke(…)` is click's `CliRunner`, not the project's one `invoke`.
    if (!inferredType && ref.language === 'python' && dotMatch) inferredType = pythonFixtureReturnType(objectOrClass!, ref, context);
    if (!inferredType && MEMBER_TYPED_LANGUAGES.has(ref.language) && dotMatch) {
      inferredType = nmTimedT('mc-member', ref, () => inferMemberReceiverType(objectOrClass!, ref, context));
      // A field of a built-in type (`string _name`, `int count`) has no project method.
      if (inferredType && /^[a-z]/.test(inferredType)) return null;
    }
    // A type parameter is its bound; with none, only `Object`'s methods.
    if (inferredType && MEMBER_TYPED_LANGUAGES.has(ref.language) &&
        !context.getNodesByName(inferredType).some(isMethodOwnerKind)) {
      const bound = typeParameterBound(inferredType, ref, context);
      if (bound === null) return null;
      if (bound !== undefined) inferredType = bound;
    }
    const awaited = !inferredType && ESM_FAMILY.has(ref.language)
      ? inferEsmAwaitedCallType(objectOrClass!, ref, context) : null;
    if (awaited) {
      if (!awaited.name || TS_PRIMITIVE_TYPES.has(awaited.name)) return null;
      inferredType = awaited.name;
    }
    if (inferredType) {
      // Java/Kotlin: when two classes share the simple name, the file's import
      // pins WHICH one (#314). Other languages disambiguate by call-site file.
      const importedFqn =
        ref.language === 'java' || ref.language === 'kotlin'
          ? context
              .getImportMappings(ref.filePath, ref.language)
              .find((i) => i.localName === inferredType)?.source
          : undefined;
      const typedMatch = nmTimedT('mc-rmot', ref, () => resolveMethodOnType(
        inferredType,
        methodName!,
        awaited ? { ...ref, filePath: awaited.filePath } : ref,
        context,
        0.9,
        'instance-method',
        importedFqn,
      ));
      if (typedMatch && ref.language === 'kotlin') {
        // `medium and 0xff` on an Int: the standard library's member, not a project `Int.and(Long)`.
        const target = context.getNodeById?.(typedMatch.targetNodeId);
        if (target && isKotlinNumberBitwise(target, ref)) return null;
      }
      if (typedMatch) {
        if (awaited) {
          const target = context.getNodeById?.(typedMatch.targetNodeId);
          if (!target || (target.qualifiedName.startsWith(`${inferredType}::`) && target.filePath !== awaited.filePath)) return null;
          return { ...typedMatch, original: ref };
        }
        return typedMatch;
      }
      if (awaited) return null;
      // A Dart method an extension adds to the receiver's type — `s.shout()`
      // on `enum Shape` via `extension ShapeInfo on Shape` (#2338).
      if (ref.language === 'dart' && dotMatch) {
        const viaExtension = nearestDartMemberOfType(
          inferredType,
          context.getNodesByName(methodName!).filter((n) => n.language === 'dart' && isDartMember(n)),
          ref,
          context,
        );
        if (viaExtension) return { original: ref, targetNodeId: viaExtension.id, confidence: 0.85, resolvedBy: 'instance-method' };
      }
      // A known JS/TS builtin receiver is external when it has no project
      // method (#1566). Inference already strips generics (`Map<K, V>` →
      // `Map`); do not let Strategy 3 guess an unrelated `get`/`set`/`has`.
      // Keep the validated match above for a project type shadowing a builtin.
      // A primitive receiver joins the builtins here: `listed.split()` on a
      // `string` is the built-in method, and Strategy 3 would otherwise hand
      // it whichever project class happens to declare a lone `split` (#1840).
      if (
        ESM_FAMILY.has(ref.language) &&
        (JS_BUILT_INS.has(inferredType) || TS_PRIMITIVE_TYPES.has(inferredType))
      ) {
        return null;
      }
      // The receiver's declared type is one the project doesn't declare —
      // `List<Roshambo> list`, `String s`, `val sb = StringBuilder()` — so the
      // method is that outside type's. gson's `list.add(…)` went to a project
      // list wrapper's `add`, commons-lang's `s.length()` to a writer's.
      // (Only a type name — `java.util.List`, not a call chain like Python's
      // `Device.objects.create(…)` the initializer pattern also captures.)
      const typeName = inferredType.split('.').pop()!;
      if (/^[A-Z]/.test(typeName) &&
          !context.getNodesByName(typeName).some((n) => isMethodOwnerKind(n) && sameLanguageFamily(n.language, ref.language))) {
        return null;
      }
    }
  }

  // Go 2-hop field chain `base.field.Method` (#1276): the base's type comes
  // from the enclosing scope (typed parameter / method receiver / local var),
  // the field's declared type from that struct's own declaration lines, and
  // the method is VALIDATED on the field's type by resolveMethodOnType. This
  // branch is EXCLUSIVE for chained Go receivers: when the hop can't be
  // inferred or the field's type is external (`conn *sql.DB` — no project
  // node), the ref stays unresolved rather than falling through to the
  // bare-name strategies below, which is exactly how `target.conn.Exec(...)`
  // fabricated a dependency on an unrelated local interface's same-named
  // method. Chained Go receivers were never emitted before #1276, so there
  // is no prior recall to preserve on the fallback path.
  if (ref.language === 'go' && dotMatch && objectOrClass!.includes('.')) {
    return matchGoFieldChainCall(objectOrClass!, methodName!, ref, context);
  }

  // Rust call through a field of the enclosing type — `self.inner.run()`,
  // emitted as `self.inner.run` (#1585). Same discipline as the Go branch
  // above, and EXCLUSIVE for the same reason: validated field-type inference
  // or nothing. Letting this shape reach the bare-name strategies below is
  // how `self.inner.run()` resolved to a same-named method on an unrelated
  // type — or to the calling method itself, a self-edge the source doesn't
  // contain — whenever the field's type was external or merely shared a
  // method name with something nearby.
  if (ref.language === 'rust' && dotMatch && objectOrClass!.startsWith('self.')) {
    return matchRustSelfFieldCall(objectOrClass!.slice('self.'.length), methodName!, ref, context);
  }

  // Rust call on the enclosing type itself — `self.reset()`, emitted as
  // `self.reset` (#1861). Same discipline as the field branch above, and
  // EXCLUSIVE for the same reason: the owner is written on the `impl` line and
  // carried in the calling method's qualified name, so it is not a guess.
  // Letting this shape reach the bare-name strategies below is how
  // `self.reset()` resolved to a same-named method on an unrelated type
  // whenever that type's method happened to sit nearer the call site.
  if (ref.language === 'rust' && dotMatch && objectOrClass === 'self') {
    return matchRustSelfCall(methodName!, ref, context);
  }

  // TS/JS call through a field of the enclosing class — `this.mailer.send()`,
  // emitted as `this.mailer.send` (#1496). Same discipline as the Rust branch
  // above, and EXCLUSIVE for the same reason: the field's declared type off
  // the class's own declaration, validated by resolveMethodOnType, or nothing.
  // Letting the bare name through is how `this.mailer.send()` inside
  // `Notifier.send()` resolved to the calling method itself — a self-edge the
  // source does not contain — whenever the two shared a name.
  if (
    (ref.language === 'typescript' || ref.language === 'javascript' || ref.language === 'tsx' || ref.language === 'jsx') &&
    dotMatch &&
    objectOrClass!.startsWith('this.')
  ) {
    return matchTsThisFieldCall(objectOrClass!.slice('this.'.length), methodName!, ref, context);
  }

  // Java/Kotlin: receiver may be a field whose name doesn't match the type by
  // Java naming convention (`userbo` → class `UserBO`, abbreviated). Look up
  // the field in the enclosing class to get its declared type, then resolve
  // the method on that type. Covers Spring `@Resource`/`@Autowired` field
  // injection where the field type is the concrete bean class.
  if ((ref.language === 'java' || ref.language === 'kotlin') && dotMatch) {
    const inferredType = inferJavaFieldReceiverType(objectOrClass!, ref, context);
    if (inferredType) {
      // When two classes share the same simple name, the caller file's
      // import is the only signal that names WHICH one — pass the
      // imported FQN so resolveMethodOnType can disambiguate (#314).
      const imports = context.getImportMappings(ref.filePath, ref.language);
      const importedFqn = imports.find((i) => i.localName === inferredType)?.source;
      const typedMatch = nmTimedT('mc-rmot', ref, () => resolveMethodOnType(
        inferredType,
        methodName!,
        ref,
        context,
        0.9,
        'instance-method',
        importedFqn,
      ));
      if (typedMatch) {
        return typedMatch;
      }
    }
  }

  // Object-literal namespace receiver (#1573): `api.call()` where `api` is a
  // same-file `const api = { call() {…}, get: () => {…} }`. Its members are
  // plain functions with bare names inside the constant's extent — no
  // `Container::member` qualified name — so none of the class-shaped
  // strategies below can see them (Strategy 3 only considers `method`
  // kinds) and the call resolved to nothing at all. Same file only: a
  // cross-file use reaches the same helper through the import path.
  if (dotMatch && !objectOrClass!.includes('.') && OBJECT_LITERAL_LANGUAGES.has(ref.language)) {
    const literalMatch = nmTimedT('mc-literal', ref, (): ResolvedRef | null => {
      // Same-file holders only, so the call-site-first ordering is moot.
      const holders = context.getNodesByName(objectOrClass!).filter(
        (n) => (n.kind === 'constant' || n.kind === 'variable') && n.filePath === ref.filePath
      );
      for (const holder of holders) {
        const hit =
          resolveObjectLiteralMember(holder, methodName!, ref, context, 0.85, 'instance-method') ??
          resolveObjectLiteralBinding(holder, methodName!, ref, context);
        if (hit) return hit;
      }
      if (holders.length === 0) return resolveGlobalNamespaceMember(objectOrClass!, methodName!, ref, context);
      return null;
    });
    if (literalMatch) return literalMatch;
  }

  // Strategy 1: Direct class name match (existing logic). When the receiver
  // names a class that exists in several files (`Logger.log()` / `Logger::log()`
  // with a `Logger` in both `a/` and `b/`), try the class in the call site's
  // own file first — otherwise the first-indexed class wins and a call in `b/`
  // resolves to `a/`'s method (#1079).
  const strat1 = nmTimedT('mc-class', ref, (): ResolvedRef | null => {
    let classCandidates = preferCallSiteFile(
      context.getNodesByName(objectOrClass!).filter(isMethodOwnerKind),
      ref.filePath,
    );
    // A C# class the call's namespaces can see before one they can't:
    // serilog's `Some.InformationEvent()` in Serilog.Tests is its own
    // Support namespace's `Some`, not the performance tests'.
    if (ref.language === 'csharp' && classCandidates.length > 1) {
      const typeRef = { ...ref, referenceName: objectOrClass! };
      const visible = classCandidates.filter((c) => c.language !== 'csharp' || isCsharpTypeVisible(c, typeRef, context));
      classCandidates = [...visible, ...classCandidates.filter((c) => !visible.includes(c))];
    }
    // A VB.NET type declared in two projects is the caller's own project's:
    // staxrip's `FrameServerFactory.Create(…)` went to its AutoCrop tool's copy.
    if (ref.language === 'vbnet') classCandidates = preferVbProject(classCandidates, ref, context);

    for (const classNode of classCandidates) {
      // Skip cross-language class matches
      if (classNode.language !== ref.language) continue;

      const nodesInFile = context.getNodesInFile(classNode.filePath);
      const methodNode = nodesInFile.find(
        (n) =>
          n.kind === 'method' &&
          n.name === methodName &&
          n.qualifiedName.includes(classNode.name)
      );

      if (methodNode) {
        return {
          original: ref,
          targetNodeId: methodNode.id,
          confidence: 0.85,
          resolvedBy: 'qualified-name',
        };
      }
    }
    // A class method the named class inherits — Horse's `THorse.Get(…)` is
    // THorseCore's, three `class(…)` heads up — before any guess by name.
    const inherited = inheritedClassMethod(classCandidates.filter((c) => c.language === ref.language), methodName!, context);
    if (inherited) return { original: ref, targetNodeId: inherited.id, confidence: 0.8, resolvedBy: 'qualified-name' };
    return null;
  });
  if (strat1) return strat1;

  // Built-in method names need a validated receiver (#1987). Typed, imported,
  // object-literal and direct class receivers have had their chance above;
  // capitalization, word overlap or a unique method name are not evidence
  // that `list.map()` / `cache.get()` calls a project class.
  if (ref.referenceKind === 'calls' && JS_FAMILY.has(ref.language) &&
      objectOrClass !== 'this' && objectOrClass !== 'super' &&
      JS_BUILTIN_METHODS.has(methodName!)) return null;

  // A receiver the file imports is past guessing. A namespace import is the
  // module object, whose members are its exports, never some class's method;
  // a binding from a package outside the repository names nothing in it. The
  // import resolver placed what it could, and a method picked by name alone is
  // wrong: zod's `z.string()` (`import * as z from "zod/v4"`) bound 3,207 calls
  // to a test helper's `string` getter, trpc's `z.record()` another class's.
  if (ref.referenceKind === 'calls' && JS_FAMILY.has(ref.language) && isImportedModuleReceiver(objectOrClass!, ref, context)) {
    return null;
  }

  // A receiver written as a type name the project doesn't declare
  // (`Exception.Create(…)` in Delphi, `Collections.sort(…)`) is a type from
  // outside it: a same-named method of some project type is a guess. horse's
  // `Exception.Create` went to its own `EHorseException::Create` 44 times.
  // A C# using alias names its type: `using Assert = Newtonsoft.Json.Tests.XUnitAssert;`.
  const aliased = ref.language === 'csharp' ? csharpUsingAlias(objectOrClass!, ref, context) : null;
  if (aliased) {
    return resolveMethodOnType(aliased, methodName!, ref, context, 0.9, 'instance-method', undefined);
  }

  // In C# and Java a capitalized receiver the class around it doesn't declare
  // is a type — a project property of that name elsewhere (a test object's
  // `DateTime`) does not make `DateTime.Parse(…)` the project's.
  const typesOnly = ref.language === 'csharp' || ref.language === 'java' || ref.language === 'rust';
  if (namesExternalType(objectOrClass!, ref.language) &&
      !context.getNodesByName(objectOrClass!).some((n) => sameLanguageFamily(n.language, ref.language) &&
        (!typesOnly || isMethodOwnerKind(n) || n.kind === 'enum' || n.kind === 'namespace' || n.kind === 'module' ||
          n.kind === 'trait' || n.kind === 'type_alias'))) {
    return null;
  }
  // Rust `task::spawn(…)` / `io::stdout()`: a function through a module path —
  // never a method some type of that name owns.
  if (ref.language === 'rust' && match === colonMatch && /^[a-z_][\w]*(?:::[a-z_]\w*)*$/.test(objectOrClass!)) {
    return null;
  }
  // `string.Equals(…)`, `object.ReferenceEquals(…)`: a C# keyword type.
  if (ref.language === 'csharp' && /^(?:string|object|int|long|short|byte|bool|char|double|float|decimal|uint|ulong|ushort|sbyte)$/.test(objectOrClass!)) {
    return null;
  }

  // Strategy 2: Instance variable receiver - try capitalized form to find class
  // e.g., "permissionEngine" → look for classes containing "PermissionEngine"
  const capitalizedReceiver = objectOrClass!.charAt(0).toUpperCase() + objectOrClass!.slice(1);
  if (capitalizedReceiver !== objectOrClass) {
    const strat2 = nmTimedT('mc-capital', ref, (): ResolvedRef | null => {
      const fuzzyClassCandidates = preferCallSiteFile(
        context.getNodesByName(capitalizedReceiver).filter(isMethodOwnerKind),
        ref.filePath,
      );
      for (const classNode of fuzzyClassCandidates) {
        // Skip cross-language class matches
        if (classNode.language !== ref.language) continue;

        const nodesInFile = context.getNodesInFile(classNode.filePath);
        const methodNode = nodesInFile.find(
          (n) =>
            n.kind === 'method' &&
            n.name === methodName &&
            n.qualifiedName.includes(classNode.name)
        );

        if (methodNode) {
          return {
            original: ref,
            targetNodeId: methodNode.id,
            confidence: 0.8,
            resolvedBy: 'instance-method',
          };
        }
      }
      return null;
    });
    if (strat2) return strat2;
  }

  // Strategy 3: Find methods by name across the codebase, match by receiver
  // name similarity with the containing class. Handles abbreviated variable
  // names like permissionEngine → PermissionRuleEngine.
  if (methodName) {
    const strat3 = nmTimedT('mc-byname', ref, (): ResolvedRef | null => {
    const methodCandidates = context.getNodesByName(methodName!);
    // Ubiquitous-method ceiling (#999): a method name re-declared across a
    // vendored theme/SDK (Metronic's `init`/`update`/… on every widget) yields
    // K candidates that receiver-word overlap can't reliably disambiguate —
    // and filtering + scoring all K per call is the O(K²) cost that wedged
    // "Resolving refs" for 15-28 min. Bail before the O(K) work; Strategy 1/2
    // (class-name match) already had their precise shot above.
    if (methodCandidates.length > AMBIGUOUS_NAME_CEILING) {
      return null;
    }
    const methods = methodCandidates.filter(
      (n) => n.kind === 'method' && n.name === methodName
    );

    // Filter to same-language candidates first
    const sameLanguageMethods = methods.filter(m => m.language === ref.language);
    let targetMethods = sameLanguageMethods.length > 0 ? sameLanguageMethods : methods;
    // A receiver the file imports is another module's value: never a method
    // declared in the calling file. expo-camera's `CameraManager.isAvailableAsync()`
    // (`import CameraManager from './ExpoCameraManager'`) went to `CameraView`'s
    // own static `isAvailableAsync` — the method making the call.
    // Ruling the caller's file out may reject a guess; it must never
    // manufacture one — the one method left is then no likelier than before.
    let narrowed = false;
    if (JS_FAMILY.has(ref.language) && isImportBinding(objectOrClass!, ref, context)) {
      const kept = targetMethods.filter((m) => m.filePath !== ref.filePath);
      narrowed = kept.length !== targetMethods.length;
      targetMethods = kept;
    }
    // Ruling these out must not leave a lone other `destroy` to guess at.
    {
      const kept = targetMethods.filter((m) => !(DISPATCHED_ACTIONS.has(m.name) &&
        DISPATCHED_OWNER.test(m.qualifiedName.slice(0, Math.max(0, m.qualifiedName.lastIndexOf('::'))).split(/::|\./).pop()!)) &&
        !isKotlinNumberBitwise(m, ref));
      narrowed ||= kept.length !== targetMethods.length;
      targetMethods = kept;
    }
    // Another library's unnamed Dart extension does not apply here: bloc's
    // `tester.pumpApp(…)` is the imported `PumpApp`, not flutter_counter's
    // `extension on WidgetTester`.
    {
      const kept = targetMethods.filter((m) => m.filePath === ref.filePath || !isDartUnnamedExtensionMember(m, context));
      narrowed ||= kept.length !== targetMethods.length;
      targetMethods = kept;
    }
    // Production code never calls into a test suite: a guess from
    // rest_framework/renderers.py's `view.reverse_action(…)` is not a test's
    // `DummyView`. The test's methods were never in the running.
    if (!isTestPath(ref.filePath)) targetMethods = targetMethods.filter((m) => !isTestPath(m.filePath));
    // A Vue component's own method is reached as `this.m()` inside it —
    // never as `e.preventDefault()` on an event, nor `this.editor.setValue()`
    // on something the component holds. A template ref
    // (`this.$refs.form.validate()`) names a child this cannot tell apart.
    if (JS_FAMILY.has(ref.language)) {
      const kept = targetMethods.filter((m) => !isVueComponentMethod(m) || (objectOrClass === 'this' && m.filePath === ref.filePath));
      narrowed ||= kept.length !== targetMethods.length;
      targetMethods = kept;
    }

    // If only one same-language method with this name exists, use it —
    // except in Ruby, where nothing types a receiver: there the one method
    // must also belong to something the receiver is named after
    // (`web_push_request.legacy_encrypt` → WebPushRequest). rubocop's
    // `node.loc` on a rubocop-ast node went to the one `loc` in the project
    // 1,201 times; lobsters' `value.to_s` to a short-id class's.
    if (targetMethods.length === 1 && !narrowed && targetMethods[0]!.language === ref.language &&
        // A test double is only what a test names — as in the scoring below:
        // allauth's `resp.json()` on a Django test response is not the one
        // `json` of its `MockedResponse`.
        !isUnnamedTestDouble(targetMethods[0]!, objectOrClass!, ref, context) &&
        !((ref.language === 'lua' || ref.language === 'luau') && isLuaLibraryCall(objectOrClass!, methodName!, ref, targetMethods[0]!)) &&
        // Rust / Go / Kotlin / C# / VB.NET: a standard-library method name on
        // an untyped receiver (`sym.map(…)`, `w.Header().Get(…)`,
        // `reader.Value.ToString()`) is the library type's.
        !(isStdMethodName(ref.language, methodName!) &&
          !/^(?:self|Self|this|base)$/.test(objectOrClass!) && !receiverNamesOwner(receiverLink(objectOrClass!), targetMethods[0]!, context)) &&
        !(UNTYPED_RECEIVER_LANGUAGES.has(ref.language) && !/^(?:self|self\.class|this|super|weak_?self|strong_?self)$/i.test(objectOrClass!) &&
          !sharesReceiverWord(objectOrClass!, targetMethods[0]!) &&
          !(ref.language === 'objc' && objcReceiverReaches(objectOrClass!, targetMethods[0]!, context)) &&
          !(ref.language === 'php' && phpReceiverReaches(objectOrClass!, targetMethods[0]!, context)))) {
      return {
        original: ref,
        targetNodeId: targetMethods[0]!.id,
        confidence: 0.7,
        resolvedBy: 'instance-method',
      };
    }

    // Multiple methods: score by receiver name word overlap with class name
    if (targetMethods.length > 1) {
      // What the receiver is named after is its last link: `builder.tokeniser`
      // is a Tokeniser, `table.Columns` no kind of table.
      const receiverWords = splitCamelCase(receiverLink(objectOrClass!));
      const head = receiverWords[receiverWords.length - 1]?.toLowerCase();
      let bestMatch: typeof targetMethods[0] | undefined;
      let bestScore = 0;
      let tied: typeof targetMethods = [];

      // Same-file candidates first, so a score tie (`score > bestScore` keeps
      // the first seen) resolves to the call site's own file rather than the
      // first-indexed duplicate (#1079).
      const std = isStdMethodName(ref.language, methodName!) && !/^(?:self|Self|this|base)$/.test(objectOrClass!);
      for (const method of preferCallSiteFile(targetMethods, ref.filePath)) {
        if (std && !receiverNamesOwner(receiverLink(objectOrClass!), method, context)) continue;
        // The owner type's own name — not its namespace (`eShop.ClientApp…`
        // shares `Client` with every `httpClient`) nor the method's.
        const cut = method.qualifiedName.lastIndexOf('::');
        const classWords = cut > 0 ? splitCamelCase(method.qualifiedName.slice(0, cut).split(/::|\./).pop()!) : [];
        let score = receiverWords.filter(w =>
          classWords.some(cw => cw.toLowerCase() === w.toLowerCase())
        ).length;
        // A test double is only what a test constructs or names — never a
        // guess from `response.json()` (mealie's `_FakeHTTPResponse`) in a
        // file that never mentions it.
        if (TEST_DOUBLE_OWNER.test(classWords.join(' ')) && !receiverWords.some((w) => TEST_DOUBLE_OWNER.test(w)) &&
            !(context.readFile(ref.filePath) ?? '').includes(method.qualifiedName.slice(0, cut).split(/::|\./).pop()!)) continue;
        // The receiver's head noun naming the owner's: `bookPage` is a Page
        // before it is anything of a Book's.
        if (head !== undefined && head === classWords[classWords.length - 1]?.toLowerCase()) score += 1;
        // Bonus for same language
        if (method.language === ref.language) score += 1;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = method;
          tied = [method];
        } else if (score === bestScore) {
          tied.push(method);
        }
      }
      // VB.NET: between equally good guesses, the caller's own file, then its
      // project, then the nearer directory — and no guess when none of them
      // decides. staxrip's main app and its AutoCrop tool each declare a
      // `ColorHSL`, and the first indexed took about 90 of the app's calls.
      if (ref.language === 'vbnet' && tied.length > 1 && bestScore >= 2) bestMatch = breakVbTie(tied, ref, context) ?? undefined;

      // A wrapper handing its call on — BookStack's `FileStorage::delete` doing
      // `$storage->delete($path)`, `CommentRepo::delete` doing
      // `$comment->delete()` — names the caller's own class only by a shared
      // word. The guess is the caller itself, so there is no guess.
      if (bestMatch && bestScore >= 2 && bestMatch.id !== ref.fromNodeId) {
        return {
          original: ref,
          targetNodeId: bestMatch.id,
          confidence: 0.65,
          resolvedBy: 'instance-method',
        };
      }
    }
    return null;
    });
    if (strat3) return strat3;
  }

  return null;
}

/**
 * Is a member call's receiver (`z` in `z.string`, `ns` in `ns.util.fn`) an
 * import binding that is a module namespace, or one from outside the repo?
 */
function isImportedModuleReceiver(receiver: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const root = receiver.split('.')[0]!;
  const binding = context.getImportMappings?.(ref.filePath, ref.language)?.find((m) => m.localName === root);
  if (!binding) return false;
  return binding.isNamespace || context.isOutOfRepoImport?.(binding.source, ref.filePath, ref.language) === true;
}

/** A method a Vue Options API component declares for itself (`index::handleLogin` in `index.vue`). */
export function isVueComponentMethod(n: Node): boolean {
  return n.kind === 'method' && n.filePath.endsWith('.vue') && n.qualifiedName === `${path.posix.basename(n.filePath, '.vue')}::${n.name}`;
}

/** Is `ref` written as `this.<name>(` in the file that declares `n`? */
export function isThisCallInOwnFile(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (n.filePath !== ref.filePath) return false;
  const line = (context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/))?.[ref.line - 1] ?? '';
  return new RegExp(String.raw`\bthis\s*\??\.\s*${n.name.replace(/\$/g, '\\$')}\s*\(`).test(line);
}

/** Is the root of a member call's receiver (`CameraManager` in `CameraManager.x`) one of the file's imports? */
function isImportBinding(receiver: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const root = receiver.split('.')[0]!;
  return context.getImportMappings?.(ref.filePath, ref.language)?.some((m) => m.localName === root) === true;
}

/** Does the file bind `name` by importing it from outside the repository? */
export function isOutOfRepoBinding(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const binding = context.getImportMappings?.(ref.filePath, ref.language)?.find((m) => m.localName === name);
  return !!binding && context.isOutOfRepoImport?.(binding.source, ref.filePath, ref.language) === true;
}

/**
 * Languages whose receivers nothing types, where a unique method name alone
 * is no evidence: CFML's `server.keyExists()` is the struct member function,
 * not the one component method named `keyExists`; Objective-C's
 * `image.respondsToSelector:` is NSObject's, not a proxy class's override;
 * PHP's `$request->has()` is the framework request's, not a settings
 * service's.
 */
const UNTYPED_RECEIVER_LANGUAGES: ReadonlySet<string> = new Set(['ruby', 'cfml', 'cfscript', 'objc', 'php']);
