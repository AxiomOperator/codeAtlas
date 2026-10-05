/**
 * User choices the installer must remember across runs.
 *
 * Stored in `~/.codegraph/preferences.json`. Today it holds one thing: whether
 * the user declined the Claude Code front-load prompt hook. Without it, an
 * opt-out at install time was forgotten and the next `codegraph upgrade`
 * wired the hook straight back in.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface InstallerPreferences {
  /** `declined`: never wire the prompt hook automatically. */
  promptHook?: 'accepted' | 'declined';
}

export function preferencesPath(): string {
  return path.join(os.homedir(), '.codegraph', 'preferences.json');
}

export function readPreferences(): InstallerPreferences {
  try {
    const parsed = JSON.parse(fs.readFileSync(preferencesPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the stored preferences. Never throws: a preference is not worth failing an install over. */
export function writePreferences(patch: InstallerPreferences): void {
  try {
    const next = { ...readPreferences(), ...patch };
    const file = preferencesPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch {
    /* best effort */
  }
}

export function promptHookDeclined(): boolean {
  return readPreferences().promptHook === 'declined';
}
