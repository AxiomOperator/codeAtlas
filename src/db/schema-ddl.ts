/**
 * Schema DDL fragments shared by code paths that must NOT drift from
 * `schema.sql` (the shipped schema, still executed whole on initialize).
 *
 * Two kinds of fragment live here:
 *   - Statements recreated at runtime after a bulk-load window (secondary
 *     indexes, FTS sync triggers). They are parsed out of `schema.sql` by the
 *     ONE helper below, so the file stays the single definition.
 *   - The synthesized-edge metadata expressions. SQLite only uses the partial
 *     index `idx_edges_synthesis_site` when a query's WHERE contains the
 *     index's predicate expression verbatim, so `schema.sql`, `migrations.ts`,
 *     `queries.ts` and `synthesis-stage.ts` all build theirs from the
 *     constants here (a test pins that `schema.sql` contains exactly them).
 *
 * Deliberately import-free beyond node builtins: migrations, queries and the
 * synthesis stage all import it, and it must not create a cycle.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Prefix a column with a table alias (`e.metadata`) or leave it bare. */
function metadataColumn(alias?: string): string {
  return alias ? `${alias}.metadata` : 'metadata';
}

/**
 * The guarded `$.synthesizedBy` predicate — true for edges a synthesis pass
 * owns. CASE short-circuits malformed metadata (json_extract would throw).
 * This is the partial predicate of `idx_edges_synthesis_site`.
 */
export function synthesizedEdgeExpr(alias?: string): string {
  const m = metadataColumn(alias);
  return `CASE WHEN json_valid(${m}) THEN json_extract(${m}, '$.synthesizedBy') END IS NOT NULL`;
}

/** The guarded `$.registeredAt` key — the indexed expression of `idx_edges_synthesis_site`. */
export function synthesisSiteExpr(alias?: string): string {
  const m = metadataColumn(alias);
  return `CASE WHEN json_valid(${m}) THEN json_extract(${m}, '$.registeredAt') END`;
}

/** Unaliased synthesized-edge predicate (the partial-index predicate verbatim). */
export const SYNTHESIZED_EDGE = synthesizedEdgeExpr();

/** Unaliased synthesis-site key (the partial index's indexed expression verbatim). */
export const SYNTHESIS_SITE_KEY = synthesisSiteExpr();

export const SYNTHESIS_SITE_INDEX = 'idx_edges_synthesis_site';

/** The column list + partial predicate of idx_edges_synthesis_site (after the index name). */
export const SYNTHESIS_SITE_INDEX_BODY = `ON edges(${SYNTHESIS_SITE_KEY})\n    WHERE ${SYNTHESIZED_EDGE}`;

/** FTS maintenance triggers on `nodes`. Names must match schema.sql. */
export const FTS_TRIGGER_NAMES = ['nodes_ai', 'nodes_ad', 'nodes_au'] as const;

/** Comment line that opens the FTS5 section of schema.sql (#1532 split). */
export const FTS5_SECTION_MARKER = '-- Full-text search index on node names, docstrings, and signatures';

let cachedSchema: string | null = null;

/** The shipped `schema.sql` (copied beside this module into dist/db by copy-assets). */
export function readSchemaSql(): string {
  return (cachedSchema ??= fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8'));
}

/**
 * The `CREATE INDEX IF NOT EXISTS <name> ...;` statement for one index,
 * extracted from schema.sql. Throws when the index is not defined there.
 */
export function schemaIndexDdl(name: string, schema: string = readSchemaSql()): string {
  const m = schema.match(new RegExp(`CREATE INDEX IF NOT EXISTS ${name}\\b[^;]*;`));
  if (!m) throw new Error(`schema.sql: index ${name} not found`);
  return m[0];
}

/** The three FTS sync-trigger DDLs, extracted from schema.sql. */
export function ftsTriggerDdls(schema: string = readSchemaSql()): string[] {
  const ddls = schema.match(/CREATE TRIGGER IF NOT EXISTS nodes_a[idu]\b[\s\S]*?END;/g);
  if (!ddls || ddls.length !== FTS_TRIGGER_NAMES.length) {
    throw new Error(
      `schema.sql: expected ${FTS_TRIGGER_NAMES.length} nodes FTS triggers, found ${ddls?.length ?? 0}`
    );
  }
  return ddls;
}

/**
 * Split schema.sql around its FTS5 section so initialize can run the rest
 * when FTS5 is unavailable (#1532). `fts` is null when the marker is absent.
 */
export function splitSchemaForFts(
  schema: string = readSchemaSql()
): { pre: string; fts: string; post: string } | null {
  const ftsIdx = schema.indexOf(FTS5_SECTION_MARKER);
  if (ftsIdx < 0) return null;
  // FTS ends after the update trigger; required tables and indexes follow it.
  const fts = schema.slice(ftsIdx).match(
    /^[\s\S]*?CREATE TRIGGER IF NOT EXISTS nodes_au\b[\s\S]*?END;/
  )?.[0];
  if (!fts) throw new Error('schema.sql: FTS5 update trigger not found');
  return { pre: schema.slice(0, ftsIdx), fts, post: schema.slice(ftsIdx + fts.length) };
}
