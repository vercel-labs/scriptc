import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const GLOBAL_HEADER = "!<arch>\n";
const MEMBER_HEADER_SIZE = 60;

function replaceField(bytes, offset, width, value) {
  bytes.write(value.padEnd(width, " "), offset, width, "ascii");
}

async function normalizeMetadata(output) {
  const bytes = await readFile(output);
  if (bytes.subarray(0, GLOBAL_HEADER.length).toString("ascii") !== GLOBAL_HEADER) {
    throw new Error(`archiver produced an invalid archive: ${output}`);
  }
  let offset = GLOBAL_HEADER.length;
  while (offset < bytes.length) {
    const headerEnd = offset + MEMBER_HEADER_SIZE;
    if (
      headerEnd > bytes.length ||
      bytes.subarray(offset + 58, headerEnd).toString("ascii") !== "`\n"
    ) throw new Error(`archiver produced a malformed member header: ${output}`);
    const sizeText = bytes.subarray(offset + 48, offset + 58).toString("ascii").trim();
    if (!/^\d+$/.test(sizeText)) {
      throw new Error(`archiver produced a malformed member size: ${output}`);
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || headerEnd + size > bytes.length) {
      throw new Error(`archiver produced an invalid member size: ${output}`);
    }
    // ar stores these values in fixed-width ASCII fields. They do not affect
    // member offsets or the symbol table, so normalizing them after indexing
    // works with Apple/BSD ar as well as archivers that implement a D mode.
    replaceField(bytes, offset + 16, 12, "0"); // timestamp
    replaceField(bytes, offset + 28, 6, "0"); // uid
    replaceField(bytes, offset + 34, 6, "0"); // gid
    replaceField(bytes, offset + 40, 8, "100644"); // mode
    offset = headerEnd + size + (size % 2);
  }
  if (offset !== bytes.length) throw new Error(`archiver produced a truncated archive: ${output}`);
  await writeFile(output, bytes);
}

export async function createDeterministicArchive(archiver, output, objects) {
  await run(archiver, ["rcs", output, ...objects], {
    // Ask Apple/BSD ar to omit timestamps up front, then normalize every
    // variable member-header field below for cross-account reproducibility.
    env: { ...process.env, ZERO_AR_DATE: "1" },
  });
  await normalizeMetadata(output);
}
