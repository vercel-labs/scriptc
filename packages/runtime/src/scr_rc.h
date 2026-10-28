/* scriptc runtime — cycle collection (scr_cycle.c), the small-object
 * allocator (scr_alloc.c) and cross-thread publication (scr_publish.c).
 * Included by scr_runtime.h, which says where new declarations go. */
#ifndef SCR_RC_H
#define SCR_RC_H

#include "scr_core.h"

/* ── reference counts ─────────────────────────────────────────────────
 * Every heap object's first member is its `size_t rc` word. On 64-bit
 * targets the word is
 *
 *     bits  0-31  the reference count (SCR_RC_COUNT)
 *     bit  62     F: a frozen record (SCR_RC_FROZEN)
 *     bit  63     P: a program-lifetime record (llvm/classes.ts
 *                 programLifetimeRc)
 *     bits 32-61  the layout id (scr_rc_layout_id)
 *
 * and no object's count reaches 2^32. The layout id names the object's
 * layout in the single object model (scr_layout.h); 0 means the object
 * never needed one. An emitted instance of a class in a program-rooted
 * hierarchy keeps its class id (its class's preorder number + 1) there
 * (llvm/classes.ts classIdRcWord): a class id is the layout id of its
 * class's canonical layout. A count of SCR_RC_IMMORTAL marks an immortal
 * object. Publication and the runtime's own immortal objects write the
 * whole word as SIZE_MAX when the object has no layout id, and write only
 * the count when it has one, so an immortal object keeps its layout id
 * (scr_rc_immortal tests the count; a high half of all ones reads as no
 * layout id). Code that reads or writes the count of an object of any
 * kind goes through SCR_RC_COUNT; code that may see an object with a layout
 * id tests immortality with scr_rc_immortal, never against SIZE_MAX. */
#if SIZE_MAX > UINT32_MAX
typedef uint32_t ScrRcCount;
#ifdef __BYTE_ORDER__
_Static_assert(__BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__,
               "the reference count is the low half of the rc word, at offset 0");
#endif
#else
typedef size_t ScrRcCount;
#endif
#define SCR_RC_IMMORTAL ((ScrRcCount)-1)
#define SCR_RC_COUNT(obj) (*(ScrRcCount *)(obj))

/* Compact class instances (64-bit targets; llvm/classes.ts
 * LlClassMeta.compact): the instances of a ProgramLifetime hierarchy count
 * nothing, so their header is one 32-bit word instead of the rc word, and
 * their fields start at offset 4. The word is SCR_RC_COMPACT_TAG, the class
 * id (0 outside a hierarchy) in the low 28 bits, and SCR_RC_COMPACT_PUBLISHED
 * once publication marks it. No count reaches the tag, so a word read through
 * SCR_RC_COUNT tells the two apart, and a count or word of
 * SCR_RC_PUBLISHED_MIN and up is published for every object. Only emitted
 * code holds compact instances in typed slots; the runtime reaches them
 * through their emitted adapters, publication walkers (SCR_PUB_COMPACT) and
 * the published test. */
#define SCR_RC_COMPACT_TAG UINT32_C(0x70000000)
#define SCR_RC_COMPACT_PUBLISHED UINT32_C(0x80000000)
#define SCR_RC_COMPACT_ID_MASK UINT32_C(0x0fffffff)
#define SCR_RC_PUBLISHED_MIN ((ScrRcCount)UINT32_C(0xf0000000))
/* Whether `obj`, an object of any kind, is published (immortal). */
#define SCR_RC_PUBLISHED(obj) (SCR_RC_COUNT(obj) >= SCR_RC_PUBLISHED_MIN)

/* Frozen records (Object.freeze). The rc word of a record a program may
 * freeze (llvm/shapes.ts) carries SCR_RC_FROZEN beside its count, and that
 * record's emitted release ignores the bit. On 64-bit targets the bit is in
 * the high half, outside the count; on 32-bit targets it is the count's bit
 * 30, which SCR_RC_REFS masks. An immortal word has the bit set too; it
 * does not read as frozen. */
#if SIZE_MAX > UINT32_MAX
#define SCR_RC_FROZEN ((size_t)1 << 62)
#define SCR_RC_REFS(obj) SCR_RC_COUNT(obj)
#else
#define SCR_RC_FROZEN ((size_t)1 << 30)
#define SCR_RC_REFS(obj) (SCR_RC_COUNT(obj) == SCR_RC_IMMORTAL ? SCR_RC_IMMORTAL : SCR_RC_COUNT(obj) & ~SCR_RC_FROZEN)
#endif
/* Whether `obj`, an object whose rc word is a count (not a compact class
 * instance), is immortal: its count is SCR_RC_IMMORTAL, whatever its high
 * half holds. */
static inline bool scr_rc_immortal(const void *obj) {
  return SCR_RC_COUNT(obj) == SCR_RC_IMMORTAL;
}

static inline bool scr_rc_frozen(const void *obj) {
  return !scr_rc_immortal(obj) && (*(const size_t *)obj & SCR_RC_FROZEN) != 0;
}

/* The high half of the rc word on 64-bit targets: the program-lifetime
 * bit, the frozen bit and the layout id (see the layout above). 32-bit
 * targets have no high half; their objects keep a layout id elsewhere when
 * they need one (scr_layout.h). */
#define SCR_RC_HIGH_LIFETIME UINT32_C(0x80000000)
#define SCR_RC_HIGH_FROZEN UINT32_C(0x40000000)
#define SCR_RC_LAYOUT_ID_MASK UINT32_C(0x3fffffff)
/* Layout ids are below this bound: 2^30 - 1 is the id bits of an all-ones
 * high half, which reads as no id. */
#define SCR_RC_LAYOUT_ID_LIMIT SCR_RC_LAYOUT_ID_MASK

/* The layout id in the high half of `obj`'s rc word, or 0 for an object
 * without one. The whole-word immortal encoding (SIZE_MAX) has no id. */
static inline uint32_t scr_rc_layout_id(const void *obj) {
#if SIZE_MAX > UINT32_MAX
  uint32_t high = (uint32_t)(*(const size_t *)obj >> 32);
  return high == UINT32_MAX ? 0 : high & SCR_RC_LAYOUT_ID_MASK;
#else
  (void)obj;
  return 0;
#endif
}

/* The class id in the high half of `obj`'s rc word, or 0 for an object
 * without one. A class id is the layout id of the class's canonical
 * layout, and no object of any other kind has a layout id yet. */
static inline uint32_t scr_rc_class_id(const void *obj) {
  return scr_rc_layout_id(obj);
}

/* ── cycle collection (scr_cycle.c) ───────────────────────────────────
 * Reference counting alone cannot free cycles, so every object that can
 * participate in one — capture boxes, heap closures, unions, promises, and
 * compiler-emitted class/record shapes with cycle-capable fields — is
 * allocated with a hidden 8-byte header directly BEFORE the object: the
 * registry id of its type's descriptor (a trace function enumerating the
 * object's cycle-capable children, and a teardown function freeing the
 * object WITHOUT releasing traced children) and the trial-deletion
 * bookkeeping (color, generation and candidate-root buffer state). Types
 * that can never be in a cycle — strings above all, plus arrays of scalar/
 * string/bytes elements and shapes whose fields are all acyclic — keep the
 * lean 1-word `rc` header and pay nothing. Heap dyn nodes all carry the
 * header (one uniform tracing ABI for unknown values); parsed documents
 * avoid candidate buffering through intact regions instead (ScrDynRegion). Arrays and maps are
 * cycle-capable exactly when their element/value type is (a record element
 * can point back at the array holding it).
 *
 * The collector is synchronous Bacon–Rajan trial deletion: a release that
 * leaves a candidate's rc above zero buffers it as a possible cycle root;
 * collection walks the buffer (markGray: trial-decrement internal edges;
 * scan: restore externally-referenced subgraphs; gather: free the
 * dead cycle members, releasing only edges that LEAVE the white set).
 * It is GENERATIONAL: each header carries a generation, a pass names the
 * oldest one it will walk, and objects that survive a pass are promoted one
 * generation (nursery, mature, old) so later restricted passes never re-walk
 * them. That is what keeps a pass proportional to recent allocation rather
 * than to the whole live heap — see the generation note in scr_cycle.c for
 * the soundness argument and the schedule. Collection points: program
 * exit (before the RC audit), event-loop quiescence, and the per-generation
 * triggers.
 * SCR_CYCLE_THRESHOLD pins the nursery trigger to a fixed candidate count.
 * SCR_CYCLE_GROWTH_CAP lowers how far past its size the heap may grow
 * between passes at an older level that find nothing (16 times its size by
 * default; see scr_cycle.c).
 * There is no concurrent or incremental collection.
 *
 * Contract for trace/teardown pairs (the compiler emits them for shapes,
 * the runtime owns its own): trace(obj) visits exactly the strong
 * references to children that themselves carry a cycle header (visit
 * callbacks tolerate NULL and immortal children); the teardown releases
 * exactly the complement (strings, arrays, acyclic shapes), frees internal
 * buffers, and frees the block via scr_cyc_free. Every heap object's
 * FIRST member is `size_t rc`, which is what lets the collector adjust
 * counts generically.
 */
typedef void (*ScrTraceVisit)(void *child, void *ctx);
typedef void (*ScrTraceFn)(void *obj, ScrTraceVisit visit, void *ctx);
typedef void (*ScrCycFreeFn)(void *obj);

/* Colors belong to the collector alone: retains and releases never write
 * them (a buffered entry is a candidate until a pass drains it). DOOMED
 * identifies the gathered dead set during re-buffering and weak observer
 * teardown. WHITE candidates may still become black when a later outside
 * root restores them; only the settled white set becomes DOOMED. */
enum { SCR_CYC_BLACK = 0, SCR_CYC_GRAY = 1, SCR_CYC_WHITE = 2, SCR_CYC_DOOMED = 3 };

/* Generations. A candidate sits in the buffer named by its own `gen`, and a
 * pass walks only objects at or below the generation it collects; a pass at
 * SCR_CYC_OLD is a full pass. */
enum { SCR_CYC_NURSERY = 0, SCR_CYC_MATURE = 1, SCR_CYC_OLD = 2, SCR_CYC_NGENS = 3 };

/* A headered type's collector entry points, shared by all its objects: the
 * header names its descriptor by a registry id (`id`, assigned on the type's
 * first allocation) instead of carrying a pointer, which keeps the header at
 * 8 bytes. Emitted shapes define one per traced type (llvm/shapes.ts);
 * runtime families define their own. Descriptors are writable (the id) and
 * must outlive every object of the type. */
typedef struct ScrCycType {
  ScrTraceFn trace;
  ScrCycFreeFn free_fn;
  /* Index of the type's per-thread collector statistics (scr_cycle.c's
   * nursery bypass): a runtime family's SCR_CYC_KIND_*, or for emitted
   * descriptors their number counting from SCR_CYC_KIND_EMITTED. 0 keeps
   * no statistics. Statistics only steer
   * when a candidate is walked, never what a pass frees, so two types that
   * share an index (separately emitted code in one process) are merely
   * judged together. */
  uint32_t kind;
  /* Registry id (scr_cyc_types), 0 until scr_cyc_register assigns it.
   * Emitted allocation paths read it and take the slow path while it is 0. */
  uint32_t id;
} ScrCycType;
/* The trace of a type that holds nothing cycle-capable: it visits nothing.
 * Emitted classes whose fields hold no cycle-capable value but whose
 * hierarchy is traced name it (llvm/classes.ts); their objects are
 * allocated with `buf` SCR_CYC_ACYCLIC. */
void scr_cyc_no_children(void *obj, ScrTraceVisit visit, void *ctx);
/* Runtime families' kinds. Emitted descriptors count from
 * SCR_CYC_KIND_EMITTED (llvm/alloc.ts FIRST_EMITTED_CYC_KIND). */
enum {
  SCR_CYC_KIND_NONE = 0,
  /* Also how the collector recognizes a cycle-capable ScrArr, whose dense
   * elements it visits inline (scr_cycle.c SCR_CYC_CHILDREN): reserved for
   * scr_array.c's descriptor. */
  SCR_CYC_KIND_ARRAY,
  SCR_CYC_KIND_PROMISE,
  SCR_CYC_KIND_BOX,
  SCR_CYC_KIND_CLOSURE,
  SCR_CYC_KIND_ERROR,
  SCR_CYC_KIND_DOMEXCEPTION,
  SCR_CYC_KIND_EMITTER,
  SCR_CYC_KIND_CAUGHT,
  SCR_CYC_KIND_DYN,
  SCR_CYC_KIND_WEAK_MAP,
  SCR_CYC_KIND_MAP,
  SCR_CYC_KIND_CLASS_OBJECT,
  SCR_CYC_KIND_STREAM,
  SCR_CYC_KIND_UNION,
  SCR_CYC_KIND_WORKER_VIEW,
  SCR_CYC_KIND_EMITTED = 32
};
/* Eight bytes in front of the object: the descriptor's registry id, the
 * collector color (SCR_CYC_*) and generation (SCR_CYC_NURSERY..SCR_CYC_OLD,
 * the walk filter), and `buf`: SCR_CYC_BUFFERED_BIT while the object sits in
 * its generation's candidate buffer, with its position there below it (O(1)
 * removal when rc hits 0), or SCR_CYC_ACYCLIC. */
typedef struct ScrCycHdr {
  uint16_t id;
  uint8_t color;
  uint8_t gen;
  uint32_t buf;
} ScrCycHdr;
#define SCR_CYC_BUFFERED_BIT 0x80000000u
/* `buf` of an object whose type's trace is scr_cyc_no_children: it has no
 * cycle-capable children, so it is never on a cycle and never a candidate.
 * Such a type still carries the header when it shares a hierarchy with
 * cycle-capable classes (headers are uniform per hierarchy). The value has
 * the buffered bit set, so a release that leaves the object alive returns
 * at the buffered test and makes no call; scr_cyc_is_buffered is false for
 * it. No buffer position reaches it (scr_cyc_grow caps the buffers well
 * below 2^31 entries). */
#define SCR_CYC_ACYCLIC 0xffffffffu

/* This layout is an ABI, not an implementation detail. The emitted
 * allocation stores the id and zeroes the rest (`buf` SCR_CYC_ACYCLIC for a
 * class whose trace is scr_cyc_no_children); every emitted release of a
 * headered object (llvm/shapes.ts cycleRootLines, used by the record, class
 * and inline RC helpers) mirrors scr_cyc_on_release's early return by
 * testing the sign of `buf` as an i32 at obj-4, the emitted death mirrors
 * scr_cyc_on_dead's by testing `buf` below -1 (cycleDeadLines), and the
 * emitted inline free reads the generation as an i8 at obj-5. Hence the
 * assertions. */
_Static_assert(sizeof(ScrCycHdr) == 8, "LLVM backend expects an 8-byte cycle header");
_Static_assert(offsetof(ScrCycHdr, id) == 0 && sizeof(((ScrCycHdr *)0)->id) == 2,
               "the emitted allocation stores the registry id as an i16 at the block start");
_Static_assert(sizeof(ScrCycHdr) - offsetof(ScrCycHdr, buf) == 4,
               "the emitted release fast path tests `buf` as an i32 at obj-4");
_Static_assert(sizeof(ScrCycHdr) - offsetof(ScrCycHdr, gen) == 5,
               "LLVM backend's inline free reads the generation as an i8 at obj-5");
_Static_assert(sizeof(ScrCycHdr) % _Alignof(double) == 0,
               "cycle-headered payloads must preserve double alignment");

static inline ScrCycHdr *scr_cyc_hdr(void *obj) { return (ScrCycHdr *)obj - 1; }

/* Registry of descriptors by id (copies, so a header reaches its entry
 * points in one step); ids are assigned on first allocation and shared by
 * every thread. */
#define SCR_CYC_MAX_TYPES ((uint32_t)1 << 15)
extern ScrCycType scr_cyc_types[SCR_CYC_MAX_TYPES];
uint32_t scr_cyc_register(ScrCycType *type);
static inline uint32_t scr_cyc_type_id(ScrCycType *type) {
  /* Acquire pairs with scr_cyc_register's publishing compare-exchange, so
   * a thread that sees the id also sees its scr_cyc_types entry. */
  uint32_t id = __atomic_load_n(&type->id, __ATOMIC_ACQUIRE);
  return id ? id : scr_cyc_register(type);
}

static inline const ScrCycType *scr_cyc_type(const ScrCycHdr *h) { return &scr_cyc_types[h->id]; }
static inline unsigned scr_cyc_color(const ScrCycHdr *h) { return h->color; }
static inline void scr_cyc_set_color(ScrCycHdr *h, unsigned color) { h->color = (uint8_t)color; }
static inline unsigned scr_cyc_gen(const ScrCycHdr *h) { return h->gen; }
static inline void scr_cyc_set_gen(ScrCycHdr *h, unsigned gen) { h->gen = (uint8_t)gen; }
static inline bool scr_cyc_is_buffered(const ScrCycHdr *h) {
  return (h->buf & SCR_CYC_BUFFERED_BIT) != 0 && h->buf != SCR_CYC_ACYCLIC;
}
/* A release that leaves the object alive has nothing to buffer: it is a
 * candidate already, or it is never one (SCR_CYC_ACYCLIC). */
static inline bool scr_cyc_release_done(const ScrCycHdr *h) {
  return (h->buf & SCR_CYC_BUFFERED_BIT) != 0;
}
static inline uint32_t scr_cyc_buf_index(const ScrCycHdr *h) {
  return h->buf & ~SCR_CYC_BUFFERED_BIT;
}
/* Buffered at position `index` of its generation's buffer, or not at all. */
static inline void scr_cyc_set_buffered(ScrCycHdr *h, uint32_t index) {
  h->buf = SCR_CYC_BUFFERED_BIT | index;
}
static inline void scr_cyc_clear_buffered(ScrCycHdr *h) { h->buf = 0; }

/* Zeroed allocation with a cycle header in front; returns the OBJECT
 * pointer (header at scr_cyc_hdr). `type` must outlive the object (a
 * static descriptor). Aborts on OOM. */
void *scr_cyc_alloc(size_t size, ScrCycType *type);
void scr_cyc_free(void *obj); /* frees the block, header included */

/* ── small-object allocator (scr_alloc.c) ───────────────────────────────
 * Runtime objects are small, short-lived and freed by the thread that made
 * them — the pattern a general-purpose malloc pays the most for. Blocks of
 * up to SCR_SA_MAX bytes come from per-size-class free lists refilled by a
 * bump pointer; the fast paths below inline into every runtime unit.
 *
 * Contracts match malloc/calloc/realloc/free (NULL on OOM), except for
 * alignment: blocks are 8-byte aligned, and 16-byte aligned when the size
 * is a multiple of 16, which covers every type whose size is a multiple of
 * its alignment. scr_mem_free and scr_mem_realloc accept ANY pointer — a
 * block outside the allocator's reservation goes back to the system — so a
 * free site can be switched without proving where its pointers came from.
 * The converse does not hold: a block from scr_mem_alloc/calloc/realloc
 * must never reach the system free/realloc. Emitted code reaches the same
 * allocator through scr_rt_calloc/scr_rt_free.
 *
 * Compiled to the plain system calls under SCR_RC_AUDIT and AddressSanitizer
 * (the audit lane must see every logical free as a real free), on targets
 * without a cheap address-space reservation (wasm32, Windows, 32-bit), and
 * in thread-instanced library archives, where several runtime instances
 * run on embedder threads the runtime does not manage. Elsewhere the
 * allocator state is unsynchronized: runtime objects are only allocated
 * and freed on their runtime thread (native worker jobs never touch them).
 *
 * Worker executables (SCR_WORKERS) give every script thread its own
 * allocator: `scr_sa` is thread-local and describes the thread's ARENA, one
 * of SCR_SA_ARENAS equal slices of a single process-wide reservation, so
 * the owning arena of any block is address arithmetic. A thread claims an
 * arena on its first allocation and parks it (free lists and bump pointers
 * intact) when it exits; the next thread to claim it continues from there.
 * On Linux an exiting thread that carved much first returns the pages of
 * its arena that hold only free blocks (scr_alloc.c). Script objects stay on their thread, so a free
 * normally hits the caller's own arena inline. A block freed by another
 * thread goes to the owning arena's lock-free remote list, which the owner
 * drains on its slow path; published (immortal) objects are never freed,
 * so they stay valid after their allocating thread exits. Threads beyond
 * SCR_SA_ARENAS, or a refused reservation, use the system allocator. */
#include <stdlib.h>
#if defined(SCR_RC_AUDIT) || defined(__SANITIZE_ADDRESS__) || defined(__wasi__) || \
    defined(__wasm__) || defined(_WIN32) || UINTPTR_MAX != UINT64_MAX ||              \
    (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
#define SCR_SMALL_ALLOC 0
#elif defined(__has_feature)
#if __has_feature(address_sanitizer)
#define SCR_SMALL_ALLOC 0
#else
#define SCR_SMALL_ALLOC 1
#endif
#else
#define SCR_SMALL_ALLOC 1
#endif

void *scr_mem_realloc(void *p, size_t n);
void *scr_rt_calloc(size_t n); /* emitted-code entry points */
#if defined(__linux__) && SCR_SMALL_ALLOC
/* The program-lifetime region (scr_alloc.c): compact class instances of
 * programs built for Linux without sanitizers (llvm/emitter.ts
 * lowRegionTarget), which are never freed, at 8-byte aligned addresses below
 * 32 GiB, so their fields can hold address >> 3 in 32 bits (0 is NULL).
 * scr_plr_init reserves it before compiled code runs; scr_plr_alloc returns
 * zeroed memory. */
void scr_plr_init(void);
void *scr_plr_alloc(size_t n);
/* The calling script thread's part of the region: emitted allocation fast
 * paths take [next, limit) in 8-byte multiples and call scr_plr_alloc when
 * it is exhausted (llvm/classes.ts addresses both fields). */
typedef struct ScrPlrChunk {
  char *next;
  char *limit;
} ScrPlrChunk;
#if defined(SCR_WORKERS) || (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
extern _Thread_local ScrPlrChunk scr_plr_chunk;
#else
extern ScrPlrChunk scr_plr_chunk;
#endif
_Static_assert(offsetof(ScrPlrChunk, next) == 0 && offsetof(ScrPlrChunk, limit) == 8,
               "llvm/classes.ts addresses ScrPlrChunk fields at these offsets");
#endif
void scr_rt_free(void *p);
/* Asks the allocator's pre-fault helper (scr_alloc.c) to fault the pages
 * of [lo, hi), aligned to 256 KiB, in ahead of use; builds without the
 * helper ignore it. */
void scr_mem_prefault(void *lo, void *hi);
/* Returns the pages of [lo, hi) (page aligned), which hold no data, to the
 * system (Linux): pre-fault requests for them are dropped first, so they
 * stay returned. Other builds ignore it. */
void scr_mem_release_ahead(void *lo, void *hi);
/* Reorders ptrs, distinct pointers `offset` bytes into blocks that are
 * about to be freed in array order, so that the free lists hand the blocks
 * back in ascending address order (scr_alloc.c). Builds without the
 * small-object allocator leave the array as it is. */
void scr_mem_order_for_free(void **ptrs, size_t n, size_t offset);

/* Size classes: requests up to 128 bytes take a class per 8-byte step
 * (small objects often sit just under a 16-byte boundary), larger ones a
 * class per 16-byte step up to 512. Class c below SCR_SA_FINE_MAX / 8
 * holds (c + 1) * 8-byte blocks, except that the class of 49 to 56-byte
 * requests (SCR_SA_WIDE) holds 64-byte blocks: a 56-byte block straddles a
 * cache line in 3 of every 4 slots, which costs more on scattered access
 * to records of that size than the smaller block saves. Widening the block
 * rather than sharing the 64-byte class keeps the class lookup free of a
 * special case. Slices start page-aligned, so a class whose block size is
 * a multiple of 16 keeps its blocks 16-byte aligned. */
#define SCR_SA_FINE_MAX 128u /* the largest request with an 8-byte-step class */
#define SCR_SA_WIDE 6u       /* the class of 49 to 56-byte requests */
#define SCR_SA_NCLASS 40u
#define SCR_SA_MAX 512u

/* The class of a block of n bytes, 1 <= n <= SCR_SA_MAX. */
static inline unsigned scr_sa_class(size_t n) {
  unsigned k = (unsigned)((n - 1) >> 3);
  return k < SCR_SA_FINE_MAX / 8 ? k : (k + SCR_SA_FINE_MAX / 8) >> 1;
}
/* The block size of class c. */
static inline size_t scr_sa_class_size(unsigned c) {
  if (c < SCR_SA_FINE_MAX / 8) return (size_t)(c + 1 + (c == SCR_SA_WIDE)) * 8;
  return (size_t)(c + 1 - SCR_SA_FINE_MAX / 16) * 16;
}

typedef struct ScrSaBlock {
  struct ScrSaBlock *next;
} ScrSaBlock;

/* One reservation split into SCR_SA_NCLASS equal slices, one per class, so
 * a block's class is its slice index: (p - base) >> shift. span is 0 until
 * the first refill reserves (and stays 0 if the host refuses).
 *
 * scr_sa exists in EVERY build, and its layout is an ABI: the LLVM backend
 * inlines the fast paths into emitted constructors and releases
 * (llvm/alloc.ts) as `{ i64, i64, i32, [40 x ptr], [40 x ptr], [40 x ptr] }`
 * on 64-bit targets. Where SCR_SMALL_ALLOC is 0 the state is never written,
 * so the emitted fast paths see no free block, no bump room and an empty
 * span, and always take their out-of-line slow path (scr_rt_calloc /
 * scr_rt_free → the system allocator) — the sanitizer and RC-audit lanes
 * therefore see every logical allocation and free without the compiler
 * knowing which runtime it links against. The emitted fast paths also skip
 * scr_obj_alloc_note/scr_obj_free_note, which is sound because those are
 * no-ops whenever the allocator is live (SCR_RC_AUDIT implies
 * SCR_SMALL_ALLOC == 0). */
typedef struct ScrSaState {
  uintptr_t base, span;
  unsigned shift;
  ScrSaBlock *free[SCR_SA_NCLASS];
  char *bump[SCR_SA_NCLASS], *lim[SCR_SA_NCLASS];
} ScrSaState;
/* Worker executables keep one allocator per script thread (see above). Its
 * state shares one thread-local block with the collector's live counts and
 * the weak dispose hook (ScrThreadHot below): on Darwin every distinct
 * thread-local costs a call per function that touches it, and allocation
 * and free paths touch all four. */
#ifdef SCR_WORKERS
/* The per-thread state of the allocation and free fast paths, in one
 * thread-local block; its layout is an ABI (llvm/alloc.ts addresses the
 * fields at fixed offsets from one llvm.threadlocal.address). */
typedef struct ScrThreadHot {
  ScrSaState sa;
  size_t cyc_live;
  size_t cyc_old_freed;
  void (*weak_dispose_hook)(void *);
} ScrThreadHot;
extern _Thread_local ScrThreadHot scr_thread_hot;
#define scr_sa (scr_thread_hot.sa)
#define scr_cyc_live (scr_thread_hot.cyc_live)
#define scr_cyc_old_freed (scr_thread_hot.cyc_old_freed)
#define scr_weak_dispose_hook (scr_thread_hot.weak_dispose_hook)
#if UINTPTR_MAX == UINT64_MAX
_Static_assert(offsetof(ScrThreadHot, sa) == 0 && offsetof(ScrThreadHot, cyc_live) == 984 &&
                   offsetof(ScrThreadHot, cyc_old_freed) == 992 &&
                   offsetof(ScrThreadHot, weak_dispose_hook) == 1000,
               "llvm/alloc.ts addresses ScrThreadHot fields at these offsets");
#endif
#else
extern ScrSaState scr_sa;
#endif
#if UINTPTR_MAX == UINT64_MAX
_Static_assert(offsetof(ScrSaState, span) == 8 && offsetof(ScrSaState, shift) == 16 &&
                   offsetof(ScrSaState, free) == 24 && offsetof(ScrSaState, bump) == 344 &&
                   offsetof(ScrSaState, lim) == 664 && sizeof(ScrSaState) == 984,
               "llvm/alloc.ts inlines the small-object allocator against this layout");
#endif
#if defined(SCR_RC_AUDIT) && SCR_SMALL_ALLOC
#error "emitted allocation fast paths skip the RC-audit object notes"
#endif

#ifdef SCR_WORKERS
/* A block outside the calling thread's arena: another arena's (remote
 * free) or the system's. */
void scr_sa_free_foreign(void *p);
/* The calling script thread is done with its arena (worker exit). */
void scr_sa_thread_park(void);
/* Waits until the arenas of exited threads are trimmed (tests). */
void scr_sa_wait_trims(void);
/* Called first on a new worker thread: prepares the thread's system-
 * allocator heap, and lets the thread's memory go back when it exits
 * (scr_alloc.c). */
void scr_sa_thread_starting(void);
/* The calling thread made objects it allocated reachable from other
 * threads: a message or an intern table shares a published graph by
 * pointer, or a process-wide cache keeps an immortal object. Its memory
 * then stays when it exits (scr_alloc.c). */
void scr_sa_thread_shares(void);
/* The event loop of the calling thread is about to wait with nothing ready
 * (true), or is done waiting (false); worker threads are ignored. The
 * memory of parked workers goes back while the loop waits (scr_alloc.c). */
void scr_sa_loop_waiting(bool waiting);
#define SCR_SA_FREE_FOREIGN(p) scr_sa_free_foreign(p)
#else
#define SCR_SA_FREE_FOREIGN(p) free(p)
#define scr_sa_thread_shares() ((void)0)
#endif

#if SCR_SMALL_ALLOC
/* Refill miss: reserves on first use, falls back to the system allocator
 * for large blocks, n == 0, an exhausted slice, or a refused reservation. */
void *scr_sa_slow(size_t n, bool zero);

static inline void *scr_sa_take(size_t n, bool zero) {
  if (n - 1 < SCR_SA_MAX) { /* n == 0 wraps to the slow path */
    unsigned c = scr_sa_class(n);
    ScrSaBlock *b = scr_sa.free[c];
    if (b) {
      scr_sa.free[c] = b->next;
      if (zero) memset(b, 0, n); /* recycled blocks are dirty */
      return b;
    }
    size_t sz = scr_sa_class_size(c);
    char *p = scr_sa.bump[c];
    if ((size_t)(scr_sa.lim[c] - p) >= sz) { /* fresh mmap memory is zero */
      scr_sa.bump[c] = p + sz;
      return p;
    }
  }
  return scr_sa_slow(n, zero);
}

static inline void *scr_mem_alloc(size_t n) { return scr_sa_take(n, false); }
static inline void *scr_mem_calloc(size_t n) { return scr_sa_take(n, true); }

static inline void scr_mem_free(void *p) {
  uintptr_t off = (uintptr_t)p - scr_sa.base;
  if (off < scr_sa.span) {
    ScrSaBlock *b = p;
    unsigned c = (unsigned)(off >> scr_sa.shift);
    b->next = scr_sa.free[c];
    scr_sa.free[c] = b;
    return;
  }
  SCR_SA_FREE_FOREIGN(p);
}
#else
static inline void *scr_mem_alloc(size_t n) { return malloc(n); }
static inline void *scr_mem_calloc(size_t n) { return calloc(1, n); }
static inline void scr_mem_free(void *p) { free(p); }
#endif

/* Inline twins of scr_cyc_alloc/scr_cyc_free for hot runtime allocation
 * sites (union boxes, arrays, boxes, closures, maps, dyn nodes). With a
 * constant size the size class and the zeroing fold at compile time. The
 * live count is exported for these and for the emitted inline paths
 * (llvm/alloc.ts), which do the same three things: header (the registry
 * id; the rest starts zero: SCR_CYC_BLACK, SCR_CYC_NURSERY, unbuffered),
 * live count, block. */
#ifndef SCR_WORKERS
extern SCR_TL size_t scr_cyc_live;
extern SCR_TL size_t scr_cyc_old_freed;
extern SCR_TL void (*scr_weak_dispose_hook)(void *);
#endif
static inline void *scr_cyc_alloc_inline(size_t size, ScrCycType *type) {
  if (size > SIZE_MAX - sizeof(ScrCycHdr)) scr_trap("scriptc: out of memory\n");
  uint32_t id = scr_cyc_type_id(type);
  ScrCycHdr *h = (ScrCycHdr *)scr_mem_calloc(sizeof(ScrCycHdr) + size);
  if (!h) scr_trap("scriptc: out of memory\n");
  h->id = (uint16_t)id;
  scr_cyc_live++;
  return h + 1;
}
/* scr_weak_dispose's NULL test inline, for the runtime's hot frees: the
 * hook stays NULL unless the program creates a weak collection or keeps a
 * checked record's source, so the free costs one predictable branch, not a
 * call. */
static inline void scr_weak_dispose_inline(void *obj) {
  if (scr_weak_dispose_hook) scr_weak_dispose_hook(obj);
}
static inline void scr_cyc_free_inline(void *obj) {
  scr_weak_dispose_inline(obj);
  scr_cyc_live--;
  if (scr_cyc_gen(scr_cyc_hdr(obj)) == SCR_CYC_OLD) scr_cyc_old_freed++;
  scr_mem_free(scr_cyc_hdr(obj));
}
_Static_assert(SCR_CYC_NURSERY == 0, "zeroed cycle headers start in the nursery");
_Static_assert(sizeof(((ScrCycHdr *)0)->gen) == 1 && SCR_CYC_OLD == 2,
               "LLVM backend's inline free compares an i8 generation against 2");

/* Dispose an object whose reference count already reached zero. The caller
 * removes its cycle candidate first. Nested disposals keep bounded stack
 * depth; deeper objects wait until the outer disposal drains the worklist.
 * The callback owns the object and must release its children and free it. */
void scr_rc_destroy(void *obj, void (*destroy)(void *));
/* scr_rc_destroy for an emitted teardown that keeps the blocks it frees in
 * a segment, linked through their first words, instead of freeing them onto
 * the free list (llvm/shapes.ts): destroy_seg tears obj down, appending its
 * blocks after the segment's last link `tail`, and returns the new last
 * link, which this returns. A disposal past the depth budget is queued with
 * `destroy`, which frees its own blocks, and leaves `tail` as it was. */
void *scr_rc_destroy_seg(void *obj, void *(*destroy_seg)(void *, void *),
                         void (*destroy)(void *), void *tail);

/* RC hooks for cycle-headered types. on_release: rc was decremented and
 * stayed above zero — buffer the object as a possible cycle root (may run
 * a collection when the buffer crosses the threshold; the caller must not
 * touch the object afterwards). on_dead: rc hit zero — drop any buffer
 * entry BEFORE tearing the object down. Retains need no hook: a candidate
 * re-retained after it was buffered simply stays a candidate, and the pass
 * that walks it finds it externally referenced. */
void scr_cyc_on_release(void *obj);
void scr_cyc_on_dead(void *obj);
/* A set of object pointers for scr_cyc_collect_set: open addressing over
 * `mask + 1` slots (a power of two), NULL marking an empty slot. */
typedef struct {
  void **slots;
  size_t mask;
} ScrCycSet;
static inline size_t scr_cyc_set_slot(const void *obj, size_t mask) {
  return (size_t)(((uintptr_t)obj >> 3) * 0x9E3779B97F4A7C15ull >> 20) & mask;
}
static inline bool scr_cyc_set_has(const ScrCycSet *set, const void *obj) {
  for (size_t j = scr_cyc_set_slot(obj, set->mask);; j = (j + 1) & set->mask) {
    if (set->slots[j] == obj) return true;
    if (set->slots[j] == NULL) return false;
  }
}
/* One full-depth pass over only the candidates in `set`, taken from the
 * buffers of generations up to `gen` (the others keep their slots and are
 * not touched); returns how many objects it freed. It leaves the
 * schedule's baselines alone. */
size_t scr_cyc_collect_set(const ScrCycSet *set, unsigned gen);
/* Publication's buffer hooks (scr_publish.c): take a buffered object out
 * of its buffer (returns its index), put it back at `index`, and close the
 * slots taken since the last fill that are still empty. */
uint32_t scr_cyc_pub_take(void *obj);
void scr_cyc_pub_restore(void *obj, uint32_t index);
void scr_cyc_pub_fill(void);

/* The candidate buffers, one per generation (scr_cycle.c), and the window
 * through which a release buffers a nursery candidate on its fast path. A
 * release that leaves an unbuffered nursery object alive appends it to the
 * nursery buffer while that buffer holds fewer than `window` entries and the
 * live count is below `alloc_trigger` (scr_cyc_append); anything else takes
 * the full scr_cyc_on_release. scr_cycle.c keeps `window` at most at the
 * number of nursery entries the buffers can hold before a collection falls
 * due or the buffer must grow, and at 0 while a pass runs, so the append is
 * exactly what scr_cyc_on_release would do with a nursery candidate. A
 * candidate whose type bypasses the nursery is moved past it before the
 * buffers are next read (scr_cycle.c, "level bypass").
 *
 * The runtime's own release paths append inline (scr_cyc_released), and
 * scr_cyc_on_release tries the append first. The layout is an ABI:
 * optimized emitted code appends through a per-module helper
 * (llvm/alloc.ts cycleAppendHelper) that addresses roots[0].v, roots[0].n,
 * window and alloc_trigger at fixed offsets. Builds whose collector state
 * is thread-local (worker executables, thread-instanced libraries) never
 * append on a fast path. */
typedef struct ScrCycBuffer {
  void **v;
  size_t n, cap;
  /* The most entries a pass held, for the work vectors a pass fills
   * (scr_cycle.c ScrVec); unused by the candidate buffers. */
  size_t used;
} ScrCycBuffer;
typedef struct ScrCycBuffers {
  ScrCycBuffer roots[SCR_CYC_NGENS];
  size_t window;
  size_t alloc_trigger;
} ScrCycBuffers;
#if !defined(SCR_WORKERS) && !(defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
#define SCR_CYC_INLINE_BUFFERING 1
extern ScrCycBuffers scr_cyc_buffers;
#if UINTPTR_MAX == UINT64_MAX
_Static_assert(offsetof(ScrCycBuffers, roots) == 0 && offsetof(ScrCycBuffer, v) == 0 &&
                   offsetof(ScrCycBuffer, n) == 8 && offsetof(ScrCycBuffers, window) == 96 &&
                   offsetof(ScrCycBuffers, alloc_trigger) == 104,
               "llvm/alloc.ts appends nursery candidates against this layout");
#endif
/* Append the unbuffered object `obj` (header `h`) to the nursery buffer if
 * it is a nursery object and the window allows; false leaves it to the rest
 * of scr_cyc_on_release. */
static inline bool scr_cyc_append(ScrCycHdr *h, void *obj) {
  ScrCycBuffer *nursery = &scr_cyc_buffers.roots[SCR_CYC_NURSERY];
  size_t n = nursery->n;
  if (scr_cyc_gen(h) != SCR_CYC_NURSERY || n >= scr_cyc_buffers.window ||
      scr_cyc_live >= scr_cyc_buffers.alloc_trigger)
    return false;
  nursery->v[n] = obj;
  nursery->n = n + 1;
  scr_cyc_set_buffered(h, (uint32_t)n);
  return true;
}
#else
#define SCR_CYC_INLINE_BUFFERING 0
#endif

/* Inline halves of the hooks for runtime release paths, mirroring the
 * emitted ones (llvm/shapes.ts): a release of an already-buffered
 * object, and the death of an object that was never buffered, need no call,
 * and a nursery candidate is appended inline while the window allows.
 * Most releases of long-lived containers take the first early return. */
static inline void scr_cyc_released(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  if (scr_cyc_release_done(h)) return;
#if SCR_CYC_INLINE_BUFFERING
  if (scr_cyc_append(h, obj)) return;
#endif
  scr_cyc_on_release(obj);
}
static inline void scr_cyc_dead(void *obj) {
  if (scr_cyc_is_buffered(scr_cyc_hdr(obj))) scr_cyc_on_dead(obj);
}

/* Full sweep: trial-deletion passes over EVERY generation, to a fixpoint.
 * This is the exit / session-reset entry point (the RC audit runs straight
 * after and wants nothing reclaimable left), and it costs a walk of the
 * live heap — do not put it on a per-turn path. */
void scr_collect_cycles(void);
void scr_collect_cycles_phase(void);
/* Sets the growth cap SCR_CYCLE_GROWTH_CAP sets (scr_cycle.c), for a program
 * that knows its own memory profile; the environment variable takes
 * precedence. Call it before the program allocates much. */
void scr_cyc_set_growth_cap(long cap);
/* Sets the nursery trigger SCR_CYCLE_THRESHOLD sets (scr_cycle.c): the
 * number of new candidates at which the release path runs a pass, for a
 * program that knows its own collection profile. The environment variable
 * takes precedence; 0 restores the default, which starts at 256 and adapts
 * to the program. The trigger re-arms with it at the end of the next pass.
 * Call it before the program allocates much. */
void scr_cyc_set_nursery_threshold(long threshold);
void scr_cyc_context_cleanup(void);

/* One pass on the normal generational schedule, for callers that reach a
 * natural collection point rather than a threshold (the event loop between
 * turns). Cheap: usually a nursery pass; a waiting mature backlog ages into
 * a bounded full pass so sparse roots cannot float forever. */
void scr_cyc_collect_scheduled(void);
/* The thread's event loop runs (scr_loop_run): from now on a full pass the
 * death rule asks for waits for scr_cyc_collect_idle. */
void scr_cyc_note_event_loop(void);
/* The event loop is about to wait with nothing ready: runs the full pass
 * the death rule asked for, if one waits; returns whether it ran. */
bool scr_cyc_collect_idle(void);

/* Publication (@scriptc/threads publish; scr_cycle.c): makes everything a
 * root reaches immortal and immutable. Compiler-emitted per-type walkers
 * mark their object (scr_pub_mark: false when already immortal) and push
 * their references; containers, strings and dyn subgraphs have runtime
 * walkers. scr_publish throws a TypeError, leaving the graph unchanged,
 * when it reaches an unpublishable dyn value. */
typedef struct ScrPub ScrPub;
typedef void (*ScrPubFn)(void *v, ScrPub *ctx);
/* What a marked object is, for the RC audit's live counts (scr_pub_mark). */
enum {
  SCR_PUB_KIND_LEAF = 0, /* not counted (bigints) */
  SCR_PUB_KIND_STRING = 1,
  SCR_PUB_KIND_ARRAY = 2,
  SCR_PUB_KIND_MAP = 3,
  SCR_PUB_KIND_OBJECT = 4,
  SCR_PUB_KIND_UNION = 5,
  SCR_PUB_KIND_DYN = 6,
  /* Or'ed into a kind: an object whose rc word keeps its class id in
   * the high half (SCR_RC_COUNT). The mark, and a refusal's restore, write
   * only the count. */
  SCR_PUB_CLASS_ID = 0x100,
  /* Or'ed into a kind: a compact class instance (SCR_RC_COMPACT_TAG). The
   * mark sets SCR_RC_COMPACT_PUBLISHED; a refusal's restore writes the
   * logged word back. */
  SCR_PUB_COMPACT = 0x200,
};
void scr_publish(void *root, ScrPubFn fn);
void scr_pub_push(ScrPub *ctx, void *v, ScrPubFn fn);
bool scr_pub_mark(ScrPub *ctx, void *obj, bool cyc, int kind);
void scr_pub_refuse(ScrPub *ctx, const char *message);
void scr_pub_refuse_at(ScrPub *ctx, const char *message, const char *detail);
void scr_pub_str_fn(void *v, ScrPub *ctx);
void scr_pub_leaf_fn(void *v, ScrPub *ctx);
void scr_pub_dyn_fn(void *v, ScrPub *ctx);
void scr_pub_arr(void *v, ScrPub *ctx, ScrPubFn elem);
void scr_pub_map(void *v, ScrPub *ctx, ScrPubFn key, ScrPubFn val);
void scr_publish_refuse(const char *message);
/* Writes into published or frozen objects (emitted guards): Node's
 * frozen-object TypeErrors. The array guards answer false (and throw
 * nothing) when Node's operation would not write the array; their ops are
 * scr_array_frozen_error's (scr_array.h). */
struct ScrArr;
SCR_COLD void scr_throw_published_field(const char *prop, const char *owner);
bool scr_throw_published_array(int op, const struct ScrArr *a, double index, double n);
bool scr_throw_published_array_range(int op, const struct ScrArr *a, double x, double y, double z);
SCR_COLD void scr_throw_published_collection(bool set);

/* Young-in nursery (scr_cycle.c built with SCR_YIN, linked by programs
 * compiled with SCRIPTC_YOUNG_NURSERY=1). A young object's header has
 * generation SCR_CYC_YOUNG, above every trial-deletion level, and its
 * nursery index in `buf` under SCR_CYC_BUFFERED_BIT, so release paths treat
 * it as a buffered candidate (no call on a release that leaves it alive,
 * scr_cyc_on_dead at its death). Emitted constructors of compiled classes
 * and records call scr_yin_enter on each new object, after storing its
 * count; the call may collect the nursery first. */
#define SCR_CYC_YOUNG 3
void scr_yin_enter(void *obj);
/* The inline entry's halves: the per-registry-id countdown of allocations
 * that skip the nursery (process-wide in executables without workers,
 * which are the ones that inline the entry), and the append when the
 * nursery has no room. */
extern uint32_t scr_yin_skip[SCR_CYC_MAX_TYPES];
void scr_yin_enter_slow(void *obj);
/* The nursery: live young objects v[0..n), capacity cap. Its layout is an
 * ABI: emitted constructors (llvm/shapes.ts youngEntryLines) append inline
 * while n < lim, writing the header themselves, and call scr_yin_enter
 * otherwise; lim stays at most the capacity and the collection size. */
typedef struct ScrYin {
  void **v;
  size_t n;
  size_t lim;
  size_t cap;
} ScrYin;
extern SCR_TL ScrYin scr_yin;
#if UINTPTR_MAX == UINT64_MAX
_Static_assert(offsetof(ScrYin, n) == 8 && offsetof(ScrYin, lim) == 16,
               "llvm/shapes.ts appends to the nursery at these offsets");
#endif

#endif /* SCR_RC_H */
