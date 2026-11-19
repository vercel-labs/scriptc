/*
 * Copyright (c) The mlkem-native project authors
 * Copyright (c) IBM Corp. 2025, 2026
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 *
 * Written by Danny Tsen <dtsen@us.ibm.com>
 */

#include "../../../common.h"
#if defined(MLK_ARITH_BACKEND_PPC64LE_DEFAULT) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED) && defined(__POWER8_VECTOR__)
/*yaml
  Name: ntt_ppc_asm
  Description: PowerPC64 VSX forward NTT
  Signature: void mlk_ntt_ppc_asm(int16_t *r, const int16_t *qdata)
  ABI:
    Architecture: powerpc64le
    CallingConvention: ELFv2
    Features: [VSX]
    r3:
      type: buffer
      size_bytes: 512
      permissions: read/write
      c_parameter: int16_t *r
      description: Input/output polynomial (256 x int16_t)
    r4:
      type: buffer
      size_bytes: 4144
      permissions: read-only
      c_parameter: const int16_t *qdata
      description: Precomputed constants (2072 x int16_t)
*/

/*
 * WARNING: This file is auto-derived from the mlkem-native source file
 *   dev/ppc64le/src/mlkem_ntt_ppc_asm.S using scripts/simpasm. Do not modify it directly.
 */

.text
.balign 4
.global MLK_ASM_NAMESPACE(ntt_ppc_asm)
MLK_ASM_FN_SYMBOL(ntt_ppc_asm)

        stdu 1, -352(1)
        mflr 0
        std 14, 56(1)
        std 15, 64(1)
        std 16, 72(1)
        std 17, 80(1)
        std 18, 88(1)
        std 19, 96(1)
        std 20, 104(1)
        std 21, 112(1)
        std 22, 120(1)
        li 10, 128
        li 11, 144
        li 12, 160
        li 14, 176
        li 15, 192
        li 16, 208
        stxvd2x 52, 10, 1
        stxvd2x 53, 11, 1
        stxvd2x 54, 12, 1
        stxvd2x 55, 14, 1
        stxvd2x 56, 15, 1
        stxvd2x 57, 16, 1
        li 10, 224
        li 11, 240
        li 12, 256
        li 14, 272
        li 15, 288
        li 16, 304
        stxvd2x 58, 10, 1
        stxvd2x 59, 11, 1
        stxvd2x 60, 12, 1
        stxvd2x 61, 14, 1
        stxvd2x 62, 15, 1
        stxvd2x 63, 16, 1
        lvx 5, 0, 4
        addi 14, 4, 112
        addi 22, 4, 2128
        vxor 3, 3, 3
        ori 2, 2, 0
        li 7, 256
        lvx 10, 0, 14
        lvx 2, 0, 22
        addi 14, 14, 16
        addi 22, 22, 16
        li 9, 0
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 2, 3
        vmhraddshs 20, 18, 2, 3
        vmhraddshs 25, 23, 2, 3
        vmhraddshs 30, 28, 2, 3
        vmladduhm 13, 13, 10, 3
        vmladduhm 18, 18, 10, 3
        vmladduhm 23, 23, 10, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        li 9, 64
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 2, 3
        vmhraddshs 20, 18, 2, 3
        vmhraddshs 25, 23, 2, 3
        vmhraddshs 30, 28, 2, 3
        vmladduhm 13, 13, 10, 3
        vmladduhm 18, 18, 10, 3
        vmladduhm 23, 23, 10, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        li 9, 128
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 2, 3
        vmhraddshs 20, 18, 2, 3
        vmhraddshs 25, 23, 2, 3
        vmhraddshs 30, 28, 2, 3
        vmladduhm 13, 13, 10, 3
        vmladduhm 18, 18, 10, 3
        vmladduhm 23, 23, 10, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        li 9, 192
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 2, 3
        vmhraddshs 20, 18, 2, 3
        vmhraddshs 25, 23, 2, 3
        vmhraddshs 30, 28, 2, 3
        vmladduhm 13, 13, 10, 3
        vmladduhm 18, 18, 10, 3
        vmladduhm 23, 23, 10, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        nop
        nop
        ori 2, 2, 0
        li 7, 128
        lvx 10, 0, 14
        lvx 2, 0, 22
        addi 14, 14, 16
        addi 22, 22, 16
        li 9, 0
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 2, 3
        vmhraddshs 20, 18, 2, 3
        vmhraddshs 25, 23, 2, 3
        vmhraddshs 30, 28, 2, 3
        vmladduhm 13, 13, 10, 3
        vmladduhm 18, 18, 10, 3
        vmladduhm 23, 23, 10, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        li 9, 64
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 2, 3
        vmhraddshs 20, 18, 2, 3
        vmhraddshs 25, 23, 2, 3
        vmhraddshs 30, 28, 2, 3
        vmladduhm 13, 13, 10, 3
        vmladduhm 18, 18, 10, 3
        vmladduhm 23, 23, 10, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        lvx 10, 0, 14
        lvx 2, 0, 22
        addi 14, 14, 16
        addi 22, 22, 16
        li 9, 256
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 2, 3
        vmhraddshs 20, 18, 2, 3
        vmhraddshs 25, 23, 2, 3
        vmhraddshs 30, 28, 2, 3
        vmladduhm 13, 13, 10, 3
        vmladduhm 18, 18, 10, 3
        vmladduhm 23, 23, 10, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        li 9, 320
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 2, 3
        vmhraddshs 20, 18, 2, 3
        vmhraddshs 25, 23, 2, 3
        vmhraddshs 30, 28, 2, 3
        vmladduhm 13, 13, 10, 3
        vmladduhm 18, 18, 10, 3
        vmladduhm 23, 23, 10, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        nop
        nop
        ori 2, 2, 0
        li 7, 64
        lvx 10, 0, 14
        lvx 2, 0, 22
        addi 14, 14, 16
        addi 22, 22, 16
        li 9, 0
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 2, 3
        vmhraddshs 20, 18, 2, 3
        vmhraddshs 25, 23, 2, 3
        vmhraddshs 30, 28, 2, 3
        vmladduhm 13, 13, 10, 3
        vmladduhm 18, 18, 10, 3
        vmladduhm 23, 23, 10, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        lvx 10, 0, 14
        lvx 2, 0, 22
        addi 14, 14, 16
        addi 22, 22, 16
        li 9, 128
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 2, 3
        vmhraddshs 20, 18, 2, 3
        vmhraddshs 25, 23, 2, 3
        vmhraddshs 30, 28, 2, 3
        vmladduhm 13, 13, 10, 3
        vmladduhm 18, 18, 10, 3
        vmladduhm 23, 23, 10, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        lvx 10, 0, 14
        lvx 2, 0, 22
        addi 14, 14, 16
        addi 22, 22, 16
        li 9, 256
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 2, 3
        vmhraddshs 20, 18, 2, 3
        vmhraddshs 25, 23, 2, 3
        vmhraddshs 30, 28, 2, 3
        vmladduhm 13, 13, 10, 3
        vmladduhm 18, 18, 10, 3
        vmladduhm 23, 23, 10, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        lvx 10, 0, 14
        lvx 2, 0, 22
        addi 14, 14, 16
        addi 22, 22, 16
        li 9, 384
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 2, 3
        vmhraddshs 20, 18, 2, 3
        vmhraddshs 25, 23, 2, 3
        vmhraddshs 30, 28, 2, 3
        vmladduhm 13, 13, 10, 3
        vmladduhm 18, 18, 10, 3
        vmladduhm 23, 23, 10, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        nop
        nop
        ori 2, 2, 0
        li 7, 32
        li 10, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 10, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 32, 0, 22
        lxvd2x 33, 10, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        li 9, 0
        add 10, 7, 9
        addi 16, 9, 64
        addi 17, 10, 64
        addi 18, 16, 64
        addi 19, 17, 64
        addi 20, 18, 64
        addi 21, 19, 64
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        li 9, 16
        add 10, 7, 9
        addi 16, 9, 64
        addi 17, 10, 64
        addi 18, 16, 64
        addi 19, 17, 64
        addi 20, 18, 64
        addi 21, 19, 64
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        li 10, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 10, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 32, 0, 22
        lxvd2x 33, 10, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        li 9, 256
        add 10, 7, 9
        addi 16, 9, 64
        addi 17, 10, 64
        addi 18, 16, 64
        addi 19, 17, 64
        addi 20, 18, 64
        addi 21, 19, 64
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        li 9, 272
        add 10, 7, 9
        addi 16, 9, 64
        addi 17, 10, 64
        addi 18, 16, 64
        addi 19, 17, 64
        addi 20, 18, 64
        addi 21, 19, 64
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        ori 2, 2, 0
        li 7, 16
        li 10, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 10, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 32, 0, 22
        lxvd2x 33, 10, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        li 9, 0
        add 10, 7, 9
        addi 16, 9, 32
        addi 17, 10, 32
        addi 18, 16, 32
        addi 19, 17, 32
        addi 20, 18, 32
        addi 21, 19, 32
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        li 10, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 10, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 32, 0, 22
        lxvd2x 33, 10, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        li 9, 128
        add 10, 7, 9
        addi 16, 9, 32
        addi 17, 10, 32
        addi 18, 16, 32
        addi 19, 17, 32
        addi 20, 18, 32
        addi 21, 19, 32
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        li 10, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 10, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 32, 0, 22
        lxvd2x 33, 10, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        li 9, 256
        add 10, 7, 9
        addi 16, 9, 32
        addi 17, 10, 32
        addi 18, 16, 32
        addi 19, 17, 32
        addi 20, 18, 32
        addi 21, 19, 32
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        li 10, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 10, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 32, 0, 22
        lxvd2x 33, 10, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        li 9, 384
        add 10, 7, 9
        addi 16, 9, 32
        addi 17, 10, 32
        addi 18, 16, 32
        addi 19, 17, 32
        addi 20, 18, 32
        addi 21, 19, 32
        lxvd2x 45, 3, 10
        lxvd2x 50, 3, 17
        lxvd2x 55, 3, 19
        lxvd2x 60, 3, 21
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        lxvd2x 44, 3, 9
        lxvd2x 49, 3, 16
        lxvd2x 54, 3, 18
        lxvd2x 59, 3, 20
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        stxvd2x 47, 3, 9
        stxvd2x 48, 3, 10
        stxvd2x 52, 3, 16
        stxvd2x 53, 3, 17
        stxvd2x 57, 3, 18
        stxvd2x 58, 3, 19
        stxvd2x 62, 3, 20
        stxvd2x 63, 3, 21
        mr 5, 3
        li 7, 8
        li 10, 16
        li 11, 32
        li 12, 48
        li 15, 64
        li 16, 80
        li 17, 96
        li 18, 112
        nop
        ori 2, 2, 0
        li 10, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 10, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 32, 0, 22
        lxvd2x 33, 10, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        lxvd2x 1, 0, 5
        lxvd2x 2, 10, 5
        xxmrgld 45, 2, 1
        xxmrghd 44, 2, 1
        lxvd2x 3, 11, 5
        lxvd2x 4, 12, 5
        xxmrgld 50, 4, 3
        xxmrghd 49, 4, 3
        lxvd2x 1, 15, 5
        lxvd2x 2, 16, 5
        xxmrgld 55, 2, 1
        xxmrghd 54, 2, 1
        lxvd2x 3, 17, 5
        lxvd2x 4, 18, 5
        xxmrgld 60, 4, 3
        xxmrghd 59, 4, 3
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        xxmrgld 0, 47, 48
        xxmrghd 1, 47, 48
        xxmrgld 2, 52, 53
        xxmrghd 3, 52, 53
        xxmrgld 4, 57, 58
        xxmrghd 5, 57, 58
        xxmrgld 6, 62, 63
        xxmrghd 7, 62, 63
        stxvd2x 0, 0, 5
        stxvd2x 1, 10, 5
        stxvd2x 2, 11, 5
        stxvd2x 3, 12, 5
        stxvd2x 4, 15, 5
        stxvd2x 5, 16, 5
        stxvd2x 6, 17, 5
        stxvd2x 7, 18, 5
        addi 5, 5, 128
        li 10, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 10, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 32, 0, 22
        lxvd2x 33, 10, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        lxvd2x 1, 0, 5
        lxvd2x 2, 10, 5
        xxmrgld 45, 2, 1
        xxmrghd 44, 2, 1
        lxvd2x 3, 11, 5
        lxvd2x 4, 12, 5
        xxmrgld 50, 4, 3
        xxmrghd 49, 4, 3
        lxvd2x 1, 15, 5
        lxvd2x 2, 16, 5
        xxmrgld 55, 2, 1
        xxmrghd 54, 2, 1
        lxvd2x 3, 17, 5
        lxvd2x 4, 18, 5
        xxmrgld 60, 4, 3
        xxmrghd 59, 4, 3
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        xxmrgld 0, 47, 48
        xxmrghd 1, 47, 48
        xxmrgld 2, 52, 53
        xxmrghd 3, 52, 53
        xxmrgld 4, 57, 58
        xxmrghd 5, 57, 58
        xxmrgld 6, 62, 63
        xxmrghd 7, 62, 63
        stxvd2x 0, 0, 5
        stxvd2x 1, 10, 5
        stxvd2x 2, 11, 5
        stxvd2x 3, 12, 5
        stxvd2x 4, 15, 5
        stxvd2x 5, 16, 5
        stxvd2x 6, 17, 5
        stxvd2x 7, 18, 5
        addi 5, 5, 128
        li 10, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 10, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 32, 0, 22
        lxvd2x 33, 10, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        lxvd2x 1, 0, 5
        lxvd2x 2, 10, 5
        xxmrgld 45, 2, 1
        xxmrghd 44, 2, 1
        lxvd2x 3, 11, 5
        lxvd2x 4, 12, 5
        xxmrgld 50, 4, 3
        xxmrghd 49, 4, 3
        lxvd2x 1, 15, 5
        lxvd2x 2, 16, 5
        xxmrgld 55, 2, 1
        xxmrghd 54, 2, 1
        lxvd2x 3, 17, 5
        lxvd2x 4, 18, 5
        xxmrgld 60, 4, 3
        xxmrghd 59, 4, 3
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        xxmrgld 0, 47, 48
        xxmrghd 1, 47, 48
        xxmrgld 2, 52, 53
        xxmrghd 3, 52, 53
        xxmrgld 4, 57, 58
        xxmrghd 5, 57, 58
        xxmrgld 6, 62, 63
        xxmrghd 7, 62, 63
        stxvd2x 0, 0, 5
        stxvd2x 1, 10, 5
        stxvd2x 2, 11, 5
        stxvd2x 3, 12, 5
        stxvd2x 4, 15, 5
        stxvd2x 5, 16, 5
        stxvd2x 6, 17, 5
        stxvd2x 7, 18, 5
        addi 5, 5, 128
        li 10, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 10, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 32, 0, 22
        lxvd2x 33, 10, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        lxvd2x 1, 0, 5
        lxvd2x 2, 10, 5
        xxmrgld 45, 2, 1
        xxmrghd 44, 2, 1
        lxvd2x 3, 11, 5
        lxvd2x 4, 12, 5
        xxmrgld 50, 4, 3
        xxmrghd 49, 4, 3
        lxvd2x 1, 15, 5
        lxvd2x 2, 16, 5
        xxmrgld 55, 2, 1
        xxmrghd 54, 2, 1
        lxvd2x 3, 17, 5
        lxvd2x 4, 18, 5
        xxmrgld 60, 4, 3
        xxmrghd 59, 4, 3
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        xxmrgld 0, 47, 48
        xxmrghd 1, 47, 48
        xxmrgld 2, 52, 53
        xxmrghd 3, 52, 53
        xxmrgld 4, 57, 58
        xxmrghd 5, 57, 58
        xxmrgld 6, 62, 63
        xxmrghd 7, 62, 63
        stxvd2x 0, 0, 5
        stxvd2x 1, 10, 5
        stxvd2x 2, 11, 5
        stxvd2x 3, 12, 5
        stxvd2x 4, 15, 5
        stxvd2x 5, 16, 5
        stxvd2x 6, 17, 5
        stxvd2x 7, 18, 5
        addi 5, 5, 128
        mr 5, 3
        li 7, 4
        nop
        ori 2, 2, 0
        li 10, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 10, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 32, 0, 22
        lxvd2x 33, 10, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        lxvd2x 57, 0, 5
        lxvd2x 58, 10, 5
        vmrgew 13, 25, 26
        vmrgow 12, 25, 26
        lxvd2x 57, 11, 5
        lxvd2x 58, 12, 5
        vmrgew 18, 25, 26
        vmrgow 17, 25, 26
        lxvd2x 57, 15, 5
        lxvd2x 58, 16, 5
        vmrgew 23, 25, 26
        vmrgow 22, 25, 26
        lxvd2x 57, 17, 5
        lxvd2x 58, 18, 5
        vmrgew 28, 25, 26
        vmrgow 27, 25, 26
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        vmrgew 10, 16, 15
        vmrgow 11, 16, 15
        vmrgew 12, 21, 20
        vmrgow 13, 21, 20
        vmrgew 14, 26, 25
        vmrgow 15, 26, 25
        vmrgew 16, 31, 30
        vmrgow 17, 31, 30
        stxvd2x 42, 0, 5
        stxvd2x 43, 10, 5
        stxvd2x 44, 11, 5
        stxvd2x 45, 12, 5
        stxvd2x 46, 15, 5
        stxvd2x 47, 16, 5
        stxvd2x 48, 17, 5
        stxvd2x 49, 18, 5
        addi 5, 5, 128
        li 10, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 10, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 32, 0, 22
        lxvd2x 33, 10, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        lxvd2x 57, 0, 5
        lxvd2x 58, 10, 5
        vmrgew 13, 25, 26
        vmrgow 12, 25, 26
        lxvd2x 57, 11, 5
        lxvd2x 58, 12, 5
        vmrgew 18, 25, 26
        vmrgow 17, 25, 26
        lxvd2x 57, 15, 5
        lxvd2x 58, 16, 5
        vmrgew 23, 25, 26
        vmrgow 22, 25, 26
        lxvd2x 57, 17, 5
        lxvd2x 58, 18, 5
        vmrgew 28, 25, 26
        vmrgow 27, 25, 26
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        vmrgew 10, 16, 15
        vmrgow 11, 16, 15
        vmrgew 12, 21, 20
        vmrgow 13, 21, 20
        vmrgew 14, 26, 25
        vmrgow 15, 26, 25
        vmrgew 16, 31, 30
        vmrgow 17, 31, 30
        stxvd2x 42, 0, 5
        stxvd2x 43, 10, 5
        stxvd2x 44, 11, 5
        stxvd2x 45, 12, 5
        stxvd2x 46, 15, 5
        stxvd2x 47, 16, 5
        stxvd2x 48, 17, 5
        stxvd2x 49, 18, 5
        addi 5, 5, 128
        li 10, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 10, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 32, 0, 22
        lxvd2x 33, 10, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        lxvd2x 57, 0, 5
        lxvd2x 58, 10, 5
        vmrgew 13, 25, 26
        vmrgow 12, 25, 26
        lxvd2x 57, 11, 5
        lxvd2x 58, 12, 5
        vmrgew 18, 25, 26
        vmrgow 17, 25, 26
        lxvd2x 57, 15, 5
        lxvd2x 58, 16, 5
        vmrgew 23, 25, 26
        vmrgow 22, 25, 26
        lxvd2x 57, 17, 5
        lxvd2x 58, 18, 5
        vmrgew 28, 25, 26
        vmrgow 27, 25, 26
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        vmrgew 10, 16, 15
        vmrgow 11, 16, 15
        vmrgew 12, 21, 20
        vmrgow 13, 21, 20
        vmrgew 14, 26, 25
        vmrgow 15, 26, 25
        vmrgew 16, 31, 30
        vmrgow 17, 31, 30
        stxvd2x 42, 0, 5
        stxvd2x 43, 10, 5
        stxvd2x 44, 11, 5
        stxvd2x 45, 12, 5
        stxvd2x 46, 15, 5
        stxvd2x 47, 16, 5
        stxvd2x 48, 17, 5
        stxvd2x 49, 18, 5
        addi 5, 5, 128
        li 10, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 10, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 32, 0, 22
        lxvd2x 33, 10, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        lxvd2x 57, 0, 5
        lxvd2x 58, 10, 5
        vmrgew 13, 25, 26
        vmrgow 12, 25, 26
        lxvd2x 57, 11, 5
        lxvd2x 58, 12, 5
        vmrgew 18, 25, 26
        vmrgow 17, 25, 26
        lxvd2x 57, 15, 5
        lxvd2x 58, 16, 5
        vmrgew 23, 25, 26
        vmrgow 22, 25, 26
        lxvd2x 57, 17, 5
        lxvd2x 58, 18, 5
        vmrgew 28, 25, 26
        vmrgow 27, 25, 26
        vmhraddshs 15, 13, 0, 3
        vmhraddshs 20, 18, 1, 3
        vmhraddshs 25, 23, 6, 3
        vmhraddshs 30, 28, 11, 3
        vmladduhm 13, 13, 7, 3
        vmladduhm 18, 18, 8, 3
        vmladduhm 23, 23, 9, 3
        vmladduhm 28, 28, 10, 3
        vmladduhm 13, 15, 5, 13
        vmladduhm 18, 20, 5, 18
        vmladduhm 23, 25, 5, 23
        vmladduhm 28, 30, 5, 28
        vsubuhm 16, 12, 13
        vadduhm 15, 13, 12
        vsubuhm 21, 17, 18
        vadduhm 20, 18, 17
        vsubuhm 26, 22, 23
        vadduhm 25, 23, 22
        vsubuhm 31, 27, 28
        vadduhm 30, 28, 27
        vmrgew 10, 16, 15
        vmrgow 11, 16, 15
        vmrgew 12, 21, 20
        vmrgow 13, 21, 20
        vmrgew 14, 26, 25
        vmrgow 15, 26, 25
        vmrgew 16, 31, 30
        vmrgow 17, 31, 30
        stxvd2x 42, 0, 5
        stxvd2x 43, 10, 5
        stxvd2x 44, 11, 5
        stxvd2x 45, 12, 5
        stxvd2x 46, 15, 5
        stxvd2x 47, 16, 5
        stxvd2x 48, 17, 5
        stxvd2x 49, 18, 5
        addi 5, 5, 128
        li 10, 128
        li 11, 144
        li 12, 160
        li 14, 176
        li 15, 192
        li 16, 208
        lxvd2x 52, 10, 1
        lxvd2x 53, 11, 1
        lxvd2x 54, 12, 1
        lxvd2x 55, 14, 1
        lxvd2x 56, 15, 1
        lxvd2x 57, 16, 1
        li 10, 224
        li 11, 240
        li 12, 256
        li 14, 272
        li 15, 288
        li 16, 304
        lxvd2x 58, 10, 1
        lxvd2x 59, 11, 1
        lxvd2x 60, 12, 1
        lxvd2x 61, 14, 1
        lxvd2x 62, 15, 1
        lxvd2x 63, 16, 1
        ld 14, 56(1)
        ld 15, 64(1)
        ld 16, 72(1)
        ld 17, 80(1)
        ld 18, 88(1)
        ld 19, 96(1)
        ld 20, 104(1)
        ld 21, 112(1)
        ld 22, 120(1)
        mtlr 0
        addi 1, 1, 352
        blr

MLK_ASM_FN_SIZE(ntt_ppc_asm)

#endif /* MLK_ARITH_BACKEND_PPC64LE_DEFAULT && !MLK_CONFIG_MULTILEVEL_NO_SHARED \
          && __POWER8_VECTOR__ */

#if defined(__ELF__)
.section .note.GNU-stack,"",%progbits
#endif
