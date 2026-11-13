// fs.close in its callback form: the fd is validated (and out-of-range
// values throw at the call), a closed or unknown descriptor reports EBADF
// to the callback, and the callback is optional — without one the close
// still runs and the call answers undefined.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "close-cb-"));
const file = path.join(dir, "a.txt");
fs.writeFileSync(file, "hello");

const steps = [
  (next) =>
    fs.close(fs.openSync(file, "r"), (...args) => {
      console.log("close", args.length, args[0]);
      next();
    }),
  (next) => {
    const fd = fs.openSync(file, "r");
    console.log("close without callback", fs.close(fd));
    fs.fstat(fd, (error) => {
      console.log("after close", error && error.code);
      next();
    });
  },
  (next) => {
    const fd = fs.openSync(file, "r");
    fs.close(fd, (error) => {
      console.log("first", error);
      fs.close(fd, (again) => {
        console.log("second", again && again.code, again && again.syscall);
        next();
      });
    });
  },
  (next) => {
    try {
      fs.close(-1, () => {});
    } catch (error) {
      console.log("negative throws", error.name, error.code, error.message);
    }
    next();
  },
  (next) => {
    try {
      fs.close(1.5, () => {});
    } catch (error) {
      console.log("fraction throws", error.name, error.code, error.message);
    }
    next();
  },
  (next) => {
    try {
      fs.close(fs.openSync(file, "r"), 5);
    } catch (error) {
      console.log("bad callback throws", error.name, error.code, error.message);
      next();
    }
  },
  (next) =>
    fs.close(999999, (error) => {
      console.log("unknown fd", error && error.code);
      next();
    }),
  (next) => {
    fs.rmSync(dir, { recursive: true, force: true });
    next();
  },
];

let index = 0;
function step() {
  if (index === steps.length) return;
  steps[index++](step);
}
step();
