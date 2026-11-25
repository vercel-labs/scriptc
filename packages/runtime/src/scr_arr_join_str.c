/* `parts.join(separator)` where the compiler knows the elements are strings:
 * the one typed entry of Array.prototype.join. An optional unit, linked only
 * into programs that hold such a join (the link feature arrJoinStr, which the
 * compiler derives from the join's receiver type), so a program that joins
 * numbers, or that reaches scr_arr_join only through another runtime unit,
 * links nothing of it and every other program keeps the default runtime
 * objects byte for byte.
 *
 * A hole-free string array is joined here in two passes. Every other array
 * the type admits at run time (holes, present undefined, a sparse tail,
 * foreign elements stored through a dynamic view) goes to scr_arr_join,
 * which joins it element by element. */
#include "scr_runtime.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* The join fills its result from the end to the start, so a short piece is
 * one fixed-size move of the SCR_JOIN_STEP bytes that end with it, whatever
 * its length. The bytes such a move reads before the piece's text are the
 * piece's own header, and the bytes it writes before the piece's place
 * belong to pieces written after it, or to the result's header words after
 * rc, which the join saves and restores. */
#define SCR_JOIN_STEP (sizeof(size_t) > 4 ? (size_t)16 : (size_t)8)
_Static_assert(offsetof(ScrStr, data) - offsetof(ScrStr, len) >= SCR_JOIN_STEP,
               "a join move must stay inside a string's header words after rc");

static inline const ScrStr *scr_join_slot(uint64_t slot) { return (const ScrStr *)(uintptr_t)slot; }

/* A string's capacity word (scr_string.h). SCR_STR_ASCII_BIT of it is the
 * proven-ASCII fact, so the and of many strings' words holds the fact for
 * all of them. */
static inline size_t scr_join_cap_word(const ScrStr *s) {
  size_t word;
  memcpy(&word, (const char *)s + offsetof(ScrStr, data) - sizeof word, sizeof word);
  return word;
}

/* Copy the `len` bytes of a string's text so that they end at `end`;
 * returns where they start. */
static inline char *scr_join_put(char *end, const ScrStr *s, size_t len) {
  const char *text = (const char *)s + offsetof(ScrStr, data);
  char *start = end - len;
  if (__builtin_expect(len <= SCR_JOIN_STEP, 1)) {
    memcpy(end - SCR_JOIN_STEP, text + len - SCR_JOIN_STEP, SCR_JOIN_STEP);
  } else if (len <= 2 * SCR_JOIN_STEP) {
    memcpy(start, text, SCR_JOIN_STEP);
    memcpy(end - SCR_JOIN_STEP, text + len - SCR_JOIN_STEP, SCR_JOIN_STEP);
  } else {
    memcpy(start, text, len);
  }
  return start;
}

/* The element in slot `i` of a string array, placed to end at `end`; a NULL
 * slot (a null or undefined element) joins as the empty string. */
static inline char *scr_join_put_slot(char *end, const uint64_t *slots, size_t i) {
  const ScrStr *s = scr_join_slot(slots[i]);
  return __builtin_expect(s != NULL, 1) ? scr_join_put(end, s, s->len) : end;
}

/* One pass over the lengths and the proven-ASCII bits the strings already
 * store sizes the result exactly, then one pass copies the pieces. An empty
 * separator and a one-byte separator have loops of their own, so neither
 * looks at the separator per element. Only a piece starting with a lone low
 * surrogate can complete a pair across its seam, and no such piece is
 * proven ASCII. */
ScrStr *scr_arr_join_str(ScrArr *a, ScrStr *sep) {
  /* `filled == len` says every index below the length holds a value in
   * dense storage (scr_array.h). */
  if (__builtin_expect(a->elem != SCR_ELEM_STR || a->filled != a->len, 0))
    return scr_arr_join(a, sep);
  const size_t limit = SIZE_MAX - sizeof(ScrStr) - 1;
  const uint64_t *slots = a->data;
  size_t n = a->len, sep_len = sep->len;
  if (n > 1 && sep_len > limit / (n - 1)) scr_trap("scriptc: out of memory\n");
  size_t total = n > 1 ? (n - 1) * sep_len : 0, carries = 0;
  size_t facts = n > 1 ? scr_join_cap_word(sep) : SCR_STR_ASCII_BIT;
  for (size_t i = 0; i < n; i++) {
    const ScrStr *s = scr_join_slot(slots[i]);
    if (__builtin_expect(s != NULL, 1)) {
      total += s->len;
      carries += total < s->len;
      facts &= scr_join_cap_word(s);
    }
  }
  if (carries || total > limit) scr_trap("scriptc: out of memory\n");
  bool ascii = (facts & SCR_STR_ASCII_BIT) != 0, lead_low = false;
  if (!ascii && __builtin_expect(scr_wtf8_any(), 0)) {
    lead_low = n > 1 && scr_wtf8_low_at(sep->data);
    for (size_t i = 0; i < n; i++) {
      const ScrStr *s = scr_join_slot(slots[i]);
      if (s) lead_low |= scr_wtf8_low_at(s->data);
    }
  }
  ScrStr *out = scr_str_alloc_raw(total, total);
  char *header = (char *)out + offsetof(ScrStr, len);
  char saved[offsetof(ScrStr, data) - offsetof(ScrStr, len)];
  memcpy(saved, header, sizeof saved);
  char *w = (char *)out + offsetof(ScrStr, data) + total;
  *w = '\0';
  size_t i = n;
  if (i > 0) w = scr_join_put_slot(w, slots, --i);
  if (sep_len == 0) {
    while (i > 0) w = scr_join_put_slot(w, slots, --i);
  } else if (sep_len == 1) {
    char c = sep->data[0];
    while (i > 0) {
      *--w = c;
      w = scr_join_put_slot(w, slots, --i);
    }
  } else {
    while (i > 0) {
      w = scr_join_put(w, sep, sep_len);
      w = scr_join_put_slot(w, slots, --i);
    }
  }
  memcpy(header, saved, sizeof saved);
  if (lead_low) scr_str_fuse_surrogates(out);
  else if (ascii) scr_str_note_ascii(out);
  return out;
}
