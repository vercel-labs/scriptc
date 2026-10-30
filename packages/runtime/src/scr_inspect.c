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

/* ── colors (stylizeWithColor) ───────────────────────────────────────── */

/* ctx.colors for the render in progress: the checked-dynamic walk wraps
 * each styled leaf in inspect.colors' SGR codes for its inspect.styles
 * style, and the layout measures entries without the codes. Static
 * renderings never run with it set. */
static SCR_TL bool g_colors;

typedef enum {
  INSP_SPECIAL,
  INSP_NUMBER,
  INSP_BIGINT,
  INSP_BOOLEAN,
  INSP_UNDEFINED,
  INSP_NULL,
  INSP_STRING,
  INSP_SYMBOL,
  INSP_DATE,
} InspStyle;

/* inspect.styles mapped through inspect.colors: [open, close]. */
static const unsigned char insp_style_codes[][2] = {
    {36, 39}, /* special: cyan */
    {33, 39}, /* number: yellow */
    {33, 39}, /* bigint: yellow */
    {33, 39}, /* boolean: yellow */
    {90, 39}, /* undefined: grey */
    {1, 22},  /* null: bold */
    {32, 39}, /* string: green */
    {32, 39}, /* symbol: green */
    {35, 39}, /* date: magenta */
};

static void insp_style_open(InspBuf *b, InspStyle style) {
  char code[8];
  int n = snprintf(code, sizeof code, "\x1b[%um", insp_style_codes[style][0]);
  ib_bytes(b, code, (size_t)n);
}

static void insp_style_close(InspBuf *b, InspStyle style) {
  char code[8];
  int n = snprintf(code, sizeof code, "\x1b[%um", insp_style_codes[style][1]);
  ib_bytes(b, code, (size_t)n);
}

/* ctx.stylize(text, style): +1; moves `text` in. */
static ScrStr *insp_styled(ScrStr *text, InspStyle style) {
  if (!g_colors) return text;
  InspBuf b = {0};
  insp_style_open(&b, style);
  ib_str(&b, text);
  insp_style_close(&b, style);
  scr_str_release(text);
  return ib_take(&b);
}

static ScrStr *insp_styled_lit(const char *text, size_t len, InspStyle style) {
  return insp_styled(scr_str_new(text, len), style);
}

/* The SC2020 refusal for colored renderings of values whose styles this
 * runtime does not produce; answers an empty string. */
static ScrStr *insp_colors_fence(const char *what) {
  InspBuf b = {0};
  ib_cstr(&b, "colored inspect output of ");
  ib_cstr(&b, what);
  ib_cstr(&b, " has no lowering");
  ScrStr *message = ib_take(&b);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  scr_str_release(message);
  return scr_str_new("", 0);
}

static ScrStr *insp_colors_fence_values(const char *cls) {
  InspBuf b = {0};
  ib_cstr(&b, cls);
  ib_cstr(&b, " values");
  ScrStr *what = ib_take(&b);
  ScrStr *out = insp_colors_fence(what->data);
  scr_str_release(what);
  return out;
}

/* The SGR sequence Node's removeColors strips (\x1b[<1 or 2 digits>m) at
 * data[i]: its length, or 0. */
static size_t insp_sgr_at(const char *data, size_t len, size_t i) {
  if (data[i] != '\x1b' || i + 3 >= len || data[i + 1] != '[') return 0;
  size_t j = i + 2, digits = 0;
  while (j < len && digits < 2 && data[j] >= '0' && data[j] <= '9') j++, digits++;
  return digits > 0 && j < len && data[j] == 'm' ? j + 1 - i : 0;
}

/* A control sequence stripVTControlCharacters removes at data[i] (CSI
 * sequences after ESC [ or C1 CSI, and OSC sequences ended by BEL): its
 * length, or 0. */
static size_t insp_vt_at(const char *data, size_t len, size_t i) {
  const unsigned char *p = (const unsigned char *)data;
  size_t j;
  if (p[i] == 0x1b && i + 1 < len && p[i + 1] == '[') j = i + 2;
  else if (p[i] == 0xc2 && i + 1 < len && p[i + 1] == 0x9b) j = i + 2;
  else if (p[i] == 0x1b && i + 1 < len && p[i + 1] == ']') {
    for (j = i + 2; j < len; j++)
      if (p[j] == 0x07) return j + 1 - i;
    return 0;
  } else return 0;
  while (j < len && ((p[j] >= '0' && p[j] <= '9') || p[j] == ';' || p[j] == '?')) j++;
  if (j >= len) return 0;
  unsigned char c = p[j];
  bool final = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'P') || (c >= 'R' && c <= 'T') ||
               c == 'Z' || c == 'c' || (c >= 'f' && c <= 'n') || c == 'q' || c == 'r' ||
               c == 't' || c == 'y' || c == '=' || c == '>' || c == '<' || c == '~';
  return final ? j + 1 - i : 0;
}

/* An entry's display width for the grid (getStringWidth(entry,
 * ctx.colors)) and its UTF-16 length for the break-length test (Node's
 * removeColors under ctx.colors). */
static size_t insp_entry_width(const ScrStr *s) {
  if (!g_colors) return insp_width(s->data, s->len);
  size_t width = 0;
  for (size_t i = 0; i < s->len;) {
    size_t skip = insp_vt_at(s->data, s->len, i);
    if (skip) {
      i += skip;
      continue;
    }
    uint32_t cp = insp_cp_at(s->data, s->len, &i);
    if (insp_full_width(cp)) width += 2;
    else if (!insp_zero_width(cp)) width += 1;
  }
  return width;
}

static size_t insp_entry_len(const ScrStr *s) {
  if (!g_colors) return insp_utf16_len(s->data, s->len);
  size_t units = 0;
  for (size_t i = 0; i < s->len;) {
    size_t skip = insp_sgr_at(s->data, s->len, i);
    if (skip) {
      i += skip;
      continue;
    }
    uint32_t cp = insp_cp_at(s->data, s->len, &i);
    units += cp >= 0x10000 ? 2 : 1;
  }
  return units;
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
static SCR_TL double g_compact = 3;  /* ctx.compact: a number, -1 for false */
static SCR_TL bool g_sorted;         /* ctx.sorted === true */
static SCR_TL double g_cur_depth;    /* ctx.currentDepth (last-entered composite) */

/* util.inspect's breakLength, compact and sorted for the renders that
 * follow (compact false is -1); the call site restores 80, 3 and false
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
  return insp_styled_lit(buf, (size_t)n, INSP_SPECIAL);
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
    size_t w = insp_entry_width(f->items[i]);
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
    total += insp_entry_len(f->items[i]);
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
    int n = snprintf(buf, sizeof buf, "<ref *%d>", ref_id);
    InspBuf rb = {0};
    if (g_colors) insp_style_open(&rb, INSP_SPECIAL);
    ib_bytes(&rb, buf, (size_t)n);
    if (g_colors) insp_style_close(&rb, INSP_SPECIAL);
    if (base->len) {
      ib_char(&rb, ' ');
      ib_str(&rb, base);
    }
    ref_base = ib_take(&rb);
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

/* nested_end's restore alone: the caller's context returns. */
void scr_insp_nested_restore(void) {
  InspSaved *sv = &g_saved[--g_nsaved];
  free(g_seen);
  g_indent = sv->indent;
  g_cur_depth = sv->cur_depth;
  g_seen = sv->seen;
  g_nseen = sv->nseen;
  g_seen_cap = sv->seen_cap;
  memcpy(g_circ, sv->circ, sizeof g_circ);
  g_ncirc = sv->ncirc;
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
  size_t ncall;
  size_t indent;
  double cur_depth;
} InspMark;

static size_t insp_call_depth(void);         /* custom calls open, below */
static void insp_call_unwind(size_t ncall); /* their options, below */

static SCR_TL InspMark *g_marks;
static SCR_TL size_t g_nmarks;
static SCR_TL size_t g_marks_cap;

void scr_insp_mark(void) {
  if (g_nmarks == g_marks_cap) {
    g_marks_cap = g_marks_cap ? g_marks_cap * 2 : 4;
    g_marks = realloc(g_marks, g_marks_cap * sizeof(InspMark));
    if (!g_marks) insp_oom();
  }
  g_marks[g_nmarks++] = (InspMark){g_nframes, g_nsaved, g_nseen, insp_call_depth(), g_indent, g_cur_depth};
}

void scr_insp_unwind(void) {
  InspMark m = g_marks[--g_nmarks];
  insp_call_unwind(m.ncall);
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
        if (g_colors) insp_style_open(&out, INSP_STRING);
        insp_quote_into(&out, v + chunk_start, end - chunk_start);
        if (g_colors) insp_style_close(&out, INSP_STRING);
        chunk_start = end;
        first = false;
      }
    }
  } else {
    if (g_colors) insp_style_open(&out, INSP_STRING);
    insp_quote_into(&out, v, vlen);
    if (g_colors) insp_style_close(&out, INSP_STRING);
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
  return scr_dyn_obj_count(props) + (props->symbol_keys ? props->symbol_keys->v.arr.len : 0);
}

static ScrStr *insp_accessor_tag(const ScrDynProp *ent);
static void insp_key_into(InspBuf *b, const char *key, size_t len);

/* Slot k's `key: value` entry when it is enumerable, else NULL. */
static ScrStr *insp_view_property(ScrDyn *props, size_t k, double recurse, double depth) {
  ScrDynProp found;
  const ScrDynProp *ent = NULL;
  ScrStr *key = NULL;
  if (k < scr_dyn_obj_count(props)) {
    found = scr_dyn_obj_prop_at(props, k);
    ent = &found;
  } else {
    ScrDyn *symbol = props->symbol_keys->v.arr.items[k - scr_dyn_obj_count(props)];
    if (scr_dyn_own_symbol_prop(props, symbol, &found)) ent = &found;
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
    if (k < scr_dyn_obj_count(props)) count += scr_dyn_obj_prop_at(props, k).enumerable;
    else {
      ScrDynProp ent;
      count += scr_dyn_own_symbol_prop(props, props->symbol_keys->v.arr.items[k - scr_dyn_obj_count(props)], &ent) &&
               ent.enumerable;
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
    for (size_t i = 0; i < scr_dyn_obj_count(node); i++) {
      ScrDynProp ent = scr_dyn_obj_prop_at(node, i);
      if (ent.key_len == 5 && memcmp(ent.key, "cause", 5) == 0) {
        *enumerable = ent.enumerable;
        return ent.value;
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
  for (size_t i = 0; i < scr_dyn_obj_count(bag); i++) {
    ScrDynProp ent = scr_dyn_obj_prop_at(bag, i);
    if (ent.enumerable && !(ent.key_len == 5 && memcmp(ent.key, "cause", 5) == 0)) return true;
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
static ScrStr *insp_accessor_tag(const ScrDynProp *ent) {
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
    if (g_colors) insp_style_open(b, INSP_STRING);
    insp_quote_into(b, key, len);
    if (g_colors) insp_style_close(b, INSP_STRING);
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
static const ScrDynProp *insp_error_hidden_entry(const ScrDyn *d, const char *key, size_t len,
                                                 ScrDynProp *out) {
  size_t i = scr_dyn_obj_index_of(d, key, len);
  if (i == SIZE_MAX) return NULL;
  *out = scr_dyn_obj_prop_at(d, i);
  return out->enumerable ? NULL : out;
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
  for (size_t i = 0; i < scr_dyn_obj_count(d); i++) {
    ScrDynProp ent = scr_dyn_obj_prop_at(d, i);
    if (!ent.enumerable) continue;
    if ((ent.key_len == 4 && memcmp(ent.key, "name", 4) == 0) ||
        (ent.key_len == 7 && memcmp(ent.key, "message", 7) == 0) ||
        (ent.key_len == 5 && memcmp(ent.key, "stack", 5) == 0))
      continue;
    extra++;
  }
  /* formatError shows a non-enumerable `cause`, and an AggregateError's
   * `errors` array, after the enumerable keys: `[cause]`, `[errors]`. */
  ScrDynProp cause_prop, errors_prop;
  const ScrDynProp *cause = insp_error_hidden_entry(d, "cause", 5, &cause_prop);
  const ScrDynProp *errors = insp_error_hidden_entry(d, "errors", 6, &errors_prop);
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
  for (size_t i = 0; i < scr_dyn_obj_count(d); i++) {
    ScrDynProp ent = scr_dyn_obj_prop_at(d, i);
    if (!ent.enumerable) continue;
    if ((ent.key_len == 4 && memcmp(ent.key, "name", 4) == 0) ||
        (ent.key_len == 7 && memcmp(ent.key, "message", 7) == 0) ||
        (ent.key_len == 5 && memcmp(ent.key, "stack", 5) == 0))
      continue;
    bool shortened = assertion && ((ent.key_len == 6 && memcmp(ent.key, "actual", 6) == 0) ||
                                   (ent.key_len == 8 && memcmp(ent.key, "expected", 8) == 0));
    ScrDyn *shown = shortened ? insp_assertion_ellipsis(ent.value) : scr_dyn_retain(ent.value);
    ScrStr *val = scr_insp_dyn(shown, recurse + 1, value_depth);
    scr_dyn_release(shown);
    InspBuf eb = {0};
    insp_key_into(&eb, ent.key, ent.key_len);
    ib_cstr(&eb, ": ");
    ib_bytes(&eb, val->data, val->len);
    scr_str_release(val);
    ScrStr *entry = ib_take(&eb);
    scr_insp_entry(entry, false);
    scr_str_release(entry);
  }
  const ScrDynProp *hidden[] = {cause, errors};
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
  const char *tag = __atomic_load_n(&scr_gen_tag_reader, __ATOMIC_RELAXED)(d->v.typed_ref.ptr);
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
    return insp_styled(ib_take(&out), INSP_SPECIAL);
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
static bool scr_insp_symbol_entry(ScrDyn *d, size_t i, ScrDynProp *out) {
  return scr_dyn_own_symbol_prop(d, d->symbol_keys->v.arr.items[i], out) &&
         (out->enumerable || g_show_hidden);
}

/* An ordinary object: `Name { key: value }` with its constructor name
 * `cls` (NULL for a plain object). Node's default view lists the own
 * enumerable string keys, then the own enumerable symbol keys. */
/* An own entry this render shows: enumerable ones, and under showHidden
 * the non-enumerable ones too (never the encoding's `%` markers). */
static bool insp_obj_shows(const ScrDynProp *ent) {
  return ent->enumerable || (g_show_hidden && !(ent->key_len && ent->key[0] == '%'));
}

/* The @@toStringTag Node brackets after a plain object's prefix
 * (`Object [Math] {}`), +1: a nonempty string read through the object and
 * its prototypes, unless the object's own tag is listed with its keys
 * (an enumerable one, or any under showHidden). NULL otherwise, and when
 * the tag's getter throws, as in Node. */
static ScrStr *insp_plain_object_tag(ScrDyn *d) {
  const ScrDyn *key = scr_dyn_to_string_tag_symbol();
  if (!key) return NULL;
  ScrDynProp own;
  if (scr_dyn_own_symbol_prop(d, key, &own) && (own.enumerable || g_show_hidden)) return NULL;
  ScrDyn *tag = scr_dyn_symbol_key_get(d, key, true);
  if (!tag) {
    if (scr_exc_pending()) scr_exc_clear();
    return NULL;
  }
  ScrStr *out = tag->kind == SCR_DYN_STR && tag->v.str->len ? scr_str_retain(tag->v.str) : NULL;
  scr_dyn_release(tag);
  return out;
}

/* Node's getPrefix for a plain object, without the trailing space: "",
 * "Object [tag]" ("Object" for the tag "Object"), or the null-prototype
 * marker followed by " [tag]". +1. */
static ScrStr *insp_plain_object_prefix(const ScrDyn *d, const ScrStr *tag) {
  InspBuf out = {0};
  if (d->null_proto) ib_cstr(&out, "[Object: null prototype]");
  else if (tag) ib_cstr(&out, "Object");
  if (tag && !(tag->len == 6 && memcmp(tag->data, "Object", 6) == 0)) {
    ib_cstr(&out, " [");
    ib_bytes(&out, tag->data, tag->len);
    ib_char(&out, ']');
  }
  return ib_take(&out);
}

static ScrStr *scr_insp_obj(ScrDyn *d, double recurse, double depth, const char *cls) {
  /* A plain object with a tag takes Node's tagged prefix in all three
   * forms: `Object [Math] {}`, `[Object [Math]]` past the depth limit,
   * and `Object [Math] { key: value }`. */
  ScrStr *tag = cls ? NULL : insp_plain_object_tag(d);
  ScrStr *tagged = tag ? insp_plain_object_prefix(d, tag) : NULL;
  if (tag) scr_str_release(tag);
  size_t shown = 0;
  for (size_t i = 0; i < scr_dyn_obj_count(d); i++) {
    ScrDynProp ent = scr_dyn_obj_prop_at(d, i);
    shown += insp_obj_shows(&ent);
  }
  size_t nsymbols = d->symbol_keys ? d->symbol_keys->v.arr.len : 0;
  for (size_t i = 0; i < nsymbols; i++) {
    ScrDynProp ent;
    shown += scr_insp_symbol_entry(d, i, &ent);
  }
  if (tagged && (shown == 0 || recurse > depth)) {
    InspBuf out = {0};
    bool bracket = shown != 0 && !d->null_proto;
    if (bracket) ib_char(&out, '[');
    ib_bytes(&out, tagged->data, tagged->len);
    ib_cstr(&out, bracket ? "]" : shown == 0 ? " {}" : "");
    scr_str_release(tagged);
    return shown == 0 ? ib_take(&out) : insp_styled(ib_take(&out), INSP_SPECIAL);
  }
  if (shown == 0) {
    if (cls) return scr_insp_class_tag(cls, " {}");
    return d->null_proto ? scr_str_new("[Object: null prototype] {}", 27)
                         : scr_str_new("{}", 2);
  }
  if (recurse > depth) {
    if (cls) return insp_styled(scr_insp_class_tag(cls, NULL), INSP_SPECIAL);
    return d->null_proto ? insp_styled_lit("[Object: null prototype]", 24, INSP_SPECIAL)
                         : insp_styled_lit("[Object]", 8, INSP_SPECIAL);
  }
  scr_insp_begin(recurse + 1);
  for (size_t i = 0; i < scr_dyn_obj_count(d); i++) {
    ScrDynProp ent = scr_dyn_obj_prop_at(d, i);
    if (!insp_obj_shows(&ent)) continue;
    ScrStr *val = ent.accessor ? insp_accessor_tag(&ent) : scr_insp_dyn(ent.value, recurse + 1, depth);
    InspBuf eb = {0};
    if (ent.enumerable) {
      insp_key_into(&eb, ent.key, ent.key_len);
    } else {
      /* formatProperty's hidden key: the key's rendering in brackets. */
      ib_char(&eb, '[');
      insp_key_into(&eb, ent.key, ent.key_len);
      ib_char(&eb, ']');
    }
    ib_cstr(&eb, ": ");
    ib_bytes(&eb, val->data, val->len);
    scr_str_release(val);
    ScrStr *entry = ib_take(&eb);
    scr_insp_entry(entry, false);
    scr_str_release(entry);
    if (scr_exc_pending()) break;
  }
  for (size_t i = 0; i < nsymbols; i++) {
    ScrDynProp found;
    if (!scr_insp_symbol_entry(d, i, &found)) continue;
    const ScrDynProp *ent = &found;
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
                 : tagged        ? tagged
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
    return insp_styled_lit(tag, (size_t)n, INSP_SPECIAL);
  }
  scr_insp_begin(recurse + 1);
  size_t shown = b->len < 100 ? b->len : 100;
  for (size_t i = 0; i < shown; i++) {
    ScrStr *s = insp_styled(scr_insp_f64(scr_bytes_get(b, (double)i)), INSP_NUMBER);
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

/* ── custom inspect functions (util.inspect.custom) ──────────────────────
 * formatValue's hook: an object whose [util.inspect.custom] member is a
 * function (other than util.inspect itself, on an object that is not its
 * constructor's prototype) renders as that function's result. It runs
 * before the circular and depth checks, with the remaining depth
 * (ctx.depth - recurseTimes), the options object getUserOptions builds and
 * util.inspect. A string result is re-indented at the current level; the
 * object itself renders normally; any other value renders in its place.
 * Class instances held as checked-dynamic values have compiled methods
 * only, so one whose class defines the method throws SC2020. */
static SCR_TL bool g_custom_inspect = true; /* ctx.customInspect */
/* ctx.depth as the options gave it, for the custom functions' depth
 * argument and options when the render's depth is unbounded: 0 the number
 * g_depth_number (Infinity or NaN), 1 null, 2 undefined. */
static SCR_TL int g_depth_kind = 1;
static SCR_TL double g_depth_number;
/* The options object that held keys inspect does not read: getUserOptions
 * spreads it into the options the custom functions receive (borrowed for
 * the render). */
static SCR_TL const ScrDyn *g_user_options;

double scr_insp_depth_kind(double kind) {
  double previous = g_depth_kind;
  g_depth_kind = (int)kind;
  g_depth_number = INFINITY;
  return previous;
}

bool scr_insp_custom_inspect(bool enabled) {
  bool previous = g_custom_inspect;
  g_custom_inspect = enabled;
  return previous;
}

/* The walk's options while a custom inspect function runs. */
typedef struct {
  bool colors;
  bool show_hidden;
  bool custom_inspect;
  bool sorted;
  bool no_break;
  int depth_kind;
  double depth_number;
  double break_length;
  double compact;
  const ScrDyn *user_options;
  size_t nsaved;  /* the nested-context stack's depth before the call */
  size_t nframes; /* the frame stack's depth before the call */
} InspCallSaved;

static SCR_TL InspCallSaved *g_call_saved;
static SCR_TL size_t g_ncall_saved;
static SCR_TL size_t g_call_saved_cap;

static void insp_call_saved_cleanup(void) {
  free(g_call_saved);
  g_call_saved = NULL;
  g_ncall_saved = g_call_saved_cap = 0;
}

/* A custom inspect function's call: Node gives each util.inspect and
 * util.format call its own ctx, so the calls the function makes start
 * with no indentation, no seen objects, no colors and the default layout
 * and options. begin answers a token; end(token) restores the walk's
 * context as it was at that begin. A call that threw skips its end, and
 * an enclosing custom function's end (or the walk's, when the function
 * caught the error) discards what the throw left: the contexts of calls
 * that never ended and the frames of renders that never finished. */
double scr_insp_custom_call_begin(void) {
  size_t nsaved = g_nsaved;
  scr_insp_nested_begin();
  if (g_ncall_saved == g_call_saved_cap) {
    if (g_call_saved_cap == 0) scr_atexit(insp_call_saved_cleanup);
    g_call_saved_cap = g_call_saved_cap ? g_call_saved_cap * 2 : 4;
    g_call_saved = realloc(g_call_saved, g_call_saved_cap * sizeof(InspCallSaved));
    if (!g_call_saved) insp_oom();
  }
  double token = (double)g_ncall_saved;
  InspCallSaved *sv = &g_call_saved[g_ncall_saved++];
  sv->nsaved = nsaved;
  sv->nframes = g_nframes;
  sv->colors = g_colors;
  sv->show_hidden = g_show_hidden;
  sv->custom_inspect = g_custom_inspect;
  sv->sorted = g_sorted;
  sv->no_break = g_no_break;
  sv->depth_kind = g_depth_kind;
  sv->depth_number = g_depth_number;
  sv->break_length = g_break_length;
  sv->compact = g_compact;
  sv->user_options = g_user_options;
  g_colors = false;
  g_show_hidden = false;
  g_custom_inspect = true;
  g_no_break = false;
  g_depth_kind = 1;
  g_depth_number = 0;
  g_user_options = NULL;
  scr_insp_layout(80, 3, false);
  return token;
}

/* Restores the options saved by the custom call at `depth` and drops it
 * and every call above it; NULL when there is none. */
static InspCallSaved *insp_call_options_restore(size_t depth) {
  if (depth >= g_ncall_saved) return NULL;
  InspCallSaved *sv = &g_call_saved[depth];
  g_ncall_saved = depth;
  g_colors = sv->colors;
  g_show_hidden = sv->show_hidden;
  g_custom_inspect = sv->custom_inspect;
  g_no_break = sv->no_break;
  g_depth_kind = sv->depth_kind;
  g_depth_number = sv->depth_number;
  g_user_options = sv->user_options;
  scr_insp_layout(sv->break_length, sv->compact, sv->sorted);
  return sv;
}

void scr_insp_custom_call_end(double token) {
  InspCallSaved *sv = insp_call_options_restore((size_t)token);
  if (!sv) return; /* an enclosing end already restored it */
  while (g_nframes > sv->nframes) {
    InspFrame *f = &g_frames[--g_nframes];
    for (size_t i = 0; i < f->len; i++) scr_str_release(f->items[i]);
    free(f->items);
  }
  g_pending_seen = NULL;
  while (g_nsaved > sv->nsaved) scr_insp_nested_restore();
}

/* scr_insp_unwind's share: the options of custom calls the refused render
 * left open. */
static void insp_call_unwind(size_t ncall) { insp_call_options_restore(ncall); }

static size_t insp_call_depth(void) { return g_ncall_saved; }

/* The style inspect.styles maps a styleType to, as [open, close] codes:
 * the styles above plus regexp (red) and module (underline). false when
 * the type has no style. */
static bool insp_style_of(const ScrStr *type, unsigned *open, unsigned *close) {
  static const struct {
    const char *name;
    unsigned open, close;
  } styles[] = {
      {"special", 36, 39}, {"number", 33, 39}, {"bigint", 33, 39}, {"boolean", 33, 39},
      {"undefined", 90, 39}, {"null", 1, 22},  {"string", 32, 39}, {"symbol", 32, 39},
      {"date", 35, 39},    {"regexp", 31, 39}, {"module", 4, 24},
  };
  for (size_t i = 0; i < sizeof styles / sizeof *styles; i++) {
    if (type->len == strlen(styles[i].name) && memcmp(type->data, styles[i].name, type->len) == 0) {
      *open = styles[i].open;
      *close = styles[i].close;
      return true;
    }
  }
  return false;
}

/* options.stylize: stylizeWithColor under colors (the text in its style's
 * codes, or unchanged), stylizeNoColor otherwise (the argument itself).
 * caps[0] holds whether colors apply. */
static ScrDyn *insp_stylize_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *colors = scr_box_get_ref(closure->caps[0]);
  bool colored = colors && scr_dyn_truthy(colors);
  scr_dyn_release(colors);
  ScrDyn *text = argc > 0 ? args[0] : (ScrDyn *)scr_dyn_undefined();
  if (!colored) return scr_dyn_retain(text);
  ScrStr *str = scr_dyn_string_coerce_js(text);
  if (!str) return NULL;
  unsigned open, close;
  ScrStr *type = argc > 1 && args[1]->kind == SCR_DYN_STR ? args[1]->v.str : NULL;
  if (!type || !insp_style_of(type, &open, &close)) {
    ScrDyn *out = scr_dyn_new_str(str);
    scr_str_release(str);
    return out;
  }
  InspBuf b = {0};
  char code[8];
  int n = snprintf(code, sizeof code, "\x1b[%um", open);
  ib_bytes(&b, code, (size_t)n);
  ib_str(&b, str);
  n = snprintf(code, sizeof code, "\x1b[%um", close);
  ib_bytes(&b, code, (size_t)n);
  scr_str_release(str);
  ScrStr *styled = ib_take(&b);
  ScrDyn *out = scr_dyn_new_str(styled);
  scr_str_release(styled);
  return out;
}

static ScrDyn *insp_inspect_call(ScrClosure *closure, ScrDyn *const *args, size_t argc);

/* Whether `value` is the stylize function getUserOptions built for these
 * colors. */
static bool insp_own_stylize(const ScrDyn *value, bool colors) {
  if (value->kind != SCR_DYN_FUNC || value->v.fn.thunk != insp_stylize_call) return false;
  ScrDyn *flag = scr_box_get_ref(value->v.fn.clo->caps[0]);
  bool colored = flag && scr_dyn_truthy(flag);
  scr_dyn_release(flag);
  return colored == colors;
}

/* util.inspect as a function value (the custom functions' third
 * argument): a fresh inspect context over the call's arguments, the
 * caller's restored afterwards. One function per thread, so the argument
 * compares equal to util.inspect. +1. */
static SCR_TL ScrDyn *g_inspect_function;

static void insp_inspect_function_cleanup(void) {
  scr_dyn_release(g_inspect_function);
  g_inspect_function = NULL;
}

/* util.inspect's own members (custom, colors, styles, defaultOptions)
 * read or written through the function value: the tables are not modeled,
 * so each throws SC2020 instead of answering undefined. */
static ScrDyn *insp_inspect_member_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args; (void)argc;
  char message[128];
  int n = snprintf(message, sizeof message, "util.inspect.%s through the inspect function is not supported yet",
                   (const char *)closure->fn);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)n, "SC2020");
  return NULL;
}

static ScrDyn *insp_inspect_value(void) {
  if (!g_inspect_function) {
    ScrClosure *closure = scr_closure_new(NULL, 0);
    g_inspect_function =
        scr_dyn_new_func(closure, insp_inspect_call, 2, "native:util.inspect", "inspect");
    scr_atexit(insp_inspect_function_cleanup);
    static const char *const members[] = {"custom", "defaultOptions", "colors", "styles"};
    ScrDyn *table = scr_dyn_function_properties(g_inspect_function);
    for (size_t i = 0; i < sizeof members / sizeof members[0]; i++) {
      ScrDyn *get = scr_dyn_new_func(scr_closure_new((void *)members[i], 0), insp_inspect_member_call, 0,
                                     "native:function", members[i]);
      ScrDyn *set = scr_dyn_new_func(scr_closure_new((void *)members[i], 0), insp_inspect_member_call, 1,
                                     "native:function", members[i]);
      scr_dyn_obj_set_accessor(table, members[i], strlen(members[i]), get, set);
      scr_dyn_obj_set_attrs_at(table, scr_dyn_obj_count(table) - 1, true, false, true);
    }
    scr_dyn_release(table);
  }
  return scr_dyn_retain(g_inspect_function);
}

static void insp_opt_set(ScrDyn *options, const char *key, ScrDyn *value /* moves in */) {
  scr_dyn_obj_set(options, key, strlen(key), value);
}

/* getUserOptions(ctx) for the render in progress at `depth`. +1. */
static ScrDyn *insp_user_options(double depth) {
  ScrDyn *options = scr_dyn_new_obj();
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(closure->caps[0], scr_dyn_new_bool(g_colors));
  insp_opt_set(options, "stylize",
               scr_dyn_new_func(closure, insp_stylize_call, 2, "native:util.stylize",
                                g_colors ? "stylizeWithColor" : "stylizeNoColor"));
  insp_opt_set(options, "showHidden", scr_dyn_new_bool(false));
  insp_opt_set(options, "depth",
               isfinite(depth)      ? scr_dyn_new_num(depth)
               : g_depth_kind == 0  ? scr_dyn_new_num(g_depth_number)
               : g_depth_kind == 1  ? scr_dyn_new_null()
                                    : scr_dyn_retain(scr_dyn_undefined()));
  insp_opt_set(options, "colors", scr_dyn_new_bool(g_colors));
  insp_opt_set(options, "customInspect", scr_dyn_new_bool(true));
  insp_opt_set(options, "showProxy", scr_dyn_new_bool(false));
  insp_opt_set(options, "maxArrayLength", scr_dyn_new_num(100));
  insp_opt_set(options, "maxStringLength", scr_dyn_new_num(10000));
  insp_opt_set(options, "breakLength", scr_dyn_new_num(g_break_length));
  insp_opt_set(options, "compact", g_compact < 0 ? scr_dyn_new_bool(false) : scr_dyn_new_num(g_compact));
  insp_opt_set(options, "sorted", scr_dyn_new_bool(g_sorted));
  insp_opt_set(options, "getters", scr_dyn_new_bool(false));
  insp_opt_set(options, "numericSeparator", scr_dyn_new_bool(false));
  if (g_user_options && g_user_options->kind == SCR_DYN_OBJ) {
    for (size_t i = 0; i < scr_dyn_obj_count(g_user_options); i++) {
      ScrDynProp ent = scr_dyn_obj_prop_at(g_user_options, i);
      if (!ent.enumerable) continue;
      ScrDyn *value = scr_dyn_obj_read((ScrDyn *)g_user_options, ent.key, ent.key_len);
      if (!value) {
        scr_dyn_release(options);
        return NULL;
      }
      scr_dyn_obj_set(options, ent.key, ent.key_len, value);
    }
  }
  return options;
}

/* The custom inspect functions of the program's classes, by the type key
 * of their instances' typed refs: compiled functions (self, depth,
 * options, inspect) that call the instance's method and answer its
 * result as a checked-dynamic value. The program registers them before
 * it runs. */
typedef struct {
  char *type_key;
  ScrDyn *fn;
} InspCustomClass;

static SCR_TL InspCustomClass *g_custom_classes;
static SCR_TL size_t g_ncustom_classes;

static void insp_custom_classes_cleanup(void) {
  for (size_t i = 0; i < g_ncustom_classes; i++) {
    free(g_custom_classes[i].type_key);
    scr_dyn_release(g_custom_classes[i].fn);
  }
  free(g_custom_classes);
  g_custom_classes = NULL;
  g_ncustom_classes = 0;
}

void scr_insp_register_custom(ScrStr *type_key, ScrDyn *fn) {
  if (g_ncustom_classes == 0) scr_atexit(insp_custom_classes_cleanup);
  InspCustomClass *grown =
      realloc(g_custom_classes, (g_ncustom_classes + 1) * sizeof *g_custom_classes);
  if (!grown) insp_oom();
  g_custom_classes = grown;
  char *key = malloc(type_key->len + 1);
  if (!key) insp_oom();
  memcpy(key, type_key->data, type_key->len);
  key[type_key->len] = '\0';
  g_custom_classes[g_ncustom_classes].type_key = key;
  g_custom_classes[g_ncustom_classes].fn = scr_dyn_retain(fn);
  g_ncustom_classes++;
}

static ScrDyn *insp_custom_class_fn(const ScrDyn *d) {
  for (size_t i = 0; i < g_ncustom_classes; i++)
    if (strcmp(g_custom_classes[i].type_key, d->v.typed_ref.type_key) == 0)
      return g_custom_classes[i].fn;
  return NULL;
}

/* The [util.inspect.custom] result for an object kind, or NULL when the
 * value renders normally (*thrown reports a pending exception). +1. */
static ScrStr *insp_custom(ScrDyn *d, double recurse, double depth, bool *thrown) {
  *thrown = false;
  if (!g_custom_inspect) return NULL;
  ScrDyn *fn;
  bool compiled = d->kind == SCR_DYN_TYPED_REF;
  if (compiled) {
    /* A class instance: its class's compiled function, when it has a
     * custom inspect method. A class whose method has no compiled call
     * (the compiler refuses such classes where it renders them) refuses
     * here too. */
    fn = insp_custom_class_fn(d);
    if (!fn) {
      ScrStr *name = scr_str_new("%symbol:Symbol(nodejs.util.inspect.custom)", 42);
      bool declared = scr_dyn_typed_ref_class_has(d, name);
      scr_str_release(name);
      if (!declared) return NULL;
      static const char message[] =
          "util.inspect of this class instance's [util.inspect.custom] method has no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      *thrown = true;
      return NULL;
    }
    fn = scr_dyn_retain(fn);
  } else {
    ScrDyn *key = scr_dyn_inspect_custom_symbol();
    if (!key) return NULL;
    if (d->kind != SCR_DYN_OBJ && d->kind != SCR_DYN_ARR && d->kind != SCR_DYN_FUNC) return NULL;
    fn = scr_dyn_reflect_get(d, key, d);
    if (!fn) {
      *thrown = true;
      return NULL;
    }
  }
  if (fn->kind != SCR_DYN_FUNC || fn->v.fn.thunk == insp_inspect_call) {
    scr_dyn_release(fn);
    return NULL;
  }
  /* A constructor's prototype object renders normally. */
  ScrDyn *ctor = !compiled && d->kind == SCR_DYN_OBJ ? scr_dyn_obj_read(d, "constructor", 11) : NULL;
  if (ctor && ctor->kind == SCR_DYN_FUNC) {
    ScrDyn *prototype = scr_dyn_fn_get(ctor, "prototype", 9);
    bool own_prototype = prototype == d;
    scr_dyn_release(prototype);
    if (own_prototype) {
      scr_dyn_release(ctor);
      scr_dyn_release(fn);
      return NULL;
    }
  }
  scr_dyn_release(ctor);
  ScrDyn *args[3];
  /* ctx.depth - recurseTimes, or null for a null depth. */
  args[0] = scr_insp_custom_depth(recurse, depth);
  args[1] = insp_user_options(depth);
  if (!args[1]) {
    scr_dyn_release(args[0]);
    scr_dyn_release(fn);
    *thrown = true;
    return NULL;
  }
  args[2] = insp_inspect_value();
  ScrDyn *ret;
  double token = scr_insp_custom_call_begin();
  if (compiled) {
    ScrDyn *call[4] = {d, args[0], args[1], args[2]};
    ret = scr_dyn_call(fn, call, 4, "[nodejs.util.inspect.custom]");
  } else {
    scr_dyn_this_push_dyn(d);
    ret = scr_dyn_call(fn, args, 3, "[nodejs.util.inspect.custom]");
    scr_dyn_this_pop();
  }
  scr_insp_custom_call_end(token);
  for (size_t i = 0; i < 3; i++) scr_dyn_release(args[i]);
  scr_dyn_release(fn);
  if (!ret) {
    *thrown = true;
    return NULL;
  }
  if (ret == d || scr_insp_custom_is_self(ret, d)) {
    scr_dyn_release(ret);
    return NULL;
  }
  ScrStr *out;
  if (ret->kind == SCR_DYN_STR) out = scr_insp_custom_text(ret->v.str);
  else out = scr_insp_dyn(ret, recurse, depth);
  scr_dyn_release(ret);
  if (scr_exc_pending()) {
    scr_str_release(out);
    *thrown = true;
    return NULL;
  }
  return out;
}

bool scr_insp_custom_enabled(void) { return g_custom_inspect; }

/* ctx.depth - recurseTimes, or null for a null depth (NaN for undefined). */
ScrDyn *scr_insp_custom_depth(double recurse, double depth) {
  if (isfinite(depth)) return scr_dyn_new_num(depth - recurse);
  if (g_depth_kind == 0) return scr_dyn_new_num(g_depth_number - recurse);
  return g_depth_kind == 1 ? scr_dyn_new_null() : scr_dyn_new_num(NAN);
}

ScrDyn *scr_insp_custom_options(double depth) { return insp_user_options(depth); }

ScrDyn *scr_insp_inspect_function(void) { return insp_inspect_value(); }

bool scr_insp_custom_is_self(ScrDyn *result, ScrDyn *self) {
  return result->kind == SCR_DYN_TYPED_REF && self->kind == SCR_DYN_TYPED_REF &&
         result->v.typed_ref.ptr == self->v.typed_ref.ptr;
}

ScrStr *scr_insp_custom_result(ScrDyn *result, double recurse, double depth) {
  if (result->kind == SCR_DYN_STR) return scr_insp_custom_text(result->v.str);
  return scr_insp_dyn(result, recurse, depth);
}

/* A custom function's string result: each newline followed by the
 * current indentation. +1. */
ScrStr *scr_insp_custom_text(ScrStr *text) {
  if (!memchr(text->data, '\n', text->len)) return scr_str_retain(text);
  InspBuf out = {0};
  for (size_t i = 0; i < text->len; i++) {
    ib_char(&out, text->data[i]);
    if (text->data[i] == '\n') ib_spaces(&out, g_indent);
  }
  return ib_take(&out);
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
  } else {
    /* The base names the function's own string `name` when its table has
     * one (Object.defineProperty, util.callbackify, util.debounce). */
    size_t name_len = name ? strlen(name) : 0;
    const ScrDyn *own_name = table && table->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(table, "name", 4) : NULL;
    if (own_name && own_name->kind == SCR_DYN_STR) {
      name = own_name->v.str->data;
      name_len = own_name->v.str->len;
    }
    if (name_len) {
      ib_cstr(&out, "[Function: ");
      ib_bytes(&out, name, name_len);
      ib_char(&out, ']');
    } else {
      ib_cstr(&out, "[Function (anonymous)]");
    }
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
    for (size_t i = 0; i < scr_dyn_obj_count(table); i++) shown += scr_dyn_obj_prop_at(table, i).enumerable;
    size_t nsymbols = table->symbol_keys ? table->symbol_keys->v.arr.len : 0;
    for (size_t i = 0; i < nsymbols; i++) {
      ScrDynProp ent;
      shown += scr_insp_symbol_entry(table, i, &ent);
    }
  }
  if (shown == 0) {
    scr_dyn_release(table);
    return insp_styled(tag, INSP_SPECIAL);
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
    return insp_styled_lit("[Function]", 10, INSP_SPECIAL);
  }
  tag = insp_styled(tag, INSP_SPECIAL);
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
      /* A MIMEParams keeps its entries private: Node prints MIMEParams {}
       * with or without showHidden. */
      return d->v.handle.tag == SCR_DYNH_MAP || d->v.handle.tag == SCR_DYNH_SET ||
                     d->v.handle.tag == SCR_DYNH_DATE || d->v.handle.tag == SCR_DYNH_MIME_PARAMS
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
  if ((d->kind == SCR_DYN_TYPED_REF ? g_ncustom_classes > 0 : scr_dyn_inspect_custom_symbol() != NULL) &&
      (d->kind == SCR_DYN_OBJ || d->kind == SCR_DYN_ARR || d->kind == SCR_DYN_FUNC ||
       d->kind == SCR_DYN_TYPED_REF)) {
    bool thrown;
    ScrStr *custom = insp_custom(d, recurse, depth, &thrown);
    if (custom) return custom;
    if (thrown) return scr_str_new("", 0);
  }
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
      return insp_styled_lit("null", 4, INSP_NULL);
    case SCR_DYN_UNDEF:
      return insp_styled_lit("undefined", 9, INSP_UNDEFINED);
    case SCR_DYN_BOOL:
      return d->v.b ? insp_styled_lit("true", 4, INSP_BOOLEAN) : insp_styled_lit("false", 5, INSP_BOOLEAN);
    case SCR_DYN_BIGINT:
      return insp_styled(scr_bigint_inspect(d->v.bigint), INSP_BIGINT);
    case SCR_DYN_SYMBOL:
      return insp_styled(d->v.symbol.render(d->v.symbol.value), INSP_SYMBOL);
    case SCR_DYN_NUM:
      return insp_styled(scr_insp_f64(d->v.num), INSP_NUMBER);
    case SCR_DYN_STR:
      return scr_insp_str(d->v.str);
    case SCR_DYN_ARR: {
      size_t len = d->v.arr.len;
      /* Named and noncanonical numeric properties follow the elements as
       * `key: value` entries (Node's array extras); under showHidden the
       * own `length` comes first, and non-enumerable properties show too. */
      const ScrDyn *props = d->v.arr.properties;
      size_t nprops = 0;
      for (size_t i = 0; props && i < scr_dyn_obj_count(props); i++) {
        ScrDynProp ent = scr_dyn_obj_prop_at(props, i);
        nprops += insp_obj_shows(&ent);
      }
      /* An instance of a class that extends Array: Node's `Name(length) `
       * prefix (scr_arr_copy_metadata names the class). */
      const char *cls = props ? props->v.obj.class_name : NULL;
      char prefix[160] = "";
      if (cls) snprintf(prefix, sizeof prefix, "%.120s(%zu) ", cls, len);
      if (len == 0 && nprops == 0 && !g_show_hidden) {
        if (!cls) return scr_str_new("[]", 2);
        InspBuf eb = {0};
        ib_cstr(&eb, prefix);
        ib_cstr(&eb, "[]");
        return ib_take(&eb);
      }
      if (recurse > depth) {
        if (!cls) return insp_styled_lit("[Array]", 7, INSP_SPECIAL);
        InspBuf eb = {0};
        ib_char(&eb, '[');
        ib_cstr(&eb, cls);
        ib_char(&eb, ']');
        return insp_styled(ib_take(&eb), INSP_SPECIAL);
      }
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
          ScrStr *s = insp_styled_lit(hole, (size_t)hn, INSP_UNDEFINED);
          scr_insp_entry(s, false);
          scr_str_release(s);
          i = next;
          continue;
        }
        ScrDyn *item = d->v.arr.items[i++];
        ScrStr *s = scr_insp_dyn(item, recurse + 1, depth);
        scr_insp_entry(s, item->kind == SCR_DYN_NUM);
        scr_str_release(s);
        if (scr_exc_pending()) break;
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
      for (size_t k = 0; props && k < scr_dyn_obj_count(props); k++) {
        ScrDynProp ent = scr_dyn_obj_prop_at(props, k);
        if (!insp_obj_shows(&ent)) continue;
        ScrStr *val = ent.accessor ? insp_accessor_tag(&ent) : scr_insp_dyn(ent.value, recurse + 1, depth);
        InspBuf eb = {0};
        /* formatProperty's hidden key: the key's rendering in brackets. */
        if (!ent.enumerable) ib_char(&eb, '[');
        insp_key_into(&eb, ent.key, ent.key_len);
        if (!ent.enumerable) ib_char(&eb, ']');
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
      InspBuf ob = {0};
      ib_cstr(&ob, prefix);
      ib_char(&ob, '[');
      ScrStr *b0 = ib_take(&ob);
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
      if (scr_dyn_obj_get(d, "%error", 6) != NULL) {
        if (g_colors) return insp_colors_fence("Error values");
        return scr_insp_dyn_error(d, recurse, depth);
      }
      /* Object.create(null)'s dictionary: Node prefixes the rendering
       * with "[Object: null prototype]" (formatValue's constructor-less
       * base), the empty form included, and the beyond-depth answer IS
       * the bare marker (where a plain object says [Object]). */
      return scr_insp_obj(d, recurse, depth, scr_dyn_class_name(d));
    }
    case SCR_DYN_FUNC:
      return scr_insp_dyn_func(d, recurse, depth);
    case SCR_DYN_HANDLE: {
      if (g_colors && d->v.handle.tag != SCR_DYNH_SET && d->v.handle.tag != SCR_DYNH_MAP &&
          d->v.handle.tag != SCR_DYNH_DATE)
        return insp_colors_fence_values(scr_dyn_handle_cls(d));
      if (d->v.handle.tag == SCR_DYNH_ARRAY_BUFFER ||
          d->v.handle.tag == SCR_DYNH_SHARED_ARRAY_BUFFER) {
        return scr_insp_array_buffer(d->v.handle.ptr, scr_dyn_handle_cls(d), recurse, depth);
      }
      if (d->v.handle.tag == SCR_DYNH_SET || d->v.handle.tag == SCR_DYNH_MAP)
        return scr_insp_dyn_collection(d, recurse, depth, d->v.handle.tag == SCR_DYNH_MAP);
      if (d->v.handle.tag == SCR_DYNH_WEAK_MAP || d->v.handle.tag == SCR_DYNH_WEAK_SET)
        return scr_insp_weak_collection(d->v.handle.tag == SCR_DYNH_WEAK_MAP ? "WeakMap" : "WeakSet",
                                        recurse, depth);
      if (d->v.handle.tag == SCR_DYNH_DATE)
        return insp_styled(scr_insp_date(scr_dyn_native_date_value(d)), INSP_DATE);
      if (d->v.handle.tag == SCR_DYNH_SEARCH_PARAMS)
        return scr_insp_search_params(d->v.handle.ptr, recurse, depth);
      if (d->v.handle.tag == SCR_DYNH_ITERATOR) {
        ScrStr *iterator = scr_insp_native_iterator(d, recurse, depth);
        if (iterator) return iterator;
      }
#ifdef SCR_NODE_ISLANDS
      /* An island object prints as Node's util.inspect prints it. */
      if (d->v.handle.tag == SCR_DYNH_NODE_ISLAND) return scr_ni_inspect(d, recurse, depth);
#endif
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
      if (g_colors && scr_insp_is_generator(d)) return insp_colors_fence("generator objects");
      if (scr_insp_is_generator(d)) return scr_insp_generator(d);
      const char *cls = NULL;
      ScrDyn *view = scr_event_ref_hooks ? scr_event_ref_hooks->inspect_view(d, &cls) : NULL;
      if (view && g_colors) {
        scr_dyn_release(view);
        return insp_colors_fence_values(cls);
      }
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
      if (date_class && g_colors) {
        scr_str_release(date_class);
        scr_dyn_release(materialized);
        return insp_colors_fence("Date subclass instances");
      }
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
        for (size_t i = 0; i < scr_dyn_obj_count(materialized) && !fields; i++)
          fields = scr_dyn_obj_prop_at(materialized, i).enumerable;
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
      if (b->is_data_view && g_colors) return insp_colors_fence("DataView values");
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

ScrStr *scr_insp_dyn_format_s(ScrDyn *d, double depth) {
  /* hasBuiltInToString is false for MIMEType and MIMEParams (their
   * constructors are not globals): %s prints String(value). */
  if (d->kind == SCR_DYN_HANDLE && (d->v.handle.tag == SCR_DYNH_MIME_TYPE || d->v.handle.tag == SCR_DYNH_MIME_PARAMS))
    return scr_dyn_string_coerce_js(d);
  return scr_insp_dyn_s(d, depth);
}

/* ── util.format over checked-dynamic values ─────────────────────────────
 * formatWithOptionsInternal over argument values whose types are known
 * only at run time: util.format and util.formatWithOptions with a runtime
 * format string or spread arguments, console output with a runtime format
 * string, and debuglog's lines. The %-substitutions (%s %d %i %f %j %o %O
 * %c %%) follow Node's argument cursor, then the remaining arguments join
 * with spaces, strings verbatim and everything else inspected under the
 * options. With colors, primitives take inspect's default styles; colored
 * object renderings have no lowering. These entries call program code
 * (toString, valueOf and toJSON), so unlike the rest of this file they
 * can throw: NULL with the exception pending. */
static void insp_fmt_fence(const ScrInspFormatOptions *o, const char *what) {
  InspBuf b = {0};
  ib_cstr(&b, o->surface);
  ib_char(&b, ' ');
  ib_cstr(&b, what);
  ScrStr *message = ib_take(&b);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  scr_str_release(message);
}

static bool insp_fmt_object(const ScrDyn *value) {
  switch (value->kind) {
  case SCR_DYN_OBJ:
  case SCR_DYN_ARR:
  case SCR_DYN_FUNC:
  case SCR_DYN_BYTES:
  case SCR_DYN_HANDLE:
  case SCR_DYN_PROMISE:
  case SCR_DYN_TYPED_REF:
  case SCR_DYN_PROXY:
    return true;
  default:
    return false;
  }
}

void scr_insp_format_defaults(ScrInspFormatOptions *o, const char *surface) {
  o->surface = surface;
  o->depth = 2;
  o->depth_kind = 0;
  o->depth_number = 2;
  o->colors = false;
  o->custom_inspect = true;
  o->break_length = 80;
  o->compact = 3;
  o->sorted = false;
  o->user_options = NULL;
}

/* inspect(value, options) at the given depth, compact and colors, with
 * the options' breakLength and sorted; the previous layout returns
 * afterwards. +1, or NULL with the exception pending. */
static ScrStr *insp_fmt_inspect(ScrDyn *value, const ScrInspFormatOptions *o, double depth,
                                double compact, bool colors) {
  double break_length = g_break_length, saved_compact = g_compact;
  bool sorted = g_sorted, saved_colors = g_colors, saved_custom = g_custom_inspect;
  int saved_depth_kind = g_depth_kind;
  double saved_depth_number = g_depth_number;
  const ScrDyn *saved_user = g_user_options;
  scr_insp_layout(o->break_length, compact, o->sorted);
  g_colors = colors;
  g_custom_inspect = o->custom_inspect;
  g_depth_kind = o->depth_kind;
  g_depth_number = o->depth_number;
  g_user_options = o->user_options;
  ScrStr *text = scr_insp_dyn(value, 0, depth);
  g_colors = saved_colors;
  g_custom_inspect = saved_custom;
  g_depth_kind = saved_depth_kind;
  g_depth_number = saved_depth_number;
  g_user_options = saved_user;
  scr_insp_layout(break_length, saved_compact, sorted);
  if (scr_exc_pending()) {
    scr_str_release(text);
    return NULL;
  }
  return text;
}

/* hasBuiltInToString's negative answer: a toString the program defined on
 * the object or its prototype chain (1). Symbol-keyed members (where
 * Symbol.toPrimitive would also count) are reported as unknown (-1), and a
 * class instance whose class defines toString as -2: its methods are
 * compiled for the class's own calls, which this runtime cannot make. */
static int insp_fmt_custom_to_string(const ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrStr *to_string = scr_str_new("toString", 8);
    bool has = scr_dyn_typed_ref_class_has(value, to_string);
    scr_str_release(to_string);
    return has ? -2 : 0;
  }
  for (const ScrDyn *current = value; current && current->kind == SCR_DYN_OBJ; current = current->prototype) {
    if (current->symbol_properties) return -1;
    const ScrDyn *member = scr_dyn_obj_get(current, "toString", 8);
    if (member) return member->kind == SCR_DYN_FUNC;
  }
  return 0;
}

static ScrStr *insp_fmt_s(ScrDyn *value, const ScrInspFormatOptions *o) {
  if (value->kind == SCR_DYN_STR) return scr_str_retain(value->v.str);
  if (value->kind == SCR_DYN_NUM) return scr_insp_f64(value->v.num);
  if (value->kind == SCR_DYN_BIGINT) return scr_bigint_inspect(value->v.bigint);
  if (value->kind == SCR_DYN_HANDLE && (value->v.handle.tag == SCR_DYNH_MIME_TYPE || value->v.handle.tag == SCR_DYNH_MIME_PARAMS))
    return scr_dyn_string_coerce_js(value);
  if (value->kind == SCR_DYN_FUNC) {
    insp_fmt_fence(o, "%s of a function prints its source text, which a compiled binary does not keep");
    return NULL;
  }
  if ((value->kind == SCR_DYN_OBJ && scr_dyn_obj_get(value, "%error", 6) == NULL) ||
      value->kind == SCR_DYN_TYPED_REF) {
    int custom = insp_fmt_custom_to_string(value);
    if (custom == -2) {
      insp_fmt_fence(o, "%s of a class instance whose class defines toString has no lowering");
      return NULL;
    }
    if (custom < 0) {
      insp_fmt_fence(o, "%s of objects with symbol-keyed members has no lowering");
      return NULL;
    }
    if (custom) return scr_dyn_string_coerce_js(value);
  }
  if (!insp_fmt_object(value)) return scr_insp_dyn(value, 0, 0);
  /* inspect(arg, { ...inspectOptions, depth: 0, colors: false, compact: 3 }) */
  return insp_fmt_inspect(value, o, 0, 3, false);
}

static ScrStr *insp_fmt_number(ScrDyn *value, int spec) {
  if (value->kind == SCR_DYN_BIGINT && spec != 'f') return scr_bigint_inspect(value->v.bigint);
  if (value->kind == SCR_DYN_SYMBOL) return scr_str_new("NaN", 3);
  double number;
  if (spec == 'd') {
    if (!scr_dyn_number_coerce_js(value, &number)) return NULL;
  } else {
    ScrStr *text = scr_dyn_string_coerce_js(value);
    if (!text) return NULL;
    number = spec == 'i' ? scr_parse_int(text, 0) : scr_parse_float(text);
    scr_str_release(text);
  }
  return scr_insp_f64(number);
}

/* One formatter's conversions: %s, %j, %d/%i/%f, %O/%o and the remaining
 * arguments' inspect (depth -1: the options' depth). The loop references
 * only the table it runs, so a program links only the conversions it uses. */
typedef struct {
  ScrStr *(*s)(ScrDyn *value, const ScrInspFormatOptions *o);
  ScrStr *(*j)(const ScrDyn *value);
  ScrStr *(*number)(ScrDyn *value, int spec);
  ScrStr *(*inspect)(ScrDyn *value, const ScrInspFormatOptions *o, double depth);
} InspFmtOps;

static ScrStr *insp_format_loop(ScrDyn *const *args, size_t argc, const ScrInspFormatOptions *o,
                                const InspFmtOps *ops) {
  if (argc == 0) return scr_str_new("", 0);
  InspBuf out = {0};
  size_t a = 0;
  const char *join = "";
  if (args[0]->kind == SCR_DYN_STR) {
    const ScrStr *first = args[0]->v.str;
    if (argc == 1) return scr_str_retain((ScrStr *)first);
    const char *text = first->data;
    size_t last = 0;
    for (size_t i = 0; first->len > 0 && i < first->len - 1; i++) {
      if (text[i] != '%') continue;
      int next = (unsigned char)text[++i];
      if (a + 1 != argc) {
        ScrStr *piece = NULL;
        switch (next) {
        case 's': piece = ops->s(args[++a], o); break;
        case 'j': piece = ops->j(args[++a]); break;
        case 'd':
        case 'i':
        case 'f': piece = ops->number(args[++a], next); break;
        case 'O': piece = ops->inspect(args[++a], o, o->depth); break;
        case 'o':
          if (insp_fmt_object(args[a + 1])) {
            insp_fmt_fence(o, "%o of objects renders hidden properties, which have no lowering; use %O");
            break;
          }
          piece = ops->inspect(args[++a], o, 4);
          break;
        case 'c':
          a += 1;
          piece = scr_str_new("", 0);
          break;
        case '%':
          ib_bytes(&out, text + last, i - last);
          last = i + 1;
          continue;
        default:
          continue;
        }
        if (!piece) {
          free(out.data);
          return NULL;
        }
        if (last != i - 1) ib_bytes(&out, text + last, i - 1 - last);
        ib_str(&out, piece);
        scr_str_release(piece);
        last = i + 1;
      } else if (next == '%') {
        ib_bytes(&out, text + last, i - last);
        last = i + 1;
      }
    }
    if (last != 0) {
      a++;
      join = " ";
      if (last < first->len) ib_bytes(&out, text + last, first->len - last);
    }
  }
  for (; a < argc; a++) {
    ib_cstr(&out, join);
    if (args[a]->kind == SCR_DYN_STR) {
      ib_str(&out, args[a]->v.str);
    } else {
      ScrStr *piece = ops->inspect(args[a], o, o->depth);
      if (!piece) {
        free(out.data);
        return NULL;
      }
      ib_str(&out, piece);
      scr_str_release(piece);
    }
    join = " ";
  }
  return ib_take(&out);
}


static ScrStr *insp_fmt_inspect_full(ScrDyn *value, const ScrInspFormatOptions *o, double depth) {
  return insp_fmt_inspect(value, o, depth, o->compact, o->colors);
}

/* The conversion tables are filled where they run: a constant table is a
 * global, and sanitized builds keep instrumented globals (and the
 * conversions they point at) through --gc-sections. */
ScrStr *scr_insp_format(ScrDyn *const *args, size_t argc, const ScrInspFormatOptions *o) {
  InspFmtOps ops;
  ops.s = insp_fmt_s;
  ops.j = scr_util_format_j;
  ops.number = insp_fmt_number;
  ops.inspect = insp_fmt_inspect_full;
  return insp_format_loop(args, argc, o, &ops);
}

/* The formatter over arguments that are all strings, numbers, booleans,
 * null or undefined (the compiler proves it from their types): the same
 * rules for those kinds, without the checked-dynamic walk the other
 * values need. */
static ScrStr *insp_prim_to_string(const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_STR: return scr_str_retain(v->v.str);
  case SCR_DYN_NUM: {
    char buf[40];
    size_t n = scr_f64_to_str(v->v.num, buf);
    return scr_str_new(buf, n);
  }
  case SCR_DYN_BOOL: return v->v.b ? scr_str_new("true", 4) : scr_str_new("false", 5);
  case SCR_DYN_NULL: return scr_str_new("null", 4);
  default: return scr_str_new("undefined", 9);
  }
}

static ScrStr *insp_prim_inspect(ScrDyn *v, const ScrInspFormatOptions *o, double depth) {
  (void)o;
  (void)depth;
  if (v->kind == SCR_DYN_STR) return scr_insp_str(v->v.str);
  if (v->kind == SCR_DYN_NUM) return scr_insp_f64(v->v.num);
  return insp_prim_to_string(v);
}

static ScrStr *insp_prim_s(ScrDyn *v, const ScrInspFormatOptions *o) {
  (void)o;
  if (v->kind == SCR_DYN_NUM) return scr_insp_f64(v->v.num);
  return insp_prim_to_string(v);
}

static ScrStr *insp_prim_j(const ScrDyn *v) {
  if (v->kind == SCR_DYN_STR) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_put_json_str(&b, v->v.str);
    return scr_jb_finish(&b);
  }
  if (v->kind == SCR_DYN_NUM && !isfinite(v->v.num)) return scr_str_new("null", 4);
  return insp_prim_to_string(v);
}

static ScrStr *insp_prim_number(ScrDyn *v, int spec) {
  double number;
  if (spec == 'd') {
    number = v->kind == SCR_DYN_NUM    ? v->v.num
             : v->kind == SCR_DYN_STR  ? scr_string_to_number(v->v.str)
             : v->kind == SCR_DYN_BOOL ? (v->v.b ? 1 : 0)
             : v->kind == SCR_DYN_NULL ? 0
                                       : NAN;
  } else {
    ScrStr *text = insp_prim_to_string(v);
    number = spec == 'i' ? scr_parse_int(text, 0) : scr_parse_float(text);
    scr_str_release(text);
  }
  return scr_insp_f64(number);
}

/* A native list of checked values (the compiled format calls) as the
 * runtime's argument pack. +1. */
static ScrDyn *insp_list_pack(ScrArr *list) {
  ScrDyn *pack = scr_dyn_new_arr();
  for (uint32_t i = 0; i < list->len; i++) scr_dyn_arr_push(pack, scr_arr_get_ref(list, i));
  return pack;
}

ScrStr *scr_insp_format_primitives(ScrArr *list) {
  ScrInspFormatOptions o;
  scr_insp_format_defaults(&o, "util.format");
  ScrDyn *pack = insp_list_pack(list);
  InspFmtOps ops;
  ops.s = insp_prim_s;
  ops.j = insp_prim_j;
  ops.number = insp_prim_number;
  ops.inspect = insp_prim_inspect;
  ScrStr *out = insp_format_loop(pack->v.arr.items, pack->v.arr.len, &o, &ops);
  scr_dyn_release(pack);
  return out;
}

/* The arguments of a dyn array pack (+1 text, or NULL pending). */
static ScrStr *insp_fmt_pack(ScrDyn *pack, const ScrInspFormatOptions *o) {
  if (pack->kind != SCR_DYN_ARR) return scr_insp_format(NULL, 0, o);
  return scr_insp_format(pack->v.arr.items, pack->v.arr.len, o);
}

ScrStr *scr_insp_format_pack(ScrDyn *pack) {
  ScrInspFormatOptions o;
  scr_insp_format_defaults(&o, "util.format");
  return insp_fmt_pack(pack, &o);
}

ScrStr *scr_insp_format_list(ScrArr *list) {
  ScrDyn *pack = insp_list_pack(list);
  ScrStr *out = scr_insp_format_pack(pack);
  scr_dyn_release(pack);
  return out;
}

/* Whether a format string can substitute: a '%' before its last character.
 * A string without one formats as its arguments joined with spaces. */
bool scr_insp_format_specifies(ScrStr *first) {
  return first->len > 1 && memchr(first->data, '%', first->len - 1) != NULL;
}

bool scr_insp_format_specifies_dyn(ScrDyn *first) {
  return first->kind == SCR_DYN_STR && scr_insp_format_specifies(first->v.str);
}

/* One own enumerable option of an inspect options object: +1 value, a
 * borrowed undefined when absent, or NULL with the exception pending. */
static ScrDyn *insp_opt(const ScrDyn *options, const char *key, bool *present) {
  size_t len = strlen(key);
  *present = options->kind == SCR_DYN_OBJ && scr_dyn_obj_get(options, key, len) != NULL &&
             scr_dyn_obj_enumerable(options, key, len);
  if (!*present) return scr_dyn_retain(scr_dyn_undefined());
  return scr_dyn_obj_read(options, key, len);
}

/* ctx.depth from an option or inspect's third argument: a number, null
 * or undefined (no limit for null, undefined and NaN). */
static bool insp_depth_option(const ScrDyn *value, ScrInspFormatOptions *o) {
  if (value->kind == SCR_DYN_NUM) {
    o->depth = isnan(value->v.num) ? INFINITY : value->v.num;
    o->depth_kind = 0;
    o->depth_number = value->v.num;
  } else if (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF) {
    o->depth = INFINITY;
    o->depth_kind = value->kind == SCR_DYN_NULL ? 1 : 2;
  } else {
    return false;
  }
  return true;
}

/* inspect's option keys (inspectDefaultOptions and stylize) over an
 * options object, as `inspect(value, options)` copies them. Options at
 * their defaults, depth, colors, compact (a number or false),
 * breakLength (a number) and sorted (a boolean) lower; other values of
 * the known options throw the SC2020 refusal. */
bool scr_insp_format_read_options(const ScrDyn *options, ScrInspFormatOptions *o) {
  ScrDyn *view = NULL;
  if (options->kind == SCR_DYN_TYPED_REF) {
    view = scr_dyn_typed_ref_materialize(options);
    if (scr_exc_pending()) {
      scr_dyn_release(view);
      return false;
    }
    options = view;
  }
  bool ok = false, present;
  ScrDyn *value = NULL;
#define INSP_OPT(key)                                  \
  do {                                                 \
    scr_dyn_release(value);                            \
    value = insp_opt(options, key, &present);          \
    if (!value) goto done;                             \
  } while (0)
  INSP_OPT("depth");
  if (present) {
    if (!insp_depth_option(value, o)) {
      insp_fmt_fence(o, "with a depth option that is not a number or null has no lowering");
      goto done;
    }
  }
  INSP_OPT("colors");
  if (present) o->colors = scr_dyn_truthy(value);
  INSP_OPT("customInspect");
  if (present) o->custom_inspect = scr_dyn_truthy(value);
  INSP_OPT("compact");
  if (present) {
    if (value->kind == SCR_DYN_NUM) o->compact = value->v.num < 0 ? 0 : value->v.num;
    else if (value->kind == SCR_DYN_BOOL && !value->v.b) o->compact = -1;
    else {
      insp_fmt_fence(o, "with this compact option has no lowering (compact must be false or a number)");
      goto done;
    }
  }
  INSP_OPT("breakLength");
  if (present) {
    if (value->kind != SCR_DYN_NUM) {
      insp_fmt_fence(o, "with a breakLength option that is not a number has no lowering");
      goto done;
    }
    o->break_length = value->v.num;
  }
  INSP_OPT("sorted");
  if (present) {
    if (value->kind != SCR_DYN_BOOL) {
      insp_fmt_fence(o, "with a sorted option that is not a boolean has no lowering");
      goto done;
    }
    o->sorted = value->v.b;
  }
  /* The options whose non-default values change renderings this runtime
   * does not produce. */
  static const struct {
    const char *key;
    int kind; /* 0: falsy, 1: true, 2: the number 100, 3: the number 10000 */
  } fixed[] = {
      {"showHidden", 0}, {"showProxy", 0}, {"maxArrayLength", 2}, {"maxStringLength", 3},
      {"getters", 0},    {"numericSeparator", 0}, {"stylize", 0},
  };
  for (size_t i = 0; i < sizeof fixed / sizeof *fixed; i++) {
    INSP_OPT(fixed[i].key);
    if (!present) continue;
    bool at_default = fixed[i].kind == 0   ? !scr_dyn_truthy(value)
                      : fixed[i].kind == 1 ? value->kind == SCR_DYN_BOOL && value->v.b
                      : value->kind == SCR_DYN_NUM && value->v.num == (fixed[i].kind == 2 ? 100 : 10000);
    /* The stylize function a custom inspect function received (options
     * passed back into util.inspect) is the default for its colors. */
    if (!at_default && strcmp(fixed[i].key, "stylize") == 0 && insp_own_stylize(value, o->colors))
      at_default = true;
    /* stylize is replaced by the color stylizer when colors is set. */
    if (!at_default && !(o->colors && strcmp(fixed[i].key, "stylize") == 0)) {
      InspBuf b = {0};
      ib_cstr(&b, "with the ");
      ib_cstr(&b, fixed[i].key);
      ib_cstr(&b, " option has no lowering");
      ScrStr *what = ib_take(&b);
      insp_fmt_fence(o, what->data);
      scr_str_release(what);
      goto done;
    }
  }
#undef INSP_OPT
  /* Keys inspect does not read: the custom functions receive them. */
  if (!view && options->kind == SCR_DYN_OBJ) {
    static const char *const known[] = {
        "showHidden", "depth",    "colors",  "customInspect", "showProxy",
        "maxArrayLength", "maxStringLength", "breakLength", "compact", "sorted",
        "getters",    "numericSeparator", "stylize",
    };
    for (size_t i = 0; i < scr_dyn_obj_count(options) && !o->user_options; i++) {
      ScrDynProp ent = scr_dyn_obj_prop_at(options, i);
      if (!ent.enumerable) continue;
      bool read = false;
      for (size_t k = 0; k < sizeof known / sizeof *known && !read; k++)
        read = ent.key_len == strlen(known[k]) && memcmp(ent.key, known[k], ent.key_len) == 0;
      if (!read) o->user_options = options;
    }
  }
  ok = true;
done:
  scr_dyn_release(value);
  scr_dyn_release(view);
  return ok;
}

/* util.inspect(value[, options]) and inspect(value, showHidden, depth,
 * colors) over checked-dynamic arguments; `argc` is the call's argument
 * count. A third argument other than undefined sets the depth and a
 * fourth the colors; a boolean second argument is showHidden, and an
 * object supplies the options, which apply after the legacy arguments.
 * +1, or NULL with the exception pending. */
ScrStr *scr_insp_inspect(ScrDyn *value, ScrDyn *options, ScrDyn *depth, ScrDyn *colors,
                         double argc) {
  ScrInspFormatOptions o;
  scr_insp_format_defaults(&o, "util.inspect");
  if (argc >= 3 && depth->kind != SCR_DYN_UNDEF) {
    if (!insp_depth_option(depth, &o)) {
      insp_fmt_fence(&o, "with a depth argument that is not a number or null has no lowering");
      return NULL;
    }
  }
  if (argc >= 4 && colors->kind != SCR_DYN_UNDEF) o.colors = scr_dyn_truthy(colors);
  if (options->kind == SCR_DYN_BOOL) {
    if (options->v.b) {
      insp_fmt_fence(&o, "with showHidden has no lowering");
      return NULL;
    }
  } else if (options->kind == SCR_DYN_OBJ || options->kind == SCR_DYN_TYPED_REF) {
    if (!scr_insp_format_read_options(options, &o)) return NULL;
  }
  return insp_fmt_inspect(value, &o, o.depth, o.compact, o.colors);
}

static ScrDyn *insp_inspect_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *undefined = scr_dyn_undefined();
  scr_insp_nested_begin();
  ScrStr *text = scr_insp_inspect(argc > 0 ? args[0] : undefined, argc > 1 ? args[1] : undefined,
                                  argc > 2 ? args[2] : undefined, argc > 3 ? args[3] : undefined,
                                  (double)argc);
  scr_insp_nested_restore();
  if (!text) return NULL;
  ScrDyn *out = scr_dyn_new_str(text);
  scr_str_release(text);
  return out;
}

/* util.formatWithOptions(inspectOptions, ...pack): validateObject (arrays
 * pass, null and functions do not), then the options as inspect reads
 * them. */
ScrStr *scr_insp_format_with_options(ScrDyn *options, ScrDyn *pack) {
  if (options->kind != SCR_DYN_OBJ && options->kind != SCR_DYN_ARR &&
      options->kind != SCR_DYN_TYPED_REF) {
    scr_dyn_arg_type_fail("inspectOptions", "of type object", options);
    return NULL;
  }
  ScrInspFormatOptions o;
  scr_insp_format_defaults(&o, "util.formatWithOptions");
  if (!scr_insp_format_read_options(options, &o)) return NULL;
  return insp_fmt_pack(pack, &o);
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
      for (size_t i = 0; i < scr_dyn_obj_count(v); i++) {
        ScrDynProp ent = scr_dyn_obj_prop_at(v, i);
        if (!ent.enumerable) continue;
        if (ent.accessor) {
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
      for (size_t i = 0; i < scr_dyn_obj_count(v); i++) {
        ScrDynProp ent = scr_dyn_obj_prop_at(v, i);
        if (!ent.enumerable) continue;
        ScrStr *val = scr_insp_dyn(ent.value, 1, 0);
        InspBuf eb = {0};
        insp_key_into(&eb, ent.key, ent.key_len);
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
