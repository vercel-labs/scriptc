// The error classes and error codes Node's errors chapter documents, as a
// program meets them: the standard constructors with name, message, cause
// and stack, Error.captureStackTrace, the errors the language itself
// throws, and the class, name, code and message of the errors Node's own
// argument, range and system-call checks throw.
const fs = require("fs");
const path = require("path");
const { Buffer } = require("buffer");
const { EventEmitter } = require("events");

function shape(label, fn) {
  try {
    console.log(label, "ok", String(fn()));
  } catch (e) {
    console.log(label, [e.constructor.name, e.name, e.code, e.message, e instanceof Error].join(" | "));
  }
}

// The standard constructors.
const inner = new Error("inner");
function report(e, isOwnClass) {
  console.log(e.name, e.message, e.cause === inner, e instanceof Error, isOwnClass, String(e));
  console.log(typeof e.stack, e.stack.split("\n")[0], Object.prototype.toString.call(e));
}
const plain = new Error("boom", { cause: inner });
report(plain, plain instanceof Error);
const type = new TypeError("boom", { cause: inner });
report(type, type instanceof TypeError);
const range = new RangeError("boom", { cause: inner });
report(range, range instanceof RangeError);
const reference = new ReferenceError("boom", { cause: inner });
report(reference, reference instanceof ReferenceError);
const syntax = new SyntaxError("boom", { cause: inner });
report(syntax, syntax instanceof SyntaxError);
console.log(type instanceof RangeError, range instanceof TypeError, plain instanceof TypeError);
console.log(new Error("x").cause, "cause" in new Error("x"), new Error().message === "");

const holder = { label: "holder" };
Error.captureStackTrace(holder);
console.log(typeof holder.stack, typeof Error.stackTraceLimit);

// Errors the language throws.
shape("null read", () => null.x);
shape("undefined name", () => undefinedName);
shape("json", () => JSON.parse("{"));
shape("array length", () => new Array(-1));

// Node's argument and range checks: the code is part of the contract.
shape("ERR_OUT_OF_RANGE size", () => Buffer.alloc(-1));
shape("ERR_OUT_OF_RANGE offset", () => Buffer.from([1, 2, 3, 4]).readUInt8(9));
shape("ERR_BUFFER_OUT_OF_BOUNDS", () => Buffer.from([1, 2]).readUInt32LE(0));
shape("ERR_UNKNOWN_ENCODING", () => Buffer.from("x", "nope"));
shape("ERR_INVALID_ARG_TYPE list", () => Buffer.concat("x"));
shape("ERR_INVALID_ARG_TYPE listener", () => new EventEmitter().on("x", 5));
shape("ERR_INVALID_ARG_TYPE time", () => process.hrtime(5));
shape("ERR_INVALID_ARG_TYPE data", () => require("crypto").createHash("sha256").update(5));
shape("ERR_INVALID_ARG_VALUE", () => fs.readFileSync(__filename, { encoding: "nope" }));
shape("ERR_INVALID_URL", () => new URL("nope"));
shape("ERR_ENCODING_NOT_SUPPORTED", () => new TextDecoder("nope"));
shape("ERR_UNKNOWN_SIGNAL", () => process.kill(process.pid, "SIGNOPE"));
shape("ERR_UNHANDLED_ERROR", () => new EventEmitter().emit("error", "plain"));
shape("ERR_PARSE_ARGS_UNKNOWN_OPTION", () => require("util").parseArgs({ args: ["--nope"], options: {} }));
shape("ERR_OUT_OF_RANGE random", () => require("crypto").randomBytes(-1));
shape("digest", () => require("crypto").createHash("nope"));
shape("zlib", () => require("zlib").inflateSync(Buffer.from("zz")));

// System errors carry code, syscall, errno and path.
const missing = path.join(__dirname, "definitely-not-here");
try {
  fs.readFileSync(missing);
} catch (e) {
  console.log(e.code, e.syscall, typeof e.errno, e.errno < 0, e.path === missing);
  console.log(e.message === "ENOENT: no such file or directory, open '" + missing + "'", e instanceof Error, e.name);
}
try {
  fs.readdirSync(__filename);
} catch (e) {
  console.log(e.code, e.syscall, e.path === __filename);
}
try {
  fs.mkdirSync(__dirname);
} catch (e) {
  console.log(e.code, e.syscall, e.path === __dirname);
}
try {
  process.chdir(missing);
} catch (e) {
  console.log(e.code, e.syscall, e.message.startsWith("ENOENT: no such file or directory, chdir"));
}
