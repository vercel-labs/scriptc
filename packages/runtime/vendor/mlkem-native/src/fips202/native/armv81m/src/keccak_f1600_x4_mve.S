/*
 * Copyright (c) The mlkem-native project authors
 * Copyright (c) 2025 Arm Limited
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

/*yaml
  Name: keccak_f1600_x4_mve_asm
  Description: Armv8.1-M MVE implementation of batched (x4) Keccak-f[1600] permutation using bit-interleaved state
  Signature: void mlk_keccak_f1600_x4_mve_asm(void *state, void *tmpstate, const uint32_t *rc)
  ABI:
    Architecture: armv81m
    CallingConvention: AAPCS32
    Features: [MVE]
    r0:
      type: buffer
      size_bytes: 800
      permissions: read/write
      c_parameter: void *state
      description: Bit-interleaved state for 4 Keccak instances (even halves followed by odd halves)
    r1:
      type: buffer
      size_bytes: 800
      permissions: read/write
      c_parameter: void *tmpstate
      description: Temporary storage for intermediate state
    r2:
      type: buffer
      size_bytes: 192
      permissions: read
      c_parameter: const uint32_t *rc
      description: Keccak round constants in bit-interleaved form (24 pairs of 32-bit words)
  Stack:
    bytes: 228
    description: register preservation (36) + SIMD registers (64) + temporary storage (128)
*/

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

#include "../../../../common.h"
#if defined(MLK_FIPS202_ARMV81M_NEED_X4) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED)

/*
 * WARNING: This file is auto-derived from the mlkem-native source file
 *   dev/fips202/armv81m/src/keccak_f1600_x4_mve.S using scripts/simpasm. Do not modify it directly.
 */

.thumb
.syntax unified

.text
.balign 4
.global MLK_ASM_NAMESPACE(keccak_f1600_x4_mve_asm)
MLK_ASM_FN_SYMBOL(keccak_f1600_x4_mve_asm)

        .cfi_startproc
        push.w {r4, r5, r6, r7, r8, r9, r10, r11, lr}
        .cfi_adjust_cfa_offset 0x24
        .cfi_rel_offset r4, 0x0
        .cfi_rel_offset r5, 0x4
        .cfi_rel_offset r6, 0x8
        .cfi_rel_offset r7, 0xc
        .cfi_rel_offset r8, 0x10
        .cfi_rel_offset r9, 0x14
        .cfi_rel_offset r10, 0x18
        .cfi_rel_offset r11, 0x1c
        .cfi_rel_offset lr, 0x20
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
        sub sp, #0x80
        .cfi_adjust_cfa_offset 0x80
        mov r6, r2
        mov.w lr, #0x18
        mov r2, r0
        mov r4, r1
        add.w r3, r2, #0x190
        vldrw.u32 q0, [r3]
        vldrw.u32 q1, [r2]
        vldrw.u32 q2, [r2, #32]
        wls lr, lr, Lmlk_keccak_f1600_x4_mve_asm_roundend @ imm = #0x8c0

Lmlk_keccak_f1600_x4_mve_asm_roundstart:
        vldrw.u32 q6, [r2, #112]
        veor q7, q6, q2
        vldrw.u32 q2, [r2, #80]
        veor q1, q2, q1
        add.w r5, r2, #0x190
        vldrw.u32 q5, [r5, #80]
        veor q4, q5, q0
        vldrw.u32 q0, [r2, #192]
        veor q3, q7, q0
        vldrw.u32 q0, [r2, #160]
        veor q1, q1, q0
        vldrw.u32 q0, [r5, #160]
        veor q0, q4, q0
        vldrw.u32 q6, [r2, #272]
        veor q2, q3, q6
        vldrw.u32 q7, [r2, #240]
        veor q5, q1, q7
        vldrw.u32 q4, [r5, #240]
        veor q4, q0, q4
        vldrw.u32 q6, [r2, #352]
        veor q3, q2, q6
        vldrw.u32 q0, [r2, #320]
        veor q2, q5, q0
        vldrw.u32 q1, [r5, #320]
        veor q5, q4, q1
        vldrw.u32 q4, [r5, #32]
        veor q0, q3, q5
        vldrw.u32 q1, [r5, #16]
        veor q6, q1, q0
        vstrw.32 q5, [sp]
        vshr.u32 q7, q6, #0x1f
        add.w r10, r4, #0x190
        vsli.32 q7, q6, #0x1
        vldrw.u32 q6, [r5, #112]
        veor q6, q4, q6
        vldrw.u32 q4, [r5, #192]
        veor q4, q6, q4
        vldrw.u32 q6, [r5, #272]
        veor q4, q4, q6
        vldrw.u32 q6, [r5, #352]
        veor q5, q4, q6
        vstrw.32 q7, [r4, #160]
        vshr.u32 q4, q5, #0x1f
        vsli.32 q4, q5, #0x1
        vldrw.u32 q6, [r2, #16]
        veor q7, q4, q2
        veor q1, q6, q7
        vldrw.u32 q6, [r5, #96]
        veor q6, q6, q0
        vstrw.32 q1, [r10, #160]
        vshr.u32 q1, q6, #0xa
        vsli.32 q1, q6, #0x16
        vldrw.u32 q6, [r2, #96]
        veor q4, q6, q7
        vstrw.32 q1, [r10, #16]
        vshr.u32 q6, q4, #0xa
        vsli.32 q6, q4, #0x16
        vldrw.u32 q1, [r5, #336]
        veor q4, q1, q0
        vldrw.u32 q1, [r2, #176]
        veor q1, q1, q7
        vstrw.32 q6, [r4, #16]
        vshr.u32 q6, q1, #0x1b
        vsli.32 q6, q1, #0x5
        vldrw.u32 q1, [r2, #256]
        veor q1, q1, q7
        vstrw.32 q6, [r4, #272]
        vshr.u32 q6, q1, #0xa
        vsli.32 q6, q1, #0x16
        vldrw.u32 q1, [r2, #336]
        veor q1, q1, q7
        vstrw.32 q6, [r10, #128]
        vshr.u32 q6, q1, #0x1f
        vsli.32 q6, q1, #0x1
        vldrw.u32 q7, [r5, #176]
        veor q7, q7, q0
        vstrw.32 q6, [r4, #384]
        vshr.u32 q1, q7, #0x1b
        vsli.32 q1, q7, #0x5
        vldrw.u32 q6, [r5, #256]
        veor q0, q6, q0
        vstrw.32 q1, [r10, #272]
        vshr.u32 q1, q4, #0x1f
        vldrw.u32 q7, [r5, #64]
        vsli.32 q1, q4, #0x1
        vldrw.u32 q4, [r5, #144]
        vshr.u32 q6, q0, #0x9
        vstrw.32 q1, [r10, #384]
        vsli.32 q6, q0, #0x17
        veor q7, q7, q4
        vldrw.u32 q1, [r5, #224]
        veor q4, q7, q1
        vldrw.u32 q7, [r5, #304]
        veor q1, q4, q7
        vldrw.u32 q0, [r5, #384]
        veor q7, q1, q0
        vstrw.32 q6, [r4, #128]
        vshr.u32 q1, q7, #0x1f
        vsli.32 q1, q7, #0x1
        vldrw.u32 q6, [r2, #144]
        veor q0, q1, q3
        vldrw.u32 q3, [r2, #64]
        veor q1, q3, q6
        vldrw.u32 q6, [r2, #224]
        veor q1, q1, q6
        vldrw.u32 q3, [r2, #304]
        veor q6, q1, q3
        vldrw.u32 q4, [r2, #384]
        veor q3, q6, q4
        vldrw.u32 q4, [r2, #48]
        veor q5, q3, q5
        vldrw.u32 q1, [r5, #48]
        veor q1, q1, q5
        vshr.u32 q6, q1, #0x12
        vsli.32 q6, q1, #0xe
        vldrw.u32 q1, [r2, #128]
        veor q1, q1, q0
        vstrw.32 q6, [r10, #80]
        vshr.u32 q6, q1, #0x5
        vsli.32 q6, q1, #0x1b
        vldrw.u32 q1, [r5, #128]
        veor q1, q1, q5
        vstrw.32 q6, [r10, #336]
        vshr.u32 q6, q1, #0x4
        vsli.32 q6, q1, #0x1c
        veor q1, q4, q0
        vstrw.32 q6, [r4, #336]
        vshr.u32 q4, q1, #0x12
        vsli.32 q4, q1, #0xe
        vldrw.u32 q6, [r2, #208]
        veor q6, q6, q0
        vstrw.32 q4, [r4, #80]
        vshr.u32 q1, q6, #0x14
        vsli.32 q1, q6, #0xc
        vldrw.u32 q4, [r2, #288]
        veor q4, q4, q0
        vldrw.u32 q6, [r2, #368]
        veor q0, q6, q0
        vshr.u32 q6, q0, #0x4
        vstrw.32 q1, [r10, #192]
        vsli.32 q6, q0, #0x1c
        vshr.u32 q0, q4, #0x16
        vldrw.u32 q1, [r5, #368]
        vsli.32 q0, q4, #0xa
        vstrw.32 q6, [r4, #304]
        veor q4, q1, q5
        vstrw.32 q0, [r10, #48]
        vshr.u32 q1, q4, #0x4
        vsli.32 q1, q4, #0x1c
        vldrw.u32 q6, [r5, #208]
        veor q6, q6, q5
        vldrw.u32 q0, [r5, #288]
        veor q5, q0, q5
        vstrw.32 q1, [r10, #304]
        vshr.u32 q0, q6, #0x13
        vsli.32 q0, q6, #0xd
        vldrw.u32 q1, [r5, #96]
        vshr.u32 q6, q5, #0x15
        vldrw.u32 q4, [r5, #16]
        vsli.32 q6, q5, #0xb
        vldrw.u32 q5, [r5, #176]
        veor q1, q4, q1
        vldrw.u32 q4, [r5, #256]
        veor q5, q1, q5
        vldrw.u32 q1, [r5, #336]
        veor q5, q5, q4
        vstrw.32 q0, [r4, #192]
        veor q0, q5, q1
        vstrw.32 q6, [r4, #48]
        vshr.u32 q5, q0, #0x1f
        vsli.32 q5, q0, #0x1
        vldrw.u32 q4, [r2, #16]
        veor q3, q5, q3
        vldrw.u32 q6, [r2, #96]
        veor q4, q4, q6
        vldrw.u32 q1, [r2, #176]
        veor q5, q4, q1
        vldrw.u32 q6, [r2, #256]
        veor q6, q5, q6
        vldrw.u32 q4, [r2, #336]
        veor q5, q6, q4
        vldrw.u32 q1, [r5]
        veor q7, q5, q7
        vldrw.u32 q4, [r2]
        veor q1, q1, q7
        veor q4, q4, q3
        vshr.u32 q6, q1, #0x20
        vsli.32 q6, q1, #0x0
        vldrw.u32 q1, [r2, #80]
        veor q1, q1, q3
        vstrw.32 q6, [r10]
        vshr.u32 q6, q4, #0x20
        vsli.32 q6, q4, #0x0
        vldrw.u32 q4, [r5, #80]
        veor q4, q4, q7
        vstrw.32 q6, [r4]
        vshr.u32 q6, q1, #0xe
        vsli.32 q6, q1, #0x12
        vldrw.u32 q1, [r2, #160]
        veor q1, q1, q3
        vstrw.32 q6, [r4, #256]
        vshr.u32 q6, q4, #0xe
        vsli.32 q6, q4, #0x12
        vldrw.u32 q4, [r2, #240]
        veor q4, q4, q3
        vstrw.32 q6, [r10, #256]
        vshr.u32 q6, q1, #0x1f
        vsli.32 q6, q1, #0x1
        vldrw.u32 q1, [r2, #320]
        veor q1, q1, q3
        vstrw.32 q6, [r10, #112]
        vshr.u32 q6, q4, #0xc
        vsli.32 q6, q4, #0x14
        vldrw.u32 q3, [r5, #240]
        veor q3, q3, q7
        vstrw.32 q6, [r10, #368]
        vshr.u32 q4, q3, #0xb
        vsli.32 q4, q3, #0x15
        vldrw.u32 q3, [r5, #160]
        veor q6, q3, q7
        vstrw.32 q4, [r4, #368]
        vshr.u32 q3, q6, #0x1e
        vsli.32 q3, q6, #0x2
        vldrw.u32 q6, [r5, #320]
        veor q7, q6, q7
        vldrw.u32 q4, [r2, #368]
        vshr.u32 q6, q1, #0x17
        vstrw.32 q3, [r4, #112]
        vsli.32 q6, q1, #0x9
        vshr.u32 q1, q7, #0x17
        vldrw.u32 q3, [r2, #48]
        vsli.32 q1, q7, #0x9
        vldrw.u32 q7, [r2, #128]
        veor q3, q3, q7
        vldrw.u32 q7, [r2, #208]
        veor q7, q3, q7
        vldrw.u32 q3, [r2, #288]
        veor q3, q7, q3
        vldrw.u32 q7, [r5, #128]
        veor q3, q3, q4
        vldrw.u32 q4, [r5, #48]
        veor q0, q3, q0
        veor q4, q4, q7
        vldrw.u32 q7, [r5, #208]
        veor q4, q4, q7
        vldrw.u32 q7, [r5, #288]
        veor q4, q4, q7
        vldrw.u32 q7, [r5, #368]
        veor q7, q4, q7
        vstrw.32 q6, [r4, #224]
        vshr.u32 q4, q7, #0x1f
        vstrw.32 q1, [r10, #224]
        vsli.32 q4, q7, #0x1
        veor q5, q4, q5
        vldrw.u32 q6, [r2, #192]
        veor q1, q6, q5
        vldrw.u32 q4, [r5, #112]
        veor q7, q2, q7
        vldrw.u32 q6, [r5, #32]
        vshr.u32 q2, q1, #0xb
        vsli.32 q2, q1, #0x15
        veor q1, q6, q0
        vstrw.32 q2, [r10, #32]
        vshr.u32 q6, q1, #0x1
        vsli.32 q6, q1, #0x1f
        vldrw.u32 q2, [r2, #112]
        veor q2, q2, q5
        vstrw.32 q6, [r10, #320]
        vshr.u32 q1, q2, #0x1d
        vsli.32 q1, q2, #0x3
        vldrw.u32 q6, [r2, #32]
        veor q4, q4, q0
        vstrw.32 q1, [r4, #176]
        veor q2, q6, q5
        vshr.u32 q6, q2, #0x1
        vldrw.u32 q1, [r5, #352]
        vsli.32 q6, q2, #0x1f
        veor q1, q1, q0
        vstrw.32 q6, [r4, #320]
        vshr.u32 q6, q1, #0x1
        vsli.32 q6, q1, #0x1f
        vldrw.u32 q2, [r5, #192]
        vshr.u32 q1, q4, #0x1d
        vstrw.32 q6, [r4, #144]
        vsli.32 q1, q4, #0x3
        veor q2, q2, q0
        vldrw.u32 q6, [r5, #272]
        veor q0, q6, q0
        vldrw.u32 q4, [r2, #352]
        veor q6, q4, q5
        vldrw.u32 q4, [r2, #272]
        veor q4, q4, q5
        vstrw.32 q1, [r10, #176]
        vshr.u32 q1, q2, #0xa
        vsli.32 q1, q2, #0x16
        vldrw.u32 q5, [sp]
        vshr.u32 q2, q0, #0x18
        vstrw.32 q1, [r4, #32]
        vsli.32 q2, q0, #0x8
        vshr.u32 q1, q6, #0x2
        vstrw.32 q2, [r4, #288]
        vsli.32 q1, q6, #0x1e
        vshr.u32 q6, q4, #0x19
        vstrw.32 q1, [r10, #144]
        vsli.32 q6, q4, #0x7
        vshr.u32 q0, q5, #0x1f
        vstrw.32 q6, [r10, #288]
        vsli.32 q0, q5, #0x1
        veor q5, q0, q3
        vldrw.u32 q6, [r2, #64]
        veor q3, q6, q5
        vldrw.u32 q1, [r5, #64]
        vshr.u32 q4, q3, #0x13
        vldrw.u32 q2, [r2, #384]
        vsli.32 q4, q3, #0xd
        vldrw.u32 q0, [r5, #224]
        veor q6, q1, q7
        vstrw.32 q4, [r10, #240]
        veor q2, q2, q5
        veor q3, q0, q7
        vldrw.u32 q0, [r2, #224]
        vshr.u32 q4, q6, #0x12
        vldrw.u32 q1, [r5, #384]
        vsli.32 q4, q6, #0xe
        vshr.u32 q6, q2, #0x19
        vstrw.32 q4, [r4, #240]
        vsli.32 q6, q2, #0x7
        vshr.u32 q2, q3, #0xc
        vstrw.32 q6, [r4, #64]
        vsli.32 q2, q3, #0x14
        veor q0, q0, q5
        vldrw.u32 q6, [r2, #144]
        veor q4, q1, q7
        veor q6, q6, q5
        vstrw.32 q2, [r4, #352]
        vshr.u32 q2, q4, #0x19
        vsli.32 q2, q4, #0x7
        vldrw.u32 q1, [r2, #304]
        veor q5, q1, q5
        vldrw.u32 q1, [r5, #144]
        veor q4, q1, q7
        vldrw.u32 q3, [r5, #304]
        veor q1, q3, q7
        vstrw.32 q2, [r10, #64]
        vshr.u32 q3, q0, #0xd
        vsli.32 q3, q0, #0x13
        vldrw.u32 q7, [r4, #80]
        vshr.u32 q0, q6, #0x16
        vstrw.32 q3, [r10, #352]
        vsli.32 q0, q6, #0xa
        vshr.u32 q2, q5, #0x1c
        vsli.32 q2, q5, #0x4
        vldrw.u32 q5, [r4, #112]
        vshr.u32 q3, q1, #0x1c
        vsli.32 q3, q1, #0x4
        vldrw.u32 q1, [r4, #128]
        vbic q6, q5, q0
        vstrw.32 q3, [r10, #208]
        vbic q3, q1, q5
        veor q3, q0, q3
        vstrw.32 q3, [r2, #96]
        vbic q3, q0, q7
        veor q0, q7, q6
        vldrw.u32 q6, [r4, #144]
        vbic q7, q7, q6
        vstrw.32 q0, [r2, #80]
        veor q3, q6, q3
        vstrw.32 q3, [r2, #144]
        veor q0, q1, q7
        vstrw.32 q0, [r2, #128]
        vbic q1, q6, q1
        vshr.u32 q6, q4, #0x16
        vldrw.u32 q3, [r10, #112]
        vsli.32 q6, q4, #0xa
        vldrw.u32 q4, [r10, #80]
        veor q1, q5, q1
        vldrw.u32 q0, [r10, #144]
        vbic q7, q4, q0
        vldrw.u32 q5, [r10, #128]
        veor q7, q5, q7
        vstrw.32 q1, [r2, #112]
        vbic q1, q0, q5
        vstrw.32 q7, [r5, #128]
        veor q7, q3, q1
        vstrw.32 q7, [r5, #112]
        vbic q7, q5, q3
        vbic q1, q3, q6
        vldrw.u32 q3, [r4, #176]
        veor q5, q4, q1
        vbic q4, q6, q4
        vldrw.u32 q1, [r4, #160]
        veor q0, q0, q4
        vldrw.u32 q4, [r4, #224]
        veor q7, q6, q7
        vstrw.32 q0, [r5, #144]
        vbic q0, q1, q4
        vstrw.32 q7, [r5, #96]
        veor q0, q2, q0
        vstrw.32 q0, [r2, #208]
        vbic q6, q3, q1
        vstrw.32 q5, [r5, #80]
        vbic q7, q4, q2
        vldrw.u32 q0, [r10, #160]
        veor q6, q4, q6
        vldrw.u32 q5, [r4, #192]
        vbic q4, q2, q5
        vldrw.u32 q2, [r10, #224]
        veor q4, q3, q4
        vstrw.32 q4, [r2, #176]
        vbic q4, q5, q3
        vstrw.32 q6, [r2, #224]
        veor q4, q1, q4
        vldrw.u32 q1, [r10, #208]
        veor q3, q5, q7
        vldrw.u32 q5, [r10, #192]
        vbic q6, q1, q5
        vldrw.u32 q7, [r10, #176]
        veor q6, q7, q6
        vstrw.32 q3, [r2, #192]
        vbic q3, q0, q2
        vstrw.32 q6, [r5, #176]
        veor q3, q1, q3
        vstrw.32 q3, [r5, #208]
        vbic q3, q5, q7
        vstrw.32 q4, [r2, #160]
        veor q3, q0, q3
        vstrw.32 q3, [r5, #160]
        vbic q6, q2, q1
        vldrw.u32 q1, [r4, #288]
        vbic q7, q7, q0
        vldrw.u32 q3, [r4, #272]
        veor q0, q5, q6
        vldrw.u32 q4, [r4, #304]
        veor q6, q2, q7
        vldrw.u32 q7, [r4, #256]
        vbic q5, q4, q1
        vstrw.32 q0, [r5, #192]
        veor q5, q3, q5
        vstrw.32 q6, [r5, #224]
        vbic q0, q3, q7
        vstrw.32 q5, [r2, #272]
        vbic q6, q1, q3
        veor q5, q7, q6
        vldrw.u32 q3, [r4, #240]
        veor q6, q3, q0
        vldrw.u32 q2, [r10, #288]
        vbic q0, q3, q4
        vstrw.32 q6, [r2, #240]
        vbic q7, q7, q3
        vstrw.32 q5, [r2, #256]
        veor q7, q4, q7
        vstrw.32 q7, [r2, #304]
        veor q7, q1, q0
        vstrw.32 q7, [r2, #288]
        vldrw.u32 q5, [r10, #304]
        vbic q7, q5, q2
        vldrw.u32 q3, [r10, #272]
        veor q1, q3, q7
        vldrw.u32 q7, [r4, #336]
        vbic q4, q2, q3
        vldrw.u32 q6, [r10, #256]
        vbic q3, q3, q6
        vldrw.u32 q0, [r10, #240]
        veor q3, q0, q3
        vstrw.32 q1, [r5, #272]
        vbic q1, q0, q5
        vstrw.32 q3, [r5, #240]
        veor q1, q2, q1
        vldrw.u32 q3, [r4, #384]
        vbic q2, q6, q0
        vldrw.u32 q0, [r4, #320]
        veor q2, q5, q2
        vldrw.u32 q5, [r4, #352]
        veor q4, q6, q4
        vstrw.32 q2, [r5, #304]
        vbic q2, q7, q0
        vstrw.32 q1, [r5, #288]
        veor q1, q3, q2
        vstrw.32 q1, [r2, #384]
        vbic q2, q5, q7
        vstrw.32 q4, [r5, #256]
        veor q4, q0, q2
        vstrw.32 q4, [r2, #320]
        vbic q2, q0, q3
        vldrw.u32 q4, [r4, #368]
        vbic q3, q3, q4
        vldrw.u32 q0, [r10, #320]
        veor q1, q5, q3
        vldrw.u32 q6, [r10, #336]
        vbic q5, q4, q5
        vstrw.32 q1, [r2, #352]
        veor q5, q7, q5
        vstrw.32 q5, [r2, #336]
        veor q3, q4, q2
        vstrw.32 q3, [r2, #368]
        vbic q7, q6, q0
        vldrw.u32 q5, [r10, #352]
        vbic q3, q5, q6
        vldrw.u32 q1, [r10, #368]
        vbic q4, q1, q5
        vldrw.u32 q2, [r4, #16]
        veor q6, q6, q4
        vldrw.u32 q4, [r10, #384]
        veor q3, q0, q3
        vstrw.32 q3, [r5, #320]
        veor q3, q4, q7
        vstrw.32 q3, [r5, #384]
        vbic q0, q0, q4
        vstrw.32 q6, [r5, #336]
        veor q3, q1, q0
        vstrw.32 q3, [r5, #368]
        vbic q7, q4, q1
        veor q5, q5, q7
        vldrw.u32 q6, [r4, #32]
        vbic q3, q6, q2
        vldrw.u32 q4, [r4, #48]
        vbic q0, q4, q6
        vldrw.u32 q1, [r4]
        veor q0, q2, q0
        vldrw.u32 q7, [r4, #64]
        veor q3, q1, q3
        vstrw.32 q5, [r5, #352]
        vbic q5, q1, q7
        vstrw.32 q0, [r2, #16]
        veor q0, q4, q5
        vstrw.32 q0, [r2, #48]
        vbic q5, q2, q1
        veor q2, q7, q5
        vldrw.u32 q0, [r10, #16]
        vbic q5, q7, q4
        vldrw.u32 q4, [r10]
        vbic q1, q0, q4
        vldrw.u32 q7, [r10, #64]
        veor q1, q7, q1
        vstrw.32 q2, [r2, #64]
        veor q2, q6, q5
        vbic q6, q4, q7
        vldrw.u32 q5, [r10, #48]
        veor q6, q5, q6
        ldrd r7, r8, [r6]
        vbic q7, q7, q5
        vstrw.32 q1, [r5, #64]
        vdup.32 q1, r7
        veor q1, q3, q1
        vldrw.u32 q3, [r10, #32]
        veor q7, q3, q7
        add.w r6, r6, #0x8
        vbic q5, q5, q3
        vstrw.32 q6, [r5, #48]
        vbic q6, q3, q0
        vstrw.32 q1, [r2]
        veor q5, q0, q5
        vstrw.32 q7, [r5, #32]
        veor q4, q4, q6
        vstrw.32 q5, [r5, #16]
        vdup.32 q6, r8
        vstrw.32 q2, [r2, #32]
        veor q0, q4, q6
        vstrw.32 q0, [r5]

Lmlk_keccak_f1600_x4_mve_asm_roundend_pre:
        le lr, Lmlk_keccak_f1600_x4_mve_asm_roundstart @ imm = #-0x8c0

Lmlk_keccak_f1600_x4_mve_asm_roundend:
        add sp, #0x80
        .cfi_adjust_cfa_offset -0x80
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
        pop.w {r4, r5, r6, r7, r8, r9, r10, r11, pc}
        .cfi_restore r4
        .cfi_restore r5
        .cfi_restore r6
        .cfi_restore r7
        .cfi_restore r8
        .cfi_restore r9
        .cfi_restore r10
        .cfi_restore r11
        .cfi_restore lr
        .cfi_adjust_cfa_offset -0x24
        .cfi_endproc
        nop

MLK_ASM_FN_SIZE(keccak_f1600_x4_mve_asm)

#endif /* MLK_FIPS202_ARMV81M_NEED_X4 && !MLK_CONFIG_MULTILEVEL_NO_SHARED */

#if defined(__ELF__)
.section .note.GNU-stack,"",%progbits
#endif
