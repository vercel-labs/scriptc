import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const globalHeader = "!<arch>\n";
const memberHeaderSize = 60;

function replaceField(bytes, offset, width, value) {
  bytes.write(value.padEnd(width, " "), offset, width, "ascii");
}

async function normalizeMetadata(output) {
  const bytes = await readFile(output);
  if (bytes.subarray(0, globalHeader.length).toString("ascii") !== globalHeader) throw new Error(`archiver produced an invalid archive: ${output}`);
  let offset = globalHeader.length;
  while (offset < bytes.length) {
    const end = offset + memberHeaderSize;
    if (end > bytes.length || bytes.subarray(offset + 58, end).toString("ascii") !== "`\n") throw new Error(`archiver produced a malformed member header: ${output}`);
    const size = Number(bytes.subarray(offset + 48, offset + 58).toString("ascii").trim());
    if (!Number.isSafeInteger(size) || size < 0 || end + size > bytes.length) throw new Error(`archiver produced an invalid member size: ${output}`);
    replaceField(bytes, offset + 16, 12, "0");
    replaceField(bytes, offset + 28, 6, "0");
    replaceField(bytes, offset + 34, 6, "0");
    replaceField(bytes, offset + 40, 8, "100644");
    offset = end + size + (size % 2);
  }
  if (offset !== bytes.length) throw new Error(`archiver produced a truncated archive: ${output}`);
  await writeFile(output, bytes);
}

export async function createDeterministicArchive(archiver, output, objects, args = []) {
  await run(archiver, [...args, "rcs", output, ...objects], { env: { ...process.env, ZERO_AR_DATE: "1" } });
  await normalizeMetadata(output);
}
