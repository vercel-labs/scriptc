// events.once and events.on over a readable stream's 'data' chunk. The
// stream emits a chunk through its own payload path (bytes, or an
// object-mode value), which has no checked-dynamic form for a typed
// listener, so both helpers register a checked-dynamic listener and the
// promise, or the iterator's value, carries the chunk itself.
import { Readable } from "node:stream";
import { once, on } from "node:events";

async function main(): Promise<void> {
  const bytes = new Readable({ read() {} });
  const chunk = once(bytes, "data");
  bytes.push(Buffer.from("hello"));
  const args = await chunk;
  console.log("once", args.length, Buffer.isBuffer(args[0]), (args[0] as Buffer).toString());

  const objects = new Readable({ objectMode: true, read() {} });
  const object = once(objects, "data");
  objects.push({ n: 1 });
  const settled = await object;
  console.log("object", JSON.stringify(settled[0]), settled.length);

  // The end of the stream closes the loop through the iterator's close
  // name.
  const streamed = Readable.from([Buffer.from("a"), Buffer.from("b")]);
  for await (const [part] of on(streamed, "data", { close: ["end"] })) {
    console.log("on", Buffer.isBuffer(part), (part as Buffer).toString());
  }

  // return() ends the iteration: the next() answer is done.
  const pushed = new Readable({ read() {} });
  const iterator = on(pushed, "data");
  pushed.push(Buffer.from("z"));
  console.log("next", JSON.stringify((await iterator.next()).value));
  const closed = await iterator.return();
  console.log("return", closed.done, (await iterator.next()).done);
}

void main();
