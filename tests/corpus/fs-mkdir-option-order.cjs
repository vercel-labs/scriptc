// The options object literal is constructed before mkdirSync runs, so its
// member initializers run in source order: a call in each member prints its
// name as it runs. Node reads recursive before mode only after that.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mkorder-"));
const under = (name) => path.join(root, name);
const log = [];
function recursiveValue() {
  log.push("recursive");
  return false;
}
function modeValue() {
  log.push("mode");
  return 0o700;
}
const result = fs.mkdirSync(under("recursive-first"), { recursive: recursiveValue(), mode: modeValue() });
console.log("recursive first", log.join(","), result === undefined);
console.log("dir", fs.statSync(under("recursive-first")).isDirectory(), (fs.statSync(under("recursive-first")).mode & 0o777).toString(8));
log.length = 0;
fs.mkdirSync(under("mode-first"), { mode: modeValue(), recursive: recursiveValue() });
console.log("mode first", log.join(","));
console.log("dir", fs.statSync(under("mode-first")).isDirectory());
// The path argument is evaluated before the options object.
log.length = 0;
function pathValue() {
  log.push("path");
  return under("path-first");
}
log.length = 0;
fs.mkdirSync(pathValue(), { recursive: recursiveValue(), mode: modeValue() });
console.log("path first", log.join(","));
console.log("dir", fs.statSync(under("path-first")).isDirectory());
// A throwing initializer stops the call before the later member runs.
log.length = 0;
function throwingRecursive() {
  log.push("throwing-recursive");
  throw new Error("recursive initializer");
}
try {
  fs.mkdirSync(under("throw-first"), { recursive: throwingRecursive(), mode: modeValue() });
} catch (error) {
  console.log("throw first", error.message, log.join(","));
}
log.length = 0;
try {
  fs.mkdirSync(under("throw-second"), { mode: modeValue(), recursive: throwingRecursive() });
} catch (error) {
  console.log("throw second", error.message, log.join(","));
}
console.log("stray dirs", fs.existsSync(under("throw-first")), fs.existsSync(under("throw-second")));
// A recursive-first initializer that assigns the variable the mode member
// reads: the initializer order decides the directory's mode. Both modes keep
// their owner bits under either a 022 or a 077 umask.
let mutableMode = 0o600;
function assigningRecursive() {
  mutableMode = 0o700;
  return false;
}
fs.mkdirSync(under("assigned-mode"), { recursive: assigningRecursive(), mode: mutableMode });
console.log("assigned mode", (fs.statSync(under("assigned-mode")).mode & 0o777).toString(8));
const modeHolder = { mode: 0o600 };
function assigningField() {
  modeHolder.mode = 0o700;
  return false;
}
fs.mkdirSync(under("assigned-field"), { recursive: assigningField(), mode: modeHolder.mode });
console.log("assigned field", (fs.statSync(under("assigned-field")).mode & 0o777).toString(8));
// A mode member written first still runs before the recursive member.
let recursiveFlag = false;
function assigningMode() {
  recursiveFlag = true;
  return 0o700;
}
function readingRecursive() {
  return recursiveFlag;
}
fs.mkdirSync(under("assigned-recursive/nested"), {
  mode: assigningMode(),
  recursive: readingRecursive(),
});
console.log("assigned recursive", fs.statSync(under("assigned-recursive/nested")).isDirectory());
fs.rmSync(root, { recursive: true, force: true });
