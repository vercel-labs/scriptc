#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
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
#include <sys/socket.h>
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
  wchar_t *wide[6] = {0};
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
    p->socket = sockets[0]; p->pid = (uint32_t)pid;
  }
done:
  close(sockets[1]);
  if (error != 0) { close(sockets[0]); system_error(error); }
  return error == 0;
}

static void stop_process(Ts7Process *p) {
  close(p->socket);
  int status;
  pid_t pid = (pid_t)p->pid;
  for (int attempt = 0; attempt < 5; attempt++) {
    pid_t result;
    do { result = waitpid(pid, &status, WNOHANG); } while (result < 0 && errno == EINTR);
    // ECHILD also means the PID no longer belongs to us. Never signal a
    // potentially recycled PID after somebody else has reaped the child.
    if (result == pid || (result < 0 && errno == ECHILD)) return;
    struct timespec delay = {0, 10000000};
    while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {}
  }
  (void)kill(pid, SIGKILL);
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
}
#endif

uint32_t scriptc_ts7_open(const uint8_t *executable, size_t executable_size,
                         const uint8_t *cwd, size_t cwd_size,
                         const uint8_t *callbacks, size_t callbacks_size,
                         uint8_t timing) {
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
  char *args[] = {exe, "--api", "--cwd", directory, callback_flag, timing ? "--timing" : NULL, NULL};
  int started = start_process(p, args, timing ? 6 : 5);
  free(exe); free(directory); free(callback_flag);
  if (!started) { free(p); return 0; }
  p->id = next_id++;
  p->next = processes;
  processes = p;
  return p->id;
}

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
      for (;;) {
        if (index >= size) return -1;
        const uint8_t *quote = memchr(bytes + index, '"', size - index);
        if (quote == NULL) return -1;
        const uint8_t *escape = memchr(bytes + index, '\\', (size_t)(quote - (bytes + index)));
        if (escape == NULL) {
          index = (size_t)(quote - bytes);
          break;
        }
        index = (size_t)(escape - bytes) + 2;
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
