/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

/* References
 * ==========
 *
 * - [FIPS140_3_IG]
 *   Implementation Guidance for FIPS 140-3 and the Cryptographic Module
 *   Validation Program
 *   National Institute of Standards and Technology
 *   https://csrc.nist.gov/projects/cryptographic-module-validation-program/fips-140-3-ig-announcements
 *
 * - [FIPS203]
 *   FIPS 203 Module-Lattice-Based Key-Encapsulation Mechanism Standard
 *   National Institute of Standards and Technology
 *   https://csrc.nist.gov/pubs/fips/203/final
 */

#ifndef MLK_H
#define MLK_H

/*
 * Public API for mlkem-native.
 *
 * This header defines the public API of a single build of mlkem-native.
 *
 * Make sure the configuration file is in the include path
 * (this is "mlkem_native_config.h" by default, or MLK_CONFIG_FILE if defined).
 *
 * # API conventions
 *
 * Conventions shared by all functions below (return values, pointer validity,
 * output buffers on error) are documented in API-CONVENTIONS.md.
 *
 * # Multi-level builds
 *
 * This header specifies a build of mlkem-native for a fixed security level.
 * If you need multiple security levels, leave the security level unspecified
 * in the configuration file and include this header multiple times, setting
 * MLK_CONFIG_PARAMETER_SET accordingly for each, and #undef'ing the MLK_H
 * guard to allow multiple inclusions.
 *
 * In this case, the configuration file must also set
 * MLK_CONFIG_MULTILEVEL_BUILD. Without it, the parameter set is not appended
 * to the namespace prefix and all inclusions declare the same symbol names.
 */

/******************************* Key sizes ************************************/

/* Sizes of cryptographic material, per parameter set */
/* See mlkem/src/params.h for the arithmetic expressions giving rise to these */
/* check-magic: off */
#define MLKEM512_SECRETKEYBYTES 1632
#define MLKEM512_PUBLICKEYBYTES 800
#define MLKEM512_CIPHERTEXTBYTES 768

#define MLKEM768_SECRETKEYBYTES 2400
#define MLKEM768_PUBLICKEYBYTES 1184
#define MLKEM768_CIPHERTEXTBYTES 1088

#define MLKEM1024_SECRETKEYBYTES 3168
#define MLKEM1024_PUBLICKEYBYTES 1568
#define MLKEM1024_CIPHERTEXTBYTES 1568
/* check-magic: on */

/* Size of randomness coins in bytes (level-independent) */
#define MLKEM_SYMBYTES 32
#define MLKEM512_SYMBYTES MLKEM_SYMBYTES
#define MLKEM768_SYMBYTES MLKEM_SYMBYTES
#define MLKEM1024_SYMBYTES MLKEM_SYMBYTES
/* Size of shared secret in bytes (level-independent) */
#define MLKEM_BYTES 32
#define MLKEM512_BYTES MLKEM_BYTES
#define MLKEM768_BYTES MLKEM_BYTES
#define MLKEM1024_BYTES MLKEM_BYTES

/* Sizes of cryptographic material, as a function of LVL=512,768,1024 */
#define MLKEM_SECRETKEYBYTES_(LVL) MLKEM##LVL##_SECRETKEYBYTES
#define MLKEM_PUBLICKEYBYTES_(LVL) MLKEM##LVL##_PUBLICKEYBYTES
#define MLKEM_CIPHERTEXTBYTES_(LVL) MLKEM##LVL##_CIPHERTEXTBYTES
#define MLKEM_SECRETKEYBYTES(LVL) MLKEM_SECRETKEYBYTES_(LVL)
#define MLKEM_PUBLICKEYBYTES(LVL) MLKEM_PUBLICKEYBYTES_(LVL)
#define MLKEM_CIPHERTEXTBYTES(LVL) MLKEM_CIPHERTEXTBYTES_(LVL)

/****************************** Error codes ***********************************/

/* Generic failure condition. Currently not returned by any function;
 * reserved for failures that no more specific code covers. */
#define MLK_ERR_FAIL (-1)
/* An allocation failed. This can only happen if MLK_CONFIG_CUSTOM_ALLOC_FREE
 * is defined and the provided MLK_CUSTOM_ALLOC can fail. */
#define MLK_ERR_OUT_OF_MEMORY (-2)
/* An RNG failure occurred. Might be due to insufficient entropy or
 * system misconfiguration. */
#define MLK_ERR_RNG_FAIL (-3)
/* Public key validation failed: the @[FIPS203, Section 7.2, 'modulus check']
 * found a coefficient outside [0,q-1]. Returned by check_pk and by the
 * encapsulation API. */
#define MLK_ERR_INVALID_PK (-4)
/* Secret key validation failed: the @[FIPS203, Section 7.3, 'hash check']
 * found the embedded public key hash inconsistent. Returned by check_sk and
 * by the decapsulation API. */
#define MLK_ERR_INVALID_SK (-5)
/* The 'Pairwise Consistency Test' @[FIPS140_3_IG, p.87] and
 * @[FIPS203, Section 7.1, Pairwise Consistency] failed. Only possible when
 * MLK_CONFIG_KEYGEN_PCT is enabled; signals that the freshly generated key
 * pair failed its encaps/decaps self-test. */
#define MLK_ERR_PCT_FAIL (-6)

/********************* Namespacing and Qualifiers *****************************/

#define MLK_API_CONCAT_(x, y) x##y
#define MLK_API_CONCAT(x, y) MLK_API_CONCAT_(x, y)
#define MLK_API_CONCAT_UNDERSCORE(x, y) MLK_API_CONCAT(MLK_API_CONCAT(x, _), y)

/* You need to make sure the config file is in the include path. */
#if defined(MLK_CONFIG_FILE)
#include MLK_CONFIG_FILE
#else
#include "mlkem_native_config.h"
#endif

/* Namespace prefix for the public API symbols. For multi-level builds, the
 * parameter set is appended to disambiguate the security levels. */
#if defined(MLK_CONFIG_MULTILEVEL_BUILD)
#define MLK_API_NAMESPACE_PREFIX \
  MLK_API_CONCAT(MLK_CONFIG_NAMESPACE_PREFIX, MLK_CONFIG_PARAMETER_SET)
#else
#define MLK_API_NAMESPACE_PREFIX MLK_CONFIG_NAMESPACE_PREFIX
#endif

#define MLK_API_NAMESPACE(sym) \
  MLK_API_CONCAT_UNDERSCORE(MLK_API_NAMESPACE_PREFIX, sym)

#if defined(__GNUC__) || defined(__clang__)
#define MLK_API_MUST_CHECK_RETURN_VALUE __attribute__((warn_unused_result))
#else
#define MLK_API_MUST_CHECK_RETURN_VALUE
#endif

#if defined(MLK_CONFIG_EXTERNAL_API_QUALIFIER)
#define MLK_API_QUALIFIER MLK_CONFIG_EXTERNAL_API_QUALIFIER
#else
#define MLK_API_QUALIFIER
#endif

/****************************** Function API **********************************/

#if !defined(MLK_CONFIG_CONSTANTS_ONLY)

#include <stdint.h>

#ifdef __cplusplus
extern "C"
{
#endif

#if !defined(MLK_CONFIG_NO_KEYPAIR_API)
/**
 * Generate a public/private keypair for the ML-KEM key encapsulation mechanism.
 *
 * @spec{Implements @[FIPS203, Algorithm 16, ML-KEM.KeyGen_Internal].}
 *
 * @param[out] pk      Output public key, an array of
 *                     MLKEM{512,768,1024}_PUBLICKEYBYTES bytes.
 * @param[out] sk      Output private key, an array of
 *                     MLKEM{512,768,1024}_SECRETKEYBYTES bytes.
 * @param[in]  coins   Input randomness, an array of 2*MLKEM_SYMBYTES uniformly
 *                     random bytes.
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
MLK_API_QUALIFIER
MLK_API_MUST_CHECK_RETURN_VALUE
int MLK_API_NAMESPACE(keypair_derand)(
    uint8_t pk[MLKEM_PUBLICKEYBYTES(MLK_CONFIG_PARAMETER_SET)],
    uint8_t sk[MLKEM_SECRETKEYBYTES(MLK_CONFIG_PARAMETER_SET)],
    const uint8_t coins[2 * MLKEM_SYMBYTES]
#ifdef MLK_CONFIG_CONTEXT_PARAMETER
    ,
    MLK_CONFIG_CONTEXT_PARAMETER_TYPE context
#endif
);


#if !defined(MLK_CONFIG_NO_RANDOMIZED_API)
/**
 * Generate a public/private keypair for the ML-KEM key encapsulation mechanism.
 *
 * @spec{Implements @[FIPS203, Algorithm 19, ML-KEM.KeyGen].}
 *
 * @param[out] pk      Output public key, an array of
 *                     MLKEM{512,768,1024}_PUBLICKEYBYTES bytes.
 * @param[out] sk      Output private key, an array of
 *                     MLKEM{512,768,1024}_SECRETKEYBYTES bytes.
 * @param      context Application context. Only present when
 *                     MLK_CONFIG_CONTEXT_PARAMETER is defined; type set by
 *                     MLK_CONFIG_CONTEXT_PARAMETER_TYPE.
 *
 * @retval 0                     Success.
 * @retval MLK_ERR_PCT_FAIL      MLK_CONFIG_KEYGEN_PCT enabled and PCT failed.
 * @retval MLK_ERR_OUT_OF_MEMORY MLK_CONFIG_CUSTOM_ALLOC_FREE was used and
 *                               MLK_CUSTOM_ALLOC returned NULL.
 * @retval MLK_ERR_RNG_FAIL      Random number generation failed.
 */
MLK_API_QUALIFIER
MLK_API_MUST_CHECK_RETURN_VALUE
int MLK_API_NAMESPACE(keypair)(
    uint8_t pk[MLKEM_PUBLICKEYBYTES(MLK_CONFIG_PARAMETER_SET)],
    uint8_t sk[MLKEM_SECRETKEYBYTES(MLK_CONFIG_PARAMETER_SET)]
#ifdef MLK_CONFIG_CONTEXT_PARAMETER
    ,
    MLK_CONFIG_CONTEXT_PARAMETER_TYPE context
#endif
);
#endif /* !MLK_CONFIG_NO_RANDOMIZED_API */
#endif /* !MLK_CONFIG_NO_KEYPAIR_API */

#if !defined(MLK_CONFIG_NO_ENCAPS_API)
/**
 * Generate ciphertext and shared secret for a given public key.
 *
 * @spec{Implements @[FIPS203, Algorithm 17, ML-KEM.Encaps_Internal].}
 *
 * @param[out] ct      Output ciphertext, an array of
 *                     MLKEM{512,768,1024}_CIPHERTEXTBYTES bytes.
 * @param[out] ss      Output shared secret, an array of MLKEM_BYTES bytes.
 * @param[in]  pk      Input public key, an array of
 *                     MLKEM{512,768,1024}_PUBLICKEYBYTES bytes.
 * @param[in]  coins   Input randomness, an array of MLKEM_SYMBYTES bytes.
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
MLK_API_QUALIFIER
MLK_API_MUST_CHECK_RETURN_VALUE
int MLK_API_NAMESPACE(enc_derand)(
    uint8_t ct[MLKEM_CIPHERTEXTBYTES(MLK_CONFIG_PARAMETER_SET)],
    uint8_t ss[MLKEM_BYTES],
    const uint8_t pk[MLKEM_PUBLICKEYBYTES(MLK_CONFIG_PARAMETER_SET)],
    const uint8_t coins[MLKEM_SYMBYTES]
#ifdef MLK_CONFIG_CONTEXT_PARAMETER
    ,
    MLK_CONFIG_CONTEXT_PARAMETER_TYPE context
#endif
);

#if !defined(MLK_CONFIG_NO_RANDOMIZED_API)
/**
 * Generate ciphertext and shared secret for a given public key.
 *
 * @spec{Implements @[FIPS203, Algorithm 20, ML-KEM.Encaps].}
 *
 * @param[out] ct      Output ciphertext, an array of
 *                     MLKEM{512,768,1024}_CIPHERTEXTBYTES bytes.
 * @param[out] ss      Output shared secret, an array of MLKEM_BYTES bytes.
 * @param[in]  pk      Input public key, an array of
 *                     MLKEM{512,768,1024}_PUBLICKEYBYTES bytes.
 * @param      context Application context. Only present when
 *                     MLK_CONFIG_CONTEXT_PARAMETER is defined; type set by
 *                     MLK_CONFIG_CONTEXT_PARAMETER_TYPE.
 *
 * @retval 0                     Success.
 * @retval MLK_ERR_INVALID_PK    The 'modulus check' @[FIPS203, Section 7.2]
 *                               for the public key failed.
 * @retval MLK_ERR_OUT_OF_MEMORY MLK_CONFIG_CUSTOM_ALLOC_FREE was used and
 *                               MLK_CUSTOM_ALLOC returned NULL.
 * @retval MLK_ERR_RNG_FAIL      Random number generation failed.
 */
MLK_API_QUALIFIER
MLK_API_MUST_CHECK_RETURN_VALUE
int MLK_API_NAMESPACE(enc)(
    uint8_t ct[MLKEM_CIPHERTEXTBYTES(MLK_CONFIG_PARAMETER_SET)],
    uint8_t ss[MLKEM_BYTES],
    const uint8_t pk[MLKEM_PUBLICKEYBYTES(MLK_CONFIG_PARAMETER_SET)]
#ifdef MLK_CONFIG_CONTEXT_PARAMETER
    ,
    MLK_CONFIG_CONTEXT_PARAMETER_TYPE context
#endif
);
#endif /* !MLK_CONFIG_NO_RANDOMIZED_API */
#endif /* !MLK_CONFIG_NO_ENCAPS_API */

#if !defined(MLK_CONFIG_NO_DECAPS_API)
/**
 * Generate shared secret for a given ciphertext and private key.
 *
 * @spec{Implements @[FIPS203, Algorithm 21, ML-KEM.Decaps].}
 *
 * @param[out] ss      Output shared secret, an array of MLKEM_BYTES bytes.
 * @param[in]  ct      Input ciphertext, an array of
 *                     MLKEM{512,768,1024}_CIPHERTEXTBYTES bytes.
 * @param[in]  sk      Input private key, an array of
 *                     MLKEM{512,768,1024}_SECRETKEYBYTES bytes.
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
MLK_API_QUALIFIER
MLK_API_MUST_CHECK_RETURN_VALUE
int MLK_API_NAMESPACE(dec)(
    uint8_t ss[MLKEM_BYTES],
    const uint8_t ct[MLKEM_CIPHERTEXTBYTES(MLK_CONFIG_PARAMETER_SET)],
    const uint8_t sk[MLKEM_SECRETKEYBYTES(MLK_CONFIG_PARAMETER_SET)]
#ifdef MLK_CONFIG_CONTEXT_PARAMETER
    ,
    MLK_CONFIG_CONTEXT_PARAMETER_TYPE context
#endif
);
#endif /* !MLK_CONFIG_NO_DECAPS_API */


/**
 * Implements modulus check mandated by FIPS 203, i.e., ensures that
 * coefficients are in [0,q-1].
 *
 * @spec{Implements @[FIPS203, Section 7.2, 'modulus check'].}
 *
 * @param[in] pk      Input public key, an array of
 *                    MLKEM{512,768,1024}_PUBLICKEYBYTES bytes.
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
MLK_API_QUALIFIER
MLK_API_MUST_CHECK_RETURN_VALUE
int MLK_API_NAMESPACE(check_pk)(
    const uint8_t pk[MLKEM_PUBLICKEYBYTES(MLK_CONFIG_PARAMETER_SET)]
#ifdef MLK_CONFIG_CONTEXT_PARAMETER
    ,
    MLK_CONFIG_CONTEXT_PARAMETER_TYPE context
#endif
);
#endif /* !MLK_CONFIG_NO_ENCAPS_API */

/**
 * Implements public key hash check mandated by FIPS 203, i.e., ensures that
 * sk[768𝑘+32 ∶ 768𝑘+64] = H(pk) = H(sk[384𝑘 : 768𝑘+32]).
 *
 * @spec{Implements @[FIPS203, Section 7.3, 'hash check'].}
 *
 * @param[in] sk      Input private key, an array of
 *                    MLKEM{512,768,1024}_SECRETKEYBYTES bytes.
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
MLK_API_QUALIFIER
MLK_API_MUST_CHECK_RETURN_VALUE
int MLK_API_NAMESPACE(check_sk)(
    const uint8_t sk[MLKEM_SECRETKEYBYTES(MLK_CONFIG_PARAMETER_SET)]
#ifdef MLK_CONFIG_CONTEXT_PARAMETER
    ,
    MLK_CONFIG_CONTEXT_PARAMETER_TYPE context
#endif
);
#endif /* !MLK_CONFIG_NO_DECAPS_API */

#ifdef __cplusplus
}
#endif

#undef MLK_API_NAMESPACE_PREFIX

#endif /* !MLK_CONFIG_CONSTANTS_ONLY */


/***************************** Memory Usage **********************************/

/*
 * By default mlkem-native performs all memory allocations on the stack.
 * Alternatively, mlkem-native supports custom allocation of large structures
 * through the `MLK_CONFIG_CUSTOM_ALLOC_FREE` configuration option.
 * See mlkem_native_config.h for details.
 *
 * `MLK_TOTAL_ALLOC_{512,768,1024}_{KEYPAIR,ENCAPS,DECAPS}` indicates the
 * maximum (accumulative) allocation via MLK_ALLOC for each parameter set and
 * operation. Note that some stack allocation remains even when using custom
 * allocators, so these values are lower than total stack usage with the default
 * stack-only allocation.
 *
 * These constants may be used to implement custom allocations using a
 * fixed-sized buffer and a simple allocator (e.g., bump allocator).
 */
/* check-magic: off */
#define MLK_TOTAL_ALLOC_512_KEYPAIR_NO_PCT 5824
#define MLK_TOTAL_ALLOC_512_KEYPAIR_PCT 10048
#define MLK_TOTAL_ALLOC_512_ENCAPS 8384
#define MLK_TOTAL_ALLOC_512_DECAPS 9152
#define MLK_TOTAL_ALLOC_768_KEYPAIR_NO_PCT 10176
#define MLK_TOTAL_ALLOC_768_KEYPAIR_PCT 15552
#define MLK_TOTAL_ALLOC_768_ENCAPS 13248
#define MLK_TOTAL_ALLOC_768_DECAPS 14336
#define MLK_TOTAL_ALLOC_1024_KEYPAIR_NO_PCT 15552
#define MLK_TOTAL_ALLOC_1024_KEYPAIR_PCT 22400
#define MLK_TOTAL_ALLOC_1024_ENCAPS 19136
#define MLK_TOTAL_ALLOC_1024_DECAPS 20704
/* check-magic: on */

/*
 * MLK_TOTAL_ALLOC_*_KEYPAIR adapts based on MLK_CONFIG_KEYGEN_PCT.
 */
#if defined(MLK_CONFIG_KEYGEN_PCT)
#define MLK_TOTAL_ALLOC_512_KEYPAIR MLK_TOTAL_ALLOC_512_KEYPAIR_PCT
#define MLK_TOTAL_ALLOC_768_KEYPAIR MLK_TOTAL_ALLOC_768_KEYPAIR_PCT
#define MLK_TOTAL_ALLOC_1024_KEYPAIR MLK_TOTAL_ALLOC_1024_KEYPAIR_PCT
#else
#define MLK_TOTAL_ALLOC_512_KEYPAIR MLK_TOTAL_ALLOC_512_KEYPAIR_NO_PCT
#define MLK_TOTAL_ALLOC_768_KEYPAIR MLK_TOTAL_ALLOC_768_KEYPAIR_NO_PCT
#define MLK_TOTAL_ALLOC_1024_KEYPAIR MLK_TOTAL_ALLOC_1024_KEYPAIR_NO_PCT
#endif

#define MLK_MAX3_(a, b, c) \
  ((a) > (b) ? ((a) > (c) ? (a) : (c)) : ((b) > (c) ? (b) : (c)))

/*
 * `MLK_TOTAL_ALLOC_{512,768,1024}` is the maximum across all operations for
 * each parameter set.
 */
#define MLK_TOTAL_ALLOC_512                                          \
  MLK_MAX3_(MLK_TOTAL_ALLOC_512_KEYPAIR, MLK_TOTAL_ALLOC_512_ENCAPS, \
            MLK_TOTAL_ALLOC_512_DECAPS)
#define MLK_TOTAL_ALLOC_768                                          \
  MLK_MAX3_(MLK_TOTAL_ALLOC_768_KEYPAIR, MLK_TOTAL_ALLOC_768_ENCAPS, \
            MLK_TOTAL_ALLOC_768_DECAPS)
#define MLK_TOTAL_ALLOC_1024                                           \
  MLK_MAX3_(MLK_TOTAL_ALLOC_1024_KEYPAIR, MLK_TOTAL_ALLOC_1024_ENCAPS, \
            MLK_TOTAL_ALLOC_1024_DECAPS)

#endif /* !MLK_H */
