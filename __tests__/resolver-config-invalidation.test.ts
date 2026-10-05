/**
 * Resolver config caches in a long-lived process (R-RES1).
 *
 * tsconfig `paths`, go.mod, workspace packages and compile_commands.json were
 * loaded once per resolver and never reset, so a daemon/watch-mode instance
 * kept resolving imports through stale config until restart. `sync` now drops
 * those caches and, when the PARSED config changed, re-extracts the files whose
 * imports it governs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { isResolutionConfigFile } from '../src/sync/watcher';

function writeTsconfig(dir: string, target: string): void {
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': [`${target}/*`] } } }, null, 2)
  );
}

describe('resolver config caches (long-lived instance)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-res-config-'));
    fs.mkdirSync(path.join(dir, 'src', 'a'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a', 'util.ts'), 'export function helper() { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'src', 'b', 'util.ts'), 'export function helper() { return 2; }\n');
    fs.writeFileSync(
      path.join(dir, 'src', 'main.ts'),
      "import { helper } from '@lib/util';\nexport function run() { return helper(); }\n"
    );
    writeTsconfig(dir, 'src/a');
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
  });

  afterEach(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('re-resolves an import after tsconfig `paths` changes, without a restart', async () => {
    expect(cg.getFileDependencies('src/main.ts')).toContain('src/a/util.ts');

    writeTsconfig(dir, 'src/b');
    const result = await cg.sync();

    expect(result.filesModified).toBeGreaterThan(0);
    const deps = cg.getFileDependencies('src/main.ts');
    expect(deps).toContain('src/b/util.ts');
    expect(deps).not.toContain('src/a/util.ts');
  });

  it('does not re-extract anything when the config is unchanged', async () => {
    const first = await cg.sync();
    expect(first.filesModified).toBe(0);
    // Rewriting tsconfig with the same parsed content is not a config change.
    writeTsconfig(dir, 'src/a');
    const second = await cg.sync();
    expect(second.filesModified).toBe(0);
    expect(cg.getFileDependencies('src/main.ts')).toContain('src/a/util.ts');
  });

  it('the watcher treats resolver config files as sync triggers', () => {
    for (const f of ['tsconfig.json', 'apps/web/tsconfig.app.json', 'jsconfig.json', 'package.json',
      'packages/x/package.json', 'go.mod', 'build/compile_commands.json', 'pnpm-workspace.yaml']) {
      expect(isResolutionConfigFile(f)).toBe(true);
    }
    for (const f of ['src/tsconfig.ts', 'package-lock.json', 'go.sum', 'README.md']) {
      expect(isResolutionConfigFile(f)).toBe(false);
    }
  });
});
