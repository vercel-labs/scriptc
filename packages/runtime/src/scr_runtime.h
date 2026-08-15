/* scriptc runtime — public API.
 * Every scriptc binary compiles these sources in; there is no shared library.
 *
 * Prefix conventions: the runtime owns "scr_" and "SCR_" macros/"Scr" type names.
 * Compiler-emitted symbols use "sc_f_" (functions), "sc_l_" (locals),
 * "sc_t" (temps) and never collide.
 */
#ifndef SCR_RUNTIME_H
#define SCR_RUNTIME_H

#include <stdarg.h>  /* va_list in the emitter listener adapters */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>    /* memcpy in the inline slot accessors */
#include <sys/types.h> /* ssize_t in the transport ops table */

/* ── libc shims ─────────────────────────────────────────────────────────
 * Win32's missing POSIX/BSD functions live in scr_win.c. Zig's musl sysroot
 * additionally lacks arc4random_buf; scr_musl.c supplies it from Linux's
 * getrandom syscall. Both files are selected by cc.ts only for their target. */
#ifdef _WIN32
#include <time.h> /* time_t / struct tm for the gmtime_r shim */
char *stpcpy(char *dst, const char *src);
void arc4random_buf(void *buf, size_t n);
struct tm *gmtime_r(const time_t *t, struct tm *out);
char *strcasestr(const char *hay, const char *needle);
#elif defined(SCR_MUSL)
void arc4random_buf(void *buf, size_t n);
#endif

/* ── thread-instanced library state ─────────────────────────────────────
 * Archives built under the profile's abi.instance_per_thread compile every
 * TU with -DSCR_THREAD_INSTANCES, and SCR_TL moves each unit's mutable
 * state — and the emitted program's globals — into thread-local storage.
 * A thread that calls the profile's init entry then owns a complete,
 * independent instance: its own collector, result arena, panic-sink
 * registration, poison flag, and program state. The instance's lifetime is
 * the thread's; the one-thread-per-instance contract (an instance is never
 * entered from two threads) is unchanged — this mode adds instances, not
 * thread awareness. Expands to nothing everywhere else, so executable
 * builds and classic library builds carry the exact bytes they always
 * carried. Truly immutable tables (static const data) stay shared. */
#if defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES)
#define SCR_TL _Thread_local
#else
#define SCR_TL
#endif

/* ── process ──────────────────────────────────────────────────────────── */

/* Called once at the top of main: private stdout formatter buffer,
 * flush-at-exit, RC audit registration (when built with -DSCR_RC_AUDIT).
 * JavaScript-visible writes flush before returning. */
void scr_init(void);

/* ── the trap funnel (scr_console.c; scr_library.c under -DSCR_LIB) ──────
 * Every unrecoverable runtime trap — OOM, semantic range traps, internal-
 * invariant failures — funnels through this pair instead of open-coded
 * fputs/fprintf + abort. Executable builds expand to exactly the historical
 * behavior (the message's bytes on stderr, then abort — the default lane
 * must not change by a byte). Library builds (-DSCR_LIB) route the message to
 * the host-registered panic sink and abort only as the last resort: before
 * registration, or if the sink returns (the ruled host-contract violation —
 * a conforming sink longjmps to a host frame BELOW the entry, never back
 * into library frames). Messages keep their trailing newline in both lanes;
 * the library funnel additionally assembles every DETECTED trap into the
 * structured trap-teaching form before delivery (a message that already
 * begins with the 0x01 marker passes verbatim) — see ScrLibSinkFn below. */
_Noreturn void scr_trap(const char *msg);
_Noreturn void scr_trap_fmt(const char *fmt, ...);

/* ── library mode (scr_library.c, linked only into library artifacts) ─────
 * A library artifact has no main, no event loop, no signal handlers, no
 * atexit registrations, and never touches host stdio modes or buffering:
 * initialization runs inside the profile-named init entry (re-runnable
 * deterministically), traps route to the sink above, and buffer-class
 * results live in a library-owned result arena. Everything here compiles only
 * under -DSCR_LIB; executable builds never contain it. */
#ifdef SCR_LIB
typedef struct ScrStr ScrStr;     /* full definitions below (C11 repeat) */
typedef struct ScrBytes ScrBytes;
/* The host's panic sink: msg is UTF-8, valid only for the duration of the
 * call; address is the trap site's return address (0 when the toolchain
 * cannot supply one); ctx is the registration's opaque pointer. The sink
 * must not call back into any library entry and must not unwind or longjmp
 * back into library frames.
 *
 * Message shape (the ratified structured trap-teaching encoding): a
 * BASELINE message is plain text whose first byte is printable (>= 0x20) —
 * no emitter path ever produces an unstructured message starting below
 * 0x20. A STRUCTURED message begins with the marker byte 0x01 followed by
 * the human teaching text and 0x1F-separated fields:
 *
 *   0x01  text  0x1F code  0x1F symbol  [ 0x1F remediation ]
 *
 * so msg_len > 0 && msg[0] == 0x01 is the one version test. Parse: split
 * the bytes after the marker on 0x1F — field 0 is the human text, 1 the
 * diagnostic code, 2 the trapping symbol as the host linked it, 3 the
 * remediation; a missing or empty field means none; ignore any field past
 * the fourth. Fields are (pointer, length) — never assume NUL termination.
 * A plain-text host may print the whole buffer: the teaching leads it.
 *
 * Every trap the runtime DETECTS arrives structured: the funnel assembles
 * the baseline human line into field 0 unchanged, a stable code for the
 * trap kind (the compiler registry's runtime family — SC4013–SC4019 plus
 * the SC4025 unregistered-callback trap, classified in scr_library.c), the
 * entry symbol recorded by the trapping
 * entry's prologue, and the profile's remediation for that code when the
 * program TU's overlay table declares one (the whole fourth field is
 * absent otherwise). A message that already begins with the marker — a
 * facade-authored structured throw, or the wrapper's compile-time-
 * assembled SC4012 contract trap — passes through byte-for-byte. */
typedef void (*ScrLibSinkFn)(void *ctx, const uint8_t *msg, size_t msg_len,
                              uint64_t address);
void scr_library_set_sink(ScrLibSinkFn fn, void *ctx); /* latest wins */

/* ── host-callback channels ───────────────────────────────────────────────
 * The panic sink's registration pattern generalized into a synchronous
 * outbound seam: the profile declares named channels (bytes/scalar
 * signatures), the generated registration symbol maps a channel name to a
 * slot index here, and compiled call sites fetch the slot through
 * scr_library_cb_require — which returns the host's pointer or delivers
 * the call site's trap message through the funnel (the SC4025 detected
 * trap) when the host never registered. The typed shape of each stored
 * pointer is the channel's, with the opaque context first:
 *
 *   <ret> (*)(void *ctx, <params...>)
 *
 * Registration is a pure store like the sink's (no entry prologue, no
 * poison guard, legal before init); latest wins, NULL clears, and
 * registrations persist across init/reset. Slots are per-copy of this
 * state, exactly the sink's story: per-archive under abi.localize_runtime,
 * per-thread instance under abi.instance_per_thread (SCR_TL) — a callback
 * registered on thread T fires only for T's instance. The host's callback
 * runs on the calling thread inside the entry's dynamic extent and must
 * NOT call back into any library entry (registration symbols included) or
 * unwind/longjmp across library frames: read the borrowed buffers, copy
 * what outlives the call, return. Buffer parameters are borrowed for the
 * duration of the call only. */
#define SCR_LIB_MAX_CALLBACKS 32 /* keep in step with LIB_MAX_CALLBACKS (library/profile.ts) */
/* The stored shape: generated call sites cast a slot's pointer to the
 * channel's typed shape before calling. */
typedef void (*ScrLibCbFn)(void);
void scr_library_cb_set(size_t slot, ScrLibCbFn fn, void *ctx);
/* The call-site fetch: the registered pointer, or the funnel trap with
 * trap_msg (never returns NULL). */
ScrLibCbFn scr_library_cb_require(size_t slot, const char *trap_msg);
void *scr_library_cb_ctx(size_t slot);

/* Entry prologue: aborts deterministically when the library is poisoned (a
 * trap already fired — no profile entry may run again; recovery is process
 * restart). reset_arena additionally drops the result arena (the
 * auto-reset posture, and the reset/collect entries' shared body).
 * entry_symbol is the generated entry's external symbol exactly as the
 * host linked it (a static string in the program TU): the prologue records
 * it in the funnel's current-entry slot so a detected trap's structured
 * message can name the trapping entry — sound as a single static slot
 * because exactly one core is ever live and entries never nest. Init and
 * the mode entries (reset, collect) record theirs too; the identity
 * getters and sink registration touch no runtime and never trap. */
void scr_library_entry(bool reset_arena, const char *entry_symbol);
void scr_library_arena_reset(void);
/* The mode-provided collect entry's body: arena reset + a full cycle
 * collection (snapshot-invariant by construction — collection frees only
 * unreachable cycles). */
void scr_library_collect(void);

/* Full session reset, called by the generated init entry AFTER the program
 * TU released and zeroed its globals: pending-exception clear, arena
 * reset, the reset registry's drains (the units' repointed atexit halves),
 * the library's interned process values, a cycle collection, and — under
 * SCR_RC_AUDIT — the zero-live-heap assertion (a failure is a trap through
 * the sink, never _Exit). */
void scr_library_reset(void);
/* Where a unit would atexit() a lazy teardown, library builds register it
 * here instead (called on every scr_library_reset, registered once). */
void scr_library_register_reset(void (*fn)(void));
/* An escaped exception at an entry boundary: renders the same "Uncaught
 * ..." text the executable epilogue prints, releases the payload, and
 * routes the text through the trap funnel. No-op when nothing is pending.
 * The ratified verbatim rule: a thrown message that ALREADY begins with the
 * structured marker 0x01 (a thrown string, or an Error whose .message
 * starts with it) is delivered byte-for-byte — no "Uncaught " prefix, no
 * added newline — which is how facade-authored structured teachings ride
 * the throw channel to the sink. Defined in scr_exception.c (it owns the
 * cell). */
void scr_library_check_exc(void);

/* The length-taking funnel entry (library lane only): delivers exactly the
 * given bytes to the sink — the verbatim path above needs it because a
 * structured message is length-delimited, never NUL-scanned. */
_Noreturn void scr_trap_len(const char *msg, size_t len);

/* The runtime-trap overlay table, DEFINED by the generated program TU
 * (both emissions emit identical data) and consumed by the funnel when it
 * assembles a detected trap's structured message: flat triples of
 * (code, teaching-or-NULL, remediation-or-NULL), one per runtime trap code
 * (the SC4013–SC4019 family plus SC4025) the profile declares text for;
 * _len counts triples. A declared teaching replaces the baseline human line as field 0;
 * a declared remediation becomes the optional fourth field. */
extern const char *const scr_library_trap_overlays[];
extern const size_t scr_library_trap_overlays_len;

/* Marshalling helpers the generated wrappers call (both emissions share
 * these bodies, which is how the two lanes stay identical by
 * construction). Inbound is borrowed-and-copied; outbound values MOVE into
 * the result arena and stay valid until the next arena reset. String
 * results are NUL-terminated after *out_len bytes (ScrStr's layout). */
ScrStr *scr_library_str_in(const uint8_t *p, size_t len);   /* +1 */
/* trap_msg is the wrapper's compiler-assembled host-contract trap message
 * (structured trap-teaching bytes naming this entry's symbol), delivered
 * through the funnel when len falls outside the marshalling class. */
ScrBytes *scr_library_bytes_in(const uint8_t *p, size_t len, const char *trap_msg); /* +1, u8 */
/* The inbound declared-integer edge (ask 4's i64/u64 parameter classes):
 * exact conversion for |v| <= 2^53-1, the host-contract trap (same
 * assembled SC4012 message shape as the bytes trap) past it — silent
 * rounding is a coercion the author never wrote. */
double scr_library_i64_in(int64_t v, const char *trap_msg);
double scr_library_u64_in(uint64_t v, const char *trap_msg);
void scr_library_str_out(ScrStr *s, const uint8_t **out, size_t *out_len);
void scr_library_bytes_out(ScrBytes *b, const uint8_t **out, size_t *out_len);

#define scr_atexit(fn) scr_library_register_reset(fn)
#else
#define scr_atexit(fn) atexit(fn)
#endif /* SCR_LIB */

/* ── cycle collection (scr_cycle.c) ───────────────────────────────────
 * Reference counting alone cannot free cycles, so every object that can
 * participate in one — capture boxes, heap closures, unions, promises, and
 * compiler-emitted class/record shapes with cycle-capable fields — is
 * allocated with a hidden header directly BEFORE the object: a trace
 * function (enumerates the object's cycle-capable children), a teardown
 * function (frees the object WITHOUT releasing traced children), and the
 * trial-deletion bookkeeping (color + candidate-root buffer state). Types
 * that can never be in a cycle — strings above all, plus arrays of scalar/
 * string/bytes elements, dyn trees, and shapes whose fields are all acyclic
 * — keep the lean 1-word `rc` header and pay nothing. Arrays and maps are
 * cycle-capable exactly when their element/value type is (a record element
 * can point back at the array holding it).
 *
 * The collector is synchronous Bacon–Rajan trial deletion: a release that
 * leaves a candidate's rc above zero buffers it as a possible cycle root;
 * collection walks the buffer (markGray: trial-decrement internal edges;
 * scan: restore externally-referenced subgraphs; collectWhite: free the
 * dead cycle members, releasing only edges that LEAVE the white set).
 * It is GENERATIONAL: each header carries a generation, a pass names the
 * oldest one it will walk, and objects that survive a pass are promoted out
 * of the nursery so later nursery passes never re-walk them. That is what
 * keeps a pass proportional to recent allocation rather than to the whole
 * live heap — see the generation note in scr_cycle.c for the soundness
 * argument and the schedule. Collection points: program exit (before the RC
 * audit), event-loop quiescence, and the per-generation triggers.
 * SCR_CYCLE_THRESHOLD pins the nursery trigger to a fixed candidate count.
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

/* DOOMED is WHITE that collectWhite has already gathered: it stops the
 * gather recursing twice, and distinguishes "about to be freed" from a
 * survivor for the re-buffering step (see scr_cycle.c). */
enum {
  SCR_CYC_BLACK = 0, SCR_CYC_PURPLE = 1, SCR_CYC_GRAY = 2, SCR_CYC_WHITE = 3,
  SCR_CYC_DOOMED = 4
};

/* Generations. A candidate sits in the buffer named by its own `gen`, and a
 * pass walks only objects at or below the generation it collects. */
enum { SCR_CYC_NURSERY = 0, SCR_CYC_MATURE = 1, SCR_CYC_NGENS = 2 };

typedef struct ScrCycHdr {
  ScrTraceFn trace;
  ScrCycFreeFn free_fn;
  uint32_t color;    /* SCR_CYC_* */
  uint16_t buffered; /* 1 = sitting in its generation's candidate buffer */
  uint16_t gen;      /* SCR_CYC_NURSERY..SCR_CYC_MATURE (the walk filter) */
  size_t buf_index;  /* position there (O(1) removal when rc hits 0) */
} ScrCycHdr;

/* This layout is an ABI, not an implementation detail. The LLVM backend
 * inlines scr_cyc_mark_live as a raw `store i32 0`: color is at obj-16 on
 * 64-bit targets and obj-12 on wasm32. Three sites emit it —
 * llvm/shapes.ts, llvm/classes.ts, and llvm/emitter.ts. Nothing but `color`
 * may share those four bytes: a field placed in them is silently zeroed by
 * every retain, which is invisible to the type system and to the C
 * compiler. Hence the target-width assertions. */
#if UINTPTR_MAX == UINT64_MAX
_Static_assert(sizeof(ScrCycHdr) == 32, "LLVM backend expects a 32-byte cycle header");
_Static_assert(offsetof(ScrCycHdr, color) == 16,
               "LLVM backend's inlined mark-live stores i32 0 at obj-16");
#elif UINTPTR_MAX == UINT32_MAX
_Static_assert(sizeof(ScrCycHdr) == 20, "LLVM backend expects a 20-byte cycle header");
_Static_assert(offsetof(ScrCycHdr, color) == 8,
               "LLVM backend's inlined mark-live stores i32 0 at obj-12");
#endif
_Static_assert(sizeof(((ScrCycHdr *)0)->color) == 4,
               "mark-live is an i32 store: color must own all four bytes");
_Static_assert(SCR_CYC_BLACK == 0,
               "the emitted mark-live stores the LITERAL 0, not the enumerator "
               "— reordering the colors would make every compiled retain write "
               "the wrong one");

static inline ScrCycHdr *scr_cyc_hdr(void *obj) { return (ScrCycHdr *)obj - 1; }

/* Zeroed allocation with a cycle header in front; returns the OBJECT
 * pointer (header at scr_cyc_hdr). Aborts on OOM. */
void *scr_cyc_alloc(size_t size, ScrTraceFn trace, ScrCycFreeFn free_fn);
void scr_cyc_free(void *obj); /* frees the block, header included */

/* RC hooks for cycle-headered types. on_release: rc was decremented and
 * stayed above zero — buffer the object as a possible cycle root (may run
 * a collection when the buffer crosses the threshold; the caller must not
 * touch the object afterwards). on_dead: rc hit zero — drop any buffer
 * entry BEFORE tearing the object down. mark_live: retain hook (a
 * re-retained candidate is certainly not garbage). */
void scr_cyc_on_release(void *obj);
void scr_cyc_on_dead(void *obj);
static inline void scr_cyc_mark_live(void *obj) {
  scr_cyc_hdr(obj)->color = SCR_CYC_BLACK;
}

/* Full sweep: trial-deletion passes over EVERY generation, to a fixpoint.
 * This is the exit / session-reset entry point (the RC audit runs straight
 * after and wants nothing reclaimable left), and it costs a walk of the
 * live heap — do not put it on a per-turn path. */
void scr_collect_cycles(void);

/* One pass on the normal generational schedule, for callers that reach a
 * natural collection point rather than a threshold (the event loop between
 * turns). Cheap: usually a nursery pass; a waiting mature backlog ages into
 * a bounded full pass so sparse roots cannot float forever. */
void scr_cyc_collect_scheduled(void);

/* ── class hierarchies (single inheritance) ───────────────────────────
 * Classes in an `extends` hierarchy share a two-word object prefix: the
 * usual `size_t rc`, then a pointer to the class's static vtable (emitted
 * per class by the compiler; standalone classes carry no vtable word and
 * none of this applies). A derived class embeds its base's fields as a
 * layout PREFIX, so an upcast is a pointer reinterpret and base-field
 * offsets agree through any static type.
 *
 * The vtable begins with this header; the compiler-emitted concrete
 * per-hierarchy struct appends one member per virtual method slot (only
 * methods actually overridden somewhere get slots — never-overridden
 * methods keep direct static calls). `pre`/`post` are the class's preorder
 * interval in the whole-program class forest: `x instanceof C` is the O(1)
 * range check `C.pre <= x->vt->pre && x->vt->pre <= C.post`. `release` is
 * the class's own whole-object release: releasing through a base-typed
 * pointer must tear down the DERIVED object's fields, so the emitted
 * release of every hierarchy class dispatches through the stored vtable
 * (retain needs no dispatch — rc is at offset 0 in every layout). The
 * cycle collector needs no vtable involvement: a cycle-capable hierarchy
 * object's header trace/teardown are stamped with the concrete class's
 * functions at allocation, which already is dynamic dispatch. */
typedef struct ScrVt {
  size_t pre, post;
  void (*release)(void *obj);
} ScrVt;

/* ── strings ──────────────────────────────────────────────────────────
 * UTF-8 bytes, refcounted, immutable. rc == SIZE_MAX marks an immortal
 * interned literal (emitted as a static object; retain/release are no-ops).
 * data is NUL-terminated for C convenience; len excludes the NUL.
 *
 * cap is the usable byte capacity of data[] excluding the NUL (allocation
 * is sizeof(ScrStr) + cap + 1); cap == len for interned literals and plain
 * allocations. Spare capacity (cap > len) exists only on concat results so
 * scr_str_concat can append in place when the left operand is uniquely
 * owned (rc == 1) — observable immutability is preserved: a string with
 * rc > 1 or rc == SIZE_MAX is never mutated.
 */
typedef struct ScrStr {
  size_t rc;
  size_t len;
  size_t cap;
  char data[];
} ScrStr;

ScrStr *scr_str_new(const char *bytes, size_t len); /* returns +1 */

/* Internal allocators for buffer builders (scr_json.c): a +1 string with
 * UNINITIALIZED data (the builder fills bytes, then len and the NUL), and
 * an rc==1-only realloc that grows capacity in place. Both keep the RC
 * audit's live count exact. */
ScrStr *scr_str_alloc_raw(size_t len, size_t cap);
ScrStr *scr_str_regrow(ScrStr *s, size_t newcap);

static inline ScrStr *scr_str_retain(ScrStr *s) {
  if (s->rc != SIZE_MAX) s->rc++;
  return s;
}

void scr_str_release(ScrStr *s); /* NULL-tolerant (uninitialized locals) */

/* Borrow both args, return +1. */
ScrStr *scr_str_concat(ScrStr *a, ScrStr *b);

bool scr_str_eq(ScrStr *a, ScrStr *b);

/* memcmp byte order == code-point order (see SEMANTICS.md: diverges from
 * JS UTF-16 code-unit order only for non-BMP vs U+E000..U+FFFF). Returns
 * <0, 0, >0. */
int scr_str_cmp(ScrStr *a, ScrStr *b);

/* ECMAScript string-list ordering: compare UTF-16 code units even though
 * ScrStr stores well-formed UTF-8. Returns <0, 0, >0. */
int scr_str_cmp_u16(ScrStr *a, ScrStr *b);

/* ── class objects (classes as first-class values) ────────────────────
 * The class STATIC side as a runtime value: one emitted IMMORTAL static
 * per class the program takes as a value (`const X = C`, class
 * expressions, constructor-typed slots). One struct type covers every
 * class — the fields are class-independent — so containers and casts
 * never need per-class knowledge. `pre`/`post` are the SAME preorder
 * numbering the vtables carry (compile-time constants in the emitted
 * initializer), so `x instanceof X` through a value is the usual O(1)
 * interval check with the interval loaded from the class object. `ctor`
 * is the emitted construct thunk — the class's own completed-constructor
 * ABI returning `void *` (the compiler's flow rules guarantee every value
 * in a slot shares one ABI); `name` is the JS-observable `.name` string
 * (an interned immortal literal). rc is always SIZE_MAX: retain/release
 * are no-ops (the regex-literal discipline), the object holds no
 * references, and it can never be part of a cycle (trace = NULL). */
typedef struct ScrClassObj {
  size_t rc; /* SIZE_MAX — every class object is an immortal static */
  size_t pre, post;
  void *ctor;
  const ScrStr *name;
} ScrClassObj;

static inline ScrClassObj *scr_classobj_retain(ScrClassObj *c) {
  if (c->rc != SIZE_MAX) c->rc++;
  return c;
}
static inline void scr_classobj_release(ScrClassObj *c) {
  (void)c; /* immortal (NULL-tolerant like every release) */
}
/* void*-signature RC adapters (container slots) — scr_object.c. */
void *scr_classobj_retain_v(void *c);
void scr_classobj_release_v(void *c);
/* `X.name` (+1 — a no-op retain on the interned immortal). */
ScrStr *scr_classobj_name(ScrClassObj *c);
/* The keyed-write miss on a fixed-shape record: throws the catchable
 * TypeError naming the key (JS would add the property — the documented
 * monomorphic-struct divergence). scr_object.c. */
void scr_record_key_miss(ScrStr *k);

/* ── error objects (scr_error.c) ──────────────────────────────────────
 * `Error` and its lib subclasses (TypeError/RangeError/SyntaxError) are a
 * RUNTIME-PROVIDED hierarchy: ScrError lays out exactly like a compiler-
 * emitted hierarchy class (rc, vt, then the fields), so `class MyError
 * extends Error` compiles as an ordinary derived class whose struct embeds
 * this prefix, and every vtable mechanism (base-typed release, preorder-
 * interval instanceof) applies unchanged.
 *
 * The four builtin classes' vtables live HERE as mutable globals because
 * the runtime itself creates error instances (JSON/dynCheck/regex failures,
 * the island bridge) — but their preorder intervals depend on the whole
 * program's class forest, which only the compiler knows. Every emitted
 * main() stamps pre/post into these vtables before user code runs (the
 * defaults below only cover the moments before that), so runtime-made and
 * compiler-made error objects always agree on instanceof.
 *
 * Cycle capability is hierarchy-uniform and program-dependent (a user
 * subclass may hold closures): when the compiler's fixpoint marks the Error
 * hierarchy cycle-capable, main() also calls scr_error_set_traced() and
 * the runtime allocates its own error objects with collector headers. */
typedef struct ScrError {
  size_t rc;
  const ScrVt *vt;
  ScrStr *name;    /* "TypeError", or whatever the user assigned */
  ScrStr *message; /* "" when constructed without one, like Node */
  ScrStr *code;    /* NULL = absent (Node: no `code` property); fs/exec
                    * throw sites stamp the errno name ("ENOENT"). Part of
                    * the layout prefix: the compiler's %Error class defs
                    * carry a matching third field, so user subclasses
                    * embed the slot and release it NULL-guarded. */
} ScrError;

enum {
  SCR_ERR_ERROR = 0,
  SCR_ERR_TYPE = 1,
  SCR_ERR_RANGE = 2,
  SCR_ERR_SYNTAX = 3,
  SCR_ERR_DOMEX = 4, /* DOMException — ScrDomException, the wider layout */
};

extern SCR_TL ScrVt scr_error_vts[5]; /* indexed by SCR_ERR_*; main() stamps pre/post */

struct ScrDyn; /* full declaration below (the checked-dynamic tree section) */

/* DOMException: the ScrError prefix (identical member order — an upcast is
 * a pointer reinterpret) plus the WebIDL slots. The extra slots are HIDDEN
 * from the compiler's IR field list (user `extends DOMException` is fenced
 * so no subclass layout ever overlaps them); reads go through the
 * scr_domex_* accessors. */
typedef struct ScrDomException {
  size_t rc;
  const ScrVt *vt;
  ScrStr *name;    /* "Error" default, or the resolved WebIDL name */
  ScrStr *message; /* "" when constructed without one */
  ScrStr *code;    /* the Node string-code slot (stays NULL here) */
  double dom_code; /* the WebIDL legacy code (0 when the name is off-table) */
  bool has_cause;  /* the options form carried a `cause` member */
  struct ScrDyn *cause; /* owned; NULL when has_cause is false */
} ScrDomException;

/* new DOMException(message?, nameOrOptions?) — both dyn args borrowed,
 * NULL-tolerant (NULL = absent = the dyn undefined). Returns +1. Never
 * throws (dyn ToString is total). Lives in scr_json.c (the args are dyn
 * values); the dyn-free half below stays in scr_error.c so the error
 * unit links without the checked-dynamic tree. */
ScrError *scr_domex_new(const struct ScrDyn *message, const struct ScrDyn *name_or_options);
/* scr_error.c's dyn-free DOMException half: the blank allocation the
 * constructors fill, the WebIDL name→legacy-code table, and the cause
 * teardown hook scr_json.c installs before any cause can exist. */
ScrError *scr_domex_alloc(void);
double scr_domex_code_of(const ScrStr *name);
void scr_domex_install_cause_drop(void (*fn)(void *obj));
double scr_domex_code(ScrError *e);           /* borrowed receiver */
bool scr_domex_has_cause(ScrError *e);        /* borrowed receiver */
struct ScrDyn *scr_domex_cause(ScrError *e);  /* +1 (dyn undefined when absent) */
/* structuredClone of a DOMException: WebIDL serialization — name/message
 * copy, the code re-derives, cause does not serialize. Borrowed receiver
 * and options (validated; throws on bad options / non-empty transfer).
 * +1, NULL after a throw. */
ScrError *scr_domex_clone(ScrError *e, const struct ScrDyn *options);
/* Throw a fresh DOMException through the exception cell (atob/btoa's
 * InvalidCharacterError sites). Copies both C strings; the _str form
 * takes ownership of the message. */
void scr_throw_domex(const char *name, const char *message);
void scr_throw_domex_str(const char *name, ScrStr *message);

/* Switch runtime-side error allocation to collector-headered (called from
 * main() when the compiler's cycle fixpoint marks the hierarchy). */
void scr_error_set_traced(void);

/* Allocate + initialize (name = the kind's builtin name, message retained
 * from the borrowed argument; NULL means ""). Returns +1. */
ScrError *scr_error_new(int kind, ScrStr *message);
/* Initialize the error prefix of an already-allocated (zeroed) object —
 * the super(message) call of a compiled `extends Error` constructor. Both
 * arguments are borrowed. */
void scr_error_init(void *obj, int kind, ScrStr *message);
/* ECMA Error.prototype.toString: "", name, message, or "name: message".
 * Borrows e, returns +1. */
ScrStr *scr_error_to_string(ScrError *e);

ScrError *scr_error_retain(ScrError *e);
void scr_error_release(ScrError *e); /* dispatches through e->vt */
void *scr_error_retain_v(void *e);
void scr_error_release_v(void *e);
void scr_error_trace(void *e, ScrTraceVisit visit, void *ctx); /* no headered children */
ScrTraceFn scr_error_trace_arg(void); /* &scr_error_trace when traced, else NULL */

/* True when a thrown hierarchy object (SCR_EXC_OBJ payload) is an Error —
 * its vtable's preorder lies inside Error's stamped interval. */
bool scr_error_is(const void *obj);

/* Throw a fresh builtin error through the exception cell. scr_throw_error
 * takes ownership of message; the _msg form copies the C string. The _named
 * form (island bridge) takes ownership of both strings and picks the
 * builtin vtable whose class name matches `name` (Error otherwise). */
void scr_throw_error(int kind, ScrStr *message);
void scr_throw_error_msg(int kind, const char *message, size_t len);
void scr_throw_error_named(ScrStr *name, ScrStr *message);
/* A read of a declare-d const nothing defines: throws Node's catchable
 * ReferenceError "<name> is not defined". Borrows name; always throws. */
void scr_undef_global_read(ScrStr *name);
/* The `code` slot (NodeJS.ErrnoException's .code): set stamps a fresh
 * string from the C literal (replacing any previous value); get answers
 * +1 or NULL when absent (the compiler's undefined arm). The _msg_code
 * thrower is scr_throw_error_msg with the code stamped on the payload. */
void scr_error_set_code(ScrError *e, const char *code);
ScrStr *scr_error_code(ScrError *e);
void scr_throw_error_msg_code(int kind, const char *message, size_t len, const char *code);
/* The compiler-resolved Node-parity throw (error.nodeThrow): builtin
 * error of `kind`, `code` stamped when non-empty. Borrows both. */
void scr_throw_node_coded(double kind, const ScrStr *code, const ScrStr *msg);

/* ── string methods ─────────────────────────────────────────────────
 * ECMA-262 observable semantics (UTF-16 code units) computed over the
 * UTF-8 storage by scanning — O(n) per call, correctness first. All double
 * index/count arguments go through ToIntegerOrInfinity (NaN → 0, trunc
 * toward zero, ±Infinity kept), exactly like JS. Every function borrows its
 * ScrStr arguments; functions returning ScrStr* return a +1 reference.
 *
 * One documented divergence (JS lone surrogates are unrepresentable in
 * well-formed UTF-8): where JS would produce a *lone surrogate* — charAt on
 * half of an astral pair, or a slice boundary that splits a pair — the
 * result contains U+FFFD (EF BF BD) in its place. Numeric results
 * (charCodeAt) are NOT affected: they return the exact surrogate code unit
 * value, computed from the code point.
 */

/* .length — number of UTF-16 code units (astral chars count as 2). */
double scr_str_utf16_len(ScrStr *s);

/* charCodeAt(i): the i-th UTF-16 code unit as a number; for astral chars
 * returns the high (0xD800+) or low (0xDC00+) surrogate value depending on
 * which half i addresses. NaN when ToIntegerOrInfinity(i) is outside
 * [0, length) — note charCodeAt(1.5) is index 1, matching Node. */
double scr_str_char_code_at(ScrStr *s, double i);

/* indexOf(needle, fromIndex): UTF-16 index of the first occurrence at or
 * after fromIndex (clamped to [0, length]), or -1. Empty needle returns the
 * clamped fromIndex per spec. */
double scr_str_index_of(ScrStr *s, ScrStr *needle, double fromIndex);

/* includes(needle) — no position argument. Empty needle → true. */
bool scr_str_includes(ScrStr *s, ScrStr *needle);

/* startsWith(needle) / endsWith(needle) — no position argument. */
bool scr_str_starts_with(ScrStr *s, ScrStr *needle);
bool scr_str_ends_with(ScrStr *s, ScrStr *needle);

/* slice(start, end): UTF-16 indices, negatives count from length, clamped
 * to [0, length]; empty when start >= end. The frontend passes
 * end = Infinity for the one-argument form. Boundaries that split an astral
 * pair yield U+FFFD for the half character (divergence, see above).
 * Returns +1. */
ScrStr *scr_str_slice(ScrStr *s, double start, double end);
/* substring: clamp-and-swap (negatives clamp to 0, start > end swaps). */
ScrStr *scr_str_substring(ScrStr *s, double start, double end);

/* repeat(count): count < 0 or Infinity is a JS RangeError; scriptc has no
 * exceptions, so it prints "scriptc: RangeError: Invalid count value" to
 * stderr and abort()s. Returns +1. */
ScrStr *scr_str_repeat(ScrStr *s, double count);

/* trim(): strips the exact JS WhiteSpace ∪ LineTerminator set from both
 * ends (U+0009-U+000D, U+0020, U+00A0, U+1680, U+2000..U+200A, U+2028,
 * U+2029, U+202F, U+205F, U+3000, U+FEFF). Returns +1. */
ScrStr *scr_str_trim(ScrStr *s);

/* toLowerCase()/toUpperCase(): ECMA-262 Default Case Conversion (final
 * sigma included) via libunicode's lre_case_conv — implemented in
 * scr_regex.c, so they link exactly into lre-using binaries (the compiler
 * sets the regex link flag for case-conversion sites). Borrow s; +1. */
ScrStr *scr_str_to_lower(const ScrStr *s);
ScrStr *scr_str_to_upper(const ScrStr *s);

/* charAt(i): 1-code-unit string; out of range → empty string. Half of an
 * astral pair → U+FFFD (divergence, see above). Returns +1. */
ScrStr *scr_str_char_at(ScrStr *s, double i);

/* The string iterator's step (for-of over strings): the full code-POINT
 * character starting at UTF-16 index i — astral chars come back whole
 * (two units); the consuming loop advances by the result's length.
 * Out of range → empty string. Returns +1. */
ScrStr *scr_str_cp_at(ScrStr *s, double i);

/* trimStart()/trimEnd(): the one-sided halves of trim. Returns +1. */
ScrStr *scr_str_trim_start(ScrStr *s);
ScrStr *scr_str_trim_end(ScrStr *s);

/* split(separator[, limit]) with a STRING separator: limit uses ToUint32;
 * the no-limit wrapper supplies 2^32-1. Empty separator
 * splits into single UTF-16 code units (each half of an astral char is
 * U+FFFD — divergence, see above); otherwise splits on every occurrence,
 * empty pieces kept. Borrows both; returns a +1 string[] (SCR_ELEM_STR). */
struct ScrArr;
struct ScrArr *scr_str_split(ScrStr *s, ScrStr *sep);
struct ScrArr *scr_str_split_limit(ScrStr *s, ScrStr *sep, double limit);

/* padStart(maxLength, fill)/padEnd — ECMA StringPad, UTF-16 unit counts.
 * Target at or below the length (or empty fill) returns the receiver
 * (retained). A truncated fill that would split an astral char emits
 * U+FFFD for the kept half. Oversized pads abort (the repeat() policy).
 * Borrow both; return +1. */
ScrStr *scr_str_pad_start(ScrStr *s, double maxLength, ScrStr *fill);
ScrStr *scr_str_pad_end(ScrStr *s, double maxLength, ScrStr *fill);

/* isWellFormed()/toWellFormed(): storage is well-formed by invariant
 * (lone surrogates became U+FFFD at their producers, SEMANTICS.md 2), so
 * isWellFormed is constant true and toWellFormed the identity (per spec
 * both are no-ops on well-formed input). Borrow s; toWellFormed +1. */
bool scr_str_is_well_formed(ScrStr *s);
ScrStr *scr_str_to_well_formed(ScrStr *s);

/* RegExp.escape(s) — ES2025 EncodeForRegExpEscape per code point: leading
 * ASCII alphanumeric hex-escapes, SyntaxCharacters and '/' take a
 * backslash, other punctuators/whitespace/line terminators hex-escape
 * (\xNN / \uNNNN, lowercase), the rest passes through. Total (the spec's
 * surrogate arm is unreachable over well-formed storage). Lives in
 * scr_regex.c (no engine needed — the placement keeps the always-linked
 * string TU out of hello-world's size class); use sites flip the regex
 * link switch (moduleUsesRegex). Borrows; +1. */
ScrStr *scr_regexp_escape(ScrStr *s);

/* parseInt(s, radix) — ECMA-262 19.2.5 exactly: JS whitespace skip, sign,
 * ToInt32 radix (0 → 10 with the 0x hex escape; outside 2..36 → NaN),
 * longest digit prefix, exact value correctly rounded (overflow →
 * ±Infinity). The frontend completes an omitted radix to 0. Borrows s. */
double scr_parse_int(ScrStr *s, double radix);
double scr_parse_float(ScrStr *s);

/* ToNumber(string) — ECMA-262 7.1.4.1 StringToNumber exactly: trim
 * StrWhiteSpace (the JS set, line terminators included) from both ends,
 * empty/whitespace-only → +0, then the WHOLE remaining span must be one
 * StrNumericLiteral — a signed decimal literal ("Infinity" exact-case
 * included, correctly rounded via strtod over the validated span) or an
 * UNSIGNED 0x/0o/0b integer literal (exact value rounded to nearest-even;
 * a sign on those is NaN, per grammar). Any trailing garbage → NaN.
 * Borrows s; never throws. */
double scr_string_to_number(ScrStr *s);

/* encodeURIComponent — ECMA-262 Encode with the component unreserved set
 * (ALPHA/DIGIT/- _ . ! ~ * ' ( )): every other byte of the UTF-8 string
 * percent-encodes as uppercase %XX (the spec's per-code-point UTF-8
 * encoding IS a byte scan over UTF-8 storage). Never throws — the spec's
 * URIError is the unpaired surrogate, which well-formed UTF-8 cannot
 * hold. Borrows s; result +1. */
ScrStr *scr_str_encode_uri_component(ScrStr *s);

/* decodeURIComponent — ECMA-262 Decode with the empty reserved set: %XX
 * escapes decode bytewise (raw non-escape bytes copy through) and escaped
 * multibyte sequences must be strictly valid UTF-8 (overlong forms,
 * surrogates, >U+10FFFF refused — UTF8-decode without replacement). Bad
 * hex or an invalid sequence THROWS the spec's catchable URIError ("URI
 * malformed") and returns NULL. Borrows s; result +1. */
ScrStr *scr_str_decode_uri_component(ScrStr *s);

/* The non-throwing core of decodeURIComponent: NULL on malformed input
 * instead of the URIError — the try/catch shape node:querystring's
 * unescape wraps around decodeURIComponent (scr_qs.c's strict pass). */
ScrStr *scr_str_decode_uri_component_try(ScrStr *s);

/* ── node:querystring (scr_qs.c — LINK-GATED by moduleUsesQs; the
 * scr_url_params.c precedent: pure data transforms, no loop hooks).
 * querystring.escape needs no entry here: Node's qsEscape encodes exactly
 * the component unreserved set, so the frontend lowers it to
 * scr_str_encode_uri_component (always linked; a program using only
 * escape never pulls this unit). */

/* querystring.unescape — Node's qsUnescape: strict decodeURIComponent
 * first, and on failure the lenient legacy unescapeBuffer(s).toString()
 * (valid %XX escapes decode to their byte, malformed escapes copy
 * literally, every non-escape UTF-16 CODE UNIT truncates to its low byte
 * — Node's Buffer element write — and the byte buffer decodes as UTF-8
 * with U+FFFD replacement per maximal subpart, Buffer.toString's rule).
 * Borrows s; result +1; never throws. */
ScrStr *scr_qs_unescape(const ScrStr *s);

/* querystring.parse — Node v24's scan state machine, byte-wise over the
 * UTF-8 storage (equivalent to the code-unit scan for well-formed input:
 * the machine compares sep/eq sequences positionally and treats '%'/'+'/
 * hex as ASCII, and multibyte alignment is preserved). Decoded pairs land
 * in `out` — the PURE-index-signature Dict record's overflow map (the
 * emitters pass rec->sc_ovf) — grouped like Node's addKeyVal: a first
 * value stores the `str_tag` union arm, a repeat REPLACES it with a
 * two-element string[] wrapped in `arr_tag`, later repeats push. sep/eq
 * fall back to "&"/"=" when empty (Node's falsy rule; the frontend
 * completes omitted/null arguments to the defaults). max_keys is Node's
 * rule exactly: > 0 caps the PAIR count (empty skipped segments count,
 * like Node's --pairs), anything else (0, negatives, NaN) is unlimited;
 * the frontend completes the omitted option to 1000. Only the DEFAULT
 * decoder runs (custom decodeURIComponent options fence at compile time),
 * so '+' means ' ' and segments decode with scr_qs_unescape's semantics
 * only when they carry a full valid %XX triple (Node's encodeCheck).
 * Borrows everything; never throws. */
typedef struct ScrMap ScrMap; /* full definition below (C11 repeat) */
void scr_qs_parse_into(ScrMap *out, const ScrStr *qs, const ScrStr *sep,
                       const ScrStr *eq, double max_keys, uint32_t str_tag,
                       uint32_t arr_tag);

/* node:util.parseArgs — the static checked-dynamic boundary. `config` is
 * the documented JSON-safe configuration object; the returned dyn tree is
 * a fresh ParsedResults object whose `values` child has null prototype.
 * Borrows config; returns +1, or NULL with a Node-coded TypeError pending. */
struct ScrDyn *scr_util_parse_args(const struct ScrDyn *config);

/* querystring.stringify — Node's stringify over a borrowed dyn value (the
 * frontend dynFroms the typed record; JS-world dyn values pass straight
 * through). Non-object dyn values answer "" like Node; object keys iterate in
 * JS own-key order (scr_dyn_obj_keys — array-index keys ascending first,
 * then insertion order, Node's ObjectKeys). Values serialize per Node's
 * encodeStringified: strings escape, finite numbers render shortest-
 * roundtrip then escape ('1e+21' → '1e%2B21'), booleans are bare
 * true/false, arrays expand to repeated keys (empty arrays emit NOTHING,
 * key included), and everything else (null, undefined, nested objects/
 * arrays, functions) is the empty value — key and eq still emitted.
 * sep/eq fall back to "&"/"=" when empty (Node's `sep ||= '&'`). Result
 * +1; never throws. */
ScrStr *scr_qs_stringify(const struct ScrDyn *obj, const ScrStr *sep,
                         const ScrStr *eq);

/* encodeURI — the same ECMA-262 Encode() with the reserved set and '#'
 * kept unescaped (scr_encode_uri_impl's keep_reserved arm). Total by the
 * well-formed-UTF-8 invariant. Borrows s; result +1. */
ScrStr *scr_encode_uri(ScrStr *s);
/* atob/btoa — the WHATWG base64 globals (Node globals since v16). The
 * argument is a borrowed dyn value: WebIDL ToString runs here over the
 * dyn kind (Node's atob(null) decodes "null"). scr_atob decodes
 * forgiving-base64 (ASCII whitespace stripped, %4==0 strips up to two
 * '=', %4==1 refuses, leftover bits discarded) into the latin1 code
 * points as a UTF-8 string; malformed input THROWS the catchable
 * DOMException InvalidCharacterError ("The string to be decoded is not
 * correctly encoded.") and returns NULL. scr_btoa encodes the string's
 * code points (any over U+00FF throws InvalidCharacterError "Invalid
 * character"). scr_b64_missing_arg is the zero-argument call of either:
 * always throws Node's TypeError [ERR_MISSING_ARGS] and returns NULL.
 * Results +1. */
ScrStr *scr_atob(const struct ScrDyn *data);
ScrStr *scr_btoa(const struct ScrDyn *data);
ScrStr *scr_b64_missing_arg(void);

/* ── arrays ─────────────────────────────────────────────────────────
 * Monomorphic, growable, refcounted. Elements live in 8-byte slots
 * (doubles/bools/pointers via memcpy and casts); `elem` records what the
 * slots hold so the array can release its own reference elements — ScrStr's
 * layout is untouched (interned-literal statics depend on it), so the
 * element kind lives here instead of in a shared object header.
 *
 * Index arguments are doubles (JS numbers). A valid index is a non-negative
 * integer; reads must be < len, writes may also be == len (append — JS
 * would create a hole past the end; scriptc traps instead, see
 * SEMANTICS.md). Anything else prints
 *   scriptc: RangeError: array index <i> out of bounds (length <n>)
 * to stderr and abort()s. pop() on an empty array likewise traps (JS
 * returns undefined — unrepresentable here).
 *
 * Ownership: _get_ref returns +1 (retains before returning); _set_ref and
 * _push_ref take ownership of the new element (and _set_ref releases the
 * old one); _pop_ref transfers the element's reference out to the caller.
 */

typedef enum {
  SCR_ELEM_F64,
  SCR_ELEM_BOOL,
  SCR_ELEM_STR, /* slots are ScrStr* — released with the array */
  SCR_ELEM_ARR, /* slots are ScrArr* — released recursively */
  SCR_ELEM_BYTES, /* slots are ScrBytes* — released with the array */
  /* Slots are void* to values the runtime cannot lay out itself — records,
   * class instances, unions, and cycle-capable inner arrays. The element
   * type's RC entry points arrive at construction (scr_arr_new_ref) and are
   * stored ONCE per array, the SCR_BOX_OBJ / map-value technique; every
   * array is still monomorphic (one element type, one set of entry points). */
  SCR_ELEM_REF,
} ScrElemKind;

typedef struct ScrArr {
  size_t rc; /* SIZE_MAX = immortal (unused for arrays; kept per convention) */
  size_t len;
  size_t cap;
  ScrElemKind elem;
  /* SCR_ELEM_REF only; NULL for every other element kind. elem_trace is
   * non-NULL exactly when the element type carries a cycle header: such
   * arrays are CYCLE-CAPABLE (an element can point back at the array that
   * owns it) and allocate with the hidden collector header — their trace
   * visits every element, and the collector teardown frees only the slot
   * storage (all elements are traced children). Arrays of acyclic ref
   * elements and the historic element kinds keep the lean 1-word header. */
  void *(*elem_retain)(void *);
  void (*elem_release)(void *);
  ScrTraceFn elem_trace;
  uint64_t *data;
} ScrArr;

ScrArr *scr_arr_new(ScrElemKind elem, size_t initial_cap); /* returns +1 */

/* SCR_ELEM_REF construction: retain/release must be non-NULL (the compiler
 * passes the element type's `_v` adapters); trace is non-NULL iff the
 * element type carries a cycle header (the array then allocates with the
 * collector header — see the struct comment). Returns +1. */
ScrArr *scr_arr_new_ref(void *(*elem_retain)(void *),
                         void (*elem_release)(void *),
                         ScrTraceFn elem_trace, size_t initial_cap);

static inline ScrArr *scr_arr_retain(ScrArr *a) {
  if (a->rc != SIZE_MAX) {
    a->rc++;
    if (a->elem_trace) scr_cyc_mark_live(a);
  }
  return a;
}

/* Releases ref elements (SCR_ELEM_STR/ARR/BYTES/REF) recursively at rc == 0.
 * NULL-tolerant (uninitialized locals). Cycle-capable arrays (elem_trace
 * non-NULL) feed the candidate-root buffer like every headered type. */
void scr_arr_release(ScrArr *a);

/* Trace entry point for cycle-capable arrays — stored in their collector
 * header and passed wherever a container stores an ARRAY payload's RC entry
 * points and the array type is cycle-capable (boxes, union arms, map
 * values, promise payloads), exactly like scr_map_trace_v. */
void scr_arr_trace_v(void *a, ScrTraceVisit visit, void *ctx);

double scr_arr_len(ScrArr *a);
/* Math.max(...xs) / Math.min(...xs) over an f64-element array: the JS
 * fold (NaN poisons, ±0 by the JS preferences, empty → ∓Infinity). */
double scr_math_max_arr(ScrArr *a);
double scr_math_min_arr(ScrArr *a);
/* The scalar Math statics (scr_lib.c): min/max are the ECMA two-argument
 * folds (NaN poisons; max prefers +0, min prefers -0 — NOT C's fmin/fmax);
 * random is a uniform [0,1) double at 53-bit granularity from
 * arc4random_buf (SEMANTICS.md 62: Node's distribution, not its sequence). */
double scr_math_min(double a, double b);
double scr_math_round(double x);
double scr_math_max(double a, double b);
double scr_math_random(void);

double scr_arr_get_f64(ScrArr *a, double i); /* trap OOB */
bool scr_arr_get_bool(ScrArr *a, double i);  /* trap OOB */
void *scr_arr_get_ref(ScrArr *a, double i);  /* trap OOB; returns +1 */

/* i == len appends; the _ref variant releases the old element (when
 * replacing) and takes ownership of the new one. */
void scr_arr_set_f64(ScrArr *a, double i, double v);
void scr_arr_set_bool(ScrArr *a, double i, bool v);
void scr_arr_set_ref(ScrArr *a, double i, void *v);

/* slice(start?, end?): a fresh +1 shallow copy of the index range —
 * ToIntegerOrInfinity indices, negatives from the end, clamping; ref
 * elements retain into the copy. Borrows a. */
ScrArr *scr_arr_slice(ScrArr *a, double start, double end);

/* ES2023 copying methods. All borrow their inputs and return fresh +1
 * shallow copies. with() raises Node's catchable RangeError for an invalid
 * relative index; the ref variant retains the borrowed replacement. */
ScrArr *scr_arr_to_reversed(const ScrArr *a);
ScrArr *scr_arr_to_spliced(const ScrArr *a, double start,
                           double delete_count, const ScrArr *items);
ScrArr *scr_arr_with_f64(ScrArr *a, double index, double value);
ScrArr *scr_arr_with_bool(ScrArr *a, double index, bool value);
ScrArr *scr_arr_with_ref(ScrArr *a, double index, void *value);

/* push returns the new length (JS-exact); _ref takes ownership. */
double scr_arr_push_f64(ScrArr *a, double v);
double scr_arr_push_bool(ScrArr *a, bool v);
double scr_arr_push_ref(ScrArr *a, void *v);

/* unshift returns the new length and _ref takes ownership. The spread form
 * borrows a same-element-kind source, retains copied refs, and snapshots
 * self-spread. reverse mutates in place and returns the receiver at +1. */
double scr_arr_unshift_f64(ScrArr *a, double v);
double scr_arr_unshift_bool(ScrArr *a, bool v);
double scr_arr_unshift_ref(ScrArr *a, void *v);
double scr_arr_unshift_spread(ScrArr *a, const ScrArr *src);
ScrArr *scr_arr_reverse(ScrArr *a);

/* pop traps on an empty array; _ref transfers ownership out (+1 to the
 * caller, no release). */
double scr_arr_pop_f64(ScrArr *a);
bool scr_arr_pop_bool(ScrArr *a);
void *scr_arr_pop_ref(ScrArr *a);

/* shift: the first element out, tail sliding down. The emitter guards the
 * empty array (JS's undefined — the `elem | undefined` union), so empty
 * here is an internal error; _ref transfers ownership out like pop. */
double scr_arr_shift_f64(ScrArr *a);
bool scr_arr_shift_bool(ScrArr *a);
void *scr_arr_shift_ref(ScrArr *a);

/* splice(start, deleteCount) — the REMOVAL forms: Node-exact
 * relative/clamped start, count clamped to [0, len - start] (+Infinity =
 * to the end). Returns the removed elements in order as a fresh +1 array,
 * ownership MOVED out of the receiver. Borrows a. */
ScrArr *scr_arr_splice(ScrArr *a, double start, double deleteCount);

/* indexOf: first index whose element strictly equals (JS ===) the needle,
 * or -1. Per element kind: f64 by value (NaN never matches — NaN !== NaN;
 * -0 matches 0), bool by value, SCR_ELEM_STR by CONTENT (JS strings are
 * primitives), SCR_ELEM_ARR/SCR_ELEM_REF by reference identity (JS object
 * equality; the compiler fences union-element arrays, whose boxes are
 * compiler artifacts pointer identity would misjudge). The _ref variants
 * BORROW the needle (no ownership change). */
double scr_arr_index_of_f64(ScrArr *a, double v);
double scr_arr_index_of_bool(ScrArr *a, bool v);
double scr_arr_index_of_ref(ScrArr *a, void *v);

/* includes: SameValueZero — exactly indexOf's equality EXCEPT NaN matches
 * NaN (JS: [NaN].indexOf(NaN) === -1 but [NaN].includes(NaN) === true). */
bool scr_arr_includes_f64(ScrArr *a, double v);
bool scr_arr_includes_bool(ScrArr *a, bool v);
bool scr_arr_includes_ref(ScrArr *a, void *v);

/* join(sep): elements stringified exactly like JS String(x) — numbers via
 * scr_f64_to_str (shortest roundtrip), booleans "true"/"false", strings
 * verbatim — with sep between. f64/bool/str element kinds only (the
 * compiler rejects the rest). Borrows both args; returns +1. */
ScrStr *scr_arr_join(ScrArr *a, ScrStr *sep);
/* String.raw over the raw literals and pre-stringified substitutions
 * (both SCR_ELEM_STR): the spec's interleave — extra substitutions drop,
 * missing ones skip. Borrows both; +1 result; never throws. */
ScrStr *scr_str_raw(ScrArr *raw, ScrArr *subs);

/* ── regular expressions (scr_regex.c — linked ONLY when the program
 * contains a regex literal; see cc.ts) ────────────────────────────────
 * The engine is quickjs-ng's libregexp (the same bytecode interpreter the
 * dynamic island uses), compiled standalone. A ScrRegex is today ALWAYS an
 * immortal interned literal: the compiler emits one static per distinct
 * (pattern, flags) pair, exactly like string literals, and the bytecode is
 * compiled lazily on first use (cached on the struct, freed at exit).
 * Subjects are matched as UTF-16 (converted per call from the UTF-8
 * storage), so all observable index behavior is UTF-16-exact like Node.
 *
 * Statefulness fence: /g and /y regexes carry mutable lastIndex in JS.
 * Supported only where iteration is internal (replace/replaceAll/split);
 * test() on a g/y-flagged regex aborts with a clear message.
 *
 * Ownership: subjects/replacements are BORROWED; string/array results
 * return +1. replace_all without /g and split on a pattern with capture
 * groups THROW catchable TypeErrors (callers are compiler-emitted pending
 * checks); every other failure mode aborts.
 */
typedef struct ScrRegex {
  size_t rc;      /* SIZE_MAX = immortal (every regex literal) */
  ScrStr *source; /* pattern text between the slashes */
  ScrStr *flags;  /* flags text, source order (alphabet fenced to gimsuy) */
  uint8_t *bc;    /* lazily compiled libregexp bytecode; NULL until first use */
} ScrRegex;

static inline ScrRegex *scr_regex_retain(ScrRegex *re) {
  if (re->rc != SIZE_MAX) re->rc++;
  return re;
}

void scr_regex_release(ScrRegex *re); /* NULL-tolerant */
void *scr_regex_retain_v(void *re);
void scr_regex_release_v(void *re);

/* new RegExp(pattern, flags): a heap ScrRegex over the same engine. The
 * pattern compiles EAGERLY — an invalid pattern or flag throws Node's
 * catchable SyntaxError at construction (detail text is libregexp's,
 * approximate fidelity; e.name exact). An empty pattern stores the
 * spec's "(?:)" source. Borrows both; +1, NULL after a throw. */
ScrRegex *scr_regex_new(ScrStr *pattern, ScrStr *flags);

bool scr_regex_test(ScrRegex *re, ScrStr *s); /* aborts on /g or /y */
/* s.match(re): +1 string[] of [whole, ...captures] (nonparticipating
 * captures hold "" — SEMANTICS.md), or NULL for no match. Aborts on /g
 * or /y like test(). Borrows both. */
ScrArr *scr_regex_match(ScrStr *s, ScrRegex *re);
/* s.search(re): the first match's UTF-16 index, or -1 — a fresh exec from
 * position 0 (Symbol.search never touches lastIndex, so no flag fence:
 * /g is irrelevant, /y anchors at 0). Borrows both; never throws. */
double scr_regex_search(ScrStr *s, ScrRegex *re);
ScrStr *scr_regex_source(ScrRegex *re);       /* +1 */
ScrStr *scr_regex_flags(ScrRegex *re);        /* +1 */
/* replace: first match without /g, every match with it. */
ScrStr *scr_regex_replace(ScrStr *s, ScrRegex *re, ScrStr *rep);
/* replaceAll: throws Node's TypeError when /g is missing (may-throw). */
ScrStr *scr_regex_replace_all(ScrStr *s, ScrRegex *re, ScrStr *rep);
/* split: capture-free patterns only — capture groups throw (may-throw).
 * limit uses ToUint32; the no-limit wrapper supplies 2^32-1. */
ScrArr *scr_regex_split(ScrStr *s, ScrRegex *re);
ScrArr *scr_regex_split_limit(ScrStr *s, ScrRegex *re, double limit);
/* matchAll drained eagerly: +1 string[][] of honest match slices; throws
 * Node's TypeError on a non-global regex (catchable). */
ScrArr *scr_regex_match_all(ScrStr *s, ScrRegex *re);
/* matchAll + the companion-index drain: also pushes each match's UTF-16
 * start index (f64) onto `indices` — the .index the for-of-over-matchAll
 * desugar reads. Same throw/result contract as scr_regex_match_all. */
ScrArr *scr_regex_match_all_into(ScrStr *s, ScrRegex *re, ScrArr *indices);

/* ── maps (scr_map.c) ───────────────────────────────────────────────
 * ES Map<K, V> with the compact-dict layout: a dense, insertion-ordered
 * entries array (deletions become tombstones; compaction happens on growth,
 * and NEVER while an iteration is active) plus an open-addressing bucket
 * table of entry indices. That is what gives JS's observable semantics for
 * free: forEach visits in insertion order, entries added during iteration
 * are visited (they append), deleted entries are skipped (tombstones), and
 * a delete + re-add moves the key to the end (Node-verified).
 *
 * Keys are string (content) or number with SameValueZero: NaN equals NaN
 * (canonicalized before hashing) and -0 is normalized to +0 at insertion,
 * exactly like JS (a stored -0 key reads back as +0). Hash is FNV-1a over
 * the string bytes / the canonicalized f64 bit pattern.
 *
 * Values are one uniform kind per map (like ScrArr elements): f64, bool, or
 * a refcounted pointer whose RC entry points arrive as function pointers at
 * construction (the SCR_BOX_OBJ technique — the runtime cannot know
 * per-class/per-record layouts). val_trace is non-NULL exactly when the
 * value type carries a cycle header: such maps are CYCLE-CAPABLE (a record/
 * object value can point back at the map holding it) and allocate with the
 * hidden collector header — their trace visits every live value, and the
 * collector teardown releases the complement (keys). Scalar-, string- and
 * array-valued maps keep the lean 1-word header (none of those can point
 * back at an owner).
 *
 * Ownership: set BORROWS the key (the map retains string keys it stores)
 * and OWNS the value (+1 moves in; replacing releases the old value).
 * get/has/delete borrow the key; get returns +1 on ref values (NULL = not
 * found) or fills an out-param and returns a found flag for scalars.
 * delete releases the entry's key and value. iter_key_str and iter_val_ref
 * return +1. iter_enter/iter_exit bracket a forEach loop: while the depth
 * is nonzero, growth keeps tombstones (indices stay stable) and clear only
 * tombstones entries — live-iteration semantics stay exact.
 */

/* SCR_MAP_KEY_REF: refcounted-pointer keys hashed and compared by IDENTITY
 * (the pointer bits) — SameValueZero for JS objects IS reference identity,
 * so a Set of handle values (Set<http.Server>, the portless auxiliary-
 * server registry) is honest hashed storage. REF keys carry their own
 * retain/release adapters (scr_set_new_ref); only SETS use the kind so
 * far — the Map-key surface stays f64/string. */
typedef enum { SCR_MAP_KEY_F64, SCR_MAP_KEY_STR, SCR_MAP_KEY_REF } ScrMapKeyKind;
typedef enum { SCR_MAP_VAL_F64, SCR_MAP_VAL_BOOL, SCR_MAP_VAL_REF } ScrMapValKind;

typedef struct {
  uint64_t key; /* double bits (normalized), ScrStr* (owned), or ref ptr (owned) */
  uint64_t val; /* double bits, bool, or owned pointer */
  bool live;    /* false = tombstone (key/val already released) */
} ScrMapEntry;

typedef struct ScrMap {
  size_t rc; /* SIZE_MAX = immortal (unused for maps; kept per convention) */
  ScrMapKeyKind key_kind;
  ScrMapValKind val_kind;
  /* SCR_MAP_VAL_REF only; val_trace non-NULL iff the value type carries a
   * cycle header (which is also the map's own headered-allocation flag). */
  void *(*val_retain)(void *);
  void (*val_release)(void *);
  ScrTraceFn val_trace;
  /* SCR_MAP_KEY_REF only (scr_set_new_ref); NULL otherwise. */
  void *(*key_retain)(void *);
  void (*key_release)(void *);
  size_t nentries; /* dense entries used, tombstones included */
  size_t nlive;    /* live entries (Map.size) */
  size_t ecap;     /* entries capacity */
  ScrMapEntry *entries;
  size_t nbuckets;  /* power of two; >= 2 * ecap so probes terminate */
  size_t *buckets;  /* entry indices; SIZE_MAX = empty */
  size_t iter_depth; /* > 0: an iteration is active — no compaction */
} ScrMap;

/* retain/release/trace are NULL for scalar value kinds; retain/release are
 * required for SCR_MAP_VAL_REF; trace is non-NULL iff the value type is
 * cycle-capable (the map then allocates with the collector header). */
ScrMap *scr_map_new(ScrMapKeyKind key_kind, ScrMapValKind val_kind,
                     void *(*val_retain)(void *), void (*val_release)(void *),
                     ScrTraceFn val_trace); /* returns +1 */
ScrMap *scr_map_retain(ScrMap *m);
void scr_map_release(ScrMap *m); /* NULL-tolerant */
void *scr_map_retain_v(void *m);
void scr_map_release_v(void *m);
void scr_map_trace_v(void *m, ScrTraceVisit visit, void *ctx);

double scr_map_size(const ScrMap *m); /* live entries (Map.size) */
void scr_map_clear(ScrMap *m);

bool scr_map_has_f64(const ScrMap *m, double key);
bool scr_map_has_str(const ScrMap *m, const ScrStr *key);
bool scr_map_has_ref(const ScrMap *m, const void *key);
bool scr_map_delete_f64(ScrMap *m, double key);
bool scr_map_delete_str(ScrMap *m, const ScrStr *key);
bool scr_map_delete_ref(ScrMap *m, const void *key);

/* set: key borrowed (string keys are retained when stored), value moves in
 * for _ref (replacing releases the old value; the stored key is kept, like
 * JS — only the value changes on overwrite). */
void scr_map_set_f64_f64(ScrMap *m, double key, double v);
void scr_map_set_f64_bool(ScrMap *m, double key, bool v);
void scr_map_set_f64_ref(ScrMap *m, double key, void *v);
void scr_map_set_str_f64(ScrMap *m, ScrStr *key, double v);
void scr_map_set_str_bool(ScrMap *m, ScrStr *key, bool v);
void scr_map_set_str_ref(ScrMap *m, ScrStr *key, void *v);
void scr_map_set_ref_f64(ScrMap *m, void *key, double v); /* REF-key sets */

/* get: scalar variants fill *out and return the found flag; ref variants
 * return +1 or NULL (values are never NULL, so NULL means "absent"). The
 * compiler wraps the result into the `V | undefined` union type-directedly
 * (the runtime knows no tags). */
bool scr_map_get_f64_f64(const ScrMap *m, double key, double *out);
bool scr_map_get_f64_bool(const ScrMap *m, double key, bool *out);
void *scr_map_get_f64_ref(const ScrMap *m, double key);
bool scr_map_get_str_f64(const ScrMap *m, const ScrStr *key, double *out);
bool scr_map_get_str_bool(const ScrMap *m, const ScrStr *key, bool *out);
void *scr_map_get_str_ref(const ScrMap *m, const ScrStr *key);

/* Iteration primitives behind the compiler's forEach desugar: an index loop
 * over the dense entries array, re-reading iter_count every pass (appends
 * during iteration are visited) and skipping tombstones via iter_live.
 * iter_key/iter_val on an out-of-range or dead index abort (the desugar
 * guards with iter_live first — reaching one is a compiler bug). */
double scr_map_iter_count(const ScrMap *m); /* entries incl. tombstones */
bool scr_map_iter_live(const ScrMap *m, double i);
double scr_map_iter_key_f64(const ScrMap *m, double i);
ScrStr *scr_map_iter_key_str(const ScrMap *m, double i); /* +1 */
void *scr_map_iter_key_ref(const ScrMap *m, double i);     /* +1 */
double scr_map_iter_val_f64(const ScrMap *m, double i);
bool scr_map_iter_val_bool(const ScrMap *m, double i);
void *scr_map_iter_val_ref(const ScrMap *m, double i); /* +1 */
void scr_map_iter_enter(ScrMap *m);
void scr_map_iter_exit(ScrMap *m);

/* Seeded Set construction (`new Set(values)`): add() every element of one
 * borrowed T[] in order — duplicates keep their first insertion position
 * (SameValueZero, exactly JS). `set` is a set-shaped map (f64 value kind,
 * stored values 0); the array's element kind matches the set's key kind. */
void scr_set_add_all(ScrMap *set, ScrArr *values);

/* `[...set]` (scr_lib.c): the live entries drained into a fresh +1 elem[]
 * in insertion order. Borrows the set; string elements retained in. */
ScrArr *scr_set_to_arr_f64(const ScrMap *s);
ScrArr *scr_set_to_arr_str(const ScrMap *s);
ScrArr *scr_set_to_arr_ref(const ScrMap *s);

/* REF-element Set construction: a set-shaped map whose keys are refcounted
 * pointers under identity hashing (see SCR_MAP_KEY_REF above). The element
 * type's `_v` adapters arrive once, the scr_arr_new_ref technique. */
ScrMap *scr_set_new_ref(void *(*elem_retain)(void *), void (*elem_release)(void *));

/* The live STRING keys of a map in JS OWN-KEY ORDER (Object.keys/values/
 * entries over an index-signature record's overflow): canonical array
 * indices first in ascending numeric order, then the rest in insertion
 * order. Fresh ScrStr* array (+1); the map is borrowed. */
ScrArr *scr_map_keys_js_order(const ScrMap *m);

#ifdef SCR_RC_AUDIT
long scr_map_live_count(void);
#endif

/* ── closures ───────────────────────────────────────────────────────
 * A closure is a function pointer plus the boxes of its captured bindings.
 * A box is one shared, refcounted variable cell: every function that
 * captures a binding (and the function that declared it) reads and writes
 * the same box, which is what makes mutation through a closure visible
 * everywhere (JS shared-binding semantics).
 *
 * The compiler emits the callee's C signature as (ScrClosure *env, params…);
 * the callee borrows env->caps[] (the closure owns them). rc == SIZE_MAX
 * marks an immortal closure (the compiler interns one per top-level
 * function referenced as a value, so `f === f` is true like in JS).
 *
 * Ownership: box _get_ref returns +1; _set_ref releases the old value and
 * takes ownership of the new one; releasing a box releases its contents;
 * releasing a closure releases its boxes.
 */

typedef enum {
  SCR_BOX_F64,
  SCR_BOX_BOOL,
  SCR_BOX_STR,
  SCR_BOX_ARR,
  SCR_BOX_FUNC,
  SCR_BOX_OBJ, /* class instance: retain/release via the fn ptrs below */
} ScrBoxKind;

typedef struct ScrBox {
  size_t rc;
  ScrBoxKind kind;
  /* SCR_BOX_OBJ only: class instances are per-class C structs the runtime
   * knows nothing about, so the compiler supplies their RC entry points.
   * obj_trace is non-NULL exactly when the payload type carries a cycle
   * header (the box's own trace then visits the payload; NULL means the
   * payload is acyclic and the box releases it itself at teardown). */
  void *(*obj_retain)(void *);
  void (*obj_release)(void *);
  ScrTraceFn obj_trace;
  uint64_t slot; /* double/bool/pointer via memcpy and casts */
} ScrBox;

ScrBox *scr_box_new(ScrBoxKind kind); /* returns +1, slot zeroed */
ScrBox *scr_box_new_obj(void *(*retain)(void *), void (*release)(void *),
                         ScrTraceFn trace);

static inline ScrBox *scr_box_retain(ScrBox *b) {
  if (b->rc != SIZE_MAX) {
    b->rc++;
    scr_cyc_mark_live(b);
  }
  return b;
}

void scr_box_release(ScrBox *b); /* releases ref contents by kind; NULL-tolerant */

double scr_box_get_f64(ScrBox *b);
bool scr_box_get_bool(ScrBox *b);
void *scr_box_get_ref(ScrBox *b); /* returns +1 */
void scr_box_set_f64(ScrBox *b, double v);
void scr_box_set_bool(ScrBox *b, bool v);
void scr_box_set_ref(ScrBox *b, void *v); /* releases old, owns new */

typedef struct ScrClosure {
  size_t rc; /* SIZE_MAX = immortal (interned top-level function value) */
  void *fn;
  size_t ncaps;
  /* The function's OWN-PROPERTY table: a box whose payload is an OBJ
   * ScrDyn (owned; lazily allocated by Object.defineProperties —
   * test/common copying name/length onto the mustCall wrapper), NULL
   * until first defined. It lives on the CLOSURE, not the dyn box:
   * boxing the same function value twice (the declaration's box, the
   * return's box) yields distinct boxes sharing one closure, and JS has
   * ONE function object — property writes must be visible through every
   * box. A ScrBox so this unit stays dyn-free (the payload's release
   * rides the box, like every capture). Untraced by the cycle collector
   * (like the dyn→closure edge): a cycle through it is merely never
   * collected. */
  ScrBox *props;
  ScrBox *caps[];
} ScrClosure;

ScrClosure *scr_closure_new(void *fn, size_t ncaps); /* +1; caller fills caps with +1 box refs */

static inline ScrClosure *scr_closure_retain(ScrClosure *c) {
  if (c->rc != SIZE_MAX) {
    c->rc++;
    scr_cyc_mark_live(c);
  }
  return c;
}

void scr_closure_release(ScrClosure *c); /* releases the boxes; NULL-tolerant */

/* ── unions ─────────────────────────────────────────────────────────
 * A union value (`A | B`) is an IMMUTABLE tagged box: a refcounted header,
 * the arm's tag (its index in the compiler's canonical arm order), and one
 * 8-byte payload slot (double/bool/pointer via memcpy, like ScrBox and
 * ScrArr slots). Reassigning a union-typed variable constructs a NEW box —
 * immutability keeps the RC story trivial.
 *
 * Scalar arms (f64/bool) live in the slot with NULL RC entry points. Ref
 * arms OWN their payload (+1 moves in at construction) and carry the arm's
 * retain/release as function pointers, exactly like SCR_BOX_OBJ: the
 * runtime cannot know per-class/per-record struct layouts, so the compiler
 * supplies its emitted `_v` adapters (and the runtime provides `_v`
 * adapters for its own refcounted kinds below).
 *
 * Ownership: _new_ref takes ownership of the payload; scr_union_peek
 * BORROWS the payload pointer (the compiler retains through the arm's
 * concrete helper when it needs +1); releasing the union releases the
 * payload through the stored fn ptr.
 */

typedef struct ScrUnion {
  size_t rc; /* SIZE_MAX = immortal (unused for unions; kept per convention) */
  uint32_t tag;
  /* Ref arms only: the payload's RC entry points. NULL for scalar arms.
   * arm_trace is non-NULL exactly when the arm type carries a cycle header
   * (like ScrBox.obj_trace: the union's trace then visits the payload). */
  void *(*arm_retain)(void *);
  void (*arm_release)(void *);
  ScrTraceFn arm_trace;
  uint64_t slot; /* double/bool/pointer via memcpy and casts */
} ScrUnion;

ScrUnion *scr_union_new_f64(uint32_t tag, double v);  /* returns +1 */
ScrUnion *scr_union_new_bool(uint32_t tag, bool v);   /* returns +1 */
/* Takes ownership of v (+1 moves in); retain/release must be non-NULL;
 * trace is non-NULL iff the arm type carries a cycle header. */
ScrUnion *scr_union_new_ref(uint32_t tag, void *v,
                             void *(*retain)(void *),
                             void (*release)(void *),
                             ScrTraceFn trace);

static inline ScrUnion *scr_union_retain(ScrUnion *u) {
  if (u->rc != SIZE_MAX) {
    u->rc++;
    scr_cyc_mark_live(u);
  }
  return u;
}

void scr_union_release(ScrUnion *u); /* releases a ref payload; NULL-tolerant */

double scr_union_get_f64(ScrUnion *u);
bool scr_union_get_bool(ScrUnion *u);

/* BORROWED payload pointer of a ref arm (no ownership change). */
static inline void *scr_union_peek(const ScrUnion *u) {
  void *p;
  memcpy(&p, &u->slot, sizeof p);
  return p;
}

/* void*-signature RC adapters for the runtime's own refcounted kinds —
 * stored in ScrUnion (ref arms) and ScrBox (SCR_BOX_OBJ-style union boxes)
 * alongside the compiler's emitted per-class/per-record `_v` adapters. */
void *scr_str_retain_v(void *s);
void scr_str_release_v(void *s);
void *scr_arr_retain_v(void *a);
void scr_arr_release_v(void *a);
void *scr_closure_retain_v(void *c);
void scr_closure_release_v(void *c);
void *scr_union_retain_v(void *u);
void scr_union_release_v(void *u);

/* Trace entry points for the runtime's cycle-headered kinds — passed
 * wherever a container stores a payload's RC entry points (ScrBox obj
 * slots, union ref arms, promise payloads, the exception cell) and the
 * payload type is one of these. The compiler passes its emitted per-shape
 * trace for cycle-capable classes/records, and NULL for acyclic types. */
void scr_closure_trace_v(void *c, ScrTraceVisit visit, void *ctx);

/* ── node:events EventEmitter (scr_events_emitter.c, link-gated) ──────
 * The runtime-provided emitter base class — the ScrError precedent:
 * ScrEmitter lays out exactly like a compiler-emitted hierarchy class
 * (rc, vt, then the prefix fields), so `class My extends EventEmitter`
 * compiles as an ordinary derived class whose struct embeds this prefix
 * (`ScrEeReg *` then `const char *`, stamped by the emitted allocation),
 * and every vtable mechanism applies unchanged. The vtable of BARE
 * emitters lives here as a mutable global; the emitted main() stamps its
 * preorder interval (the scr_error_vts story). The emitter hierarchy is
 * UNCONDITIONALLY cycle-capable — the registry owns listener closures —
 * so bare instances always allocate collector-headered and emitted
 * subclasses are always in the traced set.
 *
 * Dispatch: listeners are invoked through compiler-emitted va_list
 * adapters; scr_emitter_emit's variadic tail carries the event's typed
 * argument tuple (frontend-unified per event name), every argument
 * BORROWED — each adapter retains the +1 its callee owns. emit and
 * emit_error may leave an exception pending (a listener threw; an
 * unhandled 'error' throws its payload). */
typedef struct ScrEeReg ScrEeReg; /* the listener registry (lazy) */
typedef void (*ScrEeInvoke)(ScrClosure *cb, va_list ap);

typedef struct ScrEmitter {
  size_t rc;
  const ScrVt *vt;
  ScrEeReg *reg;   /* NULL until the first listener/setMaxListeners */
  const char *cls; /* display name for the leak warning ("EventEmitter") */
} ScrEmitter;

extern SCR_TL ScrVt scr_emitter_vt; /* main() stamps pre/post */
extern SCR_TL double scr_emitter_default_max;

ScrEmitter *scr_emitter_new(void); /* +1, collector-headered */
void scr_emitter_init(void *obj);  /* super() into the prefix (no-op today) */
ScrEmitter *scr_emitter_retain(ScrEmitter *em);
void scr_emitter_release(ScrEmitter *em); /* dispatches through em->vt */
void *scr_emitter_retain_v(void *em);
void scr_emitter_release_v(void *em);
void scr_emitter_trace(void *obj, ScrTraceVisit visit, void *ctx);

/* The emitted-subclass prefix helpers (the compiler's direct release /
 * trace / collector teardown call these for the embedded registry). */
void scr_emitter_reg_drop(ScrEeReg *reg);
void scr_emitter_reg_trace(ScrEeReg *reg, ScrTraceVisit visit, void *ctx);
void scr_emitter_reg_gcfree(ScrEeReg *reg);

/* on/once/prependListener/prependOnceListener: cb MOVES, name borrowed;
 * returns em +1 (the `return this` chaining value). 'newListener' fires
 * BEFORE the add; the leak warning prints at the crossing add. */
ScrEmitter *scr_emitter_on(ScrEmitter *em, ScrStr *name, ScrClosure *cb /*moves*/,
                            ScrEeInvoke inv, bool once, bool prepend);
/* The dyn-adapted registration family (JS-lane checked-dynamic
 * listeners). check_listener throws Node's ERR_INVALID_ARG_TYPE TypeError
 * (catchable, pending on return) when cb is not a function value; the
 * emitted registration helper calls it FIRST, so on_dyn/off_dyn take the
 * SCR_DYN_FUNC kind as given. on_dyn registers the compiler-built adapter
 * (what emit invokes — it boxes the tuple to dyn and calls the original
 * through the checked-dynamic machinery) and keeps the original (the dyn
 * box's underlying closure) as the entry's IDENTITY: off/removeListener
 * match it, listenerCount(name, fn) counts it, listeners() answers it.
 * cb is borrowed, adapter MOVES; both return em +1 (chaining). */
typedef struct ScrDyn ScrDyn; /* full definition below (C11 repeat) */
void scr_emitter_check_listener(const ScrDyn *cb);
ScrEmitter *scr_emitter_on_dyn(ScrEmitter *em, ScrStr *name, const ScrDyn *cb,
                                ScrClosure *adapter /*moves*/,
                                ScrEeInvoke inv, bool once, bool prepend);
ScrEmitter *scr_emitter_off_dyn(ScrEmitter *em, ScrStr *name, const ScrDyn *cb);
/* The adapter-mediated registration (the LLVM backend's listeners): the
 * ADAPTER closure is what emit invokes, the ORIGINAL closure is the
 * entry's identity (the on_dyn split, with a plain-closure identity).
 * Both MOVE in; returns em +1 (chaining). */
ScrEmitter *scr_emitter_on_via(ScrEmitter *em, ScrStr *name, ScrClosure *orig /*moves*/,
                                ScrClosure *adapter /*moves*/,
                                ScrEeInvoke inv, bool once, bool prepend);
/* Fixed-arity invoke shims for backends that cannot read a va_list
 * (LLVM textual IR is not va_arg-portable): shim k reads k POINTER-SIZE
 * slots off the emit tuple and calls cb->fn behind the fixed signature
 * `void (ScrClosure *, void * ×k)` — the fixed-signature adapter the
 * backend provides. Such backends pass every user tuple argument
 * pointer-classed at the emit site: scalar values point at call-lived
 * typed stack slots and reference values ride directly. The runtime's own
 * emits (data/error/pipe/meta) carry pointers only, so the shims read every
 * tuple either lane produces on 32- and 64-bit targets.
 * SCR_EE_FIXED_MAX is the registry's audited arity ceiling — backends
 * refuse listeners past it rather than guess. */
#define SCR_EE_FIXED_MAX 4
void scr_ee_inv_fixed0(ScrClosure *cb, va_list ap);
void scr_ee_inv_fixed1(ScrClosure *cb, va_list ap);
void scr_ee_inv_fixed2(ScrClosure *cb, va_list ap);
void scr_ee_inv_fixed3(ScrClosure *cb, va_list ap);
void scr_ee_inv_fixed4(ScrClosure *cb, va_list ap);
/* removeListener/off (LAST matching occurrence, Node's search order) and
 * removeAllListeners; both return em +1. 'removeListener' fires after
 * each removal when listened for. */
ScrEmitter *scr_emitter_off(ScrEmitter *em, ScrStr *name, ScrClosure *cb /*borrowed*/);
ScrEmitter *scr_emitter_remove_all(ScrEmitter *em, ScrStr *name, bool all);
/* emit: snapshot dispatch in listener order (once entries leave before
 * running); returns whether the event had listeners. The _error form is
 * emit('error', err): no listener ⇒ THROWS err (borrowed; +1 taken). */
bool scr_emitter_emit(ScrEmitter *em, ScrStr *name, ...);
bool scr_emitter_emit_error(ScrEmitter *em, ScrStr *name, ScrError *err);
double scr_emitter_listener_count(ScrEmitter *em, ScrStr *name);
double scr_emitter_listener_count_fn(ScrEmitter *em, ScrStr *name, ScrClosure *fn);
ScrArr *scr_emitter_event_names(ScrEmitter *em);          /* +1 string[] */
/* Pre-create a name's eventNames() rank with no listener (Node's stream
 * classes pre-create their known _events keys; empty = absent for every
 * other read). The stream constructors call this. */
void scr_emitter_reserve(ScrEmitter *em, const char *name);
ScrArr *scr_emitter_listeners(ScrEmitter *em, ScrStr *name); /* +1 closures */
ScrEmitter *scr_emitter_set_max(ScrEmitter *em, double n);   /* returns em +1 */
double scr_emitter_get_max(ScrEmitter *em);
void scr_emitter_set_default_max(double n);
double scr_emitter_get_default_max(void);
/* True when the emitter has at least one listener for `name` — the
 * stream unit's registration probe (and anyone else's). */
bool scr_emitter_has(ScrEmitter *em, const char *name);
/* Post-registration hook (one registrant: scr_stream_install) — called at
 * the END of scr_emitter_on with the emitter and the event name, so the
 * stream unit can start flowing on the first 'data' listener. NULL when
 * the stream unit is not linked; emitter behavior is byte-identical. */
extern void (*scr_emitter_on_hook)(ScrEmitter *em, ScrStr *name);

/* ── node:stream (scr_stream.c, link-gated by moduleUsesStream) ───────
 * The runtime-provided stream classes (Readable/Writable/Duplex/
 * Transform/PassThrough) behind the options-object constructor forms.
 * ONE layout for all five: the ScrEmitter prefix (so every emitter
 * mechanism — listener registry, emit dispatch, upcasts — applies
 * unchanged) plus a lazily-detailed state block. User `extends` of these
 * classes compiles (phase 2): the emitted subclass struct embeds this
 * full prefix (one extra slot over an emitter subclass — the state
 * pointer), allocation stamps the SUBCLASS vtable and display name and
 * leaves st NULL, and the constructor's super(options) call lands on a
 * scr_stream_init_* entry below. Stream identity for such instances is
 * preorder-interval membership under a runtime stream vtable (main()
 * stamps the intervals, the emitter-vt story).
 *
 * Event timing: Node defers most stream emissions by a process.nextTick.
 * Here those deferrals ride a dedicated TICK QUEUE drained at the top of
 * every loop turn (before the events/net/timer stations — the closest
 * station to nextTick; SEMANTICS.md documents the microtask-order
 * divergence), registered via scr_loop_set_stream at install. Emits run
 * user code synchronously on the dispatching stack and may leave an
 * exception pending, exactly like scr_emitter_emit — an unhandled
 * 'error' event throws its payload (Node's crash).
 *
 * Ownership: constructors take their option callbacks +1 (moves);
 * chunks are BORROWED at push/write (the buffer retains its copy);
 * chaining forms return the receiver +1; read()/errored answer +1 or
 * NULL. The *_done completion entries take err/data +1 (moves) — they
 * are called by compiler-emitted completion-callback closures. */
typedef struct ScrStreamState ScrStreamState;
typedef struct ScrBytes ScrBytes; /* full definition below (C11 repeat) */

typedef struct ScrStream {
  size_t rc;
  const ScrVt *vt;
  ScrEeReg *reg;   /* ScrEmitter prefix */
  const char *cls; /* ScrEmitter prefix (display name) */
  ScrStreamState *st;
} ScrStream;

extern ScrVt scr_readable_vt, scr_writable_vt, scr_duplex_vt,
    scr_transform_vt, scr_passthrough_vt; /* main() stamps pre/post */

/* Compiler-emitted option-callback invoke adapters (the leading-`this`
 * closures): the runtime calls the user's read/write/final/destroy/
 * transform/flush through these. */
typedef void (*ScrStreamReadInv)(ScrClosure *cb, ScrStream *s, double size);
typedef void (*ScrStreamChunkInv)(ScrClosure *cb, ScrStream *s, ScrBytes *chunk);
typedef void (*ScrStreamPlainInv)(ScrClosure *cb, ScrStream *s);
typedef void (*ScrStreamErrInv)(ScrClosure *cb, ScrStream *s, ScrError *err);

/* Constructors (+1 result; option callbacks MOVE; NULL = absent). hwm < 0
 * means the byte default (65536 — Node 24's getDefaultHighWaterMark). */
ScrStream *scr_stream_new_readable(double hwm, bool auto_destroy, bool emit_close,
    ScrClosure *read, ScrStreamReadInv read_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
ScrStream *scr_stream_new_writable(double hwm, bool auto_destroy, bool emit_close,
    ScrClosure *write, ScrStreamChunkInv write_inv,
    ScrClosure *final_cb, ScrStreamPlainInv final_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
ScrStream *scr_stream_new_duplex(double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *read, ScrStreamReadInv read_inv,
    ScrClosure *write, ScrStreamChunkInv write_inv,
    ScrClosure *final_cb, ScrStreamPlainInv final_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
ScrStream *scr_stream_new_transform(double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *transform, ScrStreamChunkInv transform_inv,
    ScrClosure *flush, ScrStreamPlainInv flush_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
ScrStream *scr_stream_new_passthrough(double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *transform, ScrStreamChunkInv transform_inv,
    ScrClosure *flush, ScrStreamPlainInv flush_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);

/* Subclass initialization (the emitted super(options) call over an
 * ALREADY-ALLOCATED subclass struct — same tails as the constructors;
 * receiver borrowed, callbacks move). Overridden underscore methods
 * (_read/_write/...) arrive as compiler-synthesized wrapper closures
 * that dispatch through the receiver's vtable. */
void scr_stream_init_readable(ScrStream *s, double hwm, bool auto_destroy, bool emit_close,
    ScrClosure *read, ScrStreamReadInv read_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
void scr_stream_init_writable(ScrStream *s, double hwm, bool auto_destroy, bool emit_close,
    ScrClosure *write, ScrStreamChunkInv write_inv,
    ScrClosure *final_cb, ScrStreamPlainInv final_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
void scr_stream_init_duplex(ScrStream *s, double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *read, ScrStreamReadInv read_inv,
    ScrClosure *write, ScrStreamChunkInv write_inv,
    ScrClosure *final_cb, ScrStreamPlainInv final_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
void scr_stream_init_transform(ScrStream *s, double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *transform, ScrStreamChunkInv transform_inv,
    ScrClosure *flush, ScrStreamPlainInv flush_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
void scr_stream_init_passthrough(ScrStream *s, double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *transform, ScrStreamChunkInv transform_inv,
    ScrClosure *flush, ScrStreamPlainInv flush_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);

/* The dyn-options twins (a checked-dynamic options record at
 * construction — `super(options)` forwarding a JS-lane parameter, `new
 * Readable(dynVar)`): the option walk runs at runtime with Node's own
 * reading rules (unknown keys ignored; consumed-but-unlowered options
 * throw the loud unsupported Error — MAY THROW, NULL result / no init
 * with the exception pending). opts is BORROWED; the fallback closures
 * (a subclass's overridden underscore-method wrappers, shadowed by
 * options callbacks per Node's instance-property rule) MOVE. */
ScrStream *scr_stream_new_readable_dyn(struct ScrDyn *opts);
ScrStream *scr_stream_new_writable_dyn(struct ScrDyn *opts);
ScrStream *scr_stream_new_duplex_dyn(struct ScrDyn *opts);
ScrStream *scr_stream_new_transform_dyn(struct ScrDyn *opts);
ScrStream *scr_stream_new_passthrough_dyn(struct ScrDyn *opts);
void scr_stream_init_readable_dyn(ScrStream *s, struct ScrDyn *opts,
    ScrClosure *read_fb, ScrStreamReadInv read_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv);
void scr_stream_init_writable_dyn(ScrStream *s, struct ScrDyn *opts,
    ScrClosure *write_fb, ScrStreamChunkInv write_fb_inv,
    ScrClosure *final_fb, ScrStreamPlainInv final_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv);
void scr_stream_init_duplex_dyn(ScrStream *s, struct ScrDyn *opts,
    ScrClosure *read_fb, ScrStreamReadInv read_fb_inv,
    ScrClosure *write_fb, ScrStreamChunkInv write_fb_inv,
    ScrClosure *final_fb, ScrStreamPlainInv final_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv);
void scr_stream_init_transform_dyn(ScrStream *s, struct ScrDyn *opts,
    ScrClosure *transform_fb, ScrStreamChunkInv transform_fb_inv,
    ScrClosure *flush_fb, ScrStreamPlainInv flush_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv);
void scr_stream_init_passthrough_dyn(ScrStream *s, struct ScrDyn *opts,
    ScrClosure *transform_fb, ScrStreamChunkInv transform_fb_inv,
    ScrClosure *flush_fb, ScrStreamPlainInv flush_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv);

/* stream.finished(s, cb) — the callback form: cb fires once at the
 * stream's terminal point (right after 'close'; asynchronously when
 * already closed) through the ErrInv ABI with the finish status (NULL /
 * the error / ERR_STREAM_PREMATURE_CLOSE). Returns the +1 CLEANUP
 * closure (a () => void unhooking the callback). cb MOVES. A registered
 * watcher marks lifecycle errors handled (no unhandled-'error' crash —
 * Node's eos registers listeners). */
ScrClosure *scr_stream_finished(ScrStream *s, ScrClosure *cb, ScrStreamErrInv inv);
/* The dyn-valued finished/pipeline callback inv (a mustCall wrapper in
 * the slot): success calls with NO arguments, errors box through the
 * boundary encoding. cb's cap boxes the dyn callable. */
void scr_stream_finished_dyn_inv(ScrClosure *cb, ScrStream *s, ScrError *err);
/* stream.pipeline(s1..sn, cb) — the callback form over stream arguments:
 * chains pipes (end: true), destroys every other stream with the first
 * error (Node's destroyer, pipeline order), and calls cb once after the
 * LAST 'close' with that error (or NULL). Streams borrowed; cb MOVES;
 * answers the destination +1 (pipeline's return value). */
ScrStream *scr_stream_pipeline(double n, ScrStream **streams, ScrClosure *cb, ScrStreamErrInv inv);
/* The dyn-valued twins (the callback as a checked-dynamic value —
 * mustCall wrappers; borrowed). */
ScrClosure *scr_stream_finished_dyn(ScrStream *s, struct ScrDyn *cb);
ScrStream *scr_stream_pipeline_dyn(double n, ScrStream **streams, struct ScrDyn *cb);

/* Emitted subclass RC/trace delegates for the state block (NULL-safe —
 * an exception before super(options) leaves st unset). The registry
 * slot rides scr_emitter_reg_* like any emitter subclass. */
void scr_stream_st_release(ScrStreamState *st);
void scr_stream_st_gcfree(ScrStreamState *st);
void scr_stream_st_trace(ScrStreamState *st, ScrTraceVisit visit, void *ctx);

/* The dyn-flavored completion-callback glues (the JS lane's implicitly-
 * any option callbacks / underscore methods): the emitted invoke thunks
 * mint a callable dyn (scr_dyn_new_func) over a 1-cap closure boxing the
 * retained stream, with the kind's glue — arguments arrive as dyn
 * values (error: null/undefined, a {message} object, or a string;
 * transform/flush data: bytes, a string, or absent). */
typedef struct ScrDyn ScrDyn; /* full declaration below (C11 repeat) */
ScrDyn *scr_stream_done_dyn_w(ScrClosure *clo, ScrDyn *const *args, size_t argc);
ScrDyn *scr_stream_done_dyn_f(ScrClosure *clo, ScrDyn *const *args, size_t argc);
ScrDyn *scr_stream_done_dyn_d(ScrClosure *clo, ScrDyn *const *args, size_t argc);
ScrDyn *scr_stream_done_dyn_t(ScrClosure *clo, ScrDyn *const *args, size_t argc);
ScrDyn *scr_stream_done_dyn_l(ScrClosure *clo, ScrDyn *const *args, size_t argc);

/* The readable surface. push/unshift borrow their chunk (strings convert
 * utf8, Node's decodeStrings default); push answers the below-hwm bool. */
bool scr_stream_push(ScrStream *s, ScrBytes *chunk);
bool scr_stream_push_str(ScrStream *s, ScrStr *str);
/* push(chunk, enc): the per-call literal encoding (canonical); overrides
 * the stream's defaultEncoding. Borrows both. */
bool scr_stream_push_str_enc(ScrStream *s, ScrStr *str, ScrStr *enc);
/* The defaultEncoding option's push side: how push(string) decodes chunks
 * (Buffer.from(chunk, enc)). Canonical literal, never "utf8". Receiver
 * answers +1 (the setEncoding chaining shape). */
ScrStream *scr_stream_set_push_encoding(ScrStream *s, ScrStr *enc);
bool scr_stream_push_null(ScrStream *s);
void scr_stream_unshift(ScrStream *s, ScrBytes *chunk);
void scr_stream_unshift_str(ScrStream *s, ScrStr *str);
ScrBytes *scr_stream_read(ScrStream *s, double size); /* +1 or NULL; size < 0 = all/first; throws once encoded (the static type is Buffer|null) */
/* setEncoding(enc): string-chunk mode — pushes decode through the
 * StringDecoder, 'data' delivers strings (the emit ABI carries both
 * payload slots; see scr_stream_emit_data), lengths count JS string
 * units. Borrows the canonical encoding name; receiver +1. */
ScrStream *scr_stream_set_encoding(ScrStream *s, ScrStr *enc);
typedef struct ScrPromise ScrPromise; /* full declaration below (C11 repeat) */
/* for-await: a +1 promise of the next chunk — buffered content (one
 * whole entry in Readable.from mode, the whole buffer otherwise —
 * Node's iterator read()), the EOF sentinel (an empty Buffer / dyn
 * undefined), or a rejection with the stream's error. The _dyn twin
 * boxes by runtime tag (the JS lane; encoded chunks arrive as dyn
 * strings); the typed form throws on encoded streams (chunks are
 * Buffers in typed code). At most one parked waiter (the loop awaits
 * each chunk before asking again). */
bool scr_stream_push_dyn(ScrStream *s, const ScrDyn *d);       /* borrows d; tag dispatch */
bool scr_stream_write_dyn(ScrStream *s, const ScrDyn *d, ScrClosure *cb); /* cb moves */
ScrPromise *scr_stream_next_chunk(ScrStream *s);
ScrPromise *scr_stream_next_chunk_dyn(ScrStream *s);
/* node:stream/promises — the promise forms over the finished/pipeline
 * machinery above: a pending void promise the terminal watcher settles
 * (fulfilled on a clean finish, rejected with the finish status
 * otherwise — the stream's error or ERR_STREAM_PREMATURE_CLOSE).
 * Streams borrowed; +1 promises. */
ScrPromise *scr_sp_finished(ScrStream *s);
ScrPromise *scr_sp_pipeline(double n, ScrStream **streams);
/* node:stream/consumers — the promise consumers over the readable
 * machinery: accumulate every chunk (string chunks as their utf8 bytes)
 * and settle at the terminal point (right after 'close', the eos timing
 * Node's consumers share) — text answers the utf8 decode, json parses
 * the text (malformed input rejects with the parse's SyntaxError; the
 * result is a +1 dyn tree), buffer the concatenated bytes. Stream
 * errors reject; an early close rejects ERR_STREAM_PREMATURE_CLOSE; a
 * stream with no readable side rejects Node's async-iterable TypeError.
 * Streams borrowed; +1 promises. */
ScrPromise *scr_sc_text(ScrStream *s);
ScrPromise *scr_sc_json(ScrStream *s);
ScrPromise *scr_sc_buffer(ScrStream *s);
/* Readable.from(array): +1 fully-seeded object-entry stream (one WHOLE
 * chunk per element — strings or Buffers per the flag; hwm 1, already
 * EOF'd). Borrows arr. */
ScrStream *scr_stream_from_arr(ScrArr *arr, bool strings);
ScrStream *scr_stream_pause(ScrStream *s);            /* recv +1 */
ScrStream *scr_stream_resume(ScrStream *s);           /* recv +1 */
bool scr_stream_is_paused(ScrStream *s);
double scr_stream_flowing(ScrStream *s); /* -1 = null, 0 = false, 1 = true */
ScrStream *scr_stream_pipe(ScrStream *src, ScrStream *dst, bool end); /* dst +1 */
ScrStream *scr_stream_unpipe(ScrStream *src, ScrStream *dst /*NULL = all*/); /* recv +1 */

/* The writable surface. write borrows its chunk; cb (when non-NULL)
 * MOVES and fires after the chunk's user write completes. */
bool scr_stream_write(ScrStream *s, ScrBytes *chunk, ScrClosure *cb /*moves*/);
bool scr_stream_write_str(ScrStream *s, ScrStr *str, ScrClosure *cb /*moves*/);
bool scr_stream_write_null(ScrStream *s); /* throws ERR_STREAM_NULL_VALUES */
ScrStream *scr_stream_end(ScrStream *s, ScrBytes *chunk_b, ScrStr *chunk_s,
                           ScrClosure *cb /*moves*/); /* recv +1 */
void scr_stream_cork(ScrStream *s);
void scr_stream_uncork(ScrStream *s);

/* Shared lifecycle. destroy's err is BORROWED (may be NULL). */
ScrStream *scr_stream_destroy(ScrStream *s, ScrError *err); /* recv +1 */
double scr_stream_prop(ScrStream *s, const char *name);
ScrError *scr_stream_errored(ScrStream *s); /* +1 or NULL */

/* The underscore-method assignment surface (`r._read = fn` after
 * construction — Node's own-property shadow of the prototype method):
 * the option-callback slot swaps its closure (+1 moves in, the old one
 * releases) and its compiler-emitted invoke thunk; the next dispatch
 * uses the new callback, Node's timing. */
void scr_stream_set_read(ScrStream *s, ScrClosure *cb, ScrStreamReadInv inv);
void scr_stream_set_write(ScrStream *s, ScrClosure *cb, ScrStreamChunkInv inv);
void scr_stream_set_final(ScrStream *s, ScrClosure *cb, ScrStreamPlainInv inv);
void scr_stream_set_destroy(ScrStream *s, ScrClosure *cb, ScrStreamErrInv inv);
void scr_stream_set_transform(ScrStream *s, ScrClosure *cb, ScrStreamChunkInv inv);
void scr_stream_set_flush(ScrStream *s, ScrClosure *cb, ScrStreamPlainInv inv);

/* Completion entries for the compiler-emitted done closures (err/data
 * MOVE; NULLs = absent). */
void scr_stream_write_done(ScrStream *s, ScrError *err);
void scr_stream_final_done(ScrStream *s, ScrError *err);
void scr_stream_destroy_done(ScrStream *s, ScrError *err);
void scr_stream_transform_done(ScrStream *s, ScrError *err, ScrBytes *data, ScrStr *data_str);
void scr_stream_flush_done(ScrStream *s, ScrError *err, ScrBytes *data, ScrStr *data_str);

/* RC / trace / install (the emitter-unit shapes). */
ScrStream *scr_stream_retain(ScrStream *s);
void scr_stream_release(ScrStream *s);
void *scr_stream_retain_v(void *s);
void scr_stream_release_v(void *s);
void scr_stream_trace(void *obj, ScrTraceVisit visit, void *ctx);
void scr_stream_install(void);

/* The loop's stream hook (scr_async.c): `pending` keeps the loop alive
 * while deferred ticks exist; `dispatch` drains them at every turn top —
 * the FIRST station (nextTick-most). Stream-free builds keep both NULL
 * and the loop is byte-identical. */
void scr_loop_set_stream(bool (*pending)(void), void (*dispatch)(void));
void scr_union_trace_v(void *u, ScrTraceVisit visit, void *ctx);
void scr_promise_trace_v(void *p, ScrTraceVisit visit, void *ctx);

/* ── exceptions ─────────────────────────────────────────────────────
 * One in-flight exception cell per execution context — the main stack plus
 * one per fiber (scr_async.c swaps the active cell on fiber switches).
 * `throw` stores the thrown value (taking ownership of refcounted payloads)
 * and sets the pending flag; the COMPILER emits a pending check after every call that can throw
 * and unwinds by releasing its frames/scopes and returning a dummy value —
 * no setjmp/longjmp (longjmp would skip the emitted RC releases). A `catch`
 * takes the exception by clearing the cell (the supported catch form is
 * bindingless, so the payload is released, not read); an exception still
 * pending when the entry function returns is uncaught: main prints it to
 * stderr and exits 1 (Node's uncaught exit code).
 *
 * Ref payloads carry their RC entry points as function pointers, exactly
 * like ScrUnion/SCR_BOX_OBJ: the runtime cannot know per-class/per-record
 * struct layouts. A throw while an exception is already pending REPLACES it
 * (the old payload is released) — that is JS's behavior for a throw inside
 * a `finally` running on the exception path.
 *
 * Ownership: scr_throw_str/_ref take ownership (+1 moves into the cell);
 * scr_exc_clear and scr_exc_print_uncaught release the payload, so a
 * pending exception never survives them (the RC audit stays meaningful).
 */

typedef enum {
  SCR_EXC_NONE = 0,
  SCR_EXC_F64,
  SCR_EXC_BOOL,
  SCR_EXC_STR,
  SCR_EXC_REF, /* array/closure/standalone object/record/union: RC via the fn ptrs */
  /* A HIERARCHY-class instance (the payload carries a vtable word after
   * rc): RC exactly like REF, but the dynamic class is inspectable — catch
   * bindings run instanceof against the payload's preorder interval, and
   * the uncaught/unhandled printers render Error instances as
   * "name: message" instead of "[object]". */
  SCR_EXC_OBJ,
  /* The generator-return sentinel (`gen.return(v)` injected at a suspended
   * yield): PENDING like an exception — the emitted pending checks unwind
   * through finally blocks — but it is a RETURN completion, not a throw:
   * catch handlers in generator bodies re-unwind on it (the emitted
   * sentinel prologue), and the generator trampoline consumes it (clears
   * the cell, promotes the parked return value to the completion value).
   * Carries NO payload (the value rides the generator's ret slot), so
   * scr_exc_clear/reset need no arm. Never escapes a generator fiber. */
  SCR_EXC_GENRET,
} ScrExcKind;

/* One cell per fiber (JS has one exception in flight per execution
 * context); scr_async.c swaps the active cell on fiber switches. */
typedef struct ScrExcCell {
  ScrExcKind kind;
  double f64;
  bool b;
  void *payload;
  void *(*retain_fn)(void *);
  void (*release_fn)(void *);
  /* Non-NULL iff the REF payload type carries a cycle header — carried
   * along so a rejection moving the payload into a promise keeps the
   * promise's payload edge traceable. */
  ScrTraceFn trace_fn;
} ScrExcCell;

/* Runtime-internal (fiber machinery in scr_async.c) — never emitted. */
ScrExcCell *scr_exc_swap_cell(ScrExcCell *cell); /* NULL = main's cell */
ScrExcCell *scr_exc_current_cell(void);          /* the ACTIVE cell */

bool scr_exc_pending(void);

void scr_throw_f64(double v);
void scr_throw_bool(bool v);
void scr_throw_str(ScrStr *v); /* takes ownership */
/* Takes ownership of v; retain/release must be non-NULL (the compiler
 * passes the payload type's `_v` adapters, like scr_union_new_ref); trace
 * is non-NULL iff the payload type carries a cycle header. */
void scr_throw_ref(void *v, void *(*retain)(void *), void (*release)(void *),
                    ScrTraceFn trace);
/* Same ownership contract as scr_throw_ref; the payload must be a
 * hierarchy-class instance (vtable word present) — see SCR_EXC_OBJ. */
void scr_throw_obj(void *v, void *(*retain)(void *), void (*release)(void *),
                    ScrTraceFn trace);

/* Catch: discard the in-flight exception (releases a refcounted payload). */
void scr_exc_clear(void);

/* ── catch bindings ───────────────────────────────────────────────────
 * `catch (e)` binds the in-flight exception as a refcounted SNAPSHOT box:
 * entering the catch MOVES the cell's payload into a fresh ScrCaught (the
 * pending flag clears), the binding releases with its scope like any
 * refcounted local, and every runtime question a catch body may ask —
 * typeof-style kind tests (emitted as direct kind reads), instanceof over
 * hierarchy payloads, payload extraction, rethrow — reads the box. The box
 * itself carries no collector header: bindings live only in frames (the
 * frontend rejects captures), so no cycle can pass through it, and its
 * payload reference simply counts as an external edge — trial deletion
 * restores it on scan. */
typedef struct ScrCaught {
  size_t rc;
  ScrExcKind kind; /* never SCR_EXC_NONE */
  double f64;
  bool b;
  void *payload;
  void *(*retain_fn)(void *);
  void (*release_fn)(void *);
  ScrTraceFn trace_fn;
} ScrCaught;

ScrCaught *scr_exc_take(void); /* moves the pending cell into a fresh box (+1) */
ScrCaught *scr_caught_retain(ScrCaught *c);
void scr_caught_release(ScrCaught *c); /* NULL-tolerant */
/* Borrows the box; re-raises the saved exception exactly (payload RETAINED
 * — the binding stays live until its scope exits). */
void scr_rethrow(const ScrCaught *c);
/* `e instanceof C` on a catch binding: an OBJ payload whose vtable preorder
 * lies inside C's interval. False for every other payload kind. */
bool scr_caught_instanceof(const ScrCaught *c, size_t pre, size_t post);
/* `String(e)` / `${e}` on a catch binding: JS's String() over the snapshot
 * — numbers/booleans/strings by value, Error payloads via
 * scr_error_to_string ("name: message" — String(e) carries no stack in
 * Node either), every other ref payload "[object Object]" (exact for
 * records and toString-less class instances; a documented approximation
 * for thrown arrays/closures/union boxes). Borrows the box; returns +1. */
ScrStr *scr_caught_to_string(const ScrCaught *c);
/* `e as C` on a catch binding (scr_lib.c): an OBJ payload inside C's
 * preorder interval extracts (retained, +1); every other payload THROWS a
 * catchable TypeError naming `cls`. Callers are compiler-emitted pending
 * checks. */
void *scr_caught_check_obj(const ScrCaught *c, size_t pre, size_t post,
                            const char *cls);
/* The snapshot as a dyn value (scr_json.c): identity-preserving for dyn
 * payloads and %Error instances, scalars by value, the type-erased empty
 * object for the rest (SEMANTICS.md 67). Borrows the box; +1. */
typedef struct ScrDyn ScrDyn; /* full definition below (C11 repeat) */
ScrDyn *scr_caught_to_dyn(const ScrCaught *c);

/* Uncaught path (called by main before exiting 1): flushes stdout, prints
 * "Uncaught <value>" to stderr (strings raw, numbers JS-exact, booleans
 * true/false, ref payloads as "[object]"), and releases the payload. */
void scr_exc_print_uncaught(void);

/* ── standard library: process + node:fs (scr_lib.c) ─────────────────
 * Called once at the top of main, right after scr_init: stashes argc/argv
 * (the interned process.argv array is built lazily on first read) and
 * registers an atexit cleanup that releases the library's interned values
 * BEFORE the RC audit runs (atexit is LIFO; scr_init registered the audit
 * earlier). scriptc argv shape: ["scriptc", argv[0], argv[1], ...] so
 * positions and length line up with Node's [node-path, script-path, ...args]
 * — the argv[0]/argv[1] VALUES diverge (see SEMANTICS.md).
 */
void scr_lib_init(int argc, char **argv);

/* +1 on the ONE interned argv array (identity and mutation semantics match
 * Node's stable process.argv). */
ScrArr *scr_process_argv(void);
/* Raw argv accessors — the island's process shim builds the same
 * ["scriptc", argv[0], ...] shape from the same stash. */
int scr_lib_arg_count(void);
const char *scr_lib_arg(int i);
ScrStr *scr_process_platform(void); /* +1 interned ("darwin", "linux", ...) */
ScrStr *scr_process_cwd(void);      /* +1 fresh (getcwd) */
/* Submit one raw chunk to fd 1/2 and flush it before returning. Used by all
 * JavaScript-visible console/process/readline/island output paths so the
 * internal stdio formatting buffer never delays live output. */
void scr_stdio_write(int fd, const void *data, size_t len);
/* process.stdout/.stderr .write — raw bytes (no newline or formatting; data
 * borrowed), promptly visible and ordered with console output. Constantly
 * true (the synchronous runtime never queues backpressure). */
bool scr_process_stdout_write(const ScrStr *data);
bool scr_process_stderr_write(const ScrStr *data);
/* The first-class WritableStream write: fd is the stream value itself
 * (1 = stdout, 2 = stderr — process.stdout/stderr reads mint it). */
bool scr_proc_stream_write(double fd, const ScrStr *data);
/* getenv(3) behind process.env.<NAME>: +1 fresh string when the variable is
 * set, NULL when absent. The compiler wraps the result into the interned
 * `string | undefined` union type-directedly (the runtime knows no tags);
 * the name is borrowed. Never throws. */
ScrStr *scr_env_get(const ScrStr *name);
/* setenv(3) behind process.env.NAME = v: later env reads and spawned
 * children observe the write, like Node. Both borrowed. Never throws. */
void scr_env_set(const ScrStr *name, const ScrStr *value);
void scr_env_unset(const ScrStr *name); /* delete process.env.NAME */
/* The whole environment as alternating [k, v, k, v, ...] strings in
 * environ order — the compiler's process.env snapshot builds its record
 * from this. +1 fresh array. Never throws. */
ScrArr *scr_env_pairs(void);
/* getpid(2) / getuid(2) — POSIX-only target, always answer. */
double scr_process_pid(void);
double scr_process_getuid(void);
double scr_process_getgid(void);
/* process.execPath: the running binary's own resolved absolute path
 * (_NSGetExecutablePath/readlink(/proc/self/exe) + realpath), interned on
 * first read; +1 per read. Node's value is the node executable's path —
 * SEMANTICS.md divergence 12 documents the difference. */
ScrStr *scr_process_exec_path(void);
/* process.arch: the binary's OWN architecture ("arm64", "x64") — Node's
 * answer for its own build on the same machine. +1 interned. */
ScrStr *scr_process_arch(void);
/* process.versions.node: the runtime's Node COMPATIBILITY TARGET — no
 * Node exists under a compiled binary, so this reports the version whose
 * semantics the runtime implements (SEMANTICS.md divergence 60). +1
 * interned. */
ScrStr *scr_process_versions_node(void);
ScrStr *scr_process_versions_openssl(void);
/* process.kill with Node's exact semantics: int32 pid validation (the
 * ERR_INVALID_ARG_TYPE TypeError text), Node's signal-name table for the
 * named form (unknown names throw the ERR_UNKNOWN_SIGNAL TypeError),
 * signal 0 probes, kill(2) failure throws Node's `kill ESRCH`/`kill
 * EPERM` Error. Both return Node's constant true; the signal string is
 * borrowed. */
bool scr_process_kill(double pid, double signum);
bool scr_process_kill_named(double pid, const ScrStr *signal);
/* fflush stdout, then _Exit((int)code): no atexit handlers run — the RC
 * audit is deliberately skipped (exiting mid-program leaves live values). */
void scr_process_exit(double code);
/* process._exiting: true once the exit sequence began (process.exit or
 * the exit-listener runner set the flag). Never throws. */
extern SCR_TL bool scr_process_in_exit;
bool scr_process_exiting(void);
/* umask(2): mask < 0 reads without setting; otherwise sets and answers
 * the previous mask. Never throws. */
double scr_process_umask(double mask);
/* The process introspection statics (scr_lib.c; Node's units). uptime:
 * fractional seconds since the binary's load-time anchor. The CPU clocks
 * answer microseconds; the *_diff forms subtract a prior sample, and
 * scr_cpu_prev_validate throws Node's ERR_INVALID_ARG_VALUE RangeError
 * (user first, then system) for negative/non-finite prev fields.
 * rusage(idx) answers one resourceUsage() field by canonical index.
 * available/constrained memory are libuv's numbers (0 where the platform
 * has no answer). scr_active_resources (scr_async.c) walks the loop's
 * own bookkeeping — 'Timeout'/'Immediate' strings, +1. */
double scr_process_uptime(void);
/* perf_hooks performance.now(): fractional ms since process start (the
 * uptime anchor — Node's timeOrigin for a compiled program). */
double scr_perf_now(void);
double scr_cpu_user(void);
double scr_cpu_system(void);
double scr_cpu_user_diff(double prev);
double scr_cpu_system_diff(double prev);
double scr_thread_cpu_user(void);
double scr_thread_cpu_system(void);
double scr_thread_cpu_user_diff(double prev);
double scr_thread_cpu_system_diff(double prev);
void scr_cpu_prev_validate(double user, double system);
double scr_process_rusage(double idx);
double scr_available_memory(void);
double scr_constrained_memory(void);
ScrArr *scr_active_resources(void);
/* chdir(2) — throws Node's fs-shaped error on failure (syscall "chdir"). */
void scr_process_chdir(ScrStr *dir);
/* net's process-wide happy-eyeballs attempt budget (default 250ms) — in
 * the core unit so the knob never links scr_net.c. Never throw. */
double scr_net_get_autosel_timeout(void);
void scr_net_set_autosel_timeout(double ms);

/* Synchronous fs, utf8-only (paths and contents are ScrStr bytes). All
 * ScrStr arguments are BORROWED; string/array results return +1. On
 * failure every function except scr_fs_exists THROWS through the exception
 * cell (scr_throw_str) a CATCHABLE string formatted like Node's common
 * error messages ("ENOENT: no such file or directory, open 'x'") and
 * returns a dummy (false/NULL) — callers are compiler-emitted pending
 * checks. scr_fs_exists mirrors Node's existsSync: errors become false,
 * never a throw. */
ScrStr *scr_fs_read_file(ScrStr *path);
/* realpath(3) (+1 fresh); failures throw with Node's realpathSync
 * spelling (syscall "lstat"). */
ScrStr *scr_fs_realpath(ScrStr *path);
void scr_fs_write_file(ScrStr *path, ScrStr *data);
void scr_fs_append_file(ScrStr *path, ScrStr *data);
bool scr_fs_exists(ScrStr *path);
void scr_fs_mkdir(ScrStr *path);
/* Files only, like Node's rmSync without `recursive` (a directory throws an
 * EISDIR-coded error; use scr_fs_rmdir for empty directories). */
void scr_fs_rm(ScrStr *path);
void scr_fs_rmdir(ScrStr *path);
ScrArr *scr_fs_readdir(ScrStr *path); /* names, OS order, no "."/".." */

/* The fs option forms (same throw discipline). mkdir_recursive is Node's
 * recursive algorithm (existing-dir target is a no-op; errors report
 * Node's errno at Node's path). rm_opts is rmSync with the recursive/
 * force booleans: force swallows ENOENT, recursive removes trees
 * post-order, a directory without recursive keeps the EISDIR wording
 * divergence. mkdtemp appends the six X's and returns the created path
 * (+1). access takes the F_OK/R_OK/W_OK/X_OK bits. read_fd is a read(2)
 * loop to EOF (Node's readFileSync(fd) shape — the stdin pattern);
 * failures throw Node's no-path message ("EBADF: bad file descriptor,
 * read"). */
void scr_fs_mkdir_recursive(ScrStr *path);
void scr_fs_rm_opts(ScrStr *path, bool recursive, bool force);
/* The maxRetries/retryDelay form: retries EBUSY/EMFILE/ENFILE/ENOTEMPTY/
 * EPERM failures up to maxRetries times with Node's linear backoff
 * (retryDelay ms longer per try); everything else throws immediately. */
void scr_fs_rm_opts_retry(ScrStr *path, bool recursive, bool force, double max_retries, double retry_delay);
ScrStr *scr_fs_mkdtemp(ScrStr *prefix);
void scr_fs_access(ScrStr *path, double mode);
ScrStr *scr_fs_read_fd(double fd);

/* The wider sync fs slice (same throw discipline; `.code` stamped like
 * the rest). unlink/chmod/chown wrap the syscalls 1:1. copyfile copies
 * contents into a created-or-truncated destination carrying the SOURCE's
 * mode; its errors quote both paths ("copyfile 'src' -> 'dest'", Node's
 * shape). write_file_mode is writeFileSync(p, data, { mode }) — the mode
 * applies at creation only. The mkdir *_mode twins take mkdirSync's
 * explicit mode (the recursive walk passes it to every directory it
 * creates). */
void scr_fs_unlink(ScrStr *path);
void scr_fs_chmod(ScrStr *path, double mode);
void scr_fs_chown(ScrStr *path, double uid, double gid);
void scr_fs_copyfile(ScrStr *src, ScrStr *dest);
void scr_fs_rename(ScrStr *oldpath, ScrStr *newpath);
/* The callback rename worker uses the non-throwing syscall seam off the
 * runtime thread, then materializes any Node-shaped Error back on the main
 * thread. raw returns 0 on success or a positive errno value on failure. */
int scr_fs_rename_raw(const ScrStr *oldpath, const ScrStr *newpath);
void scr_fs_rename_error(int error, const ScrStr *oldpath, const ScrStr *newpath);
void scr_fs_write_file_mode(ScrStr *path, ScrStr *data, double mode);
void scr_fs_mkdir_mode(ScrStr *path, double mode);
void scr_fs_mkdir_recursive_mode(ScrStr *path, double mode);

/* Atomics.wait(int32Array, idx, expected, timeoutMs): "not-equal" when
 * the element differs from expected, else a real nanosleep for the
 * timeout and "timed-out" (+1 string either way). scriptc has no
 * threads, so nothing can ever notify — for every compilable program
 * this IS the spec's behavior and "ok" is unreachable (the compiler
 * requires the timeout argument; an infinite wait would be a certain
 * deadlock). Out-of-range indices trap like every bytes access. */
typedef struct ScrBytes ScrBytes; /* full definition below (C11 repeat) */
ScrStr *scr_atomics_wait(ScrBytes *arr, double idx, double expected, double timeout_ms);

/* isatty(3) over an fd (0/1/2): a real boolean — false where Node's
 * non-TTY streams expose undefined (SEMANTICS.md). stdin_destroy is a
 * documented no-op. */
bool scr_process_is_tty(double fd);
void scr_process_stdin_destroy(void);
void scr_process_stdin_set_raw_mode(bool raw);

/* Terminal width for process.stdout/stderr.columns (fd 1/2):
 * ioctl(TIOCGWINSZ), -1 when the fd is not a TTY or the ioctl refuses —
 * the emitter wraps a non-negative width into the `number | undefined`
 * union's number arm and -1 into its undefined arm (Node's non-TTY
 * `.columns` is undefined). Never throws. */
double scr_process_columns(double fd);

/* Stats values (statSync / fs.promises.stat): an immutable snapshot of
 * stat(2) — follows symlinks, like Node's stat family. scr_fs_stat
 * THROWS like the other sync calls. */
typedef struct ScrStats ScrStats;
typedef struct ScrFileHandle ScrFileHandle;
typedef struct ScrPromise ScrPromise; /* full section further down */

ScrStats *scr_fs_stat(ScrStr *path);  /* +1, or throws */
ScrStats *scr_fs_lstat(ScrStr *path); /* +1, or throws; NO follow (lstat) */
ScrStats *scr_stats_retain(ScrStats *s);
void scr_stats_release(ScrStats *s);
void *scr_stats_retain_v(void *p);
void scr_stats_release_v(void *p);
bool scr_stats_is_file(ScrStats *s);
bool scr_stats_is_dir(ScrStats *s);
bool scr_stats_is_symlink(ScrStats *s); /* lstat snapshots only */
double scr_stats_size(ScrStats *s);
double scr_stats_blocks(ScrStats *s); /* allocated size in 512-byte units */
double scr_stats_nlink(ScrStats *s);
double scr_stats_atime_ms(ScrStats *s); /* ms with the sub-second fraction */
double scr_stats_mtime_ms(ScrStats *s); /* ms with the ns fraction */

/* fs/promises: the SAME sync operations, minting an already-settled
 * promise — success fulfills, failure REJECTS with the would-be thrown
 * error (catchable at the await, like Node). The syscall blocks the loop:
 * I/O never interleaves with timers/other fibers (SEMANTICS.md). Implemented in
 * scr_async.c beside the promise machinery (the runtime unit tests link
 * scr_lib.c without the fiber slice). */
ScrPromise *scr_fsp_read_file(ScrStr *path);
ScrPromise *scr_fsp_write_file(ScrStr *path, ScrStr *data);
ScrPromise *scr_fsp_write_file_mode(ScrStr *path, ScrStr *data, double mode);
ScrPromise *scr_fsp_mkdir(ScrStr *path);
ScrPromise *scr_fsp_mkdir_mode(ScrStr *path, double mode);
ScrPromise *scr_fsp_mkdir_recursive(ScrStr *path);
ScrPromise *scr_fsp_mkdir_recursive_mode(ScrStr *path, double mode);
ScrPromise *scr_fsp_unlink(ScrStr *path);
ScrPromise *scr_fsp_chmod(ScrStr *path, double mode);
ScrPromise *scr_fsp_readdir(ScrStr *path);
ScrPromise *scr_fsp_rm(ScrStr *path);
ScrPromise *scr_fsp_stat(ScrStr *path);
ScrPromise *scr_fsp_rename(ScrStr *oldpath, ScrStr *newpath);
ScrPromise *scr_fsp_open(ScrStr *path, ScrStr *flags, double mode);
ScrPromise *scr_file_handle_close_promise(ScrFileHandle *h);
ScrPromise *scr_file_handle_read_file_promise(ScrFileHandle *h, ScrStr *encoding);
ScrPromise *scr_file_handle_read_file_bytes_promise(ScrFileHandle *h, ScrStr *encoding);
ScrPromise *scr_file_handle_write_file_promise(ScrFileHandle *h, ScrStr *data, ScrStr *encoding);
ScrPromise *scr_file_handle_write_file_bytes_promise(ScrFileHandle *h, ScrBytes *data, ScrStr *encoding);
ScrPromise *scr_file_handle_stat_promise(ScrFileHandle *h);

/* fs.rename: the syscall is submitted to a native worker immediately and
 * its error-first callback fires on a later event-loop turn through an
 * emitted, program-shaped adapter. Both paths and the callback are borrowed
 * at entry; the callback MOVES into the operation. err is borrowed and NULL
 * on success. */
typedef void (*ScrFsRenameFn)(ScrClosure *cb, ScrError *err);
void scr_fs_rename_async(ScrStr *oldpath, ScrStr *newpath,
                         ScrClosure *cb /*moves*/, ScrFsRenameFn fn);
void scr_fs_rename_thunk0(ScrClosure *cb, ScrError *err);

/* ── node:timers/promises (scr_async.c) ──────────────────────────────
 * The promisified pair: a PENDING void promise a one-shot heap timer /
 * the immediate queue fulfills (the armed entry keeps the loop alive
 * until it fires, like Node). Results +1; neither throws. */
ScrPromise *scr_tp_set_timeout(double ms);
ScrPromise *scr_tp_set_immediate(void);

/* ── node:diagnostics_channel (scr_dc.c — linked when the IR carries
 * dc.* libCalls) ─────────────────────────────────────────────────────
 * A process-global name→channel registry; channel handles are 1-based
 * f64 indexes into it (Node's channels are process-lived too, its
 * WeakRef machinery aside — the registry tears down atexit before the
 * RC audit). Subscribers are dyn FUNCTION values, identity-matched by
 * unsubscribe (the underlying closure, so re-boxings of one function
 * still match — JS has ONE function object). publish calls each
 * subscriber of a SNAPSHOT with (message, name); a subscriber's throw
 * propagates out (MAY THROW — the documented divergence from Node's
 * triggerUncaughtException). subscribe/unsubscribe throw Node's
 * ERR_INVALID_ARG_TYPE TypeError for non-function subscribers (MAY
 * THROW). Names and subscriber args are BORROWED; chanName's result +1. */
double scr_dc_channel(ScrStr *name);
void scr_dc_subscribe(ScrStr *name, ScrDyn *cb);
bool scr_dc_unsubscribe(ScrStr *name, ScrDyn *cb);
bool scr_dc_has_subscribers(ScrStr *name);
void scr_dc_publish(double handle, ScrDyn *message);
void scr_dc_chan_subscribe(double handle, ScrDyn *cb);
bool scr_dc_chan_unsubscribe(double handle, ScrDyn *cb);
bool scr_dc_chan_has_subscribers(double handle);
ScrStr *scr_dc_chan_name(double handle);

/* TracingChannel (dc.tracingChannel): a registry entry of the five event
 * channels (tracing:<name>:start|end|asyncStart|asyncEnd|error), handled
 * as a 1-based f64 exactly like Channel. subscribe/unsubscribe walk the
 * handlers object's five event keys (truthy slots route to the per-channel
 * add/remove — a non-function slot throws there, Node's order);
 * unsubscribe answers Node's all-found conjunction. traceSync/traceCallback
 * mirror Node's publish choreography over the checked-dynamic tree: ctx must be an OBJ (the
 * lowering builds the default `{}`), fn/thisArg/args are dyn values (args
 * an ARR of the call arguments); the traced call binds thisArg as the
 * ambient receiver; result/error stamp onto ctx before end/error publish;
 * a traced throw and a subscriber throw both propagate (MAY THROW). All
 * arguments BORROWED; trace results +1 (or NULL with the exception
 * pending). traceCallback wraps args[position] (JS-style negative
 * indexing) in a native wrapper publishing error/result + asyncStart/
 * asyncEnd around the original callback, throwing Node's
 * ERR_INVALID_ARG_TYPE when the slot is not a function. */
double scr_dc_tracing_channel(ScrStr *name);
double scr_dc_tracing_channel_of(double start, double end, double async_start,
                                  double async_end, double error);
double scr_dc_tc_channel(double h, double idx); /* 0=start..4=error */
bool scr_dc_tc_has_subscribers(double h);
void scr_dc_tc_subscribe(double h, ScrDyn *handlers);
bool scr_dc_tc_unsubscribe(double h, ScrDyn *handlers);
ScrDyn *scr_dc_tc_trace_sync(double h, ScrDyn *fn, ScrDyn *ctx, ScrDyn *this_arg, ScrDyn *args);
ScrDyn *scr_dc_tc_trace_callback(double h, ScrDyn *fn, double position, ScrDyn *ctx,
                                  ScrDyn *this_arg, ScrDyn *args);
/* bindStore / runStores (the AsyncLocalStorage integration): per-store
 * SET semantics (a re-bind replaces the transform; a non-function
 * transform means identity); runStores enters every bound store with
 * transform(data), publishes inside the entered contexts, runs fn with
 * thisArg bound and arguments forwarded, and restores in reverse. The
 * tracing choreography enters the start channel's stores around
 * traceSync/traceCallback/tracePromise bodies and the asyncStart
 * channel's around traceCallback's wrapped callback. */
void scr_dc_chan_bind_store(double handle, double als_id, ScrDyn *transform);
bool scr_dc_chan_unbind_store(double handle, double als_id);
ScrDyn *scr_dc_chan_run_stores(double handle, ScrDyn *data, ScrDyn *fn, ScrDyn *this_arg,
                               ScrDyn *args);
/* tracePromise: publishes start, runs fn (throw → error + end + rethrow,
 * NULL result with the exception pending), wraps a non-promise result,
 * publishes end, and returns the REACTION promise (+1) — a fiber that
 * awaits the traced promise, stamps ctx.result/ctx.error, publishes
 * asyncStart/asyncEnd (plus error first on rejection), and settles the
 * result with the passed-through outcome. No-subscriber calls skip the
 * choreography (Node's early exit) but still answer a promise. */
ScrPromise *scr_dc_tc_trace_promise(double h, ScrDyn *fn, ScrDyn *ctx, ScrDyn *this_arg,
                                     ScrDyn *args);

/* ── child_process (scr_child.c) ─────────────────────────────────────
 * The synchronous slice: spawnSync as posix_spawnp + piped utf8 capture +
 * waitpid — blocks until the child is reaped (no zombie can outlive the
 * call). NEVER throws: spawn failure (nonexistent binary, EACCES) is data
 * — has_status false and empty outputs — like Node's `error` property
 * (Node types stdout/stderr null there; divergence in SEMANTICS.md).
 * A signal-killed child also has no status (Node's status: null). */
typedef struct ScrSpawnRes ScrSpawnRes;

ScrSpawnRes *scr_spawn_sync(ScrStr *cmd, ScrArr *args); /* +1, never throws */
/* The options form (cp.spawnSyncOpts): timeout_ms > 0 sends killsignal
 * (a signal NAME; "" = SIGTERM) at the deadline and the result carries
 * error: ETIMEDOUT + the signal — never a throw. stdio modes: stdin 0 =
 * /dev/null, 2 = inherit; stdout/stderr 0 = capture, 1 = ignore, 2 =
 * inherit (non-captured outputs read "" — the documented stance). */
ScrSpawnRes *scr_spawn_sync_opts(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                  ScrStr *killsignal, double in_mode,
                                  double out_mode, double err_mode);
/* The runtime-string stdio entry: the compiler proved the value is
 * "pipe" | "ignore" | "inherit" by type; the mode mapping happens here. */
ScrSpawnRes *scr_spawn_sync_stdio_str(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                       ScrStr *killsignal, ScrStr *stdio);
/* execFileSync/execSync behind one entry: posix_spawn(p) + piped utf8
 * capture + waitpid with Node's exact error shapes — non-zero exit or
 * signal death throws Error("Command failed: <cmd>[\n<stderr>]"), spawn
 * failure throws "spawnSync <file> ENOENT", a timeout SIGTERMs the child
 * and throws "spawnSync <file> ETIMEDOUT" (messages only — Node's
 * status/stdout/stderr error properties don't exist, SEMANTICS.md).
 * shell=true runs /bin/sh -c (args must be ["-c", cmd]); has_input false
 * means the input option is ABSENT (stdin from /dev/null — Node's model
 * for an undefined member), true feeds the bytes to a stdin pipe ("" is
 * the pipe with immediate EOF); cwd "" inherits; has_env false inherits
 * environ, true REPLACES it with the [k,v,...] pairs; timeout_ms <= 0
 * disables; stdout_mode 1 captures / 0 ignores / 2 inherits the parent's
 * fd, plus bit 4 = the CHILD'S STDIN inherits (stdio "inherit"; the
 * flag rides stdout_mode because the signature predates it); stderr_mode
 * 0 captures AND echoes to the parent stderr after completion (Node's
 * no-stdio-option default), 1 captures only, 2 ignores, 3 inherits.
 * Result is the captured utf8 stdout (+1) — "" when nothing captures
 * (Node answers null there; discarded results cannot tell). All args
 * borrowed. */
ScrStr *scr_exec_sync(ScrStr *cmd, ScrArr *args, bool shell, ScrStr *input,
                       bool has_input, ScrStr *cwd, bool has_env, ScrArr *env_pairs,
                       double timeout_ms, double stdout_mode, double stderr_mode);
/* The promisified-execFile capture (cp.execCapture): the same core in the
 * async shape — both streams captured (no echo), Node's ASYNC error
 * messages on the throw paths ("Command failed: <cmd>\n<stderr>" with the
 * unconditional newline, "spawn <file> <ERR>" with .code, timeouts as
 * ordinary SIGTERM command failures). +1 ScrSpawnRes on success (stdout +
 * stderr; status unused). All args borrowed. */
ScrSpawnRes *scr_exec_capture(ScrStr *cmd, ScrArr *args, ScrStr *cwd,
                               bool has_env, ScrArr *env_pairs, double timeout_ms);
ScrSpawnRes *scr_spawn_res_retain(ScrSpawnRes *r);
void scr_spawn_res_release(ScrSpawnRes *r);
void *scr_spawn_res_retain_v(void *p);
void scr_spawn_res_release_v(void *p);
bool scr_spawn_res_has_status(ScrSpawnRes *r);
double scr_spawn_res_status(ScrSpawnRes *r);
ScrStr *scr_spawn_res_stdout(ScrSpawnRes *r); /* +1 */
ScrStr *scr_spawn_res_stderr(ScrSpawnRes *r); /* +1 */
/* result.signal — the termination signal's name when a signal killed the
 * child (a timeout's killSignal included), the null arm otherwise; the
 * emitter wraps type-directedly over the has/get pair like status. */
bool scr_spawn_res_has_signal(ScrSpawnRes *r);
ScrStr *scr_spawn_res_signal(ScrSpawnRes *r); /* +1; has_signal only */
/* Node's `error` property: +1 %Error ("spawnSync <file> ENOENT", `code`
 * stamped) when the spawn itself failed, NULL otherwise (the undefined
 * arm — the emitter wraps type-directedly, the envGet convention). */
ScrError *scr_spawn_res_error(ScrSpawnRes *r);

/* argv construction shared by spawnSync and spawn: a NULL-terminated
 * vector borrowing the strings (alive while cmd/args are); free() the
 * vector only. */
char **scr_child_argv(ScrStr *cmd, ScrArr *args);

/* The asynchronous child: spawn starts it immediately (stdio all on
 * /dev/null — the compiler fences everything but { stdio: "ignore" })
 * and registers it with the event loop, which sweeps waitpid(WNOHANG) at
 * quiescence (scr_children_poll) and fires listeners at reap; between
 * turns the loop's sleep waits on a kqueue PROC filter, so an exit wakes
 * it immediately (scr_children_wait; ~1ms polling is the fallback). "exit"
 * fires once with the code (or none — signal death → the null arm);
 * "error" fires ONLY for spawn failure, and with no listener registered
 * it prints the error and exits 1 (Node's unhandled-'error' behavior).
 * Listener callbacks MOVE in and are released when the child settles; a
 * listener registered after settling is released and never fires. The
 * adapters bridge the runtime's fixed firing ABI to the callback's
 * compiled shape: exit_thunk0/err_thunk0 ignore the payload (zero-param
 * listeners), err_thunk_error constructs the %Error instance, and the
 * `(code: number | null)` shape is compiler-emitted (union tags are
 * program data). */
typedef struct ScrChild ScrChild;
/* A piped child-output stream (child.stdout / child.stderr — stdio mode
 * 3): refcounted like the child; 'data' fires one Buffer chunk per
 * read(2) (≤64KB, consumer-driven — no listener, no read: the pipe is
 * the buffer), 'end' fires once at EOF and always BEFORE the child's
 * own 'exit' (Node's pinned ordering; the settle path drains first). A
 * flowing stream (data consumer, not yet EOF) keeps the loop alive. */
typedef struct ScrChildStream ScrChildStream;
/* The data adapter: the chunk arrives BORROWED (multiple listeners see
 * the same chunk); adapters retain what they keep. */
typedef void (*ScrChildStreamDataFn)(ScrClosure *cb, ScrBytes *chunk);
/* signal_name: the termination signal's name (static storage) when a
 * signal killed the child, NULL otherwise — Node's second exit-listener
 * parameter; zero/one-param adapters ignore it. */
typedef void (*ScrChildExitFn)(ScrClosure *cb, bool has_code, double code,
                               const char *signal_name);
typedef void (*ScrChildErrFn)(ScrClosure *cb, ScrStr *msg);

ScrChild *scr_spawn(ScrStr *cmd, ScrArr *args); /* +1, never throws */
/* The options form (cp.spawnOpts): PER-SLOT stdio modes — 0 = ignore
 * (/dev/null), 1 = inherit, 2 = fd (out/err only: out_fd/err_fd dup2
 * into the child's slot, the openSync daemon-log idiom), 3 = pipe
 * (out/err only: the read end becomes the child.stdout/stderr stream);
 * detached = POSIX_SPAWN_SETSID (own session/process group); env
 * REPLACES the child environment when has_env ([k,v,...] pairs); cwd ""
 * = inherit. */
ScrChild *scr_spawn_opts(ScrStr *cmd, ScrArr *args, double in_mode,
                          double out_mode, double err_mode, double out_fd,
                          double err_fd, bool detached, bool has_env,
                          ScrArr *env_pairs, ScrStr *cwd);
ScrChild *scr_child_retain(ScrChild *c);
void scr_child_release(ScrChild *c);
void *scr_child_retain_v(void *p);
void scr_child_release_v(void *p);
void scr_child_on_exit(ScrChild *c, ScrClosure *cb /*moves*/, ScrChildExitFn fn);
void scr_child_on_error(ScrChild *c, ScrClosure *cb /*moves*/, ScrChildErrFn fn);
void scr_child_exit_thunk0(ScrClosure *cb, bool has_code, double code,
                            const char *signal_name);
void scr_child_err_thunk0(ScrClosure *cb, ScrStr *msg);
void scr_child_err_thunk_error(ScrClosure *cb, ScrStr *msg);
/* The stream surface: child.stdout/stderr answer +1 handles (NULL when
 * the slot was not piped — Node's null); listeners MOVE in and release
 * at EOF/exit-cleanup (post-'end' registrations release immediately and
 * never fire, the stdin rule). The runtime-provided data adapters cover
 * the zero-param and (chunk: Buffer) shapes; union-param listeners get
 * compiler-emitted adapters (tags are program data). */
ScrChildStream *scr_child_stream_retain(ScrChildStream *s);
void scr_child_stream_release(ScrChildStream *s);
void *scr_child_stream_retain_v(void *p);
void scr_child_stream_release_v(void *p);
ScrChildStream *scr_child_stdout(ScrChild *c); /* +1, or NULL */
ScrChildStream *scr_child_stderr(ScrChild *c); /* +1, or NULL */
void scr_child_stream_on_data(ScrChildStream *s, ScrClosure *cb /*moves*/,
                               ScrChildStreamDataFn fn, bool once);
void scr_child_stream_on_end(ScrChildStream *s, ScrClosure *cb /*moves*/, bool once);
void scr_child_stream_thunk0(ScrClosure *cb, ScrBytes *chunk);
void scr_child_stream_thunk_bytes(ScrClosure *cb, ScrBytes *chunk);
/* The lifecycle members, Node's exact shapes (pinned by the corpus):
 * pid is undefined (has_pid false) exactly on spawn failure; exitCode is
 * null while running / after a signal death, the code after a normal
 * exit, -errno once a spawn failure settled; killed flips on any
 * successful kill() send (signal 0 included); kill answers false after
 * the reap or on spawn failure and throws the Unknown-signal TypeError
 * on bad names (may-throw); unref() drops the child from the loop's
 * keep-alive set (reffed_pending is the loop's liveness half; teardown
 * releases whatever the loop never reaped so the RC audit stays clean). */
bool scr_child_has_pid(ScrChild *c);
double scr_child_pid(ScrChild *c);
bool scr_child_has_exit_code(ScrChild *c);
double scr_child_exit_code(ScrChild *c);
bool scr_child_killed(ScrChild *c);
bool scr_child_kill(ScrChild *c, const ScrStr *signal);
bool scr_child_kill_num(ScrChild *c, double signum);
void scr_child_unref(ScrChild *c);
bool scr_children_reffed_pending(void);
void scr_children_teardown(void);
/* Node's signal-name table (scr_lib.c), shared with child.kill: the
 * resolved signal number, or -1 for names outside the table. */
int scr_signal_from_name(const ScrStr *signal);
/* The reverse walk (spawnSync's result.signal): Node's spelling for the
 * host number, NULL outside the table. Static storage. */
const char *scr_signal_name(int sig);
/* The loop's half: pending() joins the exhaustion test (a live child
 * keeps the process alive, like Node); poll() reaps and fires. wait()
 * takes the loop's quiescent sleep while children are pending — it blocks
 * on the child watch (kqueue on BSD, pidfd epoll on Linux) up to
 * max_wait_ms (the next timer deadline), so a
 * child's NOTE_EXIT wakes the loop immediately; it returns false (and the
 * loop falls back to the ~1ms polling cap) when it can't wake for every
 * pending child: non-kqueue platforms, spawn failures awaiting their
 * first-pass settle, or a child whose exit filter could not be armed. */
bool scr_children_pending(void);
bool scr_children_failed_pending(void);
void scr_children_poll(void);
bool scr_children_wait(double max_wait_ms);

/* ── node:crypto (scr_lib.c) ─────────────────────────────────────────
 * The string-producing slice (Buffers aren't representable): randomUUID
 * (v4, lowercase) and the composed randomBytes(n).toString(enc) — enc is
 * "hex" or "base64" (compiler-fenced). random_string THROWS Node's
 * RangeError on out-of-range sizes; both draw from arc4random_buf. */
ScrStr *scr_crypto_random_uuid(void);
ScrStr *scr_crypto_random_string(double n, ScrStr *enc); /* +1, or throws */
/* The composed createHash(alg).update(data).digest(enc) chain, fused by
 * the compiler (no Hash handle exists). alg is "sha256" | "sha1" and enc
 * "hex" | "base64" — compile-time literals, frontend-fenced (sha1 exists
 * for the RFC 6455 Sec-WebSocket-Accept hash). Strings hash their UTF-8
 * bytes (Node's default input encoding; ScrStr storage IS utf8), the
 * bytes form a Buffer/typed array's raw bytes. Borrowed; +1 string.
 * Never throw. */
ScrStr *scr_crypto_hash_digest_str(ScrStr *alg, ScrStr *data, ScrStr *enc);
ScrStr *scr_crypto_hash_digest_bytes(ScrStr *alg, ScrBytes *data, ScrStr *enc);
/* One-shot raw digest/HMAC by algorithm name ("md5" | "sha1" | "sha256")
 * — the island crypto shim's bridge (scr_island.c host hooks). Digest
 * bytes into out (≥32); returns the digest length, 0 for an unknown
 * algorithm. */
size_t scr_crypto_digest_raw(const char *alg, const unsigned char *data, size_t len,
                             unsigned char out[32]);
size_t scr_crypto_hmac_raw(const char *alg, const unsigned char *key, size_t keylen,
                           const unsigned char *data, size_t len, unsigned char out[32]);
/* The composed `new crypto.X509Certificate(data).fingerprint` read (the
 * handle never materializes): the SHA-1 of the DER, uppercase
 * colon-separated — PEM or raw-DER input; anything else throws Node's
 * ERR_OSSL_PEM_NO_START_LINE Error. Borrowed; +1 (may throw). */
ScrStr *scr_crypto_x509_fingerprint(ScrBytes *data);
ScrStr *scr_crypto_x509_fingerprint_str(ScrStr *pem);
/* The Validity window in Node's ASN1_TIME_print shape ("Jul  1 00:00:00
 * 2026 GMT"); same PEM contract as the fingerprint pair. */
ScrStr *scr_crypto_x509_valid_from(ScrBytes *data);
ScrStr *scr_crypto_x509_valid_from_str(ScrStr *pem);
ScrStr *scr_crypto_x509_valid_to(ScrBytes *data);
ScrStr *scr_crypto_x509_valid_to_str(ScrStr *pem);

/* ── node:path (scr_path.c) ──────────────────────────────────────────
 * BOTH of Node's implementations, ported exactly: the scr_path_* family
 * is posix, the scr_path_win32_* family is Node v24's path.win32 (the
 * compiler binds the bare module by TARGET; the path.posix/path.win32
 * namespaces bind their family anywhere). All arguments are BORROWED;
 * every string result is fresh (+1). Nothing throws. join/resolve take
 * the call's variadic arguments packed into ONE string[] (the compiler
 * builds the array literal); the resolves consult getcwd like Node
 * (failure aborts, like process.cwd), the win32 one after the per-drive
 * "=X:" env vars. basename always receives a suffix — "" (a Node no-op)
 * when the call omitted it. */
ScrStr *scr_path_join(ScrArr *parts);
ScrStr *scr_path_resolve(ScrArr *parts);
ScrStr *scr_path_normalize(ScrStr *path);
ScrStr *scr_path_dirname(ScrStr *path);
ScrStr *scr_path_basename(ScrStr *path, ScrStr *suffix);
ScrStr *scr_path_extname(ScrStr *path);
bool scr_path_is_absolute(ScrStr *path);
ScrStr *scr_path_relative(ScrStr *from, ScrStr *to);
/* posix.toNamespacedPath — the identity (Node: "Non-op on posix
 * systems"). +1 via retain. */
ScrStr *scr_path_to_namespaced_path(ScrStr *path);
/* path.win32.* — Node v24's win32 implementation ported byte-for-byte
 * (backslash output, both slashes on input, UNC/device/drive-letter
 * roots, the reserved device names, the CVE-2024-36139 normalize
 * hardening); join/resolve keep the packed-string[] ABI. On win32
 * TARGETS these back the bare `path` module (Node on Windows IS
 * path.win32); everywhere they are the path.win32 namespace. resolve
 * consults the per-drive "=X:" env vars then the cwd, like Node's.
 * Same borrow/+1 contract as the posix set; nothing throws. */
ScrStr *scr_path_win32_join(ScrArr *parts);
ScrStr *scr_path_win32_resolve(ScrArr *parts);
ScrStr *scr_path_win32_normalize(ScrStr *path);
ScrStr *scr_path_win32_dirname(ScrStr *path);
ScrStr *scr_path_win32_basename(ScrStr *path, ScrStr *suffix);
ScrStr *scr_path_win32_extname(ScrStr *path);
bool scr_path_win32_is_absolute(ScrStr *path);
ScrStr *scr_path_win32_relative(ScrStr *from, ScrStr *to);
ScrStr *scr_path_win32_to_namespaced_path(ScrStr *path);

/* fs.openSync(path, flags) → the raw fd as f64 (Node's string flag
 * grammar; unknown flags throw Node's ERR_INVALID_ARG_VALUE TypeError
 * text, open(2) failures the Node fs error shape), and fs.closeSync(fd)
 * (failure throws the path-less "EBADF: bad file descriptor, close").
 * The pair behind spawn's fd-stdio form. */
double scr_fs_open(ScrStr *path, ScrStr *flags);
ScrFileHandle *scr_file_handle_open(ScrStr *path, ScrStr *flags, double mode);
ScrFileHandle *scr_file_handle_retain(ScrFileHandle *h);
void scr_file_handle_release(ScrFileHandle *h);
void *scr_file_handle_retain_v(void *p);
void scr_file_handle_release_v(void *p);
double scr_file_handle_fd(ScrFileHandle *h);
void scr_file_handle_close(ScrFileHandle *h);
double scr_file_handle_read(ScrFileHandle *h, ScrBytes *buf, double offset,
                            double length, double position, bool length_default);
double scr_file_handle_write_bytes(ScrFileHandle *h, ScrBytes *buf,
                                   double offset, double length,
                                   double position, bool length_default);
double scr_file_handle_write_str(ScrFileHandle *h, ScrStr *data,
                                 double position, ScrStr *encoding);
ScrStr *scr_file_handle_read_file(ScrFileHandle *h);
ScrBytes *scr_file_handle_read_file_bytes(ScrFileHandle *h);
void scr_file_handle_write_file(ScrFileHandle *h, ScrStr *data);
void scr_file_handle_write_file_bytes(ScrFileHandle *h, ScrBytes *data);
ScrStats *scr_file_handle_stat(ScrFileHandle *h);
/* position == -1 reads from and advances the descriptor's current offset;
 * nonnegative positions leave that offset unchanged (pread/ReadFile seam). */
double scr_fs_read_sync(double fd, ScrBytes *buf, double offset, double length,
                        double position);
/* writeSync's classic Buffer window and utf8 string forms. position -1 (or
 * any other non-safe/nonnegative-integer value) writes at and advances the
 * current descriptor offset; safe nonnegative positions leave it unchanged. */
double scr_fs_write_sync(double fd, ScrBytes *buf, double offset, double length,
                         double position);
double scr_fs_write_str_sync(double fd, ScrStr *data, double position,
                             ScrStr *encoding);
void scr_fs_close(double fd);

/* ── WHATWG URL (scr_url.c) ──────────────────────────────────────────
 * An immutable, refcounted URL value, parsed once at construction. The
 * parser covers the WHATWG algorithm's common ground exactly (see
 * scr_url.c's header comment for the covered surface and the documented
 * divergences: no IDNA, no IPv6, opaque paths verbatim).
 *
 * scr_url_new THROWS a catchable TypeError ("Invalid URL") through the
 * exception cell on unparsable input and returns NULL; the getters never
 * throw (borrowed receiver, +1 string). scr_url_to_path / _str_to_path
 * throw Node's fileURLToPath TypeErrors (non-file scheme, encoded '/',
 * non-empty host); scr_url_from_path resolves against the cwd and never
 * throws. Compiler-emitted pending checks follow every throwing call. */
typedef struct ScrUrl ScrUrl;

ScrUrl *scr_url_new(ScrStr *input); /* +1, or throws */
ScrUrl *scr_url_retain(ScrUrl *u);
void scr_url_release(ScrUrl *u);
void *scr_url_retain_v(void *p);
void scr_url_release_v(void *p);
ScrStr *scr_url_protocol(ScrUrl *u); /* +1 "https:" */
ScrStr *scr_url_host(ScrUrl *u);     /* +1 "host[:port]" (defaults stripped) */
ScrStr *scr_url_hostname(ScrUrl *u); /* +1 port-less host ("" when none) */
ScrStr *scr_url_pathname(ScrUrl *u); /* +1 */
ScrStr *scr_url_href(ScrUrl *u);     /* +1; also toString() */
ScrStr *scr_url_to_path(ScrUrl *u);      /* +1, or throws */
ScrStr *scr_url_str_to_path(ScrStr *s);  /* +1, or throws */
ScrUrl *scr_url_from_path(ScrStr *path); /* +1; throws on win32 UNC malformations only */
/* The bridge pair's win32 arms as direct entry points (the public pair
 * selects by TARGET at compile time — Node's isWindows): the host-side
 * differential tests exercise the Windows behavior from any platform,
 * like Node's { windows: true } options on fileURLToPath/pathToFileURL. */
ScrStr *scr_url_to_path_w32(ScrUrl *u);      /* +1, or throws */
ScrUrl *scr_url_from_path_w32(ScrStr *path); /* +1, or throws */

/* ── URLSearchParams (scr_url.c) ─────────────────────────────────────
 * A refcounted, MUTABLE ordered list of decoded (name, value) pairs —
 * the WHATWG application/x-www-form-urlencoded surface. Standalone
 * (scr_sp_new/parse/copy/from_pairs) or the LIVE view of a URL's query
 * (scr_url_search_params — cached on the URL so every read answers the
 * same identity, and every list mutation re-serializes into the URL's
 * query: href reflects immediately; an emptied list drops the '?').
 * Parsing/serialization match Node byte-for-byte: '+' is space, %XX
 * decodes (malformed escapes verbatim, decoded bytes UTF-8-scrubbed to
 * U+FFFD), serialization keeps [A-Za-z0-9*\-._], space → '+', uppercase
 * %XX otherwise. sort() is stable, by UTF-16 code units. Only
 * scr_sp_from_pairs throws (ERR_INVALID_TUPLE on a non-[name, value]
 * row); everything else never does. */
typedef struct ScrSearchParams ScrSearchParams;

ScrSearchParams *scr_sp_new(void);              /* +1 empty list */
ScrSearchParams *scr_sp_parse(ScrStr *init);    /* +1; strips ONE leading '?' */
ScrSearchParams *scr_sp_copy(ScrSearchParams *src); /* +1 snapshot */
ScrSearchParams *scr_sp_from_pairs(ScrArr *pairs);  /* +1, or throws (string[][] rows) */
/* The record-literal init desugar: append (name, value), answer sp +1. */
ScrSearchParams *scr_sp_with(ScrSearchParams *sp, ScrStr *name, ScrStr *value);
ScrSearchParams *scr_sp_retain(ScrSearchParams *sp);
void scr_sp_release(ScrSearchParams *sp);
void *scr_sp_retain_v(void *p);
void scr_sp_release_v(void *p);
ScrSearchParams *scr_url_search_params(ScrUrl *u); /* +1 live cached view */
ScrStr *scr_url_search(ScrUrl *u);                 /* +1 "?..." or "" */
void scr_sp_append(ScrSearchParams *sp, ScrStr *name, ScrStr *value);
void scr_sp_set(ScrSearchParams *sp, ScrStr *name, ScrStr *value);
void scr_sp_delete(ScrSearchParams *sp, ScrStr *name);
void scr_sp_delete_value(ScrSearchParams *sp, ScrStr *name, ScrStr *value);
ScrStr *scr_sp_get(ScrSearchParams *sp, ScrStr *name);     /* +1 first value, or NULL */
ScrArr *scr_sp_get_all(ScrSearchParams *sp, ScrStr *name); /* +1 string[] */
bool scr_sp_has(ScrSearchParams *sp, ScrStr *name);
bool scr_sp_has_value(ScrSearchParams *sp, ScrStr *name, ScrStr *value);
void scr_sp_sort(ScrSearchParams *sp);
double scr_sp_size(ScrSearchParams *sp);
ScrStr *scr_sp_to_string(ScrSearchParams *sp); /* +1 urlencoded serialization */
/* Index-walk iteration (the compiler's for-of/forEach desugar re-reads
 * scr_sp_size each pass — live, like the spec's index-based iterator). */
ScrStr *scr_sp_key_at(ScrSearchParams *sp, double i); /* +1; "" out of range */
ScrStr *scr_sp_val_at(ScrSearchParams *sp, double i); /* +1; "" out of range */

/* ── ES Symbol values (scr_symbol.c — linked only when the IR uses the
 * symbol surface) ─────────────────────────────────────────────────────
 * A symbol is a runtime-unique IDENTITY: the pointer IS the identity
 * (`===` is a pointer compare; every scr_sym_new allocation is a distinct
 * symbol even for equal descriptions — JS exactly). Heap, refcounted,
 * IMMUTABLE; holds at most two strings (description + registry key), so
 * never part of a cycle, no trace. Symbol.for's global registry interns
 * per KEY (byte equality) and is spec-permanent — entries are never
 * evicted; an atexit cleanup (registered at first use, so LIFO runs it
 * BEFORE scr_init's RC audit) releases the chain so audited string counts
 * stay exact. None of these throw. */
typedef struct ScrSym ScrSym;

ScrSym *scr_sym_new(ScrStr *desc); /* borrows desc (NULL = no description); +1 fresh identity */
ScrSym *scr_sym_for(ScrStr *key);  /* borrows key; +1 on the interned per-key symbol */
ScrSym *scr_sym_retain(ScrSym *s);
void scr_sym_release(ScrSym *s);
void *scr_sym_retain_v(void *p);
void scr_sym_release_v(void *p);
ScrStr *scr_sym_desc(ScrSym *s);      /* +1 description, or NULL when absent */
ScrStr *scr_sym_key_for(ScrSym *s);   /* +1 registry key, or NULL (not registered) */
ScrStr *scr_sym_to_string(ScrSym *s); /* +1 "Symbol(desc)" ("Symbol()" when absent) */

/* ── node:os (scr_lib.c) ─────────────────────────────────────────────
 * os.platform() lowers to scr_process_platform. homedir is $HOME else
 * getpwuid(3) (failure aborts); tmpdir is Node's $TMPDIR/$TMP/$TEMP
 * cascade else /tmp, one trailing slash trimmed. Both +1 fresh. */
ScrStr *scr_os_homedir(void);
ScrStr *scr_os_tmpdir(void);
ScrStr *scr_os_release(void); /* uname(2) release — +1 fresh */
ScrStr *scr_os_type(void);    /* uname(2) sysname — +1 fresh */
double scr_os_totalmem(void); /* total physical memory, bytes */
/* os.userInfo()'s field trio (pw_name / pw_shell / pw_dir — the passwd
 * home, not the $HOME cascade). +1 fresh; abort on lookup failure. */
ScrStr *scr_os_user_name(void);
ScrStr *scr_os_user_shell(void);
ScrStr *scr_os_user_homedir(void);

/* fs.readdirSync(path, { withFileTypes: true }): one readdir pass
 * snapshotting name + entry kind (scr_lib.c) — the emitter walks it to
 * assemble the typed Dirent record rows inline. Entry kinds use libuv's
 * UV_DIRENT encoding (1 file, 2 dir, 3 link, 4 fifo, 5 socket, 6 char,
 * 7 block, 0 unknown); a DT_UNKNOWN d_type falls back to lstat(2) —
 * Node's own getDirents rule. OS order, no "."/"..". scr_fs_scandir
 * throws Node's scandir errno error and answers NULL then; the name
 * accessor returns +1. */
typedef struct ScrScandir ScrScandir;
ScrScandir *scr_fs_scandir(ScrStr *path); /* or throws (NULL) */
size_t scr_fs_scandir_count(const ScrScandir *s);
ScrStr *scr_fs_scandir_name(const ScrScandir *s, size_t i); /* +1 */
double scr_fs_scandir_type(const ScrScandir *s, size_t i);
void scr_fs_scandir_free(ScrScandir *s);

/* os.networkInterfaces(): a getifaddrs(3) snapshot (scr_lib.c) the emitter
 * walks to build the typed Dict<NetworkInterfaceInfo[]> record inline. Row
 * selection and fields follow libuv/Node (IFF_UP && IFF_RUNNING,
 * AF_INET/AF_INET6; internal = IFF_LOOPBACK; MAC from the link-level
 * sibling entry, zeros when absent; cidr = address/<netmask prefix>, NULL
 * for a split netmask — Node's null). String accessors return +1; a
 * getifaddrs failure yields an empty snapshot. */
typedef struct ScrIfaddrs ScrIfaddrs;
ScrIfaddrs *scr_os_ifaddrs(void);
size_t scr_os_ifaddrs_count(const ScrIfaddrs *s);
ScrStr *scr_os_ifaddrs_name(const ScrIfaddrs *s, size_t i);
ScrStr *scr_os_ifaddrs_address(const ScrIfaddrs *s, size_t i);
ScrStr *scr_os_ifaddrs_netmask(const ScrIfaddrs *s, size_t i);
ScrStr *scr_os_ifaddrs_family(const ScrIfaddrs *s, size_t i); /* "IPv4"/"IPv6" */
ScrStr *scr_os_ifaddrs_mac(const ScrIfaddrs *s, size_t i);
bool scr_os_ifaddrs_internal(const ScrIfaddrs *s, size_t i);
bool scr_os_ifaddrs_ipv6(const ScrIfaddrs *s, size_t i);
ScrStr *scr_os_ifaddrs_cidr(const ScrIfaddrs *s, size_t i); /* +1 or NULL */
double scr_os_ifaddrs_scopeid(const ScrIfaddrs *s, size_t i);
void scr_os_ifaddrs_free(ScrIfaddrs *s);

/* ── JSON + dynamic values (scr_json.c) ─────────────────────────────
 * A dyn value — the compiled form of `unknown` — is a refcounted JSON dyn
 * tree: the result of JSON.parse, inert until a CHECKED CAST validates it
 * against a static type. The compiler emits the validation walkers
 * (sc_dc_* builders / sc_dm_* match predicates) and the type-directed
 * stringify serializers (sc_jw_*) per program; this runtime slice provides
 * the checked-dynamic tree itself, the RFC 8259 parser, the shared failure path
 * (scr_dyn_check_fail), and the output buffer the serializers append to.
 *
 * Ownership: the checked-dynamic tree owns its children (strings, items, entry keys+values);
 * releasing the root releases the tree recursively. scr_json_parse borrows
 * the text and returns +1 — or THROWS a catchable string shaped like Node's
 * V8 messages ("Unexpected end of JSON input"; approximate fidelity, see
 * SEMANTICS.md) and returns NULL. scr_dyn_obj_get returns a BORROWED
 * member (the compiler's builders retain what they extract themselves).
 */

typedef enum {
  SCR_DYN_NULL,
  SCR_DYN_BOOL,
  SCR_DYN_NUM,
  SCR_DYN_STR,
  SCR_DYN_ARR,
  SCR_DYN_OBJ,
  /* The undefined VALUE. Never produced by the parser (JSON text has no
   * undefined) — it enters the checked-dynamic tree through index-signature overflow reads
   * (a missing key), optional-chain unit paths on dyn results, and the
   * compiler's static→dyn converters (an undefined-armed union's unit
   * arm). One immortal instance (scr_dyn_undefined); JSON serialization
   * drops object members holding it and prints null for array slots,
   * exactly Node. dynCheck matches it against exactly the undefined arm. */
  SCR_DYN_UNDEF,
  /* A Uint8Array/Buffer VALUE. Never produced by the parser — it enters
   * the checked-dynamic tree through the compiler's static→dyn converters (a bytes<u8>
   * value flowing into an `unknown` slot: stdin chunks passed to
   * unknown-typed helpers). Owns a ScrBytes payload (a COPY of the static
   * source — the boundary's aliasing stance). typeof answers "object"
   * (kind tests all miss), String() joins the elements ("1,2,3" —
   * Uint8Array.prototype.toString), JSON serializes the index-keyed
   * object form ({"0":1}), and dynCheck extracts a fresh copy against a
   * Uint8Array target. */
  SCR_DYN_BYTES,
  /* A FUNCTION value. Never produced by the parser — it enters the checked-dynamic tree
   * through the compiler's static→dyn converters (a typed closure flowing
   * into an `unknown` slot: `mustCall(fn)`-style untyped JS helpers). Owns
   * a ScrClosure plus a compiler-emitted CALL THUNK that validates dyn
   * arguments into the closure's declared parameter types (per-arg
   * dynCheck — JS arity semantics: extra args ignored, missing args are
   * the undefined dyn value) and converts the result back to a dyn value.
   * `sig` is the compiler's interned signature key: dynCheck against an
   * IDENTICAL function type unwraps the closure directly; any other
   * (adaptable) function target wraps the box in a per-target adapter
   * closure. typeof answers "function", truthiness is true, String()
   * renders the native-code form (source text is gone — SEMANTICS.md),
   * JSON serialization treats it like undefined (dropped from objects,
   * null in arrays), and util.inspect prints [Function: name]. */
  SCR_DYN_FUNC,
  /* A NATIVE HANDLE value (httpReq/httpRes/netSocket crossing the checked-
   * dynamic boundary — `server.on('request', mustCall((req, res) => ...))`
   * makes the listener dyn, so the event tuple must box). Never produced
   * by the parser — it enters the checked-dynamic tree through the compiler's static→dyn
   * converters and the per-target function adapters. Boxes by REFERENCE
   * (a retained pointer + a handle-type tag): handles are stateful I/O
   * objects, so identity is the HANDLE, not the box — strict equality
   * compares (tag, pointer), and dynCheck against the same handle type
   * unwraps the pointer (+1) instead of copying. Member CALLS and the
   * property reads/writes with static equivalents dispatch through a
   * per-tag ops table (scr_dyn_handle_install — scr_http.c/scr_net.c
   * register at main(), the vtable-stamp story) onto the SAME entry
   * points the static lowerings use; unknown members meet the loud
   * "not supported yet" ladder, never a silent wrong answer. typeof
   * answers "object", truthiness is true, String() renders
   * "[object Object]" (Object.prototype.toString — Node's answer for
   * these classes), JSON serialization and util.inspect fence loudly. */
  SCR_DYN_HANDLE,
  /* A PROMISE value. Never produced by the parser — it enters the checked-dynamic tree
   * through the compiler's static→dyn converters (a promise flowing into
   * an `any`/`unknown` slot: the traced-function boundary of
   * dc.tracingChannel.tracePromise, a dyn-boxed async closure's return).
   * Boxes by REFERENCE (a retained ScrPromise + the boundary contract
   * that a dyn-crossing promise settles with a dyn payload: promise<dyn>
   * boxes its ScrPromise directly, other inner types box an ADAPTER
   * promise whose emitted settle callback converts the payload — see
   * scr_dyn_new_promise_adapting). Identity is the PROMISE, not the box
   * (strict equality compares the pointers; Promise.resolve identity
   * survives one crossing, a re-boxed typed promise mints a fresh
   * adapter — SEMANTICS.md). typeof answers "object", truthiness is
   * true, String() renders "[object Promise]" (Object.prototype.toString
   * — promises have no own toString), JSON serialization writes {} (no
   * own enumerable properties, exactly Node), and util.inspect fences
   * loudly. The dyn→promise edge is NOT visible to the cycle collector
   * (the dyn→closure stance): a cycle THROUGH a dyn-boxed promise is
   * merely never collected. */
  SCR_DYN_PROMISE,
  /* An ISLAND (engine-held) value — the jsval→dyn crossing. Never
   * produced by the parser — it enters the checked-dynamic tree through the gated
   * constructor scr_dyn_from_jsval (scr_island.c): an 'any'-typed value
   * flowing into an 'unknown'/'object'/JS-residue slot. Boxes by
   * REFERENCE (a retained ScrJsval cell). The constructor SCALAR-
   * NORMALIZES: engine numbers/strings/booleans/null/undefined convert
   * to the native dyn kinds at wrap time, so JSVAL nodes only ever hold
   * engine objects, arrays, and functions (plus the symbol/bigint edge —
   * kinds the checked-dynamic tree cannot represent at all). Identity is the CELL's
   * engine value: strict equality routes to the engine's === (two wraps
   * of one engine value compare equal), and scr_jsval_from_dyn unwraps
   * the SAME cell back (+1) — the boundary is identity-preserving for
   * engine-born values. typeof/truthiness/String() route to the engine
   * per use (scr_dyn_jsval_ops); every dyn walk without an armed route
   * (JSON, structuredClone, deepStrictEqual, inspect, keyed access,
   * calls, iteration) throws the LOUD "not supported yet" ladder — never
   * a silent wrong answer. The dyn→cell edge is NOT visible to the cycle
   * collector (the dyn→closure stance): a cycle dyn → cell → engine
   * object → host closure → dyn is merely never collected (the
   * documented cross-boundary-cycle divergence). */
  SCR_DYN_JSVAL,
  /* A compiler-owned typed reference in transit through a native Web
   * stream. Unlike an ordinary typed→unknown conversion, this capsule
   * retains the original value so a statically typed reader can recover
   * its identity. `materialize` supplies the ordinary deep-copy view for
   * consumers such as fetch request bodies that need a dyn chunk. Enum
   * position: LAST — LLVM hardcodes every preceding kind number. */
  SCR_DYN_TYPED_REF,
} ScrDynKind;

/* The handle-type tags the checked-dynamic tree can carry. The set is deliberately the
 * HANDLE kinds whose member surfaces already have complete static
 * lowerings (the http/net receiver surface); new kinds join by adding a
 * tag + an ops registration in their owning unit. */
typedef enum {
  SCR_DYNH_HTTP_REQ,   /* ScrHttpReq — IncomingMessage (server req & client res) */
  SCR_DYNH_HTTP_RES,   /* ScrHttpRes — ServerResponse */
  SCR_DYNH_NET_SOCKET, /* ScrNetSocket — net.Socket */
  SCR_DYNH_NET_SERVER, /* ScrNetServer — net.Server (http.Server rides the same handle) */
  SCR_DYNH_H2_SESSION, /* ScrH2Session — Http2Session (client & server) */
  SCR_DYNH_H2_STREAM,  /* ScrH2Stream — Http2Stream (client & server) */
  SCR_DYNH_HTTP_CLIENT, /* ScrHttpClientReq — http.ClientRequest */
  SCR_DYNH_HTTP_AGENT,  /* ScrHttpAgent — http.Agent / https.Agent */
  SCR_DYNH_ABORT_SIGNAL, /* native static-fetch AbortSignal */
  SCR_DYNH_WEB_STREAM,   /* native WHATWG ReadableStream */
  SCR_DYNH_WEB_READER,   /* native ReadableStreamDefaultReader */
  SCR_DYNH_WEB_CONTROLLER, /* native ReadableStreamDefaultController */
  SCR_DYNH_FETCH_RESPONSE, /* native static-fetch Response */
  SCR_DYNH_FETCH_HEADERS, /* native static-fetch response Headers */
  SCR_DYNH_EVENT,          /* native static-fetch abort Event */
  SCR_DYNH_ABORT_CONTROLLER, /* native static-fetch AbortController */
  SCR_DYNH_COUNT,
} ScrDynHandleTag;

typedef struct ScrDyn ScrDyn;
typedef struct ScrBytes ScrBytes; /* full definition below (C11 repeat) */
typedef struct ScrClosure ScrClosure; /* full definition below (C11 repeat) */
typedef struct ScrDynTypedCast {
  const char *type_key;
  size_t type_key_len;
  void *ptr;
  void *(*retain)(void *);
  void (*release)(void *);
  struct ScrDynTypedCast *next;
} ScrDynTypedCast;
typedef struct ScrJsval ScrJsval; /* opaque island cell (C11 repeat; the
                                   * always-linked dyn core never touches
                                   * its engine value — only the gated ops
                                   * installed by scr_dyn_from_jsval do) */

/* The compiler-emitted call glue carried by a SCR_DYN_FUNC box: checks the
 * dyn arguments against the boxed closure's declared parameter types (a
 * mismatch throws the catchable path-annotated TypeError and returns NULL
 * with the exception pending), calls through the closure, and returns the
 * result as an owned (+1) dyn value. `args` entries are BORROWED. */
typedef ScrDyn *(*ScrDynThunk)(ScrClosure *clo, ScrDyn *const *args, size_t argc);

/* Object member. Keys are malloc'd UTF-8 bytes (NUL-terminated for
 * convenience; key_len excludes the NUL) — duplicate keys were already
 * collapsed at parse time (later wins, like JS JSON.parse). */
typedef struct {
  char *key;
  size_t key_len;
  ScrDyn *value; /* owned */
} ScrDynEntry;

struct ScrDyn {
  size_t rc; /* SIZE_MAX = immortal (unused for dyn; kept per convention) */
  ScrDynKind kind;
  /* SCR_DYN_BYTES flavor: true when the value REPRESENTS a Node Buffer
   * (stream chunks, buffer-typed boundary crossings) — Buffer's string
   * coercion and toString() decode utf8, where a plain Uint8Array joins
   * its elements ("1,2,3"). Everything else ignores it. */
  bool buffer;
  /* SCR_DYN_OBJ flavor: true for Object.create(null)'s dictionary — an
   * object with NO prototype. Method dispatch needs nothing (the checked-dynamic tree's
   * OBJ dispatch is already own-member-only, which IS Node's null-proto
   * answer); util.inspect prefixes "[Object: null prototype]", and
   * deepStrictEqual separates it from plain objects (Node compares
   * prototypes — the bytes `buffer` gate's stance). Keyed reads/writes,
   * Object.keys/entries/assign, JSON, and typeof are flag-blind, and
   * fresh copies (structuredClone) DROP the flag — Node's serialization
   * answers a plain object too. */
  bool null_proto;
  union {
    bool b;
    double num;
    ScrStr *str; /* owned */
    ScrBytes *bytes; /* owned (SCR_DYN_BYTES) */
    struct { size_t len; size_t cap; ScrDyn **items; } arr;      /* owned */
    struct {
      size_t len;
      size_t cap;
      ScrDynEntry *entries;
      /* Optional identity of the typed record that produced this ordinary
       * deep-copy snapshot. EventTarget uses it to recognize the same
       * EventListenerObject across repeated static→dyn crossings without
       * changing generic dyn-object `===` semantics. */
      /* Owned through source_access(source_identity, false). Callback
       * interfaces may request a fresh snapshot with the true arm. */
      void *source_identity;
      ScrDyn *(*source_access)(void *, bool materialize);
    } obj; /* owned */
    /* SCR_DYN_FUNC: the boxed closure (owned) + its call descriptor. `sig`
     * and `name` are static compiler-emitted literals (never freed); name
     * may be NULL (anonymous — inspect prints [Function (anonymous)]).
     * The dyn→closure edge is NOT visible to the cycle collector (ScrDyn
     * has no trace header): trial deletion treats it as an external root,
     * so nothing dangles — a cycle THROUGH a dyn-boxed function is merely
     * never collected (documented divergence). */
    struct { ScrClosure *clo; ScrDynThunk thunk; const char *sig; const char *name; uint32_t arity; } fn;
    /* SCR_DYN_HANDLE: the retained native handle + its type tag. The
     * dyn→handle edge is NOT visible to the cycle collector (the dyn→
     * closure stance): handles drop their listener lists at settlement,
     * so a listener capturing its own boxed handle never cycles past the
     * settle — the settle-releases-listeners story. */
    struct { void *ptr; ScrDynHandleTag tag; } handle;
    /* SCR_DYN_TYPED_REF: original static value + its compiler-emitted
     * identity tag, RC adapters, and ordinary dyn snapshot adapter. */
    struct {
      void *ptr;
      void *(*retain)(void *);
      void (*release)(void *);
      const char *type_key;
      size_t type_key_len;
      ScrDyn *(*materialize)(void *);
      void (*commit)(void *, const ScrDyn *);
      /* Both caches belong to this capsule. ReadableStream canonicalizes
       * capsules for repeated source references, so the refreshed dyn view
       * and every structurally converted static view keep JS reference
       * identity while the source reference remains observable. */
      ScrDyn *materialized;
      ScrDynTypedCast *casts;
    } typed_ref;
    /* SCR_DYN_PROMISE: the retained promise. The boundary contract: it
     * settles with a dyn payload (SCR_EXC_REF ScrDyn fulfillment or a
     * void fulfillment awaiters read as the undefined value) — the
     * emitted converters guarantee it (direct box for promise<dyn>,
     * adapter promise otherwise). */
    ScrPromise *promise;
    /* SCR_DYN_JSVAL: the retained island cell (engine objects/arrays/
     * functions only — the constructor scalar-normalizes; see the kind's
     * comment). Released through the installed ops so this always-linked
     * core never references the gated island unit. */
    struct { ScrJsval *cell; } jsval;
  } v;
};

static inline ScrDyn *scr_dyn_retain(ScrDyn *d) {
  if (d->rc != SIZE_MAX) d->rc++;
  return d;
}

void scr_dyn_release(ScrDyn *d); /* releases the tree recursively; NULL-tolerant */

/* RFC 8259 parse of a UTF-8 string. Borrows text; returns +1, or throws a
 * catchable Node-flavored SyntaxError string and returns NULL (callers are
 * compiler-emitted pending checks — json.parse is in the may-throw seed). */
ScrDyn *scr_json_parse(ScrStr *text);

/* BORROWED member lookup on a SCR_DYN_OBJ; NULL when the key is absent. */
ScrDyn *scr_dyn_obj_get(const ScrDyn *d, const char *key, size_t key_len);

/* Object.keys/values/entries over the checked-dynamic tree: JS own-key order (array-index
 * keys ascending first), dyn-array results (+1); values/entries RETAIN
 * member nodes. null/undefined receivers throw Node's catchable
 * TypeError. */
ScrDyn *scr_dyn_obj_keys(const ScrDyn *v);
/* Object.hasOwn over a dyn receiver: OBJ member presence, ARR index
 * bounds ("length" included); nullish receivers throw Node's ToObject
 * TypeError; every other kind answers false. */
bool scr_dyn_has_own(const ScrDyn *v, const ScrStr *key);
/* Object.assign over dyn values (+1 target back; ToObject TypeError on a
 * nullish target). Sources copy their own enumerable keys exactly as
 * Object.keys lists them: OBJ members, ARR/STR/BYTES index keys; nullish
 * and scalar/function/handle sources copy nothing. */
ScrDyn *scr_dyn_assign(ScrDyn *target, const ScrDyn *src);
/* Variadic Object.assign (the spread-source form): the compiler packs
 * every source into one fresh dyn array — pack_push retains a plain
 * source in (BORROWED), pack_push_spread flattens a spread source through
 * the spread-call walk (V8's exact TypeError texts, `what` spelling the
 * spread expression; MAY THROW pending) — then assign_all copies each
 * pack element's own members onto the target left to right and answers
 * the target retained (+1; ToObject TypeError on a nullish target). */
void scr_dyn_pack_push(ScrDyn *pack, ScrDyn *v);
void scr_dyn_pack_push_spread(ScrDyn *pack, const ScrDyn *src, const ScrStr *what);
/* The iterated-path twin — a spread that is NOT the single last argument
 * takes V8's iterator-protocol failure texts, which describe the VALUE
 * ("object null", "number 5", ...) instead of spelling the expression. */
void scr_dyn_pack_push_spread_iter(ScrDyn *pack, const ScrDyn *src);
ScrDyn *scr_dyn_assign_all(ScrDyn *target, const ScrDyn *sources);
ScrDyn *scr_dyn_obj_values(const ScrDyn *v);
ScrDyn *scr_dyn_obj_entries(const ScrDyn *v);

/* dyn construction — the compiler-emitted static→dyn converters (sc_td_*)
 * and index-signature overflow machinery build dyn values directly.
 * Constructors return +1; _new_str RETAINS the string into the node.
 * arr_push and obj_set take OWNERSHIP of the value (+1 moves in); obj_set
 * COPIES the key bytes and replaces a duplicate key's value (later wins,
 * like JS). scr_dyn_undefined returns THE immortal undefined value
 * (rc == SIZE_MAX — retains/releases are no-ops). */
ScrDyn *scr_dyn_undefined(void);
ScrDyn *scr_dyn_new_null(void);
ScrDyn *scr_dyn_new_bool(bool b);
ScrDyn *scr_dyn_new_num(double n);
ScrDyn *scr_dyn_new_str(ScrStr *s);
ScrDyn *scr_dyn_new_arr(void);
ScrDyn *scr_dyn_new_obj(void);
/* The ordinary deep-copy object plus a retained typed source. source_access
 * releases that source when materialize=false and returns a fresh dyn snapshot
 * when true. Generic dyn member reads and strict equality remain snapshot/node
 * based; callback-interface consumers opt into the live arm explicitly. */
ScrDyn *scr_dyn_new_obj_with_identity(
    void *source, void *(*source_retain)(void *),
    ScrDyn *(*source_access)(void *, bool materialize));
bool scr_dyn_obj_same_source(const ScrDyn *a, const ScrDyn *b);
/* Object.create(null): the fresh null-prototype dictionary (see the
 * null_proto flavor flag above). */
ScrDyn *scr_dyn_new_obj_null_proto(void);
/* Wraps a fresh COPY of the u8 payload (the static→dyn boundary copies —
 * DataView-backed sources copy their aliased window). Borrows b. */
ScrDyn *scr_dyn_new_bytes_copy(const ScrBytes *b);
/* The Buffer-flavored twin (stream chunks): string coercion/toString
 * decode utf8 instead of joining elements. */
ScrDyn *scr_dyn_new_buffer_copy(const ScrBytes *b);
/* Identity-preserving transit capsule used by ReadableStream.from over
 * typed arrays. The constructor retains `ptr`; matching unbox returns +1.
 * materialize lazily creates and then retains one detached dyn snapshot.
 * The cast cache lets a non-exact dynCheck reuse one safe, compiler-built
 * target view instead of raw-casting structurally different layouts. */
ScrDyn *scr_dyn_new_typed_ref(
    void *ptr, void *(*retain)(void *), void (*release)(void *),
    const char *type_key, size_t type_key_len,
    ScrDyn *(*materialize)(void *),
    void (*commit)(void *, const ScrDyn *));
bool scr_dyn_typed_ref_is(
    const ScrDyn *d, const char *type_key, size_t type_key_len);
void *scr_dyn_typed_ref_unbox(const ScrDyn *d); /* +1 */
ScrDyn *scr_dyn_typed_ref_materialize(const ScrDyn *d); /* +1 */
void scr_dyn_typed_ref_commit(ScrDyn *d);
void *scr_dyn_typed_ref_cached_cast(
    const ScrDyn *d, const char *type_key, size_t type_key_len); /* +1/NULL */
void scr_dyn_typed_ref_cache_cast(
    ScrDyn *d, const char *type_key, size_t type_key_len, void *ptr,
    void *(*retain)(void *), void (*release)(void *));
/* A fresh u8 COPY of a SCR_DYN_BYTES payload (+1) — the dynCheck
 * extraction (`u as Uint8Array`). */
ScrBytes *scr_dyn_bytes_copy_out(const ScrDyn *d);
void scr_dyn_arr_push(ScrDyn *arr, ScrDyn *item);
/* Spread completion for a runtime-arity argument list (`f(...xs)` in the
 * checked-dynamic tier): flattens `src` into `arr` per JS's spread over the
 * dyn's iterable kinds — arrays element-by-element (retained), strings by
 * code POINT (the string iterator), bytes by byte — and throws V8's exact
 * SPREAD-CALL TypeError for every other kind (pending; callers check):
 * nullish sources spell the spread expression (`what`), everything else is
 * the generic "Spread syntax requires ..." text. Borrows src. */
void scr_dyn_arr_push_spread(ScrDyn *arr, const ScrDyn *src, const char *what);
/* Destructuring pack over a dyn source: iterable kinds (arrays, strings by
 * code point, bytes) collect into a fresh array (+1); every other kind
 * throws V8's destructuring TypeError — `msg` verbatim when non-empty (the
 * compile-time source spelling), else the runtime kind wording. Borrows
 * both; NULL with the exception pending on the throw. */
ScrDyn *scr_dyn_iter_pack(const ScrDyn *src, const ScrStr *msg);
/* The for-of-over-dyn pack accessors (the emitted index loop drives them
 * over a scr_dyn_iter_pack result, which is ARR by construction).
 * scr_dyn_arr_len answers 0 for non-ARR kinds; scr_dyn_arr_at answers the
 * undefined singleton past the end (both never throw). scr_dyn_arr_at is
 * +1. */
double scr_dyn_arr_len(const ScrDyn *d);
ScrDyn *scr_dyn_arr_at(const ScrDyn *d, double i);
void scr_dyn_obj_set(ScrDyn *obj, const char *key, size_t key_len, ScrDyn *value);
/* The checked-dynamic keyed WRITE (`h.k = v` on a dyn receiver): OBJ sets
 * the member (JS: later writes win, insertion order); undefined/null and
 * non-object kinds throw Node's catchable TypeErrors (strict-mode
 * wording). All three operands BORROWED (the value is retained in). */
void scr_dyn_key_set(ScrDyn *recv, ScrStr *key, ScrDyn *value);
/* `key in v` with a runtime key — the dynHasKey fold per value (OBJ own
 * members, ARR length/valid indices, false elsewhere). Never throws. */
bool scr_dyn_has_key(const ScrDyn *v, const ScrStr *key);
/* Bare `typeof v` on a dyn value: the dyn kind's JS answer (+1 string;
 * null answers "object"). Never throws. */
ScrStr *scr_dyn_typeof(const ScrDyn *d);
/* Receiver-kind-dispatched toString() (Buffer-flavored bytes decode per
 * enc — utf8 default; strings/numbers/booleans/arrays/objects answer
 * JS-exactly; undefined/null throw the catchable TypeError). Borrows; +1. */
ScrStr *scr_dyn_to_string(const ScrDyn *d, const ScrStr *enc);
/* The method-call spelling `d.toString(enc?)`: identical, except a
 * null-prototype dictionary throws "<what> is not a function" — its
 * prototype chain has no toString (Node's answer). */
ScrStr *scr_dyn_to_string_method(const ScrDyn *d, const ScrStr *enc, const ScrStr *what);
/* JS String() over the dyn kind (units render "null"/"undefined" where
 * scr_dyn_to_string throws) — the web globals' WebIDL ToString. +1. */
ScrStr *scr_dyn_string_coerce(const ScrDyn *d);
/* JS ToString WITH the object protocol (user toString/valueOf members
 * called, their throws propagating) — the WHATWG USVString conversions.
 * Borrows; +1 or NULL with the exception pending. */
ScrStr *scr_dyn_string_coerce_js(const ScrDyn *d);
bool scr_dyn_number_coerce_js(const ScrDyn *d, double *out);

/* `d instanceof TypeError` (and the other builtin error classes) on a
 * checked-dynamic value: the from_error cache resolves the dyn encoding
 * back to its runtime error and the class's stamped preorder interval
 * answers. A dyn value that never came from an error answers false. */
bool scr_dyn_err_instanceof(const ScrDyn *d, double kind);

/* structuredClone over the checked-dynamic tree: JSON-safe data + bytes deep-copy;
 * functions/handles throw the spec's catchable DataCloneError; cycles
 * throw the scriptc fence (the checked-dynamic tree cannot represent them). Option
 * validation (shared with scr_domex_clone) throws Node's exact
 * TypeErrors; any non-empty transfer list throws DataCloneError. The
 * _missing form is the zero-argument call: always throws Node's
 * ERR_MISSING_ARGS. Args borrowed (options NULL-tolerant); results +1. */
ScrDyn *scr_structured_clone(const ScrDyn *value, const ScrDyn *options);
ScrDyn *scr_structured_clone_missing(void);
ScrDyn *scr_structured_clone_transfer_fail(void); /* always throws DataCloneError */
/* Validates a structuredClone options dyn value (throws on failure —
 * callers must check scr_exc_pending). Borrowed, NULL-tolerant. */
void scr_sc_validate_options(const ScrDyn *options);
/* An %Error as the boundary's dyn shape ({name, message[, code]}).
 * Borrows; +1. */
ScrDyn *scr_dyn_from_error(const ScrError *e);
/* The reverse extraction, riding the same identity cache: a dyn error
 * that came from a runtime ScrError answers THAT instance (+1;
 * out-and-back crossings compare reference-equal); alien %error objects
 * rebuild once and enter the cache. Borrows d. */
ScrError *scr_error_from_dyn(const ScrDyn *d); /* scr_async_dyn.c (gated) */
/* The cache's runtime-internal access pair (scr_json.c owns the storage;
 * the gated extraction reads/writes through these). */
ScrError *scr_errdyn_err_of(const ScrDyn *d); /* +1 or NULL */
void scr_errdyn_put(ScrError *e, ScrDyn *d);  /* retains both sides */
/* ToBoolean over the dyn kind (JS-exact); borrowed, never throws. */
bool scr_dyn_truthy(const ScrDyn *d);
/* JS String() over a dyn value (arrays join, [object Object], the error
 * encoding renders "name: message"); borrowed, result +1, never throws. */
ScrStr *scr_dyn_display(const ScrDyn *d);
/* JS === over two dyn values: scalars by value, units by kind, everything
 * reference-shaped by node identity. Borrowed; never throws. */
bool scr_dyn_strict_eq(const ScrDyn *a, const ScrDyn *b);
/* Prototype-method dispatch on a dyn receiver (`recv.m(...)` where `m` is
 * a name a dyn-representable prototype declares — push/slice/forEach/
 * apply/...): implemented (kind, name) pairs run JS-exact semantics; a
 * real-but-unimplemented method throws a LOUD "not supported yet" Error;
 * a name the kind's prototype lacks throws Node's "<what> is not a
 * function"; OBJ receivers call the own member. recv/args borrowed,
 * result owned (+1). MAY THROW (NULL with the exception pending). */
ScrDyn *scr_dyn_invoke(ScrDyn *recv, const char *method, ScrDyn *const *args, size_t argc, const char *what);
/* Keyed read on a FUNC node: the own-property table first (defineProperties
 * writes land there), then "name" (the box's best-effort static name; ""
 * for anonymous) and "length" (the boxed arity). Returns +1, or NULL when
 * the key answers nothing (the caller's undefined). Never throws. */
ScrDyn *scr_dyn_fn_get(const ScrDyn *d, const char *key, size_t key_len);
/* Object.defineProperties over dyn values (targets: OBJ and FUNC): each
 * descriptor's `value` becomes a plain own property — writable/enumerable/
 * configurable are accepted and IGNORED (dyn properties are plain data
 * properties; SEMANTICS.md), get/set throw the loud unsupported Error.
 * Returns the target (+1, JS's return), or NULL with a pending catchable
 * TypeError (non-object target/descriptor — Node's messages). */
ScrDyn *scr_dyn_define_props(ScrDyn *target, ScrDyn *descs);
/* Boxes a closure as a callable dyn value. Ownership of `clo` MOVES in
 * (callers retain first when they keep their own reference); `sig`/`name`
 * must be static literals (the box never frees them; name may be NULL). */
ScrDyn *scr_dyn_new_func(ScrClosure *clo, ScrDynThunk thunk, uint32_t arity, const char *sig, const char *name);
/* Calls a dyn value: a non-function kind throws the catchable TypeError
 * "<what> is not a function" (Node's wording — `what` is the call site's
 * callee spelling) and returns NULL; a function kind delegates to the
 * boxed thunk (per-arg checks live there). `args` entries are BORROWED;
 * the result is owned (+1), or NULL with the exception pending. */
ScrDyn *scr_dyn_call(const ScrDyn *d, ScrDyn *const *args, size_t argc, const char *what);
/* scr_dyn_call over a dyn ARRAY's elements (the spread-application form —
 * `f(...args)` after the emitted argument array is built): argv IS the
 * array's items. Borrows both; result owned (+1), or NULL pending. */
ScrDyn *scr_dyn_apply(const ScrDyn *d, const ScrDyn *args, const char *what);

/* Path spine for dynCheck error messages — a compile-time-shaped linked
 * list the emitted builders stack-allocate per recursion level: `key`
 * non-NULL for an object member segment, else `index` is an array index.
 * Rendered root-first as "$", "$.items[2].price", ... */
typedef struct ScrDynPath {
  const struct ScrDynPath *parent;
  const char *key;
  size_t index;
} ScrDynPath;

/* The dynCheck failure path: builds "TypeError: expected <want> at <path>,
 * got <kind>" (got == NULL renders as "undefined" — a missing object
 * member) and THROWS it through the exception cell (catchable; uncaught it
 * prints as "Uncaught TypeError: ..." and exits 1). This is
 * scriptc-specific behavior — JS `as` never checks (SEMANTICS.md). */
void scr_dyn_check_fail(const ScrDynPath *path, const char *want, const ScrDyn *got);

/* ── native handles in the checked-dynamic tree (SCR_DYN_HANDLE) ────────────────────────
 * Per-tag dispatch ops, registered by the handle's owning unit
 * (scr_http_dyn_install / scr_net_dyn_install — emitted main() calls
 * them exactly when the unit is linked, the scr_net_install story), so
 * this always-linked core never references gated units. */
typedef struct ScrDynHandleOps {
  const char *cls; /* Node's constructor name — error texts and dynCheck's "got ..." */
  void *(*retain)(void *h);
  void (*release)(void *h);
  /* Member CALL on a dyn handle (`res.end(...)`): dispatch (tag, method)
   * onto the static lowering's entry point with per-arg checks per the
   * static signature. `self` is the receiving box (`return this` methods
   * answer it +1). Result owned (+1) or NULL with the exception pending.
   * Real-but-unimplemented members throw the loud "not supported yet"
   * ladder; names the class's surface never had throw Node's
   * "<what> is not a function". */
  ScrDyn *(*invoke)(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc, const char *what);
  /* Property READ with a static equivalent (req.url, res.statusCode):
   * +1 boxed value; NULL = no such modeled property (the caller answers
   * the undefined singleton — the checked-dynamic tree's own-property stance); may throw
   * the loud ladder for real-but-unmodeled names (NULL + pending). */
  ScrDyn *(*get)(void *h, const char *key, size_t key_len);
  /* Property WRITE with a static equivalent (res.statusCode = 200):
   * true = handled (value borrowed); false = not a modeled property (the
   * caller throws the loud ladder — Node would take an expando, but a
   * silent per-box expando would break handle identity). May throw its
   * own catchable error (returns true with the exception pending). */
  bool (*set)(void *h, const char *key, size_t key_len, const ScrDyn *value);
  /* Cross-unit pipe DESTINATION hook (`socket.pipe(res)` — the source's
   * unit cannot name the destination's entry points without breaking
   * link gating): the destination accepts a source handle box, or
   * answers false for a pairing it does not model (the caller's loud
   * fence). NULL when the tag accepts no pipes. */
  bool (*pipe_from)(void *dst, const ScrDyn *src);
} ScrDynHandleOps;

void scr_dyn_handle_install(ScrDynHandleTag tag, const ScrDynHandleOps *ops);
/* The tag's class display name ("IncomingMessage") — error texts across
 * units; answers "object" for an uninstalled tag (error paths only). */
const char *scr_dyn_handle_cls(const ScrDyn *d);
/* The installed ops for a HANDLE box (aborts on a missing install — an
 * internal error: emitted programs install a unit's ops whenever they
 * can box its handles). The dispatch unit's entry into the registry. */
const ScrDynHandleOps *scr_dyn_handle_ops_of(const ScrDyn *d);
/* Boxes a handle by reference (+1 box; retains h through the tag's ops).
 * The tag MUST be installed — emitted programs install a unit's ops
 * whenever they can box its handles. */
ScrDyn *scr_dyn_new_handle(void *h, ScrDynHandleTag tag);
/* dynCheck extraction (`u as IncomingMessage`, a boxed listener's typed
 * parameter): tag match answers the RETAINED pointer (+1 — reference
 * identity, no copy); anything else throws the path-annotated catchable
 * TypeError and returns NULL. */
void *scr_dyn_handle_unbox(const ScrDyn *d, ScrDynHandleTag tag, const ScrDynPath *path, const char *want);
/* Keyed read on a HANDLE box (the emitted sc_dyn_key_get's arm): the
 * tag's modeled properties answer boxed values; everything else answers
 * the undefined singleton (the checked-dynamic tree's own-property stance — SEMANTICS.md)
 * unless the ops fence it loudly. +1, or NULL with a pending exception. */
ScrDyn *scr_dyn_handle_key_get(const ScrDyn *d, const ScrStr *k);

/* ── promises in the checked-dynamic tree (SCR_DYN_PROMISE) ────────────────────────────
 * Boxes by REFERENCE (+1 box; retains p). The boundary contract: p
 * settles with a dyn payload — promise<dyn> boxes directly; other inner
 * types go through scr_dyn_new_promise_adapting, which parks an emitted
 * payload-converting adapter (the Promise.race cb-waiter machinery) on
 * `src` and boxes the fresh destination promise instead. Rejections copy
 * raw through the same machinery (reasons are dynamically tagged) and
 * count as HANDLED on src — the boxed destination is the tracked one,
 * like a JS .then chain. */
ScrDyn *scr_dyn_new_promise(ScrPromise *p); /* scr_async_dyn.c (gated) */
/* The allocator view the gated boxes use; installs the release arm's
 * promise-release edge (runtime-internal). */
ScrDyn *scr_dyn_alloc_promise(void (*release_fn)(ScrPromise *p));
extern void (*scr_dyn_promise_release_fn)(ScrPromise *p);
ScrDyn *scr_dyn_new_promise_adapting(ScrPromise *src,
                                     void (*adapt)(ScrPromise *dst, ScrPromise *src));
/* BORROWED peek at the boxed promise; NULL when d is not a promise box. */
ScrPromise *scr_dyn_promise_of(const ScrDyn *d);

/* ── island values in the checked-dynamic tree (SCR_DYN_JSVAL) ─────────────────────────
 * Engine routing ops for JSVAL nodes, installed by the gated constructor
 * (scr_dyn_from_jsval, scr_island.c — the scr_dyn_alloc_promise hook
 * story: JSVAL nodes exist only after the constructor ran, so the ops
 * are always installed when a dispatch arm meets the kind, and a
 * dynamic-free link never references engine symbols). Contracts mirror
 * the scr_jsval_* entries they route to. */
typedef struct ScrDynJsvalOps {
  void (*release)(ScrJsval *cell);
  ScrStr *(*type_of)(ScrJsval *cell); /* engine typeof; +1, never throws */
  bool (*truthy)(ScrJsval *cell);     /* engine ToBoolean; never throws */
  /* String(v) in the engine (the full ToString protocol — user toString
   * runs, its throw bridges): +1, or NULL with the exception pending. */
  ScrStr *(*to_str)(ScrJsval *cell);
  bool (*strict_eq)(ScrJsval *a, ScrJsval *b); /* engine ===; never throws */
  bool (*is_array)(ScrJsval *cell);   /* Array.isArray, engine-side */
  bool (*is_error)(ScrJsval *cell);   /* native Error instance, engine-side */
  /* ── the routed operation set (lane dyn-routing-ops) ────────────────
   * Each routes to the engine at the moment of use and converts at the
   * boundary: dyn ARGUMENTS cross through scr_jsval_from_dyn (wrapped
   * cells unwrap by reference, dyn data deep-copies, dyn FUNC boxes
   * cross through the generic host-function shim), engine RESULTS come
   * back through scr_dyn_from_jsval (scalar-normalizing). Fallible ops
   * bridge the ENGINE's exception catchably and answer NULL/false/-1. */
  ScrDyn *(*key_get)(ScrJsval *cell, const ScrStr *k); /* o[k]; +1 or NULL pending */
  bool (*key_set)(ScrJsval *cell, const ScrStr *k, const ScrDyn *v); /* false = pending */
  ScrDyn *(*call)(ScrJsval *cell, ScrDyn *const *args, size_t argc); /* f(...); +1 or NULL pending */
  /* o.m(...) — the ENGINE's own prototypes run (JS-exact flatMap/map/
   * forEach/...). A missing or non-callable member throws Node's
   * "<what> is not a function" (the call site's spelling — V8's text,
   * front-run before the engine's terser claim). */
  ScrDyn *(*invoke)(ScrJsval *cell, const char *method, ScrDyn *const *args, size_t argc, const char *what);
  bool (*is_nullish)(ScrJsval *cell); /* engine undefined/null; never throws
                                       * (always false today — the wrap
                                       * constructor scalar-normalizes) */
  /* Object.keys/values/entries (mode 0/1/2) as a NATIVE dyn array (+1):
   * keys are dyn strings, values wrap per element, entries are native
   * dyn pairs. NULL with the engine's exception pending on refusal. */
  ScrDyn *(*obj_walk)(ScrJsval *cell, int mode);
  int (*has_own)(ScrJsval *cell, const ScrStr *k); /* 0/1; -1 = pending */
  /* Object.assign(target, src) with the ENGINE target: src converts per
   * member semantics (a wrapped src spreads by reference; dyn data
   * enters as the usual deep copy). false = pending. */
  bool (*assign)(ScrJsval *cell, const ScrDyn *src);
  /* JSON.stringify text of the engine value (+1) — the engine's own
   * stringify (toJSON protocols, cycle TypeErrors). NULL + pending when
   * not JSON-representable. */
  ScrStr *(*to_json)(ScrJsval *cell);
  /* Drain the ENGINE's own iterator protocol into a fresh dyn array
   * (elements wrap back scalar-normalized) — the for-of/destructuring/
   * spread arm over a wrapped value. The guard's TypeError wording on a
   * non-iterable: spread true takes V8's spread-call text; otherwise the
   * compile-time spelling `spell` verbatim when non-NULL (the named-
   * source form), else the kind wording. An iterating getter/next throw
   * bridges with the ENGINE's message. +1, or NULL with the exception
   * pending. */
  ScrDyn *(*iter_drain)(ScrJsval *cell, bool spread, const ScrStr *spell);
} ScrDynJsvalOps;

/* The allocator view the gated constructor uses (installs the ops);
 * ownership of `cell` MOVES in (the caller retains first). */
ScrDyn *scr_dyn_alloc_jsval(ScrJsval *cell, const ScrDynJsvalOps *ops);
/* The installed ops (traps on a missing install — impossible unless a
 * JSVAL node was forged without the constructor). */
const ScrDynJsvalOps *scr_dyn_jsval_ops(void);
/* dynTest arms that need the ENGINE's answer on a JSVAL node, or the
 * materialized answer for a live typed-reference capsule. Each answers
 * false for every other kind (callers test unconditionally — the emitted
 * narrowing tests stay branch-free). Never throw. */
bool scr_dyn_isl_typeof_is(const ScrDyn *d, const char *name);
bool scr_dyn_isl_is_array(const ScrDyn *d);
bool scr_dyn_isl_is_error(const ScrDyn *d);
/* The JSVAL honesty ladder: when d is a JSVAL node, THROWS the catchable
 * "<what> on an island value held in 'unknown' is not supported yet"
 * Error and returns false; every other kind returns false untouched.
 * Callers gate un-armed operations with it — never a silent wrong
 * answer (the retired fence-box bug). */
bool scr_dyn_isl_fence(const ScrDyn *d, const char *what);
/* The emitted keyed READ's JSVAL arm (sc_dyn_key_get): routes o[k] to the
 * engine through the installed ops and wraps the result back (+1, scalars
 * normalized) — the retired `.length -> fence` row. d MUST be a JSVAL
 * node; NULL with the engine's exception bridged catchably. */
ScrDyn *scr_dyn_isl_key_get(const ScrDyn *d, const ScrStr *k);
/* The `??`/optional-chain nullish test over a dyn value: UNDEF/NULL
 * native, JSVAL through the engine's own test (defensively — the wrap
 * constructor scalar-normalizes engine null/undefined away), every other
 * kind false. Never throws. */
bool scr_dyn_is_nullish(const ScrDyn *d);
/* scr_dyn_isl_tostr_buf (the display walkers' JSVAL arm) is declared
 * with the ScrJsonBuf surface below. */

/* ── the ambient receiver (JS `this` inside listener/callback bodies) ──
 * Node calls a handle's listeners with `this` bound to the emitting
 * handle (server.listen(0, function() { this.address().port })), and a
 * dyn OBJ method call binds the object. Compiled closures carry no
 * receiver parameter; instead the CALLING site binds the receiver for
 * the call's synchronous extent (push/pop nest strictly — the runtime is
 * single-threaded and fires listeners synchronously) and a plain-function
 * `this` read (JS entries only — TypeScript keeps the noImplicitThis
 * fence) answers the innermost binding: the emitted libCall dyn.this.
 * With no binding the read answers the strict-mode undefined singleton,
 * exactly the old stance. The receiver survives into nested plain CALLS
 * made during the window (where Node would re-bind undefined) and does
 * NOT survive a resumed async body — both are documented divergences;
 * the payoff is that test/common's mustCall wrapper (`return
 * fn.apply(this, arguments)`) forwards the receiver for free. */
void scr_dyn_this_push(void *h, ScrDynHandleTag tag); /* h BORROWED (the firing site holds it); NULL binds undefined */
void scr_dyn_this_push_dyn(const ScrDyn *v);          /* retained for the window */
void scr_dyn_this_pop(void);
/* The innermost binding as a dyn value (+1): a boxed handle, the pushed
 * dyn value, or the undefined singleton (empty stack, NULL handle, or a
 * handle whose tag has no installed ops — a unit that fires without its
 * dyn half never binds). */
ScrDyn *scr_dyn_this_get(void);

/* The data-chunk encoding window (setEncoding — scr_json.c's note): the
 * firing site opens/closes it around a 'data' pass; scr_dyn_new_chunk
 * answers a Buffer-flavored bytes box, or a string inside the window. */
void scr_dyn_chunk_enc(bool utf8);
ScrDyn *scr_dyn_new_chunk(const ScrBytes *b);

/* util.format's %j over a dyn value: the JSON.stringify text (+1),
 * "undefined" when the root drops (undefined/function), or NULL with a
 * pending exception (a runtime handle inside the tree fences loudly). */
ScrStr *scr_dyn_format_j(const ScrDyn *d);
/* Node's ERR_INVALID_ARG_TYPE listener gate over a dyn value — shared by
 * the emitter unit's checked-dynamic registrations and the handle
 * dispatchers' .on(...) paths (both render errors.js's
 * determineSpecificType shapes). Throws when cb is not a function kind. */
void scr_dyn_check_listener(const ScrDyn *cb, const char *argname);
/* errors.js's determineSpecificType tail ("type number (5)", "an
 * instance of Object") rendered into buf when payload-carrying; the
 * generic ERR_INVALID_ARG_TYPE thrower over it (`expected` is the whole
 * "of type ..." clause). The handle dispatchers' per-arg gates. */
const char *scr_dyn_specific_type(const ScrDyn *v, char *buf, size_t cap);
/* ERR_INVALID_ARG_TYPE with the runtime-rendered Received tail (the
 * error.argTypeThrow libCall). Borrows all three; always throws. */
void scr_throw_arg_type(const ScrStr *argname, const ScrStr *expected, const ScrDyn *got);
void scr_dyn_arg_type_fail(const char *argname, const char *expected, const ScrDyn *got);
/* The property flavor ("The \"options.x\" property must be ...") — the
 * option-bag validators' gate (error.propTypeThrow). Always throws. */
void scr_throw_prop_type(const ScrStr *name, const ScrStr *expected, const ScrDyn *got);
void scr_dyn_prop_type_fail(const char *name, const char *expected, const ScrDyn *got);
/* Node's ERR_INVALID_ARG_VALUE ("The argument 'encoding' is invalid
 * encoding. Received 'no'") — reason NULL renders "is invalid".
 * TypeError; always throws catchably. */
void scr_dyn_arg_value_fail(const char *name, const char *reason, const ScrDyn *got);
/* The ERR_INVALID_ARG_VALUE/%j "Received" renderer (inspect-lite:
 * strings quote, scalars print plain, deep shapes sketch). */
const char *scr_dyn_inspect_lite(const ScrDyn *v, char *buf, size_t cap);
/* A ladder's post-validation refuse: throws the compiler-rendered SC2020
 * statement-fence text verbatim (Node's validation errors run first). */
void scr_throw_lowering_fence(const ScrStr *msg);
/* ERR_OUT_OF_RANGE's "Received" number rendering (Node's
 * addNumericalSeparator underscores past 2^32) — scr_bytes.c's renderer,
 * shared by the fs/net/tls option-ladder validators. */
size_t scr_num_received(double v, char out[48]);
/* Listener-closure builders for the handle dispatchers' .on(...) paths:
 * a runtime-built ScrClosure whose capture is the boxed dyn listener and
 * whose invoke boxes the event tuple back into the checked-dynamic tree and calls through
 * the checked-dynamic machinery. The matching fn-pointer shapes are the
 * per-event thunk types the registration entries take (fire0's zero-arg
 * convention / ScrNetDataFn / ScrChildErrFn). cb borrowed; result +1. */
ScrClosure *scr_dyn_listener_closure0(const ScrDyn *cb);
ScrClosure *scr_dyn_listener_closure_data(const ScrDyn *cb);
ScrClosure *scr_dyn_listener_closure_err(const ScrDyn *cb);
/* The generic pair for fire thunks the OWNING units define (handle-boxing
 * tuples this unit cannot spell: 'connection' sockets, 'request' pairs):
 * the same one-capture closure with a caller-supplied fire, and the
 * capture read those fires start from (+1). */
ScrClosure *scr_dyn_listener_closure_fn(const ScrDyn *cb, void *fire);
ScrDyn *scr_dyn_listener_fn(ScrClosure *cb);
typedef void (*ScrDynListenerDataFn)(ScrClosure *cb, ScrBytes *chunk);
typedef void (*ScrDynListenerErrFn)(ScrClosure *cb, ScrStr *msg);
extern void scr_dyn_listener_fire0(ScrClosure *cb);
extern void scr_dyn_listener_fire_data(ScrClosure *cb, ScrBytes *chunk);
extern void scr_dyn_listener_fire_err(ScrClosure *cb, ScrStr *msg);

/* Output buffer for the compiler-emitted type-directed JSON serializers.
 * Value-typed and stack-allocated by the emitted code; _finish hands the
 * bytes over as a +1 ScrStr and frees the buffer storage (including the
 * circular-detection stack below). */
struct ScrJsonSeenEnt;
typedef struct {
  char *data;
  size_t len;
  size_t cap;
  /* Circular-structure detection for RECURSIVE record types (cyclic
   * values must throw Node's exact TypeError, never recurse forever):
   * the stack of container values currently being serialized, each with
   * its outgoing edge label (the member being written). Only walkers over
   * cycle-CAPABLE types (the collector-fixpoint set) maintain it; acyclic
   * types keep the zero-cost path. */
  struct ScrJsonSeenEnt *seen;
  size_t seen_len;
  size_t seen_cap;
} ScrJsonBuf;

void scr_jb_init(ScrJsonBuf *b);
/* Append one borrowed runtime string verbatim (no JSON quoting). */
void scr_jb_put_str(ScrJsonBuf *b, const ScrStr *s);
/* Push a container onto the circular-detection stack before serializing
 * its members. If `v` is already ON the stack, throws V8's exact
 * "Converting circular structure to JSON" TypeError (the --> starting at /
 * |property/index hops/--- closes the circle rendering, ellipsis rules
 * included) and returns false — the caller returns immediately; the
 * emitted stringify site runs the pending check. `is_array` picks the
 * constructor name in the message ('Array' for arrays AND tuple shapes —
 * their JS values are arrays — 'Object' for records). */
bool scr_jb_enter(ScrJsonBuf *b, const void *v, bool is_array);
void scr_jb_leave(ScrJsonBuf *b);
/* Record the edge currently being serialized on the stack top: a static
 * property name (emitted C literal), an overflow key (borrowed for the
 * duration of the member write), or an array/tuple index. */
void scr_jb_edge_prop(ScrJsonBuf *b, const char *name);
void scr_jb_edge_key(ScrJsonBuf *b, const ScrStr *key);
void scr_jb_edge_idx(ScrJsonBuf *b, size_t i);

/* Circular guard for the compiler-emitted typed→dyn converters (sc_td_*
 * over cycle-capable containers): enter TRAPS on a value already being
 * converted (a cyclic value has no finite dyn copy — Node shares the
 * reference instead; SEMANTICS.md), else pushes. */
void scr_dyn_from_enter(const void *v);
void scr_dyn_from_leave(void);
void scr_jb_putc(ScrJsonBuf *b, char c);
void scr_jb_puts(ScrJsonBuf *b, const char *s);
/* JS JSON.stringify number rules: NaN/±Infinity → null, -0 → 0, else
 * shortest-roundtrip via scr_f64_to_str. */
void scr_jb_put_f64(ScrJsonBuf *b, double v);
/* Quoted + escaped JSON string: \" \\ \n \r \t \b \f, other control chars
 * as \u00XX, everything else (UTF-8 included) verbatim — exactly the JS
 * JSON.stringify escape set for well-formed strings. */
void scr_jb_put_json_str(ScrJsonBuf *b, const ScrStr *s);
/* String(v) of a JSVAL node appended into b (the emitted sc_ds display
 * walkers' arm; scr_dyn_display/to_string route here too): the engine's
 * ToString. A bridged failure (throwing user toString, a symbol) leaves
 * the exception PENDING and appends nothing — the loud path, never a
 * fabricated rendering. */
void scr_dyn_isl_tostr_buf(ScrJsonBuf *b, const ScrDyn *d);
/* JSON-serialize a dyn value into the buffer — the sc_jw_* walker for the
 * dyn leaves the compiler cannot type: object members holding undefined
 * DROP, array slots holding undefined print null (exactly Node). */
void scr_jb_put_dyn(ScrJsonBuf *b, const ScrDyn *d);
ScrStr *scr_jb_finish(ScrJsonBuf *b); /* returns +1; frees the buffer */

void *scr_dyn_retain_v(void *d);
void scr_dyn_release_v(void *d);

#ifdef SCR_RC_AUDIT
long scr_dyn_live_count(void);
#endif

/* ── class instances ─────────────────────────────────────────────────
 * Objects are per-class C structs emitted by the compiler (shared header:
 * `size_t rc` first), with per-class new/retain/release helpers also
 * emitted. The runtime provides only the RC-audit hooks those helpers call.
 */
void scr_obj_alloc_note(void);
void scr_obj_free_note(void);
#ifdef SCR_RC_AUDIT
long scr_obj_live_count(void);
#endif

/* ── async: promises, fibers, event loop ────────────────────────────
 * Async function bodies run on stackful fibers; `await` parks the fiber on
 * a promise; a dependency-free loop (microtasks before timers, FIFO
 * tiebreaks) drives everything after %main returns. See scr_async.c.
 */
ScrPromise *scr_promise_new(void);
ScrPromise *scr_promise_retain(ScrPromise *p);
void scr_promise_release(ScrPromise *p);
void *scr_promise_retain_v(void *p);
void scr_promise_release_v(void *p);

typedef struct ScrFiber ScrFiber;
/* Spawn + run eagerly to the first suspension; returns the promise, +1. */
ScrPromise *scr_async_spawn(void (*entry)(ScrFiber *, void *), void *argpack);
/* Runtime-authored C waiters cannot themselves become LLVM switched
 * coroutines on wasm32. Spawn after `dependency` settles so their first
 * (and only) await is extraction from an already-settled promise, while
 * retaining the ordinary promise-job hop on every target. +1. */
ScrPromise *scr_async_spawn_after(ScrPromise *dependency,
                                  void (*entry)(ScrFiber *, void *),
                                  void *argpack);

/* wasm32-wasi lowers async functions and generators through LLVM switched
 * coroutines instead of the native stack-switching implementations. The
 * first two adapters are emitted into the program module; the remaining
 * helpers let scr_async.c register, queue, and finish those coroutine
 * frames through the same ScrFiber scheduler. These declarations are part
 * of the LLVM/runtime ABI even though native targets never call them. */
void scr_wasi_coro_resume(void *handle);
void scr_wasi_coro_destroy(void *handle);
void scr_wasi_coro_started(void *handle);
void scr_wasi_await_prepare(ScrFiber *self, ScrPromise *p);
void scr_wasi_await_hop_prepare(ScrFiber *self);
bool scr_wasi_module_await_prepare(ScrFiber *self, ScrPromise *p);
void scr_wasi_async_finish(ScrFiber *self);
void scr_wasi_gen_finish(ScrFiber *self);

double scr_await_f64(ScrPromise *p); /* rejected promises re-throw */
bool scr_await_bool(ScrPromise *p);
ScrStr *scr_await_str(ScrPromise *p); /* +1 */
void *scr_await_ref(ScrPromise *p);   /* +1 via the stored retain */
void scr_await_void(ScrPromise *p);
/* Internal ESM dependency wait: parks while pending but, unlike a
 * JavaScript await expression, does not hop when already settled. */
void scr_module_await(ScrPromise *p);
/* After the root-aware event loop returns, inspect the executable's async
 * module-root promise without another microtask hop: 0 = fulfilled,
 * 1 = rejected, 13 = still pending with no ref'd work capable of settling
 * it (Node's unsettled top-level-await exit status). A rejected root is
 * marked observed here but re-thrown separately; earlier-checkpoint
 * rejections were already decided by the loop and same-checkpoint
 * competitors are suppressed by the executable-module verdict. */
int scr_promise_finish_top_level(ScrPromise *p);
void scr_promise_rethrow_top_level(ScrPromise *p);
/* The checked-dynamic tree-crossing await (SCR_DYN_PROMISE's boundary contract): the
 * payload as a dyn value (+1; void fulfillments answer the undefined
 * value), or NULL with the rejection re-thrown into the awaiter. */
ScrDyn *scr_await_dyn(ScrPromise *p);
/* `await v` over a checked-dynamic VALUE: dyn promises adopt, everything
 * else takes JS's one-hop non-thenable await and answers itself (+1). */
ScrDyn *scr_await_dyn_value(ScrDyn *v);
/* .then/.catch/.finally over a dyn promise (scr_dyn_invoke's promise arm
 * and the compiled dyn-receiver path): one reaction fiber per
 * registration — awaits src, runs the checked-dynamic tree handler (non-callable handlers
 * pass the settlement through; a returned dyn promise is adopted), and
 * settles a fresh result promise, answered BOXED (+1). Microtask-exact
 * ordering rides the fiber machinery. */
ScrDyn *scr_dyn_promise_then(ScrPromise *src, ScrDyn *onf, ScrDyn *onr, ScrDyn *onfin);
/* ── AsyncLocalStorage (node:async_hooks — scr_async.c) ───────────────
 * Stores are process-lived f64 handles; the CONTEXT is an immutable
 * refcounted snapshot of (store → dyn value) entries riding the fiber
 * machinery: one active-slot pointer (the exc-cell pattern) swapped at
 * every fiber switch, inherited by spawned fibers (Node's init-time
 * capture). enter answers the PREVIOUS snapshot (owned) for restore —
 * strict nesting is the callers' contract (run/runStores wrap calls). */
/* The snapshot layout (full declaration — the ScrExcCell stance: the
 * fiber machinery in scr_async.c owns the active slot and the RC pair;
 * the gated API TU (scr_async_dyn.c) builds and reads snapshots). */
typedef struct {
  double id;
  ScrDyn *value; /* owned */
} ScrAlsEntry;
typedef struct ScrAlsCtx {
  size_t rc;
  size_t len;
  ScrAlsEntry entries[]; /* flexible */
} ScrAlsCtx;
/* Runtime-internal (the fiber machinery's always-linked core). */
extern ScrAlsCtx **scr_als_active;
ScrAlsCtx *scr_als_ctx_retain(ScrAlsCtx *c);
void scr_als_ctx_release(ScrAlsCtx *c);
double scr_als_new(void);
ScrDyn *scr_als_get(double id); /* +1; the undefined value when unset */
ScrAlsCtx *scr_als_enter(double id, ScrDyn *value); /* borrows value; prev out (owned) */
ScrAlsCtx *scr_als_enter_absent(double id);         /* exit()'s cleared arm */
void scr_als_restore(ScrAlsCtx *prev);              /* moves prev back in */
void scr_als_enter_with(double id, ScrDyn *value);  /* no restore point (enterWith) */
void scr_als_disable(double id);
/* run/exit: enter (or clear), call the dyn function with the forwarded
 * argument vector, restore (the finally). Result +1 or NULL pending. */
ScrDyn *scr_als_run(double id, ScrDyn *value, ScrDyn *fn, ScrDyn *args);
ScrDyn *scr_als_exit_run(double id, ScrDyn *fn, ScrDyn *args);

/* process.on/once('unhandledRejection', fn): dyn listeners dispatched
 * per never-observed rejection at the end of its nextTick/microtask
 * checkpoint — (reason, promise), suppressing the default report and the
 * exit-1. `once` auto-removes after one delivery; off removes by closure
 * identity (the warning registry's story). Throws Node's
 * ERR_INVALID_ARG_TYPE on a non-function. */
void scr_process_on_unhandled_rejection(ScrDyn *fn, bool once);
void scr_process_off_unhandled_rejection(ScrDyn *fn);
/* process.on/once/off('rejectionHandled', fn): the sibling registry. A
 * promise handled after its unhandledRejection delivery fires once, with
 * the promise as Node's payload. */
void scr_process_on_rejection_handled(ScrDyn *fn, bool once);
void scr_process_off_rejection_handled(ScrDyn *fn);
/* The checkpoint delivery hook the registration above installs
 * (scr_async_dyn.c → scr_report_unhandled_rejections; NULL = default
 * report). Runtime-internal. */
extern bool (*scr_urj_deliver_fn)(ScrPromise *p);
/* The late-handled hook (scr_async_dyn.c installs it when a
 * 'rejectionHandled' listener registers): scr_async.c calls it when a
 * promise the report already delivered as unhandled gains a handler.
 * Runtime-internal. */
extern void (*scr_rjh_notify_fn)(ScrPromise *p);
/* The attach-time handled mark (a dyn then/catch carrying a rejection
 * handler, or the module loader taking ownership of an evaluation
 * promise): marks pending and rejected sources observed at Node's attach
 * moment, firing the late-handled hook when the report already delivered
 * it. Runtime-internal. */
void scr_promise_mark_handled(ScrPromise *p);
/* A rejected promise's reason as a dyn value (identity-preserving for
 * dyn payloads and %Error instances). +1. */
ScrDyn *scr_promise_reason_dyn(const ScrPromise *p);
/* process warnings (scr_lib.c — always linked so any unit can emit a
 * deprecation): dyn listeners plus Node's default stderr report
 * ("(node:pid) [CODE] Name: message" and a detail second line). Emission
 * is SYNCHRONOUS at the call (Node defers a tick — SEMANTICS.md 138's
 * precedent). scr_process_emit_warning takes the ARGUMENT VECTOR as one
 * dyn array and applies Node's full grammar/TypeErrors; scr_emit_warning
 * is the C-side deprecation entry. */
void scr_process_on_warning(ScrDyn *fn);
void scr_process_off_warning(ScrDyn *fn);
void scr_process_emit_warning(ScrDyn *args);
void scr_emit_warning(const char *name, const char *code, ScrStr *message);
/* The promise-or-absent await's unit arm: one microtask hop, like JS's
 * await of any non-thenable (and like awaiting a settled promise). */
void scr_await_hop(void);

void scr_promise_fulfill_f64(ScrPromise *p, double v);
void scr_promise_fulfill_bool(ScrPromise *p, bool v);
void scr_promise_fulfill_str(ScrPromise *p, ScrStr *v); /* moves in */
/* trace: non-NULL iff the payload type carries a cycle header (a promise
 * fulfilled with a cycle-capable value is itself a cycle member candidate:
 * its trace visits the payload). */
void scr_promise_fulfill_ref(ScrPromise *p, void *v, void *(*retain)(void *), void (*release)(void *), ScrTraceFn trace);
void scr_promise_fulfill_void(ScrPromise *p);

/* Reject `p` with the exception pending in the active cell (moved out —
 * the cell resets); wakes waiters, enters the unhandled ledger. No-op
 * with a clean cell; an already-settled `p` just clears the cell. The
 * island promise bridge's rejection half (scr_island.c). */
void scr_promise_reject_pending(ScrPromise *p);

/* Mint an ALREADY-SETTLED promise from a just-run synchronous operation:
 * a pending exception in the active cell moves in as the REJECTION (the
 * cell resets — callers' pending checks see it clean) and the payload is
 * dropped; otherwise the payload fulfills. The fs/promises bridge. */
ScrPromise *scr_promise_settled_str(ScrStr *v); /* moves v in */
ScrPromise *scr_promise_settled_void(void);
ScrPromise *scr_promise_settled_ref(void *v, void *(*retain)(void *), void (*release)(void *), ScrTraceFn trace);

/* ── Promise.race (compiler-emitted combinator plumbing) ──────────────
 * race_add: settle the result from an already-settled entry, or park a
 * callback waiter that fires inside the entry's settle — fulfillments run
 * `adapt` (an emitted per-type adapter building the result's inner type
 * from the entry's payload; scr_promise_adapt_copy is the same-type
 * one), rejections copy raw and count as HANDLED on the entry. The
 * payload accessors return retained/by-value fulfillment payloads for
 * the emitted adapters (losing entries keep their settlements). */
void scr_promise_race_add(ScrPromise *race, ScrPromise *in,
                           void (*adapt)(ScrPromise *dst, ScrPromise *src));

/* ── Promise.all (compiler-emitted combinator plumbing) ───────────────
 * BORROWS the Promise<T>[] entries array and the pre-capacity (empty,
 * cap >= ps->len) values array — NULL values/store for Promise<void>
 * entries, whose result fulfills void — retains what it keeps, and
 * returns the result promise +1. Node-exact: values land at their INPUT
 * index regardless of settlement order, the first rejection in
 * SETTLEMENT order wins (later ones count as handled on their entries),
 * and the empty array fulfills immediately. The store helpers are the
 * per-element-kind payload writers the compiler picks from. */
ScrPromise *scr_promise_all(ScrArr *ps, ScrArr *values,
                             void (*store)(ScrArr *a, double i, ScrPromise *src));
void scr_promise_all_store_f64(ScrArr *a, double i, ScrPromise *src);
void scr_promise_all_store_bool(ScrArr *a, double i, ScrPromise *src);
void scr_promise_all_store_str(ScrArr *a, double i, ScrPromise *src);
void scr_promise_all_store_ref(ScrArr *a, double i, ScrPromise *src);
void scr_promise_adapt_copy(ScrPromise *dst, ScrPromise *src);
double scr_promise_payload_f64(ScrPromise *p);
bool scr_promise_payload_bool(ScrPromise *p);
ScrStr *scr_promise_payload_str(ScrPromise *p); /* +1 */
void *scr_promise_payload_ref(ScrPromise *p);   /* +1 via the stored retain */
/* Thin payload views for the gated dyn-async TU (scr_async_dyn.c). */
int scr_promise_payload_kind(const ScrPromise *p);   /* ScrExcKind */
bool scr_promise_payload_is_dyn(const ScrPromise *p);
double scr_promise_payload_num(const ScrPromise *p);
bool scr_promise_payload_flag(const ScrPromise *p);
bool scr_promise_await_settled(ScrPromise *p); /* park/hop; false = rethrown */
void scr_promise_payload_release(const ScrPromise *p, void *v);

void scr_set_timeout(ScrClosure *cb, double ms); /* cb ownership moves in */
/* setInterval/clearInterval: the handle is the number the fallback
 * declarations promise (ids start at 1, so `if (handle)` narrows like
 * Node's Timeout truthiness). A live interval keeps the loop alive;
 * clearInterval removes it eagerly (clearing from inside its own callback
 * works). An unknown handle is a no-op, like Node. */
double scr_set_interval(ScrClosure *cb, double ms); /* cb ownership moves in */
/* `new Promise(setImmediate)`: a fresh promise an armed immediate
 * fulfills with the undefined dyn value (+1). */
ScrPromise *scr_immediate_promise(void);
void scr_clear_interval(double handle);
/* The island timer bridge (scr_web.c): a one-shot entry WITH a clear
 * handle (island clearTimeout cancels; ids share the interval space so
 * scr_clear_interval serves both), and the teardown sweep that releases
 * every armed closure before the engine dies. */
double scr_set_timeout_handle(ScrClosure *cb, double ms); /* cb ownership moves in */
void scr_timers_teardown(void);
/* Timeout.unref()/ref()/hasRef(): loop-liveness bookkeeping over the timer
 * handle (setTimeout/setInterval's id). unref drops the timer from the
 * liveness count — it still fires if the loop runs on, but never keeps the
 * process alive by itself (Node's semantics); ref restores it; hasRef
 * answers the current state. Absent/NaN handles are tolerated no-ops. */
void scr_timer_unref(double handle);
void scr_timer_ref(double handle);
bool scr_timer_has_ref(double handle);
/* Timeout.refresh(): re-arm to now + the original delay. Works on armed
 * heap entries and from inside the firing timer's own callback (the loop
 * re-arms after the callback returns); a one-shot that already fired on
 * an earlier turn is gone and no-ops (documented divergence). */
void scr_timer_refresh(double handle);
/* setImmediate/clearImmediate — Node's check phase: FIFO once per loop
 * turn after due timers, immediates queued mid-phase wait for the next
 * turn. The handle is an f64 id in its own space (clearTimeout of an
 * Immediate is a no-op, like Node); the Immediate ref trio mirrors the
 * Timeout one (unref'd pending immediates don't keep the loop alive and
 * never fire once nothing reffed remains). scr_timers_teardown sweeps
 * the immediate queue too. */
double scr_set_immediate(ScrClosure *cb); /* cb ownership moves in */
/* queueMicrotask: the callback enters the SAME FIFO promise continuations
 * ride (one microtask order, like V8's queue); a throw is an UNCAUGHT
 * exception, never a rejection. cb ownership moves in. The _dyn form
 * (checked-dynamic arguments) throws Node's ERR_INVALID_ARG_TYPE
 * synchronously on a non-function; borrowed. */
void scr_queue_microtask(ScrClosure *cb);
void scr_queue_microtask_dyn(const ScrDyn *cb);
/* setImmediate AS A dyn VALUE (the traceCallback shape): a minted dyn
 * callable that schedules args[0](args[1..]) on the immediate queue and
 * answers undefined; a non-function first argument throws Node's
 * ERR_INVALID_ARG_TYPE. Result +1. */
struct ScrDyn *scr_set_immediate_dyn_value(void);
void scr_clear_immediate(double handle);
void scr_immediate_unref(double handle);
void scr_immediate_ref(double handle);
bool scr_immediate_has_ref(double handle);
/* process.nextTick: enqueue a zero-param callback on the user tick
 * queue — drained BEFORE promise jobs at every loop checkpoint, to
 * joint exhaustion with them (Node's tick-then-microtask order).
 * Pending ticks keep the loop alive; ticks left queued at termination
 * ('exit' listeners, the uncaught paths) never run and release in
 * scr_timers_teardown — and in scr_nticks_teardown, which the
 * exit-listener runner calls for ticks enqueued AFTER the loop's own
 * teardown (they must never run yet must not leak). cb ownership moves
 * in. */
void scr_next_tick(ScrClosure *cb);
/* A successful process.stdout/stderr.write completion on that same queue.
 * The callback and its program-shaped Error | null adapter both MOVE into
 * the entry; the adapter is invoked with NULL (Node's success argument). */
void scr_process_write_callback(ScrClosure *cb, ScrFsRenameFn fn);
/* A raw C-hook entry on the SAME queue: the stream unit enqueues one
 * marker per deferred stream emission, so stream ticks and user
 * nextTicks run in true FIFO order (in Node they are the same queue).
 * Teardown drops markers without running them. */
void scr_next_tick_raw(void (*fn)(void));
void scr_nticks_teardown(void);
/* ── the events unit (scr_events.c — OPTIONAL, link-gated) ────────────
 * Process signal/exit events and the piped-stdin surface. The unit links
 * ONLY into binaries whose IR uses these surfaces (moduleUsesProcessEvents
 * — the scr_regex/scr_fetch/scr_zlib precedent); the emitted main calls
 * scr_events_install(), which fills the loop's nullable event hooks and
 * the two scr_lib.c hooks below. Event-free builds pay zero bytes.
 *
 * Signal events (process.on/once/off of "SIGINT"/"SIGTERM"): sigaction +
 * self-pipe, dispatched at loop turns as macrotasks. Watching replaces the
 * default disposition; removing the last listener restores it. Signal
 * listeners do NOT keep the loop alive (Node). `on` MOVES the callback in;
 * `off` borrows and removes the first pointer-identical entry.
 *
 * The process 'exit' event: listeners run synchronously at normal
 * termination (the unit's atexit) and inside process.exit() (through
 * scr_process_exit_hook); the adapter receives the exit code (runtime
 * thunks below for the 0-param and (code) shapes).
 *
 * process.stdin events (piped-stdin slice) and the for-await chunk
 * source. Listener callbacks MOVE in; data adapters get the chunk
 * BORROWED (the bytes thunk retains for the callee). next_chunk returns a
 * +1 promise of the next chunk — the EMPTY bytes value is the done
 * sentinel (a POSIX read never delivers an empty data chunk). While a
 * consumer exists (data listener or parked chunk promise) stdin keeps the
 * loop alive, like Node's flowing stdin. */
typedef struct ScrBytes ScrBytes; /* full definition below (C11 repeat) */
void scr_events_install(void);
void scr_signal_on(double signum, ScrClosure *cb, bool once);
void scr_signal_off(double signum, ScrClosure *cb);
void scr_process_on_exit(ScrClosure *cb, void (*fn)(ScrClosure *, double), bool once);
void scr_process_off_exit(ScrClosure *cb);
void scr_run_exit_listeners(double code);
void scr_exit_thunk0(ScrClosure *cb, double code);
void scr_exit_thunk_code(ScrClosure *cb, double code);
void scr_stdin_on_data(ScrClosure *cb, void (*fn)(ScrClosure *, ScrBytes *), bool once);
void scr_stdin_on_end(ScrClosure *cb, bool once);
void scr_stdin_on_error(ScrClosure *cb, ScrChildErrFn fn, bool once);
ScrPromise *scr_stdin_next_chunk(void); /* +1 */
void scr_stdin_destroy(void);
bool scr_stdin_pending(void);
/* node:readline's hooks into the stdin unit: removal by closure identity
 * (close() detaches the shared consumer) and the ended probe (EOF seen or
 * destroyed — a later createInterface is born dead). */
void scr_stdin_remove_data(ScrClosure *cb);
bool scr_stdin_ended(void);

/* ── node:readline (scr_readline.c, linked under the events gate) ──────
 * The question/close slice, Node's semantics pinned under pipes (the file
 * header has the full model): create answers the f64 interface handle;
 * question writes the query to stdout and delivers the next line's text
 * through the adapter (fn(cb, +1 answer)) — throwing Node's
 * "readline was closed" on a closed interface (may-throw); close fires
 * the 'close' listeners SYNCHRONOUSLY (Node's inline emit) and detaches
 * the stdin consumer; onClose registers a zero-arg listener (moves).
 * Answer adapters: thunk0 ignores the line, thunk_str passes it. */
double scr_rl_create(void);
void scr_rl_question(double id, const ScrStr *query, ScrClosure *cb /*moves*/,
                      void (*fn)(ScrClosure *, ScrStr *));
void scr_rl_close(double id);
void scr_rl_on_close(double id, ScrClosure *cb /*moves*/);
void scr_rl_answer_thunk0(ScrClosure *cb, ScrStr *answer);
void scr_rl_answer_thunk_str(ScrClosure *cb, ScrStr *answer);
void scr_stdin_data_thunk0(ScrClosure *cb, ScrBytes *chunk);
void scr_stdin_data_thunk_bytes(ScrClosure *cb, ScrBytes *chunk);
/* The loop-side registration (scr_async.c, always linked) and the
 * scr_lib.c hooks the unit fills. The abnormal-exit code hint lives in
 * scr_async.c so the uncaught/unhandled reporters can note it whether or
 * not the unit is present. */
void scr_loop_set_events(bool (*pending)(void), bool (*watching)(void),
                          void (*dispatch)(void), int (*pollfds)(int out[2]));
extern void (*scr_process_exit_hook)(double code);
extern void (*scr_stdin_destroy_hook)(void);
void scr_exit_code_note(int code);
int scr_exit_code_hint_get(void);
/* The pollable child-exit wake fd (the child kqueue / pidfd epoll) for the loop's
 * poll(2) sleep, or -1 when it can't wake for every pending child. */
int scr_children_wake_fd(void);
double scr_now_ms(void); /* the loop's monotonic clock, in ms */
/* Run to ordinary loop exhaustion, except that a non-NULL executable
 * module-root promise stops the loop as soon as it is rejected at a
 * microtask checkpoint. Fulfilled roots do not stop the loop: Node keeps
 * running ref'd work scheduled by a successfully evaluated module.
 * Returns true when a default/listener-crashing unhandled rejection
 * already selected and reported exit status 1. */
bool scr_loop_run(ScrPromise *top_level);
/* External I/O hook, polled at loop quiescence like the child registry:
 * `pending` keeps the loop alive; `poll` makes progress and may SLEEP up
 * to max_wait_ms (on real fds — socket readiness wakes it early), so the
 * loop skips its own nanosleep for that turn. One registrant: the dynamic
 * island (engine promise jobs + in-flight fetch transfers). Static builds
 * never set it. */
void scr_loop_set_io(bool (*pending)(void), void (*poll)(double max_wait_ms));
bool scr_report_unhandled_rejections(void); /* true = exit 1 */
void scr_discard_unhandled_rejections(void);
/* The island's unhandled-rejection ledger joins the report above (one
 * registrant, set at engine boot; static builds never set it): called with
 * print=true when the static ledger reported nothing, prints its FIRST
 * never-observed rejection in the same voice, frees the ledger either way,
 * and returns whether it had any. */
void scr_loop_set_island_rejections(bool (*fn)(bool print),
                                    int (*drain_jobs)(void));
/* The island's earliest armed timer deadline (scr_island_timers_deadline;
 * HUGE_VAL when none) joins the loop's sleep computation: an armed
 * AbortSignal.timeout must fire on time while the loop sleeps on socket
 * readiness, without keeping the loop alive by itself (Node's unref'd
 * timer). One registrant, set at engine boot; static builds never set it. */
void scr_loop_set_island_deadline(double (*fn)(void));
long scr_abandoned_fiber_count(void);
/* True while executing on an async fiber (vs the main stack) — the island
 * sizes its engine stack budget per stack (see scr_island.c). */
bool scr_on_fiber(void);
/* Identity of the running fiber (NULL on the main stack) — the island's
 * stack-anchor bookkeeping tells STACKS apart, not just fiber-vs-main
 * (a host callback may spawn a fiber that re-enters the engine). */
void *scr_fiber_self(void);
void scr_note_abandoned_fibers(long n); /* scr_console.c owns the flag */

/* new Promise(executor): kind 0 f64, 1 bool, 2 str, 3 void; ref-kind
 * resolve thunks are emitted (they know the concrete RC helpers) over
 * scr_resolve_ref_impl, constructed via scr_make_resolve_fn. The
 * executor runs synchronously; an escaping throw rejects the promise. */
ScrClosure *scr_make_resolve(ScrPromise *p, int kind);
ScrClosure *scr_make_resolve_fn(ScrPromise *p, void *fn);
void scr_resolve_ref_impl(ScrClosure *self, void *v, void *(*retain)(void *), void (*release)(void *), ScrTraceFn trace);
/* The reject closure: `(reason: Error) => void` — stores the reason as a
 * SCR_EXC_OBJ payload (the thrown-Error representation) and wakes waiters;
 * a reject after any settle is a no-op (first settle wins, exactly JS). */
ScrClosure *scr_make_reject(ScrPromise *p);
void scr_promise_run_executor(ScrPromise *p, ScrClosure *exec, ScrClosure *resolve);
void scr_promise_run_executor0(ScrPromise *p, ScrClosure *exec);
void scr_promise_run_executor2(ScrPromise *p, ScrClosure *exec, ScrClosure *resolve, ScrClosure *reject);

/* The promise a fiber settles (borrowed) — the emitted trampolines fulfill
 * through it. */
ScrPromise *scr_fiber_promise(ScrFiber *f);

/* ── sync generators (function*) ──────────────────────────────────────
 * A generator is a refcounted handle (ScrGen) over a fiber created
 * SUSPENDED — nothing runs until the first resume — plus three
 * type-erased value slots (kind + payload + release fn, the exception
 * cell's technique): OUT (the yielded value, or the completion value once
 * done), IN (the `.next(v)` argument), and RET (a parked `.return(v)`
 * value, promoted to OUT by the trampoline when the GENRET unwind
 * completes). The emitted code is type-directed: setters/takes move
 * ownership (+1 in, +1 out); a NONE slot is JS's undefined.
 *
 * Resume protocol (consumer side, synchronous — no event loop):
 * - scr_gen_resume: `.next()`. Starts or resumes the fiber and returns
 *   when it yields or completes. A body exception (or an injected
 *   `.throw`) moves into the CALLER's cell — the emitted pending check
 *   after the resume propagates it. Resuming a RUNNING generator throws
 *   Node's TypeError; resuming a DONE one is a no-op (OUT stays NONE —
 *   `{ value: undefined, done: true }`).
 * - scr_gen_resume_return: `.return(v)` with v already parked in RET.
 *   UNSTARTED/DONE: the body never runs (the unstarted fiber tears down,
 *   its argpack dropped); RET promotes to OUT. SUSPENDED: the GENRET
 *   sentinel enters the fiber's cell and the fiber resumes — finallys
 *   run; a finally that YIELDS parks the sentinel (done stays false; a
 *   later resume continues the unwind); a finally that THROWS replaces it.
 * - scr_gen_resume_throw: `.throw(e)` with e pending in the CALLER's cell
 *   (the emitted scr_throw_* just ran). SUSPENDED: the payload moves into
 *   the fiber's cell and the fiber resumes — the body's own try/catch
 *   sees it. UNSTARTED/DONE: the generator becomes done and the payload
 *   stays pending in the caller (the `.throw` call itself throws).
 *
 * Abandonment: releasing a SUSPENDED generator leaks its fiber
 * deliberately (unwinding would run user finallys Node's GC never runs);
 * the fiber stays in the live count, so programs that abandon one get the
 * abandoned-fiber RC-audit note (the loop-exhaustion story). An UNSTARTED
 * generator tears down cleanly: drop_args releases the packed arguments.
 */
typedef struct ScrGen ScrGen;

ScrGen *scr_gen_new(void (*entry)(ScrFiber *, void *), void *argpack,
                     void (*drop_args)(void *));
ScrGen *scr_gen_retain(ScrGen *g);
void scr_gen_release(ScrGen *g); /* NULL-tolerant */
void *scr_gen_retain_v(void *g);
void scr_gen_release_v(void *g);

void scr_gen_resume(ScrGen *g);
void scr_gen_resume_return(ScrGen *g);
void scr_gen_resume_throw(ScrGen *g);
bool scr_gen_done(ScrGen *g);

/* IN slot (consumer stores before resume; body takes after the yield). */
void scr_gen_in_f64(ScrGen *g, double v);
void scr_gen_in_bool(ScrGen *g, bool v);
void scr_gen_in_ref(ScrGen *g, void *v, void (*release)(void *)); /* moves */
void scr_gen_in_none(ScrGen *g);
double scr_gen_take_in_f64(void); /* body side: the running fiber's gen */
bool scr_gen_take_in_bool(void);
void *scr_gen_take_in_ref(void); /* +1 moved out; NONE → NULL */

/* RET slot (consumer parks the `.return(v)` value before resume_return). */
void scr_gen_ret_f64(ScrGen *g, double v);
void scr_gen_ret_bool(ScrGen *g, bool v);
void scr_gen_ret_ref(ScrGen *g, void *v, void (*release)(void *)); /* moves */
void scr_gen_ret_none(ScrGen *g);

/* OUT slot (body yields / the emitted trampoline completes; consumer
 * takes after resume). The no-gen-argument yield forms run on the CURRENT
 * fiber's generator and switch back to the resumer; control returns when
 * the consumer resumes again (the emitted pending check right after sees
 * an injected .throw payload or the GENRET sentinel). */
void scr_gen_yield_f64(double v);
void scr_gen_yield_bool(bool v);
void scr_gen_yield_ref(void *v, void (*release)(void *)); /* moves */
void scr_gen_out_f64(ScrGen *g, double v); /* trampoline completion stores */
void scr_gen_out_bool(ScrGen *g, bool v);
void scr_gen_out_ref(ScrGen *g, void *v, void (*release)(void *)); /* moves */
bool scr_gen_out_has(ScrGen *g); /* false = undefined completion value */
double scr_gen_take_out_f64(ScrGen *g);
bool scr_gen_take_out_bool(ScrGen *g);
void *scr_gen_take_out_ref(ScrGen *g); /* +1 moved out; NONE → NULL */

/* The trampoline's GENRET epilogue: true iff the sentinel is pending in
 * the ACTIVE cell (also the emitted catch-prologue test in generator
 * bodies). ret_to_out promotes the parked return value to the completion
 * value. gen_of answers the generator a fiber belongs to (borrowed). */
bool scr_exc_genret_pending(void);
void scr_gen_ret_to_out(ScrGen *g);
ScrGen *scr_gen_of_fiber(ScrFiber *f);

#ifdef SCR_RC_AUDIT
long scr_promise_live_count(void);
#endif

/* ── fetch (scr_fetch.c) ──────────────────────────────────────────────
 * The native bridge over scr_net + scr_tls + scr_http's client parser.
 * Static fetch(url) resolves at the response head with native Response
 * and ReadableStream handles; Response.json consumes that same stream.
 * AbortSignal and streaming request bodies stay native too. Under
 * --dynamic the same TU boots the broader engine web surface. The
 * emitted main calls scr_fetch_install in either form. */
void scr_fetch_install(void);
ScrPromise *scr_fetch_static(ScrStr *url, ScrDyn *init); /* +1 promise<Response handle> */
ScrDyn *scr_fetch_response_new(ScrDyn *body, ScrDyn *init); /* borrowed args; +1 Response handle or NULL pending */
ScrPromise *scr_fetch_response_json(ScrDyn *response); /* +1 promise<dyn> */
ScrPromise *scr_fetch_response_text(ScrDyn *response); /* +1 promise<dyn> */
ScrPromise *scr_fetch_response_bytes(ScrDyn *response); /* +1 promise<dyn> */
ScrDyn *scr_fetch_abort_controller_new(void); /* +1 AbortController handle */
/* Borrowed number; +1 AbortSignal handle or NULL pending. */
ScrDyn *scr_fetch_abort_timeout(ScrDyn *delay);
ScrDyn *scr_fetch_abort_now(ScrDyn *reason); /* borrowed reason; +1 handle */
ScrDyn *scr_fetch_abort_any(ScrDyn *signals); /* borrowed array; +1 handle or NULL pending */
ScrDyn *scr_fetch_stream_new(ScrDyn *source); /* borrowed source; +1 handle or NULL pending */
ScrDyn *scr_fetch_stream_from(ScrDyn *iterable); /* borrowed iterable; +1 handle or NULL pending */
ScrDyn *scr_fetch_stream_from_array(
    ScrArr *iterable,
    ScrDyn *(*item)(ScrArr *, double)); /* borrowed array/callback; +1 handle */
ScrDyn *scr_fetch_stream_from_bytes(
    ScrBytes *iterable); /* borrowed bytes; +1 handle */
ScrDyn *scr_fetch_stream_from_string(
    ScrStr *iterable); /* borrowed string; +1 handle */
ScrPromise *scr_fetch_reader_read(ScrDyn *reader); /* borrowed handle; +1 */

/* ── dynamic island (scr_island.c; --dynamic builds ONLY) ────────────
 * The embedded QuickJS-ng engine. Compiled and linked only under
 * -DSCR_DYNAMIC; static builds never reference these symbols (nor the
 * engine headers — this block deliberately names no engine type). One
 * runtime+context per process, created lazily on first entry, torn down
 * at exit before the RC audit; every entry re-anchors the engine's
 * stack-overflow check so calls from ucontext fibers are safe. Not
 * reentrant from engine callbacks.
 */
#ifdef SCR_DYNAMIC
/* Evaluate UTF-8 source in the island's global scope; returns
 * String(result) as a +1 ScrStr. Borrows code. An island exception is
 * bridged into the exception cell as a catchable string ("TypeError:
 * boom" — String(e)) and NULL comes back — callers are compiler-emitted
 * pending checks (may-throw, like the fs.* surface). */
ScrStr *scr_island_eval(ScrStr *code);

/* The libregexp opaque for scr_regex.c (--dynamic builds share the engine
 * archive's libregexp, whose host hooks want the island's JSContext):
 * lazily boots the engine and re-anchors its stack check, then hands the
 * context out as an opaque pointer. */
void *scr_island_lre_opaque(void);

/* ── embedded npm modules ─────────────────────────────────────────────
 * npm package code is embedded into the binary at BUILD time: the emitted
 * C carries every reached module's source as a static string plus the
 * (importer, specifier) → target resolution edges, and registers both
 * tables at the top of main. The island's module loader and its CommonJS
 * require shim resolve exclusively from these tables — binaries never
 * read node_modules at runtime. Edge targets are module keys or "node:*"
 * builtins, which the island shims (events, path, process, fs stubs,
 * child_process stubs). */
typedef struct ScrIslandModule {
  const char *key; /* resolved path — the loader's cache key */
  /* UTF-8 source — or raw-DEFLATE bytes when src_raw > 0 (the emitter
   * compresses big module texts; the loader inflates LAZILY at first
   * load through the inflater the emitted main installs, so a module a
   * run never loads never inflates — and its pages never fault in). */
  const char *src;
  size_t len;      /* byte length of src AS STORED */
  size_t src_raw;  /* 0: src is plain text; else the inflated byte length */
  int format; /* 0 = ESM, 1 = CommonJS, 2 = JSON */
  /* CommonJS only: the ESM facade the loader evaluates when an ES module
   * imports this file — default (module.exports itself) plus the named
   * exports LEXED from the source at BUILD time with the compiler's port
   * of Node's vendored CJS lexer. NULL for ESM sources (compiled
   * natively) and JSON (default-only wrapper, like Node). The same
   * compression contract as src, via esm_raw. */
  const char *esm;
  size_t esm_len;
  size_t esm_raw;
} ScrIslandModule;

typedef struct ScrIslandEdge {
  const char *from;
  const char *spec;
  const char *to;
  /* Which call forms this resolution serves — Node picks the "exports"
   * condition set from the CALL FORM, so a dual package embeds TWO edges
   * for one (from, spec): its "import" condition's target behind kind 1
   * and its "require" condition's behind kind 2. 0 answers both lookups
   * (relative files, builtins). */
  int kind; /* 0 = any, 1 = import, 2 = require */
} ScrIslandEdge;

/* Registers the emitted tables (static data; no copy, no engine boot).
 * Must run before any island entry that imports — main calls it right
 * after scr_lib_init. */
void scr_island_modules(const ScrIslandModule *mods, size_t nmods,
                         const ScrIslandEdge *edges, size_t nedges);

/* The inflater for compressed embedded module text (raw DEFLATE, exact
 * inflated size known from the table row). The emitted main installs
 * scr_zlib.c's scr_zlib_inflate_exact exactly when some module compressed
 * at build time — index.ts links scr_zlib.c/libz on the same predicate,
 * so compression-free builds keep their link line and the island keeps no
 * zlib reference of its own. */
void scr_island_set_inflate(bool (*inflate)(const unsigned char *src, size_t src_len,
                                            unsigned char *dst, size_t dst_len));
/* scr_zlib.c: one-shot raw-DEFLATE inflate into a caller-sized buffer;
 * true only when the stream ends exactly at dst_len. */
bool scr_zlib_inflate_exact(const unsigned char *src, size_t src_len,
                            unsigned char *dst, size_t dst_len);

/* The island process shim's implicit exit status (process.exitCode):
 * Node's set-it-and-return-normally contract. The emitted main returns
 * this after the loop drains; 0 when never set. The version advances on
 * every assignment so an exit listener can override a provisional status. */
int scr_island_exit_code(void);
size_t scr_island_exit_code_version(void);

/* ── web-platform globals (scr_web.c) ─────────────────────────────────
 * The pure-JS prelude defining the island's WHATWG subset (streams et
 * al.), evaluated at engine boot before any embedded module. `jsctx` is
 * the island's JSContext as an opaque pointer — engine types stay out of
 * this header. */
void scr_island_web_boot(void *jsctx);

/* Runs the engine's pending promise-reaction jobs to exhaustion (no-op
 * before the engine boots). Returns the number executed. The loop's io
 * hook drains through this so island async chains progress at quiescence,
 * exactly where Node runs its microtasks. */
int scr_island_drain_jobs(void);

/* Re-anchors the engine's stack-overflow check to the CURRENT stack (the
 * every-island-entry rule) — for units entering the engine from loop
 * dispatch stations (the fetch bridge's net callbacks) rather than
 * through an emitted island op. */
void scr_island_host_enter(void);

/* Bridges the engine's CURRENT pending exception into the scriptc
 * pending cell (the island timer bridge fires engine callbacks from the
 * static heap; a throw there must become the loop's uncaught report). */
void scr_island_bridge_exception(void);

/* ── island timers (scr_web.c) ────────────────────────────────────────
 * The machinery behind AbortSignal.timeout: one-shot engine callbacks
 * armed by the web prelude's host.timer. Deliberately UNREF'd, like
 * Node's AbortSignal.timeout timer — an armed timer never keeps the loop
 * alive; it fires only if other work (a live transfer, engine jobs) keeps
 * the process running, and the island's io hook caps its sleeps at the
 * earliest deadline so a fetch timeout fires on time. Deadlines are on
 * the scr_now_ms clock; _deadline returns HUGE_VAL when none are armed.
 * Teardown frees unfired callbacks so the engine audit stays zero. */
double scr_island_timers_deadline(void);
bool scr_island_timers_due(void);
bool scr_island_timers_fire_due(void); /* true = fired at least one */
void scr_island_timers_teardown(void);

/* ── dynamic fetch hooks ──────────────────────────────────────────────
 * The native bridge registers NO pending/poll hooks (its
 * transfers live on real sockets the loop's poller sleeps on); the curl
 * reference implementation (scr_fetch_curl.c, SCRIPTC_FETCH_CURL=1 —
 * one release as the flip's reference) still registers all four so the
 * loop can sleep on curl's fds. */
void scr_island_set_fetch(void (*boot)(void *jsctx), bool (*pending)(void),
                           void (*poll)(double max_wait_ms), void (*teardown)(void));

/* ── the island's node:http/https client bridge (scr_net_island.c) ────
 * The one TU referencing BOTH the socket units and the island (the
 * scr_zlib_island.c precedent): cc.ts compiles it exactly when a
 * --dynamic build links the socket units, and the emitted main calls
 * scr_net_island_install before any island entry. `attach` runs while
 * the island builds its bootstrap host object (jsctx and host_obj are
 * the engine's context and host-object pointers, opaque here — engine
 * types stay out of this header) and adds the bridge's host functions; `teardown`
 * frees engine values still held by in-flight requests before the
 * engine dies, the fetch-teardown story. Without the bridge the island
 * keeps its "does not provide the 'node:http' builtin" refusal. */
void scr_island_set_netmod(void (*attach)(void *jsctx, void *host_obj), void (*teardown)(void));
void scr_net_island_install(void);

/* ── island value handles (the `any` runtime type) ────────────────────
 * A ScrJsval is an ordinary refcounted scriptc heap cell owning ONE
 * engine value. It is opaque here (the engine's value type must not leak
 * into static-build translation units) and deliberately NOT
 * cycle-collector-traced: its internal references live in the engine's
 * own GC world, and cycles that cross the boundary are documented as
 * uncollectable (SEMANTICS.md). Releasing the last reference frees the
 * engine value — or only the cell itself after engine teardown (the
 * engine frees every value it still owns when it goes down, so a
 * post-teardown release must not touch it).
 *
 * Conventions, mirroring the rest of the runtime: operands are BORROWED,
 * refcounted results come back owned (+1). Fallible operations bridge
 * the engine exception into the exception cell (catchable) and report
 * failure via NULL (pointer results) or -1 (int results) — callers are
 * compiler-emitted pending checks. Every entry re-anchors the engine's
 * stack check, so all of these are fiber-safe. */
typedef struct ScrJsval ScrJsval;

ScrJsval *scr_jsval_retain(ScrJsval *v);
void scr_jsval_release(ScrJsval *v);
void *scr_jsval_retain_v(void *v);
void scr_jsval_release_v(void *v);

/* Binary operator codes for scr_jsval_binop / scr_jsval_cmp. The JS
 * semantics (ToPrimitive, coercion) come from prelude helper closures
 * evaluated at island init, not from C reimplementations. */
#define SCR_JSOP_ADD 0
#define SCR_JSOP_SUB 1
#define SCR_JSOP_MUL 2
#define SCR_JSOP_DIV 3
#define SCR_JSOP_MOD 4
#define SCR_JSOP_POW 5
#define SCR_JSOP_LT 6
#define SCR_JSOP_LE 7
#define SCR_JSOP_GT 8
#define SCR_JSOP_GE 9
#define SCR_JSOP_EQ 10  /* strict === */
#define SCR_JSOP_NEQ 11 /* strict !== */
#define SCR_JSOP_COUNT 12

/* Marshal in (static → island). Each returns a fresh +1 cell. from_str
 * borrows s; from_json borrows JSON text produced by the emitted
 * type-directed serializers (a DEEP COPY into the island — the documented
 * aliasing divergence) and cannot fail on that trusted input. */
ScrJsval *scr_jsval_from_f64(double v);
ScrJsval *scr_jsval_from_bool(bool v);
ScrJsval *scr_jsval_from_str(const ScrStr *s);
ScrJsval *scr_jsval_from_json(const ScrStr *json);
/* A CHECKED-DYNAMIC (dyn) value entering the island — deep copy for data
 * kinds (a boxed handle/promise throws the catchable TypeError). A JSVAL
 * node unwraps to its OWN cell (+1) — an engine value that crossed into
 * the checked-dynamic tree and back is the SAME engine value, by reference (nested JSVAL
 * members embed their engine values directly). A boxed FUNCTION crosses
 * as one generic host-function shim over its uniform ScrDynThunk: the
 * shim wraps engine arguments as dyn values (scalar-normalizing), calls
 * the thunk, and converts the dyn result back — each crossing mints a
 * fresh engine function (identity is not preserved for re-crossings;
 * SEMANTICS.md). NULL with a pending exception on failure. Borrows d. */
ScrJsval *scr_jsval_from_dyn(const ScrDyn *d);

/* The jsval→dyn crossing (the IR's dynFromJsval): wraps an island value
 * as a SCR_DYN_JSVAL node, SCALAR-NORMALIZING first — engine numbers/
 * strings/booleans/null/undefined convert to the native dyn kinds (the
 * strict exits cannot fail on engine-reported scalars), so JSVAL nodes
 * only ever hold engine objects/arrays/functions (and the symbol/bigint
 * edge). Installs the checked-dynamic tree's engine-routing ops on first use. Borrows
 * the cell (retains it into the node); +1 out; never throws. */
ScrDyn *scr_dyn_from_jsval(ScrJsval *cell);

/* Engine operations. Arithmetic yields a fresh cell (NULL = bridged);
 * comparisons yield 0/1 (-1 = bridged); truthy/not never fail. */
ScrJsval *scr_jsval_binop(int op, ScrJsval *a, ScrJsval *b);
int scr_jsval_cmp(int op, ScrJsval *a, ScrJsval *b);
/* `v instanceof C` in the engine (JS_IsInstanceOf — the spec operator,
 * Symbol.hasInstance included). 0/1; -1 = bridged (non-object RHS throws
 * the engine's own TypeError, catchably). */
int scr_jsval_instance_of(ScrJsval *v, ScrJsval *c);
ScrJsval *scr_jsval_neg(ScrJsval *a);
/* GetIterator over an island value (the for-of head over 'any'): the
 * engine's protocol lookup; NULL + pending TypeError when not iterable. */
ScrJsval *scr_jsval_iter_new(ScrJsval *a);
ScrJsval *scr_jsval_plus(ScrJsval *a); /* unary + (ToNumber) */
int scr_jsval_truthy(ScrJsval *a);
ScrStr *scr_jsval_typeof(ScrJsval *a);
ScrStr *scr_jsval_to_str(ScrJsval *a); /* String(v); NULL = bridged */

/* Property/element access and calls. Names are NUL-terminated ScrStr
 * (identifier property names from source); computed keys are jsvals. */
ScrJsval *scr_jsval_get_prop(ScrJsval *o, const ScrStr *name);
ScrJsval *scr_jsval_global_get(const ScrStr *name);
int scr_jsval_set_prop(ScrJsval *o, const ScrStr *name, ScrJsval *v);
ScrJsval *scr_jsval_get_idx(ScrJsval *o, ScrJsval *key);
/* Destructuring guards over island values: RequireObjectCoercible with
 * V8's exact TypeError text (pass-through result, +1), and GetIterator +
 * the pattern's width as a fresh engine array (undefined-padded,
 * IteratorClose per spec); both throw catchably, NULL + pending on throw. */
ScrJsval *scr_jsval_destr_check(ScrJsval *v, const char *spell, const char *first);
ScrJsval *scr_jsval_iter_n(ScrJsval *v, double n);
int scr_jsval_set_idx(ScrJsval *o, ScrJsval *key, ScrJsval *v);
ScrJsval *scr_jsval_call_method(ScrJsval *o, const ScrStr *name, int argc, ScrJsval **argv);
ScrJsval *scr_jsval_call_this(ScrJsval *f, ScrJsval *receiver, int argc, ScrJsval **argv);
/* `o.name?.(...)`: a nullish member answers the engine's undefined;
 * anything else calls with this = o (non-callables throw in the engine). */
ScrJsval *scr_jsval_opt_call_method(ScrJsval *o, const ScrStr *name, int argc, ScrJsval **argv);
ScrJsval *scr_jsval_call(ScrJsval *f, int argc, ScrJsval **argv);
/* Spread application on an island callee — `f(...pre, ...spread)` through
 * the prelude helper's REAL spread syntax (iterator protocols are the
 * engine's own; the guards front-run V8's exact spread-call TypeError
 * texts). `pre` is the engine array of leading fixed arguments; `what` the
 * spread expression's source spelling (the nullish text spells it).
 * Borrows everything; +1 out, or NULL with the exception bridged. */
ScrJsval *scr_jsval_call_spread(ScrJsval *f, ScrJsval *pre, ScrJsval *spread, const ScrStr *what);
/* `new X(...)` on an island callee (jsOp construct) — JS_CallConstructor.
 * Borrows everything; +1 out, or NULL with the exception bridged. */
ScrJsval *scr_jsval_construct(ScrJsval *f, int argc, ScrJsval **argv);

/* A scriptc closure entering the island as an engine function (the
 * package-callback pattern: `.action((a, b) => ...)`). `adapt` is the
 * compiler-emitted per-signature adapter — one uniform shape over the
 * closure ABI: borrowed argument cells in (the closure ABI consumes its
 * params, so the adapter retains them), the +1 result cell (or NULL for
 * void) out. The wrapper retains the closure; the engine finalizer
 * releases it (before the RC audit — teardown precedes it). Calls from
 * the engine pad missing arguments with undefined and drop surplus, like
 * any JS call; a scriptc exception thrown inside reverse-bridges to an
 * engine throw (strings stay strings — the two bridges round-trip). */
ScrJsval *scr_jsval_from_closure(ScrClosure *c, int arity,
                                  ScrJsval *(*adapt)(ScrClosure *, ScrJsval **));

/* True iff the cell holds the engine's undefined — the TYPED host-call
 * adapters ask before converting a `T | undefined` parameter (an absent
 * or undefined engine argument takes the undefined arm; anything else
 * converts through the exit machinery). */
bool scr_jsval_is_undefined(ScrJsval *v);

/* Optional chains on island values: the nullish test on the HANDLE
 * (`x?.y` on 'any' — undefined OR null short-circuits, JS-exact) and the
 * engine's own undefined/null as +1 cells (the unit path's result, and
 * the union lift's unit arms). All infallible. */
bool scr_jsval_is_nullish(ScrJsval *v);
ScrJsval *scr_jsval_undefined(void);
ScrJsval *scr_jsval_null(void);

/* Non-JSON marshals IN: a URL crosses as an engine URL instance built
 * from its href (the first call installs a minimal island URL class when
 * no global exists — construction re-parses through scr_url.c's WHATWG
 * parser; href/protocol/pathname readable, other components throw, see
 * SEMANTICS.md). Borrows; +1 cell out, or NULL with the exception
 * bridged. scr_jsval_from_bytes is its typed-array sibling — declared
 * with the bytes surface below. */
ScrJsval *scr_jsval_from_url(ScrUrl *u);

/* Payload tags for scr_jsval_from_promise — the fulfillment types an
 * async island callback may resolve with (the compiler fences the rest). */
enum {
  SCR_ISLP_VOID = 0,
  SCR_ISLP_F64 = 1,
  SCR_ISLP_BOOL = 2,
  SCR_ISLP_STR = 3,
  SCR_ISLP_JSVAL = 4,
  /* Promise<any[]> — the fulfillment is a native array of engine cells
   * (the jsval-element-array spelling): it re-enters the engine as a
   * fresh engine array whose ELEMENTS are the same engine values (the
   * loadPlugins shape: identity crosses, the spine is a copy). */
  SCR_ISLP_JSVAL_ARR = 5,
};

/* Wrap a scriptc promise as an ENGINE promise (async callbacks crossing
 * into the island: the package sees a real thenable). Takes ownership of
 * `p` (+1 moves in). A waiter fiber awaits it and settles the engine
 * capability when it settles — fulfillment marshals per `payload`
 * (SCR_ISLP_*), rejection reverse-bridges the reason (Errors cross as
 * real engine Errors). The await OBSERVES a rejection for the static
 * ledger, and the engine's rejection tracker takes over for the wrapper
 * promise — one report, one voice, whichever world drops the ball.
 * Wrappers still pending at teardown free their engine values then (the
 * island audit sees zero live allocations). NULL only if the engine
 * cannot mint a capability (exception bridged). */
ScrJsval *scr_jsval_from_promise(ScrPromise *p, int payload);

/* The REVERSE bridge: an ENGINE promise (a package call's jsval whose
 * declared type is Promise<T>) settles a fresh STATIC promise, so
 * `await pkgCall()` parks a fiber and `.catch/.finally` desugar over it.
 * Borrows `v`; the +1 result is pending until the engine promise settles
 * (subscription is Promise.resolve(v).then(onF, onR) through a pinned
 * prelude helper — thenables and plain values behave like `await`).
 * Fulfillment stores the retained value cell (SCR_ISLP_JSVAL) or nothing
 * (SCR_ISLP_VOID; the compiler passes no other tags); rejection converts
 * the reason exactly like a bridged exception (engine Errors become
 * ScrErrors picked by name) and rejects — re-thrown at the await,
 * ledger-tracked if never observed. The .then marks the engine promise
 * HANDLED for the island's rejection tracker, so exactly one world
 * reports a dropped rejection. Bridging the same engine promise twice
 * just makes two static observers of one settlement. NULL only on an
 * engine-level surprise minting the subscription (exception bridged). */
ScrPromise *scr_jsval_bridge_promise(ScrJsval *v, int payload);

/* Island-native literals: build an object from key/value pairs (keys are
 * marshaled strings) or an array from elements. Borrow argv; +1 out.
 * Cannot fail (allocation failure aborts, like every runtime OOM). */
ScrJsval *scr_jsval_obj_lit(int npairs, ScrJsval **kv);
/* Getter completion for an island literal: defines `key` on `obj` as an
 * engine getter invoking `fn`; answers the object retained (+1). */
ScrJsval *scr_jsval_define_getter(ScrJsval *obj, ScrJsval *key, ScrJsval *fn);
/* The engine TemplateStringsArray for an island tag call: n cooked then n
 * raw strings; the result array carries `.raw` (+1). */
ScrJsval *scr_jsval_tpl_strings(int n, ScrJsval **kv);
/* Spread completion for an island literal: engine CopyDataProperties of
 * `src` onto `obj`; answers the target (+1), NULL + pending on a getter
 * throw. */
ScrJsval *scr_jsval_obj_spread(ScrJsval *obj, ScrJsval *src);
ScrJsval *scr_jsval_arr_lit(int n, ScrJsval **elems);

/* Marshal out (island → static): validated, STRICT extraction — a
 * non-number refuses to exit as number (no coercion), throwing a
 * catchable path-less TypeError like the dynCheck walkers'. Composite
 * targets exit via scr_jsval_to_json + the existing json.parse +
 * dynCheck pipeline instead (to_json throws if the value is not
 * JSON-representable, e.g. contains a function). */
int scr_jsval_exit_f64(ScrJsval *v, double *out);
int scr_jsval_exit_bool(ScrJsval *v, bool *out);
ScrStr *scr_jsval_exit_str(ScrJsval *v);
/* Uint8Array exit (engine Buffers pass — they ARE Uint8Arrays): a fresh
 * u8 COPY (+1), the boundary's aliasing stance; NULL = thrown. */
ScrBytes *scr_jsval_exit_bytes(ScrJsval *v);
/* `any[]`-declared slot exit (the jsval-element-array spelling):
 * Array.isArray-gated, elements BY REFERENCE into a native array of
 * engine cells (identity crosses, the spine is a snapshot copy). +1;
 * NULL = thrown. */
ScrArr *scr_jsval_exit_jsval_arr(ScrJsval *v);
ScrStr *scr_jsval_to_json(ScrJsval *v);

/* The import boundary (libCall island.import): loads an embedded module —
 * the package's runtime entry — through the island's module system and
 * takes one export as an owned (+1) jsval. `name` is an export name,
 * "default", or "*" (the namespace object; for CommonJS entries, an
 * interop object over module.exports). The engine's module registry (and
 * the require shim's cache) make repeated imports lookups, not
 * re-evaluations. `specifier` is the specifier as WRITTEN at the import
 * site: an ESM entry that does not provide a requested named export
 * throws Node's link-time SyntaxError naming it ("The requested module
 * 'x' does not provide an export named 'y'"). Borrows all args. NULL =
 * bridged exception (a package's top-level code can throw). */
ScrJsval *scr_jsval_import(const ScrStr *key, const ScrStr *name, const ScrStr *specifier);

/* Dynamic import() (libCall island.importDyn): loads a module — an
 * embedded module's key or a builtin shim's "node:x" key — through the
 * island's module system and answers an owned (+1) jsval holding an
 * ENGINE PROMISE of the namespace object. ALWAYS a promise: load and
 * evaluation failures REJECT it (Node's dynamic-import shape). Borrows
 * the key. NULL only on an engine-level surprise minting the rejected
 * promise. */
ScrJsval *scr_jsval_import_dyn(const ScrStr *key);

/* The deferred boundary failure (libCall island.castFail): throws a
 * catchable TypeError naming the target type — a checked cast of an
 * island value to a type with no validated exit fails at RUNTIME, at the
 * cast, instead of refusing the build. Borrows both args; the exception
 * is pending on return. */
void scr_jsval_cast_fail(ScrJsval *v, const ScrStr *target);
#endif /* SCR_DYNAMIC */

/* ── numbers ────────────────────────────────────────────────────────────
 * JS-exact Number-to-string (ECMA-262 §6.1.6.1.20 Number::toString, radix
 * 10): shortest digit string that round-trips, ECMA placement rules.
 * Writes NUL-terminated result into buf (>= 32 bytes), returns length.
 */
size_t scr_f64_to_str(double x, char *buf);

/* The Ryū digit core (scr_number.c), shared with the Intl en-US number
 * formatter: the shortest round-tripping digits of a POSITIVE finite
 * double — value = 0.digits × 10^n, no trailing zeros, NUL-terminated.
 * Returns k, the digit count (≤ 17). */
int scr_f64_digits(double x, char digits[18], int *n_out);

/* ToString for template literals / string coercion. Returns +1. */
ScrStr *scr_f64_to_scrstr(double x);
ScrStr *scr_bool_to_scrstr(bool b); /* interned "true"/"false" */

/* ── String surface (scr_lib.c) ───────────────────────────────────────
 * fromCharCode: ONE packed f64[] of UTF-16 code units — ToUint16 each,
 * adjacent surrogate pairs combine, lone surrogates become U+FFFD
 * (divergence 1's policy). lastIndexOf: last occurrence as a UTF-16
 * index (-1 absent; empty needle finds the length). Borrowed args; the
 * string result is +1; neither throws. */
ScrStr *scr_str_from_char_code(ScrArr *codes);
/* The spread-typed-array form (String.fromCharCode(...bytes) — the
 * magic-number ASCII probe); same semantics per element. */
ScrStr *scr_str_from_char_code_bytes(ScrBytes *codes);
double scr_str_last_index_of(ScrStr *s, ScrStr *needle);

/* ── Number statics (scr_lib.c) ───────────────────────────────────────
 * JS-exact by construction: Number.isFinite/isNaN/isInteger/isSafeInteger
 * never coerce, and the compiler only routes f64-typed arguments here.
 * None throws. */
bool scr_num_is_finite(double x);
bool scr_num_is_nan(double x);
bool scr_num_is_integer(double x);
bool scr_num_is_safe_integer(double x);
/* Number.prototype formatters: toExponential() is the fraction-digits-free
 * shortest correctly-rounded mantissa; toFixed0 is the non-throwing omitted
 * argument form. toFixed implements an explicit 0..100 fractionDigits with
 * exact binary-value rounding and THROWS V8's catchable RangeError outside
 * that range. All successful results are +1. */
ScrStr *scr_num_to_exponential(double x);
ScrStr *scr_num_to_fixed0(double x);
ScrStr *scr_num_to_fixed(double x, double fraction_digits);

/* Object.is over two numbers — the spec's SameValue on doubles: NaN
 * equals NaN, +0 differs from -0, everything else is ==. Never throws. */
bool scr_num_same_value(double a, double b);

/* Intl.NumberFormat("en-US").format(x) / x.toLocaleString("en-US") with
 * default options: decimal notation, 0–3 fraction digits rounded half-up
 * on the shortest round-tripping decimal (ICU's rounding input — NOT
 * toFixed's exact-value rounding), "," grouping every three integer
 * digits, "∞"/"NaN" texts, "-0" for negative inputs rounding to zero.
 * en-US is the one embedded locale. Result +1; never throws. */
ScrStr *scr_intl_num_format_en_us(double x);

/* ── Date, the read-only value slice (scr_lib.c) ──────────────────────
 * A Date value is its TimeClip'd epoch-millisecond scalar. Identity and
 * mutation are frontend-fenced; construction, storage, getters, and ISO
 * formatting are exact over this representation. */
double scr_date_now(void); /* integer ms since epoch, like Node */
double scr_date_new_ms(double ms); /* TimeClip (NaN when invalid) */
double scr_date_get_time(double ms);
/* Node's exact ISO 8601 UTC format (expanded ±YYYYYY years outside
 * 0–9999). THROWS Node's "Invalid time value" RangeError on NaN or
 * |ms| > 8.64e15 and returns NULL; +1 otherwise. */
ScrStr *scr_date_to_iso(double ms);
/* new Date(dateString).getTime(): the BOUNDED parse (the X509 validity
 * shape + ECMA's format with an explicit offset); NaN elsewhere. */
double scr_date_parse_get_time(ScrStr *s);
/* Date.UTC over already-number arguments (frontend completes the spec's
 * defaults): MakeDay/MakeTime/TimeClip exactly — 0–99 maps to 1900+year,
 * month/date rollover, NaN for non-finite parts, out-of-range results,
 * and years past V8's ±1e6 MakeDay bound. Never throws. */
double scr_date_utc(double y, double mo, double d,
                    double h, double mi, double s, double ms);
double scr_date_get_full_year(double ms, bool utc);
double scr_date_get_month(double ms, bool utc);
double scr_date_get_date(double ms, bool utc);
double scr_date_get_day(double ms, bool utc);
double scr_date_get_hours(double ms, bool utc);
double scr_date_get_minutes(double ms, bool utc);
double scr_date_get_seconds(double ms, bool utc);
double scr_date_get_milliseconds(double ms);
double scr_date_get_timezone_offset(double ms);
/* One-argument ABI wrappers used by the LLVM lib-call table. */
double scr_date_get_full_year_local(double ms);
double scr_date_get_full_year_utc(double ms);
double scr_date_get_month_local(double ms);
double scr_date_get_month_utc(double ms);
double scr_date_get_date_local(double ms);
double scr_date_get_date_utc(double ms);
double scr_date_get_day_local(double ms);
double scr_date_get_day_utc(double ms);
double scr_date_get_hours_local(double ms);
double scr_date_get_hours_utc(double ms);
double scr_date_get_minutes_local(double ms);
double scr_date_get_minutes_utc(double ms);
double scr_date_get_seconds_local(double ms);
double scr_date_get_seconds_utc(double ms);

/* ── numeric coercion + bitwise operators ─────────────────────────────
 * JS-exact ToInt32/ToUint32 semantics: NaN/±Infinity → 0, truncation
 * toward zero, modular wrap into 32 bits; the operation runs in 32-bit
 * space (shift counts mask to 5 bits, `>>` is an arithmetic shift spelled
 * portably — no C UB/implementation-defined shifts) and the result
 * returns to f64: `>>>` as Uint32, everything else as Int32.
 * scr_to_uint32 lives in scr_number.c; the bitwise operations in scr_lib.c. */
uint32_t scr_to_uint32(double d);
double scr_bit_and(double a, double b);
double scr_bit_or(double a, double b);
double scr_bit_xor(double a, double b);
double scr_bit_shl(double a, double b);
double scr_bit_shr(double a, double b);
double scr_bit_ushr(double a, double b);
double scr_bit_not(double a);

/* ── typed arrays / Buffer (scr_bytes.c) ──────────────────────────────
 * ONE runtime representation for Uint8Array/Uint32Array/Float32Array,
 * Node's Buffer (a Uint8Array subclass), and DataView: a refcounted,
 * MUTABLE, fixed-length element buffer. An ScrBytes either OWNS its
 * storage (backing == NULL, byteOffset 0) or is a VIEW: its `data` points
 * INTO an owner's storage and its `backing` retains that owner (chain
 * depth is always exactly 1 — views over views resolve to the owner at
 * construction), so reads/writes through the view alias the source
 * JS-exactly. Views come from DataView (scr_dataview_new) and from
 * subarray()/Buffer-slice() (scr_bytes_subarray — Buffer's slice is
 * subarray's deprecated alias in Node); only the plain typed arrays'
 * slice() copies (scr_bytes_slice, matching JS).
 * Elements are scalars only and the backing edge is acyclic by
 * construction (owners point at nothing): never part of a cycle, no
 * trace. Element reads widen to double; writes coerce JS-exactly (ToUint8
 * / ToUint32 modular truncation, double→float rounding for f32).
 * Out-of-bounds ELEMENT access traps like arrays (JS returns undefined /
 * ignores the write — documented divergence); the Node-shaped operations
 * (construction lengths, set(), the read/write numeric families, the
 * DataView constructor and getters) THROW catchable RangeErrors exactly
 * where Node throws. */

typedef enum ScrBytesElem {
  SCR_BYTES_U8,  /* Uint8Array / Buffer */
  SCR_BYTES_U32, /* Uint32Array */
  SCR_BYTES_F32, /* Float32Array */
  SCR_BYTES_I32, /* Int32Array (reads sign-extend; writes ToInt32-wrap) */
} ScrBytesElem;

typedef struct ScrBytes {
  size_t rc;
  size_t len; /* ELEMENT count, fixed at construction */
  ScrBytesElem elem;
  uint8_t *data; /* len * elem_size bytes; owned unless backing is set */
  /* NULL for owners. A view (DataView, subarray, Buffer-slice) sets this
   * to the retained OWNER it aliases (chain depth is always exactly 1:
   * views over views resolve to the owner at construction) and its `data`
   * points into backing->data — released, never freed. */
  struct ScrBytes *backing;
} ScrBytes;

size_t scr_bytes_elem_size(ScrBytesElem elem); /* 1, 4, 4 */

/* node:string_decoder's StringDecoder (scr_bytes.c, beside the decoders
 * it shares): the decoder value is a record holding the CANONICAL
 * encoding name and an f64 packing the pending partial sequence (count +
 * up to 3 raw bytes — every encoding buffers at most 3); the compiler's
 * interned %strdec helpers thread both through these pure functions.
 * write answers the decoded complete prefix of pending+chunk, next the
 * packed new pending, end the buffered partial's flush (utf8 replacement
 * chars, base64's padded remainder, utf16le's held bytes; the stateless
 * latin1/ascii/hex flush nothing). Node-exact per encoding — utf8's
 * incomplete-tail walk, base64's mod-3 groups, utf16le's odd-byte and
 * trailing-lead-surrogate holds. None throws. */
ScrStr *scr_strdec_write(const ScrStr *enc, double pending, const ScrBytes *chunk);
double scr_strdec_next(const ScrStr *enc, double pending, const ScrBytes *chunk);
ScrStr *scr_strdec_end(const ScrStr *enc, double pending);

#ifdef SCR_DYNAMIC
/* Static → island typed-array marshal (scr_island.c; --dynamic builds
 * only): an engine typed array of the same element kind — a COPY, the
 * boundary's copy stance. Borrows; +1 cell, or NULL bridged. */
ScrJsval *scr_jsval_from_bytes(const ScrBytes *b);
#endif

/* `new Uint8Array(n)` / Buffer.alloc(n): zero-filled. n goes through
 * ToIndex like JS (NaN → 0, truncate toward zero; negative or > 2^53-1
 * THROWS Node's "Invalid typed array length" RangeError catchably and
 * returns NULL with the exception pending). */
ScrBytes *scr_bytes_new(ScrBytesElem elem, double n); /* +1 */

/* `new Uint8Array(src)` / Buffer.from(u8): a same-elem-kind copy (the
 * compiler fences cross-kind construction). Borrows src. Never throws. */
ScrBytes *scr_bytes_copy(const ScrBytes *src); /* +1 */

/* `new Uint8Array([1, 2, 3])` / Buffer.from(number[]): each f64 element
 * coerces per the element kind (ToUint8/ToUint32/float). Borrows arr
 * (SCR_ELEM_F64). Never throws. */
ScrBytes *scr_bytes_from_arr(ScrBytesElem elem, const ScrArr *arr); /* +1 */

static inline ScrBytes *scr_bytes_retain(ScrBytes *b) {
  if (b->rc != SIZE_MAX) b->rc++;
  return b;
}
void scr_bytes_release(ScrBytes *b); /* NULL-tolerant */
void *scr_bytes_retain_v(void *b);
void scr_bytes_release_v(void *b);
#ifdef SCR_RC_AUDIT
long scr_bytes_live_count(void);
#endif

double scr_bytes_len(const ScrBytes *b);      /* element count */
double scr_bytes_byte_len(const ScrBytes *b); /* len * elem size */

/* `.byteOffset`: 0 for owners (scriptc typed arrays always own their
 * whole storage — SEMANTICS.md notes the divergence from Node's Buffer
 * pooling), the view's offset into its owner's storage for a DataView. */
double scr_bytes_byte_offset(const ScrBytes *b);

/* `new DataView(src.buffer, byteOffset?, byteLength?)` — src is the bytes
 * value whose `.buffer` the program named (any elem kind; a DataView src
 * resolves to ITS owner, so offsets stay relative to the one buffer,
 * exactly like JS). Both indices go through ToIndex (NaN → 0, truncate
 * toward zero); a bad offset THROWS Node's "Start offset %s is outside
 * the bounds of the buffer" and a bad/overflowing length "Invalid
 * DataView length %s" (catchable RangeErrors, NULL result with the
 * exception pending). has_len distinguishes an omitted byteLength (view
 * to the end of the buffer) from an explicit one. Borrows src; the
 * result retains the owner. */
ScrBytes *scr_dataview_new(ScrBytes *src, double byte_off, bool has_len, double byte_len); /* +1 */

/* DataView getters. LE flag false = big-endian (the JS default). The
 * BIGU64/BIGI64 kinds answer the composed Number(view.getBigUint64/
 * getBigInt64(...)) lowering: the 8-byte integer converted to double
 * (round-to-nearest-even — exactly Number(bigint)). Offsets go through
 * ToIndex; any invalid or out-of-range offset THROWS Node's "Offset is
 * outside the bounds of the DataView" RangeError catchably (0 result
 * with the exception pending). */
typedef enum ScrDataViewGet {
  SCR_DV_U8, SCR_DV_I8, SCR_DV_U16, SCR_DV_I16, SCR_DV_U32, SCR_DV_I32,
  SCR_DV_F32, SCR_DV_F64, SCR_DV_BIGU64, SCR_DV_BIGI64,
} ScrDataViewGet;
double scr_dataview_get(const ScrBytes *b, double byte_off, ScrDataViewGet kind, bool le);

/* DataView setters (the integer/float kinds only — the BIG kinds never
 * lower: bigint arguments have no representation). Values coerce
 * JS-exactly: the integer kinds by modular truncation (ToUint32's residue
 * — the narrower widths store its low bytes, the same 2^width residue),
 * F32 by double→float round-to-nearest-even. Offsets go through ToIndex
 * with the getters' one RangeError. */
void scr_dataview_set(ScrBytes *b, double byte_off, double value, ScrDataViewGet kind, bool le);

/* Element read/write. Any invalid index — negative, fractional, NaN, or
 * out of bounds — TRAPS like the array runtime (SEMANTICS.md documents
 * the divergence from JS's undefined-read/ignored-write). Writes coerce
 * JS-exactly: u8/u32 by modular truncation (NaN/±Infinity → 0, truncate
 * toward zero, wrap mod 2^8/2^32), f32 by double→float rounding. */
double scr_bytes_get(const ScrBytes *b, double i);
void scr_bytes_set(ScrBytes *b, double i, double v);
/* Replace a live typed-array capsule's fixed-size payload from its dyn
 * snapshot. Source and target have the same compiler-checked bytes type. */
void scr_bytes_copy_contents(ScrBytes *dst, const ScrBytes *src);

/* TypedArray.prototype.slice(start, end): relative indices clamp like
 * string/array slice (ToIntegerOrInfinity, negatives from the end); the
 * result is a fresh same-kind copy. Never throws. */
ScrBytes *scr_bytes_slice(const ScrBytes *b, double start, double end); /* +1 */

/* ES2023 typed-array copying methods. Both preserve the receiver's element
 * kind and return a fresh +1 owner. with() raises Node's catchable
 * "Invalid typed array index" RangeError for an invalid relative index. */
ScrBytes *scr_bytes_to_reversed(const ScrBytes *b); /* +1 */
ScrBytes *scr_bytes_with(const ScrBytes *b, double index, double value); /* +1 */

/* Numeric typed-array iteration drained into number[], and Uint8Array.join.
 * Inputs borrowed; results fresh +1. */
ScrArr *scr_bytes_to_arr(const ScrBytes *b); /* +1 */
ScrStr *scr_bytes_join(const ScrBytes *b, const ScrStr *separator); /* +1 */

/* TypedArray.prototype.fill on non-u8 receivers: per-element fill with
 * the element write's coercion, slice-clamped relative indices; answers
 * the receiver +1 (chaining). Never throws. */
ScrBytes *scr_bytes_fill_elem(ScrBytes *b, double v, double start, double end); /* +1 */

/* TypedArray.prototype.subarray(start, end) — and Buffer's slice(), its
 * deprecated alias: a same-elem VIEW aliasing the receiver's storage
 * (mutations visible both ways, JS-exactly). The view retains the OWNER
 * (chain depth exactly 1, the DataView rule) and its byteOffset composes.
 * Same index clamping as slice; never throws. */
ScrBytes *scr_bytes_subarray(ScrBytes *b, double start, double end); /* +1 */

/* dst.set(src, offset): same-kind bulk copy (memmove — dst may be src).
 * offset goes through ToIntegerOrInfinity; a negative offset or
 * src.len + offset > dst.len THROWS Node's "offset is out of bounds"
 * RangeError catchably. */
void scr_bytes_set_from(ScrBytes *dst, const ScrBytes *src, double offset);

/* buf.toString(enc) on u8 bytes: "utf8" decodes with WHATWG per-maximal-
 * subpart U+FFFD replacement (Node-exact for invalid sequences), "hex" is
 * lowercase pairs, "base64"/"base64url" the standard/url alphabets (url
 * unpadded), "latin1" maps bytes to U+00XX, "ascii" masks to & 0x7f, and
 * "utf16le" decodes LE code units (surrogate pairs combine; a LONE
 * surrogate surfaces as U+FFFD — the documented divergence; an odd tail
 * byte drops). Aliases arrive NORMALIZED (the compiler folds "binary",
 * "ucs2", "utf-8", ...). Borrows both; +1 result. Never throws (the
 * compiler fences other encodings). */
ScrStr *scr_bytes_to_str(const ScrBytes *b, const ScrStr *enc);
ScrStr *scr_bytes_to_str_range(const ScrBytes *b, const ScrStr *enc, double start, double end);
/* Runtime-valued Buffer.toString encoding: aliases/case canonicalize;
 * unknown names throw ERR_UNKNOWN_ENCODING. +1, or NULL when throwing. */
ScrStr *scr_bytes_to_str_checked(const ScrBytes *b, const ScrStr *enc);
ScrStr *scr_bytes_to_str_checked_range(const ScrBytes *b, const ScrStr *enc, double start, double end);

/* WHATWG TextDecoder.decode over u8 bytes (utf-8, default options): the
 * same replacement decode as toString("utf8") with the leading BOM
 * stripped. Borrows; +1; never throws. */
ScrStr *scr_text_decode(const ScrBytes *b);

/* TextDecoder with a compile-time WHATWG legacy-encoding id. The frontend
 * owns label canonicalization and emits only the ids understood by
 * scr_bytes.c; keeping this separate from scr_text_decode means default
 * UTF-8 users do not retain the legacy mapping tables. Borrows; +1. */
ScrStr *scr_text_decode_legacy(const ScrBytes *b, double encoding);

/* Buffer.from(string, enc): "utf8" copies the bytes; "hex" parses pairs
 * and stops at the first invalid/odd tail (Node-lenient); "base64" and
 * "base64url" decode the standard AND url-safe alphabets, skipping
 * invalid bytes (Node-lenient); "latin1"/"ascii" write each UTF-16
 * unit's low byte (astral code points contribute their two surrogates');
 * "utf16le" writes LE code units, surrogate pairs included. Borrows
 * both; +1 u8 result. Never throws. */
ScrBytes *scr_bytes_from_str(const ScrStr *s, const ScrStr *enc);

/* Buffer.byteLength(string, enc) — enc NORMALIZED like from_str — and
 * Buffer.isEncoding(name) (case-insensitive over Node's alias set).
 * Borrow; never throw. */
double scr_bytes_byte_length_str(ScrStr *s, const ScrStr *enc);
bool scr_bytes_is_encoding(const ScrStr *s);

/* equals / compare / indexOf-lastIndexOf / fill / copy / swap / write on
 * u8 bytes, Node-exact (corpus 1663). compare and copy take nargs — the
 * count of PRESENT index args (defaults skip validation like Node);
 * their ladders and fill/write's mirror validateOffset ('an integer',
 * then '>= 0 && <= max' — Node spells '&&' here) and copy's C++ ladder
 * (fractionals truncate silently; targetStart/sourceEnd check only
 * >= 0). indexOf coerces byteOffset (NaN = search everything) and steps
 * by `align` (2 for utf16le needles — matches land on even offsets).
 * fill repeats the pattern over [offset, end) and answers the RECEIVER
 * (+1, chaining); the string form zero-fills on an empty pattern where
 * the bytes form throws Node's TypeError. swap reverses w-byte groups in
 * place (+1 receiver; ERR_INVALID_BUFFER_SIZE off the width). write
 * encodes and truncates at unit boundaries (whole UTF-8 code points,
 * even utf16le lengths), returning the bytes written. concat_len
 * truncates/zero-pads the concatenation to the validated total. */
bool scr_bytes_equals(const ScrBytes *a, const ScrBytes *b);
double scr_bytes_compare(const ScrBytes *src, const ScrBytes *target, double nargs,
                         double ts, double te, double ss, double se);
/* Node's validateOffset ladder (buffer.js): non-integers (±Infinity and
 * NaN included) throw the 'an integer' ERR_OUT_OF_RANGE RangeError, the
 * rest the '>= 0 && <= max' render; max < 0 drops the upper bound.
 * Returns false after arming the pending throw. */
bool scr_bytes_validate_off(const char *name, double value, double max);
/* The checked-dynamic compare/equals validators (scr_bytes_io.c): Node's
 * argument ladder over dyn-boxed arguments — a non-bytes value throws
 * ERR_INVALID_ARG_TYPE with the API's own argument name ("buf1"/"buf2",
 * "otherBuffer", "target"), non-number offsets ERR_INVALID_ARG_TYPE
 * "of type number", out-of-range numbers the validateOffset RangeError;
 * an undefined offset takes its Node default. All arguments BORROWED. */
double scr_buffer_compare_chk(const ScrDyn *a, const ScrDyn *b);
bool scr_bytes_equals_chk(const ScrBytes *recv, const ScrDyn *other);
double scr_bytes_compare_chk(const ScrBytes *src, const ScrDyn *target,
                             const ScrDyn *ts, const ScrDyn *te,
                             const ScrDyn *ss, const ScrDyn *se);
/* new Buffer(number, encoding)'s string-arm type error (always throws;
 * borrowed). */
ScrBytes *scr_buffer_new_string_fail(const ScrDyn *got);
/* fs._toUnixTimestamp over a dyn time value: numeric strings and finite
 * numbers coerce (negatives answer now/1000), the rest throw Node's
 * ERR_INVALID_ARG_TYPE. Borrowed. */
double scr_fs_to_unix_timestamp(const ScrDyn *t);
/* The fs argument-validation ladders (the fs.*Chk libCalls): Node-order
 * validation over dyn values with Node's exact typed errors; a pass
 * meets the real operation where one exists (mkdtempSync, macOS
 * lchmodSync) or the compiler-rendered fence. All borrowed; the Chk
 * forms without results always leave an exception pending. */
ScrDyn *scr_fs_exists_async(const ScrDyn *path, const ScrDyn *cb);
void scr_fs_mkdtemp_chk(const ScrDyn *prefix, const ScrDyn *cb, const ScrStr *fence);
ScrStr *scr_fs_mkdtemp_sync_chk(const ScrDyn *prefix, const ScrDyn *opts, const ScrStr *fence);
void scr_fs_read_file_chk(const ScrDyn *path, const ScrDyn *opts, const ScrDyn *cb, const ScrStr *fence);
void scr_fs_opendir_chk(const ScrDyn *path, const ScrDyn *opts, const ScrStr *fence);
void scr_fs_watch_file_chk(const ScrDyn *path, const ScrDyn *listener, const ScrStr *fence);
void scr_fs_lchmod_chk(const ScrDyn *path, const ScrDyn *mode, const ScrDyn *cb, const ScrStr *fence);
ScrDyn *scr_fs_lchmod_sync_chk(const ScrDyn *path, const ScrDyn *mode);
ScrPromise *scr_fsp_lchmod_chk(const ScrDyn *path, const ScrDyn *mode);
void scr_fs_read_chk(const ScrDyn *fd, const ScrDyn *buffer, const ScrDyn *offset,
                     const ScrDyn *length, const ScrDyn *position, const ScrStr *fence);
void scr_fs_stream_opts_chk(const ScrDyn *path, const ScrDyn *opts, const ScrStr *fence);
/* The checked-dynamic max-listeners ladders (scr_events_emitter.c). */
ScrEmitter *scr_emitter_set_max_chk(ScrEmitter *em, const ScrDyn *n);
void scr_emitter_set_default_max_chk(const ScrDyn *n, const ScrStr *name);
double scr_bytes_index_of(const ScrBytes *b, const ScrBytes *needle, double off, double align, bool fwd);
double scr_bytes_index_of_num(const ScrBytes *b, double v, double off, bool fwd);
ScrBytes *scr_bytes_fill(ScrBytes *b, const ScrBytes *pattern, double nargs, double offset, double end);
ScrBytes *scr_bytes_fill_num(ScrBytes *b, double v, double nargs, double offset, double end);
ScrBytes *scr_bytes_fill_str(ScrBytes *b, const ScrStr *s, const ScrStr *enc,
                             double nargs, double offset, double end);
double scr_bytes_copy_into(const ScrBytes *src, ScrBytes *dst, double nargs,
                           double ts, double ss, double se);
ScrBytes *scr_bytes_swap(ScrBytes *b, double width);
double scr_bytes_write_str(ScrBytes *b, const ScrStr *s, const ScrStr *enc,
                           double offset, double len, bool has_len);
ScrBytes *scr_bytes_concat_len(const ScrArr *list, double total);

/* Buffer.concat(list): list is a SCR_ELEM_BYTES array of u8 bytes values;
 * the result is one fresh copy of their concatenation. Borrows the list.
 * Never throws. */
ScrBytes *scr_bytes_concat(const ScrArr *list); /* +1 */

/* ── util.inspect (scr_inspect.c — linked ONLY when the program calls
 * util.inspect/format; see cc.ts) ─────────────────────────────────────
 * The runtime half of the static inspect rendering: the compiler
 * synthesizes one traversal helper per static type; these entries own
 * Node's exact scalar formatting and the layout engine (frames,
 * break-length, grid grouping) for the DEFAULT options. All arguments
 * BORROWED; ScrStr results +1. Nothing here throws.
 *
 * The frame protocol, mirroring Node's formatRaw: a non-empty composite
 * calls begin(recurse+1) (indentation +2, currentDepth), renders each
 * child to a string and entry()s it (is_num drives the grid's
 * padStart/padEnd order), then end(base, brace0, brace1, recurse+1,
 * array_extras, trailing_more) reduces to one string at the parent
 * indentation. Empty composites and depth placeholders never touch the
 * stack (the frontend emits their literals directly). */
ScrStr *scr_insp_f64(double x);   /* JS ToString, except -0 → "-0" */
ScrStr *scr_insp_str(ScrStr *s);  /* the quoting ladder + line splitting */
ScrStr *scr_insp_regex(ScrRegex *re);  /* /source/flags */
ScrStr *scr_insp_buffer(ScrBytes *b);  /* <Buffer aa bb ...>, 50-byte cap */
/* The stackless error form: [Name: message] / [Name], plus the stamped
 * code slot as its one extra property ({ code: 'X' }); [Name] beyond
 * depth when a code makes it composite. */
ScrStr *scr_insp_error(ScrError *e, double recurse, double depth);
/* The checked-dynamic tree: shape lives in the value, so the whole
 * traversal is here. dyn-boxed bytes render in the checked-dynamic tree's documented
 * Uint8Array identity. */
ScrStr *scr_insp_dyn(ScrDyn *d, double recurse, double depth);
/* format's %s / rest-args twin: dyn strings pass verbatim. */
ScrStr *scr_insp_dyn_s(ScrDyn *d, double depth);
#ifdef SCR_DYNAMIC
/* Island `any` (scr_inspect_island.c — linked when a --dynamic build's
 * IR carries insp.* libCalls): the scalar kinds render exactly (typeof
 * dispatch); composites THROW a catchable TypeError (callers are
 * compiler-emitted pending checks). */
ScrStr *scr_insp_jsval(ScrJsval *v, double recurse, double depth);
#endif
void scr_insp_begin(double recurse);
void scr_insp_entry(ScrStr *s, bool is_num);
/* Circular references, Node-exact (<ref *N> / [Circular *N]): the
 * compiler-emitted helpers over CYCLE-CAPABLE composites call circ_check
 * FIRST (a value already on the traversal stack answers its circular id,
 * assigned in discovery order — the caller renders scr_insp_circular and
 * descends no further), seen_push after begin, and ref_wrap around end's
 * result (pops the stack; values in the circular map gain the "<ref *N> "
 * prefix). State resets at each top-level value's first frame
 * (scr_insp_begin(1)). ref_wrap BORROWS s and returns +1. */
double scr_insp_circ_check(const void *v);
void scr_insp_seen_push(const void *v);
ScrStr *scr_insp_circular(double id);
ScrStr *scr_insp_ref_wrap(const void *v, ScrStr *s);
ScrStr *scr_insp_more_items(double remaining); /* "... N more items" */
ScrStr *scr_insp_key(ScrStr *k); /* bare-or-quoted property-name ladder; +1 */
ScrStr *scr_insp_end(ScrStr *base, ScrStr *b0, ScrStr *b1, double recurse,
                     bool array_extras, bool trailing_more);

/* The buf.read* / buf.write* numeric families on u8 bytes, Node-exact:
 * boundsError's ladder (non-integer offset → 'It must be an integer', a
 * buffer shorter than the width → 'Attempt to access memory outside
 * buffer bounds', otherwise the '>= 0 and <= max' render — big Received
 * values carry Node's underscore separators) and checkInt's value gate
 * for the integer writes (range first, widths past 4 bytes in the
 * '2 ** N' form; NaN passes and writes zeros). All catchable. Fixed
 * widths take a kind + littleEndian flag; the variable-width family
 * (read/writeUIntLE-style) validates byteLength (1-6) first, then value
 * (writes), then offset. Writes return offset + width; float kinds skip
 * the value gate entirely (any double stores, f32 rounds to nearest). */
typedef enum {
  SCR_BN_U8,
  SCR_BN_I8,
  SCR_BN_U16,
  SCR_BN_I16,
  SCR_BN_U32,
  SCR_BN_I32,
  SCR_BN_F32,
  SCR_BN_F64,
} ScrBytesNumKind;
double scr_bytes_read_num(const ScrBytes *b, double offset, ScrBytesNumKind kind, bool le);
double scr_bytes_write_num(ScrBytes *b, double value, double offset, ScrBytesNumKind kind, bool le);
double scr_bytes_read_var(const ScrBytes *b, double offset, double byte_length, bool sign, bool le);
double scr_bytes_write_var(ScrBytes *b, double value, double offset, double byte_length, bool sign, bool le);

/* fs.readFileSync(path) [no encoding] / writeFileSync(path, buf) — the
 * Buffer forms of scr_lib.c's utf8 pair, byte-exact and NUL-safe.
 * Failures THROW catchably (scr_fs_throw, Node-shaped messages). */
ScrBytes *scr_fs_read_file_bytes(ScrStr *path); /* +1 */
/* readFileSync's runtime-encoding form (scr_bytes_io.c's note): +1 dyn
 * value — a Buffer box for undefined/null, a string for utf8 — or NULL
 * with the exception pending. */
ScrDyn *scr_fs_read_file_sync_dyn(ScrStr *path, const ScrDyn *enc);
ScrBytes *scr_fs_read_fd_bytes(double fd);      /* +1; the fd form (scr_lib.c) */
void scr_fs_write_file_bytes(ScrStr *path, const ScrBytes *data);

/* fs/promises readFile(path) [no encoding]: the same read behind an
 * already-settled promise — failure REJECTS (catchable at the await). */
ScrPromise *scr_fsp_read_file_bytes(ScrStr *path); /* +1 */

/* crypto.randomBytes(n) → a real u8 Buffer. Out-of-range n THROWS Node's
 * RangeError catchably (same check as scr_crypto_random_string). */
ScrBytes *scr_crypto_random_bytes(double n); /* +1 */

/* process.stdout/stderr.write(buf[, encoding]): the raw byte writes' Buffer
 * overloads (same streams and buffering as the string forms). The encoding
 * is evaluated by the caller and ignored here, as Node does for bytes.
 * Constantly true. */
bool scr_process_stdout_write_bytes(const ScrBytes *b, const ScrStr *encoding);
bool scr_process_stderr_write_bytes(const ScrBytes *b, const ScrStr *encoding);

/* The Node-shaped fs error thrower (scr_lib.c): formats "ENOENT: no such
 * file or directory, open 'x'" and throws it catchably. Shared with
 * scr_bytes.c's fs forms. */
void scr_fs_throw(int e, const char *op, const ScrStr *path);

/* ── zlib (scr_zlib.c — compiled and linked with -lz only when the
 * program uses zlib, like scr_regex.c/libregexp; see cc.ts) ──────────
 * deflateSync/inflateSync over u8 bytes with Node's default options
 * (zlib format, default level/windowBits). deflate never throws (OOM
 * aborts); inflate of corrupt input THROWS Node's error catchably
 * ("incorrect header check", ...). Borrow their input; results +1. */
ScrBytes *scr_zlib_deflate(const ScrBytes *data);
ScrBytes *scr_zlib_inflate(const ScrBytes *data);
/* The island's mode variants (0 zlib / 1 raw / 2 gzip; inflate adds
 * 3 = auto-detect) — scr_zlib_island.c bridges them into the embedded
 * engine's node:zlib shim. */
ScrBytes *scr_zlib_deflate_mode(const ScrBytes *data, double mode, double level);
ScrBytes *scr_zlib_inflate_mode(const ScrBytes *data, double mode);
void scr_zlib_island_install(void);

/* ── node:net (scr_net.c — compiled and linked ONLY when the program
 * uses the net surface, like scr_events.c; see cc.ts) ─────────────────
 * TCP servers and sockets over the unit's own readiness poller
 * (scr_platform.h: kqueue on macOS/BSD, epoll on Linux): refcounted handles
 * whose listeners MOVE in and drop at settlement (the ScrChild ownership
 * story), consumer-driven reads (the stdin discipline), deferred
 * 'listening'/'error'/'close' emits delivered by the loop's dispatch
 * hook. The emitted main calls scr_net_install() before %main; net-free
 * builds keep their exact link line. Full design note atop scr_net.c. */
typedef struct ScrNetServer ScrNetServer;
typedef struct ScrNetSocket ScrNetSocket;
typedef void (*ScrNetConnFn)(ScrClosure *cb, ScrNetSocket *sock); /* sock +1 */
typedef void (*ScrNetDataFn)(ScrClosure *cb, ScrBytes *chunk);    /* borrowed */

/* The listener-list family (snapshot firing, once-before-run): owned by
 * scr_net.c, reused by scr_http.c for the request-body event lists. */
typedef struct ScrNetOnce ScrNetOnce;

typedef struct {
  ScrClosure *cb; /* owned */
  void *fn;       /* adapter with the event's firing ABI */
  bool once;
  ScrNetOnce *shared_once; /* owned, nullable: one once registration mirrored across lists */
} ScrNetL;

typedef struct {
  ScrNetL *ls;
  size_t n, cap;
} ScrNetLs;

void scr_net_ls_add(ScrNetLs *l, ScrClosure *cb, void *fn, bool once);
ScrNetOnce *scr_net_once_new(void); /* +1 */
ScrNetOnce *scr_net_once_retain(ScrNetOnce *once); /* +1 */
void scr_net_once_release(ScrNetOnce *once);
void scr_net_ls_add_shared_once(ScrNetLs *l, ScrClosure *cb, void *fn,
                                ScrNetOnce *once /*moves*/);
bool scr_net_ls_has_live(const ScrNetLs *l);
void scr_net_ls_drop(ScrNetLs *l);
size_t scr_net_ls_snapshot(ScrNetLs *l, ScrNetL **out);
void scr_net_fire0(ScrNetLs *l);
/* The receiver-binding twins: the emitting handle rides the pass as the
 * ambient receiver (scr_dyn_this_push — `this` in listener bodies).
 * `self` BORROWED; NULL binds undefined (= the plain spellings above). */
void scr_net_fire0_this(ScrNetLs *l, void *self, ScrDynHandleTag tag);
void scr_net_fire_err_this(ScrNetLs *l, ScrStr *msg, void *self, ScrDynHandleTag tag);

/* Protocol-layer (scr_http.c) hooks: a C-level connection consumer on
 * servers, and a C-level reader on sockets (counts as a consumer for
 * read-arming; the context BORROWS its socket and is freed with it). */
typedef void (*ScrNetNativeConnFn)(void *ctx, ScrNetSocket *sock);
typedef void (*ScrNetNativeDataFn)(void *ctx, const char *buf, size_t n);
typedef void (*ScrNetNativeEventFn)(void *ctx);
typedef bool (*ScrNetNativeErrFn)(void *ctx, ScrStr *msg); /* true = consumed */
void scr_net_server_set_native_conn(ScrNetServer *s, ScrNetNativeConnFn fn, void *ctx, void (*ctx_free)(void *));
/* The HTTP-parser ctx ALIAS: scr_http.c stamps its server ctx here so
 * late 'request' listener installs (scr_http_server_on_request) can
 * reach it even after a TLS wrap replaced the native-conn hook (the
 * https/http2 servers: scr_tls.c owns the native ctx, the http ctx sits
 * inside it). BORROWED — owned via the native-conn chain, valid while
 * the server lives; NULL on servers with no HTTP parser. */
void scr_net_server_set_http_ctx(ScrNetServer *s, void *ctx);
void *scr_net_server_get_http_ctx(ScrNetServer *s);
/* The protocol layer's settle hook: called once when the server settles
 * ('close' emitted, lists dropped) with the http_ctx alias — scr_http.c
 * drops its own request/upgrade/connect lists there (the settle-releases-
 * listeners story across the layer seam). */
void scr_net_server_set_proto_settle(ScrNetServer *s, void (*fn)(void *));
bool scr_net_server_settled(ScrNetServer *s); /* 'close' already emitted */
/* The dyn-dispatch hook for HTTP server events: scr_http.c registers it
 * at scr_http_dyn_install, and the netServer handle ops route
 * on('request', ...) (and future http events) through it — link gating
 * keeps scr_net.c from naming http entry points. Returns false for an
 * event the http layer does not model (the caller fences loudly). */
void scr_net_set_dynh_http_on(bool (*fn)(ScrNetServer *, const char *, const ScrDyn *, bool));
void scr_net_sock_set_native_reader(ScrNetSocket *s, ScrNetNativeDataFn data, ScrNetNativeEventFn eof, ScrNetNativeEventFn closed, void *ctx, void (*ctx_free)(void *));
/* The upgrade handover: clear the reader's fn pointers, keep the ctx. */
void scr_net_sock_clear_native_reader(ScrNetSocket *s);
/* The accepting server (BORROWED; NULL on client sockets) — the protocol
 * layer's receiver for server-level fires ('request': this === server). */
ScrNetServer *scr_net_sock_server(ScrNetSocket *s);
/* socket.setEncoding(enc): utf8 flips 'data' delivery to strings (the
 * chunk-encoding window); real-but-unsupported encodings fence loudly;
 * unknown names throw Node's ERR_UNKNOWN_ENCODING. May throw. */
void scr_net_sock_set_encoding(ScrNetSocket *s, ScrStr *enc /*borrowed*/);
bool scr_net_sock_destroyed(ScrNetSocket *s); /* socket.destroyed */
bool scr_net_sock_writable(ScrNetSocket *s);  /* socket.writable */
void scr_net_sock_set_native_events(ScrNetSocket *s, ScrNetNativeEventFn timeout, ScrNetNativeErrFn err);
void scr_net_sock_write_native(ScrNetSocket *s, const char *buf, size_t n);
/* The protocol layer's deferred-emit hook: `pending` joins the loop's
 * liveness test, `sweep` runs at every net sweep top. */
void scr_net_set_proto_sweep(bool (*pending)(void), void (*sweep)(void));
void scr_net_fire_err(ScrNetLs *l, ScrStr *msg); /* unhandled => exit(1) */

ScrNetServer *scr_net_server_retain(ScrNetServer *s);
void scr_net_server_release(ScrNetServer *s);
void *scr_net_server_retain_v(void *p);
void scr_net_server_release_v(void *p);
ScrNetSocket *scr_net_sock_retain(ScrNetSocket *s);
void scr_net_sock_release(ScrNetSocket *s);
void *scr_net_sock_retain_v(void *p);
void scr_net_sock_release_v(void *p);

ScrNetServer *scr_net_create_server(ScrClosure *handler /*moves, nullable*/, ScrNetConnFn fn); /* +1 */
void scr_net_listen(ScrNetServer *s, double port, ScrClosure *cb /*moves, nullable*/);
/* listen({ port, host, ipv6Only }): host is an IP literal ("" = the
 * dual-stack any default); ipv6Only sets IPV6_V6ONLY before the bind. */
void scr_net_listen_opts(ScrNetServer *s, double port, ScrStr *host /*borrowed*/,
                          bool ipv6_only, ScrClosure *cb /*moves, nullable*/);
double scr_net_server_port(ScrNetServer *s); /* address().port */
/* Writable http.Server timeout property storage. `field` is the compiler
 * ABI selector: timeout, keepAliveTimeout, headersTimeout, requestTimeout,
 * keepAliveTimeoutBuffer. Typed reads validate that no dynamic write left
 * a non-number in the ordinary JS property slot. */
double scr_net_server_timeout_get(ScrNetServer *s, double field);
void scr_net_server_timeout_set(ScrNetServer *s, double field, double value);
/* Marks the shared net-server handle as an HTTP/1 or HTTPS server. The
 * dynamic handle uses this to keep HTTP-only fields off net/TLS/H2. */
void scr_net_server_enable_http_timeout_surface(ScrNetServer *s);
/* Constructor-option twin: undefined is absent; otherwise validates type
 * and a non-negative safe integer before storing, matching Node's option
 * ladder (plain property writes do not validate). */
bool scr_net_server_timeout_option_check(double field, double value);
void scr_net_server_timeout_option_set(ScrNetServer *s, double field, const struct ScrDyn *value);
ScrStr *scr_net_server_addr_ip(ScrNetServer *s);     /* +1 — address().address */
ScrStr *scr_net_server_addr_family(ScrNetServer *s); /* +1 — address().family */
void scr_net_server_close(ScrNetServer *s, ScrClosure *cb /*moves, nullable*/);
/* The REAL close behind `wrapper.close.bind(wrapper)` — never consults
 * the override (the proxy-through idiom cannot recurse). */
void scr_net_server_close_direct(ScrNetServer *s, ScrClosure *cb /*moves, nullable*/);
/* wrapper.close = fn — the override MOVES in (a compiler-emitted
 * zero-arg wrapper); reassignment releases the old one. */
void scr_net_server_set_close_override(ScrNetServer *s, ScrClosure *ov /*moves*/);
void scr_net_server_on_error(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once);
void scr_net_server_on_close(ScrNetServer *s, ScrClosure *cb /*moves*/, bool once);
/* server.on('listening', cb): the deferred 'listening' list listen(port,
 * cb) rides — fires once per successful bind; late registrations on an
 * already-listening server never fire (Node's once-per-listen emit). */
void scr_net_server_on_listening(ScrNetServer *s, ScrClosure *cb /*moves*/, bool once);
void scr_net_server_on_connection(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrNetConnFn fn, bool once);
/* 'secureConnection' — the deferred-connection list (TLS handshake
 * timing); released unread on a server without deferral (a plain net
 * server never fires it, like Node). */
void scr_net_server_on_secure_connection(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrNetConnFn fn, bool once);
ScrNetSocket *scr_net_connect(double port, ScrStr *host /*borrowed, nullable*/, ScrClosure *cb /*moves, nullable*/); /* +1 */
/* connect with a validated autoSelectFamilyAttemptTimeout option: the
 * budget runs Node's validateInt32-from-1 ladder (ERR_OUT_OF_RANGE /
 * ERR_INVALID_ARG_TYPE) and is then inert — the single dial has nothing
 * to time. +1, or NULL with the throw pending. */
ScrNetSocket *scr_net_connect_attempt(double port, ScrStr *host /*borrowed*/, const ScrDyn *t /*borrowed*/);
/* net.connect/createConnection over a RUNTIME option bag (computed
 * keys): Node-order validation (objectMode trio, port, host,
 * autoSelectFamily, attempt budget), then the compiler-rendered fence —
 * always leaves an exception pending. Borrowed. */
void scr_net_connect_opts_chk(const ScrDyn *opts, const ScrStr *fence);
/* connect with a caller lookup (net.connect({ ..., lookup })): invokes
 * lookup(hostname, options, answer-closure) synchronously; answer_fn is
 * the emitted per-shape thunk that decodes the answer down to
 * scr_net_lookup_answer. Dials the answered addresses in order. */
/* Blocking first-answer hostname resolution for the CLIENT bridges (the
 * native fetch, the island's http/https client) — the dns.lookup
 * precedent: getaddrinfo at call time. +1: the resolved IP, or a retain
 * of `host` (already an IP literal / localhost / unresolvable — the dial
 * then delivers Node's exact getaddrinfo ENOTFOUND cause). */
ScrStr *scr_net_blocking_lookup(ScrStr *host /*borrowed*/);
ScrNetSocket *scr_net_connect_lookup(double port, ScrStr *host /*borrowed*/,
                                      ScrClosure *lookup /*moves*/, void *answer_fn); /* +1 */
void scr_net_lookup_answer(ScrClosure *self, bool has_err, ScrStr *msg /*borrowed, nullable*/,
                            ScrArr *ips /*borrowed, nullable*/);
void scr_net_sock_write_str(ScrNetSocket *s, ScrStr *data /*borrowed*/);
void scr_net_sock_write_bytes(ScrNetSocket *s, ScrBytes *data /*borrowed*/);
void scr_net_sock_end(ScrNetSocket *s);
void scr_net_sock_end_str(ScrNetSocket *s, ScrStr *data /*borrowed*/);
void scr_net_sock_end_bytes(ScrNetSocket *s, ScrBytes *data /*borrowed*/);
/* Checked-dynamic chunk forms (an untyped JS payload into a typed
 * socket): STR/BYTES dispatch; end() takes undefined/null as no chunk;
 * anything else throws Node's ERR_INVALID_ARG_TYPE chunk TypeError. */
void scr_net_sock_write_dynv(ScrNetSocket *s, const ScrDyn *d /*borrowed*/);
void scr_net_sock_end_dynv(ScrNetSocket *s, const ScrDyn *d /*borrowed*/);
void scr_net_sock_destroy(ScrNetSocket *s);
/* Flow control (pause/resume — see the struct's flag comments), the
 * FIN-flushed destroy (destroySoon), TCP_NODELAY, the deferred write/
 * finish callbacks (write(chunk, cb) / end(cb) — sweep-fired), and the
 * counters/flags the compat surface reads. */
ScrNetSocket *scr_net_sock_pause(ScrNetSocket *s);            /* +1: chaining */
ScrNetSocket *scr_net_sock_resume(ScrNetSocket *s);           /* +1: chaining */
ScrNetSocket *scr_net_sock_set_nodelay(ScrNetSocket *s, bool enable); /* +1: chaining */
void scr_net_sock_destroy_soon(ScrNetSocket *s);
void scr_net_sock_on_finish(ScrNetSocket *s, ScrClosure *cb /*moves*/);
void scr_net_sock_on_write_flush(ScrNetSocket *s, ScrClosure *cb /*moves*/);
double scr_net_sock_bytes_written(ScrNetSocket *s);
bool scr_net_sock_readable(ScrNetSocket *s);
/* The deferred dial (the http agent's maxSockets queue): the socket
 * registers "connecting" and buffers writes; dial_start runs the dial. */
ScrNetSocket *scr_net_connect_deferred(double port, ScrStr *host /*borrowed, nullable*/); /* +1 */
void scr_net_sock_dial_start(ScrNetSocket *s);
void scr_net_sock_set_timeout(ScrNetSocket *s, double ms);
void scr_net_sock_on_timeout(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);
ScrStr *scr_net_sock_remote_address(ScrNetSocket *s); /* +1 or NULL (undefined arm) */
bool scr_net_sock_encrypted(ScrNetSocket *s); /* true = TLS transport (false maps to the undefined arm) */
void scr_net_sock_pipe(ScrNetSocket *src, ScrNetSocket *dst);
void scr_net_sock_on_data(ScrNetSocket *s, ScrClosure *cb /*moves*/, ScrNetDataFn fn, bool once);
void scr_net_sock_on_end(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);
void scr_net_sock_on_close(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);
void scr_net_sock_on_error(ScrNetSocket *s, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once);
void scr_net_sock_on_connect(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);
/* The paused-mode surface (the demux path: once('readable') + read(1) +
 * unshift + emit('connection')). 'readable' listeners are consumers —
 * arrived bytes buffer in the receive buffer and the event announces
 * them (and EOF, where read answers NULL). read(n) answers exactly n
 * buffered bytes (+1) or NULL — Node's less-than-n answer; n <= 0 drains
 * everything. unshift returns bytes to the FRONT of the stream, ahead of
 * anything still in the kernel. emit('connection', sock) routes a socket
 * into another server's protocol layer — the TLS target's 'connection'
 * defers to its handshake, the http target's parser drains the buffered
 * peek first. */
void scr_net_sock_on_readable(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);
ScrBytes *scr_net_sock_read_bytes(ScrNetSocket *s, double n); /* +1 or NULL */
void scr_net_sock_unshift_bytes(ScrNetSocket *s, ScrBytes *data /*borrowed*/);
void scr_net_server_emit_connection(ScrNetServer *srv, ScrNetSocket *sock /*borrowed*/);
void scr_net_data_thunk0(ScrClosure *cb, ScrBytes *chunk);
void scr_net_data_thunk_bytes(ScrClosure *cb, ScrBytes *chunk);
void scr_net_data_thunk_str(ScrClosure *cb, ScrBytes *chunk);
/* The dynCheck-adapted listener's flavor: boxes the chunk as a
 * Buffer-flavored dyn (toString decodes utf8, Node's 'data' payload). */
void scr_net_data_thunk_dyn(ScrClosure *cb, ScrBytes *chunk);
void scr_net_conn_thunk0(ScrClosure *cb, ScrNetSocket *sock);
void scr_net_conn_thunk_sock(ScrClosure *cb, ScrNetSocket *sock);
void scr_net_install(void);
/* Registers the netSocket handle-dispatch ops (SCR_DYNH_NET_SOCKET) —
 * emitted main() calls this alongside scr_net_install exactly when the
 * net unit is linked, so the always-linked dyn core never references
 * this unit's entry points. */
void scr_net_dyn_install(void);
#ifdef SCR_RC_AUDIT
long scr_net_live_count(void);
#endif

/* ── the socket TRANSPORT hooks (scr_tls.c — compiled only into
 * TLS-using binaries; scr_net.c stays transport-agnostic through this
 * ops table). A transport sits UNDER the socket kind: reads and writes
 * redirect through xread/xwrite once installed (read(2)/write(2) shapes —
 * >0 bytes, 0 EOF, -1 with errno, EAGAIN meaning retry on readiness),
 * writes buffer until the handshake establishes, and readiness events
 * drive `handshake` until it answers done (1) or failed (-1 — the
 * transport reports the failure itself via scr_net_sock_transport_error
 * first, Node-shaped message or NULL for the server's silent
 * tlsClientError default). `on_established` (nullable) lets a protocol
 * layer attach AFTER the handshake (the https parser); `pending` answers
 * whether decrypted bytes sit buffered inside the transport (the sweep
 * drains them — the poller can't see bytes that already left the kernel);
 * `shutdown_write` sends the close_notify before the FIN. The ops table
 * is static storage in the transport unit; tctx is freed via `free`
 * when the socket handle dies. */
typedef struct ScrNetTransportOps {
  ssize_t (*xread)(void *tctx, char *buf, size_t n);
  ssize_t (*xwrite)(void *tctx, const char *buf, size_t n);
  int (*handshake)(void *tctx);
  void (*on_established)(void *tctx);
  bool (*pending)(void *tctx);
  void (*shutdown_write)(void *tctx);
  void (*free)(void *tctx);
} ScrNetTransportOps;
void scr_net_sock_set_transport(ScrNetSocket *s, const ScrNetTransportOps *ops, void *tctx);
int scr_net_sock_fd(ScrNetSocket *s);
/* Drain up to n bytes of the socket's receive buffer (peeked/unshifted
 * bytes — the demux path); consumers call it before the fd. */
size_t scr_net_sock_take_buffered(ScrNetSocket *s, char *buf, size_t n);
/* Arm the write filter for a handshake send that hit EAGAIN. */
void scr_net_sock_transport_want_write(ScrNetSocket *s);
/* The socket's transport context, guarded by the ops table identity —
 * NULL when the socket carries no transport or a different one (the SNI
 * answer path re-finds its engine from the boxed socket). */
void *scr_net_sock_transport_ctx_for(ScrNetSocket *s, const ScrNetTransportOps *ops);
/* Re-drive a parked handshake (the asynchronous SNI answer arrived —
 * no fd readiness is coming: the client is waiting for the ServerHello). */
void scr_net_sock_transport_resume(ScrNetSocket *s);
/* Replay raw bytes at the FRONT of the receive buffer — the SNI
 * pre-parse handing the consumed ClientHello back to the TLS bio. */
void scr_net_sock_replay(ScrNetSocket *s, const char *data, size_t len);
/* Transport-level failure: msg (borrowed, Node's message shape) defers
 * 'error' + teardown to the sweep; NULL tears down silently — Node's
 * default for an unhandled server-side handshake failure. */
void scr_net_sock_transport_error(ScrNetSocket *s, const char *msg);
/* Defer the server's 'connection' listeners to handshake completion —
 * tls.createServer's handler is the 'secureConnection' event, fired with
 * the socket only once the TLS layer stands (Node's timing). */
void scr_net_server_defer_connections(ScrNetServer *s);
/* The current native-connection hook (the https wrapper reads the http
 * parser installer it is about to wrap). */
void scr_net_server_get_native_conn(ScrNetServer *s, ScrNetNativeConnFn *fn, void **ctx, void (**ctx_free)(void *));

/* ── the checked-dynamic TLS-member hooks (scr_tls.c registers them when
 * linked — scr_net.c stays TLS-agnostic, the dynh_http_on precedent).
 * Each answers whether it HANDLED the member: `get` fills *out (+1, or
 * NULL for the undefined arm) for TLSSocket property reads (authorized,
 * authorizationError); `on` registers TLS event names ('secureConnect');
 * `invoke` claims TLSSocket method names (the honest per-member fences
 * for the not-yet-modeled surface). Unhandled members fall through to
 * the plain-socket dispatch unchanged. */
typedef struct ScrNetDynhTlsHooks {
  bool (*get)(ScrNetSocket *s, const char *key, struct ScrDyn **out);
  bool (*on)(ScrNetSocket *s, const char *event, const struct ScrDyn *cb, bool once);
  bool (*invoke)(ScrNetSocket *s, const char *method, struct ScrDyn *const *args, size_t argc,
                 struct ScrDyn **out);
} ScrNetDynhTlsHooks;
void scr_net_set_dynh_tls(const ScrNetDynhTlsHooks *hooks);

/* ── node:tls + node:https (scr_tls.c — compiled and linked, with the
 * vendored mbedTLS archive, only when the program uses them; design
 * note atop the file). tls.createServer returns an ORDINARY
 * ScrNetServer whose handler fires as 'secureConnection' (post-
 * handshake) with a socket that behaves exactly like a net socket;
 * https.createServer is http.createServer over the same transport;
 * https.request is the http client dialed through a client transport
 * (port 443 default, `ca` / rejectUnauthorized for local-CA flows —
 * cert/key/ca all arrive as borrowed PEM bytes). */
ScrNetServer *scr_tls_create_server(const char *cert, size_t cert_len, const char *key, size_t key_len, ScrClosure *handler /*moves, nullable*/, ScrNetConnFn fn); /* +1 */

/* ── RUNTIME tls/https options records (the divergence-66 stance: a
 * non-literal options value reads its members at runtime; members whose
 * literal forms are compile fences become runtime gates that THROW the
 * catchable fence instead of behaving differently; undocumented keys
 * drop exactly like Node drops them). cert/key values are PEM strings,
 * Buffers, or one-element arrays of those; `ca` (client side)
 * concatenates array entries into one trust-anchor bundle. The *_dyn
 * creators walk a dyn options record (the checked-dynamic JS lane's
 * shape) and mint the same servers the literal path mints; NULL returns
 * carry a pending exception. scr_tls_pem_from_dyn is the literal path's
 * runtime-valued cert/key extraction (`what` names the fence). */
ScrBytes *scr_tls_pem_from_dyn(const struct ScrDyn *v, const char *what); /* +1 or NULL+pending */
ScrNetServer *scr_tls_create_server_dyn(const struct ScrDyn *opts /*borrowed*/, ScrClosure *handler /*moves, nullable*/, ScrNetConnFn fn); /* +1 or NULL+pending */
/* The https twin (its ScrHttpReqFn parameter is declared with the http
 * section below): scr_https_create_server_dyn. */

/* ── tls.connect (scr_tls.c): the TLS client socket. Dials TCP like
 * net.connect and installs the client transport; the callback (and the
 * socket's 'connect'/'secureConnect' listeners) fires post-handshake —
 * Node's secureConnect timing. `port` < 0 reads the port from the
 * options record; `host` NULL/empty reads host (default "localhost").
 * Implemented option members: port, host, rejectUnauthorized (default
 * true; false runs the handshake with verification RECORDED, so
 * socket.authorized / authorizationError answer Node's split), ca,
 * servername (the SNI + verify name). Every other documented member
 * throws the runtime fence when present; unknown keys drop. */
ScrNetSocket *scr_tls_connect_dyn(double port, ScrStr *host /*borrowed, nullable*/, const struct ScrDyn *opts /*borrowed, nullable*/, ScrClosure *cb /*moves, nullable*/); /* +1 or NULL+pending */

/* The TLSSocket member surface on the socket kind (all no-ops / honest
 * defaults on plain sockets): authorized answers Node's verify verdict
 * (false on servers and unverified clients), auth_error the verify-
 * failure CODE STRING (+1; NULL = Node's null), on_secure_connect
 * registers at the establishment-fired conn list (released unread on a
 * plain socket — the event never fires there, like Node), on_session
 * registers the received-ticket event (fires once with the serialized
 * session as a Buffer; `fn` is the data-listener adapter ABI). */
bool scr_tls_sock_authorized(ScrNetSocket *s);
ScrStr *scr_tls_sock_auth_error(ScrNetSocket *s); /* +1 or NULL */
void scr_tls_sock_on_secure_connect(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);
void scr_tls_sock_on_session(ScrNetSocket *s, ScrClosure *cb /*moves*/, void *fn, bool once);

/* ── h2 over TLS (scr_tls.c ↔ scr_http2.c): the ALPN=h2 server wrap and
 * the https-authority client wrap. scr_http2.c calls both directly —
 * every http2-using binary links the TLS unit (the moduleUsesTls
 * switch), so no registration indirection is needed. */
void scr_tls_server_wrap_h2(ScrNetServer *s, const char *cert, size_t cert_len, const char *key, size_t key_len, ScrNetNativeConnFn h2_conn, void *h2_ctx /*moves*/, void (*h2_ctx_free)(void *), ScrClosure *sni_cb /*moves, nullable*/, void *sni_answer_fn);
void scr_tls_h2_client_wrap(ScrNetSocket *sock, ScrStr *host /*borrowed*/, bool reject_unauthorized, const char *ca /*borrowed, len 0 = none*/, size_t ca_len);

/* ── tls.SecureContext + the SNI callback (scr_tls.c) ─────────────────
 * A SecureContext is an opaque refcounted parsed cert/key pair
 * (tls.createSecureContext({ cert, key })). A server created with an
 * SNI callback parses each connection's ClientHello for the server_name
 * extension BEFORE the mbedTLS handshake begins (the callback may answer
 * asynchronously — cert generation on demand is the portless flow — and
 * mbedTLS's own f_sni must answer synchronously, so the runtime resolves
 * the name first and replays the hello bytes into the bio), invokes the
 * JS callback with (servername, answer-closure), and resumes the
 * handshake when scr_tls_sni_answer arrives: has_err tears the socket
 * down silently (Node's 'tlsClientError' default), a ctx serves its
 * cert/key via mbedtls_ssl_set_hs_own_cert, NULL serves the default
 * pair. `answer_fn` is the emitted per-shape thunk that decodes the
 * callback's program-interned unions down to this call — it becomes the
 * minted answer closure's fn (caps[0] boxes the socket). Connections
 * whose ClientHello carries no server_name skip the callback and serve
 * the default pair, exactly Node. */
typedef struct ScrSecureCtx ScrSecureCtx;
ScrSecureCtx *scr_tls_create_secure_context(const char *cert, size_t cert_len, const char *key, size_t key_len); /* +1 */
/* createSecureContext over a RUNTIME options record: Node's typed option
 * validations first, then the pem walk (+1, or NULL with the exception
 * pending). Borrowed. */
ScrSecureCtx *scr_tls_create_secure_context_dyn(const ScrDyn *opts);
/* tls.getCACertificates(type): validateString + the documented name set,
 * then the compiler-rendered fence — always leaves an exception pending. */
void scr_tls_ca_certs_chk(const ScrDyn *type, const ScrStr *fence);
ScrSecureCtx *scr_secure_ctx_retain(ScrSecureCtx *c);
void scr_secure_ctx_release(ScrSecureCtx *c);
void *scr_secure_ctx_retain_v(void *p);
void scr_secure_ctx_release_v(void *p);
ScrNetServer *scr_https_create_server_sni(const char *cert, size_t cert_len, const char *key, size_t key_len, ScrClosure *sni_cb /*moves, nullable*/, void *answer_fn); /* +1 */
void scr_tls_sni_answer(ScrClosure *self, bool has_err, ScrSecureCtx *ctx /*moves, nullable*/);
#ifdef SCR_RC_AUDIT
long scr_secure_ctx_live_count(void);
#endif

/* ── node:tls, the CA-store introspection slice (scr_tls_ca.c — its own
 * unit and link gate; NO mbedTLS, so a getCACertificates-only binary never
 * builds the archive; cc.ts also compiles it whenever scr_tls.c does). The
 * HOST roots (Windows' system certificate stores, the established bundle probe on
 * POSIX) stand in for both Node's compiled-in Mozilla roots ('bundled',
 * rootCertificates) and the platform store ('system') — the established
 * SEMANTICS divergence, extended to introspection; 'extra' uses the
 * NODE_EXTRA_CA_CERTS file captured before user code runs. Arrays are cached
 * per type (+1 retained answers each call — Node's own caching, and the
 * identity the suite pins with strictEqual). */
void scr_tls_ca_install(void); /* snapshots NODE_EXTRA_CA_CERTS + file bytes */
bool scr_tls_ca_extra_pem(const char **pem, size_t *len); /* borrowed launch snapshot */
#ifdef _WIN32
/* Enumerates Windows' trusted ROOT, intermediate CA, and TrustedPeople store
 * locations, yielding only certificates whose effective Windows EKU policy
 * permits TLS server authentication. DER is borrowed for the call. */
typedef void (*ScrTlsCaWindowsCertFn)(void *ctx, const unsigned char *der, size_t len);
bool scr_tls_ca_windows_cert_server_auth(const void *cert_context);
void scr_tls_ca_windows_certs(ScrTlsCaWindowsCertFn fn, void *ctx);
#endif
ScrArr *scr_tls_ca_get(ScrStr *type); /* +1; throws ERR_INVALID_ARG_VALUE on unknown types */
ScrArr *scr_tls_ca_root(void);        /* +1; === getCACertificates("bundled") */
/* Replaces the 'default' set: entries filter to their PEM certificate
 * blocks (deduped byte-exactly — Node dedupes by X509 identity); a
 * non-empty array yielding no blocks throws Node's
 * ERR_CRYPTO_OPERATION_FAILED and leaves the set unchanged. Borrows. */
void scr_tls_ca_set_default(ScrArr *certs);
/* scr_tls.c's anchor consult: true iff setDefaultCACertificates ran;
 * *pem/*len then carry the concatenated NUL-terminated blocks (len 0 =
 * the empty set — verification fails, Node's own consequence), and *gen
 * a counter that bumps per set so the parsed chain re-parses on change. */
bool scr_tls_ca_default_override(const char **pem, size_t *len, uint64_t *gen);

/* ── node:http, the server slice (scr_http.c — compiled only when the
 * program uses it; rides scr_net.c wholesale, design note atop the
 * file). http.createServer returns an ORDINARY ScrNetServer (listen/
 * close/address/'error' reuse the net surface); req/res are lean
 * refcounted handles, listeners dropping at settlement like sockets. */
typedef struct ScrHttpReq ScrHttpReq;
typedef struct ScrHttpRes ScrHttpRes;
typedef void (*ScrHttpReqFn)(ScrClosure *cb, ScrHttpReq *req, ScrHttpRes *res); /* both +1 */
typedef void (*ScrHttpConnectH2Fn)(ScrClosure *cb, ScrHttpReq *req, ScrHttpRes *res); /* both +1 */
/* 'upgrade' listeners, both sides: (req-or-res, socket, head) — all +1.
 * The parser steps aside (native reader cleared) and the socket is the
 * listener's raw stream; `head` carries bytes read past the 101/request
 * head. Requests with Connection: upgrade + an Upgrade header fire the
 * server list INSTEAD of 'request'; a 101 response fires the client list
 * INSTEAD of 'response'; either side with NO listener destroys the
 * socket, Node's default. */
typedef void (*ScrHttpUpgradeFn)(ScrClosure *cb, ScrHttpReq *req, ScrNetSocket *sock, ScrBytes *head);

ScrHttpReq *scr_http_req_retain(ScrHttpReq *r);
void scr_http_req_release(ScrHttpReq *r);
void *scr_http_req_retain_v(void *p);
void scr_http_req_release_v(void *p);
ScrHttpRes *scr_http_res_retain(ScrHttpRes *r);
void scr_http_res_release(ScrHttpRes *r);
void *scr_http_res_retain_v(void *p);
void scr_http_res_release_v(void *p);

/* ── the h2 compat seam (scr_http.c ⇄ scr_http2.c) ─────────────────────
 * Http2ServerRequest/Http2ServerResponse ARE the req/res handles above;
 * scr_http2.c (linked only when the real h2 surface is used) installs
 * the transport vtable — response write paths become HEADERS/DATA
 * frames — and the request-registration hook that routes
 * server.on("request", ...) on an h2-tagged server ctx to the h2
 * request list. scr_http.c links WITHOUT scr_http2.c, so the seam is a
 * pointer pair, never a hard symbol reference in that direction. */
typedef struct ScrHttpH2Ops {
  void *(*retain)(void *stream);
  void (*release)(void *stream);
  /* Serialize + send the response HEADERS frame: :status first, then the
   * set headers (connection-specific names dropped, h2's rule), then the
   * implicit date unless add_date is false (res.sendDate = false). */
  void (*respond)(void *stream, double status, ScrStr *const *names,
                  ScrStr *const *values, size_t nheaders, bool add_date);
  void (*write)(void *stream, const char *data, size_t n);
  void (*end)(void *stream, const char *data, size_t n); /* DATA + END_STREAM */
  void (*destroy)(void *stream);                          /* res.destroy: RST */
} ScrHttpH2Ops;

void scr_http_set_h2_ops(const ScrHttpH2Ops *ops);
void scr_http_set_h2_request_hook(void (*hook)(void *h2ctx, ScrClosure *cb /*moves*/,
                                               void *fn, bool once));
void scr_http_set_h2_connect_hook(void (*hook)(void *h2ctx, ScrClosure *cb /*moves*/,
                                               void *h1_fn, void *h2_fn, bool once));
void scr_http_set_h2_upgrade_hook(void (*hook)(void *h2ctx, ScrClosure *cb /*moves*/,
                                               void *fn, bool once));

/* The compat pair, built by scr_http2.c per server stream. */
ScrHttpReq *scr_http_h2_req_new(ScrNetSocket *sock /*borrowed, nullable*/,
                                 void *stream /*borrowed, nullable*/); /* +1 */
void *scr_http_req_h2_stream(ScrHttpReq *r); /* +1 or NULL */
void *scr_http_req_h2_stream_or_throw(ScrHttpReq *r, ScrStr *member /*borrowed*/); /* +1 */
void scr_http_h2_req_line(ScrHttpReq *r, ScrStr *method /*borrowed, nullable*/,
                           ScrStr *url /*borrowed, nullable*/);
void scr_http_h2_req_header(ScrHttpReq *r, ScrStr *name /*borrowed*/, ScrStr *value /*borrowed*/);
void scr_http_h2_req_data(ScrHttpReq *r, const char *data, size_t n);
void scr_http_h2_req_end(ScrHttpReq *r);
void scr_http_h2_req_aborted(ScrHttpReq *r);
void scr_http_h2_req_close(ScrHttpReq *r);
ScrHttpRes *scr_http_h2_res_new(ScrNetSocket *sock /*borrowed, nullable*/,
                                 void *stream /*borrowed*/); /* +1 */
void scr_http_h2_res_close(ScrHttpRes *r);
bool scr_http_h2_res_finished(ScrHttpRes *r);
void scr_http_req_on_aborted(ScrHttpReq *r, ScrClosure *cb /*moves*/, bool once);
ScrStr *scr_http_req_http_version(ScrHttpReq *r); /* +1 — "1.0"/"1.1"/"2.0" */
double scr_http_req_http_version_major(ScrHttpReq *r);
double scr_http_req_http_version_minor(ScrHttpReq *r);
bool scr_http_req_aborted_flag(ScrHttpReq *r);
bool scr_http_req_complete(ScrHttpReq *r);

/* Registers the httpReq/httpRes handle-dispatch ops (SCR_DYNH_HTTP_REQ /
 * SCR_DYNH_HTTP_RES) — emitted main() calls this exactly when the http
 * unit is linked (the scr_net_dyn_install story). */
void scr_http_dyn_install(void);

ScrNetServer *scr_http_create_server(ScrClosure *handler /*moves, nullable*/, ScrHttpReqFn fn); /* +1 */
/* The unguarded h2-only stream call: throws Node's exact catchable
 * TypeError (member read on undefined). Borrows; never returns. */
void scr_http2_stream_undef_call(ScrStr *member);
/* Late 'request' listener install (server.on/once("request", ...)) — the
 * http2 allowHTTP1 server's handler route (created handler-less), and
 * http.Server's 'request' event. Listeners resolve at REQUEST time (the
 * emit), Node's dispatch. On a server with no HTTP parser (a plain net
 * server) the closure releases unregistered: 'request' never fires
 * there, like Node. */
void scr_http_server_on_request(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrHttpReqFn fn, bool once);
void scr_http1_ctx_on_request(void *ctx, ScrClosure *cb /*moves*/, ScrHttpReqFn fn, bool once,
                              ScrNetOnce *shared_once /*moves, nullable*/);
void scr_http1_ctx_on_connect(void *ctx, ScrClosure *cb /*moves*/, ScrHttpUpgradeFn fn, bool once,
                              ScrNetOnce *shared_once /*moves, nullable*/);
void scr_http1_ctx_on_upgrade(void *ctx, ScrClosure *cb /*moves*/, ScrHttpUpgradeFn fn, bool once);
void scr_http1_ctx_settle(void *ctx);
ScrStr *scr_http_req_url(ScrHttpReq *r);      /* +1 */
ScrStr *scr_http_req_method(ScrHttpReq *r);   /* +1 */
ScrStr *scr_http_req_header(ScrHttpReq *r, ScrStr *name /*borrowed*/); /* +1 or NULL (undefined arm) */
void scr_http_req_on_data(ScrHttpReq *r, ScrClosure *cb /*moves*/, ScrNetDataFn fn, bool once);
/* req.pipe(dest): the IncomingMessage body streams into the destination;
 * natural end ends it (Node's pipe default). Declared below the client
 * typedef for the ClientRequest leg. */
void scr_http_req_pipe_res(ScrHttpReq *r, ScrHttpRes *dst /*borrowed*/);
void scr_http_req_pipe_sock(ScrHttpReq *r, ScrNetSocket *dst /*borrowed*/);
void scr_http_req_on_end(ScrHttpReq *r, ScrClosure *cb /*moves*/, bool once);
void scr_http_res_set_header(ScrHttpRes *r, ScrStr *name /*borrowed*/, ScrStr *value /*borrowed*/);
void scr_http_res_write_head(ScrHttpRes *r, double status);
void scr_http_res_write_head_n(ScrHttpRes *r, double status, ScrArr *names /*borrowed*/, ScrArr *values /*borrowed*/);
/* writeHead with a CHECKED-DYNAMIC headers object (borrowed): OBJ
 * entries setHeader in insertion order (string/number values), then the
 * head goes out; undefined/null = the plain head; may throw. */
void scr_http_res_write_head_dyn(ScrHttpRes *r, double status, const ScrDyn *headers);
void scr_http_res_write_str(ScrHttpRes *r, ScrStr *data /*borrowed*/);
void scr_http_res_write_bytes(ScrHttpRes *r, ScrBytes *data /*borrowed*/);
void scr_http_res_end(ScrHttpRes *r);
/* socket.pipe(res): raw source chunks become response body writes; EOF
 * ends the response (the extended-CONNECT bridge leg). Borrows both. */
void scr_http_sock_pipe_res(ScrNetSocket *src, ScrHttpRes *dst /*borrowed*/);
void scr_http_res_end_str(ScrHttpRes *r, ScrStr *data /*borrowed*/);
void scr_http_res_end_bytes(ScrHttpRes *r, ScrBytes *data /*borrowed*/);
/* Checked-dynamic chunk forms (the scr_net_sock_write_dynv story). */
void scr_http_res_write_dynv(ScrHttpRes *r, const ScrDyn *d /*borrowed*/);
void scr_http_res_end_dynv(ScrHttpRes *r, const ScrDyn *d /*borrowed*/);
bool scr_http_res_headers_sent(ScrHttpRes *r);
/* The res member surface: statusCode (200 until assigned; inert once the
 * head went out), statusMessage (the reason phrase — assigned value, or
 * the code's default), the header CRUD trio, and end(cb)'s finish slot
 * (fires deferred once the body went out — the res 'close' precedent). */
double scr_http_res_status_get(ScrHttpRes *r);
void scr_http_res_status_set(ScrHttpRes *r, double status);
ScrStr *scr_http_res_status_msg_get(ScrHttpRes *r); /* +1 */
void scr_http_res_status_msg_set(ScrHttpRes *r, ScrStr *msg /*borrowed*/);
ScrStr *scr_http_res_get_header(ScrHttpRes *r, ScrStr *name /*borrowed*/); /* +1 or NULL */
bool scr_http_res_has_header_named(ScrHttpRes *r, ScrStr *name /*borrowed*/);
void scr_http_res_remove_header(ScrHttpRes *r, ScrStr *name /*borrowed*/);
void scr_http_res_on_finish(ScrHttpRes *r, ScrClosure *cb /*moves*/);
/* createServer({ joinDuplicateHeaders: true }): repeated request-header
 * names read back joined ", " (Node's option; the default keeps first). */
void scr_http_server_join_duplicate_headers(ScrNetServer *s);
void scr_http_handler_thunk0(ScrClosure *cb, ScrHttpReq *req, ScrHttpRes *res);
void scr_http_handler_thunk1(ScrClosure *cb, ScrHttpReq *req, ScrHttpRes *res);
void scr_http_handler_thunk2(ScrClosure *cb, ScrHttpReq *req, ScrHttpRes *res);
/* server.on("connect", ...) — fired instead of 'request' for CONNECT.
 * HTTP/1 uses (req, socket, head); HTTP/2 compatibility uses (req, res). */
void scr_http_server_on_connect(ScrNetServer *s, ScrClosure *cb /*moves*/,
                                 ScrHttpUpgradeFn h1_fn, ScrHttpConnectH2Fn h2_fn,
                                 bool once);
void scr_http_server_on_upgrade(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrHttpUpgradeFn fn, bool once);
ScrArr *scr_http_req_raw_headers(ScrHttpReq *r); /* +1 — [name, value, ...], arrival order/case */
ScrArr *scr_http_req_header_pairs(ScrHttpReq *r); /* +1 — lowercased names, the headers snapshot */
ScrStr *scr_http_req_status_message(ScrHttpReq *r); /* +1 or NULL (undefined arm: server request) */
void scr_http_upgrade_thunk0(ScrClosure *cb, ScrHttpReq *req, ScrNetSocket *sock, ScrBytes *head);
void scr_http_upgrade_thunk1(ScrClosure *cb, ScrHttpReq *req, ScrNetSocket *sock, ScrBytes *head);
void scr_http_upgrade_thunk2(ScrClosure *cb, ScrHttpReq *req, ScrNetSocket *sock, ScrBytes *head);
void scr_http_upgrade_thunk3(ScrClosure *cb, ScrHttpReq *req, ScrNetSocket *sock, ScrBytes *head);

/* The member follow-ups (statusCode / socket / resume / destroy / the
 * error+close listener slots on requests; destroy / close / the
 * flat-pairs writeHead on responses). */
double scr_http_req_status(ScrHttpReq *r); /* < 0 = the undefined arm (server request) */
ScrNetSocket *scr_http_req_socket(ScrHttpReq *r); /* +1 */
void scr_http_req_resume(ScrHttpReq *r);
/* pause()/resume() hold and drain 'data'/'end' delivery (the parser keeps
 * consuming; the drain rides the emit queue); setTimeout delegates to the
 * socket's idle timer; the flags back req.destroyed/req.readable. */
void scr_http_req_pause(ScrHttpReq *r);
void scr_http_req_set_timeout(ScrHttpReq *r, double ms, ScrClosure *cb /*moves, nullable*/);
bool scr_http_req_destroyed_flag(ScrHttpReq *r);
bool scr_http_req_readable(ScrHttpReq *r);
/* flushHeaders/cork/uncork/writableCorked, the res.req backref, the
 * socket-delegated setTimeout, and write(chunk, cb)'s deferred callback. */
void scr_http_res_flush_headers(ScrHttpRes *r);
void scr_http_res_cork(ScrHttpRes *r);
void scr_http_res_uncork(ScrHttpRes *r);
double scr_http_res_writable_corked(ScrHttpRes *r);
bool scr_http_res_destroyed_flag(ScrHttpRes *r);
void scr_http_res_set_req(ScrHttpRes *r, ScrHttpReq *req /*borrowed, nullable*/);
void scr_http_res_set_timeout(ScrHttpRes *r, double ms, ScrClosure *cb /*moves, nullable*/);
void scr_http_res_on_write_flush(ScrHttpRes *r, ScrClosure *cb /*moves*/);
/* req.setEncoding(enc) — the socket twin's contract; may throw. */
void scr_http_req_set_encoding(ScrHttpReq *r, ScrStr *enc /*borrowed*/);
void scr_http_req_destroy(ScrHttpReq *r);
void scr_http_req_on_error(ScrHttpReq *r, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once);
void scr_http_req_on_close(ScrHttpReq *r, ScrClosure *cb /*moves*/, bool once);
void scr_http_res_destroy(ScrHttpRes *r);
void scr_http_res_on_close(ScrHttpRes *r, ScrClosure *cb /*moves*/, bool once);
void scr_http_res_write_head_pairs(ScrHttpRes *r, double status, ScrArr *pairs /*borrowed*/);

/* node:http, the CLIENT slice (http.request/http.get over the net client
 * machinery — one dialed connection per request, no agent pooling; the
 * wire head is Node's exactly). The response arrives as a ScrHttpReq. */
typedef struct ScrHttpClientReq ScrHttpClientReq;
typedef void (*ScrHttpRespFn)(ScrClosure *cb, ScrHttpReq *res); /* res +1 */
ScrHttpClientReq *scr_http_client_retain(ScrHttpClientReq *c);
void scr_http_client_release(ScrHttpClientReq *c);
void *scr_http_client_retain_v(void *p);
void scr_http_client_release_v(void *p);
ScrHttpClientReq *scr_http_request(ScrStr *host /*borrowed*/, double port,
                                    ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                    double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                    bool auto_end, ScrClosure *cb /*moves, nullable*/,
                                    ScrHttpRespFn fn); /* +1 */
/* The createConnection form: conn_cb (a `() => net.Socket` closure) runs
 * once, synchronously, and supplies the exchange's socket. */
ScrHttpClientReq *scr_http_request_conn(ScrClosure *conn_cb /*moves*/, ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/, double timeout_ms, ScrArr *header_pairs /*borrowed*/, bool auto_end, ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn); /* +1 */
void scr_http_client_write_str(ScrHttpClientReq *c, ScrStr *data /*borrowed*/);
void scr_http_client_write_bytes(ScrHttpClientReq *c, ScrBytes *data /*borrowed*/);
void scr_http_client_end(ScrHttpClientReq *c);
void scr_http_client_end_str(ScrHttpClientReq *c, ScrStr *data /*borrowed*/);
void scr_http_client_end_bytes(ScrHttpClientReq *c, ScrBytes *data /*borrowed*/);
/* Checked-dynamic chunk forms (the scr_net_sock_write_dynv story). */
void scr_http_client_write_dynv(ScrHttpClientReq *c, const ScrDyn *d /*borrowed*/);
void scr_http_client_end_dynv(ScrHttpClientReq *c, const ScrDyn *d /*borrowed*/);
void scr_http_client_set_timeout(ScrHttpClientReq *c, double ms);
void scr_http_client_destroy(ScrHttpClientReq *c);
bool scr_http_client_destroyed(ScrHttpClientReq *c);
void scr_http_client_on_response(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, ScrHttpRespFn fn, bool once);
void scr_http_client_on_error(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once);
void scr_http_client_on_timeout(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, bool once);
void scr_http_client_on_close(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, bool once);
void scr_http_client_on_upgrade(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, ScrHttpUpgradeFn fn, bool once);
void scr_http_req_pipe_client(ScrHttpReq *r, ScrHttpClientReq *dst /*borrowed*/);
void scr_http_resp_thunk0(ScrClosure *cb, ScrHttpReq *res);
void scr_http_resp_thunk_res(ScrClosure *cb, ScrHttpReq *res);
/* The transport-parameterized client constructor (scr_tls.c's https
 * entry): `wrap` (nullable) installs a transport on the freshly dialed
 * socket before any bytes go out (they buffer until the handshake
 * establishes), and `default_port` is the port the Host header omits
 * (80 for http, 443 for https — Node's rule). scr_http_request is this
 * with no wrap and port 80. */
ScrHttpClientReq *scr_http_request_ex(ScrStr *host /*borrowed*/, double port,
                                       ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                       double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                       bool auto_end, ScrClosure *cb /*moves, nullable*/,
                                       ScrHttpRespFn fn, int default_port,
                                       void (*wrap)(ScrNetSocket *, void *), void *wrap_ctx); /* +1 */
/* The URL-string client form (http.get('http://host:port/path')): parses
 * through the WHATWG unit; throws catchably on an unparsable input
 * ("Invalid URL") or a non-http scheme (ERR_INVALID_PROTOCOL) and
 * returns NULL with the exception pending. cb MOVES (nullable). */
ScrHttpClientReq *scr_http_request_url(ScrStr *url /*borrowed*/, ScrStr *method /*borrowed*/,
                                        bool auto_end, ScrClosure *cb /*moves, nullable*/,
                                        ScrHttpRespFn fn); /* +1 */
/* Its parse half, shared with scr_tls.c's https spelling: the scheme is
 * checked against `secure` (the calling module), so a mismatch is Node's
 * ERR_INVALID_PROTOCOL rather than a silent upgrade. false = the
 * exception is pending and no out-parameter was written. */
bool scr_http_url_parts(ScrStr *url /*borrowed*/, bool secure, ScrStr **host_out /*+1*/,
                         double *port_out, ScrStr **path_out /*+1*/);
/* ── the http Agent (new http.Agent(opts) — option surface, getName, and
 * the maxSockets queue over one-dial-per-request connections; keep-alive
 * POOLING is not modeled: keepAlive: true fences at construction).
 * agent_new answers the SCR_DYNH_HTTP_AGENT handle (+1 dyn) or throws.
 * max_sockets/max_free arrive < 0 for "unset" (Infinity / 256);
 * timeout_ms < 0 = no idle timer. request_agent_ex threads the agent dyn
 * (undefined/null = the default path; false = one-shot with Connection:
 * close; an Agent handle = queue accounting); port < 0 means "no port
 * option" — the agent's (settable) defaultPort, then the scheme's. */
ScrDyn *scr_http_agent_new(bool secure, bool keep_alive, double ka_msecs,
                            double max_sockets, double max_free, double timeout_ms,
                            double port /* < 0 = unset: the option-merge default */); /* +1 */
ScrHttpClientReq *scr_http_request_agent_ex(ScrStr *host /*borrowed*/, double port,
                                             ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                             double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                             bool auto_end, const ScrDyn *agent /*borrowed*/,
                                             ScrClosure *cb /*moves, nullable*/,
                                             ScrHttpRespFn fn, int default_port,
                                             void (*wrap)(ScrNetSocket *, void *), void *wrap_ctx); /* +1 */
ScrHttpClientReq *scr_http_request_agent(ScrStr *host /*borrowed*/, double port,
                                          ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                          double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                          bool auto_end, const ScrDyn *agent /*borrowed*/,
                                          ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn); /* +1 */
#ifdef SCR_RC_AUDIT
long scr_http_live_count(void);
#endif

/* ── node:http2 (scr_http2.c — REAL HTTP/2: h2c server + client over
 * the net loop, with an in-tree RFC 7540 frame codec and RFC 7541 HPACK;
 * the design note atop scr_http2.c has the full story). Sessions and
 * streams are refcounted handles like the net pair; 'stream'/'response'
 * payloads cross as flat [name, value, ...] pairs arrays and the EMITTED
 * adapter closure builds the program-side headers record (the response
 * :status rides separately as a number — no string→number conversion
 * exists program-side). The srv-ctx `proto` tags (SCR_NET_PROTO_*) keep
 * the two parser families apart on the shared http_ctx alias slot. */
enum { SCR_NET_PROTO_HTTP1 = 1, SCR_NET_PROTO_H2 = 2 };

typedef struct ScrH2Session ScrH2Session;
typedef struct ScrH2Stream ScrH2Stream;
typedef void (*ScrH2SessionErrorFn)(ScrClosure *cb, ScrStr *msg,
                                    ScrH2Session *session); /* session +1 */

typedef void (*ScrH2StreamFn)(ScrClosure *cb, ScrH2Stream *st, ScrArr *pairs, double flags); /* st, pairs +1 */
typedef void (*ScrH2RespFn)(ScrClosure *cb, ScrArr *pairs, double status, double flags);     /* pairs +1 */
typedef void (*ScrH2SessionFn)(ScrClosure *cb, ScrH2Session *sess);                          /* sess +1 */
typedef void (*ScrH2ConnectFn)(ScrClosure *cb, ScrH2Session *sess, ScrNetSocket *sock);      /* both +1; sock nullable */
typedef void (*ScrH2GoawayFn)(ScrClosure *cb, double code, double last);
typedef void (*ScrH2SettingsFn)(ScrClosure *cb, ScrDyn *settings /*+1*/);

ScrH2Session *scr_http2_session_retain(ScrH2Session *s);
void scr_http2_session_release(ScrH2Session *s);
void *scr_http2_session_retain_v(void *p);
void scr_http2_session_release_v(void *p);
ScrH2Stream *scr_http2_stream_retain(ScrH2Stream *st);
void scr_http2_stream_release(ScrH2Stream *st);
void *scr_http2_stream_retain_v(void *p);
void scr_http2_stream_release_v(void *p);

/* server (an ordinary net server handle; listen/close/address/'error'
 * ride the net surface — the scr_http.c shape) */
ScrNetServer *scr_http2_create_server(void); /* +1 */
/* createServer(handler): the eager (req, res) COMPAT handler — the first
 * 'request' listener (Http2ServerRequest/Response over h2 streams). */
ScrNetServer *scr_http2_create_server_req(ScrClosure *handler /*moves*/, ScrHttpReqFn fn); /* +1 */
/* The REAL h2-over-TLS server (http2.createSecureServer({ cert, key })):
 * the same session machinery behind an mbedTLS handshake whose ALPN
 * advertises h2 alone — protocol-identical after establishment. */
ScrNetServer *scr_http2_create_secure_server(const char *cert, size_t cert_len, const char *key, size_t key_len, bool enable_connect_protocol); /* +1 */
ScrNetServer *scr_http2_create_secure_server_allow_http1(const char *cert, size_t cert_len, const char *key, size_t key_len, ScrClosure *handler /*moves, nullable*/, ScrHttpReqFn fn, ScrClosure *sni_cb /*moves, nullable*/, void *sni_answer_fn, bool enable_connect_protocol); /* +1 */
/* createSecureServer(options, handler): the eager COMPAT handler as the
 * first 'request' listener over the ALPN=h2 server (the createServerReq
 * route, secured). */
ScrNetServer *scr_http2_create_secure_server_req(const char *cert, size_t cert_len, const char *key, size_t key_len, ScrClosure *handler /*moves, nullable*/, ScrHttpReqFn fn, bool enable_connect_protocol); /* +1 */
/* createSecureServer with a RUNTIME options record (the divergence-66
 * stance): allowHTTP1 picks the flavor at runtime, cert/key ride the
 * shared TLS server walk (out-of-bounds members throw the catchable
 * fence), h2 session-tuning keys drop like the literal walk ignores
 * them. +1, or NULL with the exception pending. */
ScrNetServer *scr_http2_create_secure_server_dyn(const struct ScrDyn *opts /*borrowed*/, ScrClosure *handler /*moves, nullable*/, ScrHttpReqFn fn);
/* The TLS server-options walk (scr_tls.c) — runtime-internal, shared
 * with scr_http2.c's createSecureServerDyn. */
bool scr_tls_srv_opts_walk(const struct ScrDyn *opts, const char *api, ScrBytes **cert_out, ScrBytes **key_out);
void scr_http2_server_on_stream(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrH2StreamFn fn, bool once);
void scr_http2_server_on_session(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrH2SessionFn fn, bool once);

/* client — h2c prior knowledge for http authorities, the TLS transport
 * with ALPN ["h2"] for https ones (ca len 0 = the system anchors;
 * reject_unauthorized false disables the verify gate — the local-CA
 * self-connect shapes); throws catchably on bad input */
ScrH2Session *scr_http2_connect(ScrStr *url /*borrowed*/, bool reject_unauthorized,
                                 const char *ca /*borrowed, len 0 = none*/, size_t ca_len,
                                 ScrClosure *cb /*moves, nullable*/,
                                 ScrH2ConnectFn fn); /* +1 */
/* end_stream: -1 = the method's payload-meaningless default, 0/1 explicit */
ScrH2Stream *scr_http2_session_request(ScrH2Session *s, ScrArr *pairs /*borrowed, nullable*/,
                                        double end_stream); /* +1; may throw */

/* session */
void scr_http2_session_close(ScrH2Session *s, ScrClosure *cb /*moves, nullable*/);
void scr_http2_session_destroy(ScrH2Session *s);
void scr_http2_session_on_close(ScrH2Session *s, ScrClosure *cb /*moves*/, bool once);
void scr_http2_session_on_error(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once);
void scr_http2_server_on_session_error(ScrNetServer *s, ScrClosure *cb /*moves*/,
                                       ScrH2SessionErrorFn fn, bool once);
void scr_http2_session_error_thunk0(ScrClosure *cb, ScrStr *msg, ScrH2Session *session);
void scr_http2_session_error_thunk1(ScrClosure *cb, ScrStr *msg, ScrH2Session *session);
void scr_http2_session_error_thunk2(ScrClosure *cb, ScrStr *msg, ScrH2Session *session);
void scr_http2_session_on_connect(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrH2ConnectFn fn, bool once);
void scr_http2_session_on_stream(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrH2StreamFn fn, bool once);
void scr_http2_session_on_goaway(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrH2GoawayFn fn, bool once);
/* The settings surface: session.settings(obj[, cb]) sends a SETTINGS
 * frame; local/remote listener lists fire with the settings record on
 * ACK/receipt; the property reads answer the tracked records. */
void scr_http2_session_settings(ScrH2Session *s, const ScrDyn *settings /*borrowed, nullable*/,
                                 ScrClosure *cb /*moves, nullable*/, ScrH2SettingsFn cbfn);
void scr_http2_session_on_settings(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrH2SettingsFn fn,
                                    bool once, bool local);
ScrDyn *scr_http2_session_settings_get(ScrH2Session *s, bool local); /* +1 */
bool scr_http2_session_pending_settings_ack(ScrH2Session *s);
ScrDyn *scr_http2_get_default_settings(void); /* +1 */
void scr_http2_settings_thunk(ScrClosure *cb, ScrDyn *settings);
void scr_http2_settings_thunk0(ScrClosure *cb, ScrDyn *settings);
void scr_http2_session_settings_dyncb(ScrH2Session *s, const ScrDyn *settings /*borrowed*/,
                                       const ScrDyn *cb /*borrowed*/);
void scr_http2_session_on_settings_dyn(ScrH2Session *s, const ScrDyn *cb /*borrowed*/,
                                        bool once, bool local);
bool scr_http2_session_closed(ScrH2Session *s);
bool scr_http2_session_destroyed(ScrH2Session *s);
bool scr_http2_session_encrypted(ScrH2Session *s);
double scr_http2_session_type(ScrH2Session *s); /* 0 server / 1 client */
ScrStr *scr_http2_session_alpn(ScrH2Session *s); /* +1 */
ScrNetSocket *scr_http2_session_socket(ScrH2Session *s); /* +1, NULL after teardown */

/* stream */
void scr_http2_stream_respond(ScrH2Stream *st, ScrArr *pairs /*borrowed, nullable*/, bool end_stream);
void scr_http2_stream_write_str(ScrH2Stream *st, ScrStr *data /*borrowed*/);
void scr_http2_stream_write_bytes(ScrH2Stream *st, ScrBytes *data /*borrowed*/);
void scr_http2_stream_end(ScrH2Stream *st);
void scr_http2_stream_end_str(ScrH2Stream *st, ScrStr *data /*borrowed*/);
void scr_http2_stream_end_bytes(ScrH2Stream *st, ScrBytes *data /*borrowed*/);
void scr_http2_stream_close(ScrH2Stream *st, double code, ScrClosure *cb /*moves, nullable*/);
void scr_http2_stream_destroy(ScrH2Stream *st);
void scr_http2_stream_set_encoding(ScrH2Stream *st, ScrStr *enc /*borrowed*/); /* may throw */
ScrH2Stream *scr_http2_stream_set_encoding_ret(ScrH2Stream *st, ScrStr *enc /*borrowed*/); /* +1; may throw */
void scr_http2_stream_resume(ScrH2Stream *st);
void scr_http2_stream_pause(ScrH2Stream *st);
void scr_http2_stream_on_data(ScrH2Stream *st, ScrClosure *cb /*moves*/, ScrNetDataFn fn, bool once);
void scr_http2_stream_on_end(ScrH2Stream *st, ScrClosure *cb /*moves*/, bool once);
void scr_http2_stream_on_close(ScrH2Stream *st, ScrClosure *cb /*moves*/, bool once);
void scr_http2_stream_on_aborted(ScrH2Stream *st, ScrClosure *cb /*moves*/, bool once);
void scr_http2_stream_on_error(ScrH2Stream *st, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once);
void scr_http2_stream_on_response(ScrH2Stream *st, ScrClosure *cb /*moves*/, ScrH2RespFn fn, bool once);
double scr_http2_stream_id(ScrH2Stream *st);
double scr_http2_stream_rst_code(ScrH2Stream *st);
bool scr_http2_stream_destroyed(ScrH2Stream *st);
bool scr_http2_stream_closed(ScrH2Stream *st);
bool scr_http2_stream_aborted(ScrH2Stream *st);
bool scr_http2_stream_pending(ScrH2Stream *st);
ScrH2Session *scr_http2_stream_session(ScrH2Stream *st); /* +1 */

/* the emitted-adapter thunks (arity + record-building live program-side) */
void scr_http2_stream_thunk(ScrClosure *cb, ScrH2Stream *st, ScrArr *pairs, double flags);
void scr_http2_resp_thunk(ScrClosure *cb, ScrArr *pairs, double status, double flags);
void scr_http2_session_thunk(ScrClosure *cb, ScrH2Session *sess);
void scr_http2_session_thunk0(ScrClosure *cb, ScrH2Session *sess);
void scr_http2_connect_thunk2(ScrClosure *cb, ScrH2Session *sess, ScrNetSocket *sock);
void scr_http2_connect_thunk1(ScrClosure *cb, ScrH2Session *sess, ScrNetSocket *sock);
void scr_http2_connect_thunk0(ScrClosure *cb, ScrH2Session *sess, ScrNetSocket *sock);
void scr_http2_goaway_thunk2(ScrClosure *cb, double code, double last);
void scr_http2_goaway_thunk1(ScrClosure *cb, double code, double last);
void scr_http2_goaway_thunk0(ScrClosure *cb, double code, double last);

void scr_net_sock_set_native_established(ScrNetSocket *s, ScrNetNativeEventFn fn);

/* Registers the h2 session/stream dyn handle ops (the emitted main()
 * calls it when the unit is linked — the scr_net_dyn_install story). */
void scr_http2_dyn_install(void);

#ifdef SCR_RC_AUDIT
long scr_http2_live_count(void);
#endif

/* node:https (scr_tls.c — the http server/client over the TLS
 * transport; see the tls block above for the ownership story). */
ScrNetServer *scr_https_create_server(const char *cert, size_t cert_len, const char *key, size_t key_len, ScrClosure *handler /*moves*/, ScrHttpReqFn fn); /* +1 */
/* The runtime-options-record twin (the tls block's divergence-66 walk). */
ScrNetServer *scr_https_create_server_dyn(const struct ScrDyn *opts /*borrowed*/, ScrClosure *handler /*moves, nullable*/, ScrHttpReqFn fn); /* +1 or NULL+pending */
ScrHttpClientReq *scr_https_request(ScrStr *host /*borrowed*/, double port,
                                     ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                     double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                     bool auto_end, bool reject_unauthorized,
                                     const char *ca /*borrowed, len 0 = none*/, size_t ca_len,
                                     ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn); /* +1 */
/* The URL-string form (https.get('https://host/path')): scr_http.c's
 * shared parse, then the options form's dial with Node's no-options
 * defaults (verification on, the default trust anchors). Throws
 * catchably on an unparsable input or a non-https scheme. */
ScrHttpClientReq *scr_https_request_url(ScrStr *url /*borrowed*/, ScrStr *method /*borrowed*/,
                                         bool auto_end, ScrClosure *cb /*moves, nullable*/,
                                         ScrHttpRespFn fn); /* +1 */
/* The agent-threaded twin (the scr_http_request_agent story over TLS). */
ScrHttpClientReq *scr_https_request_agent(ScrStr *host /*borrowed*/, double port,
                                           ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                           double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                           bool auto_end, bool reject_unauthorized,
                                           const char *ca /*borrowed, len 0 = none*/, size_t ca_len,
                                           const struct ScrDyn *agent /*borrowed*/,
                                           ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn); /* +1 */
/* The fetch unit's https leg (defined in scr_tls.c): a client transport
 * context (SNI/verify against the URL hostname — the DIALED address may
 * be a resolved IP) plus the wrap hook scr_http_request_ex installs on
 * the fresh socket. The ctx moves into the transport at wrap time. */
void *scr_tls_fetch_client_ctx(ScrStr *host /*borrowed*/, bool reject_unauthorized);
void scr_tls_fetch_client_wrap(ScrNetSocket *sock, void *ctx);
/* The loop-side registration (scr_async.c, always linked): `pending`
 * joins the exhaustion test (a live handle keeps the process alive, like
 * Node's active TCP handles), `dispatch` runs at every turn top like the
 * events hook, and `pollfd` exposes the unit's poller fd so the idle
 * poll(2) sleep wakes on socket readiness (-1 = no fd yet). */
void scr_loop_set_net(bool (*pending)(void), void (*dispatch)(void), int (*pollfd)(void));
/* True when fibers are queued on the microtask ready queue — dispatch
 * hooks use it to yield between event batches so promise jobs interleave
 * (net's sweep/drain alternation). */
bool scr_loop_has_ready(void);

/* ── node:dgram + node:dns (scr_dgram.c — compiled only when the program
 * uses either; design note atop the file). One lean refcounted handle
 * kind (the netSocket ownership story: listeners MOVE in and drop at
 * settlement); dns.lookup rides the same unit — getaddrinfo runs AT CALL
 * TIME and the callback defers to the next loop turn. Self-contained: no
 * symbol here requires scr_net.c to link. */
typedef struct ScrDgramSocket ScrDgramSocket;
/* The message adapter: msg and the rinfo parts arrive BORROWED (multiple
 * listeners see the same datagram); adapters retain what they keep. */
typedef void (*ScrDgramMsgFn)(ScrClosure *cb, ScrBytes *msg, ScrStr *addr, ScrStr *family, double port, double size);
/* The dns.lookup adapter: errmsg is NULL on success; everything borrowed. */
typedef void (*ScrDnsLookupFn)(ScrClosure *cb, ScrStr *errmsg, ScrStr *addr, double family);

ScrDgramSocket *scr_dgram_retain(ScrDgramSocket *s);
void scr_dgram_release(ScrDgramSocket *s);
void *scr_dgram_retain_v(void *p);
void scr_dgram_release_v(void *p);

ScrDgramSocket *scr_dgram_create(bool reuse_addr); /* +1 */
/* bind/connect: host borrowed; "" binds 0.0.0.0 (bind's Node default).
 * The callback (nullable, moves) registers as once('listening') /
 * once('connect'). Both THROW Node's state errors on a bound/connected/
 * closed socket; runtime failures (EADDRINUSE) are the async 'error'. */
void scr_dgram_bind(ScrDgramSocket *s, double port, ScrStr *host /*borrowed*/, ScrClosure *cb /*moves, nullable*/);
void scr_dgram_connect(ScrDgramSocket *s, double port, ScrStr *host /*borrowed*/, ScrClosure *cb /*moves, nullable*/);
void scr_dgram_send_str(ScrDgramSocket *s, ScrStr *data /*borrowed*/, double port, ScrStr *host /*borrowed*/);
void scr_dgram_send_bytes(ScrDgramSocket *s, ScrBytes *data /*borrowed*/, double port, ScrStr *host /*borrowed*/);
/* The send argument-validation ladder over dyn arguments (Node's
 * signature shuffle, slice bounds, list/type contracts, port/address
 * validation, and the connected-state errors); a fully-validated
 * unconnected single-payload send RUNS, the rest meet the fence. */
void scr_dgram_send_chk(ScrDgramSocket *s, const ScrDyn *buffer, const ScrDyn *a1,
                        const ScrDyn *a2, const ScrDyn *a3, const ScrDyn *a4,
                        const ScrStr *fence);
/* address() parts: ip THROWS "Not running" before bind/connect (+1
 * otherwise); family/port are only called after ip succeeded. */
ScrStr *scr_dgram_addr_ip(ScrDgramSocket *s);     /* +1, may throw */
ScrStr *scr_dgram_addr_family(ScrDgramSocket *s); /* +1 */
double scr_dgram_addr_port(ScrDgramSocket *s);
void scr_dgram_close(ScrDgramSocket *s, ScrClosure *cb /*moves, nullable*/); /* throws on closed */
void scr_dgram_unref(ScrDgramSocket *s);
void scr_dgram_ref(ScrDgramSocket *s);
void scr_dgram_on_message(ScrDgramSocket *s, ScrClosure *cb /*moves*/, ScrDgramMsgFn fn, bool once);
void scr_dgram_on_error(ScrDgramSocket *s, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once);
void scr_dgram_on_listening(ScrDgramSocket *s, ScrClosure *cb /*moves*/, bool once);
void scr_dgram_on_close(ScrDgramSocket *s, ScrClosure *cb /*moves*/, bool once);
void scr_dgram_on_connect(ScrDgramSocket *s, ScrClosure *cb /*moves*/, bool once);
/* The runtime-provided message adapters (zero/one-param listeners; the
 * two-param rinfo shape is emitted per record shape). */
void scr_dgram_msg_thunk0(ScrClosure *cb, ScrBytes *msg, ScrStr *addr, ScrStr *family, double port, double size);
void scr_dgram_msg_thunk1(ScrClosure *cb, ScrBytes *msg, ScrStr *addr, ScrStr *family, double port, double size);
/* dns.lookup: hostname borrowed, family is 4 (AF_INET pinned by the
 * frontend), the callback moves. getaddrinfo runs NOW (blocking —
 * SEMANTICS.md); delivery defers to the next loop turn. */
void scr_dns_lookup(ScrStr *hostname /*borrowed*/, double family, ScrClosure *cb /*moves*/, ScrDnsLookupFn fn);
void scr_dns_thunk0(ScrClosure *cb, ScrStr *errmsg, ScrStr *addr, double family);
void scr_dgram_install(void);
#ifdef SCR_RC_AUDIT
long scr_dgram_live_count(void);
#endif
/* The loop-side registration (scr_async.c, always linked) — the net
 * hook's exact shape, one more nullable slot set. */
void scr_loop_set_dgram(bool (*pending)(void), void (*dispatch)(void), int (*pollfd)(void));

/* ── fs.watch (scr_watch.c — compiled only when the program uses it;
 * design note atop the file). FSWatcher handles over the unit's own
 * event backend (kqueue EVFILT_VNODE on macOS/BSD, inotify on Linux):
 * refcounted, listeners MOVE in (released at
 * close/exit — the child ownership story), an open watcher keeps the
 * loop alive until close() (Node's persistent default). */
typedef struct ScrWatcher ScrWatcher;
/* The event adapter: the name ("rename"/"change") arrives BORROWED
 * (static storage); adapters build what their listener declared. */
typedef void (*ScrWatchFn)(ScrClosure *cb, const char *event);

ScrWatcher *scr_watcher_retain(ScrWatcher *w);
void scr_watcher_release(ScrWatcher *w);
void *scr_watcher_retain_v(void *p);
void scr_watcher_release_v(void *p);

/* fs.watch(path, listener?) — path borrowed, the callback (nullable)
 * MOVES. Opens the path NOW and THROWS Node's fs error when it cannot
 * ("ENOENT: ..., watch 'x'" — the polling-fallback catch shape). +1. */
ScrWatcher *scr_fs_watch(ScrStr *path, ScrClosure *cb, ScrWatchFn fn);
void scr_watcher_close(ScrWatcher *w); /* idempotent */
/* The runtime-provided listener adapters (zero-param, and the one-param
 * (eventType: string) shape). */
void scr_watch_thunk0(ScrClosure *cb, const char *event);
void scr_watch_thunk_event(ScrClosure *cb, const char *event);
void scr_watch_install(void);
/* The loop-side registration (scr_async.c, always linked) — the net
 * hook's exact shape, one more nullable slot set. */
void scr_loop_set_watch(bool (*pending)(void), void (*dispatch)(void), int (*pollfd)(void));

/* ── node:test (scr_test.c — compiled only when the program imports it;
 * design note atop the file). Registration builds the test tree while
 * module bodies run (describe callbacks execute AT registration, Node's
 * collection phase); the first registration spawns the runner FIBER,
 * which parks one microtask hop and then runs every test sequentially
 * after main returns — sync bodies called on the fiber (its exception
 * cell isolates throws), async bodies awaited through their spawn
 * wrappers. Reporting is Node v24's spec-reporter shape on stdout;
 * durations are real (nondeterministic — harnesses normalize).
 * ScrStr arguments are BORROWED; closures MOVE. `mode`: 0 run, 1 skip,
 * 2 todo. `flags`: 1 = async body, 2 = body takes the TestContext,
 * 4 = { only: true }. `at` is "file:line:col" of the registration call
 * (the failing-section "test at" line), "" when unknown. */
typedef struct ScrTestCtx ScrTestCtx;
ScrTestCtx *scr_testctx_retain(ScrTestCtx *t);
void scr_testctx_release(ScrTestCtx *t);
void *scr_testctx_retain_v(void *t);
void scr_testctx_release_v(void *t);
void scr_test_register(ScrStr *name, double mode, ScrStr *msg, ScrClosure *cb, double flags, ScrStr *at);
void scr_test_suite(ScrStr *name, double mode, ScrStr *msg, ScrClosure *cb, ScrStr *at);
/* before/after/beforeEach/afterEach on the CURRENT registration parent
 * (`which`: 0 before, 1 after, 2 beforeEach, 3 afterEach). */
void scr_test_hook(double which, ScrClosure *cb, double flags);
/* t.test(...): registers under `t`, runs the subtest INLINE on the
 * runner fiber, and returns the settled promise the `await` consumes (+1). */
ScrPromise *scr_test_sub(ScrTestCtx *t, ScrStr *name, double mode, ScrStr *msg, ScrClosure *cb, double flags, ScrStr *at);
void scr_test_ctx_skip(ScrTestCtx *t, ScrStr *msg);
void scr_test_ctx_todo(ScrTestCtx *t, ScrStr *msg);
void scr_test_ctx_diagnostic(ScrTestCtx *t, ScrStr *msg);
ScrStr *scr_test_ctx_name(ScrTestCtx *t); /* +1 */
/* Main's epilogue (emitted when moduleUsesNodeTest): 1 when any non-todo
 * test failed, Node's exit contract. */
int scr_test_exit_code(void);
#ifdef SCR_RC_AUDIT
long scr_testctx_live_count(void);
#endif

/* ── node:assert (scr_assert.c; scr_assert_match lives in scr_regex.c —
 * it needs the matcher, and every assert.match site carries a regex, so
 * the regex link switch is already on). Failures throw a catchable
 * AssertionError (%Error with name "AssertionError", code
 * "ERR_ASSERTION"); the exception is pending on return, the fs pattern.
 * Generated messages are Node's assertion_error.js scalar forms exactly
 * (the design note atop scr_assert.c lists the documented divergences).
 * All ScrStr/ScrError/ScrRegex arguments are BORROWED. `has_msg`
 * distinguishes an omitted user message from an empty one (Node treats
 * them differently per operator). */
void scr_assert_fail_msg(ScrStr *message); /* takes ownership; always throws */
ScrStr *scr_assert_inspect_str(const ScrStr *s); /* util.inspect quoting; +1 */
void scr_assert_ok(bool pass, ScrStr *message);
bool scr_assert_same_value_f64(double a, double b); /* Object.is */
/* deepStrictEqual over cyclic values: pair memo (enter answers true for
 * a pair already being compared — Node's coinductive memo; leave pops).
 * The compiler-emitted helpers over cycle-capable types wrap with these. */
bool scr_assert_deq_enter(const void *a, const void *b);
void scr_assert_deq_leave(void);
void scr_assert_eq_f64(double a, double b, bool negated, bool deep, ScrStr *msg, bool has_msg);
void scr_assert_eq_str(ScrStr *a, ScrStr *b, bool negated, bool deep, ScrStr *msg, bool has_msg);
void scr_assert_eq_bool(bool a, bool b, bool negated, bool deep, ScrStr *msg, bool has_msg);
void scr_assert_deep_result(bool equal, bool negated, ScrStr *msg, bool has_msg);
/* deepStrictEqual's verdict over two typed-array/Buffer values of one
 * static elem kind: brands_eq (Node compares prototypes — Buffer vs
 * Uint8Array differ; a compile-time answer from the two arguments' checker
 * types) AND same element count AND byte-identical storage. Both sides
 * always evaluate (they are ordinary borrowed arguments), so a
 * compile-time brand mismatch still runs their side effects. Never
 * throws. */
bool scr_assert_bytes_deep_eq(const ScrBytes *a, const ScrBytes *b, bool brands_eq);
/* strictEqual/notStrictEqual over bytes values: reference identity
 * (Object.is on objects), with Node's object-comparison headers —
 * "Values have same structure but are not reference-equal:" when the
 * contents (and static brands) match, the reference-equal expectation
 * header otherwise. Header-only messages, the composite stance
 * (SEMANTICS.md 102). Borrows a/b/msg; throws on the failing verdict. */
void scr_assert_ref_eq_bytes(const ScrBytes *a, const ScrBytes *b, bool negated,
                             bool brands_eq, ScrStr *msg, bool has_msg);
/* strictEqual/notStrictEqual over function values: reference identity
 * with the same object-comparison headers (two distinct functions are
 * never structure-equal, so the failing equal form always expects
 * reference equality). Header-only messages (SEMANTICS.md 102). */
void scr_assert_ref_eq_fn(const ScrClosure *a, const ScrClosure *b, bool negated,
                          ScrStr *msg, bool has_msg);
/* The failing-EQUAL-operator message assembler (createErrDiff's scalar
 * slice): exported for the spoke files that carry their own value
 * inspection (scr_symbol.c's symbol comparison — the assert.match
 * precedent). `ia`/`ib` are the inspected actual/expected bytes;
 * `quotes` counts string-typed sides (2 quote chars each, excluded from
 * the 12-char short-form budget); `strings` enables the stacked form's
 * first-difference `^` indicator. Throws; borrows msg. */
void scr_assert_eq_fail(const char *ia, size_t la, const char *ib, size_t lb,
                        int quotes, bool both_zero, bool strings, bool deep,
                        ScrStr *msg, bool has_msg);
/* The failing NOT-equal-operator twin: `insp` is the inspected actual. */
void scr_assert_neq_fail(const char *insp, size_t ilen, bool deep,
                         ScrStr *msg, bool has_msg);
/* strictEqual/notStrictEqual/deepStrictEqual/notDeepStrictEqual where
 * either operand is a checked-dynamic value (the frontend boxes a static
 * side into the checked-dynamic tree first). Strict pair: SameValue over the dyn kinds —
 * Object.is numbers, byte-equal strings, units by kind, node identity
 * for arrays/objects/bytes, BOXED-CLOSURE identity for functions. Deep
 * pair: the structural dyn walk (per-element arrays, key-set objects,
 * brand-aware bytes via the buffer flavor bit, closure identity for
 * functions). Generated messages reproduce assertion_error.js — the
 * scalar simple/stacked forms byte-exactly, composite values rendered
 * compact:false/sorted through the checked-dynamic tree and diffed with the real myers
 * line printer (the design note atop scr_assert.c's dyn section lists
 * the divergences). Borrows everything; throws on the failing verdict. */
void scr_assert_eq_dyn(ScrDyn *a, ScrDyn *b, bool negated, bool deep,
                       ScrStr *msg, bool has_msg);
/* assert.throws / assert.rejects whose callback returned (or whose
 * promise fulfilled): "Missing expected exception|rejection" with Node's
 * details — ` (${expected.name})` when the expected class/shape carries a
 * name (has_ename), then `: message` or `.`. */
/* Node's expectsError over an error-INSTANCE expected: the expected dyn
 * error's keys (minus the %error marker) each deep-compare against the
 * caught value's; mismatches throw the deep-equal AssertionError. */
void scr_assert_expects_err_dyn(ScrDyn *actual, ScrDyn *expected, ScrStr *msg, bool has_msg);
void scr_assert_throws_none(bool rejection, ScrStr *ename, bool has_ename,
                            ScrStr *msg, bool has_msg);
void scr_assert_throws_mismatch(ScrStr *expected_name, ScrError *err,
                                ScrStr *msg, bool has_msg);
/* assert.throws(fn, <object shape>) — Node's expectedException over the
 * static error surface (name/message/code). A tiny per-call accumulator:
 * begin stashes the caught error, each slot call adds one expected key
 * (key ids: 0 code, 1 message, 2 name — inspect's SORTED render order),
 * and end runs the comparison, throwing Node's deep-equal Comparison
 * diff (byte-exact: the bounded key set makes the full rendering
 * enumerable) or the custom message. Regex-valued slots enter
 * through scr_regex.c (scr_assert_shape_re) which tests eagerly and
 * stores the verdict + rendered source, so this file stays libregexp-free;
 * scr_assert_shape_actual is its borrowed key-value getter (NULL =
 * absent). Straight-line calls between begin and end — no fiber
 * suspension, so the accumulator is safely a static. */
void scr_assert_shape_begin(ScrError *err);
void scr_assert_shape_str(int key, ScrStr *v);
void scr_assert_shape_slot_re(int key, bool matched, ScrStr *rendered /* moves */);
ScrStr *scr_assert_shape_actual(int key); /* borrowed; NULL = absent */
void scr_assert_shape_end(ScrStr *msg, bool has_msg);
/* assert.doesNotReject whose rejection MATCHED (or had no expected):
 * "Got unwanted rejection[: message].\nActual message: \"...\"". */
void scr_assert_unwanted_rejection(ScrError *err, ScrStr *msg, bool has_msg);
/* assert.ifError over the static surface: throws for ANY value the
 * frontend routes here (Node: everything but null/undefined, falsy
 * included) — "ifError got unwanted exception: " + the error's message
 * (its name when the message is empty — Node reads constructor.name,
 * identical for the builtin hierarchy, SEMANTICS.md 105's stance for
 * subclasses) or the value's inspection. */
void scr_assert_iferror_err(ScrError *err);
void scr_assert_iferror_f64(double x);
void scr_assert_iferror_str(ScrStr *s);
void scr_assert_iferror_bool(bool b);
/* The checked-dynamic argument: dyn-kind dispatch — units pass quietly,
 * %error-marked objects throw with the error's message, everything else
 * with the inspection. */
void scr_assert_iferror_dyn(const ScrDyn *v);
/* assert.match / assert.doesNotMatch (scr_regex.c): a fresh exec from
 * index 0 — Node's exec on a fresh regex; lastIndex statefulness is not
 * modeled (SEMANTICS.md's regex stance), so g/y-flagged regexes test like
 * their flag-free twins instead of aborting. */
void scr_assert_match(ScrStr *s, ScrRegex *re, bool negated, ScrStr *msg, bool has_msg);
/* assert.throws(fn, /regex/) whose thrown ERROR did not match: Node tests
 * String(actual) ("Name: message") and reports the regex-mismatch message
 * with the input inspected (scr_regex.c). Passing calls return. */
void scr_assert_throws_regex(ScrRegex *re, ScrError *err, ScrStr *msg, bool has_msg);
/* assert.throws(fn, {message: /re/, ...}): the regex-valued shape slot —
 * tests the stashed actual key eagerly, stores verdict + rendered
 * /source/flags into the accumulator (scr_regex.c). */
void scr_assert_shape_re(int key, ScrRegex *re);
/* assert.doesNotReject's regex predicate over String(error) — never
 * throws (scr_regex.c). */
bool scr_assert_regex_err_test(ScrRegex *re, ScrError *err);
/* strictEqual/notStrictEqual/deep twins over symbol values: pointer
 * identity (a symbol IS its identity), messages from the symbols'
 * "Symbol(desc)" rendering — string-style stacked diffs with the `^`
 * first-difference indicator, v24 exactly (scr_symbol.c). */
void scr_assert_eq_sym(ScrSym *a, ScrSym *b, bool negated, bool deep,
                       ScrStr *msg, bool has_msg);

/* ── console ──────────────────────────────────────────────────────────── */

typedef struct {
  enum { SCR_ARG_F64, SCR_ARG_STR, SCR_ARG_BOOL } tag;
  union {
    double f;
    ScrStr *s;
    bool b;
  } v;
} ScrLogArg;

/* Space-joined args + '\n', submitted before return. Borrows string args. */
void scr_console_log(size_t n, const ScrLogArg *args);
/* The stderr twin (console.error AND console.warn — one stream in Node):
 * identical formatting, with stdout settled first so merged (2>&1) output
 * keeps source order. */
void scr_console_error(size_t n, const ScrLogArg *args);

#endif /* SCR_RUNTIME_H */
