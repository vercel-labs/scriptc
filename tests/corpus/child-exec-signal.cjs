// exec/execFile accept an AbortSignal: an already-aborted signal and one
// aborted while the command runs both hand the callback an AbortError with
// empty captures, and a value that is not an AbortSignal throws Node's
// ERR_INVALID_ARG_TYPE before the child starts.
const cp = require("node:child_process");
const show = (tag, e, out, err) => console.log(tag, e && e.name, e && e.code, e && e.message, e && e.killed, e && e.signal, JSON.stringify(out), JSON.stringify(err));

const pre = new AbortController();
pre.abort();
cp.exec("sleep 5", { encoding: "utf8", signal: pre.signal }, (e, out, err) => show("pre-abort", e, out, err));

const mid = new AbortController();
cp.exec("sleep 5", { encoding: "utf8", signal: mid.signal }, (e, out, err) => show("mid-abort", e, out, err));
setTimeout(() => mid.abort(new Error("custom reason")), 100);

const file = new AbortController();
cp.execFile("sleep", ["5"], { encoding: "utf8", signal: file.signal }, (e, out, err) => show("execfile-mid", e, out, err));
setTimeout(() => file.abort(), 100);

// An untyped value reaches the call, so the check is Node's own.
function execWith(value) {
  try {
    cp.exec("echo x", { signal: value }, (e) => show("bad-signal", e));
  } catch (e) {
    show("bad-signal", e);
  }
}
execWith({});
execWith(new EventTarget());
const done = new AbortController();
cp.exec("echo ok", { encoding: "utf8", signal: done.signal }, (e, out, err) => show("completes", e, out, err));

// The abort wins over a longer timeout, loses to one that already fired, and
// works through a signal carried in a variable. The cases run one after the
// other so their output order is fixed.
const race = new AbortController();
cp.exec("sleep 5", { encoding: "utf8", timeout: 5000, signal: race.signal }, (e1, o1, r1) => {
  show("abort-vs-timeout", e1, o1, r1);
  const late = new AbortController();
  cp.exec(
    "sleep 5",
    { encoding: "utf8", timeout: 100, killSignal: "SIGKILL", signal: late.signal },
    (e2, o2, r2) => {
      show("timeout-then-abort", e2, o2, r2);
      let carried = null;
      const viaVariable = new AbortController();
      carried = viaVariable.signal;
      cp.exec("sleep 5", { encoding: "utf8", signal: carried }, (e3, o3, r3) =>
        show("variable", e3, o3, r3),
      );
      setTimeout(() => viaVariable.abort(), 100);
    },
  );
  setTimeout(() => late.abort(), 800);
});
setTimeout(() => race.abort(), 100);
