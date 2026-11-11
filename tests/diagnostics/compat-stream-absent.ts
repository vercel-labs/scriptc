// node:stream members scriptc does not implement, one use each: every
// statement below is refused by name. The compatibility ledger cites this
// program for marking the rows a verified absence instead of an
// unverified registry gap.
import { Duplex, PassThrough, Writable } from "node:stream";

// The web-stream adapters coming in and the Duplex pair going out.
const fromWritable = Writable.fromWeb(new WritableStream());
const transform = new TransformStream();
const fromPair = Duplex.fromWeb({ readable: transform.readable, writable: transform.writable });
const pair = Duplex.toWeb(new PassThrough());
console.log(typeof fromWritable, typeof fromPair, typeof pair);
