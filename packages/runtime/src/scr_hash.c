/* The digest primitives node:crypto's hashes use beyond MD5, SHA-1 and
 * SHA-2 (scr_lib.c): the Keccak sponge (SHA-3, Keccak, SHAKE and
 * OpenSSL's KECCAK-KMAC digests), RIPEMD-160, BLAKE2b-512, BLAKE2s-256
 * and SM3. Each context updates incrementally, and finalization reads
 * a copy so Hash.copy() and HMAC's reuse stay plain struct copies. The
 * implementations follow FIPS 202, the RIPEMD-160 specification,
 * RFC 7693 and GB/T 32905-2016. */
#include "scr_runtime.h"

#include <string.h>

/* ── Keccak-f[1600] ─────────────────────────────────────────────────── */

static const uint64_t scr_keccak_rc[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL, 0x8000000080008000ULL,
    0x000000000000808bULL, 0x0000000080000001ULL, 0x8000000080008081ULL, 0x8000000000008009ULL,
    0x000000000000008aULL, 0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL, 0x8000000000008003ULL,
    0x8000000000008002ULL, 0x8000000000000080ULL, 0x000000000000800aULL, 0x800000008000000aULL,
    0x8000000080008081ULL, 0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL,
};

static uint64_t scr_rotl64(uint64_t x, unsigned n) { return (x << n) | (x >> (64 - n)); }

SCR_DIGEST_ALIGNED static void scr_keccak_f_rounds(uint64_t s[25], int first) {
  /* Theta, rho, pi, chi and iota with the lanes in locals; the
   * compiler keeps the unrolled round in registers. `first` skips to a
   * later round for Keccak-p[1600, n] (TurboSHAKE starts at round 12). */
  uint64_t a[25], b[25], c[5], d[5];
  memcpy(a, s, sizeof a);
  for (int round = first; round < 24; round++) {
    c[0] = a[0] ^ a[5] ^ a[10] ^ a[15] ^ a[20];
    c[1] = a[1] ^ a[6] ^ a[11] ^ a[16] ^ a[21];
    c[2] = a[2] ^ a[7] ^ a[12] ^ a[17] ^ a[22];
    c[3] = a[3] ^ a[8] ^ a[13] ^ a[18] ^ a[23];
    c[4] = a[4] ^ a[9] ^ a[14] ^ a[19] ^ a[24];
    d[0] = c[4] ^ scr_rotl64(c[1], 1);
    d[1] = c[0] ^ scr_rotl64(c[2], 1);
    d[2] = c[1] ^ scr_rotl64(c[3], 1);
    d[3] = c[2] ^ scr_rotl64(c[4], 1);
    d[4] = c[3] ^ scr_rotl64(c[0], 1);
    b[0] = a[0] ^ d[0];
    b[10] = scr_rotl64(a[1] ^ d[1], 1);
    b[20] = scr_rotl64(a[2] ^ d[2], 62);
    b[5] = scr_rotl64(a[3] ^ d[3], 28);
    b[15] = scr_rotl64(a[4] ^ d[4], 27);
    b[16] = scr_rotl64(a[5] ^ d[0], 36);
    b[1] = scr_rotl64(a[6] ^ d[1], 44);
    b[11] = scr_rotl64(a[7] ^ d[2], 6);
    b[21] = scr_rotl64(a[8] ^ d[3], 55);
    b[6] = scr_rotl64(a[9] ^ d[4], 20);
    b[7] = scr_rotl64(a[10] ^ d[0], 3);
    b[17] = scr_rotl64(a[11] ^ d[1], 10);
    b[2] = scr_rotl64(a[12] ^ d[2], 43);
    b[12] = scr_rotl64(a[13] ^ d[3], 25);
    b[22] = scr_rotl64(a[14] ^ d[4], 39);
    b[23] = scr_rotl64(a[15] ^ d[0], 41);
    b[8] = scr_rotl64(a[16] ^ d[1], 45);
    b[18] = scr_rotl64(a[17] ^ d[2], 15);
    b[3] = scr_rotl64(a[18] ^ d[3], 21);
    b[13] = scr_rotl64(a[19] ^ d[4], 8);
    b[14] = scr_rotl64(a[20] ^ d[0], 18);
    b[24] = scr_rotl64(a[21] ^ d[1], 2);
    b[9] = scr_rotl64(a[22] ^ d[2], 61);
    b[19] = scr_rotl64(a[23] ^ d[3], 56);
    b[4] = scr_rotl64(a[24] ^ d[4], 14);
    a[0] = b[0] ^ (~b[1] & b[2]);
    a[1] = b[1] ^ (~b[2] & b[3]);
    a[2] = b[2] ^ (~b[3] & b[4]);
    a[3] = b[3] ^ (~b[4] & b[0]);
    a[4] = b[4] ^ (~b[0] & b[1]);
    a[5] = b[5] ^ (~b[6] & b[7]);
    a[6] = b[6] ^ (~b[7] & b[8]);
    a[7] = b[7] ^ (~b[8] & b[9]);
    a[8] = b[8] ^ (~b[9] & b[5]);
    a[9] = b[9] ^ (~b[5] & b[6]);
    a[10] = b[10] ^ (~b[11] & b[12]);
    a[11] = b[11] ^ (~b[12] & b[13]);
    a[12] = b[12] ^ (~b[13] & b[14]);
    a[13] = b[13] ^ (~b[14] & b[10]);
    a[14] = b[14] ^ (~b[10] & b[11]);
    a[15] = b[15] ^ (~b[16] & b[17]);
    a[16] = b[16] ^ (~b[17] & b[18]);
    a[17] = b[17] ^ (~b[18] & b[19]);
    a[18] = b[18] ^ (~b[19] & b[15]);
    a[19] = b[19] ^ (~b[15] & b[16]);
    a[20] = b[20] ^ (~b[21] & b[22]);
    a[21] = b[21] ^ (~b[22] & b[23]);
    a[22] = b[22] ^ (~b[23] & b[24]);
    a[23] = b[23] ^ (~b[24] & b[20]);
    a[24] = b[24] ^ (~b[20] & b[21]);
    a[0] ^= scr_keccak_rc[round];
  }
  memcpy(s, a, sizeof a);
}

static void scr_keccak_f(uint64_t s[25]) { scr_keccak_f_rounds(s, 0); }

static void scr_keccak_absorb_block_rounds(uint64_t s[25], const unsigned char *block,
                                           size_t rate, int first) {
  for (size_t i = 0; i < rate / 8; i++) {
    uint64_t lane = 0;
    for (int b = 7; b >= 0; b--) lane = (lane << 8) | block[i * 8 + (size_t)b];
    s[i] ^= lane;
  }
  scr_keccak_f_rounds(s, first);
}

static void scr_keccak_absorb_block(uint64_t s[25], const unsigned char *block, size_t rate) {
  scr_keccak_absorb_block_rounds(s, block, rate, 0);
}

void scr_keccak_init(ScrKeccakCtx *ctx, size_t rate, unsigned char pad) {
  memset(ctx, 0, sizeof *ctx);
  ctx->rate = rate;
  ctx->pad = pad;
}

void scr_keccak_update(ScrKeccakCtx *ctx, const unsigned char *data, size_t len) {
  if (ctx->len != 0) {
    size_t take = ctx->rate - ctx->len;
    if (take > len) take = len;
    memcpy(ctx->buf + ctx->len, data, take);
    ctx->len += take;
    data += take;
    len -= take;
    if (ctx->len == ctx->rate) {
      scr_keccak_absorb_block(ctx->s, ctx->buf, ctx->rate);
      ctx->len = 0;
    }
  }
  while (len >= ctx->rate) {
    scr_keccak_absorb_block(ctx->s, data, ctx->rate);
    data += ctx->rate;
    len -= ctx->rate;
  }
  if (len != 0) {
    memcpy(ctx->buf, data, len);
    ctx->len = len;
  }
}

/* Pads a copy of the sponge and squeezes `len` bytes. */
void scr_keccak_final(const ScrKeccakCtx *source, unsigned char *out, size_t len) {
  ScrKeccakCtx ctx = *source;
  memset(ctx.buf + ctx.len, 0, ctx.rate - ctx.len);
  ctx.buf[ctx.len] ^= ctx.pad;
  ctx.buf[ctx.rate - 1] ^= 0x80;
  scr_keccak_absorb_block(ctx.s, ctx.buf, ctx.rate);
  while (len != 0) {
    size_t n = len < ctx.rate ? len : ctx.rate;
    for (size_t i = 0; i < n; i++) out[i] = (unsigned char)(ctx.s[i / 8] >> (8 * (i % 8)));
    out += n;
    len -= n;
    if (len != 0) scr_keccak_f(ctx.s);
  }
}

/* ── KMAC (SP 800-185) ──────────────────────────────────────────────── */

/* left_encode/right_encode: the byte count, then the big-endian bytes. */
static size_t scr_kmac_left_encode(unsigned char out[9], uint64_t x) {
  size_t n = 1;
  while (n < 8 && (x >> (8 * n)) != 0) n++;
  out[0] = (unsigned char)n;
  for (size_t i = 0; i < n; i++) out[1 + i] = (unsigned char)(x >> (8 * (n - 1 - i)));
  return n + 1;
}

static size_t scr_kmac_right_encode(unsigned char out[9], uint64_t x) {
  size_t n = 1;
  while (n < 8 && (x >> (8 * n)) != 0) n++;
  for (size_t i = 0; i < n; i++) out[i] = (unsigned char)(x >> (8 * (n - 1 - i)));
  out[n] = (unsigned char)n;
  return n + 1;
}

/* encode_string(S) = left_encode(len(S) in bits) || S, absorbed as it
 * goes; the byte count feeds bytepad's zero padding. The bit length can
 * differ from the byte length's when a WebCrypto key records a
 * non-byte-aligned size. */
static size_t scr_kmac_encode_bits(ScrKeccakCtx *ctx, const unsigned char *s, size_t bits) {
  unsigned char head[9];
  size_t n = scr_kmac_left_encode(head, (uint64_t)bits);
  scr_keccak_update(ctx, head, n);
  size_t bytes = (bits + 7) / 8;
  if (bytes != 0) scr_keccak_update(ctx, s, bytes);
  return n + bytes;
}
/* encode_string(S) = left_encode(len(S) in bits) || S, absorbed as it
 * goes; the byte count feeds bytepad's zero padding. */

static size_t scr_kmac_encode_string(ScrKeccakCtx *ctx, const unsigned char *s, size_t len) {
  unsigned char head[9];
  size_t n = scr_kmac_left_encode(head, (uint64_t)len * 8);
  scr_keccak_update(ctx, head, n);
  if (len != 0) scr_keccak_update(ctx, s, len);
  return n + len;
}

/* bytepad's zero padding: the bytes absorbed so far modulo the rate. */
static void scr_kmac_pad_to_rate(ScrKeccakCtx *ctx, size_t absorbed) {
  static const unsigned char zeros[168];
  size_t rem = absorbed % ctx->rate;
  if (rem != 0) scr_keccak_update(ctx, zeros, ctx->rate - rem);
}

void scr_kmac_init(ScrKeccakCtx *ctx, bool kmac256, const unsigned char *key, size_t keylen,
                   size_t key_bits, const unsigned char *custom, size_t customlen) {
  size_t rate = kmac256 ? 136 : 168;
  scr_keccak_init(ctx, rate, 0x04);
  /* bytepad(encode_string("KMAC") || encode_string(S), rate) */
  unsigned char head[9];
  size_t n = scr_kmac_left_encode(head, rate);
  scr_keccak_update(ctx, head, n);
  size_t absorbed = n;
  absorbed += scr_kmac_encode_string(ctx, (const unsigned char *)"KMAC", 4);
  absorbed += scr_kmac_encode_string(ctx, custom, customlen);
  scr_kmac_pad_to_rate(ctx, absorbed);
  /* bytepad(encode_string(K), rate), with the key's declared bit length
   * (a WebCrypto key can record one that is not a whole byte count). */
  (void)keylen;
  n = scr_kmac_left_encode(head, rate);
  scr_keccak_update(ctx, head, n);
  absorbed = n + scr_kmac_encode_bits(ctx, key, key_bits);
  scr_kmac_pad_to_rate(ctx, absorbed);
}

void scr_kmac_final(const ScrKeccakCtx *source, size_t out_bytes, size_t bits,
                    unsigned char *out) {
  ScrKeccakCtx ctx = *source;
  unsigned char tail[9];
  size_t n = scr_kmac_right_encode(tail, (uint64_t)bits);
  scr_keccak_update(&ctx, tail, n);
  scr_keccak_final(&ctx, out, out_bytes);
  size_t extra = bits % 8;
  if (extra != 0 && out_bytes != 0)
    out[out_bytes - 1] &= (unsigned char)(0xffu << (8 - extra));
}

/* cSHAKE (SP 800-185): SHAKE's sponge with the byte-padded
 * encode_string(N) || encode_string(S) prefix and domain 0x04. With both
 * empty it is plain SHAKE. */
void scr_cshake_hash(bool cshake256, const unsigned char *func, size_t func_len,
                     const unsigned char *custom, size_t custom_len, const unsigned char *data,
                     size_t data_len, unsigned char *out, size_t out_bytes, size_t bits) {
  ScrKeccakCtx ctx;
  size_t rate = cshake256 ? 136 : 168;
  if (func_len == 0 && custom_len == 0) {
    scr_keccak_init(&ctx, rate, 0x1f);
  } else {
    scr_keccak_init(&ctx, rate, 0x04);
    unsigned char head[9];
    size_t n = scr_kmac_left_encode(head, rate);
    scr_keccak_update(&ctx, head, n);
    size_t absorbed = n;
    absorbed += scr_kmac_encode_string(&ctx, func, func_len);
    absorbed += scr_kmac_encode_string(&ctx, custom, custom_len);
    scr_kmac_pad_to_rate(&ctx, absorbed);
  }
  if (data_len != 0) scr_keccak_update(&ctx, data, data_len);
  scr_keccak_final(&ctx, out, out_bytes);
  size_t extra = bits % 8;
  if (extra != 0 && out_bytes != 0)
    out[out_bytes - 1] &= (unsigned char)(0xffu << (8 - extra));
}

/* TurboSHAKE (RFC 9861): the Keccak-p[1600, 12] sponge with the caller's
 * domain separation byte (0x01..0x7f). */
void scr_turboshake_hash(bool t256, unsigned char domain, const unsigned char *data, size_t len,
                         unsigned char *out, size_t out_bytes) {
  size_t rate = t256 ? 136 : 168;
  uint64_t s[25] = {0};
  while (len >= rate) {
    scr_keccak_absorb_block_rounds(s, data, rate, 12);
    data += rate;
    len -= rate;
  }
  unsigned char block[168];
  memset(block, 0, rate);
  if (len != 0) memcpy(block, data, len);
  block[len] ^= domain;
  block[rate - 1] ^= 0x80;
  scr_keccak_absorb_block_rounds(s, block, rate, 12);
  unsigned char *out_bytes_end = out + out_bytes;
  for (size_t off = 0; out + off < out_bytes_end;) {
    size_t n = (size_t)(out_bytes_end - (out + off));
    if (n > rate) n = rate;
    for (size_t i = 0; i < n; i++) out[off + i] = (unsigned char)(s[i / 8] >> (8 * (i % 8)));
    off += n;
    if (out + off < out_bytes_end) scr_keccak_f_rounds(s, 12);
  }
}

/* RFC 9861's length_encode: the minimal big-endian bytes of x, then the
 * byte count (no data byte for zero: length_encode(0) is 0x00). */
static size_t scr_k12_length_encode(unsigned char out[9], uint64_t x) {
  if (x == 0) {
    out[0] = 0;
    return 1;
  }
  return scr_kmac_right_encode(out, x);
}

/* KangarooTwelve (RFC 9861): TurboSHAKE over M || C || length_encode(|C|);
 * above one 8192-byte chunk the tail chunks become chaining values in a
 * final node of S_0 || 03 00 00 00 00 00 00 00 || CV_1 .. CV_(n-1) ||
 * length_encode(n-1) || FF FF, run with domain 0x06. */
void scr_k12_hash(bool kt256, const unsigned char *custom, size_t custom_len,
                  const unsigned char *data, size_t data_len, unsigned char *out,
                  size_t out_bytes) {
  size_t cv_len = kt256 ? 64 : 32;
  unsigned char tail[9];
  size_t tail_len = scr_k12_length_encode(tail, (uint64_t)custom_len);
  if (custom_len > SIZE_MAX - data_len || data_len + custom_len > SIZE_MAX - tail_len)
    scr_trap("scriptc: out of memory\n");
  size_t s_len = data_len + custom_len + tail_len;
  unsigned char *s = malloc(s_len ? s_len : 1);
  if (!s) scr_trap("scriptc: out of memory\n");
  if (data_len) memcpy(s, data, data_len);
  if (custom_len) memcpy(s + data_len, custom, custom_len);
  memcpy(s + data_len + custom_len, tail, tail_len);
  if (s_len <= 8192) {
    scr_turboshake_hash(kt256, 0x07, s, s_len, out, out_bytes);
    free(s);
    return;
  }
  size_t chunks = (s_len + 8191) / 8192;
  unsigned char count[9];
  size_t count_len = scr_k12_length_encode(count, chunks - 1);
  size_t final_len = 8192 + 8 + (chunks - 1) * cv_len + count_len + 2;
  unsigned char *final = malloc(final_len);
  if (!final) scr_trap("scriptc: out of memory\n");
  memcpy(final, s, 8192);
  memset(final + 8192, 0, 8);
  final[8192] = 0x03;
  size_t pos = 8192 + 8;
  for (size_t i = 1; i < chunks; i++) {
    size_t off = i * 8192;
    size_t len = s_len - off < 8192 ? s_len - off : 8192;
    scr_turboshake_hash(kt256, 0x0B, s + off, len, final + pos, cv_len);
    pos += cv_len;
  }
  memcpy(final + pos, count, count_len);
  pos += count_len;
  final[pos++] = 0xFF;
  final[pos++] = 0xFF;
  scr_turboshake_hash(kt256, 0x06, final, final_len, out, out_bytes);
  free(final);
  free(s);
}

/* ── RIPEMD-160 ─────────────────────────────────────────────────────── */

static uint32_t scr_rotl32(uint32_t x, unsigned n) { return (x << n) | (x >> (32 - n)); }

/* One step: A = rotl(A + f(B, C, D) + X + K, s) + E and C = rotl(C, 10).
 * The steps name the five words in rotated order instead of moving them. */
#define SCR_RMD_F1(b, c, d) ((b) ^ (c) ^ (d))
#define SCR_RMD_F2(b, c, d) (((b) & (c)) | (~(b) & (d)))
#define SCR_RMD_F3(b, c, d) (((b) | ~(c)) ^ (d))
#define SCR_RMD_F4(b, c, d) (((b) & (d)) | ((c) & ~(d)))
#define SCR_RMD_F5(b, c, d) ((b) ^ ((c) | ~(d)))
#define SCR_RMD_STEP(f, a, b, c, d, e, x, k, s)              \
  do {                                                       \
    (a) = scr_rotl32((a) + f(b, c, d) + (x) + (k), s) + (e); \
    (c) = scr_rotl32(c, 10);                                 \
  } while (0)

SCR_DIGEST_ALIGNED static void scr_rmd_block(uint32_t h[5], const unsigned char *p) {
  uint32_t x[16];
  for (int i = 0; i < 16; i++)
    x[i] = (uint32_t)p[i * 4] | ((uint32_t)p[i * 4 + 1] << 8) | ((uint32_t)p[i * 4 + 2] << 16) |
           ((uint32_t)p[i * 4 + 3] << 24);
  uint32_t al = h[0], bl = h[1], cl = h[2], dl = h[3], el = h[4];
  uint32_t ar = h[0], br = h[1], cr = h[2], dr = h[3], er = h[4];
  SCR_RMD_STEP(SCR_RMD_F1, al, bl, cl, dl, el, x[0], 0x00000000u, 11);
  SCR_RMD_STEP(SCR_RMD_F1, el, al, bl, cl, dl, x[1], 0x00000000u, 14);
  SCR_RMD_STEP(SCR_RMD_F1, dl, el, al, bl, cl, x[2], 0x00000000u, 15);
  SCR_RMD_STEP(SCR_RMD_F1, cl, dl, el, al, bl, x[3], 0x00000000u, 12);
  SCR_RMD_STEP(SCR_RMD_F1, bl, cl, dl, el, al, x[4], 0x00000000u, 5);
  SCR_RMD_STEP(SCR_RMD_F1, al, bl, cl, dl, el, x[5], 0x00000000u, 8);
  SCR_RMD_STEP(SCR_RMD_F1, el, al, bl, cl, dl, x[6], 0x00000000u, 7);
  SCR_RMD_STEP(SCR_RMD_F1, dl, el, al, bl, cl, x[7], 0x00000000u, 9);
  SCR_RMD_STEP(SCR_RMD_F1, cl, dl, el, al, bl, x[8], 0x00000000u, 11);
  SCR_RMD_STEP(SCR_RMD_F1, bl, cl, dl, el, al, x[9], 0x00000000u, 13);
  SCR_RMD_STEP(SCR_RMD_F1, al, bl, cl, dl, el, x[10], 0x00000000u, 14);
  SCR_RMD_STEP(SCR_RMD_F1, el, al, bl, cl, dl, x[11], 0x00000000u, 15);
  SCR_RMD_STEP(SCR_RMD_F1, dl, el, al, bl, cl, x[12], 0x00000000u, 6);
  SCR_RMD_STEP(SCR_RMD_F1, cl, dl, el, al, bl, x[13], 0x00000000u, 7);
  SCR_RMD_STEP(SCR_RMD_F1, bl, cl, dl, el, al, x[14], 0x00000000u, 9);
  SCR_RMD_STEP(SCR_RMD_F1, al, bl, cl, dl, el, x[15], 0x00000000u, 8);
  SCR_RMD_STEP(SCR_RMD_F2, el, al, bl, cl, dl, x[7], 0x5a827999u, 7);
  SCR_RMD_STEP(SCR_RMD_F2, dl, el, al, bl, cl, x[4], 0x5a827999u, 6);
  SCR_RMD_STEP(SCR_RMD_F2, cl, dl, el, al, bl, x[13], 0x5a827999u, 8);
  SCR_RMD_STEP(SCR_RMD_F2, bl, cl, dl, el, al, x[1], 0x5a827999u, 13);
  SCR_RMD_STEP(SCR_RMD_F2, al, bl, cl, dl, el, x[10], 0x5a827999u, 11);
  SCR_RMD_STEP(SCR_RMD_F2, el, al, bl, cl, dl, x[6], 0x5a827999u, 9);
  SCR_RMD_STEP(SCR_RMD_F2, dl, el, al, bl, cl, x[15], 0x5a827999u, 7);
  SCR_RMD_STEP(SCR_RMD_F2, cl, dl, el, al, bl, x[3], 0x5a827999u, 15);
  SCR_RMD_STEP(SCR_RMD_F2, bl, cl, dl, el, al, x[12], 0x5a827999u, 7);
  SCR_RMD_STEP(SCR_RMD_F2, al, bl, cl, dl, el, x[0], 0x5a827999u, 12);
  SCR_RMD_STEP(SCR_RMD_F2, el, al, bl, cl, dl, x[9], 0x5a827999u, 15);
  SCR_RMD_STEP(SCR_RMD_F2, dl, el, al, bl, cl, x[5], 0x5a827999u, 9);
  SCR_RMD_STEP(SCR_RMD_F2, cl, dl, el, al, bl, x[2], 0x5a827999u, 11);
  SCR_RMD_STEP(SCR_RMD_F2, bl, cl, dl, el, al, x[14], 0x5a827999u, 7);
  SCR_RMD_STEP(SCR_RMD_F2, al, bl, cl, dl, el, x[11], 0x5a827999u, 13);
  SCR_RMD_STEP(SCR_RMD_F2, el, al, bl, cl, dl, x[8], 0x5a827999u, 12);
  SCR_RMD_STEP(SCR_RMD_F3, dl, el, al, bl, cl, x[3], 0x6ed9eba1u, 11);
  SCR_RMD_STEP(SCR_RMD_F3, cl, dl, el, al, bl, x[10], 0x6ed9eba1u, 13);
  SCR_RMD_STEP(SCR_RMD_F3, bl, cl, dl, el, al, x[14], 0x6ed9eba1u, 6);
  SCR_RMD_STEP(SCR_RMD_F3, al, bl, cl, dl, el, x[4], 0x6ed9eba1u, 7);
  SCR_RMD_STEP(SCR_RMD_F3, el, al, bl, cl, dl, x[9], 0x6ed9eba1u, 14);
  SCR_RMD_STEP(SCR_RMD_F3, dl, el, al, bl, cl, x[15], 0x6ed9eba1u, 9);
  SCR_RMD_STEP(SCR_RMD_F3, cl, dl, el, al, bl, x[8], 0x6ed9eba1u, 13);
  SCR_RMD_STEP(SCR_RMD_F3, bl, cl, dl, el, al, x[1], 0x6ed9eba1u, 15);
  SCR_RMD_STEP(SCR_RMD_F3, al, bl, cl, dl, el, x[2], 0x6ed9eba1u, 14);
  SCR_RMD_STEP(SCR_RMD_F3, el, al, bl, cl, dl, x[7], 0x6ed9eba1u, 8);
  SCR_RMD_STEP(SCR_RMD_F3, dl, el, al, bl, cl, x[0], 0x6ed9eba1u, 13);
  SCR_RMD_STEP(SCR_RMD_F3, cl, dl, el, al, bl, x[6], 0x6ed9eba1u, 6);
  SCR_RMD_STEP(SCR_RMD_F3, bl, cl, dl, el, al, x[13], 0x6ed9eba1u, 5);
  SCR_RMD_STEP(SCR_RMD_F3, al, bl, cl, dl, el, x[11], 0x6ed9eba1u, 12);
  SCR_RMD_STEP(SCR_RMD_F3, el, al, bl, cl, dl, x[5], 0x6ed9eba1u, 7);
  SCR_RMD_STEP(SCR_RMD_F3, dl, el, al, bl, cl, x[12], 0x6ed9eba1u, 5);
  SCR_RMD_STEP(SCR_RMD_F4, cl, dl, el, al, bl, x[1], 0x8f1bbcdcu, 11);
  SCR_RMD_STEP(SCR_RMD_F4, bl, cl, dl, el, al, x[9], 0x8f1bbcdcu, 12);
  SCR_RMD_STEP(SCR_RMD_F4, al, bl, cl, dl, el, x[11], 0x8f1bbcdcu, 14);
  SCR_RMD_STEP(SCR_RMD_F4, el, al, bl, cl, dl, x[10], 0x8f1bbcdcu, 15);
  SCR_RMD_STEP(SCR_RMD_F4, dl, el, al, bl, cl, x[0], 0x8f1bbcdcu, 14);
  SCR_RMD_STEP(SCR_RMD_F4, cl, dl, el, al, bl, x[8], 0x8f1bbcdcu, 15);
  SCR_RMD_STEP(SCR_RMD_F4, bl, cl, dl, el, al, x[12], 0x8f1bbcdcu, 9);
  SCR_RMD_STEP(SCR_RMD_F4, al, bl, cl, dl, el, x[4], 0x8f1bbcdcu, 8);
  SCR_RMD_STEP(SCR_RMD_F4, el, al, bl, cl, dl, x[13], 0x8f1bbcdcu, 9);
  SCR_RMD_STEP(SCR_RMD_F4, dl, el, al, bl, cl, x[3], 0x8f1bbcdcu, 14);
  SCR_RMD_STEP(SCR_RMD_F4, cl, dl, el, al, bl, x[7], 0x8f1bbcdcu, 5);
  SCR_RMD_STEP(SCR_RMD_F4, bl, cl, dl, el, al, x[15], 0x8f1bbcdcu, 6);
  SCR_RMD_STEP(SCR_RMD_F4, al, bl, cl, dl, el, x[14], 0x8f1bbcdcu, 8);
  SCR_RMD_STEP(SCR_RMD_F4, el, al, bl, cl, dl, x[5], 0x8f1bbcdcu, 6);
  SCR_RMD_STEP(SCR_RMD_F4, dl, el, al, bl, cl, x[6], 0x8f1bbcdcu, 5);
  SCR_RMD_STEP(SCR_RMD_F4, cl, dl, el, al, bl, x[2], 0x8f1bbcdcu, 12);
  SCR_RMD_STEP(SCR_RMD_F5, bl, cl, dl, el, al, x[4], 0xa953fd4eu, 9);
  SCR_RMD_STEP(SCR_RMD_F5, al, bl, cl, dl, el, x[0], 0xa953fd4eu, 15);
  SCR_RMD_STEP(SCR_RMD_F5, el, al, bl, cl, dl, x[5], 0xa953fd4eu, 5);
  SCR_RMD_STEP(SCR_RMD_F5, dl, el, al, bl, cl, x[9], 0xa953fd4eu, 11);
  SCR_RMD_STEP(SCR_RMD_F5, cl, dl, el, al, bl, x[7], 0xa953fd4eu, 6);
  SCR_RMD_STEP(SCR_RMD_F5, bl, cl, dl, el, al, x[12], 0xa953fd4eu, 8);
  SCR_RMD_STEP(SCR_RMD_F5, al, bl, cl, dl, el, x[2], 0xa953fd4eu, 13);
  SCR_RMD_STEP(SCR_RMD_F5, el, al, bl, cl, dl, x[10], 0xa953fd4eu, 12);
  SCR_RMD_STEP(SCR_RMD_F5, dl, el, al, bl, cl, x[14], 0xa953fd4eu, 5);
  SCR_RMD_STEP(SCR_RMD_F5, cl, dl, el, al, bl, x[1], 0xa953fd4eu, 12);
  SCR_RMD_STEP(SCR_RMD_F5, bl, cl, dl, el, al, x[3], 0xa953fd4eu, 13);
  SCR_RMD_STEP(SCR_RMD_F5, al, bl, cl, dl, el, x[8], 0xa953fd4eu, 14);
  SCR_RMD_STEP(SCR_RMD_F5, el, al, bl, cl, dl, x[11], 0xa953fd4eu, 11);
  SCR_RMD_STEP(SCR_RMD_F5, dl, el, al, bl, cl, x[6], 0xa953fd4eu, 8);
  SCR_RMD_STEP(SCR_RMD_F5, cl, dl, el, al, bl, x[15], 0xa953fd4eu, 5);
  SCR_RMD_STEP(SCR_RMD_F5, bl, cl, dl, el, al, x[13], 0xa953fd4eu, 6);
  SCR_RMD_STEP(SCR_RMD_F5, ar, br, cr, dr, er, x[5], 0x50a28be6u, 8);
  SCR_RMD_STEP(SCR_RMD_F5, er, ar, br, cr, dr, x[14], 0x50a28be6u, 9);
  SCR_RMD_STEP(SCR_RMD_F5, dr, er, ar, br, cr, x[7], 0x50a28be6u, 9);
  SCR_RMD_STEP(SCR_RMD_F5, cr, dr, er, ar, br, x[0], 0x50a28be6u, 11);
  SCR_RMD_STEP(SCR_RMD_F5, br, cr, dr, er, ar, x[9], 0x50a28be6u, 13);
  SCR_RMD_STEP(SCR_RMD_F5, ar, br, cr, dr, er, x[2], 0x50a28be6u, 15);
  SCR_RMD_STEP(SCR_RMD_F5, er, ar, br, cr, dr, x[11], 0x50a28be6u, 15);
  SCR_RMD_STEP(SCR_RMD_F5, dr, er, ar, br, cr, x[4], 0x50a28be6u, 5);
  SCR_RMD_STEP(SCR_RMD_F5, cr, dr, er, ar, br, x[13], 0x50a28be6u, 7);
  SCR_RMD_STEP(SCR_RMD_F5, br, cr, dr, er, ar, x[6], 0x50a28be6u, 7);
  SCR_RMD_STEP(SCR_RMD_F5, ar, br, cr, dr, er, x[15], 0x50a28be6u, 8);
  SCR_RMD_STEP(SCR_RMD_F5, er, ar, br, cr, dr, x[8], 0x50a28be6u, 11);
  SCR_RMD_STEP(SCR_RMD_F5, dr, er, ar, br, cr, x[1], 0x50a28be6u, 14);
  SCR_RMD_STEP(SCR_RMD_F5, cr, dr, er, ar, br, x[10], 0x50a28be6u, 14);
  SCR_RMD_STEP(SCR_RMD_F5, br, cr, dr, er, ar, x[3], 0x50a28be6u, 12);
  SCR_RMD_STEP(SCR_RMD_F5, ar, br, cr, dr, er, x[12], 0x50a28be6u, 6);
  SCR_RMD_STEP(SCR_RMD_F4, er, ar, br, cr, dr, x[6], 0x5c4dd124u, 9);
  SCR_RMD_STEP(SCR_RMD_F4, dr, er, ar, br, cr, x[11], 0x5c4dd124u, 13);
  SCR_RMD_STEP(SCR_RMD_F4, cr, dr, er, ar, br, x[3], 0x5c4dd124u, 15);
  SCR_RMD_STEP(SCR_RMD_F4, br, cr, dr, er, ar, x[7], 0x5c4dd124u, 7);
  SCR_RMD_STEP(SCR_RMD_F4, ar, br, cr, dr, er, x[0], 0x5c4dd124u, 12);
  SCR_RMD_STEP(SCR_RMD_F4, er, ar, br, cr, dr, x[13], 0x5c4dd124u, 8);
  SCR_RMD_STEP(SCR_RMD_F4, dr, er, ar, br, cr, x[5], 0x5c4dd124u, 9);
  SCR_RMD_STEP(SCR_RMD_F4, cr, dr, er, ar, br, x[10], 0x5c4dd124u, 11);
  SCR_RMD_STEP(SCR_RMD_F4, br, cr, dr, er, ar, x[14], 0x5c4dd124u, 7);
  SCR_RMD_STEP(SCR_RMD_F4, ar, br, cr, dr, er, x[15], 0x5c4dd124u, 7);
  SCR_RMD_STEP(SCR_RMD_F4, er, ar, br, cr, dr, x[8], 0x5c4dd124u, 12);
  SCR_RMD_STEP(SCR_RMD_F4, dr, er, ar, br, cr, x[12], 0x5c4dd124u, 7);
  SCR_RMD_STEP(SCR_RMD_F4, cr, dr, er, ar, br, x[4], 0x5c4dd124u, 6);
  SCR_RMD_STEP(SCR_RMD_F4, br, cr, dr, er, ar, x[9], 0x5c4dd124u, 15);
  SCR_RMD_STEP(SCR_RMD_F4, ar, br, cr, dr, er, x[1], 0x5c4dd124u, 13);
  SCR_RMD_STEP(SCR_RMD_F4, er, ar, br, cr, dr, x[2], 0x5c4dd124u, 11);
  SCR_RMD_STEP(SCR_RMD_F3, dr, er, ar, br, cr, x[15], 0x6d703ef3u, 9);
  SCR_RMD_STEP(SCR_RMD_F3, cr, dr, er, ar, br, x[5], 0x6d703ef3u, 7);
  SCR_RMD_STEP(SCR_RMD_F3, br, cr, dr, er, ar, x[1], 0x6d703ef3u, 15);
  SCR_RMD_STEP(SCR_RMD_F3, ar, br, cr, dr, er, x[3], 0x6d703ef3u, 11);
  SCR_RMD_STEP(SCR_RMD_F3, er, ar, br, cr, dr, x[7], 0x6d703ef3u, 8);
  SCR_RMD_STEP(SCR_RMD_F3, dr, er, ar, br, cr, x[14], 0x6d703ef3u, 6);
  SCR_RMD_STEP(SCR_RMD_F3, cr, dr, er, ar, br, x[6], 0x6d703ef3u, 6);
  SCR_RMD_STEP(SCR_RMD_F3, br, cr, dr, er, ar, x[9], 0x6d703ef3u, 14);
  SCR_RMD_STEP(SCR_RMD_F3, ar, br, cr, dr, er, x[11], 0x6d703ef3u, 12);
  SCR_RMD_STEP(SCR_RMD_F3, er, ar, br, cr, dr, x[8], 0x6d703ef3u, 13);
  SCR_RMD_STEP(SCR_RMD_F3, dr, er, ar, br, cr, x[12], 0x6d703ef3u, 5);
  SCR_RMD_STEP(SCR_RMD_F3, cr, dr, er, ar, br, x[2], 0x6d703ef3u, 14);
  SCR_RMD_STEP(SCR_RMD_F3, br, cr, dr, er, ar, x[10], 0x6d703ef3u, 13);
  SCR_RMD_STEP(SCR_RMD_F3, ar, br, cr, dr, er, x[0], 0x6d703ef3u, 13);
  SCR_RMD_STEP(SCR_RMD_F3, er, ar, br, cr, dr, x[4], 0x6d703ef3u, 7);
  SCR_RMD_STEP(SCR_RMD_F3, dr, er, ar, br, cr, x[13], 0x6d703ef3u, 5);
  SCR_RMD_STEP(SCR_RMD_F2, cr, dr, er, ar, br, x[8], 0x7a6d76e9u, 15);
  SCR_RMD_STEP(SCR_RMD_F2, br, cr, dr, er, ar, x[6], 0x7a6d76e9u, 5);
  SCR_RMD_STEP(SCR_RMD_F2, ar, br, cr, dr, er, x[4], 0x7a6d76e9u, 8);
  SCR_RMD_STEP(SCR_RMD_F2, er, ar, br, cr, dr, x[1], 0x7a6d76e9u, 11);
  SCR_RMD_STEP(SCR_RMD_F2, dr, er, ar, br, cr, x[3], 0x7a6d76e9u, 14);
  SCR_RMD_STEP(SCR_RMD_F2, cr, dr, er, ar, br, x[11], 0x7a6d76e9u, 14);
  SCR_RMD_STEP(SCR_RMD_F2, br, cr, dr, er, ar, x[15], 0x7a6d76e9u, 6);
  SCR_RMD_STEP(SCR_RMD_F2, ar, br, cr, dr, er, x[0], 0x7a6d76e9u, 14);
  SCR_RMD_STEP(SCR_RMD_F2, er, ar, br, cr, dr, x[5], 0x7a6d76e9u, 6);
  SCR_RMD_STEP(SCR_RMD_F2, dr, er, ar, br, cr, x[12], 0x7a6d76e9u, 9);
  SCR_RMD_STEP(SCR_RMD_F2, cr, dr, er, ar, br, x[2], 0x7a6d76e9u, 12);
  SCR_RMD_STEP(SCR_RMD_F2, br, cr, dr, er, ar, x[13], 0x7a6d76e9u, 9);
  SCR_RMD_STEP(SCR_RMD_F2, ar, br, cr, dr, er, x[9], 0x7a6d76e9u, 12);
  SCR_RMD_STEP(SCR_RMD_F2, er, ar, br, cr, dr, x[7], 0x7a6d76e9u, 5);
  SCR_RMD_STEP(SCR_RMD_F2, dr, er, ar, br, cr, x[10], 0x7a6d76e9u, 15);
  SCR_RMD_STEP(SCR_RMD_F2, cr, dr, er, ar, br, x[14], 0x7a6d76e9u, 8);
  SCR_RMD_STEP(SCR_RMD_F1, br, cr, dr, er, ar, x[12], 0x00000000u, 8);
  SCR_RMD_STEP(SCR_RMD_F1, ar, br, cr, dr, er, x[15], 0x00000000u, 5);
  SCR_RMD_STEP(SCR_RMD_F1, er, ar, br, cr, dr, x[10], 0x00000000u, 12);
  SCR_RMD_STEP(SCR_RMD_F1, dr, er, ar, br, cr, x[4], 0x00000000u, 9);
  SCR_RMD_STEP(SCR_RMD_F1, cr, dr, er, ar, br, x[1], 0x00000000u, 12);
  SCR_RMD_STEP(SCR_RMD_F1, br, cr, dr, er, ar, x[5], 0x00000000u, 5);
  SCR_RMD_STEP(SCR_RMD_F1, ar, br, cr, dr, er, x[8], 0x00000000u, 14);
  SCR_RMD_STEP(SCR_RMD_F1, er, ar, br, cr, dr, x[7], 0x00000000u, 6);
  SCR_RMD_STEP(SCR_RMD_F1, dr, er, ar, br, cr, x[6], 0x00000000u, 8);
  SCR_RMD_STEP(SCR_RMD_F1, cr, dr, er, ar, br, x[2], 0x00000000u, 13);
  SCR_RMD_STEP(SCR_RMD_F1, br, cr, dr, er, ar, x[13], 0x00000000u, 6);
  SCR_RMD_STEP(SCR_RMD_F1, ar, br, cr, dr, er, x[14], 0x00000000u, 5);
  SCR_RMD_STEP(SCR_RMD_F1, er, ar, br, cr, dr, x[0], 0x00000000u, 15);
  SCR_RMD_STEP(SCR_RMD_F1, dr, er, ar, br, cr, x[3], 0x00000000u, 13);
  SCR_RMD_STEP(SCR_RMD_F1, cr, dr, er, ar, br, x[9], 0x00000000u, 11);
  SCR_RMD_STEP(SCR_RMD_F1, br, cr, dr, er, ar, x[11], 0x00000000u, 11);
  uint32_t t = h[1] + cl + dr;
  h[1] = h[2] + dl + er;
  h[2] = h[3] + el + ar;
  h[3] = h[4] + al + br;
  h[4] = h[0] + bl + cr;
  h[0] = t;
}

#undef SCR_RMD_STEP
#undef SCR_RMD_F1
#undef SCR_RMD_F2
#undef SCR_RMD_F3
#undef SCR_RMD_F4
#undef SCR_RMD_F5

void scr_ripemd160_init(ScrRipemd160Ctx *ctx) {
  static const uint32_t initial[5] = {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0};
  memcpy(ctx->h, initial, sizeof initial);
  ctx->bytes = 0;
  ctx->len = 0;
}

void scr_ripemd160_update(ScrRipemd160Ctx *ctx, const unsigned char *data, size_t len) {
  ctx->bytes += len;
  if (ctx->len != 0) {
    size_t take = 64 - ctx->len;
    if (take > len) take = len;
    memcpy(ctx->buf + ctx->len, data, take);
    ctx->len += take;
    data += take;
    len -= take;
    if (ctx->len == 64) {
      scr_rmd_block(ctx->h, ctx->buf);
      ctx->len = 0;
    }
  }
  while (len >= 64) {
    scr_rmd_block(ctx->h, data);
    data += 64;
    len -= 64;
  }
  if (len != 0) {
    memcpy(ctx->buf, data, len);
    ctx->len = len;
  }
}

void scr_ripemd160_final(const ScrRipemd160Ctx *source, unsigned char out[20]) {
  ScrRipemd160Ctx ctx = *source;
  unsigned char tail[128];
  size_t rem = ctx.len;
  memcpy(tail, ctx.buf, rem);
  tail[rem] = 0x80;
  size_t pad = rem + 1 + 8 <= 64 ? 64 : 128;
  memset(tail + rem + 1, 0, pad - rem - 1 - 8);
  uint64_t bits = ctx.bytes * 8;
  for (int b = 0; b < 8; b++) tail[pad - 8 + b] = (unsigned char)(bits >> (8 * b));
  scr_rmd_block(ctx.h, tail);
  if (pad == 128) scr_rmd_block(ctx.h, tail + 64);
  for (int i = 0; i < 5; i++)
    for (int b = 0; b < 4; b++) out[i * 4 + b] = (unsigned char)(ctx.h[i] >> (8 * b));
}

/* ── BLAKE2b and BLAKE2s (RFC 7693, unkeyed) ───────────────────────── */

static const unsigned char scr_blake2_sigma[12][16] = {
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}, {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
    {11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4}, {7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
    {9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13}, {2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
    {12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11}, {13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
    {6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5}, {10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}, {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
};

static const uint64_t scr_blake2b_iv[8] = {
    0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL, 0x3c6ef372fe94f82bULL, 0xa54ff53a5f1d36f1ULL,
    0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL, 0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL,
};

static uint64_t scr_rotr64(uint64_t x, unsigned n) { return (x >> n) | (x << (64 - n)); }

SCR_DIGEST_ALIGNED static void scr_blake2b_compress(ScrBlake2bCtx *ctx, const unsigned char *block, bool last) {
  uint64_t m[16], v[16];
  for (int i = 0; i < 16; i++) {
    uint64_t w = 0;
    for (int b = 7; b >= 0; b--) w = (w << 8) | block[i * 8 + b];
    m[i] = w;
  }
  for (int i = 0; i < 8; i++) {
    v[i] = ctx->h[i];
    v[i + 8] = scr_blake2b_iv[i];
  }
  v[12] ^= ctx->t[0];
  v[13] ^= ctx->t[1];
  if (last) v[14] = ~v[14];
#define SCR_B2B_G(a, b, c, d, x, y)     \
  do {                                  \
    v[a] = v[a] + v[b] + (x);           \
    v[d] = scr_rotr64(v[d] ^ v[a], 32); \
    v[c] = v[c] + v[d];                 \
    v[b] = scr_rotr64(v[b] ^ v[c], 24); \
    v[a] = v[a] + v[b] + (y);           \
    v[d] = scr_rotr64(v[d] ^ v[a], 16); \
    v[c] = v[c] + v[d];                 \
    v[b] = scr_rotr64(v[b] ^ v[c], 63); \
  } while (0)
  /* The rounds are written out so each message index is a constant. */
#define SCR_B2B_ROUND(r)                                                             \
  do {                                                                               \
    SCR_B2B_G(0, 4, 8, 12, m[scr_blake2_sigma[r][0]], m[scr_blake2_sigma[r][1]]);    \
    SCR_B2B_G(1, 5, 9, 13, m[scr_blake2_sigma[r][2]], m[scr_blake2_sigma[r][3]]);    \
    SCR_B2B_G(2, 6, 10, 14, m[scr_blake2_sigma[r][4]], m[scr_blake2_sigma[r][5]]);   \
    SCR_B2B_G(3, 7, 11, 15, m[scr_blake2_sigma[r][6]], m[scr_blake2_sigma[r][7]]);   \
    SCR_B2B_G(0, 5, 10, 15, m[scr_blake2_sigma[r][8]], m[scr_blake2_sigma[r][9]]);   \
    SCR_B2B_G(1, 6, 11, 12, m[scr_blake2_sigma[r][10]], m[scr_blake2_sigma[r][11]]); \
    SCR_B2B_G(2, 7, 8, 13, m[scr_blake2_sigma[r][12]], m[scr_blake2_sigma[r][13]]);  \
    SCR_B2B_G(3, 4, 9, 14, m[scr_blake2_sigma[r][14]], m[scr_blake2_sigma[r][15]]);  \
  } while (0)
  SCR_B2B_ROUND(0); SCR_B2B_ROUND(1); SCR_B2B_ROUND(2); SCR_B2B_ROUND(3); SCR_B2B_ROUND(4); SCR_B2B_ROUND(5);
  SCR_B2B_ROUND(6); SCR_B2B_ROUND(7); SCR_B2B_ROUND(8); SCR_B2B_ROUND(9); SCR_B2B_ROUND(10); SCR_B2B_ROUND(11);
#undef SCR_B2B_ROUND
#undef SCR_B2B_G
  for (int i = 0; i < 8; i++) ctx->h[i] ^= v[i] ^ v[i + 8];
}

void scr_blake2b_init(ScrBlake2bCtx *ctx) {
  memset(ctx, 0, sizeof *ctx);
  memcpy(ctx->h, scr_blake2b_iv, sizeof scr_blake2b_iv);
  ctx->h[0] ^= 0x01010000ULL ^ 64; /* depth 1, fanout 1, no key, 64-byte digest */
}

void scr_blake2b_update(ScrBlake2bCtx *ctx, const unsigned char *data, size_t len) {
  while (len != 0) {
    /* The last block is held back so finalization can flag it. */
    if (ctx->len == 128) {
      ctx->t[0] += 128;
      if (ctx->t[0] < 128) ctx->t[1]++;
      scr_blake2b_compress(ctx, ctx->buf, false);
      ctx->len = 0;
    }
    size_t take = 128 - ctx->len;
    if (take > len) take = len;
    memcpy(ctx->buf + ctx->len, data, take);
    ctx->len += take;
    data += take;
    len -= take;
  }
}

void scr_blake2b_final(const ScrBlake2bCtx *source, unsigned char out[64]) {
  ScrBlake2bCtx ctx = *source;
  ctx.t[0] += ctx.len;
  if (ctx.t[0] < ctx.len) ctx.t[1]++;
  memset(ctx.buf + ctx.len, 0, 128 - ctx.len);
  scr_blake2b_compress(&ctx, ctx.buf, true);
  for (int i = 0; i < 64; i++) out[i] = (unsigned char)(ctx.h[i / 8] >> (8 * (i % 8)));
}

static const uint32_t scr_blake2s_iv[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                           0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};

static uint32_t scr_rotr32(uint32_t x, unsigned n) { return (x >> n) | (x << (32 - n)); }

SCR_DIGEST_ALIGNED static void scr_blake2s_compress(ScrBlake2sCtx *ctx, const unsigned char *block, bool last) {
  uint32_t m[16], v[16];
  for (int i = 0; i < 16; i++)
    m[i] = (uint32_t)block[i * 4] | ((uint32_t)block[i * 4 + 1] << 8) | ((uint32_t)block[i * 4 + 2] << 16) |
           ((uint32_t)block[i * 4 + 3] << 24);
  for (int i = 0; i < 8; i++) {
    v[i] = ctx->h[i];
    v[i + 8] = scr_blake2s_iv[i];
  }
  v[12] ^= ctx->t[0];
  v[13] ^= ctx->t[1];
  if (last) v[14] = ~v[14];
#define SCR_B2S_G(a, b, c, d, x, y)     \
  do {                                  \
    v[a] = v[a] + v[b] + (x);           \
    v[d] = scr_rotr32(v[d] ^ v[a], 16); \
    v[c] = v[c] + v[d];                 \
    v[b] = scr_rotr32(v[b] ^ v[c], 12); \
    v[a] = v[a] + v[b] + (y);           \
    v[d] = scr_rotr32(v[d] ^ v[a], 8);  \
    v[c] = v[c] + v[d];                 \
    v[b] = scr_rotr32(v[b] ^ v[c], 7);  \
  } while (0)
  /* The rounds are written out so each message index is a constant. */
#define SCR_B2S_ROUND(r)                                                             \
  do {                                                                               \
    SCR_B2S_G(0, 4, 8, 12, m[scr_blake2_sigma[r][0]], m[scr_blake2_sigma[r][1]]);    \
    SCR_B2S_G(1, 5, 9, 13, m[scr_blake2_sigma[r][2]], m[scr_blake2_sigma[r][3]]);    \
    SCR_B2S_G(2, 6, 10, 14, m[scr_blake2_sigma[r][4]], m[scr_blake2_sigma[r][5]]);   \
    SCR_B2S_G(3, 7, 11, 15, m[scr_blake2_sigma[r][6]], m[scr_blake2_sigma[r][7]]);   \
    SCR_B2S_G(0, 5, 10, 15, m[scr_blake2_sigma[r][8]], m[scr_blake2_sigma[r][9]]);   \
    SCR_B2S_G(1, 6, 11, 12, m[scr_blake2_sigma[r][10]], m[scr_blake2_sigma[r][11]]); \
    SCR_B2S_G(2, 7, 8, 13, m[scr_blake2_sigma[r][12]], m[scr_blake2_sigma[r][13]]);  \
    SCR_B2S_G(3, 4, 9, 14, m[scr_blake2_sigma[r][14]], m[scr_blake2_sigma[r][15]]);  \
  } while (0)
  SCR_B2S_ROUND(0); SCR_B2S_ROUND(1); SCR_B2S_ROUND(2); SCR_B2S_ROUND(3); SCR_B2S_ROUND(4); SCR_B2S_ROUND(5);
  SCR_B2S_ROUND(6); SCR_B2S_ROUND(7); SCR_B2S_ROUND(8); SCR_B2S_ROUND(9);
#undef SCR_B2S_ROUND
#undef SCR_B2S_G
  for (int i = 0; i < 8; i++) ctx->h[i] ^= v[i] ^ v[i + 8];
}

void scr_blake2s_init(ScrBlake2sCtx *ctx) {
  memset(ctx, 0, sizeof *ctx);
  memcpy(ctx->h, scr_blake2s_iv, sizeof scr_blake2s_iv);
  ctx->h[0] ^= 0x01010000u ^ 32; /* depth 1, fanout 1, no key, 32-byte digest */
}

void scr_blake2s_update(ScrBlake2sCtx *ctx, const unsigned char *data, size_t len) {
  while (len != 0) {
    if (ctx->len == 64) {
      ctx->t[0] += 64;
      if (ctx->t[0] < 64) ctx->t[1]++;
      scr_blake2s_compress(ctx, ctx->buf, false);
      ctx->len = 0;
    }
    size_t take = 64 - ctx->len;
    if (take > len) take = len;
    memcpy(ctx->buf + ctx->len, data, take);
    ctx->len += take;
    data += take;
    len -= take;
  }
}

void scr_blake2s_final(const ScrBlake2sCtx *source, unsigned char out[32]) {
  ScrBlake2sCtx ctx = *source;
  ctx.t[0] += (uint32_t)ctx.len;
  if (ctx.t[0] < ctx.len) ctx.t[1]++;
  memset(ctx.buf + ctx.len, 0, 64 - ctx.len);
  scr_blake2s_compress(&ctx, ctx.buf, true);
  for (int i = 0; i < 32; i++) out[i] = (unsigned char)(ctx.h[i / 4] >> (8 * (i % 4)));
}

/* ── SM3 ───────────────────────────────────────────────────────────── */

static uint32_t scr_sm3_p0(uint32_t x) { return x ^ scr_rotl32(x, 9) ^ scr_rotl32(x, 17); }
static uint32_t scr_sm3_p1(uint32_t x) { return x ^ scr_rotl32(x, 15) ^ scr_rotl32(x, 23); }

/* T_j rotated left by j mod 32. */
static const uint32_t scr_sm3_t[64] = {
    0x79cc4519u, 0xf3988a32u, 0xe7311465u, 0xce6228cbu, 0x9cc45197u, 0x3988a32fu,
    0x7311465eu, 0xe6228cbcu, 0xcc451979u, 0x988a32f3u, 0x311465e7u, 0x6228cbceu,
    0xc451979cu, 0x88a32f39u, 0x11465e73u, 0x228cbce6u, 0x9d8a7a87u, 0x3b14f50fu,
    0x7629ea1eu, 0xec53d43cu, 0xd8a7a879u, 0xb14f50f3u, 0x629ea1e7u, 0xc53d43ceu,
    0x8a7a879du, 0x14f50f3bu, 0x29ea1e76u, 0x53d43cecu, 0xa7a879d8u, 0x4f50f3b1u,
    0x9ea1e762u, 0x3d43cec5u, 0x7a879d8au, 0xf50f3b14u, 0xea1e7629u, 0xd43cec53u,
    0xa879d8a7u, 0x50f3b14fu, 0xa1e7629eu, 0x43cec53du, 0x879d8a7au, 0x0f3b14f5u,
    0x1e7629eau, 0x3cec53d4u, 0x79d8a7a8u, 0xf3b14f50u, 0xe7629ea1u, 0xcec53d43u,
    0x9d8a7a87u, 0x3b14f50fu, 0x7629ea1eu, 0xec53d43cu, 0xd8a7a879u, 0xb14f50f3u,
    0x629ea1e7u, 0xc53d43ceu, 0x8a7a879du, 0x14f50f3bu, 0x29ea1e76u, 0x53d43cecu,
    0xa7a879d8u, 0x4f50f3b1u, 0x9ea1e762u, 0x3d43cec5u,
};

SCR_DIGEST_ALIGNED static void scr_sm3_block(uint32_t v[8], const unsigned char *p) {
  uint32_t w[68], w1[64];
  for (int i = 0; i < 16; i++)
    w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) | ((uint32_t)p[i * 4 + 2] << 8) |
           (uint32_t)p[i * 4 + 3];
  for (int i = 16; i < 68; i++)
    w[i] = scr_sm3_p1(w[i - 16] ^ w[i - 9] ^ scr_rotl32(w[i - 3], 15)) ^ scr_rotl32(w[i - 13], 7) ^ w[i - 6];
  for (int i = 0; i < 64; i++) w1[i] = w[i] ^ w[i + 4];
  uint32_t a = v[0], b = v[1], c = v[2], d = v[3], e = v[4], f = v[5], g = v[6], h = v[7];
  /* Rounds 0-15 and 16-63 use different boolean functions. */
#define SCR_SM3_ROUND(ff, gg)                                           \
  do {                                                                  \
    uint32_t ss1 = scr_rotl32(scr_rotl32(a, 12) + e + scr_sm3_t[j], 7); \
    uint32_t ss2 = ss1 ^ scr_rotl32(a, 12);                             \
    uint32_t tt1 = (ff) + d + ss2 + w1[j];                              \
    uint32_t tt2 = (gg) + h + ss1 + w[j];                               \
    d = c;                                                              \
    c = scr_rotl32(b, 9);                                               \
    b = a;                                                              \
    a = tt1;                                                            \
    h = g;                                                              \
    g = scr_rotl32(f, 19);                                              \
    f = e;                                                              \
    e = scr_sm3_p0(tt2);                                                \
  } while (0)
  for (unsigned j = 0; j < 16; j++) SCR_SM3_ROUND(a ^ b ^ c, e ^ f ^ g);
  for (unsigned j = 16; j < 64; j++) SCR_SM3_ROUND((a & b) | (a & c) | (b & c), (e & f) | (~e & g));
#undef SCR_SM3_ROUND
  v[0] ^= a;
  v[1] ^= b;
  v[2] ^= c;
  v[3] ^= d;
  v[4] ^= e;
  v[5] ^= f;
  v[6] ^= g;
  v[7] ^= h;
}

void scr_sm3_init(ScrSm3Ctx *ctx) {
  static const uint32_t initial[8] = {0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
                                      0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e};
  memcpy(ctx->h, initial, sizeof initial);
  ctx->bytes = 0;
  ctx->len = 0;
}

void scr_sm3_update(ScrSm3Ctx *ctx, const unsigned char *data, size_t len) {
  ctx->bytes += len;
  if (ctx->len != 0) {
    size_t take = 64 - ctx->len;
    if (take > len) take = len;
    memcpy(ctx->buf + ctx->len, data, take);
    ctx->len += take;
    data += take;
    len -= take;
    if (ctx->len == 64) {
      scr_sm3_block(ctx->h, ctx->buf);
      ctx->len = 0;
    }
  }
  while (len >= 64) {
    scr_sm3_block(ctx->h, data);
    data += 64;
    len -= 64;
  }
  if (len != 0) {
    memcpy(ctx->buf, data, len);
    ctx->len = len;
  }
}

void scr_sm3_final(const ScrSm3Ctx *source, unsigned char out[32]) {
  ScrSm3Ctx ctx = *source;
  unsigned char tail[128];
  size_t rem = ctx.len;
  memcpy(tail, ctx.buf, rem);
  tail[rem] = 0x80;
  size_t pad = rem + 1 + 8 <= 64 ? 64 : 128;
  memset(tail + rem + 1, 0, pad - rem - 1 - 8);
  uint64_t bits = ctx.bytes * 8;
  for (int b = 0; b < 8; b++) tail[pad - 1 - b] = (unsigned char)(bits >> (8 * b));
  scr_sm3_block(ctx.h, tail);
  if (pad == 128) scr_sm3_block(ctx.h, tail + 64);
  for (int i = 0; i < 8; i++)
    for (int b = 0; b < 4; b++) out[i * 4 + b] = (unsigned char)(ctx.h[i] >> (24 - 8 * b));
}
