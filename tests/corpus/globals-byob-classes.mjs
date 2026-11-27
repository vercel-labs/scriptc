// The byte-stream classes the globals chapter documents: a byte
// ReadableStream's byob controller and reader, and the BYOB reader a
// `{ mode: "byob" }` reader request builds.
console.log(
  "typeof",
  typeof ReadableByteStreamController,
  typeof ReadableStreamBYOBReader,
  typeof ReadableStreamBYOBRequest
);

let controller = null;
const first = new ReadableStream({
  type: "bytes",
  start(c) {
    controller = c;
    c.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
    c.close();
  },
});
console.log("controller", controller instanceof ReadableByteStreamController, controller.byobRequest);

const reader = first.getReader({ mode: "byob" });
const a = await reader.read(new Uint8Array(4));
console.log("read", a.done, Array.from(a.value));
const b = await reader.read(new Uint8Array(4));
console.log("read2", b.done, Array.from(b.value));

const second = new ReadableStream({
  type: "bytes",
  pull(c) {
    c.enqueue(new Uint8Array([9, 8]));
    c.close();
  },
});
const direct = new ReadableStreamBYOBReader(second);
console.log("direct", direct instanceof ReadableStreamBYOBReader);
const c2 = await direct.read(new Uint8Array(2));
console.log("direct read", c2.done, Array.from(c2.value));
