/* Node islands: object handles (scope-B milestone NI-4). Linked with
 * scr_node_island.c into programs whose IR reaches Node.
 *
 * Island values the program holds are handles: a ScrNodeRef per V8 value,
 * naming an entry of the bridge's import table (a v8::Global), boxed as
 * SCR_DYN_HANDLE with tag SCR_DYNH_NODE_ISLAND. The bridge answers one id
 * per V8 value while the runtime holds it and the runtime keeps one ref per
 * id (ni_refs), so the same V8 object always comes back as the same ref:
 * `===` compares handle pointers and identity is exact. When the last box
 * releases a ref, the bridge drops its Global and V8 may collect the
 * object (acyclic garbage; cycles across both heaps wait for NI-8).
 *
 * Boundary rules (DESIGN §2.5.1): undefined, null, booleans, numbers
 * (exact: -0, NaN), strings (WTF-8, lone surrogates kept) and BigInt are
 * copied; everything else is a handle. Island promises cross as scriptc
 * promises settled by a V8 reaction, one per V8 promise while it lives.
 * Typed arrays and Buffers cross as ScrBytes over the same memory (the V8
 * backing store, kept alive by the bridge while the runtime holds the
 * bytes), and runtime bytes cross into V8 as a backing store over the
 * runtime's memory. Island errors thrown into the program become ScrErrors
 * with V8's name, message, stack and code, and become the original V8
 * error again when they cross back.
 *
 * Runtime objects that represent a V8 value (a promise, an error, bytes)
 * are "pinned": the table below holds the object and its ref, and a lazy
 * sweep at bridge entries releases both once the table holds the object's
 * last reference. Native objects and arrays that are not island values
 * cross by JSON copy until NI-5's exports (a documented NI-4 shortcut). */
#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE 1
#include "scr_runtime.h"
#include "scr_node_bridge.h"
#include "scr_node_island.h"

#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if !defined(_WIN32) && !defined(__wasi__)

typedef struct ScrNodeRef {
  size_t rc;
  uint32_t id;
  uint32_t flags; /* SCR_NVF_* */
  /* NI-7: a stub of a deferred island module's value (id 0) carries its
   * interface-snapshot entry (scr_node_island_boot.c) until Node starts and
   * the boot unit reconciles it with the real value. `alias`: the real ref
   * when the value already had one (identity split, traced). */
  void *stub;
  struct ScrNodeRef *alias;
  /* NI-5d: a native subclass of an island class not created yet: the
   * seven subclass arguments (retained), created on first need. */
  ScrDyn **lazy;
} ScrNodeRef;

static ScrNodeRef **ni_refs = NULL; /* by bridge id */
static size_t ni_refs_cap = 0;
static bool ni_stopped = false;

SCR_COLD static void nh_oom(void) { scr_trap("scriptc: out of memory\n"); }

static const ScrNodeBridge *nh_bridge(void) { return scr_ni_bridge(); }

/* ── pinned runtime objects ──────────────────────────────────────────── */

enum { NH_PIN_PROMISE = 1, NH_PIN_ERROR = 2, NH_PIN_BYTES = 3 };

typedef struct {
  void *obj; /* retained; its reference count is the first word */
  ScrNodeRef *ref; /* retained */
  int kind;
} NhPin;

static NhPin *nh_pins = NULL;
static size_t nh_npins = 0, nh_pins_cap = 0, nh_sweep_at = 64;

static void nh_ref_release(ScrNodeRef *ref);

static void nh_pin_release_obj(NhPin *pin) {
  switch (pin->kind) {
  case NH_PIN_PROMISE: scr_promise_release((ScrPromise *)pin->obj); break;
  case NH_PIN_ERROR: scr_error_release((ScrError *)pin->obj); break;
  case NH_PIN_BYTES: scr_bytes_release((ScrBytes *)pin->obj); break;
  }
}

static void nh_pin(void *obj, int kind, ScrNodeRef *ref) {
  if (nh_npins == nh_pins_cap) {
    size_t cap = nh_pins_cap ? nh_pins_cap * 2 : 16;
    NhPin *grown = realloc(nh_pins, cap * sizeof *grown);
    if (grown == NULL) nh_oom();
    nh_pins = grown;
    nh_pins_cap = cap;
  }
  switch (kind) {
  case NH_PIN_PROMISE: scr_promise_retain((ScrPromise *)obj); break;
  case NH_PIN_ERROR: scr_error_retain((ScrError *)obj); break;
  case NH_PIN_BYTES: scr_bytes_retain((ScrBytes *)obj); break;
  }
  ref->rc++;
  nh_pins[nh_npins++] = (NhPin){obj, ref, kind};
}

/* The ref a pinned runtime object represents, or NULL. */
static ScrNodeRef *nh_pinned(const void *obj, int kind) {
  for (size_t i = 0; i < nh_npins; i++)
    if (nh_pins[i].obj == obj && nh_pins[i].kind == kind) return nh_pins[i].ref;
  return NULL;
}

/* The pinned object of a ref, or NULL. */
static void *nh_pinned_obj(const ScrNodeRef *ref, int kind) {
  for (size_t i = 0; i < nh_npins; i++)
    if (nh_pins[i].ref == ref && nh_pins[i].kind == kind) return nh_pins[i].obj;
  return NULL;
}

/* Releases every pin whose object only the table still holds. Releasing a
 * pin can free objects that held other pinned objects, so it repeats until
 * a pass frees nothing. */
static void nh_sweep(void) {
  bool freed = true;
  while (freed) {
    freed = false;
    for (size_t i = 0; i < nh_npins;) {
      size_t rc = *(size_t *)nh_pins[i].obj;
      if (rc == 1) {
        NhPin pin = nh_pins[i];
        nh_pins[i] = nh_pins[--nh_npins];
        nh_pin_release_obj(&pin);
        nh_ref_release(pin.ref);
        freed = true;
      } else {
        i++;
      }
    }
  }
  nh_sweep_at = nh_npins * 2 > 64 ? nh_npins * 2 : 64;
}

/* ── runtime bytes V8 freed (any thread) ─────────────────────────────── */

static pthread_mutex_t nh_freed_lock = PTHREAD_MUTEX_INITIALIZER;
static void **nh_freed = NULL;
static size_t nh_nfreed = 0, nh_freed_cap = 0;

void scr_ni_bytes_free(void *owner) {
  pthread_mutex_lock(&nh_freed_lock);
  if (nh_nfreed == nh_freed_cap) {
    size_t cap = nh_freed_cap ? nh_freed_cap * 2 : 16;
    void **grown = realloc(nh_freed, cap * sizeof *grown);
    if (grown == NULL) nh_oom();
    nh_freed = grown;
    nh_freed_cap = cap;
  }
  nh_freed[nh_nfreed++] = owner;
  pthread_mutex_unlock(&nh_freed_lock);
}

static void nh_drain_freed(void) {
  for (;;) {
    pthread_mutex_lock(&nh_freed_lock);
    void *owner = nh_nfreed > 0 ? nh_freed[--nh_nfreed] : NULL;
    pthread_mutex_unlock(&nh_freed_lock);
    if (owner == NULL) return;
    scr_bytes_release((ScrBytes *)owner);
  }
}

/* Housekeeping at every operation: bytes V8 freed, and the pin sweep once
 * the table has grown. */
static void nh_enter(void) {
  if (nh_nfreed > 0) nh_drain_freed();
  if (nh_npins >= nh_sweep_at) nh_sweep();
}

/* ── refs ─────────────────────────────────────────────────────────────── */

static void *nh_ref_retain_v(void *h) {
  ((ScrNodeRef *)h)->rc++;
  return h;
}

static void nh_lazy_free(ScrNodeRef *ref) {
  if (ref->lazy == NULL) return;
  for (int i = 0; i < 7; i++) scr_dyn_release(ref->lazy[i]);
  free(ref->lazy);
  ref->lazy = NULL;
}

static void nh_ref_release(ScrNodeRef *ref) {
  if (--ref->rc != 0) return;
  if (ref->alias != NULL) {
    nh_ref_release(ref->alias);
    free(ref);
    return;
  }
  if (ref->id == 0) { /* a stub never materialized, or a transplanted ref */
    nh_lazy_free(ref);
    free(ref);
    return;
  }
  if (ref->id < ni_refs_cap && ni_refs[ref->id] == ref) ni_refs[ref->id] = NULL;
  if (!ni_stopped && scr_ni_bridge_loaded() != NULL) scr_ni_bridge_loaded()->drop(ref->id);
  free(ref);
}

static void nh_ref_release_v(void *h) { nh_ref_release((ScrNodeRef *)h); }

/* The ref of bridge id `id` (+1), created on first sight. */
static ScrNodeRef *nh_ref(uint32_t id, uint32_t flags) {
  if (id >= ni_refs_cap) {
    size_t cap = ni_refs_cap ? ni_refs_cap : 64;
    while (cap <= id) cap *= 2;
    ScrNodeRef **grown = realloc(ni_refs, cap * sizeof *grown);
    if (grown == NULL) nh_oom();
    memset(grown + ni_refs_cap, 0, (cap - ni_refs_cap) * sizeof *grown);
    ni_refs = grown;
    ni_refs_cap = cap;
  }
  ScrNodeRef *ref = ni_refs[id];
  if (ref != NULL) {
    ref->rc++;
    return ref;
  }
  ref = calloc(1, sizeof *ref);
  if (ref == NULL) nh_oom();
  ref->rc = 1;
  ref->id = id;
  ref->flags = flags;
  ni_refs[id] = ref;
  return ref;
}

/* ── NI-7 stubs (deferred island modules, scr_node_island_boot.c) ─────── */

ScrDyn *scr_ni_stub_new(uint32_t flags, void *stub) {
  ScrNodeRef *ref = calloc(1, sizeof *ref);
  if (ref == NULL) nh_oom();
  ref->rc = 1;
  ref->flags = flags;
  ref->stub = stub;
  ScrDyn *box = scr_dyn_new_handle(ref, SCR_DYNH_NODE_ISLAND);
  ref->rc--; /* the box holds the only reference */
  return box;
}

void *scr_ni_stub_of(const ScrDyn *value) {
  if (value == NULL || value->kind != SCR_DYN_HANDLE || value->v.handle.tag != SCR_DYNH_NODE_ISLAND)
    return NULL;
  return ((ScrNodeRef *)value->v.handle.ptr)->stub;
}

/* Identity reconciliation: the stub box `stub` becomes the program's
 * handle of the real island value `real` (borrowed). When the runtime saw
 * the value for the first time, the stub takes over its bridge id, so every
 * later crossing of the value answers the stub's ref and `===` holds; the
 * fresh ref is retired without dropping the bridge entry. Answers false
 * when the value is not an island object (the snapshot no longer applies). */
bool scr_ni_stub_reconcile(ScrDyn *stub, ScrDyn *real) {
  ScrNodeRef *s = stub->v.handle.ptr;
  if (!scr_ni_is_handle(real)) return false;
  ScrNodeRef *r = real->v.handle.ptr;
  if (r != s && r->stub != NULL) return false;
  s->stub = NULL;
  if (r == s) return true;
  if (r->rc == 1 && r->alias == NULL) {
    /* Only `real` holds the fresh ref: move its id to the stub. */
    s->id = r->id;
    s->flags = r->flags;
    ni_refs[r->id] = s;
    r->id = 0;
    real->v.handle.ptr = s;
    s->rc++;
    r->rc = 0;
    free(r);
    return true;
  }
  /* The program already holds the value through another ref: the stub
   * forwards to it (identity split for `===` between the two). */
  s->alias = r;
  r->rc++;
  s->id = r->id;
  s->flags = r->flags;
  if (getenv("SCRIPTC_NODE_ISLANDS_TRACE") != NULL)
    fprintf(stderr, "[node-islands] stub identity split (id %u)\n", r->id);
  return true;
}

/* A stub whose Node value is needed: starting Node materializes every
 * deferred module (scr_node_island_boot.c), after which the ref is real.
 * False with the module's load error pending. */
ScrDyn *scr_ni_lazy_subclass_new(ScrDyn *const *args) {
  ScrNodeRef *ref = calloc(1, sizeof *ref);
  ScrDyn **lazy = malloc(7 * sizeof *lazy);
  if (ref == NULL || lazy == NULL) nh_oom();
  for (int i = 0; i < 7; i++) lazy[i] = scr_dyn_retain(args[i]);
  ref->rc = 1;
  ref->flags = SCR_NVF_FUNCTION | SCR_NVF_CONSTRUCTOR;
  ref->lazy = lazy;
  ScrDyn *box = scr_dyn_new_handle(ref, SCR_DYNH_NODE_ISLAND);
  ref->rc--; /* the box holds the only reference */
  return box;
}

static bool nh_lazy_is(const ScrDyn *value) {
  return scr_ni_is_handle(value) && ((ScrNodeRef *)value->v.handle.ptr)->lazy != NULL;
}

/* Creates a lazy subclass now (its base materializes first, as the
 * conversion of the base argument needs it) and makes the lazy ref the
 * class's handle, so the box the program holds is the class. */
static bool nh_lazy_create(ScrNodeRef *ref) {
  ScrDyn **lazy = ref->lazy;
  ref->lazy = NULL;
  ScrDyn *real = scr_ni_subclass_create(lazy);
  if (real == NULL || !scr_ni_is_handle(real)) {
    ref->lazy = lazy;
    scr_dyn_release(real);
    return false;
  }
  ScrNodeRef *r = real->v.handle.ptr;
  ref->id = r->id;
  ref->flags = r->flags;
  ni_refs[r->id] = ref;
  real->v.handle.ptr = ref;
  ref->rc++;
  r->id = 0;
  r->rc = 0;
  free(r);
  scr_dyn_release(real);
  for (int i = 0; i < 7; i++) scr_dyn_release(lazy[i]);
  free(lazy);
  if (getenv("SCRIPTC_NODE_ISLANDS_TRACE") != NULL)
    fprintf(stderr, "[node-islands] created native subclass (id %u)\n", ref->id);
  return true;
}

static bool nh_live(ScrNodeRef *ref) {
  if (ref->lazy != NULL) return nh_lazy_create(ref);
  if (ref->stub == NULL) return true;
  void *stub = ref->stub;
  scr_ni_bridge();
  if (ref->stub == NULL) return true;
  scr_ni_boot_stub_failed(stub);
  return false;
}

static const ScrDynHandleOps nh_ops;

bool scr_ni_is_handle(const ScrDyn *value) {
  return value != NULL && value->kind == SCR_DYN_HANDLE &&
         value->v.handle.tag == SCR_DYNH_NODE_ISLAND;
}

static ScrNodeRef *nh_ref_of(const ScrDyn *value) {
  return scr_ni_is_handle(value) ? (ScrNodeRef *)value->v.handle.ptr : NULL;
}

/* ── awaiting island thenables ───────────────────────────────────────── */

typedef struct {
  uint32_t token;
  ScrPromise *promise; /* owned */
} NhWaiter;

static NhWaiter *nh_waiters = NULL;
static size_t nh_nwaiters = 0, nh_waiters_cap = 0;
static uint32_t nh_next_token = 1;

static uint32_t nh_wait(ScrPromise *p) {
  if (nh_nwaiters == nh_waiters_cap) {
    size_t cap = nh_waiters_cap ? nh_waiters_cap * 2 : 8;
    NhWaiter *grown = realloc(nh_waiters, cap * sizeof *grown);
    if (grown == NULL) nh_oom();
    nh_waiters = grown;
    nh_waiters_cap = cap;
  }
  uint32_t token = nh_next_token++;
  if (nh_next_token == 0) nh_next_token = 1;
  nh_waiters[nh_nwaiters++] = (NhWaiter){token, scr_promise_retain(p)};
  return token;
}

/* ── V8 → runtime ─────────────────────────────────────────────────────── */

static ScrDyn *nh_from_node(const ScrNodeValue *v);
static void nh_throw_value(const ScrNodeValue *v);
static int nh_then(const ScrNodeValue *value, uint32_t token, ScrNodeValue *thrown);

static bool nh_has_lone_surrogate(const char *p, size_t n) {
  for (size_t i = 0; i + 1 < n; i++)
    if ((unsigned char)p[i] == 0xED && (unsigned char)p[i + 1] >= 0xA0) return true;
  return false;
}

static ScrStr *nh_str(const char *data, size_t len) {
  if (nh_has_lone_surrogate(data, len)) scr_wtf8_note();
  return scr_str_new(data, len);
}

/* An island promise as a scriptc promise: one per V8 promise while the
 * program holds it, settled by a reaction on the V8 side. */
static ScrDyn *nh_promise_box(ScrNodeRef *ref) {
  ScrPromise *p = nh_pinned_obj(ref, NH_PIN_PROMISE);
  if (p == NULL) {
    p = scr_promise_new();
    nh_pin(p, NH_PIN_PROMISE, ref);
    ScrNodeValue value = {.tag = SCR_NV_HANDLE, .flags = ref->flags};
    value.u.handle = ref->id;
    ScrNodeValue thrown;
    uint32_t token = nh_wait(p);
    if (nh_then(&value, token, &thrown) != 0) {
      nh_throw_value(&thrown);
      scr_promise_reject_pending(p);
    }
    scr_promise_release(p); /* the pin holds it */
  }
  return scr_dyn_new_promise(p);
}

/* Bytes from V8: an external root over the V8 store's memory, one per V8
 * view while the program holds it. */
static ScrDyn *nh_bytes_box(const ScrNodeValue *v) {
  ScrNodeRef *ref = nh_ref(v->u.bytes.handle, v->flags);
  ScrBytes *b = nh_pinned_obj(ref, NH_PIN_BYTES);
  if (b == NULL) {
    b = scr_bytes_from_external(v->u.bytes.data, v->u.bytes.len);
    b->elem = (ScrBytesElem)v->u.bytes.elem;
    b->is_buffer = (v->flags & SCR_NVF_BUFFER) != 0;
    b->is_data_view = (v->flags & SCR_NVF_DATAVIEW) != 0;
    nh_pin(b, NH_PIN_BYTES, ref);
    scr_bytes_release(b); /* the pin holds it */
  }
  nh_ref_release(ref);
  ScrDyn *d = scr_dyn_new_bytes(b);
  d->buffer = b->is_buffer;
  return d;
}

/* A value the bridge answered, as a dyn value (+1). Copies string data at
 * once: it is valid only until the next bridge entry. */
static ScrDyn *nh_from_node(const ScrNodeValue *v) {
  switch (v->tag) {
  case SCR_NV_NULL: return scr_dyn_new_null();
  case SCR_NV_BOOL: return scr_dyn_new_bool(v->u.boolean != 0);
  case SCR_NV_NUMBER: return scr_dyn_new_num(v->u.num);
  case SCR_NV_STRING: {
    ScrStr *s = nh_str(v->u.str.data, v->u.str.len);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  case SCR_NV_BIGINT: {
    ScrStr *s = scr_str_new(v->u.str.data, v->u.str.len);
    ScrBigInt *n = scr_bigint_parse(s);
    scr_str_release(s);
    if (n == NULL) return NULL;
    ScrDyn *d = scr_dyn_new_bigint(n);
    scr_bigint_release(n);
    return d;
  }
  case SCR_NV_HANDLE: {
    ScrNodeRef *ref = nh_ref(v->u.handle, v->flags);
    ScrDyn *d = (ref->flags & SCR_NVF_PROMISE) ? nh_promise_box(ref)
                                                : scr_dyn_new_handle(ref, SCR_DYNH_NODE_ISLAND);
    nh_ref_release(ref);
    return d;
  }
  case SCR_NV_BYTES: return nh_bytes_box(v);
  case SCR_NV_EXPORT: {
    /* A native value's representative came back: the value itself. */
    ScrDyn *d = scr_ni_export_value(v->u.exp.id);
    return d != NULL ? scr_dyn_retain(d) : scr_dyn_undefined();
  }
  default: return scr_dyn_undefined();
  }
}

/* The ScrError of an island Error handle (+1): the one already pinned to
 * it, else a new one of the nearest intrinsic class, pinned. */
static ScrError *nh_error_of(const ScrNodeValue *v) {
  ScrNodeRef *ref = nh_ref(v->u.handle, v->flags);
  ScrError *pinned = nh_pinned_obj(ref, NH_PIN_ERROR);
  if (pinned != NULL) {
    nh_ref_release(ref);
    return scr_error_retain(pinned);
  }
  ScrNodeErrorInfo info;
  nh_bridge()->error_info(ref->id, &info);
  ScrStr *message = nh_str(info.message ? info.message : "", info.message_len);
  ScrError *e = scr_error_new((int)info.kind, message);
  scr_str_release(message);
  if (info.name != NULL) {
    ScrStr *name = nh_str(info.name, info.name_len);
    ScrStr *deflt = scr_error_default_name(e);
    bool differs = deflt == NULL || deflt->len != name->len ||
                   memcmp(deflt->data, name->data, name->len) != 0;
    if (deflt != NULL) scr_str_release(deflt);
    if (differs) {
      scr_str_release(e->name);
      e->name = name;
      e->name_present = true;
    } else {
      scr_str_release(name);
    }
  }
  if (info.stack != NULL) {
    ScrStr *stack = nh_str(info.stack, info.stack_len);
    scr_error_set_stack(e, stack);
    scr_str_release(stack);
  }
  if (info.code != NULL) {
    ScrStr *code = nh_str(info.code, info.code_len);
    scr_error_set_code_value(e, code);
    scr_str_release(code);
  }
  nh_pin(e, NH_PIN_ERROR, ref);
  nh_ref_release(ref);
  return e;
}

/* An argument of a native callback (scr_node_island_export.c): island
 * Errors arrive as their pinned ScrError, as thrown ones do, so typed code
 * sees `instanceof RangeError`, `message` and `code`. +1. */
ScrDyn *scr_ni_arg_in(const ScrNodeValue *v) {
  if (v->tag == SCR_NV_HANDLE && (v->flags & SCR_NVF_ERROR)) {
    ScrError *e = nh_error_of(v);
    ScrDyn *d = scr_dyn_from_error(e);
    scr_error_release(e);
    return d;
  }
  return scr_ni_value_in(v);
}

/* Leaves a thrown island value pending as a scriptc exception. An Error
 * becomes a ScrError of the nearest intrinsic class with V8's name,
 * message, stack and string code, pinned to the V8 error so that it is
 * that error again if it crosses back. */
static void nh_throw_value(const ScrNodeValue *v) {
  if (v->tag == SCR_NV_HANDLE && (v->flags & SCR_NVF_ERROR)) {
    ScrError *e = nh_error_of(v);
    scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
    return;
  }
  ScrDyn *d = nh_from_node(v);
  if (d == NULL) return; /* a conversion error is pending */
  scr_dyn_throw(d);
}

/* A V8 reaction settled an awaited thenable. */
void scr_ni_settle_value(uint32_t token, int rejected, const ScrNodeValue *value) {
  for (size_t i = 0; i < nh_nwaiters; i++) {
    if (nh_waiters[i].token != token) continue;
    ScrPromise *p = nh_waiters[i].promise;
    nh_waiters[i] = nh_waiters[--nh_nwaiters];
    if (rejected) {
      nh_throw_value(value);
      scr_promise_reject_pending(p);
    } else {
      ScrDyn *d = nh_from_node(value);
      if (d != NULL)
        scr_promise_fulfill_ref(p, d, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
      scr_promise_reject_pending(p); /* no-op unless a conversion error is pending */
    }
    scr_promise_release(p);
    return;
  }
}

/* ── runtime → V8 ─────────────────────────────────────────────────────── */

/* What a conversion into V8 keeps alive until the bridge call returns. */
typedef struct {
  void *items[16];
  void (*releases[16])(void *);
  size_t n;
  void **more;
  void (**more_releases)(void *);
  size_t nmore, more_cap;
} NhKeep;

static void nh_keep(NhKeep *k, void *obj, void (*release)(void *)) {
  if (k->n < 16) {
    k->items[k->n] = obj;
    k->releases[k->n++] = release;
    return;
  }
  if (k->nmore == k->more_cap) {
    size_t cap = k->more_cap ? k->more_cap * 2 : 16;
    void **items = realloc(k->more, cap * sizeof *items);
    void (**rels)(void *) = realloc(k->more_releases, cap * sizeof *rels);
    if (items == NULL || rels == NULL) nh_oom();
    k->more = items;
    k->more_releases = rels;
    k->more_cap = cap;
  }
  k->more[k->nmore] = obj;
  k->more_releases[k->nmore++] = release;
}

static void nh_keep_done(NhKeep *k) {
  for (size_t i = 0; i < k->n; i++) k->releases[i](k->items[i]);
  for (size_t i = 0; i < k->nmore; i++) k->more_releases[i](k->more[i]);
  free(k->more);
  free(k->more_releases);
}

static void nh_str_release_v(void *s) { scr_str_release((ScrStr *)s); }
static void nh_dyn_release_v(void *d) { scr_dyn_release((ScrDyn *)d); }

SCR_COLD static bool nh_refuse(const char *what) {
  char message[256];
  snprintf(message, sizeof message,
           "scriptc: %s cannot cross into a Node island yet (scope-B NI-5 exports native values by reference)",
           what);
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
  return false;
}

/* The values NI-5 exports by reference (closures, promises, typed refs,
 * native objects and arrays). Until then: plain dyn objects and arrays
 * cross as a JSON copy (the NI-4 shortcut), anything else is refused. */
static bool nh_export_value(ScrDyn *v, ScrNodeValue *out, NhKeep *keep) {
  /* NI-5: closures, promises, records, class instances and dyn objects
   * cross by reference (scr_node_island_export.c). */
  if (scr_ni_exportable(v)) {
    scr_ni_export_out(v, out);
    return true;
  }
  /* Arrays (dyn, and typed array capsules: NI-6 shortcut, as for dyn
   * arrays) keep NI-4's JSON copy. */
  if (v->kind == SCR_DYN_OBJ || v->kind == SCR_DYN_ARR ||
      (v->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_array_ops(v) != NULL)) {
    ScrStr *gap = scr_str_new("", 0);
    ScrDyn *json = scr_json_stringify_replacer(v, scr_dyn_undefined(), gap);
    scr_str_release(gap);
    if (json == NULL || scr_exc_pending()) {
      if (json != NULL) scr_dyn_release(json);
      return false;
    }
    if (json->kind != SCR_DYN_STR) {
      scr_dyn_release(json);
      out->tag = SCR_NV_UNDEFINED;
      return true;
    }
    nh_keep(keep, json, nh_dyn_release_v);
    out->tag = SCR_NV_JSON;
    out->u.str.data = json->v.str->data;
    out->u.str.len = json->v.str->len;
    return true;
  }
  switch (v->kind) {
  case SCR_DYN_FUNC: return nh_refuse("a function");
  case SCR_DYN_PROMISE: return nh_refuse("a native promise");
  case SCR_DYN_SYMBOL: return nh_refuse("a native symbol");
  default: return nh_refuse("this native object");
  }
}

/* The nearest intrinsic class V8 has (subclasses included). */
static uint32_t nh_error_kind(const ScrError *e) {
  for (int k = 1; k <= SCR_ERR_URI; k++) {
    if (k == SCR_ERR_DOMEX) continue;
    if (scr_error_vts[k].pre <= e->vt->pre && e->vt->pre <= scr_error_vts[k].post)
      return (uint32_t)k;
  }
  return 0;
}

/* A runtime value as a bridge in-value. False with an exception pending
 * when it cannot cross. */
static bool nh_to_node(ScrDyn *v, ScrNodeValue *out, NhKeep *keep) {
  memset(out, 0, sizeof *out);
  if (v == NULL) {
    out->tag = SCR_NV_UNDEFINED;
    return true;
  }
  switch (v->kind) {
  case SCR_DYN_UNDEF: out->tag = SCR_NV_UNDEFINED; return true;
  case SCR_DYN_NULL: out->tag = SCR_NV_NULL; return true;
  case SCR_DYN_BOOL: out->tag = SCR_NV_BOOL; out->u.boolean = v->v.b ? 1 : 0; return true;
  case SCR_DYN_NUM: out->tag = SCR_NV_NUMBER; out->u.num = v->v.num; return true;
  case SCR_DYN_STR:
    out->tag = SCR_NV_STRING;
    out->u.str.data = v->v.str->data;
    out->u.str.len = v->v.str->len;
    return true;
  case SCR_DYN_BIGINT: {
    ScrStr *text = scr_bigint_to_string(v->v.bigint, 10);
    if (text == NULL) return false;
    nh_keep(keep, text, nh_str_release_v);
    out->tag = SCR_NV_BIGINT;
    out->u.str.data = text->data;
    out->u.str.len = text->len;
    return true;
  }
  case SCR_DYN_HANDLE:
    if (v->v.handle.tag == SCR_DYNH_NODE_ISLAND) {
      ScrNodeRef *ref = v->v.handle.ptr;
      if (!nh_live(ref)) return false;
      out->tag = SCR_NV_HANDLE;
      out->flags = ref->flags;
      out->u.handle = ref->id;
      return true;
    }
    return nh_export_value(v, out, keep);
  case SCR_DYN_PROMISE: {
    ScrNodeRef *ref = nh_pinned(v->v.promise, NH_PIN_PROMISE);
    if (ref == NULL) return nh_export_value(v, out, keep);
    out->tag = SCR_NV_HANDLE;
    out->flags = ref->flags;
    out->u.handle = ref->id;
    return true;
  }
  case SCR_DYN_BYTES: {
    ScrBytes *b = v->v.bytes;
    ScrBytes *root = b->backing != NULL ? b->backing : b;
    ScrNodeRef *ref = nh_pinned(b, NH_PIN_BYTES);
    out->tag = SCR_NV_BYTES;
    out->u.bytes.elem = (uint32_t)b->elem;
    out->u.bytes.len = b->len;
    out->u.bytes.data = b->data;
    if (b->is_buffer || v->buffer) out->flags |= SCR_NVF_BUFFER;
    if (b->is_data_view) out->flags |= SCR_NVF_DATAVIEW;
    if (ref != NULL) {
      out->u.bytes.handle = ref->id; /* the same V8 view */
      return true;
    }
    if (root->shared != NULL) return nh_refuse("shared memory");
    /* V8 frees the store through host->bytes_free, which releases this. */
    out->u.bytes.owner = scr_bytes_retain(root);
    return true;
  }
  default: break;
  }
  ScrError *e = scr_errdyn_err_of(v);
  if (e != NULL) {
    ScrNodeRef *ref = nh_pinned(e, NH_PIN_ERROR);
    if (ref != NULL) {
      scr_error_release(e);
      out->tag = SCR_NV_HANDLE;
      out->flags = ref->flags;
      out->u.handle = ref->id;
      return true;
    }
    ScrStr *name = e->name != NULL ? scr_str_retain(e->name) : scr_error_default_name(e);
    ScrStr *message = e->message != NULL ? scr_str_retain(e->message) : scr_str_new("", 0);
    ScrStr *stack = scr_error_stack(e);
    nh_keep(keep, name, nh_str_release_v);
    nh_keep(keep, message, nh_str_release_v);
    if (stack != NULL) nh_keep(keep, stack, nh_str_release_v);
    out->tag = SCR_NV_ERROR;
    out->u.error.kind = nh_error_kind(e);
    out->u.error.name = name->data;
    out->u.error.name_len = name->len;
    out->u.error.message = message->data;
    out->u.error.message_len = message->len;
    if (stack != NULL) {
      out->u.error.stack = stack->data;
      out->u.error.stack_len = stack->len;
    }
    if (e->code != NULL) {
      ScrStr *code = scr_str_retain(e->code);
      nh_keep(keep, code, nh_str_release_v);
      out->u.error.code = code->data;
      out->u.error.code_len = code->len;
    }
    scr_error_release(e);
    return true;
  }
  return nh_export_value(v, out, keep);
}

/* ── operations on Node's stack ──────────────────────────────────────── */

enum {
  NH_LOAD, NH_GET, NH_SET, NH_HAS, NH_DEL, NH_INVOKE, NH_INVOKE_METHOD, NH_CONSTRUCT,
  NH_INSTANCEOF, NH_KEYS, NH_THEN,
};

typedef struct {
  int op;
  uint32_t h;
  const char *path;
  int mode;
  const ScrNodeValue *a, *b;
  const ScrNodeValue *args;
  size_t argc;
  uint32_t token;
  ScrNodeValue *out;
  int threw;
} NhCall;

static void nh_call_job(void *p) {
  NhCall *c = p;
  const ScrNodeBridge *b = scr_ni_bridge_loaded();
  switch (c->op) {
  case NH_LOAD: c->threw = b->load(c->path, c->mode, c->out); break;
  case NH_GET: c->threw = b->get(c->h, c->a, c->out); break;
  case NH_SET: c->threw = b->set(c->h, c->a, c->b, c->out); break;
  case NH_HAS: c->threw = b->has(c->h, c->a, c->out); break;
  case NH_DEL: c->threw = b->del(c->h, c->a, c->out); break;
  case NH_INVOKE: c->threw = b->invoke(c->h, c->a, c->args, c->argc, c->out); break;
  case NH_INVOKE_METHOD: c->threw = b->invoke_method(c->h, c->a, c->args, c->argc, c->out); break;
  case NH_CONSTRUCT: c->threw = b->construct(c->h, c->args, c->argc, c->out); break;
  case NH_INSTANCEOF: c->threw = b->instance_of(c->a, c->h, c->out); break;
  case NH_KEYS: c->threw = b->own_keys(c->h, c->mode, c->out); break;
  case NH_THEN: c->threw = b->then(c->a, c->token, c->out); break;
  }
}

static int nh_run(NhCall *c) {
  scr_ni_shared_refresh();
  scr_ni_on_node_stack(nh_call_job, c);
  return c->threw;
}

static int nh_then(const ScrNodeValue *value, uint32_t token, ScrNodeValue *thrown) {
  NhCall c = {.op = NH_THEN, .a = value, .token = token, .out = thrown};
  return nh_run(&c);
}

/* The outcome of a call as a dyn value (+1), or NULL with the thrown
 * value pending. */
static ScrDyn *nh_outcome(NhCall *c) {
  if (c->threw) {
    nh_throw_value(c->out);
    return NULL;
  }
  return nh_from_node(c->out);
}

/* The receiver of a property operation as an in-value: an island handle
 * names itself; anything else is a TypeError (the compiler routes only
 * island values here). */
static bool nh_receiver(ScrDyn *obj, uint32_t *id, const char *what) {
  ScrNodeRef *ref = nh_ref_of(obj);
  if (ref == NULL) {
    char message[160];
    snprintf(message, sizeof message, "scriptc: %s needs a Node island value", what);
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
    return false;
  }
  if (!nh_live(ref)) return false;
  *id = ref->id;
  return true;
}

/* ── the runtime API (scr_node_island.h) ─────────────────────────────── */

static ScrDyn *nh_load(ScrStr *path, int esm) {
  nh_bridge();
  nh_enter();
  /* A recorded `$ORIGIN/` path (`--libnode=beside` packaging) names a
   * file beside the executable, whatever the working directory. */
  static const char origin[] = "$ORIGIN/";
  size_t skip = 0, dirlen = 0;
  ScrStr *self = NULL;
  if (path->len >= sizeof origin - 1 && memcmp(path->data, origin, sizeof origin - 1) == 0) {
    skip = sizeof origin - 1;
    self = scr_process_exec_path();
    dirlen = self->len;
    while (dirlen > 0 && self->data[dirlen - 1] != '/') dirlen--;
  }
  size_t len = dirlen + path->len - skip;
  char *p = malloc(len + 1);
  if (p == NULL) nh_oom();
  if (dirlen > 0) memcpy(p, self->data, dirlen);
  memcpy(p + dirlen, path->data + skip, path->len - skip);
  p[len] = '\0';
  if (self != NULL) scr_str_release(self);
  ScrNodeValue out;
  NhCall c = {.op = NH_LOAD, .path = p, .mode = esm, .out = &out};
  nh_run(&c);
  free(p);
  return nh_outcome(&c);
}

ScrDyn *scr_ni_require(ScrStr *path) { return nh_load(path, 0); }

ScrPromise *scr_ni_import(ScrStr *path) {
  ScrDyn *d = nh_load(path, 1);
  if (d == NULL) {
    ScrPromise *p = scr_promise_new();
    scr_promise_reject_pending(p);
    return p;
  }
  ScrPromise *p = scr_dyn_promise_of(d);
  if (p != NULL) {
    p = scr_promise_retain(p);
  } else {
    p = scr_promise_new();
    scr_promise_fulfill_ref(p, scr_dyn_retain(d), scr_dyn_retain_v, scr_dyn_release_v,
                            scr_dyn_trace_v);
  }
  scr_dyn_release(d);
  return p;
}

ScrDyn *scr_ni_get(ScrDyn *obj, ScrDyn *key) {
  if (key != NULL && key->kind == SCR_DYN_STR && (scr_ni_stub_of(obj) != NULL || nh_lazy_is(obj)))
    return scr_ni_get_str(obj, key->v.str->data, key->v.str->len);
  uint32_t id;
  if (!nh_receiver(obj, &id, "a property read")) return NULL;
  nh_enter();
  NhKeep keep = {0};
  ScrNodeValue k, out;
  if (!nh_to_node(key, &k, &keep)) {
    nh_keep_done(&keep);
    return NULL;
  }
  NhCall c = {.op = NH_GET, .h = id, .a = &k, .out = &out};
  nh_run(&c);
  nh_keep_done(&keep);
  return nh_outcome(&c);
}

ScrDyn *scr_ni_get_str(ScrDyn *obj, const char *key, size_t len) {
  /* A lazy subclass answers its name without creating the class. */
  if (nh_lazy_is(obj) && len == 4 && memcmp(key, "name", 4) == 0)
    return scr_dyn_retain(((ScrNodeRef *)obj->v.handle.ptr)->lazy[1]);
  void *stub = scr_ni_stub_of(obj);
  if (stub != NULL && scr_ni_bridge_loaded() == NULL) {
    /* Before Node starts, the interface snapshot answers what it holds. */
    ScrDyn *known = scr_ni_boot_member(stub, key, len);
    if (known != NULL) return known;
  }
  uint32_t id;
  if (!nh_receiver(obj, &id, "a property read")) return NULL;
  nh_enter();
  ScrNodeValue k = {.tag = SCR_NV_STRING}, out;
  k.u.str.data = key;
  k.u.str.len = len;
  NhCall c = {.op = NH_GET, .h = id, .a = &k, .out = &out};
  nh_run(&c);
  return nh_outcome(&c);
}

static bool nh_set(uint32_t id, const ScrNodeValue *k, ScrDyn *value) {
  NhKeep keep = {0};
  ScrNodeValue v, out;
  if (!nh_to_node(value, &v, &keep)) {
    nh_keep_done(&keep);
    return false;
  }
  NhCall c = {.op = NH_SET, .h = id, .a = k, .b = &v, .out = &out};
  nh_run(&c);
  nh_keep_done(&keep);
  if (c.threw) {
    nh_throw_value(&out);
    return false;
  }
  return true;
}

bool scr_ni_set(ScrDyn *obj, ScrDyn *key, ScrDyn *value) {
  uint32_t id;
  if (!nh_receiver(obj, &id, "a property write")) return false;
  nh_enter();
  NhKeep keep = {0};
  ScrNodeValue k;
  if (!nh_to_node(key, &k, &keep)) {
    nh_keep_done(&keep);
    return false;
  }
  bool ok = nh_set(id, &k, value);
  nh_keep_done(&keep);
  return ok;
}

bool scr_ni_set_str(ScrDyn *obj, const char *key, size_t len, ScrDyn *value) {
  uint32_t id;
  if (!nh_receiver(obj, &id, "a property write")) return false;
  nh_enter();
  ScrNodeValue k = {.tag = SCR_NV_STRING};
  k.u.str.data = key;
  k.u.str.len = len;
  return nh_set(id, &k, value);
}

static int nh_bool_op(int op, ScrDyn *obj, ScrDyn *key, const char *what) {
  uint32_t id;
  if (!nh_receiver(obj, &id, what)) return -1;
  nh_enter();
  NhKeep keep = {0};
  ScrNodeValue k, out;
  if (!nh_to_node(key, &k, &keep)) {
    nh_keep_done(&keep);
    return -1;
  }
  NhCall c = {.op = op, .h = id, .a = &k, .out = &out};
  nh_run(&c);
  nh_keep_done(&keep);
  if (c.threw) {
    nh_throw_value(&out);
    return -1;
  }
  return out.tag == SCR_NV_BOOL && out.u.boolean ? 1 : 0;
}

int scr_ni_has(ScrDyn *obj, ScrDyn *key) { return nh_bool_op(NH_HAS, obj, key, "the 'in' operator"); }

int scr_ni_delete(ScrDyn *obj, ScrDyn *key) { return nh_bool_op(NH_DEL, obj, key, "delete"); }

/* Converts call arguments; NULL with an exception pending on failure. */
static ScrNodeValue *nh_args(ScrDyn *const *args, size_t argc, ScrNodeValue *small, NhKeep *keep) {
  ScrNodeValue *values = argc <= 8 ? small : malloc(argc * sizeof *values);
  if (values == NULL) nh_oom();
  for (size_t i = 0; i < argc; i++) {
    if (!nh_to_node(args[i], &values[i], keep)) {
      if (values != small) free(values);
      return NULL;
    }
  }
  return values;
}

static ScrDyn *nh_call(int op, uint32_t id, ScrDyn *this_, const ScrNodeValue *key,
                       ScrDyn *const *args, size_t argc) {
  nh_enter();
  NhKeep keep = {0};
  ScrNodeValue small[8], recv, out;
  ScrNodeValue *values = nh_args(args, argc, small, &keep);
  if (values == NULL) {
    nh_keep_done(&keep);
    return NULL;
  }
  const ScrNodeValue *a = key;
  if (op == NH_INVOKE) {
    if (!nh_to_node(this_, &recv, &keep)) {
      if (values != small) free(values);
      nh_keep_done(&keep);
      return NULL;
    }
    a = &recv;
  }
  NhCall c = {.op = op, .h = id, .a = a, .args = values, .argc = argc, .out = &out};
  nh_run(&c);
  if (values != small) free(values);
  nh_keep_done(&keep);
  return nh_outcome(&c);
}

ScrDyn *scr_ni_call(ScrDyn *fn, ScrDyn *this_, ScrDyn *const *args, size_t argc) {
  uint32_t id;
  if (!nh_receiver(fn, &id, "a call")) return NULL;
  return nh_call(NH_INVOKE, id, this_, NULL, args, argc);
}

ScrDyn *scr_ni_call_method(ScrDyn *obj, const char *key, size_t len, ScrDyn *const *args,
                           size_t argc) {
  uint32_t id;
  if (!nh_receiver(obj, &id, "a method call")) return NULL;
  ScrNodeValue k = {.tag = SCR_NV_STRING};
  k.u.str.data = key;
  k.u.str.len = len;
  return nh_call(NH_INVOKE_METHOD, id, NULL, &k, args, argc);
}

ScrDyn *scr_ni_construct(ScrDyn *ctor, ScrDyn *const *args, size_t argc) {
  uint32_t id;
  if (!nh_receiver(ctor, &id, "new")) return NULL;
  return nh_call(NH_CONSTRUCT, id, NULL, NULL, args, argc);
}

ScrStr *scr_ni_typeof(ScrDyn *value) {
  ScrNodeRef *ref = nh_ref_of(value);
  if (ref == NULL) return scr_dyn_typeof(value);
  const char *s = (ref->flags & SCR_NVF_FUNCTION) ? "function"
                  : (ref->flags & SCR_NVF_SYMBOL) ? "symbol"
                                                  : "object";
  return scr_str_new(s, strlen(s));
}

int scr_ni_instanceof(ScrDyn *value, ScrDyn *ctor) {
  /* A stub class before Node starts: no island object exists yet, and a
   * native value crossing into Node is never an instance of an ordinary
   * island class (the snapshot says whether the class is one). */
  void *stub = scr_ni_stub_of(ctor);
  if (stub != NULL && scr_ni_bridge_loaded() == NULL && !scr_ni_is_handle(value) &&
      scr_ni_boot_plain_class(stub))
    return 0;
  /* A lazy subclass has no instances yet, and a native value is never one
   * (its prototype chain is the subclass's own). */
  if (nh_lazy_is(ctor) && !scr_ni_is_handle(value)) return 0;
  uint32_t id;
  if (!nh_receiver(ctor, &id, "instanceof")) return -1;
  nh_enter();
  NhKeep keep = {0};
  ScrNodeValue v, out;
  if (!nh_to_node(value, &v, &keep)) {
    nh_keep_done(&keep);
    return -1;
  }
  NhCall c = {.op = NH_INSTANCEOF, .h = id, .a = &v, .out = &out};
  nh_run(&c);
  nh_keep_done(&keep);
  if (c.threw) {
    nh_throw_value(&out);
    return -1;
  }
  return out.tag == SCR_NV_BOOL && out.u.boolean ? 1 : 0;
}

ScrDyn *scr_ni_own_keys(ScrDyn *obj, int mode) {
  uint32_t id;
  if (!nh_receiver(obj, &id, "Object.keys")) return NULL;
  nh_enter();
  ScrNodeValue out;
  NhCall c = {.op = NH_KEYS, .h = id, .mode = mode, .out = &out};
  nh_run(&c);
  ScrDyn *array = nh_outcome(&c);
  if (array == NULL) return NULL;
  /* A fresh V8 array of keys: read its elements, then let it go. */
  ScrDyn *keys = scr_dyn_new_arr();
  ScrDyn *length = scr_ni_get_str(array, "length", 6);
  double n = length != NULL && length->kind == SCR_DYN_NUM ? length->v.num : 0;
  if (length != NULL) scr_dyn_release(length);
  for (double i = 0; i < n; i++) {
    ScrDyn *index = scr_dyn_new_num(i);
    ScrDyn *key = scr_ni_get(array, index);
    scr_dyn_release(index);
    if (key == NULL) {
      scr_dyn_release(keys);
      scr_dyn_release(array);
      return NULL;
    }
    scr_dyn_arr_push(keys, key);
  }
  scr_dyn_release(array);
  return keys;
}

ScrPromise *scr_ni_await(ScrDyn *value) {
  ScrPromise *boxed = value != NULL ? scr_dyn_promise_of(value) : NULL;
  if (boxed != NULL) return scr_promise_retain(boxed);
  ScrNodeRef *ref = nh_ref_of(value);
  if (ref != NULL && !nh_live(ref)) {
    ScrPromise *p = scr_promise_new();
    scr_promise_reject_pending(p);
    return p;
  }
  ScrPromise *p = scr_promise_new();
  if (ref == NULL) {
    scr_promise_fulfill_ref(p, scr_dyn_retain(value != NULL ? value : scr_dyn_undefined()),
                            scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    return p;
  }
  nh_enter();
  ScrNodeValue v = {.tag = SCR_NV_HANDLE, .flags = ref->flags}, thrown;
  v.u.handle = ref->id;
  uint32_t token = nh_wait(p);
  if (nh_then(&v, token, &thrown) != 0) {
    nh_throw_value(&thrown);
    scr_promise_reject_pending(p);
  }
  return p;
}

bool scr_ni_is_function(const ScrDyn *value) {
  ScrNodeRef *ref = nh_ref_of(value);
  return ref != NULL && (ref->flags & SCR_NVF_FUNCTION) != 0;
}

/* Node's util.inspect, loaded once and held for the program's life. */
static ScrDyn *nh_inspect_fn = NULL;

ScrStr *scr_ni_inspect(const ScrDyn *value, double recurse, double depth) {
  ScrNodeRef *ref = nh_ref_of(value);
  if (ref == NULL) return scr_str_new("", 0);
  if (!nh_live(ref)) return scr_str_new("", 0);
  if (nh_inspect_fn == NULL) {
    ScrStr *util = scr_str_new("node:util", 9);
    ScrDyn *module = nh_load(util, 0);
    scr_str_release(util);
    if (module == NULL) return scr_str_new("", 0);
    nh_inspect_fn = scr_ni_get_str(module, "inspect", 7);
    scr_dyn_release(module);
    if (nh_inspect_fn == NULL) return scr_str_new("", 0);
  }
  /* The remaining depth, as util.inspect counts it (null: unlimited). */
  char options[64];
  double left = depth - recurse;
  if (left != left || left > 1e9)
    snprintf(options, sizeof options, "{\"depth\":null}");
  else
    snprintf(options, sizeof options, "{\"depth\":%.0f}", left < 0 ? 0 : left);
  ScrNodeValue args[2], out;
  memset(args, 0, sizeof args);
  args[0].tag = SCR_NV_HANDLE;
  args[0].flags = ref->flags;
  args[0].u.handle = ref->id;
  args[1].tag = SCR_NV_JSON;
  args[1].u.str.data = options;
  args[1].u.str.len = strlen(options);
  ScrNodeRef *fn = nh_ref_of(nh_inspect_fn);
  nh_enter();
  NhCall c = {.op = NH_INVOKE, .h = fn->id, .a = NULL, .args = args, .argc = 2, .out = &out};
  nh_run(&c);
  ScrDyn *text = nh_outcome(&c);
  if (text == NULL) return scr_str_new("", 0);
  ScrStr *s = text->kind == SCR_DYN_STR ? scr_str_retain(text->v.str) : scr_str_new("", 0);
  scr_dyn_release(text);
  return s;
}

/* The conversions for scr_node_island_export.c: what a value_out keeps
 * alive lives until the next value_out (the bridge reads it at once). */
static NhKeep nh_out_keep;

bool scr_ni_value_out(ScrDyn *v, ScrNodeValue *out) {
  NhKeep old = nh_out_keep;
  memset(&nh_out_keep, 0, sizeof nh_out_keep);
  nh_keep_done(&old);
  return nh_to_node(v, out, &nh_out_keep);
}

/* NI-6: a conversion whose keep belongs to the caller, for values the
 * runtime pushes into Node between other conversions (shared modules). */
void *scr_ni_value_out_begin(ScrDyn *v, ScrNodeValue *out, bool *ok) {
  NhKeep *k = calloc(1, sizeof *k);
  if (k == NULL) nh_oom();
  *ok = nh_to_node(v, out, k);
  return k;
}

void scr_ni_value_out_end(void *keep) {
  nh_keep_done(keep);
  free(keep);
}

ScrDyn *scr_ni_value_in(const ScrNodeValue *v) {
  ScrDyn *d = nh_from_node(v);
  return d != NULL ? d : scr_dyn_retain(scr_dyn_undefined());
}

/* ── island arrays as copies (results typed as arrays of copied values) ─
 * An island array whose declared native type is an array of primitives or
 * strings (or arrays of those) crosses as a copy of its elements, the
 * values the checked cast then meets; nested island arrays copy too, any
 * other value (a native export coming back, an island object) is itself. */
ScrDyn *scr_node_island_copy_arrays(ScrDyn *value) {
  ScrNodeRef *ref = nh_ref_of(value);
  if (ref == NULL || (ref->flags & SCR_NVF_ARRAY) == 0) return scr_dyn_retain(value);
  ScrDyn *len = scr_ni_get_str(value, "length", 6);
  if (len == NULL) return NULL;
  double n = len->kind == SCR_DYN_NUM ? len->v.num : 0;
  scr_dyn_release(len);
  ScrDyn *out = scr_dyn_new_arr();
  for (double i = 0; i < n; i++) {
    ScrDyn *key = scr_dyn_new_num(i);
    ScrDyn *element = scr_ni_get(value, key);
    scr_dyn_release(key);
    ScrDyn *copy = element != NULL ? scr_node_island_copy_arrays(element) : NULL;
    scr_dyn_release(element);
    if (copy == NULL) {
      scr_dyn_release(out);
      return NULL;
    }
    scr_dyn_arr_push(out, copy);
  }
  return out;
}

static void nh_copy_fulfilled(ScrPromise *dst, ScrPromise *src) {
  ScrDyn *payload = scr_promise_payload_is_dyn(src) ? (ScrDyn *)scr_promise_payload_ref(src)
                                                    : scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *copy = scr_node_island_copy_arrays(payload);
  scr_dyn_release(payload);
  if (copy == NULL) {
    scr_promise_reject_pending(dst);
    return;
  }
  scr_promise_fulfill_ref(dst, copy, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
}

/* `await` of an island promise whose declared result holds arrays: the
 * fulfillment value's island arrays copied (inside the settlement, so no
 * reaction turn is added), rejections as they are. +1 promise<dyn>. */
ScrPromise *scr_node_island_await_copy(ScrDyn *value) {
  ScrPromise *src = scr_ni_await(value);
  ScrPromise *dst = scr_promise_new();
  scr_promise_mark_handled(src);
  scr_promise_race_add(dst, src, nh_copy_fulfilled);
  scr_promise_release(src);
  return dst;
}

uint32_t scr_ni_live_handles(void) {
  const ScrNodeBridge *b = scr_ni_bridge_loaded();
  if (b == NULL) return 0;
  nh_drain_freed();
  nh_sweep();
  return b->live_handles();
}

void scr_ni_stop(void) { ni_stopped = true; }

/* ── the handle tag (dynamic code over island values) ────────────────── */

static ScrDyn *nh_op_get(void *h, const char *key, size_t key_len) {
  ScrDyn *box = scr_dyn_new_handle(h, SCR_DYNH_NODE_ISLAND);
  ScrDyn *result = scr_ni_get_str(box, key, key_len);
  scr_dyn_release(box);
  return result;
}

static bool nh_op_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  ScrDyn *box = scr_dyn_new_handle(h, SCR_DYNH_NODE_ISLAND);
  scr_ni_set_str(box, key, key_len, (ScrDyn *)value);
  scr_dyn_release(box);
  return true; /* handled; a throw stays pending */
}

/* obj.m(...) from dynamic code: the member read, then the call with obj
 * as the receiver; a member that is not a function throws Node's TypeError
 * with the call site's text (`what`), as V8 words it. */
static ScrDyn *nh_op_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                            size_t argc, const char *what) {
  (void)h;
  ScrDyn *fn = scr_ni_get_str(self, method, strlen(method));
  if (fn == NULL) return NULL;
  if (!scr_ni_is_function(fn)) {
    scr_dyn_release(fn);
    char message[512];
    snprintf(message, sizeof message, "%s is not a function", what != NULL ? what : method);
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
    return NULL;
  }
  ScrDyn *result = scr_ni_call(fn, self, args, argc);
  scr_dyn_release(fn);
  return result;
}

static ScrDyn *nh_op_symbol_get(void *h, const ScrDyn *key) {
  if (!scr_ni_is_handle(key)) return NULL;
  ScrDyn *box = scr_dyn_new_handle(h, SCR_DYNH_NODE_ISLAND);
  ScrDyn *result = scr_ni_get(box, (ScrDyn *)key);
  scr_dyn_release(box);
  return result;
}

/* The host's ToPrimitive (scr_node_island_host.cjs), loaded once. */
static ScrDyn *nh_to_primitive_fn = NULL;

/* ToPrimitive of an island object, run by V8: Symbol.toPrimitive, then
 * toString/valueOf in the hint's order, with V8's TypeErrors. */
ScrDyn *scr_ni_to_primitive(const ScrDyn *self, int hint) {
  if (nh_to_primitive_fn == NULL) {
    ScrStr *name = scr_str_new("scriptc:toPrimitive", 19);
    nh_to_primitive_fn = nh_load(name, 0);
    scr_str_release(name);
    if (nh_to_primitive_fn == NULL) return NULL;
  }
  static const char *const hints[] = {"default", "number", "string"};
  const char *text = hints[hint >= 0 && hint <= 2 ? hint : 0];
  ScrStr *hs = scr_str_new(text, strlen(text));
  ScrDyn *args[2] = {(ScrDyn *)self, scr_dyn_new_str(hs)};
  scr_str_release(hs);
  ScrDyn *result = scr_ni_call(nh_to_primitive_fn, scr_dyn_undefined(), args, 2);
  scr_dyn_release(args[1]);
  return result;
}

/* The host's spread helper (`[...value]`), loaded once. */
static ScrDyn *nh_spread_fn = NULL;

/* Spread of an island value (`[...x]`, `f(...x)`): V8 drives the
 * iterator protocol, and the elements cross one by one into a fresh dyn
 * array (objects stay handles). +1, or NULL with the exception pending. */
static ScrDyn *nh_op_iter_pack(void *h) {
  if (nh_spread_fn == NULL) {
    ScrStr *name = scr_str_new("scriptc:spread", 14);
    nh_spread_fn = nh_load(name, 0);
    scr_str_release(name);
    if (nh_spread_fn == NULL) return NULL;
  }
  ScrDyn *box = scr_dyn_new_handle(h, SCR_DYNH_NODE_ISLAND);
  ScrDyn *items = scr_ni_call(nh_spread_fn, scr_dyn_undefined(), &box, 1);
  scr_dyn_release(box);
  if (items == NULL) return NULL;
  ScrDyn *length = scr_ni_get_str(items, "length", 6);
  if (length == NULL) {
    scr_dyn_release(items);
    return NULL;
  }
  size_t n = length->kind == SCR_DYN_NUM && length->v.num > 0 ? (size_t)length->v.num : 0;
  scr_dyn_release(length);
  ScrDyn *out = scr_dyn_new_arr();
  for (size_t i = 0; i < n; i++) {
    ScrDyn *key = scr_dyn_new_num((double)i);
    ScrDyn *item = scr_ni_get(items, key);
    scr_dyn_release(key);
    if (item == NULL) {
      scr_dyn_release(out);
      scr_dyn_release(items);
      return NULL;
    }
    scr_dyn_arr_push(out, item);
  }
  scr_dyn_release(items);
  return out;
}

static const ScrDynHandleOps nh_ops = {
    .cls = "Object",
    .retain = nh_ref_retain_v,
    .release = nh_ref_release_v,
    .invoke = nh_op_invoke,
    .get = nh_op_get,
    .set = nh_op_set,
    .symbol_get = nh_op_symbol_get,
    .iter_pack = nh_op_iter_pack,
};

/* At exit: what the unit itself still holds (pins, unsettled waiters,
 * util.inspect), so the runtime's reference audit sees only the program's
 * own objects. */
static void nh_cleanup(void) {
  nh_drain_freed();
  if (nh_inspect_fn != NULL) {
    scr_dyn_release(nh_inspect_fn);
    nh_inspect_fn = NULL;
  }
  if (nh_to_primitive_fn != NULL) {
    scr_dyn_release(nh_to_primitive_fn);
    nh_to_primitive_fn = NULL;
  }
  if (nh_spread_fn != NULL) {
    scr_dyn_release(nh_spread_fn);
    nh_spread_fn = NULL;
  }
  while (nh_npins > 0) {
    NhPin pin = nh_pins[--nh_npins];
    nh_pin_release_obj(&pin);
    nh_ref_release(pin.ref);
  }
  while (nh_nwaiters > 0) scr_promise_release(nh_waiters[--nh_nwaiters].promise);
  free(nh_pins);
  free(nh_waiters);
  nh_pins = NULL;
  nh_waiters = NULL;
  nh_pins_cap = nh_waiters_cap = 0;
}

void scr_ni_handles_install(void) {
  static bool installed = false;
  if (installed) return;
  installed = true;
  scr_dyn_handle_install(SCR_DYNH_NODE_ISLAND, &nh_ops);
  scr_atexit(nh_cleanup);
}

/* ── NI-4d: util.types, Array.isArray and uncaught reports ─────────────── */

static ScrDyn *nh_util_types = NULL; /* Node's util.types (held to exit) */

static void nh_util_types_cleanup(void) {
  scr_dyn_release(nh_util_types);
  nh_util_types = NULL;
}

bool scr_ni_util_type_is(const ScrDyn *value, const ScrStr *probe) {
  if (nh_util_types == NULL) {
    ScrStr *path = scr_str_new("node:util", 9);
    ScrDyn *util = scr_ni_require(path);
    scr_str_release(path);
    if (util == NULL) return false;
    nh_util_types = scr_ni_get_str(util, "types", 5);
    if (nh_util_types != NULL) scr_atexit(nh_util_types_cleanup);
    scr_dyn_release(util);
    if (nh_util_types == NULL) return false;
  }
  ScrDyn *args[1] = {(ScrDyn *)value};
  ScrDyn *r = scr_ni_call_method(nh_util_types, probe->data, probe->len, args, 1);
  if (r == NULL) return false;
  bool answer = r->kind == SCR_DYN_BOOL && r->v.b;
  scr_dyn_release(r);
  return answer;
}

bool scr_ni_is_array(ScrDyn *value) {
  if (value == NULL) return false;
  if (value->kind == SCR_DYN_ARR) return true;
  if (!scr_ni_is_handle(value)) return value->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(value);
  return (((ScrNodeRef *)value->v.handle.ptr)->flags & SCR_NVF_ARRAY) != 0;
}

bool scr_ni_report_uncaught(ScrError *error) {
  ScrNodeRef *ref = nh_pinned(error, NH_PIN_ERROR);
  const ScrNodeBridge *bridge = scr_ni_bridge_loaded();
  if (ref == NULL || ref->id == 0 || bridge == NULL) return false;
  ScrNodeErrorInfo info;
  bridge->error_info(ref->id, &info);
  if (info.stack == NULL) return false;
  if (info.arrow != NULL && info.arrow_len > 0) {
    fwrite(info.arrow, 1, info.arrow_len, stderr);
    fputs("\n\n", stderr);
  }
  fwrite(info.stack, 1, info.stack_len, stderr);
  fprintf(stderr, "\n\nNode.js v%s\n", bridge->node_version);
  fflush(stderr);
  return true;
}

/* ── NI-4a: libCall entry points of compiled island code ─────────────────
 * The compiler (frontend/lowering/lower-node-island.ts) lowers member
 * operations on island values to `nodeIsland.*` libCalls, which pass
 * strings as ScrStr and argument lists as one dyn array; these adapt them
 * to the scr_ni_* API above. Borrowed arguments, +1 results, NULL (or a
 * pending exception) when JavaScript threw. */

static size_t ni_libcall_args(ScrDyn *args, ScrDyn *const **items) {
  if (args == NULL || args->kind != SCR_DYN_ARR) {
    *items = NULL;
    return 0;
  }
  *items = args->v.arr.items;
  return args->v.arr.len;
}

/* Routing follows the value: a value typed by an island's declarations
 * may still be a native object (an island interface annotating a native
 * literal, a native error handed to an island callback). Those take the
 * ordinary checked-dynamic operations instead of the bridge. */
ScrDyn *scr_dyn_reflect_get(ScrDyn *target, ScrDyn *raw_key, ScrDyn *receiver);

static bool ni_lc_island(const ScrDyn *v) { return v != NULL && scr_ni_is_handle(v); }

/* A NUL-terminated copy of `key` for the dyn invoke path (heap only for long names). */
static ScrDyn *ni_lc_native_invoke(ScrDyn *obj, ScrStr *key, ScrDyn *const *items, size_t argc) {
  char small[128];
  char *name = key->len < sizeof small ? small : malloc(key->len + 1);
  if (name == NULL) scr_trap("scriptc: out of memory\n");
  memcpy(name, key->data, key->len);
  name[key->len] = '\0';
  ScrDyn *result = scr_dyn_invoke(obj, name, items, argc, name);
  if (name != small) free(name);
  return result;
}

ScrDyn *scr_node_island_get(ScrDyn *obj, ScrStr *key) {
  if (ni_lc_island(obj)) return scr_ni_get_str(obj, key->data, key->len);
  ScrDyn *k = scr_dyn_new_str(key);
  ScrDyn *value = scr_dyn_reflect_get(obj, k, obj);
  scr_dyn_release(k);
  return value;
}

ScrDyn *scr_node_island_get_key(ScrDyn *obj, ScrDyn *key) {
  if (ni_lc_island(obj)) return scr_ni_get(obj, key);
  return scr_dyn_reflect_get(obj, key, obj);
}

void scr_node_island_set(ScrDyn *obj, ScrStr *key, ScrDyn *value) {
  if (ni_lc_island(obj)) (void)scr_ni_set_str(obj, key->data, key->len, value);
  else scr_dyn_key_set(obj, key, value);
}

void scr_node_island_set_key(ScrDyn *obj, ScrDyn *key, ScrDyn *value) {
  if (ni_lc_island(obj)) (void)scr_ni_set(obj, key, value);
  else scr_dyn_key_set_computed(obj, key, value);
}

ScrDyn *scr_node_island_invoke(ScrDyn *obj, ScrStr *key, ScrDyn *args) {
  ScrDyn *const *items;
  size_t argc = ni_libcall_args(args, &items);
  if (ni_lc_island(obj)) return scr_ni_call_method(obj, key->data, key->len, items, argc);
  return ni_lc_native_invoke(obj, key, items, argc);
}

ScrDyn *scr_node_island_apply(ScrDyn *fn, ScrDyn *args) {
  ScrDyn *const *items;
  size_t argc = ni_libcall_args(args, &items);
  if (ni_lc_island(fn)) return scr_ni_call(fn, NULL, items, argc);
  return scr_dyn_call(fn, items, argc, "value");
}

ScrDyn *scr_node_island_construct(ScrDyn *ctor, ScrDyn *args) {
  if (!ni_lc_island(ctor)) {
    ScrStr *what = scr_str_new("value", 5);
    ScrDyn *result = scr_dyn_construct(ctor, args, what);
    scr_str_release(what);
    return result;
  }
  ScrDyn *const *items;
  size_t argc = ni_libcall_args(args, &items);
  return scr_ni_construct(ctor, items, argc);
}

bool scr_node_island_instanceof(ScrDyn *value, ScrDyn *ctor) {
  return scr_ni_instanceof(value, ctor) == 1;
}

#endif /* !_WIN32 && !__wasi__ */
