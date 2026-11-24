// The typed lane's exec options accept signal: AbortSignal, matching
// @types/node's CommonExecOptions; the callback receives the AbortError.
import { exec, execFile } from "node:child_process";

const ac = new AbortController();
exec("sleep 5", { encoding: "utf8", signal: ac.signal }, (error, stdout, stderr) => {
  console.log("typed-mid", error?.name, (error as { code?: string } | null)?.code, JSON.stringify(stdout), JSON.stringify(stderr));
});
setTimeout(() => ac.abort(), 50);

const pre = new AbortController();
pre.abort();
execFile("sleep", ["5"], { encoding: "utf8", signal: pre.signal }, (error, stdout, stderr) => {
  console.log("typed-pre", error?.name, (error as { code?: string } | null)?.code, JSON.stringify(stdout), JSON.stringify(stderr));
});
