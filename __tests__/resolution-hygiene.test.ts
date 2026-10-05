/**
 * Cross-cutting resolution hygiene (plan §4.1): rules that one strategy or
 * one pass applied and its siblings skipped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { ReferenceResolver } from '../src/resolution';
import { SYNTH_PASSES } from '../src/resolution/callback-synthesizer';
import { applyAliases, loadProjectAliases } from '../src/resolution/path-aliases';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

let dir: string | undefined;
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  dir = undefined;
});

function project(files: Record<string, string>): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-res-hygiene-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

async function index(files: Record<string, string>): Promise<CodeGraph> {
  cg = CodeGraph.initSync(project(files));
  await cg.indexAll();
  return cg;
}

function callsFrom(graph: CodeGraph, file: string, name: string): string[] {
  const fn = graph.getNodesInFile(file).find((n) => n.name === name)!;
  return graph.getOutgoingEdges(fn.id).filter((e) => e.kind === 'calls')
    .map((e) => `${graph.getNode(e.target)!.filePath}:${graph.getNode(e.target)!.name}`);
}

describe('fuzzy matching applies the exact matcher\'s scope rules (R-RES2)', () => {
  it('does not hand a bare Lua call to a table\'s method', async () => {
    const graph = await index({
      'lib/m.lua': 'local M = {}\nfunction M.helper()\n  return 1\nend\nreturn M\n',
      'main.lua': 'local function run()\n  helper()\nend\nreturn run\n',
    });
    expect(callsFrom(graph, 'main.lua', 'run')).toEqual([]);
  });
});

describe('the TS/JS chain-shape path passes the name-match gates (R-RES4)', () => {
  const store = "import { create } from 'zustand';\nexport const useStore = create((set) => ({\n  count: 0,\n  reset: () => set({ count: 0 }),\n}));\n";

  it('does not link production code into a test suite\'s store', async () => {
    const graph = await index({
      'package.json': JSON.stringify({ dependencies: { zustand: '^4' } }),
      'src/app.ts': "import { useStore } from '../tests/store';\nexport function go() {\n  useStore.getState().reset();\n}\n",
      'tests/store.ts': store,
    });
    expect(callsFrom(graph, 'src/app.ts', 'go')).not.toContain('tests/store.ts:reset');
  });

  it('still resolves the chain to a production store', async () => {
    const graph = await index({
      'package.json': JSON.stringify({ dependencies: { zustand: '^4' } }),
      'src/app.ts': "import { useStore } from './store';\nexport function go() {\n  useStore.getState().reset();\n}\n",
      'src/store.ts': store,
    });
    expect(callsFrom(graph, 'src/app.ts', 'go')).toContain('src/store.ts:reset');
  });
});

describe('synthesis merge (R-RES3) and edge metadata (R-RES7)', () => {
  it('keeps two passes\' edges for one pair when their kinds differ', async () => {
    const fake = (name: string, kind: 'calls' | 'references'): (typeof SYNTH_PASSES)[number] => ({
      name, gate: () => true,
      run: async (q) => {
        const a = q.getNodesByName('alpha')[0]!;
        const b = q.getNodesByName('beta')[0]!;
        return [{ source: a.id, target: b.id, kind, line: a.startLine, provenance: 'heuristic',
          metadata: { synthesizedBy: name, registeredAt: `${a.filePath}:${a.startLine}` } }];
      },
    });
    const added = [fake('testPassCalls', 'calls'), fake('testPassRefs', 'references'), fake('testPassCallsAgain', 'calls')];
    SYNTH_PASSES.push(...added);
    try {
      const graph = await index({ 'src/a.ts': 'export function alpha() {}\nexport function beta() {}\n' });
      const alpha = graph.getNodesByName('alpha')[0]!;
      const synthesized = graph.getOutgoingEdges(alpha.id)
        .filter((e) => typeof e.metadata?.synthesizedBy === 'string' && String(e.metadata.synthesizedBy).startsWith('testPass'))
        .map((e) => `${e.kind}:${e.metadata!.synthesizedBy}`).sort();
      // The same pair and kind is still one edge, first pass wins.
      expect(synthesized).toEqual(['calls:testPassCalls', 'references:testPassRefs']);
    } finally {
      SYNTH_PASSES.splice(SYNTH_PASSES.length - added.length, added.length);
    }
  });

  it('says where a JSX child is rendered', async () => {
    const graph = await index({
      'src/Child.tsx': 'export function Child() {\n  return <div />;\n}\n',
      'src/App.tsx': "import { Child } from './Child';\nexport function App() {\n  const x = 1;\n  return (\n    <section>\n      <Child />\n    </section>\n  );\n}\n",
    });
    const app = graph.getNodesInFile('src/App.tsx').find((n) => n.name === 'App')!;
    const render = graph.getOutgoingEdges(app.id).find((e) => e.metadata?.synthesizedBy === 'jsx-render');
    expect(render?.provenance).toBe('heuristic');
    expect(render?.metadata?.registeredAt).toBe('src/App.tsx:6');
  });

  it('says where a Vue template renders a child component', async () => {
    const graph = await index({
      'src/components/ChildCard.vue': '<template>\n  <div />\n</template>\n<script setup lang="ts">\n</script>\n',
      'src/components/Parent.vue': '<template>\n  <main>\n    <ChildCard />\n  </main>\n</template>\n<script setup lang="ts">\nimport ChildCard from \'./ChildCard.vue\';\n</script>\n',
    });
    const parent = graph.getNodesInFile('src/components/Parent.vue').find((n) => n.kind === 'component')!;
    const render = graph.getOutgoingEdges(parent.id).find((e) => e.metadata?.synthesizedBy === 'jsx-render');
    expect(render?.metadata?.registeredAt).toBe('src/components/Parent.vue:3');
  });
});

describe('a client path leaves out an optional route parameter (R-RES10)', () => {
  it('pairs fetch(\'/api/users\') with GET /api/users/:id?', async () => {
    const graph = await index({
      'package.json': JSON.stringify({ dependencies: { express: '^4' } }),
      'server.js': "const express = require('express');\nconst app = express();\napp.get('/api/users/:id?', function listUsers(req, res) { res.json([]); });\napp.listen(3000);\n",
      'web/client.js': 'export async function loadUsers() {\n  return fetch(\'/api/users\');\n}\nexport async function loadUser(id) {\n  return fetch(`/api/users/${id}`);\n}\n',
    });
    const route = graph.getNodesByKind('route').find((n) => n.name === 'GET /api/users/:id?')!;
    expect(route).toBeDefined();
    for (const fn of ['loadUsers', 'loadUser']) {
      const node = graph.getNodesInFile('web/client.js').find((n) => n.name === fn)!;
      expect(graph.getOutgoingEdges(node.id).some((e) => e.target === route.id), fn).toBe(true);
    }
  });
});

describe('tsconfig path aliases (R-RES11)', () => {
  it('does not let a wildcard\'s prefix and suffix overlap', () => {
    const aliases = { baseUrl: '/repo', patterns: [{ prefix: 'a', suffix: 'a', hasWildcard: true, replacements: ['src/*'] }] };
    expect(applyAliases('a', aliases, '/repo')).toEqual([]);
    expect(applyAliases('aba', aliases, '/repo')).toEqual(['src/b']);
  });

  it('reads ${configDir} as the directory of the config being loaded', () => {
    const root = project({
      'configs/base.json': JSON.stringify({ compilerOptions: { baseUrl: '${configDir}', paths: { '@/*': ['${configDir}/src/*'] } } }),
      'tsconfig.json': JSON.stringify({ extends: './configs/base.json' }),
    });
    const aliases = loadProjectAliases(root)!;
    expect(aliases.baseUrl).toBe(path.resolve(root));
    expect(applyAliases('@/util', aliases, root)).toEqual(['src/util']);
  });
});

describe('edge kinds per target (R-RES13)', () => {
  it('promotes calls to instantiates only for the targets that are classes', async () => {
    const graph = await index({ 'src/a.py': 'class Widget:\n    pass\n\ndef make():\n    return 1\n\ndef go():\n    return make()\n' });
    const resolver = (graph as unknown as { resolver: ReferenceResolver }).resolver;
    const node = (name: string) => graph.getNodesByName(name)[0]!;
    const edges = resolver.createEdges([{
      original: { fromNodeId: node('go').id, referenceName: 'make', referenceKind: 'calls', line: 8, column: 11, filePath: 'src/a.py', language: 'python' },
      targetNodeId: node('make').id,
      alsoTargets: [{ targetNodeId: node('Widget').id }],
      confidence: 0.9,
      resolvedBy: 'framework',
    }]);
    expect(edges.map((e) => `${graph.getNode(e.target)!.name}:${e.kind}`)).toEqual(['make:calls', 'Widget:instantiates']);
  });
});

describe('getNodesByLowerName (R-RES14)', () => {
  it('returns same-named nodes in path order, whatever order they were stored in', () => {
    const root = project({});
    const connection = DatabaseConnection.initialize(path.join(root, 'test.db'));
    try {
      const queries = new QueryBuilder(connection.getDb());
      queries.insertNodes(['z', 'm', 'a'].map((p) => ({
        id: p, name: p === 'm' ? 'Helper' : 'helper', qualifiedName: 'helper', kind: 'function' as const, language: 'php' as const,
        filePath: `${p}.php`, startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 0,
      })));
      expect(queries.getNodesByLowerName('helper').map((n) => n.filePath)).toEqual(['a.php', 'm.php', 'z.php']);
    } finally {
      connection.close();
    }
  });
});
