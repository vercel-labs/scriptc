/* scr_intl_utf16.h over byte sequences from stdin, one per line as hex
 * (`61ff62`). Prints each sequence's UTF-16 units as hex, space-separated,
 * and exits 1 when the count and the units written disagree. */
#include "scr_intl_utf16.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
  char line[4096];
  while (fgets(line, sizeof line, stdin) != NULL) {
    unsigned char bytes[2048];
    size_t len = 0;
    for (const char *p = line; p[0] != '\0' && p[0] != '\n' && p[1] != '\0'; p += 2) {
      unsigned int byte;
      if (sscanf(p, "%2x", &byte) != 1) return 2;
      bytes[len++] = (unsigned char)byte;
    }
    size_t count = scr_intl_utf16_units(bytes, len);
    uint16_t *units = malloc((count + 1) * sizeof *units);
    if (units == NULL) return 2;
    size_t written = scr_intl_utf16_fill(bytes, len, units);
    if (written != count) {
      printf("count %zu written %zu\n", count, written);
      return 1;
    }
    for (size_t i = 0; i < written; i++) printf(i == 0 ? "%04x" : " %04x", units[i]);
    printf("\n");
    free(units);
  }
  return 0;
}
