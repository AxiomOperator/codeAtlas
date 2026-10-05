/**
 * `maxChars` on codegraph_explore / `--max-chars` on the CLI (#1282, #1701):
 * a character cap that can only LOWER the tier's budget, never raise it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';
import {
  EXPLORE_MIN_CHAR_CAP,
  applyExploreCharCap,
  exploreCharCap,
  exploreTierCeiling,
  getExploreOutputBudget,
} from '../src/mcp/explore-budget';
import { coerceToolArgs } from '../src/mcp/tool-args';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

describe('exploreCharCap', () => {
  const tiers = [100, 400, 2000, 10000, 30000].map((n) => getExploreOutputBudget(n));

  it('ignores absent, non-finite and non-positive values', () => {
    for (const b of tiers) {
      for (const raw of [undefined, null, NaN, Infinity, 0, -5, '5000']) {
        expect(exploreCharCap(raw, b)).toBeNull();
      }
    }
  });

  it('never raises a tier: a cap at or above the tier ceiling is a no-op', () => {
    for (const b of tiers) {
      const ceiling = exploreTierCeiling(b);
      expect(exploreCharCap(ceiling, b)).toBeNull();
      expect(exploreCharCap(ceiling + 10_000, b)).toBeNull();
      expect(exploreCharCap(1_000_000, b)).toBeNull();
    }
  });

  it('floors tiny values at the minimum', () => {
    for (const b of tiers) expect(exploreCharCap(10, b)).toBe(EXPLORE_MIN_CHAR_CAP);
  });

  it('lowers the budget and per-file cap without raising either', () => {
    for (const b of tiers) {
      const capped = applyExploreCharCap(b, 5000);
      expect(capped.maxOutputChars).toBe(Math.min(b.maxOutputChars, 5000));
      expect(capped.maxCharsPerFile).toBeLessThanOrEqual(b.maxCharsPerFile);
      expect(capped.maxCharsPerFile).toBeLessThanOrEqual(5000);
      const loose = applyExploreCharCap(b, 1_000_000);
      expect(loose.maxOutputChars).toBe(b.maxOutputChars);
      expect(loose.maxCharsPerFile).toBe(b.maxCharsPerFile);
    }
  });

  it('leaves the tier table itself monotonic', () => {
    let prev = 0;
    for (const b of tiers) {
      expect(b.maxCharsPerFile).toBeGreaterThanOrEqual(prev);
      prev = b.maxCharsPerFile;
    }
  });
});

describe('codegraph_explore maxChars', () => {
  let dir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-max-chars-'));
    // A handful of files with sizable bodies so the default answer is large.
    for (let f = 0; f < 6; f++) {
      const fns: string[] = [];
      for (let i = 0; i < 8; i++) {
        const body = Array.from({ length: 12 }, (_, k) => `  const v${k} = input * ${k + i} + ${f}; // step ${k} of handler${f}_${i}`).join('\n');
        const next = i < 7 ? `handler${f}_${i + 1}(input)` : f < 5 ? `handler${f + 1}_0(input)` : '0';
        fns.push(`export function handler${f}_${i}(input: number): number {\n${body}\n  return ${next};\n}`);
      }
      const imports = f < 5 ? `import { handler${f + 1}_0 } from './mod${f + 1}';\n` : '';
      fs.writeFileSync(path.join(dir, `mod${f}.ts`), imports + fns.join('\n\n') + '\n');
    }
    cg = await CodeGraph.init(dir, { index: false });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    try { cg.destroy(); } catch { /* closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const query = 'handler0_0 handler1_0 handler2_0 handler3_0 handler4_0 handler5_0';

  it('is declared in the tool schema as an optional number', () => {
    const explore = tools.find((t) => t.name === 'codegraph_explore')!;
    const props = (explore.inputSchema as { properties: Record<string, { type: string }>; required: string[] });
    expect(props.properties.maxChars?.type).toBe('number');
    expect(props.required).not.toContain('maxChars');
    expect(coerceToolArgs('codegraph_explore', { query: 'x', maxChars: '4000' }).maxChars).toBe(4000);
    expect('maxChars' in coerceToolArgs('codegraph_explore', { query: 'x', maxChars: 'lots' })).toBe(false);
  });

  it('caps the response at the requested size and still answers', async () => {
    const full = await handler.execute('codegraph_explore', { query });
    const fullText = full.content[0]!.text;
    expect(fullText.length).toBeGreaterThan(4000);

    const capped = await handler.execute('codegraph_explore', { query, maxChars: 4000 });
    const cappedText = capped.content[0]!.text;
    expect(capped.isError).toBeFalsy();
    expect(cappedText.length).toBeLessThanOrEqual(4000);
    expect(cappedText).toContain('```');
    expect(cappedText).not.toMatch(/use Read/i);
  });

  it('a cap above the tier ceiling changes nothing', async () => {
    const a = await handler.execute('codegraph_explore', { query });
    const b = await handler.execute('codegraph_explore', { query, maxChars: 1_000_000 });
    expect(b.content[0]!.text).toBe(a.content[0]!.text);
  });

  it('the CLI --max-chars flag caps the output too', () => {
    const run = spawnSync(process.execPath, [BIN, 'explore', '-p', dir, '--max-chars', '3000', query], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
      timeout: 60_000,
    });
    expect(run.status, run.stderr).toBe(0);
    // console.log adds the trailing newline.
    expect(run.stdout.trimEnd().length).toBeLessThanOrEqual(3000);
  });
});
