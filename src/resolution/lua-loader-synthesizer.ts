/**
 * Lua custom module loaders (#1617).
 *
 * Embedded Lua (game clients, plugin hosts) often loads modules through a
 * host-defined function instead of `require` — `Require("Script/Foo.lua")`.
 * Nothing in the language marks such a function as a loader, so a project
 * names its loaders in `codegraph.json`:
 *
 *   { "lua": { "loaderFunctions": ["Require", "Include"] } }
 *
 * Each call to a listed function with a string literal becomes an `imports`
 * edge — from the enclosing function, else the file — to the file the literal
 * names: a path (`Script/Foo.lua`, `Script/Foo`) or a dotted module name
 * (`script.foo`), matched like `require` (`<p>.lua|.luau`, `<p>/init.lua|.luau`)
 * by path suffix, nearest to the calling file. A non-literal argument, or a
 * literal naming no project file, adds nothing.
 *
 * This runs over the indexed source at resolution time (the extractor has no
 * project configuration), so it covers every call shape alike — a top-level
 * `local M = Require("…")` as well as one inside a function body.
 */

import type { Edge } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { loadLuaLoaderFunctions } from '../project-config';
import { enclosingFn, makeLineAt } from './synth-utils';

/** Calls carrying a string literal first argument: `Name("x")`, `Name "x"`, `Name('x')`. */
function loaderCallRe(names: readonly string[]): RegExp {
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?<![\\w.:])(${alt})\\s*(?:\\(\\s*)?(["'])([^"'\\n]+)\\2`, 'g');
}

const LUA_FILE = /\.(?:lua|luau)$/i;

/** Project files by basename, for the suffix match. */
function filesByBasename(ctx: ResolutionContext): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const f of ctx.getAllFiles()) {
    const base = f.split('/').pop() ?? '';
    const bucket = index.get(base);
    if (bucket) bucket.push(f);
    else index.set(base, [f]);
  }
  return index;
}

/** The project file a loader literal names, nearest to `fromFile`; null when none does. */
export function resolveLuaLoaderPath(literal: string, fromFile: string, byBase: Map<string, string[]>): string | null {
  let p = literal.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
  if (!p) return null;
  let candidates: string[];
  if (LUA_FILE.test(p)) {
    candidates = [p];
  } else {
    if (!p.includes('/')) p = p.replace(/\./g, '/');
    candidates = [`${p}.lua`, `${p}.luau`, `${p}/init.lua`, `${p}/init.luau`];
  }
  const shared = (a: string, b: string): number => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  for (const cand of candidates) {
    const bucket = byBase.get(cand.split('/').pop() ?? '') ?? [];
    const matches = bucket.filter((f) => (f === cand || f.endsWith('/' + cand)) && f !== fromFile);
    if (matches.length === 0) continue;
    matches.sort((x, y) => shared(y, fromFile) - shared(x, fromFile) || x.localeCompare(y));
    return matches[0]!;
  }
  return null;
}

export async function luaLoaderImportEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const names = loadLuaLoaderFunctions(ctx.getProjectRoot());
  if (names.length === 0) return [];
  const re = loaderCallRe(names);
  let byBase: Map<string, string[]> | null = null;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if ((++scanned & 63) === 0) await onYield();
    const nodes = ctx.getNodesInFile(file);
    const fileNode = nodes.find((n) => n.kind === 'file');
    if (!fileNode || (fileNode.language !== 'lua' && fileNode.language !== 'luau')) continue;
    if (ctx.fileContains && !names.some((n) => ctx.fileContains!(file, n.split(/[.:]/).pop()!))) continue;
    const src = ctx.readFile(file);
    if (!src) continue;
    const lineAt = makeLineAt(src, 1);
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      // A loader call inside a `--` line comment loads nothing.
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      if (src.slice(lineStart, m.index).includes('--')) continue;
      byBase ??= filesByBasename(ctx);
      const target = resolveLuaLoaderPath(m[3]!, file, byBase);
      if (!target) continue;
      const targetNode = ctx.getNodesInFile(target).find((n) => n.kind === 'file');
      if (!targetNode) continue;
      const line = lineAt(m.index);
      const source = enclosingFn(nodes, line) ?? fileNode;
      const key = `${source.id}>${targetNode.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: source.id,
        target: targetNode.id,
        kind: 'imports',
        line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'lua-loader', via: m[1]!, registeredAt: `${file}:${line}` },
      });
    }
  }
  return edges;
}
