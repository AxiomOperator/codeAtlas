/**
 * Stale-extraction-version notice on MCP read tools (#1852): once per session
 * per project, never isError, never blocking; `codegraph_status` always
 * reports the build details.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler, __setLoadCodeGraphForTests } from '../src/mcp/tools';
import { ExploreSessionState } from '../src/mcp/explore-session-state';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';
import { describeIndexBuild, formatIndexVersionNotice } from '../src/mcp/response-decorators';

const NOTICE = 'index was built by';

async function makeProject(prefix: string, stale: boolean): Promise<{ dir: string; cg: CodeGraph }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export function hello() { return world(); }\nexport function world() { return 1; }\n');
  const cg = await CodeGraph.init(dir, { index: false });
  await cg.indexAll();
  if (stale) {
    (cg as unknown as { queries: { setMetadata(k: string, v: string): void } }).queries.setMetadata(
      'indexed_with_extraction_version',
      String(EXTRACTION_VERSION - 1),
    );
  }
  return { dir, cg };
}

function text(r: { content: Array<{ text: string }> }): string {
  return r.content[0]?.text ?? '';
}

describe('index extraction-version notice (#1852)', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!();
  });
  const track = (p: { dir: string; cg: CodeGraph }) => {
    cleanup.push(() => {
      try { p.cg.destroy(); } catch { /* closed */ }
      fs.rmSync(p.dir, { recursive: true, force: true });
    });
    return p;
  };

  it('warns on the first successful read-tool response only, per session', async () => {
    const { cg, dir } = track(await makeProject('cg-1852-stale-', true));
    const handler = new ToolHandler(cg);
    const session = new ExploreSessionState();

    const first = await handler.execute('codegraph_search', { query: 'hello' }, session);
    expect(first.isError).toBeFalsy();
    expect(text(first)).toContain(NOTICE);
    expect(text(first)).toContain(`extraction v${EXTRACTION_VERSION - 1}`);
    expect(text(first)).toContain('`codegraph index`');
    expect(text(first)).toContain(dir);
    // The answer itself is still there.
    expect(text(first)).toContain('hello');

    const second = await handler.execute('codegraph_node', { symbol: 'hello' }, session);
    expect(second.isError).toBeFalsy();
    expect(text(second)).not.toContain(NOTICE);

    // A new session gets its own one-time notice.
    const other = await handler.execute('codegraph_search', { query: 'hello' }, new ExploreSessionState());
    expect(text(other)).toContain(NOTICE);
  });

  it('stays silent for a current index', async () => {
    const { cg } = track(await makeProject('cg-1852-fresh-', false));
    const handler = new ToolHandler(cg);
    const r = await handler.execute('codegraph_search', { query: 'hello' }, new ExploreSessionState());
    expect(text(r)).not.toContain(NOTICE);
  });

  it('warns independently for each stale project reached via projectPath', async () => {
    const a = track(await makeProject('cg-1852-a-', true));
    const b = track(await makeProject('cg-1852-b-', true));
    const fresh = track(await makeProject('cg-1852-c-', false));
    a.cg.close(); b.cg.close(); fresh.cg.close();
    __setLoadCodeGraphForTests(CodeGraph);
    const handler = new ToolHandler(null);
    const session = new ExploreSessionState();
    try {
      const ra = await handler.execute('codegraph_search', { query: 'hello', projectPath: a.dir }, session);
      expect(text(ra)).toContain(NOTICE);
      expect(text(ra)).toContain(a.dir);
      const ra2 = await handler.execute('codegraph_search', { query: 'world', projectPath: a.dir }, session);
      expect(text(ra2)).not.toContain(NOTICE);
      const rb = await handler.execute('codegraph_search', { query: 'hello', projectPath: b.dir }, session);
      expect(text(rb)).toContain(NOTICE);
      expect(text(rb)).toContain(b.dir);
      const rc = await handler.execute('codegraph_search', { query: 'hello', projectPath: fresh.dir }, session);
      expect(text(rc)).not.toContain(NOTICE);
    } finally {
      await handler.closeAll();
      __setLoadCodeGraphForTests(null);
    }
  });

  it('codegraph_status always reports build details and the re-index verdict', async () => {
    const stale = track(await makeProject('cg-1852-status-', true));
    const handler = new ToolHandler(stale.cg);
    const session = new ExploreSessionState();
    for (let i = 0; i < 2; i++) {
      const r = await handler.execute('codegraph_status', {}, session);
      expect(r.isError).toBeFalsy();
      expect(text(r)).toContain('**Index built with:**');
      expect(text(r)).toContain(`extraction v${EXTRACTION_VERSION - 1}`);
      expect(text(r)).toContain('**Re-index recommended:** ⚠ yes');
    }

    const fresh = track(await makeProject('cg-1852-status-fresh-', false));
    const r2 = await new ToolHandler(fresh.cg).execute('codegraph_status', {});
    expect(text(r2)).toContain('**Re-index recommended:** no');
  });

  it('shows on every one-shot CLI call and lands in --json notices', async () => {
    const { cg } = track(await makeProject('cg-1852-cli-', true));
    const handler = new ToolHandler(cg);
    for (let i = 0; i < 2; i++) {
      const r = await handler.execute('codegraph_node', { symbol: 'hello', includeCode: true }, undefined, { structured: true });
      expect(text(r)).toContain(NOTICE);
      expect(r._cgStructured?.notices[0]).toContain(NOTICE);
    }
  });

  it('can be suppressed per call (the prompt hook does)', async () => {
    const { cg } = track(await makeProject('cg-1852-hook-', true));
    const handler = new ToolHandler(cg);
    const r = await handler.execute('codegraph_search', { query: 'hello' }, undefined, { indexVersionNotice: false });
    expect(text(r)).not.toContain(NOTICE);
  });

  it('formats a pre-stamp index honestly', () => {
    expect(describeIndexBuild({ version: null, extractionVersion: null })).toMatch(/not recorded/);
    const notice = formatIndexVersionNotice({ version: '1.0.0', extractionVersion: 3 }, 9, '/repo');
    expect(notice).toContain('CodeGraph v1.0.0, extraction v3');
    expect(notice).toContain('extraction v9');
    expect(notice).toContain('`codegraph index` in /repo');
    expect(notice).not.toMatch(/use Read/i);
  });
});

describe('ExploreSessionState.claimNotice', () => {
  let state: ExploreSessionState;
  beforeEach(() => { state = new ExploreSessionState(); });
  it('is true once per kind + project', () => {
    expect(state.claimNotice('k', '/a')).toBe(true);
    expect(state.claimNotice('k', '/a')).toBe(false);
    expect(state.claimNotice('k', '/b')).toBe(true);
    expect(state.claimNotice('other', '/a')).toBe(true);
    state.clear();
    expect(state.claimNotice('k', '/a')).toBe(true);
  });
});
