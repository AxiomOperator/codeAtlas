/**
 * Rust scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import * as path from 'path';
import { Node } from '../../../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from '../../types';
import { stripCommentsForRegex } from '../../strip-comments';
import { getCargoWorkspaceCrateMap } from '../../frameworks/cargo-workspace';
import { GO_STD_METHODS, RUST_STD_METHODS } from '../std-methods';
import { sharesReceiverWord } from '../strategies/fuzzy';
import { resolveMethodOnType } from '../strategies/method-call';
import { preferCallSiteFile } from '../strategies/qualified';
import { TYPE_MEMBER_KINDS } from '../visibility';

/** Per-context memo: node id → "this Rust method implements a trait". */
export const RUST_TRAIT_IMPL_MEMO = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * Whether a Rust method sits in an `impl Trait for Type` block. Such a method
 * carries no `pub` — the trait decides its visibility — so the extractor
 * records it as private; it is reachable wherever the trait is. Read from the
 * nearest enclosing `impl` header above the method, memoised per node.
 */
export function isRustTraitImplMethod(candidate: Node, context: ResolutionContext): boolean {
  if (candidate.kind !== 'method') return false;
  let memo = RUST_TRAIT_IMPL_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    RUST_TRAIT_IMPL_MEMO.set(context, memo);
  }
  const hit = memo.get(candidate.id);
  if (hit !== undefined) return hit;
  const lines = context.getFileLines?.(candidate.filePath) ?? context.readFile(candidate.filePath)?.split('\n') ?? [];
  let isTrait = false;
  for (let i = candidate.startLine - 2; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (/^\s*(pub(\([^)]*\))?\s+)?(unsafe\s+)?impl\b/.test(line)) {
      isTrait = /\sfor\s/.test(line.replace(/\/\/.*$/, ''));
      break;
    }
    // A top-level item above the method means it was not inside an impl.
    if (/^(pub(\([^)]*\))?\s+)?(fn|struct|enum|mod|trait|const|static|type)\b/.test(line)) break;
  }
  memo.set(candidate.id, isTrait);
  return isTrait;
}

/**
 * The directory a Rust file's private items are visible from: the file's own
 * module subtree. `src/net.rs` and `src/net/mod.rs` own `src/net/`; a crate
 * root (`lib.rs` / `main.rs`) owns its directory. A child module reaches its
 * ancestors' private items (`super::`), a sibling or another crate never does.
 */
export function rustModuleDir(filePath: string): string {
  const base = path.posix.basename(filePath);
  const dir = path.posix.dirname(filePath);
  if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') return dir;
  return path.posix.join(dir, base.replace(/\.rs$/, ''));
}

/**
 * How a bare Rust or Go name is written at its call: `path` after `::` (left
 * to the path strategies), `chained` after a `.` — with the receiver it is
 * written on, call and type arguments dropped — or `bare`. The extractors
 * keep one receiver level, so `sym.filename().map(From::from)` and
 * `child.Flags().String("f", …)` arrive as bare `map` / `String`.
 */
export function rustGoCallShape(ref: UnresolvedRef, context: ResolutionContext): { shape: 'path' } | { shape: 'bare' } | { shape: 'chained'; receiver: string } | null {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split('\n');
  let line = lines?.[ref.line - 1];
  if (line === undefined) return null;
  const name = ref.referenceName;
  const at = new RegExp(`(?<![\\w$])${name}\\s*(?:\\(|::<|!)`);
  let start = line.startsWith(name, ref.column) ? ref.column : -1;
  if (start < 0) {
    const m = at.exec(line);
    start = m ? m.index : -1;
  }
  // A link further down a chain the call's line starts — `bat()\n  .arg(…)\n  .stdout(…)` —
  // is recorded at the chain's first line.
  for (let next = ref.line; start < 0 && lines && next < Math.min(lines.length, ref.line + 20); next++) {
    const m = /^\s*\./.test(lines[next]!) ? at.exec(lines[next]!) : null;
    if (m) {
      // Named after the chain's head: `Command::new("true")` for its `.stdout(…)`.
      if (/^\s*\.\s*$/.test(lines[next]!.slice(0, m.index))) {
        return { shape: 'chained', receiver: rustGoReceiverName(line.trimEnd().replace(/[?;]+$/, '')) };
      }
      line = lines[next]!;
      start = m.index;
    }
  }
  if (start < 0) return null;
  const before = line.slice(0, start);
  if (/::\s*$/.test(before)) return { shape: 'path' };
  if (!/\.\s*$/.test(before)) return { shape: 'bare' };
  return { shape: 'chained', receiver: rustGoReceiverName(before.replace(/\?\s*\.\s*$/, '')) };
}

/**
 * The receiver a Rust / Go `….name(` is written on, as its path and dotted
 * identifiers with arguments dropped — `Command::new("x").short_flag('f')` →
 * `Command::new.short_flag`, a macro `arg!(…)` → `arg`, a Go composite
 * literal `(JSON{data})` → `JSON`. Read backwards to the expression's start.
 */
export function rustGoReceiverName(text: string): string {
  let out = '';
  let i = text.replace(/\s*\.\s*$/, '').length - 1;
  const src = text.replace(/\s*\.\s*$/, '');
  while (i >= 0) {
    const ch = src[i]!;
    if (ch === ')' || ch === ']' || ch === '}') {
      const open = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      let depth = 0;
      let j = i;
      for (; j >= 0; j--) {
        if (src[j] === ch) depth++;
        else if (src[j] === open && --depth === 0) break;
      }
      if (j < 0) return '';
      // `(JSON{data})` — a parenthesized composite literal names its type.
      if (ch === ')' && out === '') {
        const literal = /^\(\s*&?\s*([A-Za-z_][\w.]*)\s*\{/.exec(src.slice(j, i + 1));
        if (literal) return literal[1]!;
      }
      i = j - 1;
    } else if (/[\w$.:!]/.test(ch)) {
      if (ch !== '!') out = ch + out;
      i--;
    } else break;
  }
  return out.replace(/^[.:]+|[.:]+$/g, '');
}

/**
 * Whether a Rust / Go call of that shape can mean `n`. A bare call never
 * reaches a method (Rust needs `self.` / `Type::`, Go a receiver): axum's
 * routing `get(handler)` went to a cookie jar's `get`. A chained call reaches
 * a method of what its receiver is named after (or of `self`), never a free
 * function: tokio's `sym.filename().map(…)` went to `MutexGuard::map` 156
 * times, cobra's `c.Flags().String(…)` to a test type's `String`.
 */
export function isRustGoCallTarget(n: Node, shape: ReturnType<typeof rustGoCallShape>): boolean {
  if (!shape || shape.shape === 'path') return true;
  const member = n.kind === 'method';
  if (shape.shape === 'bare') return !member;
  if (!member) return n.kind !== 'function';
  // A name the standard library's own types all carry (`unwrap`, `clone`,
  // `iter`, Go's `String` / `Get`) needs a receiver named after the owner; a
  // project-specific one keeps its match — clap's `flag("n").short('n')` is
  // `Arg::short`, cobra's `c.Root().Name()` `Command::Name`.
  // Go's `w.Header().Get(…)` / `r.Header.Set(…)`: net/http's Header map.
  if (n.language === 'go' && /(?:^|\.)Header$/.test(shape.receiver) && /^(?:Get|Set|Add|Del|Values|Clone|Write)$/.test(n.name)) return false;
  const std = (n.language === 'go' ? GO_STD_METHODS : RUST_STD_METHODS).has(n.name);
  return !std || /^(?:self|Self)$/.test(shape.receiver) || (shape.receiver !== '' && sharesReceiverWord(shape.receiver, n));
}

/** Names the Rust prelude puts in every module; a project item of the same name needs a `use` to shadow one. */
const RUST_PRELUDE = new Set([
  'Ok', 'Err', 'Some', 'None', 'Result', 'Option', 'Box', 'Vec', 'String', 'Default', 'Drop', 'Iterator',
  'IntoIterator', 'From', 'Into', 'Clone', 'Copy', 'Send', 'Sync', 'Sized', 'ToString', 'ToOwned', 'PartialEq',
  'Eq', 'PartialOrd', 'Ord', 'AsRef', 'AsMut', 'Fn', 'FnMut', 'FnOnce', 'Extend', 'drop',
]);

interface RustUses {
  /** Every identifier in the file's project `use` trees — not `std::` / `core::` / `alloc::` ones. */
  names: Set<string>;
  /** `X` of each `use …::X::*` (`super` for `use super::*`). */
  globs: Set<string>;
  /** Names the file imports from outside the project — `use std::task::{Context, Poll}`, `use futures::Stream`. */
  external: Set<string>;
  /** The items the file's project `use`s bind — their leaves, not the paths they walk. */
  bound: Set<string>;
}

export const RUST_CRATES = new WeakMap<ResolutionContext, Set<string>>();
export const RUST_DEPENDENCIES = new WeakMap<ResolutionContext, Set<string>>();

/**
 * The crates the project's manifests depend on (`[dependencies]`,
 * `[dev-dependencies]`, `[build-dependencies]`, per-target ones), by the name
 * code writes them (`futures_util`), less the project's own.
 */
function rustDependencyCrates(context: ResolutionContext): Set<string> {
  const hit = RUST_DEPENDENCIES.get(context);
  if (hit) return hit;
  const deps = new Set<string>();
  const manifests = ['Cargo.toml', ...[...getCargoWorkspaceCrateMap(context).values()].map((dir) => `${dir}/Cargo.toml`)];
  for (const manifest of new Set(manifests)) {
    const text = context.readFile(manifest) ?? '';
    let inDeps = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      const header = /^\[([^\]]+)\]$/.exec(line);
      if (header) {
        const table = header[1]!.trim();
        // `[dependencies.tokio]` names one dependency in its header.
        const named = /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(table);
        if (named) deps.add(named[1]!.replace(/-/g, '_'));
        inDeps = /(?:^|\.)(?:dev-|build-)?dependencies$/.test(table);
        continue;
      }
      const key = inDeps ? /^([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1] : undefined;
      if (key) deps.add(key.replace(/-/g, '_'));
    }
  }
  for (const own of rustProjectCrates(context)) deps.delete(own);
  RUST_DEPENDENCIES.set(context, deps);
  return deps;
}

/** The project's own crate names (`tokio`, `tokio_util`), from its Cargo.toml files. */
function rustProjectCrates(context: ResolutionContext): Set<string> {
  const hit = RUST_CRATES.get(context);
  if (hit) return hit;
  const crates = new Set<string>();
  // The manifests are not indexed files: the root's package, and the workspace's members.
  const root = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(context.readFile('Cargo.toml') ?? '')?.[1];
  if (root) crates.add(root.replace(/-/g, '_'));
  for (const name of getCargoWorkspaceCrateMap(context).keys()) crates.add(name.replace(/-/g, '_'));
  RUST_CRATES.set(context, crates);
  return crates;
}
export const RUST_USES = new WeakMap<ResolutionContext, Map<string, RustUses>>();

function rustUsesOf(filePath: string, context: ResolutionContext): RustUses {
  let memo = RUST_USES.get(context);
  if (!memo) {
    memo = new Map();
    RUST_USES.set(context, memo);
  }
  const hit = memo.get(filePath);
  if (hit) return hit;
  const uses: RustUses = { names: new Set(), globs: new Set(), external: new Set(), bound: new Set() };
  const leaves = (tree: string): string[] => [
    ...[...tree.matchAll(/([A-Za-z_]\w*)\s*(?=[,}]|$|\s+as\b)|\bas\s+([A-Za-z_]\w*)/g)]
      .map((leaf) => leaf[2] ?? leaf[1]!).filter((id) => id !== 'self' && id !== 'as'),
    // `use std::io::{self, Read}` binds `io` too.
    ...[...tree.matchAll(/([A-Za-z_]\w*)\s*::\s*\{[^{}]*\bself\b/g)].map((m) => m[1]!),
  ];
  // Comments first: a doc comment's prose ("…use the Option…") is not a `use`.
  const text = stripCommentsForRegex(context.readFile(filePath) ?? '', 'rust');
  const dependencies = rustDependencyCrates(context);
  for (const m of text.matchAll(/(?:^|[;{}\s])use\s+([^;]{1,2000});/g)) {
    const tree = m[1]!;
    const root = /^\s*(?:::)?([A-Za-z_]\w*)/.exec(tree)?.[1] ?? '';
    // Outside: the standard library or a crate the manifests depend on — not a
    // module of the project's (`mod support { … }` inline in a test).
    const outside = root === 'std' || root === 'core' || root === 'alloc' || (root !== '' && dependencies.has(root));
    // The items it binds: each leaf (`as` aliases by their alias), never the path it walks.
    if (outside) {
      for (const id of leaves(tree)) uses.external.add(id);
      continue;
    }
    for (const id of leaves(tree)) uses.bound.add(id);
    for (const id of tree.matchAll(/[A-Za-z_]\w*/g)) uses.names.add(id[0]);
    for (const g of tree.matchAll(/(\w+)\s*::\s*(?:\{[^}]*)?\*/g)) uses.globs.add(g[1]!);
  }
  memo.set(filePath, uses);
  return uses;
}

/** The module a Rust file is: `src/glob.rs` → `glob`, `src/walk/mod.rs` → `walk`. */
function rustModuleName(filePath: string): string {
  const parts = filePath.split('/');
  const base = parts[parts.length - 1]!.replace(/\.rs$/, '');
  return base === 'mod' || base === 'lib' || base === 'main' ? parts[parts.length - 2] ?? base : base;
}

/** Does one of the file's globs bring in this candidate's module (or, for `use super::*`, its parent's)? */
function rustGlobCovers(uses: RustUses, candidate: Node, ref: UnresolvedRef): boolean {
  if (uses.globs.has(rustModuleName(candidate.filePath))) return true;
  if (!uses.globs.has('super')) return false;
  const dir = (p: string): string => p.slice(0, p.lastIndexOf('/'));
  // `use super::*` in a child module: the parent's file, or a sibling in the parent's directory.
  return dir(candidate.filePath) === dir(ref.filePath) || dir(candidate.filePath) === dir(dir(ref.filePath));
}

/**
 * Whether a bare Rust name can mean this candidate. An enum's variant is in
 * scope bare only through a `use` of it or of its enum's `*`, and never
 * names a TYPE — ripgrep's every `Some(x)` bound to its `EncodingMode::Some`
 * variant, every `Ok(x)` to `ParseResult::Ok`. A prelude name (`Ok`,
 * `Result`, `Box`) is the prelude's unless the file defines it or imports a
 * project item of that name — serde's macro-hygiene tests declare `struct
 * Ok`, `struct Result`, and serde bound its own `Ok(…)` and `Result<…>` to them.
 */
export function isRustNameInScope(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const name = ref.referenceName;
  // Bare in the SOURCE: the index keeps `crate::error::Result` by its last
  // segment, and a path is not a prelude lookup.
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  // Written through a path on its line (`jsont::SubMatch { … }`, `io::Result<…>`),
  // wherever the reference's column points.
  const pathed = line === undefined ? null
    : (line.startsWith(name, ref.column) && /::\s*$/.test(line.slice(0, ref.column)) ? /((?:[A-Za-z_]\w*\s*::\s*)*)([A-Za-z_]\w*)?\s*::\s*$/.exec(line.slice(0, ref.column))
      : !new RegExp(`(?<![\\w$:])${name}\\b`).test(line) ? new RegExp(`((?:[A-Za-z_]\\w*\\s*::\\s*)*)([A-Za-z_]\\w*)\\s*::\\s*${name}\\b`).exec(line) : null);
  if (pathed) {
    // Through a path: `crate::` / `self::` / `super::` look it up relatively;
    // `io::Result` is the `io` module's — tokio's `runtime/task` alias is not —
    // and a path from std (`std::io::Error`) is std's.
    const seg = pathed[2] ?? '';
    const root = /^([A-Za-z_]\w*)/.exec(pathed[1] ?? '')?.[1] ?? seg;
    // `Self::Error` in a signature is the enclosing impl's (or trait's) own
    // associated type, and `V::Value` an associated type of a generic's bound —
    // never a struct of that name: serde's 334 `Self::Error`s went to
    // `de::value::Error`.
    if (ref.referenceKind === 'references' && (pathed[1] ?? '') === '' && line !== undefined) {
      if (seg === 'Self') return candidate.kind === 'type_alias' && isInEnclosingRustImpl(candidate, ref, context);
      if (isRustGenericParam(seg, ref, context)) return false;
    }
    if ((root === 'std' || root === 'core' || root === 'alloc') && candidate.filePath !== ref.filePath) return false;
    // A project crate's name re-exports as `crate::` does: `clap::Command` is clap_builder's.
    if (seg === '' || seg === 'crate' || seg === 'self' || seg === 'super' || seg === 'Self' || candidate.filePath === ref.filePath ||
        rustProjectCrates(context).has(seg)) return true;
    // `io::Error` under `use std::io;` is std's, whatever `io/` directory the project has.
    const pathUses = rustUsesOf(ref.filePath, context);
    if (pathUses.external.has(seg) && !pathUses.bound.has(seg)) return false;
    return rustModuleName(candidate.filePath) === seg || candidate.filePath.includes(`/${seg}/`) ||
      candidate.qualifiedName.split('::').includes(seg);
  }
  if (candidate.kind === 'enum_member') {
    if (ref.referenceKind === 'references') return false;
    const uses = rustUsesOf(ref.filePath, context);
    const cut = candidate.qualifiedName.lastIndexOf('::');
    const owner = cut >= 0 ? candidate.qualifiedName.slice(0, cut).split('::').pop()! : '';
    return (owner !== '' && uses.globs.has(owner)) || (uses.names.has(name) && uses.names.has(owner));
  }
  if (candidate.filePath === ref.filePath) return true;
  const uses = rustUsesOf(ref.filePath, context);
  // `use std::task::{Context, Poll}`: the file's `Context` is std's, not tokio's
  // `runtime::context::Context`. (A method call `.env(…)` is no imported name.)
  if (uses.external.has(name) && !uses.bound.has(name) && line !== undefined) {
    // Not on its line at all: a later link of a chain written across lines (`Arg::new(…)\n.env(…)`).
    const at = new RegExp(`(?<![\\w$])${name}\\b`).exec(line.slice(Math.max(0, ref.column)));
    if (at && !/\.\s*$/.test(line.slice(0, Math.max(0, ref.column) + at.index))) return false;
  }
  if (!RUST_PRELUDE.has(name)) {
    // Another file's item — a type, a function — is in scope only through a
    // `use` that binds it or a glob over its module: tokio's `Context<'_>` is
    // not `runtime::task::trace`'s `Context` unless the file brings that one
    // in. A method is reached through a value, never a `use`.
    if (TYPE_MEMBER_KINDS.has(candidate.kind) || ref.referenceKind === 'imports' ||
        candidate.kind === 'file' || candidate.kind === 'module' || candidate.kind === 'namespace') return true;
    return uses.bound.has(name) || rustGlobCovers(uses, candidate, ref);
  }
  return uses.names.has(name) || rustGlobCovers(uses, candidate, ref);
}

/** The line of the `impl` / `trait` header above `ref` in its file (0 for none). */
function rustEnclosingImplLine(ref: UnresolvedRef, context: ResolutionContext): number {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? [];
  for (let i = ref.line - 1; i >= 0; i--) {
    if (/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(?:impl|trait)\b/.test(lines[i] ?? '')) return i + 1;
  }
  return 0;
}

/** Whether `candidate` is declared in the same `impl` / `trait` block as `ref`, above it. */
function isInEnclosingRustImpl(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const header = rustEnclosingImplLine(ref, context);
  return header > 0 && candidate.filePath === ref.filePath && candidate.startLine >= header && candidate.startLine <= ref.line;
}

/** Whether `name` is a generic type parameter of the function or impl around `ref` (`fn f<V: Visitor>`, `impl<'de, E>`). */
function isRustGenericParam(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (!/^[A-Z]\w*$/.test(name)) return false;
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? [];
  const from = Math.max(0, rustEnclosingImplLine(ref, context) - 1);
  const text = lines.slice(from, ref.line).join('\n');
  return new RegExp(`<[^<>]*(?:<[^<>]*>[^<>]*)*\\b${name}\\b\\s*(?:[:,>=])`).test(text);
}

// Rust primitives and the prelude's own types: a field of one of these never
// names a project type, so a `self.<field>.<method>()` on it stays unresolved.
const RUST_NON_PROJECT_FIELD_TYPES = new Set([
  'bool', 'char', 'str', 'String',
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
  'f32', 'f64',
  'Self', 'self',
]);

/**
 * Reduce a Rust field's declared type text to the simple name of the type a
 * method call on that field auto-derefs to, or null when there is none we can
 * name. Only the layers Rust's method-call auto-deref looks through are
 * unwrapped: references (`&`, `&'a mut`) and the owning smart pointers
 * (`Box`, `Rc`, `Arc`) — `self.inner.run()` with `inner: Box<Inner>` calls
 * `Inner::run`. Containers that do NOT auto-deref to their parameter
 * (`Option<Inner>`, `Vec<Inner>`, `Mutex<Inner>`, `RefCell<Inner>`) keep their
 * own name and, having no project node, resolve to nothing — `self.items.push()`
 * must never become `Inner::push`. A trait object (`Box<dyn Source>`) yields
 * the trait, whose method node the interface-impl synthesizer fans out. A
 * generic parameter (`T`), a primitive, a tuple / array / raw pointer / fn
 * type, or a non-identifier yields null.
 */
export function rustFieldTypeName(raw: string): string | null {
  let t = raw.trim();
  for (;;) {
    const before = t;
    t = t.replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, '');
    t = t.replace(/^(?:Box|Rc|Arc)\s*<\s*/, '');
    t = t.replace(/^(?:dyn|impl)\s+/, '');
    if (t === before) break;
  }
  // Drop generic args, the closing `>`s of unwrapped pointers, and trait-object
  // bounds (`dyn Source + Send`); keep the last path segment.
  t = t.replace(/[<>+].*$/, '').trim();
  const seg = t.split('::').filter(Boolean).pop();
  if (!seg || !/^[A-Za-z_]\w*$/.test(seg)) return null;
  if (RUST_NON_PROJECT_FIELD_TYPES.has(seg)) return null;
  if (/^[A-Z]$/.test(seg)) return null; // bare single-letter generic parameter
  return seg;
}

/**
 * `self.method()` in Rust — the method on the type the call sits inside.
 *
 * The owner is the calling method's qualified-name prefix (`Target::run` →
 * `Target`), which is where the `impl` block's type ends up. A free function
 * has no `self`, so a caller whose qualified name carries no owner declines.
 * Exactly one candidate must belong to that owner: a project with two `impl`
 * blocks for the same type is normal, two same-named methods on it is not, and
 * guessing between them is the failure this replaces.
 */
export function matchRustSelfCall(
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const caller = context.getNodeById?.(ref.fromNodeId);
  if (!caller?.qualifiedName) return null;
  const sep = caller.qualifiedName.lastIndexOf('::');
  if (sep <= 0) return null; // a free fn has no `self`
  const owner = caller.qualifiedName.slice(0, sep);

  let owned = context
    .getNodesByQualifiedName(`${owner}::${methodName}`)
    .filter(
      (n) =>
        n.kind === 'method' &&
        n.language === 'rust' &&
        n.qualifiedName === `${owner}::${methodName}`,
    );
  // Rust's extracted qualified names omit module paths. Two modules can
  // each declare `Target`; matching just `Target::reset` does not establish
  // ownership. In that case require a single owner declaration in the
  // caller's file and a method in that file. Otherwise leave it unresolved.
  // A unique owner still permits ordinary impl blocks split across files.
  const owners = context.getNodesByQualifiedName(owner).filter((n) =>
    n.language === 'rust' && ['struct', 'enum', 'union', 'trait', 'class'].includes(n.kind));
  if (owners.length > 1) {
    if (owners.filter((n) => n.filePath === caller.filePath).length !== 1) return null;
    owned = owned.filter((n) => n.filePath === caller.filePath);
  }
  if (owned.length !== 1) return null;

  return {
    original: ref,
    targetNodeId: owned[0]!.id,
    confidence: 0.9,
    resolvedBy: 'qualified-name',
  };
}

/**
 * Resolve a Rust call through a field of the enclosing type —
 * `self.inner.run()`, emitted by the extractor as `self.inner.run` (#1585).
 * Mirrors the Go 2-hop precedent above (#1276): the owner type is the calling
 * method's qualified-name prefix (`Outer::run` → `Outer`), the field's declared
 * type comes from the owner struct's OWN declaration lines, and the method is
 * resolved AND VALIDATED on that type by resolveMethodOnType. The caller
 * treats this branch as exclusive for `self.<field>` receivers: a field whose
 * type is external (`std::vec::IntoIter`, `regex::Regex`), a generic
 * parameter, or not declared where we can see it yields null and the ref stays
 * unresolved. Rust struct fields are not graph nodes, so the declaration text
 * is the only place the type lives.
 */
export function matchRustSelfFieldCall(
  field: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  // The extractor only ever emits a single field hop; anything else is not ours.
  if (!field || field.includes('.')) return null;
  const caller = context.getNodeById?.(ref.fromNodeId);
  if (!caller) return null;
  const sep = caller.qualifiedName.lastIndexOf('::');
  if (sep <= 0) return null; // a free fn has no `self`
  const owner = caller.qualifiedName.slice(0, sep).split('::').pop();
  if (!owner) return null;

  const owners = preferCallSiteFile(context.getNodesByName(owner), ref.filePath).filter(
    (n) =>
      (n.kind === 'struct' || n.kind === 'union' || n.kind === 'class') &&
      n.language === 'rust'
  );
  const fieldEsc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `pub inner: Inner,` / `inner: Box<dyn Source>,` / `pub(crate) inner: T }` —
  // the type text runs to the field separator. A comma inside generic args
  // (`HashMap<K, V>`) truncates the capture, which rustFieldTypeName then
  // reduces to the container's own name — exactly the non-deref case it
  // refuses anyway.
  const fieldRe = new RegExp(`\\b${fieldEsc}\\s*:\\s*([^,{}]+)`);
  for (const s of owners) {
    const source = context.readFile(s.filePath);
    if (!source) continue;
    // Only the struct's own declaration lines, comment-stripped line by line —
    // same discipline as the Go helper: prose or a same-named identifier
    // elsewhere in the file can never donate a type.
    const declLines = source.split('\n').slice(Math.max(0, s.startLine - 1), s.endLine);
    for (const rawLine of declLines) {
      const line = rawLine.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      const m = line.match(fieldRe);
      if (!m || !m[1]) continue;
      const fieldType = rustFieldTypeName(m[1]);
      // The field is declared here; whether or not its type names a project
      // symbol, this owner is the answer — no other same-named struct applies.
      if (!fieldType) return null;
      return resolveMethodOnType(fieldType, methodName, ref, context, 0.85, 'instance-method');
    }
  }
  return null;
}
