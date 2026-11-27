// Two outstanding reads with a small gzip payload that carries trailing
// junk: the first read answers the stream's bytes and the second rejects
// with the trailing-junk error. The error must reach the request that is
// already waiting — nothing pulls again after it is raised.

import { gzipSync } from "node:zlib";

const stream = new DecompressionStream("gzip");
const reader = stream.readable.getReader();
const writer = stream.writable.getWriter();
const first = reader.read();
const second = reader.read();
await writer.write(new Uint8Array(Buffer.concat([gzipSync(Buffer.from("alpha")), Buffer.from("junk")])));
const chunk = await first;
console.log("first", chunk.done ? "done" : (chunk.value as Uint8Array).length);
try {
  await second;
  console.log("second resolved");
} catch (error) {
  const e = error as Error & { code?: string };
  console.log("second", e.name, e.code);
}
