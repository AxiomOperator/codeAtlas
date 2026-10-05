/**
 * Advertised MCP tool names for clients that namespace tools themselves (#1267).
 *
 * Some MCP clients register every server tool as `<serverKey>_<toolName>`.
 * opencode does (verified on opencode 1.18 with both the v1 `mcp.codegraph`
 * and the native `mcp.servers.codegraph` config shapes — the model is handed
 * `codegraph_codegraph_explore`). Our tools are already called
 * `codegraph_explore`, so in such a client the doubled name no longer matches
 * anything in the server instructions, the installer-written AGENTS.md block,
 * or third-party prompts that say `codegraph_explore`.
 *
 * `CODEGRAPH_TOOL_PREFIX=none` (or `codegraph serve --mcp --tool-prefix none`,
 * which sets it) makes `tools/list` advertise the BARE names (`explore`,
 * `node`, …), so a prefixing client shows `codegraph_explore` again. The
 * default is unchanged: full `codegraph_*` names.
 *
 * Names are translated only where the CLIENT sees them — the `tools/list`
 * answer of the process the client talks to (the direct session, or the
 * local-handshake proxy). Everything behind that (ToolHandler, the shared
 * daemon, telemetry) keeps the canonical `codegraph_*` names, and
 * `tools/call` accepts BOTH spellings unconditionally ({@link canonicalToolName}),
 * so a daemon started from a differently-configured client still serves
 * every session correctly.
 *
 * The server instructions need no rewrite for this mode: bare names are only
 * meant for prefixing clients, where the name the model sees is
 * `codegraph_<tool>` — exactly what the instructions already say.
 */

export const TOOL_NAME_PREFIX = 'codegraph_';

/** True when the client should be shown bare tool names (`CODEGRAPH_TOOL_PREFIX=none`). */
export function useBareToolNames(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CODEGRAPH_TOOL_PREFIX ?? '').trim().toLowerCase();
  return v === 'none' || v === 'bare' || v === 'off' || v === '0' || v === 'false';
}

/** The tool list as the client should see it — renamed only in bare mode. */
export function presentToolNames<T extends { name: string }>(defs: T[], env: NodeJS.ProcessEnv = process.env): T[] {
  if (!useBareToolNames(env)) return defs;
  return defs.map((d) => (d.name.startsWith(TOOL_NAME_PREFIX) ? { ...d, name: d.name.slice(TOOL_NAME_PREFIX.length) } : d));
}

/**
 * Map a `tools/call` name back to the canonical `codegraph_*` name. Accepts the
 * canonical name, the bare name (`explore`), and the doubled form a prefixing
 * client might echo back (`codegraph_codegraph_explore`). Unknown names are
 * returned unchanged so the caller's "Unknown tool" path still reports them.
 */
export function canonicalToolName(name: string, known: ReadonlySet<string> | readonly string[]): string {
  const has = (n: string): boolean => (Array.isArray(known) ? (known as readonly string[]).includes(n) : (known as ReadonlySet<string>).has(n));
  if (has(name)) return name;
  const bare = name.startsWith(TOOL_NAME_PREFIX + TOOL_NAME_PREFIX) ? name.slice(TOOL_NAME_PREFIX.length) : TOOL_NAME_PREFIX + name;
  return has(bare) ? bare : name;
}
