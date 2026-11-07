// FileHandle.writeFile and FileHandle.appendFile over the write options
// record: the encoding converts string data exactly as Buffer.from does,
// while the flag, the mode and the flush value are evaluated in source order
// and unused, because a handle opens nothing and never fsyncs.
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "scr-fh-write-"));
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
  const utf8 = await fs.open(file("utf8.txt"), "w+");
  await utf8.writeFile("one");
  await utf8.writeFile("two", "utf8");
  await utf8.writeFile("three", "utf-8");
  await utf8.writeFile("four", { encoding: "utf8" });
  await utf8.writeFile("x\uD800y");
  console.log("utf8:", hex("utf8.txt"));
  await utf8.close();

  // A non-utf8 encoding converts the string the way Buffer.from does, and the
  // bytes land at the handle's current offset.
  const converted = await fs.open(file("converted.txt"), "w+");
  await converted.writeFile("héllo", "latin1");
  await converted.writeFile("hé", { encoding: "utf8" });
  const stored = { encoding: "base64" } as const;
  await converted.writeFile("hi", stored);
  await converted.writeFile("A", { encoding: "utf16le" });
  await converted.writeFile("");
  await converted.writeFile("", "latin1");
  console.log("converted:", hex("converted.txt"));
  await converted.close();

  // Uint8Array data takes no conversion; the encoding is still validated.
  const raw = await fs.open(file("raw.txt"), "w+");
  await raw.writeFile(new Uint8Array([1, 2, 3]), enc("buffer"));
  await raw.writeFile(Buffer.from([4, 5]), { encoding: "latin1" });
  await raw.writeFile(new Uint8Array([6]), { flag: "zz" });
  await plain("bytes-unknown-encoding", () =>
    raw.writeFile(new Uint8Array([7]), enc("nope")),
  );
  console.log("raw:", hex("raw.txt"));
  await raw.close();

  // The record's other values are accepted as written: a handle parses
  // neither the flag nor the mode, and the flush boolean is never consulted.
  const junk = await fs.open(file("junk.txt"), "w+");
  await plain("junk-flag", () => junk.writeFile("a", { flag: "zz" }));
  await plain("junk-flag-empty", () => junk.writeFile("b", { flag: "" }));
  await plain("junk-mode-string", () => junk.writeFile("c", { mode: "zzz" }));
  await plain("junk-mode-fraction", () => junk.writeFile("d", { mode: 1.5 }));
  await plain("junk-mode-negative", () => junk.writeFile("e", { mode: -1 }));
  await plain("junk-flush", () => junk.writeFile("f", { flush: true }));
  await plain("junk-append", () => junk.appendFile("g", { mode: "zzz", flag: "zz" }));
  console.log("junk:", hex("junk.txt"));
  await junk.close();

  // The option values are evaluated in source order before the write, and an
  // absent encoding falls back to utf8.
  const order: string[] = [];
  const echo = <T>(label: string, value: T): T => {
    order.push(label);
    return value;
  };
  const ordered = await fs.open(file("order.txt"), "w+");
  await ordered.writeFile(echo("data", "v"), {
    mode: echo("mode", 0o600),
    encoding: echo("encoding", "latin1"),
    flag: echo("flag", "w"),
    flush: echo("flush", false),
  });
  console.log("order:", order.join(","), hex("order.txt"));
  await ordered.close();

  // The encoding is validated before the write runs: its refusals are the
  // same ones the path forms report.
  const bad = await fs.open(file("bad.txt"), "w+");
  await plain("encoding-unknown", () => bad.writeFile("x", enc("nope")));
  await plain("rec-encoding-unknown", () => bad.writeFile("x", { encoding: enc("nope") }));
  await plain("string-as-buffer", () => bad.writeFile("x", enc("buffer")));
  await plain("rec-string-as-buffer", () => bad.writeFile("x", { encoding: enc("buffer") }));
  await bad.writeFile("y", { encoding: "ascii" });
  console.log("bad:", hex("bad.txt"));
  await bad.close();

  // A closed handle is refused before the write runs at all, so every
  // spelling reports the same error.
  await plain("closed-utf8", () => bad.writeFile("x"));
  await plain("closed-latin1", () => bad.writeFile("x", "latin1"));
  await plain("closed-unknown", () => bad.writeFile("x", enc("nope")));
  await plain("closed-buffer", () => bad.writeFile("x", enc("buffer")));
  await plain("closed-bytes", () => bad.writeFile(new Uint8Array([1]), enc("buffer")));
  await plain("closed-append", () => bad.appendFile("y"));

  // On an open handle the conversion runs first, so an encoding the write
  // would never reach still decides the outcome of a failed write.
  const readOnly = await fs.open(file("bad.txt"), "r");
  await plain("ro-utf8", () => readOnly.writeFile("z"));
  await plain("ro-unknown", () => readOnly.writeFile("z", enc("nope")));
  await plain("ro-buffer", () => readOnly.writeFile("z", enc("buffer")));
  await plain("ro-bytes", () => readOnly.writeFile(new Uint8Array([2]), enc("buffer")));
  await plain("ro-bytes-unknown", () =>
    readOnly.writeFile(new Uint8Array([2]), enc("nope")),
  );
  console.log("ro:", hex("bad.txt"));
  await readOnly.close();

  // An encoding value whose type also admits undefined is absent at run time
  // here: the record is read as written, so the value defaults to utf8.
  const pick = (value: string | undefined): string | undefined => value;
  const maybe = await fs.open(file("maybe.txt"), "w+");
  await maybe.writeFile("A", { encoding: pick(undefined) as BufferEncoding });
  await maybe.writeFile("B", { encoding: pick("latin1") as BufferEncoding });
  console.log("maybe:", hex("maybe.txt"));
  await maybe.close();
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
