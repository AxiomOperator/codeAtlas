/**
 * Bare tool names for clients that prefix tools with the server key (#1267),
 * and project-level `.codegraph/instructions.md` appended to the initialize
 * instructions (#765).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import CodeGraph from '../src/index';
import { MCPSession } from '../src/mcp/session';
import type { MCPEngine } from '../src/mcp/engine';
import type { JsonRpcTransport, JsonRpcRequest, JsonRpcNotification } from '../src/mcp/transport';
import { canonicalToolName, presentToolNames, useBareToolNames } from '../src/mcp/tool-names';
import { tools } from '../src/mcp/tools';
import {
  SERVER_INSTRUCTIONS,
  PROJECT_INSTRUCTIONS_MAX_BYTES,
  readProjectInstructions,
  withProjectInstructions,
} from '../src/mcp/server-instructions';

const KNOWN = tools.map((t) => t.name);

describe('tool-name prefix mode (#1267)', () => {
  const original = process.env.CODEGRAPH_TOOL_PREFIX;
  afterEach(() => {
    if (original === undefined) delete process.env.CODEGRAPH_TOOL_PREFIX;
    else process.env.CODEGRAPH_TOOL_PREFIX = original;
  });

  it('keeps the codegraph_ names by default', () => {
    expect(useBareToolNames({})).toBe(false);
    expect(presentToolNames([{ name: 'codegraph_explore' }], {})).toEqual([{ name: 'codegraph_explore' }]);
  });

  it('advertises bare names with CODEGRAPH_TOOL_PREFIX=none', () => {
    const env = { CODEGRAPH_TOOL_PREFIX: 'none' };
    expect(useBareToolNames(env)).toBe(true);
    expect(presentToolNames([{ name: 'codegraph_explore', x: 1 }, { name: 'other' }], env)).toEqual([{ name: 'explore', x: 1 }, { name: 'other' }]);
  });

  it('maps every spelling back to the canonical name; unknown names pass through', () => {
    expect(canonicalToolName('codegraph_explore', KNOWN)).toBe('codegraph_explore');
    expect(canonicalToolName('explore', KNOWN)).toBe('codegraph_explore');
    expect(canonicalToolName('codegraph_codegraph_explore', KNOWN)).toBe('codegraph_explore');
    expect(canonicalToolName('nope', KNOWN)).toBe('nope');
  });

  function fakeTransport(): JsonRpcTransport & { deliver: (m: JsonRpcRequest) => Promise<void>; results: unknown[]; errors: unknown[] } {
    let handle: ((m: JsonRpcRequest | JsonRpcNotification) => Promise<void>) | null = null;
    const results: unknown[] = [];
    const errors: unknown[] = [];
    return {
      start(h) { handle = h as typeof handle; },
      stop() { /* */ },
      send() { /* */ },
      notify() { /* */ },
      async request() { return {}; },
      sendResult(_id, result) { results.push(result); },
      sendError(_id, _code, message) { errors.push(message); },
      results,
      errors,
      async deliver(m: JsonRpcRequest) { await handle?.(m); },
    };
  }

  function sessionWith(executed: string[]) {
    const handler = {
      getTools: () => tools.filter((t) => t.name === 'codegraph_explore'),
      execute: async (name: string) => {
        executed.push(name);
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    };
    const engine = {
      ensureInitialized: async () => { /* */ },
      hasDefaultCodeGraph: () => true,
      getProjectPath: () => '/repo',
      retryInitializeSync: () => { /* */ },
      getToolHandler: () => handler,
    } as unknown as MCPEngine;
    const transport = fakeTransport();
    new MCPSession(transport, engine).start();
    return transport;
  }

  it('session: tools/list shows bare names in bare mode, and tools/call accepts both spellings in any mode', async () => {
    const executed: string[] = [];
    process.env.CODEGRAPH_TOOL_PREFIX = 'none';
    const t = sessionWith(executed);
    await t.deliver({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((t.results[0] as { tools: Array<{ name: string }> }).tools.map((x) => x.name)).toEqual(['explore']);

    delete process.env.CODEGRAPH_TOOL_PREFIX;
    await t.deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((t.results[1] as { tools: Array<{ name: string }> }).tools.map((x) => x.name)).toEqual(['codegraph_explore']);

    for (const name of ['explore', 'codegraph_explore', 'codegraph_codegraph_explore']) {
      await t.deliver({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: { query: 'q' } } });
    }
    expect(executed).toEqual(['codegraph_explore', 'codegraph_explore', 'codegraph_explore']);
    await t.deliver({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bogus', arguments: {} } });
    // An unknown name is no protocol error: the handler answers it with
    // success-shaped guidance (an isError/JSON-RPC error teaches abandonment).
    expect(t.errors).toEqual([]);
    expect(executed.at(-1)).toBe('bogus');
  });

  it('server instructions keep naming codegraph_explore (what a prefixing client shows)', () => {
    expect(SERVER_INSTRUCTIONS).toContain('codegraph_explore');
  });
});

describe('project instructions (.codegraph/instructions.md, #765)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-proj-instr-'));
    fs.mkdirSync(path.join(root, '.codegraph'));
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const file = () => path.join(root, '.codegraph', 'instructions.md');

  it('returns the base unchanged without a file (or without a root)', () => {
    expect(withProjectInstructions('BASE', root)).toBe('BASE');
    expect(withProjectInstructions('BASE', null)).toBe('BASE');
    fs.writeFileSync(file(), '   \n');
    expect(withProjectInstructions('BASE', root)).toBe('BASE');
  });

  it('appends (never replaces) the project notes under their own heading', () => {
    fs.writeFileSync(file(), 'Edges between same-named Swift and TS symbols are name-matched; confirm them.\n');
    const out = withProjectInstructions(SERVER_INSTRUCTIONS, root);
    expect(out.startsWith(SERVER_INSTRUCTIONS)).toBe(true);
    expect(out).toContain('## Project notes (from .codegraph/instructions.md)');
    expect(out).toContain('confirm them.');
  });

  it('caps the notes at 4 KB and says so', () => {
    fs.writeFileSync(file(), 'é'.repeat(PROJECT_INSTRUCTIONS_MAX_BYTES)); // 2 bytes each → cut mid-file
    const notes = readProjectInstructions(root)!;
    expect(Buffer.byteLength(notes.split('\n\n[…truncated')[0]!, 'utf8')).toBeLessThanOrEqual(PROJECT_INSTRUCTIONS_MAX_BYTES);
    expect(notes).not.toContain('�');
    expect(notes).toMatch(/truncated: \.codegraph\/instructions\.md exceeds 4096 bytes/);
  });

  it('the initialize handshake carries the notes for an indexed project', async () => {
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-proj-init-')));
    try {
      fs.writeFileSync(path.join(proj, 'a.ts'), 'export const a = 1;\n');
      const cg = await CodeGraph.init(proj, { silent: true });
      cg.destroy();
      fs.writeFileSync(path.join(proj, '.codegraph', 'instructions.md'), 'PROJECT-NOTE-XYZ');
      const results: unknown[] = [];
      let handle: ((m: JsonRpcRequest) => Promise<void>) | null = null;
      const transport = {
        start(h: typeof handle) { handle = h; }, stop() {}, send() {}, notify() {},
        async request() { return {}; },
        sendResult(_id: unknown, r: unknown) { results.push(r); }, sendError() {},
      } as unknown as JsonRpcTransport;
      const engine = { ensureInitialized: async () => {} } as unknown as MCPEngine;
      new MCPSession(transport, engine).start();
      await handle!({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: pathToFileURL(proj).href } });
      const instructions = (results[0] as { instructions: string }).instructions;
      expect(instructions.startsWith(SERVER_INSTRUCTIONS)).toBe(true);
      expect(instructions).toContain('PROJECT-NOTE-XYZ');
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('refuses a symlinked instructions.md', () => {
    const outside = path.join(root, 'secret.txt');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, file());
    expect(readProjectInstructions(root)).toBeNull();
  });
});
