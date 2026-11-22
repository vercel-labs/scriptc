import { arrayOf, BOOL, DYN, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The global builtin call slots. */
export const globalSignatures = defineLibFnSignatures({
  // Always throws; the result is the READ's declared type (a typed dummy
  // the unwind abandons) — the libCall case skips the result check.
  /** A read of a `declare`d const NOTHING defines (the bundler-define
   * pattern — __VERSION__): always throws the catchable ReferenceError
   * Node raises at the access ("<name> is not defined"). args[0] is the
   * name; the result type is the read's declared type (a typed dummy the
   * unwind abandons — the value never exists). */
  "global.undefRead": { argTypes: [STRING], result: VOID },
  /** A native reference to the global object; known names retain value fences. */
  "global.native": { argTypes: [arrayOf(STRING)], result: DYN },
  /** Arms the runtime check for the Node globals the native runtime does not
   * implement (host-globals.ts): the compiler's derived name table. */
  "global.hostAbsent": { argTypes: [arrayOf(STRING)], result: VOID },
  /** Installs the program's builtin-global lookup (global-values.ts). */
  "global.installValues": { argTypes: [DYN], result: VOID },
  /** The keys `for (key in globalThis)` visits, as a fresh object. */
  "global.forInObject": { argTypes: [], result: DYN },
  /** A JavaScript read of a name no declaration binds (scr_node_builtin.c):
   * the global object's own property of that name, or Node's
   * ReferenceError "<name> is not defined" when it has none. bindingValue
   * is the same property for `typeof`, undefined when absent; bindingHas
   * tests that the property exists. */
  "global.bindingRead": { argTypes: [STRING], result: DYN },
  "global.bindingValue": { argTypes: [STRING], result: DYN },
  "global.bindingHas": { argTypes: [STRING], result: BOOL },
});
