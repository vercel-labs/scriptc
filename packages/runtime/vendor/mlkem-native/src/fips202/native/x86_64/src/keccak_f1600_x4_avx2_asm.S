/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */
#include "../../../../common.h"

#if defined(MLK_FIPS202_X86_64_NEED_X4_AVX2) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED)
/*yaml
  Name: keccak_f1600_x4_avx2_asm
  Description: x86_64 AVX2 Keccak-f[1600] permutation for four sequential states
  Signature: void mlk_keccak_f1600_x4_avx2_asm(uint64_t states[100], const uint64_t rc[24], const uint64_t rho8[4], const uint64_t rho56[4])
  ABI:
    Architecture: x86_64
    CallingConvention: SysV
    Features: [AVX2]
    rdi:
      type: buffer
      size_bytes: 800
      permissions: read/write
      c_parameter: uint64_t states[100]
      description: Four sequential Keccak states (4 x 25 x uint64_t)
    rsi:
      type: buffer
      size_bytes: 192
      permissions: read-only
      c_parameter: const uint64_t rc[24]
      description: Round constants (24 x uint64_t)
    rdx:
      type: buffer
      size_bytes: 32
      permissions: read-only
      c_parameter: const uint64_t rho8[4]
      description: Rotation constant rho8 (4 x uint64_t)
    rcx:
      type: buffer
      size_bytes: 32
      permissions: read-only
      c_parameter: const uint64_t rho56[4]
      description: Rotation constant rho56 (4 x uint64_t)
*/


/*
 * WARNING: This file is auto-derived from the mlkem-native source file
 *   dev/fips202/x86_64/src/keccak_f1600_x4_avx2_asm.S using scripts/simpasm. Do not modify it directly.
 */

.text
.balign 4
.global MLK_ASM_NAMESPACE(keccak_f1600_x4_avx2_asm)
MLK_ASM_FN_SYMBOL(keccak_f1600_x4_avx2_asm)

        .cfi_startproc
        movq %rsp, %r11
        .cfi_def_cfa_register %r11
        andq $-0x20, %rsp
        subq $0x300, %rsp            # imm = 0x300
        vmovdqu (%rdi), %ymm0
        vmovdqu 0xc8(%rdi), %ymm3
        vmovdqu 0x190(%rdi), %ymm1
        vmovdqu 0x258(%rdi), %ymm4
        vpunpcklqdq %ymm3, %ymm0, %ymm2 # ymm2 = ymm0[0],ymm3[0],ymm0[2],ymm3[2]
        vpunpckhqdq %ymm3, %ymm0, %ymm0 # ymm0 = ymm0[1],ymm3[1],ymm0[3],ymm3[3]
        vpunpcklqdq %ymm4, %ymm1, %ymm3 # ymm3 = ymm1[0],ymm4[0],ymm1[2],ymm4[2]
        vperm2i128 $0x20, %ymm3, %ymm2, %ymm7 # ymm7 = ymm2[0,1],ymm3[0,1]
        vpunpckhqdq %ymm4, %ymm1, %ymm1 # ymm1 = ymm1[1],ymm4[1],ymm1[3],ymm4[3]
        vperm2i128 $0x31, %ymm3, %ymm2, %ymm3 # ymm3 = ymm2[2,3],ymm3[2,3]
        vmovdqu 0x278(%rdi), %ymm4
        vmovdqu %ymm3, 0x40(%rsp)
        vperm2i128 $0x31, %ymm1, %ymm0, %ymm3 # ymm3 = ymm0[2,3],ymm1[2,3]
        vmovdqu %ymm7, (%rsp)
        vperm2i128 $0x20, %ymm1, %ymm0, %ymm7 # ymm7 = ymm0[0,1],ymm1[0,1]
        vmovdqu 0x20(%rdi), %ymm0
        vmovdqu 0x1b0(%rdi), %ymm1
        vmovdqu %ymm3, 0x60(%rsp)
        vmovdqu 0xe8(%rdi), %ymm3
        vmovdqu %ymm7, 0x20(%rsp)
        vpunpcklqdq %ymm3, %ymm0, %ymm2 # ymm2 = ymm0[0],ymm3[0],ymm0[2],ymm3[2]
        vpunpckhqdq %ymm3, %ymm0, %ymm0 # ymm0 = ymm0[1],ymm3[1],ymm0[3],ymm3[3]
        vpunpcklqdq %ymm4, %ymm1, %ymm3 # ymm3 = ymm1[0],ymm4[0],ymm1[2],ymm4[2]
        vperm2i128 $0x20, %ymm3, %ymm2, %ymm7 # ymm7 = ymm2[0,1],ymm3[0,1]
        vpunpckhqdq %ymm4, %ymm1, %ymm1 # ymm1 = ymm1[1],ymm4[1],ymm1[3],ymm4[3]
        vperm2i128 $0x31, %ymm3, %ymm2, %ymm3 # ymm3 = ymm2[2,3],ymm3[2,3]
        vmovdqu 0x298(%rdi), %ymm4
        vperm2i128 $0x31, %ymm1, %ymm0, %ymm14 # ymm14 = ymm0[2,3],ymm1[2,3]
        vmovdqu %ymm7, 0x80(%rsp)
        vperm2i128 $0x20, %ymm1, %ymm0, %ymm7 # ymm7 = ymm0[0,1],ymm1[0,1]
        vmovdqu 0x40(%rdi), %ymm0
        vmovdqu 0x1d0(%rdi), %ymm1
        vmovdqu %ymm3, 0xc0(%rsp)
        vmovdqu 0x108(%rdi), %ymm3
        vmovdqu %ymm14, %ymm10
        vmovdqu %ymm7, 0xa0(%rsp)
        vpunpcklqdq %ymm3, %ymm0, %ymm2 # ymm2 = ymm0[0],ymm3[0],ymm0[2],ymm3[2]
        vpunpckhqdq %ymm3, %ymm0, %ymm0 # ymm0 = ymm0[1],ymm3[1],ymm0[3],ymm3[3]
        vpunpcklqdq %ymm4, %ymm1, %ymm3 # ymm3 = ymm1[0],ymm4[0],ymm1[2],ymm4[2]
        vpunpckhqdq %ymm4, %ymm1, %ymm1 # ymm1 = ymm1[1],ymm4[1],ymm1[3],ymm4[3]
        vperm2i128 $0x20, %ymm3, %ymm2, %ymm11 # ymm11 = ymm2[0,1],ymm3[0,1]
        vperm2i128 $0x31, %ymm3, %ymm2, %ymm3 # ymm3 = ymm2[2,3],ymm3[2,3]
        vperm2i128 $0x20, %ymm1, %ymm0, %ymm7 # ymm7 = ymm0[0,1],ymm1[0,1]
        vmovdqu %ymm3, 0x100(%rsp)
        vperm2i128 $0x31, %ymm1, %ymm0, %ymm8 # ymm8 = ymm0[2,3],ymm1[2,3]
        vmovdqu 0x128(%rdi), %ymm3
        vmovdqu 0x60(%rdi), %ymm0
        vmovdqu 0x1f0(%rdi), %ymm1
        vmovdqu %ymm7, 0xe0(%rsp)
        vmovdqu %ymm11, %ymm14
        vmovdqu 0x2b8(%rdi), %ymm4
        vmovdqu 0x2f8(%rdi), %ymm5
        vpunpcklqdq %ymm3, %ymm0, %ymm2 # ymm2 = ymm0[0],ymm3[0],ymm0[2],ymm3[2]
        vpunpckhqdq %ymm3, %ymm0, %ymm0 # ymm0 = ymm0[1],ymm3[1],ymm0[3],ymm3[3]
        vpunpcklqdq %ymm4, %ymm1, %ymm3 # ymm3 = ymm1[0],ymm4[0],ymm1[2],ymm4[2]
        vpunpckhqdq %ymm4, %ymm1, %ymm1 # ymm1 = ymm1[1],ymm4[1],ymm1[3],ymm4[3]
        vmovdqu 0x2d8(%rdi), %ymm4
        vperm2i128 $0x20, %ymm3, %ymm2, %ymm15 # ymm15 = ymm2[0,1],ymm3[0,1]
        vperm2i128 $0x31, %ymm3, %ymm2, %ymm3 # ymm3 = ymm2[2,3],ymm3[2,3]
        vperm2i128 $0x20, %ymm1, %ymm0, %ymm7 # ymm7 = ymm0[0,1],ymm1[0,1]
        vperm2i128 $0x31, %ymm1, %ymm0, %ymm9 # ymm9 = ymm0[2,3],ymm1[2,3]
        vmovdqu %ymm3, 0x140(%rsp)
        vmovdqu 0x80(%rdi), %ymm0
        vmovdqu 0x148(%rdi), %ymm3
        vmovdqu 0x210(%rdi), %ymm1
        vmovdqu %ymm7, 0x120(%rsp)
        vpunpcklqdq %ymm3, %ymm0, %ymm2 # ymm2 = ymm0[0],ymm3[0],ymm0[2],ymm3[2]
        vpunpckhqdq %ymm3, %ymm0, %ymm0 # ymm0 = ymm0[1],ymm3[1],ymm0[3],ymm3[3]
        vpunpcklqdq %ymm4, %ymm1, %ymm3 # ymm3 = ymm1[0],ymm4[0],ymm1[2],ymm4[2]
        vpunpckhqdq %ymm4, %ymm1, %ymm1 # ymm1 = ymm1[1],ymm4[1],ymm1[3],ymm4[3]
        vperm2i128 $0x20, %ymm3, %ymm2, %ymm7 # ymm7 = ymm2[0,1],ymm3[0,1]
        vperm2i128 $0x31, %ymm3, %ymm2, %ymm13 # ymm13 = ymm2[2,3],ymm3[2,3]
        vperm2i128 $0x31, %ymm1, %ymm0, %ymm3 # ymm3 = ymm0[2,3],ymm1[2,3]
        vmovdqu %ymm7, 0x160(%rsp)
        vperm2i128 $0x20, %ymm1, %ymm0, %ymm7 # ymm7 = ymm0[0,1],ymm1[0,1]
        vmovdqu 0xa0(%rdi), %ymm0
        vmovdqu 0x230(%rdi), %ymm1
        vmovdqu %ymm3, 0x1a0(%rsp)
        vmovdqu 0x168(%rdi), %ymm3
        vpunpcklqdq %ymm5, %ymm1, %ymm4 # ymm4 = ymm1[0],ymm5[0],ymm1[2],ymm5[2]
        vpunpckhqdq %ymm5, %ymm1, %ymm1 # ymm1 = ymm1[1],ymm5[1],ymm1[3],ymm5[3]
        vmovdqu %ymm7, 0x180(%rsp)
        vpunpcklqdq %ymm3, %ymm0, %ymm2 # ymm2 = ymm0[0],ymm3[0],ymm0[2],ymm3[2]
        vpunpckhqdq %ymm3, %ymm0, %ymm0 # ymm0 = ymm0[1],ymm3[1],ymm0[3],ymm3[3]
        vperm2i128 $0x20, %ymm4, %ymm2, %ymm12 # ymm12 = ymm2[0,1],ymm4[0,1]
        vperm2i128 $0x20, %ymm1, %ymm0, %ymm3 # ymm3 = ymm0[0,1],ymm1[0,1]
        vperm2i128 $0x31, %ymm4, %ymm2, %ymm7 # ymm7 = ymm2[2,3],ymm4[2,3]
        vperm2i128 $0x31, %ymm1, %ymm0, %ymm4 # ymm4 = ymm0[2,3],ymm1[2,3]
        vmovq 0x250(%rdi), %xmm0
        vmovq 0xc0(%rdi), %xmm1
        vmovdqu %ymm12, 0x1c0(%rsp)
        vmovdqu %ymm4, 0x1e0(%rsp)
        vpinsrq $0x1, 0x318(%rdi), %xmm0, %xmm0
        vpinsrq $0x1, 0x188(%rdi), %xmm1, %xmm1
        vinserti128 $0x1, %xmm0, %ymm1, %ymm2
        movq $0x0, %r10

LLmlk_keccak_f1600_x4_avx2:
        vmovdqu 0xa0(%rsp), %ymm4
        vpxor 0x1c0(%rsp), %ymm9, %ymm0
        vmovdqu %ymm9, 0x200(%rsp)
        vmovdqu %ymm10, %ymm9
        vmovdqu 0xc0(%rsp), %ymm11
        vmovdqu 0x160(%rsp), %ymm12
        vmovdqu %ymm3, 0x240(%rsp)
        vpxor 0x100(%rsp), %ymm4, %ymm1
        vmovdqu 0x40(%rsp), %ymm10
        vmovdqu %ymm4, 0x220(%rsp)
        vpxor %ymm3, %ymm12, %ymm12
        vmovdqu 0x20(%rsp), %ymm6
        vmovdqu 0x140(%rsp), %ymm4
        vmovdqu %ymm14, 0x2a0(%rsp)
        vpxor %ymm1, %ymm0, %ymm0
        vpxor %ymm8, %ymm11, %ymm1
        vpxor 0x180(%rsp), %ymm7, %ymm11
        vmovdqu %ymm10, 0x280(%rsp)
        vpxor %ymm1, %ymm12, %ymm12
        vpxor %ymm15, %ymm9, %ymm1
        vmovdqu 0xe0(%rsp), %ymm3
        vmovdqu %ymm8, 0x260(%rsp)
        vpxor %ymm1, %ymm11, %ymm11
        vpxor 0x120(%rsp), %ymm14, %ymm1
        vpxor %ymm6, %ymm12, %ymm12
        vmovdqu 0x60(%rsp), %ymm8
        vpxor %ymm10, %ymm11, %ymm11
        vpxor 0x1e0(%rsp), %ymm13, %ymm10
        vpxor %ymm4, %ymm3, %ymm3
        vmovdqu %ymm4, 0x2c0(%rsp)
        vpsrlq $0x3f, %ymm12, %ymm4
        vpsrlq $0x3f, %ymm11, %ymm5
        vpxor (%rsp), %ymm0, %ymm0
        vpxor %ymm1, %ymm10, %ymm10
        vmovdqu 0x80(%rsp), %ymm1
        vpxor %ymm8, %ymm10, %ymm10
        vmovdqu %ymm1, %ymm14
        vpxor 0x1a0(%rsp), %ymm2, %ymm1
        vmovdqu %ymm14, 0x2e0(%rsp)
        vpxor %ymm3, %ymm1, %ymm1
        vpsllq $0x1, %ymm12, %ymm3
        vpor %ymm4, %ymm3, %ymm3
        vpsllq $0x1, %ymm11, %ymm4
        vpxor %ymm14, %ymm1, %ymm1
        vpor %ymm5, %ymm4, %ymm4
        vpsrlq $0x3f, %ymm10, %ymm14
        vpxor %ymm1, %ymm3, %ymm3
        vpsllq $0x1, %ymm10, %ymm5
        vpxor %ymm0, %ymm4, %ymm4
        vpor %ymm14, %ymm5, %ymm5
        vpxor %ymm6, %ymm4, %ymm6
        vpxor %ymm12, %ymm5, %ymm5
        vpsrlq $0x3f, %ymm1, %ymm12
        vpsllq $0x1, %ymm1, %ymm1
        vpxor %ymm7, %ymm5, %ymm7
        vpxor %ymm9, %ymm5, %ymm9
        vpor %ymm12, %ymm1, %ymm1
        vpxor (%rsp), %ymm3, %ymm12
        vpxor %ymm11, %ymm1, %ymm1
        vpsrlq $0x3f, %ymm0, %ymm11
        vpsllq $0x1, %ymm0, %ymm0
        vpxor %ymm13, %ymm1, %ymm13
        vpxor %ymm8, %ymm1, %ymm8
        vpor %ymm11, %ymm0, %ymm0
        vpxor %ymm10, %ymm0, %ymm0
        vpxor 0xc0(%rsp), %ymm4, %ymm10
        vpxor %ymm2, %ymm0, %ymm2
        vpsrlq $0x14, %ymm10, %ymm11
        vpsllq $0x2c, %ymm10, %ymm10
        vpor %ymm11, %ymm10, %ymm10
        vpxor %ymm15, %ymm5, %ymm11
        vpbroadcastq (%rsi), %ymm15
        vpsrlq $0x15, %ymm11, %ymm14
        vpsllq $0x2b, %ymm11, %ymm11
        vpor %ymm14, %ymm11, %ymm11
        vpandn %ymm11, %ymm10, %ymm14
        vpxor %ymm15, %ymm14, %ymm14
        vpxor %ymm12, %ymm14, %ymm15
        vpsrlq $0x2b, %ymm13, %ymm14
        vpsllq $0x15, %ymm13, %ymm13
        vmovdqu %ymm15, (%rsp)
        vpor %ymm14, %ymm13, %ymm13
        vpandn %ymm13, %ymm11, %ymm14
        vpxor %ymm10, %ymm14, %ymm15
        vpsrlq $0x32, %ymm2, %ymm14
        vpsllq $0xe, %ymm2, %ymm2
        vmovdqu %ymm15, 0x20(%rsp)
        vpor %ymm14, %ymm2, %ymm2
        vpandn %ymm2, %ymm13, %ymm14
        vpxor %ymm11, %ymm14, %ymm11
        vmovdqu %ymm11, 0x40(%rsp)
        vpandn %ymm12, %ymm2, %ymm11
        vpandn %ymm10, %ymm12, %ymm12
        vpxor %ymm13, %ymm11, %ymm11
        vmovdqu %ymm11, 0x60(%rsp)
        vpxor %ymm2, %ymm12, %ymm11
        vpsrlq $0x24, %ymm8, %ymm2
        vpsllq $0x1c, %ymm8, %ymm8
        vmovdqu %ymm11, 0x80(%rsp)
        vpor %ymm2, %ymm8, %ymm8
        vpxor 0xe0(%rsp), %ymm0, %ymm2
        vpsrlq $0x2c, %ymm2, %ymm10
        vpsllq $0x14, %ymm2, %ymm2
        vpor %ymm10, %ymm2, %ymm2
        vpxor 0x100(%rsp), %ymm3, %ymm10
        vpsrlq $0x3d, %ymm10, %ymm11
        vpsllq $0x3, %ymm10, %ymm10
        vpor %ymm11, %ymm10, %ymm10
        vpandn %ymm10, %ymm2, %ymm11
        vpxor %ymm8, %ymm11, %ymm11
        vmovdqu %ymm11, 0xa0(%rsp)
        vpxor 0x160(%rsp), %ymm4, %ymm11
        vpsrlq $0x13, %ymm11, %ymm12
        vpsllq $0x2d, %ymm11, %ymm11
        vpor %ymm12, %ymm11, %ymm11
        vpandn %ymm11, %ymm10, %ymm12
        vpxor %ymm2, %ymm12, %ymm12
        vmovdqu %ymm12, 0xc0(%rsp)
        vpsrlq $0x3, %ymm7, %ymm12
        vpsllq $0x3d, %ymm7, %ymm7
        vpor %ymm12, %ymm7, %ymm7
        vpandn %ymm7, %ymm11, %ymm12
        vpxor %ymm10, %ymm12, %ymm10
        vpandn %ymm8, %ymm7, %ymm12
        vpandn %ymm2, %ymm8, %ymm8
        vpsrlq $0x3f, %ymm6, %ymm2
        vpsllq $0x1, %ymm6, %ymm6
        vpxor %ymm11, %ymm12, %ymm14
        vpor %ymm2, %ymm6, %ymm6
        vpsrlq $0x3a, %ymm9, %ymm2
        vpxor %ymm7, %ymm8, %ymm12
        vpsllq $0x6, %ymm9, %ymm9
        vmovdqu %ymm12, 0xe0(%rsp)
        vpxor 0x1a0(%rsp), %ymm0, %ymm7
        vpor %ymm2, %ymm9, %ymm9
        vpxor 0x120(%rsp), %ymm1, %ymm2
        vpshufb (%rdx), %ymm7, %ymm7
        vpsrlq $0x27, %ymm2, %ymm11
        vpsllq $0x19, %ymm2, %ymm2
        vpor %ymm2, %ymm11, %ymm11
        vpandn %ymm11, %ymm9, %ymm2
        vpandn %ymm7, %ymm11, %ymm8
        vpxor %ymm6, %ymm2, %ymm12
        vpxor 0x1c0(%rsp), %ymm3, %ymm2
        vpxor %ymm9, %ymm8, %ymm8
        vmovdqu %ymm12, 0x100(%rsp)
        vpsrlq $0x2e, %ymm2, %ymm12
        vpsllq $0x12, %ymm2, %ymm2
        vpor %ymm2, %ymm12, %ymm2
        vpandn %ymm2, %ymm7, %ymm12
        vpxor %ymm11, %ymm12, %ymm15
        vpandn %ymm6, %ymm2, %ymm11
        vpandn %ymm9, %ymm6, %ymm6
        vpxor %ymm7, %ymm11, %ymm12
        vmovdqu %ymm12, 0x120(%rsp)
        vpxor %ymm2, %ymm6, %ymm12
        vpxor 0x2e0(%rsp), %ymm0, %ymm6
        vpxor 0x2c0(%rsp), %ymm0, %ymm0
        vmovdqu %ymm12, 0x140(%rsp)
        vpsrlq $0x25, %ymm6, %ymm2
        vpsllq $0x1b, %ymm6, %ymm6
        vpor %ymm6, %ymm2, %ymm2
        vpxor 0x220(%rsp), %ymm3, %ymm6
        vpxor 0x200(%rsp), %ymm3, %ymm3
        vpsrlq $0x1c, %ymm6, %ymm7
        vpsllq $0x24, %ymm6, %ymm6
        vpor %ymm6, %ymm7, %ymm7
        vpxor 0x260(%rsp), %ymm4, %ymm6
        vpxor 0x240(%rsp), %ymm4, %ymm4
        vpsrlq $0x36, %ymm6, %ymm12
        vpsllq $0xa, %ymm6, %ymm6
        vpor %ymm6, %ymm12, %ymm12
        vpxor 0x180(%rsp), %ymm5, %ymm6
        vpxor 0x280(%rsp), %ymm5, %ymm5
        vpandn %ymm12, %ymm7, %ymm9
        vpsrlq $0x31, %ymm6, %ymm11
        vpsllq $0xf, %ymm6, %ymm6
        vpxor %ymm2, %ymm9, %ymm9
        vpor %ymm6, %ymm11, %ymm11
        vpandn %ymm11, %ymm12, %ymm6
        vpxor %ymm7, %ymm6, %ymm6
        vmovdqu %ymm6, 0x160(%rsp)
        vpxor 0x1e0(%rsp), %ymm1, %ymm6
        vpxor 0x2a0(%rsp), %ymm1, %ymm1
        vpshufb (%rcx), %ymm6, %ymm6
        vpandn %ymm6, %ymm11, %ymm13
        vpxor %ymm12, %ymm13, %ymm13
        vmovdqu %ymm13, 0x180(%rsp)
        vpandn %ymm2, %ymm6, %ymm13
        vpandn %ymm7, %ymm2, %ymm2
        vpxor %ymm6, %ymm2, %ymm2
        vpsrlq $0x3e, %ymm4, %ymm6
        vpxor %ymm11, %ymm13, %ymm13
        vmovdqu %ymm2, 0x1a0(%rsp)
        vpsrlq $0x2, %ymm5, %ymm2
        vpsllq $0x3e, %ymm5, %ymm5
        vpor %ymm5, %ymm2, %ymm2
        vpsrlq $0x9, %ymm1, %ymm5
        vpsllq $0x37, %ymm1, %ymm1
        vpsllq $0x2, %ymm4, %ymm4
        vpor %ymm1, %ymm5, %ymm1
        vpsrlq $0x19, %ymm0, %ymm5
        vpor %ymm4, %ymm6, %ymm4
        vpsllq $0x27, %ymm0, %ymm0
        vpor %ymm0, %ymm5, %ymm5
        vpandn %ymm5, %ymm1, %ymm0
        vpxor %ymm2, %ymm0, %ymm0
        vmovdqu %ymm0, 0x1c0(%rsp)
        vpsrlq $0x17, %ymm3, %ymm0
        vpsllq $0x29, %ymm3, %ymm3
        vpor %ymm3, %ymm0, %ymm0
        vpandn %ymm4, %ymm0, %ymm7
        vpandn %ymm0, %ymm5, %ymm3
        vpxor %ymm5, %ymm7, %ymm7
        vpandn %ymm2, %ymm4, %ymm5
        vpandn %ymm1, %ymm2, %ymm2
        vpxor %ymm0, %ymm5, %ymm5
        vpxor %ymm1, %ymm3, %ymm3
        vpxor %ymm4, %ymm2, %ymm2
        vmovdqu %ymm5, 0x1e0(%rsp)
        addq $0x8, %rsi
        addq $0x1, %r10
        cmpq $0x18, %r10
        jne LLmlk_keccak_f1600_x4_avx2
        vmovdqu (%rsp), %ymm4
        vmovdqu 0x40(%rsp), %ymm5
        vmovdqu 0x20(%rsp), %ymm0
        vmovdqu 0x60(%rsp), %ymm1
        vmovdqu 0x1c0(%rsp), %ymm12
        vmovdqu %ymm2, 0x1c0(%rsp)
        vpunpcklqdq %ymm0, %ymm4, %ymm2 # ymm2 = ymm4[0],ymm0[0],ymm4[2],ymm0[2]
        vpunpckhqdq %ymm0, %ymm4, %ymm0 # ymm0 = ymm4[1],ymm0[1],ymm4[3],ymm0[3]
        vpunpcklqdq %ymm1, %ymm5, %ymm4 # ymm4 = ymm5[0],ymm1[0],ymm5[2],ymm1[2]
        vpunpckhqdq %ymm1, %ymm5, %ymm1 # ymm1 = ymm5[1],ymm1[1],ymm5[3],ymm1[3]
        vperm2i128 $0x20, %ymm4, %ymm2, %ymm6 # ymm6 = ymm2[0,1],ymm4[0,1]
        vperm2i128 $0x31, %ymm4, %ymm2, %ymm2 # ymm2 = ymm2[2,3],ymm4[2,3]
        vmovdqu 0x80(%rsp), %ymm4
        vperm2i128 $0x20, %ymm1, %ymm0, %ymm5 # ymm5 = ymm0[0,1],ymm1[0,1]
        vperm2i128 $0x31, %ymm1, %ymm0, %ymm0 # ymm0 = ymm0[2,3],ymm1[2,3]
        vmovdqu %ymm6, (%rdi)
        vmovdqu %ymm5, 0xc8(%rdi)
        vmovdqu %ymm2, 0x190(%rdi)
        vmovdqu %ymm0, 0x258(%rdi)
        vmovdqu 0xa0(%rsp), %ymm0
        vpunpcklqdq %ymm0, %ymm4, %ymm2 # ymm2 = ymm4[0],ymm0[0],ymm4[2],ymm0[2]
        vpunpckhqdq %ymm0, %ymm4, %ymm1 # ymm1 = ymm4[1],ymm0[1],ymm4[3],ymm0[3]
        vmovdqu 0xc0(%rsp), %ymm0
        vpunpcklqdq %ymm10, %ymm0, %ymm4 # ymm4 = ymm0[0],ymm10[0],ymm0[2],ymm10[2]
        vpunpckhqdq %ymm10, %ymm0, %ymm0 # ymm0 = ymm0[1],ymm10[1],ymm0[3],ymm10[3]
        vperm2i128 $0x20, %ymm4, %ymm2, %ymm6 # ymm6 = ymm2[0,1],ymm4[0,1]
        vperm2i128 $0x20, %ymm0, %ymm1, %ymm5 # ymm5 = ymm1[0,1],ymm0[0,1]
        vperm2i128 $0x31, %ymm4, %ymm2, %ymm2 # ymm2 = ymm2[2,3],ymm4[2,3]
        vmovdqu 0xe0(%rsp), %ymm4
        vperm2i128 $0x31, %ymm0, %ymm1, %ymm1 # ymm1 = ymm1[2,3],ymm0[2,3]
        vmovdqu 0x100(%rsp), %ymm0
        vmovdqu %ymm2, 0x1b0(%rdi)
        vmovdqu %ymm1, 0x278(%rdi)
        vpunpcklqdq %ymm4, %ymm14, %ymm2 # ymm2 = ymm14[0],ymm4[0],ymm14[2],ymm4[2]
        vpunpckhqdq %ymm4, %ymm14, %ymm1 # ymm1 = ymm14[1],ymm4[1],ymm14[3],ymm4[3]
        vpunpcklqdq %ymm8, %ymm0, %ymm4 # ymm4 = ymm0[0],ymm8[0],ymm0[2],ymm8[2]
        vpunpckhqdq %ymm8, %ymm0, %ymm0 # ymm0 = ymm0[1],ymm8[1],ymm0[3],ymm8[3]
        vmovdqu %ymm6, 0x20(%rdi)
        vmovdqu %ymm5, 0xe8(%rdi)
        vperm2i128 $0x20, %ymm4, %ymm2, %ymm6 # ymm6 = ymm2[0,1],ymm4[0,1]
        vperm2i128 $0x20, %ymm0, %ymm1, %ymm5 # ymm5 = ymm1[0,1],ymm0[0,1]
        vperm2i128 $0x31, %ymm4, %ymm2, %ymm2 # ymm2 = ymm2[2,3],ymm4[2,3]
        vperm2i128 $0x31, %ymm0, %ymm1, %ymm1 # ymm1 = ymm1[2,3],ymm0[2,3]
        vmovdqu 0x120(%rsp), %ymm4
        vmovdqu 0x140(%rsp), %ymm0
        vmovdqu %ymm2, 0x1d0(%rdi)
        vmovdqu %ymm1, 0x298(%rdi)
        vpunpcklqdq %ymm4, %ymm15, %ymm2 # ymm2 = ymm15[0],ymm4[0],ymm15[2],ymm4[2]
        vpunpckhqdq %ymm4, %ymm15, %ymm1 # ymm1 = ymm15[1],ymm4[1],ymm15[3],ymm4[3]
        vpunpcklqdq %ymm9, %ymm0, %ymm4 # ymm4 = ymm0[0],ymm9[0],ymm0[2],ymm9[2]
        vmovdqu %ymm5, 0x108(%rdi)
        vpunpckhqdq %ymm9, %ymm0, %ymm0 # ymm0 = ymm0[1],ymm9[1],ymm0[3],ymm9[3]
        vmovdqu %ymm6, 0x40(%rdi)
        vperm2i128 $0x20, %ymm4, %ymm2, %ymm6 # ymm6 = ymm2[0,1],ymm4[0,1]
        vperm2i128 $0x31, %ymm4, %ymm2, %ymm2 # ymm2 = ymm2[2,3],ymm4[2,3]
        vperm2i128 $0x20, %ymm0, %ymm1, %ymm5 # ymm5 = ymm1[0,1],ymm0[0,1]
        vmovdqu 0x160(%rsp), %ymm4
        vperm2i128 $0x31, %ymm0, %ymm1, %ymm1 # ymm1 = ymm1[2,3],ymm0[2,3]
        vmovdqu 0x180(%rsp), %ymm0
        vmovdqu %ymm5, 0x128(%rdi)
        vmovdqu 0x1a0(%rsp), %ymm5
        vmovdqu %ymm2, 0x1f0(%rdi)
        vpunpcklqdq %ymm0, %ymm4, %ymm2 # ymm2 = ymm4[0],ymm0[0],ymm4[2],ymm0[2]
        vpunpckhqdq %ymm0, %ymm4, %ymm0 # ymm0 = ymm4[1],ymm0[1],ymm4[3],ymm0[3]
        vpunpcklqdq %ymm5, %ymm13, %ymm4 # ymm4 = ymm13[0],ymm5[0],ymm13[2],ymm5[2]
        vmovdqu %ymm6, 0x60(%rdi)
        vperm2i128 $0x20, %ymm4, %ymm2, %ymm6 # ymm6 = ymm2[0,1],ymm4[0,1]
        vmovdqu %ymm1, 0x2b8(%rdi)
        vperm2i128 $0x31, %ymm4, %ymm2, %ymm2 # ymm2 = ymm2[2,3],ymm4[2,3]
        vpunpckhqdq %ymm5, %ymm13, %ymm1 # ymm1 = ymm13[1],ymm5[1],ymm13[3],ymm5[3]
        vmovdqu %ymm6, 0x80(%rdi)
        vmovdqu 0x1e0(%rsp), %ymm4
        vperm2i128 $0x20, %ymm1, %ymm0, %ymm5 # ymm5 = ymm0[0,1],ymm1[0,1]
        vperm2i128 $0x31, %ymm1, %ymm0, %ymm0 # ymm0 = ymm0[2,3],ymm1[2,3]
        vmovdqu %ymm2, 0x210(%rdi)
        vpunpcklqdq %ymm3, %ymm12, %ymm2 # ymm2 = ymm12[0],ymm3[0],ymm12[2],ymm3[2]
        vmovdqu %ymm0, 0x2d8(%rdi)
        vpunpckhqdq %ymm3, %ymm12, %ymm0 # ymm0 = ymm12[1],ymm3[1],ymm12[3],ymm3[3]
        vpunpcklqdq %ymm4, %ymm7, %ymm3 # ymm3 = ymm7[0],ymm4[0],ymm7[2],ymm4[2]
        vpunpckhqdq %ymm4, %ymm7, %ymm1 # ymm1 = ymm7[1],ymm4[1],ymm7[3],ymm4[3]
        vmovdqu %ymm5, 0x148(%rdi)
        vperm2i128 $0x20, %ymm3, %ymm2, %ymm5 # ymm5 = ymm2[0,1],ymm3[0,1]
        vperm2i128 $0x31, %ymm3, %ymm2, %ymm2 # ymm2 = ymm2[2,3],ymm3[2,3]
        vmovdqu 0x1c0(%rsp), %ymm3
        vperm2i128 $0x20, %ymm1, %ymm0, %ymm4 # ymm4 = ymm0[0,1],ymm1[0,1]
        vperm2i128 $0x31, %ymm1, %ymm0, %ymm0 # ymm0 = ymm0[2,3],ymm1[2,3]
        vmovdqu %ymm5, 0xa0(%rdi)
        vextracti128 $0x1, %ymm3, %xmm15
        vmovdqu %ymm4, 0x168(%rdi)
        vmovdqu %ymm2, 0x230(%rdi)
        vmovdqu %ymm0, 0x2f8(%rdi)
        vmovq %xmm3, 0xc0(%rdi)
        vmovhpd %xmm3, 0x188(%rdi)
        vmovq %xmm15, 0x250(%rdi)
        vmovhpd %xmm15, 0x318(%rdi)
        movq %r11, %rsp
        .cfi_def_cfa_register %rsp
        retq
        .cfi_endproc

MLK_ASM_FN_SIZE(keccak_f1600_x4_avx2_asm)

#endif /* MLK_FIPS202_X86_64_NEED_X4_AVX2 && !MLK_CONFIG_MULTILEVEL_NO_SHARED */

#if defined(__ELF__)
.section .note.GNU-stack,"",%progbits
#endif
