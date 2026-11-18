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
 * - [REF]
 *   CRYSTALS-Kyber C reference implementation
 *   Bos, Ducas, Kiltz, Lepoint, Lyubashevsky, Schanck, Schwabe, Seiler, Stehlé
 *   https://github.com/pq-crystals/kyber/tree/main/ref
 */

#ifndef MLK_KEM_H
#define MLK_KEM_H

#include "cbmc.h"
#include "common.h"
#include "sys.h"

#if defined(MLK_CHECK_APIS)
/* Include to ensure consistency between internal kem.h
 * and external mlkem_native.h. */
#include "mlkem_native.h"

#if MLKEM_INDCCA_SECRETKEYBYTES != \
    MLKEM_SECRETKEYBYTES(MLK_CONFIG_PARAMETER_SET)
#error Mismatch for SECRETKEYBYTES between kem.h and mlkem_native.h
#endif

#if MLKEM_INDCCA_PUBLICKEYBYTES != \
    MLKEM_PUBLICKEYBYTES(MLK_CONFIG_PARAMETER_SET)
#error Mismatch for PUBLICKEYBYTES between kem.h and mlkem_native.h
#endif

#if MLKEM_INDCCA_CIPHERTEXTBYTES != \
    MLKEM_CIPHERTEXTBYTES(MLK_CONFIG_PARAMETER_SET)
#error Mismatch for CIPHERTEXTBYTES between kem.h and mlkem_native.h
#endif

#endif /* MLK_CHECK_APIS */

#if !defined(MLK_CONFIG_NO_KEYPAIR_API)
#define mlk_kem_keypair_derand \
  MLK_NAMESPACE_K(keypair_derand) MLK_CONTEXT_PARAMETERS_3
#if !defined(MLK_CONFIG_NO_RANDOMIZED_API)
#define mlk_kem_keypair MLK_NAMESPACE_K(keypair) MLK_CONTEXT_PARAMETERS_2
#endif
#endif /* !MLK_CONFIG_NO_KEYPAIR_API */
#if !defined(MLK_CONFIG_NO_ENCAPS_API)
#define mlk_kem_enc_derand MLK_NAMESPACE_K(enc_derand) MLK_CONTEXT_PARAMETERS_4
#if !defined(MLK_CONFIG_NO_RANDOMIZED_API)
#define mlk_kem_enc MLK_NAMESPACE_K(enc) MLK_CONTEXT_PARAMETERS_3
#endif
#define mlk_kem_check_pk MLK_NAMESPACE_K(check_pk) MLK_CONTEXT_PARAMETERS_1
#endif /* !MLK_CONFIG_NO_ENCAPS_API */
#if !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_kem_dec MLK_NAMESPACE_K(dec) MLK_CONTEXT_PARAMETERS_3
#define mlk_kem_check_sk MLK_NAMESPACE_K(check_sk) MLK_CONTEXT_PARAMETERS_1
#endif

/**
 * Implements modulus check mandated by FIPS 203, i.e., ensures that
 * coefficients are in [0,q-1].
 *
 * @spec{Implements @[FIPS203, Section 7.2, 'modulus check'].}
 *
 * @reference{Not implemented in the reference implementation @[REF].}
 *
 * @param[in] pk      Input public key (an already allocated array of
 *                    MLKEM_INDCCA_PUBLICKEYBYTES bytes).
 * @param     context Application context. Only present when
 *                    MLK_CONFIG_CONTEXT_PARAMETER is defined; type set by
 *                    MLK_CONFIG_CONTEXT_PARAMETER_TYPE.
 *
 * @retval 0                     Success.
 * @retval MLK_ERR_INVALID_PK    Modulus check failed.
 * @retval MLK_ERR_OUT_OF_MEMORY MLK_CONFIG_CUSTOM_ALLOC_FREE was used and
 *                               MLK_CUSTOM_ALLOC returned NULL.
 */
#if !defined(MLK_CONFIG_NO_ENCAPS_API)
MLK_EXTERNAL_API
MLK_MUST_CHECK_RETURN_VALUE
int mlk_kem_check_pk(const uint8_t pk[MLKEM_INDCCA_PUBLICKEYBYTES],
                     MLK_CONFIG_CONTEXT_PARAMETER_TYPE context)
__contract__(
  requires(memory_no_alias(pk, MLKEM_INDCCA_PUBLICKEYBYTES))
  ensures(return_value == 0 || return_value == MLK_ERR_INVALID_PK ||
          return_value == MLK_ERR_OUT_OF_MEMORY)
);
#endif /* !MLK_CONFIG_NO_ENCAPS_API */


/**
 * Implements public key hash check mandated by FIPS 203, i.e., ensures that
 * sk[768𝑘+32 ∶ 768𝑘+64] = H(pk) = H(sk[384𝑘 : 768𝑘+32]).
 *
 * @spec{Implements @[FIPS203, Section 7.3, 'hash check'].}
 *
 * @reference{Not implemented in the reference implementation @[REF].}
 *
 * @param[in] sk      Input private key (an already allocated array of
 *                    MLKEM_INDCCA_SECRETKEYBYTES bytes).
 * @param     context Application context. Only present when
 *                    MLK_CONFIG_CONTEXT_PARAMETER is defined; type set by
 *                    MLK_CONFIG_CONTEXT_PARAMETER_TYPE.
 *
 * @retval 0                     Success.
 * @retval MLK_ERR_INVALID_SK    Public key hash check failed.
 * @retval MLK_ERR_OUT_OF_MEMORY MLK_CONFIG_CUSTOM_ALLOC_FREE was used and
 *                               MLK_CUSTOM_ALLOC returned NULL.
 */
#if !defined(MLK_CONFIG_NO_DECAPS_API)
MLK_EXTERNAL_API
MLK_MUST_CHECK_RETURN_VALUE
int mlk_kem_check_sk(const uint8_t sk[MLKEM_INDCCA_SECRETKEYBYTES],
                     MLK_CONFIG_CONTEXT_PARAMETER_TYPE context)
__contract__(
  requires(memory_no_alias(sk, MLKEM_INDCCA_SECRETKEYBYTES))
  ensures(return_value == 0 || return_value == MLK_ERR_INVALID_SK ||
          return_value == MLK_ERR_OUT_OF_MEMORY)
);
#endif /* !MLK_CONFIG_NO_DECAPS_API */

#if !defined(MLK_CONFIG_NO_KEYPAIR_API)
/**
 * Generate a public/private keypair for the ML-KEM key encapsulation mechanism.
 *
 * @spec{Implements @[FIPS203, Algorithm 16, ML-KEM.KeyGen_Internal].}
 *
 * @param[out] pk      Output public key (an already allocated array of
 *                     MLKEM_INDCCA_PUBLICKEYBYTES bytes).
 * @param[out] sk      Output private key (an already allocated array of
 *                     MLKEM_INDCCA_SECRETKEYBYTES bytes).
 * @param[in]  coins   Input randomness (an already allocated array filled
 *                     with 2*MLKEM_SYMBYTES random bytes).
 * @param      context Application context. Only present when
 *                     MLK_CONFIG_CONTEXT_PARAMETER is defined; type set by
 *                     MLK_CONFIG_CONTEXT_PARAMETER_TYPE.
 *
 * @retval 0                     Success.
 * @retval MLK_ERR_PCT_FAIL      MLK_CONFIG_KEYGEN_PCT enabled and PCT failed.
 * @retval MLK_ERR_OUT_OF_MEMORY MLK_CONFIG_CUSTOM_ALLOC_FREE was used and
 *                               MLK_CUSTOM_ALLOC returned NULL.
 * @retval MLK_ERR_RNG_FAIL      MLK_CONFIG_KEYGEN_PCT enabled and random
 *                               number generation failed within the PCT.
 */
MLK_EXTERNAL_API
MLK_MUST_CHECK_RETURN_VALUE
int mlk_kem_keypair_derand(uint8_t pk[MLKEM_INDCCA_PUBLICKEYBYTES],
                           uint8_t sk[MLKEM_INDCCA_SECRETKEYBYTES],
                           const uint8_t coins[2 * MLKEM_SYMBYTES],
                           MLK_CONFIG_CONTEXT_PARAMETER_TYPE context)
__contract__(
  requires(memory_no_alias(pk, MLKEM_INDCCA_PUBLICKEYBYTES))
  requires(memory_no_alias(sk, MLKEM_INDCCA_SECRETKEYBYTES))
  requires(memory_no_alias(coins, 2 * MLKEM_SYMBYTES))
  assigns(memory_slice(pk, MLKEM_INDCCA_PUBLICKEYBYTES))
  assigns(memory_slice(sk, MLKEM_INDCCA_SECRETKEYBYTES))
  ensures(return_value == 0 || return_value == MLK_ERR_PCT_FAIL ||
          return_value == MLK_ERR_OUT_OF_MEMORY ||
          return_value == MLK_ERR_RNG_FAIL)
  /* Output buffers on error, per API-CONVENTIONS.md */
  ensures(return_value != 0 ==>
          array_unchanged_or_zeroized_u8(pk, MLKEM_INDCCA_PUBLICKEYBYTES))
  ensures(return_value != 0 ==>
          array_unchanged_or_zeroized_u8(sk, MLKEM_INDCCA_SECRETKEYBYTES))
);

#if !defined(MLK_CONFIG_NO_RANDOMIZED_API)
/**
 * Generate a public/private keypair for the ML-KEM key encapsulation mechanism.
 *
 * @spec{Implements @[FIPS203, Algorithm 19, ML-KEM.KeyGen].}
 *
 * @param[out] pk      Output public key (an already allocated array of
 *                     MLKEM_INDCCA_PUBLICKEYBYTES bytes).
 * @param[out] sk      Output private key (an already allocated array of
 *                     MLKEM_INDCCA_SECRETKEYBYTES bytes).
 * @param      context Application context. Only present when
 *                     MLK_CONFIG_CONTEXT_PARAMETER is defined; type set by
 *                     MLK_CONFIG_CONTEXT_PARAMETER_TYPE.
 *
 * @retval 0                     Success.
 * @retval MLK_ERR_OUT_OF_MEMORY MLK_CONFIG_CUSTOM_ALLOC_FREE was used and
 *                               MLK_CUSTOM_ALLOC returned NULL.
 * @retval MLK_ERR_RNG_FAIL      Random number generation failed.
 * @retval MLK_ERR_PCT_FAIL      MLK_CONFIG_KEYGEN_PCT enabled and PCT failed.
 */
MLK_EXTERNAL_API
MLK_MUST_CHECK_RETURN_VALUE
int mlk_kem_keypair(uint8_t pk[MLKEM_INDCCA_PUBLICKEYBYTES],
                    uint8_t sk[MLKEM_INDCCA_SECRETKEYBYTES],
                    MLK_CONFIG_CONTEXT_PARAMETER_TYPE context)
__contract__(
  requires(memory_no_alias(pk, MLKEM_INDCCA_PUBLICKEYBYTES))
  requires(memory_no_alias(sk, MLKEM_INDCCA_SECRETKEYBYTES))
  assigns(memory_slice(pk, MLKEM_INDCCA_PUBLICKEYBYTES))
  assigns(memory_slice(sk, MLKEM_INDCCA_SECRETKEYBYTES))
  ensures(return_value == 0 || return_value == MLK_ERR_PCT_FAIL ||
          return_value == MLK_ERR_OUT_OF_MEMORY ||
          return_value == MLK_ERR_RNG_FAIL)
  /* Output buffers on error, per API-CONVENTIONS.md */
  ensures(return_value != 0 ==>
          array_unchanged_or_zeroized_u8(pk, MLKEM_INDCCA_PUBLICKEYBYTES))
  ensures(return_value != 0 ==>
          array_unchanged_or_zeroized_u8(sk, MLKEM_INDCCA_SECRETKEYBYTES))
);
#endif /* !MLK_CONFIG_NO_RANDOMIZED_API */
#endif /* !MLK_CONFIG_NO_KEYPAIR_API */

/**
 * Generate ciphertext and shared secret for a given public key.
 *
 * @spec{Implements @[FIPS203, Algorithm 17, ML-KEM.Encaps_Internal].}
 *
 * @param[out] ct      Output ciphertext (an already allocated array of
 *                     MLKEM_INDCCA_CIPHERTEXTBYTES bytes).
 * @param[out] ss      Output shared secret (an already allocated array of
 *                     MLKEM_SSBYTES bytes).
 * @param[in]  pk      Input public key (an already allocated array of
 *                     MLKEM_INDCCA_PUBLICKEYBYTES bytes).
 * @param[in]  coins   Input randomness (an already allocated array filled
 *                     with MLKEM_SYMBYTES random bytes).
 * @param      context Application context. Only present when
 *                     MLK_CONFIG_CONTEXT_PARAMETER is defined; type set by
 *                     MLK_CONFIG_CONTEXT_PARAMETER_TYPE.
 *
 * @retval 0                     Success.
 * @retval MLK_ERR_INVALID_PK    The 'modulus check' @[FIPS203, Section 7.2]
 *                               for the public key failed.
 * @retval MLK_ERR_OUT_OF_MEMORY MLK_CONFIG_CUSTOM_ALLOC_FREE was used and
 *                               MLK_CUSTOM_ALLOC returned NULL.
 */
#if !defined(MLK_CONFIG_NO_ENCAPS_API)
MLK_EXTERNAL_API
MLK_MUST_CHECK_RETURN_VALUE
int mlk_kem_enc_derand(uint8_t ct[MLKEM_INDCCA_CIPHERTEXTBYTES],
                       uint8_t ss[MLKEM_SSBYTES],
                       const uint8_t pk[MLKEM_INDCCA_PUBLICKEYBYTES],
                       const uint8_t coins[MLKEM_SYMBYTES],
                       MLK_CONFIG_CONTEXT_PARAMETER_TYPE context)
__contract__(
  requires(memory_no_alias(ct, MLKEM_INDCCA_CIPHERTEXTBYTES))
  requires(memory_no_alias(ss, MLKEM_SSBYTES))
  requires(memory_no_alias(pk, MLKEM_INDCCA_PUBLICKEYBYTES))
  requires(memory_no_alias(coins, MLKEM_SYMBYTES))
  assigns(memory_slice(ct, MLKEM_INDCCA_CIPHERTEXTBYTES))
  assigns(memory_slice(ss, MLKEM_SSBYTES))
  ensures(return_value == 0 || return_value == MLK_ERR_INVALID_PK ||
          return_value == MLK_ERR_OUT_OF_MEMORY)
  /* Output buffers on error, per API-CONVENTIONS.md */
  ensures(return_value != 0 ==>
          array_unchanged_or_zeroized_u8(ct, MLKEM_INDCCA_CIPHERTEXTBYTES))
  ensures(return_value != 0 ==>
          array_unchanged_or_zeroized_u8(ss, MLKEM_SSBYTES))
);

#if !defined(MLK_CONFIG_NO_RANDOMIZED_API)
/**
 * Generate ciphertext and shared secret for a given public key.
 *
 * @spec{Implements @[FIPS203, Algorithm 20, ML-KEM.Encaps].}
 *
 * @param[out] ct      Output ciphertext (an already allocated array of
 *                     MLKEM_INDCCA_CIPHERTEXTBYTES bytes).
 * @param[out] ss      Output shared secret (an already allocated array of
 *                     MLKEM_SSBYTES bytes).
 * @param[in]  pk      Input public key (an already allocated array of
 *                     MLKEM_INDCCA_PUBLICKEYBYTES bytes).
 * @param      context Application context. Only present when
 *                     MLK_CONFIG_CONTEXT_PARAMETER is defined; type set by
 *                     MLK_CONFIG_CONTEXT_PARAMETER_TYPE.
 *
 * @retval 0                     Success.
 * @retval MLK_ERR_OUT_OF_MEMORY MLK_CONFIG_CUSTOM_ALLOC_FREE was used and
 *                               MLK_CUSTOM_ALLOC returned NULL.
 * @retval MLK_ERR_RNG_FAIL      Random number generation failed.
 * @retval MLK_ERR_INVALID_PK    The 'modulus check' @[FIPS203, Section 7.2]
 *                               for the public key failed.
 */
MLK_EXTERNAL_API
MLK_MUST_CHECK_RETURN_VALUE
int mlk_kem_enc(uint8_t ct[MLKEM_INDCCA_CIPHERTEXTBYTES],
                uint8_t ss[MLKEM_SSBYTES],
                const uint8_t pk[MLKEM_INDCCA_PUBLICKEYBYTES],
                MLK_CONFIG_CONTEXT_PARAMETER_TYPE context)
__contract__(
  requires(memory_no_alias(ct, MLKEM_INDCCA_CIPHERTEXTBYTES))
  requires(memory_no_alias(ss, MLKEM_SSBYTES))
  requires(memory_no_alias(pk, MLKEM_INDCCA_PUBLICKEYBYTES))
  assigns(memory_slice(ct, MLKEM_INDCCA_CIPHERTEXTBYTES))
  assigns(memory_slice(ss, MLKEM_SSBYTES))
  ensures(return_value == 0 || return_value == MLK_ERR_INVALID_PK ||
          return_value == MLK_ERR_OUT_OF_MEMORY ||
          return_value == MLK_ERR_RNG_FAIL)
  /* Output buffers on error, per API-CONVENTIONS.md */
  ensures(return_value != 0 ==>
          array_unchanged_or_zeroized_u8(ct, MLKEM_INDCCA_CIPHERTEXTBYTES))
  ensures(return_value != 0 ==>
          array_unchanged_or_zeroized_u8(ss, MLKEM_SSBYTES))
);
#endif /* !MLK_CONFIG_NO_RANDOMIZED_API */
#endif /* !MLK_CONFIG_NO_ENCAPS_API */

/**
 * Generate shared secret for a given ciphertext and private key.
 *
 * @spec{Implements @[FIPS203, Algorithm 21, ML-KEM.Decaps].}
 *
 * @param[out] ss      Output shared secret (an already allocated array of
 *                     MLKEM_SSBYTES bytes).
 * @param[in]  ct      Input ciphertext (an already allocated array of
 *                     MLKEM_INDCCA_CIPHERTEXTBYTES bytes).
 * @param[in]  sk      Input private key (an already allocated array of
 *                     MLKEM_INDCCA_SECRETKEYBYTES bytes).
 * @param      context Application context. Only present when
 *                     MLK_CONFIG_CONTEXT_PARAMETER is defined; type set by
 *                     MLK_CONFIG_CONTEXT_PARAMETER_TYPE.
 *
 * @retval 0                     Success.
 * @retval MLK_ERR_INVALID_SK    The 'hash check' @[FIPS203, Section 7.3]
 *                               for the secret key failed.
 * @retval MLK_ERR_OUT_OF_MEMORY MLK_CONFIG_CUSTOM_ALLOC_FREE was used and
 *                               MLK_CUSTOM_ALLOC returned NULL.
 */
#if !defined(MLK_CONFIG_NO_DECAPS_API)
MLK_EXTERNAL_API
MLK_MUST_CHECK_RETURN_VALUE
int mlk_kem_dec(uint8_t ss[MLKEM_SSBYTES],
                const uint8_t ct[MLKEM_INDCCA_CIPHERTEXTBYTES],
                const uint8_t sk[MLKEM_INDCCA_SECRETKEYBYTES],
                MLK_CONFIG_CONTEXT_PARAMETER_TYPE context)
__contract__(
  requires(memory_no_alias(ss, MLKEM_SSBYTES))
  requires(memory_no_alias(ct, MLKEM_INDCCA_CIPHERTEXTBYTES))
  requires(memory_no_alias(sk, MLKEM_INDCCA_SECRETKEYBYTES))
  assigns(memory_slice(ss, MLKEM_SSBYTES))
  ensures(return_value == 0 || return_value == MLK_ERR_INVALID_SK ||
          return_value == MLK_ERR_OUT_OF_MEMORY)
  /* Output buffers on error, per API-CONVENTIONS.md */
  ensures(return_value != 0 ==>
          array_unchanged_or_zeroized_u8(ss, MLKEM_SSBYTES))
);
#endif /* !MLK_CONFIG_NO_DECAPS_API */

#endif /* !MLK_KEM_H */
