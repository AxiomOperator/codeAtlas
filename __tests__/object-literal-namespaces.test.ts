/**
 * Object-literal members outside `export const` (#2300): plain consts,
 * namespace objects hung off a member (`window.X = {…}`, `ns.mod = {…}`),
 * and objects built inside a module-scope IIFE — the shapes script-tag JS is
 * written in. Each member is a function node, and calls through the container
 * resolve to it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('object-literal members beyond export const (#2300)', () => {
  it('extracts members of plain consts, member-assigned objects and IIFE-scoped objects', () => {
    const files: Array<[string, string]> = [
      ['src/b_plain.ts', 'const objTsPlain = { tsPlainM() { return 1; }, tsPlainProp: () => 1 };'],
      ['src/d_plain.js', 'const objJsPlain = { jsPlainM() { return 1; }, jsPlainProp: () => 1 };'],
      [
        'src/e_iife.js',
        '(function () {\n  const objIife = { iifeM() { return 1; } };\n  window.WS = { wsM() { return objIife.iifeM(); } };\n})();',
      ],
    ];
    const fns = files.flatMap(([f, src]) =>
      extractFromSource(f, src).nodes.filter((n) => n.kind === 'function').map((n) => n.name)
    );
    expect(fns.sort()).toEqual(['iifeM', 'jsPlainM', 'jsPlainProp', 'tsPlainM', 'tsPlainProp', 'wsM']);
    const iife = extractFromSource(files[2]![0], files[2]![1]);
    expect(iife.nodes.find((n) => n.name === 'WS')?.kind).toBe('variable');
    expect(iife.nodes.find((n) => n.name === 'objIife')?.kind).toBe('constant');
  });

  it('leaves a data-only object (no function members) without member nodes', () => {
    const r = extractFromSource('cfg.js', 'const cfg = { a: 1, b: { c: [1, 2, 3] } };\nwindow.CFG = { x: 1 };');
    expect(r.nodes.filter((n) => n.kind !== 'file').map((n) => n.name)).toEqual(['cfg']);
  });

  it('keeps calls written in a data member attributed to the container', () => {
    const r = extractFromSource('m.ts', 'const api = { base: makeBase(), run() { return go(); } };');
    const api = r.nodes.find((n) => n.name === 'api')!;
    const run = r.nodes.find((n) => n.name === 'run')!;
    const from = (name: string) => r.unresolvedReferences.find((u) => u.referenceName === name)?.fromNodeId;
    expect(from('makeBase')).toBe(api.id);
    expect(from('go')).toBe(run.id);
  });

  describe('resolution', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-obj-ns-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('resolves calls through plain, window-hung and IIFE-scoped namespace objects', async () => {
      fs.mkdirSync(path.join(dir, 'public/js'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app"}');
      fs.writeFileSync(
        path.join(dir, 'public/js/app.js'),
        [
          'function helper() { return 1; }',
          'const store = { shorthand() { return helper(); } };',
          '(function () {',
          '  const objIife = { iifeM() { return 1; } };',
          '  window.WS = { wsM() { return objIife.iifeM(); } };',
          '})();',
          'window.api = { load() { return store.shorthand(); } };',
          'function boot() { api.load(); }',
          '',
        ].join('\n')
      );
      // Another script tag's file reaches the namespace through the global.
      fs.writeFileSync(
        path.join(dir, 'public/js/page.js'),
        'function page() { window.api.load(); }\nfunction page2() { api.load(); }\n'
      );
      const cg = await CodeGraph.init(dir, { silent: true });
      await cg.indexAll();
      const calleesOf = (name: string) => {
        const node = cg.getNodesByName(name).find((n) => n.kind === 'function')!;
        expect(node, name).toBeDefined();
        return cg.getCallees(node.id).map((c) => c.node.name).sort();
      };
      const shorthand = calleesOf('shorthand');
      const load = calleesOf('load');
      const wsM = calleesOf('wsM');
      const boot = calleesOf('boot');
      const page = calleesOf('page');
      const page2 = calleesOf('page2');
      const helperCallers = cg
        .getCallers(cg.getNodesByName('helper')[0]!.id)
        .map((c) => c.node.name);
      cg.close();
      expect(shorthand).toEqual(['helper']);
      expect(load).toEqual(['shorthand']);
      expect(wsM).toContain('iifeM');
      expect(boot).toEqual(['load']);
      expect(page).toEqual(['load']);
      expect(page2).toEqual(['load']);
      // The member, not the enclosing constant, is the caller.
      expect(helperCallers).toEqual(['shorthand']);
    });
  });
});
