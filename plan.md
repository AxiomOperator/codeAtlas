# Remediation Plan — Code Review Findings + Open GitHub Issues

_Prepared 2026-10-05 against `main` @ `26e8488` (in sync with upstream `colbymchenry/codegraph`). Last release: **v1.6.2** (2026-10-03)._

This plan merges two inputs:

1. **The code review** (four parallel read-only passes over `src/mcp`, `src/extraction` + `src/db`, `src/resolution`, and `src/bin`/installer/sync/upgrade/telemetry/ui-server/CI). Findings are tagged **R-x**.
2. **The open issue tracker** (149 open issues at colbymchenry/codegraph). Issues are tagged **#NNNN**.

Items marked _(plausible)_ were not reproduced end-to-end — each such item starts with a failing test that proves it before any fix lands.

---

## Ground rules (from AGENTS.md — apply to every item)

- **One PR per item** (or per tightly related cluster). Each PR adds a regression test that fails on `main` and passes after the fix. Real files + real SQLite, no DB mocking.
- **CHANGELOG**: user-facing entry under `## [Unreleased]` (`### New Features` / `### Fixes`, plain language, no internal paths). Never pre-create a `[X.Y.Z]` block. No version bumps.
- **Installer changes** need coverage in `__tests__/installer-targets.test.ts`.
- **MCP guidance changes** go only in `src/mcp/server-instructions.ts`.
- **Error shape**: `isError: true` only for security refusals and genuine malfunctions; everything recoverable is success-shaped guidance.
- **Language/framework/resolution fixes**: validate on small/medium/large real repos with ≥3 flow prompts (`scripts/agent-eval/probe-*.mjs`, then `run-all.sh` / `ab-new-vs-baseline.sh`). Close flows end-to-end — partial coverage is worse than none. Read `docs/design/framework-coverage.md` first for router/framework work.
- **Platform-sensitive changes** (workers, file watching, paths, process lifecycle) are validated on Linux (Docker, `--init`) and the Windows VM, not just locally.
- **Do not** `npm publish`, `git tag`, or push release state; the maintainer runs the Release workflow.

---

## Phase 0 — Release what's already fixed (days 0–1)

Several open issues are fixed on `main` but unreleased.

| Issue | Fixed by | Action |
|---|---|---|
| #2335 daemon outlives upgrade, zeroes re-indexed files | `511d86e`, `dea076f` | Verify `[Unreleased]` CHANGELOG entry; close on v1.6.3 |
| #2336 `status` "up to date" despite zero-symbol files | `dea076f` | same |
| #2337 C# `private const` breaks `new X()` | `355afc7` | same |
| #2334 pretix indexing 2.2× slower | `0c7d0f7` | Re-time pretix on `main` before closing |
| #2305 VB.NET Shared fields/properties | `c994414`, `489b474` (partial?) | Re-run the issue's repro; split remaining gaps into a follow-up |

**Deliverables:** Highlights block written in `[Unreleased]`; maintainer cuts v1.6.3; comment on each issue with the release link.

> **Phase 0 progress (2026-10-05)**
> - ✅ Added a `### Highlights` block to `[Unreleased]` in `CHANGELOG.md` covering the fixes on `main` (#2335, #2336, #2337, #2332, VB.NET/C# accuracy) with a re-index note.
> - ✅ Confirmed #2335, #2336, #2337 are fixed on `main` (commits `511d86e`, `dea076f`, `355afc7`) — close on the next release.
> - ❌ #2334 is **not** fixed: `0c7d0f7` only fixed the Python checks; its own message says `matchDestructuredCallResult` (#2334) is still the remaining hotspot. Moved to Phase 4 (§4.1).
> - ❌ #2305 re-tested on `main` with the issue's three-file repro: `callers SessionId` / `CurrentUser` / `AppSession` still return 0. Moved to Phase 4 (§4.2).
> - ⏸ Cutting v1.6.3 and commenting/closing upstream issues need maintainer rights on `colbymchenry/codegraph` — not done from this fork.

---

## Phase 1 — Critical: supply chain, consent, and data safety (week 1)

### 1.1 Harden the release workflow — R-1, R-5
- `.github/workflows/release.yml`:
  - `actions/checkout` with `persist-credentials: false`; inject `RELEASE_PAT` only into the two `git push` steps (`git -c http.extraheader=…` or a scoped remote URL).
  - `npm ci --ignore-scripts` where install scripts aren't needed; pin `npm@11` to an exact version.
  - Move `permissions:` to per-job; the `kernel` job gets `contents: read` only.
  - Guard `if: github.ref == 'refs/heads/main'`; pass `--target ${{ github.sha }}` to `gh release create` so the tag matches the built commit.
  - Pin third-party actions by SHA.
- **Acceptance:** dry-run on a fork; token absent from `.git/config` during `npm ci`; tag SHA == build SHA.

### 1.2 Add PR CI — R-4
- New `.github/workflows/ci.yml` on `pull_request` + `push: main`:
  - `ubuntu-latest`: `npm ci`, `npx tsc --noEmit`, `npm run build`, `npm test` (both vitest projects).
  - `windows-latest` and `macos-latest`: `npm test` (allow the documented symlink-privilege exception).
  - Kernel: `cargo build` + `kernel-*` tests.
- Make the Release workflow run the full suite (or require the CI check on the release SHA) before publishing.
- **Acceptance:** branch protection requires CI; a deliberately broken test blocks merge.

### 1.3 Persist the prompt-hook opt-out — R-2
- `src/installer/index.ts:229`, `targets/claude.ts:157-160`, `src/upgrade/index.ts:843`.
- Record the decision (e.g. `~/.codegraph/preferences.json` → `{ promptHook: "declined" }`) at install; `defaultWirePromptHook` returns `false` when declined; explicit `codegraph install --prompt-hook` clears it.
- Tests: install-decline → upgrade → hook absent; install-accept → upgrade → idempotent `unchanged`.

### 1.4 Telemetry consent & data minimisation — #1868, #1908, #2333, R-13
- **Decision needed from maintainer** (legal, not code): opt-in vs. first-run prompt vs. region-aware default. Recommended: interactive first-run prompt in `codegraph install`; non-interactive / CI defaults **off**.
- Code regardless of decision:
  - Rotate or drop `machine_id` (e.g. per-month salted ID) and document retention in `TELEMETRY.md`.
  - Allowlist `mcp_tool` names and `clientInfo` values before recording (`src/telemetry/index.ts:293`, `mcp/proxy.ts:359`).
  - `codegraph serve --no-telemetry` flag (#1908) alongside the env var.
  - Cache `isEnabled()` instead of sync-reading config per call.
- Telemetry pipeline (#2333, separate PR in `telemetry-worker/` + `telemetry-dashboard/`): count late index events toward activation; distinguish usage-only days from stalled ingest; bound catch-up per cron run.

### 1.5 Verify upgrade downloads; validate pinned version — R-3, R-11
- `install.sh` / `install.ps1` / `src/upgrade/index.ts:554-570, 685-707, 762-768`:
  - Fetch the installer from the **release tag**, not `main`.
  - Verify the downloaded bundle against `SHA256SUMS` (fail closed).
  - Use `set -o pipefail` / download-then-execute so a failed `curl` fails the upgrade.
  - Validate the pinned version with `parseSemver` before it reaches `cmd /c`; ignore a stale `CODEGRAPH_VERSION` unless passed explicitly.
- Tests: tampered checksum → abort; `1.0.0&calc` → rejected; curl failure → non-zero exit.

### 1.6 Antivirus false positive — #1644
- Submit `codegraph.js` / bundle hashes to Kaspersky false-positive portal; evaluate Authenticode signing for the Windows bundle in the Release workflow. Document in README FAQ.

> **Phase 1 progress (2026-10-05)**
> - ✅ 1.1 `release.yml`: `persist-credentials: false` on checkout; `RELEASE_PAT` passed only to the two push steps via env; least-privilege `permissions` per job (kernel job read-only); both jobs gated on `refs/heads/main`; `gh release create --target <built SHA>`; `npm@11.19.0` pinned; all actions pinned by commit SHA; typecheck + build + full `npm test` before publishing. `npm ci` still runs install scripts (esbuild needs its postinstall for the viewer build) but no longer has a credential to read.
> - ✅ 1.2 New `.github/workflows/ci.yml`: PRs + pushes to main run typecheck, build and `npm test` on Linux/macOS/Windows, plus a Linux kernel build + `kernel-*` parity suites. Branch protection requiring it is a repo setting for the maintainer.
> - ✅ 1.3 Prompt-hook opt-out persisted in `~/.codegraph/preferences.json` (`src/installer/preferences.ts`); `defaultWirePromptHook` refuses when declined; opting back in clears it. Two new contract tests in `installer-targets.test.ts`.
> - ✅ 1.4 (code parts) Telemetry: unknown MCP tool names counted as `other` (`KNOWN_MCP_TOOLS`, pinned to `tools.ts` by a test); non-identifier client labels dropped; **off by default under `CI`** with no stored choice; `codegraph serve --no-telemetry` (#1908); `TELEMETRY.md` updated. #2333: index events now lower `first_index_day` at ingest; dashboard freshness counts `usage_daily`; nightly purges before catch-up and stops catch-up after a 10-minute budget.
>   - ⏸ Maintainer decision still needed for #1868: opt-in vs first-run prompt, and rotating/dropping the persistent `machine_id` (changes server-side activation math — not changed unilaterally). `isEnabled()` re-reading the consent file per call is intentional (catches another process's opt-out) and was left as is.
> - ✅ 1.5 Upgrade: strict version validation (`isValidVersion`) before anything reaches a shell; Unix upgrade downloads `install.sh` from the **release tag**, then runs it (no `curl | sh`); `install.sh`, `install.ps1` and the Windows in-place upgrade verify the archive against `SHA256SUMS` (fail closed, `CODEGRAPH_SKIP_VERIFY=1` escape hatch); warning when `CODEGRAPH_VERSION` pins the upgrade. New tests in `upgrade.test.ts` (tag URL, failed-download exit code, injection rejected).
> - ✅ 1.6 Troubleshooting doc entry for antivirus false positives (#1644). ⏸ Vendor submission and Authenticode signing need the maintainer's accounts/certificates.
> - Verification: `tsc --noEmit` clean; full suite 453 files / 5788 tests pass; telemetry-worker typechecks (dashboard's only errors are pre-existing undeclared secret bindings).

---

## Phase 2 — Reliability & crash safety (weeks 1–3)

### 2.1 Open-time heal must not run mid-index or block forever — #1887, R-DB5
- `src/db/index.ts:186-188` (`healBulkNodeLoad` / `healBulkSecondaryIndexes`).
- Gate the heal on the cross-process index lock / `index_state != 'indexing'`; a concurrent opener serves read-only instead.
- Run index recreation off the main thread (or in resumable per-index steps, each committed) so the #850 liveness watchdog can't kill it in a loop; persist progress so a restart resumes rather than repeats.
- Investigate the 14–16 GiB Windows memory spikes reported on #1887 (2026-10-05) during this recovery.
- **Acceptance:** kill a fresh index mid-bulk-load → next open recovers within watchdog budget; a `sync` during `index` does not rebuild FTS.

### 2.2 Worker teardown policy everywhere — R-DB1, R-DB2
- `src/extraction/parse-worker.ts:133`: call `collectBeforeExit()` before `process.exit(1)` on WASM OOM.
- `parse-pool.ts:366-374` (`recycle`): send `shutdown`; worker does `collectBeforeExit(); process.exit(0)`; `terminate()` only as a timeout fallback.
- `src/db/index.ts:721, 814` checkpoint/maintenance workers: let them exit themselves after replying.
- **Validation:** Windows VM, 480-run teardown loop as in `src/worker-teardown.ts` measurements; zero 0xC0000005.

### 2.3 FTS / node identity integrity — R-DB3, R-DB8 _(plausible → prove first)_
- Test 1: store a bundle with a duplicate node id → check `nodes_fts` for orphan/duplicate rows.
- Test 2: `CodeGraph.optimize()` (VACUUM) on a DB with deletions → search returns correct nodes.
- Fix (if proven): dedupe ids in `finalizeStoreBundle` and switch to `INSERT OR IGNORE`, **or** add an `INTEGER PRIMARY KEY` rowid alias so FTS `content_rowid` is stable; route standalone extractors (svelte/vue/astro/liquid/mybatis/cfml/dfm/razor) through `NodeIdAllocator`. Requires a migration + extraction-version bump (full re-index note in Highlights).

### 2.4 Transactions and rollback — R-DB6, R-DB7, R-DB13
- `sqlite-adapter.ts:170-176`, `synthesis-stage.ts:76-79`: only `ROLLBACK` when `db.isTransaction`; rethrow the original error.
- Replace flattened nested transactions with `SAVEPOINT`s.
- `extraction/index.ts:3059-3121` chunked store: wrap delete + chunks + re-attach + `upsertFile` in a single transaction (yield via savepoint boundaries, not commits), or stage into a temp table and swap.
- `removeTracked` (`:3389-3400`): one transaction; add a uniqueness key on `unresolved_refs`.

### 2.5 Fast-init corruption window — R-DB4 _(plausible)_
- On open, if `index_state` says a fast init was in progress, treat the DB as disposable (unlink + "rebuild needed" success-shaped message) instead of healing a potentially malformed file.

### 2.6 Resolver caches in long-lived processes — R-RES1
- `src/resolution/index.ts:310-319, 248`, `import-resolver.ts:668-695, 1264`.
- Introduce a resettable-cache registry; `clearCaches()` resets `projectAliases`, `dirAliases`, `goModule`, `workspacePackages`, `razorUsingsCache`, `cppIncludeDirCache`; call it when the watcher sees tsconfig/jsconfig/package.json/go.mod/compile_commands.json/_Imports.razor change. Delete dead `importMappingCache`.
- Test: daemon-style long-lived `CodeGraph`; edit tsconfig `paths` → `sync` → import resolves to new target.

### 2.7 Stale/recheck reliability reports (verify, then close or re-scope)
Ask reporters to re-test on v1.6.3; reproduce internally where possible:
- #1431 (watchdog / WAL, fixed 1.6.0), #1773 (Windows test load, fixed 1.6.1), #1567 (nested `.gitignore`, fix Sep 8), #1227 (Codex first-call "busy", 1.3.0), #1157 (Cursor hang), #1099 (memory), #1080 (over-eager explore in Codex), #1014 / #448 (SMB / mapped network drives — document unsupported WAL-on-network-FS and fail with guidance).

### 2.8 Smaller robustness items
- Engine shutdown deadline: `engine.ts:292` busy-wait gets a timeout (R-MCP11).
- Prune `driftCache`, `nestedRepoCache`, `worktreeMismatchCache` (TTL/LRU) (R-MCP8).
- Cap `SocketTransport` line buffer (R-MCP9).
- Iterative DFS with node caps for `findCircularDependencies`, `getImpactRecursive`, callers/callees recursion (R-MCP10).
- Watcher millisecond tie (`sync/watcher.ts:1035`): use `<` or a monotonic sequence number (R-18).
- UTF-16/BOM detection when decoding source files (R-DB9).
- Partial `visitNode` failure: don't store under the new content hash; mark for retry (R-DB11).
- Grammar-load transient failure: retry once per worker before marking unavailable (R-DB12).

> **Phase 2 progress (2026-10-05)** — done by four parallel worktree branches, merged and squashed into one commit; full suite 459 files / 5839 tests pass, `tsc --noEmit` clean.
> - ✅ 2.1 (#1887) Open-time bulk-load heal is skipped while another live process holds `.codegraph/codegraph.lock` (gating on `index_state` alone was wrong: `indexing` with no live holder means a dead indexer that *needs* healing); a skipped heal finishes on the next locked write. Recovery is a list of separately committed steps (resumable after a kill); `CodeGraph.open` and watchdog-armed processes run it on a worker thread with `temp_store=FILE`. New `bulk-load-recovery.test.ts` (incl. a real lowered watchdog). Memory effect on the 14–16 GiB report not measured.
> - ✅ 2.2 Worker teardown: `exitAfterCollect`, `COLLECT_BEFORE_EXIT_SOURCE`, `awaitExitOrTerminate` in `worker-teardown.ts`; parse-worker OOM path collects first; parse-pool `recycle()` sends `shutdown` and only terminates after a 5 s grace; checkpoint, maintenance and the new heal worker exit on their own. ⏸ The 480-run Windows VM validation needs the maintainer's VM.
> - ✅ 2.3 Proven: `INSERT OR REPLACE` left orphan FTS rows → `PRAGMA recursive_triggers = ON` on every connection (no schema change). Disproven: VACUUM does not renumber rowids on the bundled SQLite 3.53.4 (kept as a pin test). Existing indexes keep any old orphans until a re-index (not user-visible in search).
> - ✅ 2.4 `rollbackIfActive` — original error always rethrown; nested transactions use SAVEPOINTs; new `transactionAsync` makes the chunked big-file store one transaction with its heartbeat yields inside; `removeTracked` is one transaction. Trade-off: a giant-file store holds the write lock for the whole file. ⏸ Uniqueness key on `unresolved_refs` not added (the atomic removal removes the duplication path).
> - ✅ 2.5 Fast init writes a `codegraph.db-fastinit` pid marker before going non-durable; an open that finds a dead owner's marker discards the DB and reports "re-run `codegraph index`".
> - ✅ 2.6 `invalidateConfigCaches()` resets alias/dir-alias/go.mod/workspace/razor/C++ include caches once per index/sync; a stored config fingerprint triggers re-extraction of affected languages only when config really changed; the watcher treats tsconfig/jsconfig/package.json/pnpm-workspace/go.mod/compile_commands.json edits as full-sync triggers; dead `importMappingCache` removed. Limitation: nested tsconfig / `_Imports.razor` edits refresh caches but don't force re-extraction.
> - ✅ 2.7 Stale reports: #1431, #1773, #1567 have fixes on `main` with tests; #1773's Windows CI flakiness reproduced on GitHub-hosted Windows (8 timeout/EMFILE failures) → the CI Windows job now runs with `--maxWorkers=2` and longer timeouts. ⏸ Asking reporters of #1227, #1157, #1099, #1080, #1014, #448 to re-test needs upstream access.
> - ✅ 2.8 Engine shutdown 30 s deadline; drift / nested-repo / worktree caches LRU-bounded; socket line buffer capped (64 MiB); callers/callees/impact/DFS walks iterative with identical order (60k-deep chain test); iterative `findCircularDependencies`; watcher same-ms tie fixed with a sequence number; shared `decodeSourceBytes` (BOM + UTF-16) used by extraction and every freshness check; partial parses flagged `incomplete` and retried; grammar load retried once.

---

## Phase 3 — MCP answer correctness & agent trust (weeks 2–3)

### 3.1 Central argument coercion — R-MCP4, R-MCP13
- Add one `coerceArgs(schema, raw)` at the dispatch entry in `src/mcp/tools.ts`: object-check `params.arguments`; finite-number + clamp for `depth`/`limit`/`maxFiles`; enums. Fixes `clamp("max"||2)` → `NaN` (`tools.ts:3248, 3085, 3168, 4088`).
- Harden `clamp` in `src/utils.ts:222` to return `min` for non-finite input.
- Tests: `depth: "max"`, `limit: null`, `arguments: "str"` → bounded, success-shaped.

### 3.2 One error classifier — R-MCP1, R-MCP6, R-MCP14
- `classifyError(err) → ToolResult` used by `execute`, `executeReadTool`, query-worker, query-pool.
- Move to success-shaped guidance: `projectPath` pointing at a file (resolve from `dirname`), validation failures ("query must be a non-empty string" — also #1403), unknown/disabled tool names.
- Keep `PathRefusalError` for genuinely sensitive dirs; reconsider `~/.config` blanket refusal (allow if it contains a `.codegraph/`).

### 3.3 No silent fuzzy answers in `codegraph_node` — R-MCP2, R-MCP3, #1455
- Delete the private `findSymbolMatches` fuzzy fallback (`tools.ts:8368`); route through `src/graph/symbol-lookup.ts` `lookupSymbolNodes` (single derivation per AGENTS.md). Not-found returns "did you mean: …" suggestions, success-shaped.
- Unify qualified lookup on the exact-name index (no `limit: 50` FTS cut).

### 3.4 `codegraph_files` glob — R-MCP5
- Replace hand-rolled `globToRegex` (`tools.ts:8191`) with `picomatch` (or existing matcher used by the ignore layer): anchored, brace sets, `**/` root match, no ReDoS.

### 3.5 Explore surfaces import-kind targets — #2342
- `src/context/index.ts:1449`: allow `import` nodes whose language marks them as include/copybook targets (COBOL `EXEC SQL INCLUDE`, CICS LINK/XCTL) or when the query names them exactly.
- Test with the issue's COBOL repro.

### 3.6 Tool naming in prefixing clients — #1267
- For clients that auto-prefix (opencode et al.), offer unprefixed tool names via a server option set by the installer target (`--tool-prefix none`), and make `server-instructions.ts` render the names the client will actually see.

### 3.7 Agent adoption cluster — #1279, #1918, #914, #975, #2313, #765, #1080
- **#2313 opt-in gate hook** (`codegraph gate-hook`): Claude Code `PreToolUse` hook that blocks Grep/Glob (and `rg/grep/find` via Bash) until one codegraph call has run in the session in an indexed project. Opt-in only, installer flag, persisted like 1.3. This is the one lever that doesn't depend on agent salience.
- **#1918** ("output heavily compressed, reading file directly"): audit explore truncation markers; ensure god-file output honours the per-file budget and never implies a Read is needed.
- **#975 / #1080**: reproduce with the A/B harness on a small private-style repo; if confirmed, tune the `<500` file tier and the "small task" heuristics in instructions.
- **#765**: allow a project-level `.codegraph/instructions.md` appended to (not replacing) server instructions.
- Fix doc drift: AGENTS.md explore-budget table vs code (13K/18K/24K), `getExploreOutputBudget` doc comment, and AGENTS.md's claim that installers no longer write instruction blocks (R-MCP12, R-19).

### 3.8 Refactor `ToolHandler` / `handleExplore` (enabler, incremental) — R-MCP7
- Split `src/mcp/tools.ts` into `project-registry.ts`, `response-decorators.ts`, `tools/<tool>.ts`; break `handleExplore` (~3.5K lines) into score → pin → fund → render stages with explicit state objects.
- Pure move-refactors first (no behaviour change, snapshot tests on explore output across the 7 README repos), then the fixes above land in the new homes.

> **Phase 3 progress (2026-10-05)** — three parallel branches plus a move-only refactor, merged and squashed into one commit.
> - ✅ 3.1 `coerceToolArgs` runs once per call on both dispatch paths, driven by each tool's `inputSchema`: non-object `arguments` → `{}` (or parsed JSON), finite numbers only, booleans/enums normalised; `clamp` returns `min` for non-finite input. Fixes `depth:"max"` → unbounded impact walk and the `arguments:"str"` TypeError.
> - ✅ 3.2 `src/mcp/error-classifier.ts` `classifyError` shared by `execute`, `executeReadTool`, query-worker and query-pool. Validation errors (#1403), unknown tools and `CODEGRAPH_MCP_TOOLS`-disabled tools are success-shaped guidance; the session no longer sends a JSON-RPC error for an unknown tool name. `projectPath` = file resolves from its directory; an *indexed* project under `~/.config` is allowed over MCP (CLI/viewer still refuse; `.ssh`, `.aws`, system dirs still refused). The pool's "shutting down" result is still `isError` (genuine malfunction class — left as is).
> - ✅ 3.3 `lookupSymbolNodes` (`src/graph/symbol-lookup.ts`) is the single name→node derivation for `codegraph_node`, callers/callees/impact and the CLI; no FTS 50-cap; never a fuzzy match as an answer; not-found returns "Did you mean" suggestions with the wrong-case spelling first (#1455).
> - ✅ 3.4 `src/mcp/file-glob.ts`: anchored, brace sets, `**/` matches root, per-segment matching with wildcard/brace caps (plain picomatch hung on adversarial patterns). Review fix on merge: a pattern with **no** glob syntax keeps the old substring behaviour so name fragments like `Button` still find files.
> - ✅ 3.5 (#2342) Explore admits COBOL `import` nodes only on an exact-name query; TS guard test proves no import noise elsewhere.
> - ✅ 3.6 (#1267) Verified opencode 1.18 double-prefixes; `CODEGRAPH_TOOL_PREFIX=none` / `serve --tool-prefix none` advertises bare names; `tools/call` accepts all three spellings in every mode; opencode's installer entry sets the env.
> - ✅ 3.7 Opt-in `codegraph gate-hook` (#2313): PreToolUse on `Grep|Glob|Bash|mcp__.*codegraph.*`; a codegraph call marks the session (`~/.codegraph/gate-sessions/<id>`, pruned after 24 h); fails open everywhere; installer default NO, never wired by `--yes`/refresh/upgrade. `.codegraph/instructions.md` appended to initialize instructions (#765, 4 KB cap, regular files only). AGENTS.md budget table and installer-instructions text corrected to match the code.
>   - ⏸ #1918 / #975 / #1080 need paid agent A/B runs (`scripts/agent-eval/`) against real repos — not run here.
> - ✅ 3.8 Move-only split of `src/mcp/tools.ts` (8602 → 5384 lines): `tool-definitions.ts`, `tool-args.ts`, `explore-budget.ts`, `explore-allocation.ts`, `project-registry.ts` (`ProjectRegistry` class: default project, project cache + idle release, catch-up gates, worktree/nested-repo caches), `explore-format.ts`, `explore-query.ts`, `response-decorators.ts`, `explore-sections.ts`, `tool-formatters.ts`; every old export re-exported. Byte-identity verified: 22 CLI commands on 4 indexed projects + 31 `ToolHandler.execute` calls vs the pre-split build — zero diffs. ⏸ Splitting `handleExplore` itself into stages needs a state-object rewrite (dozens of shared locals/closures), not a move — deferred.
> - Merge fixes: session conflict (bare-name aliasing + success-shaped unknown tool) resolved; `mcp-tool-prefix` test updated for the success-shaped unknown tool; Windows CI `--minWorkers=1` (vitest rejects `maxWorkers` < default min).

---

## Phase 4 — Resolution & extraction accuracy (weeks 2–6, parallelisable)

Each item: minimal repro test from the issue → fix → probe on 3 real repos → A/B if flow-affecting.

### 4.1 Cross-cutting resolution hygiene
- **R-RES2** `matchFuzzy` duplicated scope filter: extract one `candidateInScope` used by exact and fuzzy (`name-matcher.ts:5581-5640` vs `9447-9474`).
- **R-RES3** synthesis dedup keyed on `source>target>kind` (`callback-synthesizer.ts:4096`).
- **R-RES4** chain-shape early return keeps framework candidates and applies `isVisibleAcrossFiles`/Nix gates (`resolution/index.ts:1236`).
- **R-RES5** replace ~55 `slice(0, idx).split('\n').length` sites with `makeLineAt`.
- **R-RES6** shared `linkEdgesPass` for Next/TanStack/SvelteKit/Vue/React Router link synthesis; propagate the `=>`-safe tag regex.
- **R-RES7** add `provenance:'heuristic'` + `registeredAt` to `go-method-contains` and `jsx-render` edges.
- **R-RES9–14** escape names in `new RegExp` (`callback-synthesizer.ts:173`); optional route params `:id?` in `scorePath`; nearest-tsconfig-wins + `${configDir}` + prefix/suffix length check in `applyAliases`; alias forwarding re-applies all gates; `instantiates` promotion for `alsoTargets`; `ORDER BY` on `getNodesByLowerName`.

### 4.2 Language/framework issues
| Issue | Language | Work |
|---|---|---|
| #2340 | Vue/TS | Calls inside template expressions; top-level destructuring `const { a } = useFoo()`; read **all** `<script>` blocks (R-RES8) |
| #2300 | JS/TS | Object-literal members for non-exported consts, `window.X = {…}`, `ns.mod = {…}`, IIFE scope |
| #2322 | Go | Discover nested `go.mod` modules (per-module import root), not only repo root |
| #2323 | Go | Field-call resolution when receiver type is unexported |
| #2326 | Rust/Axum | Multi-line `.route(` (rustfmt-wrapped) → AST-based, not line regex |
| #2328 | Rust | Enum variant paths (`Mode::A`, match arms) reference the enum |
| #2327 | Dart | References from extension `on` type, field types, generic args in expressions/initializers |
| #2338 | Dart | Getter reads and enum-extension methods get callers |
| #2305 | VB.NET | Shared fields/properties + class-qualified access (remainder after Phase 0 re-test) |
| #1258 | C++ | Infix/subscript operator calls via receiver type inference |
| #1181 | C# | DI registrations, EF Core, partial classes (scope into sub-issues) |
| #1617 | Lua | Configurable custom module-loader functions |
| #1225 | Java/Spring | Review contributor's `<beans>` XML branch |
| #971, #300 | Micronaut, Drupal | Route extraction (per `framework-coverage.md`) |

### 4.3 `name-matcher.ts` decomposition (enabler) — R-RES arch
- `name-matcher/strategies/{exact,qualified,method-call,fuzzy,chains}.ts` + `name-matcher/lang/<lang>.ts` exporting a `LanguageScopeRules` object (pattern already proven by `vbnet-receivers.ts`, `swift-type-visibility.ts`). Move-only PRs gated on byte-identical graph output across the eval corpus.

### 4.4 Duplicated logic
- Route incremental store through `finalizeStoreBundle` (R-DB10); single `sfcFileNode`/file-node builder; schema DDL and the `SYNTHESIZED_EDGE` CASE expression as constants in one TS module instead of regex-scraped `schema.sql` (5 sites).

> **Phase 4 progress (2026-10-05)** — seven worktree branches cherry-picked onto `main` and squashed into one commit. Full suite green both with the native kernel staged (492 files / 6342 tests) and without it (476 files / 6085 tests); all 17 kernel parity suites pass on the combined kernel. `EXTRACTION_VERSION` bumped 28 → 29 (re-index advised).
> - ✅ 4.1 #2334: `matchDestructuredCallResult` scans each file once (LRU of 4, regex-literal edge case falls back to the exact old path; 0 mismatches over 46k calls); pretix indexing ~2× faster; work-counting test. R-RES2 shared `candidateScope` for exact+fuzzy; R-RES3 dedup includes kind; R-RES4 early return goes through `gateNameMatch` and competes with framework candidates; R-RES5 all 56 sites use cached `lineOfIndex`; R-RES9 escaped name + one split per caller file; R-RES10 optional `:id?`; R-RES11 `${configDir}` + length check; R-RES12/13/14 done. Output byte-identical on 6 real projects (apart from the new `registeredAt` on `jsx-render`). ⏸ R-RES7 `go-method-contains` left structural: #1988 tests pin it as non-heuristic — needs a maintainer decision.
> - ✅ 4.2 language issues: #2340 (Vue template + top-level destructuring calls, all `<script>` blocks), #2300 (object-literal members for non-exported / `window.X` / `ns.mod` / IIFE objects — kernel + wasm), R-RES6 shared `linkEdgesPass` with `=>`-safe tag regex for all five router synthesizers, #2322 (nested/multiple `go.mod`, longest-prefix module), #2323 (unexported Go receivers), #2326 (wrapped Axum/Actix routes), #2328 (Rust enum variant refs — kernel + wasm), #2327/#2338 (Dart type positions, getter reads, enum-extension methods — kernel + wasm), #2305 (VB.NET `Shared` member access — re-verified on the issue's repro: 2 callers each), #1258 (C++ infix/subscript operators via a resolution-time synthesizer, heuristic provenance), #1617 (Lua `loaderFunctions` in `codegraph.json`), #971 (Micronaut routes; all 226 routes on Kestra's webserver bound), #300 (Drupal OOP hooks, plugin attributes/annotations, services.yml; event-name mapping, `@service` args, autowired ids and Twig deferred), #1225 (Spring `<beans>` XML ported from @ESPINS's branch with heuristic provenance on the scan join and a cross-sync cache fix).
>   - ⏸ #1181 (C# DI / EF Core / NuGet / Lambda) is an epic — needs splitting into sub-issues before work. Upstream fixed #2299 separately (#2353) after this fork's base; expect a merge conflict when syncing with upstream.
> - ✅ 4.3 `name-matcher.ts` 10,489 → 29-line entry re-exporting `src/resolution/name-matcher/` (strategies/, lang/, receiver-inference, visibility, call-shape, candidate-scope …), moved by a checker-driven script; graph dumps byte-identical on 6 projects incl. the 13-language kernel-parity fixtures. ⏸ Per-language `LanguageScopeRules` objects need restructuring (not a move) — `candidateScope` is now isolated for that step.
> - ✅ 4.4 Incremental store now uses `finalizeStoreBundle` + `buildFileRecord` (no drift found; parity test); `src/db/schema-ddl.ts` replaces the 5 regex scrapes and makes `SYNTHESIZED_EDGE` one constant (EXPLAIN QUERY PLAN test); shared `buildFileNode` for tree-sitter/vue/svelte/astro (liquid/dfm/mybatis/cfml keep theirs — different ids). 12 byte-identical before/after dumps.

---

## Phase 5 — Installer, sync, and CLI correctness (weeks 2–4)

### 5.1 Config-file safety — R-6, R-7, R-9, R-16
- Gemini/Kiro/Antigravity: switch `readJsonFile`/`writeJsonFile` (`targets/shared.ts:65-129`) to `jsonc-parser` surgical edits; on parse failure **refuse** with guidance instead of replacing.
- `atomicWriteFileSync`: resolve symlinks and write to the real target; preserve file mode; re-read-and-compare before rename to reduce lost updates on `~/.claude.json`.
- Codex TOML (`targets/toml.ts`): preserve user keys under `[mcp_servers.codegraph]` on re-install/refresh; recognise header variants (`[ mcp_servers.codegraph ]`, quoted keys, inline table); uninstall removes `.env` subtables. Rename the misleading test at `installer-targets.test.ts:956` and fix its assertion.
- `isPromptHookCommand` exact match, not substring.
- Tests: JSONC with comments, symlinked config, 0600 mode, Codex user keys survive refresh.

### 5.2 Installer UX
- Don't offer `npm install -g` when running from the bundle (R-10); report real npm error, not "permission denied".
- #243 `--personal` flag writing to gitignored local config variants.
- #1274 shared implementation for opencode-fork targets; agent-target requests (#1535 ZCode, #1347 Grok Build, #1193/#1464 Qoder) roll into #649.

### 5.3 Git hooks — R-8
- `src/sync/git-hooks.ts:147-158`: insert the block before a trailing `exit`/`exec`; only touch shell hooks (shebang check); don't chmod a hook the user disabled; refuse to edit `core.hooksPath` dirs that are tracked (husky) or global without explicit flag.

### 5.4 CLI / environment
- Raise `engines` + `node-version-check.ts:50` minimum to 22.5 when running from source (R-12).
- `project-config.ts:428-446`: reject array/null config with an error; atomic write; distinguish EACCES from missing (R-15).
- `utils.ts:153-160`: realpath the parent on ENOENT (R-14).
- Remove dead `preuninstall` (R-17).
- #2299 ui-server: advance the port on `EACCES` too (`src/ui-server/index.ts:422`), Windows-gated test.

---

## Phase 6 — Viewer launch & issue hygiene (ongoing)

- **Viewer**: consolidate #1816, #1900, #1666, #1815 into one pinned "viewer launch" issue; at launch follow AGENTS.md (delete `viewer-gate.ts`, move `docs/viewer-launch-changelog.md` entries, drop "not released yet" notes from `site/`). #1956 zh-CN i18n after launch.
- **Duplicates → tracking issues** (#648 languages, #649 agent targets, #967 frameworks):
  - GDScript #1218/#1445/#1447/#1618; Bash #1068/#1203/#1899; Qoder #1193/#1464; index location #986/#1402/#924 (XDG); max file size #369/#1016; context compiler #1432/#1433/#1434.
- **Close as low-content** after a courtesy comment: #1469, #1367, #1021.
- **Language requests** (prioritise by demand in #648): GDScript, Bash/Shell, Protobuf (#1563), Haskell, Elixir, Zig, F#, Perl (#1738), SQL/Dataform (#1756), PowerShell, Crystal, Cython, LaTeX, Move, Ansible, Salam — each via the `/add-lang` workflow.
- **Feature backlog** (evaluate against "adapt the tool, don't change the agent"): #1798 background rebuild of stale indexes + #1852 MCP stale-index warning (do #1852 first, it's small); #1280 `--json` for explore/node; #1282/#1701 char budget for explore; #1520 FTS camelCase recall + column-weighted bm25; #1877/#1871 test-path and owning-manifest queries; #1236 shared index across worktrees; #1449/#1214 large-monorepo init performance (kernel coverage); #1550 android-arm64, #1261 musl, #781 Nix, #689 Homebrew; #2058 move procedures from AGENTS.md into `.claude/skills`.
- **Contributor outreach**: #2332 (bompus fork) — review which fork commits are upstreamable.

---

## Sequencing summary

| Week | Track A (core) | Track B (correctness) | Track C (hygiene) |
|---|---|---|---|
| 0–1 | Phase 0 release; 1.1 release hardening; 1.2 PR CI | 3.1 arg coercion; 3.2 error classifier | Triage comments, duplicate closures |
| 1–2 | 1.3 prompt-hook opt-out; 1.5 upgrade verification; 2.2 worker teardown | 3.3 node lookup; 3.4 glob; 3.5 #2342; 5.4 #2299 | 1.4 telemetry decision with maintainer |
| 2–3 | 2.1 #1887 heal; 2.4 transactions; 2.6 resolver caches | 4.1 resolution hygiene; 4.2 Go/Rust | 5.1 installer config safety; 5.3 git hooks |
| 3–4 | 2.3 FTS identity (+migration, re-index) | 4.2 Vue/JS/Dart/VB | 3.7 gate-hook #2313; 3.6 #1267 |
| 4–6 | 3.8 / 4.3 refactors (move-only, byte-identical) | Remaining 4.2 rows | Phase 6 backlog |

## Definition of done (per release)

- CI green on Linux, macOS, Windows; kernel parity tests pass.
- Agent-eval A/B on the 7 README repos shows no regression in Read/Grep count, tool calls, or wall-clock.
- `[Unreleased]` has a Highlights block and plain-language Fixes/New Features entries; re-index note if 2.3 lands.
- Every issue closed by the release gets a comment linking the release.
