import { closeSync, openSync, writeSync } from "node:fs";

/** Native compiler strings stop at 2^31 - 1 UTF-8 bytes, and exceeding that
 * traps instead of throwing. Large artifacts therefore travel as bounded
 * parts; this is the part size that batching aims for. */
export const TEXT_BATCH_LENGTH = 16 * 1024 * 1024;

/** Join consecutive small parts into batches of about TEXT_BATCH_LENGTH
 * UTF-16 units, so callers hold and write few, still-bounded strings. */
export function batchTextParts(parts: readonly string[]): string[] {
  const batches: string[] = [];
  let batch: string[] = [];
  let length = 0;
  for (const part of parts) {
    batch.push(part);
    length += part.length;
    if (length >= TEXT_BATCH_LENGTH) {
      batches.push(batch.join(""));
      batch = [];
      length = 0;
    }
  }
  if (batch.length > 0) batches.push(batch.join(""));
  return batches;
}

/** The most UTF-16 units of a part that one write encodes. */
const TEXT_WRITE_LENGTH = 1024 * 1024;

/** `text` in slices of at most `length` (2 or more) UTF-16 units. A slice
 * never ends between the two halves of a surrogate pair, so the slices
 * encode, as UTF-8 or as JSON string contents, to the encoding of `text`. */
export function* textSlices(text: string, length = TEXT_WRITE_LENGTH): Generator<string> {
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + length);
    if (end < text.length) {
      const unit = text.charCodeAt(end - 1);
      if (unit >= 0xd800 && unit <= 0xdbff) end--;
    }
    yield text.slice(start, end);
    start = end;
  }
}

/** `parts` with consecutive parts joined into strings of about
 * TEXT_WRITE_LENGTH UTF-16 units (a longer part passes through whole), so
 * writing or escaping many small parts takes few calls. */
export function* joinedParts(parts: readonly string[]): Generator<string> {
  let batch: string[] = [];
  let length = 0;
  for (const part of parts) {
    batch.push(part);
    length += part.length;
    if (length >= TEXT_WRITE_LENGTH) {
      yield batch.length === 1 ? batch[0]! : batch.join("");
      batch = [];
      length = 0;
    }
  }
  if (batch.length > 0) yield batch.join("");
}

/** Encodes and writes `part` to `fd` in slices (`textSlices`), so a large
 * part is never encoded whole. `written` sees each slice after it is
 * written. */
function writeTextPart(fd: number, part: string, written?: (slice: string) => void): void {
  for (const slice of textSlices(part)) {
    const bytes = Buffer.from(slice, "utf8");
    for (let offset = 0; offset < bytes.length;) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
    written?.(slice);
  }
}

/** Write text parts to `path` in order without joining them whole: small
 * parts are written in batches (`joinedParts`). */
export function writeTextPartsSync(
  path: string,
  parts: readonly string[],
  written?: (slice: string) => void,
): void {
  const fd = openSync(path, "w");
  try {
    for (const part of joinedParts(parts)) writeTextPart(fd, part, written);
  } finally {
    closeSync(fd);
  }
}

/** writeTextPartsSync for parts generated while they are written. */
export function writeTextGeneratedSync(
  path: string,
  parts: Generator<string>,
  written?: (slice: string) => void,
): void {
  const fd = openSync(path, "w");
  try {
    for (const part of parts) writeTextPart(fd, part, written);
  } finally {
    closeSync(fd);
  }
}
