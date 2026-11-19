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

#ifndef MLK_INDCPA_H
#define MLK_INDCPA_H

#include "cbmc.h"
#include "common.h"
#include "poly_k.h"

#define mlk_gen_matrix MLK_NAMESPACE_K(gen_matrix)
/**
 * Deterministically generate matrix A (or the transpose of A) from a seed.
 * Entries of the matrix are polynomials that look uniformly random.
 * Performs rejection sampling on the output of an XOF.
 *
 * @spec{Implements @[FIPS203, Algorithm 13 (K-PKE.KeyGen), L3-7] and
 * @[FIPS203, Algorithm 14 (K-PKE.Encrypt), L4-8]. The @p transposed
 * parameter only affects internal presentation.}
 *
 * @param[out] a          Output matrix A.
 * @param[in]  seed       Input seed.
 * @param      transposed Boolean deciding whether A or A^T is generated.
 */
MLK_INTERNAL_API
void mlk_gen_matrix(mlk_polymat *a, const uint8_t seed[MLKEM_SYMBYTES],
                    int transposed)
__contract__(
  requires(memory_no_alias(a, sizeof(mlk_polymat)))
  requires(memory_no_alias(seed, MLKEM_SYMBYTES))
  requires(transposed == 0 || transposed == 1)
  assigns(memory_slice(a, sizeof(mlk_polymat)))
  ensures(forall(x, 0, MLKEM_K, forall(y, 0, MLKEM_K,
  array_bound(a->vec[x].vec[y].coeffs, 0, MLKEM_N, 0, MLKEM_Q))))
);

#if !defined(MLK_CONFIG_NO_KEYPAIR_API)
#define mlk_indcpa_keypair_derand \
  MLK_NAMESPACE_K(indcpa_keypair_derand) MLK_CONTEXT_PARAMETERS_3
/**
 * Generate public and private key for the CPA-secure public-key encryption
 * scheme underlying ML-KEM.
 *
 * @spec{Implements @[FIPS203, Algorithm 13 (K-PKE.KeyGen)].}
 *
 * @param[out] pk      Output public key
 *                     (length MLKEM_INDCPA_PUBLICKEYBYTES bytes).
 * @param[out] sk      Output private key
 *                     (length MLKEM_INDCPA_SECRETKEYBYTES bytes).
 * @param[in]  coins   Input randomness (length MLKEM_SYMBYTES bytes).
 * @param      context Application context. Only present when
 *                     MLK_CONFIG_CONTEXT_PARAMETER is defined; type set by
 *                     MLK_CONFIG_CONTEXT_PARAMETER_TYPE.
 *
 * @retval 0                     Success.
 * @retval MLK_ERR_OUT_OF_MEMORY MLK_CONFIG_CUSTOM_ALLOC_FREE was used and
 *                               MLK_CUSTOM_ALLOC returned NULL.
 */
MLK_INTERNAL_API
MLK_MUST_CHECK_RETURN_VALUE
int mlk_indcpa_keypair_derand(uint8_t pk[MLKEM_INDCPA_PUBLICKEYBYTES],
                              uint8_t sk[MLKEM_INDCPA_SECRETKEYBYTES],
                              const uint8_t coins[MLKEM_SYMBYTES],
                              MLK_CONFIG_CONTEXT_PARAMETER_TYPE context)
__contract__(
  requires(memory_no_alias(pk, MLKEM_INDCPA_PUBLICKEYBYTES))
  requires(memory_no_alias(sk, MLKEM_INDCPA_SECRETKEYBYTES))
  requires(memory_no_alias(coins, MLKEM_SYMBYTES))
  assigns(memory_slice(pk, MLKEM_INDCPA_PUBLICKEYBYTES))
  assigns(memory_slice(sk, MLKEM_INDCPA_SECRETKEYBYTES))
  ensures(return_value == 0 || return_value == MLK_ERR_OUT_OF_MEMORY)
  /* Output buffers on error, per API-CONVENTIONS.md */
  ensures(return_value != 0 ==>
          array_unchanged_or_zeroized_u8(pk, MLKEM_INDCPA_PUBLICKEYBYTES))
  ensures(return_value != 0 ==>
          array_unchanged_or_zeroized_u8(sk, MLKEM_INDCPA_SECRETKEYBYTES))
);
#endif /* !MLK_CONFIG_NO_KEYPAIR_API */

#if !defined(MLK_CONFIG_NO_ENCAPS_API) || !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_indcpa_enc MLK_NAMESPACE_K(indcpa_enc) MLK_CONTEXT_PARAMETERS_4
/**
 * Encryption function of the CPA-secure public-key encryption scheme
 * underlying ML-KEM.
 *
 * @spec{Implements @[FIPS203, Algorithm 14 (K-PKE.Encrypt)].}
 *
 * @param[out] c       Output ciphertext (length MLKEM_INDCPA_BYTES bytes).
 * @param[in]  m       Input message (length MLKEM_INDCPA_MSGBYTES bytes).
 * @param[in]  pk      Input public key
 *                     (length MLKEM_INDCPA_PUBLICKEYBYTES bytes).
 * @param[in]  coins   Input random coins used as seed (length MLKEM_SYMBYTES
 *                     bytes) to deterministically generate all randomness.
 * @param      context Application context. Only present when
 *                     MLK_CONFIG_CONTEXT_PARAMETER is defined; type set by
 *                     MLK_CONFIG_CONTEXT_PARAMETER_TYPE.
 *
 * @retval 0                     Success.
 * @retval MLK_ERR_OUT_OF_MEMORY MLK_CONFIG_CUSTOM_ALLOC_FREE was used and
 *                               MLK_CUSTOM_ALLOC returned NULL.
 */
MLK_INTERNAL_API
MLK_MUST_CHECK_RETURN_VALUE
int mlk_indcpa_enc(uint8_t c[MLKEM_INDCPA_BYTES],
                   const uint8_t m[MLKEM_INDCPA_MSGBYTES],
                   const uint8_t pk[MLKEM_INDCPA_PUBLICKEYBYTES],
                   const uint8_t coins[MLKEM_SYMBYTES],
                   MLK_CONFIG_CONTEXT_PARAMETER_TYPE context)
__contract__(
  requires(memory_no_alias(c, MLKEM_INDCPA_BYTES))
  requires(memory_no_alias(m, MLKEM_INDCPA_MSGBYTES))
  requires(memory_no_alias(pk, MLKEM_INDCPA_PUBLICKEYBYTES))
  requires(memory_no_alias(coins, MLKEM_SYMBYTES))
  assigns(memory_slice(c, MLKEM_INDCPA_BYTES))
  ensures(return_value == 0 || return_value == MLK_ERR_OUT_OF_MEMORY)
  /* Output buffers on error, per API-CONVENTIONS.md */
  ensures(return_value != 0 ==>
          array_unchanged_or_zeroized_u8(c, MLKEM_INDCPA_BYTES))
);
#endif /* !MLK_CONFIG_NO_ENCAPS_API || !MLK_CONFIG_NO_DECAPS_API */

#if !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_indcpa_dec MLK_NAMESPACE_K(indcpa_dec) MLK_CONTEXT_PARAMETERS_3
/**
 * Decryption function of the CPA-secure public-key encryption scheme
 * underlying ML-KEM.
 *
 * @spec{Implements @[FIPS203, Algorithm 15 (K-PKE.Decrypt)].}
 *
 * @param[out] m       Output decrypted message
 *                     (length MLKEM_INDCPA_MSGBYTES bytes).
 * @param[in]  c       Input ciphertext (length MLKEM_INDCPA_BYTES bytes).
 * @param[in]  sk      Input secret key
 *                     (length MLKEM_INDCPA_SECRETKEYBYTES bytes).
 * @param      context Application context. Only present when
 *                     MLK_CONFIG_CONTEXT_PARAMETER is defined; type set by
 *                     MLK_CONFIG_CONTEXT_PARAMETER_TYPE.
 *
 * @retval 0                     Success.
 * @retval MLK_ERR_OUT_OF_MEMORY MLK_CONFIG_CUSTOM_ALLOC_FREE was used and
 *                               MLK_CUSTOM_ALLOC returned NULL.
 */
MLK_INTERNAL_API
MLK_MUST_CHECK_RETURN_VALUE
int mlk_indcpa_dec(uint8_t m[MLKEM_INDCPA_MSGBYTES],
                   const uint8_t c[MLKEM_INDCPA_BYTES],
                   const uint8_t sk[MLKEM_INDCPA_SECRETKEYBYTES],
                   MLK_CONFIG_CONTEXT_PARAMETER_TYPE context)
__contract__(
  requires(memory_no_alias(c, MLKEM_INDCPA_BYTES))
  requires(memory_no_alias(m, MLKEM_INDCPA_MSGBYTES))
  requires(memory_no_alias(sk, MLKEM_INDCPA_SECRETKEYBYTES))
  assigns(memory_slice(m, MLKEM_INDCPA_MSGBYTES))
  ensures(return_value == 0 || return_value == MLK_ERR_OUT_OF_MEMORY)
  /* Output buffers on error, per API-CONVENTIONS.md */
  ensures(return_value != 0 ==>
          array_unchanged_or_zeroized_u8(m, MLKEM_INDCPA_MSGBYTES))
);
#endif /* !MLK_CONFIG_NO_DECAPS_API */

#endif /* !MLK_INDCPA_H */
