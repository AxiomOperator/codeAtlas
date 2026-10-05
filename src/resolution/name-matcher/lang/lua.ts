/**
 * Lua scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from '../../types';
import { isTestPath } from '../../../search/query-utils';
import { sharesReceiverWord } from '../strategies/fuzzy';

export const LUA_LOCALS = new WeakMap<ResolutionContext, Map<string, boolean>>();

/** Whether a Lua variable or function is declared `local` (`local x = …`, `local function f`, `local a, x = …`). */
export function isLuaLocal(candidate: Node, context: ResolutionContext): boolean {
  if (candidate.kind !== 'variable' && candidate.kind !== 'constant' && candidate.kind !== 'function') return false;
  let memo = LUA_LOCALS.get(context);
  if (!memo) LUA_LOCALS.set(context, (memo = new Map()));
  const hit = memo.get(candidate.id);
  if (hit !== undefined) return hit;
  const line = (context.getFileLines?.(candidate.filePath) ?? context.readFile(candidate.filePath)?.split(/\r?\n/))?.[candidate.startLine - 1] ?? '';
  const local = /^\s*local\b/.test(line);
  memo.set(candidate.id, local);
  return local;
}

/** Lua's global functions, and the test runner's: `local type = type` is the standard library's `type`. */
export const LUA_GLOBAL_FUNCTIONS: ReadonlySet<string> = new Set([
  'assert', 'error', 'ipairs', 'pairs', 'next', 'type', 'tostring', 'tonumber', 'setmetatable', 'getmetatable',
  'rawget', 'rawset', 'rawequal', 'rawlen', 'select', 'pcall', 'xpcall', 'unpack', 'print', 'load', 'loadstring',
  'loadfile', 'dofile', 'collectgarbage', 'require', 'setfenv', 'getfenv', 'newproxy', 'typeof', 'warn', 'tick', 'wait',
  'describe', 'it', 'before_each', 'after_each', 'setup', 'teardown', 'lazy_setup', 'lazy_teardown', 'pending', 'finally',
  'insulate', 'expose',
]);

/** `require "m"` (or a loader named for it — kong's `reload_module("spec.internal.misc")`), then any `.member`s. */
const LUA_REQUIRE_ALIAS = /^(?:require|[A-Za-z_]\w*(?:[Rr]equire|_module|[Ii]mport))\s*\(?\s*(["'])([^"']+)\1\s*\)?((?:\s*\.\s*[A-Za-z_]\w*)*)\s*$/;
const LUA_NAME_ALIAS = /^([A-Za-z_]\w*)((?:\s*\.\s*[A-Za-z_]\w*)*)\s*$/;

/**
 * A bare Lua call through a `local` alias, followed to what the alias names:
 *
 *   local splitn = require("kong.tools.string").splitn   → the module's `splitn`
 *   local select_listener = utils.select_listener        → through `local utils = require …`
 *   local fmt = string.format / local type = type        → the standard library's: no edge
 *
 * Kong localizes every global and module function it uses this way, so its
 * calls stopped at a same-file variable — 8,000 of them, most for the
 * standard library. `undefined` when the call is not through such an alias
 * (it resolves as before), null when the alias names nothing in the project.
 */
export function luaAliasTarget(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null | undefined {
  const decl = luaLocalDecl(ref.referenceName, ref.filePath, ref.line, context);
  if (!decl) return undefined;
  const target = luaAliasOf(decl, context, 0);
  if (target === undefined) return undefined;
  if (target === null) return null;
  return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' };
}

/** The `local name = …` in scope at `line` of `file`: the nearest one above it that no other function holds. */
function luaLocalDecl(name: string, file: string, line: number, context: ResolutionContext): Node | null {
  const nodes = context.getNodesInFile(file);
  const fns = nodes.filter((n) => n.kind === 'function' || n.kind === 'method');
  let best: Node | null = null;
  for (const n of nodes) {
    if (n.name !== name || n.kind !== 'variable' || n.startLine > line || !n.signature) continue;
    if (fns.some((f) => f.startLine <= n.startLine && n.startLine <= f.endLine && !(f.startLine <= line && line <= f.endLine))) continue;
    if (!isLuaLocal(n, context)) continue;
    if (!best || n.startLine > best.startLine) best = n;
  }
  // A function's own locals are not nodes: kong's `local clear_header =
  // kong.response.clear_header` inside an access handler. Read the nearest
  // one above the call within the innermost function around it.
  const fn = fns.filter((f) => f.startLine <= line && line <= f.endLine && f.startLine < line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  if (fn && (!best || best.startLine < fn.startLine)) {
    const lines = context.getFileLines?.(file) ?? context.readFile(file)?.split(/\r?\n/) ?? [];
    const decl = new RegExp(`^\\s*local\\s+${name}\\s*=\\s*(.+?)\\s*$`);
    for (let at = line - 1; at > fn.startLine; at--) {
      const m = decl.exec(lines[at - 1] ?? '');
      if (!m) continue;
      const fileNode = nodes.find((n) => n.kind === 'file');
      if (!fileNode) break;
      return { ...fileNode, name, kind: 'variable', signature: `= ${m[1]}`, startLine: at, endLine: at };
    }
  }
  return best;
}

/** Where a Lua alias is written: its file, line and name, and a node there to resolve `require`s from. */
interface LuaSite { file: string; line: number; name: string; node: Node }

/**
 * What a Lua alias variable names: a project function (or the module's own
 * global), null for the standard library or an outside module, `undefined`
 * for an initializer that is not an alias.
 */
function luaAliasOf(decl: Node, context: ResolutionContext, depth: number): Node | null | undefined {
  const rhs = decl.signature!.replace(/^\s*=\s*/, '').trim();
  return luaAliasExpr(rhs, { file: decl.filePath, line: decl.startLine, name: decl.name, node: decl }, context, depth);
}

const luaMembers = (chain: string): string[] => chain.split('.').map((s) => s.trim()).filter(Boolean);

function luaAliasExpr(rhs: string, site: LuaSite, context: ResolutionContext, depth: number): Node | null | undefined {
  const req = LUA_REQUIRE_ALIAS.exec(rhs);
  if (req) return luaModuleMember(req[2]!, luaMembers(req[3]!), site.node, context, depth);
  const named = LUA_NAME_ALIAS.exec(rhs);
  if (!named) return undefined;
  const root = named[1]!;
  const path = luaMembers(named[2]!);
  const rootDecl = root === site.name ? null : luaLocalDecl(root, site.file, site.line - 1, context);
  if (rootDecl) {
    const module = LUA_REQUIRE_ALIAS.exec(rootDecl.signature!.replace(/^\s*=\s*/, '').trim());
    if (module && path.length > 0) return luaModuleMember(module[2]!, [...luaMembers(module[3]!), ...path], rootDecl, context, depth);
    return undefined;
  }
  if (path.length === 0) return LUA_GLOBAL_FUNCTIONS.has(root) ? null : undefined;
  if (!LUA_LIBRARY_TABLES.has(root)) {
    // A member of a global table the host provides — kong's `local clear_header =
    // kong.response.clear_header` — is the one method of a table named after its holder.
    const member = path[path.length - 1]!;
    const holder = path.length > 1 ? path[path.length - 2]! : root;
    const owned = context.getNodesByName(member).filter((n) =>
      (n.language === 'lua' || n.language === 'luau') && n.kind === 'method' && sharesReceiverWord(holder, n) &&
      !(isTestPath(n.filePath) && !isTestPath(site.file)));
    return owned.length === 1 ? owned[0]! : undefined;
  }
  if (path.length !== 1) return undefined;
  // A library function the project patches itself (kong's `ngx.sleep`) is the project's —
  // a test's stand-in (`function ngx.get_phase()` in a spec) only for that test.
  const patched = context.getNodesByName(path[0]!).filter((n) =>
    (n.kind === 'function' || n.kind === 'method') && n.qualifiedName.split(/::|\./)[0] === root &&
    (n.filePath === site.file || !isTestPath(n.filePath)));
  return patched.length === 1 ? patched[0]! : null;
}

/** Per-context memo: `file\0a.b` → what that module member is. */
export const LUA_MEMBERS = new WeakMap<ResolutionContext, Map<string, Node | null | undefined>>();

/** `member` of the module `require(name)` returns, from `decl`'s file: its function of that name. */
function luaModuleMember(name: string, path: string[], decl: Node, context: ResolutionContext, depth: number): Node | null | undefined {
  const file = luaModuleFile(name, decl, context);
  if (!file) return null;
  // `require "kong.conf_loader"` called directly: the module's returned value.
  if (path.length === 0) return undefined;
  let memo = LUA_MEMBERS.get(context);
  if (!memo) LUA_MEMBERS.set(context, (memo = new Map()));
  const key = `${file}\0${path.join('.')}`;
  if (memo.has(key)) return memo.get(key);
  memo.set(key, null); // a cycle of re-exports names nothing
  const found = luaMemberIn(file, path, context, depth);
  memo.set(key, found);
  return found;
}

function luaMemberIn(file: string, path: string[], context: ResolutionContext, depth: number): Node | null | undefined {
  const member = path[path.length - 1]!;
  const nodes = context.getNodesInFile(file);
  const inFile = nodes.filter((n) => n.name === member);
  const fns = inFile.filter((n) => n.kind === 'function' || n.kind === 'method');
  if (fns.length > 0) {
    const owner = path.length > 1 ? path[path.length - 2]! : null;
    return fns.find((n) => owner !== null && n.qualifiedName.endsWith(`${owner}::${member}`)) ??
      fns.find((n) => n.kind === 'method') ?? fns[0]!;
  }
  if (depth >= 3) return null;
  // The module exports something under this name: `return { check = check_phase }`,
  // `_M.check = check_phase`, `kong_exec = cmd.kong_exec,` (spec helpers' table).
  const source = (context.readFile(file) ?? '')
    .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, (c) => c.replace(/[^\n]/g, ''))
    .replace(/--[^\n]*/g, '');
  const exported = new RegExp(`(?:^|[\\s{,.])${member}\\s*=\\s*([A-Za-z_]\\w*(?:\\s*\\.\\s*[A-Za-z_]\\w*)*)\\s*(?:[,;}]|$)`, 'm').exec(source);
  if (exported && exported[1] !== member) {
    const rhs = exported[1]!;
    const line = source.slice(0, exported.index).split('\n').length + 1;
    if (/^[A-Za-z_]\w*$/.test(rhs)) {
      const fn = nodes.find((n) => n.name === rhs && (n.kind === 'function' || n.kind === 'method'));
      if (fn) return fn;
    }
    const at = nodes.find((n) => n.kind === 'file') ?? nodes[0];
    const next = at ? luaAliasExpr(rhs, { file, line, name: member, node: at }, context, depth + 1) : undefined;
    if (next !== undefined) return next;
  }
  // The module re-exports an alias of its own (`local splitn = require(…).splitn`).
  const alias = inFile.find((n) => n.kind === 'variable' && n.signature && isLuaLocal(n, context));
  if (alias) {
    const next = luaAliasOf(alias, context, depth + 1);
    if (next !== undefined) return next;
  }
  const global = inFile.find((n) => n.kind === 'variable' && !isLuaLocal(n, context));
  return global ?? null;
}

/** The project file `require(name)` loads from `decl`'s file, or null for a module outside it. */
function luaModuleFile(name: string, decl: Node, context: ResolutionContext): string | null {
  const resolved = context.resolveImport?.({
    fromNodeId: decl.id,
    referenceName: name,
    referenceKind: 'imports',
    line: decl.startLine,
    column: 0,
    filePath: decl.filePath,
    language: decl.language,
  });
  if (!resolved) return null;
  return context.getNodeById?.(resolved.targetNodeId)?.filePath ?? null;
}

/**
 * Lua's standard and host libraries: a call through one of these tables is
 * the library's, never the one project method that shares its name (busted's
 * `assert.truthy` went to a condition helper 987 times, `string.find` to a
 * picker's `find`, Neovim's `vim.split` to a build module's).
 */
const LUA_LIBRARY_TABLES: ReadonlySet<string> = new Set([
  'string', 'table', 'math', 'io', 'os', 'coroutine', 'debug', 'utf8', 'package', 'bit', 'bit32', 'jit', 'ffi',
  'vim', 'ngx', 'assert', 'spy', 'stub', 'mock', 'love',
]);
/** Lua string methods, reached with `s:find(…)` on any string. */
const LUA_STRING_METHODS: ReadonlySet<string> = new Set([
  'find', 'match', 'gmatch', 'gsub', 'sub', 'format', 'upper', 'lower', 'len', 'rep', 'byte', 'reverse',
]);

/**
 * Whether a Lua call is a library's rather than `candidate`: through a library
 * table the project doesn't patch itself (kong's globalpatches do define
 * `ngx.sleep`), or a string method on a value.
 */
export function isLuaLibraryCall(receiver: string, method: string, ref: UnresolvedRef, candidate: Node): boolean {
  const root = receiver.split(/[.:]/)[0]!;
  if (LUA_LIBRARY_TABLES.has(root)) return candidate.qualifiedName.split(/::|\./)[0] !== root;
  return LUA_STRING_METHODS.has(method) && ref.referenceName.endsWith(`:${method}`);
}
