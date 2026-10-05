/**
 * File-path strategy: path-like references resolved to file nodes.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from '../../types';
import { sameLanguageFamily } from '../language-family';
import { computePathProximity } from './fuzzy';

/**
 * Try to resolve a path-like reference (e.g., "snippets/drawer-menu.liquid")
 * by matching the filename against file nodes.
 */
export function matchByFilePath(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Path-like (`a/b.liquid`) OR a bare filename ending in a short extension
  // (`Foo.h` — an Objective-C `#import "Foo.h"`, resolved to the header by
  // basename). A bare ref WITHOUT an extension is a symbol name, not a file, so
  // leave it to the symbol-matching strategies.
  if (!ref.referenceName.includes('/') && !/\.[A-Za-z][A-Za-z0-9]{0,3}$/.test(ref.referenceName)) {
    return null;
  }

  // Extract the filename from the path
  const fileName = ref.referenceName.split('/').pop();
  if (!fileName) return null;

  // Search for file nodes with this name
  const candidates = context.getNodesByName(fileName);
  const fileNodes = candidates.filter(n => n.kind === 'file');

  if (fileNodes.length === 0) return null;

  // Prefer exact path match on qualified_name
  const exactMatch = fileNodes.find(n => n.qualifiedName === ref.referenceName || n.filePath === ref.referenceName);
  if (exactMatch) {
    return {
      original: ref,
      targetNodeId: exactMatch.id,
      confidence: 0.95,
      resolvedBy: 'file-path',
    };
  }

  // Fall back to suffix match (e.g., ref="snippets/foo.liquid" matches
  // "src/snippets/foo.liquid"). When several files share the basename — a
  // `#include "RNCAsyncStorage.h"` with a same-named header on another platform
  // (windows/code/ vs apple/) — prefer the one in the includer's own directory,
  // then by directory proximity / same language family. A C/C++ include (and any
  // bare-filename import) resolves relative to the including file, not to an
  // arbitrary same-named header elsewhere in the tree.
  const suffixMatches = fileNodes.filter(
    n => n.qualifiedName.endsWith(ref.referenceName) || n.filePath.endsWith(ref.referenceName)
  );
  if (suffixMatches.length > 0) {
    return {
      original: ref,
      targetNodeId: pickClosestFileNode(suffixMatches, ref).id,
      confidence: 0.85,
      resolvedBy: 'file-path',
    };
  }

  // If only one file node with this name, use it with lower confidence
  if (fileNodes.length === 1) {
    return {
      original: ref,
      targetNodeId: fileNodes[0]!.id,
      confidence: 0.7,
      resolvedBy: 'file-path',
    };
  }

  return null;
}

/**
 * Among several file nodes that all match a bare include/import by basename,
 * pick the one closest to the referencing file: same directory first, then by
 * directory-tree proximity, with the same language family as a tiebreak. A
 * C/C++ `#include "X.h"` (and any bare-filename import) resolves relative to the
 * including file — not to an arbitrary same-named header on another platform.
 */
function pickClosestFileNode(candidates: Node[], ref: UnresolvedRef): Node {
  const dirOf = (p: string): string => {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(0, i) : '';
  };
  const refDir = dirOf(ref.filePath);
  const sameDir = candidates.filter((c) => dirOf(c.filePath) === refDir);
  const pool = sameDir.length > 0 ? sameDir : candidates;
  let best = pool[0]!;
  let bestScore = -Infinity;
  for (const c of pool) {
    const score =
      computePathProximity(ref.filePath, c.filePath) +
      (sameLanguageFamily(c.language, ref.language) ? 5 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}
