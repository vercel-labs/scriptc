// exec's callback error is the same metadata carrier as execFile's — the
// shell form's exit status reads as a number through `code` — and the
// execSync throw carries the sync result's own fields (status, stdout,
// stderr) with no `code`. Node's spawnSync error is the errnoException
// for both forms; here the shell always spawns, so exec's failures are
// exit statuses.
import { exec, execSync } from "node:child_process";

function keys(e: unknown): string {
  return Object.keys(e as object).join(",");
}

try {
  execSync("echo out; echo err 1>&2; exit 3", { encoding: "utf8" });
  console.log("execSync exit 3: no throw");
} catch (e) {
  const err = e as {
    code?: number | string | null;
    status?: number | null;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
  };
  console.log("execSync", typeof err.code, err.code, err.status, err.signal);
  console.log("stdout", JSON.stringify(err.stdout), "stderr", JSON.stringify(err.stderr));
  console.log("keys", keys(e), "has code", "code" in err);
  console.log("message", JSON.stringify(e instanceof Error ? e.message : String(e)));
}

exec("kill -TERM $$", (signalled) => {
  if (signalled === null) {
    console.log("exec signal: no error");
    return;
  }
  console.log(
    "exec signal",
    typeof signalled.code,
    signalled.code,
    signalled.killed,
    signalled.signal,
    keys(signalled),
  );
  console.log("cmd", signalled.cmd, "message", JSON.stringify(signalled.message));
  exec("exit 3", (error) => {
    if (error === null) {
      console.log("exec exit 3: no error");
      return;
    }
    console.log("exec exit 3", typeof error.code, error.code, error.killed, error.signal);
    console.log("chain", error?.code, typeof error?.code, error?.killed, error?.signal, error?.cmd);
    console.log(
      "compare",
      error.code === 3,
      error.code === "ENOENT",
      error.signal === null,
    );
    console.log("cmd", error.cmd, "message", JSON.stringify(error.message));
    console.log("keys", keys(error), "has code", "code" in error);
  });
});
