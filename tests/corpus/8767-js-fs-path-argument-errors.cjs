// In a JavaScript source an untyped path of a synchronous fs function is
// validated as Node validates it: a string, a file: URL or a Uint8Array is
// the path, and any other value throws ERR_INVALID_ARG_TYPE under Node's
// parameter name.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

function shape(label, fn) {
  try {
    console.log(label, "ok", JSON.stringify(fn()));
  } catch (e) {
    console.log(label, e instanceof TypeError, e.name, e.code, JSON.stringify(e.message));
  }
}
const untyped = (value) => value;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-path-"));
const file = path.join(dir, "text.txt");
fs.writeFileSync(file, "text");

// What Node accepts still reads.
shape("string", () => fs.readFileSync(untyped(file), "utf8"));
shape("url", () => fs.readFileSync(untyped(pathToFileURL(file)), "utf8"));
shape("bytes", () => fs.readFileSync(untyped(Buffer.from(file)), "utf8"));
shape("typed array", () => fs.readFileSync(untyped(new Uint8Array(Buffer.from(file))), "utf8"));
shape("stat string", () => fs.statSync(untyped(file)).size);
shape("stat url", () => fs.statSync(untyped(pathToFileURL(file))).size);

// What it rejects, by the kind of value.
shape("read object", () => fs.readFileSync({}));
shape("read null", () => fs.readFileSync(untyped(null), "utf8"));
shape("read undefined", () => fs.readFileSync(undefined));
shape("read boolean", () => fs.readFileSync(true));
shape("read array", () => fs.readFileSync(untyped([file]), "utf8"));
shape("read function", () => fs.readFileSync(untyped(function named() {})).length);
shape("read symbol", () => fs.readFileSync(untyped(Symbol("s"))).length);

// The other synchronous functions, under Node's names.
shape("stat object", () => {
  fs.statSync({});
  return "no throw";
});
shape("stat number", () => {
  fs.statSync(5);
  return "no throw";
});
shape("lstat", () => {
  fs.lstatSync(untyped(null));
  return "no throw";
});
shape("readdir", () => fs.readdirSync(untyped(1)).length);
shape("opendir", () => {
  fs.opendirSync(untyped([]));
  return "no throw";
});
shape("open", () => fs.openSync(untyped({}), "r"));
shape("mkdir", () => fs.mkdirSync({}));
shape("mkdtemp", () => fs.mkdtempSync(untyped(4)));
shape("unlink", () => fs.unlinkSync([]));
shape("rmdir", () => fs.rmdirSync(untyped(false)));
shape("rm", () => fs.rmSync(untyped(null)));
shape("write", () => fs.writeFileSync({}, "x"));
shape("append", () => fs.appendFileSync(untyped(null), "x"));
shape("chmod", () => fs.chmodSync(untyped({}), 0o644));
shape("chown", () => fs.chownSync(untyped(true), 0, 0));
shape("lchown", () => fs.lchownSync(untyped([]), 0, 0));
shape("access", () => fs.accessSync(untyped(undefined)));
shape("realpath native", () => fs.realpathSync.native(untyped(3)));
shape("rename first", () => fs.renameSync(untyped(1), file));
shape("rename second", () => fs.renameSync(file, untyped(2)));
shape("copy first", () => fs.copyFileSync(untyped({}), file));
shape("copy second", () => fs.copyFileSync(file, untyped(null)));

// readFileSync, writeFileSync and appendFileSync first ask whether the
// value is a descriptor, which converts it to a number: a symbol throws
// that conversion's TypeError, and an object's own conversion runs once.
shape("write symbol", () => fs.writeFileSync(untyped(Symbol("w")), "x"));
shape("append symbol", () => fs.appendFileSync(untyped(Symbol("a")), "x"));
let conversions = 0;
const counting = {
  valueOf() {
    conversions++;
    return 3;
  },
};
shape("read converting object", () => fs.readFileSync(untyped(counting), "utf8"));
console.log("conversions", conversions);
// A DataView is not a Uint8Array to Node's check.
shape("stat DataView", () => {
  fs.statSync(untyped(new DataView(new ArrayBuffer(4))));
  return "no throw";
});
shape("read DataView", () => fs.readFileSync(untyped(new DataView(new ArrayBuffer(4))), "utf8"));
shape("stat symbol", () => {
  fs.statSync(untyped(Symbol("p")));
  return "no throw";
});

// A descriptor where Node reads one works from a typed number; through an
// untyped value it is refused by name instead of read.
const fd = fs.openSync(file, "r");
console.log("typed descriptor", fs.readFileSync(fd, "utf8"));
const native = process.versions.v8 === undefined;
let outcome;
try {
  outcome = fs.readFileSync(untyped(fd), "utf8");
} catch (e) {
  outcome = e.code;
}
console.log("untyped descriptor", outcome === (native ? "SC2020" : ""));
fs.closeSync(fd);

// Node hands a Uint8Array's bytes to the system as they are. A path here is
// UTF-8 text, so bytes that are not are refused by name instead of naming
// another file.
let bytesOutcome;
try {
  fs.statSync(untyped(Buffer.from([0x66, 0xff, 0x6f])));
  bytesOutcome = "found";
} catch (e) {
  bytesOutcome = e.code;
}
console.log("bytes that are not UTF-8", bytesOutcome === (native ? "SC2020" : "ENOENT"));

fs.rmSync(dir, { recursive: true, force: true });
