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

/* The cipher scr_webcrypto_cipher runs: +1 output bytes, or NULL when the
 * operation fails (Node's OperationError). */
static ScrBytes *scr_wc_aes(const char *name, bool decrypt, const unsigned char *key,
                            size_t key_len, const ScrWebCryptoAesParams *p,
                            const unsigned char *in, size_t len) {
  if (strcmp(name, "AES-KW") == 0) return scr_wc_aes_kw(decrypt, key, key_len, in, len);
  if (strcmp(name, "AES-GCM") == 0) return scr_wc_aes_gcm(decrypt, key, key_len, p, in, len);
  if (strcmp(name, "AES-CBC") == 0) return scr_wc_aes_cbc(decrypt, key, key_len, p, in, len);
  return scr_wc_aes_ctr(key, key_len, p, in, len);
}

ScrPromise *scr_webcrypto_encrypt(ScrDyn *args) { return scr_webcrypto_cipher(args, false, scr_wc_aes); }

ScrPromise *scr_webcrypto_decrypt(ScrDyn *args) { return scr_webcrypto_cipher(args, true, scr_wc_aes); }

ScrPromise *scr_webcrypto_wrap_key(ScrDyn *args) { return scr_webcrypto_wrap(args, scr_wc_aes); }

ScrPromise *scr_webcrypto_unwrap_key(ScrDyn *args) { return scr_webcrypto_unwrap(args, scr_wc_aes); }
