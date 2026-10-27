/* node:dgram sockets as checked-dynamic values (SCR_DYNH_DGRAM_SOCKET):
 * the handle ops, the untyped listener mirror and the method values. A
 * unit of its own so programs that never box a socket link none of it
 * (native-toolchain gating: the dgramDyn runtime feature). */
#include "scr_platform.h"
#include "scr_runtime.h"
#include "scr_dgram_private.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void scr_dgram_dyn_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

/* The native lists' firing snapshot (scr_dgram.c's discipline): entries
 * retained; once entries leave the live list before their callbacks run. */
static size_t scr_dgram_dyn_snapshot(ScrDgramLs *l, ScrDgramL **out) {
  size_t n = l->n;
  if (n == 0) {
    *out = NULL;
    return 0;
  }
  ScrDgramL *snap = malloc(n * sizeof *snap);
  if (!snap) scr_dgram_dyn_oom();
  for (size_t i = 0; i < n; i++) {
    snap[i] = l->ls[i];
    scr_closure_retain(snap[i].cb);
  }
  size_t w = 0;
  for (size_t i = 0; i < l->n; i++) {
    if (l->ls[i].once) {
      scr_closure_release(l->ls[i].cb);
    } else {
      l->ls[w++] = l->ls[i];
    }
  }
  l->n = w;
  *out = snap;
  return n;
}

static void scr_dgram_dyn_ls_drop(ScrDgramLs *l) {
  for (size_t i = 0; i < l->n; i++) scr_closure_release(l->ls[i].cb);
  free(l->ls);
  l->ls = NULL;
  l->n = l->cap = 0;
}

/* ── checked-dynamic dgram sockets (SCR_DYNH_DGRAM_SOCKET) ─────────────
 * A socket crosses into untyped code (`socket.on.bind(socket)` in a
 * package, an untyped binding) as a handle box over a refcounted entry
 * that holds the socket and the untyped listeners, so the boxes of one
 * socket share their identity and listener state. This unit links only
 * when a program converts a socket to or from an untyped value.
 *
 * Listeners. An untyped listener lives in the entry's per-event list
 * and as a proxy closure in the socket's own native list, so runtime
 * events reach it in registration order beside typed listeners. The
 * entry's list outlives the socket's settlement ('close' drops the
 * native lists to break cycles): Node keeps listeners after close, and
 * an `emit('error', e)` afterwards still reaches them. removeListener
 * removes the most recent registration of the function, as Node does.
 *
 * emit(event, ...args) calls each listener with the given values; a
 * typed 'error' listener receives the emitted Error (the payload rides
 * scr_event_error_payload), and a typed 'message' listener cannot take
 * untyped values, so that emit throws the not-supported Error. An 'error'
 * nobody listens to throws the emitted value, as EventEmitter does. */

enum {
  SCR_DGRAM_EV_MESSAGE,
  SCR_DGRAM_EV_ERROR,
  SCR_DGRAM_EV_CLOSE,
  SCR_DGRAM_EV_LISTENING,
  SCR_DGRAM_EV_CONNECT,
  SCR_DGRAM_EV_COUNT
};

static const char *const scr_dgram_ev_names[SCR_DGRAM_EV_COUNT] = {
  "message", "error", "close", "listening", "connect",
};

typedef struct {
  ScrDyn *fn; /* +1 */
  bool once;
  double id;  /* the proxy closure's key */
} ScrDgramDynL;

typedef struct ScrDgramDyn {
  size_t rc;
  ScrDgramSocket *s; /* +1 */
  struct {
    ScrDgramDynL *ls;
    size_t n, cap;
  } ev[SCR_DGRAM_EV_COUNT];
  bool cleaned; /* exit cleanup has released its listeners */
  struct ScrDgramDyn *next; /* the live-entry table (weak) */
} ScrDgramDyn;

static SCR_TL ScrDgramDyn *scr_dgram_dyns = NULL;
static SCR_TL double scr_dgram_dyn_next_id = 0;
static SCR_TL ScrDyn *scr_dgram_dyn_methods = NULL; /* method name -> function value */

static int scr_dgram_ev_of(const ScrDyn *name) {
  if (name->kind != SCR_DYN_STR) return -1;
  for (int i = 0; i < SCR_DGRAM_EV_COUNT; i++) {
    size_t n = strlen(scr_dgram_ev_names[i]);
    if (name->v.str->len == n && memcmp(name->v.str->data, scr_dgram_ev_names[i], n) == 0) return i;
  }
  return -1;
}

static void scr_dgram_dyn_clear(ScrDgramDyn *e) {
  for (int i = 0; i < SCR_DGRAM_EV_COUNT; i++) {
    for (size_t j = 0; j < e->ev[i].n; j++) scr_dyn_release(e->ev[i].ls[j].fn);
    free(e->ev[i].ls);
    e->ev[i].ls = NULL;
    e->ev[i].n = e->ev[i].cap = 0;
  }
}

static void *scr_dgram_dyn_retain_v(void *p) {
  ScrDgramDyn *e = (ScrDgramDyn *)p;
  e->rc++;
  return e;
}

static void scr_dgram_dyn_release_v(void *p) {
  ScrDgramDyn *e = (ScrDgramDyn *)p;
  if (--e->rc != 0) return;
  ScrDgramDyn **link = &scr_dgram_dyns;
  while (*link && *link != e) link = &(*link)->next;
  if (*link) *link = e->next;
  scr_dgram_dyn_clear(e);
  scr_dgram_release(e->s);
  free(e);
}

/* The entry's listener at the proxy key, or -1 (removed meanwhile). */
static long scr_dgram_dyn_find(ScrDgramDyn *e, int ev, double id) {
  for (size_t i = 0; i < e->ev[ev].n; i++) {
    if (e->ev[ev].ls[i].id == id) return (long)i;
  }
  return -1;
}

/* Takes the listener out of the entry's list; its function moves to
 * the caller (+1). */
static ScrDyn *scr_dgram_dyn_take(ScrDgramDyn *e, int ev, size_t i) {
  ScrDyn *fn = e->ev[ev].ls[i].fn;
  memmove(&e->ev[ev].ls[i], &e->ev[ev].ls[i + 1], (e->ev[ev].n - i - 1) * sizeof *e->ev[ev].ls);
  e->ev[ev].n--;
  return fn;
}

/* Calls an untyped listener with the socket as `this`, as EventEmitter
 * does. */
static void scr_dgram_dyn_call(ScrDgramDyn *e, const ScrDyn *fn, ScrDyn *const *args,
                               size_t argc) {
  scr_dyn_this_push(e, SCR_DYNH_DGRAM_SOCKET);
  ScrDyn *r = scr_dyn_call(fn, args, argc, "listener");
  scr_dyn_this_pop();
  scr_dyn_release(r);
}

/* A proxy closure fired from the native list: its entry, key and
 * listener. A once listener leaves the entry's list first. The proxy
 * holds its own listener, so a listener that an earlier listener of the
 * same emission removed still runs, as EventEmitter's emit runs its copy
 * of the listener list. */
static void scr_dgram_dyn_fire(ScrClosure *cb, int ev, ScrDyn *const *args, size_t argc) {
  ScrDgramDyn *e = (ScrDgramDyn *)scr_box_get_ref(cb->caps[0]);
  double id = scr_box_get_f64(cb->caps[1]);
  long i = scr_dgram_dyn_find(e, ev, id);
  if (i >= 0 && e->ev[ev].ls[i].once) scr_dyn_release(scr_dgram_dyn_take(e, ev, (size_t)i));
  ScrDyn *fn = (ScrDyn *)scr_box_get_ref(cb->caps[2]);
  scr_dgram_dyn_call(e, fn, args, argc);
  scr_dyn_release(fn);
  scr_dgram_dyn_release_v(e);
}

static void scr_dgram_dyn_fire_message(ScrClosure *cb, ScrBytes *msg, ScrStr *addr,
                                       ScrStr *family, double port, double size) {
  ScrDyn *rinfo = scr_dyn_new_obj();
  scr_dyn_obj_set(rinfo, "address", 7, scr_dyn_new_str(addr));
  scr_dyn_obj_set(rinfo, "family", 6, scr_dyn_new_str(family));
  scr_dyn_obj_set(rinfo, "port", 4, scr_dyn_new_num(port));
  scr_dyn_obj_set(rinfo, "size", 4, scr_dyn_new_num(size));
  ScrDyn *args[2] = { scr_dyn_new_bytes(msg), rinfo };
  scr_dgram_dyn_fire(cb, SCR_DGRAM_EV_MESSAGE, args, 2);
  scr_dyn_release(args[0]);
  scr_dyn_release(rinfo);
}

/* A runtime 'error' (msg) or an emitted one (scr_event_error_payload). */
static void scr_dgram_dyn_fire_error(ScrClosure *cb, ScrStr *msg) {
  ScrDyn *err;
  if (scr_event_error_payload != NULL) {
    err = scr_dyn_from_error(scr_event_error_payload);
  } else {
    ScrError *e = scr_error_new(0 /* Error */, msg);
    err = scr_dyn_from_error(e);
    scr_error_release(e);
  }
  ScrDyn *args[1] = { err };
  scr_dgram_dyn_fire(cb, SCR_DGRAM_EV_ERROR, args, 1);
  scr_dyn_release(err);
}

static void scr_dgram_dyn_fire_close(ScrClosure *cb) {
  scr_dgram_dyn_fire(cb, SCR_DGRAM_EV_CLOSE, NULL, 0);
}
static void scr_dgram_dyn_fire_listening(ScrClosure *cb) {
  scr_dgram_dyn_fire(cb, SCR_DGRAM_EV_LISTENING, NULL, 0);
}
static void scr_dgram_dyn_fire_connect(ScrClosure *cb) {
  scr_dgram_dyn_fire(cb, SCR_DGRAM_EV_CONNECT, NULL, 0);
}

static ScrDgramLs *scr_dgram_native_list(ScrDgramSocket *s, int ev) {
  switch (ev) {
  case SCR_DGRAM_EV_MESSAGE: return &s->msg_ls;
  case SCR_DGRAM_EV_ERROR: return &s->err_ls;
  case SCR_DGRAM_EV_CLOSE: return &s->close_ls;
  case SCR_DGRAM_EV_LISTENING: return &s->listening_ls;
  default: return &s->conn_ls;
  }
}

/* Whether a native list entry is an untyped listener's proxy. */
static bool scr_dgram_is_proxy(const ScrDgramL *l) {
  void *fn = l->cb->fn;
  return fn == (void *)&scr_dgram_dyn_fire_message || fn == (void *)&scr_dgram_dyn_fire_error ||
         fn == (void *)&scr_dgram_dyn_fire_close || fn == (void *)&scr_dgram_dyn_fire_listening ||
         fn == (void *)&scr_dgram_dyn_fire_connect;
}

static void scr_dgram_dyn_on(ScrDgramDyn *e, int ev, const ScrDyn *fn, bool once) {
  if (e->ev[ev].n == e->ev[ev].cap) {
    e->ev[ev].cap = e->ev[ev].cap ? e->ev[ev].cap * 2 : 2;
    e->ev[ev].ls = realloc(e->ev[ev].ls, e->ev[ev].cap * sizeof *e->ev[ev].ls);
    if (!e->ev[ev].ls) scr_dgram_dyn_oom();
  }
  double id = ++scr_dgram_dyn_next_id;
  e->ev[ev].ls[e->ev[ev].n].fn = scr_dyn_retain((ScrDyn *)fn);
  e->ev[ev].ls[e->ev[ev].n].once = once;
  e->ev[ev].ls[e->ev[ev].n].id = id;
  e->ev[ev].n++;
  ScrDgramSocket *s = e->s;
  if (s->close_emitted) return; /* settled: nothing fires natively any more */
  static void *const fires[SCR_DGRAM_EV_COUNT] = {
    (void *)&scr_dgram_dyn_fire_message, (void *)&scr_dgram_dyn_fire_error,
    (void *)&scr_dgram_dyn_fire_close, (void *)&scr_dgram_dyn_fire_listening,
    (void *)&scr_dgram_dyn_fire_connect,
  };
  ScrClosure *proxy = scr_closure_new(fires[ev], 3);
  proxy->caps[0] = scr_box_new_obj(&scr_dgram_dyn_retain_v, &scr_dgram_dyn_release_v, NULL);
  scr_box_set_ref(proxy->caps[0], scr_dgram_dyn_retain_v(e));
  proxy->caps[1] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(proxy->caps[1], id);
  proxy->caps[2] = scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  scr_box_set_ref(proxy->caps[2], scr_dyn_retain((ScrDyn *)fn));
  switch (ev) {
  case SCR_DGRAM_EV_MESSAGE:
    scr_dgram_on_message(s, proxy, &scr_dgram_dyn_fire_message, once);
    break;
  case SCR_DGRAM_EV_ERROR:
    scr_dgram_on_error(s, proxy, &scr_dgram_dyn_fire_error, once);
    break;
  case SCR_DGRAM_EV_CLOSE:
    scr_dgram_on_close(s, proxy, once);
    break;
  case SCR_DGRAM_EV_LISTENING:
    scr_dgram_on_listening(s, proxy, once);
    break;
  default:
    scr_dgram_on_connect(s, proxy, once);
    break;
  }
}

/* removeListener(event, fn): the most recent registration of fn leaves
 * the entry's list and its proxy leaves the native one. */
static void scr_dgram_dyn_off(ScrDgramDyn *e, int ev, const ScrDyn *fn) {
  if (fn->kind != SCR_DYN_FUNC) return;
  for (size_t k = e->ev[ev].n; k-- > 0;) {
    const ScrDyn *have = e->ev[ev].ls[k].fn;
    if (have->kind != SCR_DYN_FUNC ||
        !scr_closure_identity_equal(have->v.fn.clo, fn->v.fn.clo)) {
      continue;
    }
    double id = e->ev[ev].ls[k].id;
    scr_dyn_release(scr_dgram_dyn_take(e, ev, k));
    ScrDgramLs *l = scr_dgram_native_list(e->s, ev);
    for (size_t i = 0; i < l->n; i++) {
      ScrClosure *c = l->ls[i].cb;
      if (!scr_dgram_is_proxy(&l->ls[i]) || scr_box_get_f64(c->caps[1]) != id) continue;
      scr_closure_release(c);
      memmove(&l->ls[i], &l->ls[i + 1], (l->n - i - 1) * sizeof *l->ls);
      l->n--;
      break;
    }
    if (ev == SCR_DGRAM_EV_MESSAGE) scr_dgram_rearm(e->s);
    return;
  }
}

/* Node's ERR_INVALID_ARG_TYPE listener gate (scr_dyn_check_listener's,
 * restated so this unit links without the handle support unit). */
static bool scr_dgram_dyn_listener_ok(const ScrDyn *cb) {
  if (cb->kind == SCR_DYN_FUNC) return true;
  scr_dyn_arg_type_fail("listener", "of type function", cb);
  return false;
}

static void scr_dgram_dynh_unsupported(const char *member, const char *why) {
  char msg[200];
  int n = snprintf(msg, sizeof msg,
                   "'dgram.Socket.prototype.%s' on a dynamic value is not supported yet%s%s", member,
                   why ? " — " : "", why ? why : "");
  scr_throw_error_msg(SCR_ERR_ERROR, msg, (size_t)n);
}

/* The message text a typed 'error' listener receives for an emitted
 * value: an Error's message, any other value's string. +1, or NULL with
 * the conversion's exception pending. */
static ScrStr *scr_dgram_emit_text(const ScrDyn *v) {
  ScrError *err = scr_errdyn_err_of(v);
  if (err != NULL) {
    ScrStr *m = scr_str_retain(err->message);
    scr_error_release(err);
    return m;
  }
  return scr_dyn_to_string(v, NULL);
}

/* emit(event, ...args): true when the event had listeners. */
static ScrDyn *scr_dgram_dyn_emit(ScrDgramDyn *e, ScrDyn *const *args, size_t argc) {
  const ScrDyn *name = argc > 0 ? args[0] : scr_dyn_undefined();
  ScrDyn *const *rest = argc > 1 ? args + 1 : NULL;
  size_t nrest = argc > 1 ? argc - 1 : 0;
  int ev = scr_dgram_ev_of(name);
  ScrDgramSocket *s = e->s;
  bool live = ev >= 0 && !s->close_emitted;
  size_t count = ev < 0 ? 0 : live ? scr_dgram_native_list(s, ev)->n : e->ev[ev].n;
  if (count == 0) {
    bool is_error = name->kind == SCR_DYN_STR && name->v.str->len == 5 &&
                    memcmp(name->v.str->data, "error", 5) == 0;
    if (!is_error) return scr_dyn_new_bool(false);
    const ScrDyn *er = nrest > 0 ? rest[0] : scr_dyn_undefined();
    ScrError *err = scr_errdyn_err_of(er);
    if (err != NULL) {
      scr_error_release(err);
      scr_dyn_throw(scr_dyn_retain((ScrDyn *)er));
      return NULL;
    }
    char shown[120], msg[200];
    int n = snprintf(msg, sizeof msg, "Unhandled error. (%s)",
                     scr_dyn_inspect_lite(er, shown, sizeof shown));
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)n, "ERR_UNHANDLED_ERROR");
    return NULL;
  }
  if (!live) {
    /* Settled: only the untyped listeners remain (the native lists were
     * dropped with the typed ones). */
    size_t n = e->ev[ev].n;
    ScrDgramDynL *snap = malloc(n * sizeof *snap);
    if (!snap) scr_dgram_dyn_oom();
    for (size_t i = 0; i < n; i++) {
      snap[i] = e->ev[ev].ls[i];
      scr_dyn_retain(snap[i].fn);
    }
    for (size_t i = e->ev[ev].n; i-- > 0;) {
      if (e->ev[ev].ls[i].once) scr_dyn_release(scr_dgram_dyn_take(e, ev, i));
    }
    for (size_t i = 0; i < n; i++) {
      if (!scr_exc_pending()) scr_dgram_dyn_call(e, snap[i].fn, rest, nrest);
      scr_dyn_release(snap[i].fn);
    }
    free(snap);
    return scr_exc_pending() ? NULL : scr_dyn_new_bool(true);
  }
  ScrDgramL *snap;
  size_t n = scr_dgram_dyn_snapshot(scr_dgram_native_list(s, ev), &snap);
  ScrError *payload = NULL;
  ScrStr *text = NULL;
  for (size_t i = 0; i < n; i++) {
    ScrClosure *cb = snap[i].cb;
    if (scr_exc_pending()) {
      scr_closure_release(cb);
      continue;
    }
    if (scr_dgram_is_proxy(&snap[i])) {
      scr_dgram_dyn_fire(cb, ev, rest, nrest);
    } else if (ev == SCR_DGRAM_EV_ERROR) {
      const ScrDyn *er = nrest > 0 ? rest[0] : scr_dyn_undefined();
      if (text == NULL) {
        payload = scr_errdyn_err_of(er);
        text = scr_dgram_emit_text(er);
      }
      if (text != NULL) {
        ScrError *saved = scr_event_error_payload;
        scr_event_error_payload = payload;
        ((ScrChildErrFn)snap[i].fn)(cb, text);
        scr_event_error_payload = saved;
      }
    } else if (ev == SCR_DGRAM_EV_MESSAGE) {
      scr_dgram_dynh_unsupported("emit", "a typed 'message' listener cannot receive untyped values");
    } else {
      ((void (*)(ScrClosure *))cb->fn)(cb);
    }
    scr_closure_release(cb);
  }
  free(snap);
  if (payload != NULL) scr_error_release(payload);
  scr_str_release(text);
  if (ev == SCR_DGRAM_EV_MESSAGE) scr_dgram_rearm(s);
  return scr_exc_pending() ? NULL : scr_dyn_new_bool(true);
}

/* address() as Node's { address, family, port } object. */
static ScrDyn *scr_dgram_dyn_address(ScrDgramSocket *s) {
  ScrStr *ip = scr_dgram_addr_ip(s);
  if (ip == NULL) return NULL;
  ScrDyn *o = scr_dyn_new_obj();
  scr_dyn_obj_set(o, "address", 7, scr_dyn_new_str(ip));
  scr_str_release(ip);
  ScrStr *family = scr_dgram_addr_family(s);
  scr_dyn_obj_set(o, "family", 6, scr_dyn_new_str(family));
  scr_str_release(family);
  scr_dyn_obj_set(o, "port", 4, scr_dyn_new_num(scr_dgram_addr_port(s)));
  return o;
}

/* bind/connect over positional untyped arguments: (port[, address][,
 * callback]); the options-object forms meet the not-supported Error. */
static bool scr_dgram_dyn_bind_args(const char *member, ScrDyn *const *args, size_t argc,
                                    double *port, ScrStr **host, const ScrDyn **cb) {
  size_t i = 0;
  *port = 0;
  *host = NULL;
  *cb = NULL;
  if (i < argc && args[i]->kind == SCR_DYN_NUM) *port = args[i++]->v.num;
  else if (i < argc && args[i]->kind == SCR_DYN_OBJ) {
    scr_dgram_dynh_unsupported(member, "the options-object form is not modeled");
    return false;
  } else if (i < argc && (args[i]->kind == SCR_DYN_UNDEF || args[i]->kind == SCR_DYN_NULL)) {
    i++;
  }
  if (i < argc && args[i]->kind == SCR_DYN_STR) *host = args[i++]->v.str;
  if (i < argc && args[i]->kind == SCR_DYN_FUNC) *cb = args[i++];
  if (i < argc && args[i]->kind != SCR_DYN_UNDEF) {
    scr_dgram_dynh_unsupported(member, "the modeled shape is (port[, address][, callback])");
    return false;
  }
  return true;
}

static ScrDyn *scr_dgram_dynh_invoke(void *h, ScrDyn *self, const char *method,
                                     ScrDyn *const *args, size_t argc, const char *what) {
  ScrDgramDyn *e = (ScrDgramDyn *)h;
  ScrDgramSocket *s = e->s;
  const ScrDyn *a0 = argc > 0 ? args[0] : scr_dyn_undefined();
  const ScrDyn *a1 = argc > 1 ? args[1] : scr_dyn_undefined();
  bool once = strcmp(method, "once") == 0;
  if (once || strcmp(method, "on") == 0 || strcmp(method, "addListener") == 0) {
    if (!scr_dgram_dyn_listener_ok(a1)) return NULL;
    int ev = scr_dgram_ev_of(a0);
    if (ev < 0) {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, "listening for '");
      if (a0->kind == SCR_DYN_STR) scr_jb_write(&b, a0->v.str->data, a0->v.str->len);
      scr_jb_puts(&b, "' on a dynamic dgram Socket is not supported yet");
      scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
      return NULL;
    }
    scr_dgram_dyn_on(e, ev, a1, once);
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "removeListener") == 0 || strcmp(method, "off") == 0) {
    if (!scr_dgram_dyn_listener_ok(a1)) return NULL;
    int ev = scr_dgram_ev_of(a0);
    if (ev >= 0) scr_dgram_dyn_off(e, ev, a1);
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "emit") == 0) return scr_dgram_dyn_emit(e, args, argc);
  if (strcmp(method, "send") == 0) {
    const ScrDyn *slot[6];
    for (size_t i = 0; i < 6; i++) slot[i] = i < argc ? args[i] : scr_dyn_undefined();
    scr_dgram_send_chk(s, slot[0], slot[1], slot[2], slot[3], slot[4], slot[5]);
    return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "close") == 0) {
    /* Node registers a function callback with on('close') before its
     * state check, so a second close still registers it, then throws. */
    if (a0->kind == SCR_DYN_FUNC) scr_dgram_dyn_on(e, SCR_DGRAM_EV_CLOSE, a0, false);
    scr_dgram_close(s, NULL);
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (strcmp(method, "bind") == 0 || strcmp(method, "connect") == 0) {
    double port;
    ScrStr *host;
    const ScrDyn *cb;
    if (!scr_dgram_dyn_bind_args(method, args, argc, &port, &host, &cb)) return NULL;
    bool bind = method[0] == 'b';
    ScrStr *h2 = host ? scr_str_retain(host) : bind ? scr_str_new("", 0) : scr_str_new("127.0.0.1", 9);
    /* the callback is once('listening') / once('connect'), registered
     * before the state checks as Node registers it */
    if (cb) scr_dgram_dyn_on(e, bind ? SCR_DGRAM_EV_LISTENING : SCR_DGRAM_EV_CONNECT, cb, true);
    if (bind) scr_dgram_bind(s, port, h2, NULL);
    else scr_dgram_connect(s, port, h2, NULL);
    scr_str_release(h2);
    if (scr_exc_pending()) return NULL;
    return bind ? scr_dyn_retain(self) : scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "disconnect") == 0) {
    scr_dgram_disconnect(s);
    return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "address") == 0) return scr_dgram_dyn_address(s);
  if (strcmp(method, "ref") == 0 || strcmp(method, "unref") == 0) {
    if (method[0] == 'r') scr_dgram_ref(s);
    else scr_dgram_unref(s);
    return scr_dyn_retain(self);
  }
  {
    static const char *const known[] = {
      "remoteAddress", "setBroadcast", "setTTL", "setMulticastTTL", "setMulticastLoopback",
      "setMulticastInterface", "addMembership", "dropMembership", "addSourceSpecificMembership",
      "dropSourceSpecificMembership", "getRecvBufferSize", "getSendBufferSize",
      "setRecvBufferSize", "setSendBufferSize", "getSendQueueSize", "getSendQueueCount",
      "prependListener", "prependOnceListener", "removeAllListeners", "listeners",
      "rawListeners", "listenerCount", "eventNames", "setMaxListeners", "getMaxListeners", NULL,
    };
    for (size_t i = 0; known[i]; i++) {
      if (strcmp(method, known[i]) == 0) {
        scr_dgram_dynh_unsupported(method, NULL);
        return NULL;
      }
    }
  }
  char msg[160];
  int n = snprintf(msg, sizeof msg, "%s is not a function", what);
  scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)n);
  return NULL;
}

/* A method read as a value (`socket.emit`, then `.bind(socket)`): one
 * function per name, which dispatches on its receiver like the
 * prototype method it stands for. */
static ScrDyn *scr_dgram_dyn_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrStr *method = scr_box_get_ref(closure->caps[0]);
  ScrDyn *receiver = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (receiver->kind == SCR_DYN_HANDLE && receiver->v.handle.tag == SCR_DYNH_DGRAM_SOCKET) {
    result = scr_dgram_dynh_invoke(receiver->v.handle.ptr, receiver, method->data, args, argc,
                                   method->data);
  } else {
    char msg[160];
    int n = snprintf(msg, sizeof msg,
                     "dgram.Socket.prototype.%s called on a value that is not a dgram Socket",
                     method->data);
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)n);
  }
  scr_dyn_release(receiver);
  scr_str_release(method);
  return result;
}

static const char *const scr_dgram_dyn_method_names[] = {
  "on", "once", "addListener", "removeListener", "off", "emit", "send", "close", "bind",
  "connect", "disconnect", "address", "ref", "unref", NULL,
};

static void scr_dgram_dyn_cleanup(void) {
  scr_dyn_release(scr_dgram_dyn_methods);
  scr_dgram_dyn_methods = NULL;
  /* Untyped listeners can close cycles through the boxes they capture,
   * and the proxies in a socket's lists hold its entry: exit releases
   * both, socket by socket. */
  /* Releasing one entry's listeners can free other entries (they unlink
   * themselves), so each pass restarts from the head. */
  for (;;) {
    ScrDgramDyn *e = scr_dgram_dyns;
    while (e && e->cleaned) e = e->next;
    if (e == NULL) break;
    e->cleaned = true;
    e->rc++;
    scr_dgram_dyn_clear(e);
    ScrDgramSocket *s = e->s;
    scr_dgram_dyn_ls_drop(&s->msg_ls);
    scr_dgram_dyn_ls_drop(&s->err_ls);
    scr_dgram_dyn_ls_drop(&s->listening_ls);
    scr_dgram_dyn_ls_drop(&s->close_ls);
    scr_dgram_dyn_ls_drop(&s->conn_ls);
    scr_dgram_dyn_release_v(e);
  }
}

static ScrDyn *scr_dgram_dynh_get(void *h, const char *key, size_t key_len) {
  (void)h;
  for (size_t i = 0; scr_dgram_dyn_method_names[i]; i++) {
    if (strcmp(key, scr_dgram_dyn_method_names[i]) != 0) continue;
    if (scr_dgram_dyn_methods == NULL) scr_dgram_dyn_methods = scr_dyn_new_obj();
    ScrDyn *have = scr_dyn_obj_get(scr_dgram_dyn_methods, key, key_len);
    if (have != NULL) return scr_dyn_retain(have);
    ScrStr *name = scr_str_new(key, key_len);
    ScrClosure *closure = scr_closure_new(NULL, 1);
    closure->caps[0] = scr_box_new(SCR_BOX_STR);
    scr_box_set_ref(closure->caps[0], name);
    ScrDyn *fn = scr_dyn_new_func(closure, scr_dgram_dyn_method_call, 0, "native:dgram.Socket",
                                  scr_dgram_dyn_method_names[i]);
    scr_dyn_obj_set(scr_dgram_dyn_methods, key, key_len, scr_dyn_retain(fn));
    return fn;
  }
  return NULL;
}

static bool scr_dgram_dynh_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  (void)h; (void)key; (void)key_len; (void)value;
  return false;
}

static const ScrDynHandleOps scr_dgram_dynh_ops = {
  .cls = "Socket",
  .retain = &scr_dgram_dyn_retain_v,
  .release = &scr_dgram_dyn_release_v,
  .invoke = &scr_dgram_dynh_invoke,
  .get = &scr_dgram_dynh_get,
  .set = &scr_dgram_dynh_set,
};

ScrDyn *scr_dgram_to_dyn(ScrDgramSocket *s) {
  static SCR_TL bool installed = false;
  if (!installed) {
    installed = true;
    scr_dyn_handle_install(SCR_DYNH_DGRAM_SOCKET, &scr_dgram_dynh_ops);
    scr_atexit(scr_dgram_dyn_cleanup);
  }
  ScrDgramDyn *e = scr_dgram_dyns;
  while (e && e->s != s) e = e->next;
  if (e == NULL) {
    /* rc 0: the box's retain takes the first reference */
    e = calloc(1, sizeof *e);
    if (!e) scr_dgram_dyn_oom();
    e->s = scr_dgram_retain(s);
    e->next = scr_dgram_dyns;
    scr_dgram_dyns = e;
  }
  return scr_dyn_new_handle(e, SCR_DYNH_DGRAM_SOCKET);
}

ScrDgramSocket *scr_dgram_from_dyn(const ScrDyn *d, const ScrDynPath *path, const char *want) {
  if (d->kind != SCR_DYN_HANDLE || d->v.handle.tag != SCR_DYNH_DGRAM_SOCKET) {
    scr_dyn_check_fail(path, want, d);
    return NULL;
  }
  return scr_dgram_retain(((ScrDgramDyn *)d->v.handle.ptr)->s);
}
