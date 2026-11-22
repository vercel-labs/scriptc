import { BOOL, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The util builtin call slots. */
export const utilSignatures = defineLibFnSignatures({
  /** node:util.parseArgs: one checked-dynamic config object in, one
   * checked-dynamic ParsedResults tree out. Statically typed member reads
   * validate their values when leaving that tree. The native parser may
   * throw Node's coded validation/grammar TypeErrors. */
  "util.parseArgs": { argTypes: [DYN], result: DYN },
  "util.getCallSites": { argTypes: [DYN, DYN], result: DYN },
  "util.parseEnv": { argTypes: [DYN], result: DYN },
  "util.getSystemErrorName": { argTypes: [DYN], result: STRING },
  "util.getSystemErrorMessage": { argTypes: [DYN], result: STRING },
  "util.systemErrorEntries": { argTypes: [], result: DYN },
  "util.stripVTControlCharacters": { argTypes: [DYN], result: STRING },
  "util.toUSVString": { argTypes: [DYN], result: STRING },
  "util.isDeepStrictEqual": { argTypes: [DYN, DYN, DYN], result: BOOL },
  "util.styleText": { argTypes: [DYN, DYN, DYN], result: STRING },
  /** util.inherits/deprecate/callbackify/debuglog over checked-dynamic
   * arguments (scr_util_callable.c). The function results are native dyn
   * wrappers; call sites with a static function type check them back. */
  "util.inherits": { argTypes: [DYN, DYN], result: VOID },
  "util.inheritsPrototype": { argTypes: [DYN, DYN, DYN], result: VOID },
  "util.deprecate": { argTypes: [DYN, DYN, DYN, DYN], result: DYN },
  "util.isArrayDeprecated": { argTypes: [DYN], result: BOOL },
  "util.extend": { argTypes: [DYN, DYN], result: DYN },
  "util.signalExitCode": { argTypes: [DYN], result: F64 },
  "util.aborted": { argTypes: [DYN, DYN], result: DYN },
  "util.diff": { argTypes: [DYN, DYN], result: DYN },
  "util.markPromiseAsHandled": { argTypes: [DYN], result: VOID },
  "util.transferableAbortSignal": { argTypes: [DYN], result: DYN },
  "util.transferableAbortController": { argTypes: [], result: DYN },
  "util.setTraceSigInt": { argTypes: [DYN], result: VOID },
  "util.debounce": { argTypes: [DYN, DYN, DYN], result: DYN },
  "util.throttle": { argTypes: [DYN, DYN, DYN, DYN], result: DYN },
  "util.callbackify": { argTypes: [DYN], result: DYN },
  /** util.promisify over an untyped function value: a native dyn function
   * whose calls answer a dyn promise the appended callback settles. */
  "util.promisifyDyn": { argTypes: [DYN], result: DYN },
  /** The custom-function protocol the typed promisify lowering runs over
   * the boxed original: the custom function (+1), or the undefined value
   * (+1) when absent or falsy; the static wrapper's marking by the same
   * key takes the wrapper and the original (+1, the same wrapper). */
  "util.promisifyCustom": { argTypes: [DYN], result: DYN },
  "util.promisifyMark": { argTypes: [DYN, DYN], result: DYN },
  "util.debuglog": { argTypes: [DYN, DYN], result: DYN },
  "util.typeIs": { argTypes: [DYN, STRING], result: BOOL },
  "util.typeValue": { argTypes: [DYN, STRING], result: DYN },
});
