// node:stream members scriptc does not implement, one use each: every
// statement below is refused by name. The compatibility ledger cites this
// program for marking the rows a verified absence instead of an
// unverified registry gap.
import { Duplex } from "node:stream";

// The web-stream adapter pair going in.
const transform = new TransformStream();
const fromPair = Duplex.fromWeb({ readable: transform.readable, writable: transform.writable });
console.log(typeof fromPair);
