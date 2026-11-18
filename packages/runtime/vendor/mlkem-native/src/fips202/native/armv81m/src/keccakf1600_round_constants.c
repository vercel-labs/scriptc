/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

#include "../../../../common.h"

#if defined(MLK_FIPS202_ARMV81M_NEED_X4) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED)

#include "fips202_native_armv81m.h"

/*
 * Keccak round constants in bit-interleaved form.
 * Each 64-bit constant is split into two 32-bit words:
 * - low word contains even-indexed bits
 * - high word contains odd-indexed bits
 */
MLK_ALIGN MLK_INTERNAL_DATA_DEFINITION const uint32_t
    mlk_keccakf1600_round_constants[48] = {
        0x00000001, 0x00000000, /* RC0 */
        0x00000000, 0x00000089, /* RC1 */
        0x00000000, 0x8000008b, /* RC2 */
        0x00000000, 0x80008080, /* RC3 */
        0x00000001, 0x0000008b, /* RC4 */
        0x00000001, 0x00008000, /* RC5 */
        0x00000001, 0x80008088, /* RC6 */
        0x00000001, 0x80000082, /* RC7 */
        0x00000000, 0x0000000b, /* RC8 */
        0x00000000, 0x0000000a, /* RC9 */
        0x00000001, 0x00008082, /* RC10 */
        0x00000000, 0x00008003, /* RC11 */
        0x00000001, 0x0000808b, /* RC12 */
        0x00000001, 0x8000000b, /* RC13 */
        0x00000001, 0x8000008a, /* RC14 */
        0x00000001, 0x80000081, /* RC15 */
        0x00000000, 0x80000081, /* RC16 */
        0x00000000, 0x80000008, /* RC17 */
        0x00000000, 0x00000083, /* RC18 */
        0x00000000, 0x80008003, /* RC19 */
        0x00000001, 0x80008088, /* RC20 */
        0x00000000, 0x80000088, /* RC21 */
        0x00000001, 0x00008000, /* RC22 */
        0x00000000, 0x80008082, /* RC23 */
};

#else /* MLK_FIPS202_ARMV81M_NEED_X4 && !MLK_CONFIG_MULTILEVEL_NO_SHARED */

MLK_EMPTY_CU(fips202_armv81m_round_constants)

#endif /* !(MLK_FIPS202_ARMV81M_NEED_X4 && !MLK_CONFIG_MULTILEVEL_NO_SHARED) \
        */
