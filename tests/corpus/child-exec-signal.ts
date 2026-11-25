// The typed lane's exec options accept signal: AbortSignal, matching
// @types/node's CommonExecOptions; the callback receives the AbortError with
// the captures collected before the abort, and signal: undefined launches
// without cancellation support. The cases run one after another so their
// output order is fixed.
import { exec, execFile } from "node:child_process";

const pre = new AbortController();
pre.abort();
execFile("sleep", ["5"], { encoding: "utf8", signal: pre.signal }, (error, stdout, stderr) => {
  console.log("typed-pre", error?.name, (error as { code?: string } | null)?.code, JSON.stringify(stdout), JSON.stringify(stderr));
  const noSignal: AbortSignal | undefined = undefined;
  exec("echo typed-undef", { encoding: "utf8", signal: noSignal }, (e2, o2, r2) => {
    console.log("typed-undefined", e2 == null, JSON.stringify(o2), JSON.stringify(r2));
    const partial = new AbortController();
    exec("printf typed-out; sleep 5", { encoding: "utf8", signal: partial.signal }, (e3, o3, r3) => {
      console.log("typed-partial", e3?.name, (e3 as { code?: string } | null)?.code, JSON.stringify(o3), JSON.stringify(r3));
    });
    setTimeout(() => partial.abort(), 200);
  });
});

// A typed child's 'error' listener hears the abort after the callback.
setTimeout(() => {
  const watched = new AbortController();
  let callbackError: unknown = null;
  let listenerError: unknown = null;
  const child = exec("sleep 5", { encoding: "utf8", signal: watched.signal }, (error, stdout, stderr) => {
    callbackError = error;
    console.log("typed-listen-callback", error?.name, (error as { code?: string } | null)?.code, JSON.stringify(stdout), JSON.stringify(stderr));
  });
  child.on("error", (error: Error & { code?: string }) => {
    listenerError = error;
    console.log("typed-listen-error", error.name, error.code);
  });
  child.on("exit", (code: number | null, signal: string | null) => console.log("typed-listen-exit", code, signal, "same-error", callbackError === listenerError));
  setTimeout(() => watched.abort(), 100);
}, 1200);
