// util.inspect of the web stream classes: each instance prints as its class
// plus the fields Node's custom inspectors report, in Node's order — a
// stream's locked flag, state and byte support, a reader's parked requests
// and closed promise, a writer's promises and desired size, a transform's
// two sides and backpressure, a text stream's encoding and flags, and a
// queuing strategy's high-water mark.
import { inspect } from "node:util";

const show = (label, value) => console.log(label, inspect(value));

show("readable", new ReadableStream());
const locked = new ReadableStream({ start(c) { c.enqueue(1); } });
locked.getReader();
show("readable-locked", locked);
show("readable-bytes", new ReadableStream({ type: "bytes" }));
show("readable-closed", new ReadableStream({ start(c) { c.close(); } }));
show("readable-errored", new ReadableStream({ start(c) { c.error(new Error("x")); } }));
show("writable", new WritableStream());
show("transform", new TransformStream());
show("count", new CountQueuingStrategy({ highWaterMark: 2 }));
show("bytes-strategy", new ByteLengthQueuingStrategy({ highWaterMark: 16 }));
show("encoder", new TextEncoderStream());
show("decoder", new TextDecoderStream());
show("reader", new ReadableStream().getReader());
show("writer", new WritableStream().getWriter());

// console.log prints the same shape.
console.log("console", new ReadableStream());
console.log("console-encoder", new TextEncoderStream());
