import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { BOOL, BYTES_U8, DYN, F64, STRING, type IrExpr, type IrStmt } from "../../../ir/ir.js";
import { lowerDynObjectLiteral } from "../expressions/object-literals.js";
import { stdlibGlobalNameOf } from "../surfaces.js";
import { builtinImportOf } from "./module-bindings.js";

/* Blob and File (node:buffer, also globals) are native checked-dynamic
 * handles (scr_blob.c). Construction, slice() and the three readers lower
 * to dedicated libCalls; size, type, name and lastModified are handle
 * property reads. Every other member is fenced at compile time so no
 * call can reach a missing runtime operation. */

type BlobClass = "Blob" | "File";

const BLOB_READS = new Set(["size", "type"]);
const FILE_READS = new Set(["size", "type", "name", "lastModified"]);
const BLOB_CALLS = new Set(["slice", "text", "bytes", "arrayBuffer"]);
// The stream readers Node 24 defines (textStream() is newer than some type
// declarations, so it is matched by name).
const STREAM_MEMBERS = new Set(["stream", "textStream"]);
// Object.prototype members other than toString() (the handle answers the
// class tag): the native handle has no prototype chain to answer them.
const OBJECT_PROTOTYPE_MEMBERS = new Set([
  "constructor",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__proto__",
]);

/** The Blob or File constructor in any spelling: the globals, globalThis
 * members, and node:buffer's named, namespace and require bindings. */
export function blobClassOf(lowerer: Lowerer, node: ts.Expression): BlobClass | null {
  const global = stdlibGlobalNameOf(lowerer, node);
  if (global === "Blob" || global === "File") return global;
  const builtin = ts.isIdentifier(node)
    ? builtinImportOf(lowerer, node)
    : ts.isPropertyAccessExpression(node) && !node.questionDotToken
      ? lowerer.builtinMemberOf(node)
      : null;
  if (builtin?.module === "buffer" && (builtin.member === "Blob" || builtin.member === "File")) {
    return builtin.member;
  }
  return null;
}

/** The class of a stdlib Blob/File-typed receiver, or null. */
function blobReceiverClass(lowerer: Lowerer, node: ts.Expression): BlobClass | null {
  const type = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(node));
  const sym = type.getAliasSymbol() ?? type.getSymbol();
  if (!sym) return null;
  const name = ts.symbolName(sym);
  if ((name !== "Blob" && name !== "File") || !lowerer.isStdlibSymbol(sym)) return null;
  return name;
}

function memberNameOf(access: ts.PropertyAccessExpression | ts.ElementAccessExpression) {
  if (ts.isPropertyAccessExpression(access)) return access.name.text;
  const key = access.argumentExpression;
  return ts.isStringLiteralLike(key) ? key.text : null;
}

/** `new Blob(sources?, options?)` and `new File(bits, name, options?)`:
 * the argument vector goes to the runtime, which validates it in Node's
 * order. */
export function lowerBlobNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const cls = blobClassOf(lowerer, expr.expression);
  if (cls === null) return null;
  const args = expr.arguments?.nodes ?? [];
  if (args.some(ts.isSpreadElement)) return null;
  const loc = locOf(expr);
  const values = args.map((arg) =>
    ts.isObjectLiteralExpression(arg)
      ? lowerDynObjectLiteral(lowerer, arg)
      : lowerer.lowerExprExpecting(arg, DYN),
  );
  return {
    kind: "libCall",
    fn: cls === "Blob" ? "blob.new" : "blob.fileNew",
    args: [{ kind: "dynArrLit", elems: values, type: DYN, loc }],
    type: DYN,
    loc,
  };
}

/** slice(), text(), bytes() and arrayBuffer() on a Blob or File. */
export function lowerStaticBlobCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.questionDotToken || !ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  const member = access.name.text;
  if (access.questionDotToken || !BLOB_CALLS.has(member)) return null;
  if (blobReceiverClass(lowerer, access.expression) === null) return null;
  if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const loc = locOf(call);
  const receiver = lowerer.lowerExprExpecting(access.expression, DYN);
  const args = call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
  if (member === "slice") {
    return {
      kind: "libCall",
      fn: "blob.slice",
      args: [receiver, { kind: "dynArrLit", elems: args, type: DYN, loc }],
      type: DYN,
      loc,
    };
  }
  const read = (recv: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: member === "text" ? "blob.text" : member === "bytes" ? "blob.bytes" : "blob.arrayBuffer",
    args: [recv],
    type: {
      kind: "promise",
      inner: member === "text" ? STRING : member === "bytes" ? BYTES_U8 : DYN,
    },
    loc,
  });
  if (args.length === 0) return read(receiver);
  // The readers take no arguments; extra ones still evaluate after the
  // receiver and before the read.
  const local = lowerer.declareHiddenLocal("%blobReceiver", DYN);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: local.id, init: receiver, loc },
    ...args.map((arg): IrStmt => ({ kind: "exprStmt", expr: arg, loc: arg.loc })),
  ];
  const result = read({ kind: "varRef", localId: local.id, type: DYN, loc });
  return { kind: "seqExpr", stmts, result, type: result.type, loc };
}

/** `v instanceof Blob` / `v instanceof File`. */
export function lowerBlobInstanceof(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  const cls = blobClassOf(lowerer, expr.right);
  if (cls === null) return null;
  const loc = locOf(expr);
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return {
    kind: "libCall",
    fn: "blob.is",
    args: [value, { kind: "numLit", value: cls === "Blob" ? 0 : 1, type: F64, loc }],
    type: BOOL,
    loc,
  };
}

/** Members outside the native surface: Node keeps Blob's state in internal
 * slots behind prototype getters and methods, so only the modeled reads
 * and calls lower; stream() and the rest are refused here. */
export function fenceStaticBlobMember(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  use: "read" | "call",
): IrExpr | null {
  const cls = blobReceiverClass(lowerer, access.expression);
  if (cls === null) return null;
  const member = memberNameOf(access);
  if (member !== null) {
    if (use === "call" && (BLOB_CALLS.has(member) || member === "toString")) return null;
    if (use === "read" && (cls === "File" ? FILE_READS : BLOB_READS).has(member)) return null;
    // Names the class does not declare keep the generic dynamic path
    // (undefined reads, Node's "is not a function" TypeError, and the
    // handle's toString()).
    const type = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(access.expression));
    if (
      !OBJECT_PROTOTYPE_MEMBERS.has(member) &&
      !STREAM_MEMBERS.has(member) &&
      !lowerer.checker.getPropertyOfType(type, member)
    ) {
      return null;
    }
  }
  if (member !== null && STREAM_MEMBERS.has(member)) {
    lowerer.noLowering(
      `${cls}.${member}()`,
      access,
      "Blob streams are not supported yet; read the contents with bytes(), arrayBuffer() or text()",
    );
  }
  lowerer.noLowering(
    member === null ? `computed ${cls} members` : `${cls}.${member}`,
    access,
    `the native ${cls} surface is ${cls === "File" ? "name, lastModified, " : ""}size and type plus slice(), text(), bytes() and arrayBuffer()`,
  );
}
