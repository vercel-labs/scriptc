const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mkopts-"));
const under = (name) => path.join(root, name);
function show(label, run) {
  try {
    const value = run();
    console.log(label, "ok", value === undefined ? "undefined" : typeof value);
  } catch (error) {
    console.log(label, "threw", error.name, error.code, error.message);
  }
}
const isDir = (name) => fs.existsSync(under(name));
let modeCalls = 0;
function modeExpression() {
  modeCalls += 1;
  return undefined;
}
show("mode undefined expression", () => fs.mkdirSync(under("mode-undefined"), { mode: modeExpression() }));
console.log("mode expression", modeCalls, isDir("mode-undefined"), (fs.statSync(under("mode-undefined")).mode & 0o777).toString(8));
function throwingMode() {
  throw new Error("mode expression");
}
show("mode throwing expression", () => fs.mkdirSync(under("mode-throw"), { mode: throwingMode() }));
console.log("mode throw dir", isDir("mode-throw"));
let recursiveCalls = 0;
function recursiveExpression() {
  recursiveCalls += 1;
  return undefined;
}
show("recursive undefined expression", () => fs.mkdirSync(under("rec-undefined"), { recursive: recursiveExpression() }));
console.log("recursive expression", recursiveCalls, isDir("rec-undefined"));
show("mode boolean", () => fs.mkdirSync(under("mode-boolean"), { mode: true }));
console.log("mode boolean dir", isDir("mode-boolean"));
show("recursive number", () => fs.mkdirSync(under("rec-number"), { recursive: 1 }));
show("recursive string", () => fs.mkdirSync(under("rec-string"), { recursive: "yes" }));
const nullMode = null;
show("mode null", () => fs.mkdirSync(under("mode-null"), { mode: nullMode }));
const nullRecursive = null;
show("recursive null", () => fs.mkdirSync(under("rec-null"), { recursive: nullRecursive }));
console.log("stray dirs", isDir("mode-boolean"), isDir("rec-number"), isDir("rec-string"), isDir("mode-null"), isDir("rec-null"));
fs.rmSync(root, { recursive: true, force: true });
