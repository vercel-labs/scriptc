/* scr_unwind_raise: the native unwind of the unwinding exception ABI of
 * emitted functions (the compiler's unwind-abi.ts). Linux (glibc and musl)
 * only; elsewhere this unit is empty. */
#include "scr_runtime.h"

#if defined(__linux__) && !defined(__ANDROID__) && !defined(__wasi__)
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unwind.h>

/* Weak, so the runtime unit alone does not link the unwinder into every
 * program: programs that raise reference the personality routine from
 * their landing pads, and its unit references the unwinder's entry points,
 * which link it in. */
#pragma weak _Unwind_ForcedUnwind
#pragma weak _Unwind_GetCFA

#if defined(__SANITIZE_ADDRESS__)
#define SCR_UNWIND_ASAN 1
#elif defined(__has_feature)
#if __has_feature(address_sanitizer)
#define SCR_UNWIND_ASAN 1
#endif
#endif
#ifdef SCR_UNWIND_ASAN
#include <sanitizer/asan_interface.h>
#endif

#ifdef SCR_UNWIND_ASAN
/* The lowest stack address the unwind has not cleared yet. The unwind
 * outlives the frame that started it: landing pads resume it. */
static SCR_TL uintptr_t scr_unwind_low;
#endif

/* Emitted landing pads are cleanups: they release the frame's references
 * and then either take the exception (a handler of theirs, or a frame on
 * the pending-flag ABI that returns with it pending) or resume the unwind.
 * So the unwind is forced, a single pass through every landing pad; the
 * exception itself stays in the active cell. */
static _Unwind_Reason_Code scr_unwind_stop(int version, _Unwind_Action actions,
                                           _Unwind_Exception_Class cls,
                                           struct _Unwind_Exception *exc,
                                           struct _Unwind_Context *context, void *arg) {
  (void)version;
  (void)cls;
  (void)exc;
#ifdef SCR_UNWIND_ASAN
  /* The frames this unwind passes never return, so it clears their
   * redzones' shadow itself. Emitted code calls scr_unwind_raise as an
   * ordinary function: the sanitizer's hook before no-return calls needs
   * stack bounds, which fiber stacks do not report. */
  uintptr_t cfa = _Unwind_GetCFA(context);
  if (cfa > scr_unwind_low) {
    __asan_unpoison_memory_region((void *)scr_unwind_low, cfa - scr_unwind_low);
    scr_unwind_low = cfa;
  }
#else
  (void)context;
#endif
  (void)arg;
  if (actions & _UA_END_OF_STACK) {
    fputs("scriptc: an exception unwound past the program's outermost frame\n", stderr);
    abort();
  }
  return _URC_NO_REASON;
}

static SCR_TL struct _Unwind_Exception scr_unwind_exception;

void scr_unwind_raise(void) {
  struct _Unwind_Exception *exc = &scr_unwind_exception;
  memset(exc, 0, sizeof *exc);
  exc->exception_class = 0x5343524950540000ull; /* "SCRIPT\0\0" */
#ifdef SCR_UNWIND_ASAN
  scr_unwind_low = (uintptr_t)__builtin_frame_address(0);
#endif
  if (_Unwind_ForcedUnwind != NULL) _Unwind_ForcedUnwind(exc, scr_unwind_stop, NULL);
  fputs("scriptc: the native unwinder could not raise an exception\n", stderr);
  abort();
}
#endif
