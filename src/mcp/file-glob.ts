/**
 * The `codegraph_files` `pattern` matcher.
 *
 * Semantics (stated in the tool description):
 * - A pattern with no glob syntax at all (`Button`, `src/auth`) is a plain
 *   substring match on the project-relative path.
 * - Matching is ANCHORED: the whole path (or basename) must match, so `*.ts`
 *   matches `a.ts` but not `a.tsx`.
 * - A pattern with no `/` matches a file's BASENAME anywhere in the tree
 *   (`*.ts`, `*.{ts,tsx}`, `index.*`), like `.gitignore` / `find -name`.
 * - A pattern with a `/` matches the project-relative path (`src/**\/*.ts`);
 *   a `**` segment matches zero or more directories, so `**\/foo.ts` also
 *   matches a root-level `foo.ts`.
 * - Brace sets (`{a,b}`, also across `/`), `?`, character classes and dotfiles
 *   are supported; per-segment syntax is picomatch's.
 *
 * ReDoS guard. picomatch compiles a WHOLE pattern to one backtracking RegExp,
 * and wildcards interleaved with globstars multiply (`**\/*a*\/**\/*a*\/**\/*a*`
 * against a deep path runs for minutes). So the pattern is matched SEGMENT BY
 * SEGMENT: `**` segments by a memoized walk over the path's segments (at most
 * pattern-segments x path-segments steps), every other segment by its own small
 * picomatch matcher, which can only see one path segment. Runs of `*` collapse,
 * and one segment may hold at most {@link MAX_STARS_PER_SEGMENT} wildcards (a
 * single segment's cost is polynomial in that count). Brace expansion is capped
 * at {@link MAX_BRACE_ALTERNATIVES} alternatives.
 */

import picomatch from 'picomatch';

/** Wildcard runs allowed in one path segment of a pattern (see module doc). */
export const MAX_STARS_PER_SEGMENT = 3;
/** Alternatives a pattern's cross-segment brace sets may expand to. */
export const MAX_BRACE_ALTERNATIVES = 64;

export type FileGlobMatcher = (relPath: string) => boolean;

/**
 * Compile a `codegraph_files` glob. Returns the matcher, or a string saying why
 * the pattern can't be used (the caller turns it into success-shaped guidance).
 */
export function compileFileGlob(rawPattern: string): FileGlobMatcher | string {
  const pattern = rawPattern
    .replace(/\\/g, '/')
    .replace(/^(?:\.?\/+)+/, '')
    // `***` and longer mean nothing more than `**`.
    .replace(/\*{3,}/g, '**');
  if (pattern.length === 0) return 'pattern is empty after normalization';

  // No glob syntax at all (`Button`, `src/auth`): keep the old substring match,
  // which agents rely on — an anchored literal would answer "no files" for a
  // name fragment and send the agent to Grep.
  if (!/[*?[\]{}!]/.test(pattern)) {
    return (relPath) => relPath.replace(/\\/g, '/').includes(pattern);
  }

  const alternatives = expandSlashBraces(pattern);
  if (typeof alternatives === 'string') return alternatives;

  const compiled: Array<Array<SegmentMatcher>> = [];
  for (const alt of alternatives) {
    // A trailing slash names a directory: everything under it.
    const segs = (alt.endsWith('/') ? `${alt}**` : alt).split('/').filter((s) => s !== '');
    // Consecutive `**` segments are one globstar.
    const deduped = segs.filter((s, i) => !(s === '**' && segs[i - 1] === '**'));
    const matchers: SegmentMatcher[] = [];
    for (const seg of deduped) {
      if (seg === '**') { matchers.push(GLOBSTAR); continue; }
      const stars = seg.match(/\*+/g)?.length ?? 0;
      if (stars > MAX_STARS_PER_SEGMENT) {
        return (
          `pattern has ${stars} wildcards in the path segment "${seg.slice(0, 80)}" — ` +
          `at most ${MAX_STARS_PER_SEGMENT} per segment are supported; use a simpler pattern ` +
          '(e.g. "*.ts", "src/**/*.test.ts") or the `path` filter'
        );
      }
      try {
        matchers.push(picomatch(seg, { dot: true }));
      } catch (err) {
        return `pattern could not be parsed as a glob (${err instanceof Error ? err.message : String(err)})`;
      }
    }
    compiled.push(matchers);
  }

  // No `/` → match the basename anywhere in the tree.
  const basenameOnly = !pattern.includes('/');
  return (relPath) => {
    const p = relPath.replace(/\\/g, '/');
    const segs = basenameOnly ? [p.slice(p.lastIndexOf('/') + 1)] : p.split('/');
    return compiled.some((m) => matchSegments(m, segs));
  };
}

type SegmentMatcher = ((segment: string) => boolean) | typeof GLOBSTAR;
const GLOBSTAR = Symbol('globstar');

/** Memoized segment walk: O(pattern segments x path segments) matcher calls. */
function matchSegments(pat: SegmentMatcher[], path: string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (path.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let res: boolean;
    if (i === pat.length) {
      res = j === path.length;
    } else {
      const m = pat[i]!;
      if (m === GLOBSTAR) {
        // Zero directories, or consume one segment and stay on the globstar.
        res = go(i + 1, j) || (j < path.length && !isDotDir(path[j]!) && go(i, j + 1));
      } else {
        res = j < path.length && m(path[j]!) && go(i + 1, j + 1);
      }
    }
    memo.set(key, res);
    return res;
  };
  return go(0, 0);
}

/** `.` / `..` never belong to a globstar (they are not real path segments). */
function isDotDir(seg: string): boolean {
  return seg === '.' || seg === '..';
}

/**
 * Expand only the brace sets that contain a `/` (a set inside one segment is
 * left to picomatch). Returns the alternatives, or a guidance string when the
 * expansion would exceed {@link MAX_BRACE_ALTERNATIVES}.
 */
function expandSlashBraces(pattern: string): string[] | string {
  const out: string[] = [];
  const queue = [pattern];
  while (queue.length) {
    const p = queue.shift()!;
    const set = findSlashBraceSet(p);
    if (!set) { out.push(p); continue; }
    for (const option of set.options) {
      queue.push(p.slice(0, set.start) + option + p.slice(set.end + 1));
      if (out.length + queue.length > MAX_BRACE_ALTERNATIVES) {
        return `pattern's brace sets expand to more than ${MAX_BRACE_ALTERNATIVES} alternatives — use a narrower pattern`;
      }
    }
  }
  return out;
}

/** The first top-level `{a,b}` whose body contains a `/`, split on top-level commas. */
function findSlashBraceSet(p: string): { start: number; end: number; options: string[] } | null {
  for (let start = 0; start < p.length; start++) {
    if (p[start] !== '{' || (start > 0 && p[start - 1] === '\\')) continue;
    let depth = 0;
    const commas: number[] = [];
    for (let k = start; k < p.length; k++) {
      const c = p[k];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const body = p.slice(start + 1, k);
          if (!body.includes('/') || commas.length === 0) break;
          const options: string[] = [];
          let prev = start + 1;
          for (const comma of commas) { options.push(p.slice(prev, comma)); prev = comma + 1; }
          options.push(p.slice(prev, k));
          return { start, end: k, options };
        }
      } else if (c === ',' && depth === 1) commas.push(k);
    }
  }
  return null;
}
