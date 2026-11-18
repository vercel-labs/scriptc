/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */
#ifndef MLK_SYS_H
#define MLK_SYS_H

#if !defined(MLK_CONFIG_NO_ASM) && (defined(__GNUC__) || defined(__clang__))
#define MLK_HAVE_INLINE_ASM
#endif

/* Try to find endianness, if not forced through CFLAGS already */
#if !defined(MLK_SYS_LITTLE_ENDIAN) && !defined(MLK_SYS_BIG_ENDIAN)
#if defined(__BYTE_ORDER__)
#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
#define MLK_SYS_LITTLE_ENDIAN
#elif __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
#define MLK_SYS_BIG_ENDIAN
#else
#error "__BYTE_ORDER__ defined, but don't recognize value."
#endif
#endif /* __BYTE_ORDER__ */

/* MSVC does not define __BYTE_ORDER__. However, MSVC only supports
 * little endian x86, x86_64, and AArch64. It is, hence, safe to assume
 * little endian. */
#if defined(_MSC_VER) && (defined(_M_X64) || defined(_M_AMD64) || \
                          defined(_M_IX86) || defined(_M_ARM64))
#define MLK_SYS_LITTLE_ENDIAN
#endif

#endif /* !MLK_SYS_LITTLE_ENDIAN && !MLK_SYS_BIG_ENDIAN */

/* Check if we're running on an AArch64 little endian system. _M_ARM64 is set by
 * MSVC. */
#if defined(__AARCH64EL__) || defined(_M_ARM64)
#define MLK_SYS_AARCH64
#endif

/* Check if the AArch64 compilation target supports NEON (Advanced SIMD).
 *
 * Some compilers also define __ARM_NEON__, but __ARM_NEON is the most reliable
 * signal. Specifically, clang on Apple appears to keep __ARM_NEON__ set even if
 * -march=armv8-a+nosimd is set.
 *
 * gcc 4.8 -- the first gcc version introducing Neon support -- sets neither
 * __ARM_NEON nor __ARM_NEON__; in fact, there is no preprocessor signal that
 * Neon is enabled. If you use gcc 4.8, you should set __ARM_NEON manually.
 * gcc 4.9 onwards do set __ARM_NEON.
 */
#if defined(MLK_SYS_AARCH64) && defined(__ARM_NEON)
#define MLK_SYS_AARCH64_NEON
#endif

/* Check if we're running on an AArch64 big endian system. */
#if defined(__AARCH64EB__)
#define MLK_SYS_AARCH64_EB
#endif

/* Check if we're running on an Armv8.1-M system with MVE */
#if defined(__ARM_ARCH_8_1M_MAIN__) || defined(__ARM_FEATURE_MVE)
#define MLK_SYS_ARMV81M_MVE
#endif

/* Check if we're running on an x86_64 system. */
#if defined(__x86_64__) || defined(_M_X64) || defined(_M_AMD64)
#define MLK_SYS_X86_64
#if defined(__AVX2__)
#define MLK_SYS_X86_64_AVX2
#endif
#endif /* __x86_64__ || _M_X64 || _M_AMD64 */

#if defined(MLK_SYS_LITTLE_ENDIAN) && defined(__powerpc64__)
#define MLK_SYS_PPC64LE
#endif

#if defined(__riscv) && defined(__riscv_xlen) && __riscv_xlen == 64
#define MLK_SYS_RISCV64
#endif

#if defined(MLK_SYS_RISCV64) && defined(__riscv_vector) && \
    defined(__riscv_v_intrinsic)
#define MLK_SYS_RISCV64_RVV
#endif

#if defined(__riscv) && defined(__riscv_xlen) && __riscv_xlen == 32
#define MLK_SYS_RISCV32
#endif

#if defined(_WIN32)
#define MLK_SYS_WINDOWS
#endif

#if defined(__linux__)
#define MLK_SYS_LINUX
#endif

#if defined(__APPLE__)
#define MLK_SYS_APPLE
#endif

#if defined(MLK_FORCE_AARCH64) && !defined(MLK_SYS_AARCH64)
#error "MLK_FORCE_AARCH64 is set, but we don't seem to be on an AArch64 system."
#endif

#if defined(MLK_FORCE_AARCH64_EB) && !defined(MLK_SYS_AARCH64_EB)
#error \
    "MLK_FORCE_AARCH64_EB is set, but we don't seem to be on an AArch64 system."
#endif

#if defined(MLK_FORCE_X86_64) && !defined(MLK_SYS_X86_64)
#error "MLK_FORCE_X86_64 is set, but we don't seem to be on an X86_64 system."
#endif

#if defined(MLK_FORCE_PPC64LE) && !defined(MLK_SYS_PPC64LE)
#error "MLK_FORCE_PPC64LE is set, but we don't seem to be on a PPC64LE system."
#endif

#if defined(MLK_FORCE_RISCV64) && !defined(MLK_SYS_RISCV64)
#error "MLK_FORCE_RISCV64 is set, but we don't seem to be on a RISCV64 system."
#endif

#if defined(MLK_FORCE_RISCV32) && !defined(MLK_SYS_RISCV32)
#error "MLK_FORCE_RISCV32 is set, but we don't seem to be on a RISCV32 system."
#endif

/*
 * MLK_INLINE: Hint for inlining.
 * - MSVC: __inline
 * - C99+: inline
 * - GCC/Clang C90: __attribute__((unused)) to silence warnings
 * - Other C90: empty
 */
#if !defined(MLK_INLINE)
#if defined(_MSC_VER)
#define MLK_INLINE __inline
#elif defined(inline) || \
    (defined(__STDC_VERSION__) && __STDC_VERSION__ >= 199901L)
#define MLK_INLINE inline
#elif defined(__GNUC__) || defined(__clang__)
#define MLK_INLINE __attribute__((unused))
#else
#define MLK_INLINE
#endif
#endif /* !MLK_INLINE */

/*
 * MLK_ALWAYS_INLINE: Force inlining.
 * - MSVC: __forceinline
 * - GCC/Clang C99+: MLK_INLINE __attribute__((always_inline))
 * - Other: MLK_INLINE (no forced inlining)
 */
#if !defined(MLK_ALWAYS_INLINE)
#if defined(_MSC_VER)
#define MLK_ALWAYS_INLINE __forceinline
#elif (defined(__GNUC__) || defined(__clang__)) && \
    (defined(inline) ||                            \
     (defined(__STDC_VERSION__) && __STDC_VERSION__ >= 199901L))
#define MLK_ALWAYS_INLINE MLK_INLINE __attribute__((always_inline))
#else
#define MLK_ALWAYS_INLINE MLK_INLINE
#endif
#endif /* !MLK_ALWAYS_INLINE */

/*
 * MLK_NOINLINE: Prevent inlining.
 * - MSVC: __declspec(noinline)
 * - GCC/Clang: __attribute__((noinline))
 * - Other: empty
 */
#if !defined(MLK_NOINLINE)
#if defined(_MSC_VER)
#define MLK_NOINLINE __declspec(noinline)
#elif defined(__GNUC__) || defined(__clang__)
#define MLK_NOINLINE __attribute__((noinline))
#else
#define MLK_NOINLINE
#endif
#endif /* !MLK_NOINLINE */

#ifndef MLK_STATIC_TESTABLE
#define MLK_STATIC_TESTABLE static
#endif

/*
 * C90 does not have the restrict compiler directive yet.
 * We don't use it in C90 builds.
 */
#if !defined(restrict)
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 199901L
#define MLK_RESTRICT restrict
#else
#define MLK_RESTRICT
#endif

#else /* !restrict */

#define MLK_RESTRICT restrict
#endif /* restrict */

#define MLK_DEFAULT_ALIGN 32
#define MLK_ALIGN_UP(N) \
  ((((N) + (MLK_DEFAULT_ALIGN - 1)) / MLK_DEFAULT_ALIGN) * MLK_DEFAULT_ALIGN)
#if defined(__GNUC__)
#define MLK_ALIGN __attribute__((aligned(MLK_DEFAULT_ALIGN)))
#elif defined(_MSC_VER)
#define MLK_ALIGN __declspec(align(MLK_DEFAULT_ALIGN))
#else
#define MLK_ALIGN /* No known support for alignment constraints */
#endif


/* New X86_64 CPUs support control-flow protection using the CET instructions.
 * When enabled (through -fcf-protection=), all compilation units (including
 * empty ones) need to support CET for this to work.
 * For assembly, this means that source files need to signal support for
 * CET by setting the appropriate note.gnu.property section.
 * This can be achieved by including the <cet.h> header in all assembly file.
 * This file also provides the _CET_ENDBR macro which needs to be placed at
 * every potential target of an indirect branch.
 * If CET is enabled _CET_ENDBR maps to the endbr64 instruction, otherwise
 * it is empty.
 * In case the compiler does not support CET (e.g., <gcc8, <clang11),
 * the __CET__ macro is not set and we default to nothing.
 * Note that we only issue _CET_ENDBR instructions through the MLK_ASM_FN_SYMBOL
 * macro as the global symbols are the only possible targets of indirect
 * branches in our code.
 */
#if defined(MLK_SYS_X86_64)
#if defined(__CET__)
#include <cet.h>
#define MLK_CET_ENDBR _CET_ENDBR
#else
#define MLK_CET_ENDBR
#endif
#endif /* MLK_SYS_X86_64 */

#if defined(MLK_CONFIG_CT_TESTING_ENABLED) && !defined(__ASSEMBLER__)
#include <valgrind/memcheck.h>
#define MLK_CT_TESTING_SECRET(ptr, len) \
  VALGRIND_MAKE_MEM_UNDEFINED((ptr), (len))
#define MLK_CT_TESTING_DECLASSIFY(ptr, len) \
  VALGRIND_MAKE_MEM_DEFINED((ptr), (len))
#else /* MLK_CONFIG_CT_TESTING_ENABLED && !__ASSEMBLER__ */
#define MLK_CT_TESTING_SECRET(ptr, len) \
  do                                    \
  {                                     \
  } while (0)
#define MLK_CT_TESTING_DECLASSIFY(ptr, len) \
  do                                        \
  {                                         \
  } while (0)
#endif /* !(MLK_CONFIG_CT_TESTING_ENABLED && !__ASSEMBLER__) */

#if defined(__GNUC__) || defined(__clang__)
#define MLK_MUST_CHECK_RETURN_VALUE __attribute__((warn_unused_result))
#else
#define MLK_MUST_CHECK_RETURN_VALUE
#endif

/* The x86_64 assembly backend uses the SysV calling convention. On Windows,
 * where the Microsoft x64 calling convention is the default, it can still be
 * used with compilers that allow choosing the calling convention per
 * function: GCC and Clang support __attribute__((sysv_abi)), which makes
 * calls to the annotated function follow the SysV calling convention.
 *
 * MLK_SYSV_ABI_SUPPORTED signals that the toolchain can call SysV assembly
 * routines; the x86_64 assembly backend is only enabled if it is defined.
 * MLK_SYSV_ABI is the attribute carried by declarations of x86_64 assembly
 * routines. Both macros can be set externally for toolchains offering an
 * equivalent mechanism that is not recognized here. */
#if defined(MLK_SYS_X86_64) && !defined(MLK_SYSV_ABI_SUPPORTED)
#if !defined(MLK_SYS_WINDOWS) || defined(__GNUC__) || defined(__clang__)
#define MLK_SYSV_ABI_SUPPORTED
#endif
#endif

#if !defined(MLK_SYSV_ABI)
#if defined(MLK_SYS_WINDOWS) && defined(MLK_SYSV_ABI_SUPPORTED)
#define MLK_SYSV_ABI __attribute__((sysv_abi))
#else
#define MLK_SYSV_ABI
#endif
#endif /* !MLK_SYSV_ABI */

#if !defined(__ASSEMBLER__)
/* System capability enumeration */
typedef enum
{
  /* x86_64 */
  MLK_SYS_CAP_X86_64_AVX2,
  /* AArch64 */
  MLK_SYS_CAP_AARCH64_NEON,
  MLK_SYS_CAP_AARCH64_SHA3,
  /* Armv8.1-M */
  MLK_SYS_CAP_ARMV81M_MVE
} mlk_sys_cap;

#if !defined(MLK_CONFIG_CUSTOM_CAPABILITY_FUNC)
#include "cbmc.h"

MLK_MUST_CHECK_RETURN_VALUE
static MLK_INLINE int mlk_sys_check_capability(mlk_sys_cap cap)
__contract__(
  ensures(return_value == 0 || return_value == 1)
)
{
  /* By default, we rely on compile-time feature detection/specification:
   * If a feature is enabled at compile-time, we assume it is supported by
   * the host that the resulting library/binary will be built on.
   * If this assumption is not true, you MUST overwrite this function.
   * See the documentation of MLK_CONFIG_CUSTOM_CAPABILITY_FUNC in
   * mlkem_native_config.h for more information. */
  (void)cap;
  return 1;
}
#endif /* !MLK_CONFIG_CUSTOM_CAPABILITY_FUNC */
#endif /* !__ASSEMBLER__ */

#endif /* !MLK_SYS_H */
