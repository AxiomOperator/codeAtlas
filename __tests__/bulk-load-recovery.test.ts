/**
 * Open-time recovery of a killed run's bulk-load windows (#1887) and of a
 * fast init that died mid-run (R-DB4).
 *
 *  - Never heal while another live process holds the index lock: its FTS
 *    triggers / secondary indexes are dropped on purpose.
 *  - Under a liveness watchdog, the heal runs off the main thread so one long
 *    CREATE INDEX can't get every restart SIGKILLed before it commits.
 *  - A fast init (memory journal, synchronous=OFF) that died leaves a marker
 *    beside the DB; the next open discards the possibly torn file instead of
 *    migrating/healing it.
 *
 * Real temp dirs, real SQLite, real spawned processes — no mocks.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath, fastInitState } from '../src/db';

const FTS_TRIGGERS = ['nodes_ad', 'nodes_ai', 'nodes_au'];

function indexNames(conn: DatabaseConnection): string[] {
  return (conn.getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
    .all() as Array<{ name: string }>).map((r) => r.name);
}

function triggerNames(conn: DatabaseConnection): string[] {
  return (conn.getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'nodes_a%' ORDER BY name")
    .all() as Array<{ name: string }>).map((r) => r.name);
}

/** Insert `count` synthetic nodes in one statement. */
function insertNodes(conn: DatabaseConnection, count: number, prefix = 'sym'): void {
  conn.getDb().exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
    INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                       start_line, end_line, start_column, end_column, updated_at)
    SELECT '${prefix}' || i, 'function', '${prefix}' || i, 'mod.${prefix}' || i,
           'src/f' || (i % 997) || '.ts', 'typescript', i, i + 1, 0, 1, 0 FROM n;
  `);
}

/** A pid that is certainly dead (a child that already exited). */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid!;
}

/**
 * Simulate a run killed inside its bulk windows: parse indexes, edge indexes
 * and FTS triggers dropped, rows written without FTS maintenance.
 */
function leaveBulkWindowsOpen(dbPath: string, nodes: number): string[] {
  const conn = DatabaseConnection.initialize(dbPath);
  const healthy = indexNames(conn);
  conn.beginBulkNodeLoad();
  conn.beginBulkParseLoad();
  conn.beginBulkRefLoad();
  insertNodes(conn, nodes);
  conn.close();
  return healthy;
}

describe('bulk-load recovery on open (#1887)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bulk-heal-'));
    fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
    dbPath = getDatabasePath(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not heal while another live process holds the index lock', () => {
    const healthy = leaveBulkWindowsOpen(dbPath, 50);
    // A live process that is not us: our parent (the vitest runner).
    fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.lock'), String(process.ppid));

    const during = DatabaseConnection.open(dbPath);
    expect(indexNames(during)).not.toEqual(healthy);
    expect(triggerNames(during)).toEqual([]);
    during.close();

    // Once the holder is gone (stale lock), the next open heals.
    fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.lock'), String(deadPid()));
    const after = DatabaseConnection.open(dbPath);
    expect(indexNames(after)).toEqual(healthy);
    expect(triggerNames(after)).toEqual(FTS_TRIGGERS);
    after.close();
  });

  it('deferred heal restores indexes, triggers and FTS off-thread', async () => {
    const healthy = leaveBulkWindowsOpen(dbPath, 2000);

    const conn = DatabaseConnection.open(dbPath, { deferHeal: true });
    await conn.whenHealed();
    expect(indexNames(conn)).toEqual(healthy);
    expect(triggerNames(conn)).toEqual(FTS_TRIGGERS);
    const hit = conn.getDb()
      .prepare("SELECT count(*) AS c FROM nodes_fts WHERE nodes_fts MATCH 'sym1234'")
      .get() as { c: number };
    expect(hit.c).toBe(1);
    // Triggers are live again: a new node is searchable.
    insertNodes(conn, 1, 'fresh');
    const fresh = conn.getDb()
      .prepare("SELECT count(*) AS c FROM nodes_fts WHERE nodes_fts MATCH 'fresh1'")
      .get() as { c: number };
    expect(fresh.c).toBe(1);
    conn.close();
  });

  it('CodeGraph.open hands out the project only after recovery completes', async () => {
    const healthy = leaveBulkWindowsOpen(dbPath, 500);
    const cg = await CodeGraph.open(dir);
    try {
      const conn = DatabaseConnection.open(dbPath, { readOnly: true });
      expect(indexNames(conn)).toEqual(healthy);
      expect(triggerNames(conn)).toEqual(FTS_TRIGGERS);
      conn.close();
    } finally {
      cg.close();
    }
  });

  it('a skipped heal runs once this process takes the lock to sync', async () => {
    const healthy = leaveBulkWindowsOpen(dbPath, 50);
    const lockPath = path.join(dir, '.codegraph', 'codegraph.lock');
    fs.writeFileSync(lockPath, String(process.ppid));
    const cg = CodeGraph.openSync(dir);
    try {
      fs.rmSync(lockPath); // the other process finished
      await cg.sync();
      const conn = DatabaseConnection.open(dbPath, { readOnly: true });
      expect(indexNames(conn)).toEqual(healthy);
      expect(triggerNames(conn)).toEqual(FTS_TRIGGERS);
      conn.close();
    } finally {
      cg.close();
    }
  });
});

/**
 * The #1887 failure mode end-to-end: a real lowered liveness watchdog in a
 * spawned process, recovering a database big enough that the inline heal
 * blocks the event loop past the timeout.
 */
describe('bulk-load recovery under a real liveness watchdog (#1887)', () => {
  const DB_MODULE = path.resolve(__dirname, '../dist/db/index.js');
  const WATCHDOG_MODULE = path.resolve(__dirname, '../dist/mcp/liveness-watchdog.js');
  let dir: string;
  let dbPath: string;
  let healthy: string[];

  beforeAll(() => {
    if (!fs.existsSync(DB_MODULE) || !fs.existsSync(WATCHDOG_MODULE)) {
      throw new Error('Build the project first (npm run build): dist modules are missing.');
    }
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bulk-heal-wd-'));
    fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
    dbPath = getDatabasePath(dir);
    healthy = leaveBulkWindowsOpen(dbPath, 300_000);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function openUnderWatchdog(openOptions: string): Promise<{ code: number | null; signal: string | null }> {
    const src = `
      const { installMainThreadWatchdog } = require(${JSON.stringify(WATCHDOG_MODULE)});
      const { DatabaseConnection } = require(${JSON.stringify(DB_MODULE)});
      installMainThreadWatchdog();
      setTimeout(async () => {
        const conn = DatabaseConnection.open(${JSON.stringify(dbPath)}, ${openOptions});
        await conn.whenHealed();
        conn.close();
        process.exit(0);
      }, 100);
    `;
    const child = spawn(process.execPath, ['-e', src], {
      env: { ...process.env, CODEGRAPH_WATCHDOG_TIMEOUT_MS: '250' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, signal: 'TIMEOUT' }); }, 60_000);
      child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
  }

  it('control: an inline heal of this database is killed by the watchdog', async () => {
    const r = await openUnderWatchdog('{ deferHeal: false }');
    expect(r.signal === 'SIGKILL' || (r.signal === null && r.code !== 0 && r.code !== null)).toBe(true);
  }, 90_000);

  it('the default open under a watchdog heals off-thread and survives', async () => {
    const r = await openUnderWatchdog('{}');
    expect(r).toEqual({ code: 0, signal: null });
    const conn = DatabaseConnection.open(dbPath, { readOnly: true });
    expect(indexNames(conn)).toEqual(healthy);
    expect(triggerNames(conn)).toEqual(FTS_TRIGGERS);
    conn.close();
  }, 90_000);
});

describe('aborted fast init (R-DB4)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fastinit-'));
    fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
    dbPath = getDatabasePath(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('discards a torn database whose fast init died, and reports a rebuild is needed', () => {
    const conn = DatabaseConnection.initialize(dbPath);
    insertNodes(conn, 5000);
    conn.close();
    // Tear the file the way a death mid-transaction without a journal can.
    const fd = fs.openSync(dbPath, 'r+');
    fs.writeSync(fd, Buffer.alloc(16 * 4096, 0xab), 0, 16 * 4096, 4096);
    fs.closeSync(fd);
    fs.writeFileSync(dbPath + '-fastinit', String(deadPid()));
    expect(fastInitState(dbPath)).toBe('aborted');

    const reopened = DatabaseConnection.open(dbPath);
    const db = reopened.getDb();
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect((db.prepare('SELECT count(*) AS c FROM nodes').get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT value FROM project_metadata WHERE key = 'index_state'").get() as { value: string }).value)
      .toBe('indexing');
    reopened.close();
    expect(fs.existsSync(dbPath + '-fastinit')).toBe(false);
  });

  it('leaves the database alone while the fast init is still running', () => {
    const conn = DatabaseConnection.initialize(dbPath);
    insertNodes(conn, 10);
    conn.close();
    fs.writeFileSync(dbPath + '-fastinit', String(process.ppid));
    expect(fastInitState(dbPath)).toBe('live');

    const reopened = DatabaseConnection.open(dbPath);
    expect((reopened.getDb().prepare('SELECT count(*) AS c FROM nodes').get() as { c: number }).c).toBe(10);
    reopened.close();
    expect(fs.existsSync(dbPath + '-fastinit')).toBe(true);
  });

  it('a fresh index marks fast init while it runs and clears it when done', async () => {
    fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function alpha() { return beta(); }\nexport function beta() { return 1; }\n');
    const cg = CodeGraph.initSync(dir);
    const markerPath = getDatabasePath(dir) + '-fastinit';
    let seenDuringRun = false;
    try {
      const result = await cg.indexAll({
        onProgress: () => { if (fs.existsSync(markerPath)) seenDuringRun = true; },
      });
      expect(result.success).toBe(true);
    } finally {
      cg.close();
    }
    expect(seenDuringRun).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
    // A clean finish is trusted on the next open.
    const reopened = await CodeGraph.open(dir);
    try {
      expect(reopened.getStats().nodeCount).toBeGreaterThan(0);
      expect(reopened.getIndexState()).toBe('complete');
    } finally {
      reopened.close();
    }
  });
});
