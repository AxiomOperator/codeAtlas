/**
 * Owning-package lookup (#1871): which package manifest owns a file.
 *
 * Walk from the file's directory up to the project root and return the
 * nearest manifest that declares a non-empty package name. Monorepos need no
 * configuration: a member package's manifest is nearer to its files than the
 * root's, so the walk lands on the member by itself, and a nameless root
 * manifest (an npm workspace root without `name`, a Cargo `[workspace]`-only
 * file) is stepped over rather than claiming everything.
 *
 * Several manifests in ONE directory resolve by the fixed order of
 * {@link MANIFESTS} (package.json first), so the answer is deterministic.
 *
 * Manifests are read on demand, never indexed, so the answer tracks the
 * working tree; batch lookups share one per-directory cache.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getSection } from './frameworks/cargo-workspace';
import { parseGoModulePath } from './go-module';

export type ManifestKind = 'npm' | 'cargo' | 'go' | 'python' | 'composer' | 'dart' | 'swift' | 'maven';

export interface OwningManifest {
  /** The package name the manifest declares (`@scope/ui`, `my_crate`, the Go module path, …). */
  name: string;
  /** Which ecosystem's manifest it is. */
  kind: ManifestKind;
  /** The manifest file, project-relative POSIX (`packages/ui/package.json`). */
  manifestPath: string;
  /** The package's root directory, project-relative POSIX (`''` for the project root). */
  dir: string;
}

/** A string value of `key` at the start of a line inside a TOML table body. */
function tomlString(body: string | null, key: string): string | null {
  if (!body) return null;
  const m = body.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"\\n]*)"|'([^'\\n]*)')`, 'm'));
  const v = (m?.[1] ?? m?.[2] ?? '').trim();
  return v || null;
}

function jsonName(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed?.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null;
  } catch {
    return null;
  }
}

/** Manifest files in same-directory precedence order, each with its name reader. */
const MANIFESTS: ReadonlyArray<{ file: string; kind: ManifestKind; name: (content: string) => string | null }> = [
  { file: 'package.json', kind: 'npm', name: jsonName },
  { file: 'Cargo.toml', kind: 'cargo', name: (c) => tomlString(getSection(c, 'package'), 'name') },
  { file: 'go.mod', kind: 'go', name: parseGoModulePath },
  {
    file: 'pyproject.toml',
    kind: 'python',
    // PEP 621 `[project]`, then Poetry's `[tool.poetry]`.
    name: (c) => tomlString(getSection(c, 'project'), 'name') ?? tomlString(getSection(c, 'tool.poetry'), 'name'),
  },
  { file: 'composer.json', kind: 'composer', name: jsonName },
  {
    file: 'pubspec.yaml',
    kind: 'dart',
    name: (c) => c.match(/^name:\s*["']?([A-Za-z0-9_]+)["']?\s*(?:#.*)?$/m)?.[1] ?? null,
  },
  {
    file: 'Package.swift',
    kind: 'swift',
    name: (c) => c.match(/Package\s*\(\s*name\s*:\s*"([^"]+)"/)?.[1] ?? null,
  },
  {
    file: 'pom.xml',
    kind: 'maven',
    // The project's own artifactId — not its <parent>'s, which comes first.
    name: (c) =>
      c.replace(/<parent>[\s\S]*?<\/parent>/, '')
        .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, '')
        .match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/)?.[1] ?? null,
  },
];

/** The manifest-file names owning-package lookup understands. */
export const OWNING_MANIFEST_FILES: readonly string[] = MANIFESTS.map((m) => m.file);

/**
 * Project-relative POSIX form of `filePath` (absolute or relative), or null
 * when it lies outside `projectRoot`.
 */
export function toProjectRelative(projectRoot: string, filePath: string): string | null {
  const abs = path.resolve(projectRoot, filePath);
  const rel = path.relative(projectRoot, abs);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** Per-directory cache for a batch of lookups (`dir` → owning manifest or null). */
export type ManifestCache = Map<string, OwningManifest | null>;

/** The named manifest declared directly IN `dir` (project-relative), or null. */
function manifestIn(projectRoot: string, dir: string): OwningManifest | null {
  for (const m of MANIFESTS) {
    const manifestPath = dir ? `${dir}/${m.file}` : m.file;
    let content: string;
    try {
      content = fs.readFileSync(path.join(projectRoot, manifestPath), 'utf-8');
    } catch {
      continue;
    }
    const name = m.name(content);
    if (name) return { name, kind: m.kind, manifestPath, dir };
  }
  return null;
}

/**
 * The nearest named manifest at or above `filePath`'s directory, never above
 * `projectRoot`. Null when the file is outside the project or no manifest up
 * the chain declares a name. Pass one `cache` across a batch of files.
 */
export function findOwningManifest(
  projectRoot: string,
  filePath: string,
  cache: ManifestCache = new Map(),
): OwningManifest | null {
  const rel = toProjectRelative(projectRoot, filePath);
  if (rel === null) return null;
  const parts = rel.split('/');
  parts.pop(); // the file itself
  const visited: string[] = [];
  let found: OwningManifest | null = null;
  for (let i = parts.length; i >= 0; i--) {
    const dir = parts.slice(0, i).join('/');
    if (cache.has(dir)) {
      found = cache.get(dir)!;
      break;
    }
    visited.push(dir);
    const own = manifestIn(projectRoot, dir);
    if (own) {
      found = own;
      break;
    }
  }
  // Every directory walked through resolves to the same owner.
  for (const dir of visited) cache.set(dir, found);
  return found;
}
