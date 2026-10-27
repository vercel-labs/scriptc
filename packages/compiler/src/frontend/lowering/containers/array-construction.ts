import { keyedHelperName } from "../stable-names.js";
import { indexedUnionArms, lowerIndexedUnionToArray } from "../indexed-unions.js";
import { generatorDrain } from "../iterator-adapters.js";
import { identityPreservingWidening } from "../coercions/identity.js";
import { liftedFreshSpread } from "../coercions/fresh-spread.js";
import { checkedIterableSpread } from "../checked-iterable-spread.js";
import { AstNode } from "../../ts7/ast-node.js";
import { InternalCompilerError } from "../../../errors.js";
import {
  dynUndefinedExpr,
  nodeThrowExpr,
  boolLit,
  countedFor,
  numLit,
  strLit,
  varRef,
} from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import {
  BOOL,
  CAUGHT,
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  arrayOf,
  isUnitType,
  canConvertToDyn,
  funcOf,
  isRefCounted,
  isSupportedArrayElem,
  typeEquals,
} from "../../../ir/ir.js";
import { isJsSourceFile, locOf } from "../../program.js";
import {
  arrayValueRead,
  arrayValueStore,
  arrayValueType,
  optionalElementValue,
  primitiveElement,
} from "../array-values.js";
import { typeKey } from "../../type-mapper.js";
import { newFnCtx } from "../lowerer.js";
import { iteratorCanStep, iteratorValue } from "../iterator-consumption.js";
import {
  collectionInput,
  ingestCollection,
  lowerCollectionInput,
} from "../collection-ingestion.js";
import {
  requireProducedArrayElement,
  lowerArrayCallback,
  callbackArrayElement,
} from "./callback-arguments.js";
import { classGeneratorIterable } from "../class-iterables.js";

/** A value whose type admits only null and undefined, stored into an array
 * that keeps undefined elements: the checker admits it there only when its
 * type is `undefined` (a tuple element typed `undefined` maps to such a
 * union), so it is evaluated and stored as undefined. */
function undefinedForNullish(
  lowerer: Lowerer,
  value: IrExpr,
  arrType: IrType & { kind: "array" },
): IrExpr {
  if (arrType.optionalElements !== true || value.type.kind !== "union") return value;
  const arms = lowerer.unions.get(value.type.unionId)?.arms ?? [];
  if (arms.length === 0 || !arms.every(isUnitType)) return value;
  const loc = value.loc;
  const optional: IrType = {
    kind: "union",
    unionId: lowerer.unions.intern([arrType.elem, UNDEFINED_T]),
  };
  const missing = lowerer.wrappedUndefined(optional, loc);
  if (!missing) return value;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: value, loc }],
    result: missing,
    type: optional,
    loc,
  };
}

/** Build the argument array for a mutating/copying operation while keeping
 * the receiver's scalar payload ABI. A missing read is represented as the
 * present UNDEFINED state in this temporary, so push/unshift and toSpliced
 * materialize it through their ordinary indexed/iterator copies. */
export function lowerArrayValueItems(
  lowerer: Lowerer,
  values: IrExpr[],
  elem: IrType,
  arrType: IrType & { kind: "array" },
  loc: SrcLoc,
): IrExpr {
  const out = lowerer.declareHiddenLocal("%arrayItems", arrType);
  const outRef = varRef(out.id, arrType, loc);
  const length = (): IrExpr => ({
    kind: "arrIntrinsic",
    method: "length",
    receiver: outRef,
    args: [],
    type: F64,
    loc,
  });
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: out.id,
      init: {
        kind: "arrayLit",
        elems: [],
        ...(values.length > 0 ? { capacity: Math.min(values.length, 1024) } : {}),
        type: arrType,
        loc,
      },
      loc,
    },
  ];
  for (const item of values) {
    const value = undefinedForNullish(lowerer, item, arrType);
    const stored =
      lowerer.runtimeOptionalWidening(value.type, elem) !== null ||
      optionalElementValue(lowerer, value, elem)
        ? value
        : lowerer.coerceToExpected(value, elem);
    body.push(arrayValueStore(lowerer, outRef, length(), stored, elem, loc));
  }
  return { kind: "seqExpr", stmts: body, result: outRef, type: arrType, loc };
}

/** The items of an array built from argument nodes (a spread copies its
 * elements in) and values already lowered (a spread tuple's fields), in
 * order. Each value is stored when its turn comes. */
export function lowerArraySpreadItems(
  lowerer: Lowerer,
  nodes: readonly (ts.Expression | IrExpr)[],
  elem: IrType,
  arrType: IrType & { kind: "array" },
  loc: SrcLoc,
): IrExpr {
  const out = lowerer.declareHiddenLocal("%arrayItems", arrType);
  const outRef = varRef(out.id, arrType, loc);
  const plainItems = nodes.filter(
    (node) => !(node instanceof AstNode) || !ts.isSpreadElement(node),
  ).length;
  const length = (): IrExpr => ({
    kind: "arrIntrinsic",
    method: "length",
    receiver: outRef,
    args: [],
    type: F64,
    loc,
  });
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: out.id,
      init: {
        kind: "arrayLit",
        elems: [],
        ...(plainItems > 0 ? { capacity: Math.min(plainItems, 1024) } : {}),
        type: arrType,
        loc,
      },
      loc,
    },
  ];
  for (const node of nodes) {
    if (!(node instanceof AstNode)) {
      // A spread tuple's first field declares the tuple's storage, which
      // the later fields read: its statements join this sequence, whose
      // frame lasts until every item is stored.
      let item = node;
      if (item.kind === "seqExpr") {
        body.push(...item.stmts);
        item = item.result;
      }
      const value = undefinedForNullish(lowerer, item, arrType);
      const stored =
        lowerer.runtimeOptionalWidening(value.type, elem) !== null ||
        optionalElementValue(lowerer, value, elem)
          ? value
          : lowerer.coerceToExpected(value, elem);
      body.push(arrayValueStore(lowerer, outRef, length(), stored, elem, loc));
    } else if (ts.isSpreadElement(node)) {
      let source = lowerer.lowerExpr(node.expression);
      if (
        source.type.kind === "set" &&
        identityPreservingWidening(lowerer, source.type.elem, elem)
      ) {
        source = {
          kind: "setIntrinsic",
          method: "toArray",
          receiver: source,
          args: [],
          type: arrayOf(source.type.elem),
          loc,
        };
      }
      if (source.type.kind === "record" && lowerer.shapes.get(source.type.shapeId)?.tuple) {
        source = lowerer.widthCoerce(source, arrType) ?? source;
      }
      if (
        !typeEquals(source.type, arrType) &&
        !(
          source.type.kind === "array" &&
          identityPreservingWidening(lowerer, source.type.elem, elem)
        )
      ) {
        // Fresh elements (an array literal) convert into the element layout.
        source = liftedFreshSpread(lowerer, node.expression, source, arrType, loc) ?? source;
      }
      // A checked-dynamic source, or any other iterable spread into
      // checked-dynamic items, drains once through the iterator protocol
      // (with the spread call's TypeErrors), and its elements convert to
      // the element type.
      const drains =
        source.type.kind === "dyn"
          ? elem.kind === "dyn" ||
            elem.kind === "f64" ||
            elem.kind === "string" ||
            elem.kind === "bool"
          : elem.kind === "dyn" &&
            !typeEquals(source.type, arrType) &&
            !(
              source.type.kind === "array" &&
              identityPreservingWidening(lowerer, source.type.elem, elem)
            ) &&
            canConvertToDyn(
              source.type,
              (id) => lowerer.shapes.get(id),
              (id) => lowerer.unions.get(id),
            );
      if (drains) {
        const spelling = ts.getTextOfNode(node.expression);
        const items = checkedIterableSpread(lowerer, source, spelling, loc);
        source = lowerer.coerceInto(node.expression, items, arrType);
      }
      if (!typeEquals(source.type, arrType)) {
        if (
          source.type.kind !== "array" ||
          !identityPreservingWidening(lowerer, source.type.elem, elem)
        ) {
          lowerer.noLowering(`Array insertion spread from '${lowerer.fmt(source.type)}'`, node);
        }
        body.push({
          kind: "exprStmt",
          expr: appendWidenedArrayValues(lowerer, outRef, source, elem, loc),
          loc,
        });
        continue;
      }
      body.push({
        kind: "exprStmt",
        expr: {
          kind: "arrIntrinsic",
          method: "pushSpread",
          receiver: outRef,
          args: [source],
          type: F64,
          loc,
        },
        loc,
      });
    } else {
      const value = lowerer.lowerExpr(node);
      const stored =
        lowerer.runtimeOptionalWidening(value.type, elem) !== null ||
        optionalElementValue(lowerer, value, elem)
          ? value
          : lowerer.coerceInto(node, value, elem);
      body.push(arrayValueStore(lowerer, outRef, length(), stored, elem, loc));
    }
  }
  return { kind: "seqExpr", stmts: body, result: outRef, type: arrType, loc };
}

/** Collect an already-lowered single spread without lowering its source twice. */
export function widenArraySpread(
  lowerer: Lowerer,
  source: IrExpr,
  elem: IrType,
  loc: SrcLoc,
): IrExpr {
  const type = arrayOf(elem);
  const out = lowerer.declareHiddenLocal("%arrayItems", type);
  const result = varRef(out.id, type, loc);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: out.id, init: { kind: "arrayLit", elems: [], type, loc }, loc },
      { kind: "exprStmt", expr: appendWidenedArrayValues(lowerer, result, source, elem, loc), loc },
    ],
    result,
    type,
    loc,
  };
}

/** Spreading observes holes as undefined and snapshots values before later
 * arguments can mutate the source. Only the copied elements are widened. */
function appendWidenedArrayValues(
  lowerer: Lowerer,
  target: IrExpr,
  source: IrExpr,
  elem: IrType,
  loc: SrcLoc,
): IrExpr {
  if (source.type.kind !== "array")
    throw new InternalCompilerError("array spread source is not an array");
  const sourceType = source.type;
  const key = `insertValues:${typeKey(sourceType.elem)}:${typeKey(elem)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%arr.insertValues", key);
    lowerer.arrHofHelpers.set(key, name);
    const outType = arrayOf(elem);
    const valueType = arrayValueType(lowerer, source.type.elem);
    const out = varRef("out.0", outType, loc);
    const input = varRef("source.0", source.type, loc);
    const value = varRef("value.0", valueType, loc);
    const length = (array: IrExpr): IrExpr => ({
      kind: "arrIntrinsic",
      method: "length",
      receiver: array,
      args: [],
      type: F64,
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "out.0", name: "out", type: outType },
        { localId: "source.0", name: "source", type: source.type },
      ],
      locals: [
        { id: "out.0", name: "out", type: outType, mutable: false },
        { id: "source.0", name: "source", type: source.type, mutable: false },
        { id: "value.0", name: "value", type: valueType, mutable: false },
        { id: "n.0", name: "count", type: F64, mutable: false },
        { id: "i.0", name: "index", type: F64, mutable: true },
      ],
      returnType: F64,
      body: [
        { kind: "varDecl", localId: "n.0", init: length(input), loc },
        countedFor(loc, varRef("n.0", F64, loc), (index) => [
          {
            kind: "varDecl",
            localId: "value.0",
            init: arrayValueRead(lowerer, input, index, sourceType.elem, loc),
            loc,
          },
          arrayValueStore(lowerer, out, length(out), value, elem, loc),
        ]),
        { kind: "return", value: length(out), loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [target, source], type: F64, loc };
}

/** The Array constructor's element and count forms, shared by calls and new. */
/** The value of `.fill(v)` when `expr` is that call's receiver. */
function fillArgumentOfReceiver(expr: ts.Expression): ts.Expression | null {
  let receiver: ts.Node = expr;
  let parent = expr.parent;
  while (ts.isParenthesizedExpression(parent)) {
    receiver = parent;
    parent = parent.parent;
  }
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== receiver) return null;
  if (parent.name.text !== "fill" || parent.questionDotToken) return null;
  const call = parent.parent;
  if (!ts.isCallExpression(call) || call.expression !== parent) return null;
  const value = call.arguments.nodes[0];
  return value !== undefined && !ts.isSpreadElement(value) ? value : null;
}

export function lowerArrayConstructor(
  lowerer: Lowerer,
  expr: ts.CallExpression | ts.NewExpression,
  args: readonly ts.Expression[],
): IrExpr {
  const loc = locOf(expr);
  if (args.some(ts.isSpreadElement)) {
    lowerer.noLowering("Array constructor with spread arguments", expr);
  }
  let result = lowerer.mapTypeOf(lowerer.typeOf(expr));
  // Constructors without a concrete element layout keep their checked
  // reference. Known element forms retain native arrays, including their
  // existing sparse storage and indexed property contracts.
  if (
    isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    (result?.kind !== "array" || result.elem.kind === "dyn")
  ) {
    return {
      kind: "dynCall",
      callee: { kind: "libCall", fn: "dyn.arrayConstructor", args: [], type: DYN, loc },
      calleeName: "Array",
      args: args.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
      type: DYN,
      loc,
    };
  }
  if (result?.kind !== "array") {
    const contextual = lowerer.checker.getContextualType(expr);
    if (contextual) result = lowerer.mapTypeOf(contextual);
  }
  // `Array(n).fill(v)`: the checker types the length-constructed array as
  // any[], but fill gives every element v's type.
  if (result?.kind !== "array") {
    const fillValue = fillArgumentOfReceiver(expr);
    const elem = fillValue
      ? lowerer.mapTypeOf(lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(fillValue)))
      : null;
    if (elem !== null && isSupportedArrayElem(elem)) result = arrayOf(elem);
  }
  if (isJsSourceFile(ts.getSourceFileOfNode(expr)) && (result === null || result.kind === "dyn"))
    result = arrayOf(DYN);
  if (result?.kind !== "array" || !isSupportedArrayElem(result.elem)) {
    lowerer.badType(expr, lowerer.typeOf(expr));
  }
  const argType = args.length === 1 ? lowerer.mapTypeOf(lowerer.typeOf(args[0]!)) : null;
  if (
    args.length === 1 &&
    result.elem.kind === "dyn" &&
    (argType === null || argType.kind === "dyn")
  ) {
    const input = lowerer.declareHiddenLocal("%arrayCtorValue", DYN);
    const value = varRef(input.id, DYN, loc);
    const local = lowerer.declareHiddenLocal("%arrayCtor", result);
    const array = varRef(local.id, result, loc);
    return {
      kind: "seqExpr",
      stmts: [
        {
          kind: "varDecl",
          localId: input.id,
          init: lowerer.lowerExprExpecting(args[0]!, DYN),
          loc,
        },
        {
          kind: "varDecl",
          localId: local.id,
          init: { kind: "arrayLit", elems: [], type: result, loc },
          loc,
        },
        {
          kind: "if",
          cond: { kind: "dynTest", test: "number", value, type: BOOL, loc },
          then: [
            {
              kind: "arraySetLength",
              arr: array,
              length: { kind: "dynCheck", value, type: F64, loc },
              loc,
            },
          ],
          else_: [arrayValueStore(lowerer, array, numLit(0, loc), value, DYN, loc)],
          loc,
        },
      ],
      result: array,
      type: result,
      loc,
    };
  }
  if (argType?.kind === "dyn") {
    lowerer.noLowering("Array constructor with a dynamically typed sole argument", args[0]!);
  }
  if (
    args.length === 1 &&
    (argType?.kind === "f64" ||
      (argType?.kind === "union" && lowerer.armTag(argType.unionId, F64) >= 0))
  ) {
    const count = lowerer.lowerExpr(args[0]!);
    const numberTag = count.type.kind === "union" ? lowerer.armTag(count.type.unionId, F64) : -1;
    if (count.type.kind !== "f64" && numberTag < 0) {
      lowerer.noLowering("Array constructor length with a value that may be missing", args[0]!);
    }
    const input =
      count.type.kind === "union" ? lowerer.declareHiddenLocal("%arrayCtorArg", count.type) : null;
    const inputRef = input ? varRef(input.id, count.type, loc) : null;
    const local = lowerer.declareHiddenLocal("%arrayLengthCtor", result);
    const ref = varRef(local.id, result, loc);
    const length: IrExpr =
      inputRef && count.type.kind === "union"
        ? {
            kind: "unionNarrow",
            unionId: count.type.unionId,
            tag: numberTag,
            value: inputRef,
            type: F64,
            loc,
          }
        : count;
    const resize: IrStmt = { kind: "arraySetLength", arr: ref, length, loc };
    return {
      kind: "seqExpr",
      stmts: [
        ...(input ? [{ kind: "varDecl" as const, localId: input.id, init: count, loc }] : []),
        {
          kind: "varDecl",
          localId: local.id,
          init: { kind: "arrayLit", elems: [], type: result, loc },
          loc,
        },
        ...(inputRef && count.type.kind === "union"
          ? [
              {
                kind: "if" as const,
                cond: {
                  kind: "unionIsTag" as const,
                  unionId: count.type.unionId,
                  tag: numberTag,
                  value: inputRef,
                  negated: false,
                  type: BOOL,
                  loc,
                },
                then: [resize],
                else_: [
                  arrayValueStore(
                    lowerer,
                    ref,
                    numLit(0, loc),
                    lowerer.coerceInto(args[0]!, inputRef, result.elem),
                    result.elem,
                    loc,
                  ),
                ],
                loc,
              },
            ]
          : [resize]),
      ],
      result: ref,
      type: result,
      loc,
    };
  }
  return {
    kind: "arrayLit",
    elems: args.map((arg) => lowerer.lowerExprExpecting(arg, result.elem)),
    type: result,
    loc,
  };
}

/** `Array.of` creates an array of its arguments, including a lone number. */
export function lowerArrayOfCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  /** The receiver is a class declared `extends Array` (array-classes.ts
   * constructs the result through it). */
  arrayClassReceiver = false,
): IrExpr | null {
  if (
    call.questionDotToken ||
    access.questionDotToken ||
    access.name.text !== "of" ||
    (!arrayClassReceiver && !lowerer.isStdlibGlobal(access.expression, "Array"))
  )
    return null;
  let result = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (result?.kind !== "array") {
    const contextual = lowerer.checker.getContextualType(call);
    if (contextual) result = lowerer.mapTypeOf(contextual);
  }
  if (result?.kind !== "array" || !isSupportedArrayElem(result.elem)) {
    lowerer.badType(call, lowerer.typeOf(call));
  }
  if (call.arguments.nodes.some(ts.isSpreadElement)) {
    return lowerArraySpreadItems(lowerer, call.arguments.nodes, result.elem, result, locOf(call));
  }
  // A `(T | undefined)[]` (primitiveElement) stores undefined arguments as
  // present undefined elements.
  if (result.optionalElements === true) {
    const nodes = call.arguments.nodes;
    const values = nodes.map((arg) => lowerer.lowerExpr(arg));
    if (values.some((value) => optionalElementValue(lowerer, value, result.elem)))
      return lowerArrayValueItems(lowerer, values, result.elem, result, locOf(call));
    return {
      kind: "arrayLit",
      elems: values.map((value, i) => lowerer.coerceInto(nodes[i]!, value, result.elem)),
      type: result,
      loc: locOf(call),
    };
  }
  return {
    kind: "arrayLit",
    elems: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, result.elem)),
    type: result,
    loc: locOf(call),
  };
}

/** Mapper-less checked Array.from: acquire once, then step through emitted
 * property and call dispatch so native class iterators retain their methods. */
export function lowerCheckedArrayFrom(
  lowerer: Lowerer,
  source: IrExpr,
  loc: SrcLoc,
  mapper?: IrExpr,
  receiver?: IrExpr,
  numeric = false,
  iterable?: IrExpr,
): Extract<IrExpr, { kind: "seqExpr" }> {
  const iterator = lowerer.declareHiddenLocal("%fromIterator", DYN);
  const next = lowerer.declareHiddenLocal("%fromNext", DYN);
  const value = lowerer.declareHiddenLocal("%fromValue", DYN);
  const fast = lowerer.declareHiddenLocal("%fromNative", BOOL);
  const out = lowerer.declareHiddenLocal("%fromArray", DYN);
  const done = lowerer.declareHiddenLocal("%fromDone", BOOL);
  done.mutable = true;
  const index = mapper ? lowerer.declareHiddenLocal("%fromIndex", F64) : null;
  if (index) index.mutable = true;
  const get = (value: IrExpr, key: string): IrExpr => ({
    kind: "dynKeyGet",
    value,
    key: strLit(key, loc),
    type: DYN,
    loc,
  });
  const item = varRef(value.id, DYN, loc);
  const mapped: IrExpr =
    mapper && index
      ? {
          kind: "ternary",
          cond: { kind: "dynTest", test: "undefined", value: mapper, type: BOOL, loc },
          then: item,
          else_: {
            kind: "dynCall",
            callee: mapper,
            ...(receiver ? { receiver } : {}),
            calleeName: "Array.from mapper",
            args: [item, lowerer.coerceToExpected(varRef(index.id, F64, loc), DYN)],
            type: DYN,
            loc,
          },
          type: DYN,
          loc,
        }
      : item;
  const element = numeric
    ? lowerer.coerceToExpected(
        { kind: "libCall", fn: "dyn.toNumberCoerce", args: [mapped], type: F64, loc },
        DYN,
      )
    : mapped;
  let append: IrStmt = {
    kind: "exprStmt",
    expr: {
      kind: "dynInvoke",
      recv: varRef(out.id, DYN, loc),
      method: "push",
      calleeName: "Array.from",
      args: [element],
      type: DYN,
      loc,
    },
    loc,
  };
  if (mapper) {
    const error = lowerer.declareHiddenLocal("%fromError", CAUGHT);
    const close = lowerer.declareHiddenLocal("%fromReturn", DYN);
    append = {
      kind: "tryCatch",
      tryBody: [append],
      catchLocalId: error.id,
      finallyBody: null,
      loc,
      catchBody: [
        {
          kind: "tryCatch",
          catchLocalId: null,
          catchBody: [],
          finallyBody: null,
          loc,
          tryBody: [
            {
              kind: "varDecl",
              localId: close.id,
              init: get(varRef(iterator.id, DYN, loc), "return"),
              loc,
            },
            {
              kind: "if",
              cond: {
                kind: "dynTest",
                test: "function",
                value: varRef(close.id, DYN, loc),
                type: BOOL,
                loc,
              },
              then: [
                {
                  kind: "exprStmt",
                  expr: {
                    kind: "dynCall",
                    callee: varRef(close.id, DYN, loc),
                    receiver: varRef(iterator.id, DYN, loc),
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
        },
        { kind: "rethrow", localId: error.id, loc },
      ],
    };
  }
  const stmts: IrStmt[] = [
    ...(mapper
      ? [
          {
            kind: "if" as const,
            cond: {
              kind: "dynTest" as const,
              test: "undefined" as const,
              value: mapper,
              type: BOOL,
              loc,
            },
            then: [],
            else_: [
              {
                kind: "if" as const,
                cond: {
                  kind: "dynTest" as const,
                  test: "function" as const,
                  value: mapper,
                  type: BOOL,
                  loc,
                },
                then: [],
                else_: [
                  {
                    kind: "exprStmt" as const,
                    expr: nodeThrowExpr(1, "", "Array.from mapper is not a function", DYN, loc),
                    loc,
                  },
                ],
                loc,
              },
            ],
            loc,
          },
        ]
      : []),
    {
      kind: "varDecl",
      localId: iterator.id,
      init: {
        kind: "libCall",
        fn: "dyn.iteratorResult",
        args: [
          {
            kind: "libCall",
            fn: iterable ? "dyn.iterator" : "dyn.arrayFromIterator",
            args: iterable ? [source, iterable] : [source],
            type: DYN,
            loc,
          },
        ],
        type: DYN,
        loc,
      },
      loc,
    },
    { kind: "varDecl", localId: next.id, init: get(varRef(iterator.id, DYN, loc), "next"), loc },
    {
      kind: "varDecl",
      localId: fast.id,
      init: iteratorCanStep(varRef(iterator.id, DYN, loc), varRef(next.id, DYN, loc), loc),
      loc,
    },
    {
      kind: "varDecl",
      localId: out.id,
      init: { kind: "dynArrLit", elems: [], type: DYN, loc },
      loc,
    },
    { kind: "varDecl", localId: done.id, init: boolLit(false, loc), loc },
    ...(index ? [{ kind: "varDecl" as const, localId: index.id, init: numLit(0, loc), loc }] : []),
    {
      kind: "while",
      cond: { kind: "unary", op: "!", operand: varRef(done.id, BOOL, loc), type: BOOL, loc },
      body: [
        {
          kind: "varDecl",
          localId: value.id,
          init: iteratorValue(
            lowerer,
            varRef(iterator.id, DYN, loc),
            varRef(next.id, DYN, loc),
            varRef(fast.id, BOOL, loc),
            done,
            loc,
            "iterator.next",
          ),
          loc,
        },
        {
          kind: "if",
          cond: { kind: "unary", op: "!", operand: varRef(done.id, BOOL, loc), type: BOOL, loc },
          then: [
            append,
            ...(index
              ? [
                  {
                    kind: "assign" as const,
                    localId: index.id,
                    value: {
                      kind: "bin" as const,
                      op: "+" as const,
                      left: varRef(index.id, F64, loc),
                      right: numLit(1, loc),
                      type: F64,
                      loc,
                    },
                    loc,
                  },
                ]
              : []),
          ],
          else_: null,
          loc,
        },
      ],
      loc,
    },
  ];
  return { kind: "seqExpr", stmts, result: varRef(out.id, DYN, loc), type: DYN, loc };
}

export function lowerArrayFromValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const name = "%builtin.Array.from";
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const context = newFnCtx(false, null, null, DYN);
    lowerer.fnStack.push(context);
    try {
      const params = ["source", "options"].map((name) => {
        const local = lowerer.declareHiddenLocal(name, DYN);
        return { localId: local.id, name, type: DYN };
      });
      const [source, options] = params.map((p) => varRef(p.localId, DYN, loc));
      const argument = (index: string): IrExpr => ({
        kind: "dynKeyGet",
        value: options!,
        key: strLit(index, loc),
        type: DYN,
        loc,
      });
      const value = lowerCheckedArrayFrom(lowerer, source!, loc, argument("0"), argument("1"));
      const constructorCheck: IrStmt = {
        kind: "if",
        cond: {
          kind: "dynTest",
          test: "function",
          value: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
          type: BOOL,
          loc,
        },
        then: [
          {
            kind: "runtimeFence",
            code: "SC2020",
            message: "Array.from with a custom constructor receiver is not supported",
            loc,
          },
        ],
        else_: null,
        loc,
      };
      lowerer.liftedFns.push({
        name,
        params,
        returnType: DYN,
        locals: context.locals,
        body: [constructorCheck, ...value.stmts, { kind: "return", value: value.result, loc }],
        loc,
      });
    } finally {
      lowerer.fnStack.pop();
    }
  }
  return {
    kind: "dynFrom",
    value: {
      kind: "closure",
      fnName: name,
      captures: [],
      type: { kind: "func", params: [DYN], ret: DYN, rest: true },
      loc,
    },
    fnName: "from",
    type: DYN,
    loc,
  };
}

/** `Array.from({ length: n }, mapfn)` — the counted-generation idiom — on
 * THE stdlib Array global. The source must be an OBJECT LITERAL whose
 * single property is `length` (the shape the idiom always spells; the
 * ArrayLike record never exists as a value). Desugars to an interned
 * synthetic loop calling the mapper with (undefined, i) exactly like JS —
 * the first argument is the dyn undefined singleton, matching the
 * checker's own `unknown` for it — and pushing each result. The loop
 * bound is `i <= n - 1`, which IS ToLength for the finite lengths that
 * terminate (fractional lengths truncate, negative/NaN produce an empty
 * array — Node-exact). Array inputs copy through the iterator's indexed
 * values, including holes as present undefined, and may map each value.
 * Map and Set inputs consume live values or entries and may map them.
 * Strings iterate by code point and may map.
 * Other iterable shapes keep the fence. Null when the callee isn't an
 * Array-static access. */
export function lowerArrayFromCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  /** The receiver is a class declared `extends Array` (array-classes.ts). */
  arrayClassReceiver = false,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!arrayClassReceiver && !lowerer.isStdlibGlobal(access.expression, "Array")) return null;
  if (access.name.text !== "from") return null;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if (
    isJsSourceFile(ts.getSourceFileOfNode(call)) &&
    args.length >= 1 &&
    args.length <= 3 &&
    !args.some(ts.isSpreadElement)
  ) {
    const name = "%builtin.Array.fromDirect";
    if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
      const context = newFnCtx(false, null, null, DYN);
      lowerer.fnStack.push(context);
      try {
        const params = ["source", "mapper", "receiver"].map((name) => {
          const local = lowerer.declareHiddenLocal(name, DYN);
          return { localId: local.id, name, type: DYN };
        });
        const refs = params.map((param) => varRef(param.localId, DYN, loc));
        const value = lowerCheckedArrayFrom(lowerer, refs[0]!, loc, refs[1], refs[2]);
        lowerer.liftedFns.push({
          name,
          params,
          returnType: DYN,
          locals: context.locals,
          body: [...value.stmts, { kind: "return", value: value.result, loc }],
          loc,
        });
      } finally {
        lowerer.fnStack.pop();
      }
    }
    return {
      kind: "call",
      callee: name,
      args: [0, 1, 2].map((i) =>
        args[i] ? lowerer.lowerExprExpecting(args[i]!, DYN) : dynUndefinedExpr(loc),
      ),
      type: DYN,
      loc,
    };
  }
  if ((args.length === 1 || args.length === 2) && !args.some(ts.isSpreadElement)) {
    const input = collectionInput(lowerer, args[0]!);
    if (input) {
      const source = lowerCollectionInput(lowerer, input);
      if (source) {
        if (args.length === 1) {
          requireProducedArrayElement(lowerer, call, "'Array.from(collection)'", input.element);
          return ingestCollection(
            lowerer,
            input,
            source,
            { kind: "array", elem: input.element },
            loc,
          );
        }
        const callback = lowerArrayCallback(
          lowerer,
          args[1]!,
          [input.element],
          arrayOf(input.element),
        );
        if (callback.arity > 2)
          lowerer.noLowering("Array.from mapper with an array parameter", args[1]!);
        if (callback.fnArg.type.ret.kind === "void" || callback.fnArg.type.ret.kind === "func")
          lowerer.badType(call, lowerer.typeOf(call));
        const element = callbackArrayElement(lowerer, call, callback.fnArg.type.ret);
        requireProducedArrayElement(lowerer, call, "'Array.from(collection, mapper)'", element);
        return ingestCollection(
          lowerer,
          input,
          source,
          { kind: "array", elem: element },
          loc,
          callback.fnArg,
        );
      }
    }
  }
  // MAPPER-LESS `Array.from({ length: n })` (usually with an explicit
  // type argument — the pMap results-array idiom): a length-n array of
  // ABSENT slots, filled by index before any read. Union elements with
  // an undefined arm hold the interned undefined (JS-exact); other
  // refcounted elements — record unions like PromiseSettledResult among
  // them — hold NULL and must be assigned before they are read
  // (SEMANTICS.md 46). Scalar elements have no absent value that isn't a
  // LIE on read (0 where Node says undefined) — fenced.
  if (
    args.length === 1 &&
    ts.isObjectLiteralExpression(args[0]!) &&
    args[0]!.properties.nodes.length === 1
  ) {
    const n = lowerLengthProp(lowerer, args[0]!.properties.nodes[0]!);
    if (n) {
      if (n.type.kind !== "f64") lowerer.badType(args[0]!, lowerer.typeOf(args[0]!));
      const arrT = lowerer.mapTypeOf(lowerer.typeOf(call));
      if (arrT?.kind !== "array") lowerer.badType(call, lowerer.typeOf(call));
      const elem = arrT.elem;
      // A `(T | undefined)[]` (primitiveElement): n present undefined
      // elements.
      const elemTs = lowerer.checker.isArrayType(lowerer.typeOf(call))
        ? lowerer.checker.getTypeArguments(lowerer.typeOf(call) as ts.TypeReference)[0]
        : undefined;
      if (
        primitiveElement(elem) &&
        elemTs !== undefined &&
        (elemTs.isUnionType() ? ts.constituentTypes(elemTs) : [elemTs]).some(
          (part) => (part.flags & ts.TypeFlags.Undefined) !== 0,
        )
      ) {
        return {
          kind: "arrIntrinsic",
          method: "fillUndefined",
          receiver: { kind: "arrayNewLen", length: n, type: arrT, loc },
          // To the end: fill clamps an infinite end to the length.
          args: [
            numLit(0, loc),
            { kind: "bin", op: "/", left: numLit(1, loc), right: numLit(0, loc), type: F64, loc },
          ],
          type: arrT,
          loc,
        };
      }
      const absent =
        elem.kind === "union"
          ? lowerer.wrappedUndefined(elem, loc) !== null ||
            (lowerer.unions.get(elem.unionId)?.arms ?? []).every((arm) => arm.kind === "record")
          : isRefCounted(elem);
      if (!absent) {
        lowerer.noLowering(
          `mapper-less Array.from({ length: n }) with '${lowerer.fmt(elem)}' elements`,
          call,
          'scalar slots would read 0/false/"" where Node reads undefined — ' +
            "pass a mapper (Array.from({ length: n }, () => init)) instead",
        );
      }
      return { kind: "arrayNewLen", length: n, type: arrT, loc };
    }
  }
  // Array iteration reads length again after every mapper call. Without
  // a mapper, a dense reversed copy followed by reversal preserves order
  // and materializes holes while keeping element reference identity.
  if ((args.length === 1 || args.length === 2) && !ts.isObjectLiteralExpression(args[0]!)) {
    const source = lowerer.lowerExpr(args[0]!);
    let src =
      source.type.kind === "string" && args.length === 2 ? strCharsCall(source, loc) : source;
    if (src.type.kind === "array") {
      const arrT = src.type;
      if (args.length === 1) {
        const dense: IrExpr = {
          kind: "arrIntrinsic",
          method: "toReversed",
          receiver: src,
          args: [],
          type: arrT,
          loc,
        };
        return {
          kind: "arrIntrinsic",
          method: "reverse",
          receiver: dense,
          args: [],
          type: arrT,
          loc,
        };
      }
      const mapper = args[1]!;
      const valueT = arrayValueType(lowerer, arrT.elem);
      const firstParam =
        ts.isArrowFunction(mapper) || ts.isFunctionExpression(mapper)
          ? mapper.parameters.nodes[0]?.name
          : undefined;
      const paramSymbol =
        firstParam && ts.isIdentifier(firstParam)
          ? lowerer.checker.getSymbolAtLocation(firstParam)
          : undefined;
      const previous = paramSymbol
        ? lowerer.runtimeOptionalBindingTypes.get(paramSymbol)
        : undefined;
      if (paramSymbol) lowerer.runtimeOptionalBindingTypes.set(paramSymbol, valueT);
      let callback: ReturnType<typeof lowerArrayCallback>;
      try {
        callback = lowerArrayCallback(lowerer, mapper, [valueT], arrT);
      } finally {
        if (paramSymbol) {
          if (previous === undefined) lowerer.runtimeOptionalBindingTypes.delete(paramSymbol);
          else lowerer.runtimeOptionalBindingTypes.set(paramSymbol, previous);
        }
      }
      const { fnArg, arity } = callback;
      if (arity > 2) lowerer.noLowering("Array.from mapper with an array parameter", args[1]!);
      const fnRet = fnArg.type.ret;
      if (fnRet.kind === "void" || fnRet.kind === "func")
        lowerer.badType(call, lowerer.typeOf(call));
      requireProducedArrayElement(lowerer, call, "'Array.from(array, mapper)'", fnRet);
      const outElem = callbackArrayElement(lowerer, call, fnRet);
      const key = `fromArray:${typeKey(arrT.elem)}:${typeKey(outElem)}:${typeKey(fnRet)}:${arity}`;
      let helper = lowerer.arrHofHelpers.get(key);
      if (!helper) {
        helper = keyedHelperName(lowerer, "%arr.fromArray", key);
        lowerer.arrHofHelpers.set(key, helper);
        lowerer.liftedFns.push(
          buildArrayFromArrayFn(lowerer, helper, arrT.elem, outElem, fnRet, arity, loc),
        );
      }
      return { kind: "call", callee: helper, args: [src, fnArg], type: arrayOf(outElem), loc };
    }
    if (src.type.kind === "bytes" && args.length === 1) {
      return {
        kind: "bytesIntrinsic",
        method: "toArray",
        receiver: src,
        args: [],
        type: arrayOf(F64),
        loc,
      };
    }
    // A union of typed arrays and number arrays (indexed-unions.ts).
    const indexedArms = indexedUnionArms(lowerer, src.type);
    if (indexedArms && args.length === 1)
      return lowerIndexedUnionToArray(lowerer, src, indexedArms, loc, true);
    if (src.type.kind === "set" && args.length === 1) {
      return {
        kind: "setIntrinsic",
        method: "toArray",
        receiver: src,
        args: [],
        type: arrayOf(src.type.elem),
        loc,
      };
    }
    // String iteration advances by code point; the same helper serves
    // `[...s]` and both Array.from(s) forms.
    if (src.type.kind === "string" && args.length === 1) return strCharsCall(src, loc);
    if (src.type.kind === "dyn" && args.length === 1) {
      return lowerCheckedArrayFrom(lowerer, src, loc);
    }
    // Array.from(sp): the checked-dynamic view's live pair iteration.
    if (src.type.kind === "searchParams" && args.length === 1) {
      return lowerCheckedArrayFrom(lowerer, lowerer.coerceInto(args[0]!, src, DYN), loc);
    }
    // A class whose [Symbol.iterator] is a generator method iterates the
    // generator that method returns.
    src = classGeneratorIterable(lowerer, src) ?? src;
    // A generator (or an iterator adapted into one) drains in order.
    if (src.type.kind === "generator" && args.length === 1) {
      const arrT = lowerer.mapTypeOf(lowerer.typeOf(call));
      const drained =
        arrT?.kind === "array"
          ? generatorDrain(lowerer, src, arrT.elem, loc, arrT.optionalElements === true)
          : null;
      if (drained) return drained;
    }
    lowerer.noLowering(
      "Array.from with this argument shape",
      call,
      "Array.from(array), Array.from(array, mapper), Array.from(aString), Array.from(aString, mapper), and Array.from({ length: n }, mapper) are the lowered forms",
    );
  }
  const n =
    args.length === 2 &&
    ts.isObjectLiteralExpression(args[0]!) &&
    args[0]!.properties.nodes.length === 1
      ? lowerLengthProp(lowerer, args[0]!.properties.nodes[0]!)
      : null;
  if (!n) {
    lowerer.noLowering(
      "Array.from with this argument shape",
      call,
      "Array.from(array), Array.from(array, mapper), Array.from(aString), Array.from(aString, mapper), and Array.from({ length: n }, mapper) are the lowered forms",
    );
  }
  if (n.type.kind !== "f64") lowerer.badType(args[0]!, lowerer.typeOf(args[0]!));
  const fnArg = lowerer.lowerExpr(args[1]!);
  // The mapper may declare any prefix of (v, i): v is the checker's own
  // `unknown` (Node passes undefined there — the dyn undefined singleton
  // here), i the index. The result type must be a legal array element.
  if (
    fnArg.type.kind !== "func" ||
    fnArg.type.params.length > 2 ||
    (fnArg.type.params.length >= 1 && fnArg.type.params[0]!.kind !== "dyn") ||
    (fnArg.type.params.length === 2 && fnArg.type.params[1]!.kind !== "f64")
  ) {
    lowerer.badType(args[1]!, lowerer.typeOf(args[1]!));
  }
  const fnT = fnArg.type as IrType & { kind: "func" };
  const fnRet = fnT.ret;
  if (fnRet.kind === "void" || fnRet.kind === "func") lowerer.badType(call, lowerer.typeOf(call));
  requireProducedArrayElement(lowerer, call, "'Array.from({ length }, mapper)'", fnRet);
  const arity = fnT.params.length;
  const key = `fromLen:${typeKey(fnRet)}:${arity}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%arr.fromLen", key);
    lowerer.arrHofHelpers.set(key, helper);
    lowerer.liftedFns.push(buildArrayFromLenFn(helper, fnRet, arity, loc));
  }
  return { kind: "call", callee: helper, args: [n, fnArg], type: arrayOf(fnRet), loc };
}

/** Map an array iterator to a fresh dense array. The source length remains
 * live so mapper mutations affect which later indexes are visited. */
function buildArrayFromArrayFn(
  lowerer: Lowerer,
  name: string,
  elem: IrType,
  outElem: IrType,
  fnRet: IrType,
  arity: number,
  loc: SrcLoc,
): IrFunction {
  const arrT = arrayOf(elem);
  const outT = arrayOf(outElem);
  const fnT = funcOf([arrayValueType(lowerer, elem), F64].slice(0, arity), fnRet);
  const a = varRef("a.0", arrT, loc);
  const i = varRef("i.0", F64, loc);
  const out = varRef("out.0", outT, loc);
  const mapped: IrExpr = {
    kind: "callValue",
    callee: varRef("f.0", fnT, loc),
    args: [arrayValueRead(lowerer, a, i, elem, loc), i].slice(0, arity),
    type: fnRet,
    loc,
  };
  // A result of another type than the element (`T | undefined` into a
  // `(T | undefined)[]`, which stores T elements) is held in a local, so
  // the store tests and converts one value.
  const held = !typeEquals(fnRet, outElem);
  const value: IrExpr = held ? varRef("v.0", fnRet, loc) : mapped;
  return {
    name,
    params: [
      { localId: "a.0", name: "a", type: arrT },
      { localId: "f.0", name: "f", type: fnT },
    ],
    returnType: outT,
    locals: [
      { id: "a.0", name: "a", type: arrT, mutable: true },
      { id: "f.0", name: "f", type: fnT, mutable: true },
      { id: "out.0", name: "out", type: outT, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
      ...(held ? [{ id: "v.0", name: "v", type: fnRet, mutable: false }] : []),
    ],
    body: [
      {
        kind: "varDecl",
        localId: "out.0",
        init: { kind: "arrayLit", elems: [], type: outT, loc },
        loc,
      },
      { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
      {
        kind: "while",
        cond: {
          kind: "bin",
          op: "<",
          left: i,
          right: { kind: "arrIntrinsic", method: "length", receiver: a, args: [], type: F64, loc },
          type: BOOL,
          loc,
        },
        body: [
          ...(held ? [{ kind: "varDecl", localId: "v.0", init: mapped, loc } as const] : []),
          arrayValueStore(lowerer, out, i, value, outElem, loc),
          {
            kind: "assign",
            localId: "i.0",
            value: { kind: "bin", op: "+", left: i, right: numLit(1, loc), type: F64, loc },
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: out, loc },
    ],
    loc,
  };
}

/** `Array.from(s)` / `[...s]` on a STRING: the code-point split into a
 * fresh string[] (scr_str_code_points). */
export function strCharsCall(src: IrExpr, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "str.codePoints", args: [src], type: arrayOf(STRING), loc };
}

/** The lowered `length` value of the one-property source literal, or null
 * (shorthand `{ length }` counts — resolved through the shorthand VALUE
 * symbol like any object literal; spreads/accessors/computed names do
 * not). */
function lowerLengthProp(lowerer: Lowerer, prop: ts.ObjectLiteralElementLike): IrExpr | null {
  if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "length") {
    return lowerer.lowerExprExpecting(prop.initializer, F64);
  }
  if (ts.isShorthandPropertyAssignment(prop) && (prop.name as ts.Identifier).text === "length") {
    return lowerer.lowerShorthandValue(prop);
  }
  return null;
}

/** The generation loop, from existing IR nodes:
 *
 *   out = [];
 *   for (i = 0; i <= n - 1; i++) out.push(f(undefined, i));
 *   return out;
 */
function buildArrayFromLenFn(name: string, fnRet: IrType, arity: number, loc: SrcLoc): IrFunction {
  const outT = arrayOf(fnRet);
  const fnT = funcOf([DYN, F64].slice(0, arity), fnRet);

  const undef: IrExpr = dynUndefinedExpr(loc);
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "out.0",
      init: { kind: "arrayLit", elems: [], type: outT, loc },
      loc,
    },
    countedFor(
      loc,
      { kind: "libCall", fn: "math.floor", args: [varRef("n.0", F64, loc)], type: F64, loc },
      () => [
        {
          kind: "exprStmt",
          expr: {
            kind: "arrIntrinsic",
            method: "push",
            receiver: varRef("out.0", outT, loc),
            args: [
              {
                kind: "callValue",
                callee: varRef("f.0", fnT, loc),
                args: [undef, varRef("i.0", F64, loc)].slice(0, arity),
                type: fnRet,
                loc,
              },
            ],
            type: F64,
            loc,
          },
          loc,
        },
      ],
    ),
    { kind: "return", value: varRef("out.0", outT, loc), loc },
  ];
  return {
    name,
    params: [
      { localId: "n.0", name: "n", type: F64 },
      { localId: "f.0", name: "f", type: fnT },
    ],
    returnType: outT,
    locals: [
      { id: "n.0", name: "n", type: F64, mutable: true },
      { id: "f.0", name: "f", type: fnT, mutable: true },
      { id: "out.0", name: "out", type: outT, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
    ],
    body,
    loc,
  };
}
