/* SHA-1, SHA-256, SHA-384 and SHA-512 block kernels (scr_lib.c), built by
 * sha-kernels.test.ts. The unit is included directly so the test can run
 * each kernel the CPU supports and the portable blocks over the same
 * inputs: known vectors, every length from 0 to 1100 bytes, and 1 MiB,
 * each fed whole and in 1-, 7-, 64- and 100-byte updates. The SHA-1 and
 * SHA-256 kernels use the SHA extensions; the SHA-512 kernels use AVX2 or
 * AVX-512VL on x86-64 and the SHA-512 extension on arm64. On CPUs without
 * them only the portable blocks run. */
#include "../src/scr_lib.c"

#include <stdio.h>
#include <string.h>

static long total = 0, failed = 0;

static void check(bool ok, const char *what, size_t len, size_t chunk) {
  total++;
  if (!ok) {
    failed++;
    fprintf(stderr, "FAIL: %s length %zu chunk %zu\n", what, len, chunk);
  }
}

static void hex(const unsigned char *d, size_t n, char *out) {
  for (size_t i = 0; i < n; i++) sprintf(out + 2 * i, "%02x", d[i]);
}

static void sha256_of(const unsigned char *data, size_t len, size_t chunk, unsigned char out[32]) {
  ScrSha256Ctx ctx;
  scr_sha256_init(&ctx);
  for (size_t at = 0; at < len;) {
    size_t take = chunk == 0 || chunk > len - at ? len - at : chunk;
    scr_sha256_update(&ctx, data + at, take);
    at += take;
  }
  scr_sha256_final(&ctx, out);
}

static void sha1_of(const unsigned char *data, size_t len, size_t chunk, unsigned char out[32]) {
  ScrSha1Ctx ctx;
  scr_sha1_init(&ctx);
  for (size_t at = 0; at < len;) {
    size_t take = chunk == 0 || chunk > len - at ? len - at : chunk;
    scr_sha1_update(&ctx, data + at, take);
    at += take;
  }
  scr_sha1_final(&ctx, out);
}

static void sha512_of(const unsigned char *data, size_t len, size_t chunk, bool sha384,
                      unsigned char out[64]) {
  ScrSha512Ctx ctx;
  scr_sha512_init(&ctx, sha384);
  for (size_t at = 0; at < len;) {
    size_t take = chunk == 0 || chunk > len - at ? len - at : chunk;
    scr_sha512_update(&ctx, data + at, take);
    at += take;
  }
  scr_sha512_final(&ctx, out, sha384);
}

/* FIPS 180-4 example vectors for SHA-384 and SHA-512. */
static void vectors512(const char *path) {
  unsigned char d[64];
  char text[129];
  static const char two_block[] =
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu";
  sha512_of((const unsigned char *)"abc", 3, 0, false, d);
  hex(d, 64, text);
  check(strcmp(text, "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f") == 0, path, 3, 0);
  sha512_of((const unsigned char *)"", 0, 0, false, d);
  hex(d, 64, text);
  check(strcmp(text, "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e") == 0, path, 0, 0);
  sha512_of((const unsigned char *)two_block, sizeof two_block - 1, 0, false, d);
  hex(d, 64, text);
  check(strcmp(text, "8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909") == 0, path, sizeof two_block - 1, 0);
  sha512_of((const unsigned char *)"abc", 3, 0, true, d);
  hex(d, 48, text);
  check(strcmp(text, "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7") == 0, path, 3, 0);
  sha512_of((const unsigned char *)two_block, sizeof two_block - 1, 0, true, d);
  hex(d, 48, text);
  check(strcmp(text, "09330c33f71147e83d192fc782cd1b4753111b173b3b05d22fa08086e3b0f712fcc7c71a557e2db966c3e9fa91746039") == 0, path, sizeof two_block - 1, 0);
  static unsigned char million[1000000];
  memset(million, 'a', sizeof million);
  sha512_of(million, sizeof million, 0, false, d);
  hex(d, 64, text);
  check(strcmp(text, "e718483d0ce769644e2e42c7bc15b4638e1f98b13b2044285632a803afa973ebde0ff244877ea60a4cb0432ce577c31beb009c5c2c49aa2e4eadb217ad8cc09b") == 0, path, sizeof million, 0);
  sha512_of(million, sizeof million, 0, true, d);
  hex(d, 48, text);
  check(strcmp(text, "9d0e1809716474cb086e834e310a4a1ced149e9c00f248527972cec5704c2a5b07b8b3dc38ecc4ebae97ddd87f3d8985") == 0, path, sizeof million, 0);
}

/* Selects the SHA-512 kernel: 0 the portable blocks, otherwise the CPU's
 * kernel. Returns false when the CPU has none. */
static bool select512(int kernel) {
#ifdef SCR_SHA_NI
  scr_sha512_x86_state = 0;
  int best = scr_sha512_x86();
  if (kernel > best - 1) return false;
  scr_sha512_x86_state = kernel == 0 ? 1 : kernel + 1;
  return true;
#elif defined(SCR_SHA512_ARM)
  scr_sha512_arm_state = 0;
  bool available = scr_sha512_arm();
  if (kernel > (available ? 1 : 0)) return false;
  scr_sha512_arm_state = kernel == 0 ? 2 : 1;
  return true;
#else
  return kernel == 0;
#endif
}

static const char *const kernel512_names[] = {"portable", "avx2-or-arm", "avx512"};

static void vectors(const char *path) {
  unsigned char d[32];
  char text[65];
  sha256_of((const unsigned char *)"abc", 3, 0, d);
  hex(d, 32, text);
  check(strcmp(text, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") == 0, path, 3, 0);
  sha256_of((const unsigned char *)"", 0, 0, d);
  hex(d, 32, text);
  check(strcmp(text, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") == 0, path, 0, 0);
  sha1_of((const unsigned char *)"abc", 3, 0, d);
  hex(d, 20, text);
  check(strcmp(text, "a9993e364706816aba3e25717850c26c9cd0d89d") == 0, path, 3, 0);
  static unsigned char million[1000000];
  memset(million, 'a', sizeof million);
  sha256_of(million, sizeof million, 0, d);
  hex(d, 32, text);
  check(strcmp(text, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0") == 0, path, sizeof million, 0);
  sha1_of(million, sizeof million, 0, d);
  hex(d, 20, text);
  check(strcmp(text, "34aa973cd4c4daa4f61eeb2bdbad27316534016f") == 0, path, sizeof million, 0);
}

int main(void) {
  enum { BIG = 1 << 20 };
  unsigned char *data = malloc(BIG);
  uint32_t x = 0x9e3779b9u;
  for (size_t i = 0; i < BIG; i++) {
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    data[i] = (unsigned char)x;
  }
  static const size_t chunks[] = {0, 1, 7, 64, 100};
  bool ni = false;
#ifdef SCR_SHA_NI
  ni = scr_sha_ni();
#endif
  vectors("portable-or-ni");
  for (size_t len = 0; len <= 1100 + 1; len++) {
    size_t n = len == 1101 ? BIG : len;
    for (size_t c = 0; c < sizeof chunks / sizeof chunks[0]; c++) {
#ifdef SCR_SHA_NI
      if (!ni) continue;
      unsigned char a[32], b[32];
      scr_sha_ni_state = 1;
      sha256_of(data, n, chunks[c], a);
      scr_sha_ni_state = 2;
      sha256_of(data, n, chunks[c], b);
      check(memcmp(a, b, 32) == 0, "sha256 ni vs portable", n, chunks[c]);
      scr_sha_ni_state = 1;
      sha1_of(data, n, chunks[c], a);
      scr_sha_ni_state = 2;
      sha1_of(data, n, chunks[c], b);
      check(memcmp(a, b, 20) == 0, "sha1 ni vs portable", n, chunks[c]);
#endif
    }
  }
#ifdef SCR_SHA_NI
  if (ni) {
    scr_sha_ni_state = 2;
    vectors("portable");
    scr_sha_ni_state = 1;
    vectors("ni");
  }
#endif
  /* SHA-512 and SHA-384: every kernel against the portable blocks, and
   * the known vectors through each. */
  int kernels512 = 0;
  for (int k = 0; k < 3 && select512(k); k++) {
    kernels512 = k + 1;
    vectors512(kernel512_names[k]);
  }
  for (int k = 1; k < kernels512; k++) {
    for (size_t len = 0; len <= 1100 + 1; len++) {
      size_t n = len == 1101 ? BIG : len;
      for (size_t c = 0; c < sizeof chunks / sizeof chunks[0]; c++) {
        for (int sha384 = 0; sha384 < 2; sha384++) {
          unsigned char a[64], b[64];
          select512(k);
          sha512_of(data, n, chunks[c], sha384, a);
          select512(0);
          sha512_of(data, n, chunks[c], sha384, b);
          check(memcmp(a, b, sha384 ? 48 : 64) == 0, kernel512_names[k], n, chunks[c]);
        }
      }
    }
  }
  free(data);
  fprintf(stderr, "sha-ni %s\n", ni ? "available" : "absent");
  fprintf(stderr, "sha-512 kernels %d\n", kernels512);
  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed != 0;
}
