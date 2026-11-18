// child_process.execFile's env, timeout and killSignal members: env REPLACES
// the child environment (an undefined value drops the variable), a child
// still running at an unsigned-integer deadline has its capture streams
// destroyed and takes killSignal (a name matched without case, SIGTERM when
// absent), and the callback reports the exit's own status with killed set.
// An out-of-range timeout throws before any spawn (an unknown signal name is
// a compile-time fence instead, as for spawnSync).
import { execFile } from "node:child_process";

interface ExecError extends Error {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
}

function line(tag: string, error: Error | null, stdout: string, stderr: string): void {
  const e = error as ExecError | null;
  console.log(
    tag,
    JSON.stringify({
      name: e === null ? null : e.name,
      code: e === null ? null : (e.code ?? null),
      killed: e === null ? null : (e.killed ?? null),
      signal: e === null ? null : (e.signal ?? null),
      message: e === null ? null : e.message,
      stdout,
      stderr,
    }),
  );
}

function thrown(tag: string, call: () => void): void {
  try {
    call();
    console.log(tag, "no throw");
  } catch (e) {
    const err = e as ExecError;
    console.log(tag, err.name, err.code ?? null, JSON.stringify(err.message));
  }
}

console.log("scheduled");

// Node validates the timeout before the signal and before spawning.
thrown("timeout-negative", () => {
  execFile("/bin/sh", ["-c", "true"], { timeout: -1 }, () => {});
});
thrown("timeout-fractional", () => {
  execFile("/bin/sh", ["-c", "true"], { timeout: 1.5 }, () => {});
});
thrown("timeout-nan", () => {
  execFile("/bin/sh", ["-c", "true"], { timeout: NaN }, () => {});
});
thrown("timeout-infinite", () => {
  execFile("/bin/sh", ["-c", "true"], { timeout: Infinity }, () => {});
});

// The environment is replaced wholesale; the undefined value is dropped and
// the parent's HOME does not reach the child.
execFile(
  "/bin/sh",
  ["-c", 'printf "%s|%s" "$FOO" "${HOME-unset}"'],
  { env: { FOO: "replaced", DROPPED: undefined } },
  (error, stdout, stderr) => {
    line("env", error, stdout, stderr);
    // A deadline the child beats: a valid timeout is not an error.
    execFile("/bin/sh", ["-c", "printf ok"], { timeout: 5000 }, (okErr, okOut, okErrOut) => {
      line("beats-deadline", okErr, okOut, okErrOut);
      // The deadline: SIGTERM by default, killed set, no exit code.
      execFile("/bin/sh", ["-c", "sleep 5"], { timeout: 60 }, (termErr, termOut, termErrOut) => {
        line("sigterm", termErr, termOut, termErrOut);
        // A signal name matches case-insensitively, and SIGKILL reaches a
        // child that ignores TERM.
        execFile(
          "/bin/sh",
          ["-c", "trap '' TERM; sleep 5"],
          { timeout: 60, killSignal: "sigkill" },
          (killErr, killOut, killErrOut) => {
            line("sigkill", killErr, killOut, killErrOut);
            // A named upper-case signal keeps working alongside.
            execFile(
              "/bin/sh",
              ["-c", "sleep 5"],
              { timeout: 60, killSignal: "SIGKILL" },
              (upperErr, upperOut, upperErrOut) => {
                line("sigkill-upper", upperErr, upperOut, upperErrOut);
              },
            );
          },
        );
      });
    });
  },
);
