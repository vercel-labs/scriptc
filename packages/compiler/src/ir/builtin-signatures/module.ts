import { arrayOf, BOOL, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The module builtin call slots. */
export const moduleSignatures = defineLibFnSignatures({
  /** Engine-free CommonJS module graph. Module values are scalar f64
   * handles; generated startup defines the registry, init wrappers update
   * loading/cache state, and the read surface answers Node's live metadata. */
  "module.registryInit": { argTypes: [F64], result: VOID },
  "module.define": {
    argTypes: [F64, STRING, STRING, STRING, arrayOf(STRING), BOOL],
    result: VOID,
  },
  "module.enter": { argTypes: [F64], result: VOID },
  "module.link": { argTypes: [F64, F64], result: VOID },
  "module.finish": { argTypes: [F64], result: VOID },
  "module.fail": { argTypes: [F64], result: VOID },
  "module.filename": { argTypes: [F64], result: STRING },
  "module.id": { argTypes: [F64], result: STRING },
  "module.path": { argTypes: [F64], result: STRING },
  "module.paths": { argTypes: [F64], result: arrayOf(STRING) },
  "module.children": { argTypes: [F64], result: arrayOf(F64) },
  "module.parent": { argTypes: [F64], result: F64 },
  "module.loaded": { argTypes: [F64], result: BOOL },
  "module.cacheGet": { argTypes: [STRING], result: F64 },
  /** createRequire's require(id) and require.resolve(request, options)
   * with a specifier computed at run time (scr_require.c): the arguments,
   * then the requiring file, the call's "file:line" and the builtin ids.
   * Both resolve like Node at run time. requireComputed always throws
   * (Node's argument errors or MODULE_NOT_FOUND), or ends the program with
   * an SC2020 refusal when the specifier resolves; resolveComputed answers
   * the resolved id or real path. */
  "module.requireComputed": { argTypes: [DYN, STRING, STRING, arrayOf(STRING)], result: DYN },
  "module.resolveComputed": {
    argTypes: [DYN, DYN, STRING, STRING, arrayOf(STRING)],
    result: STRING,
  },
  "module.cacheHas": { argTypes: [STRING], result: BOOL },
  "module.cacheKeys": { argTypes: [], result: arrayOf(STRING) },
  /** node:module's compile cache family (scr_module_cache.c). A compiled
   * program loads no JavaScript, so enableCompileCache validates its
   * argument as Node does and answers a fresh { status, message } with the
   * DISABLED status, getCompileCacheDir answers undefined, and
   * flushCompileCache validates its argument and writes nothing. */
  "module.compileCacheEnable": { argTypes: [DYN], result: DYN },
  "module.compileCacheDir": { argTypes: [], result: DYN },
  "module.compileCacheFlush": { argTypes: [DYN], result: DYN },
  /** module.constants: the per-thread frozen null-prototype object that
   * holds compileCacheStatus. */
  "module.compileCacheConstants": { argTypes: [], result: DYN },
  /** A module namespace object as a checked-dynamic value
   * (scr_module_namespace_value): the module id, its sorted export names
   * and the compiled getter. One object per module. Never throws. */
  "module.namespaceValue": { argTypes: [STRING, arrayOf(STRING), DYN], result: DYN },
  /** A module namespace as typed code sees it through a dynamic slot
   * (scr_module_namespace_dyn_value): the module id, its sorted export
   * names, the compiled getter, and the Symbol.toStringTag key. Draws
   * Node's frozen null-prototype object, one per module. Never throws. */
  "module.namespaceDyn": { argTypes: [STRING, arrayOf(STRING), DYN, DYN], result: DYN },
  /** A module namespace built from its export values as a JavaScript
   * source takes one (scr_module_namespace_copy_value): the module id and
   * the object holding the values. One marked object per module, so the
   * namespace keeps its identity. Never throws. */
  "module.namespaceCopy": { argTypes: [STRING, DYN], result: DYN },
  /** Node's Module object as a checked-dynamic value; one per record. */
  "module.dynObject": { argTypes: [F64], result: DYN },
  "module.dynChildren": { argTypes: [F64], result: DYN },
  "module.dynParent": { argTypes: [F64], result: DYN },
  "module.dynObjectOrAbsent": { argTypes: [F64], result: DYN },
  "module.dynOf": { argTypes: [DYN], result: DYN },
  "module.setExportsDyn": { argTypes: [F64, DYN], result: VOID },
});
