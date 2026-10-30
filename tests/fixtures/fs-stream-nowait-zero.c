/* LD_PRELOAD shim for fs-stream-nowait.test.ts: preadv2 with RWF_NOWAIT
 * answers 0, as Linux 5.9 and 5.10 do for an uncached RWF_NOWAIT read;
 * other calls go to the real preadv2. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/uio.h>

ssize_t preadv2(int fd, const struct iovec *iov, int iovcnt, off_t offset, int flags) {
  if (flags & RWF_NOWAIT) return 0;
  ssize_t (*real)(int, const struct iovec *, int, off_t, int) =
      (ssize_t (*)(int, const struct iovec *, int, off_t, int))dlsym(RTLD_NEXT, "preadv2");
  return real(fd, iov, iovcnt, offset, flags);
}
