import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, Language } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';
import { foldScriptResult } from './sfc-script';
import { buildFileNode } from './file-node';
import { vueOptionsMembers } from './vue-options-api';

/**
 * Vue built-in components — skipped so a `<Transition>` / `<KeepAlive>` in the
 * template doesn't become a phantom reference to a user component. Checked
 * AFTER kebab→Pascal conversion, so `<keep-alive>` is caught here too.
 */
const VUE_BUILTIN_COMPONENTS = new Set([
  'Transition',
  'TransitionGroup',
  'KeepAlive',
  'Suspense',
  'Teleport',
  'Component',
  'Slot',
]);

/** Words that look like a call in an expression (`if (`, `typeof (`) but aren't one. */
const TEMPLATE_NON_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'void',
  'delete', 'in', 'of', 'instanceof', 'await', 'new',
]);

/** `{{ expr }}` interpolations. */
const TEMPLATE_INTERPOLATION_RE = /\{\{([\s\S]*?)\}\}/g;
/** Bound attributes and directives — `:to`, `v-bind:x`, `@click`, `v-on:x`, `v-if`, `#slot` — and their value. */
const TEMPLATE_BOUND_ATTR_RE = /(?<=[\s<])(?::|@|#|v-)[\w.:\-[\]]*\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** A callee: an identifier or a member path, not itself the tail of another expression. */
const TEMPLATE_CALL_RE = /(?<![\w$.\]])([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*\(/g;

/** `my-component` → `MyComponent` (Vue allows either form in templates). */
function kebabToPascal(name: string): string {
  return name
    .split('-')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ''))
    .join('');
}

/**
 * VueExtractor - Extracts code relationships from Vue Single-File Component files
 *
 * Vue SFCs are multi-language (script + template + style). Rather than
 * parsing the full Vue grammar, we extract the <script> block content
 * and delegate it to the TypeScript/JavaScript TreeSitterExtractor.
 *
 * Every .vue file produces a component node (Vue components are always importable).
 */
export class VueExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  /**
   * Extract from Vue source
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      // The file, holding the component the .vue file is
      this.nodes.push(buildFileNode(this.filePath, this.source, 'vue'));
      const componentNode = this.createComponentNode();
      this.edges.push({ source: `file:${this.filePath}`, target: componentNode.id, kind: 'contains' });

      // Extract and process script blocks
      const scriptBlocks = this.extractScriptBlocks();

      for (const block of scriptBlocks) {
        this.processScriptBlock(block, componentNode.id);
      }

      // Extract component usages from the <template> (<ComponentName>).
      // Without this, a Vue component used only in another component's
      // markup (incl. through a barrel import) is invisible to callers /
      // impact (#629 follow-up).
      this.extractTemplateComponents(componentNode.id);
      // Calls written in template expressions — `{{ useBar(link) }}`,
      // `:to="localePath(link.location)"`, `@click="save(item)"` (#2340).
      this.extractTemplateCalls(componentNode.id);
    } catch (error) {
      this.errors.push({
        message: `Vue extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Create a component node for the .vue file
   */
  private createComponentNode(): Node {
    const lines = this.source.split('\n');
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const componentName = fileName.replace(/\.vue$/, '');
    const id = generateNodeId(this.filePath, 'component', componentName, 1);

    const node: Node = {
      id,
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'vue',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      isExported: true, // Vue components are always importable
      updatedAt: Date.now(),
    };

    this.nodes.push(node);
    return node;
  }

  /**
   * Method nodes for an Options API component's members (see
   * ./vue-options-api), and the references and edges written inside each —
   * which the TS extractor attributed to the file — re-attributed to it.
   * Lines are block-relative here; the caller offsets them with the rest.
   */
  private addOptionsMembers(
    block: { content: string; startLine: number },
    result: ExtractionResult,
    componentNodeId: string
  ): void {
    const members = vueOptionsMembers(block.content);
    if (members.length === 0) return;
    const component = this.nodes.find((n) => n.id === componentNodeId);
    const owner = component?.name ?? 'component';
    const lineAt = (offset: number) => block.content.slice(0, offset).split('\n').length;
    const colAt = (offset: number) => offset - block.content.lastIndexOf('\n', offset - 1) - 1;
    const now = Date.now();
    const created: Node[] = [];
    for (const m of members) {
      const startLine = lineAt(m.start);
      const endLine = lineAt(m.end);
      created.push({
        id: generateNodeId(this.filePath, 'method', `${owner}.${m.name}`, startLine + block.startLine),
        kind: 'method',
        name: m.name,
        qualifiedName: `${owner}::${m.name}`,
        filePath: this.filePath,
        language: 'vue',
        startLine,
        endLine,
        startColumn: colAt(m.start),
        endColumn: colAt(m.end),
        updatedAt: now,
      });
    }
    // Innermost member for a line: `computed: { x: { get() {…} } }` is one member.
    const memberAt = (line: number): Node | undefined => {
      let best: Node | undefined;
      for (const n of created) {
        if (n.startLine <= line && n.endLine >= line && (!best || n.startLine >= best.startLine)) best = n;
      }
      return best;
    };
    // What the TS extractor attributed to the file (or to nothing narrower).
    const fileNode = result.nodes.find((n) => n.kind === 'file');
    const narrower = new Set(result.nodes.filter((n) => n.kind !== 'file').map((n) => n.id));
    const isFileLevel = (id: string) => (fileNode ? id === fileNode.id : !narrower.has(id));
    for (const ref of result.unresolvedReferences) {
      if (!isFileLevel(ref.fromNodeId)) continue;
      const member = memberAt(ref.line);
      if (member) ref.fromNodeId = member.id;
    }
    for (const edge of result.edges) {
      if (edge.kind === 'contains' || !edge.line || !isFileLevel(edge.source)) continue;
      const member = memberAt(edge.line);
      if (member) edge.source = member.id;
    }
    result.nodes.push(...created);
  }

  /**
   * Extract <script> and <script setup> blocks from the Vue source
   */
  private extractScriptBlocks(): Array<{
    content: string;
    startLine: number;
    isSetup: boolean;
    isTypeScript: boolean;
  }> {
    const blocks: Array<{
      content: string;
      startLine: number;
      isSetup: boolean;
      isTypeScript: boolean;
    }> = [];

    const scriptRegex = /<script(\s[^>]*)?>(?<content>[\s\S]*?)<\/script>/g;
    let match;

    while ((match = scriptRegex.exec(this.source)) !== null) {
      const attrs = match[1] || '';
      const content = match.groups?.content || match[2] || '';

      // Detect TypeScript from lang attribute
      const isTypeScript = /lang\s*=\s*["'](ts|typescript)["']/.test(attrs);

      // Detect <script setup>
      const isSetup = /\bsetup\b/.test(attrs);

      // Calculate the 0-indexed line where the content begins. The content
      // starts right after the opening tag's `>` — its leading `\n` is part
      // of the content, so relative line 1 sits ON the tag's closing line
      // (adding 1 here double-counted the embedded newline and shifted every
      // script-block symbol down a line).
      const beforeScript = this.source.substring(0, match.index);
      const scriptTagLine = (beforeScript.match(/\n/g) || []).length;
      const openingTag = match[0].substring(0, match[0].indexOf('>') + 1);
      const openingTagLines = (openingTag.match(/\n/g) || []).length;
      const contentStartLine = scriptTagLine + openingTagLines; // 0-indexed line

      blocks.push({
        content,
        startLine: contentStartLine,
        isSetup,
        isTypeScript,
      });
    }

    return blocks;
  }

  /**
   * Process a script block by delegating to TreeSitterExtractor
   */
  private processScriptBlock(
    block: { content: string; startLine: number; isSetup: boolean; isTypeScript: boolean },
    componentNodeId: string
  ): void {
    const scriptLanguage: Language = block.isTypeScript ? 'typescript' : 'javascript';

    // Check if the script language parser is available
    if (!isLanguageSupported(scriptLanguage)) {
      this.errors.push({
        message: `Parser for ${scriptLanguage} not available, cannot parse Vue script block`,
        severity: 'warning',
      });
      return;
    }

    // Delegate to TreeSitterExtractor
    const extractor = new TreeSitterExtractor(this.filePath, block.content, scriptLanguage);
    const result = extractor.extract();

    // An Options API component's functions — `methods`, `computed`, `watch`,
    // lifecycle hooks — are object-literal members the TS extractor leaves as
    // part of the file. Name each one, and hand it the calls written inside it.
    if (!block.isSetup) this.addOptionsMembers(block, result, componentNodeId);

    foldScriptResult(
      result,
      { filePath: this.filePath, componentNodeId, lineOffset: block.startLine, language: 'vue', perInstance: block.isSetup },
      { nodes: this.nodes, edges: this.edges, unresolvedReferences: this.unresolvedReferences, errors: this.errors }
    );
  }

  /**
   * Calls written in the template's expressions — interpolations and bound
   * attributes / directives — as `calls` references from the component (#2340).
   * A composable or helper used only in markup (`{{ useBar(link) }}`,
   * `:to="localePath(x)"`) otherwise had no caller at all. `$`-prefixed Vue
   * globals (`$t`, `$emit`) and string contents are skipped; a member chain
   * deeper than `obj.fn` names nothing a static resolver can follow.
   */
  private extractTemplateCalls(componentNodeId: string): void {
    // Blank <script>/<style> blocks and HTML comments, keeping offsets and lines.
    const blank = (m: string) => m.replace(/[^\n]/g, ' ');
    const text = this.source
      .replace(/<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g, blank)
      .replace(/<!--[\s\S]*?-->/g, blank);
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
    const position = (offset: number): { line: number; column: number } => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }
      return { line: lo + 1, column: offset - lineStarts[lo]! + 1 };
    };
    const scan = (expr: string, base: number): void => {
      // Blank string-literal contents so `'fmt(x)'` is not a call.
      const code = expr.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, blank);
      TEMPLATE_CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TEMPLATE_CALL_RE.exec(code))) {
        const name = m[1]!.replace(/\?\./g, '.');
        const parts = name.split('.');
        if (parts.length > 2 || name.startsWith('$') || TEMPLATE_NON_CALLS.has(parts[0]!)) continue;
        if (/\bnew\s+$/.test(code.slice(0, m.index))) continue;
        const { line, column } = position(base + m.index);
        this.unresolvedReferences.push({
          fromNodeId: componentNodeId,
          referenceName: name,
          referenceKind: 'calls',
          line,
          column,
          filePath: this.filePath,
          language: 'vue',
        });
      }
    };
    let m: RegExpExecArray | null;
    TEMPLATE_INTERPOLATION_RE.lastIndex = 0;
    while ((m = TEMPLATE_INTERPOLATION_RE.exec(text))) scan(m[1]!, m.index + 2);
    TEMPLATE_BOUND_ATTR_RE.lastIndex = 0;
    while ((m = TEMPLATE_BOUND_ATTR_RE.exec(text))) {
      const value = m[1] ?? m[2] ?? '';
      // The value sits just before the closing quote.
      scan(value, m.index + m[0].length - 1 - value.length);
    }
  }

  /**
   * Extract component usages from the Vue `<template>`.
   *
   * PascalCase tags (`<Modal>`, `<Button />`) and kebab-case tags
   * (`<my-button>`) both represent component instantiations — analogous to
   * function calls in imperative code. Capturing them creates parent→child
   * component edges and lets `callers` / `impact` see a component that is
   * only ever used in markup. Vue's extractor previously parsed only the
   * `<script>` block, so these usages produced no edge at all (#629).
   *
   * HTML elements (lowercase, no hyphen) and Vue built-ins are skipped.
   * Unmatched names create no edge during resolution, so converting
   * kebab-case is safe even for native custom elements.
   */
  private extractTemplateComponents(componentNodeId: string): void {
    // Ranges covered by <script> / <style> blocks — skip them so script
    // identifiers and CSS selectors aren't mistaken for template tags. This
    // also correctly handles nested <template> tags (v-if / slots), which a
    // single non-greedy <template>…</template> match would mis-bound.
    const coveredRanges: Array<[number, number]> = [];
    const blockRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
    let blockMatch;
    while ((blockMatch = blockRegex.exec(this.source)) !== null) {
      const startLine = (this.source.substring(0, blockMatch.index).match(/\n/g) || []).length;
      const endLine = startLine + (blockMatch[0].match(/\n/g) || []).length;
      coveredRanges.push([startLine, endLine]);
    }

    const lines = this.source.split('\n');
    // Opening / self-closing tags (closing `</Foo>` starts with `</`, so the
    // leading `<` followed by a name letter won't match it).
    const tagRegex = /<([A-Za-z][A-Za-z0-9_-]*)\b/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

      const line = lines[lineIdx]!;
      let match;
      while ((match = tagRegex.exec(line)) !== null) {
        const raw = match[1]!;
        let componentName: string;
        if (/^[A-Z]/.test(raw)) {
          componentName = raw; // PascalCase component
        } else if (raw.includes('-')) {
          componentName = kebabToPascal(raw); // kebab-case component
        } else {
          continue; // lowercase, no hyphen → native HTML element
        }
        if (VUE_BUILTIN_COMPONENTS.has(componentName)) continue;

        this.unresolvedReferences.push({
          fromNodeId: componentNodeId,
          referenceName: componentName,
          referenceKind: 'references',
          line: lineIdx + 1, // 1-indexed
          column: match.index + 1,
          filePath: this.filePath,
          language: 'vue',
        });
      }
    }
  }
}
