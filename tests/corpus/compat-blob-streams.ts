// Blob.stream() and Blob.textStream(): the chunk cadence Node reads a
// Blob's parts with, the zero-length parts it skips, the streaming
// decoder across a split sequence, the BYOB reads a byte stream answers,
// cancellation, and the same readers on a File.
import { Blob, Buffer, File } from "node:buffer";

async function byteChunks(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const out: string[] = [];
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    out.push("u8 " + Buffer.from(step.value).toString("hex") + " " + step.value.length);
  }
  return out.length ? out.join("|") : "(none)";
}

async function textChunks(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  const out: string[] = [];
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    out.push(JSON.stringify(step.value));
  }
  return out.length ? out.join("|") : "(none)";
}

async function main() {
  // One chunk per non-empty part, in order.
  const mixed = new Blob(["ab", "", "cd", new Uint8Array([0xff])]);
  console.log("mixed", mixed.size, await byteChunks(mixed.stream()));
  console.log("empty", await byteChunks(new Blob([]).stream()));
  console.log("single", await byteChunks(new Blob(["abc"]).stream()));

  // A stream is locked once it has a reader.
  const locked = mixed.stream();
  const held = locked.getReader();
  console.log("locked", locked.locked, mixed.stream().locked);
  held.releaseLock();
  console.log("released", locked.locked, await byteChunks(locked));

  // textStream decodes part by part, holding a split sequence until the
  // part that completes it, and strips a leading BOM.
  const split = new Blob([new Uint8Array([0xe2]), new Uint8Array([0x82, 0xac])]);
  console.log("split", await textChunks(split.textStream()));
  const bom = new Blob([new Uint8Array([0xef, 0xbb, 0xbf, 0x41])]);
  console.log("bom", await textChunks(bom.textStream()));
  const invalid = new Blob([new Uint8Array([0x41, 0xff])]);
  console.log("invalid", await textChunks(invalid.textStream()));
  console.log("emptyText", await textChunks(new Blob(["", "x", ""]).textStream()));
  console.log("emptyBlobText", await textChunks(new Blob([]).textStream()));
  const tail = new Blob([new Uint8Array([0x41, 0xf0, 0x9f])]);
  console.log("truncated", await textChunks(tail.textStream()));

  // A File answers the same streams.
  const file = new File(["hi", "there"], "note.txt");
  console.log("file", file.size, file.name, await byteChunks(file.stream()));
  console.log("fileText", await textChunks(file.textStream()));

  // Byte streams take BYOB reads; a read past the end is done.
  const byob = new Blob(["abcdef"]).stream();
  const byobReader = byob.getReader({ mode: "byob" });
  const first = await byobReader.read(new Uint8Array(4));
  console.log("byob1", first.done, first.value === undefined ? "none" : Buffer.from(first.value).toString("hex"));
  const second = await byobReader.read(new Uint8Array(4));
  console.log("byob2", second.done, second.value === undefined ? "none" : Buffer.from(second.value).toString("hex"));
  const third = await byobReader.read(new Uint8Array(4));
  console.log(
    "byob3",
    third.done,
    third.value === undefined ? "none" : "len " + third.value.length,
  );

  // Cancelling resolves undefined and closes the stream.
  const canceled = new Blob(["abc"]).stream();
  const plain = canceled.getReader();
  console.log("cancel", await plain.cancel("why"), canceled.locked);
  const after = await plain.read();
  console.log("afterCancel", after.done, after.value === undefined ? "none" : "value");

  // A read taken before the cancel still settles.
  const reading = new Blob(["abc", "def"]).stream().getReader();
  const firstRead = reading.read();
  console.log("cancelPending", await reading.cancel());
  const firstStep = await firstRead;
  console.log(
    "pendingStep",
    firstStep.done,
    firstStep.done ? "none" : Buffer.from(firstStep.value).toString(),
  );

  // The stream is a real ReadableStream.
  console.log(
    "brand",
    Object.prototype.toString.call(mixed.stream()),
    mixed.stream() instanceof ReadableStream,
  );
}

await main();
