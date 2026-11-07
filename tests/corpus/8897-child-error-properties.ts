// The own properties of execFileSync's errors, attached by the runtime
// where it builds the error: a command that fails carries status, signal,
// output, pid, stdout and stderr; a command that does not exist carries
// the spawn error's errno fields and itself as `error`. Typed code catches
// each, and reads the properties through `any` afterwards.
import { execFileSync } from "node:child_process";

function report(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "no error");
  } catch (e) {
    const err = e as Error;
    console.log(label, err.name, "status" in err, "pid" in err, "nope" in err);
    const untyped = e as any;
    console.log(label, Object.keys(untyped).join(","));
    console.log(label, untyped.status, untyped.signal, typeof untyped.pid);
    console.log(label, String(untyped.stdout), JSON.stringify(String(untyped.stderr)));
    console.log(label, Array.isArray(untyped.output), untyped.output === null ? "null" : untyped.output.length);
    console.log(label, untyped.error === untyped, untyped.code, untyped.syscall, untyped.path);
    console.log(label, untyped === e, untyped instanceof Error);
  }
}

report("exit", () => {
  execFileSync("sh", ["-c", "echo out; echo err >&2; exit 3"], { stdio: "pipe" });
});
report("missing", () => {
  execFileSync("scriptc-no-such-command-8897", ["a", "b"], { stdio: "pipe" });
});
report("ok", () => {
  console.log("ok", execFileSync("sh", ["-c", "echo fine"], { encoding: "utf8" }).trim());
});
