/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */
#ifndef MLK_FIPS202_FIPS202X4_H
#define MLK_FIPS202_FIPS202X4_H


#include "../cbmc.h"
#include "../common.h"

#include "fips202.h"
#include "keccakf1600.h"

/** Context for the non-incremental 4-way SHAKE128 API. */
typedef struct
{
  uint64_t ctx[MLK_KECCAK_LANES *
               MLK_KECCAK_WAY]; /**< 4-way Keccak state, stored sequentially. */
} MLK_ALIGN mlk_shake128x4ctx;

#define mlk_shake128x4_absorb_once MLK_NAMESPACE(shake128x4_absorb_once)
void mlk_shake128x4_absorb_once(mlk_shake128x4ctx *state, const uint8_t *in0,
                                const uint8_t *in1, const uint8_t *in2,
                                const uint8_t *in3, size_t inlen)
__contract__(
  requires(inlen <= MLK_MAX_BUFFER_SIZE)
  requires(memory_no_alias(state, sizeof(mlk_shake128x4ctx)))
  requires(memory_no_alias(in0, inlen))
  requires(memory_no_alias(in1, inlen))
  requires(memory_no_alias(in2, inlen))
  requires(memory_no_alias(in3, inlen))
  assigns(memory_slice(state, sizeof(mlk_shake128x4ctx)))
);

#define mlk_shake128x4_squeezeblocks MLK_NAMESPACE(shake128x4_squeezeblocks)
void mlk_shake128x4_squeezeblocks(uint8_t *out0, uint8_t *out1, uint8_t *out2,
                                  uint8_t *out3, size_t nblocks,
                                  mlk_shake128x4ctx *state)
__contract__(
  requires(nblocks <= 8 /* somewhat arbitrary bound */)
  requires(memory_no_alias(state, sizeof(mlk_shake128x4ctx)))
  requires(memory_no_alias(out0, nblocks * SHAKE128_RATE))
  requires(memory_no_alias(out1, nblocks * SHAKE128_RATE))
  requires(memory_no_alias(out2, nblocks * SHAKE128_RATE))
  requires(memory_no_alias(out3, nblocks * SHAKE128_RATE))
  assigns(memory_slice(out0, nblocks * SHAKE128_RATE),
    memory_slice(out1, nblocks * SHAKE128_RATE),
    memory_slice(out2, nblocks * SHAKE128_RATE),
    memory_slice(out3, nblocks * SHAKE128_RATE),
    memory_slice(state, sizeof(mlk_shake128x4ctx)))
);

#define mlk_shake128x4_init MLK_NAMESPACE(shake128x4_init)
void mlk_shake128x4_init(mlk_shake128x4ctx *state);

#define mlk_shake128x4_release MLK_NAMESPACE(shake128x4_release)
void mlk_shake128x4_release(mlk_shake128x4ctx *state);

#define mlk_shake256x4 MLK_NAMESPACE(shake256x4)
void mlk_shake256x4(uint8_t *out0, uint8_t *out1, uint8_t *out2, uint8_t *out3,
                    size_t outlen, const uint8_t *in0, const uint8_t *in1,
                    const uint8_t *in2, const uint8_t *in3, size_t inlen)
__contract__(
  requires(inlen <= MLK_MAX_BUFFER_SIZE)
  requires(outlen <= MLK_MAX_BUFFER_SIZE)
  requires(memory_no_alias(in0, inlen))
  requires(memory_no_alias(in1, inlen))
  requires(memory_no_alias(in2, inlen))
  requires(memory_no_alias(in3, inlen))
  requires(memory_no_alias(out0, outlen))
  requires(memory_no_alias(out1, outlen))
  requires(memory_no_alias(out2, outlen))
  requires(memory_no_alias(out3, outlen))
  assigns(memory_slice(out0, outlen))
  assigns(memory_slice(out1, outlen))
  assigns(memory_slice(out2, outlen))
  assigns(memory_slice(out3, outlen))
);

#endif /* !MLK_FIPS202_FIPS202X4_H */
