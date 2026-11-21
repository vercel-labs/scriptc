// Duplex.fromWeb options: allowHalfOpen, objectMode, encoding, decodeStrings,
// highWaterMark and signal each take effect on the Duplex, which owns the
// pair's reader and writer.
import { Duplex, getDefaultHighWaterMark } from "node:stream";

const log = [];

const plainBody = new TransformStream();
const plain = Duplex.fromWeb(
  { readable: plainBody.readable, writable: plainBody.writable },
  { objectMode: true },
);
log.push(
  `object default ${plain.readableHighWaterMark} ${plain.writableHighWaterMark} ${getDefaultHighWaterMark(true)}`,
);

const body = new TransformStream();
const duplex = Duplex.fromWeb(
  { readable: body.readable, writable: body.writable },
  { objectMode: true, highWaterMark: 2, decodeStrings: false, allowHalfOpen: true },
);
log.push(
  `props ${duplex.readableObjectMode} ${duplex.writableObjectMode} ${duplex.readableHighWaterMark} ${duplex.writableHighWaterMark} ${duplex.readableEncoding} ${duplex.allowHalfOpen}`,
);
const seen = [];
duplex.on("data", (chunk) => seen.push(typeof chunk === "string" ? `string:${chunk}` : `${typeof chunk}:${JSON.stringify(chunk)}`));
duplex.write({ a: 1 });
duplex.write([1, 2]);
await new Promise((resolve) => setTimeout(resolve, 20));
log.push(`seen ${seen.join("|")}`);

const encodedBody = new TransformStream();
const encoded = Duplex.fromWeb(
  { readable: encodedBody.readable, writable: encodedBody.writable },
  { encoding: "utf8" },
);
const decoded = [];
encoded.on("data", (chunk) => decoded.push(`${typeof chunk}:${chunk}`));
log.push(`encoding ${encoded.readableEncoding} ${encoded.readableObjectMode}`);
encoded.write(Buffer.from("hello"));
await new Promise((resolve) => setTimeout(resolve, 20));
log.push(`decoded ${decoded.join("|")}`);

const controller = new AbortController();
const signalledBody = new TransformStream();
const signalled = Duplex.fromWeb(
  { readable: signalledBody.readable, writable: signalledBody.writable },
  { signal: controller.signal },
);
const errored = new Promise((resolve) =>
  signalled.on("error", (error) => resolve(`${error.name} ${error.code}`)),
);
controller.abort(new Error("stop"));
log.push(`signal ${await errored} destroyed ${signalled.destroyed}`);

for (const line of log) console.log(line);
