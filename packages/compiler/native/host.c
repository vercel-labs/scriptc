#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif
/* flock and LOCK_EX/LOCK_UN, which Darwin hides under _POSIX_C_SOURCE. */
#if defined(__APPLE__) && !defined(_DARWIN_C_SOURCE)
#define _DARWIN_C_SOURCE 1
#endif
#include <stdint.h>
#include <limits.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <sys/stat.h>
#include <unistd.h>
#endif

/* Accept only directories owned by this user with private POSIX access.
 * Windows inherits the user's cache ACL; reject reparse points so an
 * installed cache directory cannot redirect compiler payloads elsewhere. */
uint8_t scriptc_native_private_directory(const uint8_t *bytes, size_t size, uint8_t harden) {
  if (size == 0 || memchr(bytes, 0, size) != NULL) return 0;
#ifdef _WIN32
  (void)harden;
  if (size > INT_MAX) return 0;
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)bytes, (int)size, NULL, 0);
  if (length <= 0) return 0;
  wchar_t *path = malloc(((size_t)length + 1) * sizeof(wchar_t));
  if (!path) return 0;
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)bytes, (int)size, path, length) != length) { free(path); return 0; }
  path[length] = 0;
  DWORD attrs = GetFileAttributesW(path);
  free(path);
  return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0 && (attrs & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
#else
  char *path = malloc(size + 1);
  if (!path) return 0;
  memcpy(path, bytes, size);
  path[size] = 0;
  struct stat info;
  int ok = lstat(path, &info) == 0 && S_ISDIR(info.st_mode) && info.st_uid == getuid();
  if (ok && harden && (info.st_mode & 077) != 0) ok = chmod(path, 0700) == 0;
  if (ok) ok = lstat(path, &info) == 0 && S_ISDIR(info.st_mode) && info.st_uid == getuid() && (info.st_mode & 077) == 0;
  free(path);
  return ok;
#endif
}

/* The runtime's full sweep after a phase's data died (scr_rc.h). */
void scr_collect_cycles_phase(void);

/* Reclaims the cycles a finished compiler phase leaves behind. The
 * frontend's syntax trees and program state refer to each other, so
 * reference counting frees almost none of them when the frontend is
 * disposed, and the collector's schedule alone may not run a full pass
 * before the build ends. The sweep then returns the freed pages to the
 * system (scr_heap_trim), so code generation does not grow on top of the
 * frontend's heap. */
void scriptc_native_collect_cycles(void) {
  scr_collect_cycles_phase();
}

/* Forked lowering workers (frontend/process-fork.ts). A worker shares the
 * parent's heap copy-on-write, writes its results to a file and leaves with
 * _exit, so no buffered output or exit handler of the parent runs twice.
 * Checker requests from workers hold an exclusive flock on a file each
 * worker opens after the fork, so every worker has its own open file
 * description and the lock excludes the other workers. */
#ifdef _WIN32
int32_t scriptc_native_fork(void) { return -1; }
void scriptc_native_exit(int32_t code) { ExitProcess((UINT)code); }
int32_t scriptc_native_wait(int32_t pid) { (void)pid; return -1; }
uint8_t scriptc_native_lock_open(const uint8_t *bytes, size_t size) { (void)bytes; (void)size; return 0; }
void scriptc_native_lock(void) {}
void scriptc_native_unlock(void) {}
#else
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/wait.h>

#if defined(__linux__)
/* LLVM's profile runtime, linked into instrumented builds of the compiler
 * (SCRIPTC_NATIVE_PROFILE_GENERATE); other builds leave these null. A worker
 * starts with zeroed counters and writes its profile before _exit, which
 * skips the runtime's atexit writer, so the profile counts the worker's work
 * once. */
extern void __llvm_profile_reset_counters(void) __attribute__((weak));
extern int __llvm_profile_write_file(void) __attribute__((weak));
#endif

int32_t scriptc_native_fork(void) {
  pid_t pid = fork();
#if defined(__linux__)
  if (pid == 0 && __llvm_profile_reset_counters != NULL) __llvm_profile_reset_counters();
#endif
  return (int32_t)pid;
}

void scriptc_native_exit(int32_t code) {
#if defined(__linux__)
  if (__llvm_profile_write_file != NULL) (void)__llvm_profile_write_file();
#endif
  _exit(code);
}

/* The worker's exit status, 128 plus the signal for a worker a signal
 * ended, or -1 when waitpid fails. */
int32_t scriptc_native_wait(int32_t pid) {
  int status = 0;
  while (waitpid((pid_t)pid, &status, 0) < 0) {
    if (errno != EINTR) return -1;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return -1;
}

static int scriptc_native_lock_fd = -1;

uint8_t scriptc_native_lock_open(const uint8_t *bytes, size_t size) {
  if (size == 0 || memchr(bytes, 0, size) != NULL) return 0;
  char *path = malloc(size + 1);
  if (!path) return 0;
  memcpy(path, bytes, size);
  path[size] = 0;
  if (scriptc_native_lock_fd >= 0) close(scriptc_native_lock_fd);
  scriptc_native_lock_fd = open(path, O_CREAT | O_RDWR | O_CLOEXEC, 0600);
  free(path);
  return scriptc_native_lock_fd >= 0;
}

void scriptc_native_lock(void) {
  if (scriptc_native_lock_fd < 0) return;
  while (flock(scriptc_native_lock_fd, LOCK_EX) < 0 && errno == EINTR) {
  }
}

void scriptc_native_unlock(void) {
  if (scriptc_native_lock_fd >= 0) flock(scriptc_native_lock_fd, LOCK_UN);
}
#endif

/* The runtime's growth cap for full cycle passes (scr_rc.h). */
void scr_cyc_set_growth_cap(long cap);

/* Bounds the cyclic garbage a build can hold to twice its live heap.
 * Lowering a large program leaves hundreds of megabytes of cyclic garbage,
 * and whether a scheduled full pass reclaims it before the build's peak
 * depends on where the growth rule fires: with the default cap of 16, small
 * changes to the compiler moved the peak of one build by 390 MB. With a cap
 * of 2 a full pass runs once the heap has grown to three times its size
 * after the last one; a cap of 1 bounds the garbage further but runs more
 * passes over the live heap. SCR_CYCLE_GROWTH_CAP still overrides it. */
void scriptc_native_bound_cycle_growth(void) {
  scr_cyc_set_growth_cap(2);
}

/* The runtime's nursery trigger (scr_rc.h). */
void scr_cyc_set_nursery_threshold(long threshold);

/* Runs nursery passes every 1024 new candidates instead of every 256. Much
 * of a build's cyclic garbage outlives 256 releases: in the shorter window
 * it survives a nursery pass, is promoted, and only full passes over the
 * whole live heap find it. A constructor sets it before the compiler's
 * modules initialize, so every pass of a build uses it.
 * SCR_CYCLE_THRESHOLD still overrides it. */
__attribute__((constructor)) static void scriptc_native_widen_cycle_nursery(void) {
  scr_cyc_set_nursery_threshold(1024);
}
