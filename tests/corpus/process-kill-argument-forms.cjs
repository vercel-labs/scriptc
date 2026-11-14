// process.kill's arguments go through Node's loose guards: the pid passes
// when `pid != (pid | 0)` (so a numeric string, a padded string and an empty
// array convert, while null, undefined, a fraction and the non-finite
// numbers throw the pid TypeError), and the signal is either an int32 (0
// probes) or a name in the signal table. A number that is not an int32, an
// unknown name, an array and a plain object all throw ERR_UNKNOWN_SIGNAL
// with util.format's %s text; a symbol or bigint keeps its ToNumber message.
"use strict";
const log = [];
const note = (tag) => {
  log.push(tag);
  return 0;
};
function report(label, run) {
  try {
    console.log(label, "->", run());
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
}
const pid = process.pid;
report("self probe", () => process.kill(pid, 0));
report("string pid", () => process.kill(String(pid), 0));
report("padded string pid", () => process.kill(" " + pid + " ", 0));
report("array pid", () => process.kill([], 0));
report("number-string signal", () => process.kill(pid, "0"));
report("null pid", () => process.kill(null, 0));
report("undefined pid", () => process.kill(undefined, 0));
report("float pid", () => process.kill(1.5, 0));
report("nan pid", () => process.kill(NaN, 0));
report("infinity pid", () => process.kill(Infinity, 0));
report("bogus signal", () => process.kill(pid, "SIGNOPE"));
report("empty object signal", () => process.kill(pid, {}));
report("symbol signal", () => process.kill(pid, Symbol("s")));
report("symbol pid", () => process.kill(Symbol("p"), 0));
report("bigint pid", () => process.kill(0n, 0));
report("array signal", () => process.kill(pid, []));
report("custom toString", () => {
  const signal = {
    toString() {
      return "SIGNOPE";
    },
  };
  return process.kill(pid, signal);
});
report("extra argument", () => process.kill(pid, 0, note("kill")));
report("no signal", () => {
  const child = process.pid;
  return process.kill(child, "SIGCONT");
});
console.log("log", log.join(","));
