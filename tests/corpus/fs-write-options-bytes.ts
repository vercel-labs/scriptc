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
