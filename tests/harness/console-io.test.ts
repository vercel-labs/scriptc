/* Live process-I/O parity. The differential corpus captures stdout/stderr
 * only after each process exits, so it cannot detect an implementation that
 * retains console.log/process.stdout.write bytes in a userspace buffer until
 * a later error, a size threshold, or normal exit.
 *
 * These probes keep the child alive after writing and observe its stdout
 * pipe directly. The abrupt-death case additionally proves byte parity when
 * no exit hook can rescue retained output. SCRIPTC_SAN=1 builds the native
 * probes with the same ASan + refcount-audit instrumentation as the corpus. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureDir = join(repoRoot, "tests/fixtures/console-io");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface ClosedChild {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface BuildOptions {
  stdoutBuffering?: boolean;
}

async function build(
  name: string,
  options: BuildOptions = {},
): Promise<{ binary: string; sourceFile: string }> {
  const sourceFile = join(fixtureDir, `${name}.ts`);
  const key = createHash("sha256")
    .update(sourceFile)
    .update(readFileSync(sourceFile))
    .update(sanitize ? "san" : "plain")
    .update(options.stdoutBuffering === true ? "buffered" : "default")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `console-io-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(sourceFile, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    backend: "llvm",
    ...(options.stdoutBuffering === true ? { stdoutBuffering: true } : {}),
  });
  if (!result.ok) {
    throw new Error(
      "console-I/O probe failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return { binary: result.binaryPath, sourceFile };
}

/** Resolve only after expected stdout was visible while the child was still
 * alive. SIGKILL makes a false pass impossible: it runs no stdio/atexit
 * flushing if the expected bytes were still retained by the child. */
function observeLiveStdout(cmd: string, args: string[], expected: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let observed = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      const all = Buffer.concat(stdout);
      if (!observed && all.includes(expected)) {
        observed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout);
      if (!observed) {
        reject(
          new Error(
            `stdout was not visible before child exit` +
              `${timedOut ? " (timed out)" : ""}; code=${code}, signal=${signal}, ` +
              `stdout=${JSON.stringify(out.toString("utf8"))}, ` +
              `stderr=${JSON.stringify(Buffer.concat(stderr).toString("utf8"))}`,
          ),
        );
        return;
      }
      resolve(out);
    });
  });
}

function runToClose(cmd: string, args: string[]): Promise<ClosedChild> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("abrupt console-I/O probe timed out"));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        code,
        signal,
      });
    });
  });
}

/** Kill the child with SIGKILL after `ms`; collect what reached stdout. */
function killAfter(cmd: string, args: string[], ms: number): Promise<ClosedChild> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), ms);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code, signal });
    });
  });
}

/** Answer the probe's prompt only after it is visible, then read its reply. */
function runPrompt(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let answered = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `prompt was not visible before the read; stdout=${JSON.stringify(
            Buffer.concat(stdout).toString("utf8"),
          )}`,
        ),
      );
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (!answered && Buffer.concat(stdout).includes("prompt> ")) {
        answered = true;
        child.stdin.write("hello\n");
        child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
      });
    });
  });
}

describe(`console/process output visibility${sanitize ? " (sanitized)" : ""}`, () => {
  test("console.log and string/byte stdout writes are visible before exit", async () => {
    const expected = Buffer.from("log-ready\nstring-ready|bytes-ready");
    const probe = await build("live-stdout");

    const [nodeOut, nativeOut] = await Promise.all([
      observeLiveStdout("node", [probe.sourceFile], expected),
      observeLiveStdout(probe.binary, [], expected),
    ]);
    expect(nodeOut.subarray(0, expected.length)).toEqual(expected);
    expect(nativeOut.subarray(0, expected.length)).toEqual(expected);
  });

  test("stdout already submitted before an unflushable SIGKILL matches Node", async () => {
    const expected = Buffer.from("before-sigkill\n");
    const probe = await build("sigkill-stdout");

    const [nodeRes, nativeRes] = await Promise.all([
      runToClose("node", [probe.sourceFile]),
      runToClose(probe.binary, []),
    ]);
    expect(nodeRes.stdout).toEqual(expected);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(nativeRes.stderr).toEqual(nodeRes.stderr);
    expect(nativeRes.code).toBe(nodeRes.code);
    expect(nativeRes.signal).toBe(nodeRes.signal);
  });

  /* A bounded probe cannot fill the shared pipe: Node submits these writes
   * immediately. With backpressure, its independent asynchronous stdout and
   * stderr queues can interleave larger chunks, so compare large pipe output
   * per stream and retain the shared-file ordering check below. */
  const posix = process.platform !== "win32";
  test.skipIf(!posix)("stdout/stderr merged into one pipe keep Node's order", async () => {
    const probe = await build("merged-order");
    const merged = (cmd: string, args: string[]) =>
      runToClose("sh", ["-c", 'exec "$@" 2>&1', "sh", cmd, ...args]);
    const [nodeRes, nativeRes] = await Promise.all([
      merged("node", [probe.sourceFile, "--small"]),
      merged(probe.binary, ["--small"]),
    ]);
    expect(nodeRes.code).toBe(0);
    expect(nativeRes.code).toBe(0);
    expect(nodeRes.stdout.length).toBeLessThan(4096);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
  });

  test("large stdout/stderr pipe writes match Node per stream", async () => {
    const probe = await build("merged-order");
    const [nodeRes, nativeRes] = await Promise.all([
      runToClose("node", [probe.sourceFile]),
      runToClose(probe.binary, []),
    ]);
    expect(nodeRes.code).toBe(0);
    expect(nativeRes.code).toBe(0);
    expect(nodeRes.stdout.length).toBeGreaterThan(65536);
    expect(nodeRes.stderr.length).toBeGreaterThan(65536);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(nativeRes.stderr).toEqual(nodeRes.stderr);
  });

  test.skipIf(!posix)("stdout/stderr merged into one file keep Node's order", async () => {
    const probe = await build("merged-order");
    const outDir = join(cacheDir, "console-io-merged-file");
    mkdirSync(outDir, { recursive: true });
    const toFile = async (label: string, cmd: string, args: string[]) => {
      const path = join(outDir, `${label}.out`);
      const res = await runToClose("sh", [
        "-c",
        'out="$1"; shift; exec "$@" >"$out" 2>&1',
        "sh",
        path,
        cmd,
        ...args,
      ]);
      expect(res.code).toBe(0);
      return readFileSync(path);
    };
    const [nodeOut, nativeOut] = await Promise.all([
      toFile("node", "node", [probe.sourceFile]),
      toFile("native", probe.binary, []),
    ]);
    expect(nativeOut.length).toBe(nodeOut.length);
    expect(nativeOut.equals(nodeOut)).toBe(true);
  });

  /* The reader closes after the first chunk. SIGPIPE is ignored in the child
   * (Node ignores it unconditionally), so writes fail with EPIPE; console
   * ignores stream errors and the program completes like Node. */
  test.skipIf(!posix)(
    "console.log after the stdout reader closes (EPIPE) matches Node",
    async () => {
      const probe = await build("epipe-console");
      const readerCloses = (cmd: string, args: string[]) =>
        new Promise<ClosedChild>((resolve, reject) => {
          const child = spawn("sh", ["-c", 'trap "" PIPE; exec "$@"', "sh", cmd, ...args], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("EPIPE console probe timed out"));
          }, 20_000);
          child.stdout.once("data", (chunk: Buffer) => {
            stdout.push(chunk);
            child.stdout.destroy();
          });
          child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
          child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          child.on("close", (code, signal) => {
            clearTimeout(timer);
            resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code, signal });
          });
        });
      const [nodeRes, nativeRes] = await Promise.all([
        readerCloses("node", [probe.sourceFile]),
        readerCloses(probe.binary, []),
      ]);
      expect(nodeRes.stdout.subarray(0, 5).toString()).toBe("line ");
      expect(nativeRes.stdout.subarray(0, 5).toString()).toBe("line ");
      expect(nativeRes.stderr.toString()).toBe(nodeRes.stderr.toString());
      expect(nativeRes.code).toBe(nodeRes.code);
      expect(nativeRes.signal).toBe(nodeRes.signal);
    },
  );
});

/* The opt-in lane: `stdoutBuffering: true` keeps stdout in the runtime's
 * 64 KiB buffer when fd 1 is not a terminal. These cases pin the behavior
 * the option promises — merged order, the exit and error flushes, the
 * prompt flush before a blocking read, and the stated SIGKILL loss window —
 * while the cases above keep the default per-call contract pinned. */
describe(`buffered stdout (--stdout-buffering)${sanitize ? " (sanitized)" : ""}`, () => {
  const buffered: BuildOptions = { stdoutBuffering: true };
  const posix = process.platform !== "win32";

  test.skipIf(!posix)("small merged stdout/stderr keep Node's order", async () => {
    const probe = await build("merged-order", buffered);
    const merged = (cmd: string, args: string[]) =>
      runToClose("sh", ["-c", 'exec "$@" 2>&1', "sh", cmd, ...args]);
    const [nodeRes, nativeRes] = await Promise.all([
      merged("node", [probe.sourceFile, "--small"]),
      merged(probe.binary, ["--small"]),
    ]);
    expect(nodeRes.code).toBe(0);
    expect(nativeRes.code).toBe(0);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
  });

  test("process.exit publishes buffered stdout", async () => {
    const probe = await build("buffered-exit", buffered);
    const [nodeRes, nativeRes] = await Promise.all([
      runToClose("node", [probe.sourceFile]),
      runToClose(probe.binary, []),
    ]);
    expect(nodeRes.stdout.toString()).toBe("before-exit\n");
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(nativeRes.code).toBe(nodeRes.code);
  });

  test.skipIf(!posix)("an uncaught error publishes buffered stdout first", async () => {
    const probe = await build("buffered-throw", buffered);
    const merged = (cmd: string, args: string[]) =>
      runToClose("sh", ["-c", 'exec "$@" 2>&1', "sh", cmd, ...args]);
    const [nodeRes, nativeRes] = await Promise.all([
      merged("node", [probe.sourceFile]),
      merged(probe.binary, []),
    ]);
    const nodeText = nodeRes.stdout.toString();
    const nativeText = nativeRes.stdout.toString();
    expect(nodeText.startsWith("before-throw\n")).toBe(true);
    expect(nativeText.startsWith("before-throw\n")).toBe(true);
    expect(nativeText).toContain("buffered-throw");
    expect(nativeRes.code).toBe(nodeRes.code);
  });

  test.skipIf(!posix)("a prompt is visible before a blocking stdin read", async () => {
    const probe = await build("buffered-prompt", buffered);
    const [nodeRes, nativeRes] = await Promise.all([
      runPrompt("node", [probe.sourceFile]),
      runPrompt(probe.binary, []),
    ]);
    expect(nodeRes.stdout).toBe("prompt> got:hello\n");
    expect(nativeRes.stdout).toBe(nodeRes.stdout);
    expect(nativeRes.code).toBe(nodeRes.code);
  });

  test.skipIf(!posix)("a prompt is visible before a blocking readSync", async () => {
    const probe = await build("buffered-readsync", buffered);
    const [nodeRes, nativeRes] = await Promise.all([
      runPrompt("node", [probe.sourceFile]),
      runPrompt(probe.binary, []),
    ]);
    expect(nodeRes.stdout).toBe("prompt> got:hello\n");
    expect(nativeRes.stdout).toBe(nodeRes.stdout);
    expect(nativeRes.code).toBe(nodeRes.code);
  });

  test.skipIf(!posix)("a SIGKILL before any flush loses the buffer", async () => {
    const probe = await build("buffered-kill-window", buffered);
    // 32,000 bytes stay below the 64 KiB buffer: the spinning child is
    // killed with no settle point in between, so nothing is published.
    const res = await killAfter(probe.binary, ["32000"], 400);
    expect(res.signal).toBe("SIGKILL");
    expect(res.stdout.length).toBe(0);
  });

  test.skipIf(!posix)("a full buffer is published before a SIGKILL", async () => {
    const probe = await build("buffered-kill-window", buffered);
    // 200,000 bytes fill the buffer three times; those flushes survive the
    // kill, the tail below 64 KiB does not.
    const res = await killAfter(probe.binary, ["200000"], 800);
    expect(res.signal).toBe("SIGKILL");
    expect(res.stdout.length).toBeGreaterThanOrEqual(65536);
    expect(res.stdout.length).toBeLessThan(200000);
  });
});
