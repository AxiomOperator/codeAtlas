/**
 * Function-reference strategy (a function named as a value, e.g. a callback).
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from '../../types';
import { matchGoFieldChainCall } from '../lang/go';
import { jsFunctionLocalScope } from '../lang/javascript';
import { isFixtureInReach, isPythonLocallyBound, isPythonModuleGlobal, isPythonProperty, pythonBindsLocally, pythonDerivesFrom, pythonFieldType, pythonFromImports, pythonGlobalBindings, pythonGlobalMembers, pythonImportKeys, pythonLocalType, pythonMembers, pythonRefClass } from '../lang/python';
import { sameLanguageFamily } from '../language-family';
import { inferLocalReceiverType } from '../receiver-inference';
import { receiverLink } from '../std-methods';
import { sharesReceiverWord } from './fuzzy';
import { resolveMethodOnType } from './method-call';
import { isLexicallyReachable } from '../visibility';

/** Member values retain their receiver; never break ties by file order (#1820). */
function matchMemberFunctionRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const dot = ref.referenceName.lastIndexOf('.');
  const receiver = ref.referenceName.slice(0, dot);
  const member = ref.referenceName.slice(dot + 1);
  const result = (nodes: Node[], confidence = 0.9): ResolvedRef | null => {
    const pool = nodes.filter(n => sameLanguageFamily(n.language, ref.language));
    const target = pool.length === 1 ? pool[0] : undefined;
    return target && (target.kind === 'function' || target.kind === 'method') &&
      target.id !== ref.fromNodeId && !isPythonProperty(target, context)
      ? { original: ref, targetNodeId: target.id, confidence, resolvedBy: 'function-ref' }
      : null;
  };
  const imports = context.getImportMappings(ref.filePath, ref.language);
  // An import is authoritative even when it points outside the project.
  if (imports.some(i => i.localName === receiver.split('.')[0])) {
    if (ref.language === 'python') {
      const cls = pythonRefClass(receiver, ref, context);
      if (cls) return result(pythonMembers(cls, member, ref, context));
      // `mod.global` / an imported `global` itself — never a deeper chain (`mod.global.field`).
      const segments = receiver.split('.');
      const hit = segments.length <= 2 ? context.resolveImport?.({ ...ref, referenceName: receiver, referenceKind: 'references' }) : null;
      const global = hit && context.getNodeById?.(hit.targetNodeId);
      // A local import of the root binds what the file imports, unless the file imports it from two places.
      if (global && global.name === segments[segments.length - 1] && isPythonModuleGlobal(global, context) &&
          pythonImportKeys(segments[0]!, ref.filePath, context).size === 1 &&
          !pythonGlobalBindings(segments[0]!, ref.filePath, context).some(b => b.kind !== 'import') &&
          !pythonBindsLocally(segments[0]!, ref, context, false)) {
        return result(pythonGlobalMembers(global, member, ref, context));
      }
    }
    const imported = context.resolveImport?.(ref);
    const node = imported && context.getNodeById?.(imported.targetNodeId);
    return node ? result(context.getNodesByQualifiedName(node.qualifiedName).filter(n => n.filePath === node.filePath)) : null;
  }
  if (ref.language === 'go') {
    if (receiver.includes('.')) return matchGoFieldChainCall(receiver, member, ref, context);
    const type = inferLocalReceiverType(receiver, ref, context);
    if (type) return resolveMethodOnType(type, member, ref, context, 0.9, 'function-ref');
    const types = context.getNodesByName(receiver).filter(n => n.language === 'go' && (n.kind === 'struct' || n.kind === 'interface'));
    if (types.length) return types.length === 1 ? resolveMethodOnType(receiver, member, ref, context, 0.9, 'function-ref') : null;
  } else {
    const owner = context.getNodesInFile(ref.filePath).filter(n =>
      n.kind === 'class' && n.startLine <= ref.line && n.endLine >= ref.line)
      .sort((a, b) => b.startLine - a.startLine)[0];
    let type: string | null = null;
    if (receiver === 'self' || receiver === 'cls') {
      return owner ? result(pythonMembers(owner, member, ref, context)) : null;
    }
    if (/^(self|cls)\.\w+$/.test(receiver)) {
      if (!owner) return null;
      type = pythonFieldType(receiver, owner, ref, context);
    } else {
      type = pythonLocalType(receiver, ref, context);
      const global = type === null
        ? context.getNodesInFile(ref.filePath).find(n => n.name === receiver && isPythonModuleGlobal(n, context)) : undefined;
      if (global && !pythonBindsLocally(receiver, ref, context, true)) {
        return result(pythonGlobalMembers(global, member, ref, context));
      }
    }
    // A type name used directly (`Store.fetch`) is scoped just like an annotation.
    if (!type && /^[A-Z]\w*$/.test(receiver)) type = receiver;
    if (type && type !== 'object' && type !== 'Any') {
      const cls = pythonRefClass(type, ref, context);
      if (!cls) return null;
      const members = pythonMembers(cls, member, ref, context);
      if (members.length) return result(members);
      // A base-typed field can hold a subclass-only method (the reported case).
      // Keep only descendants of THAT base; unrelated same-name methods cannot win.
      const candidates = context.getNodesByName(member).filter(n => n.kind === 'method' && n.language === 'python');
      const descendants = candidates.filter(n => {
        const parent = context.getNodesInFile(n.filePath).find(c =>
          c.kind === 'class' && n.qualifiedName === `${c.qualifiedName}::${member}`);
        return parent && pythonDerivesFrom(parent, cls, ref, context);
      });
      return result(descendants, 0.8);
    }
  }
  // Unknown receivers retain the old unique-or-drop discipline, across ALL
  // files. Tests and abstract-looking bodies are candidates too. A lone method
  // stands only when the receiver is named after its owner: netbox's
  // `device=self.parent.device` is a model field, not the project's one
  // `device` method (a GraphQL filter's). A veto, never a filter — filtering
  // first would promote some other lone match into a new guess.
  const unique = result(context.getNodesByName(member), 0.8);
  const target = unique ? context.getNodeById?.(unique.targetNodeId) : null;
  return target && target.kind === 'method' && !sharesReceiverWord(receiverLink(receiver), target) ? null : unique;
}

/**
 * Resolve a function-as-value reference (#756) — a function name used as a
 * callback/function-pointer value (`register(handler)`, `o->cb = handler`,
 * `{ .cb = handler }`, `signal(SIGINT, handler)`). The ONLY strategy allowed
 * for `function_ref` refs: exact name, function/method targets only, same
 * language family, same-file first for bare names, and unique-only cross-file.
 * Member values use receiver/type/import scope before a unique-name fallback.
 * A wrong callback edge is worse than none.
 */
export function matchFunctionRef(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // `this.<member>` refs are resolved ONLY by the class-scoped resolver in
  // resolveOne (resolveThisMemberFnRef) — never by name matching here.
  if (ref.referenceName.startsWith('this.')) return null;

  if ((ref.language === 'python' || ref.language === 'go') && ref.referenceName.includes('.')) {
    return matchMemberFunctionRef(ref, context);
  }

  // In JS/TS/Python a bare identifier can never be a method value (methods
  // are only reachable through a receiver — `this.m` / `self.m` /
  // `Cls.m`), so bare fn-refs match FUNCTIONS only. This also sidesteps the
  // pre-existing TS quirk of class fields extracting as method-kind nodes,
  // which otherwise soaked up local names passed as arguments (excalidraw
  // A/B finding; same pattern in vendored docopt.py). Python's `self.m`
  // form keeps method targets via its own capture shape. C++ likewise: a
  // bare identifier can only be a FREE function (member values need
  // `&Cls::method`). PHP string callables name global FUNCTIONS (methods
  // need the `[$obj, 'm']` array form, which carries its own shape). Other
  // languages keep method targets: C# method groups, Swift/Dart
  // implicit-self, Java/Kotlin method references.
  const bareFnOnly =
    ref.language === 'typescript' || ref.language === 'tsx' ||
    ref.language === 'javascript' || ref.language === 'jsx' ||
    ref.language === 'arkts' ||
    ref.language === 'cpp' || ref.language === 'python' ||
    ref.language === 'php';

  // Python additionally accepts CLASS targets for bare identifiers (#1478):
  // class-as-value is a core Python idiom (`return SomeSerializer`,
  // `Meta.model = Org`, registry dicts, `admin.site.register(Model, Admin)`)
  // and, unlike TS, Python has no type-annotation recovery path. The
  // false-positive mechanism behind the function-only rule was lowercase
  // locals colliding with same-named METHODS (docopt.py) — a candidate must
  // be an exact-name CLASS node here, and the extraction gate (same-file
  // class ∪ imports) plus unique-or-drop still apply. Methods stay excluded.
  const bareClassOk = ref.language === 'python';

  // Qualified member-pointer (`&Widget::on_click` → "Widget::on_click"):
  // resolve the member ON THAT SCOPE — exempt from bareFnOnly (the `&Cls::m`
  // shape is an explicit member reference). Unique-or-drop like everything else.
  if (ref.referenceName.includes('::')) {
    const memberName = ref.referenceName.slice(ref.referenceName.lastIndexOf('::') + 2);
    const scoped = context
      .getNodesByName(memberName)
      .filter(
        (n) =>
          (n.kind === 'function' || n.kind === 'method') &&
          sameLanguageFamily(n.language, ref.language) &&
          n.id !== ref.fromNodeId &&
          (n.qualifiedName === ref.referenceName ||
            n.qualifiedName.endsWith(`::${ref.referenceName}`))
      );
    if (scoped.length === 0) return null;
    const sameFileScoped = scoped.filter((n) => n.filePath === ref.filePath);
    const pool = sameFileScoped.length > 0 ? sameFileScoped : scoped;
    if (sameFileScoped.length === 0 && scoped.length > 1) return null;
    const target = pool.reduce((a, b) => (a.startLine <= b.startLine ? a : b));
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.9,
      resolvedBy: 'function-ref',
    };
  }

  const named = context
    .getNodesByName(ref.referenceName)
    .filter(
      (n) =>
        (n.kind === 'function' ||
          (!bareFnOnly && n.kind === 'method') ||
          (bareClassOk && n.kind === 'class')) &&
        sameLanguageFamily(n.language, ref.language) &&
        n.id !== ref.fromNodeId // a function registering itself is not a dependency edge
    );
  // A function declared inside another is in scope only in there: httpx's
  // `self._build_auth(auth)` passes its own parameter, not the `auth` a test
  // defines inside `test_custom_auth`. Those still count against a lone
  // cross-file guess below — a name several functions use for themselves is
  // as likely a local's.
  let candidates = named.filter((n) => isLexicallyReachable(n, ref, context));
  if (candidates.length === 0) return null;
  // A Python name the function around it binds — a parameter, an assignment —
  // is that local's value: httpx's `auth_flow(self, request)` handing `request`
  // on is not the package's `request()` function. A pytest fixture is what a
  // test's parameter of its name receives.
  if (ref.language === 'python' && !candidates.some((n) => isFixtureInReach(n, ref.filePath, context)) &&
      isPythonLocallyBound(ref.referenceName, ref, context)) return null;
  // Likewise a JS/TS parameter or local: lodash's `baseHas(object, key)` passes its own `object`.
  const jsLocal = jsFunctionLocalScope(ref.referenceName, ref, context);
  if (jsLocal) {
    candidates = candidates.filter((n) => n.filePath === ref.filePath && n.startLine >= jsLocal.start && n.startLine <= jsLocal.end);
    if (candidates.length === 0) return null;
  }

  // Swift implicit-self: a bare identifier can name a METHOD only of the
  // ENCLOSING type (`Button(action: handleTap)` written inside that type) —
  // a same-named method on any OTHER class is a parameter collision
  // (Alamofire: a `request` parameter resolving to EventMonitor::request).
  // Scope method candidates to the from-symbol's type; top-level code has no
  // implicit self, so method targets are excluded there entirely. Free
  // functions are unaffected.
  if (ref.language === 'swift' && candidates.some((n) => n.kind === 'method')) {
    const fromNode = context.getNodeById?.(ref.fromNodeId);
    const sep = fromNode ? fromNode.qualifiedName.lastIndexOf('::') : -1;
    const classPrefix = fromNode && sep > 0 ? fromNode.qualifiedName.slice(0, sep) : null;
    candidates = candidates.filter((n) => {
      if (n.kind !== 'method') return true;
      if (!classPrefix) return false;
      const mSep = n.qualifiedName.lastIndexOf('::');
      if (mSep <= 0) return false;
      const methodPrefix = n.qualifiedName.slice(0, mSep);
      // Accept exact-scope matches plus suffix relationships either way, so
      // extension-declared members (`Holder::m`) still match a nested
      // from-scope (`Module::Holder::wire`) and vice versa.
      return (
        methodPrefix === classPrefix ||
        methodPrefix.endsWith(`::${classPrefix}`) ||
        classPrefix.endsWith(`::${methodPrefix}`)
      );
    });
    if (candidates.length === 0) return null;
  }

  // Same-file definition wins — the extraction gate guarantees most survivors
  // have one, and it's the dominant C pattern (static callback registered in
  // a same-file ops struct).
  const sameFile = candidates.filter((n) => n.filePath === ref.filePath);
  if (sameFile.length > 0) {
    // Swift: several same-named METHODS in one file is an API overload family
    // (`Session.request(...)` × N), and a bare identifier hitting it is almost
    // always a same-named parameter, not a method value (Alamofire A/B
    // finding) — refuse rather than guess. A single method (SwiftUI's
    // `action: handleTap`) still resolves.
    if (
      ref.language === 'swift' &&
      sameFile.length > 1 &&
      sameFile.every((n) => n.kind === 'method')
    ) {
      return null;
    }
    // Same-name overloads in one file are the same conceptual symbol; pick
    // the first by position for determinism.
    const target = sameFile.reduce((a, b) => (a.startLine <= b.startLine ? a : b));
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: sameFile.length === 1 ? 0.95 : 0.9,
      resolvedBy: 'function-ref',
    };
  }

  // Cross-file (imported names the import resolver didn't already claim):
  // only an unambiguous match resolves — or, in Python, the one in reach of
  // a name the file imports (netbox's `sender=CustomField` beside a test's
  // own nested `CustomField`).
  if (candidates.length === 1 && (named.length === 1 ||
      (ref.language === 'python' && pythonFromImports(ref.filePath, context).has(ref.referenceName)))) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.8,
      resolvedBy: 'function-ref',
    };
  }
  return null;
}
