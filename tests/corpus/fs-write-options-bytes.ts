// The three-argument write forms: an options record over BYTE data and over
// a `string | Uint8Array` payload. Node writes the bytes as given and
// applies `mode` when it creates the file, `flag: "wx"` refusing an
// existing one; writeFile truncates while appendFile appends. The options
// record's encoding spelling lowers too (utf8 is what the runtime writes).
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "write-options-"));

function modeOf(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

async function main(): Promise<void> {
  // Byte data with a creation mode and the exclusive flag.
  const bytesPath = join(dir, "bytes.bin");
  await writeFile(bytesPath, new Uint8Array([0x68, 0x69, 0x0a]), { mode: 0o640, flag: "wx" });
  console.log("bytes", JSON.stringify(readFileSync(bytesPath, "utf8")), modeOf(bytesPath));
  // The same path again: O_EXCL, so Node reports EEXIST.
  try {
    await writeFile(bytesPath, new Uint8Array([1]), { mode: 0o640, flag: "wx" });
    console.log("second write allowed");
  } catch (error) {
    console.log("second write", (error as NodeJS.ErrnoException).code);
  }
  // A truncating write over an existing, longer file.
  await writeFile(bytesPath, new Uint8Array([0x6f, 0x6b]));
  console.log("truncated", JSON.stringify(readFileSync(bytesPath, "utf8")));

  // A Buffer is the same byte payload (Buffer.concat's answer, which is
  // what a zip archive writer returns).
  const bufferPath = join(dir, "buffer.bin");
  await writeFile(bufferPath, Buffer.concat([Buffer.from("zip"), Buffer.from([0])]));
  console.log("buffer", JSON.stringify(readFileSync(bufferPath, "utf8")), readFileSync(bufferPath).length);

  // fs.writeFileSync(path, bytes, { mode }).
  const syncPath = join(dir, "sync.bin");
  writeFileSync(syncPath, new Uint8Array([0x41, 0x42]), { mode: 0o600 });
  console.log("sync", JSON.stringify(readFileSync(syncPath, "utf8")), modeOf(syncPath));

  // appendFileSync(path, data, { encoding: "utf8" }) appends.
  const logPath = join(dir, "log.txt");
  appendFileSync(logPath, "one\n", { encoding: "utf8" });
  appendFileSync(logPath, "two\n", { encoding: "utf8" });
  console.log("log", JSON.stringify(readFileSync(logPath, "utf8")));

  // The bare encoding spelling is the same option, and a Buffer payload
  // carries its own bytes: no name converts them, so both spellings append
  // the view verbatim.
  appendFileSync(logPath, "three\n", "utf8");
  appendFileSync(logPath, new Uint8Array([0x62, 0x79, 0x74, 0x65, 0x0a]), { encoding: "utf-8" });
  appendFileSync(logPath, new Uint8Array([0x21, 0x0a]), "utf-8");
  console.log("log bytes", JSON.stringify(readFileSync(logPath, "utf8")));

  // The bare spelling names an encoding expression, not only a literal: a
  // call statically typed as the accepted name is still evaluated, with its
  // side effects and its exceptions, before the write.
  let encodingCalls = 0;
  function encoding(): "utf8" {
    encodingCalls++;
    return "utf8";
  }
  appendFileSync(logPath, "four\n", encoding());
  console.log("encoding evaluated", encodingCalls);
  function refuseEncoding(): "utf8" {
    throw new Error("refused encoding");
  }
  try {
    appendFileSync(logPath, "five\n", refuseEncoding());
    console.log("refused encoding wrote");
  } catch {
    console.log("refused encoding threw");
  }
  console.log("log after encoding", JSON.stringify(readFileSync(logPath, "utf8")));

  // The options record's encoding member is that same expression: the record
  // is evaluated at the write site, so the call runs, and throws, as Node's.
  let optionEncodingCalls = 0;
  function optionEncoding(): "utf8" {
    optionEncodingCalls++;
    return "utf8";
  }
  appendFileSync(logPath, "six\n", { encoding: optionEncoding() });
  console.log("option encoding evaluated", optionEncodingCalls);
  function refuseOptionEncoding(): "utf8" {
    throw new Error("refused option encoding");
  }
  try {
    appendFileSync(logPath, "seven\n", { encoding: refuseOptionEncoding() });
    console.log("refused option encoding wrote");
  } catch {
    console.log("refused option encoding threw");
  }
  console.log("log after option encoding", JSON.stringify(readFileSync(logPath, "utf8")));

  // writeFileSync(path, bytes, "utf8"): the bare spelling over byte data
  // writes the view unchanged, exactly like the record form.
  const bareBytes = join(dir, "bare-bytes.bin");
  writeFileSync(bareBytes, new Uint8Array([0x72, 0x61, 0x77]), "utf8");
  writeFileSync(bareBytes, new Uint8Array([0x21]), "utf-8");
  console.log("bare bytes", JSON.stringify(readFileSync(bareBytes, "utf8")));

  // A `string | Uint8Array` append: the live arm picks the writer.
  const appendUnion = join(dir, "append-union.txt");
  for (const payload of ["text ", new Uint8Array([0x62, 0x79, 0x74, 0x65])]) {
    appendFileSync(appendUnion, payload, { encoding: "utf8" });
  }
  console.log("append union", JSON.stringify(readFileSync(appendUnion, "utf8")));

  // A `string | Uint8Array` payload reaching the same options record: the
  // value's kind decides the bytes written.
  const payloads: (string | Uint8Array)[] = ["plain ", new Uint8Array([0x62, 0x79, 0x74, 0x65])];
  const unionPath = join(dir, "union.txt");
  for (const payload of payloads) {
    await writeFile(unionPath, payload, { mode: 0o600 });
    console.log("union", JSON.stringify(readFileSync(unionPath, "utf8")));
  }
  // The same union under the exclusive flag, and with the flag omitted.
  const unionSyncPath = join(dir, "union-sync.txt");
  for (const payload of payloads) {
    writeFileSync(unionSyncPath, payload, { flag: "w" });
    writeFileSync(unionSyncPath, payload, { mode: 0o644 });
  }
  console.log("union sync", JSON.stringify(readFileSync(unionSyncPath, "utf8")), modeOf(unionSyncPath));

  // Only the flag given: Node creates with its default mode.
  const flagOnly = join(dir, "flag-only.txt");
  await writeFile(flagOnly, new Uint8Array([0x7a]), { flag: "w" });
  console.log("flag only", JSON.stringify(readFileSync(flagOnly, "utf8")), modeOf(flagOnly));

  rmSync(dir, { recursive: true, force: true });
}

await main();
