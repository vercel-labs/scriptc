// The CommonJS spellings of compat-js-value-reads.mjs: a destructured
// require(), a member of the exports object and a member of the global
// object read what the named import reads, and a name the exports object
// does not have reads undefined.
"use strict";
const { register, isBuiltin, noSuchExport } = require("node:module");
const moduleExports = require("node:module");
const { AsyncResource } = require("node:async_hooks");
const zlib = require("node:zlib");
const { Z_NO_FLUSH, constants } = require("node:zlib");
const { performance: importedPerformance } = require("node:perf_hooks");
const util = require("node:util");
const { promisify } = require("node:util");

const pass = (value) => value;

// A global Node 24 does not define by default.
console.log("storage", typeof localStorage, typeof sessionStorage, typeof global.localStorage);
console.log("storage branch", typeof sessionStorage === "undefined", "localStorage" in globalThis);
try {
  console.log(sessionStorage);
} catch (error) {
  console.log("storage read", error.name, error.message);
}

// The exports object has the non-enumerable constants an ES namespace lacks.
console.log("zlib", zlib.Z_NO_FLUSH, Z_NO_FLUSH, constants.Z_NO_FLUSH, typeof zlib.Z_BEST_COMPRESSION);

// Functions and classes native code has no value for.
console.log("register", typeof register, register.name, register.length);
console.log("register identity", register === moduleExports.register, pass(register) === register);
console.log("absent export", noSuchExport, moduleExports.noSuchExport, typeof moduleExports.noSuchExport);
console.log("isBuiltin", typeof isBuiltin, isBuiltin("fs"));
console.log("class", typeof AsyncResource, AsyncResource.name, AsyncResource.length);
console.log("promisify", typeof promisify, promisify === util.promisify, util.promisify.name);
const known = new Set([AsyncResource, register, promisify, URL, Blob]);
console.log("known", known.size, known.has(util.promisify), known.has(moduleExports.register));

// Global classes held as values.
const { Headers: HeadersValue, MessageChannel: ChannelValue } = globalThis;
console.log("globals", typeof HeadersValue, HeadersValue === Headers, HeadersValue.name);
console.log("globals", typeof ChannelValue, ChannelValue === MessageChannel, ChannelValue.name);
console.log("globals", typeof global.CryptoKey, global.SubtleCrypto.name, typeof globalThis.Crypto);

// process members.
console.log("process", process.debugPort, process.sourceMapsEnabled, process.connected, process.browser);
console.log("process", typeof process.abort, typeof process.finalization, typeof process.setSourceMapsEnabled);
const held = pass(process);
console.log("process value", typeof held, held === process, held === pass(global.process));
console.log("process value", typeof held.cwd, held.pid === process.pid, held.arch === process.arch);
console.log("process value", held.hrtime === process.hrtime, held.nextTick === process.nextTick, held.cwd === process.cwd);
console.log("commonjs global", typeof globalThis.require, typeof global.module, typeof globalThis.__filename);

// performance.
const clock = pass(performance);
console.log("performance", clock === importedPerformance, typeof clock.now, typeof clock.timeOrigin);
console.log("performance", performance.timeOrigin === clock.timeOrigin, performance.timeOrigin > 1e12);
