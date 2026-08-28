/* Format-aware symbol localization for multi-instance library mode
 * (abi.localize_runtime) — the in-process half of native-toolchain.ts's
 * localizeLibraryObjects. Host toolchains cover the classic pairings
 * (darwin's ld64 does combine+demote in one step; host-linux binutils runs
 * `ld -r` + objcopy), but no portable toolchain performs the COFF
 * equivalent at all — lld-link has no relocatable mode (mirroring MSVC
 * link.exe) and llvm-objcopy rejects symbol-scope flags for COFF — and
 * cross ELF demotion would otherwise require a host binutils/llvm-objcopy
 * that neither `zig cc` nor a stock macOS ships. These transforms close
 * both gaps with no external tool:
 *
 *   localizeElfObject      demote every defined global/weak symbol outside
 *                          the keep set to a local symbol in a relocatable
 *                          ELF64 object (the output of `zig cc -r`), and
 *                          resolve COMDAT section groups the way binutils'
 *                          --force-group-allocation does — a group whose
 *                          signature repeats across archives sharing
 *                          runtime objects must not be deduplicated against
 *                          another archive's copy at the embedder's link.
 *
 *   mergeAndLocalizeCoffObjects
 *                          the COFF combine+demote in one pass: include every
 *                          root object, pull support objects on undefined-
 *                          symbol demand (the staging-archive member semantics
 *                          `ld -r` gives the other formats), concatenate the
 *                          selected objects' sections, resolve cross-object
 *                          symbol references by index, then demote every
 *                          defined external outside the keep set to a static
 *                          symbol.
 *
 * Shared demotion rule (GNU objcopy --keep-global-symbols semantics):
 * undefined references keep their global binding (the target C/math runtime,
 * system APIs, and sanitizer ABI are the embedder's by design), and COMMON
 * symbols stay global — sanitizer image-registration guards are COMMONs whose
 * merging across archives is the documented single-registration discipline.
 * Windows embedders additionally link advapi32, iphlpapi, and ws2_32. */

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

class ObjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectFormatError";
  }
}

function fail(message: string): never {
  throw new ObjectFormatError(message);
}

/* ────────────────────────────── ELF64 ─────────────────────────────────── */

const SHT_NULL = 0;
const SHT_SYMTAB = 2;
const SHT_RELA = 4;
const SHT_NOBITS = 8;
const SHT_REL = 9;
const SHT_GROUP = 17;
const SHT_SYMTAB_SHNDX = 18;
const SHT_LLVM_ADDRSIG = 0x6fff4c03;
const SHF_GROUP = 0x200n;
const SHN_UNDEF = 0;
const SHN_LORESERVE = 0xff00;
const SHN_COMMON = 0xfff2;
const SHN_XINDEX = 0xffff;
const STB_LOCAL = 0;

interface ElfSection {
  nameOffset: number;
  type: number;
  flags: bigint;
  addr: bigint;
  size: bigint;
  link: number;
  info: number;
  addralign: bigint;
  entsize: bigint;
  data: Uint8Array;
}

interface ElfSymbol {
  nameOffset: number;
  name: string;
  info: number;
  other: number;
  /** Resolved section index (SHT_SYMTAB_SHNDX applied), or a reserved
   * SHN_* value below/at SHN_LORESERVE semantics. */
  shndx: number;
}

/** Demote every defined global/weak symbol not named in `keep` to a local
 * symbol in a relocatable ELF64 little-endian object, resolving COMDAT
 * section groups in the same pass. The input is the combined object a
 * relocatable link produced; the output is byte-rebuilt (fresh layout,
 * same section content). */
export function localizeElfObject(object: Uint8Array, keep: ReadonlySet<string>): Uint8Array {
  const view = new DataView(object.buffer, object.byteOffset, object.byteLength);
  if (object.byteLength < 64 || view.getUint32(0, false) !== 0x7f454c46) {
    fail("not an ELF object");
  }
  if (object[4] !== 2 || object[5] !== 1) {
    fail("unsupported ELF class/encoding (need ELF64, little-endian)");
  }
  if (view.getUint16(16, true) !== 1) fail("not a relocatable ELF object (ET_REL)");
  const machine = view.getUint16(18, true);
  const flags = view.getUint32(48, true);
  const shoff = Number(view.getBigUint64(40, true));
  const shentsize = view.getUint16(58, true);
  if (shentsize !== 64) fail(`unsupported ELF section header size ${shentsize}`);
  let shnum = view.getUint16(60, true);
  let shstrndx = view.getUint16(62, true);
  if (shnum === 0) shnum = Number(view.getBigUint64(shoff + 32, true));
  if (shstrndx === SHN_XINDEX) shstrndx = view.getUint32(shoff + 40, true);

  const sections: ElfSection[] = [];
  for (let i = 0; i < shnum; i++) {
    const at = shoff + i * 64;
    const type = view.getUint32(at + 4, true);
    const offset = Number(view.getBigUint64(at + 24, true));
    const size = view.getBigUint64(at + 32, true);
    sections.push({
      nameOffset: view.getUint32(at, true),
      type,
      flags: view.getBigUint64(at + 8, true),
      addr: view.getBigUint64(at + 16, true),
      size,
      link: view.getUint32(at + 40, true),
      info: view.getUint32(at + 44, true),
      addralign: view.getBigUint64(at + 48, true),
      entsize: view.getBigUint64(at + 56, true),
      data:
        type === SHT_NOBITS || type === SHT_NULL
          ? new Uint8Array(0)
          : object.subarray(offset, offset + Number(size)),
    });
  }

  const symtabIndex = sections.findIndex((s) => s.type === SHT_SYMTAB);
  if (symtabIndex < 0) fail("ELF object has no symbol table");
  const symtab = sections[symtabIndex]!;
  const strtab = sections[symtab.link];
  if (strtab === undefined) fail("ELF symbol table names an invalid string table");

  // SHT_SYMTAB_SHNDX (only present when section indices overflow st_shndx):
  // resolve the real indices up front and drop the section — the rebuilt
  // object's section count only shrinks, so inline indices always fit.
  const shndxSection = sections.find(
    (s) => s.type === SHT_SYMTAB_SHNDX && sections[s.link] === symtab,
  );
  const shndxView =
    shndxSection === undefined
      ? null
      : new DataView(
          shndxSection.data.buffer,
          shndxSection.data.byteOffset,
          shndxSection.data.byteLength,
        );

  const symbolName = (offset: number): string => {
    const bytes = strtab!.data;
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return textDecoder.decode(bytes.subarray(offset, end));
  };

  const symCount = Number(symtab.size) / 24;
  const symView = new DataView(symtab.data.buffer, symtab.data.byteOffset, symtab.data.byteLength);
  const symbols: ElfSymbol[] = [];
  for (let i = 0; i < symCount; i++) {
    const at = i * 24;
    let shndx: number = symView.getUint16(at + 6, true);
    if (shndx === SHN_XINDEX) {
      if (shndxView === null) fail("ELF symbol uses SHN_XINDEX without a SHT_SYMTAB_SHNDX table");
      shndx = shndxView.getUint32(i * 4, true);
    }
    symbols.push({
      nameOffset: symView.getUint32(at, true),
      name: symbolName(symView.getUint32(at, true)),
      info: symView.getUint8(at + 4),
      other: symView.getUint8(at + 5),
      shndx,
    });
  }

  // Section groups resolve away (the --force-group-allocation discipline),
  // and .llvm_addrsig drops — its symbol indices go stale under the symbol
  // reorder below, and its only consumer (ICF safety analysis) treats
  // absence conservatively.
  const sectionKept: boolean[] = sections.map(
    (s) =>
      s.type !== SHT_GROUP &&
      s.type !== SHT_LLVM_ADDRSIG &&
      !(shndxSection !== undefined && s === shndxSection),
  );
  const sectionMap: number[] = [];
  {
    let next = 0;
    for (let i = 0; i < sections.length; i++) sectionMap.push(sectionKept[i] === true ? next++ : -1);
  }
  for (let i = 0; i < sections.length; i++) {
    if (sectionKept[i] === true) sections[i]!.flags &= ~SHF_GROUP;
  }

  // Demote and drop decisions per symbol. A symbol anchored to a dropped
  // section (a group's own section symbol) leaves with it; nothing may
  // still reference it afterwards.
  const symbolKept: boolean[] = [];
  for (let i = 0; i < symCount; i++) {
    const sym = symbols[i]!;
    const regular = sym.shndx > SHN_UNDEF && sym.shndx < SHN_LORESERVE;
    symbolKept.push(!(regular && sectionKept[sym.shndx] !== true));
    if (i === 0) continue;
    const binding = sym.info >> 4;
    const defined = sym.shndx !== SHN_UNDEF && sym.shndx !== SHN_COMMON;
    if (binding !== STB_LOCAL && defined && !keep.has(sym.name)) {
      sym.info = (STB_LOCAL << 4) | (sym.info & 0xf);
    }
  }

  // Reorder: locals first (the spec's symbol-table contract), stable within
  // each half, index 0 pinned.
  const localOrder: number[] = [];
  const globalOrder: number[] = [];
  for (let i = 0; i < symCount; i++) {
    if (symbolKept[i] !== true) continue;
    ((symbols[i]!.info >> 4) === STB_LOCAL ? localOrder : globalOrder).push(i);
  }
  const symbolOrder = [...localOrder, ...globalOrder];
  const symbolMap: number[] = new Array<number>(symCount).fill(-1);
  symbolOrder.forEach((oldIndex, newIndex) => (symbolMap[oldIndex] = newIndex));

  const newSymtabData = new Uint8Array(symbolOrder.length * 24);
  const newSymtabView = new DataView(newSymtabData.buffer);
  symbolOrder.forEach((oldIndex, newIndex) => {
    const sym = symbols[oldIndex]!;
    const at = newIndex * 24;
    newSymtabView.setUint32(at, sym.nameOffset, true);
    newSymtabView.setUint8(at + 4, sym.info);
    newSymtabView.setUint8(at + 5, sym.other);
    const shndx =
      sym.shndx > SHN_UNDEF && sym.shndx < SHN_LORESERVE ? sectionMap[sym.shndx]! : sym.shndx;
    newSymtabView.setUint16(at + 6, shndx, true);
    newSymtabView.setBigUint64(at + 8, symView.getBigUint64(oldIndex * 24 + 8, true), true);
    newSymtabView.setBigUint64(at + 16, symView.getBigUint64(oldIndex * 24 + 16, true), true);
  });
  symtab.data = newSymtabData;
  symtab.size = BigInt(newSymtabData.length);
  symtab.info = localOrder.length;

  // Relocation sections against this symbol table: remap symbol indices.
  for (const section of sections) {
    if ((section.type !== SHT_RELA && section.type !== SHT_REL) || section.link !== symtabIndex) {
      continue;
    }
    const entry = section.type === SHT_RELA ? 24 : 16;
    const data = new Uint8Array(section.data); // private copy — inputs may be shared
    const relView = new DataView(data.buffer);
    for (let at = 0; at + entry <= data.length; at += entry) {
      const info = relView.getBigUint64(at + 8, true);
      const oldSym = Number(info >> 32n);
      if (oldSym === 0) continue;
      const newSym = symbolMap[oldSym];
      if (newSym === undefined || newSym < 0) {
        fail("ELF relocation references a symbol dropped with its section group");
      }
      relView.setBigUint64(at + 8, (BigInt(newSym) << 32n) | (info & 0xffffffffn), true);
    }
    section.data = data;
  }

  // Rebuild. sh_link is a section index in every use this object can carry;
  // sh_info is one only on relocation sections.
  const kept = sections.filter((_, i) => sectionKept[i] === true);
  let offset = 64;
  const offsets: number[] = [];
  for (const section of kept) {
    if (section.type === SHT_NULL || section.type === SHT_NOBITS) {
      offsets.push(0);
      continue;
    }
    const align = Number(section.addralign > 1n ? section.addralign : 1n);
    offset = Math.ceil(offset / align) * align;
    offsets.push(offset);
    offset += section.data.length;
  }
  const shoffOut = Math.ceil(offset / 8) * 8;
  const out = new Uint8Array(shoffOut + kept.length * 64);
  const outView = new DataView(out.buffer);
  out.set(object.subarray(0, 64));
  outView.setBigUint64(24, 0n, true); // e_entry
  outView.setBigUint64(32, 0n, true); // e_phoff
  outView.setUint16(18, machine, true);
  outView.setUint32(48, flags, true);
  outView.setBigUint64(40, BigInt(shoffOut), true);
  outView.setUint16(54, 0, true); // e_phentsize
  outView.setUint16(56, 0, true); // e_phnum
  outView.setUint16(60, kept.length, true);
  outView.setUint16(62, sectionMap[shstrndx]!, true);
  kept.forEach((section, i) => {
    if (section.type !== SHT_NULL && section.type !== SHT_NOBITS) {
      out.set(section.data, offsets[i]!);
    }
    const at = shoffOut + i * 64;
    outView.setUint32(at, section.nameOffset, true);
    outView.setUint32(at + 4, section.type, true);
    outView.setBigUint64(at + 8, section.flags, true);
    outView.setBigUint64(at + 16, section.addr, true);
    outView.setBigUint64(at + 24, BigInt(offsets[i]!), true);
    outView.setBigUint64(
      at + 32,
      section.type === SHT_NOBITS ? section.size : BigInt(section.data.length),
      true,
    );
    outView.setUint32(at + 40, section.link === 0 ? 0 : sectionMap[section.link] ?? 0, true);
    outView.setUint32(
      at + 44,
      section.type === SHT_RELA || section.type === SHT_REL
        ? sectionMap[section.info] ?? 0
        : section === symtab
          ? symtab.info
          : section.info,
      true,
    );
    outView.setBigUint64(at + 48, section.addralign, true);
    outView.setBigUint64(at + 56, section.entsize, true);
  });
  return out;
}

/* ────────────────────────────── COFF ──────────────────────────────────── */

const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_SCN_LNK_NRELOC_OVFL = 0x01000000;
const IMAGE_SCN_LNK_COMDAT = 0x00001000;
const IMAGE_SYM_UNDEFINED = 0;
const IMAGE_SYM_ABSOLUTE = -1;
const IMAGE_SYM_CLASS_EXTERNAL = 2;
const IMAGE_SYM_CLASS_STATIC = 3;
const IMAGE_SYM_CLASS_SECTION = 104;
const IMAGE_SYM_CLASS_WEAK_EXTERNAL = 105;
const IMAGE_COMDAT_SELECT_NODUPLICATES = 1;
const IMAGE_COMDAT_SELECT_ANY = 2;
const IMAGE_COMDAT_SELECT_SAME_SIZE = 3;
const IMAGE_COMDAT_SELECT_EXACT_MATCH = 4;
const IMAGE_COMDAT_SELECT_ASSOCIATIVE = 5;
const IMAGE_COMDAT_SELECT_LARGEST = 6;

interface CoffReloc {
  virtualAddress: number;
  symbolIndex: number;
  type: number;
}

interface CoffSection {
  name: string;
  virtualSize: number;
  virtualAddress: number;
  characteristics: number;
  data: Uint8Array | null; // null = uninitialized (.bss)
  rawSize: number;
  relocs: CoffReloc[];
  /** COMDAT selection (aux of the section symbol), 0 when not COMDAT. */
  comdatSelection: number;
  /** 1-based associated section for IMAGE_COMDAT_SELECT_ASSOCIATIVE. */
  comdatAssoc: number;
  /** Primary index of the COMDAT symbol (the record after the section
   * symbol anchored here) — the linker's deduplication name. */
  comdatLeader: number;
}

interface CoffSymbol {
  name: string;
  value: number;
  sectionNumber: number; // 1-based, or 0 / -1 / -2
  type: number;
  storageClass: number;
  aux: Uint8Array; // raw aux records, 18 bytes each
}

interface CoffObject {
  machine: number;
  sections: CoffSection[];
  symbols: CoffSymbol[]; // primary records only; aux rides on its symbol
  /** primary-record index (into `symbols`) by original symbol-table index */
  primaryByRaw: Map<number, number>;
  /** original symbol-table index by primary-record index */
  rawByPrimary: number[];
  label: string;
}

function readCString(bytes: Uint8Array, offset: number): string {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return textDecoder.decode(bytes.subarray(offset, end));
}

function parseCoff(object: Uint8Array, label: string): CoffObject {
  const view = new DataView(object.buffer, object.byteOffset, object.byteLength);
  if (object.byteLength < 20) fail(`${label}: not a COFF object`);
  const machine = view.getUint16(0, true);
  if (machine === 0 && view.getUint16(2, true) === 0xffff) {
    fail(`${label}: bigobj/import-descriptor COFF members are not supported here`);
  }
  const sectionCount = view.getUint16(2, true);
  const symtabOffset = view.getUint32(8, true);
  const symbolCount = view.getUint32(12, true);
  if (view.getUint16(16, true) !== 0) fail(`${label}: unexpected optional header in a COFF object`);
  const strtabOffset = symtabOffset + symbolCount * 18;
  const strtab = object.subarray(strtabOffset);

  const sectionName = (raw: Uint8Array): string => {
    if (raw[0] === 0x2f /* '/' */) {
      const spelled = textDecoder.decode(raw.subarray(1)).replace(/\0+$/, "").trim();
      const offset = Number.parseInt(spelled, 10);
      if (!Number.isFinite(offset)) fail(`${label}: malformed long section name`);
      return readCString(strtab, offset);
    }
    let end = 0;
    while (end < 8 && raw[end] !== 0) end++;
    return textDecoder.decode(raw.subarray(0, end));
  };

  const sections: CoffSection[] = [];
  for (let i = 0; i < sectionCount; i++) {
    const at = 20 + i * 40;
    const rawSize = view.getUint32(at + 16, true);
    const rawPointer = view.getUint32(at + 20, true);
    const relocPointer = view.getUint32(at + 24, true);
    let relocCount: number = view.getUint16(at + 32, true);
    const characteristics = view.getUint32(at + 36, true);
    let relocAt = relocPointer;
    if ((characteristics & IMAGE_SCN_LNK_NRELOC_OVFL) !== 0 && relocCount === 0xffff) {
      relocCount = view.getUint32(relocPointer, true) - 1;
      relocAt += 10;
    }
    const relocs: CoffReloc[] = [];
    for (let r = 0; r < relocCount; r++) {
      const rAt = relocAt + r * 10;
      relocs.push({
        virtualAddress: view.getUint32(rAt, true),
        symbolIndex: view.getUint32(rAt + 4, true),
        type: view.getUint16(rAt + 8, true),
      });
    }
    sections.push({
      name: sectionName(object.subarray(at, at + 8)),
      virtualSize: view.getUint32(at + 8, true),
      virtualAddress: view.getUint32(at + 12, true),
      characteristics,
      data: rawPointer === 0 ? null : object.subarray(rawPointer, rawPointer + rawSize),
      rawSize,
      relocs,
      comdatSelection: 0,
      comdatAssoc: 0,
      comdatLeader: -1,
    });
  }

  const symbols: CoffSymbol[] = [];
  const primaryByRaw = new Map<number, number>();
  const rawByPrimary: number[] = [];
  for (let i = 0; i < symbolCount; ) {
    const at = symtabOffset + i * 18;
    const nameIsLong = view.getUint32(at, true) === 0;
    const name = nameIsLong
      ? readCString(strtab, view.getUint32(at + 4, true))
      : (() => {
          const raw = object.subarray(at, at + 8);
          let end = 0;
          while (end < 8 && raw[end] !== 0) end++;
          return textDecoder.decode(raw.subarray(0, end));
        })();
    const auxCount = view.getUint8(at + 17);
    primaryByRaw.set(i, symbols.length);
    rawByPrimary.push(i);
    symbols.push({
      name,
      value: view.getUint32(at + 8, true),
      sectionNumber: view.getInt16(at + 12, true),
      type: view.getUint16(at + 14, true),
      storageClass: view.getUint8(at + 16),
      aux: object.slice(at + 18, at + 18 + auxCount * 18),
    });
    i += 1 + auxCount;
  }
  // COMDAT metadata rides the section symbol's aux record (selection,
  // associated section) and the record after it (the COMDAT symbol — the
  // linker's deduplication name).
  for (let sectionIndex = 1; sectionIndex <= sections.length; sectionIndex++) {
    const section = sections[sectionIndex - 1]!;
    if ((section.characteristics & IMAGE_SCN_LNK_COMDAT) === 0) continue;
    let sawSectionSymbol = false;
    for (let primary = 0; primary < symbols.length; primary++) {
      const sym = symbols[primary]!;
      if (sym.sectionNumber !== sectionIndex) continue;
      if (!sawSectionSymbol && sym.value === 0 && sym.name === section.name && sym.aux.length >= 18) {
        sawSectionSymbol = true;
        const auxView = new DataView(sym.aux.buffer, sym.aux.byteOffset, sym.aux.byteLength);
        section.comdatSelection = auxView.getUint8(14);
        section.comdatAssoc = auxView.getUint16(12, true);
        continue;
      }
      section.comdatLeader = primary;
      break;
    }
    if (!sawSectionSymbol) fail(`${label}: COMDAT section ${section.name} has no section symbol`);
  }
  return { machine, sections, symbols, primaryByRaw, rawByPrimary, label };
}

function coffDefines(sym: CoffSymbol): boolean {
  return (
    (sym.storageClass === IMAGE_SYM_CLASS_EXTERNAL &&
      (sym.sectionNumber > 0 || sym.sectionNumber === IMAGE_SYM_ABSOLUTE)) ||
    coffIsCommon(sym)
  );
}

function coffIsCommon(sym: CoffSymbol): boolean {
  return (
    sym.storageClass === IMAGE_SYM_CLASS_EXTERNAL &&
    sym.sectionNumber === IMAGE_SYM_UNDEFINED &&
    sym.value > 0
  );
}

function coffIsUndefined(sym: CoffSymbol): boolean {
  return (
    (sym.storageClass === IMAGE_SYM_CLASS_EXTERNAL &&
      sym.sectionNumber === IMAGE_SYM_UNDEFINED &&
      sym.value === 0) ||
    sym.storageClass === IMAGE_SYM_CLASS_WEAK_EXTERNAL
  );
}

function coffSectionContentsEqual(a: CoffSection, b: CoffSection): boolean {
  if (a.rawSize !== b.rawSize) return false;
  if (a.data === null || b.data === null) return a.data === b.data;
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) return false;
  }
  return true;
}

/** Combine mandatory root objects with the support objects they
 * (transitively) need into ONE COFF object, then demote every defined external
 * outside `keep` to a static symbol. Support objects join on undefined-symbol
 * demand — the staging-archive member semantics the other formats get from
 * `ld -r` — so an unused member's undefined references never reach the
 * embedder's link. x86_64 only (the one COFF target scriptc produces). */
export function mergeAndLocalizeCoffObjects(
  roots: readonly Uint8Array[],
  support: readonly Uint8Array[],
  keep: ReadonlySet<string>,
  labels?: { roots?: readonly string[]; support?: readonly string[] },
): Uint8Array {
  if (roots.length === 0) fail("COFF localization requires at least one root object");
  const objects = [
    ...roots.map((bytes, i) => parseCoff(bytes, labels?.roots?.[i] ?? `root object ${i}`)),
    ...support.map((bytes, i) => parseCoff(bytes, labels?.support?.[i] ?? `support object ${i}`)),
  ];
  for (const object of objects) {
    if (object.machine !== IMAGE_FILE_MACHINE_AMD64) {
      fail(`${object.label}: unsupported COFF machine 0x${object.machine.toString(16)}`);
    }
  }

  // Member selection: archive semantics over the support list. A definition
  // (including a COMMON) satisfies an undefined reference; first definer in
  // list order wins the pull, matching `ar` member order.
  const definers = new Map<string, number[]>();
  objects.forEach((object, index) => {
    if (index < roots.length) return;
    for (const sym of object.symbols) {
      if (!coffDefines(sym)) continue;
      const list = definers.get(sym.name);
      if (list === undefined) definers.set(sym.name, [index]);
      else list.push(index);
    }
  });
  const included: boolean[] = objects.map((_, i) => i < roots.length);
  // Archive extraction consults the linker's CURRENT symbol state: an
  // undefined in a newly pulled member is already satisfied when the
  // program object (or an earlier member) defines it. Record every
  // selected definition as soon as its member joins, before that member's
  // own undefineds are considered. Without this set, a support member can
  // spuriously pull an alternate definition that a real archive link would
  // leave untouched, and the merge later reports a false duplicate.
  const selectedDefinitions = new Set<string>();
  const addDefinitions = (object: CoffObject): void => {
    for (const sym of object.symbols) {
      if (coffDefines(sym)) selectedDefinitions.add(sym.name);
    }
  };
  for (let i = 0; i < roots.length; i++) addDefinitions(objects[i]!);
  const queue = roots.map((_, i) => i);
  while (queue.length > 0) {
    const object = objects[queue.shift()!]!;
    for (const sym of object.symbols) {
      if (!coffIsUndefined(sym)) continue;
      if (selectedDefinitions.has(sym.name)) continue;
      for (const candidate of definers.get(sym.name) ?? []) {
        if (included[candidate] !== true) {
          included[candidate] = true;
          addDefinitions(objects[candidate]!);
          queue.push(candidate);
        }
        break;
      }
    }
  }
  const selected = objects.filter((_, i) => included[i] === true);

  // COMDAT resolution, the ELF arm's --force-group-allocation analog:
  // resolve duplicate names inside THIS merge according to their selection
  // contract (mingw's .refptr.<name> stubs use ANY), then clear the COMDAT
  // flag on the survivors at emission. A section whose deduplication name
  // repeats across archives sharing runtime objects must not be deduplicated
  // against another archive's copy at the embedder's link, where its
  // relocations bind that archive's private (demoted) definitions.
  const sectionDropped = new Map<CoffObject, boolean[]>();
  const comdatKept = new Map<string, { object: CoffObject; index: number }>();
  for (const object of selected) {
    const dropped: boolean[] = object.sections.map(() => false);
    sectionDropped.set(object, dropped);
    object.sections.forEach((section, i) => {
      // .llvm_addrsig: its ULEB symbol indices go stale under the merge and
      // its absence is read conservatively. .debug$S/.debug$T (CodeView):
      // item indices resolve against the OWNING object's .debug$T, a
      // per-object contract no single merged object can express — the
      // localized member carries no CodeView, like an objcopy'd ELF member
      // carries its DWARF untouched but a stripped one loses it.
      if (section.name === ".llvm_addrsig" || section.name.startsWith(".debug$")) {
        dropped[i] = true;
      }
    });
  }
  for (const object of selected) {
    const dropped = sectionDropped.get(object)!;
    object.sections.forEach((section, i) => {
      if (dropped[i] === true || (section.characteristics & IMAGE_SCN_LNK_COMDAT) === 0) return;
      if (section.comdatSelection === IMAGE_COMDAT_SELECT_ASSOCIATIVE) return;
      if (
        section.comdatSelection !== IMAGE_COMDAT_SELECT_NODUPLICATES &&
        section.comdatSelection !== IMAGE_COMDAT_SELECT_ANY &&
        section.comdatSelection !== IMAGE_COMDAT_SELECT_SAME_SIZE &&
        section.comdatSelection !== IMAGE_COMDAT_SELECT_EXACT_MATCH &&
        section.comdatSelection !== IMAGE_COMDAT_SELECT_LARGEST
      ) {
        fail(`${object.label}: COMDAT section ${section.name} has unsupported selection ${section.comdatSelection}`);
      }
      const leader = section.comdatLeader >= 0 ? object.symbols[section.comdatLeader] : undefined;
      if (leader === undefined || leader.storageClass !== IMAGE_SYM_CLASS_EXTERNAL) {
        fail(`${object.label}: COMDAT section ${section.name} has no external leader symbol`);
      }
      const existing = comdatKept.get(leader.name);
      if (existing === undefined) {
        comdatKept.set(leader.name, { object, index: i });
        return;
      }
      const existingSection = existing.object.sections[existing.index]!;
      if (section.comdatSelection !== existingSection.comdatSelection) {
        fail(
          `conflicting COMDAT selections for ${leader.name} ` +
            `(${existing.object.label}: ${existingSection.comdatSelection}, ${object.label}: ${section.comdatSelection})`,
        );
      }
      if (section.comdatSelection === IMAGE_COMDAT_SELECT_NODUPLICATES) {
        fail(`duplicate IMAGE_COMDAT_SELECT_NODUPLICATES section ${section.name} (${existing.object.label} and ${object.label})`);
      }
      if (
        section.comdatSelection === IMAGE_COMDAT_SELECT_SAME_SIZE &&
        section.rawSize !== existingSection.rawSize
      ) {
        fail(
          `IMAGE_COMDAT_SELECT_SAME_SIZE mismatch for ${leader.name} ` +
            `(${existing.object.label}: ${existingSection.rawSize} bytes, ${object.label}: ${section.rawSize} bytes)`,
        );
      }
      if (
        section.comdatSelection === IMAGE_COMDAT_SELECT_EXACT_MATCH &&
        !coffSectionContentsEqual(existingSection, section)
      ) {
        fail(
          `IMAGE_COMDAT_SELECT_EXACT_MATCH mismatch for ${leader.name} ` +
            `(${existing.object.label} and ${object.label})`,
        );
      }
      if (
        section.comdatSelection === IMAGE_COMDAT_SELECT_LARGEST &&
        section.rawSize > existingSection.rawSize
      ) {
        sectionDropped.get(existing.object)![existing.index] = true;
        comdatKept.set(leader.name, { object, index: i });
      } else {
        dropped[i] = true;
      }
    });
  }
  // Associative sections follow their target's final fate. Resolve these
  // only after every non-associative winner is known: LARGEST can replace a
  // section seen in an earlier object, whose associates must then leave too.
  for (const object of selected) {
    const dropped = sectionDropped.get(object)!;
    object.sections.forEach((section, i) => {
      if (dropped[i] === true || section.comdatSelection !== IMAGE_COMDAT_SELECT_ASSOCIATIVE) return;
      const seen = new Set<number>([i]);
      let target = section.comdatAssoc - 1;
      while (true) {
        if (target < 0 || target >= object.sections.length) {
          fail(`${object.label}: associative COMDAT ${section.name} names an invalid section`);
        }
        if (seen.has(target)) {
          fail(`${object.label}: associative COMDAT ${section.name} contains an association cycle`);
        }
        seen.add(target);
        const targetSection = object.sections[target]!;
        if ((targetSection.characteristics & IMAGE_SCN_LNK_COMDAT) === 0) {
          fail(`${object.label}: associative COMDAT ${section.name} targets a non-COMDAT section`);
        }
        if (dropped[target] === true) {
          dropped[i] = true;
          break;
        }
        if (targetSection.comdatSelection !== IMAGE_COMDAT_SELECT_ASSOCIATIVE) break;
        target = targetSection.comdatAssoc - 1;
      }
    });
  }

  // Global resolution: one canonical entry per external name. Definitions
  // win over commons, commons (largest size) over undefineds. Symbols
  // anchored in dropped sections stand aside: a dropped duplicate's COMDAT
  // symbol resolves to the kept copy's.
  interface Canonical {
    kind: "defined" | "common" | "undefined";
    definer?: string;
    commonSize: number;
    outIndex: number; // raw output symbol-table index, assigned in pass 2
    outSlot?: number; // index into outSymbols for in-place definition landing
  }
  const canonical = new Map<string, Canonical>();
  for (const object of selected) {
    const dropped = sectionDropped.get(object)!;
    for (const sym of object.symbols) {
      if (sym.storageClass !== IMAGE_SYM_CLASS_EXTERNAL) continue;
      if (sym.sectionNumber > 0 && dropped[sym.sectionNumber - 1] === true) continue;
      const existing = canonical.get(sym.name);
      if (coffDefines(sym) && !coffIsCommon(sym)) {
        if (existing?.kind === "defined") {
          fail(
            `duplicate external symbol ${sym.name} (${existing.definer ?? "?"} and ${object.label})`,
          );
        }
        canonical.set(sym.name, {
          kind: "defined",
          definer: object.label,
          commonSize: 0,
          outIndex: -1,
        });
      } else if (coffIsCommon(sym)) {
        if (existing === undefined || existing.kind === "undefined") {
          canonical.set(sym.name, { kind: "common", commonSize: sym.value, outIndex: -1 });
        } else if (existing.kind === "common" && sym.value > existing.commonSize) {
          existing.commonSize = sym.value;
        }
      } else if (existing === undefined) {
        canonical.set(sym.name, { kind: "undefined", commonSize: 0, outIndex: -1 });
      }
    }
  }
  // A weak external's resolution happens at the embedder's link; a weak
  // reference to a name this pass demotes would dangle there. scriptc's
  // toolchains emit no weak externals in these objects — refuse rather than
  // approximate if one ever appears against a demoted name.
  for (const object of selected) {
    for (const sym of object.symbols) {
      if (sym.storageClass !== IMAGE_SYM_CLASS_WEAK_EXTERNAL) continue;
      const target = canonical.get(sym.name);
      if (target?.kind === "defined" && !keep.has(sym.name)) {
        fail(`${object.label}: weak external ${sym.name} would dangle after localization`);
      }
    }
  }

  // Pass 1 — output sections (dropping .llvm_addrsig: its ULEB symbol
  // indices go stale under the merge, and its absence is read
  // conservatively). Section map: (object, 1-based index) → 1-based output.
  interface OutSection {
    section: CoffSection;
    object: CoffObject;
  }
  const outSections: OutSection[] = [];
  const sectionMaps = new Map<CoffObject, number[]>();
  for (const object of selected) {
    const map: number[] = [0];
    const dropped = sectionDropped.get(object)!;
    object.sections.forEach((section, i) => {
      if (dropped[i] === true) {
        map.push(0);
        return;
      }
      outSections.push({ section, object });
      map.push(outSections.length);
    });
    sectionMaps.set(object, map);
  }
  if (outSections.length > 0xfffe) fail("merged COFF object exceeds the section-count limit");

  // Pass 2 — assign output symbol indices. Statics and section symbols copy
  // per object; externals emit once at their first appearance.
  interface OutSymbol {
    sym: CoffSymbol;
    object: CoffObject;
    sectionNumber: number;
    storageClass: number;
    value: number;
  }
  const outSymbols: OutSymbol[] = [];
  const symbolMaps = new Map<CoffObject, Map<number, number>>(); // raw old → raw new
  let rawOut = 0;
  for (const object of selected) {
    const map = new Map<number, number>();
    symbolMaps.set(object, map);
    const sectionMap = sectionMaps.get(object)!;
    object.symbols.forEach((sym, primaryIndex) => {
      const rawOld = object.rawByPrimary[primaryIndex]!;
      const mapSection = (): number =>
        sym.sectionNumber > 0 ? sectionMap[sym.sectionNumber] ?? 0 : sym.sectionNumber;
      if (sym.storageClass === IMAGE_SYM_CLASS_EXTERNAL) {
        const inDroppedSection =
          sym.sectionNumber > 0 &&
          sectionDropped.get(object)![sym.sectionNumber - 1] === true;
        const entry = canonical.get(sym.name)!;
        if (entry.outIndex >= 0) {
          // Later appearance of a known external: reference the canonical
          // entry, unless THIS record is the definition that must land (a
          // dropped duplicate COMDAT's symbol is a reference to the kept
          // copy, never a second landing).
          const isTheDefinition =
            entry.kind === "defined" && coffDefines(sym) && !coffIsCommon(sym) && !inDroppedSection;
          if (!isTheDefinition) {
            map.set(rawOld, entry.outIndex);
            return;
          }
          // The canonical slot was created by an earlier reference; the
          // definition replaces it in place.
          const slot = outSymbols[entry.outSlot!]!;
          slot.sym = sym;
          slot.object = object;
          slot.sectionNumber = mapSection();
          slot.value = sym.value;
          slot.storageClass = keep.has(sym.name)
            ? IMAGE_SYM_CLASS_EXTERNAL
            : IMAGE_SYM_CLASS_STATIC;
          map.set(rawOld, entry.outIndex);
          return;
        }
        const sectionNumber =
          entry.kind === "defined" && coffDefines(sym) && !coffIsCommon(sym)
            ? mapSection()
            : IMAGE_SYM_UNDEFINED;
        const value = entry.kind === "common" ? entry.commonSize : entry.kind === "defined" && !coffIsCommon(sym) ? sym.value : 0;
        const demote =
          entry.kind === "defined" &&
          coffDefines(sym) &&
          !coffIsCommon(sym) &&
          !keep.has(sym.name);
        entry.outIndex = rawOut;
        entry.outSlot = outSymbols.length;
        outSymbols.push({
          sym,
          object,
          sectionNumber,
          storageClass: demote ? IMAGE_SYM_CLASS_STATIC : IMAGE_SYM_CLASS_EXTERNAL,
          value,
        });
        map.set(rawOld, rawOut);
        rawOut += 1; // externals carry no aux records in this pipeline
        if (sym.aux.length > 0) {
          fail(`${object.label}: external symbol ${sym.name} carries aux records`);
        }
        return;
      }
      // A record anchored to a dropped section (.llvm_addrsig's section
      // symbol) leaves with it; nothing may still reference it afterwards.
      if (sym.sectionNumber > 0 && sectionMap[sym.sectionNumber] === 0) return;
      // Non-external record: copy through with a remapped section number.
      map.set(rawOld, rawOut);
      outSymbols.push({
        sym,
        object,
        sectionNumber: mapSection(),
        storageClass: sym.storageClass,
        value: sym.value,
      });
      rawOut += 1 + sym.aux.length / 18;
    });
  }

  // Pass 3 — remap relocations and aux records now every index is known.
  for (const { section, object } of outSections) {
    const map = symbolMaps.get(object)!;
    for (const reloc of section.relocs) {
      const mapped = map.get(reloc.symbolIndex);
      if (mapped === undefined) {
        // Relocations may address a record via its primary index only.
        fail(`${object.label}: relocation in ${section.name} references a non-primary symbol`);
      }
      reloc.symbolIndex = mapped;
    }
  }

  // Serialize.
  const strings: Uint8Array[] = [];
  let strtabSize = 4;
  const stringOffsets = new Map<string, number>();
  const internString = (name: string): number => {
    const existing = stringOffsets.get(name);
    if (existing !== undefined) return existing;
    const bytes = textEncoder.encode(`${name}\0`);
    strings.push(bytes);
    const offset = strtabSize;
    stringOffsets.set(name, offset);
    strtabSize += bytes.length;
    return offset;
  };

  const headerSize = 20 + outSections.length * 40;
  let dataOffset = headerSize;
  const dataOffsets: number[] = [];
  for (const { section } of outSections) {
    if (section.data === null) {
      dataOffsets.push(0);
      continue;
    }
    dataOffset = Math.ceil(dataOffset / 4) * 4;
    dataOffsets.push(dataOffset);
    dataOffset += section.rawSize;
  }
  const relocOffsets: number[] = [];
  for (const { section } of outSections) {
    if (section.relocs.length === 0) {
      relocOffsets.push(0);
      continue;
    }
    dataOffset = Math.ceil(dataOffset / 2) * 2;
    relocOffsets.push(dataOffset);
    dataOffset += (section.relocs.length + (section.relocs.length > 0xfffe ? 1 : 0)) * 10;
  }
  const symtabOffset = Math.ceil(dataOffset / 4) * 4;

  const totalSymbols = rawOut;
  const preStrtab = symtabOffset + totalSymbols * 18;
  const buffers: { at: number; bytes: Uint8Array }[] = [];

  const header = new Uint8Array(headerSize);
  const headerView = new DataView(header.buffer);
  headerView.setUint16(0, IMAGE_FILE_MACHINE_AMD64, true);
  headerView.setUint16(2, outSections.length, true);
  headerView.setUint32(4, 0, true); // deterministic timestamp
  headerView.setUint32(8, symtabOffset, true);
  headerView.setUint32(12, totalSymbols, true);
  outSections.forEach(({ section }, i) => {
    const at = 20 + i * 40;
    const nameBytes = textEncoder.encode(section.name);
    if (nameBytes.length <= 8) {
      header.set(nameBytes, at);
    } else {
      header.set(textEncoder.encode(`/${internString(section.name)}`), at);
    }
    headerView.setUint32(at + 8, section.virtualSize, true);
    headerView.setUint32(at + 12, section.virtualAddress, true);
    headerView.setUint32(at + 16, section.rawSize, true);
    headerView.setUint32(at + 20, dataOffsets[i]!, true);
    headerView.setUint32(at + 24, relocOffsets[i]!, true);
    headerView.setUint32(at + 28, 0, true); // line numbers (deprecated)
    const overflow = section.relocs.length > 0xfffe;
    headerView.setUint16(at + 32, overflow ? 0xffff : section.relocs.length, true);
    headerView.setUint16(at + 34, 0, true);
    const characteristics = section.characteristics & ~IMAGE_SCN_LNK_COMDAT;
    headerView.setUint32(
      at + 36,
      overflow
        ? characteristics | IMAGE_SCN_LNK_NRELOC_OVFL
        : characteristics & ~IMAGE_SCN_LNK_NRELOC_OVFL,
      true,
    );
  });
  buffers.push({ at: 0, bytes: header });

  outSections.forEach(({ section }, i) => {
    if (section.data !== null) buffers.push({ at: dataOffsets[i]!, bytes: section.data });
    if (section.relocs.length === 0) return;
    const overflow = section.relocs.length > 0xfffe;
    const relocBytes = new Uint8Array((section.relocs.length + (overflow ? 1 : 0)) * 10);
    const relocView = new DataView(relocBytes.buffer);
    let at = 0;
    if (overflow) {
      relocView.setUint32(0, section.relocs.length + 1, true);
      at = 10;
    }
    for (const reloc of section.relocs) {
      relocView.setUint32(at, reloc.virtualAddress, true);
      relocView.setUint32(at + 4, reloc.symbolIndex, true);
      relocView.setUint16(at + 8, reloc.type, true);
      at += 10;
    }
    buffers.push({ at: relocOffsets[i]!, bytes: relocBytes });
  });

  const symtabBytes = new Uint8Array(totalSymbols * 18);
  const symtabView = new DataView(symtabBytes.buffer);
  {
    let raw = 0;
    for (const out of outSymbols) {
      const at = raw * 18;
      const nameBytes = textEncoder.encode(out.sym.name);
      if (nameBytes.length <= 8) {
        symtabBytes.set(nameBytes, at);
      } else {
        symtabView.setUint32(at, 0, true);
        symtabView.setUint32(at + 4, internString(out.sym.name), true);
      }
      symtabView.setUint32(at + 8, out.value, true);
      symtabView.setInt16(at + 12, out.sectionNumber, true);
      symtabView.setUint16(at + 14, out.sym.type, true);
      symtabView.setUint8(at + 16, out.storageClass);
      symtabView.setUint8(at + 17, out.sym.aux.length / 18);
      // Aux records: remap the fields that carry indices. Section
      // definitions (on section symbols) carry an associated section
      // number; weak externals carry a default-symbol index. Others copy
      // raw (.file's aux is the filename bytes).
      const aux = new Uint8Array(out.sym.aux); // private copy
      if (
        (out.storageClass === IMAGE_SYM_CLASS_STATIC ||
          out.storageClass === IMAGE_SYM_CLASS_SECTION) &&
        aux.length === 18 &&
        out.sym.value === 0 &&
        out.sym.sectionNumber > 0
      ) {
        const auxView = new DataView(aux.buffer);
        const assoc = auxView.getUint16(12, true);
        const sectionMap = sectionMaps.get(out.object)!;
        auxView.setUint16(12, assoc > 0 ? sectionMap[assoc] ?? 0 : 0, true);
        auxView.setUint8(14, 0); // COMDAT selection cleared with the flag
      } else if (out.storageClass === IMAGE_SYM_CLASS_WEAK_EXTERNAL && aux.length >= 18) {
        const auxView = new DataView(aux.buffer);
        const tag = auxView.getUint32(0, true);
        const mapped = symbolMaps.get(out.object)!.get(tag);
        if (mapped === undefined) fail(`${out.object.label}: weak external tag is not a primary symbol`);
        auxView.setUint32(0, mapped, true);
      }
      symtabBytes.set(aux, at + 18);
      raw += 1 + aux.length / 18;
    }
  }
  buffers.push({ at: symtabOffset, bytes: symtabBytes });

  const strtabBytes = new Uint8Array(strtabSize);
  new DataView(strtabBytes.buffer).setUint32(0, strtabSize, true);
  {
    let at = 4;
    for (const chunk of strings) {
      strtabBytes.set(chunk, at);
      at += chunk.length;
    }
  }
  buffers.push({ at: preStrtab, bytes: strtabBytes });

  const out = new Uint8Array(preStrtab + strtabSize);
  for (const { at, bytes } of buffers) out.set(bytes, at);
  return out;
}
