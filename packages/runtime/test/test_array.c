/* Unit tests for the array runtime (scr_array.c). Built with ASan +
 * -DSCR_RC_AUDIT by array.test.ts, which also asserts the trap modes abort:
 *
 *   (no args)          run all assertions; prints "N/N cases passed"
 *   --crash-get-oob    read past the end        → RangeError + abort()
 *   --crash-get-frac   read a fractional index  → RangeError + abort()
 *   --crash-hole-read  read a hole             → RangeError + abort()
 *   --crash-pop-empty  pop an empty array       → RangeError + abort()
 *
 * The RC-recursion cases (array of strings, array of arrays of strings)
 * assert live counts directly: releasing the outer array must release
 * every reachable element exactly once.
 */
#include "../src/scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCR_RC_AUDIT
long scr_str_live_count(void); /* provided by scr_string.c */
long scr_arr_live_count(void); /* provided by scr_array.c */
#endif

static long total = 0, failed = 0;

static void check(bool ok, const char *what) {
  total++;
  if (!ok) {
    failed++;
    fprintf(stderr, "FAIL: %s\n", what);
  }
}

static void check_f64(double got, double want, const char *what) {
  check(got == want, what);
  if (got != want) fprintf(stderr, "  got %g want %g\n", got, want);
}

static void test_f64_basics(void) {
  ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
  check_f64(scr_arr_len(a), 0, "new array is empty");
  check_f64(scr_arr_push_f64(a, 1.5), 1, "push returns new length");
  check_f64(scr_arr_push_f64(a, -0.0), 2, "push returns new length (2)");
  check_f64(scr_arr_get_f64(a, 0), 1.5, "get_f64[0]");
  check(scr_arr_get_f64(a, 1) == 0 && signbit(scr_arr_get_f64(a, 1)),
        "-0 round-trips through a slot");
  scr_arr_set_f64(a, 0, 7);
  check_f64(scr_arr_get_f64(a, 0), 7, "set_f64 replaces");
  scr_arr_set_f64(a, 2, 9); /* i == len appends */
  check_f64(scr_arr_len(a), 3, "set at len appends");
  check_f64(scr_arr_get_f64(a, 2), 9, "appended value readable");
  check_f64(scr_arr_pop_f64(a), 9, "pop returns last");
  check_f64(scr_arr_len(a), 2, "pop shrinks");
  /* NaN round-trips bit-exactly through the uint64_t slot. */
  scr_arr_push_f64(a, 0.0 / 0.0);
  check(scr_arr_get_f64(a, 2) != scr_arr_get_f64(a, 2), "NaN round-trips");
  /* growth across many appends */
  for (double i = 0; i < 1000; i++) scr_arr_push_f64(a, i);
  check_f64(scr_arr_len(a), 1003, "1000 pushes grow");
  check_f64(scr_arr_get_f64(a, 1002), 999, "last survives growth");
  check_f64(scr_arr_get_f64(a, 0), 7, "first survives growth");
  scr_arr_release(a);
}

static void test_numeric_read(void) {
  ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
  check(isnan(scr_arr_get_number(a, 0)), "numeric read of empty array");
  scr_arr_set_f64(a, 0, -0.0);
  check(signbit(scr_arr_get_number(a, -0.0)), "numeric read preserves signed zero");
  scr_arr_set_f64(a, 3, INFINITY);
  check(isnan(scr_arr_get_number(a, 1)), "numeric read of dense hole");
  check_f64(scr_arr_get_number(a, 3), INFINITY, "numeric read of infinity");
  scr_arr_set_undefined(a, 2);
  check(isnan(scr_arr_get_number(a, 2)) && scr_arr_has(a, 2),
        "numeric read of present undefined keeps presence");
  scr_arr_set_f64(a, 4294967294.0, -INFINITY);
  check_f64(scr_arr_get_number(a, 4294967294.0), -INFINITY,
            "numeric read of last sparse array index");
  check(isnan(scr_arr_get_number(a, 4294967293.0)), "numeric read of sparse hole");
  scr_arr_set_undefined(a, 4294967294.0);
  check(isnan(scr_arr_get_number(a, 4294967294.0)), "numeric read of sparse undefined");
  double keys[] = {-1, 0.5, 4294967295.0, NAN, INFINITY, -INFINITY};
  for (size_t i = 0; i < sizeof keys / sizeof *keys; i++) {
    check(isnan(scr_arr_get_number(a, keys[i])), "numeric read of missing property");
    scr_arr_set_f64(a, keys[i], (double)i + 10);
    check_f64(scr_arr_get_number(a, keys[i]), (double)i + 10,
              "numeric read of ordinary numeric property");
    scr_arr_set_undefined(a, keys[i]);
    check(isnan(scr_arr_get_number(a, keys[i])) && scr_arr_has(a, keys[i]),
          "numeric read of undefined numeric property");
  }
  scr_arr_set_f64(a, 0, NAN);
  check(isnan(scr_arr_get_number(a, 0)), "numeric read of stored NaN");
  scr_arr_release(a);
}

static void test_bool(void) {
  ScrArr *a = scr_arr_new(SCR_ELEM_BOOL, 2);
  scr_arr_push_bool(a, true);
  scr_arr_push_bool(a, false);
  check(scr_arr_get_bool(a, 0) == true, "get_bool true");
  check(scr_arr_get_bool(a, 1) == false, "get_bool false");
  scr_arr_set_bool(a, 0, false);
  check(scr_arr_get_bool(a, 0) == false, "set_bool replaces");
  check(scr_arr_pop_bool(a) == false, "pop_bool");
  scr_arr_release(a);
}

static void test_dense_replacement(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
#endif
  ScrArr *a = scr_arr_new(SCR_ELEM_STR, 32);
  scr_arr_set_ref(a, 7, scr_str_new("first", 5));
  check(scr_arr_len(a) == 8 && !scr_arr_has(a, 6),
        "write within capacity grows length without filling holes");
  /* Self-assignment moves the getter's retained reference back in. */
  scr_arr_set_ref(a, 7, scr_arr_get_ref(a, 7));
  ScrStr *s = scr_arr_get_ref(a, 7);
  check(s->rc == 2 && strcmp(s->data, "first") == 0,
        "self replacement preserves exactly one stored reference");
  scr_str_release(s);
  scr_arr_set_undefined(a, 7);
  scr_arr_set_ref(a, 7, scr_str_new("second", 6));
  scr_arr_delete(a, 7);
  scr_arr_set_ref(a, 7, scr_str_new("third", 5));
  scr_arr_set_len(a, 0);
  scr_arr_set_ref(a, 9, scr_str_new("last", 4));
  check(!scr_arr_has(a, 7) && scr_arr_len(a) == 10,
        "refill after truncation does not resurrect old entries");
  s = scr_arr_get_ref(a, 9);
  check(strcmp(s->data, "last") == 0, "refill after truncation owns new value");
  scr_str_release(s);
  scr_arr_release(a);
#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings0, "dense replacements release every string");
#endif
}

static void test_unshift_reverse(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
  long arrays0 = scr_arr_live_count();
#endif

  /* The emitter applies variadic unshift arguments right-to-left. */
  ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(a, 3);
  scr_arr_push_f64(a, 4);
  check_f64(scr_arr_unshift_f64(a, 2), 3, "unshift f64 grows");
  check_f64(scr_arr_unshift_f64(a, 1), 4, "variadic-style unshift length");
  check_f64(scr_arr_get_f64(a, 0), 1, "unshift preserves arg order [0]");
  check_f64(scr_arr_get_f64(a, 1), 2, "unshift preserves arg order [1]");

  ScrArr *same = scr_arr_reverse(a);
  check(same == a, "reverse returns receiver identity");
  check_f64(scr_arr_get_f64(a, 0), 4, "reverse mutates first slot");
  check_f64(scr_arr_get_f64(a, 3), 1, "reverse mutates last slot");
  scr_arr_release(same); /* reverse's returned +1 */

  ScrArr *front = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(front, 8);
  scr_arr_push_f64(front, 9);
  check_f64(scr_arr_unshift_spread(a, front), 6, "unshift spread length");
  check_f64(scr_arr_get_f64(a, 0), 8, "unshift spread first");
  check_f64(scr_arr_get_f64(a, 1), 9, "unshift spread second");
  scr_arr_release(front);
  scr_arr_release(a);

  /* Self-spread snapshots the original block before front insertion. */
  ScrArr *self = scr_arr_new(SCR_ELEM_BOOL, 0);
  scr_arr_push_bool(self, true);
  scr_arr_push_bool(self, false);
  check_f64(scr_arr_unshift_spread(self, self), 4, "unshift self-spread length");
  check(scr_arr_get_bool(self, 0) && !scr_arr_get_bool(self, 1),
        "unshift self-spread copied prefix");
  check(scr_arr_get_bool(self, 2) && !scr_arr_get_bool(self, 3),
        "unshift self-spread kept original tail");
  scr_arr_release(self);

  /* Spread retains ref elements; either array may then die first. */
  ScrArr *src = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(src, scr_str_new("front", 5));
  ScrArr *dst = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(dst, scr_str_new("back", 4));
  scr_arr_unshift_spread(dst, src);
  ScrStr *copied = (ScrStr *)scr_arr_get_ref(dst, 0);
  check(copied->rc == 3, "unshift spread retained ref element");
  scr_str_release(copied);
  scr_arr_release(src);
  ScrStr *still = (ScrStr *)scr_arr_get_ref(dst, 0);
  check(strcmp(still->data, "front") == 0,
        "unshift spread ref survives source release");
  scr_str_release(still);
  scr_arr_release(dst);

#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings0, "unshift/reverse: no strings leaked");
  check(scr_arr_live_count() == arrays0, "unshift/reverse: no arrays leaked");
#endif
}

static void test_str_rc(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
  long arrays0 = scr_arr_live_count();
#endif
  ScrArr *a = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(a, scr_str_new("one", 3)); /* ownership moves in */
  scr_arr_push_ref(a, scr_str_new("two", 3));

  /* get_ref returns +1: the array and the caller each own a reference. */
  ScrStr *s = (ScrStr *)scr_arr_get_ref(a, 0);
  check(s->rc == 2, "get_ref retained");
  check(strcmp(s->data, "one") == 0, "get_ref content");
  scr_str_release(s);

  /* set_ref releases the replaced element and owns the new one. */
  scr_arr_set_ref(a, 0, scr_str_new("uno", 3));
  ScrStr *r = (ScrStr *)scr_arr_get_ref(a, 0);
  check(strcmp(r->data, "uno") == 0, "set_ref replaced content");
  scr_str_release(r);

  /* pop_ref transfers ownership out: rc unchanged, array no longer owns. */
  ScrStr *popped = (ScrStr *)scr_arr_pop_ref(a);
  check(popped->rc == 1, "pop_ref transfers ownership");
  check(strcmp(popped->data, "two") == 0, "pop_ref content");
  scr_str_release(popped);

  /* immortal literals in arrays: retain/release must stay no-ops */
  static struct { size_t rc; size_t len; size_t cap; char data[4]; } lit = {SIZE_MAX, 3, 3, "lit"};
  scr_arr_push_ref(a, (ScrStr *)&lit);
  ScrStr *l = (ScrStr *)scr_arr_get_ref(a, 1);
  check(l->rc == SIZE_MAX, "immortal element stays immortal");

  scr_arr_release(a); /* must release "uno" (and skip the literal) */
#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings0, "no strings leaked");
  check(scr_arr_live_count() == arrays0, "no arrays leaked");
#endif
}

static void test_nested_rc(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
  long arrays0 = scr_arr_live_count();
#endif
  /* [[ "a" ], [ "b", "c" ]] — releasing the outer array must cascade. */
  ScrArr *outer = scr_arr_new(SCR_ELEM_ARR, 0);
  ScrArr *row0 = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(row0, scr_str_new("a", 1));
  scr_arr_push_ref(outer, row0);
  ScrArr *row1 = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(row1, scr_str_new("b", 1));
  scr_arr_push_ref(row1, scr_str_new("c", 1));
  scr_arr_push_ref(outer, row1);

  ScrArr *row = (ScrArr *)scr_arr_get_ref(outer, 1);
  check(row->rc == 2, "nested get_ref retained");
  check_f64(scr_arr_len(row), 2, "inner length");
  scr_arr_release(row);

  scr_arr_release(outer);
#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings0, "nested: no strings leaked");
  check(scr_arr_live_count() == arrays0, "nested: no arrays leaked");
#endif
}

static void test_index_of_includes(void) {
  /* f64: indexOf is strict equality (NaN never matches, -0 == 0);
   * includes is SameValueZero (NaN matches NaN). */
  ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(a, 1);
  scr_arr_push_f64(a, 0.0 / 0.0);
  scr_arr_push_f64(a, -0.0);
  check_f64(scr_arr_index_of_f64(a, 1), 0, "indexOf f64 hit");
  check_f64(scr_arr_index_of_f64(a, 2), -1, "indexOf f64 miss");
  check_f64(scr_arr_index_of_f64(a, 0.0 / 0.0), -1, "indexOf NaN never matches");
  check(scr_arr_includes_f64(a, 0.0 / 0.0), "includes NaN matches NaN");
  check_f64(scr_arr_index_of_f64(a, 0.0), 2, "indexOf 0 matches -0");
  check(scr_arr_includes_f64(a, 0.0), "includes 0 matches -0");
  check(!scr_arr_includes_f64(a, 5), "includes miss");
  scr_arr_release(a);

  /* bool by value. */
  ScrArr *b = scr_arr_new(SCR_ELEM_BOOL, 0);
  scr_arr_push_bool(b, false);
  scr_arr_push_bool(b, true);
  check_f64(scr_arr_index_of_bool(b, true), 1, "indexOf bool");
  check(scr_arr_includes_bool(b, false), "includes bool");
  scr_arr_release(b);

  /* strings by CONTENT; needle borrowed (rc unchanged, released by us). */
  ScrArr *s = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(s, scr_str_new("aa", 2));
  scr_arr_push_ref(s, scr_str_new("bb", 2));
  ScrStr *needle = scr_str_new("bb", 2);
  check_f64(scr_arr_index_of_ref(s, needle), 1, "indexOf string by content");
  check(scr_arr_includes_ref(s, needle), "includes string by content");
  check(needle->rc == 1, "indexOf/includes borrow the needle");
  scr_str_release(needle);
  scr_arr_release(s);

  /* nested arrays by reference identity. */
  ScrArr *outer = scr_arr_new(SCR_ELEM_ARR, 0);
  ScrArr *inner = scr_arr_new(SCR_ELEM_F64, 0);
  ScrArr *other = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_ref(outer, scr_arr_retain(inner));
  check_f64(scr_arr_index_of_ref(outer, inner), 0, "indexOf array by identity");
  check_f64(scr_arr_index_of_ref(outer, other), -1, "structurally-equal array misses");
  scr_arr_release(inner);
  scr_arr_release(other);
  scr_arr_release(outer);
}

/* ── SCR_ELEM_REF: a mock "record" the runtime cannot lay out ─────────
 * Acyclic flavor: 1-word rc header, retain/release via the stored fn ptrs
 * (the compiler's `_v` adapters stand in). Cyclic flavor: allocated with a
 * collector header whose trace visits an owner ARRAY slot — the record can
 * point back at the array holding it, the REF cycle case. */
typedef struct MockRec {
  size_t rc;
  int value;
  ScrArr *owner; /* cyclic flavor only: traced edge back at an array */
} MockRec;

static long mock_live = 0;

static void *mock_retain(void *p) {
  MockRec *r = (MockRec *)p;
  if (r->rc != SIZE_MAX) r->rc++;
  return r;
}

static void mock_release(void *p) {
  MockRec *r = (MockRec *)p;
  if (!r || r->rc == SIZE_MAX) return;
  if (--r->rc == 0) {
    mock_live--;
    free(r);
  }
}

static MockRec *mock_new(int value) {
  MockRec *r = calloc(1, sizeof *r);
  r->rc = 1;
  r->value = value;
  mock_live++;
  return r;
}

static void mock_trace(void *p, ScrTraceVisit visit, void *ctx) {
  MockRec *r = (MockRec *)p;
  if (r->owner) visit(r->owner, ctx);
}

static void mock_gcfree(void *p) {
  /* trace visits owner (headered); nothing else refcounted to release */
  mock_live--;
  scr_cyc_free(p);
}

static void *mock_cyc_retain(void *p) {
  MockRec *r = (MockRec *)p;
  if (r->rc != SIZE_MAX) {
    r->rc++;
    scr_cyc_mark_live(r);
  }
  return r;
}

static void mock_cyc_release(void *p) {
  MockRec *r = (MockRec *)p;
  if (!r || r->rc == SIZE_MAX) return;
  if (--r->rc == 0) {
    scr_cyc_on_dead(r);
    if (r->owner) scr_arr_release(r->owner);
    mock_live--;
    scr_cyc_free(r);
  } else {
    scr_cyc_on_release(r);
  }
}

static MockRec *mock_cyc_new(int value) {
  MockRec *r = scr_cyc_alloc(sizeof *r, &mock_trace, &mock_gcfree);
  r->rc = 1;
  r->value = value;
  mock_live++;
  return r;
}

static void test_ref_elements(void) {
#ifdef SCR_RC_AUDIT
  long arrays0 = scr_arr_live_count();
#endif
  ScrArr *a = scr_arr_new_ref(&mock_retain, &mock_release, NULL, 0);
  scr_arr_push_ref(a, mock_new(1)); /* ownership moves in */
  scr_arr_push_ref(a, mock_new(2));
  check_f64(scr_arr_len(a), 2, "ref push grows");

  /* get_ref retains through the stored fn ptr. */
  MockRec *r = (MockRec *)scr_arr_get_ref(a, 0);
  check(r->rc == 2, "ref get_ref retained via elem_retain");
  check(r->value == 1, "ref get_ref content");
  mock_release(r);

  /* set_ref releases the replaced element through elem_release. */
  scr_arr_set_ref(a, 0, mock_new(10));
  check(mock_live == 2, "ref set_ref released the old element");
  MockRec *rr = (MockRec *)scr_arr_get_ref(a, 0);
  check(rr->value == 10, "ref set_ref replaced content");
  mock_release(rr);

  /* indexOf/includes: POINTER identity, needle borrowed. */
  MockRec *second = (MockRec *)scr_arr_get_ref(a, 1);
  check_f64(scr_arr_index_of_ref(a, second), 1, "ref indexOf by identity");
  check(scr_arr_includes_ref(a, second), "ref includes by identity");
  MockRec *stranger = mock_new(2);
  check_f64(scr_arr_index_of_ref(a, stranger), -1, "ref equal-value stranger misses");
  check(second->rc == 2, "ref indexOf borrows the needle");
  mock_release(stranger);

  /* pop_ref transfers ownership out. */
  MockRec *popped = (MockRec *)scr_arr_pop_ref(a);
  check(popped == second, "ref pop_ref returns the element");
  check(popped->rc == 2, "ref pop_ref transfers (our get_ref + the pop)");
  mock_release(popped);
  mock_release(second);

  scr_arr_release(a); /* releases the remaining element */
  check(mock_live == 0, "ref elements all released");
#ifdef SCR_RC_AUDIT
  check(scr_arr_live_count() == arrays0, "ref: no arrays leaked");
#endif
}

static void test_ref_cycle(void) {
#ifdef SCR_RC_AUDIT
  long arrays0 = scr_arr_live_count();
#endif
  /* arr -> rec -> arr: drop the external references, then collect. */
  ScrArr *arr = scr_arr_new_ref(&mock_cyc_retain, &mock_cyc_release, &mock_trace, 0);
  MockRec *rec = mock_cyc_new(7);
  rec->owner = (ScrArr *)scr_arr_retain(arr); /* rec points back at arr */
  scr_arr_push_ref(arr, rec);                 /* arr owns rec */
  check(mock_live == 1, "cycle: element alive");
  scr_arr_release(arr); /* external edge gone; the cycle keeps both alive */
  scr_collect_cycles();
  check(mock_live == 0, "cycle collected through the array element");
#ifdef SCR_RC_AUDIT
  check(scr_arr_live_count() == arrays0, "cycle: no arrays leaked");
#endif
}

static void test_ref_truncate_cycle(void) {
#ifdef SCR_RC_AUDIT
  long arrays0 = scr_arr_live_count();
#endif
  /* The truncation release runs while the record points back at the array.
   * The array edge must be detached before mock_cyc_release can trigger the
   * cycle collector. */
  ScrArr *arr = scr_arr_new_ref(&mock_cyc_retain, &mock_cyc_release, &mock_trace, 0);
  MockRec *rec = mock_cyc_new(8);
  rec->owner = (ScrArr *)scr_arr_retain(arr);
  scr_arr_push_ref(arr, rec);
  scr_arr_set_len(arr, 0);
  scr_collect_cycles();
  check(mock_live == 0, "truncation detaches cyclic ref before release");
  scr_arr_release(arr);
#ifdef SCR_RC_AUDIT
  check(scr_arr_live_count() == arrays0, "truncation cycle: no arrays leaked");
#endif
}

static void test_ref_trace_storage_boundaries(void) {
  long before = mock_live;
  ScrArr *arr = scr_arr_new_ref(&mock_cyc_retain, &mock_cyc_release, &mock_trace, 4096);
  MockRec *dense = mock_cyc_new(1);
  MockRec *sparse = mock_cyc_new(2);
  MockRec *property = mock_cyc_new(3);
  dense->owner = scr_arr_retain(arr);
  sparse->owner = scr_arr_retain(arr);
  property->owner = scr_arr_retain(arr);
  scr_arr_set_ref(arr, 0, dense);
  scr_arr_set_ref(arr, 3, mock_cyc_retain(dense));
  scr_arr_set_undefined(arr, 2);
  scr_arr_set_ref(arr, 4294967294.0, sparse);
  scr_arr_set_ref(arr, -1, property);
  scr_collect_cycles();
  check(mock_live == before + 3, "trace preserves dense, sparse and property edges");
  check(dense->rc == 2, "trace restores duplicate dense edges exactly");

  scr_arr_set_len(arr, 1);
  scr_collect_cycles();
  check(mock_live == before + 2, "truncation releases sparse and duplicate edges");
  check(dense->rc == 1 && property->rc == 1,
        "short array preserves its element and named property");
  scr_arr_set_len(arr, 0);
  scr_collect_cycles();
  check(mock_live == before + 1, "zero length keeps the named property");
  scr_arr_release(arr);
  scr_collect_cycles();
  check(mock_live == before, "empty reserved storage and property cycle collected");
}

static void test_join(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
#endif
  ScrStr *sep = scr_str_new(",", 1);

  ScrArr *n = scr_arr_new(SCR_ELEM_F64, 0);
  ScrStr *empty = scr_arr_join(n, sep);
  check(empty->len == 0, "join of empty array is \"\"");
  scr_str_release(empty);
  scr_arr_push_f64(n, 1.5);
  scr_arr_push_f64(n, -0.0);
  scr_arr_push_f64(n, 0.0 / 0.0);
  ScrStr *nums = scr_arr_join(n, sep);
  check(strcmp(nums->data, "1.5,0,NaN") == 0, "join f64 (JS formatting, -0 -> \"0\")");
  scr_str_release(nums);
  scr_arr_release(n);

  ScrArr *b = scr_arr_new(SCR_ELEM_BOOL, 0);
  scr_arr_push_bool(b, true);
  scr_arr_push_bool(b, false);
  ScrStr *bools = scr_arr_join(b, sep);
  check(strcmp(bools->data, "true,false") == 0, "join bool");
  scr_str_release(bools);
  scr_arr_release(b);

  ScrArr *s = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(s, scr_str_new("a", 1));
  scr_arr_push_ref(s, scr_str_new("", 0));
  scr_arr_push_ref(s, scr_str_new("c", 1));
  ScrStr *sep0 = scr_str_new("", 0);
  ScrStr *sepless = scr_arr_join(s, sep0); /* join borrows the separator */
  check(strcmp(sepless->data, "ac") == 0, "join with empty separator");
  scr_str_release(sepless);
  scr_str_release(sep0);
  ScrStr *sep2 = scr_str_new("--", 2);
  ScrStr *strs = scr_arr_join(s, sep2);
  check(strcmp(strs->data, "a----c") == 0, "join strings verbatim, empty kept");
  scr_str_release(strs);
  scr_str_release(sep2);
  scr_arr_release(s);

  s = scr_arr_new(SCR_ELEM_STR, 1);
  ScrStr *shared = scr_str_new("x\0y", 3);
  scr_arr_set_ref(s, 0, scr_str_retain(shared));
  scr_arr_set_undefined(s, 1);
  scr_arr_set_ref(s, 8192, scr_str_retain(shared));
  scr_arr_set_ref(s, -1, scr_str_new("ignored", 7));
  sep0 = scr_str_new("", 0);
  strs = scr_arr_join(s, sep0);
  check(strs->len == 6 && memcmp(strs->data, "x\0yx\0y", 6) == 0,
        "join handles sparse values and embedded zero without properties");
  check(shared->rc == 3 && strs->data[strs->len] == '\0',
        "join preserves duplicate input owners and terminates final storage");
  scr_str_release(strs);
  strs = scr_arr_join(s, sep);
  check(strs->len == 8198 && strs->data[3] == ',' && strs->data[8195] == 'x',
        "join sizing includes separators for sparse holes and undefined");
  scr_str_release(strs);
  scr_arr_release(s);
  scr_str_release(shared);
  scr_str_release(sep0);

  n = scr_arr_new(SCR_ELEM_F64, 0);
  for (size_t i = 0; i < 300; i++) scr_arr_push_f64(n, 123.5);
  nums = scr_arr_join(n, sep);
  check(nums->len == 1799 && nums->data[1799] == '\0' &&
        memcmp(nums->data + 1794, "123.5", 5) == 0,
        "numeric join grows final storage without losing its suffix");
  scr_str_release(nums);
  scr_arr_release(n);

  scr_str_release(sep);
#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings0, "join: no strings leaked");
#endif
}

static void test_sparse_holes(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
  long arrays0 = scr_arr_live_count();
#endif
  ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_f64(a, 3, 7);
  check_f64(scr_arr_len(a), 4, "far indexed write grows length");
  check(!scr_arr_has(a, 0) && !scr_arr_has(a, 2), "growth leaves holes absent");
  check(scr_arr_has(a, 3), "far indexed write is present");
  check_f64(scr_arr_get_f64(a, 3), 7, "far indexed value is readable");
  scr_arr_set_undefined(a, 2);
  check(scr_arr_state(a, 2) == SCR_ARR_UNDEFINED && scr_arr_has(a, 2),
        "explicit undefined is present and stateful");
  check_f64(scr_arr_next_present(a, 0), 2,
            "next-present traversal finds explicit undefined");
  check_f64(scr_arr_next_present(a, 3), 3,
            "next-present traversal finds dense values");
  check_f64(scr_arr_next_present(a, 4), 4,
            "next-present traversal stops at length");
  check(scr_arr_delete(a, 2) && scr_arr_state(a, 2) == SCR_ARR_HOLE &&
            scr_arr_len(a) == 4,
        "delete removes a slot without shrinking length");
  ScrStr *hole_sep = scr_str_new(",", 1);
  ScrStr *hole_join = scr_arr_join(a, hole_sep);
  check(strcmp(hole_join->data, ",,,7") == 0,
        "join preserves separators for holes");
  scr_str_release(hole_join);
  scr_str_release(hole_sep);

  ScrArr *slice = scr_arr_slice(a, 0, 4);
  check_f64(scr_arr_len(slice), 4, "slice keeps sparse length");
  check(!scr_arr_has(slice, 0) && scr_arr_has(slice, 3),
        "slice preserves hole presence");
  scr_arr_release(slice);

  ScrArr *materialized = scr_arr_to_reversed(a);
  check(scr_arr_state(materialized, 1) == SCR_ARR_UNDEFINED,
        "toReversed materializes a hole as undefined");
  scr_arr_release(materialized);

  ScrArr *concat = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_concat_copy(concat, a);
  check(scr_arr_state(concat, 0) == SCR_ARR_HOLE,
        "concat copy preserves holes");
  ScrArr *spread = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_spread(spread, a);
  check(scr_arr_state(spread, 0) == SCR_ARR_UNDEFINED,
        "spread materializes holes as undefined");
  scr_arr_release(concat);
  scr_arr_release(spread);

  ScrArr *rev = scr_arr_reverse(a);
  check(rev == a, "sparse reverse keeps identity");
  check(scr_arr_has(a, 0) && !scr_arr_has(a, 3),
        "reverse moves presence with the value");
  scr_arr_release(rev);
  scr_arr_release(a);

  ScrArr *high = scr_arr_new(SCR_ELEM_F64, 0);
  const double high_index = 4000000000.0;
  scr_arr_set_f64(high, high_index, 11);
  check(scr_arr_has(high, high_index), "high sparse index is present");
  check(high->cap <= ((size_t)1 << 20), "high sparse index avoids dense allocation");
  check(high->sparse_len == 1, "high sparse index uses side storage");
  check_f64(scr_arr_next_present(high, 0), high_index,
            "next-present traversal jumps to side storage");
  scr_arr_set_len(high, 0);
  check(high->sparse_len == 0 && scr_arr_len(high) == 0,
        "length shrink removes sparse entries");
  scr_arr_release(high);

  ScrArr *refs = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_set_ref(refs, high_index, scr_str_new("sparse", 6));
  scr_arr_set_len(refs, 0);
  scr_arr_release(refs);

  ScrArr *props = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_f64(props, -1, 21);
  scr_arr_set_f64(props, 0.5, 22);
  scr_arr_set_f64(props, 4294967295.0, 23);
  check_f64(scr_arr_len(props), 0, "ordinary numeric properties do not grow length");
  check(scr_arr_has(props, -1) && scr_arr_has(props, 0.5) &&
            scr_arr_has(props, 4294967295.0),
        "noncanonical numeric properties are present");
  check_f64(scr_arr_get_f64(props, -1), 21, "negative numeric property round-trips");
  check_f64(scr_arr_get_f64(props, 0.5), 22, "fractional numeric property round-trips");
  check_f64(scr_arr_get_f64(props, 4294967295.0), 23,
            "max non-index numeric property round-trips");
  scr_arr_set_undefined(props, -2);
  scr_arr_set_undefined(props, 1.5);
  scr_arr_set_undefined(props, 4294967295.0);
  check(scr_arr_state(props, -2) == SCR_ARR_UNDEFINED &&
            scr_arr_state(props, 1.5) == SCR_ARR_UNDEFINED &&
            scr_arr_state(props, 4294967295.0) == SCR_ARR_UNDEFINED,
        "ordinary undefined properties retain their state");
  check(scr_arr_has(props, -2) && scr_arr_has(props, 1.5) &&
            scr_arr_has(props, 4294967295.0),
        "ordinary undefined properties remain present");
  scr_arr_set_len(props, 0);
  check(scr_arr_has(props, -1), "length truncation leaves ordinary properties");
  scr_arr_release(props);
#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings0, "sparse ref truncation releases values");
  check(scr_arr_live_count() == arrays0, "sparse arrays do not leak");
#endif
}

/* Arrays beyond the 2^20 dense cutoff: contiguous growth and bulk writes stay
 * packed, rewrites of sparse entries happen in place, a populated sparse tail
 * densifies (moving its states and references), and genuinely sparse indices
 * keep side storage. */
static void test_large_storage(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
  long arrays0 = scr_arr_live_count();
#endif
  const size_t cutoff = (size_t)1 << 20;
  const double n = (double)cutoff + 200000;

  ScrArr *pushed = scr_arr_new(SCR_ELEM_F64, 0);
  for (double i = 0; i < n; i++) scr_arr_push_f64(pushed, i);
  check(pushed->sparse_len == 0 && pushed->cap >= (size_t)n,
        "appends past the cutoff stay dense");
  check_f64(scr_arr_get_f64(pushed, n - 1), n - 1, "large append round-trips");
  scr_arr_release(pushed);

  ScrArr *filled = scr_arr_new(SCR_ELEM_BOOL, 0);
  scr_arr_set_len(filled, n);
  scr_arr_release(scr_arr_fill_bool(filled, true, 0, INFINITY));
  check(filled->sparse_len == 0 && filled->cap >= (size_t)n,
        "fill of a large holey array allocates dense storage");
  scr_arr_set_bool(filled, n - 1, false);
  check(!scr_arr_get_bool(filled, n - 1) && scr_arr_get_bool(filled, n - 2),
        "large filled array accepts indexed writes");
  scr_arr_release(filled);

  ScrArr *forward = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_len(forward, n);
  for (double i = 0; i < n; i++) scr_arr_set_f64(forward, i, i * 2);
  check(forward->sparse_len == 0, "forward indexed writes extend dense storage");
  scr_arr_release(forward);

  /* Every 64th index past the cutoff is too sparse for packed slots, even
   * after a full dense prefix, once it starts beyond the append gap. */
  ScrArr *strided = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_len(strided, (double)cutoff);
  scr_arr_release(scr_arr_fill_f64(strided, 0, 0, INFINITY));
  size_t entries = 0;
  for (double i = (double)cutoff + 4095; i < n; i += 64, entries++) scr_arr_set_f64(strided, i, i);
  check(strided->cap == cutoff && strided->sparse_len == entries,
        "strided indices past the cutoff keep side storage");
  for (int round = 0; round < 3; round++) {
    for (double i = (double)cutoff + 4095; i < n; i += 64) {
      scr_arr_set_f64(strided, i, scr_arr_get_f64(strided, i) + 1);
    }
  }
  check(strided->sparse_len == entries &&
            scr_arr_get_f64(strided, (double)cutoff + 4159) == (double)cutoff + 4162,
        "rewriting sparse entries updates them in place");
  check(!scr_arr_has(strided, (double)cutoff + 1) && scr_arr_len(strided) > (double)cutoff + 4095,
        "side storage keeps holes absent");
  scr_arr_set_f64(strided, (double)cutoff + 1000, 1);
  check(strided->cap > cutoff + 1000 && scr_arr_has(strided, (double)cutoff + 1000) &&
            !scr_arr_has(strided, (double)cutoff + 999),
        "a write within the gap past a full prefix extends dense storage");
  scr_arr_release(strided);

  /* Writing backwards from the end leaves a populated sorted tail that
   * densifies; holes, undefined and references move with it. */
  ScrArr *backward = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_set_len(backward, n);
  scr_arr_set_undefined(backward, n - 1);
  for (double i = n - 2; i >= (double)cutoff; i -= 2) {
    scr_arr_set_ref(backward, i, scr_str_new("v", 1));
  }
  check(backward->sparse_len == 0 && backward->cap >= (size_t)n,
        "a populated sparse tail densifies");
  check(scr_arr_state(backward, n - 1) == SCR_ARR_UNDEFINED &&
            scr_arr_state(backward, n - 3) == SCR_ARR_HOLE &&
            scr_arr_state(backward, n - 2) == SCR_ARR_VALUE &&
            scr_arr_state(backward, (double)cutoff) == SCR_ARR_VALUE,
        "densifying preserves values, holes and undefined");
  scr_arr_release(backward);

  /* The side store is a deque: descending and ascending first touches,
   * deletes near both ends, and detached storage keep sorted order. */
  ScrArr *deque = scr_arr_new(SCR_ELEM_STR, 0);
  const double middle = 3000000000.0;
  for (double k = 0; k < 3000; k++) {
    scr_arr_set_ref(deque, middle - k * 1000, scr_str_new("d", 1));
    scr_arr_set_ref(deque, middle + 1 + k * 1000, scr_str_new("a", 1));
  }
  check(deque->sparse_len == 6000 && deque->cap == 0, "spread first touches stay sparse");
  for (double k = 0; k < 3000; k += 3) {
    scr_arr_delete(deque, middle - k * 1000);
    scr_arr_delete(deque, middle + 1 + k * 1000);
  }
  size_t visited = 0;
  bool ordered = true;
  double previous = -1;
  for (double i = scr_arr_next_present(deque, 0); i < scr_arr_len(deque);
       i = scr_arr_next_present(deque, i + 1)) {
    ordered = ordered && i > previous;
    previous = i;
    visited++;
  }
  check(visited == 4000 && ordered, "deque traversal stays sorted after deletes");
  check(!scr_arr_has(deque, middle) && scr_arr_has(deque, middle - 1000) &&
            scr_arr_has(deque, middle + 1001) && !scr_arr_has(deque, middle + 1),
        "deque deletes remove exactly their entries");
  scr_arr_unshift_ref(deque, scr_str_new("u", 1));
  check(scr_arr_has(deque, middle - 999) && scr_arr_has(deque, 0),
        "unshift rebuilds deque storage");
  scr_arr_release(scr_arr_reverse(deque));
  scr_arr_release(deque);

  ScrArr *high = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_f64(high, 0, 1);
  scr_arr_set_f64(high, 4294967294.0, 2);
  ScrArr *holes = scr_arr_slice(high, 1, INFINITY);
  check(holes->cap <= cutoff && scr_arr_len(holes) == 4294967294.0,
        "slicing a huge hole run keeps a bounded allocation");
  check(holes->sparse_len == 1 && scr_arr_get_f64(holes, 4294967293.0) == 2,
        "a sliced hole run keeps its sparse value");
  scr_arr_release(holes);
  scr_arr_release(high);
#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings0, "large-array references are released");
  check(scr_arr_live_count() == arrays0, "large arrays do not leak");
#endif
}

static void test_borrowed_ref_read(void) {
  ScrArr *a = scr_arr_new(SCR_ELEM_STR, 0);
  ScrStr *value = scr_str_new("borrowed", 8);
  double keys[] = {0, -0.0, 0.5, -1, NAN, INFINITY, -INFINITY, 4294967294.0, 4294967295.0};
  for (size_t i = 0; i < sizeof keys / sizeof *keys; i++) {
    scr_arr_set_ref(a, keys[i], scr_str_retain(value));
    size_t before = value->rc;
    check(scr_arr_peek_ref(a, keys[i]) == value, "borrowed ref lookup preserves identity");
    check(value->rc == before, "borrowed ref lookup does not retain");
    scr_arr_set_undefined(a, keys[i]);
    check(scr_arr_peek_ref(a, keys[i]) == NULL, "borrowed ref lookup of undefined");
    scr_arr_delete(a, keys[i]);
    check(scr_arr_peek_ref(a, keys[i]) == NULL, "borrowed ref lookup of deleted slot");
  }
  check(scr_arr_peek_ref(a, 3) == NULL, "borrowed ref lookup of hole");
  scr_arr_set_len(a, 0);
  check(scr_arr_peek_ref(a, 0) == NULL, "borrowed ref lookup after truncation");
  check(value->rc == 1, "borrowed reads leave only the original owner");
  scr_str_release(value);
  scr_arr_release(a);
}

static void test_bulk_reference_ownership(void) {
  long strings0 = scr_str_live_count(), arrays0 = scr_arr_live_count();
  ScrArr *a = scr_arr_new(SCR_ELEM_STR, 0);
  uint64_t slots[3];
  for (size_t i = 0; i < 3; i++) {
    char text[] = {(char)('a' + i)};
    slots[i] = (uint64_t)(uintptr_t)scr_str_from_utf8_lossy((const uint8_t *)text, 1);
  }
  check_f64(scr_arr_push_many(a, 3, slots), 3, "batch append takes all owned slots");
  for (size_t i = 0; i < 3; i++) slots[i] = (uint64_t)(uintptr_t)scr_arr_get_ref(a, i);
  check_f64(scr_arr_unshift_many(a, 3, slots), 6, "batch prepend preserves retained aliases");
  ScrArr *removed = scr_arr_splice_insert(a, 1, 2, a);
  check_f64(scr_arr_len(a), 10, "self insertion snapshots the source before mutation");
  check_f64(scr_arr_len(removed), 2, "self insertion transfers removed ownership");
  scr_arr_release(removed);
  ScrStr *value = scr_arr_get_ref(a, 0);
  ScrArr *same = scr_arr_fill_ref(a, value, 1, INFINITY);
  check(same == a, "reference fill returns a retained receiver");
  scr_arr_release(same);
  scr_str_release(value);
  scr_arr_release(scr_arr_copy_within(a, 1, 0, INFINITY));
  scr_arr_release(scr_arr_copy_within(a, 0, 1, INFINITY));
  check(scr_str_live_count() == strings0 + 1, "overlapping copy retains exactly the remaining value");
  scr_arr_release(scr_arr_fill_undefined(a, -4, INFINITY));
  check(scr_arr_state(a, 6) == SCR_ARR_UNDEFINED, "reference fill publishes explicit undefined");
  scr_arr_release(a);
  check(scr_str_live_count() == strings0, "bulk reference operations release every element");
  check(scr_arr_live_count() == arrays0, "bulk reference operations release every array");
}

typedef struct {
  ScrStr *value;
  size_t position;
} SortExpected;

static int compare_expected(const void *left, const void *right) {
  const SortExpected *a = left, *b = right;
  int order = scr_str_cmp_u16(a->value, b->value);
  return order ? order : (a->position > b->position) - (a->position < b->position);
}

static void test_primitive_sort(void) {
  long strings0 = scr_str_live_count(), arrays0 = scr_arr_live_count();
  /* More than 64 short runs exercises run-vector growth and odd merges.
   * Distinct allocations with equal contents make stability observable. */
  enum { count = 2051 };
  SortExpected expected[count];
  ScrArr *words = scr_arr_new(SCR_ELEM_STR, 0);
  for (size_t i = 0; i < count; i++) {
    char text[32];
    snprintf(text, sizeof(text), "word-%03zu", (i * 71) % 97);
    ScrStr *word = scr_str_new(text, strlen(text));
    expected[i] = (SortExpected){word, i};
    scr_arr_push_ref(words, word);
  }
  qsort(expected, count, sizeof(*expected), compare_expected);
  ScrArr *copy = scr_arr_sort_primitive(words, true);
  check(copy != words, "default toSorted creates a fresh array");
  ScrArr *same = scr_arr_sort_primitive(words, false);
  check(same == words, "default sort retains receiver identity");
  scr_arr_release(same);
  for (size_t i = 0; i < count; i++) {
    check(scr_arr_peek_ref(words, i) == expected[i].value,
          "stable default order preserves string identity");
    check(scr_arr_peek_ref(copy, i) == expected[i].value,
          "copy has the same stable string order");
  }
  scr_arr_release(words);
  check(scr_str_live_count() == strings0 + count, "copy owns every string after source release");
  scr_arr_release(copy);

  ScrArr *sparse = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_f64(sparse, 4294967294.0, -0.0);
  scr_arr_set_f64(sparse, 10, 0.0);
  scr_arr_set_f64(sparse, 3, 2);
  scr_arr_set_f64(sparse, 1, 10);
  scr_arr_set_undefined(sparse, 1048576);
  scr_arr_set_f64(sparse, -1, 77);
  scr_arr_release(scr_arr_sort_primitive(sparse, false));
  check_f64(scr_arr_len(sparse), 4294967295.0, "sort preserves sparse maximum length");
  check(!signbit(scr_arr_get_f64(sparse, 0)) && signbit(scr_arr_get_f64(sparse, 1)),
        "equal numeric spellings retain original index order");
  check_f64(scr_arr_get_f64(sparse, 2), 10, "default numbers compare string spellings");
  check_f64(scr_arr_get_f64(sparse, 3), 2, "default numeric order is lexical");
  check(scr_arr_state(sparse, 4) == SCR_ARR_UNDEFINED &&
        scr_arr_state(sparse, 5) == SCR_ARR_HOLE &&
        !scr_arr_has(sparse, 4294967294.0), "undefined precedes sparse holes");
  check_f64(scr_arr_get_f64(sparse, -1), 77, "sort keeps ordinary numeric properties");
  scr_arr_release(sparse);

  ScrArr *holes = scr_arr_new(SCR_ELEM_BOOL, 0);
  scr_arr_set_bool(holes, 4, true);
  scr_arr_set_bool(holes, 1, false);
  scr_arr_set_undefined(holes, 3);
  copy = scr_arr_sort_primitive(holes, true);
  check(!scr_arr_get_bool(copy, 0) && scr_arr_get_bool(copy, 1), "default boolean order");
  for (size_t i = 2; i < 5; i++)
    check(scr_arr_state(copy, i) == SCR_ARR_UNDEFINED, "toSorted materializes holes");
  check(!scr_arr_has(holes, 0), "toSorted leaves source holes intact");
  scr_arr_release(copy);
  scr_arr_release(holes);
  ScrArr *empty = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_release(scr_arr_sort_primitive(empty, false));
  scr_arr_release(scr_arr_sort_primitive(empty, true));
  scr_arr_release(empty);
  check(scr_str_live_count() == strings0, "primitive sorting releases all strings");
  check(scr_arr_live_count() == arrays0, "primitive sorting releases all arrays");
}

int main(int argc, char **argv) {
  if (argc > 1) {
    ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
    scr_arr_push_f64(a, 1);
    if (strcmp(argv[1], "--crash-get-oob") == 0) {
      scr_arr_get_f64(a, 1); /* len is 1 */
    } else if (strcmp(argv[1], "--crash-get-frac") == 0) {
      scr_arr_get_f64(a, 0.5);
    } else if (strcmp(argv[1], "--crash-hole-read") == 0) {
      scr_arr_set_f64(a, 2, 9);
      scr_arr_get_f64(a, 1); /* present-length read of a hole */
    } else if (strcmp(argv[1], "--crash-pop-empty") == 0) {
      scr_arr_pop_f64(a);
      scr_arr_pop_f64(a); /* now empty */
    } else {
      fprintf(stderr, "unknown mode %s\n", argv[1]);
      return 2;
    }
    fprintf(stderr, "expected a trap, still alive\n");
    return 2;
  }

  test_primitive_sort();
  test_f64_basics();
  test_numeric_read();
  test_borrowed_ref_read();
  test_bool();
  test_dense_replacement();
  test_unshift_reverse();
  test_str_rc();
  test_nested_rc();
  test_index_of_includes();
  test_ref_elements();
  test_ref_cycle();
  test_ref_truncate_cycle();
  test_ref_trace_storage_boundaries();
  test_join();
  test_sparse_holes();
  test_large_storage();
  test_bulk_reference_ownership();

  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed == 0 ? 0 : 1;
}
