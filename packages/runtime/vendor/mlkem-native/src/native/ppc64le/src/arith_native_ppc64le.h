/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */
#ifndef MLK_NATIVE_PPC64LE_SRC_ARITH_NATIVE_PPC64LE_H
#define MLK_NATIVE_PPC64LE_SRC_ARITH_NATIVE_PPC64LE_H

#include <stdint.h>
#include "../../../common.h"
#include "consts.h"

#define mlk_ntt_ppc_asm MLK_NAMESPACE(ntt_ppc_asm)
void mlk_ntt_ppc_asm(int16_t *, const int16_t *);

#define mlk_intt_ppc_asm MLK_NAMESPACE(intt_ppc_asm)
void mlk_intt_ppc_asm(int16_t *, const int16_t *);

#define mlk_reduce_ppc_asm MLK_NAMESPACE(reduce_ppc_asm)
void mlk_reduce_ppc_asm(int16_t *r, const int16_t *);

#define mlk_poly_tomont_ppc_asm MLK_NAMESPACE(poly_tomont_ppc_asm)
void mlk_poly_tomont_ppc_asm(int16_t *, const int16_t *);

#endif /* !MLK_NATIVE_PPC64LE_SRC_ARITH_NATIVE_PPC64LE_H */
