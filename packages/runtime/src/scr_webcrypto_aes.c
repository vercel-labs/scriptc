/* WebCrypto's AES ciphers: crypto.subtle.encrypt and decrypt with AES-CBC,
 * AES-CTR and AES-GCM keys, over the vendored mbedTLS block cipher.
 *
 * scr_webcrypto.c converts and validates the arguments, normalizes the
 * algorithm and checks the key; this unit runs the cipher itself, the way
 * Node 24's src/crypto/crypto_aes.cc does: CBC with PKCS#7 padding, CTR
 * with a counter that wraps within its low `length` bits (and fails when
 * the input needs more blocks than those bits can count), and GCM with a
 * 12 to 128 byte IV and a 4 to 16 byte tag appended to the ciphertext.
 * The unit links only into programs that call these methods, alongside
 * the cipher feature's mbedTLS archive. */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>

#include "mbedtls/aes.h"
#include "mbedtls/chachapoly.h"
#include "mbedtls/gcm.h"
#include "mbedtls/platform_util.h"

static ScrBytes *scr_wc_aes_gcm(bool decrypt, const unsigned char *key, size_t key_len,
                                const ScrWebCryptoAesParams *p, const unsigned char *in,
                                size_t len) {
  if (p->iv_len < 12 || p->iv_len > 128) return NULL;
  if (decrypt && len < p->tag_len) return NULL;
  size_t out_len = decrypt ? len - p->tag_len : len + p->tag_len;
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)out_len);
  mbedtls_gcm_context gcm;
  mbedtls_gcm_init(&gcm);
  int rc = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, key, (unsigned)(key_len * 8));
  if (rc == 0 && decrypt) {
    rc = mbedtls_gcm_auth_decrypt(&gcm, out_len, p->iv, p->iv_len, p->aad, p->aad_len,
                                  in + out_len, p->tag_len, in, out->data);
  } else if (rc == 0) {
    rc = mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT, len, p->iv, p->iv_len, p->aad,
                                   p->aad_len, in, out->data, p->tag_len, out->data + len);
  }
  mbedtls_gcm_free(&gcm);
  if (rc != 0) {
    mbedtls_platform_zeroize(out->data, out_len);
    scr_bytes_release(out);
    return NULL;
  }
  return out;
}

static ScrBytes *scr_wc_aes_cbc(bool decrypt, const unsigned char *key, size_t key_len,
                                const ScrWebCryptoAesParams *p, const unsigned char *in,
                                size_t len) {
  if (decrypt && (len == 0 || len % 16 != 0)) return NULL;
  size_t padded = decrypt ? len : (len / 16 + 1) * 16;
  unsigned char *buf = malloc(padded);
  if (!buf) scr_trap("scriptc: out of memory\n");
  memcpy(buf, in, len);
  if (!decrypt) memset(buf + len, (int)(padded - len), padded - len);
  unsigned char iv[16];
  memcpy(iv, p->iv, 16);
  mbedtls_aes_context aes;
  mbedtls_aes_init(&aes);
  int rc = decrypt ? mbedtls_aes_setkey_dec(&aes, key, (unsigned)(key_len * 8))
                   : mbedtls_aes_setkey_enc(&aes, key, (unsigned)(key_len * 8));
  if (rc == 0)
    rc = mbedtls_aes_crypt_cbc(&aes, decrypt ? MBEDTLS_AES_DECRYPT : MBEDTLS_AES_ENCRYPT, padded,
                               iv, buf, buf);
  mbedtls_aes_free(&aes);
  size_t out_len = padded;
  if (rc == 0 && decrypt) {
    /* PKCS#7: the final byte names 1 to 16 bytes of padding, each of
     * which holds that value. Checked without data-dependent branches. */
    unsigned char pad = buf[padded - 1];
    unsigned char diff = (unsigned char)-(pad == 0 || pad > 16);
    for (unsigned i = 1; i <= 16; i++)
      diff |= (unsigned char)((buf[padded - i] ^ pad) & (unsigned char)-(i <= pad));
    if (diff) rc = -1;
    else out_len = padded - pad;
  }
  ScrBytes *out = NULL;
  if (rc == 0) {
    out = scr_bytes_new(SCR_BYTES_U8, (double)out_len);
    memcpy(out->data, buf, out_len);
  }
  mbedtls_platform_zeroize(buf, padded);
  free(buf);
  return out;
}

/* Adds one to the low `bits` bits of a big-endian counter block, leaving
 * the bits above them unchanged. */
static void scr_wc_ctr_increment(unsigned char block[16], unsigned bits) {
  for (int i = 15; i >= 0 && bits > 0; i--) {
    unsigned width = bits >= 8 ? 8 : bits;
    unsigned mask = (1u << width) - 1;
    unsigned low = ((unsigned)block[i] + 1) & mask;
    block[i] = (unsigned char)((block[i] & ~mask) | low);
    bits -= width;
    if (low != 0) return;
  }
}

static ScrBytes *scr_wc_aes_ctr(const unsigned char *key, size_t key_len,
                                const ScrWebCryptoAesParams *p, const unsigned char *in,
                                size_t len) {
  size_t blocks = (len + 15) / 16;
  if (p->counter_bits < 64 && (double)blocks > (double)(1ull << p->counter_bits)) return NULL;
  mbedtls_aes_context aes;
  mbedtls_aes_init(&aes);
  if (mbedtls_aes_setkey_enc(&aes, key, (unsigned)(key_len * 8)) != 0) {
    mbedtls_aes_free(&aes);
    return NULL;
  }
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)len);
  unsigned char counter[16], stream[16];
  memcpy(counter, p->iv, 16);
  for (size_t off = 0; off < len; off += 16) {
    mbedtls_aes_crypt_ecb(&aes, MBEDTLS_AES_ENCRYPT, counter, stream);
    size_t n = len - off < 16 ? len - off : 16;
    for (size_t i = 0; i < n; i++) out->data[off + i] = (unsigned char)(in[off + i] ^ stream[i]);
    scr_wc_ctr_increment(counter, p->counter_bits);
  }
  mbedtls_platform_zeroize(stream, sizeof stream);
  mbedtls_aes_free(&aes);
  return out;
}

/* RFC 3394 AES key wrap with the default IV: wrapping takes a multiple of
 * 8 bytes, at least 16; unwrapping a multiple of 8, at least 24, and fails
 * when the integrity check value does not match (compared in constant
 * time). */
static ScrBytes *scr_wc_aes_kw(bool unwrap, const unsigned char *key, size_t key_len,
                               const unsigned char *in, size_t len) {
  static const unsigned char iv[8] = {0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6};
  if (len % 8 != 0 || len < (unwrap ? 24u : 16u)) return NULL;
  size_t n = unwrap ? len / 8 - 1 : len / 8;
  mbedtls_aes_context aes;
  mbedtls_aes_init(&aes);
  int rc = unwrap ? mbedtls_aes_setkey_dec(&aes, key, (unsigned)(key_len * 8))
                  : mbedtls_aes_setkey_enc(&aes, key, (unsigned)(key_len * 8));
  if (rc != 0) {
    mbedtls_aes_free(&aes);
    return NULL;
  }
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)(unwrap ? len - 8 : len + 8));
  unsigned char a[8], block[16];
  unsigned char *r = unwrap ? out->data : out->data + 8;
  if (unwrap) {
    memcpy(a, in, 8);
    memcpy(r, in + 8, len - 8);
    for (int j = 5; j >= 0; j--) {
      for (size_t i = n; i >= 1; i--) {
        uint64_t t = (uint64_t)n * (uint64_t)j + i;
        for (int k = 0; k < 8; k++) block[k] = (unsigned char)(a[k] ^ (t >> (56 - 8 * k)));
        memcpy(block + 8, r + 8 * (i - 1), 8);
        mbedtls_aes_crypt_ecb(&aes, MBEDTLS_AES_DECRYPT, block, block);
        memcpy(a, block, 8);
        memcpy(r + 8 * (i - 1), block + 8, 8);
      }
    }
  } else {
    memcpy(a, iv, 8);
    memcpy(r, in, len);
    for (int j = 0; j <= 5; j++) {
      for (size_t i = 1; i <= n; i++) {
        memcpy(block, a, 8);
        memcpy(block + 8, r + 8 * (i - 1), 8);
        mbedtls_aes_crypt_ecb(&aes, MBEDTLS_AES_ENCRYPT, block, block);
        uint64_t t = (uint64_t)n * (uint64_t)j + i;
        for (int k = 0; k < 8; k++) a[k] = (unsigned char)(block[k] ^ (t >> (56 - 8 * k)));
        memcpy(r + 8 * (i - 1), block + 8, 8);
      }
    }
    memcpy(out->data, a, 8);
  }
  mbedtls_platform_zeroize(block, sizeof block);
  mbedtls_aes_free(&aes);
  if (unwrap) {
    unsigned char diff = 0;
    for (int k = 0; k < 8; k++) diff |= (unsigned char)(a[k] ^ iv[k]);
    if (diff) {
      mbedtls_platform_zeroize(out->data, len - 8);
      scr_bytes_release(out);
      return NULL;
    }
  }
  return out;
}


/* ── AES-OCB (RFC 7253) and ChaCha20-Poly1305 ──────────────────────────
 * The two AEADs Node's WebCrypto also exposes: OCB over the mbedTLS AES
 * block cipher, with its nonce, associated data and 64-, 96- or 128-bit
 * tag, and ChaCha20-Poly1305 with mbedTLS's implementation. */

static void ocb_double(unsigned char b[16]) {
  int carry = b[0] >> 7;
  for (int i = 0; i < 15; i++) b[i] = (unsigned char)((b[i] << 1) | (b[i + 1] >> 7));
  b[15] = (unsigned char)(b[15] << 1);
  if (carry) b[15] ^= 0x87;
}

static void ocb_enc(mbedtls_aes_context *aes, const unsigned char in[16],
                    unsigned char out[16]) {
  mbedtls_aes_crypt_ecb(aes, MBEDTLS_AES_ENCRYPT, in, out);
}

/* 128 bits of the 192-bit stretch starting at bit `offset` (0-based). */
static void ocb_stretch_bits(const unsigned char stretch[24], unsigned offset,
                             unsigned char out[16]) {
  for (unsigned i = 0; i < 16; i++) {
    unsigned bit = offset + 8 * i;
    unsigned byte = bit / 8, shift = bit % 8;
    unsigned char hi = stretch[byte];
    unsigned char lo = byte + 1 < 24 ? stretch[byte + 1] : 0;
    out[i] = (unsigned char)(shift == 0 ? hi : (hi << shift) | (lo >> (8 - shift)));
  }
}

/* OCB's HASH over the associated data. */
static void ocb_hash(mbedtls_aes_context *aes, const unsigned char l_star[16],
                     const unsigned char l_dollar[16], const unsigned char *a, size_t alen,
                     unsigned char sum[16]) {
  unsigned char l[64][16];
  memcpy(l[0], l_dollar, 16);
  ocb_double(l[0]);
  for (int i = 1; i < 64; i++) {
    memcpy(l[i], l[i - 1], 16);
    ocb_double(l[i]);
  }
  memset(sum, 0, 16);
  unsigned char offset[16] = {0};
  size_t m = alen / 16;
  for (size_t i = 1; i <= m; i++) {
    unsigned ntz = 0;
    while (((i >> ntz) & 1) == 0) ntz++;
    for (int j = 0; j < 16; j++) offset[j] ^= l[ntz][j];
    unsigned char block[16], enc[16];
    for (int j = 0; j < 16; j++) block[j] = a[(i - 1) * 16 + j] ^ offset[j];
    ocb_enc(aes, block, enc);
    for (int j = 0; j < 16; j++) sum[j] ^= enc[j];
  }
  size_t rest = alen % 16;
  if (rest) {
    for (int j = 0; j < 16; j++) offset[j] ^= l_star[j];
    unsigned char block[16] = {0}, enc[16];
    memcpy(block, a + m * 16, rest);
    block[rest] = 0x80;
    for (int j = 0; j < 16; j++) block[j] ^= offset[j];
    ocb_enc(aes, block, enc);
    for (int j = 0; j < 16; j++) sum[j] ^= enc[j];
  }
}

static ScrBytes *scr_wc_aes_ocb(bool decrypt, const unsigned char *key, size_t key_len,
                                const ScrWebCryptoAesParams *p, const unsigned char *in,
                                size_t len) {
  mbedtls_aes_context aes, dec;
  mbedtls_aes_init(&aes);
  mbedtls_aes_init(&dec);
  ScrBytes *out = NULL;
  unsigned char l_star[16] = {0}, l_dollar[16], l[64][16];
  unsigned char nonce[16], ktop[16], stretch[24], offset[16], tag[16], sum[16];
  size_t tag_len = p->tag_len;
  if (p->iv_len < 1 || p->iv_len > 15 || (tag_len != 8 && tag_len != 12 && tag_len != 16) ||
      (decrypt && len < tag_len))
    goto done;
  if (mbedtls_aes_setkey_enc(&aes, key, (unsigned)(key_len * 8)) != 0) goto done;
  /* OCB decrypts a whole block with the inverse cipher, which needs its own
   * (decryption) key schedule. */
  if (decrypt && mbedtls_aes_setkey_dec(&dec, key, (unsigned)(key_len * 8)) != 0) goto done;
  ocb_enc(&aes, l_star, l_star);
  memcpy(l_dollar, l_star, 16);
  ocb_double(l_dollar);
  memcpy(l[0], l_dollar, 16);
  ocb_double(l[0]);
  for (int i = 1; i < 64; i++) {
    memcpy(l[i], l[i - 1], 16);
    ocb_double(l[i]);
  }
  /* Nonce = num2str(TAGLEN mod 128, 7) || zeros(120 - bitlen(N)) || 1 || N. */
  memset(nonce, 0, 16);
  nonce[0] = (unsigned char)(((tag_len * 8) % 128) << 1);
  nonce[15 - p->iv_len] |= 0x01;
  memcpy(nonce + 16 - p->iv_len, p->iv, p->iv_len);
  unsigned bottom = nonce[15] & 0x3f;
  unsigned char ktop_input[16];
  memcpy(ktop_input, nonce, 16);
  ktop_input[15] &= 0xc0;
  ocb_enc(&aes, ktop_input, ktop);
  memcpy(stretch, ktop, 16);
  for (int i = 0; i < 8; i++) stretch[16 + i] = (unsigned char)(ktop[i] ^ ktop[i + 1]);
  ocb_stretch_bits(stretch, bottom, offset);
  ocb_hash(&aes, l_star, l_dollar, p->aad, p->aad_len, sum);

  size_t body = decrypt ? len - tag_len : len;
  size_t m = body / 16, rest = body % 16;
  size_t out_len = decrypt ? body : body + tag_len;
  out = scr_bytes_new(SCR_BYTES_U8, (double)out_len);
  unsigned char checksum[16] = {0};
  unsigned char off[16];
  memcpy(off, offset, 16);
  for (size_t i = 1; i <= m; i++) {
    unsigned ntz = 0;
    while (((i >> ntz) & 1) == 0) ntz++;
    for (int j = 0; j < 16; j++) off[j] ^= l[ntz][j];
    unsigned char block[16], enc[16];
    if (decrypt) {
      for (int j = 0; j < 16; j++) block[j] = in[(i - 1) * 16 + j] ^ off[j];
      mbedtls_aes_crypt_ecb(&dec, MBEDTLS_AES_DECRYPT, block, enc);
      for (int j = 0; j < 16; j++) out->data[(i - 1) * 16 + j] = enc[j] ^ off[j];
      for (int j = 0; j < 16; j++) checksum[j] ^= out->data[(i - 1) * 16 + j];
    } else {
      for (int j = 0; j < 16; j++) block[j] = in[(i - 1) * 16 + j] ^ off[j];
      ocb_enc(&aes, block, enc);
      for (int j = 0; j < 16; j++) out->data[(i - 1) * 16 + j] = enc[j] ^ off[j];
      for (int j = 0; j < 16; j++) checksum[j] ^= in[(i - 1) * 16 + j];
    }
  }
  if (rest) {
    for (int j = 0; j < 16; j++) off[j] ^= l_star[j];
    unsigned char pad[16];
    ocb_enc(&aes, off, pad);
    for (size_t j = 0; j < rest; j++) {
      if (decrypt) {
        out->data[m * 16 + j] = (unsigned char)(in[m * 16 + j] ^ pad[j]);
        checksum[j] ^= out->data[m * 16 + j];
      } else {
        out->data[m * 16 + j] = (unsigned char)(in[m * 16 + j] ^ pad[j]);
        checksum[j] ^= in[m * 16 + j];
      }
    }
    checksum[rest] ^= 0x80;
  }
  unsigned char tag_input[16];
  for (int j = 0; j < 16; j++) tag_input[j] = (unsigned char)(checksum[j] ^ off[j] ^ l_dollar[j]);
  ocb_enc(&aes, tag_input, tag);
  for (int j = 0; j < 16; j++) tag[j] ^= sum[j];
  if (decrypt) {
    unsigned char diff = 0;
    for (size_t j = 0; j < tag_len; j++) diff |= (unsigned char)(tag[j] ^ in[body + j]);
    if (diff) {
      scr_bytes_release(out);
      out = NULL;
    }
  } else {
    memcpy(out->data + body, tag, tag_len);
  }
done:
  mbedtls_aes_free(&aes);
  mbedtls_aes_free(&dec);
  return out;
}

static ScrBytes *scr_wc_chacha_poly(bool decrypt, const unsigned char *key, size_t key_len,
                                    const ScrWebCryptoAesParams *p, const unsigned char *in,
                                    size_t len) {
  if (key_len != 32 || p->iv_len != 12 || p->tag_len != 16 || (decrypt && len < 16)) return NULL;
  size_t body = decrypt ? len - 16 : len;
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)body);
  mbedtls_chachapoly_context ctx;
  mbedtls_chachapoly_init(&ctx);
  int rc = mbedtls_chachapoly_setkey(&ctx, key);
  if (rc == 0 && decrypt) {
    rc = mbedtls_chachapoly_auth_decrypt(&ctx, body, p->iv, p->aad, p->aad_len, in + body, in,
                                         out->data);
  } else if (rc == 0) {
    unsigned char tag[16];
    rc = mbedtls_chachapoly_encrypt_and_tag(&ctx, body, p->iv, p->aad, p->aad_len, in, out->data,
                                            tag);
    if (rc == 0) {
      ScrBytes *full = scr_bytes_new(SCR_BYTES_U8, (double)(body + 16));
      memcpy(full->data, out->data, body);
      memcpy(full->data + body, tag, 16);
      scr_bytes_release(out);
      out = full;
    }
  }
  mbedtls_chachapoly_free(&ctx);
  if (rc != 0) {
    scr_bytes_release(out);
    return NULL;
  }
  return out;
}

/* The cipher scr_webcrypto_cipher runs: +1 output bytes, or NULL when the
 * operation fails (Node's OperationError). */
static ScrBytes *scr_wc_aes(const char *name, bool decrypt, const unsigned char *key,
                            size_t key_len, const ScrWebCryptoAesParams *p,
                            const unsigned char *in, size_t len) {
  if (strcmp(name, "AES-KW") == 0) return scr_wc_aes_kw(decrypt, key, key_len, in, len);
  if (strcmp(name, "AES-OCB") == 0) return scr_wc_aes_ocb(decrypt, key, key_len, p, in, len);
  if (strcmp(name, "ChaCha20-Poly1305") == 0)
    return scr_wc_chacha_poly(decrypt, key, key_len, p, in, len);
  if (strcmp(name, "AES-GCM") == 0) return scr_wc_aes_gcm(decrypt, key, key_len, p, in, len);
  if (strcmp(name, "AES-CBC") == 0) return scr_wc_aes_cbc(decrypt, key, key_len, p, in, len);
  return scr_wc_aes_ctr(key, key_len, p, in, len);
}

ScrPromise *scr_webcrypto_encrypt(ScrDyn *args) { return scr_webcrypto_cipher(args, false, scr_wc_aes); }

ScrPromise *scr_webcrypto_decrypt(ScrDyn *args) { return scr_webcrypto_cipher(args, true, scr_wc_aes); }

ScrPromise *scr_webcrypto_wrap_key(ScrDyn *args) { return scr_webcrypto_wrap(args, scr_wc_aes); }

ScrPromise *scr_webcrypto_unwrap_key(ScrDyn *args) { return scr_webcrypto_unwrap(args, scr_wc_aes); }
