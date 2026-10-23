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
/* util.types.<probe>(value) answered by Node for an island handle. */
bool scr_ni_util_type_is(const ScrDyn *value, const ScrStr *probe);
/* Array.isArray of a dyn value, island arrays included. */
bool scr_ni_is_array(ScrDyn *value);
/* Prints Node's uncaught-exception report for an error thrown by island
 * code (true), or nothing (false: not an island error). */
bool scr_ni_report_uncaught(ScrError *error);
int scr_ni_instanceof(ScrDyn *value, ScrDyn *ctor);
bool scr_ni_is_handle(const ScrDyn *value);
/* ToPrimitive of an island object (hint SCR_DYN_HINT_*), run by V8:
 * Symbol.toPrimitive, then toString/valueOf in the hint's order. +1, or
 * NULL with the exception pending. */
ScrDyn *scr_ni_to_primitive(const ScrDyn *self, int hint);
bool scr_ni_is_function(const ScrDyn *value); /* an island handle that is callable */
/* util.inspect of an island value at nesting `recurse` with limit `depth`,
 * by Node's own util.inspect (+1; "" with the exception pending). */
ScrStr *scr_ni_inspect(const ScrDyn *value, double recurse, double depth);
ScrDyn *scr_ni_own_keys(ScrDyn *obj, int mode); /* 0 Object.keys, 1 Reflect.ownKeys */
ScrPromise *scr_ni_await(ScrDyn *value);
/* Island arrays as copies for results typed as arrays of copied values. */
ScrDyn *scr_node_island_copy_arrays(ScrDyn *value);
ScrPromise *scr_node_island_await_copy(ScrDyn *value);
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

/* ── native values in Node (scope-B NI-5, scr_node_island_export.c) ───────
 * Closures, promises, records, class instances and dyn objects cross into
 * Node by reference: one export id and one V8 representative per native
 * referent. The conversions of scr_node_island_handle.c call these. */
bool scr_ni_value_out(ScrDyn *v, struct ScrNodeValue *out); /* NI-4's into-V8 conversion */
ScrDyn *scr_ni_value_in(const struct ScrNodeValue *v);      /* +1 */
ScrDyn *scr_ni_arg_in(const struct ScrNodeValue *v); /* +1; island Errors as their ScrError */
bool scr_ni_exportable(const ScrDyn *v);
void scr_ni_export_out(ScrDyn *v, struct ScrNodeValue *out);
ScrDyn *scr_ni_export_value(uint32_t id); /* borrowed, or NULL */
uint32_t scr_ni_live_exports(void);
/* nodeIsland.classMethods: registers the method table of a class capsule. */
ScrDyn *scr_node_island_class_methods(ScrDyn *value, ScrDyn *builder);
/* NI-5d: native subclasses of island classes created on first use. */
ScrDyn *scr_ni_subclass_create(ScrDyn *const *args);
ScrDyn *scr_ni_lazy_subclass_new(ScrDyn *const *args);
void scr_ni_bridge_export_settle(uint32_t id, int rejected, const struct ScrNodeValue *value);
int scr_ni_host_export_call(uint32_t id, const struct ScrNodeValue *this_,
                            const struct ScrNodeValue *args, size_t argc, struct ScrNodeValue *out);
int scr_ni_host_export_construct(uint32_t id, const struct ScrNodeValue *args, size_t argc,
                                 struct ScrNodeValue *out);
int scr_ni_host_export_get(uint32_t id, const struct ScrNodeValue *key, struct ScrNodeValue *out);
int scr_ni_host_export_set(uint32_t id, const struct ScrNodeValue *key,
                           const struct ScrNodeValue *value, struct ScrNodeValue *out);
int scr_ni_host_export_has(uint32_t id, const struct ScrNodeValue *key);
int scr_ni_host_export_delete(uint32_t id, const struct ScrNodeValue *key, struct ScrNodeValue *out);
int scr_ni_host_export_keys(uint32_t id, struct ScrNodeValue *out);
void scr_ni_host_export_watch(uint32_t id);
void scr_ni_host_export_release(uint32_t id);
/* ── shared modules (scope-B NI-6, scr_node_island_export.c) ── */
void scr_node_island_share(ScrStr *path, ScrStr *exports, ScrDyn *accessor);
ScrDyn *scr_node_island_shared_tdz(void);
ScrDyn *scr_node_island_class_methods_of(ScrDyn *cls, ScrDyn *builder, ScrDyn *ctor);
void scr_ni_shared_refresh(void);
void scr_ni_exports_release_all(void); /* at exit, after Node stopped */
void *scr_ni_value_out_begin(ScrDyn *v, struct ScrNodeValue *out, bool *ok);
void scr_ni_value_out_end(void *keep);
int scr_ni_host_export_instance_of(uint32_t id, const struct ScrNodeValue *value);
void scr_ni_host_shared_table(struct ScrNodeValue *out);
int scr_ni_host_shared_get(uint32_t mod, uint32_t slot, int mode, struct ScrNodeValue *out);
void scr_ni_host_shared_tdz(struct ScrNodeValue *out);
int scr_ni_host_export_op(uint32_t id, uint32_t op, const struct ScrNodeValue *args, size_t argc,
                          struct ScrNodeValue *out);
/* Promise settlement callback (SCR_NODE_ISLANDS build of scr_async.c). */
void scr_promise_on_settle_sync(ScrPromise *in, void (*cb)(ScrPromise *dst, ScrPromise *src));

/* ── deferred island modules (scope-B NI-7, scr_node_island_boot.c) ─────
 * nodeIsland.defer(path, snapshot): a statically imported island module the
 * build proved effect-free at load evaluates on first real use instead of
 * at its import position. The snapshot (lower-node-island.ts) holds the
 * boot guards (the libnode pack's and the module files' identity) and the
 * interface snapshot (export names, kinds, function name/length, primitive
 * constants). Guards pass: the module's value is a stub handle and Node
 * does not start; a guard fails: the module loads here, eagerly. When Node
 * starts for any reason, every deferred module evaluates first, in import
 * order, and each stub is reconciled with its real value (same ref, so
 * identity holds for the rest of the program). +1, NULL with an exception
 * pending (an eager load that threw). */
ScrDyn *scr_node_island_defer(ScrStr *path, ScrStr *snapshot);
/* Between the boot and handle units. */
ScrDyn *scr_ni_stub_new(uint32_t flags, void *stub); /* +1 box over a fresh stub ref */
void *scr_ni_stub_of(const ScrDyn *value); /* the stub entry of an unmaterialized stub, or NULL */
bool scr_ni_stub_reconcile(ScrDyn *stub, ScrDyn *real);
ScrDyn *scr_ni_boot_member(void *stub, const char *key, size_t len); /* +1 or NULL: unknown */
bool scr_ni_boot_plain_class(void *stub);
const char *scr_ni_pack_dir(void); /* the libnode pack directory this run uses */
void scr_ni_boot_stub_failed(void *stub); /* raises the module's load error */
/* Called at the end of Node's start (scr_node_island.c), set by the boot unit. */
extern void (*scr_ni_started_hook)(void);

/* Island operations the compiler emits (lib-shared.ts adapters). */
ScrDyn *scr_node_island_apply(ScrDyn *fn, ScrDyn *args);
ScrDyn *scr_node_island_construct(ScrDyn *ctor, ScrDyn *args);
void scr_node_island_define_field(ScrDyn *self, ScrStr *key, ScrDyn *value);
ScrDyn *scr_node_island_get(ScrDyn *obj, ScrStr *key);
ScrDyn *scr_node_island_get_key(ScrDyn *obj, ScrDyn *key);
bool scr_node_island_instanceof(ScrDyn *value, ScrDyn *ctor);
bool scr_node_island_instanceof_global(ScrDyn *value, ScrStr *name);
ScrDyn *scr_node_island_invoke(ScrDyn *obj, ScrStr *key, ScrDyn *args);
ScrDyn *scr_node_island_promisify(ScrDyn *fn);
void scr_node_island_set(ScrDyn *obj, ScrStr *key, ScrDyn *value);
void scr_node_island_set_key(ScrDyn *obj, ScrDyn *key, ScrDyn *value);
ScrDyn *scr_node_island_subclass(ScrDyn *base, ScrStr *name, ScrDyn *ctor, ScrDyn *fields, ScrDyn *methods, ScrDyn *getters, ScrDyn *setters);
ScrDyn *scr_node_island_super_construct(ScrDyn *box, ScrDyn *args);
ScrDyn *scr_node_island_super_method(ScrDyn *base, ScrDyn *self, ScrStr *name, ScrDyn *args);

#endif /* SCR_NODE_ISLAND_H */
