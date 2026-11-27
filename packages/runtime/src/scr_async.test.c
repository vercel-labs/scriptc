/* White-box memory contract: small suspended fibers must not commit their
 * whole stack, but large live frames must still survive awaits and yields.
 * With the argument `timers`: the order of a loop turn's due timers and
 * immediates. With `resolve`: the off-loop lookup the WebSocket dial runs
 * through the worker pool, and with `timerwrap`: the timer sequence's
 * ordering across the 2^32 boundary. */
#undef NDEBUG
#include "scr_async.c"
#include <assert.h>
#ifndef _WIN32
#include <arpa/inet.h>
#include <netdb.h>
#endif

static void assert_sparse(ScrFiber *f, const void *anchor) {
  size_t used = 0;
#ifdef _WIN32
  (void)f;
  MEMORY_BASIC_INFORMATION region;
  assert(VirtualQuery(anchor, &region, sizeof region) == sizeof region);
  void *base = region.AllocationBase;
  char *cursor = base;
  while (VirtualQuery(cursor, &region, sizeof region) == sizeof region &&
         region.AllocationBase == base) {
    if (region.State == MEM_COMMIT) used += region.RegionSize;
    cursor += region.RegionSize;
  }
#else
  (void)anchor;
  long page = sysconf(_SC_PAGESIZE);
  assert(page > 0);
  size_t pages = SCR_FIBER_STACK / (size_t)page;
#ifdef __APPLE__
  char *resident = calloc(pages, 1);
#else
  unsigned char *resident = calloc(pages, 1);
#endif
  assert(resident != NULL);
  assert(mincore(f->stack, SCR_FIBER_STACK, resident) == 0);
  for (size_t i = 0; i < pages; i++) {
    if (resident[i] & 1) used += (size_t)page;
  }
  free(resident);
#endif
  /* Wide margin for OS/sanitizer frames; the original eager initialization
   * commits the entire reservation and fails this bound. */
  if (used >= SCR_FIBER_STACK / 2) {
    fprintf(stderr, "shallow fiber committed %zu of %d stack bytes\n",
            used, SCR_FIBER_STACK);
    abort();
  }
}

static void shallow_async(ScrFiber *f, void *gate) {
  char anchor = 0;
  assert_sparse(f, &anchor);
  scr_await_void(gate);
  scr_promise_fulfill_void(scr_fiber_promise(f));
}

static void shallow_gen(ScrFiber *f, void *unused) {
  (void)unused;
  char anchor = 0;
  assert_sparse(f, &anchor);
  scr_gen_yield_f64(17);
  scr_gen_out_f64(scr_gen_of_fiber(f), 23);
}

/* Volatile and noinline ensure this actually uses more than the small
 * initialization window. Check every byte again after suspension. */
__attribute__((noinline))
static void large_frame(ScrPromise *gate, bool generator, unsigned char seed) {
  volatile unsigned char bytes[128 * 1024];
  for (size_t i = 0; i < sizeof bytes; i++) bytes[i] = (unsigned char)(seed + i);
  if (generator) scr_gen_yield_f64(seed);
  else scr_await_void(gate);
  for (size_t i = 0; i < sizeof bytes; i++) assert(bytes[i] == (unsigned char)(seed + i));
}

static void deep_async(ScrFiber *f, void *gate) {
  large_frame(gate, false, 37);
  scr_promise_fulfill_void(scr_fiber_promise(f));
}

static void deep_gen(ScrFiber *f, void *unused) {
  (void)unused;
  large_frame(NULL, true, 91);
  scr_gen_out_f64(scr_gen_of_fiber(f), 92);
}

/* The order of one loop turn whose timers are all due when it starts. Every
 * deadline below has passed before the loop runs, so the heap decides the
 * order and no clock does. */
static char turn_order[8];
static size_t turn_count;

static void turn_note(char name) {
  assert(turn_count < sizeof turn_order);
  turn_order[turn_count++] = name;
}

static void timer_created_first(ScrClosure *self) {
  (void)self;
  turn_note('a');
}

static void immediate_queued_by_timer(ScrClosure *self) {
  (void)self;
  turn_note('i');
}

static void timer_created_second(ScrClosure *self) {
  (void)self;
  turn_note('b');
  (void)scr_set_immediate(scr_closure_new((void *)immediate_queued_by_timer, 0));
}

static void timer_created_third(ScrClosure *self) {
  (void)self;
  turn_note('c');
}

static void immediate_queued_by_script(ScrClosure *self) {
  (void)self;
  turn_note('d');
}

static void push_due_timer(void (*fn)(ScrClosure *), double deadline_ms) {
  ScrTimer timer = {.deadline_ms = deadline_ms,
                    .seq = scr_timer_seq++,
                    .cb = scr_closure_new((void *)fn, 0),
                    .reffed = true};
  scr_timer_push(timer);
}

/* Due timers run in the order of their deadlines, whichever was created
 * first, and timers of one deadline in the order of their creation. The
 * immediates queued before the turn run after the due timers, and an
 * immediate a timer's callback queues runs after those, in the same turn. */
static void due_timers_run_by_deadline_before_immediates(void) {
  double passed = scr_now_ms() - 1000;
  push_due_timer(timer_created_first, passed + 20);
  (void)scr_set_immediate(scr_closure_new((void *)immediate_queued_by_script, 0));
  push_due_timer(timer_created_second, passed + 10);
  push_due_timer(timer_created_third, passed + 10);
  assert(!scr_loop_run(NULL));
  assert(!scr_exc_pending());
  assert(turn_count == 5 && memcmp(turn_order, "bcadi", 5) == 0);
  puts("due timers run by deadline, then by creation, before the turn's immediates");
}

/* A timer armed during a turn runs in the NEXT turn's timers phase, so the
 * immediate the same callback arms runs first ("tic"). Its deadline is
 * already passed: without the turn cutoff the deadline alone let it run in
 * this turn's timers phase, before the check phase ("tci") — the ordering
 * 5615-next-tick-callback-phases.ts lost under ASan when the clock crossed a
 * millisecond between arming the timer and reaching the timers phase. */
static void timer_arms_immediate_and_due_timer(ScrClosure *self) {
  (void)self;
  turn_note('t');
  (void)scr_set_immediate(scr_closure_new((void *)immediate_queued_by_timer, 0));
  push_due_timer(timer_created_third, scr_now_ms() - 1);
}

static void timer_armed_during_turn_waits_for_next_timers_phase(void) {
  turn_count = 0;
  push_due_timer(timer_arms_immediate_and_due_timer, scr_now_ms() - 1000);
  assert(!scr_loop_run(NULL));
  assert(!scr_exc_pending());
  assert(turn_count == 3 && memcmp(turn_order, "tic", 3) == 0);
  puts("a timer armed during a turn runs after that turn's immediates");
}

/* The 5615 shape: an I/O callback arms an immediate and a zero-delay timer.
 * Node's check phase runs the immediate first ("oic"); the timer is due by
 * the time the loop reaches its timers phase, so only a snapshot taken
 * BEFORE the I/O dispatch keeps it out of that phase ("oci" without it). */
static bool io_armed_once;
static bool io_pending(void) { return !io_armed_once; }
static void io_arms_immediate_and_due_timer(void) {
  if (io_armed_once) return;
  io_armed_once = true;
  turn_note('o');
  (void)scr_set_immediate(scr_closure_new((void *)immediate_queued_by_timer, 0));
  push_due_timer(timer_created_third, scr_now_ms() - 1);
}

static void timer_armed_by_io_callback_waits_for_next_timers_phase(void) {
  turn_count = 0;
  io_armed_once = false;
  scr_loop_set_net(io_pending, io_arms_immediate_and_due_timer, NULL);
  assert(!scr_loop_run(NULL));
  scr_loop_set_net(NULL, NULL, NULL);
  assert(!scr_exc_pending());
  assert(turn_count == 3 && memcmp(turn_order, "oic", 3) == 0);
  puts("a timer armed by an I/O callback runs after that turn's immediates");
}

/* The startup checkpoint's ticks and microtasks are queued work when the
 * timers phase begins: a due timer a process.nextTick callback arms runs
 * before that turn's immediates ("nci"). Capturing the cutoff before the
 * checkpoint would push it behind them ("nic") — Node runs the timer in the
 * timers phase that follows the startup checkpoint. */
static void tick_arms_immediate_and_due_timer(ScrClosure *self) {
  (void)self;
  turn_note('n');
  (void)scr_set_immediate(scr_closure_new((void *)immediate_queued_by_timer, 0));
  push_due_timer(timer_created_third, scr_now_ms() - 1);
}

static void tick_armed_timer_runs_before_turn_immediates(void) {
  turn_count = 0;
  scr_next_tick(scr_closure_new((void *)tick_arms_immediate_and_due_timer, 0));
  assert(!scr_loop_run(NULL));
  assert(!scr_exc_pending());
  assert(turn_count == 3 && memcmp(turn_order, "nci", 3) == 0);
  puts("a timer armed by a startup tick runs before that turn's immediates");
}

/* The immediate queue's storage. Whatever a program does with its immediates,
 * the queue holds a slot for each one that is waiting and reuses the slots of
 * those that ran or were cleared: its capacity follows the largest number
 * waiting at once, not the number ever queued. */
enum { STORAGE_TURNS = 300, STORAGE_PER_TURN = 50, STORAGE_CHAIN = 20000, STORAGE_BURST = 400000 };
static size_t storage_turns, storage_ran, storage_taken;

static void immediate_never_runs(ScrClosure *self) {
  (void)self;
  abort();
}

static void timer_queues_and_clears(ScrClosure *self) {
  (void)self;
  for (int i = 0; i < STORAGE_PER_TURN; i++) {
    scr_clear_immediate(scr_set_immediate(scr_closure_new((void *)immediate_never_runs, 0)));
  }
  /* Due after the timers of this turn: the next call belongs to a later one. */
  if (++storage_turns < STORAGE_TURNS) push_due_timer(timer_queues_and_clears, scr_now_ms() + 0.05);
}

static void immediate_queues_the_next(ScrClosure *self) {
  (void)self;
  if (++storage_ran < STORAGE_CHAIN) (void)scr_set_immediate(scr_closure_new((void *)immediate_queues_the_next, 0));
}

static void immediate_queues_the_next_and_throws(ScrClosure *self) {
  (void)self;
  if (++storage_ran < STORAGE_CHAIN) {
    (void)scr_set_immediate(scr_closure_new((void *)immediate_queues_the_next_and_throws, 0));
  }
  scr_throw_str(scr_str_new("thrown", 6));
}

/* The program's 'uncaughtException' listener: it takes the error, and the
 * loop goes on. */
static int take_uncaught(bool from_promise) {
  (void)from_promise;
  storage_taken++;
  scr_exc_clear();
  return 1;
}

/* The capacity the queue reached since the last call, against the most it may
 * hold; the queue, empty between the loop's runs, then starts from nothing,
 * so each program below is measured alone. */
static bool queue_stayed_within(size_t slots, const char *program) {
  size_t reached = scr_immediates_cap;
  assert(scr_nimmediates == 0 && scr_pending_immediates == 0);
  free(scr_immediates);
  scr_immediates = NULL;
  scr_immediates_cap = 0;
  if (reached <= slots) return true;
  fprintf(stderr, "%s left a queue of %zu slots; %zu hold all that ever waited at once\n", program, reached, slots);
  return false;
}

static void immediate_queue_reuses_its_slots(void) {
  bool reused = true;
  /* A timer drives the turns; each queues immediates and clears them all, so
   * no turn has a check phase. */
  push_due_timer(timer_queues_and_clears, scr_now_ms() - 1000);
  assert(!scr_loop_run(NULL) && !scr_exc_pending());
  assert(storage_turns == STORAGE_TURNS);
  reused &= queue_stayed_within(64, "300 turns of a timer that each queued and cleared 50 immediates");
  /* A chain: every immediate queues the next one, so one is always waiting. */
  (void)scr_set_immediate(scr_closure_new((void *)immediate_queues_the_next, 0));
  assert(!scr_loop_run(NULL) && !scr_exc_pending());
  assert(storage_ran == STORAGE_CHAIN);
  reused &= queue_stayed_within(16, "a chain of 20,000 immediates");
  /* The same chain when every callback throws: each throw ends the phase. */
  storage_ran = 0;
  scr_uncaught_exception_hook = take_uncaught;
  (void)scr_set_immediate(scr_closure_new((void *)immediate_queues_the_next_and_throws, 0));
  assert(!scr_loop_run(NULL) && !scr_exc_pending());
  scr_uncaught_exception_hook = NULL;
  assert(storage_ran == STORAGE_CHAIN && storage_taken == STORAGE_CHAIN);
  reused &= queue_stayed_within(16, "a chain of 20,000 immediates that each threw");
  if (!reused) abort();
  puts("the immediate queue reuses the slots of immediates that ran or were cleared");
}

/* Clearing the immediate queued last finds it at the queue's end: one turn
 * that queues and clears many, one after the other, takes time in proportion
 * to their number. A search from the oldest slot walked every cleared one
 * (2.9 s for 100,000 in a compiled program, sixteen times that here); the
 * bound is far above what the search from the newest needs. */
static void clearing_the_newest_immediate_does_not_walk_the_cleared_ones(void) {
  double started = scr_now_ms();
  for (int i = 0; i < STORAGE_BURST; i++) {
    scr_clear_immediate(scr_set_immediate(scr_closure_new((void *)immediate_never_runs, 0)));
    if (i % 1000 == 0 && scr_now_ms() - started > 20000) {
      fprintf(stderr, "queueing and clearing %d immediates in one turn took over 20 s\n", i);
      abort();
    }
  }
  assert(scr_pending_immediates == 0);
  puts("clearing the newest immediate does not walk the cleared ones");
}

/* Dropping entries leaves tombstones that keep occupying buckets while the
 * live count stays low, and ordinary churn can reach a table with every
 * bucket taken (a direct-awaited promise is not registered, so an absent key
 * is ordinary). An absent key must answer, and an insert must still land,
 * instead of a probe wrapping forever on the event-loop thread. */
static void promise_table_survives_tombstone_churn(void) {
  scr_async_proms_cap = 64;
  scr_async_proms = calloc(scr_async_proms_cap, sizeof *scr_async_proms);
  assert(scr_async_proms != NULL);
  for (size_t i = 0; i < scr_async_proms_cap; i++) scr_async_proms[i].key = SCR_PROM_TOMBSTONE;
  scr_async_proms_len = 0;
  scr_async_proms_used = scr_async_proms_cap;
  ScrPromise missing;
  assert(scr_async_prom_find(&missing) == NULL);
  ScrPromise fresh;
  scr_async_prom_insert(&fresh, 7, 0);
  assert(scr_async_prom_find(&fresh) != NULL);
  scr_async_prom_teardown();
  printf("promise table survives tombstone churn\n");
}

/* A handle the program drops frees the resource it named: the live count
 * returns to what it was, and (under the sanitized build's leak check) the
 * type string and captured context are released too. */
static void async_resource_handles_own_their_payload(void) {
  const size_t before = scr_ar_live_resources();
  ScrStr *name = scr_str_new("TEST", 4);
  ScrDyn *type = scr_dyn_new_str(name);
  scr_str_release(name);
  for (int i = 0; i < 32; i++) {
    ScrDyn *resource = scr_ar_new(type, NULL);
    assert(resource != NULL);
    assert(scr_ar_async_id(resource) >= 1.0);
    scr_dyn_release(resource);
  }
  scr_dyn_release(type);
  assert(scr_ar_live_resources() == before);
  printf("async resource handles own their payload\n");
}

/* executionAsyncResource() answers a handle box for a resource the scope
 * borrows; the box owns its own reference, so dropping it leaves the
 * original handle's payload alive (the regression was one shared reference,
 * which freed the payload and double-released it). */
static ScrDyn *ar_test_execution_resource(ScrClosure *self, ScrDyn *const *args, size_t argc) {
  (void)self;
  (void)args;
  (void)argc;
  return scr_ar_execution_resource();
}

static void async_resource_execution_resource_owns_its_reference(void) {
  const size_t before = scr_ar_live_resources();
  ScrStr *name = scr_str_new("SCOPED", 6);
  ScrDyn *type = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *resource = scr_ar_new(type, NULL);
  scr_dyn_release(type);
  assert(resource != NULL);
  ScrDyn *target =
      scr_dyn_new_func(scr_closure_new(NULL, 0), ar_test_execution_resource, 0, "()", "target");
  ScrDyn *args = scr_dyn_new_arr();
  ScrDyn *boxed = scr_ar_run_in_scope(resource, target, scr_dyn_undefined(), args);
  scr_dyn_release(args);
  assert(boxed != NULL);
  assert(scr_dyn_strict_eq(boxed, resource));
  scr_dyn_release(boxed);
  assert(scr_ar_async_id(resource) >= 1.0);
  assert(scr_ar_live_resources() == before + 1);
  scr_dyn_release(target);
  scr_dyn_release(resource);
  assert(scr_ar_live_resources() == before);
  printf("async resource execution resource owns its reference\n");
}

static int test_destroy_calls;

static ScrDyn *ar_test_destroy(ScrClosure *self, ScrDyn *const *args, size_t argc) {
  (void)self;
  (void)args;
  (void)argc;
  test_destroy_calls++;
  return scr_dyn_undefined();
}

/* Node registers a GC destroy hook for a resource built while destroy hooks
 * exist unless requireManualDestroy asked otherwise; dropping the last
 * reference is the runtime's disposal point, so the destroy is emitted from
 * there. An explicit emitDestroy queues its destroy once, and the release
 * that follows does not queue a second. */
static void async_resource_disposal_queues_its_destroy(void) {
  ScrDyn *destroy = scr_dyn_new_func(scr_closure_new(NULL, 0), ar_test_destroy, 1, "(asyncId)",
                                     "destroy");
  double hook = scr_ah_parts(NULL, NULL, NULL, destroy, NULL);
  scr_dyn_release(destroy);
  scr_ah_enable(hook);

  ScrStr *name = scr_str_new("AUTO", 4);
  ScrDyn *type = scr_dyn_new_str(name);
  scr_str_release(name);

  ScrDyn *resource = scr_ar_new(type, NULL);
  assert(resource != NULL);
  assert(test_destroy_calls == 0);
  scr_dyn_release(resource);
  assert(!scr_loop_run(NULL));
  assert(test_destroy_calls == 1);

  ScrDyn *options = scr_dyn_new_obj();
  scr_dyn_obj_set(options, "requireManualDestroy", 20, scr_dyn_new_bool(true));
  ScrDyn *manual = scr_ar_new(type, options);
  scr_dyn_release(options);
  assert(manual != NULL);
  scr_dyn_release(manual);
  assert(!scr_loop_run(NULL));
  assert(test_destroy_calls == 1);

  ScrDyn *destroyed = scr_ar_new(type, NULL);
  assert(destroyed != NULL);
  scr_dyn_release(scr_ar_emit_destroy(destroyed));
  scr_dyn_release(destroyed);
  assert(!scr_loop_run(NULL));
  assert(test_destroy_calls == 2);

  scr_dyn_release(type);
  scr_ah_disable(hook);
  printf("async resource disposal queues its destroy\n");
}

static ScrDyn *ar_test_target(ScrClosure *self, ScrDyn *const *args, size_t argc) {
  (void)self;
  (void)args;
  (void)argc;
  return scr_dyn_undefined();
}

/* A resource the program drops is reclaimed; a binding keeps its payload alive
 * only while the binding itself is reachable, and the loop leaves the live
 * count where it started (no growing registry of finished resources). Calling
 * the binding takes and gives back its own reference, so a called binding is
 * reclaimed like an uncalled one. */
static void async_resource_bindings_own_and_release_their_payload(void) {
  const size_t before = scr_ar_live_resources();
  ScrStr *name = scr_str_new("BOUND", 5);
  ScrDyn *type = scr_dyn_new_str(name);
  scr_str_release(name);
  for (int i = 0; i < 64; i++) {
    ScrDyn *resource = scr_ar_new(type, NULL);
    assert(resource != NULL);
    ScrClosure *closure = scr_closure_new(NULL, 0);
    ScrDyn *target = scr_dyn_new_func(closure, ar_test_target, 0, "()", "target");
    ScrDyn *bound = scr_ar_bind(resource, target, scr_dyn_undefined());
    assert(bound != NULL);
    ScrDyn *called = scr_dyn_call(bound, NULL, 0, "bound");
    assert(called != NULL);
    scr_dyn_release(called);
    /* Dropping the value leaves the binding's reference in place... */
    scr_dyn_release(resource);
    assert(scr_ar_live_resources() == before + 1);
    /* ...and dropping the binding reclaims the payload. */
    scr_dyn_release(bound);
    scr_dyn_release(target);
    assert(scr_ar_live_resources() == before);
  }
  scr_dyn_release(type);
  assert(scr_ar_live_resources() == before);
  printf("async resource bindings own and release their payload\n");
}

/* A resource a bound function keeps alive is disposed with the bound
 * function's last reference: the instance form and the static form both
 * queue the registered destroy. */
static void async_resource_binding_disposal_queues_its_destroy(void) {
  const int before = test_destroy_calls;
  ScrDyn *destroy = scr_dyn_new_func(scr_closure_new(NULL, 0), ar_test_destroy, 1, "(asyncId)",
                                     "destroy");
  double hook = scr_ah_parts(NULL, NULL, NULL, destroy, NULL);
  scr_dyn_release(destroy);
  scr_ah_enable(hook);
  ScrStr *name = scr_str_new("BINDAUTO", 8);
  ScrDyn *type = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *fn = scr_dyn_new_func(scr_closure_new(NULL, 0), ar_test_target, 0, "()", "fn");

  ScrDyn *resource = scr_ar_new(type, NULL);
  assert(resource != NULL);
  ScrDyn *bound = scr_ar_bind(resource, fn, scr_dyn_undefined());
  assert(bound != NULL);
  scr_dyn_release(resource);
  assert(test_destroy_calls == before);
  scr_dyn_release(bound); /* the payload's last reference */
  assert(!scr_loop_run(NULL));
  assert(test_destroy_calls == before + 1);

  ScrDyn *static_bound = scr_ar_bind_static(fn, scr_dyn_undefined(), scr_dyn_undefined());
  assert(static_bound != NULL);
  scr_dyn_release(static_bound);
  assert(!scr_loop_run(NULL));
  assert(test_destroy_calls == before + 2);

  scr_dyn_release(fn);
  scr_dyn_release(type);
  scr_ah_disable(hook);
  printf("async resource bindings queue their destroy\n");
}

/* A cycle the collector reclaims disposes its resources like refcounted
 * ones: each registered destroy is queued from the pass. */
static void async_resource_collected_cycle_queues_its_destroy(void) {
  enum { CYCLES = 32 };
  const int before = test_destroy_calls;
  ScrDyn *destroy = scr_dyn_new_func(scr_closure_new(NULL, 0), ar_test_destroy, 1, "(asyncId)",
                                     "destroy");
  double hook = scr_ah_parts(NULL, NULL, NULL, destroy, NULL);
  scr_dyn_release(destroy);
  scr_ah_enable(hook);
  const double store_id = scr_als_new();
  ScrStr *name = scr_str_new("CYCLEDESTROY", 12);
  ScrDyn *type = scr_dyn_new_str(name);
  scr_str_release(name);
  for (int i = 0; i < CYCLES; i++) {
    ScrDyn *store_value = scr_dyn_new_obj();
    ScrAlsCtx *prev = scr_als_enter(store_id, store_value);
    ScrDyn *resource = scr_ar_new(type, NULL);
    assert(resource != NULL);
    ScrDyn *target =
        scr_dyn_new_func(scr_closure_new(NULL, 0), ar_test_target, 0, "()", "target");
    ScrDyn *bound = scr_ar_bind(resource, target, scr_dyn_undefined());
    assert(bound != NULL);
    scr_dyn_obj_set(store_value, "cb", 2, scr_dyn_retain(bound));
    scr_als_restore(prev);
    scr_dyn_release(resource);
    scr_dyn_release(bound);
    scr_dyn_release(target);
    scr_dyn_release(store_value);
  }
  scr_dyn_release(type);
  scr_collect_cycles();
  assert(!scr_loop_run(NULL));
  assert(test_destroy_calls == before + CYCLES);
  scr_ah_disable(hook);
  printf("collected async resources queue their destroy\n");
}


/* Node keeps a resource's captured store context after emitDestroy — a later
 * runInAsyncScope call or bound callback still runs inside that store — so the
 * destroy does not release it; the context goes with the resource itself when
 * its last reference does. */
static void async_resource_destroy_keeps_its_context(void) {
  const size_t live_before = scr_ar_live_resources();
  ScrStr *value_name = scr_str_new("v", 1);
  ScrDyn *store_value = scr_dyn_new_str(value_name);
  scr_str_release(value_name);
  ScrAlsCtx *prev = scr_als_enter(1, store_value);
  scr_dyn_release(store_value);
  ScrAlsCtx *ctx = scr_als_capture(); /* the active slot's context (+1) */
  assert(ctx != NULL);
  const size_t rc_before = ctx->rc; /* the slot's reference and ours */
  ScrStr *name = scr_str_new("DESTROYED", 9);
  ScrDyn *type = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *resource = scr_ar_new(type, NULL); /* captures the context (+1) */
  assert(resource != NULL);
  scr_als_restore(prev); /* the slot lets go; the resource and we hold it */
  assert(ctx->rc == rc_before);
  ScrDyn *same = scr_ar_emit_destroy(resource);
  assert(same != NULL);
  scr_dyn_release(same);
  assert(ctx->rc == rc_before); /* Node keeps it after the destroy */
  scr_dyn_release(resource);    /* the last reference frees the resource */
  assert(ctx->rc == rc_before - 1); /* and releases the context with it */
  scr_dyn_release(type);
  assert(scr_ar_live_resources() == live_before);
  scr_als_ctx_release(ctx);
  printf("a destroyed async resource keeps its context until the resource is freed\n");
}

/* A store that holds a bound callback of a resource that captured that store is
 * one loop: store value -> callback -> resource -> snapshot -> store value.
 * Nothing in it is reference-counted to zero once the program lets go, so one
 * collector pass has to reclaim the resource and the snapshot — for many
 * requests, the live counts come back to where they started. */
static void async_resource_store_cycle_is_collected(void) {
  const size_t live_before = scr_ar_live_resources();
  const long ctx_before = scr_als_live_contexts();
  const double store_id = scr_als_new();
  ScrStr *name = scr_str_new("CYCLE", 5);
  ScrDyn *type = scr_dyn_new_str(name);
  scr_str_release(name);
  for (int i = 0; i < 64; i++) {
    ScrDyn *store_value = scr_dyn_new_obj();
    ScrAlsCtx *prev = scr_als_enter(store_id, store_value);
    ScrDyn *resource = scr_ar_new(type, NULL);
    assert(resource != NULL);
    ScrClosure *closure = scr_closure_new(NULL, 0);
    ScrDyn *target = scr_dyn_new_func(closure, ar_test_target, 0, "()", "target");
    ScrDyn *bound = scr_ar_bind(resource, target, scr_dyn_undefined());
    assert(bound != NULL);
    scr_dyn_obj_set(store_value, "cb", 2, scr_dyn_retain(bound));
    scr_als_restore(prev);
    /* The program lets go of every direct reference; the loop stays. */
    scr_dyn_release(resource);
    scr_dyn_release(bound);
    scr_dyn_release(target);
    scr_dyn_release(store_value);
  }
  scr_dyn_release(type);
  /* The loop is unreachable: one pass reclaims it, snapshots included. */
  scr_collect_cycles();
  assert(scr_ar_live_resources() == live_before);
  assert(scr_als_live_contexts() == ctx_before);
  printf("a store and a resource that hold each other are collected\n");
}

#define TEARDOWN_CYCLES 256

#ifdef SCR_RC_AUDIT
/* The pass the snapshot probe runs: the snapshot's first entry has just been
 * released, so a resource still pointing at that snapshot would be traced into
 * freed memory. */
static void teardown_cycles_pass(void) { scr_collect_cycles(); }
#endif

/* Exit teardown releases each resource's type and snapshot, and a collection
 * pass must be safe inside that sequence: the resource's children are detached
 * before they are released, and no release in the window asks for a pass. Many
 * cyclic stores left live at exit give the teardown real work; the sanitized
 * build's probe forces a pass at the exact point one snapshot's first entry
 * has been released. */
static void async_resource_teardown_releases_cyclic_stores(void) {
  const size_t before = scr_ar_live_resources();
  ScrStr *name = scr_str_new("TEARDOWN", 8);
  ScrDyn *type = scr_dyn_new_str(name);
  scr_str_release(name);
  for (int i = 0; i < TEARDOWN_CYCLES; i++) {
    const double store_id = scr_als_new();
    ScrDyn *store_value = scr_dyn_new_obj();
    ScrAlsCtx *prev = scr_als_enter(store_id, store_value);
    ScrDyn *resource = scr_ar_new(type, NULL);
    assert(resource != NULL);
    ScrClosure *closure = scr_closure_new(NULL, 0);
    ScrDyn *target = scr_dyn_new_func(closure, ar_test_target, 0, "()", "target");
    ScrDyn *bound = scr_ar_bind(resource, target, scr_dyn_undefined());
    assert(bound != NULL);
    scr_dyn_obj_set(store_value, "cb", 2, scr_dyn_retain(bound));
    scr_als_restore(prev);
    scr_dyn_release(resource);
    scr_dyn_release(bound);
    scr_dyn_release(target);
    scr_dyn_release(store_value);
  }
  scr_dyn_release(type);
  /* The loops are unreachable now; whatever the collector has not reclaimed
   * yet is what the exit teardown releases. */
  assert(scr_ar_live_resources() > before);
#ifdef SCR_RC_AUDIT
  scr_als_ctx_release_probe = teardown_cycles_pass;
#endif
  printf("teardown releases cyclic stores without walking a disposed snapshot\n");
}

/* A promiseResolve hook runs inside the settlement and may drop the last
 * reference the program held to the settling promise; the settlement must
 * finish on a promise it still holds. */
static ScrPromise *settle_hook_promise;
static ScrDyn *settle_hook_release(ScrClosure *self, ScrDyn *const *args, size_t argc) {
  (void)self;
  (void)args;
  (void)argc;
  if (settle_hook_promise != NULL) {
    scr_promise_release(settle_hook_promise); /* the program's only reference */
    settle_hook_promise = NULL;
  }
  return scr_dyn_undefined();
}

static void promise_resolve_hook_can_drop_the_settling_promise(void) {
  scr_async_hooks_install();
  ScrClosure *closure = scr_closure_new(NULL, 0);
  ScrDyn *release = scr_dyn_new_func(closure, settle_hook_release, 1, "(id)", "release");
  double handle = scr_ah_parts(NULL, NULL, NULL, NULL, release); /* promiseResolve slot */
  assert(handle >= 1);
  scr_ah_enable(handle);
  scr_dyn_release(release);
  ScrPromise *p = scr_promise_new();
  settle_hook_promise = p; /* the program keeps exactly this one reference */
  scr_promise_fulfill_void(p); /* the hook releases it mid-settlement */
  assert(settle_hook_promise == NULL);
  printf("a promiseResolve hook may drop the settling promise's owner\n");
}

/* ── the off-loop lookup (scr_net.c's scr_net_resolve_async) ─────────── */

#ifndef _WIN32
/* Interposed for this binary: the resolve the WebSocket dial submits must
 * spend its time on a pool thread, so the loop keeps turning while it
 * waits. POSIX-only; the Windows build calls Winsock's getaddrinfo. */
int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints,
                struct addrinfo **res) {
  (void)service;
  (void)hints;
  if (strcmp(node, "slow.invalid") != 0) return EAI_NONAME;
  scr_loop_sleep(120);
  struct addrinfo *ai = calloc(1, sizeof *ai);
  struct sockaddr_in *addr = calloc(1, sizeof *addr);
  assert(ai != NULL && addr != NULL);
  addr->sin_family = AF_INET;
  addr->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  ai->ai_family = AF_INET;
  ai->ai_socktype = SOCK_STREAM;
  ai->ai_addrlen = sizeof *addr;
  ai->ai_addr = (struct sockaddr *)addr;
  *res = ai;
  return 0;
}

void freeaddrinfo(struct addrinfo *res) {
  if (res == NULL) return;
  free(res->ai_addr);
  free(res);
}

static char lookup_order[8];
static size_t lookup_order_len;
static int lookup_answers;

static void lookup_notes(char at) {
  if (lookup_order_len < sizeof lookup_order) lookup_order[lookup_order_len++] = at;
}

static void lookup_timer_second(ScrClosure *self) {
  (void)self;
  lookup_notes('u');
}

static void lookup_timer_first(ScrClosure *self) {
  (void)self;
  lookup_notes('t');
  scr_set_timeout(scr_closure_new((void *)lookup_timer_second, 0), 0);
}

static void lookup_answered(void *ctx, ScrStr **ips, size_t n) {
  (void)ctx;
  lookup_notes('r');
  lookup_answers = (int)n;
  if (n == 1) assert(strcmp(ips[0]->data, "127.0.0.1") == 0);
}

static void lookup_cancelled(void *ctx) {
  (void)ctx;
  lookup_notes('c');
}

/* The dial's lookup runs on a worker thread: both timers armed before it
 * fire while the resolver is still waiting, and the answer arrives through
 * the loop afterwards. A resolver run on the loop thread would hold the
 * second timer behind the answer. */
static void async_lookup_leaves_the_loop_free(void) {
  lookup_order_len = 0;
  lookup_answers = -1;
  scr_set_timeout(scr_closure_new((void *)lookup_timer_first, 0), 0);
  ScrStr *host = scr_str_new("slow.invalid", 12);
  scr_net_resolve_async(host, &lookup_answered, &lookup_cancelled, NULL);
  scr_str_release(host);
  assert(!scr_loop_run(NULL));
  assert(!scr_exc_pending());
  assert(lookup_answers == 1);
  assert(lookup_order_len == 3 && memcmp(lookup_order, "tur", 3) == 0);
  puts("the dial's lookup runs off the loop thread");
}
#endif

/* The timer heap's FIFO tiebreak and the turn's eligibility snapshot order
 * timers by this sequence, so it must keep counting past 2^32: on Windows an
 * unsigned long sequence wraps there, and a timer armed before the wrap read
 * as armed by the current turn — an ineligible heap root that never fires
 * again. */
static void timer_sequence_orders_past_the_32_bit_boundary(void) {
  _Static_assert(sizeof(((ScrTimer *)0)->seq) >= 8,
                 "the timer sequence must outlast 2^32 arms");
  ScrTimer older = {0};
  ScrTimer newer = {0};
  older.deadline_ms = newer.deadline_ms = 1.0;
  older.seq = 0xFFFFFFF0ull;  /* armed just before the 2^32 wrap */
  newer.seq = 0x100000010ull; /* two turns past it */
  assert(scr_timer_before(&older, &newer));
  assert(!scr_timer_before(&newer, &older));
  printf("timer sequence orders past the 32-bit boundary\n");
}

int main(int argc, char **argv) {
  scr_init();
  if (argc > 1 && strcmp(argv[1], "promises") == 0) {
    promise_table_survives_tombstone_churn();
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "timers") == 0) {
    due_timers_run_by_deadline_before_immediates();
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "turnorder") == 0) {
    timer_armed_during_turn_waits_for_next_timers_phase();
    timer_armed_by_io_callback_waits_for_next_timers_phase();
    tick_armed_timer_runs_before_turn_immediates();
    return 0;
  }
#ifndef _WIN32
  if (argc > 1 && strcmp(argv[1], "resolve") == 0) {
    async_lookup_leaves_the_loop_free();
    return 0;
  }
#endif
  if (argc > 1 && strcmp(argv[1], "timerwrap") == 0) {
    timer_sequence_orders_past_the_32_bit_boundary();
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "destroy") == 0) {
    async_resource_destroy_keeps_its_context();
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "cycle") == 0) {
    async_resource_store_cycle_is_collected();
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "teardown") == 0) {
    async_resource_teardown_releases_cyclic_stores();
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "settlehook") == 0) {
    promise_resolve_hook_can_drop_the_settling_promise();
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "bindings") == 0) {
    async_resource_bindings_own_and_release_their_payload();
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "resources") == 0) {
    async_resource_handles_own_their_payload();
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "execres") == 0) {
    async_resource_execution_resource_owns_its_reference();
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "autodestroy") == 0) {
    async_resource_disposal_queues_its_destroy();
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "binddestroy") == 0) {
    async_resource_binding_disposal_queues_its_destroy();
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "cycledestroy") == 0) {
    async_resource_collected_cycle_queues_its_destroy();
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "immediates") == 0) {
    immediate_queue_reuses_its_slots();
    clearing_the_newest_immediate_does_not_walk_the_cleared_ones();
    return 0;
  }
  enum { COUNT = 128 };
  ScrPromise *jobs[COUNT];
  ScrGen *gens[COUNT];
  ScrPromise *gate = scr_promise_new();
  for (int i = 0; i < COUNT; i++) {
    jobs[i] = scr_async_spawn(shallow_async, gate);
    gens[i] = scr_gen_new(shallow_gen, NULL, NULL);
#ifndef _WIN32
    assert_sparse(gens[i]->fiber, NULL);
#endif
    scr_gen_resume(gens[i]);
    assert(scr_gen_take_out_f64(gens[i]) == 17);
  }
  scr_promise_fulfill_void(gate);
  assert(!scr_loop_run(NULL));
  assert(!scr_exc_pending());
  scr_promise_release(gate);
  for (int i = 0; i < COUNT; i++) {
    scr_promise_release(jobs[i]);
    scr_gen_resume(gens[i]);
    assert(scr_gen_done(gens[i]));
    assert(scr_gen_take_out_f64(gens[i]) == 23);
    scr_gen_release(gens[i]);
  }

  /* Exercise full stack capacity on fresh and reused mappings, and keep a
   * large generator frame parked while other fibers complete. */
  for (int pass = 0; pass < 3; pass++) {
    gate = scr_promise_new();
    ScrGen *gen = scr_gen_new(deep_gen, NULL, NULL);
    scr_gen_resume(gen);
    assert(scr_gen_take_out_f64(gen) == 91);
    for (int i = 0; i < 8; i++) jobs[i] = scr_async_spawn(deep_async, gate);
    scr_promise_fulfill_void(gate);
    assert(!scr_loop_run(NULL));
    assert(!scr_exc_pending());
    scr_promise_release(gate);
    for (int i = 0; i < 8; i++) scr_promise_release(jobs[i]);
    scr_gen_resume(gen);
    assert(scr_gen_done(gen));
    assert(scr_gen_take_out_f64(gen) == 92);
    scr_gen_release(gen);
  }
  /* The last loop turn ran with a deliberately parked generator. Refresh
   * the exhaustion bookkeeping now that every generator has completed. */
  assert(!scr_loop_run(NULL));
  assert(scr_fibers_live == 0);
  puts("fiber stacks stay lazy and preserve large suspended frames");
  return 0;
}
