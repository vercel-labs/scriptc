// typeof of the objects the runtime keeps as numeric handles answers
// "object", as Node's does: readline interfaces, timers, async-local
// stores, diagnostics channels and event-loop histograms.
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { AsyncLocalStorage } from "node:async_hooks";
import * as dc from "node:diagnostics_channel";
import { monitorEventLoopDelay } from "node:perf_hooks";

const rl = readline.createInterface({ input: new PassThrough(), terminal: false });
const timeout = setTimeout(() => {}, 1);
const interval = setInterval(() => {}, 1000);
const immediate = setImmediate(() => {});
const store = new AsyncLocalStorage<number>();
const channel = dc.channel("handles");
const tracing = dc.tracingChannel("handles");
const histogram = monitorEventLoopDelay();
const wrapped: Number = 5;
console.log(typeof rl, typeof timeout, typeof interval, typeof immediate);
console.log(typeof store, typeof channel, typeof tracing, typeof histogram, typeof wrapped);
clearTimeout(timeout);
clearInterval(interval);
clearImmediate(immediate);
rl.close();
