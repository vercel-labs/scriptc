#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCR_RC_AUDIT
static SCR_TL long scr_live_boxes = 0;
static SCR_TL long scr_live_closures = 0;
long scr_box_live_count(void) { return scr_live_boxes; }
long scr_closure_live_count(void) { return scr_live_closures; }
#endif

/* ── boxes ──────────────────────────────────────────────────────────────
 * Every box carries a cycle header (a captured binding can hold anything,
 * including the closure that captures it — the canonical cycle). The box's
 * trace visits its payload when the payload type itself carries a header:
 * closures always do; SCR_BOX_OBJ payloads iff the compiler passed a trace
 * (obj_trace doubles as that flag); strings/scalars never. SCR_BOX_ARR
 * holds acyclic arrays only — a CYCLE-CAPABLE array (traced ref elements)
 * rides a SCR_BOX_OBJ box with the array's `_v` adapters + scr_arr_trace_v,
 * so its edge stays visible to the collector. */

static void *scr_box_ptr(const ScrBox *b) {
  void *p;
  memcpy(&p, &b->slot, sizeof p);
  return p;
}

static void scr_box_trace(void *o, ScrTraceVisit visit, void *ctx) {
  ScrBox *b = (ScrBox *)o;
  void *p = scr_box_ptr(b);
  if (!p) return; /* freshly-created boxes hold NULL until first write */
  switch (b->kind) {
  case SCR_BOX_FUNC:
    visit(p, ctx);
    break;
  case SCR_BOX_OBJ:
    if (b->obj_trace) visit(p, ctx);
    break;
  default:
    break;
  }
}

/* Teardown for the collector: release exactly the payloads the trace does
 * NOT visit (the complement — see the contract in scr_runtime.h). */
static void scr_box_gcfree(void *o) {
  ScrBox *b = (ScrBox *)o;
  void *p = scr_box_ptr(b);
  if (p) {
    switch (b->kind) {
    case SCR_BOX_STR:
      scr_str_release((ScrStr *)p);
      break;
    case SCR_BOX_ARR:
      scr_arr_release((ScrArr *)p);
      break;
    case SCR_BOX_OBJ:
      if (!b->obj_trace) b->obj_release(p);
      break;
    default: /* FUNC is traced; scalars own nothing */
      break;
    }
  }
#ifdef SCR_RC_AUDIT
  scr_live_boxes--;
#endif
  scr_cyc_free(b);
}

ScrBox *scr_box_new(ScrBoxKind kind) {
  ScrBox *b = scr_cyc_alloc(sizeof(ScrBox), &scr_box_trace, &scr_box_gcfree);
  b->rc = 1;
  b->kind = kind;
#ifdef SCR_RC_AUDIT
  scr_live_boxes++;
#endif
  return b;
}

ScrBox *scr_box_new_obj(void *(*retain)(void *), void (*release)(void *),
                         ScrTraceFn trace) {
  ScrBox *b = scr_box_new(SCR_BOX_OBJ);
  b->obj_retain = retain;
  b->obj_release = release;
  b->obj_trace = trace;
  return b;
}

/* Release one payload pointer by the box's kind. Factored so set_ref can
 * release the value it REPLACED after the slot is already overwritten
 * (mutators must unlink before releasing — see scr_cycle.c). */
static void scr_box_release_payload(ScrBox *b, void *p) {
  if (!p) return;
  switch (b->kind) {
  case SCR_BOX_STR:
    scr_str_release((ScrStr *)p);
    break;
  case SCR_BOX_ARR:
    scr_arr_release((ScrArr *)p);
    break;
  case SCR_BOX_FUNC:
    scr_closure_release((ScrClosure *)p);
    break;
  case SCR_BOX_OBJ:
    b->obj_release(p);
    break;
  case SCR_BOX_F64:
  case SCR_BOX_BOOL:
    break;
  }
}

void scr_box_release(ScrBox *b) {
  if (!b || b->rc == SIZE_MAX) return; /* NULL: a switch jumped past the decl */
  if (--b->rc == 0) {
    scr_cyc_on_dead(b);
    scr_box_release_payload(b, scr_box_ptr(b));
#ifdef SCR_RC_AUDIT
    scr_live_boxes--;
#endif
    scr_cyc_free(b);
  } else {
    scr_cyc_on_release(b); /* possible cycle root; may collect — b is done */
  }
}

double scr_box_get_f64(ScrBox *b) {
  double v;
  memcpy(&v, &b->slot, sizeof v);
  return v;
}

bool scr_box_get_bool(ScrBox *b) { return b->slot != 0; }

void *scr_box_get_ref(ScrBox *b) {
  void *p = scr_box_ptr(b);
  switch (b->kind) {
  case SCR_BOX_STR:
    return scr_str_retain((ScrStr *)p);
  case SCR_BOX_ARR:
    return scr_arr_retain((ScrArr *)p);
  case SCR_BOX_FUNC:
    return scr_closure_retain((ScrClosure *)p);
  case SCR_BOX_OBJ:
    return b->obj_retain(p);
  default:
    scr_trap("scriptc: internal error: box_get_ref on a scalar box\n");
  }
}

void scr_box_set_f64(ScrBox *b, double v) { memcpy(&b->slot, &v, sizeof v); }

void scr_box_set_bool(ScrBox *b, bool v) { b->slot = v ? 1 : 0; }

void scr_box_set_ref(ScrBox *b, void *v) {
  /* Unlink-then-release: the slot must already hold the new value when the
   * old one's release runs (it can trigger a collection, which must not
   * walk the b→old edge whose count was just given up). */
  void *old = scr_box_ptr(b);
  memcpy(&b->slot, &v, sizeof v);
  scr_box_release_payload(b, old);
}

/* ── closures ─────────────────────────────────────────────────────────── */

static void scr_closure_trace(void *o, ScrTraceVisit visit, void *ctx) {
  ScrClosure *c = (ScrClosure *)o;
  for (size_t i = 0; i < c->ncaps; i++) visit(c->caps[i], ctx);
}

static void scr_closure_gcfree(void *o) {
  /* Caps are all boxes — all traced. The own-property table (props) is
   * an untraced box: released here like any external owned edge. */
  scr_box_release(((ScrClosure *)o)->props);
#ifdef SCR_RC_AUDIT
  scr_live_closures--;
#endif
  scr_cyc_free(o);
}

ScrClosure *scr_closure_new(void *fn, size_t ncaps) {
  ScrClosure *c = scr_cyc_alloc(sizeof(ScrClosure) + ncaps * sizeof(ScrBox *),
                                 &scr_closure_trace, &scr_closure_gcfree);
  c->rc = 1;
  c->fn = fn;
  c->ncaps = ncaps;
  c->props = NULL; /* lazily allocated by Object.defineProperties */
#ifdef SCR_RC_AUDIT
  scr_live_closures++;
#endif
  return c;
}

void scr_closure_release(ScrClosure *c) {
  if (!c || c->rc == SIZE_MAX) return; /* NULL: an uninitialized `let` local */
  if (--c->rc == 0) {
    scr_cyc_on_dead(c);
    for (size_t i = 0; i < c->ncaps; i++) scr_box_release(c->caps[i]);
    scr_box_release(c->props); /* NULL-tolerant */
#ifdef SCR_RC_AUDIT
    scr_live_closures--;
#endif
    scr_cyc_free(c);
  } else {
    scr_cyc_on_release(c); /* possible cycle root; may collect — c is done */
  }
}

void scr_closure_trace_v(void *c, ScrTraceVisit visit, void *ctx) {
  scr_closure_trace(c, visit, ctx);
}
