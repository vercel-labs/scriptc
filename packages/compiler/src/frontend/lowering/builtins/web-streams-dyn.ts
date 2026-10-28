import { numLit } from "../../../ir/build.js";
import { BOOL, DYN, STRING, type IrExpr, type SrcLoc } from "../../../ir/ir.js";
import * as ts from "../../ts7/adapter.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { constituentTypes } from "../../ts7/checker.js";
import type { Lowerer } from "../lowerer.js";
import { stdlibGlobalNameOf } from "../surfaces.js";
import { streamWebImportOf } from "./module-bindings.js";

/* The web stream classes in JavaScript sources: the globals and the
 * node:stream/web exports, which are the same constructors. Each reference
 * is the class's constructor value (scr_webstreams.c, webstream.class), so
 * construction, static members, prototypes and instanceof go through the
 * checked-dynamic paths over that value. TypeScript sources keep their
 * static lowerings (lower-stdlib.ts). */

/** The classes in scr_webstream_class's order. */
export const WEB_STREAM_CLASSES = [
  "ReadableStream",
  "ReadableStreamDefaultReader",
  "ReadableStreamDefaultController",
  "CountQueuingStrategy",
  "ByteLengthQueuingStrategy",
  "WritableStream",
  "WritableStreamDefaultWriter",
  "WritableStreamDefaultController",
  "TransformStream",
  "TransformStreamDefaultController",
  "TextEncoderStream",
  "TextDecoderStream",
] as const;

const CLASS_NAMES: readonly string[] = WEB_STREAM_CLASSES;

function unparenthesized(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** The class a JavaScript expression names (an identifier bound to the
 * global or to a node:stream/web import, or a member of the global
 * object), as its index in WEB_STREAM_CLASSES; null otherwise. */
export function webStreamClassKindOf(lowerer: Lowerer, node: ts.Expression): number | null {
  const expr = unparenthesized(node);
  if (!ts.isIdentifier(expr) && !ts.isPropertyAccessExpression(expr)) return null;
  if (!isJsSourceFile(ts.getSourceFileOfNode(expr))) return null;
  const member = ts.isPropertyAccessExpression(expr) ? lowerer.builtinMemberOf(expr) : null;
  const name =
    (ts.isIdentifier(expr) ? streamWebImportOf(lowerer, expr) : null) ??
    (member?.module === "stream/web" ? member.member : null) ??
    stdlibGlobalNameOf(lowerer, expr);
  if (name === null) return null;
  const index = CLASS_NAMES.indexOf(name);
  return index < 0 ? null : index;
}

/** Whether a JavaScript source of the program names one of the classes.
 * The global object answers them by a computed name only then
 * (global-values.ts), so a program without web streams does not link
 * them for its other computed global reads. */
export function programNamesWebStreamClass(lowerer: Lowerer): boolean {
  if (lowerer.namesWebStreamClass !== undefined) return lowerer.namesWebStreamClass;
  const names: ReadonlySet<string> = new Set(WEB_STREAM_CLASSES);
  let found = false;
  for (const file of lowerer.program.getSourceFiles()) {
    if (file.isDeclarationFile || !isJsSourceFile(file)) continue;
    ts.walkPreorder(file, (node) => {
      if (
        ts.isIdentifier(node) &&
        names.has(node.text) &&
        webStreamClassKindOf(lowerer, node) !== null
      ) {
        found = true;
        return "stop";
      }
      return undefined;
    });
    if (found) break;
  }
  lowerer.namesWebStreamClass = found;
  return found;
}

export function webStreamClassValue(kind: number, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "webstream.class", args: [numLit(kind, loc)], type: DYN, loc };
}

/** A JavaScript read of one of the classes as a value; null otherwise. */
export function lowerWebStreamClassRead(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  const kind = webStreamClassKindOf(lowerer, node);
  return kind === null ? null : webStreamClassValue(kind, locOf(node));
}

/** `new X(...args)` on one of the classes in JavaScript. */
export function lowerWebStreamNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const kind = webStreamClassKindOf(lowerer, expr.expression);
  if (kind === null) return null;
  const nodes = expr.arguments?.nodes ?? [];
  if (nodes.some(ts.isSpreadElement)) return null;
  const loc = locOf(expr);
  return {
    kind: "libCall",
    fn: "dyn.construct",
    args: [
      webStreamClassValue(kind, loc),
      {
        kind: "dynArrLit",
        elems: nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
        type: DYN,
        loc,
      },
      { kind: "strLit", value: CLASS_NAMES[kind]!, type: STRING, loc },
    ],
    type: DYN,
    loc,
  };
}

/** `X.from(…)` and other calls of a class's static members in JavaScript:
 * a member call on the constructor value. */
export function lowerWebStreamStaticCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const access = call.expression;
  if (call.questionDotToken || !ts.isPropertyAccessExpression(access) || access.questionDotToken)
    return null;
  const kind = webStreamClassKindOf(lowerer, access.expression);
  if (kind === null) return null;
  const nodes = call.arguments.nodes;
  if (nodes.some(ts.isSpreadElement)) return null;
  const loc = locOf(call);
  return {
    kind: "dynInvoke",
    recv: webStreamClassValue(kind, locOf(access.expression)),
    method: access.name.text,
    calleeName: ts.getTextOfNode(access),
    args: nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc,
  };
}

/** `value instanceof X` on one of the classes in JavaScript. */
export function lowerWebStreamInstanceof(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  const kind = webStreamClassKindOf(lowerer, expr.right);
  if (kind === null) return null;
  const loc = locOf(expr);
  return {
    kind: "libCall",
    fn: "webstream.instanceOf",
    args: [lowerer.lowerExprExpecting(expr.left, DYN), numLit(kind, loc)],
    type: BOOL,
    loc,
  };
}

/** The ambient web stream interfaces whose members JavaScript reads from
 * checked-dynamic values. */
const WEB_STREAM_INTERFACES: ReadonlySet<string> = new Set([
  ...WEB_STREAM_CLASSES,
  "ReadableStreamReadResult",
  "ReadableStreamReadValueResult",
  "ReadableStreamReadDoneResult",
  "UnderlyingSource",
  "UnderlyingSink",
  "Transformer",
  "QueuingStrategy",
  "QueuingStrategySize",
]);

/** Whether a JavaScript member read names a member of a web stream
 * interface, which the receiver's checked-dynamic value answers. */
export function isWebStreamMemberInJavaScript(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): boolean {
  if (!isJsSourceFile(ts.getSourceFileOfNode(access))) return false;
  const member = lowerer.checker.getSymbolAtLocation(access.name);
  const declaration = member?.declarations[0];
  let owner: ts.Node | undefined = declaration?.parent;
  while (
    owner !== undefined &&
    !ts.isInterfaceDeclaration(owner) &&
    !ts.isTypeAliasDeclaration(owner)
  )
    owner = owner.parent;
  return owner !== undefined && WEB_STREAM_INTERFACES.has(owner.name.text);
}

/** Whether a checker type is, or is a promise of, a web stream interface
 * (a read result, a reader's closed promise). JavaScript keeps such values
 * checked-dynamic, as their handles answered them: a typed copy would lose
 * the value's identity (a chunk object, a promise). */
export function typeInvolvesWebStream(lowerer: Lowerer, type: ts.Type, depth = 0): boolean {
  if (depth > 4) return false;
  if ((type.flags & ts.TypeFlags.Union) !== 0)
    return constituentTypes(type).some((t) => typeInvolvesWebStream(lowerer, t, depth + 1));
  for (const symbol of [type.getSymbol(), type.getAliasSymbol()]) {
    if (symbol === undefined) continue;
    const name = ts.symbolName(symbol);
    if (WEB_STREAM_INTERFACES.has(name) && lowerer.isStdlibSymbol(symbol)) return true;
    if (name === "Promise") {
      const args = lowerer.checker.getTypeArguments(type as ts.TypeReference);
      if (args.some((t) => typeInvolvesWebStream(lowerer, t, depth + 1))) return true;
    }
  }
  return false;
}

/** Whether a JavaScript expression produces a web stream value: a member of
 * a web stream interface (`reader.closed`), a call of one (`reader.read()`),
 * an await of either, or a value whose type involves one. */
export function isWebStreamValueInJavaScript(lowerer: Lowerer, node: ts.Expression): boolean {
  if (!isJsSourceFile(ts.getSourceFileOfNode(node))) return false;
  let expr = unparenthesized(node);
  if (ts.isAwaitExpression(expr)) expr = unparenthesized(expr.expression);
  if (ts.isCallExpression(expr)) expr = unparenthesized(expr.expression);
  if (ts.isPropertyAccessExpression(expr) && isWebStreamMemberInJavaScript(lowerer, expr))
    return true;
  return typeInvolvesWebStream(lowerer, lowerer.typeOf(node));
}
