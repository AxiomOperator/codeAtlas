/**
 * Zig support (#1060): extraction of functions / containers / methods /
 * fields / tests / `@import`s, and binding-rooted resolution of calls —
 * through imports, `@This()` aliases, typed receivers and re-exports.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, isLanguageSupported, getSupportedLanguages, initGrammars, loadAllGrammars, isSourceFile } from '../src/extraction/grammars';
import { extractZigImports } from '../src/resolution/zig';
import type { Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const MAIN = `const std = @import("std");
const mem = std.mem;
const log = std.log.scoped(.main);
const Server = @import("net/Server.zig");
const util = @import("util.zig");
const Handler = Server.Handler;

/// A growable list.
pub fn List(comptime T: type) type {
    return struct {
        const Self = @This();
        items: []T,

        pub fn append(self: *Self, item: T) !void {
            try self.ensure(1);
            _ = item;
        }

        fn ensure(self: *Self, n: usize) !void {
            _ = self;
            _ = n;
        }
    };
}

pub const Error = error{ OutOfMemory, Invalid };

pub const Color = enum(u8) { red, green, _ };

const Empty = struct {};

pub const Thing = struct {
    const Self = @This();
    count: u32 = 0,

    pub fn bump(self: *Thing) void {
        self.count += 1;
        self.helper();
        Self.static();
    }

    fn helper(self: *const Self) void {
        _ = self;
    }

    fn static() void {}
};

pub var global_counter: u32 = 0;
const LIMIT: usize = 10;

pub fn run(srv: *Server) !void {
    var t = Thing{};
    t.bump();
    srv.start();
    const s = Server.init();
    _ = s;
    _ = util.double(2);
    _ = @import("util.zig").double(3);
    Handler.handle();
    var list = List(u8){ .items = &.{} };
    try list.append(1);
    _ = mem.eql(u8, "a", "b");
    log.info("x", .{});
    cleanup();
}

fn cleanup() void {}

test "run works" {
    try run(undefined);
}
`;

const SERVER = `const Server = @This();
const std = @import("std");

port: u16,

pub const Handler = struct {
    pub fn handle() void {}
};

pub fn init() Server {
    return .{ .port = 80 };
}

pub fn start(self: *Server) void {
    self.listen();
}

fn listen(self: *Server) void {
    _ = self;
}
`;

describe('Zig language detection', () => {
  it('maps .zig to zig', () => {
    expect(detectLanguage('src/main.zig')).toBe('zig');
    expect(detectLanguage('build.zig')).toBe('zig');
    expect(isSourceFile('src/main.zig')).toBe(true);
    expect(isLanguageSupported('zig')).toBe(true);
    expect(getSupportedLanguages()).toContain('zig');
  });
});

describe('Zig extraction', () => {
  const result = () => extractFromSource('src/main.zig', MAIN);
  const byQn = (nodes: Node[], qn: string) => nodes.filter((n) => n.qualifiedName === qn);

  it('extracts functions, containers, methods, fields and enum members', () => {
    const { nodes } = result();
    expect(byQn(nodes, 'run')[0]?.kind).toBe('function');
    expect(byQn(nodes, 'run')[0]?.isExported).toBe(true);
    expect(byQn(nodes, 'cleanup')[0]?.visibility).toBe('private');
    expect(byQn(nodes, 'Thing')[0]?.kind).toBe('struct');
    expect(byQn(nodes, 'Thing::bump')[0]?.kind).toBe('method');
    expect(byQn(nodes, 'Thing::count')[0]?.kind).toBe('field');
    expect(byQn(nodes, 'Color')[0]?.kind).toBe('enum');
    expect(byQn(nodes, 'Color::red')[0]?.kind).toBe('enum_member');
    expect(byQn(nodes, 'Color::_')).toHaveLength(0);
    expect(byQn(nodes, 'Error::OutOfMemory')[0]?.kind).toBe('enum_member');
    expect(byQn(nodes, 'global_counter')[0]?.kind).toBe('variable');
    expect(byQn(nodes, 'LIMIT')[0]?.kind).toBe('constant');
    expect(byQn(nodes, 'test "run works"')[0]?.kind).toBe('function');
  });

  it('indexes a generic type function and the container it returns', () => {
    const { nodes } = result();
    const list = byQn(nodes, 'List');
    expect(list.map((n) => n.kind).sort()).toEqual(['function', 'struct']);
    expect(list.find((n) => n.kind === 'function')?.docstring).toBe('A growable list.');
    expect(byQn(nodes, 'List::append')[0]?.kind).toBe('method');
    expect(byQn(nodes, 'List::items')[0]?.kind).toBe('field');
  });

  it('keeps an empty container free of the grammar\'s MISSING field', () => {
    const { nodes } = result();
    expect(byQn(nodes, 'Empty')[0]?.kind).toBe('struct');
    expect(nodes.filter((n) => n.qualifiedName.startsWith('Empty::'))).toHaveLength(0);
  });

  it('makes @import a file import and keeps std/aliases out of the symbol table', () => {
    const { nodes, unresolvedReferences: refs } = result();
    const imports = nodes.filter((n) => n.kind === 'import').map((n) => n.name).sort();
    expect(imports).toEqual(['net/Server.zig', 'util.zig']);
    expect(refs.filter((r) => r.referenceKind === 'imports').map((r) => r.referenceName).sort()).toEqual(['net/Server.zig', 'util.zig']);
    for (const binding of ['std', 'mem', 'log', 'Server', 'util', 'Handler', 'Self']) {
      expect(nodes.find((n) => n.name === binding && n.kind !== 'file'), binding).toBeUndefined();
    }
  });

  it('rewrites receivers to types and drops std calls', () => {
    const { unresolvedReferences: refs } = result();
    const calls = refs.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
    expect(calls).toEqual(expect.arrayContaining([
      'Thing.bump', // var t = Thing{}
      'Server.start', // srv: *Server
      'Server.init',
      'util.double',
      '@import(util.zig).double',
      'Handler.handle',
      'List.append', // var list = List(u8){…}
      'List.ensure', // self: *Self inside the returned struct
      'Thing.helper', // self: *Thing
      'Thing.static', // Self = @This()
      'cleanup',
      'run',
    ]));
    expect(calls.some((c) => c.startsWith('mem.') || c.startsWith('std.') || c.startsWith('log.'))).toBe(false);
    const inst = refs.filter((r) => r.referenceKind === 'instantiates').map((r) => r.referenceName);
    expect(inst).toContain('Thing');
  });
});

describe('Zig import bindings', () => {
  it('parses @import bindings and aliases rooted in them', () => {
    const m = extractZigImports(`const std = @import("std");
const mem = std.mem;
pub const Server = @import("net/Server.zig");
const Handler = Server.Handler;
const offsets = @import("lsp").offsets;
`);
    const by = Object.fromEntries(m.map((x) => [x.localName, `${x.source}|${x.exportedName}`]));
    expect(by).toEqual({
      std: 'std|',
      mem: 'std|mem',
      Server: 'net/Server.zig|',
      Handler: 'net/Server.zig|Handler',
      offsets: 'lsp|offsets',
    });
  });
});

describe('Zig resolution', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-'));
  });
  afterEach(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }

  function edgesFrom(qn: string, file: string, kinds: string[]): string[] {
    const node = cg.getNodesInFile(file).find((n) => n.qualifiedName === qn && n.kind !== 'struct');
    expect(node, qn).toBeDefined();
    return cg
      .getOutgoingEdges(node!.id)
      .filter((e) => kinds.includes(e.kind))
      .map((e) => {
        const t = cg.getNode(e.target)!;
        return `${t.qualifiedName}@${t.filePath}`;
      })
      .sort();
  }

  it('resolves through imports, @This aliases, typed receivers and generic containers', async () => {
    write('src/main.zig', MAIN);
    write('src/net/Server.zig', SERVER);
    write('src/util.zig', 'pub fn double(a: u32) u32 {\n    return a * 2;\n}\n');
    // Same-named decoys elsewhere: a Zig call never binds by bare name.
    write('src/decoy.zig', 'pub fn cleanup() void {}\npub fn start() void {}\npub fn append() void {}\n');
    cg = await CodeGraph.init(dir, { index: true });
    cg.resolveReferences();

    expect(edgesFrom('run', 'src/main.zig', ['calls'])).toEqual([
      'Handler::handle@src/net/Server.zig',
      'List::append@src/main.zig',
      'List@src/main.zig', // `List(u8){…}` calls the generic type function
      'Thing::bump@src/main.zig',
      'cleanup@src/main.zig',
      'double@src/util.zig',
      'double@src/util.zig',
      'init@src/net/Server.zig',
      'start@src/net/Server.zig',
    ]);
    expect(edgesFrom('run', 'src/main.zig', ['instantiates'])).toEqual(['Thing@src/main.zig']);
    expect(edgesFrom('Thing::bump', 'src/main.zig', ['calls'])).toEqual(['Thing::helper@src/main.zig', 'Thing::static@src/main.zig']);
    expect(edgesFrom('List::append', 'src/main.zig', ['calls'])).toEqual(['List::ensure@src/main.zig']);
    expect(edgesFrom('start', 'src/net/Server.zig', ['calls'])).toEqual(['listen@src/net/Server.zig']);
    expect(edgesFrom('test "run works"', 'src/main.zig', ['calls'])).toEqual(['run@src/main.zig']);

    // `@import` → file → file edge
    const mainFile = cg.getNodesInFile('src/main.zig').find((n) => n.kind === 'file')!;
    const imported = cg.getOutgoingEdges(mainFile.id).filter((e) => e.kind === 'imports').map((e) => cg.getNode(e.target)?.filePath).sort();
    expect(imported).toEqual(['src/net/Server.zig', 'src/util.zig']);
  });

  it('follows pub re-exports and named build modules to their root file', async () => {
    write('src/root.zig', 'pub const net = @import("net.zig");\npub const ping = net.ping;\n');
    write('src/net.zig', 'pub fn ping() void {}\npub fn pong() void {}\n');
    write('tests/net_test.zig', `const lib = @import("root_lib");
const net = lib.net;
test "ping" {
    lib.ping();
    net.pong();
}
`);
    // `@import("root_lib")` is registered in build.zig; by convention its root is `root_lib.zig`.
    write('src/root_lib.zig', 'pub const net = @import("net.zig");\npub const ping = net.ping;\n');
    cg = await CodeGraph.init(dir, { index: true });
    cg.resolveReferences();
    expect(edgesFrom('test "ping"', 'tests/net_test.zig', ['calls'])).toEqual(['ping@src/net.zig', 'pong@src/net.zig']);
  });
});
