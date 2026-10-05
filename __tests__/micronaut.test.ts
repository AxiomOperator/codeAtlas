/**
 * Micronaut route extraction (#971): `@Controller("/base")` + `@Get/@Post/…`
 * method annotations → `route` nodes bound to their handler methods.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import { micronautResolver } from '../src/resolution/frameworks/micronaut';
import { springResolver } from '../src/resolution/frameworks/java';
import type { ResolutionContext } from '../src/resolution/types';

const IMPORTS = 'package io.kestra.webserver.controllers;\n\nimport io.micronaut.http.annotation.*;\n\n';

function extract(src: string, file = 'ExecutionController.java') {
  return micronautResolver.extract!(file, src);
}

describe('micronautResolver.extract', () => {
  it('composes the @Controller prefix with uri = and bare-string method paths', () => {
    const src = `${IMPORTS}@Controller("/api/v1/{tenant}/executions")
public class ExecutionController {
    @Get(uri = "/search")
    public PagedResults<Execution> searchExecutions(@QueryValue String q) { return null; }

    @Post(uri = "/{id}/restart", produces = MediaType.APPLICATION_JSON)
    public Execution restart(String id) { return null; }

    @Delete("/{id}")
    public void delete(String id) {}

    @Put(value = "/flows")
    public void update() {}

    @Patch("/{id}")
    public void patch(String id) {}

    @Head("/{id}")
    public void head(String id) {}

    @Options("/{id}")
    public void options(String id) {}
}`;
    const { nodes, references } = extract(src);
    expect(nodes.map((n) => n.name)).toEqual([
      'GET /api/v1/{tenant}/executions/search',
      'POST /api/v1/{tenant}/executions/{id}/restart',
      'DELETE /api/v1/{tenant}/executions/{id}',
      'PUT /api/v1/{tenant}/executions/flows',
      'PATCH /api/v1/{tenant}/executions/{id}',
      'HEAD /api/v1/{tenant}/executions/{id}',
      'OPTIONS /api/v1/{tenant}/executions/{id}',
    ]);
    expect(nodes.every((n) => n.kind === 'route' && n.language === 'java')).toBe(true);
    expect(references.map((r) => r.referenceName)).toEqual([
      'searchExecutions', 'restart', 'delete', 'update', 'patch', 'head', 'options',
    ]);
    expect(references.map((r) => r.fromNodeId)).toEqual(nodes.map((n) => n.id));
    expect(references.every((r) => r.referenceKind === 'references')).toBe(true);
  });

  it('treats a bare @Get as the controller root and a bare @Controller as "/"', () => {
    const src = `${IMPORTS}@Controller("/health")
public class HealthController {
    @Get
    public String index() { return "ok"; }
}`;
    expect(extract(src).nodes.map((n) => n.name)).toEqual(['GET /health']);

    const bare = `${IMPORTS}@Controller
public class RootController {
    @Get("/ping")
    String ping() { return "pong"; }
}`;
    const r = extract(bare);
    expect(r.nodes.map((n) => n.name)).toEqual(['GET /ping']);
    // Package-private handler (no visibility modifier) still binds.
    expect(r.references.map((x) => x.referenceName)).toEqual(['ping']);
  });

  it('fans out `uris = {…}` and resolves same-file constants', () => {
    const src = `${IMPORTS}@Controller(value = BASE, produces = {MediaType.APPLICATION_JSON})
public class ItemController {
    public static final String BASE = "/items";
    @Get(uris = {"/", "/all"})
    @Secured(SecurityRule.IS_AUTHENTICATED)
    public List<Item> list() { return null; }
}`;
    expect(extract(src).nodes.map((n) => n.name)).toEqual(['GET /items', 'GET /items/all']);
  });

  it('skips stacked annotations (with parens inside strings) between the verb and the method', () => {
    const src = `${IMPORTS}@Controller("/api")
public class FlowController {
    @ExecuteOn(TaskExecutors.IO)
    @Get(uri = "/flows/{namespace}")
    @Operation(tags = {"Flows"}, summary = "List flows (beta)")
    public HttpResponse<List<Flow>> list(@Parameter(description = "ns") String namespace) { return null; }
}`;
    const { nodes, references } = extract(src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /api/flows/{namespace}']);
    expect(references.map((r) => r.referenceName)).toEqual(['list']);
  });

  it('handles Kotlin controllers', () => {
    const src = `package demo

import io.micronaut.http.annotation.Controller
import io.micronaut.http.annotation.Get
import io.micronaut.http.annotation.Post

@Controller("/books")
open class BookController(private val repo: BookRepository) {
    @Get("/{id}")
    fun show(id: Long): Book? = repo.find(id)

    @Post
    suspend fun save(@Body book: Book): Book = repo.save(book)
}`;
    const { nodes, references } = extract(src, 'BookController.kt');
    expect(nodes.map((n) => n.name)).toEqual(['GET /books/{id}', 'POST /books']);
    expect(nodes.every((n) => n.language === 'kotlin')).toBe(true);
    expect(references.map((r) => r.referenceName)).toEqual(['show', 'save']);
  });

  it('does not emit routes for a declarative @Client interface (outgoing calls, not routes)', () => {
    const src = `package demo;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.client.annotation.Client;

@Client("/pets")
public interface PetClient {
    @Get("/{id}")
    Pet get(Long id);
}`;
    expect(extract(src, 'PetClient.java').nodes).toEqual([]);
  });

  it('assigns handlers to the controller, not to a nested class declared before them', () => {
    const src = `${IMPORTS}@Controller("/api")
public class ApiController {
    @Introspected
    public static class Dto { public String name; }

    @Get("/dto")
    public Dto dto() { return null; }
}`;
    expect(extract(src).nodes.map((n) => n.name)).toEqual(['GET /api/dto']);
  });

  it('is gated on the Micronaut annotation import — Spring controllers are untouched', () => {
    const spring = `package demo;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller("/x")
public class SpringController {
    @GetMapping("/y")
    public String y() { return "y"; }
}`;
    expect(extract(spring, 'SpringController.java').nodes).toEqual([]);
    // And Spring's extractor does not read Micronaut verbs either — no double count.
    const micronaut = `${IMPORTS}@Controller("/m")
public class MController {
    @Get("/n")
    public String n() { return "n"; }
}`;
    expect(springResolver.extract!('MController.java', micronaut).nodes.filter((n) => n.kind === 'route')).toEqual([]);
    expect(extract(micronaut, 'MController.java').nodes.map((n) => n.name)).toEqual(['GET /m/n']);
  });

  it('ignores non-JVM files', () => {
    expect(extract(`${IMPORTS}@Controller("/a") class A { @Get("/b") fun b() {} }`, 'a.ts').nodes).toEqual([]);
  });
});

describe('micronautResolver.detect', () => {
  const ctx = (files: Record<string, string>): ResolutionContext => ({
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: (f) => f in files,
    readFile: (f) => files[f] ?? null,
    getProjectRoot: () => '/p',
    getAllFiles: () => Object.keys(files),
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
  });

  it('detects a root or submodule build file declaring io.micronaut', () => {
    expect(micronautResolver.detect(ctx({ 'build.gradle': "implementation 'io.micronaut:micronaut-http'" }))).toBe(true);
    expect(micronautResolver.detect(ctx({ 'webserver/build.gradle': 'implementation "io.micronaut:micronaut-http-server-netty"' }))).toBe(true);
  });

  it('detects via a source file importing the HTTP annotations', () => {
    expect(micronautResolver.detect(ctx({ 'src/A.java': 'import io.micronaut.http.annotation.Get;' }))).toBe(true);
  });

  it('does not detect a Spring project', () => {
    expect(micronautResolver.detect(ctx({
      'pom.xml': '<artifactId>spring-boot-starter-web</artifactId>',
      'src/A.java': 'import org.springframework.stereotype.Controller;',
    }))).toBe(false);
  });
});

describe('Micronaut end-to-end — route node linked to its handler method', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('binds GET /api/v1/executions/search to searchExecutions', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-micronaut-'));
    fs.writeFileSync(path.join(tmpDir, 'build.gradle'), "dependencies { implementation 'io.micronaut:micronaut-http' }\n");
    const dir = path.join(tmpDir, 'src', 'main', 'java', 'demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'ExecutionController.java'),
      `package demo;

import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;

@Controller("/api/v1/executions")
public class ExecutionController {
    @Get(uri = "/search")
    public String searchExecutions() { return "x"; }
}
`,
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    try {
      const route = cg.getNodesByKind('route').find((n) => n.name === 'GET /api/v1/executions/search');
      expect(route).toBeDefined();
      const handler = cg.getNodesByKind('method').find((n) => n.name === 'searchExecutions');
      expect(handler).toBeDefined();
      const edges = cg.getOutgoingEdges(route!.id).filter((e) => e.kind === 'references');
      expect(edges.map((e) => e.target)).toEqual([handler!.id]);
    } finally {
      cg.close();
    }
  });
});
