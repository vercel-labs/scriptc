// Node APIs scriptc's declarations name but its lowering does not answer:
// each use below type-checks and is then refused by name (SC2020). The
// compatibility ledger cites this program for marking the rows a verified
// absence instead of an unverified registry gap.

// The global MessageChannel and its ports.
const channel = new MessageChannel();
channel.port1.postMessage("x");
channel.port2.close();

// A Duplex becomes a web pair through Duplex.toWeb: its writable side has no
// lowering (the readable side alone is Readable.toWeb).
import { Duplex, PassThrough } from "node:stream";
const webPair = Duplex.toWeb(new PassThrough());
console.log(typeof webPair);
