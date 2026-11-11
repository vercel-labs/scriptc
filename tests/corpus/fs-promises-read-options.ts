// fsPromises.readFile options: Node's getOptions ladder — the options kind
// (an encoding string, an object, a nullish value), the encoding name, the
// open flag and the signal — then the open and the read. The encoding
// chooses the result: text for every encoding name, raw bytes for none, an
// explicit null, or an empty options record.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsp-read-"));
const file = path.join(dir, "f.txt");
const missing = path.join(dir, "missing.txt");

function clean(text: string): string {
  return text.split(dir).join("<dir>").replace(/fsp-read-[A-Za-z0-9]{6}/g, "fsp-read-<name>");
}

function report(label: string, error: unknown): void {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const syscall = (error as NodeJS.ErrnoException).syscall;
    console.log(label, error.name, code, syscall ?? "-", clean(error.message));
  } else {
    console.log(label, "non-error");
  }
}

async function bytes(label: string, reading: Promise<Buffer>): Promise<void> {
  const data = await reading;
  console.log(label, data.length, Buffer.isBuffer(data), data.toString("utf8"));
}

async function main(): Promise<void> {
  fs.writeFileSync(file, "hello");

  // No options, an explicit null, and an empty record all read raw bytes.
  await bytes("plain", fsp.readFile(file));
  await bytes("null", fsp.readFile(file, null));
  await bytes("empty record", fsp.readFile(file, {}));
  await bytes("encoding null", fsp.readFile(file, { encoding: null }));
  // The flag alone keeps the byte result.
  await bytes("flag r", fsp.readFile(file, { flag: "r" }));

  // An encoding name answers text; utf8 is the shortcut spelling.
  console.log("utf8", await fsp.readFile(file, "utf8"));
  console.log("utf8 record", await fsp.readFile(file, { encoding: "utf8" }));
  console.log("hex", await fsp.readFile(file, { encoding: "hex" }));
  console.log("flag and encoding", await fsp.readFile(file, { flag: "r", encoding: "utf8" }));

  // A missing entry rejects with the open error, syscall and path.
  try {
    await fsp.readFile(missing);
    console.log("missing", "fulfilled");
  } catch (error) {
    report("missing", error);
  }

  // The signal: an already-aborted one rejects before the open; a plain
  // one observes the flag.
  const controller = new AbortController();
  controller.abort();
  try {
    await fsp.readFile(file, { signal: controller.signal });
    console.log("aborted", "fulfilled");
  } catch (error) {
    report("aborted", error);
  }
  await bytes("signal", fsp.readFile(file, { signal: new AbortController().signal }));

  // A write-only flag opens and then fails the read: Node reports EBADF
  // from the read, not the open.
  try {
    await fsp.readFile(file, { flag: "w" });
    console.log("flag w", "fulfilled");
  } catch (error) {
    report("flag w", error);
  }

  // Options and path together: the options validate first, and the open
  // reports the missing entry with the lowercased flag form.
  try {
    await fsp.readFile(missing, { encoding: "utf8", flag: "r" });
    console.log("missing with options", "fulfilled");
  } catch (error) {
    report("missing with options", error);
  }

  // The flag's open truncated the file; the stored record still reads what
  // is there.
  fs.writeFileSync(file, "hello");
  const stored: { encoding: "hex" } = { encoding: "hex" };
  console.log("stored", await fsp.readFile(file, stored));

  fs.rmSync(dir, { recursive: true, force: true });
}

main();
