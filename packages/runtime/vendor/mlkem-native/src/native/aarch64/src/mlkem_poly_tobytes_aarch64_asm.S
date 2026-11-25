/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

/*yaml
  Name: poly_tobytes_aarch64_asm
  Description: Convert polynomial to byte representation
  Signature: void mlk_poly_tobytes_aarch64_asm(uint8_t r[384], const int16_t a[256])
  ABI:
    Architecture: aarch64
    CallingConvention: AAPCS64
    Features: [NEON]
    x0:
      type: buffer
      size_bytes: 384
      permissions: write-only
      c_parameter: uint8_t r[384]
      description: Output byte array
    x1:
      type: buffer
      size_bytes: 512
      permissions: read-only
      c_parameter: const int16_t a[256]
      description: Input polynomial
  Stack:
    bytes: 0
*/

#include "../../../common.h"
#if defined(MLK_ARITH_BACKEND_AARCH64) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED) && \
    (!defined(MLK_CONFIG_NO_KEYPAIR_API) || \
     !defined(MLK_CONFIG_NO_ENCAPS_API))

/*
 * WARNING: This file is auto-derived from the mlkem-native source file
 *   dev/aarch64_opt/src/mlkem_poly_tobytes_aarch64_asm.S using scripts/simpasm. Do not modify it directly.
 */

.text
.balign 4
.global MLK_ASM_NAMESPACE(poly_tobytes_aarch64_asm)
MLK_ASM_FN_SYMBOL(poly_tobytes_aarch64_asm)

        .cfi_startproc
        mov x2, #0x10               // =16
        ldr q5, [x1, #0x10]
        ldr q3, [x1], #0x20
        ldr q29, [x1], #0x20
        ldur q2, [x1, #-0x10]
        ldr q27, [x1, #0x10]
        ldr q23, [x1, #0x30]
        ldr q17, [x1], #0x20
        ldr q16, [x1], #0x20
        uzp2 v26.8h, v3.8h, v5.8h
        uzp1 v19.8h, v3.8h, v5.8h
        uzp2 v0.8h, v29.8h, v2.8h
        uzp1 v1.8h, v29.8h, v2.8h
        xtn v5.8b, v26.8h
        shrn v3.8b, v19.8h, #0x8
        shrn v4.8b, v26.8h, #0x4
        xtn v18.8b, v0.8h
        shrn v30.8b, v0.8h, #0x4
        xtn v28.8b, v1.8h
        shrn v29.8b, v1.8h, #0x8
        sli v3.8b, v5.8b, #0x4
        xtn v2.8b, v19.8h
        sli v29.8b, v18.8b, #0x4
        lsr x2, x2, #1
        sub x2, x2, #0x2

Lmlk_poly_tobytes_loop_start:
        uzp1 v25.8h, v17.8h, v27.8h
        uzp2 v31.8h, v17.8h, v27.8h
        uzp1 v24.8h, v16.8h, v23.8h
        uzp2 v6.8h, v16.8h, v23.8h
        st3 { v2.8b, v3.8b, v4.8b }, [x0], #24
        shrn v3.8b, v25.8h, #0x8
        ldr q17, [x1], #0x20
        shrn v4.8b, v31.8h, #0x4
        xtn v21.8b, v6.8h
        ldr q23, [x1, #0x10]
        st3 { v28.8b, v29.8b, v30.8b }, [x0], #24
        shrn v29.8b, v24.8h, #0x8
        ldur q27, [x1, #-0x10]
        xtn v20.8b, v31.8h
        ldr q16, [x1], #0x20
        sli v29.8b, v21.8b, #0x4
        xtn v2.8b, v25.8h
        sli v3.8b, v20.8b, #0x4
        xtn v28.8b, v24.8h
        shrn v30.8b, v6.8h, #0x4
        subs x2, x2, #0x1
        cbnz x2, Lmlk_poly_tobytes_loop_start
        uzp2 v7.8h, v17.8h, v27.8h
        uzp1 v25.8h, v17.8h, v27.8h
        uzp2 v0.8h, v16.8h, v23.8h
        st3 { v2.8b, v3.8b, v4.8b }, [x0], #24
        st3 { v28.8b, v29.8b, v30.8b }, [x0], #24
        shrn v21.8b, v25.8h, #0x8
        uzp1 v2.8h, v16.8h, v23.8h
        shrn v22.8b, v7.8h, #0x4
        shrn v4.8b, v0.8h, #0x4
        xtn v28.8b, v7.8h
        xtn v27.8b, v0.8h
        shrn v3.8b, v2.8h, #0x8
        sli v21.8b, v28.8b, #0x4
        xtn v2.8b, v2.8h
        sli v3.8b, v27.8b, #0x4
        xtn v20.8b, v25.8h
        st3 { v20.8b, v21.8b, v22.8b }, [x0], #24
        st3 { v2.8b, v3.8b, v4.8b }, [x0], #24
        ret
        .cfi_endproc

MLK_ASM_FN_SIZE(poly_tobytes_aarch64_asm)

#endif /* MLK_ARITH_BACKEND_AARCH64 && !MLK_CONFIG_MULTILEVEL_NO_SHARED && \
          (!MLK_CONFIG_NO_KEYPAIR_API || !MLK_CONFIG_NO_ENCAPS_API) */

#if defined(__ELF__)
.section .note.GNU-stack,"",%progbits
#endif
