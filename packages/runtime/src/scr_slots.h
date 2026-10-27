/* scriptc runtime — per-thread slots (scr_slots.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_SLOTS_H
#define SCR_SLOTS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* ── per-thread slots (scr_slots.c) ───────────────────────────────────
 * ThreadSlots (@scriptc/experimental): a family of per-thread values keyed
 * by class instances. Each instance of a class used as a key carries a
 * 32-bit slot word, 0 until a value is first set for it on any thread.
 * Setting assigns the word an index that is unique in the process and
 * never reused; a published instance, which every thread may read, gets
 * its index with a compare-and-swap, so all threads agree on it.
 *
 * Each family has one ScrSlots block per thread (an emitted thread-local
 * global). The block maps indices to that thread's values through pages
 * of SCR_SLOTS_PAGE entries, so a read is the slot word, the page and the
 * entry, with no hashing, lock or atomic read-modify-write:
 *
 *     page = word >> SCR_SLOTS_PAGE_BITS < npages ? pages[word >> BITS] : none
 *     value = page[word & (SCR_SLOTS_PAGE - 1)]
 *
 * Absent pages point at a shared page of NULL entries, and index 0 is
 * never assigned, so a word of 0 reads NULL. The emitted read inlines
 * this (llvm/thread-slots.ts); scr_slots_get is the same read in C.
 *
 * A block holds one reference to each value it stores. Values belong to
 * the thread: the block releases them when they are replaced or deleted,
 * when their key is freed (scr_slots_forget, called by the key class's
 * free path), and when the thread exits. */

#define SCR_SLOTS_PAGE_BITS 10
#define SCR_SLOTS_PAGE (1u << SCR_SLOTS_PAGE_BITS)

/* The emitted layout is `{ ptr, i32, i32, ptr, ptr }`. */
typedef struct ScrSlots {
  void ***pages; /* npages entries; scr_slots_none where unset */
  uint32_t npages;
  uint32_t registered; /* on this thread's list of blocks */
  void (*release)(void *);
  struct ScrSlots *next;
} ScrSlots;

/* The page that absent pages point at. */
extern void *const scr_slots_none[SCR_SLOTS_PAGE];

/* This thread's value for the key whose slot word is `word`, borrowed, or
 * NULL. */
static inline void *scr_slots_get(const ScrSlots *s, const uint32_t *word) {
  uint32_t index = __atomic_load_n(word, __ATOMIC_RELAXED);
  uint32_t page = index >> SCR_SLOTS_PAGE_BITS;
  if (page >= s->npages) return NULL;
  return s->pages[page][index & (SCR_SLOTS_PAGE - 1)];
}

/* Stores `value` (one reference, moved in) for the key `obj`, whose slot
 * word is `word`, and releases the value it replaces. `release` releases a
 * value of the family's type. */
void scr_slots_set(ScrSlots *s, void *obj, uint32_t *word, void *value, void (*release)(void *));

/* Removes and releases this thread's value for the key; false when there
 * was none. */
bool scr_slots_delete(ScrSlots *s, const uint32_t *word);

/* The key with slot index `index` is being freed: releases its values in
 * every block of the calling thread. Only the thread that owns an
 * unpublished key can hold values for it. */
void scr_slots_forget(uint32_t index);

#endif /* SCR_SLOTS_H */
