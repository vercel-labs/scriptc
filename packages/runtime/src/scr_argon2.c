/* Argon2 (RFC 9106) for node:crypto's crypto.argon2 and crypto.argon2Sync:
 * the three variants, with the password, nonce, secret and associated-data
 * inputs and the memory, pass, parallelism and tag-length parameters Node
 * passes through. BLAKE2b comes with the implementation because Argon2
 * needs its unkeyed form with a variable output length. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── BLAKE2b (RFC 7693), unkeyed, any output length 1..64 ────────────── */

static const uint64_t blake2b_iv[8] = {
    UINT64_C(0x6a09e667f3bcc908), UINT64_C(0xbb67ae8584caa73b),
    UINT64_C(0x3c6ef372fe94f82b), UINT64_C(0xa54ff53a5f1d36f1),
    UINT64_C(0x510e527fade682d1), UINT64_C(0x9b05688c2b3e6c1f),
    UINT64_C(0x1f83d9abfb41bd6b), UINT64_C(0x5be0cd19137e2179),
};

static const unsigned char blake2b_sigma[12][16] = {
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
    {11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4},
    {7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
    {9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13},
    {2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
    {12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11},
    {13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
    {6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5},
    {10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
};

static uint64_t rotr64(uint64_t x, unsigned n) { return (x >> n) | (x << (64 - n)); }

#define B2B_G(a, b, c, d, x, y)                    \
  do {                                             \
    (a) = (a) + (b) + (x);                         \
    (d) = rotr64((d) ^ (a), 32);                   \
    (c) = (c) + (d);                               \
    (b) = rotr64((b) ^ (c), 24);                   \
    (a) = (a) + (b) + (y);                         \
    (d) = rotr64((d) ^ (a), 16);                   \
    (c) = (c) + (d);                               \
    (b) = rotr64((b) ^ (c), 63);                   \
  } while (0)

static void blake2b_compress(uint64_t h[8], const unsigned char block[128], uint64_t t0,
                             uint64_t t1, bool last) {
  uint64_t m[16], v[16];
  for (int i = 0; i < 16; i++) {
    m[i] = 0;
    for (int j = 7; j >= 0; j--) m[i] = (m[i] << 8) | block[i * 8 + j];
  }
  for (int i = 0; i < 8; i++) {
    v[i] = h[i];
    v[i + 8] = blake2b_iv[i];
  }
  v[12] ^= t0;
  v[13] ^= t1;
  if (last) v[14] = ~v[14];
  for (int r = 0; r < 12; r++) {
    const unsigned char *s = blake2b_sigma[r];
    B2B_G(v[0], v[4], v[8], v[12], m[s[0]], m[s[1]]);
    B2B_G(v[1], v[5], v[9], v[13], m[s[2]], m[s[3]]);
    B2B_G(v[2], v[6], v[10], v[14], m[s[4]], m[s[5]]);
    B2B_G(v[3], v[7], v[11], v[15], m[s[6]], m[s[7]]);
    B2B_G(v[0], v[5], v[10], v[15], m[s[8]], m[s[9]]);
    B2B_G(v[1], v[6], v[11], v[12], m[s[10]], m[s[11]]);
    B2B_G(v[2], v[7], v[8], v[13], m[s[12]], m[s[13]]);
    B2B_G(v[3], v[4], v[9], v[14], m[s[14]], m[s[15]]);
  }
  for (int i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

static void blake2b(void *out, size_t outlen, const void *in, size_t inlen) {
  uint64_t h[8];
  for (int i = 0; i < 8; i++) h[i] = blake2b_iv[i];
  h[0] ^= 0x01010000u ^ (uint64_t)outlen;
  const unsigned char *p = in;
  uint64_t t = 0;
  while (inlen > 128) {
    t += 128;
    blake2b_compress(h, p, t, 0, false);
    p += 128;
    inlen -= 128;
  }
  unsigned char last[128];
  memset(last, 0, sizeof last);
  memcpy(last, p, inlen);
  t += inlen;
  blake2b_compress(h, last, t, 0, true);
  unsigned char full[64];
  for (int i = 0; i < 8; i++)
    for (int j = 0; j < 8; j++) full[i * 8 + j] = (unsigned char)(h[i] >> (8 * j));
  memcpy(out, full, outlen);
}

/* ── Argon2 core ─────────────────────────────────────────────────────── */

#define ARGON2_BLOCK_WORDS 128

/* A derivation whose working set cannot be allocated answers like Node's
 * failed EVP_KDF setup instead of wrapping the size arithmetic. */
static void scr_argon2_operation_failed(void) {
  static const char msg[] = "Failed to initialize Argon2";
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_CRYPTO_OPERATION_FAILED");
}

static uint32_t load32(const unsigned char *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
         ((uint32_t)p[3] << 24);
}

static void store32(unsigned char *p, uint32_t v) {
  p[0] = (unsigned char)v;
  p[1] = (unsigned char)(v >> 8);
  p[2] = (unsigned char)(v >> 16);
  p[3] = (unsigned char)(v >> 24);
}

/* Argon2's G is Blake2b's round with the multiplication term (BlaMka). */
static uint64_t blamka(uint64_t a, uint64_t b) {
  return a + b + 2 * (a & 0xffffffffu) * (b & 0xffffffffu);
}

#define A2_G(a, b, c, d)              \
  do {                                \
    (a) = blamka((a), (b));           \
    (d) = rotr64((d) ^ (a), 32);      \
    (c) = blamka((c), (d));           \
    (b) = rotr64((b) ^ (c), 24);      \
    (a) = blamka((a), (b));           \
    (d) = rotr64((d) ^ (a), 16);      \
    (c) = blamka((c), (d));           \
    (b) = rotr64((b) ^ (c), 63);      \
  } while (0)

static void argon2_round(uint64_t *v) {
  A2_G(v[0], v[4], v[8], v[12]);
  A2_G(v[1], v[5], v[9], v[13]);
  A2_G(v[2], v[6], v[10], v[14]);
  A2_G(v[3], v[7], v[11], v[15]);
  A2_G(v[0], v[5], v[10], v[15]);
  A2_G(v[1], v[6], v[11], v[12]);
  A2_G(v[2], v[7], v[8], v[13]);
  A2_G(v[3], v[4], v[9], v[14]);
}

static void argon2_permute(uint64_t *v) {
  for (int i = 0; i < 8; i++) argon2_round(v + 16 * i);
  for (int i = 0; i < 8; i++) {
    uint64_t col[16];
    for (int j = 0; j < 8; j++) {
      col[2 * j] = v[16 * j + 2 * i];
      col[2 * j + 1] = v[16 * j + 2 * i + 1];
    }
    argon2_round(col);
    for (int j = 0; j < 8; j++) {
      v[16 * j + 2 * i] = col[2 * j];
      v[16 * j + 2 * i + 1] = col[2 * j + 1];
    }
  }
}

/* G(X, Y): XOR, permute, XOR again. */
static void argon2_g(uint64_t *out, const uint64_t *x, const uint64_t *y) {
  uint64_t r[ARGON2_BLOCK_WORDS];
  for (int i = 0; i < ARGON2_BLOCK_WORDS; i++) r[i] = x[i] ^ y[i];
  argon2_permute(r);
  for (int i = 0; i < ARGON2_BLOCK_WORDS; i++) out[i] = r[i] ^ x[i] ^ y[i];
}

/* H' with the requested output length. */
static void argon2_hprime(unsigned char *out, size_t outlen, const unsigned char *in,
                          size_t inlen) {
  unsigned char prefix[4];
  store32(prefix, (uint32_t)outlen);
  if (outlen <= 64) {
    size_t n = inlen + 4;
    unsigned char *buf = malloc(n);
    if (!buf) scr_trap("scriptc: out of memory\n");
    memcpy(buf, prefix, 4);
    memcpy(buf + 4, in, inlen);
    blake2b(out, outlen, buf, n);
    free(buf);
    return;
  }
  size_t r = (outlen + 31) / 32 - 2;
  unsigned char v[64];
  size_t n = inlen + 4;
  unsigned char *buf = malloc(n);
  if (!buf) scr_trap("scriptc: out of memory\n");
  memcpy(buf, prefix, 4);
  memcpy(buf + 4, in, inlen);
  blake2b(v, 64, buf, n);
  memcpy(out, v, 32);
  size_t produced = 32;
  for (size_t i = 1; i < r; i++) {
    blake2b(v, 64, v, 64);
    memcpy(out + produced, v, 32);
    produced += 32;
  }
  blake2b(v, outlen - produced, v, 64);
  memcpy(out + produced, v, outlen - produced);
  free(buf);
}

ScrBytes *scr_argon2_hash(const char *algorithm, const unsigned char *pwd, size_t pwd_len,
                          const unsigned char *salt, size_t salt_len,
                          const unsigned char *secret, size_t secret_len,
                          const unsigned char *ad, size_t ad_len, uint32_t passes,
                          uint32_t memory, uint32_t parallelism, uint32_t tag_len) {
  uint32_t type = strcmp(algorithm, "argon2d") == 0 ? 0
                  : strcmp(algorithm, "argon2i") == 0 ? 1
                                                      : 2;
  uint32_t m = memory < 8 * parallelism ? 8 * parallelism : memory;
  m = (m / (4 * parallelism)) * 4 * parallelism;
  uint32_t lane_length = m / parallelism;
  uint32_t segment_length = lane_length / 4;
  /* H0 */
  /* Six 32-bit parameters and four 32-bit length words, then the inputs.
   * The sizes are added and multiplied with overflow checks: a 32-bit
   * size_t wraps above 4 GiB, and a wrapped buffer would be overflowed. */
  size_t input_len = pwd_len;
  if (salt_len > SIZE_MAX - input_len || secret_len > SIZE_MAX - input_len - salt_len ||
      ad_len > SIZE_MAX - input_len - salt_len - secret_len ||
      input_len + salt_len + secret_len + ad_len > SIZE_MAX - 4 * 10) {
    scr_argon2_operation_failed();
    return NULL;
  }
  input_len += salt_len + secret_len + ad_len;
  size_t h0_len = 4 * 10 + input_len;
  unsigned char *h0_in = malloc(h0_len ? h0_len : 1);
  if (!h0_in) scr_trap("scriptc: out of memory\n");
  unsigned char *q = h0_in;
  store32(q, parallelism); q += 4;
  store32(q, tag_len); q += 4;
  store32(q, memory); q += 4;
  store32(q, passes); q += 4;
  store32(q, 0x13); q += 4;
  store32(q, type); q += 4;
  store32(q, (uint32_t)pwd_len); q += 4;
  if (pwd_len) memcpy(q, pwd, pwd_len); q += pwd_len;
  store32(q, (uint32_t)salt_len); q += 4;
  if (salt_len) memcpy(q, salt, salt_len); q += salt_len;
  store32(q, (uint32_t)secret_len); q += 4;
  if (secret_len) memcpy(q, secret, secret_len); q += secret_len;
  store32(q, (uint32_t)ad_len); q += 4;
  if (ad_len) memcpy(q, ad, ad_len);
  unsigned char h0[64];
  blake2b(h0, 64, h0_in, h0_len);
  free(h0_in);

  if ((size_t)m > SIZE_MAX / (ARGON2_BLOCK_WORDS * sizeof(uint64_t))) {
    scr_argon2_operation_failed();
    return NULL;
  }
  uint64_t *blocks = calloc((size_t)m * ARGON2_BLOCK_WORDS, sizeof(uint64_t));
  if (!blocks) scr_trap("scriptc: out of memory\n");
  for (uint32_t l = 0; l < parallelism; l++) {
    unsigned char seed[72];
    memcpy(seed, h0, 64);
    store32(seed + 64, 0);
    store32(seed + 68, l);
    argon2_hprime((unsigned char *)(blocks + ((size_t)l * lane_length + 0) * ARGON2_BLOCK_WORDS),
                  1024, seed, 72);
    store32(seed + 64, 1);
    argon2_hprime((unsigned char *)(blocks + ((size_t)l * lane_length + 1) * ARGON2_BLOCK_WORDS),
                  1024, seed, 72);
  }

  uint64_t address_block[ARGON2_BLOCK_WORDS], input_block[ARGON2_BLOCK_WORDS],
      zero_block[ARGON2_BLOCK_WORDS], tmp[ARGON2_BLOCK_WORDS];
  memset(zero_block, 0, sizeof zero_block);

  for (uint32_t pass = 0; pass < passes; pass++) {
    for (uint32_t slice = 0; slice < 4; slice++) {
      for (uint32_t lane = 0; lane < parallelism; lane++) {
        bool data_independent =
            type == 1 || (type == 2 && pass == 0 && slice < 2);
        /* The first two blocks of each lane are derived from H0, for
         * every variant. */
        uint32_t starting_index = 0;
        if (pass == 0 && slice == 0) starting_index = 2;
        if (data_independent) {
          memset(input_block, 0, sizeof input_block);
          input_block[0] = pass;
          input_block[1] = lane;
          input_block[2] = slice;
          input_block[3] = m;
          input_block[4] = passes;
          input_block[5] = type;
          uint32_t counter = 0;
          for (uint32_t j = starting_index; j < segment_length; j++) {
            uint32_t index_in_segment = j % ARGON2_BLOCK_WORDS;
            if (index_in_segment == 0 || j == starting_index) {
              counter++;
              input_block[6] = counter;
              argon2_g(tmp, zero_block, input_block);
              argon2_g(address_block, zero_block, tmp);
            }
            uint64_t pseudo = address_block[index_in_segment];
            uint32_t j1 = (uint32_t)(pseudo & 0xffffffffu);
            uint32_t j2 = (uint32_t)(pseudo >> 32);
            uint32_t ref_lane = (pass == 0 && slice == 0) ? lane : j2 % parallelism;
            uint32_t index = slice * segment_length + j;
            uint32_t ref_area, start;
            if (pass == 0) {
              if (slice == 0) {
                ref_area = j - 1;
                start = 0;
              } else if (ref_lane == lane) {
                ref_area = slice * segment_length + j - 1;
                start = 0;
              } else {
                ref_area = slice * segment_length + (j == 0 ? (uint32_t)-1 : 0);
                start = 0;
              }
            } else {
              if (ref_lane == lane) {
                ref_area = lane_length - segment_length + j - 1;
                start = ((slice + 1) * segment_length) % lane_length;
              } else {
                ref_area = lane_length - segment_length + (j == 0 ? (uint32_t)-1 : 0);
                start = ((slice + 1) * segment_length) % lane_length;
              }
            }
            uint64_t rel = ((uint64_t)j1 * (uint64_t)j1) >> 32;
            rel = ref_area - 1 -
                  (((uint64_t)ref_area * rel) >> 32);
            uint32_t ref_index = (uint32_t)((start + rel) % lane_length);
            uint64_t *prev = blocks + ((size_t)lane * lane_length +
                                       (index == 0 ? lane_length - 1 : index - 1)) *
                                          ARGON2_BLOCK_WORDS;
            uint64_t *ref = blocks +
                            ((size_t)ref_lane * lane_length + ref_index) * ARGON2_BLOCK_WORDS;
            uint64_t *cur = blocks + ((size_t)lane * lane_length + index) * ARGON2_BLOCK_WORDS;
            argon2_g(tmp, prev, ref);
            for (int w = 0; w < ARGON2_BLOCK_WORDS; w++)
              cur[w] = (pass == 0 ? 0 : cur[w]) ^ tmp[w];
          }
        } else {
          for (uint32_t j = starting_index; j < segment_length; j++) {
            uint32_t index = slice * segment_length + j;
            uint64_t *prev = blocks + ((size_t)lane * lane_length +
                                       (index == 0 ? lane_length - 1 : index - 1)) *
                                          ARGON2_BLOCK_WORDS;
            uint64_t pseudo = prev[0];
            uint32_t j1 = (uint32_t)(pseudo & 0xffffffffu);
            uint32_t j2 = (uint32_t)(pseudo >> 32);
            uint32_t ref_lane = (pass == 0 && slice == 0) ? lane : j2 % parallelism;
            uint32_t ref_area, start;
            if (pass == 0) {
              if (slice == 0) {
                ref_area = j - 1;
                start = 0;
              } else if (ref_lane == lane) {
                ref_area = slice * segment_length + j - 1;
                start = 0;
              } else {
                ref_area = slice * segment_length + (j == 0 ? (uint32_t)-1 : 0);
                start = 0;
              }
            } else {
              if (ref_lane == lane) {
                ref_area = lane_length - segment_length + j - 1;
                start = ((slice + 1) * segment_length) % lane_length;
              } else {
                ref_area = lane_length - segment_length + (j == 0 ? (uint32_t)-1 : 0);
                start = ((slice + 1) * segment_length) % lane_length;
              }
            }
            uint64_t rel = ((uint64_t)j1 * (uint64_t)j1) >> 32;
            rel = ref_area - 1 - (((uint64_t)ref_area * rel) >> 32);
            uint32_t ref_index = (uint32_t)((start + rel) % lane_length);
            uint64_t *ref = blocks +
                            ((size_t)ref_lane * lane_length + ref_index) * ARGON2_BLOCK_WORDS;
            uint64_t *cur = blocks + ((size_t)lane * lane_length + index) * ARGON2_BLOCK_WORDS;
            argon2_g(tmp, prev, ref);
            for (int w = 0; w < ARGON2_BLOCK_WORDS; w++)
              cur[w] = (pass == 0 ? 0 : cur[w]) ^ tmp[w];
          }
        }
      }
    }
  }

  uint64_t final_block[ARGON2_BLOCK_WORDS];
  memcpy(final_block, blocks + ((size_t)(lane_length - 1)) * ARGON2_BLOCK_WORDS,
         sizeof final_block);
  for (uint32_t l = 1; l < parallelism; l++) {
    const uint64_t *last = blocks + ((size_t)l * lane_length + lane_length - 1) * ARGON2_BLOCK_WORDS;
    for (int w = 0; w < ARGON2_BLOCK_WORDS; w++) final_block[w] ^= last[w];
  }
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)tag_len);
  if (!out) {
    /* The requested tag length is not addressable on this target; the
     * RangeError scr_bytes_new raised stays pending. */
    free(blocks);
    return NULL;
  }
  argon2_hprime(out->data, tag_len, (const unsigned char *)final_block, 1024);
  free(blocks);
  return out;
}

/* ── crypto.argon2Sync and crypto.argon2 ─────────────────────────────── */

static ScrBytes *argon2_value_bytes(const char *name, const ScrDyn *value) {
  if (value->kind == SCR_DYN_STR) {
    ScrStr *utf8 = scr_str_new("utf8", 4);
    ScrBytes *bytes = scr_bytes_from_str(value->v.str, utf8);
    scr_str_release(utf8);
    return bytes;
  }
  if (value->kind == SCR_DYN_BYTES || scr_buffer_storage_is(value))
    return scr_bytes_buffer_source(value);
  scr_dyn_prop_type_fail(
      name, "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", value);
  return NULL;
}

static bool argon2_integer(const char *name, const ScrDyn *value, double min, double max,
                           uint32_t *out) {
  if (value->kind != SCR_DYN_NUM) {
    char message[96];
    snprintf(message, sizeof message, "parameters.%s", name);
    scr_dyn_prop_type_fail(message, "of type number", value);
    return false;
  }
  double x = value->v.num;
  if (!(x == x) || x == 1.0 / 0.0 || x == -1.0 / 0.0 || trunc(x) != x) {
    char message[160], label[96];
    snprintf(label, sizeof label, "parameters.%s", name);
    snprintf(message, sizeof message,
             "The value of \"%s\" is out of range. It must be an integer. Received %g", label, x);
    scr_throw_error_msg_code(SCR_ERR_RANGE, message, strlen(message), "ERR_OUT_OF_RANGE");
    return false;
  }
  if (x < min || x > max) {
    char message[192], label[96];
    snprintf(label, sizeof label, "parameters.%s", name);
    snprintf(message, sizeof message,
             "The value of \"%s\" is out of range. It must be >= %.0f && <= %.0f. Received %.0f",
             label, min, max, x);
    scr_throw_error_msg_code(SCR_ERR_RANGE, message, strlen(message), "ERR_OUT_OF_RANGE");
    return false;
  }
  *out = (uint32_t)x;
  return true;
}

/* One optional BufferSource member (+1), or NULL when absent. */
/* An optional BufferSource member: true with *out NULL when absent, and
 * false with Node's TypeError pending when it is there but invalid. */
static bool argon2_optional_bytes(const ScrDyn *options, const char *name, ScrBytes **out) {
  ScrDyn *value = scr_dyn_obj_read(options, name, strlen(name));
  /* A NULL read is a throwing getter: its exception is pending and the
   * derivation must not run. */
  if (!value) return !scr_exc_pending();
  if (value->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(value);
    return true;
  }
  char label[64];
  snprintf(label, sizeof label, "parameters.%s", name);
  *out = argon2_value_bytes(label, value);
  scr_dyn_release(value);
  return *out != NULL;
}

static ScrBytes *argon2_required_bytes(const ScrDyn *options, const char *name) {
  ScrDyn *value = scr_dyn_obj_read(options, name, strlen(name));
  char label[64];
  snprintf(label, sizeof label, "parameters.%s", name);
  ScrBytes *bytes = value ? argon2_value_bytes(label, value) : NULL;
  if (value) scr_dyn_release(value);
  return bytes;
}

/* A typed value boxed for the checked-dynamic boundary reads its members
 * through the plain view it materializes. */
static bool argon2_plain(ScrDyn **value) {
  if ((*value)->kind != SCR_DYN_TYPED_REF) return true;
  ScrDyn *plain = scr_dyn_typed_ref_materialize(*value);
  if (!plain) return false;
  scr_dyn_release(*value);
  *value = plain;
  return true;
}

/* The Buffer for a completed derivation (+1), or NULL with the error
 * pending. */
static ScrDyn *scr_argon2_run(ScrDyn *algorithm, ScrDyn *parameters) {
  if (algorithm->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("algorithm", "of type string", algorithm);
    return NULL;
  }
  const ScrStr *name = algorithm->v.str;
  const char *alg = NULL;
  if (name->len == 7 && memcmp(name->data, "argon2d", 7) == 0) alg = "argon2d";
  else if (name->len == 7 && memcmp(name->data, "argon2i", 7) == 0) alg = "argon2i";
  else if (name->len == 8 && memcmp(name->data, "argon2id", 8) == 0) alg = "argon2id";
  if (!alg) {
    char message[128];
    snprintf(message, sizeof message,
             "The argument 'algorithm' must be one of: 'argon2d', 'argon2i', 'argon2id'. "
             "Received '%.*s'",
             (int)(name->len > 40 ? 40 : name->len), name->data);
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, strlen(message), "ERR_INVALID_ARG_VALUE");
    return NULL;
  }
  if (!scr_dyn_is_object(parameters) || parameters->kind == SCR_DYN_ARR) {
    scr_dyn_arg_type_fail("parameters", "of type object", parameters);
    return NULL;
  }
  ScrBytes *message = argon2_required_bytes(parameters, "message");
  if (!message) return NULL;
  ScrBytes *nonce = argon2_required_bytes(parameters, "nonce");
  if (!nonce) {
    scr_bytes_release(message);
    return NULL;
  }
  if (scr_bytes_byte_len(nonce) < 8 ||
      scr_bytes_byte_len(nonce) > 4294967295.0) {
    char msg[160];
    snprintf(msg, sizeof msg,
             "The value of \"parameters.nonce.byteLength\" is out of range. It must be >= 8 && <= "
             "4294967295. Received %.0f",
             scr_bytes_byte_len(nonce));
    scr_bytes_release(message);
    scr_bytes_release(nonce);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, strlen(msg), "ERR_OUT_OF_RANGE");
    return NULL;
  }
  ScrDyn *parallelism_value = scr_dyn_obj_read(parameters, "parallelism", 11);
  uint32_t parallelism = 0;
  bool ok = parallelism_value && argon2_integer("parallelism", parallelism_value, 1, 16777215,
                                                &parallelism);
  if (parallelism_value) scr_dyn_release(parallelism_value);
  ScrDyn *tag_value = ok ? scr_dyn_obj_read(parameters, "tagLength", 9) : NULL;
  uint32_t tag_length = 0;
  ok = ok && tag_value && argon2_integer("tagLength", tag_value, 4, 4294967295.0, &tag_length);
  if (tag_value) scr_dyn_release(tag_value);
  ScrDyn *memory_value = ok ? scr_dyn_obj_read(parameters, "memory", 6) : NULL;
  uint32_t memory = 0;
  ok = ok && memory_value &&
       argon2_integer("memory", memory_value, 8.0 * parallelism, 4294967295.0, &memory);
  if (memory_value) scr_dyn_release(memory_value);
  ScrDyn *passes_value = ok ? scr_dyn_obj_read(parameters, "passes", 6) : NULL;
  uint32_t passes = 0;
  ok = ok && passes_value && argon2_integer("passes", passes_value, 1, 4294967295.0, &passes);
  if (passes_value) scr_dyn_release(passes_value);
  ScrBytes *secret = NULL;
  ScrBytes *ad = NULL;
  if (ok) ok = argon2_optional_bytes(parameters, "secret", &secret);
  if (ok) ok = argon2_optional_bytes(parameters, "associatedData", &ad);
  if (!ok) {
    scr_bytes_release(message);
    scr_bytes_release(nonce);
    if (secret) scr_bytes_release(secret);
    if (ad) scr_bytes_release(ad);
    return NULL;
  }
  ScrBytes *out = scr_argon2_hash(
      alg, message->data, (size_t)scr_bytes_byte_len(message), nonce->data,
      (size_t)scr_bytes_byte_len(nonce), secret ? secret->data : NULL,
      secret ? (size_t)scr_bytes_byte_len(secret) : 0, ad ? ad->data : NULL,
      ad ? (size_t)scr_bytes_byte_len(ad) : 0, passes, memory, parallelism, tag_length);
  scr_bytes_release(message);
  scr_bytes_release(nonce);
  if (secret) scr_bytes_release(secret);
  if (ad) scr_bytes_release(ad);
  if (!out) return NULL;
  ScrDyn *result = scr_dyn_new_buffer(out);
  scr_bytes_release(out);
  return result;
}

/* The argument vector: [algorithm, parameters]. */
ScrDyn *scr_crypto_argon2_sync(ScrDyn *args) {
  size_t argc = (size_t)scr_dyn_arr_len(args);
  ScrDyn *algorithm = argc > 0 ? scr_dyn_arr_at(args, 0) : scr_dyn_undefined();
  ScrDyn *parameters = argc > 1 ? scr_dyn_arr_at(args, 1) : scr_dyn_undefined();
  if (!argon2_plain(&algorithm) || !argon2_plain(&parameters)) {
    scr_dyn_release(algorithm);
    scr_dyn_release(parameters);
    return NULL;
  }
  ScrDyn *out = scr_argon2_run(algorithm, parameters);
  scr_dyn_release(algorithm);
  scr_dyn_release(parameters);
  return out;
}

/* The deferred queue's adapter: the closure holds the program's callback,
 * and the value slot holds the Buffer's bytes. */
static void scr_argon2_settle(ScrClosure *cb, ScrError *error, ScrBytes *value) {
  (void)error;
  ScrDyn *callback = (ScrDyn *)scr_box_get_ref(cb->caps[0]);
  /* The queue hands the value over: the Buffer holds its own reference. */
  ScrDyn *out = scr_dyn_new_buffer(value);
  scr_bytes_release(value);
  ScrDyn *no_error = scr_dyn_new_null();
  ScrDyn *argv[2] = {no_error, out};
  ScrDyn *r = scr_dyn_call(callback, argv, 2, "callback");
  if (r) scr_dyn_release(r);
  scr_dyn_release(no_error);
  scr_dyn_release(out);
  scr_dyn_release(callback);
}

/* The argument vector: [algorithm, parameters, callback]; the callback
 * receives (null, buffer) in a later macrotask. */
ScrDyn *scr_crypto_argon2_cb(ScrDyn *args) {
  size_t argc = (size_t)scr_dyn_arr_len(args);
  ScrDyn *algorithm = argc > 0 ? scr_dyn_arr_at(args, 0) : scr_dyn_undefined();
  ScrDyn *parameters = argc > 1 ? scr_dyn_arr_at(args, 1) : scr_dyn_undefined();
  ScrDyn *callback = argc > 2 ? scr_dyn_arr_at(args, 2) : scr_dyn_undefined();
  if (!argon2_plain(&algorithm) || !argon2_plain(&parameters)) {
    scr_dyn_release(algorithm);
    scr_dyn_release(parameters);
    scr_dyn_release(callback);
    return NULL;
  }
  ScrDyn *out = scr_argon2_run(algorithm, parameters);
  scr_dyn_release(algorithm);
  scr_dyn_release(parameters);
  if (!out) {
    scr_dyn_release(callback);
    return NULL;
  }
  if (!scr_dyn_is_callable(callback)) {
    scr_dyn_release(out);
    scr_dyn_arg_type_fail("callback", "of type function", callback);
    scr_dyn_release(callback);
    return NULL;
  }
  /* Argon2 is a job like scrypt's: its callback rides the deferred crypto
   * queue, which keeps the loop live until it runs. */
  ScrBytes *bytes = scr_bytes_buffer_source(out);
  scr_dyn_release(out);
  ScrClosure *settle = scr_closure_new(scr_argon2_settle, 1);
  settle->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(settle->caps[0], callback);
  scr_crypto_defer_bytes(bytes, NULL, settle, scr_argon2_settle);
  return NULL;
}
