// fs.realpath.native: Node's realpath binding under a second name. It
// answers the same resolved path as fs.realpath, keeps its own name
// (empty, as the binding's is) and length 3, takes the encoding options,
// and reports a missing path to the callback.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realpath-native-"));
const file = path.join(dir, "a.txt");
fs.writeFileSync(file, "hello");

console.log("name", JSON.stringify(fs.realpath.name), JSON.stringify(fs.realpath.native.name));
console.log("length", fs.realpath.length, fs.realpath.native.length);

const indirect = path.join(dir, ".", "a.txt");

const steps = [
  (next) =>
    fs.realpath.native(indirect, (error, resolved) => {
      console.log("native", error, path.basename(resolved), path.isAbsolute(resolved));
      next();
    }),
  (next) =>
    fs.realpath(indirect, (error, resolved) => {
      console.log("plain", error, path.basename(resolved), path.isAbsolute(resolved));
      next();
    }),
  (next) =>
    fs.realpath.native(indirect, "utf8", (error, resolved) => {
      console.log("encoding", error, typeof resolved, path.basename(resolved));
      next();
    }),
  (next) =>
    fs.realpath.native(indirect, { encoding: "buffer" }, (error, resolved) => {
      console.log("buffer", error, resolved instanceof Buffer, path.basename(resolved.toString()));
      next();
    }),
  (next) =>
    fs.realpath.native(path.join(dir, "missing"), (error, resolved) => {
      console.log("missing", error && error.code, error && error.syscall, resolved);
      next();
    }),
  (next) =>
    fs.realpath.native(dir, (error, resolved) => {
      console.log("directory", error, path.basename(resolved) === path.basename(dir));
      next();
    }),
  (next) => {
    const saved = fs.realpath.native;
    saved(indirect, (error, resolved) => {
      console.log("saved", error, path.basename(resolved));
      next();
    });
  },
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
