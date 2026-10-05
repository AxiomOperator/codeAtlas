/**
 * Plan Phase 3 — 3.1 central argument coercion, 3.2 one error classifier,
 * 3.4 `codegraph_files` glob.
 *
 * The contract under test is the "errors teach abandonment" rule (AGENTS.md):
 * every recoverable condition — a malformed argument, an unknown or disabled
 * tool, a projectPath naming a file — answers SUCCESS-shaped with guidance;
 * only security refusals and genuine malfunctions carry `isError`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler, __setLoadCodeGraphForTests, coerceToolArgs, classifyError, ToolInputError, NotIndexedError, PathRefusalError } from '../src/mcp/tools';
import { compileFileGlob } from '../src/mcp/file-glob';
import { clamp, validateProjectPath } from '../src/utils';
import { isInitialized } from '../src/directory';

// In-process cross-project opens (an explicit projectPath) need the CodeGraph
// class injected — vitest can't service tools.ts's lazy require.
beforeAll(() => __setLoadCodeGraphForTests(CodeGraph));
afterAll(() => __setLoadCodeGraphForTests(null));


function text(res: { content: Array<{ text: string }> }): string {
  return res.content.map((c) => c.text).join('\n');
}

async function makeProject(root: string): Promise<CodeGraph> {
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'a.ts'),
    'export function alpha(): number { return beta(); }\nexport function beta(): number { return 1; }\n'
  );
  fs.writeFileSync(path.join(root, 'src', 'b.tsx'), 'export function Gamma() { return null; }\n');
  fs.writeFileSync(path.join(root, 'src', 'deep', 'c.ts'), 'export function delta() { return 2; }\n');
  fs.writeFileSync(path.join(root, 'foo.ts'), 'export function rootFoo() { return 3; }\n');
  const cg = await CodeGraph.init(root, { config: { include: ['**/*.ts', '**/*.tsx'], exclude: [] } });
  await cg.indexAll();
  return cg;
}

describe('clamp', () => {
  it('returns min for non-finite input', () => {
    expect(clamp(NaN, 1, 10)).toBe(1);
    expect(clamp(Infinity, 1, 10)).toBe(1);
    expect(clamp(-Infinity, 1, 10)).toBe(1);
    expect(clamp('max' as unknown as number, 1, 10)).toBe(1);
    expect(clamp(50, 1, 10)).toBe(10);
    expect(clamp(5, 1, 10)).toBe(5);
  });
});

describe('coerceToolArgs', () => {
  it('drops non-finite numbers so the handler default applies', () => {
    expect(coerceToolArgs('codegraph_impact', { symbol: 'x', depth: 'max' })).toEqual({ symbol: 'x' });
    expect(coerceToolArgs('codegraph_search', { query: 'x', limit: null })).toEqual({ query: 'x' });
    expect(coerceToolArgs('codegraph_explore', { query: 'x', maxFiles: Infinity })).toEqual({ query: 'x' });
    expect(coerceToolArgs('codegraph_explore', { query: 'x', maxFiles: {} })).toEqual({ query: 'x' });
  });

  it('converts numeric strings and boolean strings', () => {
    expect(coerceToolArgs('codegraph_search', { query: 'x', limit: ' 5 ' })).toEqual({ query: 'x', limit: 5 });
    expect(coerceToolArgs('codegraph_node', { symbol: 'x', includeCode: 'true' })).toEqual({ symbol: 'x', includeCode: true });
  });

  it('object-checks arguments: strings, arrays and null become {} (or parsed JSON)', () => {
    expect(coerceToolArgs('codegraph_search', 'not json')).toEqual({});
    expect(coerceToolArgs('codegraph_search', ['a'])).toEqual({});
    expect(coerceToolArgs('codegraph_search', null)).toEqual({});
    expect(coerceToolArgs('codegraph_search', '{"query":"alpha"}')).toEqual({ query: 'alpha' });
  });

  it('validates enums case-insensitively and rejects unknown values with ToolInputError', () => {
    expect(coerceToolArgs('codegraph_search', { query: 'x', kind: 'Function' })).toEqual({ query: 'x', kind: 'function' });
    expect(() => coerceToolArgs('codegraph_search', { query: 'x', kind: 'gizmo' })).toThrow(ToolInputError);
  });

  it('keeps unknown keys and never mutates the input', () => {
    const input = { query: 'x', limit: 'max', extra: 1 };
    const out = coerceToolArgs('codegraph_search', input);
    expect(out).toEqual({ query: 'x', extra: 1 });
    expect(input.limit).toBe('max');
  });
});

describe('classifyError', () => {
  it('classifies expected conditions success-shaped and the rest as errors', () => {
    expect(classifyError(new NotIndexedError('not indexed')).isError).toBeFalsy();
    const rebuild = new Error('a rebuild is running');
    rebuild.name = 'RebuildInProgressError';
    expect(classifyError(rebuild).isError).toBeFalsy();
    expect(classifyError(new ToolInputError('bad arg')).isError).toBeFalsy();

    const refusal = classifyError(new PathRefusalError('Refusing to operate on sensitive directory: /x'));
    expect(refusal.isError).toBe(true);
    expect(text(refusal)).not.toMatch(/retry/);

    const boom = classifyError(new Error('boom'));
    expect(boom.isError).toBe(true);
    expect(text(boom)).toMatch(/retry the call once/);
  });
});

describe('ToolHandler — coercion, guidance and projectPath', () => {
  let dir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-coerce-')));
    cg = await makeProject(dir);
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('depth: "max" on codegraph_impact is bounded and success-shaped', async () => {
    const res = await handler.execute('codegraph_impact', { symbol: 'beta', depth: 'max' });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/alpha|beta/);
  });

  it('limit: null is success-shaped', async () => {
    const res = await handler.execute('codegraph_search', { query: 'alpha', limit: null });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/alpha/);
  });

  it('maxFiles: "lots" on codegraph_explore finishes and is success-shaped', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'alpha beta', maxFiles: 'lots' });
    expect(res.isError).toBeFalsy();
  });

  it('arguments as a plain string is success-shaped guidance, not a TypeError', async () => {
    for (const tool of ['codegraph_explore', 'codegraph_search', 'codegraph_node']) {
      const res = await handler.execute(tool, 'alpha');
      expect(res.isError).toBeFalsy();
      expect(text(res)).not.toMatch(/Tool execution failed/);
    }
    const nullArgs = await handler.execute('codegraph_search', null);
    expect(nullArgs.isError).toBeFalsy();
    expect(text(nullArgs)).toMatch(/query must be a non-empty string/);
  });

  it('validation failures are success-shaped guidance (#1403)', async () => {
    const res = await handler.execute('codegraph_explore', { query: '' });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/query must be a non-empty string/);
    const kind = await handler.execute('codegraph_search', { query: 'alpha', kind: 'gizmo' });
    expect(kind.isError).toBeFalsy();
    expect(text(kind)).toMatch(/kind must be one of/);
  });

  it('an unknown tool is success-shaped and names the real tools', async () => {
    const res = await handler.execute('codegraph_explorer', { query: 'alpha' });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/unknown tool/);
    expect(text(res)).toMatch(/codegraph_explore/);
  });

  it('a disabled tool is success-shaped guidance', async () => {
    const prev = process.env.CODEGRAPH_MCP_TOOLS;
    process.env.CODEGRAPH_MCP_TOOLS = 'explore';
    try {
      const res = await handler.execute('codegraph_search', { query: 'alpha' });
      expect(res.isError).toBeFalsy();
      expect(text(res)).toMatch(/disabled via CODEGRAPH_MCP_TOOLS/);
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_MCP_TOOLS;
      else process.env.CODEGRAPH_MCP_TOOLS = prev;
    }
  });

  it('projectPath naming a FILE resolves from its parent directory', async () => {
    const other = new ToolHandler(null);
    try {
      const res = await other.execute('codegraph_search', {
        query: 'alpha',
        projectPath: path.join(dir, 'src', 'a.ts'),
      });
      expect(text(res)).not.toMatch(/not a directory/);
      expect(res.isError).toBeFalsy();
      expect(text(res)).toMatch(/alpha/);
    } finally {
      // Release the project it opened, or Windows can't delete the temp dir.
      await other.closeAll();
    }
  });
});

describe('codegraph_files glob', () => {
  let dir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-glob-')));
    cg = await makeProject(dir);
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const files = async (pattern: string): Promise<string> =>
    text(await handler.execute('codegraph_files', { pattern, format: 'flat', includeMetadata: false }));

  it('*.ts matches .ts files anywhere but not .tsx', async () => {
    const out = await files('*.ts');
    expect(out).toMatch(/src\/a\.ts/);
    expect(out).toMatch(/src\/deep\/c\.ts/);
    expect(out).toMatch(/- foo\.ts/);
    expect(out).not.toMatch(/b\.tsx/);
  });

  it('brace sets work', async () => {
    const out = await files('*.{ts,tsx}');
    expect(out).toMatch(/b\.tsx/);
    expect(out).toMatch(/a\.ts/);
  });

  it('**/foo.ts matches a root-level foo.ts', async () => {
    const out = await files('**/foo.ts');
    expect(out).toMatch(/- foo\.ts/);
    expect(out).not.toMatch(/a\.ts/);
  });

  it('a pattern with a slash is anchored to the project-relative path', async () => {
    const out = await files('src/*.ts');
    expect(out).toMatch(/src\/a\.ts/);
    expect(out).not.toMatch(/deep/);
  });

  it('an over-complex pattern is refused with success-shaped guidance', async () => {
    const res = await handler.execute('codegraph_files', { pattern: '*a*a*a*a*a*b' });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/wildcards/);
  });

  it('long **/ and interleaved-wildcard patterns finish fast (no ReDoS)', () => {
    const A = 'a'.repeat(250);
    const deep = `${(A + '/').repeat(20)}${A}c`;
    const patterns = ['**/'.repeat(1000) + 'x', '**/*a*a*/**/*a*a*/**/*a*a*b', '*a*a*b'];
    const start = Date.now();
    for (const p of patterns) {
      const m = compileFileGlob(p);
      expect(typeof m).toBe('function');
      expect((m as (s: string) => boolean)(deep)).toBe(false);
    }
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe('validateProjectPath — ~/.config', () => {
  // The suite's home sandbox points HOME at a throwaway dir, so ~/.config here
  // is a temp directory.
  const home = os.homedir();
  const created: string[] = [];
  const cgs: CodeGraph[] = [];

  afterEach(() => {
    for (const cg of cgs.splice(0)) cg.destroy();
    for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it.runIf(process.platform !== 'win32')('allows an indexed project under ~/.config (and paths inside it)', async () => {
    const proj = path.join(home, '.config', 'nvim-cg-test');
    created.push(proj);
    cgs.push(await makeProject(proj));
    expect(validateProjectPath(proj, { isIndexed: isInitialized })).toBeNull();
    // Without the predicate (CLI / viewer callers) the blanket refusal stands.
    expect(validateProjectPath(proj)).toMatch(/sensitive directory/);
    expect(validateProjectPath(path.join(proj, 'src'), { isIndexed: isInitialized })).toBeNull();

    const res = await new ToolHandler(null).execute('codegraph_search', { query: 'alpha', projectPath: proj });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/alpha/);
  });

  it.runIf(process.platform !== 'win32')('still refuses un-indexed ~/.config paths and credential dirs', async () => {
    const plain = path.join(home, '.config', 'plain-cg-test');
    fs.mkdirSync(plain, { recursive: true });
    created.push(plain);
    expect(validateProjectPath(plain, { isIndexed: isInitialized })).toMatch(/sensitive directory/);
    expect(validateProjectPath(path.join(home, '.config'), { isIndexed: isInitialized })).toMatch(/sensitive directory/);

    // An index inside ~/.ssh does NOT relax the refusal.
    const ssh = path.join(home, '.ssh', 'proj-cg-test');
    created.push(path.join(home, '.ssh'));
    cgs.push(await makeProject(ssh));
    expect(validateProjectPath(ssh, { isIndexed: isInitialized })).toMatch(/sensitive directory/);
    const res = await new ToolHandler(null).execute('codegraph_search', { query: 'alpha', projectPath: ssh });
    expect(res.isError).toBe(true);

    // And the system dirs stay refused.
    expect(validateProjectPath('/etc')).toMatch(/sensitive system directory/);
  });

  it('a pattern with no glob syntax is a substring match (agents pass name fragments)', async () => {
    const { compileFileGlob } = await import('../src/mcp/file-glob');
    const m = compileFileGlob('Button') as (p: string) => boolean;
    expect(m('src/components/PrimaryButton.tsx')).toBe(true);
    expect(m('src/components/Link.tsx')).toBe(false);
    const d = compileFileGlob('src/auth') as (p: string) => boolean;
    expect(d('src/auth/login.ts')).toBe(true);
  });
});
