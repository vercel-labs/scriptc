import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const file = join(tmpdir(), `scriptc-encoding-${process.pid}.bin`);
const bytes = Buffer.from([0, 65, 127, 128, 195, 169, 255, 0]);
writeFileSync(file, bytes);
try {
  const encodings: BufferEncoding[] = ["utf8", "latin1", "binary", "ascii", "hex", "base64", "base64url", "utf16le", "ucs2"];
  for (const encoding of encodings) {
    console.log(readFileSync(file, encoding) === bytes.toString(encoding));
    console.log(readFileSync(file, { encoding }) === bytes.toString(encoding));
    const fd = openSync(file, "r");
    try { console.log(readFileSync(fd, encoding) === bytes.toString(encoding)); }
    finally { closeSync(fd); }
    const optionsFd = openSync(file, "r");
    try { console.log(readFileSync(optionsFd, { encoding }) === bytes.toString(encoding)); }
    finally { closeSync(optionsFd); }
  }
  console.log(readFileSync(file, "latin1").charCodeAt(6));
  console.log(Buffer.isBuffer(readFileSync(file, "")));
  console.log(Buffer.isBuffer(readFileSync(file, { encoding: "" })));
  const upper = readFileSync(file, "LATIN1");
  console.log(typeof upper === "string" && upper.charCodeAt(6) === 255);
  let order = "";
  function source(): string { order += "path"; return file; }
  function encoding(): BufferEncoding { order += ":encoding"; return "latin1"; }
  console.log(readFileSync(source(), encoding()) === bytes.toString("latin1"), order);
  try { readFileSync(file + ".missing", "invalid" as BufferEncoding); }
  catch (error) { console.log(error instanceof TypeError, (error as NodeJS.ErrnoException).code); }
} finally { unlinkSync(file); }
