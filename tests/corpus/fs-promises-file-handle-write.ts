// fs.promises writeFile and appendFile with an open FileHandle where they
// take a path: the string conversion runs before the handle is consulted, so
// a closed handle reports its descriptor out of range, while an open one
// writes through the descriptor with the record's flag, mode and flush read
// and unused.
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "scr-fsp-fh-write-"));
const file = (name: string): string => path.join(dir, name);
const hex = (name: string): string => nodeFs.readFileSync(file(name)).toString("hex");

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
const enc = (name: string): BufferEncoding => name as BufferEncoding;

async function main(): Promise<void> {
  // The path forms and the handle forms write to the same descriptor, from
  // its current offset.
  const handle = await fs.open(file("mixed.txt"), "w+");
  await handle.writeFile("A");
  await fs.writeFile(handle, "B", "latin1");
  await fs.appendFile(handle, "C");
  await fs.writeFile(handle, "hé", { encoding: "latin1" });
  await fs.writeFile(handle, new Uint8Array([1, 2]), enc("buffer"));
  console.log("mixed:", hex("mixed.txt"));
  await handle.close();

  // The record's other values are accepted as written: a handle parses
  // neither the flag nor the mode and never fsyncs.
  const junk = await fs.open(file("junk.txt"), "w+");
  await plain("junk-flag", () => fs.writeFile(junk, "a", { flag: "zz" }));
  await plain("junk-mode", () => fs.writeFile(junk, "b", { mode: "zzz" }));
  await plain("junk-flush", () => fs.writeFile(junk, "c", { flush: true }));
  await plain("junk-append", () => fs.appendFile(junk, "d", { mode: -1, flag: "zz" }));
  console.log("junk:", hex("junk.txt"));
  await junk.close();

  // The option values are evaluated in source order before the write.
  const order: string[] = [];
  const echo = <T>(label: string, value: T): T => {
    order.push(label);
    return value;
  };
  const ordered = await fs.open(file("order.txt"), "w+");
  await fs.writeFile(ordered, echo("data", "v"), {
    mode: echo("mode", 0o600),
    encoding: echo("encoding", "latin1"),
    flag: echo("flag", "w"),
    flush: echo("flush", false),
  });
  console.log("order:", order.join(","), hex("order.txt"));
  await ordered.close();

  // The encoding is validated before the write; "buffer" is a valid record
  // name that only Buffer.from rejects.
  const bad = await fs.open(file("bad.txt"), "w+");
  await plain("encoding-unknown", () => fs.writeFile(bad, "x", enc("nope")));
  await plain("string-as-buffer", () => fs.writeFile(bad, "x", enc("buffer")));
  await plain("bytes-unknown", () => fs.writeFile(bad, new Uint8Array([1]), enc("nope")));
  await plain("rec-unknown", () => fs.writeFile(bad, "x", { encoding: enc("nope") }));
  await plain("append-unknown", () => fs.appendFile(bad, "x", enc("nope")));
  await fs.writeFile(bad, "y", { encoding: "ascii" });
  console.log("bad:", hex("bad.txt"));
  await bad.close();

  // A closed handle reaches the descriptor write, which range-checks its
  // descriptor, so the conversion runs first and empty data writes nothing.
  await plain("closed", () => fs.writeFile(bad, "x"));
  await plain("closed-bytes", () => fs.writeFile(bad, new Uint8Array([1])));
  await plain("closed-append", () => fs.appendFile(bad, "y"));
  await plain("closed-empty", () => fs.writeFile(bad, ""));
  await plain("closed-empty-bytes", () => fs.writeFile(bad, new Uint8Array(0)));
  await plain("closed-unknown", () => fs.writeFile(bad, "x", enc("nope")));
  await plain("closed-buffer", () => fs.writeFile(bad, "x", enc("buffer")));
  await plain("closed-bytes-unknown", () => fs.writeFile(bad, new Uint8Array([1]), enc("nope")));

  // An open read-only handle converts first and then fails the write.
  const readOnly = await fs.open(file("bad.txt"), "r");
  await plain("ro", () => fs.writeFile(readOnly, "x"));
  await plain("ro-bytes", () => fs.writeFile(readOnly, new Uint8Array([1]), enc("buffer")));
  await plain("ro-unknown", () => fs.writeFile(readOnly, "x", enc("nope")));
  await readOnly.close();
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
