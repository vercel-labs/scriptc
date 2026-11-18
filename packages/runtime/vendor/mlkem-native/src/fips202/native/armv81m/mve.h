/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

#ifndef MLK_FIPS202_NATIVE_ARMV81M_MVE_H
#define MLK_FIPS202_NATIVE_ARMV81M_MVE_H

#define MLK_FIPS202_NATIVE_ARMV81M

/* Part of backend API */
#define MLK_USE_NATIVE_FIPS202_X4
#define MLK_USE_NATIVE_FIPS202_X4_XOR_BYTES
#define MLK_USE_NATIVE_FIPS202_X4_EXTRACT_BYTES
/* Guard for assembly file */
#define MLK_FIPS202_ARMV81M_NEED_X4

#if !defined(__ASSEMBLER__)
#include "../api.h"
#include "src/fips202_native_armv81m.h"

/*
 * Native x4 permutation
 * State is kept in bit-interleaved format.
 */
#define mlk_keccak_f1600_x4_native_impl \
  MLK_NAMESPACE(keccak_f1600_x4_native_impl)
int mlk_keccak_f1600_x4_native_impl(uint64_t *state);

MLK_MUST_CHECK_RETURN_VALUE
static MLK_INLINE int mlk_keccak_f1600_x4_native(uint64_t *state)
{
  return mlk_keccak_f1600_x4_native_impl(state);
}

/*
 * Native x4 XOR bytes (with on-the-fly bit interleaving)
 */
MLK_MUST_CHECK_RETURN_VALUE
static MLK_INLINE int mlk_keccakf1600_xor_bytes_x4_native(
    uint64_t *state, const uint8_t *data0, const uint8_t *data1,
    const uint8_t *data2, const uint8_t *data3, unsigned offset,
    unsigned length)
{
  mlk_keccak_f1600_x4_state_xor_bytes_asm(state, data0, data1, data2, data3,
                                          offset, length);
  return MLK_NATIVE_FUNC_SUCCESS;
}

/*
 * Native x4 extract bytes (with on-the-fly bit de-interleaving)
 */
MLK_MUST_CHECK_RETURN_VALUE
static MLK_INLINE int mlk_keccakf1600_extract_bytes_x4_native(
    uint64_t *state, uint8_t *data0, uint8_t *data1, uint8_t *data2,
    uint8_t *data3, unsigned offset, unsigned length)
{
  mlk_keccak_f1600_x4_state_extract_bytes_asm(state, data0, data1, data2, data3,
                                              offset, length);
  return MLK_NATIVE_FUNC_SUCCESS;
}

#endif /* !__ASSEMBLER__ */

#endif /* !MLK_FIPS202_NATIVE_ARMV81M_MVE_H */
