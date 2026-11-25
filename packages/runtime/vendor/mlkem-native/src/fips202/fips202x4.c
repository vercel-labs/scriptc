/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

/* References
 * ==========
 *
 * - [FIPS203]
 *   FIPS 203 Module-Lattice-Based Key-Encapsulation Mechanism Standard
 *   National Institute of Standards and Technology
 *   https://csrc.nist.gov/pubs/fips/203/final
 */

#include "../common.h"
#if !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED)

#include "../verify.h"
#include "fips202.h"
#include "fips202x4.h"
#include "keccakf1600.h"

typedef mlk_shake128x4ctx mlk_shake256x4_ctx;

static void mlk_keccak_absorb_once_x4(uint64_t *s, unsigned r,
                                      const uint8_t *in0, const uint8_t *in1,
                                      const uint8_t *in2, const uint8_t *in3,
                                      size_t inlen, uint8_t p)
__contract__(
  requires(inlen <= MLK_MAX_BUFFER_SIZE)
  requires(memory_no_alias(s, sizeof(uint64_t) * MLK_KECCAK_LANES * MLK_KECCAK_WAY))
  requires(r > 0)
  requires(r <= sizeof(uint64_t) * MLK_KECCAK_LANES)
  requires(memory_no_alias(in0, inlen))
  requires(memory_no_alias(in1, inlen))
  requires(memory_no_alias(in2, inlen))
  requires(memory_no_alias(in3, inlen))
  assigns(memory_slice(s, sizeof(uint64_t) * MLK_KECCAK_LANES * MLK_KECCAK_WAY)))
{
  while (inlen >= r)
  __loop__(
    assigns(inlen, in0, in1, in2, in3, memory_slice(s, sizeof(uint64_t) * MLK_KECCAK_LANES * MLK_KECCAK_WAY))
    invariant(inlen <= loop_entry(inlen))
    invariant(in0 == loop_entry(in0) + (loop_entry(inlen) - inlen))
    invariant(in1 == loop_entry(in1) + (loop_entry(inlen) - inlen))
    invariant(in2 == loop_entry(in2) + (loop_entry(inlen) - inlen))
    invariant(in3 == loop_entry(in3) + (loop_entry(inlen) - inlen))
    decreases(inlen))
  {
    mlk_keccakf1600x4_xor_bytes(s, in0, in1, in2, in3, 0, r);
    mlk_keccakf1600x4_permute(s);

    in0 += r;
    in1 += r;
    in2 += r;
    in3 += r;
    inlen -= r;
  }

  /* At this point, inlen < r, so the truncations to unsigned are safe below. */

  if (inlen > 0)
  {
    mlk_keccakf1600x4_xor_bytes(s, in0, in1, in2, in3, 0, (unsigned int)inlen);
  }

  if (inlen == r - 1)
  {
    p |= 128;
    mlk_keccakf1600x4_xor_bytes(s, &p, &p, &p, &p, (unsigned int)inlen, 1);
  }
  else
  {
    mlk_keccakf1600x4_xor_bytes(s, &p, &p, &p, &p, (unsigned int)inlen, 1);
    p = 128;
    mlk_keccakf1600x4_xor_bytes(s, &p, &p, &p, &p, r - 1, 1);
  }
}

static void mlk_keccak_squeezeblocks_x4(uint8_t *out0, uint8_t *out1,
                                        uint8_t *out2, uint8_t *out3,
                                        size_t nblocks, uint64_t *s, unsigned r)
__contract__(
    requires(r <= sizeof(uint64_t) * MLK_KECCAK_LANES)
    requires(r == SHAKE128_RATE || r == SHAKE256_RATE)
    requires(nblocks <= (MLK_MAX_BUFFER_SIZE / SHAKE256_RATE))
    requires(memory_no_alias(s, sizeof(uint64_t) * MLK_KECCAK_LANES * MLK_KECCAK_WAY))
    requires(memory_no_alias(out0, nblocks * r))
    requires(memory_no_alias(out1, nblocks * r))
    requires(memory_no_alias(out2, nblocks * r))
    requires(memory_no_alias(out3, nblocks * r))
    assigns(memory_slice(s, sizeof(uint64_t) * MLK_KECCAK_LANES * MLK_KECCAK_WAY))
    assigns(memory_slice(out0, nblocks * r))
    assigns(memory_slice(out1, nblocks * r))
    assigns(memory_slice(out2, nblocks * r))
    assigns(memory_slice(out3, nblocks * r)))
{
  size_t current_offset = 0;
  while (nblocks > 0)
  __loop__(
    assigns(nblocks, current_offset,
            memory_slice(s, sizeof(uint64_t) * MLK_KECCAK_LANES * MLK_KECCAK_WAY),
            memory_slice(out0, nblocks * r),
            memory_slice(out1, nblocks * r),
            memory_slice(out2, nblocks * r),
            memory_slice(out3, nblocks * r))
    invariant(nblocks <= loop_entry(nblocks))
    invariant(current_offset == (loop_entry(nblocks) - nblocks) * r)
    decreases(nblocks))
  {
    mlk_keccakf1600x4_permute(s);
    mlk_keccakf1600x4_extract_bytes(
        s, &out0[current_offset], &out1[current_offset], &out2[current_offset],
        &out3[current_offset], 0, r);
    current_offset += r;
    nblocks--;
  }
}

void mlk_shake128x4_absorb_once(mlk_shake128x4ctx *state, const uint8_t *in0,
                                const uint8_t *in1, const uint8_t *in2,
                                const uint8_t *in3, size_t inlen)
{
  mlk_memset(state, 0, sizeof(mlk_shake128x4ctx));
  mlk_keccak_absorb_once_x4(state->ctx, SHAKE128_RATE, in0, in1, in2, in3,
                            inlen, 0x1F);
}

void mlk_shake128x4_squeezeblocks(uint8_t *out0, uint8_t *out1, uint8_t *out2,
                                  uint8_t *out3, size_t nblocks,
                                  mlk_shake128x4ctx *state)
{
  mlk_keccak_squeezeblocks_x4(out0, out1, out2, out3, nblocks, state->ctx,
                              SHAKE128_RATE);
}

void mlk_shake128x4_init(mlk_shake128x4ctx *state) { (void)state; }
void mlk_shake128x4_release(mlk_shake128x4ctx *state)
{
  /* Specification: Partially implements
   * @[FIPS203, Section 3.3, Destruction of intermediate values] */
  mlk_zeroize(state, sizeof(mlk_shake128x4ctx));
}

static void mlk_shake256x4_absorb_once(mlk_shake256x4_ctx *state,
                                       const uint8_t *in0, const uint8_t *in1,
                                       const uint8_t *in2, const uint8_t *in3,
                                       size_t inlen)
{
  mlk_memset(state, 0, sizeof(mlk_shake128x4ctx));
  mlk_keccak_absorb_once_x4(state->ctx, SHAKE256_RATE, in0, in1, in2, in3,
                            inlen, 0x1F);
}

static void mlk_shake256x4_squeezeblocks(uint8_t *out0, uint8_t *out1,
                                         uint8_t *out2, uint8_t *out3,
                                         size_t nblocks,
                                         mlk_shake256x4_ctx *state)
{
  mlk_keccak_squeezeblocks_x4(out0, out1, out2, out3, nblocks, state->ctx,
                              SHAKE256_RATE);
}

void mlk_shake256x4(uint8_t *out0, uint8_t *out1, uint8_t *out2, uint8_t *out3,
                    size_t outlen, const uint8_t *in0, const uint8_t *in1,
                    const uint8_t *in2, const uint8_t *in3, size_t inlen)
{
  mlk_shake256x4_ctx statex;
  size_t nblocks = outlen / SHAKE256_RATE;
  uint8_t tmp0[SHAKE256_RATE];
  uint8_t tmp1[SHAKE256_RATE];
  uint8_t tmp2[SHAKE256_RATE];
  uint8_t tmp3[SHAKE256_RATE];

  mlk_shake256x4_absorb_once(&statex, in0, in1, in2, in3, inlen);
  mlk_shake256x4_squeezeblocks(out0, out1, out2, out3, nblocks, &statex);

  out0 += nblocks * SHAKE256_RATE;
  out1 += nblocks * SHAKE256_RATE;
  out2 += nblocks * SHAKE256_RATE;
  out3 += nblocks * SHAKE256_RATE;

  outlen -= nblocks * SHAKE256_RATE;

  if (outlen)
  {
    mlk_shake256x4_squeezeblocks(tmp0, tmp1, tmp2, tmp3, 1, &statex);
    mlk_memcpy(out0, tmp0, outlen);
    mlk_memcpy(out1, tmp1, outlen);
    mlk_memcpy(out2, tmp2, outlen);
    mlk_memcpy(out3, tmp3, outlen);
  }

  /* Specification: Partially implements
   * @[FIPS203, Section 3.3, Destruction of intermediate values] */
  mlk_zeroize(&statex, sizeof(statex));
  mlk_zeroize(tmp0, sizeof(tmp0));
  mlk_zeroize(tmp1, sizeof(tmp1));
  mlk_zeroize(tmp2, sizeof(tmp2));
  mlk_zeroize(tmp3, sizeof(tmp3));
}

#else /* !MLK_CONFIG_MULTILEVEL_NO_SHARED */

MLK_EMPTY_CU(fips202x4)

#endif /* MLK_CONFIG_MULTILEVEL_NO_SHARED */
