/**
 * Phase 2.8 robustness items: source decoding (BOM / UTF-16), iterative graph
 * walks, the engine shutdown deadline, the socket line cap, the watcher's
 * same-millisecond tie, partial-parse retry and the grammar-load retry.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { decodeSourceBytes, readSourceTextSync } from '../src/file-limits';
import { GraphTraverser } from '../src/graph/traversal';
import { GraphQueryManager } from '../src/graph/queries';
import { waitUntilIdle } from '../src/mcp/engine';
import { SocketTransport } from '../src/mcp/transport';
import { validateAnswerFiles } from '../src/mcp/answer-freshness';
import { FileWatcher, __emitWatchEventForTests } from '../src/sync/watcher';
import { needsReparse } from '../src/extraction/grammars';
import type { Edge, Node } from '../src/types';
import type { QueryBuilder } from '../src/db/queries';

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function utf16be(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
}

describe('decodeSourceBytes', () => {
  const text = 'export function héllo() { return "✓"; }\n';
  it('decodes plain UTF-8 unchanged', () => {
    expect(decodeSourceBytes(Buffer.from(text, 'utf8'))).toBe(text);
  });
  it('drops a UTF-8 BOM', () => {
    expect(decodeSourceBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]))).toBe(text);
  });
  it('decodes UTF-16LE and UTF-16BE by BOM', () => {
    expect(decodeSourceBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))).toBe(text);
    expect(decodeSourceBytes(utf16be(text))).toBe(text);
  });
});

describe('indexing BOM / UTF-16 sources', () => {
  let cg: CodeGraph | null = null;
  afterEach(() => { cg?.destroy(); cg = null; });

  it('extracts symbols from a UTF-16 file and keeps BOM files hash-stable', async () => {
    const dir = tmp('codegraph-decode-');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'wide.ts'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('export function wideFn() { return 1; }\n', 'utf16le')]));
    fs.writeFileSync(path.join(dir, 'src', 'big.ts'), utf16be('export function bigEndianFn() { return 2; }\n'));
    fs.writeFileSync(path.join(dir, 'src', 'bom.ts'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('export function bomFn() { return 3; }\n')]));
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const names = (file: string) => cg!.getNodesInFile(file).map((n) => n.name);
    expect(names('src/wide.ts')).toContain('wideFn');
    expect(names('src/big.ts')).toContain('bigEndianFn');
    expect(names('src/bom.ts')).toContain('bomFn');
    // The BOM is not part of the first symbol's line.
    const bom = cg.getNodesInFile('src/bom.ts').find((n) => n.name === 'bomFn')!;
    expect(bom.startLine).toBe(1);

    // Drift checks decode the same way extraction hashed: nothing is stale.
    const files = ['src/wide.ts', 'src/big.ts', 'src/bom.ts'].map((p) => cg!.getFile(p)!);
    const fresh = await validateAnswerFiles(dir, files.map((f) => ({ path: f.path, contentHash: f.contentHash })));
    expect(fresh.stale).toEqual([]);
    expect(readSourceTextSync(path.join(dir, 'src', 'bom.ts')).startsWith('export')).toBe(true);

    // Touch every file (mtime changes, bytes don't) → sync confirms by hash.
    const later = new Date(Date.now() + 5000);
    for (const f of files) fs.utimesSync(path.join(dir, f.path), later, later);
    const result = await cg.sync();
    expect(result.filesModified).toBe(0);
  });
});

/** A fake QueryBuilder over an in-memory edge list (enough for the traversals). */
function fakeQueries(nodes: Node[], edges: Edge[]): QueryBuilder {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, Edge[]>();
  const outgoing = new Map<string, Edge[]>();
  for (const e of edges) {
    (incoming.get(e.target) ?? incoming.set(e.target, []).get(e.target)!).push(e);
    (outgoing.get(e.source) ?? outgoing.set(e.source, []).get(e.source)!).push(e);
  }
  const filt = (list: Edge[] | undefined, kinds?: string[]) =>
    (list ?? []).filter((e) => !kinds || kinds.includes(e.kind));
  return {
    getNodeById: (id: string) => byId.get(id) ?? null,
    getNodesByIds: (ids: string[]) => new Map(ids.filter((i) => byId.has(i)).map((i) => [i, byId.get(i)!])),
    getIncomingEdges: (id: string, kinds?: string[]) => filt(incoming.get(id), kinds),
    getOutgoingEdges: (id: string, kinds?: string[]) => filt(outgoing.get(id), kinds),
  } as unknown as QueryBuilder;
}

function chain(n: number): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ id: `n${i}`, kind: 'function', name: `f${i}`, qualifiedName: `f${i}`, filePath: 'a.ts',
      language: 'typescript', startLine: i + 1, endLine: i + 1, startColumn: 0, endColumn: 0 } as Node);
    // f(i+1) calls f(i)
    if (i > 0) edges.push({ source: `n${i}`, target: `n${i - 1}`, kind: 'calls' } as Edge);
  }
  return { nodes, edges };
}

describe('iterative graph walks', () => {
  const N = 60_000; // far deeper than the default JS call stack allows recursively

  it('getCallers / getCallees / getImpactRadius / traverseDFS survive a very deep chain', () => {
    const { nodes, edges } = chain(N);
    const t = new GraphTraverser(fakeQueries(nodes, edges));
    expect(t.getCallers('n0', N).length).toBe(N - 1);
    expect(t.getCallees(`n${N - 1}`, N).length).toBe(N - 1);
    expect(t.getImpactRadius('n0', N).nodes.size).toBe(N);
    expect(t.traverseDFS(`n${N - 1}`, { maxDepth: N, limit: N + 1, direction: 'outgoing' }).nodes.size).toBe(N);
  });

  it('keeps DFS order identical on a small branching graph', () => {
    const { nodes } = chain(5);
    const edges = [
      { source: 'n1', target: 'n0', kind: 'calls' },
      { source: 'n2', target: 'n0', kind: 'calls' },
      { source: 'n3', target: 'n1', kind: 'calls' },
      { source: 'n4', target: 'n2', kind: 'calls' },
      { source: 'n3', target: 'n2', kind: 'calls' },
    ] as Edge[];
    const t = new GraphTraverser(fakeQueries(nodes, edges));
    expect(t.getCallers('n0', 3).map((r) => r.node.id)).toEqual(['n1', 'n3', 'n2', 'n4']);
  });

  it('findCircularDependencies is iterative and reports the same cycles', () => {
    const files = Array.from({ length: 30_000 }, (_, i) => `f${i}.ts`);
    const deps = new Map<string, string[]>();
    files.forEach((f, i) => deps.set(f, i + 1 < files.length ? [files[i + 1]!] : [files[0]!]));
    deps.set('f2.ts', ['f3.ts', 'f1.ts']); // a short cycle f1 → f2 → f1 too
    const q = {
      getAllFiles: () => files.map((p) => ({ path: p })),
      getDependencyFilePaths: (p: string) => deps.get(p) ?? [],
    } as unknown as QueryBuilder;
    const cycles = new GraphQueryManager(q).findCircularDependencies();
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toHaveLength(30_000);
    expect(cycles[1]).toEqual(['f1.ts', 'f2.ts']);
  });
});

describe('engine shutdown deadline', () => {
  it('waitUntilIdle gives up after the deadline instead of spinning forever', async () => {
    const t0 = Date.now();
    expect(await waitUntilIdle(() => true, 100, 10)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
    let busy = 3;
    expect(await waitUntilIdle(() => busy-- > 0, 1000, 5)).toBe(true);
  });
});

describe('SocketTransport line cap', () => {
  it('drops a connection whose unterminated line exceeds the cap and still fires close handlers', async () => {
    const dir = tmp('codegraph-sock-');
    const sockPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\codegraph-test-${process.pid}-${Date.now()}`
      : path.join(dir, 's.sock');
    const closed = new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        const transport = new SocketTransport(socket, 'cg-test', 1024);
        transport.onClose(() => { server.close(); resolve(); });
        transport.start(async () => undefined as never);
      });
      server.on('error', reject);
      server.listen(sockPath, () => {
        const client = net.connect(sockPath, () => client.write('x'.repeat(4096)));
        client.on('error', () => { /* server hung up */ });
      });
    });
    await expect(closed).resolves.toBeUndefined();
  });
});

describe('watcher same-millisecond tie', () => {
  it('keeps an edit that lands mid-sync in the same millisecond the sync started', async () => {
    const dir = tmp('codegraph-watch-seq-');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    const T = Date.now();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const syncFn = vi.fn(async () => {
      // A new edit for the same file arrives while the sync is running, with
      // the clock still on the millisecond the sync started.
      __emitWatchEventForTests(dir, 'a.ts');
      await gate;
      return { filesChanged: 1, durationMs: 1 };
    });
    const watcher = new FileWatcher(dir, syncFn, { inertForTests: true, debounceMs: 20 });
    watcher.start();
    await watcher.waitUntilReady();
    vi.spyOn(Date, 'now').mockReturnValue(T);
    __emitWatchEventForTests(dir, 'a.ts');
    for (let i = 0; i < 200 && syncFn.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(syncFn).toHaveBeenCalled();
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(watcher.getPendingFiles().map((p) => p.path)).toContain('a.ts');
    vi.restoreAllMocks();
    watcher.stop();
  });
});

describe('partial parse / grammar retry markers', () => {
  it('needsReparse flags grammar-load failures and incomplete parses only', () => {
    expect(needsReparse(undefined)).toBe(false);
    expect(needsReparse([{ message: 'x', severity: 'error', code: 'parse_error' }])).toBe(false);
    expect(needsReparse([{ message: 'x', severity: 'error', code: 'parse_error', incomplete: true }])).toBe(true);
    expect(needsReparse([{ message: 'x', severity: 'error', code: 'parser_error' }])).toBe(true);
  });
});

describe('partial parse is retried by the next sync', () => {
  it('marks an extractor throw as incomplete', async () => {
    const { initGrammars, loadGrammarsForLanguages } = await import('../src/extraction/grammars');
    const { TreeSitterExtractor, extractFromSource } = await import('../src/extraction/tree-sitter');
    await initGrammars();
    await loadGrammarsForLanguages(['typescript']);
    const proto = TreeSitterExtractor.prototype as unknown as { visitNode: (n: unknown) => void };
    vi.spyOn(proto, 'visitNode').mockImplementation(() => { throw new Error('extractor bug'); });
    // The spy is on the wasm walker; keep a staged native kernel out of the way.
    vi.stubEnv('CODEGRAPH_KERNEL', '0');
    const result = extractFromSource('a.ts', 'export function a() {}\n', 'typescript');
    vi.unstubAllEnvs();
    expect(result.errors.some((e) => e.incomplete === true && e.code === 'parse_error')).toBe(true);
  });

  it('re-parses a file whose stored row is incomplete although its bytes are unchanged', async () => {
    const dir = tmp('codegraph-partial-');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function a() { return 1; }\n');
    const cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    try {
      await cg.indexAll();
      const rec = cg.getFile('a.ts')!;
      const queries = (cg as unknown as { queries: QueryBuilder }).queries;
      queries.upsertFile({ ...rec, errors: [{ message: 'Parse error: boom', severity: 'error', code: 'parse_error', incomplete: true }] });
      const result = await cg.sync();
      expect(result.filesModified).toBe(1);
      expect(needsReparse(cg.getFile('a.ts')!.errors)).toBe(false);
      expect((await cg.sync()).filesModified).toBe(0);
    } finally {
      cg.destroy();
    }
  });
});

describe('grammar load retry', () => {
  it('retries a transient grammar-load failure once instead of marking the language unavailable', async () => {
    const grammars = await import('../src/extraction/grammars');
    const { Language } = await import('web-tree-sitter');
    await grammars.initGrammars();
    const load = vi.spyOn(Language, 'load').mockRejectedValueOnce(new Error('EMFILE: too many open files'));
    await grammars.loadGrammarsForLanguages(['lua']);
    expect(load).toHaveBeenCalledTimes(2);
    expect(grammars.getUnavailableGrammarErrors().lua).toBeUndefined();
    expect(grammars.getParser('lua')).not.toBeNull();
  });
});
