const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mkget-"));
const under = (name) => path.join(root, name);
const isDir = (name) => fs.existsSync(under(name));
function dynamic(options) {
  return options;
}
function show(label, run) {
  try {
    const value = run();
    console.log(label, "ok", value === undefined ? "undefined" : typeof value);
  } catch (error) {
    console.log(label, "threw", error.name, error.message);
  }
}
// A getter that throws propagates before any directory is created.
let reads = 0;
const throwingRecursive = {
  get recursive() {
    reads += 1;
    throw new Error("recursive getter");
  },
};
show("recursive getter throws", () => fs.mkdirSync(under("rec-throw"), dynamic(throwingRecursive)));
console.log("recursive getter", reads, isDir("rec-throw"));
let modeReads = 0;
const throwingMode = {
  get mode() {
    modeReads += 1;
    throw new Error("mode getter");
  },
};
show("mode getter throws", () => fs.mkdirSync(under("mode-throw"), dynamic(throwingMode)));
console.log("mode getter", modeReads, isDir("mode-throw"));
// Node reads each member twice when it is present: once to test it against
// undefined and once for its value.
let recursiveValueReads = 0;
const recursiveTrue = {
  get recursive() {
    recursiveValueReads += 1;
    return true;
  },
};
show("recursive getter value", () => fs.mkdirSync(under("rec-value/a"), dynamic(recursiveTrue)));
console.log("recursive reads", recursiveValueReads, isDir("rec-value/a"));
let modeValueReads = 0;
const modeValue = {
  get mode() {
    modeValueReads += 1;
    return 0o700;
  },
};
show("mode getter value", () => fs.mkdirSync(under("mode-value"), dynamic(modeValue)));
console.log("mode reads", modeValueReads, isDir("mode-value"), (fs.statSync(under("mode-value")).mode & 0o777).toString(8));
// The callback form reads the same ladder before it schedules anything.
try {
  fs.mkdir(under("cb-throw"), dynamic({ get recursive() { throw new Error("callback getter"); } }), (error) => {
    console.log("callback getter", error && error.message);
  });
} catch (error) {
  console.log("callback getter threw", error.message, isDir("cb-throw"));
}
fs.mkdir(under("cb-ok"), dynamic({ get recursive() { return false; }, get mode() { return 0o750; } }), (error) => {
  console.log("callback ok", error, isDir("cb-ok"), (fs.statSync(under("cb-ok")).mode & 0o777).toString(8));
});
setTimeout(() => fs.rmSync(root, { recursive: true, force: true }), 300);
