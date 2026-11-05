// fs.read's callback forms with bigint positions read at the exact
// position, including past 2^53 (beyond the file's end, so nothing is
// read), and -1n reads at the current offset. A fractional or infinite
// length takes `length |= 0` before the position check, and a position
// getter in either options form runs once.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-read-cb-position-"));
const file = path.join(dir, "data");
fs.writeFileSync(file, "abc");
const fd = fs.openSync(file, "r");
const big = 9007199254740993n;

function step(label, run, next) {
  run((error, bytesRead, buffer) => {
    console.log(label, error ? error.code : null, bytesRead, buffer ? buffer.toString("latin1", 0, bytesRead) : "");
    next();
  });
}

step("positional", (cb) => fs.read(fd, Buffer.alloc(1), 0, 1, big, cb), () =>
  step("options", (cb) => fs.read(fd, { buffer: Buffer.alloc(1), position: big }, cb), () =>
    step("buffer and options", (cb) => fs.read(fd, Buffer.alloc(2), { position: big }, cb), () =>
      step("small", (cb) => fs.read(fd, Buffer.alloc(2), 0, 2, 1n, cb), () =>
        step("current", (cb) => fs.read(fd, Buffer.alloc(1), 0, 1, -1n, cb), () => {
          fractional();
        })))));

function counted(values) {
  const options = { calls: 0 };
  Object.defineProperty(options, "position", {
    get() {
      return values[options.calls++];
    },
  });
  return options;
}

function fractional() {
  step("fractional", (cb) => fs.read(fd, { buffer: Buffer.alloc(2), length: 0.5, position: 1n }, cb), () =>
    step("infinite", (cb) => fs.read(fd, Buffer.alloc(2), { length: Infinity, position: 1n }, cb), () =>
      step("truncated", (cb) => fs.read(fd, { buffer: Buffer.alloc(3), length: 2.7, position: 1n }, cb), () => {
        const first = counted([0, 2]);
        first.buffer = Buffer.alloc(1);
        first.length = 1;
        step("getter options", (cb) => fs.read(fd, first, cb), () => {
          console.log("getter options calls", first.calls);
          const second = counted([2, 0]);
          second.length = 1;
          step("getter buffer and options", (cb) => fs.read(fd, Buffer.alloc(1), second, cb), () => {
            console.log("getter buffer and options calls", second.calls);
            fs.closeSync(fd);
            fs.rmSync(dir, { recursive: true });
          });
        });
      })));
}
