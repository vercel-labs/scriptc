import type { IrRegexIntrinsicMethod, IrStrIntrinsicMethod, IrType } from "./ir.js";
import { arrayOf, BOOL, F64, REGEX, STRING, VOID } from "./ir.js";

/** Per-method signature for strIntrinsic: `argTypes` lists every argument
 * position (optional ones included); `minArgs` is the minimum number of required arguments
 * before optional trailing positions (backends fill the documented defaults). Shared with the
 * frontend's lib-boundary pass (lib-boundary.ts), which coerces or fences
 * checked-dynamic arguments against the same table the validator enforces. */
export const STR_INTRINSIC_SIGS: Record<
  IrStrIntrinsicMethod,
  { argTypes: IrType[]; minArgs: number; result: IrType }
> = {
  length: { argTypes: [], minArgs: 0, result: F64 },
  charCodeAt: { argTypes: [F64], minArgs: 1, result: F64 },
  charAt: { argTypes: [F64], minArgs: 1, result: STRING },
  indexOf: { argTypes: [STRING, F64], minArgs: 1, result: F64 },
  includes: { argTypes: [STRING, F64], minArgs: 1, result: BOOL },
  startsWith: { argTypes: [STRING, F64], minArgs: 1, result: BOOL },
  endsWith: { argTypes: [STRING, F64], minArgs: 1, result: BOOL },
  slice: { argTypes: [F64, F64], minArgs: 0, result: STRING },
  substring: { argTypes: [F64, F64], minArgs: 1, result: STRING },
  repeat: { argTypes: [F64], minArgs: 1, result: STRING },
  trim: { argTypes: [], minArgs: 0, result: STRING },
  trimStart: { argTypes: [], minArgs: 0, result: STRING },
  trimEnd: { argTypes: [], minArgs: 0, result: STRING },
  split: { argTypes: [STRING, F64], minArgs: 2, result: arrayOf(STRING) },
  padStart: { argTypes: [F64, STRING], minArgs: 2, result: STRING },
  padEnd: { argTypes: [F64, STRING], minArgs: 2, result: STRING },
  toLowerCase: { argTypes: [], minArgs: 0, result: STRING },
  toUpperCase: { argTypes: [], minArgs: 0, result: STRING },
  normalize: { argTypes: [STRING], minArgs: 1, result: STRING },
  isWellFormed: { argTypes: [], minArgs: 0, result: BOOL },
  toWellFormed: { argTypes: [], minArgs: 0, result: STRING },
  byteLength: { argTypes: [], minArgs: 0, result: F64 },
  cpAtByte: { argTypes: [F64], minArgs: 1, result: STRING },
};

/** Per-method signature for regexIntrinsic. test/source/flags take the
 * regex as receiver; replace/replaceAll/split take the STRING as receiver
 * with the regex as args[0] (mirroring the source syntax). All positions
 * are required — the surface has no optionals. */
export const REGEX_INTRINSIC_SIGS: Record<
  IrRegexIntrinsicMethod,
  { receiver: IrType; argTypes: IrType[]; result: IrType }
> = {
  test: { receiver: REGEX, argTypes: [STRING], result: BOOL },
  // match's result is the program-dependent `string[] | null` union —
  // VOID here is the process.envGet sentinel; the regexIntrinsic case
  // checks the union's arms.
  match: { receiver: STRING, argTypes: [REGEX], result: VOID },
  exec: { receiver: STRING, argTypes: [REGEX], result: VOID },
  execGroups: { receiver: STRING, argTypes: [REGEX, F64], result: VOID },
  execSpans: { receiver: STRING, argTypes: [REGEX, F64, F64], result: VOID },
  matchGroups: { receiver: STRING, argTypes: [REGEX, F64, F64], result: VOID },
  lastIndex: { receiver: REGEX, argTypes: [], result: F64 },
  matchAll: { receiver: STRING, argTypes: [REGEX], result: arrayOf(arrayOf(STRING)) },
  matchAllCaptures: { receiver: STRING, argTypes: [REGEX], result: arrayOf(arrayOf(STRING)) },
  matchAllInto: {
    receiver: STRING,
    argTypes: [REGEX, arrayOf(F64)],
    result: arrayOf(arrayOf(STRING)),
  },
  matchAllCapturesInto: {
    receiver: STRING,
    argTypes: [REGEX, arrayOf(F64)],
    result: arrayOf(arrayOf(STRING)),
  },
  search: { receiver: STRING, argTypes: [REGEX], result: F64 },
  source: { receiver: REGEX, argTypes: [], result: STRING },
  flags: { receiver: REGEX, argTypes: [], result: STRING },
  toString: { receiver: REGEX, argTypes: [], result: STRING },
  replace: { receiver: STRING, argTypes: [REGEX, STRING], result: STRING },
  replaceAll: { receiver: STRING, argTypes: [REGEX, STRING], result: STRING },
  split: { receiver: STRING, argTypes: [REGEX, F64], result: arrayOf(STRING) },
};
