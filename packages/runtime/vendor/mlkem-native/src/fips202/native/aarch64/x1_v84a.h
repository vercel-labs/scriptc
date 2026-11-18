/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

#ifndef MLK_FIPS202_NATIVE_AARCH64_X1_V84A_H
#define MLK_FIPS202_NATIVE_AARCH64_X1_V84A_H

#if !defined(__ARM_FEATURE_SHA3)
#error This backend can only be used if SHA3 extensions are available.
#endif

/* Part of backend API */
#define MLK_USE_NATIVE_FIPS202_X1
/* Guard for assembly file */
#define MLK_FIPS202_AARCH64_NEED_X1_V84A

#if !defined(__ASSEMBLER__)
#include "../api.h"
#include "src/fips202_native_aarch64.h"
MLK_MUST_CHECK_RETURN_VALUE
static MLK_INLINE int mlk_keccak_f1600_x1_native(uint64_t *state)
{
  if (!mlk_sys_check_capability(MLK_SYS_CAP_AARCH64_NEON) ||
      !mlk_sys_check_capability(MLK_SYS_CAP_AARCH64_SHA3))
  {
    return MLK_NATIVE_FUNC_FALLBACK;
  }

  mlk_keccak_f1600_x1_v84a_aarch64_asm(state, mlk_keccakf1600_round_constants);
  return MLK_NATIVE_FUNC_SUCCESS;
}
#endif /* !__ASSEMBLER__ */

#endif /* !MLK_FIPS202_NATIVE_AARCH64_X1_V84A_H */
