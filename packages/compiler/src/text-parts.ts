import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/** The longest part readTextParts returns, far below the engine's string
 * limit. */
const TEXT_PART_LENGTH = 64 * 1024 * 1024;

/** Writes compiler text artifacts (LLVM, serialized IR) in large batches.
 * Programs past the engine's string limit arrive as many parts, and writing
 * each part separately is several times slower than writing the same bytes in
 * a few large chunks. Batches stay far below the limit. */
export async function writeTextParts(
  path: string,
  text: string | readonly string[],
  mode = 0o666,
): Promise<void> {
  const file = await open(path, "w", mode);
  try {
    const write = async (chunk: string): Promise<void> => {
      const bytes = Buffer.from(chunk, "utf8");
      for (let offset = 0; offset < bytes.length;) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
        offset += bytesWritten;
      }
    };
    if (typeof text === "string") return await write(text);
    let batch: string[] = [];
    let length = 0;
    for (const part of text) {
      batch.push(part);
      length += part.length;
      if (length >= 16 * 1024 * 1024) {
        await write(batch.join(""));
        batch = [];
        length = 0;
      }
    }
    if (batch.length > 0) await write(batch.join(""));
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
