import { keyedHelperName } from "./stable-names.js";
import { helperLoc, varRef } from "../../ir/build.js";
import {
  BOOL,
  BYTES_ELEMENT_SIZE,
  F64,
  VOID,
  type IrBytesIntrinsicMethod,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
  typeKey,
} from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { arrayNumberRead, lowerSafeBytesRead, lowerSafeIndexRead } from "./array-values.js";
import type { Lowerer } from "./lowerer.js";

/** Unions of number-indexed containers: typed arrays of any element kind
 * (`Uint8Array | Uint16Array | Uint32Array`, as lru-cache picks by size)
 * and `number[]` arms.
 *
 * The union keeps its ordinary tagged representation. Each operation on it
 * lowers to a lifted helper per union and operation that tests the tag,
 * narrows to the arm and runs the arm's own operation: the inline load or
 * store of a typed array's element kind, or the dense read or write of a
 * number array. The helpers are small, so LLVM inlines them, and a loop
 * over one union value tests a loop-invariant tag. */

/** One arm: its tag and its type (bytes, or an array of numbers). */
export interface IndexedArm {
  tag: number;
  type: IrType & ({ kind: "bytes" } | { kind: "array" });
}

/** The arms of a union whose every arm is a typed array or a `number[]`,
 * or null. Unions with any other arm (undefined included) are not
 * indexed unions: their reads need a narrowing first. */
export function indexedUnionArms(lowerer: Lowerer, type: IrType): IndexedArm[] | null {
  if (type.kind !== "union") return null;
  const arms = lowerer.unions.get(type.unionId)?.arms;
  if (!arms || arms.length < 2) return null;
  const result: IndexedArm[] = [];
  for (const [tag, arm] of arms.entries()) {
    if (arm.kind === "bytes") result.push({ tag, type: arm });
    else if (arm.kind === "array" && arm.elem.kind === "f64") result.push({ tag, type: arm });
    else return null;
  }
  return result;
}

/** Whether every arm is a typed array (so typed-array-only members such
 * as `byteLength` apply). */
export function allBytesArms(arms: readonly IndexedArm[]): boolean {
  return arms.every((arm) => arm.type.kind === "bytes");
}

type ArmBody = (receiver: IrExpr, arm: IndexedArm, args: readonly IrExpr[]) => IrStmt[];

/** The helper `name(u, ...args)`: for each arm but the last, a tag test
 * that runs the arm's statements; the last arm's statements run without a
 * test (the union holds one of its arms). */
function dispatchHelper(
  lowerer: Lowerer,
  key: string,
  prefix: string,
  union: IrType,
  arms: readonly IndexedArm[],
  params: readonly { name: string; type: IrType }[],
  returnType: IrType,
  body: ArmBody,
  loc: SrcLoc,
): string {
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, prefix, key);
  lowerer.arrHofHelpers.set(key, name);
  const at = helperLoc(loc);
  if (union.kind !== "union") throw new Error("indexed-union helper over a non-union");
  const u = varRef("u.0", union, at);
  const args = params.map((p) => varRef(`${p.name}.0`, p.type, at));
  const stmts: IrStmt[] = [];
  arms.forEach((arm, i) => {
    const receiver: IrExpr = {
      kind: "unionNarrow",
      unionId: union.unionId,
      tag: arm.tag,
      value: u,
      type: arm.type,
      loc: at,
    };
    const armStmts = body(receiver, arm, args);
    if (i === arms.length - 1) {
      stmts.push(...armStmts);
      return;
    }
    stmts.push({
      kind: "if",
      cond: {
        kind: "unionIsTag",
        unionId: union.unionId,
        tag: arm.tag,
        negated: false,
        value: u,
        type: BOOL,
        loc: at,
      },
      then: armStmts,
      else_: null,
      loc: at,
    });
  });
  const fn: IrFunction = {
    name,
    params: [
      { localId: "u.0", name: "u", type: union },
      ...params.map((p) => ({ localId: `${p.name}.0`, name: p.name, type: p.type })),
    ],
    returnType,
    locals: [
      { id: "u.0", name: "u", type: union, mutable: false },
      ...params.map((p) => ({ id: `${p.name}.0`, name: p.name, type: p.type, mutable: false })),
    ],
    body: stmts,
    loc: at,
  };
  lowerer.liftedFns.push(fn);
  return name;
}

const returning = (value: IrExpr, loc: SrcLoc): IrStmt[] => [{ kind: "return", value, loc }];

/** `u[i]` read as an element or undefined (an invalid index), as the
 * typed-array and number-array reads answer. */
export function lowerIndexedUnionRead(
  lowerer: Lowerer,
  receiver: IrExpr,
  arms: readonly IndexedArm[],
  index: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const resultT = lowerer.withUndefinedArm(F64);
  const key = `idxUnion:get:${unionKey(receiver.type)}`;
  const name = dispatchHelper(
    lowerer,
    key,
    "%union.idxOr",
    receiver.type,
    arms,
    [{ name: "i", type: F64 }],
    resultT,
    (arm, info, [i]) =>
      returning(
        info.type.kind === "bytes"
          ? lowerSafeBytesRead(lowerer, arm, i!, loc)
          : lowerSafeIndexRead(lowerer, arm, i!, loc)!,
        loc,
      ),
    loc,
  );
  const numeric = indexedUnionNumberHelper(lowerer, receiver.type, arms, loc);
  lowerer.indexedUnionNumericTwins.set(name, numeric);
  return { kind: "call", callee: name, args: [receiver, index], type: resultT, loc };
}

/** `u[i]` read as a number: an invalid index reads as NaN, which is
 * ToNumber(undefined). */
export function lowerIndexedUnionNumberRead(
  lowerer: Lowerer,
  receiver: IrExpr,
  arms: readonly IndexedArm[],
  index: IrExpr,
  loc: SrcLoc,
): IrExpr {
  if (inlineDispatch(receiver, [index]))
    return inlineArms(receiver, arms, F64, (arm, info) => numberRead(arm, info, index, loc), loc);
  const name = indexedUnionNumberHelper(lowerer, receiver.type, arms, loc);
  return { kind: "call", callee: name, args: [receiver, index], type: F64, loc };
}

function numberRead(arm: IrExpr, info: IndexedArm, index: IrExpr, loc: SrcLoc): IrExpr {
  return info.type.kind === "bytes"
    ? {
        kind: "bytesIntrinsic",
        method: "get",
        receiver: arm,
        args: [index],
        type: F64,
        loc,
        invalidNaN: true,
      }
    : arrayNumberRead(arm, index, loc);
}

function indexedUnionNumberHelper(
  lowerer: Lowerer,
  union: IrType,
  arms: readonly IndexedArm[],
  loc: SrcLoc,
): string {
  return dispatchHelper(
    lowerer,
    `idxUnion:num:${unionKey(union)}`,
    "%union.getNumber",
    union,
    arms,
    [{ name: "i", type: F64 }],
    F64,
    (arm, info, [i]) => returning(numberRead(arm, info, i!, loc), loc),
    loc,
  );
}

/** The numeric twin of an indexed-union read helper call, or null. */
export function indexedUnionNumericTwin(lowerer: Lowerer, call: IrExpr): IrExpr | null {
  if (call.kind !== "call") return null;
  const twin = lowerer.indexedUnionNumericTwins.get(call.callee);
  return twin === undefined ? null : { ...call, callee: twin, type: F64 };
}

/** `u[i] = v` for a number `v`: each arm's element store (a typed array
 * converts the number to its element kind and ignores an invalid index; a
 * number array stores at the index). */
export function lowerIndexedUnionWrite(
  lowerer: Lowerer,
  receiver: IrExpr,
  arms: readonly IndexedArm[],
  index: IrExpr,
  value: IrExpr,
  loc: SrcLoc,
): IrStmt {
  // In place, the value evaluates before the arms read the receiver and
  // index: only when it cannot rebind either.
  if (inlineDispatch(receiver, [index]) && !rebinds(value, [receiver, index])) {
    const union = receiver.type;
    const valueLocal = lowerer.declareHiddenLocal("%elementValue", F64);
    const v: IrExpr = { kind: "varRef", localId: valueLocal.id, type: F64, loc };
    let chain: IrStmt[] | null = null;
    for (let i = arms.length - 1; i >= 0; i--) {
      const info = arms[i]!;
      const arm: IrExpr = {
        kind: "unionNarrow",
        unionId: union.kind === "union" ? union.unionId : "",
        tag: info.tag,
        value: receiver,
        type: info.type,
        loc,
      };
      const store: IrStmt =
        info.type.kind === "bytes"
          ? { kind: "bytesSet", arr: arm, index, value: v, loc }
          : { kind: "arraySet", arr: arm, index, value: v, loc };
      chain =
        chain === null
          ? [store]
          : [
              {
                kind: "if",
                cond: {
                  kind: "unionIsTag",
                  unionId: union.kind === "union" ? union.unionId : "",
                  tag: info.tag,
                  negated: false,
                  value: receiver,
                  type: BOOL,
                  loc,
                },
                then: [store],
                else_: chain,
                loc,
              },
            ];
    }
    return {
      kind: "block",
      body: [{ kind: "varDecl", localId: valueLocal.id, init: value, loc }, ...chain!],
      loc,
    };
  }
  const name = dispatchHelper(
    lowerer,
    `idxUnion:set:${unionKey(receiver.type)}`,
    "%union.idxSet",
    receiver.type,
    arms,
    [
      { name: "i", type: F64 },
      { name: "v", type: F64 },
    ],
    VOID,
    (arm, info, [i, v]) => [
      info.type.kind === "bytes"
        ? { kind: "bytesSet", arr: arm, index: i!, value: v!, loc }
        : { kind: "arraySet", arr: arm, index: i!, value: v!, loc },
      { kind: "return", value: null, loc },
    ],
    loc,
  );
  return {
    kind: "exprStmt",
    expr: { kind: "call", callee: name, args: [receiver, index, value], type: VOID, loc },
    loc,
  };
}

/** The members every arm answers: `length` for all, and `byteLength`,
 * `byteOffset` and `BYTES_PER_ELEMENT` when every arm is a typed array. */
export function lowerIndexedUnionMember(
  lowerer: Lowerer,
  receiver: IrExpr,
  arms: readonly IndexedArm[],
  member: string,
  loc: SrcLoc,
): IrExpr | null {
  const bytesOnly = member !== "length";
  if (
    member !== "length" &&
    member !== "byteLength" &&
    member !== "byteOffset" &&
    member !== "BYTES_PER_ELEMENT"
  )
    return null;
  if (bytesOnly && !allBytesArms(arms)) return null;
  const memberOf = (arm: IrExpr, info: IndexedArm): IrExpr =>
    info.type.kind === "array"
      ? { kind: "arrIntrinsic", method: "length", receiver: arm, args: [], type: F64, loc }
      : member === "BYTES_PER_ELEMENT"
        ? { kind: "numLit", value: BYTES_ELEMENT_SIZE[info.type.elem], type: F64, loc }
        : { kind: "bytesIntrinsic", method: member, receiver: arm, args: [], type: F64, loc };
  if (inlineDispatch(receiver, [])) return inlineArms(receiver, arms, F64, memberOf, loc);
  const name = dispatchHelper(
    lowerer,
    `idxUnion:${member}:${unionKey(receiver.type)}`,
    `%union.${member}`,
    receiver.type,
    arms,
    [],
    F64,
    (arm, info) => returning(memberOf(arm, info), loc),
    loc,
  );
  return { kind: "call", callee: name, args: [receiver], type: F64, loc };
}

function unionKey(type: IrType): string {
  return type.kind === "union" ? String(type.unionId) : "?";
}

/** A typed-array method on a union whose every arm is a typed array: the
 * arguments evaluate once in the caller, and each arm runs the same
 * `bytesIntrinsic` on its own receiver. `result` "receiver" is a method
 * that answers a typed array of the receiver's kind (subarray, slice,
 * fill, ...): each arm wraps its answer back into the union. */
export function lowerIndexedUnionMethod(
  lowerer: Lowerer,
  receiver: IrExpr,
  arms: readonly IndexedArm[],
  method: IrBytesIntrinsicMethod,
  args: readonly IrExpr[],
  result: "receiver" | IrType,
  loc: SrcLoc,
): IrExpr {
  const union = receiver.type;
  if (union.kind !== "union") throw new Error("indexed-union method over a non-union");
  const resultT = result === "receiver" ? union : result;
  const params = args.map((arg, i) => ({ name: `a${i}`, type: arg.type }));
  const signature = args.map((arg) => typeKey(arg.type)).join(",");
  const name = dispatchHelper(
    lowerer,
    `idxUnion:${method}(${signature}):${unionKey(union)}`,
    `%union.${method}`,
    union,
    arms,
    params,
    resultT,
    (arm, info, refs) => {
      const call: IrExpr = {
        kind: "bytesIntrinsic",
        method,
        receiver: arm,
        args: [...refs],
        type: result === "receiver" ? info.type : result,
        loc,
      };
      if (result === "receiver")
        return returning(
          {
            kind: "unionWrap",
            unionId: union.unionId,
            tag: info.tag,
            value: call,
            type: union,
            loc,
          },
          loc,
        );
      if (result.kind === "void")
        return [
          { kind: "exprStmt", expr: call, loc },
          { kind: "return", value: null, loc },
        ];
      return returning(call, loc);
    },
    loc,
  );
  return { kind: "call", callee: name, args: [receiver, ...args], type: resultT, loc };
}

/** The elements of `u` as a `number[]`: a typed-array arm drains its
 * elements into a fresh array. A number-array arm is the array itself for
 * consumers that copy it (spreads), or with `fresh` a dense copy whose
 * holes read as undefined (Array.from). */
export function lowerIndexedUnionToArray(
  lowerer: Lowerer,
  receiver: IrExpr,
  arms: readonly IndexedArm[],
  loc: SrcLoc,
  fresh = false,
): IrExpr {
  const arrayT: IrType = { kind: "array", elem: F64 };
  const name = dispatchHelper(
    lowerer,
    `idxUnion:${fresh ? "from" : "toArray"}:${unionKey(receiver.type)}`,
    fresh ? "%union.arrayFrom" : "%union.toArray",
    receiver.type,
    arms,
    [],
    arrayT,
    (arm, info) =>
      returning(
        info.type.kind === "bytes"
          ? {
              kind: "bytesIntrinsic",
              method: "toArray",
              receiver: arm,
              args: [],
              type: arrayT,
              loc,
            }
          : fresh
            ? {
                kind: "arrIntrinsic",
                method: "reverse",
                receiver: {
                  kind: "arrIntrinsic",
                  method: "toReversed",
                  receiver: arm,
                  args: [],
                  type: arrayT,
                  loc,
                },
                args: [],
                type: arrayT,
                loc,
              }
            : arm,
        loc,
      ),
    loc,
  );
  return { kind: "call", callee: name, args: [receiver], type: arrayT, loc };
}

/** Whether a dispatch can run in place instead of through a helper call:
 * the receiver is a plain read, so testing and narrowing it once per arm
 * reads the same value, and the other operands are plain reads or
 * literals. The arms' own reads then stay visible to the integer range
 * analysis (a loop bounded by `u.length` keeps an integer counter). */
function inlineDispatch(receiver: IrExpr, operands: readonly IrExpr[]): boolean {
  return (
    receiver.kind === "varRef" && operands.every((e) => e.kind === "varRef" || e.kind === "numLit")
  );
}

/** Expressions that run no program code: reads, literals and operators
 * over primitive values. */
const CODE_FREE_EXPRS = new Set<IrExpr["kind"]>([
  "numLit",
  "boolLit",
  "strLit",
  "unitLit",
  "varRef",
  "unary",
  "logical",
  "ternary",
  "toBool",
  "strEq",
  "strCmp",
  "arrayGet",
  "arrayHas",
  "arrayState",
  "bytesIntrinsic",
  "fieldGet",
  "recordGet",
  "unionNarrow",
  "unionIsTag",
  "unionDisc",
  "upcast",
  "nullish",
]);
const PRIMITIVE_OPERANDS = new Set<IrType["kind"]>(["f64", "bool", "string", "bigint"]);

/** Whether evaluating `e` can rebind one of the plain reads `reads`: by
 * assigning it, or by running program code (a call, a getter, a
 * conversion) that could assign a captured binding. */
function rebinds(e: IrExpr, reads: readonly IrExpr[]): boolean {
  const ids = new Set(reads.flatMap((r) => (r.kind === "varRef" ? [r.localId] : [])));
  let found = false;
  const expr = (x: IrExpr): boolean => {
    if ((x.kind === "assignExpr" || x.kind === "incDec") && ids.has(x.localId)) found = true;
    else if (x.kind === "bin") {
      if (!PRIMITIVE_OPERANDS.has(x.left.type.kind) || !PRIMITIVE_OPERANDS.has(x.right.type.kind))
        found = true;
    } else if (x.kind === "call") {
      // The union dispatch helpers only read and store elements.
      if (!x.callee.startsWith("%union.")) found = true;
    } else if (!CODE_FREE_EXPRS.has(x.kind)) found = true;
    return !found && everyExprChild(x, expr, stmt);
  };
  const stmt = (x: IrStmt): boolean => {
    if ((x.kind === "assign" || x.kind === "varDecl") && ids.has(x.localId)) found = true;
    return !found && everyStmtChild(x, expr, stmt);
  };
  expr(e);
  return found;
}

/** The in-place form of a dispatch: a ternary chain over the arms' tags,
 * the last arm untested. */
function inlineArms(
  receiver: IrExpr,
  arms: readonly IndexedArm[],
  type: IrType,
  arm: (narrowed: IrExpr, info: IndexedArm) => IrExpr,
  loc: SrcLoc,
): IrExpr {
  const union = receiver.type;
  if (union.kind !== "union") throw new Error("indexed-union dispatch over a non-union");
  const narrowed = (info: IndexedArm): IrExpr => ({
    kind: "unionNarrow",
    unionId: union.unionId,
    tag: info.tag,
    value: receiver,
    type: info.type,
    loc,
  });
  let result = arm(narrowed(arms[arms.length - 1]!), arms[arms.length - 1]!);
  for (let i = arms.length - 2; i >= 0; i--) {
    const info = arms[i]!;
    result = {
      kind: "ternary",
      cond: {
        kind: "unionIsTag",
        unionId: union.unionId,
        tag: info.tag,
        negated: false,
        value: receiver,
        type: BOOL,
        loc,
      },
      then: arm(narrowed(info), info),
      else_: result,
      type,
      loc,
    };
  }
  return result;
}
