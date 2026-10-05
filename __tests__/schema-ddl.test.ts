/**
 * schema-ddl.ts is the single source for the DDL fragments runtime code paths
 * re-execute (bulk-load index recreation, FTS triggers) and for the
 * synthesized-edge metadata expressions the partial index
 * idx_edges_synthesis_site is built on. SQLite only uses a partial index when
 * the query repeats the index's predicate verbatim, so these tests pin that
 * schema.sql, the migrations and the queries all carry exactly the constants.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { runMigrations } from '../src/db/migrations';
import {
  FTS_TRIGGER_NAMES,
  SYNTHESIS_SITE_INDEX,
  SYNTHESIS_SITE_INDEX_BODY,
  SYNTHESIS_SITE_KEY,
  SYNTHESIZED_EDGE,
  ftsTriggerDdls,
  readSchemaSql,
  schemaIndexDdl,
  splitSchemaForFts,
  synthesisSiteExpr,
  synthesizedEdgeExpr,
} from '../src/db/schema-ddl';
import { SYNTHESIZED_EDGE as STAGE_SYNTHESIZED_EDGE } from '../src/db/synthesis-stage';

const schemaFile = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf-8');

describe('schema-ddl constants match schema.sql', () => {
  it('schema.sql defines idx_edges_synthesis_site with exactly the shared expressions', () => {
    expect(schemaFile).toContain(
      `CREATE INDEX IF NOT EXISTS ${SYNTHESIS_SITE_INDEX} ${SYNTHESIS_SITE_INDEX_BODY};`
    );
    expect(schemaIndexDdl(SYNTHESIS_SITE_INDEX)).toBe(
      `CREATE INDEX IF NOT EXISTS ${SYNTHESIS_SITE_INDEX} ${SYNTHESIS_SITE_INDEX_BODY};`
    );
    expect(schemaFile).toContain(`WHERE ${SYNTHESIZED_EDGE};`);
    expect(schemaFile).toContain(`ON edges(${SYNTHESIS_SITE_KEY})`);
  });

  it('the synthesis stage and aliased query variants share the one expression', () => {
    expect(STAGE_SYNTHESIZED_EDGE).toBe(SYNTHESIZED_EDGE);
    expect(synthesizedEdgeExpr()).toBe(SYNTHESIZED_EDGE);
    expect(synthesisSiteExpr()).toBe(SYNTHESIS_SITE_KEY);
    expect(synthesizedEdgeExpr('e')).toBe(SYNTHESIZED_EDGE.replace(/\bmetadata\b/g, 'e.metadata'));
    expect(synthesisSiteExpr('e')).toBe(SYNTHESIS_SITE_KEY.replace(/\bmetadata\b/g, 'e.metadata'));
  });

  it('reads the shipped schema.sql', () => {
    expect(readSchemaSql()).toBe(schemaFile);
  });

  it('extracts every bulk-load index the connection recreates', () => {
    const names = [
      'idx_nodes_kind', 'idx_nodes_name', 'idx_nodes_qualified_name', 'idx_nodes_file_path',
      'idx_nodes_language', 'idx_nodes_file_line', 'idx_nodes_lower_name',
      'idx_unresolved_from_node', 'idx_unresolved_name', 'idx_unresolved_file_path',
      'idx_unresolved_from_name', 'idx_unresolved_status', 'idx_unresolved_failed_tail',
      'idx_files_language', 'idx_files_modified_at',
      'idx_edges_kind', 'idx_edges_source_kind', 'idx_edges_target_kind', 'idx_edges_provenance',
      SYNTHESIS_SITE_INDEX,
    ];
    for (const name of names) {
      const ddl = schemaIndexDdl(name);
      expect(ddl.startsWith(`CREATE INDEX IF NOT EXISTS ${name} `)).toBe(true);
      expect(ddl.endsWith(';')).toBe(true);
    }
    expect(() => schemaIndexDdl('idx_does_not_exist')).toThrow(/idx_does_not_exist/);
  });

  it('extracts the three FTS triggers and splits the FTS section losslessly', () => {
    const triggers = ftsTriggerDdls();
    expect(triggers).toHaveLength(FTS_TRIGGER_NAMES.length);
    FTS_TRIGGER_NAMES.forEach((name, i) => expect(triggers[i]).toContain(`IF NOT EXISTS ${name}`));
    const split = splitSchemaForFts(schemaFile)!;
    expect(split).not.toBeNull();
    expect(split.pre + split.fts + split.post).toBe(schemaFile);
    expect(split.fts).toContain('CREATE VIRTUAL TABLE');
    expect(split.fts.trimEnd().endsWith('END;')).toBe(true);
    expect(splitSchemaForFts('CREATE TABLE t(x);')).toBeNull();
  });
});

describe('the partial synthesis-site index is used', () => {
  let dir: string;
  let connection: DatabaseConnection;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-schema-ddl-'));
    connection = DatabaseConnection.initialize(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const plan = (): string => (connection.getDb().prepare(
    `EXPLAIN QUERY PLAN SELECT 1 FROM edges e WHERE ${synthesizedEdgeExpr('e')}
      AND ${synthesisSiteExpr('e')} >= ? AND ${synthesisSiteExpr('e')} < ? LIMIT 1`
  ).all('a.ts:', 'a.ts;') as Array<{ detail: string }>).map((r) => r.detail).join('\n');

  it('by the third-file wiring lookup on a fresh schema', () => {
    expect(plan()).toContain(SYNTHESIS_SITE_INDEX);
  });

  it('after the v10/v11 migrations rebuild it', () => {
    const db = connection.getDb();
    db.exec(`DROP INDEX ${SYNTHESIS_SITE_INDEX}`);
    db.exec('DELETE FROM schema_versions WHERE version >= 10');
    runMigrations(db, 9);
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(SYNTHESIS_SITE_INDEX) as { sql: string }).sql;
    expect(sql).toContain(SYNTHESIS_SITE_INDEX_BODY);
    expect(plan()).toContain(SYNTHESIS_SITE_INDEX);
  });
});
