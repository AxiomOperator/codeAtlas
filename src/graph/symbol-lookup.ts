/**
 * Symbol Lookup — the single "what did the user mean by this name?" path.
 *
 * Every verb that takes a symbol NAME from a human (or an agent) has to turn
 * that string into node(s). `codegraph_node` and `codegraph_explore` went
 * through the matcher below; the `callers` / `callees` / `impact` CLI verbs
 * carried their own ad-hoc filter instead:
 *
 *     node.name === symbol || node.name.endsWith('.' + symbol)
 *
 * which compares the query against the BARE name only. That produced two
 * opposite failures in the same repository:
 *
 *   - a bare name over-reported: `callers group` silently merged the callers of
 *     every distinct symbol named `group` — in any language — into one list
 *     headed "Callers of group", with nothing saying they were different
 *     symbols;
 *   - a qualified name under-reported: `Foo.Bar.baz` can never equal a bare
 *     `baz`, so every candidate failed the filter and the code fell through to
 *     an arbitrary top-of-FTS hit — or reported "not found" for a symbol that
 *     plainly exists.
 *
 * Both are fixed by routing all of them through one resolver, which this module
 * owns so the CLI and the MCP tools cannot drift apart again.
 */

import type { Node } from '../types';

/** Rust path prefixes that name no directory (`crate::x`, `super::y`). */
export const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

/** Does this query carry any scope qualifier at all? */
export function isQualifiedSymbol(symbol: string): boolean {
  return /[.\/]|::/.test(symbol);
}

/** The bare identifier at the end of a qualified query (arity spelling stripped). */
export function lastQualifierPart(symbol: string): string {
  const noArity = symbol.replace(/\/\d{1,3}$/, '') || symbol;
  const parts = noArity.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
}

/**
 * Rewrite every scope separator to `.` so a query and a stored qualifiedName
 * written in different conventions can be compared directly. The extractors
 * join hierarchy with `::` while users type the language's own spelling
 * (`Session.request`, `stage_apply::run`, `pkg/mod.Fn`).
 */
function canonicalScope(text: string): string {
  return text.replace(/::/g, '.').replace(/\//g, '.');
}

/**
 * Does `node` satisfy the user's symbol query?
 *
 * Bare queries match the name. Qualified queries are checked against the
 * qualifiedName under both separator conventions, then — for languages whose
 * hierarchy lives in the file path rather than the name (Rust modules, Python
 * packages) — against the path.
 */
export function matchesSymbol(node: Node, symbol: string): boolean {
  // Erlang arity spelling (`fn/3`, `mod:fn/3`): when the node's qualifiedName
  // carries an arity (#1610) the written arity must match exactly, and the rest
  // of the comparison runs on the arity-less spelling. A node with no arity
  // keeps the original symbol (a `/` there means a path-ish name instead).
  const aritySpelling = /^(.+)\/(\d{1,3})$/.exec(symbol);
  if (aritySpelling) {
    const nodeArity = /\/(\d{1,3})$/.exec(node.qualifiedName ?? '')?.[1];
    if (nodeArity !== undefined) {
      if (nodeArity !== aritySpelling[2]) return false;
      symbol = aritySpelling[1]!;
    }
  }

  if (node.name === symbol) return true;
  // File basename match ("product-card" matches "product-card.liquid").
  if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) return true;

  if (!isQualifiedSymbol(symbol)) return false;
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  if (parts.length < 2) return false;

  const lastPart = parts[parts.length - 1]!;
  if (node.name !== lastPart) return false;

  // Stage 1: qualified-name containment under the extractor's `::` convention.
  if (node.qualifiedName.includes(parts.join('::'))) return true;

  // Stage 1b: boundary-aligned suffix under a canonical separator.
  //
  // Splitting on EVERY separator assumes no scope component contains one —
  // false for any language whose module names are themselves dotted (Elixir
  // `AppWeb.Format`, a Java/C# package, a Python dotted module). There the
  // stored qualifiedName is `AppWeb.Format::group`, so the stage-1 spelling
  // `AppWeb::Format::group` cannot match and a perfectly precise query
  // resolved to nothing. Canonicalising both sides and requiring the match to
  // land on a separator boundary handles both conventions with one rule, and
  // is strictly tighter than the `includes` above.
  const canonicalQuery = canonicalScope(symbol);
  const canonicalNode = canonicalScope(node.qualifiedName);
  if (canonicalNode === canonicalQuery || canonicalNode.endsWith(`.${canonicalQuery}`)) {
    return true;
  }

  // Stage 2: file-path containment. Rust modules and Python packages are not in
  // qualifiedName — they are encoded in the path — so `stage_apply::run`
  // matches a `run` in any file with a `stage_apply` path segment.
  const containerHints = parts.slice(0, -1).filter((p) => !RUST_PATH_PREFIXES.has(p));
  if (containerHints.length === 0) return false;
  const segments = node.filePath.split('/').filter((s) => s.length > 0);
  return containerHints.every((hint) =>
    segments.some((seg) => seg === hint || seg.replace(/\.[^.]+$/, '') === hint)
  );
}

/** The slice of CodeGraph a symbol lookup needs — keeps this module testable. */
export interface SymbolLookupHost {
  getNodesByName(name: string): Node[];
  /** Index range scan; used for the exact file-basename convenience. */
  getNodesByNamePrefix?(prefix: string, limit?: number): Node[];
  searchNodes(query: string, options?: { limit?: number }): Array<{ node: Node }>;
  generatedFilePredicate(paths: string[]): (path: string) => boolean;
}

export interface SymbolLookupResult {
  /** Every definition the query names, keepers before generated stubs. */
  nodes: Node[];
  /**
   * The query named more than one distinct definition. Callers that aggregate
   * across all of them MUST surface this — an aggregate presented as one
   * symbol's answer is the over-reporting failure described at the top.
   */
  ambiguous: boolean;
  /**
   * Only when `nodes` is empty: a few close names (case-insensitive qualified
   * spellings first, then top fuzzy hits) to offer as "did you mean". These are
   * SUGGESTIONS — never render one as the answer for the typed name (#1473).
   */
  suggestions: string[];
}

/**
 * One group per (filePath, qualifiedName): same-file overloads stay together,
 * while unrelated definitions keep their own edges. Shared by CLI and MCP.
 * A non-matching file hint keeps all definitions and must be disclosed.
 */
export function groupDefinitions(
  nodes: Node[],
  fileFilter?: string
): { groups: Node[][]; filteredOut: boolean } {
  let pool = nodes;
  let filteredOut = false;
  if (fileFilter) {
    const wanted = fileFilter.replace(/^\.\//, '');
    const narrowed = pool.filter(
      (n) => n.filePath === wanted || n.filePath.endsWith(wanted) || n.filePath.endsWith(`/${wanted}`)
    );
    if (narrowed.length > 0) pool = narrowed;
    else filteredOut = true;
  }
  const byDef = new Map<string, Node[]>();
  for (const n of pool) {
    const key = `${n.filePath}|${n.qualifiedName}`;
    const group = byDef.get(key);
    if (group) group.push(n);
    else byDef.set(key, [n]);
  }
  return { groups: [...byDef.values()], filteredOut };
}

/** How many did-you-mean names a not-found answer offers. */
export const MAX_SYMBOL_SUGGESTIONS = 3;

/**
 * Resolve a user-supplied symbol name to the definitions it names — the ONE
 * derivation behind `codegraph_node`, `codegraph_callers` / `callees` /
 * `impact` (via `findAllSymbols`), explore's Flow tokens and the CLI verbs.
 *
 * The exact-name index is consulted FIRST and is authoritative: it is complete
 * and uncapped, whereas FTS ranks and truncates, and tokenises away `::` — so
 * a qualified query could miss a symbol that exists (tokio `Harness::poll`
 * among 50+ `poll`s), or land on whatever happened to rank first. A qualified
 * query enumerates every def of its LAST part and filters by the qualifier the
 * user wrote. A bare name that names no symbol may still name a FILE by its
 * exact basename (`product-card` → `product-card.liquid`); nothing fuzzy.
 * Partial or mistyped names never select the top fuzzy hit (#1473, #1455) —
 * they come back empty with `suggestions`.
 */
export function lookupSymbolNodes(cg: SymbolLookupHost, symbol: string): SymbolLookupResult {
  const qualified = isQualifiedSymbol(symbol);
  const seen = new Set<string>();
  const add = (into: Node[], list: Node[]) => {
    for (const n of list) if (!seen.has(n.id)) { seen.add(n.id); into.push(n); }
  };

  const nodes: Node[] = [];
  // A literal name first: some names carry separators themselves (a file node
  // `auth.ts`, a dotted Nix/Elixir name, Go `pkg/mod.Fn` stored verbatim).
  add(nodes, cg.getNodesByName(symbol).filter((n) => matchesSymbol(n, symbol)));
  let tailNodes: Node[] = [];
  if (qualified) {
    const tail = lastQualifierPart(symbol);
    tailNodes = tail && tail !== symbol ? cg.getNodesByName(tail) : [];
    add(nodes, tailNodes.filter((n) => matchesSymbol(n, symbol)));
  }

  // Exact file-basename convenience (`stage_apply` → `stage_apply.rs`). An
  // index range scan, not FTS; `matchesSymbol` keeps it to an EXACT basename.
  if (nodes.length === 0 && cg.getNodesByNamePrefix) {
    add(
      nodes,
      cg.getNodesByNamePrefix(`${symbol}.`, 50).filter((n) => n.kind === 'file' && matchesSymbol(n, symbol))
    );
  }

  if (nodes.length === 0) {
    return { nodes: [], ambiguous: false, suggestions: suggestSymbolNames(cg, symbol, tailNodes) };
  }

  // Keepers before generated stubs (.pb.go and friends), stable otherwise.
  const isGenerated = cg.generatedFilePredicate(nodes.map((n) => n.filePath));
  const ranked = [...nodes].sort(
    (a, b) => (isGenerated(a.filePath) ? 1 : 0) - (isGenerated(b.filePath) ? 1 : 0)
  );
  return { nodes: ranked, ambiguous: groupDefinitions(ranked).groups.length > 1, suggestions: [] };
}

/**
 * Did-you-mean names for a symbol query that resolved to nothing. A qualified
 * query whose only fault is letter case (`a.b.c.d.e` for `a.b.c.D.e`, #1455)
 * gets the real spelling first; then the top fuzzy FTS names. Never the typed
 * name itself.
 */
export function suggestSymbolNames(
  cg: SymbolLookupHost,
  symbol: string,
  tailNodes?: Node[]
): string[] {
  const out: string[] = [];
  const push = (name: string) => {
    if (name && name !== symbol && !out.includes(name) && out.length < MAX_SYMBOL_SUGGESTIONS) out.push(name);
  };

  if (isQualifiedSymbol(symbol)) {
    const lowered = symbol.toLowerCase();
    const tail = lastQualifierPart(symbol);
    const pool = tailNodes ?? (tail ? cg.getNodesByName(tail) : []);
    for (const n of pool) {
      const lc: Node = {
        ...n,
        name: n.name.toLowerCase(),
        qualifiedName: (n.qualifiedName ?? '').toLowerCase(),
        filePath: n.filePath.toLowerCase(),
      };
      if (matchesSymbol(lc, lowered)) push(canonicalScope(n.qualifiedName || n.name));
    }
  }

  let fuzzy: Array<{ node: Node }> = [];
  try {
    fuzzy = cg.searchNodes(symbol, { limit: 10 });
    if (fuzzy.length === 0 && isQualifiedSymbol(symbol)) {
      const tail = lastQualifierPart(symbol);
      if (tail && tail !== symbol) fuzzy = cg.searchNodes(tail, { limit: 10 });
    }
  } catch {
    fuzzy = [];
  }
  for (const { node } of fuzzy) push(node.name);
  return out;
}

/** One-line "kind at path:line" label used when disclosing an ambiguous query. */
export function describeSymbolNode(node: Node): string {
  return `${node.kind} ${node.qualifiedName || node.name} (${node.language}) — ${node.filePath}:${node.startLine}`;
}
