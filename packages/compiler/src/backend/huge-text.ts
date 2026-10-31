/**
 * Text on 2 MiB pages for large Linux executables.
 *
 * The kernel maps a 2 MiB window of an executable's text with one huge page
 * when the window's virtual address and file offset are both 2 MiB aligned
 * and the page cache holds the window as one 2 MiB folio. A link with
 * `-z max-page-size=0x200000` keeps every segment's address congruent to its
 * file offset modulo 2 MiB, so every 2 MiB window inside the text segment
 * qualifies. lld and zig add no file padding for it; GNU ld pads the file to
 * the alignment, so links that fall back to it leave the flag out.
 *
 * The alignment also aligns a position-independent executable's load
 * address to 2 MiB, which leaves 19 bits of address randomization for it
 * instead of 28. Only executables whose program code fills an interior 2 MiB
 * window can gain from huge pages, so smaller executables link as before.
 *
 * lld writes its output through a memory mapping, which leaves the file in
 * the page cache as 4 KiB folios. A large executable is published by writing
 * its bytes with one write instead, which leaves 2 MiB folios where the file
 * system supports them. The runtime advises the interior windows huge pages
 * at startup (scr_lib.c), so a file that is read back from disk is read as
 * 2 MiB folios too.
 */
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { NativeTargetSpec } from "./targets.js";

/** Program code from which an executable is linked for huge pages: text of
 * this size has at least one 2 MiB window inside it wherever it starts. */
export const HUGE_TEXT_MIN_CODE_BYTES = 4 << 20;

const SHF_EXECINSTR = 0x4n;

/** The bytes of executable sections in an ELF64 little-endian object, or 0
 * when the file is not one or cannot be read. Reads only the file and
 * section headers. */
export function elfObjectCodeBytes(path: string): number {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return 0;
  }
  try {
    const header = Buffer.alloc(64);
    if (readSync(fd, header, 0, 64, 0) !== 64) return 0;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getUint32(0, false) !== 0x7f454c46 || header[4] !== 2 || header[5] !== 1) return 0;
    const shoff = Number(view.getBigUint64(40, true));
    const shentsize = view.getUint16(58, true);
    let shnum = view.getUint16(60, true);
    if (shentsize !== 64 || shoff === 0) return 0;
    if (shnum === 0) {
      const first = Buffer.alloc(64);
      if (readSync(fd, first, 0, 64, shoff) !== 64) return 0;
      shnum = Number(new DataView(first.buffer, first.byteOffset, 64).getBigUint64(32, true));
    }
    const table = Buffer.alloc(shnum * 64);
    if (readSync(fd, table, 0, table.length, shoff) !== table.length) return 0;
    const sections = new DataView(table.buffer, table.byteOffset, table.byteLength);
    let code = 0;
    for (let i = 0; i < shnum; i++) {
      const at = i * 64;
      // SHT_PROGBITS sections with SHF_EXECINSTR.
      if (sections.getUint32(at + 4, true) !== 1) continue;
      if ((sections.getBigUint64(at + 8, true) & SHF_EXECINSTR) === 0n) continue;
      code += Number(sections.getBigUint64(at + 32, true));
    }
    return code;
  } finally {
    closeSync(fd);
  }
}

/** Whether a link of these program objects is laid out for huge pages. */
export function hugeTextProgram(
  target: Pick<NativeTargetSpec, "platform">,
  programObjects: readonly string[],
): boolean {
  if (target.platform !== "linux") return false;
  let code = 0;
  for (const object of programObjects) {
    code += elfObjectCodeBytes(object);
    if (code >= HUGE_TEXT_MIN_CODE_BYTES) return true;
  }
  return false;
}

/** The link arguments that align a huge-text executable's segments to
 * 2 MiB, for links by lld or zig. */
export function hugeTextLinkerArgs(hugeText: boolean, linksWithLldOrZig: boolean): string[] {
  return hugeText && linksWithLldOrZig ? ["-Wl,-z,max-page-size=0x200000"] : [];
}

/** Rewrites a linked huge-text executable with one write, so the page cache
 * holds it in 2 MiB folios; its caller then publishes it as usual. */
export function rewriteHugeTextExecutable(linked: string): void {
  const written = `${linked}.written`;
  writeFileSync(written, readFileSync(linked));
  chmodSync(written, statSync(linked).mode & 0o7777);
  renameSync(written, linked);
}
