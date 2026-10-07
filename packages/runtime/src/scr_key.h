/* Internal key hashing and canonical array-index ordering shared by native
 * maps and checked objects. Hashes never escape into JavaScript values. */
#ifndef SCR_KEY_H
#define SCR_KEY_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static inline uint64_t scr_key_mix(uint64_t value) {
  value ^= value >> 30;
  value *= UINT64_C(0xbf58476d1ce4e5b9);
  value ^= value >> 27;
  value *= UINT64_C(0x94d049bb133111eb);
  return value ^ (value >> 31);
}

/* Pack at most eight bytes with fixed-size, unaligned loads. The overlapping
 * ends cover every byte at lengths four through eight; the three selected
 * bytes cover lengths one through three. No terminator or padding is read. */
static inline uint64_t scr_key_short_word(const char *bytes, size_t length) {
  if (length >= 4) {
    uint32_t first, last;
    memcpy(&first, bytes, sizeof first);
    memcpy(&last, bytes + length - sizeof last, sizeof last);
    return ((uint64_t)first << 32) | last;
  }
  if (length == 0) return 0;
  return ((uint64_t)(unsigned char)bytes[0] << 16) |
         ((uint64_t)(unsigned char)bytes[length / 2] << 8) |
         (unsigned char)bytes[length - 1];
}

/* Callers check equal lengths first. Short keys need no out-of-line memcmp;
 * longer keys keep the platform's bulk comparison. */
static inline bool scr_key_equal(const char *a, const char *b, size_t length) {
  if (a == b) return true;
  if (length <= 8) return scr_key_short_word(a, length) == scr_key_short_word(b, length);
  return memcmp(a, b, length) == 0;
}

/* Unaligned loads stay inside the input. Hashing is process-local, so host
 * byte order is immaterial; equal byte strings always follow the same path.
 * Short keys need one avalanche and no variable-size tail copy. */
static inline uint64_t scr_key_hash(const char *bytes, size_t length) {
  uint64_t hash = UINT64_C(0x9e3779b97f4a7c15) ^ length;
  if (length <= 8) return scr_key_mix(hash ^ scr_key_short_word(bytes, length));
  size_t i = 0;
  while (length - i >= sizeof(uint64_t)) {
    uint64_t word;
    memcpy(&word, bytes + i, sizeof word);
    hash = scr_key_mix(hash ^ word);
    i += sizeof word;
  }
  return scr_key_mix(hash ^ scr_key_short_word(bytes + i, length - i));
}

static inline bool scr_key_array_index(const char *key, size_t length, uint32_t *out) {
  if (length == 0 || length > 10 || (length > 1 && key[0] == '0')) return false;
  uint64_t value = 0;
  for (size_t i = 0; i < length; i++) {
    if (key[i] < '0' || key[i] > '9') return false;
    value = value * 10 + (unsigned)(key[i] - '0');
  }
  if (value >= UINT32_MAX) return false;
  *out = (uint32_t)value;
  return true;
}

typedef struct {
  uint32_t index;
  size_t entry;
} ScrKeyIndex;

static inline int scr_key_index_compare(const void *left, const void *right) {
  uint32_t a = ((const ScrKeyIndex *)left)->index;
  uint32_t b = ((const ScrKeyIndex *)right)->index;
  return (a > b) - (a < b);
}

/* Keys are unique. Already ordered inputs need no sort, while arbitrary
 * numeric property insertion must not require quadratic enumeration. */
static inline void scr_key_index_sort(ScrKeyIndex *keys, size_t count) {
  for (size_t i = 1; i < count; i++) {
    if (keys[i - 1].index > keys[i].index) {
      qsort(keys, count, sizeof *keys, scr_key_index_compare);
      return;
    }
  }
}
#endif
