/*
 * Copyright (c) The mlkem-native project authors
 * Copyright (c) IBM Corp. 2025, 2026
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 *
 * Written by Danny Tsen <dtsen@us.ibm.com>
 */

/*
 * Poly_tomont: Inplace conversion of all coefficients of a polynomial
 *              from normal domain to Montgomery domain
 *
 * Arguments:*r: pointer to input/output polynomial
 */

#include "../../../common.h"
#if defined(MLK_ARITH_BACKEND_PPC64LE_DEFAULT) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED) && defined(__POWER8_VECTOR__) && \
    !defined(MLK_CONFIG_NO_KEYPAIR_API)
/*yaml
  Name: poly_tomont_ppc_asm
  Description: PowerPC64 VSX conversion to Montgomery form
  Signature: void mlk_poly_tomont_ppc_asm(int16_t *r, const int16_t *qdata)
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
 *   dev/ppc64le/src/mlkem_poly_tomont_ppc_asm.S using scripts/simpasm. Do not modify it directly.
 */

.text
.balign 4
.global MLK_ASM_NAMESPACE(poly_tomont_ppc_asm)
MLK_ASM_FN_SYMBOL(poly_tomont_ppc_asm)

        stdu 1, -320(1)
        mflr 0
        li 6, 128
        li 7, 144
        li 8, 160
        li 9, 176
        li 10, 192
        li 11, 208
        li 12, 224
        stxvd2x 52, 6, 1
        stxvd2x 53, 7, 1
        stxvd2x 54, 8, 1
        stxvd2x 55, 9, 1
        stxvd2x 56, 10, 1
        stxvd2x 57, 11, 1
        stxvd2x 58, 12, 1
        li 6, 240
        li 7, 256
        li 8, 272
        li 9, 288
        stxvd2x 59, 6, 1
        stxvd2x 60, 7, 1
        stxvd2x 61, 8, 1
        stxvd2x 62, 9, 1
        li 6, 0
        li 7, 80
        li 8, 96
        lxvd2x 37, 6, 4
        lxvd2x 32, 7, 4
        lxvd2x 34, 8, 4
        vxor 3, 3, 3
        li 4, -128
        li 5, -112
        li 6, -96
        li 7, -80
        li 8, -64
        li 9, -48
        li 10, -32
        li 11, -16
        lxvd2x 45, 0, 3
        addi 3, 3, 16
        lxvd2x 50, 0, 3
        addi 3, 3, 16
        lxvd2x 55, 0, 3
        addi 3, 3, 16
        lxvd2x 39, 0, 3
        addi 3, 3, 16
        vmhraddshs 14, 13, 2, 3
        vmhraddshs 19, 18, 2, 3
        vmhraddshs 24, 23, 2, 3
        vmhraddshs 8, 7, 2, 3
        vmladduhm 13, 13, 0, 3
        vmladduhm 18, 18, 0, 3
        vmladduhm 23, 23, 0, 3
        vmladduhm 7, 7, 0, 3
        vmladduhm 27, 14, 5, 13
        vmladduhm 28, 19, 5, 18
        vmladduhm 29, 24, 5, 23
        vmladduhm 30, 8, 5, 7
        lxvd2x 45, 0, 3
        addi 3, 3, 16
        lxvd2x 50, 0, 3
        addi 3, 3, 16
        lxvd2x 55, 0, 3
        addi 3, 3, 16
        lxvd2x 39, 0, 3
        addi 3, 3, 16
        vmhraddshs 14, 13, 2, 3
        vmhraddshs 19, 18, 2, 3
        vmhraddshs 24, 23, 2, 3
        vmhraddshs 8, 7, 2, 3
        vmladduhm 13, 13, 0, 3
        vmladduhm 18, 18, 0, 3
        vmladduhm 23, 23, 0, 3
        vmladduhm 7, 7, 0, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 7, 8, 5, 7
        stxvd2x 59, 4, 3
        stxvd2x 60, 5, 3
        stxvd2x 61, 6, 3
        stxvd2x 62, 7, 3
        stxvd2x 45, 8, 3
        stxvd2x 50, 9, 3
        stxvd2x 55, 10, 3
        stxvd2x 39, 11, 3
        lxvd2x 45, 0, 3
        addi 3, 3, 16
        lxvd2x 50, 0, 3
        addi 3, 3, 16
        lxvd2x 55, 0, 3
        addi 3, 3, 16
        lxvd2x 39, 0, 3
        addi 3, 3, 16
        vmhraddshs 14, 13, 2, 3
        vmhraddshs 19, 18, 2, 3
        vmhraddshs 24, 23, 2, 3
        vmhraddshs 8, 7, 2, 3
        vmladduhm 13, 13, 0, 3
        vmladduhm 18, 18, 0, 3
        vmladduhm 23, 23, 0, 3
        vmladduhm 7, 7, 0, 3
        vmladduhm 27, 14, 5, 13
        vmladduhm 28, 19, 5, 18
        vmladduhm 29, 24, 5, 23
        vmladduhm 30, 8, 5, 7
        lxvd2x 45, 0, 3
        addi 3, 3, 16
        lxvd2x 50, 0, 3
        addi 3, 3, 16
        lxvd2x 55, 0, 3
        addi 3, 3, 16
        lxvd2x 39, 0, 3
        addi 3, 3, 16
        vmhraddshs 14, 13, 2, 3
        vmhraddshs 19, 18, 2, 3
        vmhraddshs 24, 23, 2, 3
        vmhraddshs 8, 7, 2, 3
        vmladduhm 13, 13, 0, 3
        vmladduhm 18, 18, 0, 3
        vmladduhm 23, 23, 0, 3
        vmladduhm 7, 7, 0, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 7, 8, 5, 7
        stxvd2x 59, 4, 3
        stxvd2x 60, 5, 3
        stxvd2x 61, 6, 3
        stxvd2x 62, 7, 3
        stxvd2x 45, 8, 3
        stxvd2x 50, 9, 3
        stxvd2x 55, 10, 3
        stxvd2x 39, 11, 3
        lxvd2x 45, 0, 3
        addi 3, 3, 16
        lxvd2x 50, 0, 3
        addi 3, 3, 16
        lxvd2x 55, 0, 3
        addi 3, 3, 16
        lxvd2x 39, 0, 3
        addi 3, 3, 16
        vmhraddshs 14, 13, 2, 3
        vmhraddshs 19, 18, 2, 3
        vmhraddshs 24, 23, 2, 3
        vmhraddshs 8, 7, 2, 3
        vmladduhm 13, 13, 0, 3
        vmladduhm 18, 18, 0, 3
        vmladduhm 23, 23, 0, 3
        vmladduhm 7, 7, 0, 3
        vmladduhm 27, 14, 5, 13
        vmladduhm 28, 19, 5, 18
        vmladduhm 29, 24, 5, 23
        vmladduhm 30, 8, 5, 7
        lxvd2x 45, 0, 3
        addi 3, 3, 16
        lxvd2x 50, 0, 3
        addi 3, 3, 16
        lxvd2x 55, 0, 3
        addi 3, 3, 16
        lxvd2x 39, 0, 3
        addi 3, 3, 16
        vmhraddshs 14, 13, 2, 3
        vmhraddshs 19, 18, 2, 3
        vmhraddshs 24, 23, 2, 3
        vmhraddshs 8, 7, 2, 3
        vmladduhm 13, 13, 0, 3
        vmladduhm 18, 18, 0, 3
        vmladduhm 23, 23, 0, 3
        vmladduhm 7, 7, 0, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 7, 8, 5, 7
        stxvd2x 59, 4, 3
        stxvd2x 60, 5, 3
        stxvd2x 61, 6, 3
        stxvd2x 62, 7, 3
        stxvd2x 45, 8, 3
        stxvd2x 50, 9, 3
        stxvd2x 55, 10, 3
        stxvd2x 39, 11, 3
        lxvd2x 45, 0, 3
        addi 3, 3, 16
        lxvd2x 50, 0, 3
        addi 3, 3, 16
        lxvd2x 55, 0, 3
        addi 3, 3, 16
        lxvd2x 39, 0, 3
        addi 3, 3, 16
        vmhraddshs 14, 13, 2, 3
        vmhraddshs 19, 18, 2, 3
        vmhraddshs 24, 23, 2, 3
        vmhraddshs 8, 7, 2, 3
        vmladduhm 13, 13, 0, 3
        vmladduhm 18, 18, 0, 3
        vmladduhm 23, 23, 0, 3
        vmladduhm 7, 7, 0, 3
        vmladduhm 27, 14, 5, 13
        vmladduhm 28, 19, 5, 18
        vmladduhm 29, 24, 5, 23
        vmladduhm 30, 8, 5, 7
        lxvd2x 45, 0, 3
        addi 3, 3, 16
        lxvd2x 50, 0, 3
        addi 3, 3, 16
        lxvd2x 55, 0, 3
        addi 3, 3, 16
        lxvd2x 39, 0, 3
        addi 3, 3, 16
        vmhraddshs 14, 13, 2, 3
        vmhraddshs 19, 18, 2, 3
        vmhraddshs 24, 23, 2, 3
        vmhraddshs 8, 7, 2, 3
        vmladduhm 13, 13, 0, 3
        vmladduhm 18, 18, 0, 3
        vmladduhm 23, 23, 0, 3
        vmladduhm 7, 7, 0, 3
        vmladduhm 13, 14, 5, 13
        vmladduhm 18, 19, 5, 18
        vmladduhm 23, 24, 5, 23
        vmladduhm 7, 8, 5, 7
        stxvd2x 59, 4, 3
        stxvd2x 60, 5, 3
        stxvd2x 61, 6, 3
        stxvd2x 62, 7, 3
        stxvd2x 45, 8, 3
        stxvd2x 50, 9, 3
        stxvd2x 55, 10, 3
        stxvd2x 39, 11, 3
        li 6, 128
        li 7, 144
        li 8, 160
        li 9, 176
        li 10, 192
        li 11, 208
        li 12, 224
        lxvd2x 52, 6, 1
        lxvd2x 53, 7, 1
        lxvd2x 54, 8, 1
        lxvd2x 55, 9, 1
        lxvd2x 56, 10, 1
        lxvd2x 57, 11, 1
        lxvd2x 58, 12, 1
        li 6, 240
        li 7, 256
        li 8, 272
        li 9, 288
        lxvd2x 59, 6, 1
        lxvd2x 60, 7, 1
        lxvd2x 61, 8, 1
        lxvd2x 62, 9, 1
        mtlr 0
        addi 1, 1, 320
        blr

MLK_ASM_FN_SIZE(poly_tomont_ppc_asm)

#endif /* MLK_ARITH_BACKEND_PPC64LE_DEFAULT && !MLK_CONFIG_MULTILEVEL_NO_SHARED \
          && __POWER8_VECTOR__ && !MLK_CONFIG_NO_KEYPAIR_API */

#if defined(__ELF__)
.section .note.GNU-stack,"",%progbits
#endif
