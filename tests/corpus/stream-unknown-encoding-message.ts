// ERR_UNKNOWN_ENCODING renders the offending value as util.format's %s
// does: a Buffer as its contents, anything else as util.inspect at depth 0.
// The stream unit answers that text through the inspect unit's slot, which
// its constructor fills; this program calls util.inspect so the inspect unit
// links, and Readable.from's `encoding` option carries the bad values.
import { Readable } from "node:stream";
import { inspect } from "node:util";

console.log(inspect({ a: 1 }));

function attempt(label: string, encoding: unknown): void {
  try {
    Readable.from(["x"], { encoding: encoding as BufferEncoding });
    console.log("accepted", label);
  } catch (error: any) {
    console.log(`${label} ${error.name} ${error.code} ${error.message}`);
  }
}

attempt("object", { length: 3, name: "bogus" });
attempt("array", [1, 2]);
attempt("buffer", Buffer.from("nope"));
