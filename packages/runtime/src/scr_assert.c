/* node:assert — the static assertion surface. Every failure throws a
 * catchable AssertionError: a runtime %Error instance whose name is
 * "AssertionError" and whose code slot is "ERR_ASSERTION" (Node's
 * ERR_ASSERTION), so catch-side `instanceof Error`, `.name`, `.message`,
 * and `.code` reads all answer exactly like Node's.
 *
 * Generated messages reproduce Node's assertion_error.js for the SCALAR
 * comparisons this file receives (numbers, strings, booleans): the short
 * `a !== b` form under the 12-character budget (string quotes excluded),
 * the stacked `+ actual - expected` diff above it — including the `^`
 * first-difference indicator for string pairs — and the inline-vs-block
 * split of the not-equal operators (single-line inspect over 5 chars goes
 * on its own block). One deliberate divergence (SEMANTICS.md 103): Node
 * renders a COLORED character diff for string pairs when stderr is a
 * color TTY; this runtime always emits the plain stacked form (the
 * message text itself would be terminal-dependent in Node).
 * Deep-equality over composite values compares honestly in
 * compiler-synthesized helpers; their generated failure messages carry
 * Node's header line WITHOUT the rendered value diff (a full
 * util.inspect has no static lowering — SEMANTICS.md 102).
 *
 * Ownership: all ScrStr arguments are BORROWED; the throw helpers that
 * take ownership say so. Value inspection follows util.inspect's default
 * quoting (single quotes, then double, then backtick; C0 controls and
 * DEL escaped) — exotic C1/Unicode escapes are out of scope
 * (SEMANTICS.md 106). */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void scr_assert_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* ── a tiny append-only byte buffer for message assembly ─────────────── */

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} ScrAssertBuf;

static void ab_grow(ScrAssertBuf *b, size_t need) {
  if (b->len + need <= b->cap) return;
  size_t cap = b->cap ? b->cap * 2 : 64;
  while (cap < b->len + need) cap *= 2;
  char *data = realloc(b->data, cap);
  if (!data) scr_assert_oom();
  b->data = data;
  b->cap = cap;
}

static void ab_bytes(ScrAssertBuf *b, const char *s, size_t len) {
  ab_grow(b, len);
  memcpy(b->data + b->len, s, len);
  b->len += len;
}

static void ab_cstr(ScrAssertBuf *b, const char *s) { ab_bytes(b, s, strlen(s)); }

static void ab_char(ScrAssertBuf *b, char c) { ab_bytes(b, &c, 1); }

static void ab_str(ScrAssertBuf *b, const ScrStr *s) { ab_bytes(b, s->data, s->len); }

static ScrStr *ab_take(ScrAssertBuf *b) {
  ScrStr *out = scr_str_new(b->data ? b->data : "", b->len);
  free(b->data);
  return out;
}

/* ── value inspection (util.inspect's scalar slice) ──────────────────── */

/* Number inspection: JS ToString EXCEPT that inspect distinguishes -0. */
static size_t scr_assert_inspect_f64(double x, char *buf /* >= 33 */) {
  if (x == 0.0 && signbit(x)) {
    memcpy(buf, "-0", 3);
    return 2;
  }
  return scr_f64_to_str(x, buf);
}

/* String inspection: util.inspect's quoting — single quotes by default,
 * double quotes when the text contains ' but no ", backticks when it
 * contains both; backslash/quote/C0/DEL escaped (\b \t \n \f \r named,
 * \x0B and the rest as \xNN — inspect's own table). +1. */
ScrStr *scr_assert_inspect_str(const ScrStr *s) {
  char quote = '\'';
  bool hasSingle = false, hasDouble = false;
  for (size_t i = 0; i < s->len; i++) {
    if (s->data[i] == '\'') hasSingle = true;
    if (s->data[i] == '"') hasDouble = true;
  }
  if (hasSingle) quote = hasDouble ? '`' : '"';
  ScrAssertBuf b = {0};
  ab_char(&b, quote);
  for (size_t i = 0; i < s->len; i++) {
    unsigned char c = (unsigned char)s->data[i];
    if (c == (unsigned char)quote || c == '\\') {
      ab_char(&b, '\\');
      ab_char(&b, (char)c);
    } else if (c == '\b') {
      ab_cstr(&b, "\\b");
    } else if (c == '\t') {
      ab_cstr(&b, "\\t");
    } else if (c == '\n') {
      ab_cstr(&b, "\\n");
    } else if (c == '\f') {
      ab_cstr(&b, "\\f");
    } else if (c == '\r') {
      ab_cstr(&b, "\\r");
    } else if (c < 0x20 || c == 0x7f) {
      char esc[5];
      snprintf(esc, sizeof esc, "\\x%02X", c);
      ab_cstr(&b, esc);
    } else {
      ab_char(&b, (char)c);
    }
  }
  ab_char(&b, quote);
  return ab_take(&b);
}

/* ── the AssertionError throw ─────────────────────────────────────────── */

/* ── the AssertionError properties ─────────────────────────────────────
 * Every AssertionError carries generatedMessage, code, actual, expected,
 * operator and diff, in that key order. A failure path records actual,
 * expected and operator first (scr_assert_record); the throw attaches
 * them and clears the record. */
static SCR_TL ScrDyn *g_record_actual, *g_record_expected;
static SCR_TL const char *g_record_operator;

/* Records the next AssertionError's actual and expected (+1 each, moved
 * in; NULL is undefined) and operator (a static string; NULL is
 * undefined). */
void scr_assert_record(ScrDyn *actual, ScrDyn *expected, const char *op) {
  if (g_record_actual) scr_dyn_release(g_record_actual);
  if (g_record_expected) scr_dyn_release(g_record_expected);
  g_record_actual = actual;
  g_record_expected = expected;
  g_record_operator = op;
}

/* The compiler's form: borrowed values and an operator string. */
void scr_assert_record_dyn(ScrDyn *actual, ScrDyn *expected, ScrStr *op) {
  static const char *const operators[] = {
      "strictEqual", "notStrictEqual", "deepStrictEqual", "notDeepStrictEqual",
      "deepEqual", "notDeepEqual", "==", "!=", "fail", "throws", "doesNotThrow",
      "rejects", "doesNotReject", "match", "doesNotMatch", "ifError", "partialDeepStrictEqual",
  };
  const char *name = NULL;
  for (size_t i = 0; i < sizeof operators / sizeof operators[0]; i++) {
    if (op->len == strlen(operators[i]) && memcmp(op->data, operators[i], op->len) == 0) {
      name = operators[i];
    }
  }
  scr_assert_record(scr_dyn_retain(actual), scr_dyn_retain(expected), name);
}

static ScrDyn *scr_assert_dyn_text(const char *text) {
  ScrStr *s = scr_str_new(text, strlen(text));
  ScrDyn *d = scr_dyn_new_str(s);
  scr_str_release(s);
  return d;
}

/* Sets the error's own properties in Node's order. The values move in. */
static void scr_assert_attach_values(ScrError *e, bool generated, ScrDyn *actual, ScrDyn *expected,
                                     ScrDyn *op, ScrDyn *diff) {
  scr_error_set_prop(e, "generatedMessage", 16, scr_dyn_new_bool(generated));
  scr_error_set_code(e, "ERR_ASSERTION");
  scr_error_set_prop(e, "code", 4, scr_assert_dyn_text("ERR_ASSERTION"));
  scr_error_set_prop(e, "actual", 6, actual);
  scr_error_set_prop(e, "expected", 8, expected);
  scr_error_set_prop(e, "operator", 8, op);
  scr_error_set_prop(e, "diff", 4, diff);
}

static ScrError *scr_assert_error(ScrStr *message, bool generated, const char *diff) {
  ScrError *e = scr_error_new(SCR_ERR_ASSERTION, message);
  scr_str_release(message); /* scr_error_new retained its copy */
  e->name_present = true;
  ScrDyn *actual = g_record_actual ? g_record_actual : scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *expected = g_record_expected ? g_record_expected : scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *op = g_record_operator ? scr_assert_dyn_text(g_record_operator)
                                 : scr_dyn_retain(scr_dyn_undefined());
  g_record_actual = g_record_expected = NULL;
  g_record_operator = NULL;
  scr_assert_attach_values(e, generated, actual, expected, op, scr_assert_dyn_text(diff));
  return e;
}

/* Throws an AssertionError with `message` (ownership MOVES in) and the
 * recorded actual, expected and operator. `generated` says whether the
 * message is Node's generated one. The exception is pending on return —
 * callers return through the emitter's pending check like every other
 * throwing libCall. */
/* The options of the node:assert Assert instance whose call is running. The
 * compiled call sets them right before the runtime call
 * (scr_assert_set_options), the next AssertionError consumes them, and a
 * call that passes clears them (scr_assert_clear_options). */
enum { SCR_ASSERT_DIFF_FULL = 1, SCR_ASSERT_SKIP_PROTOTYPE = 2 };
static SCR_TL int g_instance_options;

void scr_assert_set_options(int options) { g_instance_options = options; }
void scr_assert_clear_options(void) { g_instance_options = 0; }
bool scr_assert_diff_full(void) { return (g_instance_options & SCR_ASSERT_DIFF_FULL) != 0; }
bool scr_assert_skip_prototype(void) {
  return (g_instance_options & SCR_ASSERT_SKIP_PROTOTYPE) != 0;
}

/* A message argument that is not a string (an untyped value, or an Error
 * to throw): the compiled call registers it before the assertion and passes
 * SCR_ASSERT_VALUE_MESSAGE as its message, which the failure paths compose
 * like any custom message. A failure whose message starts with it throws
 * the Error itself (innerFail's `message instanceof Error`) or puts
 * String(value) in its place with generatedMessage `!value`, as Node's
 * AssertionError does. Matching the sentinel keeps a registration that no
 * failure consumed from reaching another assertion. */
static SCR_TL ScrDyn *g_message_value;
static SCR_TL bool g_message_error;

void scr_assert_message_value(ScrDyn *value, bool error) {
  if (g_message_value) scr_dyn_release(g_message_value);
  g_message_value = scr_dyn_retain(value);
  g_message_error = error;
}

void scr_assert_message_clear(void) {
  if (g_message_value) scr_dyn_release(g_message_value);
  g_message_value = NULL;
}

void scr_assert_fail(ScrStr *message, bool generated) {
  static const char sentinel[] = SCR_ASSERT_VALUE_MESSAGE;
  const size_t n = sizeof sentinel - 1;
  if (g_message_value && message->len >= n && memcmp(message->data, sentinel, n) == 0) {
    ScrDyn *value = g_message_value;
    g_message_value = NULL;
    if (g_message_error) {
      scr_str_release(message);
      scr_assert_record(NULL, NULL, NULL);
      g_instance_options = 0;
      scr_dyn_throw(value);
      return;
    }
    ScrStr *text = scr_dyn_string_coerce_js(value);
    generated = !scr_dyn_truthy(value);
    scr_dyn_release(value);
    if (!text) {
      scr_str_release(message);
      return;
    }
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_write(&b, text->data, text->len);
    scr_jb_write(&b, message->data + n, message->len - n);
    scr_str_release(text);
    scr_str_release(message);
    message = scr_jb_finish(&b);
  }
  ScrError *e = scr_assert_error(message, generated, scr_assert_diff_full() ? "full" : "simple");
  g_instance_options = 0;
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* A custom message that Node passes to the AssertionError constructor
 * (innerFail): the message is kept as is, and generatedMessage is
 * `!message`, so the empty string counts as generated. Borrows msg. */
static void scr_assert_fail_custom(ScrStr *msg) {
  scr_assert_fail(scr_str_retain(msg), msg->len == 0);
}

/* A generated message. */
void scr_assert_fail_msg(ScrStr *message) { scr_assert_fail(message, true); }

/* assert(value) / assert.ok(value[, message]) / assert.fail([message]):
 * the frontend computed the truthiness and the FULL message (the user's
 * string, or the compile-time "The expression evaluated to a falsy
 * value:\n\n  <source text>\n" — the source is a compile-time constant
 * where Node re-reads the file). */
void scr_assert_ok(bool pass, ScrStr *message, bool generated) {
  if (pass) return;
  scr_assert_fail(scr_str_retain(message), generated);
}

/* SameValue over doubles — Object.is, the comparison of strictEqual AND
 * deepStrictEqual for numbers (NaN equals NaN; +0 and -0 differ). */
/* ── deepStrictEqual over cyclic values ────────────────────────────────
 * RECURSIVE record types permit reference cycles; Node's deep equality
 * memoizes (value1, value2) pairs so equal cyclic structures compare
 * true instead of recursing forever. The compiler-emitted per-type
 * helpers over cycle-capable types wrap their walks in enter/leave: a
 * PAIR already being compared answers equal (the coinductive step —
 * Node's memo behavior exactly). The stack is global (comparisons never
 * interleave; the emitted walks cannot throw mid-compare). */
static SCR_TL struct { const void *a, *b; } *g_deq_stack;
static SCR_TL size_t g_deq_len;
static SCR_TL size_t g_deq_cap;

bool scr_assert_deq_enter(const void *a, const void *b) {
  for (size_t i = 0; i < g_deq_len; i++) {
    if (g_deq_stack[i].a == a && g_deq_stack[i].b == b) return true;
  }
  if (g_deq_len == g_deq_cap) {
    g_deq_cap = g_deq_cap ? g_deq_cap * 2 : 8;
    g_deq_stack = realloc(g_deq_stack, g_deq_cap * sizeof *g_deq_stack);
    if (!g_deq_stack) scr_assert_oom();
  }
  g_deq_stack[g_deq_len].a = a;
  g_deq_stack[g_deq_len].b = b;
  g_deq_len++;
  return false;
}

void scr_assert_deq_leave(void) {
  if (g_deq_len > 0) g_deq_len--;
}

bool scr_assert_same_value_f64(double a, double b) {
  if (a == b) return a != 0.0 || signbit(a) == signbit(b);
  return isnan(a) && isnan(b);
}

/* ── generated equality messages (assertion_error.js, scalar slice) ──── */

static const char *scr_assert_eq_header(bool deep) {
  return deep ? "Expected values to be strictly deep-equal:"
              : "Expected values to be strictly equal:";
}

static const char *scr_assert_neq_header(bool deep) {
  return deep ? "Expected \"actual\" not to be strictly deep-equal to:"
              : "Expected \"actual\" to be strictly unequal to:";
}

/* The failing NOT-equal operators (values compared equal): the custom
 * message stands alone; the generated one inlines a short single-line
 * inspect after the header (<= 5 chars), block form otherwise. `insp` is
 * the inspected actual value (borrowed bytes). Exported for the spoke
 * files that carry their own inspection (scr_symbol.c). */
void scr_assert_neq_fail(const char *insp, size_t ilen, bool deep,
                         ScrStr *msg, bool has_msg) {
  if (has_msg) {
    scr_assert_fail_custom(msg);
    return;
  }
  ScrAssertBuf b = {0};
  ab_cstr(&b, scr_assert_neq_header(deep));
  ab_cstr(&b, ilen > 5 ? "\n\n" : " ");
  ab_bytes(&b, insp, ilen);
  scr_assert_fail_msg(ab_take(&b));
}

/* The failing EQUAL operators: createErrDiff's scalar paths — a custom
 * message replaces the HEADER (Node appends the diff below it; the empty
 * string falls back to the default header, `message ||` in Node).
 * `quotes` counts the string-typed sides (each contributes 2 quote
 * characters excluded from the short-form budget); `both_zero` is the
 * ±0-vs-±0 special case (never short); `strings` enables the stacked
 * form's first-difference `^` indicator (string pairs only, combined
 * inspected length within the 80-column non-TTY default). Exported for
 * scr_symbol.c's symbol comparison. */
void scr_assert_eq_fail(const char *ia, size_t la, const char *ib, size_t lb,
                        int quotes, bool both_zero, bool strings, bool deep,
                        ScrStr *msg, bool has_msg) {
  ScrAssertBuf b = {0};
  bool custom = has_msg && msg->len > 0;
  if (custom) {
    ab_str(&b, msg);
  } else {
    ab_cstr(&b, scr_assert_eq_header(deep));
  }
  size_t stringsLen = la + lb - (size_t)(2 * quotes);
  if (stringsLen <= 12 && !both_zero) {
    ab_cstr(&b, "\n\n");
    ab_bytes(&b, ia, la);
    ab_cstr(&b, " !== ");
    ab_bytes(&b, ib, lb);
    ab_cstr(&b, "\n");
  } else {
    ab_cstr(&b, "\n+ actual - expected\n\n+ ");
    ab_bytes(&b, ia, la);
    ab_cstr(&b, "\n- ");
    ab_bytes(&b, ib, lb);
    if (strings && la + lb <= 80) {
      /* The first-difference indicator (getStackedDiff): the first index
       * where actual's characters stop matching expected's — skipped when
       * that lands within the first two content characters (i < 3 over the
       * quoted text) or when actual is a prefix of expected. Node computes
       * this over the INSPECTED text of every simple stacked diff (numbers
       * and symbols included — getSimpleDiff hands getStackedDiff the
       * rendered strings, so its typeof-string test is always true), so
       * every scalar caller passes `strings` true. */
      size_t i = 0;
      while (i < la && i < lb && ia[i] == ib[i]) i++;
      if (i < la && i >= 3) {
        ab_char(&b, '\n');
        for (size_t k = 0; k < i + 2; k++) ab_char(&b, ' ');
        ab_char(&b, '^');
      }
    }
    ab_cstr(&b, "\n");
  }
  scr_assert_fail(ab_take(&b), !custom);
}

/* The equality operators' names, for the AssertionError's operator. */
const char *scr_assert_eq_operator(bool negated, bool deep) {
  return negated ? (deep ? "notDeepStrictEqual" : "notStrictEqual")
                 : (deep ? "deepStrictEqual" : "strictEqual");
}

/* strictEqual / notStrictEqual / deepStrictEqual / notDeepStrictEqual over
 * numbers: Object.is comparison, inspect distinguishes -0. */
void scr_assert_eq_f64(double a, double b, bool negated, bool deep,
                       ScrStr *msg, bool has_msg) {
  bool same = scr_assert_same_value_f64(a, b);
  if ((negated && !same) || (!negated && same)) return;
  scr_assert_record(scr_dyn_new_num(a), scr_dyn_new_num(b), scr_assert_eq_operator(negated, deep));
  char ia[40], ib[40];
  size_t la = scr_assert_inspect_f64(a, ia);
  if (negated) {
    scr_assert_neq_fail(ia, la, deep, msg, has_msg);
    return;
  }
  size_t lb = scr_assert_inspect_f64(b, ib);
  scr_assert_eq_fail(ia, la, ib, lb, 0, a == 0.0 && b == 0.0, true, deep, msg, has_msg);
}

/* The string forms: byte equality IS SameValue for canonical storage. */
void scr_assert_eq_str(ScrStr *a, ScrStr *b, bool negated, bool deep,
                       ScrStr *msg, bool has_msg) {
  bool same = a->len == b->len && memcmp(a->data, b->data, a->len) == 0;
  if ((negated && !same) || (!negated && same)) return;
  scr_assert_record(scr_dyn_new_str(a), scr_dyn_new_str(b), scr_assert_eq_operator(negated, deep));
  ScrStr *ia = scr_assert_inspect_str(a);
  if (negated) {
    scr_assert_neq_fail(ia->data, ia->len, deep, msg, has_msg);
    scr_str_release(ia);
    return;
  }
  ScrStr *ib = scr_assert_inspect_str(b);
  scr_assert_eq_fail(ia->data, ia->len, ib->data, ib->len, 2, false, true, deep,
                     msg, has_msg);
  scr_str_release(ia);
  scr_str_release(ib);
}

/* The boolean forms. */
void scr_assert_eq_bool(bool a, bool b, bool negated, bool deep,
                        ScrStr *msg, bool has_msg) {
  bool same = a == b;
  if ((negated && !same) || (!negated && same)) return;
  scr_assert_record(scr_dyn_new_bool(a), scr_dyn_new_bool(b), scr_assert_eq_operator(negated, deep));
  const char *ia = a ? "true" : "false";
  if (negated) {
    scr_assert_neq_fail(ia, strlen(ia), deep, msg, has_msg);
    return;
  }
  const char *ib = b ? "true" : "false";
  scr_assert_eq_fail(ia, strlen(ia), ib, strlen(ib), 0, false, true, deep, msg,
                     has_msg);
}

/* assert.equal / assert.notEqual: the frontend supplies the completed
 * Abstract Equality verdict (including Node v24's NaN-equals-NaN legacy
 * exception) and util.inspect renderings of the original operands. Node's
 * generated legacy message is one line: "actual == expected" / "actual !=
 * expected". A supplied message, including the empty string, replaces it. */
void scr_assert_loose_result(bool equal, bool negated, ScrStr *actual,
                             ScrStr *expected, ScrStr *msg, bool has_msg) {
  if ((negated && !equal) || (!negated && equal)) return;
  if (has_msg) {
    scr_assert_fail_custom(msg);
    return;
  }
  ScrAssertBuf b = {0};
  ab_str(&b, actual);
  ab_cstr(&b, negated ? " != " : " == ");
  ab_str(&b, expected);
  scr_assert_fail_msg(ab_take(&b));
}

/* deepStrictEqual / notDeepStrictEqual over COMPOSITE values: the frontend
 * synthesized the honest structural comparison; this only turns its verdict
 * into Node's throw. The generated message is the header line alone —
 * rendering the value diff needs util.inspect, which has no static
 * lowering (SEMANTICS.md 102). */
static ScrStr *scr_assert_dyn_eq_message(ScrDyn *a, ScrDyn *b, bool deep, ScrStr *msg, bool has_msg,
                                         bool full);
static ScrStr *scr_assert_dyn_neq_message(ScrDyn *a, bool deep, bool full);

void scr_assert_deep_result(bool equal, bool negated, ScrStr *msg, bool has_msg) {
  if ((negated && !equal) || (!negated && equal)) return;
  /* The compiled caller recorded actual and expected when both have a
   * checked-dynamic form; the message renders them as Node does. */
  ScrDyn *actual = g_record_actual, *expected = g_record_expected;
  if (actual && expected && actual->kind != SCR_DYN_UNDEF && expected->kind != SCR_DYN_UNDEF) {
    if (!negated) {
      scr_assert_fail(scr_assert_dyn_eq_message(actual, expected, true, msg, has_msg, scr_assert_diff_full()),
                      !(has_msg && msg->len > 0));
    } else if (has_msg) {
      scr_assert_fail_custom(msg);
    } else {
      scr_assert_fail(scr_assert_dyn_neq_message(actual, true, scr_assert_diff_full()), true);
    }
    return;
  }
  if (has_msg && (negated || msg->len > 0)) {
    /* Node: the not-equal operators use the message ALONE (even empty);
     * the equal operators use it as the diff HEADER when non-empty —
     * without a rendered diff below it the two collapse to the same
     * shape here. */
    scr_assert_fail_custom(msg);
    return;
  }
  const char *base = negated ? scr_assert_neq_header(true) : scr_assert_eq_header(true);
  scr_assert_fail_msg(scr_str_new(base, strlen(base)));
}

/* deepStrictEqual's content comparison over bytes values (the brand is
 * the frontend's compile-time question — see the header). One elem kind
 * by construction (the frontend's same-static-type gate), but the elem
 * check stays: a defensive answer beats a miscompare. */
static bool scr_assert_bytes_content_eq(const ScrBytes *a, const ScrBytes *b) {
  SCR_BYTES_SNAPSHOT(a);
  SCR_BYTES_SNAPSHOT(b);
  if (a->elem != b->elem || a->len != b->len) return false;
  size_t nbytes = a->len * scr_bytes_elem_size(a->elem);
  return nbytes == 0 || memcmp(a->data, b->data, nbytes) == 0;
}

bool scr_assert_bytes_deep_eq(const ScrBytes *a, const ScrBytes *b, bool brands_eq) {
  return brands_eq && scr_assert_bytes_content_eq(a, b);
}

/* strictEqual / notStrictEqual over bytes values: reference identity.
 * The generated messages are Node's OBJECT-comparison headers (createErrDiff
 * routes objects through the reference-equality wording, not the scalar
 * "strictly equal" one); the value renderings below them need the
 * assert-style diff engine, so the header stands alone — the composite
 * stance (SEMANTICS.md 102). */
void scr_assert_ref_eq_bytes(const ScrBytes *a, const ScrBytes *b, bool negated,
                             bool brands_eq, ScrStr *msg, bool has_msg) {
  bool same = a == b;
  if ((negated && !same) || (!negated && same)) return;
  scr_assert_record(scr_dyn_new_bytes(a), scr_dyn_new_bytes(b), scr_assert_eq_operator(negated, false));
  if (has_msg && (negated || msg->len > 0)) {
    /* The deepResult message stance: not-equal operators use it alone
     * (even empty); the equal operators use a non-empty one as the diff
     * header — headerless diffs collapse both to the message itself. */
    scr_assert_fail_custom(msg);
    return;
  }
  const char *h;
  if (negated) {
    h = "Expected \"actual\" not to be reference-equal to \"expected\":";
  } else if (brands_eq && scr_assert_bytes_content_eq(a, b)) {
    h = "Values have same structure but are not reference-equal:";
  } else {
    h = "Expected \"actual\" to be reference-equal to \"expected\":";
  }
  scr_assert_fail_msg(scr_str_new(h, strlen(h)));
}

/* strictEqual / notStrictEqual over function values: reference identity.
 * Two distinct functions are never deep-equal, so the failing equal form
 * always takes the reference-equality expectation header. */
void scr_assert_ref_eq_fn(const ScrClosure *a, const ScrClosure *b, bool negated,
                          ScrStr *msg, bool has_msg) {
  bool same = a == b;
  if ((negated && !same) || (!negated && same)) return;
  /* Function values have no runtime box here; actual and expected stay
   * undefined. */
  scr_assert_record(NULL, NULL, scr_assert_eq_operator(negated, false));
  if (has_msg && (negated || msg->len > 0)) {
    scr_assert_fail_custom(msg);
    return;
  }
  const char *h = negated
                      ? "Expected \"actual\" not to be reference-equal to \"expected\":"
                      : "Expected \"actual\" to be reference-equal to \"expected\":";
  scr_assert_fail_msg(scr_str_new(h, strlen(h)));
}

/* ── strictEqual / deepStrictEqual over CHECKED-DYNAMIC (dyn) operands ──
 * The checked-dynamic tree carries the value's kind at runtime, so one entry point serves
 * the whole quartet: SameValue for the strict pair (numbers by Object.is,
 * strings by bytes, units by kind, arrays/objects/bytes by node identity,
 * functions by the BOXED CLOSURE — two dyn crossings of one function are
 * the same JS function), a structural dyn walk for the deep pair.
 *
 * Failure messages reproduce Node's assertion_error.js against the v24
 * sources: inspectValue is a compact:false / sorted:true / depth-1000
 * rendering of the checked-dynamic tree (each entry on its own line, entries sorted by
 * their RENDERED text — Node's `sorted: true` sorts formatted entries),
 * the simple/stacked scalar forms match the static paths exactly,
 * and composite diffs run the real myers line diff with Node's printer
 * (5 context lines, then "..." and the "... Skipped lines" banner, comma
 * disparity between object lines treated as equal). Known divergences:
 * key sorting is UTF-8 byte order where Node sorts UTF-16 code units
 * (identical for ASCII keys), dyn function props are not rendered after
 * the [Function: name] form, and values rendering past ~4096 lines fall
 * back to the whole-value +/- form without context collapsing. */

/* JS SameValue over two dyn values (Object.is — the strictEqual and
 * notStrictEqual comparison). Functions compare by boxed closure: the
 * ScrDyn box is a boundary artifact, the closure IS the JS identity. */
static bool scr_assert_dyn_same_value(const ScrDyn *a, const ScrDyn *b) {
  if (a->kind != b->kind) return false;
  switch (a->kind) {
    case SCR_DYN_SYMBOL:
      return a->v.symbol.value == b->v.symbol.value;
    case SCR_DYN_UNDEF:
    case SCR_DYN_NULL:
      return true;
    case SCR_DYN_BOOL:
      return a->v.b == b->v.b;
    case SCR_DYN_BIGINT:
      return scr_bigint_eq(a->v.bigint, b->v.bigint);
    case SCR_DYN_NUM:
      return scr_assert_same_value_f64(a->v.num, b->v.num);
    case SCR_DYN_STR:
      return a->v.str->len == b->v.str->len &&
             memcmp(a->v.str->data, b->v.str->data, a->v.str->len) == 0;
    case SCR_DYN_FUNC:
      return scr_dyn_strict_eq(a, b);
    case SCR_DYN_HANDLE:
      /* Identity is the HANDLE (the strict_eq stance). */
      return a->v.handle.tag == b->v.handle.tag && a->v.handle.ptr == b->v.handle.ptr;
    case SCR_DYN_PROMISE:
      /* Identity is the PROMISE (the strict_eq stance). */
      return a->v.promise == b->v.promise;

    case SCR_DYN_TYPED_REF:
      return scr_dyn_strict_eq(a, b);
    default:
      return a == b; /* ARR/OBJ/BYTES: node identity */
  }
}

/* Node's strict deep equality over two dyn values: kind-wise — Object.is
 * numbers, byte-equal strings, units by kind, per-element arrays,
 * key-set-plus-values objects (dyn keys are unique, so equal lengths and
 * an a⊆b value walk prove the bijection), brand-aware bytes (the buffer
 * flavor bit IS the Buffer-vs-Uint8Array prototype Node compares first),
 * reference identity for functions (boxed closure). Plain recursion:
 * JSON-origin dyn values are trees; a keyed-write cycle (h.self = h) has no
 * memo here where Node carries one (documented divergence). */
static const ScrDyn *scr_assert_loose_error_prop(const ScrDyn *d, const char *key, size_t len);

static bool scr_assert_dyn_deep_eq(const ScrDyn *a, const ScrDyn *b) {
  if (a == b) return true;
  if (a->kind == SCR_DYN_PROXY || b->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("deep equality");
    return false;
  }
  if (a->kind == SCR_DYN_TYPED_REF || b->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *ma = a->kind == SCR_DYN_TYPED_REF
                     ? scr_dyn_typed_ref_materialize(a)
                     : scr_dyn_retain((ScrDyn *)a);
    ScrDyn *mb = b->kind == SCR_DYN_TYPED_REF
                     ? scr_dyn_typed_ref_materialize(b)
                     : scr_dyn_retain((ScrDyn *)b);
    bool same = scr_assert_dyn_deep_eq(ma, mb);
    scr_dyn_release(ma);
    scr_dyn_release(mb);
    return same;
  }
  if (a->kind != b->kind) {


    return false;
  }
  switch (a->kind) {
    case SCR_DYN_SYMBOL:
      return a->v.symbol.value == b->v.symbol.value;
    case SCR_DYN_UNDEF:
    case SCR_DYN_NULL:
      return true;
    case SCR_DYN_BOOL:
      return a->v.b == b->v.b;
    case SCR_DYN_BIGINT:
      return scr_bigint_eq(a->v.bigint, b->v.bigint);
    case SCR_DYN_NUM:
      return scr_assert_same_value_f64(a->v.num, b->v.num);
    case SCR_DYN_STR:
      return a->v.str->len == b->v.str->len &&
             memcmp(a->v.str->data, b->v.str->data, a->v.str->len) == 0;
    case SCR_DYN_FUNC:
      return scr_dyn_strict_eq(a, b);
    case SCR_DYN_HANDLE:
      /* Node's deepStrictEqual over two distinct live handles walks own
       * enumerable props we do not model; same-handle is the only case a
       * compiled test can honestly answer (documented). */
      return a->v.handle.tag == b->v.handle.tag && a->v.handle.ptr == b->v.handle.ptr;
    case SCR_DYN_PROMISE:
      /* Node compares promises structurally (no own props → equal); the
       * honest arm here is identity — two distinct promises with equal
       * settlements would diverge (documented with the handle stance). */
      return a->v.promise == b->v.promise;
    case SCR_DYN_BYTES: {
      /* The prototype gate, unless the Assert instance skips it. */
      if (a->buffer != b->buffer && !scr_assert_skip_prototype()) return false;
      const ScrBytes *x = a->v.bytes, *y = b->v.bytes;
      if (x->elem != y->elem || x->len != y->len) return false;
      return scr_assert_bytes_content_eq(x, y);
    }
    case SCR_DYN_ARR: {
      if (a->v.arr.len != b->v.arr.len) return false;
      for (size_t i = 0; i < a->v.arr.len; i++) {
        if (!scr_assert_dyn_deep_eq(a->v.arr.items[i], b->v.arr.items[i])) return false;
      }
      if (a->v.arr.properties || b->v.arr.properties) {
        if (!a->v.arr.properties || !b->v.arr.properties) {
          const ScrDyn *table = a->v.arr.properties ? a->v.arr.properties : b->v.arr.properties;
          if (scr_dyn_obj_count(table) != 0) return false;
        } else if (!scr_assert_dyn_deep_eq(a->v.arr.properties, b->v.arr.properties)) return false;
      }
      return true;
    }
    case SCR_DYN_OBJ: {
      if (scr_assert_skip_prototype()) {
        /* Node's error arm runs without the prototype check: both sides
         * are errors with the same name and message. */
        bool ea = scr_dyn_obj_get(a, "%error", 6) != NULL;
        bool eb = scr_dyn_obj_get(b, "%error", 6) != NULL;
        if (ea != eb) return false;
        if (ea && (!scr_assert_dyn_deep_eq(scr_assert_loose_error_prop(a, "name", 4),
                                           scr_assert_loose_error_prop(b, "name", 4)) ||
                   !scr_assert_dyn_deep_eq(scr_assert_loose_error_prop(a, "message", 7),
                                           scr_assert_loose_error_prop(b, "message", 7))))
          return false;
      } else if (a->null_proto != b->null_proto || a->prototype != b->prototype) {
        return false;
      }
      if (scr_dyn_obj_count(a) != scr_dyn_obj_count(b)) return false;
      for (size_t i = 0; i < scr_dyn_obj_count(a); i++) {
        ScrDynProp ent = scr_dyn_obj_prop_at(a, i);
        ScrDyn *bv = scr_dyn_obj_get(b, ent.key, ent.key_len);
        if (!bv || !scr_assert_dyn_deep_eq(ent.value, bv)) return false;
      }
      return true;
    }

    case SCR_DYN_TYPED_REF:
      return false; /* both mixed and same-kind capsules returned above */
  }
  return false; /* unreachable */
}

/* ── loose deep equality (Node's isDeepEqual) ───────────────────────────
 * comparisons.js in kLoose mode over two dyn values: primitives compare
 * with == (NaN equals NaN), there is no prototype check, an array element
 * matches a null element on the expected side, typed arrays compare by
 * tag with float elements compared by ===, and Sets and Maps match their
 * entries in Node's order, including the loosely equal primitive keys.
 * Like the strict walk, it has no cycle memo. */

static bool scr_assert_loose_eq(const ScrDyn *a, const ScrDyn *b);

static bool scr_assert_loose_object(const ScrDyn *d) {
  switch (d->kind) {
    case SCR_DYN_ARR:
    case SCR_DYN_OBJ:
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

static bool scr_assert_loose_nan(const ScrDyn *d) {
  return d->kind == SCR_DYN_NUM && d->v.num != d->v.num;
}

/* The value of an enumerable own property, or NULL. Borrowed. */
static const ScrDyn *scr_assert_loose_entry(const ScrDyn *d, const char *key, size_t len) {
  size_t i = scr_dyn_obj_index_of(d, key, len);
  if (i == SIZE_MAX) return NULL;
  ScrDynProp ent = scr_dyn_obj_prop_at(d, i);
  return ent.enumerable ? ent.value : NULL;
}

static bool scr_assert_loose_counted(ScrDynProp ent) {
  return ent.enumerable && !(ent.key_len == 6 && memcmp(ent.key, "%error", 6) == 0);
}

/* keyCheck and objEquiv over two objects' enumerable own keys. */
static bool scr_assert_loose_keys(const ScrDyn *a, const ScrDyn *b) {
  size_t na = 0, nb = 0;
  for (size_t i = 0; i < scr_dyn_obj_count(a); i++) na += scr_assert_loose_counted(scr_dyn_obj_prop_at(a, i));
  for (size_t i = 0; i < scr_dyn_obj_count(b); i++) nb += scr_assert_loose_counted(scr_dyn_obj_prop_at(b, i));
  if (na != nb) return false;
  for (size_t i = 0; i < scr_dyn_obj_count(b); i++) {
    ScrDynProp ent = scr_dyn_obj_prop_at(b, i);
    if (!scr_assert_loose_counted(ent)) continue;
    const ScrDyn *other = scr_assert_loose_entry(a, ent.key, ent.key_len);
    if (!other || !scr_assert_loose_eq(other, ent.value)) return false;
  }
  return true;
}

/* An error property read through the prototype chain; undefined when
 * absent. Borrowed. */
static const ScrDyn *scr_assert_loose_error_prop(const ScrDyn *d, const char *key, size_t len) {
  for (const ScrDyn *o = d; o && o->kind == SCR_DYN_OBJ; o = o->prototype) {
    const ScrDyn *v = scr_dyn_obj_get(o, key, len);
    if (v) return v;
  }
  return scr_dyn_undefined();
}

/* isError's arm: message, name, cause and errors compare unless the
 * expected side has them as enumerable own keys, and an own cause must
 * be own on both sides. */
static bool scr_assert_loose_error(const ScrDyn *a, const ScrDyn *b) {
  static const char *const props[] = {"message", "name", "cause", "errors"};
  for (size_t i = 0; i < 4; i++) {
    size_t len = strlen(props[i]);
    if (scr_assert_loose_entry(b, props[i], len)) continue;
    if (!scr_assert_loose_eq(scr_assert_loose_error_prop(a, props[i], len),
                             scr_assert_loose_error_prop(b, props[i], len)))
      return false;
  }
  if ((scr_dyn_obj_get(a, "cause", 5) != NULL) != (scr_dyn_obj_get(b, "cause", 5) != NULL)) return false;
  return true;
}

static bool scr_assert_loose_float_elem(ScrBytesElem elem) {
  return elem == SCR_BYTES_F16 || elem == SCR_BYTES_F32 || elem == SCR_BYTES_F64;
}

/* Typed arrays and Buffers: the same tag (a Buffer is a Uint8Array here),
 * float elements compared by ===, other elements by their bytes. */
bool scr_assert_loose_bytes_eq(const ScrBytes *x, const ScrBytes *y) {
  if (x->elem != y->elem || x->is_data_view != y->is_data_view || x->len != y->len) return false;
  if (!scr_assert_loose_float_elem(x->elem)) return scr_assert_bytes_content_eq(x, y);
  for (size_t i = 0; i < x->len; i++) {
    if (scr_bytes_get(x, (double)i) != scr_bytes_get(y, (double)i)) return false;
  }
  return true;
}

/* Two numbers under ==, with NaN equal to NaN. */
bool scr_assert_loose_f64_eq(double a, double b) {
  return a == b || (a != a && b != b);
}

static bool scr_assert_loose_bytes(const ScrDyn *a, const ScrDyn *b) {
  return scr_assert_loose_bytes_eq(a->v.bytes, b->v.bytes);
}

/* A RegExp handle's property through its handle ops (+1, never NULL). */
static ScrDyn *scr_assert_loose_regex_prop(const ScrDyn *d, const char *key) {
  const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(d);
  ScrDyn *v = ops && ops->get ? ops->get(d->v.handle.ptr, key, strlen(key)) : NULL;
  return v ? v : scr_dyn_retain(scr_dyn_undefined());
}

static bool scr_assert_loose_regex(const ScrDyn *a, const ScrDyn *b) {
  static const char *const props[] = {"source", "flags", "lastIndex"};
  for (size_t i = 0; i < 3; i++) {
    ScrDyn *x = scr_assert_loose_regex_prop(a, props[i]);
    ScrDyn *y = scr_assert_loose_regex_prop(b, props[i]);
    bool same = scr_dyn_strict_eq(x, y);
    scr_dyn_release(x);
    scr_dyn_release(y);
    if (!same) return false;
  }
  return true;
}

/* A Set's or Map's live keys (or values), in insertion order, +1 each. */
typedef struct {
  ScrDyn **items;
  size_t len;
} ScrAssertDynList;

static ScrAssertDynList scr_assert_loose_list(ScrMap *map, bool values) {
  ScrAssertDynList list = {0};
  size_t cap = 0;
  scr_map_iter_enter(map);
  for (double i = 0; i < scr_map_iter_count(map); i++) {
    if (!scr_map_iter_live(map, i)) continue;
    if (list.len == cap) {
      cap = cap ? cap * 2 : 8;
      ScrDyn **grown = realloc(list.items, cap * sizeof *grown);
      if (!grown) scr_trap("scriptc: out of memory\n");
      list.items = grown;
    }
    list.items[list.len++] = values ? scr_map_dyn_value(map, i) : scr_map_dyn_key(map, i);
  }
  scr_map_iter_exit(map);
  return list;
}

static void scr_assert_loose_list_free(ScrAssertDynList *list) {
  for (size_t i = 0; i < list->len; i++) scr_dyn_release(list->items[i]);
  free(list->items);
  list->items = NULL;
  list->len = 0;
}

static size_t scr_assert_loose_size(ScrMap *map) {
  size_t size = 0;
  for (double i = 0; i < scr_map_iter_count(map); i++) size += scr_map_iter_live(map, i);
  return size;
}

/* findLooseMatchingPrimitives: 1 (true), 0 (false), or -1 for undefined
 * (whose alternative is null) and -2 for null (whose alternative is
 * undefined). */
static int scr_assert_loose_alternative(const ScrDyn *prim) {
  switch (prim->kind) {
    case SCR_DYN_UNDEF:
      return -1;
    case SCR_DYN_NULL:
      return -2;
    case SCR_DYN_SYMBOL:
      return 0;
    case SCR_DYN_STR: {
      double n;
      if (!scr_dyn_number_coerce_js(prim, &n)) return 0;
      return n == n;
    }
    case SCR_DYN_NUM:
      return prim->v.num == prim->v.num;
    default:
      return 1;
  }
}

/* The alternative of an undefined or null primitive, +1. */
static ScrDyn *scr_assert_loose_alternative_value(int alt) {
  return alt == -1 ? scr_dyn_new_null() : scr_dyn_retain(scr_dyn_undefined());
}

static bool scr_assert_loose_set_might_have(ScrMap *a, ScrMap *b, const ScrDyn *prim) {
  int alt = scr_assert_loose_alternative(prim);
  if (alt >= 0) return alt == 1;
  ScrDyn *value = scr_assert_loose_alternative_value(alt);
  bool might = !scr_map_dyn_has(b, value, false) && scr_map_dyn_has(a, value, false);
  scr_dyn_release(value);
  return might;
}

static bool scr_assert_loose_map_might_have(ScrMap *a, ScrMap *b, const ScrDyn *prim, const ScrDyn *item2) {
  int alt = scr_assert_loose_alternative(prim);
  if (alt >= 0) return alt == 1;
  ScrDyn *key = scr_assert_loose_alternative_value(alt);
  bool might = false;
  if (scr_map_dyn_has(a, key, false)) {
    ScrDyn *item1 = scr_map_dyn_get(a, key);
    might = item1 && scr_assert_loose_eq(item1, item2) && !scr_map_dyn_has(b, key, false);
    if (item1) scr_dyn_release(item1);
  }
  scr_dyn_release(key);
  return might;
}

/* arrayHasEqualElement: searches array[start..end) from the end; a match
 * is replaced by array[end]. */
static bool scr_assert_loose_array_has(ScrDyn **array, const ScrDyn *val1, size_t start, size_t end) {
  for (size_t i = end; i-- > start;) {
    if (scr_assert_loose_eq(val1, array[i])) {
      ScrDyn *held = array[i];
      array[i] = array[end];
      array[end] = held;
      return true;
    }
  }
  return false;
}

static bool scr_assert_loose_set_objects(ScrDyn **array, size_t count, ScrAssertDynList *a, ScrMap *b) {
  int direction = 1;
  size_t start = 0, end = count - 1;
  for (size_t k = 0; k < a->len; k++) {
    const ScrDyn *val1 = a->items[k];
    if (scr_map_dyn_has(b, val1, false)) continue;
    size_t inner = start;
    if (direction == 1) {
      if (scr_assert_loose_eq(val1, array[start])) {
        start++;
        continue;
      }
      if (start == end) return false;
      direction = -1;
      inner++;
    }
    if (!scr_assert_loose_eq(val1, array[end])) {
      direction = 1;
      if (!scr_assert_loose_array_has(array, val1, inner, end)) return false;
    }
    end--;
  }
  return true;
}

typedef bool (*ScrAssertDynEq)(const ScrDyn *a, const ScrDyn *b);

/* compareSmallSets, under the mode's comparator. */
static bool scr_assert_small_sets(ScrAssertDynEq eq, ScrAssertDynList *a, ScrMap *b, const ScrDyn *val,
                                  ScrAssertDynList *b_values, size_t b_next) {
  /* iteratorB.next(): the element after val, or undefined. */
  const ScrDyn *next_b = b_next < b_values->len ? b_values->items[b_next] : scr_dyn_undefined();
  const ScrDyn *first_a = a->items[0];
  if (eq(first_a, val)) {
    if (b_values->len == 1) return true;
    const ScrDyn *second_a = a->items[1];
    return scr_map_dyn_has(b, second_a, false) || eq(second_a, next_b);
  }
  if (a->len == 1 || !eq(a->items[1], val)) return false;
  return b_values->len == 1 || scr_map_dyn_has(b, first_a, false) || eq(first_a, next_b);
}

static bool scr_assert_loose_set(ScrMap *a, ScrMap *b) {
  size_t size = scr_assert_loose_size(a);
  if (size != scr_assert_loose_size(b)) return false;
  ScrAssertDynList av = scr_assert_loose_list(a, false);
  ScrAssertDynList bv = scr_assert_loose_list(b, false);
  ScrDyn **array = NULL;
  size_t count = 0;
  int result = -1;
  for (size_t i = 0; i < bv.len && result < 0; i++) {
    const ScrDyn *val = bv.items[i];
    if (scr_map_dyn_has(a, val, false)) continue;
    if (!scr_assert_loose_object(val) && !scr_assert_loose_set_might_have(a, b, val)) {
      result = 0;
      break;
    }
    if (!array) {
      if (size < 3) {
        result = scr_assert_small_sets(scr_assert_loose_eq, &av, b, val, &bv, i + 1);
        break;
      }
      array = malloc(bv.len * sizeof *array);
      if (!array) scr_trap("scriptc: out of memory\n");
    }
    array[count++] = (ScrDyn *)val;
  }
  if (result < 0) result = array ? scr_assert_loose_set_objects(array, count, &av, b) : 1;
  free(array);
  scr_assert_loose_list_free(&av);
  scr_assert_loose_list_free(&bv);
  return result == 1;
}

static bool scr_assert_loose_map_entry(ScrMap *b, const ScrDyn *key1, const ScrDyn *item1, const ScrDyn *key2) {
  if (!scr_assert_loose_eq(key1, key2)) return false;
  ScrDyn *item2 = scr_map_dyn_get(b, key2);
  bool same = item2 && scr_assert_loose_eq(item1, item2);
  if (item2) scr_dyn_release(item2);
  return same;
}

static bool scr_assert_loose_map_array_has(ScrDyn **array, const ScrDyn *key1, const ScrDyn *item1, ScrMap *b,
                                           size_t start, size_t end) {
  for (size_t i = end; i-- > start;) {
    if (scr_assert_loose_map_entry(b, key1, item1, array[i])) {
      ScrDyn *held = array[i];
      array[i] = array[end];
      array[end] = held;
      return true;
    }
  }
  return false;
}

static bool scr_assert_loose_map_objects(ScrDyn **array, size_t count, ScrAssertDynList *ak,
                                         ScrAssertDynList *avals, ScrMap *b) {
  int direction = 1;
  size_t start = 0, end = count - 1;
  for (size_t k = 0; k < ak->len; k++) {
    const ScrDyn *key1 = ak->items[k], *item1 = avals->items[k];
    if (!scr_assert_loose_object(key1) && scr_map_dyn_has(b, key1, false)) {
      ScrDyn *item2 = scr_map_dyn_get(b, key1);
      bool same = item2 && scr_assert_loose_eq(item1, item2);
      if (item2) scr_dyn_release(item2);
      if (same) continue;
    }
    size_t inner = start;
    if (direction == 1) {
      if (scr_assert_loose_map_entry(b, key1, item1, array[start])) {
        start++;
        continue;
      }
      if (start == end) return false;
      direction = -1;
      inner++;
    }
    if (!scr_assert_loose_map_entry(b, key1, item1, array[end])) {
      direction = 1;
      if (!scr_assert_loose_map_array_has(array, key1, item1, b, inner, end)) return false;
    }
    end--;
  }
  return true;
}

static bool scr_assert_loose_map(ScrMap *a, ScrMap *b) {
  size_t size = scr_assert_loose_size(a);
  if (size != scr_assert_loose_size(b)) return false;
  ScrAssertDynList ak = scr_assert_loose_list(a, false);
  ScrAssertDynList avals = scr_assert_loose_list(a, true);
  ScrAssertDynList bk = scr_assert_loose_list(b, false);
  ScrAssertDynList bvals = scr_assert_loose_list(b, true);
  ScrDyn **array = NULL;
  size_t count = 0;
  int result = -1;
  for (size_t i = 0; i < bk.len && result < 0; i++) {
    const ScrDyn *key2 = bk.items[i], *item2 = bvals.items[i];
    if (scr_assert_loose_object(key2)) {
      if (!array) {
        if (size == 1) {
          result = scr_assert_loose_eq(ak.items[0], key2) && scr_assert_loose_eq(avals.items[0], item2);
          break;
        }
        array = malloc(bk.len * sizeof *array);
        if (!array) scr_trap("scriptc: out of memory\n");
      }
      array[count++] = (ScrDyn *)key2;
      continue;
    }
    bool present = scr_map_dyn_has(a, key2, false);
    ScrDyn *item1 = present ? scr_map_dyn_get(a, key2) : NULL;
    bool same = item1 && scr_assert_loose_eq(item1, item2);
    if (item1) scr_dyn_release(item1);
    if (same) continue;
    if (!scr_assert_loose_map_might_have(a, b, key2, item2)) {
      result = 0;
      break;
    }
    if (!array) {
      array = malloc(bk.len * sizeof *array);
      if (!array) scr_trap("scriptc: out of memory\n");
    }
    array[count++] = (ScrDyn *)key2;
  }
  if (result < 0) result = array ? scr_assert_loose_map_objects(array, count, &ak, &avals, b) : 1;
  free(array);
  scr_assert_loose_list_free(&ak);
  scr_assert_loose_list_free(&avals);
  scr_assert_loose_list_free(&bk);
  scr_assert_loose_list_free(&bvals);
  return result == 1;
}

static bool scr_assert_loose_handle(const ScrDyn *a, const ScrDyn *b) {
  if (a->v.handle.tag != b->v.handle.tag) return false;
  switch (a->v.handle.tag) {
    case SCR_DYNH_DATE: {
      double x = scr_dyn_native_date_value(a), y = scr_dyn_native_date_value(b);
      return x == y || (x != x && y != y);
    }
    case SCR_DYNH_REGEXP:
      return scr_assert_loose_regex(a, b);
    case SCR_DYNH_SET:
      return scr_assert_loose_set(a->v.handle.ptr, b->v.handle.ptr);
    case SCR_DYNH_MAP:
      return scr_assert_loose_map(a->v.handle.ptr, b->v.handle.ptr);
    default:
      return a->v.handle.ptr == b->v.handle.ptr;
  }
}

static bool scr_assert_loose_array(const ScrDyn *a, const ScrDyn *b) {
  if (a->v.arr.len != b->v.arr.len) return false;
  const ScrDyn *pa = a->v.arr.properties, *pb = b->v.arr.properties;
  if (pa || pb) {
    if (!pa || !pb) {
      const ScrDyn *table = pa ? pa : pb;
      for (size_t i = 0; i < scr_dyn_obj_count(table); i++)
        if (scr_assert_loose_counted(scr_dyn_obj_prop_at(table, i))) return false;
    } else if (!scr_assert_loose_keys(pa, pb)) {
      return false;
    }
  }
  for (size_t i = 0; i < a->v.arr.len; i++) {
    const ScrDyn *x = a->v.arr.items[i], *y = b->v.arr.items[i];
    if (y->kind == SCR_DYN_UNDEF) {
      if (x->kind != SCR_DYN_UNDEF && x->kind != SCR_DYN_NULL) return false;
    } else if ((x->kind == SCR_DYN_UNDEF || !scr_assert_loose_eq(x, y)) && y->kind != SCR_DYN_NULL) {
      return false;
    }
  }
  return true;
}

static bool scr_assert_loose_eq(const ScrDyn *a, const ScrDyn *b) {
  if (a == b) return true;
  if (a->kind == SCR_DYN_PROXY || b->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("deep equality");
    return false;
  }
  if (a->kind == SCR_DYN_TYPED_REF || b->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *ma = a->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(a) : scr_dyn_retain((ScrDyn *)a);
    ScrDyn *mb = b->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(b) : scr_dyn_retain((ScrDyn *)b);
    bool same = ma && mb && scr_assert_loose_eq(ma, mb);
    if (ma) scr_dyn_release(ma);
    if (mb) scr_dyn_release(mb);
    return same;
  }
  if (!scr_assert_loose_object(a)) {
    if (scr_assert_loose_object(b)) return false;
    /* Functions are equal to themselves only; == would call their
     * toString against a string. */
    if (a->kind == SCR_DYN_FUNC || b->kind == SCR_DYN_FUNC) return scr_dyn_strict_eq(a, b);
    return scr_dyn_abstract_eq(a, b) || (scr_assert_loose_nan(a) && scr_assert_loose_nan(b));
  }
  if (!scr_assert_loose_object(b) || a->kind != b->kind) return false;
  switch (a->kind) {
    case SCR_DYN_ARR:
      return scr_assert_loose_array(a, b);
    case SCR_DYN_OBJ: {
      bool ea = scr_dyn_obj_get(a, "%error", 6) != NULL, eb = scr_dyn_obj_get(b, "%error", 6) != NULL;
      if (ea != eb) return false;
      if (ea && !scr_assert_loose_error(a, b)) return false;
      return scr_assert_loose_keys(a, b);
    }
    case SCR_DYN_BYTES:
      return scr_assert_loose_bytes(a, b);
    case SCR_DYN_HANDLE:
      return scr_assert_loose_handle(a, b);
    default:
      return false; /* promises: identity, checked above */
  }
}

/* ── inspectValue over the checked-dynamic tree (assertion_error.js's inspect options:
 * compact:false, sorted:true, depth 1000, maxArrayLength Infinity) ───── */

#define SCR_ASSERT_CF_DEPTH 1000

static void scr_assert_cf_pad(ScrAssertBuf *b, size_t n) {
  ab_grow(b, n);
  memset(b->data + b->len, ' ', n);
  b->len += n;
}

/* Property-key rendering: __proto__ bracketed, identifier-shaped keys
 * bare (the scr_inspect.c ladder), everything else inspect-quoted. */
static void scr_assert_cf_key(ScrAssertBuf *b, const char *key, size_t len) {
  if (len == 9 && memcmp(key, "__proto__", 9) == 0) {
    ab_cstr(b, "['__proto__']");
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
    ab_bytes(b, key, len);
    return;
  }
  ScrStr *raw = scr_str_new(key, len);
  ScrStr *q = scr_assert_inspect_str(raw);
  ab_str(b, q);
  scr_str_release(q);
  scr_str_release(raw);
}

/* One rendered object entry, for sorting before emission. */
typedef struct {
  char *text;
  size_t len;
} ScrCfEntry;

static int scr_assert_cf_entry_cmp(const void *pa, const void *pb) {
  const ScrCfEntry *a = pa, *b = pb;
  size_t n = a->len < b->len ? a->len : b->len;
  int c = n ? memcmp(a->text, b->text, n) : 0;
  if (c) return c;
  return a->len < b->len ? -1 : (a->len > b->len ? 1 : 0);
}

/* Renders `d` at `indent` (the column its CONTINUATION lines start at);
 * the first line is appended in place. */
static void scr_assert_cf_value(ScrAssertBuf *b, const ScrDyn *d, size_t indent, size_t depth);

/* A plain or class-instance object: `Cls {`, the null-prototype prefix,
 * or `{`, then its entries. */
static void scr_assert_cf_object(ScrAssertBuf *b, const ScrDyn *d, size_t indent, size_t depth,
                                 const char *cls) {
  if (scr_dyn_obj_count(d) == 0) {
    if (cls) {
      ab_cstr(b, cls);
      ab_cstr(b, " {}");
      return;
    }
    ab_cstr(b, d->null_proto ? "[Object: null prototype] {}" : "{}");
    return;
  }
  if (depth == 0) {
    if (cls) {
      ab_cstr(b, "[");
      ab_cstr(b, cls);
      ab_cstr(b, "]");
      return;
    }
    ab_cstr(b, d->null_proto ? "[Object: null prototype]" : "[Object]");
    return;
  }
  if (cls) {
    ab_cstr(b, cls);
    ab_cstr(b, " ");
  } else if (d->null_proto) ab_cstr(b, "[Object: null prototype] ");
  /* Render every entry, then sort the RENDERED texts (Node's
   * sorted:true sorts formatted entries, quotes included). */
  ScrCfEntry *ents = malloc(scr_dyn_obj_count(d) * sizeof *ents);
  if (!ents) scr_assert_oom();
  for (size_t i = 0; i < scr_dyn_obj_count(d); i++) {
    ScrDynProp ent = scr_dyn_obj_prop_at(d, i);
    ScrAssertBuf eb = {0};
    scr_assert_cf_key(&eb, ent.key, ent.key_len);
    ab_cstr(&eb, ": ");
    scr_assert_cf_value(&eb, ent.value, indent + 2, depth - 1);
    ents[i].text = eb.data ? eb.data : malloc(1);
    if (!ents[i].text) scr_assert_oom();
    ents[i].len = eb.len;
  }
  qsort(ents, scr_dyn_obj_count(d), sizeof *ents, scr_assert_cf_entry_cmp);
  ab_char(b, '{');
  for (size_t i = 0; i < scr_dyn_obj_count(d); i++) {
    ab_char(b, '\n');
    scr_assert_cf_pad(b, indent + 2);
    ab_bytes(b, ents[i].text, ents[i].len);
    if (i + 1 < scr_dyn_obj_count(d)) ab_char(b, ',');
    free(ents[i].text);
  }
  free(ents);
  ab_char(b, '\n');
  scr_assert_cf_pad(b, indent);
  ab_char(b, '}');
}

static const char *scr_assert_cf_bytes_class(ScrBytesElem elem) {
  switch (elem) {
    case SCR_BYTES_U8: return "Uint8Array";
    case SCR_BYTES_U32: return "Uint32Array";
    case SCR_BYTES_F16: return "Float16Array";
    case SCR_BYTES_F32: return "Float32Array";
    case SCR_BYTES_I32: return "Int32Array";
    case SCR_BYTES_F64: return "Float64Array";
    case SCR_BYTES_I8: return "Int8Array";
    case SCR_BYTES_U16: return "Uint16Array";
    case SCR_BYTES_I16: return "Int16Array";
    case SCR_BYTES_U8C: return "Uint8ClampedArray";
  }
  return "Uint8Array";
}


static bool scr_assert_cf_error_extra(ScrDynProp ent) {
  if (!ent.enumerable || (ent.key_len > 0 && ent.key[0] == '%')) return false;
  return !((ent.key_len == 4 && memcmp(ent.key, "name", 4) == 0) ||
           (ent.key_len == 7 && memcmp(ent.key, "message", 7) == 0) ||
           (ent.key_len == 5 && memcmp(ent.key, "stack", 5) == 0));
}

/* An encoded Error: Node's stackless `[Name: message]` (assertion_error.js
 * drops the stacks when both sides are errors), then any other
 * enumerable own properties in a `{ ... }` block. */
static void scr_assert_cf_error(ScrAssertBuf *b, const ScrDyn *d, size_t indent, size_t depth) {
  const ScrDyn *name = scr_assert_loose_error_prop(d, "name", 4);
  const ScrDyn *message = scr_assert_loose_error_prop(d, "message", 7);
  ab_char(b, '[');
  if (name->kind == SCR_DYN_STR) ab_str(b, name->v.str);
  else ab_cstr(b, "Error");
  if (message->kind == SCR_DYN_STR && message->v.str->len > 0) {
    ab_cstr(b, ": ");
    ab_str(b, message->v.str);
  }
  ab_char(b, ']');
  size_t extra = 0;
  for (size_t i = 0; i < scr_dyn_obj_count(d); i++) {
    ScrDynProp ent = scr_dyn_obj_prop_at(d, i);
    if (scr_assert_cf_error_extra(ent)) extra++;
  }
  if (extra == 0) return;
  if (depth == 0) return;
  ScrCfEntry *ents = malloc(extra * sizeof *ents);
  if (!ents) scr_assert_oom();
  size_t n = 0;
  for (size_t i = 0; i < scr_dyn_obj_count(d); i++) {
    ScrDynProp ent = scr_dyn_obj_prop_at(d, i);
    if (!scr_assert_cf_error_extra(ent)) continue;
    ScrAssertBuf eb = {0};
    scr_assert_cf_key(&eb, ent.key, ent.key_len);
    ab_cstr(&eb, ": ");
    scr_assert_cf_value(&eb, ent.value, indent + 2, depth - 1);
    ents[n].text = eb.data ? eb.data : malloc(1);
    if (!ents[n].text) scr_assert_oom();
    ents[n++].len = eb.len;
  }
  qsort(ents, n, sizeof *ents, scr_assert_cf_entry_cmp);
  ab_cstr(b, " {");
  for (size_t i = 0; i < n; i++) {
    ab_char(b, '\n');
    scr_assert_cf_pad(b, indent + 2);
    ab_bytes(b, ents[i].text, ents[i].len);
    if (i + 1 < n) ab_char(b, ',');
    free(ents[i].text);
  }
  free(ents);
  ab_char(b, '\n');
  scr_assert_cf_pad(b, indent);
  ab_char(b, '}');
}

/* A Set or Map handle: `Set(n) {` / `Map(n) {` with one entry per line
 * (`k => v` for Maps), sorted by their rendered text like Node's
 * sorted:true; `[Set]` / `[Map]` past the depth. */
static void scr_assert_cf_collection(ScrAssertBuf *b, const ScrDyn *d, size_t indent, size_t depth) {
  bool is_map = d->v.handle.tag == SCR_DYNH_MAP;
  ScrMap *map = d->v.handle.ptr;
  size_t size = scr_assert_loose_size(map);
  char head[48];
  int hn = snprintf(head, sizeof head, "%s(%zu) {", is_map ? "Map" : "Set", size);
  if (size == 0) {
    ab_bytes(b, head, (size_t)hn);
    ab_char(b, '}');
    return;
  }
  if (depth == 0) {
    ab_cstr(b, is_map ? "[Map]" : "[Set]");
    return;
  }
  ScrAssertDynList keys = scr_assert_loose_list(map, false);
  ScrAssertDynList values = is_map ? scr_assert_loose_list(map, true) : (ScrAssertDynList){0};
  ScrCfEntry *ents = malloc(keys.len * sizeof *ents);
  if (!ents) scr_assert_oom();
  for (size_t i = 0; i < keys.len; i++) {
    ScrAssertBuf eb = {0};
    scr_assert_cf_value(&eb, keys.items[i], indent + 2, depth - 1);
    if (is_map) {
      ab_cstr(&eb, " => ");
      scr_assert_cf_value(&eb, values.items[i], indent + 2, depth - 1);
    }
    ents[i].text = eb.data ? eb.data : malloc(1);
    if (!ents[i].text) scr_assert_oom();
    ents[i].len = eb.len;
  }
  qsort(ents, keys.len, sizeof *ents, scr_assert_cf_entry_cmp);
  ab_bytes(b, head, (size_t)hn);
  for (size_t i = 0; i < keys.len; i++) {
    ab_char(b, '\n');
    scr_assert_cf_pad(b, indent + 2);
    ab_bytes(b, ents[i].text, ents[i].len);
    if (i + 1 < keys.len) ab_char(b, ',');
    free(ents[i].text);
  }
  free(ents);
  ab_char(b, '\n');
  scr_assert_cf_pad(b, indent);
  ab_char(b, '}');
  scr_assert_loose_list_free(&keys);
  scr_assert_loose_list_free(&values);
}

static void scr_assert_cf_value(ScrAssertBuf *b, const ScrDyn *d, size_t indent,
                                size_t depth) {
  switch (d->kind) {
    case SCR_DYN_UNDEF:
      ab_cstr(b, "undefined");
      return;
    case SCR_DYN_NULL:
      ab_cstr(b, "null");
      return;
    case SCR_DYN_BOOL:
      ab_cstr(b, d->v.b ? "true" : "false");
      return;
    case SCR_DYN_BIGINT: {
      ScrStr *text = scr_bigint_inspect(d->v.bigint);
      ab_str(b, text);
      scr_str_release(text);
      return;
    }
    case SCR_DYN_SYMBOL: {
      ScrStr *text = d->v.symbol.render(d->v.symbol.value);
      ab_str(b, text);
      scr_str_release(text);
      return;
    }
    case SCR_DYN_NUM: {
      char tmp[40];
      size_t n = scr_assert_inspect_f64(d->v.num, tmp);
      ab_bytes(b, tmp, n);
      return;
    }
    case SCR_DYN_STR: {
      ScrStr *q = scr_assert_inspect_str(d->v.str);
      ab_str(b, q);
      scr_str_release(q);
      return;
    }
    case SCR_DYN_FUNC: {
      const char *name = d->v.fn.name;
      if (name && name[0]) {
        ab_cstr(b, "[Function: ");
        ab_cstr(b, name);
        ab_char(b, ']');
      } else {
        ab_cstr(b, "[Function (anonymous)]");
      }
      return;
    }
    case SCR_DYN_HANDLE: {
      /* The depth-elided class form ([ServerResponse]) — the full own-
       * property dump Node renders is internals we do not model; this
       * text only appears inside FAILURE diffs, which already diverge in
       * report format. */
      if (d->v.handle.tag == SCR_DYNH_SET || d->v.handle.tag == SCR_DYNH_MAP) {
        scr_assert_cf_collection(b, d, indent, depth);
        return;
      }
      if (d->v.handle.tag == SCR_DYNH_DATE) {
        double ms = scr_dyn_native_date_value(d);
        if (!(fabs(ms) <= 8640000000000000.0)) {
          ab_cstr(b, "Invalid Date");
          return;
        }
        ScrStr *iso = scr_date_to_iso(ms);
        ab_str(b, iso);
        scr_str_release(iso);
        return;
      }
      if (d->v.handle.tag == SCR_DYNH_REGEXP) {
        ScrDyn *source = scr_assert_loose_regex_prop(d, "source");
        ScrDyn *flags = scr_assert_loose_regex_prop(d, "flags");
        ab_char(b, '/');
        if (source->kind == SCR_DYN_STR) ab_str(b, source->v.str);
        ab_char(b, '/');
        if (flags->kind == SCR_DYN_STR) ab_str(b, flags->v.str);
        scr_dyn_release(source);
        scr_dyn_release(flags);
        return;
      }
      ab_char(b, '[');
      ab_cstr(b, scr_dyn_handle_cls(d));
      ab_char(b, ']');
      return;
    }
    case SCR_DYN_PROMISE: {
      /* The depth-elided form (Node renders Promise { <state> }; failure
       * diffs already diverge in report format — the handle stance). */
      ab_cstr(b, "[Promise]");
      return;
    }
    case SCR_DYN_BYTES: {
      const ScrBytes *bs = d->v.bytes;
      char prefix[64];
      int pn = snprintf(prefix, sizeof prefix, "%s(%zu) %s[",
                        d->buffer ? "Buffer" : scr_assert_cf_bytes_class(bs->elem), bs->len,
                        d->buffer ? "[Uint8Array] " : "");
      ab_bytes(b, prefix, (size_t)pn);
      if (bs->len == 0) {
        ab_char(b, ']');
        return;
      }
      for (size_t i = 0; i < bs->len; i++) {
        ab_char(b, '\n');
        scr_assert_cf_pad(b, indent + 2);
        char tmp[40];
        size_t n = scr_assert_inspect_f64(scr_bytes_get(bs, (double)i), tmp);
        ab_bytes(b, tmp, n);
        if (i + 1 < bs->len) ab_char(b, ',');
      }
      ab_char(b, '\n');
      scr_assert_cf_pad(b, indent);
      ab_char(b, ']');
      return;
    }
    case SCR_DYN_ARR: {
      if (d->v.arr.len == 0) {
        ab_cstr(b, "[]");
        return;
      }
      if (depth == 0) {
        ab_cstr(b, "[Array]");
        return;
      }
      ab_char(b, '[');
      for (size_t i = 0; i < d->v.arr.len; i++) {
        ab_char(b, '\n');
        scr_assert_cf_pad(b, indent + 2);
        scr_assert_cf_value(b, d->v.arr.items[i], indent + 2, depth - 1);
        if (i + 1 < d->v.arr.len) ab_char(b, ',');
      }
      ab_char(b, '\n');
      scr_assert_cf_pad(b, indent);
      ab_char(b, ']');
      return;
    }

    case SCR_DYN_TYPED_REF: {
      /* A program class instance renders under its class name. */
      ScrDyn *materialized = scr_dyn_typed_ref_materialize(d);
      const ScrStr *cls = scr_dyn_typed_ref_class_name(d);
      if (cls && materialized->kind == SCR_DYN_OBJ && scr_dyn_obj_get(materialized, "%error", 6) == NULL)
        scr_assert_cf_object(b, materialized, indent, depth, cls->data);
      else
        scr_assert_cf_value(b, materialized, indent, depth);
      scr_dyn_release(materialized);
      return;
    }
    case SCR_DYN_PROXY:
      scr_assert_cf_value(b, d->v.proxy.target, indent, depth);
      return;
    case SCR_DYN_OBJ: {
      if (scr_dyn_obj_get(d, "%error", 6) != NULL) {
        scr_assert_cf_error(b, d, indent, depth);
        return;
      }
      /* The null-proto dictionary renders with Node's prefix in the
       * failure diff too (assertion_error.js inspects both sides). */
      scr_assert_cf_object(b, d, indent, depth, scr_dyn_class_name(d));
      return;
    }
  }
}

static ScrStr *scr_assert_cf_inspect(const ScrDyn *d) {
  ScrAssertBuf b = {0};
  scr_assert_cf_value(&b, d, 0, SCR_ASSERT_CF_DEPTH);
  return ab_take(&b);
}

/* ── the myers line diff (internal/assert/myers_diff.js) ─────────────── */

typedef struct {
  const char *s;
  size_t len;
} ScrLine;

/* Splits rendered text into lines (no trailing-newline convention: the
 * renderer never emits a final \n, matching String.prototype.split). */
static ScrLine *scr_assert_split_lines(const ScrStr *text, size_t *out_n) {
  size_t n = 1;
  for (size_t i = 0; i < text->len; i++) {
    if (text->data[i] == '\n') n++;
  }
  ScrLine *lines = malloc(n * sizeof *lines);
  if (!lines) scr_assert_oom();
  size_t li = 0, start = 0;
  for (size_t i = 0; i <= text->len; i++) {
    if (i == text->len || text->data[i] == '\n') {
      lines[li].s = text->data + start;
      lines[li].len = i - start;
      li++;
      start = i + 1;
    }
  }
  *out_n = n;
  return lines;
}

/* areLinesEqual with the comma-disparity rule: object lines differing
 * only by a trailing comma count as equal. */
static bool scr_assert_lines_eq(ScrLine a, ScrLine b, bool comma) {
  if (a.len == b.len && (a.len == 0 || memcmp(a.s, b.s, a.len) == 0)) return true;
  if (!comma) return false;
  if (a.len + 1 == b.len && b.s[b.len - 1] == ',' &&
      (a.len == 0 || memcmp(a.s, b.s, a.len) == 0))
    return true;
  if (b.len + 1 == a.len && a.s[a.len - 1] == ',' &&
      (b.len == 0 || memcmp(a.s, b.s, b.len) == 0))
    return true;
  return false;
}

typedef struct {
  int8_t op; /* 1 INSERT (actual), -1 DELETE (expected), 0 NOP */
  ScrLine line;
} ScrDiffOp;

/* The greedy O((N+M)·D) forward walk plus backtrack — a straight port of
 * myersDiff/backtrack. The result array is in REVERSE document order
 * (built back-to-front, like Node's), so the printer walks it from the
 * end. Returns NULL when the inputs exceed the line cap (the caller falls
 * back to the whole-value form). */
#define SCR_ASSERT_MYERS_CAP 4096

static ScrDiffOp *scr_assert_myers(ScrLine *a, size_t an, ScrLine *b, size_t bn,
                                   bool comma, size_t *out_n) {
  size_t max = an + bn;
  if (max == 0 || max > SCR_ASSERT_MYERS_CAP) return NULL;
  size_t width = 2 * max + 1;
  int32_t *v = calloc(width, sizeof *v);
  int32_t **trace = malloc((max + 1) * sizeof *trace);
  if (!v || !trace) scr_assert_oom();
  size_t traceN = 0;
  size_t foundLevel = 0;
  bool found = false;
  for (size_t d = 0; d <= max && !found; d++) {
    int32_t *snap = malloc(width * sizeof *snap);
    if (!snap) scr_assert_oom();
    memcpy(snap, v, width * sizeof *snap);
    trace[traceN++] = snap;
    for (long k = -(long)d; k <= (long)d; k += 2) {
      size_t off = (size_t)(k + (long)max);
      long x;
      if (k == -(long)d || (k != (long)d && v[off - 1] < v[off + 1])) {
        x = v[off + 1];
      } else {
        x = v[off - 1] + 1;
      }
      long y = x - k;
      while (x < (long)an && y < (long)bn && scr_assert_lines_eq(a[x], b[y], comma)) {
        x++;
        y++;
      }
      v[off] = (int32_t)x;
      if (x >= (long)an && y >= (long)bn) {
        foundLevel = d;
        found = true;
        break;
      }
    }
  }
  free(v);
  if (!found) { /* unreachable: D <= max always terminates */
    for (size_t i = 0; i < traceN; i++) free(trace[i]);
    free(trace);
    return NULL;
  }
  ScrDiffOp *result = malloc((an + bn + 1) * sizeof *result);
  if (!result) scr_assert_oom();
  size_t rn = 0;
  long x = (long)an, y = (long)bn;
  for (long level = (long)foundLevel; level >= 0; level--) {
    int32_t *vv = trace[level];
    long k = x - y;
    long prevK;
    if (k == -level || (k != level && vv[k + (long)max - 1] < vv[k + (long)max + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    long prevX = vv[prevK + (long)max];
    long prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ScrLine ai = a[x - 1];
      bool aComma = ai.len > 0 && ai.s[ai.len - 1] == ',';
      result[rn].op = 0;
      result[rn].line = (comma && !aComma) ? b[y - 1] : ai;
      rn++;
      x--;
      y--;
    }
    if (level > 0) {
      if (x > prevX) {
        x--;
        result[rn].op = 1;
        result[rn].line = a[x];
      } else {
        y--;
        result[rn].op = -1;
        result[rn].line = b[y];
      }
      rn++;
    }
  }
  for (size_t i = 0; i < traceN; i++) free(trace[i]);
  free(trace);
  *out_n = rn;
  return result;
}

static void scr_assert_line_out(ScrAssertBuf *b, const char *prefix, ScrLine l) {
  ab_cstr(b, prefix);
  ab_bytes(b, l.s, l.len);
  ab_char(b, '\n');
}

/* printMyersDiff: document order (the diff array reversed), 5 context
 * lines per common run, then "..." plus the run's last line and the
 * skipped flag. Trailing common lines past the window are dropped —
 * Node's printer does the same. The message lands WITHOUT its leading
 * newline (the caller places it); trailing whitespace trimmed. */
static bool scr_assert_print_myers(ScrAssertBuf *b, const ScrDiffOp *diff, size_t n) {
  bool skipped = false;
  size_t nopCount = 0;
  size_t startLen = b->len;
  for (size_t i = n; i-- > 0;) {
    int8_t op = diff[i].op;
    bool hasPrev = i + 1 < n;
    if (hasPrev && diff[i + 1].op == 0 && op != 0) {
      if (nopCount == 6) {
        scr_assert_line_out(b, "  ", diff[i + 1].line);
      } else if (nopCount == 7) {
        scr_assert_line_out(b, "  ", diff[i + 2].line);
        scr_assert_line_out(b, "  ", diff[i + 1].line);
      } else if (nopCount >= 8) {
        ab_cstr(b, "...\n");
        scr_assert_line_out(b, "  ", diff[i + 1].line);
        skipped = true;
      }
      nopCount = 0;
    }
    if (op == 1) {
      scr_assert_line_out(b, "+ ", diff[i].line);
    } else if (op == -1) {
      scr_assert_line_out(b, "- ", diff[i].line);
    } else {
      if (nopCount < 5) scr_assert_line_out(b, "  ", diff[i].line);
      nopCount++;
    }
  }
  while (b->len > startLen &&
         (b->data[b->len - 1] == '\n' || b->data[b->len - 1] == ' ')) {
    b->len--; /* trimEnd */
  }
  return skipped;
}

/* ── the dyn entry point ─────────────────────────────────────────────── */

/* Is this dyn kind `typeof == "object" && != null` to assertion_error.js? */
static bool scr_assert_dyn_is_object(const ScrDyn *d) {
  return d->kind == SCR_DYN_ARR || d->kind == SCR_DYN_OBJ || d->kind == SCR_DYN_BYTES ||
         d->kind == SCR_DYN_HANDLE || d->kind == SCR_DYN_PROMISE ||
         d->kind == SCR_DYN_TYPED_REF || d->kind == SCR_DYN_PROXY ||
         scr_dyn_ref_typeof_is(d, "object"); /* engine-held: the engine's typeof */
}

/* The failing EQUAL operators over dyn operands — createErrDiff. */
static const char scr_assert_partial_header[] =
    "Expected values to be partially and strictly deep-equal:";

/* createErrDiff over two dyn values. `header_override` replaces the
 * operator's header (partialDeepStrictEqual); NULL keeps it. `full` is
 * Node's `diff: 'full'`, which keeps every line of a >50-line
 * notIdentical rendering. */
static ScrStr *scr_assert_dyn_diff_message(ScrDyn *a, ScrDyn *b, bool deep, const char *header_override,
                                           ScrStr *msg, bool has_msg, bool full) {
  /* checkOperator: strictEqual over two objects (or two functions)
   * reports the reference-equality expectation. */
  bool objOp = !deep && ((scr_assert_dyn_is_object(a) && scr_assert_dyn_is_object(b)) ||
                         (a->kind == SCR_DYN_FUNC && b->kind == SCR_DYN_FUNC));
  const char *header =
      header_override ? header_override
      : deep ? "Expected values to be strictly deep-equal:"
           : (objOp ? "Expected \"actual\" to be reference-equal to \"expected\":"
                    : "Expected values to be strictly equal:");
  ScrStr *ia = scr_assert_cf_inspect(a);
  ScrStr *ib = scr_assert_cf_inspect(b);
  size_t an, en;
  ScrLine *alines = scr_assert_split_lines(ia, &an);
  ScrLine *elines = scr_assert_split_lines(ib, &en);
  ScrAssertBuf out = {0};
  const char *customOrHeader = header; /* resolved after operator morphing */
  bool simple = an == 1 && en == 1 &&
                (!scr_assert_dyn_is_object(a) || !scr_assert_dyn_is_object(b));
  bool inspEq = ia->len == ib->len && memcmp(ia->data, ib->data, ia->len) == 0;

  if (simple) {
    if (has_msg && msg->len > 0) {
      ab_str(&out, msg);
    } else {
      ab_cstr(&out, customOrHeader);
    }
    size_t la = ia->len, lb = ib->len;
    size_t stringsLen = la + lb;
    if (a->kind == SCR_DYN_STR) stringsLen -= 2;
    if (b->kind == SCR_DYN_STR) stringsLen -= 2;
    bool bothZero = a->kind == SCR_DYN_NUM && b->kind == SCR_DYN_NUM &&
                    a->v.num == 0.0 && b->v.num == 0.0;
    if (stringsLen <= 12 && !bothZero) {
      ab_cstr(&out, "\n\n");
      ab_str(&out, ia);
      ab_cstr(&out, " !== ");
      ab_str(&out, ib);
      ab_cstr(&out, "\n");
    } else {
      ab_cstr(&out, "\n+ actual - expected\n\n+ ");
      ab_str(&out, ia);
      ab_cstr(&out, "\n- ");
      ab_str(&out, ib);
      /* getStackedDiff's ^ indicator runs over the INSPECTED text of
       * every simple stacked diff (its typeof-string test sees the
       * rendered strings), all kinds included. */
      if (la + lb <= 80) {
        size_t i = 0;
        while (i < la && i < lb && ia->data[i] == ib->data[i]) i++;
        if (i < la && i >= 3) {
          ab_char(&out, '\n');
          for (size_t k = 0; k < i + 2; k++) ab_char(&out, ' ');
          ab_char(&out, '^');
        }
      }
      ab_cstr(&out, "\n");
    }
  } else if (inspEq) {
    /* Structurally identical renderings that are not the same reference:
     * the notIdentical banner over the single rendering. */
    const char *ident = "Values have same structure but are not reference-equal:";
    if (has_msg && msg->len > 0) {
      ab_str(&out, msg);
    } else {
      ab_cstr(&out, ident);
    }
    ab_cstr(&out, "\n");
    if (an > 50 && !full) {
      ab_cstr(&out, "\n... Skipped lines");
      ab_cstr(&out, "\n");
      for (size_t i = 0; i < 50; i++) {
        ab_bytes(&out, alines[i].s, alines[i].len);
        ab_char(&out, '\n');
      }
      ab_cstr(&out, "...}\n");
    } else {
      ab_cstr(&out, "\n");
      ab_str(&out, ia);
      ab_cstr(&out, "\n");
    }
  } else {
    /* The myers line diff with Node's printer. checkCommaDisparity is
     * Node's `actual != null && typeof actual === 'object'`. */
    bool comma = scr_assert_dyn_is_object(a);
    size_t dn = 0;
    ScrDiffOp *diff = scr_assert_myers(alines, an, elines, en, comma, &dn);
    if (has_msg && msg->len > 0) {
      ab_str(&out, msg);
    } else {
      ab_cstr(&out, customOrHeader);
    }
    ab_cstr(&out, "\n+ actual - expected");
    if (diff) {
      ScrAssertBuf body = {0};
      bool skipped = scr_assert_print_myers(&body, diff, dn);
      if (skipped) ab_cstr(&out, "\n... Skipped lines");
      ab_cstr(&out, "\n\n");
      ab_bytes(&out, body.data ? body.data : "", body.len);
      ab_cstr(&out, "\n");
      free(body.data);
      free(diff);
    } else {
      /* Past the line cap: the whole-value fallback (documented). */
      ab_cstr(&out, "\n\n");
      for (size_t i = 0; i < an; i++) scr_assert_line_out(&out, "+ ", alines[i]);
      for (size_t i = 0; i < en; i++) {
        ab_cstr(&out, "- ");
        ab_bytes(&out, elines[i].s, elines[i].len);
        if (i + 1 < en) ab_char(&out, '\n');
      }
      ab_cstr(&out, "\n");
    }
  }
  free(alines);
  free(elines);
  scr_str_release(ia);
  scr_str_release(ib);
  return ab_take(&out);
}

static void scr_assert_dyn_eq_fail(ScrDyn *a, ScrDyn *b, bool deep,
                                   ScrStr *msg, bool has_msg) {
  scr_assert_fail(scr_assert_dyn_eq_message(a, b, deep, msg, has_msg, scr_assert_diff_full()),
                  !(has_msg && msg->len > 0));
}

static ScrStr *scr_assert_dyn_eq_message(ScrDyn *a, ScrDyn *b, bool deep,
                                         ScrStr *msg, bool has_msg, bool full) {
  return scr_assert_dyn_diff_message(a, b, deep, NULL, msg, has_msg, full);
}

/* ── partial deep equality (Node's isPartialStrictEqual) ────────────────
 * comparisons.js in kPartial mode: the expected value (b) must be
 * contained in the actual one (a). Primitives compare by Object.is, with
 * no prototype check; objects compare the expected side's enumerable own
 * keys; arrays and typed arrays match as ordered subsequences; Sets and
 * Maps as subsets. Like the strict walk, it has no cycle memo. */

static bool scr_assert_partial_eq(const ScrDyn *a, const ScrDyn *b);

/* objEquiv over the expected side's enumerable own keys. */
static bool scr_assert_partial_keys(const ScrDyn *a, const ScrDyn *b) {
  for (size_t i = 0; i < scr_dyn_obj_count(b); i++) {
    ScrDynProp ent = scr_dyn_obj_prop_at(b, i);
    if (!scr_assert_loose_counted(ent)) continue;
    const ScrDyn *other = scr_assert_loose_entry(a, ent.key, ent.key_len);
    if (!other || !scr_assert_partial_eq(other, ent.value)) return false;
  }
  return true;
}

/* isError's arm: message, name, cause and errors compare unless the
 * expected side has them as enumerable own keys or leaves them undefined
 * (an empty message counts as left out), and an own cause on the
 * expected side must be own on the actual side. */
static bool scr_assert_partial_error(const ScrDyn *a, const ScrDyn *b) {
  static const char *const props[] = {"message", "name", "cause", "errors"};
  for (size_t i = 0; i < 4; i++) {
    size_t len = strlen(props[i]);
    if (scr_assert_loose_entry(b, props[i], len)) continue;
    const ScrDyn *expected = scr_assert_loose_error_prop(b, props[i], len);
    if (expected->kind == SCR_DYN_UNDEF) continue;
    if (i == 0 && expected->kind == SCR_DYN_STR && expected->v.str->len == 0) continue;
    if (!scr_assert_partial_eq(scr_assert_loose_error_prop(a, props[i], len), expected)) return false;
  }
  if (scr_dyn_obj_get(b, "cause", 5) != NULL && scr_dyn_obj_get(a, "cause", 5) == NULL) return false;
  return true;
}

/* isPartialUint8Array over the views' bytes: b's bytes in order within a's. */
static bool scr_assert_partial_bytes(const ScrBytes *x, const ScrBytes *y) {
  if (x->elem != y->elem || x->is_data_view != y->is_data_view) return false;
  size_t la = x->len * scr_bytes_elem_size(x->elem), lb = y->len * scr_bytes_elem_size(y->elem);
  if (la == lb) return scr_assert_bytes_content_eq(x, y);
  if (la < lb) return false;
  SCR_BYTES_SNAPSHOT(x);
  SCR_BYTES_SNAPSHOT(y);
  const uint8_t *pa = x->data, *pb = y->data;
  size_t offset_a = 0;
  for (size_t offset_b = 0; offset_b < lb; offset_b++) {
    while (pa[offset_a] != pb[offset_b]) {
      offset_a++;
      if (offset_a > la - lb + offset_b) return false;
    }
    offset_a++;
  }
  return true;
}

/* partialArrayEquiv over dense arrays: b's elements in order within a's. */
static bool scr_assert_partial_array(const ScrDyn *a, const ScrDyn *b) {
  size_t la = a->v.arr.len, lb = b->v.arr.len;
  if (la < lb) return false;
  const ScrDyn *pb = b->v.arr.properties;
  if (pb) {
    const ScrDyn *pa = a->v.arr.properties;
    for (size_t i = 0; i < scr_dyn_obj_count(pb); i++) {
      ScrDynProp ent = scr_dyn_obj_prop_at(pb, i);
      if (!scr_assert_loose_counted(ent)) continue;
      const ScrDyn *other = pa ? scr_assert_loose_entry(pa, ent.key, ent.key_len) : NULL;
      if (!other || !scr_assert_partial_eq(other, ent.value)) return false;
    }
  }
  size_t pos = 0;
  for (size_t i = 0; i < lb; i++) {
    while (!scr_assert_partial_eq(a->v.arr.items[pos], b->v.arr.items[i])) {
      pos++;
      if (pos > la - lb + i) return false;
    }
    pos++;
  }
  return true;
}

/* arrayHasEqualElement under the mode's comparator: searches
 * array[start..end) from the end; a match is replaced by array[end]. */
static bool scr_assert_array_has(ScrAssertDynEq eq, ScrDyn **array, const ScrDyn *val1, size_t start,
                                 size_t end) {
  for (size_t i = end; i-- > start;) {
    if (eq(val1, array[i])) {
      ScrDyn *held = array[i];
      array[i] = array[end];
      array[end] = held;
      return true;
    }
  }
  return false;
}

/* partialObjectSetEquiv: the expected side's object members, matched
 * against the actual side's members in Node's search order. */
static bool scr_assert_partial_set_objects(ScrDyn **array, size_t count, ScrAssertDynList *a, ScrMap *b) {
  int direction = 1;
  size_t start = 0, end = count - 1;
  for (size_t k = 0; k < a->len; k++) {
    const ScrDyn *val1 = a->items[k];
    if (!scr_map_dyn_has(b, val1, false)) {
      size_t inner = start;
      if (direction == 1) {
        if (scr_assert_partial_eq(val1, array[start])) {
          if (start == end) return true;
          start++;
          continue;
        }
        if (start == end) continue;
        direction = -1;
        inner++;
      }
      bool matched = true;
      if (!scr_assert_partial_eq(val1, array[end])) {
        direction = 1;
        matched = scr_assert_array_has(scr_assert_partial_eq, array, val1, inner, end);
      }
      if (matched) {
        if (start == end) return true;
        end--;
      }
    }
    if (a->len - (k + 1) <= end - start) return false;
  }
  return false;
}

static bool scr_assert_partial_set(ScrMap *a, ScrMap *b) {
  if (scr_assert_loose_size(a) < scr_assert_loose_size(b)) return false;
  ScrAssertDynList av = scr_assert_loose_list(a, false);
  ScrAssertDynList bv = scr_assert_loose_list(b, false);
  ScrDyn **array = NULL;
  size_t count = 0;
  int result = -1;
  for (size_t i = 0; i < bv.len && result < 0; i++) {
    const ScrDyn *val = bv.items[i];
    if (scr_map_dyn_has(a, val, false)) continue;
    if (!scr_assert_loose_object(val)) {
      result = 0;
      break;
    }
    if (!array) {
      if (av.len < 3) {
        result = scr_assert_small_sets(scr_assert_partial_eq, &av, b, val, &bv, i + 1);
        break;
      }
      array = malloc(bv.len * sizeof *array);
      if (!array) scr_trap("scriptc: out of memory\n");
    }
    array[count++] = (ScrDyn *)val;
  }
  if (result < 0) result = array ? scr_assert_partial_set_objects(array, count, &av, b) : 1;
  free(array);
  scr_assert_loose_list_free(&av);
  scr_assert_loose_list_free(&bv);
  return result == 1;
}

static bool scr_assert_partial_map_entry(ScrMap *b, const ScrDyn *key1, const ScrDyn *item1, const ScrDyn *key2) {
  if (!scr_assert_partial_eq(key1, key2)) return false;
  ScrDyn *item2 = scr_map_dyn_get(b, key2);
  bool same = item2 && scr_assert_partial_eq(item1, item2);
  if (item2) scr_dyn_release(item2);
  return same;
}

/* arrayHasEqualMapElement under the partial comparator. */
static bool scr_assert_partial_map_array_has(ScrDyn **array, const ScrDyn *key1, const ScrDyn *item1,
                                             ScrMap *b, size_t start, size_t end) {
  for (size_t i = end; i-- > start;) {
    if (scr_assert_partial_map_entry(b, key1, item1, array[i])) {
      ScrDyn *held = array[i];
      array[i] = array[end];
      array[end] = held;
      return true;
    }
  }
  return false;
}

/* partialObjectMapEquiv: the expected side's object keys, matched against
 * the actual side's object-keyed entries in Node's search order. */
static bool scr_assert_partial_map_objects(ScrDyn **array, size_t count, ScrAssertDynList *ak,
                                           ScrAssertDynList *avals, ScrMap *b) {
  int direction = 1;
  size_t start = 0, end = count - 1;
  for (size_t k = 0; k < ak->len; k++) {
    const ScrDyn *key1 = ak->items[k], *item1 = avals->items[k];
    if (scr_assert_loose_object(key1)) {
      size_t inner = start;
      if (direction == 1) {
        if (scr_assert_partial_map_entry(b, key1, item1, array[start])) {
          if (start == end) return true;
          start++;
          continue;
        }
        if (start == end) continue;
        direction = -1;
        inner++;
      }
      bool matched = true;
      if (!scr_assert_partial_map_entry(b, key1, item1, array[end])) {
        direction = 1;
        matched = scr_assert_partial_map_array_has(array, key1, item1, b, inner, end);
      }
      if (matched) {
        if (start == end) return true;
        end--;
      }
    }
    if (ak->len - (k + 1) <= end - start) return false;
  }
  return false;
}

static bool scr_assert_partial_map(ScrMap *a, ScrMap *b) {
  if (scr_assert_loose_size(a) < scr_assert_loose_size(b)) return false;
  ScrAssertDynList ak = scr_assert_loose_list(a, false);
  ScrAssertDynList avals = scr_assert_loose_list(a, true);
  ScrAssertDynList bk = scr_assert_loose_list(b, false);
  ScrAssertDynList bvals = scr_assert_loose_list(b, true);
  ScrDyn **array = NULL;
  size_t count = 0;
  int result = -1;
  for (size_t i = 0; i < bk.len && result < 0; i++) {
    const ScrDyn *key2 = bk.items[i], *item2 = bvals.items[i];
    if (scr_assert_loose_object(key2)) {
      if (!array) {
        if (ak.len == 1) {
          result = scr_assert_partial_eq(ak.items[0], key2) && scr_assert_partial_eq(avals.items[0], item2);
          break;
        }
        array = malloc(bk.len * sizeof *array);
        if (!array) scr_trap("scriptc: out of memory\n");
      }
      array[count++] = (ScrDyn *)key2;
      continue;
    }
    if (!scr_map_dyn_has(a, key2, false)) {
      result = 0;
      break;
    }
    ScrDyn *item1 = scr_map_dyn_get(a, key2);
    bool same = item1 && scr_assert_partial_eq(item1, item2);
    if (item1) scr_dyn_release(item1);
    if (!same) result = 0;
  }
  if (result < 0) result = array ? scr_assert_partial_map_objects(array, count, &ak, &avals, b) : 1;
  free(array);
  scr_assert_loose_list_free(&ak);
  scr_assert_loose_list_free(&avals);
  scr_assert_loose_list_free(&bk);
  scr_assert_loose_list_free(&bvals);
  return result == 1;
}

static bool scr_assert_partial_handle(const ScrDyn *a, const ScrDyn *b) {
  if (a->v.handle.tag != b->v.handle.tag) return false;
  switch (a->v.handle.tag) {
    case SCR_DYNH_DATE: {
      double x = scr_dyn_native_date_value(a), y = scr_dyn_native_date_value(b);
      return x == y || (x != x && y != y);
    }
    case SCR_DYNH_REGEXP:
      return scr_assert_loose_regex(a, b);
    case SCR_DYNH_SET:
      return scr_assert_partial_set(a->v.handle.ptr, b->v.handle.ptr);
    case SCR_DYNH_MAP:
      return scr_assert_partial_map(a->v.handle.ptr, b->v.handle.ptr);
    default:
      return a->v.handle.ptr == b->v.handle.ptr;
  }
}

static bool scr_assert_partial_eq(const ScrDyn *a, const ScrDyn *b) {
  if (a == b) return true;
  if (a->kind == SCR_DYN_PROXY || b->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("deep equality");
    return false;
  }
  if (a->kind == SCR_DYN_TYPED_REF || b->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *ma = a->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(a) : scr_dyn_retain((ScrDyn *)a);
    ScrDyn *mb = b->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(b) : scr_dyn_retain((ScrDyn *)b);
    bool same = ma && mb && scr_assert_partial_eq(ma, mb);
    if (ma) scr_dyn_release(ma);
    if (mb) scr_dyn_release(mb);
    return same;
  }
  if (!scr_assert_loose_object(a) || !scr_assert_loose_object(b)) return scr_assert_dyn_same_value(a, b);
  if (a->kind != b->kind) return false;
  switch (a->kind) {
    case SCR_DYN_ARR:
      return scr_assert_partial_array(a, b);
    case SCR_DYN_OBJ: {
      bool ea = scr_dyn_obj_get(a, "%error", 6) != NULL, eb = scr_dyn_obj_get(b, "%error", 6) != NULL;
      if (ea != eb) return false;
      if (ea && !scr_assert_partial_error(a, b)) return false;
      return scr_assert_partial_keys(a, b);
    }
    case SCR_DYN_BYTES:
      return scr_assert_partial_bytes(a->v.bytes, b->v.bytes);
    case SCR_DYN_HANDLE:
      return scr_assert_partial_handle(a, b);
    default:
      return false; /* promises: identity, checked above */
  }
}

/* The typed path's fallback for subtrees it does not cover. */
bool scr_assert_partial_eq_dyn(const ScrDyn *a, const ScrDyn *b) {
  return scr_assert_partial_eq(a, b);
}

/* partialDeepStrictEqual over statically typed values: the compiled
 * caller computed the verdict and, on failure, recorded actual and
 * expected. `negated` is always false. */
void scr_assert_partial_deep_result(bool equal, bool negated, ScrStr *msg, bool has_msg) {
  (void)negated;
  if (equal) return;
  ScrDyn *undef = scr_dyn_undefined();
  scr_assert_fail(scr_assert_dyn_diff_message(g_record_actual ? g_record_actual : undef,
                                              g_record_expected ? g_record_expected : undef, true,
                                              scr_assert_partial_header, msg, has_msg, false),
                  !(has_msg && msg->len > 0));
}

/* partialDeepStrictEqual where the operands are checked-dynamic values.
 * The message is the strict diff under the partial header. Borrows
 * everything. */
void scr_assert_partial_deep_dyn(ScrDyn *a, ScrDyn *b, ScrStr *msg, bool has_msg) {
  bool same = scr_assert_partial_eq(a, b);
  if (scr_exc_pending() || same) return;
  scr_assert_record(scr_dyn_retain(a), scr_dyn_retain(b), "partialDeepStrictEqual");
  scr_assert_fail(
      scr_assert_dyn_diff_message(a, b, true, scr_assert_partial_header, msg, has_msg,
                                              scr_assert_diff_full()),
                  !(has_msg && msg->len > 0));
}

/* The failing NOT-equal operators over dyn operands (values compared
 * same): a custom message stands alone; the generated one renders the
 * actual value under the operator's banner (the object banner for
 * notStrictEqual over objects/functions), inline when a single short
 * line, block form otherwise, >50-line renderings collapsed unless `full`
 * (Node's `diff: 'full'`). */
static ScrStr *scr_assert_dyn_neq_message(ScrDyn *a, bool deep, bool full) {
  const char *base =
      deep ? "Expected \"actual\" not to be strictly deep-equal to:"
           : ((scr_assert_dyn_is_object(a) || a->kind == SCR_DYN_FUNC)
                  ? "Expected \"actual\" not to be reference-equal to \"expected\":"
                  : "Expected \"actual\" to be strictly unequal to:");
  ScrStr *ia = scr_assert_cf_inspect(a);
  size_t an;
  ScrLine *lines = scr_assert_split_lines(ia, &an);
  ScrAssertBuf out = {0};
  ab_cstr(&out, base);
  if (an == 1) {
    ab_cstr(&out, lines[0].len > 5 ? "\n\n" : " ");
    ab_str(&out, ia);
  } else {
    ab_cstr(&out, "\n\n");
    /* res.length > 50: line 47 becomes "..." and the rest drop. */
    bool collapse = an > 50 && !full;
    size_t shown = collapse ? 47 : an;
    for (size_t i = 0; i < shown; i++) {
      if (collapse && i == 46) {
        ab_cstr(&out, "...");
      } else {
        ab_bytes(&out, lines[i].s, lines[i].len);
      }
      ab_char(&out, '\n');
    }
  }
  free(lines);
  scr_str_release(ia);
  return ab_take(&out);
}

static void scr_assert_dyn_neq_fail(ScrDyn *a, bool deep, ScrStr *msg, bool has_msg) {
  if (has_msg) {
    scr_assert_fail_custom(msg);
    return;
  }
  scr_assert_fail(scr_assert_dyn_neq_message(a, deep, scr_assert_diff_full()), true);
}

/* strictEqual / notStrictEqual / deepStrictEqual / notDeepStrictEqual
 * where either operand is a checked-dynamic value (both arrive as dyn
 * values — the frontend boxes a static side). Borrows everything. */
void scr_assert_eq_dyn(ScrDyn *a, ScrDyn *b, bool negated, bool deep,
                       ScrStr *msg, bool has_msg) {
  bool same = deep ? scr_assert_dyn_deep_eq(a, b) : scr_assert_dyn_same_value(a, b);

  if (scr_exc_pending()) return;
  if ((negated && !same) || (!negated && same)) return;
  scr_assert_record(scr_dyn_retain(a), scr_dyn_retain(b), scr_assert_eq_operator(negated, deep));
  if (negated) {
    scr_assert_dyn_neq_fail(a, deep, msg, has_msg);
  } else {
    scr_assert_dyn_eq_fail(a, b, deep, msg, has_msg);
  }
}

static ScrStr *scr_assert_generic_message(const ScrDyn *actual, const ScrDyn *expected,
                                          const ScrDyn *op, bool full);

/* deepEqual / notDeepEqual's failure: a custom message stands alone
 * (generatedMessage is !message, so an empty one counts as generated);
 * the generated one is Node's loose banner over the recorded values. */
static void scr_assert_loose_fail(ScrDyn *a, ScrDyn *b, bool negated, ScrStr *msg, bool has_msg) {
  if (has_msg) {
    scr_assert_fail_custom(msg);
    return;
  }
  ScrDyn *op = scr_assert_dyn_text(negated ? "notDeepEqual" : "deepEqual");
  ScrStr *message = scr_assert_generic_message(a, b, op, scr_assert_diff_full());
  scr_dyn_release(op);
  scr_assert_fail(message, true);
}

/* deepEqual / notDeepEqual where an operand is a checked-dynamic value
 * (both arrive as dyn values). Borrows everything. */
void scr_assert_loose_deep_dyn(ScrDyn *a, ScrDyn *b, bool negated, ScrStr *msg, bool has_msg) {
  bool same = scr_assert_loose_eq(a, b);
  if (scr_exc_pending()) return;
  if (negated ? !same : same) return;
  scr_assert_record(scr_dyn_retain(a), scr_dyn_retain(b), negated ? "notDeepEqual" : "deepEqual");
  scr_assert_loose_fail(a, b, negated, msg, has_msg);
}

/* deepEqual / notDeepEqual over statically typed values: the compiled
 * caller computed the verdict and, on failure, recorded actual and
 * expected. */
void scr_assert_loose_deep_result(bool equal, bool negated, ScrStr *msg, bool has_msg) {
  if (negated ? !equal : equal) return;
  ScrDyn *undef = scr_dyn_undefined();
  scr_assert_loose_fail(g_record_actual ? g_record_actual : undef,
                        g_record_expected ? g_record_expected : undef, negated, msg, has_msg);
}

/* Node's expectsError over an error-INSTANCE expected (assert.throws/
 * rejects second argument): every key of the expected dyn error (the
 * %error marker skipped; name/message/code is the encoding's surface)
 * must deep-strict-equal the caught value's — extra ACTUAL keys are fine
 * (Node walks the expected's keys only). A mismatch fails through the
 * deep-equal report (a mismatched key implies the full comparison
 * differs, so the diff is honest); a non-object pair falls back to the
 * full deep comparison outright. */
void scr_assert_expects_err_dyn(ScrDyn *actual, ScrDyn *expected, ScrStr *msg, bool has_msg) {
  if (actual->kind == SCR_DYN_OBJ && expected->kind == SCR_DYN_OBJ) {
    bool ok = true;
    for (size_t i = 0; i < scr_dyn_obj_count(expected) && ok; i++) {
      ScrDynProp e = scr_dyn_obj_prop_at(expected, i);
      if (e.key_len == 6 && memcmp(e.key, "%error", 6) == 0) continue;
      ScrDyn *av = scr_dyn_obj_get(actual, e.key, e.key_len);
      if (av == NULL || !scr_assert_dyn_deep_eq(av, e.value)) ok = false;
    }
    if (ok) return;
  }
  scr_assert_eq_dyn(actual, expected, false, true, msg, has_msg);
}

/* assert.throws(fn) that did NOT throw / assert.rejects whose promise
 * fulfilled: "Missing expected exception|rejection" with Node's details —
 * ` (${expected.name})` when the expected class or shape carries a name,
 * then `: message` or `.` (expectsError's NO_EXCEPTION_SENTINEL arm). */
void scr_assert_throws_none(bool rejection, ScrStr *ename, bool has_ename,
                            ScrStr *msg, bool has_msg) {
  ScrAssertBuf b = {0};
  ab_cstr(&b, rejection ? "Missing expected rejection" : "Missing expected exception");
  if (has_ename) {
    ab_cstr(&b, " (");
    ab_str(&b, ename);
    ab_char(&b, ')');
  }
  if (has_msg && msg->len > 0) {
    ab_cstr(&b, ": ");
    ab_str(&b, msg);
  } else {
    ab_cstr(&b, ".");
  }
  /* Node marks the missing-exception message as not generated. */
  scr_assert_record(NULL, NULL, rejection ? "rejects" : "throws");
  scr_assert_fail(ab_take(&b), false);
}

/* assert.throws(fn, ErrorClass) where the thrown Error is NOT an instance
 * of the expected class: Node's mismatch AssertionError, built from the
 * received error's name and message. (Node prefers constructor.name; this
 * runtime carries the `name` slot — identical for the builtin hierarchy,
 * SEMANTICS.md 105 for subclasses whose constructor name differs.)
 * Borrows both. */
void scr_assert_throws_mismatch(ScrStr *expected_name, ScrError *err,
                                ScrStr *msg, bool has_msg, bool rejection) {
  /* The expected class has no runtime box here; expected stays undefined. */
  scr_assert_record(scr_dyn_from_error(err), NULL, rejection ? "rejects" : "throws");
  if (has_msg && msg->len > 0) {
    /* A custom message stands alone (Node's innerFail with the user's
     * message — the instance-of text is the generated form only). */
    scr_assert_fail(scr_str_retain(msg), false);
    return;
  }
  ScrAssertBuf b = {0};
  ab_cstr(&b, "The error is expected to be an instance of \"");
  ab_str(&b, expected_name);
  ab_cstr(&b, "\". Received \"");
  if (err->name) ab_str(&b, err->name);
  ab_char(&b, '"');
  if (err->message && err->message->len > 0) {
    ab_cstr(&b, "\n\nError message:\n\n");
    ab_str(&b, err->message);
  }
  scr_assert_fail_msg(ab_take(&b));
}

/* ── assert.throws(fn, <object shape>) — expectedException over the
 * static error surface ─────────────────────────────────────────────────
 * Node compares each own key of the expected object against the thrown
 * error: strings by deep-equal (byte equality here), regex values by
 * test against the actual string. The bounded key set (name/message/
 * code — everything the static surface carries) makes Node's generated
 * failure message — a deep-equal diff of two `Comparison` placeholder
 * objects, keys in inspect's SORTED order (code < message < name), a
 * regex-valued key that MATCHED rendering as the actual's own value on
 * both sides — fully enumerable, so the rendering is byte-exact, not
 * header-only. The accumulator is a static: the begin/slot/end calls are
 * straight-line inside one synthesized helper, no suspension between. */

enum { SHAPE_CODE = 0, SHAPE_MESSAGE = 1, SHAPE_NAME = 2 };

typedef struct {
  bool present;
  bool is_re;
  bool re_matched;
  ScrStr *val; /* owned: the string value, or the regex's /source/flags */
} ScrShapeSlot;

static SCR_TL struct {
  ScrError *err; /* borrowed — alive across the straight-line sequence */
  ScrShapeSlot slots[3];
} scr_shape;

static void scr_shape_clear(void) {
  for (int k = 0; k < 3; k++) {
    if (scr_shape.slots[k].val) scr_str_release(scr_shape.slots[k].val);
    scr_shape.slots[k] = (ScrShapeSlot){0};
  }
  scr_shape.err = NULL;
}

void scr_assert_shape_begin(ScrError *err) {
  scr_shape_clear();
  scr_shape.err = err;
}

void scr_assert_shape_str(int key, ScrStr *v) {
  scr_shape.slots[key] = (ScrShapeSlot){
      .present = true, .is_re = false, .re_matched = false, .val = scr_str_retain(v)};
}

/* The regex slot's storage half — scr_regex.c tested the actual value
 * already and rendered the /source/flags form (moves in). */
void scr_assert_shape_slot_re(int key, bool matched, ScrStr *rendered) {
  scr_shape.slots[key] = (ScrShapeSlot){
      .present = true, .is_re = true, .re_matched = matched, .val = rendered};
}

/* The actual error's key value, borrowed; NULL = absent (a NULL code
 * slot — Node's `!(key in actual)`). name/message are always present. */
ScrStr *scr_assert_shape_actual(int key) {
  switch (key) {
    case SHAPE_CODE:
      return scr_shape.err->code;
    case SHAPE_MESSAGE:
      return scr_shape.err->message;
    default:
      return scr_shape.err->name;
  }
}

static bool scr_shape_str_eq(const ScrStr *a, const ScrStr *b) {
  return a->len == b->len && memcmp(a->data, b->data, a->len) == 0;
}

/* Does every expected key match the caught error? (The pass check and
 * doesNotReject's predicate.) */
static bool scr_shape_matches(void) {
  for (int k = 0; k < 3; k++) {
    const ScrShapeSlot *s = &scr_shape.slots[k];
    if (!s->present) continue;
    ScrStr *actual = scr_assert_shape_actual(k);
    if (!actual) return false;
    if (s->is_re ? !s->re_matched : !scr_shape_str_eq(actual, s->val)) return false;
  }
  return true;
}

/* One rendered Comparison line: "  <key>: <value>" (+ "," unless last).
 * The value is util.inspect of a string, or the regex's own rendering. */
static ScrStr *scr_shape_line(int key, ScrStr *value, bool inspect, bool last) {
  static const char *names[3] = {"code", "message", "name"};
  ScrAssertBuf b = {0};
  ab_cstr(&b, "  ");
  ab_cstr(&b, names[key]);
  ab_cstr(&b, ": ");
  if (inspect) {
    ScrStr *q = scr_assert_inspect_str(value);
    ab_str(&b, q);
    scr_str_release(q);
  } else {
    ab_str(&b, value);
  }
  if (!last) ab_char(&b, ',');
  return ab_take(&b);
}

/* The failing shape comparison's generated message: Node's deep-equal
 * diff of the two Comparison renderings. A line diff over two tiny
 * arrays (<= 5 lines): common lines print with a two-space margin; each
 * maximal differing gap prints its actual lines (+) then its expected
 * lines (-) — the myers printer's grouping, verified against v24 across
 * the enumerable case space. */
static void scr_shape_diff_fail(void) {
  ScrStr *alines[5], *elines[5];
  size_t an = 0, en = 0;
  /* Actual Comparison: the expected keys present on the error, sorted
   * render order (code < message < name); zero keys collapse to the
   * one-line "Comparison {}". */
  int akeys[3], ekeys[3];
  int ank = 0, enk = 0;
  for (int k = 0; k < 3; k++) {
    if (!scr_shape.slots[k].present) continue;
    ekeys[enk++] = k;
    if (scr_assert_shape_actual(k)) akeys[ank++] = k;
  }
  if (ank == 0) {
    alines[an++] = scr_str_new("Comparison {}", 13);
  } else {
    alines[an++] = scr_str_new("Comparison {", 12);
    for (int i = 0; i < ank; i++) {
      alines[an++] =
          scr_shape_line(akeys[i], scr_assert_shape_actual(akeys[i]), true, i == ank - 1);
    }
    alines[an++] = scr_str_new("}", 1);
  }
  elines[en++] = scr_str_new("Comparison {", 12);
  for (int i = 0; i < enk; i++) {
    const ScrShapeSlot *s = &scr_shape.slots[ekeys[i]];
    /* A regex value that MATCHED renders as the actual's own value on
     * the expected side too (Node's Comparison constructor), making the
     * two lines identical. */
    ScrStr *v = s->is_re && s->re_matched ? scr_assert_shape_actual(ekeys[i]) : s->val;
    bool inspect = !s->is_re || s->re_matched;
    elines[en++] = scr_shape_line(ekeys[i], v, inspect, i == enk - 1);
  }
  elines[en++] = scr_str_new("}", 1);

  /* LCS table over the two line arrays (byte-equal lines), then the
   * matched pairs — unique here: distinct keys never render equal lines,
   * so ambiguity cannot arise. */
  size_t L[6][6] = {{0}};
  for (size_t i = an; i-- > 0;) {
    for (size_t j = en; j-- > 0;) {
      L[i][j] = scr_shape_str_eq(alines[i], elines[j])
                    ? L[i + 1][j + 1] + 1
                    : (L[i + 1][j] > L[i][j + 1] ? L[i + 1][j] : L[i][j + 1]);
    }
  }
  /* The walk: common lines print with a two-space margin; inside a gap
   * the >= tie-break prefers actual, so each maximal differing run
   * groups its + lines before its - lines — the myers printer's
   * grouping, verified against v24 across the enumerable case space
   * (the first "\n" doubles as the blank line under the banner). */
  ScrAssertBuf b = {0};
  ab_cstr(&b, "Expected values to be strictly deep-equal:\n+ actual - expected\n");
  size_t i = 0, j = 0;
  while (i < an && j < en) {
    if (scr_shape_str_eq(alines[i], elines[j])) {
      ab_cstr(&b, "\n  ");
      ab_str(&b, alines[i]);
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      ab_cstr(&b, "\n+ ");
      ab_str(&b, alines[i]);
      i++;
    } else {
      ab_cstr(&b, "\n- ");
      ab_str(&b, elines[j]);
      j++;
    }
  }
  for (; i < an; i++) {
    ab_cstr(&b, "\n+ ");
    ab_str(&b, alines[i]);
  }
  for (; j < en; j++) {
    ab_cstr(&b, "\n- ");
    ab_str(&b, elines[j]);
  }
  ab_cstr(&b, "\n");
  for (size_t k = 0; k < an; k++) scr_str_release(alines[k]);
  for (size_t k = 0; k < en; k++) scr_str_release(elines[k]);
  scr_assert_fail_msg(ab_take(&b));
}

void scr_assert_shape_end(ScrStr *msg, bool has_msg, bool rejection) {
  if (scr_shape_matches()) {
    scr_shape_clear();
    return;
  }
  /* Node's actual is the thrown error. The expected object has no runtime
   * box here (its regex values exist only as their rendering), so expected
   * stays undefined. */
  scr_assert_record(scr_dyn_from_error(scr_shape.err), NULL, rejection ? "rejects" : "throws");
  if (has_msg && msg->len > 0) {
    scr_shape_clear();
    scr_assert_fail(scr_str_retain(msg), false);
    return;
  }
  scr_shape_diff_fail();
  scr_shape_clear();
}

/* assert.doesNotReject whose rejection matched the expectation (or had
 * none): expectsNoError's generated message. */
void scr_assert_unwanted_rejection(ScrError *err, ScrStr *msg, bool has_msg) {
  ScrAssertBuf b = {0};
  ab_cstr(&b, "Got unwanted rejection");
  if (has_msg && msg->len > 0) {
    ab_cstr(&b, ": ");
    ab_str(&b, msg);
  } else {
    ab_char(&b, '.');
  }
  ab_cstr(&b, "\nActual message: \"");
  if (err->message) ab_str(&b, err->message);
  ab_char(&b, '"');
  scr_assert_record(scr_dyn_from_error(err), NULL, "doesNotReject");
  scr_assert_fail(ab_take(&b), false);
}

void scr_assert_unwanted_error(ScrStr *actual_message, bool rejection, ScrStr *msg, bool has_msg) {
  ScrAssertBuf b = {0};
  ab_cstr(&b, rejection ? "Got unwanted rejection" : "Got unwanted exception");
  if (has_msg && msg->len) {
    ab_cstr(&b, ": ");
    ab_str(&b, msg);
  } else ab_char(&b, '.');
  ab_cstr(&b, "\nActual message: \"");
  ab_str(&b, actual_message);
  ab_char(&b, '"');
  /* The compiled call recorded the caught value as actual. */
  scr_assert_fail(ab_take(&b), false);
}

/* Node calls validation functions with a fresh object receiver and accepts
 * only the boolean true. A callback exception remains the pending exception. */
bool scr_assert_no_error_predicate(ScrDyn *predicate, ScrDyn *actual) {
  ScrDyn *receiver = scr_dyn_new_obj();
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *result = scr_dyn_call(predicate, &actual, 1, "expected");
  scr_dyn_this_pop();
  scr_dyn_release(receiver);
  bool matched = result && result->kind == SCR_DYN_BOOL && result->v.b;
  scr_dyn_release(result);
  return matched;
}

/* assert.throws/rejects with a validation function (expectedException's
 * function branch, after its instanceof check): the function runs with a
 * fresh object as `this` and the caught value, and any result but true
 * fails, with Node's generated message unless the call passed one. The
 * caught value and the function are the AssertionError's actual and
 * expected. Borrows all. */
void scr_assert_throws_validate(ScrDyn *actual, ScrDyn *validate, ScrStr *op, ScrStr *msg,
                                bool has_msg) {
  ScrDyn *receiver = scr_dyn_new_obj();
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *result = scr_dyn_call(validate, &actual, 1, "expected");
  scr_dyn_this_pop();
  scr_dyn_release(receiver);
  if (!result) return;
  if (result->kind == SCR_DYN_BOOL && result->v.b) {
    scr_dyn_release(result);
    return;
  }
  ScrStr *message;
  bool generated = !(has_msg && msg->len > 0);
  if (!generated) {
    message = scr_str_retain(msg);
  } else {
    ScrAssertBuf b = {0};
    ab_cstr(&b, "The ");
    ScrDyn *name = scr_dyn_fn_get(validate, "name", 4);
    if (name && name->kind == SCR_DYN_STR && name->v.str->len > 0) {
      ab_cstr(&b, "\"");
      ab_bytes(&b, name->v.str->data, name->v.str->len);
      ab_cstr(&b, "\" ");
    }
    if (name) scr_dyn_release(name);
    ab_cstr(&b, "validation function is expected to return \"true\". Received ");
    ScrStr *shown = scr_assert_cf_inspect(result);
    ab_bytes(&b, shown->data, shown->len);
    scr_str_release(shown);
    if (scr_dyn_ref_is_error(actual)) {
      ScrStr *text = scr_dyn_string_coerce_js(actual);
      if (!text) {
        scr_dyn_release(result);
        scr_str_release(ab_take(&b));
        return;
      }
      ab_cstr(&b, "\n\nCaught error:\n\n");
      ab_bytes(&b, text->data, text->len);
      scr_str_release(text);
    }
    message = ab_take(&b);
  }
  scr_dyn_release(result);
  scr_assert_record_dyn(actual, validate, op);
  scr_assert_fail(message, generated);
}

/* ── assert.ifError ───────────────────────────────────────────────────
 * Node throws for ANY value but null/undefined (falsy included); the
 * frontend routes null/undefined to a no-op and everything else here.
 * The detail is the error's message (its name when the message is
 * empty — Node reads constructor.name, identical for the builtin
 * hierarchy) or the value's inspection. */

/* `actual` moves in. */
static void scr_assert_iferror_fail(const char *detail, size_t len, ScrDyn *actual) {
  ScrAssertBuf b = {0};
  ab_cstr(&b, "ifError got unwanted exception: ");
  ab_bytes(&b, detail, len);
  scr_assert_record(actual, scr_dyn_new_null(), "ifError");
  scr_assert_fail(ab_take(&b), false);
}

void scr_assert_iferror_err(ScrError *err) {
  const ScrStr *d = err->message && err->message->len > 0 ? err->message : err->name;
  scr_assert_iferror_fail(d ? d->data : "", d ? d->len : 0, scr_dyn_from_error(err));
}

void scr_assert_iferror_f64(double x) {
  char buf[40];
  size_t n = scr_assert_inspect_f64(x, buf);
  scr_assert_iferror_fail(buf, n, scr_dyn_new_num(x));
}

void scr_assert_iferror_str(ScrStr *s) {
  ScrStr *q = scr_assert_inspect_str(s);
  scr_assert_iferror_fail(q->data, q->len, scr_dyn_new_str(s));
  scr_str_release(q);
}

void scr_assert_iferror_bool(bool v) {
  scr_assert_iferror_fail(v ? "true" : "false", v ? 4 : 5, scr_dyn_new_bool(v));
}

/* The checked-dynamic argument (test/common's mustSucceed wrapper): the
 * dyn kind dispatches — units pass quietly, %error-marked objects (the
 * caughtToDyn encoding) throw with the error's message (its name when
 * the message is empty, Node's rule), everything else throws with the
 * value's inspection. */
void scr_assert_iferror_dyn(const ScrDyn *v) {
  if (v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL) return;
  if (v->kind == SCR_DYN_OBJ && scr_dyn_obj_get(v, "%error", 6) != NULL) {
    const ScrDyn *msg = scr_dyn_obj_get(v, "message", 7);
    const ScrDyn *name = scr_dyn_obj_get(v, "name", 4);
    const ScrDyn *d = msg != NULL && msg->kind == SCR_DYN_STR && msg->v.str->len > 0 ? msg : name;
    if (d != NULL && d->kind == SCR_DYN_STR) {
      scr_assert_iferror_fail(d->v.str->data, d->v.str->len, scr_dyn_retain((ScrDyn *)v));
      return;
    }
  }
  ScrStr *q = scr_assert_cf_inspect(v);
  scr_assert_iferror_fail(q->data, q->len, scr_dyn_retain((ScrDyn *)v));
  scr_str_release(q);
}

/* ── new AssertionError(options) ───────────────────────────────────────
 * assertion_error.js's constructor: the message is the options' message
 * (with the diff below it for strictEqual and deepStrictEqual), or the
 * one generated from operator, actual and expected. */

static bool scr_assert_op_is(const ScrDyn *op, const char *name) {
  return op && op->kind == SCR_DYN_STR && op->v.str->len == strlen(name) &&
         memcmp(op->v.str->data, name, op->v.str->len) == 0;
}

/* `text` past `max` UTF-8 bytes keeps its first `keep` and ends in "...",
 * unless `full` (Node's `diff: 'full'`). */
static void scr_assert_ab_clipped(ScrAssertBuf *b, const ScrStr *text, size_t max, size_t keep,
                                  bool full) {
  if (!full && text->len > max) {
    ab_bytes(b, text->data, keep);
    ab_cstr(b, "...");
  } else {
    ab_str(b, text);
  }
}

/* The loose and generic forms: deepEqual's and notDeepEqual's banners,
 * else `<actual> <operator> <expected>`. */
static ScrStr *scr_assert_generic_message(const ScrDyn *actual, const ScrDyn *expected,
                                          const ScrDyn *op, bool full) {
  ScrStr *res = scr_assert_cf_inspect(actual);
  ScrStr *other = scr_assert_cf_inspect(expected);
  ScrAssertBuf b = {0};
  bool same = res->len == other->len && memcmp(res->data, other->data, res->len) == 0;
  if (scr_assert_op_is(op, "notDeepEqual") && same) {
    ScrAssertBuf head = {0};
    ab_cstr(&head, "Expected \"actual\" not to be loosely deep-equal to:\n\n");
    ab_str(&head, res);
    ScrStr *whole = ab_take(&head);
    scr_assert_ab_clipped(&b, whole, 1024, 1021, full);
    scr_str_release(whole);
  } else if (scr_assert_op_is(op, "deepEqual") || scr_assert_op_is(op, "notDeepEqual")) {
    bool deep_equal = scr_assert_op_is(op, "deepEqual");
    ab_cstr(&b, deep_equal ? "Expected values to be loosely deep-equal:\n\n"
                           : "Expected values not to be loosely deep-equal:\n\n");
    scr_assert_ab_clipped(&b, res, 512, 509, full);
    ab_cstr(&b, deep_equal ? "\n\nshould loosely deep-equal\n\n" : "\n\nshould not loosely deep-equal\n\n");
    scr_assert_ab_clipped(&b, other, 512, 509, full);
  } else {
    scr_assert_ab_clipped(&b, res, 512, 509, full);
    ab_char(&b, ' ');
    if (op && op->kind == SCR_DYN_STR) ab_str(&b, op->v.str);
    else ab_cstr(&b, "undefined");
    ab_char(&b, ' ');
    scr_assert_ab_clipped(&b, other, 512, 509, full);
  }
  scr_str_release(res);
  scr_str_release(other);
  return ab_take(&b);
}

ScrError *scr_assert_error_new(ScrDyn *options) {
  if (options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(options);
    if (!value) return NULL;
    ScrError *e = scr_assert_error_new(value);
    scr_dyn_release(value);
    return e;
  }
  if (options->kind != SCR_DYN_OBJ) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return NULL;
  }
  ScrDyn *message = scr_dyn_obj_read(options, "message", 7);
  ScrDyn *op = scr_dyn_obj_read(options, "operator", 8);
  ScrDyn *actual = scr_dyn_obj_read(options, "actual", 6);
  ScrDyn *expected = scr_dyn_obj_read(options, "expected", 8);
  ScrDyn *diff = scr_dyn_obj_read(options, "diff", 4);
  if (!actual) actual = scr_dyn_retain(scr_dyn_undefined());
  if (!expected) expected = scr_dyn_retain(scr_dyn_undefined());
  if (!op) op = scr_dyn_retain(scr_dyn_undefined());
  if (!diff || diff->kind == SCR_DYN_UNDEF) {
    if (diff) scr_dyn_release(diff);
    diff = scr_assert_dyn_text("simple");
  }
  bool custom = message && message->kind != SCR_DYN_UNDEF && message->kind != SCR_DYN_NULL;
  bool generated = !message || !scr_dyn_truthy(message); /* Node: !message */
  bool strict = scr_assert_op_is(op, "strictEqual"), deep = scr_assert_op_is(op, "deepStrictEqual");
  bool partial = scr_assert_op_is(op, "partialDeepStrictEqual");
  const char *header = partial ? scr_assert_partial_header : NULL;
  bool full = scr_assert_op_is(diff, "full"); /* Node collapses unless diff === 'full' */
  ScrStr *text = NULL;
  if (custom) {
    ScrStr *given = message->kind == SCR_DYN_STR ? scr_str_retain(message->v.str)
                                                 : scr_dyn_string_coerce_js(message);
    if (given && (strict || deep || partial)) {
      text = scr_assert_dyn_diff_message(actual, expected, deep || partial, header, given, true, full);
      scr_str_release(given);
    } else {
      text = given;
    }
  } else if (strict || deep || partial) {
    text = scr_assert_dyn_diff_message(actual, expected, deep || partial, header, NULL, false, full);
  } else if (scr_assert_op_is(op, "notStrictEqual") || scr_assert_op_is(op, "notDeepStrictEqual")) {
    text = scr_assert_dyn_neq_message(actual, scr_assert_op_is(op, "notDeepStrictEqual"), full);
  } else {
    text = scr_assert_generic_message(actual, expected, op, full);
  }
  if (message) scr_dyn_release(message);
  if (!text) {
    scr_dyn_release(actual);
    scr_dyn_release(expected);
    scr_dyn_release(op);
    scr_dyn_release(diff);
    return NULL;
  }
  ScrError *e = scr_error_new(SCR_ERR_ASSERTION, text);
  scr_str_release(text);
  e->name_present = true;
  scr_assert_attach_values(e, generated, actual, expected, op, diff);
  return e;
}

/* ── assert functions as values ──────────────────────────────────────────
 * `assert.fail` stored or passed as a function (`emitter.on("x",
 * assert.fail)`): one function per method, which takes its arguments as
 * untyped values and asserts as the method does. */

/* Node's message argument: absent or null/undefined (a generated message),
 * a string, an Error (thrown when the assertion fails), or another value
 * (String(value)). The value is registered as scr_assert_fail reads it; the
 * caller clears it after the assertion. +1 into *msg. */
static void scr_av_message(ScrDyn *const *args, size_t argc, size_t i, ScrStr **msg, bool *has) {
  const ScrDyn *m = i < argc ? args[i] : NULL;
  if (!m || m->kind == SCR_DYN_UNDEF || m->kind == SCR_DYN_NULL) {
    *msg = scr_str_new("", 0);
    *has = false;
    return;
  }
  *has = true;
  if (m->kind == SCR_DYN_STR) {
    *msg = scr_str_retain(m->v.str);
    return;
  }
  bool error = scr_dyn_ref_is_error(m) ||
               (m->kind == SCR_DYN_OBJ && scr_dyn_obj_get(m, "%error", 6) != NULL);
  scr_assert_message_value((ScrDyn *)m, error);
  *msg = scr_str_new(SCR_ASSERT_VALUE_MESSAGE, sizeof SCR_ASSERT_VALUE_MESSAGE - 1);
}

static const ScrDyn *scr_av_arg(ScrDyn *const *args, size_t argc, size_t i) {
  return i < argc ? args[i] : scr_dyn_undefined();
}

static ScrDyn *scr_av_done(ScrStr *msg) {
  scr_str_release(msg);
  scr_assert_message_clear();
  return scr_dyn_retain(scr_dyn_undefined());
}

/* assert(value, message) and assert.ok: Node's generated message quotes
 * the call's source, which a function value has no fixed site for; the
 * message here is AssertionError's own `value == true`. */
static ScrDyn *scr_av_ok(ScrClosure *c, ScrDyn *const *args, size_t argc) {
  (void)c;
  const ScrDyn *value = scr_av_arg(args, argc, 0);
  if (scr_dyn_truthy(value)) return scr_dyn_retain(scr_dyn_undefined());
  scr_assert_record(scr_dyn_retain((ScrDyn *)value), scr_dyn_new_bool(true), "==");
  if (argc == 0) {
    static const char text[] = "No value argument passed to `assert.ok()`";
    scr_assert_fail(scr_str_new(text, sizeof text - 1), true);
    return NULL;
  }
  ScrStr *msg;
  bool has;
  scr_av_message(args, argc, 1, &msg, &has);
  if (has) {
    scr_assert_fail(scr_str_retain(msg), false);
    return scr_av_done(msg);
  }
  ScrStr *shown = scr_assert_cf_inspect(value);
  ScrAssertBuf b = {0};
  ab_str(&b, shown);
  ab_cstr(&b, " == true");
  scr_str_release(shown);
  scr_assert_fail(ab_take(&b), true);
  return scr_av_done(msg);
}

/* assert.fail(message): "Failed" without a message. */
static ScrDyn *scr_av_fail(ScrClosure *c, ScrDyn *const *args, size_t argc) {
  (void)c;
  if (argc > 1) {
    static const char text[] = "assert.fail with more than one argument through a function value is not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, text, sizeof text - 1, "SC2020");
    return NULL;
  }
  ScrStr *msg;
  bool has;
  scr_av_message(args, argc, 0, &msg, &has);
  scr_assert_record(scr_dyn_retain(scr_dyn_undefined()), scr_dyn_retain(scr_dyn_undefined()), "fail");
  if (has) scr_assert_fail(scr_str_retain(msg), false);
  else scr_assert_fail(scr_str_new("Failed", 6), true);
  return scr_av_done(msg);
}

/* The comparison methods take both operands: Node's ERR_MISSING_ARGS
 * TypeError otherwise. False with it pending. */
static bool scr_av_operands(size_t argc) {
  if (argc >= 2) return true;
  static const char text[] = "The \"actual\" and \"expected\" arguments must be specified";
  scr_throw_error_msg_code(SCR_ERR_TYPE, text, sizeof text - 1, "ERR_MISSING_ARGS");
  return false;
}

/* equal / notEqual: Node's loose comparison, NaN equal to NaN. */
static ScrDyn *scr_av_loose(ScrDyn *const *args, size_t argc, bool negated) {
  if (!scr_av_operands(argc)) return NULL;
  const ScrDyn *a = scr_av_arg(args, argc, 0), *b = scr_av_arg(args, argc, 1);
  bool nan = a->kind == SCR_DYN_NUM && b->kind == SCR_DYN_NUM && isnan(a->v.num) && isnan(b->v.num);
  bool equal = nan || scr_dyn_abstract_eq(a, b);
  if (scr_exc_pending()) return NULL;
  if (negated ? !equal : equal) return scr_dyn_retain(scr_dyn_undefined());
  ScrStr *msg;
  bool has;
  scr_av_message(args, argc, 2, &msg, &has);
  scr_assert_record(scr_dyn_retain((ScrDyn *)a), scr_dyn_retain((ScrDyn *)b), negated ? "!=" : "==");
  ScrStr *ia = scr_assert_cf_inspect(a), *ib = scr_assert_cf_inspect(b);
  scr_assert_loose_result(equal, negated, ia, ib, msg, has);
  scr_str_release(ia);
  scr_str_release(ib);
  return scr_av_done(msg);
}

static ScrDyn *scr_av_equal(ScrClosure *c, ScrDyn *const *a, size_t n) {
  (void)c;
  return scr_av_loose(a, n, false);
}
static ScrDyn *scr_av_not_equal(ScrClosure *c, ScrDyn *const *a, size_t n) {
  (void)c;
  return scr_av_loose(a, n, true);
}

/* The strict and deep comparisons, through the untyped assert paths. */
enum { SCR_AV_STRICT, SCR_AV_DEEP_STRICT, SCR_AV_DEEP, SCR_AV_PARTIAL };

static ScrDyn *scr_av_compare(ScrDyn *const *args, size_t argc, int form, bool negated) {
  if (!scr_av_operands(argc)) return NULL;
  ScrDyn *a = (ScrDyn *)scr_av_arg(args, argc, 0), *b = (ScrDyn *)scr_av_arg(args, argc, 1);
  ScrStr *msg;
  bool has;
  scr_av_message(args, argc, 2, &msg, &has);
  if (form == SCR_AV_DEEP) scr_assert_loose_deep_dyn(a, b, negated, msg, has);
  else if (form == SCR_AV_PARTIAL) scr_assert_partial_deep_dyn(a, b, msg, has);
  else scr_assert_eq_dyn(a, b, negated, form == SCR_AV_DEEP_STRICT, msg, has);
  return scr_av_done(msg);
}

static ScrDyn *scr_av_strict_equal(ScrClosure *c, ScrDyn *const *a, size_t n) {
  (void)c;
  return scr_av_compare(a, n, SCR_AV_STRICT, false);
}
static ScrDyn *scr_av_not_strict_equal(ScrClosure *c, ScrDyn *const *a, size_t n) {
  (void)c;
  return scr_av_compare(a, n, SCR_AV_STRICT, true);
}
static ScrDyn *scr_av_deep_strict_equal(ScrClosure *c, ScrDyn *const *a, size_t n) {
  (void)c;
  return scr_av_compare(a, n, SCR_AV_DEEP_STRICT, false);
}
static ScrDyn *scr_av_not_deep_strict_equal(ScrClosure *c, ScrDyn *const *a, size_t n) {
  (void)c;
  return scr_av_compare(a, n, SCR_AV_DEEP_STRICT, true);
}
static ScrDyn *scr_av_deep_equal(ScrClosure *c, ScrDyn *const *a, size_t n) {
  (void)c;
  return scr_av_compare(a, n, SCR_AV_DEEP, false);
}
static ScrDyn *scr_av_not_deep_equal(ScrClosure *c, ScrDyn *const *a, size_t n) {
  (void)c;
  return scr_av_compare(a, n, SCR_AV_DEEP, true);
}
static ScrDyn *scr_av_partial_deep_strict_equal(ScrClosure *c, ScrDyn *const *a, size_t n) {
  (void)c;
  return scr_av_compare(a, n, SCR_AV_PARTIAL, false);
}

static ScrDyn *scr_av_if_error(ScrClosure *c, ScrDyn *const *args, size_t argc) {
  (void)c;
  scr_assert_iferror_dyn(scr_av_arg(args, argc, 0));
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

static const struct {
  const char *name;
  ScrDynThunk thunk;
  uint32_t arity;
} scr_av_methods[] = {
    {"ok", &scr_av_ok, 0},
    {"fail", &scr_av_fail, 1},
    {"equal", &scr_av_equal, 3},
    {"notEqual", &scr_av_not_equal, 3},
    {"strictEqual", &scr_av_strict_equal, 3},
    {"notStrictEqual", &scr_av_not_strict_equal, 3},
    {"deepEqual", &scr_av_deep_equal, 3},
    {"notDeepEqual", &scr_av_not_deep_equal, 3},
    {"deepStrictEqual", &scr_av_deep_strict_equal, 3},
    {"notDeepStrictEqual", &scr_av_not_deep_strict_equal, 3},
    {"partialDeepStrictEqual", &scr_av_partial_deep_strict_equal, 3},
    {"ifError", &scr_av_if_error, 1},
};
#define SCR_AV_COUNT (sizeof scr_av_methods / sizeof scr_av_methods[0])
static SCR_TL ScrDyn *scr_av_values[SCR_AV_COUNT];
static SCR_TL bool scr_av_registered;

static void scr_av_cleanup(void) {
  for (size_t i = 0; i < SCR_AV_COUNT; i++) {
    scr_dyn_release(scr_av_values[i]);
    scr_av_values[i] = NULL;
  }
  scr_av_registered = false;
}

/* The function value of an assert method by its canonical name (the frontend
 * maps assert/strict's aliases), +1; one value per method, so stored copies
 * compare equal. */
ScrDyn *scr_assert_method_value(ScrStr *name) {
  for (size_t i = 0; i < SCR_AV_COUNT; i++) {
    if (strlen(scr_av_methods[i].name) != name->len ||
        memcmp(scr_av_methods[i].name, name->data, name->len) != 0)
      continue;
    if (!scr_av_values[i]) {
      if (!scr_av_registered) {
        scr_av_registered = true;
        scr_atexit(scr_av_cleanup);
      }
      scr_av_values[i] = scr_dyn_new_func(scr_closure_new(NULL, 0), scr_av_methods[i].thunk,
                                          scr_av_methods[i].arity, "native:assert",
                                          scr_av_methods[i].name);
    }
    return scr_dyn_retain(scr_av_values[i]);
  }
  return scr_dyn_retain(scr_dyn_undefined());
}
