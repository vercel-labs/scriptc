// fs.promises.writeFile over Uint8Array data and over a string|Uint8Array
// union — the live tag selects the runtime entry, `{ mode, flag }` creates
// exclusively — and appendFileSync's options record, whose append
// disposition the runtime entry already carries.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-fs-write-data-"));
function hex(name: string): string {
  return readFileSync(join(dir, name)).toString("hex");
}
function created(name: string): string {
  return (statSync(join(dir, name)).mode & 0o777).toString(8);
}

// Byte data in the plain two-argument form.
await writeFile(join(dir, "bytes.bin"), new Uint8Array([0, 128, 255]));
console.log("bytes:", hex("bytes.bin"), created("bytes.bin"));

// Byte data with options, then the union's two arms: the tag picks which
// bytes are written and the exclusive flag creates with the given mode.
await writeFile(join(dir, "mode.bin"), new Uint8Array([0x68, 0x69]), { mode: 0o600 });
console.log("mode:", hex("mode.bin"), created("mode.bin"));

function value(bytes: boolean): string | Uint8Array {
  return bytes ? new Uint8Array([0x68, 0x69]) : "hi";
}
await writeFile(join(dir, "text.txt"), value(false), { mode: 0o600, flag: "wx" });
await writeFile(join(dir, "union.bin"), value(true), { mode: 0o600, flag: "wx" });
console.log("text:", hex("text.txt"), created("text.txt"));
console.log("union:", hex("union.bin"), created("union.bin"));

// "wx" never follows a path that exists: EEXIST, and the first bytes stay.
try {
  await writeFile(join(dir, "text.txt"), value(false), { mode: 0o600, flag: "wx" });
  console.log("existing: no rejection");
} catch (e) {
  if (e instanceof Error) {
    console.log("existing:", (e as NodeJS.ErrnoException).code, hex("text.txt"));
  }
}

// Option values are ordinary expressions, evaluated in object-literal
// order after the path and data.
let evaluations: string[] = [];
function writePath(name: string): string {
  evaluations.push("path");
  return join(dir, name);
}
function writeData(label: string, data: string | Uint8Array): string | Uint8Array {
  evaluations.push(label);
  return data;
}
function encoding(label: string): "utf8" {
  evaluations.push(label);
  return "utf8";
}
function mode(label: string): number {
  evaluations.push(label);
  return 0o600;
}
function exclusive(label: string): "wx" {
  evaluations.push(label);
  return "wx";
}
await writeFile(writePath("order.txt"), writeData("data", "order"), {
  encoding: encoding("encoding"),
  mode: mode("mode"),
  flag: exclusive("flag"),
});
console.log("order:", evaluations.join(","), hex("order.txt"));

async function invalidMode(label: string, value: number): Promise<void> {
  const path = join(dir, `${label}.bin`);
  try {
    const rejected = writeFile(path, new Uint8Array([1]), { mode: value });
    console.log(label, "promise returned");
    await rejected;
    console.log(label, "resolved", existsSync(path));
  } catch (e) {
    if (e instanceof Error) {
      console.log(label, e.name, `${(e as NodeJS.ErrnoException).code}`, existsSync(path));
    }
  }
}
await invalidMode("negative", -1);
await invalidMode("fractional", 1.5);

// appendFileSync appends whatever the options say: the encoding may only
// spell the utf8 the runtime writes, and the creation mode applies to a
// file the append creates.
const appended = join(dir, "append.txt");
appendFileSync(appended, "one\n");
appendFileSync(appended, "two\n", { encoding: "utf8" });
appendFileSync(appended, "three\n", "utf-8");
appendFileSync(appended, "four\n", { flag: "a" });
appendFileSync(appended, "five\n", { encoding: "utf-8", mode: 0o600 });
console.log("append:", JSON.stringify(readFileSync(appended, "utf8")));
console.log("appended mode:", created("append.txt"));

appendFileSync(join(dir, "append-created.txt"), "x", { mode: 0o600 });
console.log("append created:", hex("append-created.txt"), created("append-created.txt"));

try {
  appendFileSync(appended, "x", { mode: -1 });
  console.log("append mode: no throw");
} catch (e) {
  if (e instanceof Error) {
    console.log("append mode:", e.name, `${(e as NodeJS.ErrnoException).code}`);
  }
}

rmSync(dir, { recursive: true, force: true });
console.log("done:", !existsSync(dir));
