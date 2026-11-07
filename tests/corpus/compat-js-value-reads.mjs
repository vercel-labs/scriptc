// What a JavaScript source reads for a Node value: Node's own answer, or a
// value that carries Node's `typeof`, name, length and identity. Each block
// reads values (it calls none that native code refuses) and prints what Node
// prints.
import * as zlib from "node:zlib";
import zlibDefault from "node:zlib";
import * as moduleNamespace from "node:module";
import { register, isBuiltin } from "node:module";
import { AsyncResource } from "node:async_hooks";
import { performance as importedPerformance } from "node:perf_hooks";
import { promisify, format } from "node:util";
import { lookup } from "node:dns";

const pass = (value) => value;

// A global Node 24 does not define by default is not defined: `typeof`
// answers "undefined", the global object has no such property, and a bare
// read throws ReferenceError. A feature test takes Node's branch.
console.log("storage", typeof localStorage, typeof sessionStorage);
console.log("storage global", typeof globalThis.localStorage, globalThis.sessionStorage);
console.log("storage in", "localStorage" in globalThis, "sessionStorage" in globalThis);
// The CommonJS bindings are not properties of the global object, and an ES
// module has none of them.
console.log("commonjs", typeof require, typeof module, typeof exports, typeof __dirname);
console.log("commonjs global", typeof globalThis.require, typeof globalThis.module, globalThis.exports);
console.log("storage branch", typeof localStorage !== "undefined" ? "has storage" : "no storage");
try {
  console.log(localStorage);
} catch (error) {
  console.log("storage read", error.name, error.message);
}
try {
  sessionStorage.getItem("key");
} catch (error) {
  console.log("storage member", error instanceof ReferenceError, error.message);
}

// An ES module namespace has exactly the module's exports: zlib's
// non-enumerable constants are on the exports object (the default import)
// and not on the namespace.
console.log("zlib namespace", zlib.Z_NO_FLUSH, typeof zlib.Z_BEST_COMPRESSION, zlib.Z_DEFAULT_STRATEGY);
console.log("zlib default", zlibDefault.Z_NO_FLUSH, typeof zlibDefault.Z_BEST_COMPRESSION);
console.log("zlib constants", zlib.constants.Z_NO_FLUSH, typeof zlib.constants.Z_BEST_COMPRESSION);
console.log("zlib in", "Z_NO_FLUSH" in zlib, "constants" in zlib, typeof zlib.gzipSync);

// A function native code has no value for reads as a function: `typeof`,
// name, length and identity across spellings are Node's.
console.log("register", typeof register, register.name, register.length);
console.log("register identity", register === moduleNamespace.register, pass(register) === register);
console.log("isBuiltin", typeof isBuiltin, isBuiltin("node:fs"), isBuiltin("left-pad"));
console.log("class", typeof AsyncResource, AsyncResource.name, AsyncResource.length);
const known = new Set([AsyncResource, register, URL, Headers]);
console.log("known", known.size, known.has(AsyncResource), known.has(register), known.has(URL), known.has(Request));
console.log("library functions", typeof promisify, promisify.name, typeof format, format.name, typeof lookup);

// Classes native code implements, held as values: functions with Node's
// names, one identity per class.
const tools = { URL, Headers, AbortController, TextEncoder };
console.log("tools", typeof tools.URL, tools.URL === URL, tools.URL.name, tools.URL.length);
console.log("tools names", Object.keys(tools).map((key) => `${key}:${typeof tools[key]}:${tools[key].name}`).join(" "));
console.log("tools global", pass(globalThis.Headers) === Headers, typeof pass(Response), pass(Event).name);

// process members Node answers with constants, and names it does not have.
console.log("process constants", process.debugPort, process.sourceMapsEnabled, process.connected);
console.log("process absent", process.browser, typeof process.electronBinding, process.channel);
console.log("process functions", typeof process.abort, process.abort.name, process.abort.length);
console.log("process functions", typeof process.setSourceMapsEnabled, typeof process.reallyExit);

// performance.timeOrigin: the wall-clock time of the clock's zero.
const origin = performance.timeOrigin;
console.log("timeOrigin", typeof origin, origin > 1e12, origin === performance.timeOrigin);
console.log("timeOrigin clock", Math.abs(origin + performance.now() - Date.now()) < 1000);

// The process and performance objects as values: one object each, with
// Node's members.
const held = pass(process);
console.log("process value", typeof held, held === process, pass(globalThis.process) === held);
console.log("process value members", typeof held.cwd, typeof held.exit, typeof held.nextTick, typeof held.on);
console.log("process value data", held.pid === process.pid, held.platform === process.platform, held.debugPort);
console.log("process value in", "argv" in held, "versions" in held, "browser" in held, held.browser);
// A function member of the held object is the function the spelled member
// reads, and a call through the held object runs it.
console.log("process value identity", held.hrtime === process.hrtime, held.nextTick === process.nextTick);
console.log("process value identity", held.getBuiltinModule === process.getBuiltinModule, held.cwd === process.cwd);
console.log("process value calls", held.hrtime().length, typeof held.hrtime.bigint(), held.cwd() === process.cwd());
console.log("process value calls", held.getBuiltinModule("node:path").sep, held.getBuiltinModule("node:path") === process.getBuiltinModule("path"));
held.nextTick(() => console.log("process value tick"));
const clock = pass(performance);
console.log("performance value", typeof clock, clock === performance, clock === importedPerformance);
console.log("performance value members", typeof clock.now, typeof clock.mark, "timeOrigin" in clock, clock.timeOrigin === origin);
console.log("globals", new Set([process, performance, crypto, navigator, console]).size);

// A SubtleCrypto destructured from the WebCrypto object keeps its methods.
const { subtle } = globalThis.crypto;
const digest = await subtle.digest("SHA-256", new Uint8Array([1, 2, 3]));
console.log("subtle", typeof subtle, typeof subtle.digest, Buffer.from(digest).toString("hex").slice(0, 16));
const { subtle: again } = crypto;
console.log("subtle identity", subtle === again, subtle === crypto.subtle);
const { Console } = console;
console.log("console", typeof Console, Console.name);
