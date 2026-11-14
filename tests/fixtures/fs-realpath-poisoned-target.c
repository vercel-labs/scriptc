/* LD_PRELOAD shim for fs-realpath-poisoned-target.test.ts: the readlink of
 * the path named in SCRIPTC_REALPATH_POISON answers "sub/l", the target of a
 * different link that a directory-entry owner swapped in between the walk's
 * lstat and its readlink. Every other readlink goes to the real one. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

ssize_t readlink(const char *path, char *buf, size_t size) {
  const char *poisoned = getenv("SCRIPTC_REALPATH_POISON");
  if (poisoned != NULL && strcmp(path, poisoned) == 0) {
    static const char target[] = "sub/l";
    size_t len = sizeof target - 1;
    if (len > size) len = size;
    memcpy(buf, target, len);
    return (ssize_t)len;
  }
  static ssize_t (*real)(const char *, char *, size_t);
  if (real == NULL) real = (ssize_t (*)(const char *, char *, size_t))dlsym(RTLD_NEXT, "readlink");
  return real(path, buf, size);
}
