#include "scr_runtime.h"

#include <stdlib.h>

/* The process-global retained-registration ledger. Format-4 script-thread
 * tables use the lock-free path in this always-linked unit. Format-5 foreign
 * tables install an optional teardown hook owned by scr_ffi_queue.c, keeping
 * all queue/thread machinery out of unrelated binaries. */
static ScrFfiTable *scr_ffi_tables;
static bool scr_ffi_exit_registered;

static void scr_ffi_oom(void) { scr_trap("scriptc: out of memory\n"); }

void scr_ffi_link(ScrFfiTable *table) {
  if (!table->linked) {
    table->linked = true;
    table->next = scr_ffi_tables;
    scr_ffi_tables = table;
  }
  if (!scr_ffi_exit_registered) {
    scr_ffi_exit_registered = true;
    scr_atexit(scr_ffi_teardown_all);
  }
}

void scr_ffi_teardown(ScrFfiTable *table) {
  if (table->teardown != NULL) {
    table->teardown(table);
    return;
  }
  /* Disarm the raw trampoline slot FIRST: a closure release below cannot
   * run script code today, but the slot must never dangle over freed
   * entries — a native exit-path invocation takes the NULL trap instead. */
  if (table->slot != NULL) *table->slot = NULL;
  for (size_t i = 0; i < table->len; i++) {
    scr_closure_release(table->entries[i]);
  }
  free(table->entries);
  table->entries = NULL;
  table->len = 0;
  table->cap = 0;
}

void scr_ffi_teardown_all(void) {
  for (ScrFfiTable *table = scr_ffi_tables; table != NULL; table = table->next) {
    scr_ffi_teardown(table);
  }
}

void scr_ffi_retain(ScrFfiTable *table, ScrClosure *callback) {
  scr_ffi_link(table);
  if (table->len == table->cap) {
    size_t cap = table->cap == 0 ? 4 : table->cap * 2;
    if (cap < table->cap || cap > SIZE_MAX / sizeof *table->entries) scr_ffi_oom();
    ScrClosure **entries = realloc(table->entries, cap * sizeof *entries);
    if (entries == NULL) scr_ffi_oom();
    table->entries = entries;
    table->cap = cap;
  }
  table->entries[table->len++] = scr_closure_retain(callback);
}

/* Raw singleton registration runs in two halves around the native set
 * call. The first half pins the incoming closure and records the slot,
 * but leaves the CURRENT registration untouched: a native setter may
 * flush the outgoing callback one last time mid-replace, and it must
 * dispatch a live closure. An empty slot arms immediately so a native
 * fire-on-subscribe during the set call reaches the new closure. */
void scr_ffi_retain_slot(ScrFfiTable *table, ScrClosure **slot, ScrClosure *callback) {
  table->slot = slot;
  scr_ffi_retain(table, callback);
  if (*slot == NULL) *slot = callback;
}

/* The second half, after the native call returns: point the slot at the
 * new registration and retire every pin it superseded. A callback pumped
 * during the native call may have released or replaced this registration
 * already (nested rawSet/rawRemove) — commit only a still-live entry. */
void scr_ffi_commit_slot(ScrFfiTable *table, ScrClosure *callback) {
  bool live = false;
  for (size_t i = 0; i < table->len; i++) {
    if (table->entries[i] == callback) {
      live = true;
      break;
    }
  }
  if (!live) return;
  *table->slot = callback;
  bool kept = false;
  size_t i = 0;
  while (i < table->len) {
    ScrClosure *entry = table->entries[i];
    if (entry == callback && !kept) {
      kept = true;
      i++;
      continue;
    }
    /* Swap-remove BEFORE releasing so the table stays consistent while
     * the release runs; the swapped-in tail entry is re-examined at i. */
    table->len--;
    table->entries[i] = table->entries[table->len];
    scr_closure_release(entry);
  }
}

/* Pre-call validation for an explicit release: emitted before the native
 * removal call, so releasing an unregistered value traps before native
 * code can act on the bogus pointer pair. */
void scr_ffi_require(ScrFfiTable *table, ScrClosure *callback) {
  for (size_t i = 0; i < table->len; i++) {
    if (table->entries[i] == callback) return;
  }
  scr_trap("scriptc: releasing a native callback registration that does not exist\n");
}

void scr_ffi_release(ScrFfiTable *table, ScrClosure *callback) {
  for (size_t i = 0; i < table->len; i++) {
    if (table->entries[i] != callback) continue;
    ScrClosure *owned = table->entries[i];
    table->len--;
    if (i != table->len) table->entries[i] = table->entries[table->len];
    /* If the raw slot dispatched to this registration and no duplicate
     * pin remains, disarm it — the trampoline must not reach a released
     * closure. */
    if (table->slot != NULL && *table->slot == callback) {
      bool remaining = false;
      for (size_t j = 0; j < table->len; j++) {
        if (table->entries[j] == callback) {
          remaining = true;
          break;
        }
      }
      if (!remaining) *table->slot = NULL;
    }
    scr_closure_release(owned);
    return;
  }
  scr_trap("scriptc: releasing a native callback registration that does not exist\n");
}
