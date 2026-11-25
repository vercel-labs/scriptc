// bytes() from node:stream/consumers: every chunk of a readable stream as
// one Uint8Array, which is not a Buffer. buffer() beside it for the same
// input, and the rejections: the stream's own error and an early close.
import { PassThrough, Readable } from "node:stream";
import { buffer, bytes, text } from "node:stream/consumers";

const show = (view) =>
  `${view instanceof Uint8Array} ${Buffer.isBuffer(view)} ${view.length} [${Array.from(view).join(",")}]`;

console.log("buffers", show(await bytes(Readable.from([Buffer.from("ab"), Buffer.from("c")]))));
console.log("strings", show(await bytes(Readable.from(["hé", "llo"]))));
console.log("empty", show(await bytes(Readable.from([]))));
console.log("as buffer", show(await buffer(Readable.from([Buffer.from("ab"), Buffer.from("c")]))));

// Chunks written after the consumer started.
{
  const through = new PassThrough();
  const pending = bytes(through);
  through.write("one ");
  setImmediate(() => through.end("two"));
  const view = await pending;
  console.log("late", show(view), Buffer.from(view).toString());
}

// A stream that arrives through a function parameter.
{
  const collect = (source) => bytes(source);
  const read = (source) => text(source);
  console.log("untyped bytes", show(await collect(Readable.from(["ab", "c"]))));
  console.log("untyped text", await read(Readable.from(["a", "b"])));
  console.log("untyped buffer", show(await ((source) => buffer(source))(Readable.from(["xy"]))));
}

// The result is its own storage: changing it leaves the chunk alone.
{
  const chunk = Buffer.from("xyz");
  const view = await bytes(Readable.from([chunk]));
  view[0] = 65;
  console.log("copy", chunk.toString(), Buffer.from(view).toString());
}

// A stream that fails rejects with its error; one destroyed before its end
// rejects with a premature close.
{
  const failing = new PassThrough();
  const pending = bytes(failing);
  failing.write("partial");
  failing.destroy(new Error("source failed"));
  try {
    await pending;
    console.log("failing resolved");
  } catch (error) {
    console.log("failing rejected", error.message);
  }

  const closing = new PassThrough();
  const early = bytes(closing);
  closing.destroy();
  try {
    await early;
    console.log("closing resolved");
  } catch (error) {
    console.log("closing rejected", error.code);
  }
}
