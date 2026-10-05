/**
 * Transaction semantics of the node:sqlite adapter (plan 2.4, R-DB6 / R-DB7).
 *
 *  - A failed transaction whose work SQLite already rolled back (SQLITE_FULL,
 *    IOERR, …) must rethrow the ORIGINAL error, not "no transaction is active"
 *    from a blind ROLLBACK.
 *  - Nested `transaction()` calls are savepoints: an inner failure the outer
 *    body catches rolls back only the inner's writes.
 *  - `transactionAsync` commits all-or-nothing across awaits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createDatabase, rollbackIfActive, type SqliteDatabase } from '../src/db/sqlite-adapter';

describe('sqlite adapter transactions', () => {
  let dir: string;
  let db: SqliteDatabase;

  const count = (): number => (db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;
  const values = (): number[] =>
    (db.prepare('SELECT v FROM t ORDER BY v').all() as Array<{ v: number }>).map((r) => Number(r.v));
  const insert = (v: number): void => {
    db.prepare('INSERT INTO t (v) VALUES (?)').run(v);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-tx-'));
    db = createDatabase(path.join(dir, 'test.db')).db;
    db.exec('CREATE TABLE t (v INTEGER)');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rethrows the original error when SQLite already rolled the transaction back', () => {
    const original = new Error('disk full (simulated)');
    expect(() =>
      db.transaction(() => {
        insert(1);
        // What SQLite does on its own for SQLITE_FULL / IOERR: the transaction
        // is gone by the time control returns to the adapter.
        db.exec('ROLLBACK');
        throw original;
      })()
    ).toThrow(original);
    expect(db.inTransaction).toBe(false);
    expect(count()).toBe(0);
  });

  it('does not commit when the body swallowed an auto-rollback', () => {
    expect(() =>
      db.transaction(() => {
        insert(1);
        db.exec('ROLLBACK');
      })()
    ).toThrow(/rolled the transaction back/);
  });

  it('rollbackIfActive never throws and leaves no transaction open', () => {
    expect(() => rollbackIfActive(db)).not.toThrow();
    db.exec('BEGIN');
    insert(1);
    rollbackIfActive(db);
    expect(db.inTransaction).toBe(false);
    expect(count()).toBe(0);
  });

  it('a nested transaction that throws rolls back only its own writes', () => {
    const inner = db.transaction(() => {
      insert(2);
      throw new Error('inner failed');
    });
    db.transaction(() => {
      insert(1);
      try {
        inner();
      } catch {
        /* outer recovers */
      }
      insert(3);
    })();
    expect(values()).toEqual([1, 3]);
  });

  it('a nested transaction that succeeds commits with the outer one', () => {
    db.transaction(() => {
      insert(1);
      db.transaction(() => insert(2))();
      db.transaction(() => db.transaction(() => insert(3))())();
    })();
    expect(values()).toEqual([1, 2, 3]);
  });

  it('an outer failure rolls back committed-looking inner savepoints too', () => {
    expect(() =>
      db.transaction(() => {
        db.transaction(() => insert(1))();
        throw new Error('outer failed');
      })()
    ).toThrow('outer failed');
    expect(count()).toBe(0);
    expect(db.inTransaction).toBe(false);
  });

  it('transactionAsync is all-or-nothing across awaits', async () => {
    await expect(
      db.transactionAsync(async () => {
        insert(1);
        await new Promise<void>((r) => setImmediate(r));
        insert(2);
        await new Promise<void>((r) => setImmediate(r));
        throw new Error('crash mid-store');
      })
    ).rejects.toThrow('crash mid-store');
    expect(count()).toBe(0);
    expect(db.inTransaction).toBe(false);

    await db.transactionAsync(async () => {
      insert(1);
      await new Promise<void>((r) => setImmediate(r));
      insert(2);
    });
    expect(values()).toEqual([1, 2]);
  });

  it('transactionAsync keeps uncommitted chunks invisible to other connections', async () => {
    db.pragma('journal_mode = WAL');
    const other = createDatabase(path.join(dir, 'test.db'), { readOnly: true }).db;
    try {
      const seen: number[] = [];
      await db.transactionAsync(async () => {
        insert(1);
        await new Promise<void>((r) => setImmediate(r));
        seen.push((other.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c);
        insert(2);
      });
      expect(seen).toEqual([0]);
      expect((other.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c).toBe(2);
    } finally {
      other.close();
    }
  });

  it('serializes concurrent transactionAsync calls and nests sync transactions run during a yield', async () => {
    const a = db.transactionAsync(async () => {
      insert(1);
      await new Promise<void>((r) => setImmediate(r));
      // A synchronous transaction from elsewhere during the yield nests as a
      // savepoint instead of failing on BEGIN.
      db.transaction(() => insert(2))();
      insert(3);
    });
    const b = db.transactionAsync(async () => {
      insert(4);
    });
    await Promise.all([a, b]);
    expect(values()).toEqual([1, 2, 3, 4]);
  });
});
