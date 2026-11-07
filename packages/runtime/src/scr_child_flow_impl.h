/* The operations of child stream flow control (see scr_child_flow.h for the
 * rules). scr_child.c's SCR_CHILD_STREAM_FLOW build includes this file once
 * in each platform arm, after scr_child_stream_watching: everything here
 * works on that arm's ScrChildStream and its static helpers, and the arm's
 * read pump, EOF path, listener registration, settle path and teardown each
 * call one function below.
 *
 * A stream with a flow state sets close_wait for good. The arm's own code
 * then never takes a stream out of the watch count because its last
 * listener left (flow decides that here, through
 * scr_child_stream_watching), and a later 'close' registration finds the
 * flag set and leaves the count alone. */

#ifdef _WIN32
#define SCR_CHILD_FLOW_EMIT scr_child_stream_emit
static void scr_child_stream_emit(ScrChildStream *s, ScrBytes *bytes, ScrStr *text);
#else
#define SCR_CHILD_FLOW_EMIT scr_child_stream_emit_posix
static void scr_child_stream_emit_posix(ScrChildStream *s, ScrBytes *bytes, ScrStr *text);
#endif
static void scr_child_stream_finish(ScrChildStream *s, bool fire_end);
static void scr_children_closing_poll(void);

/* Applies a change of scr_child_stream_watching's answer to the loop's
 * watch count and the read filter, as the arm does when a stream's first
 * consumer arrives or its last one leaves. */
static void scr_child_flow_rewatch(ScrChildStream *s, bool was) {
  bool now = scr_child_stream_watching(s);
  if (was == now) return;
  if (now) {
    scr_child_streams_watching++;
#ifndef _WIN32
    scr_child_stream_arm(s);
#endif
  } else {
    scr_child_streams_watching--;
#ifndef _WIN32
    scr_child_stream_dearm(s);
    if (s->uncounted) {
      s->uncounted = false;
      scr_children_unwatched--;
    }
#endif
  }
}

/* The first pause() or resume(): from here on flow decides when the stream
 * reads. */
static void scr_child_flow_enter(ScrChildStream *s, unsigned char state) {
  bool was = scr_child_stream_watching(s);
  s->flow.state = state;
  s->close_wait = true;
  scr_child_flow_rewatch(s, was);
}

/* ── the queue of chunks held back ───────────────────────────────────── */

static void scr_child_flow_push(ScrChildStream *s, ScrBytes *bytes, ScrStr *text, size_t len) {
  ScrChildFlowChunk *chunk = calloc(1, sizeof *chunk);
  if (!chunk) scr_child_oom();
  chunk->bytes = bytes ? scr_bytes_retain(bytes) : NULL;
  chunk->text = text ? scr_str_retain(text) : NULL;
  chunk->len = len;
  if (s->flow.tail) s->flow.tail->next = chunk;
  else s->flow.head = chunk;
  s->flow.tail = chunk;
  s->flow.len += len;
}

static void scr_child_flow_chunk_free(ScrChildFlowChunk *chunk) {
  scr_bytes_release(chunk->bytes);
  scr_str_release(chunk->text);
  free(chunk);
}

/* The stream's last reference went: drop what it still held back. */
static void scr_child_flow_free(ScrChildStream *s) {
  while (s->flow.head) {
    ScrChildFlowChunk *chunk = s->flow.head;
    s->flow.head = chunk->next;
    scr_child_flow_chunk_free(chunk);
  }
  s->flow.tail = NULL;
  s->flow.len = 0;
}

/* ── ticks ───────────────────────────────────────────────────────────────
 * Node runs the drain, the owed 'end' and the exit flush as process
 * ticks. Each one here is a raw entry on the same queue as the program's
 * own nextTick callbacks, so the two interleave in the order they were
 * queued; this list holds what each entry is for. */

enum { SCR_CHILD_FLOW_TICK_DRAIN, SCR_CHILD_FLOW_TICK_END, SCR_CHILD_FLOW_TICK_FLUSH };

typedef struct ScrChildFlowTick {
  struct ScrChildFlowTick *next;
  ScrChildStream *s; /* +1 */
  int kind;
} ScrChildFlowTick;

static SCR_TL ScrChildFlowTick *scr_child_flow_ticks = NULL;
static SCR_TL ScrChildFlowTick *scr_child_flow_ticks_tail = NULL;

static void scr_child_flow_run_tick(void);

static void scr_child_flow_tick(ScrChildStream *s, int kind) {
  ScrChildFlowTick *tick = calloc(1, sizeof *tick);
  if (!tick) scr_child_oom();
  tick->s = scr_child_stream_retain(s);
  tick->kind = kind;
  if (scr_child_flow_ticks_tail) scr_child_flow_ticks_tail->next = tick;
  else scr_child_flow_ticks = tick;
  scr_child_flow_ticks_tail = tick;
  scr_next_tick_raw(scr_child_flow_run_tick);
}

/* Loop teardown: the queued entries never run. */
static void scr_child_flow_teardown(void) {
  while (scr_child_flow_ticks) {
    ScrChildFlowTick *tick = scr_child_flow_ticks;
    scr_child_flow_ticks = tick->next;
    scr_child_stream_release(tick->s);
    free(tick);
  }
  scr_child_flow_ticks_tail = NULL;
}

/* Node's resume_ and flow(): the chunks held back, in order, while the
 * stream stays flowing. With every chunk delivered and the pipe at EOF,
 * 'end' follows on a further tick (endReadable). */
static void scr_child_flow_drain(ScrChildStream *s) {
  s->flow.drain_tick = false;
  while (s->flow.state == SCR_CHILD_FLOW_FLOWING && s->flow.head != NULL) {
    ScrChildFlowChunk *chunk = s->flow.head;
    bool was = scr_child_stream_watching(s);
    s->flow.head = chunk->next;
    if (s->flow.head == NULL) s->flow.tail = NULL;
    s->flow.len -= chunk->len;
    scr_child_flow_rewatch(s, was);
    SCR_CHILD_FLOW_EMIT(s, chunk->bytes, chunk->text);
    scr_child_flow_chunk_free(chunk);
    if (scr_exc_pending()) return;
  }
  if (s->flow.state == SCR_CHILD_FLOW_FLOWING && s->flow.head == NULL && s->flow.ended &&
      !s->eof && !s->flow.end_tick) {
    s->flow.end_tick = true;
    scr_child_flow_tick(s, SCR_CHILD_FLOW_TICK_END);
  }
}

/* Node's endReadableNT: the owed 'end', once nothing is held back, whether
 * or not the stream was paused again since. The child's 'close' was
 * waiting for it. */
static void scr_child_flow_end(ScrChildStream *s) {
  s->flow.end_tick = false;
  if (s->eof || s->flow.head != NULL) return;
  scr_child_stream_finish(s, true);
  if (!scr_exc_pending()) scr_children_closing_poll();
}

static void scr_child_flow_resume(ScrChildStream *s);

static void scr_child_flow_run_tick(void) {
  ScrChildFlowTick *tick = scr_child_flow_ticks;
  if (tick == NULL) return;
  scr_child_flow_ticks = tick->next;
  if (scr_child_flow_ticks == NULL) scr_child_flow_ticks_tail = NULL;
  ScrChildStream *s = tick->s;
  int kind = tick->kind;
  free(tick);
  if (kind == SCR_CHILD_FLOW_TICK_DRAIN) {
    scr_child_flow_drain(s);
  } else if (kind == SCR_CHILD_FLOW_TICK_END) {
    scr_child_flow_end(s);
  } else if (s->flow.state == SCR_CHILD_FLOW_PAUSED) {
    scr_child_flow_resume(s); /* flushStdio */
  }
  scr_child_stream_release(s);
}

/* ── what the arm calls ──────────────────────────────────────────────── */

/* A chunk the pump read. False: the stream has no flow state and the pump
 * delivers the chunk as it always did. Otherwise the chunk is decoded as
 * Node decodes on push, and either goes to the listeners now (flowing with
 * nothing held back) or joins the queue. */
static bool scr_child_flow_take(ScrChildStream *s, const char *data, size_t len) {
  if (s->flow.state == SCR_CHILD_FLOW_NONE) return false;
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)len);
  bytes->is_buffer = true; /* Node delivers a Buffer */
  memcpy(bytes->data, data, len);
  ScrStr *text = NULL;
  if (s->encoding != NULL) {
    text = scr_strdec_write(s->encoding, s->dec_pending, bytes);
    s->dec_pending = scr_strdec_next(s->encoding, s->dec_pending, bytes);
  }
  if (text != NULL && text->len == 0) {
    /* only part of a character so far */
  } else if (s->flow.state == SCR_CHILD_FLOW_FLOWING && s->flow.head == NULL) {
    SCR_CHILD_FLOW_EMIT(s, text == NULL ? bytes : NULL, text);
  } else {
    bool was = scr_child_stream_watching(s);
    scr_child_flow_push(s, text == NULL ? bytes : NULL, text, len);
    scr_child_flow_rewatch(s, was);
  }
  scr_str_release(text);
  scr_bytes_release(bytes);
  return true;
}

/* EOF, before the arm fires 'end'. True: 'end' is owed instead (the stream
 * is paused, or flowing with chunks still to drain). The pipe closes and
 * the stream leaves the watch count, but `eof` stays false, so listeners
 * still register and the child's 'close' waits; the decoder's tail joins
 * the queue as Node pushes it. False: nothing is held back and the arm
 * fires 'end' as for any stream, which is also how the owed 'end' is
 * delivered later. */
static bool scr_child_flow_defer_end(ScrChildStream *s) {
  if (s->flow.ended || s->flow.state == SCR_CHILD_FLOW_NONE) return false;
  if (s->flow.state == SCR_CHILD_FLOW_FLOWING && s->flow.head == NULL) return false;
  if (scr_child_stream_watching(s)) scr_child_streams_watching--;
  if (s->encoding != NULL) {
    ScrStr *tail = scr_strdec_end(s->encoding, s->dec_pending);
    s->dec_pending = 0;
    if (tail->len > 0) scr_child_flow_push(s, NULL, tail, tail->len);
    scr_str_release(tail);
  }
#ifdef _WIN32
  if (s->h != NULL) {
    CloseHandle(s->h);
    s->h = NULL;
  }
#else
  if (s->uncounted) {
    s->uncounted = false;
    scr_children_unwatched--;
  }
  if (s->fd >= 0) {
    close(s->fd);
    s->fd = -1;
  }
#endif
  s->flow.ended = true;
  return true;
}

/* on/once("data") and on/once("end") on a stream with a flow state. False:
 * no flow state, the arm registers the listener as it always did. A
 * registration never changes whether such a stream reads (Node: a 'data'
 * listener does not resume a paused stream), and one made while 'end' is
 * owed is kept, since the pipe is closed but the stream has not ended. */
static bool scr_child_flow_on_data(ScrChildStream *s, ScrClosure *cb /*moves*/,
                                   ScrChildStreamDataFn fn, ScrChildStreamDataStrFn str_fn,
                                   bool once) {
  s->flow.listened = true;
  if (s->flow.state == SCR_CHILD_FLOW_NONE) return false;
  if (s->eof) {
    scr_closure_release(cb);
    return true;
  }
  if (s->n_data == s->cap_data) {
    s->cap_data = s->cap_data ? s->cap_data * 2 : 2;
    s->data_ls = realloc(s->data_ls, s->cap_data * sizeof *s->data_ls);
    if (!s->data_ls) scr_child_oom();
  }
  s->data_ls[s->n_data++] = (ScrChildStreamDataL){
      .cb = cb, .fn = fn, .str_fn = str_fn,
      .kind = str_fn != NULL ? SCR_CHILD_DATA_STRING
          : fn == &scr_child_stream_thunk0 ? SCR_CHILD_DATA_ZERO : SCR_CHILD_DATA_BYTES,
      .once = once};
  return true;
}

static bool scr_child_flow_on_end(ScrChildStream *s, ScrClosure *cb /*moves*/, bool once) {
  if (s->flow.state == SCR_CHILD_FLOW_NONE) return false;
  if (s->eof) {
    scr_closure_release(cb);
    return true;
  }
  if (s->n_end == s->cap_end) {
    s->cap_end = s->cap_end ? s->cap_end * 2 : 2;
    s->end_ls = realloc(s->end_ls, s->cap_end * sizeof *s->end_ls);
    if (!s->end_ls) scr_child_oom();
  }
  s->end_ls[s->n_end].cb = cb;
  s->end_ls[s->n_end].once = once;
  s->n_end++;
  return true;
}

/* setEncoding on a stream that holds chunks back: Node decodes what is
 * buffered into one string, which the listeners get as one chunk. */
static void scr_child_flow_set_encoding(ScrChildStream *s) {
  if (s->flow.head == NULL) return;
  ScrStr *content = scr_str_new("", 0);
  size_t len = s->flow.len;
  for (ScrChildFlowChunk *chunk = s->flow.head; chunk; chunk = chunk->next) {
    ScrStr *part = chunk->text ? scr_str_retain(chunk->text)
        : scr_strdec_write(s->encoding, s->dec_pending, chunk->bytes);
    if (chunk->text == NULL) {
      s->dec_pending = scr_strdec_next(s->encoding, s->dec_pending, chunk->bytes);
    }
    ScrStr *joined = scr_str_concat(content, part);
    scr_str_release(content);
    scr_str_release(part);
    content = joined;
  }
  scr_child_flow_free(s);
  if (content->len > 0) scr_child_flow_push(s, NULL, content, len);
  scr_str_release(content);
}

/* The child's terminal event was delivered: Node resumes each of its stdio
 * streams on the tick after the listeners (flushStdio), so a stream paused
 * before the exit, or by one of those listeners, flows again. */
static void scr_child_flow_exit(ScrChildStream *s) {
  if (s != NULL && !s->eof) scr_child_flow_tick(s, SCR_CHILD_FLOW_TICK_FLUSH);
}

/* A child started with exec()/execFile() and a callback: Node calls it back
 * on 'close', after the child's streams ended. So what a paused stream of
 * such a child still holds goes to its listeners here, before the callback,
 * with its owed 'end', and not on the ticks after the 'exit' listeners. */
static void scr_child_flow_exec_flush(ScrChildStream *s) {
  if (s == NULL || s->eof || s->flow.state != SCR_CHILD_FLOW_PAUSED) return;
  scr_child_flow_enter(s, SCR_CHILD_FLOW_FLOWING);
  scr_child_flow_drain(s);
  /* The settle path decides the child's own 'close' right after this, so
   * the owed 'end' is delivered without the close poll its tick runs. */
  if (!scr_exc_pending() && s->flow.ended && s->flow.head == NULL && !s->eof) {
    scr_child_stream_finish(s, true);
  }
}

static void scr_child_flow_resume(ScrChildStream *s) {
  if (s->flow.state == SCR_CHILD_FLOW_FLOWING) return;
  scr_child_flow_enter(s, SCR_CHILD_FLOW_FLOWING);
  if (!s->eof && !s->flow.drain_tick && (s->flow.head != NULL || s->flow.ended)) {
    s->flow.drain_tick = true;
    scr_child_flow_tick(s, SCR_CHILD_FLOW_TICK_DRAIN);
  }
}

/* ── the members ─────────────────────────────────────────────────────── */

/* stream.pause(): +1 receiver (Node returns the stream). */
ScrChildStream *scr_child_stream_pause(ScrChildStream *s) {
  if (s->flow.state != SCR_CHILD_FLOW_PAUSED) scr_child_flow_enter(s, SCR_CHILD_FLOW_PAUSED);
  return scr_child_stream_retain(s);
}

/* stream.resume(): +1 receiver. */
ScrChildStream *scr_child_stream_resume(ScrChildStream *s) {
  scr_child_flow_resume(s);
  return scr_child_stream_retain(s);
}

bool scr_child_stream_is_paused(ScrChildStream *s) {
  return s->flow.state == SCR_CHILD_FLOW_PAUSED;
}

/* stream.readableFlowing: 0 false, 1 true, -1 null (no 'data' listener was
 * ever registered and the stream was never paused or resumed). */
double scr_child_stream_flowing(ScrChildStream *s) {
  if (s->flow.state == SCR_CHILD_FLOW_PAUSED) return 0;
  if (s->flow.state == SCR_CHILD_FLOW_FLOWING || s->flow.listened) return 1;
  return -1;
}

#undef SCR_CHILD_FLOW_EMIT
