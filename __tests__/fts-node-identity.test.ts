/**
 * FTS / node-identity integrity (plan 2.3, R-DB3 / R-DB8).
 *
 * `nodes_fts` is an external-content FTS5 index keyed on `nodes.rowid` and
 * kept in sync by triggers. Two suspicions, each pinned here:
 *
 *  1. `INSERT OR REPLACE INTO nodes` with an id already present deletes the
 *     old row implicitly. SQLite fires DELETE triggers for that only when
 *     `recursive_triggers` is on — so without it the FTS delete trigger never
 *     ran and every replaced node left an orphan FTS entry (its old tokens
 *     pointing at a dead rowid). PROVEN; fixed by enabling the pragma on every
 *     connection.
 *  2. VACUUM may renumber rowids of a table without an INTEGER PRIMARY KEY,
 *     which would desync the rowid-keyed FTS index. DISPROVEN on the bundled
 *     SQLite (VACUUM's transfer path keeps rowids); kept as a pin.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { Node } from '../src/types';

function makeNode(id: string, name: string, filePath = 'a.ts'): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

/** Strict FTS5 check: index vs. the content table (rank=1). Throws on drift. */
function ftsConsistent(db: DatabaseConnection): boolean {
  try {
    db.getDb().exec(`INSERT INTO nodes_fts(nodes_fts, rank) VALUES('integrity-check', 1)`);
    return true;
  } catch {
    return false;
  }
}

function ftsRowidsMatching(db: DatabaseConnection, term: string): number[] {
  return (db.getDb().prepare('SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?').all(term) as Array<{ rowid: number }>)
    .map((r) => Number(r.rowid));
}

describe('nodes_fts stays consistent with nodes', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-identity-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a duplicate node id in one bundle leaves no orphan FTS entry', () => {
    q.storeFileBundle({
      nodes: [makeNode('dup', 'alphaOriginal'), makeNode('dup', 'betaReplacement')],
      edges: [],
      refs: [],
      file: {
        path: 'a.ts',
        contentHash: 'h',
        language: 'typescript',
        size: 1,
        modifiedAt: 0,
        indexedAt: 0,
        nodeCount: 2,
      },
    });
    expect(ftsConsistent(db)).toBe(true);
    // The replaced row's tokens are gone from the index entirely.
    expect(ftsRowidsMatching(db, 'alphaOriginal')).toEqual([]);
    expect(q.searchNodes('betaReplacement').map((r) => r.node.id)).toEqual(['dup']);
  });

  it('insertNode over an existing id replaces its FTS entry', () => {
    q.insertNode(makeNode('n1', 'oldName'));
    q.insertNode(makeNode('n1', 'newName'));
    expect(ftsConsistent(db)).toBe(true);
    expect(ftsRowidsMatching(db, 'oldName')).toEqual([]);
    expect(q.searchNodes('newName').map((r) => r.node.id)).toEqual(['n1']);
  });

  it('recursive_triggers is on for every connection', () => {
    expect(db.getDb().pragma('recursive_triggers', { simple: true })).toBe(1);
  });

  it('VACUUM (optimize) after deletions keeps search on the right nodes', () => {
    const nodes: Node[] = [];
    for (let i = 0; i < 200; i++) nodes.push(makeNode(`id${i}`, `symbolNumber${i}`, `f${i % 10}.ts`));
    q.insertNodes(nodes);
    // Delete a spread of rows so rowids have gaps for VACUUM to (not) compact.
    for (let i = 0; i < 200; i += 3) q.deleteNode(`id${i}`);
    db.optimize();
    expect(ftsConsistent(db)).toBe(true);
    for (const i of [1, 2, 4, 100, 199]) {
      const hits = q.searchNodes(`symbolNumber${i}`).map((r) => r.node.id);
      expect(hits[0]).toBe(`id${i}`);
    }
    // Deleted nodes never come back through the FTS join.
    const deleted = new Set(Array.from({ length: 67 }, (_, k) => `id${k * 3}`));
    expect(q.searchNodes('symbolNumber3', { limit: 500 }).some((r) => deleted.has(r.node.id))).toBe(false);
    // And every surviving node is still found under its own rowid.
    const rows = db.getDb().prepare('SELECT n.id, n.name FROM nodes n JOIN nodes_fts f ON f.rowid = n.rowid WHERE nodes_fts MATCH n.name').all() as Array<{ id: string; name: string }>;
    expect(rows.length).toBe(200 - deleted.size);
  });
});
