/* WeakRef (scr_weakref.c) driven the way the emitted program drives it:
 * the same dispose hook a freed dyn node and a freed native record reach,
 * the kept list's clear job in place of the microtask queue, and one cycle
 * collection to flush a parked capsule. Every check prints a line to
 * stdout, which scr_weakref.test.ts compares.
 *
 * The differential corpus pins only the deterministic cases (a target held
 * elsewhere, identity, the TypeError, rendering), because collection
 * timing is not observable in a portable program. This unit test pins the
 * clearing itself. */
#undef NDEBUG
#include "scr_runtime.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void check(bool condition, const char *what) {
  if (!condition) {
    fprintf(stderr, "FAIL %s\n", what);
    abort();
  }
  printf("ok %s\n", what);
}

/* A native record with an emitted-style release: the dispose hook runs on
 * the freeing release, before the storage goes away. */
typedef struct Node {
  size_t refs;
  double value;
} Node;

static void *node_retain(void *ptr) {
  ((Node *)ptr)->refs++;
  return ptr;
}

static void node_release(void *ptr) {
  Node *node = ptr;
  if (--node->refs) return;
  scr_weak_dispose_inline(node);
  free(node);
}

static Node *node_new(double value) {
  Node *node = calloc(1, sizeof *node);
  if (!node) abort();
  node->refs = 1;
  node->value = value;
  return node;
}

int main(void) {
  /* ── a plain object target ─────────────────────────────────────────── */
  ScrDyn *target = scr_dyn_new_obj();
  ScrDyn *ref = scr_weakref_new(target); /* borrowed, as a libCall passes it */
  check(scr_weakref_is(ref), "the constructor answers a WeakRef handle");
  check(!scr_weakref_is(target), "a plain object is not a WeakRef");

  ScrDyn *got = scr_weakref_deref(ref);
  check(got == target, "deref answers the target while the heap keeps it");
  scr_dyn_release(got);

  /* End of the job (ClearKeptObjects), then the only strong reference goes:
   * the heap frees the target and the cell clears. */
  scr_weakref_test_end_job();
  scr_dyn_release(target);
  got = scr_weakref_deref(ref);
  check(got->kind == SCR_DYN_UNDEF, "deref answers undefined once the target is freed");
  scr_dyn_release(got);
  scr_dyn_release(ref);

  /* ── a checked-native capsule target ───────────────────────────────── */
  Node *node = node_new(41);
  ScrDyn *capsule =
      scr_dyn_new_typed_ref_observed(node, node_retain, node_release, "Node", 4, NULL, NULL);
  ScrDyn *recordRef = scr_weakref_new(capsule);
  got = scr_weakref_deref(recordRef);
  check(got->kind == SCR_DYN_TYPED_REF, "deref rebuilds the capsule, not a snapshot");
  Node *unboxed = scr_dyn_typed_ref_unbox(got);
  check(unboxed == node, "the rebuilt capsule unboxes to the same record");
  node_release(unboxed);
  scr_dyn_release(got);
  /* The test's own reference goes: the capsule holds the record alone. */
  node_release(node);

  /* A released capsule with nothing but its referent is parked until the
   * next collector pass, which releases the record and clears the cell. */
  scr_weakref_test_end_job();
  scr_dyn_release(capsule);
  scr_collect_cycles();
  got = scr_weakref_deref(recordRef);
  check(got->kind == SCR_DYN_UNDEF, "deref answers undefined once the record is freed");
  scr_dyn_release(got);
  scr_dyn_release(recordRef);

  /* No live cell is left in the table. */
  check(scr_weakref_live == 0, "cleared cells leave the table");

  /* ── the target check ──────────────────────────────────────────────── */
  ScrDyn *fresh = scr_dyn_new_obj();
  check(scr_weakref_is(fresh) == false, "a fresh object is not a WeakRef");
  scr_dyn_release(fresh);
  return 0;
}
