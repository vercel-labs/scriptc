import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/** The longest part readTextParts returns, far below the engine's string
 * limit. */
const TEXT_PART_LENGTH = 64 * 1024 * 1024;

/** One part of compiler text: a string, or the UTF-8 bytes of one, which a
 * large build keeps off the V8 heap (`TextPart` in the LLVM emitter). */
export type TextPart = string | Uint8Array;

/** A part as text: a byte part is its UTF-8 decoding (the emitter writes
 * ASCII, which round-trips exactly). */
export function textOfPart(part: TextPart): string {
  return typeof part === "string" ? part : Buffer.from(part.subarray(0)).toString("utf8");
}

/** Whether a part's text contains `needle` (ASCII), without decoding a byte
 * part. */
export function partIncludes(part: TextPart, needle: string): boolean {
  if (typeof part === "string") return part.includes(needle);
  return Buffer.from(part.subarray(0)).includes(needle);
}

/** Text as a part kept off the V8 heap. */
export function bytesOfText(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

/** Writes compiler text artifacts (LLVM, serialized IR) in large batches.
 * Programs past the engine's string limit arrive as many parts, and writing
 * each part separately is several times slower than writing the same bytes in
 * a few large chunks. Batches stay far below the limit. A part that arrives
 * as bytes is written as it is. */
export async function writeTextParts(
  path: string,
  text: TextPart | readonly TextPart[],
  mode = 0o666,
): Promise<void> {
  const file = await open(path, "w", mode);
  try {
    const write = async (chunk: TextPart): Promise<void> => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      for (let offset = 0; offset < bytes.length;) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
        offset += bytesWritten;
      }
    };
    if (!Array.isArray(text)) return await write(text as TextPart);
    // A byte part and the newline around it arrive as separate parts, so the
    // batch holds bytes: a string part is encoded into it, and each batch is
    // one write.
    let batch: Uint8Array[] = [];
    let length = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      await write(batch.length === 1 ? batch[0]! : Buffer.concat(batch));
      batch = [];
      length = 0;
    };
    for (const part of text) {
      const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : part;
      batch.push(bytes);
      length += bytes.byteLength;
      if (length >= 16 * 1024 * 1024) await flush();
    }
    await flush();
  } finally {
    await file.close();
  }
}

/** Reads a text artifact as parts of at most `partLength` UTF-16 units:
 * cached LLVM and serialized IR of large programs exceed the engine's
 * string limit as one string. The decoder carries a multi-byte sequence
 * split across reads into the next part, and no part ends inside a
 * surrogate pair, so the parts join to the file's text and each encodes on
 * its own. */
export async function readTextParts(
  path: string,
  partLength = TEXT_PART_LENGTH,
): Promise<string[]> {
  const decoder = new StringDecoder("utf8");
  const parts: string[] = [];
  let pending: string[] = [];
  let pendingLength = 0;
  const flush = (): void => {
    if (pendingLength === 0) return;
    parts.push(pending.join(""));
    pending = [];
    pendingLength = 0;
  };
  const add = (text: string): void => {
    for (let offset = 0; offset < text.length;) {
      let take = Math.min(text.length - offset, partLength - pendingLength);
      // A part never ends inside a surrogate pair: writeTextParts encodes
      // its batches separately.
      const last = text.charCodeAt(offset + take - 1);
      if (take > 1 && last >= 0xd800 && last <= 0xdbff && offset + take < text.length) take--;
      pending.push(text.slice(offset, offset + take));
      pendingLength += take;
      offset += take;
      if (pendingLength >= partLength - 1) flush();
    }
  };
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 }))
    add(decoder.write(chunk as Buffer));
  add(decoder.end());
  flush();
  return parts;
}
