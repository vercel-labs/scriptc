import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  HUGE_TEXT_MIN_CODE_BYTES,
  elfObjectCodeBytes,
  hugeTextLinkerArgs,
  hugeTextProgram,
} from "./huge-text.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An ELF64 little-endian relocatable object's headers: one section per
 * entry, as [type, flags, size]. Section contents are left out, since only
 * the headers are read. */
function elfObject(sections: readonly [number, number, number][]): Buffer {
  const shoff = 64;
  const bytes = Buffer.alloc(shoff + (sections.length + 1) * 64);
  bytes.writeUInt32BE(0x7f454c46, 0);
  bytes[4] = 2; // ELFCLASS64
  bytes[5] = 1; // ELFDATA2LSB
  bytes[6] = 1;
  bytes.writeUInt16LE(1, 16); // ET_REL
  bytes.writeUInt16LE(62, 18); // EM_X86_64
  bytes.writeBigUInt64LE(BigInt(shoff), 40);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(sections.length + 1, 60);
  sections.forEach(([type, flags, size], index) => {
    const at = shoff + (index + 1) * 64;
    bytes.writeUInt32LE(type, at + 4);
    bytes.writeBigUInt64LE(BigInt(flags), at + 8);
    bytes.writeBigUInt64LE(BigInt(size), at + 32);
  });
  return bytes;
}

function file(name: string, bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-huge-text-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

const PROGBITS = 1;
const NOBITS = 8;
const ALLOC = 0x2;
const EXECINSTR = 0x4;

test("an object's code is the size of its executable PROGBITS sections", () => {
  const object = file(
    "program.o",
    elfObject([
      [PROGBITS, ALLOC | EXECINSTR, 3 << 20],
      [PROGBITS, ALLOC | EXECINSTR, 1000],
      [PROGBITS, ALLOC, 5 << 20],
      [NOBITS, ALLOC, 7 << 20],
    ]),
  );
  expect(elfObjectCodeBytes(object)).toBe((3 << 20) + 1000);
  expect(elfObjectCodeBytes(file("not-elf.o", Buffer.from("not an object")))).toBe(0);
  expect(elfObjectCodeBytes(join(object, "..", "missing.o"))).toBe(0);
});

test("only Linux programs with an interior 2 MiB window of code link for huge pages", () => {
  const linux = { platform: "linux" } as const;
  const half = file(
    "half.o",
    elfObject([[PROGBITS, ALLOC | EXECINSTR, HUGE_TEXT_MIN_CODE_BYTES / 2]]),
  );
  const small = file("small.o", elfObject([[PROGBITS, ALLOC | EXECINSTR, 1 << 20]]));
  expect(hugeTextProgram(linux, [half, small])).toBe(false);
  // Partitions of one program count together.
  expect(hugeTextProgram(linux, [half, half])).toBe(true);
  expect(hugeTextProgram({ platform: "darwin" } as const, [half, half])).toBe(false);
  expect(hugeTextProgram(linux, [])).toBe(false);
});

test("the 2 MiB alignment applies to lld and zig links of huge-text programs", () => {
  expect(hugeTextLinkerArgs(true, true)).toEqual(["-Wl,-z,max-page-size=0x200000"]);
  // GNU ld pads the file to the alignment.
  expect(hugeTextLinkerArgs(true, false)).toEqual([]);
  expect(hugeTextLinkerArgs(false, true)).toEqual([]);
});
