/* Unit tests for the DiffieHellman runtime's arithmetic (scr_dh.c), built
 * with ASan and UBSan by dh.test.ts. The unit is included directly so the
 * tests can compare the Montgomery exponentiation the primality tests use
 * with mbedTLS's, run the primality test on primes, Carmichael numbers and
 * strong pseudoprimes to small bases, split exponents past mbedTLS's limit,
 * and check generated safe primes and DH_check results. */
#include "../src/scr_dh.c"

#include <stdio.h>
#include <string.h>

static long total = 0, failed = 0;

static void check(bool ok, const char *what) {
  total++;
  if (!ok) {
    failed++;
    fprintf(stderr, "FAIL: %s\n", what);
  }
}

static void from_hex(mbedtls_mpi *x, const char *hex) {
  if (mbedtls_mpi_read_string(x, 16, hex) != 0) scr_trap("bad hex\n");
}

/* The Montgomery exponentiation, with the base 2 and with general bases,
 * against mbedtls_mpi_exp_mod for moduli of one to 64 limbs. */
static void test_mont_pow(void) {
#if SD_MONT
  static const size_t sizes[] = {3, 64, 65, 127, 128, 129, 512, 1000, 2048, 4096};
  mbedtls_mpi n, base, e, two, got, want;
  mbedtls_mpi_init(&n);
  mbedtls_mpi_init(&base);
  mbedtls_mpi_init(&e);
  mbedtls_mpi_init(&two);
  mbedtls_mpi_init(&got);
  mbedtls_mpi_init(&want);
  mbedtls_mpi_lset(&two, 2);
  for (size_t s = 0; s < sizeof sizes / sizeof sizes[0]; s++) {
    for (int trial = 0; trial < 6; trial++) {
      size_t bits = sizes[s];
      sd_random_bits(&n, bits, true);
      if (mbedtls_mpi_cmp_int(&n, 3) <= 0) mbedtls_mpi_lset(&n, 7);
      sd_random_bits(&base, bits > 2 ? bits - 1 : 1, false);
      size_t ebits = trial == 0 ? 1 : trial == 1 ? bits + 70 : (bits * (size_t)trial) / 5 + 1;
      sd_random_bits(&e, ebits, false);
      if (trial == 0) mbedtls_mpi_lset(&e, 0);
      ScDhMont m;
      bool ready = sd_mont_init(&m, &n);
      check(ready, "sd_mont_init");
      char what[96];
      snprintf(what, sizeof what, "base^e mod n for %zu bits, trial %d", bits, trial);
      bool ok = ready && sd_mont_pow(&m, &got, &base, &e) && mbedtls_mpi_exp_mod(&want, &base, &e, &n, NULL) == 0;
      check(ok && mbedtls_mpi_cmp_mpi(&got, &want) == 0, what);
      snprintf(what, sizeof what, "2^e mod n for %zu bits, trial %d", bits, trial);
      ok = ready && sd_mont_pow(&m, &got, NULL, &e) && mbedtls_mpi_exp_mod(&want, &two, &e, &n, NULL) == 0;
      check(ok && mbedtls_mpi_cmp_mpi(&got, &want) == 0, what);
      sd_mont_free(&m);
    }
  }
  mbedtls_mpi_free(&n);
  mbedtls_mpi_free(&base);
  mbedtls_mpi_free(&e);
  mbedtls_mpi_free(&two);
  mbedtls_mpi_free(&got);
  mbedtls_mpi_free(&want);
#endif
}

/* BN_check_prime's answers for small values, Mersenne numbers, Carmichael
 * numbers and strong pseudoprimes to small prime bases. */
static void test_is_prime(void) {
  static const struct {
    const char *hex;
    bool prime;
  } cases[] = {
    {"0", false},
    {"1", false},
    {"2", true},
    {"3", true},
    {"4", false},
    {"5", true},
    {"9", false},
    {"231", false},                              /* 561, a Carmichael number */
    {"451", false},                              /* 1105, a Carmichael number */
    {"7ff", false},                              /* 2047, a strong pseudoprime to the base 2 */
    {"45c5", false},                             /* 17861 = 53 · 337 */
    {"45c7", true},                              /* 17863, the largest trial-division prime */
    {"bfa17dc7", false},                         /* 3215031751, to the bases 2, 3, 5 and 7 */
    {"351591274f9af9fb", false},                 /* 3825123056546413051, to the bases up to 23 */
    {"437ae92817f9fc85b7e5", false},             /* to the prime bases up to 37 */
    {"2be6951adc5b22410a5fd", false},            /* to the prime bases up to 41 */
    {"1fffffffffffffff", true},                  /* 2^61 - 1 */
    {"1ffffffffffffffffffffff", true},           /* 2^89 - 1 */
    {"7fffffffffffffffffffffffffffffff", true},  /* 2^127 - 1 */
    {"100000000000000000000000000000001", false}, /* 2^128 + 1 */
  };
  ScDhSmallPrimes *small = sd_small_primes();
  mbedtls_mpi x;
  mbedtls_mpi_init(&x);
  for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
    from_hex(&x, cases[i].hex);
    char what[96];
    snprintf(what, sizeof what, "is_prime(0x%s) == %d", cases[i].hex, cases[i].prime);
    check(sd_is_prime(small, &x) == cases[i].prime, what);
  }
  /* The modp groups' primes are safe primes. */
  for (size_t i = 0; i < 4; i++) {
    mbedtls_mpi_read_binary(&x, sd_groups[i].p, sd_groups[i].p_len);
    check(sd_is_prime(small, &x), "a modp prime is prime");
    mbedtls_mpi_shift_r(&x, 1);
    check(sd_is_prime(small, &x), "half a modp prime is prime");
    mbedtls_mpi_add_int(&x, &x, 2);
    check(!sd_is_prime(small, &x), "half a modp prime plus 2 is composite");
  }
  mbedtls_mpi_free(&x);
  free(small);
}

/* DH_check bits for small and composite primes, the Pocklington path for
 * safe primes, and a generator at p - 1. */
static void test_check_params(void) {
  static const struct {
    const char *p;
    int g;
    int codes;
  } cases[] = {
    {"0", 2, 137}, {"1", 2, 137}, {"2", 2, 139},  {"3", 2, 138},  {"5", 2, 128},   {"5", 5, 136},
    {"7", 2, 128}, {"9", 2, 129}, {"f", 2, 129},  {"11", 2, 130}, {"17", 2, 128},  {"17", 22, 136},
    {"18", 2, 129}, {"231", 2, 129}, {"7ff", 2, 129},
  };
  mbedtls_mpi p, g;
  mbedtls_mpi_init(&p);
  mbedtls_mpi_init(&g);
  for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
    from_hex(&p, cases[i].p);
    mbedtls_mpi_lset(&g, cases[i].g);
    char what[96];
    int codes = sd_check_params(&p, &g);
    snprintf(what, sizeof what, "check(0x%s, %d) == %d (got %d)", cases[i].p, cases[i].g, cases[i].codes, codes);
    check(codes == cases[i].codes, what);
  }
  mbedtls_mpi_read_binary(&p, sd_groups[1].p, sd_groups[1].p_len);
  mbedtls_mpi_lset(&g, 2);
  check(sd_check_params(&p, &g) == 0, "check(modp2, 2) == 0");
  mbedtls_mpi_sub_int(&g, &p, 1);
  check(sd_check_params(&p, &g) == SD_NOT_SUITABLE_GENERATOR, "check(modp2, p - 1) == 8");
  mbedtls_mpi_lset(&g, 2);
  mbedtls_mpi_add_int(&p, &p, 2);
  check(sd_check_params(&p, &g) == SD_P_NOT_PRIME, "check(modp2 + 2, 2) == 1");
  mbedtls_mpi_free(&p);
  mbedtls_mpi_free(&g);
}

/* Exponents past 8192 bits, split into digits, against the exponent
 * reduced modulo p - 1 (Fermat) for a prime p. */
static void test_long_exponent(void) {
  mbedtls_mpi p, p1, base, e, reduced, got, want;
  mbedtls_mpi_init(&p);
  mbedtls_mpi_init(&p1);
  mbedtls_mpi_init(&base);
  mbedtls_mpi_init(&e);
  mbedtls_mpi_init(&reduced);
  mbedtls_mpi_init(&got);
  mbedtls_mpi_init(&want);
  mbedtls_mpi_read_binary(&p, sd_groups[0].p, sd_groups[0].p_len);
  mbedtls_mpi_sub_int(&p1, &p, 1);
  mbedtls_mpi_lset(&base, 5);
  static const size_t sizes[] = {8192, 8193, 16382, 16383, 20000};
  for (size_t i = 0; i < sizeof sizes / sizeof sizes[0]; i++) {
    sd_random_bits(&e, sizes[i], false);
    mbedtls_mpi_mod_mpi(&reduced, &e, &p1);
    bool ok = sd_exp(&got, &base, &e, &p) && mbedtls_mpi_exp_mod(&want, &base, &reduced, &p, NULL) == 0;
    char what[64];
    snprintf(what, sizeof what, "5^e mod p for a %zu-bit e", sizes[i]);
    check(ok && mbedtls_mpi_cmp_mpi(&got, &want) == 0, what);
  }
  mbedtls_mpi_lset(&p, 24);
  check(!sd_exp(&got, &base, &e, &p), "an even modulus fails");
  mbedtls_mpi_lset(&p, 1);
  check(!sd_exp(&got, &base, &e, &p), "the modulus 1 fails");
  mbedtls_mpi_free(&p);
  mbedtls_mpi_free(&p1);
  mbedtls_mpi_free(&base);
  mbedtls_mpi_free(&e);
  mbedtls_mpi_free(&reduced);
  mbedtls_mpi_free(&got);
  mbedtls_mpi_free(&want);
}

/* Generated safe primes have the requested length and congruence, and
 * mbedTLS's own primality test accepts p and (p - 1) / 2. */
static void test_generate(void) {
  static const unsigned adds[] = {24, 60, 12};
  mbedtls_mpi p, q, g;
  mbedtls_mpi_init(&p);
  mbedtls_mpi_init(&q);
  mbedtls_mpi_init(&g);
  mbedtls_mpi_lset(&g, 2);
  for (size_t i = 0; i < sizeof adds / sizeof adds[0]; i++) {
    for (int trial = 0; trial < 2; trial++) {
      bool ok = sd_generate_safe_prime(&p, 512, adds[i], adds[i] - 1, false);
      mbedtls_mpi_uint r = 0;
      ok = ok && mbedtls_mpi_bitlen(&p) == 512 && mbedtls_mpi_mod_int(&r, &p, adds[i]) == 0 && r == adds[i] - 1;
      mbedtls_mpi_copy(&q, &p);
      mbedtls_mpi_shift_r(&q, 1);
      ok = ok && mbedtls_mpi_is_prime_ext(&p, 40, sd_random, NULL) == 0 &&
           mbedtls_mpi_is_prime_ext(&q, 40, sd_random, NULL) == 0;
      char what[64];
      snprintf(what, sizeof what, "a 512-bit safe prime ≡ %u (mod %u)", adds[i] - 1, adds[i]);
      check(ok, what);
      check(sd_check_params(&p, &g) == 0, "a generated prime has no DH_check findings");
    }
  }
  mbedtls_mpi_free(&p);
  mbedtls_mpi_free(&q);
  mbedtls_mpi_free(&g);
}

/* generatePrime's search: the sizes and add forms with one possible
 * result, top-two-bit safe-prime starts, and checks above OpenSSL's
 * round count. */
static void test_generate_prime(void) {
  static const struct {
    size_t bits;
    bool safe;
    int add, rem;
    int want;
  } cases[] = {
    {2, false, 0, 0, 3},     {3, false, 0, 0, 7},     {4, false, 0, 0, 13},   {3, true, 0, 0, 7},
    {6, true, 0, 0, 59},     {7, true, 0, 0, 107},    {8, false, 200, 1, 401}, {8, false, 128, 0, 257},
    {5, false, 16, 3, 19},
  };
  mbedtls_mpi p, add, rem, q;
  mbedtls_mpi_init(&p);
  mbedtls_mpi_init(&add);
  mbedtls_mpi_init(&rem);
  mbedtls_mpi_init(&q);
  for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
    mbedtls_mpi_lset(&add, cases[i].add);
    mbedtls_mpi_lset(&rem, cases[i].rem);
    bool ok = sd_generate_prime(&p, cases[i].bits, cases[i].safe, cases[i].add ? &add : NULL,
                                cases[i].rem ? &rem : NULL) &&
              mbedtls_mpi_cmp_int(&p, cases[i].want) == 0;
    char what[96];
    snprintf(what, sizeof what, "generatePrime(%zu, safe %d, add %d, rem %d) is %d", cases[i].bits, cases[i].safe,
             cases[i].add, cases[i].rem, cases[i].want);
    check(ok, what);
  }
  for (int trial = 0; trial < 2; trial++) {
    bool ok = sd_generate_safe_prime(&p, 128, 12, 11, true) && mbedtls_mpi_bitlen(&p) == 128 &&
              mbedtls_mpi_get_bit(&p, 126) == 1;
    mbedtls_mpi_copy(&q, &p);
    mbedtls_mpi_shift_r(&q, 1);
    ok = ok && mbedtls_mpi_is_prime_ext(&p, 40, sd_random, NULL) == 0 &&
         mbedtls_mpi_is_prime_ext(&q, 40, sd_random, NULL) == 0;
    check(ok, "a 128-bit safe prime with its top two bits set");
  }
  ScDhSmallPrimes *small = sd_small_primes();
  mbedtls_mpi_read_string(&q, 10, "3215031751");
  check(!sd_is_prime_checks(small, &q, 200), "200 rounds reject a strong pseudoprime to 2, 3, 5 and 7");
  mbedtls_mpi_read_string(&q, 10, "2305843009213693951");
  check(sd_is_prime_checks(small, &q, 200), "200 rounds accept 2^61 - 1");
  free(small);
  mbedtls_mpi_free(&p);
  mbedtls_mpi_free(&add);
  mbedtls_mpi_free(&rem);
  mbedtls_mpi_free(&q);
}

int main(void) {
  test_mont_pow();
  test_is_prime();
  test_check_params();
  test_long_exponent();
  test_generate();
  test_generate_prime();
  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed ? 1 : 0;
}
