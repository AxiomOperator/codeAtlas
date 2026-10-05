/**
 * The single schema-driven argument-coercion step every tool call passes
 * through. Moved out of `tools.ts` unchanged; re-exported from there.
 */

import { ToolInputError } from './error-classifier';
import { tools } from './tool-definitions';

/** A short, safe description of an argument value for guidance text. */
export function describeArgValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return value.length === 0 ? 'an empty string' : 'a string';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/**
 * The single argument-coercion step every tool call passes through before a
 * handler sees it, driven by the tool's own `inputSchema` (so the schema stays
 * the one source of truth for what a tool accepts):
 *
 * - `arguments` that is not a plain object (a string, array, number, null) —
 *   some clients send the JSON as a string — is parsed when it is a JSON
 *   object, else replaced by `{}`. The handler then answers with its usual
 *   success-shaped "x must be a non-empty string" guidance instead of throwing
 *   a TypeError deep in dispatch.
 * - a `number` property must be a finite number. A numeric string ("5") is
 *   converted; anything else (`"max"`, `null`, `NaN`, `Infinity`, an object) is
 *   DROPPED so the handler's default applies. Before this, `clamp("max" || 2)`
 *   produced `NaN`, which disabled the impact depth limit and explore's
 *   `maxFiles` stop condition.
 * - a `boolean` property accepts `"true"`/`"false"`; any other non-boolean is
 *   dropped (default applies).
 * - an `enum` property is matched case-insensitively; a value outside the enum
 *   throws {@link ToolInputError} naming the allowed values — dropping it would
 *   silently widen a filter (e.g. `kind`).
 *
 * Unknown keys are preserved untouched (internal side channels ride on args).
 * Never mutates the caller's object. Idempotent, so the worker path may run it
 * again on already-coerced args.
 */
export function coerceToolArgs(toolName: string, raw: unknown): Record<string, unknown> {
  let obj: Record<string, unknown>;
  if (typeof raw === 'string') {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
    obj = isPlainArgsObject(parsed) ? { ...parsed } : {};
  } else {
    obj = isPlainArgsObject(raw) ? { ...raw } : {};
  }
  const def = tools.find((t) => t.name === toolName);
  const props = (def?.inputSchema as { properties?: Record<string, { type?: string; enum?: unknown[] }> } | undefined)
    ?.properties;
  if (!props) return obj;
  for (const [key, schema] of Object.entries(props)) {
    if (!(key in obj)) continue;
    const value = obj[key];
    if (schema.type === 'number') {
      const n = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : NaN;
      if (Number.isFinite(n)) obj[key] = n;
      else delete obj[key];
    } else if (schema.type === 'boolean') {
      if (typeof value === 'boolean') continue;
      if (value === 'true' || value === 'false') obj[key] = value === 'true';
      else delete obj[key];
    } else if (Array.isArray(schema.enum)) {
      if (value === undefined || value === null || value === '') { delete obj[key]; continue; }
      const allowed = schema.enum as unknown[];
      if (allowed.includes(value)) continue;
      const match = typeof value === 'string'
        ? allowed.find((a) => typeof a === 'string' && a.toLowerCase() === value.trim().toLowerCase())
        : undefined;
      if (match !== undefined) {
        obj[key] = match;
      } else {
        throw new ToolInputError(
          `${key} must be one of: ${allowed.map((a) => JSON.stringify(a)).join(', ')} ` +
          `(got ${typeof value === 'string' ? JSON.stringify(value.slice(0, 100)) : describeArgValue(value)})`
        );
      }
    }
  }
  return obj;
}

export function isPlainArgsObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
