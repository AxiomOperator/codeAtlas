/**
 * One builder makes the `file` node for both the tree-sitter extractor and
 * the single-file-component (Vue / Svelte / Astro) extractors.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { buildFileNode } from '../src/extraction/file-node';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import type { Language, Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const withoutTime = ({ updatedAt: _u, docstring: _d, ...rest }: Node) => rest;

describe('file node builder', () => {
  const cases: Array<[string, string, Language]> = [
    ['src/util.ts', 'export function f() {\n  return 1;\n}\n', 'typescript'],
    ['app/main.py', 'def f():\n    return 1\n', 'python'],
    ['pages/index.vue', '<template><div /></template>\n<script setup lang="ts">\nconst x = 1;\n</script>\n', 'vue'],
    ['src/App.svelte', '<script>\n  let n = 0;\n</script>\n<p>{n}</p>\n', 'svelte'],
    ['src/pages/a.astro', '---\nconst t = 1;\n---\n<p>{t}</p>\n', 'astro'],
  ];

  it.each(cases)('%s gets exactly the shared file node', (filePath, source, language) => {
    const r = extractFromSource(filePath, source);
    const files = r.nodes.filter((n) => n.kind === 'file');
    expect(files).toHaveLength(1);
    expect(withoutTime(files[0]!)).toEqual(withoutTime(buildFileNode(filePath, source, language)));
  });

  it('spans every line of the file', () => {
    const n = buildFileNode('a/b.ts', 'x\ny\nz', 'typescript');
    expect(n).toMatchObject({
      id: 'file:a/b.ts', kind: 'file', name: 'b.ts', qualifiedName: 'a/b.ts',
      startLine: 1, endLine: 3, startColumn: 0, endColumn: 0, isExported: false,
    });
  });
});
