import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import type { SrcLoc } from "../../../ir/ir.js";
import { varRef } from "../../../ir/build.js";
import { type IrExpr, type IrStmt, type IrType } from "../../../ir/ir.js";
import { withStreamReceiver } from "../dyn-streams.js";
import { EMITTER_API_MEMBERS } from "../lower-classes.js";
import { lowerEmitterMethodCall } from "../lower-event-emitter.js";
import {
  STREAM_API_MEMBERS,
  STREAM_OPERATORS,
  lowerStreamMethodCall,
  lowerStreamProperty,
} from "../lower-stream.js";
import { isCipherType } from "./crypto.js";
import { isSignerValue } from "./key-object.js";

/* node:crypto's Hash, Hmac, Cipheriv and Decipheriv are Transforms: a
 * value written, read, listened to, or piped as a stream reads and writes
 * through its own native Transform, which scr_stream.c creates on first
 * use. Sign and Verify are Writables: each write goes through update(), and
 * ending finishes them at once. update(), digest(), final(), sign() and
 * verify() keep the value's own lowering; the stream members lower through
 * the stream and emitter spokes over that native stream. A Hash or Hmac is
 * known by its IR type; a cipher or signer is a checked-dynamic handle and
 * is known by its checker type. */

const TRANSFORM_CLASS = "%Transform";
const WRITABLE_CLASS = "%Writable";
const TRANSFORM: IrType = { kind: "object", className: TRANSFORM_CLASS };
const WRITABLE: IrType = { kind: "object", className: WRITABLE_CLASS };

export function isHashValueType(type: IrType | null | undefined): boolean {
  return type?.kind === "cryptoHash" || type?.kind === "cryptoHmac";
}

/** Whether `node` evaluates to a Hash, Hmac, Cipheriv or Decipheriv. */
export function isValueStream(lowerer: Lowerer, node: ts.Expression): boolean {
  const type = lowerer.typeOf(node);
  return isHashValueType(lowerer.mapTypeOf(type)) || isCipherType(lowerer, type);
}

/** Whether `node` evaluates to a Sign or Verify: a Writable, with no
 * readable side. */
export function isWritableValueStream(lowerer: Lowerer, node: ts.Expression): boolean {
  return isSignerValue(lowerer, node);
}

/** The Transform of a lowered Hash or Hmac value (+1). A pipe
 * destination or pipeline stage (`piped`) also keeps the value alive
 * until its stream flushes or is destroyed. */
export function hashStreamOf(value: IrExpr, piped = false): IrExpr {
  return {
    kind: "libCall",
    fn: piped ? "crypto.hashStreamPiped" : "crypto.hashStream",
    args: [value],
    type: TRANSFORM,
    loc: value.loc,
  };
}

/** The Transform of a lowered Hash, Hmac, Cipheriv or Decipheriv value
 * (+1), with hashStreamOf's `piped` (a cipher's stream always holds its
 * cipher). */
export function valueStreamOf(value: IrExpr, piped = false): IrExpr {
  if (isHashValueType(value.type)) return hashStreamOf(value, piped);
  // A value already lowered as its stream (addAbortSignal answers the
  // Transform it was given, which its generic signature types as the
  // cipher).
  if (value.type.kind === "object") return value;
  return {
    kind: "libCall",
    fn: "stream.handleStream",
    args: [value],
    type: TRANSFORM,
    loc: value.loc,
  };
}

/** The Writable of a lowered Sign or Verify value (+1). */
export function writableStreamOf(value: IrExpr): IrExpr {
  // A value already lowered as its stream (addAbortSignal answers the
  // stream it was given).
  if (value.type.kind === "object" && value.type.className === WRITABLE_CLASS) return value;
  return {
    kind: "libCall",
    fn: "stream.handleWritable",
    args: [value],
    type: WRITABLE,
    loc: value.loc,
  };
}

/** A stream member called on a Hash, Hmac, Cipheriv, Decipheriv, Sign or
 * Verify (`hash.write(chunk)`, `cipher.on("data", cb)`,
 * `sign.setDefaultEncoding("hex")`). Members that answer the stream
 * (`this`) answer the value itself. */
export function lowerHashStreamCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const name = access.name.text;
  const streamMember = STREAM_API_MEMBERS.has(name) || STREAM_OPERATORS.has(name);
  if (!streamMember && !EMITTER_API_MEMBERS.has(name)) return null;
  const writable = isWritableValueStream(lowerer, access.expression);
  if (!writable && !isValueStream(lowerer, access.expression)) return null;
  const info = lowerer.classes.get(writable ? WRITABLE_CLASS : TRANSFORM_CLASS);
  if (!info) return null;
  // pipe(dest) answers its destination, which may be a stream too; the
  // other members typed as the value's stream answer `this`
  const answersThis = name !== "pipe";
  return withValueStreamReceiver(
    lowerer,
    access.expression,
    locOf(call),
    answersThis,
    writable,
    () =>
      streamMember
        ? lowerStreamMethodCall(lowerer, call, access, info)
        : lowerEmitterMethodCall(lowerer, call, access, info),
  );
}

/** A stream property read on a Hash, Hmac, Cipheriv, Decipheriv, Sign or
 * Verify (`cipher.destroyed`, `hash.readableEnded`, `sign.writableEnded`). */
export function lowerValueStreamProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken) return null;
  const writable = isWritableValueStream(lowerer, expr.expression);
  if (!writable && !isValueStream(lowerer, expr.expression)) return null;
  const info = lowerer.classes.get(writable ? WRITABLE_CLASS : TRANSFORM_CLASS);
  if (!info) return null;
  return withValueStreamReceiver(lowerer, expr.expression, locOf(expr), true, writable, () =>
    lowerStreamProperty(lowerer, expr, info),
  );
}

/** Evaluates the value `receiver` names once into a hidden local and runs
 * `lower` with the receiver lowering to that value's Transform (or
 * Writable). When `answersThis`, a result typed as that stream (the member
 * answered `this`) answers the value itself. */
function withValueStreamReceiver(
  lowerer: Lowerer,
  receiver: ts.Expression,
  loc: SrcLoc,
  answersThis: boolean,
  writable: boolean,
  lower: () => IrExpr | null,
): IrExpr | null {
  const value = lowerer.lowerExpr(receiver);
  const local = lowerer.declareHiddenLocal("%streamValue", value.type);
  lowerer.valueStreamReceivers.set(receiver, { localId: local.id, type: value.type, writable });
  let lowered: IrExpr | null;
  try {
    lowered = lower();
  } finally {
    lowerer.valueStreamReceivers.delete(receiver);
  }
  if (!lowered) return null;
  const answersStream =
    answersThis &&
    lowered.type.kind === "object" &&
    lowered.type.className === (writable ? WRITABLE_CLASS : TRANSFORM_CLASS);
  const result: IrExpr = answersStream
    ? {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: lowered, loc }],
        result: varRef(local.id, value.type, loc),
        type: value.type,
        loc,
      }
    : lowered;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
    result,
    type: result.type,
    loc,
  };
}

/** `for await (const chunk of value)` over a Hash, Hmac, Cipheriv or
 * Decipheriv: the loop iterates the value's Transform. */
export function lowerForAwaitValueStream(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  lowerLoop: () => IrStmt | null,
): IrStmt | null {
  if (!isValueStream(lowerer, stmt.expression)) return null;
  const loc = locOf(stmt.expression);
  const local = lowerer.declareHiddenLocal("%streamIterated", TRANSFORM);
  const init = valueStreamOf(lowerer.lowerExpr(stmt.expression));
  const loop = withStreamReceiver(
    lowerer,
    stmt.expression,
    varRef(local.id, TRANSFORM, loc),
    TRANSFORM,
    lowerLoop,
  );
  if (loop === null) return null;
  return {
    kind: "block",
    body: [{ kind: "varDecl", localId: local.id, init, loc }, loop],
    loc: locOf(stmt),
  };
}
