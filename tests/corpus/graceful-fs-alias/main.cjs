// graceful-fs compiles as node:fs (its retry queue for EMFILE/ENFILE is
// the one documented difference): the same file operations, errors and
// callback order as under Node with the real package (vendored here,
// 4.2.11, ISC). gracefulify(fs) is a no-op statement in compiled programs.
const fs = require("graceful-fs");
const { readFileSync, writeFileSync } = require("graceful-fs");
const path = require("node:path");
const os = require("node:os");

fs.gracefulify(require("fs"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graceful-fs-alias-"));
const file = path.join(dir, "a.txt");
writeFileSync(file, "hello");
fs.appendFileSync(file, " world");
console.log(readFileSync(file, "utf8"), fs.existsSync(file), fs.statSync(file).size);
console.log(fs.readdirSync(dir));
try {
  fs.readFileSync(path.join(dir, "missing.txt"));
} catch (e) {
  console.log("sync", e.code, e.syscall);
}

fs.readFile(path.join(dir, "missing.txt"), "utf8", (err) => {
  console.log("callback", err.code);
  fs.writeFile(file, "rewritten", (werr) => {
    console.log("written", werr);
    fs.readFile(file, "utf8", (rerr, text) => {
      console.log("read", rerr, text);
      fs.rmSync(dir, { recursive: true });
      console.log("removed", fs.existsSync(dir));
    });
  });
});
console.log("scheduled");
