/* WeakRef (ECMAScript 2021, decision islands-globals 2a = B): a weak
 * reference over the native heap's dispose observers, the same free-time
 * notification the native WeakMap and WeakSet use.
 *
 * A cell holds the referent's *identity* and rebuild recipe, never a
 * reference: the record a checked-native capsule views (rebuild the
 * capsule over the same pointer, so the checked cast unboxes to the same
 * record and `ref.deref() === target` holds), or the dyn box itself for a
 * plain object, array or proxy (whose address is the identity its own
 * disposal reports). When the native heap frees the referent — the last
 * release, a cycle collection, or a region teardown — scr_json.c's
 * dispose observers hand the address here and every cell over it answers
 * undefined from deref() from then on.
 *
 * Calling `new WeakRef(target)` and `deref()` also AddToKeptObjects: the
 * target joins this thread's kept list, which a microtask queued on the
 * first add of a turn releases. That ends the list at or after the end of
 * the current job, as ClearKeptObjects requires (keeping longer is always
 * allowed), so a target created only to be watched — `new WeakRef({})
 * .deref()` — is still there within its job. The exit teardown releases
 * whatever the last job kept, so the list never outlives the heap.
 *
 * The differential corpus pins only the deterministic cases (a target
 * held elsewhere, identity, the TypeErrors, String/inspect/JSON), because
 * collection timing is not observable in a portable program; a C unit
 * test (scr_weakref.test.c) drives the free-time hook directly.
 *
 * Linked only into programs that construct a WeakRef (the weakRef runtime
 * feature); scr_json.c's observer arms are part of the SCR_WEAK_REF build
 * of that unit alone. A symbol target asks the symbol unit's registry check,
 * so the program links scr_symbol.c as well (executable.ts's unit table);
 * scr_symbol.c itself is unchanged by this feature. */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>

typedef struct ScrWeakRef {
  size_t rc;
  /* The referent's identity, or NULL once the referent was freed. */
  void *key;
  /* How deref() rebuilds a value over the referent: a checked-native
   * capsule's adapters and type key, or the dyn box itself (`box`). */
  void *(*retain)(void *);
  void (*release)(void *);
  const char *type_key;
  size_t type_key_len;
  ScrDyn *(*materialize)(void *);
  void (*commit)(void *, const ScrDyn *);
  bool box;
  bool traced;
  struct ScrWeakRef *next; /* the table bucket's chain */
} ScrWeakRef;

/* Live cells in this thread's table (the WeakRefs whose target is still
 * alive). scr_json.c's observers test it before calling in. */
SCR_TL size_t scr_weakref_live;
static SCR_TL ScrWeakRef **scr_weakref_buckets;
static SCR_TL size_t scr_weakref_mask; /* capacity - 1 */

static void scr_weakref_oom(void) { scr_trap("scriptc: out of memory\n"); }

/* Mixed in 64 bits on every identity: uintptr_t is 32 bits on wasm32,
 * where the shifts would exceed its width. */
static size_t scr_weakref_hash(const void *key) {
  uint64_t bits = (uint64_t)(uintptr_t)key;
  bits ^= bits >> 33;
  bits *= UINT64_C(0xff51afd7ed558ccd);
  bits ^= bits >> 29;
  return (size_t)bits;
}

/* Indexes `ref` (its key set) into this thread's table, growing it at half
 * load. The table is freed when its last cell leaves. */
static void scr_weakref_insert(ScrWeakRef *ref) {
  if (!scr_weakref_buckets || (scr_weakref_live + 1) * 2 > scr_weakref_mask + 1) {
    ScrWeakRef **old = scr_weakref_buckets;
    size_t n = old ? scr_weakref_mask + 1 : 0, cap = n ? n * 2 : 16;
    ScrWeakRef **grown = calloc(cap, sizeof *grown);
    if (!grown) scr_weakref_oom();
    for (size_t i = 0; i < n; i++) {
      ScrWeakRef *cell = old[i];
      while (cell) {
        ScrWeakRef *next = cell->next;
        size_t slot = scr_weakref_hash(cell->key) & (cap - 1);
        cell->next = grown[slot];
        grown[slot] = cell;
        cell = next;
      }
    }
    free(old);
    scr_weakref_buckets = grown;
    scr_weakref_mask = cap - 1;
  }
  size_t slot = scr_weakref_hash(ref->key) & scr_weakref_mask;
  ref->next = scr_weakref_buckets[slot];
  scr_weakref_buckets[slot] = ref;
  scr_weakref_live++;
}

/* Takes a live cell out of the table. A cleared cell (key NULL) is
 * already out. */
static void scr_weakref_unlink(ScrWeakRef *ref) {
  if (!ref->key || !scr_weakref_buckets) return;
  ScrWeakRef **slot = &scr_weakref_buckets[scr_weakref_hash(ref->key) & scr_weakref_mask];
  while (*slot && *slot != ref) slot = &(*slot)->next;
  if (*slot != ref) return;
  *slot = ref->next;
  ref->next = NULL;
  if (--scr_weakref_live == 0) {
    free(scr_weakref_buckets);
    scr_weakref_buckets = NULL;
    scr_weakref_mask = 0;
  }
}

/* A referent was freed. Every cell over it clears; its deref answers
 * undefined from now on. Cells stay owned by their handles. */
void scr_weakref_disposed(void *key) {
  if (!scr_weakref_buckets) return;
  ScrWeakRef **slot = &scr_weakref_buckets[scr_weakref_hash(key) & scr_weakref_mask];
  while (*slot) {
    ScrWeakRef *ref = *slot;
    if (ref->key != key) {
      slot = &ref->next;
      continue;
    }
    *slot = ref->next;
    ref->next = NULL;
    ref->key = NULL;
    ref->retain = NULL;
    ref->release = NULL;
    ref->type_key = NULL;
    ref->type_key_len = 0;
    ref->materialize = NULL;
    ref->commit = NULL;
    ref->box = false;
    ref->traced = false;
    if (--scr_weakref_live == 0) {
      free(scr_weakref_buckets);
      scr_weakref_buckets = NULL;
      scr_weakref_mask = 0;
      return;
    }
  }
}

/* ── the kept list (AddToKeptObjects) ───────────────────────────────── */

static SCR_TL ScrDyn **scr_weakref_kept;
static SCR_TL size_t scr_weakref_kept_len, scr_weakref_kept_cap;
static SCR_TL bool scr_weakref_kept_queued;
static SCR_TL bool scr_weakref_teardown_armed;

/* ClearKeptObjects: releases every target the job kept. */
static void scr_weakref_kept_release_all(void) {
  for (size_t i = 0; i < scr_weakref_kept_len; i++) scr_dyn_release(scr_weakref_kept[i]);
  scr_weakref_kept_len = 0;
}

/* The program's exit (or the library's reset) releases what a last job
 * still kept, so a WeakRef costs a program nothing once it stops running:
 * without this the last job's targets would outlive the heap's audit. */
static void scr_weakref_teardown(void) {
  scr_weakref_kept_queued = false;
  scr_weakref_kept_release_all();
  free(scr_weakref_kept);
  scr_weakref_kept = NULL;
  scr_weakref_kept_cap = 0;
}

#ifndef SCR_LIB
/* The clear runs as a microtask, so the targets stay alive to the end of
 * the job that added them. */
static void scr_weakref_kept_clear(ScrClosure *job) {
  (void)job;
  scr_weakref_kept_queued = false;
  scr_weakref_kept_release_all();
}

/* The end of the job without a microtask queue (scr_weakref.test.c): the
 * clear job the queue would have run. */
void scr_weakref_test_end_job(void) { scr_weakref_kept_clear(NULL); }
#endif

/* Keeps `target` (borrowed) alive to the end of this job, and arms the
 * teardown that releases a last job's kept targets at exit (or at the
 * library's reset). A library build has no microtask queue (scr_async.c is
 * not part of a library flavor), so its kept targets stay alive to the end
 * of the library's lifetime: longer than the spec requires, which it always
 * allows, and the only answer that never reports a target that is still
 * reachable as collected. */
static void scr_weakref_keep(ScrDyn *target) {
  if (scr_weakref_kept_len == scr_weakref_kept_cap) {
    size_t cap = scr_weakref_kept_cap ? scr_weakref_kept_cap * 2 : 8;
    ScrDyn **grown = realloc(scr_weakref_kept, cap * sizeof *grown);
    if (!grown) scr_weakref_oom();
    scr_weakref_kept = grown;
    scr_weakref_kept_cap = cap;
  }
  scr_weakref_kept[scr_weakref_kept_len++] = scr_dyn_retain(target);
  if (!scr_weakref_teardown_armed) {
    scr_weakref_teardown_armed = true;
    scr_atexit(scr_weakref_teardown);
  }
#ifdef SCR_LIB
  (void)0;
#else
  if (!scr_weakref_kept_queued) {
    scr_weakref_kept_queued = true;
    scr_queue_microtask(scr_closure_new((void *)&scr_weakref_kept_clear, 0));
  }
#endif
}

/* ── the handle ─────────────────────────────────────────────────────── */

static void *scr_weakref_retain(void *ptr) {
  ((ScrWeakRef *)ptr)->rc++;
  return ptr;
}

static void scr_weakref_release(void *ptr) {
  ScrWeakRef *ref = ptr;
  if (--ref->rc) return;
  scr_weakref_unlink(ref);
  free(ref);
}

/* deref (+1): the target while the referent lives, else undefined. A
 * returned target joins the kept list, so the rest of the job sees the
 * same answer Node's AddToKeptObjects gives. */
static ScrDyn *scr_weakref_cell_deref(ScrWeakRef *ref) {
  if (!ref->key) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *value;
  if (ref->box) {
    value = scr_dyn_retain((ScrDyn *)ref->key);
  } else {
    /* The capsule canonicalizes on (referent, adapters, type key), so a
     * second WeakRef over the same record — and a checked cast of the
     * result — sees one identity, exactly as the original value did. */
    value = ref->traced
                ? scr_dyn_new_typed_ref_traced(ref->key, ref->retain, ref->release, ref->type_key,
                                               ref->type_key_len, ref->materialize, ref->commit)
                : scr_dyn_new_typed_ref_observed(ref->key, ref->retain, ref->release, ref->type_key,
                                                 ref->type_key_len, ref->materialize, ref->commit);
  }
  scr_weakref_keep(value);
  return value;
}

ScrDyn *scr_weakref_deref(ScrDyn *ref) {
  if (!ref || ref->kind != SCR_DYN_HANDLE || ref->v.handle.tag != SCR_DYNH_WEAK_REF)
    return scr_dyn_retain(scr_dyn_undefined());
  return scr_weakref_cell_deref(ref->v.handle.ptr);
}

static ScrDyn *scr_weakref_invoke(void *ptr, ScrDyn *self, const char *method,
                                  ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  (void)args;
  (void)argc;
  if (strcmp(method, "deref") == 0) return scr_weakref_cell_deref(ptr);
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, what ? what : method);
  scr_jb_puts(&b, " is not a function");
  ScrStr *message = scr_jb_finish(&b);
  scr_throw_error_msg(SCR_ERR_TYPE, message->data, message->len);
  scr_str_release(message);
  return NULL;
}

/* WeakRef keeps nothing in own properties; deref is the class's one
 * method and reads as a value through the methods table. */
static ScrDyn *scr_weakref_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  (void)key;
  (void)len;
  return NULL;
}

static ScrDyn *scr_weakref_view(void *ptr) {
  (void)ptr;
  return scr_dyn_new_obj();
}

static void scr_weakref_type_error(const char *message) {
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

static void scr_weakref_no_lowering(const char *message, size_t len) {
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, len, "SC2020");
}

/* Classifies the target and fills the cell's rebuild recipe. False with
 * the exception pending for a non-target. */
static bool scr_weakref_target_of(ScrWeakRef *ref, const ScrDyn *target) {
  static const char invalid_target[] = "WeakRef: invalid target";
  static const char symbol_message[] =
      "WeakRef with symbol targets has no weak lifetime lowering";
  static const char reference_message[] =
      "WeakRef targets of this native reference type have no weak lifetime lowering";
  /* A registered symbol is not a valid target (Node throws); an
   * unregistered one is, but the symbol table has no dispose observer, so
   * the target would never clear: refuse by name instead of diverging. */
  if (target->kind == SCR_DYN_SYMBOL) {
    ScrStr *registered = scr_sym_key_for(target->v.symbol.value);
    bool is_registered = registered != NULL;
    scr_str_release(registered);
    if (is_registered) scr_weakref_type_error(invalid_target);
    else scr_weakref_no_lowering(symbol_message, sizeof symbol_message - 1);
    return false;
  }
  switch (target->kind) {
  case SCR_DYN_OBJ:
    /* A view of a native record reports the record's free, not its own, and
     * a rebuilt view would not be the same object: refuse by name. A plain
     * object, and the snapshot a record conversion copies into, are their
     * own identity. */
    if (target->v.obj.source_identity) break;
    ref->key = (void *)target;
    ref->box = true;
    return true;
  case SCR_DYN_ARR:
  case SCR_DYN_PROXY:
    ref->key = (void *)target;
    ref->box = true;
    return true;
  case SCR_DYN_TYPED_REF:
    if (!target->v.typed_ref.observed) break;
    ref->key = target->v.typed_ref.ptr;
    ref->retain = target->v.typed_ref.retain;
    ref->release = target->v.typed_ref.release;
    ref->type_key = target->v.typed_ref.type_key;
    ref->type_key_len = target->v.typed_ref.type_key_len;
    ref->materialize = target->v.typed_ref.materialize;
    ref->commit = target->v.typed_ref.commit;
    ref->traced = target->v.typed_ref.traced;
    return true;
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL:
  case SCR_DYN_BOOL:
  case SCR_DYN_NUM:
  case SCR_DYN_STR:
  case SCR_DYN_BIGINT:
    scr_weakref_type_error(invalid_target);
    return false;
  default:
    break;
  }
  scr_weakref_no_lowering(reference_message, sizeof reference_message - 1);
  return false;
}

ScrDyn *scr_weakref_new(ScrDyn *target) {
  static const ScrDynHandleMethod methods[] = {
    { "deref", 0 },
    { NULL, 0 },
  };
  static const ScrDynHandleOps ops = {
    .cls = "WeakRef",
    /* String(ref) and inspect render through the ops tag: WeakRef is not one
     * of scr_json.c's pinned handle tags, and adding it there would change
     * that unit's code for every program. */
    .to_string_tag = "WeakRef",
    .retain = &scr_weakref_retain,
    .release = &scr_weakref_release,
    .invoke = &scr_weakref_invoke,
    .get = &scr_weakref_get,
    .inspect_view = &scr_weakref_view,
    .json_empty_object = true,
    .inspect_view_empty = true,
    .methods = methods,
  };
  ScrWeakRef *ref = calloc(1, sizeof *ref);
  if (!ref) scr_weakref_oom();
  if (!scr_weakref_target_of(ref, target)) {
    /* The argument is borrowed: a libCall's arguments stay the caller's
     * (scr_weak_collection_new's seed has the same contract), so a refused
     * target is not released here. */
    free(ref);
    return NULL;
  }
  ref->rc = 1;
  scr_dyn_handle_install(SCR_DYNH_WEAK_REF, &ops);
  /* The program may now observe frees: the emitted record frees test the
   * gate that weakRef.new sets, and this hook is what they reach. */
  scr_weakref_observers_install();
  scr_weakref_insert(ref);
  scr_weakref_keep(target);
  ScrDyn *result = scr_dyn_new_handle(ref, SCR_DYNH_WEAK_REF);
  scr_weakref_release(ref);
  /* scr_weakref_keep retained the borrowed argument: the kept list owns
   * that one reference and the caller keeps its own. */
  return result;
}

bool scr_weakref_is(const ScrDyn *value) {
  return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_WEAK_REF;
}
