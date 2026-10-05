/**
 * Node.js version compatibility check.
 *
 * Node 25.x has a V8 turboshaft WASM JIT Zone allocator bug that
 * reliably crashes CodeGraph with `Fatal process out of memory: Zone`
 * during tree-sitter grammar compilation. This module owns the
 * user-facing banner shown before exit. Kept side-effect-free so it's
 * safe to import from tests without triggering CLI bootstrap.
 */

/**
 * Build the bordered banner shown when CodeGraph detects an
 * unsupported Node.js major version (currently 25+). Pinned via unit
 * test so the recovery commands and override instructions can't be
 * silently stripped by future edits.
 *
 * Uses ASCII glyphs to stay readable on Windows OEM-codepage consoles
 * (see ../ui/glyphs.ts for the rationale).
 */
export function buildNode25BlockBanner(nodeVersion: string): string {
  const sep = '-'.repeat(72);
  return [
    sep,
    `[CodeGraph] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    'Node.js 25.x has a V8 WASM JIT (turboshaft) Zone allocator bug that',
    'crashes with `Fatal process out of memory: Zone` when CodeGraph',
    'compiles tree-sitter grammars. CodeGraph WILL crash on this Node',
    'version mid-indexing. See https://github.com/colbymchenry/codegraph/issues/81',
    '',
    'Fix: install Node.js 22 LTS:',
    '  nvm install 22 && nvm use 22                          # nvm',
    '  brew install node@22 && brew link --overwrite --force node@22  # Homebrew',
    '',
    'To override (NOT recommended - you will likely OOM):',
    '  CODEGRAPH_ALLOW_UNSAFE_NODE=1 codegraph ...',
    sep,
  ].join('\n');
}

/**
 * Lowest supported Node.js version. Matches the `engines` floor in
 * package.json. CodeGraph's only database backend is Node's built-in
 * `node:sqlite`, which first shipped in 22.5 behind `--experimental-sqlite`
 * and became available without a flag in 22.13 — below that, opening the
 * index fails with a cryptic "No such built-in module: node:sqlite". The
 * bundled runtime is always newer; this guards running from source / an
 * unbundled install. `engines` alone only *warns* on install (unless the user
 * set `engine-strict`), so the CLI bootstrap also hard-blocks here.
 */
export const MIN_NODE_VERSION = '22.13.0';
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 13;

/** Whether `nodeVersion` (e.g. `process.versions.node`) is below {@link MIN_NODE_VERSION}. */
export function isNodeVersionTooOld(nodeVersion: string): boolean {
  const [major = 0, minor = 0] = nodeVersion.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  return major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR);
}

/**
 * Build the bordered banner shown when CodeGraph detects a Node.js version
 * below {@link MIN_NODE_VERSION}. Pinned via unit test so the recovery
 * commands and the override env var can't be silently stripped by future edits.
 *
 * Uses ASCII glyphs to stay readable on Windows OEM-codepage consoles
 * (see ../ui/glyphs.ts for the rationale).
 */
export function buildNodeTooOldBanner(nodeVersion: string): string {
  const sep = '-'.repeat(72);
  return [
    sep,
    `[CodeGraph] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    `CodeGraph requires Node.js ${MIN_NODE_VERSION} or newer (and below 25).`,
    'It stores its index with Node\'s built-in SQLite module (node:sqlite),',
    'which older Node.js versions do not provide without extra flags.',
    '',
    'Fix: install Node.js 22 LTS (22.13 or newer) or Node.js 24:',
    '  nvm install 22 && nvm use 22                          # nvm',
    '  brew install node@22 && brew link --overwrite --force node@22  # Homebrew',
    '',
    'To override (NOT recommended - only works if node:sqlite is enabled):',
    '  CODEGRAPH_ALLOW_UNSAFE_NODE=1 codegraph ...',
    sep,
  ].join('\n');
}
