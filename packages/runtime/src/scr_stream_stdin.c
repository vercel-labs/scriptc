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
 * Node has one object there, with one flowing state, whichever name the
 * program uses. So from its creation this stream holds that state for both
 * names: it starts in the state process.stdin was put in before (paused,
 * resumed, read by a 'readable' listener, an encoding), and pause(),
 * resume(), isPaused() and setEncoding() through the process.stdin name act
 * on it (the ScrStdinView the stdin unit is given here).
 *
 * The stdin unit (scr_events.c) stays the only reader of descriptor 0 and
 * becomes this stream's source. The stream's _read is a pull: the unit reads
 * the next input and hands it over, whether the stream flows or is read in
 * paused mode by read(), an iteration or a 'readable' listener. Pausing
 * therefore stops 'data' events, not reads, which is what paused mode means
 * in Node. A stream nobody reads asks for nothing, so a program that
 * converts process.stdin and never reads it leaves descriptor 0 alone, and a
 * paused stream does not hold the process.
 *
 * Listeners registered through the process.stdin name stay in the unit's
 * tables. Its 'data' listeners get each chunk as the stream takes it, its
 * 'readable' and 'end' listeners follow this stream's events (one listener
 * of this stream for each), and its read() is this stream's read().
 * destroy() on the stream destroys the unit's input.
 *
 * Linked only by programs that convert process.stdin (the streamStdin link
 * feature), so every other program's stream and stdin units are unchanged. */
#include "scr_runtime.h"

static SCR_TL ScrStream *scr_stream_stdin = NULL; /* +1 until exit */
static SCR_TL bool scr_stream_stdin_fed = false;      /* the error listener is registered with the unit */
static SCR_TL bool scr_stream_stdin_readable = false; /* this stream's 'readable' reaches the unit's listeners */

/* One listener of this stream for an event without arguments. */
static void scr_stream_stdin_follow(ScrStream *s, const char *event, void (*fn)(ScrClosure *)) {
  ScrStr *name = scr_str_new(event, strlen(event));
  scr_emitter_release(scr_emitter_on((ScrEmitter *)s, name, scr_closure_new((void *)fn, 0),
                                     scr_ee_inv_fixed0, false, false));
  scr_str_release(name);
}

/* resume() after a file's input ended unread: Node's resume reads once
 * (read(0)), which ends a stream that holds nothing, flowing or not. */
static void scr_stream_stdin_on_resume(ScrClosure *cb) {
  (void)cb;
  if (scr_stream_stdin != NULL) scr_stream_read_zero(scr_stream_stdin);
}

/* A pull's answer from the unit: the next input, or NULL at its end. */
static void scr_stream_stdin_chunk(ScrBytes *chunk) {
  ScrStream *s = scr_stream_stdin;
  if (s == NULL) return;
  if (chunk == NULL) {
    if (!scr_stdin_from_file()) {
      (void)scr_stream_push_null(s);
      return;
    }
    /* Input from a file: Node reads it through a file stream, which does
     * not read again at the end. A paused stream with nothing held then
     * emits 'readable' and ends at the next read, where a pipe's stream
     * ends at once. */
    (void)scr_stream_push_null_unread(s);
    scr_stream_stdin_follow(s, "resume", scr_stream_stdin_on_resume);
    return;
  }
  /* Node's stdin yields Buffers; the unit marks the chunks of its own
   * iteration the same way. */
  chunk->is_buffer = true;
  (void)scr_stream_push(s, chunk);
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

/* The stream's _read: ask the unit for the next input. */
static void scr_stream_stdin_read(ScrClosure *cb, ScrStream *s, double size) {
  (void)cb;
  (void)size;
  if (scr_stdin_ended()) {
    (void)scr_stream_push_null(s);
    return;
  }
  if (!scr_stream_stdin_fed) {
    scr_stream_stdin_fed = true;
    scr_stdin_on_error(scr_closure_new((void *)scr_stream_stdin_error, 0), scr_stream_stdin_error, false);
  }
  if (scr_stream_flowing(s) == 1 && scr_stdin_has_readable_listener()) {
    /* The stream flows although process.stdin has a 'readable' listener.
     * Node cannot be in that state: the listener pins paused mode, and a
     * pipe from the stream moves nothing until something reads. The
     * runtime's pipe starts the flow whatever listens, so the input would
     * go where Node sends none; the read is refused by name instead. */
    static const char msg[] =
        "process.stdin piped as a stream.Readable while process.stdin has a 'readable' listener "
        "is not supported: in Node that listener keeps the stream paused (remove the listener, or "
        "read the stream in it) [SC2020]";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "SC2020");
    return;
  }
  scr_stdin_pull();
}

/* The stream's _destroy: the input is torn down with it, as destroying
 * process.stdin does. */
static void scr_stream_stdin_destroy(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)cb;
  scr_stdin_destroy();
  scr_stream_destroy_done(s, err ? scr_error_retain(err) : NULL);
}

/* The stream's 'end' and 'readable' reach the listeners registered through
 * the process.stdin name. */
static void scr_stream_stdin_on_end(ScrClosure *cb) {
  (void)cb;
  scr_stdin_view_end();
}

static void scr_stream_stdin_on_readable(ScrClosure *cb) {
  (void)cb;
  scr_stdin_view_readable();
}

/* The process.stdin name's state calls: this stream's. */
static void scr_stream_stdin_pause(void) {
  if (scr_stream_stdin != NULL) scr_stream_release(scr_stream_pause(scr_stream_stdin));
}

static void scr_stream_stdin_resume(void) {
  if (scr_stream_stdin != NULL) scr_stream_release(scr_stream_resume(scr_stream_stdin));
}

static bool scr_stream_stdin_is_paused(void) {
  return scr_stream_stdin != NULL && scr_stream_is_paused(scr_stream_stdin);
}

/* 'pause' on the stream (pause() through either name, readline closing,
 * an unpipe): the unit stops reading, as Node's stdin does on 'pause', so
 * a paused stdin does not hold the process. The read the stream had asked
 * for is closed with an empty chunk, which adds nothing and lets the next
 * read(), iteration step, 'readable' listener or resume() ask again. */
static void scr_stream_stdin_on_pause(ScrClosure *cb) {
  (void)cb;
  ScrStream *s = scr_stream_stdin;
  if (s == NULL || !scr_stdin_pull_cancel()) return;
  ScrBytes *none = scr_bytes_new(SCR_BYTES_U8, 0);
  (void)scr_stream_push(s, none);
  scr_bytes_release(none);
}

static void scr_stream_stdin_set_encoding(ScrStr *enc) {
  if (scr_stream_stdin != NULL) scr_stream_release(scr_stream_set_encoding(scr_stream_stdin, enc));
}

/* A listener registered through the process.stdin name. A 'data' listener
 * starts the flow unless the stream is paused, as Readable#on does; the
 * first 'readable' listener becomes a 'readable' listener of this stream,
 * which pins paused mode and starts reading ahead. */
static void scr_stream_stdin_listening(bool readable) {
  ScrStream *s = scr_stream_stdin;
  if (s == NULL) return;
  if (!readable) {
    if (scr_stream_flowing(s) != 0) scr_stream_release(scr_stream_resume(s));
  } else if (!scr_stream_stdin_readable) {
    scr_stream_stdin_readable = true;
    scr_stream_stdin_follow(s, "readable", scr_stream_stdin_on_readable);
  }
}

static ScrBytes *scr_stream_stdin_read_held(double size) {
  return scr_stream_stdin != NULL ? scr_stream_read(scr_stream_stdin, size) : NULL;
}

static const ScrStdinView scr_stream_stdin_view = {
    scr_stream_stdin_chunk,        scr_stream_stdin_pause,     scr_stream_stdin_resume,
    scr_stream_stdin_is_paused,    scr_stream_stdin_set_encoding, scr_stream_stdin_listening,
    scr_stream_stdin_read_held,
};

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
    scr_stream_stdin_follow(scr_stream_stdin, "end", scr_stream_stdin_on_end);
    scr_stream_stdin_follow(scr_stream_stdin, "pause", scr_stream_stdin_on_pause);
    scr_stdin_view_open(&scr_stream_stdin_view);
  }
  return scr_stream_retain(scr_stream_stdin);
}
