// An execFile options object evaluates its members in the order they are
// written, before the spawn — the launch's own argument order must not
// reorder them. Validation runs after the whole object is evaluated, so an
// env built before an out-of-range timeout is built and then the timeout
// throws.
import { execFile } from "node:child_process";

interface ExecError extends Error {
  code?: string | number | null;
}

function delay(): number {
  console.log("eval", "timeout");
  return 5000;
}

function value(tag: string): string {
  console.log("eval", tag);
  return tag;
}

console.log("scheduled");

// Written timeout-first: evaluating env before timeout would reorder them.
execFile(
  "/bin/sh",
  ["-c", "printf ok"],
  { timeout: delay(), env: { FOO: value("env") } },
  (error, stdout, stderr) => {
    console.log("done", error === null, JSON.stringify(stdout), JSON.stringify(stderr));
  },
);

// The invalid timeout throws only after the env member is evaluated.
try {
  execFile("/bin/sh", ["-c", "true"], { env: { FOO: value("bad-env") }, timeout: -1 }, () => {});
  console.log("invalid no throw");
} catch (e) {
  const err = e as ExecError;
  console.log("invalid", err.name, err.code ?? null);
}
