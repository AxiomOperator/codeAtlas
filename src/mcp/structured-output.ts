/**
 * Structured (JSON) output for the CLI's `explore --json` and `node --json`
 * (#1280). The MCP tools answer in markdown; these shapes carry the SAME
 * information as plain data so a pipeline can keep or drop each block (e.g.
 * keep the flow and blast radius, drop source bodies) without parsing prose.
 *
 * The handlers build this only when asked (an internal arg the CLI sets via
 * `ToolHandler.execute(..., { structured: true })`), ride it back on the
 * ToolResult under {@link STRUCTURED_RESULT_KEY}, and `execute` strips it for
 * every other caller — it never reaches an MCP client.
 *
 * The shape is versioned by `schemaVersion`: fields may be ADDED in a minor
 * release, never renamed or removed without bumping it. Documented in
 * `site/src/content/docs/reference/cli.md`.
 */

import type { Edge, Node } from '../types';
import type CodeGraph from '../index';
import { resolveNamedSymbolFlow } from '../graph/named-symbol-flow';
import type { BlastRadiusEntry } from './explore-sections';

/** Internal arg key: the handler builds structured output when it is `true`. */
export const STRUCTURED_ARG = '_cgStructured';
/** Internal ToolResult key the structured payload rides back on. */
export const STRUCTURED_RESULT_KEY = '_cgStructured';

export const STRUCTURED_SCHEMA_VERSION = 1;

export interface SymbolJson {
  name: string;
  qualifiedName: string;
  kind: string;
  file: string;
  startLine: number;
  endLine: number;
  signature?: string;
}

export interface FlowStepJson extends SymbolJson {
  /** Edge kind INTO this step from the previous one (null on the first step). */
  via: string | null;
  /** Set when the hop is a synthesized dynamic-dispatch edge. */
  synthesizedBy?: string;
  /** Line in this step where it calls the next one, when known. */
  callLine?: number;
}

export interface BlastRadiusJson {
  symbol: SymbolJson;
  callers: number;
  callerFiles: string[];
  testFiles: string[];
}

export interface ExploreFileJson {
  path: string;
  language: string;
  /** Symbols of this file the answer is about. */
  symbols: SymbolJson[];
  /** Line spans the `source` covers (1-based, inclusive). */
  ranges: Array<{ start: number; end: number }>;
  /**
   * The source exactly as the markdown response renders it: line-numbered
   * (`<n>\t<line>`), with gap markers between non-adjacent spans. Empty when
   * the file's source was already sent earlier in the same MCP session.
   */
  source: string;
}

export interface ExploreJson {
  schemaVersion: number;
  command: 'explore';
  query: string;
  projectRoot: string;
  /** The "Found N symbols across M files." line. */
  summary: string;
  /** Warnings that the markdown output prints above the answer. */
  notices: string[];
  /** Symbols the query named that resolved in the index. */
  namedSymbols: SymbolJson[];
  /** The call path among the named symbols (empty when none connects). */
  flow: FlowStepJson[];
  /** The flow section's markdown narrative (dynamic-dispatch links, boundaries); '' when none. */
  flowText: string;
  blastRadius: BlastRadiusJson[];
  /** Files whose source the answer includes, in rank order. */
  files: ExploreFileJson[];
  /** Relevant files that did not fit, in rank order. */
  omittedFiles: Array<{ path: string; symbols: string[] }>;
  /** The character cap this answer was built against, and its actual size as markdown. */
  budget: { maxChars: number; outputChars: number } | null;
  /** Guidance text when there is no answer to structure (nothing matched, …). */
  message?: string;
}

export interface NodeSymbolJson extends SymbolJson {
  /** Full body (leaf symbols), or a member outline (containers); null without code. */
  source: string | null;
  sourceKind: 'body' | 'outline' | 'none' | 'omitted-stale';
  callers: SymbolJson[];
  callees: SymbolJson[];
}

export interface NodeJson {
  schemaVersion: number;
  command: 'node';
  notices: string[];
  mode: 'symbol' | 'file' | 'not-found';
  /** Symbol mode: every definition the name resolved to (overloads included). */
  symbols?: NodeSymbolJson[];
  /** Symbol mode: definitions that matched but were listed without a body. */
  otherDefinitions?: SymbolJson[];
  /** File mode. */
  file?: {
    path: string;
    language: string;
    totalLines: number | null;
    dependents: string[];
    symbols: SymbolJson[];
    /** First / last line in `source` (1-based); null when no source is returned. */
    startLine: number | null;
    endLine: number | null;
    /** Raw (un-numbered) source lines startLine..endLine; null when withheld. */
    source: string | null;
  };
  /** Human guidance for not-found / ambiguous / withheld cases. */
  message?: string;
  suggestions?: string[];
}

export type StructuredOutput = ExploreJson | NodeJson;

/**
 * The JSON to print for a result that carries no structured payload — a
 * success-shaped guidance answer (nothing matched, not indexed, bad argument).
 * Same top-level shape as a real answer, empty, with the guidance in `message`.
 */
export function structuredFallback(
  command: 'explore' | 'node',
  text: string,
  query = '',
): StructuredOutput {
  if (command === 'node') {
    return { schemaVersion: STRUCTURED_SCHEMA_VERSION, command, notices: [], mode: 'not-found', message: text };
  }
  return {
    schemaVersion: STRUCTURED_SCHEMA_VERSION,
    command,
    query,
    projectRoot: '',
    summary: '',
    notices: [],
    namedSymbols: [],
    flow: [],
    flowText: '',
    blastRadius: [],
    files: [],
    omittedFiles: [],
    budget: null,
    message: text,
  };
}

export function symbolJson(n: Node, withSignature = false): SymbolJson {
  const out: SymbolJson = {
    name: n.name,
    qualifiedName: n.qualifiedName || n.name,
    kind: n.kind,
    file: n.filePath.replace(/\\/g, '/'),
    startLine: n.startLine,
    endLine: n.endLine ?? n.startLine,
  };
  if (withSignature && n.signature) out.signature = n.signature;
  return out;
}

function synthesizedBy(edge: Edge | null): string | undefined {
  if (!edge || edge.provenance !== 'heuristic') return undefined;
  const m = edge.metadata as Record<string, unknown> | undefined;
  return typeof m?.synthesizedBy === 'string' ? m.synthesizedBy : 'heuristic';
}

/**
 * The flow among the query's named symbols as data: the same path finder the
 * markdown Flow section is drawn from (`resolveNamedSymbolFlow`), top chain.
 */
export function flowJson(cg: CodeGraph, query: string): { steps: FlowStepJson[]; named: SymbolJson[] } {
  try {
    const flow = resolveNamedSymbolFlow(cg, query);
    const named = [...flow.named.values(), ...flow.dynNamed.values()].map((n) => symbolJson(n));
    const chain = flow.chains[0];
    if (!chain || chain.steps.length < 2) return { steps: [], named };
    const steps = chain.steps.map((s): FlowStepJson => {
      const step: FlowStepJson = { ...symbolJson(s.node), via: s.edge ? s.edge.kind : null };
      const synth = synthesizedBy(s.edge);
      if (synth) step.synthesizedBy = synth;
      const callLine = chain.callSites.get(s.node.id);
      if (callLine !== undefined) step.callLine = callLine;
      return step;
    });
    return { steps, named };
  } catch {
    return { steps: [], named: [] };
  }
}

export function blastRadiusJson(entries: BlastRadiusEntry[]): BlastRadiusJson[] {
  return entries.map((e) => ({
    symbol: symbolJson(e.root),
    callers: e.callers.length,
    callerFiles: e.callerFiles,
    testFiles: e.testFiles,
  }));
}
