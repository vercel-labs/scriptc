import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the module module decided never to throw. */
export const moduleNeverThrow: readonly IrLibFn[] = [
  // The Module class value and its prototype: plain runtime handles that run
  // no program code (the node:module CommonJS-module identity the recent
  // change added).
  "module.ctor",
  "module.ctorPrototype",
  // The Module view of a record: a cache lookup, a retain, and the object
  // built on first use from fields the registry already holds.
  "module.dynObject",
  "module.dynChildren",
  "module.dynParent",
  "module.dynObjectOrAbsent",
  "module.dynOf",
  "module.setExportsDyn",
  // scr_module_compile_cache_dir answers the undefined value, and
  // scr_module_constants builds two objects of constants once per thread;
  // neither takes an argument, and running out of memory ends the process.
  "module.compileCacheDir",
  "module.compileCacheConstants",
  // require.extensions: the shared table's first read builds it; reads after
  // that are a retain.
  "module.extensions",
  // scr_module_namespace_copy_value retains the module's namespace object,
  // marks it as one and records it: no program code runs, and allocation
  // failure ends the process.
  "module.namespaceCopy",
  // The strip-type experimental warning writes one message to stderr on its
  // first call; nothing else runs.
  "module.stripTypesWarning",
  // getSourceMapsSupport retains the thread's frozen record (building it on
  // first use), and findSourceMap answers the immortal undefined value;
  // neither throws, and allocation failure ends the process.
  "module.sourceMapsSupport",
  "module.findSourceMap",
  // scr_module_cache_object builds the one cache object and the Module views
  // in it; no program code runs, and running out of memory ends the process.
  "module.cacheObject",
];
