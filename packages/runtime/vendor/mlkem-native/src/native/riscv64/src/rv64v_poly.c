/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

/* === ML-KEM NTT using RISC-V Vector intrinstics */

#include "../../../common.h"

#if defined(MLK_ARITH_BACKEND_RISCV64) && \
    !defined(MLK_CONFIG_MULTILEVEL_NO_SHARED)

#include <riscv_vector.h>

#include "arith_native_riscv64.h"
#include "rv64v_debug.h"

/* Montgomery reduction constants */
/* check-magic: -3327 == signed_mod(pow(MLKEM_Q,-1,2^16), 2^16) */
#define MLK_RVV_QI -3327

/* check-magic: 2285 == unsigned_mod(2^16, MLKEM_Q) */
#define MLK_RVV_MONT_R1 2285

/* check-magic: 1353 == pow(2, 32, MLKEM_Q) */
#define MLK_RVV_MONT_R2 1353

/* check-magic: 1441 == pow(2,32-7,MLKEM_Q) */
#define MLK_RVV_MONT_NR 1441

static MLK_INLINE vint16m1_t fq_redc(vint16m1_t rh, vint16m1_t rl, size_t vl)
{
  vint16m1_t t;

  t = __riscv_vmul_vx_i16m1(rl, MLK_RVV_QI, vl); /* t = l * Q^-1   */
  t = __riscv_vmulh_vx_i16m1(t, MLKEM_Q, vl);    /* t = (t*Q) / R  */
  t = __riscv_vsub_vv_i16m1(rh, t, vl);          /* t = h - t      */

  return t;
}

/* Narrowing reduction */

static MLK_INLINE vint16m1_t fq_redc2(vint32m2_t z, size_t vl)
{
  vint16m1_t t;

  t = __riscv_vmul_vx_i16m1(__riscv_vncvt_x_x_w_i16m1(z, vl), MLK_RVV_QI,
                            vl); /*    t = l * Q^-1 */
  z = __riscv_vsub_vv_i32m2(z, __riscv_vwmul_vx_i32m2(t, MLKEM_Q, vl),
                            vl); /*    x = (x - (t*Q)) */
  t = __riscv_vnsra_wx_i16m1(z, 16, vl);

  return t;
}

/* Narrowing Barrett */

static MLK_INLINE vint16m1_t fq_barrett(vint16m1_t a, size_t vl)
{
  vint16m1_t t;
  const int16_t v = ((1 << 26) + MLKEM_Q / 2) / MLKEM_Q;

  t = __riscv_vmulh_vx_i16m1(a, v, vl);
  t = __riscv_vadd_vx_i16m1(t, 1 << (25 - 16), vl);
  t = __riscv_vsra_vx_i16m1(t, 26 - 16, vl);
  t = __riscv_vmul_vx_i16m1(t, MLKEM_Q, vl);
  t = __riscv_vsub_vv_i16m1(a, t, vl);

  mlk_assert_abs_bound_int16m1(t, vl, MLKEM_Q_HALF);
  return t;
}

/* Conditionally add Q (if negative).
 *
 * Constant-time note: We deliberately avoid a `vmslt` + masked `vadd_mu`
 * here. RVV 1.0 does not mandate mask-population-independent latency for
 * masked ops, and Zvkt's DIEL guarantee does not cover the v0 mask
 * register. Using an arithmetic-shift sign mask keeps all operands in the
 * Zvkt-covered set and matches the idiom used in the portable C
 * (mlk_ct_cmask_neg_i16, verify.h) and AArch64
 * (mlkem_poly_reduce_aarch64_asm.S) implementations. */

static MLK_INLINE vint16m1_t fq_cadd(vint16m1_t rx, size_t vl)
{
  vint16m1_t m;

  m = __riscv_vsra_vx_i16m1(rx, 15, vl);     /* m = (x < 0) ? -1 : 0 */
  m = __riscv_vand_vx_i16m1(m, MLKEM_Q, vl); /* m = (x < 0) ?  Q : 0 */
  rx = __riscv_vadd_vv_i16m1(rx, m, vl);     /* x += m               */
  return rx;
}

/* Montgomery multiply: vector-vector  */

static MLK_INLINE vint16m1_t fq_mul_vv(vint16m1_t rx, vint16m1_t ry, size_t vl)
{
  vint16m1_t rl, rh;

  rh = __riscv_vmulh_vv_i16m1(rx, ry, vl); /*  h = (x * y) / R */
  rl = __riscv_vmul_vv_i16m1(rx, ry, vl);  /*  l = (x * y) % R */
  return fq_redc(rh, rl, vl);
}

/* Montgomery multiply: vector-scalar  */

static MLK_INLINE vint16m1_t fq_mul_vx(vint16m1_t rx, int16_t ry, size_t vl)
{
  vint16m1_t rl, rh;

  rh = __riscv_vmulh_vx_i16m1(rx, ry, vl); /*  h = (x * y) / R */
  rl = __riscv_vmul_vx_i16m1(rx, ry, vl);  /*  l = (x * y) % R */
  return fq_redc(rh, rl, vl);
}

/* full normalization  */

static MLK_INLINE vint16m1_t fq_mulq_vx(vint16m1_t rx, int16_t ry, size_t vl)
{
  vint16m1_t result;

  result = fq_mul_vx(rx, ry, vl);

  mlk_assert_abs_bound_int16m1(result, vl, MLKEM_Q);
  return result;
}

/* create a permutation for swapping index bits a and b, a < b */

static vuint16m2_t bitswap_perm(unsigned a, unsigned b, size_t vl)
{
  const vuint16m2_t v2id = __riscv_vid_v_u16m2(vl);

  vuint16m2_t xa, xb;
  xa = __riscv_vsrl_vx_u16m2(v2id, b - a, vl);
  xa = __riscv_vxor_vv_u16m2(xa, v2id, vl);
  xa = __riscv_vand_vx_u16m2(xa, (1 << a), vl);
  xb = __riscv_vsll_vx_u16m2(xa, b - a, vl);
  xa = __riscv_vxor_vv_u16m2(xa, xb, vl);
  xa = __riscv_vxor_vv_u16m2(v2id, xa, vl);
  return xa;
}

/**
 * Compute negacyclic number-theoretic transform (NTT) of a polynomial in
 * place; input assumed to be in normal order, output in bitreversed order.
 *
 * @param[in,out] r Input/output polynomial.
 */

/* Forward / Cooley-Tukey butterfly operation */

#define MLK_RVV_CT_BFLY_FX(u0, u1, ut, uc, vl, layer)            \
  {                                                              \
    mlk_assert_abs_bound(&uc, 1, MLKEM_Q_HALF);                  \
                                                                 \
    ut = fq_mul_vx(u1, uc, vl);                                  \
    mlk_assert_abs_bound_int16m1(ut, vl, MLKEM_Q);               \
                                                                 \
    u1 = __riscv_vsub_vv_i16m1(u0, ut, vl);                      \
    u0 = __riscv_vadd_vv_i16m1(u0, ut, vl);                      \
    mlk_assert_abs_bound_int16m1(u0, vl, (layer + 1) * MLKEM_Q); \
    mlk_assert_abs_bound_int16m1(u1, vl, (layer + 1) * MLKEM_Q); \
  }

#define MLK_RVV_CT_BFLY_FV(u0, u1, ut, uc, vl, layer)            \
  {                                                              \
    mlk_assert_abs_bound_int16m1(uc, vl, MLKEM_Q_HALF);          \
                                                                 \
    ut = fq_mul_vv(u1, uc, vl);                                  \
    mlk_assert_abs_bound_int16m1(ut, vl, MLKEM_Q);               \
                                                                 \
    u1 = __riscv_vsub_vv_i16m1(u0, ut, vl);                      \
    u0 = __riscv_vadd_vv_i16m1(u0, ut, vl);                      \
    mlk_assert_abs_bound_int16m1(u0, vl, (layer + 1) * MLKEM_Q); \
    mlk_assert_abs_bound_int16m1(u1, vl, (layer + 1) * MLKEM_Q); \
  }

static vint16m2_t mlk_rv64v_ntt2(vint16m2_t vp, vint16m1_t cz)
{
  size_t vl = 16; /* We work with 256-bit vectors of 16x16-bit elements */
  size_t vl2 = 2 * vl;

  const vuint16m2_t v2p8 = bitswap_perm(3, 4, vl2);
  const vuint16m2_t v2p4 = bitswap_perm(2, 4, vl2);
  const vuint16m2_t v2p2 = bitswap_perm(1, 4, vl2);

  /* p1 = p8(p4(p2)) */
  const vuint16m2_t v2p1 = __riscv_vrgather_vv_u16m2(
      __riscv_vrgather_vv_u16m2(v2p2, v2p4, vl2), v2p8, vl2);

  const vuint16m1_t vid = __riscv_vid_v_u16m1(vl);
  const vuint16m1_t cs8 =
      __riscv_vadd_vx_u16m1(__riscv_vsrl_vx_u16m1(vid, 3, vl), 2, vl);
  const vuint16m1_t cs4 =
      __riscv_vadd_vx_u16m1(__riscv_vsrl_vx_u16m1(vid, 2, vl), 2 + 2, vl);
  const vuint16m1_t cs2 =
      __riscv_vadd_vx_u16m1(__riscv_vsrl_vx_u16m1(vid, 1, vl), 2 + 2 + 4, vl);

  vint16m1_t vt, c0, t0, t1;

  /* swap 8  */
  vp = __riscv_vrgatherei16_vv_i16m2(vp, v2p8, vl2);
  t0 = __riscv_vget_v_i16m2_i16m1(vp, 0);
  t1 = __riscv_vget_v_i16m2_i16m1(vp, 1);

  c0 = __riscv_vrgather_vv_i16m1(cz, cs8, vl);
  MLK_RVV_CT_BFLY_FV(t0, t1, vt, c0, vl, 5);

  /* swap 4  */
  vp = __riscv_vcreate_v_i16m1_i16m2(t0, t1);
  vp = __riscv_vrgatherei16_vv_i16m2(vp, v2p4, vl2);
  t0 = __riscv_vget_v_i16m2_i16m1(vp, 0);
  t1 = __riscv_vget_v_i16m2_i16m1(vp, 1);

  c0 = __riscv_vrgather_vv_i16m1(cz, cs4, vl);
  MLK_RVV_CT_BFLY_FV(t0, t1, vt, c0, vl, 6);

  /* swap 2  */
  vp = __riscv_vcreate_v_i16m1_i16m2(t0, t1);
  vp = __riscv_vrgatherei16_vv_i16m2(vp, v2p2, vl2);
  t0 = __riscv_vget_v_i16m2_i16m1(vp, 0);
  t1 = __riscv_vget_v_i16m2_i16m1(vp, 1);

  c0 = __riscv_vrgather_vv_i16m1(cz, cs2, vl);
  MLK_RVV_CT_BFLY_FV(t0, t1, vt, c0, vl, 7);

  /* reorganize  */
  vp = __riscv_vcreate_v_i16m1_i16m2(t0, t1);
  vp = __riscv_vrgatherei16_vv_i16m2(vp, v2p1, vl2);

  return vp;
}

/* Only for VLEN=256 for now */
void mlk_rv64v_poly_ntt(int16_t *r)
{
/* zetas can be compiled into vector constants; don't pass as a pointer */
#include "rv64v_zetas.inc"

  size_t vl = 16; /* We work with 256-bit vectors of 16x16-bit elements */
  size_t vl2 = 2 * vl;

  vint16m1_t vt;
  vint16m1_t v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, va, vb, vc, vd, ve, vf;

  const vint16m1_t z0 = __riscv_vle16_v_i16m1(&zeta[0x00], vl);
  const vint16m1_t z2 = __riscv_vle16_v_i16m1(&zeta[0x10], vl);
  const vint16m1_t z4 = __riscv_vle16_v_i16m1(&zeta[0x20], vl);
  const vint16m1_t z6 = __riscv_vle16_v_i16m1(&zeta[0x30], vl);
  const vint16m1_t z8 = __riscv_vle16_v_i16m1(&zeta[0x40], vl);
  const vint16m1_t za = __riscv_vle16_v_i16m1(&zeta[0x50], vl);
  const vint16m1_t zc = __riscv_vle16_v_i16m1(&zeta[0x60], vl);
  const vint16m1_t ze = __riscv_vle16_v_i16m1(&zeta[0x70], vl);

  v0 = __riscv_vle16_v_i16m1(&r[0x00], vl);
  v1 = __riscv_vle16_v_i16m1(&r[0x10], vl);
  v2 = __riscv_vle16_v_i16m1(&r[0x20], vl);
  v3 = __riscv_vle16_v_i16m1(&r[0x30], vl);
  v4 = __riscv_vle16_v_i16m1(&r[0x40], vl);
  v5 = __riscv_vle16_v_i16m1(&r[0x50], vl);
  v6 = __riscv_vle16_v_i16m1(&r[0x60], vl);
  v7 = __riscv_vle16_v_i16m1(&r[0x70], vl);
  v8 = __riscv_vle16_v_i16m1(&r[0x80], vl);
  v9 = __riscv_vle16_v_i16m1(&r[0x90], vl);
  va = __riscv_vle16_v_i16m1(&r[0xa0], vl);
  vb = __riscv_vle16_v_i16m1(&r[0xb0], vl);
  vc = __riscv_vle16_v_i16m1(&r[0xc0], vl);
  vd = __riscv_vle16_v_i16m1(&r[0xd0], vl);
  ve = __riscv_vle16_v_i16m1(&r[0xe0], vl);
  vf = __riscv_vle16_v_i16m1(&r[0xf0], vl);

  MLK_RVV_CT_BFLY_FX(v0, v8, vt, zeta[0x01], vl, 1);
  MLK_RVV_CT_BFLY_FX(v1, v9, vt, zeta[0x01], vl, 1);
  MLK_RVV_CT_BFLY_FX(v2, va, vt, zeta[0x01], vl, 1);
  MLK_RVV_CT_BFLY_FX(v3, vb, vt, zeta[0x01], vl, 1);
  MLK_RVV_CT_BFLY_FX(v4, vc, vt, zeta[0x01], vl, 1);
  MLK_RVV_CT_BFLY_FX(v5, vd, vt, zeta[0x01], vl, 1);
  MLK_RVV_CT_BFLY_FX(v6, ve, vt, zeta[0x01], vl, 1);
  MLK_RVV_CT_BFLY_FX(v7, vf, vt, zeta[0x01], vl, 1);

  MLK_RVV_CT_BFLY_FX(v0, v4, vt, zeta[0x10], vl, 2);
  MLK_RVV_CT_BFLY_FX(v1, v5, vt, zeta[0x10], vl, 2);
  MLK_RVV_CT_BFLY_FX(v2, v6, vt, zeta[0x10], vl, 2);
  MLK_RVV_CT_BFLY_FX(v3, v7, vt, zeta[0x10], vl, 2);
  MLK_RVV_CT_BFLY_FX(v8, vc, vt, zeta[0x11], vl, 2);
  MLK_RVV_CT_BFLY_FX(v9, vd, vt, zeta[0x11], vl, 2);
  MLK_RVV_CT_BFLY_FX(va, ve, vt, zeta[0x11], vl, 2);
  MLK_RVV_CT_BFLY_FX(vb, vf, vt, zeta[0x11], vl, 2);

  MLK_RVV_CT_BFLY_FX(v0, v2, vt, zeta[0x20], vl, 3);
  MLK_RVV_CT_BFLY_FX(v1, v3, vt, zeta[0x20], vl, 3);
  MLK_RVV_CT_BFLY_FX(v4, v6, vt, zeta[0x21], vl, 3);
  MLK_RVV_CT_BFLY_FX(v5, v7, vt, zeta[0x21], vl, 3);
  MLK_RVV_CT_BFLY_FX(v8, va, vt, zeta[0x30], vl, 3);
  MLK_RVV_CT_BFLY_FX(v9, vb, vt, zeta[0x30], vl, 3);
  MLK_RVV_CT_BFLY_FX(vc, ve, vt, zeta[0x31], vl, 3);
  MLK_RVV_CT_BFLY_FX(vd, vf, vt, zeta[0x31], vl, 3);

  MLK_RVV_CT_BFLY_FX(v0, v1, vt, zeta[0x40], vl, 4);
  MLK_RVV_CT_BFLY_FX(v2, v3, vt, zeta[0x41], vl, 4);
  MLK_RVV_CT_BFLY_FX(v4, v5, vt, zeta[0x50], vl, 4);
  MLK_RVV_CT_BFLY_FX(v6, v7, vt, zeta[0x51], vl, 4);
  MLK_RVV_CT_BFLY_FX(v8, v9, vt, zeta[0x60], vl, 4);
  MLK_RVV_CT_BFLY_FX(va, vb, vt, zeta[0x61], vl, 4);
  MLK_RVV_CT_BFLY_FX(vc, vd, vt, zeta[0x70], vl, 4);
  MLK_RVV_CT_BFLY_FX(ve, vf, vt, zeta[0x71], vl, 4);

  __riscv_vse16_v_i16m2(
      &r[0x00], mlk_rv64v_ntt2(__riscv_vcreate_v_i16m1_i16m2(v0, v1), z0), vl2);
  __riscv_vse16_v_i16m2(
      &r[0x20], mlk_rv64v_ntt2(__riscv_vcreate_v_i16m1_i16m2(v2, v3), z2), vl2);
  __riscv_vse16_v_i16m2(
      &r[0x40], mlk_rv64v_ntt2(__riscv_vcreate_v_i16m1_i16m2(v4, v5), z4), vl2);
  __riscv_vse16_v_i16m2(
      &r[0x60], mlk_rv64v_ntt2(__riscv_vcreate_v_i16m1_i16m2(v6, v7), z6), vl2);
  __riscv_vse16_v_i16m2(
      &r[0x80], mlk_rv64v_ntt2(__riscv_vcreate_v_i16m1_i16m2(v8, v9), z8), vl2);
  __riscv_vse16_v_i16m2(
      &r[0xa0], mlk_rv64v_ntt2(__riscv_vcreate_v_i16m1_i16m2(va, vb), za), vl2);
  __riscv_vse16_v_i16m2(
      &r[0xc0], mlk_rv64v_ntt2(__riscv_vcreate_v_i16m1_i16m2(vc, vd), zc), vl2);
  __riscv_vse16_v_i16m2(
      &r[0xe0], mlk_rv64v_ntt2(__riscv_vcreate_v_i16m1_i16m2(ve, vf), ze), vl2);
}

#if !defined(MLK_CONFIG_NO_ENCAPS_API) || !defined(MLK_CONFIG_NO_DECAPS_API)
/* Reverse / Gentleman-Sande butterfly operation */

#define MLK_RVV_GS_BFLY_RX(u0, u1, ut, uc, vl) \
  {                                            \
    ut = __riscv_vsub_vv_i16m1(u0, u1, vl);    \
    u0 = __riscv_vadd_vv_i16m1(u0, u1, vl);    \
    u1 = fq_mul_vx(ut, uc, vl);                \
  }

#define MLK_RVV_GS_BFLY_RV(u0, u1, ut, uc, vl) \
  {                                            \
    ut = __riscv_vsub_vv_i16m1(u0, u1, vl);    \
    u0 = __riscv_vadd_vv_i16m1(u0, u1, vl);    \
    u1 = fq_mul_vv(ut, uc, vl);                \
  }

static vint16m2_t mlk_rv64v_intt2(vint16m2_t vp, vint16m1_t cz)
{
  size_t vl = 16; /* We work with 256-bit vectors of 16x16-bit elements */
  size_t vl2 = 2 * vl;

  const vuint16m2_t v2p8 = bitswap_perm(3, 4, vl2);
  const vuint16m2_t v2p4 = bitswap_perm(2, 4, vl2);
  const vuint16m2_t v2p2 = bitswap_perm(1, 4, vl2);

  /* p0 = p2(p4(p8)) */
  const vuint16m2_t v2p0 = __riscv_vrgather_vv_u16m2(
      __riscv_vrgather_vv_u16m2(v2p8, v2p4, vl2), v2p2, vl2);

  const vuint16m1_t vid = __riscv_vid_v_u16m1(vl);
  const vuint16m1_t cs8 =
      __riscv_vadd_vx_u16m1(__riscv_vsrl_vx_u16m1(vid, 3, vl), 2, vl);
  const vuint16m1_t cs4 =
      __riscv_vadd_vx_u16m1(__riscv_vsrl_vx_u16m1(vid, 2, vl), 2 + 2, vl);
  const vuint16m1_t cs2 =
      __riscv_vadd_vx_u16m1(__riscv_vsrl_vx_u16m1(vid, 1, vl), 2 + 2 + 4, vl);

  vint16m1_t t0, t1, c0, vt;

  /* initial permute */
  vp = __riscv_vrgatherei16_vv_i16m2(vp, v2p0, vl2);
  t0 = __riscv_vget_v_i16m2_i16m1(vp, 0);
  t1 = __riscv_vget_v_i16m2_i16m1(vp, 1);

  /* pre-scale */
  t0 = fq_mulq_vx(t0, MLK_RVV_MONT_NR, vl);
  t1 = fq_mulq_vx(t1, MLK_RVV_MONT_NR, vl);

  /* absolute bounds: < t0 < q, t1 < q */
  mlk_assert_abs_bound_int16m1(t0, vl, MLKEM_Q);
  mlk_assert_abs_bound_int16m1(t1, vl, MLKEM_Q);

  c0 = __riscv_vrgather_vv_i16m1(cz, cs2, vl);
  MLK_RVV_GS_BFLY_RV(t0, t1, vt, c0, vl);

  /* absolute bounds: < t0 < 2*q, t1 < q */
  mlk_assert_abs_bound_int16m1(t0, vl, 2 * MLKEM_Q);
  mlk_assert_abs_bound_int16m1(t1, vl, MLKEM_Q);

  /* swap 2  */
  vp = __riscv_vcreate_v_i16m1_i16m2(t0, t1);
  vp = __riscv_vrgatherei16_vv_i16m2(vp, v2p2, vl2);
  t0 = __riscv_vget_v_i16m2_i16m1(vp, 0);
  t1 = __riscv_vget_v_i16m2_i16m1(vp, 1);
  c0 = __riscv_vrgather_vv_i16m1(cz, cs4, vl);
  MLK_RVV_GS_BFLY_RV(t0, t1, vt, c0, vl);

  /* absolute bounds: t0 < 4*q, t1 < q */
  mlk_assert_abs_bound_int16m1(t0, vl, 4 * MLKEM_Q);
  mlk_assert_abs_bound_int16m1(t1, vl, MLKEM_Q);

  /* swap 4  */
  vp = __riscv_vcreate_v_i16m1_i16m2(t0, t1);
  vp = __riscv_vrgatherei16_vv_i16m2(vp, v2p4, vl2);
  t0 = __riscv_vget_v_i16m2_i16m1(vp, 0);
  t1 = __riscv_vget_v_i16m2_i16m1(vp, 1);
  c0 = __riscv_vrgather_vv_i16m1(cz, cs8, vl);
  MLK_RVV_GS_BFLY_RV(t0, t1, vt, c0, vl);

  /* absolute bounds: < 8*q */
  mlk_assert_abs_bound_int16m1(t0, vl, 8 * MLKEM_Q);
  mlk_assert_abs_bound_int16m1(t1, vl, MLKEM_Q);

  t0 = fq_mulq_vx(t0, MLK_RVV_MONT_R1, vl);

  /* absolute bounds: < q */
  mlk_assert_abs_bound_int16m1(t0, vl, MLKEM_Q);
  mlk_assert_abs_bound_int16m1(t1, vl, MLKEM_Q);

  /* swap 8  */
  vp = __riscv_vcreate_v_i16m1_i16m2(t0, t1);
  vp = __riscv_vrgatherei16_vv_i16m2(vp, v2p8, vl2);

  return vp;
}

#define MLK_RV64V_ABS_BOUNDS16(vl, v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, va, \
                               vb, vc, vd, ve, vf, b0, b1, b2, b3, b4, b5, b6, \
                               b7, b8, b9, ba, bb, bc, bd, be, bf)             \
  do                                                                           \
  {                                                                            \
    mlk_assert_abs_bound_int16m1(v0, vl, (b0) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(v1, vl, (b1) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(v2, vl, (b2) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(v3, vl, (b3) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(v4, vl, (b4) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(v5, vl, (b5) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(v6, vl, (b6) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(v7, vl, (b7) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(v8, vl, (b8) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(v9, vl, (b9) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(va, vl, (ba) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(vb, vl, (bb) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(vc, vl, (bc) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(vd, vl, (bd) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(ve, vl, (be) * MLKEM_Q);                      \
    mlk_assert_abs_bound_int16m1(vf, vl, (bf) * MLKEM_Q);                      \
  } while (0)


/**
 * Compute the inverse negacyclic number-theoretic transform (NTT) of a
 * polynomial in place; input assumed to be in bitreversed order, output in
 * normal order.
 *
 * @param[in,out] r Input/output polynomial.
 */
/* Only for VLEN=256 for now */
void mlk_rv64v_poly_invntt_tomont(int16_t *r)
{
/* zetas can be compiled into vector constants; don't pass as a pointer */
#include "rv64v_izetas.inc"

  size_t vl = 16; /* We work with 256-bit vectors of 16x16-bit elements */
  size_t vl2 = 2 * vl;

  const vint16m1_t z0 = __riscv_vle16_v_i16m1(&izeta[0x00], vl);
  const vint16m1_t z2 = __riscv_vle16_v_i16m1(&izeta[0x10], vl);
  const vint16m1_t z4 = __riscv_vle16_v_i16m1(&izeta[0x20], vl);
  const vint16m1_t z6 = __riscv_vle16_v_i16m1(&izeta[0x30], vl);
  const vint16m1_t z8 = __riscv_vle16_v_i16m1(&izeta[0x40], vl);
  const vint16m1_t za = __riscv_vle16_v_i16m1(&izeta[0x50], vl);
  const vint16m1_t zc = __riscv_vle16_v_i16m1(&izeta[0x60], vl);
  const vint16m1_t ze = __riscv_vle16_v_i16m1(&izeta[0x70], vl);

  vint16m1_t vt;
  vint16m1_t v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, va, vb, vc, vd, ve, vf;
  vint16m2_t vp;

  vp = mlk_rv64v_intt2(__riscv_vle16_v_i16m2(&r[0x00], vl2), z0);
  v0 = __riscv_vget_v_i16m2_i16m1(vp, 0);
  v1 = __riscv_vget_v_i16m2_i16m1(vp, 1);

  vp = mlk_rv64v_intt2(__riscv_vle16_v_i16m2(&r[0x20], vl2), z2);
  v2 = __riscv_vget_v_i16m2_i16m1(vp, 0);
  v3 = __riscv_vget_v_i16m2_i16m1(vp, 1);

  vp = mlk_rv64v_intt2(__riscv_vle16_v_i16m2(&r[0x40], vl2), z4);
  v4 = __riscv_vget_v_i16m2_i16m1(vp, 0);
  v5 = __riscv_vget_v_i16m2_i16m1(vp, 1);

  vp = mlk_rv64v_intt2(__riscv_vle16_v_i16m2(&r[0x60], vl2), z6);
  v6 = __riscv_vget_v_i16m2_i16m1(vp, 0);
  v7 = __riscv_vget_v_i16m2_i16m1(vp, 1);

  vp = mlk_rv64v_intt2(__riscv_vle16_v_i16m2(&r[0x80], vl2), z8);
  v8 = __riscv_vget_v_i16m2_i16m1(vp, 0);
  v9 = __riscv_vget_v_i16m2_i16m1(vp, 1);

  vp = mlk_rv64v_intt2(__riscv_vle16_v_i16m2(&r[0xa0], vl2), za);
  va = __riscv_vget_v_i16m2_i16m1(vp, 0);
  vb = __riscv_vget_v_i16m2_i16m1(vp, 1);

  vp = mlk_rv64v_intt2(__riscv_vle16_v_i16m2(&r[0xc0], vl2), zc);
  vc = __riscv_vget_v_i16m2_i16m1(vp, 0);
  vd = __riscv_vget_v_i16m2_i16m1(vp, 1);

  vp = mlk_rv64v_intt2(__riscv_vle16_v_i16m2(&r[0xe0], vl2), ze);
  ve = __riscv_vget_v_i16m2_i16m1(vp, 0);
  vf = __riscv_vget_v_i16m2_i16m1(vp, 1);

  /* absolute bounds < q (see mlk_rv64v_intt2) */
  MLK_RV64V_ABS_BOUNDS16(vl,
    v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, va, vb, vc, vd, ve, vf,
    1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1);

  MLK_RVV_GS_BFLY_RX(v0, v1, vt, izeta[0x40], vl);
  MLK_RVV_GS_BFLY_RX(v2, v3, vt, izeta[0x41], vl);
  MLK_RVV_GS_BFLY_RX(v4, v5, vt, izeta[0x50], vl);
  MLK_RVV_GS_BFLY_RX(v6, v7, vt, izeta[0x51], vl);
  MLK_RVV_GS_BFLY_RX(v8, v9, vt, izeta[0x60], vl);
  MLK_RVV_GS_BFLY_RX(va, vb, vt, izeta[0x61], vl);
  MLK_RVV_GS_BFLY_RX(vc, vd, vt, izeta[0x70], vl);
  MLK_RVV_GS_BFLY_RX(ve, vf, vt, izeta[0x71], vl);

  /* absolute bounds:
   * - v{0,2,4,6,8,a,c,e}: < 2*q
   * - v{1,3,5,7,9,b,d,f}: < 1*q
   */
  MLK_RV64V_ABS_BOUNDS16(vl,
    v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, va, vb, vc, vd, ve, vf,
    2,  1,  2,  1,  2,  1,  2,  1,  2,  1,  2,  1,  2,  1,  2,  1);

  MLK_RVV_GS_BFLY_RX(v0, v2, vt, izeta[0x20], vl);
  MLK_RVV_GS_BFLY_RX(v1, v3, vt, izeta[0x20], vl);
  MLK_RVV_GS_BFLY_RX(v4, v6, vt, izeta[0x21], vl);
  MLK_RVV_GS_BFLY_RX(v5, v7, vt, izeta[0x21], vl);
  MLK_RVV_GS_BFLY_RX(v8, va, vt, izeta[0x30], vl);
  MLK_RVV_GS_BFLY_RX(v9, vb, vt, izeta[0x30], vl);
  MLK_RVV_GS_BFLY_RX(vc, ve, vt, izeta[0x31], vl);
  MLK_RVV_GS_BFLY_RX(vd, vf, vt, izeta[0x31], vl);

  /* absolute bounds:
   * - v{0,4,8,c}: < 4*q
   * - v{1,5,9,d}: < 2*q
   * - v{2,3,6,7,a,b,e,f}: < 1*q
   */
  MLK_RV64V_ABS_BOUNDS16(vl,
    v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, va, vb, vc, vd, ve, vf,
    4,  2,  1,  1,  4,  2,  1,  1,  4,  2,  1,  1,  4,  2,  1,  1);

  MLK_RVV_GS_BFLY_RX(v0, v4, vt, izeta[0x10], vl);
  MLK_RVV_GS_BFLY_RX(v1, v5, vt, izeta[0x10], vl);
  MLK_RVV_GS_BFLY_RX(v2, v6, vt, izeta[0x10], vl);
  MLK_RVV_GS_BFLY_RX(v3, v7, vt, izeta[0x10], vl);
  MLK_RVV_GS_BFLY_RX(v8, vc, vt, izeta[0x11], vl);
  MLK_RVV_GS_BFLY_RX(v9, vd, vt, izeta[0x11], vl);
  MLK_RVV_GS_BFLY_RX(va, ve, vt, izeta[0x11], vl);
  MLK_RVV_GS_BFLY_RX(vb, vf, vt, izeta[0x11], vl);

  /* absolute bounds:
   * - v{0,8}: < 8*q
   * - v{1,9}: < 4*q
   * - v{2,3,a,b}: < 2*q
   * - v{4,5,6,7,c,d,e,f}: < 1*q
   */
  MLK_RV64V_ABS_BOUNDS16(vl,
    v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, va, vb, vc, vd, ve, vf,
    8,  4,  2,  2,  1,  1,  1,  1,  8,  4,  2,  2,  1,  1,  1,  1);

  /* Reduce v0, v8 to avoid overflow */
  v0 = fq_mulq_vx(v0, MLK_RVV_MONT_R1, vl);
  v8 = fq_mulq_vx(v8, MLK_RVV_MONT_R1, vl);

  /* absolute bounds: < 4*q */
  MLK_RV64V_ABS_BOUNDS16(vl,
    v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, va, vb, vc, vd, ve, vf,
    4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4);

  MLK_RVV_GS_BFLY_RX(v0, v8, vt, izeta[0x01], vl);
  MLK_RVV_GS_BFLY_RX(v1, v9, vt, izeta[0x01], vl);
  MLK_RVV_GS_BFLY_RX(v2, va, vt, izeta[0x01], vl);
  MLK_RVV_GS_BFLY_RX(v3, vb, vt, izeta[0x01], vl);
  MLK_RVV_GS_BFLY_RX(v4, vc, vt, izeta[0x01], vl);
  MLK_RVV_GS_BFLY_RX(v5, vd, vt, izeta[0x01], vl);
  MLK_RVV_GS_BFLY_RX(v6, ve, vt, izeta[0x01], vl);
  MLK_RVV_GS_BFLY_RX(v7, vf, vt, izeta[0x01], vl);

  /* absolute bounds: < 8*q */
  MLK_RV64V_ABS_BOUNDS16(vl,
    v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, va, vb, vc, vd, ve, vf,
    8,  8,  8,  8,  8,  8,  8,  8,  8,  8,  8,  8,  8,  8,  8,  8);

  __riscv_vse16_v_i16m1(&r[0x00], v0, vl);
  __riscv_vse16_v_i16m1(&r[0x10], v1, vl);
  __riscv_vse16_v_i16m1(&r[0x20], v2, vl);
  __riscv_vse16_v_i16m1(&r[0x30], v3, vl);
  __riscv_vse16_v_i16m1(&r[0x40], v4, vl);
  __riscv_vse16_v_i16m1(&r[0x50], v5, vl);
  __riscv_vse16_v_i16m1(&r[0x60], v6, vl);
  __riscv_vse16_v_i16m1(&r[0x70], v7, vl);
  __riscv_vse16_v_i16m1(&r[0x80], v8, vl);
  __riscv_vse16_v_i16m1(&r[0x90], v9, vl);
  __riscv_vse16_v_i16m1(&r[0xa0], va, vl);
  __riscv_vse16_v_i16m1(&r[0xb0], vb, vl);
  __riscv_vse16_v_i16m1(&r[0xc0], vc, vl);
  __riscv_vse16_v_i16m1(&r[0xd0], vd, vl);
  __riscv_vse16_v_i16m1(&r[0xe0], ve, vl);
  __riscv_vse16_v_i16m1(&r[0xf0], vf, vl);
}
#endif /* !MLK_CONFIG_NO_ENCAPS_API || !MLK_CONFIG_NO_DECAPS_API */

/* ML-KEM's middle field GF(3329)[X]/(X^2) multiplication */

static MLK_INLINE void mlk_rv64v_poly_basemul_mont_add_k(int16_t *r,
                                                         const int16_t *a,
                                                         const int16_t *b,
                                                         unsigned kn)
{
#include "rv64v_zetas_basemul.inc"

  size_t vl = __riscv_vsetvl_e16m1(MLKEM_N);
  size_t i, j;

  const vuint16m1_t sw0 = __riscv_vxor_vx_u16m1(__riscv_vid_v_u16m1(vl), 1, vl);
  const vbool16_t sb0 = __riscv_vmseq_vx_u16m1_b16(
      __riscv_vand_vx_u16m1(__riscv_vid_v_u16m1(vl), 1, vl), 0, vl);

  vint16m1_t vt, vu;
  vint32m2_t wa, wb, ws;

  for (i = 0; i < MLKEM_N; i += vl)
  {
    const vint16m1_t vz = __riscv_vle16_v_i16m1(&roots[i], vl);

    for (j = 0; j < kn; j += MLKEM_N)
    {
      vt = __riscv_vle16_v_i16m1(&a[i + j], vl);
      vu = __riscv_vle16_v_i16m1(&b[i + j], vl);

      wa = __riscv_vwmul_vv_i32m2(vz, fq_mul_vv(vt, vu, vl), vl);
      wb = __riscv_vwmul_vv_i32m2(vt, __riscv_vrgather_vv_i16m1(vu, sw0, vl),
                                  vl);

      wa =
          __riscv_vadd_vv_i32m2(wa, __riscv_vslidedown_vx_i32m2(wa, 1, vl), vl);
      wb = __riscv_vadd_vv_i32m2(wb, __riscv_vslideup_vx_i32m2(wb, wb, 1, vl),
                                 vl);

      wa = __riscv_vmerge_vvm_i32m2(wb, wa, sb0, vl);

      if (j == 0)
      {
        ws = wa;
      }
      else
      {
        ws = __riscv_vadd_vv_i32m2(ws, wa, vl);
      }
    }
    /* the idea is to keep 32-bit intermediate result, reduce in the end */
    __riscv_vse16_v_i16m1(&r[i], fq_redc2(ws, vl), vl);
  }
}

#if defined(MLK_CONFIG_MULTILEVEL_WITH_SHARED) || MLKEM_K == 2
void mlk_rv64v_poly_basemul_mont_add_k2(int16_t *r, const int16_t *a,
                                        const int16_t *b)
{
  mlk_rv64v_poly_basemul_mont_add_k(r, a, b, 2 * MLKEM_N);
}
#endif /* MLK_CONFIG_MULTILEVEL_WITH_SHARED || MLKEM_K == 2 */

#if defined(MLK_CONFIG_MULTILEVEL_WITH_SHARED) || MLKEM_K == 3
void mlk_rv64v_poly_basemul_mont_add_k3(int16_t *r, const int16_t *a,
                                        const int16_t *b)
{
  mlk_rv64v_poly_basemul_mont_add_k(r, a, b, 3 * MLKEM_N);
}
#endif /* MLK_CONFIG_MULTILEVEL_WITH_SHARED || MLKEM_K == 3 */

#if defined(MLK_CONFIG_MULTILEVEL_WITH_SHARED) || MLKEM_K == 4
void mlk_rv64v_poly_basemul_mont_add_k4(int16_t *r, const int16_t *a,
                                        const int16_t *b)
{
  mlk_rv64v_poly_basemul_mont_add_k(r, a, b, 4 * MLKEM_N);
}
#endif /* MLK_CONFIG_MULTILEVEL_WITH_SHARED || MLKEM_K == 4 */

#if !defined(MLK_CONFIG_NO_KEYPAIR_API)
/**
 * In-place conversion of all coefficients of a polynomial from the normal
 * domain to the Montgomery domain.
 *
 * @param[in,out] r Input/output polynomial.
 */
void mlk_rv64v_poly_tomont(int16_t *r)
{
  size_t vl = __riscv_vsetvl_e16m1(MLKEM_N);
  size_t i;

  for (i = 0; i < MLKEM_N; i += vl)
  {
    vint16m1_t vec = __riscv_vle16_v_i16m1(&r[i], vl);
    vec = fq_mul_vx(vec, MLK_RVV_MONT_R2, vl);
    __riscv_vse16_v_i16m1(&r[i], vec, vl);
  }
}
#endif /* !MLK_CONFIG_NO_KEYPAIR_API */

/**
 * Apply Barrett reduction to all coefficients of a polynomial. For details
 * of the Barrett reduction see the comments in poly.c.
 *
 * @param[in,out] r Input/output polynomial.
 */
void mlk_rv64v_poly_reduce(int16_t *r)
{
  size_t vl = __riscv_vsetvl_e16m1(MLKEM_N);
  vint16m1_t vt;
  size_t i;

  for (i = 0; i < MLKEM_N; i += vl)
  {
    vt = __riscv_vle16_v_i16m1(&r[i], vl);
    vt = fq_barrett(vt, vl);
    vt = fq_cadd(vt, vl);
    __riscv_vse16_v_i16m1(&r[i], vt, vl);
  }
}

/* Run rejection sampling to get uniform random integers mod q.
 * buflen must be a multiple of 12. */

unsigned int mlk_rv64v_rej_uniform(int16_t *r, unsigned int len,
                                   const uint8_t *buf, unsigned int buflen)
{
  unsigned n, ctr, pos;
  vuint16m1_t x, y;
  vbool16_t lt;

  pos = 0;
  ctr = 0;

  while (ctr < len && pos < buflen)
  {
    const unsigned vl = (unsigned)__riscv_vsetvl_e16m1((buflen - pos) * 8 / 12);
    const unsigned vl23 = (vl * 24) / 32;

    const vuint16m1_t vid = __riscv_vid_v_u16m1(vl);
    const vuint16m1_t srl12v = __riscv_vmul_vx_u16m1(vid, 12, vl);
    const vuint16m1_t sel12v = __riscv_vsrl_vx_u16m1(srl12v, 4, vl);
    const vuint16m1_t sll12v = __riscv_vsll_vx_u16m1(vid, 2, vl);

    /* Functionally, this loop is not necessary, but it avoids re-evaluating
     * the VL too many times. In particular, in the first outer iteration,
     * the inner loop will process the bulk of the data with fixed VL. */
    while (ctr < len && vl23 * 2 <= buflen - pos)
    {
      x = __riscv_vle16_v_u16m1((uint16_t *)&buf[pos], vl23);
      pos += vl23 * 2;
      x = __riscv_vrgather_vv_u16m1(x, sel12v, vl);
      x = __riscv_vor_vv_u16m1(
          __riscv_vsrl_vv_u16m1(x, srl12v, vl),
          __riscv_vsll_vv_u16m1(__riscv_vslidedown(x, 1, vl), sll12v, vl), vl);
      x = __riscv_vand_vx_u16m1(x, 0xFFF, vl);

      lt = __riscv_vmsltu_vx_u16m1_b16(x, MLKEM_Q, vl);
      y = __riscv_vcompress_vm_u16m1(x, lt, vl);
      n = (unsigned)__riscv_vcpop_m_b16(lt, vl);

      if (ctr + n > len)
      {
        n = len - ctr;
      }
      __riscv_vse16_v_u16m1((uint16_t *)&r[ctr], y, n);
      ctr += n;
    }
  }

  return ctr;
}

#else /* MLK_ARITH_BACKEND_RISCV64 && !MLK_CONFIG_MULTILEVEL_NO_SHARED */

MLK_EMPTY_CU(rv64v_poly)

#endif /* !(MLK_ARITH_BACKEND_RISCV64 && !MLK_CONFIG_MULTILEVEL_NO_SHARED) */

/* To facilitate single-compilation-unit (SCU) builds, undefine all macros.
 * Don't modify by hand -- this is auto-generated by scripts/autogen. */
#undef MLK_RVV_QI
#undef MLK_RVV_MONT_R1
#undef MLK_RVV_MONT_R2
#undef MLK_RVV_MONT_NR
#undef MLK_RVV_CT_BFLY_FX
#undef MLK_RVV_CT_BFLY_FV
#undef MLK_RVV_GS_BFLY_RX
#undef MLK_RVV_GS_BFLY_RV
#undef MLK_RV64V_ABS_BOUNDS16
