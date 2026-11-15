// Writable.fromWeb and Duplex.fromWeb acquire their writer and reader from
// the web stream's own getWriter/getReader, and those methods are
// overridable: a stream can answer an ordinary value. Reading that value's
// `closed` has to follow the checked dynamic read, because an ordinary value
// is not a native handle and treating its fields as a handle tag and pointer
// would touch whatever memory they name. Node rejects these constructions
// with a TypeError; the runtime's answer differs there, but it must construct
// the adapter, destroy it and exit cleanly.
import { Duplex, Writable } from "node:stream";

const writable: any = new WritableStream();
writable.getWriter = (): number => 42;
const adapter = Writable.fromWeb(writable);
adapter.on("error", (error: Error) => console.log("writable error", error.name));
adapter.destroy();
console.log("writable", String(adapter.destroyed));

const readable: any = new ReadableStream();
readable.getReader = (): number => 42;
const duplex = Duplex.fromWeb({ readable, writable: new WritableStream() });
duplex.on("error", (error: Error) => console.log("duplex error", error.name));
duplex.destroy();
console.log("duplex", String(duplex.destroyed));
