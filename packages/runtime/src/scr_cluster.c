/* node:cluster — primary/worker process management over the child_process
 * fork channel (scr_child.c). See scr_cluster.h for the model.
 *
 * A worker is a checked-dynamic handle (the scr_dns_resolve.c Resolver
 * model): the static lowering of cluster.fork() answers one, its members
 * dispatch here, and cluster.workers hands out the same handle identity per
 * live worker.
 *
 * Events use the checked-dynamic function values the compiler boxes a
 * listener into: each listener is called with the argument shapes Node's
 * own EventEmitter emits, so a typed listener's checked adapter converts
 * them at the boundary.
 */
#include "scr_cluster.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "scr_async.h"
#include "scr_blob.h"
#include "scr_child.h"
#include "scr_dyn.h"
#include "scr_error.h"
#include "scr_json.h"

typedef struct {
  ScrStr *name;
  ScrDyn *fn; /* +1 */
  bool once;
} ScrClListener;

typedef struct {
  ScrClListener *items;
  size_t n, cap;
} ScrClListeners;

typedef struct ScrClusterWorker ScrClusterWorker;

struct ScrClusterWorker {
  size_t rc;
  double id;
  ScrChild *child; /* NULL for the process's own worker (self) */
  bool self;
  bool online;
  bool exited_after_disconnect;
  bool removed; /* no longer listed in cluster.workers */
  bool disconnect_awaited; /* cluster.disconnect() counts this worker */
  bool exited; /* the child's terminal event fired */
  const char *state; /* "none" | "online" | "listening" | "disconnected" | "dead" */
  ScrClListeners ls;
  struct ScrClusterWorker *next;
  struct ScrClusterWorker *all_next; /* every worker ever forked: teardown */
};

static SCR_TL ScrClusterWorker *scr_cl_workers = NULL;
/* Every worker this primary ever forked, kept alive to exit so cleanup can
 * break the listener cycles (a listener that captured its worker) before
 * the reference-count audit runs. */
static SCR_TL ScrClusterWorker *scr_cl_all_workers = NULL;
/* Worker references a child's terminal callback still holds when it runs:
 * releasing the last one there would free the child inside its own settle
 * pass. They are dropped at teardown instead. */
static SCR_TL ScrClusterWorker **scr_cl_deferred = NULL;
static SCR_TL size_t scr_cl_deferred_n = 0;

static void scr_clw_release(ScrClusterWorker *w);
static void scr_cl_deferred_drain(void);

static SCR_TL bool scr_cl_deferred_scheduled = false;

/* Drops the references terminal callbacks handed back: a worker freed the
 * moment its last event ran, not at exit, so recycling workers does not
 * accumulate them. */
static void scr_cl_deferred_drain(void) {
  scr_cl_deferred_scheduled = false;
  for (size_t i = 0; i < scr_cl_deferred_n; i++) scr_clw_release(scr_cl_deferred[i]);
  free(scr_cl_deferred);
  scr_cl_deferred = NULL;
  scr_cl_deferred_n = 0;
  scr_cl_deferred_scheduled = false;
}

static void scr_cl_defer_release(ScrClusterWorker *w) {
  ScrClusterWorker **items = realloc(scr_cl_deferred, (scr_cl_deferred_n + 1) * sizeof *items);
  if (!items) scr_trap("out of memory");
  scr_cl_deferred = items;
  items[scr_cl_deferred_n++] = w; /* the +1 moves here */
  if (!scr_cl_deferred_scheduled) {
    scr_cl_deferred_scheduled = true;
    scr_next_tick_raw(&scr_cl_deferred_drain);
  }
}
static SCR_TL ScrClListeners scr_cl_events; /* the cluster object's listeners */
static SCR_TL ScrDyn *scr_cl_settings = NULL;
static SCR_TL double scr_cl_next_id = 0;
static SCR_TL bool scr_cl_initialized = false;
static SCR_TL bool scr_cl_worker_mode = false;
static SCR_TL double scr_cl_self_id = 0;
static SCR_TL ScrClusterWorker *scr_cl_self = NULL;
static SCR_TL bool scr_cl_disconnect_pending = false;
/* The 'setup' emissions scheduled so far, FIFO: every setupPrimary call
 * (and every cluster.fork(), which calls it) emits one, carrying the
 * settings object that call produced (Node's setupSettingsNT(settings)). */
typedef struct {
  ScrDyn *settings; /* +1 */
} ScrClSetup;
static SCR_TL ScrClSetup *scr_cl_setups = NULL;
static SCR_TL size_t scr_cl_setups_n = 0;
static SCR_TL size_t scr_cl_disconnect_waiting = 0;
static SCR_TL ScrDyn *scr_cl_disconnect_cb = NULL; /* +1 */
static SCR_TL ScrClusterWorker **scr_cl_fork_pending = NULL; /* +1 entries */
static SCR_TL size_t scr_cl_fork_pending_n = 0;

static void scr_cl_finish_disconnect(void);
static void scr_cl_schedule_setup(ScrDyn *settings);
static void scr_cl_levels_cleanup(void);
static ScrDyn *scr_cl_worker_handle(ScrClusterWorker *w);

/* ── the worker's lifetime ─────────────────────────────────────────── */

static void scr_clw_release(ScrClusterWorker *w);
static ScrClusterWorker *scr_clw_retain(ScrClusterWorker *w) {
  if (w && w->rc != SIZE_MAX) w->rc++;
  return w;
}

static void scr_cl_ls_clear(ScrClListeners *ls) {
  for (size_t i = 0; i < ls->n; i++) {
    scr_str_release(ls->items[i].name);
    scr_dyn_release(ls->items[i].fn);
  }
  free(ls->items);
  ls->items = NULL;
  ls->n = ls->cap = 0;
}

static void *scr_clw_retain_v(void *p) { return scr_clw_retain((ScrClusterWorker *)p); }
static void scr_clw_release_v(void *p) { scr_clw_release((ScrClusterWorker *)p); }

static void scr_clw_release(ScrClusterWorker *w) {
  if (!w || w->rc == 0 || w->rc == SIZE_MAX) return;
  if (--w->rc != 0) return;
  scr_child_release(w->child);
  scr_cl_ls_clear(&w->ls);
  free(w);
}

/* ── listener lists ────────────────────────────────────────────────── */

static bool scr_cl_str_eq(const ScrStr *a, const ScrStr *b) {
  return a->len == b->len && memcmp(a->data, b->data, a->len) == 0;
}

static bool scr_cl_str_is(const ScrStr *s, const char *text) {
  size_t len = strlen(text);
  return s->len == len && memcmp(s->data, text, len) == 0;
}

static void scr_cl_ls_add(ScrClListeners *ls, const ScrStr *name, ScrDyn *fn, bool once) {
  if (ls->n == ls->cap) {
    size_t cap = ls->cap ? ls->cap * 2 : 4;
    ScrClListener *items = realloc(ls->items, cap * sizeof *items);
    if (!items) scr_trap("out of memory");
    ls->items = items;
    ls->cap = cap;
  }
  ls->items[ls->n++] = (ScrClListener){scr_str_retain((ScrStr *)name), scr_dyn_retain(fn), once};
}

/* Removes (and answers, +1) the listeners matching the name, and the
 * function when one is given. */
static size_t scr_cl_ls_take(ScrClListeners *ls, const ScrStr *name, const ScrDyn *fn_or_null,
                             ScrClListener *out) {
  size_t count = 0;
  for (size_t i = 0; i < ls->n;) {
    ScrClListener *it = &ls->items[i];
    bool match = scr_cl_str_eq(it->name, name) && (fn_or_null == NULL || it->fn == fn_or_null);
    if (!match) {
      i++;
      continue;
    }
    out[count++] = *it;
    memmove(ls->items + i, ls->items + i + 1, (ls->n - i - 1) * sizeof *ls->items);
    ls->n--;
  }
  return count;
}

static void scr_cl_taken_release(ScrClListener *items, size_t count) {
  for (size_t i = 0; i < count; i++) {
    scr_str_release(items[i].name);
    scr_dyn_release(items[i].fn);
  }
}

/* Fires the listeners registered for `event` with `args` (borrowed): a
 * `once` listener is removed before it runs, as Node's emitter does, and
 * the snapshot keeps registration order. Stops when a listener throws. */
static void scr_cl_ls_emit(ScrClListeners *ls, const char *event, ScrDyn *const *args,
                           size_t argc) {
  if (ls->n == 0) return;
  ScrStr *name = scr_str_new(event, strlen(event));
  ScrClListener *snapshot = malloc(ls->n * sizeof *snapshot);
  if (!snapshot) scr_trap("out of memory");
  size_t count = 0;
  for (size_t i = 0; i < ls->n; i++) {
    if (!scr_cl_str_eq(ls->items[i].name, name)) continue;
    snapshot[count++] = (ScrClListener){scr_str_retain(ls->items[i].name),
                                        scr_dyn_retain(ls->items[i].fn), ls->items[i].once};
  }
  /* Remove the one-shot registrations; their snapshot entries hold their
   * own references. */
  for (size_t i = 0; i < ls->n;) {
    ScrClListener *it = &ls->items[i];
    if (!scr_cl_str_eq(it->name, name) || !it->once) {
      i++;
      continue;
    }
    scr_str_release(it->name);
    scr_dyn_release(it->fn);
    memmove(ls->items + i, ls->items + i + 1, (ls->n - i - 1) * sizeof *ls->items);
    ls->n--;
  }
  scr_str_release(name);
  for (size_t i = 0; i < count; i++) {
    if (!scr_exc_pending()) {
      ScrDyn *result = scr_dyn_call(snapshot[i].fn, args, argc, event);
      scr_dyn_release(result);
    }
    scr_str_release(snapshot[i].name);
    scr_dyn_release(snapshot[i].fn);
  }
  free(snapshot);
}

/* ── small helpers ─────────────────────────────────────────────────── */

static ScrDyn *scr_cl_undefined(void) { return scr_dyn_retain(scr_dyn_undefined()); }

static char *scr_cl_cstr(const ScrStr *s) {
  char *text = malloc(s->len + 1);
  if (!text) scr_trap("out of memory");
  memcpy(text, s->data, s->len);
  text[s->len] = '\0';
  return text;
}

static double scr_cl_parse_id(const ScrStr *s) {
  char *text = scr_cl_cstr(s);
  double id = strtod(text, NULL);
  free(text);
  return id;
}

/* The argv entries a worker runs with: cluster.settings.args, else this
 * program's own user arguments (Node's process.argv.slice(2)). +1. */
static ScrArr *scr_cl_worker_args(void) {
  ScrDyn *settings = scr_cl_settings;
  if (settings != NULL && settings->kind == SCR_DYN_OBJ) {
    ScrDyn *args = scr_dyn_obj_get(settings, "args", 4); /* borrowed */
    if (args != NULL && args->kind == SCR_DYN_ARR) {
      ScrArr *out = scr_arr_new(SCR_ELEM_STR, 0);
      double len = scr_dyn_arr_len(args);
      for (double i = 0; i < len; i += 1) {
        ScrDyn *item = scr_dyn_arr_at(args, i); /* +1 */
        if (item != NULL && item->kind == SCR_DYN_STR)
          scr_arr_push_ref(out, scr_str_retain(item->v.str));
        scr_dyn_release(item);
      }
      return out;
    }
  }
  ScrArr *argv = scr_process_argv(); /* +1 */
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, 0);
  double len = scr_arr_len(argv);
  for (double i = 2; i < len; i += 1) {
    ScrStr *item = scr_arr_get_ref(argv, i); /* +1 */
    scr_arr_push_ref(out, item);
  }
  scr_arr_release(argv);
  return out;
}

/* [k0, v0, ...] with (key, value) overrides applied over `base`: an
 * existing key is replaced, a new one appended. Both borrowed. +1. */
static ScrArr *scr_cl_env_merge(ScrArr *base, ScrStr *const *keys, ScrStr *const *values,
                                size_t count) {
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, 0);
  double len = scr_arr_len(base);
  for (double i = 0; i + 1 < len; i += 2) {
    ScrStr *key = scr_arr_get_ref(base, i); /* +1 */
    bool replaced = false;
    for (size_t j = 0; j < count; j++) {
      if (scr_cl_str_eq(key, keys[j])) {
        replaced = true;
        break;
      }
    }
    if (replaced) {
      scr_str_release(key);
      continue;
    }
    ScrStr *value = scr_arr_get_ref(base, i + 1); /* +1 */
    scr_arr_push_ref(out, key);
    scr_arr_push_ref(out, value);
  }
  for (size_t j = 0; j < count; j++) {
    scr_arr_push_ref(out, scr_str_retain(keys[j]));
    scr_arr_push_ref(out, scr_str_retain(values[j]));
  }
  return out;
}

/* The env option's entries: Node's spawn coerces every value with ToString
 * and drops an undefined one. */
static bool scr_cl_env_entries(const ScrDyn *env, ScrStr ***keys_out, ScrStr ***values_out,
                               size_t *count_out) {
  *keys_out = NULL;
  *values_out = NULL;
  *count_out = 0;
  if (env == NULL || env->kind == SCR_DYN_UNDEF || env->kind == SCR_DYN_NULL) return true;
  if (env->kind != SCR_DYN_OBJ) {
    const char msg[] = "The \"env\" argument must be an object";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_TYPE");
    return false;
  }
  ScrArr *names = scr_dyn_obj_key_strs(env); /* +1 */
  size_t n = (size_t)scr_arr_len(names);
  ScrStr **keys = n ? calloc(n, sizeof *keys) : NULL;
  ScrStr **values = n ? calloc(n, sizeof *values) : NULL;
  if (n && (!keys || !values)) scr_trap("out of memory");
  size_t count = 0;
  for (size_t i = 0; i < n; i++) {
    ScrStr *key = scr_arr_get_ref(names, (double)i); /* +1 */
    ScrDyn *value = scr_dyn_obj_get(env, key->data, key->len); /* borrowed */
    if (value != NULL && value->kind != SCR_DYN_UNDEF) {
      ScrStr *text = scr_dyn_to_string(value, NULL); /* +1 */
      if (text == NULL) {
        scr_str_release(key);
        for (size_t j = 0; j < count; j++) {
          scr_str_release(keys[j]);
          scr_str_release(values[j]);
        }
        free(keys);
        free(values);
        scr_arr_release(names);
        return false;
      }
      keys[count] = key;
      values[count] = text;
      count++;
    } else {
      scr_str_release(key);
    }
  }
  scr_arr_release(names);
  *keys_out = keys;
  *values_out = values;
  *count_out = count;
  return true;
}

static void scr_cl_env_entries_free(ScrStr **keys, ScrStr **values, size_t count) {
  for (size_t i = 0; i < count; i++) {
    scr_str_release(keys[i]);
    scr_str_release(values[i]);
  }
  free(keys);
  free(values);
}

/* ── settings ──────────────────────────────────────────────────────── */

static ScrDyn *scr_cl_default_settings(void) {
  ScrDyn *settings = scr_dyn_new_obj();
  ScrArr *args = scr_cl_worker_args(); /* +1 */
  ScrDyn *args_dyn = scr_dyn_new_arr();
  double len = scr_arr_len(args);
  for (double i = 0; i < len; i += 1) {
    ScrStr *item = scr_arr_get_ref(args, i); /* +1 */
    scr_dyn_arr_push(args_dyn, scr_dyn_new_str(item));
    scr_str_release(item);
  }
  ScrStr *exec = scr_process_exec_path(); /* +1 */
  scr_dyn_obj_set(settings, "args", 4, args_dyn);
  scr_dyn_obj_set(settings, "exec", 4, scr_dyn_new_str(exec));
  scr_dyn_obj_set(settings, "execArgv", 8, scr_dyn_new_arr());
  scr_dyn_obj_set(settings, "silent", 6, scr_dyn_new_bool(false));
  scr_str_release(exec);
  scr_arr_release(args);
  return settings;
}

/* Copies the parts of `source` an object spread copies onto `target`: the own
 * enumerable string-keyed entries of an object, function, array, typed record
 * view, Proxy, or handle. Each value is read through an ordinary property
 * access, so an accessor entry runs its getter and the merged settings hold
 * the value it answers; a Proxy source answers its ownKeys and its get trap. */
static void scr_cl_object_assign(ScrDyn *target, const ScrDyn *source) {
  if (source == NULL) return;
  /* A typed settings record crosses as a capsule; its properties live on
   * its materialized view. */
  ScrDyn *view = NULL;
  if (source->kind == SCR_DYN_TYPED_REF) {
    view = scr_dyn_typed_ref_materialize(source); /* +1 */
    if (scr_exc_pending()) {
      scr_dyn_release(view);
      return;
    }
    source = view;
  }
  switch (source->kind) {
  case SCR_DYN_OBJ:
  case SCR_DYN_FUNC:
  case SCR_DYN_ARR:
  case SCR_DYN_PROXY:
  case SCR_DYN_HANDLE:
    break;
  default:
    scr_dyn_release(view);
    return;
  }
  ScrArr *names = scr_dyn_obj_key_strs(source); /* +1 */
  if (names == NULL) {
    scr_dyn_release(view);
    return;
  }
  size_t n = (size_t)scr_arr_len(names);
  for (size_t i = 0; i < n; i++) {
    ScrStr *key = scr_arr_get_ref(names, (double)i); /* +1 */
    ScrDyn *value = scr_dyn_obj_read(source, key->data, key->len); /* +1 */
    if (value != NULL && !scr_exc_pending())
      scr_dyn_obj_set(target, key->data, key->len, value);
    else
      scr_dyn_release(value);
    scr_str_release(key);
    if (scr_exc_pending()) break;
  }
  scr_arr_release(names);
  scr_dyn_release(view);
}

static void scr_cl_fire_setup(void) {
  if (scr_cl_setups_n == 0) return;
  ScrDyn *settings = scr_cl_setups[0].settings;
  memmove(scr_cl_setups, scr_cl_setups + 1, (scr_cl_setups_n - 1) * sizeof *scr_cl_setups);
  scr_cl_setups_n--;
  ScrDyn *args[] = {settings};
  scr_cl_ls_emit(&scr_cl_events, "setup", args, 1);
  scr_dyn_release(settings);
}

static void scr_cl_schedule_setup(ScrDyn *settings) {
  ScrClSetup *items = realloc(scr_cl_setups, (scr_cl_setups_n + 1) * sizeof *items);
  if (!items) scr_trap("out of memory");
  scr_cl_setups = items;
  items[scr_cl_setups_n++] = (ScrClSetup){scr_dyn_retain(settings)};
  scr_next_tick_raw(&scr_cl_fire_setup);
}

/* Node's setupPrimary merge: the defaults, then the settings object as the
 * program left it (Node's `...cluster.settings`), then `options`. Node
 * assigns a fresh object and schedules a 'setup' emission per call, each
 * carrying that call's object. `options` is borrowed; NULL is the bare
 * call. */
static void scr_cl_setup_impl(const ScrDyn *options) {
  ScrDyn *previous = scr_cl_settings;
  ScrDyn *settings = scr_cl_default_settings();
  if (previous != NULL) scr_cl_object_assign(settings, previous);
  if (options != NULL) scr_cl_object_assign(settings, options);
  /* A throwing getter makes Node's object spread throw, so the merge stops
   * before the settings object replaces the previous one or is emitted. */
  if (scr_exc_pending()) {
    scr_dyn_release(settings);
    return;
  }
  scr_dyn_release(previous);
  scr_cl_settings = settings;
  scr_cl_schedule_setup(settings);
}

void scr_cluster_setup(const ScrDyn *options) {
  if (!scr_cl_initialized) scr_cluster_init();
  if (scr_cl_worker_mode) {
    const char msg[] = "Cannot initialize cluster in a worker process";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_WORKER_INIT_FAILED");
    return;
  }
  scr_cl_setup_impl(options);
}

/* ── registry ──────────────────────────────────────────────────────── */

static void scr_cl_register(ScrClusterWorker *w) {
  w->next = scr_cl_workers;
  scr_cl_workers = scr_clw_retain(w);
}

/* cluster.workers removal (Node's removeWorker): the id stops listing at
 * once, but the registry keeps the worker (and so its child channel)
 * referenced until the process's exit event, which is what keeps a primary
 * from exiting ahead of a worker it just disconnected. */
static void scr_cl_maybe_remove(ScrClusterWorker *w) { w->removed = true; }

/* Drops the teardown list's reference once a worker's terminal events ran,
 * so a long-lived primary does not retain every worker it ever forked. */
static void scr_cl_forget_worker(ScrClusterWorker *w) {
  for (ScrClusterWorker **p = &scr_cl_all_workers; *p != NULL; p = &(*p)->all_next) {
    if (*p != w) continue;
    *p = w->all_next;
    w->all_next = NULL;
    scr_clw_release(w);
    break;
  }
}

/* Drops the registry's reference (the exit event, and teardown). */
static void scr_cl_unlink(ScrClusterWorker *w) {
  for (ScrClusterWorker **p = &scr_cl_workers; *p != NULL; p = &(*p)->next) {
    if (*p != w) continue;
    *p = w->next;
    w->next = NULL;
    scr_clw_release(w);
    break;
  }
}

static void scr_cl_fire_disconnect_done(void) {
  ScrDyn *cb = scr_cl_disconnect_cb;
  if (cb == NULL) return;
  scr_cl_disconnect_cb = NULL;
  ScrDyn *result = scr_dyn_call(cb, NULL, 0, "disconnect callback");
  scr_dyn_release(result);
  scr_dyn_release(cb);
}

static void scr_cl_finish_disconnect(void) {
  if (!scr_cl_disconnect_pending) return;
  scr_cl_disconnect_pending = false;
  scr_cl_disconnect_waiting = 0;
  scr_next_tick_raw(&scr_cl_fire_disconnect_done);
}

/* A worker cluster.disconnect() asked for reached 'disconnect' or 'exit'. */
static void scr_cl_disconnect_advance(ScrClusterWorker *w) {
  if (!w->disconnect_awaited) return;
  w->disconnect_awaited = false;
  if (scr_cl_disconnect_waiting > 0) scr_cl_disconnect_waiting--;
  if (scr_cl_disconnect_waiting == 0) scr_cl_finish_disconnect();
}

/* ── internal protocol messages ────────────────────────────────────── */

static bool scr_cl_send_act(ScrChild *child, const char *act) {
  char json[128];
  int n = snprintf(json, sizeof json, "{\"cmd\":\"NODE_CLUSTER\",\"act\":\"%s\"}", act);
  if (n <= 0) return false;
  ScrStr *text = scr_str_new(json, (size_t)n);
  bool ok = scr_child_ipc_send(child, text);
  scr_str_release(text);
  return ok;
}

bool scr_cluster_message_is_internal(const ScrDyn *message) {
  if (message == NULL || message->kind != SCR_DYN_OBJ) return false;
  ScrDyn *cmd = scr_dyn_obj_get(message, "cmd", 3); /* borrowed */
  return cmd != NULL && cmd->kind == SCR_DYN_STR && scr_cl_str_is(cmd->v.str, "NODE_CLUSTER");
}

/* The worker's own channel: the primary's acts arrive here. */
static void scr_cl_self_act(const ScrDyn *message) {
  ScrDyn *act = scr_dyn_obj_get(message, "act", 3); /* borrowed */
  if (act != NULL && act->kind == SCR_DYN_STR && scr_cl_str_is(act->v.str, "disconnect")) {
    if (scr_cl_self != NULL) scr_cl_self->exited_after_disconnect = true;
    scr_process_ipc_disconnect();
  }
}

void scr_cluster_message_dispatch(ScrChild *child, ScrDyn *message) {
  if (child == NULL) {
    scr_cl_self_act(message);
    return;
  }
  ScrClusterWorker *w = NULL;
  for (ScrClusterWorker *it = scr_cl_workers; it != NULL; it = it->next) {
    if (it->child == child) {
      w = it;
      break;
    }
  }
  if (w == NULL) return;
  ScrDyn *act = scr_dyn_obj_get(message, "act", 3); /* borrowed */
  if (act != NULL && act->kind == SCR_DYN_STR && scr_cl_str_is(act->v.str, "online") &&
      !w->online) {
    w->online = true;
    w->state = "online";
    ScrDyn *self = scr_cl_worker_handle(w);
    ScrDyn *args[] = {self};
    scr_cl_ls_emit(&w->ls, "online", args, 1);
    scr_cl_ls_emit(&scr_cl_events, "online", args, 1);
    scr_dyn_release(self);
  }
}

/* ── the dyn worker handle ─────────────────────────────────────────── */

/* One handle identity per worker: dyn equality compares (tag, pointer), so
 * every handle of a worker answers the same value, as Node's one Worker
 * object does. scr_dyn_new_handle retains the worker. */
static ScrDyn *scr_cl_worker_handle(ScrClusterWorker *w) {
  return scr_dyn_new_handle(w, SCR_DYNH_CLUSTER_WORKER);
}

static ScrDyn *scr_cl_worker_process_value(ScrClusterWorker *w) {
  if (w->self) return scr_cl_undefined();
  /* scr_dyn_new_handle retains the child itself; retaining here as well
   * would strand one reference per read, keeping every completed worker's
   * arguments, streams and AsyncLocalStorage context alive. */
  return scr_dyn_new_handle(w->child, SCR_DYNH_CHILD);
}

static bool scr_cl_worker_connected(ScrClusterWorker *w) {
  return w->self ? scr_process_ipc_connected() : scr_child_ipc_connected(w->child);
}

/* Node's send callback is asynchronous and carries the write's outcome:
 * the channel's send entry reports a write that could not complete (the
 * broken pipe of a worker that is already gone) as well as a channel
 * closed first. The thunk below turns that outcome into a queued callback
 * pair — it does not box the channel's error, so nothing of the error
 * survives the send — and the drain calls the program's callback on the
 * next tick with null or the canonical ERR_IPC_CHANNEL_CLOSED. */
typedef struct {
  ScrDyn *cb; /* +1 */
  bool failed;
} ScrClSendCb;

/* The dyn %Error Node's closed-channel send delivers. */
static ScrDyn *scr_cl_channel_closed_error(void) {
  ScrStr *message = scr_str_new("Channel closed", sizeof("Channel closed") - 1);
  ScrError *error = scr_error_new(0, message);
  scr_str_release(message);
  scr_error_set_code(error, "ERR_IPC_CHANNEL_CLOSED");
  ScrDyn *result = scr_dyn_from_error(error);
  scr_error_release(error);
  return result;
}

static SCR_TL ScrClSendCb *scr_cl_send_cbs = NULL;
static SCR_TL size_t scr_cl_send_cbs_n = 0;

static void scr_cl_send_cb_queue(ScrDyn *cb, bool failed) {
  ScrClSendCb *items = realloc(scr_cl_send_cbs, (scr_cl_send_cbs_n + 1) * sizeof *items);
  if (!items) scr_trap("out of memory");
  scr_cl_send_cbs = items;
  items[scr_cl_send_cbs_n++] = (ScrClSendCb){scr_dyn_retain(cb), failed};
}

static void scr_cl_send_cb_drain(void) {
  while (scr_cl_send_cbs_n > 0 && !scr_exc_pending()) {
    ScrClSendCb entry = scr_cl_send_cbs[0];
    memmove(scr_cl_send_cbs, scr_cl_send_cbs + 1,
            (scr_cl_send_cbs_n - 1) * sizeof *scr_cl_send_cbs);
    scr_cl_send_cbs_n--;
    /* Node's success argument is null (not undefined): a typed
     * (error: Error | null) parameter converts it. */
    ScrDyn *arg = entry.failed ? scr_cl_channel_closed_error() : scr_dyn_new_null();
    ScrDyn *args[] = {arg};
    ScrDyn *r = scr_dyn_call(entry.cb, args, 1, "send callback");
    scr_dyn_release(r);
    scr_dyn_release(arg);
    scr_dyn_release(entry.cb);
  }
}

/* The channel's completion entry: it runs once, with the send's error or
 * NULL, and hands the outcome to the callback queue. The channel owns the
 * closure and releases it after this call. */
static void scr_cl_send_done_thunk(ScrClosure *cb, ScrError *error) {
  ScrDyn *dyn_cb = scr_box_get_ref(cb->caps[0]); /* +1 */
  scr_cl_send_cb_queue(dyn_cb, error != NULL);
  scr_dyn_release(dyn_cb);
  /* The completion's error belongs to this callback (the channel releases
   * it only when no callback runs); its outcome is all the queue keeps. */
  scr_error_release(error);
  if (scr_cl_send_cbs_n == 1) scr_next_tick_raw(&scr_cl_send_cb_drain);
}

static ScrClosure *scr_cl_send_done_closure(ScrDyn *callback) {
  ScrClosure *cb = scr_closure_new((void *)&scr_cl_send_done_thunk, 1);
  cb->caps[0] = scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, &scr_dyn_trace_v);
  scr_box_set_ref(cb->caps[0], scr_dyn_retain(callback));
  return cb;
}

static bool scr_cl_worker_send(ScrClusterWorker *w, ScrDyn *message, ScrDyn *callback) {
  /* The checked-dynamic JSON walker the compiler's own message sends use;
   * it answers the serialized text (+1) and reports a refusal through the
   * pending exception. */
  ScrStr *text = scr_dyn_format_j(message);
  if (text == NULL) {
    if (callback != NULL) {
      scr_cl_send_cb_queue(callback, true);
      if (scr_cl_send_cbs_n == 1) scr_next_tick_raw(&scr_cl_send_cb_drain);
    }
    return false;
  }
  bool ok;
  if (callback == NULL) {
    ok = w->self ? scr_process_ipc_send(text) : scr_child_ipc_send(w->child, text);
  } else {
    ScrClosure *done = scr_cl_send_done_closure(callback);
    ok = w->self ? scr_process_ipc_send_cb(text, done, scr_cl_send_done_thunk)
                 : scr_child_ipc_send_cb(w->child, text, done, scr_cl_send_done_thunk);
  }
  scr_str_release(text);
  return ok;
}

static ScrDyn *scr_cl_worker_disconnect_method(ScrClusterWorker *w) {
  w->exited_after_disconnect = true;
  if (w->self) {
    scr_process_ipc_disconnect();
  } else {
    scr_cl_send_act(w->child, "disconnect");
    scr_cl_maybe_remove(w);
  }
  return scr_cl_undefined();
}

static ScrDyn *scr_cl_worker_kill_method(ScrClusterWorker *w, ScrDyn *signal) {
  if (w->self) {
    /* Node's child-side destroy: mark the disconnect and exit 0. */
    w->exited_after_disconnect = true;
    scr_process_exit(0);
    return scr_cl_undefined();
  }
  if (signal->kind == SCR_DYN_STR) {
    scr_child_kill(w->child, signal->v.str);
  } else if (signal->kind == SCR_DYN_NUM) {
    scr_child_kill_num(w->child, signal->v.num);
  } else if (signal->kind == SCR_DYN_UNDEF || signal->kind == SCR_DYN_NULL) {
    ScrStr *term = scr_str_new("SIGTERM", 7);
    scr_child_kill(w->child, term);
    scr_str_release(term);
  } else {
    scr_dyn_arg_type_fail("signal", "of type string or number", signal);
    return NULL;
  }
  return scr_cl_undefined();
}

static ScrDyn *scr_cl_worker_invoke(void *h, ScrDyn *self, const char *method,
                                    ScrDyn *const *args, size_t argc, const char *what) {
  ScrClusterWorker *w = h;
  const ScrDyn *a0 = argc > 0 ? args[0] : scr_dyn_undefined();
  const ScrDyn *a1 = argc > 1 ? args[1] : scr_dyn_undefined();
  if (!strcmp(method, "send")) {
    if (a0->kind == SCR_DYN_UNDEF) {
      const char msg[] = "The \"message\" argument must be specified";
      scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_MISSING_ARGS");
      return NULL;
    }
    ScrDyn *callback = NULL;
    for (size_t i = argc; i > 1; i--) {
      if (args[i - 1]->kind == SCR_DYN_FUNC) {
        callback = args[i - 1];
        break;
      }
    }
    return scr_dyn_new_bool(scr_cl_worker_send(w, (ScrDyn *)a0, callback));
  }
  if (!strcmp(method, "disconnect")) return scr_cl_worker_disconnect_method(w);
  if (!strcmp(method, "kill")) return scr_cl_worker_kill_method(w, (ScrDyn *)a0);
  if (!strcmp(method, "isConnected")) return scr_dyn_new_bool(scr_cl_worker_connected(w));
  if (!strcmp(method, "isDead")) return scr_dyn_new_bool(!w->self && w->exited);
  if (!strcmp(method, "ref") || !strcmp(method, "unref")) {
    if (!w->self) {
      if (method[0] == 'r') scr_child_ref(w->child);
      else scr_child_unref(w->child);
    }
    return scr_dyn_retain(self);
  }
  bool once = !strcmp(method, "once");
  bool remove = !strcmp(method, "removeListener") || !strcmp(method, "off");
  if (!strcmp(method, "on") || !strcmp(method, "addListener") || once || remove) {
    if (a1->kind != SCR_DYN_FUNC) {
      scr_dyn_arg_type_fail("listener", "of type function", a1);
      return NULL;
    }
    if (a0->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail("event", "of type string", a0);
      return NULL;
    }
    if (remove) {
      ScrClListener *snapshot = malloc((w->ls.n ? w->ls.n : 1) * sizeof *snapshot);
      if (!snapshot) scr_trap("out of memory");
      size_t count = scr_cl_ls_take(&w->ls, a0->v.str, a1, snapshot);
      scr_cl_taken_release(snapshot, count);
      free(snapshot);
    } else {
      scr_cl_ls_add(&w->ls, a0->v.str, (ScrDyn *)a1, once);
    }
    return scr_dyn_retain(self);
  }
  if (!strcmp(method, "emit") && a0->kind == SCR_DYN_STR) {
    scr_cl_ls_emit(&w->ls, a0->v.str->data, argc > 1 ? args + 1 : NULL, argc - 1);
    return scr_dyn_new_bool(true);
  }
  char msg[160];
  int n = snprintf(msg, sizeof msg, "%s is not a function", what);
  scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)n);
  return NULL;
}

static ScrDyn *scr_cl_worker_get(void *h, const char *key, size_t key_len) {
  ScrClusterWorker *w = h;
  if (key_len == 2 && !memcmp(key, "id", 2)) return scr_dyn_new_num(w->id);
  if (key_len == 7 && !memcmp(key, "process", 7)) return scr_cl_worker_process_value(w);
  if (key_len == 5 && !memcmp(key, "state", 5))
    return scr_dyn_new_str(scr_str_new(w->state, strlen(w->state)));
  if (key_len == 21 && !memcmp(key, "exitedAfterDisconnect", 21)) {
    if (w->exited_after_disconnect) return scr_dyn_new_bool(true);
    return scr_cl_undefined();
  }
  return NULL;
}

static bool scr_cl_worker_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  (void)h;
  (void)key;
  (void)key_len;
  (void)value;
  return false;
}

static const ScrDynHandleOps scr_cl_worker_ops = {
  .cls = "Worker",
  .retain = &scr_clw_retain_v,
  .release = &scr_clw_release_v,
  .invoke = &scr_cl_worker_invoke,
  .get = &scr_cl_worker_get,
  .set = &scr_cl_worker_set,
};

/* ── the child's raw events ────────────────────────────────────────── */

static ScrClusterWorker *scr_cl_box_of(ScrClosure *cb) {
  /* scr_box_get_ref answers a retained pointer (the dgram unit's box
   * convention): the thunk owns the reference it returns. */
  return (ScrClusterWorker *)scr_box_get_ref(cb->caps[0]);
}

/* A bare closure carrying the worker: the box holds a payload, so the
 * listener keeps the worker alive on its own. */
static ScrClosure *scr_cl_closure(ScrClusterWorker *w, void *fn) {
  ScrClosure *cb = scr_closure_new(fn, 1);
  cb->caps[0] = scr_box_new_obj(&scr_clw_retain_v, &scr_clw_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_clw_retain(w));
  return cb;
}

static void scr_cl_worker_message(ScrClusterWorker *w, ScrDyn *message) {
  ScrDyn *self = scr_cl_worker_handle(w);
  ScrDyn *handle = scr_cl_undefined();
  ScrDyn *cluster_args[] = {self, message, handle};
  scr_cl_ls_emit(&scr_cl_events, "message", cluster_args, 3);
  scr_dyn_release(self);
  ScrDyn *worker_args[] = {message, handle};
  scr_cl_ls_emit(&w->ls, "message", worker_args, 2);
  scr_dyn_release(handle);
}

static void scr_cl_child_message_thunk(ScrClosure *cb, ScrDyn *message) {
  ScrClusterWorker *w = scr_cl_box_of(cb);
  if (w == NULL) return;
  scr_cl_worker_message(w, message);
  scr_clw_release(w);
}

static void scr_cl_child_exit_thunk(ScrClosure *cb, bool has_code, double code,
                                    const char *signal_name) {
  ScrClusterWorker *w = scr_cl_box_of(cb);
  if (w == NULL) return;
  /* The process has exited: it no longer lists as a worker even when the
   * channel's EOF has not been read yet (the exit can be observed first). */
  if (!w->self) scr_cl_maybe_remove(w);
  w->exited = true;
  w->state = "dead";
  ScrDyn *code_arg = has_code ? scr_dyn_new_num(code) : scr_dyn_new_null();
  ScrDyn *signal_arg = scr_dyn_new_null();
  if (signal_name != NULL) {
    ScrStr *text = scr_str_new(signal_name, strlen(signal_name));
    scr_dyn_release(signal_arg);
    signal_arg = scr_dyn_new_str(text);
    scr_str_release(text);
  }
  ScrDyn *worker_args[] = {code_arg, signal_arg};
  scr_cl_ls_emit(&w->ls, "exit", worker_args, 2);
  ScrDyn *self = scr_cl_worker_handle(w);
  ScrDyn *cluster_args[] = {self, code_arg, signal_arg};
  scr_cl_ls_emit(&scr_cl_events, "exit", cluster_args, 3);
  scr_dyn_release(self);
  scr_dyn_release(code_arg);
  scr_dyn_release(signal_arg);
  scr_cl_disconnect_advance(w);
  /* The worker is dead: its listeners are moot, and dropping them here
   * breaks the cycles they may form (a listener that captured its worker)
   * so the worker can be reclaimed instead of living until exit. */
  scr_cl_ls_clear(&w->ls);
  scr_cl_unlink(w);
  scr_cl_forget_worker(w);
  scr_cl_defer_release(w);
}

static void scr_cl_child_disconnect_thunk(ScrClosure *cb) {
  ScrClusterWorker *w = scr_cl_box_of(cb);
  if (w == NULL) return;
  w->state = "disconnected";
  scr_cl_ls_emit(&w->ls, "disconnect", NULL, 0);
  ScrDyn *self = scr_cl_worker_handle(w);
  ScrDyn *args[] = {self};
  scr_cl_ls_emit(&scr_cl_events, "disconnect", args, 1);
  scr_dyn_release(self);
  scr_cl_disconnect_advance(w);
  scr_cl_defer_release(w);
}

static void scr_cl_child_error_thunk(ScrClosure *cb, ScrStr *msg) {
  (void)cb;
  (void)msg;
}

/* A cluster worker's channel starts armed: the raw listeners below hold
 * the reader and the exit/disconnect observation. */
static void scr_cl_arm_child(ScrClusterWorker *w) {
  scr_child_ipc_on_message(w->child, scr_cl_closure(w, (void *)&scr_cl_child_message_thunk),
                           scr_cl_child_message_thunk, false);
  scr_child_on_exit(w->child, scr_cl_closure(w, (void *)&scr_cl_child_exit_thunk),
                    scr_cl_child_exit_thunk);
  scr_child_ipc_on_disconnect(w->child, scr_cl_closure(w, (void *)&scr_cl_child_disconnect_thunk),
                              false);
  scr_child_on_error(w->child, scr_cl_closure(w, (void *)&scr_cl_child_error_thunk),
                     scr_cl_child_error_thunk);
}

/* ── fork ──────────────────────────────────────────────────────────── */

static void scr_cl_fire_forks(void) {
  while (scr_cl_fork_pending_n > 0 && !scr_exc_pending()) {
    ScrClusterWorker *w = scr_cl_fork_pending[0];
    memmove(scr_cl_fork_pending, scr_cl_fork_pending + 1,
            (scr_cl_fork_pending_n - 1) * sizeof *scr_cl_fork_pending);
    scr_cl_fork_pending_n--;
    ScrDyn *self = scr_cl_worker_handle(w);
    ScrDyn *args[] = {self};
    scr_cl_ls_emit(&scr_cl_events, "fork", args, 1);
    scr_dyn_release(self);
    scr_clw_release(w);
  }
}

static void scr_cl_queue_fork(ScrClusterWorker *w) {
  ScrClusterWorker **items =
      realloc(scr_cl_fork_pending, (scr_cl_fork_pending_n + 1) * sizeof *items);
  if (!items) scr_trap("out of memory");
  scr_cl_fork_pending = items;
  items[scr_cl_fork_pending_n++] = scr_clw_retain(w);
  if (scr_cl_fork_pending_n == 1) scr_next_tick_raw(&scr_cl_fire_forks);
}

ScrDyn *scr_cluster_fork(const ScrDyn *env) {
  if (!scr_cl_initialized) scr_cluster_init();
  if (scr_cl_worker_mode) {
    const char msg[] = "Cannot initialize cluster in a worker process";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_WORKER_INIT_FAILED");
    return NULL;
  }
  scr_cl_setup_impl(NULL);
#if !defined(_WIN32) && !defined(__wasi__)
  /* A worker's credentials would have to be dropped before exec; this
   * runtime re-executes the artifact and would drop them in the child,
   * which runs the dynamic loader (and any loader constructors) with the
   * primary's identity first. Refuse the launch until a pre-exec drop
   * exists, rather than treat uid/gid as enforced. Windows ignores them,
   * as Node does. */
  if (scr_cl_settings != NULL && scr_cl_settings->kind == SCR_DYN_OBJ) {
    ScrDyn *u = scr_dyn_obj_get(scr_cl_settings, "uid", 3); /* borrowed */
    ScrDyn *g = scr_dyn_obj_get(scr_cl_settings, "gid", 3); /* borrowed */
    bool credentialed = (u != NULL && u->kind != SCR_DYN_UNDEF) ||
                        (g != NULL && g->kind != SCR_DYN_UNDEF);
    if (credentialed) {
      const char msg[] =
          "cluster.fork with uid/gid is not supported: a worker's credentials "
          "cannot be dropped before exec on this runtime";
      scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
      return NULL;
    }
  }
#endif

  double id = ++scr_cl_next_id;
  ScrStr **keys = NULL, **values = NULL;
  size_t count = 0;
  if (!scr_cl_env_entries(env, &keys, &values, &count)) return NULL;

  /* NODE_UNIQUE_ID goes last, over the merged map (Node's own merge). */
  ScrStr *id_key = scr_str_new("NODE_UNIQUE_ID", 14);
  char id_text[32];
  int id_len = snprintf(id_text, sizeof id_text, "%.0f", id);
  ScrStr *id_value = scr_str_new(id_text, (size_t)id_len);
  size_t total = count + 1;
  ScrStr **all_keys = calloc(total, sizeof *all_keys);
  ScrStr **all_values = calloc(total, sizeof *all_values);
  if (!all_keys || !all_values) scr_trap("out of memory");
  for (size_t i = 0; i < count; i++) {
    all_keys[i] = keys[i];
    all_values[i] = values[i];
  }
  all_keys[count] = id_key;
  all_values[count] = id_value;

  ScrArr *base = scr_env_pairs(); /* +1 */
  ScrArr *pairs = scr_cl_env_merge(base, all_keys, all_values, total);
  scr_arr_release(base);

  ScrArr *args = scr_cl_worker_args();
  ScrStr *cwd = scr_str_new("", 0);
  bool silent = false;
  if (scr_cl_settings != NULL && scr_cl_settings->kind == SCR_DYN_OBJ) {
    ScrDyn *s = scr_dyn_obj_get(scr_cl_settings, "silent", 6); /* borrowed */
    if (s != NULL && s->kind == SCR_DYN_BOOL) silent = s->v.b;
    ScrDyn *c = scr_dyn_obj_get(scr_cl_settings, "cwd", 3); /* borrowed */
    if (c != NULL && c->kind == SCR_DYN_STR) {
      scr_str_release(cwd);
      cwd = scr_str_retain(c->v.str);
    }
  }
  double mode = silent ? 3 : 1;
  ScrChild *child = scr_fork(-1, args, mode, mode, mode, true, pairs, cwd);

  scr_str_release(cwd);
  scr_arr_release(args);
  scr_arr_release(pairs);
  scr_str_release(id_key);
  scr_str_release(id_value);
  free(all_keys);
  free(all_values);
  scr_cl_env_entries_free(keys, values, count);

  ScrClusterWorker *w = calloc(1, sizeof *w);
  if (!w) scr_trap("out of memory");
  w->rc = 0; /* the registry/queue/payload references below own it */
  w->id = id;
  w->child = child;
  w->state = "none";
  scr_cl_arm_child(w);
  scr_cl_register(w);
  w->all_next = scr_cl_all_workers;
  scr_cl_all_workers = scr_clw_retain(w);
  scr_cl_queue_fork(w);
  return scr_cl_worker_handle(w);
}

/* ── disconnect ────────────────────────────────────────────────────── */

/* Node's cluster.disconnect() removes each worker from the list while it
 * disconnects them and runs the callback when the last workers list is
 * gone. The removals are synchronous; the callback follows the workers'
 * own disconnect events (Node's intercom fires again from that handler),
 * so this waits for each disconnected worker's 'disconnect' or 'exit'. */
static void scr_cl_kick_disconnect(void) {
  size_t waiting = 0;
  ScrClusterWorker *w = scr_cl_workers;
  while (w != NULL && !scr_exc_pending()) {
    ScrClusterWorker *next = w->next;
    if (!w->self && scr_child_ipc_connected(w->child)) {
      w->exited_after_disconnect = true;
      scr_cl_send_act(w->child, "disconnect");
      if (scr_cl_disconnect_cb != NULL) {
        w->disconnect_awaited = true;
        waiting++;
      }
      scr_cl_maybe_remove(w);
    }
    w = next;
  }
  scr_cl_disconnect_waiting = waiting;
  if (waiting == 0) scr_cl_finish_disconnect();
}

void scr_cluster_disconnect(const ScrDyn *callback) {
  if (!scr_cl_initialized) scr_cluster_init();
  if (scr_cl_worker_mode) {
    const char msg[] = "cluster.disconnect is not a function";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return;
  }
  if (callback != NULL && callback->kind == SCR_DYN_FUNC) {
    scr_dyn_release(scr_cl_disconnect_cb);
    scr_cl_disconnect_cb = scr_dyn_retain((ScrDyn *)callback);
  }
  scr_cl_disconnect_pending = true;
  scr_next_tick_raw(&scr_cl_kick_disconnect);
}

/* ── the cluster object's surface ──────────────────────────────────── */

void scr_cluster_on(ScrStr *event, ScrDyn *listener, bool once) {
  if (!scr_cl_initialized) scr_cluster_init();
  if (listener == NULL || listener->kind != SCR_DYN_FUNC) {
    scr_dyn_arg_type_fail("listener", "of type function", listener);
    return;
  }
  /* The listener is the call site's borrowed argument; the list keeps its
   * own reference (scr_cl_ls_add). */
  scr_cl_ls_add(&scr_cl_events, event, listener, once);
}

void scr_cluster_off(const ScrStr *event, const ScrDyn *listener) {
  if (listener == NULL || listener->kind != SCR_DYN_FUNC) return;
  ScrClListener *snapshot = malloc((scr_cl_events.n ? scr_cl_events.n : 1) * sizeof *snapshot);
  if (!snapshot) scr_trap("out of memory");
  size_t count = scr_cl_ls_take(&scr_cl_events, event, listener, snapshot);
  scr_cl_taken_release(snapshot, count);
  free(snapshot);
}

ScrDyn *scr_cluster_settings(void) {
  if (!scr_cl_initialized) scr_cluster_init();
  /* Node starts with the empty object and only setupPrimary/fork fills it. */
  if (scr_cl_settings == NULL) scr_cl_settings = scr_dyn_new_obj();
  return scr_dyn_retain(scr_cl_settings);
}

ScrDyn *scr_cluster_workers(void) {
  if (!scr_cl_initialized) scr_cluster_init();
  ScrDyn *out = scr_dyn_new_obj();
  for (ScrClusterWorker *w = scr_cl_workers; w != NULL; w = w->next) {
    if (w->removed) continue;
    char key[32];
    int n = snprintf(key, sizeof key, "%.0f", w->id);
    if (n <= 0) continue;
    scr_dyn_obj_set(out, key, (size_t)n, scr_cl_worker_handle(w));
  }
  return out;
}

ScrDyn *scr_cluster_worker_value(void) {
  if (!scr_cl_initialized) scr_cluster_init();
  if (!scr_cl_worker_mode || scr_cl_self == NULL) return scr_cl_undefined();
  return scr_cl_worker_handle(scr_cl_self);
}

/* ── the worker process's start ────────────────────────────────────── */

/* The worker's process-channel listener: Node's Worker wraps the process
 * and forwards its 'message' event, so cluster.worker.on('message', ...)
 * sees every message the primary sends (before the program's
 * process.on('message') listeners, which registered later). Cluster
 * protocol messages never reach here: the child unit routes those to the
 * cluster hook. */
static void scr_cl_self_message(ScrClosure *cb, ScrDyn *message) {
  (void)cb;
  if (scr_cl_self == NULL) return;
  ScrDyn *handle = scr_cl_undefined();
  ScrDyn *args[] = {message, handle};
  scr_cl_ls_emit(&scr_cl_self->ls, "message", args, 2);
  scr_dyn_release(handle);
}

static void scr_cl_self_disconnect(ScrClosure *cb) {
  (void)cb;
  if (scr_cl_self == NULL) return;
  scr_cl_ls_emit(&scr_cl_self->ls, "disconnect", NULL, 0);
  if (!scr_cl_self->exited_after_disconnect) scr_process_exit(0);
}

void scr_cluster_init(void) {
  if (scr_cl_initialized) return;
  scr_cl_initialized = true;
  scr_atexit(&scr_cl_levels_cleanup);
  scr_dyn_handle_install(SCR_DYNH_CLUSTER_WORKER, &scr_cl_worker_ops);
  ScrStr *name = scr_str_new("NODE_UNIQUE_ID", 14);
  ScrStr *value = scr_env_get(name); /* +1 or NULL */
  scr_str_release(name);
  if (value != NULL) {
    scr_cl_worker_mode = true;
    scr_cl_self_id = scr_cl_parse_id(value);
    scr_str_release(value);
    /* Node deletes the variable right after its worker bootstrap. */
    ScrStr *unset = scr_str_new("NODE_UNIQUE_ID", 14);
    scr_env_unset(unset);
    scr_str_release(unset);

    ScrClusterWorker *w = calloc(1, sizeof *w);
    if (!w) scr_trap("out of memory");
    w->rc = 1; /* scr_cl_self owns it; cleanup releases it */
    w->id = scr_cl_self_id;
    w->self = true;
    w->online = true;
    w->state = "online";
    scr_cl_self = w;
    ScrClosure *msg = scr_closure_new((void *)&scr_cl_self_message, 1);
    scr_process_ipc_on_message(msg, scr_cl_self_message, false);
    ScrClosure *dc = scr_closure_new((void *)&scr_cl_self_disconnect, 1);
    scr_process_ipc_on_disconnect(dc, false);
    /* The primary waits for the 'online' act before it marks the worker
     * online; Node's worker sends it from _setupWorker. */
    if (scr_process_ipc_connected()) {
      static const char online[] = "{\"cmd\":\"NODE_CLUSTER\",\"act\":\"online\"}";
      ScrStr *act = scr_str_new(online, sizeof online - 1);
      scr_process_ipc_send(act);
      scr_str_release(act);
    }
  }
  scr_child_set_cluster_hooks(&scr_cluster_message_is_internal, &scr_cluster_message_dispatch);
}

bool scr_cluster_is_worker(void) {
  if (!scr_cl_initialized) scr_cluster_init();
  return scr_cl_worker_mode;
}

bool scr_cluster_is_primary(void) { return !scr_cluster_is_worker(); }

double scr_cluster_scheduling_policy(void) {
  ScrStr *name = scr_str_new("NODE_CLUSTER_SCHED_POLICY", 25);
  ScrStr *value = scr_env_get(name); /* +1 */
  scr_str_release(name);
  double policy = 2; /* SCHED_RR */
  if (value != NULL) {
    if (scr_cl_str_is(value, "none")) policy = 1;
    else if (scr_cl_str_is(value, "rr")) policy = 2;
    scr_str_release(value);
    return policy;
  }
#ifdef _WIN32
  return 1; /* SCHED_NONE: round-robin does not pay off under IOCP */
#else
  return policy;
#endif
}

static void scr_cl_levels_cleanup(void) {
  scr_cl_ls_clear(&scr_cl_events);
  scr_dyn_release(scr_cl_settings);
  scr_cl_settings = NULL;
  scr_dyn_release(scr_cl_disconnect_cb);
  scr_cl_disconnect_cb = NULL;
  for (size_t i = 0; i < scr_cl_fork_pending_n; i++) scr_clw_release(scr_cl_fork_pending[i]);
  free(scr_cl_fork_pending);
  scr_cl_fork_pending = NULL;
  scr_cl_fork_pending_n = 0;
  for (size_t i = 0; i < scr_cl_send_cbs_n; i++) scr_dyn_release(scr_cl_send_cbs[i].cb);
  free(scr_cl_send_cbs);
  scr_cl_send_cbs = NULL;
  scr_cl_send_cbs_n = 0;
  for (size_t i = 0; i < scr_cl_deferred_n; i++) scr_clw_release(scr_cl_deferred[i]);
  free(scr_cl_deferred);
  scr_cl_deferred = NULL;
  scr_cl_deferred_n = 0;
  scr_cl_deferred_scheduled = false;
  for (ScrClusterWorker *w = scr_cl_all_workers; w != NULL; w = w->all_next) {
    scr_cl_ls_clear(&w->ls);
  }
  while (scr_cl_all_workers != NULL) {
    ScrClusterWorker *w = scr_cl_all_workers;
    scr_cl_all_workers = w->all_next;
    w->all_next = NULL;
    scr_clw_release(w);
  }
  while (scr_cl_workers != NULL) {
    ScrClusterWorker *w = scr_cl_workers;
    scr_cl_workers = w->next;
    w->next = NULL;
    w->removed = true;
    scr_cl_ls_clear(&w->ls);
    scr_clw_release(w);
  }
  if (scr_cl_self != NULL) {
    ScrClusterWorker *w = scr_cl_self;
    scr_cl_self = NULL;
    scr_cl_ls_clear(&w->ls);
    w->rc = 1;
    scr_clw_release(w);
  }
  for (size_t i = 0; i < scr_cl_setups_n; i++) scr_dyn_release(scr_cl_setups[i].settings);
  free(scr_cl_setups);
  scr_cl_setups = NULL;
  scr_cl_setups_n = 0;
  scr_cl_initialized = false;
}
