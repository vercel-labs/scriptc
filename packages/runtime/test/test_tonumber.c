/* Oracle test for scr_string_to_number (ToNumber over strings), or for
 * scr_parse_float when argv[2] is "parseFloat" (parsefloat-cases.txt).
 * Reads case lines ("<input-hex or ->\t<16-hex-digit expected bit
 * pattern>\n" — see gen-tonumber-cases.mjs) from the file given as
 * argv[1] (or stdin), parses each input, and asserts the resulting
 * double is BIT-equal to Node's Number(input) (NaN payload and the sign
 * of zero included).
 * Exit 0 = all pass; prints each mismatch (capped) and exits 1 otherwise.
 */
#include "../src/scr_runtime.h"

#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCR_RC_AUDIT
long scr_str_live_count(void); /* provided by scr_string.c */
#endif

#define MAX_FIELD 8192

static int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* Decode "<hex>" or "-" (empty) into out; returns length or (size_t)-1. */
static size_t hex_decode(const char *hex, size_t hexlen, char *out) {
  if (hexlen == 1 && hex[0] == '-') return 0;
  if (hexlen % 2 != 0 || hexlen / 2 > MAX_FIELD) return (size_t)-1;
  for (size_t i = 0; i < hexlen; i += 2) {
    int hi = hex_val(hex[i]), lo = hex_val(hex[i + 1]);
    if (hi < 0 || lo < 0) return (size_t)-1;
    out[i / 2] = (char)((hi << 4) | lo);
  }
  return hexlen / 2;
}

int main(int argc, char **argv) {
  FILE *in = stdin;
  if (argc > 1) {
    in = fopen(argv[1], "r");
    if (!in) {
      perror(argv[1]);
      return 2;
    }
  }

  bool parse_float = argc > 2 && strcmp(argv[2], "parseFloat") == 0;
  static char linebuf[2 * MAX_FIELD + 32];
  static char input_bytes[MAX_FIELD];
  long total = 0, failed = 0;
  while (fgets(linebuf, sizeof linebuf, in)) {
    char *tab = strchr(linebuf, '\t');
    if (!tab) {
      failed++;
      fprintf(stderr, "BAD LINE (no tab)\n");
      continue;
    }
    size_t in_len = hex_decode(linebuf, (size_t)(tab - linebuf), input_bytes);
    char *expected_hex = tab + 1;
    expected_hex[strcspn(expected_hex, "\n")] = '\0';
    if (in_len == (size_t)-1 || strlen(expected_hex) != 16) {
      failed++;
      fprintf(stderr, "BAD LINE: %s\n", linebuf);
      continue;
    }

    union {
      uint64_t u;
      double d;
    } expected, got;
    expected.u = strtoull(expected_hex, NULL, 16);

    ScrStr *s = scr_str_new(input_bytes, in_len);
    got.d = parse_float ? scr_parse_float(s) : scr_string_to_number(s);
    scr_str_release(s);

    total++;
    if (got.u != expected.u) {
      failed++;
      if (failed <= 20) {
        *tab = '\0';
        fprintf(stderr,
                "MISMATCH input=%s expected=%016" PRIx64 " got=%016" PRIx64
                " (%.17g)\n",
                linebuf, expected.u, got.u, got.d);
      }
    }
  }
  if (in != stdin) fclose(in);

#ifdef SCR_RC_AUDIT
  if (scr_str_live_count() != 0) {
    fprintf(stderr, "RC AUDIT: %ld strings leaked\n", scr_str_live_count());
    failed++;
  }
#endif

  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed ? 1 : 0;
}
