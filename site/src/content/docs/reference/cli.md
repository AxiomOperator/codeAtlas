---
title: CLI
description: Every CodeGraph command and the flags it accepts.
---

```bash
codegraph                         # Run interactive installer
codegraph install                 # Run installer (explicit)
codegraph uninstall               # Remove CodeGraph from your agents (inverse of install)
codegraph init [path]             # Initialize a project + build its graph (one step)
codegraph uninit [path]           # Remove CodeGraph from a project (--force to skip prompt)
codegraph index [path]            # Full re-index from scratch (--force, --quiet, --verbose)
codegraph sync [path]             # Incremental update (--quiet)
codegraph status [path]           # Show statistics (--json)
codegraph ui [path]               # Open the browser viewer (not released yet — see below)
codegraph unlock [path]           # Remove a stale lock file that's blocking indexing
codegraph query <search>          # Search symbols (--kind, --limit, --json)
codegraph explore <query>         # Relevant symbols' source + call paths in one shot (--max-files, --max-chars, --json)
codegraph node <symbol|file>      # One symbol's source + callers, or read a file with line numbers (--file, --offset, --limit, --symbols-only, --json)
codegraph files [path]            # Show file structure (--format, --filter, --pattern, --max-depth, --json)
codegraph callers <symbol>        # Find what calls a function/method (--limit, --json)
codegraph callees <symbol>        # Find what a function/method calls (--limit, --json)
codegraph impact <symbol>         # Analyze what code is affected by changing a symbol (--depth, --json)
codegraph affected [files...]     # Find test files affected by changes (see below)
codegraph daemon                  # Manage background daemons — pick one to stop (alias: daemons)
codegraph telemetry [on|off]      # Show or change anonymous usage telemetry
codegraph upgrade [version]       # Update to the latest release (--check, --force)
codegraph version                 # Print the installed version (also -v, --version)
codegraph help [command]          # Show help, optionally for one command
```

The MCP server (`codegraph serve --mcp`) is launched automatically by your agent — you don't run it by hand. See [MCP Server](/codegraph/reference/mcp-server/).

## init, index, and sync

`codegraph init` creates the local `.codegraph/` directory **and** builds the full graph in one step. (The old `-i`/`--index` flag is now a no-op, accepted only so existing scripts don't break.) After that the file watcher keeps the graph current automatically — `index` (a full rebuild from scratch) and `sync` (an incremental update) are only needed when the watcher is disabled or you're scripting against the index outside an agent session.

## Query commands

`query`, `callers`, `callees`, and `impact` all accept `--json` for machine-readable output.

```bash
codegraph query UserService --kind class --limit 10
codegraph callers handleRequest --json
codegraph impact AuthMiddleware --depth 3
```

`explore` and `node` are the CLI faces of the `codegraph_explore` and `codegraph_node` MCP tools — same output — so subagents and non-MCP harnesses can reach the graph from a shell.

### Bounding `explore`

`--max-files` caps how many files contribute source; `--max-chars <n>` caps the whole answer in characters (the MCP tool takes the same cap as `maxChars`). The cap only ever lowers the size CodeGraph would pick for the project — a value above it changes nothing — and values below 2000 are treated as 2000. Under a tighter cap, fewer files and shorter windows of each are shown, trailing sections are dropped whole where possible, and trimmed spots name the symbols to explore next.

```bash
codegraph explore "loginUser saveSession" --max-chars 6000
```

### JSON output for `explore` and `node`

With `--json`, both commands print the same answer as structured data, so a pipeline can keep the call path and blast radius and drop the source bodies (or route them elsewhere) without parsing markdown. The shape carries `"schemaVersion": 1`; fields may be added in later releases, never renamed or removed without a version bump.

Every symbol reference has the same fields:

```json
{ "name": "loginUser", "qualifiedName": "loginUser", "kind": "function",
  "file": "src/auth.ts", "startLine": 2, "endLine": 6 }
```

`codegraph explore --json`:

| Field | Meaning |
|---|---|
| `query`, `projectRoot` | What was asked, and of which project |
| `summary` | The "Found N symbols across M files." line |
| `notices` | Warnings the text output prints above the answer (e.g. the index predates this engine — run `codegraph index`) |
| `namedSymbols` | Symbols the query named that resolved in the index |
| `flow` | The call path among the named symbols, in order: symbol references plus `via` (the edge kind into this step, `null` on the first), `synthesizedBy` (set on a dynamic-dispatch hop) and `callLine` (where this step calls the next) |
| `flowText` | The flow section's markdown narrative (dynamic-dispatch links, boundaries), or `""` |
| `blastRadius` | For the entry symbols: `{ symbol, callers, callerFiles, testFiles }` |
| `files` | Files whose source the answer includes, in rank order: `{ path, language, symbols, ranges, source }`. `source` is exactly the block the text shows — line-numbered `<n>\t<line>`, with gap markers between non-adjacent spans; `ranges` are the 1-based line spans it covers |
| `omittedFiles` | Relevant files that did not fit: `{ path, symbols }` (names only) |
| `budget` | `{ maxChars, outputChars }`: the character cap applied and the size of the markdown answer |
| `message` | Present instead of an answer when nothing matched (all arrays are then empty) |

`codegraph node --json`:

| Field | Meaning |
|---|---|
| `mode` | `"symbol"`, `"file"`, or `"not-found"` |
| `notices` | As for `explore` |
| `symbols` | Symbol mode: every definition returned in full (overloads included) — a symbol reference plus `signature`, `source`, `sourceKind` (`"body"`, `"outline"` for a class-like container, `"none"`, or `"omitted-stale"` when the file changed since it was indexed), and `callers` / `callees` as symbol references |
| `otherDefinitions` | Symbol mode: further definitions that did not fit, as symbol references |
| `file` | File mode: `{ path, language, totalLines, dependents, symbols, startLine, endLine, source }` — `source` is the raw (un-numbered) lines `startLine`–`endLine`, or `null` with `--symbols-only` or for a config file whose values are withheld |
| `message`, `suggestions` | Not-found guidance and close names |

An error prints `{ "error": "…" }` and exits non-zero.

## affected

Traces import dependencies transitively to find which test files are affected by changed source files. See [Affected Tests in CI](/codegraph/guides/affected-tests/) for options and a CI example.

## ui

:::note[Not released yet]
The viewer isn't in a CodeGraph release yet: `codegraph ui` arrives in an upcoming release. This page describes it ahead of that.
:::

`codegraph ui` opens the [browser viewer](/codegraph/guides/viewer/) for a project you have already indexed: callers on the left, the symbol's source in the middle, and what it calls on the right at the height of the line that calls it.

```bash
codegraph ui                     # the project you're standing in
codegraph ui ~/code/my-app       # a project indexed elsewhere
codegraph ui --port 8080         # pin a port (fails if it's taken)
codegraph ui --no-open           # just print the URL (headless boxes, SSH)
codegraph ui --read-only         # refuse every write, including saved trails
```

Without `--port` it takes 4747, or the next free port. `CODEGRAPH_BROWSER=<command>` chooses which browser opens; `CODEGRAPH_BROWSER=none` never opens one. `codegraph web` is an alias.

The viewer listens on `127.0.0.1` only: it opens an index that already exists, never creates one, never changes your graph or a line of your code, and sends nothing anywhere. The one thing it writes is a trail you asked it to save, under `.codegraph/ui/trails/`; `--read-only` refuses even that.
