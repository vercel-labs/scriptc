/* scriptc runtime — executable code on transparent huge pages (Linux,
 * `scriptc build --large-pages`).
 *
 * A large program's hot code spans hundreds of 4 KiB pages, more than the
 * instruction TLB holds, and most kernels cannot back file-mapped code with
 * transparent huge pages. When the system grants huge pages to anonymous
 * memory that asks for them (THP "always" or "madvise"), the constructor
 * below copies the executable's code segment, from its first to its last
 * 2 MiB boundary, into anonymous memory advised MADV_HUGEPAGE, makes the
 * copy read-only and executable, and moves it over the original range with
 * one mremap. Addresses and instructions stay the same, and the code is
 * never writable and executable at once. It runs before main, while the
 * process has one thread. If a step fails, the file-mapped code stays.
 *
 * The moved range is private memory: all of it is resident, not only the
 * pages the program runs, and it is not shared with other processes running
 * the same executable. Profilers that symbolize from file mappings see it as
 * anonymous code. The copy takes about 3 ms for 10 MiB of code, so the unit
 * links only into programs built with --large-pages. */
#include "scr_runtime.h"

#if defined(__linux__) && !defined(SCR_LIB)
#include <link.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

#if defined(MADV_HUGEPAGE) && defined(MREMAP_FIXED)
#define SCR_LARGE_PAGE ((uintptr_t)2 << 20)

/* The executable PT_LOAD segment that holds this function: the runtime
 * links into the executable, so that is the main program's code. The
 * object's name does not identify it: glibc reports the main program with
 * an empty name, and musl with its path or "/proc/self/exe". */
static int scr_text_segment(struct dl_phdr_info *info, size_t size, void *data) {
  (void)size;
  uintptr_t self = (uintptr_t)&scr_text_segment;
  for (int i = 0; i < info->dlpi_phnum; i++) {
    const ElfW(Phdr) *ph = &info->dlpi_phdr[i];
    if (ph->p_type != PT_LOAD || !(ph->p_flags & PF_X)) continue;
    uintptr_t lo = (uintptr_t)(info->dlpi_addr + ph->p_vaddr);
    uintptr_t hi = lo + (uintptr_t)ph->p_memsz;
    if (self < lo || self >= hi) continue;
    uintptr_t *range = data;
    range[0] = lo;
    range[1] = hi;
    return 1;
  }
  return 0;
}

/* Whether anonymous memory advised MADV_HUGEPAGE gets huge pages. */
static bool scr_text_thp_allowed(void) {
  FILE *f = fopen("/sys/kernel/mm/transparent_hugepage/enabled", "r");
  if (!f) return false;
  char buf[96] = {0};
  size_t n = fread(buf, 1, sizeof buf - 1, f);
  fclose(f);
  buf[n] = 0;
  return strstr(buf, "[always]") != NULL || strstr(buf, "[madvise]") != NULL;
}

__attribute__((constructor)) static void scr_text_large_pages(void) {
  uintptr_t range[2] = {0, 0};
  dl_iterate_phdr(scr_text_segment, range);
  uintptr_t lo = (range[0] + SCR_LARGE_PAGE - 1) & ~(SCR_LARGE_PAGE - 1);
  uintptr_t hi = range[1] & ~(SCR_LARGE_PAGE - 1);
  if (range[0] == 0 || hi <= lo || !scr_text_thp_allowed()) return;
  size_t len = (size_t)(hi - lo);
  /* An aligned anonymous range: map one large page more and trim. */
  char *raw = mmap(NULL, len + SCR_LARGE_PAGE, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS,
                   -1, 0);
  if (raw == MAP_FAILED) return;
  char *copy = (char *)(((uintptr_t)raw + SCR_LARGE_PAGE - 1) & ~(SCR_LARGE_PAGE - 1));
  char *end = raw + len + SCR_LARGE_PAGE;
  if (copy > raw) (void)munmap(raw, (size_t)(copy - raw));
  if (copy + len < end) (void)munmap(copy + len, (size_t)(end - (copy + len)));
  (void)madvise(copy, len, MADV_HUGEPAGE);
  memcpy(copy, (const void *)lo, len);
  if (mprotect(copy, len, PROT_READ | PROT_EXEC) != 0 ||
      mremap(copy, len, len, MREMAP_MAYMOVE | MREMAP_FIXED, (void *)lo) == MAP_FAILED)
    (void)munmap(copy, len);
}
#endif
#endif
