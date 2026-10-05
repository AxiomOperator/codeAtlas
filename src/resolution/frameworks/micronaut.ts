/**
 * Micronaut Framework Resolver (#971)
 *
 * Micronaut controllers declare routes with annotations from
 * `io.micronaut.http.annotation`:
 *
 *   @Controller("/api/v1/executions")
 *   public class ExecutionController {
 *     @Get(uri = "/search")            // or @Get("/search"), @Get (bare)
 *     public PagedResults<Execution> search(...) { ... }
 *   }
 *
 * Each verb annotation (`@Get/@Post/@Put/@Patch/@Delete/@Head/@Options`) on a
 * method of a `@Controller` class becomes a
 * `route` node named `VERB /prefix/path`, with a `references` edge to the
 * handler method — the same shape the Spring resolver emits, so Entry points
 * and `codegraph_explore` treat the two alike.
 *
 * Gates:
 *  - extraction runs only on files importing `io.micronaut.http.annotation`, so
 *    Spring's `@Controller` (a stereotype, not a route prefix) is never read here;
 *  - a verb annotation counts only inside a class annotated `@Controller` — the
 *    same annotations on a declarative `@Client` interface describe OUTGOING
 *    calls, not routes, and are skipped.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { lineOfIndex } from '../synth-utils';
import { joinPath, parseMappingPaths } from './java';

const MICRONAUT_HTTP_IMPORT = 'io.micronaut.http.annotation';

const VERBS: Record<string, string> = {
  Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', Head: 'HEAD', Options: 'OPTIONS',
};

/** Micronaut's path attributes: `@Get("/x")`, `value = "/x"`, `uri = "/x"`, `uris = {"/a", "/b"}`. */
const MICRONAUT_PATH_KEYS = ['value', 'uri', 'uris'] as const;

/** Index just past the balanced `( … )` / `{ … }` opening at `open` (string-aware). */
function skipBalanced(src: string, open: number, o = '(', c = ')'): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === o) depth++;
    else if (ch === c) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

const skipParens = (src: string, open: number): number => skipBalanced(src, open);

/** Skip whitespace and any stacked annotations (`@Foo`, `@a.b.Foo(...)`) from `pos`. */
function skipAnnotations(src: string, pos: number): number {
  let i = pos;
  for (;;) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] !== '@') return i;
    const m = /^@[\w.]+/.exec(src.slice(i, i + 200));
    if (!m) return i;
    i += m[0].length;
    let j = i;
    while (j < src.length && /\s/.test(src[j]!)) j++;
    if (src[j] === '(') i = skipParens(src, j);
  }
}

/**
 * Name of the method declared right after an annotation ending at `pos`, or
 * null when the next declaration is not a method (a class, a field).
 * Handles Java (`public HttpResponse<X> name(`, package-private `X name(`) and
 * Kotlin (`fun name(`, `suspend fun name(`).
 */
function methodNameAfter(src: string, pos: number): string | null {
  const start = skipAnnotations(src, pos);
  const stop = src.slice(start, start + 400).search(/[(;{=]/);
  if (stop < 0 || src[start + stop] !== '(') return null;
  const decl = src.slice(start, start + stop);
  if (/\b(?:class|interface|enum|record|object)\b/.test(decl)) return null;
  const m = /(\w+)\s*$/.exec(decl);
  return m ? m[1]! : null;
}

interface ClassDecl {
  index: number;
  bodyStart: number;
  bodyEnd: number;
  isController: boolean;
  prefixes: string[];
}

/**
 * Every class/interface declaration, marking the ones a `@Controller` annotates
 * with that controller's path prefixes. Found forward from each `@Controller`
 * (skipping its arguments and any stacked annotations) so arguments holding
 * braces or parens — `produces = {MediaType.X}` — never hide it.
 */
function classDecls(safe: string, consts: Map<string, string>): ClassDecl[] {
  const controllers = new Map<number, string[]>();
  const ctrlRe = /@(?:io\.micronaut\.http\.annotation\.)?Controller(?![\w.])/g;
  let m: RegExpExecArray | null;
  while ((m = ctrlRe.exec(safe)) !== null) {
    let end = m.index + m[0].length;
    let prefixes = [''];
    let j = end;
    while (j < safe.length && /\s/.test(safe[j]!)) j++;
    if (safe[j] === '(') {
      end = skipParens(safe, j);
      prefixes = parseMappingPaths(safe.slice(j + 1, end - 1), consts, MICRONAUT_PATH_KEYS);
    }
    const k = skipAnnotations(safe, end);
    const head = /^(?:(?:public|private|protected|internal|open|abstract|final|static|data|sealed|inner)\s+)*(?=(?:class|interface)\s)/.exec(
      safe.slice(k, k + 300),
    );
    if (head) controllers.set(k + head[0].length, prefixes);
  }

  const decls: ClassDecl[] = [];
  const re = /\b(?:class|interface)\s+\w+/g;
  while ((m = re.exec(safe)) !== null) {
    const prefixes = controllers.get(m.index);
    // The body: the first `{` after the header (skipping a Kotlin primary
    // constructor's parens), to its matching `}`.
    let i = m.index + m[0].length;
    let bodyStart = -1;
    while (i < safe.length) {
      const ch = safe[i];
      if (ch === '(') { i = skipParens(safe, i); continue; }
      if (ch === '{') { bodyStart = i; break; }
      if (ch === ';') break;
      i++;
    }
    if (bodyStart < 0) continue;
    const bodyEnd = skipBalanced(safe, bodyStart, '{', '}');
    decls.push({ index: m.index, bodyStart, bodyEnd, isController: !!prefixes, prefixes: prefixes ?? [''] });
  }
  return decls;
}

export const micronautResolver: FrameworkResolver = {
  name: 'micronaut',
  languages: ['java', 'kotlin'],

  detect(context: ResolutionContext): boolean {
    for (const build of ['pom.xml', 'build.gradle', 'build.gradle.kts', 'gradle.properties']) {
      const content = context.readFile(build);
      if (content && content.includes('io.micronaut')) return true;
    }
    // Multi-module builds keep the dependency in a submodule — read any
    // build file, then fall back to a source file importing the annotations.
    const files = context.getAllFiles();
    for (const f of files) {
      if (/(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/.test(f)) {
        const content = context.readFile(f);
        if (content && content.includes('io.micronaut')) return true;
      }
    }
    for (const f of files) {
      if (!f.endsWith('.java') && !f.endsWith('.kt')) continue;
      const content = context.readFile(f);
      if (content && content.includes(MICRONAUT_HTTP_IMPORT)) return true;
    }
    return false;
  },

  resolve(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    // Route → handler refs are plain method names; the generic name matcher
    // binds them (same-file first), exactly as for Spring.
    return null;
  },

  extract(filePath, content) {
    const empty = { nodes: [] as Node[], references: [] as UnresolvedRef[] };
    if (!filePath.endsWith('.java') && !filePath.endsWith('.kt')) return empty;
    if (!content.includes(MICRONAUT_HTTP_IMPORT)) return empty;

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const lang: 'java' | 'kotlin' = filePath.endsWith('.kt') ? 'kotlin' : 'java';
    const safe = stripCommentsForRegex(content, 'java');
    const consts = new Map<string, string>();
    for (const m of safe.matchAll(/\bstatic\s+final\s+String\s+(\w+)\s*=\s*"([^"]*)"\s*;/g)) consts.set(m[1]!, m[2]!);
    for (const m of safe.matchAll(/\bconst\s+val\s+(\w+)\s*(?::\s*String\s*)?=\s*"([^"]*)"/g)) consts.set(m[1]!, m[2]!);

    const decls = classDecls(safe, consts);
    if (!decls.some((d) => d.isController)) return empty;

    const verbRe = /@(?:io\.micronaut\.http\.annotation\.)?(Get|Post|Put|Patch|Delete|Head|Options)(?![\w.])/g;
    let match: RegExpExecArray | null;
    while ((match = verbRe.exec(safe)) !== null) {
      // The class this method belongs to: the innermost body around it (a
      // nested DTO class before a handler must not take the handler over).
      let owner: ClassDecl | undefined;
      for (const d of decls) {
        if (d.bodyStart < match.index && match.index < d.bodyEnd) owner = d;
      }
      if (!owner || !owner.isController) continue;

      const method = VERBS[match[1]!]!;
      let end = match.index + match[0].length;
      let args = '';
      let j = end;
      while (j < safe.length && /[ \t]/.test(safe[j]!)) j++;
      if (safe[j] === '(') {
        end = skipParens(safe, j);
        args = safe.slice(j + 1, end - 1);
      }
      const handler = methodNameAfter(safe, end);
      if (!handler) continue;
      const paths = parseMappingPaths(args, consts, MICRONAUT_PATH_KEYS);
      const line = lineOfIndex(safe, match.index);
      for (const routePath of owner.prefixes.flatMap((prefix) => paths.map((sub) => joinPath(prefix, sub)))) {
        const routeNode: Node = {
          id: `route:${filePath}:${line}:${method}:${routePath}`,
          kind: 'route',
          name: `${method} ${routePath}`,
          qualifiedName: `${filePath}::route:${routePath}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: end - match.index,
          language: lang,
          updatedAt: now,
        };
        nodes.push(routeNode);
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handler,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: lang,
        });
      }
    }
    return { nodes, references };
  },
};
