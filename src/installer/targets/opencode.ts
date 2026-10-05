/**
 * opencode target — a spec over the shared opencode-family implementation
 * (`./opencode-family.ts`, #1274).
 *
 *   - MCP server entry to `~/.config/opencode/opencode.jsonc` (global,
 *     XDG-style on EVERY platform, Windows included) or `./opencode.jsonc`
 *     (local); `.json` when only that exists.
 *   - Instructions to `~/.config/opencode/AGENTS.md` / `./AGENTS.md`.
 *
 * Writes OpenCode 2's native `mcp.servers.codegraph` with `disabled: false`
 * and `codemode: false` (#1698); a pre-#1698 `mcp.codegraph` entry is
 * migrated on re-install and removed by uninstall.
 *
 * opencode alone carries the pre-#535 `%APPDATA%/opencode` sweep: earlier
 * installs wrote the global entry there on Windows, a dir opencode never
 * reads (it resolves its config with `xdg-basedir`).
 */

import { AgentTarget } from './types';
import { createOpencodeFamilyTarget } from './opencode-family';

export const opencodeTarget: AgentTarget = createOpencodeFamilyTarget({
  id: 'opencode',
  displayName: 'opencode',
  docsUrl: 'https://opencode.ai/docs/config',
  appName: 'opencode',
  schemaUrl: 'https://opencode.ai/config.json',
  entryShape: 'v2',
  legacyAppDataSweep: true,
});
