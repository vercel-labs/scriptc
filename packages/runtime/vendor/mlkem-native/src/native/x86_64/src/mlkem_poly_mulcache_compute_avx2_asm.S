/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

#include "../../../common.h"
#if defined(MLK_ARITH_BACKEND_X86_64_DEFAULT) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED)
/*yaml
  Name: poly_mulcache_compute_avx2_asm
  Description: x86_64 AVX2 mulcache computation
  Signature: void mlk_poly_mulcache_compute_avx2_asm(int16_t *out, const int16_t *in, const int16_t *qdata)
  ABI:
    Architecture: x86_64
    CallingConvention: SysV
    Features: [AVX2]
    rdi:
      type: buffer
      size_bytes: 256
      permissions: write-only
      c_parameter: int16_t *out
      description: Output mulcache (128 x int16_t)
    rsi:
      type: buffer
      size_bytes: 512
      permissions: read-only
      c_parameter: const int16_t *in
      description: Input polynomial (256 x int16_t)
    rdx:
      type: buffer
      size_bytes: 1248
      permissions: read-only
      c_parameter: const int16_t *qdata
      description: Precomputed constants (624 x int16_t)
*/


/*
 * WARNING: This file is auto-derived from the mlkem-native source file
 *   dev/x86_64/src/mlkem_poly_mulcache_compute_avx2_asm.S using scripts/simpasm. Do not modify it directly.
 */

.text
.balign 4
.global MLK_ASM_NAMESPACE(poly_mulcache_compute_avx2_asm)
MLK_ASM_FN_SYMBOL(poly_mulcache_compute_avx2_asm)

        .cfi_startproc
        movl $0xd010d01, %eax        # imm = 0xD010D01
        vmovd %eax, %xmm0
        vpbroadcastd %xmm0, %ymm0
        vmovdqa 0x20(%rsi), %ymm2
        vmovdqa 0x60(%rsi), %ymm3
        vmovdqa 0x3e0(%rdx), %ymm4
        vmovdqa 0x460(%rdx), %ymm1
        vpmullw %ymm2, %ymm1, %ymm5
        vpmullw %ymm3, %ymm1, %ymm6
        vpmulhw %ymm2, %ymm4, %ymm7
        vpmulhw %ymm3, %ymm4, %ymm8
        vpmulhw %ymm5, %ymm0, %ymm9
        vpmulhw %ymm6, %ymm0, %ymm10
        vpsubw %ymm9, %ymm7, %ymm7
        vpsubw %ymm10, %ymm8, %ymm8
        vmovdqa %ymm7, (%rdi)
        vmovdqa %ymm8, 0x20(%rdi)
        vmovdqa 0xa0(%rsi), %ymm2
        vmovdqa 0xe0(%rsi), %ymm3
        vmovdqa 0x400(%rdx), %ymm4
        vmovdqa 0x480(%rdx), %ymm1
        vpmullw %ymm2, %ymm1, %ymm5
        vpmullw %ymm3, %ymm1, %ymm6
        vpmulhw %ymm2, %ymm4, %ymm7
        vpmulhw %ymm3, %ymm4, %ymm8
        vpmulhw %ymm5, %ymm0, %ymm9
        vpmulhw %ymm6, %ymm0, %ymm10
        vpsubw %ymm9, %ymm7, %ymm7
        vpsubw %ymm10, %ymm8, %ymm8
        vmovdqa %ymm7, 0x40(%rdi)
        vmovdqa %ymm8, 0x60(%rdi)
        vmovdqa 0x120(%rsi), %ymm2
        vmovdqa 0x160(%rsi), %ymm3
        vmovdqa 0x420(%rdx), %ymm4
        vmovdqa 0x4a0(%rdx), %ymm1
        vpmullw %ymm2, %ymm1, %ymm5
        vpmullw %ymm3, %ymm1, %ymm6
        vpmulhw %ymm2, %ymm4, %ymm7
        vpmulhw %ymm3, %ymm4, %ymm8
        vpmulhw %ymm5, %ymm0, %ymm9
        vpmulhw %ymm6, %ymm0, %ymm10
        vpsubw %ymm9, %ymm7, %ymm7
        vpsubw %ymm10, %ymm8, %ymm8
        vmovdqa %ymm7, 0x80(%rdi)
        vmovdqa %ymm8, 0xa0(%rdi)
        vmovdqa 0x1a0(%rsi), %ymm2
        vmovdqa 0x1e0(%rsi), %ymm3
        vmovdqa 0x440(%rdx), %ymm4
        vmovdqa 0x4c0(%rdx), %ymm1
        vpmullw %ymm2, %ymm1, %ymm5
        vpmullw %ymm3, %ymm1, %ymm6
        vpmulhw %ymm2, %ymm4, %ymm7
        vpmulhw %ymm3, %ymm4, %ymm8
        vpmulhw %ymm5, %ymm0, %ymm9
        vpmulhw %ymm6, %ymm0, %ymm10
        vpsubw %ymm9, %ymm7, %ymm7
        vpsubw %ymm10, %ymm8, %ymm8
        vmovdqa %ymm7, 0xc0(%rdi)
        vmovdqa %ymm8, 0xe0(%rdi)
        retq
        .cfi_endproc

MLK_ASM_FN_SIZE(poly_mulcache_compute_avx2_asm)

#endif /* MLK_ARITH_BACKEND_X86_64_DEFAULT && !MLK_CONFIG_MULTILEVEL_NO_SHARED \
        */

#if defined(__ELF__)
.section .note.GNU-stack,"",%progbits
#endif
