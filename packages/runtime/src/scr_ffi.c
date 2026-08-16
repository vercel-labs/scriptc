#include "scr_runtime.h"

#include <stdlib.h>

/* Retained callbacks are same-thread only in format 4, so the registration
 * ledger deliberately has no synchronization. The global list exists only
 * to make every still-live registration release before the executable RC
 * audit. A table remains linked after an explicit teardown so a later
 * registration can reuse it without mutating the list twice. */
static ScrFfiTable *scr_ffi_tables;
static bool scr_ffi_exit_registered;

static void scr_ffi_oom(void) { scr_trap("scriptc: out of memory\n"); }

void scr_ffi_teardown(ScrFfiTable *table) {
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
  if (!table->linked) {
    table->linked = true;
    table->next = scr_ffi_tables;
    scr_ffi_tables = table;
  }
  if (!scr_ffi_exit_registered) {
    scr_ffi_exit_registered = true;
    scr_atexit(scr_ffi_teardown_all);
  }
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

void scr_ffi_release(ScrFfiTable *table, ScrClosure *callback) {
  for (size_t i = 0; i < table->len; i++) {
    if (table->entries[i] != callback) continue;
    ScrClosure *owned = table->entries[i];
    table->len--;
    if (i != table->len) table->entries[i] = table->entries[table->len];
    scr_closure_release(owned);
    return;
  }
  scr_trap("scriptc: releasing a native callback registration that does not exist\n");
}
