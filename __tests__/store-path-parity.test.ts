/**
 * The incremental store (storeExtractionResult) and the fresh-DB bulk store
 * (buildFreshStoreBundle → storeFileBundle, the store worker's payload) both
 * validate through finalizeStoreBundle. Pin that, for the same extraction
 * result, they write the same rows — including the filtering of nodes missing
 * identity fields, dangling edges, orphaned refs, and ref denormalization.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { finalizeStoreBundle } from '../src/extraction/store-writer';
import type { ExtractionResult, Node } from '../src/types';

const FILE = 'src/a.ts';
const CONTENT = 'export function a() { return b(); }\nexport function b() { return 1; }\n';

function node(id: string, name: string, extra: Partial<Node> = {}): Node {
  return {
    id, kind: 'function', name, qualifiedName: name, filePath: FILE, language: 'typescript',
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 0, ...extra,
  };
}

function result(): ExtractionResult {
  return {
    nodes: [
      node(`file:${FILE}`, 'a.ts', { kind: 'file' }),
      node('fn-a', 'a'),
      node('fn-b', 'b', { startLine: 2, endLine: 2 }),
      node('bad-no-name', ''), // dropped: missing identity field
    ],
    edges: [
      { source: `file:${FILE}`, target: 'fn-a', kind: 'contains' },
      { source: `file:${FILE}`, target: 'fn-b', kind: 'contains' },
      { source: 'fn-a', target: 'bad-no-name', kind: 'calls' }, // dropped: dangling
    ],
    unresolvedReferences: [
      // filePath/language denormalized from the file
      { fromNodeId: 'fn-a', referenceName: 'external', referenceKind: 'calls', line: 1, column: 22 },
      // explicit filePath/language kept
      {
        fromNodeId: 'fn-b', referenceName: 'other', referenceKind: 'references', line: 2, column: 1,
        filePath: FILE, language: 'typescript',
      },
      // dropped: originates from a node that was not inserted
      { fromNodeId: 'missing', referenceName: 'ghost', referenceKind: 'calls', line: 1, column: 0 },
    ],
    errors: [],
    durationMs: 0,
  };
}

describe('store path parity', () => {
  const dirs: string[] = [];
  const graphs: CodeGraph[] = [];

  function fresh(): CodeGraph {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-parity-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, FILE), CONTENT);
    const cg = CodeGraph.initSync(dir);
    graphs.push(cg);
    return cg;
  }

  const stats = (cg: CodeGraph) => fs.statSync(path.join((cg as any).projectRoot, FILE));

  function dump(cg: CodeGraph): Record<string, unknown[]> {
    const db = (cg as any).queries.db;
    const strip = (rows: Record<string, unknown>[], drop: string[]) =>
      rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.includes(k))));
    return {
      nodes: strip(db.prepare('SELECT * FROM nodes ORDER BY id').all(), ['updated_at']),
      edges: strip(db.prepare('SELECT * FROM edges ORDER BY source, target, kind').all(), ['id']),
      refs: strip(
        db.prepare('SELECT * FROM unresolved_refs ORDER BY from_node_id, reference_name').all(),
        ['id']
      ),
      files: strip(db.prepare('SELECT * FROM files').all(), ['indexed_at', 'modified_at']), // per-temp-dir timestamps
    };
  }

  beforeEach(() => {
    dirs.length = 0;
    graphs.length = 0;
  });

  afterEach(() => {
    for (const cg of graphs) cg.destroy();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('incremental and fresh-bundle stores write identical rows', async () => {
    const incremental = fresh();
    const orchA = (incremental as any).orchestrator;
    await orchA.storeExtractionResult(FILE, CONTENT, 'typescript', stats(incremental), result());

    const bulk = fresh();
    const orchB = (bulk as any).orchestrator;
    const bundle = orchB.buildFreshStoreBundle(FILE, CONTENT, 'typescript', stats(bulk), result());
    (bulk as any).queries.storeFileBundle(bundle);

    const a = dump(incremental);
    const b = dump(bulk);
    expect(a).toEqual(b);

    // And the shared filter did its job on both.
    expect(a.nodes.map((n: any) => n.id)).toEqual(['file:src/a.ts', 'fn-a', 'fn-b']);
    expect(a.edges).toHaveLength(2);
    expect(a.refs.map((r: any) => [r.reference_name, r.file_path, r.language])).toEqual([
      ['external', FILE, 'typescript'],
      ['other', FILE, 'typescript'],
    ]);
    // nodeCount is the pre-filter count on both paths.
    expect((a.files[0] as any).node_count).toBe(4);
  });

  it('finalizeStoreBundle is the filter both paths share', () => {
    const r = result();
    const file = { path: FILE } as any;
    const out = finalizeStoreBundle(r, FILE, 'typescript', file);
    expect(out.nodes).toHaveLength(3);
    expect(out.edges).toHaveLength(2);
    expect(out.refs).toHaveLength(2);
    expect(out.file).toBe(file);
  });
});
