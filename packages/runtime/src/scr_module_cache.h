/* scriptc runtime — node:module's compile cache family (scr_module_cache.c).
 * A separate header because the declarations name ScrDyn, which scr_lib.h
 * precedes. */
#ifndef SCR_MODULE_CACHE_H
#define SCR_MODULE_CACHE_H

#include "scr_core.h"
#include "scr_dyn.h"

/* module.enableCompileCache(options): a fresh { status, message } with the
 * DISABLED status (+1), or NULL with Node's TypeError pending when the cache
 * directory `options` names is not a string. */
ScrDyn *scr_module_enable_compile_cache(const ScrDyn *options);
/* module.getCompileCacheDir(): undefined, the answer of a process whose
 * compile cache is not enabled. */
ScrDyn *scr_module_compile_cache_dir(void);
/* module.flushCompileCache(keepDeserializedCache): nothing to write, so
 * undefined; NULL with Node's TypeError pending when the argument is neither
 * undefined nor a boolean. */
ScrDyn *scr_module_flush_compile_cache(const ScrDyn *keep);
/* module.constants: the per-thread frozen null-prototype object (+1). */
ScrDyn *scr_module_constants(void);

#endif
