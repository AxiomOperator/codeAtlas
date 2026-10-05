/**
 * The one pass behind every router's markup-link synthesizer — Next.js
 * (`<Link href>`), TanStack Router and React Router (`<Link to>`), SvelteKit
 * (`<a href>`) and Vue Router (`<router-link to>`).
 *
 * Each reads its link tags out of a component's source, attributes each to the
 * innermost function it is written in, matches the destination against its
 * route table, and synthesizes one `navigates` edge per (component, route),
 * capped per component so a navigation menu does not read as a decision. What
 * differs between them — the files, the table, the tag, how a destination is
 * read — is the caller's; the scan, the attribution, the dedup and the cap live
 * here, so a fix to any of them reaches all five at once.
 */

import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import { isTestPath } from '../search/query-utils';
import { enclosingFn, makeLineAt } from './synth-utils';

/**
 * `<Tag …attr…` for any of `tags`, the attribute anywhere in the tag. Group 1
 * is the tag, group 2 what precedes the attribute; `attribute` (a regex
 * source) supplies the rest, its own groups numbered from 3.
 *
 * An attribute before the link's may hold an arrow — `<Link onClick={() =>
 * track()} href="/users">` — whose `>` is not the tag's end, so `=>` is read
 * through rather than stopping the scan.
 */
export function linkTagPattern(tags: readonly string[], attribute: string): RegExp {
  const alternation = tags.map((t) => t.replace(/[$]/g, '\\$&')).join('|');
  return new RegExp(`<(${alternation})\\b((?:[^>]|=>)*?)${attribute}`, 'g');
}

/** Links a single component may carry before it is a navigation menu, not a decision. */
export const MAX_LINKS_PER_COMPONENT = 24;

/** A route one link site reaches, and how it is written there. */
export interface LinkDestination {
  node: Node;
  display: string;
}

/** What one matched tag names: its destinations and the edge metadata they share. */
export interface LinkSite {
  destinations: LinkDestination[];
  /** Merged between `synthesizedBy`/`href` and `registeredAt` — `navMethod`, `by`. */
  metadata: Record<string, unknown>;
}

export interface LinkPassSpec<R> {
  /** `metadata.synthesizedBy` on every edge. */
  synthesizedBy: string;
  /** The files this router's links can be written in (test files are always skipped). */
  fileFilter: RegExp;
  /** The routes `file` can link to, or null when it is outside every router root. */
  routesFor: (file: string) => R | null;
  /** The tag pattern for `file`, or null when its source cannot hold a link (the cheap prefilter). */
  pattern: (file: string, source: string) => RegExp | null;
  /** Blank comments before scanning — JSX sources; template sources are scanned as written. */
  stripComments: boolean;
  /** The destinations one match names, or null when it names none. `text` is the scanned source. */
  site: (m: RegExpExecArray, text: string, file: string, routes: R) => LinkSite | null;
}

export async function linkEdgesPass<R>(
  ctx: ResolutionContext,
  onYield: MaybeYield,
  spec: LinkPassSpec<R>
): Promise<Edge[]> {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const perComponent = new Map<string, number>();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!spec.fileFilter.test(file) || isTestPath(file)) continue;
    const routes = spec.routesFor(file);
    if (routes === null) continue;
    if ((++scanned & 63) === 0) await onYield();
    const source = ctx.readFile(file);
    if (!source) continue;
    const pattern = spec.pattern(file, source);
    if (!pattern) continue;
    const text = spec.stripComments ? stripCommentsForRegex(source, 'typescript') : source;
    const nodes = ctx.getNodesInFile(file);
    const lineOf = makeLineAt(text, 1);
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const site = spec.site(m, text, file, routes);
      if (!site || site.destinations.length === 0) continue;
      const line = lineOf(m.index);
      const component = enclosingFn(nodes, line);
      if (!component) continue;
      // A destination written as a choice names one route per arm, and the
      // user reaches every one of them — each is drawn.
      for (const { node: target, display } of site.destinations) {
        const key = `${component.id}>${target.id}`;
        if (seen.has(key)) continue;
        const count = (perComponent.get(component.id) ?? 0) + 1;
        perComponent.set(component.id, count);
        if (count > MAX_LINKS_PER_COMPONENT) continue;
        seen.add(key);
        edges.push({
          source: component.id,
          target: target.id,
          kind: 'navigates',
          line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: spec.synthesizedBy,
            href: display,
            ...site.metadata,
            registeredAt: `${file}:${line}`,
          },
        });
      }
    }
  }
  return edges;
}
