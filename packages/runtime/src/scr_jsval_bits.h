/* scriptc runtime — the jsval word encoding, apart from the dynamic-tier
 * API that uses it (scr_js.h).
 *
 * A layout-mode object slot holds one jsval word (scr_dyn.h), and scr_json.c
 * — the unit that owns dynamic values — reads and writes those words. That
 * unit cannot include scr_js.h (only the js units of the dynamic tier may;
 * scr_js.h itself says why), and it must not link a js unit either: a
 * program that boxes a plain value into the checked-dynamic tree can link
 * scr_json.c without linking any js unit. So the encoding lives here, as
 * bit patterns and the three predicates that tell a word's kind, and both
 * scr_js.h and scr_json.c include this header. The inline functions take and
 * return void *, which is what a jsval is spelled as on the C side; a
 * ScrDyn * converts to one implicitly in C.
 *
 * The encoding is documented in scr_js.h. On a 32-bit target a pointer
 * cannot hold a double's bits, so a jsval there is a ScrDyn cell pointer and
 * these predicates say so: every word is a cell, and no word is a double. */
#ifndef SCR_JSVAL_BITS_H
#define SCR_JSVAL_BITS_H

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#if UINTPTR_MAX > 0xFFFFFFFFu

/* Targets with 64-bit pointers: NaN-boxed immediates. */
#define SCR_JSVAL_WORDS 1
#define SCR_JSVAL_TAG_SHIFT 48
#define SCR_JSVAL_TAG_SPECIAL UINT64_C(0xFFF9)
#define SCR_JSVAL_TAG_CELL UINT64_C(0xFFFA)
#define SCR_JSVAL_TAG_STR UINT64_C(0xFFFB)
#define SCR_JSVAL_TAG_BIGINT UINT64_C(0xFFFC)
#define SCR_JSVAL_DOUBLE_LIMIT (SCR_JSVAL_TAG_SPECIAL << SCR_JSVAL_TAG_SHIFT)
#define SCR_JSVAL_PAYLOAD_MASK ((UINT64_C(1) << SCR_JSVAL_TAG_SHIFT) - 1)
#define SCR_JSVAL_CANONICAL_NAN UINT64_C(0x7FF8000000000000)

static inline uint64_t scr_jsval_bits(const void *word) { return (uint64_t)(uintptr_t)word; }
/* Words below the special tag are doubles (the descriptive bits itself). */
static inline bool scr_jsval_is_double(const void *word) {
  return scr_jsval_bits(word) < SCR_JSVAL_DOUBLE_LIMIT;
}
static inline uint64_t scr_jsval_tag(const void *word) {
  return scr_jsval_bits(word) >> SCR_JSVAL_TAG_SHIFT;
}
/* A cell tag over a dynamic value: what a slot stores for every non-number
 * that is not one of the primitive immediates. */
static inline bool scr_jsval_is_cell(const void *word) {
  return scr_jsval_tag(word) == SCR_JSVAL_TAG_CELL;
}
static inline void *scr_jsval_cell(const void *word) {
  return (void *)(uintptr_t)(scr_jsval_bits(word) & SCR_JSVAL_PAYLOAD_MASK);
}
static inline void *scr_jsval_of_bits(uint64_t bits) { return (void *)(uintptr_t)bits; }
static inline double scr_jsval_double(const void *word) {
  double d;
  uint64_t bits = scr_jsval_bits(word);
  memcpy(&d, &bits, sizeof d);
  return d;
}
static inline void *scr_jsval_of_cell(const void *cell) {
  return scr_jsval_of_bits((SCR_JSVAL_TAG_CELL << SCR_JSVAL_TAG_SHIFT) |
                           (uint64_t)(uintptr_t)cell);
}

#else

/* 32-bit targets: every jsval is a dynamic value's cell pointer. */
#define SCR_JSVAL_WORDS 0

static inline bool scr_jsval_is_double(const void *word) {
  (void)word;
  return false;
}
static inline bool scr_jsval_is_cell(const void *word) { return word != NULL; }
static inline void *scr_jsval_cell(const void *word) { return (void *)word; }

#endif

#endif
