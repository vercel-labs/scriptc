/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

/*yaml
  Name: poly_tomont_aarch64_asm
  Description: Convert polynomial to Montgomery domain
  Signature: void mlk_poly_tomont_aarch64_asm(int16_t p[256])
  ABI:
    Architecture: aarch64
    CallingConvention: AAPCS64
    Features: [NEON]
    x0:
      type: buffer
      size_bytes: 512
      permissions: read/write
      c_parameter: int16_t p[256]
      description: Input/output polynomial
  Stack:
    bytes: 0
*/

#include "../../../common.h"
#if defined(MLK_ARITH_BACKEND_AARCH64) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED) && \
    !defined(MLK_CONFIG_NO_KEYPAIR_API)

/*
 * WARNING: This file is auto-derived from the mlkem-native source file
 *   dev/aarch64_opt/src/mlkem_poly_tomont_aarch64_asm.S using scripts/simpasm. Do not modify it directly.
 */

.text
.balign 4
.global MLK_ASM_NAMESPACE(poly_tomont_aarch64_asm)
MLK_ASM_FN_SYMBOL(poly_tomont_aarch64_asm)

        .cfi_startproc
        mov w2, #0xd01              // =3329
        dup v4.8h, w2
        mov w2, #-0x414             // =-1044
        dup v2.8h, w2
        mov w2, #-0x2824            // =-10276
        dup v3.8h, w2
        mov x1, #0x8                // =8
        ldr q18, [x0, #0x20]
        ldr q0, [x0, #0x10]
        ldr q16, [x0], #0x40
        sqrdmulh v23.8h, v0.8h, v3.8h
        mul v26.8h, v0.8h, v2.8h
        sqrdmulh v19.8h, v16.8h, v3.8h
        mls v26.8h, v23.8h, v4.h[0]
        mul v29.8h, v16.8h, v2.8h
        ldur q16, [x0, #-0x10]
        mls v29.8h, v19.8h, v4.h[0]
        stur q26, [x0, #-0x30]
        sqrdmulh v26.8h, v18.8h, v3.8h
        mul v18.8h, v18.8h, v2.8h
        stur q29, [x0, #-0x40]
        sqrdmulh v29.8h, v16.8h, v3.8h
        mls v18.8h, v26.8h, v4.h[0]
        sub x1, x1, #0x1

Lmlk_poly_tomont_loop:
        ldr q19, [x0, #0x10]
        mul v26.8h, v16.8h, v2.8h
        ldr q23, [x0, #0x20]
        ldr q17, [x0], #0x40
        mls v26.8h, v29.8h, v4.h[0]
        ldur q16, [x0, #-0x10]
        sqrdmulh v28.8h, v19.8h, v3.8h
        stur q18, [x0, #-0x60]
        mul v0.8h, v19.8h, v2.8h
        stur q26, [x0, #-0x50]
        sqrdmulh v24.8h, v23.8h, v3.8h
        mul v18.8h, v23.8h, v2.8h
        sqrdmulh v22.8h, v17.8h, v3.8h
        mul v26.8h, v17.8h, v2.8h
        mls v0.8h, v28.8h, v4.h[0]
        mls v26.8h, v22.8h, v4.h[0]
        sqrdmulh v29.8h, v16.8h, v3.8h
        stur q0, [x0, #-0x30]
        mls v18.8h, v24.8h, v4.h[0]
        stur q26, [x0, #-0x40]
        sub x1, x1, #0x1
        cbnz x1, Lmlk_poly_tomont_loop
        mul v16.8h, v16.8h, v2.8h
        stur q18, [x0, #-0x20]
        mls v16.8h, v29.8h, v4.h[0]
        stur q16, [x0, #-0x10]
        ret
        .cfi_endproc

MLK_ASM_FN_SIZE(poly_tomont_aarch64_asm)

#endif /* MLK_ARITH_BACKEND_AARCH64 && !MLK_CONFIG_MULTILEVEL_NO_SHARED && \
          !MLK_CONFIG_NO_KEYPAIR_API */

#if defined(__ELF__)
.section .note.GNU-stack,"",%progbits
#endif
