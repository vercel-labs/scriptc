// fs write data that is any ArrayBufferView: Node writes the bytes of the
// view, whatever its element type, from its byteOffset for its byteLength.
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "scr-write-views-"));
const file = (name: string): string => path.join(dir, name);
const hex = (name: string): string => nodeFs.readFileSync(file(name)).toString("hex");
const bytes = (values: number[]): ArrayBuffer => {
  const buffer = new ArrayBuffer(values.length);
  new Uint8Array(buffer).set(values);
  return buffer;
};
const enc = (name: string): BufferEncoding => name as BufferEncoding;
const report = (label: string, e: unknown): void => {
  if (e instanceof Error) {
    console.log(label, e.name, (e as NodeJS.ErrnoException).code, e.message);
  } else console.log(label, "non-error", String(e));
};
const plain = async (label: string, run: () => Promise<void>): Promise<void> => {
  try {
    await run();
    console.log(label, "ok");
  } catch (e) {
    report(label, e);
  }
};

async function main(): Promise<void> {
  // Every element type writes its storage bytes.
  nodeFs.writeFileSync(file("u8"), new Uint8Array([1, 2, 3]));
  nodeFs.writeFileSync(file("u8c"), new Uint8ClampedArray([300, 1]));
  nodeFs.writeFileSync(file("i8"), new Int8Array([-1, 0, 127]));
  nodeFs.writeFileSync(file("u16"), new Uint16Array([0x1234, 0xabcd]));
  nodeFs.writeFileSync(file("i16"), new Int16Array([-2]));
  nodeFs.writeFileSync(file("u32"), new Uint32Array([0xdeadbeef]));
  nodeFs.writeFileSync(file("i32"), new Int32Array([-2]));
  nodeFs.writeFileSync(file("f32"), new Float32Array([1.5]));
  nodeFs.writeFileSync(file("f64"), new Float64Array([1.5]));
  nodeFs.writeFileSync(file("f16"), new Float16Array([1.5]));
  nodeFs.writeFileSync(file("view"), new DataView(bytes([1, 2, 3, 4]), 1, 2));
  nodeFs.writeFileSync(file("offset"), new Uint16Array(bytes([1, 2, 3, 4, 5, 6, 7, 8]).slice(0), 4, 2));
  nodeFs.writeFileSync(file("buffer"), Buffer.from("hi"));
  nodeFs.writeFileSync(file("empty"), new Uint16Array(0));
  for (const name of [
    "u8",
    "u8c",
    "i8",
    "u16",
    "i16",
    "u32",
    "i32",
    "f32",
    "f64",
    "f16",
    "view",
    "offset",
    "buffer",
    "empty",
  ]) {
    console.log(name, hex(name));
  }

  // The path, descriptor and promise forms write the same bytes, and the
  // append forms add to the file.
  nodeFs.appendFileSync(file("append"), new Uint16Array([1]));
  nodeFs.appendFileSync(file("append"), new Uint16Array([2]));
  await fs.writeFile(file("promise"), new Uint16Array([1]));
  await fs.appendFile(file("promise"), new Uint16Array([2]));
  const fd = nodeFs.openSync(file("descriptor"), "w+");
  nodeFs.writeFileSync(fd, new Uint16Array([0x1234]));
  nodeFs.appendFileSync(fd, new Int16Array([-1]));
  nodeFs.closeSync(fd);
  console.log("append", hex("append"));
  console.log("promise", hex("promise"));
  console.log("descriptor", hex("descriptor"));

  // A handle writes the view's bytes through its descriptor.
  const handle = await fs.open(file("handle"), "w+");
  await handle.writeFile(new Uint16Array([1]));
  await handle.appendFile(new DataView(bytes([2, 3]), 1, 1));
  await fs.writeFile(handle, new Float64Array([1.5]));
  await handle.close();
  console.log("handle", hex("handle"));

  // The encoding is still read and validated, though it never applies to a
  // view; the record's other values are read in source order.
  const order: string[] = [];
  const echo = <T>(label: string, value: T): T => {
    order.push(label);
    return value;
  };
  await fs.writeFile(file("order"), echo("data", new Uint16Array([1])), {
    mode: echo("mode", 0o600),
    encoding: echo("encoding", "latin1"),
    flag: echo("flag", "w"),
    flush: echo("flush", true),
  });
  console.log("order", order.join(","), hex("order"));
  await plain("unknown", () =>
    fs.writeFile(file("bad"), new Uint16Array([1]), enc("nope")),
  );
  await plain("buffer-name", () =>
    fs.writeFile(file("bad-buffer"), new Uint16Array([1]), enc("buffer")),
  );
  console.log("bad-buffer", hex("bad-buffer"));

  // A closed handle reports its descriptor out of range, as it does for
  // string data.
  await plain("closed-view", () => fs.writeFile(handle, new Uint16Array([1])));
  await plain("closed-empty", () => fs.writeFile(handle, new Uint16Array(0)));
}

main()
  .then(() => {
    nodeFs.rmSync(dir, { recursive: true, force: true });
    console.log("removed:", !nodeFs.existsSync(dir));
  })
  .catch((e: unknown) => {
    console.log("main failed", String(e));
    nodeFs.rmSync(dir, { recursive: true, force: true });
  });
