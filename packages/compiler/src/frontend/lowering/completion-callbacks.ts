/* Completion callbacks in programs that use AsyncLocalStorage. Node runs
 * the callback of an operation a callback-style API starts (fs.readFile,
 * crypto.randomBytes, zlib.gzip, dns.lookup, server.listen, net.connect,
 * http.get, stream.finished, stream.pipeline, ...) with the stores active
 * when the call started it. The runtime invokes these callbacks from
 * the event loop, where the context is empty, so in programs whose
 * scheduling carries contexts (RuntimeFeatures asyncContext) each such
 * argument is bound to the active context at the call: als.bindCallback
 * for typed closures, als.bindCallbackDyn for dyn functions. Other
 * programs are left unchanged. */
import { BOOL, type IrExpr, type IrModule, type IrStmt } from "../../ir/ir.js";
import type { IrLibFn } from "../../ir/builtin-signatures.js";
import { mapExprChildren, mapStmtChildren } from "../../ir/traverse.js";
import { moduleUsesAsyncContext } from "../../ir/runtime-features.js";

/** The argument that is the completion callback: its index; "last" for
 * calls whose callback is the final argument when one is passed; or
 * "arguments" for the fs callback calls, whose argument is the call's
 * dyn argument vector, where the runtime finds the callback. */
type CallbackPosition = number | "last" | "arguments";

const COMPLETION_CALLBACKS: ReadonlyMap<IrLibFn, CallbackPosition> = new Map<
  IrLibFn,
  CallbackPosition
>([
  ["cp.execFile", 2],
  ["crypto.generateKeyCb", 2],
  ["crypto.hkdfCb", 5],
  ["crypto.pbkdf2Cb", 5],
  ["crypto.randomBytesCb", 1],
  ["crypto.randomFillCb", 4],
  ["crypto.randomFillCbDyn", 4],
  ["crypto.randomIntCb", 3],
  ["crypto.scryptCb", 4],
  ["dgram.bindCb", 3],
  ["dgram.closeCb", 1],
  ["dgram.connectCb", 3],
  ["dns.lookupDyn", 2],
  ["fs.callbackCall", "arguments"],
  ["fs.callbackGlob", "arguments"],
  ["fs.renameCb", 2],
  ["http.requestAgentCb", "last"],
  ["http.requestCb", "last"],
  ["http.requestConnCb", "last"],
  ["http.requestDynCb", "last"],
  ["http.requestUrlCb", "last"],
  ["net.connectCb", 2],
  ["net.connectPathCb", 2],
  ["net.listenCb", 2],
  ["net.listenOptsCb", 4],
  ["net.listenOptsReusePortCb", 5],
  ["net.listenPathCb", 2],
  ["process.stderrWriteBytesCb", 2],
  ["process.stdoutWriteBytesCb", 2],
  // stream.finished and stream.pipeline callbacks, which Node binds to
  // the context of the call (eos' and pipeline's AsyncResource.bind).
  ["stream.finished", 1],
  ["stream.finishedDyn", 1],
  ["stream.finishedOpts", "last"],
  ["stream.finishedOptsSignal", "last"],
  ["stream.pipeline", "last"],
  ["stream.pipelineDyn", "last"],
  ["stream.pipelineStages", "last"],
  ["stream.pipelineStagesDyn", "last"],
  ["zlib.cbOpts", 3],
  ["zlib.cbOptsDyn", 3],
  ["zlib.deflateCb", 1],
  ["zlib.deflateRawCb", 1],
  ["zlib.gunzipCb", 1],
  ["zlib.gzipCb", 1],
  ["zlib.inflateCb", 1],
  ["zlib.inflateRawCb", 1],
  ["zlib.unzipCb", 1],
]);

/** Completion callbacks that fire from other contexts' code (a stream event
 * that another context's call emits), so an empty context at the call
 * binds too: the callback then runs with no store, as in Node. */
const BIND_EMPTY_CONTEXT: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  "stream.finished",
  "stream.finishedDyn",
  "stream.finishedOpts",
  "stream.finishedOptsSignal",
  "stream.pipeline",
  "stream.pipelineDyn",
  "stream.pipelineStages",
  "stream.pipelineStagesDyn",
]);

/** `cb` bound to the context active where it is evaluated. Unless
 * `bindEmpty`, an empty context leaves it unbound (`always` false): the
 * loop already runs those callbacks with an empty context. */
function bindToActiveContext(cb: IrExpr, bindEmpty = false): IrExpr {
  const always: IrExpr = { kind: "boolLit", value: bindEmpty, type: BOOL, loc: cb.loc };
  if (cb.type.kind === "func")
    return {
      kind: "libCall",
      fn: "als.bindCallback",
      args: [cb, always],
      type: cb.type,
      loc: cb.loc,
    };
  if (cb.type.kind === "dyn")
    return {
      kind: "libCall",
      fn: "als.bindCallbackDyn",
      args: [cb, always],
      type: cb.type,
      loc: cb.loc,
    };
  return cb;
}

/** An element of a dyn argument vector that can be the callback: a boxed
 * closure binds as a typed closure; any other dyn value that is not a
 * boxed primitive binds as a dyn function (non-functions pass through). */
function bindArgumentElement(e: IrExpr): IrExpr {
  if (e.kind === "dynFrom") {
    return e.value.type.kind === "func" ? { ...e, value: bindToActiveContext(e.value) } : e;
  }
  return e.type.kind === "dyn" ? bindToActiveContext(e) : e;
}

function bindCall(e: IrExpr): IrExpr {
  if (e.kind !== "libCall") return e;
  const position = COMPLETION_CALLBACKS.get(e.fn);
  if (position === undefined) return e;
  if (position === "arguments") {
    const index = e.fn === "fs.callbackCall" ? 1 : 0;
    const vector = e.args[index];
    if (vector === undefined || vector.kind !== "dynArrLit") return e;
    const args = e.args.slice();
    args[index] = {
      kind: "dynArrLit",
      elems: vector.elems.map(bindArgumentElement),
      type: vector.type,
      loc: vector.loc,
    };
    return { ...e, args };
  }
  const index = position === "last" ? e.args.length - 1 : position;
  const cb = e.args[index];
  if (cb === undefined || (position === "last" && cb.type.kind !== "func")) return e;
  const args = e.args.slice();
  args[index] = bindToActiveContext(cb, BIND_EMPTY_CONTEXT.has(e.fn));
  return { ...e, args };
}

/** Binds the completion callbacks of `mod` when its scheduling carries
 * AsyncLocalStorage contexts. */
export function bindCompletionCallbacks(mod: IrModule): void {
  if (!moduleUsesAsyncContext(mod)) return;
  const rewriteExpr = (e: IrExpr): IrExpr => bindCall(mapExprChildren(e, rewriteExpr, rewriteStmt));
  const rewriteStmt = (s: IrStmt): IrStmt => mapStmtChildren(s, rewriteExpr, rewriteStmt);
  for (const fn of mod.functions) fn.body = fn.body.map(rewriteStmt);
}
