#pragma once

namespace scriptc {

/** Runs one request the one-shot command line would run, with stdout and
 * stderr captured by the caller. `Argv[0]` is the program name, so a request
 * carries the same arguments as an ordinary invocation. */
int runCommand(int Argc, char **Argv);

/** Serves `runCommand` requests on a Unix socket until no client connects for
 * `--idle-exit` seconds. Each connection carries its own requests; a client
 * that disconnects ends its session, not the server. */
int serve(int Argc, char **Argv);

} // namespace scriptc
