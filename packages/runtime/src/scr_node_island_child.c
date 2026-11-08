/* Node islands: a child process an island made, in a native ChildProcess
 * slot. Linked only into programs with both Node islands and child_process
 * (the `islandChild` link feature), with the SCR_NODE_ISLANDS build of
 * scr_child.c.
 *
 * A ChildProcess slot holds a ScrChild that compiled code calls scr_child_*
 * on, so an island's ChildProcess cannot sit in it as it is. It is adopted
 * where it enters the slot, the checked conversion (scr_ni_child_unbox): the
 * slot gets a ScrChild that has no state of its own and names the island's
 * object. Every entry point that takes it hands it to the table at the end
 * of this unit (scr_child.h, ScrChildIslandOps), which calls the island
 * object's own member:
 *
 *  - a listener is registered on the island's emitter, as a function of
 *    this unit that calls the program's listener through the adapter the
 *    entry point was given. So the order of 'spawn', 'data', 'exit',
 *    'close' and 'error', also relative to listeners the island's own code
 *    registered, is whatever Node's ChildProcess emits, and `once` and
 *    removal are the emitter's;
 *  - a property is read from the island's object at that moment, so
 *    nothing is copied that could go stale;
 *  - a method is the island's method.
 *
 * Converting the handle back to a dynamic value answers the island's
 * object (scr_ni_child_box), so untyped code and code in the island use the
 * object itself.
 *
 * Identity: one ScrChild per island object while the program holds it (the
 * table below, keyed by the import). Lifetime: the ScrChild holds the
 * island's object. While the process runs or a listener is attached the
 * island's own emitter holds the listener functions, so events arrive
 * whether or not the program still holds the ScrChild.
 *
 * Cycles: a listener that captures its own typed child is island child ->
 * listener function -> the program's closure -> ScrChild -> island child. A
 * ScrChild has no trace header (scr_child.c: "children allocate lean"), so
 * the cross-heap collector cannot see that edge. Native children break the
 * same cycle by releasing their listeners at the terminal event; here the
 * island child's 'close' does it: one function per island child (the hook)
 * listens for it, and the program's closures behind every listener
 * registered through a ScrChild of that island child, or through its stdio
 * handles, are released when it has been delivered. The listener functions
 * themselves stay on the island's emitter, as Node keeps them. */
#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE 1
/* This unit is linked only into a program with islands and always reads the
 * ScrChild layout of scr_child.c's SCR_NODE_ISLANDS build: it has no block
 * that depends on the define. */
#undef SCR_NODE_ISLANDS
#define SCR_NODE_ISLANDS 1
#include "scr_runtime.h"
#include "scr_child_private.h"
#include "scr_node_island.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if !defined(_WIN32) && !defined(__wasi__)

SCR_COLD static void nc_oom(void) { scr_trap("scriptc: out of memory\n"); }

/* ── the island's side ────────────────────────────────────────────────
 * What needs the island's own globals, evaluated in the island when the
 * first island object reaches a ChildProcess slot (nothing at start-up).
 * `hooks` maps an island child to its hook function, so every ScrChild
 * that is ever made for it finds the same one. */
static const char NC_ISLAND_SOURCE[] =
    "(function () {\n"
    "  const { ChildProcess } = process.getBuiltinModule('node:child_process');\n"
    "  const hooks = new WeakMap();\n"
    "  return {\n"
    "    isChild(value) { return value instanceof ChildProcess; },\n"
    "    hook(child) { return hooks.get(child); },\n"
    /* True: the child's 'close' was already emitted, so the hook will not run. */
    "    setHook(child, hook) {\n"
    "      hooks.set(child, hook);\n"
    "      if (child._closesNeeded !== undefined && child._closesGot >= child._closesNeeded) return true;\n"
    "      child.once('close', hook);\n"
    "      return false;\n"
    "    },\n"
    /* True: this call removed a registration of `listener`. */
    "    off(emitter, event, listener) {\n"
    "      const before = emitter.listenerCount(event);\n"
    "      emitter.removeListener(event, listener);\n"
    "      return emitter.listenerCount(event) < before;\n"
    "    },\n"
    "    channel(child) { return typeof child.send === 'function'; },\n"
    "    send(child, json, callback) {\n"
    "      const message = JSON.parse(json);\n"
    "      return callback === undefined ? child.send(message) : child.send(message, callback);\n"
    "    },\n"
    /* The channel is JSON in the native runtime: a message arrives as its text. */
    "    onMessage(child, listener, once) {\n"
    "      const forward = (message) => listener(JSON.stringify(message));\n"
    "      if (once) child.once('message', forward); else child.on('message', forward);\n"
    "    },\n"
    "    spawnargs(child) { return JSON.stringify(child.spawnargs); },\n"
    "  };\n"
    "})()";

static SCR_TL ScrDyn *nc_island = NULL; /* the object the source above answers */

static void nc_cleanup(void) {
  scr_dyn_release(nc_island);
  nc_island = NULL;
}

static bool nc_island_load(void) {
  if (nc_island != NULL) return true;
  ScrStr *specifier = scr_str_new("node:vm", 7);
  ScrDyn *vm = scr_ni_require(specifier);
  scr_str_release(specifier);
  if (vm == NULL) return false;
  ScrStr *text = scr_str_new(NC_ISLAND_SOURCE, sizeof NC_ISLAND_SOURCE - 1);
  ScrDyn *source = scr_dyn_new_str(text);
  scr_str_release(text);
  nc_island = scr_ni_call_method(vm, "runInThisContext", 16, &source, 1);
  scr_dyn_release(source);
  scr_dyn_release(vm);
  if (nc_island == NULL) return false;
  scr_atexit(nc_cleanup);
  return true;
}

/* A function of the island's side (+1, or NULL with the exception pending). */
static ScrDyn *nc_island_call(const char *name, ScrDyn *const *args, size_t argc) {
  if (!nc_island_load()) return NULL;
  return scr_ni_call_method(nc_island, name, strlen(name), args, argc);
}

static bool nc_true(ScrDyn *answer) {
  bool yes = answer != NULL && answer->kind == SCR_DYN_BOOL && answer->v.b;
  scr_dyn_release(answer);
  return yes;
}

/* ── listeners ────────────────────────────────────────────────────────
 * The function this unit registers on an island emitter is a closure with
 * two captures: its NcListener (what to call, and how) and the program's
 * closure. The second is an ordinary function capture, so the collectors
 * trace what the program's closure holds. */
enum {
  NC_HOOK = 64,    /* the island child's 'close' was delivered */
  NC_DYN,          /* an untyped listener: called with the arguments as they are */
  NC_SEND,         /* send()'s callback */
  NC_BRIDGE_WRITE, /* a general stream's write into the island's stdin completed */
  NC_BRIDGE_FINAL, /* its end completed */
};

typedef struct NcGroup {
  size_t rc;
  struct NcListener *first; /* newest first; each belongs to its function */
  bool closed;              /* the island child's 'close' was delivered */
} NcGroup;

typedef struct NcListener {
  size_t rc;
  NcGroup *group; /* +1; NULL for a callback that is no listener of the child */
  struct NcListener *prev, *next;
  ScrClosure *wrapper; /* the function this belongs to (not owned) */
  void *fn;            /* the entry point's adapter, NULL when the listener takes nothing */
  ScrDyn *dyn;         /* NC_DYN: the untyped listener (+1 until released) */
  ScrStream *stream;   /* NC_BRIDGE_*: the stream to complete (+1 through stream_ops) */
  const ScrChildStreamOps *stream_ops;
  uint8_t event; /* SCR_CHILD_EV_* or NC_* */
  bool removed;  /* off() took it from the emitter: no later off() finds it */
  bool on_close; /* NC_DYN: registered for 'close', so it runs in the emit that closes the group */
} NcListener;

static NcGroup *nc_group_retain(NcGroup *g) {
  g->rc++;
  return g;
}

static void nc_group_release(NcGroup *g) {
  if (g != NULL && --g->rc == 0) free(g);
}

static void *nc_listener_retain(void *p) {
  ((NcListener *)p)->rc++;
  return p;
}

static void nc_listener_release(void *p) {
  NcListener *l = p;
  if (l == NULL || --l->rc != 0) return;
  if (l->group != NULL) {
    if (l->prev != NULL) l->prev->next = l->next;
    else l->group->first = l->next;
    if (l->next != NULL) l->next->prev = l->prev;
    nc_group_release(l->group);
  }
  scr_dyn_release(l->dyn);
  if (l->stream != NULL) l->stream_ops->release(l->stream);
  free(l);
}

static NcListener *nc_listener_of(ScrClosure *wrapper) { /* +1 */
  return scr_box_get_ref(wrapper->caps[0]);
}

/* The program's closure behind a function (+1), NULL once it was released
 * or when the function never had one. */
static ScrClosure *nc_closure_of(ScrClosure *wrapper) {
  return wrapper->caps[1]->slot != 0 ? scr_box_get_ref(wrapper->caps[1]) : NULL;
}

static ScrDyn *nc_listener_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc);

/* The function for one registration (+1). Moves cb (may be NULL). */
static ScrDyn *nc_listener_new(NcGroup *group, int event, ScrClosure *cb, void *fn, NcListener **out) {
  NcListener *l = calloc(1, sizeof *l);
  if (l == NULL) nc_oom();
  l->rc = 1;
  l->event = (uint8_t)event;
  l->fn = fn;
  if (group != NULL) {
    l->group = nc_group_retain(group);
    l->next = group->first;
    if (group->first != NULL) group->first->prev = l;
    group->first = l;
  }
  ScrClosure *wrapper = scr_closure_new((void *)nc_listener_thunk, 2);
  wrapper->caps[0] = scr_box_new_obj(nc_listener_retain, nc_listener_release, NULL);
  scr_box_set_ref(wrapper->caps[0], l);
  wrapper->caps[1] = scr_box_new(SCR_BOX_FUNC);
  if (cb != NULL) scr_box_set_ref(wrapper->caps[1], cb);
  l->wrapper = wrapper;
  if (out != NULL) *out = l;
  return scr_dyn_new_func(wrapper, nc_listener_thunk, 0, "(...args)", "");
}

/* The same function again as a value (+1): one closure, so one function in
 * the island. */
static ScrDyn *nc_listener_value(NcListener *l) {
  return scr_dyn_new_func(scr_closure_retain(l->wrapper), nc_listener_thunk, 0, "(...args)", "");
}

/* The 'close' of an island child: the program's closures behind every
 * listener of its group are released, except those of 'close' itself, typed
 * or untyped, which are still to run in this emit and release themselves
 * when they have. */
static void nc_group_close(NcGroup *group) {
  group->closed = true;
  size_t n = 0;
  for (NcListener *l = group->first; l != NULL; l = l->next) n++;
  if (n == 0) return;
  /* Nothing is released while the list is walked: a release can free a
   * handle, which enters the island, which can free a listener. */
  ScrClosure **closures = calloc(n, sizeof *closures);
  ScrDyn **dyns = calloc(n, sizeof *dyns);
  if (closures == NULL || dyns == NULL) nc_oom();
  size_t i = 0;
  for (NcListener *l = group->first; l != NULL; l = l->next, i++) {
    if (l->event == SCR_CHILD_EV_CLOSE || l->event == NC_HOOK || l->on_close) continue;
    closures[i] = nc_closure_of(l->wrapper);
    if (closures[i] != NULL) scr_box_set_ref(l->wrapper->caps[1], NULL);
    dyns[i] = l->dyn;
    l->dyn = NULL;
  }
  for (i = 0; i < n; i++) {
    scr_closure_release(closures[i]);
    scr_dyn_release(dyns[i]);
  }
  free(closures);
  free(dyns);
}

/* A value the island delivered that the listener's type cannot take: a
 * TypeError where the listener would have run. */
SCR_COLD static void nc_refuse(const char *what) {
  char text[240];
  int len = snprintf(text, sizeof text, "scriptc: %s (a child process made in a Node island)", what);
  scr_throw_error_msg(SCR_ERR_TYPE, text, (size_t)len);
}

/* The signal name an 'exit' or 'close' carries, as the static spelling the
 * adapters take; a name outside the runtime's table is kept for the
 * process. */
static const char *nc_signal_name(const ScrStr *name) {
  int number = scr_signal_from_name(name);
  const char *known = number >= 0 ? scr_signal_name(number) : NULL;
  if (known != NULL && strlen(known) == name->len && memcmp(known, name->data, name->len) == 0)
    return known;
  static SCR_TL char **kept = NULL;
  static SCR_TL size_t nkept = 0;
  for (size_t i = 0; i < nkept; i++)
    if (strlen(kept[i]) == name->len && memcmp(kept[i], name->data, name->len) == 0) return kept[i];
  char **grown = realloc(kept, (nkept + 1) * sizeof *grown);
  char *copy = malloc(name->len + 1);
  if (grown == NULL || copy == NULL) nc_oom();
  memcpy(copy, name->data, name->len);
  copy[name->len] = '\0';
  kept = grown;
  kept[nkept++] = copy;
  return copy;
}

/* The Error an island handed over (+1), or NULL with a TypeError pending
 * when the value is not one. */
static ScrError *nc_error_of(ScrDyn *value, const char *what) {
  if (value != NULL && value->kind == SCR_DYN_OBJ) return scr_error_from_dyn(value);
  nc_refuse(what);
  return NULL;
}

static ScrDyn *nc_listener_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  NcListener *l = nc_listener_of(clo);
  ScrClosure *cb = nc_closure_of(clo);
  ScrDyn *a0 = argc > 0 ? args[0] : scr_dyn_undefined();
  switch (l->event) {
  case NC_HOOK:
    nc_group_close(l->group);
    break;
  case NC_DYN:
    if (l->dyn != NULL) {
      ScrDyn *listener = scr_dyn_retain(l->dyn);
      scr_dyn_release(scr_dyn_call(listener, args, argc, "child listener"));
      scr_dyn_release(listener);
      /* An untyped 'close' listener ran in the emit that closed the group. */
      if (l->on_close && l->group != NULL && l->group->closed && l->dyn != NULL) {
        ScrDyn *held = l->dyn;
        l->dyn = NULL;
        scr_dyn_release(held);
      }
    }
    break;
  case NC_BRIDGE_WRITE:
  case NC_BRIDGE_FINAL: {
    ScrStream *stream = l->stream;
    if (stream == NULL) break; /* completed already */
    l->stream = NULL;
    ScrError *error =
        a0->kind == SCR_DYN_OBJ ? scr_error_from_dyn(a0) : NULL; /* null or undefined: done */
    if (l->event == NC_BRIDGE_WRITE) l->stream_ops->write_done(stream, error);
    else l->stream_ops->final_done(stream, error);
    l->stream_ops->release(stream);
    break;
  }
  case NC_SEND:
    if (cb != NULL) {
      ScrError *error = a0->kind == SCR_DYN_OBJ ? scr_error_from_dyn(a0) : NULL;
      ((ScrIpcSendFn)l->fn)(cb, error);
      scr_box_set_ref(clo->caps[1], NULL); /* called once */
    }
    break;
  default:
    if (cb == NULL) break; /* released when the child closed */
    switch (l->event) {
    case SCR_CHILD_EV_EXIT:
    case SCR_CHILD_EV_CLOSE: {
      ScrDyn *signal = argc > 1 ? args[1] : scr_dyn_undefined();
      ((ScrChildExitFn)l->fn)(cb, a0->kind == SCR_DYN_NUM, a0->kind == SCR_DYN_NUM ? a0->v.num : 0,
                              signal->kind == SCR_DYN_STR ? nc_signal_name(signal->v.str) : NULL);
      break;
    }
    case SCR_CHILD_EV_ERROR:
    case SCR_CHILD_EV_WRITE_ERROR: {
      ScrError *error =
          nc_error_of(a0, "an 'error' listener that takes an Error got a value that is not one");
      if (error == NULL) break;
      /* The adapters take a message and make the Error; with the payload
       * set they hand over this one (scr_child_err_thunk_error). */
      ScrError *outer = scr_event_error_payload;
      scr_event_error_payload = error;
      ((ScrChildErrFn)l->fn)(cb, error->message);
      scr_event_error_payload = outer;
      scr_error_release(error);
      break;
    }
    case SCR_CHILD_EV_DATA:
      if (l->fn == (void *)&scr_child_stream_thunk0) scr_child_stream_thunk0(cb, NULL);
      else if (a0->kind == SCR_DYN_BYTES) ((ScrChildStreamDataFn)l->fn)(cb, a0->v.bytes);
      else
        nc_refuse("a 'data' listener that takes a Buffer got a string: an encoding is set on the "
                  "island's stream");
      break;
    case SCR_CHILD_EV_DATA_STR:
      if (a0->kind == SCR_DYN_STR) ((ScrChildStreamDataStrFn)l->fn)(cb, a0->v.str);
      else
        nc_refuse("a 'data' listener that takes a string got a Buffer: no encoding is set on the "
                  "island's stream");
      break;
    case SCR_CHILD_EV_MESSAGE: {
      ScrDyn *message = a0->kind == SCR_DYN_STR ? scr_json_parse(a0->v.str)
                                                : scr_dyn_retain(scr_dyn_undefined());
      if (message != NULL) ((ScrIpcMessageFn)l->fn)(cb, message);
      scr_dyn_release(message);
      break;
    }
    default: /* 'spawn', 'disconnect', 'end', 'drain', 'finish': no argument */
      ((void (*)(ScrClosure *))cb->fn)(cb);
      break;
    }
    /* A 'close' listener ran in the emit that closed the group. */
    if (l->event == SCR_CHILD_EV_CLOSE && l->group != NULL && l->group->closed)
      scr_box_set_ref(clo->caps[1], NULL);
    break;
  }
  scr_closure_release(cb);
  nc_listener_release(l);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_retain(scr_dyn_undefined());
}

/* ── the handles ──────────────────────────────────────────────────────── */
enum { NC_CHILD = 1, NC_READABLE, NC_WRITABLE };

typedef struct NcHandle {
  uint8_t kind;
  bool stdio;          /* a child: its stdio handles were made */
  ScrDyn *object;      /* the island's object (+1) */
  ScrDyn *child;       /* a stream: the island child it belongs to (+1) */
  NcGroup *group;      /* +1, once a listener was registered */
  ScrChild *face;      /* a child: its ScrChild (not owned) */
  ScrArr *spawnargs;   /* a child: +1 once read */
  struct NcHandle *next; /* a child: the identity table's chain */
} NcHandle;

/* Island object (its import) -> the ScrChild that stands for it, while the
 * program holds that ScrChild. */
enum { NC_BUCKETS = 64 };
static SCR_TL NcHandle *nc_children[NC_BUCKETS];

static size_t nc_bucket(const void *import) {
  uintptr_t x = (uintptr_t)import;
  x ^= x >> 33;
  x *= 0xff51afd7ed558ccdULL;
  x ^= x >> 33;
  return (size_t)x % NC_BUCKETS;
}

static const void *nc_import(const ScrDyn *object) { return object->v.handle.ptr; }

/* The group of the island child a handle belongs to (borrowed; NULL with
 * the exception pending): the one its hook holds, made with the hook when
 * the island child has none yet. */
static NcGroup *nc_group(NcHandle *h) {
  if (h->group != NULL) return h->group;
  ScrDyn *child = h->child != NULL ? h->child : h->object;
  ScrDyn *hook = nc_island_call("hook", &child, 1);
  if (hook == NULL) return NULL;
  if (hook->kind == SCR_DYN_FUNC && hook->v.fn.thunk == nc_listener_thunk && hook->v.fn.clo != NULL) {
    NcListener *l = nc_listener_of(hook->v.fn.clo);
    if (l->group != NULL) h->group = nc_group_retain(l->group);
    nc_listener_release(l);
  }
  scr_dyn_release(hook);
  if (h->group != NULL) return h->group;
  NcGroup *group = calloc(1, sizeof *group);
  if (group == NULL) nc_oom();
  group->rc = 1;
  ScrDyn *args[2] = {child, nc_listener_new(group, NC_HOOK, NULL, NULL, NULL)};
  ScrDyn *closed = nc_island_call("setHook", args, 2);
  scr_dyn_release(args[1]);
  if (closed == NULL) {
    nc_group_release(group);
    return NULL;
  }
  group->closed = nc_true(closed);
  h->group = group;
  return group;
}

static const char *nc_event_name(int event) {
  switch (event) {
  case SCR_CHILD_EV_SPAWN: return "spawn";
  case SCR_CHILD_EV_EXIT: return "exit";
  case SCR_CHILD_EV_CLOSE: return "close";
  case SCR_CHILD_EV_ERROR:
  case SCR_CHILD_EV_WRITE_ERROR: return "error";
  case SCR_CHILD_EV_MESSAGE: return "message";
  case SCR_CHILD_EV_DISCONNECT: return "disconnect";
  case SCR_CHILD_EV_DATA:
  case SCR_CHILD_EV_DATA_STR: return "data";
  case SCR_CHILD_EV_END: return "end";
  case SCR_CHILD_EV_DRAIN: return "drain";
  default: return "finish";
  }
}

static ScrDyn *nc_str(const char *text, size_t len) {
  ScrStr *s = scr_str_new(text, len);
  ScrDyn *d = scr_dyn_new_str(s);
  scr_str_release(s);
  return d;
}

/* emitter.on / once(event, function). */
static void nc_register(NcHandle *h, int event, ScrDyn *function, bool once) {
  ScrDyn *answer;
  if (event == SCR_CHILD_EV_MESSAGE) {
    ScrDyn *args[3] = {h->object, function, scr_dyn_new_bool(once)};
    answer = nc_island_call("onMessage", args, 3);
    scr_dyn_release(args[2]);
  } else {
    const char *name = nc_event_name(event);
    ScrDyn *args[2] = {nc_str(name, strlen(name)), function};
    answer = scr_ni_call_method(h->object, once ? "once" : "on", once ? 4 : 2, args, 2);
    scr_dyn_release(args[0]);
  }
  scr_dyn_release(answer);
}

static void nc_on(void *island, int event, ScrClosure *cb, void *fn, bool once) {
  NcHandle *h = island;
  NcGroup *group = nc_group(h);
  /* After the child's 'close' nothing is delivered (scr_child.c: a listener
   * registered after settling is released and never fires). */
  if (group == NULL || group->closed) {
    scr_closure_release(cb);
    return;
  }
  ScrDyn *function = nc_listener_new(group, event, cb, fn, NULL);
  nc_register(h, event, function, once);
  scr_dyn_release(function);
}

static void nc_on_dyn(void *island, ScrStr *event, ScrDyn *listener) {
  NcHandle *h = island;
  NcGroup *group = nc_group(h);
  if (group == NULL || group->closed) return;
  NcListener *l;
  ScrDyn *function = nc_listener_new(group, NC_DYN, NULL, NULL, &l);
  l->dyn = scr_dyn_retain(listener);
  l->on_close = event->len == 5 && memcmp(event->data, "close", 5) == 0;
  ScrDyn *args[2] = {scr_dyn_new_str(event), function};
  scr_dyn_release(scr_ni_call_method(h->object, "on", 2, args, 2));
  scr_dyn_release(args[0]);
  scr_dyn_release(function);
}

/* child.off(event, listener): the most recent registration of this
 * function on this emitter, as EventEmitter removes it. The emitter says
 * which of the functions made for the closure it holds. The removed
 * function keeps the program's closure: an emit that is under way calls
 * every listener that was registered when it started, so a listener an
 * earlier one removes still runs in that emit. The closure is released with
 * the function (the island's collector frees it once the emitter no longer
 * holds it) or when the child closes. */
static void nc_off(void *island, int event, ScrClosure *cb) {
  NcHandle *h = island;
  NcGroup *group = nc_group(h);
  if (group == NULL) return;
  const char *name = nc_event_name(event);
  for (NcListener *l = group->first; l != NULL;) {
    NcListener *next = l->next;
    ScrClosure *held = l->event == event && !l->removed ? nc_closure_of(l->wrapper) : NULL;
    bool same = held != NULL && scr_closure_identity_equal(held, cb);
    scr_closure_release(held);
    if (same) {
      nc_listener_retain(l);
      ScrDyn *args[3] = {h->object, nc_str(name, strlen(name)), nc_listener_value(l)};
      bool removed = nc_true(nc_island_call("off", args, 3));
      scr_dyn_release(args[1]);
      scr_dyn_release(args[2]);
      if (removed) l->removed = true;
      /* The island call may have freed listeners: the walk ends here either way
       * when one was removed, and restarts from the list's head otherwise. */
      next = removed ? NULL : l->next;
      nc_listener_release(l);
      if (scr_exc_pending()) return;
    }
    l = next;
  }
}

static ScrDyn *nc_get(NcHandle *h, const char *key) {
  return scr_ni_get_str(h->object, key, strlen(key));
}

static bool nc_number(void *island, int prop, double *value) {
  if (prop == SCR_CHILD_PROP_FLOWING) { /* readableFlowing: null, false or true */
    ScrDyn *flowing = nc_get(island, "readableFlowing");
    bool known = flowing != NULL && flowing->kind == SCR_DYN_BOOL;
    if (known) *value = flowing->v.b ? 1 : 0;
    scr_dyn_release(flowing);
    return known;
  }
  ScrDyn *d = nc_get(island, prop == SCR_CHILD_PROP_PID ? "pid" : "exitCode");
  bool has = d != NULL && d->kind == SCR_DYN_NUM;
  if (has) *value = d->v.num;
  scr_dyn_release(d);
  return has;
}

static bool nc_boolean(void *island, int prop) {
  NcHandle *h = island;
  if (prop == SCR_CHILD_PROP_CHANNEL) return nc_true(nc_island_call("channel", &h->object, 1));
  if (prop == SCR_CHILD_PROP_PAUSED) return nc_true(scr_ni_call_method(h->object, "isPaused", 8, NULL, 0));
  return nc_true(nc_get(h, prop == SCR_CHILD_PROP_KILLED      ? "killed"
                           : prop == SCR_CHILD_PROP_CONNECTED ? "connected"
                                                              : "writable"));
}

static ScrStr *nc_string(void *island, int prop) {
  ScrDyn *d = nc_get(island, prop == SCR_CHILD_PROP_SIGNAL_CODE ? "signalCode" : "spawnfile");
  ScrStr *s = d != NULL && d->kind == SCR_DYN_STR ? scr_str_retain(d->v.str) : NULL;
  scr_dyn_release(d);
  return s;
}

/* child.spawnargs: read once, so repeated reads answer one array, as the
 * island's property does. */
static ScrArr *nc_spawnargs(void *island) {
  NcHandle *h = island;
  if (h->spawnargs == NULL) {
    ScrArr *list = scr_arr_new(SCR_ELEM_STR, 0);
    ScrDyn *text = nc_island_call("spawnargs", &h->object, 1);
    ScrDyn *items = text != NULL && text->kind == SCR_DYN_STR ? scr_json_parse(text->v.str) : NULL;
    if (items != NULL && items->kind == SCR_DYN_ARR)
      for (size_t i = 0; i < items->v.arr.len; i++)
        if (items->v.arr.items[i]->kind == SCR_DYN_STR)
          scr_arr_push_ref(list, scr_str_retain(items->v.arr.items[i]->v.str));
    scr_dyn_release(items);
    scr_dyn_release(text);
    h->spawnargs = list;
  }
  return scr_arr_retain(h->spawnargs);
}

static bool nc_kill(void *island, const ScrStr *signal, double signum) {
  NcHandle *h = island;
  ScrDyn *arg = signal != NULL ? scr_dyn_new_str((ScrStr *)signal) : scr_dyn_new_num(signum);
  bool sent = nc_true(scr_ni_call_method(h->object, "kill", 4, &arg, 1));
  scr_dyn_release(arg);
  return sent;
}

static void nc_call(void *island, const char *method) {
  NcHandle *h = island;
  scr_dyn_release(scr_ni_call_method(h->object, method, strlen(method), NULL, 0));
}

static bool nc_send(void *island, ScrStr *json, ScrClosure *cb, ScrIpcSendFn fn) {
  NcHandle *h = island;
  ScrDyn *args[3] = {h->object, scr_dyn_new_str(json),
                     cb != NULL ? nc_listener_new(NULL, NC_SEND, cb, (void *)fn, NULL) : NULL};
  bool sent = nc_true(nc_island_call("send", args, cb != NULL ? 3 : 2));
  scr_dyn_release(args[1]);
  scr_dyn_release(args[2]);
  return sent;
}

static void nc_set_encoding(void *island, ScrStr *encoding) {
  NcHandle *h = island;
  ScrDyn *arg = scr_dyn_new_str(encoding);
  scr_dyn_release(scr_ni_call_method(h->object, "setEncoding", 11, &arg, 1));
  scr_dyn_release(arg);
}

static bool nc_write(void *island, const ScrStr *text, const ScrBytes *bytes) {
  NcHandle *h = island;
  ScrDyn *arg = text != NULL ? scr_dyn_new_str((ScrStr *)text) : scr_dyn_new_buffer(bytes);
  bool more = nc_true(scr_ni_call_method(h->object, "write", 5, &arg, 1));
  scr_dyn_release(arg);
  return more;
}

/* A general stream's write or end into the island's stdin: the island's
 * callback completes it. A call that throws completes it with that error. */
static void nc_bridge(NcHandle *h, int event, ScrStream *stream, ScrBytes *chunk,
                      const ScrChildStreamOps *stream_ops) {
  NcListener *l;
  ScrDyn *done = nc_listener_new(NULL, event, NULL, NULL, &l);
  l->stream = stream_ops->retain(stream);
  l->stream_ops = stream_ops;
  ScrDyn *args[2] = {chunk != NULL ? scr_dyn_new_buffer(chunk) : done, done};
  ScrDyn *answer = event == NC_BRIDGE_WRITE ? scr_ni_call_method(h->object, "write", 5, args, 2)
                                            : scr_ni_call_method(h->object, "end", 3, args, 1);
  if (chunk != NULL) scr_dyn_release(args[0]);
  if (answer == NULL && scr_exc_pending() && l->stream != NULL) {
    ScrCaught *caught = scr_exc_take();
    ScrDyn *thrown = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    ScrError *error = thrown != NULL && thrown->kind == SCR_DYN_OBJ ? scr_error_from_dyn(thrown) : NULL;
    scr_dyn_release(thrown);
    l->stream = NULL;
    if (event == NC_BRIDGE_WRITE) stream_ops->write_done(stream, error);
    else stream_ops->final_done(stream, error);
    stream_ops->release(stream);
  }
  scr_dyn_release(answer);
  scr_dyn_release(done);
}

static void nc_bridge_write(void *island, ScrStream *stream, ScrBytes *chunk,
                            const ScrChildStreamOps *stream_ops) {
  nc_bridge(island, NC_BRIDGE_WRITE, stream, chunk, stream_ops);
}

static void nc_bridge_final(void *island, ScrStream *stream, const ScrChildStreamOps *stream_ops) {
  nc_bridge(island, NC_BRIDGE_FINAL, stream, NULL, stream_ops);
}

static NcHandle *nc_handle_new(int kind, ScrDyn *object /* moves */, ScrDyn *child) {
  NcHandle *h = calloc(1, sizeof *h);
  if (h == NULL) nc_oom();
  h->kind = (uint8_t)kind;
  h->object = object;
  h->child = child != NULL ? scr_dyn_retain(child) : NULL;
  return h;
}

/* One stdio member of the island child: its handle's island part, or NULL
 * for null (a slot that is not a pipe). Moves nothing. */
static NcHandle *nc_stdio_member(NcHandle *h, const char *key, int kind) {
  ScrDyn *stream = nc_get(h, key);
  if (stream != NULL && scr_ni_is_handle(stream)) return nc_handle_new(kind, stream, h->object);
  scr_dyn_release(stream);
  return NULL;
}

static void nc_stdio(ScrChild *child) {
  NcHandle *h = child->island;
  if (h->stdio) return;
  h->stdio = true;
  NcHandle *in = nc_stdio_member(h, "stdin", NC_WRITABLE);
  NcHandle *out = nc_stdio_member(h, "stdout", NC_READABLE);
  NcHandle *err = nc_stdio_member(h, "stderr", NC_READABLE);
  if (in != NULL) child->in_stream = scr_child_writer_island_new(in);
  if (out != NULL) child->out_stream = scr_child_stream_island_new(out);
  if (err != NULL) child->err_stream = scr_child_stream_island_new(err);
}

static void nc_drop(void *island) {
  NcHandle *h = island;
  if (h->kind == NC_CHILD) {
    NcHandle **at = &nc_children[nc_bucket(nc_import(h->object))];
    while (*at != NULL && *at != h) at = &(*at)->next;
    if (*at == h) *at = h->next;
    if (h->spawnargs != NULL) scr_arr_release(h->spawnargs);
  }
  nc_group_release(h->group);
  scr_dyn_release(h->child);
  scr_dyn_release(h->object);
  free(h);
}

static const ScrChildIslandOps nc_ops = {
    nc_drop,      nc_stdio,    nc_on,           nc_off,         nc_on_dyn, nc_number,
    nc_boolean,   nc_string,   nc_spawnargs,    nc_kill,        nc_call,   nc_send,
    nc_set_encoding, nc_write, nc_bridge_write, nc_bridge_final,
};

/* ── the conversions (dyn.ts, ISLAND_ADOPTED_KINDS) ─────────────────────── */

static bool nc_is_child(const ScrDyn *d) {
  ScrDyn *arg = (ScrDyn *)d;
  return nc_true(nc_island_call("isChild", &arg, 1));
}

/* A dynamic value into a ChildProcess slot (+1): a native child as it is,
 * an island's ChildProcess adopted, anything else the conversion's
 * TypeError. */
ScrChild *scr_ni_child_unbox(const ScrDyn *d, const ScrDynPath *path, const char *want) {
  if (!scr_ni_dyn_handle(d)) return scr_dyn_handle_unbox(d, SCR_DYNH_CHILD, path, want);
  size_t bucket = nc_bucket(nc_import(d));
  for (NcHandle *h = nc_children[bucket]; h != NULL; h = h->next)
    if (nc_import(h->object) == nc_import(d)) return scr_child_retain(h->face);
  if (!nc_is_child(d)) {
    if (!scr_exc_pending()) scr_dyn_check_fail(path, want, d);
    return NULL;
  }
  scr_child_island_ops = &nc_ops;
  NcHandle *h = nc_handle_new(NC_CHILD, scr_dyn_retain((ScrDyn *)d), NULL);
  h->face = scr_child_island_new(h);
  h->next = nc_children[bucket];
  nc_children[bucket] = h;
  return h->face;
}

/* Whether a dynamic value is a ChildProcess (a union's arm test). */
bool scr_ni_child_is(const ScrDyn *d) {
  if (d->kind != SCR_DYN_HANDLE) return false;
  if (d->v.handle.tag == SCR_DYNH_CHILD) return true;
  if (d->v.handle.tag != SCR_DYNH_NODE_ISLAND) return false;
  for (NcHandle *h = nc_children[nc_bucket(nc_import(d))]; h != NULL; h = h->next)
    if (nc_import(h->object) == nc_import(d)) return true;
  ScrCaught *outer = scr_exc_pending() ? scr_exc_take() : NULL;
  bool is = nc_is_child(d);
  if (scr_exc_pending()) scr_exc_clear();
  if (outer != NULL) {
    scr_rethrow(outer);
    scr_caught_release(outer);
  }
  return is;
}

/* A ChildProcess slot's value as a dynamic value (+1): the island's own
 * object for an adopted child, the native handle otherwise. */
ScrDyn *scr_ni_child_box(ScrChild *child) {
  if (child->island != NULL) return scr_dyn_retain(((NcHandle *)child->island)->object);
  return scr_dyn_new_handle(child, SCR_DYNH_CHILD);
}

#else /* _WIN32 || __wasi__: no islands */

ScrChild *scr_ni_child_unbox(const ScrDyn *d, const ScrDynPath *path, const char *want) {
  return scr_dyn_handle_unbox(d, SCR_DYNH_CHILD, path, want);
}

bool scr_ni_child_is(const ScrDyn *d) {
  return d->kind == SCR_DYN_HANDLE && d->v.handle.tag == SCR_DYNH_CHILD;
}

ScrDyn *scr_ni_child_box(ScrChild *child) { return scr_dyn_new_handle(child, SCR_DYNH_CHILD); }

#endif
