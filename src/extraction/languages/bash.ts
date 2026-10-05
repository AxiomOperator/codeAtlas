import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// Node names follow the vendored ABI-15 tree-sitter-bash 0.25.1 grammar (see
// grammars.ts for why the tree-sitter-wasms build is not used).
//
// Shell has no declarations beyond functions and variables, and every
// invocation is the same `command` node — so the work happens in two places:
//   - here: functions (both `function f {}` and `f() {}` are
//     `function_definition`) and top-level variables (`X=1`, `export X=`,
//     `readonly X=`, `declare -r X=`);
//   - the core's bash branch in extractCall (tree-sitter.ts), which turns a
//     `command` into a `calls` ref (a function name), an `imports` ref
//     (`source` / `.`), or nothing (a builtin, or a dynamic `$cmd`).

/**
 * Shell builtins and reserved words. A command with one of these names is the
 * shell itself, never a user function, so it produces no `calls` ref. (A
 * script CAN shadow one — `cd() { …; }` — but resolving every `cd` in a repo
 * to that wrapper is the wrong default.) External programs (`grep`, `git`)
 * are not listed: they simply never match a definition, and when a repo does
 * wrap one in a function of the same name, linking to the wrapper is right.
 */
export const BASH_BUILTINS: ReadonlySet<string> = new Set([
  ':', '.', '[', '[[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd',
  'command', 'compgen', 'complete', 'compopt', 'continue', 'declare', 'dirs',
  'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fc',
  'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local',
  'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray',
  'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'test',
  'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias',
  'unset', 'wait',
  // zsh builtins that tree-sitter-bash reads as ordinary commands.
  'autoload', 'zmodload', 'zstyle', 'setopt', 'unsetopt', 'emulate', 'bindkey',
  'zle', 'compdef', 'print', 'noglob', 'functions', 'whence', 'where', 'which',
  'rehash', 'add-zsh-hook',
]);

/**
 * Commands that run their first non-flag argument as a command — `command
 * foo`, `exec foo`, `time foo`. The argument is the real callee.
 */
export const BASH_COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  'command', 'exec', 'time', 'nohup', 'builtin',
]);

/**
 * The handler argument of a command that registers a function for the shell
 * to call later, or `undefined` when `name` is not such a command (`null`
 * when it is but names no handler):
 *   - `trap HANDLER SIG…`
 *   - `add-zsh-hook [-d] HOOK HANDLER`
 *   - `zle -N WIDGET [HANDLER]` (the widget name doubles as the function)
 *   - `compdef [-flags] HANDLER CMD…`
 */
export function bashHandlerArgument(
  name: string,
  args: SyntaxNode[],
  source: string,
): SyntaxNode | null | undefined {
  const positional = (): SyntaxNode[] => args.filter((a) => !getNodeText(a, source).startsWith('-'));
  switch (name) {
    case 'trap':
      return args[0] ?? null;
    case 'add-zsh-hook':
      return positional()[1] ?? null;
    case 'zle': {
      if (!args.some((a) => getNodeText(a, source) === '-N')) return null;
      const pos = positional();
      return pos[pos.length - 1] ?? null;
    }
    case 'compdef':
      return positional()[0] ?? null;
    default:
      return undefined;
  }
}

/** A name a shell function can carry (bash allows `-`, `:`, `.` and `::`). */
export const BASH_FUNCTION_NAME_RE = /^[A-Za-z_][\w:.+-]*$/;

/**
 * Normalize the path argument of `source` / `.` to the text an import node is
 * named by: quotes dropped, expansions kept verbatim (`"$DIR/lib.sh"` →
 * `$DIR/lib.sh`). Returns null for an argument with no static path part at
 * all (`source "$file"`, `. <(cmd)`), which the resolver could never place.
 */
export function bashSourceSpec(arg: SyntaxNode, source: string): string | null {
  if (arg.type === 'process_substitution' || arg.type === 'command_substitution') return null;
  const raw = getNodeText(arg, source).trim();
  if (!raw) return null;
  // Quotes dropped; an expansion the zsh pre-parse blanked (`${_____}`) is
  // shown as `${…}` rather than as the underscores.
  const spec = raw.replace(/["']/g, '').replace(/\$\{_+\}/g, '${…}');
  if (!spec) return null;
  const tail = bashLiteralTail(spec);
  // Nothing literal after the last expansion — a fully dynamic path.
  if (tail === null || tail === '' || tail === '/') return null;
  // An expansion inside the file name (`$dir/$name.zsh`) leaves no file to
  // name; only a directory-prefix expansion (`$DIR/lib.sh`) does.
  if (tail !== spec && !tail.startsWith('/')) return null;
  return spec;
}

/**
 * The literal part of a source path that follows its last expansion, or the
 * whole spec when it has none: `$(dirname "$0")/lib/x.sh` → `/lib/x.sh`,
 * `${BASH_SOURCE%/*}/x.sh` → `/x.sh`, `lib/x.sh` → `lib/x.sh`. Null when an
 * expansion remains in the tail (`$A/$B.sh`).
 */
export function bashLiteralTail(spec: string): string | null {
  // Scan left to right, skipping each expansion whole — `${…}` and `$(…)`
  // with nesting, `$NAME`, `$1`/`$@`, and backticks — and remember where the
  // last one ended.
  let lastEnd = 0;
  let i = 0;
  const closeOf = (open: string): string => (open === '(' ? ')' : '}');
  while (i < spec.length) {
    const ch = spec[i];
    if (ch === '`') {
      const close = spec.indexOf('`', i + 1);
      if (close === -1) return null;
      i = lastEnd = close + 1;
    } else if (ch === '$') {
      const next = spec[i + 1];
      if (next === '(' || next === '{') {
        const stack: string[] = [closeOf(next)];
        let j = i + 2;
        for (; j < spec.length && stack.length; j++) {
          const c = spec[j];
          if ((c === '(' || c === '{') && spec[j - 1] === '$') stack.push(closeOf(c));
          else if (c === '(' && stack[stack.length - 1] === ')') stack.push(')');
          else if (c === stack[stack.length - 1]) stack.pop();
        }
        if (stack.length) return null; // unbalanced
        i = lastEnd = j;
      } else if (next !== undefined && /[A-Za-z_]/.test(next)) {
        let j = i + 2;
        while (j < spec.length && /\w/.test(spec[j]!)) j++;
        i = lastEnd = j;
      } else if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
        i = lastEnd = i + 2;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return spec.slice(lastEnd);
}

/** `readonly X` / `declare -r X` / `typeset -r X` declare a constant. */
function isReadonlyDeclaration(node: SyntaxNode, source: string): boolean {
  const keyword = getNodeText(node, source).trimStart().split(/\s/, 1)[0];
  if (keyword === 'readonly') return true;
  if (keyword !== 'declare' && keyword !== 'typeset') return false;
  return node.namedChildren.some((c) => c.type === 'word' && /^-[a-zA-Z]*r/.test(getNodeText(c, source)));
}

/** `export X=` / `declare -x X=` / `typeset -x X=` put X in child environments. */
function isExportDeclaration(node: SyntaxNode, source: string): boolean {
  const keyword = getNodeText(node, source).trimStart().split(/\s/, 1)[0];
  if (keyword === 'export') return true;
  if (keyword !== 'declare' && keyword !== 'typeset') return false;
  return node.namedChildren.some((c) => c.type === 'word' && /^-[a-zA-Z]*x/.test(getNodeText(c, source)));
}

/** A one-line signature for a variable node: the assignment, truncated. */
function assignmentSignature(node: SyntaxNode, source: string): string {
  const text = getNodeText(node, source).split('\n', 1)[0]!.trim();
  return text.length > 100 ? text.slice(0, 100) : text;
}

/** Longest `${…}` the zsh blanking pass will look across. */
const ZSH_EXPANSION_SCAN_LIMIT = 1000;

/**
 * zsh parameter expansions carry syntax bash has no reading for — flags
 * (`${(%):-%N}`, `${(j:,:)arr}`), modifiers (`${VAR:t:gs/%/%%}`), nested
 * forms (`${${X:-y}:h}`). tree-sitter-bash's error recovery on one of these
 * routinely swallows the enclosing function and the rest of the file, so a
 * zsh plugin's functions vanish. An expansion never declares or calls a
 * function, so for `.zsh` files every single-line `${…}` body is blanked to
 * underscores — `${__________}` is a plain bash expansion of the same length.
 * Byte offsets and newlines are preserved (preParse contract). A `$(cmd)`
 * nested in a blanked expansion loses its call, which is rare and acceptable.
 */
export function blankZshExpansions(source: string, filePath?: string): string {
  if (!filePath || !/\.zsh$/i.test(filePath)) return source;
  // Two more zsh-only shapes, both inside `(( … ))` / `[[ … ]]` tests:
  // `$+commands[x]` (is-set test) → `$_commands[x]`, and a subscript flag
  // `$arr[(Ie)$w]` / `$arr[(r)x]` → `$arr[____$w]`. Same length, same lines.
  source = source
    .replace(/\$\+(?=[A-Za-z_{])/g, '$_')
    .replace(/\[\(([A-Za-z@]{1,8})\)/g, (m) => '[' + '_'.repeat(m.length - 1));
  if (!source.includes('${')) return source;
  let out: string[] | null = null;
  let i = source.indexOf('${');
  while (i !== -1) {
    let depth = 0;
    let end = -1;
    for (let j = i + 1; j < source.length && j - i < ZSH_EXPANSION_SCAN_LIMIT; j++) {
      const ch = source[j];
      if (ch === '\n') break; // unbalanced or multi-line: leave it to the grammar
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { end = j; break; }
    }
    if (end === -1) {
      i = source.indexOf('${', i + 2);
      continue;
    }
    out ??= source.split('');
    for (let k = i + 2; k < end; k++) out[k] = '_';
    i = source.indexOf('${', end + 1);
  }
  return out ? out.join('') : source;
}

export const bashExtractor: LanguageExtractor = {
  preParse: blankZshExpansions,
  // `function f { … }`, `function f() { … }` and `f() { … }` all parse as
  // function_definition with a `name: word` and a `body` (usually a
  // compound_statement; a subshell `f() ( … )` body works the same way).
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  // `source` / `.` are commands — the core's bash branch in extractCall emits
  // the import node and file reference for them.
  importTypes: [],
  callTypes: ['command'],
  // Variables are minted by visitNode below, so the core's generic variable
  // path (which knows nothing about shell assignments) stays out of it.
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters', // shell functions take positional args — no list

  // Shell functions declare no parameters; `()` keeps the signature honest.
  getSignature: () => '()',

  // Top-level variables. The hook only runs on the module-level walk (function
  // bodies go through the body walker), so `local x` and in-function
  // assignments never become nodes. Only statements directly under `program`
  // count: an assignment inside a top-level `if` is a conditional default, and
  // the first unconditional one already named the variable.
  visitNode: (node, ctx) => {
    if (node.parent?.type !== 'program') return false;
    const source = ctx.source;

    const mint = (assign: SyntaxNode, kind: 'variable' | 'constant', exported: boolean, sigNode: SyntaxNode): void => {
      const nameNode = getChildByField(assign, 'name');
      if (!nameNode || nameNode.type !== 'variable_name') return;
      const name = getNodeText(nameNode, source);
      // A script that reassigns a global (`X=1` … `X=$((X+1))`) still has one
      // variable. First definition wins.
      if (ctx.nodes.some((n) => n.name === name && (n.kind === 'variable' || n.kind === 'constant'))) return;
      ctx.createNode(kind, name, assign, {
        signature: assignmentSignature(sigNode, source),
        isExported: exported,
      });
    };

    if (node.type === 'variable_assignment') {
      mint(node, 'variable', false, node);
    } else if (node.type === 'declaration_command') {
      const keyword = getNodeText(node, source).trimStart().split(/\s/, 1)[0];
      if (keyword === 'local') return false; // invalid outside a function
      const kind = isReadonlyDeclaration(node, source) ? 'constant' : 'variable';
      const exported = isExportDeclaration(node, source);
      for (const child of node.namedChildren) {
        if (child.type === 'variable_assignment') mint(child, kind, exported, node);
      }
    }
    // Never claim the subtree: an initializer's `$(cmd)` is still a call.
    return false;
  },
};
