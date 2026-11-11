// readdir's encoding options: the default and explicit utf8 list names as
// strings, other encodings decode the raw name bytes that way, and
// encoding: 'buffer' answers Buffers. OS order is unguaranteed (993's
// rule), so every listing sorts before printing.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-enc-"));
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(`${dir}/sub`, { recursive: true });
fs.writeFileSync(`${dir}/alpha.txt`, "a");
fs.writeFileSync(`${dir}/sub/beta.txt`, "b");

// The default and the utf8 spellings are strings.
console.log(fs.readdirSync(dir).sort().join(","));
console.log(fs.readdirSync(dir, "utf8").sort().join(","));
console.log(fs.readdirSync(dir, { encoding: "utf8" }).sort().join(","));
console.log(fs.readdirSync(dir, { encoding: "utf-8", recursive: true }).sort().join(","));

// Other encodings decode the name bytes.
console.log(fs.readdirSync(dir, "hex").sort().join(","));
console.log(fs.readdirSync(dir, { encoding: "base64" }).sort().join(","));

// encoding: 'buffer' answers Buffers; the shorthand spelling agrees.
const buffers = fs.readdirSync(dir, { encoding: "buffer" });
const shorthand = fs.readdirSync(dir, "buffer");
console.log(buffers.length, shorthand.length);
console.log(
  buffers
    .map((b) => b.toString("utf8"))
    .sort()
    .join(","),
);
console.log(Buffer.isBuffer(buffers[0]));

// Dirent rows with Buffer names: a flat listing answers them as they are.
const bdir = fs.readdirSync(dir, { withFileTypes: true, encoding: "buffer" });
console.log(bdir.map((r) => `${r.name.toString("utf8")}:${r.isDirectory()}`).sort().join(","));
console.log(Buffer.isBuffer(bdir[0].name));

// A recursive Buffer listing joins each entry into a path, and path.join
// rejects a Buffer, so a non-empty listing throws Node's TypeError. An
// empty directory still answers [].
try {
  fs.readdirSync(dir, { encoding: "buffer", recursive: true });
  console.log("no-throw");
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log("sync-buffer-recursive", err.code, err.message);
}
// The sync Dirent walk joins EVERY entry, so it throws on the first one.
try {
  fs.readdirSync(dir, { withFileTypes: true, encoding: "buffer", recursive: true });
  console.log("no-throw");
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log("sync-bdirent-recursive", err.code, err.message);
}
fs.mkdirSync(`${dir}/empty`);
console.log(fs.readdirSync(`${dir}/empty`, { encoding: "buffer", recursive: true }).length);
fs.rmdirSync(`${dir}/empty`);

// Bad encoding names throw ERR_INVALID_ARG_VALUE (Node's assertEncoding).
try {
  fs.readdirSync(dir, { encoding: "nope" as BufferEncoding });
  console.log("no-throw");
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log("sync", err.code, err.message);
}

// The string shorthand for a bad name goes through the same check.
try {
  fs.readdirSync(dir, "nope" as BufferEncoding);
} catch (e) {
  console.log("sync-short", (e as NodeJS.ErrnoException).code);
}

async function main(): Promise<void> {
  console.log((await fsp.readdir(dir)).sort().join(","));
  console.log((await fsp.readdir(dir, { encoding: "utf8", recursive: true })).sort().join(","));
  console.log((await fsp.readdir(dir, "hex")).sort().join(","));
  const pb = await fsp.readdir(dir, { encoding: "buffer" });
  console.log(pb.map((b) => b.toString("utf8")).sort().join(","));
  const pbd = await fsp.readdir(dir, { withFileTypes: true, encoding: "buffer" });
  console.log(pbd.map((r) => `${r.name.toString("utf8")}:${r.isDirectory()}`).sort().join(","));
  try {
    await fsp.readdir(dir, { encoding: "buffer", recursive: true });
    console.log("p-no-throw");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("promise-buffer-recursive", err.code, err.message);
  }
  // The promise Dirent walk joins only a directory entry, so this listing
  // throws when it reaches `sub` (and not on the files listed before it).
  try {
    await fsp.readdir(dir, { withFileTypes: true, encoding: "buffer", recursive: true });
    console.log("p-no-throw");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("promise-bdirent-recursive", err.code, err.message);
  }
  try {
    await fsp.readdir(dir, { encoding: "nope" as BufferEncoding });
    console.log("p-no-throw");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("promise", err.code, err.message);
  }
}

main().then(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
