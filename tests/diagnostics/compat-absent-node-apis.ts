// Node APIs scriptc does not implement, one use each: every statement
// below is refused by name. The compatibility ledger cites this program
// for marking the rows a verified absence instead of an unverified
// registry gap.
import { AsyncResource } from "node:async_hooks";
import { Resolver } from "node:dns";
import { EventEmitterAsyncResource } from "node:events";
import { openAsBlob } from "node:fs";
import { findPackageJSON, register } from "node:module";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { Readable, Writable } from "node:stream";

// stream: the web-stream adapters going out.
const webReadable = Readable.toWeb(Readable.from(["a"]));
const webWritable = Writable.toWeb(new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
console.log(typeof webReadable, typeof webWritable);

// url: object URLs.
console.log(URL.createObjectURL(new Blob(["x"])));

// timers: closing a Timeout.
const timer = setTimeout(() => {}, 1);
timer.close();

// perf_hooks: the time origin and the observer.
console.log(performance.timeOrigin);
const observer = new PerformanceObserver(() => {});
observer.observe({ entryTypes: ["mark"] });

// process: source maps, the capture callback, finalization and ref counting.
process.setSourceMapsEnabled(true);
console.log(process.hasUncaughtExceptionCaptureCallback());
process.setUncaughtExceptionCaptureCallback(() => {});
process.finalization.register({ n: 1 }, () => {});
process.ref(timer);
process.unref(timer);

// module: loader hooks and package lookup.
register("./hooks.mjs", import.meta.url);
console.log(findPackageJSON("..", import.meta.url));

// async_hooks and events: async resources.
const resource = new AsyncResource("Probe");
console.log(resource.runInAsyncScope(() => 1), resource.asyncId());
const emitter = new EventEmitterAsyncResource({ name: "Probe" });
emitter.emit("x");

// fs: Blob-backed opens.
console.log(await openAsBlob("/tmp/x"));

// dns: a resolver instance.
const resolver = new Resolver();
resolver.cancel();
