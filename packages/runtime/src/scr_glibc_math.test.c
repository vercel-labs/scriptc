/* Prints the bits of floor, ceil, trunc, round, sqrt, fmod, scalbn, ldexp
 * and frexp over a fixed set of inputs: NaN payloads, signed zeros,
 * subnormals, the infinities, halfway cases and values around 2^52 (quiet
 * NaNs only: frexp returns a signaling NaN unchanged where glibc's quiets
 * it, which no JavaScript value can observe). The
 * test (scr_glibc_math.test.ts) builds it against glibc's libm and, for the
 * musl lane, against scr_glibc_math.c, and compares the output. */
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

static uint64_t bits(double d) {
  uint64_t b;
  memcpy(&b, &d, sizeof b);
  return b;
}

static double from_bits(uint64_t b) {
  double d;
  memcpy(&d, &b, sizeof d);
  return d;
}

/* volatile: the calls must reach the library, not constant folding. */
static volatile double inputs[64];
static size_t count;

static void add(double d) { inputs[count++] = d; }

int main(void) {
  static const double values[] = {
      0.0, -0.0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.49999999999999994, -0.49999999999999994,
      1.0, -1.0, 3.7, -3.7, 1e-310, -1e-310, 4.9e-324, 123456789.75, -123456789.25,
      4503599627370495.5, -4503599627370495.5, 4503599627370496.0, 9007199254740993.0,
      1e300, -1e300, 1.7976931348623157e308,
  };
  for (size_t i = 0; i < sizeof values / sizeof values[0]; i++) add(values[i]);
  add(from_bits(UINT64_C(0x7FF0000000000000)));
  add(from_bits(UINT64_C(0xFFF0000000000000)));
  add(from_bits(UINT64_C(0x7FF8000000000001)));
  add(from_bits(UINT64_C(0xFFFC000000000123)));
  for (size_t i = 0; i < count; i++) {
    double x = inputs[i];
    int e = 0;
    double m = frexp(x, &e);
    printf("%016" PRIx64 " floor %016" PRIx64 " ceil %016" PRIx64 " trunc %016" PRIx64
           " round %016" PRIx64 " sqrt %016" PRIx64 " frexp %016" PRIx64 " %d\n",
           bits(x), bits(floor(x)), bits(ceil(x)), bits(trunc(x)), bits(round(x)),
           bits(sqrt(x)), bits(m), e);
    for (size_t j = 0; j < count; j += 3) {
      double y = inputs[j];
      printf("  fmod %016" PRIx64 " %016" PRIx64 "\n", bits(y), bits(fmod(x, y)));
    }
    static const int exps[] = {-1100, -1074, -1, 0, 1, 52, 1023, 1100, 2100};
    for (size_t k = 0; k < sizeof exps / sizeof exps[0]; k++)
      printf("  scalbn %d %016" PRIx64 " ldexp %016" PRIx64 "\n", exps[k],
             bits(scalbn(x, exps[k])), bits(ldexp(x, exps[k])));
  }
  return 0;
}
