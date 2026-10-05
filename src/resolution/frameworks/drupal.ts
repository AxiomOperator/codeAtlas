/**
 * Drupal Framework Resolver
 *
 * Supports Drupal 8/9/10/11 (Composer-based projects). Drupal 7 is not supported.
 *
 * ## What this resolver does
 *
 * 1. **Detection** — reads composer.json and checks for any `drupal/*` dependency in
 *    `require` or `require-dev`.
 *
 * 2. **Route extraction** — parses `*.routing.yml` files and emits `route` nodes for each
 *    Drupal route, with `references` edges to the `_controller`, `_form`, or entity handler
 *    class/method.
 *
 * 3. **Hook detection** — scans `.module`, `.install`, `.theme`, and `.inc` files for Drupal
 *    hook implementations. Two strategies are used:
 *      a. Docblock: `@Implements hook_X()` → precise, no false positives.
 *      b. Name pattern: function `{moduleName}_{hookSuffix}()` → catches hooks without
 *         docblocks but may produce false positives on helper functions.
 *    Detected hooks emit an `UnresolvedRef` from the implementing function node to the
 *    canonical `hook_X` name, linking implementations to the hook when `codegraph_callers`
 *    is invoked.
 *
 * 4. **OOP hooks** (Drupal 10.2+) — `#[Hook('x')]` on a method, or on a class naming its
 *    `method:` (else `__invoke`), emits the same `hook_x` reference a procedural
 *    implementation does, from the implementing method (#300).
 *
 * 5. **Plugins** — a class declared by a plugin attribute (`#[Block(id: …)]`) or a docblock
 *    annotation (`@Block(id = "…")`) gets a `decorates` reference to that attribute /
 *    annotation class, resolved through the file's `use` statement (#300).
 *
 * 6. **Services** — every `*.services.yml` service with a class is a `variable` node with an
 *    `instantiates` edge to that class; its tags (e.g. `event_subscriber`) are in the
 *    signature (#300).
 *
 * Deferred: the event an `EventSubscriberInterface` handles (`getSubscribedEvents()` maps an
 * event name to a method — needs the dispatcher side to be useful), `@service` arguments
 * between services (dotted ids collide with the dotted-call matcher), and Twig.
 *
 * ## Design decisions (review in future iterations)
 *
 * - Hook graph resolution (v1): hook references are stored as UnresolvedRef pointing to the
 *   canonical `hook_X` name. If Drupal core is indexed, these will resolve to core hook
 *   definitions. Without core, they remain unresolved but are still searchable via
 *   `codegraph_search("form_alter")`. Full hook-node creation (virtual nodes for every hook)
 *   is deferred to a future iteration.
 *
 * - Twig templates (out of scope for v1): `.twig` files are tracked as file nodes but no
 *   symbol extraction is performed (no tree-sitter Twig grammar). Implement when a Twig
 *   grammar WASM is available.
 *
 * ## TODOs for future iterations
 *
 * - TODO: Add Twig symbol extraction when a tree-sitter Twig grammar becomes available.
 * - TODO: Improve hook resolution: create virtual `hook_*` nodes so `codegraph_callers`
 *   returns all implementations even when Drupal core is not indexed.
 */

import { generateNodeId } from '../../extraction/tree-sitter-helpers';
import { Node } from '../../types';
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { lineOfIndex } from '../synth-utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the last PHP namespace segment from a FQCN like `\Drupal\mymodule\Controller\Foo`.
 * Returns `null` for strings that don't look like a FQCN.
 */
function lastSegment(fqcn: string): string | null {
  const clean = fqcn.replace(/^\\+/, '').trim();
  if (!clean.includes('\\')) return null;
  const parts = clean.split('\\');
  return parts[parts.length - 1] ?? null;
}

/**
 * Derive the Drupal module name from a file path.
 * e.g. `web/modules/custom/my_module/my_module.module` → `my_module`
 */
function moduleNameFromPath(filePath: string): string | null {
  const match = filePath.match(/\/([^/]+)\.[^./]+$/);
  return match ? match[1]! : null;
}

// ---------------------------------------------------------------------------
// Route extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract route nodes and handler references from a Drupal `*.routing.yml` file.
 *
 * Drupal routing YAML format:
 *
 *   route.name:
 *     path: '/some/path'
 *     defaults:
 *       _controller: '\Drupal\module\Controller\MyController::method'
 *       _form: '\Drupal\module\Form\MyForm'
 *       _title: 'Page title'
 *     requirements:
 *       _permission: 'access content'
 *     methods: [GET, POST]   # optional
 */
function extractDrupalRoutes(
  filePath: string,
  content: string
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();

  const lines = content.split('\n');

  type PendingRoute = { name: string; lineNum: number };
  let pending: PendingRoute | null = null;
  let currentPath: string | null = null;
  let handlerRefs: string[] = [];
  let methods: string[] = [];

  const flushRoute = () => {
    if (!pending || !currentPath) return;

    const methodTag = methods.length > 0 ? ` [${methods.join(',')}]` : '';
    const routeNode: Node = {
      id: `route:${filePath}:${pending.lineNum}:${currentPath}`,
      kind: 'route',
      name: `${currentPath}${methodTag}`,
      qualifiedName: `${filePath}::${pending.name}`,
      filePath,
      startLine: pending.lineNum,
      endLine: pending.lineNum,
      startColumn: 0,
      endColumn: 0,
      language: 'yaml',
      updatedAt: now,
    };
    nodes.push(routeNode);

    for (const handler of handlerRefs) {
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handler,
        referenceKind: 'references',
        line: pending.lineNum,
        column: 0,
        filePath,
        language: 'yaml',
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    // Top-level route name: no leading whitespace, ends with a colon (no value after)
    if (/^\S.*:\s*$/.test(line) && !/^\s/.test(line)) {
      flushRoute();
      pending = { name: trimmed.slice(0, -1).trim(), lineNum: i + 1 };
      currentPath = null;
      handlerRefs = [];
      methods = [];
      continue;
    }

    // path: '/some/path'
    const pathMatch = trimmed.match(/^path:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/);
    if (pathMatch) {
      currentPath = pathMatch[1]!.trim();
      continue;
    }

    // _controller: '\Drupal\...\Class::method'
    const controllerMatch = trimmed.match(/^_controller:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/);
    if (controllerMatch) {
      handlerRefs.push(controllerMatch[1]!.trim());
      continue;
    }

    // _form: '\Drupal\...\Form\MyForm'
    const formMatch = trimmed.match(/^_form:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/);
    if (formMatch) {
      handlerRefs.push(formMatch[1]!.trim());
      continue;
    }

    // _entity_form / _entity_list / _entity_view: entity.type
    const entityMatch = trimmed.match(/^_(entity_form|entity_list|entity_view):\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/);
    if (entityMatch) {
      handlerRefs.push(entityMatch[2]!.trim());
      continue;
    }

    // methods: [GET, POST]  or  methods: [GET]
    const methodsMatch = trimmed.match(/^methods:\s*\[([^\]]+)\]/);
    if (methodsMatch) {
      methods = methodsMatch[1]!.split(',').map((m) => m.trim().toUpperCase()).filter(Boolean);
      continue;
    }
  }

  flushRoute();
  return { nodes, references };
}

// ---------------------------------------------------------------------------
// Hook detection helpers
// ---------------------------------------------------------------------------

const HOOK_FILE_EXTENSIONS = ['.module', '.install', '.theme', '.inc'];

function isDrupalHookFile(filePath: string): boolean {
  return HOOK_FILE_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

/**
 * Extract hook implementation references from a Drupal PHP file.
 *
 * Strategy A (primary): look for docblocks containing `Implements hook_X().`
 * followed immediately by the function definition. This is the Drupal coding
 * standard and is precise.
 *
 * Strategy B (fallback): for functions whose name starts with `{moduleName}_`,
 * treat the suffix as the hook name. Catches hooks without docblocks but may
 * produce false positives on non-hook helper functions.
 *
 * Each detected hook emits an UnresolvedRef from the implementing function node
 * (identified by computing the same ID tree-sitter would generate) to the
 * canonical hook name, e.g. `hook_form_alter`.
 */
function extractDrupalHooks(
  filePath: string,
  content: string
): { nodes: Node[]; references: UnresolvedRef[] } {
  const references: UnresolvedRef[] = [];

  // Build a map of function name → 1-indexed line number for all top-level functions.
  // This mirrors tree-sitter's line numbering so we can reconstruct node IDs.
  const funcLineMap = new Map<string, number>();
  const funcDef = /^function\s+(\w+)\s*\(/gm;
  let fm: RegExpExecArray | null;
  while ((fm = funcDef.exec(content)) !== null) {
    const name = fm[1]!;
    if (!funcLineMap.has(name)) {
      // line = number of newlines before match start + 1
      funcLineMap.set(name, lineOfIndex(content, fm.index));
    }
  }

  const emitHookRef = (hookName: string, funcName: string) => {
    const lineNum = funcLineMap.get(funcName);
    if (lineNum === undefined) return;
    const nodeId = generateNodeId(filePath, 'function', funcName, lineNum);
    references.push({
      fromNodeId: nodeId,
      referenceName: hookName,
      referenceKind: 'references',
      line: lineNum,
      column: 0,
      filePath,
      language: 'php',
    });
  };

  // Strategy A: docblock `Implements hook_X().` followed by function definition.
  // The docblock and function may be separated by blank lines.
  const docblockPattern =
    /\/\*\*[\s\S]*?(?:@|\*\s+)Implements\s+(hook_\w+)\s*\(\)[\s\S]*?\*\/\s*\n(?:\s*\n)*function\s+(\w+)\s*\(/g;
  const docblockMatched = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = docblockPattern.exec(content)) !== null) {
    const [, hookName, funcName] = match;
    emitHookRef(hookName!, funcName!);
    docblockMatched.add(funcName!);
  }

  // Strategy B: fallback name-pattern matching for functions without docblocks.
  // Only applies to functions whose name starts with {moduleName}_ and that were
  // not already matched by Strategy A.
  const moduleName = moduleNameFromPath(filePath);
  if (moduleName) {
    const prefix = moduleName + '_';
    for (const [funcName] of funcLineMap) {
      if (docblockMatched.has(funcName)) continue;
      if (!funcName.startsWith(prefix)) continue;
      const hookSuffix = funcName.slice(prefix.length);
      if (!hookSuffix) continue;
      // Emit a reference to hook_{suffix} — the resolver will link it if the
      // hook is defined somewhere in the indexed graph (e.g. Drupal core).
      emitHookRef(`hook_${hookSuffix}`, funcName);
    }
  }

  return { nodes: [], references };
}

// ---------------------------------------------------------------------------
// PHP declaration scanner (attributes, docblocks, classes, methods)
// ---------------------------------------------------------------------------

/** One attribute inside a `#[...]` group: last name segment + raw argument text. */
interface PhpAttr {
  name: string;
  args: string;
}

/** A class / method / function declaration with what decorates it. */
interface PhpDecl {
  kind: 'class' | 'method' | 'function' | 'other';
  name: string;
  /**
   * The line tree-sitter's node starts on — the first attribute group or
   * modifier before the keyword, not the keyword itself. Node ids are hashed
   * from it, so a hook/plugin ref built from the `function`/`class` line would
   * point at a node that does not exist.
   */
  line: number;
  attrs: PhpAttr[];
  /** The `/** … *\/` docblock directly above (annotations live here). */
  docblock: string | null;
  /** Index (in the returned list) of the enclosing class-like declaration. */
  container: number | null;
}

const PHP_MODIFIERS = new Set(['public', 'protected', 'private', 'static', 'final', 'abstract', 'readonly', 'var']);
const PHP_CONTAINERS = new Set(['class', 'interface', 'trait', 'enum']);

/** Index just past the bracket that closes the one opening at `open` (string-aware). */
function skipBalanced(src: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === o) depth++;
    else if (ch === c) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/** Split `Hook('a'), Hook('b', method: 'x')` (a `#[...]` group's body) into attributes. */
function parseAttrGroup(body: string): PhpAttr[] {
  const attrs: PhpAttr[] = [];
  let i = 0;
  while (i < body.length) {
    const m = /^\s*,?\s*\\?([A-Za-z_][\w\\]*)/.exec(body.slice(i));
    if (!m) break;
    i += m[0].length;
    const name = m[1]!.split('\\').pop()!;
    let args = '';
    const ws = /^\s*/.exec(body.slice(i))![0].length;
    if (body[i + ws] === '(') {
      const end = skipBalanced(body, i + ws, '(', ')');
      args = body.slice(i + ws + 1, end - 1);
      i = end;
    }
    attrs.push({ name, args });
  }
  return attrs;
}

/**
 * Lenient single-pass scan of a PHP file for class-like and function
 * declarations, collecting each one's `#[...]` attributes and docblock. Not a
 * parser: strings and comments are skipped so their contents never read as
 * code, and brace depth tracks which class a method belongs to.
 */
function scanPhpDecls(content: string): PhpDecl[] {
  const decls: PhpDecl[] = [];
  const stack: { decl: number; depth: number }[] = [];
  let depth = 0;
  let pendingAttrs: PhpAttr[] = [];
  let pendingStart = -1;
  let docblock: string | null = null;
  let openContainer: number | null = null;
  const reset = (): void => {
    pendingAttrs = [];
    pendingStart = -1;
    docblock = null;
  };
  const n = content.length;
  let i = 0;
  while (i < n) {
    const ch = content[i]!;
    if (ch === '"' || ch === "'") {
      i++;
      while (i < n && content[i] !== ch) {
        if (content[i] === '\\') i++;
        i++;
      }
      i++;
      reset();
      continue;
    }
    if (ch === '#' && content[i + 1] === '[') {
      const end = skipBalanced(content, i + 1, '[', ']');
      if (pendingStart < 0) pendingStart = i;
      pendingAttrs.push(...parseAttrGroup(content.slice(i + 2, end - 1)));
      i = end;
      continue;
    }
    if ((ch === '/' && content[i + 1] === '/') || ch === '#') {
      const nl = content.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      if (content[i + 2] === '*') docblock = content.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '$') {
      // A variable (`$class`) is never a keyword.
      i++;
      while (i < n && /\w/.test(content[i]!)) i++;
      reset();
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < n && /\w/.test(content[i]!)) i++;
      const word = content.slice(start, i);
      const before = content.slice(Math.max(0, start - 2), start);
      if (before === '::' || before === '->' || before.endsWith('\\')) {
        reset();
        continue;
      }
      if (PHP_MODIFIERS.has(word.toLowerCase())) {
        if (pendingStart < 0) pendingStart = start;
        continue;
      }
      const lower = word.toLowerCase();
      if (lower === 'function' || PHP_CONTAINERS.has(lower)) {
        const m = /^\s*&?\s*([A-Za-z_]\w*)/.exec(content.slice(i, i + 200));
        const prev = content.slice(Math.max(0, start - 10), start);
        // `function (` is a closure, `new class` an anonymous class.
        if (m && !/\bnew\s+$/.test(prev)) {
          const declStart = pendingStart >= 0 ? pendingStart : start;
          const top = stack.length > 0 ? stack[stack.length - 1]! : null;
          const inClassBody = top !== null && depth === top.depth;
          const kind: PhpDecl['kind'] =
            lower === 'function' ? (inClassBody ? 'method' : 'function') : lower === 'class' ? 'class' : 'other';
          decls.push({
            kind,
            name: m[1]!,
            line: lineOfIndex(content, declStart),
            attrs: pendingAttrs,
            docblock,
            container: inClassBody ? top!.decl : null,
          });
          if (lower !== 'function') openContainer = decls.length - 1;
          i += m[0].length;
        }
        reset();
        continue;
      }
      reset();
      continue;
    }
    if (ch === '{') {
      depth++;
      if (openContainer !== null) {
        stack.push({ decl: openContainer, depth });
        openContainer = null;
      }
      reset();
    } else if (ch === '}') {
      if (stack.length > 0 && stack[stack.length - 1]!.depth === depth) stack.pop();
      depth--;
      reset();
    } else if (!/\s/.test(ch)) {
      // `;` ends an interface method / abstract declaration; any other
      // punctuation means the pending attributes belonged to something else.
      if (ch === ';' && openContainer !== null) openContainer = null;
      reset();
    }
    i++;
  }
  return decls;
}

// ---------------------------------------------------------------------------
// OOP hooks (#[Hook], Drupal 10.2+) and plugin declarations
// ---------------------------------------------------------------------------

/**
 * Plugin types core declares with an attribute (Drupal 10.2+) or a docblock
 * annotation (earlier). A contrib plugin type is recognised by its `id`
 * argument instead — see `isPluginAttr`.
 */
const DRUPAL_PLUGIN_TYPES = new Set([
  'Action', 'Archiver', 'Block', 'CKEditor5Plugin', 'Condition', 'ConfigEntityType', 'Constraint',
  'ContentEntityType', 'DataType', 'DisplayVariant', 'Editor', 'EntityReferenceSelection', 'EntityType',
  'Field', 'FieldFormatter', 'FieldType', 'FieldWidget', 'Filter', 'FormElement', 'HelpSection',
  'ImageEffect', 'ImageToolkit', 'ImageToolkitOperation', 'LanguageNegotiation', 'Layout', 'Mail',
  'MediaSource', 'Menu', 'MenuLink', 'MigrateDestination', 'MigrateField', 'MigrateProcess',
  'MigrateProcessPlugin', 'MigrateSource', 'PageDisplayVariant', 'QueueWorker', 'RenderElement',
  'RestResource', 'SearchPlugin', 'SectionStorage', 'StreamWrapper', 'ViewsAccess', 'ViewsArea',
  'ViewsArgument', 'ViewsArgumentDefault', 'ViewsArgumentValidator', 'ViewsCache', 'ViewsDisplay',
  'ViewsDisplayExtender', 'ViewsExposedForm', 'ViewsField', 'ViewsFilter', 'ViewsJoin', 'ViewsPager',
  'ViewsQuery', 'ViewsRelationship', 'ViewsRow', 'ViewsSort', 'ViewsStyle', 'ViewsWizard', 'WorkflowType',
]);

/** The hook name a `#[Hook(...)]` names: the first positional string, or `hook: '…'`. */
function hookNameOf(args: string): string | null {
  const named = /\bhook\s*:\s*['"](\w+)['"]/.exec(args);
  if (named) return named[1]!;
  const positional = /^\s*['"](\w+)['"]/.exec(args);
  return positional ? positional[1]! : null;
}

function isPluginAttr(attr: PhpAttr): boolean {
  if (attr.name === 'Hook' || attr.name === 'LegacyHook') return false;
  return DRUPAL_PLUGIN_TYPES.has(attr.name) || /(?:^|[,(\s])id\s*:/.test(attr.args);
}

/** Plugin annotations in a docblock: `@Block(` (known type) or `@Anything(… id = "x" …)`. */
function pluginAnnotations(docblock: string): string[] {
  const types: string[] = [];
  for (const m of docblock.matchAll(/@([A-Z]\w*)\s*\(/g)) {
    const name = m[1]!;
    if (name === 'Translation' || name === 'PluralTranslation' || name === 'ContextDefinition') continue;
    const open = m.index! + m[0].length - 1;
    const body = docblock.slice(open, skipBalanced(docblock, open, '(', ')'));
    if (DRUPAL_PLUGIN_TYPES.has(name) || /(?:^|[,(\s*])id\s*=/.test(body)) types.push(name);
  }
  return [...new Set(types)];
}

/**
 * OOP hook implementations and plugin declarations in a PHP class file.
 *
 * Hooks — each emits the same `hook_X` reference a procedural implementation
 * does, from the method that implements it:
 *   - `#[Hook('entity_presave')]` on a method (stacked or grouped attributes
 *     each count);
 *   - `#[Hook('form_alter', method: 'formAlter')]` on a class → that method;
 *   - `#[Hook('cron')]` on a class with no `method:` → its `__invoke()`.
 *
 * Plugins — a class declared by a plugin attribute (`#[Block(id: …)]`) or a
 * docblock annotation (`@Block(id = "…")`) gets a `decorates` reference to the
 * attribute/annotation class, which the file's own `use` statement names —
 * the same edge a Java annotation or a TypeScript decorator produces.
 */
function extractDrupalClassPatterns(filePath: string, content: string): UnresolvedRef[] {
  if (!content.includes('#[') && !/@[A-Z]\w*\s*\(/.test(content)) return [];
  const references: UnresolvedRef[] = [];
  const decls = scanPhpDecls(content);
  const hookRef = (decl: PhpDecl, hook: string): void => {
    references.push({
      fromNodeId: generateNodeId(filePath, 'method', decl.name, decl.line),
      referenceName: `hook_${hook}`,
      referenceKind: 'references',
      line: decl.line,
      column: 0,
      filePath,
      language: 'php',
    });
  };

  decls.forEach((decl, index) => {
    if (decl.kind === 'method') {
      for (const attr of decl.attrs) {
        if (attr.name !== 'Hook') continue;
        const hook = hookNameOf(attr.args);
        if (hook) hookRef(decl, hook);
      }
      return;
    }
    if (decl.kind !== 'class') return;

    for (const attr of decl.attrs) {
      if (attr.name !== 'Hook') continue;
      const hook = hookNameOf(attr.args);
      if (!hook) continue;
      const target = /\bmethod\s*:\s*['"](\w+)['"]/.exec(attr.args)?.[1] ?? '__invoke';
      const method = decls.find((d) => d.kind === 'method' && d.container === index && d.name === target);
      if (method) hookRef(method, hook);
    }

    const pluginTypes = new Set<string>();
    for (const attr of decl.attrs) if (isPluginAttr(attr)) pluginTypes.add(attr.name);
    if (decl.docblock) for (const t of pluginAnnotations(decl.docblock)) pluginTypes.add(t);
    for (const type of pluginTypes) {
      references.push({
        fromNodeId: generateNodeId(filePath, 'class', decl.name, decl.line),
        referenceName: type,
        referenceKind: 'decorates',
        line: decl.line,
        column: 0,
        filePath,
        language: 'php',
      });
    }
  });
  return references;
}

// ---------------------------------------------------------------------------
// Services (*.services.yml)
// ---------------------------------------------------------------------------

/**
 * Each service in a `*.services.yml` with a class becomes a `variable` node
 * named by its service id, with an `instantiates` reference to the class the
 * container builds for it (the shape Spring XML beans use). Tags are kept in
 * the signature, so an `event_subscriber` reads as one:
 *
 *   services:
 *     mymodule.subscriber:
 *       class: Drupal\mymodule\EventSubscriber\MySubscriber
 *       tags:
 *         - { name: event_subscriber }
 *
 * A service whose id is itself the class (`Drupal\x\Foo: ~`, the autowired
 * short form) is skipped: its node would carry the class's own name and add
 * nothing the class node does not already say. Aliases (`foo: '@bar'`) and
 * `_defaults` declare no class and are skipped too. Indentation is read from
 * the file, not assumed.
 */
function extractDrupalServices(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  const lines = content.split('\n');
  const unquote = (v: string): string => v.trim().replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim();

  type Svc = { id: string; line: number; cls: string | null; tags: string[] };
  const services: Svc[] = [];
  let inServices = false;
  let svcIndent = -1;
  let current: Svc | null = null;
  let inTags = false;
  let propIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\r$/, '');
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      inServices = /^services\s*:\s*$/.test(trimmed);
      current = null;
      svcIndent = -1;
      continue;
    }
    if (!inServices) continue;
    if (svcIndent < 0) svcIndent = indent;
    if (indent === svcIndent) {
      inTags = false;
      propIndent = -1;
      const m = /^(['"]?)([^'":]+(?::[^'":\s]+)*)\1\s*:\s*(.*)$/.exec(trimmed);
      if (!m) {
        current = null;
        continue;
      }
      const id = m[2]!.trim();
      const value = m[3]!.trim();
      current = null;
      if (id === '_defaults' || value.startsWith("'@") || value.startsWith('"@') || value.startsWith('@')) continue;
      current = { id, line: i + 1, cls: null, tags: [] };
      services.push(current);
      // Inline map: `foo: { class: Drupal\x\Foo, tags: [{ name: event_subscriber }] }`
      const inlineClass = /\bclass\s*:\s*([^,}]+)/.exec(value);
      if (inlineClass) current.cls = unquote(inlineClass[1]!);
      for (const t of value.matchAll(/\bname\s*:\s*([\w.]+)/g)) current.tags.push(t[1]!);
      continue;
    }
    if (!current || indent < svcIndent) continue;
    // A service's own keys sit at one indentation (the first one seen); a
    // deeper `name: event_subscriber` belongs to an expanded tag list.
    if (propIndent < 0) propIndent = indent;
    const prop = indent === propIndent ? /^(\w+)\s*:\s*(.*)$/.exec(trimmed) : null;
    if (prop && !trimmed.startsWith('-')) {
      inTags = prop[1] === 'tags';
      if (prop[1] === 'class') current.cls = unquote(prop[2]!);
      if (inTags) for (const t of prop[2]!.matchAll(/\bname\s*:\s*([\w.]+)/g)) current.tags.push(t[1]!);
      continue;
    }
    if (inTags) {
      for (const t of trimmed.matchAll(/\bname\s*:\s*['"]?([\w.]+)/g)) current.tags.push(t[1]!);
    }
  }

  for (const svc of services) {
    if (!svc.cls || !svc.cls.includes('\\') || svc.id.includes('\\')) continue;
    const cls = svc.cls.replace(/^\\/, '');
    const node: Node = {
      id: generateNodeId(filePath, 'variable', svc.id, svc.line),
      kind: 'variable',
      name: svc.id,
      qualifiedName: `${filePath}::${svc.id}`,
      filePath,
      startLine: svc.line,
      endLine: svc.line,
      startColumn: 0,
      endColumn: 0,
      language: 'yaml',
      signature: svc.tags.length > 0 ? `class: ${cls} tags: ${[...new Set(svc.tags)].join(', ')}` : `class: ${cls}`,
      updatedAt: now,
    };
    nodes.push(node);
    references.push({
      fromNodeId: node.id,
      referenceName: cls,
      referenceKind: 'instantiates',
      line: svc.line,
      column: 0,
      filePath,
      language: 'yaml',
    });
  }
  return { nodes, references };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export const drupalResolver: FrameworkResolver = {
  name: 'drupal',
  languages: ['php', 'yaml'],

  // Drupal route handlers are FQCNs (`\Drupal\…\Class::method`, the single-colon
  // controller-service form `\Drupal\…\Class:method`, or a bare `\…\FormClass`)
  // and hook refs are canonical `hook_*` names — none match a declared symbol, so
  // resolveOne's pre-filter would drop them before resolve() runs. Claim the
  // shapes resolve() handles (mirrors the Rails `controller#action` claim).
  claimsReference(name: string): boolean {
    return (
      name.startsWith('hook_') ||
      name.includes('\\') ||
      /^[A-Za-z_]\w*::?\w+$/.test(name)
    );
  },

  detect(context: ResolutionContext): boolean {
    // Primary: composer.json identifies a Drupal project/module/theme/profile.
    // A contrib module often has an EMPTY `require` (no `drupal/*` dep) but still
    // declares `"name": "drupal/<module>"` and `"type": "drupal-module"`, so check
    // those too — checking deps alone misses every standalone contrib module.
    const composer = context.readFile('composer.json');
    if (composer) {
      try {
        const json = JSON.parse(composer) as {
          name?: string;
          type?: string;
          require?: Record<string, string>;
          'require-dev'?: Record<string, string>;
        };
        if (typeof json.name === 'string' && json.name.startsWith('drupal/')) return true;
        if (typeof json.type === 'string' && json.type.startsWith('drupal-')) return true;
        const deps = { ...json.require, ...(json['require-dev'] ?? {}) };
        if (Object.keys(deps).some((k) => k.startsWith('drupal/'))) return true;
      } catch {
        // malformed composer.json — fall through to file-based detection
      }
    }

    // Fallback (composer-less module, or a non-Drupal composer.json): the
    // unmistakable Drupal signature is a `*.info.yml` manifest alongside a
    // Drupal PHP/route file. Require both so a stray `.info.yml` elsewhere
    // doesn't trigger a false positive.
    const files = context.getAllFiles();
    const hasInfoYml = files.some((f) => f.endsWith('.info.yml'));
    if (!hasInfoYml) return false;
    return files.some(
      (f) =>
        f.endsWith('.routing.yml') ||
        f.endsWith('.module') ||
        f.endsWith('.install') ||
        f.endsWith('.theme')
    );
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const name = ref.referenceName;

    // _controller: '\Drupal\module\...\ClassName::methodName' (double colon) or the
    // single-colon controller-service form '\Drupal\...\ClassName:methodName'.
    const controllerMatch = name.match(/^\\?(?:Drupal\\[^:]+\\)?([^\\:]+):{1,2}(\w+)$/);
    if (controllerMatch) {
      const [, className, methodName] = controllerMatch;
      const classNodes = context.getNodesByName(className!);
      for (const cls of classNodes) {
        if (cls.kind !== 'class') continue;
        const fileNodes = context.getNodesInFile(cls.filePath);
        const method = fileNodes.find((n) => n.kind === 'method' && n.name === methodName);
        if (method) {
          return { original: ref, targetNodeId: method.id, confidence: 0.9, resolvedBy: 'framework' };
        }
        return { original: ref, targetNodeId: cls.id, confidence: 0.7, resolvedBy: 'framework' };
      }
    }

    // _form / _entity_form: '\Drupal\module\...\ClassName'  (bare FQCN, no method)
    if (name.includes('\\') && !name.includes(':')) {
      const className = lastSegment(name);
      if (className) {
        const classNodes = context.getNodesByName(className);
        const cls = classNodes.find((n) => n.kind === 'class');
        if (cls) {
          return { original: ref, targetNodeId: cls.id, confidence: 0.85, resolvedBy: 'framework' };
        }
      }
    }

    // hook_X — the hook's documented definition (`function hook_X()` in a
    // `*.api.php`), when core or the defining module is indexed. Without it the
    // ref stays unresolved: binding to some OTHER module's `*_X` implementation
    // (what this branch used to do) linked one implementation to another, and an
    // implementation to itself.
    if (name.startsWith('hook_')) {
      const defs = context.getNodesByName(name).filter((n) => n.kind === 'function' && n.language === 'php');
      const def = defs.find((n) => n.filePath.endsWith('.api.php')) ?? (defs.length === 1 ? defs[0] : undefined);
      if (def && def.id !== ref.fromNodeId) {
        return { original: ref, targetNodeId: def.id, confidence: 0.9, resolvedBy: 'framework' };
      }
      return null;
    }

    return null;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    if (filePath.endsWith('.routing.yml')) {
      return extractDrupalRoutes(filePath, content);
    }

    if (filePath.endsWith('.services.yml')) {
      return extractDrupalServices(filePath, content);
    }

    if (isDrupalHookFile(filePath) || filePath.endsWith('.php')) {
      const procedural = extractDrupalHooks(filePath, content);
      return {
        nodes: procedural.nodes,
        references: [...procedural.references, ...extractDrupalClassPatterns(filePath, content)],
      };
    }

    return { nodes: [], references: [] };
  },
};
