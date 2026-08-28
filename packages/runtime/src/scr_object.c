/* Class instances are per-class C structs emitted by the compiler; the
 * runtime only provides the RC-audit hooks their emitted new/release
 * helpers call — plus the class-OBJECT entry points (classes as values:
 * every class object is an emitted immortal static, so the adapters are
 * no-ops behind the uniform container RC machinery). */
#include "scr_runtime.h"

void *scr_classobj_retain_v(void *c) {
  return scr_classobj_retain((ScrClassObj *)c);
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
long scr_obj_live_count(void) { return scr_live_objects; }
void scr_obj_alloc_note(void) { scr_live_objects++; }
void scr_obj_free_note(void) { scr_live_objects--; }
#else
void scr_obj_alloc_note(void) {}
void scr_obj_free_note(void) {}
#endif
