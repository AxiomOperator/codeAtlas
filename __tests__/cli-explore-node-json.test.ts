/**
 * `--json` for the CLI's `explore` and `node` (#1280): the same answer as the
 * markdown, as data — and the structured payload never leaks to MCP clients.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { STRUCTURED_ARG, type ExploreJson, type NodeJson } from '../src/mcp/structured-output';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
let dir: string;
let cg: CodeGraph;
let handler: ToolHandler;

function cli(args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
    timeout: 60_000,
  });
}

function cliJson<T>(args: string[]): T {
  const run = cli([...args, '--json']);
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as T;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-json-'));
  fs.writeFileSync(path.join(dir, 'auth.ts'), [
    "import { saveSession } from './session';",
    'export function loginUser(name: string): string {',
    '  const token = issueToken(name);',
    '  saveSession(token);',
    '  return token;',
    '}',
    'export function issueToken(name: string): string {',
    "  return 'tok-' + name;",
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'session.ts'), [
    'const store: string[] = [];',
    'export function saveSession(token: string): void {',
    '  store.push(token);',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'app.ts'), [
    "import { loginUser } from './auth';",
    'export function main(): void {',
    "  loginUser('ada');",
    '}',
    'export class Widget { render(): void {} }',
    'export class Gadget { render(): void {} }',
    '',
  ].join('\n'));
  cg = await CodeGraph.init(dir, { index: false });
  await cg.indexAll();
  handler = new ToolHandler(cg);
});

afterAll(() => {
  try { cg.destroy(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('explore --json', () => {
  it('structures the flow, symbols and source blocks', () => {
    const out = cliJson<ExploreJson>(['explore', '-p', dir, 'main loginUser saveSession']);
    expect(out.schemaVersion).toBe(1);
    expect(out.command).toBe('explore');
    expect(out.query).toBe('main loginUser saveSession');
    expect(out.summary).toMatch(/^Found \d+ symbols? across \d+ files?\./);
    expect(out.namedSymbols.map((s) => s.name)).toEqual(expect.arrayContaining(['main', 'loginUser', 'saveSession']));
    expect(out.flow.map((s) => s.name)).toEqual(['main', 'loginUser', 'saveSession']);
    expect(out.flow[0]!.via).toBeNull();
    expect(out.flow[1]!.via).toBe('calls');
    expect(out.flow[0]).toMatchObject({ file: 'app.ts', kind: 'function', startLine: 2 });

    const paths = out.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['auth.ts', 'session.ts', 'app.ts']));
    const auth = out.files.find((f) => f.path === 'auth.ts')!;
    expect(auth.language).toBe('typescript');
    expect(auth.source).toContain('export function loginUser');
    expect(auth.ranges.length).toBeGreaterThan(0);
    expect(auth.symbols.find((s) => s.name === 'loginUser')).toMatchObject({ kind: 'function', startLine: 2, endLine: 6 });

    expect(Array.isArray(out.blastRadius)).toBe(true);
    expect(out.budget!.outputChars).toBeGreaterThan(0);
    expect(out.budget!.maxChars).toBeGreaterThanOrEqual(out.budget!.outputChars);
    expect(out.notices).toEqual([]);
  });

  it('matches the markdown answer: every file in the JSON is a section in the text', async () => {
    const md = (await handler.execute('codegraph_explore', { query: 'main loginUser saveSession' })).content[0]!.text;
    const json = (await handler.execute('codegraph_explore', { query: 'main loginUser saveSession' }, undefined, { structured: true }))
      ._cgStructured as ExploreJson;
    for (const f of json.files) {
      expect(md).toContain(`\`${f.path}\``);
      expect(md).toContain(f.source);
    }
    expect(md).toContain(json.summary);
  });

  it('prints guidance in `message` when nothing matches', () => {
    const out = cliJson<ExploreJson>(['explore', '-p', dir, 'zzzqqqnothing']);
    expect(out.command).toBe('explore');
    expect(out.files).toEqual([]);
    expect(typeof out.message).toBe('string');
  });
});

describe('node --json', () => {
  it('returns the symbol body with callers and callees', () => {
    const out = cliJson<NodeJson>(['node', '-p', dir, 'loginUser']);
    expect(out.command).toBe('node');
    expect(out.mode).toBe('symbol');
    expect(out.symbols).toHaveLength(1);
    const sym = out.symbols![0]!;
    expect(sym).toMatchObject({ name: 'loginUser', kind: 'function', file: 'auth.ts', startLine: 2, sourceKind: 'body' });
    expect(sym.source).toContain('saveSession(token)');
    expect(sym.callers.map((c) => c.name)).toContain('main');
    expect(sym.callees.map((c) => c.name)).toEqual(expect.arrayContaining(['issueToken', 'saveSession']));
  });

  it('returns every definition of an ambiguous name', () => {
    const out = cliJson<NodeJson>(['node', '-p', dir, 'render']);
    expect(out.mode).toBe('symbol');
    expect(out.symbols!.map((s) => s.qualifiedName).sort().join(',')).toMatch(/Gadget.*Widget/);
  });

  it('reports a missing symbol as not-found, not as an error', () => {
    const out = cliJson<NodeJson>(['node', '-p', dir, 'loginUsr']);
    expect(out.mode).toBe('not-found');
    expect(out.message).toMatch(/not found/);
    expect(out.suggestions).toContain('loginUser');
  });

  it('file mode returns the window, symbols and dependents', () => {
    const out = cliJson<NodeJson>(['node', '-p', dir, '-f', 'auth.ts', '--offset', '2', '--limit', '3']);
    expect(out.mode).toBe('file');
    expect(out.file).toMatchObject({ path: 'auth.ts', startLine: 2, endLine: 4, totalLines: 10 });
    expect(out.file!.source).toBe([
      'export function loginUser(name: string): string {',
      '  const token = issueToken(name);',
      '  saveSession(token);',
    ].join('\n'));
    expect(out.file!.dependents).toContain('app.ts');
    expect(out.file!.symbols.map((s) => s.name)).toEqual(['loginUser', 'issueToken']);
  });
});

describe('structured payload stays internal', () => {
  it('is stripped from every non-structured call, even when the wire asks for it', async () => {
    const r = await handler.execute('codegraph_explore', { query: 'loginUser', [STRUCTURED_ARG]: true });
    expect(r._cgStructured).toBeUndefined();
    const n = await handler.execute('codegraph_node', { symbol: 'loginUser', includeCode: true, [STRUCTURED_ARG]: true });
    expect(n._cgStructured).toBeUndefined();
    expect(Object.keys(r)).not.toContain('_cgStructured');
  });

  it('leaves the markdown byte-identical whether or not structure is built', async () => {
    const plain = await handler.execute('codegraph_explore', { query: 'main loginUser saveSession' });
    const structured = await handler.execute('codegraph_explore', { query: 'main loginUser saveSession' }, undefined, { structured: true });
    expect(structured.content[0]!.text).toBe(plain.content[0]!.text);
  });
});
