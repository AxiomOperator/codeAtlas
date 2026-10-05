/**
 * Helpers shared across `AgentTarget` implementations.
 *
 * Lifted from the original `config-writer.ts` so each target can
 * compose them without inheritance. Kept deliberately small — the
 * targets are different enough (JSON vs TOML vs Markdown, varying
 * idempotency markers) that a base class would force the awkward
 * shape onto everyone.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  parse as parseJsonc,
  modify,
  applyEdits,
  printParseErrorCode,
  type FormattingOptions,
  type JSONPath,
  type ParseError,
} from 'jsonc-parser';
import type { AgentTarget, WriteResult } from './types';
import {
  CODEGRAPH_INSTRUCTIONS_BLOCK,
  CODEGRAPH_SECTION_START,
  CODEGRAPH_SECTION_END,
} from '../instructions-template';

/**
 * The MCP-server config block codegraph injects. Same shape across
 * all JSON-shaped agent configs (Claude, Cursor, opencode), only the
 * surrounding wrapper differs. Codex (TOML) builds its own block.
 */
export function getMcpServerConfig(): { type: string; command: string; args: string[] } {
  return {
    type: 'stdio',
    command: 'codegraph',
    args: ['serve', '--mcp'],
  };
}

/**
 * Permissions list for Claude `settings.json`. Other targets that
 * have a permissions concept can compose this list directly.
 *
 * One server-scoped wildcard rather than a per-tool list. By default only
 * `codegraph_explore` is even LISTED to the agent (see DEFAULT_MCP_TOOLS in
 * mcp/tools.ts), so in practice explore is the only tool this auto-approves —
 * but the wildcard means that if a user re-enables another tool via
 * CODEGRAPH_MCP_TOOLS, it's already pre-approved (no permission prompt, no
 * hand-editing settings.json), and future tools are covered too. Claude only
 * honors globs after a literal `mcp__<server>__` prefix, so this exact string
 * is the way to allow-all for one server; a bare `mcp__codegraph` or `*` is
 * ignored. The allowlist gates PROMPTING, not visibility, so a superset here
 * never makes a hidden tool appear.
 */
export function getCodeGraphPermissions(): string[] {
  return ['mcp__codegraph__*'];
}

/**
 * A config file codegraph was about to edit could not be parsed — not even
 * as JSONC. We REFUSE to touch it rather than replace it (earlier versions
 * swapped the whole file for `{ mcpServers: … }`, keeping only a `.backup`).
 * Targets turn this into a `kept` file action plus a note telling the user
 * what to fix (see `guardConfigWrite` / `withConfigRefusal`).
 */
export class ConfigParseError extends Error {
  readonly filePath: string;
  constructor(filePath: string, detail: string) {
    super(
      `${filePath} could not be parsed (${detail}) — CodeGraph left it untouched. ` +
      'Fix the syntax error (or move the file aside) and re-run `codegraph install`.',
    );
    this.name = 'ConfigParseError';
    this.filePath = filePath;
  }
}

export type JsoncParseResult =
  | { ok: true; value: Record<string, any> }
  | { ok: false; detail: string };

/**
 * Parse JSON-with-comments text into a plain object. Blank text is `{}`.
 * Comments and trailing commas are accepted (Gemini, Kiro, VS Code and
 * opencode all document JSONC configs); anything else that is malformed, or
 * a top-level value that is not an object, is a failure.
 */
export function parseJsoncObject(text: string): JsoncParseResult {
  if (!text.trim()) return { ok: true, value: {} };
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const e = errors[0]!;
    const line = text.slice(0, e.offset).split('\n').length;
    return { ok: false, detail: `${printParseErrorCode(e.error)} at line ${line}` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, detail: 'the top-level value is not an object' };
  }
  return { ok: true, value: value as Record<string, any> };
}

/**
 * Parse config text that is about to be EDITED: the object, or a
 * `ConfigParseError` naming `filePath`. Never edit on top of a lenient
 * `{}` fallback — that is how a config gets replaced.
 */
export function parseJsoncForEdit(text: string, filePath: string): Record<string, any> {
  const parsed = parseJsoncObject(text);
  if (!parsed.ok) throw new ConfigParseError(filePath, parsed.detail);
  return parsed.value;
}

/**
 * Read a JSON (or JSONC) file, returning `{}` when missing or unparseable.
 *
 * Read-only, and deliberately silent: every target's `detect()` reads
 * its agent's config on every `codegraph install`, and most of those
 * agents codegraph was never installed into. A warning about a file we
 * are not going to touch is noise (issue #1870).
 *
 * An unparseable file is never overwritten: `writeJsonFile` re-parses the
 * file itself and refuses with a `ConfigParseError` instead.
 */
export function readJsonFile(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = parseJsoncObject(fs.readFileSync(filePath, 'utf-8'));
    return parsed.ok ? parsed.value : {};
  } catch {
    return {};
  }
}

/**
 * Strict read for a config that is about to be edited: `{}` when the file
 * is missing or blank, the parsed object otherwise, and a `ConfigParseError`
 * when it can't be parsed — so an edit is never computed on top of the
 * lenient `{}` that `readJsonFile` hands `detect()`.
 */
export function readJsonFileForEdit(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) return {};
  return parseJsoncForEdit(fs.readFileSync(filePath, 'utf-8'), filePath);
}

/**
 * Resolve the file a write to `filePath` must land in. A symlinked config
 * (a dotfiles repo, `~/.claude.json -> ~/dotfiles/claude.json`) is followed
 * to its real target so the rename replaces the TARGET, never the link —
 * write-then-rename on the link path turned every symlink into a regular
 * file. Follows chains, and dangling links (whose target is then created).
 */
export function resolveWriteTarget(filePath: string): string {
  let p = filePath;
  for (let hops = 0; hops < 40; hops++) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return p;
    }
    if (!st.isSymbolicLink()) return p;
    p = path.resolve(path.dirname(p), fs.readlinkSync(p));
  }
  return p;
}

function readTextOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function existingMode(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mode & 0o7777;
  } catch {
    return undefined;
  }
}

/**
 * Write `content` to a temp file beside `real` (same directory, so the
 * rename never crosses a filesystem), carry `mode` over, rename on top.
 * `recheck` runs just before the rename; returning a string replaces the
 * temp file's content, returning `null` abandons the write.
 */
function writeAndRename(
  real: string,
  content: string,
  recheck?: () => string | null | undefined,
): boolean {
  const dir = path.dirname(real);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const mode = existingMode(real);
  const tmpPath = real + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, content);
    if (recheck) {
      const redo = recheck();
      if (redo === null) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        return false;
      }
      if (typeof redo === 'string') fs.writeFileSync(tmpPath, redo);
    }
    // writeFileSync's mode is filtered through the umask — chmod explicitly
    // so a 0600 `~/.claude.json` stays 0600 (and a 0644 one is not narrowed).
    const finalMode = existingMode(real) ?? mode;
    if (finalMode !== undefined) {
      try { fs.chmodSync(tmpPath, finalMode); } catch { /* best effort (Windows) */ }
    }
    fs.renameSync(tmpPath, real);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Write a file atomically: write to a temp file beside the real target,
 * then rename over it.
 *
 * Prevents corruption if the process crashes mid-write. Symlinks are
 * followed (the link survives and its target is updated) and the existing
 * file's permission bits are preserved. The temp file is cleaned up on
 * failure.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  writeAndRename(resolveWriteTarget(filePath), content);
}

/**
 * Read-modify-write a text file atomically, with a lost-update guard.
 *
 * `transform` receives the current text (`null` when the file does not
 * exist) and returns the new text, or `null` for "nothing to write". Just
 * before the rename the file is re-read; when something else (a running
 * Claude Code rewriting `~/.claude.json`, say) changed it after our read,
 * `transform` is re-applied ONCE to the fresh content, so that writer's
 * change is kept instead of clobbered. Not a lock — it narrows the race
 * window to the rename itself. Returns whether the file was written.
 */
export function editFileAtomic(
  filePath: string,
  transform: (current: string | null) => string | null,
): boolean {
  const real = resolveWriteTarget(filePath);
  const snapshot = readTextOrNull(real);
  const next = transform(snapshot);
  if (next === null) return false;
  return writeAndRename(real, next, () => {
    const fresh = readTextOrNull(real);
    if (fresh === snapshot) return undefined;
    return transform(fresh);
  });
}

/** One surgical JSON edit: set `value` at `path`, or delete it (`undefined`). */
interface JsonEdit {
  path: JSONPath;
  value: unknown;
  /** Array insertion rather than replacement at `path`'s index. */
  insert?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** True when `small` is `big` with some elements removed (order kept). */
function removedIndices(big: unknown[], small: unknown[]): number[] | null {
  const removed: number[] = [];
  let j = 0;
  for (let i = 0; i < big.length; i++) {
    if (j < small.length && jsonDeepEqual(big[i], small[j])) {
      j++;
    } else {
      removed.push(i);
    }
  }
  return j === small.length ? removed : null;
}

/**
 * The minimal set of path edits turning `base` into `next`. Objects recurse
 * key by key (so untouched keys — and the comments around them — are never
 * rewritten); arrays get appends / removals when that is all that changed,
 * otherwise element-wise recursion or a whole replacement.
 */
function diffJson(base: unknown, next: unknown, at: JSONPath, out: JsonEdit[]): void {
  if (jsonDeepEqual(base, next)) return;
  if (isPlainObject(base) && isPlainObject(next)) {
    for (const k of Object.keys(base)) {
      if (!(k in next)) out.push({ path: [...at, k], value: undefined });
    }
    for (const k of Object.keys(next)) {
      if (!(k in base)) out.push({ path: [...at, k], value: next[k] });
      else diffJson(base[k], next[k], [...at, k], out);
    }
    return;
  }
  if (Array.isArray(base) && Array.isArray(next)) {
    if (next.length > base.length && jsonDeepEqual(base, next.slice(0, base.length))) {
      for (let i = base.length; i < next.length; i++) {
        out.push({ path: [...at, i], value: next[i], insert: true });
      }
      return;
    }
    if (next.length < base.length) {
      const gone = removedIndices(base, next);
      if (gone) {
        for (const i of gone.reverse()) out.push({ path: [...at, i], value: undefined });
        return;
      }
    }
    if (next.length === base.length) {
      for (let i = 0; i < base.length; i++) diffJson(base[i], next[i], [...at, i], out);
      return;
    }
  }
  out.push({ path: at, value: next });
}

/** Indentation / EOL of an existing document, so edits match its style. */
function detectFormatting(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = /\n([ \t]+)\S/.exec(text);
  if (m && m[1]!.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol };
  const size = m ? m[1]!.length : 2;
  return { insertSpaces: true, tabSize: size > 0 && size <= 8 ? size : 2, eol };
}

function applyJsonEdits(text: string, edits: JsonEdit[]): string {
  const formattingOptions = detectFormatting(text);
  let out = text;
  for (const e of edits) {
    out = applyEdits(out, modify(out, e.path, e.value, {
      formattingOptions,
      isArrayInsertion: e.insert === true,
    }));
  }
  return out;
}

/**
 * Write `data` into a JSON / JSONC config surgically.
 *
 * Rather than re-serializing the whole document, the difference between
 * what is on disk and `data` is applied as `jsonc-parser` path edits, so
 * comments, key order, formatting, and every key we don't change survive
 * byte-for-byte. A brand-new (or blank) file gets a plain 2-space JSON body.
 *
 * Refuses — throws `ConfigParseError`, file untouched — when the existing
 * file can't be parsed even as JSONC. Atomic, symlink- and mode-preserving,
 * with `editFileAtomic`'s lost-update guard: the same edits are re-applied
 * to the fresh text if the file changed under us.
 */
export function writeJsonFile(filePath: string, data: Record<string, any>): void {
  let edits: JsonEdit[] | null = null;
  editFileAtomic(filePath, (current) => {
    if (current === null || !current.trim()) {
      if (edits === null) return JSON.stringify(data, null, 2) + '\n';
      return applyJsonEdits('{}\n', edits);
    }
    const parsed = parseJsoncForEdit(current, filePath);
    if (edits === null) {
      edits = [];
      diffJson(parsed, data, [], edits);
    }
    if (edits.length === 0) return null;
    return applyJsonEdits(current, edits);
  });
}

/**
 * Run one file-level config write; a `ConfigParseError` becomes a `kept`
 * action plus a user-facing note instead of aborting the whole install.
 */
export function guardConfigWrite(
  notes: string[],
  write: () => WriteResult['files'][number],
): WriteResult['files'][number] {
  try {
    return write();
  } catch (err) {
    if (err instanceof ConfigParseError) {
      notes.push(err.message);
      return { path: err.filePath, action: 'kept' };
    }
    throw err;
  }
}

/**
 * Backstop for a whole target: an unparseable config surfacing from any
 * install / uninstall step is reported (kept + note), never thrown at the
 * orchestrator and never "fixed" by replacing the file.
 */
export function withConfigRefusal<T extends AgentTarget>(target: T): T {
  const install = target.install.bind(target);
  const uninstall = target.uninstall.bind(target);
  const refuse = (err: unknown): WriteResult => {
    if (err instanceof ConfigParseError) {
      return { files: [{ path: err.filePath, action: 'kept' }], notes: [err.message] };
    }
    throw err;
  };
  target.install = (loc, opts) => {
    try { return install(loc, opts); } catch (err) { return refuse(err); }
  };
  target.uninstall = (loc, opts) => {
    try { return uninstall(loc, opts); } catch (err) { return refuse(err); }
  };
  return target;
}

/**
 * Compare two JSON values for deep equality, ignoring key order.
 *
 * Used for idempotency: when the on-disk config already exactly
 * matches what we'd write, return action=`unchanged` instead of
 * re-writing (and emitting a confusing "Updated" log line).
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length) return false;
  if (!ak.every((k, i) => k === bk[i])) return false;
  return ak.every((k) => jsonDeepEqual(ao[k], bo[k]));
}

/**
 * Replace or append a marker-delimited section in a markdown-ish file.
 *
 * Used by Claude / Codex for the `<!-- CODEGRAPH_START --> ... <!--
 * CODEGRAPH_END -->` block. Preserves all content outside the
 * markers verbatim.
 *
 * Returns `created` when the file didn't exist; `updated` when
 * markers were found and content swapped; `appended` when markers
 * weren't found and section was added at end. `unchanged` when the
 * existing block already matches `body`.
 */
export function replaceOrAppendMarkedSection(
  filePath: string,
  body: string,
  startMarker: string,
  endMarker: string,
): 'created' | 'updated' | 'appended' | 'unchanged' {
  if (!fs.existsSync(filePath)) {
    atomicWriteFileSync(filePath, body + '\n');
    return 'created';
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx !== -1 && endIdx > startIdx) {
    const existingBlock = content.substring(startIdx, endIdx + endMarker.length);
    if (existingBlock === body) {
      return 'unchanged';
    }
    const before = content.substring(0, startIdx);
    const after = content.substring(endIdx + endMarker.length);
    atomicWriteFileSync(filePath, before + body + after);
    return 'updated';
  }

  // No markers — append. Preserve existing content with a separating
  // blank line.
  const trimmed = content.trimEnd();
  const sep = trimmed.length > 0 ? '\n\n' : '';
  atomicWriteFileSync(filePath, trimmed + sep + body + '\n');
  return 'appended';
}

/**
 * Upsert the CodeGraph instructions block into an agent instructions
 * file (CLAUDE.md / AGENTS.md / GEMINI.md). The one write shared by
 * every target: self-heals a stale pre-#529 long block (markers match →
 * replaced by the current short one), appends after existing user
 * content otherwise, and reports `unchanged` on byte-equal re-runs so
 * install stays idempotent. See `instructions-template.ts` for why this
 * block exists (#704: subagents + non-MCP harnesses never see the MCP
 * initialize instructions).
 */
export function upsertInstructionsEntry(file: string): { path: string; action: 'created' | 'updated' | 'unchanged' } {
  const action = replaceOrAppendMarkedSection(
    file,
    CODEGRAPH_INSTRUCTIONS_BLOCK,
    CODEGRAPH_SECTION_START,
    CODEGRAPH_SECTION_END,
  );
  return { path: file, action: action === 'appended' ? 'updated' : action };
}

/**
 * Inverse of `replaceOrAppendMarkedSection`. Strips the marker
 * block from `filePath` if present. If the file becomes empty after
 * removal, deletes the file entirely (matches the existing Claude
 * uninstall behavior).
 *
 * Returns `removed` when content was stripped, `not-found` when
 * the markers weren't present, `kept` when the file didn't exist.
 */
export function removeMarkedSection(
  filePath: string,
  startMarker: string,
  endMarker: string,
): 'removed' | 'not-found' | 'kept' {
  if (!fs.existsSync(filePath)) return 'kept';

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 'kept';
  }

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx <= startIdx) return 'not-found';

  const before = content.substring(0, startIdx).trimEnd();
  const after = content.substring(endIdx + endMarker.length).trimStart();
  const joined = before + (before && after ? '\n\n' : '') + after;

  if (joined.trim() === '') {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  } else {
    atomicWriteFileSync(filePath, joined.trim() + '\n');
  }
  return 'removed';
}
