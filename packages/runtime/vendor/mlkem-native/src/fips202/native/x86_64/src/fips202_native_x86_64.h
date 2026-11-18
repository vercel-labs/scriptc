/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

#ifndef MLK_FIPS202_NATIVE_X86_64_SRC_FIPS202_NATIVE_X86_64_H
#define MLK_FIPS202_NATIVE_X86_64_SRC_FIPS202_NATIVE_X86_64_H

#include "../../../../cbmc.h"
#include "../../../../common.h"

/* TODO: Reconsider whether this check is needed -- x86_64 is always
 * little-endian, so the backend selection already implies this. */
#ifndef MLK_SYS_LITTLE_ENDIAN
#error Expecting a little-endian platform
#endif

#define mlk_keccakf1600_round_constants \
  MLK_NAMESPACE(keccakf1600_round_constants)
MLK_INTERNAL_DATA_DECLARATION const uint64_t
    mlk_keccakf1600_round_constants[24];

#define mlk_keccak_rho8 MLK_NAMESPACE(keccak_rho8)
MLK_INTERNAL_DATA_DECLARATION const uint64_t mlk_keccak_rho8[4];

#define mlk_keccak_rho56 MLK_NAMESPACE(keccak_rho56)
MLK_INTERNAL_DATA_DECLARATION const uint64_t mlk_keccak_rho56[4];

#define mlk_keccak_f1600_x4_avx2_asm MLK_NAMESPACE(keccak_f1600_x4_avx2_asm)
MLK_SYSV_ABI
void mlk_keccak_f1600_x4_avx2_asm(uint64_t states[100], const uint64_t rc[24],
                                  const uint64_t rho8[4],
                                  const uint64_t rho56[4])
/* This must be kept in sync with the HOL-Light specification
 * in proofs/hol_light/x86_64/proofs/keccak_f1600_x4_avx2_asm.ml */
__contract__(
  requires(memory_no_alias(states, sizeof(uint64_t) * 25 * 4))
  requires(rc == mlk_keccakf1600_round_constants)
  requires(rho8 == mlk_keccak_rho8)
  requires(rho56 == mlk_keccak_rho56)
  assigns(memory_slice(states, sizeof(uint64_t) * 25 * 4))
);

#endif /* !MLK_FIPS202_NATIVE_X86_64_SRC_FIPS202_NATIVE_X86_64_H */
