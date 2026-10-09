/* Oracle test for scr_f64_to_fixed (Number.prototype.toFixed's digits).
 * Reads case lines ("<16-hex-digit bit pattern>\t<fractionDigits>\t
 * <expected>\n" — see gen-fixed-cases.mjs) from the file given as argv[1]
 * (or stdin), renders each double, and asserts byte equality with Node's
 * x.toFixed(f).
 * Exit 0 = all pass; prints each mismatch (capped) and exits 1 otherwise.
 */
#include "../src/scr_runtime.h"

#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  FILE *in = stdin;
  if (argc > 1) {
    in = fopen(argv[1], "r");
    if (!in) {
      perror(argv[1]);
      return 2;
    }
  }

  char linebuf[256];
  char got[128];
  long total = 0, failed = 0;
  while (fgets(linebuf, sizeof linebuf, in)) {
    char *tab = strchr(linebuf, '\t');
    char *tab2 = tab ? strchr(tab + 1, '\t') : NULL;
    if (!tab2) {
      failed++;
      fprintf(stderr, "BAD LINE: %s\n", linebuf);
      continue;
    }
    *tab = '\0';
    *tab2 = '\0';
    int f = atoi(tab + 1);
    char *expected = tab2 + 1;
    expected[strcspn(expected, "\n")] = '\0';

    union {
      uint64_t u;
      double d;
    } bits;
    bits.u = strtoull(linebuf, NULL, 16);

    size_t len = scr_f64_to_fixed(bits.d, f, got);
    total++;
    if (len != strlen(got) || strcmp(got, expected) != 0) {
      failed++;
      if (failed <= 20) {
        fprintf(stderr, "MISMATCH bits=%s f=%d expected=\"%s\" got=\"%s\"\n",
                linebuf, f, expected, got);
      }
    }
  }
  if (in != stdin) fclose(in);

  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed ? 1 : 0;
}
