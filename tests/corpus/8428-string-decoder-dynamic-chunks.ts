// StringDecoder.write over a chunk that crossed the checked-dynamic
// boundary: a string passes through unchanged, an ArrayBufferView decodes,
// and anything else throws Node's ERR_INVALID_ARG_TYPE. The decoder state
// survives an interleaved string chunk.
import { StringDecoder } from "node:string_decoder";

// The chunk arrives untyped (a stream "data" payload), like pi's exec.ts.
function write(decoder: StringDecoder, chunk: any): string {
  return decoder.write(chunk);
}

const decoder = new StringDecoder("utf8");
console.log(JSON.stringify(write(decoder, "plain")));
console.log(JSON.stringify(write(decoder, Buffer.from([0x61, 0xe2]))));
console.log(JSON.stringify(write(decoder, Buffer.from([0x82, 0xac, 0x62]))));
console.log(JSON.stringify(write(decoder, "mid")));
try {
  write(decoder, 123);
} catch (e) {
  const err = e as Error;
  console.log(err.name, (err as NodeJS.ErrnoException).code, err.message);
}
try {
  write(decoder, {});
} catch (e) {
  const err = e as Error;
  console.log(err.name, (err as NodeJS.ErrnoException).code, err.message);
}
const ender = new StringDecoder("base64");
console.log(JSON.stringify(write(ender, Buffer.from([0x66]))));
console.log(JSON.stringify(ender.end()));
// end(chunk) is write(chunk) followed by the flush, over the same dynamic
// chunk shapes.
function endWith(decoder: StringDecoder, chunk: any): string {
  return decoder.end(chunk);
}
const tail = new StringDecoder("utf8");
console.log(JSON.stringify(write(tail, "x")));
console.log(JSON.stringify(endWith(tail, Buffer.from([0xe2, 0x82]))));
console.log(JSON.stringify(endWith(new StringDecoder("utf8"), "mid")));
try {
  endWith(new StringDecoder("utf8"), 123);
} catch (e) {
  const err = e as Error;
  console.log(err.name, (err as NodeJS.ErrnoException).code, err.message);
}
// end(undefined) only flushes; null is not a chunk.
const flushed = new StringDecoder("utf8");
console.log(JSON.stringify(write(flushed, Buffer.from([0x61, 0xe2, 0x82]))));
console.log(JSON.stringify(endWith(flushed, undefined)));
try {
  endWith(new StringDecoder("utf8"), null);
} catch (e) {
  const err = e as Error;
  console.log(err.name, (err as NodeJS.ErrnoException).code, err.message);
}
// An ArrayBuffer or SharedArrayBuffer is not an ArrayBufferView.
for (const chunk of [new ArrayBuffer(2), new SharedArrayBuffer(2)]) {
  try {
    write(new StringDecoder("utf8"), chunk);
  } catch (e) {
    const err = e as Error;
    console.log(err.name, (err as NodeJS.ErrnoException).code, err.message);
  }
  try {
    endWith(new StringDecoder("utf8"), chunk);
  } catch (e) {
    const err = e as Error;
    console.log(err.name, (err as NodeJS.ErrnoException).code, err.message);
  }
}
