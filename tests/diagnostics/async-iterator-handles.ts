import { Readable } from "node:stream";

// The web stream's values() iterator is a first-class static value; the
// node Readable's iterator() handle is not.
const nodeIterator = Readable.from(["a"]).iterator();
const webIterator = ReadableStream.from([1]).values();
console.log(nodeIterator, webIterator);
// Direct loop consumption remains available without materializing the node handle.

// Cleanup policy changes the emitted graph and must therefore be a literal.
async function consume(flag: boolean): Promise<void> {
  for await (
    const value of Readable.from([1]).iterator({ destroyOnReturn: flag })
  ) {
    console.log(value);
  }
  for await (
    const value of ReadableStream.from([1]).values({ preventCancel: flag })
  ) {
    console.log(value);
  }
}

void consume(false);
