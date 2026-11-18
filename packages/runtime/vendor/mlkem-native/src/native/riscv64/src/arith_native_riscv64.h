/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */
#ifndef MLK_NATIVE_RISCV64_SRC_ARITH_NATIVE_RISCV64_H
#define MLK_NATIVE_RISCV64_SRC_ARITH_NATIVE_RISCV64_H

#include "../../../common.h"

#define mlk_rv64v_poly_ntt MLK_NAMESPACE(ntt_riscv64)
void mlk_rv64v_poly_ntt(int16_t *);

#if !defined(MLK_CONFIG_NO_ENCAPS_API) || !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_rv64v_poly_invntt_tomont MLK_NAMESPACE(intt_riscv64)
void mlk_rv64v_poly_invntt_tomont(int16_t *r);
#endif

#define mlk_rv64v_poly_basemul_mont_add_k2 MLK_NAMESPACE(basemul_add_k2_riscv64)
void mlk_rv64v_poly_basemul_mont_add_k2(int16_t *r, const int16_t *a,
                                        const int16_t *b);

#define mlk_rv64v_poly_basemul_mont_add_k3 MLK_NAMESPACE(basemul_add_k3_riscv64)
void mlk_rv64v_poly_basemul_mont_add_k3(int16_t *r, const int16_t *a,
                                        const int16_t *b);

#define mlk_rv64v_poly_basemul_mont_add_k4 MLK_NAMESPACE(basemul_add_k4_riscv64)
void mlk_rv64v_poly_basemul_mont_add_k4(int16_t *r, const int16_t *a,
                                        const int16_t *b);

#if !defined(MLK_CONFIG_NO_KEYPAIR_API)
#define mlk_rv64v_poly_tomont MLK_NAMESPACE(tomont_riscv64)
void mlk_rv64v_poly_tomont(int16_t *r);
#endif

#define mlk_rv64v_poly_reduce MLK_NAMESPACE(reduce_riscv64)
void mlk_rv64v_poly_reduce(int16_t *r);

#define mlk_rv64v_poly_add MLK_NAMESPACE(poly_add_riscv64)
void mlk_rv64v_poly_add(int16_t *r, const int16_t *a, const int16_t *b);

#define mlk_rv64v_poly_sub MLK_NAMESPACE(poly_sub_riscv64)
void mlk_rv64v_poly_sub(int16_t *r, const int16_t *a, const int16_t *b);

#define mlk_rv64v_rej_uniform MLK_NAMESPACE(rj_uniform_riscv64)
MLK_MUST_CHECK_RETURN_VALUE
unsigned int mlk_rv64v_rej_uniform(int16_t *r, unsigned int len,
                                   const uint8_t *buf, unsigned int buflen);

#endif /* !MLK_NATIVE_RISCV64_SRC_ARITH_NATIVE_RISCV64_H */
