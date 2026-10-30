#undef NDEBUG
#include "scr_runtime.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>

/* The program TU owns these; a profile with no teachings emits this table. */
const char *const scr_library_trap_overlays[] = {NULL};
const size_t scr_library_trap_overlays_len = 0;

static SCR_TL ScrArr *integrity_held;
static SCR_TL unsigned integrity_resets;
static SCR_TL unsigned integrity_cycles_freed;

typedef struct { size_t rc; } IntegrityCycle;
static void trace_integrity_cycle(void *ptr, ScrTraceVisit visit, void *context) {
  /* Reset must retain restrictions until the final collection has run. */
  assert(scr_native_integrity_flags(ptr) == SCR_NATIVE_FROZEN);
  visit(ptr, context);
}
static void free_integrity_cycle(void *ptr) {
  integrity_cycles_freed++;
  scr_cyc_free(ptr);
}
static ScrCycType integrity_cycle_type = {
  .trace = trace_integrity_cycle, .free_fn = free_integrity_cycle, .kind = SCR_CYC_KIND_EMITTED,
};

static void release_integrity_root(void) {
  if (!integrity_held) return;
  /* Registered cleanup still observes the session's restrictions. */
  assert(scr_native_integrity_flags(integrity_held) == SCR_NATIVE_FROZEN);
  scr_arr_release(integrity_held);
  integrity_held = NULL;
  integrity_resets++;
  /* A dropped self-cycle is reclaimed by reset's post-callback collection. */
  IntegrityCycle *cycle = scr_cyc_alloc(sizeof *cycle, &integrity_cycle_type);
  cycle->rc = 1;
  scr_native_integrity_strengthen(cycle, SCR_NATIVE_FROZEN);
  scr_cyc_on_release(cycle);
  assert(integrity_cycles_freed + 1 == integrity_resets);
}

static void populate_result_arena(void) {
  const uint8_t *data;
  size_t length;
  scr_library_str_out(scr_str_new("result", 6), &data, &length);
  assert(length == 6 && !memcmp(data, "result", 6));
}

static void prototype_session(bool symbol_first) {
  ScrDyn *base = scr_dyn_array_prototype_base(NULL);
  ScrStr *iterator = scr_str_new("iterator", 8);
  ScrSym *symbol = symbol_first ? scr_sym_well_known(iterator) : NULL;
  ScrDyn *prototype = scr_dyn_array_prototype();
  if (!symbol) symbol = scr_sym_well_known(iterator);
  assert(base == prototype);
  ScrDyn *key = scr_dyn_new_symbol(symbol);
  ScrStr *values = scr_str_new("values", 6);
  ScrDyn *iter_method = scr_dyn_symbol_key_get(prototype, key, false);
  ScrDyn *values_method = scr_dyn_arr_named_get(prototype, values);
  assert(iter_method == values_method && scr_dyn_is_callable(values_method));
  scr_dyn_release(iter_method); scr_dyn_release(values_method); scr_dyn_release(key);
  scr_sym_release(symbol); scr_str_release(iterator); scr_str_release(values);
  ScrStr *push = scr_str_new("push", 4);
  ScrDyn *array = scr_dyn_new_arr(), *method = scr_dyn_arr_named_get(array, push);
  assert(method && scr_dyn_is_callable(method));
  assert(scr_dyn_in(array, push) && scr_dyn_in(prototype, push));
  ScrDyn *push_key = scr_dyn_new_str(push);
  ScrDyn *reflected = scr_dyn_reflect_get(array, push_key, array);
  assert(reflected == method && !scr_exc_pending());
  scr_dyn_release(reflected);
  ScrDyn *again = scr_dyn_array_prototype(), *same = scr_dyn_arr_named_get(again, push);
  assert(again == prototype && same == method);
  scr_dyn_release(same); scr_dyn_release(again);
  ScrDyn *item = scr_dyn_new_num(7);
  scr_dyn_this_push_dyn(array);
  ScrDyn *result = scr_dyn_call(method, &item, 1, "push");
  scr_dyn_this_pop();
  assert(result && result->kind == SCR_DYN_NUM && result->v.num == 1);
  assert(array->v.arr.len == 1 && array->v.arr.items[0]->v.num == 7);
  scr_dyn_release(result); scr_dyn_release(item); scr_dyn_release(method);
  scr_dyn_key_delete(prototype, push, true);
  assert(!scr_exc_pending());
  assert(!scr_dyn_in(array, push) && !scr_dyn_in(prototype, push));
  reflected = scr_dyn_reflect_get(array, push_key, array);
  assert(reflected && reflected->kind == SCR_DYN_UNDEF && !scr_exc_pending());
  scr_dyn_release(reflected);
  ScrStr *value_of = scr_str_new("valueOf", 7);
  assert(scr_dyn_in(array, value_of) && scr_dyn_in(prototype, value_of));
  ScrDyn *null_proto = scr_dyn_new_null();
  scr_dyn_release(scr_dyn_set_prototype(prototype, null_proto));
  assert(!scr_dyn_in(array, value_of) && !scr_dyn_in(prototype, value_of) && !scr_exc_pending());
  scr_dyn_release(null_proto); scr_str_release(value_of);
  scr_dyn_release(scr_dyn_freeze(prototype));
  scr_library_collect();
  scr_library_arena_reset();
  again = scr_dyn_array_prototype();
  method = scr_dyn_arr_named_get(array, push);
  assert(again == prototype && method && method->kind == SCR_DYN_UNDEF && !scr_exc_pending());
  scr_dyn_release(method); scr_dyn_release(again); scr_dyn_release(array);
  scr_dyn_release(push_key);
  scr_str_release(push); scr_dyn_release(prototype); scr_dyn_release(base);
}

static void *run_instance(void *unused) {
  (void)unused;
  scr_library_register_reset(release_integrity_root);
  for (unsigned round = 0; round < 32; round++) {
    prototype_session(round % 2 == 0);
    assert(!scr_native_integrity_active());
    integrity_held = scr_arr_new(SCR_ELEM_F64, 0);
    scr_native_integrity_strengthen(integrity_held, SCR_NATIVE_SEALED);
    populate_result_arena();
    scr_library_collect();
    assert(scr_native_integrity_flags(integrity_held) == SCR_NATIVE_SEALED);
    populate_result_arena();
    scr_library_arena_reset();
    assert(scr_native_integrity_flags(integrity_held) == SCR_NATIVE_SEALED);
    scr_native_integrity_strengthen(integrity_held, SCR_NATIVE_FROZEN);
    scr_library_reset();
    assert(!scr_native_integrity_active());
    scr_library_reset();
    assert(integrity_resets == round + 1);
    assert(integrity_cycles_freed == round + 1);
  }
  return NULL;
}

int main(void) {
#ifdef SCR_THREAD_INSTANCES
  /* A main-thread entry makes accidental process-global state fail even
   * when the scheduler runs every worker sequentially. */
  ScrArr *canary = scr_arr_new(SCR_ELEM_F64, 0);
  scr_native_integrity_strengthen(canary, SCR_NATIVE_FROZEN);
  pthread_t threads[4];
  for (unsigned i = 0; i < 4; i++) assert(!pthread_create(&threads[i], NULL, run_instance, NULL));
  for (unsigned i = 0; i < 4; i++) assert(!pthread_join(threads[i], NULL));
  assert(scr_native_integrity_flags(canary) == SCR_NATIVE_FROZEN);
  scr_arr_release(canary);
  assert(!scr_native_integrity_active() && integrity_resets == 0);
#endif
  run_instance(NULL);
  puts("library integrity survives collection and resets with its instance");
}
