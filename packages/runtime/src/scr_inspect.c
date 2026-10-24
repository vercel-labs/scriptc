/* util.inspect — the runtime half of the static rendering. The compiler
 * synthesizes one traversal helper per static type (lower-inspect.ts, the
 * deepStrictEqual precedent); THIS file owns everything the static type
 * cannot know: Node's exact scalar formatting (number -0, the
 * single→double→backtick quoting ladder with C0/C1/DEL/lone-surrogate
 * escapes, the 10000-char string cap and the per-line ` +` continuation
 * form), Buffer's <Buffer aa bb> hex form, and the LAYOUT engine — a
 * frame stack reproducing reduceToSingleString, isBelowBreakLength, and
 * groupArrayElements from Node v24's lib/internal/util/inspect.js for
 * maxArrayLength: 100 and maxStringLength: 10000, a numeric or false
 * compact (default 3), any breakLength (default 80) and a boolean sorted;
 * other non-default options fence in the frontend.
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
  const void *seen; /* the value this frame pushed on the seen stack, or NULL */
} InspFrame;

static SCR_TL InspFrame *g_frames;
static SCR_TL size_t g_nframes;
static SCR_TL size_t g_frames_cap;
static SCR_TL size_t g_indent;       /* ctx.indentationLvl */
static SCR_TL bool g_no_break;       /* breakLength: Infinity (console.table cells) */
static SCR_TL double g_break_length = 80; /* ctx.breakLength */
static SCR_TL double g_compact = 3;  /* ctx.compact: a number, 0 for false */
static SCR_TL bool g_sorted;         /* ctx.sorted === true */
static SCR_TL double g_cur_depth;    /* ctx.currentDepth (last-entered composite) */

/* util.inspect's breakLength, compact and sorted for the renders that
 * follow (compact false is 0); the call site restores 80, 3 and false
 * after its render. */
void scr_insp_layout(double break_length, double compact, bool sorted) {
  g_break_length = break_length;
  g_compact = compact;
  g_sorted = sorted;
}

static InspFrame *insp_top(void) { return &g_frames[g_nframes - 1]; }

static void insp_circ_reset(void); /* circular-reference state, below */

/* Begin a non-empty composite: formatRaw's `recurseTimes += 1;
 * ctx.currentDepth = recurseTimes` plus the uniform +2 the children
 * format under. `recurse` is the CHILDREN's recursion depth. */
/* A value whose frame the next scr_insp_begin opens: that frame pushes it
 * on the seen stack (the runtime inspector's class instances). */
static SCR_TL const void *g_pending_seen;

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
  f->seen = NULL;
  g_cur_depth = recurse;
  g_indent += 2;
  if (g_pending_seen) {
    const void *v = g_pending_seen;
    g_pending_seen = NULL;
    scr_insp_seen_push(v);
  }
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
/* util.format's %o (scr_insp_dyn_hidden): this render shows hidden own
 * properties, like util.inspect's showHidden. */
static SCR_TL bool g_show_hidden;
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
  if (g_nframes > 0) insp_top()->seen = v;
}

ScrStr *scr_insp_circular(double id) {
  char buf[32];
  int n = snprintf(buf, sizeof buf, "[Circular *%.0f]", id);
  return scr_str_new(buf, (size_t)n);
}

/* Pops the value's seen entry after its frame closed. scr_insp_end already
 * wrote the `<ref *N>` prefix of a circular target. */
ScrStr *scr_insp_ref_wrap(const void *v, ScrStr *s) {
  (void)v;
  if (g_nseen > 0) g_nseen--;
  return scr_str_retain(s);
}

/* formatRaw's Date base: toISOString(), or toString()'s "Invalid Date"
 * when the time value is NaN (the only time value outside the ISO range). */
ScrStr *scr_insp_date(double ms) {
  if (isnan(ms)) return scr_str_new("Invalid Date", 12);
  return scr_date_to_iso(ms);
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
  if (actual_max * 3 + (double)g_indent < g_break_length &&
      (total_length / actual_max > 5 || max_length <= 6)) {
    double approx_char_heights = 2.5;
    double average_bias = sqrt(actual_max - total_length / (double)f->len);
    double biased_max = fmax(actual_max - 3 - average_bias, 1);
    double columns_d = fmin(
        fmin(round(sqrt(approx_char_heights * biased_max * (double)output_len) / biased_max),
             floor((g_break_length - (double)g_indent) / actual_max)),
        fmin(g_compact * 4, 15));
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

static int insp_item_cmp(const void *a, const void *b) {
  return scr_str_cmp_u16(*(ScrStr *const *)a, *(ScrStr *const *)b);
}

/* isBelowBreakLength: UTF-16 lengths against ctx.breakLength. */
static bool insp_below_break_length(InspFrame *f, size_t start, const ScrStr *base) {
  size_t total = f->len + start;
  if ((double)(total + f->len) > g_break_length) return false;
  for (size_t i = 0; i < f->len; i++) {
    total += insp_utf16_len(f->items[i]->data, f->items[i]->len);
    if ((double)total > g_break_length) return false;
  }
  return base->len == 0 || !insp_contains_byte(base->data, base->len, '\n');
}

/* reduceToSingleString for a numeric or false compact (only a compact of
 * at least 1 groups arrays and tries the single line). Pops the
 * frame. base/b0/b1 are borrowed; +1 result. `recurse` is the frame's
 * recurseTimes (the children's depth); array_extras marks kArrayExtrasType
 * (grid grouping applies); trailing_more marks a "... N more items" tail
 * entry (excluded from the grid). */
ScrStr *scr_insp_end(ScrStr *base, ScrStr *b0, ScrStr *b1, double recurse, bool array_extras,
                     bool trailing_more) {
  InspFrame *f = insp_top();
  g_indent -= 2;
  /* sorted: true orders an object-type composite's entries (properties,
   * and Map and Set entries) by their rendered text, in UTF-16 code-unit
   * order; arrays keep their element order. */
  if (g_sorted && !array_extras && f->len > 1) qsort(f->items, f->len, sizeof *f->items, insp_item_cmp);
  /* Node adds a circular target's `<ref *N>` to the base before it chooses
   * the layout, so the reference counts toward the line width. */
  ScrStr *ref_base = NULL;
  int ref_id = f->seen ? insp_circ_id(f->seen) : 0;
  if (ref_id) {
    char buf[32];
    int n = snprintf(buf, sizeof buf, base->len ? "<ref *%d> " : "<ref *%d>", ref_id);
    size_t len = (size_t)n + base->len;
    ref_base = scr_str_alloc_raw(len, len);
    memcpy(ref_base->data, buf, (size_t)n);
    memcpy(ref_base->data + n, base->data, base->len);
    ref_base->data[len] = '\0';
    base = ref_base;
  }
  size_t entries = f->len;
  bool compact = g_compact >= 1;
  if (compact && array_extras && entries > 6) insp_group(f, trailing_more);
  InspBuf out = {0};
  if (compact && g_cur_depth - recurse < g_compact && entries == f->len) {
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
  if (ref_base) scr_str_release(ref_base);
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

/* The inspector's state at the start of a top-level render. A render that
 * an inspection refusal ends leaves its compiled frames open: the Error
 * propagates out of the emitted helpers before their scr_insp_end and
 * scr_insp_nested_end calls. The emitted render takes a mark first and
 * unwinds to it on every exit (lower-inspect.ts), so later renders start
 * from the state the refused one found. */
typedef struct {
  size_t nframes;
  size_t nsaved;
  size_t nseen;
  size_t indent;
  double cur_depth;
} InspMark;

static SCR_TL InspMark *g_marks;
static SCR_TL size_t g_nmarks;
static SCR_TL size_t g_marks_cap;

void scr_insp_mark(void) {
  if (g_nmarks == g_marks_cap) {
    g_marks_cap = g_marks_cap ? g_marks_cap * 2 : 4;
    g_marks = realloc(g_marks, g_marks_cap * sizeof(InspMark));
    if (!g_marks) insp_oom();
  }
  g_marks[g_nmarks++] = (InspMark){g_nframes, g_nsaved, g_nseen, g_indent, g_cur_depth};
}

void scr_insp_unwind(void) {
  InspMark m = g_marks[--g_nmarks];
  while (g_nframes > m.nframes) {
    InspFrame *f = &g_frames[--g_nframes];
    for (size_t i = 0; i < f->len; i++) scr_str_release(f->items[i]);
    free(f->items);
  }
  while (g_nsaved > m.nsaved) {
    InspSaved *sv = &g_saved[--g_nsaved];
    free(g_seen);
    g_seen = sv->seen;
    g_seen_cap = sv->seen_cap;
    memcpy(g_circ, sv->circ, sizeof g_circ);
    g_ncirc = sv->ncirc;
  }
  if (g_nseen > m.nseen) g_nseen = m.nseen;
  g_indent = m.indent;
  g_cur_depth = m.cur_depth;
  g_pending_seen = NULL;
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
 * (truncated) text is longer than 16 chars AND breakLength -
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
  if (!g_no_break && units > 16 && (double)units > g_break_length - (double)g_indent - 4 &&
      memchr(v, '\n', vlen) != NULL) {
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

/* Named properties of a typed array, Buffer or DataView (its
 * ScrBytes.properties table): slot k is the k-th string-keyed entry, then
 * the k-th symbol key. */
static size_t insp_view_property_slots(const ScrDyn *props) {
  if (!props) return 0;
  return props->v.obj.len + (props->symbol_keys ? props->symbol_keys->v.arr.len : 0);
}

static ScrStr *insp_accessor_tag(const ScrDynEntry *ent);
static void insp_key_into(InspBuf *b, const char *key, size_t len);

/* Slot k's `key: value` entry when it is enumerable, else NULL. */
static ScrStr *insp_view_property(ScrDyn *props, size_t k, double recurse, double depth) {
  const ScrDynEntry *ent;
  ScrStr *key = NULL;
  if (k < props->v.obj.len) {
    ent = &props->v.obj.entries[k];
  } else {
    ScrDyn *symbol = props->symbol_keys->v.arr.items[k - props->v.obj.len];
    ent = scr_dyn_own_symbol_entry(props, symbol);
    if (ent && ent->enumerable) key = scr_insp_dyn(symbol, recurse, depth);
  }
  if (!ent || !ent->enumerable) return NULL;
  ScrStr *val = ent->accessor ? insp_accessor_tag(ent) : scr_insp_dyn(ent->value, recurse, depth);
  InspBuf eb = {0};
  if (key) ib_bytes(&eb, key->data, key->len);
  else insp_key_into(&eb, ent->key, ent->key_len);
  ib_cstr(&eb, ": ");
  ib_bytes(&eb, val->data, val->len);
  scr_str_release(key);
  scr_str_release(val);
  return ib_take(&eb);
}

static size_t insp_view_property_count(ScrDyn *props) {
  size_t count = 0;
  for (size_t k = 0; k < insp_view_property_slots(props); k++) {
    if (k < props->v.obj.len) count += props->v.obj.entries[k].enumerable;
    else {
      const ScrDynEntry *ent = scr_dyn_own_symbol_entry(props, props->symbol_keys->v.arr.items[k - props->v.obj.len]);
      count += ent && ent->enumerable;
    }
  }
  return count;
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
  /* Named properties follow as `, key: value`, rendered as the members of
   * an object at depth 0 (Buffer's custom inspect). */
  bool first = true;
  for (size_t k = 0; k < insp_view_property_slots(b->properties); k++) {
    ScrStr *entry = insp_view_property(b->properties, k, 1, 2);
    if (!entry) continue;
    if (!first || b->len) ib_cstr(&out, ", ");
    first = false;
    ib_bytes(&out, entry->data, entry->len);
    scr_str_release(entry);
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

/* DataView: formatValue's `DataView { [byteLength], [byteOffset],
 * [buffer] }`, the buffer rendered one level deeper. `[DataView]` beyond
 * depth. */
static ScrStr *scr_insp_data_view(const ScrBytes *b, double recurse, double depth) {
  if (recurse > depth) return scr_str_new("[DataView]", 10);
  const ScrBytes *owner = b->backing ? b->backing : b;
  char line[64];
  scr_insp_begin(recurse + 1);
  int n = snprintf(line, sizeof line, "[byteLength]: %.0f", scr_bytes_byte_len(b));
  ScrStr *entry = scr_str_new(line, (size_t)n);
  scr_insp_entry(entry, false);
  scr_str_release(entry);
  n = snprintf(line, sizeof line, "[byteOffset]: %.0f", scr_bytes_byte_offset(b));
  entry = scr_str_new(line, (size_t)n);
  scr_insp_entry(entry, false);
  scr_str_release(entry);
  ScrStr *buffer = scr_insp_array_buffer(owner, owner->shared ? "SharedArrayBuffer" : "ArrayBuffer",
                                         recurse + 1, depth);
  InspBuf eb = {0};
  ib_cstr(&eb, "[buffer]: ");
  ib_bytes(&eb, buffer->data, buffer->len);
  scr_str_release(buffer);
  entry = ib_take(&eb);
  scr_insp_entry(entry, false);
  scr_str_release(entry);
  for (size_t k = 0; k < insp_view_property_slots(b->properties); k++) {
    entry = insp_view_property(b->properties, k, recurse + 1, depth);
    if (!entry) continue;
    scr_insp_entry(entry, false);
    scr_str_release(entry);
  }
  ScrStr *base = scr_str_new("", 0);
  ScrStr *b0 = scr_str_new("DataView {", 10);
  ScrStr *b1 = scr_str_new("}", 1);
  ScrStr *out = scr_insp_end(base, b0, b1, recurse + 1, false, false);
  scr_str_release(base);
  scr_str_release(b0);
  scr_str_release(b1);
  return out;
}

static ScrStr *scr_insp_dyn_error(ScrDyn *d, double recurse, double depth);

/* An error's own `cause` property and whether it is enumerable, read where
 * `e.cause` reads it: the error's checked-dynamic node when it has one,
 * else its slot. NULL when it has none (borrowed; `view` holds a
 * materialized node the caller releases). */
static ScrDyn *insp_error_cause(ScrError *e, bool *enumerable, ScrDyn **view) {
  *view = NULL;
  ScrDyn *node = scr_errdyn_view_of(e);
  if (node != NULL && node->kind == SCR_DYN_TYPED_REF) node = *view = scr_dyn_typed_ref_materialize(node);
  if (node != NULL && node->kind == SCR_DYN_OBJ) {
    for (size_t i = 0; i < node->v.obj.len; i++) {
      ScrDynEntry *ent = &node->v.obj.entries[i];
      if (ent->key_len == 5 && memcmp(ent->key, "cause", 5) == 0) {
        *enumerable = ent->enumerable;
        return ent->value;
      }
    }
    return NULL;
  }
  *enumerable = e->cause_enumerable;
  return e->error_cause;
}

/* Whether an error subclass instance's property bag (its properties
 * created through untyped references) holds an enumerable property other
 * than `cause`, which the error renderers print. Node's inspector shows no
 * other non-enumerable property of an error. */
bool scr_insp_error_bag_has_properties(ScrDyn *bag) {
  if (bag == NULL || bag->kind != SCR_DYN_OBJ) return false;
  for (size_t i = 0; i < bag->v.obj.len; i++) {
    const ScrDynEntry *ent = &bag->v.obj.entries[i];
    if (ent->enumerable && !(ent->key_len == 5 && memcmp(ent->key, "cause", 5) == 0)) return true;
  }
  return false;
}

/* Whether a program-declared error subclass instance has an own `cause`. */
bool scr_insp_error_has_cause(ScrError *e) {
  bool enumerable;
  ScrDyn *view;
  bool has = insp_error_cause(e, &enumerable, &view) != NULL;
  scr_dyn_release(view);
  return has;
}

/* The entry formatError prints for an error's own `cause`: `cause: value`
 * when the property is enumerable (an assignment), `[cause]: value` when it
 * is not (the constructor's options). The caller checked that it has one
 * (scr_insp_error_has_cause). +1 */
ScrStr *scr_insp_error_cause(ScrError *e, double recurse, double depth) {
  bool enumerable;
  ScrDyn *view;
  ScrDyn *cause = insp_error_cause(e, &enumerable, &view);
  ScrStr *value = cause != NULL ? scr_insp_dyn(cause, recurse, depth) : scr_str_new("undefined", 9);
  scr_dyn_release(view);
  InspBuf out = {0};
  ib_cstr(&out, enumerable ? "cause: " : "[cause]: ");
  ib_bytes(&out, value->data, value->len);
  scr_str_release(value);
  return ib_take(&out);
}

/* A runtime error through its node: the cached one, or one built from its
 * fields. */
ScrStr *scr_insp_error_node(ScrError *e, double recurse, double depth) {
  ScrDyn *view = scr_errdyn_view_of(e);
  if (view != NULL && view->kind == SCR_DYN_OBJ) return scr_insp_dyn_error(view, recurse, depth);
  ScrDyn *fields = scr_error_dyn_fields(e);
  ScrStr *out = scr_insp_dyn_error(fields, recurse, depth);
  scr_dyn_release(fields);
  return out;
}

/* Errors: the STACKLESS rendering — compiled binaries carry no stack, so
 * the base is formatError's bracket form `[Name: message]` / `[Name]`
 * (Node prints these exact forms for an error whose stack is empty;
 * stack-carrying Node output is a documented divergence). A runtime error
 * renders through its checked-dynamic node, so the own properties Node
 * shows follow in key order: the system-error fields, code, and the extra
 * properties a throw site attached (`[Error: m] { errno: -2, code:
 * 'ENOENT', ... }`). Other errors render a stamped `code` slot as their
 * one extra property: `[Error: m] { code: 'X' }`, `[Error]` beyond depth.
 * Message newlines indent like Node's formatError tail. */
ScrStr *scr_insp_error(ScrError *e, double recurse, double depth) {
  if (e->vt >= &scr_error_vts[0] && e->vt < &scr_error_vts[SCR_ERR_COUNT])
    return scr_insp_error_node(e, recurse, depth);
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
/* util.inspect's text for an accessor property: [Getter], [Setter] or
 * [Getter/Setter], by which of the two are functions. +1. */
static ScrStr *insp_accessor_tag(const ScrDynEntry *ent) {
  bool get = ent->getter && ent->getter->kind == SCR_DYN_FUNC;
  bool set = ent->setter && ent->setter->kind == SCR_DYN_FUNC;
  const char *text = get && set ? "[Getter/Setter]" : get ? "[Getter]" : set ? "[Setter]" : "undefined";
  return scr_str_new(text, strlen(text));
}

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

/* AssertionError's custom inspect (lib/internal/assert/assertion_error.js)
 * renders the error at depth 0 and shortens string actual/expected values
 * with addEllipsis: past 10 lines, the first 10 and "\n..."; otherwise past
 * 512 characters, the text from offset 512 on and "...". +1. */
static ScrDyn *insp_assertion_ellipsis(ScrDyn *value) {
  if (value->kind != SCR_DYN_STR) return scr_dyn_retain(value);
  ScrStr *text = value->v.str;
  size_t lines = 1, cut = 0;
  for (size_t i = 0; i < text->len; i++) {
    if (text->data[i] != '\n') continue;
    if (++lines == 11) {
      cut = i;
      break;
    }
  }
  InspBuf b = {0};
  if (lines > 10) {
    ib_bytes(&b, text->data, cut);
    ib_cstr(&b, "\n...");
  } else if (scr_str_utf16_len(text) > 512) {
    ScrStr *tail = scr_str_slice(text, 512, scr_str_utf16_len(text));
    ib_str(&b, tail);
    ib_cstr(&b, "...");
    scr_str_release(tail);
  } else {
    return scr_dyn_retain(value);
  }
  ScrStr *shortened = ib_take(&b);
  ScrDyn *out = scr_dyn_new_str(shortened);
  scr_str_release(shortened);
  return out;
}

/* The checked-dynamic Error encoding (scr_error_dyn_fields) rendered like
 * scr_insp_error: the stackless bracket form `[Name: message]`, then the
 * remaining enumerable own properties (code, errno, syscall, ...) in
 * Node's `{ ... }` tail. */
/* An own non-enumerable entry of the error encoding, NULL when absent or
 * enumerable (an enumerable one prints with the other own keys). */
static const ScrDynEntry *insp_error_hidden_entry(const ScrDyn *d, const char *key, size_t len) {
  for (size_t i = 0; i < d->v.obj.len; i++) {
    const ScrDynEntry *ent = &d->v.obj.entries[i];
    if (ent->key_len == len && memcmp(ent->key, key, len) == 0) return ent->enumerable ? NULL : ent;
  }
  return NULL;
}

static ScrStr *scr_insp_dyn_error(ScrDyn *d, double recurse, double depth) {
  /* An error already on the traversal stack (a spawnSync error's own
   * `error`): Node's [Circular *N], and <ref *N> on the outer rendering. */
  double circular = scr_insp_circ_check(d);
  if (circular != 0) return scr_insp_circular(circular);
  const ScrDyn *name = insp_error_slot(d, "name", 4);
  const ScrDyn *message = insp_error_slot(d, "message", 7);
  bool assertion = name != NULL && name->v.str->len == 14 &&
                   memcmp(name->v.str->data, "AssertionError", 14) == 0;
  double value_depth = assertion ? recurse : depth;
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
  /* formatError shows a non-enumerable `cause`, and an AggregateError's
   * `errors` array, after the enumerable keys: `[cause]`, `[errors]`. */
  const ScrDynEntry *cause = insp_error_hidden_entry(d, "cause", 5);
  const ScrDynEntry *errors = insp_error_hidden_entry(d, "errors", 6);
  if (errors && errors->value->kind != SCR_DYN_ARR) errors = NULL;
  extra += (cause != NULL) + (errors != NULL);
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
  scr_insp_seen_push(d);
  for (size_t i = 0; i < d->v.obj.len; i++) {
    ScrDynEntry *ent = &d->v.obj.entries[i];
    if (!ent->enumerable) continue;
    if ((ent->key_len == 4 && memcmp(ent->key, "name", 4) == 0) ||
        (ent->key_len == 7 && memcmp(ent->key, "message", 7) == 0) ||
        (ent->key_len == 5 && memcmp(ent->key, "stack", 5) == 0))
      continue;
    bool shortened = assertion && ((ent->key_len == 6 && memcmp(ent->key, "actual", 6) == 0) ||
                                   (ent->key_len == 8 && memcmp(ent->key, "expected", 8) == 0));
    ScrDyn *shown = shortened ? insp_assertion_ellipsis(ent->value) : scr_dyn_retain(ent->value);
    ScrStr *val = scr_insp_dyn(shown, recurse + 1, value_depth);
    scr_dyn_release(shown);
    InspBuf eb = {0};
    insp_key_into(&eb, ent->key, ent->key_len);
    ib_cstr(&eb, ": ");
    ib_bytes(&eb, val->data, val->len);
    scr_str_release(val);
    ScrStr *entry = ib_take(&eb);
    scr_insp_entry(entry, false);
    scr_str_release(entry);
  }
  const ScrDynEntry *hidden[] = {cause, errors};
  for (size_t i = 0; i < 2; i++) {
    if (!hidden[i]) continue;
    ScrStr *val = scr_insp_dyn(hidden[i]->value, recurse + 1, value_depth);
    InspBuf eb = {0};
    ib_char(&eb, '[');
    ib_bytes(&eb, hidden[i]->key, hidden[i]->key_len);
    ib_cstr(&eb, "]: ");
    ib_bytes(&eb, val->data, val->len);
    scr_str_release(val);
    ScrStr *entry = ib_take(&eb);
    scr_insp_entry(entry, false);
    scr_str_release(entry);
  }
  ScrStr *b0 = scr_str_new("{", 1);
  ScrStr *b1 = scr_str_new("}", 1);
  ScrStr *body = scr_insp_end(base_str, b0, b1, recurse + 1, false, false);
  scr_str_release(b0);
  scr_str_release(b1);
  scr_str_release(base_str);
  ScrStr *out = scr_insp_ref_wrap(d, body);
  scr_str_release(body);
  return out;
}

/* A class instance's name forms: "Name {}" for an empty instance, "[Name]"
 * past the depth limit (tail NULL). */
static ScrStr *scr_insp_class_tag(const char *cls, const char *tail) {
  InspBuf out = {0};
  if (tail) {
    ib_cstr(&out, cls);
    ib_cstr(&out, tail);
  } else {
    ib_char(&out, '[');
    ib_cstr(&out, cls);
    ib_char(&out, ']');
  }
  return ib_take(&out);
}

/* Node prints a @@toStringTag that ends with "." and the constructor name
 * (WebAssembly.Module for Module) in place of the name, without the
 * bracketed tag. */
static bool insp_tag_names_class(const char *tag, const char *cls) {
  if (!tag) return false;
  size_t tag_len = strlen(tag), cls_len = strlen(cls);
  return tag_len > cls_len + 1 && tag[tag_len - cls_len - 1] == '.' &&
         memcmp(tag + tag_len - cls_len, cls, cls_len) == 0;
}

/* The Symbol.toStringTag a class instance inherits from its class's
 * getter (+1), which Node brackets after the class name when it is a
 * nonempty string other than the name. An own tag field is listed with
 * the fields instead. A getter that throws shows no tag, as in Node. */
static ScrStr *insp_inherited_tag(const ScrDyn *instance, const ScrStr *name) {
  ScrStr *tag = scr_dyn_typed_ref_class_tag(instance);
  if (!tag && scr_exc_pending()) scr_exc_clear();
  if (tag && (tag->len == 0 || (tag->len == name->len && memcmp(tag->data, name->data, name->len) == 0))) {
    scr_str_release(tag);
    return NULL;
  }
  return tag;
}

/* A native Set or Map held as a checked-dynamic value: `Set(n) { a, b }`,
 * `Map(n) { k => v }`, at most 100 entries like Node's maxArrayLength. */
/* Node's formatWeakCollection: the entries of a WeakMap or WeakSet are not
 * listed without showHidden, so the body is the one "<items unknown>"
 * entry, and past the depth limit the value prints as [WeakMap]. */
static ScrStr *scr_insp_weak_collection(const char *label, double recurse, double depth) {
  InspBuf out = {0};
  if (recurse > depth) {
    ib_char(&out, '[');
    ib_cstr(&out, label);
    ib_char(&out, ']');
    return ib_take(&out);
  }
  ib_cstr(&out, label);
  ib_cstr(&out, " { <items unknown> }");
  return ib_take(&out);
}

/* A native iterator: the array and string iterators print Node's empty
 * `Object [Array Iterator] {}`; the Map and Set iterators print the
 * entries their next steps would produce, under Node's labels
 * (`[Set Iterator] { 1, 2 }`, `[Map Entries] { [ 'a', 1 ] }`), without
 * advancing. NULL for a handle's iterator (kind 4), which keeps the
 * unsupported answer. */
static ScrStr *scr_insp_native_iterator(ScrDyn *d, double recurse, double depth) {
  unsigned kind, selection;
  ScrMap *map;
  double index;
  scr_dyn_native_iterator_state(d, &kind, &selection, &map, &index);
  if (kind == 0) return scr_str_new("Object [Array Iterator] {}", 26);
  if (kind == 1) return scr_str_new("Object [String Iterator] {}", 27);
  if (kind != 2 && kind != 3) return NULL;
  bool pairs = selection == 2;
  const char *label = kind == 3 ? (pairs ? "[Set Entries]" : "[Set Iterator]")
                                : (pairs ? "[Map Entries]" : "[Map Iterator]");
  if (recurse > depth) {
    InspBuf out = {0};
    ib_cstr(&out, "[Object ");
    ib_cstr(&out, label);
    ib_char(&out, ']');
    return ib_take(&out);
  }
  size_t remaining = 0;
  if (map) {
    for (double i = scr_map_iter_skip(map, index); i < scr_map_iter_count(map); i++)
      if (scr_map_iter_live(map, i)) remaining++;
  }
  if (remaining == 0) {
    InspBuf out = {0};
    ib_cstr(&out, label);
    ib_cstr(&out, " {  }");
    return ib_take(&out);
  }
  ScrStr *base = scr_str_new(label, strlen(label));
  scr_insp_begin(recurse + 1);
  scr_map_iter_enter(map);
  size_t shown = 0;
  for (double i = scr_map_iter_skip(map, index); i < scr_map_iter_count(map) && shown < 100; i++) {
    if (!scr_map_iter_live(map, i)) continue;
    shown++;
    ScrDyn *item;
    if (pairs) {
      item = scr_dyn_new_arr();
      scr_dyn_arr_push(item, scr_map_dyn_key(map, i));
      scr_dyn_arr_push(item, kind == 3 ? scr_map_dyn_key(map, i) : scr_map_dyn_value(map, i));
    } else {
      item = kind == 2 && selection == 0 ? scr_map_dyn_value(map, i) : scr_map_dyn_key(map, i);
    }
    ScrStr *text = scr_insp_dyn(item, recurse + 1, depth);
    scr_dyn_release(item);
    scr_insp_entry(text, false);
    scr_str_release(text);
  }
  scr_map_iter_exit(map);
  if (remaining > shown) {
    ScrStr *more = scr_insp_more_items((double)(remaining - shown));
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

/* A compiled generator object: Node's empty `Object [<tag>] {}`, with the
 * tag the compiler set (scr_gen_set_tag). A generator standing in for an
 * object of another class (a tag starting with '!') throws the
 * "not supported yet" Error instead. */
static bool scr_insp_is_generator(const ScrDyn *d) {
  const char *key = d->v.typed_ref.type_key;
  return !strncmp(key, "generator<", 10) || !strncmp(key, "async-generator<", 16);
}

static ScrStr *scr_insp_generator(const ScrDyn *d) {
  const char *tag = scr_gen_tag_reader(d->v.typed_ref.ptr);
  if (tag[0] == '!') {
    static const char message[] = "util.inspect of this iterator object is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
    return scr_str_new("", 0);
  }
  InspBuf out = {0};
  ib_cstr(&out, "Object [");
  ib_cstr(&out, tag);
  ib_cstr(&out, "] {}");
  return ib_take(&out);
}

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

/* An own symbol-keyed property of `d` (borrowed) this render shows, or
 * NULL: enumerable ones, and under showHidden the non-enumerable ones too. */
static ScrDynEntry *scr_insp_symbol_entry(ScrDyn *d, size_t i) {
  ScrDynEntry *ent = scr_dyn_own_symbol_entry(d, d->symbol_keys->v.arr.items[i]);
  return ent && (ent->enumerable || g_show_hidden) ? ent : NULL;
}

/* An ordinary object: `Name { key: value }` with its constructor name
 * `cls` (NULL for a plain object). Node's default view lists the own
 * enumerable string keys, then the own enumerable symbol keys. */
/* An own entry this render shows: enumerable ones, and under showHidden
 * the non-enumerable ones too (never the encoding's `%` markers). */
static bool insp_obj_shows(const ScrDynEntry *ent) {
  return ent->enumerable || (g_show_hidden && !(ent->key_len && ent->key[0] == '%'));
}

static ScrStr *scr_insp_obj(ScrDyn *d, double recurse, double depth, const char *cls) {
  size_t shown = 0;
  for (size_t i = 0; i < d->v.obj.len; i++) shown += insp_obj_shows(&d->v.obj.entries[i]);
  size_t nsymbols = d->symbol_keys ? d->symbol_keys->v.arr.len : 0;
  for (size_t i = 0; i < nsymbols; i++) shown += scr_insp_symbol_entry(d, i) != NULL;
  if (shown == 0) {
    if (cls) return scr_insp_class_tag(cls, " {}");
    return d->null_proto ? scr_str_new("[Object: null prototype] {}", 27)
                         : scr_str_new("{}", 2);
  }
  if (recurse > depth) {
    if (cls) return scr_insp_class_tag(cls, NULL);
    return d->null_proto ? scr_str_new("[Object: null prototype]", 24)
                         : scr_str_new("[Object]", 8);
  }
  scr_insp_begin(recurse + 1);
  for (size_t i = 0; i < d->v.obj.len; i++) {
    ScrDynEntry *ent = &d->v.obj.entries[i];
    if (!insp_obj_shows(ent)) continue;
    ScrStr *val = ent->accessor ? insp_accessor_tag(ent) : scr_insp_dyn(ent->value, recurse + 1, depth);
    InspBuf eb = {0};
    if (ent->enumerable) {
      insp_key_into(&eb, ent->key, ent->key_len);
    } else {
      /* formatProperty's hidden key: the key's rendering in brackets. */
      ib_char(&eb, '[');
      insp_key_into(&eb, ent->key, ent->key_len);
      ib_char(&eb, ']');
    }
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
    ScrStr *val = ent->accessor ? insp_accessor_tag(ent) : scr_insp_dyn(ent->value, recurse + 1, depth);
    InspBuf eb = {0};
    /* A hidden symbol key is bracketed like a hidden string key. */
    if (!ent->enumerable) ib_char(&eb, '[');
    ib_bytes(&eb, key->data, key->len);
    if (!ent->enumerable) ib_char(&eb, ']');
    ib_cstr(&eb, ": ");
    ib_bytes(&eb, val->data, val->len);
    scr_str_release(key);
    scr_str_release(val);
    ScrStr *entry = ib_take(&eb);
    scr_insp_entry(entry, false);
    scr_str_release(entry);
  }
  ScrStr *base = cls             ? scr_str_new(cls, strlen(cls))
                 : d->null_proto ? scr_str_new("[Object: null prototype]", 24)
                                 : scr_str_new("", 0);
  ScrStr *b0 = scr_str_new("{", 1);
  ScrStr *b1 = scr_str_new("}", 1);
  ScrStr *out = scr_insp_end(base, b0, b1, recurse + 1, false, false);
  scr_str_release(base);
  scr_str_release(b0);
  scr_str_release(b1);
  return out;
}

/* A numeric typed array (not a Buffer): `Uint8Array(n) [ ... ]` with
 * Node's maxArrayLength (100) and array grid, `[Uint8Array]` past the
 * depth limit. Borrows b; +1. */
ScrStr *scr_insp_typed_array(ScrBytes *b, double recurse, double depth) {
  char prefix[48];
  int pn = snprintf(prefix, sizeof prefix, "%s(%zu) [", scr_bytes_elem_name(b->elem), b->len);
  /* Named properties follow the elements as `key: value` entries. */
  ScrDyn *props = b->properties;
  size_t nprops = insp_view_property_count(props);
  if (b->len == 0 && nprops == 0) {
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
  size_t entries = shown + (more ? 1 : 0);
  for (size_t k = 0; nprops && k < insp_view_property_slots(props); k++) {
    ScrStr *entry = insp_view_property(props, k, recurse + 1, depth);
    if (!entry) continue;
    /* Node's grouping pads by the element at the entry's output position. */
    scr_insp_entry(entry, entries < b->len);
    scr_str_release(entry);
    entries++;
  }
  ScrStr *base = scr_str_new("", 0);
  ScrStr *b0 = scr_str_new(prefix, (size_t)pn);
  ScrStr *b1 = scr_str_new("]", 1);
  ScrStr *out = scr_insp_end(base, b0, b1, recurse + 1, true, nprops ? entries > 100 : more);
  scr_str_release(base);
  scr_str_release(b0);
  scr_str_release(b1);
  return out;
}

/* Node's function rendering: [Function: name] / [Function (anonymous)],
 * and [class C extends B] / [class (anonymous)] for a class. The boxed
 * name is the compiler's best-effort static spelling (SEMANTICS.md —
 * reference-site naming). Enumerable own properties (a class's static
 * fields, properties assigned to a function) follow in braces; past the
 * depth limit such a function is [Function]. Borrows d; +1. */
static ScrStr *scr_insp_dyn_func(ScrDyn *d, double recurse, double depth) {
  const char *name = d->v.fn.name;
  const ScrClassObj *cls = d->v.fn.class_obj;
  ScrClosure *owner = scr_closure_identity(d->v.fn.clo);
  ScrBox *props = owner->props ? owner->props : cls ? cls->static_data : NULL;
  ScrDyn *table = props ? (ScrDyn *)scr_box_get_ref(props) : NULL; /* +1 */
  InspBuf out = {0};
  if (cls) {
    ib_cstr(&out, "[class ");
    ib_cstr(&out, name && name[0] ? name : "(anonymous)");
    const ScrDyn *base = table ? table->prototype : NULL;
    if (cls->base_name && cls->base_name->len) {
      ib_cstr(&out, " extends ");
      ib_bytes(&out, cls->base_name->data, cls->base_name->len);
    } else if (base && base->kind == SCR_DYN_FUNC && base->v.fn.name && base->v.fn.name[0]) {
      ib_cstr(&out, " extends ");
      ib_cstr(&out, base->v.fn.name);
    }
    ib_char(&out, ']');
  } else if (name && name[0]) {
    ib_cstr(&out, "[Function: ");
    ib_cstr(&out, name);
    ib_char(&out, ']');
  } else {
    ib_cstr(&out, "[Function (anonymous)]");
  }
  ScrStr *tag = ib_take(&out);
  if (cls && !props && cls->own_static_fields) {
    /* Node prints the static fields after the tag; the class object
     * does not hold them (the reflection fence's stance). */
    scr_str_release(tag);
    static const char message[] = "util.inspect of a class with static fields through unknown is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
    return scr_str_new("", 0);
  }
  size_t shown = 0;
  if (table && table->kind == SCR_DYN_OBJ) {
    for (size_t i = 0; i < table->v.obj.len; i++) shown += table->v.obj.entries[i].enumerable;
    size_t nsymbols = table->symbol_keys ? table->symbol_keys->v.arr.len : 0;
    for (size_t i = 0; i < nsymbols; i++) shown += scr_insp_symbol_entry(table, i) != NULL;
  }
  if (shown == 0) {
    scr_dyn_release(table);
    return tag;
  }
  /* A function already on the traversal stack renders as [Circular *N],
   * even past the depth limit. Its identity is the class object for a class
   * (each dynamic box of a class may carry its own closure) and the closure
   * every box of a function shares otherwise. */
  const void *identity = cls ? (const void *)cls : (const void *)owner;
  double circular = scr_insp_circ_check(identity);
  if (circular > 0) {
    scr_dyn_release(table);
    scr_str_release(tag);
    return scr_insp_circular(circular);
  }
  if (recurse > depth) {
    scr_dyn_release(table);
    scr_str_release(tag);
    return scr_str_new("[Function]", 10);
  }
  char *prefix = malloc(tag->len + 1);
  if (!prefix) scr_trap("scriptc: out of memory\n");
  memcpy(prefix, tag->data, tag->len);
  prefix[tag->len] = '\0';
  scr_str_release(tag);
  size_t nseen = g_nseen;
  g_pending_seen = identity;
  ScrStr *rendered = scr_insp_obj(table, recurse, depth, prefix);
  g_pending_seen = NULL;
  if (g_nseen > nseen) g_nseen = nseen;
  free(prefix);
  scr_dyn_release(table);
  return rendered;
}

/* Under showHidden, the kinds whose hidden entries this inspector does not
 * render (a function's length/name/prototype, an error's stack, a typed
 * array's byte fields, a native handle's internals): the kind's name, NULL
 * for the kinds it renders. */
static const char *insp_hidden_refusal(const ScrDyn *d) {
  switch (d->kind) {
    case SCR_DYN_FUNC: return "function";
    case SCR_DYN_BYTES: return d->buffer ? "Buffer" : d->v.bytes->is_data_view ? "DataView" : "typed array";
    case SCR_DYN_OBJ: return scr_dyn_obj_get(d, "%error", 6) != NULL ? "Error" : NULL;
    case SCR_DYN_HANDLE:
      return d->v.handle.tag == SCR_DYNH_MAP || d->v.handle.tag == SCR_DYNH_SET ||
                     d->v.handle.tag == SCR_DYNH_DATE
                 ? NULL
                 : scr_dyn_handle_cls(d);
    default: return NULL;
  }
}

ScrStr *scr_insp_bytes(ScrBytes *b, double recurse, double depth) {
  if (b->is_data_view) return scr_insp_data_view(b, recurse, depth);
  if (b->is_buffer) return scr_insp_buffer(b);
  return scr_insp_typed_array(b, recurse, depth);
}

/* Node's URLSearchParams inspector: [Object] past the depth limit, and
 * otherwise each pair as `name => value` with both strings inspected, on
 * one line, or one pair per line when the pairs' text is longer than
 * breakLength (the closing brace stays on the last pair's line). The lines
 * take the caller's indentation, as a custom inspector's text does. */
static ScrStr *scr_insp_search_params(ScrSearchParams *sp, double recurse, double depth) {
  if (recurse > depth) return scr_str_new("[Object]", 8);
  size_t n = (size_t)scr_sp_size(sp);
  if (n == 0) return scr_str_new("URLSearchParams {}", 18);
  ScrStr **items = malloc(n * sizeof *items);
  if (!items) insp_oom();
  double length = -2;
  for (size_t i = 0; i < n; i++) {
    ScrStr *name = scr_sp_key_at(sp, (double)i);
    ScrStr *value = scr_sp_val_at(sp, (double)i);
    ScrStr *name_text = scr_insp_str(name);
    ScrStr *value_text = scr_insp_str(value);
    InspBuf item = {0};
    ib_str(&item, name_text);
    ib_cstr(&item, " => ");
    ib_str(&item, value_text);
    items[i] = ib_take(&item);
    length += (double)insp_utf16_len(items[i]->data, items[i]->len) + 2;
    scr_str_release(name);
    scr_str_release(value);
    scr_str_release(name_text);
    scr_str_release(value_text);
  }
  bool multiline = length > g_break_length;
  InspBuf out = {0};
  ib_cstr(&out, multiline ? "URLSearchParams {\n  " : "URLSearchParams { ");
  for (size_t i = 0; i < n; i++) {
    if (i) ib_cstr(&out, multiline ? ",\n  " : ", ");
    ib_str(&out, items[i]);
    scr_str_release(items[i]);
  }
  free(items);
  ib_cstr(&out, " }");
  ScrStr *text = ib_take(&out);
  InspBuf indented = {0};
  for (size_t k = 0; k < text->len; k++) {
    ib_char(&indented, text->data[k]);
    if (text->data[k] == '\n') ib_spaces(&indented, g_indent);
  }
  scr_str_release(text);
  return ib_take(&indented);
}

ScrStr *scr_insp_dyn(ScrDyn *d, double recurse, double depth) {
  if (d->kind == SCR_DYN_PROXY) return scr_insp_dyn(d->v.proxy.target, recurse, depth);
  const char *refused = g_show_hidden ? insp_hidden_refusal(d) : NULL;
  if (refused) {
    InspBuf out = {0};
    ib_cstr(&out, "util.format %o of ");
    ib_cstr(&out, refused);
    ib_cstr(&out, " values is not supported yet");
    scr_throw_error(SCR_ERR_ERROR, ib_take(&out));
    return scr_str_new("", 0);
  }
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
    case SCR_DYN_ARR: {
      size_t len = d->v.arr.len;
      /* Named and noncanonical numeric properties follow the elements as
       * `key: value` entries (Node's array extras); under showHidden the
       * own `length` comes first, and non-enumerable properties show too. */
      const ScrDyn *props = d->v.arr.properties;
      size_t nprops = 0;
      for (size_t i = 0; props && i < props->v.obj.len; i++) nprops += insp_obj_shows(&props->v.obj.entries[i]);
      if (len == 0 && nprops == 0 && !g_show_hidden) return scr_str_new("[]", 2);
      if (recurse > depth) return scr_str_new("[Array]", 7);
      scr_insp_begin(recurse + 1);
      /* Node's maxArrayLength (100) counts output entries; a run of holes
       * is one `<n empty items>` entry (formatSpecialArray). */
      const unsigned char *presence = d->v.arr.presence;
      size_t i = 0;
      size_t shown = 0;
      for (; i < len && shown < 100; shown++) {
        if (presence && !presence[i]) {
          size_t next = i + 1;
          while (next < len && !presence[next]) next++;
          char hole[48];
          int hn = snprintf(hole, sizeof hole, "<%zu empty item%s>", next - i, next - i == 1 ? "" : "s");
          ScrStr *s = scr_str_new(hole, (size_t)hn);
          scr_insp_entry(s, false);
          scr_str_release(s);
          i = next;
          continue;
        }
        ScrDyn *item = d->v.arr.items[i++];
        ScrStr *s = scr_insp_dyn(item, recurse + 1, depth);
        scr_insp_entry(s, item->kind == SCR_DYN_NUM);
        scr_str_release(s);
      }
      bool more = i < len;
      size_t entries = shown + (more ? 1 : 0);
      if (more) {
        ScrStr *m = scr_insp_more_items((double)(len - i));
        scr_insp_entry(m, d->v.arr.items[i]->kind == SCR_DYN_NUM);
        scr_str_release(m);
      }
      if (g_show_hidden) {
        /* The own non-enumerable `length`, after the items. Node's
         * grouping reads value[k] for every output position k, this one
         * included. */
        char line[48];
        int n = snprintf(line, sizeof line, "[length]: %zu", len);
        ScrStr *s = scr_str_new(line, (size_t)n);
        scr_insp_entry(s, entries < len && (!presence || presence[entries]) &&
                              d->v.arr.items[entries]->kind == SCR_DYN_NUM);
        scr_str_release(s);
        entries++;
      }
      for (size_t k = 0; props && k < props->v.obj.len; k++) {
        const ScrDynEntry *ent = &props->v.obj.entries[k];
        if (!insp_obj_shows(ent)) continue;
        ScrStr *val = ent->accessor ? insp_accessor_tag(ent) : scr_insp_dyn(ent->value, recurse + 1, depth);
        InspBuf eb = {0};
        /* formatProperty's hidden key: the key's rendering in brackets. */
        if (!ent->enumerable) ib_char(&eb, '[');
        insp_key_into(&eb, ent->key, ent->key_len);
        if (!ent->enumerable) ib_char(&eb, ']');
        ib_cstr(&eb, ": ");
        ib_bytes(&eb, val->data, val->len);
        scr_str_release(val);
        ScrStr *entry = ib_take(&eb);
        /* Node's grouping pads by the array element at the entry's output
         * position (value[i] in groupArrayElements), not by the entry. */
        bool number = entries < len && (!presence || presence[entries]) &&
                      d->v.arr.items[entries]->kind == SCR_DYN_NUM;
        scr_insp_entry(entry, number);
        scr_str_release(entry);
        entries++;
      }
      /* Node's grouping leaves out the last entry when there are more
       * entries than maxArrayLength (100): the `... more items` entry,
       * `[length]` under showHidden, or the last property. */
      bool last_out = entries > 100;
      ScrStr *base = scr_str_new("", 0);
      ScrStr *b0 = scr_str_new("[", 1);
      ScrStr *b1 = scr_str_new("]", 1);
      ScrStr *out = scr_insp_end(base, b0, b1, recurse + 1, true, last_out);
      scr_str_release(base);
      scr_str_release(b0);
      scr_str_release(b1);
      return out;
    }
    case SCR_DYN_OBJ: {
      /* An Error carried as a checked-dynamic value (a caught error, an
       * Error stored in an `unknown` slot): the error's own rendering,
       * never the encoding's internal marker. */
      if (scr_dyn_obj_get(d, "%error", 6) != NULL) return scr_insp_dyn_error(d, recurse, depth);
      /* Object.create(null)'s dictionary: Node prefixes the rendering
       * with "[Object: null prototype]" (formatValue's constructor-less
       * base), the empty form included, and the beyond-depth answer IS
       * the bare marker (where a plain object says [Object]). */
      return scr_insp_obj(d, recurse, depth, scr_dyn_class_name(d));
    }
    case SCR_DYN_FUNC:
      return scr_insp_dyn_func(d, recurse, depth);
    case SCR_DYN_HANDLE: {
      if (d->v.handle.tag == SCR_DYNH_ARRAY_BUFFER ||
          d->v.handle.tag == SCR_DYNH_SHARED_ARRAY_BUFFER) {
        return scr_insp_array_buffer(d->v.handle.ptr, scr_dyn_handle_cls(d), recurse, depth);
      }
      if (d->v.handle.tag == SCR_DYNH_SET || d->v.handle.tag == SCR_DYNH_MAP)
        return scr_insp_dyn_collection(d, recurse, depth, d->v.handle.tag == SCR_DYNH_MAP);
      if (d->v.handle.tag == SCR_DYNH_WEAK_MAP || d->v.handle.tag == SCR_DYNH_WEAK_SET)
        return scr_insp_weak_collection(d->v.handle.tag == SCR_DYNH_WEAK_MAP ? "WeakMap" : "WeakSet",
                                        recurse, depth);
      if (d->v.handle.tag == SCR_DYNH_DATE) return scr_insp_date(scr_dyn_native_date_value(d));
      if (d->v.handle.tag == SCR_DYNH_SEARCH_PARAMS)
        return scr_insp_search_params(d->v.handle.ptr, recurse, depth);
      if (d->v.handle.tag == SCR_DYNH_ITERATOR) {
        ScrStr *iterator = scr_insp_native_iterator(d, recurse, depth);
        if (iterator) return iterator;
      }
      const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(d);
      if (ops->inspect_view) {
        /* Node's custom inspectors answer the bare class name beyond the
         * depth limit (`depth < 0`); the ones that return `this` there
         * print util.inspect's `[cls]`. */
        if (recurse > depth && !ops->inspect_view_empty) {
          /* A nested-view inspector returns the instance itself there,
           * which has no own properties: `URL {}`. */
          if (ops->inspect_view_nested) {
            InspBuf out = {0};
            ib_cstr(&out, ops->cls);
            ib_cstr(&out, " {}");
            return ib_take(&out);
          }
          if (!ops->inspect_bracketed_past_depth) return scr_str_new(ops->cls, strlen(ops->cls));
          InspBuf out = {0};
          ib_char(&out, '[');
          ib_cstr(&out, ops->cls);
          ib_char(&out, ']');
          return ib_take(&out);
        }
        ScrDyn *view = ops->inspect_view(d->v.handle.ptr);
        if (ops->inspect_view_nested) {
          scr_insp_nested_begin();
          ScrStr *inner = scr_insp_dyn(view, 0, depth);
          scr_dyn_release(view);
          ScrStr *prefix = scr_str_new(ops->cls, strlen(ops->cls));
          ScrStr *rendered = scr_insp_nested_end(prefix, inner);
          scr_str_release(prefix);
          scr_str_release(inner);
          return rendered;
        }
        ScrStr *body = scr_insp_dyn(view, recurse, depth);
        scr_dyn_release(view);
        InspBuf out = {0};
        if (insp_tag_names_class(ops->to_string_tag, ops->cls)) {
          ib_cstr(&out, ops->to_string_tag);
        } else {
          ib_cstr(&out, ops->cls);
          if (ops->to_string_tag) {
            ib_cstr(&out, " [");
            ib_cstr(&out, ops->to_string_tag);
            ib_char(&out, ']');
          }
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
      if (scr_insp_is_generator(d)) return scr_insp_generator(d);
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
      /* A class instance already on the traversal stack renders as
       * [Circular *N]. The key is the native instance, the same key the
       * compiled inspect helpers push, so a cycle through both resolves. */
      const void *instance = d->v.typed_ref.ptr;
      double circular = scr_insp_circ_check(instance);
      if (circular > 0) return scr_insp_circular(circular);
      ScrDyn *materialized = scr_dyn_typed_ref_materialize(d);
      /* A class instance prints with its class's name, which the checked
       * view of its fields does not carry. */
      const ScrStr *name = scr_dyn_typed_ref_class_name(d);
      ScrStr *out;
      double time;
      ScrStr *date_class = materialized->kind == SCR_DYN_OBJ && scr_dyn_date_class_time(d, &time)
          ? scr_dyn_date_class_name(d) : NULL;
      if (date_class) {
        /* An instance of a class declared `extends Date`: the class name and
         * the time as Date.prototype.toISOString formats it, then its own
         * enumerable properties when it has any. */
        ScrStr *iso = scr_insp_date(time);
        InspBuf head = {0};
        ib_bytes(&head, date_class->data, date_class->len);
        scr_str_release(date_class);
        ib_char(&head, ' ');
        ib_bytes(&head, iso->data, iso->len);
        scr_str_release(iso);
        ScrStr *prefix = ib_take(&head);
        bool fields = false;
        for (size_t i = 0; i < materialized->v.obj.len && !fields; i++)
          fields = materialized->v.obj.entries[i].enumerable;
        if (!fields || recurse > depth) {
          scr_dyn_release(materialized);
          return prefix;
        }
        char *cls = malloc(prefix->len + 1);
        if (!cls) scr_trap("scriptc: out of memory\n");
        memcpy(cls, prefix->data, prefix->len);
        cls[prefix->len] = '\0';
        scr_str_release(prefix);
        size_t nseen = g_nseen;
        g_pending_seen = instance;
        out = scr_insp_obj(materialized, recurse, depth, cls);
        g_pending_seen = NULL;
        if (g_nseen > nseen) g_nseen = nseen;
        free(cls);
      } else if (name && materialized->kind == SCR_DYN_OBJ &&
          scr_dyn_obj_get(materialized, "%error", 6) == NULL) {
        ScrStr *tag = insp_inherited_tag(d, name);
        if (scr_exc_pending()) {
          scr_dyn_release(materialized);
          return scr_str_new("", 0);
        }
        size_t tag_len = tag ? tag->len + 3 : 0;
        char *cls = malloc(name->len + tag_len + 1);
        if (!cls) scr_trap("scriptc: out of memory\n");
        memcpy(cls, name->data, name->len);
        if (tag) {
          /* Node's `Name [tag]` prefix. */
          memcpy(cls + name->len, " [", 2);
          memcpy(cls + name->len + 2, tag->data, tag->len);
          cls[name->len + tag_len - 1] = ']';
          scr_str_release(tag);
        }
        cls[name->len + tag_len] = '\0';
        size_t nseen = g_nseen;
        g_pending_seen = instance;
        out = scr_insp_obj(materialized, recurse, depth, cls);
        g_pending_seen = NULL;
        if (g_nseen > nseen) g_nseen = nseen;
        free(cls);
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
      if (b->is_data_view) return scr_insp_data_view(b, recurse, depth);
      if (d->buffer) {
        /* Buffer-flavored (a stream chunk): Node's <Buffer ..> form. */
        return scr_insp_buffer(b);
      }
      return scr_insp_typed_array(b, recurse, depth);
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

/* util.format's %o over a dyn value: util.inspect with showHidden at the
 * given depth. */
ScrStr *scr_insp_dyn_hidden(ScrDyn *d, double depth) {
  bool outer = g_show_hidden;
  g_show_hidden = true;
  ScrStr *out = scr_insp_dyn(d, 0, depth);
  g_show_hidden = outer;
  return out;
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
