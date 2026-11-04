/* ICU's sources and data file, pinned and fetched for the runtime pack.
 *
 * Intl answers from ICU, so the pack builds ICU's C library from the release
 * source tarball and ships its data as a FILE the executable loads at run
 * time — never embedded in the binary. The release's data file is 31.6 MiB;
 * the pack's copy keeps the locale data, break rules and dictionaries,
 * currency data and time-zone rules the Intl forms read, 11.1 MiB, and
 * leaves out the categories in ICU_DATA_DROPPED (filterIcuData below,
 * pinned by ICU_PACK_DATA_SHA256). Neither input is vendored:
 * both come from unicode-org/icu's official GitHub release for the pinned
 * version, each downloaded once into a cache and reused after that, and each
 * verified against a pinned sha256 on every use (the source by the tarball's,
 * the data twice: the zip and the extracted `.dat`). A bad download fails
 * here with both hashes, never later in a build. Offline builds work from a
 * pre-populated cache.
 *
 * The pack build writes that copy of `icudt78l.dat` to artifacts/icu/ and
 * lists it in runtime-pack.json's `data`, so the compiler can install it
 * beside every executable that links ICU (packages/compiler/src/backend/
 * linker.ts). The
 * data zip is unpacked by the small reader below rather than a dependency:
 * it holds three stored/deflated members and nothing else. The source
 * tarball is unpacked by the system `tar`, as the libnode build does.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { inflateRawSync, crc32 } from "node:zlib";
import {
  ICU_DATA_FILE,
  ICU_DATA_SHA256,
  ICU_DATA_SIZE,
  ICU_DATA_URL,
  ICU_DATA_ZIP_SHA256,
  ICU_DATA_ZIP_SIZE,
  ICU_DATA_DROPPED,
  ICU_PACK_DATA_SHA256,
  ICU_PACK_DATA_SIZE,
  ICU_SOURCE_SHA256,
  ICU_SOURCE_SIZE,
  ICU_SOURCE_URL,
  ICU_VERSION,
} from "./icu-inputs.mjs";

const run = promisify(execFile);

/** Node v24.22.1 bundles ICU 78.3 (`process.versions.icu`), whose data
 * release is this file. */
export { ICU_DATA_FILE };
export const ICU_DATA_VERSION = ICU_VERSION;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The ICU source tree, fetched once into `cacheDir` and reused after that.
 * Returns the release root (`icu/`, holding `source/` and LICENSE); the
 * cached tarball is re-verified on every call, so a corrupted cache is
 * refetched rather than trusted. */
export async function ensureIcuSources(cacheDir) {
  const tree = join(cacheDir, `icu4c-${ICU_VERSION}-source`);
  const marker = () => join(tree, "source", "common", "sources.txt");
  if (await present(marker())) return tree;
  const tarball = join(cacheDir, `icu4c-${ICU_VERSION}-sources.tgz`);
  let archive;
  try {
    archive = await readFile(tarball);
    if (archive.length !== ICU_SOURCE_SIZE || sha256(archive) !== ICU_SOURCE_SHA256)
      throw new Error("cached ICU source tarball does not match its pin");
  } catch {
    let response;
    try {
      response = await fetch(ICU_SOURCE_URL);
    } catch (cause) {
      throw new Error(
        `could not download ICU's sources (${ICU_SOURCE_URL}); ` +
          `populate ${tarball} or allow network access`,
        { cause },
      );
    }
    if (!response.ok)
      throw new Error(
        `could not download ICU's sources (${ICU_SOURCE_URL}): ${response.status} ${response.statusText}`,
      );
    archive = Buffer.from(await response.arrayBuffer());
    if (archive.length !== ICU_SOURCE_SIZE || sha256(archive) !== ICU_SOURCE_SHA256)
      throw new Error(
        `ICU source tarball from ${ICU_SOURCE_URL} is ${archive.length} bytes with sha256 ` +
          `${sha256(archive)}, expected ${ICU_SOURCE_SIZE} bytes with sha256 ${ICU_SOURCE_SHA256}`,
      );
    await mkdir(cacheDir, { recursive: true });
    await writeFile(tarball, archive);
  }
  await mkdir(cacheDir, { recursive: true });
  const stage = await mkdtemp(join(cacheDir, ".icu-sources-"));
  try {
    await run("tar", ["-xzf", tarball, "-C", stage]);
    if (!(await present(join(stage, "icu", "source", "common", "sources.txt"))))
      throw new Error(`ICU source tarball ${ICU_SOURCE_URL} does not hold icu/source`);
    await rm(tree, { recursive: true, force: true });
    await rename(join(stage, "icu"), tree);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return tree;
}

async function present(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/** The translation units one of ICU's own source lists names, in its order.
 * The lists (`source/common/sources.txt`, `source/i18n/sources.txt`) come
 * verbatim in the fetched tarball, so a build compiles exactly the units
 * ICU's own autoconf build does. packages/compiler/src/backend/vendor-inputs.ts
 * keeps the same parser for the source-build path. */
export function icuSourceList(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** The `.dat` member of a zip archive whose entry names we trust only as far
 * as the pinned sha256 of the whole archive. Supports the two methods the
 * ICU data zip uses (0 = stored, 8 = deflate) and verifies each member's
 * CRC-32, so a truncated or altered download fails here, not at run time. */
export function unzipMember(zip, name) {
  // End of central directory: 22 bytes plus a comment of up to 64 KiB.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ICU data zip has no end-of-central-directory record");
  const entries = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("ICU data zip has a malformed central-directory entry");
    const method = zip.readUInt16LE(cursor + 10);
    const expectedCrc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    const entryName = zip.toString("utf8", nameStart, nameStart + nameLength);
    const localHeader = zip.readUInt32LE(cursor + 42);
    cursor = nameStart + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if (zip.readUInt32LE(localHeader) !== 0x04034b50)
      throw new Error(`ICU data zip member ${name} has a malformed local header`);
    const dataStart =
      localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
    const payload = zip.subarray(dataStart, dataStart + compressedSize);
    if (payload.length !== compressedSize)
      throw new Error(`ICU data zip member ${name} is truncated`);
    const contents =
      method === 0
        ? Buffer.from(payload)
        : method === 8
          ? inflateRawSync(payload)
          : (() => {
              throw new Error(`ICU data zip member ${name} uses unsupported method ${method}`);
            })();
    if (contents.length !== size)
      throw new Error(`ICU data zip member ${name} is ${contents.length} bytes, expected ${size}`);
    if (crc32(contents) !== expectedCrc)
      throw new Error(`ICU data zip member ${name} failed its CRC-32 check`);
    return contents;
  }
  throw new Error(`ICU data zip does not contain ${name}`);
}

/** The pinned data file, downloaded once into `cacheDir` and reused after
 * that. Returns the path to the extracted `.dat`, whose bytes are verified
 * against the pinned sha256 on every call (the cached zip is checked too, so
 * a corrupted cache is refetched rather than trusted). */
export async function ensureIcuData(cacheDir) {
  const zipPath = join(cacheDir, `icu4c-${ICU_DATA_VERSION}-data-bin-l.zip`);
  const dataPath = join(cacheDir, `${ICU_DATA_VERSION}`, ICU_DATA_FILE);
  if (await validFile(dataPath, ICU_DATA_SHA256, ICU_DATA_SIZE)) return dataPath;
  let zip;
  try {
    zip = await readFile(zipPath);
    if (zip.length !== ICU_DATA_ZIP_SIZE || sha256(zip) !== ICU_DATA_ZIP_SHA256)
      throw new Error("cached ICU data zip does not match its pin");
  } catch {
    const response = await fetch(ICU_DATA_URL);
    if (!response.ok)
      throw new Error(
        `could not download ICU's data (${ICU_DATA_URL}): ${response.status} ${response.statusText}`,
      );
    zip = Buffer.from(await response.arrayBuffer());
    if (zip.length !== ICU_DATA_ZIP_SIZE || sha256(zip) !== ICU_DATA_ZIP_SHA256)
      throw new Error(
        `ICU data zip from ${ICU_DATA_URL} is ${zip.length} bytes with sha256 ${sha256(zip)}, ` +
          `expected ${ICU_DATA_ZIP_SIZE} bytes with sha256 ${ICU_DATA_ZIP_SHA256}`,
      );
    await mkdir(cacheDir, { recursive: true });
    await writeFile(zipPath, zip);
  }
  const bytes = unzipMember(zip, ICU_DATA_FILE);
  if (bytes.length !== ICU_DATA_SIZE || sha256(bytes) !== ICU_DATA_SHA256)
    throw new Error(`ICU data file ${ICU_DATA_FILE} does not match its pin`);
  await mkdir(join(cacheDir, ICU_DATA_VERSION), { recursive: true });
  const temporary = `${dataPath}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, dataPath);
  return dataPath;
}

async function validFile(path, expectedSha256, expectedSize) {
  try {
    if ((await stat(path)).size !== expectedSize) return false;
    return sha256(await readFile(path)) === expectedSha256;
  } catch {
    return false;
  }
}

/** The items of an ICU common data file (a `.dat`: a header, then a table of
 * contents of name and data offsets, sorted by name, then the items): each
 * item's name (`icudt78l/coll/de.res`) and its bytes. */
export function icuDataItems(bytes) {
  const headerSize = bytes.readUInt16LE(0);
  if (bytes[2] !== 0xda || bytes[3] !== 0x27) throw new Error("not an ICU data file");
  const count = bytes.readUInt32LE(headerSize);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const nameStart = headerSize + bytes.readUInt32LE(headerSize + 4 + i * 8);
    const nameEnd = bytes.indexOf(0, nameStart);
    entries.push({
      name: bytes.toString("latin1", nameStart, nameEnd),
      start: headerSize + bytes.readUInt32LE(headerSize + 8 + i * 8),
    });
  }
  return entries.map((entry, i) => ({
    name: entry.name,
    bytes: bytes.subarray(
      entry.start,
      i + 1 < entries.length ? entries[i + 1].start : bytes.length,
    ),
  }));
}

/** Whether a data item falls under one of the ICU_DATA_DROPPED patterns. */
export function icuDataItemDropped(name, dropped = ICU_DATA_DROPPED) {
  const path = name.slice(name.indexOf("/") + 1);
  return dropped.some((pattern) =>
    pattern.startsWith("*.")
      ? !path.includes("/") && path.endsWith(pattern.slice(1))
      : path.startsWith(pattern),
  );
}

/** An ICU common data file holding the items of `bytes` that `keep` accepts,
 * in their order, laid out as icupkg writes one: the original header, the
 * table of contents, the names, then each item at a 16-byte boundary. ICU
 * finds items by a binary search of the sorted table, so a subset of a valid
 * file in its order is a valid file. */
export function filterIcuData(bytes, keep) {
  const headerSize = bytes.readUInt16LE(0);
  const items = icuDataItems(bytes).filter((item) => keep(item.name));
  const names = items.map((item) => Buffer.from(`${item.name}\0`, "latin1"));
  const tocSize = 4 + items.length * 8;
  const align = (n) => (n + 15) & ~15;
  let nameOffset = tocSize;
  let dataOffset = align(tocSize + names.reduce((sum, name) => sum + name.length, 0));
  const layout = items.map((item, i) => {
    const entry = { nameOffset, dataOffset };
    nameOffset += names[i].length;
    dataOffset = align(dataOffset + item.bytes.length);
    return entry;
  });
  const out = Buffer.alloc(headerSize + dataOffset);
  bytes.copy(out, 0, 0, headerSize);
  out.writeUInt32LE(items.length, headerSize);
  items.forEach((item, i) => {
    out.writeUInt32LE(layout[i].nameOffset, headerSize + 4 + i * 8);
    out.writeUInt32LE(layout[i].dataOffset, headerSize + 8 + i * 8);
    names[i].copy(out, headerSize + layout[i].nameOffset);
    item.bytes.copy(out, headerSize + layout[i].dataOffset);
  });
  return out;
}

/** The runtime pack's data file: the pinned icudt78l.dat without the
 * ICU_DATA_DROPPED items, written into `cacheDir` once and verified against
 * its own pin on every call. Returns its path. */
export async function ensurePackIcuData(cacheDir) {
  const dataPath = join(cacheDir, `${ICU_DATA_VERSION}-pack`, ICU_DATA_FILE);
  if (await validFile(dataPath, ICU_PACK_DATA_SHA256, ICU_PACK_DATA_SIZE)) return dataPath;
  const full = await readFile(await ensureIcuData(cacheDir));
  const bytes = filterIcuData(full, (name) => !icuDataItemDropped(name));
  if (bytes.length !== ICU_PACK_DATA_SIZE || sha256(bytes) !== ICU_PACK_DATA_SHA256)
    throw new Error(
      `filtered ICU data is ${bytes.length} bytes with sha256 ${sha256(bytes)}, ` +
        `expected ${ICU_PACK_DATA_SIZE} bytes with sha256 ${ICU_PACK_DATA_SHA256} ` +
        "(update ICU_PACK_DATA_SHA256 and ICU_PACK_DATA_SIZE in icu-inputs.mjs with ICU_DATA_DROPPED)",
    );
  await mkdir(dirname(dataPath), { recursive: true });
  const temporary = `${dataPath}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, dataPath);
  return dataPath;
}
