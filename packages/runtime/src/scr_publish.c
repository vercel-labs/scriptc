/* Publication (@scriptc/threads publish): the graph walk that makes object
 * graphs immortal and immutable, and the frozen-object TypeErrors of the
 * emitted write guards. Kept out of scr_cycle.c so the collector unit links
 * without the string, number, dyn and exception runtimes. */

#include "scr_runtime.h"

#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── publication: immortal, immutable graphs (@scriptc/threads publish) ──
 * publish(root) walks everything the root reaches and makes it immortal:
 * rc == SIZE_MAX, so every retain and release skips it, the collector never
 * walks into it (SCR_CYC_SKIP) and nothing frees it, and the objects leave
 * this thread's candidate and tenured buffers. Immortal objects are never
 * written again (the emitted stores into publishable types throw the frozen-
 * object TypeError), which is what lets postMessage and workerData share
 * them with other threads by pointer.
 *
 * The compiler emits one walker per static type (llvm/publish.ts). A walker
 * marks its object through scr_pub_mark and hands every reference field to
 * scr_pub_push; containers, strings and dyn subgraphs have runtime walkers
 * here. The worklist keeps the walk iterative (parent chains and long lists
 * would overflow the stack). Every mark is logged: a refusal found later in
 * the walk (a dyn subgraph, or a value of an unpublishable static type,
 * whose emitted walker refuses) restores every logged count, so a publish
 * that throws leaves the graph unchanged, exactly like the Node.js
 * implementation, which validates before it freezes. */
/* One logged mark, 16 bytes on 64-bit targets: the log is written once per
 * object, so its size is most of the walk's memory traffic. `obj` carries
 * SCR_PUB_DYN for a dyn container frozen on success. `rc` is the count
 * before the mark, with two escapes on 64-bit targets: SCR_PUB_RC_LIFETIME
 * for the program-lifetime count (2^63), SCR_PUB_RC_BIG for any other
 * count of 32 bits or more, kept in order in ScrPub.big. */
typedef struct {
  uintptr_t obj;
  uint32_t rc;
  uint32_t buf; /* a candidate taken out of its buffer: its index + 1, else 0;
                 * SCR_PUB_LOG_COUNT: `rc` is the count of the low half */
} ScrPubLog;

/* In ScrPubLog.buf: the object keeps its class id in the high half of
 * its rc word (SCR_PUB_CLASS_ID), and `rc` is the count of the low half,
 * or it is compact (SCR_PUB_COMPACT), and `rc` is its header word. */
#define SCR_PUB_LOG_COUNT UINT32_C(0x80000000)

#define SCR_PUB_DYN ((uintptr_t)1)
#define SCR_PUB_RC_LIFETIME UINT32_C(0xfffffffe)
#define SCR_PUB_RC_BIG UINT32_C(0xffffffff)

static inline void *scr_pub_log_obj(const ScrPubLog *e) { return (void *)(e->obj & ~SCR_PUB_DYN); }

typedef struct {
  void *v;
  ScrPubFn fn;
} ScrPubItem;

/* Small graphs (an interned value whose children are already published)
 * walk within the inline buffers and allocate nothing. */
#define SCR_PUB_INLINE 32

/* The emitted walkers (llvm/publish.ts) push onto `stack` and log their
 * marks inline, through the leading word-sized fields: keep their order. */
struct ScrPub {
  ScrPubItem *stack;
  size_t len, cap;
  ScrPubLog *log;
  size_t logged, log_cap;
  const char *refusal; /* first refusal message; the walk stops */
  size_t taken; /* logged candidates taken out of their buffers */
  size_t dyns; /* logged dyn containers */
  size_t *big; /* counts SCR_PUB_RC_BIG stands for, in log order */
  size_t nbig, big_cap;
#ifdef SCR_RC_AUDIT
  uint8_t *kinds; /* per logged mark, SCR_PUB_KIND_*: leaves the audit's live count */
  size_t kinds_cap;
#endif
  ScrPubItem stack_inline[SCR_PUB_INLINE];
  ScrPubLog log_inline[SCR_PUB_INLINE];
};

_Static_assert(offsetof(ScrPub, stack) == 0 && offsetof(ScrPub, len) == sizeof(void *) &&
                   offsetof(ScrPub, cap) == 2 * sizeof(void *) && offsetof(ScrPub, log) == 3 * sizeof(void *) &&
                   offsetof(ScrPub, logged) == 4 * sizeof(void *) &&
                   offsetof(ScrPub, log_cap) == 5 * sizeof(void *) &&
                   offsetof(ScrPub, refusal) == 6 * sizeof(void *) &&
                   offsetof(ScrPub, taken) == 7 * sizeof(void *) && sizeof(ScrPubItem) == 2 * sizeof(void *) &&
                   offsetof(ScrPubLog, rc) == sizeof(void *) && sizeof(ScrPubLog) == sizeof(void *) + 8,
               "llvm/publish.ts pushes and logs at these offsets");

/* Doubles a buffer of *cap elements (256 when empty); `inline_buf` is the
 * caller's fixed first buffer, which is copied rather than reallocated. */
static void *scr_pub_grow(void *p, size_t *cap, size_t size, void *inline_buf) {
  size_t n = *cap ? *cap * 2 : 256;
  void *q;
  if (p != NULL && p == inline_buf) {
    q = malloc(n * size);
    if (q) memcpy(q, p, *cap * size);
  } else {
    q = realloc(p, n * size);
  }
  if (!q) scr_trap("scriptc: out of memory\n");
  *cap = n;
  return q;
}

void scr_pub_str_fn(void *v, ScrPub *ctx);

void scr_pub_push(ScrPub *ctx, void *v, ScrPubFn fn) {
  if (!v || SCR_RC_PUBLISHED(v) || ctx->refusal) return;
  if (fn == scr_pub_str_fn) { /* a leaf: mark it now */
    scr_pub_str_fn(v, ctx);
    return;
  }
  if (ctx->len == ctx->cap)
    ctx->stack = scr_pub_grow(ctx->stack, &ctx->cap, sizeof *ctx->stack, ctx->stack_inline);
  ctx->stack[ctx->len].v = v;
  ctx->stack[ctx->len].fn = fn;
  ctx->len++;
}

/* Marks `obj` immortal and logs its count. A candidate leaves its buffer
 * here, while its header is in cache, so committing the publish does not
 * touch the objects again. */
bool scr_pub_mark(ScrPub *ctx, void *obj, bool cyc, int kind) {
  size_t *rc = obj;
  if (SCR_RC_PUBLISHED(obj) || ctx->refusal) return false;
  bool compact = (kind & SCR_PUB_COMPACT) != 0;
  /* Both log the low 32 bits: a count, or a compact header word. An
   * object with a layout id in its rc word (scr_rc_layout_id) keeps it, as
   * a class instance keeps its class id. */
  bool class_id = compact || (kind & SCR_PUB_CLASS_ID) != 0 || scr_rc_layout_id(obj) != 0;
  kind &= ~(SCR_PUB_CLASS_ID | SCR_PUB_COMPACT);
  if (ctx->logged == ctx->log_cap)
    ctx->log = scr_pub_grow(ctx->log, &ctx->log_cap, sizeof *ctx->log, ctx->log_inline);
#ifdef SCR_RC_AUDIT
  if (ctx->logged == ctx->kinds_cap) ctx->kinds = scr_pub_grow(ctx->kinds, &ctx->kinds_cap, 1, NULL);
  ctx->kinds[ctx->logged] = (uint8_t)kind;
#else
  (void)kind;
#endif
  ScrPubLog *e = &ctx->log[ctx->logged++];
  uint32_t buf = 0;
  if (cyc && scr_cyc_is_buffered(scr_cyc_hdr(obj))) {
    buf = scr_cyc_pub_take(obj) + 1;
    ctx->taken++;
  }
  size_t count = class_id ? SCR_RC_COUNT(obj) : *rc;
  uint32_t logged = (uint32_t)count;
  if (class_id) buf |= SCR_PUB_LOG_COUNT;
#if SIZE_MAX > UINT32_MAX
  if (!class_id && count >= SCR_PUB_RC_LIFETIME) {
    if (count == (size_t)1 << 63) logged = SCR_PUB_RC_LIFETIME;
    else {
      if (ctx->nbig == ctx->big_cap) ctx->big = scr_pub_grow(ctx->big, &ctx->big_cap, sizeof *ctx->big, NULL);
      ctx->big[ctx->nbig++] = count;
      logged = SCR_PUB_RC_BIG;
    }
  }
#endif
  *e = (ScrPubLog){(uintptr_t)obj, logged, buf};
  if (compact) SCR_RC_COUNT(obj) |= SCR_RC_COMPACT_PUBLISHED;
  else if (class_id) SCR_RC_COUNT(obj) = SCR_RC_IMMORTAL;
  else *rc = SIZE_MAX;
  return true;
}

void scr_pub_refuse(ScrPub *ctx, const char *message) {
  if (!ctx->refusal) ctx->refusal = message;
}

/* An emitted refusing walker: the static path is diagnostic only. */
void scr_pub_refuse_at(ScrPub *ctx, const char *message, const char *detail) {
  if (!ctx->refusal && getenv("SCRIPTC_PUBLISH_TRACE"))
    fprintf(stderr, "scriptc: publish refused %s\n", detail);
  scr_pub_refuse(ctx, message);
}

/* Strings up to this length cache their Map key hash before they become
 * immortal (map keys are short); longer ones hash per lookup, since no
 * thread may write an immortal header (the map code skips them). */
#define SCR_PUB_HASH_PRIME_MAX 256

void scr_pub_str_fn(void *v, ScrPub *ctx) {
  ScrStr *s = v;
  if (s->rc == SIZE_MAX) return;
  if (s->len <= SCR_PUB_HASH_PRIME_MAX) scr_str_hash_prime(s);
  /* Record proven ASCII now: an immortal string cannot record it later,
   * and every UTF-16 index mapper answers ASCII strings by identity. */
  if (!s->ascii && scr_bytes_all_ascii(s->data, s->len)) s->ascii = 1;
  scr_pub_mark(ctx, s, false, SCR_PUB_KIND_STRING);
}

/* Objects without references (bigints): only the count. */
void scr_pub_leaf_fn(void *v, ScrPub *ctx) { (void)scr_pub_mark(ctx, v, false, SCR_PUB_KIND_LEAF); }

static void scr_pub_slot(ScrPub *ctx, uint64_t slot, ScrPubFn fn) {
  void *p = (void *)(uintptr_t)slot;
  if (fn) scr_pub_push(ctx, p, fn);
}

/* The elements of a compact reference array (SCR_ELEM_CREF): 4-byte dense
 * slots, 8-byte pointers in the sparse entries. */
static __attribute__((noinline)) void scr_pub_cref_elems(ScrArr *a, ScrPub *ctx, ScrPubFn fn) {
  size_t dense = a->len < a->cap ? a->len : a->cap;
  const uint32_t *refs = (const uint32_t *)a->data;
  const uint8_t *states = scr_arr_has_states(a) ? scr_arr_states_end_w(a, sizeof(uint32_t)) : NULL;
  for (size_t i = 0; i < dense; i++)
    if (!states || *scr_arr_state_in(states, i)) scr_pub_slot(ctx, scr_cref_decode(refs[i]), fn);
  if (scr_arr_ext_of(a))
    for (size_t i = 0; i < scr_arr_ext_of(a)->sparse_len; i++)
      if (scr_arr_ext_of(a)->sparse[i].state) scr_pub_slot(ctx, scr_arr_ext_of(a)->sparse[i].slot, fn);
}

void scr_pub_arr(void *v, ScrPub *ctx, ScrPubFn elem) {
  ScrArr *a = v;
  if (scr_arr_ext_of(a) && (scr_arr_ext_of(a)->props || scr_arr_ext_of(a)->metadata)) {
    scr_pub_refuse(ctx, "Cannot publish an array with non-index properties");
    return;
  }
  if (!scr_pub_mark(ctx, a, a->cyc != 0, SCR_PUB_KIND_ARRAY)) return;
  if (__builtin_expect(a->elem == SCR_ELEM_CREF, 0)) {
    scr_pub_cref_elems(a, ctx, elem);
    return;
  }
  ScrPubFn fn = a->elem == SCR_ELEM_STR ? scr_pub_str_fn : a->elem == SCR_ELEM_REF ? elem : NULL;
  if (!fn) return;
  /* String and reference elements have 8-byte slots. */
  size_t dense = a->len < a->cap ? a->len : a->cap;
  const uint8_t *states = scr_arr_scan_states(a);
  for (size_t i = 0; i < dense; i++)
    if (!states || *scr_arr_state_in(states, i)) scr_pub_slot(ctx, a->data[i], fn);
  if (scr_arr_ext_of(a))
    for (size_t i = 0; i < scr_arr_ext_of(a)->sparse_len; i++)
      if (scr_arr_ext_of(a)->sparse[i].state) scr_pub_slot(ctx, scr_arr_ext_of(a)->sparse[i].slot, fn);
}

/* publish() of a scalar Node.js refuses (a Date): nothing to walk. */
void scr_publish_refuse(const char *message) {
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

void scr_pub_map(void *v, ScrPub *ctx, ScrPubFn key, ScrPubFn val) {
  ScrMap *m = v;
  if (!scr_pub_mark(ctx, m, m->traced != 0, SCR_PUB_KIND_MAP)) return;
  ScrPubFn kfn = m->key_kind == SCR_MAP_KEY_STR ? scr_pub_str_fn
      : m->key_kind == SCR_MAP_KEY_DYN ? scr_pub_dyn_fn
      : m->key_kind == SCR_MAP_KEY_REF || m->key_kind == SCR_MAP_KEY_UNION_REF ||
              m->key_kind == SCR_MAP_KEY_BIGINT || m->key_kind == SCR_MAP_KEY_UNION_VALUE
          ? key
          : NULL;
  ScrPubFn vfn = m->val_kind == SCR_MAP_VAL_REF || m->val_kind == SCR_MAP_VAL_CREF ? val : NULL;
  for (size_t i = 0; i < m->nentries; i++) {
    if (!scr_map_entry_live(m, i)) continue; /* tombstone */
    const ScrMapEntry *e = scr_map_entry_at(m, i);
    if (kfn) scr_pub_slot(ctx, e->key, kfn);
    if (vfn) scr_pub_slot(ctx, scr_map_entry_val(m, e), vfn);
  }
}

/* A dyn subgraph: plain objects, arrays and primitives, validated as a
 * whole before anything in it is frozen and made immortal. */
static bool scr_pub_dyn_ok(const ScrDyn *d, const char **why) {
  if (d->prototype || d->symbol_properties || d->symbol_keys || d->copied_from_native) {
    *why = "Cannot publish an object with a prototype or symbol keys";
    return false;
  }
  if (d->kind == SCR_DYN_ARR) {
    if (d->v.arr.properties) {
      *why = "Cannot publish an array with non-index properties";
      return false;
    }
    return true;
  }
  if (d->null_proto || d->v.obj.source_identity || d->v.obj.source_access) {
    *why = "Cannot publish an Object object";
    return false;
  }
  for (size_t i = 0; i < scr_dyn_obj_count(d); i++)
    if (scr_dyn_obj_prop_at(d, i).accessor) {
      *why = "Cannot publish an accessor property";
      return false;
    }
  return true;
}

/* Collected dyn-subgraph entries: containers untagged, heap strings tagged
 * with 1, bigints with 2 (all three are at least 8-byte aligned). */
#define SCR_PUB_STR ((uintptr_t)1)
#define SCR_PUB_BIGINT ((uintptr_t)2)

void scr_pub_dyn_fn(void *v, ScrPub *ctx) {
  ScrDyn *root = v;
  if (root->rc == SIZE_MAX || ctx->refusal) return;
  uintptr_t *nodes = NULL;
  size_t count = 0, cap = 0, cursor = 0;
  const char *why = NULL;
#define SCR_PUB_ADD(entry)                                                         \
  do {                                                                             \
    uintptr_t e_ = (entry);                                                        \
    bool seen_ = false;                                                            \
    for (size_t j_ = 0; j_ < count && !seen_; j_++) seen_ = nodes[j_] == e_;       \
    if (!seen_) {                                                                  \
      if (count == cap) nodes = scr_pub_grow(nodes, &cap, sizeof *nodes, NULL);    \
      nodes[count++] = e_;                                                         \
    }                                                                              \
  } while (0)
  SCR_PUB_ADD((uintptr_t)root);
  /* Collect and validate (a linear duplicate check: dyn subgraphs inside
   * typed graphs are small). */
  while (cursor < count && !why) {
    uintptr_t entry = nodes[cursor++];
    if (entry & 3) continue;
    ScrDyn *d = (ScrDyn *)entry;
    switch (d->kind) {
    case SCR_DYN_NULL: case SCR_DYN_UNDEF: case SCR_DYN_BOOL: case SCR_DYN_NUM: break;
    case SCR_DYN_STR:
      if (d->v.str->rc != SIZE_MAX) SCR_PUB_ADD((uintptr_t)d->v.str | SCR_PUB_STR);
      break;
    case SCR_DYN_BIGINT:
      if (*(size_t *)d->v.bigint != SIZE_MAX) SCR_PUB_ADD((uintptr_t)d->v.bigint | SCR_PUB_BIGINT);
      break;
    case SCR_DYN_ARR:
    case SCR_DYN_OBJ: {
      if (!scr_pub_dyn_ok(d, &why)) break;
      size_t n = d->kind == SCR_DYN_ARR ? d->v.arr.len : scr_dyn_obj_count(d);
      for (size_t i = 0; i < n; i++) {
        ScrDyn *child = d->kind == SCR_DYN_ARR ? d->v.arr.items[i] : scr_dyn_obj_value_at(d, i);
        if (child && child->rc != SIZE_MAX) SCR_PUB_ADD((uintptr_t)child);
      }
      break;
    }
    case SCR_DYN_FUNC: why = "Cannot publish a function"; break;
    case SCR_DYN_SYMBOL: why = "Cannot publish a symbol"; break;
    default: why = "Cannot publish this value"; break;
    }
  }
#undef SCR_PUB_ADD
  if (why) scr_pub_refuse(ctx, why);
  else
    for (size_t i = 0; i < count; i++) {
      uintptr_t entry = nodes[i];
      void *p = (void *)(entry & ~(uintptr_t)3);
      if (entry & SCR_PUB_STR) scr_pub_str_fn(p, ctx);
      else if (entry & SCR_PUB_BIGINT) scr_pub_leaf_fn(p, ctx);
      else {
        ScrDyn *d = p;
        if (scr_pub_mark(ctx, d, true, SCR_PUB_KIND_DYN) && (d->kind == SCR_DYN_ARR || d->kind == SCR_DYN_OBJ)) {
          ctx->log[ctx->logged - 1].obj |= SCR_PUB_DYN;
          ctx->dyns++;
        }
      }
    }
  free(nodes);
}

#ifdef SCR_RC_AUDIT
/* Immortal objects are never freed, so they leave the RC audit's counts. */
static void scr_pub_audit_forget(int kind) {
  switch (kind) {
  case SCR_PUB_KIND_STRING: scr_str_live_forget(); break;
  case SCR_PUB_KIND_ARRAY: scr_arr_live_forget(); break;
  case SCR_PUB_KIND_MAP: scr_map_live_forget(); break;
  case SCR_PUB_KIND_OBJECT: scr_obj_free_note(); break;
  case SCR_PUB_KIND_UNION: scr_union_live_forget(); break;
  case SCR_PUB_KIND_DYN: scr_dyn_live_forget(); break;
  default: break;
  }
}
#endif

/* SCRIPTC_PUBLISH_TRACE, read once: -1 until then. */
static _Atomic int scr_pub_trace = -1;

/* The stack and log of this thread's last publish, kept while they hold at
 * most SCR_PUB_KEEP bytes: a thread that publishes many graphs (a file per
 * parse) reuses them instead of allocating and faulting in a fresh log each
 * time. Freed at thread (or process) exit. */
#define SCR_PUB_KEEP ((size_t)16 << 20)
typedef struct {
  ScrPubItem *stack;
  size_t cap;
  ScrPubLog *log;
  size_t log_cap;
  bool registered;
} ScrPubKeep;
static SCR_TL ScrPubKeep scr_pub_keep;

static void scr_pub_keep_free(void) {
  free(scr_pub_keep.stack);
  free(scr_pub_keep.log);
  scr_pub_keep = (ScrPubKeep){0};
  scr_pub_keep.registered = true; /* the cleanup ran; later publishes free their buffers */
}

/* Keeps a heap buffer of `bytes` for the next publish, or frees it. */
static bool scr_pub_keep_ok(size_t bytes) {
  if (bytes > SCR_PUB_KEEP) return false;
  if (!scr_pub_keep.registered) {
    scr_pub_keep.registered = true;
    scr_atexit(scr_pub_keep_free);
  }
  return true;
}

void scr_publish(void *root, ScrPubFn fn) {
  if (!root || SCR_RC_PUBLISHED(root)) return;
  ScrPub ctx;
  if (scr_pub_keep.stack) {
    ctx.stack = scr_pub_keep.stack;
    ctx.cap = scr_pub_keep.cap;
    scr_pub_keep.stack = NULL;
  } else {
    ctx.stack = ctx.stack_inline;
    ctx.cap = SCR_PUB_INLINE;
  }
  ctx.len = 0;
  if (scr_pub_keep.log) {
    ctx.log = scr_pub_keep.log;
    ctx.log_cap = scr_pub_keep.log_cap;
    scr_pub_keep.log = NULL;
  } else {
    ctx.log = ctx.log_inline;
    ctx.log_cap = SCR_PUB_INLINE;
  }
  ctx.logged = 0;
  ctx.big = NULL;
  ctx.nbig = ctx.big_cap = 0;
#ifdef SCR_RC_AUDIT
  ctx.kinds = NULL;
  ctx.kinds_cap = 0;
#endif
  ctx.taken = 0;
  ctx.dyns = 0;
  ctx.refusal = NULL;
  int traced = atomic_load_explicit(&scr_pub_trace, memory_order_relaxed);
  if (traced < 0) {
    traced = getenv("SCRIPTC_PUBLISH_TRACE") != NULL;
    atomic_store_explicit(&scr_pub_trace, traced, memory_order_relaxed);
  }
  bool trace = traced != 0;
  uint64_t t0 = trace ? scr_hrtime_ns() : 0, t1 = 0;
  scr_pub_push(&ctx, root, fn);
  while (ctx.len > 0 && !ctx.refusal) {
    ctx.len--;
    ctx.stack[ctx.len].fn(ctx.stack[ctx.len].v, &ctx);
  }
  if (ctx.refusal) {
    for (size_t i = ctx.logged; i-- > 0;) {
      const ScrPubLog *e = &ctx.log[i];
      void *obj = scr_pub_log_obj(e);
      uint32_t buf = e->buf & ~SCR_PUB_LOG_COUNT;
      if (e->buf & SCR_PUB_LOG_COUNT) {
        SCR_RC_COUNT(obj) = (ScrRcCount)e->rc;
      } else {
        size_t rc = e->rc;
#if SIZE_MAX > UINT32_MAX
        if (e->rc == SCR_PUB_RC_LIFETIME) rc = (size_t)1 << 63;
        else if (e->rc == SCR_PUB_RC_BIG) rc = ctx.big[--ctx.nbig];
#endif
        *(size_t *)obj = rc;
      }
      if (buf) scr_cyc_pub_restore(obj, buf - 1);
    }
    if (ctx.taken) scr_cyc_pub_fill();
    scr_throw_error_msg(SCR_ERR_TYPE, ctx.refusal, strlen(ctx.refusal));
  } else {
    if (trace) t1 = scr_hrtime_ns();
    /* Close the candidate buffer slots the walk cleared, before anything
     * can buffer or collect again: no pass may visit a published object. */
    if (ctx.taken) scr_cyc_pub_fill();
    /* Only dyn containers, the RC audit and LeakSanitizer need each object. */
#if defined(SCR_RC_AUDIT) || defined(SCR_LSAN_IMMORTAL)
    size_t each = ctx.logged;
#else
    size_t each = ctx.dyns ? ctx.logged : 0;
#endif
    for (size_t i = 0; i < each; i++) {
      void *obj = scr_pub_log_obj(&ctx.log[i]);
      if (ctx.log[i].obj & SCR_PUB_DYN) {
        ScrDyn *d = obj;
        /* Other threads share the object; layouts belong to this thread
         * (scr_dyn.h), so it moves to dictionary mode. */
        if (d->kind == SCR_DYN_OBJ) scr_dyn_to_dictionary(d);
        scr_dyn_release(scr_dyn_freeze_data(d));
      }
#ifdef SCR_RC_AUDIT
      scr_pub_audit_forget(ctx.kinds[i]);
#endif
      scr_lsan_immortal(obj);
    }
    if (trace) {
      uint64_t t2 = scr_hrtime_ns();
      double walk = (double)(t1 - t0) / 1e6, post = (double)(t2 - t1) / 1e6;
      fprintf(stderr, "scriptc: published %zu objects (walk %.1fms, commit %.1fms)\n", ctx.logged, walk, post);
    }
  }
  if (ctx.stack != ctx.stack_inline) {
    if (!scr_pub_keep.stack && scr_pub_keep_ok(ctx.cap * sizeof *ctx.stack)) {
      scr_pub_keep.stack = ctx.stack;
      scr_pub_keep.cap = ctx.cap;
    } else free(ctx.stack);
  }
  if (ctx.log != ctx.log_inline) {
    if (!scr_pub_keep.log && scr_pub_keep_ok(ctx.log_cap * sizeof *ctx.log)) {
      scr_pub_keep.log = ctx.log;
      scr_pub_keep.log_cap = ctx.log_cap;
    } else free(ctx.log);
  }
  free(ctx.big);
#ifdef SCR_RC_AUDIT
  free(ctx.kinds);
#endif
}

/* Writes into published objects (the emitted guards' cold paths): Node's
 * frozen-object TypeErrors, word for word. */
static void scr_pub_throw(const char *fmt, const char *a, const char *b) {
  char text[512];
  int n = snprintf(text, sizeof text, fmt, a, b);
  if (n < 0) n = 0;
  if ((size_t)n >= sizeof text) n = (int)sizeof text - 1;
  scr_throw_error_msg(SCR_ERR_TYPE, text, (size_t)n);
}

void scr_throw_published_field(const char *prop, const char *owner) {
  scr_pub_throw("Cannot assign to read only property '%s' of object '#<%s>'", prop, owner);
}

bool scr_throw_published_array(int op, const ScrArr *a, double index, double n) {
  return scr_array_frozen_error(op, a->len, index, n, 0);
}

bool scr_throw_published_array_range(int op, const ScrArr *a, double x, double y, double z) {
  return scr_array_frozen_error(op, a->len, x, y, z);
}

void scr_throw_published_collection(bool set) {
  scr_pub_throw("Cannot modify a published %s%s", set ? "Set" : "Map", "");
}
