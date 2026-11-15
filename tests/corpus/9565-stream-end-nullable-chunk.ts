// writable.end(chunk) where the chunk's type admits null or undefined:
// Node writes the chunk only when it is neither. The stream ends with the
// chunk or without it by the value the call finds; the receiver, the chunk,
// the encoding and the callback are each evaluated once, in that order.
import { PassThrough } from "node:stream";

const order: string[] = [];

function collect(label: string, feed: (sink: PassThrough) => void): Promise<void> {
  return new Promise((resolve) => {
    const sink = new PassThrough();
    let seen = "";
    sink.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
    });
    sink.on("end", () => {
      console.log(label, JSON.stringify(seen));
      resolve();
    });
    feed(sink);
  });
}

const few = process.argv.length > 9;
const present: string | null = few ? null : "rinse\n";
const absent: string | null = few ? "rinse\n" : null;
const missing: string | undefined = few ? "rinse\n" : undefined;
const bytes: Buffer | null = few ? null : Buffer.from("soak\n");
const either: string | Buffer = few ? Buffer.from("x") : "wash\n";

await collect("string or null, a string", (sink) => sink.end(present));
await collect("string or null, null", (sink) => sink.end(absent));
await collect("null literal", (sink) => sink.end(null));
await collect("undefined literal", (sink) => sink.end(undefined));
await collect("string or undefined, undefined", (sink) => sink.end(missing));
await collect("buffer or null, a buffer", (sink) => sink.end(bytes));
await collect("string or buffer", (sink) => sink.end(either));
await collect("after a write", (sink) => {
  sink.write("first\n");
  sink.end(absent);
});
await collect("with an encoding", (sink) => {
  const hex: string | null = few ? null : "666978";
  sink.end(hex, "hex");
});
await collect("with a callback", (sink) => {
  sink.end(absent, () => {
    order.push("callback");
  });
});
await collect("in order", (sink) => {
  const target = (): PassThrough => {
    order.push("stream");
    return sink;
  };
  const pick = (): string | null => {
    order.push("chunk");
    return present;
  };
  console.log(target().end(pick()) === sink);
});
console.log(order.join(","));
