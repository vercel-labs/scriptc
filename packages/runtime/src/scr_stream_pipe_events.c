/* stream — Node's pipe lifecycle for programs that pipe.
 *
 * pipe() and unpipe() are linked by every stream program (the data path
 * unpipes a destroyed destination, and an untyped call can reach pipe), so
 * what Node's pipe() adds to them — the listeners that unpipe a
 * destination when it finishes, closes or errors, and unpipe's 'pause' —
 * sits behind scr_stream_pipe_ops. This unit, selected by a program that
 * pipes, unpipes or builds a pipeline, installs the table; the
 * implementation is in scr_stream.c, beside the stream state it reads, and
 * is linked only through this reference.
 */
#include "scr_runtime.h"

__attribute__((constructor)) static void scr_stream_pipe_events_install(void) {
  scr_stream_pipe_ops = &scr_stream_pipe_events_ops;
}
