/**
 * VB.NET scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolutionContext } from '../../types';
import { hasNoReceiverOnLine } from '../call-shape';

const VB_MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'field', 'enum_member', 'constant', 'variable']);

/**
 * What a VB.NET member access is written on, read at the call site: the
 * extractor keeps a call's last name only, so `Me.CMB.Buttons.Add(x)` and
 * `New System.Drawing.Size(1, 2)` arrive as bare `Add` / `Size`. Returns null
 * for a genuinely bare name, `''` for a `With` block's `.Name`, else the
 * text before the dot (`Me.CMB.Buttons`, `System.Drawing`).
 */
export function vbReceiverOf(ref: UnresolvedRef, context: ResolutionContext): string | null {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return null;
  const lower = line.toLowerCase();
  const name = ref.referenceName.toLowerCase();
  let start = lower.startsWith(name, ref.column) ? ref.column : -1;
  if (start < 0) {
    // The reference starts at its receiver or its `New`, so the name is the
    // first one there or after: `st.Language = New Language(…)` constructs
    // a Language through no receiver, and `Me.Size = New System.Drawing.Size(…)`
    // through `System.Drawing`, not `Me`.
    const at = new RegExp(`(?<![\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'g');
    at.lastIndex = Math.max(0, ref.column);
    const m = at.exec(lower) ?? (at.lastIndex = 0, at.exec(lower));
    start = m ? m.index : -1;
  }
  if (start < 0) return null;
  const before = line.slice(0, start);
  const dot = /([\w.()]*?)\s*\.\s*$/.exec(before);
  if (!dot) return null;
  // `GetService(Of TrayNotifierService).Notify()` — the type argument names the receiver.
  const typeArg = /\(\s*Of\s+([\w.]+)\s*\)\s*\.\s*$/i.exec(before);
  if (typeArg) return typeArg[1]!;
  return dot[1]!.replace(/\([^()]*\)/g, '');
}

/**
 * Whether a VB.NET member access can mean `n`: through `Me` / `MyBase` /
 * `MyClass`, or through a name that is `n`'s own type or module
 * (`Module1.Log()`, `Colors.Red`). Any other receiver has a type nothing here
 * names — SCrawler's `New System.Drawing.Size(…)` went to a nested enum's
 * `Size` case 713 times, its designer's `Controls.Add(…)` to a collection
 * class's `Add` 547.
 */
export function isVbMemberReachable(n: Node, receiver: string): boolean {
  if (!VB_MEMBER_KINDS.has(n.kind)) return true;
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut < 0) return true;
  const last = receiver.split('.').pop()!.toLowerCase();
  if (/^(?:me|mybase|myclass)$/.test(last) && !receiver.includes('.')) return true;
  const owner = n.qualifiedName.slice(0, cut).split(/::|\./).pop()!.toLowerCase();
  return last !== '' && last === owner;
}

/**
 * Whether a VB.NET call has no receiver, or one the extractor drops (`Me`,
 * `MyClass`, `MyBase`) — a call isVbMemberInScope judges. A name its line
 * doesn't show (a link of a chain continued from the line above) is not.
 */
export function isVbScopedCall(ref: UnresolvedRef, receiver: string | null, context: ResolutionContext): boolean {
  if (ref.language !== 'vbnet' || ref.referenceKind !== 'calls' || !/^\w+$/.test(ref.referenceName)) return false;
  return receiver === null ? hasNoReceiverOnLine(ref, context) : /^(?:me|mybase|myclass)$/i.test(receiver);
}

/** Whether a VB.NET call or construction names its target with nothing before it (`New Point(4, 285)`). */
export function isVbUnqualifiedName(ref: UnresolvedRef, receiver: string | null, context: ResolutionContext): boolean {
  if (ref.language !== 'vbnet' || (ref.referenceKind !== 'calls' && ref.referenceKind !== 'instantiates')) return false;
  return receiver === null && /^\w+$/.test(ref.referenceName) && hasNoReceiverOnLine(ref, context);
}
