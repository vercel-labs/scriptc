/* scriptc runtime — parallel loops (@scriptc/experimental: parallelInto,
 * parallelReduce, parallelFor). Included by scr_runtime.h, which says where
 * new declarations go. */
#ifndef SCR_PARALLEL_H
#define SCR_PARALLEL_H

#include "scr_closure.h"
#include "scr_bytes.h"

/* ── parallel loops (scr_parallel.c) ──────────────────────────────────
 * The three calls of @scriptc/experimental split [0, count) into chunks of
 * `grain` indices and run the callbacks once per chunk. The chunk
 * boundaries are the ones packages/experimental/index.js computes: a
 * chunk's indices are [i * grain, min((i + 1) * grain, count)), and the
 * fold of parallelReduce runs left to right in chunk order, so the result
 * never depends on the number of threads.
 *
 * The callbacks are closures the compiler built in the caller's frame
 * (stack-callbacks.ts); every one of them is called as compiled closures
 * are, with the closure pointer as the environment:
 *   parallelInto:  void body(env, part, start, end)
 *   parallelReduce: double part(env, start, end), double combine(env, l, r)
 *   parallelFor:   void body(env, start, end)
 *
 * `part` is a 64-byte header built in the frame of the thread running the
 * chunk: it points into the target's storage and carries no owner, so
 * nothing retains or frees the target from several threads at once. The
 * body may not let it escape (the compiler accepts only bodies that write
 * `part`'s elements and reads captured typed arrays).
 *
 * Entry checks run before the first chunk and throw the same RangeError
 * as the Node implementation with `scr_throw_error_msg`: the caller's
 * pending check reports it. `parallel` is 0 when the compiler resolved
 * the call to the sequential loop (an unaccepted body, a worker program,
 * Windows): the chunks then run one after another on the calling thread,
 * exact Node behavior and order.
 *
 * `reads` names the typed arrays the body reads. When one of them overlaps
 * the target, the job runs sequentially, because a chunk writing part of
 * the target could race with a read of another chunk's part. */
typedef void (*ScrParBody)(ScrClosure *env, ScrBytes *part, double start, double end);
typedef void (*ScrParRange)(ScrClosure *env, double start, double end);
typedef double (*ScrParPart)(ScrClosure *env, double start, double end);
typedef double (*ScrParCombine)(ScrClosure *env, double left, double right);

/* Fills `target` chunk by chunk. */
void scr_par_into(ScrBytes *target, double stride, double grain_given, double grain,
                  double parallel, ScrClosure *body, ScrBytes **reads, size_t nreads);

/* Folds one value per chunk from left to right in chunk order. */
double scr_par_reduce(double count, double grain_given, double grain, double initial,
                      double parallel, ScrClosure *part, ScrClosure *combine);

/* Calls `body` once per chunk. Runs sequentially until the compiler can
 * prove the writes disjoint. */
void scr_par_for(double count, double grain_given, double grain, double parallel,
                 ScrClosure *body);

#endif
