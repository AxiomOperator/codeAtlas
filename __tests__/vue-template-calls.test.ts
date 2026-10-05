/**
 * Vue/TS callers that had no edge (#2340): calls inside template expressions
 * (interpolations, bound attributes, event handlers) and top-level
 * destructuring declarations (`const { a } = useFoo(1)`) in `<script setup>`
 * and plain modules. Plus R-RES8: the template-handler synthesis reads EVERY
 * script block, so a `<script>` + `<script setup>` SFC's destructured
 * composable handler resolves.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('Vue template-expression and destructuring callers (#2340)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vue-calls-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it('finds every caller of an auto-imported composable', async () => {
    write('package.json', '{"name":"app"}');
    write('composables/useFoo.ts', 'export function useFoo(n: number) {\n  return { a: n }\n}\n');
    write('composables/useBar.ts', 'export function useBar(x: unknown) {\n  return String(x)\n}\n');
    write('utils/fmt.ts', 'export function formatLink(x: unknown) {\n  return String(x)\n}\n');
    write('components/A.vue', '<script setup lang="ts">\nconst { a } = useFoo(1)\n</script>\n<template><div>{{ a }}</div></template>\n');
    write('components/F.vue', '<script setup lang="ts">\nconst [b] = useFoo(1)\n</script>\n');
    write('components/B.vue', '<script setup lang="ts">\nconst x = useFoo(1)\n</script>\n');
    write('components/H.vue', '<template><div>{{ useBar(link) }}</div></template>\n');
    write(
      'components/I.vue',
      [
        '<template>',
        '  <NuxtLink :to="formatLink(link.location)" @click="track(\'x(y)\')">',
        '    <!-- {{ commented(out) }} -->',
        '    {{ $t(\'title\') }}',
        '  </NuxtLink>',
        '</template>',
        '<script setup lang="ts">',
        'function track(name: string) { return name }',
        '</script>',
        '',
      ].join('\n')
    );
    write('src/G.ts', 'const { a } = useFoo(1)\nexport const g = a\n');
    write('src/D.ts', 'export function probe() { const { a } = useFoo(1); return a }\n');

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const callersOf = (name: string) => {
      const node = cg.getNodesByName(name).find((n) => n.kind === 'function')!;
      return cg
        .getCallers(node.id)
        .map((c) => c.node.name)
        .sort();
    };
    const useFoo = callersOf('useFoo');
    const useBar = callersOf('useBar');
    const formatLink = callersOf('formatLink');
    const track = callersOf('track');
    const i = cg.getNodesByName('I').find((n) => n.kind === 'component')!;
    const iRefs = cg.getCallees(i.id).map((c) => c.node.name);
    cg.close();

    // A/F/B are components; G is a module-level destructure (the file); D a function.
    expect(useFoo).toEqual(expect.arrayContaining(['A', 'B', 'F', 'probe']));
    expect(useFoo.some((n) => n === 'G.ts' || n === 'g')).toBe(true);
    expect(useBar).toEqual(['H']);
    expect(formatLink).toEqual(['I']);
    expect(track).toContain('I');
    // Nothing from the comment or the string literal.
    expect(iRefs).not.toContain('commented');
    expect(iRefs).not.toContain('y');
  });

  it('resolves a destructured composable handler declared in a second <script setup> block (R-RES8)', async () => {
    write('package.json', '{"name":"app"}');
    write(
      'composables/useSidebarControl.ts',
      'export function useSidebarControl() {\n  function close() { return 1 }\n  return { close }\n}\n'
    );
    write(
      'components/Side.vue',
      [
        '<script lang="ts">',
        'export default { name: "Side" }',
        '</script>',
        '<script setup lang="ts">',
        'const { close: closeSidebar } = useSidebarControl()',
        '</script>',
        '<template><button @click="closeSidebar">x</button></template>',
        '',
      ].join('\n')
    );
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const side = cg.getNodesByName('Side').find((n) => n.kind === 'component')!;
    const callees = cg.getCallees(side.id).map((c) => c.node.name);
    cg.close();
    expect(callees).toContain('close');
  });
});
