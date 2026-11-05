/* scriptc runtime — boxes and closures (scr_closure.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_CLOSURE_H
#define SCR_CLOSURE_H

#include "scr_map.h"

/* ── closures ───────────────────────────────────────────────────────
 * A closure is a function pointer plus the boxes of its captured bindings.
 * A box is one shared, refcounted variable cell: every function that
 * captures a binding (and the function that declared it) reads and writes
 * the same box, which is what makes mutation through a closure visible
 * everywhere (JS shared-binding semantics).
 *
 * The compiler emits the callee's C signature as (ScrClosure *env, params…);
 * the callee borrows env->caps[] (the closure owns them). rc == SIZE_MAX
 * marks an immortal closure (the compiler interns one per top-level
 * function referenced as a value, so `f === f` is true like in JS).
 *
 * Ownership: box _get_ref returns +1; _set_ref releases the old value and
 * takes ownership of the new one; releasing a box releases its contents;
 * releasing a closure releases its boxes.
 */

typedef enum {
  SCR_BOX_F64,
  SCR_BOX_BOOL,
  SCR_BOX_STR,
  SCR_BOX_ARR,
  SCR_BOX_FUNC,
  SCR_BOX_OBJ, /* class instance: retain/release via the fn ptrs below */
} ScrBoxKind;

typedef struct ScrBox {
  size_t rc;
  ScrBoxKind kind;
  /* SCR_BOX_OBJ only: class instances are per-class C structs the runtime
   * knows nothing about, so the compiler supplies their RC entry points.
   * obj_trace is non-NULL exactly when the payload type carries a cycle
   * header (the box's own trace then visits the payload; NULL means the
   * payload is acyclic and the box releases it itself at teardown). */
  void *(*obj_retain)(void *);
  void (*obj_release)(void *);
  ScrTraceFn obj_trace;
  uint64_t slot; /* double/bool/pointer via memcpy and casts */
} ScrBox;

/* A box can lie on a cycle only when its trace visits its payload: a
 * closure, or a class instance that carries a cycle header. Every other box
 * is a leaf of the object graph, so its releases buffer no candidate. The
 * emitted inline release (llvm/shapes.ts, the box row) mirrors this test,
 * reading `kind` and `obj_trace` at the asserted offsets. */
static inline bool scr_box_traced(const ScrBox *b) {
  return b->kind == SCR_BOX_FUNC || b->obj_trace != NULL;
}
_Static_assert(SCR_BOX_FUNC == 4, "the emitted box release compares kind against 4");
#if UINTPTR_MAX == UINT64_MAX
_Static_assert(offsetof(ScrBox, kind) == 8 && offsetof(ScrBox, obj_trace) == 32,
               "the emitted box release reads kind at 8 and obj_trace at 32");
#else
_Static_assert(offsetof(ScrBox, kind) == 4 && offsetof(ScrBox, obj_trace) == 16,
               "the emitted box release reads kind at 4 and obj_trace at 16");
#endif

ScrBox *scr_box_new(ScrBoxKind kind); /* returns +1, slot zeroed */
ScrBox *scr_box_new_obj(void *(*retain)(void *), void (*release)(void *),
                         ScrTraceFn trace);

static inline ScrBox *scr_box_retain(ScrBox *b) {
  if (b->rc != SIZE_MAX) {
    b->rc++;
  }
  return b;
}

void scr_box_release(ScrBox *b); /* releases ref contents by kind; NULL-tolerant */

double scr_box_get_f64(ScrBox *b);
bool scr_box_get_bool(ScrBox *b);
void *scr_box_get_ref(ScrBox *b); /* returns +1 */
void scr_box_set_f64(ScrBox *b, double v);
void scr_box_set_bool(ScrBox *b, bool v);
void scr_box_set_ref(ScrBox *b, void *v); /* releases old, owns new */

/* The bits of ScrClosure.function_kind. The LLVM backend stores them too:
 * CLOSURE_KIND in packages/compiler/src/backend/llvm/common.ts mirrors this
 * list, and runtime-registries.test.ts checks that the two agree and that
 * the bits are distinct. The low two bits (SCR_CLOSURE_KIND_CALL_MASK) are
 * the function's call kind: 0 ordinary, 1 generator, 2 async, 3 async
 * generator. */
#define SCR_CLOSURE_KIND_GENERATOR 1u
#define SCR_CLOSURE_KIND_ASYNC 2u
#define SCR_CLOSURE_KIND_CALL_MASK 3u
#define SCR_CLOSURE_KIND_OWN_PROTOTYPE 4u /* an ordinary function with its own prototype */
#define SCR_CLOSURE_KIND_CHECKED_ADAPTER 8u /* a checked callable adapter: the callable is in caps[0] */
/* The body never observes the ambient receiver (the `this` an unbound call
 * binds), so compiled callers skip the receiver bracket around an indirect
 * call. Set only by the compiler; the kind proper is
 * function_kind & SCR_CLOSURE_KIND_MASK. */
#define SCR_CLOSURE_KIND_RECEIVER_FREE 16u
#define SCR_CLOSURE_KIND_MASK 15u

typedef struct ScrClosure {
  size_t rc; /* SIZE_MAX = immortal (interned top-level function value) */
  void *fn;
  size_t ncaps;
  /* The function's OWN-PROPERTY table: a box whose payload is an OBJ
   * ScrDyn (owned; lazily allocated by Object.defineProperties —
   * test/common copying name/length onto the mustCall wrapper), NULL
   * until first defined. It lives on the CLOSURE, not the dyn box:
   * boxing the same function value twice (the declaration's box, the
   * return's box) yields distinct boxes sharing one closure, and JS has
   * ONE function object — property writes must be visible through every
   * box. A ScrBox so this unit stays dyn-free (the payload's release
   * rides the box, like every capture). Untraced by the cycle collector
   * (like the dyn→closure edge): a cycle through it is merely never
   * collected. */
  ScrBox *props;
  uint32_t function_kind; /* SCR_CLOSURE_KIND_* bits */
  /* The root's `length` as boxed values report it; meaningful only when
   * identity is set (the root's own boxes carry their arity). */
  uint32_t identity_length;
  /* The JS function this closure stands for. NULL means the closure is
   * its own identity. A signature adapter (the same function viewed
   * through a different native ABI) points at the root of the function
   * it adapts, so chains of adapters collapse to one root and `===`,
   * SameValue, searches and own properties all observe one function.
   * Borrowed: the adapter keeps its original alive through its captures. */
  struct ScrClosure *identity;
  /* The same function with every reference argument borrowed (the caller
   * keeps each one alive across the call and releases nothing extra), or
   * NULL. Same signature as `fn`; only callers that hold their arguments
   * for the whole call may enter through it. */
  void *fn_borrowed;
  ScrBox *caps[];
} ScrClosure;

ScrClosure *scr_closure_new(void *fn, size_t ncaps); /* +1; caller fills caps with +1 box refs */

static inline ScrClosure *scr_closure_retain(ScrClosure *c) {
  if (c->rc != SIZE_MAX) {
    c->rc++;
  }
  return c;
}

void scr_closure_release(ScrClosure *c); /* releases the boxes; NULL-tolerant */

/* The identity root of a function value (NULL-tolerant). */
static inline ScrClosure *scr_closure_identity(ScrClosure *c) {
  return c != NULL && c->identity != NULL ? c->identity : c;
}

/* JS function identity: two closures are the same function when their
 * identity roots match. */
bool scr_closure_identity_equal(ScrClosure *a, ScrClosure *b);

/* Mark `adapter` as a signature view of `original` (both borrowed);
 * `length` is the original's arity when it is a root. */
void scr_closure_adopt_identity(ScrClosure *adapter, ScrClosure *original, uint32_t length);

/* Mark `adapter` as a typed view of a dynamic function value (both
 * borrowed). Other callables keep the adapter as its own identity. */
void scr_dyn_adopt_identity(ScrClosure *adapter, const struct ScrDyn *value);

#endif /* SCR_CLOSURE_H */
