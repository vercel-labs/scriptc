import { keyedHelperName } from "../stable-names.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { boolLit, numLit, varRef } from "../../../ir/build.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrLibFn,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  VOID,
  funcOf,
  typeKey,
} from "../../../ir/ir.js";
import { PERF_ENTRY_FIELDS, PERF_ENTRY_MARKER, perfEntryJsonShape } from "../../type-mapper.js";
import {
  PERF_NODE_TIMING_JSON_FIELDS,
  PERF_NODE_TIMING_MARKER,
  eventLoopUtilizationShape,
  perfNodeTimingJsonShape,
  perfNodeTimingShape,
  uvMetricsShape,
} from "../../type-mapper.js";
import { builtinImportOf } from "./module-bindings.js";
import { lowerOptionalArgument } from "../optional-arguments.js";
import { checkedIterableSpread } from "../checked-iterable-spread.js";

/** True for any spelling of node:perf_hooks' `performance` object — the
 * named import binding, a namespace/default-import member, the require
 * twins (all through the shared builtin tables), or the GLOBAL Node
 * exposes without any import (the module export and the global are one
 * value; provenance-checked like console/process, so the bare
 * identifier and the globalThis.performance member both land here and
 * a user's own `performance` binding never does). */
function isPerfHooksPerformanceExpr(lowerer: Lowerer, node: ts.Expression): boolean {
  if (lowerer.isStdlibGlobal(node, "performance")) return true;
  if (ts.isIdentifier(node)) {
    const bi = builtinImportOf(lowerer, node);
    return bi !== null && bi.module === "perf_hooks" && bi.member === "performance";
  }
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
    const bi = lowerer.builtinMemberOf(node);
    return bi !== null && bi.module === "perf_hooks" && bi.member === "performance";
  }
  return false;
}

/** The user-timing members of the performance object: the runtime entry
 * point and, for the getters, the getEntries selector. */
const PERF_TIMELINE_CALLS: ReadonlyMap<string, { fn: IrLibFn; which?: number }> = new Map([
  ["mark", { fn: "perf.mark" }],
  ["measure", { fn: "perf.measure" }],
  ["getEntries", { fn: "perf.entries", which: 0 }],
  ["getEntriesByName", { fn: "perf.entries", which: 1 }],
  ["getEntriesByType", { fn: "perf.entries", which: 2 }],
  ["clearMarks", { fn: "perf.clearMarks" }],
  ["clearMeasures", { fn: "perf.clearMeasures" }],
]);

/** Presence probes do not extract an unbound Performance method value. A
 * perf_hooks entry or observer class does have a value: `typeof` answers
 * "function" for the module import, a namespace member and Node 24's global
 * of that name, without reading it. */
export function lowerPerfHooksTypeof(lowerer: Lowerer, expression: ts.Expression): IrExpr | null {
  if (perfClassOf(lowerer, expression) !== null)
    return { kind: "strLit", value: "function", type: STRING, loc: locOf(expression) };
  const value = isPerfHooksPerformanceExpr(lowerer, expression)
    ? "object"
    : ts.isPropertyAccessExpression(expression) &&
        !expression.questionDotToken &&
        (expression.name.text === "now" || PERF_TIMELINE_CALLS.has(expression.name.text)) &&
        isPerfHooksPerformanceExpr(lowerer, expression.expression)
      ? "function"
      : null;
  return value === null ? null : { kind: "strLit", value, type: STRING, loc: locOf(expression) };
}

/** The node:perf_hooks spoke: `performance.now()` reads the runtime's
 * monotonic clock anchored at process start — Node's timeOrigin for a
 * compiled program, fractional milliseconds — and
 * `performance.now.bind(performance)` (the mockable-clock idiom's
 * getTimestamp) is the same clock as a plain () => number function
 * value. mark/measure, the getEntries family and the clears run over the
 * runtime's performance timeline (lowerPerfTimelineCall), and an entry's
 * toJSON() answers its plain object. Other members on the performance
 * object fence by name; null for non-perf_hooks callees (the call chain
 * keeps trying). */
export function lowerPerfHooksCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.questionDotToken) return null;
  const loc = locOf(expr);
  if (access.name.text === "now" && isPerfHooksPerformanceExpr(lowerer, access.expression)) {
    if (expr.arguments.nodes.length !== 0) {
      lowerer.noLowering(
        "performance.now with arguments",
        expr,
        "Node's performance.now takes none",
      );
    }
    return { kind: "libCall", fn: "perf.now", args: [], type: F64, loc };
  }
  if (
    access.name.text === "bind" &&
    ts.isPropertyAccessExpression(access.expression) &&
    !access.expression.questionDotToken &&
    access.expression.name.text === "now" &&
    isPerfHooksPerformanceExpr(lowerer, access.expression.expression)
  ) {
    if (
      expr.arguments.nodes.length !== 1 ||
      !isPerfHooksPerformanceExpr(lowerer, expr.arguments.nodes[0]!)
    ) {
      lowerer.noLowering(
        "this performance.now.bind form",
        expr,
        "performance.now.bind(performance) is the lowered function-value spelling",
      );
    }
    return {
      kind: "closure",
      fnName: perfNowFnValueOf(lowerer),
      captures: [],
      type: funcOf([], F64),
      loc,
    };
  }
  if (
    access.name.text === "toJSON" &&
    isPerfEntryType(lowerer, lowerer.mapTypeOf(lowerer.typeOf(access.expression)))
  ) {
    if (expr.arguments.nodes.length !== 0) {
      lowerer.noLowering("PerformanceEntry toJSON with arguments", expr);
    }
    const entry = lowerer.lowerExpr(access.expression);
    if (entry.type.kind !== "record")
      lowerer.badType(access.expression, lowerer.typeOf(access.expression));
    return {
      kind: "dynFrom",
      value: perfEntryJson(lowerer, entry, entry.type, loc),
      type: DYN,
      loc,
    };
  }
  if (
    access.name.text === "toJSON" &&
    isPerfNodeTimingType(lowerer, lowerer.mapTypeOf(lowerer.typeOf(access.expression)))
  ) {
    if (expr.arguments.nodes.length !== 0) {
      lowerer.noLowering("PerformanceNodeTiming toJSON with arguments", expr);
    }
    const timing = lowerer.lowerExpr(access.expression);
    if (timing.type.kind !== "record")
      lowerer.badType(access.expression, lowerer.typeOf(access.expression));
    return {
      kind: "dynFrom",
      value: perfNodeTimingJson(lowerer, timing, timing.type, loc),
      type: DYN,
      loc,
    };
  }
  if (access.name.text === "toJSON" && isPerfHooksPerformanceExpr(lowerer, access.expression)) {
    if (expr.arguments.nodes.length !== 0) {
      lowerer.noLowering("performance.toJSON with arguments", expr);
    }
    return { kind: "dynFrom", value: performanceJsonValue(lowerer, loc), type: DYN, loc };
  }
  if (
    access.name.text === "eventLoopUtilization" &&
    isPerfHooksPerformanceExpr(lowerer, access.expression)
  ) {
    return lowerEventLoopUtilization(lowerer, expr);
  }
  const handleCall = lowerPerfHandleMethodCall(lowerer, expr, access, loc);
  if (handleCall !== null) return handleCall;
  const timeline = PERF_TIMELINE_CALLS.get(access.name.text);
  if (timeline && isPerfHooksPerformanceExpr(lowerer, access.expression)) {
    return lowerPerfTimelineCall(lowerer, expr, access.name.text, timeline, loc);
  }
  if (isPerfHooksPerformanceExpr(lowerer, access.expression)) {
    lowerer.noLowering(
      `perf_hooks performance.${access.name.text}`,
      expr,
      "performance.now() (and its .bind(performance) function value), nodeTiming, timeOrigin, toJSON, mark, measure, the getEntries family, clearMarks, clearMeasures and eventLoopUtilization are the lowered surface",
    );
  }
  return null;
}

/** The memoized () => number lifted wrapper behind
 * performance.now.bind(performance): a plain function value over the
 * same perf.now libCall. */
function perfNowFnValueOf(lowerer: Lowerer): string {
  const name = "%perf.now.value";
  if (lowerer.liftedFnNamed(name) === undefined) {
    const loc: SrcLoc = { file: "<builtin>", start: 0, end: 0 };
    lowerer.liftedFns.push({
      name,
      params: [],
      returnType: F64,
      locals: [],
      body: [
        {
          kind: "return",
          value: { kind: "libCall", fn: "perf.now", args: [], type: F64, loc },
          loc,
        },
      ],
      loc,
    });
  }
  return name;
}

/** True when `t` is the PerformanceEntry record (type-mapper's
 * perfEntryShape). */
export function isPerfEntryType(lowerer: Lowerer, t: IrType | null | undefined): boolean {
  if (t?.kind !== "record") return false;
  return lowerer.shapes.get(t.shapeId)?.fields.some((f) => f.name === PERF_ENTRY_MARKER) === true;
}

/** An entry's toJSON() object: { name, entryType, startTime, duration,
 * detail } read off the entry record. */
export function perfEntryJson(
  lowerer: Lowerer,
  entry: IrExpr,
  entryT: IrType & { kind: "record" },
  loc: SrcLoc,
): IrExpr {
  const shape = lowerer.shapes.get(entryT.shapeId)!;
  const read = (name: string): IrExpr => ({
    kind: "recordGet",
    obj: entry,
    shapeId: entryT.shapeId,
    field: name,
    type: shape.fields.find((f) => f.name === name)!.type,
    loc,
  });
  return {
    kind: "recordLit",
    fields: [...PERF_ENTRY_FIELDS].sort().map((name) => ({ name, value: read(name) })),
    type: { kind: "record", shapeId: perfEntryJsonShape(lowerer.shapes) },
    loc,
  };
}

/** True when `t` is performance.nodeTiming's record (type-mapper's
 * perfNodeTimingShape). */
export function isPerfNodeTimingType(lowerer: Lowerer, t: IrType | null | undefined): boolean {
  if (t?.kind !== "record") return false;
  return (
    lowerer.shapes.get(t.shapeId)?.fields.some((f) => f.name === PERF_NODE_TIMING_MARKER) === true
  );
}

/** performance.nodeTiming.toJSON()'s object: the milestones read off the
 * record, in toJSON's order (uvMetricsInfo is not in it). */
export function perfNodeTimingJson(
  lowerer: Lowerer,
  timing: IrExpr,
  timingT: IrType & { kind: "record" },
  loc: SrcLoc,
): IrExpr {
  const shape = lowerer.shapes.get(timingT.shapeId)!;
  const read = (name: string): IrExpr => ({
    kind: "recordGet",
    obj: timing,
    shapeId: timingT.shapeId,
    field: name,
    type: shape.fields.find((f) => f.name === name)!.type,
    loc,
  });
  return {
    kind: "recordLit",
    fields: [...PERF_NODE_TIMING_JSON_FIELDS].sort().map((name) => ({ name, value: read(name) })),
    type: { kind: "record", shapeId: perfNodeTimingJsonShape(lowerer.shapes) },
    loc,
  };
}

/** performance.nodeTiming itself: the milestones as one record of Node's
 * own properties. Node keeps them as prototype getters over the process's
 * timing, so the record is built at the read (a fresh snapshot; only the
 * two loop milestones and the metrics move after startup, and the startup
 * milestones of a compiled program are 0). */
export function perfNodeTimingValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const shapeId = perfNodeTimingShape(lowerer.shapes, lowerer.unions);
  const marker = lowerer.shapes
    .get(shapeId)!
    .fields.find((f) => f.name === PERF_NODE_TIMING_MARKER)!;
  const lib = (fn: IrLibFn): IrExpr => ({ kind: "libCall", fn, args: [], type: F64, loc });
  // Node answers -1 before the loop starts and the loop's start time after.
  const loopStart = lowerer.declareHiddenLocal("%perfNodeLoopStart", F64);
  const loopStartRef = (): IrExpr => varRef(loopStart.id, F64, loc);
  const values: Record<string, IrExpr> = {
    [PERF_NODE_TIMING_MARKER]: lowerer.absentFieldValue(marker, loc)!,
    bootstrapComplete: numLit(0, loc),
    duration: lib("perf.now"),
    entryType: { kind: "strLit", value: "node", type: STRING, loc },
    environment: numLit(0, loc),
    idleTime: lib("perf.idleTime"),
    loopExit: lib("perf.loopExit"),
    loopStart: {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: loopStart.id, init: lib("perf.loopStart"), loc }],
      result: {
        kind: "ternary",
        cond: {
          kind: "bin",
          op: ">",
          left: loopStartRef(),
          right: numLit(0, loc),
          type: BOOL,
          loc,
        },
        then: loopStartRef(),
        else_: numLit(-1, loc),
        type: F64,
        loc,
      },
      type: F64,
      loc,
    },
    name: { kind: "strLit", value: "node", type: STRING, loc },
    nodeStart: numLit(0, loc),
    startTime: numLit(0, loc),
    uvMetricsInfo: {
      kind: "recordLit",
      fields: [
        { name: "events", value: numLit(0, loc) },
        { name: "eventsWaiting", value: numLit(0, loc) },
        { name: "loopCount", value: lib("perf.loopCount") },
      ],
      type: { kind: "record", shapeId: uvMetricsShape(lowerer.shapes) },
      loc,
    },
    v8Start: numLit(0, loc),
  };
  return {
    kind: "recordLit",
    fields: Object.keys(values)
      .sort()
      .map((name) => ({ name, value: values[name]! })),
    type: { kind: "record", shapeId },
    loc,
  };
}

/** performance.toJSON(): { nodeTiming, timeOrigin, eventLoopUtilization }
 * in Node's key order. The checker declares the method's result `any`, so
 * the record is handed over as a checked-dynamic object. */
function performanceJsonValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const eluT: IrType = { kind: "record", shapeId: eventLoopUtilizationShape(lowerer.shapes) };
  const nodeTimingT: IrType = {
    kind: "record",
    shapeId: perfNodeTimingShape(lowerer.shapes, lowerer.unions),
  };
  const shapeId = lowerer.shapes.intern(
    [
      { name: "eventLoopUtilization", type: eluT },
      { name: "nodeTiming", type: nodeTimingT },
      { name: "timeOrigin", type: F64 },
    ],
    false,
    undefined,
    ["nodeTiming", "timeOrigin", "eventLoopUtilization"],
  );
  return {
    kind: "recordLit",
    fields: [
      {
        name: "eventLoopUtilization",
        value: { kind: "call", callee: eluHelperOf(lowerer, 0, eluT), args: [], type: eluT, loc },
      },
      { name: "nodeTiming", value: perfNodeTimingValue(lowerer, loc) },
      { name: "timeOrigin", value: performanceTimeOrigin(lowerer, loc) },
    ],
    type: { kind: "record", shapeId },
    loc,
  };
}

/** One timeline entry of the runtime's last answer, as the entry record. */
function perfEntryRecord(
  lowerer: Lowerer,
  t: IrType & { kind: "record" },
  index: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const marker = lowerer.shapes.get(t.shapeId)!.fields.find((f) => f.name === PERF_ENTRY_MARKER)!;
  const read = (fn: IrLibFn, type: IrType): IrExpr => ({
    kind: "libCall",
    fn,
    args: [index],
    type,
    loc,
  });
  const values: Record<string, IrExpr> = {
    [PERF_ENTRY_MARKER]: lowerer.absentFieldValue(marker, loc)!,
    detail: read("perf.entryDetail", DYN),
    duration: read("perf.entryDuration", F64),
    entryType: read("perf.entryType", STRING),
    name: read("perf.entryName", STRING),
    startTime: read("perf.entryStart", F64),
  };
  return {
    kind: "recordLit",
    fields: Object.keys(values)
      .sort()
      .map((name) => ({ name, value: values[name]! })),
    type: t,
    loc,
  };
}

/** The call's arguments as one dyn array, in source order. Spread
 * arguments expand with JavaScript's iterable semantics (strings into
 * characters, Sets, generators and other iterators through the iterator
 * protocol), and a non-iterable spread throws V8's TypeError, so the
 * runtime always receives an array. */
function lowerPerfArguments(
  lowerer: Lowerer,
  call: ts.CallExpression | ts.NewExpression,
  loc: SrcLoc,
): IrExpr {
  const nodes = call.arguments?.nodes ?? [];
  if (!nodes.some(ts.isSpreadElement)) {
    return {
      kind: "dynArrLit",
      elems: nodes.map((a) => lowerer.lowerExprExpecting(a, DYN)),
      type: DYN,
      loc,
    };
  }
  const pack = lowerer.declareHiddenLocal("%perfArgs", DYN);
  const ref = (): IrExpr => ({ kind: "varRef", localId: pack.id, type: DYN, loc });
  const stmts: IrStmt[] = [
    {
      kind: "varDecl",
      localId: pack.id,
      init: { kind: "dynArrLit", elems: [], type: DYN, loc },
      loc,
    },
  ];
  for (const arg of nodes) {
    if (!ts.isSpreadElement(arg)) {
      const value = lowerer.lowerExprExpecting(arg, DYN);
      stmts.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.packPush",
          args: [ref(), value],
          type: VOID,
          loc: value.loc,
        },
        loc: value.loc,
      });
      continue;
    }
    const spelling = ts.getTextOfNode(arg.expression);
    const items = checkedIterableSpread(lowerer, lowerer.lowerExpr(arg.expression), spelling, loc);
    stmts.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.packPushSpread",
        args: [ref(), items, { kind: "strLit", value: spelling, type: STRING, loc }],
        type: VOID,
        loc,
      },
      loc,
    });
  }
  return { kind: "seqExpr", stmts, result: ref(), type: DYN, loc };
}

/** performance.mark/measure, getEntries/getEntriesByName/getEntriesByType
 * and clearMarks/clearMeasures. The arguments cross as one dyn vector so
 * the runtime applies Node's validation in Node's order; the producing
 * calls go through a lifted helper per result type that runs the call and
 * builds the entry record(s) from the runtime's answer. */
function lowerPerfTimelineCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: string,
  timeline: { fn: IrLibFn; which?: number },
  loc: SrcLoc,
): IrExpr {
  const args = lowerPerfArguments(lowerer, call, loc);
  if (timeline.fn === "perf.clearMarks" || timeline.fn === "perf.clearMeasures") {
    return { kind: "libCall", fn: timeline.fn, args: [args], type: VOID, loc };
  }
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  const many = timeline.which !== undefined;
  const entryT = many ? (result?.kind === "array" ? result.elem : undefined) : result;
  if (!isPerfEntryType(lowerer, entryT) || entryT?.kind !== "record" || result == null) {
    lowerer.noLowering(
      `performance.${member} where the result is not a PerformanceEntry${many ? " array" : ""}`,
      call,
    );
  }
  if (!many) {
    return perfEntryProduceCall(lowerer, timeline.fn, `%perf.${member}`, args, entryT, true, loc);
  }
  const argsRef = varRef("a.0", DYN, loc);
  const whichRef = varRef("w.0", F64, loc);
  return perfEntryArrayCall(
    lowerer,
    `perf.entries:${typeKey(result)}`,
    "%perf.entries",
    [
      { localId: "a.0", name: "a", type: DYN },
      { localId: "w.0", name: "w", type: F64 },
    ],
    [args, numLit(timeline.which!, loc)],
    { kind: "libCall", fn: "perf.entries", args: [argsRef, whichRef], type: F64, loc },
    result,
    entryT,
    loc,
  );
}

/** The lifted helper behind a call that produces one entry: it runs `fn`
 * over the argument vector and builds the new entry's record from the
 * runtime's answer at index 0. `keep` hands the record back to the
 * runtime, so the timeline answers later through `perf.entryRef` with this
 * same object (performance.mark/measure); a mark built by the
 * PerformanceMark constructor is not in the timeline and keeps nothing. */
function perfEntryProduceCall(
  lowerer: Lowerer,
  fn: IrLibFn,
  helperDisplay: string,
  args: IrExpr,
  result: IrType & { kind: "record" },
  keep: boolean,
  loc: SrcLoc,
): IrExpr {
  const key = `${fn}:${typeKey(result)}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, helperDisplay, key);
    lowerer.valueHelpers.set(key, helper);
    const argsRef = varRef("a.0", DYN, loc);
    const entry = varRef("e.0", result, loc);
    const body: IrStmt[] = [
      {
        kind: "exprStmt",
        expr: { kind: "libCall", fn, args: [argsRef], type: F64, loc },
        loc,
      },
      {
        kind: "varDecl",
        localId: "e.0",
        init: perfEntryRecord(lowerer, result, numLit(0, loc), loc),
        loc,
      },
    ];
    if (keep) {
      body.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "perf.entryKeep",
          args: [{ kind: "dynFrom", value: entry, liveRef: true, type: DYN, loc }],
          type: VOID,
          loc,
        },
        loc,
      });
    }
    body.push({ kind: "return", value: entry, loc });
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "a.0", name: "a", type: DYN }],
      returnType: result,
      locals: [
        { id: "a.0", name: "a", type: DYN, mutable: false },
        { id: "e.0", name: "e", type: result, mutable: false },
      ],
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [args], type: result, loc };
}

/** The lifted helper behind a call that answers entry records: it runs
 * `count` (a libCall over the helper's own params leaving the count) and
 * builds each entry from the runtime's answer through `perf.entryRef`, the
 * record the producing call kept. */
function perfEntryArrayCall(
  lowerer: Lowerer,
  key: string,
  helperDisplay: string,
  params: { localId: string; name: string; type: IrType }[],
  callArgs: IrExpr[],
  count: IrExpr,
  result: IrType,
  entryT: IrType & { kind: "record" },
  loc: SrcLoc,
): IrExpr {
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, helperDisplay, key);
    lowerer.valueHelpers.set(key, helper);
    const index = varRef("i.0", F64, loc);
    const countRef = varRef("n.0", F64, loc);
    const out = varRef("out.0", result, loc);
    lowerer.liftedFns.push({
      name: helper,
      params: params.map((p) => ({ localId: p.localId, name: p.name, type: p.type })),
      returnType: result,
      locals: [
        ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "out.0", name: "out", type: result, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
      ],
      body: [
        { kind: "varDecl", localId: "n.0", init: count, loc },
        {
          kind: "varDecl",
          localId: "out.0",
          init: { kind: "arrayLit", elems: [], type: result, loc },
          loc,
        },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
          cond: { kind: "bin", op: "<", left: index, right: countRef, type: BOOL, loc },
          update: {
            kind: "assign",
            localId: "i.0",
            value: { kind: "bin", op: "+", left: index, right: numLit(1, loc), type: F64, loc },
            loc,
          },
          body: [
            {
              kind: "exprStmt",
              expr: {
                kind: "arrIntrinsic",
                method: "push",
                receiver: out,
                args: [
                  {
                    kind: "dynCheck",
                    value: { kind: "libCall", fn: "perf.entryRef", args: [index], type: DYN, loc },
                    preserveRefs: true,
                    type: entryT,
                    loc,
                  },
                ],
                type: F64,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: out, loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: callArgs, type: result, loc };
}

/* ── the perf_hooks classes ───────────────────────────────────────────
 * PerformanceObserver and PerformanceObserverEntryList are native
 * checked-dynamic handles (scr_perf.c); PerformanceEntry, PerformanceMark
 * and PerformanceMeasure map to the entry record. Construction, the
 * methods and instanceof cannot be answered by the value itself, so they
 * lower here. */

type PerfClass =
  | "PerformanceEntry"
  | "PerformanceMark"
  | "PerformanceMeasure"
  | "PerformanceObserver"
  | "PerformanceObserverEntryList";

const PERF_CLASSES: ReadonlySet<string> = new Set<PerfClass>([
  "PerformanceEntry",
  "PerformanceMark",
  "PerformanceMeasure",
  "PerformanceObserver",
  "PerformanceObserverEntryList",
]);

/** The perf_hooks class `node` names: a named import or require binding, a
 * namespace or default-import member, or Node 24's global of that name
 * (the module export and the global are the same class). */
export function perfClassOf(lowerer: Lowerer, node: ts.Expression): PerfClass | null {
  if (ts.isIdentifier(node)) {
    const builtin = builtinImportOf(lowerer, node);
    if (builtin?.module === "perf_hooks" && PERF_CLASSES.has(builtin.member))
      return builtin.member as PerfClass;
    if (PERF_CLASSES.has(node.text) && lowerer.isStdlibGlobal(node, node.text))
      return node.text as PerfClass;
    return null;
  }
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
    const builtin = lowerer.builtinMemberOf(node);
    if (builtin?.module === "perf_hooks" && PERF_CLASSES.has(builtin.member))
      return builtin.member as PerfClass;
  }
  return null;
}

/** The perf_hooks class a stdlib-typed value (an instance) belongs to. */
function perfValueClassOf(lowerer: Lowerer, node: ts.Expression): PerfClass | null {
  const type = lowerer.typeOf(node);
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (symbol === undefined) return null;
  const name = ts.symbolName(symbol);
  if (!PERF_CLASSES.has(name) || !lowerer.isStdlibSymbol(symbol)) return null;
  return name as PerfClass;
}

/** `new PerformanceObserver(callback)`, `new PerformanceMark(name,
 * options?)` and the three classes Node keeps unconstructible
 * (ERR_ILLEGAL_CONSTRUCTOR: PerformanceEntry, PerformanceMeasure and
 * PerformanceObserverEntryList). The argument vector evaluates first, as
 * a JavaScript call's arguments do; the runtime applies Node's validation
 * in Node's order. */
export function lowerPerfNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const cls = perfClassOf(lowerer, expr.expression);
  if (cls === null) return null;
  const loc = locOf(expr);
  const args = lowerPerfArguments(lowerer, expr, loc);
  if (cls === "PerformanceObserver") {
    return { kind: "libCall", fn: "perf.observerNew", args: [args], type: DYN, loc };
  }
  if (cls === "PerformanceMark") {
    const result = lowerer.mapTypeOf(lowerer.typeOf(expr)) ?? DYN;
    if (result.kind !== "record" || !isPerfEntryType(lowerer, result)) {
      lowerer.noLowering("new PerformanceMark where the result is not a PerformanceMark", expr);
    }
    // The constructor's mark is not in the performance timeline, so the
    // record is not handed back to the runtime (no entryKeep).
    return perfEntryProduceCall(lowerer, "perf.markNew", "%perf.markNew", args, result, false, loc);
  }
  // The unconstructible classes throw before the constructor returns, so the
  // expression never produces a value: it answers the checked-dynamic type
  // rather than the class type the checker reports. The class type is not
  // the same under both TypeScript 7 frontends for a JavaScript source, and
  // the unreachable continuation would otherwise materialize it (a typed
  // reference the program can never reach, and IR that the two checkers do
  // not agree on).
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: args, loc }],
    result: {
      kind: "libCall",
      fn: "error.nodeThrow",
      args: [
        numLit(1, loc),
        { kind: "strLit", value: "ERR_ILLEGAL_CONSTRUCTOR", type: STRING, loc },
        { kind: "strLit", value: "Illegal constructor", type: STRING, loc },
      ],
      type: DYN,
      loc,
    },
    type: DYN,
    loc,
  };
}

/** The PerformanceObserver methods (observe, disconnect, takeRecords) and
 * the PerformanceObserverEntryList selectors (getEntries,
 * getEntriesByName, getEntriesByType) over a stdlib-typed receiver. The
 * observer methods run Node's validation in the runtime; the selectors
 * answer entry records built from the runtime's answer. */
function lowerPerfHandleMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  loc: SrcLoc,
): IrExpr | null {
  const recvClass = perfValueClassOf(lowerer, access.expression);
  if (recvClass === null) return null;
  const name = access.name.text;
  const receiver = (): IrExpr => lowerer.lowerExprExpecting(access.expression, DYN);
  if (recvClass === "PerformanceObserver") {
    if (name === "observe") {
      return {
        kind: "libCall",
        fn: "perf.observerObserve",
        args: [receiver(), lowerPerfArguments(lowerer, call, loc)],
        type: VOID,
        loc,
      };
    }
    if (name === "disconnect") {
      return {
        kind: "libCall",
        fn: "perf.observerDisconnect",
        args: [receiver()],
        type: VOID,
        loc,
      };
    }
    if (name === "takeRecords") {
      const result = lowerer.mapTypeOf(lowerer.typeOf(call));
      const entryT = result?.kind === "array" ? result.elem : undefined;
      if (result == null || !isPerfEntryType(lowerer, entryT) || entryT?.kind !== "record") {
        lowerer.noLowering(
          "observer.takeRecords() where the result is not a PerformanceEntry array",
          call,
        );
      }
      return perfEntryArrayCall(
        lowerer,
        `perf.take:${typeKey(result)}`,
        "%perf.take",
        [{ localId: "o.0", name: "o", type: DYN }],
        [receiver()],
        {
          kind: "libCall",
          fn: "perf.observerTake",
          args: [varRef("o.0", DYN, loc)],
          type: F64,
          loc,
        },
        result,
        entryT,
        loc,
      );
    }
    lowerer.noLowering(
      `PerformanceObserver.${name}`,
      call,
      "observe, disconnect and takeRecords are the lowered surface",
    );
  }
  // Only the entry list has the getEntries family; the entry classes' own
  // members (toJSON, toString, the inherited record reads) lower elsewhere.
  if (recvClass !== "PerformanceObserverEntryList") return null;
  const which =
    name === "getEntries"
      ? 0
      : name === "getEntriesByName"
        ? 1
        : name === "getEntriesByType"
          ? 2
          : -1;
  if (which < 0) {
    lowerer.noLowering(
      `PerformanceObserverEntryList.${name}`,
      call,
      "getEntries, getEntriesByName and getEntriesByType are the lowered surface",
    );
  }
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  const entryT = result?.kind === "array" ? result.elem : undefined;
  if (result == null || !isPerfEntryType(lowerer, entryT) || entryT?.kind !== "record") {
    lowerer.noLowering(
      `PerformanceObserverEntryList.${name} where the result is not a PerformanceEntry array`,
      call,
    );
  }
  return perfEntryArrayCall(
    lowerer,
    `perf.list:${typeKey(result)}:${which}`,
    "%perf.list",
    [
      { localId: "l.0", name: "l", type: DYN },
      { localId: "a.0", name: "a", type: DYN },
    ],
    [receiver(), lowerPerfArguments(lowerer, call, loc)],
    {
      kind: "libCall",
      fn: "perf.listEntries",
      args: [varRef("l.0", DYN, loc), varRef("a.0", DYN, loc), numLit(which, loc)],
      type: F64,
      loc,
    },
    result,
    entryT,
    loc,
  );
}

/** `v instanceof PerformanceObserver` / `instanceof
 * PerformanceObserverEntryList` ask the handle tag, and the entry classes
 * ask the entry's entryType (a statically entry-typed value is one of the
 * two records Node's entry classes have). */
export function lowerPerfInstanceof(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  const cls = perfClassOf(lowerer, expr.right);
  if (cls === null) return null;
  const loc = locOf(expr);
  if (cls === "PerformanceObserver" || cls === "PerformanceObserverEntryList") {
    const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
    return {
      kind: "libCall",
      fn: "perf.observerIs",
      args: [value, numLit(cls === "PerformanceObserver" ? 0 : 1, loc)],
      type: BOOL,
      loc,
    };
  }
  // The lowered operand's own type decides: a value that IS an entry record
  // reads its entryType (a union or checked-dynamic one takes the runtime's
  // entry brand, which a dyn conversion of the record carries).
  const operand = lowerer.lowerExpr(expr.left);
  if (operand.type.kind === "record" && isPerfEntryType(lowerer, operand.type)) {
    // An entry record is always a PerformanceEntry, but the operand still
    // evaluates: its side effects and exceptions happen before the answer,
    // as any instanceof operand's do.
    if (cls === "PerformanceEntry")
      return {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: operand, loc }],
        result: boolLit(true, loc),
        type: BOOL,
        loc,
      };
    return {
      kind: "strEq",
      negated: false,
      left: {
        kind: "recordGet",
        obj: operand,
        shapeId: operand.type.shapeId,
        field: "entryType",
        type: STRING,
        loc,
      },
      right: {
        kind: "strLit",
        value: cls === "PerformanceMark" ? "mark" : "measure",
        type: STRING,
        loc,
      },
      type: BOOL,
      loc,
    };
  }
  // A value whose type is not statically an entry (any, or a union with
  // one): the operand is still evaluated, and the runtime's entry brand
  // answers.
  const value = lowerer.coerceInto(expr.left, operand, DYN);
  return {
    kind: "libCall",
    fn: "perf.entryIs",
    args: [value, numLit(cls === "PerformanceEntry" ? 0 : cls === "PerformanceMark" ? 1 : 2, loc)],
    type: BOOL,
    loc,
  };
}

/** `String(entry)` / `${entry}` / entry.toString(): Object.prototype
 * .toString's tag, "[object PerformanceMark]" or "[object
 * PerformanceMeasure]" (an interned helper, so the entry evaluates once). */
export function perfEntryTag(
  lowerer: Lowerer,
  entry: IrExpr,
  entryT: IrType & { kind: "record" },
  loc: SrcLoc,
): IrExpr {
  const key = `perf.tag:${entryT.shapeId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%perf.tag", key);
    lowerer.valueHelpers.set(key, helper);
    const e = varRef("e.0", entryT, loc);
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "e.0", name: "e", type: entryT }],
      returnType: STRING,
      locals: [{ id: "e.0", name: "e", type: entryT, mutable: false }],
      body: [
        {
          kind: "return",
          value: {
            kind: "ternary",
            cond: {
              kind: "strEq",
              negated: false,
              left: {
                kind: "recordGet",
                obj: e,
                shapeId: entryT.shapeId,
                field: "entryType",
                type: STRING,
                loc,
              },
              right: { kind: "strLit", value: "mark", type: STRING, loc },
              type: BOOL,
              loc,
            },
            then: { kind: "strLit", value: "[object PerformanceMark]", type: STRING, loc },
            else_: { kind: "strLit", value: "[object PerformanceMeasure]", type: STRING, loc },
            type: STRING,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [entry], type: STRING, loc };
}

/** Node keeps an entry's fields as prototype getters over internal
 * slots, so own-key walks (Object.keys/values/entries, for-in, spread,
 * hasOwnProperty) see none of them. Those walks over an entry record
 * fence instead of listing the fields. */
export function fencePerfEntryKeyWalk(
  lowerer: Lowerer,
  t: IrType | null | undefined,
  node: ts.Node,
  what: string,
): void {
  if (!isPerfEntryType(lowerer, t)) return;
  lowerer.unsupported(
    "SC1090",
    node,
    `${what} over performance entries (Node keeps their fields as prototype getters, so own-key walks see none; read the fields or call toJSON())`,
  );
}

/* ── the performance object's own properties ────────────────────────── */

/** A property READ on the perf_hooks `performance` object or a class of
 * the module that no call lowering claims: nodeTiming, timeOrigin and
 * PerformanceObserver.supportedEntryTypes. Null for every other read. */
export function lowerPerfHooksProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken) return null;
  const loc = locOf(expr);
  const name = expr.name.text;
  if (isPerfHooksPerformanceExpr(lowerer, expr.expression)) {
    if (name === "nodeTiming") return perfNodeTimingValue(lowerer, loc);
    if (name === "timeOrigin") return performanceTimeOrigin(lowerer, loc);
    return null;
  }
  if (
    name === "supportedEntryTypes" &&
    perfClassOf(lowerer, expr.expression) === "PerformanceObserver"
  ) {
    return supportedEntryTypesValue(lowerer, loc);
  }
  return null;
}

/** perf_hooks.eventLoopUtilization(u1?, u2?): the module's free function,
 * the same function as performance.eventLoopUtilization. */
export function lowerEventLoopUtilizationCall(lowerer: Lowerer, expr: ts.CallExpression): IrExpr {
  return lowerEventLoopUtilization(lowerer, expr);
}

/** `performance.timeOrigin`: the Unix time, in fractional milliseconds, at
 * which `performance.now()` read zero. The runtime's clock is anchored at
 * process start, so the origin is the wall clock minus that clock, taken
 * once and kept: every read answers the same number, and
 * `timeOrigin + now()` is the wall clock, as in Node. */
export function performanceTimeOrigin(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const helper = "%perf.timeOrigin";
  if (lowerer.liftedFnNamed(helper) === undefined) {
    const storage = `%g.${helper}`;
    const ready = `${storage}%ready`;
    lowerer.globalsList.push(
      { id: storage, name: "performance.timeOrigin", type: F64, mutable: true },
      { id: ready, name: "%ready", type: BOOL, mutable: true },
    );
    const body: IrStmt[] = [
      {
        kind: "if",
        cond: varRef(ready, BOOL, loc),
        then: [{ kind: "return", value: varRef(storage, F64, loc), loc }],
        else_: null,
        loc,
      },
      {
        kind: "assign",
        localId: storage,
        value: {
          kind: "bin",
          op: "-",
          left: { kind: "libCall", fn: "date.now", args: [], type: F64, loc },
          right: { kind: "libCall", fn: "perf.now", args: [], type: F64, loc },
          type: F64,
          loc,
        },
        loc,
      },
      { kind: "assign", localId: ready, value: boolLit(true, loc), loc },
      { kind: "return", value: varRef(storage, F64, loc), loc },
    ];
    lowerer.liftedFns.push({ name: helper, params: [], locals: [], returnType: F64, body, loc });
    lowerer.shareHelper(helper);
  }
  lowerer.noteEdge(helper);
  return { kind: "call", callee: helper, args: [], type: F64, loc };
}

/** The entry types this process reports, in Node's order. */
const SUPPORTED_ENTRY_TYPES = [
  "dns",
  "function",
  "gc",
  "http",
  "http2",
  "mark",
  "measure",
  "net",
  "quic",
  "resource",
];

/** PerformanceObserver.supportedEntryTypes: Node's fixed list, one frozen
 * array that every read answers (as in Node, `a === b` and
 * `Object.isFrozen(a)` hold). The array is native, and a checked-dynamic
 * read of it observes the same frozen array, so the identity survives the
 * conversion too. */
function supportedEntryTypesValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const helper = "%perf.supportedEntryTypes";
  const type: IrType = { kind: "array", elem: STRING };
  if (lowerer.liftedFnNamed(helper) === undefined) {
    const storage = `%g.${helper}`;
    const ready = `${storage}%ready`;
    lowerer.globalsList.push(
      { id: storage, name: "PerformanceObserver.supportedEntryTypes", type, mutable: true },
      { id: ready, name: "%ready", type: BOOL, mutable: true },
    );
    const storageRef = (): IrExpr => varRef(storage, type, loc);
    const body: IrStmt[] = [
      {
        kind: "if",
        cond: varRef(ready, BOOL, loc),
        then: [{ kind: "return", value: storageRef(), loc }],
        else_: null,
        loc,
      },
      {
        kind: "assign",
        localId: storage,
        value: {
          kind: "arrayLit",
          elems: SUPPORTED_ENTRY_TYPES.map((value) => ({
            kind: "strLit" as const,
            value,
            type: STRING,
            loc,
          })),
          type,
          loc,
        },
        loc,
      },
      {
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "array.freeze", args: [storageRef()], type: VOID, loc },
        loc,
      },
      { kind: "assign", localId: ready, value: boolLit(true, loc), loc },
      { kind: "return", value: storageRef(), loc },
    ];
    lowerer.liftedFns.push({ name: helper, params: [], locals: [], returnType: type, body, loc });
    lowerer.shareHelper(helper);
  }
  lowerer.noteEdge(helper);
  return { kind: "call", callee: helper, args: [], type, loc };
}

/* ── event-loop metrics: eventLoopUtilization and monitorEventLoopDelay ── */

/** The stdlib IntervalHistogram (monitorEventLoopDelay's result), by the
 * receiver's checker type. Its value is the runtime histogram handle. */
function isIntervalHistogram(lowerer: Lowerer, node: ts.Expression): boolean {
  const symbol = lowerer.typeOf(node).getSymbol();
  return (
    symbol !== undefined &&
    ts.symbolName(symbol) === "IntervalHistogram" &&
    lowerer.isStdlibSymbol(symbol)
  );
}

/** IntervalHistogram's numeric members, as perf.eldStat selectors. */
const HISTOGRAM_STATS: ReadonlyMap<string, number> = new Map([
  ["min", 0],
  ["max", 1],
  ["mean", 2],
  ["stddev", 3],
  ["count", 4],
  ["exceeds", 5],
]);

/** `h.min`, `h.max`, … on an IntervalHistogram: the runtime's current
 * statistic (Node's hdr_histogram values; nanoseconds). Null for every
 * other read. */
export function lowerHistogramProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const which = HISTOGRAM_STATS.get(expr.name.text);
  if (
    which === undefined ||
    expr.questionDotToken ||
    !isIntervalHistogram(lowerer, expr.expression)
  )
    return null;
  const loc = locOf(expr);
  return {
    kind: "libCall",
    fn: "perf.eldStat",
    args: [lowerer.lowerExprExpecting(expr.expression, F64), numLit(which, loc)],
    type: F64,
    loc,
  };
}

/** enable(), disable(), reset() and percentile(p) on an IntervalHistogram.
 * Other members (the BigInt twins, the percentiles Map) fence by name. */
export function lowerHistogramMethodCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.questionDotToken || !isIntervalHistogram(lowerer, access.expression)) return null;
  const loc = locOf(expr);
  const name = access.name.text;
  const handle = (): IrExpr => lowerer.lowerExprExpecting(access.expression, F64);
  const args = expr.arguments.nodes;
  if ((name === "enable" || name === "disable" || name === "reset") && args.length === 0) {
    const fn =
      name === "enable"
        ? "perf.eldEnable"
        : name === "disable"
          ? "perf.eldDisable"
          : "perf.eldReset";
    return { kind: "libCall", fn, args: [handle()], type: name === "reset" ? VOID : BOOL, loc };
  }
  if (name === "percentile" && args.length === 1 && !ts.isSpreadElement(args[0]!)) {
    // Node validates first: NaN, p <= 0 and p > 100 throw ERR_OUT_OF_RANGE.
    const h = lowerer.declareHiddenLocal("%histogram", F64);
    const p = lowerer.declareHiddenLocal("%percentile", F64);
    const pRef = (): IrExpr => varRef(p.id, F64, loc);
    const cmp = (op: "!==" | "<=" | ">", left: IrExpr, right: IrExpr): IrExpr => ({
      kind: "bin",
      op,
      left,
      right,
      type: BOOL,
      loc,
    });
    const or = (left: IrExpr, right: IrExpr): IrExpr => ({
      kind: "logical",
      op: "||",
      left,
      right,
      type: BOOL,
      loc,
    });
    const outOfRange = or(
      or(cmp("!==", pRef(), pRef()), cmp("<=", pRef(), numLit(0, loc))),
      cmp(">", pRef(), numLit(100, loc)),
    );
    const message: IrExpr = {
      kind: "strConcat",
      left: {
        kind: "strLit",
        value: 'The value of "percentile" is out of range. It must be > 0 && <= 100. Received ',
        type: STRING,
        loc,
      },
      right: { kind: "toString", operand: pRef(), type: STRING, loc },
      type: STRING,
      loc,
    };
    const thrown: IrExpr = {
      kind: "libCall",
      fn: "error.nodeThrow",
      args: [
        numLit(2, loc),
        { kind: "strLit", value: "ERR_OUT_OF_RANGE", type: STRING, loc },
        message,
      ],
      type: F64,
      loc,
    };
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: h.id, init: handle(), loc },
        { kind: "varDecl", localId: p.id, init: lowerer.lowerExprExpecting(args[0]!, F64), loc },
      ],
      result: {
        kind: "ternary",
        cond: outOfRange,
        then: thrown,
        else_: {
          kind: "libCall",
          fn: "perf.eldPercentile",
          args: [varRef(h.id, F64, loc), pRef()],
          type: F64,
          loc,
        },
        type: F64,
        loc,
      },
      type: F64,
      loc,
    };
  }
  lowerer.noLowering(
    `IntervalHistogram.${name}`,
    expr,
    "enable(), disable(), reset(), percentile(p) and the min, max, mean, stddev, count and exceeds readings are the lowered surface",
  );
}

/** `monitorEventLoopDelay(options?)` from node:perf_hooks, in any import
 * spelling (`lowerBuiltinCall`): a new sampling histogram handle. The
 * options are an inline object literal; the runtime validates the
 * resolution as Node does (an integer of at least 1). */
export function lowerMonitorEventLoopDelayCall(lowerer: Lowerer, expr: ts.CallExpression): IrExpr {
  const loc = locOf(expr);
  const args = expr.arguments.nodes;
  let resolution: IrExpr = numLit(10, loc);
  if (args.length > 1 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      "this monitorEventLoopDelay call form",
      expr,
      "pass at most one options object",
    );
  }
  if (args.length === 1) {
    const options = args[0]!;
    if (!ts.isObjectLiteralExpression(options)) {
      lowerer.noLowering(
        "monitorEventLoopDelay with a non-literal options object",
        options,
        "spell the options inline: monitorEventLoopDelay({ resolution: 20 })",
      );
    }
    for (const property of options.properties.nodes) {
      const shorthand = ts.isShorthandPropertyAssignment(property);
      if (
        (!shorthand && !ts.isPropertyAssignment(property)) ||
        !ts.isIdentifier(property.name) ||
        property.name.text !== "resolution"
      ) {
        lowerer.noLowering(
          "monitorEventLoopDelay options other than resolution",
          property,
          "resolution is the one option",
        );
      }
      // An undefined resolution takes the default, as Node's destructuring.
      resolution = lowerOptionalArgument(
        lowerer,
        shorthand ? property.name : property.initializer,
        F64,
        numLit(10, loc),
      );
    }
  }
  return { kind: "libCall", fn: "perf.eldNew", args: [resolution], type: F64, loc };
}

/** performance.eventLoopUtilization(u1?, u2?) — Node's
 * lib/internal/perf/event_loop_utilization.js over the runtime's loop
 * start and idle time, one lifted helper per arity. */
function lowerEventLoopUtilization(lowerer: Lowerer, expr: ts.CallExpression): IrExpr {
  const loc = locOf(expr);
  const args = expr.arguments.nodes;
  const resultT = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (resultT?.kind !== "record" || args.length > 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering("this performance.eventLoopUtilization call form", expr);
  }
  const helper = eluHelperOf(lowerer, args.length, resultT);
  return {
    kind: "call",
    callee: helper,
    args: args.map((arg) => lowerer.lowerExprExpecting(arg, resultT)),
    type: resultT,
    loc,
  };
}

function eluHelperOf(lowerer: Lowerer, arity: number, recT: IrType & { kind: "record" }): string {
  const name = `%perf.elu.${arity}`;
  if (lowerer.liftedFnNamed(name) !== undefined) return name;
  const loc: SrcLoc = { file: "<builtin>", start: 0, end: 0 };
  const f64Local = (id: string) => ({ id, name: id, type: F64, mutable: false });
  const params = Array.from({ length: arity }, (_, i) => ({
    localId: `u${i + 1}.0`,
    name: `u${i + 1}`,
    type: recT as IrType,
  }));
  const locals = [
    ...params.map((p) => ({ id: p.localId, name: p.name, type: recT as IrType, mutable: false })),
    f64Local("ls.0"),
    f64Local("idle.0"),
    f64Local("active.0"),
  ];
  const ref = (id: string): IrExpr => varRef(id, F64, loc);
  const field = (param: string, f: string): IrExpr => ({
    kind: "recordGet",
    obj: varRef(param, recT, loc),
    shapeId: recT.shapeId,
    field: f,
    type: F64,
    loc,
  });
  const bin = (op: "+" | "-" | "/" | "<=", left: IrExpr, right: IrExpr): IrExpr => ({
    kind: "bin",
    op,
    left,
    right,
    type: op === "<=" ? BOOL : F64,
    loc,
  });
  const record = (idle: IrExpr, active: IrExpr, utilization: IrExpr): IrExpr => ({
    kind: "recordLit",
    fields: [
      { name: "idle", value: idle },
      { name: "active", value: active },
      { name: "utilization", value: utilization },
    ],
    type: recT,
    loc,
  });
  const result = (idle: IrExpr, active: IrExpr): IrStmt => ({
    kind: "return",
    value: record(idle, active, bin("/", active, bin("+", idle, active))),
    loc,
  });
  const decl = (id: string, init: IrExpr): IrStmt => ({ kind: "varDecl", localId: id, init, loc });
  const body: IrStmt[] = [
    decl("ls.0", { kind: "libCall", fn: "perf.loopStart", args: [], type: F64, loc }),
    {
      kind: "if",
      cond: bin("<=", ref("ls.0"), numLit(0, loc)),
      then: [
        { kind: "return", value: record(numLit(0, loc), numLit(0, loc), numLit(0, loc)), loc },
      ],
      else_: null,
      loc,
    },
  ];
  if (arity === 2) {
    body.push(
      decl("idle.0", bin("-", field("u1.0", "idle"), field("u2.0", "idle"))),
      decl("active.0", bin("-", field("u1.0", "active"), field("u2.0", "active"))),
      result(ref("idle.0"), ref("active.0")),
    );
  } else {
    body.push(
      decl("idle.0", { kind: "libCall", fn: "perf.idleTime", args: [], type: F64, loc }),
      decl(
        "active.0",
        bin(
          "-",
          bin("-", { kind: "libCall", fn: "perf.now", args: [], type: F64, loc }, ref("ls.0")),
          ref("idle.0"),
        ),
      ),
      arity === 0
        ? result(ref("idle.0"), ref("active.0"))
        : result(
            bin("-", ref("idle.0"), field("u1.0", "idle")),
            bin("-", ref("active.0"), field("u1.0", "active")),
          ),
    );
  }
  lowerer.liftedFns.push({ name, params, returnType: recT, locals, body, loc });
  return name;
}
