/**
 * TanStack Router — navigation written as markup.
 *
 *   <Link to="/dashboard/invoices/$invoiceId" params={{ invoiceId: 3 }}>…</Link>
 *   <Link to="/login">Sign in</Link>
 *   <Navigate to="/dashboard" />
 *
 * A JSX attribute is not a call, so the extractor records no reference for it
 * and the resolver in `frameworks/tanstack-router.ts` — which binds
 * `navigate({ to })` and `redirect({ to })` — never sees it. This pass reads
 * every `to` out of the source, attributes it to the component (the innermost
 * function) it is written in, matches it against the TanStack route table, and
 * synthesizes one `navigates` edge from the component to the route.
 *
 * What makes this different from React Router's identical-looking `<Link to>`:
 * TanStack's `to` is the route PATTERN and the values ride beside it in
 * `params`, so `to="/posts/$postId"` names the route rather than an address —
 * and it is normalised the same way a route name is instead of being read as a
 * URL. A `<Link from=…>` with no `to` is a relative link within the route it
 * is already on, and names no destination of its own.
 *
 * Edges are `provenance:'heuristic'`, `synthesizedBy:'tanstack-link'`, with the
 * destination as written and `registeredAt` = the JSX site. A computed `to` is
 * nothing; a pattern no route serves is nothing. Nothing here runs on a project
 * with no TanStack routes.
 */

import type { Edge } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { readStringAt, routesForFile } from './frameworks/expo-router';
import { destinationsForHref } from './frameworks/nextjs';
import { tanstackDestination, tanstackTable } from './frameworks/tanstack-router';
import { linkEdgesPass, linkTagPattern } from './link-edges';

const JSX_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** `<Link … to=` / `<Navigate … to=`, the attribute anywhere in the tag. */
const LINK_TAG = linkTagPattern(['Link', 'Navigate'], `\\bto\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*)`);

/** A tag this pass could possibly match — the cheap prefilter. */
const HAS_LINK_TAG = /<(?:Link|Navigate)\b/;

export async function tanstackLinkEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const table = tanstackTable(ctx);
  if (table.byRoot.size === 0) return [];
  return linkEdgesPass(ctx, onYield, {
    synthesizedBy: 'tanstack-link',
    fileFilter: JSX_FILE,
    routesFor: (file) => {
      const routes = routesForFile(table, file);
      return routes && routes.exact.size > 0 ? routes : null;
    },
    pattern: (_file, source) => (HAS_LINK_TAG.test(source) ? LINK_TAG : null),
    stripComments: true,
    site: (m, safe, _file, routes) => {
      let literal: string | null = m[3] ?? m[4] ?? null;
      if (literal === null) {
        // `to={…}`: a string or a template.
        const at = m.index + m[0].length;
        const ch = safe[at];
        if (ch === '"' || ch === "'" || ch === '`') literal = readStringAt(safe, at);
      }
      if (literal === null) return null;
      const href = tanstackDestination(JSON.stringify(literal));
      if (!href) return null;
      return {
        destinations: destinationsForHref(href, routes).map((d) => ({ node: d.node, display: d.href.display })),
        metadata: { navMethod: m[1] === 'Navigate' ? 'navigate' : 'link' },
      };
    },
  });
}
