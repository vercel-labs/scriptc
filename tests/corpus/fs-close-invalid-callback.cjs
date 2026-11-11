// fs.close(fd, callback) only defaults the callback when it is omitted or
// undefined. null and every other non-callable value go through Node's
// makeCallback check, which throws ERR_INVALID_ARG_TYPE at the call and
// leaves the descriptor open; a valid callback still closes it.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "close-invalid-"));
const file = path.join(dir, "a.txt");
fs.writeFileSync(file, "hello");

const cases = [
  ["null", null],
  ["zero", 0],
  ["false", false],
  ["string", "x"],
  ["object", {}],
  ["array", []],
];

for (const [label, value] of cases) {
  const fd = fs.openSync(file, "r");
  try {
    fs.close(fd, value);
    console.log(label, "accepted");
  } catch (error) {
    let state = -1;
    try {
      state = fs.fstatSync(fd).size;
      fs.closeSync(fd);
    } catch (thrown) {
      state = thrown.code;
    }
    console.log(label, error.name, error.code, JSON.stringify(error.message), "fd", state);
  }
}

function state(fd) {
  try {
    fs.fstatSync(fd);
    return "open";
  } catch (thrown) {
    return thrown.code;
  }
}

// An explicit undefined takes the default callback, so the close is a request
// whose completion can land on either side of the next statement; only the
// later turn is a stable observation.
const explicit = fs.openSync(file, "r");
const returned = fs.close(explicit, undefined);
setTimeout(() => {
  console.log("undefined", returned, state(explicit));

  const called = fs.openSync(file, "r");
  fs.close(called, (error) => {
    console.log("callback", error, state(called));
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("removed", fs.existsSync(dir));
  });
}, 10);
