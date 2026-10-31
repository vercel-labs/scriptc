/* A deterministic process oracle. It accepts the real server's arguments,
 * but its small modes isolate OS transport behavior from TypeScript RPC. */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#else
#include <poll.h>
#include <time.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

/* `--listen PATH --idle-exit SECONDS`: a stand-in for a shared server. In
 * mode "listen-exit" it exits as an executable without --listen does. In
 * mode "listen" it answers each client, in order, with its client number,
 * its listen arguments, TSC_TS_LISTEN_MEMORY and its working directory, then
 * echoes until the client closes, and exits after SECONDS (at most 5) without
 * a client. */
static int listen_main(const char *mode, char **argv) {
  if (strcmp(mode, "listen-exit") == 0) return 2;
  if (strcmp(mode, "listen") != 0) return 73;
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  if (strlen(argv[0]) >= sizeof(address.sun_path)) return 77;
  strcpy(address.sun_path, argv[0]);
  int listener = socket(AF_UNIX, SOCK_STREAM, 0);
  if (listener < 0 || bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      listen(listener, 4) != 0)
    return 78;
  const char *memory = getenv("TSC_TS_LISTEN_MEMORY");
  int idle = atoi(argv[2]);
  if (idle > 5) idle = 5;
  for (int client = 1;; client++) {
    struct pollfd entry = {listener, POLLIN, 0};
    if (poll(&entry, 1, idle * 1000) <= 0) break;
    int fd = accept(listener, NULL, NULL);
    if (fd < 0) return 79;
    char line[1024], cwd[256];
    if (getcwd(cwd, sizeof(cwd)) == NULL) return 81;
    int size = snprintf(line, sizeof(line), "client %d\n%s %s\n%s\n%s\n", client, argv[0], argv[2],
                        memory == NULL ? "unset" : memory, cwd);
    if (size <= 0 || write(fd, line, (size_t)size) != size) return 80;
    uint8_t bytes[17];
    ssize_t count;
    while ((count = read(fd, bytes, sizeof(bytes))) > 0)
      if (write(fd, bytes, (size_t)count) != count) break;
    close(fd);
  }
  unlink(argv[0]);
  return 0;
}
#endif

static int child_main(int argc, char **argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  int listening = argc >= 9 && strcmp(argv[5], "--listen") == 0 && strcmp(argv[7], "--idle-exit") == 0;
  int fixed = listening ? 9 : 5;
  int at = fixed, timing = 0, libraries = 0;
  if (at < argc && strcmp(argv[at], "--timing") == 0) { timing = 1; at++; }
  if (at < argc && strcmp(argv[at], "--default-libraries-from-disk") == 0) { libraries = 1; at++; }
  if (argc < fixed || at != argc || strcmp(argv[1], "--api") != 0 || strcmp(argv[2], "--cwd") != 0 ||
      strncmp(argv[4], "--callbacks=", 12) != 0)
    return 71;
  const char *mode = argv[3];
#ifndef _WIN32
  if (listening) return listen_main(mode, argv + 6);
#endif
  if (strncmp(mode, "argv:", 5) == 0) {
    fwrite(mode + 5, 1, strlen(mode + 5), stdout);
    fputc('\n', stdout);
    fputs(argv[4], stdout);
    fputc('\n', stdout);
    fputs(timing ? "timing\n" : "plain\n", stdout);
    if (libraries) fputs("libraries from disk\n", stdout);
    return ferror(stdout) ? 72 : 0;
  }
  if (strcmp(mode, "exit") == 0) return 0;
  if (strcmp(mode, "stderr") == 0) {
    fputs("native server stderr\n", stderr);
    return 0;
  }
  if (strcmp(mode, "stall") == 0) {
    // Tell the parent we started, then deliberately ignore closed input.
    fputc('!', stdout);
    fflush(stdout);
    for (;;) {
#ifdef _WIN32
      Sleep(1000);
#else
      sleep(1);
#endif
    }
  }
  // "slow-echo" answers each read 20 ms later: after the client's poll.
  int slow = strcmp(mode, "slow-echo") == 0;
  if (!slow && strcmp(mode, "echo") != 0) return 73;
  // Unbuffered reads let short writes make progress without waiting for a
  // complete stdio buffer. Fragment each echoed reply independently.
  uint8_t bytes[17];
  for (;;) {
#ifdef _WIN32
    int count = _read(_fileno(stdin), bytes, sizeof(bytes));
#else
    ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
#endif
    if (count <= 0) return count < 0 ? 74 : 0;
    if (slow) {
#ifdef _WIN32
      Sleep(20);
#else
      struct timespec delay = {0, 20000000L};
      nanosleep(&delay, NULL);
#endif
    }
    if (fwrite(bytes, 1, (size_t)count, stdout) != (size_t)count || fflush(stdout) != 0) return 75;
  }
}

#ifdef _WIN32
// Go's executable reads Unicode argv directly. Use the same contract here
// instead of the active ANSI code page of an ordinary CRT main().
int wmain(int argc, wchar_t **wide) {
  char **argv = calloc((size_t)argc, sizeof(*argv));
  if (argv == NULL) return 76;
  for (int i = 0; i < argc; i++) {
    int size = WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, NULL, 0, NULL, NULL);
    argv[i] = malloc((size_t)size);
    if (argv[i] == NULL) return 76;
    WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, argv[i], size, NULL, NULL);
  }
  int result = child_main(argc, argv);
  for (int i = 0; i < argc; i++) free(argv[i]);
  free(argv);
  return result;
}
#else
int main(int argc, char **argv) { return child_main(argc, argv); }
#endif
