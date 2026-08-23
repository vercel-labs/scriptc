/* The server-surface lowering (node:net + node:http — the spoke-module
 * pattern, like lower-island.ts): module-function calls (net
 * createServer/connect/createConnection, http createServer/request/get —
 * named AND namespace import forms, both dispatched here), method calls
 * on netServer/netSocket/httpReq/httpRes/httpClientReq receivers, the
 * composed `server.address().port` read, and the property surface
 * (req.url/method/statusCode/socket/headers, res.headersSent,
 * socket.remoteAddress, request.destroyed). Everything the lib declares
 * beyond these shapes fences member-qualified — never a generic
 * rejection, never silence. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { ladderFenceExpr, nodeThrowExpr } from "./lowerer.js";
import { isJsSourceFile, locOf } from "../program.js";
import { arrayOf, BOOL, BYTES_U8, canBoxFuncIntoDyn, canConvertToDyn, DYN, DYN_HANDLE_KINDS, F64, funcOf, HTTP2SESSION_T, HTTP2STREAM_T, HTTPCLIENTREQ_T, HTTPREQ_T, HTTPRES_T, IrExpr, IrLibFn, IrStmt, IrType, NETSERVER_T, NETSOCKET_T, NULL_T, SECURECTX_T, STRING, UNDEFINED_T, SrcLoc, typeKey, VOID } from "../../ir/nodes.js";
import {
  AGENT_DOCUMENTED_OPTIONS,
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
import { conditionalSpreadOf } from "./lower-exprs.js";
import { boolLit, numLit, strLit, varRef } from "../../ir/build.js";
import { resultIsDiscarded } from "./call-position.js";
import { lowerCallbackArg as lowerCallbackArgShared } from "./callback-arg.js";
import { pairsSnapshotHelper } from "./pairs-snapshot.js";

const NARROW_DATA_HINT =
  'write/end take one string or one Uint8Array/Buffer value (narrow unions first)';

/** The writable numeric http.Server timeout fields. The selector is an
 * internal runtime ABI shared by the get/set libCalls (kept here beside
 * the only two construction/lowering paths that can mint the accesses). */
function httpServerTimeoutField(name: string): number | null {
  switch (name) {
    case "timeout": return 0;
    case "keepAliveTimeout": return 1;
    case "headersTimeout": return 2;
    case "requestTimeout": return 3;
    case "keepAliveTimeoutBuffer": return 4;
    default: return null;
  }
}

/** VOID-result server/socket calls are usable as statements and as concise
 * arrow bodies (`socket.on("error", () => socket.destroy())` — the shape
 * portless is made of); anything that would CONSUME the result (Node
 * returns `this`/a boolean where this surface returns void) is fenced. */
function requireStatementPosition(L: Lowerer, call: ts.CallExpression, what: string): void {
  if (resultIsDiscarded(call)) return;
  L.unsupported(
    "SC1090",
    call,
    `using the result of ${what} (the result is void here — call it as its own statement)`,
  );
}

/** The %Error param shape the error-listener slots carry. */
const ERROR_T: IrType = { kind: "object", className: "%Error" };

/** Node ignores listener/handler return values. A value-returning
 * callback rides an interned cast-and-discard adapter (the stream lane's
 * bare-expression-body discard, generalized to closure VALUES): same
 * parameters, void return, the underlying result discarded unread. */
export function voidizedCallback(L: Lowerer, cb: IrExpr, loc: SrcLoc): IrExpr {
  if (cb.type.kind !== "func" || cb.type.ret.kind === "void") return cb;
  const fromT = cb.type;
  const toT = funcOf([...fromT.params], VOID);
  const key = `server.voidcb:${typeKey(fromT)}`;
  const existing = L.arrHofHelpers.get(key);
  const name = existing ?? `%server.voidcb.${L.arrHofHelpers.size}`;
  if (!existing) {
    L.arrHofHelpers.set(key, name);
    const impl = `${name}.impl`;
    const params = fromT.params.map((p, i) => ({ localId: `p${i}.0`, name: `p${i}`, type: p }));
    L.liftedFns.push({
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
            args: params.map((p): IrExpr => ({ kind: "varRef", localId: p.localId, type: p.type, loc })),
            type: fromT.ret,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    L.liftedFns.push({
      name,
      params: [{ localId: "f.0", name: "f", type: fromT }],
      returnType: toT,
      locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
      body: [{ kind: "return", value: { kind: "closure", fnName: impl, captures: ["f.0"], type: toT, loc }, loc }],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [cb], type: toT, loc };
}

/** A registration/side-effect libCall re-shaped to answer its RECEIVER —
 * Node's `return this` chaining (server.listen(...), res.writeHead(...)):
 * an interned helper runs the void call and returns its first argument.
 * `prefix` calls (the writeHead statusMessage form's resStatusMsgSet)
 * run first, sharing the same parameter refs. */
function receiverReturningCall(
  L: Lowerer,
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
  const existing = L.arrHofHelpers.get(key);
  const name = existing ?? `%server.recvret.${L.arrHofHelpers.size}`;
  if (!existing) {
    L.arrHofHelpers.set(key, name);
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
    L.liftedFns.push({
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
  L: Lowerer,
  node: ts.Expression,
  what: string,
  maxParams: number,
  paramOk: (p: IrExpr["type"]) => boolean,
  paramHint: string,
  dynTuple?: readonly IrType[],
): { cb: IrExpr; nparams: number } {
  return lowerCallbackArgShared(L, node, what, maxParams, paramOk, paramHint, {
    ...(dynTuple !== undefined ? { dynTuple } : {}),
    adapt: (cb) => voidizedCallback(L, cb, locOf(node)),
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
function isAddressInfoRecord(L: Lowerer, t: IrType): boolean {
  if (t.kind !== "record") return false;
  const shape = L.shapes.get(t.shapeId);
  if (!shape || shape.tuple || shape.indexValue || shape.fields.length !== 3) return false;
  const want: [string, string][] = [["address", "string"], ["family", "string"], ["port", "f64"]];
  return shape.fields.every((f, i) => f.name === want[i]![0] && f.type.kind === want[i]![1]);
}

function handleReceiver(L: Lowerer, node: ts.Expression, want: IrType): IrExpr {
  const recv = L.lowerExpr(node);
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
  L: Lowerer, shapeId: string, pairsLocal: string, outLocal: string,
  statusLocal: string | null, loc: SrcLoc,
): IrStmt[] | null {
  const shape = L.shapes.get(shapeId);
  if (!shape || shape.tuple || shape.fields.length > 0 || !shape.indexValue) return null;
  const iv = shape.indexValue;
  if (iv.kind !== "union") return null;
  const strTag = L.armTag(iv.unionId, STRING);
  if (strTag < 0) return null;
  const recT: IrType = { kind: "record", shapeId };
  const pairsT = arrayOf(STRING);

  const pairAt = (offset: number): IrExpr => ({
    kind: "arrayGet",
    arr: varRef(pairsLocal, pairsT, loc),
    index: offset === 0 ? varRef("i.0", F64, loc) : { kind: "bin", op: "+", left: varRef("i.0", F64, loc), right: numLit(offset, loc), type: F64, loc },
    type: STRING,
    loc,
  });
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: outLocal, init: { kind: "recordLit", fields: [], type: recT, loc }, loc },
    {
      kind: "for",
      init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
      cond: {
        kind: "bin", op: "<", left: varRef("i.0", F64, loc),
        right: { kind: "arrIntrinsic", method: "length", receiver: varRef(pairsLocal, pairsT, loc), args: [], type: F64, loc },
        type: BOOL, loc,
      },
      update: { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: varRef("i.0", F64, loc), right: numLit(2, loc), type: F64, loc }, loc },
      body: [{
        kind: "recordKeySet", obj: varRef(outLocal, recT, loc), shapeId, key: pairAt(0),
        value: { kind: "unionWrap", unionId: iv.unionId, tag: strTag, value: pairAt(1), type: iv, loc }, loc,
      }],
      loc,
    },
  ];
  if (statusLocal !== null) {
    const f64Tag = L.armTag(iv.unionId, F64);
    if (f64Tag < 0) return null;
    stmts.push({
      kind: "recordKeySet", obj: varRef(outLocal, recT, loc), shapeId,
      key: { kind: "strLit", value: ":status", type: STRING, loc },
      value: { kind: "unionWrap", unionId: iv.unionId, tag: f64Tag, value: varRef(statusLocal, F64, loc), type: iv, loc }, loc,
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
 * header slot `f64 | string | string[] | undefined` (types.ts's
 * HEADER-FAMILY canonicalization, rebuilt here for dyn-callback headers
 * with no static param type to read the shape from). */
function canonicalHeaderRecord(L: Lowerer): { type: IrType; shapeId: string } {
  const arms = [F64, STRING, arrayOf(STRING), UNDEFINED_T];
  arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  const slot: IrType = { kind: "union", unionId: L.unions.intern(arms) };
  const shapeId = L.shapes.intern([], false, slot, []);
  return { type: { kind: "record", shapeId }, shapeId };
}

function h2HeadersCallbackAdapter(
  L: Lowerer, node: ts.Expression, what: string,
  handleKind: "http2Stream" | null, withStatus: boolean, loc: SrcLoc,
): IrExpr {
  let cb = L.lowerExpr(node);
  const maxParams = (handleKind ? 1 : 0) + 1 /* headers */ + 1 /* flags */;
  // A checked-dynamic listener (test/common's mustCall wrapper — a dyn
  // value or an arguments-reading rest function of dyn params): wrap it
  // in a dynCheck to the CANONICAL event signature, then build the header
  // record and invoke through that typed boundary (handles box by
  // reference, the record boxes to a dyn object — the net server-callbacks
  // precedent). The synthesized record IS the shape the adapter builds.
  const handleT = handleKind === "http2Stream" ? HTTP2STREAM_T : null;
  const isDynCb = cb.type.kind === "dyn" ||
    (cb.type.kind === "func" && (cb.type.rest === true || cb.type.params.every((p) => p.kind === "dyn")) &&
      canBoxFuncIntoDyn(cb.type, (id) => L.shapes.get(id), (id) => L.unions.get(id)));
  if (isDynCb) {
    const rec = canonicalHeaderRecord(L);
    const tuple: IrType[] = [];
    if (handleT) tuple.push(handleT);
    tuple.push(rec.type);
    tuple.push(F64);
    const toT = funcOf(tuple, VOID);
    const boxed: IrExpr = cb.type.kind === "dyn" ? cb : { kind: "dynFrom", value: cb, type: DYN, loc };
    cb = { kind: "dynCheck", value: boxed, type: toT, loc };
  }
  if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > maxParams) {
    L.unsupported("SC1090", node, `${what} with more than ${maxParams} parameters or returning a value`);
  }
  const fromT = cb.type;
  const headersIdx = handleT ? 1 : 0;
  const shapeId = fromT.params.length > headersIdx ? headerParamShapeId(fromT, headersIdx) : null;
  if (fromT.params.length > headersIdx && shapeId === null) {
    L.unsupported("SC1090", node, `${what} whose headers parameter is not a header record (type it IncomingHttpHeaders)`);
  }
  // Runtime ABI params, in order.
  const abiParams: { localId: string; name: string; type: IrType }[] = [];
  if (handleT) abiParams.push({ localId: "h.0", name: "h", type: handleT });
  abiParams.push({ localId: "ps.0", name: "ps", type: arrayOf(STRING) });
  if (withStatus) abiParams.push({ localId: "st.0", name: "st", type: F64 });
  abiParams.push({ localId: "fl.0", name: "fl", type: F64 });
  const toT = funcOf(abiParams.map((p) => p.type), VOID);
  const key = `h2.hdrcb:${handleKind}:${withStatus}:${typeKey(fromT)}:${shapeId ?? ""}`;
  const existing = L.arrHofHelpers.get(key);
  const name = existing ?? `%h2.hdrcb.${L.arrHofHelpers.size}`;
  if (!existing) {
    L.arrHofHelpers.set(key, name);
    const impl = `${name}.impl`;
    const locals: import("../../ir/nodes.js").IrLocal[] = [
      { id: "f.0", name: "f", type: fromT, mutable: false, boxed: true },
      ...abiParams.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
    ];
    const body: IrStmt[] = [];
    let recordRef: IrExpr | null = null;
    if (shapeId !== null) {
      locals.push({ id: "out.0", name: "out", type: { kind: "record", shapeId }, mutable: false });
      locals.push({ id: "i.0", name: "i", type: F64, mutable: true });
      const stmts = h2HeaderRecordStmts(L, shapeId, "ps.0", "out.0", withStatus ? "st.0" : null, loc);
      if (stmts === null) L.unsupported("SC1090", node, `${what} whose headers parameter is not a supported header record`);
      body.push(...stmts!);
      recordRef = varRef("out.0", { kind: "record", shapeId }, loc);
    }
    // Assemble the user-call arguments in the user's declared order.
    const callArgs: IrExpr[] = [];
    const push = (e: IrExpr) => { if (callArgs.length < fromT.params.length) callArgs.push(e); };
    if (handleT) push(varRef("h.0", handleT, loc));
    if (recordRef) push(recordRef); else if (fromT.params.length > headersIdx) push(varRef("ps.0", arrayOf(STRING), loc));
    push(varRef("fl.0", F64, loc));
    body.push({
      kind: "exprStmt",
      expr: { kind: "callValue", callee: varRef("f.0", fromT, loc), args: callArgs.slice(0, fromT.params.length), type: fromT.ret, loc },
      loc,
    });
    L.liftedFns.push({ name: impl, params: abiParams, returnType: VOID, captures: [{ localId: "f.0", name: "f", type: fromT }], locals, body, loc });
    L.liftedFns.push({
      name, params: [{ localId: "f.0", name: "f", type: fromT }], returnType: toT,
      locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
      body: [{ kind: "return", value: { kind: "closure", fnName: impl, captures: ["f.0"], type: toT, loc }, loc }], loc,
    });
  }
  return { kind: "call", callee: name, args: [cb], type: toT, loc };
}

/** Builds the flat [name, value, ...] pairs array from an OutgoingHttp
 * Headers argument (an object literal with literal/pseudo keys, or a
 * header Record). Reuses lowerClientHeadersOption's shape. */
function lowerH2HeadersArg(L: Lowerer, node: ts.Expression): IrExpr {
  return lowerClientHeadersOption(L, node);
}

/** The STATICALLY-KNOWN key text of a header-object property: literal
 * identifier/string keys, plus COMPUTED keys that are a bare identifier
 * of string-literal type — `[PORTLESS_HEADER]: "1"` over a module const
 * (the portless proxy shape) is as static as spelling the name out, and
 * an identifier read has no side effects to drop. Null for genuinely
 * dynamic keys (the caller fences). */
function staticHeaderKeyOf(L: Lowerer, prop: ts.PropertyAssignment): string | null {
  if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) return prop.name.text;
  if (ts.isComputedPropertyName(prop.name) && ts.isIdentifier(prop.name.expression)) {
    const t = L.typeOf(prop.name.expression);
    if (t.isStringLiteralType()) return t.value;
  }
  return null;
}

/** Module-function calls on net import bindings: createServer(handler?),
 * connect/createConnection(port[, host][, cb]). Null for other modules
 * (the caller falls through to the ordinary builtin tables); every net
 * member lands here — unlowered ones fence with their module-qualified
 * name. */
export function lowerNetModuleCall(L: Lowerer, expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,): IrExpr | null {
  if (bi.module === "http") return lowerHttpModuleCall(L, expr, bi, loc);
  if (bi.module === "https") return lowerHttpsModuleCall(L, expr, bi, loc);
  if (bi.module === "tls") return lowerTlsModuleCall(L, expr, bi, loc);
  if (bi.module === "http2") return lowerHttp2ModuleCall(L, expr, bi, loc);
  if (bi.module !== "net") return null;
  // Members with ordinary surfaces.ts table entries (the autoselect
  // budget pair) ride the generic path — null hands the dispatch back.
  if (builtinModuleFnOf(L, "net", bi.member)) return null;
  const args = expr.arguments;
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
      if (isJsSourceFile(expr.getSourceFile())) {
        const t = L.mapTypeOf(L.typeOf(args[0]!));
        if (t !== null && (t.kind === "string" || t.kind === "f64" || t.kind === "bool")) {
          const raw = L.lowerExpr(args[0]!);
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
        L, args[0]!, "connection handlers", 1,
        (p) => p.kind === "netSocket",
        "use (socket) or ()",
        [NETSOCKET_T],
      );
      return { kind: "libCall", fn: "net.createServerCb", args: [cb], type: NETSERVER_T, loc };
    }
    L.noLowering(
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
      return lowerNetConnectOptions(L, expr, bi.member, loc);
    }
    // A RUNTIME option bag (a record binding or dyn value — the
    // invalid-input probes build theirs with computed keys): the
    // checked-dynamic walk validates Node-order and the compiler-rendered
    // fence is the post-validation tail.
    if (args.length === 1 && isJsSourceFile(expr.getSourceFile())) {
      const t = L.mapTypeOf(L.typeOf(args[0]!));
      if (t !== null && (t.kind === "dyn" || t.kind === "record")) {
        const raw = L.lowerExpr(args[0]!);
        if (raw.type.kind === "dyn" || L.dynConvertible(raw.type)) {
          const bag: IrExpr = raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
          return {
            kind: "libCall",
            fn: "net.connectOptsChk",
            args: [bag, ladderFenceExpr(L, `${bi.member} with a runtime options record`, expr,
              "pass the options as an object literal — port, host, autoSelectFamily, autoSelectFamilyAttemptTimeout, and lookup are the supported options")],
            type: NETSOCKET_T,
            loc,
          };
        }
      }
    }
    if (args.length < 1 || args.length > 3) {
      L.noLowering(
        `${bi.member} with ${args.length} arguments`,
        expr,
        `the supported form is ${bi.member}(port, host?, connectListener?)`,
      );
    }
    const port = L.lowerExprExpecting(args[0]!, F64);
    // The optional middle host: a 2-arg call's second argument is the
    // host when string-typed, the connect listener when func-typed.
    let hostNode: ts.Expression | undefined;
    let cbNode: ts.Expression | undefined;
    if (args.length === 2) {
      if (L.mapTypeOf(L.typeOf(args[1]!))?.kind === "string") hostNode = args[1];
      else cbNode = args[1];
    } else if (args.length === 3) {
      hostNode = args[1];
      cbNode = args[2];
    }
    const host: IrExpr = hostNode
      ? L.lowerExprExpecting(hostNode, STRING)
      : { kind: "strLit", value: "localhost", type: STRING, loc };
    if (!cbNode) {
      return { kind: "libCall", fn: "net.connect", args: [port, host], type: NETSOCKET_T, loc };
    }
    const { cb } = lowerCallbackArg(
      L, cbNode, "connect listeners", 0,
      () => false,
      "use ()",
        [],
    );
    return { kind: "libCall", fn: "net.connectCb", args: [port, host, cb], type: NETSOCKET_T, loc };
  }
  L.noLowering(
    `net.${bi.member}`,
    expr,
    "createServer, connect, and createConnection are the lowered net module functions",
    L.resolveValueSymbol(expr.expression as ts.Identifier),
  );
}

/** True when `t` is the lookup-function shape the connect lowering
 * accepts: (hostname: string, options: unknown, callback) => void where
 * callback is (err: <union with a null arm>, addresses: { address:
 * string, ... }[]) => void — Node's net.LookupFunction as portless
 * declares it. */
function lookupFnShapeOk(L: Lowerer, t: IrType): boolean {
  if (t.kind !== "func" || t.ret.kind !== "void" || t.params.length !== 3) return false;
  if (t.params[0]!.kind !== "string") return false;
  if (t.params[1]!.kind !== "dyn") return false;
  const cbT = t.params[2]!;
  if (cbT.kind !== "func" || cbT.ret.kind !== "void" || cbT.params.length !== 2) return false;
  const errT = cbT.params[0]!;
  if (errT.kind !== "union") return false;
  const errDef = L.unions.get(errT.unionId);
  if (!errDef || !errDef.arms.some((a) => a.kind === "nullT")) return false;
  // Every non-null arm must be the Error root: the emitted answer thunk
  // reads .message off a non-null payload.
  if (!errDef.arms.every((a) => a.kind === "nullT" || (a.kind === "object" && a.className === "%Error"))) {
    return false;
  }
  const addrsT = cbT.params[1]!;
  if (addrsT.kind !== "array" || addrsT.elem.kind !== "record") return false;
  const shape = L.shapes.get(addrsT.elem.shapeId);
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
function lowerNetConnectOptions(L: Lowerer, expr: ts.CallExpression, member: string, loc: SrcLoc): IrExpr {
  const args = expr.arguments;
  const optsNode = args[0] as ts.ObjectLiteralExpression;
  const isJs = isJsSourceFile(expr.getSourceFile());
  // The checked-dynamic option-bag route (JS sources): a literal with
  // computed keys (the invalid-input probes' spelling) or an objectMode-
  // trio member rides WHOLE to the runtime walk — Node's Socket-ctor
  // validation order (the trio's ERR_INVALID_ARG_VALUE first, then
  // port/host/autoSelectFamily), with the compiler-rendered fence as the
  // post-validation tail.
  if (isJs) {
    const needsBag = optsNode.properties.some((p) =>
      (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) ||
      (ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name)) ||
      ["objectMode", "readableObjectMode", "writableObjectMode"].includes(
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "",
      ),
    );
    if (needsBag) {
      const raw = L.lowerExpr(optsNode);
      if (raw.type.kind === "dyn" || L.dynConvertible(raw.type)) {
        const bag: IrExpr = raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
        return {
          kind: "libCall",
          fn: "net.connectOptsChk",
          args: [bag, ladderFenceExpr(L, `${member} with these options`, optsNode,
            "port, host, autoSelectFamily, autoSelectFamilyAttemptTimeout, and lookup are the supported options")],
          type: NETSOCKET_T,
          loc,
        };
      }
    }
  }
  let port: IrExpr | null = null;
  let host: IrExpr | null = null;
  let lookup: IrExpr | null = null;
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
  for (const prop of optsNode.properties) {
    let initializer: ts.Expression | null;
    if (ts.isPropertyAssignment(prop) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
      initializer = prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      initializer = null;
    } else {
      L.noLowering(
        `${member} options with computed keys or spreads`,
        prop,
        "each option must be a plain `name: value` (or shorthand) entry with a literal key",
      );
    }
    const key = (prop.name as ts.Identifier | ts.StringLiteral).text;
    const lowerVal = (): IrExpr =>
      initializer !== null
        ? L.lowerExpr(initializer)
        : L.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
    if (key === "port") {
      port = lowerVal();
      if (port.type.kind !== "f64") {
        L.noLowering(`a ${member} 'port' option of '${L.fmt(port.type)}' values`, prop, "the port is a number here");
      }
    } else if (key === "host") {
      host = lowerVal();
      if (host.type.kind !== "string") {
        // A provably-non-string host (the invalid-input probes): Node's
        // lookupAndConnect throws ERR_INVALID_ARG_TYPE at connect time.
        if (isJs && (host.type.kind === "dyn" || L.dynConvertible(host.type))) {
          optionThrow ??= propThrow("options.host", "of type string", host);
          host = null;
          continue;
        }
        L.noLowering(`a ${member} 'host' option of '${L.fmt(host.type)}' values`, prop, "the host is a string here");
      }
    } else if (key === "autoSelectFamily") {
      // The literal `true` only: it is what licenses the try-each-address
      // dial below (false/dynamic would mean Node's single-address dial,
      // which the lookup form does not implement).
      if (initializer === null || initializer.kind !== ts.SyntaxKind.TrueKeyword) {
        // A provably-non-boolean value throws Node's validateBoolean
        // ladder instead of fencing.
        const raw = initializer !== null && isJs ? L.lowerExpr(initializer) : null;
        if (raw !== null && raw.type.kind !== "bool" &&
            (raw.type.kind === "dyn" || L.dynConvertible(raw.type))) {
          optionThrow ??= propThrow("options.autoSelectFamily", "of type boolean", raw);
          continue;
        }
        L.noLowering(
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
      if (!(raw.type.kind === "dyn" || raw.kind === "unitLit" || L.dynConvertible(raw.type))) {
        L.noLowering(
          `a ${member} 'autoSelectFamilyAttemptTimeout' option of '${L.fmt(raw.type)}' values`,
          prop,
          "the budget is a number here",
        );
      }
      attempt = raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
    } else if (key === "lookup") {
      if (initializer === null) {
        L.noLowering(`${member} with a shorthand lookup option`, prop, "spell it out: lookup: theResolver");
      }
      lookup = L.lowerExpr(initializer);
      if (!lookupFnShapeOk(L, lookup.type)) {
        L.noLowering(
          `a ${member} 'lookup' option of '${L.fmt(lookup.type)}' values`,
          prop,
          "the lowered resolver is (hostname: string, options: unknown, callback: (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void) => void",
        );
      }
    } else {
      L.noLowering(
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
    L.noLowering(
      `${member} options without a port`,
      optsNode,
      "the supported options object is { port, host?, autoSelectFamily?, lookup? }",
    );
  }
  host ??= { kind: "strLit", value: "localhost", type: STRING, loc };
  if (attempt !== null) {
    if (lookup !== null || args.length !== 1) {
      L.noLowering(
        `${member} with an autoSelectFamilyAttemptTimeout beside a lookup or connect listener`,
        expr,
        "the validated-budget form is the bare options call — register listeners separately",
      );
    }
    return { kind: "libCall", fn: "net.connectAttempt", args: [port, host, attempt], type: NETSOCKET_T, loc };
  }
  if (lookup !== null) {
    if (!autoSelect) {
      L.noLowering(
        `${member} with a lookup but no autoSelectFamily: true`,
        optsNode,
        "the lookup form dials every answered address in order — Node does that under autoSelectFamily: true, so spell it",
      );
    }
    if (args.length !== 1) {
      L.noLowering(
        `${member} with a lookup and a connect listener`,
        expr,
        "register the listener separately: socket.once('connect', ...)",
      );
    }
    return { kind: "libCall", fn: "net.connectLookup", args: [port, host, lookup], type: NETSOCKET_T, loc };
  }
  if (args.length === 1) {
    return { kind: "libCall", fn: "net.connect", args: [port, host], type: NETSOCKET_T, loc };
  }
  if (args.length !== 2) {
    L.noLowering(
      `${member} with ${args.length} arguments`,
      expr,
      `the supported form is ${member}(options[, connectListener])`,
    );
  }
  const { cb } = lowerCallbackArg(
    L, args[1]!, "connect listeners", 0,
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
function lowerServerCloseBind(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text !== "bind") return null;
  const closeAccess = access.expression;
  if (!ts.isPropertyAccessExpression(closeAccess) || closeAccess.name.text !== "close") return null;
  if (L.mapTypeOf(L.typeOf(closeAccess.expression))?.kind !== "netServer") return null;
  if (!L.isStdlibMember(closeAccess)) return null;
  const loc = locOf(call);
  const recvNode = closeAccess.expression;
  const thisArg = call.arguments[0];
  if (
    call.arguments.length !== 1 ||
    !thisArg ||
    !ts.isIdentifier(recvNode) ||
    !ts.isIdentifier(thisArg) ||
    L.resolveValueSymbol(recvNode) !== L.resolveValueSymbol(thisArg)
  ) {
    L.noLowering(
      "close.bind with this argument shape",
      call,
      "the supported form is server.close.bind(server) — the same server binding on both sides",
    );
  }
  const server = L.lowerExpr(thisArg);
  const t = L.mapTypeOf(L.typeOf(call));
  const cbUnion = t?.kind === "func" && t.params.length === 1 ? t.params[0]! : null;
  const cbOk =
    cbUnion?.kind === "union" &&
    (() => {
      const def = L.unions.get(cbUnion.unionId);
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
    L.noLowering(
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
export function lowerServerCloseOverrideAssignment(L: Lowerer, left: ts.Expression,
  right: ts.Expression, loc: SrcLoc,): IrStmt | null {
  if (!ts.isPropertyAccessExpression(left) || left.questionDotToken) return null;
  if (left.name.text !== "close") return null;
  if (L.mapTypeOf(L.typeOf(left.expression))?.kind !== "netServer") return null;
  const server = L.lowerExpr(left.expression);
  const value = L.lowerExpr(right);
  const t = value.type;
  const cbUnion = t.kind === "func" && t.params.length === 1 ? t.params[0]! : null;
  const shapeOk =
    cbUnion?.kind === "union" &&
    (t.kind === "func" && (t.ret.kind === "netServer" || t.ret.kind === "void")) &&
    (() => {
      const def = L.unions.get(cbUnion.unionId);
      return (
        !!def &&
        def.arms.some((a) => a.kind === "func" && a.params.length <= 1 && a.ret.kind === "void") &&
        def.arms.some((a) => a.kind === "undefinedT")
      );
    })();
  if (!shapeOk) {
    L.noLowering(
      "assigning this value to server.close",
      right,
      "the override must be a (callback?: (err?: Error) => void) => Server function",
    );
  }
  return {
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "net.serverSetCloseOverride", args: [server, value], type: VOID, loc },
    loc,
  };
}

/** `res.statusCode = 404` / `res.statusMessage = "Nope"` — Node's
 * writable ServerResponse properties (the implicit head reads them):
 * routed from lower-stmts' property-assignment path beside the
 * close-override hook. Null when the target isn't one of the two. */
export function lowerHttpResPropertyAssignment(L: Lowerer, left: ts.Expression,
  right: ts.Expression, loc: SrcLoc,): IrStmt | null {
  if (!ts.isPropertyAccessExpression(left) || left.questionDotToken) return null;
  const name = left.name.text;
  if (name !== "statusCode" && name !== "statusMessage") return null;
  if (L.mapTypeOf(L.typeOf(left.expression))?.kind !== "httpRes") return null;
  if (!L.isStdlibMember(left)) return null;
  const receiver = L.lowerExpr(left.expression);
  const value = name === "statusCode"
    ? L.lowerExprExpecting(right, F64)
    : L.lowerExprExpecting(right, STRING);
  const fn: IrLibFn = name === "statusCode" ? "http.resStatusSet" : "http.resStatusMsgSet";
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
export function lowerHttpServerTimeoutAssignment(L: Lowerer, left: ts.Expression,
  right: ts.Expression, loc: SrcLoc,): IrStmt | null {
  if (!ts.isPropertyAccessExpression(left) || left.questionDotToken) return null;
  const field = httpServerTimeoutField(left.name.text);
  if (field === null) return null;
  if (L.mapTypeOf(L.typeOf(left.expression))?.kind !== "netServer") return null;
  if (!L.isStdlibMember(left)) return null;
  const receiver = handleReceiver(L, left.expression, NETSERVER_T);
  const selector: IrExpr = { kind: "numLit", value: field, type: F64, loc };
  const value = L.lowerExprExpecting(right, F64);
  return {
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "http.serverTimeoutSet", args: [receiver, selector, value], type: VOID, loc },
    loc,
  };
}

/** Method calls on net.Server receivers: listen(port[, cb]), close([cb]),
 * on/once("connection" | "error" | "close", cb). address() alone fences
 * toward the composed address().port read. Null for other receivers. */
function lowerNetServerMethodCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,): IrExpr | null {
  if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "netServer") return null;
  if (!L.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  if (name === "listen") {
    if (args.length < 1 || args.length > 3) {
      L.noLowering(
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
      return receiverReturningCall(L, fn, callArgs, NETSERVER_T, loc);
    };
    const receiver = handleReceiver(L, access.expression, NETSERVER_T);
    // The options-object form — listen({ port, host?, ipv6Only? }[, cb]),
    // the portless listenOnProxyInterface shape: host binds that ONE
    // address (an IP literal — the runtime has no resolver here; absent
    // = Node's host-less dual-stack any), ipv6Only sets IPV6_V6ONLY
    // (truthiness, like Node's option handling — `boolean | undefined`
    // flows). Every other key fences by name.
    if (ts.isObjectLiteralExpression(args[0]!)) {
      let port: IrExpr | null = null;
      let host: IrExpr | null = null;
      let v6only: IrExpr | null = null;
      for (const prop of (args[0] as ts.ObjectLiteralExpression).properties) {
        let initializer: ts.Expression | null;
        if (ts.isPropertyAssignment(prop) &&
            (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
          initializer = prop.initializer;
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          initializer = null;
        } else {
          L.noLowering(
            "listen options with computed keys or spreads",
            prop,
            "each option must be a plain `name: value` (or shorthand) entry with a literal key",
          );
        }
        const key = (prop.name as ts.Identifier | ts.StringLiteral).text;
        if (key === "port") {
          port = initializer !== null
            ? L.lowerExpr(initializer)
            : L.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
          if (port.type.kind !== "f64") {
            L.noLowering(`a listen 'port' option of '${L.fmt(port.type)}' values`, prop, "the port is a number here");
          }
        } else if (key === "host") {
          host = initializer !== null
            ? L.lowerExpr(initializer)
            : L.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
          if (host.type.kind !== "string") {
            L.noLowering(`a listen 'host' option of '${L.fmt(host.type)}' values`, prop, "the host is an IP string here");
          }
        } else if (key === "ipv6Only") {
          if (initializer !== null) {
            v6only = L.lowerCondition(initializer); /* truthiness: `boolean | undefined` flows */
          } else {
            const v = L.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
            if (v.type.kind !== "bool") {
              L.noLowering(
                `a listen 'ipv6Only' option of '${L.fmt(v.type)}' values`,
                prop,
                "spell the option out (ipv6Only: value) so non-boolean values can narrow",
              );
            }
            v6only = v;
          }
        } else if (key === "signal" && ts.isPropertyAssignment(prop) &&
                   isJsSourceFile(call.getSourceFile())) {
          // A provably-non-AbortSignal signal (the invalid-input probes:
          // strings, numbers, plain records) throws Node's
          // validateAbortSignal ladder; plausible signal values keep the
          // fence — abort-driven close has no lowering yet.
          const raw = L.lowerExpr(prop.initializer);
          const provablyNot = raw.type.kind === "string" || raw.type.kind === "f64" ||
            raw.type.kind === "bool" || raw.type.kind === "record" || raw.type.kind === "array";
          if (provablyNot && L.dynConvertible(raw.type)) {
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
          L.noLowering(
            `listen option 'signal'`,
            prop,
            "abort-driven close has no lowering yet — port, host, and ipv6Only are the supported listen options",
          );
        } else {
          L.noLowering(
            `listen option '${key}'`,
            prop,
            "port, host, and ipv6Only are the supported listen options",
          );
        }
      }
      if (port === null) {
        L.noLowering(
          "listen options without a port",
          args[0]!,
          "the supported options object is { port, host?, ipv6Only? } — port 0 binds an ephemeral port",
        );
      }
      host ??= { kind: "strLit", value: "", type: STRING, loc }; /* "" = the dual-stack any default */
      v6only ??= boolLit(false, loc);
      if (args.length === 1) {
        return listenResult("net.listenOpts", [receiver, port, host, v6only]);
      }
      // The callback may be an OPTIONAL binding — `(() => void) |
      // undefined`, portless's listenOnProxyInterface pass-through: the
      // emitter unwraps the union (the SNICallback conditional-spread
      // pattern) and the runtime takes NULL for the undefined arm. A
      // checked-dynamic callback (a JS wrapper value) adapts through the
      // dynCheck function boundary.
      let cbV = L.lowerExpr(args[1]!);
      if (cbV.type.kind === "dyn") {
        cbV = { kind: "dynCheck", value: cbV, type: funcOf([], VOID), loc };
      }
      const cbFuncOk = (t: IrType): boolean =>
        t.kind === "func" && t.params.length === 0 && t.ret.kind === "void";
      const cbOk =
        cbFuncOk(cbV.type) ||
        (cbV.type.kind === "union" &&
          (() => {
            const def = L.unions.get((cbV.type as IrType & { kind: "union" }).unionId);
            return (
              !!def &&
              def.arms.length === 2 &&
              def.arms.some(cbFuncOk) &&
              def.arms.some((a) => a.kind === "undefinedT")
            );
          })());
      if (!cbOk) {
        L.unsupported(
          "SC1090",
          args[1]!,
          `listen callbacks of type '${L.fmt(cbV.type)}' (use () — an optional \`(() => void) | undefined\` binding also flows)`,
        );
      }
      return listenResult("net.listenOptsCb", [receiver, port, host, v6only, cbV]);
    }
    const port = L.lowerExprExpecting(args[0]!, F64);
    // The optional middle host — listen(port, '127.0.0.1'[, cb]): a
    // string-typed second argument is the bind address (the net.connect
    // disambiguation), routed through the options-form entry.
    let hostNode: ts.Expression | undefined;
    let cbNode: ts.Expression | undefined;
    if (args.length === 2) {
      if (L.mapTypeOf(L.typeOf(args[1]!))?.kind === "string") hostNode = args[1];
      else cbNode = args[1];
    } else if (args.length === 3) {
      hostNode = args[1];
      cbNode = args[2];
    }
    if (hostNode !== undefined) {
      const host = L.lowerExprExpecting(hostNode, STRING);
      const v6only = boolLit(false, loc);
      if (!cbNode) return listenResult("net.listenOpts", [receiver, port, host, v6only]);
      const { cb } = lowerCallbackArg(L, cbNode, "listen callbacks", 0, () => false, "use ()", []);
      return listenResult("net.listenOptsCb", [receiver, port, host, v6only, cb]);
    }
    if (!cbNode) {
      return listenResult("net.listen", [receiver, port]);
    }
    const { cb } = lowerCallbackArg(L, cbNode, "listen callbacks", 0, () => false, "use ()", []);
    return listenResult("net.listenCb", [receiver, port, cb]);
  }
  if (name === "close") {
    requireStatementPosition(L, call, "server.close(...)");
    if (args.length > 1) {
      L.noLowering(`close with ${args.length} arguments`, call, "the supported form is close([callback])");
    }
    const receiver = handleReceiver(L, access.expression, NETSERVER_T);
    if (args.length === 0) {
      return { kind: "libCall", fn: "net.serverClose", args: [receiver], type: VOID, loc };
    }
    const { cb } = lowerCallbackArg(L, args[0]!, "close callbacks", 0, () => false, "use ()", []);
    return { kind: "libCall", fn: "net.serverCloseCb", args: [receiver, cb], type: VOID, loc };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    requireStatementPosition(L, call, `server.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = L.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const receiver = handleReceiver(L, access.expression, NETSERVER_T);
    if (event === "connection" || event === "secureConnection") {
      // 'secureConnection' rides the same list: a TLS server's
      // 'connection' listeners are DEFERRED to handshake completion
      // (scr_net_server_defer_connections), which IS Node's
      // secureConnection timing; on a plain net server the name would
      // never fire in Node either — the runtime entry gates on the
      // deferral flag so the split stays exact.
      const { cb } = lowerCallbackArg(
        L, args[1]!, `${event} listeners`, 1,
        (p) => p.kind === "netSocket",
        "use (socket) or ()",
        [NETSOCKET_T],
      );
      const fn: IrLibFn = event === "connection" ? "net.serverOnConnection" : "net.serverOnSecureConnection";
      return { kind: "libCall", fn, args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "error") {
      const { cb } = lowerCallbackArg(
        L, args[1]!, "error listeners", 1,
        (p) => p.kind === "object" && p.className === "%Error",
        "use (err) or ()",
        [ERROR_T],
      );
      return { kind: "libCall", fn: "net.serverOnError", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "close") {
      const { cb } = lowerCallbackArg(L, args[1]!, "close listeners", 0, () => false, "use ()", []);
      return { kind: "libCall", fn: "net.serverOnClose", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "listening") {
      // The deferred bind emit — listen(port, cb)'s event twin: fires
      // once after a successful listen; late registrations on an
      // already-listening server never fire (Node's once-per-listen).
      const { cb } = lowerCallbackArg(L, args[1]!, "listening listeners", 0, () => false, "use ()", []);
      return { kind: "libCall", fn: "net.serverOnListening", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "request") {
      // The 'request' event — http.createServer(handler)'s event twin, and
      // the way an http2 allowHTTP1 server (created handler-less) gets its
      // handler. Same (req, res) shapes as the createServer callback; on a
      // server with no HTTP parser (net.createServer) the registration is
      // Node-honest dead weight: the event never fires there either.
      const cb = lowerRequestHandlerArg(L, args[1]!);
      return { kind: "libCall", fn: "http.serverOnRequest", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "stream") {
      // The h2c server's request event: (stream, headers, flags). The
      // adapter builds the headers record from the pairs the runtime
      // hands over. Dead weight on a non-h2 server (never fires).
      const cb = h2HeadersCallbackAdapter(L, args[1]!, "stream listeners", "http2Stream", false, loc);
      return { kind: "libCall", fn: "http2.serverOnStream", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "session") {
      // The h2c server's per-connection session event: (session). The
      // result is voidized; the handle passes by reference.
      const { cb } = lowerCallbackArg(
        L, args[1]!, "session listeners", 1,
        (p) => p.kind === "http2Session",
        "use (session) or ()",
        [HTTP2SESSION_T],
      );
      return { kind: "libCall", fn: "http2.serverOnSession", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "connect") {
      // HTTP CONNECT — the tunneling handover: (req, socket, head), fired
      // INSTEAD of 'request' for CONNECT-method requests (the 'upgrade'
      // machinery's twin; no listener destroys the socket, Node's
      // default). An allowHTTP1 server supplies a raw socket for HTTP/1.1
      // CONNECT and an Http2ServerResponse for valid traditional/extended
      // HTTP/2 CONNECT, so portless's union-typed listener selects the
      // protocol arm with `instanceof net.Socket`.
      const cb = L.lowerExpr(args[1]!);
      if (cb.type.kind !== "func" || cb.type.params.length > 3) {
        L.unsupported(
          "SC1090",
          args[1]!,
          "connect listeners with more than three parameters (use (req, socket, head))",
        );
      }
      if (cb.type.ret.kind !== "void") {
        L.unsupported(
          "SC1090",
          args[1]!,
          "connect listeners returning a value (make the callback body a block)",
        );
      }
      const [p0, p1, p2] = cb.type.params;
      const sockParamOk = (t: IrType): boolean => {
        if (t.kind === "netSocket") return true;
        if (t.kind !== "union") return false;
        const def = L.unions.get(t.unionId);
        return !!def && def.arms.some((a) => a.kind === "netSocket");
      };
      if (
        (p0 !== undefined && p0.kind !== "httpReq") ||
        (p1 !== undefined && !sockParamOk(p1)) ||
        (p2 !== undefined && !(p2.kind === "bytes" && p2.elem === "u8"))
      ) {
        L.unsupported(
          "SC1090",
          args[1]!,
          "connect listeners whose parameters are not (req: IncomingMessage, socket: Socket — or a union carrying the Socket arm, the h2 compat shape, head: Buffer)",
        );
      }
      return { kind: "libCall", fn: "http.serverOnConnect", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "upgrade") {
      // The WebSocket handover: (req, socket, head) — Node fires it
      // INSTEAD of 'request' for Connection: upgrade requests, hands the
      // socket over raw with the bytes read past the head, and destroys
      // the socket when no listener exists. Registration works on every
      // server kind (a parserless net server never fires it, like Node).
      const cb = L.lowerExpr(args[1]!);
      if (cb.type.kind !== "func" || cb.type.params.length > 3) {
        L.unsupported(
          "SC1090",
          args[1]!,
          "upgrade listeners with more than three parameters (use (req, socket, head))",
        );
      }
      if (cb.type.ret.kind !== "void") {
        L.unsupported(
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
        L.unsupported(
          "SC1090",
          args[1]!,
          "upgrade listeners whose parameters are not (req: IncomingMessage, socket: Socket, head: Buffer)",
        );
      }
      return { kind: "libCall", fn: "http.serverOnUpgrade", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "sessionError") {
      const cb = L.lowerExpr(args[1]!);
      if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 2) {
        L.unsupported(
          "SC1090",
          args[1]!,
          "sessionError listeners with more than two parameters or returning a value",
        );
      }
      const [err, session] = cb.type.params;
      if ((err !== undefined && !(err.kind === "object" && err.className === "%Error")) ||
          (session !== undefined && session.kind !== "http2Session")) {
        L.unsupported(
          "SC1090",
          args[1]!,
          "sessionError listeners whose parameters are not (error: Error, session: ServerHttp2Session)",
        );
      }
      return { kind: "libCall", fn: "http2.serverOnSessionError", args: [receiver, cb, once], type: VOID, loc };
    }
    L.noLowering(
      `server.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
      args[0]!,
      '"connection", "request", "stream", "session", "upgrade", "connect", "error", "close", "listening", and "sessionError" are the supported server events (as literals)',
    );
  }
  if (name === "emit") {
    // The demux route: emit("connection", socket) hands an accepted
    // socket to ANOTHER server (portless's first-byte TLS peek). Only
    // the literal "connection" form lowers; Node's boolean result is
    // dropped (statement position required).
    requireStatementPosition(L, call, "server.emit(...)");
    const evT = args.length >= 1 ? L.typeOf(args[0]!) : null;
    const event = evT?.isStringLiteralType() ? evT.value : null;
    if (event !== "connection" || args.length !== 2) {
      L.noLowering(
        `server.emit(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
        call,
        'emit("connection", socket) is the supported emit form (the demux route)',
      );
    }
    const receiver = handleReceiver(L, access.expression, NETSERVER_T);
    const sock = L.lowerExpr(args[1]!);
    if (sock.type.kind !== "netSocket") {
      L.noLowering(
        `emit("connection", …) with a '${L.fmt(sock.type)}' argument`,
        args[1]!,
        "the second argument must be a net socket",
      );
    }
    return { kind: "libCall", fn: "net.serverEmitConnection", args: [receiver, sock], type: VOID, loc };
  }
  if (name === "address") {
    // The full AddressInfo record (the dgram.address materialization).
    // The composed `server.address().port` read already lowered through
    // the property path; this is the record-valued remainder (`const a =
    // server.address()` — the listen-callback shape).
    if (args.length !== 0) {
      L.noLowering(`address with ${args.length} arguments`, call, "address() takes no arguments");
    }
    const result = L.mapTypeOf(L.typeOf(call));
    if (!result || !isAddressInfoRecord(L, result)) {
      L.noLowering(
        "address() where the result is not the {address, family, port} record",
        call,
        "the AddressInfo shape is the supported result",
      );
    }
    const receiver = handleReceiver(L, access.expression, NETSERVER_T);
    return { kind: "libCall", fn: "net.serverAddress", args: [receiver], type: result, loc };
  }
  L.noLowering(
    `Server.${name}`,
    call,
    "listen, close, address().port, emit(\"connection\", socket), and on/once of connection/request/upgrade/error/close/listening/sessionError are the supported Server members",
    L.checker.getSymbolAtLocation(access.name),
  );
}

/** Method calls on net.Socket receivers: write/end/destroy/pipe and
 * on/once("data" | "end" | "close" | "error" | "connect"). Null for
 * other receivers. */
function lowerNetSocketMethodCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,): IrExpr | null {
  if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "netSocket") return null;
  if (!L.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  if (name === "write" || name === "end") {
    requireStatementPosition(L, call, `socket.${name}(...)`);
    // write(chunk, encoding) — the two-argument encoding form: 'buffer'
    // beside a string chunk is Node's stream_base typecheck ("Second
    // argument must be a buffer", thrown synchronously on an established
    // socket — the invalid-input probes' shape); utf8 spellings are the
    // plain write (that IS the encoding written); a Buffer chunk ignores
    // the encoding like Node does. Other encodings keep the fence.
    if (name === "write" && args.length === 2) {
      const encT = L.typeOf(args[1]!);
      const chunkT = L.mapTypeOf(L.typeOf(args[0]!));
      if (encT.isStringLiteralType() && chunkT !== null) {
        if (encT.value === "buffer" && chunkT.kind === "string" &&
            isJsSourceFile(call.getSourceFile())) {
          L.lowerExpr(args[0]!); // evaluation order (effect-free in practice)
          return nodeThrowExpr(1, "ERR_INVALID_ARG_TYPE", "Second argument must be a buffer", VOID, loc);
        }
        const passthrough =
          (chunkT.kind === "string" && (encT.value === "utf8" || encT.value === "utf-8")) ||
          (chunkT.kind === "bytes" && chunkT.elem === "u8");
        if (passthrough) {
          const receiver2 = handleReceiver(L, access.expression, NETSOCKET_T);
          const data2 = L.lowerExpr(args[0]!);
          const fn: IrLibFn = data2.type.kind === "string" ? "net.sockWrite" : "net.sockWriteBytes";
          return { kind: "libCall", fn, args: [receiver2, data2], type: VOID, loc };
        }
      }
    }
    const maxArgs = name === "write" ? 1 : 1;
    const minArgs = name === "write" ? 1 : 0;
    if (args.length < minArgs || args.length > maxArgs) {
      L.noLowering(
        `${name} with ${args.length} arguments`,
        call,
        name === "write"
          ? "the supported form is write(data) — one string or Buffer"
          : "the supported forms are end() and end(data)",
      );
    }
    const receiver = handleReceiver(L, access.expression, NETSOCKET_T);
    if (args.length === 0) {
      return { kind: "libCall", fn: "net.sockEnd", args: [receiver], type: VOID, loc };
    }
    const data = L.lowerExpr(args[0]!);
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
    L.noLowering(`${name} of '${L.fmt(data.type)}' data`, args[0] ?? call, NARROW_DATA_HINT);
  }
  if (name === "destroy") {
    requireStatementPosition(L, call, "socket.destroy()");
    if (args.length !== 0) {
      L.noLowering(`destroy with ${args.length} arguments`, call, "destroy() takes no arguments here");
    }
    const receiver = handleReceiver(L, access.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockDestroy", args: [receiver], type: VOID, loc };
  }
  if (name === "setEncoding") {
    // The req twin: utf8 flips 'data' delivery to strings.
    requireStatementPosition(L, call, "socket.setEncoding(...)");
    if (args.length !== 1) {
      L.noLowering(`setEncoding with ${args.length} arguments`, call, "the supported form is setEncoding(encoding)");
    }
    const receiver = handleReceiver(L, access.expression, NETSOCKET_T);
    const enc = L.lowerExprExpecting(args[0]!, STRING);
    return { kind: "libCall", fn: "net.sockSetEncoding", args: [receiver, enc], type: VOID, loc };
  }
  if (name === "setTimeout") {
    requireStatementPosition(L, call, "socket.setTimeout(...)");
    if (args.length !== 1) {
      L.noLowering(
        `setTimeout with ${args.length} arguments`,
        call,
        "the supported form is setTimeout(ms) — register the callback separately: socket.once('timeout', ...)",
      );
    }
    const receiver = handleReceiver(L, access.expression, NETSOCKET_T);
    const ms = L.lowerExprExpecting(args[0]!, F64);
    return { kind: "libCall", fn: "net.sockSetTimeout", args: [receiver, ms], type: VOID, loc };
  }
  if (name === "pause" || name === "resume") {
    // Flow control (the struct's flag comments in scr_net.c): pause holds
    // reads off — kernel/TCP backpressure is the buffer; resume flows
    // (and discards sans listeners, so 'end' is reachable). Both answer
    // the socket, Node's chaining.
    if (args.length !== 0) {
      L.noLowering(`${name} with ${args.length} arguments`, call, `the form is ${name}()`);
    }
    const receiver = handleReceiver(L, access.expression, NETSOCKET_T);
    const fn: IrLibFn = name === "pause" ? "net.sockPause" : "net.sockResume";
    return { kind: "libCall", fn, args: [receiver], type: NETSOCKET_T, loc };
  }
  if (name === "setNoDelay") {
    // TCP_NODELAY on the live fd; missing/undefined means true (Node).
    // Answers the socket, Node's chaining.
    if (args.length > 1) {
      L.noLowering(`setNoDelay with ${args.length} arguments`, call, "the form is setNoDelay(noDelay?)");
    }
    const receiver = handleReceiver(L, access.expression, NETSOCKET_T);
    const enable: IrExpr = args.length === 1
      ? L.lowerExprExpecting(args[0]!, BOOL)
      : boolLit(true, loc);
    return { kind: "libCall", fn: "net.sockSetNoDelay", args: [receiver, enable], type: NETSOCKET_T, loc };
  }
  if (name === "destroySoon") {
    // end() now, destroy once the FIN actually flushed — Node's
    // 'finish'-then-destroy.
    requireStatementPosition(L, call, "socket.destroySoon()");
    if (args.length !== 0) {
      L.noLowering(`destroySoon with ${args.length} arguments`, call, "the form is destroySoon()");
    }
    const receiver = handleReceiver(L, access.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockDestroySoon", args: [receiver], type: VOID, loc };
  }
  if (name === "read") {
    // socket.read(n?) — the demux peek. Answers the interned
    // `Buffer | null` union: exactly n buffered bytes, or null (Node's
    // less-than-n answer); read() drains the whole buffer.
    if (args.length > 1) {
      L.noLowering(`read with ${args.length} arguments`, call, "the supported forms are read() and read(n)");
    }
    const receiver = handleReceiver(L, access.expression, NETSOCKET_T);
    const n: IrExpr = args.length === 1
      ? L.lowerExprExpecting(args[0]!, F64)
      : { kind: "numLit", value: 0, type: F64, loc };
    const type: IrType = { kind: "union", unionId: L.unions.intern([BYTES_U8, NULL_T]) };
    return { kind: "libCall", fn: "net.sockRead", args: [receiver, n], type, loc };
  }
  if (name === "unshift") {
    requireStatementPosition(L, call, "socket.unshift(...)");
    if (args.length !== 1) {
      L.noLowering(`unshift with ${args.length} arguments`, call, "the supported form is unshift(buffer)");
    }
    const receiver = handleReceiver(L, access.expression, NETSOCKET_T);
    const data = L.lowerExpr(args[0]!);
    if (data.type.kind !== "bytes" || data.type.elem !== "u8") {
      L.noLowering(
        `unshift of '${L.fmt(data.type)}' data`,
        args[0]!,
        "unshift takes one Buffer/Uint8Array (narrow unions first — the read(1) result needs its null arm checked)",
      );
    }
    return { kind: "libCall", fn: "net.sockUnshift", args: [receiver, data], type: VOID, loc };
  }
  if (name === "pipe") {
    requireStatementPosition(L, call, "socket.pipe(...)");
    if (args.length !== 1) {
      L.noLowering(`pipe with ${args.length} arguments`, call, "the supported form is pipe(destination)");
    }
    const receiver = handleReceiver(L, access.expression, NETSOCKET_T);
    const dst = L.lowerExpr(args[0]!);
    if (dst.type.kind === "httpRes") {
      // socket → ServerResponse (the extended-CONNECT bridge leg): raw
      // chunks become response body writes; EOF ends the response.
      return { kind: "libCall", fn: "net.sockPipeRes", args: [receiver, dst], type: VOID, loc };
    }
    if (dst.type.kind !== "netSocket") {
      L.noLowering(
        `pipe into '${L.fmt(dst.type)}' destinations`,
        args[0]!,
        "a socket pipes into another socket or a ServerResponse",
      );
    }
    return { kind: "libCall", fn: "net.sockPipe", args: [receiver, dst], type: VOID, loc };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    requireStatementPosition(L, call, `socket.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = L.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const receiver = handleReceiver(L, access.expression, NETSOCKET_T);
    if (event === "data") {
      const { cb } = lowerCallbackArg(
        L, args[1]!, "data listeners", 1,
        (p) => p.kind === "bytes" && p.elem === "u8",
        "use (chunk: Buffer) or ()",
        [DYN],
      );
      return { kind: "libCall", fn: "net.sockOnData", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "error") {
      const { cb } = lowerCallbackArg(
        L, args[1]!, "error listeners", 1,
        (p) => p.kind === "object" && p.className === "%Error",
        "use (err) or ()",
        [ERROR_T],
      );
      return { kind: "libCall", fn: "net.sockOnError", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "end" || event === "close" || event === "connect" || event === "timeout" ||
        event === "readable") {
      const { cb } = lowerCallbackArg(L, args[1]!, `${event} listeners`, 0, () => false, "use ()", []);
      const fn: IrLibFn =
        event === "end" ? "net.sockOnEnd"
        : event === "close" ? "net.sockOnClose"
        : event === "timeout" ? "net.sockOnTimeout"
        : event === "readable" ? "net.sockOnReadable"
        : "net.sockOnConnect";
      return { kind: "libCall", fn, args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "finish") {
      // Fires once when the FIN goes out — once either way (the event
      // happens at most once per socket).
      const { cb } = lowerCallbackArg(L, args[1]!, "finish listeners", 0, () => false, "use ()", []);
      return { kind: "libCall", fn: "net.sockOnFinish", args: [receiver, cb], type: VOID, loc };
    }
    if (event === "secureConnect") {
      // The TLS client's post-handshake event: on a TLS socket the
      // 'connect' list already fires at establishment (scr_net.c's
      // transport pump); the runtime gates on the transport so a plain
      // socket's registration never fires — Node's exact split.
      const { cb } = lowerCallbackArg(L, args[1]!, "secureConnect listeners", 0, () => false, "use ()", []);
      return { kind: "libCall", fn: "tls.sockOnSecureConnect", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "session") {
      // The received-ticket event: fires once per TLS client socket with
      // the serialized session (a Buffer); plain sockets never fire it.
      const { cb } = lowerCallbackArg(
        L, args[1]!, "session listeners", 1,
        (p) => p.kind === "bytes" && p.elem === "u8",
        "use (session: Buffer) or ()",
        [DYN],
      );
      return { kind: "libCall", fn: "tls.sockOnSession", args: [receiver, cb, once], type: VOID, loc };
    }
    L.noLowering(
      `socket.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
      args[0]!,
      '"data", "end", "close", "error", "connect", "timeout", "readable", "secureConnect", and "session" are the supported socket events (as literals)',
    );
  }
  L.noLowering(
    `Socket.${name}`,
    call,
    "write, end, destroy, pipe, setTimeout, remoteAddress, read, unshift, and on/once of data/end/close/error/connect/timeout/readable are the supported Socket members",
    L.checker.getSymbolAtLocation(access.name),
  );
}

/** The method-call dispatch for both server-surface receiver kinds — one
 * entry in lower-calls.ts's intrinsic chain (the lowerChildMethodCall
 * slot). Null when the receiver is neither. */
export function lowerServerMethodCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,): IrExpr | null {
  if (call.questionDotToken || (access.questionDotToken && !L.chainHandled.has(access))) return null;
  return (
    lowerServerCloseBind(L, call, access) ??
    lowerNetServerMethodCall(L, call, access) ??
    lowerNetSocketMethodCall(L, call, access) ??
    lowerH2SessionMethodCall(L, call, access) ??
    lowerH2StreamMethodCall(L, call, access) ??
    lowerHttpReqMethodCall(L, call, access) ??
    lowerHttpResMethodCall(L, call, access) ??
    lowerHttpClientMethodCall(L, call, access)
  );
}

/** The `{ ...req.headers }` SNAPSHOT helper, interned per target shape —
 * the envSnapshotHelper pattern over http.reqHeaderPairs: a fresh
 * pure-index record whose overflow holds every header (lowercased names,
 * arrival order), each value wrapped at the slot union's string arm. Null
 * when the shape is not a pure index-signature record with a string arm
 * (the caller fences). */
function headersSnapshotHelper(L: Lowerer, shapeId: string, loc: SrcLoc): string | null {
  return pairsSnapshotHelper(L, shapeId, loc, {
    keyPrefix: "headers",
    libCall: "http.reqHeaderPairs",
    params: [{ localId: "r.0", name: "r", type: HTTPREQ_T }],
    callArgs: [varRef("r.0", HTTPREQ_T, loc)],
  });
}

/** The `endStream` boolean of an h2 options object literal, as a literal
 * bool. Returns undefined when absent (or the arg is absent). Fences on
 * a non-literal endStream value or unknown keys that would matter. */
function h2EndStreamOption(L: Lowerer, node: ts.Expression | undefined): boolean | undefined {
  if (node === undefined) return undefined;
  if (!ts.isObjectLiteralExpression(node)) {
    L.noLowering("h2 options argument", node, "pass the options as an object literal ({ endStream: true })");
  }
  let end: boolean | undefined;
  for (const prop of (node as ts.ObjectLiteralExpression).properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
      L.noLowering("h2 options with spreads or computed keys", prop, "use plain `name: value` entries");
    }
    const key = (prop.name as ts.Identifier).text;
    if (key === "endStream") {
      if ((prop as ts.PropertyAssignment).initializer.kind === ts.SyntaxKind.TrueKeyword) end = true;
      else if ((prop as ts.PropertyAssignment).initializer.kind === ts.SyntaxKind.FalseKeyword) end = false;
      else L.noLowering("a non-literal endStream option", (prop as ts.PropertyAssignment).initializer, "spell it true or false");
    }
    // Other keys (waitForTrailers, exclusive, parent, weight) are accepted
    // and ignored — the honest-defaults stance (they tune framing this
    // core does not model; a use that DEPENDS on them fails downstream).
  }
  return end;
}

/** Method calls on ClientHttp2Session / ServerHttp2Session receivers.
 * Null for other receivers (the chain keeps trying). */
function lowerH2SessionMethodCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,): IrExpr | null {
  if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "http2Session") return null;
  if (!L.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  const receiver = () => handleReceiver(L, access.expression, HTTP2SESSION_T);
  if (name === "request") {
    const pairs = args.length >= 1 && !ts.isObjectLiteralExpression(args[0]!) === false && args.length >= 1
      ? null : null;
    void pairs;
    // arg0: headers (optional), arg1: options (optional).
    const headersArg = args.length >= 1 ? lowerH2HeadersArg(L, args[0]!) : { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc } as IrExpr;
    const end = h2EndStreamOption(L, args[1]);
    const endF64: IrExpr = { kind: "numLit", value: end === undefined ? -1 : end ? 1 : 0, type: F64, loc };
    return { kind: "libCall", fn: "http2.sessionRequest", args: [receiver(), headersArg, endF64], type: HTTP2STREAM_T, loc };
  }
  if (name === "close") {
    requireStatementPosition(L, call, "session.close(...)");
    if (args.length === 0) {
      return { kind: "libCall", fn: "http2.sessionClose", args: [receiver()], type: VOID, loc };
    }
    const { cb } = lowerCallbackArg(L, args[0]!, "close callbacks", 0, () => false, "use ()", []);
    return { kind: "libCall", fn: "http2.sessionCloseCb", args: [receiver(), cb], type: VOID, loc };
  }
  if (name === "destroy") {
    requireStatementPosition(L, call, "session.destroy(...)");
    return { kind: "libCall", fn: "http2.sessionDestroy", args: [receiver()], type: VOID, loc };
  }
  if (name === "settings") {
    // session.settings(obj[, cb]): the settings record crosses as a dyn
    // value (the checked-dynamic boundary — object literals box); the
    // callback fires on the peer's ACK ((err, settings, duration) in the
    // dyn flavor, zero-arg in the typed one).
    requireStatementPosition(L, call, "session.settings(...)");
    if (args.length === 0) {
      return { kind: "libCall", fn: "http2.sessionSettings0", args: [receiver()], type: VOID, loc };
    }
    const v = L.lowerExpr(args[0]!);
    const settingsArg: IrExpr = v.type.kind === "dyn" ? v : { kind: "dynFrom", value: v, type: DYN, loc };
    if (args.length >= 2) {
      const cbV = L.lowerExpr(args[1]!);
      if (cbV.type.kind === "dyn") {
        // The dyn callback keeps Node's exact (err, settings, duration)
        // shape — the runtime fires it through the checked-dynamic tree.
        return { kind: "libCall", fn: "http2.sessionSettingsDynCb", args: [receiver(), settingsArg, cbV], type: VOID, loc };
      }
      const { cb } = lowerCallbackArg(L, args[1]!, "settings callbacks", 0, () => false, "use () — or a dynamic (mustCall-wrapped) callback for the (err, settings, duration) shape", []);
      return { kind: "libCall", fn: "http2.sessionSettingsCb0", args: [receiver(), settingsArg, cb], type: VOID, loc };
    }
    return { kind: "libCall", fn: "http2.sessionSettings", args: [receiver(), settingsArg], type: VOID, loc };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    requireStatementPosition(L, call, `session.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = L.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    if (event === "localSettings" || event === "remoteSettings") {
      // The settings payload crosses as a dyn value: dyn (mustCall)
      // listeners fire with the settings record; zero-arg typed
      // listeners register plainly.
      const local = boolLit(event === "localSettings", loc);
      const cbV = L.lowerExpr(args[1]!);
      if (cbV.type.kind === "dyn") {
        return { kind: "libCall", fn: "http2.sessionOnSettingsDyn", args: [receiver(), cbV, once, local], type: VOID, loc };
      }
      const { cb } = lowerCallbackArg(L, args[1]!, `${event} listeners`, 0,
        () => false, "use () — or a dynamic (mustCall-wrapped) listener for the (settings) payload", []);
      return { kind: "libCall", fn: "http2.sessionOnSettings0", args: [receiver(), cb, once, local], type: VOID, loc };
    }
    if (event === "close") {
      const { cb } = lowerCallbackArg(L, args[1]!, "close listeners", 0, () => false, "use ()", []);
      return { kind: "libCall", fn: "http2.sessionOnClose", args: [receiver(), cb, once], type: VOID, loc };
    }
    if (event === "error") {
      const { cb } = lowerCallbackArg(L, args[1]!, "error listeners", 1,
        (p) => p.kind === "object" && p.className === "%Error", "use (err) or ()", [ERROR_T]);
      return { kind: "libCall", fn: "http2.sessionOnError", args: [receiver(), cb, once], type: VOID, loc };
    }
    if (event === "connect") {
      const { cb } = lowerCallbackArg(L, args[1]!, "connect listeners", 2,
        (p) => p.kind === "http2Session" || p.kind === "netSocket", "use (session, socket) or ()",
        [HTTP2SESSION_T, NETSOCKET_T]);
      return { kind: "libCall", fn: "http2.sessionOnConnect", args: [receiver(), cb, once], type: VOID, loc };
    }
    if (event === "stream") {
      const cb = h2HeadersCallbackAdapter(L, args[1]!, "stream listeners", "http2Stream", false, loc);
      return { kind: "libCall", fn: "http2.sessionOnStream", args: [receiver(), cb, once], type: VOID, loc };
    }
    if (event === "goaway") {
      const cb = L.lowerExpr(args[1]!);
      if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 3) {
        L.unsupported("SC1090", args[1]!, "goaway listeners with more than three parameters or returning a value");
      }
      if (cb.type.params.some((p) => p.kind !== "f64" && p.kind !== "bytes")) {
        L.unsupported("SC1090", args[1]!, "goaway listeners whose parameters are not (errorCode, lastStreamID, opaqueData?)");
      }
      return { kind: "libCall", fn: "http2.sessionOnGoaway", args: [receiver(), voidizedCallback(L, cb, loc), once], type: VOID, loc };
    }
    L.noLowering(`session.${name}("${event ?? "?"}", ...)`, args[0]!,
      '"close", "error", "connect", "stream", and "goaway" are the supported session events');
  }
  L.noLowering(`session.${name}`, call,
    "close/destroy/request and on(\"close\"|\"error\"|\"connect\"|\"stream\"|\"goaway\") are the lowered session members");
}

/** Method calls on ClientHttp2Stream / ServerHttp2Stream receivers. */
function lowerH2StreamMethodCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression, receiverOverride?: IrExpr,): IrExpr | null {
  const compatReqStream =
    ts.isPropertyAccessExpression(access.expression) &&
    access.expression.name.text === "stream" &&
    L.mapTypeOf(L.typeOf(access.expression.expression))?.kind === "httpReq";
  if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "http2Stream" && !compatReqStream) return null;
  if (!L.isStdlibMember(access) && !compatReqStream) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  const receiver = () => receiverOverride ?? handleReceiver(L, access.expression, HTTP2STREAM_T);
  if (name === "respond") {
    requireStatementPosition(L, call, "stream.respond(...)");
    const headersArg = args.length >= 1
      ? lowerH2HeadersArg(L, args[0]!)
      : { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc } as IrExpr;
    const end = h2EndStreamOption(L, args[1]);
    return { kind: "libCall", fn: "http2.streamRespond", args: [receiver(), headersArg, boolLit(end ?? false, loc)], type: VOID, loc };
  }
  if (name === "write" || name === "end") {
    requireStatementPosition(L, call, `stream.${name}(...)`);
    const minArgs = name === "write" ? 1 : 0;
    if (args.length < minArgs || args.length > 1) {
      // end() with a trailing callback is common; accept (data?, cb?) by
      // dropping a trailing closure arg (fire-and-forget — the finish
      // callback is not modeled here).
      if (!(name === "end" && args.length === 2)) {
        L.noLowering(`${name} with ${args.length} arguments`, call, `use ${name}(data${name === "write" ? "" : "?"})`);
      }
    }
    if (args.length === 0) {
      return { kind: "libCall", fn: "http2.streamEnd", args: [receiver()], type: VOID, loc };
    }
    const data = L.lowerExpr(args[0]!);
    const isBytes = data.type.kind === "bytes";
    if (data.type.kind !== "string" && !isBytes) {
      L.noLowering(`${name} with '${L.fmt(data.type)}' data`, args[0]!, "the chunk is a string or a Uint8Array here");
    }
    const fn: IrLibFn = name === "write"
      ? (isBytes ? "http2.streamWriteBytes" : "http2.streamWrite")
      : (isBytes ? "http2.streamEndBytes" : "http2.streamEndStr");
    return { kind: "libCall", fn, args: [receiver(), data], type: VOID, loc };
  }
  if (name === "close") {
    requireStatementPosition(L, call, "stream.close(...)");
    const code: IrExpr = args.length >= 1 ? L.lowerExpr(args[0]!) : { kind: "numLit", value: 0, type: F64, loc };
    if (code.type.kind !== "f64") {
      L.noLowering("stream.close with a non-numeric code", args[0]!, "the code is a number (http2.constants.NGHTTP2_*)");
    }
    if (args.length >= 2) {
      const { cb } = lowerCallbackArg(L, args[1]!, "close callbacks", 0, () => false, "use ()", []);
      return { kind: "libCall", fn: "http2.streamCloseCb", args: [receiver(), code, cb], type: VOID, loc };
    }
    return { kind: "libCall", fn: "http2.streamClose", args: [receiver(), code], type: VOID, loc };
  }
  if (name === "destroy") {
    requireStatementPosition(L, call, "stream.destroy(...)");
    return { kind: "libCall", fn: "http2.streamDestroy", args: [receiver()], type: VOID, loc };
  }
  if (name === "setEncoding") {
    const enc = L.lowerExpr(args[0]!);
    if (enc.type.kind !== "string") L.noLowering("setEncoding with a non-string encoding", args[0]!, "pass \"utf8\"");
    if (ts.isExpressionStatement(call.parent) || ts.isArrowFunction(call.parent)) {
      return { kind: "libCall", fn: "http2.streamSetEncoding", args: [receiver(), enc], type: VOID, loc };
    }
    // The chaining spelling (`client.request(h).setEncoding("utf8")`):
    // same write, the result is the receiver — Node's return-this.
    return { kind: "libCall", fn: "http2.streamSetEncodingRet", args: [receiver(), enc], type: HTTP2STREAM_T, loc };
  }
  if (name === "resume" || name === "pause") {
    requireStatementPosition(L, call, `stream.${name}(...)`);
    return { kind: "libCall", fn: name === "resume" ? "http2.streamResume" : "http2.streamPause", args: [receiver()], type: VOID, loc };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    requireStatementPosition(L, call, `stream.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = L.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    if (event === "data") {
      const { cb } = lowerCallbackArg(L, args[1]!, "data listeners", 1,
        (p) => (p.kind === "bytes" && p.elem === "u8") || p.kind === "string" || p.kind === "dyn",
        "use (chunk) or ()", [BYTES_U8]);
      return { kind: "libCall", fn: "http2.streamOnData", args: [receiver(), cb, once], type: VOID, loc };
    }
    if (event === "end" || event === "close" || event === "aborted") {
      const { cb } = lowerCallbackArg(L, args[1]!, `${event} listeners`, 0, () => false, "use ()", []);
      const fn: IrLibFn = event === "end" ? "http2.streamOnEnd" : event === "close" ? "http2.streamOnClose" : "http2.streamOnAborted";
      return { kind: "libCall", fn, args: [receiver(), cb, once], type: VOID, loc };
    }
    if (event === "error") {
      const { cb } = lowerCallbackArg(L, args[1]!, "error listeners", 1,
        (p) => p.kind === "object" && p.className === "%Error", "use (err) or ()", [ERROR_T]);
      return { kind: "libCall", fn: "http2.streamOnError", args: [receiver(), cb, once], type: VOID, loc };
    }
    if (event === "response") {
      const cb = h2HeadersCallbackAdapter(L, args[1]!, "response listeners", null, true, loc);
      return { kind: "libCall", fn: "http2.streamOnResponse", args: [receiver(), cb, once], type: VOID, loc };
    }
    L.noLowering(`stream.${name}("${event ?? "?"}", ...)`, args[0]!,
      '"data", "end", "close", "aborted", "error", and "response" are the supported stream events');
  }
  L.noLowering(`stream.${name}`, call,
    "respond/write/end/close/destroy/setEncoding/resume/pause and on(...) are the lowered stream members");
}

/** A compatibility request's `req.stream?.method(...)`: the static Node
 * type omits the HTTP/1 undefined arm, so build the runtime guard explicitly.
 * The body receives the narrowed backing stream directly, preserving lazy
 * argument evaluation on the HTTP/1 arm. */
export function lowerCompatReqStreamOptionalCall(
  L: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  if (!ts.isPropertyAccessExpression(call.expression) || !call.expression.questionDotToken) return null;
  const stream = call.expression.expression;
  if (!ts.isPropertyAccessExpression(stream) || stream.name.text !== "stream" ||
      L.mapTypeOf(L.typeOf(stream.expression))?.kind !== "httpReq") return null;
  const loc = locOf(call);
  const unionT: IrType = { kind: "union", unionId: L.unions.intern([HTTP2STREAM_T, UNDEFINED_T]) };
  const guarded: IrExpr = {
    kind: "libCall",
    fn: "http.reqH2Stream",
    args: [handleReceiver(L, stream.expression, HTTPREQ_T)],
    type: unionT,
    loc,
  };
  const id = `chain.${L.chainCounter++}`;
  const body = lowerH2StreamMethodCall(
    L,
    call,
    call.expression,
    { kind: "chainRecv", id, type: HTTP2STREAM_T, loc },
  );
  if (body === null) return null;
  return { kind: "optChain", id, receiver: guarded, body, type: VOID, loc };
}

/** The composed `server.address().port` read — the crypto
 * randomBytes(n).toString(enc) precedent: the AddressInfo record between
 * the two reads never materializes; the runtime answers the bound port
 * directly. Null for every other property shape. */
export function lowerServerProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (expr.questionDotToken && !L.chainHandled.has(expr)) return null;
  const loc = locOf(expr);
  // req.url / req.method — always-present strings on server requests;
  // req.headers.NAME — the `string | undefined` union (envGet's type).
  const recvKind = L.mapTypeOf(L.typeOf(expr.expression))?.kind;
  if (recvKind === "netServer" && L.isStdlibMember(expr)) {
    const field = httpServerTimeoutField(expr.name.text);
    if (field !== null) {
      const receiver = handleReceiver(L, expr.expression, NETSERVER_T);
      const selector: IrExpr = { kind: "numLit", value: field, type: F64, loc };
      return { kind: "libCall", fn: "http.serverTimeoutGet", args: [receiver, selector], type: F64, loc };
    }
  }
  if (recvKind === "httpReq" && L.isStdlibMember(expr)) {
    const name = expr.name.text;
    if (name === "url" || name === "method") {
      const receiver = handleReceiver(L, expr.expression, HTTPREQ_T);
      const fn: IrLibFn = name === "url" ? "http.reqUrl" : "http.reqMethod";
      return { kind: "libCall", fn, args: [receiver], type: STRING, loc };
    }
    if (name === "statusCode") {
      // `number | undefined` — a real status on client responses, the
      // undefined arm on server requests (Node's IncomingMessage split).
      const receiver = handleReceiver(L, expr.expression, HTTPREQ_T);
      return { kind: "libCall", fn: "http.reqStatusCode", args: [receiver], type: L.withUndefinedArm(F64), loc };
    }
    if (name === "socket") {
      const receiver = handleReceiver(L, expr.expression, HTTPREQ_T);
      return { kind: "libCall", fn: "http.reqSocket", args: [receiver], type: NETSOCKET_T, loc };
    }
    if (name === "httpVersion") {
      const receiver = handleReceiver(L, expr.expression, HTTPREQ_T);
      return { kind: "libCall", fn: "http.reqHttpVersion", args: [receiver], type: STRING, loc };
    }
    if (name === "httpVersionMajor" || name === "httpVersionMinor") {
      const receiver = handleReceiver(L, expr.expression, HTTPREQ_T);
      const fn: IrLibFn = name === "httpVersionMajor" ? "http.reqHttpVersionMajor" : "http.reqHttpVersionMinor";
      return { kind: "libCall", fn, args: [receiver], type: F64, loc };
    }
    if (name === "aborted" || name === "complete") {
      // The compat pair's flags (Http2ServerRequest); an http/1 request
      // answers aborted: false and complete-once-ended the same way.
      const receiver = handleReceiver(L, expr.expression, HTTPREQ_T);
      const fn: IrLibFn = name === "aborted" ? "http.reqAborted" : "http.reqComplete";
      return { kind: "libCall", fn, args: [receiver], type: BOOL, loc };
    }
    if (name === "rawHeaders") {
      // [name, value, name, value, ...] in arrival order, names in their
      // ORIGINAL case — Node's shape; a fresh string[] per read.
      const receiver = handleReceiver(L, expr.expression, HTTPREQ_T);
      return { kind: "libCall", fn: "http.reqRawHeaders", args: [receiver], type: arrayOf(STRING), loc };
    }
    if (name === "statusMessage") {
      // `string | undefined` — the reason phrase on client responses (""
      // when the status line carried none), undefined on server requests
      // (the statusCode split).
      const receiver = handleReceiver(L, expr.expression, HTTPREQ_T);
      return { kind: "libCall", fn: "http.reqStatusMessage", args: [receiver], type: L.envValueType(), loc };
    }
    if (name === "stream") {
      const parent = expr.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === expr &&
          ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
        const receiver = handleReceiver(L, expr.expression, HTTPREQ_T);
        if (parent.questionDotToken) {
          const type: IrType = {
            kind: "union",
            unionId: L.unions.intern([HTTP2STREAM_T, UNDEFINED_T]),
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
      L.noLowering(
        "reading 'stream' from a request outside a method call",
        expr,
        "call req.stream methods directly; optional calls remain undefined on HTTP/1 and use the live stream on HTTP/2",
      );
    }
    if (name === "session") {
      // Http2ServerRequest's h2-only members are not exposed through the
      // compatibility request handle yet. The call forms retain their
      // guarded-no-op / unguarded-TypeError stance; other reads fence.
      L.noLowering(
        `reading '${name}' (an HTTP/2-only member) from a request`,
        expr,
        "compatibility requests do not expose their backing h2 stream/session yet; guarded method calls no-op and other reads have no lowering",
      );
    }
    if (name === "headers") {
      // `req.headers` as a VALUE — the `{ ...req.headers }` spread and
      // record flows: a fresh snapshot record per read (Node's spread
      // copies too; the per-name READS keep their direct lowerings).
      const mapped = L.mapTypeOf(L.typeOf(expr));
      if (mapped?.kind === "record") {
        const helper = headersSnapshotHelper(L, mapped.shapeId, loc);
        if (helper !== null) {
          const receiver = handleReceiver(L, expr.expression, HTTPREQ_T);
          return { kind: "call", callee: helper, args: [receiver], type: mapped, loc };
        }
      }
      L.unsupported(
        "SC1090",
        expr,
        "req.headers as a value of this type (read one header: req.headers.name or req.headers[name])",
      );
    }
  }
  if (recvKind === "httpRes" && L.isStdlibMember(expr) && expr.name.text === "stream") {
    L.noLowering(
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
    const receiver = handleReceiver(L, expr.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockEncrypted", args: [receiver], type: L.withUndefinedArm(BOOL), loc };
  }
  if (recvKind === "netSocket" && expr.name.text === "authorized") {
    // TLSSocket.authorized — Node's verify verdict (false on plain
    // sockets, servers without requestCert, and unverified clients).
    // Like `encrypted`, no stdlib-provenance gate: the member has exactly
    // one meaning on a socket-kind receiver.
    const receiver = handleReceiver(L, expr.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "tls.sockAuthorized", args: [receiver], type: BOOL, loc };
  }
  if (recvKind === "netSocket" && expr.name.text === "authorizationError") {
    // TLSSocket.authorizationError — the verify-failure CODE STRING
    // (DEPTH_ZERO_SELF_SIGNED_CERT, ...) or null when authorized/never
    // verified: Node's exact value shape (a string, not an Error).
    const receiver = handleReceiver(L, expr.expression, NETSOCKET_T);
    const type: IrType = { kind: "union", unionId: L.unions.intern([STRING, NULL_T]) };
    return { kind: "libCall", fn: "tls.sockAuthError", args: [receiver], type, loc };
  }
  if (recvKind === "netSocket" && L.isStdlibMember(expr) && expr.name.text === "destroyed") {
    // true once the fd is gone (destroy() or full close) — Node's flag,
    // the proxy's re-entrant teardown guard.
    const receiver = handleReceiver(L, expr.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockDestroyed", args: [receiver], type: BOOL, loc };
  }
  if (recvKind === "netSocket" && L.isStdlibMember(expr) && expr.name.text === "writable") {
    // Node's stream answer: the write half is open — no end() yet, no FIN
    // sent, fd alive (connecting sockets answer true; writes queue). The
    // proxy's "may I still answer 502" guard.
    const receiver = handleReceiver(L, expr.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockWritable", args: [receiver], type: BOOL, loc };
  }
  if (recvKind === "netSocket" && L.isStdlibMember(expr) && expr.name.text === "bytesWritten") {
    // Every byte the write paths accepted (buffered included — Node
    // counts those too; plaintext on TLS sockets).
    const receiver = handleReceiver(L, expr.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockBytesWritten", args: [receiver], type: F64, loc };
  }
  if (recvKind === "netSocket" && L.isStdlibMember(expr) && expr.name.text === "readable") {
    // true until the read half is done (peer FIN / destroy).
    const receiver = handleReceiver(L, expr.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockReadable", args: [receiver], type: BOOL, loc };
  }
  if (recvKind === "netSocket" && L.isStdlibMember(expr) && expr.name.text === "remoteAddress") {
    // `string | undefined` — Node's read-time caching: a value read while
    // connected survives destroy; never-read sockets answer undefined
    // after close.
    const receiver = handleReceiver(L, expr.expression, NETSOCKET_T);
    return { kind: "libCall", fn: "net.sockRemoteAddress", args: [receiver], type: L.envValueType(), loc };
  }
  if (recvKind === "httpClientReq" && L.isStdlibMember(expr) && expr.name.text === "destroyed") {
    const receiver = handleReceiver(L, expr.expression, HTTPCLIENTREQ_T);
    return { kind: "libCall", fn: "http.clientDestroyed", args: [receiver], type: BOOL, loc };
  }
  if (isHttpReqHeaders(L, expr.expression)) {
    const receiver = handleReceiver(L, (expr.expression as ts.PropertyAccessExpression).expression, HTTPREQ_T);
    const key: IrExpr = { kind: "strLit", value: expr.name.text, type: STRING, loc };
    return { kind: "libCall", fn: "http.reqHeader", args: [receiver, key], type: L.envValueType(), loc };
  }
  if (recvKind === "httpRes" && L.isStdlibMember(expr) && expr.name.text === "headersSent") {
    const receiver = handleReceiver(L, expr.expression, HTTPRES_T);
    return { kind: "libCall", fn: "http.resHeadersSent", args: [receiver], type: BOOL, loc };
  }
  if (recvKind === "httpRes" && L.isStdlibMember(expr) && expr.name.text === "statusCode") {
    // 200 until assigned — Node's fresh-response default; the assignment
    // twin lives in lowerHttpResPropertyAssignment.
    const receiver = handleReceiver(L, expr.expression, HTTPRES_T);
    return { kind: "libCall", fn: "http.resStatusGet", args: [receiver], type: F64, loc };
  }
  if (recvKind === "httpRes" && L.isStdlibMember(expr) && expr.name.text === "statusMessage") {
    // The assigned reason phrase, or the current status code's default
    // when none was set (Node answers undefined until the head goes out
    // — divergence: this surface is string-typed, the checker's shape).
    const receiver = handleReceiver(L, expr.expression, HTTPRES_T);
    return { kind: "libCall", fn: "http.resStatusMsgGet", args: [receiver], type: STRING, loc };
  }
  if (recvKind === "http2Session" && L.isStdlibMember(expr)) {
    const m = expr.name.text;
    const recv = () => handleReceiver(L, expr.expression, HTTP2SESSION_T);
    if (m === "closed") return { kind: "libCall", fn: "http2.sessionClosed", args: [recv()], type: BOOL, loc };
    if (m === "destroyed") return { kind: "libCall", fn: "http2.sessionDestroyed", args: [recv()], type: BOOL, loc };
    if (m === "encrypted") return { kind: "libCall", fn: "http2.sessionEncrypted", args: [recv()], type: BOOL, loc };
    if (m === "type") return { kind: "libCall", fn: "http2.sessionType", args: [recv()], type: F64, loc };
    if (m === "alpnProtocol") return { kind: "libCall", fn: "http2.sessionAlpn", args: [recv()], type: STRING, loc };
    if (m === "socket") return { kind: "libCall", fn: "http2.sessionSocket", args: [recv()], type: NETSOCKET_T, loc };
    if (m === "pendingSettingsAck") return { kind: "libCall", fn: "http2.sessionPendingSettingsAck", args: [recv()], type: BOOL, loc };
    if (m === "localSettings" || m === "remoteSettings") {
      // The settings record crosses as a dyn value (the d.ts types it
      // `any`): member reads ride the checked-dynamic keyed read.
      return {
        kind: "libCall", fn: "http2.sessionSettingsGet",
        args: [recv(), boolLit(m === "localSettings", loc)], type: DYN, loc,
      };
    }
  }
  if (recvKind === "http2Stream" && L.isStdlibMember(expr)) {
    const m = expr.name.text;
    const recv = () => handleReceiver(L, expr.expression, HTTP2STREAM_T);
    if (m === "id") return { kind: "libCall", fn: "http2.streamId", args: [recv()], type: F64, loc };
    if (m === "rstCode") return { kind: "libCall", fn: "http2.streamRstCode", args: [recv()], type: F64, loc };
    if (m === "destroyed") return { kind: "libCall", fn: "http2.streamDestroyed", args: [recv()], type: BOOL, loc };
    if (m === "closed") return { kind: "libCall", fn: "http2.streamClosed", args: [recv()], type: BOOL, loc };
    if (m === "aborted") return { kind: "libCall", fn: "http2.streamAborted", args: [recv()], type: BOOL, loc };
    if (m === "pending") return { kind: "libCall", fn: "http2.streamPending", args: [recv()], type: BOOL, loc };
    if (m === "session") return { kind: "libCall", fn: "http2.streamSession", args: [recv()], type: HTTP2SESSION_T, loc };
  }
  if (expr.name.text !== "port") return null;
  const recv = expr.expression;
  if (!ts.isCallExpression(recv) || recv.questionDotToken || recv.arguments.length !== 0) return null;
  if (!ts.isPropertyAccessExpression(recv.expression)) return null;
  const inner = recv.expression;
  if (inner.name.text !== "address" || inner.questionDotToken) return null;
  if (L.mapTypeOf(L.typeOf(inner.expression))?.kind !== "netServer") return null;
  if (!L.isStdlibMember(inner)) return null;
  const receiver = handleReceiver(L, inner.expression, NETSERVER_T);
  return { kind: "libCall", fn: "net.serverPort", args: [receiver], type: F64, loc };
}

/** The (req, res) request-handler argument — http.createServer's, https
 * createServer's, http.Server's, and server.on("request")'s shared shape
 * check: at most two parameters typed (IncomingMessage, ServerResponse).
 * A value-returning handler adapts through the cast-and-discard helper
 * (Node ignores handler results — the writeHead-chaining body
 * `(req, res) => res.writeHead(200).end()` is the motivating shape). */
function lowerRequestHandlerArg(L: Lowerer, node: ts.Expression): IrExpr {
  const cb = L.lowerExpr(node);
  if (cb.type.kind === "dyn") {
    // A CHECKED-DYNAMIC handler (test/common's mustCall wrapper around
    // the (req, res) listener — the canonical suite shape): adapt
    // through the dynCheck function boundary. The adapter boxes req/res
    // as dyn HANDLE values (SCR_DYN_HANDLE — reference identity) and
    // calls the wrapper through the checked-dynamic machinery; member
    // uses inside the wrapped body dispatch back onto the same http
    // entry points at runtime.
    return { kind: "dynCheck", value: cb, type: funcOf([HTTPREQ_T, HTTPRES_T], VOID), loc: locOf(node) };
  }
  if (
    cb.type.kind === "func" &&
    (cb.type.rest === true ||
      (cb.type.params.length > 0 && cb.type.params.every((p) => p.kind === "dyn"))) &&
    canBoxFuncIntoDyn(cb.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))
  ) {
    // A hoisted plain-JS handler (`http.createServer(handle)` where
    // `function handle(req, res)` has no contextual type — dyn params),
    // or an arguments-reading rest function: box it and adapt exactly
    // like the dyn case — req/res arrive as HANDLE boxes and the body's
    // member uses dispatch at runtime.
    const boxed: IrExpr = { kind: "dynFrom", value: cb, type: DYN, loc: locOf(node) };
    return { kind: "dynCheck", value: boxed, type: funcOf([HTTPREQ_T, HTTPRES_T], VOID), loc: locOf(node) };
  }
  if (cb.type.kind !== "func" || cb.type.params.length > 2) {
    L.unsupported(
      "SC1090",
      node,
      "request handlers with more than two parameters (use (req, res))",
    );
  }
  const [p0, p1] = cb.type.params;
  if ((p0 !== undefined && p0.kind !== "httpReq") || (p1 !== undefined && p1.kind !== "httpRes")) {
    L.unsupported(
      "SC1090",
      node,
      "request handlers whose parameters are not (req: IncomingMessage, res: ServerResponse)",
    );
  }
  return voidizedCallback(L, cb, locOf(node));
}

/** The http.createServer / http.Server options object — { requireHostHeader?,
 * joinDuplicateHeaders?, keepAliveTimeoutBuffer?, ... }. The first two
 * select parser behavior; keepAliveTimeoutBuffer initializes the matching
 * writable server field after Node's non-negative-safe-integer validation.
 * Other documented keys fence by name; unknown keys drop like Node drops
 * them. */
function lowerHttpServerOptions(L: Lowerer, node: ts.Expression, what: string): {
  joinDup: boolean;
  keepAliveTimeoutBuffer: IrExpr | null;
} {
  if (!ts.isObjectLiteralExpression(node)) {
    L.noLowering(
      `${what} with a non-literal options argument`,
      node,
      "pass the options as an object literal: { requireHostHeader?, joinDuplicateHeaders? }",
    );
  }
  let joinDup = false;
  let keepAliveTimeoutBuffer: IrExpr | null = null;
  for (const prop of node.properties) {
    let initializer: ts.Expression | null;
    if (ts.isPropertyAssignment(prop) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
      initializer = prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      initializer = null;
    } else {
      L.noLowering(
        `${what} options with computed keys or spreads`,
        prop,
        "each option must be a plain `name: value` (or shorthand) entry with a literal key",
      );
    }
    const key = (prop.name as ts.Identifier | ts.StringLiteral).text;
    if (key === "requireHostHeader") {
      // The literal `false` only: it asks for exactly this parser's
      // behavior (requests without Host are served). Node's default
      // (true: answer 400) is the behavior this slice does not have, so
      // `true`/dynamic values fence instead of silently not enforcing.
      if (initializer === null || initializer.kind !== ts.SyntaxKind.FalseKeyword) {
        L.noLowering(
          `${what} with a non-\`false\` requireHostHeader option`,
          prop,
          "this parser never answers 400 for a missing Host header — requireHostHeader: false is the honest (and only) lowered value",
        );
      }
      continue;
    }
    if (key === "joinDuplicateHeaders") {
      // Literal true/false: the flag decides parse-time read semantics,
      // so a runtime value would silently pick one — fence dynamics.
      if (initializer !== null && initializer.kind === ts.SyntaxKind.TrueKeyword) {
        joinDup = true;
        continue;
      }
      if (initializer !== null && initializer.kind === ts.SyntaxKind.FalseKeyword) {
        continue; /* Node's default: repeats keep the first value */
      }
      L.noLowering(
        `${what} with a non-literal joinDuplicateHeaders option`,
        prop,
        "the lowered forms are the literals joinDuplicateHeaders: true (repeats join \", \") and false (the keep-first default)",
      );
    }
    if (key === "keepAliveTimeoutBuffer") {
      if (keepAliveTimeoutBuffer !== null) {
        L.noLowering(
          `${what} with duplicate keepAliveTimeoutBuffer options`,
          prop,
          "write keepAliveTimeoutBuffer once in the options literal",
        );
      }
      const raw = initializer !== null
        ? L.lowerExpr(initializer)
        : L.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
      const value = L.coerceToExpected(raw, DYN);
      if (value.type.kind !== "dyn") {
        L.noLowering(
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
      L, prop, key, what, HTTP_SERVER_DOCUMENTED_OPTIONS,
      "requireHostHeader: false, joinDuplicateHeaders, and keepAliveTimeoutBuffer are the supported options",
    );
    // An undocumented key, dropped like Node drops it.
  }
  return { joinDup, keepAliveTimeoutBuffer };
}

/** The shared createServer([options][, handler]) shapes behind
 * http.createServer, http.Server, and `new http.Server`: no arguments
 * (the on("request") route), a lone handler, a lone options object, and
 * (options, handler). Modeled option values wrap the construction in an
 * interned option-setting helper. */
function lowerHttpCreateServerForms(L: Lowerer, expr: ts.CallExpression | ts.NewExpression,
  what: string, loc: SrcLoc,): IrExpr {
  const args = expr.arguments ?? ([] as unknown as ts.NodeArray<ts.Expression>);
  if (args.length > 2) {
    L.noLowering(
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
  const opts = optsNode !== null
    ? lowerHttpServerOptions(L, optsNode, what)
    : { joinDup: false, keepAliveTimeoutBuffer: null };
  const server: IrExpr = handlerNode !== null
    ? { kind: "libCall", fn: "http.createServer", args: [lowerRequestHandlerArg(L, handlerNode)], type: NETSERVER_T, loc }
    : { kind: "libCall", fn: "http.createServerEmpty", args: [], type: NETSERVER_T, loc };
  if (!opts.joinDup && opts.keepAliveTimeoutBuffer === null) return server;
  // The option-setting composition: an interned helper takes the option
  // values first (preserving Node's options-before-handler evaluation
  // order), then the fresh server, applies the modeled fields, and answers
  // the server as the constructor/factory result.
  const hasBuffer = opts.keepAliveTimeoutBuffer !== null;
  const key = `server.opts:${opts.joinDup ? 1 : 0}:${hasBuffer ? 1 : 0}`;
  const existing = L.arrHofHelpers.get(key);
  const name = existing ?? `%server.opts.${L.arrHofHelpers.size}`;
  if (!existing) {
    L.arrHofHelpers.set(key, name);
    const params = [
      ...(hasBuffer ? [{ localId: "b.0", name: "buffer", type: DYN }] : []),
      { localId: "s.0", name: "s", type: NETSERVER_T },
    ];
    const ref: IrExpr = { kind: "varRef", localId: "s.0", type: NETSERVER_T, loc };
    const body: IrStmt[] = [];
    if (hasBuffer) {
      const selector: IrExpr = { kind: "numLit", value: 4, type: F64, loc };
      const value: IrExpr = { kind: "varRef", localId: "b.0", type: DYN, loc };
      body.push({
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "http.serverTimeoutOptionSet", args: [ref, selector, value], type: VOID, loc },
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
    body.push({ kind: "return", value: ref, loc });
    L.liftedFns.push({
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
    args: [...(opts.keepAliveTimeoutBuffer !== null ? [opts.keepAliveTimeoutBuffer] : []), server],
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
 * keepAlive (a boolean value — TRUE throws the runtime's named pooling
 * fence: this client dials one connection per request), keepAliveMsecs /
 * maxSockets / maxFreeSockets / timeout / port as numbers, scheduling
 * DROPS (no free pool exists, so selection order cannot observe), other
 * documented keys fence by name, and undocumented keys drop like Node
 * drops them. Null when the callee isn't the http/https Agent. */
export function lowerHttpAgentNew(L: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const callee = expr.expression;
  const bi =
    ts.isPropertyAccessExpression(callee) && callee.name.text === "Agent"
      ? L.builtinMemberOf(callee)
      : ts.isIdentifier(callee)
        ? L.builtinImportOf(callee)
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
  const args = expr.arguments ?? [];
  if (args.length > 1) {
    L.noLowering(`${api} with ${args.length} arguments`, expr, "the supported form is new Agent(options?)");
  }
  if (args.length === 1) {
    const optsNode = stripParensAndCasts(args[0]!);
    if (!ts.isObjectLiteralExpression(optsNode)) {
      L.noLowering(
        `${api} with a non-literal options value`,
        args[0]!,
        "spell the options as an object literal at the construction site",
      );
    }
    for (const prop of optsNode.properties) {
      if (ts.isSpreadAssignment(prop)) {
        L.noLowering(`${api} with an options spread`, prop, "write each option inline");
      }
      let initializer: ts.Expression | null;
      if (ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
        initializer = prop.initializer;
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        initializer = null;
      } else {
        L.noLowering(
          `${api} options with computed keys`,
          prop,
          "each option must be a plain `name: value` (or shorthand) entry with a literal key",
        );
      }
      const key = (prop.name as ts.Identifier | ts.StringLiteral).text;
      const lowerVal = (want: "bool" | "f64"): IrExpr => {
        const v = initializer !== null
          ? L.lowerExpr(initializer)
          : L.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
        if (v.type.kind === "dyn") {
          return { kind: "dynCheck", value: v, type: want === "bool" ? BOOL : F64, loc: locOf(prop) };
        }
        if (v.type.kind !== want) {
          L.noLowering(
            `a ${api} '${key}' option of '${L.fmt(v.type)}' values`,
            prop,
            want === "bool" ? "the option value must be a boolean" : "the option value must be a number",
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
        case "scheduling":
          // Free-socket selection order: no free pool exists here (no
          // keep-alive reuse), so the choice cannot observe — dropped.
          if (initializer !== null) L.lowerExpr(initializer); // evaluate, like Node
          break;
        default:
          fenceOrDropOptionKey(
            L, prop, key, api, AGENT_DOCUMENTED_OPTIONS,
            "keepAlive, keepAliveMsecs, maxSockets, maxFreeSockets, timeout, port, and scheduling are the supported options",
          );
      }
    }
  }
  return {
    kind: "libCall",
    fn: "http.agentNew",
    args: [boolLit(bi.module === "https", loc), keepAlive, kaMsecs, maxSockets, maxFree, timeout, port],
    type: DYN,
    loc,
  };
}

export function lowerHttpServerNew(L: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const callee = expr.expression;
  const isHttpServer =
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "Server" &&
      L.builtinMemberOf(callee)?.module === "http") ||
    (ts.isIdentifier(callee) &&
      L.builtinImportOf(callee)?.module === "http" &&
      L.builtinImportOf(callee)?.member === "Server");
  if (!isHttpServer) return null;
  return lowerHttpCreateServerForms(L, expr, "new http.Server", locOf(expr));
}

/** Module-function calls on http import bindings: createServer([options][,
 * handler]) and the call-form Server (Node's constructor works without
 * `new` — test/parallel's http.Server(fn) spelling). The handler takes
 * (req, res), (req), or () — runtime adapters bridge each shape.
 * Everything else the module declares fences qualified. */
function lowerHttpModuleCall(L: Lowerer, expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,): IrExpr {
  if (bi.member === "createServer" || bi.member === "Server") {
    return lowerHttpCreateServerForms(L, expr, `http.${bi.member}`, loc);
  }
  if (bi.member === "request" || bi.member === "get") {
    return lowerHttpClientCall(L, expr, bi.member, loc);
  }
  L.noLowering(
    `http.${bi.member}`,
    expr,
    "createServer, Server, request, and get are the lowered http module functions",
    L.resolveValueSymbol(expr.expression as ts.Identifier),
  );
}

/** The cert/key PEM option of tls.createServer / https.createServer: an
 * OBJECT LITERAL whose lowered `cert` and `key` entries are strings or
 * Buffers (fs.readFileSync either way — portless reads Buffers) — a
 * runtime-valued (dyn) entry rides the tls.pemDyn extraction, throwing
 * the fence at runtime for non-PEM kinds (the divergence-66 stance).
 * Every other key fences by name; SNICallback gets the pointed hint. */
function lowerTlsServerOptions(L: Lowerer, node: ts.Expression, what: string): { cert: IrExpr; key: IrExpr } {
  if (!ts.isObjectLiteralExpression(node)) {
    L.noLowering(
      `${what} with a non-literal options argument`,
      node,
      "pass the options as an object literal: { cert, key }",
    );
  }
  const loc = locOf(node);
  let cert: IrExpr | null = null;
  let key: IrExpr | null = null;
  for (const prop of node.properties) {
    let initializer: ts.Expression | null;
    if (ts.isPropertyAssignment(prop) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
      initializer = prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      initializer = null;
    } else {
      L.noLowering(
        `${what} options with computed keys or spreads`,
        prop,
        "each option must be a plain `name: value` (or shorthand) entry with a literal key",
      );
    }
    const k = (prop.name as ts.Identifier | ts.StringLiteral).text;
    if (k !== "cert" && k !== "key") {
      const init = ts.isPropertyAssignment(prop) ? prop.initializer : null;
      if ((k === "ca" || k === "rejectUnauthorized") &&
          (init === null || sideEffectFreeOptionValue(init))) {
        // Both are inert without requestCert (which fences): the server's
        // `ca` verifies CLIENT certificates and rejectUnauthorized only
        // gates that verification — Node-observably droppable, matching
        // the runtime walk's split (effectful values keep the fence).
        continue;
      }
      if (k === "requestCert" &&
          (init === null || init.kind === ts.SyntaxKind.FalseKeyword)) {
        continue; // Node's false default, spelled out
      }
      fenceOrDropOptionKey(
        L, prop, k, what, TLS_SERVER_DOCUMENTED_OPTIONS,
        "cert and key (PEM strings or Buffers) are the supported options",
        {
          SNICallback:
            "SNICallback lowers only on http2.createSecureServer({ allowHTTP1: true, ... }) — serve one cert/key pair here",
          requestCert:
            "client-certificate handshakes are not modeled (SEMANTICS.md divergence 55) — requestCert: false is the lowered value",
        },
      );
      continue; // an undocumented key, dropped like Node drops it
    }
    let v = initializer !== null
      ? L.lowerExpr(initializer)
      : L.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
    const isArrayOfPem =
      v.type.kind === "array" &&
      (v.type.elem.kind === "string" || (v.type.elem.kind === "bytes" && v.type.elem.elem === "u8"));
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
      L.noLowering(
        `a ${what} '${k}' option of '${L.fmt(v.type)}' values`,
        prop,
        "cert/key are PEM strings or Buffers here",
      );
    }
    if (k === "cert") cert = v;
    else key = v;
  }
  if (cert === null || key === null) {
    L.noLowering(
      `${what} without both cert and key`,
      node,
      "the supported options object is { cert, key } (PEM strings or Buffers)",
    );
  }
  return { cert, key };
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
  "ciphers", "passphrase", "ecdhCurve", "sessionIdContext",
  "clientCertEngine", "privateKeyEngine", "privateKeyIdentifier",
  "minVersion", "maxVersion", "handshakeTimeout", "keepAliveInitialDelay",
  "sessionTimeout", "ticketKeys",
]);

/** True when a literal options bag must ride the runtime walker: JS uses
 * it for the typed TLS validation ladders, and HTTPS uses it for
 * keepAliveTimeoutBuffer so the HTTP option is consumed without losing
 * the literal's evaluation order. */
function tlsLiteralNeedsRuntimeWalk(node: ts.ObjectLiteralExpression,
  includeHttpTimeoutOptions = false,): boolean {
  const jsSource = isJsSourceFile(node.getSourceFile());
  return node.properties.some((p) =>
    (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
    (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
    ((includeHttpTimeoutOptions && p.name.text === "keepAliveTimeoutBuffer") ||
      (jsSource && TLS_VALIDATED_OPTIONS.has(p.name.text))),
  );
}

function lowerTlsServerOptionsOrDyn(
  L: Lowerer, node: ts.Expression, what: string, includeHttpTimeoutOptions = false,
): { cert: IrExpr; key: IrExpr; dyn?: undefined } | { dyn: IrExpr } {
  if (ts.isObjectLiteralExpression(node) &&
      !tlsLiteralNeedsRuntimeWalk(node, includeHttpTimeoutOptions)) {
    return lowerTlsServerOptions(L, node, what);
  }
  const v = L.lowerExpr(node);
  if (v.type.kind === "dyn") return { dyn: v };
  // A typed options RECORD binding (`const options = { key, cert, ... };
  // createServer(options)` — the Node-suite spelling): box it into the
  // dyn and hand the whole record to the runtime walk (the divergence-66
  // stance — members read at runtime, out-of-bounds ones throw the
  // catchable fence, undefined/undocumented ones drop). canConvertToDyn
  // now folds in the bytes-bearing option records the walker can box.
  if (canConvertToDyn(v.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))) {
    return { dyn: { kind: "dynFrom", value: v, type: DYN, loc: locOf(node) } };
  }
  L.noLowering(
    `${what} with a non-literal options argument`,
    node,
    "pass the options as an object literal: { cert, key }",
  );
}

/** tls.connect — the TLS client socket. The lowered forms are
 * connect(options[, cb]) and connect(port[, host][, options][, cb]) with
 * a RUNTIME options record (the checked-dynamic JS lane's shape — a dyn
 * value, or a record that converts): the runtime walk implements
 * port/host/rejectUnauthorized/ca/servername and throws the catchable
 * fence for other documented members (the divergence-66 stance). The
 * callback (and 'secureConnect'/'connect' listeners) fires
 * post-handshake — Node's secureConnect timing. */
function lowerTlsConnectCall(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  const args = expr.arguments;
  const FORMS_HINT =
    "the supported forms are connect(options[, cb]) and connect(port[, host][, options][, cb]) — options implement port/host/rejectUnauthorized/ca/servername";
  if (args.length < 1 || args.length > 4 || args.some(ts.isSpreadElement)) {
    L.noLowering(`tls.connect with ${args.length} arguments`, expr, FORMS_HINT);
  }
  const isFuncish = (a: ts.Expression): boolean =>
    ts.isFunctionExpression(a) || ts.isArrowFunction(a) ||
    L.checker.getCallSignatures(L.typeOf(a)).length > 0;
  const isObjectish = (a: ts.Expression): boolean => {
    if (ts.isObjectLiteralExpression(a)) return true;
    if (isFuncish(a) || ts.isStringLiteralLike(a) || ts.isNumericLiteral(a)) return false;
    const t = L.typeOf(a);
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
    L.noLowering("tls.connect with a callback-first argument shape", expr, FORMS_HINT);
  } else {
    const p = L.lowerExpr(args[0]!);
    if (p.type.kind === "f64") port = p;
    else if (p.type.kind === "dyn") port = { kind: "dynCheck", value: p, type: F64, loc };
    else L.noLowering(`tls.connect with a '${L.fmt(p.type)}' port`, args[0]!, FORMS_HINT);
    i = 1;
    if (i < args.length && !isFuncish(args[i]!) && !isObjectish(args[i]!)) {
      const h = L.lowerExpr(args[i]!);
      if (h.type.kind === "string") host = h;
      else if (h.type.kind === "dyn") host = { kind: "dynCheck", value: h, type: STRING, loc };
      else L.noLowering(`tls.connect with a '${L.fmt(h.type)}' host`, args[i]!, FORMS_HINT);
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
  if (optsNode !== null) {
    const o = L.lowerExpr(optsNode);
    if (o.type.kind === "dyn") {
      opts = o;
    } else if (canConvertToDyn(o.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))) {
      opts = { kind: "dynFrom", value: o, type: DYN, loc };
    } else {
      L.noLowering(
        `tls.connect with a '${L.fmt(o.type)}' options record`,
        optsNode,
        FORMS_HINT,
      );
    }
  } else {
    if (port.kind === "numLit" && port.value === -1) {
      L.noLowering("tls.connect without a port or options", expr, FORMS_HINT);
    }
    // No options: Node's defaults (rejectUnauthorized: true) — the
    // runtime walk reads an absent record (the dyn undefined).
    opts = {
      kind: "dynFrom",
      value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
      type: DYN,
      loc,
    };
  }
  let cb: IrExpr | null = null;
  if (i < args.length) {
    if (i !== args.length - 1 || !isFuncish(args[i]!)) {
      L.noLowering("tls.connect with this argument shape", expr, FORMS_HINT);
    }
    const r = lowerCallbackArg(
      L, args[i]!, "secureConnect listeners", 0,
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
function lowerTlsModuleCall(L: Lowerer, expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,): IrExpr {
  const args = expr.arguments;
  if (bi.member === "createServer") {
    if (args.length < 1 || args.length > 2) {
      L.noLowering(
        `createServer with ${args.length} arguments`,
        expr,
        "the supported form is createServer({ cert, key }, socket => ...)",
      );
    }
    const opts = lowerTlsServerOptionsOrDyn(L, args[0]!, "tls.createServer");
    if (args.length === 1) {
      return opts.dyn !== undefined
        ? { kind: "libCall", fn: "tls.createServerDyn", args: [opts.dyn], type: NETSERVER_T, loc }
        : { kind: "libCall", fn: "tls.createServer", args: [opts.cert, opts.key], type: NETSERVER_T, loc };
    }
    const { cb } = lowerCallbackArg(
      L, args[1]!, "secureConnection listeners", 1,
      (p) => p.kind === "netSocket",
      "use (socket) or ()",
      [NETSOCKET_T],
    );
    return opts.dyn !== undefined
      ? { kind: "libCall", fn: "tls.createServerDynCb", args: [opts.dyn, cb], type: NETSERVER_T, loc }
      : { kind: "libCall", fn: "tls.createServerCb", args: [opts.cert, opts.key, cb], type: NETSERVER_T, loc };
  }
  if (bi.member === "connect") {
    return lowerTlsConnectCall(L, expr, loc);
  }
  if (bi.member === "getCACertificates" && args.length === 1 && !args.some(ts.isSpreadElement) &&
      isJsSourceFile(expr.getSourceFile())) {
    // The type-argument ladder (validateString + the documented name
    // set); the real CA list has no lowering, so a valid name meets the
    // compiler-rendered fence after the validation.
    const raw = L.lowerExpr(args[0]!);
    if (raw.type.kind === "dyn" || raw.kind === "unitLit" || L.dynConvertible(raw.type)) {
      const t: IrExpr = raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
      return {
        kind: "libCall",
        fn: "tls.caCertsChk",
        args: [t, ladderFenceExpr(L, "tls.getCACertificates", expr)],
        type: L.mapTypeOf(L.typeOf(expr)) ?? DYN,
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
      L.noLowering(
        `createSecureContext with ${args.length} arguments`,
        expr,
        "the supported form is createSecureContext({ cert, key })",
      );
    }
    const opts = lowerTlsServerOptionsOrDyn(L, args[0]!, "tls.createSecureContext");
    if (opts.dyn !== undefined) {
      return { kind: "libCall", fn: "tls.createSecureContextDyn", args: [opts.dyn], type: SECURECTX_T, loc };
    }
    return { kind: "libCall", fn: "tls.createSecureContext", args: [opts.cert, opts.key], type: SECURECTX_T, loc };
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
      L.noLowering(`getCACertificates with ${args.length} arguments`, expr);
    }
    const typeArg: IrExpr = args.length === 1
      ? L.lowerExprExpecting(args[0]!, STRING)
      : { kind: "strLit", value: "default", type: STRING, loc };
    return { kind: "libCall", fn: "tlsca.get", args: [typeArg], type: arrayOf(STRING), loc };
  }
  if (bi.member === "setDefaultCACertificates") {
    if (args.length !== 1) {
      L.noLowering(`setDefaultCACertificates with ${args.length} arguments`, expr);
    }
    const certs = L.lowerExpr(args[0]!);
    if (certs.type.kind !== "array" || certs.type.elem.kind !== "string") {
      L.noLowering(
        `setDefaultCACertificates of a '${L.fmt(certs.type)}' value`,
        args[0]!,
        "a string[] of PEM certificates is the lowered shape — decode Buffer/typed-array entries to strings first",
      );
    }
    return { kind: "libCall", fn: "tlsca.set", args: [certs], type: VOID, loc };
  }
  L.noLowering(
    `tls.${bi.member}`,
    expr,
    builtinFenceHintOf("tls", bi.member) ??
      "createServer({ cert, key }, handler) and createSecureContext({ cert, key }) are the lowered tls module functions",
    L.resolveValueSymbol(expr.expression as ts.Identifier),
  );
}

/** The tls.rootCertificates VALUE read (any import spelling): the same
 * cached array getCACertificates("bundled") answers — Node's own
 * equality (test-tls-get-ca-certificates-bundled pins certs ===
 * rootCertificates). Null for other members (the property chains keep
 * trying). */
export function lowerTlsRootCertificates(L: Lowerer, bi: { module: string; member: string }, loc: SrcLoc): IrExpr | null {
  if (bi.module !== "tls" || bi.member !== "rootCertificates") return null;
  return { kind: "libCall", fn: "tlsca.root", args: [], type: arrayOf(STRING), loc };
}

/** The `const requestFn = tls ? https.request : http.request` binding —
 * the module-function-as-value ternary between the two known clients
 * (the promisifiedExecFile registry's cousin, keyed per Lowerer pass).
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

const httpClientFnBindings = new WeakMap<Lowerer, Map<ts.Symbol, HttpClientFnBinding>>();

export function httpClientFnBindingOf(L: Lowerer, sym: ts.Symbol): HttpClientFnBinding | undefined {
  return httpClientFnBindings.get(L)?.get(sym);
}

/** The { module, member } of an http/https client-function REFERENCE
 * (`https.request` through a namespace import, or a named `request`
 * import binding) — null for anything else. */
function clientFnRefOf(L: Lowerer, node: ts.Expression): { module: "http" | "https"; member: "request" | "get" } | null {
  const e = node;
  const bi = ts.isPropertyAccessExpression(e)
    ? L.builtinMemberOf(e)
    : ts.isIdentifier(e)
      ? L.builtinImportOf(e)
      : null;
  if (!bi) return null;
  if ((bi.module !== "http" && bi.module !== "https") || (bi.member !== "request" && bi.member !== "get")) {
    return null;
  }
  return { module: bi.module, member: bi.member };
}

/** True when `sym`'s binding is never written after initialization: a
 * `const` declaration, or a parameter/let whose enclosing scope contains
 * no assignment or ++/-- targeting it. */
function neverReassigned(L: Lowerer, sym: ts.Symbol): boolean {
  const decl = L.checker.declarationsOf(sym)[0];
  if (!decl) return false;
  if (ts.isVariableDeclaration(decl) && (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0) {
    return true;
  }
  if (!ts.isParameter(decl) && !ts.isVariableDeclaration(decl)) return false;
  // The declaring scope: the nearest enclosing function-like body, or the
  // source file for module-level bindings. Writes anywhere inside
  // (nested closures included) disqualify.
  let scope: ts.Node = decl;
  while (!ts.isFunctionLike(scope.parent) && !ts.isSourceFile(scope.parent)) scope = scope.parent;
  const root: ts.Node = ts.isFunctionLike(scope.parent) ? scope.parent : scope.parent;
  let written = false;
  const hitsSym = (n: ts.Node): boolean => {
    if (ts.isIdentifier(n) && L.checker.getSymbolAtLocation(n) === sym) return true;
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
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isIdentifier(n.operand) && L.checker.getSymbolAtLocation(n.operand) === sym) {
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
export function registerHttpClientFnBinding(L: Lowerer, nameNode: ts.Node, init: ts.Expression | undefined): boolean {
  if (!init) return false;
  let e: ts.Expression = init;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isConditionalExpression(e)) return false;
  const unwrap = (a: ts.Expression): ts.Expression => {
    let x = a;
    while (ts.isParenthesizedExpression(x)) x = x.expression;
    return x;
  };
  const t = clientFnRefOf(L, unwrap(e.whenTrue));
  const f = clientFnRefOf(L, unwrap(e.whenFalse));
  if (!t || !f) return false;
  if (t.member !== f.member || t.module === f.module) {
    L.noLowering(
      "a conditional between these two client functions",
      e,
      "the lowered shape is `cond ? https.request : http.request` (or the .get pair, either order) — the same member of both modules",
    );
  }
  const cond = unwrap(e.condition);
  const condSym = ts.isIdentifier(cond) ? L.resolveValueSymbol(cond) : null;
  if (!condSym || !neverReassigned(L, condSym)) {
    L.noLowering(
      "a client-function conditional with this condition shape",
      e.condition,
      "the condition must be a bare identifier whose binding is never reassigned (it re-evaluates at each call through the binding)",
    );
  }
  const symbol = L.checker.getSymbolAtLocation(nameNode);
  if (symbol) {
    let map = httpClientFnBindings.get(L);
    if (!map) {
      map = new Map();
      httpClientFnBindings.set(L, map);
    }
    map.set(symbol, { cond, trueSecure: t.module === "https", member: t.member });
  }
  return true;
}

/** A call THROUGH a registered requestFn binding: the http client
 * lowering with the RUNTIME-secure extras (the binding mode). */
export function lowerHttpClientFnCall(L: Lowerer, expr: ts.CallExpression,
  binding: HttpClientFnBinding, loc: SrcLoc,): IrExpr {
  return lowerHttpClientCall(L, expr, binding.member, loc, binding);
}

/** Module-function calls on https import bindings: createServer(options,
 * handler) and request/get — the http client lowering with the secure
 * extras (port 443 default, rejectUnauthorized, ca). */
function lowerHttpsModuleCall(L: Lowerer, expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,): IrExpr {
  const args = expr.arguments;
  if (bi.member === "createServer") {
    if (args.length < 1 || args.length > 2) {
      L.noLowering(
        `createServer with ${args.length} arguments`,
        expr,
        "the supported form is createServer({ cert, key }, (req, res) => ...)",
      );
    }
    const opts = lowerTlsServerOptionsOrDyn(L, args[0]!, "https.createServer", true);
    if (args.length === 1) {
      // The handler-less form: 'request' listeners arrive later via
      // server.on("request", ...) — the createSecureServer emission's
      // NULL-handler shape, here for the runtime-options record only
      // (the literal path keeps its historical two-argument surface).
      if (opts.dyn !== undefined) {
        return { kind: "libCall", fn: "https.createServerDyn", args: [opts.dyn], type: NETSERVER_T, loc };
      }
      L.noLowering(
        "createServer with 1 arguments",
        expr,
        "the supported form is createServer({ cert, key }, (req, res) => ...)",
      );
    }
    const cb = lowerRequestHandlerArg(L, args[1]!);
    return opts.dyn !== undefined
      ? { kind: "libCall", fn: "https.createServerDynCb", args: [opts.dyn, cb], type: NETSERVER_T, loc }
      : { kind: "libCall", fn: "https.createServer", args: [opts.cert, opts.key, cb], type: NETSERVER_T, loc };
  }
  if (bi.member === "request" || bi.member === "get") {
    return lowerHttpClientCall(L, expr, bi.member, loc, true);
  }
  L.noLowering(
    `https.${bi.member}`,
    expr,
    "createServer, request, and get are the lowered https module functions",
    L.resolveValueSymbol(expr.expression as ts.Identifier),
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
function lowerHttp2ModuleCall(L: Lowerer, expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,): IrExpr {
  const args = expr.arguments;
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
      const t = L.typeOf(a);
      if (L.checker.getCallSignatures(t).length > 0 ||
          (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
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
    const cb = lowerRequestHandlerArg(L, handlerNode);
    return { kind: "libCall", fn: "http2.createServerReq", args: [cb], type: NETSERVER_T, loc };
  }
  if (bi.member === "connect") {
    // http2.connect(authority[, listener]) — the h2c client. The
    // authority is a string (URL objects and an options record fence).
    if (args.length < 1 || args.length > 3) {
      L.noLowering(`http2.connect with ${args.length} arguments`, expr,
        "the supported form is connect(authority[, options][, listener]) with a string authority");
    }
    const auth = L.lowerExpr(args[0]!);
    if (auth.type.kind !== "string") {
      L.noLowering(`http2.connect with a '${L.fmt(auth.type)}' authority`, args[0]!,
        "the authority is a string here (\"http://host:port\")");
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
    const arg1IsDyn = args.length >= 2 &&
      (L.typeOf(args[1]!).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    if (args.length >= 2 && !arg1IsDyn &&
        L.checker.getCallSignatures(L.typeOf(args[1]!)).length === 0) {
      if (ts.isObjectLiteralExpression(args[1]!)) {
        for (const pr of (args[1] as ts.ObjectLiteralExpression).properties) {
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
            L.noLowering("http2.connect with a createConnection option", args[1]!,
              "custom transports are not modeled — connect dials TCP itself");
          }
          if (name === "rejectUnauthorized") {
            if (valueNode.kind === ts.SyntaxKind.FalseKeyword) {
              reject = { kind: "boolLit", value: false, type: BOOL, loc };
            } else if (valueNode.kind !== ts.SyntaxKind.TrueKeyword) {
              L.noLowering("http2.connect with a non-literal rejectUnauthorized option", pr,
                "spell it true or false — it gates the https authority's certificate verification");
            }
          }
          if (name === "ca") {
            const v = L.lowerExpr(valueNode);
            if (v.type.kind === "string" || (v.type.kind === "bytes" && v.type.elem === "u8")) {
              ca = v;
            } else if (v.type.kind === "dyn") {
              ca = {
                kind: "libCall",
                fn: "tls.pemDyn",
                args: [v, { kind: "strLit", value: "an http2.connect 'ca' option", type: STRING, loc }],
                type: BYTES_U8,
                loc,
              };
            } else {
              L.noLowering(`an http2.connect 'ca' option of '${L.fmt(v.type)}' values`, pr,
                "ca is a PEM string or Buffer here");
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
        L, listenerNode, "connect listeners", 2,
        (p) => p.kind === "http2Session" || p.kind === "netSocket",
        "use (session, socket), (session), or ()",
        [HTTP2SESSION_T, NETSOCKET_T],
      );
      return { kind: "libCall", fn: "http2.connectCb", args: [auth, reject, ca, cb], type: HTTP2SESSION_T, loc };
    }
    return { kind: "libCall", fn: "http2.connect", args: [auth, reject, ca], type: HTTP2SESSION_T, loc };
  }
  if (bi.member === "getDefaultSettings") {
    // The constant defaults record, as a dyn value (the d.ts types it
    // `any` — reads ride the checked-dynamic keyed read).
    return { kind: "libCall", fn: "http2.getDefaultSettings", args: [], type: DYN, loc };
  }
  if (bi.member === "createSecureServer") {
    if (args.length < 1 || args.length > 2) {
      L.noLowering(
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
      const v = L.lowerExpr(optsNode);
      let dynOpts: IrExpr;
      if (v.type.kind === "dyn") {
        dynOpts = v;
      } else if (canConvertToDyn(v.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))) {
        dynOpts = { kind: "dynFrom", value: v, type: DYN, loc: locOf(optsNode) };
      } else {
        L.noLowering(
          "createSecureServer with a non-literal options argument",
          optsNode,
          "pass the options as an object literal ({ allowHTTP1: true, cert, key }) or a runtime record of those members",
        );
      }
      if (handlerNode === null) {
        return { kind: "libCall", fn: "http2.createSecureServerDyn", args: [dynOpts], type: NETSERVER_T, loc };
      }
      const cb = lowerRequestHandlerArg(L, handlerNode);
      return { kind: "libCall", fn: "http2.createSecureServerDynCb", args: [dynOpts, cb], type: NETSERVER_T, loc };
    }
    let cert: IrExpr | null = null;
    let key: IrExpr | null = null;
    let sni: IrExpr | null = null;
    let allowHttp1 = false;
    let enableConnectProtocol = false;
    // The SNICallback value shape: (servername: string, cb) => void where
    // cb is (err: Error | null, ctx?: SecureContext) => void — cb may
    // declare fewer params (the emitted answer thunk matches its ABI),
    // but what it does declare must carry the arms the thunk decodes.
    const sniShapeOk = (t: IrType): boolean => {
      if (t.kind !== "func" || t.ret.kind !== "void" || t.params.length !== 2) return false;
      if (t.params[0]!.kind !== "string") return false;
      const cbT = t.params[1]!;
      if (cbT.kind !== "func" || cbT.ret.kind !== "void" || cbT.params.length > 2) return false;
      const armKinds = (u: IrType): string[] =>
        u.kind === "union" ? (L.unions.get(u.unionId)?.arms ?? []).map((a) => a.kind) : [];
      const p0 = cbT.params[0];
      if (p0 !== undefined && !armKinds(p0).includes("nullT")) return false;
      const p1 = cbT.params[1];
      if (p1 !== undefined && !armKinds(p1).includes("secureCtx")) return false;
      return true;
    };
    const lowerSniValue = (node: ts.Expression, blame: ts.Node): void => {
      const v = L.lowerExpr(node);
      const funcArm =
        v.type.kind === "func"
          ? v.type
          : v.type.kind === "union"
            ? (L.unions.get(v.type.unionId)?.arms ?? []).find((a) => a.kind === "func")
            : undefined;
      const unionOk =
        v.type.kind !== "union" ||
        ((L.unions.get(v.type.unionId)?.arms ?? []).length === 2 &&
          (L.unions.get(v.type.unionId)?.arms ?? []).some((a) => a.kind === "undefinedT"));
      if (funcArm === undefined || !unionOk || !sniShapeOk(funcArm)) {
        L.noLowering(`a createSecureServer SNICallback of '${L.fmt(v.type)}' values`, blame, SNI_HINT);
      }
      sni = v;
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
          const condText = inner.condition.getText();
          const ok =
            ts.isObjectLiteralExpression(whenTrue) &&
            ts.isObjectLiteralExpression(whenFalse) &&
            whenFalse.properties.length === 0 &&
            whenTrue.properties.length === 1 &&
            ts.isPropertyAssignment(whenTrue.properties[0]!) &&
            (ts.isIdentifier(whenTrue.properties[0]!.name) ||
              ts.isStringLiteral(whenTrue.properties[0]!.name)) &&
            (whenTrue.properties[0]!.name as ts.Identifier | ts.StringLiteral).text === "SNICallback" &&
            whenTrue.properties[0]!.initializer.getText() === condText;
          if (!ok) {
            L.noLowering(
              "createSecureServer options with a conditional spread",
              prop,
              "the lowered conditional spread is exactly ...(x ? { SNICallback: x } : {}) — the included value must BE the condition",
            );
          }
          lowerSniValue(inner.condition, prop);
          return;
        }
        if (!ts.isObjectLiteralExpression(inner)) {
          L.noLowering(
            "createSecureServer options with a computed spread",
            prop,
            `spreads must be inline object literals here; ${SNI_HINT}`,
          );
        }
        for (const p of inner.properties) lowerOption(p);
        return;
      }
      let initializer: ts.Expression | null;
      if (ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
        initializer = prop.initializer;
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        initializer = null;
      } else {
        L.noLowering(
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
          L.noLowering(
            "createSecureServer with a non-literal allowHTTP1 option",
            prop,
            "allowHTTP1 picks the protocol stack (true: dual h2/http1; false/absent: ALPN=h2 only) — spell it as a literal",
          );
        }
        allowHttp1 = true;
        return;
      }
      if (k === "cert" || k === "key") {
        let v = initializer !== null
          ? L.lowerExpr(initializer)
          : L.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
        if (v.type.kind === "dyn") {
          // A runtime PEM value (fixtures.readKey(...)): the tls walk's
          // runtime extraction, same fences at runtime.
          v = {
            kind: "libCall",
            fn: "tls.pemDyn",
            args: [v, { kind: "strLit", value: `a createSecureServer '${k}' option`, type: STRING, loc }],
            type: BYTES_U8,
            loc,
          };
        } else if (v.type.kind !== "string" && !(v.type.kind === "bytes" && v.type.elem === "u8")) {
          L.noLowering(
            `a createSecureServer '${k}' option of '${L.fmt(v.type)}' values`,
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
          ts.isNumericLiteral(e) || ts.isStringLiteralLike(e) ||
          e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword;
        const isLiteralObjectOfLiterals = (e: ts.Expression): boolean =>
          ts.isObjectLiteralExpression(e) &&
          e.properties.every(
            (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && isScalarLiteral(p.initializer),
          );
        if (k === "settings" && initializer !== null && ts.isObjectLiteralExpression(initializer)) {
          for (const setting of initializer.properties) {
            if (ts.isPropertyAssignment(setting) && ts.isIdentifier(setting.name) &&
                setting.name.text === "enableConnectProtocol") {
              if (setting.initializer.kind !== ts.SyntaxKind.TrueKeyword &&
                  setting.initializer.kind !== ts.SyntaxKind.FalseKeyword) {
                L.noLowering(
                  "settings.enableConnectProtocol with a non-boolean literal",
                  setting,
                  "spell enableConnectProtocol as true or false",
                );
              }
              enableConnectProtocol = setting.initializer.kind === ts.SyntaxKind.TrueKeyword;
            }
          }
        }
        if (initializer !== null &&
            (isScalarLiteral(initializer) || isLiteralObjectOfLiterals(initializer))) {
          return;
        }
        L.noLowering(
          `createSecureServer option '${k}' with a non-literal value`,
          prop,
          "h2 session-tuning options are accepted with literal values but are not applied yet",
        );
      }
      if (k === "SNICallback") {
        if (initializer === null) {
          L.noLowering("createSecureServer with a shorthand SNICallback option", prop, "spell it out: SNICallback: theCallback");
        }
        lowerSniValue(initializer, prop);
        return;
      }
      fenceOrDropOptionKey(
        L, prop, k, "createSecureServer", HTTP2_SECURE_SERVER_DOCUMENTED_OPTIONS,
        "allowHTTP1: true, cert, key, and SNICallback are the supported options (h2 session-tuning options are accepted as literals and ignored)",
      );
      // An undocumented key, dropped like Node drops it.
    };
    for (const prop of optsNode.properties) lowerOption(prop);
    if (cert === null || key === null) {
      L.noLowering(
        "createSecureServer without both cert and key",
        optsNode,
        "the supported options object is { allowHTTP1?, cert, key } (PEM strings or Buffers)",
      );
    }
    if (sni !== null && handlerNode !== null) {
      L.noLowering(
        "createSecureServer with both an SNICallback and an eager handler",
        expr,
        "register the handler separately: server.on(\"request\", (req, res) => ...)",
      );
    }
    if (!allowHttp1) {
      // The REAL h2-over-TLS server (scr_http2.c + scr_tls.c): ALPN
      // advertises h2 alone and the h2 session attaches at establishment
      // — 'stream'/'session' listeners, exactly the h2c server's surface.
      // SNI callbacks are an https-path feature; the h2 stack serves one
      // cert/key pair.
      if (sni !== null) {
        L.noLowering(
          "createSecureServer with an SNICallback and no allowHTTP1",
          optsNode,
          "SNICallback lowers on the dual allowHTTP1 server — the h2-only server serves one cert/key pair",
        );
      }
      if (handlerNode !== null) {
        const cb = lowerRequestHandlerArg(L, handlerNode);
        return { kind: "libCall", fn: "http2.createSecureServerH2Req", args: [cert, key, cb, boolLit(enableConnectProtocol, loc)], type: NETSERVER_T, loc };
      }
      return { kind: "libCall", fn: "http2.createSecureServerH2", args: [cert, key, boolLit(enableConnectProtocol, loc)], type: NETSERVER_T, loc };
    }
    if (sni !== null) {
      return { kind: "libCall", fn: "http2.createSecureServerSni", args: [cert, key, sni, boolLit(enableConnectProtocol, loc)], type: NETSERVER_T, loc };
    }
    if (handlerNode !== null) {
      const cb = lowerRequestHandlerArg(L, handlerNode);
      return { kind: "libCall", fn: "http2.createSecureServerReq", args: [cert, key, cb, boolLit(enableConnectProtocol, loc)], type: NETSERVER_T, loc };
    }
    return { kind: "libCall", fn: "http2.createSecureServer", args: [cert, key, boolLit(enableConnectProtocol, loc)], type: NETSERVER_T, loc };
  }
  L.noLowering(
    `http2.${bi.member}`,
    expr,
    builtinFenceHintOf("http2", bi.member) ??
      "createSecureServer({ allowHTTP1: true, cert, key }) and the h2-only form are lowered",
    L.resolveValueSymbol(expr.expression as ts.Identifier),
  );
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
function lowerHttpClientCall(L: Lowerer, expr: ts.CallExpression, member: "request" | "get",
  loc: SrcLoc, secure: boolean | HttpClientFnBinding = false): IrExpr {
  const binding = typeof secure === "object" ? secure : null;
  const secureish = binding !== null || secure === true;
  /** A FRESH lowering of the binding's secure condition (pure identifier
   * read — each use is its own IR). */
  const secureExpr = (): IrExpr => {
    const c = L.lowerCondition(binding!.cond);
    return binding!.trueSecure
      ? c
      : { kind: "unary", op: "!", operand: c, type: BOOL, loc };
  };
  const args = expr.arguments;
  if (args.length < 1 || args.length > 2) {
    L.noLowering(
      `${member} with ${args.length} arguments`,
      expr,
      `the supported form is ${member}(options[, callback])`,
    );
  }
  const optsNode = args[0]!;
  if (!ts.isObjectLiteralExpression(optsNode)) {
    const t = L.mapTypeOf(L.typeOf(optsNode));
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
      const url: IrExpr = t.kind === "url"
        ? { kind: "libCall", fn: "url.href", args: [L.lowerExpr(optsNode)], type: STRING, loc }
        : L.lowerExprExpecting(optsNode, STRING);
      const methodLit: IrExpr = { kind: "strLit", value: "GET", type: STRING, loc };
      const autoEnd = boolLit(member === "get", loc);
      const isTls = secure === true;
      if (args.length === 1) {
        const fn = isTls ? "https.requestUrl" as const : "http.requestUrl" as const;
        return { kind: "libCall", fn, args: [url, methodLit, autoEnd], type: HTTPCLIENTREQ_T, loc };
      }
      const { cb } = lowerCallbackArg(
        L, args[1]!, "response callbacks", 1,
        (p) => p.kind === "httpReq",
        "use (res) or ()",
        [HTTPREQ_T],
      );
      const fn = isTls ? "https.requestUrlCb" as const : "http.requestUrlCb" as const;
      return { kind: "libCall", fn, args: [url, methodLit, autoEnd, cb], type: HTTPCLIENTREQ_T, loc };
    }
    L.noLowering(
      t?.kind === "string"
        ? `a URL-string first argument through a request-function binding`
        : `${member} with a non-literal options argument`,
      optsNode,
      t?.kind === "string"
        // Only the binding mode reaches here now: the scheme would have to
        // agree with a dial chosen at runtime.
        ? "call http.request / https.request directly for the URL-string form, or pass the options as an object literal"
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
  for (const prop of optsNode.properties) {
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
      if (cs !== null && cs !== "unsupported" && cs.props.length === 1 &&
          cs.props[0]!.name.text === "rejectUnauthorized" &&
          ts.isPropertyAssignment(cs.props[0]!) && secureish) {
        const cond = L.lowerCondition(cs.cond);
        const v = L.lowerExpr((cs.props[0] as ts.PropertyAssignment).initializer);
        if (v.type.kind !== "bool") {
          L.noLowering(
            `a ${member} 'rejectUnauthorized' option of '${L.fmt(v.type)}' values`,
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
      L.noLowering(
        `${member} with this options spread`,
        prop,
        secureish
          ? "the one supported spread is the conditional `...(c ? { rejectUnauthorized: <bool> } : {})` (either orientation) — write other members inline"
          : "spreads have no lowering here — write each option inline",
      );
    }
    let initializer: ts.Expression | null;
    if (ts.isPropertyAssignment(prop) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
      initializer = prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      initializer = null;
    } else {
      L.noLowering(
        `${member} options with computed keys`,
        prop,
        "each option must be a plain `name: value` (or shorthand) entry with a literal key",
      );
    }
    const key = (prop.name as ts.Identifier | ts.StringLiteral).text;
    const lowerVal = (want: "string" | "f64"): IrExpr => {
      const v = initializer !== null
        ? L.lowerExpr(initializer)
        : L.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
      // A checked-dynamic value (an untyped JS binding carrying the
      // port/path through a helper): dynCheck validates it into the
      // option's type — a mismatch is the catchable path-annotated
      // TypeError, the boundary's stance.
      if (v.type.kind === "dyn") {
        return { kind: "dynCheck", value: v, type: want === "string" ? STRING : F64, loc: locOf(prop) };
      }
      if (v.type.kind !== want) {
        L.noLowering(
          `a ${member} '${key}' option of '${L.fmt(v.type)}' values`,
          prop,
          want === "string" ? "the option value must be a string" : "the option value must be a number",
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
      case "headers":
        if (initializer === null) {
          L.noLowering(`${member} with a shorthand headers option`, prop, "spell it out: headers: theHeaders");
        }
        headers = lowerClientHeadersOption(L, initializer);
        break;
      case "createConnection": {
        // The caller's own dialer: a `() => net.Socket` closure the
        // runtime invokes once, synchronously (the proxy's loopback
        // dial). https keeps the fence — the TLS client owns its socket —
        // and the binding mode inherits it (its https arm would).
        if (secureish) {
          L.noLowering(
            `${member} with a createConnection option`,
            prop,
            "the https client dials its own TLS socket — pass hostname/port",
          );
        }
        if (initializer === null) {
          L.noLowering(`${member} with a shorthand createConnection option`, prop, "spell it out: createConnection: theDialer");
        }
        const v = L.lowerExpr(initializer);
        if (v.type.kind !== "func" || v.type.params.length !== 0 || v.type.ret.kind !== "netSocket") {
          L.noLowering(
            `a ${member} 'createConnection' option of '${L.fmt(v.type)}' values`,
            prop,
            "the dialer is () => net.Socket — no arguments, returning the socket to use",
          );
        }
        connCb = v;
        break;
      }
      case "rejectUnauthorized": {
        if (!secureish) {
          L.noLowering(
            `${member} option 'rejectUnauthorized'`,
            prop,
            "rejectUnauthorized is an https.request option — the plain http client has no TLS layer",
          );
        }
        const v = initializer !== null
          ? L.lowerExpr(initializer)
          : L.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
        if (v.type.kind !== "bool") {
          L.noLowering(
            `a ${member} 'rejectUnauthorized' option of '${L.fmt(v.type)}' values`,
            prop,
            "the option value must be a boolean",
          );
        }
        reject = v;
        break;
      }
      case "ca": {
        if (!secureish) {
          L.noLowering(
            `${member} option 'ca'`,
            prop,
            "ca is an https.request option — the plain http client has no TLS layer",
          );
        }
        const v = initializer !== null
          ? L.lowerExpr(initializer)
          : L.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
        if (v.type.kind !== "string" && !(v.type.kind === "bytes" && v.type.elem === "u8")) {
          L.noLowering(
            `a ${member} 'ca' option of '${L.fmt(v.type)}' values`,
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
        if (e !== null &&
            (e.kind === ts.SyntaxKind.NullKeyword ||
             (ts.isIdentifier(e) && e.text === "undefined"))) {
          break; // the default agent: what the agent-free call compiles
        }
        const v = initializer !== null
          ? L.lowerExpr(initializer)
          : L.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment);
        if (v.type.kind !== "dyn") {
          L.noLowering(
            `a ${member} 'agent' option of '${L.fmt(v.type)}' values`,
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
          L, prop, key, member,
          secureish ? HTTPS_CLIENT_DOCUMENTED_OPTIONS : HTTP_CLIENT_DOCUMENTED_OPTIONS,
          secureish
            ? "hostname/host, port, path, method, timeout, headers, agent, rejectUnauthorized, and ca are the supported options"
            : "hostname/host, port, path, method, timeout, headers, and agent are the supported options",
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
      headers = { kind: "arrayLit", elems: [strLit("Connection", loc), strLit("close", loc)], type: arrayOf(STRING), loc };
    } else if (headers.kind === "arrayLit") {
      const hasConnection = headers.elems.some(
        (el, i) => i % 2 === 0 && el.kind === "strLit" && el.value.toLowerCase() === "connection",
      );
      if (!hasConnection) {
        headers = { ...headers, elems: [...headers.elems, strLit("Connection", loc), strLit("close", loc)] };
      }
    } else {
      L.noLowering(
        `${member} with agent: false and a non-literal headers record`,
        agentClose,
        "agent: false lowers by injecting Connection: close into a LITERAL headers object — " +
          "add connection: \"close\" to the record instead, or write the headers inline",
      );
    }
  }

  if (connCb !== null && (host !== null || port !== null)) {
    // Node would use host/port only for the Host header once a dialer
    // exists — a silent half-use; set headers.host instead.
    L.noLowering(
      `${member} mixing createConnection with hostname/host/port`,
      optsNode,
      "the dialer supplies the socket — set the Host header via headers: { host: ... } instead",
    );
  }
  if (agentVal !== null && connCb !== null) {
    L.noLowering(
      `${member} mixing an agent value with createConnection`,
      optsNode,
      "both own the dial — pass one or the other",
    );
  }
  if (agentVal !== null && binding !== null) {
    L.noLowering(
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
  port ??= binding !== null
    ? { kind: "ternary", cond: secureExpr(), then: numLit(443, loc), else_: numLit(80, loc), type: F64, loc }
    : agentVal !== null ? numLit(-1, loc)
    : numLit(secure === true ? 443 : 80, loc);
  path ??= strLit("/", loc);
  method ??= strLit("GET", loc);
  timeout ??= numLit(0, loc);
  headers ??= { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc };
  const autoEnd = boolLit(member === "get", loc);
  if (connCb !== null) {
    const base = [connCb, path, method, timeout, headers, autoEnd];
    if (args.length === 1) {
      return { kind: "libCall", fn: "http.requestConn", args: base, type: HTTPCLIENTREQ_T, loc };
    }
    const { cb } = lowerCallbackArg(
      L, args[1]!, "response callbacks", 1,
      (p) => p.kind === "httpReq",
      "use (res) or ()",
      [HTTPREQ_T],
    );
    return { kind: "libCall", fn: "http.requestConnCb", args: [...base, cb], type: HTTPCLIENTREQ_T, loc };
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
    const fn: IrLibFn = binding !== null ? "https.requestFn"
      : secure === true ? (agentVal !== null ? "https.requestAgent" : "https.request")
      : agentVal !== null ? "http.requestAgent" : "http.request";
    return { kind: "libCall", fn, args: base, type: HTTPCLIENTREQ_T, loc };
  }
  const { cb } = lowerCallbackArg(
    L, args[1]!, "response callbacks", 1,
    (p) => p.kind === "httpReq",
    "use (res) or ()",
    [HTTPREQ_T],
  );
  const fn: IrLibFn = binding !== null ? "https.requestFnCb"
    : secure === true ? (agentVal !== null ? "https.requestAgentCb" : "https.requestCb")
    : agentVal !== null ? "http.requestAgentCb" : "http.requestCb";
  return { kind: "libCall", fn, args: [...base, cb], type: HTTPCLIENTREQ_T, loc };
}

/** The headers option of http.request: an object literal with literal
 * keys and string values packs into the flat [k0, v0, k1, v1, ...] pairs
 * array directly; any other expression must be a Record whose values are
 * strings (or `string | undefined` — absent entries drop, the env-option
 * rule), flattened by the interned env.pairs helper. */
function lowerClientHeadersOption(L: Lowerer, node: ts.Expression): IrExpr {
  const loc = locOf(node);
  if (ts.isObjectLiteralExpression(node)) {
    const elems: IrExpr[] = [];
    for (const prop of node.properties) {
      const key = ts.isPropertyAssignment(prop) ? staticHeaderKeyOf(L, prop) : null;
      if (!ts.isPropertyAssignment(prop) || key === null) {
        L.noLowering(
          "request headers with dynamic keys, spreads, or shorthand entries",
          prop,
          "each header must be a `name: value` entry whose key is a literal (or a string-literal-typed const: [PORTLESS_HEADER])",
        );
      }
      let value = L.lowerExpr(prop.initializer);
      if (value.type.kind === "f64") {
        // Node formats number values via String(n) — the same ToString.
        value = { kind: "toString", operand: value, type: STRING, loc };
      }
      if (value.type.kind !== "string") {
        L.noLowering(
          `request header values of type '${L.fmt(value.type)}'`,
          prop.initializer,
          "header values are strings or numbers here",
        );
      }
      elems.push({ kind: "strLit", value: key, type: STRING, loc });
      elems.push(value);
    }
    return { kind: "arrayLit", elems, type: arrayOf(STRING), loc };
  }
  const v = L.lowerExpr(node);
  if (v.type.kind !== "record") {
    L.noLowering(
      `request headers of '${L.fmt(v.type)}' values`,
      node,
      "pass an object literal or a Record<string, string>",
    );
  }
  const helper = L.envToPairsHelper(v.type.shapeId, loc);
  if (helper === null) {
    L.noLowering(
      `request headers of '${L.fmt(v.type)}' values`,
      node,
      "header values must be strings (or string | undefined)",
    );
  }
  return { kind: "call", callee: helper, args: [v], type: arrayOf(STRING), loc };
}

/** Method calls on ClientRequest receivers: write/end/destroy and
 * on/once("response" | "error" | "timeout" | "close"). Null for other
 * receivers. */
function lowerHttpClientMethodCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,): IrExpr | null {
  if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "httpClientReq") return null;
  if (!L.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  if (name === "write" || name === "end") {
    requireStatementPosition(L, call, `request.${name}(...)`);
    const minArgs = name === "write" ? 1 : 0;
    if (args.length < minArgs || args.length > 1) {
      L.noLowering(
        `${name} with ${args.length} arguments`,
        call,
        name === "write" ? "the supported form is write(data)" : "the supported forms are end() and end(data)",
      );
    }
    const receiver = L.lowerExpr(access.expression);
    if (args.length === 0) {
      return { kind: "libCall", fn: "http.clientEnd", args: [receiver], type: VOID, loc };
    }
    const data = L.lowerExpr(args[0]!);
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
    L.noLowering(`${name} of '${L.fmt(data.type)}' data`, args[0] ?? call, NARROW_DATA_HINT);
  }
  if (name === "destroy") {
    requireStatementPosition(L, call, "request.destroy()");
    if (args.length !== 0) {
      L.noLowering(`destroy with ${args.length} arguments`, call, "destroy() takes no arguments here");
    }
    const receiver = L.lowerExpr(access.expression);
    return { kind: "libCall", fn: "http.clientDestroy", args: [receiver], type: VOID, loc };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    requireStatementPosition(L, call, `request.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = L.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const receiver = L.lowerExpr(access.expression);
    if (event === "response") {
      const { cb } = lowerCallbackArg(
        L, args[1]!, "response listeners", 1,
        (p) => p.kind === "httpReq",
        "use (res) or ()",
        [HTTPREQ_T],
      );
      return { kind: "libCall", fn: "http.clientOnResponse", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "error") {
      const { cb } = lowerCallbackArg(
        L, args[1]!, "error listeners", 1,
        (p) => p.kind === "object" && p.className === "%Error",
        "use (err) or ()",
        [ERROR_T],
      );
      return { kind: "libCall", fn: "http.clientOnError", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "timeout" || event === "close") {
      const { cb } = lowerCallbackArg(L, args[1]!, `${event} listeners`, 0, () => false, "use ()", []);
      const fn: IrLibFn = event === "timeout" ? "http.clientOnTimeout" : "http.clientOnClose";
      return { kind: "libCall", fn, args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "upgrade") {
      // The client half of the WebSocket handover: a 101 response fires
      // (res, socket, head) INSTEAD of 'response'; no listener destroys
      // the connection, Node's default.
      const cb = L.lowerExpr(args[1]!);
      if (cb.type.kind !== "func" || cb.type.params.length > 3) {
        L.unsupported(
          "SC1090",
          args[1]!,
          "upgrade listeners with more than three parameters (use (res, socket, head))",
        );
      }
      if (cb.type.ret.kind !== "void") {
        L.unsupported(
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
        L.unsupported(
          "SC1090",
          args[1]!,
          "upgrade listeners whose parameters are not (res: IncomingMessage, socket: Socket, head: Buffer)",
        );
      }
      return { kind: "libCall", fn: "http.clientOnUpgrade", args: [receiver, cb, once], type: VOID, loc };
    }
    L.noLowering(
      `request.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
      args[0]!,
      '"response", "upgrade", "error", "timeout", and "close" are the supported request events (as literals)',
    );
  }
  L.noLowering(
    `ClientRequest.${name}`,
    call,
    "write, end, destroy, destroyed, and on/once of response/error/timeout/close are the supported ClientRequest members",
    L.checker.getSymbolAtLocation(access.name),
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
export function isStreamUndefCallExpr(L: Lowerer, node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isPropertyAccessExpression(node.expression.expression) &&
    !node.expression.expression.questionDotToken &&
    !node.expression.questionDotToken &&
    (node.expression.expression.name.text === "stream" ||
      node.expression.expression.name.text === "session") &&
    ts.isIdentifier(node.expression.expression.expression) &&
    L.mapTypeOf(L.typeOf(node.expression.expression.expression))?.kind === "httpReq" &&
    L.isStdlibMember(node.expression.expression)
  );
}

/** `x instanceof net.Socket` over a UNION-typed x with a netSocket arm —
 * the h2 compat 'connect' listener's narrowing (`resOrSocket instanceof
 * net.Socket`): one runtime tag test; tsc's control-flow narrowing types
 * the branches and reads bridge through maybeNarrow's unionNarrow. Null
 * for every other shape (lower-exprs' fences stand). */
export function lowerSocketInstanceOf(L: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrExpr | null {
  const rhs = expr.right;
  const isNetSocketRef =
    (ts.isPropertyAccessExpression(rhs) &&
      rhs.name.text === "Socket" &&
      L.builtinMemberOf(rhs)?.module === "net") ||
    (ts.isIdentifier(rhs) && L.builtinImportOf(rhs)?.module === "net" &&
      L.builtinImportOf(rhs)?.member === "Socket");
  if (!isNetSocketRef) return null;
  const leftT = L.mapTypeOf(L.typeOf(expr.left));
  if (leftT?.kind !== "union") return null;
  const def = L.unions.get(leftT.unionId);
  const tag = def ? def.arms.findIndex((a) => a.kind === "netSocket") : -1;
  if (tag < 0) return null;
  const left = L.lowerExpr(expr.left);
  if (left.type.kind !== "union" || left.type.unionId !== leftT.unionId) return null;
  return { kind: "unionIsTag", unionId: leftT.unionId, tag, negated: false, value: left, type: BOOL, loc };
}

/** True when `node` reads `.headers` off an IncomingMessage — the
 * receiver shape of both header-read forms. */
function isHttpReqHeaders(L: Lowerer, node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    !node.questionDotToken &&
    node.name.text === "headers" &&
    L.mapTypeOf(L.typeOf(node.expression))?.kind === "httpReq" &&
    L.isStdlibMember(node)
  );
}

/** `req.headers["x-name"]` — the element twin of the property read below;
 * called from lowerElementAccess (the process.env precedent). Answers the
 * interned `string | undefined` union; names match case-insensitively
 * (the runtime stores them lowercased, like Node). */
export function lowerHttpHeadersElement(L: Lowerer, expr: ts.ElementAccessExpression): IrExpr | null {
  if (!isHttpReqHeaders(L, expr.expression)) return null;
  const recv = (expr.expression as ts.PropertyAccessExpression).expression;
  const key = L.lowerExpr(expr.argumentExpression);
  if (key.type.kind !== "string") {
    L.unsupported("SC1090", expr.argumentExpression, "indexing req.headers with non-string keys");
  }
  const receiver = L.lowerExpr(recv);
  return {
    kind: "libCall",
    fn: "http.reqHeader",
    args: [receiver, key],
    type: L.envValueType(),
    loc: locOf(expr),
  };
}

/** Method calls on IncomingMessage receivers: on/once("data" | "end").
 * Null for other receivers. */
function lowerHttpReqMethodCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,): IrExpr | null {
  if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "httpReq") return null;
  if (!L.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  if (name === "resume" || name === "destroy") {
    requireStatementPosition(L, call, `req.${name}()`);
    if (args.length !== 0) {
      L.noLowering(`${name} with ${args.length} arguments`, call, `${name}() takes no arguments here`);
    }
    const receiver = handleReceiver(L, access.expression, HTTPREQ_T);
    const fn: IrLibFn = name === "resume" ? "http.reqResume" : "http.reqDestroy";
    return { kind: "libCall", fn, args: [receiver], type: VOID, loc };
  }
  if (name === "setEncoding") {
    // setEncoding('utf8') — 'data' delivers strings (the chunk-encoding
    // window); other real encodings fence loudly at runtime, unknown
    // names throw Node's ERR_UNKNOWN_ENCODING.
    requireStatementPosition(L, call, "req.setEncoding(...)");
    if (args.length !== 1) {
      L.noLowering(`setEncoding with ${args.length} arguments`, call, "the supported form is setEncoding(encoding)");
    }
    const receiver = handleReceiver(L, access.expression, HTTPREQ_T);
    const enc = L.lowerExprExpecting(args[0]!, STRING);
    return { kind: "libCall", fn: "http.reqSetEncoding", args: [receiver, enc], type: VOID, loc };
  }
  if (name === "pipe") {
    // The proxy legs: req→res (the response body forward), req→clientReq
    // (the request body forward), req→socket (the upgrade-rejection
    // write) — plus socket→socket, which lives on the socket receiver.
    requireStatementPosition(L, call, "req.pipe(...)");
    if (args.length !== 1) {
      L.noLowering(`pipe with ${args.length} arguments`, call, "the supported form is pipe(destination)");
    }
    const receiver = handleReceiver(L, access.expression, HTTPREQ_T);
    const dst = L.lowerExpr(args[0]!);
    const fn: IrLibFn | null =
      dst.type.kind === "httpRes" ? "http.reqPipeRes"
      : dst.type.kind === "httpClientReq" ? "http.reqPipeClient"
      : dst.type.kind === "netSocket" ? "http.reqPipeSock"
      : null;
    if (fn === null) {
      L.noLowering(
        `pipe into '${L.fmt(dst.type)}' destinations`,
        args[0]!,
        "an IncomingMessage pipes into a ServerResponse, a ClientRequest, or a Socket",
      );
    }
    return { kind: "libCall", fn, args: [receiver, dst], type: VOID, loc };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    requireStatementPosition(L, call, `req.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = L.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const receiver = handleReceiver(L, access.expression, HTTPREQ_T);
    if (event === "data") {
      const { cb } = lowerCallbackArg(
        L, args[1]!, "data listeners", 1,
        (p) => p.kind === "bytes" && p.elem === "u8",
        "use (chunk: Buffer) or ()",
        [DYN],
      );
      return { kind: "libCall", fn: "http.reqOnData", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "end") {
      const { cb } = lowerCallbackArg(L, args[1]!, "end listeners", 0, () => false, "use ()", []);
      return { kind: "libCall", fn: "http.reqOnEnd", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "error") {
      const { cb } = lowerCallbackArg(
        L, args[1]!, "error listeners", 1,
        (p) => p.kind === "object" && p.className === "%Error",
        "use (err) or ()",
        [ERROR_T],
      );
      return { kind: "libCall", fn: "http.reqOnError", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "close") {
      const { cb } = lowerCallbackArg(L, args[1]!, "close listeners", 0, () => false, "use ()", []);
      return { kind: "libCall", fn: "http.reqOnClose", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "aborted") {
      // The h2 compat event (Http2ServerRequest 'aborted'); an http/1
      // request registers too and never fires — the parser lane's story.
      const { cb } = lowerCallbackArg(L, args[1]!, "aborted listeners", 0, () => false, "use ()", []);
      return { kind: "libCall", fn: "http.reqOnAborted", args: [receiver, cb, once], type: VOID, loc };
    }
    L.noLowering(
      `req.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
      args[0]!,
      '"data", "end", "error", "close", and "aborted" are the supported request events (as literals)',
    );
  }
  L.noLowering(
    `IncomingMessage.${name}`,
    call,
    "url, method, statusCode, statusMessage, socket, headers/rawHeaders reads, resume, destroy, pipe, and on/once of data/end/error/close are the supported IncomingMessage members",
    L.checker.getSymbolAtLocation(access.name),
  );
}

/** Method calls on ServerResponse receivers: setHeader/writeHead/write/
 * end. Null for other receivers. */
function lowerHttpResMethodCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,): IrExpr | null {
  if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "httpRes") return null;
  if (!L.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  if (name === "setHeader") {
    requireStatementPosition(L, call, "res.setHeader(...)");
    if (args.length !== 2) {
      L.noLowering(`setHeader with ${args.length} arguments`, call, "the supported form is setHeader(name, value)");
    }
    const receiver = handleReceiver(L, access.expression, HTTPRES_T);
    const header = L.lowerExprExpecting(args[0]!, STRING);
    let value = L.lowerExpr(args[1]!);
    if (value.type.kind === "f64") {
      // Node formats number values via String(n) — the same ToString.
      value = { kind: "toString", operand: value, type: STRING, loc };
    }
    if (value.type.kind !== "string") {
      L.noLowering(
        `setHeader with a '${L.fmt(value.type)}' value`,
        args[1]!,
        "header values are strings or numbers here",
      );
    }
    return { kind: "libCall", fn: "http.resSetHeader", args: [receiver, header, value], type: VOID, loc };
  }
  if (name === "writeHead") {
    if (args.length < 1 || args.length > 3) {
      L.noLowering(
        `writeHead with ${args.length} arguments`,
        call,
        "the supported forms are writeHead(status[, statusMessage][, headers]) — headers as a literal object, a Record, or a flat [name, value, ...] array",
      );
    }
    const receiver = handleReceiver(L, access.expression, HTTPRES_T);
    const status = L.lowerExprExpecting(args[0]!, F64);
    // The optional statusMessage: a string-typed second argument is the
    // reason phrase (Node's overload split); it rides the composing
    // helper as a resStatusMsgSet prefix before the head goes out.
    let msg: IrExpr | null = null;
    let headersNode: ts.Expression | undefined;
    if (args.length === 2) {
      if (L.mapTypeOf(L.typeOf(args[1]!))?.kind === "string") msg = L.lowerExprExpecting(args[1]!, STRING);
      else headersNode = args[1];
    } else if (args.length === 3) {
      msg = L.lowerExprExpecting(args[1]!, STRING);
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
      if (msg === null) return receiverReturningCall(L, fn, callArgs, HTTPRES_T, loc);
      // With a message the helper's parameter list gains the msg at slot
      // 1 (feeding the resStatusMsgSet prefix); the head call itself
      // re-selects around it.
      const withMsg = [callArgs[0]!, msg, ...callArgs.slice(1)];
      return receiverReturningCall(L, fn, withMsg, HTTPRES_T, loc, {
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
      const v = L.lowerExpr(headersNode);
      if (v.type.kind === "array" && v.type.elem.kind === "string") {
        return headResult("http.resWriteHeadPairs", [receiver, status, v]);
      }
      if (v.type.kind === "dyn") {
        // A checked-dynamic headers value (an untyped JS helper's
        // parameter — the suite's test(headers) idiom): the runtime OBJ
        // walk sets each entry, loud fences for non-string/number values.
        return headResult("http.resWriteHeadDyn", [receiver, status, v]);
      }
      if (v.type.kind !== "record") {
        L.noLowering(
          `writeHead with a '${L.fmt(v.type)}' headers argument`,
          headersNode,
          "pass an object literal, a Record<string, string>, or a flat [name, value, ...] string array — or call setHeader per entry before writeHead(status)",
        );
      }
      const helper = L.envToPairsHelper(v.type.shapeId, locOf(headersNode));
      if (helper === null) {
        L.noLowering(
          `writeHead headers of '${L.fmt(v.type)}' values`,
          headersNode,
          "header values must be strings (or string | undefined) — convert numbers with String(n)",
        );
      }
      const pairs: IrExpr = { kind: "call", callee: helper, args: [v], type: arrayOf(STRING), loc };
      return headResult("http.resWriteHeadPairs", [receiver, status, pairs]);
    }
    const names: IrExpr[] = [];
    const values: IrExpr[] = [];
    for (const prop of headersNode.properties) {
      const key = ts.isPropertyAssignment(prop) ? staticHeaderKeyOf(L, prop) : null;
      if (!ts.isPropertyAssignment(prop) || key === null) {
        L.noLowering(
          "writeHead headers with dynamic keys, spreads, or shorthand entries",
          prop,
          "each header must be a `name: value` entry whose key is a literal (or a string-literal-typed const: [PORTLESS_HEADER])",
        );
      }
      let value = L.lowerExpr(prop.initializer);
      if (value.type.kind === "f64") {
        // Node formats number values via String(n) — the same ToString.
        value = { kind: "toString", operand: value, type: STRING, loc };
      }
      if (value.type.kind !== "string") {
        L.noLowering(
          `writeHead header values of type '${L.fmt(value.type)}'`,
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
    requireStatementPosition(L, call, `res.${name}(...)`);
    const minArgs = name === "write" ? 1 : 0;
    const maxArgs = name === "write" ? 1 : 2;
    if (args.length < minArgs || args.length > maxArgs) {
      L.noLowering(
        `${name} with ${args.length} arguments`,
        call,
        name === "write"
          ? "the supported form is write(data)"
          : "the supported forms are end(), end(data), end(callback), and end(data, callback)",
      );
    }
    const receiver = handleReceiver(L, access.expression, HTTPRES_T);
    // end's callback forms — end(cb) / end(data, cb): the callback fires
    // deferred once the body went out (Node's 'finish' emit), through
    // the resOnFinish slot registered just before the end call in an
    // interned composing helper.
    let cbArg: IrExpr | null = null;
    let dataNode: ts.Expression | undefined = args[0];
    if (name === "end" && args.length === 2) {
      const { cb } = lowerCallbackArg(L, args[1]!, "end callbacks", 0, () => false, "use ()", []);
      cbArg = cb;
    } else if (name === "end" && args.length === 1 &&
               L.mapTypeOf(L.typeOf(args[0]!))?.kind !== "string" &&
               L.mapTypeOf(L.typeOf(args[0]!))?.kind !== "bytes") {
      const probe = L.typeOf(args[0]!);
      if (L.mapTypeOf(probe)?.kind === "func" || L.mapTypeOf(probe) === null || L.mapTypeOf(probe)?.kind === "dyn") {
        const { cb } = lowerCallbackArg(L, args[0]!, "end callbacks", 0, () => false, "use ()", []);
        cbArg = cb;
        dataNode = undefined;
      }
    }
    const endWithCb = (fn: IrLibFn, callArgs: IrExpr[], cb: IrExpr): IrExpr => {
      const all = [...callArgs, cb];
      const key = `server.endcb:${fn}:${all.map((a) => typeKey(a.type)).join(",")}`;
      const existing = L.arrHofHelpers.get(key);
      const helper = existing ?? `%server.endcb.${L.arrHofHelpers.size}`;
      if (!existing) {
        L.arrHofHelpers.set(key, helper);
        const params = all.map((a, i) => ({ localId: `p${i}.0`, name: `p${i}`, type: a.type }));
        L.liftedFns.push({
          name: helper,
          params,
          returnType: VOID,
          locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
          body: [
            {
              kind: "exprStmt",
              expr: { kind: "libCall", fn: "http.resOnFinish", args: [varRef(params[0]!.localId, params[0]!.type, loc), varRef(params[all.length - 1]!.localId, params[all.length - 1]!.type, loc)], type: VOID, loc },
              loc,
            },
            {
              kind: "exprStmt",
              expr: { kind: "libCall", fn, args: callArgs.map((_, i) => varRef(params[i]!.localId, params[i]!.type, loc)), type: VOID, loc },
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
    const data = L.lowerExpr(dataNode);
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
    L.noLowering(`${name} of '${L.fmt(data.type)}' data`, dataNode ?? call, NARROW_DATA_HINT);
  }
  if (name === "getHeader" || name === "hasHeader" || name === "removeHeader") {
    // The header CRUD trio (setHeader's readers): getHeader answers the
    // value as SET — `string | undefined` here, where Node can also
    // answer numbers/arrays it was handed (this surface stores strings);
    // removeHeader drops every case-insensitive match before the head
    // goes out; hasHeader is the boolean probe.
    if (name === "removeHeader") requireStatementPosition(L, call, "res.removeHeader(...)");
    if (args.length !== 1) {
      L.noLowering(`${name} with ${args.length} arguments`, call, `the supported form is ${name}(name)`);
    }
    const receiver = handleReceiver(L, access.expression, HTTPRES_T);
    const header = L.lowerExprExpecting(args[0]!, STRING);
    if (name === "getHeader") {
      return { kind: "libCall", fn: "http.resGetHeader", args: [receiver, header], type: L.envValueType(), loc };
    }
    if (name === "hasHeader") {
      return { kind: "libCall", fn: "http.resHasHeader", args: [receiver, header], type: BOOL, loc };
    }
    return { kind: "libCall", fn: "http.resRemoveHeader", args: [receiver, header], type: VOID, loc };
  }
  if (name === "destroy") {
    requireStatementPosition(L, call, "res.destroy()");
    if (args.length !== 0) {
      L.noLowering(`destroy with ${args.length} arguments`, call, "destroy() takes no arguments here");
    }
    const receiver = handleReceiver(L, access.expression, HTTPRES_T);
    return { kind: "libCall", fn: "http.resDestroy", args: [receiver], type: VOID, loc };
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    requireStatementPosition(L, call, `res.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = L.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const receiver = handleReceiver(L, access.expression, HTTPRES_T);
    if (event === "close") {
      const { cb } = lowerCallbackArg(L, args[1]!, "close listeners", 0, () => false, "use ()", []);
      return { kind: "libCall", fn: "http.resOnClose", args: [receiver, cb, once], type: VOID, loc };
    }
    L.noLowering(
      `res.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
      args[0]!,
      '"close" is the supported response event (as a literal)',
    );
  }
  L.noLowering(
    `ServerResponse.${name}`,
    call,
    "setHeader, getHeader, hasHeader, removeHeader, writeHead, write, end, destroy, headersSent, statusCode, statusMessage, and on/once of close are the supported ServerResponse members",
    L.checker.getSymbolAtLocation(access.name),
  );
}
