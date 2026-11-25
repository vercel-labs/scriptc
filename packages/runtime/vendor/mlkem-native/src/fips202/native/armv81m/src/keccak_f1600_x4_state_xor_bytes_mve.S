/*
 * Copyright (c) The mlkem-native project authors
 * Copyright (c) The mldsa-native project authors
 * Copyright (c) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
// MVE/Helium implementation of KeccakF1600x4_StateXORBytes.
//
// void KeccakF1600x4_StateXORBytes(state, d0, d1, d2, d3, offset, length)
//
// Reads 'length' plain bytes from each of four input buffers (d0..d3),
// splits every byte into its even and odd bits (bit-interleaving), and
// XORs the result into the Keccak state starting at byte 'offset'.
//
// ---------------------------------------------------------------------------
// Bit-interleaving background
// ---------------------------------------------------------------------------
// Each 64-bit Keccak lane is stored as two 32-bit words:
//   even half -- bits 0, 2, 4, ..., 62 of the lane
//   odd half  -- bits 1, 3, 5, ..., 63 of the lane
// This representation allows 64-bit lane rotations (used in the Keccak
// round function) to be implemented as pairs of 32-bit rotations.
//
// Batched (x4) processing:
//   Four Keccak instances are processed as a batch.  Their states are
//   stored interleaved in a single 800-byte buffer: first the even
//   halves of all 25 lanes (400 bytes), then the odd halves (400 bytes).
//   Within each 16-byte row, the four u32 words correspond to
//   instances 0..3 of the same lane, enabling SIMD-parallel operations
//   across all four instances.
//
// State memory layout (25 lanes x 4 instances x 2 halves):
//   S[i][l]_even/odd = even/odd half of lane l, instance i  (u32)
//   Each row is 16 bytes (one Q-register).
//   Offset  Contents
//     0     S[0][ 0]_even, S[1][ 0]_even, S[2][ 0]_even, S[3][ 0]_even
//    16     S[0][ 1]_even, S[1][ 1]_even, S[2][ 1]_even, S[3][ 1]_even
//    ...
//   384     S[0][24]_even, S[1][24]_even, S[2][24]_even, S[3][24]_even
//   400     S[0][ 0]_odd,  S[1][ 0]_odd,  S[2][ 0]_odd,  S[3][ 0]_odd
//   416     S[0][ 1]_odd,  S[1][ 1]_odd,  S[2][ 1]_odd,  S[3][ 1]_odd
//    ...
//   784     S[0][24]_odd,  S[1][24]_odd,  S[2][24]_odd,  S[3][24]_odd
//
// ---------------------------------------------------------------------------
// Three-phase structure
// ---------------------------------------------------------------------------
//   Prologue -- if offset is not 8-byte aligned, absorb
//               min(length, 8-(offset%8)) bytes via predicated byte loads.
//   Main     -- process full 8-byte groups via word-level gather loads,
//               bit-interleave, then VEOR into even/odd state halves.
//   Tail     -- absorb remaining <8 bytes via predicated byte loads.

#include "../../../../common.h"
#if defined(MLK_FIPS202_ARMV81M_NEED_X4) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED)

/*
 * WARNING: This file is auto-derived from the mlkem-native source file
 *   dev/fips202/armv81m/src/keccak_f1600_x4_state_xor_bytes_mve.S using scripts/simpasm. Do not modify it directly.
 */

.thumb
.syntax unified

.text
.balign 4
.global MLK_ASM_NAMESPACE(keccak_f1600_x4_state_xor_bytes_asm)
MLK_ASM_FN_SYMBOL(keccak_f1600_x4_state_xor_bytes_asm)

        .cfi_startproc
        push.w {r4, r5, r6, r7, r8, r9, r10, r11, r12, lr}
        .cfi_adjust_cfa_offset 0x28
        .cfi_rel_offset r4, 0x0
        .cfi_rel_offset r5, 0x4
        .cfi_rel_offset r6, 0x8
        .cfi_rel_offset r7, 0xc
        .cfi_rel_offset r8, 0x10
        .cfi_rel_offset r9, 0x14
        .cfi_rel_offset r10, 0x18
        .cfi_rel_offset r11, 0x1c
        .cfi_rel_offset lr, 0x24
        vpush {d8, d9, d10, d11, d12, d13, d14, d15}
        .cfi_adjust_cfa_offset 0x40
        .cfi_rel_offset d8, 0x0
        .cfi_rel_offset d9, 0x8
        .cfi_rel_offset d10, 0x10
        .cfi_rel_offset d11, 0x18
        .cfi_rel_offset d12, 0x20
        .cfi_rel_offset d13, 0x28
        .cfi_rel_offset d14, 0x30
        .cfi_rel_offset d15, 0x38
        ldr r4, [sp, #0x68]
        ldr.w r10, [sp, #0x6c]
        ldr r6, [sp, #0x70]
        cmp r6, #0x0
        beq.w Lmlk_keccak_f1600_x4_state_xor_bytes_asm_exit @ imm = #0x346
        and r5, r10, #0x7
        bic r9, r10, #0x7
        add.w r8, r0, r9, lsl #1
        add.w r7, r8, #0x190
        cmp r5, #0x0
        beq.w Lmlk_keccak_f1600_x4_state_xor_bytes_asm_pre_main @ imm = #0x12c
        subs r1, r1, r5
        subs r2, r2, r5
        subs r3, r3, r5
        subs r4, r4, r5
        rsb.w lr, r5, #0x8
        cmp r6, lr
        it ls
        movls lr, r6
        subs.w r6, r6, lr
        vctp.8 lr
        vmrs r11, p0
        lsl.w r11, r11, r5
        vmsr p0, r11
        vpstttt
        vldrbt.u8 q0, [r1], #4
        vldrbt.u8 q1, [r2], #4
        vldrbt.u8 q2, [r3], #4
        vldrbt.u8 q3, [r4], #4
        vmov.f64 d1, d4
        vmov.f64 d3, d6
        vrev64.32 q2, q0
        vrev64.32 q3, q1
        movw r0, #0xf0f
        vmsr p0, r0
        vpsel q0, q0, q3
        vpsel q1, q2, q1
        vmov q2, q0
        vmov q3, q1
        vshr.u8 q4, q0, #0x2
        vsli.8 q0, q4, #0x1
        vshr.u8 q4, q0, #0x3
        vsli.8 q0, q4, #0x2
        vshr.u8 q4, q0, #0x4
        vsli.8 q0, q4, #0x3
        vshr.u16 q4, q0, #0x8
        vsli.8 q0, q4, #0x4
        vshr.u32 q4, q0, #0x10
        vsli.16 q0, q4, #0x8
        vshr.u8 q4, q3, #0x2
        vsli.8 q3, q4, #0x1
        vshr.u8 q4, q3, #0x3
        vsli.8 q3, q4, #0x2
        vshr.u8 q4, q3, #0x4
        vsli.8 q3, q4, #0x3
        vshr.u16 q4, q3, #0x8
        vsli.8 q3, q4, #0x4
        vshr.u32 q4, q3, #0x10
        vsli.16 q3, q4, #0x8
        vsli.32 q0, q3, #0x10
        vshl.i8 q4, q2, #0x2
        vsri.8 q2, q4, #0x1
        vshl.i8 q4, q2, #0x3
        vsri.8 q2, q4, #0x2
        vshl.i8 q4, q2, #0x4
        vsri.8 q2, q4, #0x3
        vshl.i16 q4, q2, #0x8
        vsri.8 q2, q4, #0x4
        vshl.i32 q4, q2, #0x10
        vsri.16 q2, q4, #0x8
        vshl.i8 q4, q1, #0x2
        vsri.8 q1, q4, #0x1
        vshl.i8 q4, q1, #0x3
        vsri.8 q1, q4, #0x2
        vshl.i8 q4, q1, #0x4
        vsri.8 q1, q4, #0x3
        vshl.i16 q4, q1, #0x8
        vsri.8 q1, q4, #0x4
        vshl.i32 q4, q1, #0x10
        vsri.16 q1, q4, #0x8
        vsri.32 q1, q2, #0x10
        vldrw.u32 q4, [r8]
        vldrw.u32 q5, [r7]
        veor q4, q4, q0
        veor q5, q5, q1
        vstrw.32 q4, [r8], #16
        vstrw.32 q5, [r7], #16
        vmov q7[2], q7[0], r1, r3
        vmov q7[3], q7[1], r2, r4
        b Lmlk_keccak_f1600_x4_state_xor_bytes_asm_main_body @ imm = #0xe

Lmlk_keccak_f1600_x4_state_xor_bytes_asm_pre_main:
        vmov q7[2], q7[0], r1, r3
        vmov q7[3], q7[1], r2, r4
        mov.w r0, #0x4
        vsub.i32 q7, q7, r0

Lmlk_keccak_f1600_x4_state_xor_bytes_asm_main_body:
        lsr.w lr, r6, #0x3
        wls lr, lr, Lmlk_keccak_f1600_x4_state_xor_bytes_asm_main_loop_end @ imm = #0xd4

Lmlk_keccak_f1600_x4_state_xor_bytes_asm_main_loop_start:
        vldrw.u32 q0, [q7, #4]!
        vldrw.u32 q1, [q7, #4]!
        vmov q2, q0
        vmov q3, q1
        vshr.u8 q4, q0, #0x2
        vsli.8 q0, q4, #0x1
        vshr.u8 q4, q0, #0x3
        vsli.8 q0, q4, #0x2
        vshr.u8 q4, q0, #0x4
        vsli.8 q0, q4, #0x3
        vshr.u16 q4, q0, #0x8
        vsli.8 q0, q4, #0x4
        vshr.u32 q4, q0, #0x10
        vsli.16 q0, q4, #0x8
        vshr.u8 q4, q3, #0x2
        vsli.8 q3, q4, #0x1
        vshr.u8 q4, q3, #0x3
        vsli.8 q3, q4, #0x2
        vshr.u8 q4, q3, #0x4
        vsli.8 q3, q4, #0x3
        vshr.u16 q4, q3, #0x8
        vsli.8 q3, q4, #0x4
        vshr.u32 q4, q3, #0x10
        vsli.16 q3, q4, #0x8
        vsli.32 q0, q3, #0x10
        vshl.i8 q4, q2, #0x2
        vsri.8 q2, q4, #0x1
        vshl.i8 q4, q2, #0x3
        vsri.8 q2, q4, #0x2
        vshl.i8 q4, q2, #0x4
        vsri.8 q2, q4, #0x3
        vshl.i16 q4, q2, #0x8
        vsri.8 q2, q4, #0x4
        vshl.i32 q4, q2, #0x10
        vsri.16 q2, q4, #0x8
        vshl.i8 q4, q1, #0x2
        vsri.8 q1, q4, #0x1
        vshl.i8 q4, q1, #0x3
        vsri.8 q1, q4, #0x2
        vshl.i8 q4, q1, #0x4
        vsri.8 q1, q4, #0x3
        vshl.i16 q4, q1, #0x8
        vsri.8 q1, q4, #0x4
        vshl.i32 q4, q1, #0x10
        vsri.16 q1, q4, #0x8
        vsri.32 q1, q2, #0x10
        vldrw.u32 q4, [r8]
        vldrw.u32 q5, [r7]
        veor q4, q4, q0
        veor q5, q5, q1
        vstrw.32 q4, [r8], #16
        vstrw.32 q5, [r7], #16
        le lr, Lmlk_keccak_f1600_x4_state_xor_bytes_asm_main_loop_start @ imm = #-0xd4

Lmlk_keccak_f1600_x4_state_xor_bytes_asm_main_loop_end:
        ands r6, r6, #0x7
        beq.w Lmlk_keccak_f1600_x4_state_xor_bytes_asm_exit @ imm = #0x110
        mov.w r0, #0x4
        vadd.i32 q7, q7, r0
        vmov r1, r3, q7[2], q7[0]
        vmov r2, r4, q7[3], q7[1]
        vctp.8 r6
        vpstttt
        vldrbt.u8 q0, [r1]
        vldrbt.u8 q1, [r2]
        vldrbt.u8 q2, [r3]
        vldrbt.u8 q3, [r4]
        vmov.f64 d1, d4
        vmov.f64 d3, d6
        vrev64.32 q2, q0
        vrev64.32 q3, q1
        movw r0, #0xf0f
        vmsr p0, r0
        vpsel q0, q0, q3
        vpsel q1, q2, q1
        vmov q2, q0
        vmov q3, q1
        vshr.u8 q4, q0, #0x2
        vsli.8 q0, q4, #0x1
        vshr.u8 q4, q0, #0x3
        vsli.8 q0, q4, #0x2
        vshr.u8 q4, q0, #0x4
        vsli.8 q0, q4, #0x3
        vshr.u16 q4, q0, #0x8
        vsli.8 q0, q4, #0x4
        vshr.u32 q4, q0, #0x10
        vsli.16 q0, q4, #0x8
        vshr.u8 q4, q3, #0x2
        vsli.8 q3, q4, #0x1
        vshr.u8 q4, q3, #0x3
        vsli.8 q3, q4, #0x2
        vshr.u8 q4, q3, #0x4
        vsli.8 q3, q4, #0x3
        vshr.u16 q4, q3, #0x8
        vsli.8 q3, q4, #0x4
        vshr.u32 q4, q3, #0x10
        vsli.16 q3, q4, #0x8
        vsli.32 q0, q3, #0x10
        vshl.i8 q4, q2, #0x2
        vsri.8 q2, q4, #0x1
        vshl.i8 q4, q2, #0x3
        vsri.8 q2, q4, #0x2
        vshl.i8 q4, q2, #0x4
        vsri.8 q2, q4, #0x3
        vshl.i16 q4, q2, #0x8
        vsri.8 q2, q4, #0x4
        vshl.i32 q4, q2, #0x10
        vsri.16 q2, q4, #0x8
        vshl.i8 q4, q1, #0x2
        vsri.8 q1, q4, #0x1
        vshl.i8 q4, q1, #0x3
        vsri.8 q1, q4, #0x2
        vshl.i8 q4, q1, #0x4
        vsri.8 q1, q4, #0x3
        vshl.i16 q4, q1, #0x8
        vsri.8 q1, q4, #0x4
        vshl.i32 q4, q1, #0x10
        vsri.16 q1, q4, #0x8
        vsri.32 q1, q2, #0x10
        vldrw.u32 q4, [r8]
        vldrw.u32 q5, [r7]
        veor q4, q4, q0
        veor q5, q5, q1
        vstrw.32 q4, [r8], #16
        vstrw.32 q5, [r7], #16

Lmlk_keccak_f1600_x4_state_xor_bytes_asm_exit:
        vpop {d8, d9, d10, d11, d12, d13, d14, d15}
        .cfi_restore d8
        .cfi_restore d9
        .cfi_restore d10
        .cfi_restore d11
        .cfi_restore d12
        .cfi_restore d13
        .cfi_restore d14
        .cfi_restore d15
        .cfi_adjust_cfa_offset -0x40
        pop.w {r4, r5, r6, r7, r8, r9, r10, r11, r12, pc}
        .cfi_restore r4
        .cfi_restore r5
        .cfi_restore r6
        .cfi_restore r7
        .cfi_restore r8
        .cfi_restore r9
        .cfi_restore r10
        .cfi_restore r11
        .cfi_restore lr
        .cfi_adjust_cfa_offset -0x28
        .cfi_endproc

MLK_ASM_FN_SIZE(keccak_f1600_x4_state_xor_bytes_asm)

#endif /* MLK_FIPS202_ARMV81M_NEED_X4 && !MLK_CONFIG_MULTILEVEL_NO_SHARED */

#if defined(__ELF__)
.section .note.GNU-stack,"",%progbits
#endif
