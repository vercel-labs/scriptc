/* util.inspect — the runtime half of the static rendering. The compiler
 * synthesizes one traversal helper per static type (lower-inspect.ts, the
 * deepStrictEqual precedent); THIS file owns everything the static type
 * cannot know: Node's exact scalar formatting (number -0, the
 * single→double→backtick quoting ladder with C0/C1/DEL/lone-surrogate
 * escapes, the 10000-char string cap and the per-line ` +` continuation
 * form), Buffer's <Buffer aa bb> hex form, and the LAYOUT engine — a
 * frame stack reproducing reduceToSingleString, isBelowBreakLength, and
 * groupArrayElements from Node v24's lib/internal/util/inspect.js for the
 * DEFAULT options (compact: 3, breakLength: 80, maxArrayLength: 100,
 * maxStringLength: 10000; non-default options fence in the frontend).
 *
 * Lengths follow Node exactly: the break-length math counts UTF-16 code
 * units (JS .length); the grid-grouping math counts DISPLAY WIDTH. Node
 * with ICU measures width via icu::getStringWidth over NFC-normalized
 * text; this file ports the non-ICU fallback tables (full-width/
 * zero-width code points, no NFC) — pure-ASCII entries agree exactly,
 * exotic grouped entries may not (SEMANTICS.md divergence).
 *
 * The frame stack is process-global (single-threaded runtime, and the
 * synthesized traversals never call user code — no getters, no custom
 * inspect — so renders never nest re-entrantly mid-frame).
 *
 * Ownership: ScrStr/ScrBytes/ScrDyn/ScrError arguments are BORROWED;
 * ScrStr results return +1. Nothing here throws; OOM aborts. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void insp_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* ── a tiny append-only byte buffer ──────────────────────────────────── */

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} InspBuf;

static void ib_grow(InspBuf *b, size_t need) {
  if (b->len + need <= b->cap) return;
  size_t cap = b->cap ? b->cap * 2 : 64;
  while (cap < b->len + need) cap *= 2;
  char *data = realloc(b->data, cap);
  if (!data) insp_oom();
  b->data = data;
  b->cap = cap;
}

static void ib_bytes(InspBuf *b, const char *s, size_t len) {
  ib_grow(b, len);
  memcpy(b->data + b->len, s, len);
  b->len += len;
}

static void ib_cstr(InspBuf *b, const char *s) { ib_bytes(b, s, strlen(s)); }
static void ib_char(InspBuf *b, char c) { ib_bytes(b, &c, 1); }
static void ib_str(InspBuf *b, const ScrStr *s) { ib_bytes(b, s->data, s->len); }

static void ib_spaces(InspBuf *b, size_t n) {
  ib_grow(b, n);
  memset(b->data + b->len, ' ', n);
  b->len += n;
}

static ScrStr *ib_take(InspBuf *b) {
  ScrStr *out = scr_str_new(b->data ? b->data : "", b->len);
  free(b->data);
  return out;
}

/* ── WTF-8 iteration + JS length/width measures ──────────────────────── */

/* Decode the code point at data[i] (WTF-8: lone surrogates ride 3-byte
 * ED A0..BF xx sequences). Malformed bytes decode as themselves — the
 * runtime never produces them, this is belt-and-braces. Advances *i. */
static uint32_t insp_cp_at(const char *data, size_t len, size_t *i) {
  const unsigned char *p = (const unsigned char *)data;
  unsigned char c = p[*i];
  if (c < 0x80) {
    *i += 1;
    return c;
  }
  if ((c & 0xe0) == 0xc0 && *i + 1 < len) {
    uint32_t cp = ((uint32_t)(c & 0x1f) << 6) | (p[*i + 1] & 0x3f);
    *i += 2;
    return cp;
  }
  if ((c & 0xf0) == 0xe0 && *i + 2 < len) {
    uint32_t cp = ((uint32_t)(c & 0x0f) << 12) | ((uint32_t)(p[*i + 1] & 0x3f) << 6) |
                  (p[*i + 2] & 0x3f);
    *i += 3;
    return cp;
  }
  if ((c & 0xf8) == 0xf0 && *i + 3 < len) {
    uint32_t cp = ((uint32_t)(c & 0x07) << 18) | ((uint32_t)(p[*i + 1] & 0x3f) << 12) |
                  ((uint32_t)(p[*i + 2] & 0x3f) << 6) | (p[*i + 3] & 0x3f);
    *i += 4;
    return cp;
  }
  *i += 1;
  return c;
}

/* JS .length: UTF-16 code units (astral code points count 2). */
static size_t insp_utf16_len(const char *data, size_t len) {
  size_t units = 0;
  for (size_t i = 0; i < len;) {
    uint32_t cp = insp_cp_at(data, len, &i);
    units += cp >= 0x10000 ? 2 : 1;
  }
  return units;
}

/* Node's non-ICU isFullWidthCodePoint table (inspect.js). */
static bool insp_full_width(uint32_t code) {
  return code >= 0x1100 &&
         (code <= 0x115f || code == 0x2329 || code == 0x232a ||
          (code >= 0x2e80 && code <= 0x3247 && code != 0x303f) ||
          (code >= 0x3250 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0xa4c6) ||
          (code >= 0xa960 && code <= 0xa97c) || (code >= 0xac00 && code <= 0xd7a3) ||
          (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) ||
          (code >= 0xfe30 && code <= 0xfe6b) || (code >= 0xff01 && code <= 0xff60) ||
          (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1b000 && code <= 0x1b001) ||
          (code >= 0x1f200 && code <= 0x1f251) || (code >= 0x1f300 && code <= 0x1f64f) ||
          (code >= 0x20000 && code <= 0x3fffd));
}

/* Node's non-ICU isZeroWidthCodePoint table (inspect.js). */
static bool insp_zero_width(uint32_t code) {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ||
         (code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) ||
         (code >= 0x20d0 && code <= 0x20ff) || (code >= 0xfe00 && code <= 0xfe0f) ||
         (code >= 0xfe20 && code <= 0xfe2f) || (code >= 0xe0100 && code <= 0xe01ef);
}

/* Display width (grouping math only): Node's non-ICU getStringWidth,
 * without the NFC normalization ICU builds apply (SEMANTICS.md). */
static size_t insp_width(const char *data, size_t len) {
  size_t width = 0;
  for (size_t i = 0; i < len;) {
    uint32_t cp = insp_cp_at(data, len, &i);
    if (insp_full_width(cp)) width += 2;
    else if (!insp_zero_width(cp)) width += 1;
  }
  return width;
}

/* ── number rendering ────────────────────────────────────────────────── */

/* formatNumber: JS ToString EXCEPT -0 renders as '-0'. */
ScrStr *scr_insp_f64(double x) {
  if (x == 0.0 && signbit(x)) return scr_str_new("-0", 2);
  char buf[40];
  size_t n = scr_f64_to_str(x, buf);
  return scr_str_new(buf, n);
}

/* ── string quoting (strEscape) ──────────────────────────────────────── */

/* The C0 escape table (inspect.js `meta`, entries 0x00-0x1f). */
static const char *const INSP_C0[32] = {
    "\\x00", "\\x01", "\\x02", "\\x03", "\\x04", "\\x05", "\\x06", "\\x07",
    "\\b",   "\\t",   "\\n",   "\\x0B", "\\f",   "\\r",   "\\x0E", "\\x0F",
    "\\x10", "\\x11", "\\x12", "\\x13", "\\x14", "\\x15", "\\x16", "\\x17",
    "\\x18", "\\x19", "\\x1A", "\\x1B", "\\x1C", "\\x1D", "\\x1E", "\\x1F",
};

static bool insp_contains_byte(const char *data, size_t len, char c) {
  return memchr(data, c, len) != NULL;
}

static bool insp_contains_dollar_brace(const char *data, size_t len) {
  for (size_t i = 0; i + 1 < len; i++) {
    if (data[i] == '$' && data[i + 1] == '{') return true;
  }
  return false;
}

/* Quote selection: single quotes; double when the text has ' but no ";
 * backtick when it has both but no ` and no ${. -1 = ", -2 = `, 39 = '. */
static int insp_pick_quote(const char *data, size_t len) {
  if (!insp_contains_byte(data, len, '\'')) return 39;
  if (!insp_contains_byte(data, len, '"')) return -1;
  if (!insp_contains_byte(data, len, '`') && !insp_contains_dollar_brace(data, len)) return -2;
  return 39;
}

static char insp_quote_char(int quote) { return quote == -1 ? '"' : quote == -2 ? '`' : '\''; }

/* strEscape's body between the quotes: escape backslash, C0 (the meta
 * table), DEL + C1 as \xNN (uppercase), lone surrogates as \udNNN
 * (lowercase — Number.prototype.toString(16)), and the single quote only
 * when quoting with '. */
static void insp_escape_into(InspBuf *b, const char *data, size_t len, int quote) {
  for (size_t i = 0; i < len;) {
    size_t start = i;
    uint32_t cp = insp_cp_at(data, len, &i);
    if (cp < 0x20) {
      ib_cstr(b, INSP_C0[cp]);
    } else if (cp == '\'' && quote == 39) {
      ib_cstr(b, "\\'");
    } else if (cp == '\\') {
      ib_cstr(b, "\\\\");
    } else if (cp >= 0x7f && cp <= 0x9f) {
      char esc[8];
      snprintf(esc, sizeof esc, "\\x%02X", cp);
      ib_cstr(b, esc);
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      char esc[8];
      snprintf(esc, sizeof esc, "\\u%x", cp);
      ib_cstr(b, esc);
    } else {
      ib_bytes(b, data + start, i - start);
    }
  }
}

static void insp_quote_into(InspBuf *b, const char *data, size_t len) {
  int quote = insp_pick_quote(data, len);
  ib_char(b, insp_quote_char(quote));
  insp_escape_into(b, data, len, quote);
  ib_char(b, insp_quote_char(quote));
}

/* ── the frame stack ─────────────────────────────────────────────────── */

typedef struct {
  ScrStr **items;
  size_t len;
  size_t cap;
  bool all_num; /* every entry so far flagged numeric (grouping order) */
} InspFrame;

static SCR_TL InspFrame *g_frames;
static SCR_TL size_t g_nframes;
static SCR_TL size_t g_frames_cap;
static SCR_TL size_t g_indent;       /* ctx.indentationLvl */
static SCR_TL bool g_no_break;       /* breakLength: Infinity (console.table cells) */
static SCR_TL double g_cur_depth;    /* ctx.currentDepth (last-entered composite) */

static InspFrame *insp_top(void) { return &g_frames[g_nframes - 1]; }

static void insp_circ_reset(void); /* circular-reference state, below */

/* Begin a non-empty composite: formatRaw's `recurseTimes += 1;
 * ctx.currentDepth = recurseTimes` plus the uniform +2 the children
 * format under. `recurse` is the CHILDREN's recursion depth. */
void scr_insp_begin(double recurse) {
  if (recurse == 1) insp_circ_reset(); /* a fresh top-level value: Node's per-inspect ctx */
  if (g_nframes == g_frames_cap) {
    g_frames_cap = g_frames_cap ? g_frames_cap * 2 : 8;
    g_frames = realloc(g_frames, g_frames_cap * sizeof(InspFrame));
    if (!g_frames) insp_oom();
  }
  InspFrame *f = &g_frames[g_nframes++];
  f->items = NULL;
  f->len = 0;
  f->cap = 0;
  f->all_num = true;
  g_cur_depth = recurse;
  g_indent += 2;
}

/* Append one already-rendered entry (borrowed; retained here). is_num
 * mirrors `typeof value[i] === 'number'` — it decides grid grouping's
 * padStart/padEnd order. */
void scr_insp_entry(ScrStr *s, bool is_num) {
  InspFrame *f = insp_top();
  if (f->len == f->cap) {
    f->cap = f->cap ? f->cap * 2 : 8;
    f->items = realloc(f->items, f->cap * sizeof(ScrStr *));
    if (!f->items) insp_oom();
  }
  f->items[f->len++] = scr_str_retain(s);
  if (!is_num) f->all_num = false;
}

/* ── circular references (Node's <ref *N> / [Circular *N]) ────────────
 * Recursive record/class types permit runtime reference cycles, and Node
 * renders them with formatValue's seen/circular machinery: a value
 * already ON the current traversal stack renders as `[Circular *N]` (N
 * assigned at first detection, in discovery order), and every rendering
 * of a so-numbered value gets the `<ref *N> ` prefix at its close. The
 * compiler-emitted helpers over CYCLE-CAPABLE composites drive exactly
 * that protocol: circ_check first (before the empty-literal and depth
 * answers — Node's order: a circular value beyond the depth budget still
 * says Circular), seen_push after begin, ref_wrap around end's result.
 * The circular MAP persists for one whole top-level inspect — begin(1)
 * is the per-value reset (a root composite's first frame). */
typedef struct {
  const void *ptr;
  int id; /* circular id (0 while only on the stack) */
} InspSeenEnt;

static SCR_TL InspSeenEnt *g_seen;
static SCR_TL size_t g_nseen;
static SCR_TL size_t g_seen_cap;
/* Detection-numbered circular targets (persist across the call). */
static SCR_TL const void *g_circ[64];
static SCR_TL int g_ncirc;

static void insp_circ_reset(void) {
  g_nseen = 0;
  g_ncirc = 0;
}

static int insp_circ_id(const void *v) {
  for (int i = 0; i < g_ncirc; i++) {
    if (g_circ[i] == v) return i + 1;
  }
  return 0;
}

double scr_insp_circ_check(const void *v) {
  for (size_t i = 0; i < g_nseen; i++) {
    if (g_seen[i].ptr != v) continue;
    int id = insp_circ_id(v);
    if (id == 0 && g_ncirc < (int)(sizeof g_circ / sizeof *g_circ)) {
      g_circ[g_ncirc++] = v;
      id = g_ncirc;
    }
    return (double)id;
  }
  return 0;
}

void scr_insp_seen_push(const void *v) {
  if (g_nseen == g_seen_cap) {
    g_seen_cap = g_seen_cap ? g_seen_cap * 2 : 8;
    g_seen = realloc(g_seen, g_seen_cap * sizeof(InspSeenEnt));
    if (!g_seen) insp_oom();
  }
  g_seen[g_nseen].ptr = v;
  g_seen[g_nseen].id = 0;
  g_nseen++;
}

ScrStr *scr_insp_circular(double id) {
  char buf[32];
  int n = snprintf(buf, sizeof buf, "[Circular *%.0f]", id);
  return scr_str_new(buf, (size_t)n);
}

ScrStr *scr_insp_ref_wrap(const void *v, ScrStr *s) {
  if (g_nseen > 0) g_nseen--;
  int id = insp_circ_id(v);
  if (id == 0) return scr_str_retain(s);
  char buf[32];
  int n = snprintf(buf, sizeof buf, "<ref *%d> ", id);
  ScrStr *out = scr_str_alloc_raw(s->len + (size_t)n, s->len + (size_t)n);
  memcpy(out->data, buf, (size_t)n);
  memcpy(out->data + n, s->data, s->len);
  out->data[out->len] = '\0';
  return out;
}

/* remainingText: the "... N more items" tail entry. */
ScrStr *scr_insp_more_items(double remaining) {
  char buf[64];
  int n = snprintf(buf, sizeof buf, "... %.0f more item%s", remaining, remaining > 1 ? "s" : "");
  return scr_str_new(buf, (size_t)n);
}

/* groupArrayElements: the grid layout for arrays with more than six
 * entries. Rewrites the frame's items in place when grouping applies. */
static void insp_group(InspFrame *f, bool trailing_more) {
  size_t output_len = f->len - (trailing_more ? 1 : 0);
  double total_length = 0;
  double max_length = 0;
  size_t *data_len = malloc((output_len ? output_len : 1) * sizeof(size_t));
  if (!data_len) insp_oom();
  for (size_t i = 0; i < output_len; i++) {
    size_t w = insp_width(f->items[i]->data, f->items[i]->len);
    data_len[i] = w;
    total_length += (double)w + 2;
    if ((double)w > max_length) max_length = (double)w;
  }
  double actual_max = max_length + 2;
  if (actual_max * 3 + (double)g_indent < 80 &&
      (total_length / actual_max > 5 || max_length <= 6)) {
    double approx_char_heights = 2.5;
    double average_bias = sqrt(actual_max - total_length / (double)f->len);
    double biased_max = fmax(actual_max - 3 - average_bias, 1);
    double columns_d = fmin(
        fmin(round(sqrt(approx_char_heights * biased_max * (double)output_len) / biased_max),
             floor((80 - (double)g_indent) / actual_max)),
        fmin(3 * 4 /* ctx.compact * 4 */, 15));
    if (columns_d <= 1) {
      free(data_len);
      return;
    }
    size_t columns = (size_t)columns_d;
    size_t *max_line_length = malloc(columns * sizeof(size_t));
    if (!max_line_length) insp_oom();
    for (size_t i = 0; i < columns; i++) {
      size_t line_max = 0;
      for (size_t j = i; j < output_len; j += columns) {
        if (data_len[j] > line_max) line_max = data_len[j];
      }
      max_line_length[i] = line_max + 2;
    }
    bool pad_start = f->all_num;
    ScrStr **tmp = NULL;
    size_t tmp_len = 0, tmp_cap = 0;
    for (size_t i = 0; i < output_len; i += columns) {
      size_t max = i + columns < output_len ? i + columns : output_len;
      InspBuf line = {0};
      size_t j = i;
      for (; j + 1 < max; j++) {
        size_t width = data_len[j];
        size_t target = max_line_length[j - i];
        if (pad_start) {
          if (target > width + 2) ib_spaces(&line, target - width - 2);
          ib_str(&line, f->items[j]);
          ib_cstr(&line, ", ");
        } else {
          ib_str(&line, f->items[j]);
          ib_cstr(&line, ", ");
          if (target > width + 2) ib_spaces(&line, target - width - 2);
        }
      }
      if (pad_start) {
        size_t width = data_len[j];
        size_t target = max_line_length[j - i] - 2;
        if (target > width) ib_spaces(&line, target - width);
        ib_str(&line, f->items[j]);
      } else {
        ib_str(&line, f->items[j]);
      }
      if (tmp_len == tmp_cap) {
        tmp_cap = tmp_cap ? tmp_cap * 2 : 8;
        tmp = realloc(tmp, tmp_cap * sizeof(ScrStr *));
        if (!tmp) insp_oom();
      }
      tmp[tmp_len++] = ib_take(&line);
    }
    if (trailing_more) {
      if (tmp_len == tmp_cap) {
        tmp_cap += 1;
        tmp = realloc(tmp, tmp_cap * sizeof(ScrStr *));
        if (!tmp) insp_oom();
      }
      tmp[tmp_len++] = scr_str_retain(f->items[f->len - 1]);
    }
    for (size_t i = 0; i < f->len; i++) scr_str_release(f->items[i]);
    free(f->items);
    f->items = tmp;
    f->len = tmp_len;
    f->cap = tmp_cap;
    free(max_line_length);
  }
  free(data_len);
}

/* isBelowBreakLength: UTF-16 lengths against breakLength 80. */
static bool insp_below_break_length(InspFrame *f, size_t start, const ScrStr *base) {
  size_t total = f->len + start;
  if (total + f->len > 80) return false;
  for (size_t i = 0; i < f->len; i++) {
    total += insp_utf16_len(f->items[i]->data, f->items[i]->len);
    if (total > 80) return false;
  }
  return base->len == 0 || !insp_contains_byte(base->data, base->len, '\n');
}

/* reduceToSingleString for the default options (compact: 3). Pops the
 * frame. base/b0/b1 are borrowed; +1 result. `recurse` is the frame's
 * recurseTimes (the children's depth); array_extras marks kArrayExtrasType
 * (grid grouping applies); trailing_more marks a "... N more items" tail
 * entry (excluded from the grid). */
ScrStr *scr_insp_end(ScrStr *base, ScrStr *b0, ScrStr *b1, double recurse, bool array_extras,
                     bool trailing_more) {
  InspFrame *f = insp_top();
  g_indent -= 2;
  size_t entries = f->len;
  if (array_extras && entries > 6) insp_group(f, trailing_more);
  InspBuf out = {0};
  if (g_cur_depth - recurse < 3 && entries == f->len) {
    size_t start = f->len + g_indent + insp_utf16_len(b0->data, b0->len) +
                   insp_utf16_len(base->data, base->len) + 10;
    if (insp_below_break_length(f, start, base)) {
      bool multiline = false;
      for (size_t i = 0; i < f->len && !multiline; i++) {
        multiline = insp_contains_byte(f->items[i]->data, f->items[i]->len, '\n');
      }
      if (!multiline) {
        if (base->len) {
          ib_str(&out, base);
          ib_char(&out, ' ');
        }
        ib_str(&out, b0);
        ib_char(&out, ' ');
        for (size_t i = 0; i < f->len; i++) {
          if (i) ib_cstr(&out, ", ");
          ib_str(&out, f->items[i]);
        }
        ib_char(&out, ' ');
        ib_str(&out, b1);
        goto done;
      }
    }
  }
  if (base->len) {
    ib_str(&out, base);
    ib_char(&out, ' ');
  }
  ib_str(&out, b0);
  for (size_t i = 0; i < f->len; i++) {
    ib_cstr(&out, i ? ",\n" : "\n");
    ib_spaces(&out, g_indent + 2);
    ib_str(&out, f->items[i]);
  }
  ib_char(&out, '\n');
  ib_spaces(&out, g_indent);
  ib_str(&out, b1);
done:;
  for (size_t i = 0; i < f->len; i++) scr_str_release(f->items[i]);
  free(f->items);
  g_nframes--;
  return ib_take(&out);
}

/* ── nested inspections ──────────────────────────────────────────────
 * A custom inspect that renders another value with util.inspect
 * (PerformanceEntry's `${constructor.name} ${inspect(this.toJSON(),
 * opts)}`): Node runs that inspect in a fresh context — indentation,
 * depth tracking and the circular bookkeeping start over — and the
 * caller re-indents the result's lines at its own level. nested_begin
 * sets the fresh context aside the caller's; nested_end restores the
 * caller's and answers `prefix inner` with every newline re-indented
 * (+1; both borrowed). */
typedef struct {
  size_t indent;
  double cur_depth;
  InspSeenEnt *seen;
  size_t nseen;
  size_t seen_cap;
  const void *circ[64];
  int ncirc;
} InspSaved;

static SCR_TL InspSaved *g_saved;
static SCR_TL size_t g_nsaved;
static SCR_TL size_t g_saved_cap;

void scr_insp_nested_begin(void) {
  if (g_nsaved == g_saved_cap) {
    g_saved_cap = g_saved_cap ? g_saved_cap * 2 : 4;
    g_saved = realloc(g_saved, g_saved_cap * sizeof(InspSaved));
    if (!g_saved) insp_oom();
  }
  InspSaved *sv = &g_saved[g_nsaved++];
  sv->indent = g_indent;
  sv->cur_depth = g_cur_depth;
  sv->seen = g_seen;
  sv->nseen = g_nseen;
  sv->seen_cap = g_seen_cap;
  memcpy(sv->circ, g_circ, sizeof g_circ);
  sv->ncirc = g_ncirc;
  g_indent = 0;
  g_cur_depth = 0;
  g_seen = NULL;
  g_nseen = g_seen_cap = 0;
  g_ncirc = 0;
}

ScrStr *scr_insp_nested_end(ScrStr *prefix, ScrStr *inner) {
  InspSaved *sv = &g_saved[--g_nsaved];
  free(g_seen);
  g_indent = sv->indent;
  g_cur_depth = sv->cur_depth;
  g_seen = sv->seen;
  g_nseen = sv->nseen;
  g_seen_cap = sv->seen_cap;
  memcpy(g_circ, sv->circ, sizeof g_circ);
  g_ncirc = sv->ncirc;
  InspBuf out = {0};
  ib_str(&out, prefix);
  ib_char(&out, ' ');
  for (size_t i = 0; i < inner->len; i++) {
    char c = inner->data[i];
    ib_char(&out, c);
    if (c == '\n') ib_spaces(&out, g_indent);
  }
  return ib_take(&out);
}

/* ── string values (formatPrimitive's string half) ───────────────────── */

/* Byte offset of UTF-16 unit `units` — when the boundary splits an astral
 * code point (JS slice splitting a surrogate pair), the left half keeps
 * the HIGH surrogate: *lone_high is set and the offset excludes the
 * 4-byte sequence. */
static size_t insp_utf16_offset(const char *data, size_t len, size_t units, bool *lone_high,
                                uint32_t *high_cp) {
  size_t count = 0;
  *lone_high = false;
  for (size_t i = 0; i < len;) {
    if (count == units) return i;
    size_t start = i;
    uint32_t cp = insp_cp_at(data, len, &i);
    size_t w = cp >= 0x10000 ? 2 : 1;
    if (count + w > units) {
      /* boundary splits this astral pair: keep its high surrogate */
      *lone_high = true;
      *high_cp = 0xd800 + ((cp - 0x10000) >> 10);
      return start;
    }
    count += w;
  }
  return len;
}

/* formatPrimitive over a string value under the default options:
 * maxStringLength 10000, then the per-line ` +` continuation when the
 * (truncated) text is longer than 16 chars AND breakLength(80) -
 * indentationLvl - 4, split after each newline; the trailer counts the
 * cut characters. Uses the CURRENT indentation. */
ScrStr *scr_insp_str(ScrStr *s) {
  InspBuf out = {0};
  const char *data = s->data;
  size_t byte_len = s->len;
  size_t units = insp_utf16_len(data, byte_len);
  char trailer[64] = "";
  char surrogate_tail[4];
  size_t surrogate_tail_len = 0;
  if (units > 10000) {
    size_t remaining = units - 10000;
    bool lone_high;
    uint32_t high_cp = 0;
    byte_len = insp_utf16_offset(data, byte_len, 10000, &lone_high, &high_cp);
    if (lone_high) {
      /* re-encode the kept high surrogate as WTF-8 */
      surrogate_tail[0] = (char)(0xe0 | (high_cp >> 12));
      surrogate_tail[1] = (char)(0x80 | ((high_cp >> 6) & 0x3f));
      surrogate_tail[2] = (char)(0x80 | (high_cp & 0x3f));
      surrogate_tail_len = 3;
    }
    snprintf(trailer, sizeof trailer, "... %zu more character%s", remaining,
             remaining > 1 ? "s" : "");
    units = 10000;
  }
  /* the (possibly truncated) value as one buffer */
  InspBuf val = {0};
  ib_bytes(&val, data, byte_len);
  if (surrogate_tail_len) ib_bytes(&val, surrogate_tail, surrogate_tail_len);
  size_t vlen = val.len;
  const char *v = val.data ? val.data : "";
  if (!g_no_break && units > 16 && units > 80 - g_indent - 4 && memchr(v, '\n', vlen) != NULL) {
    /* split after each newline; quote each chunk; join with ` +\n<indent+2>` */
    size_t chunk_start = 0;
    bool first = true;
    for (size_t i = 0; i <= vlen; i++) {
      bool at_end = i == vlen;
      if (at_end ? i > chunk_start : v[i] == '\n') {
        size_t end = at_end ? i : i + 1;
        if (!first) {
          ib_cstr(&out, " +\n");
          ib_spaces(&out, g_indent + 2);
        }
        insp_quote_into(&out, v + chunk_start, end - chunk_start);
        chunk_start = end;
        first = false;
      }
    }
  } else {
    insp_quote_into(&out, v, vlen);
  }
  if (trailer[0]) ib_cstr(&out, trailer);
  free(val.data);
  return ib_take(&out);
}

/* ── regex / Buffer / Error leaves ───────────────────────────────────── */

/* RegExp: `/source/flags` (RegExp.prototype.toString — regexes render
 * fully at any depth; our regexes never carry extra own properties). */
ScrStr *scr_insp_regex(ScrRegex *re) {
  InspBuf out = {0};
  ib_char(&out, '/');
  ib_bytes(&out, re->source->data, re->source->len);
  ib_char(&out, '/');
  ib_bytes(&out, re->flags->data, re->flags->len);
  return ib_take(&out);
}

/* Buffer: the custom-inspect hex form `<Buffer aa bb ...>`, capped at
 * INSPECT_MAX_BYTES (50); renders fully at any depth (custom inspection
 * runs before the depth check in Node). u8 element kind only (the
 * frontend fences the rest). */
ScrStr *scr_insp_buffer(ScrBytes *b) {
  SCR_BYTES_SNAPSHOT(b);
  InspBuf out = {0};
  ib_cstr(&out, "<Buffer ");
  size_t max = b->len < 50 ? b->len : 50;
  for (size_t i = 0; i < max; i++) {
    char hex[4];
    snprintf(hex, sizeof hex, "%02x", ((const unsigned char *)b->data)[i]);
    if (i) ib_char(&out, ' ');
    ib_bytes(&out, hex, 2);
  }
  if (b->len > 50) {
    char more[48];
    size_t remaining = b->len - 50;
    int n = snprintf(more, sizeof more, " ... %zu more byte%s", remaining,
                     remaining > 1 ? "s" : "");
    ib_bytes(&out, more, (size_t)n);
  }
  ib_char(&out, '>');
  return ib_take(&out);
}

/* ArrayBuffer/SharedArrayBuffer: formatArrayBuffer's
 * `[Uint8Contents]: <hex pairs>` (the first maxArrayLength = 100 bytes,
 * then ` ... N more byte(s)`) followed by the byteLength key, inside the
 * class braces. `[ArrayBuffer]` beyond depth. */
static ScrStr *scr_insp_array_buffer(const ScrBytes *h, const char *cls, double recurse,
                                     double depth) {
  if (recurse > depth) {
    InspBuf out = {0};
    ib_char(&out, '[');
    ib_cstr(&out, cls);
    ib_char(&out, ']');
    return ib_take(&out);
  }
  size_t len = (size_t)scr_bytes_byte_len(h);
  size_t shown = len < 100 ? len : 100;
  uint8_t head[100];
  if (shown) scr_bytes_read(h, 0, head, shown);
  static const char hex[] = "0123456789abcdef";
  InspBuf contents = {0};
  ib_cstr(&contents, "[Uint8Contents]: <");
  for (size_t i = 0; i < shown; i++) {
    if (i) ib_char(&contents, ' ');
    ib_char(&contents, hex[head[i] >> 4]);
    ib_char(&contents, hex[head[i] & 15]);
  }
  if (len > shown) {
    char more[64];
    size_t remaining = len - shown;
    int n = snprintf(more, sizeof more, " ... %zu more byte%s", remaining, remaining > 1 ? "s" : "");
    ib_bytes(&contents, more, (size_t)n);
  }
  ib_char(&contents, '>');
  char byte_length[48];
  int bn = snprintf(byte_length, sizeof byte_length, "[byteLength]: %zu", len);
  scr_insp_begin(recurse + 1);
  ScrStr *entry = ib_take(&contents);
  scr_insp_entry(entry, false);
  scr_str_release(entry);
  entry = scr_str_new(byte_length, (size_t)bn);
  scr_insp_entry(entry, false);
  scr_str_release(entry);
  InspBuf open = {0};
  ib_cstr(&open, cls);
  ib_cstr(&open, " {");
  ScrStr *base = scr_str_new("", 0);
  ScrStr *b0 = ib_take(&open);
  ScrStr *b1 = scr_str_new("}", 1);
  ScrStr *out = scr_insp_end(base, b0, b1, recurse + 1, false, false);
  scr_str_release(base);
  scr_str_release(b0);
  scr_str_release(b1);
  return out;
}

/* Errors: the STACKLESS rendering — compiled binaries carry no stack, so
 * the base is formatError's bracket form `[Name: message]` / `[Name]`
 * (Node prints these exact forms for an error whose stack is empty;
 * stack-carrying Node output is a documented divergence). A stamped
 * `code` slot renders as the one extra own property Node would show:
 * `[Error: m] { code: 'X' }`, `[Error]` beyond depth. Message newlines
 * indent like Node's formatError tail. */
ScrStr *scr_insp_error(ScrError *e, double recurse, double depth) {
  bool has_code = e->code != NULL; /* the stamped slot, read directly (borrowed) */
  if (has_code && recurse > depth) {
    /* `[${getCtxStyle(...)}]` with the trailing space sliced: [Name] */
    InspBuf out = {0};
    ib_char(&out, '[');
    ib_str(&out, e->name);
    ib_char(&out, ']');
    return ib_take(&out);
  }
  InspBuf base = {0};
  ib_char(&base, '[');
  ib_str(&base, e->name);
  if (e->message->len) {
    ib_cstr(&base, ": ");
    /* indent embedded newlines by the CURRENT level (formatError's
     * final replaceAll — g_indent is the property's own level here). */
    for (size_t i = 0; i < e->message->len; i++) {
      char c = e->message->data[i];
      ib_char(&base, c);
      if (c == '\n') ib_spaces(&base, g_indent);
    }
  }
  ib_char(&base, ']');
  ScrStr *base_str = ib_take(&base);
  if (!has_code) return base_str;
  scr_insp_begin(recurse + 1);
  {
    InspBuf entry = {0};
    ib_cstr(&entry, "code: ");
    insp_quote_into(&entry, e->code->data, e->code->len);
    ScrStr *entry_str = ib_take(&entry);
    scr_insp_entry(entry_str, false);
    scr_str_release(entry_str);
  }
  ScrStr *b0 = scr_str_new("{", 1);
  ScrStr *b1 = scr_str_new("}", 1);
  ScrStr *out = scr_insp_end(base_str, b0, b1, recurse + 1, false, false);
  scr_str_release(b0);
  scr_str_release(b1);
  scr_str_release(base_str);
  return out;
}

/* ── dyn values (the checked-dynamic JSON dyn) ───────────────────────── */

/* Property-name rendering: bare when the key matches Node's keyStrRegExp
 * (/^[a-zA-Z_][a-zA-Z_0-9]*$/, '__proto__' excepted), quoted otherwise. */
static void insp_key_into(InspBuf *b, const char *key, size_t len) {
  if (len == 9 && memcmp(key, "__proto__", 9) == 0) {
    ib_cstr(b, "['__proto__']");
    return;
  }
  bool bare = len > 0;
  for (size_t i = 0; bare && i < len; i++) {
    char c = key[i];
    bool head_ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
    bool tail_ok = head_ok || (c >= '0' && c <= '9');
    bare = i == 0 ? head_ok : tail_ok;
  }
  if (bare) {
    ib_bytes(b, key, len);
  } else {
    insp_quote_into(b, key, len);
  }
}

/* Property-name rendering for the synthesized index-signature record
 * helpers (their keys are runtime strings, so the bare-or-quoted ladder
 * must run here): insp_key_into over a ScrStr. Borrows; result +1. */
ScrStr *scr_insp_key(ScrStr *k) {
  InspBuf b = {0};
  insp_key_into(&b, k->data, k->len);
  return ib_take(&b);
}

/* The full inspect over a dyn tree — the one runtime type whose SHAPE
 * lives in the value, so the traversal lives here instead of a
 * synthesized helper. Same engine, same defaults. dyn-boxed bytes render
 * in the checked-dynamic tree's documented Uint8Array identity (SEMANTICS.md). */
/* An encoded Error's string slot: own first, then its prototype (an
 * inherited name/message lives there), else NULL. Borrowed. */
static const ScrDyn *insp_error_slot(const ScrDyn *d, const char *key, size_t len) {
  const ScrDyn *v = scr_dyn_obj_get(d, key, len);
  if (v == NULL && d->prototype != NULL && d->prototype->kind == SCR_DYN_OBJ)
    v = scr_dyn_obj_get(d->prototype, key, len);
  return v != NULL && v->kind == SCR_DYN_STR ? v : NULL;
}

/* The checked-dynamic Error encoding (scr_error_dyn_fields) rendered like
 * scr_insp_error: the stackless bracket form `[Name: message]`, then the
 * remaining enumerable own properties (code, errno, syscall, ...) in
 * Node's `{ ... }` tail. */
static ScrStr *scr_insp_dyn_error(ScrDyn *d, double recurse, double depth) {
  const ScrDyn *name = insp_error_slot(d, "name", 4);
  const ScrDyn *message = insp_error_slot(d, "message", 7);
  size_t extra = 0;
  for (size_t i = 0; i < d->v.obj.len; i++) {
    ScrDynEntry *ent = &d->v.obj.entries[i];
    if (!ent->enumerable) continue;
    if ((ent->key_len == 4 && memcmp(ent->key, "name", 4) == 0) ||
        (ent->key_len == 7 && memcmp(ent->key, "message", 7) == 0) ||
        (ent->key_len == 5 && memcmp(ent->key, "stack", 5) == 0))
      continue;
    extra++;
  }
  InspBuf base = {0};
  ib_char(&base, '[');
  if (name != NULL) ib_str(&base, name->v.str);
  else ib_cstr(&base, "Error");
  if (extra > 0 && recurse > depth) {
    ib_char(&base, ']');
    return ib_take(&base);
  }
  if (message != NULL && message->v.str->len) {
    ib_cstr(&base, ": ");
    for (size_t i = 0; i < message->v.str->len; i++) {
      char c = message->v.str->data[i];
      ib_char(&base, c);
      if (c == '\n') ib_spaces(&base, g_indent);
    }
  }
  ib_char(&base, ']');
  ScrStr *base_str = ib_take(&base);
  if (extra == 0) return base_str;
  scr_insp_begin(recurse + 1);
  for (size_t i = 0; i < d->v.obj.len; i++) {
    ScrDynEntry *ent = &d->v.obj.entries[i];
    if (!ent->enumerable) continue;
    if ((ent->key_len == 4 && memcmp(ent->key, "name", 4) == 0) ||
        (ent->key_len == 7 && memcmp(ent->key, "message", 7) == 0) ||
        (ent->key_len == 5 && memcmp(ent->key, "stack", 5) == 0))
      continue;
    ScrStr *val = scr_insp_dyn(ent->value, recurse + 1, depth);
    InspBuf eb = {0};
    insp_key_into(&eb, ent->key, ent->key_len);
    ib_cstr(&eb, ": ");
    ib_bytes(&eb, val->data, val->len);
    scr_str_release(val);
    ScrStr *entry = ib_take(&eb);
    scr_insp_entry(entry, false);
    scr_str_release(entry);
  }
  ScrStr *b0 = scr_str_new("{", 1);
  ScrStr *b1 = scr_str_new("}", 1);
  ScrStr *out = scr_insp_end(base_str, b0, b1, recurse + 1, false, false);
  scr_str_release(b0);
  scr_str_release(b1);
  scr_str_release(base_str);
  return out;
}

/* A class instance's name forms: "Name {}" for an empty instance, "[Name]"
 * past the depth limit (tail NULL). */
static ScrStr *scr_insp_class_tag(const char *cls, const char *tail, bool null_proto) {
  InspBuf out = {0};
  if (!tail || null_proto) ib_char(&out, '[');
  ib_cstr(&out, cls ? cls : "Object");
  if (null_proto) ib_cstr(&out, ": null prototype");
  if (!tail || null_proto) ib_char(&out, ']');
  if (tail) ib_cstr(&out, tail);
  return ib_take(&out);
}

/* A native Set or Map held as a checked-dynamic value: `Set(n) { a, b }`,
 * `Map(n) { k => v }`, at most 100 entries like Node's maxArrayLength. */
static ScrStr *scr_insp_dyn_collection(ScrDyn *d, double recurse, double depth, bool is_map) {
  ScrMap *map = d->v.handle.ptr;
  const char *label = is_map ? "Map" : "Set";
  size_t size = 0;
  for (double i = 0; i < scr_map_iter_count(map); i++)
    if (scr_map_iter_live(map, i)) size++;
  InspBuf head = {0};
  ib_cstr(&head, label);
  char count[32];
  snprintf(count, sizeof count, "(%zu)", size);
  ib_cstr(&head, count);
  if (size == 0) {
    ib_cstr(&head, " {}");
    return ib_take(&head);
  }
  if (recurse > depth) {
    scr_str_release(ib_take(&head));
    InspBuf out = {0};
    ib_char(&out, '[');
    ib_cstr(&out, label);
    ib_char(&out, ']');
    return ib_take(&out);
  }
  ScrStr *base = ib_take(&head);
  scr_insp_begin(recurse + 1);
  scr_map_iter_enter(map);
  size_t shown = 0;
  for (double i = 0; i < scr_map_iter_count(map) && shown < 100; i++) {
    if (!scr_map_iter_live(map, i)) continue;
    shown++;
    ScrDyn *key = scr_map_dyn_key(map, i);
    ScrStr *k = scr_insp_dyn(key, recurse + 1, depth);
    scr_dyn_release(key);
    if (!is_map) {
      scr_insp_entry(k, false);
      scr_str_release(k);
      continue;
    }
    ScrDyn *value = scr_map_dyn_value(map, i);
    ScrStr *v = scr_insp_dyn(value, recurse + 1, depth);
    scr_dyn_release(value);
    InspBuf eb = {0};
    ib_bytes(&eb, k->data, k->len);
    ib_cstr(&eb, " => ");
    ib_bytes(&eb, v->data, v->len);
    scr_str_release(k);
    scr_str_release(v);
    ScrStr *entry = ib_take(&eb);
    scr_insp_entry(entry, false);
    scr_str_release(entry);
  }
  scr_map_iter_exit(map);
  if (size > shown) {
    ScrStr *more = scr_insp_more_items((double)(size - shown));
    scr_insp_entry(more, false);
    scr_str_release(more);
  }
  ScrStr *b0 = scr_str_new("{", 1);
  ScrStr *b1 = scr_str_new("}", 1);
  ScrStr *out = scr_insp_end(base, b0, b1, recurse + 1, false, false);
  scr_str_release(base);
  scr_str_release(b0);
  scr_str_release(b1);
  return out;
}

/* An own enumerable symbol-keyed property of `d` (borrowed), or NULL. */
static ScrDynEntry *scr_insp_symbol_entry(ScrDyn *d, size_t i) {
  ScrDynEntry *ent = scr_dyn_own_symbol_entry(d, d->symbol_keys->v.arr.items[i]);
  return ent && ent->enumerable ? ent : NULL;
}

/* An ordinary object: `Name { key: value }` with its constructor name
 * `cls` (NULL for a plain object). Node's default view lists the own
 * enumerable string keys, then the own enumerable symbol keys. */
static ScrStr *scr_insp_obj(ScrDyn *d, double recurse, double depth, const char *cls, const void *identity) {
  double circular = scr_insp_circ_check(identity);
  if (circular) return scr_insp_circular(circular);
  size_t shown = 0;
  for (size_t i = 0; i < d->v.obj.len; i++) shown += d->v.obj.entries[i].enumerable;
  size_t nsymbols = d->symbol_keys ? d->symbol_keys->v.arr.len : 0;
  for (size_t i = 0; i < nsymbols; i++) shown += scr_insp_symbol_entry(d, i) != NULL;
  if (shown == 0) {
    return cls || d->null_proto ? scr_insp_class_tag(cls, " {}", d->null_proto)
                               : scr_str_new("{}", 2);
  }
  if (recurse > depth) {
    return scr_insp_class_tag(cls, NULL, d->null_proto);
  }
  scr_insp_begin(recurse + 1);
  scr_insp_seen_push(identity);
  for (size_t i = 0; i < d->v.obj.len; i++) {
    ScrDynEntry *ent = &d->v.obj.entries[i];
    if (!ent->enumerable) continue;
    ScrStr *val = scr_insp_dyn(ent->value, recurse + 1, depth);
    InspBuf eb = {0};
    insp_key_into(&eb, ent->key, ent->key_len);
    ib_cstr(&eb, ": ");
    ib_bytes(&eb, val->data, val->len);
    scr_str_release(val);
    ScrStr *entry = ib_take(&eb);
    scr_insp_entry(entry, false);
    scr_str_release(entry);
  }
  for (size_t i = 0; i < nsymbols; i++) {
    ScrDynEntry *ent = scr_insp_symbol_entry(d, i);
    if (!ent) continue;
    ScrStr *key = scr_insp_dyn(d->symbol_keys->v.arr.items[i], recurse + 1, depth);
    ScrStr *val = scr_insp_dyn(ent->value, recurse + 1, depth);
    InspBuf eb = {0};
    ib_bytes(&eb, key->data, key->len);
    ib_cstr(&eb, ": ");
    ib_bytes(&eb, val->data, val->len);
    scr_str_release(key);
    scr_str_release(val);
    ScrStr *entry = ib_take(&eb);
    scr_insp_entry(entry, false);
    scr_str_release(entry);
  }
  ScrStr *base = cls || d->null_proto ? scr_insp_class_tag(cls, "", d->null_proto)
                                    : scr_str_new("", 0);
  ScrStr *b0 = scr_str_new("{", 1);
  ScrStr *b1 = scr_str_new("}", 1);
  ScrStr *out = scr_insp_end(base, b0, b1, recurse + 1, false, false);
  scr_str_release(base);
  scr_str_release(b0);
  scr_str_release(b1);
  ScrStr *wrapped = scr_insp_ref_wrap(identity, out);
  scr_str_release(out);
  return wrapped;
}

static ScrStr *scr_insp_arr(ScrDyn *d, double recurse, double depth, const void *identity) {
  double circular = scr_insp_circ_check(identity);
  if (circular) return scr_insp_circular(circular);
  if (d->v.arr.len == 0) return scr_str_new("[]", 2);
  if (recurse > depth) return scr_str_new("[Array]", 7);
  scr_insp_begin(recurse + 1);
  scr_insp_seen_push(identity);
  size_t shown = d->v.arr.len < 100 ? d->v.arr.len : 100;
  for (size_t i = 0; i < shown; i++) {
    ScrDyn *item = d->v.arr.items[i];
    ScrStr *s = scr_insp_dyn(item, recurse + 1, depth);
    scr_insp_entry(s, item->kind == SCR_DYN_NUM);
    scr_str_release(s);
  }
  bool more = d->v.arr.len > 100;
  if (more) {
    ScrStr *m = scr_insp_more_items((double)(d->v.arr.len - 100));
    scr_insp_entry(m, d->v.arr.items[100]->kind == SCR_DYN_NUM);
    scr_str_release(m);
  }
  ScrStr *base = scr_str_new("", 0);
  ScrStr *b0 = scr_str_new("[", 1);
  ScrStr *b1 = scr_str_new("]", 1);
  ScrStr *out = scr_insp_end(base, b0, b1, recurse + 1, true, more);
  scr_str_release(base);
  scr_str_release(b0);
  scr_str_release(b1);
  ScrStr *wrapped = scr_insp_ref_wrap(identity, out);
  scr_str_release(out);
  return wrapped;
}

ScrStr *scr_insp_dyn(ScrDyn *d, double recurse, double depth) {
  if (d->kind == SCR_DYN_PROXY) return scr_insp_dyn(d->v.proxy.target, recurse, depth);
  switch (d->kind) {
    case SCR_DYN_NULL:
      return scr_str_new("null", 4);
    case SCR_DYN_UNDEF:
      return scr_str_new("undefined", 9);
    case SCR_DYN_BOOL:
      return d->v.b ? scr_str_new("true", 4) : scr_str_new("false", 5);
    case SCR_DYN_BIGINT:
      return scr_bigint_inspect(d->v.bigint);
    case SCR_DYN_SYMBOL:
      return d->v.symbol.render(d->v.symbol.value);
    case SCR_DYN_NUM:
      return scr_insp_f64(d->v.num);
    case SCR_DYN_STR:
      return scr_insp_str(d->v.str);
    case SCR_DYN_ARR:
      return scr_insp_arr(d, recurse, depth, d);
    case SCR_DYN_OBJ: {
      /* An Error carried as a checked-dynamic value (a caught error, an
       * Error stored in an `unknown` slot): the error's own rendering,
       * never the encoding's internal marker. */
      if (scr_dyn_obj_get(d, "%error", 6) != NULL) return scr_insp_dyn_error(d, recurse, depth);
      /* Object.create(null)'s dictionary: Node prefixes the rendering
       * with "[Object: null prototype]" (formatValue's constructor-less
       * base), the empty form included, and the beyond-depth answer IS
       * the bare marker (where a plain object says [Object]). */
      return scr_insp_obj(d, recurse, depth, scr_dyn_class_name(d),
                          d->v.obj.source_identity ? d->v.obj.source_identity : d);
    }
    case SCR_DYN_FUNC: {
      /* Node's function rendering: [Function: name] / [Function
       * (anonymous)]. The boxed name is the compiler's best-effort static
       * spelling (SEMANTICS.md — reference-site naming). */
      const char *name = d->v.fn.name;
      InspBuf out = {0};
      if (name && name[0]) {
        ib_cstr(&out, "[Function: ");
        ib_cstr(&out, name);
        ib_char(&out, ']');
      } else {
        ib_cstr(&out, "[Function (anonymous)]");
      }
      return ib_take(&out);
    }
    case SCR_DYN_HANDLE: {
      if (d->v.handle.tag == SCR_DYNH_ARRAY_BUFFER ||
          d->v.handle.tag == SCR_DYNH_SHARED_ARRAY_BUFFER) {
        return scr_insp_array_buffer(d->v.handle.ptr, scr_dyn_handle_cls(d), recurse, depth);
      }
      if (d->v.handle.tag == SCR_DYNH_SET || d->v.handle.tag == SCR_DYNH_MAP)
        return scr_insp_dyn_collection(d, recurse, depth, d->v.handle.tag == SCR_DYNH_MAP);
      const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(d);
      if (ops->inspect_view) {
        /* Node's custom inspectors answer the bare class name beyond the
         * depth limit (`depth < 0`); the ones that return `this` there
         * print util.inspect's `[cls]`. */
        if (recurse > depth && !ops->inspect_view_empty) {
          if (!ops->inspect_bracketed_past_depth) return scr_str_new(ops->cls, strlen(ops->cls));
          InspBuf out = {0};
          ib_char(&out, '[');
          ib_cstr(&out, ops->cls);
          ib_char(&out, ']');
          return ib_take(&out);
        }
        ScrDyn *view = ops->inspect_view(d->v.handle.ptr);
        ScrStr *body = scr_insp_dyn(view, recurse, depth);
        scr_dyn_release(view);
        InspBuf out = {0};
        ib_cstr(&out, ops->cls);
        if (ops->to_string_tag) {
          ib_cstr(&out, " [");
          ib_cstr(&out, ops->to_string_tag);
          ib_char(&out, ']');
        }
        ib_char(&out, ' ');
        ib_bytes(&out, body->data, body->len);
        scr_str_release(body);
        return ib_take(&out);
      }
      /* Node prints the class's full property dump (ServerResponse {
       * ... }) — internals we do not model. Throw the 'not supported yet'
       * Error instead of printing a wrong shape (SEMANTICS.md). */
      InspBuf out = {0};
      ib_cstr(&out, "util.inspect of a dynamic ");
      ib_cstr(&out, scr_dyn_handle_cls(d));
      ib_cstr(&out, " is not supported yet");
      scr_throw_error(SCR_ERR_ERROR, ib_take(&out));
      return scr_str_new("", 0);
    }

    case SCR_DYN_TYPED_REF: {
      /* Detect native aliases before refresh can replace an outer inspector
       * frame's borrowed entries. The snapshot and capsule are one node. */
      const void *identity = d->v.typed_ref.ptr;
      double circular = scr_insp_circ_check(identity);
      if (circular) return scr_insp_circular(circular);
      const char *cls = NULL;
      ScrDyn *view = scr_event_ref_hooks ? scr_event_ref_hooks->inspect_view(d, &cls) : NULL;
      if (view) {
        /* The handle rule above: the class name past the depth limit. */
        if (recurse > depth) {
          scr_dyn_release(view);
          return scr_str_new(cls, strlen(cls));
        }
        ScrStr *body = scr_insp_dyn(view, recurse, depth);
        scr_dyn_release(view);
        InspBuf out = {0};
        ib_cstr(&out, cls);
        ib_char(&out, ' ');
        ib_bytes(&out, body->data, body->len);
        scr_str_release(body);
        return ib_take(&out);
      }
      ScrDyn *materialized = scr_dyn_typed_ref_materialize(d);
      /* A class instance prints with its class's name, which the checked
       * view of its fields does not carry. */
      const char *name = scr_dyn_typed_ref_class_name(d);
      ScrStr *out;
      if (name && materialized->kind == SCR_DYN_OBJ &&
          scr_dyn_obj_get(materialized, "%error", 6) == NULL) {
        out = scr_insp_obj(materialized, recurse, depth, name, identity);
      } else if (materialized->kind == SCR_DYN_OBJ &&
                 scr_dyn_obj_get(materialized, "%error", 6) == NULL) {
        out = scr_insp_obj(materialized, recurse, depth, scr_dyn_class_name(materialized), identity);
      } else if (materialized->kind == SCR_DYN_ARR) {
        out = scr_insp_arr(materialized, recurse, depth, identity);
      } else {
        out = scr_insp_dyn(materialized, recurse, depth);
      }
      scr_dyn_release(materialized);
      return out;
    }
    case SCR_DYN_PROMISE: {
      /* Node renders Promise { <pending> } / Promise { value } — the
       * settled-value rendering pulls in the whole inspector; throw
       * the 'not supported yet' Error instead of printing a wrong shape (the
       * handle stance). */
      InspBuf out = {0};
      ib_cstr(&out, "util.inspect of a promise value is not supported yet");
      scr_throw_error(SCR_ERR_ERROR, ib_take(&out));
      return scr_str_new("", 0);
    }
    case SCR_DYN_BYTES: {
      ScrBytes *b = d->v.bytes;
      if (d->buffer) {
        /* Buffer-flavored (a stream chunk): Node's <Buffer ..> form. */
        return scr_insp_buffer(b);
      }
      char prefix[48];
      int pn = snprintf(prefix, sizeof prefix, "%s(%zu) [", scr_bytes_elem_name(b->elem), b->len);
      if (b->len == 0) {
        InspBuf out = {0};
        ib_bytes(&out, prefix, (size_t)pn);
        ib_char(&out, ']');
        return ib_take(&out);
      }
      if (recurse > depth) {
        char tag[32];
        int n = snprintf(tag, sizeof tag, "[%s]", scr_bytes_elem_name(b->elem));
        return scr_str_new(tag, (size_t)n);
      }
      scr_insp_begin(recurse + 1);
      size_t shown = b->len < 100 ? b->len : 100;
      for (size_t i = 0; i < shown; i++) {
        ScrStr *s = scr_insp_f64(scr_bytes_get(b, (double)i));
        scr_insp_entry(s, true);
        scr_str_release(s);
      }
      bool more = b->len > 100;
      if (more) {
        ScrStr *m = scr_insp_more_items((double)(b->len - 100));
        scr_insp_entry(m, true);
        scr_str_release(m);
      }
      ScrStr *base = scr_str_new("", 0);
      ScrStr *b0 = scr_str_new(prefix, (size_t)pn);
      ScrStr *b1 = scr_str_new("]", 1);
      ScrStr *out = scr_insp_end(base, b0, b1, recurse + 1, true, more);
      scr_str_release(base);
      scr_str_release(b0);
      scr_str_release(b1);
      return out;
    }
  }
  return scr_str_new("undefined", 9); /* unreachable */
}

/* util.format's %s over a dyn value: strings pass VERBATIM (Node's
 * `typeof arg === 'string' ? arg : inspect(arg)` — the %s depth is 0,
 * the rest-args depth 2); everything else inspects at the given depth. */
ScrStr *scr_insp_dyn_s(ScrDyn *d, double depth) {
  if (d->kind == SCR_DYN_STR) return scr_str_retain(d->v.str);
  return scr_insp_dyn(d, 0, depth);
}

/* ── console.table cells ─────────────────────────────────────────────── */

size_t scr_insp_display_width(const char *data, size_t len) { return insp_width(data, len); }

static void insp_cell_join(InspBuf *b, ScrStr **items, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (i) ib_cstr(b, ", ");
    ib_str(b, items[i]);
    scr_str_release(items[i]);
  }
}

static ScrStr *insp_table_cell(ScrDyn *v) {
  switch (v->kind) {
    case SCR_DYN_PROXY:
      return insp_table_cell(v->v.proxy.target);
    case SCR_DYN_TYPED_REF: {
      ScrDyn *materialized = scr_dyn_typed_ref_materialize(v);
      ScrStr *out = insp_table_cell(materialized);
      scr_dyn_release(materialized);
      return out;
    }
    case SCR_DYN_OBJ: {
      if (scr_dyn_obj_get(v, "%error", 6) != NULL) {
        static const char message[] = "console.table cells holding Error values have no lowering";
        scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
        return scr_str_new("", 0);
      }
      const char *base = v->null_proto ? "[Object: null prototype]" : "Object";
      size_t n = 0;
      for (size_t i = 0; i < v->v.obj.len; i++) {
        ScrDynEntry *ent = &v->v.obj.entries[i];
        if (!ent->enumerable) continue;
        if (ent->accessor) {
          static const char message[] = "console.table cells holding accessor properties have no lowering";
          scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
          return scr_str_new("", 0);
        }
        n++;
      }
      InspBuf out = {0};
      if (n > 2) {
        /* depth -1: the object itself is past the depth limit. */
        if (v->null_proto) ib_cstr(&out, base);
        else ib_cstr(&out, "[Object]");
        return ib_take(&out);
      }
      if (v->null_proto) {
        ib_cstr(&out, base);
        ib_char(&out, ' ');
      }
      if (n == 0) {
        ib_cstr(&out, "{}");
        return ib_take(&out);
      }
      ScrStr *items[2];
      size_t count = 0;
      for (size_t i = 0; i < v->v.obj.len; i++) {
        ScrDynEntry *ent = &v->v.obj.entries[i];
        if (!ent->enumerable) continue;
        ScrStr *val = scr_insp_dyn(ent->value, 1, 0);
        InspBuf eb = {0};
        insp_key_into(&eb, ent->key, ent->key_len);
        ib_cstr(&eb, ": ");
        ib_str(&eb, val);
        scr_str_release(val);
        items[count++] = ib_take(&eb);
      }
      ib_cstr(&out, "{ ");
      insp_cell_join(&out, items, n);
      ib_cstr(&out, " }");
      return ib_take(&out);
    }
    case SCR_DYN_ARR:
    case SCR_DYN_BYTES: {
      bool bytes = v->kind == SCR_DYN_BYTES;
      if (bytes && v->buffer) return scr_insp_buffer(v->v.bytes);
      size_t len = bytes ? v->v.bytes->len : v->v.arr.len;
      InspBuf out = {0};
      if (bytes) {
        char prefix[48];
        int pn = snprintf(prefix, sizeof prefix, "%s(%zu) ", scr_bytes_elem_name(v->v.bytes->elem), len);
        ib_bytes(&out, prefix, (size_t)pn);
      }
      if (len == 0) {
        ib_cstr(&out, "[]");
        return ib_take(&out);
      }
      /* maxArrayLength 3; the elements sit past depth 0. */
      size_t shown = len < 3 ? len : 3;
      ScrStr *items[4];
      for (size_t i = 0; i < shown; i++) {
        items[i] = bytes ? scr_insp_f64(scr_bytes_get(v->v.bytes, (double)i))
                         : scr_insp_dyn(v->v.arr.items[i], 1, 0);
      }
      size_t n = shown;
      if (len > shown) items[n++] = scr_insp_more_items((double)(len - shown));
      ib_cstr(&out, "[ ");
      insp_cell_join(&out, items, n);
      ib_cstr(&out, " ]");
      return ib_take(&out);
    }
    default:
      return scr_insp_dyn(v, 0, 0);
  }
}

ScrStr *scr_insp_table_cell(ScrDyn *value) {
  bool saved = g_no_break;
  g_no_break = true;
  ScrStr *out = insp_table_cell(value);
  g_no_break = saved;
  return out;
}
