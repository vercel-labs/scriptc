/* musl libc shim — compiled into linux-musl target builds only (cc.ts adds
 * this TU together with -DSCR_MUSL). musl deliberately provides no libc
 * identification macro, so the target-selected project macro is the guard.
 *
 * The x86_64 and AArch64 ucontext implementations below are derived from libucontext
 * commit 49e671dd52ff6791295d8161ad3b6da7dc5f6f9d:
 * https://github.com/kaniini/libucontext
 *
 * Copyright (c) 2018-2025 Ariadne Conill <ariadne@dereferenced.org>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * This software is provided 'as is' and without any warranty, express or
 * implied. In no event shall the authors be liable for any damages arising
 * from the use of this software. */
#ifdef SCR_MUSL

#include "scr_runtime.h"

#include <errno.h>
#include <stdlib.h>
#include <sys/random.h>
#ifndef SCR_LIB
#include <stdarg.h>
#include <ucontext.h>
#endif

#if !defined(__x86_64__) && !defined(__aarch64__)
#error "scriptc's musl runtime currently supports x86_64 and AArch64 only"
#endif

/* The scriptc runtime uses arc4random_buf as its infallible CSPRNG contract.
 * Linux getrandom has the same kernel source and needs neither mutable state
 * nor an fd. Retry interrupts and short reads; any other failure enters the
 * runtime trap funnel rather than returning predictable or partially
 * initialized bytes. Executables still print and abort there, while library
 * artifacts deliver the failure to their registered panic sink. */
void arc4random_buf(void *buf, size_t n) {
  unsigned char *p = buf;
  while (n > 0) {
    ssize_t got = getrandom(p, n, 0);
    if (got > 0) {
      p += (size_t)got;
      n -= (size_t)got;
      continue;
    }
    if (got < 0 && errno == EINTR) continue;
    scr_trap("scriptc: getrandom failed\n");
  }
}

/* Library artifacts contain no fibers or event loop, so they need only the
 * CSPRNG shim above and must not acquire context-switching definitions. */
#ifndef SCR_LIB

/* musl exposes the POSIX ucontext types but intentionally omits these legacy
 * functions. scriptc's async/generator fibers need only user-space register
 * swaps; they never use a context to mutate the process signal mask. These are
 * libucontext's fast (non-POSIX-signal-mask) implementations, emitted under
 * the standard symbol names that musl leaves unresolved. */
#if defined(__x86_64__)
_Static_assert(offsetof(ucontext_t, uc_mcontext.gregs) == 40,
               "unexpected musl x86_64 ucontext layout");
_Static_assert(offsetof(ucontext_t, uc_mcontext.fpregs) == 224,
               "unexpected musl x86_64 fpregs layout");
_Static_assert(offsetof(ucontext_t, __fpregs_mem) == 424,
               "unexpected musl x86_64 fpregs storage layout");

/* Keep the assembler independent of whether the sysroot exposes glibc's
 * REG_* spellings as enum constants, self-referential macros, or neither. */
#undef REG_R8
#undef REG_R9
#undef REG_R10
#undef REG_R11
#undef REG_R12
#undef REG_R13
#undef REG_R14
#undef REG_R15
#undef REG_RDI
#undef REG_RSI
#undef REG_RBP
#undef REG_RBX
#undef REG_RDX
#undef REG_RAX
#undef REG_RCX
#undef REG_RSP
#undef REG_RIP
#define REG_R8 0
#define REG_R9 1
#define REG_R10 2
#define REG_R11 3
#define REG_R12 4
#define REG_R13 5
#define REG_R14 6
#define REG_R15 7
#define REG_RDI 8
#define REG_RSI 9
#define REG_RBP 10
#define REG_RBX 11
#define REG_RDX 12
#define REG_RAX 13
#define REG_RCX 14
#define REG_RSP 15
#define REG_RIP 16

#define SCR_STR_INNER(x) #x
#define SCR_STR(x) SCR_STR_INNER(x)
#define SCR_UC_GREG(reg) (40 + ((reg) * 8))

__asm__(
    ".text\n"
    ".global getcontext\n"
    "getcontext:\n"
    "  movq %r8, "  SCR_STR(SCR_UC_GREG(REG_R8))  "(%rdi)\n"
    "  movq %r9, "  SCR_STR(SCR_UC_GREG(REG_R9))  "(%rdi)\n"
    "  movq %r10, " SCR_STR(SCR_UC_GREG(REG_R10)) "(%rdi)\n"
    "  movq %r11, " SCR_STR(SCR_UC_GREG(REG_R11)) "(%rdi)\n"
    "  movq %r12, " SCR_STR(SCR_UC_GREG(REG_R12)) "(%rdi)\n"
    "  movq %r13, " SCR_STR(SCR_UC_GREG(REG_R13)) "(%rdi)\n"
    "  movq %r14, " SCR_STR(SCR_UC_GREG(REG_R14)) "(%rdi)\n"
    "  movq %r15, " SCR_STR(SCR_UC_GREG(REG_R15)) "(%rdi)\n"
    "  movq %rdi, " SCR_STR(SCR_UC_GREG(REG_RDI)) "(%rdi)\n"
    "  movq %rsi, " SCR_STR(SCR_UC_GREG(REG_RSI)) "(%rdi)\n"
    "  movq %rbp, " SCR_STR(SCR_UC_GREG(REG_RBP)) "(%rdi)\n"
    "  movq %rbx, " SCR_STR(SCR_UC_GREG(REG_RBX)) "(%rdi)\n"
    "  movq %rdx, " SCR_STR(SCR_UC_GREG(REG_RDX)) "(%rdi)\n"
    "  movq %rax, " SCR_STR(SCR_UC_GREG(REG_RAX)) "(%rdi)\n"
    "  movq %rcx, " SCR_STR(SCR_UC_GREG(REG_RCX)) "(%rdi)\n"
    "  movq (%rsp), %rcx\n"
    "  movq %rcx, " SCR_STR(SCR_UC_GREG(REG_RIP)) "(%rdi)\n"
    "  leaq 8(%rsp), %rcx\n"
    "  movq %rcx, " SCR_STR(SCR_UC_GREG(REG_RSP)) "(%rdi)\n"
    "  leaq 424(%rdi), %rcx\n"
    "  movq %rcx, 224(%rdi)\n"
    "  fnstenv (%rcx)\n"
    "  fldenv (%rcx)\n"
    "  stmxcsr 448(%rdi)\n"
    "  xorl %eax, %eax\n"
    "  ret\n"

    ".global setcontext\n"
    "setcontext:\n"
    "  movq 224(%rdi), %rcx\n"
    "  fldenv (%rcx)\n"
    "  ldmxcsr 448(%rdi)\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R8))  "(%rdi), %r8\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R9))  "(%rdi), %r9\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R10)) "(%rdi), %r10\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R11)) "(%rdi), %r11\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R12)) "(%rdi), %r12\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R13)) "(%rdi), %r13\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R14)) "(%rdi), %r14\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R15)) "(%rdi), %r15\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RSI)) "(%rdi), %rsi\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RBP)) "(%rdi), %rbp\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RBX)) "(%rdi), %rbx\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RDX)) "(%rdi), %rdx\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RAX)) "(%rdi), %rax\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RCX)) "(%rdi), %rcx\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RSP)) "(%rdi), %rsp\n"
    "  pushq " SCR_STR(SCR_UC_GREG(REG_RIP)) "(%rdi)\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RDI)) "(%rdi), %rdi\n"
    "  xorl %eax, %eax\n"
    "  ret\n"

    ".global swapcontext\n"
    "swapcontext:\n"
    "  movq %r8, "  SCR_STR(SCR_UC_GREG(REG_R8))  "(%rdi)\n"
    "  movq %r9, "  SCR_STR(SCR_UC_GREG(REG_R9))  "(%rdi)\n"
    "  movq %r10, " SCR_STR(SCR_UC_GREG(REG_R10)) "(%rdi)\n"
    "  movq %r11, " SCR_STR(SCR_UC_GREG(REG_R11)) "(%rdi)\n"
    "  movq %r12, " SCR_STR(SCR_UC_GREG(REG_R12)) "(%rdi)\n"
    "  movq %r13, " SCR_STR(SCR_UC_GREG(REG_R13)) "(%rdi)\n"
    "  movq %r14, " SCR_STR(SCR_UC_GREG(REG_R14)) "(%rdi)\n"
    "  movq %r15, " SCR_STR(SCR_UC_GREG(REG_R15)) "(%rdi)\n"
    "  movq %rdi, " SCR_STR(SCR_UC_GREG(REG_RDI)) "(%rdi)\n"
    "  movq %rsi, " SCR_STR(SCR_UC_GREG(REG_RSI)) "(%rdi)\n"
    "  movq %rbp, " SCR_STR(SCR_UC_GREG(REG_RBP)) "(%rdi)\n"
    "  movq %rbx, " SCR_STR(SCR_UC_GREG(REG_RBX)) "(%rdi)\n"
    "  movq %rdx, " SCR_STR(SCR_UC_GREG(REG_RDX)) "(%rdi)\n"
    "  movq %rax, " SCR_STR(SCR_UC_GREG(REG_RAX)) "(%rdi)\n"
    "  movq %rcx, " SCR_STR(SCR_UC_GREG(REG_RCX)) "(%rdi)\n"
    "  movq (%rsp), %rcx\n"
    "  movq %rcx, " SCR_STR(SCR_UC_GREG(REG_RIP)) "(%rdi)\n"
    "  leaq 8(%rsp), %rcx\n"
    "  movq %rcx, " SCR_STR(SCR_UC_GREG(REG_RSP)) "(%rdi)\n"
    "  leaq 424(%rdi), %rcx\n"
    "  movq %rcx, 224(%rdi)\n"
    "  fnstenv (%rcx)\n"
    "  fldenv (%rcx)\n"
    "  stmxcsr 448(%rdi)\n"
    "  movq 224(%rsi), %rcx\n"
    "  fldenv (%rcx)\n"
    "  ldmxcsr 448(%rsi)\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R8))  "(%rsi), %r8\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R9))  "(%rsi), %r9\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R10)) "(%rsi), %r10\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R11)) "(%rsi), %r11\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R12)) "(%rsi), %r12\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R13)) "(%rsi), %r13\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R14)) "(%rsi), %r14\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R15)) "(%rsi), %r15\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RDI)) "(%rsi), %rdi\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RBP)) "(%rsi), %rbp\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RBX)) "(%rsi), %rbx\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RDX)) "(%rsi), %rdx\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RAX)) "(%rsi), %rax\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RCX)) "(%rsi), %rcx\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RSP)) "(%rsi), %rsp\n"
    "  pushq " SCR_STR(SCR_UC_GREG(REG_RIP)) "(%rsi)\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RSI)) "(%rsi), %rsi\n"
    "  xorl %eax, %eax\n"
    "  ret\n"

    ".hidden scr_musl_context_trampoline\n"
    "scr_musl_context_trampoline:\n"
    "  movq (%rbx), %rdi\n"
    "  testq %rdi, %rdi\n"
    "  je 1f\n"
    "  call setcontext\n"
    "  ud2\n"
    "1:\n"
    "  xorl %edi, %edi\n"
    "  call exit\n"
    "  ud2\n");

extern void scr_musl_context_trampoline(void);

void makecontext(ucontext_t *ucp, void (*func)(void), int argc, ...) {
  greg_t *sp;
  va_list va;
  int i;
  unsigned int link_slot = (unsigned int)(argc > 6 ? argc - 6 : 0) + 1;

  sp = (greg_t *)((uintptr_t)ucp->uc_stack.ss_sp + ucp->uc_stack.ss_size);
  sp -= link_slot;
  sp = (greg_t *)(((uintptr_t)sp & ~(uintptr_t)15) - 8);

  ucp->uc_mcontext.fpregs = (void *)&ucp->__fpregs_mem;
  ucp->uc_mcontext.gregs[REG_RIP] = (greg_t)(uintptr_t)func;
  ucp->uc_mcontext.gregs[REG_RBX] = (greg_t)(uintptr_t)&sp[link_slot];
  ucp->uc_mcontext.gregs[REG_RSP] = (greg_t)(uintptr_t)sp;

  sp[0] = (greg_t)(uintptr_t)&scr_musl_context_trampoline;
  sp[link_slot] = (greg_t)(uintptr_t)ucp->uc_link;

  va_start(va, argc);
  for (i = 0; i < argc; i++) {
    greg_t arg = va_arg(va, greg_t);
    switch (i) {
      case 0: ucp->uc_mcontext.gregs[REG_RDI] = arg; break;
      case 1: ucp->uc_mcontext.gregs[REG_RSI] = arg; break;
      case 2: ucp->uc_mcontext.gregs[REG_RDX] = arg; break;
      case 3: ucp->uc_mcontext.gregs[REG_RCX] = arg; break;
      case 4: ucp->uc_mcontext.gregs[REG_R8] = arg; break;
      case 5: ucp->uc_mcontext.gregs[REG_R9] = arg; break;
      default: sp[i - 5] = arg; break;
    }
  }
  va_end(va);
}

#undef SCR_UC_GREG
#undef SCR_STR
#undef SCR_STR_INNER

#elif defined(__aarch64__)

/* musl's AArch64 ucontext embeds the kernel sigcontext after a 128-byte
 * signal mask. Keep the offsets pinned to the Zig 0.16 musl headers: the
 * assembly below saves the ABI's callee-preserved GPR and SIMD state there. */
_Static_assert(offsetof(ucontext_t, uc_mcontext.regs[0]) == 184,
               "unexpected musl AArch64 register layout");
_Static_assert(offsetof(ucontext_t, uc_mcontext.sp) == 432,
               "unexpected musl AArch64 stack-pointer layout");
_Static_assert(offsetof(ucontext_t, uc_mcontext.pc) == 440,
               "unexpected musl AArch64 program-counter layout");
_Static_assert(offsetof(ucontext_t, uc_mcontext.pstate) == 448,
               "unexpected musl AArch64 processor-state layout");
_Static_assert(offsetof(ucontext_t, uc_mcontext.__reserved) == 464,
               "unexpected musl AArch64 SIMD-state layout");

#define SCR_STR_INNER(x) #x
#define SCR_STR(x) SCR_STR_INNER(x)
#define SCR_A64_UC_REG(reg) (184 + ((reg) * 8))
#define SCR_A64_UC_SP 432
#define SCR_A64_UC_PC 440
#define SCR_A64_UC_PSTATE 448
#define SCR_A64_UC_FPSIMD 464

__asm__(
    ".text\n"
    ".p2align 2\n"
    ".global getcontext\n"
    "getcontext:\n"
    "  str xzr, [x0, #" SCR_STR(SCR_A64_UC_REG(0)) "]\n"
    "  stp x2, x3, [x0, #" SCR_STR(SCR_A64_UC_REG(2)) "]\n"
    "  str x30, [x0, #" SCR_STR(SCR_A64_UC_PC) "]\n"
    "  mov x2, sp\n"
    "  str x2, [x0, #" SCR_STR(SCR_A64_UC_SP) "]\n"
    "  str xzr, [x0, #" SCR_STR(SCR_A64_UC_PSTATE) "]\n"
    "  add x2, x0, #" SCR_STR(SCR_A64_UC_FPSIMD) "\n"
    "  stp q8, q9, [x2, #144]\n"
    "  stp q10, q11, [x2, #176]\n"
    "  stp q12, q13, [x2, #208]\n"
    "  stp q14, q15, [x2, #240]\n"
    "  mov x2, x0\n"
    "  mov x0, #0\n"
    "  stp x0, x1, [x2, #" SCR_STR(SCR_A64_UC_REG(0)) "]\n"
    "  stp x4, x5, [x2, #" SCR_STR(SCR_A64_UC_REG(4)) "]\n"
    "  stp x6, x7, [x2, #" SCR_STR(SCR_A64_UC_REG(6)) "]\n"
    "  stp x8, x9, [x2, #" SCR_STR(SCR_A64_UC_REG(8)) "]\n"
    "  stp x10, x11, [x2, #" SCR_STR(SCR_A64_UC_REG(10)) "]\n"
    "  stp x12, x13, [x2, #" SCR_STR(SCR_A64_UC_REG(12)) "]\n"
    "  stp x14, x15, [x2, #" SCR_STR(SCR_A64_UC_REG(14)) "]\n"
    "  stp x16, x17, [x2, #" SCR_STR(SCR_A64_UC_REG(16)) "]\n"
    "  stp x18, x19, [x2, #" SCR_STR(SCR_A64_UC_REG(18)) "]\n"
    "  stp x20, x21, [x2, #" SCR_STR(SCR_A64_UC_REG(20)) "]\n"
    "  stp x22, x23, [x2, #" SCR_STR(SCR_A64_UC_REG(22)) "]\n"
    "  stp x24, x25, [x2, #" SCR_STR(SCR_A64_UC_REG(24)) "]\n"
    "  stp x26, x27, [x2, #" SCR_STR(SCR_A64_UC_REG(26)) "]\n"
    "  stp x28, x29, [x2, #" SCR_STR(SCR_A64_UC_REG(28)) "]\n"
    "  str x30, [x2, #" SCR_STR(SCR_A64_UC_REG(30)) "]\n"
    "  ret\n"

    ".p2align 2\n"
    ".global setcontext\n"
    "setcontext:\n"
    "  ldp x18, x19, [x0, #" SCR_STR(SCR_A64_UC_REG(18)) "]\n"
    "  ldp x20, x21, [x0, #" SCR_STR(SCR_A64_UC_REG(20)) "]\n"
    "  ldp x22, x23, [x0, #" SCR_STR(SCR_A64_UC_REG(22)) "]\n"
    "  ldp x24, x25, [x0, #" SCR_STR(SCR_A64_UC_REG(24)) "]\n"
    "  ldp x26, x27, [x0, #" SCR_STR(SCR_A64_UC_REG(26)) "]\n"
    "  ldp x28, x29, [x0, #" SCR_STR(SCR_A64_UC_REG(28)) "]\n"
    "  ldr x30, [x0, #" SCR_STR(SCR_A64_UC_REG(30)) "]\n"
    "  ldr x2, [x0, #" SCR_STR(SCR_A64_UC_SP) "]\n"
    "  mov sp, x2\n"
    "  add x2, x0, #" SCR_STR(SCR_A64_UC_FPSIMD) "\n"
    "  ldp q8, q9, [x2, #144]\n"
    "  ldp q10, q11, [x2, #176]\n"
    "  ldp q12, q13, [x2, #208]\n"
    "  ldp q14, q15, [x2, #240]\n"
    "  ldr x16, [x0, #" SCR_STR(SCR_A64_UC_PC) "]\n"
    "  ldp x2, x3, [x0, #" SCR_STR(SCR_A64_UC_REG(2)) "]\n"
    "  ldp x4, x5, [x0, #" SCR_STR(SCR_A64_UC_REG(4)) "]\n"
    "  ldp x6, x7, [x0, #" SCR_STR(SCR_A64_UC_REG(6)) "]\n"
    "  ldp x0, x1, [x0, #" SCR_STR(SCR_A64_UC_REG(0)) "]\n"
    "  br x16\n"

    ".p2align 2\n"
    ".global swapcontext\n"
    "swapcontext:\n"
    "  str xzr, [x0, #" SCR_STR(SCR_A64_UC_REG(0)) "]\n"
    "  stp x2, x3, [x0, #" SCR_STR(SCR_A64_UC_REG(2)) "]\n"
    "  stp x4, x5, [x0, #" SCR_STR(SCR_A64_UC_REG(4)) "]\n"
    "  stp x6, x7, [x0, #" SCR_STR(SCR_A64_UC_REG(6)) "]\n"
    "  stp x8, x9, [x0, #" SCR_STR(SCR_A64_UC_REG(8)) "]\n"
    "  stp x10, x11, [x0, #" SCR_STR(SCR_A64_UC_REG(10)) "]\n"
    "  stp x12, x13, [x0, #" SCR_STR(SCR_A64_UC_REG(12)) "]\n"
    "  stp x14, x15, [x0, #" SCR_STR(SCR_A64_UC_REG(14)) "]\n"
    "  stp x16, x17, [x0, #" SCR_STR(SCR_A64_UC_REG(16)) "]\n"
    "  stp x18, x19, [x0, #" SCR_STR(SCR_A64_UC_REG(18)) "]\n"
    "  stp x20, x21, [x0, #" SCR_STR(SCR_A64_UC_REG(20)) "]\n"
    "  stp x22, x23, [x0, #" SCR_STR(SCR_A64_UC_REG(22)) "]\n"
    "  stp x24, x25, [x0, #" SCR_STR(SCR_A64_UC_REG(24)) "]\n"
    "  stp x26, x27, [x0, #" SCR_STR(SCR_A64_UC_REG(26)) "]\n"
    "  stp x28, x29, [x0, #" SCR_STR(SCR_A64_UC_REG(28)) "]\n"
    "  str x30, [x0, #" SCR_STR(SCR_A64_UC_REG(30)) "]\n"
    "  str x30, [x0, #" SCR_STR(SCR_A64_UC_PC) "]\n"
    "  mov x2, sp\n"
    "  str x2, [x0, #" SCR_STR(SCR_A64_UC_SP) "]\n"
    "  str xzr, [x0, #" SCR_STR(SCR_A64_UC_PSTATE) "]\n"
    "  add x2, x0, #" SCR_STR(SCR_A64_UC_FPSIMD) "\n"
    "  stp q8, q9, [x2, #144]\n"
    "  stp q10, q11, [x2, #176]\n"
    "  stp q12, q13, [x2, #208]\n"
    "  stp q14, q15, [x2, #240]\n"
    "  mov x0, x1\n"
    "  b setcontext\n"

    ".p2align 2\n"
    ".hidden scr_musl_context_trampoline\n"
    "scr_musl_context_trampoline:\n"
    "  mov x0, x19\n"
    "  cbz x0, 1f\n"
    "  bl setcontext\n"
    "  brk #0\n"
    "1:\n"
    "  mov w0, #0\n"
    "  bl exit\n"
    "  brk #0\n");

extern void scr_musl_context_trampoline(void);

void makecontext(ucontext_t *ucp, void (*func)(void), int argc, ...) {
  greg_t *sp;
  va_list va;
  int i;

  sp = (greg_t *)((uintptr_t)ucp->uc_stack.ss_sp + ucp->uc_stack.ss_size);
  sp -= argc < 8 ? 0 : argc - 8;
  sp = (greg_t *)((uintptr_t)sp & ~(uintptr_t)15);

  ucp->uc_mcontext.sp = (greg_t)(uintptr_t)sp;
  ucp->uc_mcontext.pc = (greg_t)(uintptr_t)func;
  ucp->uc_mcontext.regs[19] = (greg_t)(uintptr_t)ucp->uc_link;
  ucp->uc_mcontext.regs[30] =
      (greg_t)(uintptr_t)&scr_musl_context_trampoline;

  va_start(va, argc);
  for (i = 0; i < argc && i < 8; i++) {
    ucp->uc_mcontext.regs[i] = va_arg(va, greg_t);
  }
  for (; i < argc; i++) {
    *sp++ = va_arg(va, greg_t);
  }
  va_end(va);
}

#undef SCR_A64_UC_FPSIMD
#undef SCR_A64_UC_PSTATE
#undef SCR_A64_UC_PC
#undef SCR_A64_UC_SP
#undef SCR_A64_UC_REG
#undef SCR_STR
#undef SCR_STR_INNER

#endif /* architecture */

#endif /* !SCR_LIB */

#else /* !SCR_MUSL */

typedef int scr_musl_unused;

#endif /* SCR_MUSL */
