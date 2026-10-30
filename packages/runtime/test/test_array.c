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
static size_t arr_sparse_len(const ScrArr *a) { return a->ext ? a->ext->sparse_len : 0; }

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

static const ScrArrOps mock_ops = { &mock_retain, &mock_release, NULL };
static const ScrArrOps mock_cyc_ops = { &mock_cyc_retain, &mock_cyc_release, &mock_trace };

/* A named property can close a cycle independently of the indexed element
 * type. Exercise every allocator and both traced and untraced slot payloads. */
static void test_named_metadata_cycles(void) {
  const ScrElemKind kinds[] = {SCR_ELEM_F64, SCR_ELEM_BOOL, SCR_ELEM_STR,
                              SCR_ELEM_BYTES, SCR_ELEM_ARR, SCR_ELEM_REF, SCR_ELEM_REF};
  for (size_t kind = 0; kind < sizeof kinds / sizeof *kinds; kind++) {
    for (int allocation = 0; allocation < 3; allocation++) {
      scr_collect_cycles();
      long arrays = scr_arr_live_count(), strings = scr_str_live_count();
      long bytes = scr_bytes_live_count(), dyn = scr_dyn_live_count(), records = mock_live;
      size_t headered = scr_cyc_live;
      const ScrArrOps *ops = kind == 6 ? &mock_cyc_ops : &mock_ops;
      ScrArr *a = kinds[kind] == SCR_ELEM_REF
          ? (allocation == 1 ? scr_arr_new_ops_small(ops) : scr_arr_new_ops(ops, 2))
          : allocation == 2 ? scr_arr_new_inline(kinds[kind], 2)
          : allocation == 1 ? scr_arr_new_small(kinds[kind]) : scr_arr_new(kinds[kind], 2);
      check(a->cyc, "named metadata owner has a collector header for every element kind");
      if (!a->cyc) { scr_arr_release(a); continue; }
      const double indices[] = {0, 4294967294.0, -1};
      for (size_t i = 0; i < sizeof indices / sizeof *indices; i++) {
        double index = indices[i];
        switch (kinds[kind]) {
        case SCR_ELEM_F64: scr_arr_set_f64(a, index, 42); break;
        case SCR_ELEM_BOOL: scr_arr_set_bool(a, index, true); break;
        case SCR_ELEM_STR: scr_arr_set_ref(a, index, scr_str_new("owned", 5)); break;
        case SCR_ELEM_BYTES: scr_arr_set_ref(a, index, scr_bytes_new(SCR_BYTES_U8, 4)); break;
        case SCR_ELEM_ARR: {
          ScrArr *inner = scr_arr_new(SCR_ELEM_F64, 1);
          scr_arr_push_f64(inner, 42);
          scr_arr_set_ref(a, index, inner);
          break;
        }
        case SCR_ELEM_REF:
          scr_arr_set_ref(a, index, kind == 6 ? mock_cyc_new(42) : mock_new(42));
          break;
        }
      }
      ScrDyn *metadata = scr_dyn_new_obj();
      scr_arr_ext(a)->metadata = metadata;
      scr_dyn_obj_set(metadata, "self", 4, scr_dyn_new_typed_ref_traced(
          a, scr_arr_retain_v, scr_arr_release_v, "array:metadata", 14, NULL, NULL));
      /* A second edge reaches the owner through a closure's native array
       * capture, independently of the capsule's trace contract. */
      ScrClosure *closure = scr_closure_new(NULL, 1);
      closure->caps[0] = scr_box_new(SCR_BOX_ARR);
      scr_box_set_ref(closure->caps[0], scr_arr_retain(a));
      ScrDyn *function = scr_dyn_new_func(closure, NULL, 0, "()", "capture");
      scr_dyn_obj_set(metadata, "capture", 7, function);
      scr_collect_cycles();
      check(a->rc == 3 && scr_arr_has(a, 0) && scr_arr_has(a, -1),
            "external owner survives collection with both named back edges");
      scr_arr_release(a);
      scr_collect_cycles();
      check(scr_arr_live_count() == arrays && scr_str_live_count() == strings &&
            scr_bytes_live_count() == bytes && scr_dyn_live_count() == dyn &&
            mock_live == records && scr_cyc_live == headered,
            "named cycles release traced children and untraced slot payloads exactly once");
    }
  }
}

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
  check(scr_arr_sort_dense(one, &floor_fn, 2, false, 0, NULL) && !scr_exc_pending(),
        "a published singleton sort performs no writes");
  one->rc = rc;
  scr_arr_release(one);
  ScrArr *single_hole = scr_arr_new(SCR_ELEM_F64, 1);
  scr_arr_set_len(single_hole, 1);
  check(scr_arr_sort_dense(single_hole, &floor_fn, 2, false, 0, NULL) &&
        !scr_arr_has(single_hole, 0), "in-place singleton sort preserves its hole");
  check(!scr_arr_sort_dense(single_hole, &floor_fn, 2, true, 0, NULL) && sort_calls == 0,
        "toSorted materializes a singleton hole through the snapshot path");
  scr_arr_release(single_hole);
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

static ScrArr *integrity_sort_receiver;
static unsigned integrity_sort_mode, integrity_sort_calls;

static void integrity_sort_edit(void) {
  if (integrity_sort_calls++) return;
  if (integrity_sort_mode == 1) scr_arr_delete(integrity_sort_receiver, 1);
  if (integrity_sort_mode == 2) scr_arr_set_len(integrity_sort_receiver, 1);
  scr_native_integrity_strengthen(integrity_sort_receiver,
      integrity_sort_mode == 1 || integrity_sort_mode == 2
          ? SCR_NATIVE_NON_EXTENSIBLE : SCR_NATIVE_FROZEN);
  if (integrity_sort_mode == 3) scr_throw_f64(77);
}

static double integrity_sort_numbers(ScrClosure *self, double left, double right) {
  (void)self;
  integrity_sort_edit();
  return left - right;
}

static double integrity_sort_strings(ScrClosure *self, void *left, void *right) {
  (void)self;
  double order = scr_str_cmp_u16(left, right);
  scr_str_release(left); scr_str_release(right);
  integrity_sort_edit();
  return order;
}

static void test_sort_integrity_callbacks(void) {
  long strings = scr_str_live_count(), arrays = scr_arr_live_count();
  ScrClosure numbers = {SIZE_MAX, (void *)integrity_sort_numbers, 0, NULL, 0};
  ScrClosure words = {SIZE_MAX, (void *)integrity_sort_strings, 0, NULL, 0};
  for (int references = 0; references < 2; references++) {
    for (integrity_sort_mode = 0; integrity_sort_mode < 4; integrity_sort_mode++) {
      ScrArr *a = scr_arr_new(references ? SCR_ELEM_STR : SCR_ELEM_F64, 3);
      for (int i = 3; i > 0; i--) {
        if (references) { char value = (char)('0' + i); scr_arr_push_ref(a, scr_str_new(&value, 1)); }
        else scr_arr_push_f64(a, i);
      }
      integrity_sort_receiver = a;
      integrity_sort_calls = 0;
      check(scr_arr_sort_dense(a, references ? &words : &numbers, 2, false, 0, NULL),
            "dense sort handles comparator-time integrity changes");
      check(scr_exc_pending(), "sort preserves comparator failure or refuses the first forbidden write");
      if (integrity_sort_mode == 3 && scr_exc_pending()) {
        ScrCaught *caught = scr_exc_take();
        ScrStr *message = scr_caught_to_string(caught);
        check(strcmp(message->data, "77") == 0, "the comparator exception precedes frozen writeback");
        scr_str_release(message); scr_caught_release(caught);
      } else scr_exc_clear();
      check(integrity_sort_calls > 0 && a->len == (integrity_sort_mode == 2 ? 1 : 3),
            "sort keeps comparator edits to receiver length");
      double first = references ? ((ScrStr *)scr_arr_peek_ref(a, 0))->data[0] - '0'
                                : scr_arr_get_f64(a, 0);
      check_f64(first, integrity_sort_mode == 1 || integrity_sort_mode == 2 ? 1 : 3,
                "sort retains only writes completed before refusal");
      if (integrity_sort_mode == 1)
        check(!scr_arr_has(a, 1), "sort cannot refill a comparator-created non-extensible hole");
      scr_arr_release(a);
    }
  }
  ScrClosure pure = {SIZE_MAX, (void *)sort_by_floor, 0, NULL, 0};
  for (int scenario = 0; scenario < 8; scenario++) {
    int order = scenario & 1;
    bool sorted = (scenario & 2) != 0, published = (scenario & 4) != 0;
    ScrArr *a = scr_arr_new(SCR_ELEM_F64, 2);
    scr_arr_push_f64(a, sorted ? 1 : 3); scr_arr_push_f64(a, 2);
    size_t rc = a->rc;
    if (published) a->rc = SIZE_MAX;
    else scr_native_integrity_strengthen(a, SCR_NATIVE_FROZEN);
    check(scr_arr_sort_dense(a, &pure, 2, false, order, NULL) && scr_exc_pending(),
          "ordinary and keyed sort reject frozen writeback");
    scr_exc_clear();
    check_f64(scr_arr_get_f64(a, 0), sorted ? 1 : 3,
              "a frozen sort receiver keeps its original order");
    if (published) a->rc = rc;
    scr_arr_release(a);
  }
  for (int hole = 0; hole < 2; hole++) {
    ScrArr *a = scr_arr_new(SCR_ELEM_STR, 4);
    ScrStr *b = scr_str_new("b", 1), *first = scr_str_new("a", 1);
    scr_arr_push_ref(a, b);
    scr_arr_push_ref(a, first);
    scr_arr_set_ref(a, hole ? 3 : 2, scr_str_retain(b));
    scr_native_integrity_strengthen(a, SCR_NATIVE_NON_EXTENSIBLE);
    ScrArr *result = scr_arr_sort_primitive(a, false);
    check(hole ? result == NULL && scr_exc_pending() : result == a && !scr_exc_pending(),
          "primitive sort transfers duplicate references before any refused insertion");
    scr_exc_clear();
    check(scr_arr_peek_ref(a, 0) == first && scr_arr_peek_ref(a, 1) == b &&
          scr_arr_peek_ref(a, hole ? 3 : 2) == b,
          "primitive sort retains snapshot identity through overwritten references");
    if (result) scr_arr_release(result);
    scr_arr_release(a);
  }
  integrity_sort_receiver = NULL;
  check(scr_str_live_count() == strings && scr_arr_live_count() == arrays,
        "refused sort writeback releases retained work values");
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
 * operations that keep an array hole-free keep the bound at its length. */
static bool filled_ok(const ScrArr *a) {
  if (a->filled > a->len || a->filled > a->cap) return false;
  for (size_t i = 0; i < a->filled; i++)
    if (a->present[i] != SCR_ARR_VALUE) return false;
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
    if (i < b->cap && b->present[i] != SCR_ARR_VALUE) break;
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
 * the same allocation. Growth moves the states past the larger value area,
 * densifying absorbs sparse entries into bytes, and every moving and copying
 * operation keeps values, holes and present undefined in place. */
static bool bool_layout_ok(const ScrArr *a) {
  return a->cap == 0 || a->present == (const uint8_t *)a->data + a->cap;
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

static void test_indexed_storage_names(void) {
  ScrArr *a = scr_arr_new_small(SCR_ELEM_F64);
  ScrArr *b = scr_arr_new_small(SCR_ELEM_F64);
  scr_arr_set_f64(a, -1, 11);
  scr_arr_set_f64(b, -1, 22);
  ScrArrProp *a_props = a->ext->props, *b_props = b->ext->props;
  scr_arr_swap_indexed_storage(a, b);
  check(a->ext->props == a_props && b->ext->props == b_props,
        "indexed refresh preserves both named-property owners");
  check_f64(scr_arr_get_f64(a, -1), 11, "target keeps its named numeric value");
  check_f64(scr_arr_get_f64(b, -1), 22, "temporary keeps its named numeric value");
  scr_arr_release(a);
  scr_arr_release(b);

  a = scr_arr_new_small(SCR_ELEM_F64);
  b = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(a, 11);
  scr_arr_swap_indexed_storage(a, b);
  check(!a->ext && !b->ext && a->len == 0 && b->len == 1,
        "dense-only transfer keeps extensions unallocated");
  scr_arr_release(a);
  check_f64(scr_arr_get_f64(b, 0), 11, "moved inline values outlive their original header");
  scr_arr_release(b);

  a = scr_arr_new_small(SCR_ELEM_BOOL);
  b = scr_arr_new(SCR_ELEM_BOOL, 0);
  scr_arr_set_bool(b, 3000000, true);
  scr_arr_swap_indexed_storage(a, b);
  check(a->ext && b->ext && arr_sparse_len(a) == 1 && arr_sparse_len(b) == 0 && b->len == 0,
        "sparse transfer creates a missing extension before changing owners");
  scr_arr_release(b);
  check(scr_arr_get_bool(a, 3000000), "moved sparse values outlive their original header");
  scr_arr_release(a);
}

static unsigned metadata_gets, metadata_sets;
static ScrDyn *metadata_receiver;

static ScrDyn *metadata_getter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  ScrDyn *receiver = scr_dyn_this_get();
  check(receiver == metadata_receiver, "copied accessor receives the detached snapshot");
  scr_dyn_release(receiver);
  metadata_gets++;
  return scr_dyn_new_num(73.5);
}

static ScrDyn *metadata_setter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  metadata_sets++;
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *metadata_key(const char *name) {
  ScrStr *text = scr_str_new(name, strlen(name));
  ScrDyn *key = scr_dyn_new_str(text);
  scr_str_release(text);
  return key;
}

static void test_metadata_copy(void) {
  scr_collect_cycles();
  long arrays = scr_arr_live_count(), strings = scr_str_live_count(), dyn = scr_dyn_live_count();
  size_t headered = scr_cyc_live;
  ScrArr *a = scr_arr_new_small(SCR_ELEM_F64);
  ScrDyn *source = scr_arr_ext(a)->metadata = scr_dyn_new_obj();
  ScrDyn *target = scr_dyn_new_arr(), *prototype = scr_dyn_new_obj();
  ScrDyn *data_key = metadata_key("data"), *accessor_key = metadata_key("accessor");
  ScrDyn *mutable_key = metadata_key("mutable");
  ScrSym *symbol = scr_sym_new(NULL);
  ScrDyn *symbol_key = scr_dyn_new_symbol(symbol);
  scr_sym_release(symbol);
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(11.5));
  scr_dyn_release(scr_dyn_define_property(source, data_key, descriptor));
  scr_dyn_release(descriptor);

  descriptor = scr_dyn_new_obj();
  ScrDyn *getter = scr_dyn_new_func(scr_closure_new(NULL, 0), metadata_getter, 0, "()", "metadata_getter");
  scr_dyn_obj_set(descriptor, "get", 3, getter);
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
  scr_dyn_release(scr_dyn_define_property(source, accessor_key, descriptor));
  scr_dyn_release(descriptor);
  scr_dyn_obj_set(source, "mutable", 7, scr_dyn_new_num(22.5));

  descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(33.5));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  scr_dyn_release(scr_dyn_define_property(source, symbol_key, descriptor));
  scr_dyn_release(descriptor);

  descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "set", 3,
      scr_dyn_new_func(scr_closure_new(NULL, 0), metadata_setter, 1, "(number)", "metadata_setter"));
  scr_dyn_release(scr_dyn_define_property(prototype, mutable_key, descriptor));
  scr_dyn_release(descriptor);
  scr_dyn_release(scr_dyn_set_prototype(target, prototype));
  scr_dyn_arr_push(target, scr_dyn_new_num(44.5));
  metadata_gets = metadata_sets = 0;
  metadata_receiver = target;
  scr_arr_copy_metadata(a, target);
  check(!scr_exc_pending() && !metadata_gets && !metadata_sets,
        "metadata copying invokes neither getters nor inherited setters");
  check(target->v.arr.len == 1 && target->v.arr.items[0]->v.num == 44.5,
        "metadata copying preserves indexed snapshot contents");
  ScrDyn *keys[] = {data_key, accessor_key, mutable_key, symbol_key};
  for (size_t i = 0; i < sizeof keys / sizeof *keys; i++) {
    ScrDyn *original = scr_dyn_get_own_property_descriptor(source, keys[i]);
    ScrDyn *copied = scr_dyn_get_own_property_descriptor(target, keys[i]);
    check(copied && copied->kind == SCR_DYN_OBJ, "snapshot retains every string and symbol descriptor");
    if (copied && copied->kind == SCR_DYN_OBJ) {
      const char *fields[] = {"value", "writable", "get", "set", "enumerable", "configurable"};
      for (size_t f = 0; f < sizeof fields / sizeof *fields; f++) {
        const ScrDyn *left = scr_dyn_obj_get(original, fields[f], strlen(fields[f]));
        const ScrDyn *right = scr_dyn_obj_get(copied, fields[f], strlen(fields[f]));
        check((!left && !right) || (left && right && scr_dyn_strict_eq(left, right)),
              "copied descriptor preserves its value, accessors and attributes");
      }
    }
    scr_dyn_release(original);
    scr_dyn_release(copied);
  }
  ScrDyn *replacement = scr_dyn_new_num(55.5);
  scr_dyn_key_set(target, mutable_key->v.str, replacement);
  scr_dyn_symbol_key_set(target, symbol_key, replacement);
  scr_dyn_release(replacement);
  ScrDyn *original_symbol = scr_dyn_symbol_key_get(source, symbol_key, false);
  check(scr_dyn_obj_get(source, "mutable", 7)->v.num == 22.5 &&
        original_symbol->kind == SCR_DYN_NUM && original_symbol->v.num == 33.5,
        "detached string and symbol updates leave native metadata unchanged");
  scr_dyn_release(original_symbol);
  scr_arr_release(a);
  scr_collect_cycles();
  ScrDyn *value = scr_dyn_arr_named_get(target, accessor_key->v.str);
  check(value && value->kind == SCR_DYN_NUM && value->v.num == 73.5 && metadata_gets == 1,
        "copied accessor survives native metadata disposal and runs once on Get");
  scr_dyn_release(value);
  for (size_t i = 0; i < sizeof keys / sizeof *keys; i++) scr_dyn_release(keys[i]);
  scr_dyn_release(target);
  scr_dyn_release(prototype);
  metadata_receiver = NULL;
  scr_collect_cycles();
  check(scr_arr_live_count() == arrays && scr_str_live_count() == strings &&
        scr_dyn_live_count() == dyn && scr_cyc_live == headered && !scr_exc_pending(),
        "metadata snapshots release every descriptor, closure and symbol owner");
}

static void storage_set(ScrArr *a, double index, int value, bool traced) {
  switch (a->elem) {
  case SCR_ELEM_F64: scr_arr_set_f64(a, index, value); break;
  case SCR_ELEM_BOOL: scr_arr_set_bool(a, index, value == 11); break;
  case SCR_ELEM_STR: {
    char text[16];
    int length = snprintf(text, sizeof text, "%d", value);
    scr_arr_set_ref(a, index, scr_str_new(text, (size_t)length));
    break;
  }
  case SCR_ELEM_REF: {
    MockRec *record = traced ? mock_cyc_new(value) : mock_new(value);
    if (traced) record->owner = scr_arr_retain(a);
    scr_arr_set_ref(a, index, record);
    break;
  }
  default: abort();
  }
}

static bool storage_value(ScrArr *a, double index, int value) {
  if (scr_arr_state(a, index) != SCR_ARR_VALUE) return false;
  switch (a->elem) {
  case SCR_ELEM_F64: return scr_arr_get_f64(a, index) == value;
  case SCR_ELEM_BOOL: return scr_arr_get_bool(a, index) == (value == 11);
  case SCR_ELEM_STR: return atoi(((ScrStr *)scr_arr_peek_ref(a, index))->data) == value;
  case SCR_ELEM_REF: return ((MockRec *)scr_arr_peek_ref(a, index))->value == value;
  default: abort();
  }
}

static void storage_check(ScrArr *a, int pattern, int value) {
  check(a->len == (pattern & 2 ? 3000003 : pattern & 1 ? 3 : 0),
        "indexed storage moves length with its slots");
  check((pattern & 1 ? storage_value(a, 0, value) : !scr_arr_has(a, 0)) &&
        !scr_arr_has(a, 1) &&
        scr_arr_state(a, 2) == (pattern & 1 ? SCR_ARR_UNDEFINED : SCR_ARR_HOLE),
        "dense values, holes and explicit undefined move together");
  check((pattern & 2 ? storage_value(a, 3000000, value) : !scr_arr_has(a, 3000000)) &&
        !scr_arr_has(a, 3000001) &&
        scr_arr_state(a, 3000002) == (pattern & 2 ? SCR_ARR_UNDEFINED : SCR_ARR_HOLE),
        "sparse values, holes and explicit undefined move together");
  check(filled_ok(a), "indexed storage preserves the dense filled-prefix invariant");
}

static void test_indexed_storage(void) {
  const ScrElemKind kinds[] = {SCR_ELEM_F64, SCR_ELEM_BOOL, SCR_ELEM_STR,
                              SCR_ELEM_REF, SCR_ELEM_REF};
  for (size_t kind = 0; kind < sizeof kinds / sizeof *kinds; kind++)
    for (int allocation = 0; allocation < 3; allocation++)
      for (int pattern = 0; pattern < 4; pattern++)
        for (int reverse = 0; reverse < 2; reverse++) {
          scr_collect_cycles();
          long arrays = scr_arr_live_count(), strings = scr_str_live_count();
          long dyn = scr_dyn_live_count(), records = mock_live;
          size_t headered = scr_cyc_live;
          ScrArr *pair[2];
          ScrArrExt *extensions[2];
          ScrArrProp *properties[2];
          ScrDyn *metadata[2];
          size_t counts[2];
          ScrSym *symbol = scr_sym_new(NULL);
          ScrDyn *key = scr_dyn_new_symbol(symbol);
          scr_sym_release(symbol);
          for (int side = 0; side < 2; side++) {
            int layout = (allocation + side) % 3;
            int contents = side ? 3 - pattern : pattern;
            int value = side ? 22 : 11;
            const ScrArrOps *ops = kind == 4 ? &mock_cyc_ops : &mock_ops;
            ScrArr *a = pair[side] = kinds[kind] == SCR_ELEM_REF
                ? (layout == 1 ? scr_arr_new_ops_small(ops) : scr_arr_new_ops(ops, 4))
                : layout == 2 ? scr_arr_new_inline(kinds[kind], 4)
                : layout == 1 ? scr_arr_new_small(kinds[kind]) : scr_arr_new(kinds[kind], 4);
            if (contents & 1) {
              storage_set(a, 0, value, kind == 4);
              scr_arr_set_undefined(a, 2);
            }
            if (contents & 2) {
              storage_set(a, 3000000, value, kind == 4);
              scr_arr_set_undefined(a, 3000002);
            }
            storage_set(a, -1, value, kind == 4);
            extensions[side] = a->ext;
            properties[side] = a->ext->props;
            metadata[side] = a->ext->metadata = scr_dyn_new_obj();
            scr_dyn_obj_set(metadata[side], "label", 5, scr_dyn_new_num(value + 0.5));
            ScrDyn *symbol_value = scr_dyn_new_num(value + 0.5);
            scr_dyn_symbol_key_set(metadata[side], key, symbol_value);
            scr_dyn_release(symbol_value);
            counts[side] = a->rc;
          }
          ScrArr *a = pair[0], *b = pair[1];
          uint64_t *inline_data = a->data;
          scr_arr_swap_indexed_storage(a, a);
          check(a->data == inline_data && a->ext == extensions[0] && a->rc == counts[0],
                "self swap preserves inline storage and ownership");
          ScrArr *alias = scr_arr_retain(a);
          scr_native_integrity_strengthen(a, SCR_NATIVE_NON_EXTENSIBLE);
          scr_arr_swap_indexed_storage(a, b);
          check(!inline_slots(a) && !inline_slots(b), "storage transfer detaches both inline buffers");
          check(a->rc == counts[0] + 1 && b->rc == counts[1] && a->elem == b->elem && a->ops == b->ops,
                "storage transfer borrows both representations without changing RC");
          check(scr_arr_integrity_flags(a) == SCR_NATIVE_NON_EXTENSIBLE && !scr_arr_integrity_flags(b),
                "indexed storage does not transfer native integrity identity");
          storage_check(alias, 3 - pattern, 22);
          storage_check(b, pattern, 11);
          for (int side = 0; side < 2; side++) {
            ScrArr *owner = pair[side];
            check(owner->ext == extensions[side] && owner->ext->metadata == metadata[side] &&
                  owner->ext->props == properties[side] && storage_value(owner, -1, side ? 22 : 11),
                  "indexed transfer preserves both named-property containers and values");
            ScrDyn *label = scr_dyn_obj_get(owner->ext->metadata, "label", 5);
            ScrDyn *symbol_value = scr_dyn_symbol_key_get(owner->ext->metadata, key, false);
            check(label->kind == SCR_DYN_NUM && label->v.num == (side ? 22.5 : 11.5) &&
                  symbol_value->kind == SCR_DYN_NUM && symbol_value->v.num == label->v.num,
                  "string and symbol metadata stay attached to their original referent");
            scr_dyn_release(symbol_value);
          }
          scr_arr_release(alias);
          scr_arr_release(pair[reverse]);
          scr_collect_cycles();
          storage_check(pair[!reverse], reverse ? 3 - pattern : pattern, reverse ? 22 : 11);
          scr_arr_release(pair[!reverse]);
          scr_dyn_release(key);
          scr_collect_cycles();
          check(scr_arr_live_count() == arrays && scr_str_live_count() == strings &&
                scr_dyn_live_count() == dyn && mock_live == records && scr_cyc_live == headered &&
                !scr_native_integrity_active() && !scr_exc_pending(),
                "either release order frees all values, named properties and cyclic owners");
        }
}

static void test_inline_slots(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
  long arrays0 = scr_arr_live_count();
#endif
  ScrArr *plain = scr_arr_new(SCR_ELEM_F64, 4);
  check(!inline_slots(plain), "plain constructions keep separate storage");
  scr_arr_release(plain);
  ScrArr *a = scr_arr_new_small(SCR_ELEM_F64);
  check(inline_slots(a) && a->cap >= 4 && a->len == 0 && a->present == (uint8_t *)(a->data + a->cap),
        "small construction places slots and states in the array block");
  size_t inline_cap = a->cap;
  for (size_t i = 0; i < inline_cap; i++) scr_arr_push_f64(a, (double)i);
  check(inline_slots(a) && a->filled == inline_cap, "appends within the inline capacity stay inline");
  scr_arr_push_f64(a, 100);
  check(!inline_slots(a) && a->cap > inline_cap && scr_arr_get_f64(a, 0) == 0 &&
            scr_arr_get_f64(a, (double)inline_cap - 1) == (double)inline_cap - 1 &&
            scr_arr_get_f64(a, (double)inline_cap) == 100 && a->present == (uint8_t *)(a->data + a->cap),
        "growth moves inline slots to their own allocation");
  scr_arr_release(a);

  ScrArr *flags = scr_arr_new_small(SCR_ELEM_BOOL);
  check(inline_slots(flags) && flags->present == (uint8_t *)flags->data + flags->cap,
        "boolean inline slots are one byte each");
  scr_arr_push_bool(flags, true);
  scr_arr_set_bool(flags, 3, true);
  check(scr_arr_get_bool(flags, 0) && !scr_arr_has(flags, 1) && scr_arr_get_bool(flags, 3),
        "boolean inline slots keep holes");
  scr_arr_release(flags);

  ScrArr *words = scr_arr_new_small(SCR_ELEM_STR);
  scr_arr_push_ref(words, scr_str_new("a", 1));
  scr_arr_push_ref(words, scr_str_new("b", 1));
  scr_arr_set_ref(words, 3000000, scr_str_new("far", 3));
  check(inline_slots(words) && arr_sparse_len(words) == 1, "a far index leaves inline slots in place");
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


static void check_error(const char *expected) {
  check(scr_exc_pending(), expected);
  if (!scr_exc_pending()) return;
  ScrCaught *caught = scr_exc_take();
  ScrStr *text = scr_caught_to_string(caught);
  check(strcmp(text->data, expected) == 0, expected);
  scr_str_release(text);
  scr_caught_release(caught);
}

static void test_integrity_properties(void) {
  const unsigned levels[] = {SCR_NATIVE_NON_EXTENSIBLE, SCR_NATIVE_SEALED, SCR_NATIVE_FROZEN};
  const double keys[] = {0, 2, 2000000, -1, 0.5, 4294967295.0, NAN, INFINITY};
  for (size_t level = 0; level < sizeof levels / sizeof *levels; level++) {
    ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
    for (size_t i = 0; i < sizeof keys / sizeof *keys; i++)
      scr_arr_set_f64(a, keys[i], 3);
    scr_arr_set_undefined(a, 2);
    scr_arr_set_len(a, 2000004);
    scr_native_integrity_strengthen(a, levels[level]);
    for (size_t i = 0; i < sizeof keys / sizeof *keys; i++) {
      scr_arr_set_f64(a, keys[i], 7);
      if (level == 2) {
        check(scr_exc_pending(), "frozen existing numeric properties reject writes");
        scr_exc_clear();
      } else {
        check(!scr_exc_pending(), "non-extensible and sealed existing writes succeed");
        check_f64(scr_arr_get_f64(a, keys[i]), 7, "existing numeric property changed");
      }
    }
    scr_arr_set_f64(a, 1, 8);
    check_error("TypeError: Cannot add property 1, object is not extensible");
    check(!scr_arr_has(a, 1), "failed hole write preserves absence");
    scr_arr_set_undefined(a, 2000002);
    check_error("TypeError: Cannot add property 2000002, object is not extensible");
    check(!scr_arr_has(a, 2000002), "failed undefined write preserves sparse hole");
    scr_arr_set_f64(a, -2, 8);
    check_error("TypeError: Cannot add property -2, object is not extensible");
    check(!scr_arr_delete(a, 1) && !scr_exc_pending(), "missing deletion is a no-op");
    bool removed = scr_arr_delete(a, 2);
    if (level == 0) {
      check(removed && !scr_exc_pending() && !scr_arr_has(a, 2), "non-extensible deletion succeeds");
      scr_arr_set_undefined(a, 2);
      check_error("TypeError: Cannot add property 2, object is not extensible");
    } else {
      check(!removed && scr_arr_has(a, 2), "sealed and frozen deletion preserves present element");
      check_error("TypeError: Cannot delete property '2' of [object Array]");
    }
    scr_arr_release(a);
    check(!scr_native_integrity_active(), "array disposal clears its integrity metadata");
  }
}

static void test_integrity_length(void) {
  ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_undefined(a, 2);
  scr_arr_set_len(a, 6);
  scr_native_integrity_strengthen(a, SCR_NATIVE_NON_EXTENSIBLE);
  scr_arr_set_len(a, 8);
  check(a->len == 8 && !scr_exc_pending() && !scr_arr_has(a, 7),
        "non-extensible length growth creates holes");
  scr_arr_set_len(a, 2);
  check(a->len == 2 && !scr_exc_pending(), "non-extensible shrink deletes present undefined");
  scr_arr_release(a);

  a = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_undefined(a, 2);
  scr_arr_set_f64(a, 2000000, 9);
  scr_arr_set_len(a, 4294967295.0);
  scr_native_integrity_strengthen(a, SCR_NATIVE_SEALED);
  scr_arr_set_len(a, 1);
  check_error("TypeError: Cannot delete property '2000000' of [object Array]");
  check(a->len == 2000001 && scr_arr_has(a, 2) && scr_arr_get_f64(a, 2000000) == 9,
        "sealed shrink restores length after the highest sparse element");
  scr_arr_release(a);

  a = scr_arr_new(SCR_ELEM_BOOL, 0);
  scr_arr_set_undefined(a, 2);
  scr_arr_set_len(a, 7);
  scr_native_integrity_strengthen(a, SCR_NATIVE_SEALED);
  scr_arr_set_len(a, 1);
  check_error("TypeError: Cannot delete property '2' of [object Array]");
  check(a->len == 3 && scr_arr_has(a, 2), "sealed shrink includes present undefined");
  scr_arr_set_len(a, 8);
  scr_arr_set_len(a, 3);
  check(a->len == 3 && !scr_exc_pending(), "sealed trailing holes can shrink");
  scr_arr_set_len(a, 1.5);
  check_error("RangeError: Invalid array length");
  scr_arr_release(a);

  a = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_len(a, 6);
  scr_native_integrity_strengthen(a, SCR_NATIVE_SEALED);
  scr_arr_set_len(a, 0);
  check(a->len == 0 && !scr_exc_pending(), "sealed hole-only array can shrink to zero");
  scr_arr_release(a);

  a = scr_arr_new(SCR_ELEM_F64, 0);
  scr_native_integrity_strengthen(a, SCR_NATIVE_FROZEN);
  const double lengths[] = {0, 1, -1, 1.5, NAN, INFINITY, 4294967296.0};
  for (size_t i = 0; i < sizeof lengths / sizeof *lengths; i++) {
    scr_arr_set_len(a, lengths[i]);
    check_error("TypeError: Cannot assign to read only property 'length' of object '[object Array]'");
    check(a->len == 0, "frozen length assignment leaves length unchanged");
  }
  scr_arr_release(a);
}

static void test_integrity_owned_refs(void) {
#ifdef SCR_RC_AUDIT
  long strings = scr_str_live_count();
#endif
  ScrArr *a = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_set_ref(a, 0, scr_str_new("kept", 4));
  scr_native_integrity_strengthen(a, SCR_NATIVE_FROZEN);
  scr_arr_set_ref(a, 0, scr_str_new("rejected", 8));
  check_error("TypeError: Cannot assign to read only property '0' of object '[object Array]'");
  ScrStr *kept = scr_arr_get_ref(a, 0);
  check(strcmp(kept->data, "kept") == 0, "rejected ref write leaves old owner intact");
  scr_arr_set_ref(a, 0, kept); /* the failing setter must consume this +1 */
  check_error("TypeError: Cannot assign to read only property '0' of object '[object Array]'");
  check(kept->rc == 1, "failing self-assignment consumes exactly the input reference");
  scr_arr_release(a);
#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings, "rejected ref writes release every temporary");
#endif
  a = scr_arr_new(SCR_ELEM_ARR, 0);
  ScrArr *child = scr_arr_new(SCR_ELEM_F64, 0);
  scr_native_integrity_strengthen(a, SCR_NATIVE_FROZEN);
  scr_arr_set_ref(a, 0, scr_arr_retain(child));
  check_error("TypeError: Cannot add property 0, object is not extensible");
  check(child->rc == 1, "rejected array value releases its transferred reference");
  scr_arr_release(child);
  scr_arr_release(a);

  a = scr_arr_new(SCR_ELEM_BYTES, 0);
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, 4);
  scr_native_integrity_strengthen(a, SCR_NATIVE_FROZEN);
  scr_arr_set_ref(a, 0, scr_bytes_retain(bytes));
  check_error("TypeError: Cannot add property 0, object is not extensible");
  check(bytes->rc == 1, "rejected byte view releases its transferred reference");
  scr_bytes_release(bytes);
  scr_arr_release(a);

  long records = mock_live;
  a = scr_arr_new_ops(&mock_ops, 0);
  MockRec *record = mock_new(7);
  scr_native_integrity_strengthen(a, SCR_NATIVE_FROZEN);
  scr_arr_set_ref(a, 0, mock_retain(record));
  check_error("TypeError: Cannot add property 0, object is not extensible");
  check(record->rc == 1, "rejected record value releases through its ops");
  mock_release(record);
  scr_arr_release(a);

  a = scr_arr_new_ops(&mock_cyc_ops, 0);
  record = mock_cyc_new(8);
  record->owner = scr_arr_retain(a);
  scr_native_integrity_strengthen(a, SCR_NATIVE_FROZEN);
  scr_arr_set_ref(a, 0, record);
  check_error("TypeError: Cannot add property 0, object is not extensible");
  check(a->rc == 1 && a->len == 0, "refusal releases a cyclic input without installing it");
  scr_arr_release(a);
  scr_collect_cycles();
  check(mock_live == records, "rejected record inputs leave no live values");
  check(!scr_native_integrity_active(), "refusal cleanup leaves no integrity metadata");
}

static void test_removal_owned_results(void) {
  long arrays = scr_arr_live_count(), records = mock_live;
  for (int shift = 0; shift < 2; shift++) for (int sparse = 0; sparse < 2; sparse++)
    for (int restricted = 0; restricted < 2; restricted++) for (int discard = 0; discard < 2; discard++) {
      ScrArr *a = scr_arr_new_ops(&mock_cyc_ops, 0);
      MockRec *record = mock_cyc_new(7);
      record->owner = scr_arr_retain(a);
      scr_arr_set_ref(a, sparse && !shift ? 2000000 : 0, record);
      if (sparse && shift) scr_arr_set_len(a, 2000001);
      size_t length = a->len;
      if (restricted) scr_native_integrity_strengthen(a, SCR_NATIVE_NON_EXTENSIBLE);
      uint64_t slot = 0;
      uint8_t state = shift ? scr_arr_shift_state(a, discard ? NULL : &slot)
          : scr_arr_pop_state(a, discard ? NULL : &slot);
      check(!scr_exc_pending() && state == SCR_ARR_VALUE && a->len == length - 1,
            "dense and sparse removal succeeds with a writable length");
      if (!discard) {
        MockRec *out = (MockRec *)(uintptr_t)slot;
        check(out == record && out->value == 7 && out->rc == 1,
              "successful removal transfers exactly one outgoing reference");
        mock_cyc_release(out);
      }
      check(mock_live == records && filled_ok(a), "discarded removal releases after consistent storage");
      scr_arr_release(a);
      scr_collect_cycles();
      check(scr_arr_live_count() == arrays && !scr_native_integrity_active(),
            "successful removal releases every cyclic owner and restriction");
    }

  ScrArr *a = scr_arr_new_ops(&mock_cyc_ops, 0);
  for (int i = 0; i < 3; i++) {
    MockRec *record = mock_cyc_new(i + 1);
    record->owner = scr_arr_retain(a);
    scr_arr_push_ref(a, record);
  }
  scr_native_integrity_strengthen(a, SCR_NATIVE_SEALED);
  uint64_t slot = UINT64_MAX;
  check(scr_arr_shift_state(a, &slot) == SCR_ARR_HOLE && slot == 0,
        "failed shift transfers no saved result");
  check_error("TypeError: Cannot delete property '2' of [object Array]");
  check(a->len == 3 && ((MockRec *)scr_arr_peek_ref(a, 0))->value == 2 &&
        ((MockRec *)scr_arr_peek_ref(a, 1))->value == 3 &&
        scr_arr_peek_ref(a, 1) == scr_arr_peek_ref(a, 2) && mock_live == records + 2,
        "failed sealed shift keeps completed writes and releases the saved first value");
  scr_native_integrity_strengthen(a, SCR_NATIVE_FROZEN);
  check(scr_arr_pop_ref(a) == NULL, "typed pop preserves a pending refusal instead of trapping");
  check_error("TypeError: Cannot delete property '2' of [object Array]");
  check(scr_arr_shift_ref(a) == NULL, "typed shift preserves a pending refusal instead of trapping");
  check_error("TypeError: Cannot assign to read only property '0' of object '[object Array]'");
  scr_arr_release(a);
  scr_collect_cycles();
  check(mock_live == records && scr_arr_live_count() == arrays && !scr_native_integrity_active(),
        "failed removals release every retained reference");
}

static void integrity_publish_array(void *ptr, ScrPub *context) {
  scr_pub_arr(ptr, context, NULL);
}

/* Sparse storage must preserve the same partial writes as the dense Node
 * matrix. Back-edges make replacement and failure cleanup collectable at
 * every release, including reverse's retained value after a deletion. */
static void test_integrity_range_sparse_refs(void) {
  const double high = 2000000;
  const unsigned levels[] = {SCR_NATIVE_NON_EXTENSIBLE, SCR_NATIVE_SEALED, SCR_NATIVE_FROZEN};
  long arrays = scr_arr_live_count(), records = mock_live;
  for (int op = 0; op < 3; op++) for (size_t level = 0; level < 3; level++) {
    ScrArr *a = scr_arr_new_ops(&mock_cyc_ops, 0);
    MockRec *first = mock_cyc_new(1), *last = mock_cyc_new(3), *fill = NULL;
    first->owner = scr_arr_retain(a);
    last->owner = scr_arr_retain(a);
    scr_arr_set_ref(a, op == 2 ? 0 : high, first);
    scr_arr_set_ref(a, op == 2 ? high : high + 3, last);
    if (op == 0) {
      scr_arr_set_undefined(a, high + 1);
      fill = mock_cyc_new(9);
      fill->owner = scr_arr_retain(a);
    } else {
      MockRec *middle = mock_cyc_new(2);
      middle->owner = scr_arr_retain(a);
      scr_arr_set_ref(a, op == 2 ? 1 : high + 1, middle);
    }
    check(a->cap < (size_t)high && arr_sparse_len(a) > 0,
          "restricted ranges exercise sparse storage");
    scr_native_integrity_strengthen(a, levels[level]);
    ScrArr *result = op == 0 ? scr_arr_fill_ref(a, fill, high, high + 4)
        : op == 1 ? scr_arr_copy_within(a, high + 1, high, high + 3)
        : scr_arr_reverse(a);
    check(result == NULL, "partial sparse mutation returns no owned result");
    if (op == 0) {
      check_error(level == 2
          ? "TypeError: Cannot assign to read only property '2000000' of object '[object Array]'"
          : "TypeError: Cannot add property 2000002, object is not extensible");
      check(((MockRec *)scr_arr_peek_ref(a, high))->value == (level == 2 ? 1 : 9),
            "sparse fill keeps its first completed write");
      check(level == 2 ? scr_arr_state(a, high + 1) == SCR_ARR_UNDEFINED
          : ((MockRec *)scr_arr_peek_ref(a, high + 1))->value == 9,
          "sparse fill replaces a present undefined before the hole");
      check(((MockRec *)scr_arr_peek_ref(a, high + 3))->value == 3,
            "sparse fill stops before later references");
      mock_cyc_release(fill);
    } else if (op == 1) {
      check_error(level == 0
          ? "TypeError: Cannot add property 2000002, object is not extensible"
          : "TypeError: Cannot delete property '2000003' of [object Array]");
      check(((MockRec *)scr_arr_peek_ref(a, high))->value == 1 &&
            ((MockRec *)scr_arr_peek_ref(a, high + 1))->value == 2,
            "backward sparse copy stops before earlier sources");
      check(level == 0 ? !scr_arr_has(a, high + 3)
          : ((MockRec *)scr_arr_peek_ref(a, high + 3))->value == 3,
          "sparse copy preserves a completed deletion on later failure");
    } else {
      check_error(level == 0
          ? "TypeError: Cannot add property 1999999, object is not extensible"
          : level == 1 ? "TypeError: Cannot delete property '1' of [object Array]"
          : "TypeError: Cannot assign to read only property '0' of object '[object Array]'");
      check(((MockRec *)scr_arr_peek_ref(a, 0))->value == (level == 2 ? 1 : 3) &&
            ((MockRec *)scr_arr_peek_ref(a, high))->value == (level == 2 ? 3 : 1),
            "reverse keeps completed swaps across dense and sparse storage");
      check(level == 0 ? !scr_arr_has(a, 1)
          : ((MockRec *)scr_arr_peek_ref(a, 1))->value == 2,
          "reverse keeps a deletion before its failed sparse store");
      check(!scr_arr_has(a, high - 1), "failed reverse store leaves its sparse hole");
    }
    if (op != 2) {
      check(!scr_arr_has(a, high + 2) && scr_arr_next_present(a, 0) == high,
            "failed sparse ranges preserve holes outside completed writes");
    }
    check(a->len == (size_t)high + (op == 2 ? 1 : 4) && filled_ok(a),
          "partial sparse ranges preserve length and the filled prefix");
    scr_arr_release(result);
    scr_arr_release(a);
    scr_collect_cycles();
    check(mock_live == records && scr_arr_live_count() == arrays,
          "partial range cleanup releases all cyclic references");
    check(!scr_native_integrity_active(), "collected sparse arrays retire integrity metadata");
  }
}

static void test_integrity_splice_ownership(void) {
  long arrays = scr_arr_live_count(), records = mock_live;
  for (int sparse = 0; sparse < 2; sparse++) for (unsigned level = 0; level < 4; level++) {
    double base = sparse ? 2000000 : 0;
    ScrArr *a = scr_arr_new_ops(&mock_cyc_ops, 0);
    for (int i = 0; i < 3; i++) {
      MockRec *record = mock_cyc_new(i + 1);
      record->owner = scr_arr_retain(a);
      scr_arr_set_ref(a, base + i, record);
    }
    if (level) scr_native_integrity_strengthen(a, level == 1 ? SCR_NATIVE_NON_EXTENSIBLE
        : level == 2 ? SCR_NATIVE_SEALED : SCR_NATIVE_FROZEN);
    MockRec *insert = mock_cyc_new(9);
    insert->owner = scr_arr_retain(a);
    uint64_t slot = (uint64_t)(uintptr_t)insert;
    scr_arr_splice_drop(a, base, 2, 1, &slot);
    if (level < 2) {
      check(!scr_exc_pending() && a->len == (size_t)base + 2 && mock_live == records + 2,
            "successful discard splice consumes its inserted cyclic reference");
      check(((MockRec *)scr_arr_peek_ref(a, base))->value == 9 &&
            ((MockRec *)scr_arr_peek_ref(a, base + 1))->value == 3,
            "successful discard splice preserves the tail");
    } else if (level == 2) {
      check_error(sparse ? "TypeError: Cannot delete property '2000002' of [object Array]"
          : "TypeError: Cannot delete property '2' of [object Array]");
      check(a->len == (size_t)base + 3 && mock_live == records + 2 &&
            ((MockRec *)scr_arr_peek_ref(a, base))->value == 1 &&
            scr_arr_peek_ref(a, base + 1) == scr_arr_peek_ref(a, base + 2),
            "failed discard splice keeps tail writes and releases unused insertion");
    } else {
      check_error(sparse ? "TypeError: Cannot assign to read only property '2000001' of object '[object Array]'"
          : "TypeError: Cannot assign to read only property '1' of object '[object Array]'");
      check(a->len == (size_t)base + 3 && mock_live == records + 3,
            "early splice refusal releases all insertion arguments");
    }
    check(filled_ok(a), "splice preserves the filled prefix after partial mutation");
    if (sparse && level) {
      size_t length = a->len;
      long live = mock_live;
      slot = (uint64_t)(uintptr_t)mock_cyc_new(8);
      scr_arr_splice_drop(a, base, 0, 1, &slot);
      check_error(level == 1 ? "TypeError: Cannot add property 2000002, object is not extensible"
          : "TypeError: Cannot add property 2000003, object is not extensible");
      check(a->len == length && mock_live == live && filled_ok(a),
            "sparse growth refusal preserves its receiver and releases the unused argument");
    }
    scr_arr_release(a);
    scr_collect_cycles();
    check(mock_live == records && scr_arr_live_count() == arrays &&
          !scr_native_integrity_active(), "splice releases cyclic snapshots and pending arguments");
  }

  ScrArr *a = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_set_ref(a, 2000000, scr_str_new("tail", 4));
  scr_arr_set_len(a, 2000002);
  ScrArr *removed = scr_arr_splice_insert(a, 0, INFINITY, a);
  check(!scr_exc_pending() && a->len == 2000002 && removed->len == 2000002,
        "sparse self insertion snapshots the original length");
  check(scr_arr_state(removed, 0) == SCR_ARR_HOLE &&
        scr_arr_state(a, 0) == SCR_ARR_UNDEFINED &&
        scr_arr_state(a, 2000001) == SCR_ARR_UNDEFINED &&
        scr_arr_peek_ref(a, 2000000) == scr_arr_peek_ref(removed, 2000000),
        "self insertion materializes input holes but preserves removed holes");
  scr_arr_release(a);
  scr_native_integrity_strengthen(removed, SCR_NATIVE_FROZEN);
  ScrArr *empty = scr_arr_new(SCR_ELEM_STR, 0);
  ScrArr *copy = scr_arr_to_spliced(removed, 0, 2000000, empty);
  check(!scr_exc_pending() && copy->len == 2 &&
        scr_arr_peek_ref(copy, 0) == scr_arr_peek_ref(removed, 2000000) &&
        scr_arr_state(copy, 1) == SCR_ARR_UNDEFINED && removed->len == 2000002,
        "toSpliced reads frozen sparse inputs without mutating them");
  scr_arr_release(copy);
  scr_arr_release(empty);
  scr_arr_release(removed);
  check(scr_arr_live_count() == arrays && !scr_native_integrity_active(),
        "sparse self insertion and copying release their arrays");
}

static void test_integrity_extension_ownership(void) {
  long arrays = scr_arr_live_count(), records = mock_live;
  const size_t counts[] = {0, 1, 2, 64, 65};
  for (int prepend = 0; prepend < 2; prepend++) for (int sparse = 0; sparse < 2; sparse++)
    for (unsigned level = 0; level < 4; level++) for (size_t c = 0; c < 5; c++) {
      size_t count = counts[c], base = sparse ? 2000000 : 0;
      ScrArr *a = scr_arr_new_ops(&mock_cyc_ops, 128);
      MockRec *first = mock_cyc_new(1);
      first->owner = scr_arr_retain(a);
      scr_arr_set_ref(a, (double)base, first);
      scr_arr_set_len(a, (double)(base + 3)); /* trailing holes are moved before a present value */
      if (level) scr_native_integrity_strengthen(a, level == 1 ? SCR_NATIVE_NON_EXTENSIBLE
          : level == 2 ? SCR_NATIVE_SEALED : SCR_NATIVE_FROZEN);
      uint64_t slots[65];
      for (size_t i = 0; i < count; i++) {
        MockRec *record = mock_cyc_new((int)i + 2);
        record->owner = scr_arr_retain(a);
        slots[i] = (uint64_t)(uintptr_t)record;
      }
      double result = prepend ? scr_arr_unshift_many(a, count, slots) : scr_arr_push_many(a, count, slots);
      bool refused = level && (count || level == 3);
      if (refused) {
        char message[128];
        if (count) snprintf(message, sizeof message,
            "TypeError: Cannot add property %zu, object is not extensible",
            prepend ? base + count : base + 3);
        else snprintf(message, sizeof message,
            "TypeError: Cannot assign to read only property 'length' of object '[object Array]'");
        check_error(message);
        check(result == 0 && a->len == base + 3 && mock_live == records + 1,
              "extension refusal consumes every cyclic input before or after tail movement");
      } else {
        check(result == (double)(base + 3 + count) && !scr_exc_pending() &&
              mock_live == records + 1 + (long)count,
              "extension accepts the entire argument count and owns each value");
        check(scr_arr_peek_ref(a, (double)(base + (prepend ? count : 0))) == first,
              "extension preserves the original sparse or dense edge");
      }
      check(filled_ok(a), "extension preserves the filled prefix and hole states");
      scr_arr_release(a);
      scr_collect_cycles();
      check(mock_live == records && scr_arr_live_count() == arrays &&
            !scr_native_integrity_active(), "extension releases all cyclic argument and receiver owners");
    }
}

static void test_published_property_guards(void) {
  ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_undefined(a, 2);
  scr_native_integrity_strengthen(a, SCR_NATIVE_SEALED);
  scr_publish(a, integrity_publish_array);
  check(!scr_exc_pending() && a->rc == SIZE_MAX && !scr_native_integrity_flags(a),
        "publication replaces metadata");
  scr_arr_set_f64(a, 1, 9);
  check_error("TypeError: Cannot add property 1, object is not extensible");
  scr_arr_set_f64(a, -1, 9);
  check_error("TypeError: Cannot add property -1, object is not extensible");
  check(scr_arr_check_delete(a, 1) && !scr_exc_pending(),
        "published guard allows deleting an absent index");
  check(!scr_arr_check_set(a, 1), "published guard rejects adding a hole");
  check_error("TypeError: Cannot add property 1, object is not extensible");
  scr_arr_set_len(a, 3);
  check_error("TypeError: Cannot assign to read only property 'length' of object '[object Array]'");
  scr_arr_push_many(a, 0, NULL);
  check_error("TypeError: Cannot assign to read only property 'length' of object '[object Array]'");
  scr_arr_unshift_many(a, 0, NULL);
  check_error("TypeError: Cannot assign to read only property 'length' of object '[object Array]'");
  scr_arr_push_f64(a, 9);
  check_error("TypeError: Cannot add property 3, object is not extensible");
  double numbers[2] = {8, 9};
  uint64_t slots[2];
  memcpy(slots, numbers, sizeof slots);
  scr_arr_unshift_many(a, 2, slots);
  check_error("TypeError: Cannot add property 4, object is not extensible");
  ScrArr *copy = scr_arr_new(SCR_ELEM_F64, 0);
  check(scr_arr_push_spread(copy, a) == 3 && scr_arr_unshift_spread(copy, a) == 6 &&
        !scr_exc_pending() && a->len == 3 && !scr_arr_has(a, 0),
        "published sources can be borrowed by both extension methods");
  for (size_t i = 0; i < copy->len; i++)
    check(scr_arr_state(copy, (double)i) == SCR_ARR_UNDEFINED,
          "extension materializes holes from a published source");
  scr_arr_release(copy);
}

/* Differential presence/state matrix: Node supplies the independent oracle
 * in array.test.ts. All three representations take the same JS operations. */
static void integrity_print_contents(ScrArr *a, int kind) {
  for (size_t i = 0; i < a->len; i++) {
    double state = scr_arr_state(a, (double)i);
    if (state == SCR_ARR_HOLE) putchar('h');
    else if (state == SCR_ARR_UNDEFINED) putchar('u');
    else if (kind == 0) printf("%.0f", scr_arr_get_f64(a, (double)i));
    else if (kind == 1) putchar(scr_arr_get_bool(a, (double)i) ? '1' : '0');
    else fputs(((ScrStr *)scr_arr_peek_ref(a, (double)i))->data, stdout);
  }
}

static uint64_t integrity_value_slot(int kind, int value) {
  if (kind == 0) {
    double number = value;
    uint64_t slot;
    memcpy(&slot, &number, sizeof slot);
    return slot;
  }
  if (kind == 1) return value % 2 != 0;
  char text = (char)('0' + value);
  return (uint64_t)(uintptr_t)scr_str_new(&text, 1);
}

static int integrity_mutation_oracle(int mode) {
  bool removal = mode == 1;
  for (int kind = 0; kind < 3; kind++) for (size_t n = 0; n <= 4; n++) {
    size_t patterns = 1;
    for (size_t i = 0; i < n; i++) patterns *= 3;
    for (size_t pattern = 0; pattern < patterns; pattern++)
      for (unsigned level = 0; level < 4; level++) for (int op = 0; op < (mode == 4 ? 2 : mode == 3 ? 16 : mode == 2 ? 22 : removal ? 2 : 8); op++) {
        ScrArr *a = scr_arr_new(kind == 0 ? SCR_ELEM_F64 : kind == 1 ? SCR_ELEM_BOOL : SCR_ELEM_STR, n);
        scr_arr_set_len(a, (double)n);
        size_t digits = pattern;
        for (size_t i = 0; i < n; i++, digits /= 3) {
          if (digits % 3 == 1) scr_arr_set_undefined(a, (double)i);
          if (digits % 3 == 2) {
            if (kind == 0) scr_arr_set_f64(a, (double)i, (double)i + 1);
            else if (kind == 1) scr_arr_set_bool(a, (double)i, (i + 1) % 2 != 0);
            else {
              char value = (char)('1' + i);
              scr_arr_set_ref(a, (double)i, scr_str_new(&value, 1));
            }
          }
        }
        if (level) scr_native_integrity_strengthen(a, level == 1 ? SCR_NATIVE_NON_EXTENSIBLE
            : level == 2 ? SCR_NATIVE_SEALED : SCR_NATIVE_FROZEN);
        ScrArr *result = NULL;
        uint64_t removed = 0;
        uint8_t removed_state = SCR_ARR_HOLE;
        double extended = 0;
        if (mode == 4) {
          result = scr_arr_sort_primitive(a, op != 0);
        } else if (mode == 3) {
          bool prepend = op % 2 != 0;
          if (op < 2 || (op >= 4 && op < 6) || (op >= 12 && op < 14)) {
            size_t count = op < 2 ? 0 : op < 6 ? 2 : 65;
            uint64_t slots[65];
            for (size_t i = 0; i < count; i++)
              slots[i] = integrity_value_slot(kind, count == 2 ? (int)i + 8 : (int)(i % 9) + 1);
            extended = prepend ? scr_arr_unshift_many(a, count, slots) : scr_arr_push_many(a, count, slots);
          } else if (op < 4) {
            if (kind == 0) extended = prepend ? scr_arr_unshift_f64(a, 9) : scr_arr_push_f64(a, 9);
            else if (kind == 1) extended = prepend ? scr_arr_unshift_bool(a, true) : scr_arr_push_bool(a, true);
            else {
              ScrStr *text = scr_str_new("9", 1);
              extended = prepend ? scr_arr_unshift_ref(a, text) : scr_arr_push_ref(a, text);
            }
          } else {
            ScrArr *items = op == 8 || op == 9 ? a : scr_arr_new(a->elem, 0);
            if (op == 6 || op == 7) {
              uint64_t slot = integrity_value_slot(kind, 9);
              scr_arr_push_many(items, 1, &slot);
              scr_arr_set_undefined(items, 1);
              scr_arr_set_len(items, 3);
              slot = integrity_value_slot(kind, 8);
              scr_arr_push_many(items, 1, &slot);
            } else if (op >= 14) scr_arr_set_undefined(items, 0);
            extended = prepend ? scr_arr_unshift_spread(a, items) : scr_arr_push_spread(a, items);
            if (items != a) scr_arr_release(items);
          }
          if (!scr_exc_pending()) result = scr_arr_retain(a);
        } else if (mode == 2) {
          int action = op < 12 ? op : op - 12;
          double start = action == 3 ? -2 : action == 10 ? (double)n
              : (action == 2 || (action >= 5 && action <= 8)) ? 1 : 0;
          double count = action == 0 || action == 6 || action == 10 ? 0
              : action == 4 || action == 11 ? (double)n : action == 5 ? INFINITY
              : action == 8 ? 2 : 1;
          size_t add = action >= 6 && action <= 8 ? 1 : action == 9 ? 2 : 0;
          uint64_t slots[2];
          for (size_t i = 0; i < add; i++)
            slots[i] = integrity_value_slot(kind, action == 9 && i == 0 ? 8 : 9);
          if (op >= 12) {
            scr_arr_splice_drop(a, start, count, add, slots);
          } else if (action == 11) {
            result = scr_arr_splice_insert(a, start, count, a);
          } else if (add || action == 10) {
            ScrArr *items = scr_arr_new(a->elem, add + 1);
            scr_arr_push_many(items, add, slots);
            if (action == 10) scr_arr_set_undefined(items, 0);
            result = scr_arr_splice_insert(a, start, count, items);
            scr_arr_release(items);
          } else result = scr_arr_splice(a, start, count);
        } else if (removal) {
          removed_state = op == 0 ? scr_arr_pop_state(a, &removed) : scr_arr_shift_state(a, &removed);
          if (!scr_exc_pending()) result = scr_arr_retain(a);
        } else if (op == 0) result = scr_arr_reverse(a);
        else if (op == 1 || op == 2) {
          double start = op == 1 ? 0 : 1, end = op == 1 ? (double)n : 1;
          if (kind == 0) result = scr_arr_fill_f64(a, 9, start, end);
          else if (kind == 1) result = scr_arr_fill_bool(a, true, start, end);
          else {
            ScrStr *value = scr_str_new("9", 1);
            result = scr_arr_fill_ref(a, value, start, end);
            scr_str_release(value);
          }
        } else if (op == 3) result = scr_arr_fill_undefined(a, 1, (double)n - 1);
        else if (op == 4) result = scr_arr_copy_within(a, 0, 0, (double)n);
        else if (op == 5) result = scr_arr_copy_within(a, 1, 0, (double)n);
        else if (op == 6) result = scr_arr_copy_within(a, 0, 1, (double)n);
        else result = scr_arr_copy_within(a, -2, 0, (double)n - 1);
        printf("%d|%zu|%zu|%u|%d|", kind, n, pattern, level, op);
        bool threw = scr_exc_pending();
        if (threw) {
          check(result == NULL, "throwing range operation returns no owned result");
          check(mode != 3 || extended == 0, "failed extension returns an inert scalar");
          check(!removal || (removed_state == SCR_ARR_HOLE && removed == 0),
                "throwing removal leaves no transferred value");
          ScrCaught *caught = scr_exc_take();
          ScrStr *text = scr_caught_to_string(caught);
          printf("%s", text->data);
          scr_str_release(text);
          scr_caught_release(caught);
        } else {
          check(mode == 2 || (mode == 4 && op == 1) || result == a,
                "successful in-place operation returns the same array");
          fputs("ok", stdout);
          if (mode == 4) {
            check(op == 0 || result != a, "toSorted returns a fresh array");
            printf(":%zu:", result->len);
            integrity_print_contents(result, kind);
          } else if (mode == 3) printf(":%.0f", extended);
          else if (mode == 2 && op < 12) {
            check(result && result != a, "splice returns a fresh removed array");
            printf(":%zu:", result->len);
            integrity_print_contents(result, kind);
          } else if (removal) {
            putchar(':');
            if (removed_state != SCR_ARR_VALUE) putchar('u');
            else if (kind == 0) {
              double value;
              memcpy(&value, &removed, sizeof value);
              printf("%.0f", value);
            } else if (kind == 1) putchar(removed ? '1' : '0');
            else fputs(((ScrStr *)(uintptr_t)removed)->data, stdout);
          }
        }
        if (removal && removed_state == SCR_ARR_VALUE && kind == 2)
          scr_str_release((ScrStr *)(uintptr_t)removed);
        check(mode >= 2 || a->len == n - (removal && !threw && n > 0),
              "mutation changes length only after successful removal");
        check(filled_ok(a), "range operation preserves the filled prefix after success or refusal");
        scr_arr_release(result);
        printf("|%zu|", a->len);
        integrity_print_contents(a, kind);
        putchar('\n');
        scr_arr_release(a);
      }
  }
  check(!scr_native_integrity_active(), "range matrix releases all integrity identities");
  scr_collect_cycles();
  check(scr_arr_live_count() == 0 && scr_str_live_count() == 0,
        "range matrix releases every array and string");
  return failed ? 1 : 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--metadata-copy") == 0) {
    test_metadata_copy();
    fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
    return failed ? 1 : 0;
  }
  if (argc == 2 && strcmp(argv[1], "--indexed-storage") == 0) {
    test_indexed_storage_names();
    test_indexed_storage();
    fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
    return failed ? 1 : 0;
  }
  if (argc == 2 && strcmp(argv[1], "--named-metadata") == 0) {
    test_named_metadata_cycles();
    fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
    return failed ? 1 : 0;
  }
  if (argc == 2 && strcmp(argv[1], "--integrity-range-oracle") == 0) return integrity_mutation_oracle(0);
  if (argc == 2 && strcmp(argv[1], "--integrity-removal-oracle") == 0) return integrity_mutation_oracle(1);
  if (argc == 2 && strcmp(argv[1], "--integrity-splice-oracle") == 0) return integrity_mutation_oracle(2);
  if (argc == 2 && strcmp(argv[1], "--integrity-extend-oracle") == 0) return integrity_mutation_oracle(3);
  if (argc == 2 && strcmp(argv[1], "--integrity-sort-oracle") == 0) return integrity_mutation_oracle(4);
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
  test_dense_slots();
  test_typed_sort();
  test_dense_comparator_sort();
  test_sort_integrity_callbacks();
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
  test_ref_cycle();
  test_named_metadata_cycles();
  test_ref_truncate_cycle();
  test_ref_trace_storage_boundaries();
  test_join();
  test_sparse_holes();
  test_large_storage();
  test_bulk_reference_ownership();
  test_splice_drop();
  test_filled_prefix();
  test_bool_bytes();
  test_inline_slots();
  test_indexed_storage_names();
  test_indexed_storage();
  test_metadata_copy();

  test_integrity_properties();
  test_integrity_length();
  test_integrity_owned_refs();
  test_removal_owned_results();
  test_integrity_range_sparse_refs();
  test_integrity_splice_ownership();
  test_integrity_extension_ownership();
  test_published_property_guards();

  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed == 0 ? 0 : 1;
}
