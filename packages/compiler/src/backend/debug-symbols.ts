import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HEADER = Buffer.from("SCDSYM01");

export function needsDarwinDebugSymbols(
  platform: string,
  optimization?: string,
  strip = false,
): boolean {
  return platform === "darwin" && optimization === "dev" && !strip;
}

/** Run before deleting link inputs: Mach-O executables retain a debug map,
 * while the actual line tables live in those temporary object files.
 *
 * A sanitized dev build references runtime symbols that its temporary objects
 * do not define, and darwin's dsymutil warns once per reference — tens of
 * thousands of lines, past the 1 MiB a child's stderr may hold by default.
 * `-q` limits that stream, and the buffer covers what it still prints; a real
 * failure keeps dsymutil's stderr for the compile error. */
export async function createDarwinDebugSymbols(binary: string): Promise<void> {
  await exec("dsymutil", ["-q", binary, "-o", `${binary}.dSYM`], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Keep the two dSYM payloads together as one integrity-checked cache file.
 * Names are fixed by the output, never accepted from serialized cache data. */
export async function readDarwinDebugSymbols(binary: string): Promise<Buffer> {
  const contents = join(`${binary}.dSYM`, "Contents");
  const [plist, dwarf] = await Promise.all([
    readFile(join(contents, "Info.plist")),
    readFile(join(contents, "Resources", "DWARF", basename(binary))),
  ]);
  const sizes = Buffer.alloc(4);
  sizes.writeUInt32LE(plist.length);
  return Buffer.concat([HEADER, sizes, plist, dwarf]);
}

export async function installDarwinDebugSymbols(bytes: Buffer, binary: string): Promise<void> {
  if (bytes.length < 12 || !bytes.subarray(0, 8).equals(HEADER))
    throw new Error("invalid cached dSYM");
  const plistEnd = 12 + bytes.readUInt32LE(8);
  if (plistEnd <= 12 || plistEnd >= bytes.length) throw new Error("invalid cached dSYM sizes");
  const current = await readDarwinDebugSymbols(binary).catch(() => null);
  if (current?.equals(bytes)) return;
  const stage = await mkdtemp(join(dirname(binary), ".scriptc-dsym-"));
  try {
    const contents = join(stage, "Contents");
    const dwarfDir = join(contents, "Resources", "DWARF");
    await mkdir(dwarfDir, { recursive: true });
    await Promise.all([
      writeFile(join(contents, "Info.plist"), bytes.subarray(12, plistEnd)),
      writeFile(join(dwarfDir, basename(binary)), bytes.subarray(plistEnd)),
    ]);
    await rm(`${binary}.dSYM`, { recursive: true, force: true });
    await rename(stage, `${binary}.dSYM`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
