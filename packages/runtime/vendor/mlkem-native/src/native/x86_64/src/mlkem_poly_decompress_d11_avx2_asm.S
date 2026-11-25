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
 * Name:        mlk_poly_decompress_d11_avx2_asm
 *
 * Description: Decompression of a polynomial from 11 bits per coefficient.
 *
 * Arguments:   - int16_t *r:       pointer to output polynomial
 *              - const uint8_t *a: pointer to input byte array
 *                                  (of length MLKEM_POLYCOMPRESSEDBYTES_D11)
 *              - const uint8_t *data: pointer to constants
 *                                  (shufbidx[0:32], srlvdidx[32:64],
 *                                   srlvqidx[64:96], shift[96:128])
 **************************************************/

#include "../../../common.h"
#if defined(MLK_ARITH_BACKEND_X86_64_DEFAULT) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED) && \
    !defined(MLK_CONFIG_NO_DECAPS_API) && \
    (defined(MLK_CONFIG_MULTILEVEL_WITH_SHARED) || MLKEM_K == 4)
/*yaml
  Name: poly_decompress_d11_avx2_asm
  Description: x86_64 AVX2 polynomial decompression (d=11)
  Signature: void mlk_poly_decompress_d11_avx2_asm(int16_t *r, const uint8_t *a, const uint8_t *data)
  ABI:
    Architecture: x86_64
    CallingConvention: SysV
    Features: [AVX2]
    rdi:
      type: buffer
      size_bytes: 512
      permissions: write-only
      c_parameter: int16_t *r
      description: Output polynomial (256 x int16_t)
    rsi:
      type: buffer
      size_bytes: 352
      permissions: read-only
      c_parameter: const uint8_t *a
      description: Input compressed polynomial
    rdx:
      type: buffer
      size_bytes: 128
      permissions: read-only
      c_parameter: const uint8_t *data
      description: Precomputed decompression constants
*/


/*
 * WARNING: This file is auto-derived from the mlkem-native source file
 *   dev/x86_64/src/mlkem_poly_decompress_d11_avx2_asm.S using scripts/simpasm. Do not modify it directly.
 */

.text
.balign 4
.global MLK_ASM_NAMESPACE(poly_decompress_d11_avx2_asm)
MLK_ASM_FN_SYMBOL(poly_decompress_d11_avx2_asm)

        .cfi_startproc
        movl $0xd010d01, %eax        # imm = 0xD010D01
        vmovd %eax, %xmm0
        vpbroadcastd %xmm0, %ymm0
        movl $0x7ff07ff0, %eax       # imm = 0x7FF07FF0
        vmovd %eax, %xmm1
        vpbroadcastd %xmm1, %ymm1
        vmovdqa (%rdx), %ymm2
        vmovdqa 0x20(%rdx), %ymm3
        vmovdqa 0x40(%rdx), %ymm4
        vmovdqa 0x60(%rdx), %ymm5
        vmovdqu (%rsi), %xmm6
        vmovd 0x10(%rsi), %xmm7
        vpinsrw $0x2, 0x14(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, (%rdi)
        vmovdqu 0x16(%rsi), %xmm6
        vmovd 0x26(%rsi), %xmm7
        vpinsrw $0x2, 0x2a(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0x20(%rdi)
        vmovdqu 0x2c(%rsi), %xmm6
        vmovd 0x3c(%rsi), %xmm7
        vpinsrw $0x2, 0x40(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0x40(%rdi)
        vmovdqu 0x42(%rsi), %xmm6
        vmovd 0x52(%rsi), %xmm7
        vpinsrw $0x2, 0x56(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0x60(%rdi)
        vmovdqu 0x58(%rsi), %xmm6
        vmovd 0x68(%rsi), %xmm7
        vpinsrw $0x2, 0x6c(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0x80(%rdi)
        vmovdqu 0x6e(%rsi), %xmm6
        vmovd 0x7e(%rsi), %xmm7
        vpinsrw $0x2, 0x82(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0xa0(%rdi)
        vmovdqu 0x84(%rsi), %xmm6
        vmovd 0x94(%rsi), %xmm7
        vpinsrw $0x2, 0x98(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0xc0(%rdi)
        vmovdqu 0x9a(%rsi), %xmm6
        vmovd 0xaa(%rsi), %xmm7
        vpinsrw $0x2, 0xae(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0xe0(%rdi)
        vmovdqu 0xb0(%rsi), %xmm6
        vmovd 0xc0(%rsi), %xmm7
        vpinsrw $0x2, 0xc4(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0x100(%rdi)
        vmovdqu 0xc6(%rsi), %xmm6
        vmovd 0xd6(%rsi), %xmm7
        vpinsrw $0x2, 0xda(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0x120(%rdi)
        vmovdqu 0xdc(%rsi), %xmm6
        vmovd 0xec(%rsi), %xmm7
        vpinsrw $0x2, 0xf0(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0x140(%rdi)
        vmovdqu 0xf2(%rsi), %xmm6
        vmovd 0x102(%rsi), %xmm7
        vpinsrw $0x2, 0x106(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0x160(%rdi)
        vmovdqu 0x108(%rsi), %xmm6
        vmovd 0x118(%rsi), %xmm7
        vpinsrw $0x2, 0x11c(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0x180(%rdi)
        vmovdqu 0x11e(%rsi), %xmm6
        vmovd 0x12e(%rsi), %xmm7
        vpinsrw $0x2, 0x132(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0x1a0(%rdi)
        vmovdqu 0x134(%rsi), %xmm6
        vmovd 0x144(%rsi), %xmm7
        vpinsrw $0x2, 0x148(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0x1c0(%rdi)
        vmovdqu 0x14a(%rsi), %xmm6
        vmovd 0x15a(%rsi), %xmm7
        vpinsrw $0x2, 0x15e(%rsi), %xmm7, %xmm7
        vinserti128 $0x1, %xmm7, %ymm6, %ymm6
        vpermq $0x94, %ymm6, %ymm6     # ymm6 = ymm6[0,1,1,2]
        vpshufb %ymm2, %ymm6, %ymm6
        vpsrlvd %ymm3, %ymm6, %ymm6
        vpsrlvq %ymm4, %ymm6, %ymm6
        vpmullw %ymm5, %ymm6, %ymm6
        vpsrlw $0x1, %ymm6, %ymm6
        vpand %ymm1, %ymm6, %ymm6
        vpmulhrsw %ymm0, %ymm6, %ymm6
        vmovdqu %ymm6, 0x1e0(%rdi)
        retq
        .cfi_endproc

MLK_ASM_FN_SIZE(poly_decompress_d11_avx2_asm)

#endif /* MLK_ARITH_BACKEND_X86_64_DEFAULT && !MLK_CONFIG_MULTILEVEL_NO_SHARED \
          && !MLK_CONFIG_NO_DECAPS_API && (MLK_CONFIG_MULTILEVEL_WITH_SHARED || \
          MLKEM_K == 4) */

#if defined(__ELF__)
.section .note.GNU-stack,"",%progbits
#endif
