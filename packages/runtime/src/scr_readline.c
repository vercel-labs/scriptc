/* node:readline and node:readline/promises — the Interface
 * (lib/internal/readline/interface.js) over process.stdin or a stream
 * input, linked only when the program uses it (the events gating;
 * rl.* libCalls imply events). The stream side (listeners on the input,
 * pause/resume, output writes) lives in scr_stream.c behind ScrRlIo, so
 * stdin-only programs never link the stream unit. Terminal interfaces
 * hand their input, prompts and writes to scr_readline_tty.c through
 * scr_rl_tty_ops; the rest of this file is the non-terminal path.
 *
 * Behavior, matching Node v24.15.0:
 * - Input bytes run through a UTF-8 decoder that holds an incomplete
 *   trailing sequence for the next chunk (StringDecoder); invalid bytes
 *   decode to U+FFFD. String chunks pass through unchanged.
 * - Lines split on /\r?\n|\r(?!\n)/: a trailing \r ends its line at once,
 *   and a \n starting the next chunk is dropped when it arrives within
 *   crlfDelay ms (default and minimum 100).
 * - Each line answers a pending question, or else is emitted as 'line'.
 *   A second question while one is pending writes the prompt again and is
 *   otherwise ignored.
 * - The input's 'end' emits a non-empty partial line as 'line' (a pending
 *   question does not receive it), then close().
 * - close() pauses (emitting 'pause' when not already paused), removes
 *   the input listeners, and emits 'close' synchronously. A pending
 *   question is never answered.
 * - Prompts are written only when an output was given.
 * - The async iterator is events.on(rl, 'line', { close: ['close'],
 *   highWaterMark: 1024 }): lines queue until next() takes them, the
 *   input pauses above 1024 queued lines and resumes once the queue
 *   empties, and return() stops listening while queued lines stay
 *   readable.
 * - On stdin, an interface created after stdin ended is DEAD: a question
 *   still writes its prompt, but nothing ever answers and 'close' never
 *   fires. */
#include "scr_readline_internal.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void scr_rl_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static void *scr_rl_grow(void *p, size_t *cap, size_t need, size_t elem) {
  if (need <= *cap) return p;
  size_t c = *cap ? *cap * 2 : 4;
  while (c < need) c *= 2;
  void *q = realloc(p, c * elem);
  if (!q) scr_rl_oom();
  *cap = c;
  return q;
}

/* The Interface, its listeners and the terminal hooks live in
 * scr_readline_internal.h, shared with scr_readline_tty.c. */
SCR_TL const ScrRlTtyOps *scr_rl_tty_ops = NULL;

static SCR_TL ScrRl *scr_rls = NULL;
static SCR_TL double scr_rl_next_id = 1;
static SCR_TL size_t scr_rl_stdin_open = 0; /* open stdin interfaces */
static SCR_TL ScrClosure *scr_rl_data_cb = NULL; /* the shared stdin consumer (borrowed) */
static SCR_TL bool scr_rl_end_registered = false;

ScrRl *scr_rl_find(double id) {
  for (ScrRl *rl = scr_rls; rl; rl = rl->next) {
    if (rl->id == id) return rl;
  }
  return NULL;
}

static void scr_rl_throw_closed(void) {
  static const char m[] = "readline was closed";
  scr_throw_error_msg_code(SCR_ERR_ERROR, m, sizeof m - 1, "ERR_USE_AFTER_CLOSE");
}

/* ── listeners ─────────────────────────────────────────────────────── */

static void scr_rl_add(ScrRl *rl, int ev, ScrClosure *cb /*moves*/, void *fn, bool once, bool iter) {
  RlList *l = &rl->ev[ev];
  l->v = scr_rl_grow(l->v, &l->cap, l->n + 1, sizeof *l->v);
  l->v[l->n++] = (RlEntry){cb, fn, once, iter};
}

static void scr_rl_remove_iter(ScrRl *rl) {
  for (int ev = 0; ev < RL_EV_COUNT; ev++) {
    RlList *l = &rl->ev[ev];
    size_t k = 0;
    for (size_t i = 0; i < l->n; i++) {
      if (!l->v[i].iter) l->v[k++] = l->v[i];
    }
    l->n = k;
  }
}

static void scr_rl_iter_line(ScrRl *rl, ScrStr *line /*moves*/);
static void scr_rl_iter_error(ScrRl *rl, ScrError *err);
static void scr_rl_iter_close(ScrRl *rl);

/* emit(ev, ...): a snapshot in listener order; once-listeners leave before
 * they run (Node's onceWrapper). `line` is borrowed (each line listener
 * receives its own +1); `err` is borrowed. */
void scr_rl_emit(ScrRl *rl, int ev, ScrStr *line, ScrError *err) {
  RlList *l = &rl->ev[ev];
  size_t n = l->n;
  if (n == 0) return;
  RlEntry *snap = malloc(n * sizeof *snap);
  if (!snap) scr_rl_oom();
  memcpy(snap, l->v, n * sizeof *snap);
  for (size_t i = 0; i < n; i++) {
    if (!snap[i].iter) scr_closure_retain(snap[i].cb);
  }
  size_t k = 0;
  for (size_t i = 0; i < l->n; i++) {
    if (l->v[i].once) {
      if (!l->v[i].iter) scr_closure_release(l->v[i].cb);
    } else {
      l->v[k++] = l->v[i];
    }
  }
  l->n = k;
  for (size_t i = 0; i < n; i++) {
    RlEntry e = snap[i];
    if (!scr_exc_pending()) {
      if (e.iter) {
        if (ev == RL_EV_LINE) scr_rl_iter_line(rl, scr_str_retain(line));
        else if (ev == RL_EV_ERROR) scr_rl_iter_error(rl, err);
        else if (ev == RL_EV_CLOSE) scr_rl_iter_close(rl);
      } else if (ev == RL_EV_LINE) {
        ((ScrRlLineFn)e.fn)(e.cb, scr_str_retain(line));
      } else if (ev == RL_EV_ERROR) {
        ((ScrRlErrFn)e.fn)(e.cb, err);
      } else if (ev == RL_EV_HISTORY && e.fn) {
        ((ScrRlHistoryFn)e.fn)(e.cb, scr_rl_history_of(rl));
      } else {
        ((void (*)(ScrClosure *))e.cb->fn)(e.cb);
      }
    }
    if (!e.iter) scr_closure_release(e.cb);
  }
  free(snap);
}

ScrArr *scr_rl_history_of(ScrRl *rl) {
  if (!rl->history) rl->history = scr_arr_new(SCR_ELEM_STR, 0);
  return rl->history;
}

/* emit('history', this.history): the listeners get the array itself */
void scr_rl_emit_history(ScrRl *rl) { scr_rl_emit(rl, RL_EV_HISTORY, NULL, NULL); }

/* ── output, pause/resume ──────────────────────────────────────────── */

void scr_rl_write_out(ScrRl *rl, ScrStr *text) {
  if (rl->out) rl->io->write(rl->out, text);
  else if (rl->out_stdout) scr_stdio_write_str(1, text);
}

static void scr_rl_feed_bytes(ScrRl *rl, const char *p, size_t n);

/* pause()/resume() without the closed check (Node's methods throw on a
 * closed interface; close() itself pauses first). */
void scr_rl_do_pause(ScrRl *rl) {
  if (rl->paused) return;
  if (rl->in) rl->io->pause(rl->in);
  rl->paused = true;
  scr_rl_emit(rl, RL_EV_PAUSE, NULL, NULL);
}

void scr_rl_do_resume(ScrRl *rl) {
  if (!rl->paused) return;
  if (rl->in) rl->io->resume(rl->in);
  rl->paused = false;
  if (rl->tty) scr_rl_tty_ops->resumed(rl);
  scr_rl_emit(rl, RL_EV_RESUME, NULL, NULL);
  /* stdin bytes that arrived while paused (the pipe holds them in Node) */
  if (rl->stdin_in && rl->parked_len > 0 && !rl->closed) {
    char *p = rl->parked;
    size_t n = rl->parked_len;
    rl->parked = NULL;
    rl->parked_len = rl->parked_cap = 0;
    scr_rl_feed_bytes(rl, p, n);
    free(p);
  }
}

bool scr_rl_prompt_writable(ScrRl *rl) {
  if (!rl->prompt_value) return true;
  scr_dyn_arg_type_fail("stringToWrite", "of type string", rl->prompt_value);
  return false;
}

static void scr_rl_prompt_now(ScrRl *rl) {
  if (rl->paused) scr_rl_do_resume(rl);
  if (scr_exc_pending()) return;
  if (rl->tty) scr_rl_tty_ops->prompt(rl, false);
  else if (scr_rl_prompt_writable(rl)) scr_rl_write_out(rl, rl->prompt);
}

/* setPrompt(this[kOldPrompt]) when a question is answered or cancelled */
static void scr_rl_restore_prompt(ScrRl *rl) {
  if (!rl->old_prompt) return;
  scr_str_release(rl->prompt);
  rl->prompt = rl->old_prompt;
  rl->old_prompt = NULL;
  if (rl->prompt_value) scr_dyn_release(rl->prompt_value);
  rl->prompt_value = rl->old_prompt_value;
  rl->old_prompt_value = NULL;
}

/* ── close ─────────────────────────────────────────────────────────── */

static void scr_rl_detach_stdin(ScrRl *rl) {
  if (!rl->stdin_in || rl->dead) return;
  if (scr_rl_stdin_open > 0) scr_rl_stdin_open--;
  /* The last stdin interface leaving detaches the shared consumer so the
   * loop stops waiting on fd 0 (Node's pause-on-close). */
  if (scr_rl_stdin_open == 0 && scr_rl_data_cb != NULL) {
    scr_stdin_remove_data(scr_rl_data_cb);
    scr_rl_data_cb = NULL;
  }
}

void scr_rl_settle_close(ScrRl *rl) {
  if (rl->closed) return;
  scr_rl_do_pause(rl);
  if (scr_exc_pending()) return;
  if (rl->tty) scr_rl_tty_ops->closing(rl); /* kSetRawMode(false) */
  rl->closed = true;
  /* onSelfCloseWithoutTerminal: the input listeners go first (they were
   * registered at construction). */
  if (rl->in) {
    rl->io->detach(rl->in, rl->id);
    rl->io->release(rl->in);
    rl->in = NULL;
  }
  scr_rl_detach_stdin(rl);
  if (rl->abort_dispose) {
    ScrDyn *d = rl->abort_dispose;
    rl->abort_dispose = NULL;
    ScrDyn *r = scr_dyn_call(d, NULL, 0, "dispose");
    if (r) scr_dyn_release(r);
    scr_dyn_release(d);
  }
  if (rl->q_cb) {
    scr_closure_release(rl->q_cb); /* a pending question never answers */
    rl->q_cb = NULL;
  }
  scr_rl_emit(rl, RL_EV_CLOSE, NULL, NULL);
  free(rl->line_buf);
  rl->line_buf = NULL;
  rl->line_len = rl->line_cap = 0;
  free(rl->parked);
  rl->parked = NULL;
  rl->parked_len = rl->parked_cap = 0;
  if (rl->out) {
    rl->io->release(rl->out);
    rl->out = NULL;
  }
}

/* ── lines ─────────────────────────────────────────────────────────── */

/* kOnLine: a pending question takes the line, else 'line'. Moves line. */
void scr_rl_on_line(ScrRl *rl, ScrStr *line) {
  if (rl->q_cb) {
    ScrClosure *cb = rl->q_cb;
    ScrRlLineFn fn = rl->q_fn;
    rl->q_cb = NULL;
    scr_rl_restore_prompt(rl);
    fn(cb, line);
    scr_closure_release(cb);
    return;
  }
  scr_rl_emit(rl, RL_EV_LINE, line, NULL);
  scr_str_release(line);
}

static void scr_rl_buf_append(ScrRl *rl, const char *p, size_t n) {
  rl->line_buf = scr_rl_grow(rl->line_buf, &rl->line_cap, rl->line_len + n + 1, 1);
  memcpy(rl->line_buf + rl->line_len, p, n);
  rl->line_len += n;
}

/* The end of the line starting at `i` in text without a CR: the next LF,
 * or n when the text ends first. */
static size_t scr_rl_next_lf(const char *p, size_t i, size_t n) {
  const char *lf = memchr(p + i, '\n', n - i);
  return lf ? (size_t)(lf - p) : n;
}

/* The end of the line starting at `i`: the next LF or CR, or n. */
static size_t scr_rl_next_break(const char *p, size_t i, size_t n) {
  while (i < n && p[i] != '\n' && p[i] != '\r') i++;
  return i;
}

/* kNormalWrite over decoded UTF-8 text. The text is scanned once: LF-only
 * text (no CR anywhere in it) moves from LF to LF with memchr, other text
 * splits at LF, CR and CRLF. The unfinished line before the text only
 * joins the first line, so the rest of the text is never copied whole. */
static void scr_rl_feed_text(ScrRl *rl, const char *p, size_t n) {
  if (rl->tty) {
    scr_rl_tty_ops->feed(rl, p, n);
    return;
  }
  if (rl->saw_return_at != 0 && scr_now_ms() - rl->saw_return_at <= rl->crlf_delay) {
    if (n > 0 && p[0] == '\n') {
      p++;
      n--;
    }
    rl->saw_return_at = 0;
  }
  bool cr = n > 0 && memchr(p, '\r', n) != NULL;
  size_t end = n == 0 ? 0 : cr ? scr_rl_next_break(p, 0, n) : scr_rl_next_lf(p, 0, n);
  if (end == n) {
    if (n > 0) scr_rl_buf_append(rl, p, n);
    return;
  }
  rl->saw_return_at = p[n - 1] == '\r' ? scr_now_ms() : 0;
  /* Split first (the remainder becomes the new unfinished line before any
   * line is delivered, as in Node), then deliver in order. */
  size_t n_lines = 0, cap_lines = 0;
  ScrStr **lines = NULL;
  size_t start = 0;
  while (end < n) {
    lines = scr_rl_grow(lines, &cap_lines, n_lines + 1, sizeof *lines);
    if (n_lines == 0 && rl->line_len > 0) {
      scr_rl_buf_append(rl, p, end);
      lines[n_lines++] = scr_str_new(rl->line_buf, rl->line_len);
    } else {
      lines[n_lines++] = scr_str_new(p + start, end - start);
    }
    start = end + (p[end] == '\r' && end + 1 < n && p[end + 1] == '\n' ? 2 : 1);
    end = start >= n ? n : cr ? scr_rl_next_break(p, start, n) : scr_rl_next_lf(p, start, n);
  }
  rl->line_len = 0;
  if (start < n) scr_rl_buf_append(rl, p + start, n - start);
  for (size_t i = 0; i < n_lines; i++) {
    if (rl->closed || scr_exc_pending()) {
      scr_str_release(lines[i]);
      continue;
    }
    scr_rl_on_line(rl, lines[i]);
  }
  free(lines);
}

/* The length of an incomplete UTF-8 sequence ending the buffer (0 when the
 * buffer ends on a complete sequence or invalid bytes). */
size_t scr_rl_incomplete_tail(const unsigned char *p, size_t n) {
  for (size_t back = 1; back <= 3 && back <= n; back++) {
    unsigned char c = p[n - back];
    if ((c & 0xC0) == 0x80) continue; /* a continuation byte */
    size_t need = c >= 0xF0 && c <= 0xF4   ? 4
                  : c >= 0xE0 && c <= 0xEF ? 3
                  : c >= 0xC2 && c <= 0xDF ? 2
                                           : 0;
    return need > back ? back : 0;
  }
  return 0;
}

/* decoder.write(bytes) then kNormalWrite. */
static void scr_rl_feed_bytes(ScrRl *rl, const char *p, size_t n) {
  if (rl->stdin_in && rl->paused && !rl->closed) {
    rl->parked = scr_rl_grow(rl->parked, &rl->parked_cap, rl->parked_len + n, 1);
    memcpy(rl->parked + rl->parked_len, p, n);
    rl->parked_len += n;
    return;
  }
  /* ASCII with no held bytes decodes to itself: split it in place. */
  if (rl->n_held == 0 && scr_bytes_ascii_span(p, n) == n) {
    scr_rl_feed_text(rl, p, n);
    return;
  }
  size_t total = rl->n_held + n;
  unsigned char *all = malloc(total ? total : 1);
  if (!all) scr_rl_oom();
  memcpy(all, rl->held, rl->n_held);
  memcpy(all + rl->n_held, p, n);
  size_t tail = scr_rl_incomplete_tail(all, total);
  rl->n_held = tail;
  memcpy(rl->held, all + total - tail, tail);
  ScrStr *text = scr_str_from_utf8_lossy(all, total - tail);
  free(all);
  scr_rl_feed_text(rl, text->data, text->len);
  scr_str_release(text);
}

/* The input ended: a non-empty unfinished line is emitted as 'line' (not
 * offered to a pending question), then close(). */
static void scr_rl_feed_end(ScrRl *rl) {
  if (rl->closed) return;
  if (rl->tty) {
    scr_rl_tty_ops->end(rl);
    return;
  }
  if (rl->line_len > 0) {
    ScrStr *line = scr_str_new(rl->line_buf, rl->line_len);
    rl->line_len = 0;
    scr_rl_emit(rl, RL_EV_LINE, line, NULL);
    scr_str_release(line);
    if (scr_exc_pending()) return;
  }
  scr_rl_settle_close(rl);
}

void scr_rl_input_bytes(double id, ScrBytes *chunk) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) return;
  /* The splitter copies every line it keeps before it delivers one, so it
   * can read a chunk's own storage; shared memory is copied out first. */
  if (!chunk->shared) {
    scr_rl_feed_bytes(rl, (const char *)chunk->data, chunk->len);
    return;
  }
  char *p = malloc(chunk->len ? chunk->len : 1);
  if (!p) scr_rl_oom();
  scr_bytes_read(chunk, 0, p, chunk->len);
  scr_rl_feed_bytes(rl, p, chunk->len);
  free(p);
}

void scr_rl_input_str(double id, ScrStr *chunk) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) return;
  scr_rl_feed_text(rl, chunk->data, chunk->len);
}

void scr_rl_input_end(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (rl) scr_rl_feed_end(rl);
}

/* The input's 'error' becomes the interface's: with no listener (the
 * iterator counts as one), it is thrown, as EventEmitter's emit('error')
 * throws. */
void scr_rl_input_error(double id, ScrError *err) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl) return;
  if (rl->ev[RL_EV_ERROR].n == 0) {
    scr_throw_obj(scr_error_retain(err), &scr_error_retain_v, &scr_error_release_v,
                  scr_error_trace_arg());
    return;
  }
  scr_rl_emit(rl, RL_EV_ERROR, NULL, err);
}

/* ── stdin input ───────────────────────────────────────────────────── */

/* The shared stdin consumer: every open stdin interface gets each chunk. */
static void scr_rl_data_adapter(ScrClosure *cb, ScrBytes *chunk) {
  (void)cb;
  for (ScrRl *rl = scr_rls; rl; rl = rl->next) {
    if (rl->closed || rl->dead || !rl->stdin_in) continue;
    scr_rl_input_bytes(rl->id, chunk);
    if (scr_exc_pending()) return;
  }
}

static void scr_rl_end_thunk(ScrClosure *cb) {
  (void)cb;
  scr_rl_data_cb = NULL; /* the stdin unit dropped its listeners itself */
  for (ScrRl *rl = scr_rls; rl; rl = rl->next) {
    if (rl->closed || rl->dead || !rl->stdin_in) continue;
    if (rl->parked_len > 0) {
      /* parked bytes still end their lines before the input ends */
      bool paused = rl->paused;
      rl->paused = false;
      char *p = rl->parked;
      size_t n = rl->parked_len;
      rl->parked = NULL;
      rl->parked_len = rl->parked_cap = 0;
      scr_rl_feed_bytes(rl, p, n);
      free(p);
      rl->paused = paused;
      if (scr_exc_pending()) return;
    }
    scr_rl_feed_end(rl);
    if (scr_exc_pending()) return;
  }
}

/* ── async iteration (events.on) ───────────────────────────────────── */

static void scr_rl_iter_settle_done(ScrPromise *p) {
  scr_promise_fulfill_ref(p, scr_dyn_retain(scr_dyn_undefined()), scr_dyn_retain_v,
                          scr_dyn_release_v, NULL);
}

static void scr_rl_iter_settle_line(ScrPromise *p, ScrStr *line /*moves*/) {
  ScrDyn *v = scr_dyn_new_str(line);
  scr_str_release(line);
  scr_promise_fulfill_ref(p, v, scr_dyn_retain_v, scr_dyn_release_v, NULL);
}

static void scr_rl_iter_reject(ScrPromise *p, ScrError *err) {
  scr_throw_obj(scr_error_retain(err), &scr_error_retain_v, &scr_error_release_v,
                scr_error_trace_arg());
  scr_promise_reject_pending(p);
}

static ScrPromise *scr_rl_iter_shift_waiter(RlIter *it) {
  ScrPromise *p = it->waiters[0];
  memmove(it->waiters, it->waiters + 1, (it->wn - 1) * sizeof *it->waiters);
  it->wn--;
  return p;
}

/* closeHandler */
static void scr_rl_iter_close(ScrRl *rl) {
  RlIter *it = rl->iter;
  if (!it) return;
  scr_rl_remove_iter(rl);
  it->finished = true;
  it->paused = false;
  while (it->wn > 0) {
    ScrPromise *p = scr_rl_iter_shift_waiter(it);
    scr_rl_iter_settle_done(p);
    scr_promise_release(p);
  }
}

/* eventHandler */
static void scr_rl_iter_line(ScrRl *rl, ScrStr *line) {
  RlIter *it = rl->iter;
  if (it->finished) {
    scr_str_release(line);
    return;
  }
  if (it->wn > 0) {
    ScrPromise *p = scr_rl_iter_shift_waiter(it);
    scr_rl_iter_settle_line(p, line);
    scr_promise_release(p);
    return;
  }
  it->q = scr_rl_grow(it->q, &it->cap, it->head + it->len + 1, sizeof *it->q);
  it->q[it->head + it->len++] = line;
  if (!it->paused && it->len > 1024) {
    it->paused = true;
    if (!rl->closed) scr_rl_do_pause(rl);
  }
}

/* errorHandler */
static void scr_rl_iter_error(ScrRl *rl, ScrError *err) {
  RlIter *it = rl->iter;
  if (it->wn > 0) {
    ScrPromise *p = scr_rl_iter_shift_waiter(it);
    scr_rl_iter_reject(p, err);
    scr_promise_release(p);
  } else if (!it->error) {
    it->error = scr_error_retain(err);
  }
  scr_rl_iter_close(rl);
}

/* rl[Symbol.asyncIterator](): one iterator per interface, created on the
 * first call; it listens for 'line', 'error' and 'close' from then on. */
void scr_rl_iter_open(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->iter) return;
  rl->iter = calloc(1, sizeof *rl->iter);
  if (!rl->iter) scr_rl_oom();
  scr_rl_add(rl, RL_EV_LINE, NULL, NULL, false, true);
  scr_rl_add(rl, RL_EV_ERROR, NULL, NULL, false, true);
  scr_rl_add(rl, RL_EV_CLOSE, NULL, NULL, false, true);
}

/* next(): a promise of the next line, or of undefined once done. */
ScrPromise *scr_rl_iter_next(double id) {
  ScrPromise *p = scr_promise_new();
  ScrRl *rl = scr_rl_find(id);
  RlIter *it = rl ? rl->iter : NULL;
  if (!it) {
    scr_rl_iter_settle_done(p);
    return p;
  }
  if (it->len > 0) {
    ScrStr *line = it->q[it->head++];
    it->len--;
    if (it->len == 0) it->head = 0;
    if (it->paused && it->len < 1) {
      it->paused = false;
      if (!rl->closed) scr_rl_do_resume(rl);
    }
    scr_rl_iter_settle_line(p, line);
    return p;
  }
  if (it->error) {
    ScrError *err = it->error;
    it->error = NULL;
    scr_rl_iter_reject(p, err);
    scr_error_release(err);
    return p;
  }
  if (it->finished) {
    scr_rl_iter_settle_done(p);
    return p;
  }
  it->waiters = scr_rl_grow(it->waiters, &it->wcap, it->wn + 1, sizeof *it->waiters);
  it->waiters[it->wn++] = scr_promise_retain(p);
  return p;
}

/* return(): the loop left early. */
void scr_rl_iter_return(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (rl) scr_rl_iter_close(rl);
}

/* ── creation ──────────────────────────────────────────────────────── */

static void scr_rl_iter_free(RlIter *it) {
  for (size_t i = 0; i < it->len; i++) scr_str_release(it->q[it->head + i]);
  free(it->q);
  for (size_t i = 0; i < it->wn; i++) scr_promise_release(it->waiters[i]);
  free(it->waiters);
  if (it->error) scr_error_release(it->error);
  free(it);
}

static void scr_rl_ask_release_v(void *p);

/* Exit-time cleanup (the events-unit precedent, before the RC audit):
 * whatever an interface still holds releases here. */
static void scr_rl_cleanup_atexit(void) {
  ScrRl *rl = scr_rls;
  scr_rls = NULL;
  while (rl) {
    ScrRl *next = rl->next;
    if (rl->q_cb) scr_closure_release(rl->q_cb);
    for (int ev = 0; ev < RL_EV_COUNT; ev++) {
      for (size_t i = 0; i < rl->ev[ev].n; i++) {
        if (!rl->ev[ev].v[i].iter) scr_closure_release(rl->ev[ev].v[i].cb);
      }
      free(rl->ev[ev].v);
    }
    if (rl->iter) scr_rl_iter_free(rl->iter);
    if (rl->abort_dispose) scr_dyn_release(rl->abort_dispose);
    if (rl->history) scr_arr_release(rl->history);
    if (rl->q_ask) scr_rl_ask_release_v(rl->q_ask);
    if (rl->tty) scr_rl_tty_ops->free(rl);
    if (rl->in) rl->io->release(rl->in);
    if (rl->out) rl->io->release(rl->out);
    scr_str_release(rl->prompt);
    if (rl->old_prompt) scr_str_release(rl->old_prompt);
    if (rl->prompt_value) scr_dyn_release(rl->prompt_value);
    if (rl->old_prompt_value) scr_dyn_release(rl->old_prompt_value);
    free(rl->line_buf);
    free(rl->parked);
    free(rl);
    rl = next;
  }
}

static void scr_rl_close_job(ScrClosure *job) {
  ScrRl *rl = scr_rl_find(scr_box_get_f64(job->caps[0]));
  if (rl) scr_rl_settle_close(rl);
}

static ScrDyn *scr_rl_abort_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrRl *rl = scr_rl_find(scr_box_get_f64(clo->caps[0]));
  if (rl) scr_rl_settle_close(rl);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* validateAbortSignal(signal, 'options.signal'): the aborted flag (0 or
 * 1), or -1 with ERR_INVALID_ARG_TYPE pending for a value that is not an
 * AbortSignal. */
static int scr_rl_signal_aborted(ScrDyn *signal) {
  ScrDyn *aborted = NULL;
  if (signal->kind == SCR_DYN_OBJ) {
    ScrDyn *v = scr_dyn_obj_get(signal, "aborted", 7);
    aborted = v ? scr_dyn_retain(v) : NULL;
  } else if (signal->kind == SCR_DYN_HANDLE) {
    ScrStr *k = scr_str_new("aborted", 7);
    aborted = scr_dyn_handle_key_get(signal, k);
    scr_str_release(k);
  }
  if (!aborted) {
    scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", signal);
    return -1;
  }
  int r = scr_dyn_truthy(aborted) ? 1 : 0;
  scr_dyn_release(aborted);
  return r;
}

/* The `signal` option: an aborted signal closes the interface on the next
 * tick; otherwise a later abort closes it. */
static void scr_rl_watch_signal(ScrRl *rl, ScrDyn *signal, ScrAbortAddFn add) {
  int state = scr_rl_signal_aborted(signal);
  if (state < 0) return;
  bool is_aborted = state == 1;
  if (is_aborted) {
    ScrClosure *job = scr_closure_new((void *)&scr_rl_close_job, 1);
    job->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(job->caps[0], rl->id);
    scr_next_tick(job);
    return;
  }
  ScrClosure *clo = scr_closure_new((void *)&scr_rl_abort_thunk, 1);
  clo->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(clo->caps[0], rl->id);
  ScrDyn *listener = scr_dyn_new_func(clo, &scr_rl_abort_thunk, 0, "()", "onAborted");
  rl->abort_dispose = add(signal, listener);
  scr_dyn_release(listener);
}

/* createInterface: input is a stream (+1, moves; io non-NULL) or NULL for
 * process.stdin; output is a stream (+1, moves), or NULL with out_stdout
 * selecting process.stdout. crlf_delay is Node's option value (0 when
 * absent); prompt is borrowed (NULL: "> "); signal is NULL or a borrowed
 * AbortSignal, `add` its addAbortListener. Answers the interface
 * handle. */
double scr_rl_open(const ScrRlIo *io, void *in, void *out, bool out_stdout, double crlf_delay,
                   ScrStr *prompt, ScrDyn *signal, ScrAbortAddFn add) {
  static SCR_TL bool cleanup_registered = false;
  if (!cleanup_registered) {
    cleanup_registered = true;
    scr_atexit(scr_rl_cleanup_atexit);
  }
  ScrRl *rl = calloc(1, sizeof *rl);
  if (!rl) scr_rl_oom();
  rl->id = scr_rl_next_id++;
  rl->stdin_in = in == NULL;
  rl->io = io;
  rl->in = in;
  rl->out = out;
  rl->out_stdout = out_stdout;
  rl->prompt = prompt ? scr_str_retain(prompt) : scr_str_new("> ", 2);
  /* this.crlfDelay = crlfDelay ? MathMax(kMincrlfDelay, crlfDelay) : kMincrlfDelay */
  rl->crlf_delay = isnan(crlf_delay) || crlf_delay == 0 ? 100 : fmax(100, crlf_delay);
  rl->history_size = 30; /* kHistorySize */
  rl->history_index = -1;
  rl->tab_size = 8;
  rl->escape_timeout = 500; /* ESCAPE_CODE_TIMEOUT */
  rl->next = scr_rls;
  scr_rls = rl;
  if (in == NULL) {
    if (scr_stdin_ended()) {
      rl->dead = true; /* a question writes its prompt; nothing answers */
    } else {
      scr_rl_stdin_open++;
      if (scr_rl_data_cb == NULL) {
        scr_rl_data_cb = scr_closure_new((void *)&scr_rl_data_adapter, 0);
        scr_stdin_on_data(scr_rl_data_cb, &scr_rl_data_adapter, false);
      }
      if (!scr_rl_end_registered) {
        scr_rl_end_registered = true;
        scr_stdin_on_end(scr_closure_new((void *)&scr_rl_end_thunk, 0), false);
      }
    }
  }
  if (signal && scr_dyn_truthy(signal)) scr_rl_watch_signal(rl, signal, add);
  return rl->id;
}

/* ── methods ───────────────────────────────────────────────────────── */

/* question(query, cb): throws ERR_USE_AFTER_CLOSE on a closed interface;
 * while a question is pending only the prompt is written again. */
void scr_rl_question(double id, ScrStr *query, ScrClosure *cb /*moves*/, ScrRlLineFn fn) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_closure_release(cb);
    scr_rl_throw_closed();
    return;
  }
  if (rl->q_cb) {
    scr_closure_release(cb);
    scr_rl_prompt_now(rl);
    return;
  }
  rl->old_prompt = rl->prompt;
  rl->old_prompt_value = rl->prompt_value;
  rl->prompt = scr_str_retain(query);
  rl->prompt_value = NULL;
  rl->q_cb = cb;
  rl->q_fn = fn;
  scr_rl_prompt_now(rl);
}

/* A prompt that is not a string: String(value) for a primitive, which is
 * what the terminal's line refresh and getCursorPos concatenate. An
 * object's valueOf/toString would run on every refresh, and a symbol
 * throws there, so a terminal interface refuses them (false, the refusal
 * pending); another interface only writes the prompt, which throws for
 * any value that is not a string, so it keeps ''. +1. */
static bool scr_rl_prompt_text(ScrRl *rl, ScrDyn *value, ScrStr **out) {
  if (scr_rl_primitive_prompt(value)) {
    *out = scr_dyn_string_coerce(value);
    return true;
  }
  if (!rl->tty) {
    *out = scr_str_new("", 0);
    return true;
  }
  static const char m[] =
      "a terminal readline prompt that is an object or a symbol has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, m, sizeof m - 1, "SC2020");
  return false;
}

/* question(query, cb) with a checked-dynamic query: a string goes through
 * scr_rl_question. Another value becomes the prompt, the callback is
 * kept, and the prompt write throws ERR_INVALID_ARG_TYPE on an interface
 * that is not a terminal (the question stays pending, as in Node). */
void scr_rl_question_dyn(double id, ScrDyn *query, ScrClosure *cb /*moves*/, ScrRlLineFn fn) {
  if (query->kind == SCR_DYN_STR) {
    scr_rl_question(id, query->v.str, cb, fn);
    return;
  }
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed || rl->q_cb) {
    scr_rl_question(id, NULL, cb, fn); /* the closed throw, or the re-prompt */
    return;
  }
  ScrStr *text;
  if (!scr_rl_prompt_text(rl, query, &text)) {
    scr_closure_release(cb);
    return;
  }
  rl->old_prompt = rl->prompt;
  rl->old_prompt_value = rl->prompt_value;
  rl->prompt = text;
  rl->prompt_value = scr_dyn_retain(query);
  rl->q_cb = cb;
  rl->q_fn = fn;
  scr_rl_prompt_now(rl);
}

/* The promise question's state, shared by the answer adapter and the abort
 * listener. The signal listener's disposable rides the answer adapter
 * (caps[1]), not this state: the listener holds the state, so the state
 * must not hold the listener. */
typedef struct {
  size_t rc;
  ScrPromise *p;
  ScrDyn *signal; /* +1 or NULL */
  double id;
  bool settled;
} RlAsk;

static void *scr_rl_ask_retain_v(void *a) {
  ((RlAsk *)a)->rc++;
  return a;
}

static void scr_rl_ask_release_v(void *v) {
  RlAsk *a = v;
  if (--a->rc > 0) return;
  scr_promise_release(a->p);
  if (a->signal) scr_dyn_release(a->signal);
  free(a);
}

static void *scr_rl_dyn_retain_v(void *p) { return p ? scr_dyn_retain(p) : NULL; }
static void scr_rl_dyn_release_v(void *p) { scr_dyn_release(p); }

/* Calls and drops a disposable (+1). */
static void scr_rl_dispose(ScrDyn *d) {
  if (!d) return;
  ScrDyn *r = scr_dyn_call(d, NULL, 0, "dispose");
  if (r) scr_dyn_release(r);
  scr_dyn_release(d);
}

/* caps[0] the question state; caps[1] the signal listener's disposable
 * (a dyn value, or an empty box). */
static void scr_rl_ask_answer(ScrClosure *cb, ScrStr *answer) {
  RlAsk *a = scr_box_get_ref(cb->caps[0]); /* +1 */
  scr_rl_dispose(scr_box_get_ref(cb->caps[1]));
  scr_box_set_ref(cb->caps[1], NULL);
  if (!a->settled) {
    a->settled = true;
    scr_promise_fulfill_str(a->p, answer);
  } else {
    scr_str_release(answer);
  }
  scr_rl_ask_release_v(a);
}

/* new AbortError(undefined, { cause: signal.reason }) */
static ScrError *scr_rl_abort_error(ScrDyn *signal) {
  ScrStr *message = scr_str_new("The operation was aborted", 25);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_str_release(e->name);
  e->name = scr_str_new("AbortError", 10);
  /* AbortError assigns code, then name: own enumerable properties */
  scr_error_set_code(e, "ABORT_ERR");
  e->name_present = true;
  e->name_enumerable = true;
  ScrStr *k = scr_str_new("reason", 6);
  ScrDyn *reason = scr_dyn_handle_key_get(signal, k);
  scr_str_release(k);
  scr_error_define_cause(e, reason ? reason : scr_dyn_undefined());
  if (reason) scr_dyn_release(reason);
  return e;
}

static void scr_rl_ask_reject(RlAsk *a, ScrError *e /*moves*/) {
  a->settled = true;
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
  scr_promise_reject_pending(a->p);
}

/* kQuestionReject(new AbortError(message)): the terminal's Ctrl+C and
 * Ctrl+D on the last promise question. */
void scr_rl_reject_question(ScrRl *rl, const char *message) {
  RlAsk *a = rl->q_ask;
  if (!a || a->settled) return;
  ScrStr *m = scr_str_new(message, strlen(message));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, m);
  scr_str_release(m);
  /* new AbortError(message): code, then name, as own properties */
  scr_str_release(e->name);
  e->name = scr_str_new("AbortError", 10);
  scr_error_set_code(e, "ABORT_ERR");
  e->name_present = true;
  e->name_enumerable = true;
  scr_rl_ask_reject(a, e);
}

/* onAbort: kQuestionCancel (drops whichever question is pending, writing
 * clearLine's "\r\n"), then the rejection. */
static ScrDyn *scr_rl_ask_abort_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  RlAsk *a = scr_box_get_ref(clo->caps[0]); /* +1 */
  ScrRl *rl = scr_rl_find(a->id);
  if (rl && rl->q_cb) {
    scr_closure_release(rl->q_cb);
    rl->q_cb = NULL;
    scr_rl_restore_prompt(rl);
    if (rl->tty) {
      scr_rl_tty_ops->clear_line(rl);
    } else {
      ScrStr *crlf = scr_str_new("\r\n", 2);
      scr_rl_write_out(rl, crlf);
      scr_str_release(crlf);
    }
  }
  if (!a->settled) scr_rl_ask_reject(a, scr_rl_abort_error(a->signal));
  scr_rl_ask_release_v(a);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* readline/promises question(query, { signal }): rejects with
 * ERR_USE_AFTER_CLOSE on a closed interface and with an AbortError when
 * the signal is (or becomes) aborted. A checked-dynamic query (query_dyn,
 * query NULL) that is not a string rejects with what question() throws,
 * as Node's promise executor does. */
static ScrPromise *scr_rl_ask(double id, ScrStr *query, ScrDyn *query_dyn, ScrDyn *signal,
                              ScrAbortAddFn add) {
  RlAsk *a = calloc(1, sizeof *a);
  if (!a) scr_rl_oom();
  a->rc = 1;
  a->p = scr_promise_new();
  a->id = id;
  ScrDyn *dispose = NULL;
  ScrPromise *result = scr_promise_retain(a->p);
  if (signal && scr_dyn_truthy(signal)) {
    int state = scr_rl_signal_aborted(signal);
    if (state < 0) {
      a->settled = true;
      scr_promise_reject_pending(a->p);
      scr_rl_ask_release_v(a);
      return result;
    }
    bool is_aborted = state == 1;
    a->signal = scr_dyn_retain(signal);
    if (is_aborted) {
      scr_rl_ask_reject(a, scr_rl_abort_error(signal));
      scr_rl_ask_release_v(a);
      return result;
    }
    ScrClosure *clo = scr_closure_new((void *)&scr_rl_ask_abort_thunk, 1);
    clo->caps[0] = scr_box_new_obj(&scr_rl_ask_retain_v, &scr_rl_ask_release_v, NULL);
    scr_box_set_ref(clo->caps[0], scr_rl_ask_retain_v(a));
    ScrDyn *listener = scr_dyn_new_func(clo, &scr_rl_ask_abort_thunk, 0, "()", "onAbort");
    dispose = add(signal, listener);
    scr_dyn_release(listener);
  }
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_rl_dispose(dispose);
    static const char m[] = "readline was closed";
    ScrStr *message = scr_str_new(m, sizeof m - 1);
    ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
    scr_str_release(message);
    scr_error_set_code(e, "ERR_USE_AFTER_CLOSE");
    scr_rl_ask_reject(a, e);
    scr_rl_ask_release_v(a);
    return result;
  }
  /* this[kQuestionReject] = reject */
  if (rl->q_ask) scr_rl_ask_release_v(rl->q_ask);
  rl->q_ask = scr_rl_ask_retain_v(a);
  ScrClosure *cb = scr_closure_new((void *)&scr_rl_ask_answer, 2);
  cb->caps[0] = scr_box_new_obj(&scr_rl_ask_retain_v, &scr_rl_ask_release_v, NULL);
  scr_box_set_ref(cb->caps[0], a); /* the creation reference moves here */
  cb->caps[1] = scr_box_new_obj(&scr_rl_dyn_retain_v, &scr_rl_dyn_release_v, NULL);
  scr_box_set_ref(cb->caps[1], dispose); /* moves (NULL without a signal) */
  if (!query_dyn) {
    scr_rl_question(id, query, cb, &scr_rl_ask_answer);
    return result;
  }
  scr_rl_ask_retain_v(a);
  scr_rl_question_dyn(id, query_dyn, cb, &scr_rl_ask_answer);
  if (scr_exc_pending() && !a->settled) {
    a->settled = true;
    scr_promise_reject_pending(a->p);
  }
  scr_rl_ask_release_v(a);
  return result;
}

ScrPromise *scr_rl_question_promise(double id, ScrStr *query, ScrDyn *signal, ScrAbortAddFn add) {
  return scr_rl_ask(id, query, NULL, signal, add);
}

ScrPromise *scr_rl_question_promise_dyn(double id, ScrDyn *query, ScrDyn *signal,
                                        ScrAbortAddFn add) {
  return scr_rl_ask(id, NULL, query, signal, add);
}

void scr_rl_close(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (rl) scr_rl_settle_close(rl); /* twice is a no-op, like Node */
}

void scr_rl_pause(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_rl_throw_closed();
    return;
  }
  scr_rl_do_pause(rl);
}

void scr_rl_resume(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_rl_throw_closed();
    return;
  }
  scr_rl_do_resume(rl);
}

void scr_rl_prompt(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_rl_throw_closed();
    return;
  }
  scr_rl_prompt_now(rl);
}

/* prompt(preserveCursor): a terminal interface keeps its cursor */
void scr_rl_prompt_with(double id, bool preserve) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_rl_throw_closed();
    return;
  }
  if (!rl->tty || !preserve) {
    scr_rl_prompt_now(rl);
    return;
  }
  if (rl->paused) scr_rl_do_resume(rl);
  if (scr_exc_pending()) return;
  scr_rl_tty_ops->prompt(rl, true);
}

void scr_rl_set_prompt(double id, ScrStr *prompt) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl) return;
  scr_str_release(rl->prompt);
  rl->prompt = scr_str_retain(prompt);
  if (rl->prompt_value) scr_dyn_release(rl->prompt_value);
  rl->prompt_value = NULL;
}

/* setPrompt(value) with a checked-dynamic value; borrows. */
void scr_rl_set_prompt_dyn(double id, ScrDyn *prompt) {
  if (prompt->kind == SCR_DYN_STR) {
    scr_rl_set_prompt(id, prompt->v.str);
    return;
  }
  ScrRl *rl = scr_rl_find(id);
  if (!rl) return;
  ScrStr *text;
  if (!scr_rl_prompt_text(rl, prompt, &text)) return;
  scr_str_release(rl->prompt);
  rl->prompt = text;
  if (rl->prompt_value) scr_dyn_release(rl->prompt_value);
  rl->prompt_value = scr_dyn_retain(prompt);
}

ScrStr *scr_rl_get_prompt(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (rl && rl->prompt_value) {
    static const char m[] = "rl.getPrompt() of a prompt that is not a string has no lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, m, sizeof m - 1, "SC2020");
    return scr_str_new("", 0);
  }
  return rl ? scr_str_retain(rl->prompt) : scr_str_new("", 0);
}

/* Called after a node:readline/promises interface opens: its Interface
 * class is not node:readline's, which instanceof tells apart. */
void scr_rl_mark_promises(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (rl) rl->promises = true;
}

bool scr_rl_is_promises(double id) {
  ScrRl *rl = scr_rl_find(id);
  return rl && rl->promises;
}

bool scr_rl_is_terminal(double id) {
  ScrRl *rl = scr_rl_find(id);
  return rl && rl->tty;
}

/* rl.line: '' on a non-terminal interface */
ScrStr *scr_rl_line(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || !rl->tty) return scr_str_new("", 0);
  return scr_rl_tty_ops->line(rl);
}

/* rl.cursor: a non-terminal interface has none (undefined) */
double scr_rl_cursor(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (rl && rl->tty) return scr_rl_tty_ops->cursor(rl);
  static const char m[] = "rl.cursor of an interface that is not a terminal has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, m, sizeof m - 1, "SC2020");
  return 0;
}

/* write(data, key): a non-terminal interface writes data alone
 * (kNormalWrite ignores undefined) */
void scr_rl_write_key(double id, bool has_data, ScrStr *data, bool has_key, bool has_name,
                      ScrStr *name, bool ctrl, bool meta, bool shift) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_rl_throw_closed();
    return;
  }
  if (rl->paused) scr_rl_do_resume(rl);
  if (scr_exc_pending()) return;
  if (rl->tty) {
    scr_rl_tty_ops->write_key(rl, has_data ? data : NULL, has_key, has_name ? name : NULL, ctrl,
                              meta, shift);
  } else if (has_data) {
    scr_rl_feed_text(rl, data->data, data->len);
  }
}

/* write(data): the text runs through the line splitter as if it were
 * input. */
void scr_rl_write(double id, ScrStr *data) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_rl_throw_closed();
    return;
  }
  if (rl->paused) scr_rl_do_resume(rl);
  if (scr_exc_pending()) return;
  if (rl->tty) scr_rl_tty_ops->write(rl, data); /* kTtyWrite(d) */
  else scr_rl_feed_text(rl, data->data, data->len);
}

/* on/once for 'line' (fn: the line adapter), 'close', 'pause', 'resume'
 * (fn NULL), and 'error' (fn: the error adapter). Listeners added after
 * 'close' was emitted never run. */
void scr_rl_on(double id, double ev, ScrClosure *cb /*moves*/, void *fn, bool once) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || ev < 0 || ev >= RL_EV_COUNT) {
    scr_closure_release(cb);
    return;
  }
  scr_rl_add(rl, (int)ev, cb, fn, once, false);
}

/* ── the history and editing options ───────────────────────────────── */

static SCR_COLD void scr_rl_out_of_range(const char *name, const char *range, double v) {
  char got[48];
  size_t n = scr_num_received(v, got);
  char m[200];
  int len = snprintf(m, sizeof m, "The value of \"%s\" is out of range. It must be %s. Received %.*s",
                     name, range, (int)n, got);
  scr_throw_error_msg_code(SCR_ERR_RANGE, m, (size_t)len, "ERR_OUT_OF_RANGE");
}

void scr_rl_check_options(double flags, double tab_size, double escape_timeout, double size) {
  int f = (int)flags;
  if (f & 1) { /* validateUint32(input.tabSize, 'tabSize', true) */
    if (tab_size != floor(tab_size) || isnan(tab_size)) {
      scr_rl_out_of_range("tabSize", "an integer", tab_size);
      return;
    }
    if (tab_size < 1 || tab_size > 4294967295.0) {
      scr_rl_out_of_range("tabSize", ">= 1 && <= 4294967295", tab_size);
      return;
    }
  }
  if ((f & 2) && !isfinite(escape_timeout)) {
    /* ERR_INVALID_ARG_VALUE('input.escapeCodeTimeout', this.escapeCodeTimeout) */
    static const char m[] = "The property 'input.escapeCodeTimeout' is invalid. Received 500";
    scr_throw_error_msg_code(SCR_ERR_TYPE, m, sizeof m - 1, "ERR_INVALID_ARG_VALUE");
    return;
  }
  if ((f & 4) && (isnan(size) || size < 0)) { /* validateNumber(options.size, 'size', 0) */
    scr_rl_out_of_range("size", ">= 0", size);
  }
}

void scr_rl_check_completer(ScrDyn *completer) {
  /* completer !== undefined && typeof completer !== 'function' */
  if (completer->kind == SCR_DYN_UNDEF || scr_dyn_is_callable(completer)) return;
  scr_dyn_arg_value_fail("completer", NULL, completer);
}

void scr_rl_set_options(double id, double flags, double size, bool remove_dups, double tab_size,
                        double escape_timeout) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl) return;
  int f = (int)flags;
  if (f & 1) rl->tab_size = tab_size;
  if (f & 2) rl->escape_timeout = escape_timeout;
  if (f & 4) rl->history_size = size;
  rl->remove_dups = remove_dups;
}

void scr_rl_set_history(double id, ScrArr *history) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl) return;
  if (rl->history) scr_arr_release(rl->history);
  rl->history = scr_arr_retain(history);
}

ScrArr *scr_rl_history(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl) return scr_arr_new(SCR_ELEM_STR, 0);
  if (!rl->history) rl->history = scr_arr_new(SCR_ELEM_STR, 0);
  return scr_arr_retain(rl->history);
}

double scr_rl_num_prop(double id, double which) {
  ScrRl *rl = scr_rl_find(id);
  switch ((int)which) {
  case 0: return rl ? rl->history_size : 30;
  case 1: return rl ? rl->history_index : -1;
  case 2: return rl ? rl->crlf_delay : 100;
  case 3: return rl ? rl->tab_size : 8;
  default: return rl ? rl->escape_timeout : 500;
  }
}

/* ── the cursor helpers (internal/readline/callbacks.js) ───────────── */

/* CSI`${v}` + final: v as JS ToString renders it */
static void scr_rl_csi_num(ScrJsonBuf *b, double v, char final) {
  scr_jb_puts(b, "\x1b[");
  scr_jb_put_number(b, v);
  scr_jb_putc(b, final);
}

static SCR_COLD void scr_rl_nan_arg(const char *name) {
  /* ERR_INVALID_ARG_VALUE(name, NaN) */
  ScrDyn *nan = scr_dyn_new_num(NAN);
  scr_dyn_arg_value_fail(name, NULL, nan);
  scr_dyn_release(nan);
}

/* The data a helper writes (+1), after its argument checks (may throw):
 * kind 0 cursorTo(x, y?), 1 moveCursor(dx, dy) ('' when !(dx || dy)),
 * 2 clearLine(dir), 3 clearScreenDown(), 4 cursorTo(stream, undefined, y)
 * (always throws). */
ScrStr *scr_rl_seq(double kind, double a, double b, bool has_b) {
  ScrJsonBuf out;
  scr_jb_init(&out);
  switch ((int)kind) {
  case 0:
    if (isnan(a)) {
      scr_rl_nan_arg("x");
      break;
    }
    if (has_b && isnan(b)) {
      scr_rl_nan_arg("y");
      break;
    }
    if (!has_b) {
      scr_rl_csi_num(&out, a + 1, 'G');
    } else {
      /* CSI`${y + 1};${x + 1}H` */
      scr_jb_puts(&out, "\x1b[");
      scr_jb_put_number(&out, b + 1);
      scr_jb_putc(&out, ';');
      scr_jb_put_number(&out, a + 1);
      scr_jb_putc(&out, 'H');
    }
    break;
  case 1:
    if (a < 0) scr_rl_csi_num(&out, -a, 'D');
    else if (a > 0) scr_rl_csi_num(&out, a, 'C');
    if (b < 0) scr_rl_csi_num(&out, -b, 'A');
    else if (b > 0) scr_rl_csi_num(&out, b, 'B');
    break;
  case 2:
    scr_jb_puts(&out, a < 0 ? "\x1b[1K" : a > 0 ? "\x1b[0K" : "\x1b[2K");
    break;
  case 4: {
    /* cursorTo(stream, undefined, y) */
    if (isnan(b)) {
      scr_rl_nan_arg("y");
      break;
    }
    static const char m[] = "Cannot set cursor row without setting its column";
    scr_throw_error_msg_code(SCR_ERR_TYPE, m, sizeof m - 1, "ERR_INVALID_CURSOR_POS");
    break;
  }
  default:
    scr_jb_puts(&out, "\x1b[0J");
    break;
  }
  return scr_jb_finish(&out);
}

/* moveCursor writes unless !(dx || dy) */
bool scr_rl_moves(double dx, double dy) { return (dx != 0 && !isnan(dx)) || (dy != 0 && !isnan(dy)); }

/* ── readline/promises Readline (internal/readline/promises.js) ────── */

/* A Readline over process.stdout/stderr (fd) or a writable stream (io).
 * Actions queue until commit(), or are written on the next tick with
 * autoCommit. */
typedef struct ScrRlUi {
  double id;
  int fd;     /* 1 or 2; 0 for a stream */
  void *out;  /* the stream (+1), or NULL */
  const ScrRlIo *io;
  bool auto_commit;
  char *todo; /* the pending actions (#todo joined) */
  size_t todo_len, todo_cap;
  struct ScrRlUi *next;
} ScrRlUi;

static SCR_TL ScrRlUi *scr_rl_uis = NULL;
static SCR_TL double scr_rl_ui_next_id = 1;

static void scr_rl_ui_cleanup(void) {
  while (scr_rl_uis) {
    ScrRlUi *u = scr_rl_uis;
    scr_rl_uis = u->next;
    if (u->out) u->io->release(u->out);
    free(u->todo);
    free(u);
  }
}

double scr_rl_ui_open(const ScrRlIo *io, void *out /*moves*/, double fd, bool auto_commit) {
  static SCR_TL bool registered = false;
  if (!registered) {
    registered = true;
    scr_atexit(scr_rl_ui_cleanup);
  }
  ScrRlUi *u = calloc(1, sizeof *u);
  if (!u) scr_trap("scriptc: out of memory\n");
  u->id = scr_rl_ui_next_id++;
  u->fd = (int)fd;
  u->out = out;
  u->io = io;
  u->auto_commit = auto_commit;
  u->next = scr_rl_uis;
  scr_rl_uis = u;
  return u->id;
}

double scr_rl_ui_open_fd(double fd, bool auto_commit) {
  return scr_rl_ui_open(NULL, NULL, fd, auto_commit);
}

static ScrRlUi *scr_rl_ui_find(double id) {
  for (ScrRlUi *u = scr_rl_uis; u; u = u->next) {
    if (u->id == id) return u;
  }
  return NULL;
}

/* stream.write(text, cb): cb (moves, or NULL) runs once the write is done;
 * process.stdout/stderr complete on the next tick */
static void scr_rl_ui_write(ScrRlUi *u, ScrStr *text, ScrClosure *cb) {
  if (u->fd) {
    scr_stdio_write_str(u->fd, text);
    if (cb) scr_next_tick(cb);
  } else {
    u->io->write_cb(u->out, text, cb);
  }
}

static void scr_rl_ui_tick_write(ScrClosure *job) {
  ScrRlUi *u = scr_rl_ui_find(scr_box_get_f64(job->caps[0]));
  ScrStr *text = scr_box_get_ref(job->caps[1]);
  if (u) scr_rl_ui_write(u, text, NULL);
  scr_str_release(text);
}

/* autoCommit: process.nextTick(() => stream.write(data)); else
 * #todo.push(data). Moves data. */
static void scr_rl_ui_push(ScrRlUi *u, ScrStr *data) {
  if (u->auto_commit) {
    ScrClosure *job = scr_closure_new((void *)&scr_rl_ui_tick_write, 2);
    job->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(job->caps[0], u->id);
    job->caps[1] = scr_box_new(SCR_BOX_STR);
    scr_box_set_ref(job->caps[1], data);
    scr_next_tick(job);
    return;
  }
  u->todo = scr_rl_grow(u->todo, &u->todo_cap, u->todo_len + data->len, 1);
  memcpy(u->todo + u->todo_len, data->data, data->len);
  u->todo_len += data->len;
  scr_str_release(data);
}

/* validateInteger(value, name, min, max) for a number */
static bool scr_rl_check_int(const char *name, double v, double min, double max) {
  if (v != trunc(v) || isnan(v)) {
    scr_rl_out_of_range(name, "an integer", v);
    return false;
  }
  if (v < min || v > max) {
    char range[96];
    char lo[40], hi[40];
    lo[scr_f64_to_str(min, lo)] = '\0';
    hi[scr_f64_to_str(max, hi)] = '\0';
    snprintf(range, sizeof range, ">= %s && <= %s", lo, hi);
    scr_rl_out_of_range(name, range, v);
    return false;
  }
  return true;
}

#define SCR_RL_SAFE 9007199254740991.0

void scr_rl_ui_cursor_to(double id, double x, bool has_y, double y) {
  ScrRlUi *u = scr_rl_ui_find(id);
  if (!scr_rl_check_int("x", x, -SCR_RL_SAFE, SCR_RL_SAFE)) return;
  if (has_y && !scr_rl_check_int("y", y, -SCR_RL_SAFE, SCR_RL_SAFE)) return;
  if (u) scr_rl_ui_push(u, scr_rl_seq(0, x, y, has_y));
}

void scr_rl_ui_move_cursor(double id, double dx, double dy) {
  ScrRlUi *u = scr_rl_ui_find(id);
  if (!scr_rl_moves(dx, dy)) return;
  if (!scr_rl_check_int("dx", dx, -SCR_RL_SAFE, SCR_RL_SAFE)) return;
  if (!scr_rl_check_int("dy", dy, -SCR_RL_SAFE, SCR_RL_SAFE)) return;
  if (u) scr_rl_ui_push(u, scr_rl_seq(1, dx, dy, true));
}

void scr_rl_ui_clear_line(double id, double dir) {
  ScrRlUi *u = scr_rl_ui_find(id);
  if (!scr_rl_check_int("dir", dir, -1, 1)) return;
  if (u) scr_rl_ui_push(u, scr_rl_seq(2, dir, 0, false));
}

void scr_rl_ui_clear_screen_down(double id) {
  ScrRlUi *u = scr_rl_ui_find(id);
  if (u) scr_rl_ui_push(u, scr_rl_seq(3, 0, 0, false));
}

void scr_rl_ui_rollback(double id) {
  ScrRlUi *u = scr_rl_ui_find(id);
  if (u) u->todo_len = 0;
}

static void scr_rl_ui_resolve(ScrClosure *cb) {
  ScrPromise *p = scr_box_get_ref(cb->caps[0]);
  scr_promise_fulfill_void(p);
  scr_promise_release(p);
}

/* commit(): writes the pending actions now; the promise resolves when
 * the write completes (+1) */
ScrPromise *scr_rl_ui_commit(double id) {
  ScrPromise *p = scr_promise_new();
  ScrRlUi *u = scr_rl_ui_find(id);
  if (!u) {
    scr_promise_fulfill_void(p);
    return p;
  }
  ScrStr *text = scr_str_new(u->todo ? u->todo : "", u->todo_len);
  u->todo_len = 0;
  ScrClosure *cb = scr_closure_new((void *)&scr_rl_ui_resolve, 1);
  cb->caps[0] = scr_box_new_obj(&scr_promise_retain_v, &scr_promise_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_promise_retain(p));
  scr_rl_ui_write(u, text, cb);
  scr_str_release(text);
  return p;
}

/* ── the runtime-provided adapters ─────────────────────────────────── */

/* A (history: string[]) listener: the callee owns its argument, and the
 * interface keeps the array. */
void scr_rl_history_thunk_arr(ScrClosure *cb, ScrArr *history) {
  ((void (*)(ScrClosure *, ScrArr *))cb->fn)(cb, scr_arr_retain(history));
}

/* A checked-dynamic (history) listener: it gets a dyn copy of the
 * history, and its changes to the copy are written back to the
 * interface's array when it returns. */
void scr_rl_history_thunk_dyn(ScrClosure *cb, ScrArr *history) {
  ScrDyn *copy = scr_dyn_new_arr();
  double n = scr_arr_len(history);
  for (double i = 0; i < n; i++) {
    ScrStr *s = scr_arr_peek_ref(history, i);
    scr_dyn_arr_push(copy, s ? scr_dyn_new_str(s) : scr_dyn_retain(scr_dyn_undefined()));
  }
  ((void (*)(ScrClosure *, ScrDyn *))cb->fn)(cb, scr_dyn_retain(copy));
  if (!scr_exc_pending()) {
    double m = scr_dyn_arr_len(copy);
    scr_arr_set_len(history, 0);
    for (double i = 0; i < m; i++) {
      ScrDyn *e = scr_dyn_arr_at(copy, i);
      ScrStr *s = e->kind == SCR_DYN_STR ? scr_str_retain(e->v.str) : scr_dyn_string_coerce(e);
      scr_arr_push_ref(history, s);
      scr_dyn_release(e);
    }
  }
  scr_dyn_release(copy);
}

/* A zero-param line/answer callback: the text is ignored. */
void scr_rl_answer_thunk0(ScrClosure *cb, ScrStr *answer) {
  scr_str_release(answer);
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* An (answer: string) callback — owns the +1 answer per the universal
 * convention. */
void scr_rl_answer_thunk_str(ScrClosure *cb, ScrStr *answer) {
  ((void (*)(ScrClosure *, ScrStr *))cb->fn)(cb, answer);
}

/* An (err: Error) listener. */
void scr_rl_error_thunk(ScrClosure *cb, ScrError *err) {
  ((void (*)(ScrClosure *, ScrError *))cb->fn)(cb, scr_error_retain(err));
}

/* JavaScript listeners take checked-dynamic values (the adapter owns
 * the +1 dyn parameter it passes). */
void scr_rl_answer_thunk_dyn(ScrClosure *cb, ScrStr *answer) {
  ScrDyn *d = scr_dyn_new_str(answer);
  scr_str_release(answer);
  ((void (*)(ScrClosure *, ScrDyn *))cb->fn)(cb, d);
}

void scr_rl_error_thunk_dyn(ScrClosure *cb, ScrError *err) {
  ScrDyn *d = scr_dyn_from_error(err);
  ((void (*)(ScrClosure *, ScrDyn *))cb->fn)(cb, d);
}

void scr_rl_error_thunk0(ScrClosure *cb, ScrError *err) {
  (void)err;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}
