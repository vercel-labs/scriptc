// fsPromises.realpath/mkdtemp options: a BufferEncoding string or an
// object literal's encoding member. utf8 (and the empty string) answer the
// path text, "buffer" answers the raw bytes, and every other known encoding
// re-encodes the path's UTF-8 bytes. Node validates the encoding before the
// path, so an unknown name rejects first.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsp-enc-"));
const file = path.join(dir, "file.txt");
const link = path.join(dir, "link.txt");
const missing = path.join(dir, "missing.txt");

function clean(text: string): string {
  // mkdtemp's random suffix is per-run: name the shape, not the value.
  const marker = "missing.txt/x-";
  const at = text.indexOf(marker);
  const stable = at < 0 ? text : text.slice(0, at + marker.length) + "<random>";
  return stable.split(dir).join("<dir>");
}

function report(label: string, error: unknown): void {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.log(label, error.name, code, clean(error.message));
  } else {
    console.log(label, "non-error");
  }
}

async function main(): Promise<void> {
  fs.writeFileSync(file, "payload");
  fs.symlinkSync(file, link);

  const resolved = await fsp.realpath(link);
  console.log("realpath", clean(resolved), resolved === file);
  // The uppercase spelling is not a BufferEncoding literal, but Node's
  // encoding check is case-insensitive and still answers the path text.
  const upper = await fsp.realpath(link, "UTF8");
  console.log("utf8 upper", upper === resolved);
  const objectForm = await fsp.realpath(link, { encoding: "utf8" });
  console.log("object form", objectForm === resolved);
  const empty = await fsp.realpath(link, "");
  console.log("empty encoding", empty === resolved);
  const nullOptions = await fsp.realpath(link, null);
  console.log("null options", nullOptions === resolved);
  const undefinedOptions = await fsp.realpath(link, undefined);
  console.log("undefined options", undefinedOptions === resolved);

  const hex = await fsp.realpath(link, "hex");
  const fromHex = Buffer.from(hex, "hex").toString("utf8");
  console.log("hex", typeof hex, fromHex === resolved);
  const base64 = await fsp.realpath(link, { encoding: "base64" });
  console.log("base64", Buffer.from(base64, "base64").toString("utf8") === resolved);
  const latin1 = await fsp.realpath(link, "latin1");
  console.log("latin1", latin1 === resolved);
  const raw = await fsp.realpath(link, "buffer");
  console.log("buffer", Buffer.isBuffer(raw), raw.toString("utf8") === resolved);
  const rawObject = await fsp.realpath(link, { encoding: "buffer" });
  console.log("buffer object", Buffer.isBuffer(rawObject), rawObject.equals(raw));

  // getOptions runs before the path: the encoding error comes first.
  try {
    await fsp.realpath(missing, { encoding: "wat" });
    console.log("bad encoding", "fulfilled");
  } catch (error) {
    report("bad encoding", error);
  }
  try {
    await fsp.realpath(missing, "hex");
    console.log("missing hex", "fulfilled");
  } catch (error) {
    report("missing hex", error);
  }

  const plain = await fsp.mkdtemp(path.join(dir, "plain-"));
  console.log("mkdtemp", plain.startsWith(path.join(dir, "plain-")), fs.existsSync(plain));
  const plainUpper = await fsp.mkdtemp(path.join(dir, "upper-"), "UTF8");
  console.log("mkdtemp upper", plainUpper.startsWith(path.join(dir, "upper-")));
  const plainObject = await fsp.mkdtemp(path.join(dir, "object-"), { encoding: "utf8" });
  console.log("mkdtemp object", plainObject.startsWith(path.join(dir, "object-")));
  const hexDir = await fsp.mkdtemp(path.join(dir, "hex-"), "hex");
  const decoded = Buffer.from(hexDir, "hex").toString("utf8");
  console.log("mkdtemp hex", typeof hexDir, decoded.startsWith(path.join(dir, "hex-")), fs.existsSync(decoded));
  const bufferDir = await fsp.mkdtemp(path.join(dir, "buffer-"), { encoding: "buffer" });
  console.log("mkdtemp buffer", Buffer.isBuffer(bufferDir), fs.existsSync(bufferDir.toString("utf8")));
  try {
    await fsp.mkdtemp(path.join(dir, "bad-"), "wat");
    console.log("mkdtemp bad encoding", "fulfilled");
  } catch (error) {
    report("mkdtemp bad encoding", error);
  }
  try {
    await fsp.mkdtemp(path.join(missing, "x-"), "hex");
    console.log("mkdtemp missing", "fulfilled");
  } catch (error) {
    report("mkdtemp missing", error);
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

main();
