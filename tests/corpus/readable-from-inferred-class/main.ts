// A TypeScript entry over a JavaScript module. The checker infers the class
// of `outer.inner.make(...)` from the JavaScript source, and the value comes
// back from an untyped member: Readable.from builds its stream from the
// class's [Symbol.asyncIterator]() on that instance.
import { Readable } from "node:stream";
import { Outer } from "./frames.cjs";

async function run(): Promise<void> {
  const outer = new Outer();
  const chunks: string[] = [];
  for await (const chunk of Readable.from(outer.inner.make(["a", "b", "c"]))) {
    chunks.push(String(chunk));
  }
  console.log(chunks.join(" "));
  const stream = Readable.from(outer.inner.make([]));
  let count = 0;
  for await (const _chunk of stream) count++;
  console.log("empty", count, stream.destroyed);
}

run().then(() => console.log("done"));
