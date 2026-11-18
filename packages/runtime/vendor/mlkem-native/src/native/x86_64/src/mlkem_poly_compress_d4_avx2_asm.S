/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

/* References
 * ==========
 *
 * - [REF_AVX2]
 *   CRYSTALS-Kyber optimized AVX2 implementation
 *   Bos, Ducas, Kiltz, Lepoint, Lyubashevsky, Schanck, Schwabe, Seiler, Stehlé
 *   https://github.com/pq-crystals/kyber/tree/main/avx2
 */

/*
 * This file is derived from the public domain
 * AVX2 Kyber implementation @[REF_AVX2].
 */

/*************************************************
 * Name:        mlk_poly_compress_d4_avx2_asm
 *
 * Description: Compression of a polynomial to 4 bits per coefficient.
 *
 * Arguments:   - uint8_t *r:       pointer to output byte array
 *                                  (of length MLKEM_POLYCOMPRESSEDBYTES_D4)
 *              - const int16_t *a: pointer to input polynomial
 *              - const uint8_t *data: pointer to permdidx constant
 **************************************************/

#include "../../../common.h"
#if defined(MLK_ARITH_BACKEND_X86_64_DEFAULT) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED) && \
    (!defined(MLK_CONFIG_NO_ENCAPS_API) || \
     !defined(MLK_CONFIG_NO_DECAPS_API)) && \
    (defined(MLK_CONFIG_MULTILEVEL_WITH_SHARED) || MLKEM_K == 2 || MLKEM_K == 3)
/*yaml
  Name: poly_compress_d4_avx2_asm
  Description: x86_64 AVX2 polynomial compression (d=4)
  Signature: void mlk_poly_compress_d4_avx2_asm(uint8_t *r, const int16_t *a, const uint8_t *data)
  ABI:
    Architecture: x86_64
    CallingConvention: SysV
    Features: [AVX2]
    rdi:
      type: buffer
      size_bytes: 128
      permissions: write-only
      c_parameter: uint8_t *r
      description: Output compressed polynomial
    rsi:
      type: buffer
      size_bytes: 512
      permissions: read-only
      c_parameter: const int16_t *a
      description: Input polynomial (256 x int16_t)
    rdx:
      type: buffer
      size_bytes: 32
      permissions: read-only
      c_parameter: const uint8_t *data
      description: Precomputed compression constants
*/


/*
 * WARNING: This file is auto-derived from the mlkem-native source file
 *   dev/x86_64/src/mlkem_poly_compress_d4_avx2_asm.S using scripts/simpasm. Do not modify it directly.
 */

.text
.balign 4
.global MLK_ASM_NAMESPACE(poly_compress_d4_avx2_asm)
MLK_ASM_FN_SYMBOL(poly_compress_d4_avx2_asm)

        .cfi_startproc
        movl $0x4ebf4ebf, %eax       # imm = 0x4EBF4EBF
        vmovd %eax, %xmm0
        vpbroadcastd %xmm0, %ymm0
        movl $0x2000200, %eax        # imm = 0x2000200
        vmovd %eax, %xmm1
        vpbroadcastd %xmm1, %ymm1
        movl $0xf000f, %eax          # imm = 0xF000F
        vmovd %eax, %xmm2
        vpbroadcastd %xmm2, %ymm2
        movl $0x10011001, %eax       # imm = 0x10011001
        vmovd %eax, %xmm3
        vpbroadcastd %xmm3, %ymm3
        vmovdqa (%rdx), %ymm4
        vmovdqa (%rsi), %ymm5
        vmovdqa 0x20(%rsi), %ymm6
        vmovdqa 0x40(%rsi), %ymm7
        vmovdqa 0x60(%rsi), %ymm8
        vpmulhw %ymm0, %ymm5, %ymm5
        vpmulhw %ymm0, %ymm6, %ymm6
        vpmulhw %ymm0, %ymm7, %ymm7
        vpmulhw %ymm0, %ymm8, %ymm8
        vpmulhrsw %ymm1, %ymm5, %ymm5
        vpmulhrsw %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm1, %ymm7, %ymm7
        vpmulhrsw %ymm1, %ymm8, %ymm8
        vpand %ymm2, %ymm5, %ymm5
        vpand %ymm2, %ymm6, %ymm6
        vpand %ymm2, %ymm7, %ymm7
        vpand %ymm2, %ymm8, %ymm8
        vpackuswb %ymm6, %ymm5, %ymm5
        vpackuswb %ymm8, %ymm7, %ymm7
        vpmaddubsw %ymm3, %ymm5, %ymm5
        vpmaddubsw %ymm3, %ymm7, %ymm7
        vpackuswb %ymm7, %ymm5, %ymm5
        vpermd %ymm5, %ymm4, %ymm5
        vmovdqu %ymm5, (%rdi)
        vmovdqa 0x80(%rsi), %ymm5
        vmovdqa 0xa0(%rsi), %ymm6
        vmovdqa 0xc0(%rsi), %ymm7
        vmovdqa 0xe0(%rsi), %ymm8
        vpmulhw %ymm0, %ymm5, %ymm5
        vpmulhw %ymm0, %ymm6, %ymm6
        vpmulhw %ymm0, %ymm7, %ymm7
        vpmulhw %ymm0, %ymm8, %ymm8
        vpmulhrsw %ymm1, %ymm5, %ymm5
        vpmulhrsw %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm1, %ymm7, %ymm7
        vpmulhrsw %ymm1, %ymm8, %ymm8
        vpand %ymm2, %ymm5, %ymm5
        vpand %ymm2, %ymm6, %ymm6
        vpand %ymm2, %ymm7, %ymm7
        vpand %ymm2, %ymm8, %ymm8
        vpackuswb %ymm6, %ymm5, %ymm5
        vpackuswb %ymm8, %ymm7, %ymm7
        vpmaddubsw %ymm3, %ymm5, %ymm5
        vpmaddubsw %ymm3, %ymm7, %ymm7
        vpackuswb %ymm7, %ymm5, %ymm5
        vpermd %ymm5, %ymm4, %ymm5
        vmovdqu %ymm5, 0x20(%rdi)
        vmovdqa 0x100(%rsi), %ymm5
        vmovdqa 0x120(%rsi), %ymm6
        vmovdqa 0x140(%rsi), %ymm7
        vmovdqa 0x160(%rsi), %ymm8
        vpmulhw %ymm0, %ymm5, %ymm5
        vpmulhw %ymm0, %ymm6, %ymm6
        vpmulhw %ymm0, %ymm7, %ymm7
        vpmulhw %ymm0, %ymm8, %ymm8
        vpmulhrsw %ymm1, %ymm5, %ymm5
        vpmulhrsw %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm1, %ymm7, %ymm7
        vpmulhrsw %ymm1, %ymm8, %ymm8
        vpand %ymm2, %ymm5, %ymm5
        vpand %ymm2, %ymm6, %ymm6
        vpand %ymm2, %ymm7, %ymm7
        vpand %ymm2, %ymm8, %ymm8
        vpackuswb %ymm6, %ymm5, %ymm5
        vpackuswb %ymm8, %ymm7, %ymm7
        vpmaddubsw %ymm3, %ymm5, %ymm5
        vpmaddubsw %ymm3, %ymm7, %ymm7
        vpackuswb %ymm7, %ymm5, %ymm5
        vpermd %ymm5, %ymm4, %ymm5
        vmovdqu %ymm5, 0x40(%rdi)
        vmovdqa 0x180(%rsi), %ymm5
        vmovdqa 0x1a0(%rsi), %ymm6
        vmovdqa 0x1c0(%rsi), %ymm7
        vmovdqa 0x1e0(%rsi), %ymm8
        vpmulhw %ymm0, %ymm5, %ymm5
        vpmulhw %ymm0, %ymm6, %ymm6
        vpmulhw %ymm0, %ymm7, %ymm7
        vpmulhw %ymm0, %ymm8, %ymm8
        vpmulhrsw %ymm1, %ymm5, %ymm5
        vpmulhrsw %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm1, %ymm7, %ymm7
        vpmulhrsw %ymm1, %ymm8, %ymm8
        vpand %ymm2, %ymm5, %ymm5
        vpand %ymm2, %ymm6, %ymm6
        vpand %ymm2, %ymm7, %ymm7
        vpand %ymm2, %ymm8, %ymm8
        vpackuswb %ymm6, %ymm5, %ymm5
        vpackuswb %ymm8, %ymm7, %ymm7
        vpmaddubsw %ymm3, %ymm5, %ymm5
        vpmaddubsw %ymm3, %ymm7, %ymm7
        vpackuswb %ymm7, %ymm5, %ymm5
        vpermd %ymm5, %ymm4, %ymm5
        vmovdqu %ymm5, 0x60(%rdi)
        retq
        .cfi_endproc

MLK_ASM_FN_SIZE(poly_compress_d4_avx2_asm)

#endif /* MLK_ARITH_BACKEND_X86_64_DEFAULT && !MLK_CONFIG_MULTILEVEL_NO_SHARED \
          && (!MLK_CONFIG_NO_ENCAPS_API || !MLK_CONFIG_NO_DECAPS_API) && \
          (MLK_CONFIG_MULTILEVEL_WITH_SHARED || MLKEM_K == 2 || MLKEM_K == 3) \
        */

#if defined(__ELF__)
.section .note.GNU-stack,"",%progbits
#endif
