/**
 * Vue Router — navigation written as markup.
 *
 *   <router-link to="/login">Sign in</router-link>
 *   <RouterLink :to="{ name: 'profile', params: { username } }">…</RouterLink>
 *   <NuxtLink to="/dashboard">…</NuxtLink>          // Nuxt
 *   <router-link :to="`/article/${slug}`">…</router-link>
 *
 * A template attribute is not a call, so the extractor records no reference
 * for it and the resolver in `frameworks/vue-router.ts` — which binds
 * `router.push` and `navigateTo` — never sees it. This pass reads every `to`
 * out of the source, attributes it to the component (the innermost function)
 * it is written in, matches it against the Vue route table by NAME or by
 * path, and synthesizes one `navigates` edge from the component to the route.
 *
 * The bound form (`:to`) is what carries an object or a template, and it is
 * the common one in a Vue template — so both spellings are read, and both a
 * `{ name: … }` and a `{ path: … }` destination resolve, exactly as they do
 * from a `router.push`.
 *
 * Edges are `provenance:'heuristic'`, `synthesizedBy:'vue-router-link'`, with
 * the destination as written and `registeredAt` = the template site. A
 * computed `:to="target"` is nothing; a name or path nothing declares is
 * nothing. Nothing here runs on a project with no Vue routes.
 */

import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { readStringAt, routesForFile, toHref } from './frameworks/expo-router';
import { destinationsForHref } from './frameworks/nextjs';
import { parseVuePathObject, routeNameInExpression, vueRouteTable } from './frameworks/vue-router';
import { linkEdgesPass, linkTagPattern } from './link-edges';

const TEMPLATE_FILE = /\.(?:vue|[cm]?[jt]sx?)$/;

/** `<router-link … to=` / `<RouterLink … :to=` / `<NuxtLink … to=`, the attribute anywhere in the tag. */
const LINK_TAG = linkTagPattern(
  ['router-link', 'RouterLink', 'NuxtLink', 'nuxt-link'],
  `\\s:?to\\s*=\\s*(?:"([^"]*)"|'([^']*)')`
);

/** A tag this pass could possibly match — the cheap prefilter. */
const HAS_LINK_TAG = /<(?:router-link|RouterLink|NuxtLink|nuxt-link)\b/;

export async function vueRouterLinkEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const table = vueRouteTable(ctx);
  if (table.byRoot.size === 0) return [];
  return linkEdgesPass(ctx, onYield, {
    synthesizedBy: 'vue-router-link',
    fileFilter: TEMPLATE_FILE,
    routesFor: (file) => {
      const routes = routesForFile(table, file);
      return routes && routes.exact.size > 0 ? routes : null;
    },
    pattern: (_file, source) => (HAS_LINK_TAG.test(source) ? LINK_TAG : null),
    stripComments: false,
    site: (m, _source, _file, routes) => {
      // A bound `:to` holds an expression; a plain `to` holds a literal path.
      const value = (m[3] ?? m[4] ?? '').trim();
      if (value.length === 0) return null;
      // The `to` attribute itself — what follows `<tag` and the attributes before it.
      const bound = m[0].slice(1 + m[1]!.length + m[2]!.length).trimStart().startsWith(':');
      const named = bound ? routeNameInExpression(value) : null;
      const byName = named === null ? undefined : routes.byName.get(named);
      // A `{ name }` destination names exactly one route; a path may be
      // written as a choice, and then every arm is drawn.
      let destinations: { node: Node; display: string }[];
      if (byName && named !== null) destinations = [{ node: byName, display: named }];
      else {
        const href = bound ? (parseVuePathObject(value) ?? toHref(readStringAt(value, 0))) : toHref(value);
        if (!href || !href.path.startsWith('/')) return null;
        destinations = destinationsForHref(href, routes).map((d) => ({ node: d.node, display: d.href.display }));
      }
      return {
        destinations,
        metadata: {
          navMethod: 'link',
          ...(named !== null && routes.byName.has(named) ? { by: 'name' } : {}),
        },
      };
    },
  });
}
