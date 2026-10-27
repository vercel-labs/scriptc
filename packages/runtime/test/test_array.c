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

/* Sparse entries live in the array's out-of-line storage. */
static size_t arr_sparse_len(const ScrArr *a) { return scr_arr_ext_of(a) ? scr_arr_ext_of(a)->sparse_len : 0; }

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
  static ScrCycType cyc_type = { &mock_trace, &mock_gcfree, 0 };
  MockRec *r = scr_cyc_alloc(sizeof *r, &cyc_type);
  r->rc = 1;
  r->value = value;
  mock_live++;
  return r;
}

static ScrArrOps mock_ops = { &mock_retain, &mock_release, NULL };
static ScrArrOps mock_cyc_ops = { &mock_cyc_retain, &mock_cyc_release, &mock_trace };
/* First used after test_ops_overflow fills the registry: its arrays keep the ops in their ext. */
static ScrArrOps mock_cyc_ops_late = { &mock_cyc_retain, &mock_cyc_release, &mock_trace };

static void test_ref_elements(void) {
#ifdef SCR_RC_AUDIT
  long arrays0 = scr_arr_live_count();
#endif
  ScrArr *a = scr_arr_new_ops(&mock_ops, 0);
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

/* Elements whose release does nothing (SCR_ARR_OPS_RELEASE_NOTHING): the
 * last release of an array frees its storage without calling the element
 * release. An array with out-of-line storage keeps the full teardown. */
static int nothing_releases = 0;
static void *nothing_retain(void *p) { return p; }
static void nothing_release(void *p) {
  (void)p;
  nothing_releases++;
}
static ScrArrOps nothing_ops = { &nothing_retain, &nothing_release, NULL, 0,
                                 SCR_ARR_OPS_RELEASE_NOTHING };

static void test_release_nothing_ops(void) {
#ifdef SCR_RC_AUDIT
  long arrays0 = scr_arr_live_count();
#endif
  static MockRec kept[3];
  ScrArr *a = scr_arr_new_ops(&nothing_ops, 0);
  for (int i = 0; i < 3; i++) scr_arr_push_ref(a, &kept[i]);
  ScrArr *shared = scr_arr_retain(a);
  scr_arr_release(shared);
  check_f64(scr_arr_len(a), 3, "release-nothing: a shared release keeps the array");
  scr_arr_release(a);
  check(nothing_releases == 0, "release-nothing: teardown calls no element release");
  ScrArr *sparse = scr_arr_new_ops(&nothing_ops, 0);
  scr_arr_push_ref(sparse, &kept[0]);
  scr_arr_set_ref(sparse, 4000000000.0, &kept[1]); /* out-of-line sparse slot */
  check(scr_arr_ext_of(sparse) != NULL, "release-nothing: a far index makes an ext");
  scr_arr_release(sparse);
  check(nothing_releases == 2, "release-nothing: an array with an ext keeps the full teardown");
  ScrArr *nums = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(nums, 1);
  scr_arr_release(nums);
#ifdef SCR_RC_AUDIT
  check(scr_arr_live_count() == arrays0, "release-nothing: no arrays leaked");
#endif
}

/* Element ops past the registry's capacity: every descriptor still finds its
 * own retain and release, and the first ones keep their registry ids. */
static void test_ops_overflow(void) {
  enum { N = SCR_ARR_OPS_OVERFLOW + 8 };
  static ScrArrOps many[N];
  static ScrArr *arrays[N];
  for (int i = 0; i < N; i++) many[i] = (ScrArrOps){ &mock_retain, &mock_release, NULL, 0 };
  for (int i = 0; i < N; i++) {
    arrays[i] = scr_arr_new_ops(&many[i], 0);
    scr_arr_push_ref(arrays[i], mock_new(i));
  }
  check(scr_arr_ops(arrays[0]) == &many[0], "a registered descriptor answers by id");
  check(scr_arr_ops(arrays[N - 1]) == &many[N - 1], "an overflow descriptor answers through the array");
  check(many[N - 1].id == SCR_ARR_OPS_OVERFLOW, "descriptors past the table get the overflow id");
  MockRec *r = (MockRec *)scr_arr_get_ref(arrays[N - 1], 0);
  check(r->rc == 2 && r->value == N - 1, "an overflow array retains through its own ops");
  mock_release(r);
  for (int i = 0; i < N; i++) scr_arr_release(arrays[i]);
  check(mock_live == 0, "overflow arrays release their elements");
}

/* An array with out-of-line storage keeps it through every change of its
 * dense allocation: growth, head room, unshift into new room, sorting
 * (which rebuilds the storage) and a sparse tail. */
static void test_ext_through_storage_changes(void) {
  ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_f64(a, -1, 7); /* a noncanonical property: out-of-line storage */
  check(scr_arr_ext_of(a) != NULL, "a numeric property creates out-of-line storage");
  for (int i = 0; i < 100; i++) scr_arr_push_f64(a, 100 - i);
  check_f64(scr_arr_get_f64(a, -1), 7, "the property survives growth");
  for (int i = 0; i < 40; i++) scr_arr_shift_f64(a);
  check_f64(scr_arr_get_f64(a, -1), 7, "the property survives head room");
  for (int i = 0; i < 60; i++) scr_arr_unshift_f64(a, 1000 + i);
  check_f64(scr_arr_len(a), 120, "unshift after shifts keeps the length");
  check_f64(scr_arr_get_f64(a, -1), 7, "the property survives new head room");
  ScrArr *same = scr_arr_sort_primitive(a, false);
  check(same == a, "an in-place sort returns the array");
  check_f64(scr_arr_get_f64(a, 0), 1, "sorting reorders the values");
  check_f64(scr_arr_get_f64(a, -1), 7, "the property survives a sort");
  scr_arr_set_f64(a, 5000000, 9); /* a sparse tail entry */
  check(arr_sparse_len(a) == 1 && scr_arr_get_f64(a, 5000000) == 9, "a sparse entry joins the out-of-line storage");
  scr_arr_release(same); /* the sort's result reference */
  scr_arr_release(a);

  ScrArr *empty = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_f64(empty, 0.5, 3);
  check_f64(scr_arr_get_f64(empty, 0.5), 3, "an array without elements keeps a property");
  scr_arr_push_f64(empty, 1);
  check_f64(scr_arr_get_f64(empty, 0.5), 3, "the property survives the first element");
  scr_arr_release(empty);
}

static void test_ref_cycle(void) {
#ifdef SCR_RC_AUDIT
  long arrays0 = scr_arr_live_count();
#endif
  /* arr -> rec -> arr: drop the external references, then collect. */
  ScrArr *arr = scr_arr_new_ops(&mock_cyc_ops, 0);
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

static void test_ref_known_count_cycle(ScrArrOps *ops) {
#ifdef SCR_RC_AUDIT
  long arrays0 = scr_arr_live_count();
#endif
  /* A known-count construction of cycle-capable elements keeps its slots
   * after the collector header: the collector traces them, and both the
   * collected array and one released by its count free the one block. */
  ScrArr *arr = scr_arr_new_ops(ops, 2);
  bool in_block = arr->data == (uint64_t *)((char *)arr + ((sizeof(ScrArr) + 7) & ~(size_t)7));
  /* Ops past the registry (once test_ops_overflow has filled it) live in
   * the ext, which moves the slots to their own allocation. */
  bool overflow = (arr->spare >> SCR_ARR_OPS_SHIFT) == SCR_ARR_OPS_OVERFLOW;
  check(arr->cap >= 2 && in_block == !overflow && scr_arr_ops(arr) == ops,
        "known-count cycle-capable construction is inline unless its ops need the ext");
  MockRec *first = mock_cyc_new(1);
  first->owner = (ScrArr *)scr_arr_retain(arr);
  scr_arr_push_ref(arr, first);
  scr_arr_push_ref(arr, mock_cyc_new(2));
  scr_arr_release(arr);
  scr_collect_cycles();
  check(mock_live == 0, "cycle through an inline array collected");
  ScrArr *plain = scr_arr_new_ops(ops, 3);
  for (int i = 0; i < 4; i++) scr_arr_push_ref(plain, mock_cyc_new(i));
  check(scr_arr_len(plain) == 4, "a cycle-capable inline array grows out of its block");
  scr_arr_release(plain);
  scr_collect_cycles();
  check(mock_live == 0, "released inline cycle-capable array frees its elements");
#ifdef SCR_RC_AUDIT
  check(scr_arr_live_count() == arrays0, "known-count cycle: no arrays leaked");
#endif
}

static void test_ref_truncate_cycle(void) {
#ifdef SCR_RC_AUDIT
  long arrays0 = scr_arr_live_count();
#endif
  /* The truncation release runs while the record points back at the array.
   * The array edge must be detached before mock_cyc_release can trigger the
   * cycle collector. */
  ScrArr *arr = scr_arr_new_ops(&mock_cyc_ops, 0);
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
  ScrArr *arr = scr_arr_new_ops(&mock_cyc_ops, 4096);
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
  check(arr_sparse_len(high) == 1, "high sparse index uses side storage");
  check_f64(scr_arr_next_present(high, 0), high_index,
            "next-present traversal jumps to side storage");
  scr_arr_set_len(high, 0);
  check(arr_sparse_len(high) == 0 && scr_arr_len(high) == 0,
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
  check(arr_sparse_len(pushed) == 0 && pushed->cap >= (size_t)n,
        "appends past the cutoff stay dense");
  check_f64(scr_arr_get_f64(pushed, n - 1), n - 1, "large append round-trips");
  scr_arr_release(pushed);

  ScrArr *filled = scr_arr_new(SCR_ELEM_BOOL, 0);
  scr_arr_set_len(filled, n);
  scr_arr_release(scr_arr_fill_bool(filled, true, 0, INFINITY));
  check(arr_sparse_len(filled) == 0 && filled->cap >= (size_t)n,
        "fill of a large holey array allocates dense storage");
  scr_arr_set_bool(filled, n - 1, false);
  check(!scr_arr_get_bool(filled, n - 1) && scr_arr_get_bool(filled, n - 2),
        "large filled array accepts indexed writes");
  scr_arr_release(filled);

  ScrArr *forward = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_len(forward, n);
  for (double i = 0; i < n; i++) scr_arr_set_f64(forward, i, i * 2);
  check(arr_sparse_len(forward) == 0, "forward indexed writes extend dense storage");
  scr_arr_release(forward);

  /* Every 64th index past the cutoff is too sparse for packed slots, even
   * after a full dense prefix, once it starts beyond the append gap. */
  ScrArr *strided = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_len(strided, (double)cutoff);
  scr_arr_release(scr_arr_fill_f64(strided, 0, 0, INFINITY));
  size_t entries = 0;
  for (double i = (double)cutoff + 4095; i < n; i += 64, entries++) scr_arr_set_f64(strided, i, i);
  check(strided->cap == cutoff && arr_sparse_len(strided) == entries,
        "strided indices past the cutoff keep side storage");
  for (int round = 0; round < 3; round++) {
    for (double i = (double)cutoff + 4095; i < n; i += 64) {
      scr_arr_set_f64(strided, i, scr_arr_get_f64(strided, i) + 1);
    }
  }
  check(arr_sparse_len(strided) == entries &&
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
  check(arr_sparse_len(backward) == 0 && backward->cap >= (size_t)n,
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
  check(arr_sparse_len(deque) == 6000 && deque->cap == 0, "spread first touches stay sparse");
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
  check(arr_sparse_len(holes) == 1 && scr_arr_get_f64(holes, 4294967293.0) == 2,
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

/* Statement-position splices release removed values and keep inserted
 * ownership, on the dense path and the sparse fallback alike. */
static void test_splice_drop(void) {
  long strings0 = scr_str_live_count(), arrays0 = scr_arr_live_count();
  ScrArr *a = scr_arr_new(SCR_ELEM_STR, 0);
  uint64_t slots[12];
  for (size_t i = 0; i < 12; i++) {
    char text[] = {(char)('a' + i)};
    slots[i] = (uint64_t)(uintptr_t)scr_str_from_utf8_lossy((const uint8_t *)text, 1);
  }
  scr_arr_push_many(a, 10, slots);
  scr_arr_set_undefined(a, 10);
  scr_arr_set_len(a, 13); /* holes at 11 and 12 */
  scr_arr_splice_drop(a, 1, 9, 1, slots + 10); /* removes b..j (> 8 values) */
  check_f64(scr_arr_len(a), 5, "drop splice removes and inserts in place");
  check(scr_arr_state(a, 2) == SCR_ARR_UNDEFINED, "drop splice shifts explicit undefined");
  check(scr_arr_state(a, 3) == SCR_ARR_HOLE, "drop splice shifts holes");
  check(scr_str_live_count() == strings0 + 3, "drop splice releases every removed value");
  scr_arr_splice_drop(a, -2, INFINITY, 0, NULL);
  check_f64(scr_arr_len(a), 3, "drop splice clamps relative starts and counts");
  scr_arr_splice_drop(a, NAN, -1, 1, slots + 11);
  check_f64(scr_arr_len(a), 4, "drop splice treats NaN and negative counts as zero");
  ScrStr *first = scr_arr_get_ref(a, 0);
  check(first == (ScrStr *)(uintptr_t)slots[11], "drop splice inserts at the clamped start");
  scr_str_release(first);
  ScrArr *s = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_set_ref(s, 2000000, scr_str_retain((ScrStr *)(uintptr_t)slots[0]));
  uint64_t one = (uint64_t)(uintptr_t)scr_str_retain((ScrStr *)(uintptr_t)slots[0]);
  scr_arr_splice_drop(s, 0, 1, 1, &one);
  check_f64(scr_arr_len(s), 2000001, "sparse drop splice keeps sparse semantics");
  scr_arr_release(s);
  scr_arr_release(a);
  check(scr_str_live_count() == strings0, "drop splices balance string ownership");
  check(scr_arr_live_count() == arrays0, "drop splices free their temporary arrays");
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

/* scr_arr_sort_values: closures built by hand with the callValue ABI. */
static long sort_calls = 0, sort_throw_at = -1;

static double sort_by_floor(ScrClosure *self, double a, double b) {
  (void)self;
  sort_calls++;
  return floor(a) - floor(b);
}

static double sort_by_length(ScrClosure *self, void *a, void *b) {
  (void)self;
  double d = (double)((ScrStr *)a)->len - (double)((ScrStr *)b)->len;
  scr_str_release((ScrStr *)a); /* the callee owns its parameters */
  scr_str_release((ScrStr *)b);
  if (++sort_calls == sort_throw_at) scr_throw_f64(42);
  return d;
}

static double sort_one_arg(ScrClosure *self, double a) {
  (void)self;
  sort_calls++;
  return a > 1 ? 1 : 0;
}

static double sort_nan(ScrClosure *self) {
  (void)self;
  sort_calls++;
  return NAN;
}

static void test_comparator_sort(void) {
  ScrClosure floor_fn = {SIZE_MAX, (void *)sort_by_floor, 0, NULL, 0};
  ScrArr *nums = scr_arr_new(SCR_ELEM_F64, 0);
  const double input[] = {3.1, 1.1, 2.1, 1.2, 9.1, 3.2, 0.1, 1.3, 2.2, 8.1, 7.1, 6.1,
                          5.1, 4.1, 3.3, 2.3, 1.4, 0.2, 9.2, 8.2, 7.2, 6.2, 5.2, 4.2};
  const size_t n = sizeof(input) / sizeof(*input);
  for (size_t i = 0; i < n; i++) scr_arr_push_f64(nums, input[i]);
  scr_arr_push_f64(nums, -1); /* beyond the sorted count */
  scr_arr_sort_values(nums, (double)n, &floor_fn, 2, 0, NULL);
  bool ordered = true;
  for (size_t i = 1; i < n; i++) {
    double a = scr_arr_get_f64(nums, (double)(i - 1)), b = scr_arr_get_f64(nums, (double)i);
    if (floor(a) > floor(b) || (floor(a) == floor(b) && a > b)) ordered = false;
  }
  check(ordered, "comparator sort orders keys and keeps equal keys stable");
  check_f64(scr_arr_get_f64(nums, (double)n), -1, "comparator sort leaves slots past the count");

  ScrClosure one_fn = {SIZE_MAX, (void *)sort_one_arg, 0, NULL, 0};
  ScrClosure nan_fn = {SIZE_MAX, (void *)sort_nan, 0, NULL, 0};
  ScrArr *few = scr_arr_new(SCR_ELEM_F64, 0);
  for (int i = 0; i < 5; i++) scr_arr_push_f64(few, 5 - i);
  sort_calls = 0;
  scr_arr_sort_values(few, 5, &nan_fn, 0, 0, NULL);
  check(sort_calls > 0 && scr_arr_get_f64(few, 0) == 5 && scr_arr_get_f64(few, 4) == 1,
        "a NaN comparator result keeps the input order");
  scr_arr_sort_values(few, 5, &one_fn, 1, 0, NULL);
  check_f64(scr_arr_len(few), 5, "a one-parameter comparator sort keeps every element");
  sort_calls = 0;
  scr_arr_sort_values(few, 1, &nan_fn, 0, 0, NULL);
  check(sort_calls == 0, "a single value needs no comparator call");
  scr_arr_release(few);
  scr_arr_release(nums);

  long strings0 = scr_str_live_count();
  ScrClosure length_fn = {SIZE_MAX, (void *)sort_by_length, 0, NULL, 0};
  ScrArr *words = scr_arr_new(SCR_ELEM_STR, 0);
  const char *spellings[] = {"ccc", "a", "bb", "dddd", "e", "ff", "ggg", "h",
                             "iiiii", "jj", "k", "llll", "mmm", "n", "oo", "p",
                             "qqq", "r", "ss", "t"};
  const size_t word_count = sizeof(spellings) / sizeof(*spellings);
  ScrStr *originals[sizeof(spellings) / sizeof(*spellings)];
  for (size_t i = 0; i < word_count; i++) {
    originals[i] = scr_str_new(spellings[i], strlen(spellings[i]));
    scr_arr_push_ref(words, scr_str_retain(originals[i]));
  }
  sort_calls = 0;
  sort_throw_at = 7;
  scr_arr_sort_values(words, (double)word_count, &length_fn, 2, 0, NULL);
  check(scr_exc_pending(), "a throwing comparator leaves the exception pending");
  scr_exc_clear();
  check(sort_calls == 7, "the sort stops at the first comparator exception");
  bool unchanged = true;
  for (size_t i = 0; i < word_count; i++)
    if (scr_arr_peek_ref(words, (double)i) != originals[i]) unchanged = false;
  check(unchanged, "a comparator exception leaves the snapshot unchanged");
  sort_throw_at = -1;
  scr_arr_sort_values(words, (double)word_count, &length_fn, 2, 0, NULL);
  check(!scr_exc_pending(), "a successful comparator sort leaves no exception");
  bool stable = true;
  size_t last_index = 0, last_len = 0;
  for (size_t i = 0; i < word_count; i++) {
    ScrStr *s = scr_arr_peek_ref(words, (double)i);
    size_t index = 0;
    while (index < word_count && originals[index] != s) index++;
    size_t len = s->len;
    if (index == word_count || len < last_len || (i && len == last_len && index < last_index))
      stable = false;
    last_len = len;
    last_index = index;
  }
  check(stable, "reference sort is a stable permutation of the original strings");
  for (size_t i = 0; i < word_count; i++) scr_str_release(originals[i]);
  check(scr_str_live_count() == strings0 + (long)word_count,
        "comparator calls balance every retained argument");
  scr_arr_release(words);
  check(scr_str_live_count() == strings0, "comparator sort releases all strings");

  /* Past the dense limit the tail lives in sparse slots. */
  const size_t big = ((size_t)1 << 20) + 300;
  ScrArr *wide = scr_arr_new(SCR_ELEM_F64, 0);
  for (size_t i = 0; i < big; i++) scr_arr_push_f64(wide, (double)(big - i) + 0.5);
  scr_arr_sort_values(wide, (double)big, &floor_fn, 2, 0, NULL);
  bool wide_ordered = true;
  for (size_t i = 0; i < big; i++)
    if (scr_arr_get_f64(wide, (double)i) != (double)(i + 1) + 0.5) wide_ordered = false;
  check(wide_ordered, "comparator sort writes sparse tail slots");
  scr_arr_release(wide);
}

/* scr_arr_sort_dense: in-place comparator sort of dense arrays. */
static ScrArr *dense_target = NULL;
static long dense_edit_at = -1;
static ScrStr *dense_replacement = NULL;

static double dense_by_length(ScrClosure *self, void *a, void *b) {
  (void)self;
  double d = (double)((ScrStr *)a)->len - (double)((ScrStr *)b)->len;
  scr_str_release((ScrStr *)a);
  scr_str_release((ScrStr *)b);
  if (++sort_calls == dense_edit_at) {
    /* Overwrite one element, then truncate: the dropped originals must
     * survive in the sort's own buffer. */
    scr_arr_set_ref(dense_target, 0, scr_str_retain(dense_replacement));
    scr_arr_set_len(dense_target, 0);
  }
  if (sort_calls == sort_throw_at) scr_throw_f64(7);
  return d;
}

static double dense_observe(ScrClosure *self, double a, double b) {
  (void)self;
  /* The receiver keeps its unsorted values while the comparator runs. */
  if (sort_calls++ == 0 && scr_arr_get_f64(dense_target, 0) != 9) sort_throw_at = -2;
  return a - b;
}

static void test_dense_comparator_sort(void) {
  ScrClosure floor_fn = {SIZE_MAX, (void *)sort_by_floor, 0, NULL, 0};
  ScrClosure observe_fn = {SIZE_MAX, (void *)dense_observe, 0, NULL, 0};
  ScrArr *nums = scr_arr_new(SCR_ELEM_F64, 0);
  for (int i = 0; i < 100; i++) scr_arr_push_f64(nums, (double)((i * 37) % 100) + (i % 2) * 0.5);
  scr_arr_push_f64(nums, 9); /* keys stay distinct by floor */
  scr_arr_set_f64(nums, 0, 9);
  dense_target = nums;
  sort_calls = 0;
  sort_throw_at = -1;
  check(scr_arr_sort_dense(nums, &observe_fn, 2, false, 0, NULL), "a dense number array sorts in place");
  check(sort_throw_at == -1, "the comparator sees the unsorted receiver");
  bool ordered = true;
  for (size_t i = 1; i < 101; i++)
    if (scr_arr_get_f64(nums, (double)(i - 1)) > scr_arr_get_f64(nums, (double)i)) ordered = false;
  check(ordered && scr_arr_len(nums) == 101, "dense number sort orders every value");

  ScrArr *holes = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(holes, 3);
  scr_arr_set_f64(holes, 2, 1);
  sort_calls = 0;
  check(!scr_arr_sort_dense(holes, &floor_fn, 2, false, 0, NULL) && sort_calls == 0,
        "an array with holes takes the snapshot path without comparator calls");
  ScrArr *undef = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(undef, 3);
  scr_arr_set_undefined(undef, 1);
  scr_arr_push_f64(undef, 1);
  check(!scr_arr_sort_dense(undef, &floor_fn, 2, true, 0, NULL) && sort_calls == 0,
        "storage-level undefined takes the snapshot path");
  ScrArr *one = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(one, 5);
  check(scr_arr_sort_dense(one, &floor_fn, 2, false, 0, NULL) && sort_calls == 0,
        "a single value needs no comparator call");
  size_t rc = one->rc;
  one->rc = SIZE_MAX; /* as publication marks it */
  check(!scr_arr_sort_dense(one, &floor_fn, 2, false, 0, NULL), "a published array takes the general path");
  one->rc = rc;
  scr_arr_release(one);
  scr_arr_release(undef);
  scr_arr_release(holes);
  scr_arr_release(nums);

  long strings0 = scr_str_live_count();
  ScrClosure length_fn = {SIZE_MAX, (void *)dense_by_length, 0, NULL, 0};
  const char *spellings[] = {"ccc", "a", "bb", "dddd", "e", "ff", "ggg", "h", "iiiii", "jj",
                             "k", "llll", "mmm", "n", "oo", "p", "qqq", "r", "ss", "t"};
  const size_t count = sizeof(spellings) / sizeof(*spellings);
  for (int owned = 0; owned < 2; owned++) {
    for (long at = 1; at <= 40; at += 39) {
      ScrArr *words = scr_arr_new(SCR_ELEM_STR, 0);
      for (size_t i = 0; i < count; i++)
        scr_arr_push_ref(words, scr_str_new(spellings[i], strlen(spellings[i])));
      ScrStr *first = scr_arr_peek_ref(words, 0);
      sort_calls = 0;
      sort_throw_at = at;
      dense_edit_at = -1;
      check(scr_arr_sort_dense(words, &length_fn, 2, owned, 0, NULL) && scr_exc_pending(),
            "a throwing comparator leaves the exception pending");
      scr_exc_clear();
      check(sort_calls == at && scr_arr_len(words) == count,
            "the dense sort stops at the first comparator exception");
      if (!owned) {
        check(scr_arr_peek_ref(words, 0) == first, "an exception leaves the receiver unwritten");
      } else {
        /* A private copy is discarded after an exception; it must still
         * own every element exactly once. */
        bool permutation = true;
        for (size_t i = 0; i < count; i++) {
          size_t uses = 0;
          for (size_t j = 0; j < count; j++)
            uses += strcmp(((ScrStr *)scr_arr_peek_ref(words, (double)j))->data, spellings[i]) == 0;
          permutation &= uses == 1;
        }
        check(permutation, "an exception leaves the private copy a permutation");
      }
      scr_arr_release(words);
    }
  }
  check(scr_str_live_count() == strings0, "throwing dense sorts release every string");

  dense_replacement = scr_str_new("zz", 2);
  ScrArr *words = scr_arr_new(SCR_ELEM_STR, 0);
  for (size_t i = 0; i < count; i++)
    scr_arr_push_ref(words, scr_str_new(spellings[i], strlen(spellings[i])));
  dense_target = words;
  sort_calls = 0;
  sort_throw_at = -1;
  dense_edit_at = 3;
  check(scr_arr_sort_dense(words, &length_fn, 2, false, 0, NULL) && !scr_exc_pending(),
        "a comparator that truncates the receiver still completes");
  dense_edit_at = -1;
  bool lengths = scr_arr_len(words) == count;
  for (size_t i = 1; lengths && i < count; i++)
    lengths = ((ScrStr *)scr_arr_peek_ref(words, (double)(i - 1)))->len <=
              ((ScrStr *)scr_arr_peek_ref(words, (double)i))->len;
  check(lengths, "the sorted original values are written back after truncation");
  scr_arr_release(words);
  scr_str_release(dense_replacement);
  check(scr_str_live_count() == strings0, "a mutating comparator leaks no string");
  dense_target = NULL;
}

static void test_exact_construction(void) {
  /* Construction reserves the requested slots (rounded up to the small
   * allocator's block where it is live); appends past them grow
   * geometrically, and every new slot starts as a hole. */
  ScrArr *one = scr_arr_new(SCR_ELEM_F64, 1);
  check(one->cap >= 1 && one->cap < 4 && scr_arr_len(one) == 0 && !scr_arr_has(one, 0),
        "one-slot construction keeps an exactly sized empty dense prefix");
  scr_arr_push_f64(one, 1);
  size_t first_cap = one->cap;
  for (int i = 2; i <= 6; i++) scr_arr_push_f64(one, i);
  check(one->cap >= 6 && one->cap > first_cap && scr_arr_len(one) == 6,
        "appends past an exact construction grow the dense prefix");
  for (int i = 0; i < 6; i++) check(scr_arr_get_number(one, i) == i + 1, "grown values kept");
  scr_arr_set_len(one, (double)one->cap + 3);
  check(!scr_arr_has(one, 6) && !scr_arr_has(one, (double)one->cap - 1),
        "spare capacity after growth from an exact size reads as holes");
  scr_arr_release(one);
#if SCR_SMALL_ALLOC
  /* Requests round to 16 bytes before the size class: two slots (18
   * bytes) get a 32-byte block, so one append needs no reallocation. */
  ScrArr *two = scr_arr_new(SCR_ELEM_F64, 2);
  scr_arr_push_f64(two, 1);
  scr_arr_push_f64(two, 2);
  uint64_t *before = two->data;
  scr_arr_push_f64(two, 3);
  check(two->cap == 3 && two->data == before && scr_arr_get_number(two, 2) == 3,
        "an exact two-slot construction has room for one append");
  scr_arr_release(two);
#endif

  ScrArr *refs = scr_arr_new(SCR_ELEM_STR, 3);
  scr_arr_push_ref(refs, scr_str_new("a", 1));
  scr_arr_set_ref(refs, 4, scr_str_new("e", 1));
  check(scr_arr_len(refs) == 5 && scr_arr_has(refs, 0) && !scr_arr_has(refs, 1) &&
            !scr_arr_has(refs, 3) && scr_arr_has(refs, 4),
        "index write past an exact construction leaves holes between");
  scr_arr_release(refs);
}

/* The hole-free prefix bound never covers a non-value state, and the
 * operations that keep an array hole-free keep the bound at its length. An
 * array without states keeps its elements in dense storage. */
static bool filled_ok(const ScrArr *a) {
  if (a->filled > a->len || a->filled > a->cap) return false;
  if (!scr_arr_has_states(a) && (a->len > a->cap || a->filled != a->len)) return false;
  for (size_t i = 0; i < a->filled; i++)
    if (scr_arr_dense_state(a, i) != SCR_ARR_VALUE) return false;
  return true;
}

static void test_filled_prefix(void) {
  ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
  for (int i = 0; i < 8; i++) scr_arr_push_f64(a, i);
  check(a->filled == 8 && filled_ok(a), "pushes keep the bound at the length");
  scr_arr_set_len(a, 12);
  check(a->filled == 8 && filled_ok(a), "length growth leaves the bound below the holes");
  scr_arr_set_f64(a, 8, 8);
  check(a->filled == 9 && filled_ok(a), "a write at the bound extends it");
  scr_arr_set_f64(a, 11, 11);
  check(a->filled == 9 && filled_ok(a), "a write past a hole does not extend it");
  scr_arr_release(scr_arr_fill_f64(a, 0, 0, INFINITY));
  check(a->filled == 12 && filled_ok(a), "fill over the whole array restores it");
  scr_arr_delete(a, 3);
  check(a->filled == 3 && filled_ok(a), "delete cuts the bound at the hole");
  scr_arr_set_f64(a, 3, 3);
  check(a->filled == 4 && filled_ok(a), "refilling the hole continues the prefix");
  scr_arr_set_undefined(a, 1);
  check(a->filled == 1 && filled_ok(a), "present undefined cuts the bound");
  scr_arr_set_len(a, 0);
  check(a->filled == 0 && filled_ok(a), "truncation cuts the bound");
  scr_arr_release(a);

  ScrArr *b = scr_arr_new(SCR_ELEM_F64, 0);
  for (int i = 0; i < 10; i++) scr_arr_push_f64(b, i);
  check(scr_arr_shift_f64(b) == 0 && b->filled == 9 && filled_ok(b), "shift keeps a full bound");
  scr_arr_unshift_f64(b, -1);
  check(b->filled == 10 && filled_ok(b), "unshift keeps a full bound");
  scr_arr_release(scr_arr_splice(b, 2, 3));
  check(b->filled == 7 && filled_ok(b), "splice removal keeps a full bound");
  double values[2] = {5, 6};
  uint64_t two[2];
  memcpy(two, values, sizeof two);
  scr_arr_splice_drop(b, 1, 0, 2, two);
  check(b->filled == 9 && filled_ok(b), "splice insertion keeps a full bound");
  scr_arr_release(scr_arr_reverse(b));
  check(b->filled == 9 && filled_ok(b), "reverse keeps a full bound");
  scr_arr_release(scr_arr_copy_within(b, 0, 4, 6));
  check(b->filled == 9 && filled_ok(b), "copyWithin inside the prefix keeps it");
  scr_arr_set_len(b, 12);
  scr_arr_release(scr_arr_copy_within(b, 2, 10, 12));
  check(b->filled == 2 && filled_ok(b), "copyWithin of holes cuts the bound");
  ScrArr *s = scr_arr_slice(b, 0, 2);
  check(s->filled == 2 && filled_ok(s), "slice of a hole-free range is hole-free");
  scr_arr_release(s);
  s = scr_arr_slice(b, 0, INFINITY);
  check(s->filled == 2 && filled_ok(s), "slice keeps holes out of the bound");
  scr_arr_release(s);
  /* The rescan after a copy stops exactly at the first non-value state,
   * whichever eight-state step holds it, and a slice that starts past a
   * source's bound still finds the values after it. */
  for (size_t hole = 0; hole < 37; hole++) {
    ScrArr *w = scr_arr_new(SCR_ELEM_F64, 0);
    for (int i = 0; i < 37; i++) scr_arr_push_f64(w, i);
    if (hole % 2) scr_arr_set_undefined(w, (double)hole);
    else scr_arr_delete(w, (double)hole);
    for (size_t from = 0; from < 20; from += 3) {
      ScrArr *c = scr_arr_slice(w, (double)from, INFINITY);
      size_t want = hole >= from ? hole - from : 37 - from;
      check(c->filled == want && filled_ok(c), "slice bound ends at the first non-value");
      scr_arr_release(c);
    }
    ScrArr *c = scr_arr_slice(w, 30, 10);
    check(c->len == 0 && c->filled == 0, "an empty slice has an empty bound");
    scr_arr_release(c);
    scr_arr_release(w);
  }
  scr_arr_release(scr_arr_reverse(b));
  check(filled_ok(b), "reverse of a holey array recomputes the bound");
  scr_arr_release(scr_arr_sort_primitive(b, false));
  check(filled_ok(b), "sorting moves holes past the bound");
  for (size_t i = 0; i < b->len; i++) {
    if (i < b->cap && scr_arr_dense_state(b, i) != SCR_ARR_VALUE) break;
    check(i < b->filled, "sorted values form the bound");
  }
  while (scr_arr_len(b) > 0) {
    scr_arr_pop_state(b, NULL);
    check(filled_ok(b), "pop keeps the bound below the length");
  }
  scr_arr_release(b);

  ScrArr *r = scr_arr_new(SCR_ELEM_STR, 0);
  for (int i = 0; i < 4; i++) scr_arr_push_ref(r, scr_str_new("ab", 2));
  check(r->filled == 4 && filled_ok(r), "reference pushes keep the bound");
  scr_arr_delete(r, 0);
  check(r->filled == 0 && filled_ok(r), "deleting the first reference empties the bound");
  scr_arr_set_ref(r, 0, scr_str_new("c", 1));
  check(r->filled == 1 && filled_ok(r), "a write at an empty bound extends it by one");
  scr_arr_release(r);
}

/* Boolean arrays store one byte per dense element, followed by the states in
 * the same allocation once they have states. Growth moves the states to the
 * end of the larger area, densifying absorbs sparse entries into bytes, and
 * every moving and copying operation keeps values, holes and present
 * undefined in place. */
static bool bool_layout_ok(const ScrArr *a) {
  return a->cap == 0 || !scr_arr_has_states(a) ||
         scr_arr_states_end(a) == (const uint8_t *)a->data + 2 * (size_t)a->cap;
}

static bool bool_states(const ScrArr *a, const char *want) {
  if (scr_arr_len(a) != (double)strlen(want)) return false;
  for (size_t i = 0; want[i]; i++) {
    double state = scr_arr_state(a, (double)i);
    char got = state == SCR_ARR_HOLE        ? '_'
               : state == SCR_ARR_UNDEFINED ? 'u'
               : scr_arr_get_bool((ScrArr *)a, (double)i) ? 't'
                                                          : 'f';
    if (got != want[i]) return false;
  }
  return true;
}

static void test_bool_bytes(void) {
  ScrArr *a = scr_arr_new(SCR_ELEM_BOOL, 0);
  for (int i = 0; i < 1000; i++) scr_arr_push_bool(a, i % 3 == 0);
  check(bool_layout_ok(a) && a->filled == 1000, "bool pushes grow one-byte storage");
  bool values_ok = true;
  for (int i = 0; i < 1000; i++) {
    values_ok &= ((const uint8_t *)a->data)[i] == (i % 3 == 0);
    values_ok &= scr_arr_get_bool(a, i) == (i % 3 == 0);
  }
  check(values_ok, "bool values are stored as 0/1 bytes");
  check(scr_arr_index_of_bool(a, false) == 1 && scr_arr_includes_bool(a, true),
        "bool search reads bytes");
  scr_arr_set_len(a, 5);
  scr_arr_set_len(a, 8);
  scr_arr_set_undefined(a, 6);
  check(bool_layout_ok(a) && bool_states(a, "tfftf_u_"), "bool truncation clears bytes");

  ScrArr *s = scr_arr_new(SCR_ELEM_BOOL, 0);
  scr_arr_set_bool(s, 0, true);
  scr_arr_set_bool(s, 3000000, true);
  scr_arr_set_bool(s, 2000000, false);
  check(arr_sparse_len(s) == 2 && !scr_arr_get_bool(s, 2000000) && scr_arr_get_bool(s, 3000000),
        "bool sparse entries keep their values");
  scr_arr_set_len(s, 2000001);
  scr_arr_release(scr_arr_fill_bool(s, true, 1, 2000000));
  check(arr_sparse_len(s) == 0 && bool_layout_ok(s) && !scr_arr_get_bool(s, 2000000) &&
            scr_arr_get_bool(s, 1999999) && scr_arr_index_of_bool(s, false) == 2000000,
        "densifying absorbs sparse bool entries into bytes");
  scr_arr_release(s);

  ScrArr *m = scr_arr_new(SCR_ELEM_BOOL, 0);
  uint64_t slots[3] = {1, 0, 1};
  scr_arr_push_many(m, 3, slots);
  scr_arr_unshift_many(m, 2, slots + 1);
  check(bool_states(m, "fttft"), "slot buffers narrow to bytes");
  scr_arr_unshift_bool(m, false);
  scr_arr_set_undefined(m, 2);
  scr_arr_delete(m, 4);
  check(bool_states(m, "ffut_t"), "unshift moves bytes and states together");
  ScrArr *removed = scr_arr_splice(m, 1, 2);
  check(bool_states(removed, "fu") && bool_states(m, "ft_t"), "splice moves bytes out");
  scr_arr_release(removed);
  ScrArr *items = scr_arr_new(SCR_ELEM_BOOL, 0);
  scr_arr_push_bool(items, true);
  scr_arr_push_bool(items, false);
  scr_arr_release(scr_arr_splice_insert(m, 1, 1, items));
  check(bool_states(m, "ftf_t"), "splice insertion copies bytes in");
  scr_arr_splice_drop(m, 0, 1, 2, slots);
  check(bool_states(m, "tftf_t"), "statement splice stores bytes");
  scr_arr_release(scr_arr_reverse(m));
  check(bool_states(m, "t_ftft"), "reverse swaps bytes");
  ScrArr *copy = scr_arr_slice(m, 1, INFINITY);
  check(bool_states(copy, "_ftft") && bool_layout_ok(copy), "slice copies bytes");
  scr_arr_release(copy);
  copy = scr_arr_to_reversed(m);
  check(bool_states(copy, "tftfut"), "toReversed copies bytes and materializes holes");
  scr_arr_release(copy);
  scr_arr_concat_copy(m, items);
  scr_arr_push_spread(m, m);
  check(bool_states(m, "t_ftfttftuftfttf"), "concat keeps holes; self spread reads them as undefined");
  scr_arr_release(scr_arr_copy_within(m, 0, 2, 5));
  check(scr_arr_index_eq(m, 0, items, 1) && scr_arr_index_eq(m, 1, items, 0),
        "copyWithin moves bytes and index equality reads them");
  check(scr_arr_shift_bool(m) == false && scr_arr_pop_bool(m) == false, "shift and pop read bytes");
  scr_arr_release(scr_arr_sort_primitive(m, false));
  bool sorted = true;
  for (double i = 1; i < scr_arr_len(m); i++)
    if (scr_arr_state(m, i) == SCR_ARR_VALUE && scr_arr_state(m, i - 1) == SCR_ARR_VALUE)
      sorted &= scr_arr_get_bool(m, i - 1) <= scr_arr_get_bool(m, i);
  check(sorted, "default sort orders bytes");
  ScrStr *sep = scr_str_new(",", 1);
  ScrStr *joined = scr_arr_join(items, sep);
  check(strcmp(joined->data, "true,false") == 0, "join reads bytes");
  scr_str_release(joined);
  scr_str_release(sep);
  scr_arr_release(items);
  scr_arr_release(m);
  scr_arr_release(a);
}

/* Small constructions keep their first slots in the array's own block,
 * right after the header; growth moves them to an ordinary
 * allocation, and storage replacement, outlining and release never free
 * the inline room on its own (ASan reports an invalid free otherwise). */
static bool inline_slots(const ScrArr *a) {
  return a->data == (const uint64_t *)((const char *)a + ((sizeof(ScrArr) + 7) & ~(size_t)7));
}

/* Int32 slots: 4-byte values, then the state bytes when the array has them. */
static bool i32_layout_ok(const ScrArr *a) {
  return a->elem == SCR_ELEM_I32 && scr_arr_slot_width(a) == sizeof(int32_t);
}

/* SCR_ELEM_I32: 4-byte int32 slots behind the double-valued entry points. */
static void test_i32_slots(void) {
  ScrArr *a = scr_arr_new_small(SCR_ELEM_I32);
  for (int i = 0; i < 1000; i++) scr_arr_push_f64(a, (double)(i * 7 - 3000));
  check(i32_layout_ok(a) && !scr_arr_has_states(a) && a->filled == 1000,
        "int32 pushes grow four-byte storage without states");
  bool values_ok = true;
  for (int i = 0; i < 1000; i++) {
    values_ok &= ((const int32_t *)a->data)[i] == i * 7 - 3000;
    values_ok &= scr_arr_get_f64(a, i) == (double)(i * 7 - 3000);
    values_ok &= scr_arr_get_number(a, i) == (double)(i * 7 - 3000);
  }
  check(values_ok, "int32 values are stored as 4-byte integers and read as doubles");
  scr_arr_set_f64(a, 10, 2147483647);
  scr_arr_set_f64(a, 11, -2147483648.0);
  check(scr_arr_get_f64(a, 10) == 2147483647 && scr_arr_get_f64(a, 11) == -2147483648.0,
        "int32 extremes round-trip");
  check(scr_arr_pop_f64(a) == 999 * 7 - 3000 && scr_arr_len(a) == 999, "pop reads the last int32");
  scr_arr_set_len(a, 5);
  scr_arr_set_len(a, 8);
  check(i32_layout_ok(a) && scr_arr_has_states(a) && scr_arr_state(a, 6) == SCR_ARR_HOLE &&
            isnan(scr_arr_get_number(a, 6)) && scr_arr_get_f64(a, 4) == 4 * 7 - 3000,
        "int32 truncation clears slots and extension adds holes");
  scr_arr_set_f64(a, 20, 5);
  check(scr_arr_len(a) == 21 && scr_arr_state(a, 15) == SCR_ARR_HOLE && scr_arr_get_f64(a, 20) == 5,
        "an int32 store past the length leaves holes");
  scr_arr_release(scr_arr_fill_f64(a, -9, 0, 21));
  bool filled_ok = a->filled == 21;
  for (int i = 0; i < 21; i++) filled_ok &= scr_arr_get_f64(a, i) == -9;
  check(filled_ok, "int32 fill writes every slot");
  scr_arr_release(a);

  ScrArr *s = scr_arr_new(SCR_ELEM_I32, 0);
  scr_arr_set_f64(s, 0, 1);
  scr_arr_set_f64(s, 3000000, 3);
  scr_arr_set_f64(s, 2000000, -2);
  check(arr_sparse_len(s) == 2 && scr_arr_get_f64(s, 2000000) == -2 && scr_arr_get_f64(s, 3000000) == 3,
        "int32 sparse entries keep double slots");
  scr_arr_set_len(s, 2000001);
  scr_arr_release(scr_arr_fill_f64(s, 4, 1, 2000000));
  check(arr_sparse_len(s) == 0 && i32_layout_ok(s) && scr_arr_get_f64(s, 2000000) == -2 &&
            scr_arr_get_f64(s, 1999999) == 4 && scr_arr_get_f64(s, 0) == 1,
        "densifying absorbs sparse entries into int32 slots");
  scr_arr_release(s);

  ScrArr *k = scr_arr_new(SCR_ELEM_I32, 6);
  for (int i = 0; i < 6; i++) scr_arr_push_f64(k, i);
  scr_arr_push_f64(k, 6);
  check(i32_layout_ok(k) && scr_arr_get_f64(k, 6) == 6 && scr_arr_get_f64(k, 0) == 0,
        "a known-count int32 array grows out of its block");
  scr_arr_release(k);

  /* Widening: in place, to 8-byte double slots, keeping states. */
  ScrArr *w = scr_arr_new(SCR_ELEM_I32, 3);
  for (int i = 0; i < 3; i++) scr_arr_push_f64(w, i - 1);
  check(inline_slots(w), "a three-element int32 construction keeps inline slots");
  scr_arr_widen_i32(w);
  check(w->elem == SCR_ELEM_F64 && !inline_slots(w) && scr_arr_len(w) == 3 && w->filled == 3 &&
            scr_arr_get_f64(w, 0) == -1 && scr_arr_get_f64(w, 2) == 1,
        "widening moves inline int32 slots out as doubles");
  scr_arr_set_f64(w, 1, 2.5);
  check(scr_arr_get_f64(w, 1) == 2.5, "a widened array stores fractions");
  scr_arr_widen_i32(w);
  check(w->elem == SCR_ELEM_F64 && scr_arr_get_f64(w, 1) == 2.5, "widening twice is a no-op");
  scr_arr_release(w);

  ScrArr *h = scr_arr_new_small(SCR_ELEM_I32);
  for (int i = 0; i < 100; i++) scr_arr_push_f64(h, i * 3);
  scr_arr_set_len(h, 120);
  scr_arr_set_undefined(h, 5);
  scr_arr_set_f64(h, 4000000, -7);
  size_t cap = h->cap;
  scr_arr_widen_i32(h);
  bool widened = h->elem == SCR_ELEM_F64 && h->cap == cap && scr_arr_len(h) == 4000001 &&
                 scr_arr_states_end(h) == (const uint8_t *)h->data + 9 * (size_t)h->cap;
  for (int i = 0; i < 100; i++)
    if (i != 5) widened &= scr_arr_get_f64(h, i) == i * 3;
  check(widened && scr_arr_state(h, 5) == SCR_ARR_UNDEFINED && scr_arr_state(h, 110) == SCR_ARR_HOLE &&
            scr_arr_get_f64(h, 4000000) == -7 && arr_sparse_len(h) == 1,
        "widening keeps values, present undefined, holes and sparse entries");
  scr_arr_push_f64(h, 0.5);
  check(scr_arr_get_f64(h, 4000001) == 0.5, "a widened array keeps growing as doubles");
  scr_arr_release(h);

  ScrArr *e = scr_arr_new_small(SCR_ELEM_I32);
  scr_arr_widen_i32(e);
  scr_arr_push_f64(e, -0.0);
  check(e->elem == SCR_ELEM_F64 && signbit(scr_arr_get_f64(e, 0)), "an empty int32 array widens too");
  scr_arr_release(e);
}

static void test_inline_slots(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
  long arrays0 = scr_arr_live_count();
#endif
  ScrArr *plain = scr_arr_new(SCR_ELEM_F64, 0);
  check(!inline_slots(plain) && plain->data == NULL, "empty plain constructions allocate no slots");
  scr_arr_release(plain);
  /* A construction with a known count up to 16 slots keeps them in its own
   * block; growth past them moves them out like any inline array. */
  ScrArr *known = scr_arr_new(SCR_ELEM_F64, 4);
  check(inline_slots(known) && known->cap >= 4 && known->len == 0 && !scr_arr_has(known, 0) &&
            !scr_arr_has_states(known),
        "a known-count construction places its slots in the array block");
  size_t known_cap = known->cap;
  for (size_t i = 0; i <= known_cap; i++) scr_arr_push_f64(known, (double)i);
  check(!inline_slots(known) && scr_arr_len(known) == known_cap + 1 && scr_arr_get_f64(known, 0) == 0 &&
            scr_arr_get_f64(known, (double)known_cap) == (double)known_cap,
        "growth past a known-count construction moves the slots out");
  scr_arr_release(known);
  ScrArr *sixteen = scr_arr_new(SCR_ELEM_STR, 16);
  for (int i = 0; i < 16; i++) scr_arr_push_ref(sixteen, scr_str_new("s", 1));
  check(inline_slots(sixteen) && scr_arr_len(sixteen) == 16, "sixteen known slots stay inline");
  scr_arr_release(sixteen);
  ScrArr *large = scr_arr_new(SCR_ELEM_F64, 17);
  check(!inline_slots(large) && large->cap >= 17, "larger known counts keep separate storage");
  scr_arr_release(large);
  ScrArr *known_flags = scr_arr_new(SCR_ELEM_BOOL, 5);
  scr_arr_push_bool(known_flags, true);
  check(inline_slots(known_flags) && known_flags->cap >= 5 && scr_arr_get_bool(known_flags, 0),
        "known-count boolean constructions are inline too");
  scr_arr_release(known_flags);
  ScrArr *a = scr_arr_new_small(SCR_ELEM_F64);
  check(inline_slots(a) && a->cap >= 4 && a->len == 0 && !scr_arr_has_states(a),
        "small construction places its slots in the array block, without states");
  size_t inline_cap = a->cap;
  for (size_t i = 0; i < inline_cap; i++) scr_arr_push_f64(a, (double)i);
  check(inline_slots(a) && a->filled == inline_cap, "appends within the inline capacity stay inline");
  scr_arr_push_f64(a, 100);
  check(!inline_slots(a) && a->cap > inline_cap && scr_arr_get_f64(a, 0) == 0 &&
            scr_arr_get_f64(a, (double)inline_cap - 1) == (double)inline_cap - 1 &&
            scr_arr_get_f64(a, (double)inline_cap) == 100 && !scr_arr_has_states(a),
        "growth moves inline slots to their own allocation");
  scr_arr_release(a);

  ScrArr *flags = scr_arr_new_small(SCR_ELEM_BOOL);
  check(inline_slots(flags) && flags->cap >= 4 && !scr_arr_has_states(flags),
        "boolean inline slots are one byte each");
  scr_arr_push_bool(flags, true);
  scr_arr_set_bool(flags, 3, true);
  check(scr_arr_get_bool(flags, 0) && !scr_arr_has(flags, 1) && scr_arr_get_bool(flags, 3) &&
            scr_arr_has_states(flags) && bool_layout_ok(flags),
        "boolean inline slots keep holes");
  scr_arr_release(flags);

  ScrArr *words = scr_arr_new_small(SCR_ELEM_STR);
  scr_arr_push_ref(words, scr_str_new("a", 1));
  scr_arr_push_ref(words, scr_str_new("b", 1));
  scr_arr_set_ref(words, 3000000, scr_str_new("far", 3));
  /* A sparse entry needs out-of-line storage, whose pointer lives before the
   * dense allocation: the inline slots move out of line with their values. */
  check(!inline_slots(words) && arr_sparse_len(words) == 1 &&
            strcmp(((ScrStr *)scr_arr_peek_ref(words, 1))->data, "b") == 0,
        "a far index moves the inline slots out of line");
  scr_arr_unshift_ref(words, scr_str_new("z", 1));
  check(!inline_slots(words) && scr_arr_len(words) == 3000002 &&
            strcmp(((ScrStr *)scr_arr_peek_ref(words, 0))->data, "z") == 0 &&
            strcmp(((ScrStr *)scr_arr_peek_ref(words, 2))->data, "b") == 0 &&
            strcmp(((ScrStr *)scr_arr_peek_ref(words, 3000001))->data, "far") == 0,
        "rebuilding storage of an inline array keeps every element");
  scr_arr_release(words);

  ScrArr *moved = scr_arr_new_small(SCR_ELEM_STR);
  ScrArr *copy = scr_arr_new_small(SCR_ELEM_STR);
  scr_arr_push_ref(moved, scr_str_new("x", 1));
  scr_arr_push_ref(moved, scr_str_new("y", 1));
  scr_arr_concat_copy(copy, moved);
  check(inline_slots(copy) && scr_arr_len(copy) == 2, "a copy into small storage stays inline");
  scr_arr_outline(moved);
  check(!inline_slots(moved) && strcmp(((ScrStr *)scr_arr_peek_ref(moved, 1))->data, "y") == 0,
        "outlining moves the slots and keeps the elements");
  scr_arr_outline(moved);
  scr_arr_release(scr_arr_splice(copy, 0, 1));
  scr_arr_release(scr_arr_reverse(copy));
  check(scr_arr_len(copy) == 1 && strcmp(((ScrStr *)scr_arr_peek_ref(copy, 0))->data, "y") == 0,
        "moving operations work on inline slots");
  scr_arr_release(copy);
  scr_arr_release(moved);
#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings0 && scr_arr_live_count() == arrays0,
        "inline-slot arrays release every element and header");
#endif
}

/* Keyed sorts for recognized numeric comparators: the same stable result as
 * the comparator sort, without comparator calls unless a key is NaN or -0. */
static double keyed_ascending(ScrClosure *self, double a, double b) {
  (void)self;
  sort_calls++;
  return a - b;
}

static double keyed_descending(ScrClosure *self, double a, double b) {
  (void)self;
  sort_calls++;
  return b - a;
}

static double keyed_rec_ascending(ScrClosure *self, void *a, void *b) {
  (void)self;
  sort_calls++;
  double d = (double)((MockRec *)a)->value - (double)((MockRec *)b)->value;
  mock_release(a);
  mock_release(b);
  return d;
}

static double keyed_rec_descending(ScrClosure *self, void *a, void *b) {
  (void)self;
  sort_calls++;
  double d = (double)((MockRec *)b)->value - (double)((MockRec *)a)->value;
  mock_release(a);
  mock_release(b);
  return d;
}

/* Reads value 0 as -0, which the comparator also treats as equal to 0. A
 * first scan reads keys without storing them, so a key may be read twice,
 * and placing a short tail reads head keys again in binary searches. */
static long key_reads = 0;
static double keyed_rec_key(ScrClosure *self, void *a) {
  (void)self;
  key_reads++;
  int value = ((MockRec *)a)->value;
  mock_release(a);
  return value == 0 ? -0.0 : (double)value;
}

static uint32_t keyed_seed = 7;
static uint32_t keyed_random(void) {
  keyed_seed = keyed_seed * 1103515245u + 12345u;
  return keyed_seed >> 8;
}

static void keyed_fill(ScrArr *a, ScrArr *b, size_t n, int shape) {
  for (size_t i = 0; i < n; i++) {
    double v;
    if (shape == 0) v = (double)(keyed_random() % 64) - 32; /* small integers with ties */
    else if (shape == 1) v = ((double)keyed_random() - 4e6) / 977.0 * 1e10; /* wide doubles */
    else if (shape == 2) v = (double)i; /* presorted */
    else if (shape == 3) v = (double)(n - i) * 0.25; /* strictly reversed */
    else if (shape == 4) v = (double)((i % (n / 3 + 1)) / 2); /* three runs with ties */
    else if (shape == 5) v = i + 3 < n ? (double)i : (double)(keyed_random() % 64); /* sorted, then appended */
    else v = i < 3 ? (double)(keyed_random() % 64) : (double)(i / 2); /* a few, then sorted */
    if (shape == 1 && i == 3) v = INFINITY;
    if (shape == 1 && i == 5) v = -INFINITY;
    scr_arr_push_f64(a, v);
    scr_arr_push_f64(b, v);
  }
}

static bool keyed_same_numbers(ScrArr *a, ScrArr *b) {
  if (scr_arr_len(a) != scr_arr_len(b)) return false;
  for (size_t i = 0; i < (size_t)scr_arr_len(a); i++) {
    double x = scr_arr_get_f64(a, (double)i), y = scr_arr_get_f64(b, (double)i);
    if (memcmp(&x, &y, sizeof x) != 0) return false;
  }
  return true;
}

static void test_keyed_sort(void) {
  ScrClosure ascending = {SIZE_MAX, (void *)keyed_ascending, 0, NULL, 0};
  ScrClosure descending = {SIZE_MAX, (void *)keyed_descending, 0, NULL, 0};
  const size_t sizes[] = {2, 5, 40, 49, 1000, 70000, 140000}; /* the last takes 11-bit digits */
  const size_t size_count = sizeof(sizes) / sizeof(*sizes);
  bool same = true, uncalled = true;
  for (size_t s = 0; s < size_count; s++) {
    for (int shape = 0; shape < 7; shape++) {
      for (int order = -1; order <= 1; order += 2) {
        ScrClosure *cmp = order > 0 ? &ascending : &descending;
        for (int path = 0; path < 3; path++) {
          ScrArr *expected = scr_arr_new(SCR_ELEM_F64, 0);
          ScrArr *actual = scr_arr_new(SCR_ELEM_F64, 0);
          keyed_fill(expected, actual, sizes[s], shape);
          scr_arr_sort_values(expected, (double)sizes[s], cmp, 2, 0, NULL);
          sort_calls = 0;
          if (path == 0) scr_arr_sort_values(actual, (double)sizes[s], cmp, 2, order, NULL);
          else scr_arr_sort_dense(actual, cmp, 2, path == 2, order, NULL);
          uncalled &= sort_calls == 0;
          same &= keyed_same_numbers(expected, actual);
          scr_arr_release(expected);
          scr_arr_release(actual);
        }
      }
    }
  }
  check(same, "keyed number sorts match the comparator sort");
  check(uncalled, "keyed number sorts call no comparator");

  const double specials[] = {NAN, -0.0};
  for (size_t k = 0; k < 2; k++) {
    ScrArr *expected = scr_arr_new(SCR_ELEM_F64, 0);
    ScrArr *actual = scr_arr_new(SCR_ELEM_F64, 0);
    keyed_fill(expected, actual, 300, 0);
    scr_arr_set_f64(expected, 150, specials[k]);
    scr_arr_set_f64(actual, 150, specials[k]);
    scr_arr_sort_values(expected, 300, &ascending, 2, 0, NULL);
    sort_calls = 0;
    scr_arr_sort_dense(actual, &ascending, 2, true, 1, NULL);
    check(sort_calls > 0 && keyed_same_numbers(expected, actual),
          k == 0 ? "a NaN key sorts through the comparator" : "a -0 key sorts through the comparator");
    scr_arr_release(expected);
    scr_arr_release(actual);
  }

  ScrClosure rec_ascending = {SIZE_MAX, (void *)keyed_rec_ascending, 0, NULL, 0};
  ScrClosure rec_descending = {SIZE_MAX, (void *)keyed_rec_descending, 0, NULL, 0};
  ScrClosure rec_key = {SIZE_MAX, (void *)keyed_rec_key, 0, NULL, 0};
  long live0 = mock_live;
  bool identical = true, direct = true, fallback = true;
  for (size_t s = 0; s < size_count; s++) {
    for (int order = -1; order <= 1; order += 2) {
      ScrClosure *cmp = order > 0 ? &rec_ascending : &rec_descending;
      for (int variant = 0; variant < 8; variant++) {
        /* Random keys, three ascending runs, ascending keys with a few or an
         * eighth appended, each without and with a -0 key. */
        bool zero = variant & 1, runs = variant / 2 == 1, appended = variant / 2 >= 2;
        size_t tail = variant / 2 == 3 ? sizes[s] / 8 : 4;
        size_t n = sizes[s];
        ScrArr *expected = scr_arr_new_ops(&mock_ops, 0);
        ScrArr *actual = scr_arr_new_ops(&mock_ops, 0);
        for (size_t i = 0; i < n; i++) {
          int value = runs       ? (int)((i % (n / 3 + 1)) * 40 / (n / 3 + 1)) + 1
                      : appended ? (i + tail < n ? (int)(i * 40 / n) + 1 : (int)(keyed_random() % 45))
                                 : (int)(keyed_random() % 50) - 25;
          if (value == 0) value = 25;
          if (zero && i == n / 2) value = 0;
          MockRec *r = mock_new(value);
          scr_arr_push_ref(expected, r);
          scr_arr_push_ref(actual, mock_retain(r));
        }
        scr_arr_sort_values(expected, (double)n, cmp, 2, 0, NULL);
        sort_calls = 0;
        key_reads = 0;
        if (s % 2) scr_arr_sort_values(actual, (double)n, cmp, 2, order, &rec_key);
        else scr_arr_sort_dense(actual, cmp, 2, s % 4 == 2, order, &rec_key);
        for (size_t i = 0; i < n; i++)
          identical &= scr_arr_peek_ref(expected, (double)i) == scr_arr_peek_ref(actual, (double)i);
        if (zero) fallback &= sort_calls > 0;
        else direct &= sort_calls == 0 && key_reads <= 2 * (long)n + (long)tail * 64;
        scr_arr_release(expected);
        scr_arr_release(actual);
      }
    }
  }
  check(identical, "keyed record sorts keep the comparator sort's stable permutation");
  check(direct, "keyed record sorts read keys a bounded number of times and call no comparator");
  check(fallback, "a -0 record key sorts through the comparator");
  check(mock_live == live0, "keyed record sorts balance every key read");
}

/* Multi-key sorts: a record's value v has keys v / 100 (major), v / 10 % 10
 * (middle) and v % 10 (minor). Value -1 reads key 1 as -0 and value -2 reads
 * it as NaN; the comparators treat both as the comparator expressions do. */
static double multi_key_of(int value, uint32_t j) {
  if (j == 1 && value == -1) return -0.0;
  if (j == 1 && value == -2) return NAN;
  if (value < 0) value = 0;
  return j == 0 ? value / 100 : j == 1 ? value / 10 % 10 : value % 10;
}

static double multi_term(double d) { return d != d ? 0 : d; }

/* `a.major - b.major || b.middle - a.middle` */
static double multi_two(ScrClosure *self, void *a, void *b) {
  (void)self;
  sort_calls++;
  int x = ((MockRec *)a)->value, y = ((MockRec *)b)->value;
  mock_release(a);
  mock_release(b);
  double d = multi_term(multi_key_of(x, 0) - multi_key_of(y, 0));
  return d != 0 ? d : multi_key_of(y, 1) - multi_key_of(x, 1);
}

/* `b.major - a.major || a.middle - b.middle || b.minor - a.minor` */
static double multi_three(ScrClosure *self, void *a, void *b) {
  (void)self;
  sort_calls++;
  int x = ((MockRec *)a)->value, y = ((MockRec *)b)->value;
  mock_release(a);
  mock_release(b);
  double d = multi_term(multi_key_of(y, 0) - multi_key_of(x, 0));
  if (d == 0) d = multi_term(multi_key_of(x, 1) - multi_key_of(y, 1));
  return d != 0 ? d : multi_key_of(y, 2) - multi_key_of(x, 2);
}

static double multi_key(ScrClosure *self, void *a, double j) {
  (void)self;
  key_reads++;
  int value = ((MockRec *)a)->value;
  mock_release(a);
  return multi_key_of(value, (uint32_t)j);
}

static void test_multi_key_sort(void) {
  ScrClosure two = {SIZE_MAX, (void *)multi_two, 0, NULL, 0};
  ScrClosure three = {SIZE_MAX, (void *)multi_three, 0, NULL, 0};
  ScrClosure key = {SIZE_MAX, (void *)multi_key, 0, NULL, 0};
  /* Two keys with the second descending; three with the first and third. */
  const int32_t two_order = 2 | 1 << 9, three_order = 3 | 1 << 8 | 1 << 10;
  const size_t sizes[] = {2, 5, 40, 49, 1000, 70000, 140000};
  long live0 = mock_live;
  bool identical = true, direct = true, fallback = true;
  for (size_t s = 0; s < sizeof(sizes) / sizeof(*sizes); s++) {
    for (int variant = 0; variant < 6; variant++) {
      /* Two or three keys; then no special key, a -0 or a NaN in key 1. */
      bool use_three = variant & 1;
      int special = variant / 2;
      size_t n = sizes[s];
      ScrArr *expected = scr_arr_new_ops(&mock_ops, 0);
      ScrArr *actual = scr_arr_new_ops(&mock_ops, 0);
      for (size_t i = 0; i < n; i++) {
        int value = (int)(keyed_random() % (n < 100 ? 300 : 3000));
        if (special && i == n / 2) value = -special;
        MockRec *r = mock_new(value);
        scr_arr_push_ref(expected, r);
        scr_arr_push_ref(actual, mock_retain(r));
      }
      ScrClosure *cmp = use_three ? &three : &two;
      int32_t order = use_three ? three_order : two_order;
      scr_arr_sort_values(expected, (double)n, cmp, 2, 0, NULL);
      sort_calls = 0;
      key_reads = 0;
      if (s % 2) scr_arr_sort_values(actual, (double)n, cmp, 2, order, &key);
      else scr_arr_sort_dense(actual, cmp, 2, s % 4 == 2, order, &key);
      for (size_t i = 0; i < n; i++)
        identical &= scr_arr_peek_ref(expected, (double)i) == scr_arr_peek_ref(actual, (double)i);
      if (special) fallback &= sort_calls > 0;
      else direct &= sort_calls == 0 && key_reads == (long)n * (use_three ? 3 : 2);
      scr_arr_release(expected);
      scr_arr_release(actual);
    }
  }
  check(identical, "multi-key record sorts keep the comparator sort's stable permutation");
  check(direct, "multi-key record sorts read each key once and call no comparator");
  check(fallback, "a -0 or NaN in a later key sorts through the comparator");
  check(mock_live == live0, "multi-key record sorts balance every key read");
}

/* Typed-array sorts: the default numeric order and recognized comparator
 * orders against the comparator sort, which follows Node's merge schedule. */
static double typed_mod_ascending(ScrClosure *self, double a, double b) {
  (void)self;
  sort_calls++;
  return fmod(fabs(a), 7) - fmod(fabs(b), 7);
}

static double typed_default_order(ScrClosure *self, double a, double b) {
  (void)self;
  /* The default TypedArray order: numbers ascending, -0 before 0, NaN last. */
  if (a != a) return b != b ? 0 : 1;
  if (b != b) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  if (a == 0 && signbit(a) != signbit(b)) return signbit(a) ? -1 : 1;
  return 0;
}

static double typed_throwing(ScrClosure *self, double a, double b) {
  (void)self;
  if (++sort_calls == sort_throw_at) scr_throw_f64(5);
  return a - b;
}

static bool typed_same(const ScrBytes *a, const ScrBytes *b) {
  return a->len == b->len && memcmp(a->data, b->data, a->len * scr_bytes_elem_size(a->elem)) == 0;
}

static double typed_value(ScrBytesElem elem, size_t i, int shape) {
  double r = (double)keyed_random();
  if (shape == 1) return (double)i; /* presorted */
  if (shape == 2) return (double)(1000 - i % 1000); /* descending runs */
  switch (elem) {
  case SCR_BYTES_U8:
  case SCR_BYTES_U8C: return fmod(r, 256);
  case SCR_BYTES_I8: return fmod(r, 256) - 128;
  case SCR_BYTES_U16: return fmod(r, 65536);
  case SCR_BYTES_I16: return fmod(r, 65536) - 32768;
  case SCR_BYTES_U32: return r * 256;
  case SCR_BYTES_I32: return r * 256 - 2147483648.0;
  default: return (r - 8e6) / 3.0;
  }
}

static void test_typed_sort(void) {
  const ScrBytesElem elems[] = {SCR_BYTES_U8,  SCR_BYTES_U8C, SCR_BYTES_I8,
                                SCR_BYTES_U16, SCR_BYTES_I16, SCR_BYTES_U32,
                                SCR_BYTES_I32, SCR_BYTES_F32, SCR_BYTES_F64};
  const size_t sizes[] = {0, 1, 2, 7, 48, 49, 1000, 150000};
  ScrClosure natural = {SIZE_MAX, (void *)typed_default_order, 0, NULL, 0};
  ScrClosure ascending = {SIZE_MAX, (void *)keyed_ascending, 0, NULL, 0};
  ScrClosure descending = {SIZE_MAX, (void *)keyed_descending, 0, NULL, 0};
  ScrClosure by_mod = {SIZE_MAX, (void *)typed_mod_ascending, 0, NULL, 0};
  bool numeric = true, keyed = true, compared = true;
  for (size_t e = 0; e < sizeof(elems) / sizeof(*elems); e++) {
    for (size_t s = 0; s < sizeof(sizes) / sizeof(*sizes); s++) {
      for (int shape = 0; shape < 3; shape++) {
        size_t n = sizes[s];
        ScrBytes *base = scr_bytes_new(elems[e], (double)n);
        for (size_t i = 0; i < n; i++) scr_bytes_set(base, (double)i, typed_value(elems[e], i, shape));
        bool floats = elems[e] == SCR_BYTES_F32 || elems[e] == SCR_BYTES_F64;
        if (floats && n > 6 && shape == 0) {
          scr_bytes_set(base, 1, NAN);
          scr_bytes_set(base, 3, -0.0);
          scr_bytes_set(base, 5, 0.0);
        }
        ScrBytes *expected = scr_bytes_copy(base), *actual = scr_bytes_copy(base);
        scr_bytes_sort_compare(expected, &natural, 2);
        numeric &= scr_bytes_sort_numeric(actual, 0) && typed_same(expected, actual);
        scr_bytes_release(expected);
        scr_bytes_release(actual);
        for (int order = -1; order <= 1; order += 2) {
          expected = scr_bytes_copy(base);
          actual = scr_bytes_copy(base);
          ScrClosure *cmp = order > 0 ? &ascending : &descending;
          scr_bytes_sort_compare(expected, cmp, 2);
          sort_calls = 0;
          bool handled = scr_bytes_sort_numeric(actual, order);
          /* NaN and -0 refuse the comparator order and leave the elements. */
          bool special = floats && n > 6 && shape == 0;
          keyed &= sort_calls == 0 && handled == !special;
          keyed &= handled ? typed_same(expected, actual) : typed_same(base, actual);
          scr_bytes_release(expected);
          scr_bytes_release(actual);
        }
        if (n <= 1000) {
          /* The comparator sort is stable for a consistent comparator. */
          actual = scr_bytes_copy(base);
          scr_bytes_sort_compare(actual, &by_mod, 2);
          for (size_t i = 1; i < n; i++) {
            double a = fmod(fabs(scr_bytes_get(actual, (double)(i - 1))), 7);
            double b = fmod(fabs(scr_bytes_get(actual, (double)i)), 7);
            if (a == a && b == b && a > b) compared = false;
          }
          scr_bytes_release(actual);
        }
        scr_bytes_release(base);
      }
    }
  }
  check(numeric, "typed default sorts match the default order's comparator sort");
  check(keyed, "typed keyed sorts match their comparators and refuse NaN and -0");
  check(compared, "typed comparator sorts order by the comparator");

  /* Node's merge schedule: three elements compare (b, c) first, then a. */
  ScrBytes *three = scr_bytes_new(SCR_BYTES_F64, 3);
  scr_bytes_set(three, 0, 3);
  scr_bytes_set(three, 1, 1);
  scr_bytes_set(three, 2, 2);
  ScrClosure throwing = {SIZE_MAX, (void *)typed_throwing, 0, NULL, 0};
  sort_calls = 0;
  sort_throw_at = 2;
  scr_bytes_sort_compare(three, &throwing, 2);
  check(scr_exc_pending(), "a throwing typed comparator leaves the exception pending");
  scr_exc_clear();
  check(sort_calls == 2 && scr_bytes_get(three, 0) == 3 && scr_bytes_get(three, 2) == 2,
        "a typed comparator exception leaves the elements unwritten");
  sort_throw_at = -1;
  scr_bytes_sort_compare(three, &throwing, 2);
  check(!scr_exc_pending() && scr_bytes_get(three, 0) == 1 && scr_bytes_get(three, 2) == 3,
        "a typed comparator sort writes the sorted values back");
  scr_bytes_release(three);
}

/* scr_arr_dense_slots: the borrowed slots of hole-free dense arrays. */
static void test_dense_slots(void) {
  size_t len = 0;
  ScrArr *nums = scr_arr_new(SCR_ELEM_F64, 0);
  check(scr_arr_dense_slots(nums, &len) == NULL, "an empty array has no dense slots");
  for (int i = 0; i < 5; i++) scr_arr_push_f64(nums, i * 1.5);
  const uint64_t *slots = scr_arr_dense_slots(nums, &len);
  bool values = slots != NULL && len == 5;
  for (size_t i = 0; values && i < len; i++) {
    double v;
    memcpy(&v, &slots[i], sizeof v);
    values = v == (double)i * 1.5;
  }
  check(values, "dense number slots hold the values in order");
  scr_arr_set_undefined(nums, 2);
  check(scr_arr_dense_slots(nums, &len) == NULL, "storage-level undefined has no dense slots");
  ScrArr *holes = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(holes, 1);
  scr_arr_set_f64(holes, 3, 2);
  check(scr_arr_dense_slots(holes, &len) == NULL, "holes have no dense slots");
  ScrArr *flags = scr_arr_new(SCR_ELEM_BOOL, 0);
  scr_arr_push_bool(flags, true);
  check(scr_arr_dense_slots(flags, &len) == NULL, "boolean arrays have no 8-byte slots");
  ScrArr *words = scr_arr_new(SCR_ELEM_STR, 0);
  ScrStr *word = scr_str_new("w", 1);
  scr_arr_push_ref(words, scr_str_retain(word));
  slots = scr_arr_dense_slots(words, &len);
  check(slots != NULL && len == 1 && (void *)(uintptr_t)slots[0] == word,
        "dense reference slots hold borrowed pointers");
  ScrArr *wide = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(wide, 1);
  scr_arr_set_f64(wide, 3000000, 2);
  check(scr_arr_dense_slots(wide, &len) == NULL, "a sparse tail has no dense slots");
  scr_str_release(word);
  scr_arr_release(wide);
  scr_arr_release(words);
  scr_arr_release(flags);
  scr_arr_release(holes);
  scr_arr_release(nums);
}

/* shift and splice(0, n) advance dense storage into head room instead of
 * moving the tail; unshift reuses that room, growth gives it back, and a
 * drained array starts over at the front of its allocation. */
/* SCR_ARR_HEAD_ROOM (scr_array.c): the array has vacated slots in front of
 * `data`, and the slot just before `data` holds their count. */
static bool head_room(const ScrArr *a) { return (a->spare & 2u) != 0; }

static void test_head_room(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
  long arrays0 = scr_arr_live_count();
#endif
  ScrArr *q = scr_arr_new(SCR_ELEM_F64, 0);
  for (int i = 0; i < 64; i++) scr_arr_push_f64(q, i);
  uint64_t *block = q->data;
  size_t cap = q->cap;
  check_f64(scr_arr_shift_f64(q), 0, "shift answers the first element");
  check(q->data == block + 1 && q->cap == cap - 1 && q->len == 63,
        "shift advances the storage instead of moving the tail");
  check(!scr_arr_has_states(q) && head_room(q) && q->data[-1] == 1,
        "shift records the vacated slot in front of the data");
  check(q->filled == 63, "shift keeps the hole-free prefix");
  for (int i = 1; i < 40; i++) scr_arr_shift_f64(q);
  check(q->data == block + 40 && q->len == 24 && scr_arr_get_f64(q, 0) == 40 &&
            scr_arr_get_f64(q, 23) == 63,
        "repeated shifts index from the new front");
  check_f64(scr_arr_unshift_f64(q, -1), 25, "unshift into head room");
  check(q->data == block + 39 && scr_arr_get_f64(q, 0) == -1 && scr_arr_get_f64(q, 1) == 40,
        "unshift reuses the room shift left");
  /* Appends past the window move the elements back to the front of the
   * same allocation when the reclaimed room is large. */
  while (q->len < q->cap) scr_arr_push_f64(q, 100);
  scr_arr_push_f64(q, 101);
  check(q->data == block && q->cap == cap && q->len == 26,
        "growth reuses head room in place");
  check(scr_arr_get_f64(q, 0) == -1 && scr_arr_get_f64(q, 1) == 40 &&
            scr_arr_get_f64(q, q->len - 1) == 101 && !scr_arr_has(q, (double)q->len),
        "elements keep their order across the move");
  /* A drained array starts over at the front of its allocation. */
  while (q->len > 0) scr_arr_shift_f64(q);
  check(q->data == block && q->cap == cap && q->filled == 0, "draining resets the head room");
  scr_arr_push_f64(q, 5);
  check(q->data == block && scr_arr_get_f64(q, 0) == 5, "a drained array refills from the front");
  scr_arr_release(q);

  /* Small head room relative to the elements grows the allocation. */
  ScrArr *full = scr_arr_new(SCR_ELEM_F64, 0);
  for (int i = 0; i < 64; i++) scr_arr_push_f64(full, i);
  while (full->len < full->cap) scr_arr_push_f64(full, 0);
  size_t full_cap = full->cap;
  scr_arr_shift_f64(full);
  scr_arr_push_f64(full, 1);
  scr_arr_push_f64(full, 2);
  check(full->cap > full_cap && scr_arr_get_f64(full, 0) == 1 &&
            scr_arr_get_f64(full, full->len - 1) == 2,
        "growth past a small head room is geometric");
  scr_arr_release(full);

  /* splice(0, n) as a value and as a statement. */
  ScrArr *s = scr_arr_new(SCR_ELEM_F64, 0);
  for (int i = 0; i < 20; i++) scr_arr_push_f64(s, i);
  uint64_t *sblock = s->data;
  ScrArr *removed = scr_arr_splice(s, 0, 3);
  check(removed->len == 3 && scr_arr_get_f64(removed, 2) == 2 && s->data == sblock + 3 &&
            scr_arr_get_f64(s, 0) == 3,
        "splice(0, n) leaves head room");
  scr_arr_release(removed);
  scr_arr_splice_drop(s, 0, 2, 0, NULL);
  check(s->data == sblock + 5 && s->len == 15 && scr_arr_get_f64(s, 0) == 5,
        "statement splice(0, n) leaves head room");
  /* Sparse writes far past the end, then growth absorbs them. */
  scr_arr_set_f64(s, 2000000, 7);
  check(arr_sparse_len(s) == 1 && scr_arr_get_f64(s, 2000000) == 7, "sparse write after head room");
  check_f64(scr_arr_shift_f64(s), 5, "shift of a sparse array");
  check(scr_arr_get_f64(s, 1999999) == 7 && !scr_arr_has(s, 2000000), "shift renumbers sparse entries");
  scr_arr_release(s);

  /* Strings: shifted references move out; the rest are released once. */
  ScrArr *names = scr_arr_new(SCR_ELEM_STR, 0);
  for (int i = 0; i < 30; i++) scr_arr_push_ref(names, scr_str_new("name", 4));
  for (int i = 0; i < 10; i++) scr_str_release((ScrStr *)scr_arr_shift_ref(names));
  scr_arr_release(scr_arr_splice(names, 0, 5));
  scr_arr_splice_drop(names, 0, 5, 0, NULL);
  scr_arr_unshift_ref(names, scr_str_new("front", 5));
  ScrStr *front = (ScrStr *)scr_arr_get_ref(names, 0);
  check(strcmp(front->data, "front") == 0 && names->len == 11, "string queue keeps its order");
  scr_str_release(front);
  scr_arr_release(names);

  /* A run of unshifts opens head room once it has moved the elements. */
  ScrArr *rev = scr_arr_new(SCR_ELEM_F64, 0);
  for (int i = 0; i < 1000; i++) scr_arr_unshift_f64(rev, i);
  bool ordered = rev->len == 1000;
  for (int i = 0; i < 1000 && ordered; i++) ordered = scr_arr_get_f64(rev, i) == 999 - i;
  check(ordered, "unshift run keeps reverse order");
  size_t room = head_room(rev) ? (size_t)rev->data[-1] : 0;
  check(room >= 4 && rev->cap >= rev->len, "an unshift run reserves head room");
  uint64_t *rblock = rev->data;
  scr_arr_unshift_f64(rev, -1);
  check(rev->data == rblock - 1, "unshift into reserved head room needs no move");
  uint64_t slots[3] = {0};
  double v = 7;
  for (int i = 0; i < 3; i++) memcpy(&slots[i], &v, sizeof v);
  check_f64(scr_arr_unshift_many(rev, 3, slots), 1004, "unshift many into head room");
  check(rev->data == rblock - 4 && scr_arr_get_f64(rev, 3) == -1, "unshift many order");
  /* Storage swaps (typed views) first drop the head room. */
  scr_arr_outline(rev);
  check(!head_room(rev) && scr_arr_get_f64(rev, 0) == 7 &&
            scr_arr_get_f64(rev, 1003) == 0,
        "outline moves the elements to the front of their allocation");
  scr_arr_release(rev);

  /* A one-off unshift and small arrays keep moving their elements. */
  ScrArr *once = scr_arr_new(SCR_ELEM_F64, 0);
  for (int i = 0; i < 40; i++) scr_arr_push_f64(once, i);
  size_t once_cap = once->cap;
  scr_arr_unshift_f64(once, -1);
  check(once->cap == once_cap && !head_room(once),
        "a one-off unshift keeps the allocation");
  scr_arr_release(once);

  /* Booleans move their elements (one-byte slots have no head room). */
  ScrArr *flags = scr_arr_new(SCR_ELEM_BOOL, 0);
  for (int i = 0; i < 10; i++) scr_arr_push_bool(flags, i % 3 == 0);
  uint64_t *fblock = flags->data;
  check(scr_arr_shift_bool(flags) && !scr_arr_shift_bool(flags) && flags->data == fblock &&
            flags->len == 8 && !scr_arr_get_bool(flags, 0) && scr_arr_get_bool(flags, 1),
        "boolean shift moves the tail");
  scr_arr_release(flags);
#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings0, "head room: no strings leaked");
  check(scr_arr_live_count() == arrays0, "head room: no arrays leaked");
#endif
}

/* SCR_ARR_STATES (scr_array.h): an array starts without state bytes and
 * keeps none while every index below its length is a present value. A
 * hole, a present undefined or a length past the elements gives it states,
 * with the elements in place. */
static ScrStr *str_of(const char *text) { return scr_str_new(text, strlen(text)); }

static bool strs_are(ScrArr *a, const char *want) {
  /* want: one character per element, '_' a hole, 'u' undefined. */
  if (scr_arr_len(a) != (double)strlen(want)) return false;
  for (size_t i = 0; want[i]; i++) {
    double state = scr_arr_state(a, (double)i);
    if (want[i] == '_') {
      if (state != SCR_ARR_HOLE) return false;
    } else if (want[i] == 'u') {
      if (state != SCR_ARR_UNDEFINED) return false;
    } else {
      if (state != SCR_ARR_VALUE) return false;
      ScrStr *got = scr_arr_get_ref(a, (double)i);
      bool same = got->len == 1 && got->data[0] == want[i];
      scr_str_release(got);
      if (!same) return false;
    }
  }
  return filled_ok(a);
}

static ScrArr *strs_of(const char *text, bool small) {
  ScrArr *a = small ? scr_arr_new_small(SCR_ELEM_STR) : scr_arr_new(SCR_ELEM_STR, 0);
  for (size_t i = 0; text[i]; i++) scr_arr_push_ref(a, scr_str_new(text + i, 1));
  return a;
}

static void test_states_on_demand(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
  long arrays0 = scr_arr_live_count();
#endif
  ScrArr *a = strs_of("abcdef", false);
  scr_arr_set_ref(a, 1, str_of("B"));
  scr_arr_set_ref(a, 6, str_of("g"));
  scr_str_release(scr_arr_pop_ref(a));
  scr_arr_set_len(a, 5);
  check(!scr_arr_has_states(a) && a->filled == 5 && strs_are(a, "aBcde"),
        "pushes, writes below the length, appends, pops and truncation keep no states");
  scr_arr_set_undefined(a, 2);
  check(scr_arr_has_states(a) && strs_are(a, "aBude"), "a present undefined gives the array states");
  scr_arr_release(a);

  ScrArr *gap = strs_of("ab", true);
  scr_arr_set_ref(gap, 3, str_of("d"));
  check(scr_arr_has_states(gap) && strs_are(gap, "ab_d"), "a write past the length leaves holes");
  scr_arr_release(gap);

  ScrArr *longer = strs_of("abc", true);
  scr_arr_set_len(longer, 5);
  check(scr_arr_has_states(longer) && strs_are(longer, "abc__"), "a longer length adds holes");
  scr_arr_release(longer);

  /* `new Array(n)` and a length set on an empty small array: the inline
   * slots give way to one allocation holding the slots and their states. */
  ScrArr *sized = scr_arr_new_small(SCR_ELEM_STR);
  scr_arr_set_len(sized, 6);
  scr_arr_set_ref(sized, 4, str_of("e"));
  check(scr_arr_has_states(sized) && !(sized->spare & SCR_ARR_INLINE_SLOTS) && sized->cap == 6 &&
            strs_are(sized, "____e_") && filled_ok(sized),
        "a length set on an empty inline array reserves that many slots with states");
  scr_arr_release(sized);

  ScrArr *deleted = strs_of("abcd", false);
  scr_arr_delete(deleted, 1);
  check(scr_arr_has_states(deleted) && strs_are(deleted, "a_cd"), "delete leaves a hole");
  scr_arr_release(deleted);

  /* Conversion keeps out-of-line storage and head room's elements. */
  ScrArr *props = strs_of("abc", true);
  scr_arr_set_ref(props, -1, str_of("p"));
  scr_arr_set_undefined(props, 3);
  ScrStr *prop = scr_arr_get_ref(props, -1);
  check(scr_arr_has_states(props) && strs_are(props, "abcu") && prop->data[0] == 'p',
        "states keep a noncanonical property");
  scr_str_release(prop);
  scr_arr_release(props);
  ScrArr *q = strs_of("abcdefghijklmnopqrst", false);
  for (int i = 0; i < 3; i++) scr_str_release(scr_arr_shift_ref(q));
  check(!scr_arr_has_states(q) && head_room(q), "shift keeps no states");
  scr_arr_set_undefined(q, 1);
  check(scr_arr_has_states(q) && !head_room(q) && strs_are(q, "dufghijklmnopqrst"),
        "states move the elements of head room to the front");
  scr_arr_release(q);

  /* Copies keep no states for values, and states for holes. */
  ScrArr *src = strs_of("abcde", false);
  ScrArr *part = scr_arr_slice(src, 1, 4);
  ScrArr *joined = scr_arr_slice(src, 0, INFINITY);
  scr_arr_concat_copy(joined, src);
  ScrArr *spliced = scr_arr_splice(joined, 2, 3);
  ScrArr *reversed = scr_arr_to_reversed(src);
  scr_arr_release(scr_arr_reverse(src));
  scr_arr_release(scr_arr_sort_primitive(src, false));
  check(!scr_arr_has_states(part) && strs_are(part, "bcd"), "a slice of values keeps no states");
  check(!scr_arr_has_states(joined) && strs_are(joined, "ababcde"),
        "concat and splice of values keep no states");
  check(!scr_arr_has_states(spliced) && strs_are(spliced, "cde"), "removed values keep no states");
  check(!scr_arr_has_states(reversed) && strs_are(reversed, "edcba"), "toReversed of values keeps no states");
  check(!scr_arr_has_states(src) && strs_are(src, "abcde"), "reverse and sort of values keep no states");
  scr_arr_release(src);
  scr_arr_release(part);
  scr_arr_release(joined);
  scr_arr_release(spliced);
  scr_arr_release(reversed);
  ScrArr *holey = strs_of("ab", false);
  scr_arr_set_ref(holey, 3, str_of("d"));
  ScrArr *spread = strs_of("x", true);
  scr_arr_push_spread(spread, holey);
  ScrArr *concat = strs_of("x", true);
  scr_arr_concat_copy(concat, holey);
  ScrArr *values = scr_arr_slice(holey, 0, 2);
  ScrArr *front = strs_of("yz", false);
  scr_arr_unshift_spread(front, holey);
  check(scr_arr_has_states(spread) && strs_are(spread, "xabud") && scr_arr_has_states(concat) &&
            strs_are(concat, "xab_d") && !scr_arr_has_states(values) && strs_are(values, "ab") &&
            scr_arr_has_states(front) && strs_are(front, "abudyz"),
        "copies of holes keep holes or present undefined");
  scr_arr_release(holey);
  scr_arr_release(spread);
  scr_arr_release(concat);
  scr_arr_release(values);
  scr_arr_release(front);

  /* Numbers and booleans take the same paths without references. */
  ScrArr *nums = scr_arr_new(SCR_ELEM_F64, 3);
  for (int i = 0; i < 40; i++) scr_arr_push_f64(nums, i);
  scr_arr_release(scr_arr_fill_f64(nums, 7, 30, INFINITY));
  check(!scr_arr_has_states(nums) && scr_arr_get_number(nums, 39) == 7 && scr_arr_get_number(nums, 40) != 0,
        "number fills keep no states");
  scr_arr_release(scr_arr_fill_undefined(nums, 0, 1));
  check(scr_arr_has_states(nums) && scr_arr_state(nums, 0) == SCR_ARR_UNDEFINED &&
            scr_arr_get_number(nums, 1) == 1 && scr_arr_get_number(nums, 39) == 7 && filled_ok(nums),
        "an undefined fill gives a number array states");
  scr_arr_release(nums);
  ScrArr *bits = scr_arr_new_small(SCR_ELEM_BOOL);
  for (int i = 0; i < 6; i++) scr_arr_push_bool(bits, i % 2 == 0);
  scr_arr_set_undefined(bits, 6);
  check(scr_arr_has_states(bits) && bool_layout_ok(bits) && scr_arr_get_bool(bits, 4) &&
            !scr_arr_get_bool(bits, 5) && scr_arr_state(bits, 6) == SCR_ARR_UNDEFINED,
        "boolean arrays get one state byte per element");
  scr_arr_release(bits);
#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings0, "states on demand: no strings leaked");
  check(scr_arr_live_count() == arrays0, "states on demand: no arrays leaked");
#endif
}

/* Elements outside the element type (SCR_ARR_FOREIGN): stores, reads,
 * copies, sorting and removal keep the stored value's count balanced. */
static void test_foreign_elements(void) {
  ScrStr *text = scr_str_new("x", 1);
  ScrDyn *x = scr_dyn_new_str(text);
  scr_str_release(text);
  ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(a, 1);
  scr_arr_push_f64(a, 2);
  check(scr_arr_set_foreign(a, 2, x), "foreign store appends");
  check_f64(scr_arr_len(a), 3, "foreign store extends the length");
  check_f64(scr_arr_state(a, 2), SCR_ARR_FOREIGN, "foreign element state");
  ScrDyn *got = scr_arr_get_foreign(a, 2);
  check(got == x, "get_foreign answers the stored value");
  scr_dyn_release(got);
  check(scr_arr_get_foreign(a, 0) == NULL, "a number is not a foreign element");
  check(isnan(scr_arr_get_number(a, 2)), "numeric read of a foreign 'x' is NaN");
  check(scr_arr_set_foreign(a, 3, scr_dyn_undefined()), "undefined store");
  check_f64(scr_arr_state(a, 3), SCR_ARR_UNDEFINED, "undefined is a present undefined");
  ScrStr *sep = scr_str_new(",", 1);
  ScrStr *joined = scr_arr_join(a, sep);
  check(joined->len == 6 && memcmp(joined->data, "1,2,x,", 6) == 0, "join converts foreign");
  scr_str_release(joined);
  ScrArr *copy = scr_arr_slice(a, 0, INFINITY);
  check_f64(scr_arr_state(copy, 2), SCR_ARR_FOREIGN, "slice keeps a foreign element");
  scr_arr_release(copy);
  ScrArr *head = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_foreign(head, 0, x);
  scr_arr_push_f64(head, 2);
  scr_arr_push_f64(head, 3);
  copy = scr_arr_slice(head, 1, INFINITY);
  check_f64(scr_arr_get_f64(copy, 1), 3, "slice past a foreign element");
  scr_arr_release(copy);
  scr_arr_release(head);
  scr_arr_set_f64(a, 2, 5);
  check_f64(scr_arr_get_f64(a, 2), 5, "a number replaces a foreign element");
  scr_arr_set_foreign(a, 2, x);
  scr_arr_set_len(a, 1);
  check_f64(scr_arr_len(a), 1, "truncation drops foreign elements");
  scr_arr_set_foreign(a, 1, x);
  check(scr_arr_delete(a, 1), "delete removes a foreign element");
  scr_arr_set_foreign(a, 1, x);
  uint64_t slot = 0;
  check(scr_arr_pop_state(a, &slot) == SCR_ARR_FOREIGN, "pop answers the foreign state");
  check((ScrDyn *)(uintptr_t)slot == x, "pop moves the value out");
  scr_dyn_release((ScrDyn *)(uintptr_t)slot);
  for (int i = 0; i < 12; i++) scr_arr_set_foreign(a, (double)(1 + i), x);
  double seven = 7;
  uint64_t inserted[1];
  memcpy(&inserted[0], &seven, sizeof seven);
  scr_arr_splice_drop(a, 1, 10, 1, inserted);
  check_f64(scr_arr_len(a), 4, "splice removes foreign elements");
  check_f64(scr_arr_get_f64(a, 1), 7, "splice inserts after them");
  scr_arr_release(a);

  ScrStr *letter = scr_str_new("a", 1);
  ScrDyn *a_value = scr_dyn_new_str(letter);
  scr_str_release(letter);
  ScrArr *s = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(s, 10);
  scr_arr_push_f64(s, 9);
  scr_arr_set_foreign(s, 2, a_value);
  scr_arr_push_f64(s, 1);
  scr_arr_release(scr_arr_sort_primitive(s, false));
  check(scr_arr_get_f64(s, 0) == 1 && scr_arr_get_f64(s, 1) == 10 && scr_arr_get_f64(s, 2) == 9,
        "default sort orders numbers by their strings");
  check_f64(scr_arr_state(s, 3), SCR_ARR_FOREIGN, "default sort orders 'a' after the digits");
  scr_arr_release(s);
  scr_dyn_release(a_value);

  ScrArr *flags = scr_arr_new(SCR_ELEM_BOOL, 0);
  check(!scr_arr_set_foreign(flags, 0, x), "boolean arrays hold no foreign elements");
  scr_arr_release(flags);
  scr_str_release(sep);
  check(x->rc == 1, "every foreign store released its count");
  scr_dyn_release(x);
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
  test_comparator_sort();
  test_keyed_sort();
  test_multi_key_sort();
  test_dense_slots();
  test_typed_sort();
  test_dense_comparator_sort();
  test_f64_basics();
  test_numeric_read();
  test_borrowed_ref_read();
  test_bool();
  test_exact_construction();
  test_dense_replacement();
  test_unshift_reverse();
  test_str_rc();
  test_nested_rc();
  test_index_of_includes();
  test_ref_elements();
  test_release_nothing_ops();
  test_ref_known_count_cycle(&mock_cyc_ops);
  test_ops_overflow();
  test_ref_known_count_cycle(&mock_cyc_ops_late);
  test_ext_through_storage_changes();
  test_ref_cycle();
  test_ref_truncate_cycle();
  test_ref_trace_storage_boundaries();
  test_join();
  test_sparse_holes();
  test_large_storage();
  test_bulk_reference_ownership();
  test_splice_drop();
  test_filled_prefix();
  test_bool_bytes();
  test_i32_slots();
  test_inline_slots();
  test_head_room();
  test_states_on_demand();

  test_foreign_elements();

  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed == 0 ? 0 : 1;
}
