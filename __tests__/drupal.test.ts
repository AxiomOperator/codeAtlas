/**
 * Tests for Drupal framework resolver.
 *
 * Unit tests cover drupalResolver.detect(), extract() (routes + hooks), and resolve().
 * Integration tests use a real CodeGraph instance with a temporary Drupal project layout.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { drupalResolver } from '../src/resolution/frameworks/drupal';
import { generateNodeId } from '../src/extraction/tree-sitter-helpers';
import type { ResolutionContext } from '../src/resolution/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
  overrides: Partial<ResolutionContext> = {},
): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/project',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------

describe('drupalResolver.detect', () => {
  it('returns true when composer.json has a drupal/ dependency', () => {
    const ctx = makeContext({
      readFile: (f) =>
        f === 'composer.json'
          ? JSON.stringify({
              require: {
                'drupal/core-recommended': '~10.5',
                'drush/drush': '^13',
              },
            })
          : null,
    });
    expect(drupalResolver.detect(ctx)).toBe(true);
  });

  it('returns true when drupal/ dependency is in require-dev', () => {
    const ctx = makeContext({
      readFile: (f) =>
        f === 'composer.json'
          ? JSON.stringify({ 'require-dev': { 'drupal/core': '^10' } })
          : null,
    });
    expect(drupalResolver.detect(ctx)).toBe(true);
  });

  it('returns false when composer.json has no drupal/ dependencies', () => {
    const ctx = makeContext({
      readFile: (f) =>
        f === 'composer.json'
          ? JSON.stringify({
              require: { 'laravel/framework': '^10', php: '>=8.1' },
            })
          : null,
    });
    expect(drupalResolver.detect(ctx)).toBe(false);
  });

  it('returns false when composer.json is absent', () => {
    const ctx = makeContext({ readFile: () => null });
    expect(drupalResolver.detect(ctx)).toBe(false);
  });

  it('returns false when composer.json is malformed JSON', () => {
    const ctx = makeContext({ readFile: () => '{ bad json' });
    expect(drupalResolver.detect(ctx)).toBe(false);
  });

  it('returns true for a contrib module with empty require (composer name/type)', () => {
    const ctx = makeContext({
      readFile: (f) =>
        f === 'composer.json'
          ? JSON.stringify({
              name: 'drupal/admin_toolbar',
              type: 'drupal-module',
              require: {},
            })
          : null,
    });
    expect(drupalResolver.detect(ctx)).toBe(true);
  });

  it('returns true via the *.info.yml fallback when composer.json is absent', () => {
    const ctx = makeContext({
      readFile: () => null,
      getAllFiles: () => [
        'mymodule/mymodule.info.yml',
        'mymodule/mymodule.routing.yml',
      ],
    });
    expect(drupalResolver.detect(ctx)).toBe(true);
  });

  it('returns false for a stray *.info.yml with no Drupal PHP/route file', () => {
    const ctx = makeContext({
      readFile: () => null,
      getAllFiles: () => ['some/unrelated.info.yml'],
    });
    expect(drupalResolver.detect(ctx)).toBe(false);
  });
});

describe('drupalResolver.claimsReference', () => {
  it('claims FQCN handler refs and hook names the pre-filter would drop', () => {
    expect(drupalResolver.claimsReference!('\\Drupal\\m\\Form\\SettingsForm')).toBe(true);
    expect(drupalResolver.claimsReference!('\\Drupal\\m\\Controller\\C:setNoJsCookie')).toBe(true);
    expect(drupalResolver.claimsReference!('hook_form_alter')).toBe(true);
  });

  it('does not claim ordinary identifiers or entity-handler dotted refs', () => {
    expect(drupalResolver.claimsReference!('someHelperFunction')).toBe(false);
    expect(drupalResolver.claimsReference!('comment.default')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extract() — routing.yml
// ---------------------------------------------------------------------------

describe('drupalResolver.extract — routing.yml', () => {
  const routing = `
mymodule.example:
  path: '/mymodule/example'
  defaults:
    _controller: '\\Drupal\\mymodule\\Controller\\MyController::build'
    _title: 'Example page'
  requirements:
    _permission: 'access content'
`;

  it('emits a route node for each YAML route', () => {
    const { nodes } = drupalResolver.extract!(
      'mymodule/mymodule.routing.yml',
      routing,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('route');
    expect(nodes[0]!.name).toBe('/mymodule/example');
  });

  it('sets qualifiedName to filePath::routeName', () => {
    const { nodes } = drupalResolver.extract!(
      'mymodule/mymodule.routing.yml',
      routing,
    );
    expect(nodes[0]!.qualifiedName).toBe(
      'mymodule/mymodule.routing.yml::mymodule.example',
    );
  });

  it('emits a references edge to the controller FQCN', () => {
    const { references } = drupalResolver.extract!(
      'mymodule/mymodule.routing.yml',
      routing,
    );
    expect(references).toHaveLength(1);
    expect(references[0]!.referenceName).toBe(
      '\\Drupal\\mymodule\\Controller\\MyController::build',
    );
    expect(references[0]!.referenceKind).toBe('references');
  });

  it('emits a references edge to a _form handler', () => {
    const src = `
mymodule.settings_form:
  path: '/admin/config/mymodule'
  defaults:
    _form: '\\Drupal\\mymodule\\Form\\SettingsForm'
    _title: 'MyModule settings'
  requirements:
    _permission: 'administer site configuration'
`;
    const { nodes, references } = drupalResolver.extract!(
      'mymodule/mymodule.routing.yml',
      src,
    );
    expect(nodes).toHaveLength(1);
    expect(references[0]!.referenceName).toBe(
      '\\Drupal\\mymodule\\Form\\SettingsForm',
    );
  });

  it('handles multiple routes in one file', () => {
    const src = `
mod.page_one:
  path: '/page-one'
  defaults:
    _controller: '\\Drupal\\mod\\Controller\\PageController::one'
  requirements:
    _permission: 'access content'

mod.page_two:
  path: '/page-two'
  defaults:
    _controller: '\\Drupal\\mod\\Controller\\PageController::two'
  requirements:
    _permission: 'access content'
`;
    const { nodes, references } = drupalResolver.extract!(
      'mod/mod.routing.yml',
      src,
    );
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.name)).toContain('/page-one');
    expect(nodes.map((n) => n.name)).toContain('/page-two');
    expect(references).toHaveLength(2);
  });

  it('skips commented-out lines', () => {
    const src = `
mod.page:
  path: '/page'
  defaults:
    #_controller: '\\Drupal\\mod\\Controller\\Old::build'
    _controller: '\\Drupal\\mod\\Controller\\New::build'
  requirements:
    _permission: 'access content'
`;
    const { references } = drupalResolver.extract!('mod/mod.routing.yml', src);
    expect(references).toHaveLength(1);
    expect(references[0]!.referenceName).toContain('New');
  });

  it('includes HTTP methods in the route node name when present', () => {
    const src = `
mod.api:
  path: '/api/resource'
  defaults:
    _controller: '\\Drupal\\mod\\Controller\\ApiController::get'
  methods: [GET, POST]
  requirements:
    _permission: 'access content'
`;
    const { nodes } = drupalResolver.extract!('mod/mod.routing.yml', src);
    expect(nodes[0]!.name).toContain('GET');
    expect(nodes[0]!.name).toContain('POST');
  });

  it('returns empty result for non-routing-yml files', () => {
    const { nodes, references } = drupalResolver.extract!(
      'mymodule.module',
      '<?php\n',
    );
    // Module files go through hook detection, not route extraction
    expect(nodes).toHaveLength(0);
  });

  it('returns empty result for files with no valid routes', () => {
    const { nodes, references } = drupalResolver.extract!(
      'some.routing.yml',
      '# empty\n',
    );
    expect(nodes).toHaveLength(0);
    expect(references).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extract() — hook detection in .module files
// ---------------------------------------------------------------------------

describe('drupalResolver.extract — hook detection', () => {
  it('detects hook implementation via docblock (Strategy A)', () => {
    const src = `<?php

/**
 * Implements hook_form_alter().
 */
function mymodule_form_alter(&$form, $form_state, $form_id) {
  // ...
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.module',
      src,
    );
    const hookRef = references.find(
      (r) => r.referenceName === 'hook_form_alter',
    );
    expect(hookRef).toBeDefined();
    expect(hookRef!.referenceKind).toBe('references');
  });

  it('detects hook implementation via name pattern (Strategy B)', () => {
    const src = `<?php

function mymodule_views_data() {
  return [];
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.module',
      src,
    );
    const hookRef = references.find(
      (r) => r.referenceName === 'hook_views_data',
    );
    expect(hookRef).toBeDefined();
  });

  it('does not emit a hook ref for non-hook helper functions', () => {
    // 'other_module_helper' doesn't start with 'mymodule_', so no hook ref
    const src = `<?php
function other_module_helper() {}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.module',
      src,
    );
    expect(references).toHaveLength(0);
  });

  it('detects hooks in .install files', () => {
    const src = `<?php
/**
 * Implements hook_schema().
 */
function mymodule_schema() {
  return [];
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.install',
      src,
    );
    const hookRef = references.find((r) => r.referenceName === 'hook_schema');
    expect(hookRef).toBeDefined();
  });

  it('detects hooks in .theme files', () => {
    const src = `<?php
/**
 * Implements hook_preprocess_node().
 */
function mytheme_preprocess_node(&$variables) {}
`;
    const { references } = drupalResolver.extract!(
      'web/themes/custom/mytheme/mytheme.theme',
      src,
    );
    const hookRef = references.find(
      (r) => r.referenceName === 'hook_preprocess_node',
    );
    expect(hookRef).toBeDefined();
  });

  it('does not duplicate refs when both docblock and name pattern match', () => {
    // Strategy A matches first and adds to docblockMatched set;
    // Strategy B skips already-matched functions.
    const src = `<?php
/**
 * Implements hook_form_alter().
 */
function mymodule_form_alter(&$form, $form_state, $form_id) {}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.module',
      src,
    );
    const hookRefs = references.filter(
      (r) => r.referenceName === 'hook_form_alter',
    );
    expect(hookRefs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// resolve()
// ---------------------------------------------------------------------------

describe('drupalResolver.resolve', () => {
  it('resolves a _controller FQCN with ::method to the method node', () => {
    const methodNode = {
      id: 'method:abc123',
      kind: 'method' as const,
      name: 'build',
      qualifiedName: 'MyController::build',
      filePath: 'web/modules/custom/mymodule/src/Controller/MyController.php',
      language: 'php' as const,
      startLine: 10,
      endLine: 20,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const classNode = {
      id: 'class:def456',
      kind: 'class' as const,
      name: 'MyController',
      qualifiedName: 'MyController',
      filePath: 'web/modules/custom/mymodule/src/Controller/MyController.php',
      language: 'php' as const,
      startLine: 5,
      endLine: 30,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'MyController' ? [classNode] : []),
      getNodesInFile: () => [classNode, methodNode],
    });
    const ref = {
      fromNodeId: 'route:x',
      referenceName: '\\Drupal\\mymodule\\Controller\\MyController::build',
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'mymodule.routing.yml',
      language: 'yaml' as const,
    };
    const resolved = drupalResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('method:abc123');
    expect(resolved!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('resolves a _form FQCN (no ::method) to the class node', () => {
    const classNode = {
      id: 'class:form123',
      kind: 'class' as const,
      name: 'SettingsForm',
      qualifiedName: 'SettingsForm',
      filePath: 'web/modules/custom/mymodule/src/Form/SettingsForm.php',
      language: 'php' as const,
      startLine: 1,
      endLine: 50,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'SettingsForm' ? [classNode] : []),
    });
    const ref = {
      fromNodeId: 'route:x',
      referenceName: '\\Drupal\\mymodule\\Form\\SettingsForm',
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'mymodule.routing.yml',
      language: 'yaml' as const,
    };
    const resolved = drupalResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('class:form123');
  });

  it('returns null when the target class cannot be found', () => {
    const ctx = makeContext({ getNodesByName: () => [] });
    const ref = {
      fromNodeId: 'route:x',
      referenceName: '\\Drupal\\mymodule\\Controller\\Missing::method',
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'mymodule.routing.yml',
      language: 'yaml' as const,
    };
    expect(drupalResolver.resolve(ref, ctx)).toBeNull();
  });

  it('resolves a single-colon controller-service ref (Class:method)', () => {
    const methodNode = {
      id: 'method:nojs1',
      kind: 'method' as const,
      name: 'setNoJsCookie',
      qualifiedName: 'BigPipeController::setNoJsCookie',
      filePath: 'core/modules/big_pipe/src/Controller/BigPipeController.php',
      language: 'php' as const,
      startLine: 10,
      endLine: 20,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const classNode = {
      id: 'class:nojs2',
      kind: 'class' as const,
      name: 'BigPipeController',
      qualifiedName: 'BigPipeController',
      filePath: 'core/modules/big_pipe/src/Controller/BigPipeController.php',
      language: 'php' as const,
      startLine: 5,
      endLine: 30,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'BigPipeController' ? [classNode] : []),
      getNodesInFile: () => [classNode, methodNode],
    });
    const ref = {
      fromNodeId: 'route:x',
      referenceName: '\\Drupal\\big_pipe\\Controller\\BigPipeController:setNoJsCookie',
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'big_pipe.routing.yml',
      language: 'yaml' as const,
    };
    const resolved = drupalResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('method:nojs1');
  });
});

// ---------------------------------------------------------------------------
// End-to-end integration test
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Drupal end-to-end — route node linked to controller method', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('creates a route→controller edge from routing.yml to PHP class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drupal-'));

    // Minimal composer.json to trigger Drupal detection
    fs.writeFileSync(
      path.join(tmpDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~10.5' } }),
    );

    // Module directory structure
    const modDir = path.join(tmpDir, 'web', 'modules', 'custom', 'my_module');
    fs.mkdirSync(path.join(modDir, 'src', 'Controller'), { recursive: true });

    // routing.yml
    fs.writeFileSync(
      path.join(modDir, 'my_module.routing.yml'),
      [
        'my_module.hello:',
        "  path: '/hello'",
        '  defaults:',
        "    _controller: '\\Drupal\\my_module\\Controller\\HelloController::build'",
        "    _title: 'Hello'",
        '  requirements:',
        "    _permission: 'access content'",
      ].join('\n') + '\n',
    );

    // PHP controller
    fs.writeFileSync(
      path.join(modDir, 'src', 'Controller', 'HelloController.php'),
      [
        '<?php',
        'namespace Drupal\\my_module\\Controller;',
        'use Drupal\\Core\\Controller\\ControllerBase;',
        'class HelloController extends ControllerBase {',
        '  public function build() {',
        "    return ['#markup' => 'Hello'];",
        '  }',
        '}',
      ].join('\n') + '\n',
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Route node must exist
    const routes = cg.getNodesByKind('route');
    expect(routes.length).toBeGreaterThan(0);
    const route = routes.find((n) => n.name.includes('/hello'));
    expect(route).toBeDefined();

    // Controller method must be indexed
    const methods = cg.getNodesByKind('method');
    const buildMethod = methods.find((n) => n.name === 'build');
    expect(buildMethod).toBeDefined();

    // Edge: route → build method (or class fallback)
    const edges = cg.getOutgoingEdges(route!.id);
    expect(edges.length).toBeGreaterThan(0);

    cg.close();
  });
});

// ---------------------------------------------------------------------------
// #300 — OOP hooks, plugin declarations, services
// ---------------------------------------------------------------------------

const HOOKS_FILE = 'web/modules/custom/m/src/Hook/FormHooks.php';

describe('drupalResolver.extract — OOP #[Hook] attributes (#300)', () => {
  const hookRefs = (file: string, src: string) =>
    drupalResolver
      .extract!(file, src)
      .references.filter((r) => r.referenceName.startsWith('hook_'))
      .map((r) => [r.referenceName, r.fromNodeId]);

  it('links a method-level #[Hook] from the method node (id hashed from the attribute line)', () => {
    const src = `<?php
namespace Drupal\\m\\Hook;

use Drupal\\Core\\Hook\\Attribute\\Hook;

class EntityHooks {
  /**
   * Docblocks sit outside the node; the attribute starts it.
   */
  #[Hook('entity_presave')]
  public function entityPresave($entity): void {}
}
`;
    expect(hookRefs(HOOKS_FILE, src)).toEqual([
      ['hook_entity_presave', generateNodeId(HOOKS_FILE, 'method', 'entityPresave', 10)],
    ]);
  });

  it('emits every hook of stacked, grouped, and named-argument attributes', () => {
    const src = `<?php
class CommentHooks {
  #[Hook('comment_insert')]
  #[Hook('comment_update')]
  public function commentSave($c): void {}

  #[Hook('node_insert'), \\Drupal\\Core\\Hook\\Attribute\\Hook(hook: 'node_update', order: Order::First)]
  public static function nodeSave($n): void {}
}
`;
    expect(hookRefs(HOOKS_FILE, src)).toEqual([
      ['hook_comment_insert', generateNodeId(HOOKS_FILE, 'method', 'commentSave', 3)],
      ['hook_comment_update', generateNodeId(HOOKS_FILE, 'method', 'commentSave', 3)],
      ['hook_node_insert', generateNodeId(HOOKS_FILE, 'method', 'nodeSave', 7)],
      ['hook_node_update', generateNodeId(HOOKS_FILE, 'method', 'nodeSave', 7)],
    ]);
  });

  it('links a class-level #[Hook] to its method: target, or to __invoke', () => {
    const src = `<?php
#[Hook('form_alter', method: 'formAlter')]
#[Hook('cron')]
final class MixedHooks {
  public function helper() {}

  public function formAlter(array &$form): void {}

  public function __invoke(): void {}
}
`;
    expect(hookRefs(HOOKS_FILE, src)).toEqual([
      ['hook_form_alter', generateNodeId(HOOKS_FILE, 'method', 'formAlter', 7)],
      ['hook_cron', generateNodeId(HOOKS_FILE, 'method', '__invoke', 9)],
    ]);
  });

  it('ignores #[Hook] text inside strings and comments, and non-Hook attributes', () => {
    const src = `<?php
class NotHooks {
  // #[Hook('commented')]
  public function a() { return "#[Hook('in_string')]"; }

  #[Deprecated]
  public function b() {}
}
`;
    expect(hookRefs(HOOKS_FILE, src)).toEqual([]);
  });

  it('a class-level #[Hook] whose method is missing emits nothing', () => {
    const src = `<?php
#[Hook('cron', method: 'missing')]
class Broken {
  public function other() {}
}
`;
    expect(hookRefs(HOOKS_FILE, src)).toEqual([]);
  });
});

describe('drupalResolver.extract — plugin declarations (#300)', () => {
  const FILE = 'web/modules/custom/m/src/Plugin/Block/MyBlock.php';
  const decorates = (src: string) =>
    drupalResolver
      .extract!(FILE, src)
      .references.filter((r) => r.referenceKind === 'decorates')
      .map((r) => [r.referenceName, r.fromNodeId]);

  it('a multi-line PHP 8 plugin attribute decorates the class', () => {
    const src = `<?php
namespace Drupal\\m\\Plugin\\Block;

use Drupal\\Core\\Block\\Attribute\\Block;

#[Block(
  id: 'my_block',
  admin_label: new TranslatableMarkup('My block'),
)]
class MyBlock extends BlockBase {}
`;
    expect(decorates(src)).toEqual([['Block', generateNodeId(FILE, 'class', 'MyBlock', 6)]]);
  });

  it('a docblock annotation decorates the class (node starts at the class line)', () => {
    const src = `<?php
use Drupal\\Core\\Block\\Annotation\\Block;

/**
 * @Block(
 *   id = "old_block",
 *   admin_label = @Translation("Old block")
 * )
 */
final class OldBlock extends BlockBase {}
`;
    expect(decorates(src)).toEqual([['Block', generateNodeId(FILE, 'class', 'OldBlock', 10)]]);
  });

  it('recognises a contrib plugin type by its id argument, in either style', () => {
    const attr = `<?php
#[CommerceCheckoutPane(id: 'review', label: 'Review')]
class Review {}
`;
    expect(decorates(attr)).toEqual([['CommerceCheckoutPane', generateNodeId(FILE, 'class', 'Review', 2)]]);
    const anno = `<?php
/**
 * @CommerceCheckoutPane(
 *   id = "review",
 * )
 */
class Review {}
`;
    expect(decorates(anno)).toEqual([['CommerceCheckoutPane', generateNodeId(FILE, 'class', 'Review', 7)]]);
  });

  it('does not treat other attributes or docblock tags as plugins', () => {
    const src = `<?php
/**
 * Something.
 *
 * @see Foo()
 * @Translation("x")
 */
#[AsEventListener(event: 'kernel.request')]
#[Hook('cron')]
class NotAPlugin {
  public function __invoke() {}
}
`;
    expect(decorates(src)).toEqual([]);
  });
});

describe('drupalResolver.extract — services.yml (#300)', () => {
  const FILE = 'web/modules/custom/m/m.services.yml';

  it('emits a node per service with a class and an instantiates ref to it, tags in the signature', () => {
    const src = `services:
  m.subscriber:
    class: Drupal\\m\\EventSubscriber\\MySubscriber
    arguments: ['@entity_type.manager']
    tags:
      - { name: event_subscriber }
  m.helper:
    class: '\\Drupal\\m\\Helper'
  m.alias: '@m.helper'
  _defaults:
    autowire: true
  Drupal\\m\\Autowired: ~
  m.inline: { class: Drupal\\m\\Inline, tags: [{ name: event_subscriber }] }
`;
    const { nodes, references } = drupalResolver.extract!(FILE, src);
    expect(nodes.map((n) => [n.kind, n.name, n.startLine, n.signature])).toEqual([
      ['variable', 'm.subscriber', 2, 'class: Drupal\\m\\EventSubscriber\\MySubscriber tags: event_subscriber'],
      ['variable', 'm.helper', 7, 'class: Drupal\\m\\Helper'],
      ['variable', 'm.inline', 13, 'class: Drupal\\m\\Inline tags: event_subscriber'],
    ]);
    expect(references.map((r) => [r.fromNodeId, r.referenceKind, r.referenceName])).toEqual([
      [nodes[0]!.id, 'instantiates', 'Drupal\\m\\EventSubscriber\\MySubscriber'],
      [nodes[1]!.id, 'instantiates', 'Drupal\\m\\Helper'],
      [nodes[2]!.id, 'instantiates', 'Drupal\\m\\Inline'],
    ]);
  });

  it('reads the indentation from the file (4-space services)', () => {
    const src = `parameters:
    foo: bar
services:
    m.four:
        class: Drupal\\m\\Four
        tags:
            -
                name: event_subscriber
`;
    const { nodes } = drupalResolver.extract!(FILE, src);
    expect(nodes.map((n) => [n.name, n.signature])).toEqual([['m.four', 'class: Drupal\\m\\Four tags: event_subscriber']]);
  });
});

describe('drupalResolver.resolve — hook refs (#300)', () => {
  const fn = (id: string, name: string, filePath: string) => ({
    id, kind: 'function' as const, name, qualifiedName: name, filePath, language: 'php' as const,
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0,
  });
  const ref = {
    fromNodeId: 'method:impl', referenceName: 'hook_cron', referenceKind: 'references' as const,
    line: 1, column: 0, filePath: 'm/src/Hook/CronHooks.php', language: 'php' as const,
  };

  it('resolves to the hook definition in *.api.php', () => {
    const ctx = makeContext({
      getNodesByName: (n) => (n === 'hook_cron' ? [fn('f:def', 'hook_cron', 'core/core.api.php')] : []),
    });
    expect(drupalResolver.resolve(ref, ctx)?.targetNodeId).toBe('f:def');
  });

  it('stays unresolved without a definition — never binds to another implementation', () => {
    const ctx = makeContext({
      getNodesByKind: (k) => (k === 'function' ? [fn('f:other', 'other_cron', 'other/other.module')] : []),
    });
    expect(drupalResolver.resolve(ref, ctx)).toBeNull();
  });
});

describe('Drupal end-to-end — OOP hooks, plugins and services (#300)', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('wires hooks to core definitions, plugins to their attribute class, services to their class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drupal-oop-'));
    const files: Record<string, string> = {
      'composer.json': JSON.stringify({ require: { 'drupal/core': '^11' } }),
      'core/core.api.php': '<?php\nfunction hook_cron() {}\nfunction hook_form_alter() {}\n',
      'core/lib/Drupal/Core/Block/Attribute/Block.php': '<?php\nnamespace Drupal\\Core\\Block\\Attribute;\nclass Block {}\n',
      'core/lib/Drupal/Core/Block/Annotation/Block.php': '<?php\nnamespace Drupal\\Core\\Block\\Annotation;\nclass Block {}\n',
      'm/m.services.yml':
        'services:\n  m.subscriber:\n    class: Drupal\\m\\EventSubscriber\\MySubscriber\n    tags:\n      - { name: event_subscriber }\n',
      'm/src/EventSubscriber/MySubscriber.php':
        '<?php\nnamespace Drupal\\m\\EventSubscriber;\nclass MySubscriber {\n  public static function getSubscribedEvents() { return []; }\n}\n',
      'm/src/Hook/MHooks.php':
        "<?php\nnamespace Drupal\\m\\Hook;\nuse Drupal\\Core\\Hook\\Attribute\\Hook;\n\n#[Hook('form_alter', method: 'formAlter')]\nclass MHooks {\n  public function formAlter(array &$form): void {}\n\n  #[Hook('cron')]\n  public function cron(): void {}\n}\n",
      'm/src/Plugin/Block/NewBlock.php':
        "<?php\nnamespace Drupal\\m\\Plugin\\Block;\nuse Drupal\\Core\\Block\\Attribute\\Block;\n\n#[Block(\n  id: 'new_block',\n)]\nclass NewBlock {}\n",
      'm/src/Plugin/Block/OldBlock.php':
        '<?php\nnamespace Drupal\\m\\Plugin\\Block;\nuse Drupal\\Core\\Block\\Annotation\\Block;\n\n/**\n * @Block(\n *   id = "old_block",\n * )\n */\nclass OldBlock {}\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    try {
      const byName = (kind: string, name: string, file?: string) =>
        cg.getNodesByKind(kind as never).find((n) => n.name === name && (!file || n.filePath.includes(file)))!;
      const targetsOf = (id: string, kind: string) =>
        cg.getOutgoingEdges(id).filter((e) => e.kind === kind).map((e) => e.target);

      expect(targetsOf(byName('method', 'formAlter').id, 'references')).toEqual([byName('function', 'hook_form_alter').id]);
      expect(targetsOf(byName('method', 'cron').id, 'references')).toEqual([byName('function', 'hook_cron').id]);
      expect(targetsOf(byName('class', 'NewBlock').id, 'decorates')).toEqual([byName('class', 'Block', 'Attribute').id]);
      expect(targetsOf(byName('class', 'OldBlock').id, 'decorates')).toEqual([byName('class', 'Block', 'Annotation').id]);
      expect(targetsOf(byName('variable', 'm.subscriber').id, 'instantiates')).toEqual([byName('class', 'MySubscriber').id]);
    } finally {
      cg.close();
    }
  });
});
