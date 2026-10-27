// decodeStrings: false and the write-side default encoding in typed code:
// a string write reaches _write and _transform as the string with its
// encoding (its UTF-16 length counts toward writableLength), Buffers keep
// 'buffer', defaultEncoding decides how write(string) encodes (and the
// name _write sees when strings stay strings), and setDefaultEncoding()
// lowercases, validates and chains.
import { PassThrough, Transform, Writable } from "node:stream";

const log: string[] = [];

function describe(chunk: string | Buffer, enc: string): string {
  return typeof chunk === "string" ? `string:${chunk}/${enc}` : `B:${chunk.toString("hex")}/${enc}`;
}

class Keeper extends Writable {
  seen: string[] = [];
  constructor() {
    super({ decodeStrings: false, highWaterMark: 4 });
  }
  _write(chunk: string | Buffer, enc: string, cb: (error?: Error | null) => void): void {
    this.seen.push(describe(chunk, enc));
    setTimeout(cb, 1);
  }
}

async function main(): Promise<void> {
  const keeper = new Keeper();
  log.push("ret " + keeper.write("héllo"));
  log.push("length " + keeper.writableLength);
  keeper.write("6869", "hex");
  keeper.write(Buffer.from("zz"));
  keeper.end("end", "latin1");
  await new Promise((resolve) => keeper.on("finish", resolve));
  log.push("keeper " + keeper.seen.join(" "));

  const hex = new Writable({
    defaultEncoding: "hex",
    write(chunk: Buffer, enc: string, cb: (error?: Error | null) => void) {
      log.push(`hex ${chunk.toString()} ${enc}`);
      cb();
    },
  });
  hex.write("6869");
  hex.write("41", "utf8");
  hex.setDefaultEncoding("BASE64").write("aGk=");
  try {
    hex.setDefaultEncoding("nope");
  } catch (e) {
    log.push(`setDefaultEncoding ${(e as NodeJS.ErrnoException).code} ${(e as Error).message}`);
  }
  log.push("chains " + (hex.setDefaultEncoding("utf8") === hex));
  hex.end("ok");

  const both = new Writable({
    decodeStrings: false,
    defaultEncoding: "LATIN1",
    write(chunk: string | Buffer, enc: string, cb: (error?: Error | null) => void) {
      log.push("both " + describe(chunk, enc));
      cb();
    },
  });
  both.write("x");
  both.setDefaultEncoding("UTF-8");
  both.write("y");
  both.end();

  const t = new Transform({
    decodeStrings: false,
    transform(chunk: string | Buffer, enc: string, cb: (error: Error | null, data?: string | Buffer) => void) {
      log.push("transform " + describe(chunk, enc));
      cb(null, chunk);
    },
  });
  t.on("data", (c: Buffer) => log.push("transform out " + c.toString("hex")));
  t.write("abc");
  t.end("ff", "hex");

  const p = new PassThrough({ decodeStrings: false });
  p.on("data", (c: Buffer) => log.push("pass " + c.toString()));
  p.end("q");

  try {
    new Writable({ defaultEncoding: "bogus" });
  } catch (e) {
    log.push("constructor " + (e as NodeJS.ErrnoException).code);
  }
  setTimeout(() => console.log(log.join("\n")), 10);
}
main();
