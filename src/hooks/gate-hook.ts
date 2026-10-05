/**
 * `codegraph gate-hook` — opt-in Claude Code `PreToolUse` hook (#2313).
 *
 * In an indexed project it blocks text search — the `Grep` / `Glob` tools and
 * Bash commands whose search head is `rg` / `grep` / `find` / `fd` / `ag` /
 * `ack` — until the session has made at least one CodeGraph call. After that
 * first call every search is allowed again (literals, configs, docs …).
 *
 * ## How "this session used CodeGraph" is tracked
 *
 * The MCP server cannot do it: Claude Code never tells an MCP server its
 * session id, and one server process (or the shared daemon) can serve many
 * sessions, so anything the server wrote would be a guess (a recency window
 * per project lets a second, parallel session through on the first one's
 * call). The hook, on the other hand, receives `session_id` on stdin for
 * EVERY tool call. So the same hook is registered with a matcher that also
 * covers CodeGraph's own MCP tools (`mcp__…codegraph…__*`), and:
 *
 *   - a `PreToolUse` for a CodeGraph MCP tool — or a Bash `codegraph
 *     explore|query|node|…` command — writes a marker file named after the
 *     session id, then allows the call;
 *   - a `PreToolUse` for a search tool checks that marker.
 *
 * Marking at PreToolUse (not PostToolUse) means one hook entry covers both
 * sides, and an attempted call counts: if the CodeGraph call itself fails,
 * the agent has still asked the index first and must not be locked out of
 * its built-in tools. Markers live under `~/.codegraph/gate-sessions/` (not a
 * world-writable tmp dir, where another user could plant a symlink at a
 * predictable name) and are pruned after a day.
 *
 * ## Never in the way
 *
 * Off unless the user opted in at install time. Does nothing outside an
 * indexed project. Any error, malformed stdin, or missing session id → allow
 * (fail OPEN). `CODEGRAPH_NO_GATE_HOOK=1` disables it without editing
 * settings.json.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Claude Code PreToolUse payload (only the fields we read). */
export interface GateHookInput {
  session_id?: unknown;
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
}

export type GateDecision =
  | { action: 'allow'; why: string }
  | { action: 'mark'; why: string }
  | { action: 'deny'; why: string; reason: string };

export interface GateDeps {
  /** Nearest indexed project root at or above `p`, or null. */
  findIndexedRoot(p: string): string | null;
  /** True when this session already made a CodeGraph call. */
  hasMarker(sessionId: string): boolean;
}

/** Commands treated as a text search when they head a pipeline segment. */
const SEARCH_HEADS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'find', 'fd', 'fdfind', 'ag', 'ack']);
/** `codegraph <sub>` invocations that count as asking the index. */
const CODEGRAPH_QUERY_SUBCOMMANDS = new Set(['explore', 'query', 'node', 'context', 'callers', 'callees', 'impact', 'files', 'search']);
/** Wrappers skipped when finding a segment's real command word. */
const COMMAND_PREFIXES = new Set(['sudo', 'command', 'time', 'nice', 'env', 'exec', 'nohup']);

/** A CodeGraph MCP tool, however the host namespaced the server (`mcp__codegraph__…`, `mcp__plugin_x_codegraph__…`). */
export function isCodegraphMcpTool(toolName: string): boolean {
  return /^mcp__.*codegraph.*__/i.test(toolName);
}

/** Split a shell command into the first word-list of every pipeline (pipe targets are not heads). */
function pipelineHeads(command: string): string[][] {
  const heads: string[][] = [];
  // Statement separators. Quoting isn't modelled: a separator inside quotes
  // only produces an extra (harmless) segment to inspect.
  for (const stmt of command.split(/&&|\|\||;|\n|(?<![<>])&(?!>)/)) {
    const first = stmt.split('|')[0] ?? ''; // only the pipeline's head; `x | grep y` filters output
    const words = first.trim().replace(/^[({\s]+/, '').split(/\s+/).filter(Boolean);
    if (words.length) heads.push(words);
  }
  return heads;
}

/** The command word of a segment, past `FOO=bar` assignments and wrappers like `sudo`. */
function commandWord(words: string[]): { cmd: string; rest: string[] } | null {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || COMMAND_PREFIXES.has(words[i]!))) i++;
  if (i >= words.length) return null;
  const cmd = path.basename(words[i]!.replace(/^['"]|['"]$/g, ''));
  return { cmd, rest: words.slice(i + 1) };
}

/**
 * True when a search's path arguments ALL point inside `node_modules` —
 * searching a dependency's source is fine (CodeGraph doesn't index it). A
 * repo-wide search that merely excludes node_modules is still gated.
 */
function targetsOnlyNodeModules(args: string[]): boolean {
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!.replace(/^['"]|['"]$/g, '');
    if (a.startsWith('-') || a.startsWith('!')) continue;
    const prev = i > 0 ? args[i - 1]! : '';
    if (/^(--exclude(-dir)?|--ignore(-dir)?|-not|!|-g|--glob|--iglob)$/.test(prev)) continue;
    if (a.includes('node_modules')) paths.push(a);
  }
  return paths.length > 0;
}

/** First search head in a Bash command, or null when none. */
export function bashSearchHead(command: string): { cmd: string; args: string[] } | null {
  for (const words of pipelineHeads(command)) {
    const cw = commandWord(words);
    if (cw && SEARCH_HEADS.has(cw.cmd)) return { cmd: cw.cmd, args: cw.rest };
  }
  return null;
}

/** True when a Bash command runs a `codegraph` query (CLI use counts as asking the index). */
export function isCodegraphCliQuery(command: string): boolean {
  for (const words of pipelineHeads(command)) {
    const cw = commandWord(words);
    if (!cw) continue;
    let { cmd, rest } = cw;
    // `npx @colbymchenry/codegraph explore …`
    if (cmd === 'npx' && rest.length && /codegraph/.test(rest[0]!)) { cmd = 'codegraph'; rest = rest.slice(1); }
    if ((cmd === 'codegraph' || cmd === 'codegraph.cmd' || cmd === 'codegraph.js') && rest.length && CODEGRAPH_QUERY_SUBCOMMANDS.has(rest[0]!)) {
      return true;
    }
  }
  return false;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function denyReason(root: string): string {
  return (
    `CodeGraph gate: this project (${root}) is indexed by CodeGraph, and text search is held until ` +
    `this session asks the index once. Call the codegraph_explore MCP tool first (a natural-language ` +
    `question or the symbol/file names you are after) — it returns the matching symbols' verbatim source ` +
    `and call paths. After one CodeGraph call, Grep/Glob/rg/find work normally for literals, configs and docs. ` +
    `(The user enabled this gate; CODEGRAPH_NO_GATE_HOOK=1 turns it off.)`
  );
}

/**
 * Pure decision for one PreToolUse event. Never throws on bad input — an
 * unrecognized shape is an `allow`.
 */
export function decideGate(input: GateHookInput, deps: GateDeps): GateDecision {
  const tool = str(input.tool_name);
  const event = str(input.hook_event_name);
  if (event && event !== 'PreToolUse') return { action: 'allow', why: 'not-pretooluse' };
  const sessionId = str(input.session_id);
  const toolInput = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>;
  const cwd = str(input.cwd) || process.cwd();

  if (isCodegraphMcpTool(tool)) return sessionId ? { action: 'mark', why: 'mcp' } : { action: 'allow', why: 'no-session' };

  let searchPath: string;
  if (tool === 'Grep' || tool === 'Glob') {
    const p = str(toolInput.path);
    if (/(^|[\\/])node_modules([\\/]|$)/.test(p)) return { action: 'allow', why: 'node_modules' };
    searchPath = p ? path.resolve(cwd, p) : cwd;
  } else if (tool === 'Bash') {
    const command = str(toolInput.command);
    if (!command) return { action: 'allow', why: 'no-command' };
    if (isCodegraphCliQuery(command)) return sessionId ? { action: 'mark', why: 'cli' } : { action: 'allow', why: 'no-session' };
    const head = bashSearchHead(command);
    if (!head) return { action: 'allow', why: 'not-search' };
    if (targetsOnlyNodeModules(head.args)) return { action: 'allow', why: 'node_modules' };
    searchPath = cwd;
  } else {
    return { action: 'allow', why: 'other-tool' };
  }

  // Without a session id there is no way to ever lift the gate — fail open.
  if (!sessionId) return { action: 'allow', why: 'no-session' };
  const root = deps.findIndexedRoot(searchPath);
  if (!root) return { action: 'allow', why: 'not-indexed' };
  if (deps.hasMarker(sessionId)) return { action: 'allow', why: 'session-used-codegraph' };
  return { action: 'deny', why: 'gated', reason: denyReason(root) };
}

// ---------------------------------------------------------------------------
// Session markers
// ---------------------------------------------------------------------------

const MARKER_TTL_MS = 24 * 60 * 60 * 1000;

export function gateMarkerDir(home: string = os.homedir()): string {
  return path.join(home, '.codegraph', 'gate-sessions');
}

/** File-name-safe, collision-resistant key for a session id. */
function markerName(sessionId: string): string {
  return /^[A-Za-z0-9_-]{1,100}$/.test(sessionId)
    ? sessionId
    : crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 40);
}

export function hasGateMarker(sessionId: string, dir: string = gateMarkerDir()): boolean {
  try {
    return fs.statSync(path.join(dir, markerName(sessionId))).isFile();
  } catch {
    return false;
  }
}

/** Record that `sessionId` asked CodeGraph. Best-effort; also prunes stale markers now and then. */
export function writeGateMarker(sessionId: string, dir: string = gateMarkerDir(), now: number = Date.now()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, markerName(sessionId));
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '', { flag: 'w' });
      pruneGateMarkers(dir, now);
    }
  } catch {
    /* fail open: a missing marker only means the next search is held once more */
  }
}

export function pruneGateMarkers(dir: string, now: number = Date.now()): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > MARKER_TTL_MS) fs.unlinkSync(file);
      } catch { /* raced with another prune */ }
    }
  } catch { /* best effort */ }
}
