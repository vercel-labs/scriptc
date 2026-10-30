import { isBuiltinClassInstance } from "./receiver-types.js";
import { dynUndefinedExpr } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  STRING,
  type SrcLoc,
  VOID,
  canBoxFuncIntoDyn,
  canConvertToDyn,
} from "../../../ir/ir.js";

/** The channel-name argument of the diagnostics_channel surface: a
 * string (dyn names ride the validated extraction — Node's non-string
 * names would throw ERR_INVALID_ARG_TYPE where the dynCheck throws its
 * annotated TypeError; symbol names have no lowering and fence through
 * the coercion's own rejection). */
export function diagnosticsChannelNameArgument(lowerer: Lowerer, node: ts.Expression): IrExpr {
  return lowerer.lowerExprExpecting(node, STRING);
}

/** A diagnostics_channel subscriber as a dyn value: dyn callables pass
 * through (test/common's mustCall wrapper — an untyped JS function
 * value), boxable typed closures ride dynFrom. Identity is preserved
 * either way, so unsubscribe(fn) finds the subscribe(fn) entry. */
export function lowerDiagnosticsSubscriber(lowerer: Lowerer, node: ts.Expression): IrExpr {
  // The stdlib GLOBAL setImmediate as a function value (the Node-suite
  // traceCallback shape): a minted native dyn callable — the identifier
  // has no other first-class story.
  if (ts.isIdentifier(node) && node.text === "setImmediate") {
    const sym = lowerer.checker.getSymbolAtLocation(node);
    const decls = sym ? sym.declarations : [];
    if (decls.length > 0 && decls.every((d) => lowerer.isStdlibFile(ts.getSourceFileOfNode(d)))) {
      return {
        kind: "libCall",
        fn: "timers.setImmediateFnValue",
        args: [],
        type: DYN,
        loc: locOf(node),
      };
    }
  }
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
  lowerer.unsupported(
    "SC1090",
    node,
    `channel subscribers of type '${lowerer.fmt(cb.type)}' (subscribers cross as dyn functions — parameters must be dyn-representable)`,
  );
}

/** A published message as a dyn value: dyn passes through, everything
 * in the dynFrom domain (JSON-safe data, bytes, %Error, boxable
 * functions, handle kinds) boxes; the rest fences with the domain named. */
function lowerDiagnosticsMessage(lowerer: Lowerer, node: ts.Expression): IrExpr {
  // An explicit `undefined` argument (tracePromise(fn, ctx, undefined,
  // ...args) — Node's own no-this spelling) is the undefined dyn value,
  // exactly what an omitted slot defaults to.
  if (ts.isIdentifier(node) && node.text === "undefined") {
    return dynUndefinedExpr(locOf(node));
  }
  const msg = lowerer.lowerExpr(node);
  if (msg.type.kind === "dyn") return msg;
  if (
    canConvertToDyn(
      msg.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    return { kind: "dynFrom", value: msg, type: DYN, loc: locOf(node) };
  }
  lowerer.unsupported(
    "SC1090",
    node,
    `publishing '${lowerer.fmt(msg.type)}' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions)`,
  );
}

/** Method calls on diagnostics_channel Channel receivers:
 * publish(message), subscribe(fn), unsubscribe(fn) — over the f64
 * channel handle. The rest of the declared surface (bindStore,
 * runStores) fences member-qualified. Null for non-Channel receivers. */
export function lowerDiagnosticsChannelMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!isBuiltinClassInstance(lowerer, access.expression, "Channel")) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (name === "publish" && call.arguments.nodes.length === 1) {
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    const msg = lowerDiagnosticsMessage(lowerer, call.arguments.nodes[0]!);
    return { kind: "libCall", fn: "dc.publish", args: [receiver, msg], type: VOID, loc };
  }
  if ((name === "subscribe" || name === "unsubscribe") && call.arguments.nodes.length === 1) {
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    const cb = lowerDiagnosticsSubscriber(lowerer, call.arguments.nodes[0]!);
    return name === "subscribe"
      ? { kind: "libCall", fn: "dc.chanSubscribe", args: [receiver, cb], type: VOID, loc }
      : { kind: "libCall", fn: "dc.chanUnsubscribe", args: [receiver, cb], type: BOOL, loc };
  }
  // bindStore(store[, transform]) / unbindStore(store) / runStores(data,
  // fn[, thisArg[, ...args]]): the AsyncLocalStorage integration — the
  // store argument is the ALS f64 handle; the transform crosses as a
  // dyn function (absent = identity, the undefined dyn value); runStores
  // enters the bound stores, publishes inside them, and forwards
  // this/arguments to fn exactly like the trace calls.
  if (
    (name === "bindStore" || name === "unbindStore") &&
    call.arguments.nodes.length >= 1 &&
    call.arguments.nodes.length <= (name === "bindStore" ? 2 : 1)
  ) {
    if (!isBuiltinClassInstance(lowerer, call.arguments.nodes[0]!, "AsyncLocalStorage")) {
      lowerer.noLowering(
        `Channel.${name} with this store argument`,
        call.arguments.nodes[0]!,
        "an AsyncLocalStorage instance (node:async_hooks) is the supported store",
      );
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    const store = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, F64);
    if (name === "unbindStore") {
      return {
        kind: "libCall",
        fn: "dc.chanUnbindStore",
        args: [receiver, store],
        type: BOOL,
        loc,
      };
    }
    const transform: IrExpr =
      call.arguments.nodes[1] !== undefined
        ? lowerDiagnosticsSubscriber(lowerer, call.arguments.nodes[1]!)
        : dynUndefinedExpr(loc);
    return {
      kind: "libCall",
      fn: "dc.chanBindStore",
      args: [receiver, store, transform],
      type: VOID,
      loc,
    };
  }
  if (name === "runStores" && call.arguments.nodes.length >= 2) {
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    const data = lowerDiagnosticsMessage(lowerer, call.arguments.nodes[0]!);
    const fn = lowerDiagnosticsSubscriber(lowerer, call.arguments.nodes[1]!);
    const thisArg: IrExpr =
      call.arguments.nodes[2] !== undefined
        ? lowerDiagnosticsMessage(lowerer, call.arguments.nodes[2]!)
        : dynUndefinedExpr(loc);
    const rest = lowerTracingArguments(lowerer, call.arguments.nodes.slice(3), loc);
    return {
      kind: "libCall",
      fn: "dc.chanRunStores",
      args: [receiver, data, fn, thisArg, rest],
      type: DYN,
      loc,
    };
  }
  lowerer.noLowering(
    `Channel.${name}`,
    call,
    "publish(message), subscribe(fn), unsubscribe(fn), bindStore/unbindStore/runStores, and the name/hasSubscribers reads are the supported Channel members",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** Whether `node` names the AsyncLocalStorage class itself. */
function isAsyncLocalStorageClass(lowerer: Lowerer, node: ts.Expression): boolean {
  if (!ts.isIdentifier(node)) return false;
  const symbol = lowerer.resolveValueSymbol(node);
  return (
    symbol !== null &&
    lowerer.isStdlibSymbol(symbol) &&
    ts.symbolName(symbol) === "AsyncLocalStorage"
  );
}

/** The static AsyncLocalStorage members: bind(fn) answers fn bound to the
 * active context (its own type for a typed function; a dyn function in
 * JavaScript files, where the bound function's name and receiver are
 * observable, and for dyn values); snapshot() answers a dyn function
 * (cb, ...args) that runs cb in the context active at the snapshot. */
function lowerAsyncLocalStorageStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr {
  const name = access.name.text;
  const loc = locOf(call);
  const always: IrExpr = { kind: "boolLit", value: true, type: BOOL, loc };
  if (name === "bind" && call.arguments.nodes.length === 1) {
    const arg = call.arguments.nodes[0]!;
    if (!isJsSourceFile(ts.getSourceFileOfNode(call))) {
      const fn = lowerer.lowerExpr(arg);
      if (fn.type.kind === "func")
        return { kind: "libCall", fn: "als.bindCallback", args: [fn, always], type: fn.type, loc };
    }
    return asyncLocalStorageResult(lowerer, call, {
      kind: "libCall",
      fn: "als.bindCallbackDyn",
      args: [lowerDiagnosticsMessage(lowerer, arg), always],
      type: DYN,
      loc,
    });
  }
  if (name === "snapshot" && call.arguments.nodes.length === 0)
    return { kind: "libCall", fn: "als.snapshot", args: [], type: DYN, loc };
  lowerer.noLowering(
    `AsyncLocalStorage.${name}`,
    call,
    "AsyncLocalStorage.bind(fn) and AsyncLocalStorage.snapshot() are the supported static members",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** new AsyncLocalStorage(options): the options object as a dyn value
 * (plain property literals build it member by member). */
export function lowerAsyncLocalStorageOptions(lowerer: Lowerer, node: ts.Expression): IrExpr {
  return lowerTracingHandlers(lowerer, node);
}

/** `.name` on AsyncLocalStorage receivers: the constructor's name option
 * (als.name), converted to the property's type. Null otherwise. */
export function lowerAsyncLocalStorageProperty(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.questionDotToken || access.name.text !== "name") return null;
  if (!isBuiltinClassInstance(lowerer, access.expression, "AsyncLocalStorage")) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const loc = locOf(access);
  const receiver = lowerer.lowerExprExpecting(access.expression, F64);
  const value: IrExpr = { kind: "libCall", fn: "als.name", args: [receiver], type: DYN, loc };
  const expected = lowerer.mapTypeOf(lowerer.typeOf(access));
  return !expected || expected.kind === "dyn" ? value : lowerer.coerceInto(access, value, expected);
}

/** Method calls on AsyncLocalStorage receivers: run(store, fn, ...args),
 * exit(fn, ...args), getStore(), enterWith(store), disable() — over the
 * f64 store handle (als.* libCalls; values cross as dyn values) — and the
 * static bind/snapshot members. Null for other receivers. */
export function lowerAsyncLocalStorageMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (isAsyncLocalStorageClass(lowerer, access.expression))
    return lowerAsyncLocalStorageStaticCall(lowerer, call, access);
  if (!isBuiltinClassInstance(lowerer, access.expression, "AsyncLocalStorage")) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (name === "getStore" && call.arguments.nodes.length === 0) {
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    return asyncLocalStorageResult(lowerer, call, {
      kind: "libCall",
      fn: "als.get",
      args: [receiver],
      type: DYN,
      loc,
    });
  }
  if (name === "run" && call.arguments.nodes.length >= 2) {
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    const value = lowerDiagnosticsMessage(lowerer, call.arguments.nodes[0]!);
    const fn = lowerDiagnosticsSubscriber(lowerer, call.arguments.nodes[1]!);
    const rest = lowerTracingArguments(lowerer, call.arguments.nodes.slice(2), loc);
    return asyncLocalStorageResult(lowerer, call, {
      kind: "libCall",
      fn: "als.run",
      args: [receiver, value, fn, rest],
      type: DYN,
      loc,
    });
  }
  if (name === "exit" && call.arguments.nodes.length >= 1) {
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    const fn = lowerDiagnosticsSubscriber(lowerer, call.arguments.nodes[0]!);
    const rest = lowerTracingArguments(lowerer, call.arguments.nodes.slice(1), loc);
    return asyncLocalStorageResult(lowerer, call, {
      kind: "libCall",
      fn: "als.exitRun",
      args: [receiver, fn, rest],
      type: DYN,
      loc,
    });
  }
  if (name === "enterWith" && call.arguments.nodes.length === 1) {
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    const value = lowerDiagnosticsMessage(lowerer, call.arguments.nodes[0]!);
    return { kind: "libCall", fn: "als.enterWith", args: [receiver, value], type: VOID, loc };
  }
  if (name === "disable" && call.arguments.nodes.length === 0) {
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    return { kind: "libCall", fn: "als.disable", args: [receiver], type: VOID, loc };
  }
  lowerer.noLowering(
    `AsyncLocalStorage.${name}`,
    call,
    "run(store, fn, ...args), exit(fn, ...args), getStore(), enterWith(store), and disable() are the supported AsyncLocalStorage members",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** The runtime carries a tagged value, while a typed ALS call promises
 * its generic store/callback result. Convert at that boundary so inferred
 * locals and immediate method calls share the same checked representation.
 * Untyped JS and unknown stores keep the original dynamic value. */
function asyncLocalStorageResult(lowerer: Lowerer, call: ts.CallExpression, value: IrExpr): IrExpr {
  const expected = lowerer.mapTypeOf(lowerer.typeOf(call));
  // Promises already use the runtime's dynamic async path; unlike class
  // capsules, boxed typed promises do not have a checked extraction ABI.
  if (
    !expected ||
    expected.kind === "dyn" ||
    expected.kind === "void" ||
    expected.kind === "promise"
  )
    return value;
  return lowerer.coerceInto(call, value, expected);
}

/** Property reads on Channel receivers: `.name` (the registration
 * string) and `.hasSubscribers` (the publish guard). Null for
 * non-Channel receivers and other members (the method fence owns them). */
export function lowerDiagnosticsChannelProperty(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.questionDotToken) return null;
  const name = access.name.text;
  if (name !== "name" && name !== "hasSubscribers") return null;
  if (!isBuiltinClassInstance(lowerer, access.expression, "Channel")) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const loc = locOf(access);
  const receiver = lowerer.lowerExprExpecting(access.expression, F64);
  return name === "name"
    ? { kind: "libCall", fn: "dc.chanName", args: [receiver], type: STRING, loc }
    : { kind: "libCall", fn: "dc.chanHasSubscribers", args: [receiver], type: BOOL, loc };
}

export const DC_TRACE_EVENTS = ["start", "end", "asyncStart", "asyncEnd", "error"] as const;

/** A TracingChannel handlers object as a dyn value: dyn passes through;
 * an INLINE object literal of plain event-name properties builds the checked-dynamic tree
 * object member-by-member (each value through the message conversion —
 * closures box by identity, so unsubscribe still matches), covering the
 * `{ start: () => {} }` spelling whose record type (function members)
 * has no whole-value conversion. Everything else rides lowerDiagnosticsMessage. */
function lowerTracingHandlers(lowerer: Lowerer, node: ts.Expression): IrExpr {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (
    ts.isObjectLiteralExpression(e) &&
    lowerer.mapTypeOf(lowerer.typeOf(e))?.kind === "record" &&
    e.properties.nodes.length > 0 &&
    e.properties.nodes.every((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name))
  ) {
    const loc = locOf(e);
    return {
      kind: "dynObjLit",
      fields: e.properties.nodes.map((p) => {
        const pa = p as ts.PropertyAssignment;
        return {
          key: {
            kind: "strLit",
            value: (pa.name as ts.Identifier).text,
            type: STRING,
            loc: locOf(pa),
          },
          value: lowerDiagnosticsMessage(lowerer, pa.initializer),
        };
      }),
      type: DYN,
      loc,
    };
  }
  return lowerDiagnosticsMessage(lowerer, node);
}

/** A trace-call argument list's tail as ONE dyn array (dynArrLit over
 * per-element conversions). Spread arguments fence — the built array
 * must mirror the call site's argument vector exactly. */
export function lowerTracingArguments(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  loc: SrcLoc,
): IrExpr {
  const elems = args.map((a) => {
    if (ts.isSpreadElement(a)) {
      lowerer.noLowering(
        "trace calls with spread arguments",
        a,
        "write the traced arguments positionally",
      );
    }
    return lowerDiagnosticsMessage(lowerer, a);
  });
  return { kind: "dynArrLit", elems, type: DYN, loc };
}

/** Method calls on TracingChannel receivers: subscribe/unsubscribe over
 * a dyn handlers object, traceSync/traceCallback through the runtime's
 * publish choreography (dc.tcTraceSync/dc.tcTraceCallback — fn, context,
 * thisArg, and the argument vector all cross as dyn values; context
 * defaults to a fresh `{}` and thisArg to undefined, Node's defaults),
 * and tracePromise through the reaction-fiber choreography
 * (dc.tcTracePromise — the result is the reaction promise, typed
 * promise<dyn> so .then/.catch chains ride the promise lowerings).
 * Null for non-TracingChannel receivers. */
export function lowerTracingChannelMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!isBuiltinClassInstance(lowerer, access.expression, "TracingChannel")) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if ((name === "subscribe" || name === "unsubscribe") && call.arguments.nodes.length === 1) {
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    const handlers = lowerTracingHandlers(lowerer, call.arguments.nodes[0]!);
    return name === "subscribe"
      ? { kind: "libCall", fn: "dc.tcSubscribe", args: [receiver, handlers], type: VOID, loc }
      : { kind: "libCall", fn: "dc.tcUnsubscribe", args: [receiver, handlers], type: BOOL, loc };
  }
  if (
    (name === "traceSync" || name === "traceCallback" || name === "tracePromise") &&
    call.arguments.nodes.length >= 1
  ) {
    const receiver = lowerer.lowerExprExpecting(access.expression, F64);
    const fn = lowerDiagnosticsSubscriber(lowerer, call.arguments.nodes[0]!);
    // traceSync(fn, context?, thisArg?, ...args) /
    // tracePromise(fn, context?, thisArg?, ...args) /
    // traceCallback(fn, position?, context?, thisArg?, ...args)
    const shift = name === "traceCallback" ? 1 : 0;
    const ctxNode = call.arguments.nodes[1 + shift];
    const thisNode = call.arguments.nodes[2 + shift];
    const ctx: IrExpr =
      ctxNode !== undefined
        ? lowerDiagnosticsMessage(lowerer, ctxNode)
        : { kind: "dynObjLit", fields: [], type: DYN, loc };
    const thisArg: IrExpr =
      thisNode !== undefined ? lowerDiagnosticsMessage(lowerer, thisNode) : dynUndefinedExpr(loc);
    const rest = lowerTracingArguments(lowerer, call.arguments.nodes.slice(3 + shift), loc);
    if (name === "traceSync") {
      return {
        kind: "libCall",
        fn: "dc.tcTraceSync",
        args: [receiver, fn, ctx, thisArg, rest],
        type: DYN,
        loc,
      };
    }
    if (name === "tracePromise") {
      // The runtime returns the REACTION promise (dyn payload), so the
      // call site's .then/.catch chains ride the promise<dyn> lowerings.
      // A non-promise traced return wraps (PromiseResolve, Node) — on
      // the no-subscriber early exit too, where Node returns it raw
      // (SEMANTICS.md).
      return {
        kind: "libCall",
        fn: "dc.tcTracePromise",
        args: [receiver, fn, ctx, thisArg, rest],
        type: { kind: "promise", inner: DYN },
        loc,
      };
    }
    const pos: IrExpr =
      call.arguments.nodes[1] !== undefined
        ? lowerer.lowerExprExpecting(call.arguments.nodes[1]!, F64)
        : { kind: "numLit", value: -1, type: F64, loc };
    return {
      kind: "libCall",
      fn: "dc.tcTraceCallback",
      args: [receiver, fn, pos, ctx, thisArg, rest],
      type: DYN,
      loc,
    };
  }
  lowerer.noLowering(
    `TracingChannel.${name}`,
    call,
    "subscribe(handlers), unsubscribe(handlers), traceSync(fn, ...), traceCallback(fn, ...), tracePromise(fn, ...), and the per-event channel/hasSubscribers reads are the supported TracingChannel members",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** Property reads on TracingChannel receivers: the five event channels
 * (`.start` … `.error` — Channel-typed f64 handles the Channel lowerings
 * take over) and `.hasSubscribers` (the five-channel disjunction). Null
 * for other members and non-TracingChannel receivers. */
export function lowerTracingChannelProperty(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.questionDotToken) return null;
  const name = access.name.text;
  const idx = (DC_TRACE_EVENTS as readonly string[]).indexOf(name);
  if (idx < 0 && name !== "hasSubscribers") return null;
  if (!isBuiltinClassInstance(lowerer, access.expression, "TracingChannel")) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const loc = locOf(access);
  const receiver = lowerer.lowerExprExpecting(access.expression, F64);
  return idx >= 0
    ? {
        kind: "libCall",
        fn: "dc.tcChannel",
        args: [receiver, { kind: "numLit", value: idx, type: F64, loc }],
        type: F64,
        loc,
      }
    : { kind: "libCall", fn: "dc.tcHasSubscribers", args: [receiver], type: BOOL, loc };
}

// node:diagnostics_channel — the module-level pub/sub surface. The
// subscriber arguments box into the checked-dynamic tree (dyn) so JS harness wrappers
// (test/common's mustCall — a rest-args function value) and typed
// closures both cross; publish and the Channel methods lower in
// lowerDiagnosticsChannelMethodCall over the f64 channel handle.
export function lowerDiagnosticsChannelCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.member === "channel" && expr.arguments.nodes.length === 1) {
    const name = diagnosticsChannelNameArgument(lowerer, expr.arguments.nodes[0]!);
    return { kind: "libCall", fn: "dc.channel", args: [name], type: F64, loc };
  }
  if (
    (bi.member === "subscribe" || bi.member === "unsubscribe") &&
    expr.arguments.nodes.length === 2
  ) {
    const name = diagnosticsChannelNameArgument(lowerer, expr.arguments.nodes[0]!);
    const cb = lowerDiagnosticsSubscriber(lowerer, expr.arguments.nodes[1]!);
    return bi.member === "subscribe"
      ? { kind: "libCall", fn: "dc.subscribe", args: [name, cb], type: VOID, loc }
      : { kind: "libCall", fn: "dc.unsubscribe", args: [name, cb], type: BOOL, loc };
  }
  if (bi.member === "hasSubscribers" && expr.arguments.nodes.length === 1) {
    const name = diagnosticsChannelNameArgument(lowerer, expr.arguments.nodes[0]!);
    return { kind: "libCall", fn: "dc.hasSubscribers", args: [name], type: BOOL, loc };
  }
  // tracingChannel: the string form interns the five tracing:<name>:*
  // channels; the collection form takes an object literal whose five
  // event members are Channel-typed values (Node's TracingChannelCollection).
  if (bi.member === "tracingChannel" && expr.arguments.nodes.length === 1) {
    const a = expr.arguments.nodes[0]!;
    if (ts.isObjectLiteralExpression(a)) {
      const byEvent = new Map<string, IrExpr>();
      for (const p of a.properties.nodes) {
        if (
          !ts.isPropertyAssignment(p) ||
          !ts.isIdentifier(p.name) ||
          !(DC_TRACE_EVENTS as readonly string[]).includes(p.name.text)
        ) {
          lowerer.noLowering(
            "tracingChannel with this collection shape",
            p,
            "the supported collection form assigns each of start/end/asyncStart/asyncEnd/error a Channel value inline",
          );
        }
        byEvent.set(p.name.text, lowerer.lowerExprExpecting(p.initializer, F64));
      }
      if (byEvent.size !== 5) {
        lowerer.noLowering(
          "tracingChannel with a partial collection",
          a,
          "the supported collection form names all five event channels",
        );
      }
      return {
        kind: "libCall",
        fn: "dc.tracingChannelOf",
        args: DC_TRACE_EVENTS.map((ev) => byEvent.get(ev)!),
        type: F64,
        loc,
      };
    }
    const name = diagnosticsChannelNameArgument(lowerer, a);
    return { kind: "libCall", fn: "dc.tracingChannel", args: [name], type: F64, loc };
  }

  return null;
}
