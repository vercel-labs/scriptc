/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

#ifndef MLK_FIPS202_NATIVE_API_H
#define MLK_FIPS202_NATIVE_API_H
/*
 * FIPS-202 native interface
 *
 * This header is primarily for documentation purposes.
 * It should not be included by backend implementations.
 */

#include "../../cbmc.h"

/* Backends must return MLK_NATIVE_FUNC_SUCCESS upon success. */
#define MLK_NATIVE_FUNC_SUCCESS (0)
/* Backends may return MLK_NATIVE_FUNC_FALLBACK to signal to the frontend that
 * the target/parameters are unsupported; typically, this would be because of
 * dependencies on CPU features not detected on the host CPU. In this case,
 * the frontend falls back to the default C implementation. */
#define MLK_NATIVE_FUNC_FALLBACK (-1)

/*
 * This is the C<->native interface allowing for the drop-in
 * of custom Keccak-F1600 implementations.
 *
 * A _backend_ is a specific implementation of parts of this interface.
 *
 * You can replace 1-fold or 4-fold batched Keccak-F1600.
 * To enable, set MLK_USE_NATIVE_FIPS202_X1 or MLK_USE_NATIVE_FIPS202_X4
 * in your backend, and define the inline wrappers mlk_keccak_f1600_x1_native()
 * and/or mlk_keccak_f1600_x4_native(), respectively, to forward to your
 * implementation.
 */

#if defined(MLK_USE_NATIVE_FIPS202_X1)
MLK_MUST_CHECK_RETURN_VALUE
static MLK_INLINE int mlk_keccak_f1600_x1_native(uint64_t *state)
__contract__(
  requires(memory_no_alias(state, sizeof(uint64_t) * 25 * 1))
  assigns(memory_slice(state, sizeof(uint64_t) * 25 * 1))
  ensures(return_value == MLK_NATIVE_FUNC_FALLBACK || return_value == MLK_NATIVE_FUNC_SUCCESS)
  ensures((return_value == MLK_NATIVE_FUNC_FALLBACK) ==> array_unchanged_u64(state, 25 * 1)));
#endif /* MLK_USE_NATIVE_FIPS202_X1 */
#if defined(MLK_USE_NATIVE_FIPS202_X4)
MLK_MUST_CHECK_RETURN_VALUE
static MLK_INLINE int mlk_keccak_f1600_x4_native(uint64_t *state)
__contract__(
  requires(memory_no_alias(state, sizeof(uint64_t) * 25 * 4))
  assigns(memory_slice(state, sizeof(uint64_t) * 25 * 4))
  ensures(return_value == MLK_NATIVE_FUNC_FALLBACK || return_value == MLK_NATIVE_FUNC_SUCCESS)
  ensures((return_value == MLK_NATIVE_FUNC_FALLBACK) ==> array_unchanged_u64(state, 25 * 4)));
#endif /* MLK_USE_NATIVE_FIPS202_X4 */

/*
 * Native x4 XOR bytes and extract bytes interface.
 *
 * These functions allow backends to provide optimized implementations for
 * XORing input data into the state and extracting output data from the state.
 * This is particularly useful for backends that use a different internal state
 * representation (e.g., bit-interleaved), as conversion can happen during
 * XOR/extract rather than before/after each permutation.
 *
 * NOTE: We assume that the custom representation of the zero state is the
 * all-zero state.
 *
 * MLK_USE_NATIVE_FIPS202_X4_XOR_BYTES: Backend provides native XOR bytes
 * MLK_USE_NATIVE_FIPS202_X4_EXTRACT_BYTES: Backend provides native extract
 * bytes
 */

#if defined(MLK_USE_NATIVE_FIPS202_X4_XOR_BYTES)
MLK_MUST_CHECK_RETURN_VALUE
static MLK_INLINE int mlk_keccakf1600_xor_bytes_x4_native(
    uint64_t *state, const unsigned char *data0, const unsigned char *data1,
    const unsigned char *data2, const unsigned char *data3, unsigned offset,
    unsigned length)
__contract__(
  requires(0 <= offset && offset <= 25 * sizeof(uint64_t) &&
           0 <= length && length <= 25 * sizeof(uint64_t) - offset)
  requires(memory_no_alias(state, sizeof(uint64_t) * 25 * 4))
  requires(memory_no_alias(data0, length))
  requires((data0 == data1 &&
            data0 == data2 &&
            data0 == data3) ||
           (memory_no_alias(data1, length) &&
            memory_no_alias(data2, length) &&
            memory_no_alias(data3, length)))
  assigns(memory_slice(state, sizeof(uint64_t) * 25 * 4))
  ensures(return_value == MLK_NATIVE_FUNC_FALLBACK || return_value == MLK_NATIVE_FUNC_SUCCESS)
  ensures((return_value == MLK_NATIVE_FUNC_FALLBACK) ==> array_unchanged_u64(state, 25 * 4)));
#endif /* MLK_USE_NATIVE_FIPS202_X4_XOR_BYTES */

#if defined(MLK_USE_NATIVE_FIPS202_X4_EXTRACT_BYTES)
MLK_MUST_CHECK_RETURN_VALUE
static MLK_INLINE int mlk_keccakf1600_extract_bytes_x4_native(
    uint64_t *state, unsigned char *data0, unsigned char *data1,
    unsigned char *data2, unsigned char *data3, unsigned offset,
    unsigned length)
__contract__(
  requires(0 <= offset && offset <= 25 * sizeof(uint64_t) &&
           0 <= length && length <= 25 * sizeof(uint64_t) - offset)
  requires(memory_no_alias(state, sizeof(uint64_t) * 25 * 4))
  requires(memory_no_alias(data0, length))
  requires(memory_no_alias(data1, length))
  requires(memory_no_alias(data2, length))
  requires(memory_no_alias(data3, length))
  assigns(memory_slice(data0, length))
  assigns(memory_slice(data1, length))
  assigns(memory_slice(data2, length))
  assigns(memory_slice(data3, length))
  ensures(return_value == MLK_NATIVE_FUNC_FALLBACK || return_value == MLK_NATIVE_FUNC_SUCCESS));
#endif /* MLK_USE_NATIVE_FIPS202_X4_EXTRACT_BYTES */

#endif /* !MLK_FIPS202_NATIVE_API_H */
