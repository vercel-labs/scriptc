/* scriptc runtime — the readline Interface shared by scr_readline.c and
 * its terminal half, scr_readline_tty.c. Not included by scr_runtime.h. */
#ifndef SCR_READLINE_INTERNAL_H
#define SCR_READLINE_INTERNAL_H

#include "scr_runtime.h"

/* Listener events. 'history' fires only on terminal interfaces;
 * 'SIGINT', 'SIGTSTP' and 'SIGCONT' are the terminal's control keys. */
enum {
  RL_EV_LINE,
  RL_EV_CLOSE,
  RL_EV_PAUSE,
  RL_EV_RESUME,
  RL_EV_ERROR,
  RL_EV_HISTORY,
  RL_EV_SIGINT,
  RL_EV_SIGTSTP,
  RL_EV_SIGCONT,
  RL_EV_COUNT
};

typedef void (*ScrRlLineFn)(ScrClosure *, ScrStr *); /* owns the +1 line */
typedef void (*ScrRlErrFn)(ScrClosure *, ScrError *); /* borrows the error */
typedef void (*ScrRlHistoryFn)(ScrClosure *, ScrArr *); /* borrows the history */

/* One listener: a user closure (fn: the line, error or history adapter;
 * NULL for the zero-argument events), or the async iterator's own
 * handler. */
typedef struct {
  ScrClosure *cb;
  void *fn;
  bool once;
  bool iter;
} RlEntry;

typedef struct {
  RlEntry *v;
  size_t n, cap;
} RlList;

typedef struct {
  ScrStr **q; /* queued lines (owned) */
  size_t head, len, cap;
  ScrPromise **waiters; /* pending next() promises (owned) */
  size_t wn, wcap;
  ScrError *error; /* an 'error' no next() has seen yet (owned) */
  bool finished, paused;
} RlIter;

struct ScrRlTty;

typedef struct ScrRl {
  double id;
  bool closed;
  bool stdin_in; /* reads process.stdin through the shared consumer */
  bool dead;     /* stdin only: created after stdin ended */
  bool paused;
  bool promises; /* created by node:readline/promises */
  const ScrRlIo *io; /* the stream side, for a stream input or output */
  void *in;  /* the input stream (+1), or NULL */
  void *out; /* the output stream (+1), or NULL */
  bool out_stdout;
  ScrStr *prompt, *old_prompt;
  /* A prompt that is not a string (setPrompt or question with another
   * value), +1, or NULL; prompt then holds String(value) for a terminal
   * interface. Writing it the way Node's kWriteToOutput does throws
   * ERR_INVALID_ARG_TYPE. old_prompt_value is old_prompt's. */
  ScrDyn *prompt_value, *old_prompt_value;
  ScrClosure *q_cb; /* the pending question's callback (owned) */
  ScrRlLineFn q_fn;
  /* the last promise question (kQuestionReject), which the terminal's
   * Ctrl+C and Ctrl+D reject with an AbortError (+1, or NULL) */
  void *q_ask;
  RlList ev[RL_EV_COUNT];
  /* the line splitter */
  char *line_buf; /* the unfinished line (kLine_buffer), UTF-8 */
  size_t line_len, line_cap;
  unsigned char held[4]; /* the decoder's incomplete trailing sequence */
  size_t n_held;
  double saw_return_at, crlf_delay;
  /* stdin bytes that arrived while paused */
  char *parked;
  size_t parked_len, parked_cap;
  RlIter *iter;
  ScrDyn *abort_dispose; /* the signal option's listener disposable (+1) */
  /* The history and editing options. A non-terminal interface keeps
   * them as given and never records history. */
  ScrArr *history; /* the history option (+1), or NULL until first read */
  double history_size, tab_size, escape_timeout;
  bool remove_dups;
  double history_index; /* -1 until a terminal recalls an entry */
  /* terminal mode (scr_readline_tty.c), or NULL */
  struct ScrRlTty *tty;
  struct ScrRl *next;
} ScrRl;

/* The terminal half's entry points, installed by scr_rl_terminal. */
typedef struct {
  void (*feed)(ScrRl *rl, const char *text, size_t n); /* decoded input text */
  void (*end)(ScrRl *rl);                              /* the input's 'end' */
  void (*prompt)(ScrRl *rl, bool preserve_cursor);
  void (*write)(ScrRl *rl, ScrStr *data); /* rl.write(data); borrows */
  void (*closing)(ScrRl *rl);             /* close(): raw mode off */
  void (*clear_line)(ScrRl *rl);          /* kQuestionCancel's clearLine() */
  void (*free)(ScrRl *rl);
  ScrStr *(*line)(ScrRl *rl); /* rl.line (+1) */
  double (*cursor)(ScrRl *rl);
  /* write(data, key): data NULL for undefined or null, name NULL for a
   * key without one; both borrowed */
  void (*write_key)(ScrRl *rl, ScrStr *data, bool has_key, ScrStr *name, bool ctrl, bool meta,
                    bool shift);
  void (*resumed)(ScrRl *rl); /* resume(): process.stdin keys parked meanwhile flow */
} ScrRlTtyOps;
extern SCR_TL const ScrRlTtyOps *scr_rl_tty_ops;

ScrRl *scr_rl_find(double id);
ScrArr *scr_rl_history_of(ScrRl *rl); /* borrowed; created on first use */
/* emit(ev, ...): line borrowed, err borrowed. */
void scr_rl_emit(ScrRl *rl, int ev, ScrStr *line, ScrError *err);
void scr_rl_emit_history(ScrRl *rl);
void scr_rl_write_out(ScrRl *rl, ScrStr *text);
/* kWriteToOutput(prompt)'s validateString: false with ERR_INVALID_ARG_TYPE
 * pending when the prompt is not a string. */
bool scr_rl_prompt_writable(ScrRl *rl);
/* A prompt value whose String() the interface keeps in prompt. */
static inline bool scr_rl_primitive_prompt(const ScrDyn *v) {
  return v->kind == SCR_DYN_NULL || v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_BOOL ||
         v->kind == SCR_DYN_NUM || v->kind == SCR_DYN_BIGINT;
}
/* kOnLine: a pending question takes the line, else 'line'. Moves line. */
void scr_rl_on_line(ScrRl *rl, ScrStr *line);
void scr_rl_do_pause(ScrRl *rl);
void scr_rl_do_resume(ScrRl *rl);
void scr_rl_settle_close(ScrRl *rl);
/* kQuestionReject(new AbortError(message)) on the last promise question;
 * a settled question ignores it. */
void scr_rl_reject_question(ScrRl *rl, const char *message);
/* The length of an incomplete UTF-8 sequence ending p[0..n) (StringDecoder's
 * held bytes). */
size_t scr_rl_incomplete_tail(const unsigned char *p, size_t n);

#endif /* SCR_READLINE_INTERNAL_H */
