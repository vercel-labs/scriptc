// Node answers a Buffer from every file read. The brand is observable:
// Buffer.isBuffer, .constructor, inspect (a Uint8Array slot still prints
// Node's <Buffer ..> form) and Buffer's own numeric search semantics.
// scr_lib.c sets it in the build a program that can observe it selects; the
// dynamic and callback forms brand already. The scratch file is per process:
// the harness runs Node and the native binary concurrently in one cwd.
import {
  closeSync,
  openSync,
  readFile as readFileCallback,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";

function tail(path: string): string {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") {
    i = i - 1;
  }
  return path.slice(i + 1);
}
const file = "tmp-fs-buffer-brand-" + tail(process.argv[1]) + "-" + process.pid;
writeFileSync(file, "brand,ed");

const buf = readFileSync(file);
console.log("sync", Buffer.isBuffer(buf), buf.toString(), buf.subarray(1, 4).toString());
console.log("constructor", buf.constructor === Buffer.from("x").constructor);

const fd = openSync(file, "r");
try {
  const viaFd = readFileSync(fd);
  console.log("fd", Buffer.isBuffer(viaFd), viaFd.toString());
} finally {
  closeSync(fd);
}

// A plain Uint8Array stays unbranded; Buffer.from brands a copy.
const plain = new Uint8Array([104, 105]);
console.log("plain", Buffer.isBuffer(plain), Buffer.isBuffer(Buffer.from(plain)));
console.log("plain constructor", plain.constructor === Buffer.from("x").constructor);

// Through unknown: the boxing keeps the brand.
function isBuffer(value: unknown): boolean {
  return Buffer.isBuffer(value);
}
const asUnknown: unknown = buf;
console.log("unknown", Buffer.isBuffer(asUnknown), isBuffer(buf), isBuffer(plain));

// A Uint8Array-typed slot holding the read's Buffer: Node's inspect still
// answers the Buffer form, and a numeric search keeps Buffer's semantics (a
// needle above 255 is a byte, a fractional needle truncates) instead of
// Uint8Array's element comparison.
const widened: Uint8Array = readFileSync(file);
console.log("widened", Buffer.isBuffer(widened));
console.log("widened inspect", widened);
console.log("widened search", widened.indexOf(114), widened.indexOf(44), widened.indexOf(300));
console.log("widened fractional", widened.indexOf(44.5), widened.lastIndexOf(114.9));
console.log("widened includes", widened.includes(98), widened.includes(354), widened.lastIndexOf(100));

// The promise form, and the callback form below it.
readFile(file).then((promised) => {
  console.log("promise", Buffer.isBuffer(promised), promised.toString());
  readFileCallback(file, {}, (err, data) => {
    if (err) throw err;
    console.log("callback", Buffer.isBuffer(data), data.toString());
    rmSync(file);
  });
});
