// child_process.spawn's timeout and killSignal: the launch checks run
// before any process starts (validateTimeout's ERR_OUT_OF_RANGE; then
// sanitizeKillSignal, which takes a signal name in any case or a signal
// number and refuses everything else), and a positive timeout kills the
// child with killSignal — SIGTERM without one — leaving its stdio alone.
// Absent, 0 and an undefined-typed value arm no timer.
import { spawn, type ChildProcess } from "node:child_process";

interface SpawnError extends Error {
  code?: string;
}

function thrown(tag: string, call: () => void): void {
  try {
    call();
    console.log(tag, "no throw");
  } catch (e) {
    const err = e as SpawnError;
    console.log(tag, err.name, err.code ?? null, JSON.stringify(err.message));
  }
}

function wait(tag: string, child: ChildProcess, next: () => void): void {
  child.on("error", (e) => console.log(tag, "error", e.name));
  child.on("close", (code, signal) => {
    console.log(tag, code, signal);
    next();
  });
}

const sleeper = ["-c", "sleep 5"];

console.log("scheduled");

thrown("negative", () => spawn("/bin/sh", sleeper, { timeout: -1 }));
thrown("fractional", () => spawn("/bin/sh", sleeper, { timeout: 1.5 }));
thrown("nan", () => spawn("/bin/sh", sleeper, { timeout: NaN }));
thrown("infinite", () => spawn("/bin/sh", sleeper, { timeout: Infinity }));
thrown("unknown-name", () => spawn("/bin/sh", sleeper, { killSignal: "SIGBOGUS" }));
thrown("unknown-number", () => spawn("/bin/sh", sleeper, { killSignal: 0 }));
thrown("string-number", () => spawn("/bin/sh", sleeper, { killSignal: "9" }));

wait("default", spawn("/bin/sh", sleeper, { stdio: "ignore", timeout: 120 }), () => {
  wait(
    "sigkill",
    spawn("/bin/sh", sleeper, { stdio: "ignore", timeout: 120, killSignal: "SIGKILL" }),
    () => {
      wait(
        "numeric",
        spawn("/bin/sh", sleeper, { stdio: "ignore", timeout: 120, killSignal: 9 }),
        () => {
          wait(
            "lower",
            spawn("/bin/sh", sleeper, { stdio: "ignore", timeout: 120, killSignal: "sigterm" }),
            () => {
              wait(
                "no-timeout",
                spawn("/bin/sh", ["-c", "exit 3"], { stdio: "ignore", killSignal: "SIGKILL" }),
                () => {
                  wait(
                    "zero",
                    spawn("/bin/sh", ["-c", "exit 3"], { stdio: "ignore", timeout: 0 }),
                    () => {
                      const absent: number | undefined = undefined;
                      wait(
                        "union-absent",
                        spawn("/bin/sh", ["-c", "exit 3"], { stdio: "ignore", timeout: absent }),
                        () => {
                          const present: number | undefined = 120;
                          wait(
                            "union-present",
                            spawn("/bin/sh", sleeper, { stdio: "ignore", timeout: present }),
                            () => {
                              console.log("done");
                            },
                          );
                        },
                      );
                    },
                  );
                },
              );
            },
          );
        },
      );
    },
  );
});
