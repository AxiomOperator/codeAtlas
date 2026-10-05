/**
 * SQLite Adapter
 *
 * Thin wrapper over Node's built-in `node:sqlite` (`DatabaseSync`), exposed
 * through a small better-sqlite3-shaped interface so the rest of the codebase
 * is storage-agnostic.
 *
 * CodeGraph ships with a bundled Node runtime, so `node:sqlite` (real SQLite,
 * with WAL + FTS5) is always available — there is no native build step and no
 * wasm fallback. When run from source instead, it requires Node >= 22.13.
 */

import { toWslSharedIndexError } from './wsl-shared-index';

export interface SqliteStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
  /**
   * Lazily yield result rows one at a time instead of materializing the whole
   * set with `all()`. Use for unbounded scans (e.g. every function/method node)
   * so memory stays O(1) in the row count rather than O(rows) — see #610, where
   * `all()`-ing every symbol on a dense project spiked the heap into an OOM.
   */
  iterate(...params: any[]): IterableIterator<any>;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(str: string, options?: { simple?: boolean }): any;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  /** BEGIN … await fn … COMMIT as one atomic unit; see NodeSqliteAdapter. */
  transactionAsync<T>(fn: () => Promise<T>): Promise<T>;
  close(): void;
  readonly open: boolean;
  /** Undefined on a runtime without `isTransaction`; callers must then not memoize. */
  readonly inTransaction?: boolean;
}

/**
 * The active SQLite backend. Only one now (`node:sqlite`); kept as a named type
 * so `codegraph status` and the per-instance reporting have a stable shape.
 */
export type SqliteBackend = 'node-sqlite';

/**
 * Wraps Node's built-in `node:sqlite` (`DatabaseSync`) to match the
 * better-sqlite3 interface the rest of the code expects.
 *
 * node:sqlite is real SQLite compiled into Node, so it supports WAL, FTS5,
 * mmap, and `@named` params natively — the only shims needed are the
 * better-sqlite3 conveniences node:sqlite omits: a `.pragma()` helper, a
 * `.transaction()` helper, and `open` (node:sqlite exposes `isOpen`).
 */
class NodeSqliteAdapter implements SqliteDatabase {
  private _db: any;
  private _txDepth = 0;
  private _asyncTail: Promise<void> = Promise.resolve();
  private readonly _dbPath: string;

  constructor(dbPath: string, opts?: { readOnly?: boolean }) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    this._dbPath = dbPath;
    this._db = opts?.readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath);
    // `INSERT OR REPLACE INTO nodes` deletes the old row implicitly, and SQLite
    // fires DELETE triggers for that only with recursive_triggers on. Without
    // it the nodes_fts delete trigger never runs, so every replaced node left
    // an orphan entry in the external-content FTS index (stale tokens pointing
    // at a dead rowid). Connection-level, touches no file, so it is set on
    // every connection — the store worker's included.
    this._db.exec('PRAGMA recursive_triggers = ON');
  }

  /**
   * What a failed call throws: the error itself, or — for a "disk I/O error"
   * on a WSL index that Windows CodeGraph shares — the actionable rewrite
   * (#995). Every open runs its PRAGMAs and first reads through the methods
   * below, and so does every later query. `iterate()` is left raw: a
   * row-by-row wrapper would tax the unbounded scans it exists for, and a
   * session reads through `get`/`all` long before it reaches one.
   */
  private failure(err: unknown): unknown {
    return toWslSharedIndexError(err, this._dbPath) ?? err;
  }

  get inTransaction(): boolean | undefined {
    return this._db.isTransaction;
  }

  get open(): boolean {
    return this._db.isOpen;
  }

  prepare(sql: string): SqliteStatement {
    // node:sqlite matches better-sqlite3's calling convention (variadic
    // positional args, or a single object for @named params), so params forward
    // through unchanged.
    let stmt: any;
    try {
      stmt = this._db.prepare(sql);
    } catch (err) {
      throw this.failure(err);
    }
    const failure = (err: unknown): unknown => this.failure(err);
    return {
      run(...params: any[]) {
        let r: any;
        try {
          r = stmt.run(...params);
        } catch (err) {
          throw failure(err);
        }
        return {
          changes: Number(r?.changes ?? 0),
          lastInsertRowid: r?.lastInsertRowid ?? 0,
        };
      },
      get(...params: any[]) {
        try {
          return stmt.get(...params);
        } catch (err) {
          throw failure(err);
        }
      },
      all(...params: any[]) {
        try {
          return stmt.all(...params);
        } catch (err) {
          throw failure(err);
        }
      },
      iterate(...params: any[]) {
        return stmt.iterate(...params);
      },
    };
  }

  exec(sql: string): void {
    try {
      this._db.exec(sql);
    } catch (err) {
      throw this.failure(err);
    }
  }

  pragma(str: string, options?: { simple?: boolean }): any {
    const trimmed = str.trim();
    // Write pragma ("key = value"): node:sqlite is real SQLite, so every pragma
    // (WAL, mmap, synchronous, …) applies as-is.
    if (trimmed.includes('=')) {
      this.exec(`PRAGMA ${trimmed}`);
      return;
    }
    // Read pragma. Default: the row object (e.g. { journal_mode: 'wal' }).
    // `{ simple: true }` returns just the single column value, like better-sqlite3.
    const row = this.prepare(`PRAGMA ${trimmed}`).get();
    if (options?.simple) {
      return row && typeof row === 'object' ? Object.values(row)[0] : row;
    }
    return row;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      // Nested call (a transaction()-wrapped helper invoked from inside another
      // transaction): run the body in a SAVEPOINT, so an inner failure the
      // outer body catches rolls back only the inner's partial writes instead
      // of committing them with the outer transaction.
      if (this._txDepth > 0) return this.runInSavepoint(() => fn(...args));
      this._db.exec('BEGIN');
      this._txDepth = 1;
      try {
        const result = fn(...args);
        this.commitOrThrow();
        return result;
      } catch (error) {
        rollbackIfActive(this);
        throw error;
      } finally {
        this._txDepth = 0;
      }
    };
  }

  /**
   * Async counterpart of `transaction()`: BEGIN, await `fn`, COMMIT — so a
   * long store can yield to the event loop (savepoint-free, no intermediate
   * commits) while other connections still see it land atomically. Calls are
   * serialized on this connection (a second one waits for the first to
   * finish); one must not be awaited from inside another. Synchronous
   * `transaction()` calls made during `fn`'s awaits nest as savepoints.
   */
  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this._asyncTail;
    let release!: () => void;
    this._asyncTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      this._db.exec('BEGIN');
      this._txDepth = 1;
      try {
        const result = await fn();
        this.commitOrThrow();
        return result;
      } catch (error) {
        rollbackIfActive(this);
        throw error;
      } finally {
        this._txDepth = 0;
      }
    } finally {
      release();
    }
  }

  private runInSavepoint<T>(fn: () => T): T {
    const name = `cg_sp_${this._txDepth}`;
    this._db.exec(`SAVEPOINT ${name}`);
    this._txDepth++;
    try {
      const result = fn();
      this._db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      // If SQLite already rolled the whole transaction back (SQLITE_FULL,
      // IOERR, …) the savepoint is gone too — touching it would throw and
      // mask the real error.
      if (this.inTransaction !== false) {
        try {
          this._db.exec(`ROLLBACK TO ${name}`);
          this._db.exec(`RELEASE ${name}`);
        } catch {
          /* keep the original error */
        }
      }
      throw error;
    } finally {
      this._txDepth--;
    }
  }

  /** COMMIT, unless SQLite already rolled the transaction back on its own. */
  private commitOrThrow(): void {
    if (this.inTransaction === false) {
      throw new Error('SQLite rolled the transaction back before it could commit');
    }
    this._db.exec('COMMIT');
  }

  close(): void {
    // node:sqlite's DatabaseSync.close() throws if already closed; make it
    // idempotent to match better-sqlite3 (callers may close more than once).
    if (this._db.isOpen) this._db.close();
  }
}

/**
 * Roll back `db`'s open transaction, if it still has one. After SQLITE_FULL,
 * IOERR and friends SQLite has already rolled back on its own; a blind
 * ROLLBACK then throws "no transaction is active" and masks the real error.
 * On a runtime without `isTransaction` (Node < 22.16) the ROLLBACK is
 * attempted and its failure swallowed. Never throws — callers rethrow the
 * ORIGINAL error.
 */
export function rollbackIfActive(db: Pick<SqliteDatabase, 'exec' | 'inTransaction'>): void {
  if (db.inTransaction === false) return;
  try {
    db.exec('ROLLBACK');
  } catch {
    /* already rolled back — keep the caller's original error */
  }
}

/**
 * Create a database connection backed by `node:sqlite`.
 *
 * Returns the active backend alongside the db so each `DatabaseConnection` can
 * report it per-instance — MCP can open multiple project DBs in one process, so
 * a process-global would race.
 */
export function createDatabase(dbPath: string, opts?: { readOnly?: boolean }): { db: SqliteDatabase; backend: SqliteBackend } {
  try {
    return { db: new NodeSqliteAdapter(dbPath, opts), backend: 'node-sqlite' };
  } catch (error) {
    // node:sqlite loaded and SQLite itself failed — not a missing-module case.
    const shared = toWslSharedIndexError(error, dbPath);
    if (shared) throw shared;
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      'Failed to open SQLite via the built-in node:sqlite module.\n' +
      'CodeGraph requires node:sqlite (Node.js 22.13+). Install the self-contained\n' +
      'CodeGraph release (it bundles a compatible Node), or run on Node 22.13+.\n' +
      `Underlying error: ${msg}`
    );
  }
}
