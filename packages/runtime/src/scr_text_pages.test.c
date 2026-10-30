/* scr_text_pages.c checks (Linux): a program that links the unit has its code
 * moved onto anonymous memory when the system grants transparent huge pages,
 * and keeps the file-mapped code otherwise. The code stays the same either
 * way. Eight MiB of padding in the text segment give the move several
 * aligned 2 MiB pages to take. */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PAD_BYTES 0x800000

__asm__(".pushsection .text\n"
        ".p2align 12\n"
        ".globl scr_test_text_pad\n"
        "scr_test_text_pad:\n"
        ".skip 0x800000, 0xcc\n"
        ".popsection\n");
extern const unsigned char scr_test_text_pad[];

static void fail(const char *what) {
  printf("FAIL: %s\n", what);
  exit(1);
}

static bool thp_allowed(void) {
  FILE *f = fopen("/sys/kernel/mm/transparent_hugepage/enabled", "r");
  if (!f) return false;
  char buf[96] = {0};
  size_t n = fread(buf, 1, sizeof buf - 1, f);
  fclose(f);
  buf[n] = 0;
  return strstr(buf, "[always]") != NULL || strstr(buf, "[madvise]") != NULL;
}

/* Whether the mapping holding `p` is backed by a file (an inode), and its
 * permissions. */
static bool mapping_of(const void *p, bool *file, char perms[5]) {
  FILE *f = fopen("/proc/self/maps", "r");
  if (!f) return false;
  char line[512];
  bool found = false;
  while (fgets(line, sizeof line, f)) {
    unsigned long lo, hi, offset, inode;
    unsigned dev_major, dev_minor;
    if (sscanf(line, "%lx-%lx %4s %lx %x:%x %lu", &lo, &hi, perms, &offset, &dev_major, &dev_minor,
               &inode) != 7)
      continue;
    if ((uintptr_t)p < lo || (uintptr_t)p >= hi) continue;
    *file = inode != 0;
    found = true;
    break;
  }
  fclose(f);
  return found;
}

int main(void) {
  const unsigned char *middle = scr_test_text_pad + PAD_BYTES / 2;
  bool file;
  char perms[5] = {0};
  if (!mapping_of(middle, &file, perms)) fail("the padding is in no mapping");
  if (strcmp(perms, "r-xp") != 0) fail("the code is not read-only and executable");
  bool allowed = thp_allowed();
  if (allowed && file) fail("the code stayed file-mapped although huge pages are allowed");
  if (!allowed && !file) fail("the code moved although huge pages are not allowed");
  for (size_t i = 0; i < PAD_BYTES; i++)
    if (scr_test_text_pad[i] != 0xcc) fail("the moved code differs");
  printf("text page checks passed: %s\n", allowed ? "moved" : "kept");
  return 0;
}
