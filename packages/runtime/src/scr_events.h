/* scriptc runtime — the events unit: signals, exit listeners and stdin
 * (scr_events.c). Included by scr_runtime.h, which says where new
 * declarations go. */
#ifndef SCR_EVENTS_H
#define SCR_EVENTS_H

#include "scr_child.h"
#include "scr_async.h"

/* ── the events unit (scr_events.c — OPTIONAL, link-gated) ────────────
 * Process signal/exit events and the piped-stdin surface. The unit links
 * ONLY into binaries whose IR uses these surfaces (moduleUsesProcessEvents
 * — the scr_regex/scr_fetch/scr_zlib precedent); the emitted main calls
 * scr_events_install(), which fills the loop's nullable event hooks and
 * the two scr_lib.c hooks below. Event-free builds pay zero bytes.
 *
 * Signal events (process.on/once/off of "SIGINT"/"SIGTERM"): sigaction +
 * self-pipe, dispatched at loop turns as macrotasks. Watching replaces the
 * default disposition; removing the last listener restores it. Signal
 * listeners do NOT keep the loop alive (Node). `on` MOVES the callback in;
 * `off` borrows and removes the first pointer-identical entry.
 *
 * The process 'exit' event: listeners run synchronously at normal
 * termination (the unit's atexit) and inside process.exit() (through
 * scr_process_exit_hook); the adapter receives the exit code (runtime
 * thunks below for the 0-param and (code) shapes).
 *
 * process.stdin events (piped-stdin slice) and the for-await chunk
 * source. Listener callbacks MOVE in; data adapters get the chunk
 * BORROWED (the bytes thunk retains for the callee). next_chunk returns a
 * +1 promise of the next chunk — the EMPTY bytes value is the done
 * sentinel (a POSIX read never delivers an empty data chunk). While a
 * consumer exists (data listener or parked chunk promise) stdin keeps the
 * loop alive, like Node's flowing stdin. */
typedef struct ScrBytes ScrBytes; /* full definition below (C11 repeat) */
void scr_events_install(void);
void scr_signal_on(ScrStr *name, ScrDyn *cb, bool once);
void scr_signal_off(ScrStr *name, ScrDyn *cb);
void scr_process_on_exit(ScrClosure *cb, void (*fn)(ScrClosure *, double), bool once);
void scr_process_off_exit(ScrClosure *cb);
void scr_run_exit_listeners(double code);
void scr_exit_thunk0(ScrClosure *cb, double code);
void scr_exit_thunk_code(ScrClosure *cb, double code);
void scr_stdin_on_data(ScrClosure *cb, void (*fn)(ScrClosure *, ScrBytes *), bool once);
/* A string 'data' listener (moves cb): receives each chunk decoded by the
 * stdin's setEncoding decoder; with no encoding set, a delivery throws
 * the setEncoding-state TypeError instead (Node would pass a Buffer). */
void scr_stdin_on_data_str(ScrClosure *cb, void (*fn)(ScrClosure *, ScrStr *), bool once);
/* process.stdin.setEncoding: the canonical encoding (borrowed). */
void scr_stdin_set_encoding(ScrStr *enc);
void scr_stdin_data_thunk_str(ScrClosure *cb, ScrStr *text);
void scr_stdin_on_end(ScrClosure *cb, bool once);
void scr_stdin_on_error(ScrClosure *cb, ScrChildErrFn fn, bool once);
ScrPromise *scr_stdin_next_chunk(void); /* +1 */
void scr_stdin_destroy(void);
bool scr_stdin_pending(void);
/* node:readline's hooks into the stdin unit: removal by closure identity
 * (close() detaches the shared consumer) and the ended probe (EOF seen or
 * destroyed — a later createInterface is born dead). */
void scr_stdin_remove_data(ScrClosure *cb);
bool scr_stdin_ended(void);

#endif /* SCR_EVENTS_H */
