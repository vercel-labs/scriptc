#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
/* flock(2), for the checker server's lock file, and syscall(2). */
#define _DEFAULT_SOURCE
#define _DARWIN_C_SOURCE
#endif
#include "ts7-process.h"
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
#else
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <crt_externs.h>
#else
extern char **environ;
#endif
#endif

typedef struct Ts7Process {
  uint32_t id;
  uint32_t pid;
  struct Ts7Process *next;
#ifdef _WIN32
  HANDLE process;
  HANDLE job;
  HANDLE input;
  HANDLE output;
#else
  int socket;
  /* The checker server's lock file, held while connected to the server
   * (scriptc_ts7_attach); -1 for a server this process started. */
  int lock;
#endif
} Ts7Process;

static Ts7Process *processes;
static uint32_t next_id = 1;
static int exit_registered;
static char last_error[1024];

static void error_text(const char *text) {
  (void)snprintf(last_error, sizeof(last_error), "%s", text);
}

#ifdef _WIN32
static void system_error(DWORD code) {
  wchar_t message[512];
  DWORD count = FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                               NULL, code, 0, message, 512, NULL);
  if (count == 0 || WideCharToMultiByte(CP_UTF8, 0, message, (int)count,
                                        last_error, sizeof(last_error) - 1, NULL, NULL) == 0) {
    (void)snprintf(last_error, sizeof(last_error), "Windows error %lu", (unsigned long)code);
  } else {
    int length = WideCharToMultiByte(CP_UTF8, 0, message, (int)count,
                                     last_error, sizeof(last_error) - 1, NULL, NULL);
    while (length > 0 && (last_error[length - 1] == '\r' || last_error[length - 1] == '\n')) length--;
    last_error[length] = '\0';
  }
}
#else
static void system_error(int code) { error_text(strerror(code)); }
#endif

int32_t scriptc_ts7_error(uint8_t *bytes, size_t size) {
  size_t count = strlen(last_error);
  if (count > size) count = size;
  if (count != 0 && bytes != NULL) memcpy(bytes, last_error, count);
  return (int32_t)count;
}

static char *copy_argument(const uint8_t *bytes, size_t size, const char *prefix) {
  size_t prefix_size = strlen(prefix);
  if (size == 0 || bytes == NULL || memchr(bytes, 0, size) != NULL) {
    error_text("process arguments must be nonempty strings without NUL bytes");
    return NULL;
  }
  if (size > SIZE_MAX - prefix_size - 1) {
    error_text("process argument is too large");
    return NULL;
  }
  char *copy = malloc(prefix_size + size + 1);
  if (copy == NULL) { error_text("out of memory"); return NULL; }
  memcpy(copy, prefix, prefix_size);
  memcpy(copy + prefix_size, bytes, size);
  copy[prefix_size + size] = '\0';
  return copy;
}

static Ts7Process *find_process(uint32_t id) {
  for (Ts7Process *p = processes; p != NULL; p = p->next) {
    if (p->id == id) return p;
  }
  error_text("invalid or closed server handle");
  return NULL;
}

#ifdef _WIN32
static wchar_t *wide_argument(const char *argument) {
  int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, argument, -1, NULL, 0);
  if (count == 0) { system_error(GetLastError()); return NULL; }
  wchar_t *wide = malloc((size_t)count * sizeof(wchar_t));
  if (wide == NULL) { error_text("out of memory"); return NULL; }
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, argument, -1, wide, count) == 0) {
    system_error(GetLastError()); free(wide); return NULL;
  }
  return wide;
}

/* Quote each argv element using the Windows CRT rules. Backslashes before
 * quotes and before the closing quote need doubling; shell metacharacters
 * remain ordinary characters because no command interpreter is started. */
static wchar_t *command_line(wchar_t **arguments, size_t count) {
  size_t capacity = 1;
  for (size_t i = 0; i < count; i++) {
    size_t length = wcslen(arguments[i]);
    if (length > 16380 || capacity > 32767 - (length * 2 + 4)) {
      error_text("server command line exceeds the Windows limit"); return NULL;
    }
    capacity += length * 2 + 4;
  }
  wchar_t *line = malloc(capacity * sizeof(wchar_t));
  if (line == NULL) { error_text("out of memory"); return NULL; }
  wchar_t *out = line;
  for (size_t i = 0; i < count; i++) {
    if (i != 0) *out++ = L' ';
    *out++ = L'"';
    const wchar_t *at = arguments[i];
    for (;;) {
      size_t slashes = 0;
      while (*at == L'\\') { slashes++; at++; }
      size_t emit = (*at == L'"' || *at == L'\0') ? slashes * 2 : slashes;
      while (emit-- > 0) *out++ = L'\\';
      if (*at == L'\0') break;
      if (*at == L'"') *out++ = L'\\';
      *out++ = *at++;
    }
    *out++ = L'"';
  }
  *out = L'\0';
  return line;
}

static int start_process(Ts7Process *p, char **args, size_t argc) {
  wchar_t *wide[7] = {0};
  wchar_t *line = NULL;
  HANDLE child_input = NULL, child_output = NULL, child_error = NULL;
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
  int attributes_ready = 0;
  int started = 0;
  PROCESS_INFORMATION info = {0};
  SECURITY_ATTRIBUTES security = {sizeof(security), NULL, TRUE};
  DWORD code = 0;
  for (size_t i = 0; i < argc; i++) {
    wide[i] = wide_argument(args[i]);
    if (wide[i] == NULL) goto done;
  }
  line = command_line(wide, argc);
  if (line == NULL) goto done;
  if (!CreatePipe(&child_input, &p->input, &security, 0) ||
      !SetHandleInformation(p->input, HANDLE_FLAG_INHERIT, 0) ||
      !CreatePipe(&p->output, &child_output, &security, 0) ||
      !SetHandleInformation(p->output, HANDLE_FLAG_INHERIT, 0)) goto failed;
  HANDLE stderr_handle = GetStdHandle(STD_ERROR_HANDLE);
  if (stderr_handle != NULL && stderr_handle != INVALID_HANDLE_VALUE) {
    if (!DuplicateHandle(GetCurrentProcess(), stderr_handle, GetCurrentProcess(),
                          &child_error, 0, TRUE, DUPLICATE_SAME_ACCESS)) goto failed;
  } else {
    child_error = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                              &security, OPEN_EXISTING, 0, NULL);
    if (child_error == INVALID_HANDLE_VALUE) { child_error = NULL; goto failed; }
  }
  SIZE_T attribute_size = 0;
  (void)InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_size);
  attributes = malloc(attribute_size);
  if (attributes == NULL) { error_text("out of memory"); goto done; }
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_size)) goto failed;
  attributes_ready = 1;
  HANDLE inherited[] = {child_input, child_output, child_error};
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                  inherited, sizeof(inherited), NULL, NULL)) goto failed;
  p->job = CreateJobObjectW(NULL, NULL);
  if (p->job == NULL) goto failed;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(p->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) goto failed;
  STARTUPINFOEXW startup = {0};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = child_input;
  startup.StartupInfo.hStdOutput = child_output;
  startup.StartupInfo.hStdError = child_error;
  startup.lpAttributeList = attributes;
  if (!CreateProcessW(wide[0], line, NULL, NULL, TRUE,
                       EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED,
                       NULL, NULL, &startup.StartupInfo, &info)) goto failed;
  if (!AssignProcessToJobObject(p->job, info.hProcess) || ResumeThread(info.hThread) == (DWORD)-1) goto failed;
  p->process = info.hProcess;
  p->pid = info.dwProcessId;
  info.hProcess = NULL;
  started = 1;
  goto done;
failed:
  code = GetLastError();
  system_error(code);
done:
  if (info.hProcess != NULL) {
    (void)TerminateProcess(info.hProcess, 1);
    (void)WaitForSingleObject(info.hProcess, INFINITE);
    CloseHandle(info.hProcess);
  }
  if (info.hThread != NULL) CloseHandle(info.hThread);
  if (child_input != NULL) CloseHandle(child_input);
  if (child_output != NULL) CloseHandle(child_output);
  if (child_error != NULL) CloseHandle(child_error);
  if (attributes_ready) DeleteProcThreadAttributeList(attributes);
  free(attributes);
  free(line);
  for (size_t i = 0; i < argc; i++) free(wide[i]);
  if (!started) {
    if (p->input != NULL) CloseHandle(p->input);
    if (p->output != NULL) CloseHandle(p->output);
    if (p->job != NULL) CloseHandle(p->job);
  }
  return started;
}

static void stop_process(Ts7Process *p) {
  CloseHandle(p->input);
  CloseHandle(p->output);
  // Permit a server already finishing after EOF to exit normally. The job
  // guarantees cleanup even if the server never reads its closed input.
  if (WaitForSingleObject(p->process, 50) == WAIT_TIMEOUT) {
    (void)TerminateJobObject(p->job, 1);
  }
  (void)WaitForSingleObject(p->process, INFINITE);
  CloseHandle(p->process);
  CloseHandle(p->job);
}
#else
static int start_process(Ts7Process *p, char **args, size_t argc) {
  (void)argc;
  int sockets[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) != 0) { system_error(errno); return 0; }
  int error = 0;
  if (fcntl(sockets[0], F_SETFD, FD_CLOEXEC) < 0 || fcntl(sockets[1], F_SETFD, FD_CLOEXEC) < 0) {
    error = errno; goto done;
  }
#ifdef SO_NOSIGPIPE
  int no_sigpipe = 1;
  if (setsockopt(sockets[0], SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe)) != 0) {
    error = errno; goto done;
  }
#endif
  // Keep the child's socket away from stdin/stdout even when the parent
  // started with a standard descriptor closed. dup2(fd, fd) preserves
  // CLOEXEC and a later close action would otherwise close the new stream.
  if (sockets[1] <= STDERR_FILENO) {
    int moved = fcntl(sockets[1], F_DUPFD_CLOEXEC, STDERR_FILENO + 1);
    if (moved < 0) { error = errno; goto done; }
    close(sockets[1]); sockets[1] = moved;
  }
  posix_spawn_file_actions_t actions;
  error = posix_spawn_file_actions_init(&actions);
  if (error != 0) goto done;
  error = posix_spawn_file_actions_addclose(&actions, sockets[0]);
  if (error == 0) error = posix_spawn_file_actions_adddup2(&actions, sockets[1], STDIN_FILENO);
  if (error == 0) error = posix_spawn_file_actions_adddup2(&actions, sockets[1], STDOUT_FILENO);
  if (error == 0) error = posix_spawn_file_actions_addclose(&actions, sockets[1]);
  pid_t pid = 0;
#ifdef __APPLE__
  char **environment = *_NSGetEnviron();
#else
  char **environment = environ;
#endif
  if (error == 0) error = posix_spawn(&pid, args[0], &actions, NULL, args, environment);
  posix_spawn_file_actions_destroy(&actions);
  if (error == 0) {
    p->socket = sockets[0]; p->pid = (uint32_t)pid; p->lock = -1;
  }
done:
  close(sockets[1]);
  if (error != 0) { close(sockets[0]); system_error(error); }
  return error == 0;
}

static void stop_process(Ts7Process *p) {
  close(p->socket);
  // A shared checker server keeps running; closing the connection ends this
  // build's session, and closing the lock file lets another build connect.
  if (p->lock >= 0) { close(p->lock); return; }
  int status;
  pid_t pid = (pid_t)p->pid;
  // A server exits within a fraction of a millisecond of reading EOF, so the
  // checks start 0.1 ms apart and double: 51.1 ms in all before the kill.
  for (int attempt = 0; attempt < 10; attempt++) {
    pid_t result;
    do { result = waitpid(pid, &status, WNOHANG); } while (result < 0 && errno == EINTR);
    // ECHILD also means the PID no longer belongs to us. Never signal a
    // potentially recycled PID after somebody else has reaped the child.
    if (result == pid || (result < 0 && errno == ECHILD)) return;
    if (attempt == 9) break;
    struct timespec delay = {0, 100000L << attempt};
    while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {}
  }
  (void)kill(pid, SIGKILL);
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
}
#endif

uint32_t scriptc_ts7_open(const uint8_t *executable, size_t executable_size,
                         const uint8_t *cwd, size_t cwd_size,
                         const uint8_t *callbacks, size_t callbacks_size,
                         uint8_t timing, uint8_t libraries_from_disk) {
  if (next_id == 0) { error_text("server handle IDs are exhausted"); return 0; }
  char *exe = copy_argument(executable, executable_size, "");
  if (exe == NULL) return 0;
  char *directory = copy_argument(cwd, cwd_size, "");
  if (directory == NULL) { free(exe); return 0; }
  char *callback_flag = copy_argument(callbacks, callbacks_size, "--callbacks=");
  if (callback_flag == NULL) { free(exe); free(directory); return 0; }
  Ts7Process *p = calloc(1, sizeof(*p));
  if (p == NULL) { error_text("out of memory"); free(exe); free(directory); free(callback_flag); return 0; }
  if (!exit_registered) {
    if (atexit(scriptc_ts7_close_all) != 0) {
      error_text("could not register server cleanup"); free(p); free(exe); free(directory); free(callback_flag); return 0;
    }
    exit_registered = 1;
  }
  char *args[8] = {exe, "--api", "--cwd", directory, callback_flag};
  size_t argc = 5;
  if (timing) args[argc++] = "--timing";
  if (libraries_from_disk) args[argc++] = "--default-libraries-from-disk";
  args[argc] = NULL;
  int started = start_process(p, args, argc);
  free(exe); free(directory); free(callback_flag);
  if (!started) { free(p); return 0; }
  p->id = next_id++;
  p->next = processes;
  processes = p;
  return p->id;
}

#ifdef _WIN32
uint32_t scriptc_ts7_attach(const uint8_t *name, size_t name_size,
                           const uint8_t *executable, size_t executable_size,
                           const uint8_t *cwd, size_t cwd_size,
                           const uint8_t *callbacks, size_t callbacks_size,
                           uint8_t timing, uint8_t libraries_from_disk, uint32_t idle_exit,
                           uint32_t memory) {
  (void)name; (void)name_size; (void)executable; (void)executable_size; (void)cwd; (void)cwd_size;
  (void)callbacks; (void)callbacks_size; (void)timing; (void)libraries_from_disk; (void)idle_exit; (void)memory;
  error_text("a shared checker server needs Unix sockets");
  return 0;
}
#else
/* This user's checker server directory: $XDG_RUNTIME_DIR/scriptc, or
 * /tmp/scriptc-<uid>. It must be a directory this user owns with no access
 * for others; one that exists otherwise is not used. */
static int server_directory(char *path, size_t size) {
  const char *runtime = getenv("XDG_RUNTIME_DIR");
  int count = runtime != NULL && runtime[0] == '/'
                  ? snprintf(path, size, "%s/scriptc", runtime)
                  : snprintf(path, size, "/tmp/scriptc-%lu", (unsigned long)geteuid());
  if (count < 0 || (size_t)count >= size) { error_text("checker server directory path is too long"); return 0; }
  if (mkdir(path, 0700) != 0 && errno != EEXIST) { system_error(errno); return 0; }
  struct stat info;
  if (lstat(path, &info) != 0) { system_error(errno); return 0; }
  if (!S_ISDIR(info.st_mode) || info.st_uid != geteuid() || (info.st_mode & 077) != 0) {
    error_text("checker server directory is not private to this user");
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
  if (setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe)) != 0) { close(fd); return -1; }
#endif
  int status;
  do { status = connect(fd, (const struct sockaddr *)&address, sizeof(address)); } while (status != 0 && errno == EINTR);
  if (status != 0) { close(fd); return -1; }
  return fd;
}

/* Starts the server in its own process group, so that a terminal's signals
 * to the build do not reach it, with its standard streams on /dev/null and
 * no other descriptor of this process, so that it holds no pipe a caller of
 * the build waits on. `limit` (TSC_TS_LISTEN_MEMORY=...) is added to the
 * environment unless it sets TSC_TS_LISTEN_MEMORY. */
static pid_t start_server(char **args, char *limit) {
#ifdef __APPLE__
  char **inherited = *_NSGetEnviron();
#else
  char **inherited = environ;
#endif
  size_t count = 0;
  int has_limit = 0;
  for (; inherited[count] != NULL; count++)
    if (strncmp(inherited[count], "TSC_TS_LISTEN_MEMORY=", 21) == 0) has_limit = 1;
  char **environment = malloc((count + 2) * sizeof(char *));
  if (environment == NULL) { error_text("out of memory"); return -1; }
  memcpy(environment, inherited, count * sizeof(char *));
  environment[count] = has_limit ? NULL : limit;
  environment[count + 1] = NULL;
  long descriptors = sysconf(_SC_OPEN_MAX);
  if (descriptors < 0 || descriptors > 65536) descriptors = 65536;
  sigset_t signals;
  sigemptyset(&signals);
  pid_t pid = fork();
  if (pid == 0) {
    // Only async-signal-safe calls until exec.
    int null = open("/dev/null", O_RDWR);
    if (setpgid(0, 0) != 0 || null < 0 || dup2(null, STDIN_FILENO) < 0 || dup2(null, STDOUT_FILENO) < 0 ||
        dup2(null, STDERR_FILENO) < 0)
      _exit(127);
#if defined(__linux__) && defined(SYS_close_range)
    if (syscall(SYS_close_range, 3U, ~0U, 0U) != 0)
#endif
      for (long fd = 3; fd < descriptors; fd++) close((int)fd);
    sigprocmask(SIG_SETMASK, &signals, NULL);
    execve(args[0], args, environment);
    _exit(127);
  }
  int error = errno;
  free(environment);
  if (pid < 0) { system_error(error); return -1; }
  return pid;
}

uint32_t scriptc_ts7_attach(const uint8_t *name, size_t name_size,
                           const uint8_t *executable, size_t executable_size,
                           const uint8_t *cwd, size_t cwd_size,
                           const uint8_t *callbacks, size_t callbacks_size,
                           uint8_t timing, uint8_t libraries_from_disk, uint32_t idle_exit,
                           uint32_t memory) {
  if (next_id == 0) { error_text("server handle IDs are exhausted"); return 0; }
  char *server = copy_argument(name, name_size, "");
  if (server == NULL) return 0;
  char directory[256], socket_path[sizeof(((struct sockaddr_un *)0)->sun_path)], lock_path[512];
  int named = strchr(server, '/') == NULL;
  if (!named) error_text("checker server names cannot contain '/'");
  if (named) named = server_directory(directory, sizeof(directory));
  if (named) {
    int count = snprintf(socket_path, sizeof(socket_path), "%s/%s.sock", directory, server);
    named = count > 0 && (size_t)count < sizeof(socket_path);
    if (!named) error_text("checker server socket path is too long");
    else (void)snprintf(lock_path, sizeof(lock_path), "%s.lock", socket_path);
  }
  free(server);
  if (!named) return 0;
  // One build at a time uses the server; a build that finds it in use
  // starts its own server instead of waiting.
  int lock = open(lock_path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (lock < 0) { system_error(errno); return 0; }
  if (flock(lock, LOCK_EX | LOCK_NB) != 0) {
    if (errno == EWOULDBLOCK) error_text("the checker server is in use");
    else system_error(errno);
    close(lock);
    return 0;
  }
  int fd = connect_server(socket_path);
  if (fd < 0) {
    char *exe = copy_argument(executable, executable_size, "");
    char *dir = exe == NULL ? NULL : copy_argument(cwd, cwd_size, "");
    char *callback_flag = dir == NULL ? NULL : copy_argument(callbacks, callbacks_size, "--callbacks=");
    char idle[16], limit[48];
    (void)snprintf(idle, sizeof(idle), "%lu", (unsigned long)idle_exit);
    (void)snprintf(limit, sizeof(limit), "TSC_TS_LISTEN_MEMORY=%lu", (unsigned long)memory);
    pid_t pid = -1;
    if (callback_flag != NULL) {
      char *args[12] = {exe, "--api", "--cwd", dir, callback_flag, "--listen", socket_path, "--idle-exit", idle};
      size_t argc = 9;
      if (timing) args[argc++] = "--timing";
      if (libraries_from_disk) args[argc++] = "--default-libraries-from-disk";
      args[argc] = NULL;
      pid = start_server(args, limit);
    }
    free(exe); free(dir); free(callback_flag);
    // The server listens as it starts. One that exits first, such as a
    // tsc-ts without --listen, or one that is not listening within 2 s,
    // leaves this build to start its own server.
    for (int attempt = 0; pid > 0; attempt++) {
      fd = connect_server(socket_path);
      if (fd >= 0) break;
      int status;
      pid_t result;
      do { result = waitpid(pid, &status, WNOHANG); } while (result < 0 && errno == EINTR);
      if (result != 0) { error_text("the checker server exited as it started"); break; }
      if (attempt == 1000) { error_text("the checker server did not start listening"); break; }
      struct timespec delay = {0, 2000000};
      while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {}
    }
  }
  if (fd < 0) { close(lock); return 0; }
  Ts7Process *p = calloc(1, sizeof(*p));
  if (p == NULL) { error_text("out of memory"); close(fd); close(lock); return 0; }
  if (!exit_registered) {
    if (atexit(scriptc_ts7_close_all) != 0) {
      error_text("could not register server cleanup"); free(p); close(fd); close(lock); return 0;
    }
    exit_registered = 1;
  }
  p->socket = fd;
  p->lock = lock;
  p->id = next_id++;
  p->next = processes;
  processes = p;
  return p->id;
}
#endif

uint32_t scriptc_ts7_pid(uint32_t handle) {
  Ts7Process *p = find_process(handle);
  return p != NULL ? p->pid : 0;
}

static int valid_range(const uint8_t *bytes, size_t size, uint32_t offset, uint32_t length) {
  if (offset > size || length > size - offset || (length != 0 && bytes == NULL)) {
    error_text("transfer is outside the borrowed byte span"); return 0;
  }
  return 1;
}

int32_t scriptc_ts7_read(uint32_t handle, uint8_t *bytes, size_t size,
                        uint32_t offset, uint32_t length) {
  Ts7Process *p = find_process(handle);
  if (p == NULL || !valid_range(bytes, size, offset, length)) return -1;
  if (length == 0) return 0;
  if (length > INT32_MAX) length = INT32_MAX;
#ifdef _WIN32
  DWORD count = 0;
  if (ReadFile(p->output, bytes + offset, length, &count, NULL)) return (int32_t)count;
  DWORD code = GetLastError();
  if (code == ERROR_BROKEN_PIPE) return 0;
  system_error(code); return -1;
#else
  ssize_t count;
  do { count = recv(p->socket, bytes + offset, length, 0); } while (count < 0 && errno == EINTR);
  if (count < 0) { system_error(errno); return -1; }
  return (int32_t)count;
#endif
}

int32_t scriptc_ts7_write(uint32_t handle, const uint8_t *bytes, size_t size,
                         uint32_t offset, uint32_t length) {
  Ts7Process *p = find_process(handle);
  if (p == NULL || !valid_range(bytes, size, offset, length)) return -1;
  if (length == 0) return 0;
  if (length > INT32_MAX) length = INT32_MAX;
#ifdef _WIN32
  DWORD count = 0;
  if (WriteFile(p->input, bytes + offset, length, &count, NULL)) return (int32_t)count;
  system_error(GetLastError()); return -1;
#else
  int flags = 0;
#ifdef MSG_NOSIGNAL
  flags = MSG_NOSIGNAL;
#endif
  ssize_t count;
  do { count = send(p->socket, bytes + offset, length, flags); } while (count < 0 && errno == EINTR);
  if (count < 0) { system_error(errno); return -1; }
  return (int32_t)count;
#endif
}

void scriptc_ts7_close(uint32_t handle) {
  Ts7Process **link = &processes;
  while (*link != NULL && (*link)->id != handle) link = &(*link)->next;
  if (*link == NULL) return;
  Ts7Process *p = *link;
  *link = p->next;
  stop_process(p);
  free(p);
}

void scriptc_ts7_close_all(void) {
  while (processes != NULL) scriptc_ts7_close(processes->id);
}

static int json_space(uint8_t byte) {
  return byte == ' ' || byte == '\n' || byte == '\r' || byte == '\t';
}

int32_t scriptc_ts7_json_value_end(const uint8_t *bytes, size_t size, uint32_t start) {
  if (size > INT32_MAX) return -1;
  size_t depth = 0;
  size_t index = start;
  while (index < size) {
    uint8_t byte = bytes[index];
    if (byte == '"') {
      index++;
      // The quote found stays the candidate end until an escape skips it, so
      // every byte of the string is scanned once by each search.
      const uint8_t *quote = index < size ? memchr(bytes + index, '"', size - index) : NULL;
      for (;;) {
        if (quote == NULL) return -1;
        const uint8_t *escape = memchr(bytes + index, '\\', (size_t)(quote - (bytes + index)));
        if (escape == NULL) {
          index = (size_t)(quote - bytes);
          break;
        }
        index = (size_t)(escape - bytes) + 2;
        if (bytes + index > quote) quote = index < size ? memchr(bytes + index, '"', size - index) : NULL;
      }
      index++;
      if (depth == 0) return (int32_t)index;
      continue;
    }
    if (byte == '{' || byte == '[') {
      depth++;
    } else if (byte == '}' || byte == ']') {
      if (depth == 0) return (int32_t)index;
      depth--;
      if (depth == 0) return (int32_t)(index + 1);
    } else if (depth == 0 && (byte == ',' || json_space(byte))) {
      return (int32_t)index;
    }
    index++;
  }
  if (depth != 0) return -1;
  return (int32_t)index;
}
