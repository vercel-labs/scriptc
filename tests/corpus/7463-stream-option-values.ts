// Typed decodeStrings and defaultEncoding options whose values are known
// only at run time: decodeStrings === false keeps string writes, a known
// defaultEncoding is the write default as given and how push(string)
// decodes, null and utf8 are the default, an unknown name throws
// ERR_UNKNOWN_ENCODING before construction, and a subclass's super()
// options take them the same way.
import { Writable, Readable, Duplex } from "node:stream";
type Cb = (error?: Error | null) => void;
const flags: boolean[] = JSON.parse("[false, true]");
const encodings: Array<string | null> = JSON.parse('["hex", "latin1", null, "UTF8"]');
for (const decode of flags) {
  const w = new Writable({
    decodeStrings: decode,
    defaultEncoding: encodings[0] as BufferEncoding,
    write(chunk: any, enc: string, cb: Cb): void {
      console.log("write", decode, typeof chunk, enc, String(chunk));
      cb();
    },
  });
  w.write("6869");
}
const r = new Readable({ defaultEncoding: encodings[1] as BufferEncoding, read(): void {} });
r.push("é");
r.push(null);
r.on("data", (d: Buffer) => console.log("readable", d.toString("hex")));
const dflt = new Writable({
  defaultEncoding: encodings[2] as any,
  write(chunk: Buffer, enc: string, cb: Cb): void {
    console.log("null default", enc, chunk.toString());
    cb();
  },
});
dflt.write("ok");
const upper = new Duplex({
  defaultEncoding: encodings[3] as BufferEncoding,
  decodeStrings: flags[0],
  read(): void {},
  write(chunk: any, enc: string, cb: Cb): void {
    console.log("duplex", typeof chunk, enc);
    cb();
  },
});
upper.write("x");
try {
  new Writable({ defaultEncoding: JSON.parse('"nope"') });
} catch (e) {
  console.log("bad", (e as Error & { code?: string }).code, (e as Error).message);
}
class Sink extends Writable {
  constructor(decode: boolean, encoding: BufferEncoding) {
    super({ decodeStrings: decode, defaultEncoding: encoding });
  }
  _write(chunk: any, enc: string, cb: Cb): void {
    console.log("sink", typeof chunk, enc);
    cb();
  }
}
new Sink(flags[0]!, encodings[1] as BufferEncoding).write("y");
