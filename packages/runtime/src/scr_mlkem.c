/* ML-KEM (FIPS 203) on the vendored mlkem-native core (mlkem/), whose C
 * backend the compiler builds once per parameter set in the mlkem vendor
 * archive. This unit maps the runtime's level argument to those symbols,
 * supplies the random-byte hook the randomized entry points reference, and
 * installs the core the pki unit reaches ML-KEM keys through, so a program
 * that never names an ML-KEM algorithm links neither this unit nor the
 * archive. */
#include "scr_runtime.h"
#include "scr_pki.h"

/* The vendored API, namespaced per parameter set (numeric level). */
#define SCR_MLKEM_DECL(level)                                                                     \
  int PQCP_MLKEM_NATIVE_MLKEM##level##_keypair_derand(uint8_t *pk, uint8_t *sk,                  \
                                                      const uint8_t coins[64]);                   \
  int PQCP_MLKEM_NATIVE_MLKEM##level##_enc_derand(uint8_t *ct, uint8_t *ss, const uint8_t *pk,    \
                                                  const uint8_t coins[32]);                       \
  int PQCP_MLKEM_NATIVE_MLKEM##level##_dec(uint8_t *ss, const uint8_t *ct, const uint8_t *sk)
SCR_MLKEM_DECL(512);
SCR_MLKEM_DECL(768);
SCR_MLKEM_DECL(1024);

/* mlkem_native.c's randomized entry points reference this hook; the runtime
 * draws from its cryptographically secure source. */
int randombytes(uint8_t *out, size_t outlen) {
  ScrBytes *bytes = scr_crypto_random_bytes((double)outlen);
  if (!bytes) return -1;
  if (outlen != 0) memcpy(out, bytes->data, outlen);
  scr_bytes_release(bytes);
  return 0;
}

static bool scr_mlkem_keypair_derand(int level, uint8_t *pk, uint8_t *sk, const uint8_t seed[64]) {
  if (level == 512) return PQCP_MLKEM_NATIVE_MLKEM512_keypair_derand(pk, sk, seed) == 0;
  if (level == 768) return PQCP_MLKEM_NATIVE_MLKEM768_keypair_derand(pk, sk, seed) == 0;
  return PQCP_MLKEM_NATIVE_MLKEM1024_keypair_derand(pk, sk, seed) == 0;
}

static bool scr_mlkem_encapsulate(int level, uint8_t *ct, uint8_t shared[32], const uint8_t *pk,
                                  const uint8_t seed[32]) {
  if (level == 512) return PQCP_MLKEM_NATIVE_MLKEM512_enc_derand(ct, shared, pk, seed) == 0;
  if (level == 768) return PQCP_MLKEM_NATIVE_MLKEM768_enc_derand(ct, shared, pk, seed) == 0;
  return PQCP_MLKEM_NATIVE_MLKEM1024_enc_derand(ct, shared, pk, seed) == 0;
}

static bool scr_mlkem_decapsulate(int level, uint8_t shared[32], const uint8_t *ct,
                                  const uint8_t *sk) {
  if (level == 512) return PQCP_MLKEM_NATIVE_MLKEM512_dec(shared, ct, sk) == 0;
  if (level == 768) return PQCP_MLKEM_NATIVE_MLKEM768_dec(shared, ct, sk) == 0;
  return PQCP_MLKEM_NATIVE_MLKEM1024_dec(shared, ct, sk) == 0;
}

static const ScrPkiMlkemCore scr_mlkem_core = {
    .keypair_derand = scr_mlkem_keypair_derand,
    .encapsulate = scr_mlkem_encapsulate,
    .decapsulate = scr_mlkem_decapsulate,
};

__attribute__((constructor)) static void scr_mlkem_install(void) {
  scr_pki_mlkem_core = &scr_mlkem_core;
}
