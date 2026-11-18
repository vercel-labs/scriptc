/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

/*************************************************
 * Name:        mlk_rej_uniform_avx2_asm
 *
 * Description: Run rejection sampling on uniform random bytes to generate
 *              uniform random integers mod q
 *
 * Arguments:   - int16_t *r:          pointer to output buffer of MLKEM_N
 *                                     16-bit coefficients.
 *              - const uint8_t *buf:  pointer to input buffer
 *                                     (assumed to be uniform random bytes)
 *              - unsigned buflen:     length of input buffer in bytes.
 *                                     Must be a multiple of 12.
 *
 * Returns number of sampled 16-bit integers (at most MLKEM_N).
 **************************************************/
#include "../../../common.h"

#if defined(MLK_ARITH_BACKEND_X86_64_DEFAULT) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED)
/*yaml
  Name: rej_uniform_avx2_asm
  Description: x86_64 AVX2 rejection sampling
  Signature: uint64_t mlk_rej_uniform_avx2_asm(int16_t *r, const uint8_t *buf, unsigned buflen, const uint8_t *table)
  ABI:
    Architecture: x86_64
    CallingConvention: SysV
    Features: [AVX2]
    rdi:
      type: buffer
      size_bytes: 512
      permissions: write-only
      c_parameter: int16_t *r
      description: Output buffer (256 x int16_t)
    rsi:
      type: buffer
      size_bytes: rdx
      permissions: read-only
      c_parameter: const uint8_t *buf
      description: Input buffer
    rdx:
      type: scalar
      c_parameter: unsigned buflen
      description: Length of input buffer (must be multiple of 12)
      test_with: 504  # MLKEM_GEN_MATRIX_NBLOCKS * MLK_XOF_RATE
    rcx:
      type: buffer
      size_bytes: 4096
      permissions: read-only
      c_parameter: const uint8_t *table
      description: Lookup table
*/


/*
 * WARNING: This file is auto-derived from the mlkem-native source file
 *   dev/x86_64/src/mlkem_rej_uniform_avx2_asm.S using scripts/simpasm. Do not modify it directly.
 */

.text
.balign 4
.global MLK_ASM_NAMESPACE(rej_uniform_avx2_asm)
MLK_ASM_FN_SYMBOL(rej_uniform_avx2_asm)

        .cfi_startproc
        subq $0x210, %rsp            # imm = 0x210
        .cfi_adjust_cfa_offset 0x210
        xorl %eax, %eax
        testq %rdx, %rdx
        je Lmlk_rej_uniform_asm_end
        movabsq $0xd010d010d010d01, %rax # imm = 0xD010D010D010D01
        movq %rax, %xmm0
        pinsrq $0x1, %rax, %xmm0
        movabsq $0xfff0fff0fff0fff, %rax # imm = 0xFFF0FFF0FFF0FFF
        movq %rax, %xmm5
        pinsrq $0x1, %rax, %xmm5
        movabsq $0x504040302010100, %rax # imm = 0x504040302010100
        movq %rax, %xmm4
        movabsq $0xb0a0a0908070706, %rax # imm = 0xB0A0A0908070706
        pinsrq $0x1, %rax, %xmm4
        movq $0x0, %rax
        movq $0x0, %r8
        movq $0x5555, %r9            # imm = 0x5555

Lmlk_rej_uniform_asm_loop_start:
        movq (%rsi,%r8), %xmm2
        pinsrd $0x2, 0x8(%rsi,%r8), %xmm2
        pshufb %xmm4, %xmm2
        movdqa %xmm2, %xmm3
        psrlw $0x4, %xmm3
        pblendw $0xaa, %xmm3, %xmm2     # xmm2 = xmm2[0],xmm3[1],xmm2[2],xmm3[3],xmm2[4],xmm3[5],xmm2[6],xmm3[7]
        pand %xmm5, %xmm2
        movdqa %xmm0, %xmm1
        pcmpgtw %xmm2, %xmm1
        pmovmskb %xmm1, %r11d
        pextq %r9, %r11, %r11
        movq %r11, %r10
        shlq $0x4, %r10
        movdqu (%rcx,%r10), %xmm3
        pshufb %xmm3, %xmm2
        movdqu %xmm2, (%rsp,%rax,2)
        popcntq %r11, %r11
        addq %r11, %rax
        cmpq $0x100, %rax            # imm = 0x100
        jae Lmlk_rej_uniform_asm_final_copy
        addq $0xc, %r8
        cmpq %r8, %rdx
        ja Lmlk_rej_uniform_asm_loop_start

Lmlk_rej_uniform_asm_final_copy:
        movq $0x100, %rcx            # imm = 0x100
        cmpq $0x100, %rax            # imm = 0x100
        cmovaq %rcx, %rax
        movq %rsp, %rsi
        movq %rax, %rcx
        shlq %rcx
        rep  movsb (%rsi), %es:(%rdi)

Lmlk_rej_uniform_asm_end:
        addq $0x210, %rsp            # imm = 0x210
        .cfi_adjust_cfa_offset -0x210
        retq
        .cfi_endproc

MLK_ASM_FN_SIZE(rej_uniform_avx2_asm)

#endif /* MLK_ARITH_BACKEND_X86_64_DEFAULT && !MLK_CONFIG_MULTILEVEL_NO_SHARED \
        */

#if defined(__ELF__)
.section .note.GNU-stack,"",%progbits
#endif
