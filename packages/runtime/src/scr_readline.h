/* scriptc runtime — node:readline (scr_readline.c) and the event-loop entry
 * points (scr_async.c). Included by scr_runtime.h, which says where new
 * declarations go. */
#ifndef SCR_READLINE_H
#define SCR_READLINE_H

#include "scr_events.h"

/* ── node:readline and node:readline/promises (scr_readline.c, linked
 * under the events gate) ─────────────────────────────────────────────
 * The non-terminal Interface (the file header has the model). Interfaces
 * are f64 handles. A stream input or output goes through ScrRlIo, which
 * scr_stream.c provides (scr_stream_rl_open), so stdin-only programs
 * never link the stream unit; the stream side feeds input through
 * scr_rl_input_*. Signal-taking entry points get addAbortListener as
 * `add` (scr_events_add_abort_listener), passed only by programs that
 * link the event-target unit. Listener event numbers: 0 'line',
 * 1 'close', 2 'pause', 3 'resume', 4 'error'. */
typedef struct ScrRlIo {
  void (*pause)(void *s);
  void (*resume)(void *s);
  void (*detach)(void *s, double id); /* removes the interface's input listeners */
  void (*write)(void *s, ScrStr *text); /* borrows text */
  /* write(text, cb): borrows text; cb (moves, or NULL) runs when the
   * write completes */
  void (*write_cb)(void *s, ScrStr *text, ScrClosure *cb);
  /* emitKeypressEvents' listeners on the stream: on_event adds cb (moves)
   * for an event emitting nargs pointer arguments; off_event removes cb
   * (borrowed); emit2 emits two borrowed dyn arguments. */
  void (*on_event)(void *s, const char *name, ScrClosure *cb, int nargs);
  void (*off_event)(void *s, const char *name, ScrClosure *cb);
  double (*listener_count)(void *s, const char *name);
  void (*emit2)(void *s, const char *name, void *a, void *b);
  void *(*retain)(void *s);
  void (*drop_data)(void *s, double id); /* a terminal interface's own 'data' listener leaves */
  void (*release)(void *s);
} ScrRlIo;
double scr_rl_open(const ScrRlIo *io, void *in /*+1 or NULL: stdin*/, void *out /*+1 or NULL*/,
                   bool out_stdout, double crlf_delay, ScrStr *prompt, ScrDyn *signal,
                   ScrAbortAddFn add);
void scr_rl_input_bytes(double id, ScrBytes *chunk);
void scr_rl_input_str(double id, ScrStr *chunk);
void scr_rl_input_end(double id);
void scr_rl_input_error(double id, ScrError *err);
/* question: throws ERR_USE_AFTER_CLOSE on a closed interface (may-throw);
 * fn(cb, +1 answer). The promise form never throws. */
void scr_rl_question(double id, ScrStr *query, ScrClosure *cb /*moves*/,
                      void (*fn)(ScrClosure *, ScrStr *));
ScrPromise *scr_rl_question_promise(double id, ScrStr *query, ScrDyn *signal, ScrAbortAddFn add);
/* The same with a checked-dynamic query (borrowed). A query that is not a
 * string makes the prompt write throw ERR_INVALID_ARG_TYPE (the promise
 * form rejects with it) unless the interface is a terminal; the question
 * stays pending, as in Node. */
void scr_rl_question_dyn(double id, ScrDyn *query, ScrClosure *cb /*moves*/,
                         void (*fn)(ScrClosure *, ScrStr *));
ScrPromise *scr_rl_question_promise_dyn(double id, ScrDyn *query, ScrDyn *signal,
                                        ScrAbortAddFn add);
void scr_rl_close(double id);
void scr_rl_pause(double id);  /* may throw ERR_USE_AFTER_CLOSE */
void scr_rl_resume(double id); /* may throw ERR_USE_AFTER_CLOSE */
void scr_rl_prompt(double id); /* may throw ERR_USE_AFTER_CLOSE */
void scr_rl_prompt_with(double id, bool preserve); /* prompt(preserveCursor); may throw */
void scr_rl_set_prompt(double id, ScrStr *prompt);
void scr_rl_set_prompt_dyn(double id, ScrDyn *prompt); /* borrows; may throw */
ScrStr *scr_rl_get_prompt(double id); /* +1; may throw (a prompt that is not a string) */
void scr_rl_write(double id, ScrStr *data); /* may throw ERR_USE_AFTER_CLOSE */
void scr_rl_on(double id, double ev, ScrClosure *cb /*moves*/, void *fn, bool once);
/* createInterface's history and editing options, in Node's order: the
 * flags name the present ones (1 tabSize, 2 escapeCodeTimeout,
 * 4 historySize), checked before the interface opens (validateUint32,
 * the finite escapeCodeTimeout, validateNumber(size, 0)); may throw.
 * set_options and set_history store them on the open interface (history
 * borrowed: rl.history answers that array). */
void scr_rl_check_options(double flags, double tab_size, double escape_timeout, double size);
/* A checked-dynamic completer that is not undefined must be callable
 * (ERR_INVALID_ARG_VALUE); borrowed; may throw. */
void scr_rl_check_completer(ScrDyn *completer);
void scr_rl_set_options(double id, double flags, double size, bool remove_dups, double tab_size,
                        double escape_timeout);
void scr_rl_set_history(double id, ScrArr *history);
/* rl.history: the history option itself, or an empty array the interface
 * keeps (+1). The numeric members (0 historySize, 1 historyIndex,
 * 2 crlfDelay, 3 tabSize, 4 escapeCodeTimeout). */
ScrArr *scr_rl_history(double id);
double scr_rl_num_prop(double id, double which);
/* Terminal mode (scr_readline_tty.c, linked by programs whose interfaces
 * can be terminal ones). scr_rl_terminal runs right after createInterface:
 * mode 0 takes `on` (the terminal option), 2 is an absent `terminal`
 * with process.stdout as the output (output.isTTY); completer is
 * borrowed (the undefined dyn when absent); promises picks
 * readline/promises, whose completer is awaited; inspect is scr_insp_dyn
 * when there is a completer (the inspect unit links only then). */
void scr_rl_terminal(double id, double mode, bool on, ScrDyn *completer, bool promises,
                     ScrStr *(*inspect)(ScrDyn *, double, double));
void scr_rl_mark_promises(double id);
bool scr_rl_is_promises(double id);
bool scr_rl_is_terminal(double id);
/* readline.cursorTo / moveCursor / clearLine / clearScreenDown: the data
 * written (+1; kind 0-3), after the argument checks (may throw), and
 * whether moveCursor writes. */
ScrStr *scr_rl_seq(double kind, double a, double b, bool has_b);
bool scr_rl_moves(double dx, double dy);
/* readline.emitKeypressEvents (scr_readline_tty.c): process.stdin, or a
 * stream through scr_stream_rl_keypress_events; iface is an interface or
 * 0, timeout iface.escapeCodeTimeout or NaN. A 'keypress' listener on
 * process.stdin is a checked-dynamic function (borrowed). */
void scr_rl_keypress_events(const ScrRlIo *io, void *stream, double iface, double timeout);
void scr_stream_rl_keypress_events(ScrStream *s, double iface, double timeout);
void scr_rl_stdin_on_keypress(ScrDyn *cb, bool once);
/* readline/promises Readline: handles over process.stdout/stderr (fd 1/2)
 * or a writable stream (scr_stream_rl_ui_open, which checks isWritable).
 * The actions validate as Node does (ERR_OUT_OF_RANGE; may throw) and
 * queue, or are written on the next tick with autoCommit; commit()
 * answers a +1 promise<void>. */
double scr_rl_ui_open(const ScrRlIo *io, void *out, double fd, bool auto_commit);
double scr_rl_ui_open_fd(double fd, bool auto_commit);
double scr_stream_rl_ui_open(ScrStream *out, bool auto_commit); /* may throw */
void scr_rl_ui_cursor_to(double id, double x, bool has_y, double y);
void scr_rl_ui_move_cursor(double id, double dx, double dy);
void scr_rl_ui_clear_line(double id, double dir);
void scr_rl_ui_clear_screen_down(double id);
void scr_rl_ui_rollback(double id);
ScrPromise *scr_rl_ui_commit(double id);
/* getCursorPos() (scr_readline_tty.c): which 0 rows, 1 cols */
double scr_rl_cursor_pos(double id, double which);
ScrStr *scr_rl_line(double id); /* +1 */
/* rl.cursor; a non-terminal interface's (undefined) throws SC2020 */
double scr_rl_cursor(double id);
/* write(data, key): has_data false for undefined or null data, has_name
 * false for a key without a name; may throw ERR_USE_AFTER_CLOSE. */
void scr_rl_write_key(double id, bool has_data, ScrStr *data, bool has_key, bool has_name,
                      ScrStr *name, bool ctrl, bool meta, bool shift);
void scr_rl_iter_open(double id);
ScrPromise *scr_rl_iter_next(double id); /* +1 promise<dyn>: the line, or undefined */
void scr_rl_iter_return(double id);
/* Listener adapters: line/answer (fn(cb, +1 text)) and error listeners. */
void scr_rl_answer_thunk0(ScrClosure *cb, ScrStr *answer);
void scr_rl_answer_thunk_str(ScrClosure *cb, ScrStr *answer);
void scr_rl_error_thunk(ScrClosure *cb, ScrError *err);
void scr_rl_history_thunk_arr(ScrClosure *cb, ScrArr *history);
void scr_rl_history_thunk_dyn(ScrClosure *cb, ScrArr *history);
void scr_rl_error_thunk0(ScrClosure *cb, ScrError *err);
void scr_rl_answer_thunk_dyn(ScrClosure *cb, ScrStr *answer);
void scr_rl_error_thunk_dyn(ScrClosure *cb, ScrError *err);
/* createInterface with a stream input and/or output (scr_stream.c): in is
 * the input stream or NULL for process.stdin; out the output stream or
 * NULL (out_stdout picks process.stdout). Both borrowed, like prompt
 * (NULL: the default "> "). */
/* A checked-dynamic input or output as its stream (+1; NULL for an output
 * of null or undefined); refuses other values (may throw). */
ScrStream *scr_stream_rl_from_dyn(const ScrDyn *value, bool output);
double scr_stream_rl_open(ScrStream *in, ScrStream *out, bool out_stdout, double crlf_delay,
                          ScrStr *prompt, ScrDyn *signal, ScrAbortAddFn add);
void scr_stdin_data_thunk0(ScrClosure *cb, ScrBytes *chunk);
void scr_stdin_data_thunk_bytes(ScrClosure *cb, ScrBytes *chunk);
/* The loop-side registration (scr_async.c, always linked) and the
 * scr_lib.c hooks the unit fills. The abnormal-exit code hint lives in
 * scr_async.c so the uncaught/unhandled reporters can note it whether or
 * not the unit is present. */
void scr_loop_set_events(bool (*pending)(void), bool (*watching)(void),
                          void (*dispatch)(void), int (*pollfds)(int out[2]));
extern SCR_TL void (*scr_process_exit_hook)(double code);
extern SCR_TL void (*scr_stdin_destroy_hook)(void);
void scr_exit_code_note(int code);
int scr_exit_code_hint_get(void);
/* The pollable child-exit wake fd (the child kqueue / pidfd epoll) for the loop's
 * poll(2) sleep, or -1 when it can't wake for every pending child. */
int scr_children_wake_fd(void);
double scr_now_ms(void); /* the loop's monotonic clock, in ms */
/* Run to ordinary loop exhaustion, except that a non-NULL executable
 * module-root promise stops the loop as soon as it is rejected at a
 * microtask checkpoint. Fulfilled roots do not stop the loop: Node keeps
 * running ref'd work scheduled by a successfully evaluated module.
 * Returns true when a default/listener-crashing unhandled rejection
 * already selected and reported exit status 1. */
bool scr_loop_run(ScrPromise *top_level);
void scr_loop_commonjs_entry(void);
bool scr_report_unhandled_rejections(void); /* true = exit 1 */
void scr_discard_unhandled_rejections(void);
long scr_abandoned_fiber_count(void);


void *scr_fiber_self(void);
void scr_note_abandoned_fibers(long n); /* scr_console.c owns the flag */

/* new Promise(executor): kind 0 f64, 1 bool, 2 str, 3 void; ref-kind
 * resolve thunks are emitted (they know the concrete RC helpers) over
 * scr_resolve_ref_impl, constructed via scr_make_resolve_fn. The
 * executor runs synchronously; an escaping throw rejects the promise. */
ScrClosure *scr_make_resolve(ScrPromise *p, int kind);
ScrClosure *scr_make_resolve_fn(ScrPromise *p, void *fn);
void scr_resolve_ref_impl(ScrClosure *self, void *v, void *(*retain)(void *), void (*release)(void *), ScrTraceFn trace);
/* The reject closure: `(reason: Error) => void` — stores the reason as a
 * SCR_EXC_OBJ payload (the thrown-Error representation) and wakes waiters;
 * a reject after any settle is a no-op (first settle wins, exactly JS). */
ScrClosure *scr_make_reject(ScrPromise *p);
void scr_promise_run_executor(ScrPromise *p, ScrClosure *exec, ScrClosure *resolve);
void scr_promise_run_executor0(ScrPromise *p, ScrClosure *exec);
void scr_promise_run_executor2(ScrPromise *p, ScrClosure *exec, ScrClosure *resolve, ScrClosure *reject);

/* The promise a fiber settles (borrowed) — the emitted trampolines fulfill
 * through it. */
ScrPromise *scr_fiber_promise(ScrFiber *f);

#endif /* SCR_READLINE_H */
