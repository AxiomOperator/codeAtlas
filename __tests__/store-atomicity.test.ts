/**
 * Store-path atomicity (plan 2.4, R-DB13).
 *
 *  - The chunked store for a giant file (more rows than one store chunk)
 *    yields to the event loop between chunks but must still land as ONE
 *    transaction: a failure part-way keeps the file's previous symbols and
 *    other files' incoming edges into it.
 *  - Removing a tracked file resurrects its incoming edges as refs and
 *    deletes it in one transaction.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

const BIG_FUNCS = 2100; // > STORE_CHUNK (2000) → the chunked, yielding path

function bigFile(prefix = ''): string {
  const lines: string[] = [prefix];
  for (let i = 0; i < BIG_FUNCS; i++) lines.push(`export function f${i}() { return ${i}; }`);
  return lines.join('\n');
}

describe('store atomicity', () => {
  let dir: string;
  let cg: CodeGraph;

  const db = () => (cg as any).queries.db;
  const nodeCount = (file: string): number =>
    (db().prepare('SELECT COUNT(*) AS c FROM nodes WHERE file_path = ?').get(file) as { c: number }).c;
  const incomingCalls = (): number =>
    (
      db()
        .prepare(
          `SELECT COUNT(*) AS c FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
           WHERE e.kind = 'calls' AND s.file_path = 'src/caller.ts' AND t.file_path = 'src/big.ts'`
        )
        .get() as { c: number }
    ).c;
  const refCount = (): number =>
    (db().prepare('SELECT COUNT(*) AS c FROM unresolved_refs').get() as { c: number }).c;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-atomicity-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'big.ts'), bigFile());
    fs.writeFileSync(
      path.join(dir, 'src', 'caller.ts'),
      `import { f1, f2 } from './big';\nexport function caller() { return f1() + f2(); }\n`
    );
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a failure part-way through a chunked re-store keeps the old file and its incoming edges', async () => {
    const before = nodeCount('src/big.ts');
    expect(before).toBeGreaterThan(BIG_FUNCS);
    expect(incomingCalls()).toBe(2);
    const hashBefore = (cg as any).queries.getFileByPath('src/big.ts').contentHash;

    // Shift every line so all node ids change, then crash at the very last
    // step (the file record) — after the delete, every chunk and the re-attach.
    fs.writeFileSync(path.join(dir, 'src', 'big.ts'), bigFile('// shifted\n'));
    const queries = (cg as any).queries;
    const realUpsert = queries.upsertFile.bind(queries);
    vi.spyOn(queries, 'upsertFile').mockImplementation((rec: any) => {
      if (rec.path === 'src/big.ts') throw new Error('crash before file record');
      return realUpsert(rec);
    });

    try {
      await cg.sync();
    } catch {
      /* sync may surface the failure — either way the DB must be intact */
    }

    expect(db().inTransaction).toBe(false);
    expect(nodeCount('src/big.ts')).toBe(before);
    expect(incomingCalls()).toBe(2);
    expect(queries.getFileByPath('src/big.ts').contentHash).toBe(hashBefore);

    // With the fault gone, the next sync re-stores the file normally.
    vi.restoreAllMocks();
    await cg.sync();
    expect(nodeCount('src/big.ts')).toBe(before);
    expect(incomingCalls()).toBe(2);
    expect(queries.getFileByPath('src/big.ts').contentHash).not.toBe(hashBefore);
  });

  it('removing a file resurrects refs and deletes it atomically', async () => {
    const refsBefore = refCount();
    fs.rmSync(path.join(dir, 'src', 'big.ts'));
    const queries = (cg as any).queries;
    const realDelete = queries.deleteFile.bind(queries);
    vi.spyOn(queries, 'deleteFile').mockImplementation((p: any) => {
      if (p === 'src/big.ts') throw new Error('crash during delete');
      return realDelete(p);
    });

    try {
      await cg.sync();
    } catch {
      /* expected */
    }

    // Neither the resurrected refs nor the delete landed.
    expect(db().inTransaction).toBe(false);
    expect(refCount()).toBe(refsBefore);
    expect(nodeCount('src/big.ts')).toBeGreaterThan(BIG_FUNCS);
    expect(incomingCalls()).toBe(2);

    vi.restoreAllMocks();
    await cg.sync();
    expect(nodeCount('src/big.ts')).toBe(0);
    expect(queries.getFileByPath('src/big.ts')).toBeFalsy();
  });
});
