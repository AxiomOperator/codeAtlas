/**
 * Tiny TOML helpers — just enough to inject / replace / remove a
 * single dotted-key table block (`[mcp_servers.codegraph]`) inside an
 * existing `~/.codex/config.toml`. We deliberately do NOT try to be a
 * general TOML parser/serializer; that would mean pulling in a
 * dependency (~50KB) for ~6 lines of output.
 *
 * Strategy: treat the file as text, split into statements by a small
 * lexical scan (header-shaped text inside multiline values never counts as
 * a header). Find the `[mcp_servers.codegraph]` table in any spelling,
 * and upsert only the keys the installer owns inside it — user-added keys
 * (`env`, `startup_timeout_sec`, …) and `[mcp_servers.codegraph.*]`
 * subtables survive. Everything outside is preserved byte-for-byte.
 *
 * Limitations (acceptable for our narrow use):
 *   - Only writes a top-level table header. Array-of-tables and sibling
 *     subtables are preserved as opaque blocks (we always write the full
 *     dotted key `[mcp_servers.codegraph]`).
 *   - Doesn't validate sibling TOML — if the file is malformed
 *     elsewhere, our injection won't fix it but won't make it worse.
 *   - Quotes string values with double quotes; escapes `\` and `"`.
 */

/**
 * Serialize a record into the body lines of a TOML table. Values
 * supported: string, string[]. Other types throw — the codex MCP
 * config only needs these two.
 */
export function serializeTomlTableBody(values: Record<string, string | string[]>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      lines.push(`${key} = ${quoteString(value)}`);
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      const parts = value.map(quoteString).join(', ');
      lines.push(`${key} = [${parts}]`);
    } else {
      throw new Error(`Unsupported TOML value type for key "${key}"`);
    }
  }
  return lines.join('\n');
}

function quoteString(s: string): string {
  // TOML basic strings: backslash and double-quote escapes; control
  // chars not expected in our payload (paths/args).
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Build a full table block: header line + body. Suitable for direct
 * insertion into a TOML file.
 */
export function buildTomlTable(header: string, values: Record<string, string | string[]>): string {
  return `[${header}]\n${serializeTomlTableBody(values)}`;
}

type MultilineStringDelimiter = '"""' | "'''";

interface TomlLexState {
  multilineString: MultilineStringDelimiter | null;
  arrayDepth: number;
  inlineTableDepth: number;
}

const TOML_KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*')`;
const TOML_DOTTED_KEY = String.raw`${TOML_KEY_PART}(?:[ \t]*\.[ \t]*${TOML_KEY_PART})*`;
const TOML_TABLE = String.raw`\[[ \t]*${TOML_DOTTED_KEY}[ \t]*\]`;
const TOML_ARRAY_TABLE = String.raw`\[\[[ \t]*${TOML_DOTTED_KEY}[ \t]*\]\]`;
const TOML_TABLE_HEADER = new RegExp(
  String.raw`^[ \t]*(?:${TOML_TABLE}|${TOML_ARRAY_TABLE})[ \t]*(?:#.*)?\r?$`
);

function isTomlTableHeader(line: string): boolean {
  return TOML_TABLE_HEADER.test(line);
}

/** Track value constructs that may legally span lines so bracket-shaped string
 * content and nested arrays cannot be mistaken for sibling table headers. */
function scanTomlLine(line: string, state: TomlLexState): void {
  for (let i = 0; i < line.length;) {
    if (state.multilineString !== null) {
      const end = findMultilineStringEnd(line, i, state.multilineString);
      if (end === -1) return;
      i = end + state.multilineString.length;
      state.multilineString = null;
      continue;
    }

    if (line[i] === '#') return;

    const multiline = line.startsWith('"""', i)
      ? '"""'
      : line.startsWith("'''", i)
        ? "'''"
        : null;
    if (multiline !== null) {
      state.multilineString = multiline;
      i += multiline.length;
      continue;
    }

    const ch = line[i]!;
    if (ch === '"' || ch === "'") {
      i = skipSingleLineString(line, i, ch);
      continue;
    }
    if (ch === '[') state.arrayDepth++;
    else if (ch === ']' && state.arrayDepth > 0) state.arrayDepth--;
    else if (ch === '{') state.inlineTableDepth++;
    else if (ch === '}' && state.inlineTableDepth > 0) state.inlineTableDepth--;
    i++;
  }
}

function findMultilineStringEnd(
  line: string,
  from: number,
  delimiter: MultilineStringDelimiter,
): number {
  let end = line.indexOf(delimiter, from);
  while (delimiter === '"""' && end !== -1 && isBackslashEscaped(line, end)) {
    end = line.indexOf(delimiter, end + 1);
  }
  return end;
}

function isBackslashEscaped(line: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && line[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

function skipSingleLineString(line: string, start: number, quote: '"' | "'"): number {
  for (let i = start + 1; i < line.length; i++) {
    if (quote === '"' && line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === quote) return i + 1;
  }
  return line.length;
}

/** A TOML value the installer writes. */
export type TomlValue = string | string[];

/**
 * One logical statement of a TOML document: a table header, a key/value
 * pair (including every continuation line of a multi-line value), or
 * anything else (blank lines, comments). `end` is exclusive and includes
 * the trailing newline.
 */
export interface TomlStatement {
  kind: 'table' | 'array-table' | 'kv' | 'other';
  start: number;
  end: number;
  /** Header path for tables; the (relative) dotted key for `kv`. */
  key: string[];
  /** The table this statement sits in (`[]` = root). */
  table: string[];
}

const TOML_HEADER_PARTS = new RegExp(
  String.raw`^[ \t]*(\[\[|\[)[ \t]*(${TOML_DOTTED_KEY})[ \t]*\]\]?[ \t]*(?:#.*)?\r?$`,
);
const TOML_KV_START = new RegExp(String.raw`^[ \t]*(${TOML_DOTTED_KEY})[ \t]*=`);

/**
 * Split a dotted key (`mcp_servers."codegraph"`, `a . 'b'`) into its
 * unquoted parts. Lenient: input is already known to match the key grammar.
 */
export function parseDottedKey(raw: string): string[] {
  const parts: string[] = [];
  let i = 0;
  const s = raw.trim();
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      const lit = s.slice(i, j + 1);
      try { parts.push(JSON.parse(lit)); } catch { parts.push(lit.slice(1, -1)); }
      i = j + 1;
    } else if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      const end = j === -1 ? s.length : j;
      parts.push(s.slice(i + 1, end));
      i = end + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) break;
      parts.push(m[0]);
      i += m[0].length;
    }
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '.') i++;
    else break;
  }
  return parts;
}

/**
 * Scan a TOML document into statements. A small lexical pass keeps
 * header-shaped text inside multi-line strings / arrays / inline tables out
 * of the header search, and groups a multi-line value with its key.
 */
export function scanTomlStatements(content: string): TomlStatement[] {
  const out: TomlStatement[] = [];
  let table: string[] = [];
  let pos = 0;
  while (pos < content.length) {
    const nl = content.indexOf('\n', pos);
    const lineEnd = nl === -1 ? content.length : nl + 1;
    const line = content.slice(pos, nl === -1 ? content.length : nl);

    if (isTomlTableHeader(line)) {
      const m = TOML_HEADER_PARTS.exec(line);
      const key = m ? parseDottedKey(m[2]!) : [];
      table = key;
      out.push({ kind: m && m[1] === '[[' ? 'array-table' : 'table', start: pos, end: lineEnd, key, table: key });
      pos = lineEnd;
      continue;
    }

    const kv = TOML_KV_START.exec(line);
    const state: TomlLexState = { multilineString: null, arrayDepth: 0, inlineTableDepth: 0 };
    scanTomlLine(line, state);
    let end = lineEnd;
    while (
      end < content.length &&
      (state.multilineString !== null || state.arrayDepth > 0 || state.inlineTableDepth > 0)
    ) {
      const nl2 = content.indexOf('\n', end);
      scanTomlLine(content.slice(end, nl2 === -1 ? content.length : nl2), state);
      end = nl2 === -1 ? content.length : nl2 + 1;
    }
    out.push({ kind: kv ? 'kv' : 'other', start: pos, end, key: kv ? parseDottedKey(kv[1]!) : [], table });
    pos = end;
  }
  return out;
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
function hasPrefix(a: readonly string[], prefix: readonly string[]): boolean {
  return a.length >= prefix.length && prefix.every((x, i) => a[i] === x);
}

interface TableBlock {
  /** Index of the header statement. */
  index: number;
  start: number;
  headerEnd: number;
  end: number;
}

function tableBlocks(stmts: TomlStatement[], contentLength: number): TableBlock[] {
  const blocks: TableBlock[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const st = stmts[i]!;
    if (st.kind !== 'table' && st.kind !== 'array-table') continue;
    let end = contentLength;
    for (let j = i + 1; j < stmts.length; j++) {
      if (stmts[j]!.kind === 'table' || stmts[j]!.kind === 'array-table') {
        end = stmts[j]!.start;
        break;
      }
    }
    blocks.push({ index: i, start: st.start, headerEnd: st.end, end });
  }
  return blocks;
}

/**
 * Locate the `[a.b]` table for `header`, whatever its spelling —
 * `[ a.b ]`, `[a."b"]`, `['a'.b]`, a trailing comment. Null when absent.
 */
export function findTomlTable(content: string, header: string): TableBlock | null {
  const want = parseDottedKey(header);
  const stmts = scanTomlStatements(content);
  return tableBlocks(stmts, content.length).find((b) => {
    const st = stmts[b.index]!;
    return st.kind === 'table' && samePath(st.key, want);
  }) ?? null;
}

/**
 * True when `header`'s table is defined some way OTHER than a `[header]`
 * table — an inline table (`codegraph = { … }` under `[mcp_servers]`, or
 * `mcp_servers = { codegraph = … }`) or dotted keys (`codegraph.command = …`).
 * Adding a `[header]` table next to one of those would be a duplicate
 * definition (invalid TOML), and editing them in place isn't something a
 * line-oriented editor can do safely, so callers refuse instead.
 */
export function findInlineTomlDefinition(content: string, header: string): boolean {
  const want = parseDottedKey(header);
  for (const st of scanTomlStatements(content)) {
    if (st.kind !== 'kv') continue;
    if (hasPrefix(st.table, want)) continue; // inside our own table (or a subtable)
    const full = [...st.table, ...st.key];
    if (hasPrefix(full, want)) return true;
    if (full.length < want.length && hasPrefix(want, full)) {
      // `mcp_servers = { codegraph = {...} }` — look for the next segment
      // as a key inside the inline value.
      const seg = want[full.length]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const text = content.slice(st.start, st.end);
      const valueText = text.slice(text.indexOf('=') + 1);
      if (new RegExp(String.raw`[{,][ \t\r\n]*["']?${seg}["']?[ \t]*[.=]`).test(valueText)) return true;
    }
  }
  return false;
}

function insertTable(fileContent: string, block: string): string {
  const trimmed = fileContent.trimEnd();
  const sep = trimmed.length > 0 ? '\n\n' : '';
  return trimmed + sep + block + '\n';
}

/**
 * Insert or replace a top-level dotted-key TOML table block in the
 * given file content, owning the WHOLE block. Preserves all other content
 * verbatim. (The Codex target uses `upsertTomlTableKeys`, which owns only
 * its own keys.)
 *
 * Returns `'inserted'` when the table was newly added, `'replaced'`
 * when an existing one was rewritten, `'unchanged'` when the
 * existing block already matches `block` byte-for-byte.
 */
export function upsertTomlTable(
  fileContent: string,
  header: string,
  block: string,
): { content: string; action: 'inserted' | 'replaced' | 'unchanged' } {
  const t = findTomlTable(fileContent, header);
  if (!t) return { content: insertTable(fileContent, block), action: 'inserted' };

  const existingBlock = fileContent.substring(t.start, t.end).replace(/\n+$/, '');
  if (existingBlock === block) {
    return { content: fileContent, action: 'unchanged' };
  }

  // Trim trailing blank lines from `before` (we'll re-add one) and
  // leading blank lines from `after` so the file shape stays clean.
  const beforeClean = fileContent.substring(0, t.start).replace(/\n+$/, '');
  const afterClean = fileContent.substring(t.end).replace(/^\n+/, '');
  const sepBefore = beforeClean.length > 0 ? '\n\n' : '';
  const sepAfter = afterClean.length > 0 ? '\n\n' : '\n';
  return {
    content: beforeClean + sepBefore + block + sepAfter + afterClean,
    action: 'replaced',
  };
}

/**
 * Upsert only the keys in `values` inside the `[header]` table. Keys the
 * caller doesn't own (`env`, `startup_timeout_sec`, `enabled`, comments …)
 * are preserved verbatim, as are `[header.*]` subtables and every other
 * table. An owned key keeps its position (and indentation); a missing one
 * is added right under the header; a duplicate owned key is dropped.
 *
 * `refused` (content unchanged) when the table is defined inline or by
 * dotted keys elsewhere — see `findInlineTomlDefinition`.
 */
export function upsertTomlTableKeys(
  fileContent: string,
  header: string,
  values: Record<string, TomlValue>,
): { content: string; action: 'inserted' | 'replaced' | 'unchanged' | 'refused' } {
  if (findInlineTomlDefinition(fileContent, header)) {
    return { content: fileContent, action: 'refused' };
  }
  const t = findTomlTable(fileContent, header);
  if (!t) {
    return { content: insertTable(fileContent, buildTomlTable(header, values)), action: 'inserted' };
  }

  const stmts = scanTomlStatements(fileContent).filter((s) => s.start >= t.headerEnd && s.end <= t.end);
  const owned = new Set(Object.keys(values));
  const emitted = new Set<string>();
  const body: string[] = [];
  for (const st of stmts) {
    const text = fileContent.slice(st.start, st.end);
    const name = st.kind === 'kv' && st.key.length === 1 ? st.key[0]! : null;
    if (name !== null && owned.has(name)) {
      if (!emitted.has(name)) {
        const indent = /^[ \t]*/.exec(text)![0];
        body.push(indent + serializeTomlTableBody({ [name]: values[name]! }) + '\n');
        emitted.add(name);
      }
      continue;
    }
    body.push(text);
  }
  const missing = Object.keys(values).filter((k) => !emitted.has(k));
  let headerText = fileContent.slice(t.start, t.headerEnd);
  if (!headerText.endsWith('\n')) headerText += '\n';
  const missingText = missing.map((k) => serializeTomlTableBody({ [k]: values[k]! }) + '\n').join('');
  const next = fileContent.slice(0, t.start) + headerText + missingText + body.join('') + fileContent.slice(t.end);
  return next === fileContent
    ? { content: fileContent, action: 'unchanged' }
    : { content: next, action: 'replaced' };
}

/**
 * Remove a top-level dotted-key TOML table block — and every
 * `[header.*]` subtable (e.g. `[mcp_servers.codegraph.env]`) with it, so
 * an uninstall leaves no orphaned half-definition behind. Any spelling of
 * the header is recognized. Returns the possibly-empty new content + an
 * action flag.
 */
export function removeTomlTable(
  fileContent: string,
  header: string,
): { content: string; action: 'removed' | 'not-found' } {
  const want = parseDottedKey(header);
  const stmts = scanTomlStatements(fileContent);
  const doomed = tableBlocks(stmts, fileContent.length).filter((b) => {
    const st = stmts[b.index]!;
    return (st.kind === 'table' && samePath(st.key, want)) ||
      (st.key.length > want.length && hasPrefix(st.key, want));
  });
  if (doomed.length === 0) return { content: fileContent, action: 'not-found' };

  let content = fileContent;
  for (const b of [...doomed].reverse()) {
    const before = content.substring(0, b.start).replace(/\n+$/, '');
    const after = content.substring(b.end).replace(/^\n+/, '');
    content = before + (before && after ? '\n\n' : '') + after;
  }
  return { content, action: 'removed' };
}
