/* The PKCS#1 v1.5 private decryption of crypto.privateDecrypt over "rsa"
 * keys. A block whose type 2 padding does not check out answers a synthetic
 * message, and the keyed work a decryption does (the rejection key
 * derivation and the stream the synthetic message and its length come
 * from) is the same whether the padding checked out or not: a decryption
 * that did that work only for a rejected ciphertext would take a different
 * time for the two, which is the padding oracle the scheme removes. */
#undef NDEBUG
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "mbedtls/ctr_drbg.h"
#include "mbedtls/entropy.h"
#include "mbedtls/md.h"
#include "mbedtls/rsa.h"

/* Counts the HMACs the decryption finishes. The mbedTLS declarations above
 * are already read, so the macro renames scr_pki.c's calls and leaves the
 * library's own out. */
static unsigned hmac_finishes;
static int test_hmac_finish(mbedtls_md_context_t *ctx, unsigned char *out) {
  hmac_finishes++;
  return mbedtls_md_hmac_finish(ctx, out);
}
#define mbedtls_md_hmac_finish test_hmac_finish
#include "../src/scr_pki.c"
#undef mbedtls_md_hmac_finish

static ScrBytes *bytes_of(const unsigned char *data, size_t len) {
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)len);
  if (len) memcpy(b->data, data, len);
  return b;
}

/* Decrypts the block `block` (the plaintext of the ciphertext `cipher`),
 * counting the HMACs the decryption finishes. */
static ScrDyn *decrypt(mbedtls_rsa_context *rsa, const unsigned char *block, const unsigned char *cipher, size_t k,
                       unsigned *finishes) {
  ScrBytes *ct = bytes_of(cipher, k);
  hmac_finishes = 0;
  ScrDyn *out = sp_pkcs1_decrypt(rsa, block, k, ct);
  *finishes = hmac_finishes;
  scr_bytes_release(ct);
  return out;
}

int main(void) {
  mbedtls_entropy_context entropy;
  mbedtls_ctr_drbg_context drbg;
  mbedtls_rsa_context rsa;
  mbedtls_entropy_init(&entropy);
  mbedtls_ctr_drbg_init(&drbg);
  mbedtls_rsa_init(&rsa);
  static const char seed[] = "scriptc pkcs1 test";
  assert(mbedtls_ctr_drbg_seed(&drbg, mbedtls_entropy_func, &entropy, (const unsigned char *)seed,
                               sizeof seed - 1) == 0);
  assert(mbedtls_rsa_gen_key(&rsa, mbedtls_ctr_drbg_random, &drbg, 1024, 65537) == 0);
  size_t k = mbedtls_rsa_get_len(&rsa);
  assert(k >= 16 && k <= MBEDTLS_MPI_MAX_SIZE);

  static const char message[] = "the padding is no oracle";
  size_t msglen = sizeof message - 1;
  assert(msglen + 11 <= k);

  unsigned char *valid = calloc(1, k), *invalid = calloc(1, k);
  unsigned char *ct_valid = malloc(k), *ct_invalid = malloc(k);
  assert(valid && invalid && ct_valid && ct_invalid);
  /* 00 || 02 || PS || 00 || message, with PS one byte longer than the
     eight the check asks for. */
  valid[1] = 0x02;
  memset(valid + 2, 0x41, k - msglen - 3);
  valid[k - msglen - 1] = 0x00;
  memcpy(valid + k - msglen, message, msglen);
  assert(mbedtls_rsa_public(&rsa, valid, ct_valid) == 0);
  /* The same block with a zero byte inside PS, so the first separator
     comes too early. */
  memcpy(invalid, valid, k);
  invalid[5] = 0x00;
  assert(mbedtls_rsa_public(&rsa, invalid, ct_invalid) == 0);

  unsigned valid_finishes = 0, invalid_finishes = 0, repeat_finishes = 0;
  ScrDyn *accepted = decrypt(&rsa, valid, ct_valid, k, &valid_finishes);
  ScrDyn *rejected = decrypt(&rsa, invalid, ct_invalid, k, &invalid_finishes);
  ScrDyn *rejected_again = decrypt(&rsa, invalid, ct_invalid, k, &repeat_finishes);

  /* The accepted block answers the message ... */
  assert(accepted->kind == SCR_DYN_BYTES);
  assert(accepted->v.bytes->len == msglen);
  assert(memcmp(accepted->v.bytes->data, message, msglen) == 0);

  /* ... and the rejected one a message of its own, the same every time,
     which the check never saw. */
  assert(rejected->kind == SCR_DYN_BYTES);
  assert(rejected->v.bytes->len <= k - 11);
  assert(rejected_again->kind == SCR_DYN_BYTES);
  assert(rejected_again->v.bytes->len == rejected->v.bytes->len);
  assert(memcmp(rejected_again->v.bytes->data, rejected->v.bytes->data, rejected->v.bytes->len) == 0);
  assert(rejected->v.bytes->len != msglen ||
         memcmp(rejected->v.bytes->data, message, msglen) != 0);

  /* The work the implicit rejection exists to hide: a decryption of a
     well-padded ciphertext finishes the same HMACs as one of a rejected
     ciphertext, since the synthetic message and its length are generated
     either way. */
  assert(valid_finishes == invalid_finishes);
  assert(valid_finishes == repeat_finishes);
  assert(valid_finishes > 0);

  /* An empty message is the separator in the block's last byte. */
  memcpy(valid, invalid, k);
  valid[1] = 0x02;
  memset(valid + 2, 0x41, k - 3);
  valid[k - 1] = 0x00;
  assert(mbedtls_rsa_public(&rsa, valid, ct_valid) == 0);
  ScrDyn *empty = decrypt(&rsa, valid, ct_valid, k, &valid_finishes);
  assert(empty->kind == SCR_DYN_BYTES && empty->v.bytes->len == 0);
  assert(valid_finishes == invalid_finishes);

  scr_dyn_release(accepted);
  scr_dyn_release(rejected);
  scr_dyn_release(rejected_again);
  scr_dyn_release(empty);
  free(valid);
  free(invalid);
  free(ct_valid);
  free(ct_invalid);
  mbedtls_rsa_free(&rsa);
  mbedtls_ctr_drbg_free(&drbg);
  mbedtls_entropy_free(&entropy);
  puts("pkcs1 implicit rejection");
  return 0;
}
