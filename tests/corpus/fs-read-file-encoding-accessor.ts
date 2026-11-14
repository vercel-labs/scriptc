// fs.promises.readFile reads options.encoding through the property twice in
// getOptions (`!== 'buffer'`, then assertEncoding) and once more inside the
// read, with options.flag read between the second and third encoding read.
// Accessors see exactly that order, and an invalid encoding rejects before
// the flag is used — so flag "w" does not truncate the file.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsp-rf-accessor-"));
const file = path.join(dir, "file.txt");
fs.writeFileSync(file, "abc");

const order: string[] = [];
const valid = {
  get flag(): "r" {
    order.push("flag");
    return "r";
  },
  get encoding(): BufferEncoding {
    order.push("enc");
    return "utf8";
  },
};
console.log("valid", JSON.stringify(await fsp.readFile(file, valid)), order.join(","));

// flag "w" reaches the open after the encoding was accepted; opening an
// existing file for writing truncates it, then the read fails EBADF.
const order2: string[] = [];
const truncating = {
  get encoding(): BufferEncoding {
    order2.push("enc");
    return "utf8";
  },
  get flag(): "w" {
    order2.push("flag");
    return "w";
  },
};
try {
  console.log("w unexpected", await fsp.readFile(file, truncating));
} catch (error) {
  const errno = error as NodeJS.ErrnoException;
  console.log("w", errno.code, order2.join(","));
}

// An invalid encoding rejects with ERR_INVALID_ARG_VALUE from the getOptions
// validation, before the open — so the "w" file keeps its bytes.
fs.writeFileSync(file, "abc");
let reads = 0;
const invalid = {
  flag: "w" as const,
  get encoding(): BufferEncoding {
    reads += 1;
    order.push("bad enc");
    return ("no" + "pe") as BufferEncoding;
  },
};
try {
  console.log("invalid unexpected", await fsp.readFile(file, invalid));
} catch (error) {
  const errno = error as NodeJS.ErrnoException;
  console.log("invalid", errno.code, errno.message, reads, order.join(","));
}
console.log("kept", JSON.stringify(fs.readFileSync(file, "utf8")));

fs.rmSync(dir, { recursive: true, force: true });
