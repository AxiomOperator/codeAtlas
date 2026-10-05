/**
 * C# scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Node } from '../../../types';
import { UnresolvedRef, ResolutionContext } from '../../types';
import { stripCommentsForRegex } from '../../strip-comments';
import { hasNoReceiverOnLine } from '../call-shape';
import { splitCppTopLevel } from './c-cpp';

export const CSHARP_ALIASES = new WeakMap<ResolutionContext, Map<string, Map<string, string>>>();

/**
 * The type a C# file's `using Name = Some.Namespace.Type;` (or `global using`)
 * aliases `name` to, as its simple name — or null.
 */
export function csharpUsingAlias(name: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  if (!/^[A-Za-z_]\w*$/.test(name)) return null;
  let memo = CSHARP_ALIASES.get(context);
  if (!memo) {
    memo = new Map();
    CSHARP_ALIASES.set(context, memo);
  }
  let aliases = memo.get(ref.filePath);
  if (!aliases) {
    aliases = new Map();
    const source = context.readFile(ref.filePath) ?? '';
    for (const m of source.matchAll(/^\s*(?:global\s+)?using\s+([A-Za-z_]\w*)\s*=\s*(?:global::)?([\w.]+)\s*(?:<[^;>]*>)?\s*;/gm)) {
      aliases.set(m[1]!, m[2]!.split('.').pop()!);
    }
    memo.set(ref.filePath, aliases);
  }
  return aliases.get(name) ?? null;
}

export const CSHARP_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'struct', 'record']);
const CSHARP_MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'field', 'enum_member', 'constant', 'event']);
export const CSHARP_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();
export const CSHARP_STATIC_USINGS = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/**
 * Whether a bare C# name — `TestContext`, `Easing`, `Helper()` — can mean the
 * member `n`: C# reads a bare name as a member of the types around it (outer
 * classes included) or of their base types, or of a `using static` type.
 * Never some unrelated class's: eShop's `TestContext.CancellationToken` in
 * one test class went to another test class's `TestContext` property, MAUI's
 * `Easing.Linear` to an animation class's `Easing`. Chain links the line
 * shows a receiver for are not judged.
 */
export function isCsharpMemberInScope(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (!CSHARP_MEMBER_KINDS.has(n.kind)) return true;
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut < 0 || !hasNoReceiverOnLine(ref, context)) return true;
  const owner = n.qualifiedName.slice(0, cut).split(/::|\./).pop()!;
  if (csharpStaticUsings(ref.filePath, context).has(owner)) return true;
  const around = context
    .getNodesInFile(ref.filePath)
    .filter((t) => CSHARP_TYPE_KINDS.has(t.kind) && t.startLine <= ref.line && t.endLine >= ref.line);
  // No type around the name: the declaration wasn't recovered — nothing to judge by.
  if (around.length === 0) return true;
  const seen = new Set<string>();
  const queue = around.map((t) => t.name);
  while (queue.length > 0 && seen.size < 40) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === owner) return true;
    queue.push(...csharpSupertypesOf(name, context));
  }
  return false;
}

/** The simple names a C# type's declarations (every `partial` one) derive from. */
function csharpSupertypesOf(typeName: string, context: ResolutionContext): string[] {
  let memo = CSHARP_SUPERS.get(context);
  if (!memo) CSHARP_SUPERS.set(context, (memo = new Map()));
  const hit = memo.get(typeName);
  if (hit) return hit;
  const names: string[] = [];
  for (const decl of context.getNodesByName(typeName)) {
    if (decl.language !== 'csharp' || !CSHARP_TYPE_KINDS.has(decl.kind)) continue;
    const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
    let head = lines.slice(decl.startLine - 1, decl.startLine + 8).join(' ');
    head = head.slice(0, (head.indexOf('{') + 1 || head.length + 1) - 1);
    let depth = 0;
    let flat = '';
    for (const ch of head) {
      if (ch === '<' || ch === '(') depth++;
      else if (ch === '>' || ch === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0) flat += ch;
    }
    const bases = new RegExp(`\\b${typeName}\\s*:\\s*(.*?)(?:\\bwhere\\b|$)`).exec(flat)?.[1] ?? '';
    for (const m of bases.matchAll(/([A-Za-z_][\w.]*)/g)) names.push(m[1]!.split('.').pop()!);
  }
  memo.set(typeName, names);
  return names;
}

/**
 * The types a C# file sees through static usings: its own `using static
 * A.B.Type;`, any file's `global using static`, and `<Using Include="A.B.Type"
 * Static="true"/>` in the `.csproj` / `Directory.Build.props` files above it
 * (AutoMapper imports its ExpressionBuilder helpers project-wide that way).
 */
function csharpStaticUsings(file: string, context: ResolutionContext): Set<string> {
  let memo = CSHARP_STATIC_USINGS.get(context);
  if (!memo) CSHARP_STATIC_USINGS.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const owners = new Set<string>(csharpProjectStaticUsings(path.posix.dirname(file), context, memo));
  for (const m of (context.readFile(file) ?? '').matchAll(/^\s*(?:global\s+)?using\s+static\s+([\w.]+)\s*;/gm)) owners.add(m[1]!.split('.').pop()!);
  memo.set(file, owners);
  return owners;
}

/** Static usings that apply to every file under `dir`: project files on the way up, and every `global using static`. */
function csharpProjectStaticUsings(dir: string, context: ResolutionContext, memo: Map<string, Set<string>>): Set<string> {
  const key = `dir:${dir}`;
  const hit = memo.get(key);
  if (hit) return hit;
  let owners: Set<string>;
  if (dir === '.' || dir === '' || dir === '/') {
    owners = new Set();
    for (const f of context.getAllFiles()) {
      if (!f.endsWith('.cs')) continue;
      const text = context.readFile(f) ?? '';
      if (!text.includes('global using static')) continue;
      for (const m of text.matchAll(/^\s*global\s+using\s+static\s+([\w.]+)\s*;/gm)) owners.add(m[1]!.split('.').pop()!);
    }
  } else {
    owners = new Set(csharpProjectStaticUsings(path.posix.dirname(dir), context, memo));
  }
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(path.join(context.getProjectRoot(), dir === '.' ? '' : dir));
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!/\.(?:csproj|props)$/i.test(entry)) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(context.getProjectRoot(), dir === '.' ? '' : dir, entry), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/<Using\s+Include\s*=\s*"([\w.]+)"[^>]*\bStatic\s*=\s*"true"/gi)) owners.add(m[1]!.split('.').pop()!);
  }
  memo.set(key, owners);
  return owners;
}

export const CSHARP_NAMESPACE_SCOPES = new WeakMap<ResolutionContext, Map<string, { namespaces: string[]; usings: Set<string>; aliases: Map<string, string> }>>();
export const CSHARP_PROJECT_USINGS = new WeakMap<ResolutionContext, Map<string, { usings: Set<string>; project: boolean }>>();

/**
 * The namespaces a C# file's code runs in and the ones it imports: its
 * `namespace` declarations, its `using X;`, the `global using X;` of its
 * project's files (every file's, outside any project) and the
 * `<Using Include="X" />` of the project files above it.
 */
function csharpNamespaceScope(file: string, context: ResolutionContext): { namespaces: string[]; usings: Set<string>; aliases: Map<string, string> } {
  let memo = CSHARP_NAMESPACE_SCOPES.get(context);
  if (!memo) CSHARP_NAMESPACE_SCOPES.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const text = stripCommentsForRegex(context.readFile(file) ?? '', 'java');
  const namespaces = [...text.matchAll(/^\s*namespace\s+([\w.]+)/gm)].map((m) => m[1]!);
  let projectMemo = CSHARP_PROJECT_USINGS.get(context);
  if (!projectMemo) CSHARP_PROJECT_USINGS.set(context, (projectMemo = new Map()));
  const project = csharpProjectUsings(path.posix.dirname(file), context, projectMemo);
  const usings = new Set<string>(project.usings);
  if (!project.project) for (const u of csharpGlobalUsings('.', context)) usings.add(u);
  const aliases = new Map<string, string>();
  for (const m of text.matchAll(/^\s*(?:global\s+)?using\s+(?!static\b)(?:([A-Za-z_]\w*)\s*=\s*)?([\w.]+)\s*;/gm)) {
    if (m[1]) aliases.set(m[1], m[2]!);
    else usings.add(m[2]!);
  }
  const scope = { namespaces, usings, aliases };
  memo.set(file, scope);
  return scope;
}

/**
 * The `<Using Include="X" />` of the project files from `dir` up, and the
 * `global using X;` of each project's own files — a global using is its
 * project's alone: serilog's Serilog.Tests and Serilog.PerformanceTests each
 * `global using` their own `Support` namespace, and both define `Some`.
 * `project` says whether a `.csproj` sits at `dir` or above it.
 */
function csharpProjectUsings(dir: string, context: ResolutionContext, memo: Map<string, { usings: Set<string>; project: boolean }>): { usings: Set<string>; project: boolean } {
  const key = dir;
  const hit = memo.get(key);
  if (hit) return hit;
  const root = dir === '.' || dir === '' || dir === '/';
  const parent = root ? null : csharpProjectUsings(path.posix.dirname(dir), context, memo);
  const usings = new Set<string>(parent?.usings ?? []);
  let project = parent?.project ?? false;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(path.join(context.getProjectRoot(), root ? '' : dir));
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!/\.(?:csproj|props)$/i.test(entry)) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(context.getProjectRoot(), root ? '' : dir, entry), 'utf8');
    } catch {
      continue;
    }
    if (/\.csproj$/i.test(entry) && !project) {
      project = true;
      for (const u of csharpGlobalUsings(root ? '.' : dir, context)) usings.add(u);
    }
    for (const m of text.matchAll(/<Using\s+Include\s*=\s*"([\w.]+)"(?![^>]*\bStatic\s*=\s*"true")[^>]*>/gi)) usings.add(m[1]!);
    // The SDK's implicit usings (serilog's own `System.TimeProvider` polyfill is seen through them).
    if (/<ImplicitUsings>\s*(?:enable|true)\s*<\/ImplicitUsings>/i.test(text)) {
      for (const ns of CSHARP_IMPLICIT_USINGS) usings.add(ns);
    }
  }
  const result = { usings, project };
  memo.set(key, result);
  return result;
}

export const CSHARP_GLOBAL_USINGS = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/** The `global using X;` of the `.cs` files under `dir` (`.` = the whole repository). */
function csharpGlobalUsings(dir: string, context: ResolutionContext): Set<string> {
  let memo = CSHARP_GLOBAL_USINGS.get(context);
  if (!memo) CSHARP_GLOBAL_USINGS.set(context, (memo = new Map()));
  const hit = memo.get(dir);
  if (hit) return hit;
  const usings = new Set<string>();
  const prefix = dir === '.' ? '' : `${dir}/`;
  for (const f of context.getAllFiles()) {
    if (!f.endsWith('.cs') || !f.startsWith(prefix) || (context.fileContains && !context.fileContains(f, 'global using'))) continue;
    for (const m of (context.readFile(f) ?? '').matchAll(/^\s*global\s+using\s+(?!static\b)([\w.]+)\s*;/gm)) usings.add(m[1]!);
  }
  memo.set(dir, usings);
  return usings;
}

/** The namespaces `<ImplicitUsings>enable</ImplicitUsings>` imports into every file (Microsoft.NET.Sdk). */
const CSHARP_IMPLICIT_USINGS: readonly string[] = [
  'System', 'System.Collections.Generic', 'System.IO', 'System.Linq', 'System.Net.Http', 'System.Threading', 'System.Threading.Tasks',
];

/**
 * Whether a bare C# type name can mean `n` — a type in namespace `N` is seen
 * from `N` and the namespaces inside it, and through a `using N;` —
 * Newtonsoft's `async Task` tests (`using System.Threading.Tasks;`) bound
 * `Task` to a test class of that name in `Newtonsoft.Json.Tests.Schema`, 433
 * times. A type in the global namespace is seen everywhere.
 */
export function isCsharpTypeVisible(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const cut = n.qualifiedName.indexOf('::');
  if (cut < 0) return true;
  const ns = n.qualifiedName.slice(0, cut);
  // A nested type (`Outer::Inner`) is judged by its outermost type's namespace.
  const scope = csharpNamespaceScope(ref.filePath, context);
  // `using License = AutoMapper.Licensing.License;` names that type, whatever the file's usings.
  const aliased = scope.aliases.get(ref.referenceName);
  if (aliased !== undefined) return aliased === `${ns}.${n.qualifiedName.slice(cut + 2).replace(/::/g, '.')}`;
  if (scope.namespaces.some((own) => own === ns || own.startsWith(ns + '.'))) return true;
  return scope.usings.has(ns);
}

/**
 * Whether a bare C# name can reach `n` as a nested type: only from inside the
 * type that declares it (any partial part, any depth) or a class deriving from
 * it. AutoMapper's tests each declare their own nested `Source`, and a
 * same-file `new Source()` went to whichever test class came first.
 */
export function isCsharpNestedTypeInScope(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut < 0) return true;
  const owner = n.qualifiedName.slice(0, cut);
  const ownerType = context.getNodesInFile(n.filePath).find((p) => CSHARP_TYPE_KINDS.has(p.kind) && p.qualifiedName === owner);
  // Declared in a namespace, not a type.
  if (!ownerType) return true;
  const enclosing = context.getNodesInFile(ref.filePath)
    .filter((p) => CSHARP_TYPE_KINDS.has(p.kind) && p.startLine <= ref.line && p.endLine >= ref.line);
  if (enclosing.some((p) => p.qualifiedName === owner || p.qualifiedName.startsWith(`${owner}::`))) return true;
  // Inherited: a type around the ref derives from the owner (`class SourceA :
  // Source`), through any partial part — Newtonsoft's JsonTextReader.Async.cs
  // is `partial class JsonTextReader` with no base list, reading JsonReader's `State`.
  return enclosing.some((p) => csharpAncestorNames(p.qualifiedName, context).has(ownerType.name));
}

export const CSHARP_ANCESTORS = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/** The simple names of the C# types `qn` derives from, through every partial part and base, a few levels up. */
function csharpAncestorNames(qn: string, context: ResolutionContext, depth = 0): Set<string> {
  let memo = CSHARP_ANCESTORS.get(context);
  if (!memo) CSHARP_ANCESTORS.set(context, (memo = new Map()));
  const hit = memo.get(qn);
  if (hit) return hit;
  const names = new Set<string>();
  memo.set(qn, names); // a cycle reads what is gathered so far
  for (const decl of context.getNodesByQualifiedName(qn)) {
    if (decl.language !== 'csharp' || !CSHARP_TYPE_KINDS.has(decl.kind)) continue;
    const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
    let header = '';
    for (let i = decl.startLine - 1; i < Math.min(lines.length, decl.startLine + 6) && !header.includes('{'); i++) header += `${lines[i] ?? ''} `;
    const list = /:\s*([^{;]*)/.exec(header.split('{')[0]!.replace(/\bwhere\b[\s\S]*$/, ''))?.[1] ?? '';
    for (const base of splitCppTopLevel(list)) {
      const name = /([A-Za-z_]\w*)\s*(?:<.*)?$/.exec(base.trim())?.[1];
      if (name) names.add(name);
    }
  }
  if (depth < 4) {
    for (const base of [...names]) {
      for (const t of context.getNodesByName(base)) {
        if (t.language !== 'csharp' || !CSHARP_TYPE_KINDS.has(t.kind) || t.qualifiedName === qn) continue;
        for (const up of csharpAncestorNames(t.qualifiedName, context, depth + 1)) names.add(up);
      }
    }
  }
  return names;
}
