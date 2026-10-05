/**
 * Objective-C scope, visibility and receiver rules used by the name matcher.
 *
 * Part of the name matcher (see ../name-matcher.ts, one level up).
 */

import { Node } from '../../../types';
import { UnresolvedRef, ResolutionContext } from '../../types';

export const OBJC_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();
export const OBJC_MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'field']);

/**
 * How a bare Objective-C name is written at its site: `c-call` for C call
 * syntax (`completionBlock()` — a function, a block or a function pointer,
 * never a method), `self-send` for a message to `self` / `super` /
 * `[self class]`, whose receiver the extractor drops; null otherwise.
 */
export function objcCallShape(ref: UnresolvedRef, context: ResolutionContext): 'c-call' | 'self-send' | 'super-send' | null {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return null;
  const name = ref.referenceName.split(':')[0]!;
  if (!name) return null;
  const at = new RegExp(`(?<![\\w.])${name}\\b`, 'g');
  let m: RegExpExecArray | null;
  let shape: 'c-call' | 'self-send' | 'super-send' | null = null;
  while ((m = at.exec(line))) {
    const before = line.slice(0, m.index);
    const after = line.slice(m.index + name.length);
    if (/^\s*\(/.test(after) && !/\[\s*[\w.]+\s+$/.test(before)) shape ??= 'c-call';
    else if (/\[\s*super\s+$/.test(before)) return 'super-send';
    else if (/\[\s*(?:self|\[\s*self\s+class\s*\])\s+$/.test(before)) return 'self-send';
  }
  return shape;
}

/**
 * The classes a message to `self` / `super` can reach: the class it is
 * written in and every class that one inherits from (read from its
 * `@interface Name : Super` declarations; category methods are indexed under
 * the class they extend). Null outside any class.
 */
function objcHierarchyAt(ref: UnresolvedRef, context: ResolutionContext): Set<string> | null {
  const inFile = context.getNodesInFile(ref.filePath);
  let here = inFile
    .filter((c) => c.kind === 'class' && c.startLine <= ref.line && c.endLine >= ref.line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0]?.name;
  // An `@implementation` whose range the index lost still names its class in
  // its methods: `SDWebImageDownloaderDecryptor::initWithBlock:`.
  if (!here) {
    const method = inFile.find((c) => c.kind === 'method' && c.startLine <= ref.line && c.endLine >= ref.line && c.qualifiedName.includes('::'));
    here = method?.qualifiedName.slice(0, method.qualifiedName.lastIndexOf('::'));
  }
  if (!here) return null;
  const seen = new Set<string>();
  const queue = [here];
  while (queue.length > 0 && seen.size < 30) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...objcSupertypesOf(name, context));
  }
  return seen;
}

/**
 * Whether a message to `self` / `super` can mean `n`: a method of a class in
 * the sender's hierarchy — SDWebImage's `[self class]` went to SDWeakProxy's
 * `class` 71 times. When tree-sitter-objc loses an `@implementation`
 * (AFNetworking's AFURLSessionManager) its methods are indexed as functions:
 * one in the sender's own file, or in the file named after a class of its
 * hierarchy, still counts (as does any, when the sender's own class was lost
 * too). A function elsewhere is never what `[super init]` sends to.
 */
export function isObjcSelfSendTarget(n: Node, ref: UnresolvedRef, context: ResolutionContext, toSuper = false): boolean {
  const hierarchy = objcHierarchyAt(ref, context);
  if (OBJC_MEMBER_KINDS.has(n.kind)) {
    const cut = n.qualifiedName.lastIndexOf('::');
    if (cut < 0 || hierarchy === null) return true;
    const owner = n.qualifiedName.slice(0, cut);
    // `[super init]` goes past the class it is written in.
    return hierarchy.has(owner) && !(toSuper && owner === [...hierarchy][0]);
  }
  if (n.filePath === ref.filePath) return !toSuper;
  if (hierarchy === null) return true;
  const base = n.filePath.slice(n.filePath.lastIndexOf('/') + 1).replace(/\.\w+$/, '');
  return hierarchy.has(base) && !(toSuper && base === [...hierarchy][0]);
}

/**
 * UIKit / AppKit superclasses, for a category on a system class: an
 * `UIImageView (WebCache)` method sending `[self sd_internalSetImageWithURL:…]`
 * reaches the `UIView (WebCache)` category.
 */
export const OBJC_SYSTEM_SUPERS: Readonly<Record<string, string>> = {
  UIResponder: 'NSObject', UIView: 'UIResponder', UIViewController: 'UIResponder', UIWindow: 'UIView',
  UIControl: 'UIView', UIButton: 'UIControl', UITextField: 'UIControl', UISwitch: 'UIControl', UISlider: 'UIControl',
  UISegmentedControl: 'UIControl', UIStepper: 'UIControl', UIPageControl: 'UIControl', UIDatePicker: 'UIControl',
  UIRefreshControl: 'UIControl', UIStackView: 'UIView', UINavigationBar: 'UIView', UIToolbar: 'UIView',
  UITabBar: 'UIView', UISearchBar: 'UIView', UIVisualEffectView: 'UIView', UIActivityIndicatorView: 'UIView',
  UIProgressView: 'UIView', UIPickerView: 'UIView', UITableViewHeaderFooterView: 'UIView',
  UITableViewController: 'UIViewController', UICollectionViewController: 'UIViewController',
  UINavigationController: 'UIViewController', UITabBarController: 'UIViewController',
  UIPageViewController: 'UIViewController', UISplitViewController: 'UIViewController',
  UIAlertController: 'UIViewController', UIHostingController: 'UIViewController',
  UIImageView: 'UIView', UILabel: 'UIView', UIScrollView: 'UIView', UITableView: 'UIScrollView',
  UICollectionView: 'UIScrollView', UITextView: 'UIScrollView', UITableViewCell: 'UIView',
  UICollectionReusableView: 'UIView', UICollectionViewCell: 'UICollectionReusableView',
  MKAnnotationView: 'UIView', MKMapView: 'UIView',
  NSResponder: 'NSObject', NSView: 'NSResponder', NSViewController: 'NSResponder', NSWindow: 'NSResponder',
  NSControl: 'NSView', NSImageView: 'NSControl', NSButton: 'NSControl', NSTextField: 'NSControl', NSTableView: 'NSControl',
};

/**
 * Whether an Objective-C receiver's type owns `method`, in its hierarchy: the
 * receiver names a class (`[AllTypesObject objectsInRealm:…]` — a class
 * method inherited from RLMObject), or is a property one of whose
 * `@property … Type *name` declarations gives such a type
 * (`managed.anyDataObj` → RLMSet, for `containsObject:`).
 */
export function objcReceiverReaches(receiver: string, method: Node, context: ResolutionContext): boolean {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut < 0) return false;
  const owner = method.qualifiedName.slice(0, cut);
  let types: string[] = [];
  if (/^[A-Z]\w*$/.test(receiver)) {
    if (context.getNodesByName(receiver).some((n) => n.kind === 'class' && n.language === 'objc')) types = [receiver];
  } else if (receiver.includes('.')) types = objcPropertyTypes(receiver.split('.').pop()!, context);
  const seen = new Set<string>();
  const queue = [...types];
  while (queue.length > 0 && seen.size < 40) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === owner) return true;
    queue.push(...objcSupertypesOf(name, context));
  }
  return false;
}

/** The classes the `@property … Type *name` declarations of `name` give. */
function objcPropertyTypes(name: string, context: ResolutionContext): string[] {
  const types = new Set<string>();
  const decl = new RegExp(`@property\\s*(?:\\([^)]*\\)\\s*)?([A-Z]\\w*)\\s*(?:<[^;]*>\\s*)?\\*\\s*(?:_Nullable\\s+|_Nonnull\\s+)?${name}\\b`);
  for (const n of context.getNodesByName(name)) {
    if (n.kind !== 'property' || n.language !== 'objc') continue;
    const line = context.getFileLines?.(n.filePath)?.[n.startLine - 1] ?? context.readFile(n.filePath)?.split('\n')[n.startLine - 1] ?? '';
    const t = decl.exec(line)?.[1];
    if (t) types.add(t);
  }
  return [...types];
}

/** The superclasses an Objective-C class's `@interface` declarations name. */
export function objcSupertypesOf(name: string, context: ResolutionContext): string[] {
  let memo = OBJC_SUPERS.get(context);
  if (!memo) OBJC_SUPERS.set(context, (memo = new Map()));
  const hit = memo.get(name);
  if (hit) return hit;
  const supers: string[] = [];
  for (const decl of context.getNodesByName(name)) {
    if (decl.kind !== 'class' || decl.language !== 'objc') continue;
    const line = context.getFileLines?.(decl.filePath)?.[decl.startLine - 1] ?? context.readFile(decl.filePath)?.split('\n')[decl.startLine - 1] ?? '';
    const sup = /@interface\s+\w+\s*:\s*(\w+)/.exec(line)?.[1];
    if (sup && !supers.includes(sup)) supers.push(sup);
  }
  const system = OBJC_SYSTEM_SUPERS[name];
  if (supers.length === 0 && system) supers.push(system);
  memo.set(name, supers);
  return supers;
}
