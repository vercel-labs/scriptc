/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */
#ifndef MLK_FIPS202_KECCAKF1600_H
#define MLK_FIPS202_KECCAKF1600_H
#include "../cbmc.h"
#include "../common.h"

#define MLK_KECCAK_LANES 25
#define MLK_KECCAK_WAY 4

/*
 * WARNING:
 * The contents of this structure, including the placement
 * and interleaving of Keccak lanes, are IMPLEMENTATION-DEFINED.
 * The struct is only exposed here to allow its construction on the stack.
 */

#define mlk_keccakf1600_extract_bytes MLK_NAMESPACE(keccakf1600_extract_bytes)
void mlk_keccakf1600_extract_bytes(uint64_t *state, unsigned char *data,
                                   unsigned offset, unsigned length)
__contract__(
    requires(0 <= offset && offset <= MLK_KECCAK_LANES * sizeof(uint64_t) &&
             0 <= length && length <= MLK_KECCAK_LANES * sizeof(uint64_t) - offset)
    requires(memory_no_alias(state, sizeof(uint64_t) * MLK_KECCAK_LANES))
    requires(memory_no_alias(data, length))
    assigns(memory_slice(data, length))
);

#define mlk_keccakf1600_xor_bytes MLK_NAMESPACE(keccakf1600_xor_bytes)
void mlk_keccakf1600_xor_bytes(uint64_t *state, const unsigned char *data,
                               unsigned offset, unsigned length)
__contract__(
    requires(0 <= offset && offset <= MLK_KECCAK_LANES * sizeof(uint64_t) &&
             0 <= length && length <= MLK_KECCAK_LANES * sizeof(uint64_t) - offset)
    requires(memory_no_alias(state, sizeof(uint64_t) * MLK_KECCAK_LANES))
    requires(memory_no_alias(data, length))
    assigns(memory_slice(state, sizeof(uint64_t) * MLK_KECCAK_LANES))
);

#define mlk_keccakf1600x4_extract_bytes \
  MLK_NAMESPACE(keccakf1600x4_extract_bytes)
void mlk_keccakf1600x4_extract_bytes(uint64_t *state, unsigned char *data0,
                                     unsigned char *data1, unsigned char *data2,
                                     unsigned char *data3, unsigned offset,
                                     unsigned length)
__contract__(
    requires(0 <= offset && offset <= MLK_KECCAK_LANES * sizeof(uint64_t) &&
             0 <= length && length <= MLK_KECCAK_LANES * sizeof(uint64_t) - offset)
    requires(memory_no_alias(state, sizeof(uint64_t) * MLK_KECCAK_LANES * MLK_KECCAK_WAY))
    requires(memory_no_alias(data0, length))
    requires(memory_no_alias(data1, length))
    requires(memory_no_alias(data2, length))
    requires(memory_no_alias(data3, length))
    assigns(memory_slice(data0, length))
    assigns(memory_slice(data1, length))
    assigns(memory_slice(data2, length))
    assigns(memory_slice(data3, length))
);

#define mlk_keccakf1600x4_xor_bytes MLK_NAMESPACE(keccakf1600x4_xor_bytes)
void mlk_keccakf1600x4_xor_bytes(uint64_t *state, const unsigned char *data0,
                                 const unsigned char *data1,
                                 const unsigned char *data2,
                                 const unsigned char *data3, unsigned offset,
                                 unsigned length)
__contract__(
    requires(0 <= offset && offset <= MLK_KECCAK_LANES * sizeof(uint64_t) &&
             0 <= length && length <= MLK_KECCAK_LANES * sizeof(uint64_t) - offset)
    requires(memory_no_alias(state, sizeof(uint64_t) * MLK_KECCAK_LANES * MLK_KECCAK_WAY))
    requires(memory_no_alias(data0, length))
    /* Case 1: all input buffers are distinct; Case 2: All input buffers are the same */
    requires((data0 == data1 &&
              data0 == data2 &&
              data0 == data3) ||
             (memory_no_alias(data1, length) &&
              memory_no_alias(data2, length) &&
              memory_no_alias(data3, length)))
    assigns(memory_slice(state, sizeof(uint64_t) * MLK_KECCAK_LANES * MLK_KECCAK_WAY))
);


#define mlk_keccakf1600x4_permute MLK_NAMESPACE(keccakf1600x4_permute)
void mlk_keccakf1600x4_permute(uint64_t *state)
__contract__(
    requires(memory_no_alias(state, sizeof(uint64_t) * MLK_KECCAK_LANES * MLK_KECCAK_WAY))
    assigns(memory_slice(state, sizeof(uint64_t) * MLK_KECCAK_LANES * MLK_KECCAK_WAY))
);

#define mlk_keccakf1600_permute MLK_NAMESPACE(keccakf1600_permute)
void mlk_keccakf1600_permute(uint64_t *state)
__contract__(
    requires(memory_no_alias(state, sizeof(uint64_t) * MLK_KECCAK_LANES))
    assigns(memory_slice(state, sizeof(uint64_t) * MLK_KECCAK_LANES))
);

#endif /* !MLK_FIPS202_KECCAKF1600_H */
