import { BOOL, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The nodeIsland builtin call slots. */
export const nodeIslandSignatures = defineLibFnSignatures({
  /** @scriptc/node calls into Node loaded into the program (scr_node_island.c):
   * the calling module's path, the specifier, the export name and the
   * boxed argument array, copied as JSON. callSync answers the result's
   * JSON copy or throws the copied error; call answers a promise of it. */
  "nodeIsland.callSync": { argTypes: [STRING, STRING, STRING, DYN], result: DYN },
  "nodeIsland.call": {
    argTypes: [STRING, STRING, STRING, DYN],
    result: { kind: "promise", inner: DYN },
  },
  /** Node islands (scope-B NI-4, scr_node_island_handle.c): island values
   * are dyn values (`foreign` lowers as dyn), objects are handle boxes
   * whose identity is the V8 object's. require/import load an island
   * module by its absolute (or `$ORIGIN/`) path; the rest are member reads,
   * writes and calls on island values, argument lists as one dyn array.
   * requireModule(specifier) of @scriptc/node lowers to require too. */
  "nodeIsland.require": { argTypes: [STRING], result: DYN },
  /** process.report, answered by the island (the same process): the
   * diagnostic report object of the running binary. */
  "nodeIsland.processReport": { argTypes: [], result: DYN },
  /** NI-7: a deferred island module (path, boot guards + interface snapshot). */
  "nodeIsland.defer": { argTypes: [STRING, STRING], result: DYN },
  "nodeIsland.import": { argTypes: [STRING], result: { kind: "promise", inner: DYN } },
  /** The program's function for a primitive constructor (`String`), by
   * name: a built-in constructor crosses the island boundary as the other
   * side's own intrinsic (scr_node_island_export.c). */
  "nodeIsland.intrinsic": { argTypes: [STRING, DYN], result: VOID },
  "nodeIsland.get": { argTypes: [DYN, STRING], result: DYN },
  "nodeIsland.getKey": { argTypes: [DYN, DYN], result: DYN },
  "nodeIsland.set": { argTypes: [DYN, STRING, DYN], result: VOID },
  "nodeIsland.setKey": { argTypes: [DYN, DYN, DYN], result: VOID },
  "nodeIsland.invoke": { argTypes: [DYN, STRING, DYN], result: DYN },
  "nodeIsland.apply": { argTypes: [DYN, DYN], result: DYN },
  "nodeIsland.applyTo": { argTypes: [DYN, DYN, DYN], result: DYN },
  "nodeIsland.construct": { argTypes: [DYN, DYN], result: DYN },
  "nodeIsland.instanceof": { argTypes: [DYN, DYN], result: BOOL },
  /** Array.isArray of a dyn value in a program with Node islands: island
   * arrays answer true too. */
  "nodeIsland.isArray": { argTypes: [DYN], result: BOOL },
  /** NI-5: a class instance crossing into an island, with the builder of
   * its class's method table (run once per class). Answers the value. */
  "nodeIsland.classMethods": { argTypes: [DYN, DYN], result: DYN },
  /** NI-5b: native classes extending island classes. subclass(base, name,
   * ctor, fields, methods, getters, setters) makes the JavaScript class;
   * superConstruct(box, args) is the native constructor's super(...);
   * superMethod(base, this, name, args) is super.name(...); defineField
   * defines an instance field; promisify is util.promisify in the island. */
  "nodeIsland.subclass": { argTypes: [DYN, STRING, DYN, DYN, DYN, DYN, DYN], result: DYN },
  "nodeIsland.superConstruct": { argTypes: [DYN, DYN], result: DYN },
  "nodeIsland.superMethod": { argTypes: [DYN, DYN, STRING, DYN], result: DYN },
  "nodeIsland.defineField": { argTypes: [DYN, STRING, DYN], result: VOID },
  "nodeIsland.promisify": { argTypes: [DYN], result: DYN },
  /** clearTimeout (0), clearInterval (1) or clearImmediate (2) of a
   * checked-dynamic value that is not a number: an island's timer is
   * cleared by Node's own function, any other value is ignored. */
  "nodeIsland.clearTimer": { argTypes: [DYN, F64], result: VOID },
  /** NI-6 shared modules: registers a module the program shares with its
   * islands (real path, exports JSON, accessor); the TDZ sentinel an
   * accessor answers; the method table and constructor helper of an
   * exported class by its class value (either may be undefined; answers
   * the class value). */
  "nodeIsland.share": { argTypes: [STRING, STRING, DYN], result: VOID },
  "nodeIsland.sharedTdz": { argTypes: [], result: DYN },
  "nodeIsland.classMethodsOf": { argTypes: [DYN, DYN, DYN], result: DYN },
  /** `v instanceof Error` (or a builtin Error subclass) for an island value. */
  "nodeIsland.instanceofGlobal": { argTypes: [DYN, STRING], result: BOOL },
  /** Whether a dyn value is an island handle (never loads Node). */
  "nodeIsland.isHandle": { argTypes: [DYN], result: BOOL },
  /** Island arrays of copied values as copies (a result, or an awaited
   * promise's value). */
  "nodeIsland.copyArrays": { argTypes: [DYN], result: DYN },
  "nodeIsland.awaitCopy": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  /** The operand of a dynamic await or PromiseResolve in a program with
   * Node islands: an island thenable as the promise V8 adopts it into,
   * any other value as itself. */
  "nodeIsland.adoptThenable": { argTypes: [DYN], result: DYN },
  /** `Promise.resolve(v)` over a dynamic value in a program with Node
   * islands: PromiseResolve, so an island thenable is adopted. */
  "nodeIsland.promiseResolve": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  /** process.exitCode in a program with Node islands: Node's property
   * once Node is loaded, the runtime's own value before
   * (island-process-state.ts). */
  "nodeIsland.setExitCode": { argTypes: [F64], result: VOID },
  "nodeIsland.exitCode": { argTypes: [], result: F64 },
  "nodeIsland.hasExitCode": { argTypes: [], result: BOOL },
  /** process.chdir in a program with Node islands: the runtime's own
   * change, then Node drops its cached process.cwd()
   * (island-process-state.ts). */
  "nodeIsland.chdir": { argTypes: [STRING], result: VOID },
});
