// child.kill's signal follows Node's sanitizeKillSignal: a name (any case) or
// an integer is the signal, an omitted or undefined signal is SIGTERM, and
// every other value throws ERR_UNKNOWN_SIGNAL with the value inspected.
const cp = require("node:child_process");
const cases = [
  ["omitted", (c) => c.kill()],
  ["num0", (c) => c.kill(0)],
  ["num9", (c) => c.kill(9)],
  ["name", (c) => c.kill("SIGTERM")],
  ["lower", (c) => c.kill("sigterm")],
  ["str0", (c) => c.kill("0")],
  ["undef", (c) => c.kill(undefined)],
  ["null", (c) => c.kill(null)],
  ["nan", (c) => c.kill(NaN)],
  ["frac", (c) => c.kill(9.5)],
  ["bool", (c) => c.kill(true)],
  ["obj", (c) => c.kill({})],
  ["arr", (c) => c.kill([])],
  ["big", (c) => c.kill(1n)],
  ["sym", (c) => c.kill(Symbol("s"))],
  ["empty", (c) => c.kill("")],
  // A JS string may hold an embedded NUL, and Node's message keeps every
  // byte of it.
  ["nul-in-name", (c) => c.kill("a\u0000bc")],
  ["nul-only", (c) => c.kill("\u0000")],
  // A signal value carried in a variable takes the same sanitizer path.
  [
    "variable-null",
    (c) => {
      const carried = null;
      return c.kill(carried);
    },
  ],
];
let i = 0;
function next() {
  if (i >= cases.length) return;
  const [label, fn] = cases[i];
  i += 1;
  const child = cp.spawn("sleep", ["2"]);
  let out;
  child.on("spawn", () => {
    try {
      out = "ret " + fn(child);
    } catch (error) {
      out = "throw " + error.code + " " + JSON.stringify(error.message);
    }
    if (!child.killed) child.kill("SIGKILL");
  });
  child.on("error", () => {});
  child.on("close", () => {
    console.log(label, out);
    next();
  });
}
next();
