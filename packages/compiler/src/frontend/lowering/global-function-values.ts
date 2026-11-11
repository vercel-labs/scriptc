/** Builtin global functions JavaScript sources read as values (`const p =
 * parseInt`, `globalThis[name]`) beyond the interned function and
 * constructor values (builtinGlobalValue):
 * - parseInt and parseFloat are the Number statics' function values, as in
 *   Node (`parseInt === Number.parseInt`).
 * - isNaN and isFinite convert their argument with ToNumber.
 * - Symbol makes a symbol whose description is its argument's ToString, or
 *   one without a description when the argument is undefined.
 * - eval throws the EvalError a direct call throws (code-generation.ts).
 * - escape, unescape, WeakRef and AsyncDisposableStack have no lowering:
 *   their values have Node's name and length and throw SC2020 when called
 *   or constructed, as their direct uses refuse. */
import {
  BOOL,
  DYN,
  F64,
  STRING,
  SYMBOL_T,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { dynUndefinedExpr, nodeThrowExpr, varRef } from "../../ir/build.js";
import { noLoweringDiag } from "../../diagnostics/diagnostic.js";
import type { Lowerer } from "./lowerer.js";
import { lowerNumberParserValue } from "./lower-builtin-values.js";
import { CODE_GENERATION_DISALLOWED } from "./code-generation.js";
import { globalFunctionFenceValue } from "./builtin-function-fences.js";

/** The globals without a lowering whose values every source language reads
 * through this file (the others a JavaScript source reads are answered by
 * the same builder at the identifier and member reads). Node's length for
 * each comes from the census of the pinned Node (node-values.ts). */
const UNLOWERED: ReadonlySet<string> = new Set([
  "escape",
  "unescape",
  "WeakRef",
  "AsyncDisposableStack",
]);

/** Whether `name` is a global without a lowering, whose value throws the
 * fence. TypeScript sources keep the compile-time refusal for these. */
export function isUnloweredGlobal(name: string): boolean {
  return UNLOWERED.has(name);
}

/** The globals function values are built for: the ones read below, and the
 * ones without a lowering. */
const GLOBAL_VALUE_NAMES: ReadonlySet<string> = new Set([
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "Symbol",
  "eval",
  ...UNLOWERED,
]);

/** Whether a JavaScript source reads `name` as one of the function values
 * this file builds (never as a class value). */
export function hasGlobalFunctionValue(name: string): boolean {
  return GLOBAL_VALUE_NAMES.has(name);
}

/** The value a JavaScript source reads for the global function `name`, or
 * null when it has none here. `reportFences` is false for the program's
 * global lookup, which holds every declared global's value whether or not
 * the program reads it: only a read reports the value's fence. */
export function globalFunctionValue(
  lowerer: Lowerer,
  name: string,
  loc: SrcLoc,
  reportFences = true,
): IrExpr | null {
  switch (name) {
    case "parseInt":
    case "parseFloat":
      return lowerNumberParserValue(lowerer, name, loc);
    case "isNaN":
    case "isFinite":
      return numberTestValue(lowerer, name, loc);
    case "Symbol":
      return symbolValue(lowerer, loc);
    case "eval":
      return evalValue(lowerer, loc);
    default:
      return UNLOWERED.has(name) ? unloweredValue(lowerer, name, loc, reportFences) : null;
  }
}

/** A lifted function `%builtin.global.<name>` of one checked-dynamic
 * parameter, defined once, boxed under Node's name and, when it differs
 * from 1, Node's length. */
function oneArgumentValue(
  lowerer: Lowerer,
  name: string,
  ret: IrType,
  body: (argument: IrExpr) => IrStmt[],
  loc: SrcLoc,
  length?: number,
): IrExpr {
  const fnName = `%builtin.global.${name}`;
  if (lowerer.liftedFnNamed(fnName) === undefined)
    lowerer.liftedFns.push({
      name: fnName,
      params: [{ localId: "value.0", name: "value", type: DYN }],
      locals: [{ id: "value.0", name: "value", type: DYN, mutable: false }],
      returnType: ret,
      body: body(varRef("value.0", DYN, loc)),
      loc,
    });
  return {
    kind: "dynFrom",
    value: {
      kind: "closure",
      fnName,
      captures: [],
      type: { kind: "func", params: [DYN], ret },
      loc,
    },
    fnName: name,
    ...(length !== undefined ? { fnLength: length } : {}),
    type: DYN,
    loc,
  };
}

/** isNaN and isFinite: ToNumber, then the test. */
function numberTestValue(lowerer: Lowerer, name: "isNaN" | "isFinite", loc: SrcLoc): IrExpr {
  return oneArgumentValue(
    lowerer,
    name,
    BOOL,
    (argument) => [
      {
        kind: "return",
        value: {
          kind: "libCall",
          fn: name === "isNaN" ? "num.isNaN" : "number.isFinite",
          args: [{ kind: "libCall", fn: "dyn.toNumberCoerce", args: [argument], type: F64, loc }],
          type: BOOL,
          loc,
        },
        loc,
      },
    ],
    loc,
  );
}

/** Symbol(description). */
function symbolValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  return oneArgumentValue(
    lowerer,
    "Symbol",
    SYMBOL_T,
    (argument) => [
      {
        kind: "if",
        cond: { kind: "dynTest", test: "undefined", value: argument, type: BOOL, loc },
        then: [
          {
            kind: "return",
            value: { kind: "libCall", fn: "sym.newAnon", args: [], type: SYMBOL_T, loc },
            loc,
          },
        ],
        else_: null,
        loc,
      },
      {
        kind: "return",
        value: {
          kind: "libCall",
          fn: "sym.new",
          args: [
            { kind: "libCall", fn: "dyn.toStringCoerce", args: [argument], type: STRING, loc },
          ],
          type: SYMBOL_T,
          loc,
        },
        loc,
      },
    ],
    loc,
    // Node's Symbol declares no parameters.
    0,
  );
}

/** eval: the EvalError every code-generation call throws. */
function evalValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  return oneArgumentValue(
    lowerer,
    "eval",
    DYN,
    () => [
      {
        kind: "exprStmt",
        expr: nodeThrowExpr(6, "", CODE_GENERATION_DISALLOWED, F64, loc),
        loc,
      },
      { kind: "return", value: dynUndefinedExpr(loc), loc },
    ],
    loc,
  );
}

/** A global without a lowering: calling or constructing it throws the
 * SC2020 fence its direct use reports. Each read that reaches the value
 * reports the fence; the program's lookup holds the value without
 * reporting one. */
function unloweredValue(
  lowerer: Lowerer,
  name: string,
  loc: SrcLoc,
  reportFences: boolean,
): IrExpr {
  const diag = noLoweringDiag(name, loc);
  if (reportFences) lowerer.runtimeFences.push(diag);
  return globalFunctionFenceValue(lowerer, name, loc, diag);
}
