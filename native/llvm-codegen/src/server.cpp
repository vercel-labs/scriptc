#include "server.h"

#include "diagnostics.h"

#include "llvm/ADT/StringRef.h"
#include "llvm/Support/raw_ostream.h"

#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

using namespace llvm;

namespace {

/* A session carries requests on one connection, and a request carries one
 * command line and the directory it runs in, so the protocol is a header the
 * client and the server both spell out here. Lengths keep paths and arguments
 * intact without escaping. */
constexpr const char *Protocol = "SCGEN1";

bool writeAll(int Fd, const char *Data, size_t Size) {
  while (Size > 0) {
    ssize_t Written = write(Fd, Data, Size);
    if (Written < 0 && errno == EINTR) continue;
    if (Written <= 0) return false;
    Data += Written;
    Size -= static_cast<size_t>(Written);
  }
  return true;
}

bool readAll(int Fd, char *Data, size_t Size) {
  while (Size > 0) {
    ssize_t Read = read(Fd, Data, Size);
    if (Read < 0 && errno == EINTR) continue;
    if (Read <= 0) return false;
    Data += Read;
    Size -= static_cast<size_t>(Read);
  }
  return true;
}

/** One `\n`-terminated line without its terminator, or false at end of
 * stream. A line longer than any request field ends the session. */
bool readLine(int Fd, std::string &Line) {
  Line.clear();
  for (;;) {
    char Byte = 0;
    ssize_t Read = read(Fd, &Byte, 1);
    if (Read < 0 && errno == EINTR) continue;
    if (Read <= 0) return false;
    if (Byte == '\n') return true;
    if (Line.size() > (1u << 20)) return false;
    Line.push_back(Byte);
  }
}

/** Everything a command printed, read back after it returns. */
struct Captured {
  std::string Out;
  std::string Err;
  int Code = -1;
};

void drain(FILE *File, std::string &Into) {
  if (File == nullptr) return;
  fflush(File);
  int Fd = fileno(File);
  if (lseek(Fd, 0, SEEK_SET) == static_cast<off_t>(-1)) return;
  char Buffer[8192];
  for (;;) {
    ssize_t Read = read(Fd, Buffer, sizeof(Buffer));
    if (Read < 0 && errno == EINTR) continue;
    if (Read <= 0) return;
    Into.append(Buffer, static_cast<size_t>(Read));
  }
}

/** Runs one command in the requesting build's working directory with its
 * standard streams captured, since a command's input and output paths and
 * the debug information it writes are relative to that directory. A capture
 * that cannot be set up returns false and the client falls back to its
 * one-shot path. */
bool runCaptured(const std::string &Cwd, std::vector<std::string> &Args,
                 Captured &Result) {
  FILE *OutFile = tmpfile();
  FILE *ErrFile = tmpfile();
  if (OutFile == nullptr || ErrFile == nullptr) {
    if (OutFile != nullptr) fclose(OutFile);
    if (ErrFile != nullptr) fclose(ErrFile);
    return false;
  }
  // Buffered output belongs to the streams before they are redirected.
  outs().flush();
  errs().flush();
  // A request carries the arguments an invocation would carry after the
  // program name, which every command parser expects in front.
  Args.insert(Args.begin(), "scriptc-llvm-codegen");
  std::vector<char *> Argv;
  Argv.reserve(Args.size());
  for (std::string &Arg : Args) Argv.push_back(Arg.data());
  Argv.push_back(nullptr);
  int SavedOut = dup(STDOUT_FILENO);
  int SavedErr = dup(STDERR_FILENO);
  if (SavedOut < 0 || SavedErr < 0 ||
      dup2(fileno(OutFile), STDOUT_FILENO) < 0 ||
      dup2(fileno(ErrFile), STDERR_FILENO) < 0) {
    if (SavedOut >= 0) close(SavedOut);
    if (SavedErr >= 0) close(SavedErr);
    fclose(OutFile);
    fclose(ErrFile);
    return false;
  }
  // Relative input and output paths and the debug information a command
  // writes are relative to the requesting build's directory.
  int PreviousDir = open(".", O_RDONLY);
  if (PreviousDir < 0 || (!Cwd.empty() && chdir(Cwd.c_str()) != 0)) {
    if (PreviousDir >= 0) close(PreviousDir);
    dup2(SavedOut, STDOUT_FILENO);
    dup2(SavedErr, STDERR_FILENO);
    close(SavedOut);
    close(SavedErr);
    fclose(OutFile);
    fclose(ErrFile);
    return false;
  }
  Result.Code =
      scriptc::runCommand(static_cast<int>(Args.size()), Argv.data());
  fchdir(PreviousDir);
  close(PreviousDir);
  outs().flush();
  errs().flush();
  dup2(SavedOut, STDOUT_FILENO);
  dup2(SavedErr, STDERR_FILENO);
  close(SavedOut);
  close(SavedErr);
  drain(OutFile, Result.Out);
  drain(ErrFile, Result.Err);
  fclose(OutFile);
  fclose(ErrFile);
  return true;
}

bool parseCount(StringRef Text, size_t &Value) {
  if (Text.empty() || Text.size() > 12) return false;
  size_t Parsed = 0;
  for (char Byte : Text) {
    if (Byte < '0' || Byte > '9') return false;
    Parsed = Parsed * 10 + static_cast<size_t>(Byte - '0');
  }
  Value = Parsed;
  return true;
}

/** One request: the protocol, the argument count and the working directory's
 * byte length, the directory, then each argument's byte length and bytes.
 * Returns false at the end of the session. */
bool readRequest(int Fd, std::string &Cwd, std::vector<std::string> &Args) {
  std::string Header;
  if (!readLine(Fd, Header)) return false;
  StringRef Fields(Header);
  if (!Fields.consume_front(Protocol) || !Fields.consume_front(" "))
    return false;
  size_t Space = Fields.find(' ');
  size_t Count = 0;
  size_t CwdLength = 0;
  if (Space == StringRef::npos || !parseCount(Fields.slice(0, Space), Count) ||
      !parseCount(Fields.drop_front(Space + 1), CwdLength))
    return false;
  if (Count == 0 || Count > 4096 || CwdLength > 4096) return false;
  Cwd.resize(CwdLength);
  if (CwdLength != 0 && !readAll(Fd, Cwd.data(), CwdLength)) return false;
  Args.clear();
  Args.reserve(Count);
  for (size_t Index = 0; Index < Count; ++Index) {
    std::string LengthText;
    if (!readLine(Fd, LengthText)) return false;
    size_t Length = 0;
    if (!parseCount(LengthText, Length)) return false;
    std::string Arg;
    Arg.resize(Length);
    if (Length != 0 && !readAll(Fd, Arg.data(), Length)) return false;
    Args.push_back(std::move(Arg));
  }
  return true;
}

/** Answers one request and writes its captured output back. */
void serveOne(int Fd, const std::string &Cwd, std::vector<std::string> &Args) {
  Captured Result;
  if (!runCaptured(Cwd, Args, Result)) {
    Result.Code = 70;  // EX_SOFTWARE: the capture itself failed.
    Result.Out.clear();
    Result.Err = "{\"code\":\"capture_failed\",\"message\":\"the codegen server "
                 "could not capture the command's output\"}\n";
  }
  std::string Header = std::string(Protocol) + " " + std::to_string(Result.Code) +
                       " " + std::to_string(Result.Out.size()) + " " +
                       std::to_string(Result.Err.size()) + "\n";
  if (!writeAll(Fd, Header.data(), Header.size())) return;
  if (!Result.Out.empty() && !writeAll(Fd, Result.Out.data(), Result.Out.size()))
    return;
  if (!Result.Err.empty())
    writeAll(Fd, Result.Err.data(), Result.Err.size());
}

/** Serves every request on one connection. A disconnect ends the session. */
void serveSession(int Fd) {
  std::string Cwd;
  std::vector<std::string> Args;
  while (readRequest(Fd, Cwd, Args)) serveOne(Fd, Cwd, Args);
}

} // namespace

namespace scriptc {

int serve(int Argc, char **Argv) {
  StringRef SocketPath;
  long IdleSeconds = 600;
  for (int Index = 2; Index < Argc; ++Index) {
    StringRef Arg(Argv[Index]);
    if (Arg == "--socket" && Index + 1 < Argc) {
      SocketPath = Argv[++Index];
    } else if (Arg.consume_front("--socket=")) {
      SocketPath = Arg;
    } else if (Arg == "--idle-exit" && Index + 1 < Argc) {
      IdleSeconds = strtol(Argv[++Index], nullptr, 10);
    } else if (Arg.consume_front("--idle-exit=")) {
      IdleSeconds = strtol(Arg.str().c_str(), nullptr, 10);
    } else {
      return reportError("usage",
                         "serve accepts --socket <path> --idle-exit <seconds>");
    }
  }
  if (SocketPath.empty())
    return reportError("usage", "serve requires --socket <path>");
  if (IdleSeconds < 0) IdleSeconds = 0;
  if (SocketPath.size() >= sizeof(sockaddr_un::sun_path) - 1)
    return reportError("socket_path_too_long",
                       "the server socket path is too long for this host");
  // A client that disconnects mid-response leaves a broken pipe.
  signal(SIGPIPE, SIG_IGN);
  sockaddr_un Address{};
  Address.sun_family = AF_UNIX;
  memcpy(Address.sun_path, SocketPath.data(), SocketPath.size());
  int Listener = socket(AF_UNIX, SOCK_STREAM, 0);
  if (Listener < 0)
    return reportError("socket_failed", StringRef(strerror(errno)));
  // Only this user's builds may reach the server that holds their sources.
  mode_t Mask = umask(077);
  unlink(Address.sun_path);
  int Bound = bind(Listener, reinterpret_cast<sockaddr *>(&Address),
                   sizeof(Address));
  int BindError = errno;
  umask(Mask);
  if (Bound != 0) {
    close(Listener);
    return reportError("bind_failed", StringRef(strerror(BindError)));
  }
  if (listen(Listener, 8) != 0) {
    int ListenError = errno;
    close(Listener);
    unlink(Address.sun_path);
    return reportError("listen_failed", StringRef(strerror(ListenError)));
  }
  const long long IdleMilliseconds = static_cast<long long>(IdleSeconds) * 1000;
  for (;;) {
    pollfd Pending{Listener, POLLIN, 0};
    int Ready = poll(&Pending, 1, static_cast<int>(IdleMilliseconds));
    if (Ready < 0 && errno == EINTR) continue;
    // No client for `--idle-exit` seconds: the next build starts its own.
    if (Ready == 0) break;
    if (Ready < 0) break;
    int Client = accept(Listener, nullptr, nullptr);
    if (Client < 0) {
      if (errno == EINTR || errno == ECONNABORTED) continue;
      break;
    }
    serveSession(Client);
    close(Client);
  }
  close(Listener);
  unlink(Address.sun_path);
  return 0;
}

} // namespace scriptc
