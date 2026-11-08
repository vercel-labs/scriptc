// The TypeScript twin of compat-core-members.mjs: single members of core
// modules with no program of their own, from a typed source. The name of
// an AsyncLocalStorage, the Blob constructor, MIMEType fields, the
// Timeout and Immediate handles, process.getActiveResourcesInfo(),
// fs.rm() with a callback, and the global console and process bindings.
// The deprecated buf.parent alias, the frsize field of a StatFs and the
// console property of the global object have no declaration, so this twin
// leaves them to the JavaScript program.
import { AsyncLocalStorage } from "node:async_hooks";
import { Blob } from "node:buffer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MIMEType } from "node:util";

console.log(new AsyncLocalStorage<number>({ name: "requests" }).name, new AsyncLocalStorage<number>().name);

const blob = new Blob(["ab", new Uint8Array([99])], { type: "text/plain" });
console.log(blob.size, blob.type, await blob.text(), blob instanceof Blob);

const mime = new MIMEType("text/html; charset=utf-8");
console.log(mime.type, mime.subtype, mime.essence, mime.params.get("charset"), String(mime));
mime.type = "application";
mime.subtype = "json";
console.log(mime.essence);

const timeout = setTimeout(() => {}, 1000);
console.log(typeof timeout.hasRef(), timeout.refresh() === timeout, timeout.unref() === timeout, timeout.hasRef(), timeout.ref() === timeout, timeout.hasRef());
console.log(process.getActiveResourcesInfo().includes("Timeout"));
clearTimeout(timeout);
const immediate = setImmediate(() => console.log("immediate ran"));
console.log(typeof immediate.hasRef(), immediate.unref() === immediate, immediate.ref() === immediate, immediate.hasRef());
await new Promise<void>((resolve) => setImmediate(resolve));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compat-core-"));
fs.mkdirSync(path.join(dir, "a"));
fs.writeFileSync(path.join(dir, "a", "f"), "x");
await new Promise<void>((resolve) =>
  fs.rm(dir, { recursive: true, force: true }, (error) => {
    console.log(error, fs.existsSync(dir));
    fs.rm(path.join(dir, "missing"), (missing) => {
      console.log(missing?.code, missing?.syscall);
      resolve();
    });
  }),
);

console.log(typeof console, typeof console.log);
console.log(typeof process, typeof process.pid);
