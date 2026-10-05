import * as path from 'path';
import type { Language, Node } from '../types';

/**
 * The `file` node for a whole source file — id `file:<path>`, spanning every
 * line. The one builder shared by the tree-sitter extractor and the SFC
 * (Vue / Svelte / Astro) extractors, so a component file and a plain script
 * file get the same file node.
 */
export function buildFileNode(filePath: string, source: string, language: Language): Node {
  return {
    id: `file:${filePath}`,
    kind: 'file',
    name: path.basename(filePath),
    qualifiedName: filePath,
    filePath,
    language,
    startLine: 1,
    endLine: source.split('\n').length,
    startColumn: 0,
    endColumn: 0,
    isExported: false,
    updatedAt: Date.now(),
  };
}
