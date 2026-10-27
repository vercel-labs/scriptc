/* Ed25519 for scr_pki.c: libsodium's ref10 implementation (vendored, see
 * ../vendor/README.md), textually included so it builds as this one unit.
 * It links only into programs that name Ed25519 (the ed25519 runtime
 * feature) and installs itself into scr_pki.c at startup; without it,
 * Ed25519 signing, verification and public-key derivation throw a coded
 * SC2020 error.
 *
 * Signing runs in constant time. Verification rejects a non-canonical S
 * and the small-order R and public-key encodings, then checks the
 * cofactorless equation, which is what Node 24 answers. */
#include "scr_runtime.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "scr_pki.h"

#define CONFIGURED 1
#include "../vendor/libsodium/ed25519_ref10.c"
#include "../vendor/libsodium/hash_sha512_cp.c"
#include "../vendor/libsodium/verify.c"
#include "../vendor/libsodium/sign.c"
#include "../vendor/libsodium/open.c"
#include "../vendor/libsodium/keypair.c"
#undef CONFIGURED

/* The libsodium utilities those units call. */
void sodium_memzero(void *const pnt, const size_t len) {
  volatile unsigned char *p = (volatile unsigned char *)pnt;
  for (size_t i = 0; i < len; i++) p[i] = 0U;
}

int sodium_memcmp(const void *const b1_, const void *const b2_, size_t len) {
  const volatile unsigned char *b1 = (const volatile unsigned char *)b1_;
  const volatile unsigned char *b2 = (const volatile unsigned char *)b2_;
  volatile unsigned char d = 0U;
  for (size_t i = 0; i < len; i++) d |= b1[i] ^ b2[i];
  return (1 & ((d - 1) >> 8)) - 1;
}

int sodium_is_zero(const unsigned char *n, const size_t nlen) {
  volatile unsigned char d = 0U;
  for (size_t i = 0; i < nlen; i++) d |= n[i];
  return 1 & ((d - 1) >> 8);
}

void randombytes_buf(void *const buf, const size_t size) { arc4random_buf(buf, size); }

static void se_public_key(uint8_t pub[32], const uint8_t seed[32]) {
  uint8_t sk[64];
  crypto_sign_ed25519_seed_keypair(pub, sk, seed);
  sodium_memzero(sk, sizeof sk);
}

static void se_sign(uint8_t sig[64], const uint8_t seed[32], const uint8_t pub[32], const uint8_t *m,
                    size_t n) {
  uint8_t sk[64];
  memcpy(sk, seed, 32);
  memcpy(sk + 32, pub, 32);
  crypto_sign_ed25519_detached(sig, NULL, m, n, sk);
  sodium_memzero(sk, sizeof sk);
}

static bool se_verify(const uint8_t pub[32], const uint8_t *m, size_t n, const uint8_t sig[64]) {
  return crypto_sign_ed25519_verify_detached(sig, m, n, pub) == 0;
}

static const ScrPkiEd25519 se_table = {
    .public_key = se_public_key,
    .sign = se_sign,
    .verify = se_verify,
};

__attribute__((constructor)) static void se_install(void) { scr_pki_ed25519 = &se_table; }
