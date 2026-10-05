/**
 * Go module path detection.
 *
 * A Go monorepo's cross-package calls (`pkga.FuncX(...)`) only resolve when
 * the resolver knows the project's module path (the `module ...` directive
 * in `go.mod`). Without it, `isExternalImport` treats every in-module import
 * — `github.com/example/myproject/pkga` — as a third-party package, so
 * resolution falls through to name-matching with path proximity and returns
 * a tiny fraction of the real call sites. See issue #388.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface GoModule {
  /** The module path declared in `go.mod`, e.g. `github.com/example/myproject` */
  modulePath: string;
  /** Absolute path to the directory containing the `go.mod` file. */
  rootDir: string;
  /**
   * Project-relative POSIX path of that directory (`''` for the project
   * root). Absent on modules built by older callers — treated as `''`.
   */
  relDir?: string;
}

/**
 * Read the `go.mod` file at the project root and extract the module path.
 * Returns `null` if no `go.mod` exists or it has no `module` directive.
 *
 * Only the project-root `go.mod` is read here; {@link discoverGoModules}
 * finds the nested ones (`svc/go.mod`, a root module plus sibling modules).
 */
export function loadGoModule(projectRoot: string): GoModule | null {
  return loadGoModuleAt(projectRoot, '');
}

function loadGoModuleAt(projectRoot: string, relDir: string): GoModule | null {
  const dir = relDir ? path.join(projectRoot, relDir) : projectRoot;
  const goModPath = path.join(dir, 'go.mod');
  let content: string;
  try {
    content = fs.readFileSync(goModPath, 'utf-8');
  } catch {
    return null;
  }
  // `module <path>` is the first non-comment directive in any valid go.mod.
  // Strip line comments so a `// module foo` doesn't false-match.
  const stripped = content.replace(/\/\/[^\n]*/g, '');
  const match = stripped.match(/^\s*module\s+(\S+)\s*$/m);
  if (!match) return null;
  // Strip optional quoting around the module path.
  const modulePath = match[1]!.replace(/^["']|["']$/g, '');
  if (!modulePath) return null;
  // relDir is omitted for the root module so its shape (and the stored
  // resolution-config fingerprint) matches pre-#2322 indexes.
  return relDir ? { modulePath, rootDir: dir, relDir } : { modulePath, rootDir: dir };
}

/**
 * Every Go module that owns an indexed `.go` file: for each directory holding
 * one, the nearest enclosing `go.mod` at or below the project root (#2322).
 * Deriving the candidates from indexed files means ignored trees (vendor/,
 * testdata/, excluded dirs) never contribute a module. Sorted by module path
 * length, longest first, so {@link goImportPackageDir} picks the most specific
 * module for an import — a root `go.etcd.io/etcd/v3` never claims
 * `go.etcd.io/etcd/server/v3/...` (a sibling module whose path isn't under it).
 */
export function discoverGoModules(projectRoot: string, filePaths: Iterable<string>): GoModule[] {
  const dirModule = new Map<string, GoModule | null>(); // dir -> nearest module
  const found = new Map<string, GoModule>(); // relDir -> module
  const nearest = (dir: string): GoModule | null => {
    const walked: string[] = [];
    let result: GoModule | null = null;
    let cur = dir;
    for (;;) {
      const memo = dirModule.get(cur);
      if (memo !== undefined) { result = memo; break; }
      walked.push(cur);
      const mod = loadGoModuleAt(projectRoot, cur);
      if (mod) { result = mod; found.set(cur, mod); break; }
      if (cur === '') break;
      const slash = cur.lastIndexOf('/');
      cur = slash >= 0 ? cur.slice(0, slash) : '';
    }
    for (const d of walked) dirModule.set(d, result);
    return result;
  };
  for (const raw of filePaths) {
    if (!raw.endsWith('.go')) continue;
    const fp = raw.replace(/\\/g, '/');
    const slash = fp.lastIndexOf('/');
    nearest(slash >= 0 ? fp.slice(0, slash) : '');
  }
  return [...found.values()].sort(
    (a, b) => b.modulePath.length - a.modulePath.length || (a.relDir ?? '').localeCompare(b.relDir ?? '')
  );
}

/**
 * The project-relative POSIX directory an in-module Go import path names, or
 * `null` when no known module claims it (stdlib / third-party). Matches the
 * LONGEST module path that is the import path or a `/`-prefix of it.
 */
export function goImportPackageDir(importPath: string, modules: readonly GoModule[]): string | null {
  let best: GoModule | null = null;
  for (const m of modules) {
    if (importPath !== m.modulePath && !importPath.startsWith(m.modulePath + '/')) continue;
    if (!best || m.modulePath.length > best.modulePath.length) best = m;
  }
  if (!best) return null;
  const rest = importPath === best.modulePath ? '' : importPath.slice(best.modulePath.length + 1);
  const base = best.relDir ?? '';
  return base && rest ? `${base}/${rest}` : base || rest;
}

/** The modules a resolution context knows (all discovered, else the root one). */
export function contextGoModules(context: {
  getGoModules?(): readonly GoModule[];
  getGoModule?(): GoModule | null;
} | undefined): readonly GoModule[] {
  if (!context) return [];
  const all = context.getGoModules?.();
  if (all) return all;
  const root = context.getGoModule?.();
  return root ? [root] : [];
}
