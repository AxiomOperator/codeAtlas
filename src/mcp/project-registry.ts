/**
 * Project resolution and lifetime for `ToolHandler` (`ProjectRegistry`), plus
 * its helpers: path canonicalization, the explicit-`projectPath` cache bounds
 * and idle release, and the catch-up gate timeout. Moved out of `tools.ts`
 * unchanged.
 */

import type CodeGraph from '../index';
import { findNearestCodeGraphRoot, isInitialized, isSameIndexRoot } from '../directory';
import type { WslSharedIndexError } from '../db/wsl-shared-index';
import {
  detectWorktreeIndexMismatch,
  nestedRepositoryBelow,
  type NestedRepository,
  type WorktreeIndexMismatch,
} from '../sync/worktree';
import { existsSync, realpathSync, statSync } from 'fs';
import { dirname, relative as relativePath, resolve as resolvePath } from 'path';
import { validateProjectPath } from '../utils';
import { PathRefusalError } from '../errors';
import { NotIndexedError } from './error-classifier';
import { LRUCache } from '../resolution/lru-cache';

/** Bound for the per-start-path git caches (worktree mismatch, nested repo). */
const MCP_PATH_CACHE_MAX = 256;

// Lazy-load the heavy CodeGraph chain off the MCP startup path — see the same
// helper in engine.ts. ToolHandler must load to answer tools/list (static
// schemas), but it must NOT drag in sqlite/query layers before the daemon binds;
// CodeGraph is pulled in only when a tool actually opens a project. require() is
// sync + cached (CommonJS build).
const loadCodeGraph = (): typeof import('../index').default =>
  loadCodeGraphForTests ?? (require('../index') as typeof import('../index')).default;
// Test seam (same pattern as the watcher's `__setFsWatchForTests`): vitest's
// module transform can't service the lazy `require('../index')` above, so
// in-process tests that exercise a genuine cross-project open (an explicit
// `projectPath` to a different project — issue #1474's repro shape) inject the
// already-imported class here. Never set outside tests.
let loadCodeGraphForTests: typeof import('../index').default | null = null;
export function __setLoadCodeGraphForTests(cls: typeof import('../index').default | null): void {
  loadCodeGraphForTests = cls;
}

/**
 * How long the FIRST tool call waits on the post-open catch-up reconcile before
 * giving up and serving anyway (issue #905). On a normal repo the reconcile
 * finishes in well under this, so the gate is fully honored and nothing changes.
 * On a very large repo (~100k files) the reconcile takes minutes — blocking the
 * first call on all of it presents as a multi-minute hang — so we wait briefly
 * for a clean answer, then serve and let the reconcile finish in the background
 * (it yields to the event loop, so a concurrent read still runs).
 *
 * `CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS` overrides the default; `0` restores the
 * old unbounded-wait behavior (always block until the reconcile completes).
 */
export const DEFAULT_CATCHUP_GATE_TIMEOUT_MS = 3000;
export function resolveCatchUpGateTimeoutMs(): number {
  const raw = process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_CATCHUP_GATE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CATCHUP_GATE_TIMEOUT_MS;
  return Math.floor(n);
}



/**
 * The directory a `projectPath` names: the path itself, or — when it is an
 * existing regular file — its parent directory. Never throws.
 */
export function projectDirFor(projectPath: string): string {
  try {
    if (statSync(projectPath).isFile()) return dirname(resolvePath(projectPath));
  } catch { /* missing / unreadable: resolve as given (it may walk up, #238) */ }
  return projectPath;
}



/** realpath when the path exists, the path itself otherwise — never throws. */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * How many explicit-`projectPath` projects a handler keeps open at once
 * (#1835). Each cached project may hold a file watcher, a writer lock and a
 * SQLite connection, so the cache is bounded LRU: opening one more than this
 * closes the least recently used. Small on purpose — a session that queries
 * many repositories still leaks nothing; it only pays a reopen + catch-up.
 */
export const MAX_CACHED_PROJECTS = 8;

/**
 * How long an explicit-`projectPath` project may go unused before the handler
 * releases it (#2087). Releasing frees its SQLite handle, its watcher and the
 * writer lock the engine may hold on that project — which otherwise stays held
 * for the whole life of this daemon, locking the project's own daemon and
 * `codegraph index` out. The next call reopens it and catches up.
 * `CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS` overrides it; `0` never releases.
 */
export const DEFAULT_PROJECT_IDLE_TIMEOUT_MS = 600_000;
export function resolveProjectIdleTimeoutMs(): number {
  const raw = process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_PROJECT_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PROJECT_IDLE_TIMEOUT_MS;
  return Math.floor(n);
}

/**
 * Engine-side lifecycle for a project the ToolHandler opened for an explicit
 * `projectPath` (#1835). `activate` gives it the same treatment the default
 * project gets — a file watcher while it stays open and a catch-up sync — and
 * returns the catch-up promise, which the handler awaits (time-boxed) before
 * calls against that project. `release` runs after active calls drain, so the
 * engine can release shared ownership safely on LRU eviction or shutdown.
 */
export interface ProjectLifecycle {
  open(root: string, open: () => CodeGraph): CodeGraph;
  activate(cg: CodeGraph): Promise<void>;
  release(cg: CodeGraph): void | Promise<void>;
}

/**
 * Which project a tool call runs against, and the lifetime of every project
 * the handler opened for it: the default project, the bounded LRU cache of
 * explicit-`projectPath` projects (with idle release and engine-owned
 * lifecycle), the catch-up gates a call waits on, and the memoized git checks
 * (worktree/index mismatch, uncovered nested repository). Held by
 * `ToolHandler`; moved out of it unchanged.
 */
export class ProjectRegistry {
  // Cache of opened CodeGraph instances for cross-project queries, keyed by the
  // CANONICAL (realpath) index root. Map insertion order doubles as LRU order:
  // a hit re-inserts, and `MAX_CACHED_PROJECTS` bounds the size (#1835).
  projectCache: Map<string, CodeGraph> = new Map();
  // When each cached root was last handed to a call, and the one timer that
  // releases the oldest once it has been idle long enough (#2087).
  private projectUsedAt: Map<string, number> = new Map();
  private idleReleaseTimer: NodeJS.Timeout | null = null;
  // Engine hook that watches + catches up an explicit project (null for the
  // CLI and worker-thread handlers, which never own a watcher).
  private projectLifecycle: ProjectLifecycle | null = null;
  // Every concurrent call shares its project's pending catch-up promise.
  private projectGates: Map<CodeGraph, Promise<void>> = new Map();
  activeCalls = 0;
  closing = false;
  private pendingCloses = 0;
  private closeWaiters: Array<() => void> = [];
  // The directory the server last searched for a default project. Surfaced in
  // the "not initialized" error so users can see why detection missed.
  private defaultProjectHint: string | null = null;
  // Indexed sub-projects the engine's bounded down-scan saw below the search
  // base when no default project resolved (#1607). Listed in the "not
  // initialized" error so the fact is reachable through the protocol, not just
  // the host's stderr capture. Engine-maintained (initial resolve + throttled
  // retry) — tool calls themselves never scan.
  private knownSubprojects: string[] = [];
  private knownSubprojectsBase: string | null = null;
  // Why the default project failed to open, when that is worth telling the
  // agent instead of "no project loaded" — today only the Windows/WSL
  // shared-index error (#995). Engine-maintained; cleared by a successful open.
  private defaultOpenFailure: WslSharedIndexError | null = null;
  // Per-start-path cache of the git worktree/index mismatch (issue #155). The
  // mismatch is a fixed property of (where the request came from → which
  // .codegraph/ it resolves to), so the up-to-two `git rev-parse` spawns run
  // once and every later tool call reuses the result — never shelling out to
  // git on the hot path. `undefined` = not computed yet; `null` = no mismatch.
  // LRU-bounded: a long-lived daemon serving many distinct start paths must
  // not grow it forever (R-MCP8); an evicted entry just re-runs git once.
  private worktreeMismatchCache = new LRUCache<string, WorktreeIndexMismatch | null>(MCP_PATH_CACHE_MAX);
  // Per-(projectPath, index root) cache of the different git repository the
  // path sits in below that root, if any (#2110) — the git half of
  // `uncoveredNestedRepo`, memoized like the mismatch above.
  private nestedRepoCache = new LRUCache<string, NestedRepository | null>(MCP_PATH_CACHE_MAX);
  // Gate that the MCP engine pokes after `cg.open()` so the first tool call
  // blocks on the post-open filesystem reconcile (catch-up sync). Without
  // this, a tool call that races past `catchUpSync()` serves rows for files
  // that were deleted (or edited) while no MCP server was running — and the
  // per-file staleness banner can't help, because `getPendingFiles()` is
  // populated by the watcher, not by catch-up. The wait is time-boxed
  // (see {@link resolveCatchUpGateTimeoutMs}) so a minutes-long reconcile on a
  // huge repo can't hang a call (#905); cleared when the reconcile settles.
  catchUpGate: Promise<void> | null = null;
  // Engine hook fired when `freshen` reopened a replaced database (#1902), so
  // the engine can reconcile the new file with a catch-up sync.
  private onDatabaseReopened: ((cg: CodeGraph) => void) | null = null;

  constructor(public cg: CodeGraph | null) {}

  /**
   * Engine-only: own the lifecycle (watcher, catch-up, writer lock) of every
   * project this handler opens for an explicit `projectPath` (#1835).
   */
  setProjectLifecycle(lifecycle: ProjectLifecycle | null): void {
    this.projectLifecycle = lifecycle;
  }

  /**
   * Update the default CodeGraph instance (e.g. after lazy initialization)
   */
  setDefaultCodeGraph(cg: CodeGraph): void {
    this.cg = cg;
    this.defaultOpenFailure = null;
  }

  /**
   * Engine-only: record why the default project failed to open (#995), so a
   * call that needs it answers with that fix rather than "no project loaded".
   * `null` clears it.
   */
  setDefaultOpenFailure(err: WslSharedIndexError | null): void {
    this.defaultOpenFailure = err;
  }

  /**
   * Engine-only: register the catch-up sync promise so the next `execute()`
   * call awaits it before serving. The handler swallows rejections (the
   * engine logs them) so a sync failure never propagates as a tool error;
   * we still want to serve a best-effort result over the same potentially-
   * stale data, which is what would have happened without the gate.
   */
  setCatchUpGate(p: Promise<void> | null): void {
    this.catchUpGate = p;
    void p?.then(() => {
      if (this.catchUpGate === p) this.catchUpGate = null;
    }, () => {
      if (this.catchUpGate === p) this.catchUpGate = null;
    });
  }

  /**
   * Engine-only: called after a tool call's {@link freshen} reopened a database
   * that was replaced on disk (#1902). The engine decides whether a catch-up
   * sync is its to run (only for the instance it watches and writes).
   */
  setOnDatabaseReopened(fn: ((cg: CodeGraph) => void) | null): void {
    this.onDatabaseReopened = fn;
  }

  /**
   * Await the catch-up gate, but no longer than the configured timeout (#905).
   * If the reconcile settles first, we got the fully-reconciled answer. If the
   * timeout wins, we serve the call now and let the reconcile finish in the
   * background — it yields to the event loop (see SYNC_RECONCILE_YIELD_INTERVAL),
   * so a concurrent read still runs against the same connection. Never throws:
   * a failed reconcile is logged by the engine, and we serve best-effort over
   * the same potentially-stale data the un-gated path would have.
   */
  async awaitCatchUpGate(gate: Promise<void>): Promise<void> {
    const timeoutMs = resolveCatchUpGateTimeoutMs();
    if (timeoutMs <= 0) {
      // 0 = opt back into the original unbounded wait.
      try { await gate; } catch { /* engine already logged */ }
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([
        gate.then(() => 'done' as const, () => 'done' as const),
        timedOut,
      ]);
      if (outcome === 'timeout') {
        process.stderr.write(
          `[CodeGraph MCP] Catch-up reconcile still running after ${timeoutMs}ms; serving this tool call now and finishing the reconcile in the background (#905). ` +
          `Set CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS=0 to always wait for it.\n`
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Record the directory the server tried to resolve the default project from.
   * Used only to make the "no default project" error actionable.
   */
  setDefaultProjectHint(searchedPath: string): void {
    this.defaultProjectHint = searchedPath;
  }

  /**
   * Engine-only: record the indexed sub-projects the workspace down-scan saw
   * when it could not adopt a default project (#1606/#1607). An empty list
   * clears any previous note.
   */
  setKnownSubprojects(roots: string[], base: string): void {
    this.knownSubprojects = roots;
    this.knownSubprojectsBase = base;
  }

  /** One message line naming the indexed sub-projects, or '' when none known. */
  private formatKnownSubprojects(): string {
    if (this.knownSubprojects.length === 0) return '';
    const base = this.knownSubprojectsBase;
    const rels = this.knownSubprojects.map((r) => (base ? relativePath(base, r) || '.' : r));
    return (
      `Indexed sub-projects were found below it: ${rels.join(', ')} — ` +
      'pass one of them (absolute, or resolved against that directory) as projectPath.\n'
    );
  }

  /**
   * Whether a default CodeGraph instance is available
   */
  hasDefaultCodeGraph(): boolean {
    return this.cg !== null;
  }

  /**
   * Get CodeGraph instance for a project
   *
   * If projectPath is provided, opens that project's CodeGraph (cached).
   * Otherwise returns the default CodeGraph instance.
   *
   * Walks up parent directories to find the nearest .codegraph/ folder,
   * similar to how git finds .git/ directories.
   */
  getCodeGraph(projectPath?: string): CodeGraph {
    if (!projectPath) {
      if (!this.cg) {
        if (this.defaultOpenFailure) throw this.defaultOpenFailure;
        const searched = this.defaultProjectHint ?? process.cwd();
        throw new NotIndexedError(
          'No CodeGraph project is loaded for this session.\n' +
          `Searched for a .codegraph/ directory starting from: ${searched}\n` +
          this.formatKnownSubprojects() +
          'Either the server root has no index of its own (e.g. a monorepo where only ' +
          "sub-projects are indexed), or the MCP client launched the server outside your " +
          'project without reporting the workspace root. Either way, target the project ' +
          'explicitly:\n' +
          '  • Pass projectPath to the tool call, e.g. projectPath: "/absolute/path/to/your/project" ' +
          '(any project that has a .codegraph/ — including a sub-project of a monorepo)\n' +
          '  • Or add --path to the server\'s MCP config args: ["serve", "--mcp", "--path", "/absolute/path/to/your/project"]\n' +
          'If a project simply has no index, use your built-in tools (Read/Grep/Glob) for THAT ' +
          "project (the user can run 'codegraph init' there to enable it) — you can still query " +
          'other indexed projects by projectPath in the same session.'
        );
      }
      return this.freshen(this.cg);
    }

    // Reject sensitive system directories before opening. Only validate a
    // path that actually exists — a nested or not-yet-created sub-path of a
    // real project must still be allowed to resolve UP to its .codegraph/
    // root below (issue #238), so we don't run the existence-checking
    // validator on paths that are meant to walk up.
    //
    // An existing FILE (an agent passing the file it is looking at) resolves
    // from its parent directory — the project it lives in — instead of being
    // refused as "not a directory".
    projectPath = projectDirFor(projectPath);
    if (existsSync(projectPath)) {
      // An indexed project under ~/.config (a dotfiles repo the user chose to
      // index) is allowed; un-indexed ~/.config paths stay refused.
      const pathError = validateProjectPath(projectPath, { isIndexed: isInitialized });
      if (pathError) {
        throw new PathRefusalError(pathError);
      }
    }

    // Always RE-RESOLVE the nearest .codegraph/ from the input path. The walk
    // is cheap (a few existsSync up the tree) and is the only thing that
    // notices a path whose index root CHANGED since it was first seen — most
    // importantly a git worktree that gained its own .codegraph/ after the
    // (long-lived) server first resolved it up to the parent checkout. We used
    // to short-circuit on a `projectCache[projectPath]` entry before resolving,
    // which pinned that first resolution for the server's whole lifetime, so a
    // worktree kept being served the parent checkout's index until restart
    // (#926). The DB connection itself is still cached (by resolved root,
    // below), so re-resolving costs only the stat walk, never a reopen.
    const resolvedRoot = findNearestCodeGraphRoot(projectPath);
    // Two spellings of one root (a symlinked checkout, `/tmp` vs
    // `/private/tmp`) must share one connection and one watcher (#1835).
    const canonicalRoot = resolvedRoot ? canonicalPath(resolvedRoot) : null;

    if (!resolvedRoot || !canonicalRoot) {
      throw new NotIndexedError(
        `The project at ${projectPath} isn't indexed with codegraph (no .codegraph/ directory found ` +
        'walking up from it), so codegraph cannot query it. Use your built-in tools (Read/Grep/Glob) ' +
        "for that codebase instead, and don't call codegraph for it again this session. " +
        "Indexing is the user's decision — they can run 'codegraph init' in that project to enable it."
      );
    }

    const cg = this.openProjectRoot(resolvedRoot, canonicalRoot);
    // The walk above crosses git boundaries. A nested repository the ancestor
    // index leaves out (typically gitignored) would otherwise be answered from
    // the ancestor's code, looking like an answer about the requested project
    // (#2110) — so it gets the same guidance as a project with no index at all.
    const nested = this.uncoveredNestedRepo(projectPath, canonicalRoot, cg);
    if (nested) {
      throw new NotIndexedError(
        `The project at ${projectPath} isn't indexed with codegraph: it is its own git repository ` +
        `(${nested.root}), and the nearest index, at ${canonicalRoot}, holds none of its files ` +
        '(that repository is excluded from it, e.g. by a .gitignore), so codegraph cannot query it. ' +
        "Use your built-in tools (Read/Grep/Glob) for that codebase instead, and don't call codegraph " +
        "for it again this session. Indexing is the user's decision — they can run 'codegraph init' " +
        `in ${nested.root} to enable it.`
      );
    }
    return cg;
  }

  /**
   * The open CodeGraph for an index root the up-walk resolved: the default
   * instance, a cached one, or a newly opened (and cached) one.
   */
  private openProjectRoot(resolvedRoot: string, canonicalRoot: string): CodeGraph {
    // If the path resolves to the default project, reuse the already-open
    // default instance rather than opening a SECOND connection to the same DB.
    // A duplicate connection serializes reads against the watcher's auto-sync
    // writes; when WAL isn't in effect (e.g. a filesystem without shared-memory
    // support) that surfaces as intermittent
    // "database is locked" on concurrent tool calls. See issue #238. The
    // default instance is owned/closed by the server, so it's never cached.
    // Another spelling of the same root counts too (#1057).
    if (this.cg && isSameIndexRoot(this.cg.getProjectRoot(), resolvedRoot)) {
      return this.freshen(this.cg);
    }

    // Cache the open DB connection by CANONICAL ROOT only — never by the input
    // path. One key per instance means closeAll() closes each exactly once, and
    // a changed resolution maps to a different entry instead of a stale hit.
    const cached = this.projectCache.get(canonicalRoot);
    if (cached) {
      // Refresh LRU position.
      this.projectCache.delete(canonicalRoot);
      this.projectCache.set(canonicalRoot, cached);
      this.projectUsedAt.set(canonicalRoot, Date.now());
      return this.freshen(cached);
    }

    // Compare current identities on every cache miss: a previously seen alias
    // may have been retargeted or recreated since the last call (#1057).
    for (const [root, open] of this.projectCache) {
      if (isSameIndexRoot(root, resolvedRoot)) {
        this.projectCache.delete(root);
        this.projectCache.set(root, open);
        this.projectUsedAt.set(root, Date.now());
        return this.freshen(open);
      }
    }

    const open = () => loadCodeGraph().openSync(canonicalRoot);
    const cg = this.projectLifecycle?.open(canonicalRoot, open) ?? open();
    this.projectCache.set(canonicalRoot, cg);
    this.projectUsedAt.set(canonicalRoot, Date.now());
    this.trimProjects();
    return cg;
  }

  /**
   * The nested git repository `projectPath` lives in when the index the
   * up-walk reached (`indexRoot`'s, open as `cg`) holds none of its files; null
   * when that index covers it — an ordinary subdirectory, a submodule or
   * embedded clone the ancestor indexes, a linked worktree (#155) — or when git
   * can't tell (#2110).
   *
   * The git half is memoized per (projectPath, index root), keyed on both for
   * the reason `worktreeMismatchCache` is (#926). The index half is one
   * primary-key probe per call, so a sync that brings the repository into the
   * index is honored without a restart.
   */
  private uncoveredNestedRepo(projectPath: string, indexRoot: string, cg: CodeGraph): NestedRepository | null {
    const cacheKey = `${projectPath}\u0000${indexRoot}`;
    let nested = this.nestedRepoCache.get(cacheKey);
    if (nested === undefined) {
      nested = nestedRepositoryBelow(projectPath, indexRoot);
      this.nestedRepoCache.set(cacheKey, nested);
    }
    if (!nested) return null;
    try {
      return cg.hasFilesUnder(nested.relPath) ? null : nested;
    } catch {
      // An index we can't read is no evidence the repository is excluded.
      return null;
    }
  }

  async awaitProjectGate(projectPath: string): Promise<void> {
    const cg = this.getCodeGraph(projectPath);
    if (!this.projectLifecycle || cg === this.cg) return;
    let gate = this.projectGates.get(cg);
    if (!gate) {
      gate = this.projectLifecycle.activate(cg).catch(() => { /* engine logs */ });
      this.projectGates.set(cg, gate);
      void gate.then(() => {
        if (this.projectGates.get(cg) === gate) this.projectGates.delete(cg);
        this.trimProjects();
      });
    }
    await this.awaitCatchUpGate(gate);
  }

  /**
   * Never evict a graph while a tool call or its timed-out reconcile uses it.
   * Evicts over the LRU bound, on close, and once idle past the timeout
   * (#2087). The cache is in last-use order, so idle entries lead it.
   */
  trimProjects(): void {
    if (this.activeCalls > 0) return;
    const idleMs = resolveProjectIdleTimeoutMs();
    const now = Date.now();
    for (const [root, cg] of this.projectCache) {
      const idle = idleMs > 0 && now - (this.projectUsedAt.get(root) ?? now) >= idleMs;
      if (!this.closing && this.projectCache.size <= MAX_CACHED_PROJECTS && !idle) break;
      if (this.projectGates.has(cg)) continue;
      this.projectCache.delete(root);
      this.projectUsedAt.delete(root);
      if (this.projectLifecycle) {
        this.pendingCloses++;
        void Promise.resolve(this.projectLifecycle.release(cg)).finally(() => {
          this.pendingCloses--;
          this.trimProjects();
        });
      } else cg.close();
    }
    if (this.closing && this.projectCache.size === 0 && this.pendingCloses === 0) {
      for (const resolve of this.closeWaiters.splice(0)) resolve();
    }
    this.scheduleIdleRelease(idleMs);
  }

  /**
   * Arm one unref'd timer for the oldest project a trim could release. A
   * project whose catch-up is still running is trimmed when that settles; the
   * 1s floor keeps a project a trim must skip from re-arming in a tight loop.
   */
  private scheduleIdleRelease(idleMs: number): void {
    if (this.idleReleaseTimer || this.closing || idleMs <= 0) return;
    for (const [root, cg] of this.projectCache) {
      if (this.projectGates.has(cg)) continue;
      const due = (this.projectUsedAt.get(root) ?? Date.now()) + idleMs - Date.now();
      this.idleReleaseTimer = setTimeout(() => {
        this.idleReleaseTimer = null;
        this.trimProjects();
      }, Math.min(Math.max(due, 1000), 0x7fffffff)); // setTimeout's 32-bit cap
      this.idleReleaseTimer.unref();
      return;
    }
  }

  /**
   * Heal a long-lived connection whose `.codegraph/` was removed and recreated
   * at the same path (a worktree recreated, or `rm -rf .codegraph` + re-init)
   * before handing it to a tool. Otherwise the daemon keeps serving the
   * pre-removal snapshot from its now-unlinked file handle until restart — and
   * because the daemon registry is keyed by path, a same-path recreate routes
   * new clients straight back to this same stale daemon (#925). The check is one
   * stat() and a no-op unless the inode actually changed; it never throws into a
   * tool call.
   */
  private freshen(cg: CodeGraph): CodeGraph {
    try {
      if (cg.reopenIfReplaced()) {
        process.stderr.write(
          '[CodeGraph MCP] The index was replaced on disk (e.g. a git worktree ' +
          'recreated at the same path); reopened the live database in place.\n'
        );
        this.onDatabaseReopened?.(cg);
      }
    } catch {
      // Best-effort self-heal — a failed reopen must never break the tool call;
      // the (still stale) handle keeps serving and the next call retries.
    }
    return cg;
  }

  /**
   * Close all cached project connections
   */
  closeAll(): Promise<void> {
    this.closing = true;
    this.worktreeMismatchCache.clear();
    if (this.idleReleaseTimer) clearTimeout(this.idleReleaseTimer);
    this.idleReleaseTimer = null;
    this.nestedRepoCache.clear();
    this.trimProjects();
    if (this.projectCache.size === 0 && this.activeCalls === 0 && this.pendingCloses === 0) return Promise.resolve();
    return new Promise((resolve) => this.closeWaiters.push(resolve));
  }

  /**
   * Cached git worktree/index mismatch for a tool call's effective project.
   *
   * The "effective project" is what the request targets: an explicit
   * `projectPath` arg, else the directory the server resolved its default
   * project from (`defaultProjectHint`), else cwd. Memoized per start path —
   * see `worktreeMismatchCache`. Best-effort: if the project can't be resolved
   * (e.g. nothing initialized yet), it reports "no mismatch" so a tool is never
   * broken by this check.
   */
  worktreeMismatchFor(projectPath?: string): WorktreeIndexMismatch | null {
    const startPath = projectPath ?? this.defaultProjectHint ?? process.cwd();

    // The verdict depends on BOTH the start path AND the index root it resolves
    // to, so the cache must be keyed on the pair. Resolve the index root first
    // (cheap — getCodeGraph re-walks to the nearest .codegraph/, no git), then
    // key on `(startPath, indexRoot)`. The moment that root changes — most
    // importantly when a git worktree gains its own index and the walk-up stops
    // there instead of at the parent checkout — the key changes and the verdict
    // is recomputed, instead of serving the stale "borrowed the parent's index"
    // warning for the server's whole lifetime. Keying on startPath alone pinned
    // that first verdict until restart (#926).
    let indexRoot: string;
    try {
      indexRoot = this.getCodeGraph(projectPath).getProjectRoot();
    } catch {
      // No resolvable project (or any other resolution error) → nothing to warn.
      return null;
    }

    const cacheKey = `${startPath}\u0000${indexRoot}`;
    const cached = this.worktreeMismatchCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const mismatch = detectWorktreeIndexMismatch(startPath, indexRoot);
    this.worktreeMismatchCache.set(cacheKey, mismatch);
    return mismatch;
  }
}
