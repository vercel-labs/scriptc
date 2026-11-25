#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
/* flock(2), for the server's lock file, and the open flags below. */
#define _DEFAULT_SOURCE
#define _DARWIN_C_SOURCE
#endif
/* The code generation server a native compiler build talks to synchronously.
 *
 * A build that does not find a server starts one and connects to it; the
 * server answers every emit request it sends, keeps the tool's libraries and
 * target registered, and exits after its idle period, so the next build
 * either reuses it or starts one of its own. A build that cannot reach a
 * server reports that through a zero handle and runs the one-shot path.
 *
 * There is no JavaScript host on that path, so the connection, the request
 * framing's transfers, and the server's lifetime are all here. */
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifndef _WIN32
#include <fcntl.h>
#include <signal.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

// macOS reports a peer's disconnect as SIGPIPE unless the socket asked
// otherwise, which connect_server does there.
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

#ifndef _WIN32
extern char **environ;
#endif

#define CODEGEN_ERROR_BYTES 512

static char last_error[CODEGEN_ERROR_BYTES];

int32_t scriptc_codegen_error(uint8_t *bytes, size_t size) {
  size_t count = strlen(last_error);
  if (count > size) count = size;
  if (count != 0 && bytes != NULL) memcpy(bytes, last_error, count);
  return (int32_t)count;
}

static void error_text(const char *text) {
  snprintf(last_error, sizeof(last_error), "%s", text);
}

#ifndef _WIN32

static void system_error(int code) {
  snprintf(last_error, sizeof(last_error), "%s (errno %d)", strerror(code), code);
}

typedef struct CodegenServer {
  uint32_t id;
  int socket;
  /* The lock this build holds while it uses the server, so that a second
   * build starts its own server instead of interleaving requests. */
  int lock;
  struct CodegenServer *next;
} CodegenServer;

static CodegenServer *servers;
static uint32_t next_id = 1;
static int exit_registered;

static CodegenServer *find_server(uint32_t handle) {
  for (CodegenServer *server = servers; server != NULL; server = server->next)
    if (server->id == handle) return server;
  error_text("unknown code generation server handle");
  return NULL;
}

static int valid_range(const uint8_t *bytes, size_t size, uint32_t offset, uint32_t length) {
  if (offset > size || length > size - offset || (length != 0 && bytes == NULL)) {
    error_text("transfer is outside the borrowed byte span");
    return 0;
  }
  return 1;
}

static char *copy_argument(const uint8_t *bytes, size_t size) {
  if (size == 0 || bytes == NULL || memchr(bytes, 0, size) != NULL) {
    error_text("a server argument must be a nonempty string without NUL bytes");
    return NULL;
  }
  char *copy = malloc(size + 1);
  if (copy == NULL) { error_text("out of memory"); return NULL; }
  memcpy(copy, bytes, size);
  copy[size] = '\0';
  return copy;
}

void scriptc_codegen_close(uint32_t handle);

void scriptc_codegen_close_all(void) {
  while (servers != NULL) scriptc_codegen_close(servers->id);
}

void scriptc_codegen_close(uint32_t handle) {
  CodegenServer **link = &servers;
  while (*link != NULL && (*link)->id != handle) link = &(*link)->next;
  if (*link == NULL) return;
  CodegenServer *server = *link;
  *link = server->next;
  // Closing the connection ends this build's session; the server keeps
  // running for the builds that follow. The lock only says this build is
  // done with it.
  close(server->socket);
  close(server->lock);
  free(server);
}

/* This user's server directory: $XDG_RUNTIME_DIR/scriptc, or
 * /tmp/scriptc-<uid>. It must be a directory this user owns with no access
 * for others; one that exists otherwise is not used. */
static int server_directory(char *path, size_t size) {
  const char *runtime = getenv("XDG_RUNTIME_DIR");
  int count = runtime != NULL && runtime[0] == '/'
                  ? snprintf(path, size, "%s/scriptc", runtime)
                  : snprintf(path, size, "/tmp/scriptc-%lu", (unsigned long)geteuid());
  if (count < 0 || (size_t)count >= size) {
    error_text("server directory path is too long");
    return 0;
  }
  if (mkdir(path, 0700) != 0 && errno != EEXIST) { system_error(errno); return 0; }
  struct stat info;
  if (lstat(path, &info) != 0) { system_error(errno); return 0; }
  if (!S_ISDIR(info.st_mode) || info.st_uid != geteuid() || (info.st_mode & 077) != 0) {
    error_text("server directory is not private to this user");
    return 0;
  }
  return 1;
}

/* A connection to the server listening at `path`, or -1. */
static int connect_server(const char *path) {
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, path, strlen(path) + 1);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  if (fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) { close(fd); return -1; }
#ifdef SO_NOSIGPIPE
  int no_sigpipe = 1;
  if (setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe)) != 0) {
    close(fd);
    return -1;
  }
#endif
  int status;
  do { status = connect(fd, (const struct sockaddr *)&address, sizeof(address)); } while (status != 0 && errno == EINTR);
  if (status != 0) { close(fd); return -1; }
  return fd;
}

/* Starts the server in its own process group, so that a terminal's signals
 * to the build do not reach it, with its standard streams on /dev/null and
 * no other descriptor of this process, so that it holds no pipe a caller of
 * the build waits on. */
static pid_t start_server(char **args) {
  long descriptors = sysconf(_SC_OPEN_MAX);
  if (descriptors < 0 || descriptors > 65536) descriptors = 65536;
  pid_t pid = fork();
  if (pid == 0) {
    // Only async-signal-safe calls until exec.
    int null = open("/dev/null", O_RDWR);
    if (setpgid(0, 0) != 0 || null < 0 || dup2(null, STDIN_FILENO) < 0 ||
        dup2(null, STDOUT_FILENO) < 0 || dup2(null, STDERR_FILENO) < 0 || chdir("/") != 0)
      _exit(127);
#if defined(__linux__) && defined(SYS_close_range)
    if (syscall(SYS_close_range, 3U, ~0U, 0U) != 0)
#endif
      for (long fd = 3; fd < descriptors; fd++) close((int)fd);
    execve(args[0], args, environ);
    _exit(127);
  }
  int error = errno;
  if (pid < 0) { system_error(error); return -1; }
  return pid;
}

/* The lock that makes one build at a time use the server at `socket_path`,
 * or -1. `in_use` reports a server another build is connected to. */
static int lock_server(const char *socket_path, int *in_use) {
  char lock_path[512];
  if ((size_t)snprintf(lock_path, sizeof(lock_path), "%s.lock", socket_path) >= sizeof(lock_path)) {
    error_text("server lock path is too long");
    return -1;
  }
  int lock = open(lock_path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (lock < 0) { system_error(errno); return -1; }
  if (flock(lock, LOCK_EX | LOCK_NB) != 0) {
    if (errno == EWOULDBLOCK) {
      *in_use = 1;
      error_text("the code generation server is in use");
    } else {
      system_error(errno);
    }
    close(lock);
    return -1;
  }
  return lock;
}

/* Connects to the server named `name`, starting it from `executable` when
 * none is listening. The server listens as it starts; one that exits first,
 * or is not listening within 2 s, leaves this build to its one-shot path. */
uint32_t scriptc_codegen_attach(const uint8_t *name, size_t name_size,
                                const uint8_t *executable, size_t executable_size,
                                uint32_t idle_exit) {
  if (next_id == 0) { error_text("server handle IDs are exhausted"); return 0; }
  char *server = copy_argument(name, name_size);
  if (server == NULL) return 0;
  char directory[256];
  char socket_path[sizeof(((struct sockaddr_un *)0)->sun_path)];
  int named = 0;
  if (strchr(server, '/') != NULL) {
    error_text("server names cannot contain '/'");
  } else if (server_directory(directory, sizeof(directory))) {
    int count = snprintf(socket_path, sizeof(socket_path), "%s/%s.sock", directory, server);
    if (count < 0 || (size_t)count >= sizeof(socket_path))
      error_text("server socket path is too long");
    else
      named = 1;
  }
  if (!named) {
    free(server);
    return 0;
  }
  // One build at a time uses a server; a build that finds the shared one in
  // use runs on a server of its own rather than waiting for it.
  int in_use = 0;
  int lock = lock_server(socket_path, &in_use);
  if (lock < 0 && in_use) {
    char unique[256];
    (void)snprintf(unique, sizeof(unique), "%s-%lu", server, (unsigned long)getpid());
    if ((size_t)snprintf(socket_path, sizeof(socket_path), "%s/%s.sock", directory, unique) <
        sizeof(socket_path))
      lock = lock_server(socket_path, &in_use);
    else
      error_text("server socket path is too long");
  }
  free(server);
  if (lock < 0) return 0;
  int fd = connect_server(socket_path);
  if (fd < 0) {
    char *exe = copy_argument(executable, executable_size);
    char idle[16];
    (void)snprintf(idle, sizeof(idle), "%lu", (unsigned long)idle_exit);
    pid_t pid = -1;
    if (exe != NULL) {
      char *args[8] = {exe, "serve", "--socket", socket_path, "--idle-exit", idle};
      args[6] = NULL;
      pid = start_server(args);
    }
    free(exe);
    for (int attempt = 0; pid > 0; attempt++) {
      fd = connect_server(socket_path);
      if (fd >= 0) break;
      int status;
      pid_t result;
      do { result = waitpid(pid, &status, WNOHANG); } while (result < 0 && errno == EINTR);
      if (result != 0) { error_text("the code generation server exited as it started"); break; }
      if (attempt == 1000) { error_text("the code generation server did not start listening"); break; }
      struct timespec delay = {0, 2000000};
      while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {}
    }
  }
  if (fd < 0) { close(lock); return 0; }
  CodegenServer *server_entry = calloc(1, sizeof(*server_entry));
  if (server_entry == NULL) { error_text("out of memory"); close(fd); close(lock); return 0; }
  if (!exit_registered) {
    if (atexit(scriptc_codegen_close_all) != 0) {
      error_text("could not register server cleanup");
      free(server_entry);
      close(fd);
      close(lock);
      return 0;
    }
    exit_registered = 1;
  }
  server_entry->socket = fd;
  server_entry->lock = lock;
  server_entry->id = next_id++;
  server_entry->next = servers;
  servers = server_entry;
  return server_entry->id;
}

int32_t scriptc_codegen_read(uint32_t handle, uint8_t *bytes, size_t size,
                             uint32_t offset, uint32_t length) {
  CodegenServer *server = find_server(handle);
  if (server == NULL || !valid_range(bytes, size, offset, length)) return -1;
  if (length == 0) return 0;
  if (length > INT32_MAX) length = INT32_MAX;
  ssize_t count;
  do { count = recv(server->socket, bytes + offset, length, 0); } while (count < 0 && errno == EINTR);
  if (count < 0) { system_error(errno); return -1; }
  return (int32_t)count;
}

int32_t scriptc_codegen_write(uint32_t handle, const uint8_t *bytes, size_t size,
                              uint32_t offset, uint32_t length) {
  CodegenServer *server = find_server(handle);
  if (server == NULL || !valid_range(bytes, size, offset, length)) return -1;
  if (length == 0) return 0;
  if (length > INT32_MAX) length = INT32_MAX;
  ssize_t count;
  do { count = send(server->socket, bytes + offset, length, MSG_NOSIGNAL); } while (count < 0 && errno == EINTR);
  if (count < 0) { system_error(errno); return -1; }
  return (int32_t)count;
}

#else

/* Attach reports that servers need Unix sockets and returns no handle, so
 * there is never one to close. */
void scriptc_codegen_close(uint32_t handle) { (void)handle; }

void scriptc_codegen_close_all(void) {}

uint32_t scriptc_codegen_attach(const uint8_t *name, size_t name_size,
                                const uint8_t *executable, size_t executable_size,
                                uint32_t idle_exit) {
  (void)name; (void)name_size; (void)executable; (void)executable_size; (void)idle_exit;
  error_text("a code generation server needs Unix sockets");
  return 0;
}

int32_t scriptc_codegen_read(uint32_t handle, uint8_t *bytes, size_t size,
                             uint32_t offset, uint32_t length) {
  (void)handle; (void)bytes; (void)size; (void)offset; (void)length;
  error_text("a code generation server needs Unix sockets");
  return -1;
}

int32_t scriptc_codegen_write(uint32_t handle, const uint8_t *bytes, size_t size,
                              uint32_t offset, uint32_t length) {
  (void)handle; (void)bytes; (void)size; (void)offset; (void)length;
  error_text("a code generation server needs Unix sockets");
  return -1;
}

#endif
