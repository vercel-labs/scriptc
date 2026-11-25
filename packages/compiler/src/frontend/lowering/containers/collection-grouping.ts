import { keyedHelperName } from "../stable-names.js";
import { boolLit, countedFor, dynUndefinedExpr, numLit, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import {
  BOOL,
  CAUGHT,
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  typeEquals,
} from "../../../ir/ir.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { type GenType, genStep, genValue, stepDrivable } from "../lower-generators.js";
import { lowerArrayCallback } from "./callback-arguments.js";
import { iteratorCanStep } from "../iterator-consumption.js";
import { typeKey } from "../../type-mapper.js";

/** Object.groupBy / Map.groupBy (ES2024): group the elements of an
 * array, Set, Map (its [key, value] entries) or generator by a
 * per-element key. Both lower to one interned helper loop per source and
 * callback type — the callback runs synchronously per element (index included in
 * the two-parameter form), the first occurrence of a key creates its
 * group in encounter order, and later hits push onto the same array
 * (JS's exact accumulation — the stored arrays are the live groups).
 * Map.groupBy keeps typed keys under SameValueZero; Object.groupBy
 * requires a STRING-KEYED result (Partial<Record<string, T[]>> — a
 * literal-union key type makes a fixed-field record, which has no
 * grouping representation) and stringifies number keys like JS property
 * keys; its result has a null prototype. Other iterables fence (spread
 * into an array first). Null when the callee isn't the stdlib Object/Map
 * groupBy. */
export function lowerGroupByStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text !== "groupBy") return null;
  const isMap = lowerer.isStdlibGlobal(access.expression, "Map");
  const isObject = !isMap && lowerer.isStdlibGlobal(access.expression, "Object");
  if (!isMap && !isObject) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const what = isMap ? "Map.groupBy" : "Object.groupBy";
  const loc = locOf(call);
  if (
    call.arguments.nodes.length !== 2 ||
    call.arguments.nodes.some((a) => ts.isSpreadElement(a))
  ) {
    lowerer.noLowering(`${what} with ${call.arguments.nodes.length} arguments`, call);
  }
  const items = lowerer.lowerExpr(call.arguments.nodes[0]!);
  const elem = groupedElement(lowerer, items.type);
  if (elem === null) {
    // A JavaScript source groups a checked-dynamic value (`Object.groupBy(items,
    // f)` on an untyped parameter, `Map.groupBy([])`): the elements, the keys
    // and the result are dynamic, so the whole loop runs on the
    // checked-dynamic tree (dynamic-grouping below) instead of a typed helper.
    const dynamic = lowerDynamicGroupByCall(lowerer, call, items, null, isMap, loc);
    if (dynamic) return dynamic;
    lowerer.noLowering(
      `${what} over an iterable of type '${lowerer.checker.typeToString(lowerer.typeOf(call.arguments.nodes[0]!))}'`,
      call.arguments.nodes[0]!,
      "arrays, Sets, Maps and generators are the supported items forms — spread other iterables first: [...items]",
    );
  }
  const groupT = arrayOf(elem);
  const fNode = call.arguments.nodes[1]!;
  // An unannotated JavaScript callback parameter takes the element.
  const f =
    isJsSourceFile(ts.getSourceFileOfNode(fNode)) &&
    (ts.isArrowFunction(fNode) || ts.isFunctionExpression(fNode))
      ? lowerArrayCallback(lowerer, fNode, [elem], groupT, true).fnArg
      : lowerer.lowerExpr(fNode);
  if (
    f.type.kind !== "func" ||
    f.type.params.length > 2 ||
    (f.type.params.length >= 1 && !typeEquals(f.type.params[0]!, elem)) ||
    (f.type.params.length === 2 && f.type.params[1]!.kind !== "f64")
  ) {
    lowerer.badType(call.arguments.nodes[1]!, lowerer.typeOf(call.arguments.nodes[1]!));
  }
  const keyT = f.type.ret;
  // The call's own type keeps the callback's literal-union key type
  // (Partial<Record<"even" | "odd", T[]>> — a FIXED-FIELD record, which
  // has no grouping representation); a CONTEXT naming the string-keyed
  // form (the annotated-const idiom) is the groupable reading, so it
  // wins when it maps that way.
  const ctxT = lowerer.checker.getContextualType(call);
  const ctxMapped = ctxT !== undefined ? lowerer.mapTypeOf(ctxT) : null;
  const ownMapped = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (isMap) {
    const resultT = ctxMapped?.kind === "map" ? ctxMapped : ownMapped;
    if (
      resultT?.kind !== "map" ||
      !typeEquals(resultT.key, keyT) ||
      !typeEquals(resultT.value, groupT)
    ) {
      const dynamic = lowerDynamicGroupByCall(lowerer, call, items, f, isMap, loc);
      if (dynamic) return dynamic;
      lowerer.noLowering(
        `${what} at this result type`,
        call,
        "the result must be Map<K, T[]> over the callback's K and the items' T — annotate: Map.groupBy<K, T>(items, f)",
      );
    }
    const key = `map.groupBy:${typeKey(items.type)}:${typeKey(f.type)}`;
    let helper = lowerer.mapHofHelpers.get(key);
    if (!helper) {
      helper = keyedHelperName(lowerer, "%map.groupBy", key);
      lowerer.mapHofHelpers.set(key, helper);
      lowerer.liftedFns.push(buildGroupByFn(lowerer, helper, items.type, f.type, resultT, loc));
    }
    return { kind: "call", callee: helper, args: [items, f], type: resultT, loc };
  }
  // A groupable reading is an INDEX-SIGNATURE record (no declared
  // fields). Either candidate qualifying proves the checker committed
  // the result to the string-keyed form; the VALUE's shape is then
  // minted exactly (fields none, index value T[] | undefined — the
  // structural intern, so a matching annotation shares the id) rather
  // than adopted, because mapped-type instantiations can arrive with a
  // widened index value.
  const indexShaped = (t: IrType | null): boolean => {
    if (t?.kind !== "record") return false;
    const s = lowerer.shapes.get(t.shapeId);
    return s !== undefined && s.fields.length === 0 && s.indexValue !== undefined;
  };
  if (
    (!indexShaped(ctxMapped) && !indexShaped(ownMapped)) ||
    (keyT.kind !== "string" && keyT.kind !== "f64")
  ) {
    // A JavaScript source's channel takes a literal-union key
    // (`n > 2 ? "big" : "small"`) the way Node does: a dynamic object whose
    // groups the program reads by property key.
    const dynamic = lowerDynamicGroupByCall(lowerer, call, items, f, isMap, loc);
    if (dynamic) return dynamic;
    lowerer.noLowering(
      `${what} at this result type`,
      call,
      "a string-keyed result (Partial<Record<string, T[]>>) is the supported form — a literal-union " +
        "key type makes a fixed-field record: widen the callback's key type to string " +
        "(numbers stringify like JS property keys)",
    );
  }
  const resultT: IrType & { kind: "record" } = {
    kind: "record",
    shapeId: lowerer.shapes.intern([], false, lowerer.withUndefinedArm(groupT), []),
  };
  const key = `object.groupBy:${typeKey(items.type)}:${typeKey(f.type)}`;
  let helper = lowerer.mapHofHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%object.groupBy", key);
    lowerer.mapHofHelpers.set(key, helper);
    lowerer.liftedFns.push(buildGroupByFn(lowerer, helper, items.type, f.type, resultT, loc));
  }
  return { kind: "call", callee: helper, args: [items, f], type: resultT, loc };
}

/** The checked-dynamic `Object.groupBy`/`Map.groupBy` (a JavaScript source
 * over an untyped value), Node's ArrayGroupBy over the checked-dynamic tree:
 *
 *   g = new Map() | Object.create(null)
 *   it = %iterator%(source)             // the source's own iterator, walked LIVE
 *   for (step = it.next(); !step.done; step = it.next()) {
 *     v = step.value; k = f(v, i);      // Map keeps k, Object takes ToPropertyKey
 *     cur = g.get(k)                    // the object's own keyed read
 *     if (cur === undefined) g.set(k, [v]); else cur.push(v);
 *   }
 *   return g
 *
 * The result is dynamic; assignment to a typed slot converts through the
 * usual checked-dynamic boundary. Null when the source is not dynamic or the
 * call is not in a JavaScript source (a typed source keeps its typed helper,
 * and its fences). */
function lowerDynamicGroupByCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  items: IrExpr,
  lowered: IrExpr | null,
  isMap: boolean,
  loc: SrcLoc,
): IrExpr | null {
  if (!isJsSourceFile(ts.getSourceFileOfNode(call))) return null;
  // The checked-dynamic grouping builds a generic checked-dynamic Map. It
  // converts to a typed result only when that result states no key/value
  // types (`Map<any, any>`, what an untyped source's call is typed as); a
  // result the checker types as a Map<…> keeps the typed helper and its
  // refusal, so the program never takes a conversion the value cannot
  // satisfy. An object result converts structurally, so it stays dynamic.
  if (isMap) {
    const mapped = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (mapped !== null && mapped.kind === "map") return null;
  }
  const source =
    items.type.kind === "dyn"
      ? items
      : lowerer.dynConvertible(items.type)
        ? ({ kind: "dynFrom", value: items, type: DYN, loc } satisfies IrExpr)
        : null;
  if (source === null) return null;
  const fNode = call.arguments.nodes[1]!;
  if (ts.isSpreadElement(fNode)) return null;
  const f = lowered ?? lowerer.lowerExpr(fNode);
  if (f.type.kind !== "func" && f.type.kind !== "dyn") return null;
  const key = `dyn.groupBy:${isMap ? "map" : "object"}:${typeKey(f.type)}`;
  let helper = lowerer.mapHofHelpers.get(key);
  if (helper === undefined) {
    helper = keyedHelperName(lowerer, isMap ? "%map.groupBy.dyn" : "%object.groupBy.dyn", key);
    lowerer.mapHofHelpers.set(key, helper);
    lowerer.liftedFns.push(buildDynGroupByFn(lowerer, helper, f.type, isMap, loc));
  }
  const accumulator: IrExpr = isMap
    ? {
        kind: "libCall",
        fn: "dyn.construct",
        args: [
          {
            kind: "libCall",
            fn: "dyn.globalConstructor",
            args: [{ kind: "strLit", value: "Map", type: STRING, loc }],
            type: DYN,
            loc,
          },
          { kind: "dynArrLit", elems: [], type: DYN, loc },
          { kind: "strLit", value: "Map", type: STRING, loc },
        ],
        type: DYN,
        loc,
      }
    : { kind: "libCall", fn: "dyn.objCreateNullProto", args: [], type: DYN, loc };
  return { kind: "call", callee: helper, args: [source, f, accumulator], type: DYN, loc };
}

/** The dynamic grouping loop (lowerDynamicGroupByCall). The source is walked
 * by its iterator, one element per callback, so the source is LIVE while the
 * callbacks run exactly as Node's ArrayGroupBy walks it: an array, Set or Map
 * the callback appends to groups the added entries, and entries it deletes
 * are skipped. A throwing callback closes the iterator, with return()'s own
 * error suppressed behind the callback's. The group read and write go through
 * the dynamic receiver's own stores — a Map handle's get/set for Map.groupBy
 * (SameValueZero keys, Node's Map), an own keyed read/write of the
 * null-prototype object for Object.groupBy, whose key passes ToPropertyKey
 * first (symbols stay symbols, other keys stringify). */
function buildDynGroupByFn(
  lowerer: Lowerer,
  name: string,
  fT: IrType,
  isMap: boolean,
  loc: SrcLoc,
): IrFunction {
  const items = (): IrExpr => varRef("items.0", DYN, loc);
  const g = (): IrExpr => varRef("g.0", DYN, loc);
  const iterator = (): IrExpr => varRef("iterator.0", DYN, loc);
  const next = (): IrExpr => varRef("next.0", DYN, loc);
  const fast = (): IrExpr => varRef("fast.0", BOOL, loc);
  const done = (): IrExpr => varRef("done.0", BOOL, loc);
  const value = (): IrExpr => varRef("value.0", DYN, loc);
  const step = (): IrExpr => varRef("step.0", DYN, loc);
  const returned = (): IrExpr => varRef("close.0", DYN, loc);
  const cur = (): IrExpr => varRef("cur.0", DYN, loc);
  const v = value;
  const notDone = (): IrExpr => ({ kind: "unary", op: "!", operand: done(), type: BOOL, loc });
  const member = (source: IrExpr, key: string): IrExpr => ({
    kind: "dynKeyGet",
    value: source,
    key: { kind: "strLit", value: key, type: STRING, loc },
    type: DYN,
    loc,
  });
  const index = (): IrExpr => ({
    kind: "dynFrom",
    value: varRef("i.0", F64, loc),
    type: DYN,
    loc,
  });
  // The callback's answer as a dynamic value. A typed function value is
  // called with the parameters it declares (the index included only for a
  // two-parameter callback, like the typed helper); a dynamic callback is
  // called with both, as JavaScript passes them.
  const keyOf = (): IrExpr => {
    if (fT.kind !== "func") {
      return {
        kind: "dynCall",
        callee: varRef("f.0", DYN, loc),
        calleeName: "callback",
        args: [v(), index()],
        type: DYN,
        loc,
      };
    }
    const callee = varRef("f.0", fT, loc);
    // The element crosses into the helper's dynamic loop: a typed parameter
    // takes the checked extraction of it (the source element's static type).
    const first = (): IrExpr =>
      fT.params[0]!.kind === "dyn" ? v() : lowerer.coerceToExpected(v(), fT.params[0]!);
    const args =
      fT.params.length === 0
        ? []
        : fT.params.length === 1
          ? [first()]
          : [first(), varRef("i.0", F64, loc)];
    const call: IrExpr = { kind: "callValue", callee, args, type: fT.ret, loc };
    return fT.ret.kind === "dyn" ? call : lowerer.coerceToExpected(call, DYN);
  };
  const key: IrExpr = isMap
    ? keyOf()
    : { kind: "libCall", fn: "dyn.propertyKey", args: [keyOf()], type: DYN, loc };
  const read = (): IrExpr =>
    isMap
      ? {
          kind: "dynInvoke",
          recv: g(),
          method: "get",
          calleeName: "get",
          args: [varRef("k.0", DYN, loc)],
          type: DYN,
          loc,
        }
      : { kind: "dynKeyGet", value: g(), key: varRef("k.0", DYN, loc), type: DYN, loc };
  const fresh = (): IrExpr => ({ kind: "dynArrLit", elems: [v()], type: DYN, loc });
  const store: IrStmt = {
    kind: "exprStmt",
    expr: isMap
      ? {
          kind: "dynInvoke",
          recv: g(),
          method: "set",
          calleeName: "set",
          args: [varRef("k.0", DYN, loc), fresh()],
          type: DYN,
          loc,
        }
      : {
          kind: "libCall",
          fn: "dyn.keySetComputed",
          args: [g(), varRef("k.0", DYN, loc), fresh()],
          type: VOID,
          loc,
        },
    loc,
  };
  const push: IrStmt = {
    kind: "exprStmt",
    expr: {
      kind: "dynInvoke",
      recv: cur(),
      method: "push",
      calleeName: "push",
      args: [v()],
      type: DYN,
      loc,
    },
    loc,
  };
  const locals: IrLocal[] = [
    { id: "items.0", name: "items", type: DYN, mutable: false },
    { id: "f.0", name: "f", type: fT, mutable: false },
    { id: "g.0", name: "g", type: DYN, mutable: true },
    { id: "iterator.0", name: "iterator", type: DYN, mutable: false },
    { id: "next.0", name: "next", type: DYN, mutable: false },
    { id: "fast.0", name: "fast", type: BOOL, mutable: false },
    { id: "done.0", name: "done", type: BOOL, mutable: true },
    { id: "value.0", name: "value", type: DYN, mutable: true },
    { id: "step.0", name: "step", type: DYN, mutable: false },
    { id: "i.0", name: "i", type: F64, mutable: true },
    { id: "k.0", name: "k", type: DYN, mutable: false },
    { id: "cur.0", name: "cur", type: DYN, mutable: false },
    { id: "close.0", name: "close", type: DYN, mutable: false },
    { id: "error.0", name: "error", type: CAUGHT, mutable: false },
  ];
  return {
    name,
    params: [
      { localId: "items.0", name: "items", type: DYN },
      { localId: "f.0", name: "f", type: fT },
      { localId: "g.0", name: "g", type: DYN },
    ],
    returnType: DYN,
    locals,
    body: [
      {
        kind: "varDecl",
        localId: "iterator.0",
        init: {
          kind: "libCall",
          fn: "dyn.iterator",
          args: [items(), { kind: "strLit", value: "items", type: STRING, loc }],
          type: DYN,
          loc,
        },
        loc,
      },
      // next is read once, as JS keeps it in the iterator record.
      { kind: "varDecl", localId: "next.0", init: member(iterator(), "next"), loc },
      { kind: "varDecl", localId: "fast.0", init: iteratorCanStep(iterator(), next(), loc), loc },
      { kind: "varDecl", localId: "done.0", init: boolLit(false, loc), loc },
      { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
      {
        kind: "while",
        cond: { kind: "unary", op: "!", operand: done(), type: BOOL, loc },
        body: [
          // Declared before the branches, which each assign it: a local
          // declared in a branch is released when the branch ends.
          { kind: "varDecl", localId: "value.0", init: dynUndefinedExpr(loc), loc },
          {
            kind: "if",
            cond: fast(),
            then: [
              {
                kind: "assign",
                localId: "value.0",
                value: {
                  kind: "libCall",
                  fn: "dyn.iteratorStep",
                  args: [iterator()],
                  type: DYN,
                  loc,
                },
                loc,
              },
              {
                kind: "assign",
                localId: "done.0",
                value: {
                  kind: "libCall",
                  fn: "dyn.iteratorStepDone",
                  args: [iterator()],
                  type: BOOL,
                  loc,
                },
                loc,
              },
            ],
            else_: [
              {
                kind: "varDecl",
                localId: "step.0",
                init: {
                  kind: "libCall",
                  fn: "dyn.iteratorResult",
                  args: [
                    {
                      kind: "dynCall",
                      callee: next(),
                      receiver: iterator(),
                      calleeName: "iterator.next",
                      args: [],
                      type: DYN,
                      loc,
                    },
                  ],
                  type: DYN,
                  loc,
                },
                loc,
              },
              // done before value: a completed iterator's value is never read.
              {
                kind: "assign",
                localId: "done.0",
                value: {
                  kind: "dynTest",
                  test: "truthy",
                  value: member(step(), "done"),
                  type: BOOL,
                  loc,
                },
                loc,
              },
              {
                kind: "if",
                cond: notDone(),
                then: [{ kind: "assign", localId: "value.0", value: member(step(), "value"), loc }],
                else_: null,
                loc,
              },
            ],
            loc,
          },
          {
            kind: "if",
            cond: notDone(),
            then: [
              {
                kind: "tryCatch",
                tryBody: [
                  { kind: "varDecl", localId: "k.0", init: key, loc },
                  { kind: "varDecl", localId: "cur.0", init: read(), loc },
                  {
                    kind: "if",
                    cond: { kind: "dynTest", test: "undefined", value: cur(), type: BOOL, loc },
                    then: [store],
                    else_: [push],
                    loc,
                  },
                  {
                    kind: "assign",
                    localId: "i.0",
                    value: {
                      kind: "bin",
                      op: "+",
                      left: varRef("i.0", F64, loc),
                      right: numLit(1, loc),
                      type: F64,
                      loc,
                    },
                    loc,
                  },
                ],
                // IteratorClose: an abrupt end of the grouping loop closes
                // the source, and return()'s own error never displaces the
                // callback's.
                catchLocalId: "error.0",
                catchBody: [
                  {
                    kind: "tryCatch",
                    tryBody: [
                      {
                        kind: "varDecl",
                        localId: "close.0",
                        init: member(iterator(), "return"),
                        loc,
                      },
                      {
                        kind: "if",
                        cond: {
                          kind: "dynTest",
                          test: "function",
                          value: returned(),
                          type: BOOL,
                          loc,
                        },
                        then: [
                          {
                            kind: "exprStmt",
                            expr: {
                              kind: "dynCall",
                              callee: returned(),
                              receiver: iterator(),
                              calleeName: "iterator.return",
                              args: [],
                              type: DYN,
                              loc,
                            },
                            loc,
                          },
                        ],
                        else_: null,
                        loc,
                      },
                    ],
                    catchBody: [],
                    catchLocalId: null,
                    finallyBody: null,
                    loc,
                  },
                  { kind: "rethrow", localId: "error.0", loc },
                ],
                finallyBody: null,
                loc,
              },
            ],
            else_: null,
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: g(), loc },
    ],
    loc,
  };
}

/** The groupBy helper body — one loop, two grouping stores:
 *
 *   g = new Map() | {}
 *   for (i = 0; i < items.length; i++) {
 *     v = items[i]; k = f(v[, i]);
 *     cur = g.get(k)                    // the V|undefined union read
 *     if (cur is undefined) g.set(k, [v]); else cur.push(v);
 *   }
 *   return g
 *
 * The map read/write are mapIntrinsic get/set; the record pair are the
 * overflow keyed get/set with an f64 key stringified first (JS property
 * keys). Both reads answer the value-or-undefined union, so the arm
 * test IS the has() check with one lookup. */
function buildGroupByFn(
  lowerer: Lowerer,
  name: string,
  sourceT: IrType,
  fnT: IrType & { kind: "func" },
  resultT: (IrType & { kind: "map" }) | (IrType & { kind: "record" }),
  loc: SrcLoc,
): IrFunction {
  const elem = groupedElement(lowerer, sourceT)!;
  const itemsT = arrayOf(elem) as IrType & { kind: "array" };
  const keyT = fnT.ret;
  const arity = fnT.params.length;
  const isMap = resultT.kind === "map";
  // The union the group read answers: the map value's undefined-armed
  // union, or the record shape's index value (validated by the caller).
  const iv: IrType & { kind: "union" } = isMap
    ? (lowerer.withUndefinedArm(itemsT) as IrType & { kind: "union" })
    : (lowerer.shapes.get(resultT.shapeId)!.indexValue as IrType & { kind: "union" });
  const arrTag = lowerer.armTag(iv.unionId, itemsT);
  const undefTag = lowerer.armTag(iv.unionId, UNDEFINED_T);

  const gRef = (): IrExpr => varRef("g.0", resultT, loc);
  const kRef = (): IrExpr => varRef("k.0", keyT, loc);
  // Record keys are property keys: an f64 key stringifies (JS's exact
  // number ToString); map keys stay typed.
  const storeKey = (): IrExpr =>
    isMap || keyT.kind === "string"
      ? kRef()
      : { kind: "toString", operand: kRef(), type: STRING, loc };
  const groupRead = (): IrExpr =>
    isMap
      ? { kind: "mapIntrinsic", method: "get", receiver: gRef(), args: [storeKey()], type: iv, loc }
      : {
          kind: "recordKeyGet",
          obj: gRef(),
          shapeId: (resultT as IrType & { kind: "record" }).shapeId,
          key: storeKey(),
          overflowOnly: true,
          type: iv,
          loc,
        };
  const freshGroup = (): IrExpr => ({
    kind: "arrayLit",
    elems: [varRef("v.0", elem, loc)],
    type: itemsT,
    loc,
  });
  const groupWrite = (): IrStmt =>
    isMap
      ? {
          kind: "exprStmt",
          expr: {
            kind: "mapIntrinsic",
            method: "set",
            receiver: gRef(),
            args: [storeKey(), freshGroup()],
            type: VOID,
            loc,
          },
          loc,
        }
      : {
          kind: "recordKeySet",
          obj: gRef(),
          shapeId: (resultT as IrType & { kind: "record" }).shapeId,
          key: storeKey(),
          value: {
            kind: "unionWrap",
            unionId: iv.unionId,
            tag: arrTag,
            value: freshGroup(),
            type: iv,
            loc,
          },
          loc,
        };
  const callArgs: IrExpr[] = [];
  if (arity >= 1) callArgs.push(varRef("v.0", elem, loc));
  if (arity === 2) callArgs.push(varRef("i.0", F64, loc));
  const locals: IrLocal[] = [
    { id: "items.0", name: "items", type: itemsT, mutable: true },
    { id: "f.0", name: "f", type: fnT, mutable: true },
    { id: "g.0", name: "g", type: resultT, mutable: false },
    { id: "n.0", name: "n", type: F64, mutable: false },
    { id: "i.0", name: "i", type: F64, mutable: true },
    { id: "v.0", name: "v", type: elem, mutable: false },
    { id: "k.0", name: "k", type: keyT, mutable: false },
    { id: "cur.0", name: "cur", type: iv, mutable: false },
  ];
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "g.0",
      // Object.groupBy's result object has a null prototype.
      init: isMap
        ? { kind: "mapNew", type: resultT, loc }
        : { kind: "recordLit", fields: [], nullProto: true, type: resultT, loc },
      loc,
    },
    {
      kind: "varDecl",
      localId: "n.0",
      init: {
        kind: "arrIntrinsic",
        method: "length",
        receiver: varRef("items.0", itemsT, loc),
        args: [],
        type: F64,
        loc,
      },
      loc,
    },
    countedFor(loc, varRef("n.0", F64, loc), () => [
      {
        kind: "varDecl",
        localId: "v.0",
        init: {
          kind: "arrayGet",
          arr: varRef("items.0", itemsT, loc),
          index: varRef("i.0", F64, loc),
          type: elem,
          loc,
        },
        loc,
      },
      {
        kind: "varDecl",
        localId: "k.0",
        init: {
          kind: "callValue",
          callee: varRef("f.0", fnT, loc),
          args: callArgs,
          type: keyT,
          loc,
        },
        loc,
      },
      { kind: "varDecl", localId: "cur.0", init: groupRead(), loc },
      {
        kind: "if",
        cond: {
          kind: "unionIsTag",
          unionId: iv.unionId,
          tag: undefTag,
          negated: false,
          value: varRef("cur.0", iv, loc),
          type: BOOL,
          loc,
        },
        then: [groupWrite()],
        else_: [
          {
            kind: "exprStmt",
            expr: {
              kind: "arrIntrinsic",
              method: "push",
              receiver: {
                kind: "unionNarrow",
                unionId: iv.unionId,
                tag: arrTag,
                value: varRef("cur.0", iv, loc),
                type: itemsT,
                loc,
              },
              args: [varRef("v.0", elem, loc)],
              type: F64,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
    ]),
    { kind: "return", value: gRef(), loc },
  ];
  if (sourceT.kind !== "array") {
    // Another iterable: the same per-element statements over its own
    // walk, the callback's index counted by hand.
    const loop = body[2] as IrStmt & { kind: "for" };
    const perElement = loop.body.slice(1);
    locals[0] = { id: "items.0", name: "items", type: sourceT, mutable: true };
    const walk = groupedWalk(lowerer, sourceT, elem, perElement, loc, (local) =>
      locals.push(local),
    );
    body.splice(1, 2, { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc }, ...walk);
  }
  return {
    name,
    params: [
      { localId: "items.0", name: "items", type: sourceT },
      { localId: "f.0", name: "f", type: fnT },
    ],
    returnType: resultT,
    locals,
    body,
    loc,
  };
}

/** The element a grouped source delivers: an array's or Set's element, a
 * Map's [key, value] pair (the checker's own tuple shape), or a
 * generator's yield. Null for other sources. */
function groupedElement(lowerer: Lowerer, sourceT: IrType): IrType | null {
  switch (sourceT.kind) {
    case "array":
    case "set":
      return sourceT.elem;
    case "map":
      return {
        kind: "record",
        shapeId: lowerer.shapes.intern(
          [
            { name: "0", type: sourceT.key },
            { name: "1", type: sourceT.value },
          ],
          true,
        ),
      };
    case "generator":
      return stepDrivable(sourceT) ? sourceT.yieldT : null;
    default:
      return null;
  }
}

/** The walk of a Set, Map or generator source: binds `v.0` to each element,
 * runs `perElement`, then advances the `i.0` counter. A Set or Map is
 * walked live, as forEach walks it (appended entries are visited, deleted
 * ones skipped), between iterEnter and iterExit. A generator is stepped,
 * and closed when a callback throws, as Node closes the iterator. */
function groupedWalk(
  lowerer: Lowerer,
  sourceT: IrType,
  elem: IrType,
  perElement: IrStmt[],
  loc: SrcLoc,
  addLocal: (local: IrLocal) => void,
): IrStmt[] {
  const items = (): IrExpr => varRef("items.0", sourceT, loc);
  const bump: IrStmt = {
    kind: "assign",
    localId: "i.0",
    value: {
      kind: "bin",
      op: "+",
      left: varRef("i.0", F64, loc),
      right: numLit(1, loc),
      type: F64,
      loc,
    },
    loc,
  };
  const visit = (value: IrExpr): IrStmt[] => [
    { kind: "varDecl", localId: "v.0", init: value, loc },
    ...perElement,
    bump,
  ];
  if (sourceT.kind === "set" || sourceT.kind === "map") {
    const collT = sourceT;
    const iter = (
      method: "iterCount" | "iterLive" | "iterKey" | "iterValue" | "iterEnter" | "iterExit",
      args: IrExpr[],
      type: IrType,
    ): IrExpr =>
      collT.kind === "map"
        ? { kind: "mapIntrinsic", method, receiver: items(), args, type, loc }
        : {
            kind: "setIntrinsic",
            method: method as "iterCount" | "iterLive" | "iterKey" | "iterEnter" | "iterExit",
            receiver: items(),
            args,
            type,
            loc,
          };
    addLocal({ id: "j.0", name: "j", type: F64, mutable: true });
    const j = (): IrExpr => varRef("j.0", F64, loc);
    const element: IrExpr =
      collT.kind === "map"
        ? {
            kind: "recordLit",
            fields: [
              { name: "0", value: iter("iterKey", [j()], collT.key) },
              { name: "1", value: iter("iterValue", [j()], collT.value) },
            ],
            type: elem,
            loc,
          }
        : iter("iterKey", [j()], collT.elem);
    return [
      { kind: "exprStmt", expr: iter("iterEnter", [], VOID), loc },
      {
        kind: "tryCatch",
        tryBody: [
          {
            kind: "for",
            init: { kind: "varDecl", localId: "j.0", init: numLit(0, loc), loc },
            cond: {
              kind: "bin",
              op: "<",
              left: j(),
              right: iter("iterCount", [], F64),
              type: BOOL,
              loc,
            },
            update: {
              kind: "assign",
              localId: "j.0",
              value: { kind: "bin", op: "+", left: j(), right: numLit(1, loc), type: F64, loc },
              loc,
            },
            body: [
              {
                kind: "if",
                cond: iter("iterLive", [j()], BOOL),
                then: visit(element),
                else_: null,
                loc,
              },
            ],
            loc,
          },
        ],
        catchBody: null,
        catchLocalId: null,
        finallyBody: [{ kind: "exprStmt", expr: iter("iterExit", [], VOID), loc }],
        loc,
      },
    ];
  }
  // A generator: `open` holds while an element is being grouped, so a
  // throwing callback closes the generator; an exhausted or throwing
  // generator is not closed.
  const genT = sourceT as GenType;
  addLocal({ id: "open.0", name: "open", type: BOOL, mutable: true });
  const setOpen = (value: boolean): IrStmt => ({
    kind: "assign",
    localId: "open.0",
    value: { kind: "boolLit", value, type: BOOL, loc },
    loc,
  });
  return [
    {
      kind: "varDecl",
      localId: "open.0",
      init: { kind: "boolLit", value: false, type: BOOL, loc },
      loc,
    },
    {
      kind: "tryCatch",
      tryBody: [
        {
          kind: "while",
          cond: { kind: "boolLit", value: true, type: BOOL, loc },
          body: [
            setOpen(false),
            {
              kind: "if",
              cond: genStep(items(), loc),
              then: [{ kind: "break", loc }],
              else_: null,
              loc,
            },
            setOpen(true),
            ...visit(genValue(varRef("items.0", genT, loc) as IrExpr & { type: GenType }, loc)),
          ],
          loc,
        },
      ],
      catchBody: null,
      catchLocalId: null,
      finallyBody: [
        {
          kind: "if",
          cond: varRef("open.0", BOOL, loc),
          then: [
            {
              kind: "exprStmt",
              expr: { kind: "genResume", mode: "close", gen: items(), arg: null, type: VOID, loc },
              loc,
            },
          ],
          else_: null,
          loc,
        },
      ],
      loc,
    },
  ];
}
