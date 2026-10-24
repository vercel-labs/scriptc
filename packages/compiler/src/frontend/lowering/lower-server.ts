import { keyedHelperName } from "./stable-names.js";
import { lowerTlsCertificateCall } from "./builtins/x509.js";
import {
  dynUndefinedExpr,
  nodeThrowExpr,
  boolLit,
  numLit,
  strLit,
  varRef,
} from "../../ir/build.js";

import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { ladderFenceExpr } from "./lowerer.js";
import { isJsSourceFile, locOf } from "../program.js";
import {
  arrayOf,
  BOOL,
  BYTES_U8,
  canBoxFuncIntoDyn,
  canConvertToDyn,
  DYN,
  DYN_HANDLE_KINDS,
  F64,
  funcOf,
  HTTP2SESSION_T,
  HTTP2STREAM_T,
  HTTPCLIENTREQ_T,
  HTTPREQ_T,
  HTTPRES_T,
  type IrExpr,
  type IrLibFn,
  type IrStmt,
  type IrType,
  NETSERVER_T,
  NETSOCKET_T,
  NULL_T,
  SECURECTX_T,
  STRING,
  UNDEFINED_T,
  type SrcLoc,
  typeKey,
  VOID,
} from "../../ir/ir.js";
import {
  AGENT_DOCUMENTED_OPTIONS,
  HTTPS_AGENT_DOCUMENTED_OPTIONS,
  builtinFenceHintOf,
  builtinModuleFnOf,
  fenceOrDropOptionKey,
  HTTP_CLIENT_DOCUMENTED_OPTIONS,
  HTTP_SERVER_DOCUMENTED_OPTIONS,
  HTTP2_SECURE_SERVER_DOCUMENTED_OPTIONS,
  HTTPS_CLIENT_DOCUMENTED_OPTIONS,
  sideEffectFreeOptionValue,
  TLS_SERVER_DOCUMENTED_OPTIONS,
} from "./surfaces.js";
import { conditionalSpreadOf, lowerDynObjectLiteral } from "./expressions/object-literals.js";
import { resultIsDiscarded } from "./call-position.js";
import { lowerCallbackArg as lowerCallbackArgShared } from "./callback-arg.js";
import { pairsSnapshotHelper } from "./pairs-snapshot.js";

const NARROW_DATA_HINT =
  "write/end take one string or one Uint8Array/Buffer value (narrow unions first)";

/** The writable numeric http.Server timeout fields. The selector is an
 * internal runtime ABI shared by the get/set libCalls (kept here beside
 * the only two construction/lowering paths that can mint the accesses). */
function httpServerTimeoutField(name: string): number | null {
  switch (name) {
    case "timeout":
      return 0;
    case "keepAliveTimeout":
      return 1;
    case "headersTimeout":
      return 2;
    case "requestTimeout":
      return 3;
    case "keepAliveTimeoutBuffer":
      return 4;
    default:
      return null;
  }
}

/** VOID-result server/socket calls are usable as statements and as concise
 * arrow bodies (`socket.on("error", () => socket.destroy())` — the shape
 * portless is made of); anything that would CONSUME the result (Node
 * returns `this`/a boolean where this surface returns void) is fenced. */
function requireStatementPosition(lowerer: Lowerer, call: ts.CallExpression, what: string): void {
  if (resultIsDiscarded(call)) return;
  lowerer.unsupported(
    "SC1090",
    call,
    `using the result of ${what} (the result is void here — call it as its own statement)`,
  );
}

function lowerExactReusePort(lowerer: Lowerer, value: IrExpr, node: ts.Node): IrExpr {
  const loc = locOf(node);
  const falseValue = (): IrExpr => boolLit(false, loc);

  if (value.type.kind === "bool") return value;
  if (value.type.kind === "dyn") {
    return {
      kind: "dynScalarEq",
      left: value,
      right: boolLit(true, loc),
      type: BOOL,
      loc,
    };
  }

  if (value.type.kind === "union") {
    const def = lowerer.unions.get(value.type.unionId);
    const boolTag = def?.arms.findIndex((arm) => arm.kind === "bool") ?? -1;
    if (boolTag >= 0) {
      const local = lowerer.declareHiddenLocal("%listenReusePort", value.type);
      const ref = (): IrExpr => ({ kind: "varRef", localId: local.id, type: value.type, loc });
      return {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
        result: {
          kind: "ternary",
          cond: {
            kind: "unionIsTag",
            unionId: value.type.unionId,
            tag: boolTag,
            negated: false,
            value: ref(),
            type: BOOL,
            loc,
          },
          then: {
            kind: "unionNarrow",
            unionId: value.type.unionId,
            tag: boolTag,
            value: ref(),
            type: BOOL,
            loc,
          },
          else_: falseValue(),
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      };
    }
  }

  // Static non-boolean values cannot equal true, but their initializer may
  // have observable effects (for example, a getter-backed expression).
  // Keep that evaluation in the IR while disabling the kernel option.
  if (value.type.kind === "void") {
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: value, loc }],
      result: falseValue(),
      type: BOOL,
      loc,
    };
  }
  if (value.kind === "unitLit") return falseValue();
  const local = lowerer.declareHiddenLocal("%listenReusePort", value.type);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
    result: falseValue(),
    type: BOOL,
    loc,
  };
}

/** The %Error param shape the error-listener slots carry. */
const ERROR_T: IrType = { kind: "object", className: "%Error" };

/** Node ignores listener/handler return values. A value-returning
 * callback rides an interned cast-and-discard adapter (the stream lane's
 * bare-expression-body discard, generalized to closure VALUES): same
 * parameters, void return, the underlying result discarded unread. */
export function voidizedCallback(lowerer: Lowerer, cb: IrExpr, loc: SrcLoc): IrExpr {
  if (cb.type.kind !== "func" || cb.type.ret.kind === "void") return cb;
  const fromT = cb.type;
  const toT = funcOf([...fromT.params], VOID);
  const key = `server.voidcb:${typeKey(fromT)}`;
  const existing = lowerer.arrHofHelpers.get(key);
  const name = existing ?? keyedHelperName(lowerer, "%server.voidcb", key);
  if (!existing) {
    lowerer.arrHofHelpers.set(key, name);
    const impl = `${name}.impl`;
    const params = fromT.params.map((p, i) => ({ localId: `p${i}.0`, name: `p${i}`, type: p }));
    lowerer.liftedFns.push({
      name: impl,
      params,
      returnType: VOID,
      captures: [{ localId: "f.0", name: "f", type: fromT }],
      locals: [
        { id: "f.0", name: "f", type: fromT, mutable: false, boxed: true },
        ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      ],
      body: [
        {
          kind: "exprStmt",
          expr: {
            kind: "callValue",
            callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
            args: params.map((p): IrExpr => ({
              kind: "varRef",
              localId: p.localId,
              type: p.type,
              loc,
            })),
            type: fromT.ret,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "f.0", name: "f", type: fromT }],
      returnType: toT,
      locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
      body: [
        {
          kind: "return",
          value: { kind: "closure", fnName: impl, captures: ["f.0"], type: toT, adapts: true, loc },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [cb], type: toT, loc };
}

/** A socket or server listener with parameters that the runtime calls
 * through the checked-dynamic boundary (close(hadError), write's
 * cb(err), 'drop', getConnections): a dyn function value as is, or a
 * typed function boxed with per-argument checks. */
function lowerSocketDynListener(lowerer: Lowerer, node: ts.Expression, what: string): IrExpr {
  const cb = lowerer.lowerExpr(node);
  if (cb.type.kind === "dyn") return cb;
  if (
    cb.type.kind === "func" &&
    canBoxFuncIntoDyn(
      cb.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    return { kind: "dynFrom", value: cb, type: DYN, loc: locOf(node) };
  }
  lowerer.noLowering(
    `${what} that cannot cross the checked-dynamic boundary`,
    node,
    "the callback's parameters and return value must have checked-dynamic conversions",
  );
}

/** A registration/side-effect libCall re-shaped to answer its RECEIVER —
 * Node's `return this` chaining (server.listen(...), res.writeHead(...)):
 * an interned helper runs the void call and returns its first argument.
 * `prefix` calls (the writeHead statusMessage form's resStatusMsgSet)
 * run first, sharing the same parameter refs. */
function receiverReturningCall(
  lowerer: Lowerer,
  fn: IrLibFn,
  callArgs: IrExpr[],
  recvT: IrType,
  loc: SrcLoc,
  opts?: {
    prefix?: { fn: IrLibFn; argIndices: number[] };
    /** The main libCall's parameter indices (default: all, in order) —
     * the writeHead statusMessage form's msg slot feeds only the prefix. */
    mainArgIndices?: number[];
  },
): IrExpr {
  const key = `server.recvret:${fn}:${opts?.prefix?.fn ?? ""}:${(opts?.mainArgIndices ?? []).join(".")}:${callArgs.map((a) => typeKey(a.type)).join(",")}`;
  const existing = lowerer.arrHofHelpers.get(key);
  const name = existing ?? keyedHelperName(lowerer, "%server.recvret", key);
  if (!existing) {
    lowerer.arrHofHelpers.set(key, name);
    const params = callArgs.map((a, i) => ({ localId: `p${i}.0`, name: `p${i}`, type: a.type }));
    const body: IrStmt[] = [];
    if (opts?.prefix) {
      body.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: opts.prefix.fn,
          args: opts.prefix.argIndices.map((i) => varRef(params[i]!.localId, params[i]!.type, loc)),
          type: VOID,
          loc,
        },
        loc,
      });
    }
    const mainIdx = opts?.mainArgIndices ?? params.map((_, i) => i);
    body.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn,
        args: mainIdx.map((i) => varRef(params[i]!.localId, params[i]!.type, loc)),
        type: VOID,
        loc,
      },
      loc,
    });
    body.push({ kind: "return", value: varRef(params[0]!.localId, params[0]!.type, loc), loc });
    lowerer.liftedFns.push({
      name,
      params,
      returnType: recvT,
      locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      body,
      loc,
    });
  }
  return { kind: "call", callee: name, args: callArgs, type: recvT, loc };
}

/** Lowers a listener/callback argument, pinning the exact closure shape:
 * at most `maxParams` parameters and (when present) the parameter's IR
 * kind must satisfy `paramOk`. A value-returning closure adapts through
 * the cast-and-discard helper (Node ignores listener results). When
 * `dynTuple` is given (the event's payload types, every one
 * dyn-convertible) a CHECKED-DYNAMIC callback — a JS wrapper value like
 * test/common's mustCall result — adapts through the dynCheck function
 * boundary instead of fencing; handle-carrying events pass no tuple and
 * keep their fences. Returns the lowered closure and its param count. */
function lowerCallbackArg(
  lowerer: Lowerer,
  node: ts.Expression,
  what: string,
  maxParams: number,
  paramOk: (p: IrExpr["type"]) => boolean,
  paramHint: string,
  dynTuple?: readonly IrType[],
): { cb: IrExpr; nparams: number } {
  return lowerCallbackArgShared(lowerer, node, what, maxParams, paramOk, paramHint, {
    ...(dynTuple !== undefined ? { dynTuple } : {}),
    adapt: (cb) => voidizedCallback(lowerer, cb, locOf(node)),
  });
}
/** Lowers a handle-kind method receiver. The checker's control flow can
 * narrow an untyped binding to the handle class (`let server; server =
 * createServer(...)` — the keep-alive shape) so the STATIC lowering
 * claims the call while the binding's IR type is dyn: the receiver then
 * rides a dynCheck unwrap (a tag-checked reference extraction, identity
 * preserved — DYN_HANDLE_KINDS) onto the same entry points. */
/** True iff `t` is the {address: string, family: string, port: number}
 * record — server.address()'s materialized shape (lower-dgram's
 * AddressInfo check, another receiver). */
function isAddressInfoRecord(lowerer: Lowerer, t: IrType): boolean {
  if (t.kind !== "record") return false;
  const shape = lowerer.shapes.get(t.shapeId);
  if (!shape || shape.tuple || shape.indexValue || shape.fields.length !== 3) return false;
  const want: [string, string][] = [
    ["address", "string"],
    ["family", "string"],
    ["port", "f64"],
  ];
  return shape.fields.every((f, i) => f.name === want[i]![0] && f.type.kind === want[i]![1]);
}

function coerceToHandle(lowerer: Lowerer, node: ts.Expression, want: IrType): IrExpr {
  const recv = lowerer.lowerExpr(node);
  if (recv.type.kind === "dyn" && DYN_HANDLE_KINDS.has(want.kind)) {
    return { kind: "dynCheck", value: recv, type: want, loc: locOf(node) };
  }
  return recv;
}

/** Statements that build a header record `out` (a pre-declared local of
 * the pure-index record `shapeId`) from a flat [name, value, ...] pairs
 * local: every value wraps at the slot's string arm, and — when
 * `statusLocal` is given — the ":status" key is overwritten with the f64
 * arm (the response record's numeric :status, the byte-exact assert
 * target). Mirrors headersSnapshotHelper's loop, sourced from a pairs
 * array instead of reqHeaderPairs. Null when the shape is not a
 * string-armed pure-index record. */
function h2HeaderRecordStmts(
  lowerer: Lowerer,
  shapeId: string,
  pairsLocal: string,
  outLocal: string,
  statusLocal: string | null,
  loc: SrcLoc,
): IrStmt[] | null {
  const shape = lowerer.shapes.get(shapeId);
  if (!shape || shape.tuple || shape.fields.length > 0 || !shape.indexValue) return null;
  const iv = shape.indexValue;
  if (iv.kind !== "union") return null;
  const strTag = lowerer.armTag(iv.unionId, STRING);
  if (strTag < 0) return null;
  const recT: IrType = { kind: "record", shapeId };
  const pairsT = arrayOf(STRING);

  const pairAt = (offset: number): IrExpr => ({
    kind: "arrayGet",
    arr: varRef(pairsLocal, pairsT, loc),
    index:
      offset === 0
        ? varRef("i.0", F64, loc)
        : {
            kind: "bin",
            op: "+",
            left: varRef("i.0", F64, loc),
            right: numLit(offset, loc),
            type: F64,
            loc,
          },
    type: STRING,
    loc,
  });
  const stmts: IrStmt[] = [
    {
      kind: "varDecl",
      localId: outLocal,
      init: { kind: "recordLit", fields: [], type: recT, loc },
      loc,
    },
    {
      kind: "for",
      init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
      cond: {
        kind: "bin",
        op: "<",
        left: varRef("i.0", F64, loc),
        right: {
          kind: "arrIntrinsic",
          method: "length",
          receiver: varRef(pairsLocal, pairsT, loc),
          args: [],
          type: F64,
          loc,
        },
        type: BOOL,
        loc,
      },
      update: {
        kind: "assign",
        localId: "i.0",
        value: {
          kind: "bin",
          op: "+",
          left: varRef("i.0", F64, loc),
          right: numLit(2, loc),
          type: F64,
          loc,
        },
        loc,
      },
      body: [
        {
          kind: "recordKeySet",
          obj: varRef(outLocal, recT, loc),
          shapeId,
          key: pairAt(0),
          value: {
            kind: "unionWrap",
            unionId: iv.unionId,
            tag: strTag,
            value: pairAt(1),
            type: iv,
            loc,
          },
          loc,
        },
      ],
      loc,
    },
  ];
  if (statusLocal !== null) {
    const f64Tag = lowerer.armTag(iv.unionId, F64);
    if (f64Tag < 0) return null;
    stmts.push({
      kind: "recordKeySet",
      obj: varRef(outLocal, recT, loc),
      shapeId,
      key: { kind: "strLit", value: ":status", type: STRING, loc },
      value: {
        kind: "unionWrap",
        unionId: iv.unionId,
        tag: f64Tag,
        value: varRef(statusLocal, F64, loc),
        type: iv,
        loc,
      },
      loc,
    });
  }
  return stmts;
}

/** The record shapeId of a callback parameter that must be the canonical
 * header record (a pure-index string-armed record). Null when the param
 * is absent or not such a record. */
function headerParamShapeId(cbT: IrType, idx: number): string | null {
  if (cbT.kind !== "func") return null;
  const p = cbT.params[idx];
  if (!p || p.kind !== "record") return null;
  return p.shapeId;
}

/** Adapts a user 'stream'/'response' listener to the runtime thunk ABI,
 * building the header record from the pairs the runtime hands over. The
 * runtime ABI's leading param is the STREAM handle (kind === handleKind,
 * or absent for 'response'); a trailing f64 status feeds the record's
 * :status when `withStatus`. Returns the adapter closure (VOID-returning,
 * runtime ABI) to pass into the libCall. */
/** The canonical header record type — a pure-index record over the
 * header slot `f64 | string | string[] | undefined` (type-mapper.ts's
 * HEADER-FAMILY canonicalization, rebuilt here for dyn-callback headers
 * with no static param type to read the shape from). */
function canonicalHeaderRecord(lowerer: Lowerer): { type: IrType; shapeId: string } {
  const arms = [F64, STRING, arrayOf(STRING), UNDEFINED_T];
  arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  const slot: IrType = { kind: "union", unionId: lowerer.unions.intern(arms) };
  const shapeId = lowerer.shapes.intern([], false, slot, []);
  return { type: { kind: "record", shapeId }, shapeId };
}

function h2HeadersCallbackAdapter(
  lowerer: Lowerer,
  node: ts.Expression,
  what: string,
  handleKind: "http2Stream" | null,
  withStatus: boolean,
  loc: SrcLoc,
): IrExpr {
  let cb = lowerer.lowerExpr(node);
  const maxParams = (handleKind ? 1 : 0) + 1 /* headers */ + 1; /* flags */
  // A checked-dynamic listener (test/common's mustCall wrapper — a dyn
  // value or an arguments-reading rest function of dyn params): wrap it
  // in a dynCheck to the CANONICAL event signature, then build the header
  // record and invoke through that typed boundary (handles box by
  // reference, the record boxes to a dyn object — the net server-callbacks
  // precedent). The synthesized record IS the shape the adapter builds.
  const handleT = handleKind === "http2Stream" ? HTTP2STREAM_T : null;
  const isDynCb =
    cb.type.kind === "dyn" ||
    (cb.type.kind === "func" &&
      (cb.type.rest === true || cb.type.params.every((p) => p.kind === "dyn")) &&
      canBoxFuncIntoDyn(
        cb.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      ));
  if (isDynCb) {
    const rec = canonicalHeaderRecord(lowerer);
    const tuple: IrType[] = [];
    if (handleT) tuple.push(handleT);
    tuple.push(rec.type);
    tuple.push(F64);
    const toT = funcOf(tuple, VOID);
    const boxed: IrExpr =
      cb.type.kind === "dyn" ? cb : { kind: "dynFrom", value: cb, type: DYN, loc };
    cb = { kind: "dynCheck", value: boxed, type: toT, loc };
  }
  if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > maxParams) {
    lowerer.unsupported(
      "SC1090",
      node,
      `${what} with more than ${maxParams} parameters or returning a value`,
    );
  }
  const fromT = cb.type;
  const headersIdx = handleT ? 1 : 0;
  const shapeId = fromT.params.length > headersIdx ? headerParamShapeId(fromT, headersIdx) : null;
  if (fromT.params.length > headersIdx && shapeId === null) {
    lowerer.unsupported(
      "SC1090",
      node,
      `${what} whose headers parameter is not a header record (type it IncomingHttpHeaders)`,
    );
  }
  // Runtime ABI params, in order.
  const abiParams: { localId: string; name: string; type: IrType }[] = [];
  if (handleT) abiParams.push({ localId: "h.0", name: "h", type: handleT });
  abiParams.push({ localId: "ps.0", name: "ps", type: arrayOf(STRING) });
  if (withStatus) abiParams.push({ localId: "st.0", name: "st", type: F64 });
  abiParams.push({ localId: "fl.0", name: "fl", type: F64 });
  const toT = funcOf(
    abiParams.map((p) => p.type),
    VOID,
  );
  const key = `h2.hdrcb:${handleKind}:${withStatus}:${typeKey(fromT)}:${shapeId ?? ""}`;
  const existing = lowerer.arrHofHelpers.get(key);
  const name = existing ?? keyedHelperName(lowerer, "%h2.hdrcb", key);
  if (!existing) {
    lowerer.arrHofHelpers.set(key, name);
    const impl = `${name}.impl`;
    const locals: import("../../ir/ir.js").IrLocal[] = [
      { id: "f.0", name: "f", type: fromT, mutable: false, boxed: true },
      ...abiParams.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
    ];
    const body: IrStmt[] = [];
    let recordRef: IrExpr | null = null;
    if (shapeId !== null) {
      locals.push({ id: "out.0", name: "out", type: { kind: "record", shapeId }, mutable: false });
      locals.push({ id: "i.0", name: "i", type: F64, mutable: true });
      const stmts = h2HeaderRecordStmts(
        lowerer,
        shapeId,
        "ps.0",
        "out.0",
        withStatus ? "st.0" : null,
        loc,
      );
      if (stmts === null)
        lowerer.unsupported(
          "SC1090",
          node,
          `${what} whose headers parameter is not a supported header record`,
        );
      body.push(...stmts!);
      recordRef = varRef("out.0", { kind: "record", shapeId }, loc);
    }
    // Assemble the user-call arguments in the user's declared order.
    const callArgs: IrExpr[] = [];
    const push = (e: IrExpr) => {
      if (callArgs.length < fromT.params.length) callArgs.push(e);
    };
    if (handleT) push(varRef("h.0", handleT, loc));
    if (recordRef) push(recordRef);
    else if (fromT.params.length > headersIdx) push(varRef("ps.0", arrayOf(STRING), loc));
    push(varRef("fl.0", F64, loc));
    body.push({
      kind: "exprStmt",
      expr: {
        kind: "callValue",
        callee: varRef("f.0", fromT, loc),
        args: callArgs.slice(0, fromT.params.length),
        type: fromT.ret,
        loc,
      },
      loc,
    });
    lowerer.liftedFns.push({
      name: impl,
      params: abiParams,
      returnType: VOID,
      captures: [{ localId: "f.0", name: "f", type: fromT }],
      locals,
      body,
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "f.0", name: "f", type: fromT }],
      returnType: toT,
      locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
      body: [
        {
          kind: "return",
          value: { kind: "closure", fnName: impl, captures: ["f.0"], type: toT, loc },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [cb], type: toT, loc };
}

/** Builds the flat [name, value, ...] pairs array from an OutgoingHttp
 * Headers argument (an object literal with literal/pseudo keys, or a
 * header Record). Reuses lowerClientHeadersOption's shape. */
function lowerH2HeadersArg(lowerer: Lowerer, node: ts.Expression): IrExpr {
  return lowerClientHeadersOption(lowerer, node);
}

/** The STATICALLY-KNOWN key text of a header-object property: literal
 * identifier/string keys, plus COMPUTED keys that are a bare identifier
 * of string-literal type — `[PORTLESS_HEADER]: "1"` over a module const
 * (the portless proxy shape) is as static as spelling the name out, and
 * an identifier read has no side effects to drop. Null for genuinely
 * dynamic keys (the caller fences). */
function staticHeaderKeyOf(lowerer: Lowerer, prop: ts.PropertyAssignment): string | null {
  if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) return prop.name.text;
  if (ts.isComputedPropertyName(prop.name) && ts.isIdentifier(prop.name.expression)) {
    const t = lowerer.typeOf(prop.name.expression);
    if (t.isStringLiteralType()) return t.value;
  }
  return null;
}

/** Module-function calls on net import bindings: createServer(handler?),
 * connect/createConnection(port[, host][, cb]). Null for other modules
 * (the caller falls through to the ordinary builtin tables); every net
 * member lands here — unlowered ones fence with their module-qualified
 * name. */
export function lowerNetModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module === "http") return lowerHttpModuleCall(lowerer, expr, bi, loc);
  if (bi.module === "https") return lowerHttpsModuleCall(lowerer, expr, bi, loc);
  if (bi.module === "tls") return lowerTlsModuleCall(lowerer, expr, bi, loc);
  if (bi.module === "http2") return lowerHttp2ModuleCall(lowerer, expr, bi, loc);
  if (bi.module !== "net") return null;
  // Members with ordinary surfaces.ts table entries (the autoselect
  // budget pair) ride the generic path — null hands the dispatch back.
  if (builtinModuleFnOf(lowerer, "net", bi.member)) return null;
  const args = expr.arguments.nodes;
  if (bi.member === "createServer") {
    if (args.length === 0) {
      return { kind: "libCall", fn: "net.createServer", args: [], type: NETSERVER_T, loc };
    }
    if (args.length === 1) {
      // A provably-non-object, non-function argument (the invalid-input
      // probes: createServer('path'), createServer(0)): Node throws
      // ERR_INVALID_ARG_TYPE on 'options' before any server exists. DYN
      // result — the checked-dynamic lane's concise arrows box it, and
      // the throw means it never materializes.
      if (isJsSourceFile(ts.getSourceFileOfNode(expr))) {
        const t = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
        if (t !== null && (t.kind === "string" || t.kind === "f64" || t.kind === "bool")) {
          const raw = lowerer.lowerExpr(args[0]!);
          return {
            kind: "libCall",
            fn: "error.argTypeThrow",
            args: [
              { kind: "strLit", value: "options", type: STRING, loc },
              { kind: "strLit", value: "of type object", type: STRING, loc },
              { kind: "dynFrom", value: raw, type: DYN, loc },
            ],
            type: NETSERVER_T,
            loc,
          };
        }
      }
      const { cb } = lowerCallbackArg(
        lowerer,
        args[0]!,
        "connection handlers",
        1,
        (p) => p.kind === "netSocket",
        "use (socket) or ()",
        [NETSOCKET_T],
      );
      return { kind: "libCall", fn: "net.createServerCb", args: [cb], type: NETSERVER_T, loc };
    }
    lowerer.noLowering(
      `createServer with ${args.length} arguments`,
      expr,
      "the supported forms are createServer() and createServer(socket => ...)",
    );
  }
  if (bi.member === "connect" || bi.member === "createConnection") {
    // The options-object form — connect({ port, host?, autoSelectFamily?,
    // lookup? }): portless's createLoopbackConnection. A `lookup` function
    // OVERRIDES resolution: the runtime invokes it as Node does —
    // lookup(hostname, options, callback) with callback(err, addresses)
    // — and dials the answered addresses IN ORDER, each connect failure
    // trying the next (the fixed-list autoSelectFamily behavior;
    // autoSelectFamily must be the literal `true` alongside it, portless's
    // spelling — without it Node would dial only the first address). The
    // no-lookup form is connect(port, host) with the option spellings.
    if (args.length >= 1 && ts.isObjectLiteralExpression(args[0]!)) {
      return lowerNetConnectOptions(lowerer, expr, bi.member, loc);
    }
    // A RUNTIME option bag (a record binding or dyn value — the
    // invalid-input probes build theirs with computed keys): the
    // checked-dynamic walk validates Node-order and the compiler-rendered
    // fence is the post-validation tail.
    if (args.length === 1 && isJsSourceFile(ts.getSourceFileOfNode(expr))) {
      const t = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
      if (t !== null && (t.kind === "dyn" || t.kind === "record")) {
        const raw = lowerer.lowerExpr(args[0]!);
        if (raw.type.kind === "dyn" || lowerer.dynConvertible(raw.type)) {
          const bag: IrExpr =
            raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
          return {
            kind: "libCall",
            fn: "net.connectOptsChk",
            args: [
              bag,
              ladderFenceExpr(
                lowerer,
                `${bi.member} with a runtime options record`,
                expr,
                "pass the options as an object literal — port, host, autoSelectFamily, autoSelectFamilyAttemptTimeout, and lookup are the supported options",
              ),
            ],
            type: NETSOCKET_T,
            loc,
          };
        }
      }
    }
    if (args.length < 1 || args.length > 3) {
      lowerer.noLowering(
        `${bi.member} with ${args.length} arguments`,
        expr,
        `the supported form is ${bi.member}(port, host?, connectListener?)`,
      );
    }
    const port = lowerer.lowerExprExpecting(args[0]!, F64);
    // The optional middle host: a 2-arg call's second argument is the
    // host when string-typed, the connect listener when func-typed.
    let hostNode: ts.Expression | undefined;
    let cbNode: ts.Expression | undefined;
    if (args.length === 2) {
      if (lowerer.mapTypeOf(lowerer.typeOf(args[1]!))?.kind === "string") hostNode = args[1];
      else cbNode = args[1];
    } else if (args.length === 3) {
      hostNode = args[1];
      cbNode = args[2];
    }
    const host: IrExpr = hostNode
      ? lowerer.lowerExprExpecting(hostNode, STRING)
      : { kind: "strLit", value: "localhost", type: STRING, loc };
    if (!cbNode) {
      return { kind: "libCall", fn: "net.connect", args: [port, host], type: NETSOCKET_T, loc };
    }
    const { cb } = lowerCallbackArg(
      lowerer,
      cbNode,
      "connect listeners",
      0,
      () => false,
      "use ()",
      [],
    );
    return { kind: "libCall", fn: "net.connectCb", args: [port, host, cb], type: NETSOCKET_T, loc };
  }
  lowerer.noLowering(
    `net.${bi.member}`,
    expr,
    "createServer, connect, and createConnection are the lowered net module functions",
    lowerer.resolveValueSymbol(expr.expression as ts.Identifier),
  );
}

/** True when `t` is the lookup-function shape the connect lowering
 * accepts: (hostname: string, options: unknown, callback) => void where
 * callback is (err: <union with a null arm>, addresses: { address:
 * string, ... }[]) => void — Node's net.LookupFunction as portless
 * declares it. */
function lookupFnShapeOk(lowerer: Lowerer, t: IrType): boolean {
  if (t.kind !== "func" || t.ret.kind !== "void" || t.params.length !== 3) return false;
  if (t.params[0]!.kind !== "string") return false;
  if (t.params[1]!.kind !== "dyn") return false;
  const cbT = t.params[2]!;
  if (cbT.kind !== "func" || cbT.ret.kind !== "void" || cbT.params.length !== 2) return false;
  const errT = cbT.params[0]!;
  if (errT.kind !== "union") return false;
  const errDef = lowerer.unions.get(errT.unionId);
  if (!errDef || !errDef.arms.some((a) => a.kind === "nullT")) return false;
  // Every non-null arm must be the Error root: the emitted answer thunk
  // reads .message off a non-null payload.
  if (
    !errDef.arms.every(
      (a) => a.kind === "nullT" || (a.kind === "object" && a.className === "%Error"),
    )
  ) {
    return false;
  }
  const addrsT = cbT.params[1]!;
  if (addrsT.kind !== "array" || addrsT.elem.kind !== "record") return false;
  const shape = lowerer.shapes.get(addrsT.elem.shapeId);
  return !!shape && shape.fields.some((f) => f.name === "address" && f.type.kind === "string");
}

/** net.connect / net.createConnection with an OPTIONS OBJECT: { port,
 * host?, autoSelectFamily?, lookup? }. Without `lookup` this is the
 * (port, host) form in option spelling; with it the runtime drives the
 * caller's resolver and dials its answered addresses in order (the
 * fixed-list autoSelectFamily behavior — the literal `true` is required
 * alongside, portless's createLoopbackConnection). Other keys fence by
 * name; a connect listener argument is supported on the no-lookup form
 * only. */
function lowerNetConnectOptions(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: string,
  loc: SrcLoc,
): IrExpr {
  const args = expr.arguments.nodes;
  const optsNode = args[0] as ts.ObjectLiteralExpression;
  const isJs = isJsSourceFile(ts.getSourceFileOfNode(expr));
  // The checked-dynamic option-bag route (JS sources): a literal with
  // computed keys (the invalid-input probes' spelling) or an objectMode-
  // trio member rides WHOLE to the runtime walk — Node's Socket-ctor
  // validation order (the trio's ERR_INVALID_ARG_VALUE first, then
  // port/host/autoSelectFamily), with the compiler-rendered fence as the
  // post-validation tail.
  if (isJs) {
    const needsBag = optsNode.properties.nodes.some(
      (p) =>
        (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) ||
        (ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name)) ||
        ["objectMode", "readableObjectMode", "writableObjectMode"].includes(
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
            ? p.name.text
            : "",
        ),
    );
    if (needsBag) {
      const raw = lowerer.lowerExpr(optsNode);
      if (raw.type.kind === "dyn" || lowerer.dynConvertible(raw.type)) {
        const bag: IrExpr =
          raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
        return {
          kind: "libCall",
          fn: "net.connectOptsChk",
          args: [
            bag,
            ladderFenceExpr(
              lowerer,
              `${member} with these options`,
              optsNode,
              "port, host, autoSelectFamily, autoSelectFamilyAttemptTimeout, and lookup are the supported options",
            ),
          ],
          type: NETSOCKET_T,
          loc,
        };
      }
    }
  }
  let port: IrExpr | null = null;
  let host: IrExpr | null = null;
  let lookup: IrExpr | null = null;
  let dynLookup: IrExpr | null = null;
  let autoSelect = false;
  let attempt: IrExpr | null = null;
  let optionThrow: IrExpr | null = null;
  const propThrow = (name: string, expected: string, got: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "error.propTypeThrow",
    args: [
      { kind: "strLit", value: name, type: STRING, loc },
      { kind: "strLit", value: expected, type: STRING, loc },
      got.type.kind === "dyn" ? got : { kind: "dynFrom", value: got, type: DYN, loc },
    ],
    type: NETSOCKET_T,
    loc,
  });
  for (const prop of optsNode.properties.nodes) {
    let initializer: ts.Expression | null;
    if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    ) {
      initializer = prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      initializer = null;
    } else {
      lowerer.noLowering(
        `${member} options with computed keys or spreads`,
        prop,
        "each option must be a plain `name: value` (or shorthand) entry with a literal key",
      );
    }
    const key = (prop.name as ts.Identifier | ts.StringLiteral).text;
    const lowerVal = (): IrExpr =>
      initializer !== null
        ? lowerer.lowerExpr(initializer)
        : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
    if (key === "port") {
      port = lowerVal();
      if (port.type.kind !== "f64") {
        lowerer.noLowering(
          `a ${member} 'port' option of '${lowerer.fmt(port.type)}' values`,
          prop,
          "the port is a number here",
        );
      }
    } else if (key === "host") {
      host = lowerVal();
      if (host.type.kind !== "string") {
        // A provably-non-string host (the invalid-input probes): Node's
        // lookupAndConnect throws ERR_INVALID_ARG_TYPE at connect time.
        if (isJs && (host.type.kind === "dyn" || lowerer.dynConvertible(host.type))) {
          optionThrow ??= propThrow("options.host", "of type string", host);
          host = null;
          continue;
        }
        lowerer.noLowering(
          `a ${member} 'host' option of '${lowerer.fmt(host.type)}' values`,
          prop,
          "the host is a string here",
        );
      }
    } else if (key === "autoSelectFamily") {
      // The literal `true` only: it is what licenses the try-each-address
      // dial below (false/dynamic would mean Node's single-address dial,
      // which the lookup form does not implement).
      if (initializer === null || initializer.kind !== ts.SyntaxKind.TrueKeyword) {
        // A provably-non-boolean value throws Node's validateBoolean
        // ladder instead of fencing.
        const raw = initializer !== null && isJs ? lowerer.lowerExpr(initializer) : null;
        if (
          raw !== null &&
          raw.type.kind !== "bool" &&
          (raw.type.kind === "dyn" || lowerer.dynConvertible(raw.type))
        ) {
          optionThrow ??= propThrow("options.autoSelectFamily", "of type boolean", raw);
          continue;
        }
        lowerer.noLowering(
          `${member} with a non-literal autoSelectFamily option`,
          prop,
          "the lowered form is autoSelectFamily: true beside a lookup function",
        );
      }
      autoSelect = true;
    } else if (key === "autoSelectFamilyAttemptTimeout") {
      // The attempt budget validates at runtime (Node's validateInt32-
      // from-1 ladder) and is then inert — the single dial has nothing
      // to time, the autoSelectFamily simplification's sibling.
      const raw = lowerVal();
      if (
        !(raw.type.kind === "dyn" || raw.kind === "unitLit" || lowerer.dynConvertible(raw.type))
      ) {
        lowerer.noLowering(
          `a ${member} 'autoSelectFamilyAttemptTimeout' option of '${lowerer.fmt(raw.type)}' values`,
          prop,
          "the budget is a number here",
        );
      }
      attempt = raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
    } else if (key === "lookup") {
      if (initializer === null) {
        lowerer.noLowering(
          `${member} with a shorthand lookup option`,
          prop,
          "spell it out: lookup: theResolver",
        );
      }
      lookup = lowerer.lowerExpr(initializer);
      // A lookup of Node's own type (net.LookupFunction: options and a
      // callback taking an address string or list) crosses as a checked-
      // dynamic function the runtime calls the way Node's dial does.
      if (
        !lookupFnShapeOk(lowerer, lookup.type) &&
        lookup.type.kind === "func" &&
        lookup.type.params.length === 3 &&
        canBoxFuncIntoDyn(
          lookup.type,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      ) {
        dynLookup = { kind: "dynFrom", value: lookup, type: DYN, loc: locOf(initializer) };
      } else if (lookup.type.kind === "dyn") {
        dynLookup = lookup;
      } else if (!lookupFnShapeOk(lowerer, lookup.type)) {
        lowerer.noLowering(
          `a ${member} 'lookup' option of '${lowerer.fmt(lookup.type)}' values`,
          prop,
          "the lowered resolver is (hostname: string, options: unknown, callback: (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void) => void",
        );
      }
    } else {
      lowerer.noLowering(
        `${member} option '${key}'`,
        prop,
        "port, host, autoSelectFamily, and lookup are the supported options",
      );
    }
  }
  // A collected option-contract violation replaces the whole call: Node
  // throws it from Socket.connect before dialing (port validation held —
  // the port arm above fenced non-number ports already).
  if (optionThrow !== null) return optionThrow;
  if (port === null) {
    lowerer.noLowering(
      `${member} options without a port`,
      optsNode,
      "the supported options object is { port, host?, autoSelectFamily?, lookup? }",
    );
  }
  host ??= { kind: "strLit", value: "localhost", type: STRING, loc };
  if (attempt !== null) {
    if (lookup !== null || args.length !== 1) {
      lowerer.noLowering(
        `${member} with an autoSelectFamilyAttemptTimeout beside a lookup or connect listener`,
        expr,
        "the validated-budget form is the bare options call — register listeners separately",
      );
    }
    return {
      kind: "libCall",
      fn: "net.connectAttempt",
      args: [port, host, attempt],
      type: NETSOCKET_T,
      loc,
    };
  }
  if (dynLookup !== null) {
    if (args.length !== 1) {
      lowerer.noLowering(
        `${member} with a lookup and a connect listener`,
        expr,
        "register the listener separately: socket.once('connect', ...)",
      );
    }
    return {
      kind: "libCall",
      fn: "net.connectLookupDyn",
      args: [port, host, dynLookup],
      type: NETSOCKET_T,
      loc,
    };
  }
  if (lookup !== null) {
    if (!autoSelect) {
      lowerer.noLowering(
        `${member} with a lookup but no autoSelectFamily: true`,
        optsNode,
        "the lookup form dials every answered address in order — Node does that under autoSelectFamily: true, so spell it",
      );
    }
    if (args.length !== 1) {
      lowerer.noLowering(
        `${member} with a lookup and a connect listener`,
        expr,
        "register the listener separately: socket.once('connect', ...)",
      );
    }
    return {
      kind: "libCall",
      fn: "net.connectLookup",
      args: [port, host, lookup],
      type: NETSOCKET_T,
      loc,
    };
  }
  if (args.length === 1) {
    return { kind: "libCall", fn: "net.connect", args: [port, host], type: NETSOCKET_T, loc };
  }
  if (args.length !== 2) {
    lowerer.noLowering(
      `${member} with ${args.length} arguments`,
      expr,
      `the supported form is ${member}(options[, connectListener])`,
    );
  }
  const { cb } = lowerCallbackArg(
    lowerer,
    args[1]!,
    "connect listeners",
    0,
    () => false,
    "use ()",
    [],
  );
  return { kind: "libCall", fn: "net.connectCb", args: [port, host, cb], type: NETSOCKET_T, loc };
}

/** `wrapper.close.bind(wrapper)` — the bound REAL close as a VALUE (the
 * portless close-proxy idiom, paired with the `wrapper.close = fn`
 * override assignment): a compiler-emitted closure over the server whose
 * invocation closes DIRECTLY (never through the override, so the
 * override body's `origClose(cb)` cannot recurse) and answers the server
 * (Node's chaining return). The bind argument must be the same server
 * binding as the method receiver — any other `this` would be a
 * different close. Null when the shape doesn't match (generic fences
 * name `.bind` otherwise). */
function lowerServerCloseBind(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text !== "bind") return null;
  const closeAccess = access.expression;
  if (!ts.isPropertyAccessExpression(closeAccess) || closeAccess.name.text !== "close") return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(closeAccess.expression))?.kind !== "netServer") return null;
  if (!lowerer.isStdlibMember(closeAccess)) return null;
  const loc = locOf(call);
  const recvNode = closeAccess.expression;
  const thisArg = call.arguments.nodes[0];
  if (
    call.arguments.nodes.length !== 1 ||
    !thisArg ||
    !ts.isIdentifier(recvNode) ||
    !ts.isIdentifier(thisArg) ||
    lowerer.resolveValueSymbol(recvNode) !== lowerer.resolveValueSymbol(thisArg)
  ) {
    lowerer.noLowering(
      "close.bind with this argument shape",
      call,
      "the supported form is server.close.bind(server) — the same server binding on both sides",
    );
  }
  const server = lowerer.lowerExpr(thisArg);
  const t = lowerer.mapTypeOf(lowerer.typeOf(call));
  const cbUnion = t?.kind === "func" && t.params.length === 1 ? t.params[0]! : null;
  const cbOk =
    cbUnion?.kind === "union" &&
    (() => {
      const def = lowerer.unions.get(cbUnion.unionId);
      return (
        !!def &&
        def.arms.some((a) => a.kind === "func" && a.params.length <= 1 && a.ret.kind === "void") &&
        def.arms.some((a) => a.kind === "undefinedT")
      );
    })();
  // Both type worlds pass: @types/node spells (callback?: (err?: Error)
  // => void) => Server; the shipped fallback (callback?: () => void) =>
  // void — the emitted adapter follows the mapped shape either way.
  if (!t || t.kind !== "func" || !cbOk || (t.ret.kind !== "netServer" && t.ret.kind !== "void")) {
    lowerer.noLowering(
      "close.bind with this signature",
      call,
      "the bound close is (callback?: (err?: Error) => void) => Server",
    );
  }
  return { kind: "libCall", fn: "net.serverCloseBind", args: [server], type: t, loc };
}

/** `wrapper.close = fn` (the close-override assignment — lower-stmts
 * routes property-assignment statements here before its generic fence):
 * the function value MOVES into the server's override slot behind an
 * emitted zero-arg wrapper; server.close() runs it instead of closing,
 * and the override reaches the real close through its bound origClose.
 * Null when the target isn't a net.Server close member. */
export function lowerServerCloseOverrideAssignment(
  lowerer: Lowerer,
  left: ts.Expression,
  right: ts.Expression,
  loc: SrcLoc,
): IrStmt | null {
  if (!ts.isPropertyAccessExpression(left) || left.questionDotToken) return null;
  if (left.name.text !== "close") return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(left.expression))?.kind !== "netServer") return null;
  const server = lowerer.lowerExpr(left.expression);
  const value = lowerer.lowerExpr(right);
  const t = value.type;
  const cbUnion = t.kind === "func" && t.params.length === 1 ? t.params[0]! : null;
  const shapeOk =
    cbUnion?.kind === "union" &&
    t.kind === "func" &&
    (t.ret.kind === "netServer" || t.ret.kind === "void") &&
    (() => {
      const def = lowerer.unions.get(cbUnion.unionId);
      return (
        !!def &&
        def.arms.some((a) => a.kind === "func" && a.params.length <= 1 && a.ret.kind === "void") &&
        def.arms.some((a) => a.kind === "undefinedT")
      );
    })();
  if (!shapeOk) {
    lowerer.noLowering(
      "assigning this value to server.close",
      right,
      "the override must be a (callback?: (err?: Error) => void) => Server function",
    );
  }
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "net.serverSetCloseOverride",
      args: [server, value],
      type: VOID,
      loc,
    },
    loc,
  };
}

/** Writable ServerResponse properties consulted by the implicit head and
 * the strict body-length check. Null when the target isn't one of them. */
export function lowerHttpResPropertyAssignment(
  lowerer: Lowerer,
  left: ts.Expression,
  right: ts.Expression,
  loc: SrcLoc,
): IrStmt | null {
  if (!ts.isPropertyAccessExpression(left) || left.questionDotToken) return null;
  const name = left.name.text;
  if (
    name !== "statusCode" &&
    name !== "statusMessage" &&
    name !== "sendDate" &&
    name !== "strictContentLength"
  )
    return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(left.expression))?.kind !== "httpRes") return null;
  if (!lowerer.isStdlibMember(left)) return null;
  const receiver = coerceToHandle(lowerer, left.expression, HTTPRES_T);
  const value =
    name === "statusCode"
      ? lowerer.lowerExprExpecting(right, F64)
      : lowerer.lowerExprExpecting(right, name === "statusMessage" ? STRING : BOOL);
  const fn: IrLibFn =
    name === "statusCode"
      ? "http.resStatusSet"
      : name === "statusMessage"
        ? "http.resStatusMsgSet"
        : name === "sendDate"
          ? "http.resSendDateSet"
          : "http.resStrictContentLengthSet";
  return {
    kind: "exprStmt",
    expr: { kind: "libCall", fn, args: [receiver, value], type: VOID, loc },
    loc,
  };
}

/** `server.timeout = n` and the four HTTP parser/keep-alive timeout
 * siblings. These are ordinary writable number properties in Node: the
 * runtime stores their exact value per server; active timeout behavior is
 * a separate protocol concern. */
export function lowerHttpServerTimeoutAssignment(
  lowerer: Lowerer,
  left: ts.Expression,
  right: ts.Expression,
  loc: SrcLoc,
): IrStmt | null {
  if (!ts.isPropertyAccessExpression(left) || left.questionDotToken) return null;
  const field = httpServerTimeoutField(left.name.text);
  if (field === null) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(left.expression))?.kind !== "netServer") return null;
  if (!lowerer.isStdlibMember(left)) return null;
  const receiver = coerceToHandle(lowerer, left.expression, NETSERVER_T);
  const selector: IrExpr = { kind: "numLit", value: field, type: F64, loc };
  const value = lowerer.lowerExprExpecting(right, F64);
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "http.serverTimeoutSet",
      args: [receiver, selector, value],
      type: VOID,
      loc,
    },
    loc,
  };
}

/** `server.maxConnections = n`: the value crosses as a dyn (undefined
 * and null unset the cap). `server.dropMaxConnection = v` stores the
 * value as is (Node reads it only in cluster mode). */
export function lowerNetServerMaxConnectionsAssignment(
  lowerer: Lowerer,
  left: ts.Expression,
  right: ts.Expression,
  loc: SrcLoc,
): IrStmt | null {
  if (!ts.isPropertyAccessExpression(left) || left.questionDotToken) return null;
  const name = left.name.text;
  if (name !== "maxConnections" && name !== "dropMaxConnection") return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(left.expression))?.kind !== "netServer") return null;
  if (!lowerer.isStdlibMember(left)) return null;
  const receiver = coerceToHandle(lowerer, left.expression, NETSERVER_T);
  const value = lowerer.coerceToExpected(lowerer.lowerExpr(right), DYN);
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn:
        name === "maxConnections"
          ? "net.serverMaxConnectionsSet"
          : "net.serverDropMaxConnectionSet",
      args: [receiver, value],
      type: VOID,
      loc,
    },
    loc,
  };
}

/** Method calls on net.Server receivers: listen(port[, cb]), close([cb]),
 * on/once("connection" | "error" | "close", cb). address() alone fences
 * toward the composed address().port read. Null for other receivers. */
function lowerNetServerMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "netServer") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if (name === "getConnections") {
    // cb(null, count) on the next tick; answers the server.
    if (args.length !== 1) {
      lowerer.noLowering(
        `getConnections with ${args.length} arguments`,
        call,
        "the form is getConnections(callback)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSERVER_T);
    const cb = lowerSocketDynListener(lowerer, args[0]!, "getConnections callbacks");
    if (resultIsDiscarded(call)) {
      return {
        kind: "libCall",
        fn: "net.serverGetConnections",
        args: [receiver, cb],
        type: VOID,
        loc,
      };
    }
    return receiverReturningCall(
      lowerer,
      "net.serverGetConnections",
      [receiver, cb],
      NETSERVER_T,
      loc,
    );
  }
  if (name === "setTimeout") {
    if (args.length < 1 || args.length > 2)
      lowerer.noLowering(
        "server.setTimeout arguments",
        call,
        "pass milliseconds and an optional socket callback",
      );
    const receiver = coerceToHandle(lowerer, access.expression, NETSERVER_T);
    const ms = lowerer.lowerExprExpecting(args[0]!, F64);
    const cb =
      args.length === 2
        ? lowerCallbackArg(
            lowerer,
            args[1]!,
            "server timeout callbacks",
            1,
            (p) => p.kind === "netSocket",
            "use (socket) or ()",
            [NETSOCKET_T],
          ).cb
        : null;
    const fn: IrLibFn = cb === null ? "http.serverSetTimeout" : "http.serverSetTimeoutCb";
    const callArgs = cb === null ? [receiver, ms] : [receiver, ms, cb];
    if (resultIsDiscarded(call)) return { kind: "libCall", fn, args: callArgs, type: VOID, loc };
    return receiverReturningCall(lowerer, fn, callArgs, NETSERVER_T, loc);
  }
  if (name === "closeAllConnections" || name === "closeIdleConnections") {
    requireStatementPosition(lowerer, call, `server.${name}()`);
    if (args.length !== 0)
      lowerer.noLowering(`server.${name} arguments`, call, `${name}() takes no arguments`);
    const receiver = coerceToHandle(lowerer, access.expression, NETSERVER_T);
    const fn: IrLibFn =
      name === "closeAllConnections"
        ? "http.serverCloseAllConnections"
        : "http.serverCloseIdleConnections";
    return { kind: "libCall", fn, args: [receiver], type: VOID, loc };
  }
  if (name === "listen") {
    if (args.length < 1 || args.length > 3) {
      lowerer.noLowering(
        `listen with ${args.length} arguments`,
        call,
        "the supported form is listen(port[, host][, callback]) — port 0 binds an ephemeral port",
      );
    }
    // Node answers the server (`return this` chaining — `const s =
    // http.createServer(...).listen(0)`, `server.listen(0).address()`):
    // statement position keeps the plain void call; a consumed result
    // rides the interned receiver-returning helper.
    const listenResult = (fn: IrLibFn, callArgs: IrExpr[]): IrExpr => {
      if (ts.isExpressionStatement(call.parent)) {
        return { kind: "libCall", fn, args: callArgs, type: VOID, loc };
      }
      return receiverReturningCall(lowerer, fn, callArgs, NETSERVER_T, loc);
    };
    const receiver = coerceToHandle(lowerer, access.expression, NETSERVER_T);
    // The options-object form — listen({ port, host?, ipv6Only?, reusePort? }[, cb]),
    // the portless listenOnProxyInterface shape: host binds that ONE
    // address (an IP literal — the runtime has no resolver here; absent
    // = Node's host-less dual-stack any), ipv6Only sets IPV6_V6ONLY
    // (truthiness, like Node's option handling — `boolean | undefined`
    // flows). reusePort is different: Node enables it only for exact true,
    // while its presence selects the additive ABI even when the value is
    // false.
    // Every other key fences by name.
    if (ts.isObjectLiteralExpression(args[0]!)) {
      let port: IrExpr | null = null;
      let host: IrExpr | null = null;
      let v6only: IrExpr | null = null;
      let reusePort: IrExpr | null = null;
      for (const prop of (args[0] as ts.ObjectLiteralExpression).properties.nodes) {
        let initializer: ts.Expression | null;
        if (
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
        ) {
          initializer = prop.initializer;
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          initializer = null;
        } else {
          lowerer.noLowering(
            "listen options with computed keys or spreads",
            prop,
            "each option must be a plain `name: value` (or shorthand) entry with a literal key",
          );
        }
        const key = (prop.name as ts.Identifier | ts.StringLiteral).text;
        if (key === "port") {
          port =
            initializer !== null
              ? lowerer.lowerExpr(initializer)
              : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
          if (port.type.kind !== "f64") {
            lowerer.noLowering(
              `a listen 'port' option of '${lowerer.fmt(port.type)}' values`,
              prop,
              "the port is a number here",
            );
          }
        } else if (key === "host") {
          host =
            initializer !== null
              ? lowerer.lowerExpr(initializer)
              : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
          if (host.type.kind !== "string") {
            lowerer.noLowering(
              `a listen 'host' option of '${lowerer.fmt(host.type)}' values`,
              prop,
              "the host is an IP string here",
            );
          }
        } else if (key === "ipv6Only") {
          if (initializer !== null) {
            v6only =
              lowerer.lowerCondition(initializer); /* truthiness: `boolean | undefined` flows */
          } else {
            const v = lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
            if (v.type.kind !== "bool") {
              lowerer.noLowering(
                `a listen 'ipv6Only' option of '${lowerer.fmt(v.type)}' values`,
                prop,
                "spell the option out (ipv6Only: value) so non-boolean values can narrow",
              );
            }
            v6only = v;
          }
        } else if (key === "reusePort") {
          if (initializer !== null) {
            reusePort = lowerExactReusePort(lowerer, lowerer.lowerExpr(initializer), prop);
          } else {
            const v = lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
            if (v.type.kind !== "bool") {
              lowerer.noLowering(
                `a listen 'reusePort' option of '${lowerer.fmt(v.type)}' values`,
                prop,
                "spell the option out (reusePort: value) so optional values can narrow",
              );
            }
            reusePort = v;
          }
        } else if (
          key === "signal" &&
          ts.isPropertyAssignment(prop) &&
          isJsSourceFile(ts.getSourceFileOfNode(call))
        ) {
          // A provably-non-AbortSignal signal (the invalid-input probes:
          // strings, numbers, plain records) throws Node's
          // validateAbortSignal ladder; plausible signal values keep the
          // fence — abort-driven close has no lowering yet.
          const raw = lowerer.lowerExpr(prop.initializer);
          const provablyNot =
            raw.type.kind === "string" ||
            raw.type.kind === "f64" ||
            raw.type.kind === "bool" ||
            raw.type.kind === "record" ||
            raw.type.kind === "array";
          if (provablyNot && lowerer.dynConvertible(raw.type)) {
            return {
              kind: "libCall",
              fn: "error.propTypeThrow",
              args: [
                { kind: "strLit", value: "options.signal", type: STRING, loc },
                { kind: "strLit", value: "an instance of AbortSignal", type: STRING, loc },
                { kind: "dynFrom", value: raw, type: DYN, loc },
              ],
              type: ts.isExpressionStatement(call.parent) ? VOID : NETSERVER_T,
              loc,
            };
          }
          lowerer.noLowering(
            `listen option 'signal'`,
            prop,
            "abort-driven close has no lowering yet — port, host, ipv6Only, and reusePort are the supported listen options",
          );
        } else {
          lowerer.noLowering(
            `listen option '${key}'`,
            prop,
            "port, host, ipv6Only, and reusePort are the supported listen options",
          );
        }
      }
      if (port === null) {
        lowerer.noLowering(
          "listen options without a port",
          args[0]!,
          "the supported options object is { port, host?, ipv6Only?, reusePort? } — port 0 binds an ephemeral port",
        );
      }
      host ??= {
        kind: "strLit",
        value: "",
        type: STRING,
        loc,
      }; /* "" = the dual-stack any default */
      v6only ??= boolLit(false, loc);
      const listenOptsFn: IrLibFn =
        reusePort === null ? "net.listenOpts" : "net.listenOptsReusePort";
      const listenOptsCbFn: IrLibFn =
        reusePort === null ? "net.listenOptsCb" : "net.listenOptsReusePortCb";
      if (args.length === 1) {
        return listenResult(
          listenOptsFn,
          reusePort === null
            ? [receiver, port, host, v6only]
            : [receiver, port, host, v6only, reusePort],
        );
      }
      // The callback may be an OPTIONAL binding — `(() => void) |
      // undefined`, portless's listenOnProxyInterface pass-through: the
      // emitter unwraps the union (the SNICallback conditional-spread
      // pattern) and the runtime takes NULL for the undefined arm. A
      // checked-dynamic callback (a JS wrapper value) adapts through the
      // dynCheck function boundary.
      let cbV = lowerer.lowerExpr(args[1]!);
      if (cbV.type.kind === "dyn") {
        cbV = { kind: "dynCheck", value: cbV, type: funcOf([], VOID), loc };
      }
      const cbFuncOk = (t: IrType): boolean =>
        t.kind === "func" && t.params.length === 0 && t.ret.kind === "void";
      const cbOk =
        cbFuncOk(cbV.type) ||
        (cbV.type.kind === "union" &&
          (() => {
            const def = lowerer.unions.get((cbV.type as IrType & { kind: "union" }).unionId);
            return (
              !!def &&
              def.arms.length === 2 &&
              def.arms.some(cbFuncOk) &&
              def.arms.some((a) => a.kind === "undefinedT")
            );
          })());
      if (!cbOk) {
        lowerer.unsupported(
          "SC1090",
          args[1]!,
          `listen callbacks of type '${lowerer.fmt(cbV.type)}' (use () — an optional \`(() => void) | undefined\` binding also flows)`,
        );
      }
      return listenResult(
        listenOptsCbFn,
        reusePort === null
          ? [receiver, port, host, v6only, cbV]
          : [receiver, port, host, v6only, reusePort, cbV],
      );
    }
    // listen(path[, cb]): a string first argument names a Unix socket
    // (the runtime takes a numeric string as a port, Node's isPipeName).
    if (lowerer.mapTypeOf(lowerer.typeOf(args[0]!))?.kind === "string") {
      if (args.length > 2) {
        lowerer.noLowering(
          `listen(path) with ${args.length} arguments`,
          call,
          "the supported form is listen(path[, callback])",
        );
      }
      const path = lowerer.lowerExprExpecting(args[0]!, STRING);
      if (args.length === 1) return listenResult("net.listenPath", [receiver, path]);
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "listen callbacks",
        0,
        () => false,
        "use ()",
        [],
      );
      return listenResult("net.listenPathCb", [receiver, path, cb]);
    }
    const port = lowerer.lowerExprExpecting(args[0]!, F64);
    // The optional middle host — listen(port, '127.0.0.1'[, cb]): a
    // string-typed second argument is the bind address (the net.connect
    // disambiguation), routed through the options-form entry.
    let hostNode: ts.Expression | undefined;
    let cbNode: ts.Expression | undefined;
    if (args.length === 2) {
      if (lowerer.mapTypeOf(lowerer.typeOf(args[1]!))?.kind === "string") hostNode = args[1];
      else cbNode = args[1];
    } else if (args.length === 3) {
      hostNode = args[1];
      cbNode = args[2];
    }
    if (hostNode !== undefined) {
      const host = lowerer.lowerExprExpecting(hostNode, STRING);
      const v6only = boolLit(false, loc);
      if (!cbNode) return listenResult("net.listenOpts", [receiver, port, host, v6only]);
      const { cb } = lowerCallbackArg(
        lowerer,
        cbNode,
        "listen callbacks",
        0,
        () => false,
        "use ()",
        [],
      );
      return listenResult("net.listenOptsCb", [receiver, port, host, v6only, cb]);
    }
    if (!cbNode) {
      return listenResult("net.listen", [receiver, port]);
    }
    const { cb } = lowerCallbackArg(
      lowerer,
      cbNode,
      "listen callbacks",
      0,
      () => false,
      "use ()",
      [],
    );
    return listenResult("net.listenCb", [receiver, port, cb]);
  }
  if (name === "close") {
    requireStatementPosition(lowerer, call, "server.close(...)");
    if (args.length > 1) {
      lowerer.noLowering(
        `close with ${args.length} arguments`,
        call,
        "the supported form is close([callback])",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSERVER_T);
    if (args.length === 0) {
      return { kind: "libCall", fn: "net.serverClose", args: [receiver], type: VOID, loc };
    }
    if (
      lowerer.checker
        .getCallSignatures(lowerer.typeOf(args[0]!))
        .some((sig) => sig.getParameters().length > 0)
    ) {
      // close((err) => ...): undefined once the server closes, or Node's
      // ERR_SERVER_NOT_RUNNING when it was not listening.
      return {
        kind: "libCall",
        fn: "net.serverCloseDyn",
        args: [receiver, lowerSocketDynListener(lowerer, args[0]!, "close callbacks")],
        type: VOID,
        loc,
      };
    }
    const { cb } = lowerCallbackArg(
      lowerer,
      args[0]!,
      "close callbacks",
      0,
      () => false,
      "use ()",
      [],
    );
    return { kind: "libCall", fn: "net.serverCloseCb", args: [receiver, cb], type: VOID, loc };
  }
  if (name === "addContext" || name === "setSecureContext") {
    // tls.Server's SNI table and default context (scr_tls.c): addContext
    // takes a SecureContext or createSecureContext's options; the runtime
    // throws Node's errors and the fence on a non-TLS server.
    requireStatementPosition(lowerer, call, `server.${name}(...)`);
    const want = name === "addContext" ? 2 : 1;
    if (args.length !== want || args.some(ts.isSpreadElement)) {
      lowerer.noLowering(
        `${name} with ${args.length} arguments`,
        call,
        name === "addContext"
          ? "the form is addContext(servername, context)"
          : "the form is setSecureContext(options)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSERVER_T);
    if (name === "setSecureContext") {
      const options = lowerer.lowerExprExpecting(args[0]!, DYN);
      return {
        kind: "libCall",
        fn: "tls.serverSetSecureContext",
        args: [receiver, options],
        type: VOID,
        loc,
      };
    }
    const servername = lowerer.lowerExprExpecting(args[0]!, DYN);
    const context = lowerer.lowerExpr(args[1]!);
    if (context.type.kind === "secureCtx") {
      return {
        kind: "libCall",
        fn: "tls.serverAddContextCtx",
        args: [receiver, servername, context],
        type: VOID,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: "tls.serverAddContext",
      args: [receiver, servername, lowerer.coerceInto(args[1]!, context, DYN)],
      type: VOID,
      loc,
    };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    requireStatementPosition(lowerer, call, `server.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = lowerer.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const receiver = coerceToHandle(lowerer, access.expression, NETSERVER_T);
    if (event === "tlsClientError") {
      // A failed handshake on a tls or https server: (err, tlsSocket).
      const listener = args[1]!;
      const { cb } = lowerCallbackArgShared(
        lowerer,
        listener,
        "tlsClientError listeners",
        2,
        (p, i) =>
          i === 0 ? p.kind === "object" && p.className === "%Error" : p.kind === "netSocket",
        "use (err, tlsSocket), (err) or ()",
        {
          dynTuple: [ERROR_T, NETSOCKET_T],
          checkAllParams: true,
          adapt: (c) => voidizedCallback(lowerer, c, locOf(listener)),
        },
      );
      return {
        kind: "libCall",
        fn: "tls.serverOnClientError",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "connection" || event === "secureConnection") {
      // 'secureConnection' rides the same list: a TLS server's
      // 'connection' listeners are DEFERRED to handshake completion
      // (scr_net_server_defer_connections), which IS Node's
      // secureConnection timing; on a plain net server the name would
      // never fire in Node either — the runtime entry gates on the
      // deferral flag so the split stays exact.
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        `${event} listeners`,
        1,
        (p) => p.kind === "netSocket",
        "use (socket) or ()",
        [NETSOCKET_T],
      );
      const fn: IrLibFn =
        event === "connection" ? "net.serverOnConnection" : "net.serverOnSecureConnection";
      return { kind: "libCall", fn, args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "error") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "error listeners",
        1,
        (p) => p.kind === "object" && p.className === "%Error",
        "use (err) or ()",
        [ERROR_T],
      );
      return {
        kind: "libCall",
        fn: "net.serverOnError",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "close") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "close listeners",
        0,
        () => false,
        "use ()",
        [],
      );
      return {
        kind: "libCall",
        fn: "net.serverOnClose",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "timeout") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "timeout listeners",
        1,
        (p) => p.kind === "netSocket",
        "use (socket) or ()",
        [NETSOCKET_T],
      );
      return {
        kind: "libCall",
        fn: "http.serverOnTimeout",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "listening") {
      // The deferred bind emit — listen(port, cb)'s event twin: fires
      // once after a successful listen; late registrations on an
      // already-listening server never fire (Node's once-per-listen).
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "listening listeners",
        0,
        () => false,
        "use ()",
        [],
      );
      return {
        kind: "libCall",
        fn: "net.serverOnListening",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "checkContinue" || event === "checkExpectation") {
      // Expect handling: these listeners take the request instead of
      // 'request' (checkContinue answers with res.writeContinue()).
      const cb = lowerRequestHandlerArg(lowerer, args[1]!);
      return {
        kind: "libCall",
        fn: "http.serverOnCheck",
        args: [receiver, cb, once, boolLit(event === "checkExpectation", loc)],
        type: VOID,
        loc,
      };
    }
    if (event === "request") {
      // The 'request' event — http.createServer(handler)'s event twin, and
      // the way an http2 allowHTTP1 server (created handler-less) gets its
      // handler. Same (req, res) shapes as the createServer callback; on a
      // server with no HTTP parser (net.createServer) the registration is
      // Node-honest dead weight: the event never fires there either.
      const cb = lowerRequestHandlerArg(lowerer, args[1]!);
      return {
        kind: "libCall",
        fn: "http.serverOnRequest",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "stream") {
      // The h2c server's request event: (stream, headers, flags). The
      // adapter builds the headers record from the pairs the runtime
      // hands over. Dead weight on a non-h2 server (never fires).
      const cb = h2HeadersCallbackAdapter(
        lowerer,
        args[1]!,
        "stream listeners",
        "http2Stream",
        false,
        loc,
      );
      return {
        kind: "libCall",
        fn: "http2.serverOnStream",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "drop") {
      // A connection past maxConnections, with its local and remote
      // addresses.
      return {
        kind: "libCall",
        fn: "net.serverOnDrop",
        args: [receiver, lowerSocketDynListener(lowerer, args[1]!, "drop listeners"), once],
        type: VOID,
        loc,
      };
    }
    if (event === "session") {
      // The h2c server's per-connection session event: (session). The
      // result is voidized; the handle passes by reference.
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "session listeners",
        1,
        (p) => p.kind === "http2Session",
        "use (session) or ()",
        [HTTP2SESSION_T],
      );
      return {
        kind: "libCall",
        fn: "http2.serverOnSession",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "connect") {
      // HTTP CONNECT — the tunneling handover: (req, socket, head), fired
      // INSTEAD of 'request' for CONNECT-method requests (the 'upgrade'
      // machinery's twin; no listener destroys the socket, Node's
      // default). An allowHTTP1 server supplies a raw socket for HTTP/1.1
      // CONNECT and an Http2ServerResponse for valid traditional/extended
      // HTTP/2 CONNECT, so portless's union-typed listener selects the
      // protocol arm with `instanceof net.Socket`.
      const cb = lowerer.lowerExpr(args[1]!);
      if (cb.type.kind !== "func" || cb.type.params.length > 3) {
        lowerer.unsupported(
          "SC1090",
          args[1]!,
          "connect listeners with more than three parameters (use (req, socket, head))",
        );
      }
      if (cb.type.ret.kind !== "void") {
        lowerer.unsupported(
          "SC1090",
          args[1]!,
          "connect listeners returning a value (make the callback body a block)",
        );
      }
      const [p0, p1, p2] = cb.type.params;
      const sockParamOk = (t: IrType): boolean => {
        if (t.kind === "netSocket") return true;
        if (t.kind !== "union") return false;
        const def = lowerer.unions.get(t.unionId);
        return !!def && def.arms.some((a) => a.kind === "netSocket");
      };
      if (
        (p0 !== undefined && p0.kind !== "httpReq") ||
        (p1 !== undefined && !sockParamOk(p1)) ||
        (p2 !== undefined && !(p2.kind === "bytes" && p2.elem === "u8"))
      ) {
        lowerer.unsupported(
          "SC1090",
          args[1]!,
          "connect listeners whose parameters are not (req: IncomingMessage, socket: Socket — or a union carrying the Socket arm, the h2 compat shape, head: Buffer)",
        );
      }
      return {
        kind: "libCall",
        fn: "http.serverOnConnect",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "upgrade") {
      // The WebSocket handover: (req, socket, head) — Node fires it
      // INSTEAD of 'request' for Connection: upgrade requests, hands the
      // socket over raw with the bytes read past the head, and destroys
      // the socket when no listener exists. Registration works on every
      // server kind (a parserless net server never fires it, like Node).
      const cb = lowerer.lowerExpr(args[1]!);
      if (cb.type.kind !== "func" || cb.type.params.length > 3) {
        lowerer.unsupported(
          "SC1090",
          args[1]!,
          "upgrade listeners with more than three parameters (use (req, socket, head))",
        );
      }
      if (cb.type.ret.kind !== "void") {
        lowerer.unsupported(
          "SC1090",
          args[1]!,
          "upgrade listeners returning a value (make the callback body a block)",
        );
      }
      const [p0, p1, p2] = cb.type.params;
      if (
        (p0 !== undefined && p0.kind !== "httpReq") ||
        (p1 !== undefined && p1.kind !== "netSocket") ||
        (p2 !== undefined && !(p2.kind === "bytes" && p2.elem === "u8"))
      ) {
        lowerer.unsupported(
          "SC1090",
          args[1]!,
          "upgrade listeners whose parameters are not (req: IncomingMessage, socket: Socket, head: Buffer)",
        );
      }
      return {
        kind: "libCall",
        fn: "http.serverOnUpgrade",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "sessionError") {
      const cb = lowerer.lowerExpr(args[1]!);
      if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 2) {
        lowerer.unsupported(
          "SC1090",
          args[1]!,
          "sessionError listeners with more than two parameters or returning a value",
        );
      }
      const [err, session] = cb.type.params;
      if (
        (err !== undefined && !(err.kind === "object" && err.className === "%Error")) ||
        (session !== undefined && session.kind !== "http2Session")
      ) {
        lowerer.unsupported(
          "SC1090",
          args[1]!,
          "sessionError listeners whose parameters are not (error: Error, session: ServerHttp2Session)",
        );
      }
      return {
        kind: "libCall",
        fn: "http2.serverOnSessionError",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    lowerer.noLowering(
      `server.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
      args[0]!,
      '"connection", "request", "checkContinue", "checkExpectation", "drop", "stream", "session", "upgrade", "connect", "error", "close", "listening", and "sessionError" are the supported server events (as literals)',
    );
  }
  if (name === "emit") {
    // The demux route: emit("connection", socket) hands an accepted
    // socket to ANOTHER server (portless's first-byte TLS peek). Only
    // the literal "connection" form lowers; Node's boolean result is
    // dropped (statement position required).
    requireStatementPosition(lowerer, call, "server.emit(...)");
    const evT = args.length >= 1 ? lowerer.typeOf(args[0]!) : null;
    const event = evT?.isStringLiteralType() ? evT.value : null;
    if (event !== "connection" || args.length !== 2) {
      lowerer.noLowering(
        `server.emit(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
        call,
        'emit("connection", socket) is the supported emit form (the demux route)',
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSERVER_T);
    const sock = lowerer.lowerExpr(args[1]!);
    if (sock.type.kind !== "netSocket") {
      lowerer.noLowering(
        `emit("connection", …) with a '${lowerer.fmt(sock.type)}' argument`,
        args[1]!,
        "the second argument must be a net socket",
      );
    }
    return {
      kind: "libCall",
      fn: "net.serverEmitConnection",
      args: [receiver, sock],
      type: VOID,
      loc,
    };
  }
  if ((name === "ref" || name === "unref") && args.length === 0) {
    // Whether the server keeps the event loop alive.
    requireStatementPosition(lowerer, call, `server.${name}()`);
    const receiver = coerceToHandle(lowerer, access.expression, NETSERVER_T);
    return {
      kind: "libCall",
      fn: "net.serverSetRef",
      args: [receiver, boolLit(name === "ref", loc)],
      type: VOID,
      loc,
    };
  }
  if (name === "address") {
    // The full AddressInfo record (the dgram.address materialization).
    // The composed `server.address().port` read already lowered through
    // the property path; this is the record-valued remainder (`const a =
    // server.address()` — the listen-callback shape).
    if (args.length !== 0) {
      lowerer.noLowering(
        `address with ${args.length} arguments`,
        call,
        "address() takes no arguments",
      );
    }
    const result = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (result && isAddressInfoRecord(lowerer, result)) {
      const receiver = coerceToHandle(lowerer, access.expression, NETSERVER_T);
      if (unixListenReachable(lowerer)) {
        // A Unix-socket server's address() is its path, which this record
        // cannot hold: the check throws for one before the record reads.
        const local = lowerer.declareHiddenLocal("%addressServer", NETSERVER_T);
        const server = (): IrExpr => varRef(local.id, NETSERVER_T, loc);
        return {
          kind: "seqExpr",
          stmts: [
            { kind: "varDecl", localId: local.id, init: receiver, loc },
            {
              kind: "exprStmt",
              expr: {
                kind: "libCall",
                fn: "net.serverAddressCheck",
                args: [server()],
                type: VOID,
                loc,
              },
              loc,
            },
          ],
          result: { kind: "libCall", fn: "net.serverAddress", args: [server()], type: result, loc },
          type: result,
          loc,
        };
      }
      return { kind: "libCall", fn: "net.serverAddress", args: [receiver], type: result, loc };
    }
    // @types/node's `string | AddressInfo | null`: the record while the
    // server listens (a TCP server never answers the pipe-path string),
    // null otherwise, like Node.
    const arms = result?.kind === "union" ? (lowerer.unions.get(result.unionId)?.arms ?? []) : [];
    const record = arms.find((arm) => isAddressInfoRecord(lowerer, arm));
    const nullTag = result?.kind === "union" ? lowerer.armTag(result.unionId, NULL_T) : -1;
    if (!result || result.kind !== "union" || record === undefined || nullTag < 0) {
      lowerer.noLowering(
        "address() where the result is not the {address, family, port} record",
        call,
        "the AddressInfo shape is the supported result",
      );
    }
    const unionId = result.unionId;
    const receiver = coerceToHandle(lowerer, access.expression, NETSERVER_T);
    const local = lowerer.declareHiddenLocal("%addressServer", NETSERVER_T);
    const server = varRef(local.id, NETSERVER_T, loc);
    const recordArm: IrExpr = {
      kind: "unionWrap",
      unionId,
      tag: lowerer.armTag(unionId, record),
      value: { kind: "libCall", fn: "net.serverAddress", args: [server], type: record, loc },
      type: result,
      loc,
    };
    const stringTag = lowerer.armTag(unionId, STRING);
    let listeningArm: IrExpr = recordArm;
    const stmts: IrStmt[] = [{ kind: "varDecl", localId: local.id, init: receiver, loc }];
    if (stringTag >= 0 && unixListenReachable(lowerer)) {
      // Node answers a Unix-socket server's address() with its path.
      const pathLocal = lowerer.declareHiddenLocal("%addressPath", STRING);
      const path = (): IrExpr => varRef(pathLocal.id, STRING, loc);
      stmts.push({
        kind: "varDecl",
        localId: pathLocal.id,
        init: { kind: "libCall", fn: "net.serverUnixPath", args: [server], type: STRING, loc },
        loc,
      });
      listeningArm = {
        kind: "ternary",
        cond: {
          kind: "strEq",
          negated: true,
          left: path(),
          right: strLit("", loc),
          type: BOOL,
          loc,
        },
        then: { kind: "unionWrap", unionId, tag: stringTag, value: path(), type: result, loc },
        else_: recordArm,
        type: result,
        loc,
      };
    }
    return {
      kind: "seqExpr",
      stmts,
      result: {
        kind: "ternary",
        cond: { kind: "libCall", fn: "net.serverListening", args: [server], type: BOOL, loc },
        then: listeningArm,
        else_: {
          kind: "unionWrap",
          unionId,
          tag: nullTag,
          value: { kind: "unitLit", unit: "null", type: NULL_T, loc },
          type: result,
          loc,
        },
        type: result,
        loc,
      },
      type: result,
      loc,
    };
  }
  lowerer.noLowering(
    `Server.${name}`,
    call,
    'listen, close, address().port, emit("connection", socket), and on/once of connection/request/upgrade/error/close/listening/sessionError are the supported Server members',
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** Whether a setEncoding call can reach some net.Socket in this program:
 * `x.setEncoding(...)` or `x["setEncoding"](...)` where `x` is a socket
 * or an untyped value. Sockets that never get an encoding keep the Buffer
 * chunk path; with one, Node's 'data' chunks are strings. */
function socketEncodingReachable(lowerer: Lowerer): boolean {
  if (lowerer.socketEncodingReachable !== null) return lowerer.socketEncodingReachable;
  let reachable = false;
  for (const file of lowerer.program.getSourceFiles()) {
    if (file.isDeclarationFile || !file.text.includes("setEncoding")) continue;
    ts.walkPreorder(file, (node) => {
      if (reachable) return "skip";
      if (!ts.isCallExpression(node)) return undefined;
      const callee = node.expression;
      const receiver =
        ts.isPropertyAccessExpression(callee) && callee.name.text === "setEncoding"
          ? callee.expression
          : ts.isElementAccessExpression(callee) &&
              ts.isStringLiteralLike(callee.argumentExpression) &&
              callee.argumentExpression.text === "setEncoding"
            ? callee.expression
            : null;
      if (receiver === null) return undefined;
      const kind = lowerer.mapTypeOf(lowerer.checker.getTypeAtLocation(receiver))?.kind;
      if (kind === undefined || kind === "netSocket" || kind === "dyn") reachable = true;
      return undefined;
    });
    if (reachable) break;
  }
  lowerer.socketEncodingReachable = reachable;
  return reachable;
}

/** Whether some server in the program may listen on a Unix socket: a
 * `.listen(x, ...)` call on a server (or an untyped value) whose first
 * argument is string-typed. Only then does address() check for the socket
 * path, so other programs keep the record-only lowering. */
function unixListenReachable(lowerer: Lowerer): boolean {
  if (lowerer.unixListenReachable !== null) return lowerer.unixListenReachable;
  let reachable = false;
  for (const file of lowerer.program.getSourceFiles()) {
    if (file.isDeclarationFile || !file.text.includes("listen")) continue;
    ts.walkPreorder(file, (node) => {
      if (reachable) return "skip";
      if (!ts.isCallExpression(node) || node.arguments.nodes.length === 0) return undefined;
      const callee = node.expression;
      if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "listen") return undefined;
      const kind = lowerer.mapTypeOf(lowerer.checker.getTypeAtLocation(callee.expression))?.kind;
      if (kind !== undefined && kind !== "netServer" && kind !== "dyn") return undefined;
      const arg = lowerer.mapTypeOf(lowerer.checker.getTypeAtLocation(node.arguments.nodes[0]!));
      // Only a string-typed argument lowers to listen(path) (an untyped
      // one checks into a port).
      if (arg?.kind === "string") reachable = true;
      return undefined;
    });
    if (reachable) break;
  }
  lowerer.unixListenReachable = reachable;
  return reachable;
}

/** An inline 'data' listener whose chunk parameter is typed Buffer, for a
 * socket that may have an encoding set: the chunk binds as a checked
 * dynamic value, so the body sees what Node passes (a string after
 * setEncoding, a Buffer otherwise) whatever the annotation says. Null
 * for other listener shapes. */
function lowerEncodedDataListener(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  let fn = node;
  while (ts.isParenthesizedExpression(fn)) fn = fn.expression;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
  if (fn.parameters.nodes.length !== 1) return null;
  const param = fn.parameters.nodes[0]!;
  if (!ts.isIdentifier(param.name) || param.initializer || param.dotDotDotToken) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(param.name);
  if (symbol === undefined) return null;
  const previousBinding = lowerer.runtimeOptionalBindingTypes.get(symbol);
  const previousImplicit = lowerer.implicitParamTypes;
  const implicit = new Map(previousImplicit ?? []);
  implicit.set(symbol, lowerer.checker.getUnknownType());
  lowerer.runtimeOptionalBindingTypes.set(symbol, DYN);
  lowerer.implicitParamTypes = implicit;
  try {
    return lowerer.lowerExpr(fn);
  } finally {
    if (previousBinding === undefined) lowerer.runtimeOptionalBindingTypes.delete(symbol);
    else lowerer.runtimeOptionalBindingTypes.set(symbol, previousBinding);
    lowerer.implicitParamTypes = previousImplicit;
  }
}

/** Method calls on net.Socket receivers: write/end/destroy/pipe and
 * on/once("data" | "end" | "close" | "error" | "connect"). Null for
 * other receivers. */
function lowerNetSocketMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "netSocket") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if ((name === "ref" || name === "unref") && args.length === 0) {
    // Whether the socket keeps the event loop alive.
    requireStatementPosition(lowerer, call, `socket.${name}()`);
    const receiver = lowerer.lowerExpr(access.expression);
    return {
      kind: "libCall",
      fn: "net.sockSetRef",
      args: [receiver, boolLit(name === "ref", loc)],
      type: VOID,
      loc,
    };
  }
  if (name === "write" || name === "end") {
    requireStatementPosition(lowerer, call, `socket.${name}(...)`);
    // write(chunk, encoding) — the two-argument encoding form: 'buffer'
    // beside a string chunk is Writable's encoding check (a synchronous
    // ERR_UNKNOWN_ENCODING TypeError, "Unknown encoding: buffer" — the
    // invalid-input probes' shape); utf8 spellings are the plain write
    // (that IS the encoding written); a Buffer chunk ignores the encoding
    // like Node does. Other encodings keep the fence.
    if (name === "write" && args.length === 2) {
      const encT = lowerer.typeOf(args[1]!);
      const chunkT = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
      if (encT.isStringLiteralType() && chunkT !== null) {
        if (
          encT.value === "buffer" &&
          chunkT.kind === "string" &&
          isJsSourceFile(ts.getSourceFileOfNode(call))
        ) {
          lowerer.lowerExpr(args[0]!); // evaluation order (effect-free in practice)
          return nodeThrowExpr(1, "ERR_UNKNOWN_ENCODING", "Unknown encoding: buffer", VOID, loc);
        }
        const passthrough =
          (chunkT.kind === "string" && (encT.value === "utf8" || encT.value === "utf-8")) ||
          (chunkT.kind === "bytes" && chunkT.elem === "u8");
        if (passthrough) {
          const socket = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
          const chunk = lowerer.lowerExpr(args[0]!);
          const fn: IrLibFn = chunk.type.kind === "string" ? "net.sockWrite" : "net.sockWriteBytes";
          return { kind: "libCall", fn, args: [socket, chunk], type: VOID, loc };
        }
      }
    }
    // A trailing callback: write's runs once the data is flushed (with
    // null for the error), end's once the socket finishes ('finish').
    const last = args.length > 0 ? args[args.length - 1]! : null;
    if (
      last !== null &&
      args.length <= 2 &&
      (name === "end" || args.length === 2) &&
      lowerer.checker.getCallSignatures(lowerer.typeOf(last)).length > 0
    ) {
      const sockLocal = lowerer.declareHiddenLocal("%sockCb", NETSOCKET_T);
      const stmts: IrStmt[] = [
        {
          kind: "varDecl",
          localId: sockLocal.id,
          init: coerceToHandle(lowerer, access.expression, NETSOCKET_T),
          loc,
        },
      ];
      const receiver = (): IrExpr => ({
        kind: "varRef",
        localId: sockLocal.id,
        type: NETSOCKET_T,
        loc,
      });
      const dataNode = args.length === 2 ? args[0]! : null;
      let main: IrExpr = {
        kind: "libCall",
        fn: "net.sockEnd",
        args: [receiver()],
        type: VOID,
        loc,
      };
      if (dataNode !== null) {
        const data = lowerer.lowerExpr(dataNode);
        const fn: IrLibFn | null =
          data.type.kind === "string"
            ? name === "write"
              ? "net.sockWrite"
              : "net.sockEndStr"
            : data.type.kind === "bytes" && data.type.elem === "u8"
              ? name === "write"
                ? "net.sockWriteBytes"
                : "net.sockEndBytes"
              : data.type.kind === "dyn"
                ? name === "write"
                  ? "net.sockWriteDyn"
                  : "net.sockEndDyn"
                : null;
        if (fn === null) {
          lowerer.noLowering(
            `${name} of '${lowerer.fmt(data.type)}' data`,
            dataNode,
            NARROW_DATA_HINT,
          );
        }
        main = { kind: "libCall", fn, args: [receiver(), data], type: VOID, loc };
      }
      const cb = lowerer.lowerExpr(last);
      let register: IrExpr;
      if (cb.type.kind === "func" && cb.type.params.length === 0 && cb.type.ret.kind === "void") {
        register = {
          kind: "libCall",
          fn: name === "write" ? "net.sockOnWriteFlush" : "net.sockOnFinish",
          args: [receiver(), cb],
          type: VOID,
          loc,
        };
      } else {
        register = {
          kind: "libCall",
          fn: name === "write" ? "net.sockOnWriteFlushDyn" : "net.sockOnFinishDyn",
          args: [receiver(), lowerSocketDynListener(lowerer, last, `${name} callbacks`)],
          type: VOID,
          loc,
        };
      }
      stmts.push({ kind: "exprStmt", expr: main, loc });
      return { kind: "seqExpr", stmts, result: register, type: VOID, loc };
    }
    const maxArgs = name === "write" ? 1 : 1;
    const minArgs = name === "write" ? 1 : 0;
    if (args.length < minArgs || args.length > maxArgs) {
      lowerer.noLowering(
        `${name} with ${args.length} arguments`,
        call,
        name === "write"
          ? "the supported form is write(data) — one string or Buffer"
          : "the supported forms are end() and end(data)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    if (args.length === 0) {
      return { kind: "libCall", fn: "net.sockEnd", args: [receiver], type: VOID, loc };
    }
    const data = lowerer.lowerExpr(args[0]!);
    if (data.type.kind === "string") {
      const fn: IrLibFn = name === "write" ? "net.sockWrite" : "net.sockEndStr";
      return { kind: "libCall", fn, args: [receiver, data], type: VOID, loc };
    }
    if (data.type.kind === "bytes" && data.type.elem === "u8") {
      const fn: IrLibFn = name === "write" ? "net.sockWriteBytes" : "net.sockEndBytes";
      return { kind: "libCall", fn, args: [receiver, data], type: VOID, loc };
    }
    if (data.type.kind === "dyn") {
      // An untyped JS payload (a helper's parameter): the runtime
      // dispatches STR/BYTES and throws Node's chunk TypeError otherwise.
      const fn: IrLibFn = name === "write" ? "net.sockWriteDyn" : "net.sockEndDyn";
      return { kind: "libCall", fn, args: [receiver, data], type: VOID, loc };
    }
    lowerer.noLowering(
      `${name} of '${lowerer.fmt(data.type)}' data`,
      args[0] ?? call,
      NARROW_DATA_HINT,
    );
  }
  if (name === "destroy") {
    requireStatementPosition(lowerer, call, "socket.destroy()");
    if (args.length !== 0) {
      lowerer.noLowering(
        `destroy with ${args.length} arguments`,
        call,
        "destroy() takes no arguments here",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockDestroy", args: [receiver], type: VOID, loc };
  }
  if (name === "setEncoding") {
    // The req twin: utf8 flips 'data' delivery to strings.
    requireStatementPosition(lowerer, call, "socket.setEncoding(...)");
    if (args.length !== 1) {
      lowerer.noLowering(
        `setEncoding with ${args.length} arguments`,
        call,
        "the supported form is setEncoding(encoding)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    const enc = lowerer.lowerExprExpecting(args[0]!, STRING);
    return { kind: "libCall", fn: "net.sockSetEncoding", args: [receiver, enc], type: VOID, loc };
  }
  if (name === "setTimeout") {
    requireStatementPosition(lowerer, call, "socket.setTimeout(...)");
    if (args.length !== 1 && args.length !== 2) {
      lowerer.noLowering(
        `setTimeout with ${args.length} arguments`,
        call,
        "the supported forms are setTimeout(ms) and setTimeout(ms, callback)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    const ms = lowerer.lowerExprExpecting(args[0]!, F64);
    if (args.length === 2) {
      // Node adds the callback as a once('timeout') listener (removes it
      // for 0); msecs is checked first either way.
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "setTimeout callbacks",
        0,
        () => false,
        "use ()",
        [],
      );
      return {
        kind: "libCall",
        fn: "net.sockSetTimeoutCb",
        args: [receiver, ms, cb],
        type: VOID,
        loc,
      };
    }
    return { kind: "libCall", fn: "net.sockSetTimeout", args: [receiver, ms], type: VOID, loc };
  }
  if (name === "setKeepAlive") {
    // SO_KEEPALIVE plus the initial delay (whole seconds, at least 1);
    // Node's defaults are false and 0. Answers the socket.
    if (args.length > 2) {
      lowerer.noLowering(
        `setKeepAlive with ${args.length} arguments`,
        call,
        "the form is setKeepAlive(enable?, initialDelay?)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    const enable: IrExpr =
      args.length >= 1 ? lowerer.lowerExprExpecting(args[0]!, BOOL) : boolLit(false, loc);
    const delay: IrExpr =
      args.length === 2
        ? lowerer.lowerExprExpecting(args[1]!, F64)
        : { kind: "numLit", value: 0, type: F64, loc };
    return {
      kind: "libCall",
      fn: "net.sockSetKeepAlive",
      args: [receiver, enable, delay],
      type: NETSOCKET_T,
      loc,
    };
  }
  if (name === "pause" || name === "resume") {
    // Flow control (the struct's flag comments in scr_net.c): pause holds
    // reads off — kernel/TCP backpressure is the buffer; resume flows
    // (and discards sans listeners, so 'end' is reachable). Both answer
    // the socket, Node's chaining.
    if (args.length !== 0) {
      lowerer.noLowering(`${name} with ${args.length} arguments`, call, `the form is ${name}()`);
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    const fn: IrLibFn = name === "pause" ? "net.sockPause" : "net.sockResume";
    return { kind: "libCall", fn, args: [receiver], type: NETSOCKET_T, loc };
  }
  if (name === "setNoDelay") {
    // TCP_NODELAY on the live fd; missing/undefined means true (Node).
    // Answers the socket, Node's chaining.
    if (args.length > 1) {
      lowerer.noLowering(
        `setNoDelay with ${args.length} arguments`,
        call,
        "the form is setNoDelay(noDelay?)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    const enable: IrExpr =
      args.length === 1 ? lowerer.lowerExprExpecting(args[0]!, BOOL) : boolLit(true, loc);
    return {
      kind: "libCall",
      fn: "net.sockSetNoDelay",
      args: [receiver, enable],
      type: NETSOCKET_T,
      loc,
    };
  }
  if ((name === "getProtocol" || name === "getCipher") && args.length === 0) {
    // TLSSocket.getProtocol(): "TLSv1.2"/"TLSv1.3" or null;
    // getCipher(): { name, standardName, version }.
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    const value: IrExpr = {
      kind: "libCall",
      fn: name === "getProtocol" ? "tls.sockGetProtocol" : "tls.sockGetCipher",
      args: [receiver],
      type: DYN,
      loc,
    };
    const declared = lowerer.mapTypeOf(lowerer.typeOf(call));
    return declared === null || declared.kind === "dyn"
      ? value
      : lowerer.coerceInto(call, value, declared);
  }
  {
    const certificate = lowerTlsCertificateCall(lowerer, call, name, () =>
      coerceToHandle(lowerer, access.expression, NETSOCKET_T),
    );
    if (certificate) return certificate;
  }
  if (name === "isSessionReused" && args.length === 0) {
    // TLSSocket.isSessionReused(): the client never offers a cached
    // session (no session resumption, a documented TLS divergence), so
    // no handshake resumes one. A plain socket asserted to be a
    // TLSSocket answers false too, where Node has no such method.
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: receiver, loc }],
      result: boolLit(false, loc),
      type: BOOL,
      loc,
    };
  }
  if (name === "resetAndDestroy") {
    // An RST close; a connecting socket resets once it connects. Answers
    // the socket, Node's chaining.
    if (args.length !== 0) {
      lowerer.noLowering(
        `resetAndDestroy with ${args.length} arguments`,
        call,
        "the form is resetAndDestroy()",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    return {
      kind: "libCall",
      fn: "net.sockResetAndDestroy",
      args: [receiver],
      type: NETSOCKET_T,
      loc,
    };
  }
  if (name === "address") {
    // { address, family, port } or {} (connecting or destroyed): the
    // declared AddressInfo | {} maps to a dyn value.
    if (args.length !== 0) {
      lowerer.noLowering(
        `address with ${args.length} arguments`,
        call,
        "address() takes no arguments",
      );
    }
    const result = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (result?.kind !== "dyn") {
      lowerer.noLowering(
        "socket.address() where the result is not AddressInfo | {}",
        call,
        "use the declared AddressInfo | {} result, and narrow it with a type assertion",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockAddress", args: [receiver], type: DYN, loc };
  }
  if (name === "destroySoon") {
    // end() now, destroy once the FIN actually flushed — Node's
    // 'finish'-then-destroy.
    requireStatementPosition(lowerer, call, "socket.destroySoon()");
    if (args.length !== 0) {
      lowerer.noLowering(
        `destroySoon with ${args.length} arguments`,
        call,
        "the form is destroySoon()",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockDestroySoon", args: [receiver], type: VOID, loc };
  }
  if (name === "read") {
    // socket.read(n?) — the demux peek. Answers the interned
    // `Buffer | null` union: exactly n buffered bytes, or null (Node's
    // less-than-n answer); read() drains the whole buffer.
    if (args.length > 1) {
      lowerer.noLowering(
        `read with ${args.length} arguments`,
        call,
        "the supported forms are read() and read(n)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    const n: IrExpr =
      args.length === 1
        ? lowerer.lowerExprExpecting(args[0]!, F64)
        : { kind: "numLit", value: 0, type: F64, loc };
    const type: IrType = { kind: "union", unionId: lowerer.unions.intern([BYTES_U8, NULL_T]) };
    return { kind: "libCall", fn: "net.sockRead", args: [receiver, n], type, loc };
  }
  if (name === "unshift") {
    requireStatementPosition(lowerer, call, "socket.unshift(...)");
    if (args.length !== 1) {
      lowerer.noLowering(
        `unshift with ${args.length} arguments`,
        call,
        "the supported form is unshift(buffer)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    const data = lowerer.lowerExpr(args[0]!);
    if (data.type.kind !== "bytes" || data.type.elem !== "u8") {
      lowerer.noLowering(
        `unshift of '${lowerer.fmt(data.type)}' data`,
        args[0]!,
        "unshift takes one Buffer/Uint8Array (narrow unions first — the read(1) result needs its null arm checked)",
      );
    }
    return { kind: "libCall", fn: "net.sockUnshift", args: [receiver, data], type: VOID, loc };
  }
  if (name === "pipe") {
    requireStatementPosition(lowerer, call, "socket.pipe(...)");
    if (args.length !== 1) {
      lowerer.noLowering(
        `pipe with ${args.length} arguments`,
        call,
        "the supported form is pipe(destination)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    const dst = lowerer.lowerExpr(args[0]!);
    if (dst.type.kind === "httpRes") {
      // socket → ServerResponse (the extended-CONNECT bridge leg): raw
      // chunks become response body writes; EOF ends the response.
      return { kind: "libCall", fn: "net.sockPipeRes", args: [receiver, dst], type: VOID, loc };
    }
    if (dst.type.kind !== "netSocket") {
      lowerer.noLowering(
        `pipe into '${lowerer.fmt(dst.type)}' destinations`,
        args[0]!,
        "a socket pipes into another socket or a ServerResponse",
      );
    }
    return { kind: "libCall", fn: "net.sockPipe", args: [receiver, dst], type: VOID, loc };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    requireStatementPosition(lowerer, call, `socket.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = lowerer.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const receiver = coerceToHandle(lowerer, access.expression, NETSOCKET_T);
    if (event === "data") {
      const sigs = lowerer.checker.getCallSignatures(lowerer.typeOf(args[1]!));
      const firstParam = sigs.length === 1 ? sigs[0]!.getParameters()[0] : undefined;
      const param =
        firstParam !== undefined
          ? lowerer.mapTypeOf(lowerer.checker.getTypeOfSymbol(firstParam))
          : null;
      if (
        param !== null &&
        param.kind !== "dyn" &&
        !(param.kind === "bytes" && param.elem === "u8")
      ) {
        // A chunk typed string (or string | Buffer): the listener takes
        // the chunk through a checked boundary, so a string arrives after
        // setEncoding and a Buffer without it fails the check instead of
        // being decoded.
        const boxed = lowerSocketDynListener(lowerer, args[1]!, "data listeners");
        const cb: IrExpr = { kind: "dynCheck", value: boxed, type: funcOf([DYN], VOID), loc };
        return {
          kind: "libCall",
          fn: "net.sockOnData",
          args: [receiver, cb, once],
          type: VOID,
          loc,
        };
      }
      if (param !== null && param.kind === "bytes" && socketEncodingReachable(lowerer)) {
        const encoded = lowerEncodedDataListener(lowerer, args[1]!);
        // A listener defined elsewhere keeps its Buffer parameter; it takes
        // the chunk through the checked boundary, so a string chunk fails
        // the check instead of arriving as a Buffer.
        const cb: IrExpr =
          encoded ??
          ({
            kind: "dynCheck",
            value: lowerSocketDynListener(lowerer, args[1]!, "data listeners"),
            type: funcOf([DYN], VOID),
            loc,
          } as IrExpr);
        return {
          kind: "libCall",
          fn: "net.sockOnData",
          args: [receiver, cb, once],
          type: VOID,
          loc,
        };
      }
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "data listeners",
        1,
        (p) => p.kind === "bytes" && p.elem === "u8",
        "use (chunk: Buffer) or ()",
        [DYN],
      );
      return { kind: "libCall", fn: "net.sockOnData", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "error") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "error listeners",
        1,
        (p) => p.kind === "object" && p.className === "%Error",
        "use (err) or ()",
        [ERROR_T],
      );
      return {
        kind: "libCall",
        fn: "net.sockOnError",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (
      event === "close" &&
      lowerer.checker
        .getCallSignatures(lowerer.typeOf(args[1]!))
        .some((sig) => sig.getParameters().length > 0)
    ) {
      // close(hadError): true when the socket closed because of an error.
      return {
        kind: "libCall",
        fn: "net.sockOnCloseDyn",
        args: [receiver, lowerSocketDynListener(lowerer, args[1]!, "close listeners"), once],
        type: VOID,
        loc,
      };
    }
    if (
      event === "end" ||
      event === "close" ||
      event === "connect" ||
      event === "ready" ||
      event === "timeout" ||
      event === "readable"
    ) {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        `${event} listeners`,
        0,
        () => false,
        "use ()",
        [],
      );
      const fn: IrLibFn =
        event === "end"
          ? "net.sockOnEnd"
          : event === "close"
            ? "net.sockOnClose"
            : event === "timeout"
              ? "net.sockOnTimeout"
              : event === "readable"
                ? "net.sockOnReadable"
                : event === "ready"
                  ? "net.sockOnReady"
                  : "net.sockOnConnect";
      return { kind: "libCall", fn, args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "lookup") {
      // (err, address, family, host) after the host name resolves, before
      // the connect: once per resolved address, or once with the error.
      return {
        kind: "libCall",
        fn: "net.sockOnLookup",
        args: [receiver, lowerSocketDynListener(lowerer, args[1]!, "lookup listeners"), once],
        type: VOID,
        loc,
      };
    }
    if (event === "finish") {
      // Fires once when the FIN goes out — once either way (the event
      // happens at most once per socket).
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "finish listeners",
        0,
        () => false,
        "use ()",
        [],
      );
      return { kind: "libCall", fn: "net.sockOnFinish", args: [receiver, cb], type: VOID, loc };
    }
    if (event === "secureConnect") {
      // The TLS client's post-handshake event: on a TLS socket the
      // 'connect' list already fires at establishment (scr_net.c's
      // transport pump); the runtime gates on the transport so a plain
      // socket's registration never fires — Node's exact split.
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "secureConnect listeners",
        0,
        () => false,
        "use ()",
        [],
      );
      return {
        kind: "libCall",
        fn: "tls.sockOnSecureConnect",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "secure") {
      // The handshake's completion on a TLS socket (after secureConnect on
      // a client); plain sockets never fire it.
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "secure listeners",
        0,
        () => false,
        "use ()",
        [],
      );
      return {
        kind: "libCall",
        fn: "tls.sockOnSecure",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "session") {
      // The received-ticket event: fires once per TLS client socket with
      // the serialized session (a Buffer); plain sockets never fire it.
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "session listeners",
        1,
        (p) => p.kind === "bytes" && p.elem === "u8",
        "use (session: Buffer) or ()",
        [DYN],
      );
      return {
        kind: "libCall",
        fn: "tls.sockOnSession",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    lowerer.noLowering(
      `socket.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
      args[0]!,
      '"data", "end", "close", "error", "connect", "lookup", "ready", "timeout", "readable", "secureConnect", "secure", and "session" are the supported socket events (as literals)',
    );
  }
  lowerer.noLowering(
    `Socket.${name}`,
    call,
    "write, end, destroy, pipe, setTimeout, setKeepAlive, setNoDelay, the address fields, read, unshift, and on/once of data/end/close/error/connect/ready/timeout/readable are the supported Socket members",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** The method-call dispatch for both server-surface receiver kinds — one
 * entry in lower-calls.ts's intrinsic chain (the lowerChildMethodCall
 * slot). Null when the receiver is neither. */
export function lowerServerMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || (access.questionDotToken && !lowerer.chainHandled.has(access)))
    return null;
  return (
    lowerServerCloseBind(lowerer, call, access) ??
    lowerNetServerMethodCall(lowerer, call, access) ??
    lowerNetSocketMethodCall(lowerer, call, access) ??
    lowerH2SessionMethodCall(lowerer, call, access) ??
    lowerH2StreamMethodCall(lowerer, call, access) ??
    lowerHttpReqMethodCall(lowerer, call, access) ??
    lowerHttpResMethodCall(lowerer, call, access) ??
    lowerHttpClientMethodCall(lowerer, call, access)
  );
}

/** The `{ ...req.headers }` SNAPSHOT helper, interned per target shape —
 * the envSnapshotHelper pattern over http.reqHeaderPairs: a fresh
 * pure-index record whose overflow holds every header (lowercased names,
 * arrival order), each value wrapped at the slot union's string arm. Null
 * when the shape is not a pure index-signature record with a string arm
 * (the caller fences). */
function headersSnapshotHelper(lowerer: Lowerer, shapeId: string, loc: SrcLoc): string | null {
  return pairsSnapshotHelper(lowerer, shapeId, loc, {
    keyPrefix: "headers",
    libCall: "http.reqHeaderPairs",
    params: [{ localId: "r.0", name: "r", type: HTTPREQ_T }],
    callArgs: [varRef("r.0", HTTPREQ_T, loc)],
    listKey: { name: "set-cookie", libCall: "http.reqHeaderList" },
  });
}

function trailersSnapshotHelper(lowerer: Lowerer, shapeId: string, loc: SrcLoc): string | null {
  return pairsSnapshotHelper(lowerer, shapeId, loc, {
    keyPrefix: "trailers",
    libCall: "http.reqTrailerPairs",
    params: [{ localId: "r.0", name: "r", type: HTTPREQ_T }],
    callArgs: [varRef("r.0", HTTPREQ_T, loc)],
  });
}

function distinctSnapshotHelper(
  lowerer: Lowerer,
  shapeId: string,
  loc: SrcLoc,
  collection: "headersDistinct" | "trailersDistinct",
): string | null {
  return pairsSnapshotHelper(lowerer, shapeId, loc, {
    keyPrefix: collection,
    libCall: collection === "headersDistinct" ? "http.reqHeaderPairs" : "http.reqTrailerPairs",
    lookupValue:
      collection === "headersDistinct" ? "http.reqHeaderValues" : "http.reqTrailerValues",
    params: [{ localId: "r.0", name: "r", type: HTTPREQ_T }],
    callArgs: [varRef("r.0", HTTPREQ_T, loc)],
  });
}

/** The `endStream` boolean of an h2 options object literal, as a literal
 * bool. Returns undefined when absent (or the arg is absent). Fences on
 * a non-literal endStream value or unknown keys that would matter. */
function h2EndStreamOption(lowerer: Lowerer, node: ts.Expression | undefined): boolean | undefined {
  if (node === undefined) return undefined;
  if (!ts.isObjectLiteralExpression(node)) {
    lowerer.noLowering(
      "h2 options argument",
      node,
      "pass the options as an object literal ({ endStream: true })",
    );
  }
  let end: boolean | undefined;
  for (const prop of (node as ts.ObjectLiteralExpression).properties.nodes) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
      lowerer.noLowering(
        "h2 options with spreads or computed keys",
        prop,
        "use plain `name: value` entries",
      );
    }
    const key = (prop.name as ts.Identifier).text;
    if (key === "endStream") {
      if ((prop as ts.PropertyAssignment).initializer.kind === ts.SyntaxKind.TrueKeyword)
        end = true;
      else if ((prop as ts.PropertyAssignment).initializer.kind === ts.SyntaxKind.FalseKeyword)
        end = false;
      else
        lowerer.noLowering(
          "a non-literal endStream option",
          (prop as ts.PropertyAssignment).initializer,
          "spell it true or false",
        );
    }
    // Other keys (waitForTrailers, exclusive, parent, weight) are accepted
    // and ignored — the honest-defaults stance (they tune framing this
    // core does not model; a use that DEPENDS on them fails downstream).
  }
  return end;
}

/** Method calls on ClientHttp2Session / ServerHttp2Session receivers.
 * Null for other receivers (the chain keeps trying). */
function lowerH2SessionMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "http2Session") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  const receiver = () => coerceToHandle(lowerer, access.expression, HTTP2SESSION_T);
  if (name === "request") {
    const pairs =
      args.length >= 1 && !ts.isObjectLiteralExpression(args[0]!) === false && args.length >= 1
        ? null
        : null;
    void pairs;
    // arg0: headers (optional), arg1: options (optional).
    const headersArg =
      args.length >= 1
        ? lowerH2HeadersArg(lowerer, args[0]!)
        : ({ kind: "arrayLit", elems: [], type: arrayOf(STRING), loc } as IrExpr);
    const end = h2EndStreamOption(lowerer, args[1]);
    const endF64: IrExpr = {
      kind: "numLit",
      value: end === undefined ? -1 : end ? 1 : 0,
      type: F64,
      loc,
    };
    return {
      kind: "libCall",
      fn: "http2.sessionRequest",
      args: [receiver(), headersArg, endF64],
      type: HTTP2STREAM_T,
      loc,
    };
  }
  if (name === "close") {
    requireStatementPosition(lowerer, call, "session.close(...)");
    if (args.length === 0) {
      return { kind: "libCall", fn: "http2.sessionClose", args: [receiver()], type: VOID, loc };
    }
    const { cb } = lowerCallbackArg(
      lowerer,
      args[0]!,
      "close callbacks",
      0,
      () => false,
      "use ()",
      [],
    );
    return { kind: "libCall", fn: "http2.sessionCloseCb", args: [receiver(), cb], type: VOID, loc };
  }
  if (name === "destroy") {
    requireStatementPosition(lowerer, call, "session.destroy(...)");
    return { kind: "libCall", fn: "http2.sessionDestroy", args: [receiver()], type: VOID, loc };
  }
  if (name === "settings") {
    // session.settings(obj[, cb]): the settings record crosses as a dyn
    // value (the checked-dynamic boundary — object literals box); the
    // callback fires on the peer's ACK ((err, settings, duration) in the
    // dyn flavor, zero-arg in the typed one).
    requireStatementPosition(lowerer, call, "session.settings(...)");
    if (args.length === 0) {
      return { kind: "libCall", fn: "http2.sessionSettings0", args: [receiver()], type: VOID, loc };
    }
    const v = lowerer.lowerExpr(args[0]!);
    const settingsArg: IrExpr =
      v.type.kind === "dyn" ? v : { kind: "dynFrom", value: v, type: DYN, loc };
    if (args.length >= 2) {
      const cbV = lowerer.lowerExpr(args[1]!);
      if (cbV.type.kind === "dyn") {
        // The dyn callback keeps Node's exact (err, settings, duration)
        // shape — the runtime fires it through the checked-dynamic tree.
        return {
          kind: "libCall",
          fn: "http2.sessionSettingsDynCb",
          args: [receiver(), settingsArg, cbV],
          type: VOID,
          loc,
        };
      }
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "settings callbacks",
        0,
        () => false,
        "use () — or a dynamic (mustCall-wrapped) callback for the (err, settings, duration) shape",
        [],
      );
      return {
        kind: "libCall",
        fn: "http2.sessionSettingsCb0",
        args: [receiver(), settingsArg, cb],
        type: VOID,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: "http2.sessionSettings",
      args: [receiver(), settingsArg],
      type: VOID,
      loc,
    };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    requireStatementPosition(lowerer, call, `session.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = lowerer.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    if (event === "localSettings" || event === "remoteSettings") {
      // The settings payload crosses as a dyn value: dyn (mustCall)
      // listeners fire with the settings record; zero-arg typed
      // listeners register plainly.
      const local = boolLit(event === "localSettings", loc);
      const cbV = lowerer.lowerExpr(args[1]!);
      if (cbV.type.kind === "dyn") {
        return {
          kind: "libCall",
          fn: "http2.sessionOnSettingsDyn",
          args: [receiver(), cbV, once, local],
          type: VOID,
          loc,
        };
      }
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        `${event} listeners`,
        0,
        () => false,
        "use () — or a dynamic (mustCall-wrapped) listener for the (settings) payload",
        [],
      );
      return {
        kind: "libCall",
        fn: "http2.sessionOnSettings0",
        args: [receiver(), cb, once, local],
        type: VOID,
        loc,
      };
    }
    if (event === "close") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "close listeners",
        0,
        () => false,
        "use ()",
        [],
      );
      return {
        kind: "libCall",
        fn: "http2.sessionOnClose",
        args: [receiver(), cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "error") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "error listeners",
        1,
        (p) => p.kind === "object" && p.className === "%Error",
        "use (err) or ()",
        [ERROR_T],
      );
      return {
        kind: "libCall",
        fn: "http2.sessionOnError",
        args: [receiver(), cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "connect") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "connect listeners",
        2,
        (p) => p.kind === "http2Session" || p.kind === "netSocket",
        "use (session, socket) or ()",
        [HTTP2SESSION_T, NETSOCKET_T],
      );
      return {
        kind: "libCall",
        fn: "http2.sessionOnConnect",
        args: [receiver(), cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "stream") {
      const cb = h2HeadersCallbackAdapter(
        lowerer,
        args[1]!,
        "stream listeners",
        "http2Stream",
        false,
        loc,
      );
      return {
        kind: "libCall",
        fn: "http2.sessionOnStream",
        args: [receiver(), cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "goaway") {
      const cb = lowerer.lowerExpr(args[1]!);
      if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 3) {
        lowerer.unsupported(
          "SC1090",
          args[1]!,
          "goaway listeners with more than three parameters or returning a value",
        );
      }
      if (cb.type.params.some((p) => p.kind !== "f64" && p.kind !== "bytes")) {
        lowerer.unsupported(
          "SC1090",
          args[1]!,
          "goaway listeners whose parameters are not (errorCode, lastStreamID, opaqueData?)",
        );
      }
      return {
        kind: "libCall",
        fn: "http2.sessionOnGoaway",
        args: [receiver(), voidizedCallback(lowerer, cb, loc), once],
        type: VOID,
        loc,
      };
    }
    lowerer.noLowering(
      `session.${name}("${event ?? "?"}", ...)`,
      args[0]!,
      '"close", "error", "connect", "stream", and "goaway" are the supported session events',
    );
  }
  lowerer.noLowering(
    `session.${name}`,
    call,
    'close/destroy/request and on("close"|"error"|"connect"|"stream"|"goaway") are the lowered session members',
  );
}

/** Method calls on ClientHttp2Stream / ServerHttp2Stream receivers. */
function lowerH2StreamMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  receiverOverride?: IrExpr,
): IrExpr | null {
  const compatReqStream =
    ts.isPropertyAccessExpression(access.expression) &&
    access.expression.name.text === "stream" &&
    lowerer.mapTypeOf(lowerer.typeOf(access.expression.expression))?.kind === "httpReq";
  if (
    lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "http2Stream" &&
    !compatReqStream
  )
    return null;
  if (!lowerer.isStdlibMember(access) && !compatReqStream) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  const receiver = () =>
    receiverOverride ?? coerceToHandle(lowerer, access.expression, HTTP2STREAM_T);
  if (name === "respond") {
    requireStatementPosition(lowerer, call, "stream.respond(...)");
    const headersArg =
      args.length >= 1
        ? lowerH2HeadersArg(lowerer, args[0]!)
        : ({ kind: "arrayLit", elems: [], type: arrayOf(STRING), loc } as IrExpr);
    const end = h2EndStreamOption(lowerer, args[1]);
    return {
      kind: "libCall",
      fn: "http2.streamRespond",
      args: [receiver(), headersArg, boolLit(end ?? false, loc)],
      type: VOID,
      loc,
    };
  }
  if (name === "write" || name === "end") {
    requireStatementPosition(lowerer, call, `stream.${name}(...)`);
    const minArgs = name === "write" ? 1 : 0;
    if (args.length < minArgs || args.length > 1) {
      // end() with a trailing callback is common; accept (data?, cb?) by
      // dropping a trailing closure arg (fire-and-forget — the finish
      // callback is not modeled here).
      if (!(name === "end" && args.length === 2)) {
        lowerer.noLowering(
          `${name} with ${args.length} arguments`,
          call,
          `use ${name}(data${name === "write" ? "" : "?"})`,
        );
      }
    }
    if (args.length === 0) {
      return { kind: "libCall", fn: "http2.streamEnd", args: [receiver()], type: VOID, loc };
    }
    const data = lowerer.lowerExpr(args[0]!);
    const isBytes = data.type.kind === "bytes";
    if (data.type.kind !== "string" && !isBytes) {
      lowerer.noLowering(
        `${name} with '${lowerer.fmt(data.type)}' data`,
        args[0]!,
        "the chunk is a string or a Uint8Array here",
      );
    }
    const fn: IrLibFn =
      name === "write"
        ? isBytes
          ? "http2.streamWriteBytes"
          : "http2.streamWrite"
        : isBytes
          ? "http2.streamEndBytes"
          : "http2.streamEndStr";
    return { kind: "libCall", fn, args: [receiver(), data], type: VOID, loc };
  }
  if (name === "close") {
    requireStatementPosition(lowerer, call, "stream.close(...)");
    const code: IrExpr =
      args.length >= 1 ? lowerer.lowerExpr(args[0]!) : { kind: "numLit", value: 0, type: F64, loc };
    if (code.type.kind !== "f64") {
      lowerer.noLowering(
        "stream.close with a non-numeric code",
        args[0]!,
        "the code is a number (http2.constants.NGHTTP2_*)",
      );
    }
    if (args.length >= 2) {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "close callbacks",
        0,
        () => false,
        "use ()",
        [],
      );
      return {
        kind: "libCall",
        fn: "http2.streamCloseCb",
        args: [receiver(), code, cb],
        type: VOID,
        loc,
      };
    }
    return { kind: "libCall", fn: "http2.streamClose", args: [receiver(), code], type: VOID, loc };
  }
  if (name === "destroy") {
    requireStatementPosition(lowerer, call, "stream.destroy(...)");
    return { kind: "libCall", fn: "http2.streamDestroy", args: [receiver()], type: VOID, loc };
  }
  if (name === "setEncoding") {
    const enc = lowerer.lowerExpr(args[0]!);
    if (enc.type.kind !== "string")
      lowerer.noLowering("setEncoding with a non-string encoding", args[0]!, 'pass "utf8"');
    if (ts.isExpressionStatement(call.parent) || ts.isArrowFunction(call.parent)) {
      return {
        kind: "libCall",
        fn: "http2.streamSetEncoding",
        args: [receiver(), enc],
        type: VOID,
        loc,
      };
    }
    // The chaining spelling (`client.request(h).setEncoding("utf8")`):
    // same write, the result is the receiver — Node's return-this.
    return {
      kind: "libCall",
      fn: "http2.streamSetEncodingRet",
      args: [receiver(), enc],
      type: HTTP2STREAM_T,
      loc,
    };
  }
  if (name === "resume" || name === "pause") {
    requireStatementPosition(lowerer, call, `stream.${name}(...)`);
    return {
      kind: "libCall",
      fn: name === "resume" ? "http2.streamResume" : "http2.streamPause",
      args: [receiver()],
      type: VOID,
      loc,
    };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    requireStatementPosition(lowerer, call, `stream.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = lowerer.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    if (event === "data") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "data listeners",
        1,
        (p) => (p.kind === "bytes" && p.elem === "u8") || p.kind === "string" || p.kind === "dyn",
        "use (chunk) or ()",
        [BYTES_U8],
      );
      return {
        kind: "libCall",
        fn: "http2.streamOnData",
        args: [receiver(), cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "end" || event === "close" || event === "aborted") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        `${event} listeners`,
        0,
        () => false,
        "use ()",
        [],
      );
      const fn: IrLibFn =
        event === "end"
          ? "http2.streamOnEnd"
          : event === "close"
            ? "http2.streamOnClose"
            : "http2.streamOnAborted";
      return { kind: "libCall", fn, args: [receiver(), cb, once], type: VOID, loc };
    }
    if (event === "error") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "error listeners",
        1,
        (p) => p.kind === "object" && p.className === "%Error",
        "use (err) or ()",
        [ERROR_T],
      );
      return {
        kind: "libCall",
        fn: "http2.streamOnError",
        args: [receiver(), cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "response") {
      const cb = h2HeadersCallbackAdapter(lowerer, args[1]!, "response listeners", null, true, loc);
      return {
        kind: "libCall",
        fn: "http2.streamOnResponse",
        args: [receiver(), cb, once],
        type: VOID,
        loc,
      };
    }
    lowerer.noLowering(
      `stream.${name}("${event ?? "?"}", ...)`,
      args[0]!,
      '"data", "end", "close", "aborted", "error", and "response" are the supported stream events',
    );
  }
  lowerer.noLowering(
    `stream.${name}`,
    call,
    "respond/write/end/close/destroy/setEncoding/resume/pause and on(...) are the lowered stream members",
  );
}

/** A compatibility request's `req.stream?.method(...)`: the static Node
 * type omits the HTTP/1 undefined arm, so build the runtime guard explicitly.
 * The body receives the narrowed backing stream directly, preserving lazy
 * argument evaluation on the HTTP/1 arm. */
export function lowerCompatReqStreamOptionalCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  if (!ts.isPropertyAccessExpression(call.expression) || !call.expression.questionDotToken)
    return null;
  const stream = call.expression.expression;
  if (
    !ts.isPropertyAccessExpression(stream) ||
    stream.name.text !== "stream" ||
    lowerer.mapTypeOf(lowerer.typeOf(stream.expression))?.kind !== "httpReq"
  )
    return null;
  const loc = locOf(call);
  const unionT: IrType = {
    kind: "union",
    unionId: lowerer.unions.intern([HTTP2STREAM_T, UNDEFINED_T]),
  };
  const guarded: IrExpr = {
    kind: "libCall",
    fn: "http.reqH2Stream",
    args: [coerceToHandle(lowerer, stream.expression, HTTPREQ_T)],
    type: unionT,
    loc,
  };
  const id = lowerer.closureName(loc, "", "chain");
  const body = lowerH2StreamMethodCall(lowerer, call, call.expression, {
    kind: "chainRecv",
    id,
    type: HTTP2STREAM_T,
    loc,
  });
  if (body === null) return null;
  return { kind: "optChain", id, receiver: guarded, body, type: VOID, loc };
}

/** The composed `server.address().port` read — the crypto
 * randomBytes(n).toString(enc) precedent: the AddressInfo record between
 * the two reads never materializes; the runtime answers the bound port
 * directly. Null for every other property shape. */
export function lowerServerProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken && !lowerer.chainHandled.has(expr)) return null;
  const loc = locOf(expr);
  // req.url / req.method — always-present strings on server requests;
  // req.headers.NAME — the `string | undefined` union (envGet's type).
  const recvKind = lowerer.mapTypeOf(lowerer.typeOf(expr.expression))?.kind;
  if (recvKind === "netServer" && lowerer.isStdlibMember(expr)) {
    if (expr.name.text === "listening") {
      const receiver = coerceToHandle(lowerer, expr.expression, NETSERVER_T);
      return { kind: "libCall", fn: "net.serverListening", args: [receiver], type: BOOL, loc };
    }
    if (expr.name.text === "maxConnections" || expr.name.text === "dropMaxConnection") {
      const receiver = coerceToHandle(lowerer, expr.expression, NETSERVER_T);
      const value: IrExpr = {
        kind: "libCall",
        fn:
          expr.name.text === "maxConnections"
            ? "net.serverMaxConnectionsGet"
            : "net.serverDropMaxConnectionGet",
        args: [receiver],
        type: DYN,
        loc,
      };
      // The property's declared type: an earlier `= undefined` narrows
      // the read's own type to undefined.
      const sym = lowerer.checker.getSymbolAtLocation(expr.name);
      const declared = lowerer.mapTypeOf(
        sym ? lowerer.checker.getTypeOfSymbol(sym) : lowerer.typeOf(expr),
      );
      return declared === null || declared.kind === "dyn"
        ? value
        : lowerer.coerceInto(expr, value, declared);
    }
    const field = httpServerTimeoutField(expr.name.text);
    if (field !== null) {
      const receiver = coerceToHandle(lowerer, expr.expression, NETSERVER_T);
      const selector: IrExpr = { kind: "numLit", value: field, type: F64, loc };
      return {
        kind: "libCall",
        fn: "http.serverTimeoutGet",
        args: [receiver, selector],
        type: F64,
        loc,
      };
    }
  }
  if (recvKind === "httpReq" && lowerer.isStdlibMember(expr)) {
    const name = expr.name.text;
    if (name === "url" || name === "method") {
      const receiver = coerceToHandle(lowerer, expr.expression, HTTPREQ_T);
      const fn: IrLibFn = name === "url" ? "http.reqUrl" : "http.reqMethod";
      return { kind: "libCall", fn, args: [receiver], type: STRING, loc };
    }
    if (name === "statusCode") {
      // `number | undefined` — a real status on client responses, the
      // undefined arm on server requests (Node's IncomingMessage split).
      const receiver = coerceToHandle(lowerer, expr.expression, HTTPREQ_T);
      return {
        kind: "libCall",
        fn: "http.reqStatusCode",
        args: [receiver],
        type: lowerer.withUndefinedArm(F64),
        loc,
      };
    }
    if (name === "socket" || name === "connection") {
      const receiver = coerceToHandle(lowerer, expr.expression, HTTPREQ_T);
      return { kind: "libCall", fn: "http.reqSocket", args: [receiver], type: NETSOCKET_T, loc };
    }
    if (name === "httpVersion") {
      const receiver = coerceToHandle(lowerer, expr.expression, HTTPREQ_T);
      return { kind: "libCall", fn: "http.reqHttpVersion", args: [receiver], type: STRING, loc };
    }
    if (name === "httpVersionMajor" || name === "httpVersionMinor") {
      const receiver = coerceToHandle(lowerer, expr.expression, HTTPREQ_T);
      const fn: IrLibFn =
        name === "httpVersionMajor" ? "http.reqHttpVersionMajor" : "http.reqHttpVersionMinor";
      return { kind: "libCall", fn, args: [receiver], type: F64, loc };
    }
    if (name === "aborted" || name === "complete") {
      // The compat pair's flags (Http2ServerRequest); an http/1 request
      // answers aborted: false and complete-once-ended the same way.
      const receiver = coerceToHandle(lowerer, expr.expression, HTTPREQ_T);
      const fn: IrLibFn = name === "aborted" ? "http.reqAborted" : "http.reqComplete";
      return { kind: "libCall", fn, args: [receiver], type: BOOL, loc };
    }
    if (name === "rawHeaders" || name === "rawTrailers") {
      // [name, value, name, value, ...] in arrival order, names in their
      // ORIGINAL case — Node's shape; a fresh string[] per read.
      const receiver = coerceToHandle(lowerer, expr.expression, HTTPREQ_T);
      const fn: IrLibFn = name === "rawHeaders" ? "http.reqRawHeaders" : "http.reqRawTrailers";
      return { kind: "libCall", fn, args: [receiver], type: arrayOf(STRING), loc };
    }
    if (name === "statusMessage") {
      // `string | undefined` — the reason phrase on client responses (""
      // when the status line carried none), undefined on server requests
      // (the statusCode split).
      const receiver = coerceToHandle(lowerer, expr.expression, HTTPREQ_T);
      return {
        kind: "libCall",
        fn: "http.reqStatusMessage",
        args: [receiver],
        type: lowerer.envValueType(),
        loc,
      };
    }
    if (name === "stream") {
      const parent = expr.parent;
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === expr &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent
      ) {
        const receiver = coerceToHandle(lowerer, expr.expression, HTTPREQ_T);
        if (parent.questionDotToken) {
          const type: IrType = {
            kind: "union",
            unionId: lowerer.unions.intern([HTTP2STREAM_T, UNDEFINED_T]),
          };
          return { kind: "libCall", fn: "http.reqH2Stream", args: [receiver], type, loc };
        }
        return {
          kind: "libCall",
          fn: "http.reqH2StreamOrThrow",
          args: [receiver, { kind: "strLit", value: parent.name.text, type: STRING, loc }],
          type: HTTP2STREAM_T,
          loc,
        };
      }
      lowerer.noLowering(
        "reading 'stream' from a request outside a method call",
        expr,
        "call req.stream methods directly; optional calls remain undefined on HTTP/1 and use the live stream on HTTP/2",
      );
    }
    if (name === "session") {
      // Http2ServerRequest's h2-only members are not exposed through the
      // compatibility request handle yet. The call forms retain their
      // guarded-no-op / unguarded-TypeError stance; other reads fence.
      lowerer.noLowering(
        `reading '${name}' (an HTTP/2-only member) from a request`,
        expr,
        "compatibility requests do not expose their backing h2 stream/session yet; guarded method calls no-op and other reads have no lowering",
      );
    }
    if (
      name === "headers" ||
      name === "trailers" ||
      name === "headersDistinct" ||
      name === "trailersDistinct"
    ) {
      // Whole-object reads materialize a typed snapshot record. Per-name
      // reads retain their direct lowerings.
      const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
      if (mapped?.kind === "record") {
        const helper =
          name === "headers"
            ? headersSnapshotHelper(lowerer, mapped.shapeId, loc)
            : name === "trailers"
              ? trailersSnapshotHelper(lowerer, mapped.shapeId, loc)
              : distinctSnapshotHelper(lowerer, mapped.shapeId, loc, name);
        if (helper !== null) {
          const receiver = coerceToHandle(lowerer, expr.expression, HTTPREQ_T);
          return { kind: "call", callee: helper, args: [receiver], type: mapped, loc };
        }
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        `req.${name} as a value of this type (read one field: req.${name}.name or req.${name}[name])`,
      );
    }
  }
  if (recvKind === "httpRes" && lowerer.isStdlibMember(expr) && expr.name.text === "stream") {
    lowerer.noLowering(
      "reading 'stream' (an HTTP/2-only member) from a response",
      expr,
      "compatibility responses do not expose their backing h2 stream yet — guard method calls with '?.' or drop the use",
    );
  }
  if (recvKind === "netSocket" && expr.name.text === "encrypted") {
    // `boolean | undefined` — Node types `encrypted` on TLSSocket only
    // (true from construction); reading it off a plain socket answers
    // undefined. The @types/node idiom reaches it through a cast
    // (`socket as net.Socket & { encrypted?: boolean }` — proxy.ts's
    // isEncrypted), so the member's declaration is USER code and the
    // stdlib-provenance check deliberately does not apply: the receiver
    // KIND is a real socket either way, and `encrypted` on a socket has
    // exactly one meaning.
    const receiver = coerceToHandle(lowerer, expr.expression, NETSOCKET_T);
    return {
      kind: "libCall",
      fn: "net.sockEncrypted",
      args: [receiver],
      type: lowerer.withUndefinedArm(BOOL),
      loc,
    };
  }
  if (recvKind === "netSocket" && expr.name.text === "authorized") {
    // TLSSocket.authorized — Node's verify verdict (false on plain
    // sockets, servers without requestCert, and unverified clients).
    // Like `encrypted`, no stdlib-provenance gate: the member has exactly
    // one meaning on a socket-kind receiver.
    const receiver = coerceToHandle(lowerer, expr.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "tls.sockAuthorized", args: [receiver], type: BOOL, loc };
  }
  if (
    recvKind === "netSocket" &&
    lowerer.isStdlibMember(expr) &&
    expr.name.text === "alpnProtocol"
  ) {
    // TLSSocket.alpnProtocol: null before the handshake, then the
    // negotiated protocol or false.
    const receiver = coerceToHandle(lowerer, expr.expression, NETSOCKET_T);
    const value: IrExpr = {
      kind: "libCall",
      fn: "tls.sockAlpnProtocol",
      args: [receiver],
      type: DYN,
      loc,
    };
    const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
    return declared === null || declared.kind === "dyn"
      ? value
      : lowerer.coerceInto(expr, value, declared);
  }
  if (recvKind === "netSocket" && expr.name.text === "authorizationError") {
    // TLSSocket.authorizationError — the verify-failure CODE STRING
    // (DEPTH_ZERO_SELF_SIGNED_CERT, ...) or null when authorized/never
    // verified: Node's exact value shape (a string, not an Error).
    const receiver = coerceToHandle(lowerer, expr.expression, NETSOCKET_T);
    const type: IrType = { kind: "union", unionId: lowerer.unions.intern([STRING, NULL_T]) };
    return { kind: "libCall", fn: "tls.sockAuthError", args: [receiver], type, loc };
  }
  if (recvKind === "netSocket" && lowerer.isStdlibMember(expr) && expr.name.text === "destroyed") {
    // true once the fd is gone (destroy() or full close) — Node's flag,
    // the proxy's re-entrant teardown guard.
    const receiver = coerceToHandle(lowerer, expr.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockDestroyed", args: [receiver], type: BOOL, loc };
  }
  if (recvKind === "netSocket" && lowerer.isStdlibMember(expr) && expr.name.text === "writable") {
    // Node's stream answer: the write half is open — no end() yet, no FIN
    // sent, fd alive (connecting sockets answer true; writes queue). The
    // proxy's "may I still answer 502" guard.
    const receiver = coerceToHandle(lowerer, expr.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockWritable", args: [receiver], type: BOOL, loc };
  }
  if (
    recvKind === "netSocket" &&
    lowerer.isStdlibMember(expr) &&
    expr.name.text === "bytesWritten"
  ) {
    // Every byte the write paths accepted (buffered included — Node
    // counts those too; plaintext on TLS sockets).
    const receiver = coerceToHandle(lowerer, expr.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockBytesWritten", args: [receiver], type: F64, loc };
  }
  if (recvKind === "netSocket" && lowerer.isStdlibMember(expr) && expr.name.text === "readable") {
    // true until the read half is done (peer FIN / destroy).
    const receiver = coerceToHandle(lowerer, expr.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockReadable", args: [receiver], type: BOOL, loc };
  }
  if (
    recvKind === "netSocket" &&
    lowerer.isStdlibMember(expr) &&
    expr.name.text === "remoteAddress"
  ) {
    // `string | undefined` — Node's read-time caching: a value read while
    // connected survives destroy; never-read sockets answer undefined
    // after close.
    const receiver = coerceToHandle(lowerer, expr.expression, NETSOCKET_T);
    return {
      kind: "libCall",
      fn: "net.sockRemoteAddress",
      args: [receiver],
      type: lowerer.envValueType(),
      loc,
    };
  }
  if (recvKind === "netSocket" && lowerer.isStdlibMember(expr)) {
    const name = expr.name.text;
    // The other address fields: the peer's cached like remoteAddress, the
    // local ones read live (undefined while connecting and after close).
    const field = [
      "remotePort",
      "remoteFamily",
      "localAddress",
      "localPort",
      "localFamily",
    ].indexOf(name);
    if (field >= 0) {
      const receiver = coerceToHandle(lowerer, expr.expression, NETSOCKET_T);
      const value: IrExpr = {
        kind: "libCall",
        fn: "net.sockAddrField",
        args: [receiver, { kind: "numLit", value: field, type: F64, loc }],
        type: DYN,
        loc,
      };
      const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
      return declared === null || declared.kind === "dyn"
        ? value
        : lowerer.coerceInto(expr, value, declared);
    }
    const scalar: { fn: IrLibFn; type: IrType } | null =
      name === "bytesRead"
        ? { fn: "net.sockBytesRead", type: F64 }
        : name === "connecting"
          ? { fn: "net.sockConnecting", type: BOOL }
          : name === "pending"
            ? { fn: "net.sockPending", type: BOOL }
            : name === "readyState"
              ? { fn: "net.sockReadyState", type: STRING }
              : null;
    if (scalar !== null) {
      const receiver = coerceToHandle(lowerer, expr.expression, NETSOCKET_T);
      return { kind: "libCall", fn: scalar.fn, args: [receiver], type: scalar.type, loc };
    }
  }
  if (
    recvKind === "httpClientReq" &&
    lowerer.isStdlibMember(expr) &&
    expr.name.text === "destroyed"
  ) {
    const receiver = coerceToHandle(lowerer, expr.expression, HTTPCLIENTREQ_T);
    return { kind: "libCall", fn: "http.clientDestroyed", args: [receiver], type: BOOL, loc };
  }
  if (
    recvKind === "httpClientReq" &&
    lowerer.isStdlibMember(expr) &&
    (expr.name.text === "socket" || expr.name.text === "connection")
  ) {
    const receiver = coerceToHandle(lowerer, expr.expression, HTTPCLIENTREQ_T);
    return { kind: "libCall", fn: "http.clientSocket", args: [receiver], type: NETSOCKET_T, loc };
  }
  if (
    recvKind === "httpClientReq" &&
    lowerer.isStdlibMember(expr) &&
    expr.name.text === "writableCorked"
  ) {
    const receiver = coerceToHandle(lowerer, expr.expression, HTTPCLIENTREQ_T);
    return { kind: "libCall", fn: "http.clientWritableCorked", args: [receiver], type: F64, loc };
  }
  if (recvKind === "httpClientReq" && lowerer.isStdlibMember(expr)) {
    const name = expr.name.text;
    const strFn: IrLibFn | null =
      name === "method"
        ? "http.clientMethod"
        : name === "path"
          ? "http.clientPath"
          : name === "host"
            ? "http.clientHost"
            : name === "protocol"
              ? "http.clientProtocol"
              : null;
    if (strFn !== null) {
      const receiver = coerceToHandle(lowerer, expr.expression, HTTPCLIENTREQ_T);
      return { kind: "libCall", fn: strFn, args: [receiver], type: STRING, loc };
    }
    const boolFn: IrLibFn | null =
      name === "aborted"
        ? "http.clientAborted"
        : name === "headersSent"
          ? "http.clientHeadersSent"
          : name === "writableEnded" || name === "finished"
            ? "http.clientWritableEnded"
            : name === "writableFinished"
              ? "http.clientWritableFinished"
              : name === "reusedSocket"
                ? "http.clientReusedSocket"
                : null;
    if (boolFn !== null) {
      const receiver = coerceToHandle(lowerer, expr.expression, HTTPCLIENTREQ_T);
      return { kind: "libCall", fn: boolFn, args: [receiver], type: BOOL, loc };
    }
  }
  if (httpReqFieldCollection(lowerer, expr.expression) !== null) {
    const collection = httpReqFieldCollection(lowerer, expr.expression)!;
    const receiver = coerceToHandle(
      lowerer,
      (expr.expression as ts.PropertyAccessExpression).expression,
      HTTPREQ_T,
    );
    const key: IrExpr = { kind: "strLit", value: expr.name.text, type: STRING, loc };
    const list = isSetCookieRead(lowerer, expr, collection, key);
    const fn: IrLibFn =
      collection === "headers" && !list
        ? "http.reqHeader"
        : collection === "trailers"
          ? "http.reqTrailer"
          : collection === "headersDistinct" || list
            ? "http.reqHeaderValues"
            : "http.reqTrailerValues";
    const type =
      collection.endsWith("Distinct") || list
        ? lowerer.withUndefinedArm(arrayOf(STRING))
        : lowerer.envValueType();
    return { kind: "libCall", fn, args: [receiver, key], type, loc };
  }
  if (recvKind === "httpRes" && lowerer.isStdlibMember(expr) && expr.name.text === "headersSent") {
    const receiver = coerceToHandle(lowerer, expr.expression, HTTPRES_T);
    return { kind: "libCall", fn: "http.resHeadersSent", args: [receiver], type: BOOL, loc };
  }
  if (
    recvKind === "httpRes" &&
    lowerer.isStdlibMember(expr) &&
    expr.name.text === "writableEnded"
  ) {
    const receiver = coerceToHandle(lowerer, expr.expression, HTTPRES_T);
    return { kind: "libCall", fn: "http.resWritableEnded", args: [receiver], type: BOOL, loc };
  }
  if (recvKind === "httpRes" && lowerer.isStdlibMember(expr) && expr.name.text === "finished") {
    const receiver = coerceToHandle(lowerer, expr.expression, HTTPRES_T);
    return { kind: "libCall", fn: "http.resWritableEnded", args: [receiver], type: BOOL, loc };
  }
  if (
    recvKind === "httpRes" &&
    lowerer.isStdlibMember(expr) &&
    expr.name.text === "writableCorked"
  ) {
    const receiver = coerceToHandle(lowerer, expr.expression, HTTPRES_T);
    return { kind: "libCall", fn: "http.resWritableCorked", args: [receiver], type: F64, loc };
  }
  if (recvKind === "httpRes" && lowerer.isStdlibMember(expr) && expr.name.text === "statusCode") {
    // 200 until assigned — Node's fresh-response default; the assignment
    // twin lives in lowerHttpResPropertyAssignment.
    const receiver = coerceToHandle(lowerer, expr.expression, HTTPRES_T);
    return { kind: "libCall", fn: "http.resStatusGet", args: [receiver], type: F64, loc };
  }
  if (
    recvKind === "httpRes" &&
    lowerer.isStdlibMember(expr) &&
    expr.name.text === "statusMessage"
  ) {
    // Unset until the head is sent; then the assigned or default reason.
    const receiver = coerceToHandle(lowerer, expr.expression, HTTPRES_T);
    return {
      kind: "libCall",
      fn: "http.resStatusMsgGet",
      args: [receiver],
      type: lowerer.withUndefinedArm(STRING),
      loc,
    };
  }
  if (recvKind === "httpRes" && lowerer.isStdlibMember(expr)) {
    const name = expr.name.text;
    if (name === "req") {
      const receiver = coerceToHandle(lowerer, expr.expression, HTTPRES_T);
      return { kind: "libCall", fn: "http.resRequest", args: [receiver], type: HTTPREQ_T, loc };
    }
    if (name === "socket" || name === "connection") {
      const receiver = coerceToHandle(lowerer, expr.expression, HTTPRES_T);
      const type: IrType = { kind: "union", unionId: lowerer.unions.intern([NETSOCKET_T, NULL_T]) };
      return { kind: "libCall", fn: "http.resSocket", args: [receiver], type, loc };
    }
    if (name === "writableFinished") {
      const receiver = coerceToHandle(lowerer, expr.expression, HTTPRES_T);
      return { kind: "libCall", fn: "http.resWritableFinished", args: [receiver], type: BOOL, loc };
    }
    if (name === "sendDate" || name === "strictContentLength") {
      const receiver = coerceToHandle(lowerer, expr.expression, HTTPRES_T);
      const fn: IrLibFn =
        name === "sendDate" ? "http.resSendDateGet" : "http.resStrictContentLengthGet";
      return { kind: "libCall", fn, args: [receiver], type: BOOL, loc };
    }
  }
  if (recvKind === "http2Session" && lowerer.isStdlibMember(expr)) {
    const m = expr.name.text;
    const recv = () => coerceToHandle(lowerer, expr.expression, HTTP2SESSION_T);
    if (m === "closed")
      return { kind: "libCall", fn: "http2.sessionClosed", args: [recv()], type: BOOL, loc };
    if (m === "destroyed")
      return { kind: "libCall", fn: "http2.sessionDestroyed", args: [recv()], type: BOOL, loc };
    if (m === "encrypted")
      return { kind: "libCall", fn: "http2.sessionEncrypted", args: [recv()], type: BOOL, loc };
    if (m === "type")
      return { kind: "libCall", fn: "http2.sessionType", args: [recv()], type: F64, loc };
    if (m === "alpnProtocol")
      return { kind: "libCall", fn: "http2.sessionAlpn", args: [recv()], type: STRING, loc };
    if (m === "socket")
      return { kind: "libCall", fn: "http2.sessionSocket", args: [recv()], type: NETSOCKET_T, loc };
    if (m === "pendingSettingsAck")
      return {
        kind: "libCall",
        fn: "http2.sessionPendingSettingsAck",
        args: [recv()],
        type: BOOL,
        loc,
      };
    if (m === "localSettings" || m === "remoteSettings") {
      // The settings record crosses as a dyn value (the d.ts types it
      // `any`): member reads ride the checked-dynamic keyed read.
      return {
        kind: "libCall",
        fn: "http2.sessionSettingsGet",
        args: [recv(), boolLit(m === "localSettings", loc)],
        type: DYN,
        loc,
      };
    }
  }
  if (recvKind === "http2Stream" && lowerer.isStdlibMember(expr)) {
    const m = expr.name.text;
    const recv = () => coerceToHandle(lowerer, expr.expression, HTTP2STREAM_T);
    if (m === "id")
      return { kind: "libCall", fn: "http2.streamId", args: [recv()], type: F64, loc };
    if (m === "rstCode")
      return { kind: "libCall", fn: "http2.streamRstCode", args: [recv()], type: F64, loc };
    if (m === "destroyed")
      return { kind: "libCall", fn: "http2.streamDestroyed", args: [recv()], type: BOOL, loc };
    if (m === "closed")
      return { kind: "libCall", fn: "http2.streamClosed", args: [recv()], type: BOOL, loc };
    if (m === "aborted")
      return { kind: "libCall", fn: "http2.streamAborted", args: [recv()], type: BOOL, loc };
    if (m === "pending")
      return { kind: "libCall", fn: "http2.streamPending", args: [recv()], type: BOOL, loc };
    if (m === "session")
      return {
        kind: "libCall",
        fn: "http2.streamSession",
        args: [recv()],
        type: HTTP2SESSION_T,
        loc,
      };
  }
  if (expr.name.text !== "port") return null;
  const recv = expr.expression;
  if (!ts.isCallExpression(recv) || recv.questionDotToken || recv.arguments.nodes.length !== 0)
    return null;
  if (!ts.isPropertyAccessExpression(recv.expression)) return null;
  const inner = recv.expression;
  if (inner.name.text !== "address" || inner.questionDotToken) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(inner.expression))?.kind !== "netServer") return null;
  if (!lowerer.isStdlibMember(inner)) return null;
  const receiver = coerceToHandle(lowerer, inner.expression, NETSERVER_T);
  if (unixListenReachable(lowerer)) {
    const local = lowerer.declareHiddenLocal("%addressServer", NETSERVER_T);
    const server = (): IrExpr => varRef(local.id, NETSERVER_T, loc);
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: local.id, init: receiver, loc },
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "net.serverAddressCheck",
            args: [server()],
            type: VOID,
            loc,
          },
          loc,
        },
      ],
      result: { kind: "libCall", fn: "net.serverPort", args: [server()], type: F64, loc },
      type: F64,
      loc,
    };
  }
  return { kind: "libCall", fn: "net.serverPort", args: [receiver], type: F64, loc };
}

/** The (req, res) request-handler argument — http.createServer's, https
 * createServer's, http.Server's, and server.on("request")'s shared shape
 * check: at most two parameters typed (IncomingMessage, ServerResponse).
 * A value-returning handler adapts through the cast-and-discard helper
 * (Node ignores handler results — the writeHead-chaining body
 * `(req, res) => res.writeHead(200).end()` is the motivating shape). */
function lowerRequestHandlerArg(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const cb = lowerer.lowerExpr(node);
  if (cb.type.kind === "dyn") {
    // A CHECKED-DYNAMIC handler (test/common's mustCall wrapper around
    // the (req, res) listener — the canonical suite shape): adapt
    // through the dynCheck function boundary. The adapter boxes req/res
    // as dyn HANDLE values (SCR_DYN_HANDLE — reference identity) and
    // calls the wrapper through the checked-dynamic machinery; member
    // uses inside the wrapped body dispatch back onto the same http
    // entry points at runtime.
    return {
      kind: "dynCheck",
      value: cb,
      type: funcOf([HTTPREQ_T, HTTPRES_T], VOID),
      loc: locOf(node),
    };
  }
  if (
    cb.type.kind === "func" &&
    (cb.type.rest === true ||
      (cb.type.params.length > 0 && cb.type.params.every((p) => p.kind === "dyn"))) &&
    canBoxFuncIntoDyn(
      cb.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    // A hoisted plain-JS handler (`http.createServer(handle)` where
    // `function handle(req, res)` has no contextual type — dyn params),
    // or an arguments-reading rest function: box it and adapt exactly
    // like the dyn case — req/res arrive as HANDLE boxes and the body's
    // member uses dispatch at runtime.
    const boxed: IrExpr = { kind: "dynFrom", value: cb, type: DYN, loc: locOf(node) };
    return {
      kind: "dynCheck",
      value: boxed,
      type: funcOf([HTTPREQ_T, HTTPRES_T], VOID),
      loc: locOf(node),
    };
  }
  if (cb.type.kind !== "func" || cb.type.params.length > 2) {
    lowerer.unsupported(
      "SC1090",
      node,
      "request handlers with more than two parameters (use (req, res))",
    );
  }
  const [p0, p1] = cb.type.params;
  if ((p0 !== undefined && p0.kind !== "httpReq") || (p1 !== undefined && p1.kind !== "httpRes")) {
    lowerer.unsupported(
      "SC1090",
      node,
      "request handlers whose parameters are not (req: IncomingMessage, res: ServerResponse)",
    );
  }
  return voidizedCallback(lowerer, cb, locOf(node));
}

/** The http.createServer / http.Server options object — { requireHostHeader?,
 * joinDuplicateHeaders?, keepAliveTimeoutBuffer?, ... }. The first two
 * select parser behavior; keepAliveTimeoutBuffer initializes the matching
 * writable server field after Node's non-negative-safe-integer validation.
 * Other documented keys fence by name; unknown keys drop like Node drops
 * them. */
function lowerHttpServerOptions(
  lowerer: Lowerer,
  node: ts.Expression,
  what: string,
): {
  joinDup: boolean;
  allowMissingHost: boolean;
  keepAliveTimeoutBuffer: IrExpr | null;
  maxHeaderSize: IrExpr | null;
} {
  if (!ts.isObjectLiteralExpression(node)) {
    lowerer.noLowering(
      `${what} with a non-literal options argument`,
      node,
      "pass the options as an object literal: { requireHostHeader?, joinDuplicateHeaders? }",
    );
  }
  let joinDup = false;
  let allowMissingHost = false;
  let keepAliveTimeoutBuffer: IrExpr | null = null;
  let maxHeaderSize: IrExpr | null = null;
  for (const prop of node.properties.nodes) {
    let initializer: ts.Expression | null;
    if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    ) {
      initializer = prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      initializer = null;
    } else {
      lowerer.noLowering(
        `${what} options with computed keys or spreads`,
        prop,
        "each option must be a plain `name: value` (or shorthand) entry with a literal key",
      );
    }
    const key = (prop.name as ts.Identifier | ts.StringLiteral).text;
    if (key === "requireHostHeader") {
      if (initializer !== null && initializer.kind === ts.SyntaxKind.FalseKeyword) {
        allowMissingHost = true;
        continue;
      }
      if (initializer !== null && initializer.kind === ts.SyntaxKind.TrueKeyword) {
        allowMissingHost = false;
        continue;
      }
      lowerer.noLowering(
        `${what} with a non-literal requireHostHeader option`,
        prop,
        "the lowered forms are the literals requireHostHeader: true and false",
      );
      continue;
    }
    if (key === "joinDuplicateHeaders") {
      // Literal true/false: the flag decides parse-time read semantics,
      // so a runtime value would pick one without a diagnostic — fence dynamics.
      if (initializer !== null && initializer.kind === ts.SyntaxKind.TrueKeyword) {
        joinDup = true;
        continue;
      }
      if (initializer !== null && initializer.kind === ts.SyntaxKind.FalseKeyword) {
        joinDup = false; /* Node's default: repeats keep the first value */
        continue;
      }
      lowerer.noLowering(
        `${what} with a non-literal joinDuplicateHeaders option`,
        prop,
        'the lowered forms are the literals joinDuplicateHeaders: true (repeats join ", ") and false (the keep-first default)',
      );
    }
    if (key === "maxHeaderSize") {
      // The header size bound (Node's validateInteger runs in the runtime).
      const raw =
        initializer !== null
          ? lowerer.lowerExpr(initializer)
          : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
      if (raw.type.kind !== "f64") {
        lowerer.noLowering(
          `${what} with a '${lowerer.fmt(raw.type)}' maxHeaderSize option`,
          prop,
          "maxHeaderSize is a number",
        );
      }
      maxHeaderSize = raw;
      continue;
    }
    if (key === "keepAliveTimeoutBuffer") {
      if (keepAliveTimeoutBuffer !== null) {
        lowerer.noLowering(
          `${what} with duplicate keepAliveTimeoutBuffer options`,
          prop,
          "write keepAliveTimeoutBuffer once in the options literal",
        );
      }
      const raw =
        initializer !== null
          ? lowerer.lowerExpr(initializer)
          : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
      const value = lowerer.coerceToExpected(raw, DYN);
      if (value.type.kind !== "dyn") {
        lowerer.noLowering(
          `${what} with a keepAliveTimeoutBuffer value that cannot cross the runtime option boundary`,
          prop,
          "keepAliveTimeoutBuffer is a number or undefined",
        );
      }
      // Preserve the optional field's undefined arm until runtime: Node
      // treats it as absent, while numbers take the constructor-only
      // integer/range ladder and dynamic non-numbers get its named type
      // error. Coercing eagerly to F64 would reject the valid explicit-
      // undefined spelling before the option helper sees it.
      keepAliveTimeoutBuffer = value;
      continue;
    }
    fenceOrDropOptionKey(
      lowerer,
      prop,
      key,
      what,
      HTTP_SERVER_DOCUMENTED_OPTIONS,
      "requireHostHeader, joinDuplicateHeaders, keepAliveTimeoutBuffer, and maxHeaderSize are the supported options",
    );
    // An undocumented key, dropped like Node drops it.
  }
  return { joinDup, allowMissingHost, keepAliveTimeoutBuffer, maxHeaderSize };
}

/** The shared createServer([options][, handler]) shapes behind
 * http.createServer, http.Server, and `new http.Server`: no arguments
 * (the on("request") route), a lone handler, a lone options object, and
 * (options, handler). Modeled option values wrap the construction in an
 * interned option-setting helper. */
function lowerHttpCreateServerForms(
  lowerer: Lowerer,
  expr: ts.CallExpression | ts.NewExpression,
  what: string,
  loc: SrcLoc,
): IrExpr {
  const args: readonly ts.Expression[] = expr.arguments?.nodes ?? [];
  if (args.length > 2) {
    lowerer.noLowering(
      `${what} with ${args.length} arguments`,
      expr,
      `the supported forms are ${what}([options][, (req, res) => ...])`,
    );
  }
  let optsNode: ts.Expression | null = null;
  let handlerNode: ts.Expression | null = null;
  if (args.length === 2) {
    optsNode = args[0]!;
    handlerNode = args[1]!;
  } else if (args.length === 1) {
    if (ts.isObjectLiteralExpression(args[0]!)) optsNode = args[0]!;
    else handlerNode = args[0]!;
  }
  const opts =
    optsNode !== null
      ? lowerHttpServerOptions(lowerer, optsNode, what)
      : {
          joinDup: false,
          allowMissingHost: false,
          keepAliveTimeoutBuffer: null,
          maxHeaderSize: null,
        };
  const server: IrExpr =
    handlerNode !== null
      ? {
          kind: "libCall",
          fn: "http.createServer",
          args: [lowerRequestHandlerArg(lowerer, handlerNode)],
          type: NETSERVER_T,
          loc,
        }
      : { kind: "libCall", fn: "http.createServerEmpty", args: [], type: NETSERVER_T, loc };
  if (
    !opts.joinDup &&
    !opts.allowMissingHost &&
    opts.keepAliveTimeoutBuffer === null &&
    opts.maxHeaderSize === null
  )
    return server;
  // The option-setting composition: an interned helper takes the option
  // values first (preserving Node's options-before-handler evaluation
  // order), then the fresh server, applies the modeled fields, and answers
  // the server as the constructor/factory result.
  const hasBuffer = opts.keepAliveTimeoutBuffer !== null;
  const hasMax = opts.maxHeaderSize !== null;
  const key = `server.opts:${opts.joinDup ? 1 : 0}:${opts.allowMissingHost ? 1 : 0}:${hasBuffer ? 1 : 0}:${hasMax ? 1 : 0}`;
  const existing = lowerer.arrHofHelpers.get(key);
  const name = existing ?? keyedHelperName(lowerer, "%server.opts", key);
  if (!existing) {
    lowerer.arrHofHelpers.set(key, name);
    const params = [
      ...(hasBuffer ? [{ localId: "b.0", name: "buffer", type: DYN }] : []),
      ...(hasMax ? [{ localId: "m.0", name: "maxHeaderSize", type: F64 }] : []),
      { localId: "s.0", name: "s", type: NETSERVER_T },
    ];
    const ref: IrExpr = { kind: "varRef", localId: "s.0", type: NETSERVER_T, loc };
    const body: IrStmt[] = [];
    if (hasBuffer) {
      const selector: IrExpr = { kind: "numLit", value: 4, type: F64, loc };
      const value: IrExpr = { kind: "varRef", localId: "b.0", type: DYN, loc };
      body.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "http.serverTimeoutOptionSet",
          args: [ref, selector, value],
          type: VOID,
          loc,
        },
        loc,
      });
    }
    if (hasMax) {
      body.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "http.serverMaxHeaderSize",
          args: [ref, { kind: "varRef", localId: "m.0", type: F64, loc }],
          type: VOID,
          loc,
        },
        loc,
      });
    }
    if (opts.joinDup) {
      body.push({
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "http.serverJoinDupHeaders", args: [ref], type: VOID, loc },
        loc,
      });
    }
    if (opts.allowMissingHost) {
      body.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "http.serverAllowMissingHostHeader",
          args: [ref],
          type: VOID,
          loc,
        },
        loc,
      });
    }
    body.push({ kind: "return", value: ref, loc });
    lowerer.liftedFns.push({
      name,
      params,
      returnType: NETSERVER_T,
      locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      body,
      loc,
    });
  }
  return {
    kind: "call",
    callee: name,
    args: [
      ...(opts.keepAliveTimeoutBuffer !== null ? [opts.keepAliveTimeoutBuffer] : []),
      ...(opts.maxHeaderSize !== null ? [opts.maxHeaderSize] : []),
      server,
    ],
    type: NETSERVER_T,
    loc,
  };
}

/** `new http.Server([options][, handler])` — the constructor spelling of
 * createServer (Node's Server class IS the factory's product); called
 * from lowerNew ahead of the stdlib-constructor fence. Null when the
 * callee is not the http module's Server. */
/** `new http.Agent(opts?)` / `new https.Agent(opts?)` (property access or
 * named import): the Agent lowers to a checked-dynamic HANDLE —
 * getName/destroy and the sockets/requests/freeSockets counters dispatch
 * through the dyn handle ops, and the request path threads it (the
 * requestAgent rows). Options parse at the LITERAL construction site:
 * keepAlive (a boolean value: finished connections return to the free
 * list), keepAliveMsecs / maxSockets / maxFreeSockets / timeout / port as
 * numbers, scheduling as a value the runtime validates ('fifo' or
 * 'lifo'), other documented keys fence by name, and undocumented keys
 * drop like Node drops them. Null when the callee isn't the http/https
 * Agent. */
export function lowerHttpAgentNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const callee = expr.expression;
  const bi =
    ts.isPropertyAccessExpression(callee) && callee.name.text === "Agent"
      ? lowerer.builtinMemberOf(callee)
      : ts.isIdentifier(callee)
        ? lowerer.builtinImportOf(callee)
        : null;
  if (!bi || bi.member !== "Agent" || (bi.module !== "http" && bi.module !== "https")) return null;
  const loc = locOf(expr);
  const api = `new ${bi.module}.Agent`;

  let keepAlive: IrExpr = boolLit(false, loc);
  let kaMsecs: IrExpr = numLit(-1, loc);
  let maxSockets: IrExpr = numLit(-1, loc);
  let maxFree: IrExpr = numLit(-1, loc);
  let timeout: IrExpr = numLit(-1, loc);
  let port: IrExpr = numLit(-1, loc);
  let scheduling: IrExpr = lowerer.coerceToExpected(strLit("lifo", loc), DYN);
  const args = expr.arguments?.nodes ?? [];
  if (args.length > 1) {
    lowerer.noLowering(
      `${api} with ${args.length} arguments`,
      expr,
      "the supported form is new Agent(options?)",
    );
  }
  if (args.length === 1) {
    const optsNode = stripParensAndCasts(args[0]!);
    if (!ts.isObjectLiteralExpression(optsNode)) {
      lowerer.noLowering(
        `${api} with a non-literal options value`,
        args[0]!,
        "spell the options as an object literal at the construction site",
      );
    }
    for (const prop of optsNode.properties.nodes) {
      if (ts.isSpreadAssignment(prop)) {
        lowerer.noLowering(`${api} with an options spread`, prop, "write each option inline");
      }
      let initializer: ts.Expression | null;
      if (
        ts.isPropertyAssignment(prop) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
      ) {
        initializer = prop.initializer;
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        initializer = null;
      } else {
        lowerer.noLowering(
          `${api} options with computed keys`,
          prop,
          "each option must be a plain `name: value` (or shorthand) entry with a literal key",
        );
      }
      const key = (prop.name as ts.Identifier | ts.StringLiteral).text;
      const lowerVal = (want: "bool" | "f64"): IrExpr => {
        const v =
          initializer !== null
            ? lowerer.lowerExpr(initializer)
            : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
        if (v.type.kind === "dyn") {
          return {
            kind: "dynCheck",
            value: v,
            type: want === "bool" ? BOOL : F64,
            loc: locOf(prop),
          };
        }
        if (v.type.kind !== want) {
          lowerer.noLowering(
            `a ${api} '${key}' option of '${lowerer.fmt(v.type)}' values`,
            prop,
            want === "bool"
              ? "the option value must be a boolean"
              : "the option value must be a number",
          );
        }
        return v;
      };
      switch (key) {
        case "keepAlive":
          keepAlive = lowerVal("bool");
          break;
        case "keepAliveMsecs":
          kaMsecs = lowerVal("f64");
          break;
        case "maxSockets":
          maxSockets = lowerVal("f64");
          break;
        case "maxFreeSockets":
          maxFree = lowerVal("f64");
          break;
        case "timeout":
          timeout = lowerVal("f64");
          break;
        case "port":
          // Node merges agent options under portless request options —
          // the settable defaultPort carries this one.
          port = lowerVal("f64");
          break;
        case "scheduling": {
          // 'fifo' | 'lifo' (falsy = 'lifo'), validated by the runtime
          const v =
            initializer !== null
              ? lowerer.lowerExpr(initializer)
              : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
          scheduling = lowerer.coerceToExpected(v, DYN);
          break;
        }
        default:
          fenceOrDropOptionKey(
            lowerer,
            prop,
            key,
            api,
            bi.module === "https" ? HTTPS_AGENT_DOCUMENTED_OPTIONS : AGENT_DOCUMENTED_OPTIONS,
            bi.module === "https"
              ? "keepAlive, keepAliveMsecs, maxSockets, maxFreeSockets, timeout, port, and scheduling are the supported options; pass TLS options such as ca and rejectUnauthorized on each https.request"
              : "keepAlive, keepAliveMsecs, maxSockets, maxFreeSockets, timeout, port, and scheduling are the supported options",
          );
      }
    }
  }
  return {
    kind: "libCall",
    fn: "http.agentNew",
    args: [
      boolLit(bi.module === "https", loc),
      keepAlive,
      kaMsecs,
      maxSockets,
      maxFree,
      timeout,
      port,
      scheduling,
    ],
    type: DYN,
    loc,
  };
}

export function lowerHttpServerNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const callee = expr.expression;
  const isHttpServer =
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "Server" &&
      lowerer.builtinMemberOf(callee)?.module === "http") ||
    (ts.isIdentifier(callee) &&
      lowerer.builtinImportOf(callee)?.module === "http" &&
      lowerer.builtinImportOf(callee)?.member === "Server");
  if (!isHttpServer) return null;
  return lowerHttpCreateServerForms(lowerer, expr, "new http.Server", locOf(expr));
}

/** `new tls.TLSSocket(socket, options)` in server mode: a new TLS socket
 * takes over the socket's connection and runs the server handshake
 * (scr_tls_wrap_socket). The options record reads at runtime, the
 * tls.connect precedent. A literal's secureContext member is a
 * SecureContext handle, which the checked-dynamic record cannot hold, so
 * it passes as its own argument; members after it must be free of side
 * effects, because it is read after them. Node never starts the handshake
 * of a client-mode TLSSocket, so a literal without isServer: true fences
 * here. */
export function lowerTlsSocketNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const callee = expr.expression;
  const isTlsSocket =
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "TLSSocket" &&
      lowerer.builtinMemberOf(callee)?.module === "tls") ||
    (ts.isIdentifier(callee) &&
      lowerer.builtinImportOf(callee)?.module === "tls" &&
      lowerer.builtinImportOf(callee)?.member === "TLSSocket");
  if (!isTlsSocket) return null;
  const loc = locOf(expr);
  const HINT =
    "the supported forms are new tls.TLSSocket(socket, { isServer: true, cert, key }) and new tls.TLSSocket(socket, { isServer: true, secureContext })";
  const args = expr.arguments?.nodes ?? [];
  if (args.length !== 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`new tls.TLSSocket with ${args.length} argument(s)`, expr, HINT);
  }
  const socket = lowerer.lowerExpr(args[0]!);
  if (socket.type.kind !== "netSocket") {
    lowerer.noLowering(
      `new tls.TLSSocket over a '${lowerer.fmt(socket.type)}' value`,
      args[0]!,
      "the wrapped value must be a net.Socket (a server connection or an http CONNECT socket)",
    );
  }
  let optsNode: ts.Expression = args[1]!;
  while (ts.isParenthesizedExpression(optsNode)) optsNode = optsNode.expression;
  if (!ts.isObjectLiteralExpression(optsNode)) {
    const o = lowerer.lowerExpr(optsNode);
    const opts: IrExpr =
      o.type.kind === "dyn"
        ? o
        : canConvertToDyn(
              o.type,
              (id) => lowerer.shapes.get(id),
              (id) => lowerer.unions.get(id),
            )
          ? { kind: "dynFrom", value: o, type: DYN, loc }
          : lowerer.noLowering(
              `new tls.TLSSocket with a '${lowerer.fmt(o.type)}' options record`,
              optsNode,
              `${HINT} — a secureContext member lowers in an options object literal`,
            );
    return { kind: "libCall", fn: "tls.wrapSocket", args: [socket, opts], type: NETSOCKET_T, loc };
  }
  const props = optsNode.properties.nodes;
  const nameOf = (p: ts.ObjectLiteralElementLike): string | null =>
    (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
    (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
      ? p.name.text
      : null;
  const isServer = props.find((p) => nameOf(p) === "isServer");
  if (
    isServer === undefined ||
    (ts.isPropertyAssignment(isServer) && isServer.initializer.kind === ts.SyntaxKind.FalseKeyword)
  ) {
    lowerer.noLowering(
      "new tls.TLSSocket in client mode",
      optsNode,
      "Node starts no handshake for a client-mode TLSSocket — pass isServer: true for the server side; tls.connect makes client sockets",
    );
  }
  const ctxIndex = props.findIndex((p) => nameOf(p) === "secureContext");
  if (ctxIndex < 0) {
    const opts = lowerDynObjectLiteral(lowerer, optsNode);
    return { kind: "libCall", fn: "tls.wrapSocket", args: [socket, opts], type: NETSOCKET_T, loc };
  }
  const ctxProp = props[ctxIndex]!;
  const ctxNode = ts.isShorthandPropertyAssignment(ctxProp)
    ? ctxProp.name
    : (ctxProp as ts.PropertyAssignment).initializer;
  for (const p of props.slice(ctxIndex + 1)) {
    const pure =
      ts.isShorthandPropertyAssignment(p) ||
      (ts.isPropertyAssignment(p) && sideEffectFreeOptionValue(p.initializer));
    if (!pure) {
      lowerer.noLowering(
        "a new tls.TLSSocket options literal with side effects after secureContext",
        p,
        "secureContext is read after the other members — move it to the end of the object",
      );
    }
  }
  let ctx: IrExpr | null = null;
  const opts = lowerDynObjectLiteral(lowerer, optsNode, (node, value) => {
    if (node !== ctxNode) return lowerer.coerceToExpected(value, DYN);
    if (value.type.kind !== "secureCtx") {
      lowerer.noLowering(
        `a '${lowerer.fmt(value.type)}' secureContext`,
        node,
        "pass a tls.createSecureContext({ cert, key }) result",
      );
    }
    ctx = value;
    return {
      kind: "dynFrom",
      value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
      type: DYN,
      loc,
    };
  });
  return {
    kind: "libCall",
    fn: "tls.wrapSocketCtx",
    args: [socket, opts, ctx!],
    type: NETSOCKET_T,
    loc,
  };
}

/** Module-function calls on http import bindings: createServer([options][,
 * handler]) and the call-form Server (Node's constructor works without
 * `new` — test/parallel's http.Server(fn) spelling). The handler takes
 * (req, res), (req), or () — runtime adapters bridge each shape.
 * Everything else the module declares fences qualified. */
function lowerHttpModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr {
  if (bi.member === "validateHeaderName") {
    requireStatementPosition(lowerer, expr, "http.validateHeaderName(...)");
    if (
      expr.arguments.nodes.length < 1 ||
      expr.arguments.nodes.length > 2 ||
      expr.arguments.nodes.some(ts.isSpreadElement)
    ) {
      lowerer.noLowering(
        "http.validateHeaderName arguments",
        expr,
        "pass a header name and an optional label",
      );
    }
    const name = lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, STRING);
    const label =
      expr.arguments.nodes.length === 2
        ? lowerer.lowerExprExpecting(expr.arguments.nodes[1]!, STRING)
        : strLit("Header name", loc);
    return { kind: "libCall", fn: "http.validateHeaderName", args: [name, label], type: VOID, loc };
  }
  if (bi.member === "validateHeaderValue") {
    requireStatementPosition(lowerer, expr, "http.validateHeaderValue(...)");
    if (expr.arguments.nodes.length !== 2 || expr.arguments.nodes.some(ts.isSpreadElement)) {
      lowerer.noLowering(
        "http.validateHeaderValue arguments",
        expr,
        "pass a header name and a value",
      );
    }
    const name = lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, STRING);
    const value = lowerer.lowerExprExpecting(expr.arguments.nodes[1]!, DYN);
    return {
      kind: "libCall",
      fn: "http.validateHeaderValue",
      args: [name, value],
      type: VOID,
      loc,
    };
  }
  if (bi.member === "createServer" || bi.member === "Server") {
    return lowerHttpCreateServerForms(lowerer, expr, `http.${bi.member}`, loc);
  }
  if (bi.member === "request" || bi.member === "get") {
    return lowerHttpClientCall(lowerer, expr, bi.member, loc);
  }
  lowerer.noLowering(
    `http.${bi.member}`,
    expr,
    "createServer, Server, request, get, validateHeaderName, and validateHeaderValue are the lowered http module functions",
    lowerer.resolveValueSymbol(expr.expression as ts.Identifier),
  );
}

/** The cert/key PEM option of tls.createServer / https.createServer: an
 * OBJECT LITERAL whose lowered `cert` and `key` entries are strings or
 * Buffers (fs.readFileSync either way — portless reads Buffers) — a
 * runtime-valued (dyn) entry rides the tls.pemDyn extraction, throwing
 * the fence at runtime for non-PEM kinds (the divergence-66 stance).
 * Every other key fences by name; SNICallback gets the pointed hint. */
function lowerTlsServerOptions(
  lowerer: Lowerer,
  node: ts.Expression,
  what: string,
  allowSni = false,
): { cert: IrExpr; key: IrExpr; sni?: IrExpr } {
  if (!ts.isObjectLiteralExpression(node)) {
    lowerer.noLowering(
      `${what} with a non-literal options argument`,
      node,
      "pass the options as an object literal: { cert, key }",
    );
  }
  const loc = locOf(node);
  let cert: IrExpr | null = null;
  let key: IrExpr | null = null;
  let sni: IrExpr | undefined;
  let pendingSni: IrStmt | null = null;
  for (const prop of node.properties.nodes) {
    let initializer: ts.Expression | null;
    if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    ) {
      initializer = prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      initializer = null;
    } else {
      lowerer.noLowering(
        `${what} options with computed keys or spreads`,
        prop,
        "each option must be a plain `name: value` (or shorthand) entry with a literal key",
      );
    }
    const k = (prop.name as ts.Identifier | ts.StringLiteral).text;
    if (k === "SNICallback" && allowSni) {
      const value =
        initializer !== null
          ? lowerer.lowerExpr(initializer)
          : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
      const checked = checkSniCallbackValue(lowerer, value, prop, what);
      if (cert !== null && key !== null) {
        sni = checked;
      } else {
        // The runtime call reads cert and key first. A cert or key entry
        // after the callback can change the binding the callback reads,
        // so the callback is saved ahead of the next of them, in source
        // order.
        const saved = lowerer.declareHiddenLocal("%sniCallback", checked.type);
        pendingSni = { kind: "varDecl", localId: saved.id, init: checked, loc: locOf(prop) };
        sni = varRef(saved.id, checked.type, locOf(prop));
      }
      continue;
    }
    if (k !== "cert" && k !== "key") {
      const init = ts.isPropertyAssignment(prop) ? prop.initializer : null;
      if (k === "rejectUnauthorized" && (init === null || sideEffectFreeOptionValue(init))) {
        // Without requestCert (a literal with requestCert or ca rides the
        // runtime walk) rejectUnauthorized gates nothing — droppable, like
        // the runtime walk's split (effectful values keep the fence).
        continue;
      }
      fenceOrDropOptionKey(
        lowerer,
        prop,
        k,
        what,
        TLS_SERVER_DOCUMENTED_OPTIONS,
        "cert and key (PEM strings or Buffers) are the supported options",
        {
          SNICallback:
            "SNICallback lowers on tls.createServer and http2.createSecureServer({ allowHTTP1: true, ... }) — serve one cert/key pair here",
        },
      );
      continue; // an undocumented key, dropped like Node drops it
    }
    let v =
      initializer !== null
        ? lowerer.lowerExpr(initializer)
        : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
    const isArrayOfPem =
      v.type.kind === "array" &&
      (v.type.elem.kind === "string" ||
        (v.type.elem.kind === "bytes" && v.type.elem.elem === "u8"));
    if (v.type.kind === "dyn" || isArrayOfPem) {
      // A runtime PEM value (fixtures.readKey(...) — the suite's shape) or
      // the one-element-array multi-context spelling: the runtime
      // extraction accepts strings/Buffers (and one-element arrays of
      // those) and throws the catchable fence otherwise.
      v = {
        kind: "libCall",
        fn: "tls.pemDyn",
        args: [
          v.type.kind === "dyn" ? v : { kind: "dynFrom", value: v, type: DYN, loc },
          { kind: "strLit", value: `a ${what} '${k}' option`, type: STRING, loc },
        ],
        type: BYTES_U8,
        loc,
      };
    } else if (v.type.kind !== "string" && !(v.type.kind === "bytes" && v.type.elem === "u8")) {
      lowerer.noLowering(
        `a ${what} '${k}' option of '${lowerer.fmt(v.type)}' values`,
        prop,
        "cert/key are PEM strings or Buffers here",
      );
    }
    if (pendingSni !== null) {
      v = { kind: "seqExpr", stmts: [pendingSni], result: v, type: v.type, loc };
      pendingSni = null;
    }
    if (k === "cert") cert = v;
    else key = v;
  }
  if (cert === null || key === null) {
    lowerer.noLowering(
      `${what} without both cert and key`,
      node,
      "the supported options object is { cert, key } (PEM strings or Buffers)",
    );
  }
  return sni === undefined ? { cert, key } : { cert, key, sni };
}

/** The options argument of tls/https createServer, split three ways: an
 * object literal takes the static walk above; a RUNTIME (dyn) value — the
 * checked-dynamic JS lane's record — passes whole to the runtime walk
 * (scr_tls_srv_opts_walk: same member split, fences thrown at runtime,
 * the divergence-66 stance); anything else keeps the compile fence. */
/** The option keys whose Node argument contracts the runtime walker
 * validates (scr_tls_opts_validate) — a literal carrying any of them
 * rides WHOLE to the walker so the typed ladders run in Node's order
 * (the static walk would fence them before validating). */
const TLS_VALIDATED_OPTIONS: ReadonlySet<string> = new Set([
  "ciphers",
  "passphrase",
  "ecdhCurve",
  "sessionIdContext",
  "clientCertEngine",
  "privateKeyEngine",
  "privateKeyIdentifier",
  "minVersion",
  "maxVersion",
  "handshakeTimeout",
  "keepAliveInitialDelay",
  "sessionTimeout",
  "ticketKeys",
]);

/** True when a literal options bag must ride the runtime walker: JS uses
 * it for the typed TLS validation ladders, HTTPS uses it for
 * keepAliveTimeoutBuffer so the HTTP option is consumed without losing
 * the literal's evaluation order, and `runtimeKeys` names options only the
 * runtime walk implements (tls.createServer's ALPNProtocols). */
function tlsLiteralNeedsRuntimeWalk(
  node: ts.ObjectLiteralExpression,
  includeHttpTimeoutOptions = false,
  runtimeKeys: ReadonlySet<string> = new Set(),
): boolean {
  const jsSource = isJsSourceFile(ts.getSourceFileOfNode(node));
  return node.properties.nodes.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      ((includeHttpTimeoutOptions && p.name.text === "keepAliveTimeoutBuffer") ||
        runtimeKeys.has(p.name.text) ||
        (jsSource && TLS_VALIDATED_OPTIONS.has(p.name.text))),
  );
}

/** The client-certificate options (requestCert, and ca, which also
 * completes the server's own chain): the runtime walk implements them for
 * tls.createServer and https.createServer, and the literal cert/key
 * lowering does not. */
const TLS_CLIENT_AUTH_OPTIONS: ReadonlySet<string> = new Set(["requestCert", "ca"]);

/** tls.createServer options the runtime walk implements and the literal
 * cert/key lowering does not. */
const TLS_SERVER_RUNTIME_OPTIONS: ReadonlySet<string> = new Set([
  "ALPNProtocols",
  "minVersion",
  "maxVersion",
  ...TLS_CLIENT_AUTH_OPTIONS,
]);

function lowerTlsServerOptionsOrDyn(
  lowerer: Lowerer,
  node: ts.Expression,
  what: string,
  includeHttpTimeoutOptions = false,
  runtimeKeys: ReadonlySet<string> = new Set(),
  allowSni = false,
): { cert: IrExpr; key: IrExpr; sni?: IrExpr; dyn?: undefined } | { dyn: IrExpr } {
  if (ts.isObjectLiteralExpression(node)) {
    if (!tlsLiteralNeedsRuntimeWalk(node, includeHttpTimeoutOptions, runtimeKeys))
      return lowerTlsServerOptions(lowerer, node, what, allowSni);
    const sniOption = node.properties.nodes.find(
      (p) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === "SNICallback",
    );
    if (allowSni && sniOption !== undefined) {
      lowerer.noLowering(
        `${what} with SNICallback and options the runtime walk reads`,
        sniOption,
        "SNICallback lowers with cert and key; ALPNProtocols, minVersion, maxVersion, requestCert, ca and the validated options are not combined with it yet",
      );
    }
  }
  const v = lowerer.lowerExpr(node);
  if (v.type.kind === "dyn") return { dyn: v };
  // A typed options RECORD binding (`const options = { key, cert, ... };
  // createServer(options)` — the Node-suite spelling): box it into the
  // dyn and hand the whole record to the runtime walk (the divergence-66
  // stance — members read at runtime, out-of-bounds ones throw the
  // catchable fence, undefined/undocumented ones drop). canConvertToDyn
  // now folds in the bytes-bearing option records the walker can box.
  if (
    canConvertToDyn(
      v.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    return { dyn: { kind: "dynFrom", value: v, type: DYN, loc: locOf(node) } };
  }
  lowerer.noLowering(
    `${what} with a non-literal options argument`,
    node,
    "pass the options as an object literal: { cert, key }",
  );
}

/** tls.connect — the TLS client socket. The lowered forms are
 * connect(options[, cb]) and connect(port[, host][, options][, cb]) with
 * a RUNTIME options record (the checked-dynamic JS lane's shape — a dyn
 * value, or a record that converts): the runtime walk implements
 * port/host/socket/rejectUnauthorized/ca/cert/key/servername/ALPNProtocols/minVersion/maxVersion/timeout and throws the catchable
 * fence for other documented members (the divergence-66 stance). The
 * callback (and 'secureConnect'/'connect' listeners) fires
 * post-handshake — Node's secureConnect timing. */
function lowerTlsConnectCall(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  const args = expr.arguments.nodes;
  const FORMS_HINT =
    "the supported forms are connect(options[, cb]) and connect(port[, host][, options][, cb]) — options implement port/host/socket/rejectUnauthorized/ca/cert/key/servername/ALPNProtocols/minVersion/maxVersion/timeout";
  if (args.length < 1 || args.length > 4 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`tls.connect with ${args.length} arguments`, expr, FORMS_HINT);
  }
  const isFuncish = (a: ts.Expression): boolean =>
    ts.isFunctionExpression(a) ||
    ts.isArrowFunction(a) ||
    lowerer.checker.getCallSignatures(lowerer.typeOf(a)).length > 0;
  const isObjectish = (a: ts.Expression): boolean => {
    if (ts.isObjectLiteralExpression(a)) return true;
    if (isFuncish(a) || ts.isStringLiteralLike(a) || ts.isNumericLiteral(a)) return false;
    const t = lowerer.typeOf(a);
    return (t.flags & ts.TypeFlags.Object) !== 0;
  };

  let port: IrExpr = numLit(-1, loc); // -1: the runtime reads options.port
  let host: IrExpr = { kind: "strLit", value: "", type: STRING, loc }; // "": options.host / localhost
  let optsNode: ts.Expression | null = null;
  let i = 0;
  if (isObjectish(args[0]!)) {
    optsNode = args[0]!;
    i = 1;
  } else if (isFuncish(args[0]!)) {
    lowerer.noLowering("tls.connect with a callback-first argument shape", expr, FORMS_HINT);
  } else {
    const p = lowerer.lowerExpr(args[0]!);
    if (p.type.kind === "f64") port = p;
    else if (p.type.kind === "dyn") port = { kind: "dynCheck", value: p, type: F64, loc };
    else
      lowerer.noLowering(`tls.connect with a '${lowerer.fmt(p.type)}' port`, args[0]!, FORMS_HINT);
    i = 1;
    if (i < args.length && !isFuncish(args[i]!) && !isObjectish(args[i]!)) {
      const h = lowerer.lowerExpr(args[i]!);
      if (h.type.kind === "string") host = h;
      else if (h.type.kind === "dyn") host = { kind: "dynCheck", value: h, type: STRING, loc };
      else
        lowerer.noLowering(
          `tls.connect with a '${lowerer.fmt(h.type)}' host`,
          args[i]!,
          FORMS_HINT,
        );
      i++;
    }
    if (i < args.length && isObjectish(args[i]!)) {
      optsNode = args[i]!;
      i++;
    }
  }
  // The options value rides whole to the runtime walk: dyn passes
  // directly; a typed record that converts boxes into the checked-dynamic tree.
  let opts: IrExpr;
  let literal: ts.Expression | null = optsNode;
  while (literal !== null && ts.isParenthesizedExpression(literal)) literal = literal.expression;
  if (
    literal !== null &&
    ts.isObjectLiteralExpression(literal) &&
    literal.properties.nodes.some(
      (p) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        ts.isIdentifier(p.name) &&
        p.name.text === "socket",
    )
  ) {
    // A socket member is a handle the record form cannot box: the literal
    // builds the checked-dynamic object member by member.
    opts = lowerDynObjectLiteral(lowerer, literal);
  } else if (optsNode !== null) {
    const o = lowerer.lowerExpr(optsNode);
    if (o.type.kind === "dyn") {
      opts = o;
    } else if (
      canConvertToDyn(
        o.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      opts = { kind: "dynFrom", value: o, type: DYN, loc };
    } else {
      lowerer.noLowering(
        `tls.connect with a '${lowerer.fmt(o.type)}' options record`,
        optsNode,
        FORMS_HINT,
      );
    }
  } else {
    if (port.kind === "numLit" && port.value === -1) {
      lowerer.noLowering("tls.connect without a port or options", expr, FORMS_HINT);
    }
    // No options: Node's defaults (rejectUnauthorized: true) — the
    // runtime walk reads an absent record (the dyn undefined).
    opts = dynUndefinedExpr(loc);
  }
  let cb: IrExpr | null = null;
  if (i < args.length) {
    if (i !== args.length - 1 || !isFuncish(args[i]!)) {
      lowerer.noLowering("tls.connect with this argument shape", expr, FORMS_HINT);
    }
    const r = lowerCallbackArg(
      lowerer,
      args[i]!,
      "secureConnect listeners",
      0,
      () => false,
      "use ()",
      [],
    );
    cb = r.cb;
  }
  return cb !== null
    ? { kind: "libCall", fn: "tls.connectCb", args: [port, host, opts, cb], type: NETSOCKET_T, loc }
    : { kind: "libCall", fn: "tls.connect", args: [port, host, opts], type: NETSOCKET_T, loc };
}

/** Module-function calls on tls import bindings: createServer(options[,
 * secureConnectionListener]) — the listener fires post-handshake with a
 * socket that behaves exactly like a net socket. Everything else the
 * module declares fences qualified (createSecureContext and connect
 * carry pointed hints from the fence-hint table). */
function lowerTlsModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr {
  const args = expr.arguments.nodes;
  if (bi.member === "createServer") {
    if (args.length < 1 || args.length > 2) {
      lowerer.noLowering(
        `createServer with ${args.length} arguments`,
        expr,
        "the supported form is createServer({ cert, key }, socket => ...)",
      );
    }
    const opts = lowerTlsServerOptionsOrDyn(
      lowerer,
      args[0]!,
      "tls.createServer",
      false,
      TLS_SERVER_RUNTIME_OPTIONS,
      true,
    );
    if (args.length === 1) {
      if (opts.dyn !== undefined)
        return {
          kind: "libCall",
          fn: "tls.createServerDyn",
          args: [opts.dyn],
          type: NETSERVER_T,
          loc,
        };
      return opts.sni !== undefined
        ? {
            kind: "libCall",
            fn: "tls.createServerSni",
            args: [opts.cert, opts.key, opts.sni],
            type: NETSERVER_T,
            loc,
          }
        : {
            kind: "libCall",
            fn: "tls.createServer",
            args: [opts.cert, opts.key],
            type: NETSERVER_T,
            loc,
          };
    }
    const { cb } = lowerCallbackArg(
      lowerer,
      args[1]!,
      "secureConnection listeners",
      1,
      (p) => p.kind === "netSocket",
      "use (socket) or ()",
      [NETSOCKET_T],
    );
    if (opts.dyn !== undefined)
      return {
        kind: "libCall",
        fn: "tls.createServerDynCb",
        args: [opts.dyn, cb],
        type: NETSERVER_T,
        loc,
      };
    return opts.sni !== undefined
      ? {
          kind: "libCall",
          fn: "tls.createServerSniCb",
          args: [opts.cert, opts.key, opts.sni, cb],
          type: NETSERVER_T,
          loc,
        }
      : {
          kind: "libCall",
          fn: "tls.createServerCb",
          args: [opts.cert, opts.key, cb],
          type: NETSERVER_T,
          loc,
        };
  }
  if (bi.member === "connect") {
    return lowerTlsConnectCall(lowerer, expr, loc);
  }
  if (
    bi.member === "getCACertificates" &&
    args.length === 1 &&
    !args.some(ts.isSpreadElement) &&
    isJsSourceFile(ts.getSourceFileOfNode(expr))
  ) {
    // The type-argument ladder (validateString + the documented name
    // set); the real CA list has no lowering, so a valid name meets the
    // compiler-rendered fence after the validation.
    const raw = lowerer.lowerExpr(args[0]!);
    if (raw.type.kind === "dyn" || raw.kind === "unitLit" || lowerer.dynConvertible(raw.type)) {
      const t: IrExpr =
        raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
      return {
        kind: "libCall",
        fn: "tls.caCertsChk",
        args: [t, ladderFenceExpr(lowerer, "tls.getCACertificates", expr)],
        type: lowerer.mapTypeOf(lowerer.typeOf(expr)) ?? DYN,
        loc,
      };
    }
  }
  if (bi.member === "createSecureContext") {
    // createSecureContext({ cert, key }) → the opaque SecureContext handle
    // an SNI callback answers with. The minimal honest form: exactly the
    // cert/key pair (PEM strings or Buffers — the createServer options
    // walk, reused); ca/ciphers/etc. fence by name there.
    if (args.length !== 1) {
      lowerer.noLowering(
        `createSecureContext with ${args.length} arguments`,
        expr,
        "the supported form is createSecureContext({ cert, key })",
      );
    }
    const opts = lowerTlsServerOptionsOrDyn(
      lowerer,
      args[0]!,
      "tls.createSecureContext",
      false,
      TLS_CLIENT_AUTH_OPTIONS,
    );
    if (opts.dyn !== undefined) {
      return {
        kind: "libCall",
        fn: "tls.createSecureContextDyn",
        args: [opts.dyn],
        type: SECURECTX_T,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: "tls.createSecureContext",
      args: [opts.cert, opts.key],
      type: SECURECTX_T,
      loc,
    };
  }
  // The CA-store introspection pair (scr_tls_ca.c — its own link gate, no
  // mbedTLS): getCACertificates(type?) answers the per-type cached PEM
  // string array (an omitted type completes to "default", Node's own
  // default; unknown strings throw Node's ERR_INVALID_ARG_VALUE at
  // runtime), and setDefaultCACertificates(certs) replaces the default
  // set and the client trust anchors. rootCertificates is a VALUE read —
  // lowerTlsRootCertificates below.
  if (bi.member === "getCACertificates") {
    if (args.length > 1) {
      lowerer.noLowering(`getCACertificates with ${args.length} arguments`, expr);
    }
    const typeArg: IrExpr =
      args.length === 1
        ? lowerer.lowerExprExpecting(args[0]!, STRING)
        : { kind: "strLit", value: "default", type: STRING, loc };
    return { kind: "libCall", fn: "tlsca.get", args: [typeArg], type: arrayOf(STRING), loc };
  }
  if (bi.member === "setDefaultCACertificates") {
    if (args.length !== 1) {
      lowerer.noLowering(`setDefaultCACertificates with ${args.length} arguments`, expr);
    }
    const certs = lowerer.lowerExpr(args[0]!);
    if (certs.type.kind !== "array" || certs.type.elem.kind !== "string") {
      lowerer.noLowering(
        `setDefaultCACertificates of a '${lowerer.fmt(certs.type)}' value`,
        args[0]!,
        "a string[] of PEM certificates is the lowered shape — decode Buffer/typed-array entries to strings first",
      );
    }
    return { kind: "libCall", fn: "tlsca.set", args: [certs], type: VOID, loc };
  }
  lowerer.noLowering(
    `tls.${bi.member}`,
    expr,
    builtinFenceHintOf("tls", bi.member) ??
      "createServer({ cert, key }, handler) and createSecureContext({ cert, key }) are the lowered tls module functions",
    lowerer.resolveValueSymbol(expr.expression as ts.Identifier),
  );
}

/** The tls.rootCertificates VALUE read (any import spelling): the same
 * cached array getCACertificates("bundled") answers — Node's own
 * equality (test-tls-get-ca-certificates-bundled pins certs ===
 * rootCertificates). Null for other members (the property chains keep
 * trying). */
export function lowerTlsRootCertificates(
  lowerer: Lowerer,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module !== "tls" || bi.member !== "rootCertificates") return null;
  return { kind: "libCall", fn: "tlsca.root", args: [], type: arrayOf(STRING), loc };
}

/** The `const requestFn = tls ? https.request : http.request` binding —
 * the module-function-as-value ternary between the two known clients
 * (the static-callable projection registry's cousin, keyed per Lowerer pass).
 * The declaration binds nothing; calls THROUGH the binding lower as the
 * runtime-secure client (lowerHttpClientCall's binding mode), and the
 * recorded condition re-evaluates at each call site — sound because the
 * recognizer admits only a bare identifier over a never-reassigned
 * binding (a pure, stable read). */
export interface HttpClientFnBinding {
  cond: ts.Expression;
  /** true when the ternary's TRUE arm is the https client. */
  trueSecure: boolean;
  member: "request" | "get";
}

export function httpClientFnBindingOf(
  lowerer: Lowerer,
  sym: ts.Symbol,
): HttpClientFnBinding | undefined {
  return lowerer.httpClientFnBindings.get(sym);
}

/** The { module, member } of an http/https client-function REFERENCE
 * (`https.request` through a namespace import, or a named `request`
 * import binding) — null for anything else. */
function clientFnRefOf(
  lowerer: Lowerer,
  node: ts.Expression,
): { module: "http" | "https"; member: "request" | "get" } | null {
  const e = node;
  const bi = ts.isPropertyAccessExpression(e)
    ? lowerer.builtinMemberOf(e)
    : ts.isIdentifier(e)
      ? lowerer.builtinImportOf(e)
      : null;
  if (!bi) return null;
  if (
    (bi.module !== "http" && bi.module !== "https") ||
    (bi.member !== "request" && bi.member !== "get")
  ) {
    return null;
  }
  return { module: bi.module, member: bi.member };
}

/** True when `sym`'s binding is never written after initialization: a
 * `const` declaration, or a parameter/let whose enclosing scope contains
 * no assignment or ++/-- targeting it. */
function neverReassigned(lowerer: Lowerer, sym: ts.Symbol): boolean {
  const decl = sym.declarations[0];
  if (!decl) return false;
  if (
    ts.isVariableDeclaration(decl) &&
    (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0
  ) {
    return true;
  }
  if (!ts.isParameter(decl) && !ts.isVariableDeclaration(decl)) return false;
  // The declaring scope: the nearest enclosing function-like body, or the
  // source file for module-level bindings. Writes anywhere inside
  // (nested closures included) disqualify.
  let scope: ts.Node = decl;
  while (
    scope.parent !== undefined &&
    !ts.isFunctionLike(scope.parent) &&
    !ts.isSourceFile(scope.parent)
  )
    scope = scope.parent;
  const root = scope.parent;
  if (root === undefined) return false;
  let written = false;
  const hitsSym = (n: ts.Node): boolean => {
    if (ts.isIdentifier(n) && lowerer.checker.getSymbolAtLocation(n) === sym) return true;
    let hit = false;
    ts.forEachChild(n, (c) => {
      if (!hit) hit = hitsSym(c);
    });
    return hit;
  };
  const visit = (n: ts.Node): void => {
    if (written) return;
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      const isAssign = k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
      // The whole LEFT side scans (destructuring targets included).
      if (isAssign && hitsSym(n.left)) {
        written = true;
        return;
      }
    }
    if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken ||
        n.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(n.operand) &&
      lowerer.checker.getSymbolAtLocation(n.operand) === sym
    ) {
      written = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return !written;
}

/** Recognizes `const x = cond ? <client A> : <client B>` where A and B
 * are the SAME member (request/get) of https and http (either order) —
 * registers the binding (calls lower; the declaration itself binds
 * nothing) and answers true. A matched ternary whose condition is not a
 * stable identifier fences pointedly; non-client ternaries answer false
 * (the ordinary decl path and its per-arm fences apply). */
export function registerHttpClientFnBinding(
  lowerer: Lowerer,
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): boolean {
  if (!init) return false;
  let e: ts.Expression = init;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isConditionalExpression(e)) return false;
  const unwrap = (a: ts.Expression): ts.Expression => {
    let x = a;
    while (ts.isParenthesizedExpression(x)) x = x.expression;
    return x;
  };
  const t = clientFnRefOf(lowerer, unwrap(e.whenTrue));
  const f = clientFnRefOf(lowerer, unwrap(e.whenFalse));
  if (!t || !f) return false;
  if (t.member !== f.member || t.module === f.module) {
    lowerer.noLowering(
      "a conditional between these two client functions",
      e,
      "the lowered shape is `cond ? https.request : http.request` (or the .get pair, either order) — the same member of both modules",
    );
  }
  const cond = unwrap(e.condition);
  const condSym = ts.isIdentifier(cond) ? lowerer.resolveValueSymbol(cond) : null;
  if (!condSym || !neverReassigned(lowerer, condSym)) {
    lowerer.noLowering(
      "a client-function conditional with this condition shape",
      e.condition,
      "the condition must be a bare identifier whose binding is never reassigned (it re-evaluates at each call through the binding)",
    );
  }
  const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
  if (symbol) {
    lowerer.httpClientFnBindings.set(symbol, {
      cond,
      trueSecure: t.module === "https",
      member: t.member,
    });
  }
  return true;
}

/** A call THROUGH a registered requestFn binding: the http client
 * lowering with the RUNTIME-secure extras (the binding mode). */
export function lowerHttpClientFnCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  binding: HttpClientFnBinding,
  loc: SrcLoc,
): IrExpr {
  return lowerHttpClientCall(lowerer, expr, binding.member, loc, binding);
}

/** Module-function calls on https import bindings: createServer(options,
 * handler) and request/get — the http client lowering with the secure
 * extras (port 443 default, rejectUnauthorized, ca). */
function lowerHttpsModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr {
  const args = expr.arguments.nodes;
  if (bi.member === "createServer") {
    if (args.length < 1 || args.length > 2) {
      lowerer.noLowering(
        `createServer with ${args.length} arguments`,
        expr,
        "the supported form is createServer({ cert, key }, (req, res) => ...)",
      );
    }
    const opts = lowerTlsServerOptionsOrDyn(
      lowerer,
      args[0]!,
      "https.createServer",
      true,
      TLS_CLIENT_AUTH_OPTIONS,
    );
    if (args.length === 1) {
      // The handler-less form: 'request' listeners arrive later via
      // server.on("request", ...) — the createSecureServer emission's
      // NULL-handler shape, here for the runtime-options record only
      // (the literal path keeps its historical two-argument surface).
      if (opts.dyn !== undefined) {
        return {
          kind: "libCall",
          fn: "https.createServerDyn",
          args: [opts.dyn],
          type: NETSERVER_T,
          loc,
        };
      }
      lowerer.noLowering(
        "createServer with 1 arguments",
        expr,
        "the supported form is createServer({ cert, key }, (req, res) => ...)",
      );
    }
    const cb = lowerRequestHandlerArg(lowerer, args[1]!);
    return opts.dyn !== undefined
      ? {
          kind: "libCall",
          fn: "https.createServerDynCb",
          args: [opts.dyn, cb],
          type: NETSERVER_T,
          loc,
        }
      : {
          kind: "libCall",
          fn: "https.createServer",
          args: [opts.cert, opts.key, cb],
          type: NETSERVER_T,
          loc,
        };
  }
  if (bi.member === "request" || bi.member === "get") {
    return lowerHttpClientCall(lowerer, expr, bi.member, loc, true);
  }
  lowerer.noLowering(
    `https.${bi.member}`,
    expr,
    "createServer, request, and get are the lowered https module functions",
    lowerer.resolveValueSymbol(expr.expression as ts.Identifier),
  );
}

/** The h2 SESSION-tuning options of http2.createSecureServer. This slice
 * runs most at their defaults, so they are accepted and ignored only with
 * literal values; settings.enableConnectProtocol is parsed explicitly
 * below because it changes the wire protocol and CONNECT dispatch. */
const HTTP2_IGNORED_TUNING_OPTIONS: ReadonlySet<string> = new Set([
  "streamResetBurst",
  "streamResetRate",
  "maxSessionMemory",
  "maxDeflateDynamicTableSize",
  "maxSettings",
  "maxHeaderListPairs",
  "maxOutstandingPings",
  "maxSendHeaderBlockLength",
  "paddingStrategy",
  "peerMaxConcurrentStreams",
  "settings",
]);

const SNI_HINT =
  "SNICallback lowers as a direct option or the conditional spread " +
  "...(x ? { SNICallback: x } : {}) — the callback is (servername, cb) => void " +
  "with cb: (err: Error | null, ctx?: tls.SecureContext) => void";

/** An SNICallback option value: (servername: string, cb) => void where cb
 * is (err: Error | null, ctx?: SecureContext) => void, or that function
 * unioned with undefined (no callback). cb may declare fewer params (the
 * emitted answer thunk matches its ABI), but what it does declare must
 * carry the arms the thunk decodes. */
function lowerSniCallbackValue(
  lowerer: Lowerer,
  node: ts.Expression,
  blame: ts.Node,
  what: string,
): IrExpr {
  return checkSniCallbackValue(lowerer, lowerer.lowerExpr(node), blame, what);
}

function checkSniCallbackValue(lowerer: Lowerer, v: IrExpr, blame: ts.Node, what: string): IrExpr {
  const shapeOk = (t: IrType): boolean => {
    if (t.kind !== "func" || t.ret.kind !== "void" || t.params.length !== 2) return false;
    if (t.params[0]!.kind !== "string") return false;
    const cbT = t.params[1]!;
    if (cbT.kind !== "func" || cbT.ret.kind !== "void" || cbT.params.length > 2) return false;
    const armKinds = (u: IrType): string[] =>
      u.kind === "union" ? (lowerer.unions.get(u.unionId)?.arms ?? []).map((a) => a.kind) : [];
    const p0 = cbT.params[0];
    if (p0 !== undefined && !armKinds(p0).includes("nullT")) return false;
    const p1 = cbT.params[1];
    if (p1 !== undefined && !armKinds(p1).includes("secureCtx")) return false;
    return true;
  };
  const arms = v.type.kind === "union" ? (lowerer.unions.get(v.type.unionId)?.arms ?? []) : [];
  const funcArm = v.type.kind === "func" ? v.type : arms.find((a) => a.kind === "func");
  const unionOk =
    v.type.kind !== "union" || (arms.length === 2 && arms.some((a) => a.kind === "undefinedT"));
  if (funcArm === undefined || !unionOk || !shapeOk(funcArm)) {
    lowerer.noLowering(`a ${what} SNICallback of '${lowerer.fmt(v.type)}' values`, blame, SNI_HINT);
  }
  return v;
}

/** Strips parentheses and type assertions: the portless spelling wraps
 * an options spread as `...({ ... } as Record<string, unknown>)`. */
function stripParensAndCasts(node: ts.Expression): ts.Expression {
  let e = node;
  for (;;) {
    if (ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isAsExpression(e) || ts.isTypeAssertion(e)) e = e.expression;
    else return e;
  }
}

/** Module-function calls on http2 import bindings. createServer lowers h2c;
 * createSecureServer lowers h2 over TLS, with allowHTTP1 selecting one
 * dual-ALPN server whose request/connect listeners mirror across parsers. */
function lowerHttp2ModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr {
  const args = expr.arguments.nodes;
  if (bi.member === "createServer") {
    // The REAL h2c server (scr_http2.c). An options object literal is
    // accepted and ignored (h2 session-tuning knobs; the honest-defaults
    // stance) — a NON-literal options argument or an eager (req, res)
    // handler is NOT the lowered shape (register via server.on("stream")).
    let handlerNode: ts.Expression | null = null;
    for (const a of args) {
      if (ts.isObjectLiteralExpression(a)) continue; // tuning options: ignored
      if (ts.isFunctionExpression(a) || ts.isArrowFunction(a)) {
        handlerNode = a;
        continue;
      }
      // A function-typed OR dyn argument is the eager compat handler
      // (`createServer(common.mustCall(handler))` — the suite's shape);
      // anything else is a tuning-options VALUE — accepted and never
      // evaluated (h2 knobs this core runs at defaults; the options
      // expression is a pure read in every suite shape).
      const t = lowerer.typeOf(a);
      if (
        lowerer.checker.getCallSignatures(t).length > 0 ||
        (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
      ) {
        handlerNode = a;
      }
    }
    if (handlerNode === null) {
      return { kind: "libCall", fn: "http2.createServer", args: [], type: NETSERVER_T, loc };
    }
    // An eager (req, res) handler is the COMPAT surface: the handler
    // becomes the first 'request' listener (Node's exact route), and the
    // pair it receives ARE the http req/res handles — Http2ServerRequest/
    // Http2ServerResponse over h2 streams (scr_http2.c's compat layer).
    const cb = lowerRequestHandlerArg(lowerer, handlerNode);
    return { kind: "libCall", fn: "http2.createServerReq", args: [cb], type: NETSERVER_T, loc };
  }
  if (bi.member === "connect") {
    // http2.connect(authority[, listener]) — the h2c client. The
    // authority is a string (URL objects and an options record fence).
    if (args.length < 1 || args.length > 3) {
      lowerer.noLowering(
        `http2.connect with ${args.length} arguments`,
        expr,
        "the supported form is connect(authority[, options][, listener]) with a string authority",
      );
    }
    const auth = lowerer.lowerExpr(args[0]!);
    if (auth.type.kind !== "string") {
      lowerer.noLowering(
        `http2.connect with a '${lowerer.fmt(auth.type)}' authority`,
        args[0]!,
        'the authority is a string here ("http://host:port")',
      );
    }
    // connect(authority, options[, listener]): session-tuning options
    // are accepted and never evaluated (the core runs at defaults) —
    // EXCEPT createConnection (a transport change: fence) and the TLS
    // client knobs an https authority reads: rejectUnauthorized (a
    // literal bool) and ca (a PEM string/Buffer — runtime values ride
    // the pemDyn extraction). On an http authority both are inert,
    // exactly Node. A DYN second argument is the LISTENER
    // (`connect(url, mustCall(cb))`, the suite's shape — options arrive
    // as object literals); the dyn flavor adapts through the checked
    // function boundary below.
    let listenerNode: ts.Expression | undefined = args[1];
    let reject: IrExpr = { kind: "boolLit", value: true, type: BOOL, loc };
    let ca: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
    const arg1IsDyn =
      args.length >= 2 &&
      (lowerer.typeOf(args[1]!).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    if (
      args.length >= 2 &&
      !arg1IsDyn &&
      lowerer.checker.getCallSignatures(lowerer.typeOf(args[1]!)).length === 0
    ) {
      if (ts.isObjectLiteralExpression(args[1]!)) {
        for (const pr of (args[1] as ts.ObjectLiteralExpression).properties.nodes) {
          // Plain `name: value` and shorthand `{ ca }` both carry the
          // option; a shorthand's value is the same-named identifier.
          let name: string;
          let valueNode: ts.Expression;
          if (ts.isPropertyAssignment(pr) && ts.isIdentifier(pr.name)) {
            name = pr.name.text;
            valueNode = pr.initializer;
          } else if (ts.isShorthandPropertyAssignment(pr)) {
            name = (pr.name as ts.Identifier).text;
            valueNode = pr.name as ts.Identifier;
          } else {
            continue;
          }
          if (name === "createConnection") {
            lowerer.noLowering(
              "http2.connect with a createConnection option",
              args[1]!,
              "custom transports are not modeled — connect dials TCP itself",
            );
          }
          if (name === "rejectUnauthorized") {
            if (valueNode.kind === ts.SyntaxKind.FalseKeyword) {
              reject = { kind: "boolLit", value: false, type: BOOL, loc };
            } else if (valueNode.kind !== ts.SyntaxKind.TrueKeyword) {
              lowerer.noLowering(
                "http2.connect with a non-literal rejectUnauthorized option",
                pr,
                "spell it true or false — it gates the https authority's certificate verification",
              );
            }
          }
          if (name === "ca") {
            const v = lowerer.lowerExpr(valueNode);
            if (v.type.kind === "string" || (v.type.kind === "bytes" && v.type.elem === "u8")) {
              ca = v;
            } else if (v.type.kind === "dyn") {
              ca = {
                kind: "libCall",
                fn: "tls.pemDyn",
                args: [
                  v,
                  { kind: "strLit", value: "an http2.connect 'ca' option", type: STRING, loc },
                ],
                type: BYTES_U8,
                loc,
              };
            } else {
              lowerer.noLowering(
                `an http2.connect 'ca' option of '${lowerer.fmt(v.type)}' values`,
                pr,
                "ca is a PEM string or Buffer here",
              );
            }
          }
        }
      }
      listenerNode = args[2];
    } else if (args.length === 3) {
      listenerNode = args[2];
    }
    if (listenerNode !== undefined) {
      // The listener is the 'connect' once-listener: (session, socket) or
      // fewer. Its result is ignored (voidized); handles pass by ref.
      const { cb } = lowerCallbackArg(
        lowerer,
        listenerNode,
        "connect listeners",
        2,
        (p) => p.kind === "http2Session" || p.kind === "netSocket",
        "use (session, socket), (session), or ()",
        [HTTP2SESSION_T, NETSOCKET_T],
      );
      return {
        kind: "libCall",
        fn: "http2.connectCb",
        args: [auth, reject, ca, cb],
        type: HTTP2SESSION_T,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: "http2.connect",
      args: [auth, reject, ca],
      type: HTTP2SESSION_T,
      loc,
    };
  }
  if (bi.member === "getDefaultSettings") {
    // The constant defaults record, as a dyn value (the d.ts types it
    // `any` — reads ride the checked-dynamic keyed read).
    return { kind: "libCall", fn: "http2.getDefaultSettings", args: [], type: DYN, loc };
  }
  if (bi.member === "createSecureServer") {
    if (args.length < 1 || args.length > 2) {
      lowerer.noLowering(
        `createSecureServer with ${args.length} arguments`,
        expr,
        "the supported forms are createSecureServer(options[, onRequestHandler]) with options { allowHTTP1?, cert, key }",
      );
    }
    const optsNode = args[0]!;
    // The eager (req, res) handler — Node routes it as the first
    // 'request' listener; both flavors' compat layers serve it (the
    // allowHTTP1 server's HTTP/1.1 handles, the h2 server's compat
    // handles over streams).
    const handlerNode = args.length === 2 ? args[1]! : null;
    if (!ts.isObjectLiteralExpression(optsNode)) {
      // The RUNTIME options record (the divergence-66 stance, the
      // tls/https.createServerDyn precedent): allowHTTP1/cert/key read
      // at runtime, out-of-bounds TLS members throw the catchable
      // runtime fence, h2 session-tuning keys drop exactly like the
      // literal walk ignores them.
      const v = lowerer.lowerExpr(optsNode);
      let dynOpts: IrExpr;
      if (v.type.kind === "dyn") {
        dynOpts = v;
      } else if (
        canConvertToDyn(
          v.type,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      ) {
        dynOpts = { kind: "dynFrom", value: v, type: DYN, loc: locOf(optsNode) };
      } else {
        lowerer.noLowering(
          "createSecureServer with a non-literal options argument",
          optsNode,
          "pass the options as an object literal ({ allowHTTP1: true, cert, key }) or a runtime record of those members",
        );
      }
      if (handlerNode === null) {
        return {
          kind: "libCall",
          fn: "http2.createSecureServerDyn",
          args: [dynOpts],
          type: NETSERVER_T,
          loc,
        };
      }
      const cb = lowerRequestHandlerArg(lowerer, handlerNode);
      return {
        kind: "libCall",
        fn: "http2.createSecureServerDynCb",
        args: [dynOpts, cb],
        type: NETSERVER_T,
        loc,
      };
    }
    let cert: IrExpr | null = null;
    let key: IrExpr | null = null;
    let sni: IrExpr | null = null;
    let allowHttp1 = false;
    let enableConnectProtocol = false;
    const lowerSniValue = (node: ts.Expression, blame: ts.Node): void => {
      sni = lowerSniCallbackValue(lowerer, node, blame, "createSecureServer");
    };
    const lowerOption = (prop: ts.ObjectLiteralElementLike): void => {
      if (ts.isSpreadAssignment(prop)) {
        // Spreads of INLINE object literals (parens/as-casts stripped —
        // the `...({ streamResetBurst: 10000 } as Record<string,
        // unknown>)` spelling) flatten into the same option walk. The
        // CONDITIONAL spread `...(x ? { SNICallback: x } : {})` — the
        // portless proxy shape — lowers as the SNICallback | undefined
        // union: the spread includes the option exactly when x is truthy,
        // and a func | undefined union is truthy exactly on its func arm,
        // so passing the union (undefined arm = no callback) is the same
        // semantics — PROVIDED the included value IS the condition, which
        // the text check pins. Any other spread operand is opaque to the
        // static walk.
        const inner = stripParensAndCasts(prop.expression);
        if (ts.isConditionalExpression(inner)) {
          const whenTrue = stripParensAndCasts(inner.whenTrue);
          const whenFalse = stripParensAndCasts(inner.whenFalse);
          const condText = ts.getTextOfNode(inner.condition);
          const ok =
            ts.isObjectLiteralExpression(whenTrue) &&
            ts.isObjectLiteralExpression(whenFalse) &&
            whenFalse.properties.nodes.length === 0 &&
            whenTrue.properties.nodes.length === 1 &&
            ts.isPropertyAssignment(whenTrue.properties.nodes[0]!) &&
            (ts.isIdentifier(whenTrue.properties.nodes[0]!.name) ||
              ts.isStringLiteral(whenTrue.properties.nodes[0]!.name)) &&
            (whenTrue.properties.nodes[0]!.name as ts.Identifier | ts.StringLiteral).text ===
              "SNICallback" &&
            ts.getTextOfNode(whenTrue.properties.nodes[0]!.initializer) === condText;
          if (!ok) {
            lowerer.noLowering(
              "createSecureServer options with a conditional spread",
              prop,
              "the lowered conditional spread is exactly ...(x ? { SNICallback: x } : {}) — the included value must BE the condition",
            );
          }
          lowerSniValue(inner.condition, prop);
          return;
        }
        if (!ts.isObjectLiteralExpression(inner)) {
          lowerer.noLowering(
            "createSecureServer options with a computed spread",
            prop,
            `spreads must be inline object literals here; ${SNI_HINT}`,
          );
        }
        for (const p of inner.properties.nodes) lowerOption(p);
        return;
      }
      let initializer: ts.Expression | null;
      if (
        ts.isPropertyAssignment(prop) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
      ) {
        initializer = prop.initializer;
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        initializer = null;
      } else {
        lowerer.noLowering(
          "createSecureServer options with computed keys",
          prop,
          "each option must be a plain `name: value` (or shorthand) entry with a literal key",
        );
      }
      const k = (prop.name as ts.Identifier | ts.StringLiteral).text;
      if (k === "allowHTTP1") {
        // A literal true or false: true selects the dual h2/http1 server;
        // false IS the absent default — the h2-only ALPN server below. A runtime
        // value would pick a protocol stack dynamically — fence.
        if (initializer !== null && initializer.kind === ts.SyntaxKind.FalseKeyword) return;
        if (initializer === null || initializer.kind !== ts.SyntaxKind.TrueKeyword) {
          lowerer.noLowering(
            "createSecureServer with a non-literal allowHTTP1 option",
            prop,
            "allowHTTP1 picks the protocol stack (true: dual h2/http1; false/absent: ALPN=h2 only) — spell it as a literal",
          );
        }
        allowHttp1 = true;
        return;
      }
      if (k === "cert" || k === "key") {
        let v =
          initializer !== null
            ? lowerer.lowerExpr(initializer)
            : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
        if (v.type.kind === "dyn") {
          // A runtime PEM value (fixtures.readKey(...)): the tls walk's
          // runtime extraction, same fences at runtime.
          v = {
            kind: "libCall",
            fn: "tls.pemDyn",
            args: [
              v,
              { kind: "strLit", value: `a createSecureServer '${k}' option`, type: STRING, loc },
            ],
            type: BYTES_U8,
            loc,
          };
        } else if (v.type.kind !== "string" && !(v.type.kind === "bytes" && v.type.elem === "u8")) {
          lowerer.noLowering(
            `a createSecureServer '${k}' option of '${lowerer.fmt(v.type)}' values`,
            prop,
            "cert/key are PEM strings or Buffers here",
          );
        }
        if (k === "cert") cert = v;
        else key = v;
        return;
      }
      if (HTTP2_IGNORED_TUNING_OPTIONS.has(k)) {
        // Ignored, literals only (see the set's comment). `settings` takes
        // a NESTED literal of literals (`settings: { enableConnectProtocol:
        // true }` — the portless RFC 8441 advertisement): every member is
        // itself inert h2-session state, so the same no-observable-skip
        // argument covers the one level of nesting.
        const isScalarLiteral = (e: ts.Expression): boolean =>
          ts.isNumericLiteral(e) ||
          ts.isStringLiteralLike(e) ||
          e.kind === ts.SyntaxKind.TrueKeyword ||
          e.kind === ts.SyntaxKind.FalseKeyword;
        const isLiteralObjectOfLiterals = (e: ts.Expression): boolean =>
          ts.isObjectLiteralExpression(e) &&
          e.properties.nodes.every(
            (p) =>
              ts.isPropertyAssignment(p) &&
              ts.isIdentifier(p.name) &&
              isScalarLiteral(p.initializer),
          );
        if (k === "settings" && initializer !== null && ts.isObjectLiteralExpression(initializer)) {
          for (const setting of initializer.properties.nodes) {
            if (
              ts.isPropertyAssignment(setting) &&
              ts.isIdentifier(setting.name) &&
              setting.name.text === "enableConnectProtocol"
            ) {
              if (
                setting.initializer.kind !== ts.SyntaxKind.TrueKeyword &&
                setting.initializer.kind !== ts.SyntaxKind.FalseKeyword
              ) {
                lowerer.noLowering(
                  "settings.enableConnectProtocol with a non-boolean literal",
                  setting,
                  "spell enableConnectProtocol as true or false",
                );
              }
              enableConnectProtocol = setting.initializer.kind === ts.SyntaxKind.TrueKeyword;
            }
          }
        }
        if (
          initializer !== null &&
          (isScalarLiteral(initializer) || isLiteralObjectOfLiterals(initializer))
        ) {
          return;
        }
        lowerer.noLowering(
          `createSecureServer option '${k}' with a non-literal value`,
          prop,
          "h2 session-tuning options are accepted with literal values but are not applied yet",
        );
      }
      if (k === "SNICallback") {
        if (initializer === null) {
          lowerer.noLowering(
            "createSecureServer with a shorthand SNICallback option",
            prop,
            "spell it out: SNICallback: theCallback",
          );
        }
        lowerSniValue(initializer, prop);
        return;
      }
      fenceOrDropOptionKey(
        lowerer,
        prop,
        k,
        "createSecureServer",
        HTTP2_SECURE_SERVER_DOCUMENTED_OPTIONS,
        "allowHTTP1: true, cert, key, and SNICallback are the supported options (h2 session-tuning options are accepted as literals and ignored)",
      );
      // An undocumented key, dropped like Node drops it.
    };
    for (const prop of optsNode.properties.nodes) lowerOption(prop);
    if (cert === null || key === null) {
      lowerer.noLowering(
        "createSecureServer without both cert and key",
        optsNode,
        "the supported options object is { allowHTTP1?, cert, key } (PEM strings or Buffers)",
      );
    }
    if (sni !== null && handlerNode !== null) {
      lowerer.noLowering(
        "createSecureServer with both an SNICallback and an eager handler",
        expr,
        'register the handler separately: server.on("request", (req, res) => ...)',
      );
    }
    if (!allowHttp1) {
      // The REAL h2-over-TLS server (scr_http2.c + scr_tls.c): ALPN
      // advertises h2 alone and the h2 session attaches at establishment
      // — 'stream'/'session' listeners, exactly the h2c server's surface.
      // SNI callbacks are an https-path feature; the h2 stack serves one
      // cert/key pair.
      if (sni !== null) {
        lowerer.noLowering(
          "createSecureServer with an SNICallback and no allowHTTP1",
          optsNode,
          "SNICallback lowers on the dual allowHTTP1 server — the h2-only server serves one cert/key pair",
        );
      }
      if (handlerNode !== null) {
        const cb = lowerRequestHandlerArg(lowerer, handlerNode);
        return {
          kind: "libCall",
          fn: "http2.createSecureServerH2Req",
          args: [cert, key, cb, boolLit(enableConnectProtocol, loc)],
          type: NETSERVER_T,
          loc,
        };
      }
      return {
        kind: "libCall",
        fn: "http2.createSecureServerH2",
        args: [cert, key, boolLit(enableConnectProtocol, loc)],
        type: NETSERVER_T,
        loc,
      };
    }
    if (sni !== null) {
      return {
        kind: "libCall",
        fn: "http2.createSecureServerSni",
        args: [cert, key, sni, boolLit(enableConnectProtocol, loc)],
        type: NETSERVER_T,
        loc,
      };
    }
    if (handlerNode !== null) {
      const cb = lowerRequestHandlerArg(lowerer, handlerNode);
      return {
        kind: "libCall",
        fn: "http2.createSecureServerReq",
        args: [cert, key, cb, boolLit(enableConnectProtocol, loc)],
        type: NETSERVER_T,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: "http2.createSecureServer",
      args: [cert, key, boolLit(enableConnectProtocol, loc)],
      type: NETSERVER_T,
      loc,
    };
  }
  lowerer.noLowering(
    `http2.${bi.member}`,
    expr,
    builtinFenceHintOf("http2", bi.member) ??
      "createSecureServer({ allowHTTP1: true, cert, key }) and the h2-only form are lowered",
    lowerer.resolveValueSymbol(expr.expression as ts.Identifier),
  );
}

/** The checked-dynamic options value of a request whose options the
 * runtime reads: a non-literal options value (a RequestOptions variable —
 * checked-dynamic storage — or a record that converts to one), or a
 * literal the static walk cannot lower because it spreads another options
 * value or sets socketPath. Null keeps the static literal walk (and its
 * fences), which every other literal takes unchanged. */
function runtimeRequestOptions(
  lowerer: Lowerer,
  optsNode: ts.Expression,
  secureish: boolean,
): IrExpr | null {
  if (ts.isObjectLiteralExpression(optsNode)) {
    const needsRuntime = optsNode.properties.nodes.some((prop) => {
      if (ts.isSpreadAssignment(prop)) {
        // the static walk's one spread: `...(c ? { rejectUnauthorized } : {})` on https
        const cs = conditionalSpreadOf(prop.expression);
        return !(
          secureish &&
          cs !== null &&
          cs !== "unsupported" &&
          cs.props.length === 1 &&
          cs.props[0]!.name.text === "rejectUnauthorized"
        );
      }
      return (
        (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
        (prop.name.text === "socketPath" ||
          // a client certificate: the runtime request walk reads cert and key
          (secureish && (prop.name.text === "cert" || prop.name.text === "key")))
      );
    });
    if (!needsRuntime) return null;
    return lowerDynObjectLiteral(lowerer, optsNode);
  }
  const t = lowerer.mapTypeOf(lowerer.typeOf(optsNode));
  if (!t || !(t.kind === "dyn" || (t.kind === "record" && lowerer.dynConvertible(t)))) return null;
  return lowerer.coerceToExpected(lowerer.lowerExpr(optsNode), DYN);
}

/** http.request(options[, cb]) / http.get(options[, cb]) — the client.
 * The options argument must be an OBJECT LITERAL; the lowered keys are
 * hostname/host, port, path, method, timeout, and headers (a nested
 * object literal with string values, or any Record whose values are
 * strings / `string | undefined` — the env.pairs shape). Every other key
 * fences by name. The callback registers as once('response'); get() is
 * request() plus the eager end(). A URL-STRING first argument takes the
 * requestUrl row instead (both schemes; see below). `secure` is the https
 * spelling: port defaults to 443 and the rejectUnauthorized (boolean)
 * and ca (PEM string/Buffer) options join the lowered set. A
 * HttpClientFnBinding as `secure` is the requestFn-binding mode: whether
 * the dial is TLS is a RUNTIME bool (the binding's condition, re-lowered
 * per use — a pure identifier read), the port default follows it (443 /
 * 80), the https extras stay lowered (the plain arm ignores them at
 * runtime, exactly Node's http.request with TLS options), and the one
 * supported options SPREAD is the conditional `...(c ? {
 * rejectUnauthorized: <bool> } : {})` (either orientation) — the
 * portless isProxyRunning shape. */
function lowerHttpClientCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: "request" | "get",
  loc: SrcLoc,
  secure: boolean | HttpClientFnBinding = false,
): IrExpr {
  const binding = typeof secure === "object" ? secure : null;
  const secureish = binding !== null || secure === true;
  /** A FRESH lowering of the binding's secure condition (pure identifier
   * read — each use is its own IR). */
  const secureExpr = (): IrExpr => {
    const c = lowerer.lowerCondition(binding!.cond);
    return binding!.trueSecure ? c : { kind: "unary", op: "!", operand: c, type: BOOL, loc };
  };
  const args = expr.arguments.nodes;
  if (args.length < 1 || args.length > 2) {
    lowerer.noLowering(
      `${member} with ${args.length} arguments`,
      expr,
      `the supported form is ${member}(options[, callback])`,
    );
  }
  const optsNode = args[0]!;
  const runtimeOptions =
    binding === null ? runtimeRequestOptions(lowerer, optsNode, secureish) : null;
  if (runtimeOptions !== null) {
    // The options record is read at run time (the ClientRequest
    // constructor's walk in the runtime): a RequestOptions variable, or a
    // literal that spreads one or sets socketPath.
    const autoEnd = boolLit(member === "get", loc);
    const secureDyn = secure === true;
    if (args.length === 1) {
      return {
        kind: "libCall",
        fn: secureDyn ? "https.requestDyn" : "http.requestDyn",
        args: [runtimeOptions, autoEnd],
        type: HTTPCLIENTREQ_T,
        loc,
      };
    }
    const { cb } = lowerCallbackArg(
      lowerer,
      args[1]!,
      "response callbacks",
      1,
      (p) => p.kind === "httpReq",
      "use (res) or ()",
      [HTTPREQ_T],
    );
    return {
      kind: "libCall",
      fn: secureDyn ? "https.requestDynCb" : "http.requestDynCb",
      args: [runtimeOptions, autoEnd, cb],
      type: HTTPCLIENTREQ_T,
      loc,
    };
  }
  if (!ts.isObjectLiteralExpression(optsNode)) {
    const t = lowerer.mapTypeOf(lowerer.typeOf(optsNode));
    if ((t?.kind === "string" || t?.kind === "url") && binding === null) {
      // The URL-string form — http.get(`http://127.0.0.1:${port}/x`[, cb])
      // and its https spelling: the runtime parses through the WHATWG unit
      // and dials; unparsable inputs and a scheme that is not the calling
      // module's throw catchably (may-throw seed). No options means Node's
      // defaults, which for https is verification against the default
      // trust anchors. The requestFn binding has no URL row — whether the
      // dial is TLS is only known at runtime there, and the two schemes
      // reject each other's URLs.
      // A URL OBJECT is its href through the same parse — Node's own
      // reading of the argument, and the serialization round-trips.
      const url: IrExpr =
        t.kind === "url"
          ? {
              kind: "libCall",
              fn: "url.href",
              args: [lowerer.lowerExpr(optsNode)],
              type: STRING,
              loc,
            }
          : lowerer.lowerExprExpecting(optsNode, STRING);
      const methodLit: IrExpr = { kind: "strLit", value: "GET", type: STRING, loc };
      const autoEnd = boolLit(member === "get", loc);
      const isTls = secure === true;
      if (args.length === 1) {
        const fn = isTls ? ("https.requestUrl" as const) : ("http.requestUrl" as const);
        return { kind: "libCall", fn, args: [url, methodLit, autoEnd], type: HTTPCLIENTREQ_T, loc };
      }
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "response callbacks",
        1,
        (p) => p.kind === "httpReq",
        "use (res) or ()",
        [HTTPREQ_T],
      );
      const fn = isTls ? ("https.requestUrlCb" as const) : ("http.requestUrlCb" as const);
      return {
        kind: "libCall",
        fn,
        args: [url, methodLit, autoEnd, cb],
        type: HTTPCLIENTREQ_T,
        loc,
      };
    }
    lowerer.noLowering(
      t?.kind === "string"
        ? `a URL-string first argument through a request-function binding`
        : `${member} with a non-literal options argument`,
      optsNode,
      t?.kind === "string"
        ? // Only the binding mode reaches here now: the scheme would have to
          // agree with a dial chosen at runtime.
          "call http.request / https.request directly for the URL-string form, or pass the options as an object literal"
        : "pass the options as an object literal: { hostname, port, path, method, timeout?, headers? }",
    );
  }
  let host: IrExpr | null = null;
  let port: IrExpr | null = null;
  let path: IrExpr | null = null;
  let method: IrExpr | null = null;
  let timeout: IrExpr | null = null;
  let headers: IrExpr | null = null;
  let reject: IrExpr | null = null;
  let ca: IrExpr | null = null;
  let connCb: IrExpr | null = null;
  /** agent: false — inject Connection: close into the request head. */
  let agentClose: ts.Node | null = null;
  /** agent: <Agent value> — the requestAgent rows thread the handle. */
  let agentVal: IrExpr | null = null;
  /** signal: an AbortSignal (checked at runtime) that destroys the request. */
  let signal: IrExpr | null = null;
  /** servername: the TLS name for SNI and certificate verification. */
  let servername: IrExpr | null = null;
  /** maxHeaderSize: the response head's size bound. */
  let maxHeaderSize: IrExpr | null = null;
  for (const prop of optsNode.properties.nodes) {
    // Shorthand entries ({ port } for { port: port }) are the natural
    // spelling at these call sites — the shorthand's VALUE lowering
    // resolves the local binding (lowerShorthandValue), not the property
    // symbol.
    // The conditional-spread idiom `...(c ? { rejectUnauthorized: <bool>
    // } : {})` (either orientation) — the portless isProxyRunning shape:
    // the option applies exactly when c holds, and Node's default (true,
    // verify) is what the empty arm leaves in place, so the value lowers
    // as one ternary over c. Only the https-capable modes accept it (the
    // plain client has no TLS layer to configure).
    if (ts.isSpreadAssignment(prop)) {
      const cs = conditionalSpreadOf(prop.expression);
      if (
        cs !== null &&
        cs !== "unsupported" &&
        cs.props.length === 1 &&
        cs.props[0]!.name.text === "rejectUnauthorized" &&
        ts.isPropertyAssignment(cs.props[0]!) &&
        secureish
      ) {
        const cond = lowerer.lowerCondition(cs.cond);
        const v = lowerer.lowerExpr((cs.props[0] as ts.PropertyAssignment).initializer);
        if (v.type.kind !== "bool") {
          lowerer.noLowering(
            `a ${member} 'rejectUnauthorized' option of '${lowerer.fmt(v.type)}' values`,
            cs.props[0]!,
            "the option value must be a boolean",
          );
        }
        const dflt = boolLit(true, loc); /* Node's default: verify */
        reject = {
          kind: "ternary",
          cond,
          then: cs.whenTrue ? v : dflt,
          else_: cs.whenTrue ? dflt : v,
          type: BOOL,
          loc,
        };
        continue;
      }
      lowerer.noLowering(
        `${member} with this options spread`,
        prop,
        secureish
          ? "the one supported spread is the conditional `...(c ? { rejectUnauthorized: <bool> } : {})` (either orientation) — write other members inline"
          : "spreads have no lowering here — write each option inline",
      );
    }
    let initializer: ts.Expression | null;
    if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    ) {
      initializer = prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      initializer = null;
    } else {
      lowerer.noLowering(
        `${member} options with computed keys`,
        prop,
        "each option must be a plain `name: value` (or shorthand) entry with a literal key",
      );
    }
    const key = (prop.name as ts.Identifier | ts.StringLiteral).text;
    const lowerVal = (want: "string" | "f64"): IrExpr => {
      const v =
        initializer !== null
          ? lowerer.lowerExpr(initializer)
          : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
      // A checked-dynamic value (an untyped JS binding carrying the
      // port/path through a helper): dynCheck validates it into the
      // option's type — a mismatch is the catchable path-annotated
      // TypeError, the boundary's stance.
      if (v.type.kind === "dyn") {
        return {
          kind: "dynCheck",
          value: v,
          type: want === "string" ? STRING : F64,
          loc: locOf(prop),
        };
      }
      if (v.type.kind !== want) {
        lowerer.noLowering(
          `a ${member} '${key}' option of '${lowerer.fmt(v.type)}' values`,
          prop,
          want === "string"
            ? "the option value must be a string"
            : "the option value must be a number",
        );
      }
      return v;
    };
    switch (key) {
      case "hostname":
      case "host":
        host = lowerVal("string");
        break;
      case "port":
        port = lowerVal("f64");
        break;
      case "path":
        path = lowerVal("string");
        break;
      case "method":
        method = lowerVal("string");
        break;
      case "timeout":
        timeout = lowerVal("f64");
        break;
      case "maxHeaderSize":
        maxHeaderSize = lowerVal("f64");
        break;
      case "servername":
        if (binding !== null) {
          lowerer.noLowering(
            `${member} option 'servername' through a module-function binding`,
            prop,
            "call https.request directly when passing servername",
          );
        }
        if (!secureish) {
          lowerer.noLowering(
            `${member} option 'servername'`,
            prop,
            "servername is an https.request option — the plain http client has no TLS layer",
          );
        }
        servername = lowerVal("string");
        break;
      case "signal": {
        const v =
          initializer !== null
            ? lowerer.lowerExpr(initializer)
            : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
        signal = lowerer.coerceToExpected(v, DYN);
        break;
      }
      case "headers":
        if (initializer === null) {
          lowerer.noLowering(
            `${member} with a shorthand headers option`,
            prop,
            "spell it out: headers: theHeaders",
          );
        }
        headers = lowerClientHeadersOption(lowerer, initializer);
        break;
      case "createConnection": {
        // The caller's own dialer: a `() => net.Socket` closure the
        // runtime invokes once, synchronously (the proxy's loopback
        // dial). https keeps the fence — the TLS client owns its socket —
        // and the binding mode inherits it (its https arm would).
        if (secureish) {
          lowerer.noLowering(
            `${member} with a createConnection option`,
            prop,
            "the https client dials its own TLS socket — pass hostname/port",
          );
        }
        if (initializer === null) {
          lowerer.noLowering(
            `${member} with a shorthand createConnection option`,
            prop,
            "spell it out: createConnection: theDialer",
          );
        }
        const v = lowerer.lowerExpr(initializer);
        if (
          v.type.kind !== "func" ||
          v.type.params.length !== 0 ||
          v.type.ret.kind !== "netSocket"
        ) {
          lowerer.noLowering(
            `a ${member} 'createConnection' option of '${lowerer.fmt(v.type)}' values`,
            prop,
            "the dialer is () => net.Socket — no arguments, returning the socket to use",
          );
        }
        connCb = v;
        break;
      }
      case "rejectUnauthorized": {
        if (!secureish) {
          lowerer.noLowering(
            `${member} option 'rejectUnauthorized'`,
            prop,
            "rejectUnauthorized is an https.request option — the plain http client has no TLS layer",
          );
        }
        const v =
          initializer !== null
            ? lowerer.lowerExpr(initializer)
            : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
        if (v.type.kind !== "bool") {
          lowerer.noLowering(
            `a ${member} 'rejectUnauthorized' option of '${lowerer.fmt(v.type)}' values`,
            prop,
            "the option value must be a boolean",
          );
        }
        reject = v;
        break;
      }
      case "ca": {
        if (!secureish) {
          lowerer.noLowering(
            `${member} option 'ca'`,
            prop,
            "ca is an https.request option — the plain http client has no TLS layer",
          );
        }
        const v =
          initializer !== null
            ? lowerer.lowerExpr(initializer)
            : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
        if (v.type.kind !== "string" && !(v.type.kind === "bytes" && v.type.elem === "u8")) {
          lowerer.noLowering(
            `a ${member} 'ca' option of '${lowerer.fmt(v.type)}' values`,
            prop,
            "the ca is a PEM string or Buffer here",
          );
        }
        ca = v;
        break;
      }
      case "agent": {
        // Node's agent option. `false` asks for a one-shot dial with
        // Connection: close — exactly the compiled client's connection
        // model, so it LOWERS (the header injects below). null/undefined
        // pick the default agent, whose keep-alive request header the
        // compiled client already sends (socket REUSE stays the
        // documented divergence either way). An Agent VALUE (the lowered
        // `new http.Agent(...)` handle — a checked-dynamic value) threads
        // through the requestAgent rows: getName-keyed maxSockets
        // accounting over one-dial-per-request connections; a runtime
        // non-Agent value is Node's ERR_INVALID_ARG_TYPE.
        const e = initializer !== null ? stripParensAndCasts(initializer) : null;
        if (e !== null && e.kind === ts.SyntaxKind.FalseKeyword) {
          agentClose = prop;
          break;
        }
        if (
          e !== null &&
          (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined"))
        ) {
          break; // the default agent: what the agent-free call compiles
        }
        const v =
          initializer !== null
            ? lowerer.lowerExpr(initializer)
            : lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
        if (v.type.kind !== "dyn") {
          lowerer.noLowering(
            `a ${member} 'agent' option of '${lowerer.fmt(v.type)}' values`,
            prop,
            "the agent is the checked-dynamic Agent handle new http.Agent(...) answers " +
              "(or false / null / undefined)",
          );
        }
        agentVal = v;
        break;
      }
      default:
        fenceOrDropOptionKey(
          lowerer,
          prop,
          key,
          member,
          secureish ? HTTPS_CLIENT_DOCUMENTED_OPTIONS : HTTP_CLIENT_DOCUMENTED_OPTIONS,
          secureish
            ? "hostname/host, port, path, method, timeout, headers, agent, signal, maxHeaderSize, rejectUnauthorized, ca, and servername are the supported options"
            : "hostname/host, port, path, method, timeout, headers, agent, signal, and maxHeaderSize are the supported options",
        );
    }
  }
  if (agentClose !== null) {
    // agent: false → Node sends `Connection: close` (its one-shot Agent
    // sets the header) and tears the socket down with the response — the
    // compiled client already closes, so the header is the whole
    // lowering. A user-set connection header wins, Node's rule; a
    // non-literal headers record cannot be checked for one, so the combo
    // fences instead of double-sending.

    if (headers === null) {
      headers = {
        kind: "arrayLit",
        elems: [strLit("Connection", loc), strLit("close", loc)],
        type: arrayOf(STRING),
        loc,
      };
    } else if (headers.kind === "arrayLit") {
      const hasConnection = headers.elems.some(
        (el, i) => i % 2 === 0 && el.kind === "strLit" && el.value.toLowerCase() === "connection",
      );
      if (!hasConnection) {
        headers = {
          ...headers,
          elems: [...headers.elems, strLit("Connection", loc), strLit("close", loc)],
        };
      }
    } else {
      lowerer.noLowering(
        `${member} with agent: false and a non-literal headers record`,
        agentClose,
        "agent: false lowers by injecting Connection: close into a LITERAL headers object — " +
          'add connection: "close" to the record instead, or write the headers inline',
      );
    }
  }

  if (connCb !== null && (host !== null || port !== null)) {
    // Node would use host/port only for the Host header once a dialer
    // exists — a partial use with no warning; set headers.host instead.
    lowerer.noLowering(
      `${member} mixing createConnection with hostname/host/port`,
      optsNode,
      "the dialer supplies the socket — set the Host header via headers: { host: ... } instead",
    );
  }
  if (agentVal !== null && connCb !== null) {
    lowerer.noLowering(
      `${member} mixing an agent value with createConnection`,
      optsNode,
      "both own the dial — pass one or the other",
    );
  }
  if (agentVal !== null && binding !== null) {
    lowerer.noLowering(
      `${member} through a module-function binding with an agent value`,
      optsNode,
      "call http.request/https.request directly when passing an Agent",
    );
  }
  host ??= strLit("localhost", loc);
  // The binding mode's default port follows the runtime dial: 443 on the
  // TLS arm, 80 on the plain one — exactly each client's own default.
  // With an AGENT the sentinel -1 says "no port option": the runtime
  // consults the agent's (settable) defaultPort first, Node's merge.
  port ??=
    binding !== null
      ? {
          kind: "ternary",
          cond: secureExpr(),
          then: numLit(443, loc),
          else_: numLit(80, loc),
          type: F64,
          loc,
        }
      : agentVal !== null
        ? numLit(-1, loc)
        : numLit(secure === true ? 443 : 80, loc);
  path ??= strLit("/", loc);
  method ??= strLit("GET", loc);
  timeout ??= numLit(0, loc);
  headers ??= { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc };
  const autoEnd = boolLit(member === "get", loc);
  // options.signal is checked first: Node's constructor rejects a value
  // that is not an AbortSignal before it dials. servername is stored just
  // before construction (it selects the TLS name and which pooled sockets
  // the request may reuse); maxHeaderSize and the signal then apply to the
  // built request (an already aborted signal destroys it at once, like
  // Node's constructor).
  const withSignal = (request: IrExpr): IrExpr => {
    if (signal === null && servername === null && maxHeaderSize === null) return request;
    const local = lowerer.declareHiddenLocal("%requestOptions", HTTPCLIENTREQ_T);
    const ref = (): IrExpr => varRef(local.id, HTTPCLIENTREQ_T, loc);
    const steps: IrStmt[] = [];
    let signalRef: (() => IrExpr) | null = null;
    if (signal !== null) {
      const signalLocal = lowerer.declareHiddenLocal("%requestSignal", DYN);
      signalRef = () => varRef(signalLocal.id, DYN, loc);
      steps.push({ kind: "varDecl", localId: signalLocal.id, init: signal, loc });
      steps.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "http.clientSignalCheck",
          args: [signalRef()],
          type: VOID,
          loc,
        },
        loc,
      });
    }
    if (servername !== null) {
      steps.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "https.nextServername",
          args: [servername],
          type: VOID,
          loc,
        },
        loc,
      });
    }
    steps.push({ kind: "varDecl", localId: local.id, init: request, loc });
    if (maxHeaderSize !== null) {
      steps.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "http.clientMaxHeaderSize",
          args: [ref(), maxHeaderSize],
          type: VOID,
          loc,
        },
        loc,
      });
    }
    if (signalRef !== null) {
      steps.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "http.clientSignal",
          args: [ref(), signalRef()],
          type: VOID,
          loc,
        },
        loc,
      });
    }
    return { kind: "seqExpr", stmts: steps, result: ref(), type: HTTPCLIENTREQ_T, loc };
  };
  if (connCb !== null) {
    const base = [connCb, path, method, timeout, headers, autoEnd];
    if (args.length === 1) {
      return withSignal({
        kind: "libCall",
        fn: "http.requestConn",
        args: base,
        type: HTTPCLIENTREQ_T,
        loc,
      });
    }
    const { cb } = lowerCallbackArg(
      lowerer,
      args[1]!,
      "response callbacks",
      1,
      (p) => p.kind === "httpReq",
      "use (res) or ()",
      [HTTPREQ_T],
    );
    return withSignal({
      kind: "libCall",
      fn: "http.requestConnCb",
      args: [...base, cb],
      type: HTTPCLIENTREQ_T,
      loc,
    });
  }
  const base = [host, port, path, method, timeout, headers, autoEnd];
  if (secureish) {
    reject ??= boolLit(true, loc); /* Node's default: verify */
    ca ??= strLit("", loc); /* none: /etc/ssl/cert.pem stands in for Node's roots */
    base.push(reject, ca);
  }
  if (agentVal !== null) base.push(agentVal);
  if (binding !== null) base.unshift(secureExpr());
  if (args.length === 1) {
    const fn: IrLibFn =
      binding !== null
        ? "https.requestFn"
        : secure === true
          ? agentVal !== null
            ? "https.requestAgent"
            : "https.request"
          : agentVal !== null
            ? "http.requestAgent"
            : "http.request";
    return withSignal({ kind: "libCall", fn, args: base, type: HTTPCLIENTREQ_T, loc });
  }
  const { cb } = lowerCallbackArg(
    lowerer,
    args[1]!,
    "response callbacks",
    1,
    (p) => p.kind === "httpReq",
    "use (res) or ()",
    [HTTPREQ_T],
  );
  const fn: IrLibFn =
    binding !== null
      ? "https.requestFnCb"
      : secure === true
        ? agentVal !== null
          ? "https.requestAgentCb"
          : "https.requestCb"
        : agentVal !== null
          ? "http.requestAgentCb"
          : "http.requestCb";
  return withSignal({ kind: "libCall", fn, args: [...base, cb], type: HTTPCLIENTREQ_T, loc });
}

/** The headers option of http.request: an object literal with literal
 * keys and string values packs into the flat [k0, v0, k1, v1, ...] pairs
 * array directly; any other expression must be a Record whose values are
 * strings (or `string | undefined` — absent entries drop, the env-option
 * rule), flattened by the interned env.pairs helper. */
function lowerClientHeadersOption(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const loc = locOf(node);
  if (ts.isObjectLiteralExpression(node)) {
    const elems: IrExpr[] = [];
    for (const prop of node.properties.nodes) {
      const key = ts.isPropertyAssignment(prop) ? staticHeaderKeyOf(lowerer, prop) : null;
      if (!ts.isPropertyAssignment(prop) || key === null) {
        lowerer.noLowering(
          "request headers with dynamic keys, spreads, or shorthand entries",
          prop,
          "each header must be a `name: value` entry whose key is a literal (or a string-literal-typed const: [PORTLESS_HEADER])",
        );
      }
      let value = lowerer.lowerExpr(prop.initializer);
      if (value.type.kind === "f64") {
        // Node formats number values via String(n) — the same ToString.
        value = { kind: "toString", operand: value, type: STRING, loc };
      }
      if (value.type.kind !== "string") {
        lowerer.noLowering(
          `request header values of type '${lowerer.fmt(value.type)}'`,
          prop.initializer,
          "header values are strings or numbers here",
        );
      }
      elems.push({ kind: "strLit", value: key, type: STRING, loc });
      elems.push(value);
    }
    return { kind: "arrayLit", elems, type: arrayOf(STRING), loc };
  }
  const v = lowerer.lowerExpr(node);
  if (v.type.kind !== "record") {
    lowerer.noLowering(
      `request headers of '${lowerer.fmt(v.type)}' values`,
      node,
      "pass an object literal or a Record<string, string>",
    );
  }
  const helper = lowerer.envToPairsHelper(v.type.shapeId, loc);
  if (helper === null) {
    lowerer.noLowering(
      `request headers of '${lowerer.fmt(v.type)}' values`,
      node,
      "header values must be strings (or string | undefined)",
    );
  }
  return { kind: "call", callee: helper, args: [v], type: arrayOf(STRING), loc };
}

/** OutgoingMessage.addTrailers accepts an object or a pair-list literal.
 * Flatten the latter in source order; non-literal nested arrays currently
 * fence rather than reaching the C runtime with the wrong wire shape. */
function lowerHttpTrailersOption(lowerer: Lowerer, node: ts.Expression): IrExpr {
  if (!ts.isArrayLiteralExpression(node)) return lowerClientHeadersOption(lowerer, node);
  const loc = locOf(node);
  const flat: IrExpr[] = [];
  for (const entry of node.elements.nodes) {
    if (!ts.isArrayLiteralExpression(entry) || entry.elements.nodes.length !== 2) {
      lowerer.noLowering(
        "addTrailers pair list",
        entry,
        "use an object/Record or literal [name, value] pairs",
      );
    }
    const pair = entry as ts.ArrayLiteralExpression;
    const name = pair.elements.nodes[0]!;
    const value = pair.elements.nodes[1]!;
    if (ts.isSpreadElement(name) || ts.isSpreadElement(value)) {
      lowerer.noLowering(
        "addTrailers pair with spread",
        entry,
        "use direct string name/value expressions",
      );
    }
    flat.push(lowerer.lowerExprExpecting(name, STRING), lowerer.lowerExprExpecting(value, STRING));
  }
  return { kind: "arrayLit", elems: flat, type: arrayOf(STRING), loc };
}

/** Method calls on ClientRequest receivers: write/end/destroy and
 * on/once("response" | "error" | "timeout" | "close"). Null for other
 * receivers. */
function lowerHttpClientMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "httpClientReq") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if (name === "setHeader") {
    requireStatementPosition(lowerer, call, "request.setHeader(...)");
    if (args.length !== 2)
      lowerer.noLowering("request.setHeader arguments", call, "pass a name and string value");
    const receiver = coerceToHandle(lowerer, access.expression, HTTPCLIENTREQ_T);
    const header = lowerer.lowerExprExpecting(args[0]!, STRING);
    const value = lowerer.lowerExprExpecting(args[1]!, STRING);
    return {
      kind: "libCall",
      fn: "http.clientSetHeader",
      args: [receiver, header, value],
      type: VOID,
      loc,
    };
  }
  if (name === "getHeader" || name === "hasHeader" || name === "removeHeader") {
    if (name === "removeHeader")
      requireStatementPosition(lowerer, call, "request.removeHeader(...)");
    if (args.length !== 1)
      lowerer.noLowering(`request.${name} arguments`, call, `pass one header name`);
    const receiver = coerceToHandle(lowerer, access.expression, HTTPCLIENTREQ_T);
    const header = lowerer.lowerExprExpecting(args[0]!, STRING);
    const fn: IrLibFn =
      name === "getHeader"
        ? "http.clientGetHeader"
        : name === "hasHeader"
          ? "http.clientHasHeader"
          : "http.clientRemoveHeader";
    const type = name === "getHeader" ? lowerer.envValueType() : name === "hasHeader" ? BOOL : VOID;
    return { kind: "libCall", fn, args: [receiver, header], type, loc };
  }
  if (name === "getHeaderNames" || name === "getRawHeaderNames" || name === "getHeaders") {
    if (args.length !== 0)
      lowerer.noLowering(`request.${name} arguments`, call, `${name}() takes no arguments`);
    const receiver = coerceToHandle(lowerer, access.expression, HTTPCLIENTREQ_T);
    const fn: IrLibFn =
      name === "getHeaderNames"
        ? "http.clientGetHeaderNames"
        : name === "getRawHeaderNames"
          ? "http.clientGetRawHeaderNames"
          : "http.clientGetHeaders";
    return {
      kind: "libCall",
      fn,
      args: [receiver],
      type: name === "getHeaders" ? DYN : arrayOf(STRING),
      loc,
    };
  }
  if (name === "flushHeaders" || name === "cork" || name === "uncork") {
    requireStatementPosition(lowerer, call, `request.${name}()`);
    if (args.length !== 0)
      lowerer.noLowering(`request.${name} with arguments`, call, `${name}() takes no arguments`);
    const receiver = coerceToHandle(lowerer, access.expression, HTTPCLIENTREQ_T);
    const fn: IrLibFn =
      name === "flushHeaders"
        ? "http.clientFlushHeaders"
        : name === "cork"
          ? "http.clientCork"
          : "http.clientUncork";
    return { kind: "libCall", fn, args: [receiver], type: VOID, loc };
  }
  if (name === "setNoDelay") {
    requireStatementPosition(lowerer, call, "request.setNoDelay(...)");
    if (args.length > 1)
      lowerer.noLowering("request.setNoDelay arguments", call, "pass an optional boolean");
    const receiver = coerceToHandle(lowerer, access.expression, HTTPCLIENTREQ_T);
    const enable =
      args.length === 0 ? boolLit(true, loc) : lowerer.lowerExprExpecting(args[0]!, BOOL);
    return {
      kind: "libCall",
      fn: "http.clientSetNoDelay",
      args: [receiver, enable],
      type: VOID,
      loc,
    };
  }
  if (name === "setSocketKeepAlive") {
    requireStatementPosition(lowerer, call, "request.setSocketKeepAlive(...)");
    if (args.length > 2)
      lowerer.noLowering(
        "request.setSocketKeepAlive arguments",
        call,
        "pass an optional boolean and initial delay in milliseconds",
      );
    const receiver = coerceToHandle(lowerer, access.expression, HTTPCLIENTREQ_T);
    const enable =
      args.length === 0 ? boolLit(true, loc) : lowerer.lowerExprExpecting(args[0]!, BOOL);
    const delay = args.length < 2 ? numLit(0, loc) : lowerer.lowerExprExpecting(args[1]!, F64);
    return {
      kind: "libCall",
      fn: "http.clientSetSocketKeepAlive",
      args: [receiver, enable, delay],
      type: VOID,
      loc,
    };
  }
  if (name === "setTimeout") {
    if (args.length < 1 || args.length > 2)
      lowerer.noLowering(
        "request.setTimeout arguments",
        call,
        "pass milliseconds and an optional callback",
      );
    const receiver = coerceToHandle(lowerer, access.expression, HTTPCLIENTREQ_T);
    const ms = lowerer.lowerExprExpecting(args[0]!, F64);
    const cb =
      args.length === 2
        ? lowerCallbackArg(
            lowerer,
            args[1]!,
            "request timeout callbacks",
            0,
            () => false,
            "use ()",
            [],
          ).cb
        : null;
    const fn: IrLibFn = cb === null ? "http.clientSetTimeout" : "http.clientSetTimeoutCb";
    const callArgs = cb === null ? [receiver, ms] : [receiver, ms, cb];
    if (resultIsDiscarded(call)) return { kind: "libCall", fn, args: callArgs, type: VOID, loc };
    return receiverReturningCall(lowerer, fn, callArgs, HTTPCLIENTREQ_T, loc);
  }
  if (name === "addTrailers") {
    requireStatementPosition(lowerer, call, "request.addTrailers(...)");
    if (args.length !== 1)
      lowerer.noLowering(
        "request.addTrailers argument count",
        call,
        "pass one trailer object or pair-list literal",
      );
    const receiver = coerceToHandle(lowerer, access.expression, HTTPCLIENTREQ_T);
    const pairs = lowerHttpTrailersOption(lowerer, args[0]!);
    return {
      kind: "libCall",
      fn: "http.clientAddTrailers",
      args: [receiver, pairs],
      type: VOID,
      loc,
    };
  }
  if (name === "write" || name === "end") {
    requireStatementPosition(lowerer, call, `request.${name}(...)`);
    const minArgs = name === "write" ? 1 : 0;
    if (args.length < minArgs || args.length > 1) {
      lowerer.noLowering(
        `${name} with ${args.length} arguments`,
        call,
        name === "write"
          ? "the supported form is write(data)"
          : "the supported forms are end() and end(data)",
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    if (args.length === 0) {
      return { kind: "libCall", fn: "http.clientEnd", args: [receiver], type: VOID, loc };
    }
    const data = lowerer.lowerExpr(args[0]!);
    if (data.type.kind === "string") {
      const fn: IrLibFn = name === "write" ? "http.clientWrite" : "http.clientEndStr";
      return { kind: "libCall", fn, args: [receiver, data], type: VOID, loc };
    }
    if (data.type.kind === "dyn") {
      // An untyped JS payload — the net.sockWriteDyn story.
      const fn: IrLibFn = name === "write" ? "http.clientWriteDyn" : "http.clientEndDyn";
      return { kind: "libCall", fn, args: [receiver, data], type: VOID, loc };
    }
    if (data.type.kind === "bytes" && data.type.elem === "u8") {
      const fn: IrLibFn = name === "write" ? "http.clientWriteBytes" : "http.clientEndBytes";
      return { kind: "libCall", fn, args: [receiver, data], type: VOID, loc };
    }
    lowerer.noLowering(
      `${name} of '${lowerer.fmt(data.type)}' data`,
      args[0] ?? call,
      NARROW_DATA_HINT,
    );
  }
  if (name === "destroy" && args.length === 1) {
    // destroy(err): err is the request's 'error' (an Error value here).
    requireStatementPosition(lowerer, call, "request.destroy(err)");
    const receiver = lowerer.lowerExpr(access.expression);
    const err = lowerer.lowerExpr(args[0]!);
    if (err.type.kind !== "object") {
      lowerer.noLowering(
        `destroy with a '${lowerer.fmt(err.type)}' argument`,
        args[0]!,
        "pass an Error value, or call destroy() without one",
      );
    }
    return {
      kind: "libCall",
      fn: "http.clientDestroyError",
      args: [receiver, lowerer.coerceToExpected(err, ERROR_T)],
      type: VOID,
      loc,
    };
  }
  if (name === "destroy" || name === "abort") {
    requireStatementPosition(lowerer, call, `request.${name}()`);
    if (args.length !== 0) {
      lowerer.noLowering(
        `${name} with ${args.length} arguments`,
        call,
        `${name}() takes no arguments here`,
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    return {
      kind: "libCall",
      fn: name === "destroy" ? "http.clientDestroy" : "http.clientAbort",
      args: [receiver],
      type: VOID,
      loc,
    };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    requireStatementPosition(lowerer, call, `request.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = lowerer.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const receiver = lowerer.lowerExpr(access.expression);
    if (event === "response") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "response listeners",
        1,
        (p) => p.kind === "httpReq",
        "use (res) or ()",
        [HTTPREQ_T],
      );
      return {
        kind: "libCall",
        fn: "http.clientOnResponse",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "socket") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "socket listeners",
        1,
        (p) => p.kind === "netSocket",
        "use (socket) or ()",
        [NETSOCKET_T],
      );
      return {
        kind: "libCall",
        fn: "http.clientOnSocket",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "error") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "error listeners",
        1,
        (p) => p.kind === "object" && p.className === "%Error",
        "use (err) or ()",
        [ERROR_T],
      );
      return {
        kind: "libCall",
        fn: "http.clientOnError",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (
      event === "timeout" ||
      event === "close" ||
      event === "finish" ||
      event === "abort" ||
      event === "continue"
    ) {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        `${event} listeners`,
        0,
        () => false,
        "use ()",
        [],
      );
      const fn: IrLibFn =
        event === "timeout"
          ? "http.clientOnTimeout"
          : event === "close"
            ? "http.clientOnClose"
            : event === "abort"
              ? "http.clientOnAbort"
              : event === "continue"
                ? "http.clientOnContinue"
                : "http.clientOnFinish";
      return { kind: "libCall", fn, args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "upgrade") {
      // The client half of the WebSocket handover: a 101 response fires
      // (res, socket, head) INSTEAD of 'response'; no listener destroys
      // the connection, Node's default.
      const cb = lowerer.lowerExpr(args[1]!);
      if (cb.type.kind !== "func" || cb.type.params.length > 3) {
        lowerer.unsupported(
          "SC1090",
          args[1]!,
          "upgrade listeners with more than three parameters (use (res, socket, head))",
        );
      }
      if (cb.type.ret.kind !== "void") {
        lowerer.unsupported(
          "SC1090",
          args[1]!,
          "upgrade listeners returning a value (make the callback body a block)",
        );
      }
      const [p0, p1, p2] = cb.type.params;
      if (
        (p0 !== undefined && p0.kind !== "httpReq") ||
        (p1 !== undefined && p1.kind !== "netSocket") ||
        (p2 !== undefined && !(p2.kind === "bytes" && p2.elem === "u8"))
      ) {
        lowerer.unsupported(
          "SC1090",
          args[1]!,
          "upgrade listeners whose parameters are not (res: IncomingMessage, socket: Socket, head: Buffer)",
        );
      }
      return {
        kind: "libCall",
        fn: "http.clientOnUpgrade",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    lowerer.noLowering(
      `request.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
      args[0]!,
      '"response", "socket", "upgrade", "error", "timeout", "finish", "abort", and "close" are the supported request events (as literals)',
    );
  }
  lowerer.noLowering(
    `ClientRequest.${name}`,
    call,
    "header reads/mutations, write, end, destroy, and on/once of response/error/timeout/close are the supported ClientRequest members",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** True when `node` is the h2-only stream/session CALL shape —
 * `req.stream.destroy()` / `req.session.m(...)` on an identifier
 * receiver mapped httpReq (the lower-calls streamUndefCall precedent's
 * predicate, shared): on this lowering the member is always undefined,
 * so the CALL always throws — a concise arrow over it (`() =>
 * req.stream.destroy()`) is a throw-only body whose declared return type
 * (ServerHttp2Stream, unmappable) must not decide the lambda's ABI.
 * lambdaSignature consults this and takes void, the `never` stance. */
export function isStreamUndefCallExpr(lowerer: Lowerer, node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isPropertyAccessExpression(node.expression.expression) &&
    !node.expression.expression.questionDotToken &&
    !node.expression.questionDotToken &&
    (node.expression.expression.name.text === "stream" ||
      node.expression.expression.name.text === "session") &&
    ts.isIdentifier(node.expression.expression.expression) &&
    lowerer.mapTypeOf(lowerer.typeOf(node.expression.expression.expression))?.kind === "httpReq" &&
    lowerer.isStdlibMember(node.expression.expression)
  );
}

/** `x instanceof net.Socket` over a UNION-typed x with a netSocket arm —
 * the h2 compat 'connect' listener's narrowing (`resOrSocket instanceof
 * net.Socket`): one runtime tag test; tsc's control-flow narrowing types
 * the branches and reads bridge through maybeNarrow's unionNarrow. Null
 * for every other shape (lower-exprs' fences stand). */
export function lowerSocketInstanceOf(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const rhs = expr.right;
  const isNetSocketRef =
    (ts.isPropertyAccessExpression(rhs) &&
      rhs.name.text === "Socket" &&
      lowerer.builtinMemberOf(rhs)?.module === "net") ||
    (ts.isIdentifier(rhs) &&
      lowerer.builtinImportOf(rhs)?.module === "net" &&
      lowerer.builtinImportOf(rhs)?.member === "Socket");
  if (!isNetSocketRef) return null;
  const leftT = lowerer.mapTypeOf(lowerer.typeOf(expr.left));
  if (leftT?.kind !== "union") return null;
  const def = lowerer.unions.get(leftT.unionId);
  const tag = def ? def.arms.findIndex((a) => a.kind === "netSocket") : -1;
  if (tag < 0) return null;
  const left = lowerer.lowerExpr(expr.left);
  if (left.type.kind !== "union" || left.type.unionId !== leftT.unionId) return null;
  return {
    kind: "unionIsTag",
    unionId: leftT.unionId,
    tag,
    negated: false,
    value: left,
    type: BOOL,
    loc,
  };
}

/** True when `node` reads `.headers` off an IncomingMessage — the
 * receiver shape of both header-read forms. */
function httpReqFieldCollection(
  lowerer: Lowerer,
  node: ts.Expression,
): "headers" | "trailers" | "headersDistinct" | "trailersDistinct" | null {
  if (
    ts.isPropertyAccessExpression(node) &&
    !node.questionDotToken &&
    (node.name.text === "headers" ||
      node.name.text === "trailers" ||
      node.name.text === "headersDistinct" ||
      node.name.text === "trailersDistinct") &&
    lowerer.mapTypeOf(lowerer.typeOf(node.expression))?.kind === "httpReq" &&
    lowerer.isStdlibMember(node)
  )
    return node.name.text;
  return null;
}

/** `req.headers["x-name"]` — the element twin of the property read below;
 * called from lowerElementAccess (the process.env precedent). Answers the
 * interned `string | undefined` union; names match case-insensitively
 * (the runtime stores them lowercased, like Node). */
export function lowerHttpHeadersElement(
  lowerer: Lowerer,
  expr: ts.ElementAccessExpression,
): IrExpr | null {
  const collection = httpReqFieldCollection(lowerer, expr.expression);
  if (collection === null) return null;
  const recv = (expr.expression as ts.PropertyAccessExpression).expression;
  const key = lowerer.lowerExpr(expr.argumentExpression);
  if (key.type.kind !== "string") {
    lowerer.unsupported(
      "SC1090",
      expr.argumentExpression,
      `indexing req.${collection} with non-string keys`,
    );
  }
  const receiver = lowerer.lowerExpr(recv);
  const list = isSetCookieRead(lowerer, expr, collection, key);
  return {
    kind: "libCall",
    fn:
      collection === "headers" && !list
        ? "http.reqHeader"
        : collection === "trailers"
          ? "http.reqTrailer"
          : collection === "headersDistinct" || list
            ? "http.reqHeaderValues"
            : "http.reqTrailerValues",
    args: [receiver, key],
    type:
      collection.endsWith("Distinct") || list
        ? lowerer.withUndefinedArm(arrayOf(STRING))
        : lowerer.envValueType(),
    loc: locOf(expr),
  };
}

/** `headers["set-cookie"]` reads Node's array of every Set-Cookie line,
 * the `string[] | undefined` that @types/node's IncomingHttpHeaders
 * declares. A read typed as a string (the bundled declarations type every
 * header as one) is refused, because Node's value is an array. */
function isSetCookieRead(
  lowerer: Lowerer,
  expr: ts.Expression,
  collection: string,
  key: IrExpr,
): boolean {
  if (collection !== "headers" || key.kind !== "strLit" || key.value !== "set-cookie") return false;
  const type = lowerer.mapTypeOf(lowerer.typeOf(expr));
  const array = lowerer.withUndefinedArm(arrayOf(STRING));
  if (type?.kind === "union" && array.kind === "union" && type.unionId === array.unionId)
    return true;
  lowerer.noLowering(
    "reading set-cookie through string-typed headers",
    expr,
    "Node stores set-cookie as an array: read headersDistinct['set-cookie'], or install @types/node, which types headers['set-cookie'] as string[]",
  );
}

/** Method calls on IncomingMessage receivers: on/once("data" | "end").
 * Null for other receivers. */
function lowerHttpReqMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "httpReq") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if (name === "setTimeout") {
    requireStatementPosition(lowerer, call, "message.setTimeout(...)");
    if (args.length < 1 || args.length > 2)
      lowerer.noLowering(
        "message.setTimeout arguments",
        call,
        "pass milliseconds and an optional callback",
      );
    const receiver = coerceToHandle(lowerer, access.expression, HTTPREQ_T);
    const ms = lowerer.lowerExprExpecting(args[0]!, F64);
    if (args.length === 1)
      return { kind: "libCall", fn: "http.reqSetTimeout", args: [receiver, ms], type: VOID, loc };
    const { cb } = lowerCallbackArg(
      lowerer,
      args[1]!,
      "message timeout callbacks",
      0,
      () => false,
      "use ()",
      [],
    );
    return {
      kind: "libCall",
      fn: "http.reqSetTimeoutCb",
      args: [receiver, ms, cb],
      type: VOID,
      loc,
    };
  }
  if (name === "resume" || name === "pause" || name === "destroy") {
    requireStatementPosition(lowerer, call, `req.${name}()`);
    if (args.length !== 0) {
      lowerer.noLowering(
        `${name} with ${args.length} arguments`,
        call,
        `${name}() takes no arguments here`,
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, HTTPREQ_T);
    const fn: IrLibFn =
      name === "resume" ? "http.reqResume" : name === "pause" ? "http.reqPause" : "http.reqDestroy";
    return { kind: "libCall", fn, args: [receiver], type: VOID, loc };
  }
  if (name === "setEncoding") {
    // setEncoding('utf8') — 'data' delivers strings (the chunk-encoding
    // window); other real encodings throw "not supported yet" at runtime, unknown
    // names throw Node's ERR_UNKNOWN_ENCODING.
    requireStatementPosition(lowerer, call, "req.setEncoding(...)");
    if (args.length !== 1) {
      lowerer.noLowering(
        `setEncoding with ${args.length} arguments`,
        call,
        "the supported form is setEncoding(encoding)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, HTTPREQ_T);
    const enc = lowerer.lowerExprExpecting(args[0]!, STRING);
    return { kind: "libCall", fn: "http.reqSetEncoding", args: [receiver, enc], type: VOID, loc };
  }
  if (name === "pipe") {
    // The proxy legs: req→res (the response body forward), req→clientReq
    // (the request body forward), req→socket (the upgrade-rejection
    // write) — plus socket→socket, which lives on the socket receiver.
    requireStatementPosition(lowerer, call, "req.pipe(...)");
    if (args.length !== 1) {
      lowerer.noLowering(
        `pipe with ${args.length} arguments`,
        call,
        "the supported form is pipe(destination)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, HTTPREQ_T);
    const dst = lowerer.lowerExpr(args[0]!);
    const fn: IrLibFn | null =
      dst.type.kind === "httpRes"
        ? "http.reqPipeRes"
        : dst.type.kind === "httpClientReq"
          ? "http.reqPipeClient"
          : dst.type.kind === "netSocket"
            ? "http.reqPipeSock"
            : null;
    if (fn === null) {
      lowerer.noLowering(
        `pipe into '${lowerer.fmt(dst.type)}' destinations`,
        args[0]!,
        "an IncomingMessage pipes into a ServerResponse, a ClientRequest, or a Socket",
      );
    }
    return { kind: "libCall", fn, args: [receiver, dst], type: VOID, loc };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    requireStatementPosition(lowerer, call, `req.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = lowerer.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const receiver = coerceToHandle(lowerer, access.expression, HTTPREQ_T);
    if (event === "data") {
      const sigs = lowerer.checker.getCallSignatures(lowerer.typeOf(args[1]!));
      const firstParam = sigs.length === 1 ? sigs[0]!.getParameters()[0] : undefined;
      const param =
        firstParam !== undefined
          ? lowerer.mapTypeOf(lowerer.checker.getTypeOfSymbol(firstParam))
          : null;
      if (param !== null && param.kind === "string") {
        // A chunk typed string (the setEncoding('utf8') shape), as on a
        // socket: the listener takes the chunk through a checked
        // boundary, so a string arrives after setEncoding and a Buffer
        // without it fails the check instead of being decoded.
        const boxed = lowerSocketDynListener(lowerer, args[1]!, "data listeners");
        const cb: IrExpr = { kind: "dynCheck", value: boxed, type: funcOf([DYN], VOID), loc };
        return {
          kind: "libCall",
          fn: "http.reqOnData",
          args: [receiver, cb, once],
          type: VOID,
          loc,
        };
      }
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "data listeners",
        1,
        (p) => p.kind === "bytes" && p.elem === "u8",
        "use (chunk: Buffer) or ()",
        [DYN],
      );
      return { kind: "libCall", fn: "http.reqOnData", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "end") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "end listeners",
        0,
        () => false,
        "use ()",
        [],
      );
      return { kind: "libCall", fn: "http.reqOnEnd", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "error") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "error listeners",
        1,
        (p) => p.kind === "object" && p.className === "%Error",
        "use (err) or ()",
        [ERROR_T],
      );
      return {
        kind: "libCall",
        fn: "http.reqOnError",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "close") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "close listeners",
        0,
        () => false,
        "use ()",
        [],
      );
      return {
        kind: "libCall",
        fn: "http.reqOnClose",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "aborted") {
      // The h2 compat event (Http2ServerRequest 'aborted'); an http/1
      // request registers too and never fires — the parser lane's story.
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "aborted listeners",
        0,
        () => false,
        "use ()",
        [],
      );
      return {
        kind: "libCall",
        fn: "http.reqOnAborted",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    lowerer.noLowering(
      `req.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
      args[0]!,
      '"data", "end", "error", "close", and "aborted" are the supported request events (as literals)',
    );
  }
  lowerer.noLowering(
    `IncomingMessage.${name}`,
    call,
    "url, method, statusCode, statusMessage, socket, headers/rawHeaders reads, resume, destroy, pipe, and on/once of data/end/error/close are the supported IncomingMessage members",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** Method calls on ServerResponse receivers: setHeader/writeHead/write/
 * end. Null for other receivers. */
function lowerHttpResMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "httpRes") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if (name === "setTimeout") {
    if (args.length < 1 || args.length > 2) {
      lowerer.noLowering(
        `res.setTimeout with ${args.length} arguments`,
        call,
        "use setTimeout(milliseconds[, callback])",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, HTTPRES_T);
    const ms = lowerer.lowerExprExpecting(args[0]!, F64);
    const cb =
      args.length === 2
        ? lowerCallbackArg(
            lowerer,
            args[1]!,
            "response timeout callbacks",
            0,
            () => false,
            "use ()",
            [],
          ).cb
        : null;
    const fn: IrLibFn = cb === null ? "http.resSetTimeout" : "http.resSetTimeoutCb";
    const callArgs = cb === null ? [receiver, ms] : [receiver, ms, cb];
    if (resultIsDiscarded(call)) return { kind: "libCall", fn, args: callArgs, type: VOID, loc };
    return receiverReturningCall(lowerer, fn, callArgs, HTTPRES_T, loc);
  }
  if (name === "writeContinue" || name === "writeProcessing" || name === "writeEarlyHints") {
    requireStatementPosition(lowerer, call, `res.${name}(...)`);
    if (ts.symbolNameOf(lowerer.typeOf(access.expression).getSymbol()) === "Http2ServerResponse") {
      lowerer.noLowering(
        `Http2ServerResponse.${name}`,
        call,
        "HTTP/2 informational responses are not supported by the static runtime yet",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, HTTPRES_T);
    if (name !== "writeEarlyHints") {
      if (args.length !== 0)
        lowerer.noLowering(`res.${name} callback`, call, `${name}() supports no callback here`);
      return {
        kind: "libCall",
        fn: name === "writeContinue" ? "http.resWriteContinue" : "http.resWriteProcessing",
        args: [receiver],
        type: VOID,
        loc,
      };
    }
    if (args.length !== 1)
      lowerer.noLowering(
        "res.writeEarlyHints arguments",
        call,
        "pass one header object or Record<string, string> without a callback",
      );
    const node = args[0]!;
    let pairs: IrExpr;
    if (ts.isObjectLiteralExpression(node)) {
      const elems: IrExpr[] = [];
      for (const prop of node.properties.nodes) {
        const key = ts.isPropertyAssignment(prop) ? staticHeaderKeyOf(lowerer, prop) : null;
        if (!ts.isPropertyAssignment(prop) || key === null) {
          lowerer.noLowering(
            "writeEarlyHints headers with dynamic keys, spreads, or shorthand entries",
            prop,
            "use literal header keys and string values",
          );
        }
        const value = lowerer.lowerExpr(prop.initializer);
        if (value.type.kind !== "string") {
          lowerer.noLowering(
            `writeEarlyHints value of type '${lowerer.fmt(value.type)}'`,
            prop.initializer,
            "header values must be strings here",
          );
        }
        elems.push({ kind: "strLit", value: key, type: STRING, loc }, value);
      }
      pairs = { kind: "arrayLit", elems, type: arrayOf(STRING), loc };
    } else {
      const value = lowerer.lowerExpr(node);
      if (value.type.kind !== "record") {
        lowerer.noLowering(
          `writeEarlyHints headers of '${lowerer.fmt(value.type)}'`,
          node,
          "pass an object literal or a Record<string, string>",
        );
      }
      const helper = lowerer.envToPairsHelper(value.type.shapeId, loc);
      if (helper === null) {
        lowerer.noLowering(
          "writeEarlyHints header values",
          node,
          "use a Record<string, string> with string values",
        );
      }
      pairs = { kind: "call", callee: helper, args: [value], type: arrayOf(STRING), loc };
    }
    return {
      kind: "libCall",
      fn: "http.resWriteEarlyHints",
      args: [receiver, pairs],
      type: VOID,
      loc,
    };
  }
  if (name === "getHeaderNames" || name === "getRawHeaderNames" || name === "getHeaders") {
    if (args.length !== 0)
      lowerer.noLowering(`res.${name} arguments`, call, `${name}() takes no arguments`);
    const receiver = coerceToHandle(lowerer, access.expression, HTTPRES_T);
    const fn: IrLibFn =
      name === "getHeaderNames"
        ? "http.resGetHeaderNames"
        : name === "getRawHeaderNames"
          ? "http.resGetRawHeaderNames"
          : "http.resGetHeaders";
    return {
      kind: "libCall",
      fn,
      args: [receiver],
      type: name === "getHeaders" ? DYN : arrayOf(STRING),
      loc,
    };
  }
  if (name === "flushHeaders" || name === "cork" || name === "uncork") {
    requireStatementPosition(lowerer, call, `res.${name}()`);
    if (args.length !== 0)
      lowerer.noLowering(`res.${name} with arguments`, call, `${name}() takes no arguments`);
    const receiver = coerceToHandle(lowerer, access.expression, HTTPRES_T);
    const fn: IrLibFn =
      name === "flushHeaders"
        ? "http.resFlushHeaders"
        : name === "cork"
          ? "http.resCork"
          : "http.resUncork";
    return { kind: "libCall", fn, args: [receiver], type: VOID, loc };
  }
  if (name === "addTrailers") {
    requireStatementPosition(lowerer, call, "res.addTrailers(...)");
    if (ts.symbolNameOf(lowerer.typeOf(access.expression).getSymbol()) === "Http2ServerResponse") {
      lowerer.noLowering(
        "Http2ServerResponse.addTrailers",
        call,
        "HTTP/2 response trailers are not supported by the static runtime yet",
      );
    }
    if (args.length !== 1)
      lowerer.noLowering(
        "res.addTrailers argument count",
        call,
        "pass one trailer object or pair-list literal",
      );
    const receiver = coerceToHandle(lowerer, access.expression, HTTPRES_T);
    const pairs = lowerHttpTrailersOption(lowerer, args[0]!);
    return { kind: "libCall", fn: "http.resAddTrailers", args: [receiver, pairs], type: VOID, loc };
  }
  if (name === "setHeader") {
    requireStatementPosition(lowerer, call, "res.setHeader(...)");
    if (args.length !== 2) {
      lowerer.noLowering(
        `setHeader with ${args.length} arguments`,
        call,
        "the supported form is setHeader(name, value)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, HTTPRES_T);
    const header = lowerer.lowerExprExpecting(args[0]!, STRING);
    let value = lowerer.lowerExpr(args[1]!);
    if (
      lowerer.mapTypeOf(lowerer.typeOf(args[1]!))?.kind === "string" &&
      lowerer.runtimeOptionalWidening(value.type, STRING) !== null
    ) {
      // Missing-value propagation keeps an indexed/header read's storage
      // as string | undefined after TypeScript narrows this call site to
      // string. Treat setHeader's string overload as the typed consumer it
      // is: extract the proven arm through the ordinary checked coercion.
      // An unguarded optional value remains union-typed to the checker and
      // retains the setHeader refusal below.
      value = lowerer.coerceInto(args[1]!, value, STRING);
    }
    if (value.type.kind !== "string") {
      // Numbers and arrays keep their type for getHeader/getHeaders, like
      // Node's stored value; numbers serialize as String(n) and arrays as
      // one line per element.
      return {
        kind: "libCall",
        fn: "http.resSetHeaderDyn",
        args: [receiver, header, lowerer.coerceToExpected(value, DYN)],
        type: VOID,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: "http.resSetHeader",
      args: [receiver, header, value],
      type: VOID,
      loc,
    };
  }
  if (name === "appendHeader") {
    requireStatementPosition(lowerer, call, "res.appendHeader(...)");
    if (args.length !== 2) {
      lowerer.noLowering(
        `appendHeader with ${args.length} arguments`,
        call,
        "the supported form is appendHeader(name, value)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, HTTPRES_T);
    const header = lowerer.lowerExprExpecting(args[0]!, STRING);
    const value = lowerer.lowerExpr(args[1]!);
    return {
      kind: "libCall",
      fn: "http.resAppendHeader",
      args: [receiver, header, lowerer.coerceToExpected(value, DYN)],
      type: VOID,
      loc,
    };
  }
  if (name === "writeHead") {
    if (args.length < 1 || args.length > 3) {
      lowerer.noLowering(
        `writeHead with ${args.length} arguments`,
        call,
        "the supported forms are writeHead(status[, statusMessage][, headers]) — headers as a literal object, a Record, or a flat [name, value, ...] array",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, HTTPRES_T);
    const status = lowerer.lowerExprExpecting(args[0]!, F64);
    // The optional statusMessage: a string-typed second argument is the
    // reason phrase (Node's overload split); it rides the composing
    // helper as a resStatusMsgSet prefix before the head goes out.
    let msg: IrExpr | null = null;
    let headersNode: ts.Expression | undefined;
    if (args.length === 2) {
      if (lowerer.mapTypeOf(lowerer.typeOf(args[1]!))?.kind === "string")
        msg = lowerer.lowerExprExpecting(args[1]!, STRING);
      else headersNode = args[1];
    } else if (args.length === 3) {
      msg = lowerer.lowerExprExpecting(args[1]!, STRING);
      headersNode = args[2];
    }
    // Node answers the response (`return this` — the chaining shape
    // res.writeHead(...).end(...)): statement position keeps the plain
    // void call; a consumed result (or a statusMessage prefix) rides the
    // receiver-returning helper.
    const headResult = (fn: IrLibFn, callArgs: IrExpr[]): IrExpr => {
      if (msg === null && ts.isExpressionStatement(call.parent)) {
        return { kind: "libCall", fn, args: callArgs, type: VOID, loc };
      }
      if (msg === null) return receiverReturningCall(lowerer, fn, callArgs, HTTPRES_T, loc);
      // With a message the helper's parameter list gains the msg at slot
      // 1 (feeding the resStatusMsgSet prefix); the head call itself
      // re-selects around it.
      const withMsg = [callArgs[0]!, msg, ...callArgs.slice(1)];
      return receiverReturningCall(lowerer, fn, withMsg, HTTPRES_T, loc, {
        prefix: { fn: "http.resStatusMsgSet", argIndices: [0, 1] },
        mainArgIndices: [0, ...callArgs.slice(1).map((_, i) => i + 2)],
      });
    };
    if (headersNode === undefined) {
      return headResult("http.resWriteHead", [receiver, status]);
    }
    // The headers argument: an OBJECT LITERAL with identifier or
    // string-literal keys and string-typed values, packed into parallel
    // name/value arrays (evaluation order is the literal's own) — any
    // RECORD whose values are strings / `string | undefined` (absent
    // entries drop), flattened through the interned env.pairs helper —
    // or Node's FLAT ARRAY form ([name, value, name, value, ...]: a
    // string[] value, repeated names writing one line each).
    if (!ts.isObjectLiteralExpression(headersNode)) {
      const v = lowerer.lowerExpr(headersNode);
      if (v.type.kind === "array" && v.type.elem.kind === "string") {
        return headResult("http.resWriteHeadPairs", [receiver, status, v]);
      }
      if (v.type.kind === "dyn") {
        // A checked-dynamic headers value (an untyped JS helper's
        // parameter — the suite's test(headers) idiom): the runtime OBJ
        // walk sets each entry and throws ERR_INVALID_ARG_TYPE for
        // non-string/number values.
        return headResult("http.resWriteHeadDyn", [receiver, status, v]);
      }
      if (v.type.kind !== "record") {
        lowerer.noLowering(
          `writeHead with a '${lowerer.fmt(v.type)}' headers argument`,
          headersNode,
          "pass an object literal, a Record<string, string>, or a flat [name, value, ...] string array — or call setHeader per entry before writeHead(status)",
        );
      }
      const helper = lowerer.envToPairsHelper(v.type.shapeId, locOf(headersNode));
      if (helper === null) {
        lowerer.noLowering(
          `writeHead headers of '${lowerer.fmt(v.type)}' values`,
          headersNode,
          "header values must be strings (or string | undefined) — convert numbers with String(n)",
        );
      }
      const pairs: IrExpr = { kind: "call", callee: helper, args: [v], type: arrayOf(STRING), loc };
      return headResult("http.resWriteHeadPairs", [receiver, status, pairs]);
    }
    const names: IrExpr[] = [];
    const values: IrExpr[] = [];
    for (const prop of headersNode.properties.nodes) {
      const key = ts.isPropertyAssignment(prop) ? staticHeaderKeyOf(lowerer, prop) : null;
      if (!ts.isPropertyAssignment(prop) || key === null) {
        lowerer.noLowering(
          "writeHead headers with dynamic keys, spreads, or shorthand entries",
          prop,
          "each header must be a `name: value` entry whose key is a literal (or a string-literal-typed const: [PORTLESS_HEADER])",
        );
      }
      let value = lowerer.lowerExpr(prop.initializer);
      if (value.type.kind === "f64") {
        // Node formats number values via String(n) — the same ToString.
        value = { kind: "toString", operand: value, type: STRING, loc };
      }
      if (value.type.kind !== "string") {
        lowerer.noLowering(
          `writeHead header values of type '${lowerer.fmt(value.type)}'`,
          prop.initializer,
          "header values are strings or numbers here",
        );
      }
      names.push({ kind: "strLit", value: key, type: STRING, loc });
      values.push(value);
    }
    const namesArr: IrExpr = { kind: "arrayLit", elems: names, type: arrayOf(STRING), loc };
    const valuesArr: IrExpr = { kind: "arrayLit", elems: values, type: arrayOf(STRING), loc };
    return headResult("http.resWriteHeadN", [receiver, status, namesArr, valuesArr]);
  }
  if (name === "write" || name === "end") {
    requireStatementPosition(lowerer, call, `res.${name}(...)`);
    const minArgs = name === "write" ? 1 : 0;
    const maxArgs = name === "write" ? 1 : 2;
    if (args.length < minArgs || args.length > maxArgs) {
      lowerer.noLowering(
        `${name} with ${args.length} arguments`,
        call,
        name === "write"
          ? "the supported form is write(data)"
          : "the supported forms are end(), end(data), end(callback), and end(data, callback)",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, HTTPRES_T);
    // end's callback forms — end(cb) / end(data, cb): the callback fires
    // deferred once the body went out (just before Node's 'finish' emit),
    // through the resOnEndCallback slot registered just before the end
    // call in an interned composing helper.
    let cbArg: IrExpr | null = null;
    let dataNode: ts.Expression | undefined = args[0];
    if (name === "end" && args.length === 2) {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "end callbacks",
        0,
        () => false,
        "use ()",
        [],
      );
      cbArg = cb;
    } else if (
      name === "end" &&
      args.length === 1 &&
      lowerer.mapTypeOf(lowerer.typeOf(args[0]!))?.kind !== "string" &&
      lowerer.mapTypeOf(lowerer.typeOf(args[0]!))?.kind !== "bytes"
    ) {
      const probe = lowerer.typeOf(args[0]!);
      if (
        lowerer.mapTypeOf(probe)?.kind === "func" ||
        lowerer.mapTypeOf(probe) === null ||
        lowerer.mapTypeOf(probe)?.kind === "dyn"
      ) {
        const { cb } = lowerCallbackArg(
          lowerer,
          args[0]!,
          "end callbacks",
          0,
          () => false,
          "use ()",
          [],
        );
        cbArg = cb;
        dataNode = undefined;
      }
    }
    const endWithCb = (fn: IrLibFn, callArgs: IrExpr[], cb: IrExpr): IrExpr => {
      const all = [...callArgs, cb];
      const key = `server.endcb:${fn}:${all.map((a) => typeKey(a.type)).join(",")}`;
      const existing = lowerer.arrHofHelpers.get(key);
      const helper = existing ?? keyedHelperName(lowerer, "%server.endcb", key);
      if (!existing) {
        lowerer.arrHofHelpers.set(key, helper);
        const params = all.map((a, i) => ({ localId: `p${i}.0`, name: `p${i}`, type: a.type }));
        lowerer.liftedFns.push({
          name: helper,
          params,
          returnType: VOID,
          locals: params.map((p) => ({
            id: p.localId,
            name: p.name,
            type: p.type,
            mutable: false,
          })),
          body: [
            {
              kind: "exprStmt",
              expr: {
                kind: "libCall",
                fn: "http.resOnEndCallback",
                args: [
                  varRef(params[0]!.localId, params[0]!.type, loc),
                  varRef(params[all.length - 1]!.localId, params[all.length - 1]!.type, loc),
                ],
                type: VOID,
                loc,
              },
              loc,
            },
            {
              kind: "exprStmt",
              expr: {
                kind: "libCall",
                fn,
                args: callArgs.map((_, i) => varRef(params[i]!.localId, params[i]!.type, loc)),
                type: VOID,
                loc,
              },
              loc,
            },
          ],
          loc,
        });
      }
      return { kind: "call", callee: helper, args: all, type: VOID, loc };
    };
    if (dataNode === undefined) {
      if (cbArg !== null) return endWithCb("http.resEnd", [receiver], cbArg);
      return { kind: "libCall", fn: "http.resEnd", args: [receiver], type: VOID, loc };
    }
    const data = lowerer.lowerExpr(dataNode);
    if (data.type.kind === "string") {
      const fn: IrLibFn = name === "write" ? "http.resWrite" : "http.resEndStr";
      if (cbArg !== null) return endWithCb(fn, [receiver, data], cbArg);
      return { kind: "libCall", fn, args: [receiver, data], type: VOID, loc };
    }
    if (data.type.kind === "bytes" && data.type.elem === "u8") {
      const fn: IrLibFn = name === "write" ? "http.resWriteBytes" : "http.resEndBytes";
      if (cbArg !== null) return endWithCb(fn, [receiver, data], cbArg);
      return { kind: "libCall", fn, args: [receiver, data], type: VOID, loc };
    }
    if (data.type.kind === "dyn") {
      // An untyped JS payload — the net.sockWriteDyn story.
      const fn: IrLibFn = name === "write" ? "http.resWriteDyn" : "http.resEndDyn";
      if (cbArg !== null) return endWithCb(fn, [receiver, data], cbArg);
      return { kind: "libCall", fn, args: [receiver, data], type: VOID, loc };
    }
    // end(payload ? text : undefined): an absent chunk ends without data,
    // as end() does. The checked-dynamic end takes each arm at run time.
    if (name === "end" && data.type.kind === "union" && lowerer.dynConvertible(data.type)) {
      const arms = lowerer.unions.get(data.type.unionId)?.arms ?? [];
      if (
        arms.every(
          (arm) =>
            arm.kind === "string" ||
            (arm.kind === "bytes" && arm.elem === "u8") ||
            arm.kind === "undefinedT" ||
            arm.kind === "nullT",
        )
      ) {
        const dynData: IrExpr = { kind: "dynFrom", value: data, type: DYN, loc: locOf(dataNode) };
        if (cbArg !== null) return endWithCb("http.resEndDyn", [receiver, dynData], cbArg);
        return {
          kind: "libCall",
          fn: "http.resEndDyn",
          args: [receiver, dynData],
          type: VOID,
          loc,
        };
      }
    }
    lowerer.noLowering(
      `${name} of '${lowerer.fmt(data.type)}' data`,
      dataNode ?? call,
      NARROW_DATA_HINT,
    );
  }
  if (name === "getHeader" || name === "hasHeader" || name === "removeHeader") {
    // The header CRUD trio (setHeader's readers): getHeader answers the
    // value as set (a number, string or string[]); removeHeader drops
    // every case-insensitive match before the head goes out; hasHeader is
    // the boolean probe.
    if (name === "removeHeader") requireStatementPosition(lowerer, call, "res.removeHeader(...)");
    if (args.length !== 1) {
      lowerer.noLowering(
        `${name} with ${args.length} arguments`,
        call,
        `the supported form is ${name}(name)`,
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, HTTPRES_T);
    const header = lowerer.lowerExprExpecting(args[0]!, STRING);
    if (name === "getHeader") {
      // The value as set: number, string or string[] (undefined when
      // absent), checked against the declared result type.
      const value: IrExpr = {
        kind: "libCall",
        fn: "http.resGetHeaderDyn",
        args: [receiver, header],
        type: DYN,
        loc,
      };
      const declared = lowerer.mapTypeOf(lowerer.typeOf(call));
      return declared === null || declared.kind === "dyn"
        ? value
        : lowerer.coerceInto(call, value, declared);
    }
    if (name === "hasHeader") {
      return {
        kind: "libCall",
        fn: "http.resHasHeader",
        args: [receiver, header],
        type: BOOL,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: "http.resRemoveHeader",
      args: [receiver, header],
      type: VOID,
      loc,
    };
  }
  if (name === "destroy") {
    requireStatementPosition(lowerer, call, "res.destroy()");
    if (args.length !== 0) {
      lowerer.noLowering(
        `destroy with ${args.length} arguments`,
        call,
        "destroy() takes no arguments here",
      );
    }
    const receiver = coerceToHandle(lowerer, access.expression, HTTPRES_T);
    return { kind: "libCall", fn: "http.resDestroy", args: [receiver], type: VOID, loc };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    requireStatementPosition(lowerer, call, `res.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = lowerer.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const receiver = coerceToHandle(lowerer, access.expression, HTTPRES_T);
    if (event === "close") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "close listeners",
        0,
        () => false,
        "use ()",
        [],
      );
      return {
        kind: "libCall",
        fn: "http.resOnClose",
        args: [receiver, cb, once],
        type: VOID,
        loc,
      };
    }
    if (event === "finish") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "finish listeners",
        0,
        () => false,
        "use ()",
        [],
      );
      return { kind: "libCall", fn: "http.resOnFinish", args: [receiver, cb], type: VOID, loc };
    }
    lowerer.noLowering(
      `res.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
      args[0]!,
      '"close" and "finish" are the supported response events (as literals)',
    );
  }
  lowerer.noLowering(
    `ServerResponse.${name}`,
    call,
    "setHeader, appendHeader, getHeader, hasHeader, removeHeader, writeHead, writeContinue, writeProcessing, writeEarlyHints, setTimeout, write, end, destroy, response state reads, and on/once of close are the supported ServerResponse members",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}
