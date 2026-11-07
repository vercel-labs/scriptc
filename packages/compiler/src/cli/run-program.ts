/* How `scriptc run` runs the program it built. The Node-hosted CLI, its bootstrap's cached route
 * and the native CLI all run it this way, so the three agree on what the caller sees. */
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { isatty } from "node:tty";

/** The number of a signal, by name; 0 for a name this platform does not have. */
function signalNumber(name: string): number {
  return (constants.signals as Record<string, number | undefined>)[name] ?? 0;
}

/** Runs `file` with `args` and this process's stdio, and resolves to the exit status scriptc ends
 * with: the program's own, or 128 plus the signal's number when a signal killed the program,
 * which is what a shell reports for a program it ran directly.
 *
 * A signal that asks scriptc to stop (SIGINT, SIGTERM, SIGHUP) goes to the program instead, so
 * stopping `scriptc run` stops the program, and scriptc then ends with the program's status. A
 * program that dies of any other signal is named on stderr, since nobody asked for that.
 *
 * The one exception is SIGINT while a standard stream is a terminal. The terminal's interrupt
 * key signals every process of the foreground group, the program included, and Node cannot tell
 * that delivery from a SIGINT another process sent to scriptc alone. Handing every SIGINT on
 * would give the program each interrupt key twice, which ends a program that treats the second
 * one as "quit now"; so with a terminal no SIGINT is handed on, and one sent to scriptc alone
 * stops nothing. SIGTERM is always handed on. (Without the listener that SIGINT would end
 * scriptc and leave the program running.)
 *
 * `startFailure` words the error for a program that could not be started. */
export function runProgram(
  file: string,
  args: readonly string[],
  startFailure: (message: string) => string = (message) => `could not run ${file}: ${message}`,
): Promise<number> {
  return new Promise<number>((resolveExit) => {
    // A terminal sends its interrupt to every process in the foreground group, so the program
    // already has that one. Without a terminal a SIGINT reached scriptc alone and is handed on.
    const interruptIsShared = isatty(0) || isatty(1) || isatty(2);
    const asked: string[] = [];
    let child: ChildProcess | null = null;
    const onInterrupt = (): void => {
      asked.push("SIGINT");
      if (!interruptIsShared) child?.kill("SIGINT");
    };
    const onTerminate = (): void => {
      asked.push("SIGTERM");
      child?.kill("SIGTERM");
    };
    const onHangup = (): void => {
      asked.push("SIGHUP");
      child?.kill("SIGHUP");
    };
    // Listen before the program starts: once it runs, a caller that waits for its first output
    // can signal scriptc at any moment, and without a listener the signal ends scriptc alone.
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    process.on("SIGHUP", onHangup);
    let finished = false;
    const finish = (status: number): void => {
      if (finished) return;
      finished = true;
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      process.off("SIGHUP", onHangup);
      resolveExit(status);
    };
    const started = spawn(file, args, { stdio: "inherit" });
    child = started;
    started.on("error", (error) => {
      process.stderr.write(`scriptc: ${startFailure(error.message)}\n`);
      finish(1);
    });
    started.on("exit", (code, signal) => {
      if (signal === null) {
        finish(code ?? 0);
        return;
      }
      if (!asked.includes(signal)) process.stderr.write(`scriptc: program killed by ${signal}\n`);
      finish(128 + signalNumber(signal));
    });
  });
}
