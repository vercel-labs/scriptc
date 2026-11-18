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
  Name: reduce_ppc_asm
  Description: PowerPC64 VSX modular reduction
  Signature: void mlk_reduce_ppc_asm(int16_t *r, const int16_t *qdata)
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
 *   dev/ppc64le/src/mlkem_reduce_ppc_asm.S using scripts/simpasm. Do not modify it directly.
 */

.text
.balign 4
.global MLK_ASM_NAMESPACE(reduce_ppc_asm)
MLK_ASM_FN_SYMBOL(reduce_ppc_asm)

        stdu 1, -224(1)
        mflr 0
        std 14, 96(1)
        std 15, 104(1)
        std 16, 112(1)
        li 6, 128
        li 7, 144
        li 8, 160
        li 9, 176
        li 10, 192
        stxvd2x 52, 6, 1
        stxvd2x 53, 7, 1
        stxvd2x 54, 8, 1
        stxvd2x 55, 9, 1
        stxvd2x 56, 10, 1
        vxor 7, 7, 7
        li 6, 16
        li 7, 32
        lxvd2x 35, 6, 4
        lxvd2x 32, 7, 4
        vspltisw 2, 13
        vadduwm 2, 2, 2
        vspltisw 4, 1
        vsubuwm 5, 2, 4
        vslw 1, 4, 5
        li 4, -128
        li 5, -112
        li 6, -96
        li 7, -80
        li 8, -64
        li 9, -48
        li 10, -32
        li 11, -16
        li 14, 16
        li 15, 32
        li 16, 48
        lxvd2x 40, 0, 3
        lxvd2x 44, 14, 3
        lxvd2x 48, 15, 3
        lxvd2x 52, 16, 3
        addi 3, 3, 64
        vmulosh 6, 8, 0
        vmulesh 5, 8, 0
        vmulosh 11, 12, 0
        vmulesh 10, 12, 0
        vmulosh 15, 16, 0
        vmulesh 14, 16, 0
        vmulosh 19, 20, 0
        vmulesh 18, 20, 0
        xxmrglw 36, 37, 38
        xxmrghw 37, 37, 38
        xxmrglw 41, 42, 43
        xxmrghw 42, 42, 43
        xxmrglw 45, 46, 47
        xxmrghw 46, 46, 47
        xxmrglw 49, 50, 51
        xxmrghw 50, 50, 51
        vadduwm 4, 4, 1
        vadduwm 5, 5, 1
        vadduwm 9, 9, 1
        vadduwm 10, 10, 1
        vadduwm 13, 13, 1
        vadduwm 14, 14, 1
        vadduwm 17, 17, 1
        vadduwm 18, 18, 1
        vsraw 4, 4, 2
        vsraw 5, 5, 2
        vsraw 9, 9, 2
        vsraw 10, 10, 2
        vsraw 13, 13, 2
        vsraw 14, 14, 2
        vsraw 17, 17, 2
        vsraw 18, 18, 2
        vpkuwum 4, 5, 4
        vsubuhm 4, 7, 4
        vpkuwum 9, 10, 9
        vsubuhm 9, 7, 9
        vpkuwum 13, 14, 13
        vsubuhm 13, 7, 13
        vpkuwum 17, 18, 17
        vsubuhm 17, 7, 17
        vmladduhm 21, 4, 3, 8
        vmladduhm 22, 9, 3, 12
        vmladduhm 23, 13, 3, 16
        vmladduhm 24, 17, 3, 20
        lxvd2x 40, 0, 3
        lxvd2x 44, 14, 3
        lxvd2x 48, 15, 3
        lxvd2x 52, 16, 3
        addi 3, 3, 64
        vmulosh 6, 8, 0
        vmulesh 5, 8, 0
        vmulosh 11, 12, 0
        vmulesh 10, 12, 0
        vmulosh 15, 16, 0
        vmulesh 14, 16, 0
        vmulosh 19, 20, 0
        vmulesh 18, 20, 0
        xxmrglw 36, 37, 38
        xxmrghw 37, 37, 38
        xxmrglw 41, 42, 43
        xxmrghw 42, 42, 43
        xxmrglw 45, 46, 47
        xxmrghw 46, 46, 47
        xxmrglw 49, 50, 51
        xxmrghw 50, 50, 51
        vadduwm 4, 4, 1
        vadduwm 5, 5, 1
        vadduwm 9, 9, 1
        vadduwm 10, 10, 1
        vadduwm 13, 13, 1
        vadduwm 14, 14, 1
        vadduwm 17, 17, 1
        vadduwm 18, 18, 1
        vsraw 4, 4, 2
        vsraw 5, 5, 2
        vsraw 9, 9, 2
        vsraw 10, 10, 2
        vsraw 13, 13, 2
        vsraw 14, 14, 2
        vsraw 17, 17, 2
        vsraw 18, 18, 2
        vpkuwum 4, 5, 4
        vsubuhm 4, 7, 4
        vpkuwum 9, 10, 9
        vsubuhm 9, 7, 9
        vpkuwum 13, 14, 13
        vsubuhm 13, 7, 13
        vpkuwum 17, 18, 17
        vsubuhm 17, 7, 17
        vmladduhm 4, 4, 3, 8
        vmladduhm 9, 9, 3, 12
        vmladduhm 13, 13, 3, 16
        vmladduhm 17, 17, 3, 20
        stxvd2x 53, 4, 3
        stxvd2x 54, 5, 3
        stxvd2x 55, 6, 3
        stxvd2x 56, 7, 3
        stxvd2x 36, 8, 3
        stxvd2x 41, 9, 3
        stxvd2x 45, 10, 3
        stxvd2x 49, 11, 3
        lxvd2x 40, 0, 3
        lxvd2x 44, 14, 3
        lxvd2x 48, 15, 3
        lxvd2x 52, 16, 3
        addi 3, 3, 64
        vmulosh 6, 8, 0
        vmulesh 5, 8, 0
        vmulosh 11, 12, 0
        vmulesh 10, 12, 0
        vmulosh 15, 16, 0
        vmulesh 14, 16, 0
        vmulosh 19, 20, 0
        vmulesh 18, 20, 0
        xxmrglw 36, 37, 38
        xxmrghw 37, 37, 38
        xxmrglw 41, 42, 43
        xxmrghw 42, 42, 43
        xxmrglw 45, 46, 47
        xxmrghw 46, 46, 47
        xxmrglw 49, 50, 51
        xxmrghw 50, 50, 51
        vadduwm 4, 4, 1
        vadduwm 5, 5, 1
        vadduwm 9, 9, 1
        vadduwm 10, 10, 1
        vadduwm 13, 13, 1
        vadduwm 14, 14, 1
        vadduwm 17, 17, 1
        vadduwm 18, 18, 1
        vsraw 4, 4, 2
        vsraw 5, 5, 2
        vsraw 9, 9, 2
        vsraw 10, 10, 2
        vsraw 13, 13, 2
        vsraw 14, 14, 2
        vsraw 17, 17, 2
        vsraw 18, 18, 2
        vpkuwum 4, 5, 4
        vsubuhm 4, 7, 4
        vpkuwum 9, 10, 9
        vsubuhm 9, 7, 9
        vpkuwum 13, 14, 13
        vsubuhm 13, 7, 13
        vpkuwum 17, 18, 17
        vsubuhm 17, 7, 17
        vmladduhm 21, 4, 3, 8
        vmladduhm 22, 9, 3, 12
        vmladduhm 23, 13, 3, 16
        vmladduhm 24, 17, 3, 20
        lxvd2x 40, 0, 3
        lxvd2x 44, 14, 3
        lxvd2x 48, 15, 3
        lxvd2x 52, 16, 3
        addi 3, 3, 64
        vmulosh 6, 8, 0
        vmulesh 5, 8, 0
        vmulosh 11, 12, 0
        vmulesh 10, 12, 0
        vmulosh 15, 16, 0
        vmulesh 14, 16, 0
        vmulosh 19, 20, 0
        vmulesh 18, 20, 0
        xxmrglw 36, 37, 38
        xxmrghw 37, 37, 38
        xxmrglw 41, 42, 43
        xxmrghw 42, 42, 43
        xxmrglw 45, 46, 47
        xxmrghw 46, 46, 47
        xxmrglw 49, 50, 51
        xxmrghw 50, 50, 51
        vadduwm 4, 4, 1
        vadduwm 5, 5, 1
        vadduwm 9, 9, 1
        vadduwm 10, 10, 1
        vadduwm 13, 13, 1
        vadduwm 14, 14, 1
        vadduwm 17, 17, 1
        vadduwm 18, 18, 1
        vsraw 4, 4, 2
        vsraw 5, 5, 2
        vsraw 9, 9, 2
        vsraw 10, 10, 2
        vsraw 13, 13, 2
        vsraw 14, 14, 2
        vsraw 17, 17, 2
        vsraw 18, 18, 2
        vpkuwum 4, 5, 4
        vsubuhm 4, 7, 4
        vpkuwum 9, 10, 9
        vsubuhm 9, 7, 9
        vpkuwum 13, 14, 13
        vsubuhm 13, 7, 13
        vpkuwum 17, 18, 17
        vsubuhm 17, 7, 17
        vmladduhm 4, 4, 3, 8
        vmladduhm 9, 9, 3, 12
        vmladduhm 13, 13, 3, 16
        vmladduhm 17, 17, 3, 20
        stxvd2x 53, 4, 3
        stxvd2x 54, 5, 3
        stxvd2x 55, 6, 3
        stxvd2x 56, 7, 3
        stxvd2x 36, 8, 3
        stxvd2x 41, 9, 3
        stxvd2x 45, 10, 3
        stxvd2x 49, 11, 3
        lxvd2x 40, 0, 3
        lxvd2x 44, 14, 3
        lxvd2x 48, 15, 3
        lxvd2x 52, 16, 3
        addi 3, 3, 64
        vmulosh 6, 8, 0
        vmulesh 5, 8, 0
        vmulosh 11, 12, 0
        vmulesh 10, 12, 0
        vmulosh 15, 16, 0
        vmulesh 14, 16, 0
        vmulosh 19, 20, 0
        vmulesh 18, 20, 0
        xxmrglw 36, 37, 38
        xxmrghw 37, 37, 38
        xxmrglw 41, 42, 43
        xxmrghw 42, 42, 43
        xxmrglw 45, 46, 47
        xxmrghw 46, 46, 47
        xxmrglw 49, 50, 51
        xxmrghw 50, 50, 51
        vadduwm 4, 4, 1
        vadduwm 5, 5, 1
        vadduwm 9, 9, 1
        vadduwm 10, 10, 1
        vadduwm 13, 13, 1
        vadduwm 14, 14, 1
        vadduwm 17, 17, 1
        vadduwm 18, 18, 1
        vsraw 4, 4, 2
        vsraw 5, 5, 2
        vsraw 9, 9, 2
        vsraw 10, 10, 2
        vsraw 13, 13, 2
        vsraw 14, 14, 2
        vsraw 17, 17, 2
        vsraw 18, 18, 2
        vpkuwum 4, 5, 4
        vsubuhm 4, 7, 4
        vpkuwum 9, 10, 9
        vsubuhm 9, 7, 9
        vpkuwum 13, 14, 13
        vsubuhm 13, 7, 13
        vpkuwum 17, 18, 17
        vsubuhm 17, 7, 17
        vmladduhm 21, 4, 3, 8
        vmladduhm 22, 9, 3, 12
        vmladduhm 23, 13, 3, 16
        vmladduhm 24, 17, 3, 20
        lxvd2x 40, 0, 3
        lxvd2x 44, 14, 3
        lxvd2x 48, 15, 3
        lxvd2x 52, 16, 3
        addi 3, 3, 64
        vmulosh 6, 8, 0
        vmulesh 5, 8, 0
        vmulosh 11, 12, 0
        vmulesh 10, 12, 0
        vmulosh 15, 16, 0
        vmulesh 14, 16, 0
        vmulosh 19, 20, 0
        vmulesh 18, 20, 0
        xxmrglw 36, 37, 38
        xxmrghw 37, 37, 38
        xxmrglw 41, 42, 43
        xxmrghw 42, 42, 43
        xxmrglw 45, 46, 47
        xxmrghw 46, 46, 47
        xxmrglw 49, 50, 51
        xxmrghw 50, 50, 51
        vadduwm 4, 4, 1
        vadduwm 5, 5, 1
        vadduwm 9, 9, 1
        vadduwm 10, 10, 1
        vadduwm 13, 13, 1
        vadduwm 14, 14, 1
        vadduwm 17, 17, 1
        vadduwm 18, 18, 1
        vsraw 4, 4, 2
        vsraw 5, 5, 2
        vsraw 9, 9, 2
        vsraw 10, 10, 2
        vsraw 13, 13, 2
        vsraw 14, 14, 2
        vsraw 17, 17, 2
        vsraw 18, 18, 2
        vpkuwum 4, 5, 4
        vsubuhm 4, 7, 4
        vpkuwum 9, 10, 9
        vsubuhm 9, 7, 9
        vpkuwum 13, 14, 13
        vsubuhm 13, 7, 13
        vpkuwum 17, 18, 17
        vsubuhm 17, 7, 17
        vmladduhm 4, 4, 3, 8
        vmladduhm 9, 9, 3, 12
        vmladduhm 13, 13, 3, 16
        vmladduhm 17, 17, 3, 20
        stxvd2x 53, 4, 3
        stxvd2x 54, 5, 3
        stxvd2x 55, 6, 3
        stxvd2x 56, 7, 3
        stxvd2x 36, 8, 3
        stxvd2x 41, 9, 3
        stxvd2x 45, 10, 3
        stxvd2x 49, 11, 3
        lxvd2x 40, 0, 3
        lxvd2x 44, 14, 3
        lxvd2x 48, 15, 3
        lxvd2x 52, 16, 3
        addi 3, 3, 64
        vmulosh 6, 8, 0
        vmulesh 5, 8, 0
        vmulosh 11, 12, 0
        vmulesh 10, 12, 0
        vmulosh 15, 16, 0
        vmulesh 14, 16, 0
        vmulosh 19, 20, 0
        vmulesh 18, 20, 0
        xxmrglw 36, 37, 38
        xxmrghw 37, 37, 38
        xxmrglw 41, 42, 43
        xxmrghw 42, 42, 43
        xxmrglw 45, 46, 47
        xxmrghw 46, 46, 47
        xxmrglw 49, 50, 51
        xxmrghw 50, 50, 51
        vadduwm 4, 4, 1
        vadduwm 5, 5, 1
        vadduwm 9, 9, 1
        vadduwm 10, 10, 1
        vadduwm 13, 13, 1
        vadduwm 14, 14, 1
        vadduwm 17, 17, 1
        vadduwm 18, 18, 1
        vsraw 4, 4, 2
        vsraw 5, 5, 2
        vsraw 9, 9, 2
        vsraw 10, 10, 2
        vsraw 13, 13, 2
        vsraw 14, 14, 2
        vsraw 17, 17, 2
        vsraw 18, 18, 2
        vpkuwum 4, 5, 4
        vsubuhm 4, 7, 4
        vpkuwum 9, 10, 9
        vsubuhm 9, 7, 9
        vpkuwum 13, 14, 13
        vsubuhm 13, 7, 13
        vpkuwum 17, 18, 17
        vsubuhm 17, 7, 17
        vmladduhm 21, 4, 3, 8
        vmladduhm 22, 9, 3, 12
        vmladduhm 23, 13, 3, 16
        vmladduhm 24, 17, 3, 20
        lxvd2x 40, 0, 3
        lxvd2x 44, 14, 3
        lxvd2x 48, 15, 3
        lxvd2x 52, 16, 3
        addi 3, 3, 64
        vmulosh 6, 8, 0
        vmulesh 5, 8, 0
        vmulosh 11, 12, 0
        vmulesh 10, 12, 0
        vmulosh 15, 16, 0
        vmulesh 14, 16, 0
        vmulosh 19, 20, 0
        vmulesh 18, 20, 0
        xxmrglw 36, 37, 38
        xxmrghw 37, 37, 38
        xxmrglw 41, 42, 43
        xxmrghw 42, 42, 43
        xxmrglw 45, 46, 47
        xxmrghw 46, 46, 47
        xxmrglw 49, 50, 51
        xxmrghw 50, 50, 51
        vadduwm 4, 4, 1
        vadduwm 5, 5, 1
        vadduwm 9, 9, 1
        vadduwm 10, 10, 1
        vadduwm 13, 13, 1
        vadduwm 14, 14, 1
        vadduwm 17, 17, 1
        vadduwm 18, 18, 1
        vsraw 4, 4, 2
        vsraw 5, 5, 2
        vsraw 9, 9, 2
        vsraw 10, 10, 2
        vsraw 13, 13, 2
        vsraw 14, 14, 2
        vsraw 17, 17, 2
        vsraw 18, 18, 2
        vpkuwum 4, 5, 4
        vsubuhm 4, 7, 4
        vpkuwum 9, 10, 9
        vsubuhm 9, 7, 9
        vpkuwum 13, 14, 13
        vsubuhm 13, 7, 13
        vpkuwum 17, 18, 17
        vsubuhm 17, 7, 17
        vmladduhm 4, 4, 3, 8
        vmladduhm 9, 9, 3, 12
        vmladduhm 13, 13, 3, 16
        vmladduhm 17, 17, 3, 20
        stxvd2x 53, 4, 3
        stxvd2x 54, 5, 3
        stxvd2x 55, 6, 3
        stxvd2x 56, 7, 3
        stxvd2x 36, 8, 3
        stxvd2x 41, 9, 3
        stxvd2x 45, 10, 3
        stxvd2x 49, 11, 3
        addi 3, 3, -512
        vxor 9, 9, 9
        vspltish 10, 15
        vmr 11, 3
        lxvd2x 44, 0, 3
        lxvd2x 45, 14, 3
        lxvd2x 46, 15, 3
        lxvd2x 47, 16, 3
        addi 3, 3, 64
        vsrh 1, 12, 10
        vsrh 0, 13, 10
        vsrh 3, 14, 10
        vsrh 2, 15, 10
        vadduhm 7, 12, 11
        vadduhm 8, 13, 11
        vadduhm 5, 14, 11
        vadduhm 6, 15, 11
        vcmpequh 1, 1, 9
        vcmpequh 0, 0, 9
        vcmpequh 3, 3, 9
        vcmpequh 2, 2, 9
        xxsel 33, 39, 44, 33
        xxsel 32, 40, 45, 32
        xxsel 35, 37, 46, 35
        xxsel 34, 38, 47, 34
        stxvd2x 35, 10, 3
        stxvd2x 34, 11, 3
        stxvd2x 33, 8, 3
        stxvd2x 32, 9, 3
        lxvd2x 44, 0, 3
        lxvd2x 45, 14, 3
        lxvd2x 46, 15, 3
        lxvd2x 47, 16, 3
        addi 3, 3, 64
        vsrh 1, 12, 10
        vsrh 0, 13, 10
        vsrh 3, 14, 10
        vsrh 2, 15, 10
        vadduhm 7, 12, 11
        vadduhm 8, 13, 11
        vadduhm 5, 14, 11
        vadduhm 6, 15, 11
        vcmpequh 1, 1, 9
        vcmpequh 0, 0, 9
        vcmpequh 3, 3, 9
        vcmpequh 2, 2, 9
        xxsel 33, 39, 44, 33
        xxsel 32, 40, 45, 32
        xxsel 35, 37, 46, 35
        xxsel 34, 38, 47, 34
        stxvd2x 35, 10, 3
        stxvd2x 34, 11, 3
        stxvd2x 33, 8, 3
        stxvd2x 32, 9, 3
        lxvd2x 44, 0, 3
        lxvd2x 45, 14, 3
        lxvd2x 46, 15, 3
        lxvd2x 47, 16, 3
        addi 3, 3, 64
        vsrh 1, 12, 10
        vsrh 0, 13, 10
        vsrh 3, 14, 10
        vsrh 2, 15, 10
        vadduhm 7, 12, 11
        vadduhm 8, 13, 11
        vadduhm 5, 14, 11
        vadduhm 6, 15, 11
        vcmpequh 1, 1, 9
        vcmpequh 0, 0, 9
        vcmpequh 3, 3, 9
        vcmpequh 2, 2, 9
        xxsel 33, 39, 44, 33
        xxsel 32, 40, 45, 32
        xxsel 35, 37, 46, 35
        xxsel 34, 38, 47, 34
        stxvd2x 35, 10, 3
        stxvd2x 34, 11, 3
        stxvd2x 33, 8, 3
        stxvd2x 32, 9, 3
        lxvd2x 44, 0, 3
        lxvd2x 45, 14, 3
        lxvd2x 46, 15, 3
        lxvd2x 47, 16, 3
        addi 3, 3, 64
        vsrh 1, 12, 10
        vsrh 0, 13, 10
        vsrh 3, 14, 10
        vsrh 2, 15, 10
        vadduhm 7, 12, 11
        vadduhm 8, 13, 11
        vadduhm 5, 14, 11
        vadduhm 6, 15, 11
        vcmpequh 1, 1, 9
        vcmpequh 0, 0, 9
        vcmpequh 3, 3, 9
        vcmpequh 2, 2, 9
        xxsel 33, 39, 44, 33
        xxsel 32, 40, 45, 32
        xxsel 35, 37, 46, 35
        xxsel 34, 38, 47, 34
        stxvd2x 35, 10, 3
        stxvd2x 34, 11, 3
        stxvd2x 33, 8, 3
        stxvd2x 32, 9, 3
        lxvd2x 44, 0, 3
        lxvd2x 45, 14, 3
        lxvd2x 46, 15, 3
        lxvd2x 47, 16, 3
        addi 3, 3, 64
        vsrh 1, 12, 10
        vsrh 0, 13, 10
        vsrh 3, 14, 10
        vsrh 2, 15, 10
        vadduhm 7, 12, 11
        vadduhm 8, 13, 11
        vadduhm 5, 14, 11
        vadduhm 6, 15, 11
        vcmpequh 1, 1, 9
        vcmpequh 0, 0, 9
        vcmpequh 3, 3, 9
        vcmpequh 2, 2, 9
        xxsel 33, 39, 44, 33
        xxsel 32, 40, 45, 32
        xxsel 35, 37, 46, 35
        xxsel 34, 38, 47, 34
        stxvd2x 35, 10, 3
        stxvd2x 34, 11, 3
        stxvd2x 33, 8, 3
        stxvd2x 32, 9, 3
        lxvd2x 44, 0, 3
        lxvd2x 45, 14, 3
        lxvd2x 46, 15, 3
        lxvd2x 47, 16, 3
        addi 3, 3, 64
        vsrh 1, 12, 10
        vsrh 0, 13, 10
        vsrh 3, 14, 10
        vsrh 2, 15, 10
        vadduhm 7, 12, 11
        vadduhm 8, 13, 11
        vadduhm 5, 14, 11
        vadduhm 6, 15, 11
        vcmpequh 1, 1, 9
        vcmpequh 0, 0, 9
        vcmpequh 3, 3, 9
        vcmpequh 2, 2, 9
        xxsel 33, 39, 44, 33
        xxsel 32, 40, 45, 32
        xxsel 35, 37, 46, 35
        xxsel 34, 38, 47, 34
        stxvd2x 35, 10, 3
        stxvd2x 34, 11, 3
        stxvd2x 33, 8, 3
        stxvd2x 32, 9, 3
        lxvd2x 44, 0, 3
        lxvd2x 45, 14, 3
        lxvd2x 46, 15, 3
        lxvd2x 47, 16, 3
        addi 3, 3, 64
        vsrh 1, 12, 10
        vsrh 0, 13, 10
        vsrh 3, 14, 10
        vsrh 2, 15, 10
        vadduhm 7, 12, 11
        vadduhm 8, 13, 11
        vadduhm 5, 14, 11
        vadduhm 6, 15, 11
        vcmpequh 1, 1, 9
        vcmpequh 0, 0, 9
        vcmpequh 3, 3, 9
        vcmpequh 2, 2, 9
        xxsel 33, 39, 44, 33
        xxsel 32, 40, 45, 32
        xxsel 35, 37, 46, 35
        xxsel 34, 38, 47, 34
        stxvd2x 35, 10, 3
        stxvd2x 34, 11, 3
        stxvd2x 33, 8, 3
        stxvd2x 32, 9, 3
        lxvd2x 44, 0, 3
        lxvd2x 45, 14, 3
        lxvd2x 46, 15, 3
        lxvd2x 47, 16, 3
        addi 3, 3, 64
        vsrh 1, 12, 10
        vsrh 0, 13, 10
        vsrh 3, 14, 10
        vsrh 2, 15, 10
        vadduhm 7, 12, 11
        vadduhm 8, 13, 11
        vadduhm 5, 14, 11
        vadduhm 6, 15, 11
        vcmpequh 1, 1, 9
        vcmpequh 0, 0, 9
        vcmpequh 3, 3, 9
        vcmpequh 2, 2, 9
        xxsel 33, 39, 44, 33
        xxsel 32, 40, 45, 32
        xxsel 35, 37, 46, 35
        xxsel 34, 38, 47, 34
        stxvd2x 35, 10, 3
        stxvd2x 34, 11, 3
        stxvd2x 33, 8, 3
        stxvd2x 32, 9, 3
        ld 14, 96(1)
        ld 15, 104(1)
        ld 16, 112(1)
        li 6, 128
        li 7, 144
        li 8, 160
        li 9, 176
        li 10, 192
        lxvd2x 52, 6, 1
        lxvd2x 53, 7, 1
        lxvd2x 54, 8, 1
        lxvd2x 55, 9, 1
        lxvd2x 56, 10, 1
        mtlr 0
        addi 1, 1, 224
        blr

MLK_ASM_FN_SIZE(reduce_ppc_asm)

#endif /* MLK_ARITH_BACKEND_PPC64LE_DEFAULT && !MLK_CONFIG_MULTILEVEL_NO_SHARED \
          && __POWER8_VECTOR__ */

#if defined(__ELF__)
.section .note.GNU-stack,"",%progbits
#endif
