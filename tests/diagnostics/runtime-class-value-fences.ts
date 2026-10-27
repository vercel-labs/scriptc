// Values of EventEmitter, the stream classes and the error classes
// construct, test instanceof and answer typeof, .name and ===. These uses
// report at the use.
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const R: typeof Readable = Readable;
const configured = new R({ read() {} });
console.log(configured.readable);

const C: typeof EventEmitter = EventEmitter;
console.log(C);
const boxed: unknown = Readable;
console.log(boxed !== undefined, C.defaultMaxListeners);

// TypeScript types this array as RangeErrorConstructor[] (the error
// constructor interfaces are structurally identical); annotate it as
// ErrorConstructor[].
const errorMix = [TypeError, RangeError];
console.log(errorMix.length);

const aggregates = [AggregateError];
console.log(aggregates.length);
