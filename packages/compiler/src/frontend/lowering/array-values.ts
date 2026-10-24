import { keyedHelperName } from "./stable-names.js";
import { InternalCompilerError } from "../../errors.js";
import { dynUndefinedExpr, helperLoc, varRef } from "../../ir/build.js";
import {
  BOOL,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  isIntegerBytesElem,
  type SrcLoc,
  STRING,
  UNDEFINED_T,
  typeEquals,
  typeKey,
  unionContainerArmsOk,
} from "../../ir/ir.js";
import { everyExpr } from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";
import type * as ts from "../ts7/adapter.js";

/** Test whether one array index contains a value rather than a hole. */
export function arrayIndexPresent(arr: IrExpr, index: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "arrayHas",
    arr,
    index,
    type: BOOL,
    loc,
  };
}

/** Test the conventional `a.0[i.0]` slot used by synthesized array loops. */
export function currentArrayIndexPresent(arrType: IrType, loc: SrcLoc): IrExpr {
  return arrayIndexPresent(varRef("a.0", arrType, loc), varRef("i.0", F64, loc), loc);
}

/** The value yielded by a JavaScript array read, independent of its slot's storage type. */
export function arrayValueType(lowerer: Lowerer, elem: IrType): IrType {
  if (elem.kind === "dyn") return elem;
  return elem.kind === "union"
    ? (lowerer.withUndefinedArmOf(elem) ?? elem)
    : lowerer.withUndefinedArm(elem);
}

/** ToNumber of one stabilized `number[]` element read: a hole, a present
 * undefined and a missing index all read as NaN, which is
 * ToNumber(undefined). Numeric updates use it in place of the optional
 * element value. */
export function arrayNumberRead(arr: IrExpr, index: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "arrIntrinsic",
    method: "getNumber",
    receiver: arr,
    args: [index],
    type: F64,
    loc,
  };
}

/** Read one stabilized receiver/index pair. Both a hole and present undefined yield undefined. */
export function arrayValueRead(
  lowerer: Lowerer,
  arr: IrExpr,
  index: IrExpr,
  elem: IrType,
  loc: SrcLoc,
): IrExpr {
  const type = arrayValueType(lowerer, elem);
  const read: IrExpr = { kind: "arrayGet", arr, index, type: elem, loc };
  const missing: IrExpr =
    type.kind === "dyn" ? dynUndefinedExpr(loc) : lowerer.wrappedUndefined(type, loc)!;
  return {
    kind: "ternary",
    cond: {
      kind: "bin",
      op: "===",
      left: { kind: "arrayState", arr, index, type: F64, loc },
      right: { kind: "numLit", value: 1, type: F64, loc },
      type: BOOL,
      loc,
    },
    then: typeEquals(elem, type) ? read : lowerer.coerceToExpected(read, type),
    else_: missing,
    type,
    loc,
  };
}

/** Read one position of a stabilized union of native arrays and tuples
 * (`const [a, b] = re.exec(s) || ["", ""]`) without copying the receiver
 * or its elements. Every array arm contributes its missing-value case; a
 * tuple arm answers its field, or undefined past its end. Tuple arms need
 * a constant position. With `stringChars` (the string iterator's code
 * points as a fresh string[]), a string arm (`re.exec(s) || ""`) answers
 * its code point at the position, or undefined past its end. */
export function unionArrayValueRead(
  lowerer: Lowerer,
  value: IrExpr,
  index: IrExpr,
  loc: SrcLoc,
  stringChars?: (text: IrExpr) => IrExpr,
): IrExpr | null {
  if (value.type.kind !== "union") return null;
  const unionId = value.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (!arms?.length) return null;
  const position = index.kind === "numLit" ? String(index.value) : null;
  // A tuple arm's answer at the position: its field, or undefined past
  // its end. Null when the arm is neither an array nor a tuple.
  const tupleField = (arm: IrType): { name: string; type: IrType } | "past" | null => {
    if (arm.kind !== "record" || position === null) return null;
    const shape = lowerer.shapes.get(arm.shapeId);
    if (!shape?.tuple) return null;
    return shape.fields.find((f) => f.name === position) ?? "past";
  };
  // Keep the collection's IrType union layout and narrow each element at
  // its use; an inferred array predicate changes the collection's ABI.
  const stringArm = (arm: IrType): boolean => arm.kind === "string" && stringChars !== undefined;
  for (const arm of arms)
    if (arm.kind !== "array" && !stringArm(arm) && tupleField(arm) === null) return null;
  const answers = new Map<string, IrType>();
  for (const arm of arms) {
    const field = arm.kind === "array" || stringArm(arm) ? null : tupleField(arm);
    const answer =
      arm.kind === "array"
        ? arrayValueType(lowerer, arm.elem)
        : stringArm(arm)
          ? arrayValueType(lowerer, STRING)
          : field === "past"
            ? UNDEFINED_T
            : field!.type;
    const parts = answer.kind === "union" ? lowerer.unions.get(answer.unionId)!.arms : [answer];
    for (const part of parts) answers.set(typeKey(part), part);
  }
  const joined = [...answers.values()].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  if (joined.length === 1 && joined[0]!.kind === "undefinedT") return null;
  if (
    joined.length > 1 &&
    (!unionContainerArmsOk(joined) ||
      joined.some((arm) => arm.kind === "dyn" || arm.kind === "generator" || arm.kind === "caught"))
  )
    return null;
  const type: IrType =
    joined.length === 1 ? joined[0]! : { kind: "union", unionId: lowerer.unions.intern(joined) };
  let result: IrExpr | null = null;
  for (let tag = arms.length - 1; tag >= 0; tag--) {
    const arm = arms[tag]!;
    const receiver: IrExpr = { kind: "unionNarrow", unionId, tag, value, type: arm, loc };
    let read: IrExpr;
    if (arm.kind === "array") {
      read = lowerer.coerceToExpected(
        arrayValueRead(lowerer, receiver, index, arm.elem, loc),
        type,
      );
    } else if (stringArm(arm)) {
      read = lowerer.coerceToExpected(
        arrayValueRead(lowerer, stringChars!(receiver), index, STRING, loc),
        type,
      );
    } else {
      const field = tupleField(arm);
      if (field === null) return null;
      if (field === "past") {
        const missing = lowerer.wrappedUndefined(type, loc);
        if (!missing) return null;
        read = missing;
      } else {
        read = lowerer.coerceToExpected(
          {
            kind: "recordGet",
            obj: receiver,
            shapeId: (arm as IrType & { kind: "record" }).shapeId,
            field: field.name,
            type: field.type,
            loc,
          },
          type,
        );
      }
    }
    result =
      result === null
        ? read
        : {
            kind: "ternary",
            cond: { kind: "unionIsTag", unionId, tag, value, negated: false, type: BOOL, loc },
            then: read,
            else_: result,
            type,
            loc,
          };
  }
  return result;
}

/** Expression kinds that evaluate without running other code or writing
 * a binding. */
const PURE_KINDS = new Set<IrExpr["kind"]>([
  "varRef",
  "numLit",
  "strLit",
  "boolLit",
  "unitLit",
  "bin",
  "unary",
  "logical",
  "ternary",
  "toBool",
  "fieldGet",
  "recordGet",
  "arrayGet",
  "arrayState",
  "arrayHas",
  "unionIsTag",
  "unionNarrow",
  "unionWrap",
]);

/** The locals evaluating `value` may assign, and whether it may run other
 * code (anything but the pure kinds and the read-only element helpers),
 * which can assign locals and fields through closures. */
function valueEffects(lowerer: Lowerer, value: IrExpr): { writes: Set<string>; opaque: boolean } {
  const readers = new Set<string>();
  for (const [key, name] of lowerer.arrHofHelpers) if (key.startsWith("idxOr:")) readers.add(name);
  const writes = new Set<string>();
  let opaque = false;
  everyExpr(value, {
    expr: (e) => {
      if (e.kind === "assignExpr" || e.kind === "incDec") writes.add(e.localId);
      else if (e.kind === "call" ? !readers.has(e.callee) : !PURE_KINDS.has(e.kind)) opaque = true;
      return true;
    },
    stmt: (s) => {
      if (s.kind === "varDecl" || s.kind === "assign") writes.add(s.localId);
      else opaque = true;
      return true;
    },
  });
  return { writes, opaque };
}

/** Whether evaluating `e` after `value` gives what it gives before it: a
 * literal, or a local and field read `value` cannot change. */
function unaffectedBy(e: IrExpr, effects: { writes: Set<string>; opaque: boolean }): boolean {
  switch (e.kind) {
    case "numLit":
    case "strLit":
      return true;
    case "varRef":
      return !effects.writes.has(e.localId);
    case "bin":
      return unaffectedBy(e.left, effects) && unaffectedBy(e.right, effects);
    case "fieldGet":
    case "recordGet":
      return !effects.opaque && unaffectedBy(e.obj, effects);
    default:
      return false;
  }
}

/** Whether `e` reads a `let` or `var` binding, which code the value runs
 * can assign through a closure. */
function readsMutableLocal(lowerer: Lowerer, e: IrExpr): boolean {
  return !everyExpr(e, {
    expr: (x) =>
      x.kind !== "varRef" || lowerer.ctx.locals.find((l) => l.id === x.localId)?.mutable === false,
    stmt: () => true,
  });
}

/** A number, string or boolean element type. Arrays of it hold a present
 * undefined in the element's state, so `(T | undefined)[]` stores T
 * elements (the type mapper) and a T[] seen as one stays the same array. */
export function primitiveElement(elem: IrType): boolean {
  return elem.kind === "f64" || elem.kind === "string" || elem.kind === "bool";
}

/** `value` is the element type with undefined, stored into an array of a
 * primitive element type: a present undefined or the element. */
export function optionalElementValue(lowerer: Lowerer, value: IrExpr, elem: IrType): boolean {
  if (!primitiveElement(elem)) return false;
  if (value.type.kind === "undefinedT") return true;
  return (
    value.type.kind === "union" &&
    lowerer.armTag(value.type.unionId, UNDEFINED_T) >= 0 &&
    typeEquals(lowerer.stripUndefinedArm(value.type), elem)
  );
}

/** A value of a primitive element type that holds a slot until the value
 * stored there replaces it (insertedValues), or stands for a slot that is
 * not read. */
export function elementPlaceholder(elem: IrType, loc: SrcLoc): IrExpr {
  if (elem.kind === "f64") return { kind: "numLit", value: 0, type: F64, loc };
  if (elem.kind === "bool") return { kind: "boolLit", value: false, type: BOOL, loc };
  return { kind: "strLit", value: "", type: STRING, loc };
}

/** Values inserted into an array (push, unshift, splice, a literal), in
 * source order. A value that can be undefined (optionalElementValue) is
 * kept in a temporary: the insertion takes a placeholder for it, and
 * `fill` then stores the value at the placeholder's index. */
export function insertedValues(
  lowerer: Lowerer,
  values: readonly IrExpr[],
  elem: IrType,
  coerce: (value: IrExpr, index: number) => IrExpr,
  loc: SrcLoc,
): {
  stmts: IrStmt[];
  args: IrExpr[];
  optional: boolean;
  fill: (arr: IrExpr, first: IrExpr) => IrStmt[];
} {
  if (!values.some((value) => optionalElementValue(lowerer, value, elem)))
    return { stmts: [], args: values.map(coerce), optional: false, fill: () => [] };
  const stmts: IrStmt[] = [];
  const args: IrExpr[] = [];
  const held: { offset: number; value: IrExpr }[] = [];
  values.forEach((value, offset) => {
    // Every value is evaluated in order before the insertion.
    if (value.type.kind === "undefinedT") {
      if (value.kind !== "unitLit") stmts.push({ kind: "exprStmt", expr: value, loc });
      args.push(elementPlaceholder(elem, loc));
      held.push({ offset, value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc } });
      return;
    }
    const temp = lowerer.declareHiddenLocal("%inserted", value.type);
    stmts.push({ kind: "varDecl", localId: temp.id, init: value, loc });
    const stable = varRef(temp.id, temp.type, loc);
    if (optionalElementValue(lowerer, value, elem)) {
      args.push(elementPlaceholder(elem, loc));
      held.push({ offset, value: stable });
    } else {
      args.push(coerce(stable, offset));
    }
  });
  const fill = (arr: IrExpr, first: IrExpr): IrStmt[] =>
    held.map(({ offset, value }) =>
      arrayValueStore(
        lowerer,
        arr,
        offset === 0
          ? first
          : {
              kind: "bin",
              op: "+",
              left: first,
              right: { kind: "numLit", value: offset, type: F64, loc },
              type: F64,
              loc,
            },
        value,
        elem,
        loc,
      ),
    );
  return { stmts, args, optional: true, fill };
}

/** Statements appending `value` to `arr` inside a lifted helper. A value
 * that can be undefined in a primitive array (optionalElementValue) is held
 * in the helper's local `slot` (which the caller declares with the value's
 * type) and stored as a present undefined or the element; any other value
 * converts to the element type. */
export function appendElement(
  lowerer: Lowerer,
  arr: IrExpr,
  value: IrExpr,
  elem: IrType,
  slot: string,
  loc: SrcLoc,
): IrStmt[] {
  if (optionalElementValue(lowerer, value, elem) && value.type.kind !== "undefinedT") {
    const held = varRef(slot, value.type, loc);
    const length: IrExpr = {
      kind: "arrIntrinsic",
      method: "length",
      receiver: arr,
      args: [],
      type: F64,
      loc,
    };
    return [
      { kind: "varDecl", localId: slot, init: value, loc },
      arrayValueStore(lowerer, arr, length, held, elem, loc),
    ];
  }
  return [
    {
      kind: "exprStmt",
      expr: {
        kind: "arrIntrinsic",
        method: "push",
        receiver: arr,
        args: [lowerer.coerceToExpected(value, elem)],
        type: F64,
        loc,
      },
      loc,
    },
  ];
}

/** Store a stabilized value without changing the array's element ABI. */
export function arrayValueStore(
  lowerer: Lowerer,
  arr: IrExpr,
  index: IrExpr,
  value: IrExpr,
  elem: IrType,
  loc: SrcLoc,
): IrStmt {
  if (typeEquals(value.type, elem)) return { kind: "arraySet", arr, index, value, loc };
  // An undefined value of a `(T | undefined)[]` (primitiveElement).
  if (value.type.kind === "undefinedT" && primitiveElement(elem)) {
    const write: IrStmt = { kind: "arraySetUndefined", arr, index, loc };
    if (value.kind === "unitLit") return write;
    return { kind: "block", body: [{ kind: "exprStmt", expr: value, loc }, write], loc };
  }
  if (value.type.kind === "union" && lowerer.armTag(value.type.unionId, UNDEFINED_T) >= 0) {
    // The tag test and the VALUE arm extraction both consume the value. Keep
    // an arbitrary expression (especially an array read or call) single
    // evaluated before branching; this also gives the native emitters one
    // owned union temporary to release on every path.
    const unionId = value.type.unionId;
    let stable = value;
    const prefix: IrStmt[] = [];
    // The stores below evaluate the receiver and the index after the value.
    // JavaScript evaluates them first (`out[n++] = src[n]` reads src[1]), so
    // either may need its value held before the value runs.
    if (value.kind !== "varRef") {
      const valueFx = valueEffects(lowerer, value);
      const hold = (e: IrExpr, name: string, effects: typeof valueFx): IrExpr => {
        if (unaffectedBy(e, effects) && !(effects.opaque && readsMutableLocal(lowerer, e)))
          return e;
        const temp = lowerer.declareHiddenLocal(name, e.type);
        prefix.push({ kind: "varDecl", localId: temp.id, init: e, loc });
        return varRef(temp.id, temp.type, loc);
      };
      // The receiver runs before the index and the value, so the index's
      // effects can change it too (`a[(a = b, 0)] = c[0]!`).
      const indexFx = valueEffects(lowerer, index);
      arr = hold(arr, "%arrayTarget", {
        writes: new Set([...valueFx.writes, ...indexFx.writes]),
        opaque: valueFx.opaque || indexFx.opaque,
      });
      index = hold(index, "%arrayIndex", valueFx);
    }
    if (value.kind !== "varRef") {
      const temp = lowerer.declareHiddenLocal("%arrayValue", value.type);
      prefix.push({ kind: "varDecl", localId: temp.id, init: value, loc });
      stable = varRef(temp.id, temp.type, loc);
    }
    const write: IrStmt = {
      kind: "if",
      cond: {
        kind: "unionIsTag",
        unionId,
        tag: lowerer.armTag(unionId, UNDEFINED_T),
        negated: false,
        value: stable,
        type: BOOL,
        loc,
      },
      then: [{ kind: "arraySetUndefined", arr, index, loc }],
      else_: [{ kind: "arraySet", arr, index, value: lowerer.coerceToExpected(stable, elem), loc }],
      loc,
    };
    if (prefix.length > 0) return { kind: "block", body: [...prefix, write], loc };
    return write;
  }
  return { kind: "arraySet", arr, index, value: lowerer.coerceToExpected(value, elem), loc };
}

/** An ordinary indexed read: values retain their element type, while
 * holes, missing properties, and present undefined yield undefined. */
export function lowerSafeIndexRead(
  lowerer: Lowerer,
  arr: IrExpr,
  index: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  if (arr.type.kind !== "array") throw new InternalCompilerError("indexed read requires an array");
  const elem = arr.type.elem;
  if (elem.kind === "void") return null;
  const resultT = arrayValueType(lowerer, elem);
  const key = `idxOr:${typeKey(elem)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    const at = helperLoc(loc);
    name = keyedHelperName(lowerer, "%arr.idxOr", key);
    lowerer.arrHofHelpers.set(key, name);
    const arrT = arr.type;
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "a.0", name: "a", type: arrT },
        { localId: "i.0", name: "i", type: F64 },
      ],
      returnType: resultT,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: false },
      ],
      body: [
        {
          kind: "return",
          value: arrayValueRead(lowerer, varRef("a.0", arrT, at), varRef("i.0", F64, at), elem, at),
          loc: at,
        },
      ],
      loc: at,
    });
  }
  return { kind: "call", callee: name, args: [arr, index], type: resultT, loc };
}

/** An ordinary typed-array element read `t[i]`: like Node, an index that
 * is not an integer in [0, length) answers undefined (the storage is
 * never touched out of bounds). The result is `number | undefined`, the
 * same optional shape ordinary array reads carry; numeric consumers fuse
 * back to the plain element read (tryLowerNumericIndexRead), where the
 * invalid case reads as NaN — exactly ToNumber(undefined). */
export function lowerSafeBytesRead(
  lowerer: Lowerer,
  receiver: IrExpr,
  index: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const bytesT = receiver.type;
  if (bytesT.kind !== "bytes") throw new InternalCompilerError("typed read requires bytes");
  const resultT = lowerer.withUndefinedArm(F64);
  const key = `bytesIdxOr:${typeKey(bytesT)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    const at = helperLoc(loc);
    name = keyedHelperName(lowerer, "%bytes.idxOr", key);
    lowerer.arrHofHelpers.set(key, name);
    const b = varRef("b.0", bytesT, at);
    const i = varRef("i.0", F64, at);
    const cmp = (op: "<" | ">=" | "===", left: IrExpr, right: IrExpr): IrExpr => ({
      kind: "bin",
      op,
      left,
      right,
      type: BOOL,
      loc: at,
    });
    const inRange: IrExpr = {
      kind: "logical",
      op: "&&",
      left: cmp(">=", i, { kind: "numLit", value: 0, type: F64, loc: at }),
      right: {
        kind: "logical",
        op: "&&",
        left: cmp("<", i, {
          kind: "bytesIntrinsic",
          method: "length",
          receiver: b,
          args: [],
          type: F64,
          loc: at,
        }),
        right: cmp("===", { kind: "libCall", fn: "math.trunc", args: [i], type: F64, loc: at }, i),
        type: BOOL,
        loc: at,
      },
      type: BOOL,
      loc: at,
    };
    const read: IrExpr = {
      kind: "bytesIntrinsic",
      method: "get",
      receiver: b,
      args: [i],
      type: F64,
      loc: at,
    };
    if (isIntegerBytesElem(bytesT.elem)) {
      // An integer element is never NaN, so the NaN-for-invalid read
      // decides presence with one inline index check (no separate range
      // and integrality tests).
      const v = varRef("v.0", F64, at);
      lowerer.liftedFns.push({
        name,
        params: [
          { localId: "b.0", name: "b", type: bytesT },
          { localId: "i.0", name: "i", type: F64 },
        ],
        returnType: resultT,
        locals: [
          { id: "b.0", name: "b", type: bytesT, mutable: false },
          { id: "i.0", name: "i", type: F64, mutable: false },
          { id: "v.0", name: "v", type: F64, mutable: false },
        ],
        body: [
          { kind: "varDecl", localId: "v.0", init: { ...read, invalidNaN: true }, loc: at },
          {
            kind: "return",
            value: {
              kind: "ternary",
              cond: { kind: "libCall", fn: "num.isNaN", args: [v], type: BOOL, loc: at },
              then: lowerer.wrappedUndefined(resultT, at)!,
              else_: lowerer.coerceToExpected(v, resultT),
              type: resultT,
              loc: at,
            },
            loc: at,
          },
        ],
        loc: at,
      });
      return { kind: "call", callee: name, args: [receiver, index], type: resultT, loc };
    }
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "b.0", name: "b", type: bytesT },
        { localId: "i.0", name: "i", type: F64 },
      ],
      returnType: resultT,
      locals: [
        { id: "b.0", name: "b", type: bytesT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: false },
      ],
      body: [
        {
          kind: "return",
          value: {
            kind: "ternary",
            cond: inRange,
            then: lowerer.coerceToExpected(read, resultT),
            else_: lowerer.wrappedUndefined(resultT, at)!,
            type: resultT,
            loc: at,
          },
          loc: at,
        },
      ],
      loc: at,
    });
  }
  return { kind: "call", callee: name, args: [receiver, index], type: resultT, loc };
}

/** Whether `operand` is a call of the typed-array read helper. */
function isBytesReadHelperCall(lowerer: Lowerer, operand: IrExpr): boolean {
  if (operand.kind !== "call" || operand.args.length !== 2) return false;
  const receiver = operand.args[0]!;
  return (
    receiver.type.kind === "bytes" &&
    operand.args[1]!.type.kind === "f64" &&
    operand.callee === lowerer.arrHofHelpers.get(`bytesIdxOr:${typeKey(receiver.type)}`)
  );
}

/** Fuse only our own f64-array read helper with immediate ToNumber.
 * Reuse its arguments verbatim so the receiver and index still evaluate
 * exactly once, in order, before the read. Do not specialize user calls,
 * union-element arrays, or optional values stored in locals. */
export function tryLowerNumericIndexRead(
  lowerer: Lowerer,
  operand: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  if (operand.kind === "call" && isBytesReadHelperCall(lowerer, operand)) {
    // The plain element read: an invalid index reads as NaN, which is
    // ToNumber(undefined).
    const [receiver, index] = operand.args;
    return {
      kind: "bytesIntrinsic",
      method: "get",
      receiver: receiver!,
      args: [index!],
      type: F64,
      loc,
      invalidNaN: true,
    };
  }
  if (
    operand.kind !== "call" ||
    operand.callee !== lowerer.arrHofHelpers.get(`idxOr:${typeKey(F64)}`)
  )
    return null;
  const [arr, index] = operand.args;
  if (
    operand.args.length !== 2 ||
    arr?.type.kind !== "array" ||
    arr.type.elem.kind !== "f64" ||
    index?.type.kind !== "f64"
  )
    return null;
  // The intrinsic owns the evaluated receiver through index evaluation,
  // then borrows it for one slot lookup. No extra helper parameter or
  // separate state/getter expressions need to retain the array again.
  return {
    kind: "arrIntrinsic",
    method: "getNumber",
    receiver: arr,
    args: [index],
    type: F64,
    loc,
  };
}

/** Fuse our own typed-array read helper with strict equality against a
 * plain number: `t[i] === b` is false when `t[i]` is undefined, and the
 * NaN-for-invalid read is never equal to anything either, so the plain
 * read answers exactly (`!==` is the negation). The other operand must
 * lower to a double that never stands for undefined: a union keeps the
 * box (undefined === undefined is true), and so does a NaN-coded value
 * (nan-coded-reads.ts), which encodes undefined as NaN. The read keeps
 * its arguments, so evaluation order is unchanged. */
export function tryLowerBytesReadNumberEquality(
  lowerer: Lowerer,
  operand: IrExpr,
  other: IrExpr,
  otherNode: ts.Expression,
): IrExpr | null {
  if (other.type.kind !== "f64" || !isBytesReadHelperCall(lowerer, operand)) return null;
  if (lowerer.nanCodedReads?.mayStandForUndefined(otherNode) === true) return null;
  return tryLowerNumericIndexRead(lowerer, operand, operand.loc);
}

/** Fuse our own scalar-array read helper with an immediate ToBoolean, so a
 * condition such as `if (flags[i])` never boxes `T | undefined`. Numbers
 * reuse getNumber: a missing slot reads as NaN, which is falsy exactly like
 * undefined. Booleans test the slot state and then read the value; both
 * operands are evaluated twice, so they must be plain bindings/literals
 * (the same proof the indexed-comparison fusion uses). Returns a BOOL
 * expression with the original evaluation order, or null. */
export function tryLowerIndexTruthiness(
  lowerer: Lowerer,
  operand: IrExpr,
  node: ts.Expression,
  loc: SrcLoc,
): IrExpr | null {
  if (operand.kind !== "call" || operand.args.length !== 2) return null;
  if (isBytesReadHelperCall(lowerer, operand)) {
    // NaN (the invalid read) is falsy exactly like undefined.
    const number = tryLowerNumericIndexRead(lowerer, operand, loc);
    return number ? lowerer.ensureBool(number, node) : null;
  }
  const [arr, index] = operand.args;
  if (arr?.type.kind !== "array" || index?.type.kind !== "f64") return null;
  const elem = arr.type.elem;
  if (elem.kind !== "f64" && elem.kind !== "bool") return null;
  if (operand.callee !== lowerer.arrHofHelpers.get(`idxOr:${typeKey(elem)}`)) return null;
  if (elem.kind === "f64") {
    const number = tryLowerNumericIndexRead(lowerer, operand, loc);
    return number ? lowerer.ensureBool(number, node) : null;
  }
  return tryFuseIndexRead(lowerer, operand, BOOL, (read) => read, {
    kind: "boolLit",
    value: false,
    type: BOOL,
    loc,
  });
}

/** Fuse our own non-union array read helper with its single consumer:
 * `present` receives the strict element read, `missing` answers holes,
 * present undefined, and absent indices. The receiver and index evaluate
 * once more than in the helper form, so both must be plain bindings or
 * numeric literals (nothing can run between the state test and the read). */
export function tryFuseIndexRead(
  lowerer: Lowerer,
  operand: IrExpr,
  type: IrType,
  present: (read: IrExpr) => IrExpr,
  missing: IrExpr,
): IrExpr | null {
  if (operand.kind !== "call" || operand.args.length !== 2) return null;
  const [arr, index] = operand.args;
  if (arr?.type.kind !== "array" || index?.type.kind !== "f64") return null;
  const elem = arr.type.elem;
  if (elem.kind === "union" || elem.kind === "void") return null;
  if (operand.callee !== lowerer.arrHofHelpers.get(`idxOr:${typeKey(elem)}`)) return null;
  if (arr.kind !== "varRef" || (index.kind !== "varRef" && index.kind !== "numLit")) return null;
  const loc = operand.loc;
  return {
    kind: "ternary",
    cond: {
      kind: "bin",
      op: "===",
      left: { kind: "arrayState", arr, index, type: F64, loc },
      right: { kind: "numLit", value: 1, type: F64, loc },
      type: BOOL,
      loc,
    },
    then: present({ kind: "arrayGet", arr, index, type: elem, loc }),
    else_: missing,
    type,
    loc,
  };
}
