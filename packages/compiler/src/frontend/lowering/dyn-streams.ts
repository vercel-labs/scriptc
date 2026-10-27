/* Checked-dynamic stream slots (TypeMapperCtx.dynNodeStreams).
 *
 * Under the general stream representation (general-streams.ts),
 * NodeJS.ReadableStream and NodeJS.WritableStream map to the runtime stream
 * classes. JavaScript code also hands such slots its own stream objects:
 * constructor-function streams over EventEmitter or the legacy Stream, plain
 * objects implementing on/pipe/write/end, streams of bundled npm code. A
 * program that moves an untyped value into a stream slot therefore lowers
 * again with checked-dynamic slots: those two interfaces map to dyn, so a
 * slot holds either a boxed native stream (its typed capsule, which unboxes
 * to the same stream) or the JavaScript object itself, and a value returned
 * to JavaScript is the object that came in.
 *
 * A member call on such a slot dispatches per value at run time. A native
 * stream unboxes and takes the ordinary class-method lowering (the same
 * stream surface a typed stream has); any other value calls its own member
 * with JavaScript's dynamic semantics (dynInvoke). Programs without such a
 * flow never take this pass, so their IR is unchanged. */
import type { IrExpr, IrStmt, IrType } from "../../ir/ir.js";
import { dynUndefinedExpr, numLit, strLit, varRef } from "../../ir/build.js";
import { DYN } from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { isDeclaredInAmbientNamespace } from "../type-mapper.js";
import { resultIsDiscarded } from "./call-position.js";
import { lowerObjectMethodCall } from "./lower-calls.js";
import type { Lowerer } from "./lowerer.js";

/** The side a NodeJS stream interface names: "r" for NodeJS.ReadableStream,
 * "w" for NodeJS.WritableStream (through null/undefined and intersections),
 * or null for any other type. */
export function nodeStreamInterfaceSide(lowerer: Lowerer, type: ts.Type): "r" | "w" | null {
  const parts = (t: ts.Type): ts.Type[] =>
    (t.flags & ts.TypeFlags.Intersection) !== 0 ? ts.constituentTypes(t).flatMap(parts) : [t];
  for (const part of parts(lowerer.checker.getNonNullableType(type))) {
    const psym = part.getSymbol() ?? part.getAliasSymbol();
    if (
      (psym === undefined || ts.symbolName(psym) !== "ReadableStream") &&
      (psym === undefined || ts.symbolName(psym) !== "WritableStream")
    )
      continue;
    const declared = psym.declarations.some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        lowerer.isStdlibFile(ts.getSourceFileOfNode(d)) &&
        isDeclaredInAmbientNamespace(d, "NodeJS"),
    );
    if (declared) return ts.symbolName(psym) === "ReadableStream" ? "r" : "w";
  }
  return null;
}

/** The runtime class a native value of the side unboxes to. */
export function nativeStreamClass(side: "r" | "w"): IrType {
  return { kind: "object", className: side === "r" ? "%Readable" : "%Writable" };
}

/** The native stream of a checked-dynamic value (+1, typed as the side's
 * class) or null: the stream.dynNative libCall, which tests the value's
 * typed capsule without throwing. */
function dynNativeStream(
  lowerer: Lowerer,
  value: IrExpr,
  side: "r" | "w",
  fn: "stream.dynNative" | "stream.dynNativePipe" = "stream.dynNative",
): IrExpr {
  const native = nativeStreamClass(side);
  return {
    kind: "libCall",
    fn,
    args: [value, numLit(side === "r" ? 1 : 2, value.loc)],
    type: { kind: "union", unionId: lowerer.unions.intern([native, { kind: "nullT" }]) },
    loc: value.loc,
  };
}

/** Runs `lower` with `node` lowering to `value` and its member calls taking
 * `type` as the receiver representation. */
export function withStreamReceiver<T>(
  lowerer: Lowerer,
  node: ts.Expression,
  value: IrExpr,
  type: IrType,
  lower: () => T,
): T {
  const previous = lowerer.receiverTypeOverrides.get(node);
  lowerer.receiverTypeOverrides.set(node, type);
  try {
    return lowerer.withExpressionOverride(node, value, lower);
  } finally {
    if (previous) lowerer.receiverTypeOverrides.set(node, previous);
    else lowerer.receiverTypeOverrides.delete(node);
  }
}

/** `stream.member(args)` on a NodeJS.ReadableStream / NodeJS.WritableStream
 * receiver under checked-dynamic stream slots, or null when the call is not
 * one. */
export function lowerDynStreamMemberCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (!lowerer.dynNodeStreams) return null;
  // The native arm re-enters the call lowering with the receiver bound.
  if (lowerer.chainRecvByNode.has(access.expression)) return null;
  if (access.questionDotToken || call.questionDotToken || !ts.isIdentifier(access.name))
    return null;
  if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const side = nodeStreamInterfaceSide(lowerer, lowerer.typeOf(access.expression));
  if (side === null) return null;
  const loc = locOf(call);
  const receiverValue = lowerer.lowerExpr(access.expression);
  const receiver = lowerer.declareHiddenLocal("%streamReceiver", receiverValue.type);
  const receiverRef = varRef(receiver.id, receiver.type, locOf(access.expression));
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: receiver.id, init: receiverValue, loc }];
  const seq = (result: IrExpr): IrExpr => ({
    kind: "seqExpr",
    stmts,
    result,
    type: result.type,
    loc,
  });
  // A typed stream whose declared type is one of the interfaces (a child
  // stdio read): the class-method path on its own representation.
  if (receiverValue.type.kind !== "dyn") {
    const typed =
      receiverValue.type.kind === "object"
        ? withStreamReceiver(lowerer, access.expression, receiverRef, receiverValue.type, () =>
            lowerObjectMethodCall(lowerer, call, access),
          )
        : lowerer.withExpressionOverride(access.expression, receiverRef, () =>
            lowerer.lowerCall(call),
          );
    if (typed === null) lowerer.noLowering(`${access.name.text} on this stream`, call);
    return seq(typed);
  }
  const nativeType = nativeStreamClass(side);
  const nullable = dynNativeStream(lowerer, receiverRef, side);
  const nativeOrNull = lowerer.declareHiddenLocal("%streamNative", nullable.type);
  stmts.push({ kind: "varDecl", localId: nativeOrNull.id, init: nullable, loc });
  const unionId = nullable.type.kind === "union" ? nullable.type.unionId : "";
  const tag = lowerer.armTag(unionId, nativeType);
  const native = lowerer.declareHiddenLocal("%streamNativeValue", nativeType);
  const nativeRef = varRef(native.id, nativeType, locOf(access.expression));
  const nativeDecl: IrStmt = {
    kind: "varDecl",
    localId: native.id,
    init: {
      kind: "unionNarrow",
      unionId,
      tag,
      value: varRef(nativeOrNull.id, nullable.type, loc),
      type: nativeType,
      loc,
    },
    loc,
  };
  const typed = withStreamReceiver(lowerer, access.expression, nativeRef, nativeType, () =>
    lowerObjectMethodCall(lowerer, call, access),
  );
  if (typed === null)
    lowerer.noLowering(
      `${side === "r" ? "NodeJS.ReadableStream" : "NodeJS.WritableStream"}.${access.name.text}`,
      call,
    );
  // Any other value calls its own member, with the arguments as untyped
  // values (typed callbacks box behind checked thunks).
  const invoked: IrExpr = {
    kind: "dynInvoke",
    recv: receiverRef,
    method: access.name.text,
    calleeName: ts.getTextOfNode(access),
    args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc,
  };
  const cond: IrExpr = {
    kind: "unionIsTag",
    unionId,
    tag,
    negated: false,
    value: varRef(nativeOrNull.id, nullable.type, loc),
    type: { kind: "bool" },
    loc,
  };
  const resultType = resultIsDiscarded(call) ? null : lowerer.irTypeOf(call);
  if (resultType === null || resultType.kind === "void") {
    stmts.push({
      kind: "if",
      cond,
      then: [nativeDecl, { kind: "exprStmt", expr: typed, loc }],
      else_: [{ kind: "exprStmt", expr: invoked, loc }],
      loc,
    });
    return seq(dynUndefinedExpr(loc));
  }
  const result = lowerer.declareHiddenLocal("%streamResult", resultType);
  result.mutable = true;
  stmts.push(
    { kind: "varDecl", localId: result.id, init: null, loc },
    {
      kind: "if",
      cond,
      then: [
        nativeDecl,
        {
          kind: "assign",
          localId: result.id,
          value: lowerer.coerceInto(call, typed, resultType),
          loc,
        },
      ],
      else_: [
        {
          kind: "assign",
          localId: result.id,
          value: lowerer.coerceInto(call, invoked, resultType),
          loc,
        },
      ],
      loc,
    },
  );
  return seq(varRef(result.id, resultType, loc));
}

/** `for await (const chunk of stream)` over a checked-dynamic
 * NodeJS.ReadableStream: a native stream iterates through the Readable
 * lowering; any other value throws the not-supported Error (async
 * iteration of JavaScript stream objects has no lowering). */
export function lowerForAwaitDynStream(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  lowerLoop: () => IrStmt | null,
): IrStmt | null {
  if (!lowerer.dynNodeStreams || lowerer.chainRecvByNode.has(stmt.expression)) return null;
  if (nodeStreamInterfaceSide(lowerer, lowerer.typeOf(stmt.expression)) !== "r") return null;
  const loc = locOf(stmt.expression);
  const value = lowerer.lowerExpr(stmt.expression);
  const native: IrType =
    value.type.kind === "dyn" ? { kind: "object", className: "%Duplex" } : value.type;
  const local = lowerer.declareHiddenLocal("%streamIterated", native);
  const init: IrExpr =
    value.type.kind === "dyn"
      ? {
          kind: "libCall",
          fn: "stream.unboxDyn",
          args: [
            value,
            strLit(
              "for await over stream objects other than native streams is not supported yet",
              loc,
            ),
          ],
          type: native,
          loc,
        }
      : value;
  const loop = withStreamReceiver(
    lowerer,
    stmt.expression,
    varRef(local.id, native, loc),
    native,
    lowerLoop,
  );
  if (loop === null) return null;
  return {
    kind: "block",
    body: [{ kind: "varDecl", localId: local.id, init, loc }, loop],
    loc: locOf(stmt),
  };
}

/** A statement that runs `onNative` with the native stream a
 * checked-dynamic pipe or unpipe destination stands for (typed as the
 * side's class), or `otherwise` for any other value. The destination's
 * stream is a boxed native one or a constructor-function stream's
 * (stream.dynNativePipe): only the runtime's pipe reads it, while member
 * calls on a slot keep a constructor-function stream's own methods. */
export function dynNativeBranch(
  lowerer: Lowerer,
  value: IrExpr,
  side: "r" | "w",
  onNative: (native: IrExpr) => IrStmt,
  otherwise: IrStmt,
): IrStmt {
  const loc = value.loc;
  const nativeType = nativeStreamClass(side);
  const nullable = dynNativeStream(lowerer, value, side, "stream.dynNativePipe");
  const nativeOrNull = lowerer.declareHiddenLocal("%streamNative", nullable.type);
  const unionId = nullable.type.kind === "union" ? nullable.type.unionId : "";
  const tag = lowerer.armTag(unionId, nativeType);
  const native = lowerer.declareHiddenLocal("%streamNativeValue", nativeType);
  const nullableRef = varRef(nativeOrNull.id, nullable.type, loc);
  return {
    kind: "block",
    body: [
      { kind: "varDecl", localId: nativeOrNull.id, init: nullable, loc },
      {
        kind: "if",
        cond: {
          kind: "unionIsTag",
          unionId,
          tag,
          negated: false,
          value: nullableRef,
          type: { kind: "bool" },
          loc,
        },
        then: [
          {
            kind: "varDecl",
            localId: native.id,
            init: { kind: "unionNarrow", unionId, tag, value: nullableRef, type: nativeType, loc },
            loc,
          },
          onNative(varRef(native.id, nativeType, loc)),
        ],
        else_: [otherwise],
        loc,
      },
    ],
    loc,
  };
}
