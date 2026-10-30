import { keyedHelperName } from "../stable-names.js";
import { allBytesArms, indexedUnionArms, lowerIndexedUnionMethod } from "../indexed-unions.js";
import { boolLit, dynUndefinedExpr, nodeThrowExpr, numLit, varRef } from "../../../ir/build.js";
import { BUF_NUM_METHODS } from "./buffer-numeric-methods.js";
import * as ts from "../../ts7/adapter.js";
import { constituentTypes } from "../../ts7/checker.js";
import {
  BIGINT_T,
  BOOL,
  BYTES_ELEMENT_NAME,
  BYTES_U8,
  DYN,
  F64,
  type IrBytesElem,
  type IrBytesIntrinsicMethod,
  type IrExpr,
  type IrLibFn,
  type IrLocal,
  type IrParam,
  type IrFunction,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  bytesOf,
  funcOf,
  isUnitType,
  typeEquals,
} from "../../../ir/ir.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { stdlibGlobalNameOf } from "../surfaces.js";
import type { Lowerer } from "../lowerer.js";
import { ENTRY_NAME, newFnCtx, own } from "../lowerer.js";
import { everyStmt } from "../../../ir/traverse.js";
import { buildBytesSortFn, closureKeyOrder } from "../lower-array-sort.js";
import { isSafeToDiscard } from "../expressions/evaluation-safety.js";
import { lowerDynObjectLiteral } from "../expressions/object-literals.js";
import {
  defaultAfterUndefined,
  lowerOptionalArgument,
  lowerStaticallyUndefinedArgument,
} from "../optional-arguments.js";
import { lowerArraySpreadItems, lowerCheckedArrayFrom } from "./array-construction.js";
import { lowerOptionalNumber, lowerToNumberArgument } from "../lower-exprs.js";
import { lowerBytesIteratorValue } from "../iterator-adapters.js";
import { lowerArrayCallback } from "./callback-arguments.js";
import { callbackSite, findPredicateOk, predicateToBoolean } from "./array-callbacks.js";
import { typeKey } from "../../type-mapper.js";

/** TypedArray.prototype.sort and toSorted. The receiver and comparator
 * expressions are evaluated before entering the helper (buildBytesSortFn).
 * The default order is numeric, so the comparator-less form sorts by value
 * in the runtime, as does a recognized numeric comparator. */
function lowerBytesSortCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  bytesT: IrType & { kind: "bytes" },
): IrExpr {
  const loc = locOf(call);
  const method = access.name.text;
  const copyFirst = method === "toSorted";
  if (call.arguments.nodes.length > 1 || call.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `.${method} with ${call.arguments.nodes.length} arguments on ${BYTES_ELEMENT_NAME[bytesT.elem]}`,
      call,
    );
  }
  const receiver = lowerer.lowerExprExpecting(access.expression, bytesT);
  const undefinedArg = call.arguments.nodes[0]
    ? lowerStaticallyUndefinedArgument(lowerer, call.arguments.nodes[0])
    : null;
  const helperFor = (
    key: string,
    arity: number,
    hasComparator: boolean,
    order: 1 | -1 | null,
  ): string => {
    const cacheKey = `bytes.${method}:${bytesT.elem}:${key}`;
    let helper = lowerer.arrHofHelpers.get(cacheKey);
    if (!helper) {
      helper = keyedHelperName(lowerer, `%bytes.${method}`, cacheKey);
      lowerer.arrHofHelpers.set(cacheKey, helper);
      lowerer.liftedFns.push(
        buildBytesSortFn(helper, bytesT, arity, hasComparator, copyFirst, order, loc),
      );
    }
    return helper;
  };
  if (call.arguments.nodes.length === 0 || undefinedArg) {
    const helper = helperFor("default", 0, false, null);
    if (!undefinedArg || isSafeToDiscard(undefinedArg)) {
      return { kind: "call", callee: helper, args: [receiver], type: bytesT, loc };
    }
    // The default helper takes no comparator argument. Snapshot the
    // receiver into a hidden local so the discarded undefined argument
    // still evaluates after the receiver and before the helper call.
    const saved = lowerer.declareHiddenLocal("%bytesSortRecv", bytesT);
    const savedRef: IrExpr = {
      kind: "varRef",
      localId: saved.id,
      type: bytesT,
      loc,
    };
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: saved.id, init: receiver, loc },
        { kind: "exprStmt", expr: undefinedArg, loc: undefinedArg.loc },
      ],
      result: {
        kind: "call",
        callee: helper,
        args: [savedRef],
        type: bytesT,
        loc,
      },
      type: bytesT,
      loc,
    };
  }
  const argNode = call.arguments.nodes[0]!;
  let fnArg = lowerer.lowerExpr(argNode);
  // As for Array sort: adapt a comparator over checked values to the
  // element ABI; arithmetic on inferred JS values still yields a number.
  if (
    fnArg.type.kind === "func" &&
    fnArg.type.params.length <= 2 &&
    fnArg.type.params.every((param) => lowerer.coercibleValue(F64, param))
  ) {
    const result =
      fnArg.type.ret.kind === "dyn" && isJsSourceFile(ts.getSourceFileOfNode(argNode))
        ? F64
        : fnArg.type.ret;
    const expected = funcOf(
      fnArg.type.params.map(() => F64),
      result,
    );
    if (!typeEquals(fnArg.type, expected)) fnArg = lowerer.coerceToExpected(fnArg, expected);
  }
  if (
    fnArg.type.kind !== "func" ||
    fnArg.type.params.length > 2 ||
    !fnArg.type.params.every((p) => p.kind === "f64") ||
    fnArg.type.ret.kind !== "f64"
  ) {
    lowerer.badType(argNode, lowerer.typeOf(argNode));
  }
  const arity = fnArg.type.params.length;
  const keyed = closureKeyOrder(lowerer.liftedFns, fnArg);
  const order = keyed?.length === 1 && keyed[0]!.read === null ? keyed[0]!.order : null;
  const helper = helperFor(`${arity}${order === null ? "" : `:keyed${order}`}`, arity, true, order);
  return {
    kind: "call",
    callee: helper,
    args: [receiver, fnArg],
    type: bytesT,
    loc,
  };
}

/** The TypedArray.prototype callback methods. */
type BytesCallbackMethod =
  | "forEach"
  | "map"
  | "filter"
  | "some"
  | "every"
  | "find"
  | "findIndex"
  | "findLast"
  | "findLastIndex"
  | "reduce"
  | "reduceRight";

const BYTES_CALLBACK_METHODS: ReadonlySet<string> = new Set<BytesCallbackMethod>([
  "forEach",
  "map",
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "reduce",
  "reduceRight",
]);

/** The typed-array callback methods (forEach, map, filter, some, every,
 * find, findIndex, findLast, findLastIndex, reduce, reduceRight). The
 * receiver, the callback and reduce's initial value evaluate in order
 * before the helper runs. The helper reads the length once (typed arrays
 * have no holes) and each element when it visits it, so the callback's
 * writes show in later elements. The callback receives the element, its
 * index and the typed array (reduce's receive the accumulator first). map
 * and filter return a new typed array of the receiver's kind; map stores
 * each result with the element conversion of that kind. A thisArg keeps
 * the fence, as for arrays. */
function lowerBytesCallbackCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  method: BytesCallbackMethod,
  bytesT: IrType & { kind: "bytes" },
): IrExpr {
  const loc = locOf(call);
  const nArgs = call.arguments.nodes.length;
  const reduce = method === "reduce" || method === "reduceRight";
  if (nArgs < 1 || nArgs > (reduce ? 2 : 1) || call.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `.${method} with ${nArgs} arguments on ${BYTES_ELEMENT_NAME[bytesT.elem]}`,
      call,
      reduce ? undefined : "the thisArg parameter has no lowering — use an arrow function",
    );
  }
  const argNode = call.arguments.nodes[0]!;
  const hasInit = reduce && nArgs === 2;
  const accT = reduce ? (hasInit ? lowerer.irTypeOf(call) : F64) : null;
  if (accT !== null && (accT.kind === "void" || accT.kind === "func"))
    lowerer.badType(call, lowerer.typeOf(call));
  const receiver = lowerer.lowerExprExpecting(access.expression, bytesT);
  const { fnArg, arity } = lowerArrayCallback(
    lowerer,
    argNode,
    accT !== null ? [accT, F64] : [F64],
    bytesT,
    false,
    accT ?? undefined,
  );
  const fnRet = fnArg.type.ret;
  const predicate =
    method === "filter" ||
    method === "some" ||
    method === "every" ||
    method === "find" ||
    method === "findIndex" ||
    method === "findLast" ||
    method === "findLastIndex";
  if (predicate && !findPredicateOk(lowerer, fnRet))
    lowerer.badType(argNode, lowerer.typeOf(argNode));
  if (method === "map" && !lowerer.coercibleValue(F64, fnRet))
    lowerer.badType(argNode, lowerer.typeOf(argNode));
  const resultT: IrType =
    accT ??
    (method === "forEach"
      ? VOID
      : method === "map" || method === "filter"
        ? bytesT
        : method === "some" || method === "every"
          ? BOOL
          : method === "findIndex" || method === "findLastIndex"
            ? F64
            : lowerer.irTypeOf(call));
  const helper = bytesCallbackHelper(
    lowerer,
    method,
    bytesT,
    resultT,
    fnRet,
    arity,
    hasInit,
    loc,
    callbackSite(fnArg),
  );
  const args: IrExpr[] = [receiver, fnArg];
  if (hasInit) args.push(lowerer.lowerExprExpecting(call.arguments.nodes[1]!, resultT));
  return { kind: "call", callee: helper, args, type: resultT, loc };
}

/** The interned helper of one typed-array callback method shape. A literal
 * callback gets a helper of its own (`site`), which the backend then calls
 * directly, as for the array methods. The visit is a loop on its own
 * counter (`for (let i = 0; i < a.length; i++)`, or down from the last
 * index), so the counter is an integer and the element reads need no
 * index test. */
function bytesCallbackHelper(
  lowerer: Lowerer,
  method: BytesCallbackMethod,
  bytesT: IrType & { kind: "bytes" },
  resultT: IrType,
  fnRet: IrType,
  arity: number,
  hasInit: boolean,
  loc: SrcLoc,
  site: string,
): string {
  const key = `bytes.${method}:${bytesT.elem}:${typeKey(resultT)}:${typeKey(fnRet)}:${arity}:${hasInit ? "init" : ""}${site}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, `%bytes.${method}`, key);
  lowerer.arrHofHelpers.set(key, name);
  const reduce = method === "reduce" || method === "reduceRight";
  const backward = method === "reduceRight" || method === "findLast" || method === "findLastIndex";
  const fnT = funcOf(
    (reduce ? [resultT, F64, F64, bytesT] : [F64, F64, bytesT]).slice(0, arity),
    fnRet,
  );
  const keptT = arrayOf(F64);
  const a = (): IrExpr => varRef("a.0", bytesT, loc);
  const i = (): IrExpr => varRef("i.0", F64, loc);
  const n = (): IrExpr => varRef("n.0", F64, loc);
  const acc = (): IrExpr => varRef("acc.0", resultT, loc);
  const element = (): IrExpr => varRef("v.0", F64, loc);
  const at = (index: IrExpr): IrExpr => ({
    kind: "bytesIntrinsic",
    method: "get",
    receiver: a(),
    args: [index],
    type: F64,
    loc,
  });
  const callback = (): IrExpr => ({
    kind: "callValue",
    callee: varRef("f.0", fnT, loc),
    args: (reduce ? [acc(), element(), i(), a()] : [element(), i(), a()]).slice(0, arity),
    type: fnRet,
    loc,
  });
  // The forward bound is the receiver's length itself (fixed for a typed
  // array, and equal to `n`), which the emitter's typed-array loops use.
  const length = (): IrExpr => ({
    kind: "bytesIntrinsic",
    method: "length",
    receiver: a(),
    args: [],
    type: F64,
    loc,
  });
  const inRange = (): IrExpr =>
    backward
      ? { kind: "bin", op: ">=", left: i(), right: numLit(0, loc), type: BOOL, loc }
      : { kind: "bin", op: "<", left: i(), right: length(), type: BOOL, loc };
  const advance = (): IrStmt => ({
    kind: "assign",
    localId: "i.0",
    value: {
      kind: "bin",
      op: backward ? "-" : "+",
      left: i(),
      right: numLit(1, loc),
      type: F64,
      loc,
    },
    loc,
  });
  const ret = (value: IrExpr | null): IrStmt => ({ kind: "return", value, loc });
  // map and filter of a Buffer return a Buffer (Node's species).
  const copyBrand = (out: IrExpr): IrStmt => ({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "bytes.copyBrand", args: [out, a()], type: VOID, loc },
    loc,
  });
  const locals: IrLocal[] = [
    { id: "a.0", name: "a", type: bytesT, mutable: true },
    { id: "f.0", name: "f", type: fnT, mutable: true },
    ...(hasInit ? [{ id: "z.0", name: "z", type: resultT, mutable: true } as IrLocal] : []),
    ...(reduce || method === "map" || method === "filter"
      ? [{ id: "acc.0", name: "acc", type: resultT, mutable: true } as IrLocal]
      : []),
    ...(method === "filter"
      ? [{ id: "kept.0", name: "kept", type: keptT, mutable: true } as IrLocal]
      : []),
    { id: "n.0", name: "n", type: F64, mutable: false },
    { id: "i.0", name: "i", type: F64, mutable: true },
    { id: "v.0", name: "v", type: F64, mutable: true },
  ];
  const params: IrParam[] = [
    { localId: "a.0", name: "a", type: bytesT },
    { localId: "f.0", name: "f", type: fnT },
    ...(hasInit ? [{ localId: "z.0", name: "z", type: resultT }] : []),
  ];
  const visit: IrStmt[] = [{ kind: "assign", localId: "v.0", value: at(i()), loc }];
  let seeded = false;
  const prologue: IrStmt[] = [];
  let epilogue: IrStmt[];
  switch (method) {
    case "forEach":
      visit.push({ kind: "exprStmt", expr: callback(), loc });
      epilogue = [ret(null)];
      break;
    case "map":
      prologue.push({
        kind: "varDecl",
        localId: "acc.0",
        init: { kind: "bytesNew", source: n(), type: bytesT, loc },
        loc,
      });
      visit.push({
        kind: "bytesSet",
        arr: acc(),
        index: i(),
        value: lowerer.coerceToExpected(callback(), F64),
        loc,
      });
      if (bytesT.elem === "u8") prologue.push(copyBrand(acc()));
      epilogue = [ret(acc())];
      break;
    case "filter":
      prologue.push({
        kind: "varDecl",
        localId: "kept.0",
        init: { kind: "arrayLit", elems: [], type: keptT, loc },
        loc,
      });
      visit.push({
        kind: "if",
        cond: predicateToBoolean(callback()),
        then: [
          {
            kind: "exprStmt",
            expr: {
              kind: "arrIntrinsic",
              method: "push",
              receiver: varRef("kept.0", keptT, loc),
              args: [element()],
              type: F64,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      });
      epilogue = [
        {
          kind: "varDecl",
          localId: "acc.0",
          init: { kind: "bytesNew", source: varRef("kept.0", keptT, loc), type: bytesT, loc },
          loc,
        },
        ...(bytesT.elem === "u8" ? [copyBrand(acc())] : []),
        ret(acc()),
      ];
      break;
    case "some":
    case "every": {
      const found = method === "some";
      const test = predicateToBoolean(callback());
      visit.push({
        kind: "if",
        cond: found ? test : { kind: "unary", op: "!", operand: test, type: BOOL, loc },
        then: [ret(boolLit(found, loc))],
        else_: null,
        loc,
      });
      epilogue = [ret(boolLit(!found, loc))];
      break;
    }
    case "find":
    case "findLast":
      visit.push({
        kind: "if",
        cond: predicateToBoolean(callback()),
        then: [ret(lowerer.coerceToExpected(element(), resultT))],
        else_: null,
        loc,
      });
      epilogue = [
        ret(
          lowerer.coerceToExpected(
            { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
            resultT,
          ),
        ),
      ];
      break;
    case "findIndex":
    case "findLastIndex":
      visit.push({
        kind: "if",
        cond: predicateToBoolean(callback()),
        then: [ret(i())],
        else_: null,
        loc,
      });
      epilogue = [ret(numLit(-1, loc))];
      break;
    case "reduce":
    case "reduceRight":
      if (hasInit) {
        prologue.push({
          kind: "varDecl",
          localId: "acc.0",
          init: varRef("z.0", resultT, loc),
          loc,
        });
      } else {
        // The seed is the first visited element; the loop starts past it.
        seeded = true;
        prologue.push(
          {
            kind: "if",
            cond: { kind: "bin", op: "===", left: n(), right: numLit(0, loc), type: BOOL, loc },
            then: [
              {
                kind: "throw",
                value: {
                  kind: "libCall",
                  fn: "error.new",
                  args: [
                    {
                      kind: "strLit",
                      value: "Reduce of empty array with no initial value",
                      type: STRING,
                      loc,
                    },
                  ],
                  type: { kind: "object", className: "%TypeError" },
                  loc,
                },
                loc,
              },
            ],
            else_: null,
            loc,
          },
          {
            kind: "varDecl",
            localId: "acc.0",
            init: at(
              backward
                ? { kind: "bin", op: "-", left: n(), right: numLit(1, loc), type: F64, loc }
                : numLit(0, loc),
            ),
            loc,
          },
        );
      }
      visit.push({
        kind: "assign",
        localId: "acc.0",
        value: lowerer.coerceToExpected(callback(), resultT),
        loc,
      });
      epilogue = [ret(acc())];
      break;
  }
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "n.0",
      init: { kind: "bytesIntrinsic", method: "length", receiver: a(), args: [], type: F64, loc },
      loc,
    },
    { kind: "varDecl", localId: "v.0", init: numLit(0, loc), loc },
    ...prologue,
    {
      kind: "for",
      init: {
        kind: "varDecl",
        localId: "i.0",
        init: backward
          ? {
              kind: "bin",
              op: "-",
              left: n(),
              right: numLit(seeded ? 2 : 1, loc),
              type: F64,
              loc,
            }
          : numLit(seeded ? 1 : 0, loc),
        loc,
      },
      cond: inRange(),
      update: advance(),
      body: visit,
      loc,
    },
    ...epilogue,
  ];
  lowerer.liftedFns.push({ name, params, returnType: resultT, locals, body, loc });
  return name;
}

/* ── typed arrays / Buffer ─────────────────────────────────────────────── */

/** The typed-array constructors with a runtime representation, by lib
 * interface name. Other flavors (BigInt64Array, BigUint64Array) fall through
 * to the generic stdlib-constructor fence. DataView is handled separately. */
const BYTES_CTORS: Record<string, IrBytesElem | undefined> = {
  Uint8Array: "u8",
  Uint8ClampedArray: "u8c",
  Int8Array: "i8",
  Uint16Array: "u16",
  Int16Array: "i16",
  Uint32Array: "u32",
  Int32Array: "i32",
  Float16Array: "f16",
  Float32Array: "f32",
  Float64Array: "f64",
};

/** Numeric typed-array constructors
 * (stdlib provenance — a user's own class with the name resolves through
 * classBySymbol). Lowered argument shapes: none (empty), a length
 * (zero-filled; ToIndex at runtime — invalid lengths throw Node's
 * RangeError), a numeric typed array or Buffer (an independent COPY —
 * the readFile chain's `new Uint8Array(await readFile(p))`), a number[]
 * literal (element-coerced; its contextual type is the lib's
 * ArrayLike/Iterable union, which cannot map — the Set-seed pattern), or
 * a number[]-typed value, or checked native input with runtime length /
 * array-like dispatch. ArrayBuffer inputs create shared views.
 * Null when this isn't a stdlib
 * typed-array construction. */
export function lowerBytesNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
  symbol: ts.Symbol | null | undefined,
): IrExpr | null {
  if (
    symbol != null &&
    (ts.symbolName(symbol) === "ArrayBuffer" || ts.symbolName(symbol) === "SharedArrayBuffer") &&
    lowerer.isStdlibSymbol(symbol)
  ) {
    const args = expr.arguments?.nodes ?? [];
    if (args.length > 1 || args.some(ts.isSpreadElement)) {
      lowerer.noLowering(
        "resizable ArrayBuffer construction",
        expr,
        "fixed-length ArrayBuffers accept a byte length; resizable storage is not supported yet",
      );
    }
    const length = args[0]
      ? lowerer.coerceInto(args[0], lowerer.lowerExpr(args[0]), DYN)
      : dynUndefinedExpr(locOf(expr));
    return {
      kind: "libCall",
      fn:
        ts.symbolName(symbol) === "SharedArrayBuffer" ? "sharedArrayBuffer.new" : "arrayBuffer.new",
      args: [length],
      type: DYN,
      loc: locOf(expr),
    };
  }
  if (symbol && ts.symbolName(symbol) === "DataView" && lowerer.isStdlibSymbol(symbol)) {
    return lowerDataViewNew(lowerer, expr);
  }
  const elem = symbol ? own(BYTES_CTORS, ts.symbolName(symbol)) : undefined;
  if (!elem || !symbol || !lowerer.isStdlibSymbol(symbol)) return null;
  const name = ts.symbolName(symbol);
  const type = bytesOf(elem);
  const loc = locOf(expr);
  const args = expr.arguments?.nodes ?? [];
  if (args.length === 0) return { kind: "bytesNew", source: null, type, loc };
  if (args.length >= 2 && args.length <= 3 && !args.some(ts.isSpreadElement)) {
    return lowerArrayBufferView(lowerer, args, elem, loc);
  }
  if (args.length === 1 && !ts.isSpreadElement(args[0]!)) {
    const argNode = args[0]!;
    if (ts.isArrayLiteralExpression(argNode) && !argNode.elements.nodes.some(ts.isSpreadElement)) {
      const elems = argNode.elements.nodes.map((el) => lowerer.lowerExprExpecting(el, F64));
      const seed: IrExpr = { kind: "arrayLit", elems, type: arrayOf(F64), loc };
      return { kind: "bytesNew", source: seed, type, loc };
    }
    const src = lowerer.lowerExpr(argNode);
    if (src.type.kind === "union") {
      const arms = lowerer.unions.get(src.type.unionId)?.arms;
      if (
        arms?.every(
          (arm) =>
            arm.kind === "f64" ||
            arm.kind === "bytes" ||
            typeEquals(arm, UNDEFINED_T) ||
            (arm.kind === "array" && arm.elem.kind === "f64"),
        )
      ) {
        // The checked constructor dispatch preserves each arm's copy or
        // length semantics, including undefined -> empty, and evaluates
        // an effectful source expression exactly once.
        return { kind: "bytesNew", source: lowerer.coerceInto(argNode, src, DYN), type, loc };
      }
    }
    if (
      src.type.kind === "f64" ||
      src.type.kind === "bytes" ||
      src.type.kind === "dyn" ||
      (src.type.kind === "array" && src.type.elem.kind === "f64")
    ) {
      return { kind: "bytesNew", source: src, type, loc };
    }
    lowerer.noLowering(
      `new ${name} over '${lowerer.fmt(src.type)}' values`,
      argNode,
      `supported: new ${name}(), (length), (typedArray) — always a copy — or (number[]); ` +
        "or (ArrayBuffer, byteOffset?, length?) for shared storage (narrow unions first)",
    );
  }
  lowerer.noLowering(
    `new ${name} with ${args.length} arguments`,
    expr,
    `supported: new ${name}(), (length), (typedArray), or (number[])`,
  );
}

/** TypedArray.from and TypedArray.of. Preserve from's iterable /
 * array-like semantics separately from constructor length coercion. */
export function lowerBytesStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(call, access)) return null;
  if (lowerer.isStdlibGlobal(access.expression, "ArrayBuffer") && access.name.text === "isView") {
    if (call.arguments.nodes.length !== 1 || call.arguments.nodes.some(ts.isSpreadElement))
      lowerer.noLowering("ArrayBuffer.isView argument count", call);
    const arg = call.arguments.nodes[0]!;
    return {
      kind: "libCall",
      fn: "arrayBuffer.isView",
      args: [lowerer.coerceInto(arg, lowerer.lowerExpr(arg), DYN)],
      type: BOOL,
      loc: locOf(call),
    };
  }
  if (
    (access.name.text !== "from" && access.name.text !== "of") ||
    !ts.isIdentifier(access.expression)
  )
    return null;
  const symbol = lowerer.resolveValueSymbol(access.expression);
  const elem = symbol ? own(BYTES_CTORS, ts.symbolName(symbol)) : undefined;
  if (!elem || !lowerer.isStdlibSymbol(symbol ?? undefined)) return null;
  if (access.name.text === "of") return lowerBytesOf(lowerer, call, elem);
  if (
    call.arguments.nodes.length < 1 ||
    call.arguments.nodes.length > 3 ||
    call.arguments.nodes.some(ts.isSpreadElement)
  ) {
    lowerer.noLowering("TypedArray.from with this argument count", call);
  }
  const node = call.arguments.nodes[0]!;
  const source = lowerer.lowerExpr(node);
  if (call.arguments.nodes.length > 1) {
    if (!["string", "array", "bytes"].includes(source.type.kind))
      lowerer.noLowering("TypedArray.from mapper over this source representation", call);
    const loc = locOf(call);
    const key = `%builtin.${elem}.fromMapped`;
    if (!lowerer.liftedFns.some((fn) => fn.name === key)) {
      const context = newFnCtx(false, null, null, bytesOf(elem));
      lowerer.fnStack.push(context);
      try {
        const locals = ["source", "mapper", "receiver"].map((name) =>
          lowerer.declareHiddenLocal(name, DYN),
        );
        const [input, mapper, receiver] = locals.map((local) => varRef(local.id, DYN, loc));
        const collected = lowerCheckedArrayFrom(lowerer, input!, loc);
        const mapped = lowerCheckedArrayFrom(
          lowerer,
          collected.result,
          loc,
          mapper!,
          receiver!,
          true,
        );
        // Consume the iterable before mapping, but validate the mapper first.
        lowerer.liftedFns.push({
          name: key,
          params: locals.map((local) => ({ localId: local.id, name: local.name, type: DYN })),
          returnType: bytesOf(elem),
          locals: context.locals,
          loc,
          body: [
            mapped.stmts[0]!,
            ...collected.stmts,
            ...mapped.stmts.slice(1),
            {
              kind: "return",
              value: {
                kind: "bytesNew",
                source: mapped.result,
                from: true,
                type: bytesOf(elem),
                loc,
              },
              loc,
            },
          ],
        });
      } finally {
        lowerer.fnStack.pop();
      }
    }
    return {
      kind: "call",
      callee: key,
      args: [
        lowerer.coerceInto(node, source, DYN),
        lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN),
        call.arguments.nodes[2]
          ? lowerer.lowerExprExpecting(call.arguments.nodes[2], DYN)
          : dynUndefinedExpr(loc),
      ],
      type: bytesOf(elem),
      loc,
    };
  }
  if (
    source.type.kind === "bytes" ||
    (source.type.kind === "array" && source.type.elem.kind === "f64")
  ) {
    return { kind: "bytesNew", source, type: bytesOf(elem), loc: locOf(call) };
  }
  return {
    kind: "bytesNew",
    source: lowerer.coerceInto(node, source, DYN),
    from: true,
    type: bytesOf(elem),
    loc: locOf(call),
  };
}

/** TypedArray.of: a new array of the arguments, each converted with ToNumber
 * in argument order after all of them are evaluated. Numbers copy directly;
 * other values (and spread items) collect into an array that goes through
 * TypedArray.from's conversion, which calls valueOf/toString the same way. */
function lowerBytesOf(lowerer: Lowerer, call: ts.CallExpression, elem: IrBytesElem): IrExpr {
  const loc = locOf(call);
  const nodes = call.arguments.nodes;
  const type = bytesOf(elem);
  if (nodes.some(ts.isSpreadElement)) {
    const numeric = nodes.every((node) => {
      const mapped = lowerer.mapTypeOf(
        lowerer.typeOf(ts.isSpreadElement(node) ? node.expression : node),
      );
      return ts.isSpreadElement(node)
        ? mapped?.kind === "array" && mapped.elem.kind === "f64"
        : mapped?.kind === "f64";
    });
    const elemType = numeric ? F64 : DYN;
    const items = lowerArraySpreadItems(
      lowerer,
      nodes,
      elemType,
      { kind: "array", elem: elemType },
      loc,
    );
    if (numeric) return { kind: "bytesNew", source: items, type, loc };
    return {
      kind: "bytesNew",
      source: lowerer.coerceToExpected(items, DYN),
      from: true,
      type,
      loc,
    };
  }
  const values = nodes.map((node) => lowerer.lowerExpr(node));
  if (values.every((value) => value.type.kind === "f64")) {
    return {
      kind: "bytesNew",
      source: { kind: "arrayLit", elems: values, type: arrayOf(F64), loc },
      type,
      loc,
    };
  }
  const elems = values.map((value, i) => lowerer.coerceInto(nodes[i]!, value, DYN));
  return {
    kind: "bytesNew",
    source: lowerer.coerceToExpected({ kind: "arrayLit", elems, type: arrayOf(DYN), loc }, DYN),
    from: true,
    type,
    loc,
  };
}

/** Construct a view over the complete branded backing allocation. */
function lowerArrayBufferView(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  elem: IrBytesElem | "dv",
  loc: SrcLoc,
): IrExpr {
  const values = [0, 1, 2].map((index) => {
    const node = args[index];
    return node ? lowerer.coerceInto(node, lowerer.lowerExpr(node), DYN) : dynUndefinedExpr(loc);
  });
  const fn = {
    u8c: "arrayBuffer.viewU8C",
    i8: "arrayBuffer.viewI8",
    u16: "arrayBuffer.viewU16",
    i16: "arrayBuffer.viewI16",
    u8: "arrayBuffer.viewU8",
    u32: "arrayBuffer.viewU32",
    i32: "arrayBuffer.viewI32",
    f16: "arrayBuffer.viewF16",
    f32: "arrayBuffer.viewF32",
    f64: "arrayBuffer.viewF64",
    dv: "arrayBuffer.viewDV",
  } as const;
  return {
    kind: "libCall",
    fn: fn[elem],
    args: values,
    type: elem === "dv" ? BYTES_U8 : bytesOf(elem),
    loc,
  };
}

function lowerDataViewNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr {
  const args = expr.arguments?.nodes ?? [];
  if (!args.length || args.length > 3 || args.some(ts.isSpreadElement))
    lowerer.noLowering("DataView constructor argument count", expr);
  return lowerArrayBufferView(lowerer, args, "dv", locOf(expr));
}

/** `receiver.set(src, offset?)` on a lowered typed-array receiver. */
function bytesSetIntrinsic(
  lowerer: Lowerer,
  receiver: IrExpr,
  argNodes: readonly ts.Expression[],
  loc: SrcLoc,
): IrExpr {
  const src = lowerer.lowerExpr(argNodes[0]!);
  const method = src.type.kind === "bytes" ? "setFrom" : "setFromDyn";
  const args = [src.type.kind === "bytes" ? src : lowerer.coerceInto(argNodes[0]!, src, DYN)];
  if (argNodes.length === 2)
    args.push(
      lowerOptionalArgument(lowerer, argNodes[1]!, F64, {
        kind: "numLit",
        value: 0,
        type: F64,
        loc,
      }),
    );
  return { kind: "bytesIntrinsic", method, receiver, args, type: VOID, loc };
}

/** `Uint8Array.prototype.set.call(target, src, offset?)`, through any typed
 * array constructor's prototype (they share %TypedArray%.prototype.set). A
 * target the checker types as a typed array or Buffer lowers like
 * `target.set(src, offset)`. Any other target, a DataView included, is
 * checked at run time: a typed array calls its `set`, and
 * anything else throws Node's TypeError "this is not a typed array.",
 * after every argument is evaluated. */
export function lowerBytesPrototypeSetCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (
    call.questionDotToken ||
    access.questionDotToken ||
    access.name.text !== "call" ||
    !ts.isPropertyAccessExpression(access.expression)
  )
    return null;
  const method = access.expression;
  const proto = method.expression;
  if (
    method.questionDotToken ||
    method.name.text !== "set" ||
    !ts.isPropertyAccessExpression(proto) ||
    proto.questionDotToken ||
    proto.name.text !== "prototype" ||
    !ts.isIdentifier(proto.expression) ||
    !lowerer.isStdlibMember(method)
  )
    return null;
  const ctor = lowerer.resolveValueSymbol(proto.expression);
  if (!ctor || !lowerer.isStdlibSymbol(ctor) || !own(BYTES_CTORS, ts.symbolName(ctor))) return null;
  const argNodes = call.arguments.nodes;
  if (argNodes.length < 2 || argNodes.length > 3 || argNodes.some(ts.isSpreadElement)) return null;
  const loc = locOf(call);
  const target = lowerer.lowerExpr(argNodes[0]!);
  // A DataView lowers to the same bytes type, so the checker type decides:
  // only a typed array (or a Buffer) takes the method's path.
  const targetSymbol = lowerer.typeOf(argNodes[0]!).getSymbol();
  if (
    target.type.kind === "bytes" &&
    targetSymbol !== undefined &&
    lowerer.isStdlibSymbol(targetSymbol) &&
    (own(BYTES_CTORS, ts.symbolName(targetSymbol)) !== undefined ||
      ts.symbolName(targetSymbol) === "Buffer")
  )
    return bytesSetIntrinsic(lowerer, target, argNodes.slice(1), loc);
  const slot = (value: IrExpr): { decl: IrStmt; read: IrExpr } => {
    const local = lowerer.declareHiddenLocal("%setArg", DYN);
    return {
      decl: { kind: "varDecl", localId: local.id, init: value, loc },
      read: varRef(local.id, DYN, loc),
    };
  };
  const slots = [
    slot(lowerer.coerceInto(argNodes[0]!, target, DYN)),
    ...argNodes.slice(1).map((arg) => slot(lowerer.lowerExprExpecting(arg, DYN))),
  ];
  const isTypedArray: IrExpr = {
    kind: "libCall",
    fn: "util.typeIs",
    args: [slots[0]!.read, { kind: "strLit", value: "isTypedArray", type: STRING, loc }],
    type: BOOL,
    loc,
  };
  return {
    kind: "seqExpr",
    stmts: [
      ...slots.map((s) => s.decl),
      {
        kind: "if",
        cond: { kind: "unary", op: "!", operand: isTypedArray, type: BOOL, loc },
        then: [
          {
            kind: "exprStmt",
            expr: nodeThrowExpr(1, "", "this is not a typed array.", VOID, loc),
            loc,
          },
        ],
        else_: null,
        loc,
      },
    ],
    result: {
      kind: "dynInvoke",
      recv: slots[0]!.read,
      method: "set",
      calleeName: ts.getTextOfNode(method),
      args: slots.slice(1).map((s) => s.read),
      type: DYN,
      loc,
    },
    type: DYN,
    loc,
  };
}

/** Method calls on typed-array/Buffer receivers: slice (copy), subarray
 * (shared view), toReversed, copyWithin, set(src,
 * offset?), and the u8-only Buffer surface: toString(enc?) plus the
 * whole numeric read/write family (fixed widths BE/LE and the
 * variable-width read/writeUIntLE quartet — BUF_NUM_METHODS). Everything
 * else the lib declares (fill, indexOf, reverse, ...) falls through to
 * the SC2020 member fence. Null when this isn't a bytes method call. */
/** The [needle, fromIndex] arguments of TypedArray indexOf, lastIndexOf
 * and includes. A present fromIndex converts even when it is undefined
 * (NaN, which ToIntegerOrInfinity makes 0); an absent one is 0, or
 * +Infinity for lastIndexOf, which starts at the last element. */
function elementSearchArgs(lowerer: Lowerer, call: ts.CallExpression, name: string): IrExpr[] {
  const nodes = call.arguments.nodes;
  const loc = locOf(call);
  const needle = lowerer.lowerExprExpecting(nodes[0]!, F64);
  const from: IrExpr = nodes[1]
    ? lowerOptionalNumber(lowerer, lowerer.lowerExpr(nodes[1]), locOf(nodes[1]), nodes[1])
    : ({
        kind: "numLit",
        value: name === "lastIndexOf" ? Infinity : 0,
        type: F64,
        loc,
      } satisfies IrExpr);
  // An undefined fromIndex is NaN once converted, which starts at 0.
  if (from.kind === "unitLit") return [needle, { kind: "numLit", value: NaN, type: F64, loc }];
  if (from.type.kind === "undefinedT" || from.type.kind === "void")
    return [
      needle,
      {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: from, loc }],
        result: { kind: "numLit", value: NaN, type: F64, loc },
        type: F64,
        loc,
      },
    ];
  if (from.type.kind !== "f64") lowerer.noLowering(`.${name} with a non-number fromIndex`, call);
  return [needle, from];
}

const ELEMENT_SEARCHES: Readonly<Record<string, IrBytesIntrinsicMethod>> = {
  indexOf: "indexOfElem",
  lastIndexOf: "lastIndexOfElem",
  includes: "includesElem",
};

/** Whether a union has a Buffer arm, under any alias name: each arm's own
 * symbol names it. */
function hasBufferArm(type: ts.Type): boolean {
  const arms = type.flags & ts.TypeFlags.Union ? constituentTypes(type) : [type];
  return arms.some((arm) => {
    const symbol = arm.getSymbol();
    return symbol !== undefined && ts.symbolName(symbol) === "Buffer";
  });
}

/** The element-kind-generic typed-array methods on a union of typed
 * arrays (indexed-unions.ts): the arguments lower as for one typed array,
 * and each arm runs the method on its own receiver. Null for the methods
 * that need a narrowing to one kind first. */
function lowerUnionBytesMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  name: string,
): IrExpr | null {
  if (isJsSourceFile(ts.getSourceFileOfNode(call))) return null;
  // A Buffer arm's methods differ from a typed array's (slice aliases, fill
  // checks its range, searches take strings and wrap numbers), so such a
  // union narrows to its arms first.
  if (hasBufferArm(lowerer.typeOf(access.expression))) return null;
  const nodes = call.arguments.nodes;
  if (nodes.some(ts.isSpreadElement)) return null;
  const loc = locOf(call);
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const optional = (i: number, fallback: IrExpr, type: IrType = F64): IrExpr =>
    nodes[i] ? lowerOptionalArgument(lowerer, nodes[i]!, type, fallback) : fallback;
  let method: IrBytesIntrinsicMethod;
  let args: () => IrExpr[];
  let result: "receiver" | IrType;
  if ((name === "slice" || name === "subarray") && nodes.length <= 2) {
    method = name;
    args = () => [optional(0, num(0)), optional(1, num(Infinity))];
    result = "receiver";
  } else if (name === "fill" && nodes.length <= 3) {
    method = "fillElem";
    args = () => [optional(0, num(0)), optional(1, num(0)), optional(2, num(Infinity))];
    result = "receiver";
  } else if (name === "copyWithin" && nodes.length <= 3) {
    method = "copyWithin";
    args = () => [optional(0, num(0)), optional(1, num(0)), optional(2, num(Infinity))];
    result = "receiver";
  } else if (name === "toReversed" && nodes.length === 0) {
    method = "toReversed";
    args = () => [];
    result = "receiver";
  } else if (Object.hasOwn(ELEMENT_SEARCHES, name) && (nodes.length === 1 || nodes.length === 2)) {
    method = ELEMENT_SEARCHES[name]!;
    args = () => elementSearchArgs(lowerer, call, name);
    result = name === "includes" ? BOOL : F64;
  } else if (name === "join" && nodes.length <= 1) {
    method = "join";
    args = () => [optional(0, { kind: "strLit", value: ",", type: STRING, loc }, STRING)];
    result = STRING;
  } else if (name === "set" && (nodes.length === 1 || nodes.length === 2)) {
    const source = lowerer.mapTypeOf(lowerer.typeOf(nodes[0]!));
    method = source?.kind === "bytes" ? "setFrom" : "setFromDyn";
    args = () => {
      const src = lowerer.lowerExpr(nodes[0]!);
      const first = src.type.kind === "bytes" ? src : lowerer.coerceInto(nodes[0]!, src, DYN);
      return nodes.length === 2 ? [first, optional(1, num(0))] : [first];
    };
    result = VOID;
  } else return null;
  const receiver = lowerer.lowerExpr(access.expression);
  const arms = indexedUnionArms(lowerer, receiver.type);
  if (!arms || !allBytesArms(arms)) return null;
  return lowerIndexedUnionMethod(lowerer, receiver, arms, method, args(), result, loc);
}

export function lowerBytesMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(access, call)) return null;
  const name = access.name.text;
  const receiverIr = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  const unionArms = receiverIr ? indexedUnionArms(lowerer, receiverIr) : null;
  if (unionArms && allBytesArms(unionArms) && lowerer.isStdlibMember(access))
    return lowerUnionBytesMethodCall(lowerer, call, access, name);
  if (receiverIr?.kind !== "bytes") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const loc = locOf(call);
  const nArgs = call.arguments.nodes.length;
  // Encoded stream callbacks can receive strings even when JavaScript's
  // contextual inference still describes their parameter as a Buffer.
  if (name === "toString" && nArgs <= 1 && isJsSourceFile(ts.getSourceFileOfNode(call))) {
    const lowered = lowerer.lowerExpr(access.expression);
    const receiver =
      lowered.kind === "dynCheck" && lowered.value.type.kind === "dyn" ? lowered.value : lowered;
    if (receiver.type.kind === "dyn")
      return {
        kind: "libCall",
        fn: "dyn.toString",
        args: [
          receiver,
          call.arguments.nodes[0]
            ? lowerer.lowerExprExpecting(call.arguments.nodes[0], DYN)
            : dynUndefinedExpr(loc),
          { kind: "strLit", value: ts.getTextOfNode(access), type: STRING, loc },
        ],
        type: STRING,
        loc,
      };
  }
  if (name === "sort" || name === "toSorted") {
    return lowerBytesSortCall(lowerer, call, access, receiverIr);
  }
  if (BYTES_CALLBACK_METHODS.has(name)) {
    return lowerBytesCallbackCall(lowerer, call, access, name as BytesCallbackMethod, receiverIr);
  }
  // values()/keys()/entries() as iterator objects (for...of heads and
  // stored numeric iterators lower before this).
  if ((name === "values" || name === "keys" || name === "entries") && nArgs === 0) {
    const type = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (type?.kind === "generator") {
      const value = lowerBytesIteratorValue(
        lowerer,
        lowerer.lowerExpr(access.expression),
        name,
        type,
        loc,
      );
      if (value) return value;
    }
  }
  // TypedArray indexOf / lastIndexOf / includes (the Buffer-declared forms,
  // which also take string and Buffer needles, lowered above).
  if (
    Object.hasOwn(ELEMENT_SEARCHES, name) &&
    !lowerer.checker
      .getSymbolAtLocation(access.name)
      ?.declarations.some(
        (d) => ts.isInterfaceDeclaration(d.parent) && d.parent.name.text === "Buffer",
      )
  ) {
    if (nArgs < 1 || nArgs > 2 || call.arguments.nodes.some(ts.isSpreadElement)) {
      lowerer.noLowering(`.${name} with ${nArgs} arguments on typed arrays`, call);
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, receiverIr);
    return {
      kind: "bytesIntrinsic",
      method: ELEMENT_SEARCHES[name]!,
      receiver,
      args: elementSearchArgs(lowerer, call, name),
      type: name === "includes" ? BOOL : F64,
      loc,
    };
  }
  if (name === "toReversed") {
    if (nArgs !== 0) {
      lowerer.noLowering(`.toReversed with ${nArgs} arguments on typed arrays`, call);
    }
    return {
      kind: "bytesIntrinsic",
      method: "toReversed",
      receiver: lowerer.lowerExprExpecting(access.expression, receiverIr),
      args: [],
      type: receiverIr,
      loc,
    };
  }
  if (receiverIr.elem === "u8" && name === "with") {
    if (nArgs !== 2 || call.arguments.nodes.some(ts.isSpreadElement)) {
      lowerer.noLowering(`.with with ${nArgs} arguments on Uint8Array`, call);
    }
    return {
      kind: "bytesIntrinsic",
      method: "with",
      receiver: lowerer.lowerExprExpecting(access.expression, receiverIr),
      args: [
        lowerer.lowerExprExpecting(call.arguments.nodes[0]!, F64),
        lowerer.lowerExprExpecting(call.arguments.nodes[1]!, F64),
      ],
      type: receiverIr,
      loc,
    };
  }
  if (name === "join") {
    if (nArgs > 1 || call.arguments.nodes.some(ts.isSpreadElement)) {
      lowerer.noLowering(`.join with ${nArgs} arguments on typed arrays`, call);
    }
    const separatorDefault: IrExpr = {
      kind: "strLit",
      value: ",",
      type: STRING,
      loc,
    };
    const separator = call.arguments.nodes[0]
      ? lowerOptionalArgument(lowerer, call.arguments.nodes[0], STRING, separatorDefault)
      : separatorDefault;
    return {
      kind: "bytesIntrinsic",
      method: "join",
      receiver: lowerer.lowerExprExpecting(access.expression, receiverIr),
      args: [separator],
      type: STRING,
      loc,
    };
  }
  if (name === "slice" || name === "subarray") {
    if (nArgs > 2) {
      lowerer.noLowering(`.${name} with ${nArgs} arguments on typed arrays`, call);
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, receiverIr);
    // A missing start is 0 and a missing end is the length (+Infinity
    // clamps to it), as for omitted arguments.
    const args = call.arguments.nodes.map((a, i) =>
      lowerOptionalArgument(lowerer, a, F64, {
        kind: "numLit",
        value: i === 0 ? 0 : Infinity,
        type: F64,
        loc,
      }),
    );
    // subarray is a VIEW (TypedArray.prototype.subarray aliases), and
    // Buffer's slice() is subarray's deprecated Node alias — resolved by
    // where the member is declared, the toString discipline below. Only
    // the plain typed arrays' slice() copies (JS-exact).
    const declaredOnBuffer =
      name === "slice" &&
      (() => {
        const nameSym = lowerer.checker.getSymbolAtLocation(access.name);
        return (
          nameSym !== undefined &&
          nameSym.declarations.some(
            (d) => ts.isInterfaceDeclaration(d.parent) && d.parent.name.text === "Buffer",
          )
        );
      })();
    const method = name === "subarray" || declaredOnBuffer ? "subarray" : "slice";
    return { kind: "bytesIntrinsic", method, receiver, args, type: receiverIr, loc };
  }
  if (name === "copyWithin") {
    if (nArgs > 3 || call.arguments.nodes.some(ts.isSpreadElement)) {
      lowerer.noLowering(`.copyWithin with ${nArgs} arguments on typed arrays`, call);
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, receiverIr);
    const args = [0, 0, Infinity].map((value, i) => {
      const fallback: IrExpr = { kind: "numLit", value, type: F64, loc };
      const node = call.arguments.nodes[i];
      return node ? lowerOptionalArgument(lowerer, node, F64, fallback) : fallback;
    });
    return { kind: "bytesIntrinsic", method: "copyWithin", receiver, args, type: receiverIr, loc };
  }
  if (
    name === "fill" &&
    !(() => {
      const symbol = lowerer.checker.getSymbolAtLocation(access.name);
      return (
        symbol !== undefined &&
        symbol.declarations.some(
          (declaration) =>
            ts.isInterfaceDeclaration(declaration.parent) &&
            declaration.parent.name.text === "Buffer",
        )
      );
    })()
  ) {
    // Typed arrays use element coercion and relative, clamped indices.
    // Buffer's same-named method keeps its pattern and offset validation.
    if (nArgs > 3 || call.arguments.nodes.some(ts.isSpreadElement)) {
      lowerer.noLowering(`.fill with ${nArgs} arguments on typed arrays`, call);
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, receiverIr);
    const zero: IrExpr = { kind: "numLit", value: 0, type: F64, loc };
    const v = call.arguments.nodes[0]
      ? lowerOptionalArgument(lowerer, call.arguments.nodes[0], F64, zero)
      : zero;
    const idx = call.arguments.nodes.slice(1).map((a, i) =>
      lowerOptionalArgument(lowerer, a, F64, {
        kind: "numLit",
        value: i === 0 ? 0 : Infinity,
        type: F64,
        loc,
      }),
    );
    return {
      kind: "bytesIntrinsic",
      method: "fillElem",
      receiver,
      args: [v, ...idx],
      type: receiverIr,
      loc,
    };
  }
  if (name === "set") {
    if (nArgs < 1 || nArgs > 2) {
      lowerer.noLowering(`.set with ${nArgs} arguments on typed arrays`, call);
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, receiverIr);
    return bytesSetIntrinsic(lowerer, receiver, call.arguments.nodes, loc);
  }
  if (name === "toString") {
    // Buffer's toString(encoding?) — utf8 by default. A 0-arg toString
    // resolved against the plain Uint8Array interface is JS's
    // Array-toString (comma join), a different operation: fenced.
    const declaredOnBuffer = (() => {
      const nameSym = lowerer.checker.getSymbolAtLocation(access.name);
      if (
        nameSym !== undefined &&
        nameSym.declarations.some(
          (d) => ts.isInterfaceDeclaration(d.parent) && d.parent.name.text === "Buffer",
        )
      )
        return true;
      // A receiver the lowering types as a Buffer where the checker says
      // `any` (a JavaScript pipeline stage's chunk).
      const receiverSym = lowerer.typeOf(access.expression).getSymbol();
      return (
        receiverSym !== undefined &&
        ts.symbolName(receiverSym) === "Buffer" &&
        receiverSym.declarations.some((d) => lowerer.isStdlibFile(ts.getSourceFileOfNode(d)))
      );
    })();
    if (receiverIr.elem !== "u8" || !declaredOnBuffer) {
      lowerer.noLowering(
        "typed-array toString",
        call,
        'Buffer.from(x).toString("utf8" | "hex" | "base64") is the lowered string conversion',
      );
    }
    if (nArgs > 3) lowerer.noLowering(`.toString with ${nArgs} arguments on Buffers`, call);
    const receiver = lowerer.lowerExprExpecting(access.expression, receiverIr);
    const encNode = call.arguments.nodes[0];
    let method: IrBytesIntrinsicMethod = "toString";
    let enc: IrExpr = { kind: "strLit", value: "utf8", type: STRING, loc };
    if (encNode) {
      const encType = lowerer.typeOf(encNode);
      const encName = encType.isStringLiteralType() ? knownBufEncoding(encType.value) : undefined;
      if (encName !== undefined) {
        // Keep literals on the canonical, non-throwing fast path.
        enc = defaultAfterUndefined(lowerer.lowerExpr(encNode), {
          kind: "strLit",
          value: encName,
          type: STRING,
          loc,
        });
      } else {
        const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, encNode);
        if (undefinedArg) {
          // An explicit undefined is the omitted-encoding default. Keep
          // the canonical, non-throwing path while preserving effects
          // from equivalent spellings such as `void sideEffect()`.
          enc = defaultAfterUndefined(undefinedArg, enc);
        } else {
          // A BufferEncoding-typed variable selects its decoder at
          // runtime. Optional variables default their undefined arm to
          // utf8; the checked intrinsic canonicalizes every present
          // alias/case and raises Node's ERR_UNKNOWN_ENCODING when a cast
          // lets a bad value through.
          enc = lowerOptionalArgument(lowerer, encNode, STRING, enc);
          method = "toStringVar";
        }
      }
    }
    // The range form toString(enc, start[, end]) decodes the clamped
    // [start, end) byte window (Node's slice-then-decode). An omitted
    // end stays omitted (2 intrinsic args) — the emitter supplies the
    // receiver's length, because EXPLICIT negative ends clamp to empty
    // in Node and no in-band sentinel can represent "omitted" safely.
    if (nArgs > 1) {
      const start = lowerer.lowerExprExpecting(call.arguments.nodes[1]!, F64);
      if (nArgs === 3) {
        const end = lowerer.lowerExprExpecting(call.arguments.nodes[2]!, F64);
        return {
          kind: "bytesIntrinsic",
          method,
          receiver,
          args: [enc, start, end],
          type: STRING,
          loc,
        };
      }
      return { kind: "bytesIntrinsic", method, receiver, args: [enc, start], type: STRING, loc };
    }
    return { kind: "bytesIntrinsic", method, receiver, args: [enc], type: STRING, loc };
  }
  // The Buffer-declared comparison/search/mutation surface. All of
  // these resolve against the Buffer interface (the checker keeps most
  // off plain typed arrays; where the lib DOES declare a same-named
  // TypedArray member — indexOf, includes, fill — the semantics differ,
  // so only Buffer-declared resolutions lower and u8 receivers gate the
  // rest).
  const declOnBuffer = (() => {
    const nameSym = lowerer.checker.getSymbolAtLocation(access.name);
    return (
      nameSym !== undefined &&
      nameSym.declarations.some(
        (d) => ts.isInterfaceDeclaration(d.parent) && d.parent.name.text === "Buffer",
      )
    );
  })();
  if (declOnBuffer && receiverIr.elem === "u8") {
    const bufMethod = lowerBufferInstanceMethod(lowerer, call, access, name, loc);
    if (bufMethod) return bufMethod;
  }
  const bigKind = own(BUF_BIGINT_METHODS, name);
  if (bigKind !== undefined && declOnBuffer && receiverIr.elem === "u8") {
    const write = name.startsWith("write");
    const required = write ? 1 : 0;
    if (nArgs < required || nArgs > required + 1) {
      lowerer.noLowering(`.${name} with ${nArgs} arguments`, call);
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, receiverIr);
    const offsetNode = call.arguments.nodes[required];
    const offset: IrExpr = offsetNode
      ? lowerer.lowerExprExpecting(offsetNode, F64)
      : { kind: "numLit", value: 0, type: F64, loc };
    const sign: IrExpr = { kind: "boolLit", value: bigKind.sign, type: BOOL, loc };
    const le: IrExpr = { kind: "boolLit", value: bigKind.le, type: BOOL, loc };
    if (!write) {
      return {
        kind: "libCall",
        fn: "bigint.bufferRead",
        args: [receiver, offset, sign, le],
        type: BIGINT_T,
        loc,
      };
    }
    const value = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, BIGINT_T);
    return {
      kind: "libCall",
      fn: "bigint.bufferWrite",
      args: [receiver, value, offset, sign, le],
      type: F64,
      loc,
    };
  }
  // The Buffer numeric read/write families — every fixed-width kind in
  // both endiannesses ("Uint" and "UInt" alike: Node aliases both), plus
  // the variable-width read/writeUIntLE quartet. The kind token rides as
  // a strLit args[0]; omitted offsets complete to Node's default 0.
  const numKind = own(BUF_NUM_METHODS, name);
  if (numKind !== undefined) {
    if (receiverIr.elem !== "u8") {
      lowerer.noLowering(
        `.${name} on a '${lowerer.fmt(receiverIr)}'`,
        call,
        "the numeric families read/write Buffer bytes",
      );
    }
    if (!numericArguments(lowerer, call))
      return dynNumericCall(lowerer, call, access, name, receiverIr, loc);
    const write = name.startsWith("write");
    const required = write ? 1 : 0; // value; offset defaults to 0
    if (nArgs < required || nArgs > required + 1) {
      lowerer.noLowering(`.${name} with ${nArgs} arguments`, call);
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, receiverIr);
    const kind: IrExpr = { kind: "strLit", value: numKind, type: STRING, loc };
    const args = [kind, ...call.arguments.nodes.map((a) => lowerer.lowerExprExpecting(a, F64))];
    if (nArgs === required) {
      args.push({ kind: "numLit", value: 0, type: F64, loc }); // Node's offset default
    }
    return {
      kind: "bytesIntrinsic",
      method: write ? "writeNum" : "readNum",
      receiver,
      args,
      type: F64,
      loc,
    };
  }
  const varKind = own(BUF_NUM_VAR_METHODS, name);
  if (varKind !== undefined) {
    if (receiverIr.elem !== "u8") {
      lowerer.noLowering(
        `.${name} on a '${lowerer.fmt(receiverIr)}'`,
        call,
        "the numeric families read/write Buffer bytes",
      );
    }
    const write = name.startsWith("write");
    const required = write ? 3 : 2; // Node declares offset AND byteLength required
    if (nArgs !== required) {
      lowerer.noLowering(`.${name} with ${nArgs} arguments`, call);
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, receiverIr);
    const kind: IrExpr = { kind: "strLit", value: varKind, type: STRING, loc };
    const args = [kind, ...call.arguments.nodes.map((a) => lowerer.lowerExprExpecting(a, F64))];
    return {
      kind: "bytesIntrinsic",
      method: write ? "writeNumVar" : "readNumVar",
      receiver,
      args,
      type: F64,
      loc,
    };
  }
  // DataView getters (DataView maps to bytes<u8>, so the receiver kind
  // and stdlib provenance land here; the checker keeps these names off
  // typed arrays and Buffers). The multi-byte kinds take the optional
  // littleEndian bool (omitted = big-endian, the JS default). All THROW
  // Node's RangeError on a bad offset (may-throw seeds).
  const dvBigGetter = own(DV_BIG_GETTERS, name);
  if (dvBigGetter !== undefined && receiverIr.elem === "u8") {
    if (nArgs < 1 || nArgs > 2) lowerer.noLowering(`.${name} with ${nArgs} arguments`, call);
    const receiver = lowerer.lowerExprExpecting(access.expression, receiverIr);
    const offset = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, F64);
    const sign: IrExpr = { kind: "boolLit", value: dvBigGetter.sign, type: BOOL, loc };
    const le: IrExpr = call.arguments.nodes[1]
      ? lowerer.lowerExprExpecting(call.arguments.nodes[1], BOOL)
      : { kind: "boolLit", value: false, type: BOOL, loc };
    return {
      kind: "libCall",
      fn: "bigint.dataViewGet",
      args: [receiver, offset, sign, le],
      type: BIGINT_T,
      loc,
    };
  }
  const dvGetter = own(DV_GETTERS, name);
  if (dvGetter !== undefined && receiverIr.elem === "u8") {
    const maxArgs = dvGetter.le ? 2 : 1;
    if (nArgs < 1 || nArgs > maxArgs) {
      lowerer.noLowering(`.${name} with ${nArgs} arguments`, call);
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, receiverIr);
    // ToIndex(undefined) is ToIndex(NaN): a missing offset reads offset 0.
    const args = [lowerToNumberArgument(lowerer, call.arguments.nodes[0]!)];
    if (nArgs === 2) args.push(lowerer.lowerExprExpecting(call.arguments.nodes[1]!, BOOL));
    return { kind: "bytesIntrinsic", method: dvGetter.method, receiver, args, type: F64, loc };
  }
  // DataView setters — the getters' mirror: (byteOffset, value) plus the
  // optional littleEndian bool on the multi-byte kinds. Void results;
  // the same constant Node RangeError on a bad offset (may-throw seeds).
  // setBigUint64/setBigInt64 never lower (bigint ARGUMENTS have no
  // representation and no composed form exists) — they keep the member
  // fence, as does setFloat16.
  const dvSetter = own(DV_SETTERS, name);
  if ((name === "setBigUint64" || name === "setBigInt64") && receiverIr.elem === "u8") {
    if (nArgs < 2 || nArgs > 3) lowerer.noLowering(`.${name} with ${nArgs} arguments`, call);
    const receiver = lowerer.lowerExprExpecting(access.expression, receiverIr);
    const offset = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, F64);
    const value = lowerer.lowerExprExpecting(call.arguments.nodes[1]!, BIGINT_T);
    const le: IrExpr = call.arguments.nodes[2]
      ? lowerer.lowerExprExpecting(call.arguments.nodes[2], BOOL)
      : { kind: "boolLit", value: false, type: BOOL, loc };
    return {
      kind: "libCall",
      fn: "bigint.dataViewSet",
      args: [receiver, offset, value, le],
      type: VOID,
      loc,
    };
  }
  if (dvSetter !== undefined && receiverIr.elem === "u8") {
    const maxArgs = dvSetter.le ? 3 : 2;
    if (nArgs < 2 || nArgs > maxArgs) {
      lowerer.noLowering(`.${name} with ${nArgs} arguments`, call);
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, receiverIr);
    // The offset (ToIndex) and the value (ToNumber) treat a missing value
    // as NaN.
    const args = [
      lowerToNumberArgument(lowerer, call.arguments.nodes[0]!),
      lowerToNumberArgument(lowerer, call.arguments.nodes[1]!),
    ];
    if (nArgs === 3) args.push(lowerer.lowerExprExpecting(call.arguments.nodes[2]!, BOOL));
    return { kind: "bytesIntrinsic", method: dvSetter.method, receiver, args, type: VOID, loc };
  }
  return null;
}

/** Node's Buffer encoding names → the runtime's canonical spelling (every
 * alias folds at compile time; the runtime sees only canonical names).
 * Shared by toString, Buffer.from, and Buffer.byteLength. */
const BUF_ENCODINGS: Record<string, string | undefined> = {
  utf8: "utf8",
  "utf-8": "utf8",
  hex: "hex",
  base64: "base64",
  base64url: "base64url",
  latin1: "latin1",
  binary: "latin1",
  ascii: "ascii",
  utf16le: "utf16le",
  "utf-16le": "utf16le",
  ucs2: "utf16le",
  "ucs-2": "utf16le",
};

/** A literal encoding's canonical name, or undefined for a spelling Node
 * does not know — the ladder callers (stream options) turn unknown
 * literals into Node's runtime ERR_UNKNOWN_ENCODING throw. */
export function knownBufEncoding(name: string): string | undefined {
  // Buffer.isEncoding: any letter case
  return own(BUF_ENCODINGS, name) ?? own(BUF_ENCODINGS, name.toLowerCase());
}

/** The literal encoding argument of a Buffer surface, normalized — or a
 * fence when it isn't a literal alias Node knows. */
export function bufEncoding(lowerer: Lowerer, what: string, encNode: ts.Expression): string {
  const t = lowerer.typeOf(encNode);
  const v = t.isStringLiteralType() ? own(BUF_ENCODINGS, t.value) : undefined;
  if (v === undefined) {
    lowerer.noLowering(
      `${what} with this encoding`,
      encNode,
      'a literal "utf8", "hex", "base64", "base64url", "latin1", "binary", "ascii", "utf16le", or "ucs2" spelling is the lowered encoding surface',
    );
  }
  return v;
}

const BUF_BIGINT_METHODS: Record<string, { sign: boolean; le: boolean } | undefined> = {
  readBigInt64BE: { sign: true, le: false },
  readBigInt64LE: { sign: true, le: true },
  readBigUInt64BE: { sign: false, le: false },
  readBigUInt64LE: { sign: false, le: true },
  readBigUint64BE: { sign: false, le: false },
  readBigUint64LE: { sign: false, le: true },
  writeBigInt64BE: { sign: true, le: false },
  writeBigInt64LE: { sign: true, le: true },
  writeBigUInt64BE: { sign: false, le: false },
  writeBigUInt64LE: { sign: false, le: true },
  writeBigUint64BE: { sign: false, le: false },
  writeBigUint64LE: { sign: false, le: true },
};

/** Whether every argument of a numeric read/write is statically a number. */
function numericArguments(lowerer: Lowerer, call: ts.CallExpression): boolean {
  return call.arguments.nodes.every((a) => lowerer.mapTypeOf(lowerer.typeOf(a))?.kind === "f64");
}

/** A numeric read/write with an argument that is not a number (a string
 * offset from untyped JavaScript): the checked-dynamic Buffer method runs
 * Node's argument validation at runtime. */
function dynNumericCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  name: string,
  receiverIr: IrType,
  loc: SrcLoc,
): IrExpr {
  const receiver = lowerer.lowerExprExpecting(access.expression, receiverIr);
  return {
    kind: "dynCheck",
    value: {
      kind: "dynInvoke",
      recv: { kind: "dynFrom", value: receiver, type: DYN, loc, liveRef: true },
      method: name,
      calleeName: ts.getTextOfNode(access),
      args: call.arguments.nodes.map((a) => lowerer.lowerExprExpecting(a, DYN)),
      type: DYN,
      loc,
    },
    type: F64,
    loc,
  };
}

/** The variable-width quartet (offset + byteLength) → sign/endian token. */
const BUF_NUM_VAR_METHODS: Record<string, string | undefined> = {
  readUIntBE: "ube",
  readUintBE: "ube",
  readUIntLE: "ule",
  readUintLE: "ule",
  readIntBE: "ibe",
  readIntLE: "ile",
  writeUIntBE: "ube",
  writeUintBE: "ube",
  writeUIntLE: "ule",
  writeUintLE: "ule",
  writeIntBE: "ibe",
  writeIntLE: "ile",
};

/** The Buffer-declared comparison/search/mutation methods on a u8
 * receiver: equals, compare, indexOf/lastIndexOf/includes (number,
 * string-with-encoding, and Buffer needles), fill, copy, swap16/32/64,
 * and write. Null when `name` isn't one of them (the numeric families
 * and the generic bytes surface try next). Encodings must be literals
 * (bufEncoding's fence); a trailing string-typed argument is the
 * encoding, exactly Node's overloads. */
function lowerBufferInstanceMethod(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  name: string,
  loc: SrcLoc,
): IrExpr | null {
  const args = call.arguments.nodes;
  const nArgs = args.length;
  if (args.some(ts.isSpreadElement)) return null;
  const isStringArg = (i: number): boolean =>
    lowerer.mapTypeOf(lowerer.typeOf(args[i]!))?.kind === "string";
  const u8Arg = (i: number): IrExpr => {
    const v = lowerer.lowerExpr(args[i]!);
    if (!(v.type.kind === "bytes" && v.type.elem === "u8")) {
      lowerer.noLowering(
        `.${name} of '${lowerer.fmt(v.type)}' values`,
        args[i]!,
        "a Buffer/Uint8Array argument is the lowered shape (narrow unions first)",
      );
    }
    return v;
  };

  // The checked-dynamic crossing for a compare/equals argument slot: dyn
  // passes through, convertible statics (the invalid-input probes'
  // literals) wrap in dynFrom, `undefined` literals ride the same wrap.

  const chkArg = (i: number): IrExpr => {
    // Object literals take the dyn literal path directly (method members
    // box as dyn functions — the typed record fence never applies).
    if (ts.isObjectLiteralExpression(args[i]!)) {
      return lowerDynObjectLiteral(lowerer, args[i] as ts.ObjectLiteralExpression);
    }
    const v = lowerer.lowerExpr(args[i]!);
    if (v.type.kind === "dyn") return v;
    if (v.kind === "unitLit" || lowerer.dynConvertible(v.type)) {
      return { kind: "dynFrom", value: v, type: DYN, loc: v.loc };
    }
    lowerer.noLowering(
      `.${name} of '${lowerer.fmt(v.type)}' values`,
      args[i]!,
      "a Buffer/Uint8Array argument is the lowered shape (narrow unions first)",
    );
  };
  const argIrKind = (i: number): IrType | null => lowerer.mapTypeOf(lowerer.typeOf(args[i]!));

  if (name === "equals") {
    if (nArgs !== 1) lowerer.noLowering(`.equals with ${nArgs} arguments`, call);
    if (argIrKind(0)?.kind === "bytes") {
      const other = u8Arg(0);
      const receiver = lowerer.lowerExprExpecting(access.expression, BYTES_U8);
      return { kind: "bytesIntrinsic", method: "equals", receiver, args: [other], type: BOOL, loc };
    }
    // Not statically bytes (the invalid-input probes, untyped JS
    // helpers): Node's "otherBuffer" argument ladder runs at runtime.
    const receiver = lowerer.lowerExprExpecting(access.expression, BYTES_U8);
    return { kind: "libCall", fn: "bytes.equalsChk", args: [receiver, chkArg(0)], type: BOOL, loc };
  }
  if (name === "compare") {
    if (nArgs > 5) lowerer.noLowering(`.compare with ${nArgs} arguments`, call);
    const fast =
      nArgs >= 1 &&
      argIrKind(0)?.kind === "bytes" &&
      call.arguments.nodes
        .slice(1)
        .every((a) => lowerer.mapTypeOf(lowerer.typeOf(a))?.kind === "f64");
    if (fast) {
      const target = u8Arg(0);
      const idx = call.arguments.nodes.slice(1).map((a) => lowerer.lowerExprExpecting(a, F64));
      const receiver = lowerer.lowerExprExpecting(access.expression, BYTES_U8);
      return {
        kind: "bytesIntrinsic",
        method: "compareBuf",
        receiver,
        args: [target, ...idx],
        type: F64,
        loc,
      };
    }
    // An absent/ill-typed target or offset (`a.compare()`, string
    // offsets, explicit undefined): Node's target/targetStart/targetEnd/
    // sourceStart/sourceEnd ladder runs at runtime; absent slots pass
    // the undefined dyn (Node defaults apply there).
    const receiver = lowerer.lowerExprExpecting(access.expression, BYTES_U8);
    const slots: IrExpr[] = [];
    for (let i = 0; i < 5; i++) slots.push(i < nArgs ? chkArg(i) : dynUndefinedExpr(loc));
    return { kind: "libCall", fn: "bytes.compareChk", args: [receiver, ...slots], type: F64, loc };
  }
  if (name === "indexOf" || name === "lastIndexOf" || name === "includes") {
    if (nArgs < 1 || nArgs > 3) lowerer.noLowering(`.${name} with ${nArgs} arguments`, call);
    // The overloads: (v), (v, byteOffset), (v, encoding), (v, byteOffset,
    // encoding) — a trailing string-typed arg is the encoding.
    let encName = "utf8";
    let offNode: ts.Expression | undefined;
    if (nArgs === 3) {
      offNode = args[1]!;
      encName = bufEncoding(lowerer, `.${name}`, args[2]!);
    } else if (nArgs === 2) {
      if (isStringArg(1)) encName = bufEncoding(lowerer, `.${name}`, args[1]!);
      else offNode = args[1]!;
    }
    const resultT = name === "includes" ? BOOL : F64;
    const vT = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
    const receiver = lowerer.lowerExprExpecting(access.expression, BYTES_U8);
    if (vT?.kind === "f64") {
      // A number needle wraps & 0xFF at runtime (Buffer semantics; the
      // encoding is irrelevant, like Node).
      const v = lowerer.lowerExprExpecting(args[0]!, F64);
      const numArgs = [v, ...(offNode ? [lowerer.lowerExprExpecting(offNode, F64)] : [])];
      const method =
        name === "indexOf"
          ? "indexOfNum"
          : name === "lastIndexOf"
            ? "lastIndexOfNum"
            : "includesNum";
      return { kind: "bytesIntrinsic", method, receiver, args: numArgs, type: resultT, loc };
    }
    let needle: IrExpr;
    let align = 1;
    if (vT?.kind === "string") {
      const s = lowerer.lowerExprExpecting(args[0]!, STRING);
      const enc: IrExpr = { kind: "strLit", value: encName, type: STRING, loc };
      needle = { kind: "libCall", fn: "buffer.fromStr", args: [s, enc], type: BYTES_U8, loc };
      if (encName === "utf16le") align = 2;
    } else if (vT?.kind === "bytes" && vT.elem === "u8") {
      needle = lowerer.lowerExpr(args[0]!);
      // A Buffer needle under utf16le also searches whole 2-byte units.
      if (encName === "utf16le") align = 2;
    } else {
      lowerer.noLowering(
        `.${name} of '${lowerer.checker.typeToString(lowerer.typeOf(args[0]!))}' values`,
        args[0]!,
        "string, number, and Buffer/Uint8Array needles search (narrow unions first)",
      );
    }
    const alignLit: IrExpr = { kind: "numLit", value: align, type: F64, loc };
    const searchArgs = [
      needle,
      alignLit,
      ...(offNode ? [lowerer.lowerExprExpecting(offNode, F64)] : []),
    ];
    return { kind: "bytesIntrinsic", method: name, receiver, args: searchArgs, type: resultT, loc };
  }
  if (name === "fill") {
    if (nArgs < 1 || nArgs > 4) lowerer.noLowering(`.fill with ${nArgs} arguments`, call);
    // A trailing string-typed arg past the value is the encoding.
    let encNode: ts.Expression | undefined;
    let idxNodes = call.arguments.nodes.slice(1);
    if (idxNodes.length > 0 && isStringArg(nArgs - 1)) {
      encNode = idxNodes[idxNodes.length - 1];
      idxNodes = idxNodes.slice(0, -1);
    }
    if (idxNodes.length > 2) lowerer.noLowering(`.fill with ${nArgs} arguments`, call);
    const idx = idxNodes.map((a) => lowerer.lowerExprExpecting(a, F64));
    const receiverT = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
    if (receiverT?.kind !== "bytes")
      lowerer.badType(access.expression, lowerer.typeOf(access.expression));
    const vT = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
    const receiver = lowerer.lowerExprExpecting(access.expression, BYTES_U8);
    if (vT?.kind === "string") {
      const encName = encNode ? bufEncoding(lowerer, ".fill", encNode) : "utf8";
      const s = lowerer.lowerExprExpecting(args[0]!, STRING);
      const enc: IrExpr = { kind: "strLit", value: encName, type: STRING, loc };
      return {
        kind: "bytesIntrinsic",
        method: "fillStr",
        receiver,
        args: [s, enc, ...idx],
        type: BYTES_U8,
        loc,
      };
    }
    if (encNode) lowerer.noLowering(".fill with an encoding on a non-string value", encNode);
    if (vT?.kind === "f64") {
      const v = lowerer.lowerExprExpecting(args[0]!, F64);
      return {
        kind: "bytesIntrinsic",
        method: "fillNum",
        receiver,
        args: [v, ...idx],
        type: BYTES_U8,
        loc,
      };
    }
    const pattern = u8Arg(0);
    return {
      kind: "bytesIntrinsic",
      method: "fill",
      receiver,
      args: [pattern, ...idx],
      type: BYTES_U8,
      loc,
    };
  }
  if (name === "copy") {
    if (nArgs < 1 || nArgs > 4) lowerer.noLowering(`.copy with ${nArgs} arguments`, call);
    const target = u8Arg(0);
    const idx = call.arguments.nodes.slice(1).map((a) => lowerer.lowerExprExpecting(a, F64));
    const receiver = lowerer.lowerExprExpecting(access.expression, BYTES_U8);
    return {
      kind: "bytesIntrinsic",
      method: "copy",
      receiver,
      args: [target, ...idx],
      type: F64,
      loc,
    };
  }
  if (name === "swap16" || name === "swap32" || name === "swap64") {
    if (nArgs !== 0) lowerer.noLowering(`.${name} with ${nArgs} arguments`, call);
    const receiver = lowerer.lowerExprExpecting(access.expression, BYTES_U8);
    return { kind: "bytesIntrinsic", method: name, receiver, args: [], type: BYTES_U8, loc };
  }
  if (name === "write") {
    if (nArgs < 1 || nArgs > 4) lowerer.noLowering(`.write with ${nArgs} arguments`, call);
    // (str), (str, enc), (str, offset), (str, offset, enc),
    // (str, offset, length), (str, offset, length, enc).
    let encNode: ts.Expression | undefined;
    let idxNodes = call.arguments.nodes.slice(1);
    if (idxNodes.length > 0 && isStringArg(nArgs - 1)) {
      encNode = idxNodes[idxNodes.length - 1];
      idxNodes = idxNodes.slice(0, -1);
    }
    if (idxNodes.length > 2) lowerer.noLowering(`.write with ${nArgs} arguments`, call);
    const encName = encNode ? bufEncoding(lowerer, "Buffer.write", encNode) : "utf8";
    const s = lowerer.lowerExprExpecting(args[0]!, STRING);
    const enc: IrExpr = { kind: "strLit", value: encName, type: STRING, loc };
    const offset: IrExpr = idxNodes[0]
      ? lowerer.lowerExprExpecting(idxNodes[0], F64)
      : { kind: "numLit", value: 0, type: F64, loc };
    const writeArgs = [
      s,
      enc,
      offset,
      ...(idxNodes[1] ? [lowerer.lowerExprExpecting(idxNodes[1], F64)] : []),
    ];
    const receiver = lowerer.lowerExprExpecting(access.expression, BYTES_U8);
    return {
      kind: "bytesIntrinsic",
      method: "writeStr",
      receiver,
      args: writeArgs,
      type: F64,
      loc,
    };
  }
  return null;
}

const DV_BIG_GETTERS: Record<string, { sign: boolean } | undefined> = {
  getBigInt64: { sign: true },
  getBigUint64: { sign: false },
};

/** The number-returning DataView getter surface by source name. `le` marks
 * the multi-byte kinds whose signature declares optional littleEndian;
 * the BigInt pair routes through DV_BIG_GETTERS above. */
const DV_GETTERS: Record<string, { method: IrBytesIntrinsicMethod; le: boolean } | undefined> = {
  getUint8: { method: "dvGetUint8", le: false },
  getInt8: { method: "dvGetInt8", le: false },
  getUint16: { method: "dvGetUint16", le: true },
  getInt16: { method: "dvGetInt16", le: true },
  getUint32: { method: "dvGetUint32", le: true },
  getInt32: { method: "dvGetInt32", le: true },
  getFloat16: { method: "dvGetFloat16", le: true },
  getFloat32: { method: "dvGetFloat32", le: true },
  getFloat64: { method: "dvGetFloat64", le: true },
};

const DV_SETTERS: Record<string, { method: IrBytesIntrinsicMethod; le: boolean } | undefined> = {
  setUint8: { method: "dvSetUint8", le: false },
  setInt8: { method: "dvSetInt8", le: false },
  setUint16: { method: "dvSetUint16", le: true },
  setInt16: { method: "dvSetInt16", le: true },
  setUint32: { method: "dvSetUint32", le: true },
  setInt32: { method: "dvSetInt32", le: true },
  setFloat16: { method: "dvSetFloat16", le: true },
  setFloat32: { method: "dvSetFloat32", le: true },
  setFloat64: { method: "dvSetFloat64", le: true },
};

/** The Buffer statics — `Buffer.from(...)`, `Buffer.alloc(n)`,
 * `Buffer.concat(list)`, `Buffer.isBuffer(x)` — on THE stdlib Buffer
 * global (name + provenance; fallback and @types/node alike). Null when
 * the callee isn't a Buffer-static access. */
function knownBufferProducer(
  lowerer: Lowerer,
  source: ts.Expression,
  seen = new Set<ts.Symbol>(),
): boolean {
  let node = source;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertion(node))
    node = node.expression;
  if (ts.isIdentifier(node)) {
    const symbol = lowerer.checker.getSymbolAtLocation(node);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    return symbol.declarations.some(
      (decl) =>
        ts.isVariableDeclaration(decl) &&
        ts.isVariableDeclarationList(decl.parent) &&
        (decl.parent.flags & ts.NodeFlags.Const) !== 0 &&
        decl.initializer !== undefined &&
        knownBufferProducer(lowerer, decl.initializer, seen),
    );
  }
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const bi = ts.isIdentifier(callee)
    ? lowerer.builtinImportOf(callee)
    : ts.isPropertyAccessExpression(callee)
      ? lowerer.builtinMemberOf(callee)
      : null;
  if (
    bi?.module === "crypto" &&
    (bi.member === "randomBytes" || bi.member === "pbkdf2Sync" || bi.member === "scryptSync")
  )
    return true;
  if (bi?.module === "buffer" && bi.member === "transcode") return true;
  if (bi?.module === "url" && bi.member === "fileURLToPathBuffer") return true;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "digest" ||
    node.arguments.nodes.length !== 0
  )
    return false;
  const type = lowerer.mapTypeOf(lowerer.typeOf(callee.expression));
  return type?.kind === "cryptoHash" || type?.kind === "cryptoHmac";
}

/** Buffer.from over a checked-dynamic source and encoding, both already in
 * repeatable locals: Node's fromString takes utf8 for an absent, non-string
 * or empty encoding and throws ERR_UNKNOWN_ENCODING for an unknown name; an
 * ArrayBuffer takes the second argument as its byte offset; other sources
 * ignore it. */
function dynBufferFromParts(
  source: IrExpr,
  encoding: IrExpr,
  loc: SrcLoc,
  length?: IrExpr,
): IrExpr {
  const utf8: IrExpr = { kind: "strLit", value: "utf8", type: STRING, loc };
  const isString = (x: IrExpr): IrExpr => ({
    kind: "dynTest",
    test: "string",
    value: x,
    type: BOOL,
    loc,
  });
  const name: IrExpr = {
    kind: "ternary",
    cond: {
      kind: "logical",
      op: "&&",
      left: isString(encoding),
      right: {
        kind: "strEq",
        negated: true,
        left: { kind: "dynCheck", value: encoding, type: STRING, loc },
        right: { kind: "strLit", value: "", type: STRING, loc },
        type: BOOL,
        loc,
      },
      type: BOOL,
      loc,
    },
    then: { kind: "dynCheck", value: encoding, type: STRING, loc },
    else_: utf8,
    type: STRING,
    loc,
  };
  return {
    kind: "ternary",
    cond: isString(source),
    then: {
      kind: "libCall",
      fn: "buffer.poolFromStrChecked",
      args: [{ kind: "dynCheck", value: source, type: STRING, loc }, name],
      type: BYTES_U8,
      loc,
    },
    // An ArrayBuffer takes the second argument as its byte offset and the
    // third as its length (scr_buffer_from_dyn_range_pooled); other values
    // convert with utf8.
    else_: length
      ? {
          kind: "libCall",
          fn: "buffer.poolFromDynRange",
          args: [source, encoding, length],
          type: BYTES_U8,
          loc,
        }
      : {
          kind: "libCall",
          fn: "buffer.poolFromDynOffset",
          args: [source, encoding],
          type: BYTES_U8,
          loc,
        },
    type: BYTES_U8,
    loc,
  };
}

/** Buffer.from(arrayBuffer, byteOffset[, length]): each argument in order
 * as a checked-dynamic value, read by the runtime as Node's
 * fromArrayBuffer reads them. */
function bufferFromArrayBufferRange(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  loc: SrcLoc,
  first?: IrExpr,
): IrExpr {
  const operands = [0, 1, 2].map((i) =>
    i === 0 && first
      ? first
      : args[i]
        ? lowerer.lowerExprExpecting(args[i]!, DYN)
        : dynUndefinedExpr(loc),
  );
  return { kind: "libCall", fn: "buffer.poolFromDynRange", args: operands, type: BYTES_U8, loc };
}

/** Lowers `source` and `encNode` (or undefined) into hidden dyn locals, in
 * source order, and builds the result from their references. */
function withDynBufferArguments(
  lowerer: Lowerer,
  source: IrExpr,
  encNode: ts.Expression | undefined,
  loc: SrcLoc,
  build: (source: IrExpr, encoding: IrExpr) => IrExpr,
): IrExpr {
  const v = lowerer.declareHiddenLocal("%bufferValue", DYN);
  const e = lowerer.declareHiddenLocal("%bufferEncoding", DYN);
  const result = build(varRef(v.id, DYN, loc), varRef(e.id, DYN, loc));
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: v.id, init: lowerer.coerceToExpected(source, DYN), loc },
      {
        kind: "varDecl",
        localId: e.id,
        init:
          encNode === undefined
            ? dynUndefinedExpr(loc)
            : lowerer.coerceToExpected(lowerer.lowerExpr(encNode), DYN),
        loc,
      },
    ],
    result,
    type: result.type,
    loc,
  };
}

/** Buffer.from(value, encoding) over a checked-dynamic value whose encoding
 * is not a literal: yazl forwards its `encoding` parameter, often undefined.
 * Null when the encoding is absent or a literal. */
function dynBufferFromRuntimeEncoding(
  lowerer: Lowerer,
  value: IrExpr,
  encNode: ts.Expression | undefined,
  loc: SrcLoc,
): IrExpr | null {
  if (encNode === undefined || lowerer.typeOf(encNode).isStringLiteralType()) return null;
  return withDynBufferArguments(lowerer, value, encNode, loc, (source, encoding) =>
    dynBufferFromParts(source, encoding, loc),
  );
}

/** The deprecated `Buffer(arg[, encodingOrOffset[, length]])`, called or
 * constructed through the global or an alias of it, as Node's Buffer
 * function runs it: the arguments evaluate in order, DEP0005 is reported
 * on the next tick (once, and never for a call made from node_modules,
 * which only counts toward Node's 10000-call check), then a number
 * allocates zero-filled bytes (and throws ERR_INVALID_ARG_TYPE beside a
 * string second argument) and anything else converts as Buffer.from does.
 * Null for spread arguments and more than three. */
export function lowerBufferConstruct(
  lowerer: Lowerer,
  expr: ts.NewExpression | ts.CallExpression,
): IrExpr | null {
  if (ts.isCallExpression(expr) && expr.questionDotToken) return null;
  const args = expr.arguments?.nodes ?? [];
  if (args.length > 3 || args.some(ts.isSpreadElement)) return null;
  if (stdlibGlobalNameOf(lowerer, expr.expression) !== "Buffer") return null;
  const loc = locOf(expr);
  const locals = [0, 1, 2].slice(0, Math.max(args.length, 2)).map((i) => {
    const local = lowerer.declareHiddenLocal("%bufferArgument", DYN);
    const node = args[i];
    const init = node === undefined ? dynUndefinedExpr(loc) : lowerer.lowerExprExpecting(node, DYN);
    return { local, init };
  });
  const [source, second, third] = locals.map(({ local }) => varRef(local.id, DYN, loc)) as [
    IrExpr,
    IrExpr,
    IrExpr | undefined,
  ];
  const inNodeModules = /[\\/]node_modules[\\/]/.test(expr.getSourceFile().fileName);
  const value: IrExpr = {
    kind: "ternary",
    cond: { kind: "dynTest", test: "number", value: source, type: BOOL, loc },
    then: {
      kind: "ternary",
      cond: { kind: "dynTest", test: "string", value: second, type: BOOL, loc },
      then: { kind: "libCall", fn: "buffer.newStringFail", args: [source], type: BYTES_U8, loc },
      else_: {
        kind: "libCall",
        fn: "buffer.alloc",
        args: [{ kind: "dynCheck", value: source, type: F64, loc }],
        type: BYTES_U8,
        loc,
      },
      type: BYTES_U8,
      loc,
    },
    else_: dynBufferFromParts(source, second, loc, third),
    type: BYTES_U8,
    loc,
  };
  return {
    kind: "seqExpr",
    stmts: [
      ...locals.map(({ local, init }): IrStmt => ({
        kind: "varDecl",
        localId: local.id,
        init,
        loc,
      })),
      {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: inNodeModules ? "buffer.deprecationCount" : "buffer.deprecation",
          args: [],
          type: VOID,
          loc,
        },
        loc,
      },
    ],
    result: { kind: "libCall", fn: "buffer.brand", args: [value], type: BYTES_U8, loc },
    type: BYTES_U8,
    loc,
  };
}

/** Buffer.from(array or bytes, extra): Node copies an array-like source and
 * ignores the encoding/offset argument (yazl passes its `encoding` through
 * unchanged), but JavaScript still evaluates it after the source. */
function withIgnoredBufferArgument(
  lowerer: Lowerer,
  extraNode: ts.Expression | undefined,
  source: IrExpr,
  build: (source: IrExpr) => IrExpr,
): IrExpr {
  if (extraNode === undefined) return build(source);
  const extra = lowerer.lowerExpr(extraNode);
  if (isSafeToDiscard(extra)) return build(source);
  const loc = source.loc;
  const tmp = lowerer.declareHiddenLocal("%bufferSource", source.type);
  const result = build(varRef(tmp.id, source.type, loc));
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: tmp.id, init: source, loc },
      { kind: "exprStmt", expr: extra, loc },
    ],
    result,
    type: result.type,
    loc,
  };
}

export function lowerBufferStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const value = lowerBufferStaticValue(lowerer, call, access);
  // Every byte-valued Buffer factory creates a distinct view. Preserve its
  // brand even when stored as Uint8Array or passed through checked values.
  return value?.type.kind === "bytes"
    ? { kind: "libCall", fn: "buffer.brand", args: [value], type: value.type, loc: value.loc }
    : value;
}

function lowerBufferStaticValue(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!lowerer.isStdlibGlobal(access.expression, "Buffer")) return null;
  const member = access.name.text;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if (member === "from") {
    if (
      args.length >= 1 &&
      args.length <= 3 &&
      !args.some(ts.isSpreadElement) &&
      ((symbol) =>
        symbol != null &&
        (ts.symbolName(symbol) === "ArrayBuffer" || ts.symbolName(symbol) === "SharedArrayBuffer"))(
        lowerer.typeOf(args[0]!).getSymbol(),
      )
    ) {
      // A byte offset or length follows Node's fromArrayBuffer (its
      // conversions and ERR_BUFFER_OUT_OF_BOUNDS), not the typed-array view.
      if (args.length === 1) return lowerArrayBufferView(lowerer, args, "u8", loc);
      return bufferFromArrayBufferRange(lowerer, args, loc);
    }
    // Buffer.from(value, byteOffset, length) over an untyped value: an
    // ArrayBuffer's range, or the two-argument conversion of other values.
    if (args.length === 3 && !args.some(ts.isSpreadElement)) {
      const first = lowerer.lowerExpr(args[0]!);
      if (first.type.kind === "dyn") return bufferFromArrayBufferRange(lowerer, args, loc, first);
    }
    // Buffer.from(x.buffer[, byteOffset[, length]]): a u8 VIEW sharing
    // x's storage (Node shares the ArrayBuffer; length is in BYTES).
    // The first argument must be the SYNTACTIC `.buffer` of a typed
    // array — the DataView peel — and the construction rides the same
    // dataViewNew intrinsic (offset/length validation throws Node's
    // DataView-shaped RangeErrors; valid indices behave exactly).
    if (
      args.length >= 1 &&
      args.length <= 3 &&
      !args.some(ts.isSpreadElement) &&
      ts.isPropertyAccessExpression(args[0]!) &&
      args[0].name.text === "buffer"
    ) {
      const srcNode = args[0].expression;
      const srcIr = lowerer.mapTypeOf(lowerer.typeOf(srcNode));
      if (srcIr?.kind === "bytes") {
        // A JavaScript field can hold the typed array as a dynamic value.
        const receiver = lowerer.lowerExprExpecting(srcNode, srcIr);
        const idxArgs = args.slice(1).map((a) => lowerer.lowerExprExpecting(a, F64));
        return {
          kind: "bytesIntrinsic",
          method: "dataViewNew",
          receiver,
          args: idxArgs,
          type: BYTES_U8,
          loc,
        };
      }
    }
    if (args.length >= 1 && args.length <= 2 && !args.some(ts.isSpreadElement)) {
      const argNode = args[0]!;
      if (
        ts.isArrayLiteralExpression(argNode) &&
        !argNode.elements.nodes.some(ts.isSpreadElement)
      ) {
        // A number[] literal (contextually typed by the lib's readonly
        // number[] slot — build it element-wise, the Set-seed pattern).
        const elems = argNode.elements.nodes.map((el) => lowerer.lowerExprExpecting(el, F64));
        const seed: IrExpr = { kind: "arrayLit", elems, type: arrayOf(F64), loc };
        return withIgnoredBufferArgument(lowerer, args[1], seed, (array) => ({
          kind: "libCall",
          fn: "buffer.poolFromArray",
          args: [array],
          type: BYTES_U8,
          loc,
        }));
      } else {
        const srcIr = lowerer.mapTypeOf(lowerer.typeOf(argNode));
        const value = lowerer.lowerExpr(argNode);
        // JS callback storage can be native DYN even when the checker
        // reports any (or a narrowed Buffer). Dispatch on its actual ABI.
        if (value.type.kind === "dyn") {
          const runtimeEncoding = dynBufferFromRuntimeEncoding(lowerer, value, args[1], loc);
          if (runtimeEncoding) return runtimeEncoding;
          const encName = args[1] ? bufEncoding(lowerer, "Buffer.from", args[1]) : "utf8";
          const enc: IrExpr = { kind: "strLit", value: encName, type: STRING, loc };
          return {
            kind: "libCall",
            fn: "buffer.poolFromDyn",
            args: [value, enc],
            type: BYTES_U8,
            loc,
          };
        }
        if (srcIr?.kind === "string") {
          const s = lowerer.coerceInto(argNode, value, STRING);
          const encNode = args[1];
          let enc: IrExpr = { kind: "strLit", value: "utf8", type: STRING, loc };
          let fn: IrLibFn = "buffer.poolFromStr";
          if (encNode) {
            const encType = lowerer.typeOf(encNode);
            const encName = encType.isStringLiteralType()
              ? knownBufEncoding(encType.value)
              : undefined;
            if (encName !== undefined) {
              enc = defaultAfterUndefined(lowerer.lowerExpr(encNode), {
                kind: "strLit",
                value: encName,
                type: STRING,
                loc,
              });
            } else {
              const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, encNode);
              if (undefinedArg) {
                enc = defaultAfterUndefined(undefinedArg, enc);
              } else {
                enc = lowerOptionalArgument(lowerer, encNode, STRING, enc);
                fn = "buffer.poolFromStrChecked";
              }
            }
          }
          return { kind: "libCall", fn, args: [s, enc], type: BYTES_U8, loc };
        }
        // A checker type with no mapping (pako's conditional `O extends
        // { toText: true } ? string : Uint8Array` result) whose lowered
        // value is a u8 view copies like the typed form.
        if (
          (srcIr?.kind === "bytes" && srcIr.elem === "u8") ||
          (srcIr === null && value.type.kind === "bytes" && value.type.elem === "u8")
        ) {
          return withIgnoredBufferArgument(lowerer, args[1], value, (bytes) => ({
            kind: "libCall",
            fn: "buffer.poolFromBytes",
            args: [bytes],
            type: BYTES_U8,
            loc,
          }));
        }
        if (srcIr?.kind === "array" && srcIr.elem.kind === "f64") {
          return withIgnoredBufferArgument(lowerer, args[1], value, (array) => ({
            kind: "libCall",
            fn: "buffer.poolFromArray",
            args: [array],
            type: BYTES_U8,
            loc,
          }));
        }
        // A union of strings, u8 views and undefined/null (a JS-inferred
        // npm result such as pako's deflate): the checked form dispatches
        // on the runtime kind exactly as for an untyped JS value, Node's
        // TypeError for the unit arms included.
        if (
          args.length === 1 &&
          value.type.kind === "union" &&
          lowerer.dynConvertible(value.type) &&
          lowerer.unions
            .get(value.type.unionId)
            ?.arms.every(
              (arm) =>
                arm.kind === "string" ||
                (arm.kind === "bytes" && arm.elem === "u8") ||
                isUnitType(arm),
            ) === true
        ) {
          return {
            kind: "libCall",
            fn: "buffer.poolFromDyn",
            args: [
              lowerer.coerceToExpected(value, DYN),
              { kind: "strLit", value: "utf8", type: STRING, loc },
            ],
            type: BYTES_U8,
            loc,
          };
        }
      }
    }
    lowerer.noLowering(
      "Buffer.from with this argument shape",
      call,
      "supported: Buffer.from(string, encoding?), Buffer.from(u8Array) — a copy — " +
        "Buffer.from(number[]), or Buffer.from(arrayBuffer, byteOffset?, length?) — a view sharing " +
        "the buffer's storage; narrow unions first",
    );
  }
  if (member === "alloc" || member === "allocUnsafe" || member === "allocUnsafeSlow") {
    const maxArgs = member === "alloc" ? 3 : 1;
    if (args.length < 1 || args.length > maxArgs || args.some(ts.isSpreadElement)) {
      lowerer.noLowering(`Buffer.${member} with ${args.length} arguments`, call);
    }
    // allocUnsafe's contents are unspecified in Node (uninitialized pool
    // memory). Pool slabs and unpooled buffers start zero-filled.
    const size = lowerer.lowerExprExpecting(args[0]!, F64);
    const fn: IrLibFn =
      member === "alloc"
        ? "buffer.alloc"
        : member === "allocUnsafe"
          ? "buffer.allocUnsafe"
          : "buffer.allocUnsafeSlow";
    const fresh: IrExpr = { kind: "libCall", fn, args: [size], type: BYTES_U8, loc };
    if (args.length === 1) return fresh;
    // alloc(size, fill, encoding?): the fill semantics ARE fill()'s —
    // the fresh buffer is the receiver of a whole-range fill.
    const fillT = lowerer.mapTypeOf(lowerer.typeOf(args[1]!));
    if (fillT?.kind === "string") {
      const encName = args[2] ? bufEncoding(lowerer, "Buffer.alloc", args[2]) : "utf8";
      const s = lowerer.lowerExprExpecting(args[1]!, STRING);
      const enc: IrExpr = { kind: "strLit", value: encName, type: STRING, loc };
      return {
        kind: "bytesIntrinsic",
        method: "fillStr",
        receiver: fresh,
        args: [s, enc],
        type: BYTES_U8,
        loc,
      };
    }
    if (args.length > 2) {
      lowerer.noLowering("Buffer.alloc with an encoding on a non-string fill", args[2]!);
    }
    if (fillT?.kind === "f64") {
      const v = lowerer.lowerExprExpecting(args[1]!, F64);
      return {
        kind: "bytesIntrinsic",
        method: "fillNum",
        receiver: fresh,
        args: [v],
        type: BYTES_U8,
        loc,
      };
    }
    if (fillT?.kind === "bytes" && fillT.elem === "u8") {
      const pattern = lowerer.lowerExpr(args[1]!);
      return {
        kind: "bytesIntrinsic",
        method: "fill",
        receiver: fresh,
        args: [pattern],
        type: BYTES_U8,
        loc,
      };
    }
    lowerer.noLowering(
      `Buffer.alloc with a '${lowerer.checker.typeToString(lowerer.typeOf(args[1]!))}' fill`,
      args[1]!,
      "number, string, and Buffer/Uint8Array fills are the lowered shapes",
    );
  }
  if (member === "concat") {
    if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement)) {
      lowerer.noLowering(`Buffer.concat with ${args.length} arguments`, call);
    }
    const argNode = args[0]!;
    let list: IrExpr;
    if (ts.isArrayLiteralExpression(argNode) && !argNode.elements.nodes.some(ts.isSpreadElement)) {
      const elems = argNode.elements.nodes.map((el) => lowerer.lowerExprExpecting(el, BYTES_U8));
      list = { kind: "arrayLit", elems, type: arrayOf(BYTES_U8), loc };
    } else {
      list = lowerer.lowerExpr(argNode);
      if (!typeEquals(list.type, arrayOf(BYTES_U8))) {
        // Any other list (JavaScript's untyped `const chunks = []`, or a
        // union of arrays): the runtime checks it as Node does (an Array of
        // Uint8Arrays, the ERR_INVALID_ARG_TYPE errors otherwise) before
        // concatenating.
        const value: IrExpr =
          list.type.kind === "dyn" ? list : { kind: "dynFrom", value: list, type: DYN, loc };
        if (args.length === 2) {
          const total = lowerer.lowerExprExpecting(args[1]!, F64);
          return {
            kind: "libCall",
            fn: "buffer.concatLenDyn",
            args: [value, total],
            type: BYTES_U8,
            loc,
          };
        }
        return { kind: "libCall", fn: "buffer.concatDyn", args: [value], type: BYTES_U8, loc };
      }
    }
    if (args.length === 2) {
      // The totalLength form truncates or zero-pads (and THROWS Node's
      // 'length' RangeError on bad totals).
      const total = lowerer.lowerExprExpecting(args[1]!, F64);
      return { kind: "libCall", fn: "buffer.concatLen", args: [list, total], type: BYTES_U8, loc };
    }
    return { kind: "libCall", fn: "buffer.concat", args: [list], type: BYTES_U8, loc };
  }
  if (member === "compare") {
    // The static form: Buffer.compare(a, b) IS a.compare(b).
    if (args.length !== 2 || args.some(ts.isSpreadElement)) {
      lowerer.noLowering(`Buffer.compare with ${args.length} arguments`, call);
    }
    const sides = args.map((a) => lowerer.lowerExpr(a));
    if (sides.every((v) => v.type.kind === "bytes" && v.type.elem === "u8")) {
      return {
        kind: "bytesIntrinsic",
        method: "compareBuf",
        receiver: sides[0]!,
        args: [sides[1]!],
        type: F64,
        loc,
      };
    }
    // A side that is not statically bytes (the invalid-input probes,
    // untyped JS helpers): Node's "buf1"/"buf2" argument ladder runs
    // at runtime — a well-typed dyn still compares.
    const dyns = sides.map((v, i): IrExpr => {
      if (v.type.kind === "dyn") return v;
      if (v.kind === "unitLit" || lowerer.dynConvertible(v.type)) {
        return { kind: "dynFrom", value: v, type: DYN, loc: v.loc };
      }
      lowerer.noLowering(
        `Buffer.compare of '${lowerer.fmt(v.type)}' values`,
        args[i]!,
        "Buffer/Uint8Array values compare (narrow unions first)",
      );
    });
    return { kind: "libCall", fn: "buffer.compareChk", args: dyns, type: F64, loc };
  }
  if (member === "isBuffer") {
    // The type-predicate narrowing test. Lowered where it DECIDES
    // something: a union-typed argument with a Buffer arm becomes a
    // runtime tag test (tsc's narrowing then types the branches, the
    // discriminated-union machinery). Statically-decided arguments stay
    // fenced except for standard-library calls (and const aliases of
    // them) proven to return a real Buffer; those preserve evaluation and
    // fold true even though Buffer and Uint8Array share one IR storage.
    if (args.length === 1 && !ts.isSpreadElement(args[0]!)) {
      const source = args[0]!;
      const v = lowerer.lowerExpr(args[0]!);
      // The bytes IR intentionally unifies Buffer and Uint8Array storage,
      // but these standard-library producers are known to return a real
      // Node Buffer. Preserve source evaluation and fold the predicate.
      if (knownBufferProducer(lowerer, source)) {
        return {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: v, loc: v.loc }],
          result: { kind: "boolLit", value: true, type: BOOL, loc },
          type: BOOL,
          loc,
        };
      }
      // Untyped stream chunks retain the native checked value's Buffer
      // flavor. Plain bytes are Uint8Arrays at this boundary; inspecting
      // only the bytes tag would incorrectly identify them as Buffers.
      const checked =
        isJsSourceFile(ts.getSourceFileOfNode(call)) &&
        v.kind === "dynCheck" &&
        v.value.type.kind === "dyn"
          ? v.value
          : v;
      if (checked.type.kind === "dyn") {
        return { kind: "dynTest", test: "buffer", value: checked, type: BOOL, loc };
      }
      // Primitive storage cannot carry a Buffer. Keep argument effects
      // even when its representation makes the answer constant.
      if (
        v.type.kind === "string" ||
        v.type.kind === "f64" ||
        v.type.kind === "bool" ||
        v.type.kind === "symbol" ||
        v.type.kind === "bigint" ||
        v.type.kind === "nullT" ||
        v.type.kind === "undefinedT"
      ) {
        if (isSafeToDiscard(v)) return { kind: "boolLit", value: false, type: BOOL, loc };
        return {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: v, loc: v.loc }],
          result: { kind: "boolLit", value: false, type: BOOL, loc },
          type: BOOL,
          loc,
        };
      }
      if (v.type.kind === "union") {
        const def = lowerer.unions.get(v.type.unionId);
        const tag = def ? def.arms.findIndex((a) => a.kind === "bytes" && a.elem === "u8") : -1;
        if (tag >= 0) {
          return {
            kind: "unionIsTag",
            unionId: v.type.unionId,
            tag,
            negated: false,
            value: v,
            type: BOOL,
            loc,
          };
        }
      }
      // A typed view of unknown provenance (a Uint8Array parameter,
      // safe-buffer's Buffer.from result): Buffer is a brand of the view,
      // which the runtime keeps, so the test reads it.
      if (v.type.kind === "bytes") {
        return { kind: "libCall", fn: "buffer.isBranded", args: [v], type: BOOL, loc };
      }
      lowerer.noLowering(
        `Buffer.isBuffer of '${lowerer.fmt(v.type)}' values`,
        args[0]!,
        "the check lowers as a runtime tag test on unions with a Buffer arm — here the answer is static",
      );
    }
    lowerer.noLowering("Buffer.isBuffer with this argument shape", call);
  }
  if (member === "byteLength") {
    // Buffer.byteLength(string, enc?) — the UTF-16-aware per-encoding
    // count — or of a typed array/Buffer (its byte length, a property
    // read at heart).
    if (args.length >= 1 && args.length <= 2 && !ts.isSpreadElement(args[0]!)) {
      const srcIr = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
      if (srcIr?.kind === "string") {
        const encName = args[1] ? bufEncoding(lowerer, "Buffer.byteLength", args[1]) : "utf8";
        const s = lowerer.lowerExprExpecting(args[0]!, STRING);
        const enc: IrExpr = { kind: "strLit", value: encName, type: STRING, loc };
        return { kind: "libCall", fn: "buffer.byteLenStr", args: [s, enc], type: F64, loc };
      }
      if (
        (srcIr === null || srcIr.kind === "dyn") &&
        (!args[1] || ts.isStringLiteralLike(args[1]))
      ) {
        const encoding: IrExpr = {
          kind: "strLit",
          value: args[1] ? bufEncoding(lowerer, "Buffer.byteLength", args[1]) : "utf8",
          type: STRING,
          loc,
        };
        return {
          kind: "libCall",
          fn: "buffer.byteLenDyn",
          args: [lowerer.lowerExprExpecting(args[0]!, DYN), encoding],
          type: F64,
          loc,
        };
      }
      if (srcIr?.kind === "bytes" && args.length === 1) {
        const receiver = lowerer.lowerExpr(args[0]!);
        return { kind: "bytesIntrinsic", method: "byteLength", receiver, args: [], type: F64, loc };
      }
    }
    lowerer.noLowering(
      "Buffer.byteLength with this argument shape",
      call,
      "supported: Buffer.byteLength(string, literalEncoding?) or Buffer.byteLength(typedArray)",
    );
  }
  if (member === "isEncoding") {
    // The runtime alias-set test — a plain bool over any string value
    // (Node's case-insensitive normalizeEncoding check).
    if (
      args.length === 1 &&
      !ts.isSpreadElement(args[0]!) &&
      lowerer.mapTypeOf(lowerer.typeOf(args[0]!))?.kind === "string"
    ) {
      const s = lowerer.lowerExprExpecting(args[0]!, STRING);
      return { kind: "libCall", fn: "buffer.isEncoding", args: [s], type: BOOL, loc };
    }
    // Any other single argument: Node answers false for non-strings.
    if (args.length === 1 && !ts.isSpreadElement(args[0]!)) {
      const value = lowerer.declareHiddenLocal("%bufferEncoding", DYN);
      const ref = varRef(value.id, DYN, loc);
      return {
        kind: "seqExpr",
        stmts: [
          {
            kind: "varDecl",
            localId: value.id,
            init: lowerer.lowerExprExpecting(args[0]!, DYN),
            loc,
          },
        ],
        result: {
          kind: "logical",
          op: "&&",
          left: { kind: "dynTest", test: "string", value: ref, type: BOOL, loc },
          right: {
            kind: "libCall",
            fn: "buffer.isEncoding",
            args: [{ kind: "dynCheck", value: ref, type: STRING, loc }],
            type: BOOL,
            loc,
          },
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      };
    }
    lowerer.noLowering(
      "Buffer.isEncoding with this argument shape",
      call,
      "one argument is the lowered form",
    );
  }
  return null; // of, copyBytesFrom, ... → the SC2020 member fence
}

/** `Buffer.prototype.<name>` or `Buffer.prototype[key]` read in JavaScript
 * (smart-buffer's `typeof Buffer.prototype[method]` probe): the member as
 * scr_buffer_prototype_member answers it. Null for other expressions. */
export function lowerBufferPrototypeMember(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken || !isJsSourceFile(expr.getSourceFile())) return null;
  const receiver = expr.expression;
  if (
    !ts.isPropertyAccessExpression(receiver) ||
    receiver.questionDotToken ||
    receiver.name.text !== "prototype" ||
    stdlibGlobalNameOf(lowerer, receiver.expression) !== "Buffer"
  )
    return null;
  const loc = locOf(expr);
  const key: IrExpr = ts.isPropertyAccessExpression(expr)
    ? {
        kind: "dynFrom",
        value: { kind: "strLit", value: expr.name.text, type: STRING, loc },
        type: DYN,
        loc,
      }
    : lowerer.lowerExprExpecting(expr.argumentExpression, DYN);
  return { kind: "libCall", fn: "buffer.prototypeMember", args: [key], type: DYN, loc };
}

const BUFFER_VALUE_FNS: ReadonlySet<string> = new Set([
  "buffer.constructor",
  "buffer.staticValue",
  "buffer.prototypeMember",
]);

/** A program that reads the Buffer function's value installs it in %main,
 * so a Buffer's `.constructor` answers the same function. */
export function installBufferValue(functions: IrFunction[]): void {
  let found = false;
  const visitor = {
    expr: (e: IrExpr): boolean => {
      if (e.kind === "libCall" && BUFFER_VALUE_FNS.has(e.fn)) found = true;
      return !found;
    },
    stmt: (): boolean => !found,
  };
  for (const fn of functions) {
    for (const s of fn.body) everyStmt(s, visitor);
    if (found) break;
  }
  const main = functions.find((fn) => fn.name === ENTRY_NAME);
  if (!found || !main) return;
  main.body.unshift({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "buffer.installValue", args: [], type: VOID, loc: main.loc },
    loc: main.loc,
  });
}
