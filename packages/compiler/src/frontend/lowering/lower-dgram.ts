import { keyedHelperName } from "./stable-names.js";
import { dynUndefinedExpr, boolLit } from "../../ir/build.js";
/* The dgram/dns-surface lowering (node:dgram + node:dns — a spoke module
 * like lower-server.ts): module-function calls (dgram createSocket, dns
 * lookup), method calls on dgramSocket receivers (bind/connect/
 * disconnect/send/address/close/unref/ref, the socket options in
 * DGRAM_OPTIONS and the message/listening/close/connect/error events), and
 * the AddressInfo record materialization behind address(). Everything the
 * lib declares beyond these shapes fences member-qualified — never a
 * generic rejection, never silence. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { isJsSourceFile, locOf } from "../program.js";
import {
  BOOL,
  canBoxFuncIntoDyn,
  canDynCheckTo,
  typeKey,
  DGRAMSOCK_T,
  DYN,
  F64,
  type IrExpr,
  type IrLibFn,
  type IrType,
  type SrcLoc,
  STRING,
  VOID,
} from "../../ir/ir.js";
import { resultIsDiscarded } from "./call-position.js";
import { lowerCallbackArg as lowerCallbackArgShared } from "./callback-arg.js";
import { documentedParameter } from "./call-signatures.js";

const DGRAM_SURFACE_HINT =
  "bind, connect, disconnect, send, address, close, unref/ref, the socket " +
  "options, and on/once of message/listening/close/connect/error are the " +
  "supported dgram.Socket members";

/** The IR type each declared parameter type lowers to. */
const DGRAM_OPTION_PARAMS = { boolean: BOOL, number: F64, string: STRING } as const;

/** The socket options: each takes fixed typed arguments (the trailing
 * `optional` count may be omitted) and calls one runtime function. A
 * `value` result answers what the runtime returns; the others are
 * statements, like Node's undefined. */
const DGRAM_OPTIONS: Record<
  string,
  { fn: IrLibFn; params: (keyof typeof DGRAM_OPTION_PARAMS)[]; optional?: number; value?: IrType }
> = {
  setBroadcast: { fn: "dgram.setBroadcast", params: ["boolean"] },
  setTTL: { fn: "dgram.setTTL", params: ["number"], value: F64 },
  setMulticastTTL: { fn: "dgram.setMulticastTTL", params: ["number"], value: F64 },
  setMulticastLoopback: { fn: "dgram.setMulticastLoopback", params: ["boolean"], value: BOOL },
  setMulticastInterface: { fn: "dgram.setMulticastInterface", params: ["string"] },
  addMembership: { fn: "dgram.addMembership", params: ["string", "string"], optional: 1 },
  dropMembership: { fn: "dgram.dropMembership", params: ["string", "string"], optional: 1 },
  getRecvBufferSize: { fn: "dgram.getRecvBufferSize", params: [], value: F64 },
  getSendBufferSize: { fn: "dgram.getSendBufferSize", params: [], value: F64 },
  setRecvBufferSize: { fn: "dgram.setRecvBufferSize", params: ["number"] },
  setSendBufferSize: { fn: "dgram.setSendBufferSize", params: ["number"] },
  getSendQueueSize: { fn: "dgram.getSendQueueSize", params: [], value: F64 },
  getSendQueueCount: { fn: "dgram.getSendQueueCount", params: [], value: F64 },
  disconnect: { fn: "dgram.disconnect", params: [] },
};

/** Dgram's callback policy: validate every positional parameter and require
 * callbacks to return void; raw dyn values adapt only to zero-arg slots. */
function lowerCallbackArg(
  lowerer: Lowerer,
  node: ts.Expression,
  what: string,
  maxParams: number,
  paramOk: (param: IrType, index: number) => boolean,
  paramHint: string,
): { cb: IrExpr; nparams: number } {
  return lowerCallbackArgShared(lowerer, node, what, maxParams, paramOk, paramHint, {
    dynZero: true,
    checkAllParams: true,
    rejectValueReturn: true,
  });
}

/** VOID-result socket calls are usable as statements and as concise arrow
 * bodies; anything consuming the result (Node returns `this` where this
 * surface returns void) is fenced — the lower-server stance. */
function requireStatementPosition(lowerer: Lowerer, call: ts.CallExpression, what: string): void {
  if (resultIsDiscarded(call)) return;
  lowerer.unsupported(
    "SC1090",
    call,
    `using the result of ${what} (the result is void here — call it as its own statement)`,
  );
}

/** Lowers a listener/callback argument, pinning the closure shape: void
 * return, at most `maxParams` parameters, each parameter's IR kind
 * satisfying `paramOk` (indexed). The lower-server helper's shape,
 * re-stated here so the spoke stays self-contained. */
/** True iff `t` is a record of exactly the given (name-sorted) string/f64
 * fields — the AddressInfo/RemoteInfo shape check. */
function isRecordOfFields(
  lowerer: Lowerer,
  t: IrType,
  fields: [string, "string" | "f64"][],
): boolean {
  if (t.kind !== "record") return false;
  const shape = lowerer.shapes.get(t.shapeId);
  if (!shape || shape.tuple || shape.indexValue || shape.fields.length !== fields.length)
    return false;
  return shape.fields.every((f, i) => f.name === fields[i]![0] && f.type.kind === fields[i]![1]);
}

const ADDRINFO_FIELDS: [string, "string" | "f64"][] = [
  ["address", "string"],
  ["family", "string"],
  ["port", "f64"],
];
const RINFO_FIELDS: [string, "string" | "f64"][] = [
  ["address", "string"],
  ["family", "string"],
  ["port", "f64"],
  ["size", "f64"],
];

/** Module-function calls on dgram/dns import bindings (named imports AND
 * namespace members — both funnel here): createSocket("udp4" | { type,
 * reuseAddr? }), dns.lookup(hostname, { family: 4 }, cb). Null for other
 * modules (the caller falls through); every dgram/dns member lands here —
 * unlowered ones fence with their module-qualified name. */
export function lowerDgramDnsModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module === "dns") return lowerDnsModuleCall(lowerer, expr, bi, loc);
  if (bi.module === "dns/promises") return lowerDnsPromisesCall(lowerer, expr, bi, loc);
  if (bi.module !== "dgram") return null;
  const args = expr.arguments.nodes;
  if (bi.member === "createSocket") {
    if (args.length !== 1) {
      lowerer.noLowering(
        `createSocket with ${args.length} arguments`,
        expr,
        'the supported forms are createSocket("udp4") and createSocket({ type: "udp4", reuseAddr? })',
      );
    }
    const arg = args[0]!;
    // createSocket("udp4") — the bare string form.
    const argT = lowerer.typeOf(arg);
    if (argT.isStringLiteralType()) {
      if (argT.value !== "udp4") {
        lowerer.noLowering(
          `createSocket("${argT.value}")`,
          arg,
          '"udp4" is the supported socket type',
        );
      }
      lowerer.lowerExpr(arg); // side-effect order (a call producing the literal type)
      return {
        kind: "libCall",
        fn: "dgram.createSocket",
        args: [boolLit(false, loc)],
        type: DGRAMSOCK_T,
        loc,
      };
    }
    // createSocket({ type: "udp4", reuseAddr?: <bool> }) — an OBJECT
    // LITERAL with literal keys; type must be the "udp4" literal.
    if (!ts.isObjectLiteralExpression(arg)) {
      lowerer.noLowering(
        "createSocket with a non-literal options argument",
        arg,
        'pass the options as an object literal: createSocket({ type: "udp4" })',
      );
    }
    let sawType = false;
    let reuseAddr: IrExpr | null = null;
    for (const prop of arg.properties.nodes) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
        lowerer.noLowering(
          "createSocket options with computed keys, spreads, or shorthand entries",
          prop,
          "each option must be a plain `name: value` entry with a literal key",
        );
      }
      const name = prop.name.text;
      if (name === "type") {
        const t = lowerer.typeOf(prop.initializer);
        if (!t.isStringLiteralType() || t.value !== "udp4") {
          lowerer.noLowering(
            'createSocket with a type other than the "udp4" literal',
            prop.initializer,
            '"udp4" is the supported socket type',
          );
        }
        sawType = true;
      } else if (name === "reuseAddr") {
        reuseAddr = lowerer.lowerExprExpecting(prop.initializer, BOOL);
      } else if (name === "signal" && isJsSourceFile(ts.getSourceFileOfNode(expr))) {
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
          raw.type.kind === "array" ||
          ts.isObjectLiteralExpression(prop.initializer);
        if (provablyNot && lowerer.dynConvertible(raw.type)) {
          return {
            kind: "libCall",
            fn: "error.propTypeThrow",
            args: [
              { kind: "strLit", value: "options.signal", type: STRING, loc },
              { kind: "strLit", value: "an instance of AbortSignal", type: STRING, loc },
              lowerer.coerceToExpected(raw, DYN),
            ],
            type: DGRAMSOCK_T,
            loc,
          };
        }
        lowerer.noLowering(
          `createSocket option 'signal'`,
          prop,
          "abort-driven close has no lowering yet — type and reuseAddr are the supported options",
        );
      } else {
        lowerer.noLowering(
          `createSocket option '${name}'`,
          prop,
          "type and reuseAddr are the supported options",
        );
      }
    }
    if (!sawType) {
      lowerer.noLowering(
        "createSocket options without a type",
        arg,
        'the supported form is createSocket({ type: "udp4", reuseAddr? })',
      );
    }
    return {
      kind: "libCall",
      fn: "dgram.createSocket",
      args: [reuseAddr ?? boolLit(false, loc)],
      type: DGRAMSOCK_T,
      loc,
    };
  }
  lowerer.noLowering(
    `dgram.${bi.member}`,
    expr,
    "createSocket is the lowered dgram module function",
    ts.isIdentifier(expr.expression) ? lowerer.resolveValueSymbol(expr.expression) : undefined,
  );
}

/** A dns callback the runtime calls through the checked-dynamic boundary:
 * a dyn function as is, or a typed function boxed with per-argument
 * checks. */
function lowerDnsCallback(lowerer: Lowerer, node: ts.Expression, what: string): IrExpr {
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
    "the callback's parameters must have checked-dynamic conversions",
  );
}

/** node:dns/promises calls (and dns.promises members): lookup(hostname[,
 * options]) and lookupService(address, port) as promises over the callback
 * forms' runtime (argument errors throw synchronously, as Node validates
 * before it creates the promise), plus the shared getServers and result
 * order functions. A typed result (Promise<LookupAddress>) checks the
 * settled value through the checked-dynamic boundary. */
function lowerDnsPromisesCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr {
  const args = expr.arguments.nodes;
  const dyn = (node: ts.Expression): IrExpr =>
    lowerer.coerceToExpected(lowerer.lowerExpr(node), DYN);
  if (bi.member === "lookup" || bi.member === "lookupService") {
    const service = bi.member === "lookupService";
    if (service ? args.length !== 2 : args.length !== 1 && args.length !== 2) {
      lowerer.noLowering(
        `dnsPromises.${bi.member} with ${args.length} arguments`,
        expr,
        service
          ? "the form is lookupService(address, port)"
          : "the supported forms are lookup(hostname) and lookup(hostname, options)",
      );
    }
    const promise: IrExpr = {
      kind: "libCall",
      fn: service ? "dns.promisesLookupService" : "dns.promisesLookup",
      args: [dyn(args[0]!), args.length === 2 ? dyn(args[1]!) : dynUndefinedExpr(loc)],
      type: { kind: "promise", inner: DYN },
      loc,
    };
    const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
    if (declared === null || declared.kind !== "promise" || declared.inner.kind === "dyn") {
      return promise;
    }
    return checkedDynPromise(lowerer, promise, declared, expr, loc);
  }
  if (["getServers", "getDefaultResultOrder", "setDefaultResultOrder"].includes(bi.member)) {
    return lowerDnsModuleCall(lowerer, expr, { module: "dns", member: bi.member }, loc);
  }
  lowerer.noLowering(
    `dnsPromises.${bi.member}`,
    expr,
    "lookup, lookupService, getServers, getDefaultResultOrder, and setDefaultResultOrder are the lowered dns/promises functions",
    ts.isIdentifier(expr.expression) ? lowerer.resolveValueSymbol(expr.expression) : undefined,
  );
}

/** A promise<dyn> as the call site's typed promise: an interned async
 * helper awaits it and checks the settled value into the declared inner
 * type (a mismatch rejects with the checked-dynamic TypeError). */
function checkedDynPromise(
  lowerer: Lowerer,
  promise: IrExpr,
  declared: IrType & { kind: "promise" },
  node: ts.Node,
  loc: SrcLoc,
): IrExpr {
  const inner = declared.inner;
  if (
    !canDynCheckTo(
      inner,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    lowerer.noLowering(
      `a dns/promises result typed '${lowerer.fmt(declared)}'`,
      node,
      "the settled value must have a checked-dynamic conversion (type it as the documented LookupAddress shape or unknown)",
    );
  }
  const key = `dns.promise:${typeKey(declared)}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%dns.promise", key);
    lowerer.valueHelpers.set(key, helper);
    const promiseT: IrType = { kind: "promise", inner: DYN };
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "promise", name: "promise", type: promiseT }],
      returnType: inner,
      locals: [
        { id: "promise", name: "promise", type: promiseT, mutable: false },
        { id: "settled", name: "settled", type: DYN, mutable: false },
      ],
      body: [
        {
          kind: "varDecl",
          localId: "settled",
          init: {
            kind: "awaitExpr",
            value: { kind: "varRef", localId: "promise", type: promiseT, loc },
            type: DYN,
            loc,
          },
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "dynCheck",
            value: { kind: "varRef", localId: "settled", type: DYN, loc },
            type: inner,
            loc,
          },
          loc,
        },
      ],
      loc,
      async: true,
    });
  }
  return { kind: "call", callee: helper, args: [promise], type: declared, loc };
}

/** dns module calls: lookup(hostname[, options], callback) with Node's
 * option forms, lookupService(address, port, callback), getServers() and
 * get/setDefaultResultOrder(). The runtime validates the arguments as
 * lib/dns.js does; getaddrinfo runs at call time and the callback comes
 * with the other lookup deliveries (literal addresses on the next tick). */
function lowerDnsModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr {
  const args = expr.arguments.nodes;
  const dyn = (node: ts.Expression): IrExpr => {
    // `opts as dns.LookupOneOptions` over a checked-dynamic value (the
    // overload-satisfying cast of a pass-through lookup): the cast changes
    // no value, so the options reach the runtime as they are.
    let inner = node;
    while (ts.isAsExpression(inner) || ts.isParenthesizedExpression(inner))
      inner = inner.expression;
    if (inner !== node && lowerer.mapTypeOf(lowerer.typeOf(inner))?.kind === "dyn")
      return lowerer.lowerExpr(inner);
    return lowerer.coerceToExpected(lowerer.lowerExpr(node), DYN);
  };
  // A callback whose second parameter is typed (string, LookupAddress[])
  // cannot take the undefined Node passes after an error.
  const typedResult = (node: ts.Expression): IrExpr => {
    const sig = lowerer.checker.getCallSignatures(lowerer.typeOf(node))[0];
    const second = sig?.getParameters()[1];
    const t = second ? lowerer.mapTypeOf(lowerer.checker.getTypeOfSymbol(second)) : null;
    return boolLit(t !== null && t.kind !== "dyn", loc);
  };
  if (bi.member === "lookup") {
    requireStatementPosition(lowerer, expr, "dns.lookup(...)");
    if (args.length !== 2 && args.length !== 3) {
      lowerer.noLowering(
        `lookup with ${args.length} arguments`,
        expr,
        "the supported forms are lookup(hostname, callback) and lookup(hostname, options, callback)",
      );
    }
    const hostname = dyn(args[0]!);
    const options = args.length === 3 ? dyn(args[1]!) : dynUndefinedExpr(loc);
    const last = args[args.length - 1]!;
    // Options known only at run time (a checked-dynamic value, or one cast
    // to an overload's option type) decide between Node's two callback
    // shapes there: the address is a string, or an address list with
    // `all: true`. An inline callback then binds its parameters as
    // checked-dynamic values, whatever the overload the checker picked
    // says, and its body tests what actually arrived.
    let runtimeOptions = false;
    if (args.length === 3) {
      let inner: ts.Expression = args[1]!;
      while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner))
        inner = inner.expression;
      runtimeOptions = lowerer.mapTypeOf(lowerer.typeOf(inner))?.kind === "dyn";
    }
    let callbackNode: ts.Expression = last;
    while (ts.isParenthesizedExpression(callbackNode)) callbackNode = callbackNode.expression;
    const dynCallback =
      runtimeOptions && (ts.isArrowFunction(callbackNode) || ts.isFunctionExpression(callbackNode));
    const typed = dynCallback ? boolLit(false, loc) : typedResult(last);
    if (dynCallback) lowerer.dynParamLambdas.add(callbackNode);
    let cb: IrExpr;
    try {
      cb = lowerDnsCallback(lowerer, last, "lookup callbacks");
    } finally {
      if (dynCallback) lowerer.dynParamLambdas.delete(callbackNode);
    }
    return {
      kind: "libCall",
      fn: "dns.lookupDyn",
      args: [hostname, options, cb, typed],
      type: VOID,
      loc,
    };
  }
  if (bi.member === "lookupService") {
    requireStatementPosition(lowerer, expr, "dns.lookupService(...)");
    if (args.length !== 3) {
      lowerer.noLowering(
        `lookupService with ${args.length} arguments`,
        expr,
        "the form is lookupService(address, port, callback)",
      );
    }
    const typed = typedResult(args[2]!);
    const cb = lowerDnsCallback(lowerer, args[2]!, "lookupService callbacks");
    return {
      kind: "libCall",
      fn: "dns.lookupService",
      args: [dyn(args[0]!), dyn(args[1]!), cb, typed],
      type: VOID,
      loc,
    };
  }
  if (bi.member === "getServers" && args.length === 0) {
    const value: IrExpr = { kind: "libCall", fn: "dns.getServers", args: [], type: DYN, loc };
    const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
    return declared === null || declared.kind === "dyn"
      ? value
      : lowerer.coerceInto(expr, value, declared);
  }
  if (bi.member === "getDefaultResultOrder" && args.length === 0) {
    return { kind: "libCall", fn: "dns.getDefaultResultOrder", args: [], type: STRING, loc };
  }
  if (bi.member === "setDefaultResultOrder" && args.length === 1) {
    requireStatementPosition(lowerer, expr, "dns.setDefaultResultOrder(...)");
    return {
      kind: "libCall",
      fn: "dns.setDefaultResultOrder",
      args: [dyn(args[0]!)],
      type: VOID,
      loc,
    };
  }
  lowerer.noLowering(
    `dns.${bi.member}`,
    expr,
    "lookup, lookupService, getServers, getDefaultResultOrder, and setDefaultResultOrder are the lowered dns module functions",
    ts.isIdentifier(expr.expression) ? lowerer.resolveValueSymbol(expr.expression) : undefined,
  );
}

/** A listener JavaScript leaves untyped: a function literal with a
 * parameter that has neither an annotation nor JSDoc (paramShape makes it
 * checked-dynamic), or any other untyped value. */
function untypedJsListener(lowerer: Lowerer, node: ts.Expression): boolean {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e))
    return e.parameters.nodes.some((param) => !documentedParameter(param));
  return (lowerer.typeOf(e).flags & ts.TypeFlags.Any) !== 0;
}

/** Method calls on dgram.Socket receivers — one entry in lower-calls.ts's
 * intrinsic chain (after lowerServerMethodCall). Null for other
 * receivers. */
export function lowerDgramMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "dgramSocket") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if (name === "bind" || name === "connect") {
    requireStatementPosition(lowerer, call, `socket.${name}(...)`);
    // bind(port[, address][, cb]) / connect(port[, address][, cb]) — the
    // net.connect optional-middle rule: a 2-arg call's second argument is
    // the address when string-typed, the callback when func-typed.
    if (args.length < 1 || args.length > 3) {
      lowerer.noLowering(
        `${name} with ${args.length} arguments`,
        call,
        `the supported form is ${name}(port[, address][, callback])`,
      );
    }
    const port = lowerer.lowerExprExpecting(args[0]!, F64);
    let hostNode: ts.Expression | undefined;
    let cbNode: ts.Expression | undefined;
    if (args.length === 2) {
      if (lowerer.mapTypeOf(lowerer.typeOf(args[1]!))?.kind === "string") hostNode = args[1];
      else cbNode = args[1];
    } else if (args.length === 3) {
      hostNode = args[1];
      cbNode = args[2];
    }
    // Omitted-address completions: bind's is Node's 0.0.0.0 (the runtime
    // reads "" as any); connect's is 127.0.0.1, Node's udp4 default.
    const host: IrExpr = hostNode
      ? lowerer.lowerExprExpecting(hostNode, STRING)
      : { kind: "strLit", value: name === "bind" ? "" : "127.0.0.1", type: STRING, loc };
    const receiver = lowerer.lowerExpr(access.expression);
    if (!cbNode) {
      const fn: IrLibFn = name === "bind" ? "dgram.bind" : "dgram.connect";
      return { kind: "libCall", fn, args: [receiver, port, host], type: VOID, loc };
    }
    const { cb } = lowerCallbackArg(lowerer, cbNode, `${name} callbacks`, 0, () => false, "use ()");
    const fn: IrLibFn = name === "bind" ? "dgram.bindCb" : "dgram.connectCb";
    return { kind: "libCall", fn, args: [receiver, port, host, cb], type: VOID, loc };
  }
  if (name === "send") {
    requireStatementPosition(lowerer, call, "socket.send(...)");
    // send(msg, port, address) — one datagram to an explicit destination
    // (the static fast path). Every OTHER shape in a JS source rides the
    // checked-dynamic ladder (dgram.sendChk): Node's signature shuffle,
    // slice bounds, list/type contracts, port/address validation, the
    // connected-state errors, then the send itself — lists, connected
    // sends and completion callbacks included.
    const staticShape =
      args.length === 3 &&
      !args.some(ts.isSpreadElement) &&
      (() => {
        const dataT = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
        const portT = lowerer.mapTypeOf(lowerer.typeOf(args[1]!));
        const hostT = lowerer.mapTypeOf(lowerer.typeOf(args[2]!));
        return (
          (dataT?.kind === "string" || (dataT?.kind === "bytes" && dataT.elem === "u8")) &&
          portT?.kind === "f64" &&
          hostT?.kind === "string"
        );
      })();
    if (staticShape) {
      const receiver = lowerer.lowerExpr(access.expression);
      const data = lowerer.lowerExpr(args[0]!);
      const port = lowerer.lowerExprExpecting(args[1]!, F64);
      const host = lowerer.lowerExprExpecting(args[2]!, STRING);
      const fn: IrLibFn = data.type.kind === "string" ? "dgram.sendStr" : "dgram.sendBytes";
      return { kind: "libCall", fn, args: [receiver, data, port, host], type: VOID, loc };
    }
    // TypeScript reaches the ladder for the completion-callback form
    // send(msg, port, address, callback) (the hot-shots package shim).
    if (
      (isJsSourceFile(ts.getSourceFileOfNode(call)) || args.length === 4) &&
      args.length <= 6 &&
      !args.some(ts.isSpreadElement)
    ) {
      const receiver = lowerer.lowerExpr(access.expression);
      const slots: IrExpr[] = [];
      let ok = true;
      for (let i = 0; i < 6; i++) {
        const n = args[i];
        if (!n) {
          slots.push(dynUndefinedExpr(loc));
          continue;
        }
        const raw = lowerer.lowerExpr(n);
        if (raw.type.kind === "dyn") slots.push(raw);
        else if (
          raw.kind === "unitLit" ||
          lowerer.dynConvertible(raw.type) ||
          (raw.type.kind === "func" &&
            canBoxFuncIntoDyn(
              raw.type,
              (id) => lowerer.shapes.get(id),
              (id) => lowerer.unions.get(id),
            ))
        ) {
          slots.push({ kind: "dynFrom", value: raw, type: DYN, loc });
        } else {
          ok = false;
          break;
        }
      }
      if (ok) {
        return {
          kind: "libCall",
          fn: "dgram.sendChk",
          args: [receiver, ...slots],
          type: VOID,
          loc,
        };
      }
    }
    lowerer.noLowering(
      `send with ${args.length} arguments`,
      call,
      "the supported form is send(msg, port, address) — one string or Buffer datagram",
    );
  }
  if (name === "address") {
    if (args.length !== 0) {
      lowerer.noLowering(
        `address with ${args.length} arguments`,
        call,
        "address() takes no arguments",
      );
    }
    // The declared AddressInfo return must map to the {address, family,
    // port} record — the runtime fills exactly those three fields.
    const result = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (!result || !isRecordOfFields(lowerer, result, ADDRINFO_FIELDS)) {
      lowerer.noLowering(
        "address() where the result is not the {address, family, port} record",
        call,
        "the AddressInfo shape is the supported result",
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    return { kind: "libCall", fn: "dgram.address", args: [receiver], type: result, loc };
  }
  if (name === "close") {
    requireStatementPosition(lowerer, call, "socket.close(...)");
    if (args.length > 1) {
      lowerer.noLowering(
        `close with ${args.length} arguments`,
        call,
        "the supported form is close([callback])",
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    if (args.length === 0) {
      return { kind: "libCall", fn: "dgram.close", args: [receiver], type: VOID, loc };
    }
    const { cb } = lowerCallbackArg(lowerer, args[0]!, "close callbacks", 0, () => false, "use ()");
    return { kind: "libCall", fn: "dgram.closeCb", args: [receiver, cb], type: VOID, loc };
  }
  if (name === "unref" || name === "ref") {
    requireStatementPosition(lowerer, call, `socket.${name}()`);
    if (args.length !== 0) {
      lowerer.noLowering(
        `${name} with ${args.length} arguments`,
        call,
        `${name}() takes no arguments`,
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const fn: IrLibFn = name === "unref" ? "dgram.unref" : "dgram.ref";
    return { kind: "libCall", fn, args: [receiver], type: VOID, loc };
  }
  if ((name === "on" || name === "once") && args.length === 2) {
    requireStatementPosition(lowerer, call, `socket.${name}(...)`);
    // A JavaScript listener whose parameters are untyped registers through
    // the socket's checked-dynamic handle, which hands it untyped values.
    if (isJsSourceFile(ts.getSourceFileOfNode(call)) && untypedJsListener(lowerer, args[1]!)) {
      return {
        kind: "dynInvoke",
        recv: lowerer.coerceToExpected(lowerer.lowerExpr(access.expression), DYN),
        method: name,
        calleeName: ts.getTextOfNode(access),
        args: [
          lowerer.lowerExprExpecting(args[0]!, DYN),
          lowerer.lowerExprExpecting(args[1]!, DYN),
        ],
        type: DYN,
        loc,
      };
    }
    const once = boolLit(name === "once", loc);
    const evT = lowerer.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const receiver = lowerer.lowerExpr(access.expression);
    if (event === "message") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        "message listeners",
        2,
        (p, i) =>
          i === 0
            ? p.kind === "bytes" && p.elem === "u8"
            : isRecordOfFields(lowerer, p, RINFO_FIELDS),
        "use (msg: Buffer, rinfo) or (msg: Buffer) or ()",
      );
      return {
        kind: "libCall",
        fn: "dgram.onMessage",
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
      );
      return { kind: "libCall", fn: "dgram.onError", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "listening" || event === "close" || event === "connect") {
      const { cb } = lowerCallbackArg(
        lowerer,
        args[1]!,
        `${event} listeners`,
        0,
        () => false,
        "use ()",
      );
      const fn: IrLibFn =
        event === "listening"
          ? "dgram.onListening"
          : event === "close"
            ? "dgram.onClose"
            : "dgram.onConnect";
      return { kind: "libCall", fn, args: [receiver, cb, once], type: VOID, loc };
    }
    lowerer.noLowering(
      `socket.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
      args[0]!,
      '"message", "listening", "close", "connect", and "error" are the supported socket events (as literals)',
    );
  }
  const option = Object.hasOwn(DGRAM_OPTIONS, name) ? DGRAM_OPTIONS[name]! : null;
  if (option !== null) {
    const min = option.params.length - (option.optional ?? 0);
    const kinds = args.map((arg) =>
      ts.isSpreadElement(arg) ? undefined : lowerer.mapTypeOf(lowerer.typeOf(arg))?.kind,
    );
    if (
      args.length < min ||
      args.length > option.params.length ||
      kinds.some((kind, i) => kind !== DGRAM_OPTION_PARAMS[option.params[i]!].kind)
    ) {
      lowerer.noLowering(
        `socket.${name} with these arguments`,
        call,
        option.params.length === 0
          ? `${name}() takes no arguments`
          : `pass ${option.params.join(", ")} arguments, as the declaration types them`,
      );
    }
    if (option.value === undefined) requireStatementPosition(lowerer, call, `socket.${name}(...)`);
    const receiver = lowerer.lowerExpr(access.expression);
    const lowered: IrExpr[] = [receiver];
    option.params.forEach((param, i) => {
      lowered.push(
        args[i] !== undefined
          ? lowerer.lowerExprExpecting(args[i]!, DGRAM_OPTION_PARAMS[param])
          : { kind: "strLit", value: "", type: STRING, loc },
      );
    });
    // the membership calls pass whether the interface argument was given
    if (option.optional !== undefined)
      lowered.push(boolLit(args.length === option.params.length, loc));
    return { kind: "libCall", fn: option.fn, args: lowered, type: option.value ?? VOID, loc };
  }
  lowerer.noLowering(
    `dgram.Socket.${name}`,
    call,
    DGRAM_SURFACE_HINT,
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** True for a dns callback function util.promisify converts. */
export function isPromisifiedDnsMember(member: string): boolean {
  return member === "lookup" || member === "lookupService";
}

/** A call through `promisify(dns.lookup)` or `promisify(dns.lookupService)`:
 * the callback form runs with a callback that settles a promise of the
 * checked-dynamic `{ address, family }` (the address array with
 * options.all) or `{ hostname, service }`, which Node's custom promisified
 * forms produce. An argument error rejects the promise instead of
 * throwing. A declared result type other than `unknown` is reached through
 * an async helper that awaits that promise and checks the value. */
export function lowerPromisifiedDnsCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: string,
  loc: SrcLoc,
): IrExpr {
  const args = expr.arguments.nodes;
  if (args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`the promisified dns.${member} with spread arguments`, expr);
  }
  const service = member === "lookupService";
  if (service ? args.length !== 2 : args.length < 1 || args.length > 2) {
    lowerer.noLowering(
      `the promisified dns.${member} with ${args.length} arguments`,
      expr,
      service
        ? "the form is lookupService(address, port)"
        : "the supported forms are lookup(hostname) and lookup(hostname, options)",
    );
  }
  const dyn = (node: ts.Expression | undefined): IrExpr =>
    node ? lowerer.coerceToExpected(lowerer.lowerExpr(node), DYN) : dynUndefinedExpr(loc);
  const promiseDyn: IrType = { kind: "promise", inner: DYN };
  const call: IrExpr = {
    kind: "libCall",
    fn: service ? "dns.lookupServicePromise" : "dns.lookupPromise",
    args: [dyn(args[0]), dyn(args[1])],
    type: promiseDyn,
    loc,
  };
  const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (declared?.kind !== "promise") {
    lowerer.noLowering(`the promisified dns.${member} with this result type`, expr);
  }
  const value = declared.inner;
  if (value.kind === "dyn") return call;
  if (
    !canDynCheckTo(
      value,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    lowerer.noLowering(
      `the promisified dns.${member} with a '${lowerer.fmt(declared)}' result`,
      expr,
      "the result type must have a checked conversion from the lookup's value",
    );
  }
  const key = `dnsPromise:${JSON.stringify(value)}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%dnsPromise", key);
    lowerer.valueHelpers.set(key, name);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "p.0", name: "p", type: promiseDyn }],
      returnType: value,
      async: true,
      locals: [{ id: "p.0", name: "p", type: promiseDyn, mutable: false }],
      body: [
        {
          kind: "return",
          value: {
            kind: "dynCheck",
            value: {
              kind: "awaitExpr",
              value: { kind: "varRef", localId: "p.0", type: promiseDyn, loc },
              type: DYN,
              loc,
            },
            type: value,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [call], type: declared, loc };
}
