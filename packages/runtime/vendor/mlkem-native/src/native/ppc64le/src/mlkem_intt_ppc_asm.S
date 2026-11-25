/*
 * Copyright (c) The mlkem-native project authors
 * Copyright (c) IBM Corp. 2025, 2026
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 *
 * Written by Danny Tsen <dtsen@us.ibm.com>
 */

#include "../../../common.h"
#if defined(MLK_ARITH_BACKEND_PPC64LE_DEFAULT) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED) && defined(__POWER8_VECTOR__) && \
    (!defined(MLK_CONFIG_NO_ENCAPS_API) || \
     !defined(MLK_CONFIG_NO_DECAPS_API))
/*yaml
  Name: intt_ppc_asm
  Description: PowerPC64 VSX inverse NTT
  Signature: void mlk_intt_ppc_asm(int16_t *r, const int16_t *qdata)
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
 *   dev/ppc64le/src/mlkem_intt_ppc_asm.S using scripts/simpasm. Do not modify it directly.
 */

.text
.balign 4
.global MLK_ASM_NAMESPACE(intt_ppc_asm)
MLK_ASM_FN_SYMBOL(intt_ppc_asm)

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
        lxvd2x 0, 0, 4
        xxlxor 35, 35, 35
        xxlor 3, 35, 35
        li 10, 16
        li 11, 32
        lxvd2x 6, 10, 4
        lxvd2x 32, 11, 4
        vspltisw 8, 13
        vadduwm 8, 8, 8
        xxlor 8, 40, 40
        vspltisw 9, 1
        vsubuwm 10, 8, 9
        vslw 9, 9, 10
        xxlor 7, 41, 41
        li 10, 16
        li 11, 32
        li 12, 48
        li 15, 64
        li 16, 80
        li 17, 96
        li 18, 112
        addi 14, 4, 48
        lvx 10, 0, 14
        addi 14, 4, 64
        lvx 11, 0, 14
        li 8, 4
        mtctr 8
        xxlor 37, 0, 0

mlk_intt_ppc_asm_Loopf:
        lxvd2x 57, 0, 3
        lxvd2x 58, 10, 3
        lxvd2x 62, 11, 3
        lxvd2x 63, 12, 3
        addi 3, 3, 64
        vmhraddshs 14, 25, 11, 3
        vmhraddshs 19, 26, 11, 3
        vmhraddshs 24, 30, 11, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 6, 25, 10, 3
        vmladduhm 7, 26, 10, 3
        vmladduhm 8, 30, 10, 3
        vmladduhm 9, 31, 10, 3
        vmladduhm 6, 14, 5, 6
        vmladduhm 7, 19, 5, 7
        vmladduhm 8, 24, 5, 8
        vmladduhm 9, 29, 5, 9
        lxvd2x 57, 0, 3
        lxvd2x 58, 10, 3
        lxvd2x 62, 11, 3
        lxvd2x 63, 12, 3
        addi 3, 3, 64
        vmhraddshs 14, 25, 11, 3
        vmhraddshs 19, 26, 11, 3
        vmhraddshs 24, 30, 11, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 10, 3
        vmladduhm 18, 26, 10, 3
        vmladduhm 23, 30, 10, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        addi 3, 3, -128
        stxvd2x 38, 0, 3
        stxvd2x 39, 10, 3
        stxvd2x 40, 11, 3
        stxvd2x 41, 12, 3
        stxvd2x 45, 15, 3
        stxvd2x 50, 16, 3
        stxvd2x 55, 17, 3
        stxvd2x 60, 18, 3
        addi 3, 3, 128
        bdnz mlk_intt_ppc_asm_Loopf
        addi 3, 3, -512
        nop
        nop
        ori 2, 2, 0
        addi 14, 4, 1120
        addi 22, 4, 3136
        li 7, 4
        mr 5, 3
        lxvd2x 57, 0, 5
        lxvd2x 58, 10, 5
        vmrgew 8, 25, 26
        vmrgow 21, 25, 26
        lxvd2x 57, 11, 5
        lxvd2x 58, 12, 5
        vmrgew 12, 25, 26
        vmrgow 22, 25, 26
        lxvd2x 57, 15, 5
        lxvd2x 58, 16, 5
        vmrgew 16, 25, 26
        vmrgow 23, 25, 26
        lxvd2x 57, 17, 5
        lxvd2x 58, 18, 5
        vmrgew 20, 25, 26
        vmrgow 24, 25, 26
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        xxlor 10, 36, 36
        xxlor 11, 41, 41
        xxlor 12, 45, 45
        xxlor 13, 49, 49
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        xxlor 46, 10, 10
        xxlor 51, 11, 11
        xxlor 56, 12, 12
        xxlor 61, 13, 13
        vmrgew 10, 13, 14
        vmrgow 11, 13, 14
        vmrgew 12, 18, 19
        vmrgow 13, 18, 19
        vmrgew 14, 23, 24
        vmrgow 15, 23, 24
        vmrgew 16, 28, 29
        vmrgow 17, 28, 29
        stxvd2x 42, 0, 5
        stxvd2x 43, 10, 5
        stxvd2x 44, 11, 5
        stxvd2x 45, 12, 5
        stxvd2x 46, 15, 5
        stxvd2x 47, 16, 5
        stxvd2x 48, 17, 5
        stxvd2x 49, 18, 5
        addi 5, 5, 128
        lxvd2x 57, 0, 5
        lxvd2x 58, 10, 5
        vmrgew 8, 25, 26
        vmrgow 21, 25, 26
        lxvd2x 57, 11, 5
        lxvd2x 58, 12, 5
        vmrgew 12, 25, 26
        vmrgow 22, 25, 26
        lxvd2x 57, 15, 5
        lxvd2x 58, 16, 5
        vmrgew 16, 25, 26
        vmrgow 23, 25, 26
        lxvd2x 57, 17, 5
        lxvd2x 58, 18, 5
        vmrgew 20, 25, 26
        vmrgow 24, 25, 26
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        xxlor 10, 36, 36
        xxlor 11, 41, 41
        xxlor 12, 45, 45
        xxlor 13, 49, 49
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        xxlor 46, 10, 10
        xxlor 51, 11, 11
        xxlor 56, 12, 12
        xxlor 61, 13, 13
        vmrgew 10, 13, 14
        vmrgow 11, 13, 14
        vmrgew 12, 18, 19
        vmrgow 13, 18, 19
        vmrgew 14, 23, 24
        vmrgow 15, 23, 24
        vmrgew 16, 28, 29
        vmrgow 17, 28, 29
        stxvd2x 42, 0, 5
        stxvd2x 43, 10, 5
        stxvd2x 44, 11, 5
        stxvd2x 45, 12, 5
        stxvd2x 46, 15, 5
        stxvd2x 47, 16, 5
        stxvd2x 48, 17, 5
        stxvd2x 49, 18, 5
        addi 5, 5, 128
        lxvd2x 57, 0, 5
        lxvd2x 58, 10, 5
        vmrgew 8, 25, 26
        vmrgow 21, 25, 26
        lxvd2x 57, 11, 5
        lxvd2x 58, 12, 5
        vmrgew 12, 25, 26
        vmrgow 22, 25, 26
        lxvd2x 57, 15, 5
        lxvd2x 58, 16, 5
        vmrgew 16, 25, 26
        vmrgow 23, 25, 26
        lxvd2x 57, 17, 5
        lxvd2x 58, 18, 5
        vmrgew 20, 25, 26
        vmrgow 24, 25, 26
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        xxlor 10, 36, 36
        xxlor 11, 41, 41
        xxlor 12, 45, 45
        xxlor 13, 49, 49
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        xxlor 46, 10, 10
        xxlor 51, 11, 11
        xxlor 56, 12, 12
        xxlor 61, 13, 13
        vmrgew 10, 13, 14
        vmrgow 11, 13, 14
        vmrgew 12, 18, 19
        vmrgow 13, 18, 19
        vmrgew 14, 23, 24
        vmrgow 15, 23, 24
        vmrgew 16, 28, 29
        vmrgow 17, 28, 29
        stxvd2x 42, 0, 5
        stxvd2x 43, 10, 5
        stxvd2x 44, 11, 5
        stxvd2x 45, 12, 5
        stxvd2x 46, 15, 5
        stxvd2x 47, 16, 5
        stxvd2x 48, 17, 5
        stxvd2x 49, 18, 5
        addi 5, 5, 128
        lxvd2x 57, 0, 5
        lxvd2x 58, 10, 5
        vmrgew 8, 25, 26
        vmrgow 21, 25, 26
        lxvd2x 57, 11, 5
        lxvd2x 58, 12, 5
        vmrgew 12, 25, 26
        vmrgow 22, 25, 26
        lxvd2x 57, 15, 5
        lxvd2x 58, 16, 5
        vmrgew 16, 25, 26
        vmrgow 23, 25, 26
        lxvd2x 57, 17, 5
        lxvd2x 58, 18, 5
        vmrgew 20, 25, 26
        vmrgow 24, 25, 26
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        xxlor 10, 36, 36
        xxlor 11, 41, 41
        xxlor 12, 45, 45
        xxlor 13, 49, 49
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        xxlor 46, 10, 10
        xxlor 51, 11, 11
        xxlor 56, 12, 12
        xxlor 61, 13, 13
        vmrgew 10, 13, 14
        vmrgow 11, 13, 14
        vmrgew 12, 18, 19
        vmrgow 13, 18, 19
        vmrgew 14, 23, 24
        vmrgow 15, 23, 24
        vmrgew 16, 28, 29
        vmrgow 17, 28, 29
        stxvd2x 42, 0, 5
        stxvd2x 43, 10, 5
        stxvd2x 44, 11, 5
        stxvd2x 45, 12, 5
        stxvd2x 46, 15, 5
        stxvd2x 47, 16, 5
        stxvd2x 48, 17, 5
        stxvd2x 49, 18, 5
        addi 5, 5, 128
        mr 5, 3
        li 7, 8
        lxvd2x 10, 0, 5
        lxvd2x 11, 10, 5
        xxmrgld 40, 11, 10
        xxmrghd 53, 11, 10
        lxvd2x 10, 11, 5
        lxvd2x 11, 12, 5
        xxmrgld 44, 11, 10
        xxmrghd 54, 11, 10
        lxvd2x 10, 15, 5
        lxvd2x 11, 16, 5
        xxmrgld 48, 11, 10
        xxmrghd 55, 11, 10
        lxvd2x 10, 17, 5
        lxvd2x 11, 18, 5
        xxmrgld 52, 11, 10
        xxmrghd 56, 11, 10
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        xxlor 10, 36, 36
        xxlor 11, 41, 41
        xxlor 12, 45, 45
        xxlor 13, 49, 49
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        xxlor 46, 10, 10
        xxlor 51, 11, 11
        xxlor 56, 12, 12
        xxlor 61, 13, 13
        xxmrgld 42, 46, 45
        xxmrghd 43, 46, 45
        xxmrgld 44, 51, 50
        xxmrghd 45, 51, 50
        xxmrgld 46, 56, 55
        xxmrghd 47, 56, 55
        xxmrgld 48, 61, 60
        xxmrghd 49, 61, 60
        stxvd2x 42, 0, 5
        stxvd2x 43, 10, 5
        stxvd2x 44, 11, 5
        stxvd2x 45, 12, 5
        stxvd2x 46, 15, 5
        stxvd2x 47, 16, 5
        stxvd2x 48, 17, 5
        stxvd2x 49, 18, 5
        addi 5, 5, 128
        lxvd2x 10, 0, 5
        lxvd2x 11, 10, 5
        xxmrgld 40, 11, 10
        xxmrghd 53, 11, 10
        lxvd2x 10, 11, 5
        lxvd2x 11, 12, 5
        xxmrgld 44, 11, 10
        xxmrghd 54, 11, 10
        lxvd2x 10, 15, 5
        lxvd2x 11, 16, 5
        xxmrgld 48, 11, 10
        xxmrghd 55, 11, 10
        lxvd2x 10, 17, 5
        lxvd2x 11, 18, 5
        xxmrgld 52, 11, 10
        xxmrghd 56, 11, 10
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        xxlor 10, 36, 36
        xxlor 11, 41, 41
        xxlor 12, 45, 45
        xxlor 13, 49, 49
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        xxlor 46, 10, 10
        xxlor 51, 11, 11
        xxlor 56, 12, 12
        xxlor 61, 13, 13
        xxmrgld 42, 46, 45
        xxmrghd 43, 46, 45
        xxmrgld 44, 51, 50
        xxmrghd 45, 51, 50
        xxmrgld 46, 56, 55
        xxmrghd 47, 56, 55
        xxmrgld 48, 61, 60
        xxmrghd 49, 61, 60
        stxvd2x 42, 0, 5
        stxvd2x 43, 10, 5
        stxvd2x 44, 11, 5
        stxvd2x 45, 12, 5
        stxvd2x 46, 15, 5
        stxvd2x 47, 16, 5
        stxvd2x 48, 17, 5
        stxvd2x 49, 18, 5
        addi 5, 5, 128
        lxvd2x 10, 0, 5
        lxvd2x 11, 10, 5
        xxmrgld 40, 11, 10
        xxmrghd 53, 11, 10
        lxvd2x 10, 11, 5
        lxvd2x 11, 12, 5
        xxmrgld 44, 11, 10
        xxmrghd 54, 11, 10
        lxvd2x 10, 15, 5
        lxvd2x 11, 16, 5
        xxmrgld 48, 11, 10
        xxmrghd 55, 11, 10
        lxvd2x 10, 17, 5
        lxvd2x 11, 18, 5
        xxmrgld 52, 11, 10
        xxmrghd 56, 11, 10
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        xxlor 10, 36, 36
        xxlor 11, 41, 41
        xxlor 12, 45, 45
        xxlor 13, 49, 49
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        xxlor 46, 10, 10
        xxlor 51, 11, 11
        xxlor 56, 12, 12
        xxlor 61, 13, 13
        xxmrgld 42, 46, 45
        xxmrghd 43, 46, 45
        xxmrgld 44, 51, 50
        xxmrghd 45, 51, 50
        xxmrgld 46, 56, 55
        xxmrghd 47, 56, 55
        xxmrgld 48, 61, 60
        xxmrghd 49, 61, 60
        stxvd2x 42, 0, 5
        stxvd2x 43, 10, 5
        stxvd2x 44, 11, 5
        stxvd2x 45, 12, 5
        stxvd2x 46, 15, 5
        stxvd2x 47, 16, 5
        stxvd2x 48, 17, 5
        stxvd2x 49, 18, 5
        addi 5, 5, 128
        lxvd2x 10, 0, 5
        lxvd2x 11, 10, 5
        xxmrgld 40, 11, 10
        xxmrghd 53, 11, 10
        lxvd2x 10, 11, 5
        lxvd2x 11, 12, 5
        xxmrgld 44, 11, 10
        xxmrghd 54, 11, 10
        lxvd2x 10, 15, 5
        lxvd2x 11, 16, 5
        xxmrgld 48, 11, 10
        xxmrghd 55, 11, 10
        lxvd2x 10, 17, 5
        lxvd2x 11, 18, 5
        xxmrgld 52, 11, 10
        xxmrghd 56, 11, 10
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        xxlor 10, 36, 36
        xxlor 11, 41, 41
        xxlor 12, 45, 45
        xxlor 13, 49, 49
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        xxlor 46, 10, 10
        xxlor 51, 11, 11
        xxlor 56, 12, 12
        xxlor 61, 13, 13
        xxmrgld 42, 46, 45
        xxmrghd 43, 46, 45
        xxmrgld 44, 51, 50
        xxmrghd 45, 51, 50
        xxmrgld 46, 56, 55
        xxmrghd 47, 56, 55
        xxmrgld 48, 61, 60
        xxmrghd 49, 61, 60
        stxvd2x 42, 0, 5
        stxvd2x 43, 10, 5
        stxvd2x 44, 11, 5
        stxvd2x 45, 12, 5
        stxvd2x 46, 15, 5
        stxvd2x 47, 16, 5
        stxvd2x 48, 17, 5
        stxvd2x 49, 18, 5
        addi 5, 5, 128
        nop
        ori 2, 2, 0
        li 7, 16
        li 9, 0
        add 10, 7, 9
        addi 16, 9, 32
        addi 17, 10, 32
        addi 18, 16, 32
        addi 19, 17, 32
        addi 20, 18, 32
        addi 21, 19, 32
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        li 9, 128
        add 10, 7, 9
        addi 16, 9, 32
        addi 17, 10, 32
        addi 18, 16, 32
        addi 19, 17, 32
        addi 20, 18, 32
        addi 21, 19, 32
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        li 9, 256
        add 10, 7, 9
        addi 16, 9, 32
        addi 17, 10, 32
        addi 18, 16, 32
        addi 19, 17, 32
        addi 20, 18, 32
        addi 21, 19, 32
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        li 9, 384
        add 10, 7, 9
        addi 16, 9, 32
        addi 17, 10, 32
        addi 18, 16, 32
        addi 19, 17, 32
        addi 20, 18, 32
        addi 21, 19, 32
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        nop
        nop
        ori 2, 2, 0
        li 7, 32
        li 9, 0
        add 10, 7, 9
        addi 16, 9, 64
        addi 17, 10, 64
        addi 18, 16, 64
        addi 19, 17, 64
        addi 20, 18, 64
        addi 21, 19, 64
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        addi 14, 14, -64
        addi 22, 22, -64
        li 9, 16
        add 10, 7, 9
        addi 16, 9, 64
        addi 17, 10, 64
        addi 18, 16, 64
        addi 19, 17, 64
        addi 20, 18, 64
        addi 21, 19, 64
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        li 9, 256
        add 10, 7, 9
        addi 16, 9, 64
        addi 17, 10, 64
        addi 18, 16, 64
        addi 19, 17, 64
        addi 20, 18, 64
        addi 21, 19, 64
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        addi 14, 14, -64
        addi 22, 22, -64
        li 9, 272
        add 10, 7, 9
        addi 16, 9, 64
        addi 17, 10, 64
        addi 18, 16, 64
        addi 19, 17, 64
        addi 20, 18, 64
        addi 21, 19, 64
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        li 8, 16
        li 11, 32
        li 12, 48
        lxvd2x 39, 0, 14
        lxvd2x 40, 8, 14
        lxvd2x 41, 11, 14
        lxvd2x 42, 12, 14
        lxvd2x 44, 0, 22
        lxvd2x 52, 8, 22
        lxvd2x 38, 11, 22
        lxvd2x 43, 12, 22
        addi 14, 14, 64
        addi 22, 22, 64
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 20, 3
        vmhraddshs 24, 30, 6, 3
        vmhraddshs 29, 31, 11, 3
        vmladduhm 13, 25, 7, 3
        vmladduhm 18, 26, 8, 3
        vmladduhm 23, 30, 9, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        nop
        nop
        ori 2, 2, 0
        li 7, 64
        li 9, 0
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        lvx 10, 0, 14
        lvx 12, 0, 22
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 12, 3
        vmhraddshs 24, 30, 12, 3
        vmhraddshs 29, 31, 12, 3
        vmladduhm 13, 25, 10, 3
        vmladduhm 18, 26, 10, 3
        vmladduhm 23, 30, 10, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
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
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        lvx 10, 0, 14
        lvx 12, 0, 22
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 12, 3
        vmhraddshs 24, 30, 12, 3
        vmhraddshs 29, 31, 12, 3
        vmladduhm 13, 25, 10, 3
        vmladduhm 18, 26, 10, 3
        vmladduhm 23, 30, 10, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
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
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        lvx 10, 0, 14
        lvx 12, 0, 22
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 12, 3
        vmhraddshs 24, 30, 12, 3
        vmhraddshs 29, 31, 12, 3
        vmladduhm 13, 25, 10, 3
        vmladduhm 18, 26, 10, 3
        vmladduhm 23, 30, 10, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
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
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        lvx 10, 0, 14
        lvx 12, 0, 22
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 12, 3
        vmhraddshs 24, 30, 12, 3
        vmhraddshs 29, 31, 12, 3
        vmladduhm 13, 25, 10, 3
        vmladduhm 18, 26, 10, 3
        vmladduhm 23, 30, 10, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        addi 14, 14, 16
        addi 22, 22, 16
        nop
        nop
        ori 2, 2, 0
        li 7, 128
        li 9, 0
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        lvx 10, 0, 14
        lvx 12, 0, 22
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 12, 3
        vmhraddshs 24, 30, 12, 3
        vmhraddshs 29, 31, 12, 3
        vmladduhm 13, 25, 10, 3
        vmladduhm 18, 26, 10, 3
        vmladduhm 23, 30, 10, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        li 9, 64
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        lvx 10, 0, 14
        lvx 12, 0, 22
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 12, 3
        vmhraddshs 24, 30, 12, 3
        vmhraddshs 29, 31, 12, 3
        vmladduhm 13, 25, 10, 3
        vmladduhm 18, 26, 10, 3
        vmladduhm 23, 30, 10, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
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
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        lvx 10, 0, 14
        lvx 12, 0, 22
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 12, 3
        vmhraddshs 24, 30, 12, 3
        vmhraddshs 29, 31, 12, 3
        vmladduhm 13, 25, 10, 3
        vmladduhm 18, 26, 10, 3
        vmladduhm 23, 30, 10, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        li 9, 320
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        lvx 10, 0, 14
        lvx 12, 0, 22
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 12, 3
        vmhraddshs 24, 30, 12, 3
        vmhraddshs 29, 31, 12, 3
        vmladduhm 13, 25, 10, 3
        vmladduhm 18, 26, 10, 3
        vmladduhm 23, 30, 10, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        addi 14, 14, 16
        addi 22, 22, 16
        nop
        nop
        ori 2, 2, 0
        li 7, 256
        li 9, 0
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        lvx 10, 0, 14
        lvx 12, 0, 22
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 12, 3
        vmhraddshs 24, 30, 12, 3
        vmhraddshs 29, 31, 12, 3
        vmladduhm 13, 25, 10, 3
        vmladduhm 18, 26, 10, 3
        vmladduhm 23, 30, 10, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        li 9, 64
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        lvx 10, 0, 14
        lvx 12, 0, 22
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 12, 3
        vmhraddshs 24, 30, 12, 3
        vmhraddshs 29, 31, 12, 3
        vmladduhm 13, 25, 10, 3
        vmladduhm 18, 26, 10, 3
        vmladduhm 23, 30, 10, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        li 9, 128
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        lvx 10, 0, 14
        lvx 12, 0, 22
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 12, 3
        vmhraddshs 24, 30, 12, 3
        vmhraddshs 29, 31, 12, 3
        vmladduhm 13, 25, 10, 3
        vmladduhm 18, 26, 10, 3
        vmladduhm 23, 30, 10, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
        li 9, 192
        add 10, 7, 9
        addi 16, 9, 16
        addi 17, 10, 16
        addi 18, 16, 16
        addi 19, 17, 16
        addi 20, 18, 16
        addi 21, 19, 16
        lxvd2x 40, 3, 10
        lxvd2x 44, 3, 17
        lxvd2x 48, 3, 19
        lxvd2x 52, 3, 21
        lxvd2x 53, 3, 9
        lxvd2x 54, 3, 16
        lxvd2x 55, 3, 18
        lxvd2x 56, 3, 20
        vsubuhm 25, 8, 21
        vsubuhm 26, 12, 22
        vsubuhm 30, 16, 23
        vsubuhm 31, 20, 24
        vadduhm 8, 8, 21
        vadduhm 12, 12, 22
        vadduhm 16, 16, 23
        vadduhm 20, 20, 24
        vxor 7, 7, 7
        xxlor 35, 6, 6
        xxlor 33, 7, 7
        xxlor 34, 8, 8
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
        stxvd2x 36, 3, 9
        stxvd2x 41, 3, 16
        stxvd2x 45, 3, 18
        stxvd2x 49, 3, 20
        xxlor 37, 0, 0
        xxlor 35, 3, 3
        lvx 10, 0, 14
        lvx 12, 0, 22
        vmhraddshs 14, 25, 12, 3
        vmhraddshs 19, 26, 12, 3
        vmhraddshs 24, 30, 12, 3
        vmhraddshs 29, 31, 12, 3
        vmladduhm 13, 25, 10, 3
        vmladduhm 18, 26, 10, 3
        vmladduhm 23, 30, 10, 3
        vmladduhm 28, 31, 10, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 28, 29, 5, 28
        stxvd2x 45, 3, 10
        stxvd2x 50, 3, 17
        stxvd2x 55, 3, 19
        stxvd2x 60, 3, 21
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

MLK_ASM_FN_SIZE(intt_ppc_asm)

#endif /* MLK_ARITH_BACKEND_PPC64LE_DEFAULT && !MLK_CONFIG_MULTILEVEL_NO_SHARED \
          && __POWER8_VECTOR__ && (!MLK_CONFIG_NO_ENCAPS_API || \
          !MLK_CONFIG_NO_DECAPS_API) */

#if defined(__ELF__)
.section .note.GNU-stack,"",%progbits
#endif
