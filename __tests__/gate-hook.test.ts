/**
 * `codegraph gate-hook` (#2313) — the opt-in Claude Code PreToolUse hook that
 * holds text search until a session has asked CodeGraph once.
 *
 * Pure decision logic first (no filesystem), then the per-session marker
 * store, then the built CLI end-to-end against a real index (exit 2 + stderr
 * reason on deny; silent exit 0 everywhere else — it must fail OPEN).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import CodeGraph from '../src/index';
import {
  decideGate,
  bashSearchHead,
  isCodegraphCliQuery,
  isCodegraphMcpTool,
  hasGateMarker,
  writeGateMarker,
  pruneGateMarkers,
  type GateDeps,
} from '../src/hooks/gate-hook';

const ROOT = path.resolve('/work/repo');

function deps(opts: { indexed?: boolean; marked?: boolean } = {}): GateDeps {
  const { indexed = true, marked = false } = opts;
  return {
    findIndexedRoot: (p) => (indexed && path.resolve(p).startsWith(ROOT) ? ROOT : null),
    hasMarker: () => marked,
  };
}

const pre = (tool_name: string, tool_input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: ROOT, ...extra,
});

describe('gate-hook decision', () => {
  it('denies Grep and Glob in an indexed project before any CodeGraph call', () => {
    for (const tool of ['Grep', 'Glob']) {
      const d = decideGate(pre(tool, { pattern: 'handleLogin' }), deps());
      expect(d.action).toBe('deny');
      if (d.action === 'deny') expect(d.reason).toMatch(/codegraph_explore/);
    }
  });

  it('allows everything once the session has a marker', () => {
    expect(decideGate(pre('Grep', { pattern: 'x' }), deps({ marked: true })).action).toBe('allow');
    expect(decideGate(pre('Bash', { command: 'rg foo' }), deps({ marked: true })).action).toBe('allow');
  });

  it('never gates an un-indexed project (or a search path outside the index)', () => {
    expect(decideGate(pre('Grep', { pattern: 'x' }), deps({ indexed: false })).action).toBe('allow');
    expect(decideGate(pre('Grep', { pattern: 'x', path: '/etc' }), deps()).action).toBe('allow');
  });

  it('marks the session on a CodeGraph MCP call, however the server is namespaced', () => {
    expect(decideGate(pre('mcp__codegraph__codegraph_explore', { query: 'q' }), deps()).action).toBe('mark');
    expect(decideGate(pre('mcp__plugin_cg_codegraph__codegraph_explore', { query: 'q' }), deps()).action).toBe('mark');
    expect(isCodegraphMcpTool('mcp__other__search')).toBe(false);
  });

  it('marks the session on a codegraph CLI query run through Bash', () => {
    expect(decideGate(pre('Bash', { command: 'codegraph explore "login flow"' }), deps()).action).toBe('mark');
    expect(decideGate(pre('Bash', { command: 'npx @colbymchenry/codegraph node AuthService' }), deps()).action).toBe('mark');
    // `codegraph status` is not a query.
    expect(isCodegraphCliQuery('codegraph status')).toBe(false);
  });

  it('gates Bash search heads but not pipe targets or non-search commands', () => {
    expect(decideGate(pre('Bash', { command: 'rg -n handleLogin src' }), deps()).action).toBe('deny');
    expect(decideGate(pre('Bash', { command: 'cd src && grep -rn foo .' }), deps()).action).toBe('deny');
    expect(decideGate(pre('Bash', { command: 'FOO=1 find . -name "*.ts"' }), deps()).action).toBe('deny');
    expect(decideGate(pre('Bash', { command: 'pnpm test 2>&1 | grep FAIL' }), deps()).action).toBe('allow');
    expect(decideGate(pre('Bash', { command: 'git status' }), deps()).action).toBe('allow');
    expect(decideGate(pre('Bash', { command: 'npm run build' }), deps()).action).toBe('allow');
  });

  it('allows searches that target node_modules, but not a repo-wide search excluding it', () => {
    expect(decideGate(pre('Grep', { pattern: 'x', path: 'node_modules/react' }), deps()).action).toBe('allow');
    expect(decideGate(pre('Bash', { command: 'grep -rn useState node_modules/react' }), deps()).action).toBe('allow');
    expect(decideGate(pre('Bash', { command: 'grep -rn useState . --exclude-dir node_modules' }), deps()).action).toBe('deny');
    expect(decideGate(pre('Bash', { command: "rg useState -g '!node_modules'" }), deps()).action).toBe('deny');
  });

  it('fails open on malformed input, other tools, other events, or a missing session id', () => {
    expect(decideGate({}, deps()).action).toBe('allow');
    expect(decideGate({ tool_name: 42 } as never, deps()).action).toBe('allow');
    expect(decideGate(pre('Read', { file_path: 'a.ts' }), deps()).action).toBe('allow');
    expect(decideGate(pre('Grep', { pattern: 'x' }, { hook_event_name: 'PostToolUse' }), deps()).action).toBe('allow');
    expect(decideGate(pre('Grep', { pattern: 'x' }, { session_id: undefined }), deps()).action).toBe('allow');
    expect(decideGate(pre('Bash', { command: 42 }), deps()).action).toBe('allow');
  });

  it('finds the search head past wrappers and in later statements', () => {
    expect(bashSearchHead('sudo rg foo')?.cmd).toBe('rg');
    expect(bashSearchHead('echo hi; /usr/bin/grep -r x .')?.cmd).toBe('grep');
    expect(bashSearchHead('cat file | grep x')).toBeNull();
  });
});

describe('gate-hook session markers', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-gate-markers-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips a marker per session id (and keys odd ids safely)', () => {
    expect(hasGateMarker('abc-123', dir)).toBe(false);
    writeGateMarker('abc-123', dir);
    expect(hasGateMarker('abc-123', dir)).toBe(true);
    expect(hasGateMarker('other', dir)).toBe(false);
    writeGateMarker('../../etc/passwd', dir);
    expect(hasGateMarker('../../etc/passwd', dir)).toBe(true);
    for (const name of fs.readdirSync(dir)) expect(name).not.toMatch(/[\\/.]/);
  });

  it('prunes markers older than a day', () => {
    writeGateMarker('old', dir);
    const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fs.utimesSync(path.join(dir, 'old'), old / 1000, old / 1000);
    writeGateMarker('fresh', dir);
    pruneGateMarkers(dir);
    expect(hasGateMarker('old', dir)).toBe(false);
    expect(hasGateMarker('fresh', dir)).toBe(true);
  });
});

describe('gate-hook CLI (built)', () => {
  let tmp: string;
  let unindexed: string;
  const session = `test-${process.pid}-${Date.now()}`;

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-gate-cli-')));
    unindexed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-gate-plain-')));
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'export function handleLogin() { return 1; }\n');
    const cg = await CodeGraph.init(tmp, { silent: true });
    try { await cg.indexAll(); } finally { cg.destroy(); }
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(unindexed, { recursive: true, force: true });
  });

  function run(payload: unknown, env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [path.resolve(__dirname, '../dist/bin/codegraph.js'), 'gate-hook'], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_NO_RELAUNCH: '1', CODEGRAPH_WASM_RELAUNCHED: '1',
        CODEGRAPH_NO_GATE_HOOK: '0',
        ...env,
      },
    });
  }

  it('denies with exit 2 + reason until a codegraph MCP call, then allows', () => {
    const grep = { session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'handleLogin' }, cwd: tmp };
    const denied = run(grep);
    expect(denied.status).toBe(2);
    expect(denied.stderr).toMatch(/codegraph_explore/);
    expect(denied.stdout).toBe('');

    const mark = run({ ...grep, tool_name: 'mcp__codegraph__codegraph_explore', tool_input: { query: 'handleLogin' } });
    expect(mark.status).toBe(0);
    expect(mark.stdout + mark.stderr).toBe('');

    const allowed = run(grep);
    expect(allowed.status).toBe(0);
    expect(allowed.stdout + allowed.stderr).toBe('');
  });

  it('exits 0 silently for an un-indexed project, garbage stdin, and the kill-switch', () => {
    const grep = { session_id: `${session}-b`, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' }, cwd: unindexed };
    for (const r of [
      run(grep),
      run('not json {'),
      run({ ...grep, cwd: tmp }, { CODEGRAPH_NO_GATE_HOOK: '1' }),
    ]) {
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toBe('');
    }
  });
});
