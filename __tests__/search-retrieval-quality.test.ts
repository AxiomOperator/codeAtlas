/**
 * FTS retrieval quality (#1520): sub-word recall for camelCase / snake_case
 * names, the opaque `id` column out of matching, path scoping applied before
 * the limit, kind scoping honored by the exact-name supplement, and dedupe of
 * copied symbols.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { nameMatchBonus } from '../src/search/query-utils';
import { dedupeSearchResults, nodeScopeSql } from '../src/search/search-scope';
import type { Node, SearchResult } from '../src/types';

const HELPER = `export function scaffoldHelper(input: string): string {
  const trimmed = input.trim();
  return trimmed.toUpperCase();
}
`;

describe('searchNodes retrieval quality (#1520)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-search-quality-'));
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    write('src/http/data.ts', 'export class DataRequest {\n  url = "";\n}\n');
    write('src/http/parse.ts', 'export function parse_request(raw: string): number {\n  return raw.length;\n}\n');
    write('src/util/paths.ts', [
      'export const path = "/";',
      'export function isTestPath(p: string): boolean {',
      '  return p.includes("test");',
      '}',
      'export function renamedFunc(): void {}',
      'export function alpha(): void {}',
      'export function beta(): void {}',
      '',
    ].join('\n'));
    write('src/kinds.ts', 'export class Widget {}\nexport function widgetFactory(): Widget { return new Widget(); }\n');
    // Many same-prefixed symbols across two packages, for path scoping.
    for (const pkg of ['pkg-a', 'pkg-b']) {
      const body = Array.from({ length: 12 }, (_, i) => `export function handler${pkg.slice(-1)}${i}(): void {}`).join('\n');
      write(`${pkg}/src/handlers.ts`, body + '\n');
    }
    // Copied scaffold: identical symbol in two places, plus a same-named but
    // different symbol that must NOT be collapsed.
    write('apps/one/helper.ts', HELPER);
    write('apps/two/helper.ts', HELPER);
    write('apps/three/helper.ts', 'export function scaffoldHelper(n: number): number {\n  return n;\n}\n');

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const names = (rs: SearchResult[]) => rs.map((r) => r.node.name);

  it('finds camelCase and snake_case names by one of their words', () => {
    const got = names(cg.searchNodes('request', { limit: 10 }));
    expect(got).toContain('DataRequest');
    expect(got).toContain('parse_request');
  });

  it('sub-word recall can be switched off', () => {
    expect(names(cg.searchNodes('request', { limit: 10, subwords: false }))).not.toContain('DataRequest');
  });

  it('a multi-word query ranks the symbol covering every word above a one-word exact match', () => {
    const got = names(cg.searchNodes('test path', { limit: 5 }));
    expect(got).toContain('isTestPath');
    expect(got.indexOf('isTestPath')).toBeLessThan(got.indexOf('path') === -1 ? Infinity : got.indexOf('path'));
    expect(nameMatchBonus('isTestPath', 'test path')).toBeGreaterThan(nameMatchBonus('path', 'test path'));
  });

  it('sub-word recall requires every query word (no partial-word noise)', () => {
    expect(names(cg.searchNodes('newFunc', { limit: 10 }))).not.toContain('renamedFunc');
  });

  it('never matches the opaque id column (a kind word is not a symbol)', () => {
    // Node ids are `<kind>:<hash>`; before #1520 the query "function" matched
    // every function through its id.
    const got = names(cg.searchNodes('function', { limit: 50 }));
    expect(got).not.toContain('alpha');
    expect(got).not.toContain('beta');
  });

  it('the exact-name supplement honors the kind filter', () => {
    const rs = cg.searchNodes('Widget', { limit: 20, kinds: ['function'] });
    expect(rs.length).toBeGreaterThan(0);
    for (const r of rs) expect(r.node.kind).toBe('function');
  });

  it('scopes by path substring and glob before the limit', () => {
    const a = cg.searchNodes('handler', { limit: 5, includePatterns: ['pkg-a'] });
    expect(a).toHaveLength(5);
    for (const r of a) expect(r.node.filePath.startsWith('pkg-a/')).toBe(true);

    const b = cg.searchNodes('handler', { limit: 5, includePatterns: ['pkg-b/**/*.ts'] });
    expect(b).toHaveLength(5);
    for (const r of b) expect(r.node.filePath.startsWith('pkg-b/')).toBe(true);

    const notA = cg.searchNodes('handler', { limit: 50, excludePatterns: ['pkg-a/'] });
    expect(notA.length).toBeGreaterThan(0);
    for (const r of notA) expect(r.node.filePath.startsWith('pkg-a/')).toBe(false);
  });

  it('the path: query filter fills the page instead of filtering a truncated one', () => {
    const rs = cg.searchNodes('handler path:pkg-b', { limit: 4 });
    expect(rs).toHaveLength(4);
    for (const r of rs) expect(r.node.filePath.startsWith('pkg-b/')).toBe(true);
  });

  it('dedupe collapses identical copies and keeps distinct same-named symbols', () => {
    const all = cg.searchNodes('scaffoldHelper', { limit: 10, kinds: ['function'] });
    expect(all.filter((r) => r.node.name === 'scaffoldHelper')).toHaveLength(3);

    const deduped = cg.searchNodes('scaffoldHelper', { limit: 10, kinds: ['function'], dedupe: true })
      .filter((r) => r.node.name === 'scaffoldHelper');
    expect(deduped).toHaveLength(2);
    const collapsed = deduped.find((r) => r.duplicates && r.duplicates.length > 0)!;
    expect(collapsed).toBeDefined();
    expect(collapsed.duplicates).toHaveLength(1);
    const paths = [collapsed.node.filePath, collapsed.duplicates![0]!.filePath].sort();
    expect(paths).toEqual(['apps/one/helper.ts', 'apps/two/helper.ts']);
  });
});

describe('search scope helpers', () => {
  it('builds glob and substring path predicates', () => {
    const s = nodeScopeSql('n', { includePatterns: ['src/**/*.ts', 'Lib'], excludePatterns: ['gen'] });
    expect(s.sql).toContain('n.file_path GLOB ?');
    expect(s.sql).toContain('instr(lower(n.file_path), ?) > 0');
    expect(s.sql).toContain('AND NOT (');
    expect(s.params).toEqual(['src/*.ts', 'lib', 'gen']);
  });

  it('dedupe keeps result order and never collapses within one file', () => {
    const node = (id: string, filePath: string): Node => ({
      id, kind: 'function', name: 'f', qualifiedName: 'f', filePath, language: 'typescript',
      startLine: 1, endLine: 3, startColumn: 0, endColumn: 0, updatedAt: 0,
    } as Node);
    const out = dedupeSearchResults([
      { node: node('1', 'a.ts'), score: 3 },
      { node: node('2', 'a.ts'), score: 2 },
      { node: node('3', 'b.ts'), score: 1 },
    ]);
    expect(out.map((r) => r.node.id)).toEqual(['1', '2']);
    expect(out[0]!.duplicates).toEqual([{ id: '3', filePath: 'b.ts', startLine: 1 }]);
  });
});
