/**
 * Shared implementation for opencode and its forks (#1274).
 *
 * opencode forks keep its config format byte-for-byte — the same `mcp`
 * wrapper, the same `$schema`, XDG-only config-dir resolution, `.jsonc`
 * preferred over `.json`, and the `AGENTS.md` instructions convention — but
 * rename the app identity on disk (config dir under `~/.config/`, config
 * file base name). Each target is a small `OpencodeFamilySpec` over this.
 *
 *   - MCP server entry to `<xdg>/<app>/<app>.jsonc` (global — XDG on EVERY
 *     platform, Windows included: opencode resolves its dir with the
 *     `xdg-basedir` package, `XDG_CONFIG_HOME` else `~/.config`) or
 *     `./<app>.jsonc` (local). Falls back to `<app>.json` when only that
 *     exists; new installs get `.jsonc`, which is what opencode creates.
 *   - Instructions to `<xdg>/<app>/AGENTS.md` (global) or `./AGENTS.md`
 *     (local).
 *   - No permissions concept.
 *
 * Entry shapes:
 *   - `v2` — OpenCode 2's native `mcp.servers.<name>` with `disabled: false`
 *     and `codemode: false` (keeps `codegraph_explore` on the native tool
 *     list instead of behind Code Mode, #1698). Also read by opencode 1.18+.
 *     A pre-#1698 `mcp.codegraph` + `enabled` entry is migrated on install.
 *   - `v1` — the original `mcp.<name>` + `enabled: true`, for forks that
 *     branched before OpenCode 2.
 * Uninstall removes either shape.
 *
 * Reads + writes go through `jsonc-parser` so any `//` and `/* *\/`
 * comments survive; an unparseable file is refused, never replaced.
 *
 * Fork-specific history stays per-spec: the pre-#535 `%APPDATA%` sweep is
 * opencode's alone — a fork that never shipped those versions must never
 * touch `%APPDATA%`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { modify, applyEdits } from 'jsonc-parser';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  TargetId,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  ConfigParseError,
  jsonDeepEqual,
  parseJsoncForEdit,
  parseJsoncObject,
  removeMarkedSection,
  upsertInstructionsEntry,
  withConfigRefusal,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

export interface OpencodeFamilySpec {
  id: TargetId;
  displayName: string;
  docsUrl: string;
  /** Config dir name under the XDG config home AND the config file base name. */
  appName: string;
  /** `$schema` seeded into a new config (and added when missing). */
  schemaUrl: string;
  /** Which MCP entry shape this app reads — see the module comment. */
  entryShape: 'v1' | 'v2';
  /**
   * opencode only: pre-#535 installs wrote the global entry under
   * `%APPDATA%/<app>`, a dir the app never reads; install/uninstall sweep it.
   */
  legacyAppDataSweep?: boolean;
}

const FORMATTING = { tabSize: 2, insertSpaces: true, eol: '\n' };

/**
 * The fields every shape shares. opencode registers MCP tools as
 * `<server>_<tool>`, which turned `codegraph_explore` into
 * `codegraph_codegraph_explore` (#1267); serve bare names (`explore`) so the
 * model sees `codegraph_explore`. An env var rather than a `--tool-prefix`
 * flag so an older codegraph on PATH ignores it instead of refusing to start.
 */
function serverEntry(shape: 'v1' | 'v2'): Record<string, unknown> {
  const command = ['codegraph', 'serve', '--mcp'];
  const environment = { CODEGRAPH_TOOL_PREFIX: 'none' };
  return shape === 'v2'
    ? { type: 'local', command, disabled: false, codemode: false, environment }
    : { type: 'local', command, enabled: true, environment };
}

/** Path of the entry this shape writes. */
function entryPath(shape: 'v1' | 'v2'): string[] {
  return shape === 'v2' ? ['mcp', 'servers', 'codegraph'] : ['mcp', 'codegraph'];
}

/** True when either the OpenCode 2 native entry or a v1 entry is present. */
function hasCodegraphEntry(config: Record<string, any>): boolean {
  return !!(config.mcp?.servers?.codegraph || config.mcp?.codegraph);
}

function lenientParse(text: string): Record<string, any> {
  const parsed = parseJsoncObject(text);
  return parsed.ok ? parsed.value : {};
}

function readConfigText(file: string): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8');
}

class OpencodeFamilyTarget implements AgentTarget {
  readonly id: TargetId;
  readonly displayName: string;
  readonly docsUrl: string;

  constructor(private readonly spec: OpencodeFamilySpec) {
    this.id = spec.id;
    this.displayName = spec.displayName;
    this.docsUrl = spec.docsUrl;
  }

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  // ---- paths ---------------------------------------------------------

  private globalConfigDir(): string {
    // XDG_CONFIG_HOME if set, else ~/.config — on every platform, matching
    // opencode's own `xdg-basedir` resolution (no Windows special case; #535).
    const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), '.config');
    return path.join(xdg, this.spec.appName);
  }

  /**
   * The pre-#535 `%APPDATA%/<app>` dir when this spec sweeps it and it could
   * hold stale state. Gated on the env var rather than `process.platform` so
   * the cleanup runs under the cross-platform test suite; on POSIX, APPDATA
   * is unset in real life and this is a no-op.
   */
  private legacyAppDataDir(): string | null {
    if (!this.spec.legacyAppDataSweep) return null;
    const appData = process.env.APPDATA;
    if (!appData || !appData.trim()) return null;
    const legacy = path.join(appData, this.spec.appName);
    return path.resolve(legacy) === path.resolve(this.globalConfigDir()) ? null : legacy;
  }

  private baseDir(loc: Location): string {
    return loc === 'global' ? this.globalConfigDir() : process.cwd();
  }

  /** Existing `.jsonc`, then `.json`; `.jsonc` for new files. */
  private configPath(loc: Location): string {
    const dir = this.baseDir(loc);
    const jsonc = path.join(dir, `${this.spec.appName}.jsonc`);
    const json = path.join(dir, `${this.spec.appName}.json`);
    if (fs.existsSync(jsonc)) return jsonc;
    if (fs.existsSync(json)) return json;
    return jsonc;
  }

  private instructionsPath(loc: Location): string {
    return path.join(this.baseDir(loc), 'AGENTS.md');
  }

  // ---- AgentTarget ---------------------------------------------------

  detect(loc: Location): DetectionResult {
    const file = this.configPath(loc);
    const alreadyConfigured = hasCodegraphEntry(lenientParse(readConfigText(file)));
    // Global: the XDG dir is what the app creates on first run; a legacy
    // %APPDATA% dir still counts so a re-install can sweep it.
    const legacy = this.legacyAppDataDir();
    const installed = loc === 'global'
      ? fs.existsSync(this.globalConfigDir()) || (!!legacy && fs.existsSync(legacy))
      : fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(this.writeMcpEntry(loc));

    // AGENTS.md gets the short marker-fenced CodeGraph block (#704):
    // subagents and non-MCP harnesses read AGENTS.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    files.push(upsertInstructionsEntry(this.instructionsPath(loc)));

    if (loc === 'global') files.push(...this.cleanupLegacyAppData());
    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(this.removeMcpEntryAt(this.configPath(loc)));
    files.push(this.removeInstructionsEntry(loc));
    if (loc === 'global') files.push(...this.cleanupLegacyAppData());
    return { files };
  }

  printConfig(loc: Location): string {
    const target = this.configPath(loc);
    const config: Record<string, any> = { $schema: this.spec.schemaUrl, mcp: {} };
    if (this.spec.entryShape === 'v2') config.mcp.servers = { codegraph: serverEntry('v2') };
    else config.mcp.codegraph = serverEntry('v1');
    return `# Add to ${target}\n\n${JSON.stringify(config, null, 2)}\n`;
  }

  describePaths(loc: Location): string[] {
    return [this.configPath(loc), this.instructionsPath(loc)];
  }

  // ---- writes --------------------------------------------------------

  private writeMcpEntry(loc: Location): WriteResult['files'][number] {
    const file = this.configPath(loc);
    const existed = fs.existsSync(file);
    let text = readConfigText(file);

    // Seed a minimal config when the file is brand-new so the result is a
    // complete, schema-tagged file (not just a bare `{ "mcp": {...} }`).
    if (!text.trim()) {
      text = `{\n  "$schema": ${JSON.stringify(this.spec.schemaUrl)}\n}\n`;
    }

    const config = parseJsoncForEdit(text, file);
    const shape = this.spec.entryShape;
    const before = shape === 'v2' ? config.mcp?.servers?.codegraph : config.mcp?.codegraph;
    const after = serverEntry(shape);
    // OpenCode 2: a pre-#1698 `mcp.codegraph` must go, so only the native
    // entry (where `codemode` survives normalization) remains.
    const hasLegacy = shape === 'v2' && !!config.mcp?.codegraph;

    if (jsonDeepEqual(before, after) && !hasLegacy) {
      return { path: file, action: 'unchanged' };
    }

    if (!config.$schema) {
      text = applyEdits(text, modify(text, ['$schema'], this.spec.schemaUrl, { formattingOptions: FORMATTING }));
    }
    if (hasLegacy) {
      text = applyEdits(text, modify(text, ['mcp', 'codegraph'], undefined, { formattingOptions: FORMATTING }));
    }
    // Surgical edit — preserves comments, formatting, and order of every
    // key we don't touch.
    const updated = applyEdits(text, modify(text, entryPath(shape), after, { formattingOptions: FORMATTING }));
    atomicWriteFileSync(file, updated);
    return { path: file, action: existed ? 'updated' : 'created' };
  }

  /**
   * Surgically drop our CodeGraph entry from one config file — either shape.
   * Leaves sibling servers, comments, and formatting untouched; drops
   * emptied `mcp.servers` / `mcp` wrappers too.
   */
  private removeMcpEntryAt(file: string): WriteResult['files'][number] {
    if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
    const text = readConfigText(file);
    const config = parseJsoncForEdit(text, file);
    if (!hasCodegraphEntry(config)) return { path: file, action: 'not-found' };

    const drop = (t: string, p: string[]) => applyEdits(t, modify(t, p, undefined, { formattingOptions: FORMATTING }));
    let updated = text;
    if (config.mcp?.servers?.codegraph) updated = drop(updated, ['mcp', 'servers', 'codegraph']);
    // Re-parse after the native removal so a file that held BOTH shapes
    // (possible mid-migration) still drops the v1 leftover.
    if (lenientParse(updated).mcp?.codegraph) updated = drop(updated, ['mcp', 'codegraph']);

    let afterParsed = lenientParse(updated);
    if (afterParsed.mcp?.servers && typeof afterParsed.mcp.servers === 'object' &&
        Object.keys(afterParsed.mcp.servers).length === 0) {
      updated = drop(updated, ['mcp', 'servers']);
      afterParsed = lenientParse(updated);
    }
    if (afterParsed.mcp && typeof afterParsed.mcp === 'object' &&
        Object.keys(afterParsed.mcp).length === 0) {
      updated = drop(updated, ['mcp']);
    }

    atomicWriteFileSync(file, updated);
    return { path: file, action: 'removed' };
  }

  /**
   * Remove whatever a pre-#535 install left in `%APPDATA%/<app>` — an MCP
   * entry the app never reads, plus our AGENTS.md block. Returns only files
   * actually changed. Never touches anything else in the legacy dir, and
   * skips (never fails the install over) a legacy file it can't parse.
   */
  private cleanupLegacyAppData(): WriteResult['files'] {
    const dir = this.legacyAppDataDir();
    if (!dir || !fs.existsSync(dir)) return [];
    const out: WriteResult['files'] = [];
    for (const name of [`${this.spec.appName}.jsonc`, `${this.spec.appName}.json`]) {
      try {
        const res = this.removeMcpEntryAt(path.join(dir, name));
        if (res.action === 'removed') out.push(res);
      } catch (err) {
        if (!(err instanceof ConfigParseError)) throw err;
      }
    }
    const agents = path.join(dir, 'AGENTS.md');
    const action = removeMarkedSection(agents, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
    if (action === 'removed') out.push({ path: agents, action });
    return out;
  }

  /**
   * Strip the marker-delimited CodeGraph block from AGENTS.md if a prior
   * install wrote one (issue #529).
   */
  private removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
    const file = this.instructionsPath(loc);
    const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
    return { path: file, action };
  }
}

/** Build an opencode-family `AgentTarget` from its spec. */
export function createOpencodeFamilyTarget(spec: OpencodeFamilySpec): AgentTarget {
  return withConfigRefusal(new OpencodeFamilyTarget(spec));
}
