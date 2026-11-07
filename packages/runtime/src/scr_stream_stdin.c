/* process.stdin as a node:stream Readable (the stream.stdioReadable libCall).
 *
 * In Node process.stdin is a Readable, so a program may hand it to anything
 * that takes one. The process stream handle answers its one stream here, as
 * process.stdout and process.stderr answer theirs (scr_stream_stdio_writable)
 * and a cipher handle its Transform (scr_stream_of_handle): each thread keeps
 * one Readable for descriptor 0, created by the first conversion, so every
 * conversion answers the same object and its listeners and readable state are
 * shared.
 *
 * The stdin unit (scr_events.c) stays the only reader of descriptor 0. The
 * stream is one of its consumers: the first time the stream is asked for
 * data it registers a 'data', an 'end' and an 'error' listener there, pushes
 * each chunk it is handed, ends at the unit's 'end' and is destroyed with the
 * unit's error. A chunk therefore reaches a listener registered on
 * process.stdin and a listener registered on the stream once each. Until the
 * stream is read nothing is registered, so a program that converts
 * process.stdin and never reads it leaves descriptor 0 alone, as Node leaves
 * a paused stdin.
 *
 * When the stream's buffer is full (a paused stream, or a pipe whose
 * destination is behind) the unit is paused, which is what Node's one
 * stream does under backpressure, and the stream's next request for data
 * resumes it. destroy() on the stream destroys the unit's input.
 *
 * Linked only by programs that convert process.stdin (the streamStdin link
 * feature), so every other program's stream and stdin units are unchanged. */
#include "scr_runtime.h"

static SCR_TL ScrStream *scr_stream_stdin = NULL; /* +1 until exit */
static SCR_TL bool scr_stream_stdin_fed = false;      /* listeners registered with the unit */
static SCR_TL bool scr_stream_stdin_held = false;     /* this unit paused the input */

static void scr_stream_stdin_data(ScrClosure *cb, ScrBytes *chunk) {
  (void)cb;
  ScrStream *s = scr_stream_stdin;
  if (s == NULL) return;
  if (!scr_stream_push(s, chunk)) {
    scr_stream_stdin_held = true;
    scr_stdin_pause();
  }
}

static void scr_stream_stdin_end(ScrClosure *cb) {
  (void)cb;
  if (scr_stream_stdin != NULL) (void)scr_stream_push_null(scr_stream_stdin);
}

static void scr_stream_stdin_error(ScrClosure *cb, ScrStr *message) {
  (void)cb;
  ScrStream *s = scr_stream_stdin;
  if (s == NULL) return;
  ScrError *error = scr_event_error_payload != NULL ? scr_error_retain(scr_event_error_payload)
                                                    : scr_error_new(0 /* Error */, message);
  scr_stream_release(scr_stream_destroy(s, error));
  scr_error_release(error);
}

/* The stream's _read: start (or resume) the input. */
static void scr_stream_stdin_read(ScrClosure *cb, ScrStream *s, double size) {
  (void)cb;
  (void)size;
  if (scr_stdin_ended()) {
    (void)scr_stream_push_null(s);
    return;
  }
  if (!scr_stream_stdin_fed) {
    scr_stream_stdin_fed = true;
    scr_stdin_on_data(scr_closure_new((void *)scr_stream_stdin_data, 0), scr_stream_stdin_data, false);
    scr_stdin_on_end(scr_closure_new((void *)scr_stream_stdin_end, 0), false);
    scr_stdin_on_error(scr_closure_new((void *)scr_stream_stdin_error, 0), scr_stream_stdin_error, false);
  }
  if (scr_stream_stdin_held) {
    scr_stream_stdin_held = false;
    scr_stdin_resume();
  }
}

/* The stream's _destroy: the input is torn down with it, as destroying
 * process.stdin does. */
static void scr_stream_stdin_destroy(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)cb;
  scr_stdin_destroy();
  scr_stream_destroy_done(s, err ? scr_error_retain(err) : NULL);
}

/* At exit. A listener that captures an object holding the stream (a class
 * that keeps the stream in a field and listens on it) forms a cycle through
 * the stream's listener table. This cache is the stream's reference from
 * outside the program, so the table is emptied before the reference goes. */
static void scr_stream_stdin_free(void) {
  ScrStream *s = scr_stream_stdin;
  scr_stream_stdin = NULL;
  if (s == NULL) return;
  scr_stream_release((ScrStream *)scr_emitter_remove_all((ScrEmitter *)s, NULL, true));
  scr_stream_release(s);
}

/* process.stdin flowing into a Readable slot: the thread's stdin stream (+1). */
ScrStream *scr_stream_stdio_readable(void) {
  if (scr_stream_stdin == NULL) {
    scr_atexit(scr_stream_stdin_free);
    scr_stream_stdin = scr_stream_new_readable(-1, true, true,
        scr_closure_new((void *)scr_stream_stdin_read, 0), scr_stream_stdin_read,
        scr_closure_new((void *)scr_stream_stdin_destroy, 0), scr_stream_stdin_destroy);
  }
  return scr_stream_retain(scr_stream_stdin);
}
