/**
 * Bash / shell language support (#1068, #1203, #1899): detection, extraction
 * of functions / variables / `source` imports / command calls, the zsh
 * pre-parse, and end-to-end resolution of calls and sourced files.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, initGrammars, loadAllGrammars, isSourceFile } from '../src/extraction/grammars';
import { bashLiteralTail, blankZshExpansions } from '../src/extraction/languages/bash';
import type { Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Bash language detection', () => {
  it('maps .sh, .bash and .zsh to bash and indexes them', () => {
    expect(detectLanguage('scripts/deploy.sh')).toBe('bash');
    expect(detectLanguage('lib/bats-core/common.bash')).toBe('bash');
    expect(detectLanguage('plugins/git/git.plugin.zsh')).toBe('bash');
    expect(detectLanguage('INSTALL.SH')).toBe('bash');
    expect(isSourceFile('scripts/deploy.sh')).toBe(true);
    expect(isSourceFile('lib/x.bash')).toBe(true);
    expect(isSourceFile('x.zsh')).toBe(true);
  });
});

describe('Bash extraction', () => {
  const script = `#!/usr/bin/env bash
set -euo pipefail
source ./lib/common.sh
. "$(dirname "$0")/lib/log.sh"
source "$file"
export PREFIX="/usr/local"
readonly VERSION=1.2.3
declare -rx MODE=prod
declare -a ARR=(a b c)
COUNT=0
COUNT=$((COUNT + 1))
CONFIG="$(load_config)"

function greet {
  local name="$1"
  echo "hello $name"
  helper "$name"
}

helper() {
  case "$1" in
    a|b) echo ab ;;
    *) greet x ;;
  esac
  if [[ -n "$1" ]]; then
    result=$(compute 1 2)
  fi
  for i in 1 2; do compute "$i"; done
}

function compute() {
  echo $(( $1 + $2 ))
}

main() {
  greet "world" | tee out.log
  helper && compute 3 4 || exit 1
  command compute 5 6
  \\compute 7 8
  "$dynamic" arg
  trap cleanup EXIT
  trap 'rm -f /tmp/x' INT
}
cleanup() { rm -f /tmp/x; }
main "$@"
`;

  const result = () => extractFromSource('bin/main.sh', script);
  const byKind = (kind: Node['kind']) =>
    result().nodes.filter((n) => n.kind === kind).map((n) => n.name);

  it('extracts both function definition forms', () => {
    expect(byKind('function').sort()).toEqual(['cleanup', 'compute', 'greet', 'helper', 'main']);
    const greet = result().nodes.find((n) => n.name === 'greet')!;
    expect(greet.language).toBe('bash');
    expect(greet.startLine).toBe(14);
    expect(greet.endLine).toBe(18);
  });

  it('extracts top-level variables, constants and exports once each', () => {
    const nodes = result().nodes;
    expect(byKind('variable').sort()).toEqual(['ARR', 'CONFIG', 'COUNT', 'PREFIX']);
    expect(byKind('constant').sort()).toEqual(['MODE', 'VERSION']);
    expect(nodes.find((n) => n.name === 'PREFIX')?.isExported).toBe(true);
    expect(nodes.find((n) => n.name === 'MODE')?.isExported).toBe(true);
    expect(nodes.find((n) => n.name === 'COUNT')?.isExported).toBe(false);
    // `local name=` inside a function is not a graph symbol.
    expect(nodes.find((n) => n.name === 'name')).toBeUndefined();
  });

  it('emits source / . as imports, skipping fully dynamic paths', () => {
    expect(byKind('import')).toEqual(['./lib/common.sh', '$(dirname $0)/lib/log.sh']);
    const imports = result().unresolvedReferences.filter((r) => r.referenceKind === 'imports');
    expect(imports.map((r) => r.referenceName)).toEqual(['./lib/common.sh', '$(dirname $0)/lib/log.sh']);
  });

  it('emits calls for function-like commands and skips builtins and dynamic names', () => {
    const r = result();
    const idToName = new Map(r.nodes.map((n) => [n.id, n.name]));
    const calls = r.unresolvedReferences
      .filter((ref) => ref.referenceKind === 'calls')
      .map((ref) => `${idToName.get(ref.fromNodeId)}->${ref.referenceName}`);
    expect(calls).toContain('greet->helper');
    expect(calls).toContain('helper->greet'); // inside a case arm
    expect(calls).toContain('helper->compute'); // inside $(…) and a for loop
    expect(calls).toContain('main->tee'); // external programs are refs too; they never resolve
    expect(calls.filter((c) => c === 'main->compute')).toHaveLength(3); // plain, `command`, `\\compute`
    expect(calls).toContain('main.sh->main');
    expect(calls).toContain('main.sh->load_config');
    const names = new Set(r.unresolvedReferences.map((ref) => ref.referenceName));
    for (const builtin of ['echo', 'set', 'exit', 'local', 'trap', 'source', '[[', 'rm -f /tmp/x']) {
      expect(names.has(builtin)).toBe(false);
    }
    expect([...names].some((n) => n.includes('$'))).toBe(true); // only the import specs
    expect(r.unresolvedReferences.some((ref) => ref.referenceKind === 'calls' && ref.referenceName.includes('$'))).toBe(false);
  });

  it('records a trap handler as a reference, not a call', () => {
    const refs = result().unresolvedReferences.filter((r) => r.referenceKind === 'references');
    expect(refs.map((r) => r.referenceName)).toEqual(['cleanup']);
  });

  it('records zsh hook / widget / completion registrations as references', () => {
    const r = extractFromSource(
      'x.plugin.zsh',
      'f() { :; }\nadd-zsh-hook precmd _my_precmd\nzle -N my-widget\nzle -N other _other_fn\ncompdef _mycomp mycmd\n',
    );
    expect(r.unresolvedReferences.filter((x) => x.referenceKind === 'references').map((x) => x.referenceName))
      .toEqual(['_my_precmd', 'my-widget', '_other_fn', '_mycomp']);
  });
});

describe('zsh pre-parse', () => {
  it('blanks zsh-only expansions in .zsh files without moving offsets', () => {
    const src = 'f() {\n  echo "${VIRTUAL_ENV:t:gs/%/%%}" ${(j:,:)arr}\n  (( $+commands[op] )) && g\n}\n';
    const out = blankZshExpansions(src, 'a.plugin.zsh');
    expect(out).toHaveLength(src.length);
    expect(out.split('\n').map((l) => l.length)).toEqual(src.split('\n').map((l) => l.length));
    expect(out).not.toContain('(j:,:)');
    expect(out).toContain('$_commands[op]');
    // .sh / .bash files are left exactly as written.
    expect(blankZshExpansions(src, 'a.sh')).toBe(src);
  });

  it('recovers functions a zsh expansion would otherwise swallow', () => {
    const src = `function virtualenv_prompt_info(){
  [[ -n \${VIRTUAL_ENV} ]] || return
  echo "\${ZSH_THEME_VIRTUALENV_PREFIX=[}\${VIRTUAL_ENV_PROMPT:-\${VIRTUAL_ENV:t:gs/%/%%}}\${ZSH_THEME_VIRTUALENV_SUFFIX=]}"
}
other() { virtualenv_prompt_info; }
`;
    const r = extractFromSource('plugins/virtualenv/virtualenv.plugin.zsh', src);
    expect(r.nodes.filter((n) => n.kind === 'function').map((n) => n.name).sort())
      .toEqual(['other', 'virtualenv_prompt_info']);
  });
});

describe('bashLiteralTail', () => {
  it('keeps the literal path after the last expansion', () => {
    expect(bashLiteralTail('lib/x.sh')).toBe('lib/x.sh');
    expect(bashLiteralTail('$(dirname $0)/lib/x.sh')).toBe('/lib/x.sh');
    expect(bashLiteralTail('$(dirname $(readlink -f $0))/x.sh')).toBe('/x.sh');
    expect(bashLiteralTail('${BASH_SOURCE%/*}/x.sh')).toBe('/x.sh');
    expect(bashLiteralTail('$DIR/x.sh')).toBe('/x.sh');
    expect(bashLiteralTail('`dirname $0`/x.sh')).toBe('/x.sh');
    expect(bashLiteralTail('$A/$B')).toBe('');
  });
});

describe('Bash resolution', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bash-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 });
  });

  function write(rel: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), content);
  }

  function importedFiles(fromFile: string): string[] {
    const files = cg!.getNodesByKind('file');
    const source = files.find((n) => n.filePath === fromFile)!;
    return cg!
      .getOutgoingEdges(source.id)
      .filter((e) => e.kind === 'imports')
      .map((e) => files.find((n) => n.id === e.target)?.filePath ?? '?')
      .sort();
  }

  function callersOf(name: string, filePath?: string): string[] {
    const target = cg!
      .getNodesByKind('function')
      .find((n) => n.name === name && (!filePath || n.filePath === filePath));
    expect(target, `${name} node`).toBeDefined();
    return cg!
      .getIncomingEdges(target!.id)
      .filter((e) => e.kind === 'calls' || e.kind === 'references')
      .map((e) => {
        const src = cg!.getNode(e.source);
        return `${src?.name}@${src?.filePath}:${e.kind}`;
      })
      .sort();
  }

  it('links sourced files and cross-file function calls', async () => {
    write('lib/common.sh', 'log_info() { echo "$@"; }\ndie() { log_info "fatal"; exit 1; }\n');
    write('lib/log.sh', 'log_warn() { :; }\n');
    write(
      'bin/deploy.sh',
      [
        'source "$(dirname "$0")/../lib/common.sh"',
        '. "${BASH_SOURCE%/*}/../lib/log.sh"',
        'source "$HOME/.bashrc"',
        'run() { log_info start; die oops; }',
        'trap cleanup EXIT',
        'cleanup() { log_warn bye; }',
        'run',
        '',
      ].join('\n'),
    );
    write('scripts/ci.bash', 'source lib/common.sh\nci() { log_info ci; }\n');

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    expect(importedFiles('bin/deploy.sh')).toEqual(['lib/common.sh', 'lib/log.sh']);
    // A root-relative path (scripts are usually run from the repo root).
    expect(importedFiles('scripts/ci.bash')).toEqual(['lib/common.sh']);
    expect(callersOf('log_info')).toEqual([
      'ci@scripts/ci.bash:calls',
      'die@lib/common.sh:calls',
      'run@bin/deploy.sh:calls',
    ]);
    expect(callersOf('cleanup')).toEqual(['deploy.sh@bin/deploy.sh:references']);
    expect(callersOf('run')).toEqual(['deploy.sh@bin/deploy.sh:calls']);
  });

  it('prefers the same-file definition when several scripts define a helper', async () => {
    write('dns_a.sh', '_get_root() { :; }\ndns_a_add() { _get_root; }\n');
    write('dns_b.sh', '_get_root() { :; }\ndns_b_add() { _get_root; }\n');

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    expect(callersOf('_get_root', 'dns_a.sh')).toEqual(['dns_a_add@dns_a.sh:calls']);
    expect(callersOf('_get_root', 'dns_b.sh')).toEqual(['dns_b_add@dns_b.sh:calls']);
  });

  it('never links shell commands to other languages, or other languages to shell functions', async () => {
    write('build.sh', 'build() { compile; deploy; }\n');
    write('tools.py', 'def compile():\n    pass\n\ndef main():\n    build()\n');

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const compile = cg.getNodesByKind('function').find((n) => n.name === 'compile' && n.language === 'python')!;
    expect(cg.getIncomingEdges(compile.id).filter((e) => e.kind === 'calls')).toHaveLength(0);
    expect(callersOf('build')).toEqual([]);
  });

  it('leaves an ambiguous or bare-name dynamic source unresolved', async () => {
    write('a/key-bindings.zsh', 'kb() { :; }\n');
    write('plugins/fzf.plugin.zsh', 'source "${fzf_base}/key-bindings.zsh"\n');
    write('one/lib/util.sh', 'u1() { :; }\n');
    write('two/lib/util.sh', 'u2() { :; }\n');
    write('main.sh', 'source "$ROOT/lib/util.sh"\n');

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    expect(importedFiles('plugins/fzf.plugin.zsh')).toEqual([]);
    expect(importedFiles('main.sh')).toEqual([]);
  });

  it('resolves a dynamic prefix by unique directory-qualified suffix', async () => {
    write('dnsapi/dns_ali.sh', '_ali_rest() { :; }\n');
    write('deploy/ali_cdn.sh', 'source "$LE_WORKING_DIR/dnsapi/dns_ali.sh"\nali_cdn_deploy() { _ali_rest; }\n');

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    expect(importedFiles('deploy/ali_cdn.sh')).toEqual(['dnsapi/dns_ali.sh']);
    expect(callersOf('_ali_rest')).toEqual(['ali_cdn_deploy@deploy/ali_cdn.sh:calls']);
  });
});
