/**
 * Go / Rust resolution gaps reported as issues:
 *  - #2322 Go: cross-package calls when `go.mod` lives in a subdirectory, or the
 *    root module has sibling modules whose paths aren't under it.
 *  - #2323 Go: `s.field.Method()` when the receiver type is unexported.
 *  - #2326 Rust/Axum: a rustfmt-wrapped `.route(` call links its handler.
 *  - #2328 Rust: enum variant paths (`Mode::A`, match arms) reference the enum.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
const graphs: CodeGraph[] = [];

afterEach(() => {
  for (const g of graphs.splice(0)) g.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-phase4-gorust-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const cg = await CodeGraph.init(root, { index: true });
  graphs.push(cg);
  return cg;
}

/** Names of the nodes with a non-`contains` edge into a node named `name` (of `kind`). */
function callersOf(cg: CodeGraph, name: string, kind?: string): string[] {
  const ids = cg.searchNodes(name, { limit: 50 })
    .map((r) => r.node)
    .filter((n) => n.name === name && (!kind || n.kind === kind))
    .map((n) => n.id);
  return [...new Set(cg.getIncomingEdgesTo(ids)
    .filter((e) => e.kind !== 'contains')
    .map((e) => cg.getNode(e.source)!.name))].sort();
}

const STORE_GO = `package store

type Manager struct{}

func New() *Manager { return &Manager{} }

func (m *Manager) CreateItem(name string) error { return nil }
`;
const serviceGo = (mod: string) => `package domain

import "${mod}/internal/store"

type Service struct {
	db *store.Manager
}

func NewService() *Service {
	return &Service{db: store.New()}
}

func (s *Service) AddItem(name string) error {
	return s.db.CreateItem(name)
}
`;

describe('#2322 Go module in a subdirectory', () => {
  it('resolves package-qualified and field-chain calls under svc/go.mod', async () => {
    const cg = await index({
      'svc/go.mod': 'module example.com/app/svc\n\ngo 1.22\n',
      'svc/internal/store/store.go': STORE_GO,
      'svc/internal/domain/service.go': serviceGo('example.com/app/svc'),
      'web/package.json': '{"name":"web"}\n',
    });
    expect(callersOf(cg, 'New', 'function')).toEqual(['NewService']);
    expect(callersOf(cg, 'CreateItem', 'method')).toEqual(['AddItem']);
  });

  it('resolves a root module importing a sibling module (longest module path wins)', async () => {
    const cg = await index({
      'go.mod': 'module example.com/etcd/v3\n\ngo 1.22\n',
      'server/go.mod': 'module example.com/etcd/server/v3\n\ngo 1.22\n',
      'server/storage/wal/wal.go': `package wal

func OpenForRead(dir string) error { return nil }
`,
      'etcdutl/cmd.go': `package etcdutl

import "example.com/etcd/server/v3/storage/wal"

func Run() error {
	return wal.OpenForRead("x")
}
`,
    });
    expect(callersOf(cg, 'OpenForRead', 'function')).toEqual(['Run']);
  });
});

describe('#2323 Go field chain through an unexported receiver type', () => {
  it('resolves s.service.AddItem() inside func (s *server)', async () => {
    const cg = await index({
      'go.mod': 'module example.com/app\n\ngo 1.22\n',
      'internal/domain/service.go': `package domain

type Service struct{}

func (s *Service) AddItem(name string) error { return nil }
`,
      'internal/handlers/server.go': `package handlers

import "example.com/app/internal/domain"

type server struct {
	service *domain.Service
}

func (s *server) Create(name string) error {
	return s.service.AddItem(name)
}
`,
    });
    expect(callersOf(cg, 'AddItem', 'method')).toEqual(['Create']);
  });
});

describe('#2326 Axum wrapped .route(', () => {
  it('links the handler of a rustfmt-wrapped route like a one-line one', async () => {
    const cg = await index({
      'Cargo.toml': '[package]\nname = "repro"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/handlers/mod.rs': 'pub async fn single_line_handler() {}\npub async fn multi_line_handler() {}\n',
      'src/main.rs': `mod handlers;
use axum::{routing::get, Router};

pub fn app() -> Router {
    Router::new()
        .route("/single", get(handlers::single_line_handler))
        .route(
            "/multi",
            get(handlers::multi_line_handler),
        )
}
`,
    });
    expect(callersOf(cg, 'single_line_handler', 'function')).toEqual(['GET /single']);
    expect(callersOf(cg, 'multi_line_handler', 'function')).toEqual(['GET /multi']);
  });
});

describe('#2328 Rust enum variant paths', () => {
  it('records a reference to the enum from variant expressions and match arms', async () => {
    const cg = await index({
      'Cargo.toml': '[package]\nname = "repro"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/mode.rs': `pub enum Mode {
    A,
    B,
}

pub fn takes(_m: Mode) {}
`,
      'src/variant_use.rs': `use crate::mode;

pub fn code(flag: bool) -> u8 {
    let m = if flag { mode::Mode::A } else { mode::Mode::B };
    match m {
        mode::Mode::A => 1,
        mode::Mode::B => 2,
    }
}
`,
      'src/main.rs': `mod mode;
mod variant_use;

fn main() {
    mode::takes(mode::Mode::A);
    let _ = variant_use::code(true);
}
`,
      'src/local.rs': `pub enum Color { Red, Green }

pub fn pick(c: &Color) -> u8 {
    match c {
        Color::Red => 1,
        Color::Green => 2,
    }
}

pub fn make() -> u8 { if let Color::Green = Color::Red { 1 } else { 0 } }
`,
    });
    expect(callersOf(cg, 'Mode', 'enum')).toEqual(expect.arrayContaining(['code', 'main', 'takes']));
    expect(callersOf(cg, 'Color', 'enum')).toEqual(expect.arrayContaining(['make', 'pick']));
    // The variant itself is referenced too.
    expect(callersOf(cg, 'A', 'enum_member')).toEqual(['code', 'main']);
    expect(callersOf(cg, 'B', 'enum_member')).toEqual(['code']);
    expect(callersOf(cg, 'Red', 'enum_member')).toEqual(['make', 'pick']);
  });

  it('does not link a variant path of an enum the project does not define', async () => {
    const cg = await index({
      'Cargo.toml': '[package]\nname = "repro"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/lib.rs': `use std::cmp::Ordering;

pub enum Less { X }

pub fn cmp(a: u8, b: u8) -> u8 {
    match a.cmp(&b) {
        Ordering::Less => 1,
        _ => 0,
    }
}
`,
    });
    expect(callersOf(cg, 'Less', 'enum')).toEqual([]);
  });
});
