// fs.close's fd validation for values the static signature does not accept:
// non-numbers report ERR_INVALID_ARG_TYPE, non-integers and out-of-range
// numbers ERR_OUT_OF_RANGE, and the callback stays optional.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "close-args-"));
const file = path.join(dir, "f.txt");
fs.writeFileSync(file, "x");
const noop = () => {};

function t(label, run) {
  try {
    run();
    console.log(label, "accepted");
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
}

t("string", () => fs.close("3", noop));
t("object", () => fs.close({}, noop));
t("array", () => fs.close([1], noop));
t("null", () => fs.close(null, noop));
t("undefined", () => fs.close(undefined, noop));
t("NaN", () => fs.close(NaN, noop));
t("Infinity", () => fs.close(Infinity, noop));
t("negative", () => fs.close(-1, noop));
t("fractional", () => fs.close(2.5, noop));
t("too large", () => fs.close(2 ** 31, noop));

// A valid descriptor without a callback still closes. Node's close is
// asynchronous even then (the default callback only reports the error), so
// the descriptor may be open right after the call; by the time the loop
// drains it is closed. Reading it at exit makes the observation
// deterministic.
const fd = fs.openSync(file, "r");
fs.close(fd);
process.on("exit", () => {
  try {
    fs.fstatSync(fd);
    console.log("still readable");
  } catch (error) {
    console.log("closed without callback", error.code);
  }
});

// A boolean is not an integer either.
t("boolean", () => fs.close(true, noop));
