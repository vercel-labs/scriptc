/* Reads cases from standard input, each a little-endian u32 length, a u32
 * start and the bytes, and prints scriptc_ts7_json_value_end for each. */
#include "ts7-process.h"
#include <stdio.h>
#include <stdlib.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

static int read_u32(uint32_t *value) {
  unsigned char bytes[4];
  if (fread(bytes, 1, 4, stdin) != 4) return 0;
  *value = (uint32_t)bytes[0] | (uint32_t)bytes[1] << 8 | (uint32_t)bytes[2] << 16 |
           (uint32_t)bytes[3] << 24;
  return 1;
}

int main(void) {
#ifdef _WIN32
  /* The cases are bytes: text mode would rewrite line endings. */
  _setmode(_fileno(stdin), _O_BINARY);
#endif
  uint32_t length, start;
  while (read_u32(&length)) {
    if (!read_u32(&start)) return 1;
    uint8_t *bytes = malloc(length == 0 ? 1 : length);
    if (bytes == NULL || fread(bytes, 1, length, stdin) != length) return 1;
    printf("%d\n", (int)scriptc_ts7_json_value_end(bytes, length, start));
    free(bytes);
  }
  return 0;
}
