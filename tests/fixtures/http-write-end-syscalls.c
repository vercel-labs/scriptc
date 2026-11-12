/* LD_PRELOAD shim for http-write-end-syscalls.test.ts: counts the write
 * calls (write, writev, send, sendto, sendmsg) on every socket accept() or
 * accept4() returned, and when such a socket closes appends the count to
 * the file HTTP_WRITE_COUNT_FILE names, one line per connection. Other
 * calls go to the real functions. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <unistd.h>

#define MAX_FDS 4096

static int counts[MAX_FDS]; /* -1: not an accepted socket */
static int initialized;

static void init(void) {
  if (initialized) return;
  for (int i = 0; i < MAX_FDS; i++) counts[i] = -1;
  initialized = 1;
}

static void track(int fd) {
  init();
  if (fd >= 0 && fd < MAX_FDS) counts[fd] = 0;
}

static void count(int fd) {
  init();
  if (fd >= 0 && fd < MAX_FDS && counts[fd] >= 0) counts[fd]++;
}

static void report(int fd) {
  init();
  if (fd < 0 || fd >= MAX_FDS || counts[fd] < 0) return;
  const char *path = getenv("HTTP_WRITE_COUNT_FILE");
  if (path) {
    char line[32];
    int n = snprintf(line, sizeof line, "%d\n", counts[fd]);
    /* raw syscalls: the shim's own write and close must not count. openat,
     * not open: arm64 Linux has no SYS_open. */
    int out = (int)syscall(SYS_openat, AT_FDCWD, path, O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (out >= 0) {
      syscall(SYS_write, out, line, (size_t)n);
      syscall(SYS_close, out);
    }
  }
  counts[fd] = -1;
}

#define REAL(name, type) ((type)dlsym(RTLD_NEXT, name))

int accept(int fd, struct sockaddr *addr, socklen_t *len) {
  int r = REAL("accept", int (*)(int, struct sockaddr *, socklen_t *))(fd, addr, len);
  track(r);
  return r;
}

int accept4(int fd, struct sockaddr *addr, socklen_t *len, int flags) {
  int r = REAL("accept4", int (*)(int, struct sockaddr *, socklen_t *, int))(fd, addr, len, flags);
  track(r);
  return r;
}

ssize_t write(int fd, const void *buf, size_t n) {
  count(fd);
  return REAL("write", ssize_t (*)(int, const void *, size_t))(fd, buf, n);
}

ssize_t writev(int fd, const struct iovec *iov, int iovcnt) {
  count(fd);
  return REAL("writev", ssize_t (*)(int, const struct iovec *, int))(fd, iov, iovcnt);
}

ssize_t send(int fd, const void *buf, size_t n, int flags) {
  count(fd);
  return REAL("send", ssize_t (*)(int, const void *, size_t, int))(fd, buf, n, flags);
}

ssize_t sendto(int fd, const void *buf, size_t n, int flags, const struct sockaddr *to,
               socklen_t tolen) {
  count(fd);
  return REAL("sendto", ssize_t (*)(int, const void *, size_t, int, const struct sockaddr *,
                                    socklen_t))(fd, buf, n, flags, to, tolen);
}

ssize_t sendmsg(int fd, const struct msghdr *msg, int flags) {
  count(fd);
  return REAL("sendmsg", ssize_t (*)(int, const struct msghdr *, int))(fd, msg, flags);
}

int close(int fd) {
  report(fd);
  return REAL("close", int (*)(int))(fd);
}
