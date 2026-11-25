/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

/*
 * WARNING: This file is auto-generated from scripts/autogen
 *          in the mlkem-native repository.
 *          Do not modify it directly.
 */

#include "../../../../common.h"

#if (defined(MLK_FIPS202_AARCH64_NEED_X1_SCALAR) ||                  \
     defined(MLK_FIPS202_AARCH64_NEED_X1_V84A) ||                    \
     defined(MLK_FIPS202_AARCH64_NEED_X2_V84A) ||                    \
     defined(MLK_FIPS202_AARCH64_NEED_X4_V8A_SCALAR_HYBRID) ||       \
     defined(MLK_FIPS202_AARCH64_NEED_X4_V8A_V84A_SCALAR_HYBRID)) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED)

#include "fips202_native_aarch64.h"

MLK_ALIGN MLK_INTERNAL_DATA_DEFINITION const uint64_t
    mlk_keccakf1600_round_constants[24] = {
        0x0000000000000001, 0x0000000000008082, 0x800000000000808a,
        0x8000000080008000, 0x000000000000808b, 0x0000000080000001,
        0x8000000080008081, 0x8000000000008009, 0x000000000000008a,
        0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
        0x000000008000808b, 0x800000000000008b, 0x8000000000008089,
        0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
        0x000000000000800a, 0x800000008000000a, 0x8000000080008081,
        0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
};

#else /* (MLK_FIPS202_AARCH64_NEED_X1_SCALAR ||                               \
         MLK_FIPS202_AARCH64_NEED_X1_V84A || MLK_FIPS202_AARCH64_NEED_X2_V84A \
         || MLK_FIPS202_AARCH64_NEED_X4_V8A_SCALAR_HYBRID ||                  \
         MLK_FIPS202_AARCH64_NEED_X4_V8A_V84A_SCALAR_HYBRID) &&               \
         !MLK_CONFIG_MULTILEVEL_NO_SHARED */

MLK_EMPTY_CU(fips202_aarch64_round_constants)

#endif /* !((MLK_FIPS202_AARCH64_NEED_X1_SCALAR ||                             \
          MLK_FIPS202_AARCH64_NEED_X1_V84A || MLK_FIPS202_AARCH64_NEED_X2_V84A \
          || MLK_FIPS202_AARCH64_NEED_X4_V8A_SCALAR_HYBRID ||                  \
          MLK_FIPS202_AARCH64_NEED_X4_V8A_V84A_SCALAR_HYBRID) &&               \
          !MLK_CONFIG_MULTILEVEL_NO_SHARED) */
