/* node:readline's terminal mode (lib/internal/readline/interface.js
 * kTtyWrite and its helpers, internal/readline/utils.js emitKeys,
 * internal/readline/emitKeypressEvents.js and internal/repl/history.js),
 * linked only by programs whose interfaces can be terminal ones or that
 * use emitKeypressEvents or getCursorPos.
 *
 * Behavior, matching Node v24.22.0:
 * - Input runs through emitKeypressEvents' decoder, one per stream and
 *   shared with the stream's 'keypress' listeners, one code point at a
 *   time; an escape at the end of a chunk is resolved after
 *   escapeCodeTimeout ms. Each key goes through kTtyWrite: line editing,
 *   word and line deletion with the kill ring and yank, undo and redo,
 *   history recall with prefix search, Tab completion, and Ctrl+C / D / Z.
 * - The line and the cursor count UTF-16 units, as JS strings do.
 * - Output goes to the interface's output as Node writes it: each
 *   cursorTo / moveCursor / clearScreenDown and each text is its own
 *   write. Columns are the TTY's for a TTY stdout and Infinity otherwise.
 * - Lines enter the history (historySize, removeHistoryDuplicates) and
 *   'history' fires with the history array. */
#include "scr_readline_internal.h"
#include "scr_readline_width_data.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if !defined(_WIN32) && !defined(__wasi__)
#include <signal.h>
#include <unistd.h>
#endif

static void tty_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

/* ── UTF-16 strings ────────────────────────────────────────────────── */

typedef struct {
  uint16_t *u;
  size_t n, cap;
} U16;

static void u16_reserve(U16 *s, size_t need) {
  if (need <= s->cap) return;
  size_t c = s->cap ? s->cap * 2 : 16;
  while (c < need) c *= 2;
  uint16_t *q = realloc(s->u, c * sizeof *q);
  if (!q) tty_oom();
  s->u = q;
  s->cap = c;
}

static void u16_set(U16 *d, const uint16_t *p, size_t n) {
  u16_reserve(d, n);
  if (n) memmove(d->u, p, n * sizeof *p);
  d->n = n;
}

static void u16_append(U16 *d, const uint16_t *p, size_t n) {
  u16_reserve(d, d->n + n);
  if (n) memcpy(d->u + d->n, p, n * sizeof *p);
  d->n += n;
}

static void u16_push(U16 *d, uint16_t c) { u16_append(d, &c, 1); }

static void u16_free(U16 *s) {
  free(s->u);
  s->u = NULL;
  s->n = s->cap = 0;
}

static void u16_push_cp(U16 *d, uint32_t cp) {
  if (cp >= 0x10000) {
    cp -= 0x10000;
    u16_push(d, (uint16_t)(0xd800 + (cp >> 10)));
    u16_push(d, (uint16_t)(0xdc00 + (cp & 0x3ff)));
  } else {
    u16_push(d, (uint16_t)cp);
  }
}

/* WTF-8 text (lone surrogates as 3-byte sequences) into UTF-16 units;
 * invalid bytes become U+FFFD. */
static void u16_from_utf8(U16 *d, const char *text, size_t n) {
  const unsigned char *p = (const unsigned char *)text;
  size_t i = 0;
  while (i < n) {
    unsigned char c = p[i];
    uint32_t cp;
    size_t len;
    if (c < 0x80) {
      cp = c;
      len = 1;
    } else if ((c & 0xe0) == 0xc0 && i + 1 < n) {
      cp = ((uint32_t)(c & 0x1f) << 6) | (p[i + 1] & 0x3f);
      len = 2;
    } else if ((c & 0xf0) == 0xe0 && i + 2 < n) {
      cp = ((uint32_t)(c & 0x0f) << 12) | ((uint32_t)(p[i + 1] & 0x3f) << 6) | (p[i + 2] & 0x3f);
      len = 3;
    } else if ((c & 0xf8) == 0xf0 && i + 3 < n) {
      cp = ((uint32_t)(c & 0x07) << 18) | ((uint32_t)(p[i + 1] & 0x3f) << 12) |
           ((uint32_t)(p[i + 2] & 0x3f) << 6) | (p[i + 3] & 0x3f);
      len = 4;
    } else {
      cp = 0xfffd;
      len = 1;
    }
    u16_push_cp(d, cp);
    i += len;
  }
}

static ScrStr *u16_to_str(const uint16_t *p, size_t n) {
  char *buf = malloc(n * 3 + 1);
  if (!buf) tty_oom();
  size_t k = 0;
  for (size_t i = 0; i < n; i++) {
    uint32_t cp = p[i];
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < n && p[i + 1] >= 0xdc00 && p[i + 1] <= 0xdfff) {
      cp = 0x10000 + ((cp - 0xd800) << 10) + (p[i + 1] - 0xdc00);
      i++;
    }
    if (cp < 0x80) {
      buf[k++] = (char)cp;
    } else if (cp < 0x800) {
      buf[k++] = (char)(0xc0 | (cp >> 6));
      buf[k++] = (char)(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      buf[k++] = (char)(0xe0 | (cp >> 12));
      buf[k++] = (char)(0x80 | ((cp >> 6) & 0x3f));
      buf[k++] = (char)(0x80 | (cp & 0x3f));
    } else {
      buf[k++] = (char)(0xf0 | (cp >> 18));
      buf[k++] = (char)(0x80 | ((cp >> 12) & 0x3f));
      buf[k++] = (char)(0x80 | ((cp >> 6) & 0x3f));
      buf[k++] = (char)(0x80 | (cp & 0x3f));
    }
  }
  ScrStr *s = scr_str_new(buf, k);
  free(buf);
  return s;
}

/* String.prototype.codePointAt(i) */
static uint32_t u16_cp_at(const uint16_t *p, size_t n, size_t i) {
  uint32_t c = p[i];
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < n && p[i + 1] >= 0xdc00 && p[i + 1] <= 0xdfff)
    return 0x10000 + ((c - 0xd800) << 10) + (p[i + 1] - 0xdc00);
  return c;
}

static bool u16_eq(const uint16_t *a, size_t an, const uint16_t *b, size_t bn) {
  return an == bn && (an == 0 || memcmp(a, b, an * sizeof *a) == 0);
}

static bool u16_starts_with(const uint16_t *s, size_t n, const uint16_t *pre, size_t pn) {
  return pn <= n && (pn == 0 || memcmp(s, pre, pn * sizeof *s) == 0);
}

/* JS \s (WhiteSpace and LineTerminator) */
static bool js_space(uint32_t c) {
  return c == 0x09 || c == 0x0a || c == 0x0b || c == 0x0c || c == 0x0d || c == 0x20 ||
         c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 ||
         c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
}

/* JS \w */
static bool js_word(uint32_t c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
}

/* charLengthLeft / charLengthAt (internal/readline/utils.js) */
static size_t char_length_left(const U16 *s, size_t i) {
  if (i == 0) return 0;
  if ((i > 1 && u16_cp_at(s->u, s->n, i - 2) >= 0x10000) || u16_cp_at(s->u, s->n, i - 1) >= 0x10000)
    return 2;
  return 1;
}

static size_t char_length_at(const U16 *s, size_t i) {
  if (s->n <= i) return 1;
  return u16_cp_at(s->u, s->n, i) >= 0x10000 ? 2 : 1;
}

/* ── the terminal state ────────────────────────────────────────────── */

/* scr_insp_dyn, passed in when there is a completer (the inspect unit links
 * only then) */
typedef ScrStr *(*ScrRlInspectFn)(ScrDyn *, double, double);

typedef struct {
  U16 text;
  size_t cursor;
} RlEdit;

typedef struct {
  RlEdit *v;
  size_t n, cap;
} RlEdits;

/* a decoded key (emitKeys' key object) */
typedef struct {
  const char *name; /* NULL: undefined */
  bool ctrl, meta, shift;
  bool has_sequence;
  U16 sequence;
  char one[2]; /* storage for a one-letter name */
  bool has_code; /* key.code, set for escape sequences */
  uint16_t code[16];
  size_t code_n;
} RlKey;

typedef struct ScrRlTty {
  U16 line;
  size_t cursor;
  double prev_rows;
  bool multiline; /* kIsMultiline */
  bool has_sub;   /* kSubstringSearch !== null */
  U16 sub;
  const char *prev_key; /* kPreviousKey.name (NULL: none or undefined) */
  bool yanking;
  U16 ring[32]; /* kKillRing */
  size_t ring_n, ring_cursor;
  RlEdits undo, redo;
  double prev_cursor_cols; /* kPreviousCursorCols */
  U16 saved_line;          /* kSavePreviousState */
  size_t saved_cursor;
  double saved_prev_rows;
  double saw_return_at; /* kSawReturnAt */
  bool completion_enabled;
  ScrClosure *kp_listener; /* onkeypress on a stream input (the emitter owns it) */
  ScrDyn *completer; /* +1 or NULL */
  bool completer_callback; /* (line, callback) completer, or node:readline's wrapper */
  bool promises;           /* readline/promises: the completer is awaited */
  double columns;
  bool dumb;     /* node:readline under TERM=dumb (_ttyWriteDumb) */
  bool raw_stdin; /* stdin is a TTY in raw mode */
  ScrRlInspectFn inspect; /* util.inspect for completion errors, with a completer */
} ScrRlTty;

static ScrRlTty *tty_of(ScrRl *rl) { return rl->tty; }

/* ── output (internal/readline/callbacks.js) ───────────────────────── */

static bool tty_has_output(ScrRl *rl) { return rl->out != NULL || rl->out_stdout; }

static void tty_write_cstr(ScrRl *rl, const char *s, size_t n) {
  if (!tty_has_output(rl)) return;
  ScrStr *t = scr_str_new(s, n);
  scr_rl_write_out(rl, t);
  scr_str_release(t);
}

/* kWriteToOutput */
static void tty_write_u16(ScrRl *rl, const uint16_t *p, size_t n) {
  if (!tty_has_output(rl)) return;
  ScrStr *t = u16_to_str(p, n);
  scr_rl_write_out(rl, t);
  scr_str_release(t);
}

static void tty_write_num(char *buf, size_t *k, double v) {
  *k += (size_t)snprintf(buf + *k, 32, "%.0f", v);
}

/* cursorTo(output, x): CSI x+1 G */
static void tty_cursor_to(ScrRl *rl, double x) {
  if (!tty_has_output(rl)) return;
  char buf[48];
  size_t k = 0;
  buf[k++] = '\x1b';
  buf[k++] = '[';
  tty_write_num(buf, &k, x + 1);
  buf[k++] = 'G';
  tty_write_cstr(rl, buf, k);
}

/* moveCursor(output, dx, dy) */
static void tty_move_cursor(ScrRl *rl, double dx, double dy) {
  if (!tty_has_output(rl) || !(dx || dy)) return;
  char buf[96];
  size_t k = 0;
  if (dx < 0) {
    buf[k++] = '\x1b';
    buf[k++] = '[';
    tty_write_num(buf, &k, -dx);
    buf[k++] = 'D';
  } else if (dx > 0) {
    buf[k++] = '\x1b';
    buf[k++] = '[';
    tty_write_num(buf, &k, dx);
    buf[k++] = 'C';
  }
  if (dy < 0) {
    buf[k++] = '\x1b';
    buf[k++] = '[';
    tty_write_num(buf, &k, -dy);
    buf[k++] = 'A';
  } else if (dy > 0) {
    buf[k++] = '\x1b';
    buf[k++] = '[';
    tty_write_num(buf, &k, dy);
    buf[k++] = 'B';
  }
  tty_write_cstr(rl, buf, k);
}

static void tty_clear_screen_down(ScrRl *rl) { tty_write_cstr(rl, "\x1b[0J", 4); }

/* this.columns: the output's columns, or Infinity */
static double tty_columns(ScrRl *rl) {
  if (rl->out_stdout && !rl->out) {
    double cols = scr_process_columns(1);
    if (cols > 0) return cols;
  }
  return INFINITY;
}

/* ── display positions ─────────────────────────────────────────────── */

/* getStringWidth(String.fromCodePoint(cp), false) */
static unsigned tty_cp_width(uint32_t cp) {
  size_t lo = 0, hi = sizeof scr_rl_width_ranges / sizeof scr_rl_width_ranges[0];
  while (lo < hi) {
    size_t mid = (lo + hi) / 2;
    if (cp < scr_rl_width_ranges[mid].start) hi = mid;
    else if (cp > scr_rl_width_ranges[mid].end) lo = mid + 1;
    else return scr_rl_width_ranges[mid].width;
  }
  return 1;
}

static bool tty_cp_emoji(uint32_t cp) {
  size_t lo = 0, hi = sizeof scr_rl_emoji_ranges / sizeof scr_rl_emoji_ranges[0];
  while (lo < hi) {
    size_t mid = (lo + hi) / 2;
    if (cp < scr_rl_emoji_ranges[mid].start) hi = mid;
    else if (cp > scr_rl_emoji_ranges[mid].end) lo = mid + 1;
    else return true;
  }
  return false;
}

typedef struct {
  double cols, rows;
} RlPos;

/* kGetDisplayPos(str): the last character's display position, after
 * stripVTControlCharacters. */
static RlPos tty_display_pos(ScrRl *rl, const uint16_t *p, size_t n) {
  ScrRlTty *t = tty_of(rl);
  U16 str = {0};
  bool vt = false;
  for (size_t i = 0; i < n && !vt; i++) vt = p[i] == 0x1b || p[i] == 0x9b;
  if (vt) {
    ScrStr *raw = u16_to_str(p, n);
    ScrDyn *d = scr_dyn_new_str(raw);
    scr_str_release(raw);
    ScrStr *stripped = scr_util_strip_vt(d);
    scr_dyn_release(d);
    u16_from_utf8(&str, stripped->data, stripped->len);
    scr_str_release(stripped);
  } else {
    u16_set(&str, p, n);
  }
  t->columns = tty_columns(rl);
  double offset = 0, rows = 0, col = t->columns;
  double tab = rl->tab_size;
  for (size_t i = 0; i < str.n;) {
    uint32_t cp = u16_cp_at(str.u, str.n, i);
    size_t len = cp >= 0x10000 ? 2 : 1;
    if (cp == '\n') {
      double r = ceil(offset / col);
      rows += r ? r : 1;
      offset = t->multiline ? 2 : 0; /* kMultilinePrompt '| ' */
      i += len;
      continue;
    }
    if (cp == '\t') {
      offset += tab - fmod(offset, tab);
      i += len;
      continue;
    }
    unsigned width = tty_cp_width(cp);
    if (width == 0 || width == 1) {
      offset += (double)width;
    } else {
      if (fmod(offset + 1, col) == 0) offset++;
      offset += 2;
    }
    i += len;
  }
  u16_free(&str);
  double cols = fmod(offset, col);
  rows += (offset - cols) / col;
  RlPos pos = {cols, rows};
  return pos;
}

/* getCursorPos(): the prompt and the line before the cursor */
static RlPos tty_cursor_pos(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  U16 s = {0};
  u16_from_utf8(&s, rl->prompt->data, rl->prompt->len);
  u16_append(&s, t->line.u, t->cursor);
  RlPos pos = tty_display_pos(rl, s.u, s.n);
  u16_free(&s);
  return pos;
}

/* kSetLine */
static void tty_set_line(ScrRlTty *t, const uint16_t *p, size_t n) {
  U16 copy = {0};
  u16_set(&copy, p, n);
  u16_free(&t->line);
  t->line = copy;
  t->multiline = false;
  for (size_t i = 0; i < n; i++) {
    if (p[i] == '\n') {
      t->multiline = true;
      break;
    }
  }
}

/* Keeps the cursor on a character boundary of the line: a cursor between
 * the two units of a surrogate pair moves to the pair's start (dir < 0)
 * or its end (dir > 0). Node's own kMultilineMove can stop inside a pair;
 * the editing code here indexes the line by the cursor and relies on it
 * staying on a boundary and within the line. */
static void tty_snap(ScrRlTty *t, int dir) {
  size_t c = t->cursor > t->line.n ? t->line.n : t->cursor;
  if (c > 0 && c < t->line.n && t->line.u[c - 1] >= 0xd800 && t->line.u[c - 1] <= 0xdbff &&
      t->line.u[c] >= 0xdc00 && t->line.u[c] <= 0xdfff)
    c = dir < 0 ? c - 1 : c + 1;
  t->cursor = c;
}

/* kRefreshLine */
static void tty_refresh(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  U16 line = {0};
  u16_from_utf8(&line, rl->prompt->data, rl->prompt->len);
  size_t prompt_n = line.n;
  u16_append(&line, t->line.u, t->line.n);
  RlPos disp = tty_display_pos(rl, line.u, line.n);
  RlPos cursor = tty_cursor_pos(rl);
  if (t->prev_rows > 0) tty_move_cursor(rl, 0, -t->prev_rows);
  tty_cursor_to(rl, 0);
  tty_clear_screen_down(rl);
  if (t->multiline) {
    /* the first line with the prompt, then '| ' before each later one */
    size_t start = 0, i = 0;
    bool first = true;
    for (;; i++) {
      if (i == t->line.n || t->line.u[i] == '\n') {
        U16 out = {0};
        if (first) {
          u16_append(&out, line.u, prompt_n);
        } else {
          static const uint16_t cont[] = {'\n', '|', ' '};
          u16_append(&out, cont, 3);
        }
        u16_append(&out, t->line.u + start, i - start);
        tty_write_u16(rl, out.u, out.n);
        u16_free(&out);
        first = false;
        start = i + 1;
        if (i == t->line.n) break;
      }
    }
  } else {
    tty_write_u16(rl, line.u, line.n);
  }
  if (disp.cols == 0) tty_write_cstr(rl, " ", 1);
  tty_cursor_to(rl, cursor.cols);
  double diff = disp.rows - cursor.rows;
  if (diff > 0) tty_move_cursor(rl, 0, -diff);
  t->prev_rows = cursor.rows;
  u16_free(&line);
}

/* kMoveCursor(dx) */
static void tty_move(ScrRl *rl, double dx) {
  ScrRlTty *t = tty_of(rl);
  if (dx == 0) return;
  RlPos old = tty_cursor_pos(rl);
  double c = (double)t->cursor + dx;
  if (c < 0) c = 0;
  else if (c > (double)t->line.n) c = (double)t->line.n;
  t->cursor = (size_t)c;
  tty_snap(t, dx < 0 ? -1 : 1);
  RlPos now = tty_cursor_pos(rl);
  if (old.rows == now.rows) tty_move_cursor(rl, now.cols - old.cols, 0);
  else tty_refresh(rl);
}

/* ── undo / redo (kPushToUndoStack, kUndo, kRedo) ──────────────────── */

static void edits_push(RlEdits *e, const U16 *text, size_t cursor) {
  if (e->n == e->cap) {
    e->cap = e->cap ? e->cap * 2 : 8;
    e->v = realloc(e->v, e->cap * sizeof *e->v);
    if (!e->v) tty_oom();
  }
  RlEdit *x = &e->v[e->n++];
  memset(x, 0, sizeof *x);
  u16_set(&x->text, text->u, text->n);
  x->cursor = cursor;
}

static void edits_clear(RlEdits *e) {
  for (size_t i = 0; i < e->n; i++) u16_free(&e->v[i].text);
  e->n = 0;
}

/* kBeforeEdit: push { text, cursor }, dropping the oldest past 2048 */
static void tty_before_edit(ScrRlTty *t) {
  edits_push(&t->undo, &t->line, t->cursor);
  if (t->undo.n > 2048) {
    u16_free(&t->undo.v[0].text);
    memmove(t->undo.v, t->undo.v + 1, (t->undo.n - 1) * sizeof *t->undo.v);
    t->undo.n--;
  }
}

static void tty_undo_redo(ScrRl *rl, RlEdits *from, RlEdits *to) {
  ScrRlTty *t = tty_of(rl);
  if (from->n == 0) return;
  edits_push(to, &t->line, t->cursor);
  RlEdit e = from->v[--from->n];
  tty_set_line(t, e.text.u, e.text.n);
  t->cursor = e.cursor;
  tty_snap(t, -1);
  u16_free(&e.text);
  tty_refresh(rl);
}

/* ── editing ───────────────────────────────────────────────────────── */

/* kInsertString(c) */
static void tty_insert(ScrRl *rl, const uint16_t *c, size_t cn) {
  ScrRlTty *t = tty_of(rl);
  tty_before_edit(t);
  if (!t->completion_enabled) {
    /* raw insertion: the line changes without kSetLine */
    U16 line = {0};
    u16_append(&line, t->line.u, t->cursor);
    u16_append(&line, c, cn);
    u16_append(&line, t->line.u + t->cursor, t->line.n - t->cursor);
    u16_free(&t->line);
    t->line = line;
    t->cursor += cn;
    tty_write_u16(rl, c, cn);
    return;
  }
  if (t->cursor < t->line.n) {
    U16 line = {0};
    u16_append(&line, t->line.u, t->cursor);
    u16_append(&line, c, cn);
    u16_append(&line, t->line.u + t->cursor, t->line.n - t->cursor);
    tty_set_line(t, line.u, line.n);
    u16_free(&line);
    t->cursor += cn;
    tty_refresh(rl);
  } else {
    RlPos old = tty_cursor_pos(rl);
    u16_append(&t->line, c, cn);
    t->cursor += cn;
    RlPos now = tty_cursor_pos(rl);
    if (old.rows < now.rows) tty_refresh(rl);
    else tty_write_u16(rl, c, cn);
  }
}

/* kDeleteLeft / kDeleteRight */
static void tty_delete_left(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  if (t->cursor > 0 && t->line.n > 0) {
    tty_before_edit(t);
    size_t k = char_length_left(&t->line, t->cursor);
    if (k > t->cursor) k = t->cursor;
    memmove(t->line.u + t->cursor - k, t->line.u + t->cursor,
            (t->line.n - t->cursor) * sizeof *t->line.u);
    t->line.n -= k;
    t->cursor -= k;
    tty_refresh(rl);
  }
}

static void tty_delete_right(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  if (t->cursor < t->line.n) {
    tty_before_edit(t);
    size_t k = char_length_at(&t->line, t->cursor);
    if (t->cursor + k > t->line.n) k = t->line.n - t->cursor;
    memmove(t->line.u + t->cursor, t->line.u + t->cursor + k,
            (t->line.n - t->cursor - k) * sizeof *t->line.u);
    t->line.n -= k;
    tty_refresh(rl);
  }
}

/* /^\s*(?:[^\w\s]+|\w+)?/ over the code-point-reversed text before the
 * cursor: the units to step back */
static size_t tty_word_left_len(const ScrRlTty *t) {
  size_t j = t->cursor;
  const uint16_t *u = t->line.u;
  while (j > 0 && js_space(u[j - 1])) j--;
  if (j > 0) {
    if (js_word(u[j - 1])) {
      while (j > 0 && js_word(u[j - 1])) j--;
    } else {
      while (j > 0 && !js_word(u[j - 1]) && !js_space(u[j - 1])) j--;
    }
  }
  return t->cursor - j;
}

/* /^(?:\s+|[^\w\s]+|\w+)\s*\/ (word_right) and /^(?:\s+|\W+|\w+)\s*\/
 * (delete_word_right) after the cursor */
static size_t tty_word_right_len(const ScrRlTty *t, bool nonword_takes_space) {
  size_t j = t->cursor, n = t->line.n;
  const uint16_t *u = t->line.u;
  if (j >= n) return 0;
  if (js_space(u[j])) {
    while (j < n && js_space(u[j])) j++;
  } else if (js_word(u[j])) {
    while (j < n && js_word(u[j])) j++;
  } else {
    while (j < n && !js_word(u[j]) && (nonword_takes_space || !js_space(u[j]))) j++;
  }
  while (j < n && js_space(u[j])) j++;
  return j - t->cursor;
}

static void tty_word_left(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  if (t->cursor > 0) tty_move(rl, -(double)tty_word_left_len(t));
}

static void tty_word_right(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  if (t->cursor < t->line.n) tty_move(rl, (double)tty_word_right_len(t, false));
}

static void tty_delete_word_left(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  if (t->cursor > 0) {
    tty_before_edit(t);
    size_t k = tty_word_left_len(t);
    if (k > t->cursor) k = t->cursor;
    memmove(t->line.u + t->cursor - k, t->line.u + t->cursor,
            (t->line.n - t->cursor) * sizeof *t->line.u);
    t->line.n -= k;
    t->cursor -= k;
    tty_refresh(rl);
  }
}

static void tty_delete_word_right(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  if (t->cursor < t->line.n) {
    tty_before_edit(t);
    size_t k = tty_word_right_len(t, true);
    if (k > t->line.n - t->cursor) k = t->line.n - t->cursor;
    memmove(t->line.u + t->cursor, t->line.u + t->cursor + k,
            (t->line.n - t->cursor - k) * sizeof *t->line.u);
    t->line.n -= k;
    tty_refresh(rl);
  }
}

/* ── the kill ring ─────────────────────────────────────────────────── */

static void tty_push_kill_ring(ScrRlTty *t, const uint16_t *p, size_t n) {
  if (n == 0) return;
  if (t->ring_n > 0 && u16_eq(t->ring[0].u, t->ring[0].n, p, n)) return;
  if (t->ring_n == 32) {
    u16_free(&t->ring[31]);
    t->ring_n--;
  }
  memmove(t->ring + 1, t->ring, t->ring_n * sizeof *t->ring);
  memset(&t->ring[0], 0, sizeof t->ring[0]);
  u16_set(&t->ring[0], p, n);
  t->ring_n++;
  t->ring_cursor = 0;
}

static void tty_delete_line_left(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  tty_before_edit(t);
  U16 del = {0}, rest = {0};
  u16_set(&del, t->line.u, t->cursor);
  u16_set(&rest, t->line.u + t->cursor, t->line.n - t->cursor);
  tty_set_line(t, rest.u, rest.n);
  t->cursor = 0;
  tty_push_kill_ring(t, del.u, del.n);
  u16_free(&del);
  u16_free(&rest);
  tty_refresh(rl);
}

static void tty_delete_line_right(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  tty_before_edit(t);
  U16 del = {0}, rest = {0};
  u16_set(&del, t->line.u + t->cursor, t->line.n - t->cursor);
  u16_set(&rest, t->line.u, t->cursor);
  tty_set_line(t, rest.u, rest.n);
  tty_push_kill_ring(t, del.u, del.n);
  u16_free(&del);
  u16_free(&rest);
  tty_refresh(rl);
}

static void tty_yank(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  if (t->ring_n > 0) {
    t->yanking = true;
    U16 y = {0};
    u16_set(&y, t->ring[t->ring_cursor].u, t->ring[t->ring_cursor].n);
    tty_insert(rl, y.u, y.n);
    u16_free(&y);
  }
}

static void tty_yank_pop(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  if (!t->yanking) return;
  if (t->ring_n > 1) {
    size_t last = t->ring[t->ring_cursor].n;
    t->ring_cursor++;
    if (t->ring_cursor >= t->ring_n) t->ring_cursor = 0;
    const U16 *cur = &t->ring[t->ring_cursor];
    size_t head_n = t->cursor >= last ? t->cursor - last : 0;
    U16 line = {0};
    u16_append(&line, t->line.u, head_n);
    u16_append(&line, cur->u, cur->n);
    u16_append(&line, t->line.u + t->cursor, t->line.n - t->cursor);
    tty_set_line(t, line.u, line.n);
    u16_free(&line);
    t->cursor = head_n + cur->n;
    tty_snap(t, 1);
    tty_refresh(rl);
  }
}

/* ── history (internal/repl/history.js) ────────────────────────────── */

/* reverseString(line, from, to) */
static void tty_reverse_lines(U16 *out, const uint16_t *p, size_t n, uint16_t from, uint16_t to) {
  out->n = 0;
  size_t end = n;
  for (size_t i = n; i > 0; i--) {
    if (p[i - 1] == from) {
      u16_append(out, p + i, end - i);
      u16_push(out, to);
      end = i - 1;
    }
  }
  u16_append(out, p, end);
}

static double tty_hist_len(ScrRl *rl) { return scr_arr_len(scr_rl_history_of(rl)); }

/* history[i] as UTF-16 (a hole reads as '') */
static void tty_hist_at(ScrRl *rl, double i, U16 *out) {
  out->n = 0;
  ScrStr *s = scr_arr_peek_ref(scr_rl_history_of(rl), i);
  if (s) u16_from_utf8(out, s->data, s->len);
}

/* addHistory(isMultiline, false): the line kLine hands kOnLine (+1) */
static ScrStr *tty_add_history(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  const U16 *line = &t->line;
  if (line->n == 0) return scr_str_new("", 0);
  if (rl->history_size == 0) return u16_to_str(line->u, line->n);
  size_t i = 0;
  while (i < line->n && js_space(line->u[i])) i++;
  if (i == line->n) return u16_to_str(line->u, line->n);
  ScrArr *h = scr_rl_history_of(rl);
  if (t->multiline && rl->history_index == -1 && scr_arr_len(h) > 0) {
    ScrStr *gone = scr_arr_shift_ref(h);
    if (gone) scr_str_release(gone);
  }
  U16 norm = {0};
  tty_reverse_lines(&norm, line->u, line->n, '\n', '\r');
  ScrStr *ns = u16_to_str(norm.u, norm.n);
  u16_free(&norm);
  ScrStr *first = scr_arr_len(h) > 0 ? scr_arr_peek_ref(h, 0) : NULL;
  if (!first || !scr_str_eq(first, ns)) {
    if (rl->remove_dups) {
      double dup = scr_arr_index_of_ref(h, ns);
      if (dup != -1) scr_arr_release(scr_arr_splice(h, dup, 1));
    }
    scr_arr_unshift_ref(h, scr_str_retain(ns));
    if (scr_arr_len(h) > rl->history_size) {
      ScrStr *gone = scr_arr_pop_ref(h);
      if (gone) scr_str_release(gone);
    }
  }
  scr_str_release(ns);
  rl->history_index = -1;
  ScrStr *top = scr_arr_len(h) > 0 ? scr_arr_peek_ref(h, 0) : NULL;
  ScrStr *final;
  if (!top) {
    final = scr_str_new("", 0);
  } else if (t->multiline) {
    U16 a = {0}, b = {0};
    u16_from_utf8(&a, top->data, top->len);
    tty_reverse_lines(&b, a.u, a.n, '\r', '\r');
    final = u16_to_str(b.u, b.n);
    u16_free(&a);
    u16_free(&b);
  } else {
    final = scr_str_retain(top);
  }
  scr_rl_emit_history(rl);
  return final;
}

/* navigateToNext / navigateToPrevious: the new line into *out */
static void tty_navigate(ScrRl *rl, int dir, U16 *out) {
  ScrRlTty *t = tty_of(rl);
  U16 search = {0}, entry = {0};
  if (t->has_sub) u16_set(&search, t->sub.u, t->sub.n);
  double len = tty_hist_len(rl);
  double index = rl->history_index + dir;
  for (;;) {
    if (dir < 0 ? index < 0 : index >= len) break;
    tty_hist_at(rl, index, &entry);
    if (u16_starts_with(entry.u, entry.n, search.u, search.n) &&
        !u16_eq(t->line.u, t->line.n, entry.u, entry.n))
      break;
    index += dir;
  }
  rl->history_index = index;
  if (dir < 0 ? index == -1 : index == len) {
    u16_set(out, search.u, search.n);
  } else {
    tty_hist_at(rl, index, &entry);
    tty_reverse_lines(out, entry.u, entry.n, '\r', '\n');
  }
  u16_free(&search);
  u16_free(&entry);
}

/* kHistoryNext / kHistoryPrev */
static void tty_history_step(ScrRl *rl, int dir) {
  ScrRlTty *t = tty_of(rl);
  double len = tty_hist_len(rl);
  bool can = dir < 0 ? (rl->history_index > -1 && len > 0) : (len != rl->history_index && len > 0);
  if (!can) return;
  tty_before_edit(t);
  U16 next = {0};
  tty_navigate(rl, dir, &next);
  tty_set_line(t, next.u, next.n);
  u16_free(&next);
  t->cursor = t->line.n;
  tty_refresh(rl);
}

/* kMultilineMove(direction, splitLines, { rows, cols }) */
static void tty_multiline_move(ScrRl *rl, int dir, RlPos pos) {
  ScrRlTty *t = tty_of(rl);
  /* the lengths of lines rows and rows + dir */
  size_t row = 0, start = 0, curr = 0, adj = 0;
  size_t want = (size_t)pos.rows;
  for (size_t i = 0;; i++) {
    if (i == t->line.n || t->line.u[i] == '\n') {
      size_t l = i - start;
      if (row == want) curr = l;
      if ((double)row == pos.rows + dir) adj = l;
      row++;
      start = i + 1;
      if (i == t->line.n) break;
    }
  }
  double cols = pos.cols;
  double clamp = dir == 1 ? (double)curr - cols + 2 + (double)adj + 1 : -cols + 1;
  bool should_clamp = cols > (double)adj + 1;
  double amount;
  if (should_clamp) {
    if (t->prev_cursor_cols == -1) t->prev_cursor_cols = cols;
    amount = clamp;
  } else {
    amount = dir == 1 ? (double)curr + 1 : -(double)adj - 1;
    if (t->prev_cursor_cols != -1) {
      if (t->prev_cursor_cols <= (double)adj) {
        amount += t->prev_cursor_cols - cols;
        t->prev_cursor_cols = -1;
      } else {
        amount = clamp;
      }
    }
  }
  tty_move(rl, amount);
}

static size_t tty_line_count(const ScrRlTty *t) {
  size_t n = 1;
  for (size_t i = 0; i < t->line.n; i++) n += t->line.u[i] == '\n';
  return n;
}

static void tty_up_or_prev(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  RlPos pos = tty_cursor_pos(rl);
  if (t->multiline && pos.rows > 0) {
    tty_multiline_move(rl, -1, pos);
    return;
  }
  t->prev_cursor_cols = -1;
  tty_history_step(rl, 1);
}

static void tty_down_or_next(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  RlPos pos = tty_cursor_pos(rl);
  if (t->multiline && pos.rows < (double)tty_line_count(t) - 1) {
    tty_multiline_move(rl, 1, pos);
    return;
  }
  t->prev_cursor_cols = -1;
  tty_history_step(rl, -1);
}

/* ── lines ─────────────────────────────────────────────────────────── */

/* clearLine() */
static void tty_clear_line(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  tty_move(rl, INFINITY);
  tty_write_cstr(rl, "\r\n", 2);
  tty_set_line(t, NULL, 0);
  t->cursor = 0;
  t->prev_rows = 0;
}

/* kLine */
static void tty_line(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  u16_set(&t->saved_line, t->line.u, t->line.n);
  t->saved_cursor = t->cursor;
  t->saved_prev_rows = t->prev_rows;
  ScrStr *line = tty_add_history(rl);
  edits_clear(&t->undo);
  edits_clear(&t->redo);
  tty_clear_line(rl);
  scr_rl_on_line(rl, line);
}

/* ── Tab completion ────────────────────────────────────────────────── */

typedef struct {
  U16 *v;
  size_t n;
} RlStrs;

static void strs_free(RlStrs *s) {
  for (size_t i = 0; i < s->n; i++) u16_free(&s->v[i]);
  free(s->v);
  s->v = NULL;
  s->n = 0;
}

static void tty_dyn_to_u16(const ScrDyn *d, U16 *out) {
  out->n = 0;
  ScrStr *s = d->kind == SCR_DYN_STR ? scr_str_retain(d->v.str) : scr_dyn_string_coerce(d);
  u16_from_utf8(out, s->data, s->len);
  scr_str_release(s);
}

/* getStringWidth(str): stripVTControlCharacters, then each code point's
 * width, skipping an emoji right after a ZWJ */
static double tty_string_width(const U16 *s) {
  U16 str = {0};
  bool vt = false;
  for (size_t i = 0; i < s->n && !vt; i++) vt = s->u[i] == 0x1b || s->u[i] == 0x9b;
  if (vt) {
    ScrStr *raw = u16_to_str(s->u, s->n);
    ScrDyn *d = scr_dyn_new_str(raw);
    scr_str_release(raw);
    ScrStr *stripped = scr_util_strip_vt(d);
    scr_dyn_release(d);
    u16_from_utf8(&str, stripped->data, stripped->len);
    scr_str_release(stripped);
  } else {
    u16_set(&str, s->u, s->n);
  }
  double w = 0;
  uint32_t prev = 0;
  for (size_t i = 0; i < str.n;) {
    uint32_t cp = u16_cp_at(str.u, str.n, i);
    i += cp >= 0x10000 ? 2 : 1;
    if (!(prev == 0x200d && tty_cp_emoji(cp))) w += tty_cp_width(cp);
    prev = cp;
  }
  u16_free(&str);
  return w;
}

static int u16_cmp(const U16 *a, const U16 *b) {
  size_t n = a->n < b->n ? a->n : b->n;
  for (size_t i = 0; i < n; i++)
    if (a->u[i] != b->u[i]) return a->u[i] < b->u[i] ? -1 : 1;
  return a->n < b->n ? -1 : a->n > b->n ? 1 : 0;
}

/* String.prototype.slice(start, end) bounds */
static size_t tty_slice_bound(double v, size_t len) {
  if (v < 0) v += (double)len;
  if (v < 0) return 0;
  return v > (double)len ? len : (size_t)v;
}

/* kTabCompleter(lastKeypressWasTab, { 0: completions, 1: completeOn }) */
static void tty_tab_completer(ScrRl *rl, bool last_tab, ScrDyn *value /*borrowed; NULL: undefined*/) {
  ScrRlTty *t = tty_of(rl);
  if (!value || scr_dyn_is_nullish(value)) {
    bool null = value && value->kind != SCR_DYN_UNDEF;
    const char *m = null ? "Cannot destructure property '0' of 'object null' as it is null."
                         : "Cannot destructure property '0' of 'undefined' as it is undefined.";
    scr_throw_error_msg(SCR_ERR_TYPE, m, strlen(m));
    return;
  }
  ScrDyn *v = value->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(value) : scr_dyn_retain(value);
  if (v->kind != SCR_DYN_ARR) {
    scr_dyn_release(v);
    return;
  }
  ScrDyn *comps = scr_dyn_arr_at(v, 0);
  ScrDyn *on = scr_dyn_arr_at(v, 1);
  scr_dyn_release(v);
  if (comps->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *m = scr_dyn_typed_ref_materialize(comps);
    scr_dyn_release(comps);
    comps = m;
  }
  if (!scr_dyn_truthy(comps) || comps->kind != SCR_DYN_ARR || scr_dyn_arr_len(comps) == 0) {
    scr_dyn_release(comps);
    scr_dyn_release(on);
    return;
  }
  RlStrs all = {0};
  all.n = (size_t)scr_dyn_arr_len(comps);
  all.v = calloc(all.n, sizeof *all.v);
  if (!all.v) tty_oom();
  for (size_t i = 0; i < all.n; i++) {
    ScrDyn *e = scr_dyn_arr_at(comps, (double)i);
    tty_dyn_to_u16(e, &all.v[i]);
    scr_dyn_release(e);
  }
  scr_dyn_release(comps);
  U16 complete_on = {0};
  tty_dyn_to_u16(on, &complete_on);
  scr_dyn_release(on);

  /* commonPrefix(completions.filter((e) => e !== '')) */
  const U16 *min = NULL, *max = NULL;
  size_t nonempty = 0;
  for (size_t i = 0; i < all.n; i++) {
    if (all.v[i].n == 0) continue;
    nonempty++;
    if (!min || u16_cmp(&all.v[i], min) < 0) min = &all.v[i];
    if (!max || u16_cmp(&all.v[i], max) > 0) max = &all.v[i];
  }
  U16 prefix = {0};
  if (nonempty > 0) {
    size_t k = 0;
    while (k < min->n && k < max->n && min->u[k] == max->u[k]) k++;
    if (nonempty == 1 || k < min->n) u16_set(&prefix, min->u, nonempty == 1 ? min->n : k);
    else u16_set(&prefix, min->u, min->n);
  }

  if (u16_starts_with(prefix.u, prefix.n, complete_on.u, complete_on.n) && prefix.n > complete_on.n) {
    tty_insert(rl, prefix.u + complete_on.n, prefix.n - complete_on.n);
  } else if (!u16_starts_with(complete_on.u, complete_on.n, prefix.u, prefix.n)) {
    double cut = (double)t->cursor - (double)complete_on.n;
    size_t head = tty_slice_bound(cut, t->line.n);
    size_t tail = t->cursor;
    U16 line = {0};
    u16_append(&line, t->line.u, head);
    u16_append(&line, prefix.u, prefix.n);
    u16_append(&line, t->line.u + tail, t->line.n - tail);
    tty_set_line(t, line.u, line.n);
    u16_free(&line);
    double c = cut + (double)prefix.n;
    t->cursor = c < 0 ? 0 : c > (double)t->line.n ? t->line.n : (size_t)c;
    tty_snap(t, 1);
    tty_refresh(rl);
  } else if (last_tab) {
    tty_before_edit(t);
    double *widths = calloc(all.n, sizeof *widths);
    if (!widths) tty_oom();
    double widest = -INFINITY;
    for (size_t i = 0; i < all.n; i++) {
      widths[i] = tty_string_width(&all.v[i]);
      if (widths[i] > widest) widest = widths[i];
    }
    double width = widest + 2;
    double max_columns = floor(tty_columns(rl) / width);
    if (max_columns == 0 || isnan(max_columns) || isinf(max_columns)) max_columns = 1;
    U16 out = {0};
    static const uint16_t crlf[] = {'\r', '\n'};
    u16_append(&out, crlf, 2);
    double line_index = 0, whitespace = 0;
    for (size_t i = 0; i < all.n; i++) {
      const U16 *c = &all.v[i];
      if (c->n == 0 || line_index == max_columns) {
        u16_append(&out, crlf, 2);
        line_index = 0;
        whitespace = 0;
      } else {
        for (double w = 0; w < whitespace; w++) u16_push(&out, ' ');
      }
      if (c->n != 0) {
        u16_append(&out, c->u, c->n);
        whitespace = width - widths[i];
        line_index++;
      } else {
        u16_append(&out, crlf, 2);
      }
    }
    if (line_index != 0) {
      u16_append(&out, crlf, 2);
      u16_append(&out, crlf, 2);
    }
    tty_write_u16(rl, out.u, out.n);
    u16_free(&out);
    free(widths);
    tty_refresh(rl);
  }
  u16_free(&prefix);
  u16_free(&complete_on);
  strs_free(&all);
}

/* `Tab completion error: ${inspect(err)}` */
static void tty_completion_error(ScrRl *rl, ScrDyn *err) {
  ScrStr *s = rl->tty->inspect(err, 0, 2);
  static const char head[] = "Tab completion error: ";
  ScrStr *h = scr_str_new(head, sizeof head - 1);
  ScrStr *m = scr_str_concat(h, s);
  scr_str_release(h);
  scr_str_release(s);
  scr_rl_write_out(rl, m);
  scr_str_release(m);
}

static ScrDyn *tty_line_before_cursor(ScrRlTty *t) {
  ScrStr *s = u16_to_str(t->line.u, t->cursor);
  ScrDyn *d = scr_dyn_new_str(s);
  scr_str_release(s);
  return d;
}

/* node:readline's (line, callback) completer: the callback */
static ScrDyn *tty_complete_cb(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  double id = scr_box_get_f64(clo->caps[0]);
  bool last_tab = scr_box_get_f64(clo->caps[1]) != 0;
  ScrRl *rl = scr_rl_find(id);
  if (!rl || !rl->tty) return scr_dyn_retain(scr_dyn_undefined());
  scr_rl_resume(id); /* this.resume(): throws once the interface is closed */
  if (scr_exc_pending()) return NULL;
  ScrDyn *err = argc > 0 ? args[0] : NULL;
  if (err && scr_dyn_truthy(err)) {
    tty_completion_error(rl, err);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  tty_tab_completer(rl, last_tab, argc > 1 ? args[1] : NULL);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_retain(scr_dyn_undefined());
}

/* readline/promises: the rest of kTabComplete after `await completer()` */
typedef struct {
  double id;
  bool last_tab;
  ScrPromise *p; /* +1 */
} RlAwaitCompletion;

static void tty_complete_await_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  RlAwaitCompletion a = *(RlAwaitCompletion *)arg;
  free(arg);
  ScrDyn *value = scr_await_ref(a.p);
  scr_promise_release(a.p);
  ScrRl *rl = scr_rl_find(a.id);
  if (scr_exc_pending()) {
    ScrCaught *c = scr_exc_take();
    ScrDyn *err = scr_caught_to_dyn(c);
    scr_caught_release(c);
    if (rl && rl->tty && err) tty_completion_error(rl, err);
    if (err) scr_dyn_release(err);
    if (rl) scr_rl_resume(a.id); /* finally { this.resume() } */
    return;
  }
  if (!rl || !rl->tty) {
    if (value) scr_dyn_release(value);
    return;
  }
  scr_rl_resume(a.id);
  if (!scr_exc_pending()) tty_tab_completer(rl, a.last_tab, value);
  if (value) scr_dyn_release(value);
}

/* kTabComplete / node:readline's _tabComplete */
static void tty_tab_complete(ScrRl *rl, bool last_tab) {
  ScrRlTty *t = tty_of(rl);
  scr_rl_do_pause(rl);
  ScrDyn *line = tty_line_before_cursor(t);
  if (t->promises) {
    ScrDyn *args[1] = {line};
    ScrDyn *r = scr_dyn_call(t->completer, args, 1, "this.completer");
    scr_dyn_release(line);
    if (!r) {
      /* a synchronous throw: the catch block, then finally */
      ScrCaught *c = scr_exc_take();
      ScrDyn *err = scr_caught_to_dyn(c);
      scr_caught_release(c);
      if (err) {
        tty_completion_error(rl, err);
        scr_dyn_release(err);
      }
      scr_rl_resume(rl->id);
      return;
    }
    ScrPromise *p = r->kind == SCR_DYN_PROMISE ? r->v.promise : NULL;
    p = p ? scr_promise_retain(p)
          : scr_promise_settled_ref(scr_dyn_retain(r), &scr_dyn_retain_v, &scr_dyn_release_v,
                                    &scr_dyn_trace_v);
    scr_dyn_release(r);
    RlAwaitCompletion *a = malloc(sizeof *a);
    if (!a) tty_oom();
    a->id = rl->id;
    a->last_tab = last_tab;
    a->p = scr_promise_retain(p);
    scr_promise_release(scr_async_spawn_after(p, &tty_complete_await_entry, a));
    scr_promise_release(p);
    return;
  }
  if (t->completer_callback) {
    ScrClosure *clo = scr_closure_new((void *)&tty_complete_cb, 2);
    clo->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(clo->caps[0], rl->id);
    clo->caps[1] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(clo->caps[1], last_tab ? 1 : 0);
    ScrDyn *cb = scr_dyn_new_func(clo, &tty_complete_cb, 2, "(err, value)", NULL);
    ScrDyn *args[2] = {line, cb};
    ScrDyn *r = scr_dyn_call(t->completer, args, 2, "this.completer");
    scr_dyn_release(line);
    scr_dyn_release(cb);
    if (r) scr_dyn_release(r);
    return;
  }
  /* (v, cb) => cb(null, completer(v)) */
  ScrDyn *args[1] = {line};
  ScrDyn *r = scr_dyn_call(t->completer, args, 1, "completer");
  scr_dyn_release(line);
  if (!r) return;
  scr_rl_resume(rl->id);
  if (!scr_exc_pending()) tty_tab_completer(rl, last_tab, r);
  scr_dyn_release(r);
}

/* ── kSetRawMode and Ctrl+Z ────────────────────────────────────────── */

static void tty_set_raw(ScrRl *rl, bool mode) {
  if (rl->tty->raw_stdin) scr_process_stdin_set_raw_mode(mode);
}

#if !defined(_WIN32) && !defined(__wasi__)
/* process.once('SIGCONT', ...) after a Ctrl+Z with no 'SIGTSTP' listener */
static ScrDyn *tty_sigcont_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrRl *rl = scr_rl_find(scr_box_get_f64(clo->caps[0]));
  if (!rl || !rl->tty) return scr_dyn_retain(scr_dyn_undefined());
  if (!rl->paused) {
    scr_rl_do_pause(rl);
    scr_rl_emit(rl, RL_EV_SIGCONT, NULL, NULL);
    if (scr_exc_pending()) return NULL;
  }
  tty_set_raw(rl, true);
  tty_refresh(rl);
  return scr_dyn_retain(scr_dyn_undefined());
}

static void tty_suspend(ScrRl *rl) {
  ScrClosure *clo = scr_closure_new((void *)&tty_sigcont_thunk, 1);
  clo->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(clo->caps[0], rl->id);
  ScrDyn *cb = scr_dyn_new_func(clo, &tty_sigcont_thunk, 0, "()", NULL);
  ScrStr *name = scr_str_new("SIGCONT", 7);
  scr_signal_on(name, cb, true);
  scr_str_release(name);
  scr_dyn_release(cb);
  tty_set_raw(rl, false);
  kill(getpid(), SIGTSTP);
}
#endif

/* ── kTtyWrite ─────────────────────────────────────────────────────── */

static bool key_is(const RlKey *k, const char *name) { return k->name && strcmp(k->name, name) == 0; }

/* lineEnding = /\r?\n|\r(?!\n)| | /g: the next match at or
 * after *from, as [start, end) */
static bool tty_next_line_ending(const uint16_t *s, size_t n, size_t from, size_t *start, size_t *end) {
  for (size_t i = from; i < n; i++) {
    uint16_t c = s[i];
    if (c == '\r') {
      *start = i;
      *end = i + 1 < n && s[i + 1] == '\n' ? i + 2 : i + 1;
      return true;
    }
    if (c == '\n' || c == 0x2028 || c == 0x2029) {
      *start = i;
      *end = i + 1;
      return true;
    }
  }
  return false;
}

/* the default case: each line ending submits the line */
static void tty_insert_text(ScrRl *rl, const uint16_t *s, size_t n) {
  size_t last = 0, start, end;
  while (tty_next_line_ending(s, n, last, &start, &end)) {
    tty_insert(rl, s + last, start - last);
    if (scr_exc_pending()) return;
    last = end;
    tty_line(rl);
    if (scr_exc_pending() || !rl->tty) return;
  }
  tty_insert(rl, s + last, n - last);
}

/* s: NULL for undefined. key: NULL for kEmptyObject. */
static void tty_write_key(ScrRl *rl, const U16 *s, const RlKey *key) {
  ScrRlTty *t = tty_of(rl);
  static const RlKey empty = {0};
  bool previous_tab = t->prev_key != NULL;
  if (!key) key = &empty;
  t->prev_key = key_is(key, "tab") ? "tab" : NULL;
  bool reset_cols = true;

  if (!key->meta || !key_is(key, "y")) t->yanking = false;

  if ((key_is(key, "up") || key_is(key, "down")) && !key->ctrl && !key->meta && !key->shift) {
    if (!t->has_sub && !t->multiline) {
      t->has_sub = true;
      u16_set(&t->sub, t->line.u, t->cursor);
    }
  } else if (t->has_sub) {
    t->has_sub = false;
    if (tty_hist_len(rl) == rl->history_index) rl->history_index = -1;
  }

  if (key->has_sequence && key->sequence.n > 0) {
    uint32_t c = u16_cp_at(key->sequence.u, key->sequence.n, 0);
    if (c == 0x1f) {
      tty_undo_redo(rl, &t->undo, &t->redo);
      return;
    }
    if (c == 0x1e) {
      tty_undo_redo(rl, &t->redo, &t->undo);
      return;
    }
  }

  if (key_is(key, "escape")) return;

  if (key->ctrl && key->shift) {
    if (key_is(key, "backspace")) tty_delete_line_left(rl);
    else if (key_is(key, "delete")) tty_delete_line_right(rl);
  } else if (key->ctrl) {
    const char *nm = key->name ? key->name : "";
    if (!strcmp(nm, "c")) {
      if (rl->ev[RL_EV_SIGINT].n > 0) {
        scr_rl_emit(rl, RL_EV_SIGINT, NULL, NULL);
      } else {
        scr_rl_settle_close(rl);
        scr_rl_reject_question(rl, "Aborted with Ctrl+C");
      }
    } else if (!strcmp(nm, "h")) {
      tty_delete_left(rl);
    } else if (!strcmp(nm, "d")) {
      if (t->cursor == 0 && t->line.n == 0) {
        scr_rl_settle_close(rl);
        scr_rl_reject_question(rl, "Aborted with Ctrl+D");
      } else if (t->cursor < t->line.n) {
        tty_delete_right(rl);
      }
    } else if (!strcmp(nm, "u")) {
      tty_delete_line_left(rl);
    } else if (!strcmp(nm, "k")) {
      tty_delete_line_right(rl);
    } else if (!strcmp(nm, "a")) {
      tty_move(rl, -INFINITY);
    } else if (!strcmp(nm, "e")) {
      tty_move(rl, INFINITY);
    } else if (!strcmp(nm, "b")) {
      tty_move(rl, -(double)char_length_left(&t->line, t->cursor));
    } else if (!strcmp(nm, "f")) {
      tty_move(rl, (double)char_length_at(&t->line, t->cursor));
    } else if (!strcmp(nm, "l")) {
      if (tty_has_output(rl)) tty_write_cstr(rl, "\x1b[1;1H", 6);
      tty_clear_screen_down(rl);
      tty_refresh(rl);
    } else if (!strcmp(nm, "n")) {
      tty_history_step(rl, -1);
    } else if (!strcmp(nm, "p")) {
      tty_history_step(rl, 1);
    } else if (!strcmp(nm, "y")) {
      tty_yank(rl);
    } else if (!strcmp(nm, "z")) {
#if !defined(_WIN32) && !defined(__wasi__)
      if (rl->ev[RL_EV_SIGTSTP].n > 0) scr_rl_emit(rl, RL_EV_SIGTSTP, NULL, NULL);
      else tty_suspend(rl);
#endif
    } else if (!strcmp(nm, "w") || !strcmp(nm, "backspace")) {
      tty_delete_word_left(rl);
    } else if (!strcmp(nm, "delete")) {
      tty_delete_word_right(rl);
    } else if (!strcmp(nm, "left")) {
      tty_word_left(rl);
    } else if (!strcmp(nm, "right")) {
      tty_word_right(rl);
    }
  } else if (key->meta) {
    const char *nm = key->name ? key->name : "";
    if (!strcmp(nm, "b")) tty_word_left(rl);
    else if (!strcmp(nm, "f")) tty_word_right(rl);
    else if (!strcmp(nm, "d") || !strcmp(nm, "delete")) tty_delete_word_right(rl);
    else if (!strcmp(nm, "backspace")) tty_delete_word_left(rl);
    else if (!strcmp(nm, "y")) tty_yank_pop(rl);
  } else {
    if (t->saw_return_at && !key_is(key, "enter")) t->saw_return_at = 0;
    const char *nm = key->name ? key->name : "";
    if (!strcmp(nm, "return")) {
      t->saw_return_at = scr_now_ms();
      tty_line(rl);
    } else if (!strcmp(nm, "enter")) {
      if (t->saw_return_at == 0 || scr_now_ms() - t->saw_return_at > rl->crlf_delay) tty_line(rl);
      if (rl->tty) rl->tty->saw_return_at = 0;
    } else if (!strcmp(nm, "backspace")) {
      tty_delete_left(rl);
    } else if (!strcmp(nm, "delete")) {
      tty_delete_right(rl);
    } else if (!strcmp(nm, "left")) {
      tty_move(rl, -(double)char_length_left(&t->line, t->cursor));
    } else if (!strcmp(nm, "right")) {
      tty_move(rl, (double)char_length_at(&t->line, t->cursor));
    } else if (!strcmp(nm, "home")) {
      tty_move(rl, -INFINITY);
    } else if (!strcmp(nm, "end")) {
      tty_move(rl, INFINITY);
    } else if (!strcmp(nm, "up")) {
      reset_cols = false;
      tty_up_or_prev(rl);
    } else if (!strcmp(nm, "down")) {
      reset_cols = false;
      tty_down_or_next(rl);
    } else if (!strcmp(nm, "tab") && t->completer && t->completion_enabled) {
      tty_tab_complete(rl, previous_tab);
    } else if (s && s->n > 0) {
      tty_insert_text(rl, s->u, s->n);
    }
  }
  if (reset_cols && rl->tty) rl->tty->prev_cursor_cols = -1;
}

/* node:readline's _ttyWriteDumb under TERM=dumb */
static void tty_write_dumb(ScrRl *rl, const U16 *s, const RlKey *key) {
  ScrRlTty *t = tty_of(rl);
  static const RlKey empty = {0};
  if (!key) key = &empty;
  if (key_is(key, "escape")) return;
  if (t->saw_return_at && !key_is(key, "enter")) t->saw_return_at = 0;
  if (key->ctrl) {
    if (key_is(key, "c")) {
      if (rl->ev[RL_EV_SIGINT].n > 0) scr_rl_emit(rl, RL_EV_SIGINT, NULL, NULL);
      else scr_rl_settle_close(rl);
      return;
    }
    if (key_is(key, "d")) {
      scr_rl_settle_close(rl);
      return;
    }
  }
  if (key_is(key, "return")) {
    t->saw_return_at = scr_now_ms();
    tty_line(rl);
  } else if (key_is(key, "enter")) {
    if (t->saw_return_at == 0 || scr_now_ms() - t->saw_return_at > rl->crlf_delay) tty_line(rl);
    if (rl->tty) rl->tty->saw_return_at = 0;
  } else if (s && s->n > 0) {
    u16_append(&t->line, s->u, s->n);
    t->cursor += s->n;
    tty_write_u16(rl, s->u, s->n);
  }
}

/* onkeypress: kTtyWrite, then a refresh after half a surrogate pair */
static void tty_keypress(ScrRl *rl, const U16 *s, const RlKey *key) {
  if (rl->tty->dumb) tty_write_dumb(rl, s, key);
  else tty_write_key(rl, s, key);
  if (scr_exc_pending() || !rl->tty || rl->closed) return;
  if (key && key->has_sequence && key->sequence.n > 0) {
    uint32_t c = u16_cp_at(key->sequence.u, key->sequence.n, 0);
    if (c >= 0xd800 && c <= 0xdfff) tty_refresh(rl);
  }
}

/* ── emitKeys (internal/readline/utils.js) ─────────────────────────── */

/* The generator reads one character per yield and always finishes a key
 * on the character it read last, so the buffered characters are parsed
 * again from the start as each one arrives. -1 is the timeout's ''. */
typedef struct {
  const int32_t *c;
  size_t n, i;
} RlScan;

#define RL_NEXT(p, ch)                                                                             \
  do {                                                                                             \
    if ((p)->i >= (p)->n) return false;                                                            \
    (ch) = (p)->c[(p)->i++];                                                                       \
  } while (0)

static void s_push(U16 *s, int32_t ch) {
  if (ch >= 0) u16_push_cp(s, (uint32_t)ch);
}

static bool u_digit(uint16_t u) { return u >= '0' && u <= '9'; }
static bool u_alpha(uint16_t u) { return (u >= 'A' && u <= 'Z') || (u >= 'a' && u <= 'z'); }
static bool u_tail(uint16_t u) { return u == '~' || u == '^' || u == '$'; }
static bool ch_digit(int32_t ch) { return ch >= '0' && ch <= '9'; }

static bool u16_is(const U16 *s, const char *lit) {
  size_t n = strlen(lit);
  if (s->n != n) return false;
  for (size_t i = 0; i < n; i++)
    if (s->u[i] != (unsigned char)lit[i]) return false;
  return true;
}

static const struct {
  const char *code, *name;
  int flag; /* 1: shift, 2: ctrl */
} RL_CODES[] = {
    {"[P", "f1", 0},          {"[Q", "f2", 0},          {"[R", "f3", 0},
    {"[S", "f4", 0},          {"OP", "f1", 0},          {"OQ", "f2", 0},
    {"OR", "f3", 0},          {"OS", "f4", 0},          {"[11~", "f1", 0},
    {"[12~", "f2", 0},        {"[13~", "f3", 0},        {"[14~", "f4", 0},
    {"[200~", "paste-start", 0}, {"[201~", "paste-end", 0}, {"[[A", "f1", 0},
    {"[[B", "f2", 0},         {"[[C", "f3", 0},         {"[[D", "f4", 0},
    {"[[E", "f5", 0},         {"[15~", "f5", 0},        {"[17~", "f6", 0},
    {"[18~", "f7", 0},        {"[19~", "f8", 0},        {"[20~", "f9", 0},
    {"[21~", "f10", 0},       {"[23~", "f11", 0},       {"[24~", "f12", 0},
    {"[A", "up", 0},          {"[B", "down", 0},        {"[C", "right", 0},
    {"[D", "left", 0},        {"[E", "clear", 0},       {"[F", "end", 0},
    {"[H", "home", 0},        {"OA", "up", 0},          {"OB", "down", 0},
    {"OC", "right", 0},       {"OD", "left", 0},        {"OE", "clear", 0},
    {"OF", "end", 0},         {"OH", "home", 0},        {"[1~", "home", 0},
    {"[2~", "insert", 0},     {"[3~", "delete", 0},     {"[4~", "end", 0},
    {"[5~", "pageup", 0},     {"[6~", "pagedown", 0},   {"[[5~", "pageup", 0},
    {"[[6~", "pagedown", 0},  {"[7~", "home", 0},       {"[8~", "end", 0},
    {"[a", "up", 1},          {"[b", "down", 1},        {"[c", "right", 1},
    {"[d", "left", 1},        {"[e", "clear", 1},       {"[2$", "insert", 1},
    {"[3$", "delete", 1},     {"[5$", "pageup", 1},     {"[6$", "pagedown", 1},
    {"[7$", "home", 1},       {"[8$", "end", 1},        {"Oa", "up", 2},
    {"Ob", "down", 2},        {"Oc", "right", 2},       {"Od", "left", 2},
    {"Oe", "clear", 2},       {"[2^", "insert", 2},     {"[3^", "delete", 2},
    {"[5^", "pageup", 2},     {"[6^", "pagedown", 2},   {"[7^", "home", 2},
    {"[8^", "end", 2},        {"[Z", "tab", 1},
};

/* One key from the buffered characters: false when more are needed. */
static bool tty_parse_key(const int32_t *c, size_t n, RlKey *key, bool *escaped_out) {
  RlScan scan = {c, n, 0}, *p = &scan;
  U16 *s = &key->sequence;
  s->n = 0;
  key->name = NULL;
  key->ctrl = key->meta = key->shift = false;
  int32_t ch;
  RL_NEXT(p, ch);
  s_push(s, ch);
  bool escaped = false;
  if (ch == 0x1b) {
    escaped = true;
    RL_NEXT(p, ch);
    s_push(s, ch);
    if (ch == 0x1b) {
      RL_NEXT(p, ch);
      s_push(s, ch);
    }
  }
  if (escaped && (ch == 'O' || ch == '[')) {
    /* the code: 'O' or '[', a second '[', and at most seven units of
     * the command (three digits, ';', a digit and one character) */
    uint16_t code_u[16];
    U16 code = {code_u, 0, sizeof code_u / sizeof code_u[0]};
    int modifier = 0;
    u16_push(&code, (uint16_t)ch);
    if (ch == 'O') {
      RL_NEXT(p, ch);
      s_push(s, ch);
      if (ch_digit(ch)) {
        modifier = (ch - '0') - 1;
        RL_NEXT(p, ch);
        s_push(s, ch);
      }
      s_push(&code, ch);
    } else {
      RL_NEXT(p, ch);
      s_push(s, ch);
      if (ch == '[') {
        u16_push(&code, '[');
        RL_NEXT(p, ch);
        s_push(s, ch);
      }
      size_t cmd_start = s->n - 1;
      if (ch_digit(ch)) {
        RL_NEXT(p, ch);
        s_push(s, ch);
        if (ch_digit(ch)) {
          RL_NEXT(p, ch);
          s_push(s, ch);
          if (ch_digit(ch)) {
            RL_NEXT(p, ch);
            s_push(s, ch);
          }
        }
      }
      if (ch == ';') {
        RL_NEXT(p, ch);
        s_push(s, ch);
        if (ch_digit(ch)) {
          int32_t more;
          RL_NEXT(p, more);
          s_push(s, more);
        }
      }
      const uint16_t *u = s->u + cmd_start;
      size_t len = s->n - cmd_start;
      bool done = false;
      /* /^(?:(\d\d?)(?:;(\d))?([~^$])|(\d{3}~))$/ */
      for (size_t d = 2; d >= 1 && !done; d--) {
        if (len < d + 1) continue;
        bool digits = true;
        for (size_t k = 0; k < d; k++) digits = digits && u_digit(u[k]);
        if (!digits) continue;
        int mod = 1;
        size_t at = d;
        if (len == d + 3 && u[at] == ';' && u_digit(u[at + 1])) {
          mod = u[at + 1] - '0';
          at += 2;
        }
        if (at + 1 == len && u_tail(u[at])) {
          u16_append(&code, u, d);
          u16_push(&code, u[at]);
          modifier = mod - 1;
          done = true;
        }
      }
      if (!done && len == 4 && u_digit(u[0]) && u_digit(u[1]) && u_digit(u[2]) && u[3] == '~') {
        u16_append(&code, u, 4);
        done = true;
      }
      /* /^((\d;)?(\d))?([A-Za-z])$/ */
      if (!done) {
        if (len == 1 && u_alpha(u[0])) {
          u16_push(&code, u[0]);
          modifier = 0;
          done = true;
        } else if (len == 2 && u_digit(u[0]) && u_alpha(u[1])) {
          u16_push(&code, u[1]);
          modifier = (u[0] - '0') - 1;
          done = true;
        } else if (len == 4 && u_digit(u[0]) && u[1] == ';' && u_digit(u[2]) && u_alpha(u[3])) {
          u16_push(&code, u[3]);
          modifier = (u[2] - '0') - 1;
          done = true;
        }
      }
      if (!done) u16_append(&code, u, len);
    }
    key->ctrl = (modifier & 4) != 0;
    key->meta = (modifier & 10) != 0;
    key->shift = (modifier & 1) != 0;
    key->has_code = true;
    key->code_n = code.n;
    memcpy(key->code, code.u, code.n * sizeof *code.u);
    key->name = "undefined";
    for (size_t i = 0; i < sizeof RL_CODES / sizeof RL_CODES[0]; i++) {
      if (u16_is(&code, RL_CODES[i].code)) {
        key->name = RL_CODES[i].name;
        if (RL_CODES[i].flag == 1) key->shift = true;
        if (RL_CODES[i].flag == 2) key->ctrl = true;
        break;
      }
    }
  } else if (ch == '\r') {
    key->name = "return";
    key->meta = escaped;
  } else if (ch == '\n') {
    key->name = "enter";
    key->meta = escaped;
  } else if (ch == '\t') {
    key->name = "tab";
    key->meta = escaped;
  } else if (ch == '\b' || ch == 0x7f) {
    key->name = "backspace";
    key->meta = escaped;
  } else if (ch == 0x1b) {
    key->name = "escape";
    key->meta = escaped;
  } else if (ch == ' ') {
    key->name = "space";
    key->meta = escaped;
  } else if (!escaped && ch <= 0x1a) {
    /* String.fromCharCode(code + 96); the timeout's '' reads as NaN */
    key->one[0] = ch < 0 ? '\0' : (char)(ch + 'a' - 1);
    key->one[1] = '\0';
    key->name = key->one;
    key->ctrl = true;
  } else if (ch_digit(ch) || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
    key->one[0] = (char)(ch >= 'A' && ch <= 'Z' ? ch + 32 : ch);
    key->one[1] = '\0';
    key->name = key->one;
    key->shift = ch >= 'A' && ch <= 'Z';
    key->meta = escaped;
  } else if (escaped) {
    key->name = ch < 0 ? "escape" : NULL;
    key->meta = true;
  }
  key->has_sequence = true;
  *escaped_out = escaped;
  return true;
}

#undef RL_NEXT

/* ── emitKeypressEvents (internal/readline/emitKeypressEvents.js) ────── */

/* One decoder per stream, as Node keeps stream[ESCAPE_DECODER]. Keys go to
 * the stream's 'keypress' listeners in order: listeners over checked-
 * dynamic (str, key) values, and terminal interfaces' own onkeypress. The
 * hub attaches its 'data' listener once a 'keypress' listener exists
 * (Node's newListener wait) and leaves it when data arrives with none. */
typedef struct {
  ScrDyn *cb; /* the listener, a checked-dynamic function (+1); NULL for an interface */
  double rl;  /* the interface whose onkeypress this is */
  bool once;
} RlKpEntry;

typedef struct {
  RlKpEntry *v;
  size_t n, cap;
} RlKpList;

typedef struct RlKeyHub {
  double id;
  void *stream; /* the stream (+1), or NULL for process.stdin */
  const ScrRlIo *io;
  double iface; /* the interface emitKeypressEvents was given, or 0 */
  double escape_timeout;
  int32_t *pend; /* buffered code points (-1 for the timeout's '') */
  size_t pend_n, pend_cap;
  double esc_timer;
  unsigned char held[4]; /* KEYPRESS_DECODER's incomplete tail */
  size_t n_held;
  bool data_on;              /* onData is attached */
  ScrClosure *on_data;       /* the stream's onData listener (borrowed) */
  ScrClosure *on_new;        /* the stream's onNewListener (borrowed) */
  char *parked;              /* stdin bytes while an attached interface is paused */
  size_t parked_len, parked_cap;
  struct RlKeyHub *next;
} RlKeyHub;

static SCR_TL RlKeyHub *rl_hubs = NULL;
static SCR_TL double rl_hub_next_id = 1;
static SCR_TL RlKpList rl_stdin_kp; /* process.stdin's 'keypress' listeners */
static SCR_TL bool rl_stdin_data_registered = false;

static void hub_cleanup(void) {
  while (rl_hubs) {
    RlKeyHub *h = rl_hubs;
    rl_hubs = h->next;
    if (h->stream) h->io->release(h->stream);
    free(h->pend);
    free(h->parked);
    free(h);
  }
  for (size_t i = 0; i < rl_stdin_kp.n; i++)
    if (rl_stdin_kp.v[i].cb) scr_dyn_release(rl_stdin_kp.v[i].cb);
  free(rl_stdin_kp.v);
  rl_stdin_kp.v = NULL;
  rl_stdin_kp.n = rl_stdin_kp.cap = 0;
}

static void hub_cleanup_register(void) {
  static SCR_TL bool registered = false;
  if (registered) return;
  registered = true;
  scr_atexit(hub_cleanup);
}

static RlKeyHub *hub_by_id(double id) {
  for (RlKeyHub *h = rl_hubs; h; h = h->next) {
    if (h->id == id) return h;
  }
  return NULL;
}

static RlKeyHub *hub_of(void *stream) {
  for (RlKeyHub *h = rl_hubs; h; h = h->next) {
    if (h->stream == stream) return h;
  }
  return NULL;
}

static double hub_listener_count(RlKeyHub *h) {
  if (!h->stream) return (double)rl_stdin_kp.n;
  return h->io->listener_count(h->stream, "keypress");
}

static void kp_push(RlKpList *l, ScrDyn *cb, double rl, bool once) {
  if (l->n == l->cap) {
    l->cap = l->cap ? l->cap * 2 : 4;
    l->v = realloc(l->v, l->cap * sizeof *l->v);
    if (!l->v) tty_oom();
  }
  RlKpEntry e = {cb, rl, once};
  l->v[l->n++] = e;
}

static ScrDyn *u16_dyn(const U16 *s) {
  ScrStr *t = u16_to_str(s->u, s->n);
  ScrDyn *d = scr_dyn_new_str(t);
  scr_str_release(t);
  return d;
}

/* emitKeys' key object: { sequence, name, ctrl, meta, shift[, code] } */
static ScrDyn *key_dyn(const RlKey *k) {
  ScrDyn *o = scr_dyn_new_obj();
  scr_dyn_obj_set(o, "sequence", 8, u16_dyn(&k->sequence));
  if (k->name) {
    ScrStr *n = scr_str_new(k->name, strlen(k->name));
    scr_dyn_obj_set(o, "name", 4, scr_dyn_new_str(n));
    scr_str_release(n);
  } else {
    scr_dyn_obj_set(o, "name", 4, scr_dyn_retain(scr_dyn_undefined()));
  }
  scr_dyn_obj_set(o, "ctrl", 4, scr_dyn_new_bool(k->ctrl));
  scr_dyn_obj_set(o, "meta", 4, scr_dyn_new_bool(k->meta));
  scr_dyn_obj_set(o, "shift", 5, scr_dyn_new_bool(k->shift));
  if (k->has_code) {
    U16 c = {(uint16_t *)k->code, k->code_n, k->code_n};
    scr_dyn_obj_set(o, "code", 4, u16_dyn(&c));
  }
  return o;
}

static void tty_keypress(ScrRl *rl, const U16 *s, const RlKey *key);

/* emit('keypress', escaped ? undefined : s, key) */
static void hub_emit(RlKeyHub *h, const U16 *s, const RlKey *key) {
  if (h->stream) {
    ScrDyn *sd = s ? u16_dyn(s) : scr_dyn_retain(scr_dyn_undefined());
    ScrDyn *kd = key_dyn(key);
    h->io->emit2(h->stream, "keypress", sd, kd);
    scr_dyn_release(sd);
    scr_dyn_release(kd);
    return;
  }
  /* a snapshot in listener order; once-listeners leave before they run */
  RlKpList *l = &rl_stdin_kp;
  size_t n = l->n;
  if (n == 0) return;
  RlKpEntry *snap = malloc(n * sizeof *snap);
  if (!snap) tty_oom();
  memcpy(snap, l->v, n * sizeof *snap);
  for (size_t i = 0; i < n; i++)
    if (snap[i].cb) scr_dyn_retain(snap[i].cb);
  size_t k = 0;
  for (size_t i = 0; i < l->n; i++) {
    if (l->v[i].once) {
      if (l->v[i].cb) scr_dyn_release(l->v[i].cb);
    } else {
      l->v[k++] = l->v[i];
    }
  }
  l->n = k;
  for (size_t i = 0; i < n; i++) {
    RlKpEntry e = snap[i];
    if (!scr_exc_pending()) {
      if (e.cb) {
        ScrDyn *args[2] = {s ? u16_dyn(s) : scr_dyn_retain(scr_dyn_undefined()), key_dyn(key)};
        ScrDyn *r = scr_dyn_call(e.cb, args, 2, "listener");
        if (r) scr_dyn_release(r);
        scr_dyn_release(args[0]);
        scr_dyn_release(args[1]);
      } else {
        ScrRl *rl = scr_rl_find(e.rl);
        if (rl && rl->tty && !rl->closed) tty_keypress(rl, s, key);
      }
    }
    if (e.cb) scr_dyn_release(e.cb);
  }
  free(snap);
}

static void hub_pend_clear(RlKeyHub *h) { h->pend_n = 0; }

/* the next character into the decoder; a finished key is emitted */
static void hub_decode(RlKeyHub *h, int32_t ch) {
  if (h->pend_n == h->pend_cap) {
    h->pend_cap = h->pend_cap ? h->pend_cap * 2 : 16;
    h->pend = realloc(h->pend, h->pend_cap * sizeof *h->pend);
    if (!h->pend) tty_oom();
  }
  h->pend[h->pend_n++] = ch;
  RlKey key = {0};
  bool escaped = false;
  if (!tty_parse_key(h->pend, h->pend_n, &key, &escaped)) {
    u16_free(&key.sequence);
    return;
  }
  hub_pend_clear(h);
  U16 *s = &key.sequence;
  if (s->n != 0 && (key.name != NULL || escaped)) hub_emit(h, escaped ? NULL : s, &key);
  else if (char_length_at(s, 0) == s->n) hub_emit(h, s, &key);
  u16_free(&key.sequence);
}

/* triggerEscape: next('') after escapeCodeTimeout */
static void hub_escape_timeout(ScrClosure *clo) {
  RlKeyHub *h = hub_by_id(scr_box_get_f64(clo->caps[0]));
  if (!h) return;
  h->esc_timer = 0;
  hub_decode(h, -1);
  if (scr_exc_pending()) hub_pend_clear(h);
}

/* the interface's isCompletionEnabled, which onData sets per chunk */
static void hub_completion(RlKeyHub *h, bool on) {
  ScrRl *rl = h->iface ? scr_rl_find(h->iface) : NULL;
  if (rl && rl->tty) rl->tty->completion_enabled = on;
}

/* onData over decoded text */
static void hub_feed_text(RlKeyHub *h, const char *text, size_t n) {
  U16 str = {0};
  u16_from_utf8(&str, text, n);
  if (str.n == 0) return;
  if (h->esc_timer) {
    scr_clear_interval(h->esc_timer);
    h->esc_timer = 0;
  }
  hub_completion(h, false);
  size_t length = 0;
  for (size_t i = 0; i < str.n;) {
    uint32_t cp = u16_cp_at(str.u, str.n, i);
    size_t len = cp >= 0x10000 ? 2 : 1;
    length += len;
    if (length == str.n) hub_completion(h, true);
    hub_decode(h, (int32_t)cp);
    if (scr_exc_pending()) {
      /* the generator restarts and the error propagates */
      hub_pend_clear(h);
      break;
    }
    if (length == str.n && cp == 0x1b) {
      ScrClosure *clo = scr_closure_new((void *)&hub_escape_timeout, 1);
      clo->caps[0] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(clo->caps[0], h->id);
      h->esc_timer = scr_set_timeout_handle(clo, h->escape_timeout);
    }
    i += len;
  }
  u16_free(&str);
}

static void hub_attach(RlKeyHub *h);

/* onData(input): with no 'keypress' listener the data listener leaves and
 * the hub waits for one again */
static void hub_on_data(RlKeyHub *h, const unsigned char *p, size_t n, ScrStr *str) {
  if (!h->data_on) return;
  if (hub_listener_count(h) == 0) {
    h->data_on = false;
    if (h->stream) {
      h->io->off_event(h->stream, "data", h->on_data);
      h->on_data = NULL;
      hub_attach(h);
    }
    return;
  }
  if (str) {
    hub_feed_text(h, str->data, str->len);
    return;
  }
  size_t total = h->n_held + n;
  unsigned char *all = malloc(total ? total : 1);
  if (!all) tty_oom();
  memcpy(all, h->held, h->n_held);
  memcpy(all + h->n_held, p, n);
  size_t tail = scr_rl_incomplete_tail(all, total);
  h->n_held = tail;
  memcpy(h->held, all + total - tail, tail);
  ScrStr *text = scr_str_from_utf8_lossy(all, total - tail);
  free(all);
  hub_feed_text(h, text->data, text->len);
  scr_str_release(text);
}

/* process.stdin is paused for the hub while a terminal interface reading
 * it is (Node pauses the stream itself) */
static bool hub_stdin_held(void) {
  for (size_t i = 0; i < rl_stdin_kp.n; i++) {
    if (rl_stdin_kp.v[i].cb) continue;
    ScrRl *rl = scr_rl_find(rl_stdin_kp.v[i].rl);
    if (rl && !rl->closed && rl->paused) return true;
  }
  return false;
}

static void hub_stdin_data(ScrClosure *cb, ScrBytes *chunk) {
  (void)cb;
  RlKeyHub *h = hub_of(NULL);
  if (!h || !h->data_on) return;
  size_t n = (size_t)chunk->len;
  char *p = malloc(n ? n : 1);
  if (!p) tty_oom();
  scr_bytes_read(chunk, 0, p, n);
  if (hub_stdin_held()) {
    if (h->parked_len + n > h->parked_cap) {
      h->parked_cap = (h->parked_len + n) * 2;
      h->parked = realloc(h->parked, h->parked_cap);
      if (!h->parked) tty_oom();
    }
    memcpy(h->parked + h->parked_len, p, n);
    h->parked_len += n;
  } else {
    hub_on_data(h, (const unsigned char *)p, n, NULL);
  }
  free(p);
}

static void hub_stream_data(ScrClosure *cb, void *bytes, void *str) {
  RlKeyHub *h = hub_by_id(scr_box_get_f64(cb->caps[0]));
  if (!h) return;
  if (str) {
    hub_on_data(h, NULL, 0, (ScrStr *)str);
    return;
  }
  ScrBytes *b = bytes;
  size_t n = (size_t)b->len;
  char *p = malloc(n ? n : 1);
  if (!p) tty_oom();
  scr_bytes_read(b, 0, p, n);
  hub_on_data(h, (const unsigned char *)p, n, NULL);
  free(p);
}

/* stream.on('data', onData) */
static void hub_data_on(RlKeyHub *h) {
  if (h->data_on) return;
  h->data_on = true;
  if (h->stream) {
    ScrClosure *c = scr_closure_new((void *)&hub_stream_data, 1);
    c->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(c->caps[0], h->id);
    h->on_data = c;
    h->io->on_event(h->stream, "data", c, 2);
  } else if (!rl_stdin_data_registered) {
    rl_stdin_data_registered = true;
    scr_stdin_on_data(scr_closure_new((void *)&hub_stdin_data, 0), &hub_stdin_data, false);
  }
}

/* onNewListener(event): the first 'keypress' listener attaches onData */
static void hub_stream_new_listener(ScrClosure *cb, void *name) {
  RlKeyHub *h = hub_by_id(scr_box_get_f64(cb->caps[0]));
  ScrStr *ev = name;
  if (!h || !ev || ev->len != 8 || memcmp(ev->data, "keypress", 8) != 0) return;
  ScrClosure *self = h->on_new;
  h->on_new = NULL;
  hub_data_on(h);
  if (self) h->io->off_event(h->stream, "newListener", self);
}

/* listenerCount('keypress') > 0 ? on('data') : on('newListener') */
static void hub_attach(RlKeyHub *h) {
  if (hub_listener_count(h) > 0) {
    hub_data_on(h);
  } else if (h->stream && !h->on_new) {
    ScrClosure *c = scr_closure_new((void *)&hub_stream_new_listener, 1);
    c->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(c->caps[0], h->id);
    h->on_new = c;
    h->io->on_event(h->stream, "newListener", c, 1);
  }
}

/* emitKeypressEvents(stream, iface): once per stream. stream NULL is
 * process.stdin (io NULL), else it is retained through io. iface is an
 * interface (0 for none); timeout is iface.escapeCodeTimeout when given
 * as a number (NaN: the interface's, or 500). */
void scr_rl_keypress_events(const ScrRlIo *io, void *stream, double iface, double timeout) {
  if (hub_of(stream)) return;
  hub_cleanup_register();
  RlKeyHub *h = calloc(1, sizeof *h);
  if (!h) tty_oom();
  h->id = rl_hub_next_id++;
  h->io = io;
  h->stream = stream ? io->retain(stream) : NULL;
  h->iface = iface;
  ScrRl *rl = iface ? scr_rl_find(iface) : NULL;
  h->escape_timeout = !isnan(timeout) ? timeout : rl ? rl->escape_timeout : 500;
  h->next = rl_hubs;
  rl_hubs = h;
  hub_attach(h);
}

/* process.stdin.on/once('keypress', listener): cb is the listener as a
 * checked-dynamic function (borrowed), called with (str, key) */
void scr_rl_stdin_on_keypress(ScrDyn *cb, bool once) {
  if (cb) scr_dyn_retain(cb);
  /* newListener: the hub attaches before the listener is added */
  hub_cleanup_register();
  RlKeyHub *h = hub_of(NULL);
  if (h) hub_data_on(h);
  kp_push(&rl_stdin_kp, cb, 0, once);
}

/* a terminal interface's onkeypress on a stream input */
static void hub_rl_listener(ScrClosure *cb, void *str, void *key) {
  ScrRl *rl = scr_rl_find(scr_box_get_f64(cb->caps[0]));
  if (!rl || !rl->tty || rl->closed) return;
  ScrDyn *sd = str, *kd = key;
  U16 s = {0};
  bool has_s = sd && sd->kind == SCR_DYN_STR;
  if (has_s) u16_from_utf8(&s, sd->v.str->data, sd->v.str->len);
  RlKey k = {0};
  char *nm = NULL;
  ScrDyn *v = kd ? scr_dyn_obj_get(kd, "name", 4) : NULL;
  if (v && v->kind == SCR_DYN_STR) {
    nm = malloc(v->v.str->len + 1);
    if (!nm) tty_oom();
    memcpy(nm, v->v.str->data, v->v.str->len);
    nm[v->v.str->len] = '\0';
    k.name = nm;
  }
  v = kd ? scr_dyn_obj_get(kd, "ctrl", 4) : NULL;
  k.ctrl = v && scr_dyn_truthy(v);
  v = kd ? scr_dyn_obj_get(kd, "meta", 4) : NULL;
  k.meta = v && scr_dyn_truthy(v);
  v = kd ? scr_dyn_obj_get(kd, "shift", 5) : NULL;
  k.shift = v && scr_dyn_truthy(v);
  v = kd ? scr_dyn_obj_get(kd, "sequence", 8) : NULL;
  if (v && v->kind == SCR_DYN_STR) {
    k.has_sequence = true;
    u16_from_utf8(&k.sequence, v->v.str->data, v->v.str->len);
  }
  tty_keypress(rl, has_s ? &s : NULL, &k);
  u16_free(&k.sequence);
  free(nm);
  u16_free(&s);
}

/* the interface's own onkeypress: emitKeypressEvents(input, this), then
 * input.on('keypress', onkeypress) */
static void hub_attach_interface(ScrRl *rl, const ScrRlIo *io, void *stream) {
  scr_rl_keypress_events(io, stream, rl->id, NAN);
  if (!stream) {
    scr_rl_stdin_on_keypress(NULL, false);
    rl_stdin_kp.v[rl_stdin_kp.n - 1].rl = rl->id;
    return;
  }
  ScrClosure *c = scr_closure_new((void *)&hub_rl_listener, 1);
  c->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(c->caps[0], rl->id);
  rl->tty->kp_listener = c;
  io->on_event(stream, "keypress", c, 2);
}

/* onSelfCloseWithTerminal: input.removeListener('keypress', onkeypress) */
static void hub_detach_interface(ScrRl *rl) {
  if (!rl->in) {
    RlKpList *l = &rl_stdin_kp;
    for (size_t i = 0; i < l->n; i++) {
      if (!l->v[i].cb && l->v[i].rl == rl->id) {
        memmove(l->v + i, l->v + i + 1, (l->n - i - 1) * sizeof *l->v);
        l->n--;
        break;
      }
    }
    return;
  }
  if (rl->tty->kp_listener) {
    rl->io->off_event(rl->in, "keypress", rl->tty->kp_listener);
    rl->tty->kp_listener = NULL;
  }
}

/* resume() of a terminal interface on process.stdin: parked keys flow */
static void tty_resumed(ScrRl *rl) {
  if (rl->in) return;
  RlKeyHub *h = hub_of(NULL);
  if (!h || h->parked_len == 0 || hub_stdin_held()) return;
  char *p = h->parked;
  size_t n = h->parked_len;
  h->parked = NULL;
  h->parked_len = h->parked_cap = 0;
  hub_on_data(h, (const unsigned char *)p, n, NULL);
  free(p);
}

/* The interface's own 'data' (scr_readline.c) is not a terminal's input:
 * keys arrive through the hub. */
static void tty_feed(ScrRl *rl, const char *text, size_t n) {
  (void)rl;
  (void)text;
  (void)n;
}

/* ontermend: a pending line is emitted as is, then close() */
static void tty_end(ScrRl *rl) {
  ScrRlTty *t = tty_of(rl);
  if (t->line.n > 0) {
    ScrStr *line = u16_to_str(t->line.u, t->line.n);
    scr_rl_emit(rl, RL_EV_LINE, line, NULL);
    scr_str_release(line);
    if (scr_exc_pending()) return;
  }
  scr_rl_settle_close(rl);
}

/* prompt(preserveCursor) */
static void tty_prompt(ScrRl *rl, bool preserve) {
  ScrRlTty *t = tty_of(rl);
  ScrStr *name = scr_str_new("TERM", 4);
  ScrStr *term = scr_env_get(name);
  scr_str_release(name);
  bool dumb = term && term->len == 4 && memcmp(term->data, "dumb", 4) == 0;
  if (term) scr_str_release(term);
  if (dumb) {
    if (scr_rl_prompt_writable(rl)) scr_rl_write_out(rl, rl->prompt);
    return;
  }
  if (!preserve) t->cursor = 0;
  tty_refresh(rl);
}

/* write(d): kTtyWrite(d) with no key */
static void tty_write_op(ScrRl *rl, ScrStr *data) {
  U16 s = {0};
  u16_from_utf8(&s, data->data, data->len);
  if (rl->tty->dumb) tty_write_dumb(rl, &s, NULL);
  else tty_write_key(rl, &s, NULL);
  u16_free(&s);
}

static void tty_closing(ScrRl *rl) {
  tty_set_raw(rl, false);
  hub_detach_interface(rl);
}

/* kQuestionCancel's clearLine() */
static void tty_clear_line_op(ScrRl *rl) { tty_clear_line(rl); }

static void tty_free(ScrRl *rl) {
  ScrRlTty *t = rl->tty;
  if (!t) return;
  u16_free(&t->line);
  u16_free(&t->sub);
  for (size_t i = 0; i < t->ring_n; i++) u16_free(&t->ring[i]);
  edits_clear(&t->undo);
  edits_clear(&t->redo);
  free(t->undo.v);
  free(t->redo.v);
  u16_free(&t->saved_line);
  if (t->completer) scr_dyn_release(t->completer);
  free(t);
  rl->tty = NULL;
}


/* rl.line */
static ScrStr *tty_line_op(ScrRl *rl) { return u16_to_str(rl->tty->line.u, rl->tty->line.n); }

static double tty_cursor_op(ScrRl *rl) { return (double)rl->tty->cursor; }

/* write(data, key) on an open terminal interface */
static void tty_write_key_op(ScrRl *rl, ScrStr *data, bool has_key, ScrStr *name, bool ctrl,
                             bool meta, bool shift) {
  U16 s = {0};
  if (data) u16_from_utf8(&s, data->data, data->len);
  RlKey key = {0};
  char *nm = NULL;
  if (name) {
    nm = malloc(name->len + 1);
    if (!nm) tty_oom();
    memcpy(nm, name->data, name->len);
    nm[name->len] = '\0';
    key.name = nm;
  }
  key.ctrl = ctrl;
  key.meta = meta;
  key.shift = shift;
  if (rl->tty->dumb) tty_write_dumb(rl, data ? &s : NULL, has_key ? &key : NULL);
  else tty_write_key(rl, data ? &s : NULL, has_key ? &key : NULL);
  free(nm);
  u16_free(&s);
}

/* getCursorPos(): which 0 rows, 1 cols. A non-terminal interface has no
 * cursor, so line.slice(0, undefined) is its whole (empty) line. */
double scr_rl_cursor_pos(double id, double which) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl) return 0;
  RlPos pos;
  if (rl->tty) {
    pos = tty_cursor_pos(rl);
  } else {
    if (rl->prompt_value && !scr_rl_primitive_prompt(rl->prompt_value)) {
      static const char m[] =
          "rl.getCursorPos() with a prompt that is an object or a symbol has no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, m, sizeof m - 1, "SC2020");
      return 0;
    }
    ScrRlTty probe = {0};
    probe.columns = INFINITY;
    rl->tty = &probe;
    U16 s = {0};
    u16_from_utf8(&s, rl->prompt->data, rl->prompt->len);
    pos = tty_display_pos(rl, s.u, s.n);
    u16_free(&s);
    rl->tty = NULL;
  }
  return which == 0 ? pos.rows : pos.cols;
}

static const ScrRlTtyOps TTY_OPS = {
    tty_feed,          tty_end,  tty_prompt,  tty_write_op,  tty_closing,
    tty_clear_line_op, tty_free, tty_line_op, tty_cursor_op, tty_write_key_op,
    tty_resumed,
};

/* ── entry points ──────────────────────────────────────────────────── */

/* The terminal half of createInterface: mode 0 takes `on` (the terminal
 * option), 2 is an absent option with process.stdout as the output
 * (output.isTTY). completer is borrowed (the undefined dyn when absent);
 * promises selects readline/promises, whose completer is awaited; inspect
 * is scr_insp_dyn when there is a completer. */
void scr_rl_terminal(double id, double mode, bool on, ScrDyn *completer, bool promises,
                     ScrRlInspectFn inspect) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->tty) return;
  if (mode == 2) {
    if (!scr_process_is_tty(1)) return;
  } else if (!on) {
    return;
  }
  ScrRlTty *t = calloc(1, sizeof *t);
  if (!t) tty_oom();
  rl->history_index = -1;
  t->prev_cursor_cols = -1;
  t->completion_enabled = true;
  t->promises = promises;
  t->inspect = inspect;
  t->columns = INFINITY;
  if (completer && completer->kind != SCR_DYN_UNDEF) {
    t->completer = scr_dyn_retain(completer);
    if (!promises) {
      ScrDyn *len = scr_dyn_fn_get(completer, "length", 6);
      t->completer_callback = len && len->kind == SCR_DYN_NUM && len->v.num == 2;
      if (len) scr_dyn_release(len);
    }
  }
  if (!promises) {
    ScrStr *name = scr_str_new("TERM", 4);
    ScrStr *term = scr_env_get(name);
    scr_str_release(name);
    t->dumb = term && term->len == 4 && memcmp(term->data, "dumb", 4) == 0;
    if (term) scr_str_release(term);
  }
  t->raw_stdin = rl->stdin_in && scr_process_is_tty(0);
  scr_rl_tty_ops = &TTY_OPS;
  rl->tty = t;
  /* emitKeypressEvents(input, this); input.on('keypress', onkeypress) */
  if (rl->in) rl->io->drop_data(rl->in, rl->id);
  hub_attach_interface(rl, rl->io, rl->in);
  tty_set_raw(rl, true);
}
