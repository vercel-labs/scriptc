// Node APIs scriptc's declarations name but its lowering does not answer:
// each use below type-checks and is then refused by name (SC2020). The
// compatibility ledger cites this program for marking the rows a verified
// absence instead of an unverified registry gap.

// Readable.toWeb's byte-stream form: the option is typed, and a byte stream
// has no lowering (the default ReadableStream does).
import { Readable } from "node:stream";
const web = Readable.toWeb(Readable.from(["a"]), { type: "bytes" });
console.log(typeof web);
