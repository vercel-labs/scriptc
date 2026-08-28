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

/* Throws an AssertionError with `message` (ownership MOVES in): a runtime
 * %Error whose name/code are Node's. The exception is pending on return —
 * callers return through the emitter's pending check like every other
 * throwing libCall. */
void scr_assert_fail_msg(ScrStr *message) {
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message); /* scr_error_new retained its copy */
  scr_str_release(e->name);
  e->name = scr_str_new("AssertionError", 14);
  scr_error_set_code(e, "ERR_ASSERTION");
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* assert(value) / assert.ok(value[, message]) / assert.fail([message]):
 * the frontend computed the truthiness and the FULL message (the user's
 * string, or the compile-time "The expression evaluated to a falsy
 * value:\n\n  <source text>\n" — the source is a compile-time constant
 * where Node re-reads the file). */
void scr_assert_ok(bool pass, ScrStr *message) {
  if (pass) return;
  scr_assert_fail_msg(scr_str_retain(message));
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
    scr_assert_fail_msg(scr_str_retain(msg));
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
  if (has_msg && msg->len > 0) {
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
  scr_assert_fail_msg(ab_take(&b));
}

/* strictEqual / notStrictEqual / deepStrictEqual / notDeepStrictEqual over
 * numbers: Object.is comparison, inspect distinguishes -0. */
void scr_assert_eq_f64(double a, double b, bool negated, bool deep,
                       ScrStr *msg, bool has_msg) {
  bool same = scr_assert_same_value_f64(a, b);
  if ((negated && !same) || (!negated && same)) return;
  char ia[40], ib[40];
  size_t la = scr_assert_inspect_f64(a, ia);
  if (negated) {
    scr_assert_neq_fail(ia, la, deep, msg, has_msg);
    return;
  }
  size_t lb = scr_assert_inspect_f64(b, ib);
  scr_assert_eq_fail(ia, la, ib, lb, 0, a == 0.0 && b == 0.0, true, deep, msg, has_msg);
}

/* The string forms: byte equality IS SameValue for well-formed UTF-8. */
void scr_assert_eq_str(ScrStr *a, ScrStr *b, bool negated, bool deep,
                       ScrStr *msg, bool has_msg) {
  bool same = a->len == b->len && memcmp(a->data, b->data, a->len) == 0;
  if ((negated && !same) || (!negated && same)) return;
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
  const char *ia = a ? "true" : "false";
  if (negated) {
    scr_assert_neq_fail(ia, strlen(ia), deep, msg, has_msg);
    return;
  }
  const char *ib = b ? "true" : "false";
  scr_assert_eq_fail(ia, strlen(ia), ib, strlen(ib), 0, false, true, deep, msg,
                     has_msg);
}

/* deepStrictEqual / notDeepStrictEqual over COMPOSITE values: the frontend
 * synthesized the honest structural comparison; this only turns its verdict
 * into Node's throw. The generated message is the header line alone —
 * rendering the value diff needs util.inspect, which has no static
 * lowering (SEMANTICS.md 102). */
void scr_assert_deep_result(bool equal, bool negated, ScrStr *msg, bool has_msg) {
  if ((negated && !equal) || (!negated && equal)) return;
  if (has_msg && (negated || msg->len > 0)) {
    /* Node: the not-equal operators use the message ALONE (even empty);
     * the equal operators use it as the diff HEADER when non-empty —
     * without a rendered diff below it the two collapse to the same
     * shape here. */
    scr_assert_fail_msg(scr_str_retain(msg));
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
  if (has_msg && (negated || msg->len > 0)) {
    /* The deepResult message stance: not-equal operators use it alone
     * (even empty); the equal operators use a non-empty one as the diff
     * header — headerless diffs collapse both to the message itself. */
    scr_assert_fail_msg(scr_str_retain(msg));
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
  if (has_msg && (negated || msg->len > 0)) {
    scr_assert_fail_msg(scr_str_retain(msg));
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
 * the simple/stacked scalar forms match the static paths byte-for-byte,
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
    case SCR_DYN_UNDEF:
    case SCR_DYN_NULL:
      return true;
    case SCR_DYN_BOOL:
      return a->v.b == b->v.b;
    case SCR_DYN_NUM:
      return scr_assert_same_value_f64(a->v.num, b->v.num);
    case SCR_DYN_STR:
      return a->v.str->len == b->v.str->len &&
             memcmp(a->v.str->data, b->v.str->data, a->v.str->len) == 0;
    case SCR_DYN_FUNC:
      return a == b || a->v.fn.clo == b->v.fn.clo;
    case SCR_DYN_HANDLE:
      /* Identity is the HANDLE (the strict_eq stance). */
      return a->v.handle.tag == b->v.handle.tag && a->v.handle.ptr == b->v.handle.ptr;
    case SCR_DYN_PROMISE:
      /* Identity is the PROMISE (the strict_eq stance). */
      return a->v.promise == b->v.promise;
    case SCR_DYN_JSVAL:
      /* Identity is the ENGINE VALUE (the strict_eq stance): the engine's
       * === — exact for SameValue too, since wrap-time scalar
       * normalization leaves only reference kinds behind. */
      return a == b || scr_dyn_jsval_ops()->strict_eq(a->v.jsval.cell, b->v.jsval.cell);
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
static bool scr_assert_dyn_deep_eq(const ScrDyn *a, const ScrDyn *b) {
  if (a == b) return true;
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
    /* A MIXED comparison with an island side (wrapped engine object vs
     * dyn data): Node walks both structurally — a plain `false` would
     * mint a fabricated AssertionError for values Node may call equal.
     * Loud fence (the long-tail lane's structural walk). */
    if (a->kind == SCR_DYN_JSVAL || b->kind == SCR_DYN_JSVAL) {
      scr_dyn_isl_fence(a->kind == SCR_DYN_JSVAL ? a : b, "deepStrictEqual");
    }
    return false;
  }
  switch (a->kind) {
    case SCR_DYN_UNDEF:
    case SCR_DYN_NULL:
      return true;
    case SCR_DYN_BOOL:
      return a->v.b == b->v.b;
    case SCR_DYN_NUM:
      return scr_assert_same_value_f64(a->v.num, b->v.num);
    case SCR_DYN_STR:
      return a->v.str->len == b->v.str->len &&
             memcmp(a->v.str->data, b->v.str->data, a->v.str->len) == 0;
    case SCR_DYN_FUNC:
      return a->v.fn.clo == b->v.fn.clo;
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
      if (a->buffer != b->buffer) return false; /* the prototype gate */
      const ScrBytes *x = a->v.bytes, *y = b->v.bytes;
      if (x->elem != y->elem || x->len != y->len) return false;
      size_t nbytes = x->len * scr_bytes_elem_size(x->elem);
      return nbytes == 0 || memcmp(x->data, y->data, nbytes) == 0;
    }
    case SCR_DYN_ARR: {
      if (a->v.arr.len != b->v.arr.len) return false;
      for (size_t i = 0; i < a->v.arr.len; i++) {
        if (!scr_assert_dyn_deep_eq(a->v.arr.items[i], b->v.arr.items[i])) return false;
      }
      return true;
    }
    case SCR_DYN_OBJ: {
      if (a->null_proto != b->null_proto) return false; /* the prototype gate */
      if (a->v.obj.len != b->v.obj.len) return false;
      for (size_t i = 0; i < a->v.obj.len; i++) {
        const ScrDynEntry *ent = &a->v.obj.entries[i];
        ScrDyn *bv = scr_dyn_obj_get(b, ent->key, ent->key_len);
        if (!bv || !scr_assert_dyn_deep_eq(ent->value, bv)) return false;
      }
      return true;
    }
    case SCR_DYN_JSVAL:
      /* Node walks the engine objects structurally — a walk this runtime
       * cannot run. Engine-identical answers true honestly; anything else
       * throws the loud ladder (scr_assert_eq_dyn propagates the pending
       * exception INSTEAD of minting an AssertionError). */
      if (scr_dyn_jsval_ops()->strict_eq(a->v.jsval.cell, b->v.jsval.cell)) return true;
      scr_dyn_isl_fence(a, "deepStrictEqual");
      return false;
    case SCR_DYN_TYPED_REF:
      return false; /* both mixed and same-kind capsules returned above */
  }
  return false; /* unreachable */
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
                        d->buffer ? "Buffer" : "Uint8Array", bs->len,
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
        size_t n = scr_assert_inspect_f64((double)((const unsigned char *)bs->data)[i], tmp);
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
    case SCR_DYN_JSVAL: {
      /* The depth-elided placeholder (the handle stance): Node renders
       * the engine object's property dump — internals this walker does
       * not model; the text only appears inside FAILURE reports, which
       * already diverge in format. */
      ab_cstr(b, "[island value]");
      return;
    }
    case SCR_DYN_TYPED_REF: {
      ScrDyn *materialized = scr_dyn_typed_ref_materialize(d);
      scr_assert_cf_value(b, materialized, indent, depth);
      scr_dyn_release(materialized);
      return;
    }
    case SCR_DYN_OBJ: {
      /* The null-proto dictionary renders with Node's prefix in the
       * failure diff too (assertion_error.js inspects both sides). */
      if (d->v.obj.len == 0) {
        ab_cstr(b, d->null_proto ? "[Object: null prototype] {}" : "{}");
        return;
      }
      if (depth == 0) {
        ab_cstr(b, d->null_proto ? "[Object: null prototype]" : "[Object]");
        return;
      }
      if (d->null_proto) ab_cstr(b, "[Object: null prototype] ");
      /* Render every entry, then sort the RENDERED texts (Node's
       * sorted:true sorts formatted entries, quotes included). */
      ScrCfEntry *ents = malloc(d->v.obj.len * sizeof *ents);
      if (!ents) scr_assert_oom();
      for (size_t i = 0; i < d->v.obj.len; i++) {
        const ScrDynEntry *ent = &d->v.obj.entries[i];
        ScrAssertBuf eb = {0};
        scr_assert_cf_key(&eb, ent->key, ent->key_len);
        ab_cstr(&eb, ": ");
        scr_assert_cf_value(&eb, ent->value, indent + 2, depth - 1);
        ents[i].text = eb.data ? eb.data : malloc(1);
        if (!ents[i].text) scr_assert_oom();
        ents[i].len = eb.len;
      }
      qsort(ents, d->v.obj.len, sizeof *ents, scr_assert_cf_entry_cmp);
      ab_char(b, '{');
      for (size_t i = 0; i < d->v.obj.len; i++) {
        ab_char(b, '\n');
        scr_assert_cf_pad(b, indent + 2);
        ab_bytes(b, ents[i].text, ents[i].len);
        if (i + 1 < d->v.obj.len) ab_char(b, ',');
        free(ents[i].text);
      }
      free(ents);
      ab_char(b, '\n');
      scr_assert_cf_pad(b, indent);
      ab_char(b, '}');
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
 * skipped flag. Trailing common lines past the window drop silently —
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
         d->kind == SCR_DYN_TYPED_REF ||
         scr_dyn_isl_typeof_is(d, "object"); /* engine-held: the engine's typeof */
}

/* The failing EQUAL operators over dyn operands — createErrDiff. */
static void scr_assert_dyn_eq_fail(ScrDyn *a, ScrDyn *b, bool deep,
                                   ScrStr *msg, bool has_msg) {
  /* checkOperator: strictEqual over two objects (or two functions)
   * reports the reference-equality expectation. */
  bool objOp = !deep && ((scr_assert_dyn_is_object(a) && scr_assert_dyn_is_object(b)) ||
                         (a->kind == SCR_DYN_FUNC && b->kind == SCR_DYN_FUNC));
  const char *header =
      deep ? "Expected values to be strictly deep-equal:"
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
    if (an > 50) {
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
  scr_assert_fail_msg(ab_take(&out));
}

/* The failing NOT-equal operators over dyn operands (values compared
 * same): a custom message stands alone; the generated one renders the
 * actual value under the operator's banner (the object banner for
 * notStrictEqual over objects/functions), inline when a single short
 * line, block form otherwise, >50-line renderings collapsed. */
static void scr_assert_dyn_neq_fail(ScrDyn *a, bool deep, ScrStr *msg, bool has_msg) {
  if (has_msg) {
    scr_assert_fail_msg(scr_str_retain(msg));
    return;
  }
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
    size_t shown = an > 50 ? 47 : an;
    for (size_t i = 0; i < shown; i++) {
      if (an > 50 && i == 46) {
        ab_cstr(&out, "...");
      } else {
        ab_bytes(&out, lines[i].s, lines[i].len);
      }
      ab_char(&out, '\n');
    }
  }
  free(lines);
  scr_str_release(ia);
  scr_assert_fail_msg(ab_take(&out));
}

/* strictEqual / notStrictEqual / deepStrictEqual / notDeepStrictEqual
 * where either operand is a checked-dynamic value (both arrive as dyn
 * values — the frontend boxes a static side). Borrows everything. */
void scr_assert_eq_dyn(ScrDyn *a, ScrDyn *b, bool negated, bool deep,
                       ScrStr *msg, bool has_msg) {
  bool same = deep ? scr_assert_dyn_deep_eq(a, b) : scr_assert_dyn_same_value(a, b);
  /* The deep walk's JSVAL arm fences loudly (an island value it cannot
   * compare structurally): propagate THAT, never a fabricated
   * AssertionError over a comparison that did not run. */
  if (scr_exc_pending()) return;
  if ((negated && !same) || (!negated && same)) return;
  if (negated) {
    scr_assert_dyn_neq_fail(a, deep, msg, has_msg);
  } else {
    scr_assert_dyn_eq_fail(a, b, deep, msg, has_msg);
  }
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
    for (size_t i = 0; i < expected->v.obj.len && ok; i++) {
      const ScrDynEntry *e = &expected->v.obj.entries[i];
      if (e->key_len == 6 && memcmp(e->key, "%error", 6) == 0) continue;
      ScrDyn *av = scr_dyn_obj_get(actual, e->key, e->key_len);
      if (av == NULL || !scr_assert_dyn_deep_eq(av, e->value)) ok = false;
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
  if (has_msg) {
    ab_cstr(&b, ": ");
    ab_str(&b, msg);
  } else {
    ab_cstr(&b, ".");
  }
  scr_assert_fail_msg(ab_take(&b));
}

/* assert.throws(fn, ErrorClass) where the thrown Error is NOT an instance
 * of the expected class: Node's mismatch AssertionError, built from the
 * received error's name and message. (Node prefers constructor.name; this
 * runtime carries the `name` slot — identical for the builtin hierarchy,
 * SEMANTICS.md 105 for subclasses whose constructor name differs.)
 * Borrows both. */
void scr_assert_throws_mismatch(ScrStr *expected_name, ScrError *err,
                                ScrStr *msg, bool has_msg) {
  if (has_msg) {
    /* A custom message stands alone (Node's innerFail with the user's
     * message — the instance-of text is the generated form only). */
    scr_assert_fail_msg(scr_str_retain(msg));
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

void scr_assert_shape_end(ScrStr *msg, bool has_msg) {
  if (scr_shape_matches()) {
    scr_shape_clear();
    return;
  }
  if (has_msg) {
    scr_shape_clear();
    scr_assert_fail_msg(scr_str_retain(msg));
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
  if (has_msg) {
    ab_cstr(&b, ": ");
    ab_str(&b, msg);
  } else {
    ab_char(&b, '.');
  }
  ab_cstr(&b, "\nActual message: \"");
  if (err->message) ab_str(&b, err->message);
  ab_char(&b, '"');
  scr_assert_fail_msg(ab_take(&b));
}

/* ── assert.ifError ───────────────────────────────────────────────────
 * Node throws for ANY value but null/undefined (falsy included); the
 * frontend routes null/undefined to a no-op and everything else here.
 * The detail is the error's message (its name when the message is
 * empty — Node reads constructor.name, identical for the builtin
 * hierarchy) or the value's inspection. */

static void scr_assert_iferror_fail(const char *detail, size_t len) {
  ScrAssertBuf b = {0};
  ab_cstr(&b, "ifError got unwanted exception: ");
  ab_bytes(&b, detail, len);
  scr_assert_fail_msg(ab_take(&b));
}

void scr_assert_iferror_err(ScrError *err) {
  const ScrStr *d = err->message && err->message->len > 0 ? err->message : err->name;
  scr_assert_iferror_fail(d ? d->data : "", d ? d->len : 0);
}

void scr_assert_iferror_f64(double x) {
  char buf[40];
  size_t n = scr_assert_inspect_f64(x, buf);
  scr_assert_iferror_fail(buf, n);
}

void scr_assert_iferror_str(ScrStr *s) {
  ScrStr *q = scr_assert_inspect_str(s);
  scr_assert_iferror_fail(q->data, q->len);
  scr_str_release(q);
}

void scr_assert_iferror_bool(bool v) {
  scr_assert_iferror_fail(v ? "true" : "false", v ? 4 : 5);
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
      scr_assert_iferror_fail(d->v.str->data, d->v.str->len);
      return;
    }
  }
  ScrStr *q = scr_assert_cf_inspect(v);
  scr_assert_iferror_fail(q->data, q->len);
  scr_str_release(q);
}
