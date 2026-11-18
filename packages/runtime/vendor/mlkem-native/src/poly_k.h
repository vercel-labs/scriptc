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

#ifndef MLK_POLY_K_H
#define MLK_POLY_K_H

#include "common.h"
#include "compress.h"
#include "poly.h"

/* Parameter set namespacing
 * This is to facilitate building multiple instances
 * of mlkem-native (e.g. with varying parameter sets)
 * within a single compilation unit. */
#define mlk_polyvec MLK_ADD_PARAM_SET(mlk_polyvec)
#define mlk_polymat MLK_ADD_PARAM_SET(mlk_polymat)
#define mlk_polyvec_mulcache MLK_ADD_PARAM_SET(mlk_polyvec_mulcache)
/* End of parameter set namespacing */

/** Vector of MLKEM_K polynomials. */
typedef struct
{
  mlk_poly vec[MLKEM_K]; /**< Component polynomials. */
} MLK_ALIGN mlk_polyvec;

/** MLKEM_K x MLKEM_K matrix of polynomials. */
typedef struct
{
  mlk_polyvec vec[MLKEM_K]; /**< Rows of the matrix. */
} MLK_ALIGN mlk_polymat;

/** Vector of MLKEM_K mlk_poly_mulcache entries. */
typedef struct
{
  mlk_poly_mulcache vec[MLKEM_K]; /**< Per-component caches. */
} MLK_ALIGN mlk_polyvec_mulcache;

#if !defined(MLK_CONFIG_NO_ENCAPS_API) || !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_poly_compress_du MLK_NAMESPACE_K(poly_compress_du)
/**
 * Compression (du bits) and subsequent serialization of a polynomial.
 *
 * @spec{Implements `ByteEncode_{d_u} (Compress_{d_u} (u))` in @[FIPS203,
 * Algorithm 14 (K-PKE.Encrypt), L22], with level-specific d_u defined in
 * @[FIPS203, Table 2], and given by MLKEM_DU here.}
 *
 * @param[out] r Output byte array (of length MLKEM_POLYCOMPRESSEDBYTES_DU
 *               bytes).
 * @param[in]  a Input polynomial. Coefficients must be unsigned canonical,
 *               i.e. in [0,1,..,MLKEM_Q-1].
 */
static MLK_INLINE void mlk_poly_compress_du(
    uint8_t r[MLKEM_POLYCOMPRESSEDBYTES_DU], const mlk_poly *a)
__contract__(
  requires(memory_no_alias(r, MLKEM_POLYCOMPRESSEDBYTES_DU))
  requires(memory_no_alias(a, sizeof(mlk_poly)))
  requires(array_bound(a->coeffs, 0, MLKEM_N, 0, MLKEM_Q))
  assigns(memory_slice(r, MLKEM_POLYCOMPRESSEDBYTES_DU)))
{
#if MLKEM_DU == 10
  mlk_poly_compress_d10(r, a);
#elif MLKEM_DU == 11
  mlk_poly_compress_d11(r, a);
#else
#error "Invalid value of MLKEM_DU"
#endif
}
#endif /* !MLK_CONFIG_NO_ENCAPS_API || !MLK_CONFIG_NO_DECAPS_API */

#if !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_poly_decompress_du MLK_NAMESPACE_K(poly_decompress_du)
/**
 * De-serialization and subsequent decompression (du bits) of a polynomial;
 * approximate inverse of mlk_poly_compress_du.
 *
 * Upon return, the coefficients of the output polynomial are
 * unsigned-canonical (non-negative and smaller than MLKEM_Q).
 *
 * @spec{Implements `Decompress_{d_u} (ByteDecode_{d_u} (u))` in @[FIPS203,
 * Algorithm 15 (K-PKE.Decrypt), L3], with level-specific d_u defined in
 * @[FIPS203, Table 2], and given by MLKEM_DU here.}
 *
 * @param[out] r Output polynomial.
 * @param[in]  a Input byte array (of length MLKEM_POLYCOMPRESSEDBYTES_DU
 *               bytes).
 */
static MLK_INLINE void mlk_poly_decompress_du(
    mlk_poly *r, const uint8_t a[MLKEM_POLYCOMPRESSEDBYTES_DU])
__contract__(
  requires(memory_no_alias(a, MLKEM_POLYCOMPRESSEDBYTES_DU))
  requires(memory_no_alias(r, sizeof(mlk_poly)))
  assigns(memory_slice(r, sizeof(mlk_poly)))
  ensures(array_bound(r->coeffs, 0, MLKEM_N, 0, MLKEM_Q)))
{
#if MLKEM_DU == 10
  mlk_poly_decompress_d10(r, a);
#elif MLKEM_DU == 11
  mlk_poly_decompress_d11(r, a);
#else
#error "Invalid value of MLKEM_DU"
#endif
}
#endif /* !MLK_CONFIG_NO_DECAPS_API */

#if !defined(MLK_CONFIG_NO_ENCAPS_API) || !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_poly_compress_dv MLK_NAMESPACE_K(poly_compress_dv)
/**
 * Compression (dv bits) and subsequent serialization of a polynomial.
 *
 * @spec{Implements `ByteEncode_{d_v} (Compress_{d_v} (v))` in @[FIPS203,
 * Algorithm 14 (K-PKE.Encrypt), L23], with level-specific d_v defined in
 * @[FIPS203, Table 2], and given by MLKEM_DV here.}
 *
 * @param[out] r Output byte array (of length MLKEM_POLYCOMPRESSEDBYTES_DV
 *               bytes).
 * @param[in]  a Input polynomial. Coefficients must be unsigned canonical,
 *               i.e. in [0,1,..,MLKEM_Q-1].
 */
static MLK_INLINE void mlk_poly_compress_dv(
    uint8_t r[MLKEM_POLYCOMPRESSEDBYTES_DV], const mlk_poly *a)
__contract__(
  requires(memory_no_alias(r, MLKEM_POLYCOMPRESSEDBYTES_DV))
  requires(memory_no_alias(a, sizeof(mlk_poly)))
  requires(array_bound(a->coeffs, 0, MLKEM_N, 0, MLKEM_Q))
  assigns(memory_slice(r, MLKEM_POLYCOMPRESSEDBYTES_DV)))
{
#if MLKEM_DV == 4
  mlk_poly_compress_d4(r, a);
#elif MLKEM_DV == 5
  mlk_poly_compress_d5(r, a);
#else
#error "Invalid value of MLKEM_DV"
#endif
}
#endif /* !MLK_CONFIG_NO_ENCAPS_API || !MLK_CONFIG_NO_DECAPS_API */


#if !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_poly_decompress_dv MLK_NAMESPACE_K(poly_decompress_dv)
/**
 * De-serialization and subsequent decompression (dv bits) of a polynomial;
 * approximate inverse of mlk_poly_compress_dv.
 *
 * Upon return, the coefficients of the output polynomial are
 * unsigned-canonical (non-negative and smaller than MLKEM_Q).
 *
 * @spec{Implements `Decompress_{d_v} (ByteDecode_{d_v} (v))` in @[FIPS203,
 * Algorithm 15 (K-PKE.Decrypt), L4], with level-specific d_v defined in
 * @[FIPS203, Table 2], and given by MLKEM_DV here.}
 *
 * @param[out] r Output polynomial.
 * @param[in]  a Input byte array (of length MLKEM_POLYCOMPRESSEDBYTES_DV
 *               bytes).
 */
static MLK_INLINE void mlk_poly_decompress_dv(
    mlk_poly *r, const uint8_t a[MLKEM_POLYCOMPRESSEDBYTES_DV])
__contract__(
  requires(memory_no_alias(a, MLKEM_POLYCOMPRESSEDBYTES_DV))
  requires(memory_no_alias(r, sizeof(mlk_poly)))
  assigns(memory_slice(r, sizeof(mlk_poly)))
  ensures(array_bound(r->coeffs, 0, MLKEM_N, 0, MLKEM_Q)))
{
#if MLKEM_DV == 4
  mlk_poly_decompress_d4(r, a);
#elif MLKEM_DV == 5
  mlk_poly_decompress_d5(r, a);
#else
#error "Invalid value of MLKEM_DV"
#endif
}
#endif /* !MLK_CONFIG_NO_DECAPS_API */

#if !defined(MLK_CONFIG_NO_ENCAPS_API) || !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_polyvec_compress_du MLK_NAMESPACE_K(polyvec_compress_du)
/**
 * Compress and serialize a vector of polynomials.
 *
 * @spec{Implements `ByteEncode_{d_u} (Compress_{d_u} (u))` in @[FIPS203,
 * Algorithm 14 (K-PKE.Encrypt), L22], with level-specific d_u defined in
 * @[FIPS203, Table 2], and given by MLKEM_DU here.}
 *
 * @param[out] r Output byte array (needs space for
 *               MLKEM_POLYVECCOMPRESSEDBYTES_DU bytes).
 * @param[in]  a Input vector of polynomials. Coefficients must be unsigned
 *               canonical, i.e. in [0,1,..,MLKEM_Q-1].
 */
MLK_INTERNAL_API
void mlk_polyvec_compress_du(uint8_t r[MLKEM_POLYVECCOMPRESSEDBYTES_DU],
                             const mlk_polyvec *a)
__contract__(
  requires(memory_no_alias(r, MLKEM_POLYVECCOMPRESSEDBYTES_DU))
  requires(memory_no_alias(a, sizeof(mlk_polyvec)))
  requires(forall(k0, 0, MLKEM_K,
         array_bound(a->vec[k0].coeffs, 0, MLKEM_N, 0, MLKEM_Q)))
  assigns(memory_slice(r, MLKEM_POLYVECCOMPRESSEDBYTES_DU))
);
#endif /* !MLK_CONFIG_NO_ENCAPS_API || !MLK_CONFIG_NO_DECAPS_API */

#if !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_polyvec_decompress_du MLK_NAMESPACE_K(polyvec_decompress_du)
/**
 * De-serialize and decompress a vector of polynomials; approximate inverse
 * of mlk_polyvec_compress_du.
 *
 * @spec{Implements `Decompress_{d_u} (ByteDecode_{d_u} (u))` in @[FIPS203,
 * Algorithm 15 (K-PKE.Decrypt), L3], with level-specific d_u defined in
 * @[FIPS203, Table 2], and given by MLKEM_DU here.}
 *
 * @param[out] r Output vector of polynomials. Coefficients are normalized
 *               to [0,1,..,MLKEM_Q-1].
 * @param[in]  a Input byte array (of length MLKEM_POLYVECCOMPRESSEDBYTES_DU
 *               bytes).
 */
MLK_INTERNAL_API
void mlk_polyvec_decompress_du(mlk_polyvec *r,
                               const uint8_t a[MLKEM_POLYVECCOMPRESSEDBYTES_DU])
__contract__(
  requires(memory_no_alias(a, MLKEM_POLYVECCOMPRESSEDBYTES_DU))
  requires(memory_no_alias(r, sizeof(mlk_polyvec)))
  assigns(memory_slice(r, sizeof(mlk_polyvec)))
  ensures(forall(k0, 0, MLKEM_K,
         array_bound(r->vec[k0].coeffs, 0, MLKEM_N, 0, MLKEM_Q)))
);
#endif /* !MLK_CONFIG_NO_DECAPS_API */

#if !defined(MLK_CONFIG_NO_KEYPAIR_API) || !defined(MLK_CONFIG_NO_ENCAPS_API)
#define mlk_polyvec_tobytes MLK_NAMESPACE_K(polyvec_tobytes)
/**
 * Serialize a vector of polynomials.
 *
 * @spec{Implements ByteEncode_12 @[FIPS203, Algorithm 5]. Extended to
 * vectors as per @[FIPS203, 2.4.8 Applying Algorithms to Arrays] and
 * @[FIPS203, 2.4.6, Matrices and Vectors].}
 *
 * @param[out] r Output byte array (needs space for MLKEM_POLYVECBYTES bytes).
 * @param[in]  a Input vector of polynomials. Each polynomial must have
 *               coefficients in [0,1,..,MLKEM_Q-1].
 */
MLK_INTERNAL_API
void mlk_polyvec_tobytes(uint8_t r[MLKEM_POLYVECBYTES], const mlk_polyvec *a)
__contract__(
  requires(memory_no_alias(a, sizeof(mlk_polyvec)))
  requires(memory_no_alias(r, MLKEM_POLYVECBYTES))
  requires(forall(k0, 0, MLKEM_K,
         array_bound(a->vec[k0].coeffs, 0, MLKEM_N, 0, MLKEM_Q)))
  assigns(memory_slice(r, MLKEM_POLYVECBYTES))
);
#endif /* !MLK_CONFIG_NO_KEYPAIR_API || !MLK_CONFIG_NO_ENCAPS_API */

#if !defined(MLK_CONFIG_NO_ENCAPS_API) || !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_polyvec_frombytes MLK_NAMESPACE_K(polyvec_frombytes)
/**
 * De-serialize a vector of polynomials; inverse of mlk_polyvec_tobytes.
 *
 * @spec{Implements ByteDecode_12 @[FIPS203, Algorithm 6]. Extended to
 * vectors as per @[FIPS203, 2.4.8 Applying Algorithms to Arrays] and
 * @[FIPS203, 2.4.6, Matrices and Vectors].}
 *
 * @param[out] r Output vector of polynomials. Coefficients will be
 *               normalized in [0,1,..,4095].
 * @param[in]  a Input byte array (of length MLKEM_POLYVECBYTES bytes).
 */
MLK_INTERNAL_API
void mlk_polyvec_frombytes(mlk_polyvec *r, const uint8_t a[MLKEM_POLYVECBYTES])
__contract__(
  requires(memory_no_alias(r, sizeof(mlk_polyvec)))
  requires(memory_no_alias(a, MLKEM_POLYVECBYTES))
  assigns(memory_slice(r, sizeof(mlk_polyvec)))
  ensures(forall(k0, 0, MLKEM_K,
        array_bound(r->vec[k0].coeffs, 0, MLKEM_N, 0, MLKEM_UINT12_LIMIT)))
);
#endif /* !MLK_CONFIG_NO_ENCAPS_API || !MLK_CONFIG_NO_DECAPS_API */

#define mlk_polyvec_ntt MLK_NAMESPACE_K(polyvec_ntt)
/**
 * Apply forward NTT to all elements of a vector of polynomials.
 *
 * The input is assumed to be in normal order and coefficient-wise bound by
 * MLKEM_Q in absolute value.
 *
 * The output polynomial is in bitreversed order, and coefficient-wise bound
 * by MLK_NTT_BOUND in absolute value.
 *
 * @spec{Implements @[FIPS203, Algorithm 9, NTT]. Extended to vectors as per
 * @[FIPS203, 2.4.6, Matrices and Vectors].}
 *
 * @param[in,out] r Input/output vector of polynomials.
 */
MLK_INTERNAL_API
void mlk_polyvec_ntt(mlk_polyvec *r)
__contract__(
  requires(memory_no_alias(r, sizeof(mlk_polyvec)))
  requires(forall(j, 0, MLKEM_K,
  array_abs_bound(r->vec[j].coeffs, 0, MLKEM_N, MLKEM_Q)))
  assigns(memory_slice(r, sizeof(mlk_polyvec)))
  ensures(forall(j, 0, MLKEM_K,
  array_abs_bound(r->vec[j].coeffs, 0, MLKEM_N, MLK_NTT_BOUND)))
);

#if !defined(MLK_CONFIG_NO_ENCAPS_API) || !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_polyvec_invntt_tomont MLK_NAMESPACE_K(polyvec_invntt_tomont)
/**
 * Apply inverse NTT to all elements of a vector of polynomials and multiply
 * by Montgomery factor 2^16.
 *
 * The input is assumed to be in bitreversed order, and can have arbitrary
 * coefficients in int16_t.
 *
 * The output polynomial is in normal order, and coefficient-wise bound by
 * MLK_INVNTT_BOUND in absolute value.
 *
 * @spec{Implements @[FIPS203, Algorithm 10, NTT^{-1}]. Extended to vectors
 * as per @[FIPS203, 2.4.6, Matrices and Vectors].}
 *
 * @param[in,out] r Input/output vector of polynomials.
 */
MLK_INTERNAL_API
void mlk_polyvec_invntt_tomont(mlk_polyvec *r)
__contract__(
  requires(memory_no_alias(r, sizeof(mlk_polyvec)))
  assigns(memory_slice(r, sizeof(mlk_polyvec)))
  ensures(forall(j, 0, MLKEM_K,
  array_abs_bound(r->vec[j].coeffs, 0, MLKEM_N, MLK_INVNTT_BOUND)))
);
#endif /* !MLK_CONFIG_NO_ENCAPS_API || !MLK_CONFIG_NO_DECAPS_API */

#define mlk_polyvec_basemul_acc_montgomery_cached \
  MLK_NAMESPACE_K(polyvec_basemul_acc_montgomery_cached)
/**
 * Scalar product of two vectors of polynomials in NTT domain, using
 * mulcache for the second operand.
 *
 * Bounds: every coefficient of @p a is assumed to be in [0,1,..,4095]. No
 * bounds guarantees for the coefficients in the result.
 *
 * @spec{Implements @[FIPS203, Section 2.4.7, Eq (2.14)], @[FIPS203,
 * Algorithm 11, MultiplyNTTs], and @[FIPS203, Algorithm 12,
 * BaseCaseMultiply].}
 *
 * @param[out] r       Output polynomial.
 * @param[in]  a       First input polynomial vector.
 * @param[in]  b       Second input polynomial vector.
 * @param[in]  b_cache Mulcache for the second input polynomial vector. Can
 *                     be computed via mlk_polyvec_mulcache_compute().
 */
MLK_INTERNAL_API
void mlk_polyvec_basemul_acc_montgomery_cached(
    mlk_poly *r, const mlk_polyvec *a, const mlk_polyvec *b,
    const mlk_polyvec_mulcache *b_cache)
__contract__(
  requires(memory_no_alias(r, sizeof(mlk_poly)))
  requires(memory_no_alias(a, sizeof(mlk_polyvec)))
  requires(memory_no_alias(b, sizeof(mlk_polyvec)))
  requires(memory_no_alias(b_cache, sizeof(mlk_polyvec_mulcache)))
  requires(forall(k1, 0, MLKEM_K,
     array_bound(a->vec[k1].coeffs, 0, MLKEM_N, 0, MLKEM_UINT12_LIMIT)))
  assigns(memory_slice(r, sizeof(mlk_poly)))
);

#define mlk_polyvec_mulcache_compute MLK_NAMESPACE_K(polyvec_mulcache_compute)
/**
 * Compute the mulcache for a vector of polynomials in NTT domain.
 *
 * The mulcache of a degree-2 polynomial b := b0 + b1*X in Fq[X]/(X^2-zeta)
 * is the value b1*zeta, needed when computing products of b in
 * Fq[X]/(X^2-zeta).
 *
 * The mulcache of a polynomial in NTT domain -- which is a 128-tuple of
 * degree-2 polynomials in Fq[X]/(X^2-zeta), for varying zeta, is the
 * 128-tuple of mulcaches of those polynomials.
 *
 * The mulcache of a vector of polynomials is the vector of mulcaches of
 * its entries.
 *
 * @spec{Caches `b_1 * \gamma` in @[FIPS203, Algorithm 12, BaseCaseMultiply,
 * L1].}
 *
 * @param[out] x Mulcache to be populated.
 * @param[in]  a Input polynomial vector.
 */
/*
 * NOTE: The default C implementation of this function populates
 * the mulcache with values in (-q,q), but this is not needed for the
 * higher level safety proofs, and thus not part of the spec.
 */
MLK_INTERNAL_API
void mlk_polyvec_mulcache_compute(mlk_polyvec_mulcache *x, const mlk_polyvec *a)
__contract__(
  requires(memory_no_alias(x, sizeof(mlk_polyvec_mulcache)))
  requires(memory_no_alias(a, sizeof(mlk_polyvec)))
  assigns(memory_slice(x, sizeof(mlk_polyvec_mulcache)))
);

#define mlk_polyvec_reduce MLK_NAMESPACE_K(polyvec_reduce)
/**
 * Apply Barrett reduction to each coefficient of each element of a vector
 * of polynomials. For details of the Barrett reduction see comments in
 * poly.c.
 *
 * @spec{Normalizes on unsigned canonical representatives ahead of calling
 * @[FIPS203, Compress_d, Eq (4.7)]. This is not made explicit in FIPS 203.}
 *
 * @param[in,out] r Input/output polynomial vector.
 */
/*
 * NOTE: The semantics of mlk_polyvec_reduce() is different in
 *       the reference implementation, which requires
 *       signed canonical output data. Unsigned canonical
 *       outputs are better suited to the only remaining
 *       use of mlk_poly_reduce() in the context of (de)serialization.
 */
MLK_INTERNAL_API
void mlk_polyvec_reduce(mlk_polyvec *r)
__contract__(
  requires(memory_no_alias(r, sizeof(mlk_polyvec)))
  assigns(memory_slice(r, sizeof(mlk_polyvec)))
  ensures(forall(k0, 0, MLKEM_K,
    array_bound(r->vec[k0].coeffs, 0, MLKEM_N, 0, MLKEM_Q)))
);

#define mlk_polyvec_add MLK_NAMESPACE_K(polyvec_add)
/**
 * Add vectors of polynomials.
 *
 * The coefficients of @p r and @p b must be such that the addition does
 * not overflow. Otherwise, the behaviour of this function is undefined.
 *
 * The coefficients returned in @p *r are in int16_t which is sufficient to
 * prove type-safety of calling units. Therefore, no stronger ensures clause
 * is required on this function.
 *
 * @spec{@[FIPS203, 2.4.5, Arithmetic With Polynomials and NTT
 * Representations]. Used in @[FIPS203, Algorithm 14 (K-PKE.Encrypt), L19].}
 *
 * @param[in,out] r Input-output vector of polynomials to be added to.
 * @param[in]     b Second input vector of polynomials.
 */
MLK_INTERNAL_API
void mlk_polyvec_add(mlk_polyvec *r, const mlk_polyvec *b)
__contract__(
  requires(memory_no_alias(r, sizeof(mlk_polyvec)))
  requires(memory_no_alias(b, sizeof(mlk_polyvec)))
  requires(forall(j0, 0, MLKEM_K,
          forall(k0, 0, MLKEM_N,
            (int32_t)r->vec[j0].coeffs[k0] + b->vec[j0].coeffs[k0] <= INT16_MAX)))
  requires(forall(j1, 0, MLKEM_K,
          forall(k1, 0, MLKEM_N,
            (int32_t)r->vec[j1].coeffs[k1] + b->vec[j1].coeffs[k1] >= INT16_MIN)))
  assigns(memory_slice(r, sizeof(mlk_polyvec)))
);

#if !defined(MLK_CONFIG_NO_KEYPAIR_API)
#define mlk_polyvec_tomont MLK_NAMESPACE_K(polyvec_tomont)
/**
 * In-place conversion of all coefficients of a polynomial vector from the
 * normal domain to the Montgomery domain.
 *
 * Bounds: output < MLKEM_Q in absolute value.
 *
 * @spec{Internal normalization required in `mlk_indcpa_keypair_derand` as
 * part of matrix-vector multiplication @[FIPS203, Algorithm 13, K-PKE.KeyGen,
 * L18].}
 *
 * @param[in,out] r Input/output polynomial vector.
 */
MLK_INTERNAL_API
void mlk_polyvec_tomont(mlk_polyvec *r)
__contract__(
  requires(memory_no_alias(r, sizeof(mlk_polyvec)))
  assigns(memory_slice(r, sizeof(mlk_polyvec)))
  ensures(forall(j, 0, MLKEM_K,
    array_abs_bound(r->vec[j].coeffs, 0, MLKEM_N, MLKEM_Q)))
);
#endif /* !MLK_CONFIG_NO_KEYPAIR_API */

#if !defined(MLK_CONFIG_NO_KEYPAIR_API) ||                              \
    (MLKEM_ETA1 == MLKEM_ETA2 && (!defined(MLK_CONFIG_NO_ENCAPS_API) || \
                                  !defined(MLK_CONFIG_NO_DECAPS_API)))
#define mlk_poly_getnoise_eta1_4x MLK_NAMESPACE_K(poly_getnoise_eta1_4x)
/**
 * Batch sample four polynomials deterministically from a seed and nonces,
 * with output polynomials close to centered binomial distribution with
 * parameter MLKEM_ETA1.
 *
 * @spec{Implements 4x `SamplePolyCBD_{eta1} (PRF_{eta1} (sigma, N))`:
 * @[FIPS203, Algorithm 8, SamplePolyCBD_eta] and @[FIPS203, Eq (4.3),
 * PRF_eta]. `SamplePolyCBD_{eta1} (PRF_{eta1} (sigma, N))` appears in
 * @[FIPS203, Algorithm 13, K-PKE.KeyGen, L{9, 13}] and @[FIPS203,
 * Algorithm 14, K-PKE.Encrypt, L10].}
 *
 * @param[out] r0     Output polynomial.
 * @param[out] r1     Output polynomial.
 * @param[out] r2     Output polynomial.
 * @param[out] r3     Output polynomial. May be NULL.
 * @param[in]  seed   Input seed (of length MLKEM_SYMBYTES bytes).
 * @param      nonce0 One-byte input nonce.
 * @param      nonce1 One-byte input nonce.
 * @param      nonce2 One-byte input nonce.
 * @param      nonce3 One-byte input nonce.
 */
MLK_INTERNAL_API
void mlk_poly_getnoise_eta1_4x(mlk_poly *r0, mlk_poly *r1, mlk_poly *r2,
                               mlk_poly *r3, const uint8_t seed[MLKEM_SYMBYTES],
                               uint8_t nonce0, uint8_t nonce1, uint8_t nonce2,
                               uint8_t nonce3)
__contract__(
  requires(memory_no_alias(seed, MLKEM_SYMBYTES))
  requires(memory_no_alias(r0, sizeof(mlk_poly)))
  requires(memory_no_alias(r1, sizeof(mlk_poly)))
  requires(memory_no_alias(r2, sizeof(mlk_poly)))
  requires(r3 == NULL || memory_no_alias(r3, sizeof(mlk_poly)))
  assigns(memory_slice(r0, sizeof(mlk_poly)))
  assigns(memory_slice(r1, sizeof(mlk_poly)))
  assigns(memory_slice(r2, sizeof(mlk_poly)))
  assigns(r3 != NULL: memory_slice(r3, sizeof(mlk_poly)))
  ensures(array_abs_bound(r0->coeffs,0, MLKEM_N, MLKEM_ETA1 + 1))
  ensures(array_abs_bound(r1->coeffs,0, MLKEM_N, MLKEM_ETA1 + 1))
  ensures(array_abs_bound(r2->coeffs,0, MLKEM_N, MLKEM_ETA1 + 1))
  ensures(r3 != NULL ==> array_abs_bound(r3->coeffs,0, MLKEM_N, MLKEM_ETA1 + 1))
);

#if MLKEM_ETA1 == MLKEM_ETA2
/*
 * We only require mlk_poly_getnoise_eta2_4x for ml-kem-768 and ml-kem-1024
 * where MLKEM_ETA2 = MLKEM_ETA1 = 2.
 * For ml-kem-512, mlk_poly_getnoise_eta1122_4x is used instead.
 */
#define mlk_poly_getnoise_eta2_4x mlk_poly_getnoise_eta1_4x
#endif /* MLKEM_ETA1 == MLKEM_ETA2 */
#endif /* !MLK_CONFIG_NO_KEYPAIR_API || (MLKEM_ETA1 == MLKEM_ETA2 && \
          (!MLK_CONFIG_NO_ENCAPS_API || !MLK_CONFIG_NO_DECAPS_API)) */

#if (MLKEM_K == 2 || MLKEM_K == 4) && \
    (!defined(MLK_CONFIG_NO_ENCAPS_API) || !defined(MLK_CONFIG_NO_DECAPS_API))
#define mlk_poly_getnoise_eta2 MLK_NAMESPACE_K(poly_getnoise_eta2)
/**
 * Sample a polynomial deterministically from a seed and a nonce, with
 * output polynomial close to centered binomial distribution with parameter
 * MLKEM_ETA2.
 *
 * @spec{Implements `SamplePolyCBD_{eta2} (PRF_{eta2} (sigma, N))`:
 * @[FIPS203, Algorithm 8, SamplePolyCBD_eta] and @[FIPS203, Eq (4.3),
 * PRF_eta]. `SamplePolyCBD_{eta2} (PRF_{eta2} (sigma, N))` appears in
 * @[FIPS203, Algorithm 14, K-PKE.Encrypt, L14].}
 *
 * @param[out] r     Output polynomial.
 * @param[in]  seed  Input seed (of length MLKEM_SYMBYTES bytes).
 * @param      nonce One-byte input nonce.
 */
MLK_INTERNAL_API
void mlk_poly_getnoise_eta2(mlk_poly *r, const uint8_t seed[MLKEM_SYMBYTES],
                            uint8_t nonce)
__contract__(
  requires(memory_no_alias(r, sizeof(mlk_poly)))
  requires(memory_no_alias(seed, MLKEM_SYMBYTES))
  assigns(memory_slice(r, sizeof(mlk_poly)))
  ensures(array_abs_bound(r->coeffs, 0, MLKEM_N, MLKEM_ETA2 + 1))
);
#endif /* (MLKEM_K == 2 || MLKEM_K == 4) && (!MLK_CONFIG_NO_ENCAPS_API || \
          !MLK_CONFIG_NO_DECAPS_API) */

#if MLKEM_K == 2 && \
    (!defined(MLK_CONFIG_NO_ENCAPS_API) || !defined(MLK_CONFIG_NO_DECAPS_API))
#define mlk_poly_getnoise_eta1122_4x MLK_NAMESPACE_K(poly_getnoise_eta1122_4x)
/**
 * Batch sample four polynomials deterministically from a seed and nonces,
 * with output polynomials close to centered binomial distribution with
 * parameter MLKEM_ETA1 and MLKEM_ETA2.
 *
 * @spec{Implements two instances each of
 * `SamplePolyCBD_{eta1} (PRF_{eta1} (sigma, N))` and
 * `SamplePolyCBD_{eta2} (PRF_{eta2} (sigma, N))`:
 * @[FIPS203, Algorithm 8, SamplePolyCBD_eta] and @[FIPS203, Eq (4.3),
 * PRF_eta]. `SamplePolyCBD_{eta2} (PRF_{eta2} (sigma, N))` appears in
 * @[FIPS203, Algorithm 14, K-PKE.Encrypt, L14].}
 *
 * @param[out] r0     Output polynomial.
 * @param[out] r1     Output polynomial.
 * @param[out] r2     Output polynomial.
 * @param[out] r3     Output polynomial.
 * @param[in]  seed   Input seed (of length MLKEM_SYMBYTES bytes).
 * @param      nonce0 One-byte input nonce.
 * @param      nonce1 One-byte input nonce.
 * @param      nonce2 One-byte input nonce.
 * @param      nonce3 One-byte input nonce.
 */
MLK_INTERNAL_API
void mlk_poly_getnoise_eta1122_4x(mlk_poly *r0, mlk_poly *r1, mlk_poly *r2,
                                  mlk_poly *r3,
                                  const uint8_t seed[MLKEM_SYMBYTES],
                                  uint8_t nonce0, uint8_t nonce1,
                                  uint8_t nonce2, uint8_t nonce3)
__contract__(
  requires(memory_no_alias(r0, sizeof(mlk_poly)))
  requires(memory_no_alias(r1, sizeof(mlk_poly)))
  requires(memory_no_alias(r2, sizeof(mlk_poly)))
  requires(memory_no_alias(r3, sizeof(mlk_poly)))
  requires(memory_no_alias(seed, MLKEM_SYMBYTES))
  assigns(memory_slice(r0, sizeof(mlk_poly)))
  assigns(memory_slice(r1, sizeof(mlk_poly)))
  assigns(memory_slice(r2, sizeof(mlk_poly)))
  assigns(memory_slice(r3, sizeof(mlk_poly)))
  ensures(array_abs_bound(r0->coeffs,0, MLKEM_N, MLKEM_ETA1 + 1)
       && array_abs_bound(r1->coeffs,0, MLKEM_N, MLKEM_ETA1 + 1)
       && array_abs_bound(r2->coeffs,0, MLKEM_N, MLKEM_ETA2 + 1)
       && array_abs_bound(r3->coeffs,0, MLKEM_N, MLKEM_ETA2 + 1))
);
#endif /* MLKEM_K == 2 && (!MLK_CONFIG_NO_ENCAPS_API || \
          !MLK_CONFIG_NO_DECAPS_API) */

#endif /* !MLK_POLY_K_H */
