// The Console constructor's stream validation: Node takes a target when
// `typeof stream.write === 'function'`, defaults stderr to stdout, and
// throws ERR_CONSOLE_WRITABLE_STREAM for the first target that fails,
// after every option initializer has evaluated. ignoreErrors is not
// validated: Node stores Boolean(ignoreErrors).
const { Console } = require("console");

const built = (value) => (void value, "constructed");

function shape(label, fn) {
  try {
    console.log(label, "ok", String(fn()));
  } catch (e) {
    console.log(label, [e.constructor.name, e.name, e.code, e.message, e instanceof Error].join(" | "));
  }
}

shape("no options", () => built(new Console()));
shape("empty options", () => built(new Console({})));
shape("number stdout", () => built(new Console({ stdout: 5 })));
shape("number argument", () => built(new Console(5)));
shape("null argument", () => built(new Console(null)));
shape("null stdout", () => built(new Console({ stdout: null })));
shape("empty object stdout", () => built(new Console({ stdout: {} })));
shape("number stderr", () => built(new Console(process.stdout, 5)));
shape("options number stderr", () => built(new Console({ stdout: process.stdout, stderr: 5 })));
shape("options null stderr", () => built(new Console({ stdout: process.stdout, stderr: null })));
shape("writable stdout", () => built(new Console({ stdout: process.stdout })));
shape("both stdio", () => built(new Console({ stdout: process.stdout, stderr: process.stderr })));

// stdout is validated before stderr, and both after the whole options
// object evaluated: a bad stdout still runs the stderr initializer.
shape("order", () => {
  try {
    new Console({ stdout: 5, stderr: console.log("stderr initializer") });
  } catch (e) {
    console.log("order caught", e.code);
  }
  return "checked";
});

// ignoreErrors takes any value; only a falsy one changes the handling.
for (const value of [5, 0, "", "x", {}, [], null, true, false]) {
  shape("ignoreErrors " + JSON.stringify(value), () => built(new Console({ stdout: process.stdout, ignoreErrors: value })));
}
