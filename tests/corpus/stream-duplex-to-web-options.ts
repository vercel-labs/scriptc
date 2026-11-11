// Duplex.toWeb on a live duplex whose readable side is disabled: Node builds
// the pair's readable as an already-cancelled ReadableStream over the
// caller's `type` (or `readableType`) option, and the writable side from the
// live duplex. The options bag is the caller's, so each conversion must leave
// it intact.
import { Duplex } from "node:stream";

function disabledDuplex(): Duplex {
  return new Duplex({
    readable: false,
    write(_chunk: Buffer, _enc: string, cb: () => void): void {
      cb();
    },
  });
}

async function describe(readable: ReadableStream, writable: WritableStream): Promise<void> {
  const reader = readable.getReader();
  const first = await reader.read();
  console.log(`read done ${String(first.done)} value ${String(first.value)}`);
  const writer = writable.getWriter();
  await writer.write("payload");
  await writer.close();
  console.log("wrote and closed");
}

async function main(): Promise<void> {
  const typed = disabledDuplex();
  console.log(`readable prop ${String(typed.readable)} writable prop ${String(typed.writable)}`);
  const typeOptions: { type: "bytes" } = { type: "bytes" };
  const byType = Duplex.toWeb(typed, typeOptions);
  await describe(byType.readable, byType.writable);
  console.log(`type option after ${String(typeOptions.type)}`);

  const typedByReadable = disabledDuplex();
  const readableOptions: { readableType: "bytes" } = { readableType: "bytes" };
  const byReadable = Duplex.toWeb(typedByReadable, readableOptions);
  await describe(byReadable.readable, byReadable.writable);
  console.log(`readableType option after ${String(readableOptions.readableType)}`);

  const untyped = disabledDuplex();
  const plain = Duplex.toWeb(untyped);
  await describe(plain.readable, plain.writable);
}

await main();
