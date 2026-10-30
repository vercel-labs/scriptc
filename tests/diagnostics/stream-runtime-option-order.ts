import { Writable } from "node:stream";

// Runtime decodeStrings and defaultEncoding values are read before the
// other option members are evaluated, while Node evaluates the members in
// order: a value after a member with effects refuses, and so does a value
// with effects after a member that reads a property those effects change.
let encoding = (process.env["STREAM_ENCODING"] ?? "utf8") as BufferEncoding;
let decode = process.env["STREAM_DECODE"] !== "0";
function bump(): number {
  encoding = "hex";
  decode = false;
  return 16;
}
const sink = new Writable({
  highWaterMark: bump(),
  defaultEncoding: encoding,
  write(_chunk, _encoding, done) {
    done();
  },
});
const other = new Writable({
  highWaterMark: bump(),
  decodeStrings: decode,
  write(_chunk, _encoding, done) {
    done();
  },
});
const sizes = { hwm: 16 };
function pickEncoding(): BufferEncoding {
  sizes.hwm = 1;
  return "hex";
}
const third = new Writable({
  highWaterMark: sizes.hwm,
  defaultEncoding: pickEncoding(),
  write(_chunk, _encoding, done) {
    done();
  },
});
sink.end();
other.end();
third.end();
