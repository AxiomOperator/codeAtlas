/**
 * Graph-derived sections of `codegraph_explore` / `codegraph_node` output: the
 * Flow path among named symbols, dynamic/polymorphic boundaries, the blast
 * radius, and the caller/callee trail. Hoisted from `ToolHandler` unchanged.
 */

import type CodeGraph from '../index';
import { guardLabel, guardsForFileSync, siteKey, supportsBranchGuards } from '../graph/branch-guards';
import { type BoundarySite, findDynamicBoundaries } from '../graph/dynamic-boundary-report';
import { resolveNamedSymbolFlow } from '../graph/named-symbol-flow';
import { countImplementers } from '../graph/type-hierarchy';
import { isTestFile } from '../search/query-utils';
import type { Edge, Node, Subgraph } from '../types';
import { validatePathWithinRoot } from '../utils';
import { statSync } from 'fs';

/**
 * The branch conditions a flow hop's call site runs under, read from the
 * caller's source now (`graph/branch-guards.ts`); '' when unconditional,
 * unreadable, or the grammar for that language is not loaded.
 */
export function whenLabel(cg: CodeGraph, caller: Node, edge: Edge): string {
  if (!edge.line || !supportsBranchGuards(caller.language)) return '';
  try {
    const rec = cg.getFile(caller.filePath);
    if (!rec) return '';
    const abs = validatePathWithinRoot(cg.getProjectRoot(), caller.filePath);
    if (!abs) return '';
    const st = statSync(abs);
    // Drifted since the index: the recorded line may point elsewhere.
    if (st.size !== rec.size || Math.floor(st.mtimeMs) !== Math.floor(rec.modifiedAt)) return '';
    const site = { line: edge.line, column: typeof edge.column === 'number' ? edge.column : null };
    const g = guardsForFileSync(abs, caller.language, [site]).get(siteKey(site));
    return g ? guardLabel(g) : '';
  } catch {
    return '';
  }
}

/**
 * Describe a synthesized (dynamic-dispatch) edge for human output: how the
 * callback was wired up — the bridge static parsing can't see. Returns null
 * for ordinary static edges. Used by trace + the node trail so a synthesized
 * hop reads as "registered via onUpdate at App.tsx:3148", not a bare arrow.
 */
export function synthEdgeNote(edge: Edge | null): { label: string; compact: string; registeredAt?: string } | null {
  if (!edge || edge.provenance !== 'heuristic') return null;
  const m = edge.metadata as Record<string, unknown> | undefined;
  const registeredAt = typeof m?.registeredAt === 'string' ? m.registeredAt : undefined;
  const at = registeredAt ? ` @${registeredAt}` : '';
  if (m?.synthesizedBy === 'callback') {
    const via = m.via ? `\`${String(m.via)}\`` : 'a registrar';
    const field = m.field ? ` on .${String(m.field)}` : '';
    return {
      label: `callback — registered via ${via}${field} (dynamic dispatch)`,
      compact: `dynamic: callback via ${via}${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'http-client') {
    const req = `${String(m.method ?? 'GET')} ${String(m.href ?? '')}`.trim();
    return {
      label: `HTTP request \`${req}\` — the client's call onto its own route (cross-tier)`,
      compact: `dynamic: HTTP ${req}${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'queue-job') {
    const job = m.event ? `\`${String(m.event)}\`` : 'a job';
    const queue = m.queue ? ` on queue \`${String(m.queue)}\`` : '';
    return {
      label: `queue job ${job}${queue} — producer → consumer (cross-tier)`,
      compact: `dynamic: queue job ${job}${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'event-bus') {
    const ev = m.event ? `\`${String(m.event)}\`` : 'an event';
    const what = m.channel === 'socket' ? 'socket message' : 'bus event';
    const dir = m.tier === 'client→server' ? ', client → server' : m.tier === 'server→client' ? ', server → client' : '';
    return {
      label: `${what} ${ev} — emit → handler${dir} (dynamic dispatch)`,
      compact: `dynamic: ${what} ${ev}${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'event-emitter') {
    const ev = m.event ? `\`${String(m.event)}\`` : 'an event';
    return {
      label: `event ${ev} — emit → handler (dynamic dispatch)`,
      compact: `dynamic: event ${ev}${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'react-render') {
    return {
      label: `React re-render — \`setState\` re-runs render() (dynamic dispatch)`,
      compact: `dynamic: React re-render via setState${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'jsx-render') {
    const child = m.via ? `<${String(m.via)}>` : 'a child component';
    return {
      label: `renders ${child} (JSX child — dynamic dispatch)`,
      compact: `dynamic: renders ${child}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'vue-handler') {
    const ev = m.event ? `@${String(m.event)}` : 'a template event';
    return {
      label: `Vue template handler — bound to ${ev} (dynamic dispatch)`,
      compact: `dynamic: Vue ${ev} handler`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'interface-impl') {
    return {
      label: `interface/abstract dispatch — runs the implementation override (dynamic dispatch)`,
      compact: `dynamic: interface → impl${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'closure-collection') {
    const field = m.field ? `\`${String(m.field)}\`` : 'a collection';
    return {
      label: `closure collection — runs handlers appended to ${field} (dynamic dispatch)`,
      compact: `dynamic: runs ${field} handlers${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'fn-pointer-dispatch') {
    const via = m.via ? `\`${String(m.via)}\`` : 'a function pointer';
    return {
      label: `function-pointer dispatch via ${via} (dynamic dispatch)`,
      compact: `dynamic: fn-pointer ${m.via ? String(m.via) : ''}${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'goframe-route') {
    const route = m.route ? `\`${String(m.route)}\`` : 'a route';
    return {
      label: `GoFrame route ${route} — reflective Bind → controller method (dynamic dispatch)`,
      compact: `dynamic: GoFrame route ${m.route ? String(m.route) : ''}${at}`,
      registeredAt,
    };
  }
  // Generic fallback for any other synthesizer (redux-thunk, gin-middleware-chain,
  // flutter-build, …): a synthesized hop must never read as a bare static `calls`.
  // It's a dynamic-dispatch bridge — label it as one and keep its wiring site.
  if (typeof m?.synthesizedBy === 'string') {
    const kind = m.synthesizedBy.replace(/-/g, ' ');
    return { label: `${kind} (dynamic dispatch)`, compact: `dynamic: ${kind}${at}`, registeredAt };
  }
  return null;
}

/**
 * Flow-from-named-symbols: an agent's codegraph_explore query is a bag of
 * symbol names that usually spans the flow it's investigating (e.g.
 * "PmsProductController getList PmsProductService list PmsProductServiceImpl").
 * Surface the longest call chain AMONG those named symbols — scoped to what the
 * agent explicitly named, so (unlike a fuzzy relevance set) there's no
 * wrong-feature wandering. Rides synthesized edges, so controller→service-
 * interface→impl shows up. Returns '' if no chain of >=3 nodes exists.
 *
 * Ambiguous tokens (Java `list` → dozens of nodes) are disambiguated by
 * CO-NAMING: the agent names the class too, so we keep only `list` candidates
 * whose qualifiedName contains another named token (`PmsProductServiceImpl::list`),
 * dropping unrelated `OmsOrderService::list`.
 */
export function buildFlowFromNamedSymbols(cg: CodeGraph, query: string): { text: string; pathNodeIds: Set<string>; namedNodeIds: Set<string>; uniqueNamedNodeIds: Set<string>; spineCallSites: Map<string, number> } {
  // spineCallSites: for each spine node, the line where it CALLS the next hop —
  // lets the source assembler window an oversize spine method (e.g. n8n's 962-line
  // processRunExecutionData) to the call site instead of dumping the whole body.
  const EMPTY = { text: '', pathNodeIds: new Set<string>(), namedNodeIds: new Set<string>(), uniqueNamedNodeIds: new Set<string>(), spineCallSites: new Map<string, number>() };
  try {
    // Token resolution — parsing, overload disambiguation, the CONSTANT/
    // VARIABLE synth endpoints — is shared with `/api/flow`, so a name written
    // in the viewer's search box resolves to the same nodes it does here.
    const flow = resolveNamedSymbolFlow(cg, query);
    const { named, dynNamed, tokenNodes, tokenFamily, uniqueNamedNodeIds, preciseNamedIds } =
      flow;
    if (flow.tokens.length < 2) return EMPTY;
    // Surface synthesized (heuristic) edges incident to a named symbol — INCLUDING
    // the non-callable CONSTANT endpoints in `dynNamed`. `skipInChain` drops a hop
    // already shown in the rendered main chain (a 2-node chain renders nothing, so a
    // direct named→named synth hop still surfaces — #687).
    const collectSynthLinks = (skipInChain: ((e: Edge) => boolean) | null): string[] => {
      const synthLines: string[] = [];
      const synthSeen = new Set<string>();
      for (const n of [...named.values(), ...dynNamed.values()]) {
        if (synthLines.length >= 6) break;
        // RAW edges for the same reason as hasHeuristicEdge above — a static
        // edge over the same pair hides the synthesized one from getCallers.
        const incident = [...cg.getIncomingEdges(n.id), ...cg.getOutgoingEdges(n.id)];
        for (const edge of incident) {
          if (synthLines.length >= 6) break;
          if (edge.provenance !== 'heuristic') continue;
          const otherId = edge.source === n.id ? edge.target : edge.source;
          if (otherId === n.id) continue;
          const other = cg.getNode(otherId);
          if (!other) continue;
          if (skipInChain && skipInChain(edge)) continue;
          const src = edge.source === n.id ? n : other;
          const tgt = edge.source === n.id ? other : n;
          const key = `${src.name}>${tgt.name}`;
          if (synthSeen.has(key)) continue;
          synthSeen.add(key);
          const note = synthEdgeNote(edge);
          synthLines.push(`- ${src.name} → ${tgt.name}   [${note ? note.compact : edge.kind}]`);
        }
      }
      return synthLines;
    };
    /**
     * No narrative to print — but the agent still NAMED symbols, and their
     * identity is a separate output from the prose (CG-38).
     *
     * `namedNodeIds` is not decoration: downstream it injects the named def into
     * the file's cluster ranges and ranks it importance 9, which is the whole
     * mechanism behind "a symbol the agent named renders" (the assembler's
     * named-def injection). Returning EMPTY here threw that away whenever the
     * named symbols happened not to form a call chain — two sibling closures in
     * one factory (`queueMessage` / `flushQueuedMessages`, neither calling the
     * other) produce no chain, no synth hop and no dispatch boundary, so BOTH
     * defs lost importance 9 and the file rendered from its head instead: the
     * agent got the `QueuedMessage` interface at L70 and had to Read the file
     * for the functions at L1087/L1102 it had asked for by name.
     *
     * Restricted to SHAPE-PRECISE tokens. With a narrative present the prose is
     * itself corroboration that the resolution was right, so that path keeps
     * every named id as before; with nothing corroborating it, only an
     * unambiguous symbol reference may promote — an English word in a prose
     * question that happens to exact-match a callable must not earn importance 9.
     * Same distinction, same test, as the gather path's `isPreciseToken`.
     */
    const identityOnly = () => (preciseNamedIds.size === 0 ? EMPTY : {
      text: '',
      pathNodeIds: new Set<string>(),
      namedNodeIds: new Set<string>(preciseNamedIds),
      uniqueNamedNodeIds: new Set<string>([...uniqueNamedNodeIds].filter((id) => preciseNamedIds.has(id))),
      spineCallSites: new Map<string, number>(),
    });
    if (named.size < 2) {
      // <2 CALLABLES resolved. Two recoveries before giving up: (1) synthesized
      // edges among named CONSTANT/VARIABLE endpoints — RTK thunk→thunk is
      // constant→constant, so `named` can be empty while `dynNamed` holds the
      // whole chain; (2) the one resolved callable's body may hold the
      // dynamic-dispatch site that EXPLAINS a half-connected flow.
      const synthLines = collectSynthLinks(null);
      const boundaries = named.size === 0 ? '' : (buildDynamicBoundaries(cg, [...named.values()], named) || '');
      if (synthLines.length === 0 && !boundaries) return identityOnly();
      const out: string[] = [];
      if (synthLines.length) out.push(
        '**Dynamic-dispatch links among your symbols**',
        '(synthesized — the indirect hops grep/Read would reconstruct; the `@file:line` is the wiring site)',
        '', ...synthLines, '');
      if (boundaries) out.push(boundaries);
      out.push('> Full source for these symbols is below.\n');
      return { text: out.join('\n'), pathNodeIds: new Set(), namedNodeIds: new Set<string>([...named.keys(), ...dynNamed.keys()]), uniqueNamedNodeIds, spineCallSites: new Map<string, number>() };
    }
    // The search itself lives in `../graph/named-symbol-flow`, so the viewer's
    // Flow strip rides exactly this path finder rather than a second one that
    // could disagree with it. What stays here is the PROSE — the narrative,
    // the dynamic-dispatch links, the boundary announcements.
    const best = flow.chains[0]?.steps ?? null;
    const hasMain = !!best && best.length >= 3;
    const pathIds = new Set((best ?? []).map((s) => s.node.id));
    // Where each spine node calls the NEXT hop — lets the assembler window an
    // oversize spine method to the call instead of dumping the whole body.
    const spineCallSites = flow.chains[0]?.callSites ?? new Map<string, number>();

    // Dynamic-boundary scan (#687) — fires ONLY when the flow the agent
    // asked about did not fully connect: some token resolved to nodes but
    // none of them sit on the main chain (or there is no chain at all). A
    // healthy flow skips this entirely. Scan order: the chain's dead end
    // first (where the partial flow stops), then the disconnected symbols,
    // agent-specific (unique-named) ones first.
    let boundaryText = '';
    {
      const uncovered: Node[] = [];
      if (!hasMain) {
        // No rendered chain — but a 2-node chain still CONNECTS its two
        // endpoints (e.g. via one synthesized hop, surfaced below as a
        // dynamic-dispatch link). Only nodes off that short chain are
        // unexplained breaks worth scanning.
        for (const n of named.values()) if (!pathIds.has(n.id)) uncovered.push(n);
      } else {
        for (const ids of tokenNodes.values()) {
          if (ids.length === 0 || ids.some((id) => pathIds.has(id))) continue;
          for (const id of ids) { const n = named.get(id); if (n) uncovered.push(n); }
        }
      }
      if (uncovered.length > 0) {
        const scanList: Node[] = [];
        if (hasMain) scanList.push(best![best!.length - 1]!.node);
        scanList.push(...uncovered.sort((a, b) =>
          (uniqueNamedNodeIds.has(b.id) ? 1 : 0) - (uniqueNamedNodeIds.has(a.id) ? 1 : 0)));
        boundaryText = buildDynamicBoundaries(cg, scanList, named);
      }
    }

    // Interface/registry-dispatch announcement (extends #687 to GRAPH-visible
    // polymorphism). A method the agent NAMED that resolves to a large same-name
    // family AND did not land on the main chain is almost always a runtime
    // dispatch (plugin/strategy/handler interface): the concrete target is chosen
    // at runtime from N implementations, so no single static edge is the answer.
    // The body-scan above can't see this — `nodeType.execute()` is textually an
    // ordinary call; the polymorphism lives in the graph (implements edges), so
    // detect it there. Fires ONLY for an uncovered named token; a connected flow
    // stays silent.
    let polyText = '';
    {
      const POLY_MIN_FAMILY = 8; // smaller families are overload sets, not dispatch
      const polyCands: Array<{ token: string; family: Node[] }> = [];
      for (const [t, fam] of tokenFamily) {
        if (fam.length < POLY_MIN_FAMILY) continue;
        const ids = tokenNodes.get(t) || [];
        if (ids.some((id) => pathIds.has(id))) continue; // covered by the flow — silent
        polyCands.push({ token: t, family: fam });
      }
      if (polyCands.length) polyText = buildPolymorphicBoundaries(cg, polyCands, named);
    }

    // Supplementary: dynamic-dispatch (synthesized) edges incident to a named
    // symbol (incl. the non-callable CONSTANT endpoints in `dynNamed`) — the
    // indirect hops an agent would otherwise grep/Read to reconstruct ("where do
    // the appended `validators` actually run?"). Surfaced even when the OTHER end
    // wasn't named. The skip drops a hop already in the rendered main chain; a
    // 2-node chain renders nothing (hasMain false) so a direct named→named synth
    // hop still surfaces — too short for Flow, but #687-visible here.
    const synthLines = collectSynthLinks(
      hasMain ? (e: Edge) => pathIds.has(e.source) && pathIds.has(e.target) : null
    );

    if (!hasMain && synthLines.length === 0 && !boundaryText && !polyText) return identityOnly();
    const out: string[] = [];
    if (hasMain) {
      out.push('**Flow (call path among the symbols you queried)**', '');
      for (let i = 0; i < best!.length; i++) {
        const step = best![i]!;
        if (step.edge) {
          const sy = synthEdgeNote(step.edge);
          const when = i > 0 ? whenLabel(cg, best![i - 1]!.node, step.edge) : '';
          out.push(`   ↓ ${sy ? sy.compact : step.edge.kind}${when ? ` (when ${when})` : ''}`);
        }
        out.push(`${i + 1}. ${step.node.name} (${step.node.filePath}:${step.node.startLine})`);
      }
      out.push('');
    }
    if (synthLines.length) {
      out.push(
        '**Dynamic-dispatch links among your symbols**',
        '(synthesized — the indirect hops grep/Read would reconstruct; the `@file:line` is the wiring site)',
        '',
        ...synthLines,
        ''
      );
    }
    if (boundaryText) out.push(boundaryText);
    if (polyText) out.push(polyText);
    out.push('> Full source for these symbols is below — the call flow among them, followed by their bodies.', '');
    // namedNodeIds = every callable the agent explicitly named (a superset of
    // the spine). A file holding one is something the agent asked to SEE, so it
    // must keep full source even if it's an off-spine polymorphic sibling — the
    // agent named `getResponseWithInterceptorChain` / `SQLCompiler.execute_sql`
    // as the mechanism, not as an interchangeable leaf. See the skeleton gate.
    return { text: out.join('\n'), pathNodeIds: pathIds, namedNodeIds: new Set<string>([...named.keys(), ...dynNamed.keys()]), uniqueNamedNodeIds, spineCallSites };
  } catch {
    return EMPTY;
  }
}

/**
 * Dynamic-boundary surfacing (#687): when the flow among the agent's named
 * symbols does not fully connect, scan the disconnected symbols' bodies for
 * dynamic-dispatch sites (computed member calls, getattr, reflection, typed
 * message buses, runtime-keyed emits) and ANNOUNCE the boundary — the exact
 * site, the form, and (when a key is statically visible) candidate targets —
 * instead of guessing edges. The answer to "how does A reach B" when no
 * static path exists IS the dispatch site: that's where the flow continues
 * at runtime. Query-time, deterministic, zero graph mutation; a fully
 * connected flow never reaches this method.
 */
export function buildDynamicBoundaries(cg: CodeGraph, scanList: Node[], named: Map<string, Node>): string {
  const MAX_NOTES = 4; // boundary bullets per explore
  // The verdict is not derived here — `findDynamicBoundaries` produces it and
  // the viewer's end cap renders the same object, so the two can never
  // disagree about where a flow stops. What is left here is the prose.
  const reports = findDynamicBoundaries(cg, scanList, { named, maxSites: MAX_NOTES });
  const notes: string[] = [];
  for (const report of reports) {
    if (notes.length >= MAX_NOTES) break;
    for (const site of report.sites) {
      if (notes.length >= MAX_NOTES) break;
      const more = site.moreSites
        ? ` (+${site.moreSites} more such site${site.moreSites > 1 ? 's' : ''} in this body)`
        : '';
      notes.push(`- \`${report.node.name}\` (${report.node.filePath}:${site.line}) — ${site.label}: \`${site.snippet}\`${more}`);
      const cand = boundaryCandidates(site);
      if (cand) notes.push(`  ${cand}`);
    }
  }
  if (notes.length === 0) return '';
  return [
    '**Dynamic boundaries (the static path ends at runtime dispatch)**',
    '',
    ...notes,
    '',
    '> These sites choose their call target at runtime (registry / bus / reflection) — the site shown IS where the flow continues. To follow it, run codegraph_explore or codegraph_node on a candidate; source for the sites above is included below.',
    '',
  ].join('\n');
}

/**
 * Interface/registry-dispatch announcement — #687 extended to GRAPH-visible
 * polymorphism (the body-scan can't see it: `nodeType.execute()` is textually
 * an ordinary call; the polymorphism lives in the `implements`/`extends` edges).
 *
 * A method the agent named that resolves to a large same-name family whose
 * definers overwhelmingly implement/extend ONE supertype is a runtime dispatch:
 * the concrete target is chosen at runtime from N implementations, so no single
 * static edge is "the answer" — the implementations ARE the continuations. We
 * announce the supertype, its TRUE implementer count, and a few concrete targets,
 * then steer to codegraph_explore. Graph-only, query-time, zero mutation; the
 * caller fires it ONLY for an UNCOVERED named token, so a connected flow is silent.
 *
 * Robust to FTS sampling bias: the same-name family is a capped FTS sample that
 * over-represents whatever FTS ranks first (n8n: DB `TableOperation.execute`
 * outnumbered `INodeType.execute` in the sample 7:6 even though INodeType has
 * 611 implementers vs a handful). So candidate supertypes are ranked by their
 * TRUE graph-wide implementer count, NOT their frequency in the sample.
 */
export function buildPolymorphicBoundaries(cg: CodeGraph, candidates: Array<{ token: string; family: Node[] }>, named: Map<string, Node>): string {
  const CLASSY = new Set(['class', 'struct', 'interface', 'trait', 'protocol', 'abstract']);
  const MIN_IMPL = 8;     // a supertype needs >= this many implementers to count as "polymorphic"
  const MIN_SUPPORT = 2;  // >= this many sampled definers must share the supertype (ties it to the token)
  const SAMPLE = 40;      // family members inspected per token
  const MAX_NOTES = 3;
  const rel = (p: string) => p.replace(/\\/g, '/');
  const containerOf = (m: Node): Node | null => {
    try { const ce = cg.getIncomingEdges(m.id).find((e) => e.kind === 'contains'); return ce ? cg.getNode(ce.source) : null; }
    catch { return null; }
  };
  // A supertype dispatches only a member it (or an ancestor) declares. Without
  // this, any name shared by enough subclasses read as dispatch through their
  // common base: on vscode the query word `extension`, a getter on unrelated
  // classes that all extend `Disposable`, was announced as "runtime dispatch to
  // 2706 types implementing Disposable" at the top of 9 of 31 answers.
  //
  // A Swift protocol and each of its extensions are separate nodes of one name,
  // and a conformer's edge may land on any of them (Alamofire's
  // `RequestInterceptor` conformers point at an extension in OfflineRetrier.swift
  // that has no `adapt`), so every same-named type is asked. The answer is
  // `unknown`, and the announcement stays, whenever absence can't be judged:
  // nothing on the chain has indexed members of the family's sort, or an
  // interface/protocol on it has none (Swift requirements aren't nodes, so
  // `URLRequestConvertible` can't be said to lack `asURLRequest`).
  const memberOfSupertype = (typeId: string, name: string, callable: boolean): 'declared' | 'absent' | 'unknown' => {
    const counts = (kind: string) => !callable || kind === 'method' || kind === 'function';
    let sawMembers = false;
    let opaque = false;
    const seen = new Set<string>();
    const visit = (id: string, depth: number): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      let node: Node | null = null;
      let edges: ReturnType<typeof cg.getOutgoingEdges> = [];
      try { node = cg.getNode(id); edges = cg.getOutgoingEdges(id); } catch { return false; }
      let own = 0;
      for (const e of edges) {
        if (e.kind !== 'contains') continue;
        let child: Node | null = null;
        try { child = cg.getNode(e.target); } catch { child = null; }
        if (!child) continue;
        if (child.name === name) return true;
        if (counts(child.kind)) own++;
      }
      if (own > 0) sawMembers = true;
      else if (node && (node.kind === 'interface' || node.kind === 'protocol' || node.kind === 'trait')) opaque = true;
      if (depth >= 3) return false;
      return edges.some((e) => (e.kind === 'extends' || e.kind === 'implements') && visit(e.target, depth + 1));
    };
    let root: Node | null = null;
    try { root = cg.getNode(typeId); } catch { root = null; }
    let namesakes: Node[] = [];
    try {
      namesakes = root
        ? cg.getNodesByName(root.name).filter((n) => n.language === root!.language && CLASSY.has(n.kind))
        : [];
    } catch { namesakes = []; }
    if (visit(typeId, 0) || namesakes.some((n) => visit(n.id, 0))) return 'declared';
    return sawMembers && !opaque ? 'absent' : 'unknown';
  };
  const notes: string[] = [];
  const seenSuper = new Set<string>();
  for (const { token, family } of candidates) {
    if (notes.length >= MAX_NOTES) break;
    const memberName = family[0]?.name ?? token;
    const callableFamily = family[0]?.kind === 'method' || family[0]?.kind === 'function';
    // supertype id → how many sampled definers share it + a few example definers
    const supers = new Map<string, { node: Node; count: number; targets: Node[] }>();
    for (const m of family.slice(0, SAMPLE)) {
      const container = containerOf(m);
      if (!container || !CLASSY.has(container.kind)) continue;
      let sups: Node[] = [];
      try {
        sups = cg.getOutgoingEdges(container.id)
          .filter((e) => e.kind === 'implements' || e.kind === 'extends')
          .map((e) => { try { return cg.getNode(e.target); } catch { return null; } })
          .filter((n): n is Node => !!n && CLASSY.has(n.kind) && (n.name?.length || 0) >= 3);
      } catch { /* no supertypes — free function or unresolved */ }
      for (const s of sups) {
        const e = supers.get(s.id) || { node: s, count: 0, targets: [] };
        e.count++;
        if (e.targets.length < 6) e.targets.push(m);
        supers.set(s.id, e);
      }
    }
    // Pick the supertype with the most TRUE implementers (graph-wide), among
    // those genuinely shared by the token's definers.
    let best: { node: Node; impl: number; targets: Node[] } | null = null;
    for (const { node, count, targets } of supers.values()) {
      if (count < MIN_SUPPORT) continue;
      // The implementer count is `countImplementers` — the same function the
      // viewer's type-hierarchy fan counts with, so "dispatch to N types
      // implementing X" is the same N on both surfaces (CG-58). Distinct
      // types, not edges: a class tied to its supertype by both a parsed
      // `extends` and a synthesized `implements` is one implementation.
      const impl = countImplementers(cg, node.id);
      if (impl < MIN_IMPL) continue;
      if (best && impl <= best.impl) continue;
      if (memberOfSupertype(node.id, memberName, callableFamily) === 'absent') continue;
      best = { node, impl, targets };
    }
    if (!best || seenSuper.has(best.node.id)) continue;
    seenSuper.add(best.node.id);
    const namedNames = new Set([...named.values()].map((n) => n.name));
    const eg = best.targets.slice(0, 4).map((m) => {
      const cont = containerOf(m);
      const disp = cont ? `${cont.name}.${m.name}` : (m.qualifiedName || m.name);
      const mark = cont && namedNames.has(cont.name) ? ' ← you named this' : '';
      return `\`${disp}\` (${rel(m.filePath)}:${m.startLine})${mark}`;
    });
    const more = best.impl > eg.length ? ` +${best.impl - eg.length} more` : '';
    notes.push(`- \`${token}\` → runtime dispatch to **${best.impl}** types implementing \`${best.node.name}\` — the static path ends here, the target is chosen at runtime. e.g. ${eg.join(', ')}${more}`);
  }
  if (notes.length === 0) return '';
  return [
    '**Interface dispatch (a named method has many implementations)**',
    '',
    ...notes,
    '',
    '> The method above is dispatched at runtime to one of the listed implementations (a registry / plugin / strategy interface) — there is no single static caller→callee edge; the implementations ARE the continuations. To follow one, run codegraph_explore on a listed target.',
    '',
  ].join('\n');
}

/**
 * Render the candidate shortlist for a dispatch site as one line.
 *
 * The shortlist itself is `shortlistBoundaryCandidates` in
 * `../graph/dynamic-boundary-report` — shared with the viewer's end cap, so
 * "candidates for key `save`" names the same symbols in both places. Symbols
 * the agent already named are marked: that is the "you were right, here's the
 * wiring" case.
 */
export function boundaryCandidates(site: BoundarySite): string {
  if (site.candidates.length === 0) return site.candidateNote ?? '';
  const list = site.candidates.map((c) =>
    `\`${c.display}\` (${c.node.filePath}:${c.node.startLine})${c.named ? ' ← you named this' : ''}`
  );
  return `candidates for key \`${site.key}\`: ${list.join(', ')}`;
}

/**
 * Compact "blast radius" for the entry symbols of an explore result: who
 * depends on each (callers) and which test files cover it — LOCATIONS ONLY,
 * no source, so the agent knows what to update / re-verify before editing
 * without reaching for a separate impact call. Always-on, but skips symbols
 * that have no dependents (nothing to warn about), and returns '' when none
 * qualify so a leaf-only exploration stays clean.
 */
export function buildBlastRadiusSection(
  cg: CodeGraph,
  subgraph: Subgraph,
  /**
   * Exact targets (a qualified name, a line anchor) lead the list. The search
   * roots are whatever FTS ranked first for the bare name, so without this a
   * query for `SQLCompiler.as_sql` headlined `SQLInsertCompiler.as_sql` — and
   * the agent took that as the tool having found the wrong method.
   */
  leadingIds: Iterable<string> = [],
): string {
  const ROOT_CAP = 5; // only the symbols the query actually targeted
  const FILE_CAP = 4; // caller files listed per symbol before "+N more"
  const MEANINGFUL = new Set<string>([
    'function', 'method', 'class', 'interface', 'struct', 'union', 'trait', 'protocol',
    'enum', 'type_alias', 'component', 'constant', 'variable', 'property', 'field',
  ]);
  const rel = (p: string) => p.replace(/\\/g, '/');

  const roots = [...new Set([...leadingIds, ...subgraph.roots])]
    .map((id) => subgraph.nodes.get(id))
    .filter((n): n is Node => !!n && MEANINGFUL.has(n.kind))
    .slice(0, ROOT_CAP);
  if (roots.length === 0) return '';

  const entries: string[] = [];
  for (const root of roots) {
    let callers: Array<{ node: Node }> = [];
    try { callers = cg.getCallers(root.id) as Array<{ node: Node }>; } catch { /* skip this root */ }

    const seen = new Set<string>();
    const uniq: Node[] = [];
    for (const c of callers) {
      if (c?.node && !seen.has(c.node.id)) { seen.add(c.node.id); uniq.push(c.node); }
    }
    if (uniq.length === 0) continue; // no blast radius → nothing to flag

    const callerFiles = [...new Set(uniq.map((n) => rel(n.filePath)))];
    const testFiles = callerFiles.filter((f) => isTestFile(f));
    const nonTest = callerFiles.filter((f) => !isTestFile(f));

    const shown = nonTest.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ');
    const more = nonTest.length > FILE_CAP ? ` +${nonTest.length - FILE_CAP} more` : '';
    const where = nonTest.length > 0 ? ` in ${shown}${more}` : '';
    const tests = testFiles.length > 0
      ? `; tests: ${testFiles.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ')}${testFiles.length > FILE_CAP ? ` +${testFiles.length - FILE_CAP}` : ''}`
      : indirectTestNote(cg, uniq, rel);

    entries.push(
      `- \`${root.name}\` (${rel(root.filePath)}:${root.startLine}) — ${uniq.length} caller${uniq.length === 1 ? '' : 's'}${where}${tests}`,
    );
  }
  if (entries.length === 0) return '';

  return [
    '**Blast radius — what depends on these (update/verify before editing)**',
    '',
    ...entries,
    '',
  ].join('\n');
}

/**
 * Test-coverage note for a blast-radius entry whose DIRECT callers include no
 * test file. A helper called only by production code can still be exercised
 * by tests further up the caller chain (#1475: 40% of directly-unflagged
 * symbols had a test within 2-3 hops), so walk up to 2 more hops before
 * claiming anything — and even then claim only what was measured.
 */
export function indirectTestNote(cg: CodeGraph, directCallers: Node[], rel: (p: string) => string): string {
  const MAX_HOPS = 3; // direct callers are hop 1
  const BUDGET = 64;  // getCallers lookups per entry — bounds god-fan-in symbols
  const FILE_CAP = 2;
  let budget = BUDGET;
  const visited = new Set(directCallers.map((n) => n.id));
  let frontier = directCallers;
  for (let hop = 2; hop <= MAX_HOPS && frontier.length > 0 && budget > 0; hop++) {
    const next: Node[] = [];
    const found = new Set<string>();
    for (const node of frontier) {
      if (budget-- <= 0) break;
      let callers: Array<{ node: Node }> = [];
      try { callers = cg.getCallers(node.id) as Array<{ node: Node }>; } catch { continue; }
      for (const c of callers) {
        const n = c?.node;
        if (!n || visited.has(n.id)) continue;
        visited.add(n.id);
        const f = rel(n.filePath);
        if (isTestFile(f)) found.add(f);
        else next.push(n);
      }
    }
    if (found.size > 0) {
      const files = [...found];
      const shown = files.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ');
      const more = files.length > FILE_CAP ? ` +${files.length - FILE_CAP}` : '';
      return `; tested via callers: ${shown}${more}`;
    }
    frontier = next;
  }
  // Budget exhaustion means hops 2-3 weren't fully searched — fall back to
  // the weaker claim that IS established by the direct-caller check.
  return budget > 0
    ? `; no tests found within ${MAX_HOPS} caller hops`
    : '; no test calls this directly';
}

/**
 * Build the "trail" for a symbol: its direct callees (what it calls) and
 * callers (what calls it), each with file:line — so codegraph_node doubles as
 * the structural Grep→Read→expand primitive: a spot PLUS where to go next.
 * Capped to stay cheap. Walk the graph by calling codegraph_node on a trail
 * entry; no Read needed for covered hops. Empty edges on a non-leaf often mean
 * dynamic dispatch the static graph couldn't resolve — that absence is itself
 * a signal (read that one hop) rather than a dead end.
 */
export function formatTrail(cg: CodeGraph, node: Node): string {
  const TRAIL_CAP = 12;
  const fmt = (e: { node: Node; edge: Edge }) => {
    const base = `${e.node.name} (${e.node.filePath}:${e.node.startLine})`;
    const synth = synthEdgeNote(e.edge);
    return synth ? `${base} [${synth.compact}]` : base;
  };
  const collect = (edges: Array<{ node: Node; edge: Edge }>): Array<{ node: Node; edge: Edge }> => {
    const seen = new Set<string>([node.id]);
    const out: Array<{ node: Node; edge: Edge }> = [];
    for (const e of edges) {
      if (seen.has(e.node.id)) continue;
      seen.add(e.node.id);
      out.push(e);
    }
    return out;
  };
  const callees = collect(cg.getCallees(node.id));
  const callers = collect(cg.getCallers(node.id));
  if (callees.length === 0 && callers.length === 0) return '';
  const lines: string[] = ['', '**Trail — codegraph_node any of these to follow it (no Read needed)**'];
  if (callees.length > 0) {
    lines.push(`**Calls →** ${callees.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callees.length > TRAIL_CAP ? `, +${callees.length - TRAIL_CAP} more` : ''}`);
  }
  if (callers.length > 0) {
    lines.push(`**Called by ←** ${callers.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callers.length > TRAIL_CAP ? `, +${callers.length - TRAIL_CAP} more` : ''}`);
  }
  return lines.join('\n');
}
