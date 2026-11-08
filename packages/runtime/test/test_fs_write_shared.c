/* The options-record byte write over shared storage: a SharedArrayBuffer
 * backing a Buffer or Uint8Array may be rewritten by another thread, so the
 * write snapshots it (SCR_BYTES_SNAPSHOT) and hands write() a local copy —
 * the same rule the plain byte write follows. The wrapped write() in this
 * fixture records whether the pointer it receives is the shared storage. */
#include "scr_runtime.h"

#include <stdio.h>
#include <string.h>
#include <unistd.h>

static const uint8_t *shared_data;
static int shared_writes;
static int writes;

ssize_t __real_write(int fd, const void *buf, size_t n);
ssize_t __wrap_write(int fd, const void *buf, size_t n) {
  writes++;
  if (buf == shared_data) shared_writes++;
  return __real_write(fd, buf, n);
}

static ScrBytes *shared_bytes(size_t count, uint8_t fill) {
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)count);
  scr_bytes_make_shared(bytes);
  memset(bytes->data, fill, count);
  shared_data = bytes->data;
  return bytes;
}

static int file_is(const char *path, uint8_t fill, size_t count) {
  FILE *file = fopen(path, "rb");
  if (!file) return 0;
  int ok = 1;
  for (size_t i = 0; i < count; i++)
    if (fgetc(file) != fill) ok = 0;
  if (fgetc(file) != EOF) ok = 0;
  fclose(file);
  return ok;
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: %s <dir>\n", argv[0]);
    return 2;
  }
  char path[4096];
  snprintf(path, sizeof path, "%s/options.bin", argv[1]);
  ScrStr *p = scr_str_new(path, strlen(path));
  ScrStr *empty = scr_str_new("", 0);
  ScrStr *write_flag = scr_str_new("w", 1);
  ScrStr *append_flag = scr_str_new("a", 1);

  /* The mode is a number, as the lowering passes it. Octal 0644 as an
   * integer constant: `0644.0` is the decimal 644.0, which creates the file
   * as 01204, without read permission for its owner, and the read-back below
   * then fails wherever the process has no CAP_DAC_OVERRIDE. */
  double mode = (double)0644;
  ScrBytes *bytes = shared_bytes(64, 0x41);
  scr_fs_write_file_bytes_options(p, bytes, empty, mode, write_flag);
  int ok = file_is(path, 0x41, 64);
  scr_fs_append_file_bytes_options(p, bytes, empty, mode, append_flag);
  ok = ok && file_is(path, 0x41, 128);

  int saw_shared = shared_writes;
  int wrote = writes;
  scr_bytes_release(bytes);
  scr_str_release(p);
  scr_str_release(empty);
  scr_str_release(write_flag);
  scr_str_release(append_flag);

  if (!ok || saw_shared != 0 || wrote == 0) {
    fprintf(stderr, "ok=%d shared_writes=%d writes=%d\n", ok, saw_shared, wrote);
    return 1;
  }
  printf("shared options write checks passed\n");
  return 0;
}
