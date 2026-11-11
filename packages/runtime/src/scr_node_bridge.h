/* scriptc runtime — the C ABI between the runtime and the libnode bridge
 * (packages/libnode-common/bridge/scr_node_bridge.cc). The runtime never
 * includes a Node or V8 header: it loads the bridge library of a libnode
 * pack with dlopen on first use and talks to it only through this table.
 * The bridge links libnode and pins the Node ABI; the runtime pins only
 * SCR_NODE_BRIDGE_ABI, which changes with any change to these structs and
 * with any change to what an entry does that the runtime relies on.
 *
 * Conventions: strings are UTF-8 and borrowed unless noted. Call outcomes
 * are "R<json>" (returned; "R" alone is undefined) or "T<json>" (threw;
 * the JSON is {"error":{kind,message,code?}}, {"value":...} or
 * {"undefined":true}, see scr_node_island_host.cjs). Every entry point
 * runs on the thread that called start, and every host function is called
 * on it. */
#ifndef SCR_NODE_BRIDGE_H
#define SCR_NODE_BRIDGE_H

#include <stddef.h>
#include <stdint.h>

#define SCR_NODE_BRIDGE_ABI 21u
/* The symbol a bridge library exports: `const ScrNodeBridge *(void)`. */
#define SCR_NODE_BRIDGE_ENTRY "scr_node_bridge_v1"

/* Operations on exports (host->export_op): on Map and Set exports (NI-5b),
 * and on a native error's export. */
enum {
  SCR_NODE_COLLECTION_GET = 0,
  SCR_NODE_COLLECTION_SET = 1, /* Map#set, Set#add */
  SCR_NODE_COLLECTION_HAS = 2,
  SCR_NODE_COLLECTION_DELETE = 3,
  SCR_NODE_COLLECTION_CLEAR = 4,
  SCR_NODE_COLLECTION_SIZE = 5,
  SCR_NODE_COLLECTION_ENTRIES = 6,
  /* A native error's own string-keyed data properties, in order, as
   * SCR_NV_JSON: [name, attributes, name, attributes, ..., state].
   * attributes: 1 writable, 2 enumerable, 4 configurable. state: 1 when the
   * error is not extensible. `stack` is not listed: it is every error's
   * accessor, read and written through export_get and export_set. */
  SCR_NODE_EXPORT_OWN = 7,
};

/* Operations on twin exports (host->export_op, SCR_NVF_TWIN): the island
 * object asks its native object. GET: args[0] names a property, the answer
 * is its value. INVOKE: args[0] names a method, the rest are its arguments,
 * the answer is its result. Both are the native handle's own property read
 * and method call. TELL: the island object changed; args[0] names the
 * event and args[1] is its value (an island signal aborted: "abort" and
 * the reason). */
enum {
  SCR_NODE_TWIN_GET = 16,
  SCR_NODE_TWIN_INVOKE = 17,
  SCR_NODE_TWIN_TELL = 18,
};

/* Kinds of runtime jobs the bridge schedules on Node's queues (`run`). */
enum {
  SCR_NODE_JOB_MICROTASK = 1, /* V8's microtask queue */
  SCR_NODE_JOB_TICK = 2,      /* Node's process.nextTick queue */
  SCR_NODE_JOB_TIMER = 3,     /* a Node timer (setTimeout / setInterval) */
  SCR_NODE_JOB_IMMEDIATE = 4, /* Node's check phase (setImmediate) */
};

/* Process events that island code listens to (`listen`): the listener
 * joins the runtime's own registry at its registration position, so one
 * registry orders the listeners of both sides and libuv never owns a
 * signal. */
enum {
  SCR_NODE_EVENT_SIGNAL = 1,
  SCR_NODE_EVENT_EXIT = 2,
};

/* The runtime's I/O as Node's loop sees it (io_state): the fds to watch
 * for readability, whether runtime work keeps the loop alive, whether
 * runtime work is ready without any fd (the loop must not block), and a
 * bound in milliseconds on the sleep for work no fd announces (-1: none).
 * The bridge sets `phase` (input): when it asks, so that liveness is
 * current wherever Node's loop next decides it. */
enum {
  SCR_NODE_IO_PREPARE = 0, /* before a poll phase */
  SCR_NODE_IO_CHECK = 1,   /* after a check phase: the end of a turn */
  SCR_NODE_IO_JOBS = 2,    /* after a microtask checkpoint (any callback) */
};
#define SCR_NODE_IO_MAX_FDS 16
typedef struct ScrNodeIoState {
  int phase;
  int fds[SCR_NODE_IO_MAX_FDS];
  int nfds;
  int alive;
  int ready;
  int cap_ms;
} ScrNodeIoState;


/* ── object handles (scope-B NI-4) ────────────────────────────────────────
 * A value crossing between the runtime and V8. Primitives, strings and
 * BigInt are copies; objects are handles: ids into the bridge's import
 * table of V8 references, one id per V8 object while the runtime
 * holds it (the bridge answers the same id for the same object), released
 * with `drop`. The table holds v8::TracedReferences that V8 marks only
 * while the runtime may still use them (NI-8, gc_analyze). Typed arrays,
 * Buffers, DataViews and ArrayBuffers cross as their memory (BYTES), which
 * both sides alias, and symbols as symbols: for these each side has an
 * object of its own, and the two are bound one to one (host->bind) for as
 * long as the runtime holds its half, so either crosses as the other.
 *
 * Out-values the bridge writes hold bridge-owned string data valid until
 * the next bridge entry; the runtime copies it at once. In-values are
 * borrowed for the call. */
enum {
  SCR_NV_UNDEFINED = 0,
  SCR_NV_NULL = 1,
  SCR_NV_BOOL = 2,
  SCR_NV_NUMBER = 3,
  SCR_NV_STRING = 4, /* WTF-8: lone surrogates as their 3-byte forms */
  SCR_NV_BIGINT = 5, /* str: decimal text with an optional leading '-' */
  SCR_NV_HANDLE = 6, /* handle: an import-table id; flags: SCR_NVF_* */
  SCR_NV_BYTES = 7,  /* bytes: a typed array / Buffer / DataView over shared memory, or
                        (SCR_NVF_ARRAYBUFFER) the ArrayBuffer itself */
  SCR_NV_ERROR = 8,  /* into V8 only: a native Error, by reference: one V8 Error of its
                        intrinsic class per export id, which is SCR_NV_EXPORT when it crosses
                        back. Its own properties are the export's (SCR_NODE_EXPORT_OWN,
                        export_get, export_set, export_delete) */
  SCR_NV_JSON = 9,   /* into V8 only: str is JSON text, parsed there (a copy) */
  SCR_NV_EXPORT = 10, /* exp: a runtime value exported by reference (NI-5); flags: SCR_NVF_FUNCTION,
                         SCR_NVF_PROMISE, SCR_NVF_ARRAY, SCR_NVF_MAP, SCR_NVF_SET, SCR_NVF_TWIN
                         or 0 for an object */
  SCR_NV_SYMBOL = 11, /* into V8 only: sym, a runtime symbol that has no V8 symbol bound yet */
};
/* What a handle is, reported with every handle the bridge answers. */
enum {
  SCR_NVF_FUNCTION = 1,
  SCR_NVF_SYMBOL = 2, /* the runtime pairs it with a symbol of its own (symbol_info) */
  SCR_NVF_ERROR = 4,
  SCR_NVF_ARRAY = 8,
  SCR_NVF_PROMISE = 16,
  SCR_NVF_CONSTRUCTOR = 32,
  SCR_NVF_BUFFER = 64, /* BYTES: a Buffer; DATAVIEW: a DataView */
  SCR_NVF_DATAVIEW = 128,
  SCR_NVF_MAP = 256, /* EXPORT: a native Map (NI-5b) */
  SCR_NVF_SET = 512, /* EXPORT: a native Set (NI-5b) */
  /* EXPORT: a native object of a platform class whose island receivers
   * brand-check it (an AbortSignal). Its representative is a real object of
   * the island's own class, the twin: made by the bootstrap's makeTwin from
   * the class name in exp.name, or, when exp.length names an import, that
   * island object, which the export adopts (adoptTwin). The runtime keeps
   * the two objects' state in step.
   * HANDLE: an island object of a class the bootstrap lists in
   * twinPrototypes: the runtime may answer it with a native object that
   * adopts it. */
  SCR_NVF_TWIN = 1024,
  SCR_NVF_ARRAYBUFFER = 2048, /* BYTES: the ArrayBuffer itself, not a view of it */
  /* A built-in constructor (String, Number, Boolean, BigInt, Map, Date, ...).
   * EXPORT: the native value of the one `exp.name` names; its representative
   * is the island's own intrinsic of that name, so island code compares it
   * equal to its `String` and the island hands the same object back.
   * HANDLE: the function is one of the island's intrinsic constructors: the
   * runtime answers it with the native value of that name when the program
   * holds one. */
  SCR_NVF_INTRINSIC = 32768,
};
/* A handle with this bit names a "young" view: the V8 view of a runtime
 * view that crossed for the first time since the runtime's last
 * young_flush. Most such views cross once and are dropped (a chunk of a
 * stream), so until the flush the bridge only keeps them alive, in the
 * order it made them (the handle's other bits are the position), and the
 * runtime holds its halves in the same order. The flush gives the views
 * the program still holds real handles and lets the others go. */
#define SCR_NODE_YOUNG 0x80000000u

/* What a runtime object bound to a V8 value is (host->bound, host->bind). */
enum {
  SCR_NODE_BIND_VIEW = 1,   /* a typed array, Buffer or DataView */
  SCR_NODE_BIND_BUFFER = 2, /* the storage an ArrayBuffer stands for */
  SCR_NODE_BIND_SYMBOL = 3,
};
/* Kinds of symbol (SCR_NV_SYMBOL, ScrNodeSymbolInfo): the text is the
 * description (SCR_NODE_SYMBOL_NO_DESCRIPTION: none), the Symbol.for key, or
 * the well-known symbol's property name on Symbol ("iterator"). */
enum {
  SCR_NODE_SYMBOL_UNIQUE = 0,
  SCR_NODE_SYMBOL_NO_DESCRIPTION = 1,
  SCR_NODE_SYMBOL_REGISTERED = 2,
  SCR_NODE_SYMBOL_WELL_KNOWN = 3,
};
/* BYTES element kinds: ScrBytesElem's numbering (scr_bytes.h). */
typedef struct ScrNodeValue {
  uint32_t tag;
  uint32_t flags;
  union {
    int boolean;
    double num;
    struct {
      const char *data;
      size_t len;
    } str;
    uint32_t handle;
    /* One ArrayBuffer per storage and one view object per view, on both
     * sides. A value names the view by `handle` once the two are bound;
     * the first crossing carries what the other side needs to make its
     * half: out of V8 the ArrayBuffer's handle and extent, into V8 the
     * runtime's objects, which the bridge binds (host->bind) to the V8
     * values it makes. With SCR_NVF_ARRAYBUFFER the value is the buffer:
     * `buffer`, `data` and `buffer_len` describe it and the view fields
     * are unused. */
    struct {
      uint8_t *data; /* the view's first byte */
      size_t len;    /* elements */
      uint32_t elem; /* ScrBytesElem */
      uint32_t handle; /* the view's handle; 0 into V8: none is bound yet */
      void *owner;   /* into V8, handle 0: the runtime's view object */
      uint32_t buffer; /* the ArrayBuffer's handle; 0: out of V8 the runtime already
                          holds the view, into V8 none is bound yet */
      size_t offset;     /* the view's byteOffset in its ArrayBuffer */
      size_t buffer_len; /* the ArrayBuffer's byteLength */
      void *root;    /* into V8, buffer 0: the runtime's storage owner */
    } bytes;
    struct {
      uint32_t kind;    /* SCR_NODE_SYMBOL_* */
      const char *text; /* WTF-8 */
      size_t len;
      void *owner;      /* the runtime's symbol (host->bind) */
    } sym;
    struct {
      uint32_t kind; /* scr_error.h SCR_ERR_* (intrinsic class) */
      uint32_t export_id; /* the runtime's export-table id of the error */
      uint32_t class_instance; /* an instance of a program class: the export also
                                  answers its class's members */
    } error;
    struct {
      uint32_t id;     /* the runtime's export-table id */
      uint32_t length; /* functions: their `length`; twins: the import the export adopts (0: none) */
      const char *name; /* functions: their `name` (NULL: anonymous); twins: their class */
      size_t name_len;
    } exp;
  } u;
} ScrNodeValue;

/* An island error's own properties, read by `error_info` (bridge-owned
 * strings, valid until the next entry; code NULL when it has no string
 * code). kind is the nearest intrinsic class (SCR_ERR_*). */
typedef struct ScrNodeErrorInfo {
  uint32_t kind;
  const char *name, *message, *stack, *code;
  size_t name_len, message_len, stack_len, code_len;
  /* Node's arrow header for the throw site ("<file>:<line>\n<source
   * line>\n<caret>"), recorded when the error was thrown out of island
   * code; NULL when none. */
  const char *arrow;
  size_t arrow_len;
} ScrNodeErrorInfo;

/* What an island symbol is, read by `symbol_info` (bridge-owned text,
 * valid until the next entry). */
typedef struct ScrNodeSymbolInfo {
  uint32_t kind; /* SCR_NODE_SYMBOL_* */
  const char *text;
  size_t len;
} ScrNodeSymbolInfo;

/* ── cross-heap cycle collection (scope-B NI-8) ────────────────────────────
 * Before V8's major GC marks, the runtime answers which exports its own
 * roots still hold and, for each other export, what its native subgraph
 * reaches across the boundary (gc_analyze). V8 then marks from its roots,
 * the exports native roots hold and the imports they hold, and through each
 * representative it marks into what that export reaches. Exports V8 did not
 * reach lose their representative (export_release), imports it did not
 * reach are collected, and the runtime's cycle collector frees the native
 * half. Reach entries are import ids, or export ids with SCR_NODE_GC_EXPORT
 * set. All arrays are runtime-owned until the next host call. */
#define SCR_NODE_GC_EXPORT 0x80000000u
typedef struct ScrNodeGcResult {
  const uint32_t *free_imports; /* import ids no native root holds */
  size_t nfree_imports;
  const uint8_t *rooted;        /* per analyzed export: native roots hold it */
  const uint32_t *reach_start;  /* per analyzed export: its first entry in `reach` */
  const uint32_t *reach_len;
  const uint32_t *reach;
  size_t visited;               /* native objects the analysis walked */
} ScrNodeGcResult;
/* What the bridge counted, for the trace and the leak tests. */
typedef struct ScrNodeGcStats {
  uint64_t major_gcs;      /* V8 major GCs since Node started */
  uint64_t analyses;       /* of which the runtime analyzed (the others traced everything) */
  uint64_t freed_exports;  /* representatives V8 collected */
  uint64_t freed_imports;  /* imports V8 collected */
  uint64_t analysis_ns;    /* time spent in gc_analyze, in total */
  uint64_t max_analysis_ns;
  uint32_t live_exports;   /* representatives alive now */
  uint32_t live_imports;   /* import-table entries alive now */
} ScrNodeGcStats;

/* What the runtime provides to the bridge. */
typedef struct ScrNodeBridgeHost {
  /* An asynchronous call settled with this outcome. */
  void (*settle)(uint32_t id, const char *outcome, size_t len);
  /* Node ends the process (process.exit, an uncaught exception): the
   * runtime runs its exit sequence with this code and never returns. */
  void (*exit)(int code);
  /* A runtime job came due on Node's queues (a SCR_NODE_JOB_* kind and the
   * token the runtime passed when it scheduled it). Runs on the stack of
   * Node's own dispatch, so Node drains ticks and microtasks after it
   * exactly as after any of its callbacks. */
  void (*run)(uint32_t kind, uint32_t token);
  /* The runtime's I/O hooks: its state before each poll phase and after
   * each check phase, and one dispatch pass (when a watched fd is readable
   * or `ready` was set). */
  void (*io_state)(ScrNodeIoState *state);
  void (*io_dispatch)(void);
  /* V8 finished a microtask checkpoint: the runtime reports the unhandled
   * rejections of its own promises, as Node does at the same point. */
  void (*microtasks_done)(void);
  /* Island code added (add=1, once=1 for once listeners) or removed
   * (add=0) a listener for a process event (SCR_NODE_EVENT_*, `name` its
   * event name). `listener` identifies it in later `emit` calls. */
  void (*listen)(uint32_t event, const char *name, uint32_t listener, int add, int once);
  /* The lowest stack address JavaScript may use on the stack the runtime
   * is calling in from (its main thread's or an async fiber's), for V8's
   * stack limit; 0 leaves V8's own. */
  uintptr_t (*stack_limit)(void);
  /* The start (highest address) of the stack the caller runs on when the
   * runtime provides it (Node's own stack), 0 for a thread's own stack.
   * V8 scans the stack conservatively from the current position up to the
   * start it records for the thread, so it must not record the thread's
   * when JavaScript runs on the runtime's stack. */
  uintptr_t (*stack_start)(void);
  /* NI-4: a thenable the runtime awaits (`then`) settled; `value` is the
   * fulfillment or (rejected=1) the reason. Runs as a V8 reaction job. */
  void (*settle_value)(uint32_t token, int rejected, const ScrNodeValue *value);
  /* NI-4: V8 freed a backing store over runtime bytes (the `root` the
   * bridge bound with store=1). May run on any thread: the runtime queues
   * the release for its own thread. */
  void (*bytes_free)(void *owner);
  /* Native values in Node (NI-5): the V8 representative of export `id`
   * was called, constructed, or had a property read, written, tested,
   * deleted or enumerated. 0: returned (*out), 1: threw (*out is the thrown
   * value), 2: absent (get/set/delete: the ordinary object answers). Out
   * strings are runtime-owned until the next host call. Keys are strings
   * or array indices (numbers). export_keys answers SCR_NV_JSON: the own
   * enumerable string keys. */
  int (*export_call)(uint32_t id, const ScrNodeValue *this_, const ScrNodeValue *args,
                     size_t argc, ScrNodeValue *out);
  int (*export_construct)(uint32_t id, const ScrNodeValue *args, size_t argc, ScrNodeValue *out);
  int (*export_get)(uint32_t id, const ScrNodeValue *key, ScrNodeValue *out);
  int (*export_set)(uint32_t id, const ScrNodeValue *key, const ScrNodeValue *value,
                    ScrNodeValue *out);
  int (*export_has)(uint32_t id, const ScrNodeValue *key);
  int (*export_delete)(uint32_t id, const ScrNodeValue *key, ScrNodeValue *out);
  int (*export_keys)(uint32_t id, ScrNodeValue *out);
  /* The V8 promise representing native promise `id` exists: settle it
   * (bridge->export_settle) when the native promise settles. */
  void (*export_watch)(uint32_t id);
  /* V8 collected the representative of `id`. */
  void (*export_release)(uint32_t id);
  /* `value instanceof <export id>` for a native class representative
   * (its Symbol.hasInstance): 1 or 0. */
  int (*export_instance_of)(uint32_t id, const ScrNodeValue *value);
  /* ── shared modules (NI-6): modules the program compiled that island
   * code imports resolve, through the loader hooks of the bootstrap, to
   * generated modules over the live native exports. ── */
  /* The table, as SCR_NV_STRING JSON: [{"path","exports":[{"name","kind"}]}]
   * (index = module id, export index = slot). */
  void (*shared_table)(ScrNodeValue *out);
  /* The current value of a shared export. mode 0: read; 1: read and bind
   * (the generated module holds it: later native changes are pushed with
   * bridge->shared_push); 2: bind late (the binding is in its temporal
   * dead zone: it is pushed once the native declaration ran). 0: *out is
   * the value; 1: threw (*out thrown); 3: in its temporal dead zone. */
  int (*shared_get)(uint32_t mod, uint32_t slot, int mode, ScrNodeValue *out);
  /* The exports in their temporal dead zone now, as SCR_NV_STRING JSON
   * [[mod, slot], ...]. */
  void (*shared_tdz)(ScrNodeValue *out);
  /* An export's operation: a Map's or Set's (SCR_NODE_COLLECTION_*), a twin
   * export's (SCR_NODE_TWIN_*), or a native error's own properties
   * (SCR_NODE_EXPORT_OWN). 0 returned (*out), 1 threw. ENTRIES answers an
   * array export: [key, value] pairs of a Map, the values of a Set. */
  int (*export_op)(uint32_t id, uint32_t op, const ScrNodeValue *args, size_t argc,
                   ScrNodeValue *out);
  /* NI-8: the analysis before a major GC, over the `nexports` exports that
   * have a representative. 0: *out holds the answer; 1: the runtime cannot
   * answer now (V8 then treats every handle as a root for this GC). Runs
   * inside V8's GC prologue: it must not call into the bridge. */
  int (*gc_analyze)(const uint32_t *exports, size_t nexports, ScrNodeGcResult *out);
  /* One V8 value per runtime view, storage and symbol (SCR_NODE_BIND_*).
   * `bound` answers the handle bound to `owner`, or 0. `bind`: the bridge
   * made the V8 value for `owner` and names it `handle` (a view: a young
   * handle, see SCR_NODE_YOUNG); the runtime holds that handle for as long
   * as it holds `owner`, so the same value crosses next time. store=1: a
   * V8 backing store over the runtime's memory now holds `owner`, until
   * bytes_free(owner). It comes with the storage's ArrayBuffer, or with
   * the view of a typed array that is its own storage: then the
   * ArrayBuffer has no handle of its own, and the runtime knows it by the
   * view while that is young and by the store's memory afterwards.
   * Neither may call into the bridge. */
  uint32_t (*bound)(uint32_t kind, void *owner);
  void (*bind)(uint32_t kind, void *owner, uint32_t handle, int store);
  /* Whether the runtime holds its own object for the V8 value `handle` (a
   * view or a symbol): such a view crosses out of V8 as its handle alone,
   * and such a symbol is a key the runtime's objects answer. */
  int (*holds)(uint32_t handle);
  /* The index-th own symbol key of export `id` (0, *out), or 2 when it has
   * no such key: what its representative lists beside its own. */
  int (*export_symbol)(uint32_t id, uint32_t index, ScrNodeValue *out);
} ScrNodeBridgeHost;

typedef struct ScrNodeBridge {
  uint32_t abi;               /* SCR_NODE_BRIDGE_ABI */
  const char *node_version;   /* the libnode it links: "24.22.1" */
  uint32_t module_version;    /* its NODE_MODULE_VERSION */
  /* Initializes Node once per process and runs `bootstrap` as the main
   * script of one environment. argv[0] names the executable. Every entry
   * runs on one stack the runtime provides; `stack_limit` is the lowest
   * address JavaScript may use on it (V8's stack limit), 0 for V8's
   * default. Returns NULL, or a message the runtime frees with `release`. */
  char *(*start)(const ScrNodeBridgeHost *host, const char *bootstrap, const char *argv0,
                 uintptr_t stack_limit);
  /* Calls the bootstrap's dispatcher in a callback scope (ticks and
   * microtasks drain when it closes, as after any libuv callback). A
   * synchronous call answers its outcome (+1, freed with `release`, length
   * in *len); an asynchronous one answers NULL and settles through the
   * host, possibly before it returns. */
  char *(*call)(uint32_t id, int sync, const char *file, const char *specifier,
                const char *name, const char *args, size_t args_len, size_t *len);
  void (*release)(void *memory);
  /* The hosted loop (scope-B NI-3). Once Node is loaded, the runtime's
   * queues live on Node's: `host_loop` starts the integration (the I/O
   * handles that watch the runtime's fds, the microtask-checkpoint hook)
   * and holds a callback scope open until the next `checkpoint`, so work
   * already pending in the runtime and work the current runtime callback
   * goes on to queue drain together, at the end of that callback. */
  void (*host_loop)(void);
  /* Schedules runtime jobs (SCR_NODE_JOB_*). Timers take Node's delay
   * coercion; `repeat` > 0 re-arms after each run (setInterval), and
   * `delay` may differ from `repeat` for intervals migrated mid-period.
   * Handles are nonzero and name the Node Timeout or Immediate until the
   * runtime clears them; a cleared or fired handle is never reused. */
  void (*microtask)(uint32_t token);
  void (*tick)(uint32_t token);
  uint32_t (*timer)(double delay, double repeat, int ref, uint32_t token);
  void (*timer_clear)(uint32_t handle);
  void (*timer_ref)(uint32_t handle, int ref);
  void (*timer_refresh)(uint32_t handle);
  uint32_t (*immediate)(int ref, uint32_t token);
  void (*immediate_clear)(uint32_t handle);
  void (*immediate_ref)(uint32_t handle, int ref);
  /* The checkpoint after a macrotask: closes the scope `host_loop` held
   * (or opens and closes one), which runs Node's tick queue and V8's
   * microtasks to exhaustion. `microtasks_first` runs the microtasks once
   * before the ticks: the end of an ES module main body. */
  void (*checkpoint)(int microtasks_first);
  /* Runs Node's event loop until nothing keeps it alive (beforeExit
   * included). Returns when the program ends normally, with the exit code
   * island code assigned to process.exitCode (0: none). `continue_turn`:
   * the switch interrupted a timers or poll phase, so the first iteration
   * starts at the poll phase instead of the timers phase. */
  int (*run_loop)(int continue_turn);
  /* Calls island listener `listener` of a process event: a signal (`name`,
   * signal number `arg`) or exit (code `arg`). A signal listener runs in a
   * callback scope (ticks and microtasks drain after it); an exit listener
   * is a plain call, after which nothing drains. Exit with listener 0 calls
   * no listener: it tells island code that the exit sequence began
   * (process._exiting). */
  void (*emit)(uint32_t event, uint32_t listener, const char *name, int arg);
  /* Tears Node down at process exit. No JavaScript runs from here on: the
   * timers and immediates still due are dropped. */
  void (*stop)(void);
  /* ── object handles (NI-4). Each operation answers 0 (returned: *out is
   * the result) or 1 (threw: *out is the thrown value). ── */
  /* Loads a module by absolute path: require(path) (esm=0, the exports),
   * or import(path) (esm=1, a promise of the namespace). */
  int (*load)(const char *path, int esm, ScrNodeValue *out);
  /* Property access on handle h; key goes through ToPropertyKey. */
  int (*get)(uint32_t h, const ScrNodeValue *key, ScrNodeValue *out);
  int (*set)(uint32_t h, const ScrNodeValue *key, const ScrNodeValue *value, ScrNodeValue *out);
  int (*has)(uint32_t h, const ScrNodeValue *key, ScrNodeValue *out);  /* out: BOOL */
  int (*del)(uint32_t h, const ScrNodeValue *key, ScrNodeValue *out);  /* out: BOOL */
  /* fn(...args) with receiver this_ (NULL: undefined). */
  int (*invoke)(uint32_t fn, const ScrNodeValue *this_, const ScrNodeValue *args, size_t argc,
                ScrNodeValue *out);
  /* h[key](...args) with h as the receiver. */
  int (*invoke_method)(uint32_t h, const ScrNodeValue *key, const ScrNodeValue *args, size_t argc,
                       ScrNodeValue *out);
  int (*construct)(uint32_t h, const ScrNodeValue *args, size_t argc, ScrNodeValue *out);
  int (*instance_of)(const ScrNodeValue *value, uint32_t ctor, ScrNodeValue *out); /* BOOL */
  /* Own keys of h: mode 0 Object.keys, mode 1 Reflect.ownKeys. out: a
   * handle to a fresh array, which the runtime reads and drops. */
  int (*own_keys)(uint32_t h, int mode, ScrNodeValue *out);
  /* Promise.resolve(value).then(...): settles through host->settle_value
   * with `token`. Answers 1 with *out thrown if `then` could not attach. */
  int (*then)(const ScrNodeValue *value, uint32_t token, ScrNodeValue *out);
  /* The own name, message, stack and string code of an error handle. */
  void (*error_info)(uint32_t h, ScrNodeErrorInfo *out);
  /* Releases handle h. */
  void (*drop)(uint32_t h);
  /* The number of live import-table entries (leak tests). */
  uint32_t (*live_handles)(void);
  /* Settles the V8 promise representing native promise `id` (NI-5). */
  void (*export_settle)(uint32_t id, int rejected, const ScrNodeValue *value);
  /* NI-6: the native value of shared export (mod, slot) changed: the
   * generated module's binding takes `value`. */
  void (*shared_push)(uint32_t mod, uint32_t slot, const ScrNodeValue *value);
  /* NI-8: the cross-heap collector's counters. */
  void (*gc_stats)(ScrNodeGcStats *out);
  /* What symbol handle h is: its kind and description, registry key or
   * well-known name. */
  void (*symbol_info)(uint32_t h, ScrNodeSymbolInfo *out);
  /* Ends the young views: view i gets a real handle (ids[i]) when keep[i]
   * is set, and is the bridge's to forget otherwise. `n` is the number of
   * young views the runtime was told of. */
  void (*young_flush)(const uint8_t *keep, size_t n, uint32_t *ids);
} ScrNodeBridge;

#endif /* SCR_NODE_BRIDGE_H */
