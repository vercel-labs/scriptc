/* Per-thread slots (ThreadSlots, @scriptc/experimental): see scr_slots.h. */

#include "scr_runtime.h"

#include <stdatomic.h>
#include <stdlib.h>

void *const scr_slots_none[SCR_SLOTS_PAGE] = {0};

/* The next slot index to assign. 0 means "no index". */
static _Atomic uint32_t scr_slots_next = 1;

/* This thread's blocks that hold or held values, and whether their release
 * at thread exit is registered. */
static SCR_TL ScrSlots *scr_slots_blocks;
static SCR_TL bool scr_slots_exit_registered;

static _Noreturn void scr_slots_oom(void) { scr_trap("scriptc: out of memory\n"); }

/* A page's entries follow its count of non-NULL entries. */
static inline uintptr_t *scr_slots_count(void **page) { return (uintptr_t *)page - 1; }

/* The slot index of the key `obj` with slot word `word`, assigned on first
 * use. A published key may be read by every thread, so its index is set
 * once with a compare-and-swap and every thread uses the winner's. An
 * unpublished key is reachable from this thread only. */
static uint32_t scr_slots_index(void *obj, uint32_t *word) {
  uint32_t index = __atomic_load_n(word, __ATOMIC_RELAXED);
  if (index != 0) return index;
  index = atomic_fetch_add_explicit(&scr_slots_next, 1, memory_order_relaxed);
  if (index == 0) scr_trap("scriptc: ThreadSlots ran out of slot indices\n");
  if (SCR_RC_COUNT(obj) != SCR_RC_IMMORTAL) {
    __atomic_store_n(word, index, __ATOMIC_RELAXED);
    return index;
  }
  uint32_t expected = 0;
  if (__atomic_compare_exchange_n(word, &expected, index, false, __ATOMIC_RELAXED,
                                  __ATOMIC_RELAXED))
    return index;
  return expected;
}

/* Releases the values of every block of this thread and frees their
 * pages, leaving the blocks as a later first set finds them. A released
 * value can free a key, whose scr_slots_forget then finds an already
 * emptied block. */
static void scr_slots_thread_exit(void) {
  if (!scr_exit_frees()) return;
  ScrSlots *blocks = scr_slots_blocks;
  scr_slots_blocks = NULL;
  scr_slots_exit_registered = false;
  for (ScrSlots *s = blocks, *next; s != NULL; s = next) {
    next = s->next;
    void ***pages = s->pages;
    uint32_t npages = s->npages;
    s->pages = NULL;
    s->npages = 0;
    s->registered = 0;
    s->next = NULL;
    for (uint32_t p = 0; p < npages; p++) {
      void **page = pages[p];
      if (page == (void **)scr_slots_none) continue;
      for (uint32_t i = 0; i < SCR_SLOTS_PAGE; i++)
        if (page[i] != NULL) s->release(page[i]);
      free(scr_slots_count(page));
    }
    free(pages);
  }
}

static void scr_slots_register(ScrSlots *s, void (*release)(void *)) {
  s->release = release;
  s->registered = 1;
  s->next = scr_slots_blocks;
  scr_slots_blocks = s;
  if (!scr_slots_exit_registered) {
    scr_slots_exit_registered = true;
    scr_atexit(scr_slots_thread_exit);
  }
}

/* The page holding `index`, created when absent. */
static void **scr_slots_page(ScrSlots *s, uint32_t index) {
  uint32_t p = index >> SCR_SLOTS_PAGE_BITS;
  if (p >= s->npages) {
    uint32_t n = s->npages ? s->npages : 4;
    while (n <= p) n = n > UINT32_MAX / 2 ? (UINT32_MAX >> SCR_SLOTS_PAGE_BITS) + 1 : n * 2;
    void ***pages = realloc(s->pages, (size_t)n * sizeof *pages);
    if (!pages) scr_slots_oom();
    for (uint32_t i = s->npages; i < n; i++) pages[i] = (void **)scr_slots_none;
    s->pages = pages;
    s->npages = n;
  }
  void **page = s->pages[p];
  if (page == (void **)scr_slots_none) {
    uintptr_t *block = calloc(SCR_SLOTS_PAGE + 1, sizeof(void *));
    if (!block) scr_slots_oom();
    page = (void **)(block + 1);
    s->pages[p] = page;
  }
  return page;
}

/* Takes the entry `index` out of `s`; returns its value, or NULL. The
 * page goes when its last entry does. */
static void *scr_slots_take(ScrSlots *s, uint32_t index) {
  uint32_t p = index >> SCR_SLOTS_PAGE_BITS;
  if (p >= s->npages) return NULL;
  void **page = s->pages[p];
  void **entry = &page[index & (SCR_SLOTS_PAGE - 1)];
  void *value = *entry;
  if (value == NULL) return NULL;
  *entry = NULL;
  if (--*scr_slots_count(page) == 0) {
    free(scr_slots_count(page));
    s->pages[p] = (void **)scr_slots_none;
  }
  return value;
}

void scr_slots_set(ScrSlots *s, void *obj, uint32_t *word, void *value, void (*release)(void *)) {
  if (!s->registered) scr_slots_register(s, release);
  uint32_t index = scr_slots_index(obj, word);
  void **page = scr_slots_page(s, index);
  void **entry = &page[index & (SCR_SLOTS_PAGE - 1)];
  void *old = *entry;
  *entry = value;
  if (old == NULL) ++*scr_slots_count(page);
  else s->release(old);
}

bool scr_slots_delete(ScrSlots *s, const uint32_t *word) {
  uint32_t index = __atomic_load_n(word, __ATOMIC_RELAXED);
  void *old = index ? scr_slots_take(s, index) : NULL;
  if (old == NULL) return false;
  s->release(old);
  return true;
}

void scr_slots_forget(uint32_t index) {
  for (ScrSlots *s = scr_slots_blocks; s != NULL; s = s->next) {
    void *old = scr_slots_take(s, index);
    if (old != NULL) s->release(old);
  }
}
