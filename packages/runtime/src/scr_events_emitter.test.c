/* errorMonitor runs once and may change which error listeners receive this emit. */
#undef NDEBUG
#include "scr_runtime.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static ScrEmitter *emitter;
static ScrStr *name;
static ScrError *error;
static ScrDyn *value, *listener;
static unsigned monitors, calls;
enum { ADD, REMOVE, THROW };
static int change;
static ScrError *monitor_error;

static void handle(ScrClosure *self, void *payload) {
  (void)self;
  assert(payload == error);
  calls++;
}

static ScrDyn *handle_dyn(ScrClosure *self, ScrDyn *const *args, size_t argc) {
  (void)self;
  assert(argc == 1 && args[0] == value);
  calls++;
  return scr_dyn_undefined();
}

static void listen(ScrDyn *cb, ScrStr *event) {
  scr_emitter_release(scr_emitter_on_dyn(emitter, event, cb, scr_closure_retain(cb->v.fn.clo),
                                        &scr_ee_inv_fixed1, false, false));
}

static void change_listeners(void) {
  monitors++;
  if (change == THROW)
    scr_throw_obj(scr_error_retain(monitor_error), scr_error_retain_v, scr_error_release_v,
                  scr_error_trace_arg());
  else if (change == REMOVE)
    scr_emitter_release(scr_emitter_off_dyn(emitter, name, listener));
  else
    listen(listener, name);
}

static void monitor(ScrClosure *self, void *payload) {
  (void)self;
  assert(payload == error);
  change_listeners();
}

static ScrDyn *monitor_dyn(ScrClosure *self, ScrDyn *const *args, size_t argc) {
  (void)self;
  assert(argc == 1 && args[0] == value);
  change_listeners();
  return scr_dyn_undefined();
}

int main(int argc, char **argv) {
  assert(argc == 2);
  scr_init();
  name = scr_str_new("error", 5);
  error = scr_error_new(SCR_ERR_ERROR, NULL);
  value = scr_dyn_from_error(error);
  listener = scr_dyn_new_func(scr_closure_new((void *)&handle, 0), &handle_dyn, 1, "", "listener");
  ScrDyn *watch = scr_dyn_new_func(scr_closure_new((void *)&monitor, 0), &monitor_dyn, 1, "", "monitor");
  monitor_error = scr_error_new(SCR_ERR_TYPE, NULL);
  for (change = ADD; change <= THROW; change++) {
    emitter = scr_emitter_new();
    monitors = calls = 0;
    listen(watch, scr_emitter_error_monitor());
    if (change != ADD) listen(listener, name);
    bool had;
    if (!strcmp(argv[1], "typed")) had = scr_emitter_emit_error(emitter, name, error);
    else if (!strcmp(argv[1], "mixed")) had = scr_emitter_emit_error_mixed(emitter, name, error, &value, 1);
    else if (!strcmp(argv[1], "dynamic")) had = scr_emitter_emit_any(emitter, name, &value, 1);
    else if (!strcmp(argv[1], "value")) had = scr_emitter_emit_error_value(emitter, &value, 1, NULL);
    else if (!strcmp(argv[1], "flex")) had = scr_emitter_emit_error_flex(emitter, value);
    else { assert(!strcmp(argv[1], "carried")); had = scr_emitter_emit_error_carried(emitter, name, error, &value, 1); }
    assert(monitors == 1);
    assert(calls == (unsigned)(change == ADD));
    if (change == ADD) {
      assert(had && !scr_exc_pending());
    } else {
      assert(scr_exc_active->kind == SCR_EXC_OBJ);
      assert(scr_exc_active->payload == (change == THROW ? monitor_error : error));
      scr_exc_clear();
    }
    scr_emitter_release(emitter);
  }
  scr_dyn_release(watch);
  scr_dyn_release(listener);
  scr_dyn_release(value);
  scr_error_release(monitor_error);
  scr_error_release(error);
  scr_str_release(name);
  puts("monitor changes affect the same error event");
  return 0;
}
