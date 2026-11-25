// fs.opendir's callback form validates options.bufferSize after the
// directory opens: an invalid value closes the handle and throws from the
// completion callback, so it arrives as an uncaught exception and the
// caller's callback never runs. Values above 4294967295, zero, a
// non-integer, and a non-number each report their own error shape.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendir-buffer-"));

const cases = [
  [0, "zero"],
  [4294967296, "too large"],
  [1.5, "fraction"],
  ["2", "string"],
];
let next = 0;

process.on("uncaughtException", (error) => {
  console.log(cases[next - 1][1], error.name, error.code, error.message);
  if (next < cases.length) {
    fs.opendir(dir, { bufferSize: cases[next][0] }, () => {
      console.log("callback", cases[next - 1][1]);
    });
    next++;
    return;
  }
  fs.rmSync(dir, { recursive: true });
  console.log("removed", fs.existsSync(dir));
});

fs.opendir(dir, { bufferSize: cases[0][0] }, () => {
  console.log("callback", cases[0][1]);
});
next = 1;
