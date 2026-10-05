/**
 * Git Sync Hooks
 *
 * When the live file watcher is disabled (e.g. on WSL2 `/mnt/*` drives,
 * see watch-policy.ts), the CodeGraph index would otherwise go stale until
 * the user runs `codegraph sync` by hand. As an opt-in alternative, we can
 * install git hooks that refresh the index after the operations that change
 * files on disk: commit, merge (covers `git pull`), and checkout.
 *
 * The hooks run `codegraph sync` in the background so they never block git,
 * and are guarded by `command -v codegraph` so they no-op cleanly when the
 * CLI isn't on PATH. Our snippet is delimited by marker comments so install
 * is idempotent and removal preserves any user-authored hook content.
 *
 * We are conservative about hooks we did not write:
 * - only shell hooks are edited (a python/node hook would break on a shell
 *   snippet) — others get a note telling the user what to add;
 * - our block goes BEFORE a trailing top-level `exit` / `exec`, which would
 *   otherwise make it unreachable;
 * - an existing hook that is not executable was disabled on purpose, so it
 *   is left alone (never chmod'ed back on);
 * - a `core.hooksPath` that is tracked in the repo (husky, …) or lives
 *   outside it (a global hooks dir) is shared state, so it is only edited
 *   with an explicit opt-in (`forceHooksPath`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const MARKER_BEGIN = '# >>> codegraph sync hook >>>';
const MARKER_END = '# <<< codegraph sync hook <<<';

export type GitHookName = 'post-commit' | 'post-merge' | 'post-checkout';

/** Hooks installed by default: commit, merge (git pull), and checkout. */
export const DEFAULT_SYNC_HOOKS: GitHookName[] = ['post-commit', 'post-merge', 'post-checkout'];

/** The line a user can add to their own hook to get the same behavior. */
export const SYNC_HOOK_LINE = '( codegraph sync >/dev/null 2>&1 & ) >/dev/null 2>&1';

export interface GitHookResult {
  /** Hook names that were created or updated (removed, for removeGitSyncHook). */
  installed: GitHookName[];
  /** Resolved hooks directory, or null when not a git repo. */
  hooksDir: string | null;
  /** Reason nothing happened (e.g. not a git repository). */
  skipped?: string;
  /**
   * Notes about hooks deliberately left alone (non-shell hook, disabled hook,
   * shared `core.hooksPath`), each telling the user how to wire the sync line
   * in themselves. Empty when there is nothing to say.
   */
  notes: string[];
}

export interface InstallGitSyncHookOptions {
  /**
   * Edit hooks inside a `core.hooksPath` directory even when it is tracked in
   * the repo (husky, …) or lives outside the repo (a global hooks dir shared
   * by every repository). Off by default.
   */
  forceHooksPath?: boolean;
}

function git(projectRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000, // fail fast instead of hanging init/sync on a stuck git (#1139)
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Whether `projectRoot` is inside a git working tree. Returns false if git
 * isn't installed or the path isn't a repo.
 */
export function isGitRepo(projectRoot: string): boolean {
  return git(projectRoot, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/**
 * Resolve the git hooks directory for a project, honoring `core.hooksPath`
 * and git worktrees. Returns an absolute path, or null when not a repo.
 */
function gitHooksDir(projectRoot: string): string | null {
  const out = git(projectRoot, ['rev-parse', '--git-path', 'hooks']);
  if (!out) return null;
  return path.isAbsolute(out) ? out : path.resolve(projectRoot, out);
}

function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * When `core.hooksPath` points somewhere we should not edit without consent,
 * return why (for the user-facing note). Null when the hooks dir is the
 * repo's own private `.git/hooks` or an untracked, unignored in-repo dir.
 */
function sharedHooksPathReason(projectRoot: string, hooksDir: string): string | null {
  const configured = git(projectRoot, ['config', '--get', 'core.hooksPath']);
  if (!configured) return null; // default .git/hooks (incl. a worktree's common dir) — private to this clone

  const top = git(projectRoot, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const topReal = realpathOrResolve(top);
  const dirReal = realpathOrResolve(hooksDir);
  if (!isWithin(dirReal, topReal)) {
    return `core.hooksPath points at ${hooksDir}, outside this repository (a hooks directory shared with other repositories)`;
  }
  // Tracked hooks dir (husky v4–8 `.husky/`, a committed `githooks/`, …).
  const tracked = git(projectRoot, ['ls-files', '--', dirReal]);
  if (tracked) {
    return `core.hooksPath points at ${hooksDir}, which is tracked in this repository (shared with everyone who clones it)`;
  }
  // Generated by a hook manager and git-ignored (husky v9 `.husky/_`) — it
  // would overwrite our edit on its next run anyway.
  const probe = path.join(dirReal, 'post-commit');
  try {
    execFileSync('git', ['check-ignore', '-q', '--', probe], {
      cwd: projectRoot, stdio: 'ignore', windowsHide: true, timeout: 5000,
    });
    return `core.hooksPath points at ${hooksDir}, which is generated by a hook manager (git-ignored)`;
  } catch {
    /* not ignored (exit 1) or git error — treat as a plain local dir */
  }
  return null;
}

/** The shell snippet (between markers) injected into each hook. */
function markerBlock(): string {
  return [
    MARKER_BEGIN,
    '# Keeps the CodeGraph index fresh while the live file watcher is off',
    '# (e.g. WSL2 /mnt drives). Runs in the background so it never blocks git.',
    '# Managed by codegraph; remove with `codegraph uninit` or delete this block.',
    'if command -v codegraph >/dev/null 2>&1; then',
    `  ${SYNC_HOOK_LINE}`,
    'fi',
    MARKER_END,
  ].join('\n');
}

/**
 * Remove our marker block (and the marker lines) from hook content. When the
 * block was inserted before a trailing `exit`/`exec`, the single blank line
 * we added after it is removed too, so install → remove round-trips exactly.
 */
function stripMarkerBlock(content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let inBlock = false;
  let dropSeparator = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed === MARKER_BEGIN) { inBlock = true; continue; }
    if (trimmed === MARKER_END) { inBlock = false; dropSeparator = true; continue; }
    if (inBlock) continue;
    if (dropSeparator) {
      dropSeparator = false;
      // Our separator: a blank line that has more content after it.
      if (trimmed === '' && lines.slice(i + 1).some((l) => l.trim() !== '')) continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** Whether a hook body is just a shebang / blank lines (i.e. only ever ours). */
function isEffectivelyEmpty(content: string): boolean {
  return content
    .split('\n')
    .map((l) => l.trim())
    .every((l) => l.length === 0 || l.startsWith('#!'));
}

const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash']);

/**
 * The interpreter a hook's shebang names (`#!/usr/bin/env -S bash -e` →
 * `bash`), or null when there is no shebang (git runs it with `sh`).
 */
export function hookInterpreter(content: string): string | null {
  const first = (content.split('\n', 1)[0] ?? '').replace(/\r$/, '');
  if (!first.startsWith('#!')) return null;
  const parts = first.slice(2).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  let interp = path.posix.basename(parts[0]!.replace(/\\/g, '/'));
  if (interp === 'env') {
    const arg = parts.slice(1).find((p) => !p.startsWith('-') && !p.includes('='));
    interp = arg ? path.posix.basename(arg) : 'env';
  }
  return interp.replace(/\.exe$/i, '');
}

function isShellHook(content: string): boolean {
  const interp = hookInterpreter(content);
  return interp === null || SHELL_INTERPRETERS.has(interp);
}

/**
 * Add our block to existing (already block-free) hook content. A trailing
 * top-level `exit …` / `exec …` would make an appended block unreachable, so
 * the block goes right before it.
 */
function addBlock(base: string, block: string): string {
  const lines = base.replace(/\s*$/, '').split('\n');
  let last = lines.length - 1;
  while (last >= 0) {
    const t = (lines[last] ?? '').trim();
    if (t === '' || t.startsWith('#')) { last--; continue; }
    break;
  }
  if (last >= 0 && /^(exit|exec)(\s|;|$)/.test((lines[last] ?? '').replace(/\r$/, ''))) {
    const head = lines.slice(0, last);
    const tail = lines.slice(last);
    return [...head, block, '', ...tail].join('\n') + '\n';
  }
  return `${lines.join('\n')}\n\n${block}\n`;
}

function isExecutableFile(file: string): boolean {
  if (process.platform === 'win32') return true; // mode bits aren't meaningful
  try {
    return (fs.statSync(file).mode & 0o111) !== 0;
  } catch {
    return true;
  }
}

function chmodExecutable(file: string): void {
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    /* chmod is a no-op / unsupported on some platforms (e.g. Windows) */
  }
}

/**
 * Install (or update) the CodeGraph sync hooks in a git repository.
 * Idempotent: re-running replaces our marker block rather than duplicating
 * it, and any user-authored hook content is preserved. Hooks we must not
 * edit are reported in `notes` instead.
 */
export function installGitSyncHook(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
  options: InstallGitSyncHookOptions = {},
): GitHookResult {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) {
    return { installed: [], hooksDir: null, skipped: 'not a git repository', notes: [] };
  }

  const manualHint = `add this line to the hook yourself: ${SYNC_HOOK_LINE}`;

  if (!options.forceHooksPath) {
    const reason = sharedHooksPathReason(projectRoot, hooksDir);
    if (reason) {
      return {
        installed: [],
        hooksDir,
        skipped: 'core.hooksPath is shared',
        notes: [
          `${reason} — left untouched. To keep the index fresh, ${manualHint.replace('the hook', `your ${hooks.join(' / ')} hooks`)}` +
          ' — or re-run `codegraph init --force-hooks-path` to let CodeGraph edit them.',
        ],
      };
    }
  }

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch {
    return { installed: [], hooksDir, skipped: 'could not access the git hooks directory', notes: [] };
  }

  const block = markerBlock();
  const installed: GitHookName[] = [];
  const notes: string[] = [];

  for (const hook of hooks) {
    const file = path.join(hooksDir, hook);

    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `#!/bin/sh\n${block}\n`);
      chmodExecutable(file);
      installed.push(hook);
      continue;
    }

    const original = fs.readFileSync(file, 'utf8');
    if (!isShellHook(original)) {
      notes.push(
        `${file} is a ${hookInterpreter(original)} hook, not a shell script — left untouched. ` +
        `To keep the index fresh, have it run \`codegraph sync\` in the background (the shell equivalent is: ${SYNC_HOOK_LINE}).`,
      );
      continue;
    }
    if (!isExecutableFile(file)) {
      notes.push(
        `${file} exists but is not executable (disabled) — left untouched. ` +
        `If you re-enable it (chmod +x), ${manualHint}`,
      );
      continue;
    }

    const base = stripMarkerBlock(original);
    const content = isEffectivelyEmpty(base) && !base.trim().startsWith('#!')
      ? `#!/bin/sh\n${block}\n`
      : addBlock(base, block);
    if (content !== original) fs.writeFileSync(file, content); // keeps the file's mode
    installed.push(hook);
  }

  return { installed, hooksDir, notes };
}

/**
 * Remove the CodeGraph sync hooks. Strips only our marker block; deletes the
 * hook file entirely when nothing but a shebang remains, otherwise rewrites
 * the user's content untouched (mode preserved). Works wherever our block is
 * found — including a shared `core.hooksPath` edited with `forceHooksPath`.
 */
export function removeGitSyncHook(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): GitHookResult {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) {
    return { installed: [], hooksDir: null, skipped: 'not a git repository', notes: [] };
  }

  const removed: GitHookName[] = [];

  for (const hook of hooks) {
    const file = path.join(hooksDir, hook);
    if (!fs.existsSync(file)) continue;

    const original = fs.readFileSync(file, 'utf8');
    if (!original.includes(MARKER_BEGIN)) continue;

    const stripped = stripMarkerBlock(original);
    if (isEffectivelyEmpty(stripped)) {
      fs.unlinkSync(file);
    } else {
      fs.writeFileSync(file, `${stripped.replace(/\s*$/, '')}\n`);
    }
    removed.push(hook);
  }

  return { installed: removed, hooksDir, notes: [] };
}

/** Whether any CodeGraph sync hook is currently installed. */
export function isSyncHookInstalled(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): boolean {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) return false;
  return hooks.some((hook) => {
    const file = path.join(hooksDir, hook);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARKER_BEGIN);
  });
}
