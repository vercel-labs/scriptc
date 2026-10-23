/* scriptc runtime — Node islands (scr_node_island.c). Linked only into
 * programs whose IR calls into Node.js (the `nodeIsland` runtime feature),
 * together with the SCR_NODE_ISLANDS build of scr_async.c, which defines
 * the loop slot below. */
#ifndef SCR_NODE_ISLAND_H
#define SCR_NODE_ISLAND_H

#include "scr_async.h"
#include "scr_dyn.h"

/* Records the build-time configuration: the libnode pack directory
 * (absolute, or `$ORIGIN/`-relative to the executable) and the Node version
 * its bridge must link. Both strings are static. The emitted main calls it
 * before %main. */
void scr_node_island_install(const char *libnode, const char *node_version);

/* @scriptc/node callSync(specifier, name, ...args): `file` is the calling
 * module's path (relative specifiers resolve from it), `args` the boxed
 * argument array, copied as JSON. Returns the JSON copy of the result, +1,
 * or NULL with the copied error pending. Borrows every argument. */
ScrDyn *scr_node_island_call_sync(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args);

/* @scriptc/node call(...): the same call, asynchronous. Returns a +1
 * promise that settles with the result's copy, or rejects with the copied
 * error (also when the arguments cannot be copied). Never throws. */
ScrPromise *scr_node_island_call(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args);

/* The hosted loop (SCR_NODE_ISLANDS build of scr_async.c, scope-B NI-3).
 * scr_loop_host moves the runtime's pending ticks, promise jobs, timers
 * and immediates onto Node's queues through `bridge` and schedules every
 * later one there; `since_ms` (scr_now_ms() before Node began loading) is
 * the clock pending timers count their remaining delay from. The rest are
 * the bridge's host callbacks (scr_node_bridge.h). */
struct ScrNodeBridge;
struct ScrNodeIoState;
void scr_loop_host(const struct ScrNodeBridge *bridge, double since_ms);
bool scr_loop_is_hosted(void);
void scr_loop_hosted_run(uint32_t kind, uint32_t token);
void scr_loop_hosted_io_state(struct ScrNodeIoState *state);
void scr_loop_hosted_io(void);
void scr_loop_hosted_microtasks_done(void);

/* Process events island code listens to (SCR_NODE_EVENT_* of the bridge
 * ABI). Their listeners sit in the runtime's registries (the
 * SCR_NODE_ISLANDS build of scr_events.c) at their registration position,
 * and a delivery calls them through scr_node_island_emit: a signal with
 * its number, exit with the code. */
enum { SCR_NODE_ISLAND_EVENT_SIGNAL = 1, SCR_NODE_ISLAND_EVENT_EXIT = 2 };
void scr_node_island_emit(uint32_t event, uint32_t listener, ScrStr *name, int arg);
void scr_signal_on_island(ScrStr *name, uint32_t listener);
void scr_signal_off_island(uint32_t listener);
void scr_process_on_exit_island(uint32_t listener);
void scr_process_off_exit_island(uint32_t listener);

/* ── object handles (scope-B NI-4, scr_node_island_handle.c) ─────────────
 * Island values the program holds are SCR_DYN_HANDLE boxes with tag
 * SCR_DYNH_NODE_ISLAND: one handle per V8 value, so `===` is identity.
 * Primitives, strings and BigInt are copies; island promises are scriptc
 * promises; typed arrays and Buffers are ScrBytes over the same memory.
 * All arguments are borrowed; ScrDyn results are +1, NULL (or false, or
 * -1 for the int forms) with the exception pending. The first call loads
 * Node. See scriptc-perf/results/ni-4/ABI.md. */
ScrDyn *scr_ni_require(ScrStr *path);     /* require(absolute path): the exports */
ScrPromise *scr_ni_import(ScrStr *path);  /* import(absolute path): the namespace */
ScrDyn *scr_ni_get(ScrDyn *obj, ScrDyn *key);
ScrDyn *scr_ni_get_str(ScrDyn *obj, const char *key, size_t len);
bool scr_ni_set(ScrDyn *obj, ScrDyn *key, ScrDyn *value);
bool scr_ni_set_str(ScrDyn *obj, const char *key, size_t len, ScrDyn *value);
int scr_ni_has(ScrDyn *obj, ScrDyn *key);
int scr_ni_delete(ScrDyn *obj, ScrDyn *key);
ScrDyn *scr_ni_call(ScrDyn *fn, ScrDyn *this_, ScrDyn *const *args, size_t argc);
ScrDyn *scr_ni_call_method(ScrDyn *obj, const char *key, size_t len, ScrDyn *const *args,
                           size_t argc);
ScrDyn *scr_ni_construct(ScrDyn *ctor, ScrDyn *const *args, size_t argc);
ScrStr *scr_ni_typeof(ScrDyn *value);
int scr_ni_instanceof(ScrDyn *value, ScrDyn *ctor);
bool scr_ni_is_handle(const ScrDyn *value);
bool scr_ni_is_function(const ScrDyn *value); /* an island handle that is callable */
/* util.inspect of an island value at nesting `recurse` with limit `depth`,
 * by Node's own util.inspect (+1; "" with the exception pending). */
ScrStr *scr_ni_inspect(const ScrDyn *value, double recurse, double depth);
ScrDyn *scr_ni_own_keys(ScrDyn *obj, int mode); /* 0 Object.keys, 1 Reflect.ownKeys */
ScrPromise *scr_ni_await(ScrDyn *value);
uint32_t scr_ni_live_handles(void); /* live import-table entries (leak tests) */

/* Between the two island units. */
struct ScrNodeValue;
const struct ScrNodeBridge *scr_ni_bridge(void);        /* loads Node */
const struct ScrNodeBridge *scr_ni_bridge_loaded(void); /* NULL until loaded */
void scr_ni_on_node_stack(void (*job)(void *), void *arg);
void scr_ni_settle_value(uint32_t token, int rejected, const struct ScrNodeValue *value);
void scr_ni_bytes_free(void *owner);
void scr_ni_handles_install(void);
void scr_ni_stop(void);

/* Island operations the compiler emits (lib-shared.ts adapters). */
ScrDyn *scr_node_island_apply(ScrDyn *fn, ScrDyn *args);
ScrDyn *scr_node_island_construct(ScrDyn *ctor, ScrDyn *args);
ScrDyn *scr_node_island_get(ScrDyn *obj, ScrStr *key);
bool scr_node_island_instanceof(ScrDyn *value, ScrDyn *ctor);
ScrDyn *scr_node_island_invoke(ScrDyn *obj, ScrStr *key, ScrDyn *args);
void scr_node_island_set(ScrDyn *obj, ScrStr *key, ScrDyn *value);
void scr_node_island_set_key(ScrDyn *obj, ScrDyn *key, ScrDyn *value);

#endif /* SCR_NODE_ISLAND_H */
