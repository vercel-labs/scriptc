/* scriptc runtime — libc shims, runtime instance state, process entry, the
 * trap funnel, library mode and host-callback channels (scr_console.c,
 * scr_library.c, scr_context.c). Included by scr_runtime.h, which says where
 * new declarations go. */
#ifndef SCR_CORE_H
#define SCR_CORE_H

#include <stdarg.h>  /* va_list in the emitter listener adapters */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>    /* memcpy in the inline slot accessors */
#include <sys/types.h> /* ssize_t in the transport ops table */

/* ── libc shims ─────────────────────────────────────────────────────────
 * Win32's missing POSIX/BSD functions live in scr_win.c. Zig's musl sysroot
 * additionally lacks arc4random_buf; scr_musl.c supplies it from Linux's
 * getrandom syscall. Both files are selected by native-toolchain.ts only for their target. */
#if defined(_WIN32) && defined(_MSC_VER)
/* MSVC's C headers do not define POSIX ssize_t. Keep the runtime's byte-count
 * interfaces pointer-sized on Windows without requiring a Windows SDK header
 * (and leave the Zig/MinGW compatibility route's native typedef intact). */
typedef intptr_t ssize_t;
#endif
#ifdef _WIN32
#include <time.h> /* time_t / struct tm for the gmtime_r shim */
char *stpcpy(char *dst, const char *src);
void arc4random_buf(void *buf, size_t n);
struct tm *gmtime_r(const time_t *t, struct tm *out);
char *strcasestr(const char *hay, const char *needle);
#elif defined(SCR_MUSL)
void arc4random_buf(void *buf, size_t n);
#endif

/* ── runtime instance state ─────────────────────────────────────────────
 * Archives built under the profile's abi.instance_per_thread compile every
 * TU with -DSCR_THREAD_INSTANCES, and SCR_TL moves each unit's mutable
 * state — and the emitted program's globals — into thread-local storage.
 * A thread that calls the profile's init entry then owns a complete,
 * independent instance: its own collector, result arena, panic-sink
 * registration, poison flag, and program state. The instance's lifetime is
 * the thread's; the one-thread-per-instance contract (an instance is never
 * entered from two threads) is unchanged — this mode adds instances, not
 * thread awareness. Worker executables use the same isolation for their
 * collectors, caches and scheduler state. Expands to nothing for ordinary
 * executables and classic libraries. Immutable tables stay shared. */
#if (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES)) || defined(SCR_WORKERS)
#define SCR_TL _Thread_local
#else
#define SCR_TL
#endif

/* Entry points that only run when a JS exception is being raised. noinline
 * keeps the throw machinery out of every caller: the LLVM helper never
 * imports noinline runtime bodies into program code, so a compiled function
 * whose only slow path throws stays small enough to inline and needs no
 * callee-saved registers on its fast path. cold tells the C compiler that
 * runtime paths reaching them are unlikely. */
#if defined(__GNUC__) || defined(__clang__)
#define SCR_COLD __attribute__((cold, noinline))
#else
#define SCR_COLD
#endif

/* Digest compression functions start on a cache line. The release
 * runtime keeps the compiler's default function alignment, so without it
 * their speed moves with the size of unrelated code before them. WASM
 * code has no addresses to align. */
#if (defined(__GNUC__) || defined(__clang__)) && !defined(__wasm__)
#define SCR_DIGEST_ALIGNED __attribute__((aligned(64)))
#else
#define SCR_DIGEST_ALIGNED
#endif

/* ── process ──────────────────────────────────────────────────────────── */

/* Called once at the top of main: private stdout formatter buffer,
 * flush-at-exit, RC audit registration (when built with -DSCR_RC_AUDIT).
 * JavaScript-visible writes flush before returning. */
void scr_init(void);
/* Program objects emitted by the bundled LLVM helper reference this symbol.
 * Its versioned spelling makes a mismatched manual runtime link fail before
 * the program can start. */
void scr_runtime_abi_v42(void);
void scr_runtime_workers_v8(void);

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

/* glibc added arc4random_buf in 2.36. Older GNU targets use the same kernel
 * CSPRNG as the musl shim, with no global state or persistent descriptor. */
#ifdef __GLIBC__
#if !__GLIBC_PREREQ(2, 36)
#include <errno.h>
#include <stdlib.h>
#include <sys/random.h>
static inline void scr_glibc_random_buf(void *buf, size_t n) {
  unsigned char *p = buf;
  while (n > 0) {
    ssize_t got = getrandom(p, n, 0);
    if (got > 0) {
      p += (size_t)got;
      n -= (size_t)got;
    } else if (got < 0 && errno == EINTR) {
      continue;
    } else {
      scr_trap("scriptc: getrandom failed\n");
    }
  }
}
#define arc4random_buf scr_glibc_random_buf
#endif
#endif
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
 * the SC4025 unregistered-callback and SC4026 callback-re-entry traps,
 * classified in scr_library.c), the
 * entry symbol recorded by the trapping
 * entry's prologue, and the profile's remediation for that code when the
 * program TU's overlay table declares one (the whole fourth field is
 * absent otherwise). A message that already begins with the marker — a
 * facade-authored structured throw, or the wrapper's compile-time-
 * assembled SC4012 contract trap — passes through unchanged. */
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
 * registrations persist across init/reset. While a host callback is active,
 * its registration entry is rejected before name dispatch or a store, just
 * like every runtime-touching ABI entry. Slots are per-copy of this
 * state, exactly the sink's story: per-archive under abi.localize_runtime,
 * per-thread instance under abi.instance_per_thread (SCR_TL) — a callback
 * registered on thread T fires only for T's instance. The host's callback
 * runs on the calling thread inside the entry's dynamic extent and must
 * NOT call back into any library entry (exports, init, reset, collect, sink
 * registration, or callback registration) or unwind/longjmp across library
 * frames: read the borrowed buffers, copy what outlives the call, return.
 * A re-entry is a detected SC4026 trap: it poisons only this library
 * instance, delivers exactly once to the already-registered sink, names the
 * attempted inner ABI symbol in structured field 2, then aborts if the sink
 * returns. A later host-loop turn may enter normally after the callback has
 * returned. Buffer parameters are borrowed for the duration of the call
 * only. */
#define SCR_LIB_MAX_CALLBACKS 32 /* keep in step with LIB_MAX_CALLBACKS (library/library-profile.ts) */
/* The stored shape: generated call sites cast a slot's pointer to the
 * channel's typed shape before calling. */
typedef void (*ScrLibCbFn)(void);
void scr_library_cb_set(size_t slot, ScrLibCbFn fn, void *ctx);
/* The call-site fetch: the registered pointer, or the funnel trap with
 * trap_msg (never returns NULL). */
ScrLibCbFn scr_library_cb_require(size_t slot, const char *trap_msg);
void *scr_library_cb_ctx(size_t slot);
/* Generated typed call sites bracket only the actual host-function call.
 * End is reached only after a normal return; an illegal unwind deliberately
 * leaves the depth active so the next ABI entry is rejected. */
void scr_library_callback_begin(void);
void scr_library_callback_end(void);
/* Registration wrappers bypass scr_library_entry because their normal path
 * is a pure store. They call this first so callback-time registration is
 * rejected before dispatch, NULL handling, or mutation. */
void scr_library_callback_entry_guard(const char *entry_symbol);

/* Entry prologue: aborts deterministically when the library is poisoned (a
 * trap already fired — no profile entry may run again; recovery is process
 * restart). reset_arena additionally drops the result arena (the
 * auto-reset posture, and the reset/collect entries' shared body).
 * entry_symbol is the generated entry's external symbol exactly as the
 * host linked it (a static string in the program TU): the prologue records
 * it in the funnel's current-entry slot so a detected trap's structured
 * message can name the trapping entry. A host callback's attempted nested
 * entry is rejected first and replaces this slot with that inner symbol.
 * Init and the mode entries (reset, collect) record theirs too. The two
 * profile identity getters are the explicit pure-data exception: they touch
 * no mutable runtime state and remain callable before init and after poison. */
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
 * starts with it) is delivered unchanged — no "Uncaught " prefix, no
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
 * (the SC4013–SC4019 family plus SC4025 and SC4026) the profile declares
 * text for;
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
 * assembled SC4012 message shape as the bytes trap) past it — rounding
 * without a diagnostic is a coercion the author never wrote. */
double scr_library_i64_in(int64_t v, const char *trap_msg);
double scr_library_u64_in(uint64_t v, const char *trap_msg);
void scr_library_str_out(ScrStr *s, const uint8_t **out, size_t *out_len);
void scr_library_bytes_out(ScrBytes *b, const uint8_t **out, size_t *out_len);
/* The cstring class (a NUL-terminated `const char *`). Inbound: a copy
 * decoded as UTF-8 with U+FFFD replacement; NULL delivers trap_msg (the
 * assembled SC4012 message). Outbound results move into the arena and
 * return their data; callback arguments return the string's own data,
 * borrowed for the call. A string containing U+0000 cannot be a C string:
 * both outbound forms trap instead of truncating. */
ScrStr *scr_library_cstr_in(const char *p, const char *trap_msg); /* +1 */
const char *scr_library_cstr_out(ScrStr *s);
const char *scr_library_cstr_arg(const ScrStr *s);

#define scr_atexit(fn) scr_library_register_reset(fn)
#elif defined(SCR_WORKERS)
/* Executable workers drain their own cleanup stack before their TLS dies.
 * Registering their callbacks with libc would execute them on the process
 * exit thread against a different runtime instance. */
int scr_context_atexit(void (*fn)(void));
void scr_context_cleanup(void);
void scr_context_enter(uint64_t thread_id);
uint64_t scr_context_thread_id(void);
void scr_context_stop_flag(const void *flag);
void scr_context_stop(int code);
bool scr_context_stopping(void);
bool scr_context_checkpoint(void);
bool scr_context_quiet(void);
#if !defined(__APPLE__) && !defined(_WIN32) && !defined(__CYGWIN__) && !defined(__wasi__)
/* ELF worker executables (the LLVM emitter's executableTls targets): every
 * script thread owns an exact pending word in the executable's static TLS
 * block, which emitted pending checks load with one thread-pointer-relative
 * access and no out-of-line slow path (scr_exception.c). */
#define SCR_EXC_FLAG 1
#define SCR_EXC_FLAG_PENDING 1u /* the active cell's kind is not NONE */
#define SCR_EXC_FLAG_STOP 2u    /* the context must stop (never cleared) */
extern SCR_TL _Atomic uint32_t scr_exc_flag;
/* Requests the stop of the thread that owns `flag` (scr_worker.c holds the
 * owner's word only while its script runs). */
void scr_exc_flag_request_stop(_Atomic uint32_t *flag);
#else
/* The process-wide exception alert that emitted pending checks of other
 * worker executables test inline (scr_exception.c): nonzero while some
 * script thread may have an exception pending in its active cell or must
 * stop. */
extern _Atomic uint32_t scr_exc_alert;
void scr_exc_alert_add(int delta); /* worker.terminate() references */
#endif
void scr_exc_alert_thread_exit(void);
void scr_loop_context_shutdown(void);
extern SCR_TL void (*scr_context_report_error)(void);
/* Set while scr_context_report_error reports an unhandled rejection. */
extern SCR_TL bool scr_context_report_rejection;
typedef struct ScrContextEnv ScrContextEnv;
ScrContextEnv *scr_context_env_capture(void);
void scr_context_env_free(ScrContextEnv *environment);
void scr_context_env_enter(ScrContextEnv *environment);
bool scr_context_env_set(const char *name, const char *value);
const char *scr_context_getenv(const char *name);
struct ScrArr *scr_context_env_pairs(void);
#define scr_atexit(fn) scr_context_atexit(fn)
#else
#define scr_atexit(fn) atexit(fn)
#endif /* SCR_LIB */

/* Also used by ordinary event-loop builds, where this always returns true. */
bool scr_context_is_main(void);

/* Whether the calling thread frees what the program still holds when its
 * script ends: module globals, the final cycle collection, collector
 * buffers. Worker threads do (a later thread reuses their arena), and so
 * does every thread of a build that checks for leaks (the RC audit,
 * AddressSanitizer) or of a process run with SCRIPTC_EXIT_FREE=1. The main
 * thread of other builds leaves its heap to the operating system, which
 * reclaims it at exit. Exit listeners and output flushing run either way. */
bool scr_exit_frees(void);
#ifdef SCR_WORKERS
/* The time the calling thread's script ended (scr_hrtime_ns; 0 until then),
 * recorded by scr_exit_frees for SCRIPTC_WORKER_STATS. */
void scr_context_note_script_end(void);
uint64_t scr_context_script_end_ns(void);
#endif

/* Native stack guard. Compiled functions that can recurse compare their
 * stack pointer against scr_stack_guard on entry and throw Node's catchable
 * RangeError below it. The guard sits a reserve above the lowest usable
 * address of the running stack (thread or async fiber), leaving room for the
 * throw, unwinding, finally blocks, catch handlers and the uncaught-error
 * report. Zero (the default) disables the check on that stack. */
extern SCR_TL uintptr_t scr_stack_guard;
void scr_stack_guard_init(void);
SCR_COLD void scr_stack_overflow(void);
#if defined(SCR_WORKERS) && !defined(SCR_LIB) && defined(__APPLE__) && \
    (defined(__aarch64__) || defined(__x86_64__))
/* Darwin worker executables: reading a thread-local variable calls its TLV
 * thunk, so the emitted entry checks read the running stack's guard from a
 * pthread thread-specific-data slot instead, addressed from the thread
 * pointer (TPIDRRO_EL0 on arm64, %gs on x86-64) plus this byte offset.
 * scr_stack_guard_init validates the slot on first use; zero means the
 * direct read is unavailable and the checks call scr_stack_guard_get. */
#define SCR_STACK_GUARD_TSD 1
extern uintptr_t scr_stack_guard_tsd;
uintptr_t scr_stack_guard_get(void);
void scr_stack_guard_set(uintptr_t guard);
#define SCR_STACK_GUARD_SET(guard) scr_stack_guard_set(guard)
#else
#define SCR_STACK_GUARD_SET(guard) (scr_stack_guard = (guard))
#endif
#if defined(__has_feature)
#if __has_feature(address_sanitizer)
#define SCR_STACK_RESERVE_MAX ((size_t)2 << 20)
#endif
#endif
#ifndef SCR_STACK_RESERVE_MAX
#define SCR_STACK_RESERVE_MAX ((size_t)256 << 10)
#endif
static inline uintptr_t scr_stack_guard_for(uintptr_t low, size_t size) {
  size_t reserve = size / 4;
  if (reserve > SCR_STACK_RESERVE_MAX) reserve = SCR_STACK_RESERVE_MAX;
  return low + reserve;
}
double scr_context_thread_number(void);
double scr_worker_root(void);
int scr_worker_argc(void);
char **scr_worker_argv(void);

#ifdef SCR_WORKERS
#define scr_getenv(name) scr_context_getenv(name)
#else
#define scr_getenv(name) getenv(name)
#endif

#endif /* SCR_CORE_H */
