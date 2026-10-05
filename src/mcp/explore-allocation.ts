/**
 * `codegraph_explore` relevance scoring weights and score-proportional byte
 * allocation across files. Moved out of `tools.ts` unchanged; re-exported from there.
 */

import type { ExploreOutputBudget } from './explore-budget';
import type { Edge } from '../types';

// ── Explore relevance scoring (CG-10 / #1500) ──────────────────────────────
//
// A file earns its slice of the explore envelope from the symbols in it that the
// query matched. Before this weighting every match counted the same per tier, so
// a file that merely declares a local `const explore` scored what a file that
// DEFINES the explore pipeline scored — which is how three
// `scripts/agent-eval/*.mjs` harnesses took 63% of this repo's own "how does
// explore allocate its output budget across files" response on nothing but a
// local `explore` and a `BUDGET` constant. Four levers — the first three are
// multiplicative, so they compose without ordering surprises; the fourth decides
// admission from the result:
//
//   1. KIND      — what a match on this NodeKind actually tells you (below).
//   2. ISOLATION — a weak-kind symbol nothing calls or references is a pure name
//                  collision; participation in the graph is the corroboration.
//   3. PENALTY   — generated / test / i18n files are weaker answers to an
//                  architecture question at EVERY signal, not just as the
//                  tiebreak-at-equal-score they used to be.
//   4. FLOOR     — admission scales with the best file's score, replacing an
//                  absolute bar that admitted noise wherever the top score was
//                  high.

/**
 * How strongly a match on a symbol of this kind corroborates that its FILE is
 * what the query is about.
 *
 *   1.0   a callable or a type — the unit an architecture question is about
 *   ~0.5  a member of a type, or the file node itself (a path match, not a
 *         symbol match)
 *   ~0.3  a variable / constant — as often a name collision as a definition
 *   0.15  a parameter — essentially never the subject of a question
 *
 * Unlisted kinds fall back to `DEFAULT_RELEVANCE_KIND_WEIGHT`, so a NodeKind
 * added later is neither free nor fatal.
 */
export const RELEVANCE_KIND_WEIGHT: Readonly<Record<string, number>> = {
  // Callables and types: the answer lives in one of these.
  function: 1, method: 1, class: 1, struct: 1, union: 1, interface: 1, trait: 1,
  protocol: 1, component: 1, route: 1, enum: 1, type_alias: 1, constructor: 1,
  // Containers: real structure, but a whole namespace/module matching a term is
  // a coarser signal than a callable matching it.
  namespace: 0.8, module: 0.8,
  // Members of a type: real, weaker on their own.
  property: 0.5, field: 0.5, enum_member: 0.35,
  // The file node itself — the path matched, no symbol did.
  file: 0.5,
  // Incidental until the graph corroborates them (see ISOLATED_ below).
  constant: 0.35, variable: 0.3, parameter: 0.15,
};
export const DEFAULT_RELEVANCE_KIND_WEIGHT = 0.5;

/**
 * The "member of a type" tier of the table above, named so the one kind that
 * cannot be read off `node.kind` can be placed on it: an interface's
 * `method_signature` (#1638). Same value as `property`/`field`, deliberately —
 * it is the same tier, not a new one.
 */
export const TYPE_MEMBER_RELEVANCE_WEIGHT = 0.5;

/**
 * Kinds whose evidentiary value depends on whether anything USES them. An
 * exported `const DEFAULTS` that half the codebase references is a real
 * definition; a `const explore` living inside one function of an eval script is
 * a name collision. Only these kinds pay for the isolation probe.
 */
export const WEAK_RELEVANCE_KINDS: ReadonlySet<string> = new Set([
  'constant', 'variable', 'parameter', 'field', 'property', 'enum_member',
]);

/** Weight for a weak-kind symbol with no incoming/outgoing usage edge at all. */
export const ISOLATED_WEAK_KIND_WEIGHT = 0.08;

/**
 * Edges that mean "this symbol is used". `contains` is lexical nesting, not
 * usage — counting it would make every file-scope constant look corroborated,
 * which is exactly the case this guards against.
 */
export const RELEVANCE_USAGE_EDGES: ReadonlySet<string> = new Set([
  'calls', 'references', 'extends', 'implements', 'overrides',
  'instantiates', 'returns', 'type_of', 'decorates', 'navigates',
]);

/**
 * Cap on what PERIPHERAL nodes (in the subgraph, but neither a query match nor
 * adjacent to one) can contribute to a file's score. Uncapped, each such node
 * added a flat +1, so a file grew more "relevant" simply by being bigger —
 * `parse-session.mjs` reached score 22 off ONE incidental constant plus twelve
 * unrelated symbols. Size is not evidence; cap its contribution.
 */
export const PERIPHERAL_SCORE_CAP = 5;

/**
 * Rank penalties, applied to BOTH the relevance score and the graph mass.
 *
 * Generated source used to be a tiebreak at equal score only, so a generated
 * file that outscored the hand-written one still won — the #1500 report exactly:
 * the FKIT CRUD layer carries every query term AND more graph mass than the
 * use-case that implements the business rule. A multiplier demotes it on the
 * PRIMARY sort key instead, without ever hard-excluding it (ask about the
 * generated API by name and the named-seed tier still puts it first). It is
 * self-normalizing: in an all-generated repo everything scales together and
 * relative ranking is untouched.
 */
export const GENERATED_RANK_PENALTY = 0.3;
/**
 * Test/spec/icon/i18n files. These are normally hard-excluded outright, but that
 * filter stands down when fewer than 2 non-low-value candidates remain (else
 * tests would be the only signal for the area). This is the softened form for
 * that case: down-weighted rather than removed.
 */
export const LOW_VALUE_RANK_PENALTY = 0.5;
/**
 * Ambient declaration files — a hand-written `.d.ts` of global shims, vendored
 * typings, module augmentation (CG-28). Declares nothing but types, and nothing
 * in the index depends on it.
 *
 * Such a file cannot answer a FLOW question no matter how much its identifiers
 * overlap the query: no bodies, no call edges, no behaviour, and nothing typed
 * by it. Its ceiling of usefulness is a type signature, and one follow-up
 * explore fetches that. But the identifiers it declares are exactly the generic
 * ones a prose question uses (`Body`, `Message`, `ImageMetadata`,
 * `ReadableStream`), so on term overlap it out-scores the implementation and
 * takes the envelope — measured at rank #1 and 51% of delivered source, with
 * the flow's own entry file getting none.
 *
 * Softer than {@link GENERATED_RANK_PENALTY} on purpose: "generated" is a claim
 * about provenance the file itself makes, while this is an inference about what
 * a file can be USEFUL for. A demoted declaration file that is still the best
 * candidate should keep its place; the penalty only has to stop it beating real
 * implementation. It does NOT stack with the generated penalty (see rankPenalty)
 * — penalising twice for the same property is how a file gets cliffed out of
 * answers where it is genuinely relevant.
 */
export const AMBIENT_DECLARATION_RANK_PENALTY = 0.5;
/**
 * The type-level NodeKinds. Must stay in step with the kind list in
 * `QueryBuilder.getAmbientDeclarationPathsAmong` — that query decides which
 * files are ambient declarations, this set decides which symbols in them the
 * agent can name to lift the penalty back off.
 */
export const DECLARATION_KINDS = new Set(['interface', 'type_alias', 'enum', 'enum_member', 'namespace']);

/**
 * Score floor: `clamp(topScore * FRACTION, ABSOLUTE, MAX)`.
 *
 * An absolute floor alone (`>= 3`) admits noise on any repo where the top file
 * scores 50+, so the bar is now a FRACTION of the best file's score and scales
 * with how strong the best match is. On a diffuse survey question no file
 * dominates, every candidate sits near the top score, and the whole spread gets
 * through; on a precise question it cuts the long tail of incidental matches.
 *
 * ABSOLUTE is recalibrated for kind-weighted scores: the old `>= 3` assumed an
 * unweighted tier sum where any query match was worth 10. A file whose sole
 * match is an unused local constant now scores 0.8, so 3 had quietly become a
 * much harsher admission bar than it was written to be — and the relative floor
 * is what this change means to prune with anyway.
 */
export const SCORE_FLOOR_ABSOLUTE = 1;
export const SCORE_FLOOR_FRACTION_OF_TOP = 0.2;
/**
 * Ceiling on the relative floor, in units of one direct query match on a
 * callable (the `entryNodeIds` tier, weight 1.0). A single full-strength match
 * is never incidental, so no amount of concentration elsewhere may exclude it:
 * one named-seed-heavy file (`+50` per seed) otherwise pushed the floor to 21
 * and dropped `BridgeInterceptor`'s file, which the agent had named — a class,
 * so it entered at the +10 tier rather than +50. The #1500 noise this change
 * targets scores 0.8–6, well under this ceiling.
 */
export const SCORE_FLOOR_MAX = 10;
/**
 * The relative floor must never starve a question of candidates: if it would
 * leave fewer than this, backfill with the best-scoring ones it cut. The cost of
 * under-serving is the agent calling explore again — a whole round-trip. See the
 * backfill itself for the two strengths it runs at (thin vs. empty).
 */
export const SCORE_FLOOR_KEEP_MIN = 3;

// ── Score-proportional byte allocation (CG-12 / #1500) ─────────────────────
//
// The score floor above decides WHICH files reach the response. This decides how
// the byte envelope is SPLIT among them — and until this existed, it wasn't
// really decided at all: every admitted file was capped at the same
// `maxCharsPerFile`, and the whole-file rule handed anything under
// `maxCharsPerFile * 3` its entire contents. So allocation followed FILE SIZE,
// not relevance. On this repo's own "how does explore allocate its output budget
// across files", `src/mcp/tools.ts` (score 41, 4x the graph mass, 3x the distinct
// term hits — it literally holds the allocator) was clipped at 3,800 while a
// score-18 file shipped whole at 5,672 and took 51% of the envelope, purely for
// being small. On the #1500 Go fixture, two generated CRUD files shipped whole at
// ~4.5K each and consumed the tier's 4 file slots, so `BuildPayslip` — the
// hand-written half of "create and calculate payslips" — never appeared at all.
//
// The replacement: reserve each file a share of the envelope proportional to what
// it is worth, up front, before anything renders. Three consequences:
//
//   1. A reservation is a GUARANTEE, not a race. The old loop spent the envelope
//      first-come-first-served in rank order, so the top two files could exhaust
//      it and every later file hit a `budget-90pct` skip regardless of merit.
//   2. A file below the cliff gets ZERO source — its path, symbols and line
//      numbers only. It costs ~100 chars instead of ~4,500, and (crucially) it
//      does not consume a `maxFiles` slot, so the slot goes to a file that earns
//      its bytes. This is the concentration lever.
//   3. The per-file cap stops being the primary guard. It survives only as
//      `ALLOC_MAX_SHARE`, a safety valve against a single god-file — which the
//      proportional split already bounds, since a file's share can't exceed its
//      weight share.
export const EXPLORE_ALLOCATION = {
  /**
   * A file whose weight is under this fraction of the top file's gets no source.
   *
   * Calibrated between the two shapes the fixtures pin: the #1500 generated CRUD
   * lands at 10–11% of the top weight (penalised twice — once into the score by
   * `rankPenalty`, once again here) and must cliff; a genuinely peripheral but
   * hand-written flow file — `payslip_builder.go`, the direct callee of the
   * workflow entry — lands at 25% and must NOT. Everything in between is a
   * judgement call the agent can undo for ~0 cost, because a cliffed file is
   * still NAMED in the response and one follow-up explore fetches it.
   */
  CLIFF_FRACTION: 0.15,
  /**
   * Ceiling on the cliff, in the same units as `SCORE_FLOOR_MAX` — and for the
   * same reason. A file whose weight clears a full-strength direct match is never
   * incidental, so no amount of concentration elsewhere may zero it: one
   * overwhelming top file (a 99-scoring god-file among score-10 peers) otherwise
   * puts the cliff at 14.9 and silences every peer the score floor had just
   * deliberately admitted. The cliff is a RELATIVE prune of weak evidence, not a
   * second admission gate — the score floor already owns admission.
   */
  CLIFF_MAX: SCORE_FLOOR_MAX,
  /**
   * Floor on a useful reservation — every admitted file gets this much before
   * the proportional split divides the rest. Under it a slice can't hold one
   * complete method, and a fragment is strictly worse than a pointer: it forces
   * the Read this tool exists to prevent.
   *
   * It is a FLOOR, not a second cliff. Cliffing the starved file instead
   * cascades: removing the smallest raises everyone else's share by so little
   * that the next-smallest starves too, and a query with two dominant files ate
   * six legitimately-ranked peers one at a time. Concentration is the relative
   * cliff's job; this only keeps a served file's slice usable.
   */
  MIN_CHARS: 700,
  /**
   * Safety valve, as a fraction of the envelope. Not the primary guard any more —
   * the proportional split is — so this only has to stop a pathological
   * single-file response.
   *
   * It does not apply to a file the query NAMED — one that defines a symbol the
   * query spelled, or that the query named by path. The valve hedges against a
   * mis-ranked dominant file, and a file the agent asked for by name is not
   * one. It also never redistributed: a clamped file's excess was simply left
   * unreserved, and the carry-forward only moves reservations, so nobody could
   * spend it. On express, "response.js res.send res.json res.render …" admits
   * one file, clamps it at 9,100 with 3,700 of the pool unreserved, and cuts
   * the named `send` body at 55 of 97 lines in a 10.9K response to a 13K budget.
   */
  MAX_SHARE: 0.7,
  /**
   * Markdown overhead charged per rendered file (header + fences + blank lines),
   * matching the render loop's own `+ 200` accounting. Held out of the pool
   * before the split so the reservations plus their overhead fit the envelope —
   * without this the last file's reservation is always the one that doesn't fit.
   */
  FILE_OVERHEAD: 200,
  /**
   * Flow-spine files are weighted up and are exempt from the cliff. Clipping the
   * spine causes the Read fallback (it IS the answer to a flow question);
   * clipping a peripheral file does not. This makes the existing advisory spine
   * handling — `hasSpine`, `SPINE_CEILING` — strict at the allocation layer.
   */
  SPINE_WEIGHT_BOOST: 2,
  /**
   * Slack allowed on the whole-file rule: a file a little over its reservation
   * still ships WHOLE rather than as clusters, because slicing off that last
   * sliver saves ~1% of the envelope and costs a Read — the trade the whole-file
   * rule exists to refuse. Proportional (with an absolute ceiling) because a
   * "sliver" is relative: a flat 800 is 15% of a 5K reservation but 31% of a 2.5K
   * one, and at the small end that overshoot is exactly what the file below then
   * loses.
   */
  WHOLE_FILE_GRACE_FRACTION: 0.15,
  WHOLE_FILE_GRACE_MAX: 800,
  /**
   * A reservation that already covers this fraction of a file BUYS THE WHOLE
   * FILE (CG-21), even though the file is bigger than the reservation.
   *
   * The grace above is calibrated as a *sliver* — it only rescues a file that
   * essentially fits. Below it there is a hole the render loop cannot fill:
   * express's `lib/utils.js` (5,293 B) was the TOP-ranked file, reserved 3,870,
   * declined the whole-file render at a 4,450 grace bound, and then spent 583 on
   * a three-symbol cluster render. The other 3,287 chars of its reservation were
   * neither redistributed nor delivered — the envelope shrank by a third against
   * an unchanged budget and the agent Read the file back four times.
   *
   * So the rule is not "does the file fit the reservation" but "has the
   * reservation already bought most of the file": at 0.6 the loop pays at most
   * two-thirds of a reservation extra to avoid losing the whole thing, and it
   * spends bytes it was going to spend anyway on a file that already earned
   * them. Below the fraction the shortfall is real — the file is several times
   * its reservation, clustering is the right answer, and the carry-forward
   * (`reservedSoFar`/`sourceSpent` in the render loop) hands whatever it cannot
   * spend to the next file down.
   */
  WHOLE_FILE_BUY_FRACTION: 0.6,
  /**
   * The buy rule's overshoot is funded from ONE pool for the whole response,
   * sized as this fraction of the envelope — deliberately the same 15% as
   * `WHOLE_FILE_GRACE_FRACTION`, one level up: the grace is a sliver of a
   * FILE's reservation, this is a sliver of the RESPONSE's envelope.
   *
   * Per-file funding is the version that fails, and it fails the same way the
   * bug being fixed does. The merit test is a RATIO, so wherever several files
   * sit near it they all qualify, and N independent overshoots inflate the
   * response until the render ceiling drops whatever is last. Measured on the
   * #1500 payroll fixture: three files bought whole and `payslip_builder.go` —
   * the file that computes the payslip the question asks about, rank #6 — was
   * dropped entirely so three higher-ranked files could each ship their final
   * sliver. A dropped section is strictly worse than a clustered one, so one
   * shared pool, spent in rank order, is the bound that matters.
   */
  WHOLE_FILE_BUY_OVERSHOOT_FRACTION: 0.15,
} as const;

/** One candidate file's allocation inputs, in final rank order. */
export interface ExploreAllocationCandidate {
  path: string;
  /** Post-`rankPenalty` relevance score from the ranking pass. */
  score: number;
  /**
   * How much this file's BYTES are worth, independent of how well it matched.
   * Ranking answers "is this file about the query"; allocation answers "will
   * these bytes teach the agent anything". Generated CRUD can legitimately rank
   * (it name-collides on every domain word) while its bytes stay mechanical
   * boilerplate the agent gains nothing from reading — so `rankPenalty` is
   * applied a SECOND time here. That is what finally sinks the #1500 generated
   * layer below the cliff: it survived CG-10's single penalty because the sort's
   * leading keys (entry-point, graph mass) are structural, and a big densely
   * self-referential generated file scores well on both.
   */
  worth: number;
  /**
   * Carries a symbol on the rendered flow spine — or an exact target (a
   * qualified name, a line anchor), which is the answer by the same argument.
   */
  spine: boolean;
  /**
   * The query named this file by PATH (see query-paths.ts). Pinned files are
   * never cliffed or trimmed, and weigh at least as much as the strongest
   * candidate — the agent asked for the file itself, so starving it on text/
   * graph scores (which a pure-path query doesn't produce) defeats the ask.
   */
  pinned?: boolean;
  /**
   * The query named a symbol this file defines (the named-first sort tier). Like
   * a pinned file, it is exempt from the `MAX_SHARE` valve: its proportional
   * share stands, bounded only by the pool.
   */
  named?: boolean;
}

export interface ExploreAllocation {
  /** path → chars of source it may render. Only holds admitted files. */
  allowances: Map<string, number>;
  /** Files the cliff zeroed, in rank order — pointers, not bytes. */
  cliffed: string[];
  /** The weight threshold the cliff fired at (0 when nothing was cliffed). */
  cliffAt: number;
  /** Chars actually split among the admitted files. */
  pool: number;
}

/** A file the query asked for by name — a symbol it defines, or its path. */
export function isNamedCandidate(c: Pick<ExploreAllocationCandidate, 'named' | 'pinned'>): boolean {
  return c.named === true || c.pinned === true;
}

/**
 * Split `budget.maxOutputChars` across ranked candidates in proportion to
 * relevance, with a hard relative cliff.
 *
 * `candidates` must arrive in FINAL RANK ORDER — `maxFiles` is applied to the
 * survivors of the cliff, in that order, so cliffing genuinely hands a slot to
 * the next file down rather than leaving it unused.
 *
 * Tier invariant (`getExploreOutputBudget`): a larger tier must never allow less
 * per file than a smaller one. It holds here by construction — every bound is a
 * fraction of `maxOutputChars` or of `maxCharsPerFile`, both monotonic across
 * tiers — except `MIN_CHARS`, which is an absolute floor and so identical at
 * every tier.
 */
export function allocateExploreBudget(
  candidates: readonly ExploreAllocationCandidate[],
  budget: ExploreOutputBudget,
  maxFiles: number,
): ExploreAllocation {
  const A = EXPLORE_ALLOCATION;
  const empty: ExploreAllocation = { allowances: new Map(), cliffed: [], cliffAt: 0, pool: 0 };
  if (candidates.length === 0) return empty;

  // A non-finite weight is treated as no evidence rather than propagated: an
  // Infinity score would otherwise make every share `Infinity/Infinity` = NaN and
  // hand the render loop a NaN allowance. Scores are finite sums in the real
  // pipeline, so this only has to fail safe.
  const weightOf = (c: ExploreAllocationCandidate) => {
    const w = Math.max(0, c.score) * Math.max(0, Math.min(1, c.worth)) * (c.spine ? A.SPINE_WEIGHT_BOOST : 1);
    return Number.isFinite(w) ? w : 0;
  };

  // Pinned files weigh at least as much as the strongest raw candidate: their
  // score is whatever the stripped query happened to match (for a pure-path
  // query, nearly nothing), and a proportional split on that would fund the
  // named file worst of all. Floor of 1 covers the all-pinned/zero-score case.
  const rawWeights = new Map(candidates.map((c) => [c.path, weightOf(c)]));
  const topRaw = Math.max(...rawWeights.values());
  const weights = new Map(candidates.map((c) => [
    c.path,
    c.pinned ? Math.max(rawWeights.get(c.path) ?? 0, topRaw, 1) : (rawWeights.get(c.path) ?? 0),
  ]));
  const topWeight = Math.max(...weights.values());
  if (!(topWeight > 0)) return empty;

  // Cliff over the WHOLE candidate list, before `maxFiles` — otherwise the file
  // cap fills with cliff-bound files and the slot they free is never handed on.
  const cliffAt = Math.min(topWeight * A.CLIFF_FRACTION, A.CLIFF_MAX);
  const cliffed: string[] = [];
  let admitted: ExploreAllocationCandidate[] = [];
  for (const c of candidates) {
    if (!c.spine && !c.pinned && (weights.get(c.path) ?? 0) < cliffAt) cliffed.push(c.path);
    else admitted.push(c);
  }
  // Never cliff every candidate: an empty response costs a whole round-trip.
  if (admitted.length === 0) {
    admitted = [candidates[0]!];
    cliffed.splice(cliffed.indexOf(candidates[0]!.path), 1);
  }
  for (const c of admitted.slice(maxFiles)) cliffed.push(c.path);
  admitted = admitted.slice(0, maxFiles);

  // Serve fewer files well rather than many badly: the envelope has to afford
  // MIN_CHARS for everything admitted. When it can't, cliff the lowest-weight
  // files (never a spine file, never the last one) in one deterministic trim —
  // not one at a time, which is how the old starvation rule snowballed.
  const affordable = Math.max(1, Math.floor(budget.maxOutputChars / (A.MIN_CHARS + A.FILE_OVERHEAD)));
  if (admitted.length > affordable) {
    const byWeight = [...admitted].sort((a, b) => (weights.get(b.path) ?? 0) - (weights.get(a.path) ?? 0));
    const keep = new Set(byWeight.slice(0, affordable).map((c) => c.path));
    for (const c of admitted) if (c.spine || c.pinned) keep.add(c.path);
    for (const c of admitted) if (!keep.has(c.path)) cliffed.push(c.path);
    admitted = admitted.filter((c) => keep.has(c.path));
  }

  const allowances = new Map<string, number>();
  const pool = Math.max(0, budget.maxOutputChars - A.FILE_OVERHEAD * admitted.length);
  const total = admitted.reduce((s, c) => s + (weights.get(c.path) ?? 0), 0);
  if (total <= 0 || admitted.length === 0) return { allowances, cliffed, cliffAt, pool };
  // Everyone gets MIN_CHARS; the REMAINDER is what splits by weight. The floor
  // is what keeps a diffuse survey question returning a useful spread, and the
  // remainder is what concentrates a precise one — the top file's slice grows
  // with its weight share, uncapped by any flat per-file limit.
  const ceiling = Math.round(budget.maxOutputChars * A.MAX_SHARE);
  const floors = Math.min(pool, A.MIN_CHARS * admitted.length);
  const remainder = Math.max(0, pool - floors);
  // Both parts FLOOR: a sum of rounded shares can exceed the remainder that fed
  // it (by up to half a char per file), and the reservations must fit the pool
  // exactly — the render loop spends them, so an over-allocation is an over-long
  // response the hard ceiling then has to truncate. Flooring costs at most one
  // char per file.
  // The valve spares a file the query named (see MAX_SHARE): its share is already
  // a slice of `pool`, so the reservations still fit the pool exactly.
  for (const c of admitted) {
    const share = Math.floor(floors / admitted.length)
      + Math.floor((remainder * (weights.get(c.path) ?? 0)) / total);
    allowances.set(c.path, isNamedCandidate(c) ? share : Math.min(share, ceiling));
  }
  return { allowances, cliffed, cliffAt, pool };
}

/**
 * Graph-connectivity relevance via Random-Walk-with-Restart (personalized
 * PageRank) from the query's matched SEED nodes over the call/reference graph.
 *
 * This is the ranking signal text search (FTS/bm25) CANNOT provide, and it's
 * codegraph's home turf: relevance by STRUCTURE, not words. A file whose
 * symbols are call-connected to the matched cluster accrues walk mass and
 * ranks high; a lone TEXT match — e.g. `LensSwitcher.swift` matched the word
 * "switch" from `switchOrganization`, but calls none of `setUser`/`fetchUser`
 * — gets only its own restart probability and ranks ~0. Immune to the
 * tokenization trap that fools term matching, deterministic, no embeddings.
 *
 * Undirected adjacency (reachability both ways), restart α=0.25 to the seeds,
 * power iteration to convergence. Bounded to the already-relevant subgraph, so
 * it's a few hundred nodes × ~25 iterations — negligible cost.
 */
export function computeGraphRelevance(
  nodeIds: string[],
  edges: Edge[],
  seedIds: Set<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  const n = nodeIds.length;
  if (n === 0) return out;
  const idx = new Map<string, number>();
  for (let i = 0; i < n; i++) idx.set(nodeIds[i]!, i);

  const RANK_EDGES = new Set<string>([
    'calls', 'references', 'extends', 'implements', 'overrides',
    'instantiates', 'returns', 'type_of', 'imports', 'navigates',
  ]);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    if (!RANK_EDGES.has(e.kind)) continue;
    const i = idx.get(e.source);
    const j = idx.get(e.target);
    if (i === undefined || j === undefined || i === j) continue;
    adj[i]!.push(j);
    adj[j]!.push(i); // undirected — reachable either direction
  }

  // Restart vector: uniform over seeds present in the candidate set. (Falls
  // back to uniform-over-all if no seed landed in the set, so we never return
  // all-zero.)
  const r = new Array<number>(n).fill(0);
  let rsum = 0;
  for (const id of seedIds) {
    const i = idx.get(id);
    if (i !== undefined) { r[i] = 1; rsum += 1; }
  }
  if (rsum === 0) { for (let i = 0; i < n; i++) r[i] = 1; rsum = n; }
  for (let i = 0; i < n; i++) r[i]! /= rsum;

  const alpha = 0.25;
  let s = r.slice();
  for (let iter = 0; iter < 25; iter++) {
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const si = s[i]!;
      if (si === 0) continue;
      const d = adj[i]!.length;
      if (d === 0) { next[i]! += si; continue; } // dangling: keep its mass
      const share = si / d;
      for (const j of adj[i]!) next[j]! += share;
    }
    for (let i = 0; i < n; i++) s[i] = (1 - alpha) * next[i]! + alpha * r[i]!;
  }
  for (let i = 0; i < n; i++) out.set(nodeIds[i]!, s[i]!);
  return out;
}
