// readable.read(size): a size above 1GiB is ERR_OUT_OF_RANGE, a
// non-integer size goes through parseInt, and a size parseInt cannot read
// (no argument, NaN, Infinity) is the absent form that drains. Negative
// sizes read nothing.
import { Readable } from "node:stream";

function fresh() {
  const readable = new Readable({ read() {} });
  readable.push("abcd");
  return readable;
}

const show = (value) => (value === null ? "null" : String(value));

{
  for (const size of [0, 1.5, 2, -1, -1.5, NaN]) {
    const readable = fresh();
    try {
      console.log(String(size), "->", show(readable.read(size)), "len", readable.readableLength, "hwm", readable.readableHighWaterMark);
    } catch (err) {
      console.log(String(size), "threw", err.code, "|", err.message);
    }
  }
}
{
  // the absent form drains
  const readable = fresh();
  console.log("no argument ->", show(readable.read()), "len", readable.readableLength);
}
{
  const readable = fresh();
  console.log("Infinity ->", show(readable.read(Infinity)), "len", readable.readableLength);
}
{
  // a value parseInt reads: its numeric prefix wins
  for (const size of ["3", "2x", "x"]) {
    const readable = fresh();
    console.log(JSON.stringify(size), "->", show(readable.read(size)), "len", readable.readableLength);
  }
}
{
  // 1GiB is the largest accepted size
  const readable = fresh();
  console.log("1GiB ->", show(readable.read(2 ** 30)), "hwm", readable.readableHighWaterMark);
}
for (const size of [2 ** 30 + 1, 2 ** 32]) {
  const readable = fresh();
  try {
    console.log(String(size), "->", show(readable.read(size)));
  } catch (err) {
    console.log(String(size), "threw", err.code, "|", err.message);
  }
}
