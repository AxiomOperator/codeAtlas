/**
 * Git Sync Hooks Tests
 *
 * Covers installing/removing the opt-in commit/merge/checkout hooks that
 * keep the index fresh when the live watcher is disabled (issue #199).
 * Exercises real git repos in temp dirs — no mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  hookInterpreter,
  installGitSyncHook,
  removeGitSyncHook,
  isSyncHookInstalled,
  isGitRepo,
  DEFAULT_SYNC_HOOKS,
} from '../src/sync/git-hooks';

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function isExecutable(file: string): boolean {
  if (process.platform === 'win32') return true; // mode bits not meaningful
  return (fs.statSync(file).mode & 0o111) !== 0;
}

describe('git sync hooks', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-githooks-'));
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('installs all default hooks, executable, invoking codegraph sync', () => {
    gitInit(repo);
    const result = installGitSyncHook(repo);

    expect(result.installed.sort()).toEqual([...DEFAULT_SYNC_HOOKS].sort());
    expect(result.skipped).toBeUndefined();

    for (const hook of DEFAULT_SYNC_HOOKS) {
      const file = path.join(repo, '.git', 'hooks', hook);
      expect(fs.existsSync(file)).toBe(true);
      const body = fs.readFileSync(file, 'utf8');
      expect(body).toContain('codegraph sync');
      expect(body).toContain('command -v codegraph'); // no-op when not on PATH
      expect(isExecutable(file)).toBe(true);
    }
    expect(isSyncHookInstalled(repo)).toBe(true);
  });

  it('is idempotent — re-install does not duplicate the block', () => {
    gitInit(repo);
    installGitSyncHook(repo);
    installGitSyncHook(repo);

    const body = fs.readFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), 'utf8');
    const occurrences = body.split('# >>> codegraph sync hook >>>').length - 1;
    expect(occurrences).toBe(1);
  });

  it('preserves a pre-existing user hook and appends our block', () => {
    gitInit(repo);
    const file = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(file, '#!/bin/sh\necho "my custom hook"\n', { mode: 0o755 });

    installGitSyncHook(repo, ['post-commit']);

    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain('echo "my custom hook"');
    expect(body).toContain('codegraph sync');
  });

  it('remove strips our block; deletes a hook that was only ours', () => {
    gitInit(repo);
    installGitSyncHook(repo, ['post-commit']);
    const file = path.join(repo, '.git', 'hooks', 'post-commit');
    expect(fs.existsSync(file)).toBe(true);

    const result = removeGitSyncHook(repo, ['post-commit']);
    expect(result.installed).toEqual(['post-commit']);
    expect(fs.existsSync(file)).toBe(false); // was ours-only → deleted
    expect(isSyncHookInstalled(repo)).toBe(false);
  });

  it('remove keeps user content when the hook is shared', () => {
    gitInit(repo);
    const file = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(file, '#!/bin/sh\necho "keep me"\n', { mode: 0o755 });
    installGitSyncHook(repo, ['post-commit']);

    removeGitSyncHook(repo, ['post-commit']);

    expect(fs.existsSync(file)).toBe(true);
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain('echo "keep me"');
    expect(body).not.toContain('codegraph sync');
  });

  it('inserts the block before a trailing top-level exit, and remove round-trips exactly', () => {
    gitInit(repo);
    const file = path.join(repo, '.git', 'hooks', 'post-commit');
    const original = '#!/bin/sh\necho "lint"\nexit 0\n';
    fs.writeFileSync(file, original, { mode: 0o755 });

    installGitSyncHook(repo, ['post-commit']);
    const body = fs.readFileSync(file, 'utf8');
    expect(body.indexOf('codegraph sync')).toBeLessThan(body.indexOf('exit 0'));
    expect(body.trimEnd().endsWith('exit 0')).toBe(true);

    // Re-install stays idempotent and still before the exit.
    installGitSyncHook(repo, ['post-commit']);
    expect(fs.readFileSync(file, 'utf8')).toBe(body);

    removeGitSyncHook(repo, ['post-commit']);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('inserts before a trailing exec (husky-style) but not before an indented exit', () => {
    gitInit(repo);
    const execHook = path.join(repo, '.git', 'hooks', 'post-merge');
    fs.writeFileSync(execHook, '#!/usr/bin/env bash\nexec npx something "$@"\n', { mode: 0o755 });
    const ifHook = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(ifHook, '#!/bin/sh\nif [ -n "$X" ]; then\n  exit 1\nfi\n', { mode: 0o755 });

    installGitSyncHook(repo, ['post-merge', 'post-checkout']);
    const execBody = fs.readFileSync(execHook, 'utf8');
    expect(execBody.indexOf('codegraph sync')).toBeLessThan(execBody.indexOf('exec npx'));
    const ifBody = fs.readFileSync(ifHook, 'utf8');
    expect(ifBody.indexOf('codegraph sync')).toBeGreaterThan(ifBody.indexOf('fi\n'));
  });

  it('leaves non-shell hooks untouched and returns a note', () => {
    gitInit(repo);
    const file = path.join(repo, '.git', 'hooks', 'post-commit');
    const original = '#!/usr/bin/env python3\nprint("hi")\n';
    fs.writeFileSync(file, original, { mode: 0o755 });

    const result = installGitSyncHook(repo, ['post-commit']);
    expect(result.installed).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(result.notes.join('\n')).toMatch(/python3 hook.*codegraph sync/s);
    expect(isSyncHookInstalled(repo, ['post-commit'])).toBe(false);
  });

  it('edits hooks with no shebang or a zsh shebang', () => {
    gitInit(repo);
    const a = path.join(repo, '.git', 'hooks', 'post-commit');
    const b = path.join(repo, '.git', 'hooks', 'post-merge');
    fs.writeFileSync(a, 'echo plain\n', { mode: 0o755 });
    fs.writeFileSync(b, '#!/usr/bin/env -S zsh -e\necho z\n', { mode: 0o755 });
    const result = installGitSyncHook(repo, ['post-commit', 'post-merge']);
    expect(result.installed.sort()).toEqual(['post-commit', 'post-merge']);
    expect(result.notes).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')('does not re-enable a disabled (non-executable) hook', () => {
    gitInit(repo);
    const file = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(file, '#!/bin/sh\necho off\n', { mode: 0o644 });
    fs.chmodSync(file, 0o644);

    const result = installGitSyncHook(repo, ['post-commit']);
    expect(result.installed).toEqual([]);
    expect(isExecutable(file)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('#!/bin/sh\necho off\n');
    expect(result.notes.join('\n')).toMatch(/not executable/);
  });

  it.runIf(process.platform !== 'win32')('remove keeps the mode of a shared hook', () => {
    gitInit(repo);
    const file = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(file, '#!/bin/sh\necho keep\n', { mode: 0o750 });
    fs.chmodSync(file, 0o750);
    installGitSyncHook(repo, ['post-commit']);
    removeGitSyncHook(repo, ['post-commit']);
    expect(fs.statSync(file).mode & 0o777).toBe(0o750);
  });

  it('refuses a tracked core.hooksPath (husky) unless forced; uninstall removes only our block', () => {
    gitInit(repo);
    const husky = path.join(repo, '.husky');
    fs.mkdirSync(husky);
    const hookFile = path.join(husky, 'post-commit');
    const original = '#!/bin/sh\necho team hook\n';
    fs.writeFileSync(hookFile, original, { mode: 0o755 });
    execFileSync('git', ['add', '.husky'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: repo, stdio: 'ignore' });

    const refused = installGitSyncHook(repo, ['post-commit']);
    expect(refused.installed).toEqual([]);
    expect(refused.notes.join('\n')).toMatch(/tracked in this repository/);
    expect(refused.notes.join('\n')).toMatch(/--force-hooks-path/);
    expect(fs.readFileSync(hookFile, 'utf8')).toBe(original);

    const forced = installGitSyncHook(repo, ['post-commit'], { forceHooksPath: true });
    expect(forced.installed).toEqual(['post-commit']);
    expect(fs.readFileSync(hookFile, 'utf8')).toContain('codegraph sync');

    removeGitSyncHook(repo, ['post-commit']);
    expect(fs.readFileSync(hookFile, 'utf8')).toBe(original);
  });

  it('refuses a core.hooksPath outside the repository unless forced', () => {
    gitInit(repo);
    const globalHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-global-hooks-'));
    try {
      execFileSync('git', ['config', 'core.hooksPath', globalHooks], { cwd: repo, stdio: 'ignore' });
      const refused = installGitSyncHook(repo, ['post-commit']);
      expect(refused.installed).toEqual([]);
      expect(refused.notes.join('\n')).toMatch(/outside this repository/);
      expect(fs.existsSync(path.join(globalHooks, 'post-commit'))).toBe(false);

      const forced = installGitSyncHook(repo, ['post-commit'], { forceHooksPath: true });
      expect(forced.installed).toEqual(['post-commit']);
      removeGitSyncHook(repo, ['post-commit']);
      expect(fs.existsSync(path.join(globalHooks, 'post-commit'))).toBe(false);
    } finally {
      fs.rmSync(globalHooks, { recursive: true, force: true });
    }
  });

  it('honors core.hooksPath', () => {
    gitInit(repo);
    const customHooks = path.join(repo, '.husky');
    fs.mkdirSync(customHooks);
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: repo, stdio: 'ignore' });

    const result = installGitSyncHook(repo, ['post-commit']);
    expect(result.hooksDir).toBe(customHooks);
    expect(fs.existsSync(path.join(customHooks, 'post-commit'))).toBe(true);
    // The default .git/hooks dir should NOT have received the hook.
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  it('skips cleanly when not a git repository', () => {
    expect(isGitRepo(repo)).toBe(false);
    const result = installGitSyncHook(repo);
    expect(result.installed).toEqual([]);
    expect(result.hooksDir).toBeNull();
    expect(result.skipped).toMatch(/not a git repository/);
    expect(isSyncHookInstalled(repo)).toBe(false);
  });

  it('parses hook interpreters from shebangs', () => {
    expect(hookInterpreter('echo hi')).toBeNull();
    expect(hookInterpreter('#!/bin/sh\n')).toBe('sh');
    expect(hookInterpreter('#!/usr/bin/env bash\n')).toBe('bash');
    expect(hookInterpreter('#!/usr/bin/env -S node --no-warnings\n')).toBe('node');
    expect(hookInterpreter('#!/usr/bin/python3\r\n')).toBe('python3');
  });
});
