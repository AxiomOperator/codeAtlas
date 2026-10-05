/**
 * Freshness banners and footers prepended/appended to read-tool responses.
 * Moved out of `tools.ts` unchanged; re-exported from there.
 */

import type { PendingFile } from '../sync';

/**
 * Per-file staleness banner emitted at the top of a tool response when the
 * file watcher has pending events for files referenced by the response.
 * The agent uses this to fall back to Read for those specific files
 * without waiting for the debounced sync (issue #403).
 */
export function formatStaleBanner(stale: PendingFile[]): string {
  const now = Date.now();
  const lines = stale.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    const label = p.indexing ? 'indexing in progress' : 'pending sync';
    return `  - ${p.path} (edited ${ageMs}ms ago, ${label})`;
  });
  return (
    '⚠️ Some files referenced below were edited since the last index sync — ' +
    'their codegraph entries may be stale:\n' +
    lines.join('\n') +
    '\nFor accurate content of those specific files, Read them directly. ' +
    'The rest of this response is fresh.'
  );
}

/**
 * Compact footer listing pending files that are NOT referenced in this
 * response. Gives the agent a complete project-wide freshness picture
 * without bloating the main banner.
 */
export function formatStaleFooter(stale: PendingFile[]): string {
  const MAX = 5;
  const now = Date.now();
  const shown = stale.slice(0, MAX);
  const lines = shown.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    return `  - ${p.path} (edited ${ageMs}ms ago)`;
  });
  const more = stale.length > MAX ? `\n  - …and ${stale.length - MAX} more` : '';
  return (
    `(Note: ${stale.length} file(s) elsewhere in this project are pending index ` +
    `sync but were not referenced above:\n${lines.join('\n')}${more})`
  );
}

/**
 * Whole-index degradation banner (issue #876). Emitted at the top of a read
 * tool response when live watching has permanently stopped — at which point
 * `getPendingFiles()` is empty, so the per-file banner above can't fire even
 * though the index is now FROZEN and silently drifting stale. Leads with the
 * agent-actionable instruction (Read directly) and carries the reason, which
 * already names the operator remedy (`codegraph sync` / git hooks).
 */
export function formatDegradedBanner(reason: string | null): string {
  return (
    '⚠️ CodeGraph auto-sync is DISABLED — live file watching stopped, so the index is ' +
    'frozen and any file edited since then is stale here. Read files directly to confirm ' +
    'current content before relying on it.' +
    (reason ? `\n  Reason: ${reason}` : '')
  );
}

/** Re-armed watches are not proof of freshness until their full scan commits. */
export function formatRecoveringBanner(): string {
  return (
    '⚠️ CodeGraph auto-sync is RECOVERING — file watching restarted after lock contention, ' +
    'but the full index catch-up has not completed. Read files directly to confirm ' +
    'current content before relying on these results.'
  );
}
