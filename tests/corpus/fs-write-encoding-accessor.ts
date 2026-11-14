// fs.promises.writeFile/appendFile read options.encoding through the
// property. An accessor answers a newly allocated string each time; the
// bytes written come from the encoding it names, so the returned string has
// to outlive the read until the data is encoded (the sanitizer lane catches
// a release that leaves the reader dangling).
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsp-write-accessor-"));
const file = path.join(dir, "file.txt");

let reads = 0;
const latin1 = {
  get encoding(): BufferEncoding {
    reads += 1;
    // A fresh concatenation, not an interned literal.
    return ("latin" + "1") as BufferEncoding;
  },
};
await fsp.writeFile(file, "é", latin1);
console.log("written", fs.readFileSync(file).toString("hex"), reads > 0);

await fsp.appendFile(file, "ü", latin1);
console.log("appended", fs.readFileSync(file).toString("hex"), reads > 0);

// The utf8 default still applies when the accessor answers utf8.
const utf8 = {
  get encoding(): BufferEncoding {
    return ("ut" + "f8") as BufferEncoding;
  },
  flag: "w" as const,
};
await fsp.writeFile(file, "€", utf8);
console.log("utf8", fs.readFileSync(file).toString("hex"));

// An accessor naming an unknown encoding rejects before the file is opened,
// so the previous bytes survive.
let invalidReads = 0;
const invalid = {
  flag: "w" as const,
  get encoding(): BufferEncoding {
    invalidReads += 1;
    return ("no" + "pe") as BufferEncoding;
  },
};
try {
  await fsp.writeFile(file, "x", invalid);
  console.log("invalid unexpected");
} catch (error) {
  const errno = error as NodeJS.ErrnoException;
  console.log("invalid", errno.code, errno.message, invalidReads > 0);
}
console.log("kept", fs.readFileSync(file).toString("hex"));

fs.rmSync(dir, { recursive: true, force: true });
