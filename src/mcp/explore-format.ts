/**
 * `codegraph_explore` rendering helpers: line numbering, file-section headers,
 * gap markers, and the completeness/pointer epilogue. Moved out of `tools.ts` unchanged.
 */

import type { Node } from '../types';
import { mergeRanges } from './explore-dedup';
import type { ExploreLineRange } from './explore-session-state';

/**
 * Whether `codegraph_explore` should prefix source lines with their line
 * numbers (cat -n style: `<num>\t<code>`).
 *
 * Line numbers let the agent cite `file:line` straight from the explore
 * payload instead of re-Reading the file just to find a line number — the
 * dominant residual cost on precise-tracing questions (#185 follow-up).
 *
 * Defaults ON. Set `CODEGRAPH_EXPLORE_LINENUMS=0` to disable (used by the
 * A/B harness to measure the payload-cost vs. read-savings tradeoff).
 */
export function exploreLineNumbersEnabled(): boolean {
  return process.env.CODEGRAPH_EXPLORE_LINENUMS !== '0';
}

/**
 * Adaptive explore sizing (default ON). `codegraph_explore` skeletonizes OFF-SPINE
 * polymorphic-sibling files — a file whose class is one of ≥3 interchangeable
 * implementations of a shared interface (e.g. OkHttp's `: Interceptor` classes) —
 * to class + member signatures (bodies elided), keeping the on-spine exemplar full.
 * This sizes the response to the answer instead of the budget cap on sibling-heavy
 * flows (OkHttp interceptor-chain explore 28.5k→16.6k, ~28% cheaper than native
 * search, reads flat). It is PROVABLY INERT elsewhere: distinct pipeline steps (no
 * ≥3-implementer supertype, e.g. Excalidraw's `renderStaticScene`) and on-spine
 * files keep full source — output is byte-identical to shipped on excalidraw /
 * tokio / django / vscode / gin. Set `CODEGRAPH_ADAPTIVE_EXPLORE=0` to disable.
 */
export function adaptiveExploreEnabled(): boolean {
  return process.env.CODEGRAPH_ADAPTIVE_EXPLORE !== '0' && process.env.CODEGRAPH_ADAPTIVE_EXPLORE !== 'false';
}


/**
 * Prefix each line of a source slice with its 1-based line number, matching
 * the Read tool's `cat -n` convention (number + tab) so the agent treats it
 * the same way it treats Read output.
 *
 * @param slice  contiguous source text (already extracted from the file)
 * @param firstLineNumber  the 1-based line number of the slice's first line
 */
export function numberSourceLines(slice: string, firstLineNumber: number): string {
  const out: string[] = [];
  const split = slice.split('\n');
  for (let i = 0; i < split.length; i++) {
    out.push(`${firstLineNumber + i}\t${split[i]}`);
  }
  return out.join('\n');
}

/**
 * Unique line-prefix for a per-file source section in codegraph_explore output.
 * Issue #778: tool results dropped ATX headings (`####`, `##`, `###`) for bold
 * labels so Markdown-rendering MCP clients (e.g. the Claude Code VSCode
 * extension) stop blowing every header up to H1–H4. The path is bold + a code
 * span so it still reads as a header, and the leading ``**` `` stays a UNIQUE,
 * greppable marker — no other explore line begins with it — that the explore
 * truncation boundary (`handleExplore`) keys off to cut on whole file sections.
 */
export const FILE_SECTION_PREFIX = '**`';
// Placeholder for codegraph_explore's "Found N symbols across M files." line.
// The honest N/M can only be known after the final truncation drops trailing
// sections (#1046), so the header is emitted as this sentinel and substituted
// at the very end. This bracketed token never occurs in rendered source or a
// file path, so the final string-replace can't collide.
export const SUMMARY_SENTINEL = '[[codegraph-explore-summary]]';
export function fileSectionHeader(filePath: string, suffix: string): string {
  return suffix
    ? `${FILE_SECTION_PREFIX}${filePath}\`** — ${suffix}`
    : `${FILE_SECTION_PREFIX}${filePath}\`**`;
}

/** Header of `codegraph_explore`'s trailing pointer list. */
export const POINTER_HEADER = '**Not shown above — explore these names for their source**';
/** Most files the pointer list ever names one-per-line; the rest are a count. */
export const POINTER_MAX_FILES = 10;
/**
 * How many elided-in-file symbols a gap marker or biased header names (#1711).
 * Kept small: the names exist so a follow-up explore has a target, not so the
 * meta-text rivals the source it is pointing at.
 */
export const ELIDED_SYMBOL_CAP = 6;

/**
 * Kinds a single-line anchor (`compiler.py:776`) resolves to: the innermost
 * one containing the line is the symbol the agent is pointing at. A class
 * enclosing the line is deliberately NOT a target — it spans most of its file,
 * and "the whole class" is not what a line number asks for.
 */
export const ANCHOR_CALLABLE_KINDS = new Set(['method', 'function', 'constructor', 'component']);
/** Lines either side of a single-line anchor that no callable encloses. */
export const ANCHOR_LINE_CONTEXT = 15;

/**
 * Most windows one oversize exact / named-spine body is cut into in the
 * focused view: the head plus the call sites into the other symbols the
 * question named. More turns a method into confetti.
 */
export const MAX_BODY_FOCUS_LINES = 6;

export type ElidedSymbolRef = { name: string; kind: string; startLine: number };

/**
 * Indexed symbols whose definition starts strictly between two rendered
 * spans. The hole is what a trim dropped; naming them is what lets the agent
 * follow up by name instead of guessing (#1711).
 */
export function symbolsBetweenRanges(
  nodes: ReadonlyArray<{ name: string; kind: string; startLine: number; endLine: number }>,
  fromEnd: number,
  toStart: number,
): ElidedSymbolRef[] {
  if (toStart <= fromEnd + 1) return [];
  const out: ElidedSymbolRef[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (n.kind === 'import' || n.kind === 'export') continue;
    if (n.startLine <= fromEnd || n.startLine >= toStart) continue;
    if (seen.has(n.name)) continue;
    seen.add(n.name);
    out.push({ name: n.name, kind: n.kind, startLine: n.startLine });
  }
  out.sort((a, b) => a.startLine - b.startLine);
  return out;
}

/**
 * Symbols in `candidates` whose start line is not covered by any emitted range.
 * Used to bias the per-file header toward what the trim dropped (#1711).
 */
export function symbolsNotInRanges(
  candidates: ReadonlyArray<ElidedSymbolRef>,
  ranges: ReadonlyArray<ExploreLineRange>,
): ElidedSymbolRef[] {
  if (ranges.length === 0) return [...candidates].sort((a, b) => a.startLine - b.startLine);
  const out: ElidedSymbolRef[] = [];
  const seen = new Set<string>();
  for (const n of candidates) {
    if (seen.has(n.name)) continue;
    if (ranges.some((r) => n.startLine >= r.start && n.startLine <= r.end)) continue;
    seen.add(n.name);
    out.push(n);
  }
  out.sort((a, b) => a.startLine - b.startLine);
  return out;
}

export const BARE_GAP_MARKER = '\n\n... (gap) ...\n\n';

/**
 * Gap marker between two non-contiguous slices of one file.
 *
 * Bare `... (gap) ...` told the agent something was missing but not WHAT —
 * and the footer then asked it to re-explore "with its exact name", which is
 * circular when the missing names *are* the question (#1711). When the hole
 * holds indexed symbols, list them as `name (file:line)` (same shape the
 * flow / blast-radius lines already use).
 */
export function formatGapMarker(
  filePath: string,
  elided: ReadonlyArray<ElidedSymbolRef>,
): string {
  if (elided.length === 0) return BARE_GAP_MARKER;
  const shown = elided.slice(0, ELIDED_SYMBOL_CAP);
  const more = elided.length - shown.length;
  const names = shown.map((s) => `${s.name} (${filePath}:${s.startLine})`).join(', ')
    + (more > 0 ? `, +${more} more` : '');
  return `\n\n... (gap: ${names}) ...\n\n`;
}

/**
 * Join rendered parts with gap markers that name whatever the trim skipped.
 *
 * `spareChars` is what naming may cost beyond bare markers. Cluster selection
 * prices every join between clusters as a bare marker, and on a long path each
 * named gap runs to several hundred chars, so unbounded naming overran the
 * file's reservation and the ceiling trim then dropped SOURCE to pay for the
 * names: vscode's `rpcProtocol.ts` went from ~5,200 chars of the RPCProtocol
 * body to a 222-char stub. A gap the spare can't cover stays bare; the file
 * header still lists the symbols the trim dropped.
 */
export function joinPartsWithNamedGaps(
  filePath: string,
  parts: ReadonlyArray<{ range: ExploreLineRange; text: string }>,
  nodes: ReadonlyArray<{ name: string; kind: string; startLine: number; endLine: number }>,
  spareChars = Infinity,
): string {
  if (parts.length === 0) return '';
  let out = parts[0]!.text;
  let spare = spareChars;
  for (let i = 1; i < parts.length; i++) {
    const prev = parts[i - 1]!;
    const next = parts[i]!;
    const named = formatGapMarker(filePath, symbolsBetweenRanges(nodes, prev.range.end, next.range.start));
    const extra = named.length - BARE_GAP_MARKER.length;
    if (extra <= spare) {
      out += named;
      spare -= extra;
    } else {
      out += BARE_GAP_MARKER;
    }
    out += next.text;
  }
  return out;
}

/**
 * Prefer symbols the trim dropped when filling the per-file header's named
 * slots, so `+N more` is less likely to hide the answer (#1711). Frequency
 * still breaks ties among the preferred / remaining groups.
 */
export function biasHeaderSymbols(
  symbols: readonly string[],
  elided: ReadonlyArray<ElidedSymbolRef>,
  cap: number,
): { shown: string[]; omitted: number } {
  const elidedLabels = elided.map((s) => `${s.name}(${s.kind})`);
  const elidedSet = new Set(elidedLabels);
  const elidedNames = new Set(elided.map((s) => s.name));
  const counts = new Map<string, number>();
  for (const s of symbols) counts.set(s, (counts.get(s) ?? 0) + 1);
  // Also surface elided symbols that never made it into `symbols` (a dropped
  // cluster's members are absent from assembleSection's list today).
  for (const label of elidedLabels) {
    if (!counts.has(label)) counts.set(label, 1);
  }
  // Earlier elided defs first (elided is startLine-sorted) so the header's
  // named slots track source order through the hole rather than alphabetical
  // filler (`calls0` beating `syncStateNow`).
  const elidedRank = new Map<string, number>();
  elided.forEach((s, i) => {
    elidedRank.set(`${s.name}(${s.kind})`, i);
    if (!elidedRank.has(s.name)) elidedRank.set(s.name, i);
  });
  const score = (label: string): [number, number, number] => {
    const name = label.replace(/\(.*\)$/, '');
    const preferred = elidedSet.has(label) || elidedNames.has(name) ? 1 : 0;
    const rank = elidedRank.get(label) ?? elidedRank.get(name) ?? 9999;
    return [preferred, counts.get(label) ?? 0, -rank];
  };
  const sorted = [...counts.keys()].sort((a, b) => {
    const [pa, ca, ra] = score(a);
    const [pb, cb, rb] = score(b);
    return pb - pa || cb - ca || rb - ra || a.localeCompare(b);
  });
  const shown = sorted.slice(0, cap);
  return { shown, omitted: Math.max(0, sorted.length - shown.length) };
}

/**
 * One pointer line: the file plus enough symbol names to make it NAMEABLE in a
 * follow-up explore. Capped — an un-capped list ran to ~1.9K on the #1500
 * fixture (12 generated CRUD symbols on one line), meta-text bought at the
 * price of the source bytes this section exists to point away from.
 */
export function pointerLineFor(filePath: string, nodes: readonly Node[]): string {
  const POINTER_SYMBOLS = 6;
  const named = nodes.filter((n) => n.kind !== 'import' && n.kind !== 'export');
  const pool = named.length > 0 ? named : nodes;
  const shown = pool.slice(0, POINTER_SYMBOLS);
  const more = pool.length - shown.length;
  const symbols = shown.map((n) => `${n.name}:${n.startLine}`).join(', ')
    + (more > 0 ? `, +${more} more` : '');
  return `- ${filePath}: ${symbols}`;
}
/**
 * Emitted when the response was too full to carry ANY of its pointer list. It
 * is the one line the epilogue floor is reserved for: the list itself can be
 * traded away, but the agent must still be told that an uncovered area exists
 * and that another explore — not a Read — is how to reach it.
 */
export const EPILOGUE_LOST_NOTE = '> (Trailing pointer list omitted for size. The source above is complete and verbatim — treat it as already Read. For anything this call did not cover, run another codegraph_explore with the specific names rather than reading those files.)';
/**
 * The notes that stand in for the epilogue, or close a truncated response, in
 * two wordings each. `complete` says the source above is complete; `trimmed` is
 * used when a section it vouches for was trimmed (see `elidedWantedSpans`) and
 * drops that claim, keeping the guarantee that is still true. Each trimmed
 * wording is no longer than its complete one: the epilogue floor (`lost`) and
 * the cut note's fit test (`cut`) are sized before the render knows which of the
 * two it will need.
 */
export const EXPLORE_FALLBACK_NOTES = {
  lost: {
    complete: EPILOGUE_LOST_NOTE,
    trimmed: '> (Trailing pointer list omitted for size. The source above is verbatim — treat it as already Read. For symbols its gap markers name, and anything else not covered, run another codegraph_explore with those names rather than reading.)',
  },
  cut: {
    complete: '\n\n> (Trailing notes omitted for size. The source above is complete and verbatim — treat it as already Read. For anything this call did not cover, run another codegraph_explore with the specific names rather than reading those files.)',
    trimmed: '\n\n> (Trailing notes omitted for size. The source above is verbatim — treat it as already Read. For symbols its gap markers name, and anything else not covered, run another codegraph_explore with those names rather than reading.)',
  },
  truncated: {
    complete: '\n\n... (output truncated to budget; the source above is complete and verbatim — treat it as already Read. For any area not covered, run another codegraph_explore with the specific names — do NOT Read these files.)',
    trimmed: '\n\n... (output truncated to budget; the source above is verbatim — treat it as already Read. For names its gap markers list, or any area not covered, run another codegraph_explore — do NOT Read these files.)',
  },
} as const;

/**
 * One symbol a file section set out to deliver: a cluster member, or a symbol
 * of the per-symbol (focused/skeleton) view. Completeness is judged against
 * these, not against the file — explore never promises whole files, only the
 * symbols it selected for each one.
 */
export type ExploreWantedSpan = {
  name: string;
  kind: string;
  start: number;
  end: number;
  importance: number;
  spine: boolean;
  /** The indexed qualified name (`SQLCompiler::as_sql`), when the span is a node. */
  qualifiedName?: string;
};

/**
 * The wanted spans a section did NOT deliver in full: some line of the span is
 * in neither what this call sent nor what an earlier call already sent (a
 * back-referenced span counts — the agent holds that copy).
 *
 * Derived from the emitted ranges rather than from a flag each trim site has to
 * remember to set. The oversize-spine window set none until #2068, which is how
 * a 62-line slice of vscode's 968-line `rpcProtocol.ts` went out under "Complete
 * source … do NOT re-read them". Whatever elides source — a member shrink, a
 * ceiling window, a dropped cluster, the per-symbol view, a path added later —
 * shows up here.
 *
 * Most relevant first (spine, then importance), then source order.
 */
export function elidedWantedSpans(
  wanted: ReadonlyArray<ExploreWantedSpan>,
  delivered: ReadonlyArray<ExploreLineRange>,
): ExploreWantedSpan[] {
  const merged = mergeRanges(delivered);
  const out = wanted.filter((w) => w.start > 0 && w.end >= w.start
    && !merged.some((r) => r.start <= w.start && w.end <= r.end));
  return out.sort((a, b) =>
    Number(b.spine) - Number(a.spine) || b.importance - a.importance || a.start - b.start);
}

/** A rendered file whose section is missing some of what it set out to deliver. */
export type ExplorePartialFile = { filePath: string; elided: ReadonlyArray<ExploreWantedSpan> };

/** Trimmed files the completeness note names one by one; the rest are a count. */
export const TRIMMED_FILES_NAMED = 3;
/** Elided symbols the completeness note names, from the spine or named by the agent. */
export const TRIMMED_SYMBOLS_NAMED = 4;
/**
 * Kinds the note never offers as a follow-up target. A container elided by a
 * trim is too big for one section by construction, so exploring it by name
 * comes back trimmed too; its members are the useful names.
 */
export const TRIMMED_NAME_SKIP_KINDS = new Set([
  'file', 'module', 'namespace', 'class', 'struct', 'union', 'interface', 'protocol', 'trait',
]);

/**
 * The name the completeness note offers for an elided symbol: `Owner.member`
 * for a method, so an overloaded name resolves to the definition that was cut
 * (django has 110 `as_sql`s; the note used to offer the bare one and agents
 * then added a path and line to disambiguate it). The bare name otherwise.
 */
export function followUpName(e: ExploreWantedSpan): string {
  if (e.kind !== 'method' || !e.qualifiedName) return e.name;
  const segs = e.qualifiedName.split('::');
  const owner = segs.length >= 2 ? segs[segs.length - 2]! : '';
  return /^[A-Za-z_$][\w$]*$/.test(owner) ? `${owner}.${e.name}` : e.name;
}

/**
 * The shortest trailing slice of each path that no other path in `paths`
 * ends with: `extHostExtensionService.ts` alone when it is the only one,
 * `node/extHostExtensionService.ts` beside `common/extHostExtensionService.ts`.
 */
export function shortestUniqueSuffixes(paths: ReadonlyArray<string>): Map<string, string> {
  const all = [...new Set(paths)];
  const out = new Map<string, string>();
  for (const p of all) {
    const segs = p.split('/');
    let n = 1;
    for (; n < segs.length; n++) {
      const suffix = segs.slice(-n).join('/');
      if (!all.some((o) => o !== p && (o === suffix || o.endsWith(`/${suffix}`)))) break;
    }
    out.set(p, segs.slice(-n).join('/'));
  }
  return out;
}

/**
 * The large tiers' completeness note (`includeCompletenessSignal`), as
 * candidates from most to least specific. The epilogue fit keeps the first
 * one that fits the room left (CG-26).
 *
 * "Complete" is claimed only when no section elided anything it set out to
 * deliver. Otherwise the note keeps the guarantee that is still true (every
 * block shown is verbatim; treat it as already Read), names the trimmed files
 * and the most relevant elided symbols as room allows, and sends the agent to
 * another codegraph_explore for them. It never offers Read: explore output must
 * not tell the agent to Read (AGENTS.md).
 */
export function exploreCompletenessNotes(
  filesIncluded: number,
  trimmed: ReadonlyArray<ExplorePartialFile>,
  /** Every path the response can name (sections and pointer list); labels are unique among them. */
  knownPaths: ReadonlyArray<string>,
): string[] {
  // No count when every section is held from an earlier call: "0 files" reads
  // as nothing shown, beside a note about what was shown.
  const files = filesIncluded === 0 ? 'these files'
    : filesIncluded === 1 ? '1 file' : `${filesIncluded} files`;
  if (trimmed.length === 0) {
    return [`> **Complete source for ${files} is included above — do NOT re-read them.** If your question also needs files/symbols listed under "Not shown above" (or any area this call didn't cover), make ANOTHER codegraph_explore targeting those names — it returns the same source with line numbers and is cheaper and more complete than reading.`];
  }
  const label = shortestUniqueSuffixes([...knownPaths, ...trimmed.map((t) => t.filePath)]);
  const shownFiles = trimmed.slice(0, TRIMMED_FILES_NAMED).map((t) => `\`${label.get(t.filePath)}\``);
  const moreFiles = trimmed.length - shownFiles.length;
  const trimmedList = shownFiles.join(', ') + (moreFiles > 0 ? ` +${moreFiles} more` : '');
  const names: string[] = [];
  for (const t of trimmed) {
    for (const e of t.elided) {
      if (names.length >= TRIMMED_SYMBOLS_NAMED) break;
      if (!(e.spine || e.importance >= 9) || TRIMMED_NAME_SKIP_KINDS.has(e.kind)) continue;
      const name = followUpName(e);
      if (!names.includes(name)) names.push(name);
    }
  }
  const head = `> **Verbatim source for ${files} is included above — treat it as already Read.**`;
  const what = 'gap markers and file headers name what was elided';
  const tail = 'For those, or anything under "Not shown above", make ANOTHER codegraph_explore with those exact names instead of reading the files — it returns their source with line numbers.';
  const withFiles = `${head} Trimmed for size: ${trimmedList}; ${what}`;
  const candidates = names.length > 0
    ? [`${withFiles} (e.g. ${names.map((n) => `\`${n}\``).join(', ')}). ${tail}`]
    : [];
  candidates.push(`${withFiles}. ${tail}`, `${head} Some sections were trimmed for size; ${what}. ${tail}`);
  return candidates;
}

/** Chars a block of lines costs once joined into the response. */
export const roomForLines = (block: readonly string[]): number =>
  block.reduce((n, s) => n + s.length + 1, 0);

/**
 * Fit the completeness note and the pointer list into the room the response has
 * left (CG-26). Returns the note (a candidate block, or none), the pointer
 * block, and the room that remains.
 *
 * The note is one of `noteCandidates`, most specific first. A complete-source
 * note keeps the precedence it always had and goes first. A note that YIELDS (a
 * trimmed one) gives way to the pointer list, which names files the response
 * does not show at all, while what a trimmed section elided is already named in
 * its own gap markers and header. It leaves the list's header and first entry
 * when that much could fit, and its optional detail never costs an entry the
 * least specific candidate would have left.
 */
export function fitExploreEpilogue(opts: {
  room: number;
  noteCandidates: ReadonlyArray<readonly string[]>;
  noteYields: boolean;
  pointerEntries: readonly string[];
  pointerOmitted: number;
}): { note: string[]; pointers: string[]; room: number } {
  const { noteCandidates, noteYields, pointerEntries, pointerOmitted } = opts;
  let room = opts.room;
  // The pointer list as it fits `space`: entries in rank order, and a tail
  // line confessing every entry left out.
  const fitPointers = (space: number): { block: string[]; taken: number } => {
    if (pointerEntries.length === 0) return { block: [], taken: 0 };
    const head = [POINTER_HEADER, ''];
    let left = space - roomForLines(head);
    if (left < 0) return { block: [], taken: 0 };
    let taken = 0;
    for (const entry of pointerEntries) {
      // Every entry we do NOT take has to be confessed by the tail line, so
      // the tail's cost is part of taking one less than all of them.
      const dropped = pointerEntries.length - taken - 1 + pointerOmitted;
      const tail = dropped > 0 ? roomForLines([`- ... and ${dropped} more files`]) : 0;
      if (entry.length + 1 + tail > left) break;
      left -= entry.length + 1;
      taken++;
    }
    if (taken === 0) return { block: [], taken: 0 };
    const block = [...head, ...pointerEntries.slice(0, taken)];
    const dropped = pointerEntries.length - taken + pointerOmitted;
    if (dropped > 0) block.push(`- ... and ${dropped} more files`);
    return { block, taken };
  };

  const pointerNeed = pointerEntries.length > 0
    ? roomForLines([POINTER_HEADER, '', pointerEntries[0]!,
      `- ... and ${pointerEntries.length - 1 + pointerOmitted} more files`])
    : 0;
  const pointerMin = noteYields && pointerNeed <= room ? pointerNeed : 0;
  const leastSpecific = noteCandidates[noteCandidates.length - 1];
  const entriesBeside = (b: readonly string[]) => fitPointers(room - roomForLines(b)).taken;
  const entriesFloor = noteYields && leastSpecific ? entriesBeside(leastSpecific) : 0;
  const note = [...(noteCandidates.find((b) => roomForLines(b) + pointerMin <= room
    && (!noteYields || entriesBeside(b) >= entriesFloor)) ?? [])];
  room -= roomForLines(note);

  const pointers = fitPointers(room).block;
  room -= roomForLines(pointers);
  return { note, pointers, room };
}

/**
 * Match response delimiters rather than ASCII "path characters": filenames
 * can contain Unicode, @, +, and other punctuation. Keep line references and
 * a sentence-ending period, but reject prefixes/suffixes of longer paths.
 */
export function mentionsPath(text: string, relPath: string): boolean {
  const delimiter = /[\s`"'()[\]{}*]/;
  for (let at = text.indexOf(relPath); at !== -1; at = text.indexOf(relPath, at + 1)) {
    if (at > 0 && !delimiter.test(text[at - 1] ?? '')) continue;
    const end = at + relPath.length;
    if (end === text.length || delimiter.test(text[end] ?? '')) return true;
    const suffix = text.slice(end);
    if (/^:\d+(?::\d+|[-–]\d+)?(?=$|[\s`"'()[\]{}*])/.test(suffix)) return true;
    if (/^:(?=$|\s)/.test(suffix)) return true; // file-list label
    if (/^\.(?=$|\s)/.test(suffix)) return true; // prose punctuation
    if (/^[,;](?=$|\s)/.test(suffix)) return true; // list separator
  }
  return false;
}
