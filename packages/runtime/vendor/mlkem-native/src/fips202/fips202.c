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
 *
 * - [mupq]
 *   Common files for pqm4, pqm3, pqriscv
 *   Kannwischer, Petri, Rijneveld, Schwabe, Stoffelen
 *   https://github.com/mupq/mupq
 *
 * - [supercop]
 *   SUPERCOP benchmarking framework
 *   Daniel J. Bernstein
 *   http://bench.cr.yp.to/supercop.html
 *
 * - [tweetfips]
 *   'tweetfips202' FIPS202 implementation
 *   Van Assche, Bernstein, Schwabe
 *   https://keccak.team/2015/tweetfips202.html
 */

/* Based on the CC0 implementation from @[mupq] and the public domain
 * implementation @[supercop, crypto_hash/keccakc512/simple/]
 * by Ronny Van Keer, and the public domain @[tweetfips] implementation. */

#include "../common.h"
#if !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED)


#include "../verify.h"
#include "fips202.h"
#include "keccakf1600.h"

/**
 * Absorb step of Keccak; non-incremental, starts by zeroeing the state.
 *
 * @warning Must only be called once.
 *
 * @param[out] s    Pointer to (uninitialized) output Keccak state.
 * @param      r    Rate in bytes (e.g., 168 for SHAKE128).
 * @param[in]  m    Input to be absorbed into @p s.
 * @param      mlen Length of input in bytes.
 * @param      p    Domain-separation byte for different Keccak-derived
 *                  functions.
 */
static void mlk_keccak_absorb_once(uint64_t *s, unsigned r, const uint8_t *m,
                                   size_t mlen, uint8_t p)
__contract__(
    requires(mlen <= MLK_MAX_BUFFER_SIZE)
    requires(r > 0)
    requires(r <= sizeof(uint64_t) * MLK_KECCAK_LANES)
    requires(memory_no_alias(s, sizeof(uint64_t) * MLK_KECCAK_LANES))
    requires(memory_no_alias(m, mlen))
    assigns(memory_slice(s, sizeof(uint64_t) * MLK_KECCAK_LANES)))
{
  /* Initialize state */
  size_t i;
  for (i = 0; i < 25; ++i)
  __loop__(invariant(i <= 25)
           decreases(25 - i))
  {
    s[i] = 0;
  }

  while (mlen >= r)
  __loop__(
    assigns(mlen, m, memory_slice(s, sizeof(uint64_t) * MLK_KECCAK_LANES))
    invariant(mlen <= loop_entry(mlen))
    invariant(m == loop_entry(m) + (loop_entry(mlen) - mlen))
    decreases(mlen))
  {
    mlk_keccakf1600_xor_bytes(s, m, 0, r);
    mlk_keccakf1600_permute(s);
    mlen -= r;
    m += r;
  }

  /* At this point, mlen < r, so the truncations to unsigned are safe below. */

  if (mlen > 0)
  {
    mlk_keccakf1600_xor_bytes(s, m, 0, (unsigned int)mlen);
  }

  if (mlen == r - 1)
  {
    p |= 128;
    mlk_keccakf1600_xor_bytes(s, &p, (unsigned int)mlen, 1);
  }
  else
  {
    mlk_keccakf1600_xor_bytes(s, &p, (unsigned int)mlen, 1);
    p = 128;
    mlk_keccakf1600_xor_bytes(s, &p, r - 1, 1);
  }
}

/**
 * Block-level Keccak squeeze.
 *
 * @param[out]    h       Output bytes.
 * @param         nblocks Number of blocks to be squeezed.
 * @param[in,out] s       Input/output state.
 * @param         r       Rate in bytes (e.g., 168 for SHAKE128).
 */
static void mlk_keccak_squeezeblocks(uint8_t *h, size_t nblocks, uint64_t *s,
                                     unsigned r)
__contract__(
    requires(r <= sizeof(uint64_t) * MLK_KECCAK_LANES)
    requires(nblocks <= 8 /* somewhat arbitrary bound */)
    requires(memory_no_alias(s, sizeof(uint64_t) * MLK_KECCAK_LANES))
    requires(memory_no_alias(h, nblocks * r))
    assigns(memory_slice(s, sizeof(uint64_t) * MLK_KECCAK_LANES))
    assigns(memory_slice(h, nblocks * r)))
{
  while (nblocks > 0)
  __loop__(
    assigns(h, nblocks,
      memory_slice(s, sizeof(uint64_t) * MLK_KECCAK_LANES),
      memory_slice(h, nblocks * r))
    invariant(nblocks <= loop_entry(nblocks) &&
      h == loop_entry(h) + r * (loop_entry(nblocks) - nblocks))
    decreases(nblocks))
  {
    mlk_keccakf1600_permute(s);
    mlk_keccakf1600_extract_bytes(s, h, 0, r);
    h += r;
    nblocks--;
  }
}

/**
 * Keccak squeeze; can be called on byte-level.
 *
 * @warning Must only be called once.
 *
 * @param[out]    h      Output bytes.
 * @param         outlen Number of bytes to be squeezed.
 * @param[in,out] s      Keccak state.
 * @param         r      Rate in bytes (e.g., 168 for SHAKE128).
 */
static void mlk_keccak_squeeze_once(uint8_t *h, size_t outlen, uint64_t *s,
                                    unsigned r)
__contract__(
    requires(outlen <= MLK_MAX_BUFFER_SIZE)
    requires(r > 0)
    requires(r <= sizeof(uint64_t) * MLK_KECCAK_LANES)
    requires(memory_no_alias(s, sizeof(uint64_t) * MLK_KECCAK_LANES))
    requires(memory_no_alias(h, outlen))
    assigns(memory_slice(s, sizeof(uint64_t) * MLK_KECCAK_LANES))
    assigns(memory_slice(h, outlen)))
{
  size_t len;
  while (outlen > 0)
  __loop__(
    assigns(len, h, outlen,
      memory_slice(s, sizeof(uint64_t) * MLK_KECCAK_LANES),
      memory_slice(h, outlen))
    invariant(outlen <= loop_entry(outlen) &&
      h == loop_entry(h) + (loop_entry(outlen) - outlen))
    decreases(outlen))
  {
    mlk_keccakf1600_permute(s);

    if (outlen < r)
    {
      len = outlen;
    }
    else
    {
      len = r;
    }
    mlk_keccakf1600_extract_bytes(s, h, 0, (unsigned int)len);
    h += len;
    outlen -= len;
  }
}

void mlk_shake128_absorb_once(mlk_shake128ctx *state, const uint8_t *input,
                              size_t inlen)
{
  mlk_keccak_absorb_once(state->ctx, SHAKE128_RATE, input, inlen, 0x1F);
}

void mlk_shake128_squeezeblocks(uint8_t *output, size_t nblocks,
                                mlk_shake128ctx *state)
{
  mlk_keccak_squeezeblocks(output, nblocks, state->ctx, SHAKE128_RATE);
}

void mlk_shake128_init(mlk_shake128ctx *state) { (void)state; }
void mlk_shake128_release(mlk_shake128ctx *state)
{
  /* Specification: Partially implements
   * @[FIPS203, Section 3.3, Destruction of intermediate values] */
  mlk_zeroize(state, sizeof(mlk_shake128ctx));
}

typedef mlk_shake128ctx mlk_shake256ctx;
void mlk_shake256(uint8_t *output, size_t outlen, const uint8_t *input,
                  size_t inlen)
{
  mlk_shake256ctx state;
  /* Absorb input */
  mlk_keccak_absorb_once(state.ctx, SHAKE256_RATE, input, inlen, 0x1F);
  /* Squeeze output */
  mlk_keccak_squeeze_once(output, outlen, state.ctx, SHAKE256_RATE);
  /* Specification: Partially implements
   * @[FIPS203, Section 3.3, Destruction of intermediate values] */
  mlk_zeroize(&state, sizeof(state));
}

void mlk_sha3_256(uint8_t *output, const uint8_t *input, size_t inlen)
{
  uint64_t ctx[25];
  /* Absorb input */
  mlk_keccak_absorb_once(ctx, SHA3_256_RATE, input, inlen, 0x06);
  /* Squeeze output */
  mlk_keccak_squeeze_once(output, 32, ctx, SHA3_256_RATE);
  /* Specification: Partially implements
   * @[FIPS203, Section 3.3, Destruction of intermediate values] */
  mlk_zeroize(ctx, sizeof(ctx));
}

void mlk_sha3_512(uint8_t *output, const uint8_t *input, size_t inlen)
{
  uint64_t ctx[25];
  /* Absorb input */
  mlk_keccak_absorb_once(ctx, SHA3_512_RATE, input, inlen, 0x06);
  /* Squeeze output */
  mlk_keccak_squeeze_once(output, 64, ctx, SHA3_512_RATE);
  /* Specification: Partially implements
   * @[FIPS203, Section 3.3, Destruction of intermediate values] */
  mlk_zeroize(ctx, sizeof(ctx));
}

#else /* !MLK_CONFIG_MULTILEVEL_NO_SHARED */

MLK_EMPTY_CU(fips202)

#endif /* MLK_CONFIG_MULTILEVEL_NO_SHARED */
