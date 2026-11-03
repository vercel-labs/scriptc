/* The call-time parameter bind (fn.generator.bindAtCall): an optional unit,
 * linked only into programs whose IR carries a bind barrier, so every other
 * program keeps the default runtime objects byte for byte. The protocol is
 * in scr_generator.h. */
#include "scr_runtime.h"
#include "scr_generator_private.h"

#include <string.h>

/* scr_async.c's scr_gen_exc_move, repeated for the one hand-off that crosses
 * this unit's boundary: a bind failure lands in async_error, where
 * scr_gen_switched_back puts an async generator body's exception, and the
 * call must throw it. The caller's cell is empty when the bind runs, and
 * both cells keep their stack frames. */
static void scr_gen_bind_throw(ScrExcCell *dst, ScrExcCell *src) {
  ScrStackFrame *dst_stack = dst->stack;
  ScrStackFrame *src_stack = src->stack;
  *dst = *src;
  dst->stack = dst_stack;
  memset(src, 0, sizeof *src);
  src->stack = src_stack;
  scr_exc_cell_changed();
}

/* The barrier suspends without a value in the stackless form (coro.suspend
 * writes no slot), but the fiber form parks the valueless yield, whose slot
 * is an empty REF. Clear that marker so a bound generator stays parked
 * exactly like one that has not yielded: otherwise OUT reads as a value, and
 * the next settlement takes the stale slot for a yielded (or completion)
 * result — an async generator's await would settle its request with the
 * marker, and its later completion would read the same slot twice. */
static void scr_gen_bind_park(ScrGen *g) {
  if (g->state != SCR_GEN_DONE) {
    g->out.kind = SCR_EXC_NONE;
    g->out.payload = NULL;
    g->out.release_fn = NULL;
  }
  /* The hop parked the generator where an await would; a request expects a
   * yield there. */
  if (g->is_async && g->state == SCR_GEN_AWAITING) g->state = SCR_GEN_SUSPENDED;
}

void scr_gen_bind(ScrGen *g) {
  if (!g->is_async || g->state != SCR_GEN_UNSTARTED) {
    /* A synchronous generator reports a bind failure through the caller's
     * cell, and scr_gen_step resets IN as every step does. */
    (void)scr_gen_step(g);
    scr_gen_bind_park(g);
    return;
  }
  /* An async generator's prologue parks its exception in async_error, which
   * Node throws from the call. The spawn wrapper built a fresh generator, so
   * nothing has stored IN yet. */
  scr_gen_resume(g);
  if (g->async_error.kind != SCR_EXC_NONE) {
    scr_gen_bind_throw(scr_exc_current_cell(), &g->async_error);
    return;
  }
  scr_gen_bind_park(g);
}
