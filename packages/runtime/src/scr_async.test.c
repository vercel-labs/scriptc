/* White-box memory contract: small suspended fibers must not commit their
 * whole stack, but large live frames must still survive awaits and yields.
 * With the argument `timers`: the order of a loop turn's due timers and
 * immediates. */
#undef NDEBUG
#include "scr_async.c"
#include <assert.h>

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

int main(int argc, char **argv) {
  scr_init();
  if (argc > 1 && strcmp(argv[1], "timers") == 0) {
    due_timers_run_by_deadline_before_immediates();
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
