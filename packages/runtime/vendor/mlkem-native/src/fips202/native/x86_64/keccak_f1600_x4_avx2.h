/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

#ifndef MLK_FIPS202_NATIVE_X86_64_KECCAK_F1600_X4_AVX2_H
#define MLK_FIPS202_NATIVE_X86_64_KECCAK_F1600_X4_AVX2_H

#include "../../../common.h"

#define MLK_FIPS202_X86_64_NEED_X4_AVX2

/* Part of backend API */
#define MLK_USE_NATIVE_FIPS202_X4

#if !defined(__ASSEMBLER__)
#include "../api.h"
#include "src/fips202_native_x86_64.h"
MLK_MUST_CHECK_RETURN_VALUE
static MLK_INLINE int mlk_keccak_f1600_x4_native(uint64_t *state)
{
  if (!mlk_sys_check_capability(MLK_SYS_CAP_X86_64_AVX2))
  {
    return MLK_NATIVE_FUNC_FALLBACK;
  }

  mlk_keccak_f1600_x4_avx2_asm(state, mlk_keccakf1600_round_constants,
                               mlk_keccak_rho8, mlk_keccak_rho56);
  return MLK_NATIVE_FUNC_SUCCESS;
}
#endif /* !__ASSEMBLER__ */

#endif /* !MLK_FIPS202_NATIVE_X86_64_KECCAK_F1600_X4_AVX2_H */
