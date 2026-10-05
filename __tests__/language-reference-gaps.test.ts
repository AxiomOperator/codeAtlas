/**
 * Reference gaps closed per language:
 * - Dart type positions with no reference (#2327): extension `on` type, field
 *   types, generic arguments in expressions and top-level initializers.
 * - Dart getter reads and enum-extension members with no callers (#2338).
 * - VB.NET Shared field / property access through the class name (#2305).
 * - C++ infix / subscript operator overloads (#1258).
 * - Lua custom module loaders declared in codegraph.json (#1617).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { clearProjectConfigCache } from '../src/project-config';

let tempDir: string;
let cg: CodeGraph | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-lang-gaps-'));
});

afterEach(() => {
  cg?.destroy();
  cg = undefined;
  clearProjectConfigCache();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 });
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(tempDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  return cg;
}

/** Names of the symbols with an edge of `kinds` into any node named `qualifiedName`. */
function sourcesInto(qualifiedName: string, kinds: string[]): string[] {
  const targets = cg!.searchNodes(qualifiedName.split('::').pop()!, { limit: 100 })
    .map((r) => r.node)
    .filter((n) => n.qualifiedName === qualifiedName && n.kind !== 'import');
  if (targets.length === 0) throw new Error(`no node ${qualifiedName}`);
  const names = targets
    .flatMap((t) => cg!.getIncomingEdges(t.id))
    .filter((e) => kinds.includes(e.kind))
    .map((e) => cg!.getNode(e.source)?.name)
    .filter((n): n is string => !!n);
  return [...new Set(names)].sort();
}

describe('Dart type positions (#2327)', () => {
  it('references a type from an extension `on`, a field, and generic arguments', async () => {
    await index({
      'pubspec.yaml': 'name: repro\n',
      'lib/report.dart': 'class Report {\n  final int score;\n  const Report(this.score);\n}\n',
      'lib/a_parameter.dart': "import 'report.dart';\n\nint score(Report r) => r.score;\n",
      'lib/b_return_generic.dart': "import 'report.dart';\n\nFuture<Report?> load() async => null;\n",
      'lib/c_extension_on.dart': "import 'report.dart';\n\nextension ReportX on Report {\n  bool get high => score > 5;\n}\n",
      'lib/d_field_type.dart': "import 'report.dart';\n\nclass Holder {\n  final Report report;\n  const Holder(this.report);\n}\n",
      'lib/e_toplevel_initializer_generic.dart':
        "import 'report.dart';\n\nclass Family<T, A> {\n  const Family();\n}\n\nfinal reportProvider = Family<Report?, String>();\n",
      'lib/f_expression_generic.dart': "import 'report.dart';\n\nvoid run() {\n  Future<Report?>.value(null);\n}\n",
    });
    expect(sourcesInto('Report', ['references'])).toEqual(
      ['Holder', 'ReportX', 'load', 'reportProvider', 'run', 'score'].sort()
    );
  });
});

describe('Dart getter reads and enum extensions (#2338)', () => {
  const shape = `enum Shape { circle, square }

extension ShapeInfo on Shape {
  String get label => name.toUpperCase();
  String shout() => name.toUpperCase();
}

class Box {
  const Box(this.size);
  final int size;
  int get area => size * size;
  int grow() => size + 1;
}

class Crate {
  int get area => 0;
}

extension BoxActions on Box {
  int twice() => size * 2;
}
`;
  const use = `import 'shape.dart';

String a(Shape s) => s.label;
String b(Shape s) => s.shout();
int c(Box x) => x.area;
int d(Box x) => x.grow();
int e(Box x) => x.twice();
int f(Box x) {
  final total = x.area + x.size;
  return total;
}
class User {
  int g(Box x) => x.area;
}
int untyped(dynamic x) => x.area;
`;

  it('links getter reads and enum-extension members through the receiver type', async () => {
    await index({ 'pubspec.yaml': 'name: repro\n', 'lib/shape.dart': shape, 'lib/use.dart': use });
    expect(sourcesInto('Box::area', ['calls', 'references'])).toEqual(['c', 'f', 'g']);
    expect(sourcesInto('ShapeInfo::label', ['calls', 'references'])).toEqual(['a']);
    expect(sourcesInto('ShapeInfo::shout', ['calls', 'references'])).toEqual(['b']);
    expect(sourcesInto('Box::grow', ['calls'])).toEqual(['d']);
    expect(sourcesInto('BoxActions::twice', ['calls'])).toEqual(['e']);
    // A getter of the same name on another type, and an untyped receiver, get nothing.
    expect(sourcesInto('Crate::area', ['calls', 'references'])).toEqual([]);
  });
});

describe('VB.NET Shared member access (#2305)', () => {
  it('references Shared fields, Shared properties and the class through its name', async () => {
    await index({
      'AppSession.vb': `Public Class AppSession
    Public Shared SessionId As Guid = Guid.NewGuid()
    Public Shared Property CurrentUser As String
    Public Property Name As String
    Public Shared Function GetGreeting() As String
        Return "Hello " & CurrentUser
    End Function
End Class
`,
      'Other.vb': `Public Class Other
    Public Shared CurrentUser As String
End Class
`,
      'Consumer.vb': `Public Class Consumer
    Public Sub Run()
        Dim id As Guid = AppSession.SessionId
        AppSession.CurrentUser = "demo"
        Console.WriteLine(AppSession.GetGreeting())
    End Sub
End Class
`,
      'Consumer2.vb': `Public Class Consumer2
    Public Function Describe(s As AppSession) As String
        Return AppSession.CurrentUser & AppSession.SessionId.ToString() & s.Name
    End Function
End Class
`,
    });
    expect(sourcesInto('AppSession::SessionId', ['references'])).toEqual(['Describe', 'Run']);
    expect(sourcesInto('AppSession::CurrentUser', ['references'])).toEqual(['Describe', 'Run']);
    expect(sourcesInto('AppSession::Name', ['references'])).toEqual(['Describe']);
    expect(sourcesInto('AppSession', ['references'])).toEqual(['Describe', 'Run']);
    expect(sourcesInto('AppSession::GetGreeting', ['calls'])).toEqual(['Run']);
    expect(sourcesInto('Other::CurrentUser', ['references'])).toEqual([]);
  });
});

describe('C++ infix and subscript operator overloads (#1258)', () => {
  it('links `a + b` / `a[i]` to the left operand type\'s operator, and nothing else', async () => {
    await index({
      'v.hpp': `#pragma once
struct Aaa {
  Aaa operator+(const Aaa& o) const { return o; }
  Aaa operator[](int i) const { return *this; }
};
struct V {
  int x;
  V operator+(const V& o) const;
  V operator[](int i) const { return V{x + i}; }
  V operator-() const { return V{-x}; }
  bool operator==(const V& o) const { return x == o.x; }
  int get() const { return x; }
};
struct W : V {};
struct Holder {
  V v;
  V twice() const { return v + v; }
};
`,
      'v.cpp': `#include "v.hpp"
V V::operator+(const V& o) const { return V{x + o.x}; }
`,
      'app.cpp': `#include "v.hpp"
int plainCaller(const V& a) { return a.get(); }
V infixCaller(const V& a, const V& b) { return a + b; }
V subscriptCaller(const V& a) { return a[3]; }
bool eqCaller(V a, V b) { return a == b; }
V inheritedCaller(const W& w, const V& b) { return w + b; }
int pointerArith(V* p) { V* q = p + 1; return q[0].x; }
int ints(int i, int j) { int k[3]; return i + j + k[1]; }
V autoCaller(const V& a) { auto c = a; return c + a; }
V negate(const V& a) { return -a; }
V shadowed(const V& a) { { int a = 1; return V{a + 2}; } }
`,
    });
    expect(sourcesInto('V::operator+', ['calls'])).toEqual(['infixCaller', 'inheritedCaller', 'twice']);
    expect(sourcesInto('V::operator[]', ['calls'])).toEqual(['subscriptCaller']);
    expect(sourcesInto('V::operator==', ['calls'])).toEqual(['eqCaller']);
    expect(sourcesInto('V::operator-', ['calls'])).toEqual([]);
    expect(sourcesInto('V::get', ['calls'])).toEqual(['plainCaller']);
    expect(sourcesInto('Aaa::operator+', ['calls'])).toEqual([]);
    expect(sourcesInto('Aaa::operator[]', ['calls'])).toEqual([]);
  });
});

describe('Lua custom module loaders (#1617)', () => {
  const files = {
    'Script/Activity/ActivityMgrC.lua': 'local M = {}\nfunction M.start() return 1 end\nreturn M\n',
    'Script/Util/strings.lua': 'return {}\n',
    'main.lua': `local Mgr = Require("Script/Activity/ActivityMgrC.lua")
Require "Script.Util.strings"
-- Require("Script/Nope.lua")
local function boot()
  local S = Include('Script/Util/strings')
  return S
end
Mgr.start()
`,
  };

  function importersOf(file: string): string[] {
    const fileNode = cg!.getNodesInFile(file).find((n) => n.kind === 'file')!;
    return cg!
      .getIncomingEdges(fileNode.id)
      .filter((e) => e.kind === 'imports')
      .map((e) => cg!.getNode(e.source)?.name ?? '')
      .sort();
  }

  it('turns configured loader calls into imports edges', async () => {
    await index({ ...files, 'codegraph.json': JSON.stringify({ lua: { loaderFunctions: ['Require', 'Include'] } }) });
    expect(importersOf('Script/Activity/ActivityMgrC.lua')).toEqual(['main.lua']);
    expect(importersOf('Script/Util/strings.lua')).toEqual(['boot', 'main.lua']);
  });

  it('adds nothing without the config', async () => {
    await index(files);
    expect(importersOf('Script/Activity/ActivityMgrC.lua')).toEqual([]);
    expect(importersOf('Script/Util/strings.lua')).toEqual([]);
  });
});
