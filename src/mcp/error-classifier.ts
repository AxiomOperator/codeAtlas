/**
 * The ONE place an MCP tool failure becomes a {@link ToolResult}.
 *
 * Every path that turns a thrown error into a tool response — the in-process
 * dispatch ({@link ToolHandler.execute}), the read-tool entry the query workers
 * run ({@link ToolHandler.executeReadTool}), the worker's own belt-and-braces
 * catch, and the pool's crash/shutdown settles — goes through here, so a given
 * condition answers with the same SHAPE whichever thread served it.
 *
 * The shape is the contract (AGENTS.md, "Errors teach abandonment"): one or two
 * `isError: true` responses early in a session and the agent stops calling
 * codegraph entirely. So `isError` is reserved for "stop trying" cases —
 * security refusals ({@link PathRefusalError}) and genuine malfunctions (which
 * carry a retry-once note). Every expected, recoverable condition answers
 * SUCCESS-shaped with guidance text.
 *
 * Kept free of the heavy engine chain so the query worker and pool can load it
 * without pulling in `tools.ts`.
 */

import { WslSharedIndexError } from '../db/wsl-shared-index';
import { PathRefusalError } from '../errors';
import type { ToolResult } from './tools';

/**
 * An expected, recoverable "codegraph can't serve this" condition — most
 * importantly a project with no index. Classified SUCCESS-shaped (guidance
 * text, NO isError): an `isError: true` early in a session teaches the agent
 * the toolset is broken and it stops calling codegraph entirely (observed
 * repeatedly), which is exactly wrong for conditions the agent can simply work
 * around (use built-in tools for that codebase / pass projectPath).
 */
export class NotIndexedError extends Error {}

/**
 * A bad tool call the agent can fix by itself: a missing/oversized argument,
 * a tool name this server doesn't expose, a tool disabled by
 * `CODEGRAPH_MCP_TOOLS`. Classified SUCCESS-shaped — the call was wrong, the
 * toolset is fine, and the text says how to call it correctly.
 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/**
 * The Windows/WSL shared-index failure (#995) phrased for the agent. It is an
 * expected condition the USER fixes in their environment, so like
 * {@link NotIndexedError} it answers SUCCESS-shaped — never `isError`, which
 * would teach the agent to abandon codegraph for projects that work fine.
 */
export function wslSharedIndexGuidance(err: WslSharedIndexError): string {
  return (
    `${err.message}\n\n` +
    "If you are an AI agent: codegraph can't read this project's index from WSL until the user " +
    'makes that change. Use your built-in tools (Read/Grep/Glob) for this task and pass the message ' +
    "above on to the user — setting CODEGRAPH_DIR and building the index are the user's decisions, " +
    "so don't do either yourself."
  );
}

/** A plain success-shaped result. */
export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Success-shaped guidance for a call the agent can correct (see {@link ToolInputError}). */
export function inputGuidanceResult(message: string): ToolResult {
  return textResult(
    `Invalid tool call: ${message}. Fix the arguments and call again — the codegraph tools ` +
    'themselves are working.'
  );
}

/** A genuine malfunction: `isError`, with a retry-once note. */
export function internalErrorResult(message: string): ToolResult {
  return {
    content: [{
      type: 'text',
      text:
        `Error: Tool execution failed: ${message}. ` +
        'This is an internal codegraph error — retry the call once; if it persists, ' +
        'continue without codegraph for this task.',
    }],
    isError: true,
  };
}

/** A security refusal: `isError`, deliberately WITHOUT retry encouragement. */
export function refusalResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/**
 * Classify a thrown error into a tool response. Never throws.
 *
 * - {@link NotIndexedError}, a running `codegraph index` rebuild
 *   (`RebuildInProgressError`, matched by name so this module stays free of
 *   the writer-lock module, #1325) → success-shaped guidance.
 * - {@link ToolInputError} → success-shaped "fix the call" guidance.
 * - {@link WslSharedIndexError} → success-shaped user-fix guidance (#995).
 * - {@link PathRefusalError} → clean error, no retry encouragement.
 * - anything else → internal error with a retry-once note.
 */
export function classifyError(err: unknown): ToolResult {
  if (err instanceof NotIndexedError || (err as Error | null)?.name === 'RebuildInProgressError') {
    return textResult((err as Error).message);
  }
  if (err instanceof ToolInputError) {
    return inputGuidanceResult(err.message);
  }
  if (err instanceof WslSharedIndexError) {
    return textResult(wslSharedIndexGuidance(err));
  }
  if (err instanceof PathRefusalError) {
    return refusalResult(err.message);
  }
  return internalErrorResult(err instanceof Error ? err.message : String(err));
}
