import { isBuiltinClassInstance } from "./receiver-types.js";
import { numLit, strLit } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { isChildSurfaceMember } from "../surfaces.js";
import {
  BOOL,
  CHILDSTREAM_T,
  CHILDWRITER_T,
  DATE_T,
  DIR_T,
  F64,
  FILEHANDLE_T,
  type IrExpr,
  type IrLibFn,
  type IrType,
  STRING,
} from "../../../ir/ir.js";
import { storedTextCodecClassOf } from "./text-codecs.js";
import { DIR_MEMBERS, DIR_METHODS } from "./filesystem.js";

/** The property-read extensions this spoke owns, tried BEFORE the
 * lower-exprs intrinsic-property fallback (the lowerer's wrapper chains
 * them): the widened numeric Stats snapshot and SpawnSyncReturns.signal
 * (the termination signal's name as the call site's `Signals | null` union
 * — null for a normal exit or spawn failure; a timeout kill reports its
 * killSignal, Node's shape). Null for everything else, so the ordinary
 * chain (and its fences) keeps going. */

/** Stats data members: each reads the snapshot (scr_stats_*). */
const STATS_FIELDS: Record<string, IrLibFn> = {
  dev: "stats.dev",
  mode: "stats.mode",
  nlink: "stats.nlink",
  uid: "stats.uid",
  gid: "stats.gid",
  rdev: "stats.rdev",
  blksize: "stats.blksize",
  ino: "stats.ino",
  blocks: "stats.blocks",
  atimeMs: "stats.atimeMs",
  mtimeMs: "stats.mtimeMs",
  ctimeMs: "stats.ctimeMs",
  birthtimeMs: "stats.birthtimeMs",
  atime: "stats.atime",
  mtime: "stats.mtime",
  ctime: "stats.ctime",
  birthtime: "stats.birthtime",
};
const DATE_FIELDS = new Set(["atime", "mtime", "ctime", "birthtime"]);
export function lowerBuiltinExtraProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken && !lowerer.chainHandled.has(expr)) return null;
  const codec = storedTextCodecClassOf(lowerer, expr.expression);
  if (
    codec &&
    lowerer.isStdlibMember(expr) &&
    ["encoding", "fatal", "ignoreBOM"].includes(expr.name.text)
  ) {
    const receiver = lowerer.lowerExpr(expr.expression);
    if (receiver.type.kind !== "record")
      lowerer.badType(expr.expression, lowerer.typeOf(expr.expression));
    const loc = locOf(expr);
    if (codec === "TextEncoder" && expr.name.text === "encoding") {
      return {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: receiver, loc }],
        result: strLit("utf-8", loc),
        type: STRING,
        loc,
      };
    }
    if (codec === "TextDecoder") {
      const field = expr.name.text === "encoding" ? "%TextDecoder" : `%${expr.name.text}`;
      const value: IrExpr = {
        kind: "recordGet",
        obj: receiver,
        shapeId: receiver.type.shapeId,
        field,
        type: expr.name.text === "encoding" ? F64 : BOOL,
        loc,
      };
      return expr.name.text === "encoding"
        ? { kind: "libCall", fn: "text.decoderName", args: [value], type: STRING, loc }
        : value;
    }
  }
  // decoder.encoding on a StringDecoder-typed receiver: the record's
  // hidden canonical-name field (construction folded the aliases —
  // exactly what Node's normalized `.encoding` answers).
  if (
    expr.name.text === "encoding" &&
    isBuiltinClassInstance(lowerer, expr.expression, "StringDecoder") &&
    lowerer.isStdlibMember(expr)
  ) {
    const receiver = lowerer.lowerExpr(expr.expression);
    if (receiver.type.kind !== "record")
      lowerer.badType(expr.expression, lowerer.typeOf(expr.expression));
    return {
      kind: "recordGet",
      obj: receiver,
      shapeId: receiver.type.shapeId,
      field: "%enc",
      type: STRING,
      loc: locOf(expr),
    };
  }
  const kind = lowerer.mapTypeOf(lowerer.typeOf(expr.expression))?.kind;
  if (
    kind === "record" &&
    ["read", "written"].includes(expr.name.text) &&
    lowerer.isStdlibMember(expr)
  ) {
    const receiver = lowerer.lowerExpr(expr.expression);
    if (receiver.type.kind === "record") {
      const fields = lowerer.shapes.get(receiver.type.shapeId)?.fields;
      if (
        fields?.length === 2 &&
        fields.every(
          (field) => ["read", "written"].includes(field.name) && field.type.kind === "f64",
        )
      ) {
        return {
          kind: "recordGet",
          obj: receiver,
          shapeId: receiver.type.shapeId,
          field: expr.name.text,
          type: F64,
          loc: locOf(expr),
        };
      }
    }
  }
  if (
    kind !== "stats" &&
    kind !== "fileHandle" &&
    kind !== "dir" &&
    kind !== "spawnRes" &&
    kind !== "child" &&
    kind !== "childWriter"
  )
    return null;
  if (kind === "child" ? !isChildSurfaceMember(lowerer, expr) : !lowerer.isStdlibMember(expr))
    return null;
  const name = expr.name.text;
  const loc = locOf(expr);
  if (kind === "fileHandle") {
    if (name === "fd") {
      const receiver = lowerer.lowerExprExpecting(expr.expression, FILEHANDLE_T);
      return { kind: "libCall", fn: "fileHandle.fd", args: [receiver], type: F64, loc };
    }
    const methods = new Set([
      "close",
      "read",
      "write",
      "readFile",
      "writeFile",
      "appendFile",
      "stat",
    ]);
    if (methods.has(name)) {
      lowerer.unsupported("SC1090", expr, `FileHandle methods as values (call '${name}' directly)`);
    }
    lowerer.noLowering(
      `FileHandle.${name}`,
      expr,
      "fd, close(), read(), write(), readFile(), writeFile(), appendFile(), and stat() are the supported FileHandle members",
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "dir") {
    if (name === "path") {
      const receiver = lowerer.lowerExprExpecting(expr.expression, DIR_T);
      return { kind: "libCall", fn: "dir.path", args: [receiver], type: STRING, loc };
    }
    if (DIR_METHODS.has(name)) {
      lowerer.unsupported("SC1090", expr, `Dir methods as values (call '${name}' directly)`);
    }
    lowerer.noLowering(
      `Dir.${name}`,
      expr,
      DIR_MEMBERS,
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  // child.stdin/stdout/stderr — the piped streams: the checker's
  // `Writable | null` / `Readable | null` (null exactly when the slot
  // was not piped), constructed type-directedly in the backend over the
  // +1-or-NULL runtime pair.
  if (kind === "child" && (name === "stdin" || name === "stdout" || name === "stderr")) {
    const receiver = lowerer.lowerExpr(expr.expression);
    // Under the general stream representation (general-streams.ts) the
    // declared stream type maps to a runtime stream class: the read
    // answers the child's bridged stream (one per stdio slot, so repeated
    // reads keep identity), fed by the same pipe.
    const general = lowerer.generalNodeStreams ? generalChildStdioType(lowerer, expr, name) : null;
    if (general) {
      const type: IrType = {
        kind: "union",
        unionId: lowerer.unions.intern([general, { kind: "nullT" }]),
      };
      const read: IrExpr = {
        kind: "libCall",
        fn: "child.stdioStream",
        args: [receiver, numLit(name === "stdin" ? 0 : name === "stdout" ? 1 : 2, loc)],
        type,
        loc,
      };
      return lowerer.maybeNarrow(read, expr);
    }
    const streamType = name === "stdin" ? CHILDWRITER_T : CHILDSTREAM_T;
    const type: IrType = {
      kind: "union",
      unionId: lowerer.unions.intern([streamType, { kind: "nullT" }]),
    };
    const read: IrExpr = {
      kind: "libCall",
      fn: name === "stdin" ? "child.stdin" : name === "stdout" ? "child.stdout" : "child.stderr",
      args: [receiver],
      type,
      loc,
    };
    return lowerer.maybeNarrow(read, expr);
  }
  if (kind === "child" && name === "connected") {
    return {
      kind: "libCall",
      fn: "child.connected",
      args: [lowerer.lowerExpr(expr.expression)],
      type: BOOL,
      loc,
    };
  }
  if (kind === "child") return null; // pid/exitCode/killed live in lowerIntrinsicProperty
  if (kind === "childWriter") {
    if (name === "writable") {
      const receiver = lowerer.lowerExprExpecting(expr.expression, CHILDWRITER_T);
      return { kind: "libCall", fn: "writer.writable", args: [receiver], type: BOOL, loc };
    }
    if (
      name === "write" ||
      name === "end" ||
      name === "destroy" ||
      name === "on" ||
      name === "once"
    ) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `child stdin methods as values (call '${name}' directly)`,
      );
    }
    lowerer.noLowering(
      `Writable.${name}`,
      expr,
      'write(string | Uint8Array), end(), destroy(), writable, and on/once("drain" | "finish" | "error", cb) are supported',
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "stats" && Object.hasOwn(STATS_FIELDS, name)) {
    const receiver = lowerer.lowerExpr(expr.expression);
    const fn = STATS_FIELDS[name]!;
    // The Date fields are the *Ms values rounded, as Node's dateFromMs builds them.
    const type = DATE_FIELDS.has(name) ? DATE_T : F64;
    return { kind: "libCall", fn, args: [receiver], type, loc };
  }
  if (kind === "spawnRes" && name === "signal") {
    const receiver = lowerer.lowerExpr(expr.expression);
    const type: IrType = {
      kind: "union",
      unionId: lowerer.unions.intern([STRING, { kind: "nullT" }]),
    };
    const read: IrExpr = { kind: "libCall", fn: "spawnRes.signal", args: [receiver], type, loc };
    return lowerer.maybeNarrow(read, expr);
  }
  return null;
}

/** The runtime stream class a child stdio read produces under the general
 * stream representation, or null when the declared type keeps the stdio
 * handle (the fallback declarations' ChildStdin). */
function generalChildStdioType(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
  name: "stdin" | "stdout" | "stderr",
): IrType | null {
  const className = name === "stdin" ? "%Writable" : "%Readable";
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (!mapped) return null;
  // Checked-dynamic stream slots: the declared stream type maps to dyn
  // (dyn-streams.ts); the read still produces the bridged stream.
  if (lowerer.dynNodeStreams && mapped.kind === "dyn") return { kind: "object", className };
  const arms =
    mapped.kind === "union" ? (lowerer.unions.get(mapped.unionId)?.arms ?? []) : [mapped];
  return arms.some((arm) => arm.kind === "object" && arm.className === className)
    ? { kind: "object", className }
    : null;
}
