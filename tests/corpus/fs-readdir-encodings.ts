// readdir's encoding spellings: the bare name ("utf8", "buffer" and the
// other BufferEncoding codecs) and the { encoding } record, in the sync and
// promise forms. The bytes form answers the entry names as Buffers holding
// each name's bytes; every other name decodes them with that codec. Both
// list the same entries in the same order.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "readdir-encodings-"));
fs.writeFileSync(join(dir, "a.txt"), "a");
fs.writeFileSync(join(dir, "é.txt"), "e");
fs.mkdirSync(join(dir, "sub"));

const showNames = (label: string, names: string[]): void => {
  console.log(label, JSON.stringify(names));
};
const showBytes = (label: string, names: Buffer[]): void => {
  console.log(
    label,
    JSON.stringify(names.map((n) => `${Buffer.isBuffer(n) ? "buf" : "u8"}:${n.toString("hex")}`)),
  );
};

showNames("plain", fs.readdirSync(dir));
showNames("bare utf8", fs.readdirSync(dir, "utf8"));
showNames("record utf8", fs.readdirSync(dir, { encoding: "utf8" }));
showBytes("bare buffer", fs.readdirSync(dir, "buffer"));
showBytes("record buffer", fs.readdirSync(dir, { encoding: "buffer" }));
showBytes("promise bare", await fsp.readdir(dir, "buffer"));
showBytes("promise record", await fsp.readdir(dir, { encoding: "buffer" }));
showNames("promise utf8", await fsp.readdir(dir, { encoding: "utf8" }));
showNames("bare hex", fs.readdirSync(dir, "hex"));
showNames("record hex", fs.readdirSync(dir, { encoding: "hex" }));
showBytes("recursive false buffer", fs.readdirSync(dir, { encoding: "buffer", recursive: false }));
showNames("recursive false hex", fs.readdirSync(dir, { encoding: "hex", recursive: false }));
showNames("promise latin1", await fsp.readdir(dir, { encoding: "latin1" }));

// A dynamic encoding name reads at run time, like the literal spelling.
const dynamic: BufferEncoding = "hex";
showNames("dynamic", fs.readdirSync(dir, dynamic));

const entries = fs.readdirSync(dir);
const bytes = fs.readdirSync(dir, "buffer");
console.log("counts", entries.length, bytes.length);
console.log(
  "bytes match",
  bytes.every((name, i) => name.equals(Buffer.from(entries[i]!, "utf8"))),
);

try {
  fs.readdirSync(join(dir, "missing"), "buffer");
} catch (error) {
  const err = error as NodeJS.ErrnoException;
  console.log("missing", err.code, err.syscall);
}

fs.rmSync(dir, { recursive: true, force: true });
