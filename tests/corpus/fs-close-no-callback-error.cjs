// fs.close(fd) with no callback runs Node's defaultCloseCallback: the close
// itself happens at the call, but a failure is thrown from the request's
// completion on a later turn, so the call site never sees it and the
// uncaughtException listener does. The descriptor argument is still
// validated at the call, so out-of-range values throw synchronously.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "close-deferred-"));
const file = path.join(dir, "a.txt");
fs.writeFileSync(file, "hello");

try {
  fs.close(-1);
  console.log("negative accepted");
} catch (error) {
  console.log("negative throws at the call", error.name, error.code, error.message);
}

try {
  fs.close(1.5, () => {});
  console.log("fraction accepted");
} catch (error) {
  console.log("fraction throws at the call", error.name, error.code, error.message);
}

const good = fs.openSync(file, "r");
console.log("valid close", fs.close(good));

const broken = fs.openSync(file, "r");
fs.closeSync(broken);
let seen = 0;
process.on("uncaughtException", (error) => {
  console.log("uncaught", error.name, error.code, error.errno, error.syscall, error.message);
  seen++;
  if (seen === 1) {
    console.log("descriptor is not open", (() => {
      try {
        fs.fstatSync(broken);
        return "open";
      } catch (thrown) {
        return thrown.code;
      }
    })());
    fs.close(broken);
    console.log("second failure scheduled");
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("removed", fs.existsSync(dir));
});

console.log("before the failing close");
fs.close(broken);
console.log("after the call, still synchronous");
// Keeps the loop alive until the deferred failures have run.
setTimeout(() => {}, 10);
