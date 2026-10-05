/**
 * Next.js — navigation written as markup.
 *
 *   <Link href="/users">Users</Link>
 *   <Link href={`/users/${user.id}`}>…</Link>
 *   <Link href={{ pathname: '/users/[id]', query: { id } }}>…</Link>
 *   <a href="/pricing">Pricing</a>
 *
 * A JSX attribute is not a call, so the extractor records no reference for
 * it and the resolver in `frameworks/nextjs.ts` — which binds `router.push`
 * and `redirect` — never sees it. This pass reads every `<Link href>` and
 * internal `<a href>` out of the source, attributes it to the component
 * (the innermost function) it is written in, matches the href against the
 * Next route table, and synthesizes one `navigates` edge from the component
 * to the page. That is the edge the Screens view walks back from, so a
 * page's links are its transitions exactly as a screen's taps are.
 *
 * Edges are `provenance:'heuristic'`, `synthesizedBy:'next-link'`, with the
 * href as written and `registeredAt` = the JSX site. A computed href
 * (`href={href}`) is nothing; a path no page serves is nothing. Nothing here
 * runs on a project with no Next pages.
 */

import type { Edge } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { readStringAt, toHref } from './frameworks/expo-router';
import { nextRouteTable, destinationsForHref } from './frameworks/nextjs';
import { linkEdgesPass, linkTagPattern } from './link-edges';

const JSX_FILE = /\.(?:[cm]?[jt]sx?|mdx)$/;

/** `<Link … href=…` / `<NextLink … href=…` / `<a … href=…`, the attribute anywhere in the tag. */
const LINK_TAG = linkTagPattern(['Link', 'NextLink', 'a'], `\\bhref\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*)`);

export async function nextLinkEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const table = nextRouteTable(ctx);
  if (table.exact.size === 0) return [];
  return linkEdgesPass(ctx, onYield, {
    synthesizedBy: 'next-link',
    fileFilter: JSX_FILE,
    routesFor: (file) => (table.roots.some((root) => file.startsWith(root)) ? table : null),
    pattern: (_file, source) => (source.includes('href') ? LINK_TAG : null),
    stripComments: true,
    site: (m, safe) => {
      const tag = m[1]!;
      let literal: string | null = m[3] ?? m[4] ?? null;
      if (literal === null) {
        // `href={…}`: a string, a template, or an object with a literal pathname.
        const at = m.index + m[0].length;
        const ch = safe[at];
        if (ch === '"' || ch === "'" || ch === '`') literal = readStringAt(safe, at);
        else if (ch === '{') {
          const key = /\bpathname\s*:\s*/y;
          key.lastIndex = at;
          const close = safe.indexOf('}', at);
          const head = key.exec(safe.slice(0, close < 0 ? undefined : close).slice(at));
          if (head) literal = readStringAt(safe, at + head.index + head[0].length);
        }
      }
      if (literal === null) return null;
      // An external `<a href>` is a link out of the site, not a transition.
      if (tag === 'a' && !literal.startsWith('/')) return null;
      const href = toHref(literal);
      if (!href) return null;
      return {
        destinations: destinationsForHref(href, table).map((d) => ({ node: d.node, display: d.href.display })),
        metadata: { navMethod: tag === 'a' ? 'a' : 'link' },
      };
    },
  });
}
