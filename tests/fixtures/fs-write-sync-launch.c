#include <fcntl.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

static int child_status(int status) {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 125;
}

int main(int argc, char **argv) {
  if (argc < 3) return 126;

  if (strcmp(argv[1], "rlimit") == 0) {
    struct rlimit limit = {512, 512};
    if (setrlimit(RLIMIT_FSIZE, &limit) != 0) return 124;
    execv(argv[2], argv + 2);
    return 123;
  }

  if (strcmp(argv[1], "nonblock") == 0) {
    int fds[2];
    if (pipe(fds) != 0) return 122;
    int flags = fcntl(fds[1], F_GETFL);
    if (flags < 0 || fcntl(fds[1], F_SETFL, flags | O_NONBLOCK) != 0) return 121;

    pid_t pid = fork();
    if (pid < 0) return 120;
    if (pid == 0) {
      close(fds[0]);
      if (dup2(fds[1], STDOUT_FILENO) < 0) _exit(119);
      close(fds[1]);
      execv(argv[2], argv + 2);
      _exit(118);
    }

    close(fds[1]);
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) return 117;
    close(fds[0]);
    return child_status(status);
  }

  return 116;
}
