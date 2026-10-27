#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif
/* macOS declares mkdtemp only with the Darwin extensions visible. */
#if defined(__APPLE__) && !defined(_DARWIN_C_SOURCE)
#define _DARWIN_C_SOURCE 1
#endif
#include "ts7-process.h"
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

static const char *executable;
static const char *callbacks = "readFile,fileExists";

static uint32_t start_with(const char *mode, int timing, int libraries) {
  return scriptc_ts7_open((const uint8_t *)executable, strlen(executable),
                          (const uint8_t *)mode, strlen(mode),
                          (const uint8_t *)callbacks, strlen(callbacks), (uint8_t)timing, (uint8_t)libraries);
}

static uint32_t start(const char *mode, int timing) { return start_with(mode, timing, 0); }

static void fail_message(void) {
  uint8_t message[1024];
  int32_t size = scriptc_ts7_error(message, sizeof(message));
  assert(size > 0);
  assert(scriptc_ts7_error(message, 3) == 3);
  assert(scriptc_ts7_error(NULL, 0) == 0);
}

static void read_exact(uint32_t id, uint8_t *bytes, size_t size) {
  size_t at = 0;
  while (at < size) {
    int32_t count = scriptc_ts7_read(id, bytes, size, (uint32_t)at, (uint32_t)(size - at));
    assert(count > 0 && (size_t)count <= size - at);
    at += (size_t)count;
  }
}

static void write_exact(uint32_t id, const uint8_t *bytes, size_t size, uint32_t offset, uint32_t length) {
  uint32_t at = 0;
  while (at < length) {
    int32_t count = scriptc_ts7_write(id, bytes, size, offset + at, length - at);
    assert(count > 0 && (uint32_t)count <= length - at);
    at += (uint32_t)count;
  }
}

static void assert_reaped(uint32_t pid) {
#ifdef _WIN32
  HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, pid);
  if (process != NULL) {
    assert(WaitForSingleObject(process, 0) == WAIT_OBJECT_0);
    CloseHandle(process);
  } else assert(GetLastError() == ERROR_INVALID_PARAMETER);
#else
  int status;
  assert(waitpid((pid_t)pid, &status, WNOHANG) == -1 && errno == ECHILD);
#endif
}

static unsigned resource_count(void) {
#ifdef _WIN32
  DWORD count;
  assert(GetProcessHandleCount(GetCurrentProcess(), &count));
  return (unsigned)count;
#else
  unsigned count = 0;
  for (int fd = 0; fd < 1024; fd++) if (fcntl(fd, F_GETFD) != -1) count++;
  return count;
#endif
}

static void argument_cases(void) {
  const char *values[] = {
    "", "a b", "double\"quote", "end\\", "many\\\\\"quotes\\\\", "a;&$()`'b", "h\xc3\xa9llo \xf0\x9f\x8c\x8d",
  };
  for (size_t i = 0; i < sizeof(values) / sizeof(values[0]); i++) {
    for (int flags = 0; flags < 4; flags++) {
      int timing = flags & 1, libraries = flags >> 1;
      char mode[256], expected[512];
      snprintf(mode, sizeof(mode), "argv:%s", values[i]);
      snprintf(expected, sizeof(expected), "%s\n--callbacks=%s\n%s\n%s", values[i], callbacks,
               timing ? "timing" : "plain", libraries ? "libraries from disk\n" : "");
      uint32_t id = start_with(mode, timing, libraries);
      assert(id != 0);
      uint8_t actual[512];
      read_exact(id, actual, strlen(expected));
      assert(memcmp(actual, expected, strlen(expected)) == 0);
      assert(scriptc_ts7_read(id, actual, sizeof(actual), 0, sizeof(actual)) == 0);
      uint32_t pid = scriptc_ts7_pid(id);
      scriptc_ts7_close(id);
      assert_reaped(pid);
    }
  }
}

static void exchange_cases(void) {
  uint32_t ids[3];
  for (int i = 0; i < 3; i++) { ids[i] = start("echo", 0); assert(ids[i] != 0); }
  assert(ids[0] != ids[1] && ids[1] != ids[2]);
  uint8_t bytes[1028], result[1028];
  for (unsigned round = 0; round < 200; round++) {
    for (unsigned i = 0; i < sizeof(bytes); i++) bytes[i] = (uint8_t)(i * 31 + round);
    memset(result, 0xcc, sizeof(result));
    uint32_t id = ids[round % 3];
    write_exact(id, bytes, sizeof(bytes), 2, 1024);
    size_t at = 2;
    while (at < 1026) {
      int32_t count = scriptc_ts7_read(id, result, sizeof(result), (uint32_t)at, (uint32_t)(1026 - at));
      assert(count > 0);
      at += (size_t)count;
    }
    assert(memcmp(bytes + 2, result + 2, 1024) == 0);
    assert(result[0] == 0xcc && result[1] == 0xcc && result[1026] == 0xcc && result[1027] == 0xcc);
  }
  for (int i = 0; i < 3; i++) {
    uint32_t id = ids[i], pid = scriptc_ts7_pid(id);
    assert(scriptc_ts7_read(id, NULL, 0, 0, 0) == 0);
    assert(scriptc_ts7_write(id, NULL, 0, 0, 0) == 0);
    assert(scriptc_ts7_read(id, result, sizeof(result), sizeof(result) + 1, 0) == -1);
    assert(scriptc_ts7_read(id, result, sizeof(result), 1, sizeof(result)) == -1);
    assert(scriptc_ts7_write(id, NULL, 1, 0, 1) == -1);
    assert(scriptc_ts7_write(id, bytes, sizeof(bytes), UINT32_MAX, 2) == -1);
    fail_message();
    scriptc_ts7_close(id);
    scriptc_ts7_close(id);
    assert_reaped(pid);
    assert(scriptc_ts7_read(id, result, sizeof(result), 0, 1) == -1);
    assert(scriptc_ts7_write(id, bytes, sizeof(bytes), 0, 1) == -1);
  }
  uint32_t newer = start("echo", 0);
  assert(newer > ids[2]);
  scriptc_ts7_close(ids[0]);
  assert(scriptc_ts7_pid(newer) != 0);
  scriptc_ts7_close(newer);
}

static void failure_cases(void) {
  uint8_t bytes[1] = {42};
  const char *saved = executable;
  executable = "/scriptc/does-not-exist/tsgo";
  for (int i = 0; i < 30; i++) { assert(start("echo", 0) == 0); fail_message(); }
  executable = saved;
  assert(scriptc_ts7_open(NULL, 0, bytes, 1, bytes, 1, 0, 0) == 0);
  assert(scriptc_ts7_open((const uint8_t *)"abc\0def", 7, bytes, 1, bytes, 1, 0, 0) == 0);
  assert(scriptc_ts7_open((const uint8_t *)executable, strlen(executable), NULL, 0, bytes, 1, 0, 0) == 0);
  assert(scriptc_ts7_open((const uint8_t *)executable, strlen(executable), bytes, 1, NULL, 0, 0, 0) == 0);
  for (int i = 0; i < 30; i++) {
    uint32_t id = start("exit", 0);
    assert(id != 0);
    assert(scriptc_ts7_read(id, bytes, 1, 0, 1) == 0);
    // The peer has closed: writes must report an error, never SIGPIPE.
    assert(scriptc_ts7_write(id, bytes, 1, 0, 1) == -1);
    uint32_t pid = scriptc_ts7_pid(id);
    scriptc_ts7_close(id);
    assert_reaped(pid);
  }
  for (int i = 0; i < 3; i++) {
    uint32_t id = start("stall", 0);
    assert(id != 0);
    read_exact(id, bytes, 1);
    assert(bytes[0] == '!');
  }
  scriptc_ts7_close_all();
  scriptc_ts7_close_all();
  scriptc_ts7_close(0);
  scriptc_ts7_close(UINT32_MAX);
}

#ifndef _WIN32
static uint32_t attach(const char *name, const char *mode, uint32_t memory) {
  return scriptc_ts7_attach((const uint8_t *)name, strlen(name), (const uint8_t *)executable, strlen(executable),
                            (const uint8_t *)mode, strlen(mode), (const uint8_t *)callbacks, strlen(callbacks),
                            0, 0, 1, memory);
}

static void expect_line(uint32_t id, const char *expected) {
  char line[512];
  size_t at = 0;
  do {
    assert(at + 1 < sizeof(line));
    read_exact(id, (uint8_t *)line + at, 1);
  } while (line[at++] != '\n');
  line[at] = '\0';
  assert(strcmp(line, expected) == 0);
}

static void attach_cases(void) {
  char runtime[] = "/tmp/scriptc-ts7-attach-XXXXXX";
  assert(mkdtemp(runtime) != NULL);
  assert(setenv("XDG_RUNTIME_DIR", runtime, 1) == 0);
  assert(unsetenv("TSC_TS_LISTEN_MEMORY") == 0);
  char directory[256], socket_path[512], expected[600];
  uint8_t bytes[4];
  snprintf(directory, sizeof(directory), "%s/scriptc", runtime);
  snprintf(socket_path, sizeof(socket_path), "%s/server.sock", directory);
  // The first build starts the server with its idle time and memory limit.
  // The server holds none of the build's descriptors, such as an output
  // pipe its caller reads to the end.
  int output[2];
  assert(pipe(output) == 0);
  uint32_t first = attach("server", "listen", 123);
  assert(first != 0 && scriptc_ts7_pid(first) == 0);
  close(output[1]);
  struct pollfd ended = {output[0], POLLIN, 0};
  assert(poll(&ended, 1, 5000) == 1);
  assert(read(output[0], bytes, 1) == 0);
  close(output[0]);
  expect_line(first, "client 1\n");
  snprintf(expected, sizeof(expected), "%s 1\n", socket_path);
  expect_line(first, expected);
  expect_line(first, "123\n");
  write_exact(first, (const uint8_t *)"ping", 4, 0, 4);
  read_exact(first, bytes, 4);
  assert(memcmp(bytes, "ping", 4) == 0);
  // A build that finds the server in use gets no handle.
  for (int i = 0; i < 3; i++) { assert(attach("server", "listen", 123) == 0); fail_message(); }
  scriptc_ts7_close(first);
  scriptc_ts7_close(first);
  // A later build connects to the same server.
  uint32_t second = attach("server", "listen", 123);
  assert(second != 0);
  expect_line(second, "client 2\n");
  scriptc_ts7_close(second);
  // An executable without --listen exits as it starts.
  assert(attach("old", "listen-exit", 0) == 0);
  fail_message();
  // A server directory others can access is not used.
  assert(chmod(directory, 0755) == 0);
  assert(attach("server", "listen", 123) == 0);
  fail_message();
  assert(chmod(directory, 0700) == 0);
  // A name that would leave the directory, or make the path too long.
  assert(attach("../server", "listen", 123) == 0);
  fail_message();
  char long_name[200];
  memset(long_name, 'x', sizeof(long_name) - 1);
  long_name[sizeof(long_name) - 1] = '\0';
  assert(attach(long_name, "listen", 123) == 0);
  fail_message();
  // The server exits after its idle second and removes its socket.
  unlink(socket_path);
  snprintf(expected, sizeof(expected), "%s.lock", socket_path);
  unlink(expected);
  snprintf(expected, sizeof(expected), "%s/old.sock.lock", directory);
  unlink(expected);
  rmdir(directory);
  rmdir(runtime);
  assert(unsetenv("XDG_RUNTIME_DIR") == 0);
}
#endif

static int process_main(int argc, char **argv) {
  assert(argc >= 2);
  executable = argv[1];
#ifndef _WIN32
  assert(signal(SIGPIPE, SIG_DFL) != SIG_ERR);
  int saved_input = -1, saved_output = -1;
  if (argc > 2 && strcmp(argv[2], "closed-standard") == 0) {
    saved_input = dup(STDIN_FILENO);
    saved_output = dup(STDOUT_FILENO);
    close(STDIN_FILENO);
    close(STDOUT_FILENO);
  }
#endif
  // Windows initializes process creation, Unicode conversion and error
  // formatting facilities lazily. Measure repeated use after exercising
  // those paths; their one-time handles are not owned by this transport.
#ifdef _WIN32
  argument_cases();
  exchange_cases();
  failure_cases();
#endif
  unsigned before = resource_count();
  argument_cases();
  exchange_cases();
  failure_cases();
#ifndef _WIN32
  attach_cases();
#endif
  assert(resource_count() == before);
#ifndef _WIN32
  if (saved_input >= 0) { assert(dup2(saved_input, STDIN_FILENO) >= 0); close(saved_input); }
  if (saved_output >= 0) { assert(dup2(saved_output, STDOUT_FILENO) >= 0); close(saved_output); }
#endif
  puts("native process contracts passed");
  return 0;
}

#ifdef _WIN32
int wmain(int argc, wchar_t **wide) {
  char **argv = calloc((size_t)argc, sizeof(*argv));
  assert(argv != NULL);
  for (int i = 0; i < argc; i++) {
    int size = WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, NULL, 0, NULL, NULL);
    assert(size > 0);
    argv[i] = malloc((size_t)size);
    assert(argv[i] != NULL);
    assert(WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, argv[i], size, NULL, NULL) == size);
  }
  int result = process_main(argc, argv);
  for (int i = 0; i < argc; i++) free(argv[i]);
  free(argv);
  return result;
}
#else
int main(int argc, char **argv) { return process_main(argc, argv); }
#endif
