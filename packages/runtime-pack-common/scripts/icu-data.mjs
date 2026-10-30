/* ICU's sources and data file, pinned and fetched for the runtime pack.
 *
 * Intl answers from ICU, so the pack builds ICU's C library from the release
 * source tarball and ships its data as a FILE the executable loads at run
 * time (31.6 MiB of CLDR patterns, locale metadata, break rules and
 * time-zone shapes) — never embedded in the binary. Neither is vendored:
 * both come from unicode-org/icu's official GitHub release for the pinned
 * version, each downloaded once into a cache and reused after that, and each
 * verified against a pinned sha256 on every use (the source by the tarball's,
 * the data twice: the zip and the extracted `.dat`). A bad download fails
 * here with both hashes, never later in a build. Offline builds work from a
 * pre-populated cache.
 *
 * The pack build drops `icudt78l.dat` into artifacts/icu/ and lists it in
 * runtime-pack.json's `data`, so the compiler can install it beside every
 * executable that links ICU (packages/compiler/src/backend/linker.ts). The
 * data zip is unpacked by the small reader below rather than a dependency:
 * it holds three stored/deflated members and nothing else. The source
 * tarball is unpacked by the system `tar`, as the libnode build does.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { inflateRawSync, crc32 } from "node:zlib";
import {
  ICU_DATA_FILE,
  ICU_DATA_SHA256,
  ICU_DATA_SIZE,
  ICU_DATA_URL,
  ICU_DATA_ZIP_SHA256,
  ICU_DATA_ZIP_SIZE,
  ICU_SOURCE_SHA256,
  ICU_SOURCE_SIZE,
  ICU_SOURCE_URL,
  ICU_VERSION,
} from "./icu-inputs.mjs";

const run = promisify(execFile);

/** Node v24.22.0 bundles ICU 78.3 (`process.versions.icu`), whose data
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
  if (await validFile(dataPath, ICU_DATA_SHA256)) return dataPath;
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

async function validFile(path, expectedSha256) {
  try {
    if ((await stat(path)).size !== ICU_DATA_SIZE) return false;
    return sha256(await readFile(path)) === expectedSha256;
  } catch {
    return false;
  }
}
