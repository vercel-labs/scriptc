import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ts7Wire, type Ts7WireIo } from "./rpc-wire.js";
import { ensureExecutable } from "../../executable-mode.js";

// Node's public spawn API does not expose synchronous pipe descriptors, so
// the server's end of the channel is a named pipe on Windows and a FIFO pair
// elsewhere, both opened with openSync. Keep this host-specific boundary out
// of the statically compiled protocol.

const liveTransports = new Set<Ts7WireIo>();
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function closeLiveTransports(): void {
  for (const transport of liveTransports) transport.close();
}

function track(transport: Ts7WireIo): void {
  if (liveTransports.size === 0) process.on("exit", closeLiveTransports);
  liveTransports.add(transport);
}

function untrack(transport: Ts7WireIo): void {
  liveTransports.delete(transport);
  if (liveTransports.size === 0) process.removeListener("exit", closeLiveTransports);
}

/** A synchronous read or write that retries an interrupted call and waits
 * out a full pipe. */
function transfer(
  operation: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) => number,
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
): number {
  for (;;) {
    try {
      return operation(fd, buffer, offset, length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EINTR") continue;
      if (code !== "EAGAIN") throw error;
      Atomics.wait(sleepBuffer, 0, 0, 1);
    }
  }
}

/** Windows: the server is a child process that creates a named pipe
 * (`--pipe`), which this process opens. Windows has no zombie processes; the
 * child's handle closes with the process. */
class Ts7NamedPipeIo implements Ts7WireIo {
  private readonly child: ChildProcess;
  private pipeFd = -1;
  private closed = false;
  private spawnError: Error | undefined;

  constructor(executable: string, args: string[]) {
    const pipe = `\\\\.\\pipe\\scriptc-ts7-${process.pid}-${randomUUID()}`;
    this.child = spawn(executable, [...args, "--pipe", pipe], {
      stdio: ["ignore", "ignore", "inherit"],
      windowsHide: true,
    });
    // A failed spawn emits asynchronously even when the connection below has
    // already thrown. Always consume that event.
    this.child.on("error", (error: Error) => {
      this.spawnError = error;
    });
    try {
      if (this.child.pid === undefined)
        throw new Error(`Unable to start TypeScript server: ${executable}`);
      for (let attempt = 0; attempt < 500; attempt++) {
        try {
          this.pipeFd = openSync(pipe, "r+");
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "EBUSY") throw error;
          Atomics.wait(sleepBuffer, 0, 0, 10);
        }
      }
      if (this.pipeFd === -1)
        throw new Error("TypeScript server: timed out connecting to named pipe");
      this.child.unref();
      track(this);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  read = (buffer: Uint8Array, offset: number, length: number): number => {
    if (this.spawnError) throw this.spawnError;
    if (this.closed) throw new Error("TypeScript server transport is closed");
    return transfer(readSync, this.pipeFd, buffer, offset, length);
  };

  write = (buffer: Uint8Array, offset: number, length: number): number => {
    if (this.spawnError) throw this.spawnError;
    if (this.closed) throw new Error("TypeScript server transport is closed");
    return transfer(writeSync, this.pipeFd, buffer, offset, length);
  };

  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    untrack(this);
    if (this.pipeFd !== -1) {
      try {
        closeSync(this.pipeFd);
      } catch {
        /* still end the child */
      }
      this.pipeFd = -1;
    }
    // The channel is closed and all its work is discarded. SIGTERM invokes
    // tsgo's cancellation handler, which can race EOF and print "context
    // canceled" into an otherwise successful compile's stderr.
    if (this.child.pid !== undefined) this.child.kill("SIGKILL");
  };
}

/* POSIX: the server is not this process's child. A shell that spawnSync runs
 * and reaps creates the FIFOs, starts a lifetime supervisor in the background
 * and exits; the supervisor starts the server with its standard input and
 * output on the FIFOs, prints its PID, and stays the server's parent. A child
 * of this process would stay a zombie after it exits: Node reaps children only
 * from its event loop, which a synchronous compile never returns to. The
 * supervisor points its standard input and output at /dev/null before it opens
 * the FIFOs, so spawnSync's output pipe closes as soon as the launcher exits,
 * while its standard error stays connected so the server's startup and crash
 * diagnostics reach this process. A missing or non-executable server fails
 * here, before any FIFO exists: the supervisor would otherwise block opening
 * its input and the failure would only surface as end of file on the first
 * read.
 *
 * The supervisor is a Node process rather than a subshell so its ownership of
 * the server's PID does not depend on the shell's reaping rules: it blocks in
 * a synchronous read of the lifetime pipe, and while the event loop is blocked
 * it cannot reap the server. A server that exits stays a zombie the supervisor
 * owns, so its PID cannot be reused before the supervisor kills it; the kill
 * can only ever reach that server (or its zombie, where it does nothing). */
const FIFO_SUPERVISOR_SOURCE = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [input, output, life, pidPath, executable, ...args] = process.argv.slice(2);
const child = spawn(
  "/bin/sh",
  ["-c", 'exec "$@" <"$SCRIPTC_TS7_IN" >"$SCRIPTC_TS7_OUT"', "sh", executable, ...args],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, SCRIPTC_TS7_IN: input, SCRIPTC_TS7_OUT: output },
  },
);
fs.writeFileSync(pidPath, String(child.pid));
const lifeFd = fs.openSync(life, "r");
const scratch = Buffer.alloc(64);
for (;;) {
  let read;
  try {
    read = fs.readSync(lifeFd, scratch, 0, scratch.length, null);
  } catch (error) {
    if (error.code === "EINTR" || error.code === "EAGAIN") continue;
    throw error;
  }
  if (read === 0) break;
}
child.kill("SIGKILL");
process.exit(0);
`;
const FIFO_SUPERVISOR = Buffer.from(FIFO_SUPERVISOR_SOURCE).toString("base64");

const FIFO_LAUNCH = [
  'i=$1 o=$2 l=$3 p=$4; shift 4; command -v "$1" >/dev/null || exit 127; ',
  'mkfifo -m 600 "$i" "$o" "$l" "$p" || exit 1; ',
  // The supervisor blocks until the lifetime pipe's writer closes (this
  // process's close, any exit path, or its death closing the descriptor),
  // then kills its own child, which it has never reaped.
  `"${process.execPath}" -e 'eval(Buffer.from(process.argv[1],"base64").toString("utf8"))' '${FIFO_SUPERVISOR}' "$i" "$o" "$l" "$p" "$@" </dev/null >/dev/null & `,
  'read -r s <"$p"; echo "$s"',
].join("");

/** How long a starting server may take to open its input, in milliseconds. */
const FIFO_OPEN_TIMEOUT = 10_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class Ts7FifoIo implements Ts7WireIo {
  private readFd = -1;
  private writeFd = -1;
  /** The lifetime pipe's writer: the server's parent kills and reaps it when
   * this end closes, which happens on close(), on any exit path, and when
   * the process dies (its descriptors close with it). */
  private lifeFd = -1;
  private closed = false;
  /** The server's process ID, for tests: this process never signals it. */
  readonly pid: number;

  constructor(executable: string, args: string[]) {
    const directory = mkdtempSync(join(tmpdir(), "scriptc-ts7-"));
    const input = join(directory, "in");
    const output = join(directory, "out");
    const life = join(directory, "life");
    const pidPipe = join(directory, "pid");
    try {
      const shell = spawnSync(
        "/bin/sh",
        ["-c", FIFO_LAUNCH, "sh", input, output, life, pidPipe, executable, ...args],
        { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" },
      );
      const pid = Number(shell.stdout?.trim());
      if (shell.status !== 0 || !Number.isSafeInteger(pid) || pid <= 0)
        throw new Error(`Unable to start TypeScript server: ${executable}`);
      this.pid = pid;
      // The server's parent blocks opening its end, so this returns once it
      // is watching; closing this descriptor is the stop signal.
      this.lifeFd = openSync(life, "w");
      // A non-blocking open fails with ENXIO until the server opens its end,
      // so a server that exits as it starts cannot block this process.
      let probe = -1;
      for (let waited = 0; probe < 0; waited++) {
        try {
          probe = openSync(input, constants.O_WRONLY | constants.O_NONBLOCK);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
          if (waited >= FIFO_OPEN_TIMEOUT || !processAlive(pid))
            throw new Error(`Unable to start TypeScript server: ${executable}`);
          Atomics.wait(sleepBuffer, 0, 0, 1);
        }
      }
      try {
        // The server reads now, so a blocking open returns at once.
        this.writeFd = openSync(input, "w");
      } finally {
        closeSync(probe);
      }
      // The server's shell opens its output right after its input.
      this.readFd = openSync(output, "r");
      track(this);
    } catch (error) {
      this.close();
      throw error;
    } finally {
      // Both ends are open, or the start failed: the names are not needed.
      rmSync(directory, { recursive: true, force: true });
    }
  }

  read = (buffer: Uint8Array, offset: number, length: number): number => {
    if (this.closed) throw new Error("TypeScript server transport is closed");
    return transfer(readSync, this.readFd, buffer, offset, length);
  };

  write = (buffer: Uint8Array, offset: number, length: number): number => {
    if (this.closed) throw new Error("TypeScript server transport is closed");
    return transfer(writeSync, this.writeFd, buffer, offset, length);
  };

  /** Closing both FIFOs ends the session: the server reads end of file on
   * its input and exits, and a write to its closed output ends it with
   * SIGPIPE. A server that does not exit when its input closes is killed by
   * the lifetime supervisor, which is its parent; the supervisor never reaps
   * it while it blocks, so the signal cannot reach another process. */
  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    untrack(this);
    // Closing the lifetime pipe makes the server's parent kill it; closing
    // the data pipes also ends a server that watches its input.
    for (const fd of [this.lifeFd, this.writeFd, this.readFd]) {
      if (fd === -1) continue;
      try {
        closeSync(fd);
      } catch {
        /* close the other end too */
      }
    }
    this.writeFd = -1;
    this.readFd = -1;
    this.lifeFd = -1;
  };
}

export function spawnTs7Wire(executable: string, args: string[]): Ts7Wire {
  ensureExecutable(executable);
  return new Ts7Wire(
    process.platform === "win32"
      ? new Ts7NamedPipeIo(executable, args)
      : new Ts7FifoIo(executable, args),
  );
}
