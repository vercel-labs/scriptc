import {
  READABLE_STREAM_WEB_VIEW_CALLS,
  staticFetchMembers,
} from "../../../compat/fetch-profile.js";
import { dynUndefinedExpr, numLit } from "../../../ir/build.js";
import { WEB_STREAM_CLASSES } from "../../../ir/webstream-classes.js";
import { everyStmt } from "../../../ir/traverse.js";
import {
  BOOL,
  DYN,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type SrcLoc,
} from "../../../ir/ir.js";
import * as ts from "../../ts7/adapter.js";
import { withoutParentheses } from "../../outer-expressions.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { constituentTypes } from "../../ts7/checker.js";
import { ENTRY_NAME, type Lowerer } from "../lowerer.js";
import { stdlibGlobalNameOf } from "../surfaces.js";
import { streamWebImportOf } from "./module-bindings.js";
import { lowerDynObjectLiteral } from "../expressions/object-literals.js";

/* The web stream classes in JavaScript sources: the globals and the
 * node:stream/web exports, which are the same constructors. Each reference
 * is the class's constructor value (scr_webstreams.c, webstream.class), so
 * construction, static members, prototypes and instanceof go through the
 * checked-dynamic paths over that value. TypeScript sources keep their
 * static lowerings (lower-stdlib.ts). */

/** The classes in scr_webstream_class's order (ir/webstream-classes.ts). */
export { WEB_STREAM_CLASSES };

const CLASS_NAMES: readonly string[] = WEB_STREAM_CLASSES;

/** The class a JavaScript expression names (an identifier bound to the
 * global or to a node:stream/web import, or a member of the global
 * object), as its index in WEB_STREAM_CLASSES; null otherwise. */
export function webStreamClassKindOf(lowerer: Lowerer, node: ts.Expression): number | null {
  const expr = withoutParentheses(node);
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

/** The classes a TypeScript source constructs through the web stream
 * classes once it uses an operation the native streams lack. */
const TYPED_CLASSES: ReadonlySet<string> = new Set([
  "ReadableStream",
  "ReadableStreamDefaultReader",
  "ReadableStreamBYOBReader",
  "ReadableByteStreamController",
  "ReadableStreamBYOBRequest",
  "WritableStream",
  "TransformStream",
  "CountQueuingStrategy",
  "ByteLengthQueuingStrategy",
  "WritableStreamDefaultWriter",
  "WritableStreamDefaultController",
  "TransformStreamDefaultController",
  "TextEncoderStream",
  "TextDecoderStream",
]);
const WEB_VIEW_CALLS: ReadonlySet<string> = new Set(READABLE_STREAM_WEB_VIEW_CALLS);

/** The text of an object literal's property name, for a plain identifier, a
 * string or a number key; null for a computed key. */
function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return null;
}

/** Whether a ReadableStream constructor's source asks for a byte stream: an
 * object literal with a `type` member, or a value whose type has one
 * (`const source: UnderlyingByteSource = …`). Only the web stream classes
 * build byte streams. */
function sourceIsByteStream(lowerer: Lowerer, arg: ts.Expression | undefined): boolean {
  if (arg === undefined) return false;
  if (ts.isObjectLiteralExpression(arg))
    return arg.properties.nodes.some(
      (p) => p.name !== undefined && propertyNameText(p.name as ts.PropertyName) === "type",
    );
  const property = lowerer.checker.getPropertyOfType(lowerer.typeOf(arg), "type");
  if (property === undefined) return false;
  const type = lowerer.checker.getTypeOfSymbolAtLocation(property, arg);
  return (
    (type.flags & ts.TypeFlags.StringLiteral) !== 0 &&
    (type as ts.StringLiteralType).value === "bytes"
  );
}

/** Whether a TypeScript source of the program uses a web stream operation
 * the native streams lack: a ReadableStream tee(), pipeTo() or
 * pipeThrough() call, a getReader() call with arguments (the byte reader's
 * mode), a ReadableStream constructor with a queuing strategy or a byte
 * source, a WritableStream, WritableStreamDefaultWriter,
 * WritableStreamDefaultController, TransformStreamDefaultController,
 * CountQueuingStrategy, ByteLengthQueuingStrategy, TextEncoderStream,
 * TextDecoderStream, ReadableStreamDefaultReader or ReadableStreamBYOBReader
 * constructor, or a TransformStream constructor with arguments (a
 * transformer or queuing strategies). Such a program builds its
 * ReadableStream, WritableStream and TransformStream values with the web
 * stream classes, as JavaScript does; a program that uses only getReader(),
 * cancel() and the identity transform keeps the native streams. */
export function programUsesTypedWebStreams(lowerer: Lowerer): boolean {
  if (lowerer.typedWebStreams !== undefined) return lowerer.typedWebStreams;
  let found = false;
  for (const file of lowerer.program.getSourceFiles()) {
    if (file.isDeclarationFile || isJsSourceFile(file)) continue;
    ts.walkPreorder(file, (node) => {
      const member = staticMemberName(node);
      if (member !== null && WEB_VIEW_CALLS.has(member) && isReadableStreamMember(lowerer, node))
        found = true;
      else if (
        member === "getReader" &&
        ts.isCallExpression(node) &&
        node.arguments.nodes.length > 0 &&
        isReadableStreamMember(lowerer, node.expression)
      )
        found = true;
      else if (ts.isNewExpression(node)) {
        const name = stdlibGlobalNameOf(lowerer, withoutParentheses(node.expression));
        if (
          name === "WritableStream" ||
          name === "WritableStreamDefaultWriter" ||
          name === "WritableStreamDefaultController" ||
          name === "TransformStreamDefaultController" ||
          name === "CountQueuingStrategy" ||
          name === "ByteLengthQueuingStrategy" ||
          name === "TextEncoderStream" ||
          name === "TextDecoderStream" ||
          name === "ReadableStreamDefaultReader" ||
          name === "ReadableStreamBYOBReader" ||
          name === "ReadableByteStreamController" ||
          name === "ReadableStreamBYOBRequest" ||
          (name === "TransformStream" && (node.arguments?.nodes.length ?? 0) > 0) ||
          (name === "ReadableStream" &&
            ((node.arguments?.nodes.length ?? 0) > 1 ||
              sourceIsByteStream(lowerer, node.arguments?.nodes[0])))
        )
          found = true;
      }
      return found ? "stop" : undefined;
    });
    if (found) break;
  }
  lowerer.typedWebStreams = found;
  return found;
}

/** The class a TypeScript `new` expression constructs through the web
 * stream classes (programUsesTypedWebStreams), as its index in
 * WEB_STREAM_CLASSES; null otherwise. */
function typedWebStreamClassKindOf(lowerer: Lowerer, node: ts.Expression): number | null {
  const expr = withoutParentheses(node);
  if (!ts.isIdentifier(expr) || isJsSourceFile(ts.getSourceFileOfNode(expr))) return null;
  const name = streamWebImportOf(lowerer, expr) ?? stdlibGlobalNameOf(lowerer, expr);
  if (name === null || !TYPED_CLASSES.has(name) || !programUsesTypedWebStreams(lowerer))
    return null;
  return CLASS_NAMES.indexOf(name);
}

/** The class a TypeScript `instanceof` operand names when the program
 * builds its streams through the web stream classes
 * (programUsesTypedWebStreams): the same brand test the JavaScript path
 * runs, since those values are checked-dynamic handles. */
function typedStreamInstanceClassKindOf(lowerer: Lowerer, node: ts.Expression): number | null {
  const expr = withoutParentheses(node);
  if (!ts.isIdentifier(expr)) return null;
  const name = stdlibGlobalNameOf(lowerer, expr);
  if (name === null || !TYPED_CLASSES.has(name) || !programUsesTypedWebStreams(lowerer))
    return null;
  const index = CLASS_NAMES.indexOf(name);
  return index < 0 ? null : index;
}

export function webStreamClassValue(kind: number, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "webstream.class", args: [numLit(kind, loc)], type: DYN, loc };
}

/** A JavaScript read of one of the classes as a value; null otherwise. */
export function lowerWebStreamClassRead(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  const kind = webStreamClassKindOf(lowerer, node);
  return kind === null ? null : webStreamClassValue(kind, locOf(node));
}

/** `new X(...args)` on one of the classes in JavaScript, and on
 * ReadableStream, WritableStream and TransformStream in a TypeScript
 * program that uses the web stream classes (programUsesTypedWebStreams).
 * A TypeScript source's object literal argument (a source, sink,
 * transformer or strategy) becomes a plain object with its methods. */
export function lowerWebStreamNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const typed = webStreamClassKindOf(lowerer, expr.expression) === null;
  const kind = typed
    ? typedWebStreamClassKindOf(lowerer, expr.expression)
    : webStreamClassKindOf(lowerer, expr.expression);
  if (kind === null) return null;
  const nodes = expr.arguments?.nodes ?? [];
  if (nodes.some(ts.isSpreadElement)) return null;
  const loc = locOf(expr);
  const argument = (arg: ts.Expression): IrExpr =>
    typed && ts.isObjectLiteralExpression(arg)
      ? lowerDynObjectLiteral(lowerer, arg)
      : lowerer.lowerExprExpecting(arg, DYN);
  return {
    kind: "libCall",
    fn: "dyn.construct",
    args: [
      webStreamClassValue(kind, loc),
      {
        kind: "dynArrLit",
        elems: nodes.map(argument),
        type: DYN,
        loc,
      },
      { kind: "strLit", value: CLASS_NAMES[kind]!, type: STRING, loc },
    ],
    type: DYN,
    loc,
  };
}

/** `ReadableStream.from(iterable)`, the only static member of the classes:
 * the class's own from, which steps any iterable or async iterable. The
 * runtime entry also counts as a runtime iterator step, so a compiled
 * generator passed here answers its next and return members. */
function lowerReadableStreamFrom(lowerer: Lowerer, call: ts.CallExpression, loc: SrcLoc): IrExpr {
  const nodes = call.arguments.nodes;
  const first = nodes[0];
  const iterable: IrExpr = first ? lowerer.lowerExprExpecting(first, DYN) : dynUndefinedExpr(loc);
  const from = (arg: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "webstream.from",
    args: [arg],
    type: DYN,
    loc,
  });
  if (nodes.length <= 1) return from(iterable);
  // from() ignores surplus arguments, but evaluates them in source order.
  const local = lowerer.declareHiddenLocal("%fromIterable", DYN);
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: local.id, init: iterable, loc }];
  for (const surplus of nodes.slice(1)) {
    const discarded = lowerer.lowerExpr(surplus);
    stmts.push({ kind: "exprStmt", expr: discarded, loc: discarded.loc });
  }
  return {
    kind: "seqExpr",
    stmts,
    result: from({ kind: "varRef", localId: local.id, type: DYN, loc }),
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
  if (kind === 0 && access.name.text === "from") return lowerReadableStreamFrom(lowerer, call, loc);
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

/** `value instanceof X` on one of the classes in JavaScript, and on the
 * web stream classes a TypeScript source builds through them once it uses
 * an operation the native streams lack: those values are checked-dynamic
 * handles, so the brand test reads the handle class. */
export function lowerWebStreamInstanceof(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  const kind =
    webStreamClassKindOf(lowerer, expr.right) ??
    typedStreamInstanceClassKindOf(lowerer, expr.right);
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
  "ReadableStreamBYOBReadResult",
  "UnderlyingSource",
  "UnderlyingByteSource",
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
  let expr = withoutParentheses(node);
  if (ts.isAwaitExpression(expr)) expr = withoutParentheses(expr.expression);
  if (ts.isCallExpression(expr)) expr = withoutParentheses(expr.expression);
  if (ts.isPropertyAccessExpression(expr) && isWebStreamMemberInJavaScript(lowerer, expr))
    return true;
  return typeInvolvesWebStream(lowerer, lowerer.typeOf(node));
}

/** Whether a checker type is the stdlib ReadableStream, or a union with it. */
function isReadableStreamType(lowerer: Lowerer, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Union) !== 0)
    return constituentTypes(type).some((t) => isReadableStreamType(lowerer, t));
  const symbol = type.getSymbol();
  return (
    symbol !== undefined &&
    ts.symbolName(symbol) === "ReadableStream" &&
    lowerer.isStdlibSymbol(symbol)
  );
}

type MemberAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/** The member a property access names, or an element access with a string
 * literal key (`body.tee` and `body["tee"]`); null for any other node. */
function staticMemberName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) return key.text;
  }
  return null;
}

/** Whether a member access (staticMemberName) resolves to a member of the
 * stdlib ReadableStream interface. */
function isReadableStreamMember(lowerer: Lowerer, access: ts.Node): boolean {
  const key = ts.isPropertyAccessExpression(access)
    ? access.name
    : ts.isElementAccessExpression(access)
      ? access.argumentExpression
      : null;
  if (key === null) return false;
  const member = lowerer.checker.getSymbolAtLocation(key);
  if (member === undefined || !lowerer.isStdlibSymbol(member)) return false;
  let owner: ts.Node | undefined = member.declarations[0]?.parent;
  while (owner !== undefined && !ts.isInterfaceDeclaration(owner)) owner = owner.parent;
  return owner !== undefined && owner.name.text === "ReadableStream";
}

/** Whether a checker type is any or unknown, which a fetch body can be. */
function isUntypedType(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/** Whether the program links the fetch unit (a fetch. entry point), whose
 * Response and Request bodies can reach JavaScript as untyped values. */
function programLinksFetch(functions: IrFunction[]): boolean {
  let found = false;
  const visitor = {
    expr: (e: IrExpr): boolean => {
      if (e.kind === "libCall" && e.fn.startsWith("fetch.")) found = true;
      return !found;
    },
    stmt: (): boolean => !found,
  };
  for (const fn of functions) {
    for (const s of fn.body) everyStmt(s, visitor);
    if (found) return true;
  }
  return false;
}

/** Whether a JavaScript source of the program uses a ReadableStream member
 * that the fetch unit's own stream does not implement (the fetch profile's
 * readableStreamUnsupported): a member access the checker resolves to the
 * interface, or `for await` over a ReadableStream value. The same member
 * names on an untyped receiver, or `for await` over an untyped value,
 * count in a program that links the fetch unit, since the value can be a
 * fetch body. */
function programUsesWebStreamOnlyMembers(lowerer: Lowerer, functions: IrFunction[]): boolean {
  if (programUsesTypedWebStreams(lowerer)) return true;
  const members = staticFetchMembers().readableStreamUnsupported;
  const iterates = members.has("[Symbol.asyncIterator]");
  let untyped = false;
  for (const file of lowerer.program.getSourceFiles()) {
    if (file.isDeclarationFile || !isJsSourceFile(file)) continue;
    let found = false;
    ts.walkPreorder(file, (node) => {
      let receiver: ts.Type | null = null;
      const member = staticMemberName(node);
      if (member !== null && members.has(member)) {
        if (isReadableStreamMember(lowerer, node)) found = true;
        else receiver = lowerer.typeOf((node as MemberAccess).expression);
      } else if (iterates && ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
        receiver = lowerer.typeOf(node.expression);
        if (isReadableStreamType(lowerer, receiver)) found = true;
      }
      if (found) return "stop";
      if (receiver !== null && isUntypedType(receiver)) untyped = true;
      return undefined;
    });
    if (found) return true;
  }
  return untyped && programLinksFetch(functions);
}

/** Links the web stream classes into a program whose JavaScript uses a
 * ReadableStream member the fetch unit's own stream lacks, or whose
 * TypeScript uses the web stream classes (programUsesTypedWebStreams): a
 * fetch body's or a native stream's
 * handle stands for a web ReadableStream once such a member is used
 * (scr_fetch.c, sf_stream_web_view). %main installs the classes first. A
 * program that names one of the classes links them already. */
export function installFetchBodyWebStreams(lowerer: Lowerer, functions: IrFunction[]): void {
  if (programNamesWebStreamClass(lowerer) || !programUsesWebStreamOnlyMembers(lowerer, functions))
    return;
  const main = functions.find((fn) => fn.name === ENTRY_NAME);
  if (!main) return;
  const loc = main.loc;
  main.body.unshift({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "webstream.install", args: [], type: VOID, loc },
    loc,
  });
}
