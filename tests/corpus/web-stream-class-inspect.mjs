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

// A released writer's inspection throws its invalid-state TypeError (its
// desiredSize getter does), as Node's inspector does.
const released = new WritableStream().getWriter();
released.releaseLock();
try {
  inspect(released);
  console.log("released-writer no-throw");
} catch (error) {
  console.log("released-writer", error.name, error.code, error.message);
}
console.log("after-released");

// The same throw leaves an inspection that reaches the writer through a
// container: an array, an object field, and a bounded-depth inspect.
const nestedCases = [[released], { w: released }, [1, released, 2]];
for (const value of nestedCases) {
  try {
    inspect(value);
    console.log("nested no-throw");
  } catch (error) {
    console.log("nested", error.name, error.code, error.message);
  }
}
try {
  inspect([released], { depth: 1 });
  console.log("bounded no-throw");
} catch (error) {
  console.log("bounded", error.name, error.message);
}
console.log("after-nested");
