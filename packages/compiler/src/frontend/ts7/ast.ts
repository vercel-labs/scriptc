/* Frontend AST helpers over the owned native TypeScript 7 node model.
 * Kind-specific interfaces refine its concrete getters and preserve object
 * identity. Guards and token spellings come from the pinned SDK generator;
 * this module does not import an SDK runtime implementation.
 *
 * Guards: 82 of the census's 90 is* guards re-export same-name; seven were
 * renamed in 7 (isParameter -> isParameterDeclaration and friends) and alias
 * back here; isExternalModule was dropped (the client SourceFile exposes
 * externalModuleIndicator instead) and is shimmed. isFunctionLike is the one
 * SEMANTIC rename: 7's isFunctionLikeDeclaration is narrower (declarations
 * only), so the shim composes 7's isSignatureDeclaration — the same kind set
 * 5.9.3's isFunctionLike accepts, minus the JSDoc closure-syntax function
 * type (tsgo dropped that node kind) — plus JSDocSignature.
 *
 * Helpers: the free-function forms 7 moved onto Node/SourceFile methods
 * (forEachChild, getLineAndCharacterOfPosition), and the pure-AST utilities
 * the package dropped (getCombinedNodeFlags/getCombinedModifierFlags/
 * canHaveModifiers/getModifiers), reimplemented from the 5.9.3 semantics
 * over 7's nodes with 7's enum values only. */

import type {
  AccessorDeclaration,
  GetAccessorDeclaration,
  Modifier,
  Node,
  NodeArray,
  ParameterDeclaration,
  PropertySignatureDeclaration,
  SetAccessorDeclaration,
  SignatureDeclaration,
  SourceFile,
  StringLiteralLikeNode,
} from "./ast-types.js";
import {
  isAccessorDeclaration,
  isBindingElement,
  isGetAccessorDeclaration,
  isJSDocSignature,
  isParameterDeclaration,
  isPropertySignatureDeclaration,
  isSetAccessorDeclaration,
  isSignatureDeclaration,
  isStringLiteralLikeNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
} from "./ast-guards.generated.js";
import type { Ts7DiagnosticData as Diagnostic } from "./session-schema.generated.js";
import { ModifierFlags, SyntaxKind } from "./enums.js";

/* ---- everything 7 kept under the same name ---- */

// The frontend's node types, guards and token spellings share the concrete
// AstNode layout. Parser and transform factories remain outside this client.
export * from "./ast-types.js";
export * from "./ast-guards.generated.js";
export { tokenToString } from "./ast-tokens.generated.js";

/* ---- the seven renamed guards, under their 5.9.3 names ---- */

export const isParameter: (node: Node | undefined) => node is ParameterDeclaration =
  isParameterDeclaration;
export const isPropertySignature: (node: Node | undefined) => node is PropertySignatureDeclaration =
  isPropertySignatureDeclaration;
export const isStringLiteralLike: (node: Node | undefined) => node is StringLiteralLikeNode =
  isStringLiteralLikeNode;
export const isGetAccessor: (node: Node | undefined) => node is GetAccessorDeclaration =
  isGetAccessorDeclaration;
export const isSetAccessor: (node: Node | undefined) => node is SetAccessorDeclaration =
  isSetAccessorDeclaration;
export const isAccessor: (node: Node | undefined) => node is AccessorDeclaration =
  isAccessorDeclaration;

/* ---- renamed types, under their 5.9.3 names ---- */

export type StringLiteralLike = StringLiteralLikeNode;
export type MethodSignature = import("./ast-types.js").MethodSignatureDeclaration;

/** 5.9.3's isFunctionLike: true for every SignatureDeclaration kind. 7's
 * same-set guard is isSignatureDeclaration (its isFunctionLikeDeclaration is
 * the narrower declarations-only check); JSDocSignature joins because 5.9.3
 * counts it. 5.9.3 also accepted JSDocFunctionType — a node kind tsgo no
 * longer produces, so no walk over a 7 AST can present one. */
export function isFunctionLike(node: Node | undefined): node is SignatureDeclaration {
  return isSignatureDeclaration(node) || isJSDocSignature(node);
}

/** 5.9.3's isExternalModule: 7 exposes the indicator on the SourceFile. */
export function isExternalModule(file: SourceFile): boolean {
  return file.externalModuleIndicator !== undefined;
}

/* ---- free-function forms 7 moved onto the nodes ---- */

export function forEachChild<T>(
  node: Node,
  cbNode: (node: Node) => T | undefined,
  cbNodes?: (nodes: NodeArray<Node>) => T | undefined,
): T | undefined {
  return node.forEachChild(cbNode, cbNodes);
}

/** Preorder walk over a whole subtree with an EXPLICIT stack. The idiomatic
 * recursive forEachChild visit costs two JS frames per AST level, so a
 * pathologically deep tree — the ~6500-term left-nested binary chain of the
 * binderBinaryExpressionStress corpus pair — overflows the stack as an ICE
 * before the lowering's SC1090 nesting fence (200 levels) ever sees the
 * expression. Whole-file sweeps (prefetch, require scans, `arguments`
 * detection) walk this way instead, so absurd nesting always reaches the
 * named fence. The callback may answer "skip" to leave a node's children
 * unvisited (scope and depth cut-offs — `depth` counts levels below the
 * root) or "stop" to end the walk early. */
export function walkPreorder(
  root: Node,
  cb: (node: Node, depth: number) => void | "skip" | "stop",
  kinds?: ReadonlySet<SyntaxKind>,
): void {
  const file = root.file;
  const stack: number[] = [root.index];
  const depths: number[] = [0];
  while (stack.length > 0) {
    const index = stack.pop()!;
    const depth = depths.pop()!;
    const node =
      kinds === undefined || kinds.has(file.wire.kind(index)) ? file.node(index) : undefined;
    const verdict = node === undefined ? undefined : cb(node, depth);
    if (verdict === "stop") return;
    if (verdict === "skip") continue;
    const first = stack.length;
    if (kinds === undefined) node!.appendChildIndices(stack);
    else file.wire.appendChildIndices(index, stack);
    // The wire visits siblings in source order. Reverse only this new
    // segment so the stack visits the first child before later siblings.
    for (let left = first, right = stack.length - 1; left < right; left++, right--) {
      const index = stack[left]!;
      stack[left] = stack[right]!;
      stack[right] = index;
    }
    for (let i = first; i < stack.length; i++) depths.push(depth + 1);
  }
}

export function getLineAndCharacterOfPosition(
  sourceFile: SourceFile,
  position: number,
): { line: number; character: number } {
  return sourceFile.getLineAndCharacterOfPosition(position);
}

/* ---- pure-AST utilities the package dropped ---- */

/* 5.9.3's canHaveModifiers kind set, spelled with 7's SyntaxKind keys (all
 * fifteen exist under the same names in 7; kinds are compared symbolically,
 * never numerically). */
const MODIFIER_HOSTS: ReadonlySet<number> = new Set<number>([
  SyntaxKind.TypeParameter,
  SyntaxKind.Parameter,
  SyntaxKind.PropertySignature,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.MethodSignature,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.IndexSignature,
  SyntaxKind.ConstructorType,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.ClassExpression,
  SyntaxKind.VariableStatement,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.ModuleDeclaration,
  SyntaxKind.ImportEqualsDeclaration,
  SyntaxKind.ImportDeclaration,
  SyntaxKind.ExportAssignment,
  SyntaxKind.ExportDeclaration,
]);

export function canHaveModifiers(node: Node): boolean {
  return MODIFIER_HOSTS.has(node.kind);
}

/** The node's modifier tokens, decorators excluded (5.9.3's getModifiers). */
export function getModifiers(node: Node): readonly Modifier[] | undefined {
  const modifiers = node.modifiers;
  if (modifiers === undefined) return undefined;
  return modifiers.filter((m): m is Modifier => m.kind !== SyntaxKind.Decorator);
}

/* Modifier token kind -> ModifierFlags bit, both sides 7's enums. */
function modifierToFlag(kind: number): number {
  switch (kind) {
    case SyntaxKind.StaticKeyword:
      return ModifierFlags.Static;
    case SyntaxKind.PublicKeyword:
      return ModifierFlags.Public;
    case SyntaxKind.ProtectedKeyword:
      return ModifierFlags.Protected;
    case SyntaxKind.PrivateKeyword:
      return ModifierFlags.Private;
    case SyntaxKind.AbstractKeyword:
      return ModifierFlags.Abstract;
    case SyntaxKind.AccessorKeyword:
      return ModifierFlags.Accessor;
    case SyntaxKind.AsyncKeyword:
      return ModifierFlags.Async;
    case SyntaxKind.ReadonlyKeyword:
      return ModifierFlags.Readonly;
    case SyntaxKind.OverrideKeyword:
      return ModifierFlags.Override;
    case SyntaxKind.ExportKeyword:
      return ModifierFlags.Export;
    case SyntaxKind.DeclareKeyword:
      return ModifierFlags.Ambient;
    case SyntaxKind.ConstKeyword:
      return ModifierFlags.Const;
    case SyntaxKind.DefaultKeyword:
      return ModifierFlags.Default;
    case SyntaxKind.InKeyword:
      return ModifierFlags.In;
    case SyntaxKind.OutKeyword:
      return ModifierFlags.Out;
    case SyntaxKind.Decorator:
      return ModifierFlags.Decorator;
    default:
      return ModifierFlags.None;
  }
}

function modifierFlagsOfNode(node: Node): number {
  const modifiers = node.modifiers;
  let flags = ModifierFlags.None as number;
  if (modifiers !== undefined) {
    for (const m of modifiers) flags |= modifierToFlag(m.kind);
  }
  // 5.9.3 counts an identifier-flagged this-keyword edge case we skip: it
  // only arises for parser-manufactured identifiers, which client walks
  // never observe.
  return flags;
}

/* The shared declaration-chain walk of 5.9.3's getCombinedNodeFlags /
 * getCombinedModifierFlags, mirrored exactly: a binding element climbs to
 * the declaration that hosts its outermost pattern; a variable declaration
 * merges its list's flags, the list its statement's. */
function walkUpBindingElementsAndPatterns(bindingElement: Node): Node | undefined {
  let node = bindingElement.parent; // the binding pattern
  while (node !== undefined && isBindingElement(node.parent)) {
    node = node.parent.parent;
  }
  return node?.parent; // VariableDeclaration or ParameterDeclaration
}

function getCombinedFlags(node: Node, getFlags: (n: Node) => number): number {
  let n: Node | undefined = isBindingElement(node) ? walkUpBindingElementsAndPatterns(node) : node;
  let flags = n === undefined ? 0 : getFlags(n);
  if (isVariableDeclaration(n)) n = n.parent;
  if (n !== undefined && isVariableDeclarationList(n)) {
    flags |= getFlags(n);
    n = n.parent;
  }
  if (n !== undefined && isVariableStatement(n)) {
    flags |= getFlags(n);
  }
  return flags;
}

/** 5.9.3's getCombinedNodeFlags (the Const/Let/Using answer for a
 * declaration, wherever in the binding chain the flag sits). */
export function getCombinedNodeFlags(node: Node): number {
  return getCombinedFlags(node, (n) => n.flags);
}

/** 5.9.3's getCombinedModifierFlags. */
export function getCombinedModifierFlags(node: Node): number {
  return getCombinedFlags(node, modifierFlagsOfNode);
}

/* ---- diagnostics text ---- */

/** 5.9.3's flattenDiagnosticMessageText, widened for the 7 world: 7's
 * Diagnostic carries flat text plus a messageChain of the same shape, so
 * this accepts either a plain string (already flat) or a 7 Diagnostic and
 * renders the chain with 5.9.3's indentation layout. */
export function flattenDiagnosticMessageText(
  diag: string | Diagnostic | undefined,
  newLine: string,
  indent = 0,
): string {
  if (diag === undefined) return "";
  if (typeof diag === "string") return diag;
  let result = "";
  if (indent > 0) {
    result += newLine;
    for (let i = 0; i < indent; i++) result += "  ";
  }
  result += diag.text;
  for (const child of diag.messageChain ?? []) {
    result += flattenDiagnosticMessageText(child, newLine, indent + 1);
  }
  return result;
}
