/**
 * Plain-text renderers for the non-explore read tools (search, callers/callees,
 * impact, node, files). Hoisted from `ToolHandler` unchanged.
 */

import type CodeGraph from '../index';
import type { Edge, Node, SearchResult, Subgraph } from '../types';
import { numberSourceLines } from './explore-format';

/**
 * Format files as a flat list
 */
export function formatFilesFlat(files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
  const lines: string[] = [`**Files (${files.length})**`, ''];

  for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
    if (includeMetadata) {
      lines.push(`- ${file.path} (${file.language}, ${file.nodeCount} symbols)`);
    } else {
      lines.push(`- ${file.path}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format files grouped by language
 */
export function formatFilesGrouped(files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
  const byLang = new Map<string, typeof files>();

  for (const file of files) {
    const existing = byLang.get(file.language) || [];
    existing.push(file);
    byLang.set(file.language, existing);
  }

  const lines: string[] = [`**Files by Language (${files.length} total)**`, ''];

  // Sort languages by file count (descending)
  const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [lang, langFiles] of sortedLangs) {
    lines.push(`**${lang} (${langFiles.length})**`);
    for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
      if (includeMetadata) {
        lines.push(`- ${file.path} (${file.nodeCount} symbols)`);
      } else {
        lines.push(`- ${file.path}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format files as a tree structure
 */
export function formatFilesTree(
  files: { path: string; language: string; nodeCount: number }[],
  includeMetadata: boolean,
  maxDepth?: number
): string {
  // Build tree structure
  interface TreeNode {
    name: string;
    children: Map<string, TreeNode>;
    file?: { language: string; nodeCount: number };
  }

  const root: TreeNode = { name: '', children: new Map() };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      if (!current.children.has(part)) {
        current.children.set(part, { name: part, children: new Map() });
      }
      current = current.children.get(part)!;

      // If this is the last part, it's a file
      if (i === parts.length - 1) {
        current.file = { language: file.language, nodeCount: file.nodeCount };
      }
    }
  }

  // Render tree
  const lines: string[] = [`**Project Structure (${files.length} files)**`, ''];

  const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
    if (maxDepth !== undefined && depth > maxDepth) return;

    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    if (node.name) {
      let line = prefix + connector + node.name;
      if (node.file && includeMetadata) {
        line += ` (${node.file.language}, ${node.file.nodeCount} symbols)`;
      }
      lines.push(line);
    }

    const children = [...node.children.values()];
    // Sort: directories first, then files, both alphabetically
    children.sort((a, b) => {
      const aIsDir = a.children.size > 0 && !a.file;
      const bIsDir = b.children.size > 0 && !b.file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const nextPrefix = node.name ? prefix + childPrefix : prefix;
      renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
    }
  };

  renderNode(root, '', true, 0);

  return lines.join('\n');
}

export function formatSearchResults(results: SearchResult[]): string {
  const lines: string[] = [`**Search Results (${results.length} found)**`, ''];

  for (const result of results) {
    const { node } = result;
    const location = node.startLine ? `:${node.startLine}` : '';
    // Compact format: one line per result with key info
    lines.push(`**${node.name}** (${node.kind})`);
    lines.push(`${node.filePath}${location}`);
    if (node.signature) lines.push(`\`${node.signature}\``);
    lines.push('');
  }

  return lines.join('\n');
}

export function formatNodeList(nodes: Node[], title: string, labels?: Map<string, string>): string {
  const lines: string[] = [`**${title} (${nodes.length} found)**`, ''];

  for (const node of nodes) {
    const location = node.startLine ? `:${node.startLine}` : '';
    // Compact: just name, kind, location — plus the relationship when it
    // isn't a plain call (callback registration, instantiation, …).
    const label = labels?.get(node.id);
    lines.push(
      `- ${node.name} (${node.kind}) - ${node.filePath}${location}${label ? ` — via ${label}` : ''}`
    );
  }

  return lines.join('\n');
}

/**
 * Relationship label for a non-`calls` edge in callers/callees lists. A
 * function-as-value edge (#756) is the high-signal one: `callers(cb)`
 * showing "via callback registration" tells the agent this is where the
 * callback is WIRED, not where it's invoked.
 */
export function edgeLabel(edge: Edge): string | null {
  if (edge.kind === 'calls') return null;
  if (edge.metadata?.fnRef === true) return 'callback registration';
  if (edge.kind === 'instantiates') return 'instantiation';
  if (edge.kind === 'imports') return 'import';
  if (edge.kind === 'references') return 'reference';
  return edge.kind;
}

export function formatImpact(symbol: string, impact: Subgraph): string {
  const nodeCount = impact.nodes.size;

  // Compact format: just list affected symbols grouped by file
  const lines: string[] = [
    `**Impact: "${symbol}" affects ${nodeCount} symbols**`,
    '',
  ];

  // Group by file
  const byFile = new Map<string, Node[]>();
  for (const node of impact.nodes.values()) {
    const existing = byFile.get(node.filePath) || [];
    existing.push(node);
    byFile.set(node.filePath, existing);
  }

  for (const [file, nodes] of byFile) {
    lines.push(`**${file}:**`);
    // Compact: inline list
    const nodeList = nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
    lines.push(nodeList);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build a compact structural outline of a container symbol from its
 * indexed children (methods, fields, properties, …) — name, kind,
 * line number, and signature — so the agent gets the shape of a class
 * without the full source of every method. Returns '' when the container
 * has no indexed children, so the caller can fall back to full source.
 */
export function buildContainerOutline(cg: CodeGraph, node: Node): string {
  const children = cg.getChildren(node.id)
    .filter(c => c.kind !== 'import' && c.kind !== 'export')
    .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
  if (children.length === 0) return '';

  const lines = [`**Members (${children.length}):**`, ''];
  for (const c of children) {
    const loc = c.startLine ? `:${c.startLine}` : '';
    const sig = c.signature ? ` — \`${c.signature}\`` : '';
    lines.push(`- ${c.name} (${c.kind})${loc}${sig}`);
  }
  return lines.join('\n');
}

export function formatNodeDetails(node: Node, code: string | null, outline?: string | null): string {
  const location = node.startLine ? `:${node.startLine}` : '';
  const lines: string[] = [
    `**${node.name}** (${node.kind})`,
    '',
    `**Location:** ${node.filePath}${location}`,
  ];

  if (node.signature) {
    lines.push(`**Signature:** \`${node.signature}\``);
  }

  // Only include docstring if it's short and useful
  if (node.docstring && node.docstring.length < 200) {
    lines.push('', node.docstring);
  }

  if (outline) {
    lines.push('', outline, '',
      `> Structural outline only. Read \`${node.filePath}\` or call codegraph_node on a specific member for its body.`);
  } else if (code) {
    // Line-numbered (cat -n style, like codegraph_explore and Read) so the
    // agent can cite/edit exact lines without re-Reading the file for them.
    const numbered = node.startLine ? numberSourceLines(code, node.startLine) : code;
    lines.push('', '```' + node.language, numbered, '```');
  }

  return lines.join('\n');
}
