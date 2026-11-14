import { isBuiltinClassInstance } from "./receiver-types.js";
import { numLit, strLit, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { isChildSurfaceMember, isChildWriterSurfaceMember } from "../surfaces.js";
import {
  BIGINT_T,
  BOOL,
  CHILDSTREAM_T,
  CHILDWRITER_T,
  CHILD_T,
  DATE_T,
  DIR_T,
  DYN,
  F64,
  FILEHANDLE_T,
  type IrExpr,
  type IrLibFn,
  type IrStmt,
  type IrType,
  NULL_T,
  STRING,
  VOID,
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
/** BigIntStats answers a `bigint` for EVERY number member of Stats — the
 * integers, the `*Ms` millisecond members (the truncated nanosecond
 * quotient, as Node's binding computes them) and the BigIntStats-only `*Ns`
 * nanosecond members. Only the four time members stay `Date`s. */
const NANOSECOND_FIELDS: Record<string, IrLibFn> = {
  atimeNs: "bigstats.atimeNs",
  mtimeNs: "bigstats.mtimeNs",
  ctimeNs: "bigstats.ctimeNs",
  birthtimeNs: "bigstats.birthtimeNs",
};
const BIGINT_STATS_FIELDS: Record<string, IrLibFn> = {
  ...Object.fromEntries(
    Object.entries(STATS_FIELDS).map(([name]) => [name, `bigstats.${name}` as IrLibFn]),
  ),
  ...NANOSECOND_FIELDS,
};

/** A Stats/BigIntStats member read off a checked-dynamic value. The stat
 * calls' run-time options ladder answers Node's object, whose member table
 * (number or bigint) only the `bigint` option read at the call knows, so
 * the member reads off the object at run time — `typeof stats.size` answers
 * "bigint" for a BigIntStats the call chose. */
function statsDynMember(expr: ts.PropertyAccessExpression, receiver: IrExpr, name: string): IrExpr {
  const loc = locOf(expr);
  return {
    kind: "dynKeyGet",
    key: { kind: "strLit", value: name, type: STRING, loc },
    ...(expr.questionDotToken ? { optional: true as const } : {}),
    value: receiver,
    type: DYN,
    loc,
  };
}
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
  // child.stdout.readableFlowing: Node's `boolean | null` (null until the
  // stream gets a 'data' listener or is paused or resumed). The handle's
  // other properties have no lowering here.
  if (
    kind === "childStream" &&
    expr.name.text === "readableFlowing" &&
    lowerer.isStdlibMember(expr)
  ) {
    const receiver = lowerer.lowerExprExpecting(expr.expression, CHILDSTREAM_T);
    const type: IrType = {
      kind: "union",
      unionId: lowerer.unions.intern([BOOL, { kind: "nullT" }]),
    };
    const read: IrExpr = {
      kind: "libCall",
      fn: "stream.childFlowing",
      args: [receiver],
      type,
      loc: locOf(expr),
    };
    return lowerer.maybeNarrow(read, expr);
  }
  if (
    kind !== "stats" &&
    kind !== "bigintStats" &&
    kind !== "fileHandle" &&
    kind !== "dir" &&
    kind !== "spawnRes" &&
    kind !== "child" &&
    kind !== "childWriter"
  )
    return null;
  if (
    kind === "child"
      ? !isChildSurfaceMember(lowerer, expr)
      : kind === "childWriter"
        ? !isChildWriterSurfaceMember(lowerer, expr)
        : !lowerer.isStdlibMember(expr)
  )
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
  // child.stdio — Node's stdio array: the piped handles at their slots
  // (the same objects stdin/stdout/stderr answer, so repeated reads and the
  // identity test agree) and null for every slot that is not a pipe. The
  // array's LENGTH is the child's stdio slot count — 3 for a spawn or an
  // exec/execFile child, 4 for a fork's IPC slot, which Node reports null —
  // so the runtime answers it and the fourth slot is appended only there.
  // Distinct slots have distinct declared types (a Writable is not a
  // Readable), so each read keeps its own two-arm union and widens into the
  // array's element union, which the equality lowering compares by tag.
  if (kind === "child" && name === "stdio") {
    const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
    const elem = mapped?.kind === "array" ? mapped.elem : null;
    const arms = elem?.kind === "union" ? (lowerer.unions.get(elem.unionId)?.arms ?? []) : [];
    const slotArm = (fd: 0 | 1 | 2): IrType | null => {
      if (lowerer.generalNodeStreams) {
        const className = fd === 0 ? "%Writable" : "%Readable";
        return arms.find((arm) => arm.kind === "object" && arm.className === className) ?? null;
      }
      const kind = fd === 0 ? "childWriter" : "childStream";
      return arms.find((arm) => arm.kind === kind) ?? null;
    };
    if (
      mapped?.kind !== "array" ||
      mapped.elem.kind !== "union" ||
      (slotArm(0) === null && slotArm(1) === null)
    ) {
      // @types/node's five-tuple declaration has no array form, and neither
      // does a checked-dynamic stream slot: the member is refused by name,
      // as every unlowered @types/node surface is, and `.length` on it
      // must not fold to the declared arity.
      lowerer.noLowering(
        "ChildProcess.stdio",
        expr,
        "child.stdio is lowered for the shipped declarations' (Writable | Readable | null)[]; @types/node's five-tuple declaration and checked-dynamic stream slots have no array form",
      );
    }
    // One array per child, as Node's ChildProcess keeps: the first read
    // builds it and stores it on the child, and every later read answers
    // that same array (so `child.stdio === child.stdio`, and an element
    // mutation is visible through both).
    const childLocal = lowerer.declareHiddenLocal("%stdioChild", CHILD_T);
    const arrLocal = lowerer.declareHiddenLocal("%stdio", mapped);
    const child = varRef(childLocal.id, CHILD_T, loc);
    const array = varRef(arrLocal.id, mapped, loc);
    const push = (value: IrExpr): IrStmt => ({
      kind: "exprStmt",
      expr: {
        kind: "arrIntrinsic",
        method: "push",
        receiver: array,
        args: [value],
        type: F64,
        loc,
      },
      loc,
    });
    const slot = (fd: 0 | 1 | 2): IrExpr => {
      const arm = slotArm(fd)!;
      const type: IrType = { kind: "union", unionId: lowerer.unions.intern([arm, NULL_T]) };
      const read: IrExpr = lowerer.generalNodeStreams
        ? { kind: "libCall", fn: "child.stdioStream", args: [child, numLit(fd, loc)], type, loc }
        : {
            kind: "libCall",
            fn: fd === 0 ? "child.stdin" : fd === 1 ? "child.stdout" : "child.stderr",
            args: [child],
            type,
            loc,
          };
      return lowerer.coerceInto(expr, read, mapped.elem);
    };
    const nullSlot = lowerer.coerceInto(
      expr,
      { kind: "unitLit", unit: "null", type: NULL_T, loc },
      mapped.elem,
    );
    const build: IrStmt[] = [
      {
        kind: "varDecl",
        localId: arrLocal.id,
        init: { kind: "arrayLit", elems: [], type: mapped, loc },
        loc,
      },
      push(slot(0)),
      push(slot(1)),
      push(slot(2)),
    ];
    // A forked child's fourth slot is its IPC channel; Node's stdio array
    // holds null there, and its length is 4.
    build.push({
      kind: "if",
      cond: {
        kind: "bin",
        op: ">",
        left: { kind: "libCall", fn: "child.stdioLen", args: [child], type: F64, loc },
        right: numLit(3, loc),
        type: BOOL,
        loc,
      },
      then: [push(nullSlot)],
      else_: null,
      loc,
    });
    build.push({
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "child.stdioStore", args: [child, array], type: VOID, loc },
      loc,
    });
    const read: IrExpr = {
      kind: "ternary",
      cond: { kind: "libCall", fn: "child.stdioCached", args: [child], type: BOOL, loc },
      then: { kind: "libCall", fn: "child.stdioArray", args: [child], type: mapped, loc },
      else_: { kind: "seqExpr", stmts: build, result: array, type: mapped, loc },
      type: mapped,
      loc,
    };
    return lowerer.maybeNarrow(
      {
        kind: "seqExpr",
        stmts: [
          {
            kind: "varDecl",
            localId: childLocal.id,
            init: lowerer.lowerExpr(expr.expression),
            loc,
          },
        ],
        result: read,
        type: mapped,
        loc,
      },
      expr,
    );
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
  const statsFields =
    kind === "stats" ? STATS_FIELDS : kind === "bigintStats" ? BIGINT_STATS_FIELDS : undefined;
  if (statsFields !== undefined && Object.hasOwn(statsFields, name)) {
    const receiver = lowerer.lowerExpr(expr.expression);
    if (receiver.type.kind === "dyn") return statsDynMember(expr, receiver, name);
    const fn = statsFields[name]!;
    // The Date fields are the millisecond value rounded, as Node's
    // dateFromMs builds them; every other Stats number is a bigint on
    // BigIntStats.
    const type = DATE_FIELDS.has(name) ? DATE_T : kind === "bigintStats" ? BIGINT_T : F64;
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
