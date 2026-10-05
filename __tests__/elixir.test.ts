/**
 * Elixir support (#1219): extraction of modules / multi-clause functions /
 * macros / protocols / structs / ExUnit tests, and alias-aware resolution of
 * remote, local, imported and `__MODULE__` calls.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, isLanguageSupported, getSupportedLanguages, initGrammars, loadAllGrammars, isSourceFile } from '../src/extraction/grammars';
import type { Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const ACCOUNTS = `defmodule MyApp.Accounts do
  @moduledoc "Accounts context"
  alias MyApp.Repo
  alias MyApp.Accounts.{User, Token}
  alias MyApp.Mailer, as: M
  import Ecto.Query, only: [from: 2]
  require Logger
  use GenServer

  @doc "Fetch a user"
  @spec get_user(integer()) :: User.t() | nil
  def get_user(id) when is_integer(id) do
    Repo.get(User, id)
  end

  def get_user(_), do: nil

  defp normalize(email), do: String.downcase(email)

  def create(attrs) do
    email = normalize(attrs.email)
    Logger.info("creating")
    %User{email: email} |> Repo.insert()
    attrs |> Token.build()
    M.deliver(email)
    __MODULE__.get_user(1)
    Enum.map([1], &normalize/1)
  end

  defmacro my_macro(x) do
    quote do: unquote(x)
  end

  defguard is_ok(x) when x == :ok

  defdelegate fetch(id), to: Repo, as: :get

  defstruct [:name, email: nil]

  defmodule Inner do
    def hello, do: :world
  end

  def call_inner, do: Inner.hello()
end

defprotocol Size do
  def size(data)
end

defimpl Size, for: BitString do
  def size(string), do: byte_size(string)
end
`;

describe('Elixir language detection', () => {
  it('maps .ex and .exs to elixir', () => {
    expect(detectLanguage('lib/my_app/accounts.ex')).toBe('elixir');
    expect(detectLanguage('test/accounts_test.exs')).toBe('elixir');
    expect(detectLanguage('mix.exs')).toBe('elixir');
    expect(isSourceFile('lib/a.ex')).toBe(true);
    expect(isLanguageSupported('elixir')).toBe(true);
    expect(getSupportedLanguages()).toContain('elixir');
  });
});

describe('Elixir extraction', () => {
  const result = () => extractFromSource('lib/my_app/accounts.ex', ACCOUNTS);
  const byQn = (nodes: Node[], qn: string) => nodes.find((n) => n.qualifiedName === qn);

  it('extracts modules with full dotted names, including nested ones', () => {
    const { nodes } = result();
    const mod = byQn(nodes, 'MyApp.Accounts');
    expect(mod?.kind).toBe('module');
    expect(mod?.docstring).toBe('Accounts context');
    expect(byQn(nodes, 'MyApp.Accounts.Inner')?.kind).toBe('module');
    expect(byQn(nodes, 'MyApp.Accounts.Inner::hello')?.kind).toBe('function');
  });

  it('merges multi-clause functions into one node with @spec/@doc attached', () => {
    const { nodes } = result();
    const getUser = nodes.filter((n) => n.qualifiedName === 'MyApp.Accounts::get_user');
    expect(getUser).toHaveLength(1);
    expect(getUser[0]!.startLine).toBe(12);
    expect(getUser[0]!.endLine).toBe(16);
    expect(getUser[0]!.signature).toContain('@spec get_user(integer())');
    expect(getUser[0]!.docstring).toBe('Fetch a user');
    expect(getUser[0]!.isExported).toBe(true);
  });

  it('marks defp private and records macro kinds', () => {
    const { nodes } = result();
    expect(byQn(nodes, 'MyApp.Accounts::normalize')?.visibility).toBe('private');
    expect(byQn(nodes, 'MyApp.Accounts::normalize')?.isExported).toBe(false);
    expect(byQn(nodes, 'MyApp.Accounts::my_macro')?.decorators).toEqual(['defmacro']);
    expect(byQn(nodes, 'MyApp.Accounts::is_ok')?.decorators).toEqual(['defguard']);
    expect(byQn(nodes, 'MyApp.Accounts::fetch')?.decorators).toEqual(['defdelegate']);
  });

  it('extracts struct fields, protocols and impls', () => {
    const { nodes } = result();
    expect(byQn(nodes, 'MyApp.Accounts::name')?.kind).toBe('field');
    expect(byQn(nodes, 'MyApp.Accounts::email')?.kind).toBe('field');
    expect(byQn(nodes, 'Size')?.kind).toBe('protocol');
    expect(byQn(nodes, 'Size::size')?.kind).toBe('function');
    expect(byQn(nodes, 'Size.BitString')?.kind).toBe('module');
  });

  it('emits alias-expanded remote calls, local calls and captures', () => {
    const { unresolvedReferences: refs } = result();
    const calls = refs.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
    expect(calls).toContain('MyApp.Repo::get');
    expect(calls).toContain('MyApp.Repo::insert');
    expect(calls).toContain('MyApp.Accounts.Token::build');
    expect(calls).toContain('MyApp.Mailer::deliver'); // alias … as: M
    expect(calls).toContain('MyApp.Accounts::get_user'); // __MODULE__.get_user
    expect(calls).toContain('MyApp.Accounts.Inner::hello'); // implicit nested-module alias
    expect(calls).toContain('normalize');
    expect(calls).toContain('MyApp.Repo::get'); // defdelegate … to: Repo, as: :get
    // Kernel special forms and declaration macros never become calls.
    for (const noise of ['def', 'defp', 'alias', 'quote', 'unquote', 'is_integer', 'defstruct']) {
      expect(calls).not.toContain(noise);
    }
    // @spec type positions are not calls.
    expect(calls).not.toContain('User::t');
    const refsTo = refs.filter((r) => r.referenceKind === 'references').map((r) => r.referenceName);
    expect(refsTo).toContain('MyApp.Accounts.User'); // %User{}
    expect(refsTo).toContain('normalize'); // &normalize/1
  });

  it('emits directives as imports / implements', () => {
    const { unresolvedReferences: refs } = result();
    const imports = refs.filter((r) => r.referenceKind === 'imports').map((r) => r.referenceName);
    expect(imports).toEqual(expect.arrayContaining(['MyApp.Repo', 'MyApp.Accounts.User', 'MyApp.Accounts.Token', 'MyApp.Mailer', 'Ecto.Query', 'Logger']));
    const impls = refs.filter((r) => r.referenceKind === 'implements').map((r) => r.referenceName);
    expect(impls).toContain('GenServer');
    expect(impls).toContain('Size');
  });

  it('turns ExUnit tests into functions', () => {
    const { nodes, unresolvedReferences: refs } = extractFromSource(
      'test/accounts_test.exs',
      `defmodule MyApp.AccountsTest do
  use ExUnit.Case
  describe "get_user/1" do
    test "returns nil", %{id: id} do
      assert MyApp.Accounts.get_user(id) == nil
    end
  end
end
`,
    );
    const t = nodes.find((n) => n.name === 'test "returns nil"');
    expect(t?.kind).toBe('function');
    expect(t?.qualifiedName).toBe('MyApp.AccountsTest::test "returns nil"');
    expect(refs.find((r) => r.referenceName === 'MyApp.Accounts::get_user')?.fromNodeId).toBe(t?.id);
  });
});

describe('Elixir resolution', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-elixir-'));
  });
  afterEach(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }

  function calleesOf(qn: string): string[] {
    const node = cg.getNodesByKind('function').find((n) => n.qualifiedName === qn);
    expect(node, qn).toBeDefined();
    return cg
      .getOutgoingEdges(node!.id)
      .filter((e) => e.kind === 'calls' || e.kind === 'references')
      .map((e) => cg.getNode(e.target)?.qualifiedName ?? '?')
      .sort();
  }

  it('resolves remote, aliased, local, imported and __MODULE__ calls — and nothing by bare name', async () => {
    write('lib/my_app/accounts.ex', ACCOUNTS);
    write(
      'lib/my_app/repo.ex',
      `defmodule MyApp.Repo do
  def get(schema, id), do: {schema, id}
  def insert(struct), do: {:ok, struct}
end

defmodule MyApp.Accounts.User do
  defstruct [:email]
end

defmodule MyApp.Accounts.Token do
  import MyApp.Helpers
  def build(attrs), do: helper(attrs)
end

defmodule MyApp.Helpers do
  def helper(x), do: x
end

defmodule MyApp.Other do
  # Same name as MyApp.Accounts.normalize/1 — must never be picked for a
  # bare call from another module.
  def normalize(x), do: x
  def info(x), do: x
end
`,
    );
    cg = await CodeGraph.init(dir, { index: true });
    cg.resolveReferences();

    expect(calleesOf('MyApp.Accounts::get_user')).toEqual(['MyApp.Repo::get']);
    const create = calleesOf('MyApp.Accounts::create');
    expect(create).toEqual(expect.arrayContaining([
      'MyApp.Accounts::normalize',
      'MyApp.Repo::insert',
      'MyApp.Accounts.Token::build',
      'MyApp.Accounts::get_user',
      'MyApp.Accounts.User',
    ]));
    expect(create).not.toContain('MyApp.Other::normalize');
    // Logger.info (external) does not land on MyApp.Other.info.
    expect(create).not.toContain('MyApp.Other::info');
    expect(calleesOf('MyApp.Accounts.Token::build')).toEqual(['MyApp.Helpers::helper']);
    expect(calleesOf('MyApp.Accounts::call_inner')).toEqual(['MyApp.Accounts.Inner::hello']);
    expect(calleesOf('MyApp.Accounts::fetch')).toEqual(['MyApp.Repo::get']);

    // defimpl → implements the protocol
    const impl = cg.getNodesByKind('module').find((n) => n.qualifiedName === 'Size.BitString')!;
    const implTargets = cg.getOutgoingEdges(impl.id).filter((e) => e.kind === 'implements').map((e) => cg.getNode(e.target)?.qualifiedName);
    expect(implTargets).toEqual(['Size']);

    // alias directives link modules
    const accounts = cg.getNodesByKind('module').find((n) => n.qualifiedName === 'MyApp.Accounts')!;
    const imported = cg.getOutgoingEdges(accounts.id).filter((e) => e.kind === 'imports').map((e) => cg.getNode(e.target)?.qualifiedName).sort();
    expect(imported).toEqual(['MyApp.Accounts.Token', 'MyApp.Accounts.User', 'MyApp.Repo']);
  });
});
