// bytes() from node:stream/consumers in typed code: a Uint8Array of every
// chunk, with the rejection for a stream that fails.
import { PassThrough, Readable } from "node:stream";
import { buffer, bytes } from "node:stream/consumers";

function show(view: Uint8Array): string {
  return `${Buffer.isBuffer(view)} ${view.length} [${Array.from(view).join(",")}]`;
}

async function main(): Promise<void> {
  const view: Uint8Array = await bytes(Readable.from([Buffer.from("ab"), Buffer.from("c")]));
  console.log("buffers", show(view));
  console.log("strings", show(await bytes(Readable.from(["hé", "llo"]))));
  console.log("empty", show(await bytes(Readable.from([]))));
  const asBuffer: Buffer = await buffer(Readable.from([Buffer.from("abc")]));
  console.log("as buffer", show(asBuffer), asBuffer.toString());

  const through = new PassThrough();
  const pending = bytes(through);
  through.write("one ");
  setImmediate(() => through.end("two"));
  const late = await pending;
  console.log("late", show(late), Buffer.from(late).toString());

  const failing = new PassThrough();
  const rejected = bytes(failing);
  failing.destroy(new Error("source failed"));
  try {
    await rejected;
    console.log("failing resolved");
  } catch (error) {
    console.log("failing rejected", error instanceof Error ? error.message : "?");
  }
}

main();
