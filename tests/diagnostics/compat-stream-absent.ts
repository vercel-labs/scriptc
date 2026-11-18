// node:stream members scriptc does not implement, one use each: every
// statement below is refused by name. The compatibility ledger cites this
// program for marking the rows a verified absence instead of an
// unverified registry gap.
import * as stream from "node:stream";
import { Duplex, PassThrough, Readable } from "node:stream";

// A connected pair of Duplex streams.
const [left, right] = stream.duplexPair();
left.write("x");
right.resume();

// Wrapping an old-style stream: wrap() copies the old stream's methods
// onto the new one by key.
const old = new PassThrough();
const wrapped = new Readable().wrap(old);
wrapped.resume();

// The web-stream adapter pair going in.
const transform = new TransformStream();
const fromPair = Duplex.fromWeb({ readable: transform.readable, writable: transform.writable });
console.log(typeof fromPair);
