/* Class instance layouts are emitted by the compiler. Class objects share
 * one runtime layout, including captured bindings for local classes. */
#include "scr_runtime.h"

/* The lifetime-region fiber hooks (scr_region.h) live in this always-linked
 * unit: scr_async.c reads them, and some runtime test links take
 * scr_async.c without scr_region.c. scr_region_create installs them. */
_Atomic(const ScrRgnFiberHooks *) scr_region_fiber_hooks = NULL;

void scr_classobj_trace_v(void *object, ScrTraceVisit visit, void *ctx) {
  ScrClassObj *c = object;
  for (size_t i = 0; i < c->ncaps; i++) visit(c->caps[i], ctx);
  visit(c->prototype_data, ctx);
  visit(c->static_data, ctx);
}

static void scr_classobj_gcfree(void *object) {
  scr_obj_free_note();
  scr_cyc_free(object);
}

ScrClassObj *scr_classobj_new(const ScrClassObj *template, size_t ncaps) {
  if (ncaps > (SIZE_MAX - sizeof(ScrClassObj)) / sizeof(ScrBox *))
    scr_trap("scriptc: class capture allocation overflow\n");
  static ScrCycType cyc_type = { &scr_classobj_trace_v, &scr_classobj_gcfree, SCR_CYC_KIND_CLASS_OBJECT };
  ScrClassObj *c = scr_cyc_alloc(sizeof(ScrClassObj) + ncaps * sizeof(ScrBox *), &cyc_type);
  c->rc = 1;
  c->pre = template->pre;
  c->post = template->post;
  c->ctor = template->ctor;
  c->name = template->name;
  c->ncaps = ncaps;
  c->length = template->length;
  c->prototype_data = NULL;
  c->static_data = NULL;
  scr_obj_alloc_note();
  return c;
}

static void scr_classobj_destroy(void *object) {
  ScrClassObj *c = object;
  for (size_t i = 0; i < c->ncaps; i++) scr_box_release(c->caps[i]);
  scr_box_release(c->prototype_data);
  scr_box_release(c->static_data);
  scr_classobj_gcfree(c);
}

void scr_classobj_release(ScrClassObj *c) {
  if (!c || c->rc == SIZE_MAX) return;
  if (--c->rc == 0) {
    scr_cyc_dead(c);
    scr_rc_destroy(c, scr_classobj_destroy);
  } else {
    scr_cyc_released(c);
  }
}

void *scr_classobj_retain_v(void *c) {
  return scr_classobj_retain((ScrClassObj *)c);
}

void scr_classobj_clear_properties(ScrClassObj *c) {
  ScrBox *prototype = c->prototype_data, *statics = c->static_data;
  c->prototype_data = NULL;
  c->static_data = NULL;
  scr_box_release(prototype);
  scr_box_release(statics);
}
void scr_classobj_release_v(void *c) { scr_classobj_release((ScrClassObj *)c); }

ScrStr *scr_classobj_name(ScrClassObj *c) {
  return scr_str_retain((ScrStr *)c->name);
}

/* The keyed-write MISS on a fixed-shape (signature-free) record: JS would
 * ADD the property, which a monomorphic struct cannot — the write throws
 * the catchable TypeError naming the key instead (the documented
 * divergence; the emitted per-shape keyed-write helpers call this after
 * the declared-field chain misses). */
void scr_record_key_miss(ScrStr *k) {
  const char *base = "Cannot add property '";
  ScrStr *head = scr_str_new(base, strlen(base));
  ScrStr *with_key = scr_str_concat(head, k);
  scr_str_release(head);
  const char *tail_c = "' to a fixed-shape object";
  ScrStr *tail = scr_str_new(tail_c, strlen(tail_c));
  ScrStr *msg = scr_str_concat(with_key, tail);
  scr_str_release(with_key);
  scr_str_release(tail);
  scr_throw_error(SCR_ERR_TYPE, msg); /* takes ownership */
}

#ifdef SCR_RC_AUDIT
static SCR_TL long scr_live_objects = 0;
/* ProgramLifetime instances (@scriptc/types) this thread created and no
 * released lifetime region freed (scr_region.c): never freed by design, and
 * neither is anything they hold (see the exit audit in scr_console.c). */
static SCR_TL long scr_lifetime_objects = 0;
long scr_obj_live_count(void) { return scr_live_objects; }
long scr_obj_lifetime_count(void) { return scr_lifetime_objects; }
void scr_obj_alloc_note(void) { scr_live_objects++; }
void scr_obj_free_note(void) { scr_live_objects--; }
/* Also an intentional LeakSanitizer root, like published objects: what the
 * instance holds stays reachable. */
void scr_obj_lifetime_note(const void *obj) {
  scr_lifetime_objects++;
  scr_lsan_immortal(obj);
}
void scr_obj_lifetime_forget(long n) { scr_lifetime_objects -= n; }
#else
#undef scr_obj_alloc_note
#undef scr_obj_free_note
void scr_obj_alloc_note(void) {}
void scr_obj_free_note(void) {}
void scr_obj_lifetime_note(const void *obj) { (void)obj; }
#endif
