/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */
#ifndef MLK_FIPS202_NATIVE_ARMV81M_SRC_FIPS202_NATIVE_ARMV81M_H
#define MLK_FIPS202_NATIVE_ARMV81M_SRC_FIPS202_NATIVE_ARMV81M_H

#include "../../../../common.h"

/* Keccak round constants in bit-interleaved form */
#define mlk_keccakf1600_round_constants \
  MLK_NAMESPACE(keccakf1600_round_constants)
MLK_INTERNAL_DATA_DECLARATION const uint32_t
    mlk_keccakf1600_round_constants[48];

#define mlk_keccak_f1600_x4_mve_asm MLK_NAMESPACE(keccak_f1600_x4_mve_asm)
void mlk_keccak_f1600_x4_mve_asm(uint64_t state[100], uint64_t tmpstate[100],
                                 const uint32_t rc[48]);

#define mlk_keccak_f1600_x4_state_xor_bytes_asm \
  MLK_NAMESPACE(keccak_f1600_x4_state_xor_bytes_asm)
void mlk_keccak_f1600_x4_state_xor_bytes_asm(void *state, const uint8_t *d0,
                                             const uint8_t *d1,
                                             const uint8_t *d2,
                                             const uint8_t *d3, unsigned offset,
                                             unsigned length);

#define mlk_keccak_f1600_x4_state_extract_bytes_asm \
  MLK_NAMESPACE(keccak_f1600_x4_state_extract_bytes_asm)
void mlk_keccak_f1600_x4_state_extract_bytes_asm(void *state, uint8_t *data0,
                                                 uint8_t *data1, uint8_t *data2,
                                                 uint8_t *data3,
                                                 unsigned offset,
                                                 unsigned length);

#endif /* !MLK_FIPS202_NATIVE_ARMV81M_SRC_FIPS202_NATIVE_ARMV81M_H */
