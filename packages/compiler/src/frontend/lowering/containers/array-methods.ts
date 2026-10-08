import { identityPreservingWidening } from "../coercions/identity.js";
import { arrayConcatHelper } from "./array-concat.js";
import { boolLit, countedFor, numLit, strLit, varRef } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  JSVAL,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  arrayOf,
  isRefCounted,
  isUnitType,
  typeEquals,
} from "../../../ir/ir.js";
import { ARRAY_METHODS } from "../surfaces.js";
import { tryLowerExpression } from "../expressions/try-lower-expression.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { islandPrimitiveExit, lowerDynDispatchMethodCall } from "../lower-calls.js";
import {
  arrayIndexPresent,
  arrayValueRead,
  arrayValueStore,
  arrayValueType,
} from "../array-values.js";
import { typeKey } from "../../type-mapper.js";
import {
  defaultAfterUndefined,
  lowerPositionArgument,
  lowerStaticallyUndefinedArgument,
  positionNumber,
} from "../optional-arguments.js";
import { lowerArrayCopyWithin, lowerArrayFill } from "../array-indexed-mutation.js";
import {
  lowerArrayUnionHofCall,
  lowerArraySortCall,
  lowerArrayHofCall,
  lowerArrayFindLikeCall,
  lowerArrayFlatMapCall,
  lowerArrayReduceCall,
} from "./array-callbacks.js";
import {
  lowerArraySpreadItems,
  lowerArrayValueItems,
  widenArraySpread,
} from "./array-construction.js";
import { arrayLengthDeclaration } from "./array-iteration.js";
import {
  lowerArrayCallback,
  callbackArrayElement,
  requireProducedArrayElement,
} from "./callback-arguments.js";

function primitivePositionType(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "union") {
    return (
      lowerer.unions.get(type.unionId)?.arms.every((arm) => primitivePositionType(lowerer, arm)) ??
      false
    );
  }
  return (
    type.kind === "f64" ||
    type.kind === "string" ||
    type.kind === "bool" ||
    type.kind === "nullT" ||
    type.kind === "undefinedT"
  );
}

function lowerArrayPosition(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  defaultValue: IrExpr,
  subject: string,
): IrExpr {
  if (!node) return defaultValue;
  if (ts.isSpreadElement(node)) lowerer.noLowering(`${subject} with a spread argument`, node);
  const value = lowerPositionArgument(lowerer, node, defaultValue);
  if (!primitivePositionType(lowerer, value.type)) {
    lowerer.noLowering(`${subject} of '${lowerer.fmt(value.type)}' values`, node);
  }
  const loc = locOf(node);
  const local = lowerer.declareHiddenLocal("%arrayPosition", value.type);
  const ref = varRef(local.id, value.type, loc);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
    result: positionNumber(lowerer, ref, defaultValue, node, subject),
    type: F64,
    loc,
  };
}

function lowerArrayJoinSeparator(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  loc: SrcLoc,
): IrExpr {
  const comma = strLit(",", loc);
  if (!node) return comma;
  const undefinedValue = lowerStaticallyUndefinedArgument(lowerer, node);
  if (undefinedValue) return defaultAfterUndefined(undefinedValue, comma);
  const value = lowerer.lowerExpr(node);
  if (value.type.kind === "nullT") return defaultAfterUndefined(value, strLit("null", loc));
  if (value.type.kind === "union") {
    const undefinedTag = lowerer.armTag(value.type.unionId, UNDEFINED_T);
    if (undefinedTag >= 0) {
      const local = lowerer.declareHiddenLocal("%joinSeparator", value.type);
      const ref = varRef(local.id, value.type, loc);
      return {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
        result: {
          kind: "ternary",
          cond: {
            kind: "unionIsTag",
            unionId: value.type.unionId,
            tag: undefinedTag,
            value: ref,
            negated: false,
            type: BOOL,
            loc,
          },
          then: comma,
          else_: lowerer.ensureString(ref, node),
          type: STRING,
          loc,
        },
        type: STRING,
        loc,
      };
    }
  }
  if (value.type.kind === "dyn" || value.type.kind === "jsval") {
    lowerer.noLowering(".join separator with a runtime-dependent undefined value", node);
  }
  return lowerer.ensureString(value, node);
}

/** Ambient array method calls. `push`/`unshift`/`pop`/`reverse`/
 * `indexOf`/`includes`/`join`
 * lower to arrIntrinsic; the HOF family — `map`/`filter`/`forEach`/
 * `find`/`some`/`every`/`flatMap`/`reduce`/`reduceRight` — desugars to a
 * direct call of a synthetic loop function (see lowerArrayHofCall and
 * friends). Null when this isn't an ambient array method call. tsc has
 * already checked arity and argument types against ambient/scriptc.d.ts. */
export function lowerArrayMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(access, call)) return null;
  const name = access.name.text;
  if (!ARRAY_METHODS.has(name) && name !== "sort" && name !== "shift" && name !== "splice")
    return null;
  let receiverIr = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  const checkerReceiver = lowerer.checker.getTypeAtLocation(access.expression);
  const implicitArrayReceiver =
    receiverIr?.kind === "array" &&
    (checkerReceiver.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ||
      lowerer.checkerAnyArrayType(checkerReceiver));
  // A checker-`any[]` receiver (the readonly-array Array.isArray quirk)
  // whose VALUE lowers to a real static array (maybeNarrow's isArray
  // bridge): ride the ordinary tables on the lowered element type — the
  // dyn-receiver string precedent (re-lowering is pure IR construction).
  // A checker-untyped receiver has no stdlib-declared member symbol, so
  // the isStdlibMember gate is skipped for probed receivers (nothing
  // user-declared can shadow a method on a value the checker calls any).
  let probedUntyped = false;
  if (implicitArrayReceiver) probedUntyped = true;
  if (
    (receiverIr === null ||
      receiverIr.kind === "dyn" ||
      (receiverIr.kind === "array" && receiverIr.elem.kind === "dyn")) &&
    (lowerer.checkerAnyArray(access.expression) ||
      // A checker-`any` CHAIN whose value lowers to a real static array
      // (`context.stack.split('\n').slice(2)` — the dyn-receiver string
      // machinery answered string[]): same rule, any-typed spelling.
      ((lowerer.typeOf(access.expression).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
        0 &&
        isJsSourceFile(access.getSourceFile())))
  ) {
    const probe = lowerer.lowerExpr(access.expression);
    if (probe.type.kind === "array") {
      receiverIr = probe.type;
      probedUntyped = true;
    }
  }
  if (receiverIr?.kind === "union") {
    const unionHof = lowerArrayUnionHofCall(lowerer, call, access, receiverIr);
    if (unionHof) return unionHof;
  }
  if (receiverIr?.kind !== "array") return null;
  if (!probedUntyped && !lowerer.isStdlibMember(access)) return null;
  let elem = receiverIr.elem;
  const loc = locOf(call);
  // An island handle behind an array-typed .d.ts surface
  // (`parts().join("-")` — arrays never exit eagerly, so the value
  // stays jsval): the ENGINE's own Array.prototype method runs on the
  // engine array — every declared call form (fromIndex, comparators
  // and HOF callbacks as marshaled host functions), Node-exact by
  // construction, with the declared-primitive result exit. Never a
  // static arrIntrinsic over a jsval (the validator ICE).
  {
    const receiver = lowerer.lowerExpr(access.expression);
    if (receiver.type.kind === "union") {
      const arms = lowerer.unions.get(receiver.type.unionId)?.arms;
      const present = arms?.find((arm): boolean => arm.kind === "array");
      if (
        present?.kind === "array" &&
        arms?.every((arm) => typeEquals(arm, present) || isUnitType(arm))
      ) {
        // A predicate can narrow the element type without changing the
        // original array layout. Extract that stored array before choosing
        // a helper, then adapt callback arguments at their actual ABI.
        const array =
          lowerer.runtimeOptionalPropertyReceiver(access.expression, receiver, present, name) ??
          lowerer.coerceInto(access.expression, receiver, present);
        return lowerer.withExpressionOverride(access.expression, array, () =>
          lowerArrayMethodCall(lowerer, call, access),
        );
      }
    }
    if (receiver.type.kind === "record" && lowerer.shapes.get(receiver.type.shapeId)?.tuple) {
      return lowerTupleReadMethodCall(lowerer, call, access, receiver);
    }
    if (receiver.type.kind === "jsval") {
      const loweredArgs = call.arguments.map((a) => lowerer.lowerExpr(a));
      if (
        name === "filter" &&
        loweredArgs[0]?.type.kind === "func" &&
        loweredArgs[0].type.ret.kind === "void"
      ) {
        lowerer.unsupported(
          "SC1090",
          call.arguments[0]!,
          "'.filter()' with a void-returning predicate (the callback return value is erased before its truthiness can be tested)",
        );
      }
      const args = loweredArgs.map((arg, i) => lowerer.jsvalIn(arg, call.arguments[i]!));
      const result: IrExpr = {
        kind: "jsOp",
        op: "callMethod",
        name,
        args: [receiver, ...args],
        type: JSVAL,
        loc,
      };
      return islandPrimitiveExit(lowerer, call, result);
    }
    // An array-mapped CHECKER type whose VALUE lives in the checked-dynamic tree
    // (`Object.keys(dynObj).sort()` — the key-walk answers a dyn array):
    // the record family's array sibling. Methods with a runtime
    // receiver-kind dispatch ride dynInvoke — the real method runs on
    // the dyn array, JS-exact; the rest keep an honest fence instead of
    // handing a static array intrinsic a dyn receiver (the validator
    // ICE). Consumers validate the dyn result where a static type is
    // required (dynCheck — the member-read discipline).
    if (receiver.type.kind === "dyn") {
      const dispatched = lowerDynDispatchMethodCall(lowerer, call, access, receiver, true);
      if (dispatched) return dispatched;
      lowerer.noLowering(
        `.${name} on an array value held in a checked-dynamic binding`,
        call,
        "assign it to an array-typed binding first (the validated extraction), then call the method",
      );
    }
    // Flow predicates and evolving-any analysis can refine the checker
    // element type without changing the array's storage. Helpers and
    // callback array arguments must retain the original layout and
    // identity; element conversions happen at the callback boundary.
    if (receiver.type.kind === "array" && !typeEquals(receiverIr, receiver.type)) {
      receiverIr = receiver.type;
      elem = receiver.type.elem;
    }
  }
  if (name === "sort" || name === "toSorted") {
    return lowerArraySortCall(lowerer, call, access, elem, receiverIr);
  }
  if (name === "toReversed") {
    if (call.arguments.length !== 0) {
      lowerer.noLowering(`.toReversed with ${call.arguments.length} arguments`, call);
    }
    return {
      kind: "arrIntrinsic",
      method: "toReversed",
      receiver: lowerer.lowerExpr(access.expression),
      args: [],
      type: receiverIr,
      loc,
    };
  }
  if (name === "reverse") {
    if (call.arguments.length !== 0) {
      lowerer.noLowering(`.reverse with ${call.arguments.length} arguments`, call);
    }
    return {
      kind: "arrIntrinsic",
      method: "reverse",
      receiver: lowerer.lowerExpr(access.expression),
      args: [],
      type: receiverIr,
      loc,
    };
  }
  if (name === "fill") {
    if (call.arguments.length > 3 || call.arguments.some(ts.isSpreadElement)) {
      lowerer.noLowering(`.fill with ${call.arguments.length} arguments`, call);
    }
    const value = call.arguments[0] ? lowerer.lowerExpr(call.arguments[0]) : null;
    if (
      value &&
      (value.type.kind === "dyn" || value.type.kind === "jsval") &&
      isRefCounted(elem) &&
      elem.kind !== "string" &&
      !typeEquals(value.type, elem)
    ) {
      lowerer.noLowering(
        ".fill of a checked-dynamic reference into a static array",
        call.arguments[0]!,
      );
    }
    const writeUndefined =
      value === null || value.type.kind === "undefinedT" || value.type.kind === "void";
    return lowerArrayFill(
      lowerer,
      lowerer.lowerExpr(access.expression),
      value,
      writeUndefined,
      lowerArrayPosition(lowerer, call.arguments[1], numLit(0, loc), "array fill start"),
      lowerArrayPosition(lowerer, call.arguments[2], numLit(Infinity, loc), "array fill end"),
      receiverIr,
      loc,
    );
  }
  if (name === "copyWithin") {
    if (call.arguments.length > 3 || call.arguments.some(ts.isSpreadElement)) {
      lowerer.noLowering(`.copyWithin with ${call.arguments.length} arguments`, call);
    }
    return lowerArrayCopyWithin(
      lowerer.lowerExpr(access.expression),
      lowerArrayPosition(lowerer, call.arguments[0], numLit(0, loc), "array copyWithin target"),
      lowerArrayPosition(lowerer, call.arguments[1], numLit(0, loc), "array copyWithin start"),
      lowerArrayPosition(lowerer, call.arguments[2], numLit(Infinity, loc), "array copyWithin end"),
      receiverIr,
      loc,
    );
  }
  if (name === "with") {
    if (call.arguments.length !== 2 || call.arguments.some(ts.isSpreadElement)) {
      lowerer.noLowering(`.with with ${call.arguments.length} arguments`, call);
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const index = lowerPositionArgument(lowerer, call.arguments[0]!, numLit(0, loc));
    if (!primitivePositionType(lowerer, index.type)) {
      lowerer.noLowering(`.with index of '${lowerer.fmt(index.type)}' values`, call.arguments[0]!);
    }
    const value = lowerer.lowerExpr(call.arguments[1]!);
    const receiverLocal = lowerer.declareHiddenLocal("%withRecv", receiverIr);
    const indexLocal = lowerer.declareHiddenLocal("%withIndex", index.type);
    const valueLocal = lowerer.declareHiddenLocal("%withValue", value.type);
    const receiverRef = varRef(receiverLocal.id, receiverIr, loc);
    const indexRef = varRef(indexLocal.id, index.type, loc);
    const valueRef = varRef(valueLocal.id, value.type, loc);
    const numericIndex = positionNumber(
      lowerer,
      indexRef,
      numLit(0, loc),
      call.arguments[0]!,
      "array with index",
    );
    const stmts: IrStmt[] = [
      { kind: "varDecl", localId: receiverLocal.id, init: receiver, loc },
      { kind: "varDecl", localId: indexLocal.id, init: index, loc },
      { kind: "varDecl", localId: valueLocal.id, init: value, loc },
    ];
    if (value.type.kind === "union" && lowerer.runtimeOptionalWidening(value.type, elem) !== null) {
      // `.with()` validates its index and returns a fresh copy. Stabilize
      // all three operands, then select the scalar replacement or the
      // present-undefined copy without evaluating a read twice.
      const unionId = value.type.unionId;
      const undefTag = lowerer.armTag(unionId, UNDEFINED_T);
      const condition: IrExpr = {
        kind: "unionIsTag",
        unionId,
        tag: undefTag,
        negated: false,
        value: valueRef,
        type: BOOL,
        loc,
      };
      const missing: IrExpr = {
        kind: "arrIntrinsic",
        method: "withUndefined",
        receiver: receiverRef,
        args: [numericIndex],
        type: receiverIr,
        loc,
      };
      const present: IrExpr = {
        kind: "arrIntrinsic",
        method: "with",
        receiver: receiverRef,
        args: [numericIndex, lowerer.coerceToExpected(valueRef, elem)],
        type: receiverIr,
        loc,
      };
      return {
        kind: "seqExpr",
        stmts,
        result: {
          kind: "ternary",
          cond: condition,
          then: missing,
          else_: present,
          type: receiverIr,
          loc,
        },
        type: receiverIr,
        loc,
      };
    }
    const coercedValue = lowerer.coerceInto(call.arguments[1]!, valueRef, elem);
    return {
      kind: "seqExpr",
      stmts,
      result: {
        kind: "arrIntrinsic",
        method: "with",
        receiver: receiverRef,
        args: [numericIndex, coercedValue],
        type: receiverIr,
        loc,
      },
      type: receiverIr,
      loc,
    };
  }
  if (name === "toSpliced") {
    const receiver = lowerer.lowerExpr(access.expression);
    const start = lowerArrayPosition(
      lowerer,
      call.arguments[0],
      numLit(0, loc),
      "array toSpliced start",
    );
    const deleteCount = lowerArrayPosition(
      lowerer,
      call.arguments[1],
      numLit(call.arguments.length === 1 ? Infinity : 0, loc),
      "array toSpliced deleteCount",
    );
    const itemNodes = call.arguments.slice(2);
    const hasSpread = itemNodes.some(ts.isSpreadElement);
    const itemProbes = hasSpread ? [] : itemNodes.map((arg) => tryLowerExpression(lowerer, arg));
    const statefulItems = itemProbes.some(
      (probe) => probe !== null && lowerer.runtimeOptionalWidening(probe.type, elem) !== null,
    );
    const items: IrExpr = hasSpread
      ? lowerArraySpreadItems(lowerer, itemNodes, elem, receiverIr, loc)
      : statefulItems
        ? lowerArrayValueItems(
            lowerer,
            itemNodes.map((arg) => lowerer.lowerExpr(arg)),
            elem,
            receiverIr,
            loc,
          )
        : {
            kind: "arrayLit",
            elems: itemNodes.map((arg) => lowerer.coerceInto(arg, lowerer.lowerExpr(arg), elem)),
            type: receiverIr,
            loc,
          };
    return {
      kind: "arrIntrinsic",
      method: "toSpliced",
      receiver,
      args: [start, deleteCount, items],
      type: receiverIr,
      loc,
    };
  }
  if (name === "flat") return lowerArrayFlatCall(lowerer, call, access, receiverIr);

  // The lib declares wider call forms than the lowered surface — the
  // predicate/mapping HOFs take a thisArg. Each unlowered form is fenced
  // per site (SC2020), never silently truncated to the supported
  // arguments. push/unshift lower every declared form (variadic, 0 args
  // included — Node returns the unchanged length); reduce/reduceRight
  // lower both declared forms (with and without an initial value).
  const arity = {
    push: [0, Number.MAX_SAFE_INTEGER],
    unshift: [0, Number.MAX_SAFE_INTEGER],
    pop: [0, 0],
    indexOf: [1, 2],
    lastIndexOf: [1, 2],
    includes: [0, 2],
    join: [0, 1],
    concat: [0, Number.MAX_SAFE_INTEGER],
    slice: [0, 2],
    shift: [0, 0],
    splice: [0, Number.MAX_SAFE_INTEGER],
    at: [0, 1],
    map: [1, 1],
    filter: [1, 1],
    forEach: [1, 1],
    find: [1, 1],
    findIndex: [1, 1],
    some: [1, 1],
    findLast: [1, 1],
    findLastIndex: [1, 1],
    every: [1, 1],
    flatMap: [1, 1],
    reduce: [1, 2],
    reduceRight: [1, 2],
  }[
    name as
      | "push"
      | "unshift"
      | "pop"
      | "concat"
      | "indexOf"
      | "lastIndexOf"
      | "includes"
      | "join"
      | "slice"
      | "shift"
      | "splice"
      | "at"
      | "map"
      | "filter"
      | "forEach"
      | "find"
      | "findIndex"
      | "findLast"
      | "findLastIndex"
      | "some"
      | "every"
      | "flatMap"
      | "reduce"
      | "reduceRight"
  ];
  if (call.arguments.length < arity[0]! || call.arguments.length > arity[1]!) {
    const hint =
      name === "map" ||
      name === "filter" ||
      name === "forEach" ||
      name === "find" ||
      name === "some" ||
      name === "every" ||
      name === "flatMap"
        ? "the thisArg parameter has no lowering — use an arrow function"
        : undefined;
    lowerer.noLowering(
      `.${name} with ${call.arguments.length} argument${call.arguments.length === 1 ? "" : "s"}`,
      call,
      hint,
    );
  }
  if (name === "push" || name === "unshift") {
    let receiver = lowerer.lowerExpr(access.expression);
    if (receiver.type.kind === "union" && lowerer.armTag(receiver.type.unionId, UNDEFINED_T) >= 0) {
      const present = lowerer.stripUndefinedArm(receiver.type);
      const helper =
        present.kind === "array"
          ? lowerer.narrowedArmHelper(receiver.type.unionId, present, loc)
          : null;
      receiver = helper
        ? { kind: "call", callee: helper, args: [receiver], type: present, loc }
        : lowerer.maybeNarrow(receiver, access.expression);
    }
    // `a.push(...src)` / `a.unshift(...src)`: copy src's elements in
    // order (count snapshotted first, so the self-spread forms duplicate
    // like JS) and return the new length.
    const spreadArg =
      call.arguments.length === 1 && ts.isSpreadElement(call.arguments[0]!)
        ? call.arguments[0]!
        : null;
    if ((name === "push" || name === "unshift") && spreadArg && ts.isSpreadElement(spreadArg)) {
      let src = lowerer.lowerExpr(spreadArg.expression);
      // `a.push(...someSet)` / `a.unshift(...someSet)`: a compatible Set drains first
      // (setIntrinsic toArray — insertion order), then appends.
      if (src.type.kind === "set" && identityPreservingWidening(lowerer, src.type.elem, elem)) {
        src = {
          kind: "setIntrinsic",
          method: "toArray",
          receiver: src,
          args: [],
          type: arrayOf(src.type.elem),
          loc,
        };
      }
      if (
        src.type.kind === "array" &&
        !typeEquals(src.type, receiverIr) &&
        identityPreservingWidening(lowerer, src.type.elem, elem)
      ) {
        const items = widenArraySpread(lowerer, src, elem, loc);
        return {
          kind: "arrIntrinsic",
          method: name === "push" ? "pushSpread" : "unshiftSpread",
          receiver,
          args: [items],
          type: F64,
          loc,
        };
      }
      if (!typeEquals(src.type, receiverIr)) {
        lowerer.unsupported(
          "SC1090",
          spreadArg,
          `${name === "push" ? "pushing" : "unshifting"} a spread of '${lowerer.fmt(src.type)}' onto a '${lowerer.fmt(receiverIr)}' array (only a same-element-type array spreads)`,
        );
      }
      return {
        kind: "arrIntrinsic",
        method: name === "push" ? "pushSpread" : "unshiftSpread",
        receiver,
        args: [src],
        type: F64,
        loc,
      };
    }
    if (call.arguments.some(ts.isSpreadElement)) {
      // Finish argument evaluation before mutating the receiver. Each
      // spread snapshots its elements immediately, so a later argument
      // can mutate that source without changing already-collected values.
      const items = lowerArraySpreadItems(lowerer, call.arguments, elem, receiverIr, loc);
      return {
        kind: "arrIntrinsic",
        method: name === "push" ? "pushSpread" : "unshiftSpread",
        receiver,
        args: [items],
        type: F64,
        loc,
      };
    }
    const valueProbes = call.arguments.map((arg) => tryLowerExpression(lowerer, arg));
    if (
      valueProbes.some(
        (probe) => probe !== null && lowerer.runtimeOptionalWidening(probe.type, elem) !== null,
      )
    ) {
      const items = lowerArrayValueItems(
        lowerer,
        call.arguments.map((arg) => lowerer.lowerExpr(arg)),
        elem,
        receiverIr,
        loc,
      );
      return {
        kind: "arrIntrinsic",
        method: name === "push" ? "pushSpread" : "unshiftSpread",
        receiver,
        args: [items],
        type: F64,
        loc,
      };
    }
    // Inserted values flow into the element slot like an assignment would:
    // union-element arrays wrap plain arm values (coerceInto is inert
    // when the types already agree).
    const args = call.arguments.map((a) =>
      name === "push" || name === "unshift"
        ? lowerer.lowerExprExpecting(a, elem)
        : lowerer.lowerExpr(a),
    );
    return {
      kind: "arrIntrinsic",
      method: name,
      receiver,
      args,
      type: F64,
      loc,
    };
  }
  if (name === "pop") {
    // Widen a union payload through the normal array-read machinery
    // before removing it. Reinterpreting the stored union's tag as the
    // result union would confuse arms when undefined changes their order.
    if (elem.kind === "union" && lowerer.armTag(elem.unionId, UNDEFINED_T) < 0) {
      return lowerUnionArrayRemoval(lowerer, access.expression, elem, false, loc);
    }
    const receiver = lowerer.lowerExpr(access.expression);
    return {
      kind: "arrIntrinsic",
      method: "pop",
      receiver,
      args: [],
      type: arrayValueType(lowerer, elem),
      loc,
    };
  }
  if (name === "indexOf" || name === "lastIndexOf" || name === "includes") {
    return lowerArraySearchCall(lowerer, call, access, name, elem);
  }
  if (name === "concat") {
    // `a.concat(x, ys, ...)` — a fresh array of a's elements followed by
    // each argument in order: JS spreads array arguments one level
    // (IsArray, never deeper) and appends plain values. Each argument is
    // either an ELEMENT (pushed) or a SAME-ELEMENT ARRAY (spread) —
    // decided by its static type, which matches IsArray exactly here
    // because the two kinds map differently. The one ambiguous corner —
    // an array-of-arrays receiver given a bare inner array, where TS
    // types it as an element but JS would SPREAD it — is fenced.
    const receiver = lowerer.lowerExpr(access.expression);
    const shape: (IrType | null)[] = [];
    const args: IrExpr[] = [];
    for (const argNode of call.arguments) {
      if (ts.isSpreadElement(argNode)) {
        lowerer.unsupported(
          "SC1090",
          argNode,
          "spread arguments to concat (pass the array itself — concat already spreads array arguments)",
        );
      }
      const argIr = lowerer.mapTypeOf(lowerer.typeOf(argNode));
      const probedArg = probedUntyped ? tryLowerExpression(lowerer, argNode) : null;
      const argArrayType =
        probedArg?.type.kind === "array" ? probedArg.type : argIr?.kind === "array" ? argIr : null;
      if (argArrayType !== null) {
        if (elem.kind === "array" && typeEquals(argArrayType, elem)) {
          // number[][].concat(inner: number[]) — TS says element, JS's
          // IsArray says spread; no honest static answer exists.
          lowerer.unsupported(
            "SC1090",
            argNode,
            "concat of a bare inner array onto an array-of-arrays (JS would SPREAD it one level — wrap it: a.concat([inner]))",
          );
        }
        // Declaration-backed JS methods can return checked values even
        // when their public signature names a concrete array. Validate
        // that boundary before spreading the represented elements.
        let arg = lowerer.lowerExpr(argNode);
        if (arg.type.kind === "dyn") arg = lowerer.coerceInto(argNode, arg, argArrayType);
        if (arg.type.kind !== "array") lowerer.badType(argNode, lowerer.typeOf(argNode));
        shape.push(arg.type.elem);
        args.push(arg);
        continue;
      }
      // A handle-element receiver given an argument whose CHECKER type
      // spells evolved elements while its VALUE is a jsval-element
      // array (`fns.concat(tail)` — both sides of the evolving-`any`
      // adoption): the value's array-ness decides, exactly JS's
      // IsArray — spread it. Non-array values fall through to the
      // element push (the jsvalIn coercion).
      if (elem.kind === "jsval") {
        const arg = lowerer.lowerExpr(argNode);
        if (arg.type.kind === "array" && arg.type.elem.kind === "jsval") {
          shape.push(arg.type.elem);
          args.push(arg);
          continue;
        }
      }
      // An element value — union elements wrap exactly like a push.
      shape.push(null);
      args.push(lowerer.lowerExprExpecting(argNode, elem));
    }
    const helper = arrayConcatHelper(lowerer, elem, shape, call, loc);
    return { kind: "call", callee: helper, args: [receiver, ...args], type: receiverIr, loc };
  }
  if (name === "slice") {
    const receiver = lowerer.lowerExpr(access.expression);
    const args = [
      lowerArrayPosition(lowerer, call.arguments[0], numLit(0, loc), "array slice start"),
      lowerArrayPosition(lowerer, call.arguments[1], numLit(Infinity, loc), "array slice end"),
    ];
    return { kind: "arrIntrinsic", method: "slice", receiver, args, type: receiverIr, loc };
  }
  if (name === "splice") {
    const receiver = lowerer.lowerExpr(access.expression);
    const args: IrExpr[] = [
      lowerArrayPosition(lowerer, call.arguments[0], numLit(0, loc), "array splice start"),
      lowerArrayPosition(
        lowerer,
        call.arguments[1],
        numLit(call.arguments.length === 1 ? Infinity : 0, loc),
        "array splice deleteCount",
      ),
    ];
    if (call.arguments.length <= 2) {
      return { kind: "arrIntrinsic", method: "splice", receiver, args, type: receiverIr, loc };
    }
    const itemNodes = call.arguments.slice(2);
    const hasSpread = itemNodes.some(ts.isSpreadElement);
    const itemProbes = hasSpread ? [] : itemNodes.map((arg) => tryLowerExpression(lowerer, arg));
    const statefulItems = itemProbes.some(
      (probe) => probe !== null && lowerer.runtimeOptionalWidening(probe.type, elem) !== null,
    );
    const items: IrExpr = hasSpread
      ? lowerArraySpreadItems(lowerer, itemNodes, elem, receiverIr, loc)
      : statefulItems
        ? lowerArrayValueItems(
            lowerer,
            itemNodes.map((arg) => lowerer.lowerExpr(arg)),
            elem,
            receiverIr,
            loc,
          )
        : {
            kind: "arrayLit",
            elems: itemNodes.map((arg) => lowerer.coerceInto(arg, lowerer.lowerExpr(arg), elem)),
            type: receiverIr,
            loc,
          };
    return {
      kind: "arrIntrinsic",
      method: "spliceInsert",
      receiver,
      args: [...args, items],
      type: receiverIr,
      loc,
    };
  }
  if (name === "shift") {
    // Like pop, a union without undefined needs an explicit tag widening.
    if (elem.kind === "union" && lowerer.armTag(elem.unionId, UNDEFINED_T) < 0) {
      return lowerUnionArrayRemoval(lowerer, access.expression, elem, true, loc);
    }
    const receiver = lowerer.lowerExpr(access.expression);
    return {
      kind: "arrIntrinsic",
      method: "shift",
      receiver,
      args: [],
      type: arrayValueType(lowerer, elem),
      loc,
    };
  }
  if (name === "join") {
    if (elem.kind === "dyn") {
      const receiver = lowerer.coerceToExpected(lowerer.lowerExpr(access.expression), DYN);
      const args = call.arguments.length
        ? [lowerer.lowerExprExpecting(call.arguments[0]!, DYN)]
        : [];
      return lowerer.coerceToExpected(
        {
          kind: "dynInvoke",
          recv: receiver,
          method: "join",
          calleeName: access.getText(),
          args,
          type: DYN,
          loc,
        },
        STRING,
      );
    }
    // The ambient declares join on every Array<T> (a per-element-type
    // interface split isn't expressible there), so string-convertible
    // elements are enforced here: nested arrays would need JS's recursive
    // Array#toString. UNIONS of the convertible kinds join too —
    // undefined/null arms print EMPTY per Array.prototype.join (the
    // `.filter(Boolean)` idiom keeps its checker type `(string |
    // undefined)[]`, and JS joins the units silently) — via a per-union
    // interned walker in the backend.
    const joinableUnion =
      elem.kind === "union" &&
      (lowerer.unions
        .get(elem.unionId)
        ?.arms.every(
          (a) => a.kind === "f64" || a.kind === "string" || a.kind === "bool" || isUnitType(a),
        ) ??
        false);
    if (elem.kind !== "f64" && elem.kind !== "string" && elem.kind !== "bool" && !joinableUnion) {
      lowerer.unsupported(
        "SC1090",
        call,
        "'.join()' on arrays of this element type (number, string, and boolean arrays join — unions of those with undefined/null arms too, the units printing empty like JS)",
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const sep = lowerArrayJoinSeparator(lowerer, call.arguments[0], loc);
    return { kind: "arrIntrinsic", method: "join", receiver, args: [sep], type: STRING, loc };
  }
  if (name === "map" || name === "filter" || name === "forEach") {
    return lowerArrayHofCall(lowerer, call, access, name, elem);
  }
  if (
    name === "find" ||
    name === "findIndex" ||
    name === "findLast" ||
    name === "findLastIndex" ||
    name === "some" ||
    name === "every"
  ) {
    return lowerArrayFindLikeCall(lowerer, call, access, name, elem, probedUntyped);
  }
  if (name === "at") return lowerArrayAtCall(lowerer, call, access, elem);
  if (name === "flatMap") return lowerArrayFlatMapCall(lowerer, call, access, elem);
  // reduce / reduceRight
  return lowerArrayReduceCall(lowerer, call, access, name as "reduce" | "reduceRight", elem);
}

/** Read before splice so removal cannot destroy the result's owned payload.
 * The source is evaluated once and empty/sparse arrays yield undefined using
 * the same slot-state checks as an indexed read. */
function lowerUnionArrayRemoval(
  lowerer: Lowerer,
  source: ts.Expression,
  elem: IrType,
  first: boolean,
  loc: SrcLoc,
): IrExpr {
  const receiver = lowerer.lowerExpr(source);
  const arr = lowerer.declareHiddenLocal("%removeArray", receiver.type);
  const arrRef = varRef(arr.id, arr.type, loc);
  const index = lowerer.declareHiddenLocal("%removeIndex", F64);
  const indexRef = varRef(index.id, F64, loc);
  const value = arrayValueRead(lowerer, arrRef, indexRef, elem, loc);
  const result = lowerer.declareHiddenLocal("%removedValue", value.type);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: arr.id, init: receiver, loc },
      {
        kind: "varDecl",
        localId: index.id,
        init: first
          ? numLit(0, loc)
          : {
              kind: "bin",
              op: "-",
              left: {
                kind: "arrIntrinsic",
                method: "length",
                receiver: arrRef,
                args: [],
                type: F64,
                loc,
              },
              right: numLit(1, loc),
              type: F64,
              loc,
            },
        loc,
      },
      { kind: "varDecl", localId: result.id, init: value, loc },
      {
        kind: "exprStmt",
        expr: {
          kind: "arrIntrinsic",
          method: "splice",
          receiver: arrRef,
          args: [indexRef, numLit(1, loc)],
          type: arr.type,
          loc,
        },
        loc,
      },
    ],
    result: varRef(result.id, result.type, loc),
    type: result.type,
    loc,
  };
}

function literalFlatDepth(value: IrExpr): number | null {
  if (value.kind === "numLit") return value.value;
  if (value.kind === "strLit") return Number(value.value);
  if (value.kind === "boolLit") return value.value ? 1 : 0;
  if (value.kind === "unitLit") return value.unit === "undefined" ? 1 : 0;
  if (value.kind === "unary" && value.op === "-") {
    const operand = literalFlatDepth(value.operand);
    return operand === null ? null : -operand;
  }
  return null;
}

function lowerArrayFlatCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  receiverType: IrType & { kind: "array" },
): IrExpr {
  const loc = locOf(call);
  if (call.arguments.length > 1 || call.arguments.some(ts.isSpreadElement)) {
    lowerer.noLowering(`.flat with ${call.arguments.length} arguments`, call);
  }
  const elemCouldNest = (elem: IrType): boolean =>
    elem.kind === "array" ||
    elem.kind === "jsval" ||
    elem.kind === "dyn" ||
    (elem.kind === "union" &&
      (lowerer.unions
        .get(elem.unionId)
        ?.arms.some((arm) => arm.kind === "array" || arm.kind === "jsval" || arm.kind === "dyn") ??
        true));
  if (!elemCouldNest(receiverType.elem) && call.arguments[0]) {
    const receiver = lowerer.lowerExpr(access.expression);
    const depth = lowerArrayPosition(
      lowerer,
      call.arguments[0],
      numLit(1, loc),
      "array flat depth",
    );
    const local = lowerer.declareHiddenLocal("%flatReceiver", receiverType);
    const ref = varRef(local.id, receiverType, loc);
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: local.id, init: receiver, loc },
        { kind: "exprStmt", expr: depth, loc },
      ],
      result: {
        kind: "arrIntrinsic",
        method: "flatCopy",
        receiver: ref,
        args: [{ kind: "arrayLit", elems: [], type: receiverType, loc }],
        type: receiverType,
        loc,
      },
      type: receiverType,
      loc,
    };
  }
  const depth = call.arguments[0] ? literalFlatDepth(lowerer.lowerExpr(call.arguments[0])) : 1;
  if (depth === null) lowerer.noLowering(".flat with a nonconstant depth", call);
  let remaining = Number.isNaN(depth) || depth <= 0 ? 0 : Math.trunc(depth);
  let result: IrExpr = lowerer.lowerExpr(access.expression);
  let currentType = receiverType;
  let flattened = false;
  while (remaining > 0) {
    const elem = currentType.elem;
    if (elem.kind !== "array" && elemCouldNest(elem)) {
      lowerer.noLowering(".flat over elements with runtime-dependent array shape", call);
    }
    if (elem.kind !== "array") break;
    result = {
      kind: "arrIntrinsic",
      method: "flatOne",
      receiver: result,
      args: [{ kind: "arrayLit", elems: [], type: elem, loc }],
      type: elem,
      loc,
    };
    currentType = elem;
    remaining--;
    flattened = true;
  }
  if (!flattened) {
    result = {
      kind: "arrIntrinsic",
      method: "flatCopy",
      receiver: result,
      args: [{ kind: "arrayLit", elems: [], type: currentType, loc }],
      type: currentType,
      loc,
    };
  }
  return result;
}

/** `indexOf` and `includes` normally use the runtime's typed search helpers,
 * but an indexed array read is a `T | undefined` value. Keep that union
 * through a small lowered loop so the needle's missing state is observable:
 * indexOf and lastIndexOf skip holes, while includes treats holes as
 * undefined. The same loop also gives union-element arrays their value
 * equality rather than comparing the compiler's union boxes by pointer. */
function lowerArraySearchCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  method: "indexOf" | "lastIndexOf" | "includes",
  elem: IrType,
): IrExpr {
  const loc = locOf(call);
  const receiver = lowerer.lowerExpr(access.expression);
  if (call.arguments.some(ts.isSpreadElement))
    lowerer.noLowering(`.${method} with spread arguments`, call);
  const needle: IrExpr = call.arguments[0]
    ? lowerer.lowerExpr(call.arguments[0])
    : { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
  const fromIndex: IrExpr = call.arguments[1]
    ? lowerPositionArgument(lowerer, call.arguments[1], numLit(0, loc))
    : method === "lastIndexOf"
      ? { kind: "bin", op: "/", left: numLit(1, loc), right: numLit(0, loc), type: F64, loc }
      : numLit(0, loc);
  return lowerArraySearchValues(lowerer, call, method, elem, receiver, needle, fromIndex);
}

function lowerArraySearchValues(
  lowerer: Lowerer,
  call: ts.CallExpression,
  method: "indexOf" | "lastIndexOf" | "includes",
  elem: IrType,
  receiver: IrExpr,
  needle: IrExpr,
  fromIndex: IrExpr,
): IrExpr {
  const loc = locOf(call);
  const argNode = call.arguments[0] ?? call;
  // A derived CLASS VALUE against a base-classval element widens (the same
  // pointer — identity search is exact); the coercion path owns the ABI gate.
  if (
    needle.type.kind === "classval" &&
    elem.kind === "classval" &&
    !typeEquals(needle.type, elem)
  ) {
    needle = lowerer.coerceInto(argNode, needle, elem);
  }

  // Preserve the existing fast path for an ordinary, non-union needle. Its
  // runtime implementation already has exact primitive/reference equality.
  if (
    method !== "lastIndexOf" &&
    call.arguments.length === 1 &&
    elem.kind !== "union" &&
    elem.kind !== "bigint" &&
    typeEquals(needle.type, elem)
  ) {
    return {
      kind: "arrIntrinsic",
      method,
      receiver,
      args: [needle],
      type: method === "includes" ? BOOL : F64,
      loc,
    };
  }

  let valueT = arrayValueType(lowerer, elem);
  // jsval/dyn arrays have a single engine value representation rather than a
  // static undefined arm. Keep their existing runtime path and its explicit
  // type fence; typed static arrays take the state-aware helper below.
  if (valueT.kind !== "union") {
    if (method === "lastIndexOf")
      lowerer.noLowering(".lastIndexOf on an array of engine values", call);
    if (call.arguments.length > 1)
      lowerer.noLowering(`.${method} with fromIndex on '${lowerer.fmt(elem)}' elements`, call);
    if (!typeEquals(needle.type, elem)) lowerer.badType(argNode, lowerer.typeOf(argNode));
    return {
      kind: "arrIntrinsic",
      method,
      receiver,
      args: [needle],
      type: method === "includes" ? BOOL : F64,
      loc,
    };
  }

  // Search uses strict equality, never conversion to the array's element
  // type. Retain primitive needles of a different kind in the comparison
  // union so a nonmatching kind returns a miss instead of throwing.
  const needleArms =
    needle.type.kind === "union" ? lowerer.unions.get(needle.type.unionId)!.arms : [needle.type];
  const scalarNeedle = needleArms.every(
    (arm) =>
      arm.kind === "f64" ||
      arm.kind === "string" ||
      arm.kind === "bool" ||
      arm.kind === "bigint" ||
      arm.kind === "symbol" ||
      isUnitType(arm),
  );
  const valueDef = lowerer.unions.get(valueT.unionId)!;
  const valueArms = valueDef.arms;
  if (scalarNeedle && !valueArms.some((arm) => arm.kind === "func" || arm.kind === "set")) {
    const arms = [...valueArms];
    for (const arm of needleArms)
      if (!arms.some((existing) => typeEquals(existing, arm))) arms.push(arm);
    if (arms.length !== valueArms.length)
      valueT = { kind: "union", unionId: lowerer.unions.transform(valueDef, arms) };
  }
  const directNeedle =
    method === "lastIndexOf" && elem.kind !== "union" && typeEquals(needle.type, elem);
  const searchNeedle = directNeedle ? needle : lowerer.coerceInto(argNode, needle, valueT);
  // Checked dynamic extraction can copy a composite. Its new identity cannot
  // be compared to an array element as though it were the original value.
  if (
    method === "lastIndexOf" &&
    searchNeedle.kind === "dynCheck" &&
    (elem.kind === "record" || elem.kind === "array")
  ) {
    lowerer.noLowering(".lastIndexOf with a checked dynamic reference needle", call);
  }
  if (!directNeedle && !typeEquals(searchNeedle.type, valueT))
    lowerer.badType(argNode, lowerer.typeOf(argNode));
  const helper = arraySearchHelper(
    lowerer,
    method,
    elem,
    valueT,
    searchNeedle.type,
    directNeedle,
    fromIndex.type,
    call.arguments[1] ?? call,
    loc,
  );
  return {
    kind: "call",
    callee: helper,
    args: [receiver, searchNeedle, fromIndex],
    type: method === "includes" ? BOOL : F64,
    loc,
  };
}

/** SameValueZero over a static value union. `unionEq` supplies strict
 * equality for every arm; the extra f64-arm test is the only difference for
 * includes, where NaN equals NaN while +0 and -0 remain equal. */
function arraySearchEquality(
  lowerer: Lowerer,
  left: IrExpr,
  right: IrExpr,
  sameValueZero: boolean,
  loc: SrcLoc,
): IrExpr {
  if (
    left.type.kind !== "union" ||
    right.type.kind !== "union" ||
    left.type.unionId !== right.type.unionId
  ) {
    if (left.type.kind === "string" && right.type.kind === "string") {
      return { kind: "strEq", negated: false, left, right, type: BOOL, loc };
    }
    if (left.type.kind === "bigint" && right.type.kind === "bigint") {
      return {
        kind: "bin",
        op: "===",
        left: { kind: "libCall", fn: "bigint.cmp", args: [left, right], type: F64, loc },
        right: numLit(0, loc),
        type: BOOL,
        loc,
      };
    }
    return { kind: "bin", op: "===", left, right, type: BOOL, loc };
  }
  const unionId = left.type.unionId;
  const strict: IrExpr = {
    kind: "unionEq",
    unionId,
    negated: false,
    sameValue: false,
    left,
    right,
    type: BOOL,
    loc,
  };
  if (!sameValueZero) return strict;
  const numberTag = lowerer.unions.get(unionId)?.arms.findIndex((arm) => arm.kind === "f64") ?? -1;
  if (numberTag < 0) return strict;
  const leftIsNumber: IrExpr = {
    kind: "unionIsTag",
    unionId,
    tag: numberTag,
    negated: false,
    value: left,
    type: BOOL,
    loc,
  };
  const rightIsNumber: IrExpr = {
    kind: "unionIsTag",
    unionId,
    tag: numberTag,
    negated: false,
    value: right,
    type: BOOL,
    loc,
  };
  const leftNumber: IrExpr = {
    kind: "unionNarrow",
    unionId,
    tag: numberTag,
    value: left,
    type: F64,
    loc,
  };
  const rightNumber: IrExpr = {
    kind: "unionNarrow",
    unionId,
    tag: numberTag,
    value: right,
    type: F64,
    loc,
  };
  const bothNaN: IrExpr = {
    kind: "logical",
    op: "&&",
    left: {
      kind: "logical",
      op: "&&",
      left: leftIsNumber,
      right: rightIsNumber,
      type: BOOL,
      loc,
    },
    right: {
      kind: "logical",
      op: "&&",
      left: { kind: "libCall", fn: "num.isNaN", args: [leftNumber], type: BOOL, loc },
      right: { kind: "libCall", fn: "num.isNaN", args: [rightNumber], type: BOOL, loc },
      type: BOOL,
      loc,
    },
    type: BOOL,
    loc,
  };
  return { kind: "logical", op: "||", left: strict, right: bothNaN, type: BOOL, loc };
}

function arraySearchHelper(
  lowerer: Lowerer,
  method: "indexOf" | "lastIndexOf" | "includes",
  elem: IrType,
  valueT: IrType & { kind: "union" },
  needleT: IrType,
  directNeedle: boolean,
  fromT: IrType,
  fromNode: ts.Expression,
  loc: SrcLoc,
): string {
  const key = `${method}:${typeKey(elem)}:${typeKey(valueT)}:${typeKey(needleT)}:${directNeedle}:${typeKey(fromT)}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = `%arr.${method}.${lowerer.arrHofHelpers.size}`;
  lowerer.arrHofHelpers.set(key, name);
  const arrT = arrayOf(elem);
  const resultT = method === "includes" ? BOOL : F64;
  const arrRef = varRef("a.0", arrT, loc);
  const indexRef = varRef("i.0", F64, loc);
  const needleRef = varRef("needle.0", needleT, loc);
  const stateRef = varRef("state.0", F64, loc);
  const nextRef = varRef("next.0", F64, loc);
  const fromRef = varRef("from.0", fromT, loc);
  const numberRef = varRef("number.0", F64, loc);
  const integerRef = varRef("integer.0", F64, loc);
  // Snapshot length before coercing fromIndex, then apply ToIntegerOrInfinity.
  const number = positionNumber(
    lowerer,
    fromRef,
    numLit(0, loc),
    fromNode,
    "array search position",
  );
  const integer: IrExpr = {
    kind: "ternary",
    cond: { kind: "libCall", fn: "num.isNaN", args: [numberRef], type: BOOL, loc },
    then: numLit(0, loc),
    else_: { kind: "libCall", fn: "math.trunc", args: [numberRef], type: F64, loc },
    type: F64,
    loc,
  };
  const forwardStart: IrExpr = {
    kind: "ternary",
    cond: { kind: "bin", op: "<", left: integerRef, right: numLit(0, loc), type: BOOL, loc },
    then: {
      kind: "libCall",
      fn: "math.max",
      args: [
        { kind: "bin", op: "+", left: varRef("n.0", F64, loc), right: integerRef, type: F64, loc },
        numLit(0, loc),
      ],
      type: F64,
      loc,
    },
    // Adding positive zero canonicalizes a truncated negative zero.
    else_: { kind: "bin", op: "+", left: integerRef, right: numLit(0, loc), type: F64, loc },
    type: F64,
    loc,
  };
  const start: IrExpr =
    method === "lastIndexOf"
      ? {
          kind: "ternary",
          cond: { kind: "bin", op: "<", left: integerRef, right: numLit(0, loc), type: BOOL, loc },
          then: {
            kind: "bin",
            op: "+",
            left: varRef("n.0", F64, loc),
            right: integerRef,
            type: F64,
            loc,
          },
          else_: {
            kind: "libCall",
            fn: "math.min",
            args: [
              { kind: "bin", op: "+", left: integerRef, right: numLit(0, loc), type: F64, loc },
              {
                kind: "bin",
                op: "-",
                left: varRef("n.0", F64, loc),
                right: numLit(1, loc),
                type: F64,
                loc,
              },
            ],
            type: F64,
            loc,
          },
          type: F64,
          loc,
        }
      : forwardStart;
  const rawRead: IrExpr = { kind: "arrayGet", arr: arrRef, index: indexRef, type: elem, loc };
  const missing = lowerer.wrappedUndefined(valueT, loc);
  if (!missing) throw new InternalCompilerError("array search helper needs an undefined arm");
  const optionalValue: IrExpr = {
    kind: "ternary",
    cond: { kind: "bin", op: "===", left: stateRef, right: numLit(1, loc), type: BOOL, loc },
    then: typeEquals(elem, valueT) ? rawRead : lowerer.coerceToExpected(rawRead, valueT),
    else_: missing,
    type: valueT,
    loc,
  };
  const value = directNeedle ? rawRead : optionalValue;
  const readT = directNeedle ? elem : valueT;
  const equal = arraySearchEquality(
    lowerer,
    varRef("value.0", readT, loc),
    needleRef,
    method === "includes",
    loc,
  );
  const match =
    method !== "includes"
      ? {
          kind: "logical" as const,
          op: "&&" as const,
          left: {
            kind: "bin" as const,
            op: directNeedle ? ("===" as const) : ("!==" as const),
            left: stateRef,
            right: numLit(directNeedle ? 1 : 0, loc),
            type: BOOL,
            loc,
          },
          right: equal,
          type: BOOL,
          loc,
        }
      : equal;
  const undefinedTag = lowerer.armTag(valueT.unionId, UNDEFINED_T);
  if (undefinedTag < 0)
    throw new InternalCompilerError("array search helper needs an undefined tag");
  const needleIsUndefined: IrExpr = directNeedle
    ? boolLit(false, loc)
    : {
        kind: "unionIsTag",
        unionId: valueT.unionId,
        tag: undefinedTag,
        negated: false,
        value: needleRef,
        type: BOOL,
        loc,
      };
  const advance: IrStmt = {
    kind: "assign",
    localId: "i.0",
    value: {
      kind: "bin",
      op: method === "lastIndexOf" ? "-" : "+",
      left: indexRef,
      right: numLit(1, loc),
      type: F64,
      loc,
    },
    loc,
  };
  const visitPresent: IrStmt[] = [
    { kind: "varDecl", localId: "value.0", init: value, loc },
    {
      kind: "if",
      cond: match,
      then: [{ kind: "return", value: method === "includes" ? boolLit(true, loc) : indexRef, loc }],
      else_: null,
      loc,
    },
    advance,
  ];
  const skipHole: IrStmt[] =
    method === "lastIndexOf"
      ? [advance]
      : [
          {
            kind: "varDecl",
            localId: "next.0",
            init: {
              kind: "arrIntrinsic",
              method: "nextPresent",
              receiver: arrRef,
              args: [indexRef],
              type: F64,
              loc,
            },
            loc,
          },
          ...(method === "includes"
            ? [
                {
                  kind: "if" as const,
                  cond: needleIsUndefined,
                  then: [{ kind: "return" as const, value: boolLit(true, loc), loc }],
                  else_: null,
                  loc,
                },
              ]
            : []),
          { kind: "assign", localId: "i.0", value: nextRef, loc },
        ];
  const loopBody: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "state.0",
      init: { kind: "arrayState", arr: arrRef, index: indexRef, type: F64, loc },
      loc,
    },
    {
      kind: "if",
      cond: { kind: "bin", op: "===", left: stateRef, right: numLit(0, loc), type: BOOL, loc },
      then: skipHole,
      else_: visitPresent,
      loc,
    },
  ];
  lowerer.liftedFns.push({
    name,
    params: [
      { localId: "a.0", name: "a", type: arrT },
      { localId: "needle.0", name: "needle", type: needleT },
      { localId: "from.0", name: "from", type: fromT },
    ],
    returnType: resultT,
    locals: [
      { id: "a.0", name: "a", type: arrT, mutable: true },
      { id: "needle.0", name: "needle", type: needleT, mutable: true },
      { id: "from.0", name: "from", type: fromT, mutable: false },
      { id: "number.0", name: "number", type: F64, mutable: false },
      { id: "integer.0", name: "integer", type: F64, mutable: false },
      { id: "n.0", name: "n", type: F64, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
      { id: "state.0", name: "state", type: F64, mutable: false },
      { id: "next.0", name: "next", type: F64, mutable: false },
      { id: "value.0", name: "value", type: readT, mutable: false },
    ],
    body: [
      arrayLengthDeclaration(arrT, loc),
      { kind: "varDecl", localId: "number.0", init: number, loc },
      { kind: "varDecl", localId: "integer.0", init: integer, loc },
      { kind: "varDecl", localId: "i.0", init: start, loc },
      {
        kind: "while",
        cond:
          method === "lastIndexOf"
            ? { kind: "bin", op: ">=", left: indexRef, right: numLit(0, loc), type: BOOL, loc }
            : {
                kind: "bin",
                op: "<",
                left: indexRef,
                right: varRef("n.0", F64, loc),
                type: BOOL,
                loc,
              },
        body: loopBody,
        loc,
      },
      { kind: "return", value: method === "includes" ? boolLit(false, loc) : numLit(-1, loc), loc },
    ],
    loc,
  });
  return name;
}

/** Tuple methods keep the original receiver alive through argument evaluation.
 * Callback methods read each position only when it is visited, so writes to
 * later positions through a captured alias are visible. A tuple cannot be
 * passed as the callback's array parameter without changing its identity;
 * that parameter retains an explicit representation boundary. */
export function lowerTupleReadMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  tupleReceiver?: IrExpr,
): IrExpr | null {
  if (lowerer.chainBlocked(access, call)) return null;
  const method = access.name.text;
  const search = method === "includes" || method === "indexOf" || method === "lastIndexOf";
  if (
    method !== "slice" &&
    method !== "map" &&
    method !== "flatMap" &&
    method !== "join" &&
    !search
  )
    return null;
  if (!lowerer.isStdlibMember(access)) return null;
  let receiverIr = tupleReceiver?.type ?? lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  let receiver: IrExpr | null = tupleReceiver ?? null;
  const checkerArray = lowerer.checkerArrayValue(access.expression);
  if (checkerArray?.type.kind === "record") {
    receiverIr = checkerArray.type;
    receiver = checkerArray;
  }
  if (receiverIr?.kind !== "record") return null;
  const shape = lowerer.shapes.get(receiverIr.shapeId);
  if (!shape?.tuple) return null;
  receiver ??= lowerer.lowerExpr(access.expression);
  if (method === "join") {
    // Object.entries can retain its dynamic array representation behind a
    // checker tuple. Native tuples box as live references, so separator
    // evaluation can still mutate their elements before join reads them.
    // An unchecked outer array read must validate its optional payload
    // before passing the tuple to the runtime.
    if (receiver.type.kind === "union") {
      receiver = lowerer.coerceInto(access.expression, receiver, receiverIr);
    }
    const converted = lowerer.coerceInto(access.expression, receiver, DYN);
    const boxed: IrExpr =
      converted.kind === "dynFrom" && converted.value.type.kind === "record"
        ? { ...converted, liveRef: true }
        : converted;
    const joined = lowerDynDispatchMethodCall(lowerer, call, access, boxed, true);
    return joined ? lowerer.coerceInto(call, joined, STRING) : null;
  }
  if (receiver.type.kind !== "record") return null;
  const fields = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
  const arms: IrType[] = [];
  for (const field of fields) {
    const types =
      field.type.kind === "union" ? lowerer.unions.get(field.type.unionId)!.arms : [field.type];
    for (const type of types) if (!arms.some((arm) => typeEquals(arm, type))) arms.push(type);
  }
  if (arms.length === 0) return null;
  const elem: IrType =
    arms.length === 1 ? arms[0]! : { kind: "union", unionId: lowerer.unions.intern(arms) };
  const loc = locOf(call);
  const tuple = varRef("a.0", receiver.type, loc);
  const read = (field: (typeof fields)[number]): IrExpr =>
    lowerer.coerceInto(
      access.expression,
      {
        kind: "recordGet",
        obj: tuple,
        shapeId: receiverIr.shapeId,
        field: field.name,
        type: field.type,
        loc,
      },
      elem,
    );
  if (search) {
    if (call.arguments.length > 2 || call.arguments.some(ts.isSpreadElement)) {
      return lowerer.noLowering(`tuple .${method} with spread or extra arguments`, call);
    }
    const arg = call.arguments[0];
    const undefinedArg = arg ? lowerStaticallyUndefinedArgument(lowerer, arg) : null;
    let needle = arg ? (undefinedArg ?? lowerer.lowerExpr(arg)) : null;
    if (!needle || isUnitType(needle.type) || needle.type.kind === "void") {
      const optional = arrayValueType(lowerer, elem);
      const wrapped =
        needle?.type.kind === "nullT"
          ? lowerer.coerceInto(arg ?? call, needle, optional)
          : lowerer.wrappedUndefined(optional, loc);
      if (!wrapped) return lowerer.noLowering(`tuple .${method} missing search value`, call);
      needle = needle ? defaultAfterUndefined(needle, wrapped) : wrapped;
    }
    const from = call.arguments[1]
      ? lowerPositionArgument(lowerer, call.arguments[1], numLit(0, loc))
      : numLit(method === "lastIndexOf" ? Infinity : 0, loc);
    const key = `tuple.${method}:${typeKey(receiver.type)}:${typeKey(needle.type)}:${typeKey(from.type)}:${call.arguments.length}`;
    let helper = lowerer.arrHofHelpers.get(key);
    const resultType = method === "includes" ? BOOL : F64;
    if (!helper) {
      helper = `%tuple.${method}.${lowerer.arrHofHelpers.size}`;
      lowerer.arrHofHelpers.set(key, helper);
      const params = [
        { localId: "a.0", name: "a", type: receiver.type },
        { localId: "needle.0", name: "needle", type: needle.type },
        { localId: "from.0", name: "from", type: from.type },
      ];
      const result = lowerArraySearchValues(
        lowerer,
        call,
        method,
        elem,
        { kind: "arrayLit", elems: fields.map(read), type: arrayOf(elem), loc },
        varRef("needle.0", needle.type, loc),
        varRef("position.0", F64, loc),
      );
      lowerer.liftedFns.push({
        name: helper,
        params,
        returnType: resultType,
        locals: [
          ...params.map((param) => ({
            id: param.localId,
            name: param.name,
            type: param.type,
            mutable: false,
          })),
          { id: "position.0", name: "position", type: F64, mutable: false },
        ],
        body: [
          {
            kind: "varDecl",
            localId: "position.0",
            init: positionNumber(
              lowerer,
              varRef("from.0", from.type, loc),
              numLit(0, loc),
              call.arguments[1] ?? call,
              "tuple search position",
            ),
            loc,
          },
          { kind: "return", value: result, loc },
        ],
        loc,
      });
    }
    return { kind: "call", callee: helper, args: [receiver, needle, from], type: resultType, loc };
  }
  if (method === "slice") {
    if (call.arguments.length > 2 || call.arguments.some(ts.isSpreadElement)) {
      lowerer.noLowering(`.slice with ${call.arguments.length} arguments`, call);
    }
    const args = call.arguments.map((arg) => lowerer.lowerExpr(arg));
    args.forEach((arg, i) => {
      if (arg.type.kind !== "f64")
        lowerer.badType(call.arguments[i]!, lowerer.typeOf(call.arguments[i]!));
    });
    const resultType = arrayOf(elem);
    const key = `tuple.slice:${typeKey(receiver.type)}:${args.length}`;
    let helper = lowerer.arrHofHelpers.get(key);
    if (!helper) {
      helper = `%tuple.slice.${lowerer.arrHofHelpers.size}`;
      lowerer.arrHofHelpers.set(key, helper);
      const params = [receiver, ...args].map((arg, i) => ({
        localId: i === 0 ? "a.0" : `arg.${i}`,
        name: `arg${i}`,
        type: arg.type,
      }));
      lowerer.liftedFns.push({
        name: helper,
        params,
        returnType: resultType,
        locals: params.map((param) => ({
          id: param.localId,
          name: param.name,
          type: param.type,
          mutable: false,
        })),
        body: [
          {
            kind: "return",
            value: {
              kind: "arrIntrinsic",
              method: "slice",
              receiver: { kind: "arrayLit", elems: fields.map(read), type: resultType, loc },
              args: args.map((arg, i) => varRef(`arg.${i + 1}`, arg.type, loc)),
              type: resultType,
              loc,
            },
            loc,
          },
        ],
        loc,
      });
    }
    return { kind: "call", callee: helper, args: [receiver, ...args], type: resultType, loc };
  }
  if (call.arguments.length !== 1 || call.arguments.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `.${method} with ${call.arguments.length} arguments`,
      call,
      "the thisArg parameter has no lowering — use an arrow function",
    );
  }
  const callback = call.arguments[0]!;
  // Check before the array HOF adapter can create a tuple-to-array copy.
  const signatures = lowerer.checker.getCallSignatures(lowerer.typeOf(callback));
  if (signatures.some((signature) => signature.getParameters().length > 2)) {
    lowerer.noLowering(
      `tuple .${method} callback array parameter`,
      callback,
      "capture the original tuple explicitly to preserve its identity",
    );
  }
  const { fnArg, arity } = lowerArrayCallback(lowerer, callback, [elem], receiver.type);
  const ret = fnArg.type.ret;
  if (ret.kind === "void" || ret.kind === "func") lowerer.badType(call, lowerer.typeOf(call));
  if (
    method === "flatMap" &&
    (ret.kind === "dyn" ||
      ret.kind === "jsval" ||
      (ret.kind === "record" && lowerer.shapes.get(ret.shapeId)?.tuple))
  ) {
    return {
      kind: "dynInvoke",
      recv: { kind: "dynFrom", value: receiver, type: DYN, loc },
      method: "flatMap",
      calleeName: access.getText(),
      args: [{ kind: "dynFrom", value: fnArg, type: DYN, loc }],
      type: DYN,
      loc,
    };
  }
  if (
    method === "flatMap" &&
    ret.kind === "union" &&
    lowerer.unions.get(ret.unionId)!.arms.some((arm) => arm.kind === "array")
  ) {
    lowerer.noLowering(
      "tuple .flatMap callback mixing array and scalar results",
      callback,
      "return an array from every path",
    );
  }
  const flatten = method === "flatMap" && ret.kind === "array";
  const outElem = flatten ? ret.elem : callbackArrayElement(lowerer, call, ret);
  requireProducedArrayElement(lowerer, call, `'.${method}()'`, outElem);
  const outType = arrayOf(outElem);
  const key = `tuple.${method}:${typeKey(receiver.type)}:${typeKey(fnArg.type)}:${typeKey(outElem)}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%tuple.${method}.${lowerer.arrHofHelpers.size}`;
    lowerer.arrHofHelpers.set(key, helper);
    const out = varRef("out.0", outType, loc);
    const result = varRef("r.0", ret, loc);
    const outputLength: IrExpr = {
      kind: "arrIntrinsic",
      method: "length",
      receiver: out,
      args: [],
      type: F64,
      loc,
    };
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "out.0",
        init: { kind: "arrayLit", elems: [], type: outType, loc },
        loc,
      },
    ];
    for (const field of fields) {
      const invocation: IrExpr = {
        kind: "callValue",
        callee: varRef("f.0", fnArg.type, loc),
        args: [read(field), numLit(Number(field.name), loc)].slice(0, arity),
        type: ret,
        loc,
      };
      body.push(
        field === fields[0]
          ? { kind: "varDecl", localId: "r.0", init: invocation, loc }
          : { kind: "assign", localId: "r.0", value: invocation, loc },
      );
      if (flatten) {
        const index = varRef("i.0", F64, loc);
        body.push(
          countedFor(
            loc,
            { kind: "arrIntrinsic", method: "length", receiver: result, args: [], type: F64, loc },
            () => [
              {
                kind: "if",
                cond: arrayIndexPresent(result, index, loc),
                then: [
                  {
                    kind: "varDecl",
                    localId: "inner.0",
                    init: arrayValueRead(lowerer, result, index, outElem, loc),
                    loc,
                  },
                  arrayValueStore(
                    lowerer,
                    out,
                    outputLength,
                    varRef("inner.0", arrayValueType(lowerer, outElem), loc),
                    outElem,
                    loc,
                  ),
                ],
                else_: null,
                loc,
              },
            ],
          ),
        );
      } else {
        body.push(arrayValueStore(lowerer, out, outputLength, result, outElem, loc));
      }
    }
    body.push({ kind: "return", value: out, loc });
    lowerer.liftedFns.push({
      name: helper,
      params: [
        { localId: "a.0", name: "a", type: receiver.type },
        { localId: "f.0", name: "f", type: fnArg.type },
      ],
      returnType: outType,
      locals: [
        { id: "a.0", name: "a", type: receiver.type, mutable: false },
        { id: "f.0", name: "f", type: fnArg.type, mutable: false },
        { id: "out.0", name: "out", type: outType, mutable: false },
        { id: "r.0", name: "r", type: ret, mutable: true },
        ...(flatten
          ? [
              { id: "i.0", name: "i", type: F64, mutable: true },
              {
                id: "inner.0",
                name: "inner",
                type: arrayValueType(lowerer, outElem),
                mutable: false,
              },
            ]
          : []),
      ],
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [receiver, fnArg], type: outType, loc };
}

/** `a.at(i)` — the es2022 relative-index read. Desugars to an interned
 * helper over existing IR nodes, ToIntegerOrInfinity-exact: the index
 * truncates toward zero (floor for non-negatives, mirrored floor for
 * negatives, NaN → 0), negatives wrap by the length once, and anything
 * still outside [0, n) answers the undefined arm — never a bounds throw.
 * The result is the checker's own `T | undefined` union, the find
 * machinery's wrap rules (an undefined-armed element type passes
 * through). */
function lowerArrayAtCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  elem: IrType,
): IrExpr {
  const loc = locOf(call);
  if (call.arguments.some(ts.isSpreadElement))
    lowerer.noLowering(".at with spread arguments", call);
  const receiver = lowerer.lowerExpr(access.expression);
  const indexNode = call.arguments[0];
  const index = lowerPositionArgument(lowerer, indexNode, numLit(0, loc));
  const resultT = lowerer.irTypeOf(call);
  if (resultT.kind !== "union") lowerer.badType(call, lowerer.typeOf(call)); // defensive: T | undefined always maps to a union
  const undefTag = lowerer.armTag(resultT.unionId, UNDEFINED_T);
  if (undefTag < 0) lowerer.badType(call, lowerer.typeOf(call));
  const key = `at:${typeKey(elem)}:${typeKey(resultT)}:${typeKey(index.type)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    name = `%arr.at.${lowerer.arrHofHelpers.size}`;
    lowerer.arrHofHelpers.set(key, name);
    const arrT = arrayOf(elem);

    const t = varRef("t.0", F64, loc);
    const i = varRef("i.0", index.type, loc);
    const number = varRef("number.0", F64, loc);
    const n = varRef("n.0", F64, loc);
    const found = lowerer.coerceToExpected(
      arrayValueRead(lowerer, varRef("a.0", arrT, loc), t, elem, loc),
      resultT,
    );
    const miss: IrExpr = {
      kind: "unionWrap",
      unionId: resultT.unionId,
      tag: undefTag,
      value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
      type: resultT,
      loc,
    };
    const floorOf = (e: IrExpr): IrExpr => ({
      kind: "libCall",
      fn: "math.floor",
      args: [e],
      type: F64,
      loc,
    });
    const lt = (l: IrExpr, r: IrExpr): IrExpr => ({
      kind: "bin",
      op: "<",
      left: l,
      right: r,
      type: BOOL,
      loc,
    });
    const body: IrStmt[] = [
      arrayLengthDeclaration(arrT, loc),
      {
        kind: "varDecl",
        localId: "number.0",
        init: positionNumber(lowerer, i, numLit(0, loc), indexNode ?? call, "array at position"),
        loc,
      },
      // ToIntegerOrInfinity: floor is trunc for i >= 0; negatives mirror
      // (trunc(i) = -floor(-i)); NaN becomes 0. ±Infinity floors to
      // itself and falls out of range below, exactly the spec.
      { kind: "varDecl", localId: "t.0", init: floorOf(number), loc },
      {
        kind: "if",
        cond: lt(number, numLit(0, loc)),
        then: [
          {
            kind: "assign",
            localId: "t.0",
            value: {
              kind: "bin",
              op: "-",
              left: numLit(0, loc),
              right: floorOf({
                kind: "bin",
                op: "-",
                left: numLit(0, loc),
                right: number,
                type: F64,
                loc,
              }),
              type: F64,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      },
      {
        kind: "if",
        cond: { kind: "libCall", fn: "num.isNaN", args: [number], type: BOOL, loc },
        then: [{ kind: "assign", localId: "t.0", value: numLit(0, loc), loc }],
        else_: null,
        loc,
      },
      {
        kind: "if",
        cond: lt(t, numLit(0, loc)),
        then: [
          {
            kind: "assign",
            localId: "t.0",
            value: { kind: "bin", op: "+", left: t, right: n, type: F64, loc },
            loc,
          },
        ],
        else_: null,
        loc,
      },
      {
        kind: "if",
        cond: lt(t, numLit(0, loc)),
        then: [{ kind: "return", value: miss, loc }],
        else_: null,
        loc,
      },
      {
        kind: "if",
        cond: { kind: "bin", op: ">=", left: t, right: n, type: BOOL, loc },
        then: [{ kind: "return", value: miss, loc }],
        else_: null,
        loc,
      },
      { kind: "return", value: found, loc },
    ];
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "a.0", name: "a", type: arrT },
        { localId: "i.0", name: "i", type: index.type },
      ],
      returnType: resultT,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: true },
        { id: "i.0", name: "i", type: index.type, mutable: false },
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "number.0", name: "number", type: F64, mutable: false },
        { id: "t.0", name: "t", type: F64, mutable: true },
      ],
      body,
      loc,
    });
  }
  return { kind: "call", callee: name, args: [receiver, index], type: resultT, loc };
}
