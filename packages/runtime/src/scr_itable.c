/* Shared intern tables (@scriptc/experimental InternTable); the contract is
 * in scr_itable.h.
 *
 * A table is SCR_ITABLE_SEGMENTS independent segments. The top bits of a
 * key's 64-bit hash pick the segment and the low bits the first slot of a
 * linear probe in the segment's index. Number tables keep each key and its
 * value in the index slot itself, so a lookup touches one slot per probe.
 * String and array tables keep entries (value, hash and key bytes) in
 * chunks owned by the segment; their slots hold the entry pointer with a
 * tag of hash bits 50..57 in bits 48..55, so a probe reads an entry only
 * when the tags match. An array key is stored as one byte string that
 * encodes its elements (scr_itable_encode), so array keys compare by
 * their elements; keys longer or larger than a table accepts are refused
 * with a TypeError before anything is encoded.
 *
 * Readers load the segment's index pointer, then slots with acquire order,
 * and never write. Writers hold the segment's lock: they probe again, grow
 * the index when an insert would fill more than half of it, fill in the
 * value (and the entry), and store the slot's last word with release order.
 * A grown index is complete before its pointer is stored with release
 * order, and a reader that still holds the previous one sees every key
 * stored before the growth. A replaced index is retired and freed once no
 * thread can still be probing it (see "retired indexes" below).
 *
 * Tables, their entries and their current indexes are never freed. Every
 * such allocation is reachable from the static registry, so leak checkers
 * report none of it. */

#include "scr_runtime.h"
#include "scr_itable.h"
#include "scr_key.h"

#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#include <windows.h>
#elif !defined(__wasi__) && !defined(__wasm__)
#include <sched.h>
#endif

#define SCR_ITABLE_SEGMENT_BITS 6
#define SCR_ITABLE_SEGMENTS (1u << SCR_ITABLE_SEGMENT_BITS)
#define SCR_ITABLE_FIRST_SLOTS 8u
#define SCR_ITABLE_FIRST_CHUNK ((size_t)512)
#define SCR_ITABLE_MAX_CHUNK ((size_t)64 << 10)
/* Keys whose bytes (a string's, or an array key's encoding) exceed this
 * are refused, which keeps every entry size representable on 32-bit
 * targets. Array keys of more than SCR_ITABLE_MAX_KEY_ELEMENTS elements are
 * refused too; the Node.js implementation applies the same limit. */
#define SCR_ITABLE_MAX_KEY_BYTES ((size_t)SCR_STR_MAX_CAP)
#define SCR_ITABLE_MAX_KEY_ELEMENTS 65536u

/* String slots: 0 is empty; otherwise the entry pointer with the tag in
 * bits 48..55, which no supported target uses for user-space addresses
 * (tagged heap pointers keep their tag in the top byte, which is kept). */
#define SCR_ITABLE_TAG_SHIFT 48
#define SCR_ITABLE_TAG_MASK ((uint64_t)0xff << SCR_ITABLE_TAG_SHIFT)

/* Number slots are { value, key }, with the key stored as its normalized
 * bits XOR this NaN pattern, which normalization never produces (so no
 * stored key is 0), and a tag byte of hash bits 48..55 (0 mapped to 1). */
#define SCR_ITABLE_F64_FLIP UINT64_C(0x7ff4000000000001)

typedef struct ScrITableIndex {
  uint64_t mask;                  /* slots - 1 */
  struct ScrITableIndex *retired; /* the retired list's next index */
  uint64_t epoch;                 /* the epoch it was retired in */
  /* Number indexes: one tag byte per slot (0: empty), after the words. A
   * probe reads the dense tags first, so a miss rarely touches a pair. */
  _Atomic uint8_t *tags;
  _Atomic uint64_t words[];       /* one word per string slot, two per number slot */
} ScrITableIndex;

/* A string or array table entry: the value slot first (scr_itable.h),
 * then the key's bytes. */
typedef struct {
  uint64_t value;
  uint64_t hash;
  uint32_t len;
  char data[];
} ScrITableStrEntry;

typedef struct ScrITableChunk {
  struct ScrITableChunk *next;
  size_t size;
  size_t used;
  _Alignas(8) char data[];
} ScrITableChunk;

/* Lookups read only `index`, which changes when the index grows; inserts
 * write the rest. The two halves sit on separate cache lines, so inserts
 * into a segment do not evict its index pointer from readers' caches. */
typedef struct {
  _Alignas(64) ScrITableIndex *_Atomic index;
  _Alignas(64) atomic_uint lock;
  _Atomic uint64_t count;
  ScrITableChunk *chunks; /* the newest first */
} ScrITableSegment;

struct ScrITable {
  ScrITableSegment segments[SCR_ITABLE_SEGMENTS];
  struct ScrITable *next; /* the registry list */
  int key_kind;
  size_t name_len;
  char name[];
};

static void scr_itable_oom(void) { scr_trap("scriptc: out of memory\n"); }

static inline void scr_itable_pause(void) {
#if defined(__x86_64__) || defined(__i386__)
  __builtin_ia32_pause();
#elif defined(__aarch64__)
  __asm__ __volatile__("yield");
#endif
}

static void scr_itable_yield(void) {
#if defined(_WIN32)
  SwitchToThread();
#elif !defined(__wasi__) && !defined(__wasm__)
  sched_yield();
#endif
}

static void scr_itable_lock(atomic_uint *lock) {
  unsigned spins = 0;
  while (atomic_exchange_explicit(lock, 1, memory_order_acquire)) {
    while (atomic_load_explicit(lock, memory_order_relaxed)) {
      if (++spins < 64) scr_itable_pause();
      else scr_itable_yield();
    }
  }
}

static void scr_itable_unlock(atomic_uint *lock) {
  atomic_store_explicit(lock, 0, memory_order_release);
}

/* ── retired indexes ─────────────────────────────────────────────────
 * A thread that loaded a segment's index pointer before the index grew may
 * still be probing the old index (or about to read a number entry handle
 * that points into it). Every thread that uses a table has a reader record:
 * at the start of each lookup and insert it records the global epoch it
 * reads there, with release order. Growth publishes the new index, retires
 * the old one under the current epoch and advances the epoch. A retired
 * index is freed once every registered reader has recorded a later epoch:
 * such a reader began its current operation after the growth, so it reads
 * the new pointer, and the operations before, which may have read the old
 * one, are complete. Entry handles are used before the thread's next lookup
 * or insert, so the same rule covers them. A thread that stops using tables
 * keeps its last epoch, and with it later retirements, until it uses a
 * table again or exits (scr_itable_thread_exit). */
typedef struct ScrITableReader {
  _Atomic uint64_t seen; /* SCR_ITABLE_IDLE: the record is unused */
  struct ScrITableReader *next;
} ScrITableReader;

#define SCR_ITABLE_IDLE UINT64_MAX

static _Atomic uint64_t scr_itable_epoch = 1;
static ScrITableReader *_Atomic scr_itable_readers;
static SCR_TL ScrITableReader *scr_itable_reader;
static atomic_uint scr_itable_retired_lock;
static ScrITableIndex *scr_itable_retired; /* newest first */

static ScrITableReader *scr_itable_reader_new(void) {
  /* Reuse the record of an exited thread, else add one. */
  for (ScrITableReader *r = atomic_load_explicit(&scr_itable_readers, memory_order_acquire); r; r = r->next) {
    uint64_t idle = SCR_ITABLE_IDLE;
    if (atomic_compare_exchange_strong_explicit(&r->seen, &idle, 0, memory_order_acq_rel, memory_order_relaxed))
      return r;
  }
  ScrITableReader *r = calloc(1, sizeof *r);
  if (!r) scr_itable_oom();
  r->next = atomic_load_explicit(&scr_itable_readers, memory_order_relaxed);
  while (!atomic_compare_exchange_weak_explicit(&scr_itable_readers, &r->next, r, memory_order_release,
                                                memory_order_relaxed)) {
  }
  return r;
}

/* The start of a lookup or insert: the calling thread holds nothing it
 * read before. */
static inline void scr_itable_enter(void) {
  ScrITableReader *r = scr_itable_reader;
  if (__builtin_expect(r == NULL, 0)) r = scr_itable_reader = scr_itable_reader_new();
  uint64_t epoch = atomic_load_explicit(&scr_itable_epoch, memory_order_acquire);
  if (atomic_load_explicit(&r->seen, memory_order_relaxed) != epoch)
    atomic_store_explicit(&r->seen, epoch, memory_order_release);
}

void scr_itable_thread_exit(void) {
  ScrITableReader *r = scr_itable_reader;
  if (!r) return;
  scr_itable_reader = NULL;
  atomic_store_explicit(&r->seen, SCR_ITABLE_IDLE, memory_order_release);
}

/* Retires `index` (the caller has published its replacement) and frees
 * the retired indexes no reader can still hold. */
static void scr_itable_retire(ScrITableIndex *index) {
  scr_itable_lock(&scr_itable_retired_lock);
  index->epoch = atomic_fetch_add_explicit(&scr_itable_epoch, 1, memory_order_acq_rel);
  index->retired = scr_itable_retired;
  scr_itable_retired = index;
  uint64_t oldest = SCR_ITABLE_IDLE;
  for (ScrITableReader *r = atomic_load_explicit(&scr_itable_readers, memory_order_acquire); r; r = r->next) {
    uint64_t seen = atomic_load_explicit(&r->seen, memory_order_acquire);
    if (seen < oldest) oldest = seen;
  }
  /* Free every index retired before the oldest recorded epoch. */
  ScrITableIndex **link = &scr_itable_retired;
  while (*link) {
    ScrITableIndex *old = *link;
    if (old->epoch < oldest) {
      *link = old->retired;
      free(old);
    } else {
      link = &old->retired;
    }
  }
  scr_itable_unlock(&scr_itable_retired_lock);
}

/* ── keys and hashes ─────────────────────────────────────────────────── */

static inline uint64_t scr_itable_f64_bits(double k) {
  if (k != k) return UINT64_C(0x7ff8000000000000); /* one NaN key */
  if (k == 0) k = 0;                                /* -0 is the key 0 */
  uint64_t bits;
  memcpy(&bits, &k, sizeof bits);
  return bits;
}

static inline uint64_t scr_itable_f64_hash(uint64_t stored) { return scr_key_mix(stored); }

/* The Map key hash of a string (scr_map.c), which heap strings cache in
 * their header: a key used with a Map or a table before hashes once. */
static uint32_t scr_itable_str_hash32(const ScrStr *s) {
#if SCR_STR_HASH_CACHE
  uint32_t h = s->hash;
  if (h != 0) return h;
#endif
  uint64_t wide = scr_key_hash(s->data, s->len);
  uint32_t folded = (uint32_t)(wide ^ (wide >> 32));
  if (folded == 0) folded = 1;
#if SCR_STR_HASH_CACHE
  if (s->rc != SIZE_MAX) ((ScrStr *)s)->hash = folded;
#endif
  return folded;
}

static inline uint64_t scr_itable_str_hash(const ScrStr *s) {
  return scr_key_mix((uint64_t)scr_itable_str_hash32(s) | ((uint64_t)s->len << 32));
}

static inline ScrITableSegment *scr_itable_segment(ScrITable *t, uint64_t hash) {
  return &t->segments[hash >> (64 - SCR_ITABLE_SEGMENT_BITS)];
}

static inline uint8_t scr_itable_tag8(uint64_t hash) {
  uint8_t tag = (uint8_t)(hash >> 48);
  return tag ? tag : 1;
}

static inline uint64_t scr_itable_tag(uint64_t hash) {
  return ((hash >> 50) & 0xff) << SCR_ITABLE_TAG_SHIFT;
}

static inline const ScrITableStrEntry *scr_itable_slot_entry(uint64_t slot) {
  return (const ScrITableStrEntry *)(uintptr_t)(slot & ~SCR_ITABLE_TAG_MASK);
}

/* ── lookups ─────────────────────────────────────────────────────────── */

static const ScrITableStrEntry *scr_itable_probe_bytes(const ScrITableIndex *index, uint64_t hash,
                                                       const char *bytes, size_t len) {
  if (!index) return NULL;
  uint64_t tag = scr_itable_tag(hash);
  for (uint64_t i = hash & index->mask;; i = (i + 1) & index->mask) {
    uint64_t slot = atomic_load_explicit(&index->words[i], memory_order_acquire);
    if (slot == 0) return NULL;
    if ((slot & SCR_ITABLE_TAG_MASK) != tag) continue;
    const ScrITableStrEntry *e = scr_itable_slot_entry(slot);
    if (e->hash == hash && e->len == len && scr_key_equal(e->data, bytes, len)) return e;
  }
}

/* The { value, key } pair of a stored number key, or NULL. */
static _Atomic uint64_t *scr_itable_probe_f64(ScrITableIndex *index, uint64_t hash, uint64_t stored) {
  if (!index) return NULL;
  uint8_t tag = scr_itable_tag8(hash);
  for (uint64_t i = hash & index->mask;; i = (i + 1) & index->mask) {
    uint8_t seen = atomic_load_explicit(&index->tags[i], memory_order_acquire);
    if (seen == 0) return NULL;
    if (seen == tag && atomic_load_explicit(&index->words[2 * i + 1], memory_order_relaxed) == stored)
      return &index->words[2 * i];
  }
}

const ScrITableEntry *scr_itable_find_str(ScrITable *t, const ScrStr *key) {
  scr_itable_enter();
  uint64_t hash = scr_itable_str_hash(key);
  ScrITableSegment *seg = scr_itable_segment(t, hash);
  return (const ScrITableEntry *)scr_itable_probe_bytes(
      atomic_load_explicit(&seg->index, memory_order_acquire), hash, key->data, key->len);
}

const ScrITableEntry *scr_itable_find_f64(ScrITable *t, double key) {
  scr_itable_enter();
  uint64_t stored = scr_itable_f64_bits(key) ^ SCR_ITABLE_F64_FLIP;
  uint64_t hash = scr_itable_f64_hash(stored);
  ScrITableSegment *seg = scr_itable_segment(t, hash);
  return (const ScrITableEntry *)scr_itable_probe_f64(
      atomic_load_explicit(&seg->index, memory_order_acquire), hash, stored);
}

/* ── inserts (the segment lock held) ─────────────────────────────────── */

static ScrITableIndex *scr_itable_index_new(uint64_t slots, bool numbers) {
  /* Bytes per slot: the words and, for numbers, the tag byte. */
  size_t per = (numbers ? 2 : 1) * sizeof(uint64_t) + (numbers ? 1 : 0);
  if (slots > (SIZE_MAX - sizeof(ScrITableIndex)) / per) scr_itable_oom();
  size_t words = (size_t)slots * (numbers ? 2 : 1) * sizeof(uint64_t);
  ScrITableIndex *index = calloc(1, sizeof(ScrITableIndex) + words + (numbers ? slots : 0));
  if (!index) scr_itable_oom();
  index->mask = slots - 1;
  if (numbers) index->tags = (_Atomic uint8_t *)((char *)index->words + words);
  return index;
}

/* Whether slot `i` holds a key (the caller holds the segment lock). */
static inline bool scr_itable_used(const ScrITableIndex *index, uint64_t i, bool numbers) {
  if (numbers) return atomic_load_explicit(&index->tags[i], memory_order_relaxed) != 0;
  return atomic_load_explicit(&index->words[i], memory_order_relaxed) != 0;
}

/* Makes room for one more key: the segment's index, created or grown so
 * that it stays at most half full. Growth rehashes every stored key. */
static ScrITableIndex *scr_itable_reserve(ScrITableSegment *seg, bool numbers) {
  ScrITableIndex *index = atomic_load_explicit(&seg->index, memory_order_relaxed);
  uint64_t count = atomic_load_explicit(&seg->count, memory_order_relaxed);
  if (index && (count + 1) * 2 <= index->mask + 1) return index;
  ScrITableIndex *grown = scr_itable_index_new(index ? (index->mask + 1) * 2 : SCR_ITABLE_FIRST_SLOTS, numbers);
  if (index) {
    for (uint64_t i = 0; i <= index->mask; i++) {
      if (!scr_itable_used(index, i, numbers)) continue;
      uint64_t last = atomic_load_explicit(&index->words[numbers ? 2 * i + 1 : i], memory_order_relaxed);
      uint64_t hash = numbers ? scr_itable_f64_hash(last) : scr_itable_slot_entry(last)->hash;
      uint64_t j = hash & grown->mask;
      while (scr_itable_used(grown, j, numbers)) j = (j + 1) & grown->mask;
      if (numbers) {
        atomic_store_explicit(&grown->words[2 * j],
                              atomic_load_explicit(&index->words[2 * i], memory_order_relaxed),
                              memory_order_relaxed);
        atomic_store_explicit(&grown->words[2 * j + 1], last, memory_order_relaxed);
        atomic_store_explicit(&grown->tags[j], scr_itable_tag8(hash), memory_order_relaxed);
      } else {
        atomic_store_explicit(&grown->words[j], last, memory_order_relaxed);
      }
    }
  }
  atomic_store_explicit(&seg->index, grown, memory_order_release);
  if (index) scr_itable_retire(index);
  return grown;
}

/* The first empty slot of the key's probe (the key is known to be absent). */
static uint64_t scr_itable_free_slot(const ScrITableIndex *index, uint64_t hash, bool numbers) {
  uint64_t i = hash & index->mask;
  while (scr_itable_used(index, i, numbers)) i = (i + 1) & index->mask;
  return i;
}

static void scr_itable_counted(ScrITableSegment *seg) {
  atomic_store_explicit(&seg->count, atomic_load_explicit(&seg->count, memory_order_relaxed) + 1,
                        memory_order_relaxed);
}

static void *scr_itable_alloc(ScrITableSegment *seg, size_t size) {
  size = (size + 7) & ~(size_t)7;
  ScrITableChunk *chunk = seg->chunks;
  if (!chunk || chunk->size - chunk->used < size) {
    size_t next = chunk ? chunk->size * 2 : SCR_ITABLE_FIRST_CHUNK;
    if (next > SCR_ITABLE_MAX_CHUNK) next = SCR_ITABLE_MAX_CHUNK;
    if (next < size) next = size;
    chunk = calloc(1, sizeof(ScrITableChunk) + next);
    if (!chunk) scr_itable_oom();
    if ((uint64_t)(uintptr_t)chunk & SCR_ITABLE_TAG_MASK)
      scr_trap("scriptc: InternTable memory is outside the supported address range\n");
    chunk->size = next;
    chunk->next = seg->chunks;
    seg->chunks = chunk;
  }
  void *p = chunk->data + chunk->used;
  chunk->used += size;
  return p;
}

/* Stores `value` under a byte key (a string's bytes or an encoded array)
 * unless the key has an entry. */
static const ScrITableEntry *scr_itable_insert_bytes(ScrITable *t, uint64_t hash, const char *bytes,
                                                     size_t len, uint64_t value) {
  if (len > SCR_ITABLE_MAX_KEY_BYTES) scr_trap("scriptc: InternTable key is too long\n");
  ScrITableSegment *seg = scr_itable_segment(t, hash);
  scr_itable_lock(&seg->lock);
  const ScrITableStrEntry *found =
      scr_itable_probe_bytes(atomic_load_explicit(&seg->index, memory_order_relaxed), hash, bytes, len);
  if (!found) {
    ScrITableIndex *index = scr_itable_reserve(seg, false);
    ScrITableStrEntry *entry = scr_itable_alloc(seg, sizeof(ScrITableStrEntry) + len);
    entry->value = value;
    entry->hash = hash;
    entry->len = (uint32_t)len;
    memcpy(entry->data, bytes, len);
    uint64_t i = scr_itable_free_slot(index, hash, false);
    atomic_store_explicit(&index->words[i], (uint64_t)(uintptr_t)entry | scr_itable_tag(hash),
                          memory_order_release);
    scr_itable_counted(seg);
    found = entry;
  }
  scr_itable_unlock(&seg->lock);
  return (const ScrITableEntry *)found;
}

const ScrITableEntry *scr_itable_insert_str(ScrITable *t, const ScrStr *key, uint64_t value) {
  scr_itable_enter();
  scr_sa_thread_shares(); /* the stored value graph is read by every thread */
  return scr_itable_insert_bytes(t, scr_itable_str_hash(key), key->data, key->len, value);
}

const ScrITableEntry *scr_itable_insert_f64(ScrITable *t, double key, uint64_t value) {
  scr_itable_enter();
  scr_sa_thread_shares(); /* the stored value graph is read by every thread */
  uint64_t stored = scr_itable_f64_bits(key) ^ SCR_ITABLE_F64_FLIP;
  uint64_t hash = scr_itable_f64_hash(stored);
  ScrITableSegment *seg = scr_itable_segment(t, hash);
  scr_itable_lock(&seg->lock);
  _Atomic uint64_t *found =
      scr_itable_probe_f64(atomic_load_explicit(&seg->index, memory_order_relaxed), hash, stored);
  if (!found) {
    ScrITableIndex *index = scr_itable_reserve(seg, true);
    uint64_t i = scr_itable_free_slot(index, hash, true);
    atomic_store_explicit(&index->words[2 * i], value, memory_order_relaxed);
    atomic_store_explicit(&index->words[2 * i + 1], stored, memory_order_relaxed);
    atomic_store_explicit(&index->tags[i], scr_itable_tag8(hash), memory_order_release);
    scr_itable_counted(seg);
    found = &index->words[2 * i];
  }
  scr_itable_unlock(&seg->lock);
  return (const ScrITableEntry *)found;
}

/* ── array keys ──────────────────────────────────────────────────────── */

/* A walk over the elements of an array in index order. Sparse entries
 * are sorted by index (scr_array.h), so one pass visits each once. */
typedef struct {
  const ScrArr *a;
  size_t sparse;
} ScrITableElements;

/* The state and slot of element `i` (i < len, increasing across calls). */
static ScrArrState scr_itable_element(ScrITableElements *w, size_t i, uint64_t *slot) {
  const ScrArr *a = w->a;
  if (i < a->filled) {
    *slot = a->data[i];
    return SCR_ARR_VALUE;
  }
  if (i < a->cap) {
    *slot = a->data[i];
    return (ScrArrState)scr_arr_dense_state(a, i);
  }
  if (scr_arr_ext_of(a)) {
    while (w->sparse < scr_arr_ext_of(a)->sparse_len && scr_arr_ext_of(a)->sparse[w->sparse].index < i) w->sparse++;
    if (w->sparse < scr_arr_ext_of(a)->sparse_len && scr_arr_ext_of(a)->sparse[w->sparse].index == i) {
      *slot = scr_arr_ext_of(a)->sparse[w->sparse].slot;
      return (ScrArrState)scr_arr_ext_of(a)->sparse[w->sparse].state;
    }
  }
  return SCR_ARR_HOLE;
}

/* An array key as bytes: per number element its normalized bits, per
 * string element a 32-bit length and the bytes; a hole or undefined
 * element is the bits of a NaN that normalization never produces, or the
 * length 0xffffffff. */
#define SCR_ITABLE_ABSENT_F64 UINT64_C(0x7ff4000000000002)
#define SCR_ITABLE_ABSENT_STR UINT32_C(0xffffffff)

static void scr_itable_refuse(const char *message) {
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

/* The encoded size of `key`, or false (with a pending TypeError) when the
 * key is longer or larger than a table accepts. Every sum stays at most
 * SCR_ITABLE_MAX_KEY_BYTES, so none can wrap. */
static bool scr_itable_encoded_size(const ScrArr *key, int kind, size_t *out) {
  if (key->len > SCR_ITABLE_MAX_KEY_ELEMENTS) {
    scr_itable_refuse("InternTable array keys can have at most 65536 elements");
    return false;
  }
  size_t n = 0;
  ScrITableElements walk = {key, 0};
  for (size_t i = 0; i < key->len; i++) {
    size_t add = kind == SCR_ITABLE_KEY_F64S ? 8 : 4;
    if (kind != SCR_ITABLE_KEY_F64S) {
      uint64_t slot = 0;
      if (scr_itable_element(&walk, i, &slot) == SCR_ARR_VALUE) {
        const ScrStr *s = (const ScrStr *)(uintptr_t)slot;
        if (s->len > SCR_ITABLE_MAX_KEY_BYTES - add) add = SCR_ITABLE_MAX_KEY_BYTES + 1;
        else add += s->len;
      }
    }
    if (add > SCR_ITABLE_MAX_KEY_BYTES - n) {
      scr_itable_refuse("InternTable array keys can encode at most 2147483647 bytes");
      return false;
    }
    n += add;
  }
  *out = n;
  return true;
}

/* Writes the encoding of `key` into `out`, which holds exactly the size
 * scr_itable_encoded_size answered. */
static void scr_itable_encode(const ScrArr *key, int kind, char *out) {
  size_t n = 0;
  ScrITableElements walk = {key, 0};
  for (size_t i = 0; i < key->len; i++) {
    uint64_t slot = 0;
    bool present = scr_itable_element(&walk, i, &slot) == SCR_ARR_VALUE;
    if (kind == SCR_ITABLE_KEY_F64S) {
      uint64_t bits = SCR_ITABLE_ABSENT_F64;
      if (present) {
        double d;
        memcpy(&d, &slot, sizeof d);
        bits = scr_itable_f64_bits(d);
      }
      memcpy(out + n, &bits, 8);
      n += 8;
    } else {
      const ScrStr *s = present ? (const ScrStr *)(uintptr_t)slot : NULL;
      uint32_t len = s ? (uint32_t)s->len : SCR_ITABLE_ABSENT_STR;
      memcpy(out + n, &len, 4);
      n += 4;
      if (s) {
        memcpy(out + n, s->data, s->len);
        n += s->len;
      }
    }
  }
}

static inline uint64_t scr_itable_bytes_hash(const char *bytes, size_t len) {
  return scr_key_mix(scr_key_hash(bytes, len) ^ ((uint64_t)len << 1));
}

/* Encodes `key` into `stack` when it fits, else into a heap buffer the
 * caller frees; NULL (with a pending TypeError) for a refused key. */
static char *scr_itable_encoded(const ScrITable *t, const ScrArr *key, char *stack, size_t cap, size_t *len) {
  if (!scr_itable_encoded_size(key, t->key_kind, len)) return NULL;
  char *bytes = stack;
  if (*len > cap) {
    bytes = malloc(*len);
    if (!bytes) scr_itable_oom();
  }
  scr_itable_encode(key, t->key_kind, bytes);
  return bytes;
}

#define SCR_ITABLE_STACK_KEY 256

const ScrITableEntry *scr_itable_find_arr(ScrITable *t, const ScrArr *key) {
  scr_itable_enter();
  char stack[SCR_ITABLE_STACK_KEY];
  size_t len;
  char *bytes = scr_itable_encoded(t, key, stack, sizeof stack, &len);
  if (!bytes) return NULL;
  uint64_t hash = scr_itable_bytes_hash(bytes, len);
  ScrITableSegment *seg = scr_itable_segment(t, hash);
  const ScrITableEntry *found = (const ScrITableEntry *)scr_itable_probe_bytes(
      atomic_load_explicit(&seg->index, memory_order_acquire), hash, bytes, len);
  if (bytes != stack) free(bytes);
  return found;
}

const ScrITableEntry *scr_itable_insert_arr(ScrITable *t, const ScrArr *key, uint64_t value) {
  scr_itable_enter();
  scr_sa_thread_shares(); /* the stored value graph is read by every thread */
  char stack[SCR_ITABLE_STACK_KEY];
  size_t len;
  char *bytes = scr_itable_encoded(t, key, stack, sizeof stack, &len);
  if (!bytes) return NULL;
  const ScrITableEntry *entry = scr_itable_insert_bytes(t, scr_itable_bytes_hash(bytes, len), bytes, len, value);
  if (bytes != stack) free(bytes);
  return entry;
}

double scr_itable_size(const ScrITable *t) {
  uint64_t total = 0;
  for (unsigned i = 0; i < SCR_ITABLE_SEGMENTS; i++)
    total += atomic_load_explicit(&t->segments[i].count, memory_order_relaxed);
  return (double)total;
}

/* ── the registry ────────────────────────────────────────────────────── */

static atomic_uint scr_itable_registry_lock;
static ScrITable *scr_itable_registry;

ScrITable *scr_itable_open(const ScrStr *name, int key_kind) {
  scr_itable_lock(&scr_itable_registry_lock);
  ScrITable *t = scr_itable_registry;
  while (t && !(t->name_len == name->len && memcmp(t->name, name->data, name->len) == 0)) t = t->next;
  if (!t) {
    /* Segments are cache-line aligned; tables are never freed, so the
     * block's start need not be kept. */
    char *block = calloc(1, sizeof(ScrITable) + name->len + 63);
    if (!block) scr_itable_oom();
    t = (ScrITable *)(((uintptr_t)block + 63) & ~(uintptr_t)63);
    t->key_kind = key_kind;
    t->name_len = name->len;
    memcpy(t->name, name->data, name->len);
    t->next = scr_itable_registry;
    scr_itable_registry = t;
  }
  scr_itable_unlock(&scr_itable_registry_lock);
  if (t->key_kind != key_kind) scr_trap("scriptc: an InternTable name is open with another key type\n");
  return t;
}
