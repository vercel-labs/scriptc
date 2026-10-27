import { keyedHelperName } from "../stable-names.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { numLit, varRef } from "../../../ir/build.js";
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

/** Presence probes do not extract an unbound Performance method value. */
export function lowerPerfHooksTypeof(lowerer: Lowerer, expression: ts.Expression): IrExpr | null {
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
    access.name.text === "eventLoopUtilization" &&
    isPerfHooksPerformanceExpr(lowerer, access.expression)
  ) {
    return lowerEventLoopUtilization(lowerer, expr);
  }
  const timeline = PERF_TIMELINE_CALLS.get(access.name.text);
  if (timeline && isPerfHooksPerformanceExpr(lowerer, access.expression)) {
    return lowerPerfTimelineCall(lowerer, expr, access.name.text, timeline, loc);
  }
  if (isPerfHooksPerformanceExpr(lowerer, access.expression)) {
    lowerer.noLowering(
      `perf_hooks performance.${access.name.text}`,
      expr,
      "performance.now() (and its .bind(performance) function value), mark, measure, the getEntries family, clearMarks, clearMeasures and eventLoopUtilization are the lowered surface",
    );
  }
  return null;
}

/** The memoized () => number lifted wrapper behind
 * performance.now.bind(performance): a plain function value over the
 * same perf.now libCall. */
function perfNowFnValueOf(lowerer: Lowerer): string {
  const name = "%perf.now.value";
  if (!lowerer.liftedFns.some((f) => f.name === name)) {
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
    [PERF_ENTRY_MARKER]: lowerer.absentFieldValue(marker.type, loc)!,
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
function lowerPerfArguments(lowerer: Lowerer, call: ts.CallExpression, loc: SrcLoc): IrExpr {
  if (!call.arguments.nodes.some(ts.isSpreadElement)) {
    return {
      kind: "dynArrLit",
      elems: call.arguments.nodes.map((a) => lowerer.lowerExprExpecting(a, DYN)),
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
  for (const arg of call.arguments.nodes) {
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
  const key = `perf.${many ? "entries" : timeline.fn}:${typeKey(result)}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, `%perf.${many ? "entries" : member}`, key);
    lowerer.valueHelpers.set(key, helper);
    const argsRef = varRef("a.0", DYN, loc);
    const whichRef = varRef("w.0", F64, loc);
    const locals: { id: string; name: string; type: IrType; mutable: boolean }[] = [
      { id: "a.0", name: "a", type: DYN, mutable: false },
    ];
    let body: IrStmt[];
    if (!many) {
      // The new entry's record goes back to the runtime by reference, so
      // later getEntries calls answer this same object.
      locals.push({ id: "e.0", name: "e", type: entryT, mutable: false });
      const entry = varRef("e.0", entryT, loc);
      body = [
        {
          kind: "exprStmt",
          expr: { kind: "libCall", fn: timeline.fn, args: [argsRef], type: F64, loc },
          loc,
        },
        {
          kind: "varDecl",
          localId: "e.0",
          init: perfEntryRecord(lowerer, entryT, numLit(0, loc), loc),
          loc,
        },
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "perf.entryKeep",
            args: [{ kind: "dynFrom", value: entry, liveRef: true, type: DYN, loc }],
            type: VOID,
            loc,
          },
          loc,
        },
        { kind: "return", value: entry, loc },
      ];
    } else {
      locals.push(
        { id: "w.0", name: "w", type: F64, mutable: false },
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "out.0", name: "out", type: result, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
      );
      const index = varRef("i.0", F64, loc);
      const count = varRef("n.0", F64, loc);
      const out = varRef("out.0", result, loc);
      body = [
        {
          kind: "varDecl",
          localId: "n.0",
          init: { kind: "libCall", fn: "perf.entries", args: [argsRef, whichRef], type: F64, loc },
          loc,
        },
        {
          kind: "varDecl",
          localId: "out.0",
          init: { kind: "arrayLit", elems: [], type: result, loc },
          loc,
        },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
          cond: { kind: "bin", op: "<", left: index, right: count, type: BOOL, loc },
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
      ];
    }
    lowerer.liftedFns.push({
      name: helper,
      params: [
        { localId: "a.0", name: "a", type: DYN },
        ...(many ? [{ localId: "w.0", name: "w", type: F64 }] : []),
      ],
      returnType: result,
      locals,
      body,
      loc,
    });
  }
  return {
    kind: "call",
    callee: helper,
    args: many ? [args, numLit(timeline.which!, loc)] : [args],
    type: result,
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
  if (lowerer.liftedFns.some((f) => f.name === name)) return name;
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
