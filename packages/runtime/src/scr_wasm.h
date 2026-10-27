/* scriptc runtime — the WebAssembly JavaScript API (scr_wasm.c): the entry
 * points the LLVM backend calls for the wasm.* lib functions. Included by
 * scr_runtime.h, which says where new declarations go. The contract with
 * translated modules, including scr_wasm_registry, is in scr_wasm_abi.h. */
#ifndef SCR_WASM_H
#define SCR_WASM_H

#include "scr_async.h"
#include "scr_dyn.h"
#include "scr_wasm_abi.h"

ScrPromise *scr_wasm_compile(ScrDyn *bytes);
bool scr_wasm_validate(ScrDyn *bytes);
ScrPromise *scr_wasm_instantiate(ScrDyn *source, ScrDyn *imports);
ScrDyn *scr_wasm_module_new(ScrDyn *bytes);
ScrDyn *scr_wasm_instance_new(ScrDyn *module, ScrDyn *imports);
bool scr_wasm_is(const ScrDyn *value, double kind);
ScrDyn *scr_wasm_error_new(double kind, ScrDyn *message, ScrDyn *options);
ScrDyn *scr_wasm_function(double kind);
ScrDyn *scr_wasm_namespace(void);
ScrDyn *scr_wasm_global_view(void);
ScrDyn *scr_wasm_memory_construct(ScrDyn *descriptor);
ScrDyn *scr_wasm_table_construct(ScrDyn *descriptor, ScrDyn *value);
ScrDyn *scr_wasm_global_construct(ScrDyn *descriptor, ScrDyn *value);
ScrDyn *scr_wasm_construct_without_new(double kind, ScrDyn *arg0, ScrDyn *arg1);
ScrDyn *scr_wasm_module_imports(ScrDyn *module);
ScrDyn *scr_wasm_module_exports(ScrDyn *module);
ScrDyn *scr_wasm_module_custom_sections(ScrDyn *module, ScrDyn *name);
ScrDyn *scr_wasm_value_of(ScrDyn *value);

#endif /* SCR_WASM_H */
