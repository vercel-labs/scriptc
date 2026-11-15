// child_process.spawn from a JavaScript module: the options record is
// computed, so its members are read at run time. spawn's launch checks run
// in Node's order (timeout as an unsigned integer, the signal as an
// AbortSignal, the killSignal as a name or a number), and a positive
// timeout kills with killSignal at the deadline.
"use strict";
const { spawn } = require("child_process");

/**
 * @param {string} tag
 * @param {() => any} make
 */
function thrown(tag, make) {
  try {
    const child = make();
    if (child) child.on("error", () => {});
    console.log(tag, "no throw");
  } catch (e) {
    console.log(tag, e.name, e.code ?? null, JSON.stringify(e.message));
  }
}

/**
 * @param {string} tag
 * @param {import("child_process").ChildProcess} child
 * @param {() => void} next
 */
function wait(tag, child, next) {
  child.on("error", (e) => console.log(tag, "error", e.name));
  child.on("close", (code, signal) => {
    console.log(tag, code, signal);
    next();
  });
}

const sleeper = ["-c", "sleep 5"];
console.log("scheduled");

thrown("timeout-negative", () => spawn("/bin/sh", sleeper, { timeout: -1 }));
thrown("timeout-fractional", () => spawn("/bin/sh", sleeper, { timeout: 1.5 }));
thrown("timeout-nan", () => spawn("/bin/sh", sleeper, { timeout: NaN }));
thrown("kill-unknown", () => spawn("/bin/sh", sleeper, { killSignal: "nope" }));
thrown("kill-unknown-number", () => spawn("/bin/sh", sleeper, { killSignal: 999999 }));
thrown("kill-fractional", () => spawn("/bin/sh", sleeper, { killSignal: 9.5 }));
thrown("kill-string-number", () => spawn("/bin/sh", sleeper, { killSignal: "9" }));
thrown("kill-boolean", () => spawn("/bin/sh", sleeper, { killSignal: true }));
thrown("signal-null", () => spawn("/bin/sh", sleeper, { signal: null }));
thrown("signal-string", () => spawn("/bin/sh", sleeper, { signal: "stop" }));
thrown("signal-object", () => spawn("/bin/sh", sleeper, { signal: {} }));
// Node validates the timeout, then the signal, then the killSignal: the
// first failing check reports.
thrown("timeout-before-signal", () => spawn("/bin/sh", sleeper, { timeout: -1, signal: null }));
thrown("signal-before-kill", () => spawn("/bin/sh", sleeper, { signal: null, killSignal: "nope" }));

const timed = { stdio: "ignore", timeout: 80, killSignal: 9 };
wait("numeric", spawn("/bin/sh", sleeper, timed), () => {
  const named = { stdio: "ignore" };
  named.timeout = 80;
  named.killSignal = "sigkill";
  wait("named", spawn("/bin/sh", sleeper, named), () => {
    const zero = { stdio: "ignore", timeout: 0, killSignal: "SIGKILL" };
    wait("zero", spawn("/bin/sh", ["-c", "exit 7"], zero), () => {
      const nullish = { stdio: "ignore", timeout: null, killSignal: null };
      wait("nullish", spawn("/bin/sh", ["-c", "exit 7"], nullish), () => {
        console.log("done");
      });
    });
  });
});
