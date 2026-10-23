/* scriptc runtime — the C ABI between the runtime and the libnode bridge
 * (packages/libnode-common/bridge/scr_node_bridge.cc). The runtime never
 * includes a Node or V8 header: it loads the bridge library of a libnode
 * pack with dlopen on first use and talks to it only through this table.
 * The bridge links libnode and pins the Node ABI; the runtime pins only
 * SCR_NODE_BRIDGE_ABI, which changes with any change to these structs.
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

#define SCR_NODE_BRIDGE_ABI 4u
/* The symbol a bridge library exports: `const ScrNodeBridge *(void)`. */
#define SCR_NODE_BRIDGE_ENTRY "scr_node_bridge_v1"

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
} ScrNodeBridgeHost;

typedef struct ScrNodeBridge {
  uint32_t abi;               /* SCR_NODE_BRIDGE_ABI */
  const char *node_version;   /* the libnode it links: "24.22.0" */
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
   * signal number `arg`) or exit (code `arg`). */
  void (*emit)(uint32_t event, uint32_t listener, const char *name, int arg);
  /* Tears Node down at process exit. */
  void (*stop)(void);
} ScrNodeBridge;

#endif /* SCR_NODE_BRIDGE_H */
