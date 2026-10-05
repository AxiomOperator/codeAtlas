/**
 * Per-file facts as a public query: is this a test suite (#1877), and which
 * package owns it (#1871) — on the library API and in `codegraph files --json`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, findOwningManifest, isTestPath } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function runJson(cwd: string, args: string[]): any {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: {
      ...process.env,
      CODEGRAPH_NO_DAEMON: '1',
      CODEGRAPH_TELEMETRY: '0',
      CODEGRAPH_NO_UPDATE_CHECK: '1',
      NO_COLOR: '1',
    },
  });
  expect(result.status, (result.stdout ?? '') + (result.stderr ?? '')).toBe(0);
  return JSON.parse(result.stdout);
}

describe('owning manifest and test-path queries (#1871, #1877)', () => {
  let dir: string;
  let cg: CodeGraph;

  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-file-facts-'));
    // Nameless workspace root: must be stepped over, never claim a file.
    write('package.json', JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    write('packages/ui/package.json', JSON.stringify({ name: '@acme/ui' }));
    write('packages/ui/src/button.ts', 'export function button(): void {}\n');
    write('packages/ui/src/button.test.ts', 'import { button } from "./button";\nbutton();\n');
    // Same directory, two manifests: package.json wins deterministically.
    write('packages/mixed/package.json', JSON.stringify({ name: 'mixed-npm' }));
    write('packages/mixed/composer.json', JSON.stringify({ name: 'acme/mixed' }));
    write('packages/mixed/index.ts', 'export const mixed = 1;\n');
    write('crates/Cargo.toml', '[workspace]\nmembers = ["core"]\n');
    write('crates/core/Cargo.toml', '[package]\nversion = "0.1.0"\nname = "acme-core"\n\n[dependencies]\nname-helper = "1"\n');
    write('crates/core/src/lib.rs', 'pub fn core() {}\n');
    write('svc/go.mod', 'module github.com/acme/svc // the service\n\ngo 1.22\n');
    write('svc/internal/handler.go', 'package internal\n\nfunc Handle() {}\n');
    write('svc/internal/handler_test.go', 'package internal\n\nfunc TestHandle() {}\n');
    write('py/pyproject.toml', '[tool.poetry]\nname = "acme-py"\nversion = "1.0"\n');
    write('py/acme/main.py', 'def main():\n    pass\n');
    write('php/composer.json', JSON.stringify({ name: 'acme/php' }));
    write('php/src/App.php', '<?php\nclass App {}\n');
    write('loose/orphan.ts', 'export const orphan = 1;\n');

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves each file to its nearest named manifest', () => {
    expect(cg.getOwningManifest('packages/ui/src/button.ts')).toEqual({
      name: '@acme/ui', kind: 'npm', manifestPath: 'packages/ui/package.json', dir: 'packages/ui',
    });
    expect(cg.getOwningManifest('crates/core/src/lib.rs')).toMatchObject({ name: 'acme-core', kind: 'cargo' });
    expect(cg.getOwningManifest('svc/internal/handler.go')).toMatchObject({
      name: 'github.com/acme/svc', kind: 'go', dir: 'svc',
    });
    expect(cg.getOwningManifest('py/acme/main.py')).toMatchObject({ name: 'acme-py', kind: 'python' });
    expect(cg.getOwningManifest('php/src/App.php')).toMatchObject({ name: 'acme/php', kind: 'composer' });
  });

  it('prefers package.json when two manifests share a directory', () => {
    expect(cg.getOwningManifest('packages/mixed/index.ts')).toMatchObject({ name: 'mixed-npm', kind: 'npm' });
  });

  it('steps over nameless manifests and returns null when nothing names a package', () => {
    expect(cg.getOwningManifest('loose/orphan.ts')).toBeNull();
  });

  it('accepts absolute paths and refuses paths outside the project', () => {
    expect(cg.getOwningManifest(path.join(dir, 'packages/ui/src/button.ts'))?.name).toBe('@acme/ui');
    expect(cg.getOwningManifest(path.join(os.tmpdir(), 'elsewhere', 'x.ts'))).toBeNull();
    expect(cg.getOwningManifest('../outside.ts')).toBeNull();
  });

  it('batch lookup matches single lookups', () => {
    const files = ['packages/ui/src/button.ts', 'packages/ui/src/button.test.ts', 'loose/orphan.ts', 'py/acme/main.py'];
    const batch = cg.getOwningManifests(files);
    for (const f of files) expect(batch.get(f)).toEqual(cg.getOwningManifest(f));
    // The standalone helper is the same derivation.
    expect(findOwningManifest(dir, 'py/acme/main.py')).toEqual(cg.getOwningManifest('py/acme/main.py'));
  });

  it('answers the test-suite question per file with the shared predicate', () => {
    expect(cg.isTestPath('packages/ui/src/button.test.ts')).toBe(true);
    expect(cg.isTestPath('svc/internal/handler_test.go')).toBe(true);
    expect(cg.isTestPath(path.join(dir, 'svc/internal/handler_test.go'))).toBe(true);
    expect(cg.isTestPath('packages/ui/src/button.ts')).toBe(false);
    // Narrow reading: a fixture is not a test suite.
    expect(cg.isTestPath('fixtures/data.ts')).toBe(false);
    expect(cg.isTestPath('x/foo.test.ts')).toBe(isTestPath('x/foo.test.ts'));
  });

  it('files --json carries isTest and the owning package; --tests/--no-tests filter', () => {
    const files = runJson(dir, ['files', '--json']);
    const byPath = new Map<string, any>(files.map((f: any) => [f.path, f]));
    expect(byPath.get('packages/ui/src/button.test.ts')).toMatchObject({
      isTest: true,
      package: { name: '@acme/ui', kind: 'npm', manifest: 'packages/ui/package.json', dir: 'packages/ui' },
    });
    expect(byPath.get('packages/ui/src/button.ts').isTest).toBe(false);
    expect(byPath.get('loose/orphan.ts').package).toBeNull();

    const tests = runJson(dir, ['files', '--json', '--tests']).map((f: any) => f.path).sort();
    expect(tests).toEqual(['packages/ui/src/button.test.ts', 'svc/internal/handler_test.go']);
    const nonTests = runJson(dir, ['files', '--json', '--no-tests']);
    expect(nonTests.length).toBe(files.length - 2);
    expect(nonTests.every((f: any) => f.isTest === false)).toBe(true);
  });
});
