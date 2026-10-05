/**
 * #2342 — codegraph_explore must surface COBOL include / copybook targets.
 *
 * `EXEC SQL INCLUDE <copybook>` (and COPY, CICS LINK/XCTL) targets are indexed
 * as `import`-kind nodes, which explore's candidate channels exclude because a
 * JS/TS/Python import statement carries no information. For COBOL the import
 * node IS the target, so an exact name in the query admits it (with the
 * paragraph that holds it) — while ordinary imports stay out of explore.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('codegraph_explore — COBOL include targets (#2342)', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2342-'));
    // The issue's minimal repro.
    fs.writeFileSync(
      path.join(root, 'TESTPROG.cbl'),
      [
        '       IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '       PROCEDURE DIVISION.',
        '       UP-INCLUDE-COPYBOOK SECTION.',
        '       UP-INCLUDE-COPYBOOK-10.',
        '           EXEC SQL INCLUDE MYCOPYBOOK END-EXEC.',
        '',
      ].join('\n'),
    );
    // A long program whose include sits deep inside one paragraph, far from
    // the top of the file, so the render must anchor on it.
    const lines = [
      '       IDENTIFICATION DIVISION.',
      '       PROGRAM-ID. BIGPROG.',
      '       PROCEDURE DIVISION.',
    ];
    for (let i = 1; i <= 150; i++) {
      lines.push(`       PARA-${i}.`, `           DISPLAY 'STEP ${i}'.`, `           MOVE ${i} TO WS-COUNT.`, `           PERFORM PARA-${i + 1}.`);
      if (i === 90) lines.push('           EXEC SQL INCLUDE DEEPBOOK END-EXEC.');
    }
    lines.push('       PARA-151.', '           STOP RUN.', '');
    fs.writeFileSync(path.join(root, 'BIGPROG.cbl'), lines.join('\n'));

    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    handler?.closeAll();
    cg?.destroy();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  async function explore(query: string): Promise<string> {
    const res = await handler.execute('codegraph_explore', { query });
    expect(res.isError).not.toBe(true);
    return res.content?.[0]?.text ?? '';
  }

  it('the copybook is indexed as an import node (precondition)', () => {
    const nodes = cg.getNodesByName('MYCOPYBOOK');
    expect(nodes.some((n) => n.kind === 'import' && n.language === 'cobol')).toBe(true);
  });

  it('explore surfaces the issue repro by exact copybook name', async () => {
    const out = await explore('MYCOPYBOOK');
    expect(out).not.toMatch(/No relevant code found/);
    expect(out).toMatch(/EXEC SQL INCLUDE MYCOPYBOOK END-EXEC/);
  });

  it('explore renders an include deep inside a large program', async () => {
    const out = await explore('DEEPBOOK');
    expect(out).toMatch(/\d+\t\s+EXEC SQL INCLUDE DEEPBOOK END-EXEC\./);
    expect(out).toContain('PARA-90');
  });

  it('a partial copybook name is not an exact match', async () => {
    const sub = await cg.findRelevantContext('MYCOPY', { searchLimit: 8, traversalDepth: 3, maxNodes: 200, minScore: 0.2 });
    expect([...sub.nodes.values()].some((n) => n.kind === 'import')).toBe(false);
  });
});

describe('codegraph_explore — JS/TS imports stay out (#2342 guard)', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2342-ts-'));
    const src = path.join(root, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, 'server.ts'),
      `import express from 'express';\nimport { lodashThing } from 'lodash';\n\n` +
      `export function startServer() {\n  const app = express();\n  return lodashThing(app);\n}\n`,
    );
    cg = CodeGraph.initSync(root, { config: { include: ['src/**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    handler?.closeAll();
    cg?.destroy();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('an exactly-named JS/TS import never becomes an explore candidate', async () => {
    expect(cg.getNodesByName('lodashThing').some((n) => n.kind === 'import')
      || cg.getNodesByName('lodash').some((n) => n.kind === 'import')).toBe(true);
    for (const q of ['lodashThing', 'lodash', 'express startServer']) {
      const sub = await cg.findRelevantContext(q, { searchLimit: 8, traversalDepth: 3, maxNodes: 200, minScore: 0.2 });
      expect([...sub.nodes.values()].filter((n) => n.kind === 'import').map((n) => n.name), q).toEqual([]);
    }
    const res = await handler.execute('codegraph_explore', { query: 'express startServer' });
    expect(res.content?.[0]?.text ?? '').not.toMatch(/\(import\)/);
  });
});
