// A binding that names a global object and owns no storage reads, as a
// value, what the global's own name reads: the same object.
var process = global.process;
const same = process;
const proc = require("node:process");
const Fn = Function;
var Buf = require("buffer").Buffer;

function usable(p) {
  return p && typeof p === "object" && typeof p.on === "function" && typeof p.pid === "number";
}

function kindOf(value) {
  return typeof value;
}

function holds(table) {
  return table.any === proc && table.any.pid === same.pid;
}

console.log(usable(process), usable(same), usable(proc), kindOf(same), kindOf(proc));
console.log(same === process, same === proc, same === globalThis.process, proc === global.process);
console.log(typeof same.platform, same.platform === proc.platform, same.argv.length > 0, same.pid === proc.pid);

// Held in an object and passed on.
const table = { any: same, sub: false };
console.log(holds(table), kindOf(table.any), Object.keys(table).join(","));

// Members the binding reads directly keep working beside the value reads.
console.log(typeof process.nextTick, process.argv.length > 0, typeof proc.hrtime);

// Constructors behind a binding.
const intrinsics = { "%Function%": Fn, "%Buffer%": Buf };
console.log(kindOf(Fn), Fn === Function, intrinsics["%Function%"] === Function, Fn.name);
console.log(kindOf(Buf), Buf === Buffer, intrinsics["%Buffer%"] === Buffer, Buf.name);
