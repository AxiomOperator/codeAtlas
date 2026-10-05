/**
 * One symbol-name derivation for codegraph_node, callers/callees/impact and the
 * CLI (`lookupSymbolNodes` in src/graph/symbol-lookup.ts).
 *
 * - A partial or mistyped bare name must never render the top fuzzy hit's body
 *   as if it were the requested symbol (#1473, #1455). It comes back
 *   success-shaped with clearly-labelled "did you mean" suggestions.
 * - Exact names (incl. overloads) and exact file basenames still resolve.
 * - A qualified name resolves through the uncapped exact-name index, so a
 *   method named like 60 others (tokio `Harness::poll`) is never lost below an
 *   FTS result cut.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { lookupSymbolNodes } from '../src/graph/symbol-lookup';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function runCli(args: string[], cwd: string): string {
  try {
    return execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_TELEMETRY: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    return (err as { stdout?: string }).stdout ?? '';
  }
}

const POLL_DEFS = 60;

describe('symbol lookup — no silent fuzzy answers, uncapped qualified lookup', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-nofuzzy-node-'));
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'tasks'), { recursive: true });

    // 60 same-named `poll` methods across 60 classes, then the one we want.
    for (let i = 0; i < POLL_DEFS; i++) {
      fs.writeFileSync(
        path.join(src, 'tasks', `task${i}.ts`),
        `export class HarnessTask${i} {\n  poll(): number { return ${i}; }\n}\n`,
      );
    }
    fs.writeFileSync(
      path.join(src, 'driver.ts'),
      `export class Harness {\n  poll(): string {\n    return 'harness-poll-body';\n  }\n}\n` +
      `export function driveHarness(h: Harness) { return h.poll(); }\n`,
    );

    // A bare name with a near-miss sibling and overloads.
    fs.writeFileSync(
      path.join(src, 'parser.ts'),
      `export function parseTokenStream(input: string) {\n  return 'token-stream-body:' + input;\n}\n` +
      `export function runParser() { return parseTokenStream('x'); }\n`,
    );
    fs.writeFileSync(
      path.join(src, 'shapes.ts'),
      `export class Circle {\n  area(): number { return 1; }\n}\n` +
      `export class Square {\n  area(): number { return 2; }\n}\n`,
    );
    fs.writeFileSync(path.join(src, 'product-card.ts'), `export const productCardMarker = 1;\n`);

    cg = CodeGraph.initSync(root, { config: { include: ['src/**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    handler?.closeAll();
    cg?.close();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  async function call(tool: string, args: Record<string, unknown>) {
    const res = await handler.execute(tool, args);
    return { text: res.content?.[0]?.text ?? '', isError: res.isError === true };
  }

  it('codegraph_node: a prefix of a real name renders no body, offers suggestions, not isError', async () => {
    const { text, isError } = await call('codegraph_node', { symbol: 'parseToken', includeCode: true });
    expect(isError).toBe(false);
    expect(text).toMatch(/Symbol "parseToken" not found/);
    expect(text).toMatch(/Did you mean:.*parseTokenStream/);
    expect(text).toMatch(/suggestions, not answers/);
    expect(text).not.toContain('token-stream-body');
    expect(text).not.toMatch(/use Read/i);
  });

  it('codegraph_node: a mistyped name renders no body', async () => {
    const { text, isError } = await call('codegraph_node', { symbol: 'parseTokenStrem', includeCode: true });
    expect(isError).toBe(false);
    expect(text).toMatch(/not found/);
    expect(text).not.toContain('token-stream-body');
  });

  it('codegraph_node: exact name still renders its body', async () => {
    const { text } = await call('codegraph_node', { symbol: 'parseTokenStream', includeCode: true });
    expect(text).toContain('token-stream-body');
    expect(text).not.toMatch(/not found/);
  });

  it('codegraph_node: overloads still render every definition', async () => {
    const { text } = await call('codegraph_node', { symbol: 'area', includeCode: true });
    expect(text).toMatch(/2 definitions named "area"/);
    expect(text).toContain('return 1;');
    expect(text).toContain('return 2;');
  });

  it('codegraph_node: exact file basename still resolves, a partial basename does not', async () => {
    expect(lookupSymbolNodes(cg, 'product-card').nodes.map((n) => n.kind)).toEqual(['file']);
    expect(lookupSymbolNodes(cg, 'product-car').nodes).toEqual([]);
  });

  it(`qualified name resolves among ${POLL_DEFS}+ same-named definitions`, async () => {
    expect(cg.getNodesByName('poll').length).toBeGreaterThan(50);
    const { nodes } = lookupSymbolNodes(cg, 'Harness.poll');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.filePath).toBe('src/driver.ts');

    const { text } = await call('codegraph_node', { symbol: 'Harness.poll', includeCode: true });
    expect(text).toContain('harness-poll-body');

    const callers = await call('codegraph_callers', { symbol: 'Harness.poll' });
    expect(callers.text).toContain('driveHarness');
  });

  it('qualified resolution rides the exact-name index, not FTS ranking', () => {
    // A host whose FTS returns nothing (or a capped, mis-ranked page): the
    // answer must not depend on it.
    const host = {
      getNodesByName: (n: string) => cg.getNodesByName(n),
      getNodesByNamePrefix: (p: string, l?: number) => cg.getNodesByNamePrefix(p, l),
      searchNodes: () => [],
      generatedFilePredicate: (paths: string[]) => cg.generatedFilePredicate(paths),
    };
    for (const q of ['Harness.poll', 'Harness::poll', 'HarnessTask42.poll']) {
      const { nodes } = lookupSymbolNodes(host, q);
      expect(nodes, q).toHaveLength(1);
    }
    expect(lookupSymbolNodes(host, 'Harness::poll').nodes[0]!.filePath).toBe('src/driver.ts');
  });

  it('a wrong-case qualifier is not found, and the real spelling is suggested (#1455)', () => {
    const res = lookupSymbolNodes(cg, 'harness.poll');
    expect(res.nodes).toEqual([]);
    expect(res.suggestions[0]).toBe('Harness.poll');
  });

  it('CLI and MCP agree: node not-found text, and callers of a qualified name', async () => {
    if (!fs.existsSync(BIN)) return;
    cg.close();
    try {
      const cliNode = runCli(['node', 'parseToken'], root);
      const cg2 = await CodeGraph.open(root);
      const mcp = new ToolHandler(cg2);
      const mcpNode = (await mcp.execute('codegraph_node', { symbol: 'parseToken', includeCode: true }))
        .content[0]!.text;
      expect(cliNode.trim()).toBe(mcpNode.trim());

      const cliCallers = runCli(['callers', 'Harness.poll', '--json'], root);
      expect(cliCallers).toContain('driveHarness');
      const cliMissing = runCli(['callers', 'parseToken', '--json'], root);
      expect(cliMissing).toMatch(/Symbol "parseToken" not found — did you mean: .*parseTokenStream/);
      mcp.closeAll();
      cg2.close();
    } finally {
      cg = await CodeGraph.open(root);
      handler = new ToolHandler(cg);
    }
  });
});
