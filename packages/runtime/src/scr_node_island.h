/* scriptc runtime — Node islands (scr_node_island.c). Linked only into
 * programs whose IR calls into Node.js (the `nodeIsland` runtime feature),
 * together with the SCR_NODE_ISLANDS build of scr_async.c, which defines
 * the loop slot below. */
#ifndef SCR_NODE_ISLAND_H
#define SCR_NODE_ISLAND_H

#include "scr_async.h"
#include "scr_dyn.h"
#include "scr_events.h"

#include <stdatomic.h>

/* Records the build-time configuration: the libnode pack directory
 * (absolute, or `$ORIGIN/`-relative to the executable) and the Node version
 * its bridge must link. Both strings are static. The emitted main calls it
 * before %main. */
void scr_node_island_install(const char *libnode, const char *node_version);

/* Records the island module tree (node-islands/modules.ts): its manifest,
 * and its files concatenated in manifest order when the executable carries
 * them (NULL when they ship beside it at `location`, a `$ORIGIN/` path; ""
 * otherwise). All static. The emitted main calls it after
 * scr_node_island_install. */
void scr_node_island_install_modules(const char *manifest, size_t manifest_len,
                                     const unsigned char *data, size_t data_len,
                                     const char *location);

/* @scriptc/node callSync(specifier, name, ...args): `file` is the calling
 * module's path (relative specifiers resolve from it), `args` the boxed
 * argument array, copied as JSON. Returns the JSON copy of the result, +1,
 * or NULL with the copied error pending. Borrows every argument. */
ScrDyn *scr_node_island_call_sync(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args);

/* @scriptc/node call(...): the same call, asynchronous. Returns a +1
 * promise that settles with the result's copy, or rejects with the copied
 * error (also when the arguments cannot be copied). Never throws. */
ScrPromise *scr_node_island_call(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args);

/* Whether island code can run on a thread other than the island's. Only an
 * executable with worker threads has such a thread. SCR_WORKERS is a
 * whole-runtime mode: every other build has one script thread, and
 * scr_context_is_main() is the constant true there, behind a call the
 * compiler cannot see through. The island units therefore ask through
 * scr_ni_main_thread() and test SCR_NI_THREADS, so that in a program
 * without workers the routing, the locks, the shared mode of the tables and
 * every thread test are constants: an island operation runs the
 * instructions it ran before threads could reach an island. */
#ifdef SCR_WORKERS
#define SCR_NI_THREADS 1
static inline bool scr_ni_main_thread(void) { return scr_context_is_main(); }
#else
#define SCR_NI_THREADS 0
static inline bool scr_ni_main_thread(void) { return true; }
#endif

/* Island operations from other threads. Node runs on the thread that
 * started it (the main thread), so an operation another thread reaches
 * through an island value posts itself to that thread and waits for the
 * answer; the loop below drains the posted operations. Without worker
 * threads nothing is ever posted, the loop tests fold away and no wake
 * pipe is opened. */
#if SCR_NI_THREADS
bool scr_ni_remote_pending(void);
int scr_ni_remote_pollfd(void);
void scr_ni_remote_dispatch(void);
#else
static inline bool scr_ni_remote_pending(void) { return false; }
static inline int scr_ni_remote_pollfd(void) { return -1; }
static inline void scr_ni_remote_dispatch(void) {}
#endif
/* The operation the calling thread posted last did not run, because the
 * thread was asked to stop first: its termination is pending and the
 * operation's out-values are as the caller initialized them. */
extern SCR_TL bool scr_ni_unserved;

/* Whether a thread other than the island's has used the island: until
 * then the island tables take no locks (scr_node_island_handle.c). */
extern atomic_bool scr_ni_threads_shared;

/* The hosted loop (SCR_NODE_ISLANDS build of scr_async.c, scope-B NI-3).
 * scr_loop_host moves the runtime's pending ticks, promise jobs, timers
 * and immediates onto Node's queues through `bridge` and schedules every
 * later one there; `since_ms` (scr_now_ms() before Node began loading) is
 * the clock pending timers count their remaining delay from. The rest are
 * the bridge's host callbacks (scr_node_bridge.h). */
struct ScrNodeBridge;
struct ScrNodeIoState;
void scr_loop_host(const struct ScrNodeBridge *bridge, double since_ms);
/* The lowest live frame of Node's stack while a fiber runs (the SCR_NODE_ISLANDS
 * build of scr_async.c records it at each switch from Node's stack to a
 * fiber; 0: none), and the test for Node's stack it uses. */
extern uintptr_t scr_node_stack_low;
extern bool (*scr_node_stack_has)(uintptr_t sp);
/* Around a nested entry: the runtime's scheduling state of the suspended
 * calling fiber, saved and put back (the SCR_NODE_ISLANDS build of
 * scr_async.c). */
void *scr_loop_nested_enter(void);
void scr_loop_nested_leave(void *save);
bool scr_loop_is_hosted(void);
void scr_loop_hosted_run(uint32_t kind, uint32_t token);
void scr_loop_hosted_io_state(struct ScrNodeIoState *state);
void scr_loop_hosted_io(void);
void scr_loop_hosted_microtasks_done(void);

/* Runtime code switches stacks (scr_switch) at `sp`: when that is Node's
 * stack, the frames above stay live until it switches back, so a call
 * into Node.js from the other stack runs below them. */
void scr_node_island_leave_stack(uintptr_t sp);

/* Process events island code listens to (SCR_NODE_EVENT_* of the bridge
 * ABI). Their listeners sit in scr_events.c's registries at their
 * registration position, and a delivery calls them through
 * scr_node_island_emit: a signal with its number, exit with the code.
 *
 * SCR_NODE_ISLAND_EVENT_TURN is not an event and has no listener: the
 * bootstrap answers it by running the rest of Node's current turn (the
 * hosted loop's deciding tick, scr_async.c). */
enum {
  SCR_NODE_ISLAND_EVENT_SIGNAL = SCR_EVENTS_ISLAND_SIGNAL,
  SCR_NODE_ISLAND_EVENT_EXIT = SCR_EVENTS_ISLAND_EXIT,
  SCR_NODE_ISLAND_EVENT_TURN = 3,
};
void scr_node_island_emit(uint32_t event, uint32_t listener, ScrStr *name, int arg);
void scr_signal_on_island(ScrStr *name, uint32_t listener);
void scr_signal_off_island(uint32_t listener);
void scr_process_on_exit_island(uint32_t listener);
void scr_process_off_exit_island(uint32_t listener);

/* ── object handles (scope-B NI-4, scr_node_island_handle.c) ─────────────
 * Island values the program holds are SCR_DYN_HANDLE boxes with tag
 * SCR_DYNH_NODE_ISLAND: one handle per V8 value, so `===` is identity.
 * Primitives, strings and BigInt are copies; island promises are scriptc
 * promises; typed arrays, Buffers, DataViews and ArrayBuffers are ScrBytes
 * over the same memory, one per island object; island symbols are native
 * symbols paired with them.
 * All arguments are borrowed; ScrDyn results are +1, NULL (or false, or
 * -1 for the int forms) with the exception pending. The first call loads
 * Node. See scriptc-perf/results/ni-4/ABI.md. */
ScrDyn *scr_ni_require(ScrStr *path);     /* require(absolute path): the exports */
ScrPromise *scr_ni_import(ScrStr *path);  /* import(absolute path): the namespace */
/* process.report, answered by the island — which is this same process, so
 * the report's sharedObjects lists the binary's real libraries. Compiler
 * builds that have no island keep the process.report refusal instead. */
ScrDyn *scr_ni_process_report(void);
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
/* ── process events (scr_node_island_events.c) ──────────────────────────
 * Once Node is loaded, Node's `process` is the registry of
 * uncaughtException, its monitor, unhandledRejection, rejectionHandled and
 * warning, and process.exitCode is Node's property. */
/* The SCR_NODE_ISLANDS build of scr_async_dyn.c: moves the native
 * listeners onto `process`, in their order, and installs the hooks below. */
void scr_process_events_to_node(void);
/* process.on (0), once (1), prependListener (2), removeListener (3),
 * prependOnceListener (4). */
void scr_ni_process_listen(int mode, const char *event, ScrDyn *listener);
int scr_ni_uncaught(bool from_promise);          /* scr_uncaught_exception_hook */
void scr_ni_promise_unhandled(ScrPromise *p);    /* scr_urj_node_fn */
void scr_ni_promise_handled(ScrPromise *p);      /* scr_rjh_notify_fn */
bool scr_ni_warning(ScrDyn *warning, ScrDyn *code, ScrDyn *detail, bool no_deprecation);
/* The SCR_NODE_ISLANDS build of scr_async.c: when set, a rejected promise
 * nobody observed at a hosted checkpoint is handed to Node's tracking
 * instead of the runtime's report. */
extern SCR_TL void (*scr_urj_node_fn)(ScrPromise *p);
/* A runtime promise whose V8 promise exists: V8 tracks its unhandled
 * rejection. true when native code already reacts to it. */
bool scr_promise_tracked_by_node(ScrPromise *p);
/* process.exitCode in Node: 1 set (*out), 0 unset, -1 Node cannot answer. */
int scr_ni_exit_code(bool set, double code, double *out);
/* The libCalls of process.exitCode in a program with islands. */
void scr_node_island_set_exit_code(double code);
double scr_node_island_exit_code(void);
bool scr_node_island_has_exit_code(void);
/* The libCall of process.chdir in a program with islands: Node's cached
 * process.cwd() follows the program's change. */
void scr_node_island_chdir(ScrStr *dir);
/* A native error is one V8 error while native code holds it. */
void scr_ni_error_link(ScrDyn *value);
ScrDyn *scr_ni_helper(const char *name, ScrDyn *const *args, size_t argc);
bool scr_ni_running(void); /* Node is loaded and not stopped */

/* An island thenable as the promise V8 adopts it into; any other value as
 * itself (the operand of a dynamic await or PromiseResolve). +1. */
ScrDyn *scr_node_island_adopt_thenable(ScrDyn *value);
/* Promise.resolve of a dynamic value: PromiseResolve, thenables adopted. +1. */
ScrPromise *scr_node_island_promise_resolve(ScrDyn *value);
uint32_t scr_ni_live_handles(void); /* live import-table entries (leak tests) */

/* The operations the units every program can link route to the island
 * units: what scr_json.c's dynamic paths do with an island handle (typeof,
 * calls, ToPrimitive, `in`, delete, Object.keys, weak-collection keys and
 * the rest), util.inspect of one (scr_inspect.c), instanceof against one
 * (scr_dyn_builtin_class.c) and the uncaught report of an island error
 * (scr_exception.c).
 * scr_node_island_handle.c installs them from a constructor, so they are
 * set in every program that can hold an island handle and NULL in every
 * other, and each of those units builds one object whether or not a program
 * links the island units. */
typedef struct ScrNiDynOps {
  ScrDyn *(*get)(ScrDyn *obj, ScrDyn *key);
  ScrDyn *(*get_str)(ScrDyn *obj, const char *key, size_t len);
  int (*has)(ScrDyn *obj, ScrDyn *key);
  int (*delete_key)(ScrDyn *obj, ScrDyn *key);
  ScrDyn *(*own_keys)(ScrDyn *obj, int mode);
  /* Array.isArray of the node: the JSON serializer and a checked array
   * conversion take the array shape from it. */
  bool (*is_array)(const ScrDyn *value);
  ScrDyn *(*call)(ScrDyn *fn, ScrDyn *this_, ScrDyn *const *args, size_t argc);
  ScrDyn *(*construct)(ScrDyn *ctor, ScrDyn *const *args, size_t argc);
  ScrStr *(*type_of)(ScrDyn *value);
  bool (*util_type_is)(const ScrDyn *value, const ScrStr *probe);
  int (*instance_of)(ScrDyn *value, ScrDyn *ctor);
  ScrDyn *(*to_primitive)(const ScrDyn *self, int hint);
  bool (*is_function)(const ScrDyn *value);
  /* A property of an error island code threw that its native view does not
   * hold, read from the V8 error (+1 in *out, NULL with the exception
   * pending when the read threw): own properties, its class's methods and
   * accessors, and `constructor`, its own realm's. `view` is any object:
   * 1 for the view of an island error, 0 for any other value. The caller,
   * in a unit every program links, only tests the table and calls; finding
   * the error of a view is done here, where only island programs pay for
   * it. It has the place error_constructor had, which it replaces, so the
   * entries behind it keep their offsets in the units every program links
   * (error_has, below, is at the end for the same reason). */
  int (*error_get)(const ScrDyn *view, const char *key, size_t len, ScrDyn **out);
  /* Object.prototype.toString.call(value), answered by Node (+1; NULL with
   * the exception pending). */
  ScrStr *(*object_tag)(const ScrDyn *value);
  /* The identity root of an island function (borrowed, owned by the
   * function's handle): every typed view of the function adopts it, so the
   * views are one function to `===`, searches and collection keys. NULL for
   * a value that is not a function. */
  struct ScrClosure *(*function_identity)(const ScrDyn *fn);
  /* The island function whose identity root is `root`, as its handle (+1);
   * NULL when `root` is not such a root. A signature adapter over a view of
   * an island function boxes as the function itself through this. */
  ScrDyn *(*function_of_identity)(const struct ScrClosure *root);
  /* util.inspect of an island value (scr_ni_inspect). */
  ScrStr *(*inspect)(const ScrDyn *value, double recurse, double depth);
  /* Node's uncaught-exception report for an error island code threw
   * (scr_ni_report_uncaught): true when it printed one. */
  bool (*report_uncaught)(struct ScrError *error);
  /* Weak collections keyed by island objects (scr_ni_weak_get,
   * scr_ni_weak_test, scr_ni_weak_set): the entries of a native WeakMap,
   * WeakSet or FinalizationRegistry whose key is an island object live in a
   * collection inside the island. */
  ScrDyn *(*weak_get)(ScrDyn *collection, ScrDyn *key);
  int (*weak_test)(ScrDyn *collection, bool set, ScrDyn *key, bool remove);
  bool (*weak_set)(ScrDyn **collection, bool set, ScrDyn *key, ScrDyn *value);
  /* The `in` operator on an error island code threw, for what its native
   * view does not hold (error_get reads the same): 1, 0, or -1 for a value
   * that is not the view of an island error. */
  int (*error_has)(const ScrDyn *view, const char *key, size_t len);
  /* A member of an island promise that a promise does not have itself (an
   * island class that extends Promise adds its own), read from the V8
   * promise (+1 in *out, NULL with the exception pending when the read
   * threw). 1 for the mirror of an island promise, 0 for any other.
   * promise_has is the `in` operator on the same promise: 1, 0, or -1 for
   * a promise that is not an island promise's mirror. */
  int (*promise_get)(const ScrDyn *promise, const char *key, size_t len, ScrDyn **out);
  int (*promise_has)(const ScrDyn *promise, const char *key, size_t len);
  /* A write to a member of an island promise: the island object takes it
   * (a throw stays pending). 1 for the mirror of an island promise, 0 for
   * any other. */
  int (*promise_set)(const ScrDyn *promise, const char *key, size_t len, ScrDyn *value);
  /* obj[key] = value for any property key (a symbol crosses as the symbol
   * paired with it). */
  bool (*set)(ScrDyn *obj, ScrDyn *key, ScrDyn *value);
  /* Object.hasOwn, and propertyIsEnumerable when `enumerable` is set, by
   * Node's intrinsics: the object's own methods of those names may be
   * shadowed or absent and decide nothing.
   *
   * New entries go at the end. The runtime every program links reads the
   * entries above by their offset (scr_dyn_call reads `call`, for one), so
   * an entry added in the middle changes the bytes of programs that have
   * no island at all. */
  int (*has_own)(ScrDyn *obj, ScrDyn *key, int enumerable);
} ScrNiDynOps;
extern const ScrNiDynOps *scr_ni_dyn_ops;

/* scr_ni_is_handle for units that also build into programs without the
 * island units. */
static inline bool scr_ni_dyn_handle(const ScrDyn *value) {
  return value != NULL && value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_NODE_ISLAND;
}

/* Between the two island units. */
struct ScrNodeValue;
const struct ScrNodeBridge *scr_ni_bridge(void);        /* loads Node */
const struct ScrNodeBridge *scr_ni_bridge_loaded(void); /* NULL until loaded */
/* The file a module load names, +1 malloc'd: `./<path>` is a path in the
 * program's module tree, under its root once Node is loaded; anything else
 * (a built-in module) as it is. */
char *scr_ni_module_path(const ScrStr *path);
/* The installed island module tree (scr_node_island.c, "What a start
 * does"): whether an island error's code says Node did not find a file,
 * whether an error's text names the tree, the repair of the files it lacks
 * (once per process), and how many files this process put back. */
bool scr_ni_missing_file_code(const char *code, size_t len);
bool scr_ni_tree_named(const char *text, size_t len);
void scr_ni_tree_repair(void);
size_t scr_ni_tree_repairs(void);
/* The two checks and the repair for one island error, on the island's
 * thread whichever thread read the error (a text is NULL when absent). */
void scr_ni_tree_lost_file(const char *code, size_t code_len, const char *message,
                           size_t message_len, const char *stack, size_t stack_len);
void scr_ni_on_node_stack(void (*job)(void *), void *arg);
void scr_ni_settle_value(uint32_t token, int rejected, const struct ScrNodeValue *value);
void scr_ni_bytes_free(void *owner);
/* One V8 value per byte view, ArrayBuffer storage and symbol (the bridge's
 * `bound`, `bind` and `holds` host callbacks). */
uint32_t scr_ni_host_bound(uint32_t kind, void *owner);
void scr_ni_host_bind(uint32_t kind, void *owner, uint32_t handle, int store);
int scr_ni_host_holds(uint32_t handle);
void scr_ni_called_in(void); /* island code called a native function: its arguments are converted */
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
uint32_t scr_ni_export_id(ScrDyn *v); /* the export id of `v` (borrowed), minted on first crossing */
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
int scr_ni_host_export_symbol(uint32_t id, uint32_t index, struct ScrNodeValue *out);
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
/* ── twins (scr_node_island_export.c) ─────────────────────────────────────
 * A native object of a platform class whose island receivers test its brand
 * crosses as an export whose representative is a real object of the
 * island's own class (scr_node_bridge.h SCR_NVF_TWIN). The other way, an
 * island object of such a class that reaches native code is adopted: a new
 * native object stands for it natively, as an export whose representative
 * is that island object. A class joins by registering from a unit of its
 * own, which links only into programs that have both Node islands and the
 * class's native objects. The native object's reference count is its first
 * word (NI-8 reads it). */
typedef struct ScrNiTwinClass {
  int tag;          /* the native objects' handle tag (SCR_DYNH_*) */
  const char *name; /* the island class: a twin maker of scr_node_island_host.cjs */
  /* The class shares its native object with another twin class (an
   * AbortController and its signal are one object natively): the two are
   * separate exports. At most one class per object says so. */
  bool shares_object;
  /* Export `id` of `object` was made: the object starts telling its twin
   * what changes (scr_ni_twin_tell). The answer, when not NULL, goes to
   * `detach` before the export table lets go of the object, unless the
   * class reported it gone (scr_ni_twin_detached). NULL: nothing to tell. */
  void *(*attach)(uint32_t id, void *object);
  void (*detach)(void *attachment);
  /* A new native object (+1) to stand for an island object of the class
   * that reached native code. NULL: island objects of the class stay
   * handles. */
  ScrDyn *(*adopt)(void);
  /* The island object told its native object that `event` happened, with
   * `value` (borrowed): SCR_NODE_TWIN_TELL. NULL: nothing to hear. */
  void (*hear)(void *object, const char *event, ScrDyn *value);
  struct ScrNiTwinClass *next;
} ScrNiTwinClass;
void scr_ni_twin_register(ScrNiTwinClass *cls);
bool scr_ni_twin_box(const ScrDyn *v); /* a native object of a twin class */
/* The native object of export `id` tells its twin that `event` happened,
 * with `value` (borrowed). */
void scr_ni_twin_tell(uint32_t id, const char *event, ScrDyn *value);
void scr_ni_twin_detached(uint32_t id); /* the attachment freed itself */
/* The native object (+1) that adopts island object `island` (its handle
 * box, import `handle`), or NULL when no class adopts it: it stays a handle. */
ScrDyn *scr_ni_twin_adopt(ScrDyn *island, uint32_t handle);
/* Built-in constructors (SCR_NVF_INTRINSIC, scr_node_island_export.c): the
 * program's function for the constructor `name`, registered at start, and
 * the native value (+1, or NULL) of the island intrinsic behind `handle`. */
void scr_ni_intrinsic_register(ScrStr *name, ScrDyn *value);
ScrDyn *scr_ni_intrinsic_native(ScrDyn *handle);
size_t scr_ni_twin_exports(const void *object, uint32_t ids[2]); /* NI-8 */
/* Promise settlement callback (SCR_NODE_ISLANDS build of scr_async.c). */
void scr_promise_on_settle_sync(ScrPromise *in, void (*cb)(ScrPromise *dst, ScrPromise *src));
/* Mirrors of island promises (scr_async.c): a mirror reacts to its V8
 * promise at the first native reaction to it (the subscriber runs then,
 * once), and a promise settled inside V8's reaction job runs the jobs it
 * queues there (scr_loop_hosted_settle_begin, the settlements, _run). */
extern void (*scr_promise_subscribe_fn)(ScrPromise *mirror);
void scr_promise_mark_island_mirror(ScrPromise *p);
void scr_loop_hosted_settle_begin(void);
void scr_loop_hosted_settle_run(void);
void *scr_promise_untraced_dyn_payload(const ScrPromise *p);

/* ── cross-heap cycle collection (scope-B NI-8, scr_node_island_gc.c) ──── */
const void *scr_ni_export_identity(uint32_t id);
void *scr_ni_gc_ref(const ScrDyn *box, size_t *rc, uint32_t *id);
void *scr_ni_gc_ref_info(void *ref, size_t *rc, uint32_t *id);
size_t scr_ni_gc_pins(void ***objs, void ***refs);
struct ScrNodeGcResult;
int scr_ni_host_gc_analyze(const uint32_t *exports, size_t nexports,
                           struct ScrNodeGcResult *out);
void scr_ni_gc_cleanup(void); /* at exit */
/* Weak collections keyed by island objects (scr_node_island_gc.c): the
 * entries of a native WeakMap, WeakSet or FinalizationRegistry whose key
 * is an island object live in a WeakMap or WeakSet inside the island,
 * `collection` (NULL until the first such entry; `set`: a WeakSet).
 * scr_json.c calls them through ScrNiDynOps. */
ScrDyn *scr_ni_weak_get(ScrDyn *collection, ScrDyn *key); /* +1; undefined: no entry */
int scr_ni_weak_test(ScrDyn *collection, bool set, ScrDyn *key, bool remove); /* 1, 0; -1: threw */
bool scr_ni_weak_set(ScrDyn **collection, bool set, ScrDyn *key, ScrDyn *value);

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
bool scr_ni_boot_snapshot_valid(void *stub); /* its module has not evaluated */
const char *scr_ni_pack_dir(void); /* the libnode pack directory this run uses */
void scr_ni_boot_stub_failed(void *stub); /* raises the module's load error */
/* Called at the end of Node's start (scr_node_island.c), set by the boot unit. */
extern void (*scr_ni_started_hook)(void);

/* ── shared process output streams (scr_node_island_stdio.c) ────────────
 * Called once Node has started, by the SCR_NODE_ISLAND_STDIO build of
 * scr_node_island.c: programs that have islands and hold a process output
 * stream as a value. It makes `write` on the island's process.stdout and
 * process.stderr an accessor over the program's write slots. */
void scr_ni_stdio_started(void);
/* Releases the helper scr_ni_stdio_started took. Called by the same build
 * at process end after both sides' 'exit' listeners ran, while Node can
 * still release it. */
void scr_ni_stdio_stop(void);

/* Island operations the compiler emits (lib-shared.ts adapters). */
ScrDyn *scr_node_island_apply(ScrDyn *fn, ScrDyn *args);
/* fn called with `this` (a method read before its arguments ran). */
ScrDyn *scr_node_island_apply_to(ScrDyn *fn, ScrDyn *this_, ScrDyn *args);
ScrDyn *scr_node_island_construct(ScrDyn *ctor, ScrDyn *args);
void scr_node_island_define_field(ScrDyn *self, ScrStr *key, ScrDyn *value);
ScrDyn *scr_node_island_get(ScrDyn *obj, ScrStr *key);
ScrDyn *scr_node_island_get_key(ScrDyn *obj, ScrDyn *key);
bool scr_node_island_instanceof(ScrDyn *value, ScrDyn *ctor);
bool scr_node_island_instanceof_global(ScrDyn *value, ScrStr *name);
ScrDyn *scr_node_island_invoke(ScrDyn *obj, ScrStr *key, ScrDyn *args);
ScrDyn *scr_node_island_promisify(ScrDyn *fn);
/* clearTimeout / clearInterval / clearImmediate (which 0, 1, 2) of a
 * checked-dynamic value that is not a number: an island timer is cleared in
 * Node, any other value is ignored. */
void scr_node_island_clear_timer(ScrDyn *value, double which);
void scr_node_island_set(ScrDyn *obj, ScrStr *key, ScrDyn *value);
void scr_node_island_set_key(ScrDyn *obj, ScrDyn *key, ScrDyn *value);
ScrDyn *scr_node_island_subclass(ScrDyn *base, ScrStr *name, ScrDyn *ctor, ScrDyn *fields, ScrDyn *methods, ScrDyn *getters, ScrDyn *setters);
ScrDyn *scr_node_island_super_construct(ScrDyn *box, ScrDyn *args);
ScrDyn *scr_node_island_super_method(ScrDyn *base, ScrDyn *self, ScrStr *name, ScrDyn *args);

#endif /* SCR_NODE_ISLAND_H */
