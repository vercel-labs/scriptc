// node:stream members scriptc does not implement, one use each: every
// statement below is refused by name. The compatibility ledger cites this
// program for marking the rows a verified absence instead of an
// unverified registry gap.
import * as stream from "node:stream";
import { PassThrough, Readable } from "node:stream";

// A connected pair of Duplex streams.
const [left, right] = stream.duplexPair();
left.write("x");
right.resume();

// Wrapping an old-style stream: wrap() copies the old stream's methods
// onto the new one by key.
const old = new PassThrough();
const wrapped = new Readable().wrap(old);
wrapped.resume();

// The web-stream transform's own class.
const transform = new TransformStream();
const pair = Duplex.toWeb(new PassThrough());
console.log(typeof transform.readable, typeof pair);
