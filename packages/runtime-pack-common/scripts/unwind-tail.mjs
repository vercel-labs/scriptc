import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/* The unwind tail of a packaged ELF object.
 *
 * LLVM pads every frame description entry (FDE) of an object's `.eh_frame`
 * to 4 bytes, except the object's last one, which it pads so that the
 * section's size is a multiple of 8 (a linker that concatenates `.eh_frame`
 * sections, as a relocatable link does, would otherwise put zero padding
 * between them, and a zero length ends the table). So the last FDE of an
 * object carries 0 or 4 extra bytes of DW_CFA_nop depending on the sizes of
 * all the FDEs before it, and linkers copy FDEs verbatim. An edit to any
 * function of a runtime unit that moves the unit's FDE total by 4 modulo 8
 * then changes the bytes of the unit's last function's FDE, and with them
 * every executable that links that function, whether or not it links the
 * function that was edited.
 *
 * Packaged objects therefore end their unwind table with the FDE of a
 * function no executable links. Every packaged ELF translation unit includes
 * unwind-tail.h, which defines one empty function in a section of its own
 * (UNWIND_TAIL_SECTION); nothing references it, so section garbage collection
 * drops it and its FDE from every executable. The compiler does not emit
 * that function last (functions it defers, such as static functions, follow
 * the last function of the source), so moveUnwindTailLast moves its FDE to
 * the end of the table and gives it the section's alignment padding. Every
 * other FDE then has the padding its own size needs, wherever it is and
 * whatever the unit's other functions are. The table keeps its size and its
 * alignment, so the object stays an ordinary one for every linker.
 *
 * ELF64 little-endian objects only: the Linux and Android packs. Mach-O
 * objects describe almost every function with compact unwind entries, and
 * COFF objects carry one `.pdata`/`.xdata` section per function, so neither
 * has a table whose last entry depends on the others. */

export const UNWIND_TAIL_SECTION = ".text.scr_unwind_tail";

/** Compiler flags that define the unwind tail function in a translation
 * unit of an object in `objectFormat`. */
export function unwindTailCompileFlags(objectFormat) {
  return objectFormat === "elf"
    ? ["-include", fileURLToPath(new URL("../unwind-tail.h", import.meta.url))]
    : [];
}

const SHT_SYMTAB = 2;
const SHT_RELA = 4;
const SHT_REL = 9;
const SHT_SYMTAB_SHNDX = 18;
const SHT_CREL = 0x40000014;
const SHN_XINDEX = 0xffff;
const RELA_SIZE = 24;
const SYMBOL_SIZE = 24;

function isElf(object) {
  return object.length >= 64 && object.readUInt32LE(0) === 0x464c457f;
}

function readSections(object) {
  if (object[4] !== 2 || object[5] !== 1)
    throw new Error("unwind tail: only ELF64 little-endian objects are supported");
  const offset = Number(object.readBigUInt64LE(0x28));
  const entrySize = object.readUInt16LE(0x3a);
  if (offset === 0) return [];
  const header = (index) => {
    const at = offset + index * entrySize;
    return {
      index,
      at,
      nameOffset: object.readUInt32LE(at),
      type: object.readUInt32LE(at + 4),
      offset: Number(object.readBigUInt64LE(at + 0x18)),
      size: Number(object.readBigUInt64LE(at + 0x20)),
      link: object.readUInt32LE(at + 0x28),
      info: object.readUInt32LE(at + 0x2c),
      alignment: Number(object.readBigUInt64LE(at + 0x30)),
    };
  };
  // An object with more sections than the header's 16-bit fields hold keeps
  // the count and the name table's index in section 0.
  let count = object.readUInt16LE(0x3c);
  let names = object.readUInt16LE(0x3e);
  if (count === 0) count = header(0).size;
  if (names === SHN_XINDEX) names = header(0).link;
  const sections = Array.from({ length: count }, (_, index) => header(index));
  const nameTable = sections[names];
  for (const section of sections) {
    const start = nameTable.offset + section.nameOffset;
    section.name = object.toString("latin1", start, object.indexOf(0, start));
  }
  return sections;
}

/** The byte length of a LEB128 value at `at`. */
function lebLength(data, at, end) {
  let length = 1;
  while (at + length <= end && (data[at + length - 1] & 0x80) !== 0) length++;
  return length;
}

/** The offset after a block at `at`: an unsigned LEB128 length and that many
 * bytes. */
function blockEnd(data, at, end) {
  const start = at + lebLength(data, at, end);
  let length = 0;
  for (let i = at, shift = 0; i < start; i++, shift += 7) length += (data[i] & 0x7f) * 2 ** shift;
  return start + length;
}

/** The size of a pointer in DW_EH_PE encoding `encoding`. */
function encodedPointerSize(encoding) {
  if (encoding === 0xff) return 0;
  switch (encoding & 0x0f) {
    case 0x00: // DW_EH_PE_absptr
    case 0x04: // DW_EH_PE_udata8
    case 0x0c: // DW_EH_PE_sdata8
      return 8;
    case 0x02: // DW_EH_PE_udata2
    case 0x0a: // DW_EH_PE_sdata2
      return 2;
    case 0x03: // DW_EH_PE_udata4
    case 0x0b: // DW_EH_PE_sdata4
      return 4;
    default:
      throw new Error(`unwind tail: pointer encoding 0x${encoding.toString(16)} has no fixed size`);
  }
}

/** The number of DW_CFA_nop bytes that follow the last other instruction of
 * the call frame program in [start, end). Padding cannot be told from
 * operand bytes without decoding: a trailing zero may be an operand. */
function trailingNops(data, start, end, pointerSize) {
  let at = start;
  let lastEnd = start;
  const leb = () => {
    at += lebLength(data, at, end);
  };
  const block = () => {
    at = blockEnd(data, at, end);
  };
  while (at < end) {
    const opcode = data[at++];
    if (opcode === 0x00) continue; // DW_CFA_nop
    const high = opcode & 0xc0;
    if (high === 0x80) leb(); // DW_CFA_offset
    else if (high === 0) {
      switch (opcode) {
        case 0x01: // DW_CFA_set_loc
          at += pointerSize;
          break;
        case 0x02: // DW_CFA_advance_loc1
          at += 1;
          break;
        case 0x03: // DW_CFA_advance_loc2
          at += 2;
          break;
        case 0x04: // DW_CFA_advance_loc4
          at += 4;
          break;
        case 0x06: // DW_CFA_restore_extended
        case 0x07: // DW_CFA_undefined
        case 0x08: // DW_CFA_same_value
        case 0x0d: // DW_CFA_def_cfa_register
        case 0x0e: // DW_CFA_def_cfa_offset
        case 0x13: // DW_CFA_def_cfa_offset_sf
        case 0x2e: // DW_CFA_GNU_args_size
          leb();
          break;
        case 0x05: // DW_CFA_offset_extended
        case 0x09: // DW_CFA_register
        case 0x0c: // DW_CFA_def_cfa
        case 0x11: // DW_CFA_offset_extended_sf
        case 0x12: // DW_CFA_def_cfa_sf
        case 0x14: // DW_CFA_val_offset
        case 0x15: // DW_CFA_val_offset_sf
        case 0x2f: // DW_CFA_GNU_negative_offset_extended
          leb();
          leb();
          break;
        case 0x0a: // DW_CFA_remember_state
        case 0x0b: // DW_CFA_restore_state
        case 0x2c: // DW_CFA_AARCH64_negate_ra_state_with_pc
        case 0x2d: // DW_CFA_GNU_window_save, DW_CFA_AARCH64_negate_ra_state
          break;
        case 0x0f: // DW_CFA_def_cfa_expression
          block();
          break;
        case 0x10: // DW_CFA_expression
        case 0x16: // DW_CFA_val_expression
          leb();
          block();
          break;
        default:
          throw new Error(`unwind tail: unknown call frame instruction 0x${opcode.toString(16)}`);
      }
    }
    // DW_CFA_advance_loc (0x40) and DW_CFA_restore (0xc0) have no operands.
    if (at > end) throw new Error("unwind tail: a call frame instruction runs past its entry");
    lastEnd = at;
  }
  return end - lastEnd;
}

/** A CIE's fields that say how to read its FDEs. */
function readCie(data, offset, end) {
  let at = offset + 8;
  const version = data[at++];
  if (version !== 1 && version !== 3)
    throw new Error(`unwind tail: unsupported CIE version ${version}`);
  const augmentationEnd = data.indexOf(0, at);
  const augmentation = data.toString("latin1", at, augmentationEnd);
  at = augmentationEnd + 1;
  if (augmentation !== "" && !augmentation.startsWith("z"))
    throw new Error(`unwind tail: unsupported CIE augmentation "${augmentation}"`);
  at += lebLength(data, at, end); // code alignment factor
  at += lebLength(data, at, end); // data alignment factor
  at += version === 1 ? 1 : lebLength(data, at, end); // return address register
  let pointerEncoding = 0x00;
  if (augmentation.startsWith("z")) {
    const instructions = blockEnd(data, at, end);
    at += lebLength(data, at, end);
    for (const letter of augmentation.slice(1)) {
      if (letter === "R") pointerEncoding = data[at++];
      else if (letter === "L") at++;
      else if (letter === "P") at += 1 + encodedPointerSize(data[at]);
      // "S" (signal frame), "B" and "G" (AArch64 pointer authentication and
      // memory tagging) carry no data. The data of a letter this does not
      // know cannot be skipped, so the walk ends there with the fields read
      // so far; the length above still says where the instructions start.
      else if (!"SBG".includes(letter)) break;
    }
    at = instructions;
  }
  return {
    sized: augmentation.startsWith("z"),
    pointerSize: encodedPointerSize(pointerEncoding),
    instructions: at,
  };
}

/** The entries of an `.eh_frame` section's bytes, in order. */
function readEntries(data) {
  const entries = [];
  const cies = new Map();
  for (let offset = 0; offset < data.length;) {
    if (offset + 8 > data.length) throw new Error("unwind tail: an .eh_frame entry is cut short");
    const length = data.readUInt32LE(offset);
    if (length === 0) throw new Error("unwind tail: .eh_frame holds a terminator");
    if (length === 0xffffffff) throw new Error("unwind tail: 64-bit .eh_frame entries");
    const end = offset + 4 + length;
    if (end > data.length) throw new Error("unwind tail: an .eh_frame entry runs past the section");
    const id = data.readUInt32LE(offset + 4);
    let instructions;
    let cie = null;
    let pointerSize;
    if (id === 0) {
      const read = readCie(data, offset, end);
      cies.set(offset, read);
      ({ instructions, pointerSize } = read);
    } else {
      cie = offset + 4 - id;
      const read = cies.get(cie);
      if (read === undefined) throw new Error("unwind tail: an FDE names no CIE before it");
      pointerSize = read.pointerSize;
      instructions = offset + 8 + 2 * pointerSize;
      if (read.sized) instructions = blockEnd(data, instructions, end);
    }
    if (instructions > end)
      throw new Error("unwind tail: an .eh_frame entry's header is cut short");
    entries.push({
      offset,
      size: end - offset,
      cie,
      nops: trailingNops(data, instructions, end, pointerSize),
    });
    offset = end;
  }
  return entries;
}

/** An ELF object's unwind table: its section, entries and relocations, with
 * the section each FDE describes. Null when the object has no `.eh_frame`. */
function readUnwindTable(object) {
  const sections = readSections(object);
  const section = sections.find((candidate) => candidate.name === ".eh_frame");
  if (section === undefined || section.size === 0) return null;
  const applying = sections.filter(
    (candidate) =>
      candidate.info === section.index &&
      (candidate.type === SHT_RELA || candidate.type === SHT_REL || candidate.type === SHT_CREL),
  );
  if (applying.some((candidate) => candidate.type !== SHT_RELA) || applying.length > 1)
    throw new Error("unwind tail: .eh_frame relocations are not one SHT_RELA section");
  const relocations = applying[0] ?? null;
  const data = object.subarray(section.offset, section.offset + section.size);
  const entries = readEntries(data);
  // The section of the function each FDE describes: the section of the
  // symbol its first field (the function's address) is relocated against.
  const targets = new Map();
  if (relocations !== null) {
    const symbols = sections[relocations.link];
    if (symbols.type !== SHT_SYMTAB)
      throw new Error("unwind tail: relocations name no symbol table");
    const extended = sections.find(
      (candidate) => candidate.type === SHT_SYMTAB_SHNDX && candidate.link === symbols.index,
    );
    for (let at = relocations.offset; at < relocations.offset + relocations.size; at += RELA_SIZE) {
      const symbol = Number(object.readBigUInt64LE(at + 8) >> 32n);
      let index = object.readUInt16LE(symbols.offset + symbol * SYMBOL_SIZE + 6);
      if (index === SHN_XINDEX) {
        if (extended === undefined) throw new Error("unwind tail: a symbol's section is missing");
        index = object.readUInt32LE(extended.offset + symbol * 4);
      }
      targets.set(Number(object.readBigUInt64LE(at)), sections[index]?.name ?? null);
    }
  }
  for (const entry of entries)
    entry.target = entry.cie === null ? null : (targets.get(entry.offset + 8) ?? null);
  return { sections, section, relocations, data, entries };
}

/** Move the unwind tail function's FDE to the end of an ELF object's
 * `.eh_frame`, in place, and give it the section's alignment padding. The
 * section keeps its size. Returns whether the object's bytes changed. Throws
 * when the object has an unwind table without exactly one unwind tail
 * function: the translation unit was compiled without unwind-tail.h. */
export function moveUnwindTailLast(object) {
  if (!isElf(object)) throw new Error("unwind tail: not an ELF object");
  const table = readUnwindTable(object);
  if (table === null) throw new Error("unwind tail: the object has no .eh_frame");
  const { section, relocations, data, entries } = table;
  const tails = entries.filter((entry) => entry.target === UNWIND_TAIL_SECTION);
  if (tails.length !== 1)
    throw new Error(
      `unwind tail: expected one FDE for ${UNWIND_TAIL_SECTION}, found ${tails.length}`,
    );
  const order = [...entries.filter((entry) => entry !== tails[0]), tails[0]];
  // Each entry keeps the padding its own size needs: whole words of trailing
  // DW_CFA_nop are alignment padding that depended on the other entries.
  let end = 0;
  for (const entry of order) {
    entry.moved = end;
    entry.kept = entry.size - (entry.nops & ~3);
    end += entry.kept;
  }
  const padding = section.size - end;
  if (padding < 0 || padding >= Math.max(section.alignment, 4) || padding % 4 !== 0)
    throw new Error(`unwind tail: .eh_frame cannot keep its size (${padding} bytes left over)`);
  const moved = new Map(entries.map((entry) => [entry.offset, entry.moved]));
  const rebuilt = Buffer.alloc(section.size);
  for (const entry of order) {
    data.copy(rebuilt, entry.moved, entry.offset, entry.offset + entry.kept);
    const last = entry === tails[0];
    rebuilt.writeUInt32LE(entry.kept + (last ? padding : 0) - 4, entry.moved);
    // An FDE names its CIE by the distance back from this field.
    if (entry.cie !== null)
      rebuilt.writeUInt32LE(entry.moved + 4 - moved.get(entry.cie), entry.moved + 4);
  }
  const before = Buffer.concat([
    data,
    relocations === null
      ? Buffer.alloc(0)
      : object.subarray(relocations.offset, relocations.offset + relocations.size),
  ]);
  if (relocations !== null) {
    const records = [];
    for (let at = relocations.offset; at < relocations.offset + relocations.size; at += RELA_SIZE) {
      const record = Buffer.from(object.subarray(at, at + RELA_SIZE));
      const offset = Number(record.readBigUInt64LE(0));
      const entry = entries.findLast((candidate) => candidate.offset <= offset);
      if (entry === undefined || offset >= entry.offset + entry.kept)
        throw new Error("unwind tail: a relocation applies to alignment padding");
      record.writeBigUInt64LE(BigInt(offset - entry.offset + entry.moved), 0);
      records.push(record);
    }
    // Linkers read the relocations of an entry in address order.
    records
      .map((record, index) => ({ record, index, offset: record.readBigUInt64LE(0) }))
      .sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : a.index - b.index))
      .forEach(({ record }, index) => record.copy(object, relocations.offset + index * RELA_SIZE));
  }
  rebuilt.copy(object, section.offset);
  const after = Buffer.concat([
    object.subarray(section.offset, section.offset + section.size),
    relocations === null
      ? Buffer.alloc(0)
      : object.subarray(relocations.offset, relocations.offset + relocations.size),
  ]);
  return !before.equals(after);
}

/** What keeps an object's unwind table from being independent of the
 * object's other functions: an empty list for a packaged object as
 * moveUnwindTailLast leaves it, and for an object that is not ELF. */
export function unwindTailProblems(object) {
  if (!isElf(object)) return [];
  const table = readUnwindTable(object);
  if (table === null) return ["the object has no .eh_frame, so no unwind tail function"];
  const problems = [];
  const last = table.entries.at(-1);
  if (last.target !== UNWIND_TAIL_SECTION)
    problems.push(
      `the last FDE describes ${last.target ?? "no section"}, not ${UNWIND_TAIL_SECTION}: its alignment padding depends on the object's other functions`,
    );
  for (const entry of table.entries.slice(0, -1)) {
    if (entry.target === UNWIND_TAIL_SECTION)
      problems.push(`the FDE of ${UNWIND_TAIL_SECTION} at ${entry.offset} is not the last one`);
    if (entry.nops >= 4)
      problems.push(
        `the entry at ${entry.offset} (${entry.target ?? "a CIE"}) ends in ${entry.nops} bytes of padding`,
      );
  }
  return problems;
}

/** A summary of an ELF object's unwind table: the section's file offset,
 * size and alignment and, per entry, its offset in the section, size,
 * trailing padding and the section it describes. Null for an object without
 * `.eh_frame`. */
export function describeUnwindTable(object) {
  if (!isElf(object)) return null;
  const table = readUnwindTable(object);
  if (table === null) return null;
  return {
    offset: table.section.offset,
    size: table.section.size,
    alignment: table.section.alignment,
    entries: table.entries.map(({ offset, size, cie, nops, target }) => ({
      offset,
      size,
      kind: cie === null ? "cie" : "fde",
      nops,
      target,
    })),
  };
}

/** The members of an `ar` archive that hold object files, as
 * { name, data } with `data` a view into `archive`. */
export function archiveMembers(archive) {
  if (archive.toString("latin1", 0, 8) !== "!<arch>\n") throw new Error("not an ar archive");
  const members = [];
  let longNames = null;
  for (let at = 8; at + 60 <= archive.length;) {
    const field = (start, length) => archive.toString("latin1", at + start, at + start + length);
    const size = Number.parseInt(field(48, 10), 10);
    const data = archive.subarray(at + 60, at + 60 + size);
    let name = field(0, 16).trimEnd();
    at += 60 + size + (size % 2);
    // GNU archives: "/" is the symbol index, "//" the long-name table, and
    // "/<offset>" a name in that table.
    if (name === "/" || name === "/SYM64/") continue;
    if (name === "//") {
      longNames = data;
      continue;
    }
    if (/^\/\d+$/.test(name)) {
      const start = Number.parseInt(name.slice(1), 10);
      name = longNames.toString("latin1", start, longNames.indexOf("\n", start));
    }
    members.push({ name: name.replace(/\/$/, ""), data });
  }
  return members;
}

/** The unwind tail problems of every object file and archive member under
 * `root`, as "<path>: <problem>" lines. */
export async function unwindTailProblemsUnder(root) {
  const problems = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".o"))
        for (const problem of unwindTailProblems(await readFile(path)))
          problems.push(`${relative(root, path)}: ${problem}`);
      else if (entry.name.endsWith(".a"))
        for (const member of archiveMembers(await readFile(path)))
          for (const problem of unwindTailProblems(member.data))
            problems.push(`${relative(root, path)}(${member.name}): ${problem}`);
    }
  };
  await visit(root);
  return problems;
}

/** Fail a pack build whose artifacts under `root` hold an object with an
 * unwind table that does not end with the unwind tail function's entry. */
export async function assertUnwindTails(root) {
  const problems = await unwindTailProblemsUnder(root);
  if (problems.length > 0)
    throw new Error(
      `runtime-pack artifacts whose unwind table depends on their other functions (${problems.length}):\n${problems.slice(0, 20).join("\n")}`,
    );
}
