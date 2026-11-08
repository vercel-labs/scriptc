// A kiln's firing log. Every step is a child started through the callback
// form of execFile or exec with the options that involve the environment,
// a timer or an AbortSignal: env, timeout, killSignal, signal, alone and
// together, beside cwd and maxBuffer. Each step prints what the callback's
// error holds (name, code, killed, signal, cmd, message, cause), the captured
// output and the child's 'exit' event; the steps run one after another, so
// the log has one order.
import { exec, execFile } from "node:child_process";

function fields(e: unknown): string {
  if (e === null) return "ok";
  const failure = e as Error & {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    cmd?: unknown;
    cause?: unknown;
  };
  const cause =
    failure.cause instanceof Error
      ? failure.cause.name + ":" + failure.cause.message
      : String(failure.cause);
  return [
    failure.name,
    String(failure.code),
    String(failure.killed),
    String(failure.signal),
    String(failure.cmd),
    JSON.stringify(failure.message),
    cause,
  ].join(" / ");
}

function note<T>(label: string, value: T): T {
  console.log("evaluated", label);
  return value;
}

const steps: Array<(done: () => void) => void> = [];
function step(label: string, run: (done: () => void) => void): void {
  steps.push((done) => {
    console.log("--", label);
    run(done);
  });
}
function fire(at: number): void {
  const next = steps[at];
  if (next === undefined) {
    console.log("kiln cold");
    return;
  }
  next(() => fire(at + 1));
}

const few = process.argv.length < 9;
const stubborn = "trap '' TERM; exec sleep 5";

step("env replaces the environment", (done) => {
  execFile(
    "/bin/sh",
    ["-c", 'printf "%s|%s" "$GLAZE" "${KILN_UNSET:-none}"'],
    { env: { GLAZE: "celadon", PATH: "/usr/bin:/bin" } },
    (error, stdout, stderr) => {
      console.log(fields(error), JSON.stringify(stdout), JSON.stringify(stderr));
      done();
    },
  );
});

step("env spread over the parent's, with cwd", (done) => {
  execFile(
    "/bin/sh",
    ["-c", 'printf "%s|%s" "$PWD" "$GLAZE"'],
    { cwd: "/", env: { ...process.env, GLAZE: "tenmoku" } },
    (error, stdout) => {
      console.log(fields(error), JSON.stringify(stdout));
      done();
    },
  );
});

step("timeout not reached", (done) => {
  execFile("/bin/sh", ["-c", "printf bisque"], { timeout: 20000 }, (error, stdout) => {
    console.log(fields(error), JSON.stringify(stdout));
    done();
  });
});

step("timeout reached", (done) => {
  const soak = execFile("sleep", ["5"], { timeout: 150 }, (error, stdout, stderr) => {
    console.log(fields(error), JSON.stringify(stdout), JSON.stringify(stderr));
    done();
  });
  soak.on("exit", (code, signal) => {
    console.log("exit", code, signal, soak.killed);
  });
});

step("timeout reached, killSignal for a child that ignores SIGTERM", (done) => {
  const soak = execFile(
    "/bin/sh",
    ["-c", stubborn],
    { timeout: 150, killSignal: "SIGKILL" },
    (error) => {
      console.log(fields(error));
      done();
    },
  );
  soak.on("exit", (code, signal) => {
    console.log("exit", code, signal, soak.killed);
  });
});

step("maxBuffer reached sends killSignal too", (done) => {
  const flood = execFile(
    "/bin/sh",
    ["-c", "trap '' TERM; head -c 4000 /dev/zero | tr '\\0' x; exec sleep 5"],
    { maxBuffer: 64, killSignal: "SIGKILL" },
    (error, stdout) => {
      console.log(fields(error), stdout.length);
      done();
    },
  );
  flood.on("exit", (code, signal) => {
    console.log("exit", code, signal, flood.killed);
  });
});

step("timeout undefined, killSignal alone", (done) => {
  const wait: number | undefined = few ? undefined : 150;
  execFile(
    "/bin/sh",
    ["-c", "printf glost"],
    { timeout: wait, killSignal: "SIGKILL" },
    (error, stdout) => {
      console.log(fields(error), JSON.stringify(stdout));
      done();
    },
  );
});

step("signal aborted while the child runs, with a reason", (done) => {
  const damper = new AbortController();
  const soak = execFile("sleep", ["5"], { signal: damper.signal }, (error, stdout, stderr) => {
    console.log(fields(error), JSON.stringify(stdout), JSON.stringify(stderr));
  });
  soak.on("error", (err) => {
    console.log("error event", err.name, err.message);
  });
  soak.on("exit", (code, signal) => {
    console.log("exit", code, signal, soak.killed);
    done();
  });
  setTimeout(() => damper.abort(new Error("kiln opened")), 100);
});

step("signal already aborted", (done) => {
  const damper = new AbortController();
  damper.abort("cone bent");
  const soak = execFile("sleep", ["5"], { signal: damper.signal }, (error) => {
    console.log(fields(error));
  });
  soak.on("spawn", () => {
    console.log("spawned");
  });
  soak.on("exit", (code, signal) => {
    console.log("exit", code, signal, soak.killed);
    done();
  });
});

step("signal aborted when the first output arrives", (done) => {
  const damper = new AbortController();
  const soak = execFile(
    "/bin/sh",
    ["-c", "printf ember; exec sleep 5"],
    { signal: damper.signal, timeout: 20000 },
    (error, stdout) => {
      console.log(fields(error), JSON.stringify(stdout));
    },
  );
  soak.stdout?.on("data", () => {
    damper.abort();
  });
  soak.on("exit", (code, signal) => {
    console.log("exit", code, signal);
    done();
  });
});

step("signal never aborted, and undefined", (done) => {
  const damper = new AbortController();
  execFile("/bin/sh", ["-c", "printf one"], { signal: damper.signal }, (error, stdout) => {
    console.log(fields(error), JSON.stringify(stdout));
    execFile("/bin/sh", ["-c", "printf two"], { signal: undefined }, (again, out) => {
      console.log(fields(again), JSON.stringify(out));
      done();
    });
  });
});

step("a conditional spread carries timeout and signal, or nothing", (done) => {
  const damper = new AbortController();
  const timeout = 150;
  const signal = damper.signal;
  execFile("sleep", ["5"], { ...(few ? { timeout, signal } : {}) }, (error) => {
    console.log(fields(error));
    execFile(
      "/bin/sh",
      ["-c", "printf cooled"],
      { cwd: "/", ...(few ? {} : { timeout, signal }) },
      (again, out) => {
        console.log(fields(again), JSON.stringify(out));
        done();
      },
    );
  });
});

step("every option evaluates where it is written", (done) => {
  const damper = new AbortController();
  execFile(
    note("file", "/bin/sh"),
    note("args", ["-c", 'printf "%s|%s" "$PWD" "$GLAZE"']),
    {
      timeout: note("timeout", 20000),
      cwd: note("cwd", "/"),
      ...(note("condition", few) ? { signal: note("signal", damper.signal) } : {}),
      killSignal: note("killSignal", "SIGTERM" as const),
      maxBuffer: note("maxBuffer", 4096),
      env: { GLAZE: note("env", "shino"), PATH: "/usr/bin:/bin" },
    },
    (error, stdout) => {
      console.log(fields(error), JSON.stringify(stdout));
      done();
    },
  );
});

step("values execFile refuses, in its order", (done) => {
  const attempt = (label: string, start: () => void): void => {
    try {
      start();
      console.log(label, "started");
    } catch (e) {
      console.log(label, "threw", fields(e));
    }
  };
  const never = (): void => {
    console.log("never called");
  };
  const below: number = -1 * process.argv.length;
  const between: number = process.argv.length + 0.5;
  const unknown: string = "SIGKILN" + process.argv.length;
  const torn: string = "a\0b";
  const stray: unknown = { cone: 6 };
  attempt("negative timeout", () => execFile("/bin/echo", [], { timeout: below }, never));
  attempt("fractional timeout", () => execFile("/bin/echo", [], { timeout: between }, never));
  attempt("unknown signal", () => execFile("/bin/echo", [], { killSignal: unknown }, never));
  attempt("timeout before limit", () =>
    execFile("/bin/echo", [], { maxBuffer: below, timeout: below }, never),
  );
  attempt("limit before signal name", () =>
    execFile("/bin/echo", [], { killSignal: unknown, maxBuffer: below }, never),
  );
  attempt("signal name before argument", () =>
    execFile("/bin/echo", [torn], { killSignal: unknown }, never),
  );
  attempt("argument before abort signal", () =>
    execFile("/bin/echo", [torn], { signal: stray as AbortSignal }, never),
  );
  attempt("not an abort signal", () =>
    execFile("/bin/echo", [], { signal: stray as AbortSignal }, never),
  );
  attempt("exec negative timeout", () => exec("echo", { timeout: below }, never));
  done();
});

step("exec with env, timeout and signal", (done) => {
  exec('printf "%s" "$GLAZE"', { env: { GLAZE: "ash", PATH: "/usr/bin:/bin" } }, (error, out) => {
    console.log(fields(error), JSON.stringify(out));
    const soak = exec("exec sleep 5", { timeout: 150, killSignal: "SIGKILL" }, (late) => {
      console.log(fields(late));
      const damper = new AbortController();
      exec("exec sleep 5", { signal: damper.signal }, (aborted) => {
        console.log(fields(aborted));
        done();
      });
      setTimeout(() => damper.abort(), 100);
    });
    soak.on("exit", (code, signal) => {
      console.log("exit", code, signal, soak.killed);
    });
  });
});

fire(0);
