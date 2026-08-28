/* Deterministic coverage for the in-process localization transforms: the
 * fixtures are synthesized byte-level objects (no toolchain), so every
 * suite exercises these paths — the toolchain-driven integration lives in
 * tests/harness/library-multi.test.ts (M10/M11) behind SCRIPTC_CROSS. */
import { describe, expect, test } from "vitest";
import { localizeElfObject, mergeAndLocalizeCoffObjects } from "./object-localize.js";

/* ── minimal ELF64 builder ──────────────────────────────────────────────── */

interface ElfSectionSpec {
  name: string;
  type: number;
  flags?: bigint;
  data?: Uint8Array;
  link?: number;
  info?: number;
  entsize?: bigint;
  addralign?: bigint;
}

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_GROUP = 17;
const SHF_ALLOC = 0x2n;
const SHF_EXECINSTR = 0x4n;
const SHF_GROUP = 0x200n;
const STB_GLOBAL = 1;
const STB_WEAK = 2;
const SHN_COMMON = 0xfff2;

interface ElfSymbolSpec {
  name: string;
  binding: number;
  shndx: number;
  value?: bigint;
}

function buildStrtab(names: string[]): { data: Uint8Array; offsets: Map<string, number> } {
  const offsets = new Map<string, number>();
  let size = 1;
  for (const name of names) {
    if (!offsets.has(name)) {
      offsets.set(name, size);
      size += name.length + 1;
    }
  }
  const data = new Uint8Array(size);
  for (const [name, at] of offsets) data.set(new TextEncoder().encode(name), at);
  return { data, offsets };
}

/** Assemble an ET_REL ELF64LE: caller supplies content sections; the
 * builder appends .symtab, .strtab, .shstrtab (their indices are
 * sections.length, +1, +2). Symbols must list locals first. */
function buildElf(sections: ElfSectionSpec[], symbols: ElfSymbolSpec[], localCount: number): Uint8Array {
  const strtab = buildStrtab(symbols.map((s) => s.name).filter((n) => n !== ""));
  const symData = new Uint8Array((symbols.length + 1) * 24);
  const symView = new DataView(symData.buffer);
  symbols.forEach((sym, i) => {
    const at = (i + 1) * 24;
    symView.setUint32(at, sym.name === "" ? 0 : strtab.offsets.get(sym.name)!, true);
    symView.setUint8(at + 4, (sym.binding << 4) | 0);
    symView.setUint16(at + 6, sym.shndx, true);
    symView.setBigUint64(at + 8, sym.value ?? 0n, true);
  });
  const all: ElfSectionSpec[] = [
    { name: "", type: 0 },
    ...sections,
    { name: ".symtab", type: SHT_SYMTAB, data: symData, link: sections.length + 2, info: localCount + 1, entsize: 24n },
    { name: ".strtab", type: SHT_STRTAB, data: strtab.data },
    { name: ".shstrtab", type: SHT_STRTAB },
  ];
  const shstr = buildStrtab(all.map((s) => s.name).filter((n) => n !== ""));
  all[all.length - 1]!.data = shstr.data;
  let offset = 64;
  const offsets = all.map((s) => {
    const data = s.data ?? new Uint8Array(0);
    offset = Math.ceil(offset / 8) * 8;
    const at = offset;
    offset += data.length;
    return at;
  });
  const shoff = Math.ceil(offset / 8) * 8;
  const out = new Uint8Array(shoff + all.length * 64);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x7f454c46, false);
  out[4] = 2; // ELFCLASS64
  out[5] = 1; // little-endian
  out[6] = 1; // EV_CURRENT
  view.setUint16(16, 1, true); // ET_REL
  view.setUint16(18, 0x3e, true); // EM_X86_64
  view.setUint32(20, 1, true);
  view.setBigUint64(40, BigInt(shoff), true);
  view.setUint16(52, 64, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, all.length, true);
  view.setUint16(62, all.length - 1, true);
  all.forEach((s, i) => {
    const at = shoff + i * 64;
    const data = s.data ?? new Uint8Array(0);
    out.set(data, offsets[i]!);
    view.setUint32(at, s.name === "" ? 0 : shstr.offsets.get(s.name)!, true);
    view.setUint32(at + 4, s.type, true);
    view.setBigUint64(at + 8, s.flags ?? 0n, true);
    view.setBigUint64(at + 24, BigInt(s.type === 0 ? 0 : offsets[i]!), true);
    view.setBigUint64(at + 32, BigInt(data.length), true);
    view.setUint32(at + 40, s.link ?? 0, true);
    view.setUint32(at + 44, s.info ?? 0, true);
    view.setBigUint64(at + 48, s.addralign ?? 1n, true);
    view.setBigUint64(at + 56, s.entsize ?? 0n, true);
  });
  return out;
}

/* Tiny independent reader for assertions. */
interface ReadElf {
  sections: { name: string; type: number; flags: bigint; link: number; info: number; data: Uint8Array }[];
  symbols: { name: string; binding: number; shndx: number }[];
  symtabInfo: number;
}

function readElf(bytes: Uint8Array): ReadElf {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shoff = Number(view.getBigUint64(40, true));
  const shnum = view.getUint16(60, true);
  const shstrndx = view.getUint16(62, true);
  const raw = [] as { nameOff: number; type: number; flags: bigint; offset: number; size: number; link: number; info: number }[];
  for (let i = 0; i < shnum; i++) {
    const at = shoff + i * 64;
    raw.push({
      nameOff: view.getUint32(at, true),
      type: view.getUint32(at + 4, true),
      flags: view.getBigUint64(at + 8, true),
      offset: Number(view.getBigUint64(at + 24, true)),
      size: Number(view.getBigUint64(at + 32, true)),
      link: view.getUint32(at + 40, true),
      info: view.getUint32(at + 44, true),
    });
  }
  const shstr = raw[shstrndx]!;
  const name = (table: { offset: number; size: number }, at: number): string => {
    let end = table.offset + at;
    while (bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(table.offset + at, end));
  };
  const sections = raw.map((s) => ({
    name: name(shstr, s.nameOff),
    type: s.type,
    flags: s.flags,
    link: s.link,
    info: s.info,
    data: bytes.subarray(s.offset, s.offset + s.size),
  }));
  const symtabIdx = raw.findIndex((s) => s.type === SHT_SYMTAB);
  const symtab = raw[symtabIdx]!;
  const strtab = raw[symtab.link]!;
  const symbols = [] as ReadElf["symbols"];
  for (let at = symtab.offset; at < symtab.offset + symtab.size; at += 24) {
    symbols.push({
      name: name(strtab, view.getUint32(at, true)),
      binding: view.getUint8(at + 4) >> 4,
      shndx: view.getUint16(at + 6, true),
    });
  }
  return { sections, symbols, symtabInfo: symtab.info };
}

describe("localizeElfObject", () => {
  test("demotes unlisted globals, keeps the keep set / undefineds / commons, remaps relocations", () => {
    // .text with two functions; a relocation referencing the global that
    // gets demoted; one undefined and one COMMON symbol.
    const rela = new Uint8Array(24);
    const relaView = new DataView(rela.buffer);
    relaView.setBigUint64(8, (3n << 32n) | 2n, true); // sym 3 (helper), R_X86_64_PC32
    const object = buildElf(
      [
        { name: ".text", type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, data: new Uint8Array(16) },
        { name: ".rela.text", type: SHT_RELA, data: rela, link: 3, info: 1, entsize: 24n },
      ],
      [
        { name: "", binding: 0, shndx: 1 }, // local section-ish symbol
        { name: "keep_me", binding: STB_GLOBAL, shndx: 1 },
        { name: "helper", binding: STB_GLOBAL, shndx: 1, value: 8n },
        { name: "libc_ref", binding: STB_GLOBAL, shndx: 0 },
        { name: "shared_common", binding: STB_GLOBAL, shndx: SHN_COMMON, value: 8n },
        { name: "weak_def", binding: STB_WEAK, shndx: 1 },
      ],
      1,
    );
    const localized = readElf(localizeElfObject(object, new Set(["keep_me"])));
    const byName = new Map(localized.symbols.map((s) => [s.name, s]));
    expect(byName.get("helper")!.binding).toBe(0);
    expect(byName.get("weak_def")!.binding).toBe(0);
    expect(byName.get("keep_me")!.binding).toBe(STB_GLOBAL);
    expect(byName.get("libc_ref")!.binding).toBe(STB_GLOBAL);
    expect(byName.get("libc_ref")!.shndx).toBe(0);
    expect(byName.get("shared_common")!.binding).toBe(STB_GLOBAL);
    expect(byName.get("shared_common")!.shndx).toBe(SHN_COMMON);
    // Locals precede globals and sh_info agrees.
    const firstGlobal = localized.symbols.findIndex((s) => s.binding !== 0);
    expect(localized.symbols.slice(firstGlobal).every((s) => s.binding !== 0)).toBe(true);
    expect(localized.symtabInfo).toBe(firstGlobal);
    // The relocation follows helper to its new index.
    const relaOut = localized.sections.find((s) => s.name === ".rela.text")!;
    const info = new DataView(relaOut.data.buffer, relaOut.data.byteOffset).getBigUint64(8, true);
    const target = localized.symbols[Number(info >> 32n)]!;
    expect(target.name).toBe("helper");
    expect(info & 0xffffffffn).toBe(2n);
  });

  test("resolves section groups: SHT_GROUP dropped, SHF_GROUP cleared, members and indices intact", () => {
    const group = new Uint8Array(8);
    const groupView = new DataView(group.buffer);
    groupView.setUint32(0, 1, true); // GRP_COMDAT
    groupView.setUint32(4, 2, true); // member: .text.grouped
    const object = buildElf(
      [
        { name: ".group", type: SHT_GROUP, data: group, link: 3, info: 2, entsize: 4n },
        { name: ".text.grouped", type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR | SHF_GROUP, data: new Uint8Array(4) },
      ],
      [
        { name: "", binding: 0, shndx: 1 }, // the group's own section symbol
        { name: "signature", binding: STB_GLOBAL, shndx: 2 },
        { name: "kept", binding: STB_GLOBAL, shndx: 2 },
      ],
      1,
    );
    const localized = readElf(localizeElfObject(object, new Set(["kept"])));
    expect(localized.sections.some((s) => s.type === SHT_GROUP)).toBe(false);
    const member = localized.sections.find((s) => s.name === ".text.grouped")!;
    expect(member.flags & SHF_GROUP).toBe(0n);
    const byName = new Map(localized.symbols.map((s) => [s.name, s]));
    expect(byName.get("signature")!.binding).toBe(0);
    expect(byName.get("kept")!.binding).toBe(STB_GLOBAL);
    // The member's section index shifted down by the dropped group.
    expect(byName.get("kept")!.shndx).toBe(
      localized.sections.findIndex((s) => s.name === ".text.grouped"),
    );
  });

  test("refuses non-relocatable input", () => {
    const object = buildElf([], [], 0);
    new DataView(object.buffer).setUint16(16, 2, true); // ET_EXEC
    expect(() => localizeElfObject(object, new Set())).toThrow(/ET_REL/);
  });
});

/* ── minimal COFF builder ───────────────────────────────────────────────── */

const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_SCN_LNK_COMDAT = 0x00001000;
const IMAGE_SYM_CLASS_EXTERNAL = 2;
const IMAGE_SYM_CLASS_STATIC = 3;

interface CoffSectionSpec {
  name: string;
  data: Uint8Array;
  characteristics?: number;
  relocs?: { va: number; sym: number; type: number }[];
  comdatSelection?: number;
  comdatAssoc?: number;
}

interface CoffSymbolSpec {
  name: string;
  section: number; // 1-based, 0 undefined, -1 absolute
  value?: number;
  storageClass?: number;
  sectionDef?: boolean; // emit a section-definition aux record
}

function buildCoff(sections: CoffSectionSpec[], symbols: CoffSymbolSpec[]): Uint8Array {
  const auxCounts: number[] = symbols.map((s) => (s.sectionDef === true ? 1 : 0));
  const rawCount = symbols.length + auxCounts.reduce((a, b) => a + b, 0);
  const headerSize = 20 + sections.length * 40;
  let at = headerSize;
  const dataAt = sections.map((s) => {
    const here = at;
    at += s.data.length;
    return here;
  });
  const relocAt = sections.map((s) => {
    if ((s.relocs ?? []).length === 0) return 0;
    const here = at;
    at += s.relocs!.length * 10;
    return here;
  });
  const symtabAt = at;
  const longNames = symbols.filter((s) => s.name.length > 8).map((s) => s.name);
  const strtab = buildStrtab(longNames);
  const out = new Uint8Array(symtabAt + rawCount * 18 + 4 + strtab.data.length - 1 + 3);
  const view = new DataView(out.buffer);
  view.setUint16(0, IMAGE_FILE_MACHINE_AMD64, true);
  view.setUint16(2, sections.length, true);
  view.setUint32(8, symtabAt, true);
  view.setUint32(12, rawCount, true);
  sections.forEach((s, i) => {
    const h = 20 + i * 40;
    out.set(new TextEncoder().encode(s.name.slice(0, 8)), h);
    view.setUint32(h + 16, s.data.length, true);
    view.setUint32(h + 20, dataAt[i]!, true);
    view.setUint32(h + 24, relocAt[i]!, true);
    view.setUint16(h + 32, (s.relocs ?? []).length, true);
    view.setUint32(h + 36, s.characteristics ?? 0x60000020, true);
    out.set(s.data, dataAt[i]!);
    (s.relocs ?? []).forEach((r, ri) => {
      const ra = relocAt[i]! + ri * 10;
      view.setUint32(ra, r.va, true);
      view.setUint32(ra + 4, r.sym, true);
      view.setUint16(ra + 8, r.type, true);
    });
  });
  let raw = 0;
  symbols.forEach((s, i) => {
    const a = symtabAt + raw * 18;
    if (s.name.length > 8) {
      view.setUint32(a + 4, 3 + strtab.offsets.get(s.name)!, true);
    } else {
      out.set(new TextEncoder().encode(s.name), a);
    }
    view.setUint32(a + 8, s.value ?? 0, true);
    view.setInt16(a + 12, s.section, true);
    view.setUint8(a + 16, s.storageClass ?? IMAGE_SYM_CLASS_EXTERNAL);
    view.setUint8(a + 17, auxCounts[i]!);
    raw += 1;
    if (s.sectionDef === true) {
      const auxAt = symtabAt + raw * 18;
      const spec = sections[s.section - 1]!;
      view.setUint32(auxAt, spec.data.length, true);
      view.setUint16(auxAt + 4, (spec.relocs ?? []).length, true);
      view.setUint16(auxAt + 12, spec.comdatAssoc ?? s.section, true);
      view.setUint8(auxAt + 14, spec.comdatSelection ?? 0);
      raw += 1;
    }
  });
  const strtabAt = symtabAt + rawCount * 18;
  view.setUint32(strtabAt, 4 + strtab.data.length - 1, true);
  out.set(strtab.data.subarray(1), strtabAt + 4);
  return out.subarray(0, strtabAt + 4 + strtab.data.length - 1);
}

interface ReadCoff {
  sections: { name: string; characteristics: number; data: Uint8Array; relocs: { sym: number }[] }[];
  symbols: { name: string; section: number; storageClass: number; index: number }[];
}

function readCoff(bytes: Uint8Array): ReadCoff {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectionCount = view.getUint16(2, true);
  const symtabAt = view.getUint32(8, true);
  const symbolCount = view.getUint32(12, true);
  const strtabAt = symtabAt + symbolCount * 18;
  const cstr = (at: number): string => {
    let end = at;
    while (bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(at, end));
  };
  const sections = [] as ReadCoff["sections"];
  for (let i = 0; i < sectionCount; i++) {
    const h = 20 + i * 40;
    let name = new TextDecoder().decode(bytes.subarray(h, h + 8)).replace(/\0+$/, "");
    if (name.startsWith("/")) name = cstr(strtabAt + Number.parseInt(name.slice(1), 10));
    const rawSize = view.getUint32(h + 16, true);
    const rawAt = view.getUint32(h + 20, true);
    const relocAt = view.getUint32(h + 24, true);
    const relocCount = view.getUint16(h + 32, true);
    const relocs = [] as { sym: number }[];
    for (let r = 0; r < relocCount; r++) relocs.push({ sym: view.getUint32(relocAt + r * 10 + 4, true) });
    sections.push({
      name,
      characteristics: view.getUint32(h + 36, true),
      data: bytes.subarray(rawAt, rawAt + rawSize),
      relocs,
    });
  }
  const symbols = [] as ReadCoff["symbols"];
  for (let i = 0; i < symbolCount; ) {
    const a = symtabAt + i * 18;
    const name =
      view.getUint32(a, true) === 0
        ? cstr(strtabAt + view.getUint32(a + 4, true))
        : new TextDecoder().decode(bytes.subarray(a, a + 8)).replace(/\0+$/, "");
    symbols.push({
      name,
      section: view.getInt16(a + 12, true),
      storageClass: view.getUint8(a + 16),
      index: i,
    });
    i += 1 + view.getUint8(a + 17);
  }
  return { sections, symbols };
}

describe("mergeAndLocalizeCoffObjects", () => {
  const text = (relocs?: { va: number; sym: number; type: number }[]): CoffSectionSpec => ({
    name: ".text",
    data: new Uint8Array(8),
    characteristics: 0x60000020,
    ...(relocs !== undefined ? { relocs } : {}),
  });

  test("pulls support on demand, resolves references to the demoted definition, keeps the keep set", () => {
    // program: defines keep_me, references helper (reloc via undefined sym 2)
    // raw symbol indices: .text 0 (aux 1), keep_me 2, helper 3, memcpy 4
    const program = buildCoff(
      [text([{ va: 0, sym: 3, type: 4 }])],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "keep_me", section: 1 },
        { name: "helper", section: 0 },
        { name: "memcpy", section: 0 },
      ],
    );
    // needed support: defines helper
    const needed = buildCoff(
      [text()],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "helper", section: 1, value: 4 },
      ],
    );
    // unneeded support: defines lonely, references a unit library mode excludes
    const unneeded = buildCoff(
      [text()],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "lonely", section: 1 },
        { name: "excluded_unit_ref", section: 0 },
      ],
    );
    const merged = readCoff(
      mergeAndLocalizeCoffObjects([program], [needed, unneeded], new Set(["keep_me"])),
    );
    const byName = new Map(merged.symbols.map((s) => [s.name, s]));
    expect(byName.get("keep_me")!.storageClass).toBe(IMAGE_SYM_CLASS_EXTERNAL);
    expect(byName.get("helper")!.storageClass).toBe(IMAGE_SYM_CLASS_STATIC);
    expect(byName.get("helper")!.section).toBeGreaterThan(0);
    expect(byName.get("memcpy")!.storageClass).toBe(IMAGE_SYM_CLASS_EXTERNAL);
    expect(byName.get("memcpy")!.section).toBe(0);
    // The unneeded member never joined: no lonely, no leaked reference.
    expect(byName.has("lonely")).toBe(false);
    expect(byName.has("excluded_unit_ref")).toBe(false);
    // The program's relocation now addresses the demoted definition.
    expect(merged.sections[0]!.relocs[0]!.sym).toBe(byName.get("helper")!.index);
  });

  test("includes every root even when no other object references its exports", () => {
    const program = buildCoff(
      [text()],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "keep_me", section: 1 },
      ],
    );
    const identity = buildCoff(
      [text()],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "build_id", section: 1 },
        { name: "abi_version", section: 1, value: 4 },
      ],
    );
    const unneeded = buildCoff(
      [text()],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "lonely", section: 1 },
        { name: "excluded_unit_ref", section: 0 },
      ],
    );

    const merged = readCoff(
      mergeAndLocalizeCoffObjects(
        [program, identity],
        [unneeded],
        new Set(["keep_me", "build_id", "abi_version"]),
      ),
    );
    const byName = new Map(merged.symbols.map((symbol) => [symbol.name, symbol]));
    for (const name of ["keep_me", "build_id", "abi_version"]) {
      expect(byName.get(name)?.storageClass).toBe(IMAGE_SYM_CLASS_EXTERNAL);
      expect(byName.get(name)?.section).toBeGreaterThan(0);
    }
    expect(byName.has("lonely")).toBe(false);
    expect(byName.has("excluded_unit_ref")).toBe(false);
  });

  test("resolves cross-references between program-shard roots and demotes their private links", () => {
    const first = buildCoff(
      [text([{ va: 0, sym: 3, type: 4 }])],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "private_a", section: 1 },
        { name: "private_b", section: 0 },
      ],
    );
    const second = buildCoff(
      [text([{ va: 0, sym: 3, type: 4 }])],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "private_b", section: 1 },
        { name: "private_a", section: 0 },
        { name: "public_entry", section: 1, value: 4 },
      ],
    );
    const merged = readCoff(
      mergeAndLocalizeCoffObjects([first, second], [], new Set(["public_entry"])),
    );
    const byName = new Map(merged.symbols.map((symbol) => [symbol.name, symbol]));
    expect(byName.get("private_a")?.storageClass).toBe(IMAGE_SYM_CLASS_STATIC);
    expect(byName.get("private_b")?.storageClass).toBe(IMAGE_SYM_CLASS_STATIC);
    expect(byName.get("public_entry")?.storageClass).toBe(IMAGE_SYM_CLASS_EXTERNAL);
    expect(merged.sections[0]!.relocs[0]!.sym).toBe(byName.get("private_b")!.index);
    expect(merged.sections[1]!.relocs[0]!.sym).toBe(byName.get("private_a")!.index);
  });

  test("does not pull an alternate definition when a selected object already satisfies the reference", () => {
    // program defines foo and needs bar; the first support member defines
    // bar and calls back into foo. A real archive link stops there. The
    // later alternate foo member must remain unselected rather than causing
    // a false duplicate definition during the merge.
    const program = buildCoff(
      [text([{ va: 0, sym: 3, type: 4 }])],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "foo", section: 1 },
        { name: "bar", section: 0 },
      ],
    );
    const needed = buildCoff(
      [text([{ va: 0, sym: 3, type: 4 }])],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "bar", section: 1 },
        { name: "foo", section: 0 },
      ],
    );
    const alternate = buildCoff(
      [text()],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "foo", section: 1 },
        { name: "alternate_only", section: 1 },
      ],
    );

    const merged = readCoff(
      mergeAndLocalizeCoffObjects([program], [needed, alternate], new Set()),
    );
    const byName = new Map(merged.symbols.map((s) => [s.name, s]));
    expect(byName.has("alternate_only")).toBe(false);
    expect(merged.sections.filter((s) => s.name === ".text")).toHaveLength(2);
    expect(merged.sections[0]!.relocs[0]!.sym).toBe(byName.get("bar")!.index);
    expect(merged.sections[1]!.relocs[0]!.sym).toBe(byName.get("foo")!.index);
  });

  test("COMDAT duplicates deduplicate inside the merge and the flag clears in the output", () => {
    // Both objects carry a .refptr.shared COMDAT ANY stub (the mingw
    // pattern: one per referencing TU); the program pulls the support
    // object through an undefined reference. Raw symbol indices per
    // object: .text 0 (aux 1), .rdata 2 (aux 3), then the named symbols.
    const program = buildCoff(
      [
        text([{ va: 0, sym: 5, type: 4 }]),
        {
          name: ".rdata",
          data: new Uint8Array(8),
          characteristics: 0x40000040 | IMAGE_SCN_LNK_COMDAT,
          comdatSelection: 2,
          relocs: [],
        },
      ],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: ".rdata", section: 2, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "keep_me", section: 1 },
        { name: "support_fn", section: 0 },
        { name: ".refptr.shared", section: 2 },
      ],
    );
    const support = buildCoff(
      [
        text(),
        {
          name: ".rdata",
          data: new Uint8Array(8),
          characteristics: 0x40000040 | IMAGE_SCN_LNK_COMDAT,
          comdatSelection: 2,
          relocs: [],
        },
      ],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: ".rdata", section: 2, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "support_fn", section: 1 },
        { name: ".refptr.shared", section: 2 },
      ],
    );
    const merged = readCoff(mergeAndLocalizeCoffObjects([program], [support], new Set(["keep_me"])));
    // One survivor section carries the stub; no COMDAT flag remains anywhere.
    const rdata = merged.sections.filter((s) => s.name === ".rdata");
    expect(rdata.length).toBe(1);
    for (const section of merged.sections) {
      expect(section.characteristics & IMAGE_SCN_LNK_COMDAT).toBe(0);
    }
    // The stub's symbol demoted with everything else; exactly one copy.
    const stubs = merged.symbols.filter((s) => s.name === ".refptr.shared");
    expect(stubs.length).toBe(1);
    expect(stubs[0]!.storageClass).toBe(IMAGE_SYM_CLASS_STATIC);
  });

  const comdatPair = (
    selection: number,
    firstData: Uint8Array,
    secondData: Uint8Array,
  ): { program: Uint8Array; support: Uint8Array[] } => {
    const program = buildCoff(
      [text([{ va: 0, sym: 3, type: 4 }, { va: 4, sym: 4, type: 4 }])],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "entry", section: 1 },
        { name: "need_one", section: 0 },
        { name: "need_two", section: 0 },
      ],
    );
    const member = (needed: string, data: Uint8Array): Uint8Array =>
      buildCoff(
        [
          text(),
          {
            name: ".rdata",
            data,
            characteristics: 0x40000040 | IMAGE_SCN_LNK_COMDAT,
            comdatSelection: selection,
          },
        ],
        [
          { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
          { name: ".rdata", section: 2, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
          { name: needed, section: 1 },
          { name: "shared", section: 2 },
        ],
      );
    return { program, support: [member("need_one", firstData), member("need_two", secondData)] };
  };

  test("COMDAT LARGEST retains the largest selected definition", () => {
    const pair = comdatPair(6, new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8, 9]));
    const merged = readCoff(mergeAndLocalizeCoffObjects([pair.program], pair.support, new Set(["entry"])));
    const rdata = merged.sections.filter((section) => section.name === ".rdata");
    expect(rdata).toHaveLength(1);
    expect([...rdata[0]!.data]).toEqual([5, 6, 7, 8, 9]);
  });

  test("associative COMDATs follow a LARGEST winner chosen from a later object", () => {
    const pair = comdatPair(6, new Uint8Array(4), new Uint8Array(8));
    const withAssociate = (marker: number): Uint8Array => {
      // Rebuild the support member so its third section associates with the
      // LARGEST parent in section 2. Both selected members use the same
      // leader names; only the later/larger pair should survive.
      const needed = marker === 1 ? "need_one" : "need_two";
      return buildCoff(
        [
          text(),
          {
            name: ".rdata",
            data: marker === 1 ? new Uint8Array(4) : new Uint8Array(8),
            characteristics: 0x40000040 | IMAGE_SCN_LNK_COMDAT,
            comdatSelection: 6,
          },
          {
            name: ".assoc",
            data: new Uint8Array([marker]),
            characteristics: 0x40000040 | IMAGE_SCN_LNK_COMDAT,
            comdatSelection: 5,
            comdatAssoc: 2,
          },
        ],
        [
          { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
          { name: ".rdata", section: 2, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
          { name: "shared", section: 2 },
          { name: ".assoc", section: 3, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
          { name: "assoc_shared", section: 3 },
          { name: needed, section: 1 },
        ],
      );
    };
    const merged = readCoff(
      mergeAndLocalizeCoffObjects(
        [pair.program],
        [withAssociate(1), withAssociate(2)],
        new Set(["entry"]),
      ),
    );
    const associates = merged.sections.filter((section) => section.name === ".assoc");
    expect(associates).toHaveLength(1);
    expect([...associates[0]!.data]).toEqual([2]);
  });

  test("COMDAT SAME_SIZE refuses definitions with different sizes", () => {
    const pair = comdatPair(3, new Uint8Array(4), new Uint8Array(8));
    expect(() =>
      mergeAndLocalizeCoffObjects([pair.program], pair.support, new Set(), {
        roots: ["program.o"],
        support: ["one.o", "two.o"],
      }),
    ).toThrow(/SAME_SIZE mismatch.*one\.o.*two\.o/);
  });

  test("COMDAT EXACT_MATCH refuses equal-size definitions with different contents", () => {
    const pair = comdatPair(4, new Uint8Array([1, 2, 3, 4]), new Uint8Array([1, 2, 3, 5]));
    expect(() =>
      mergeAndLocalizeCoffObjects([pair.program], pair.support, new Set(), {
        roots: ["program.o"],
        support: ["one.o", "two.o"],
      }),
    ).toThrow(/EXACT_MATCH mismatch.*one\.o.*two\.o/);
  });

  test("COMDAT duplicates refuse conflicting selection kinds", () => {
    const one = comdatPair(2, new Uint8Array(4), new Uint8Array(4));
    const two = comdatPair(3, new Uint8Array(4), new Uint8Array(4));
    expect(() => mergeAndLocalizeCoffObjects([one.program], [one.support[0]!, two.support[1]!], new Set()))
      .toThrow(/conflicting COMDAT selections/);
  });

  test("duplicate strong definitions refuse with both members named", () => {
    const one = buildCoff(
      [text()],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "keep_me", section: 1 },
        { name: "dup", section: 1 },
        { name: "pull", section: 0 },
      ],
    );
    const two = buildCoff(
      [text()],
      [
        { name: ".text", section: 1, storageClass: IMAGE_SYM_CLASS_STATIC, sectionDef: true },
        { name: "pull", section: 1 },
        { name: "dup", section: 1 },
      ],
    );
    expect(() =>
      mergeAndLocalizeCoffObjects([one], [two], new Set(["keep_me"]), {
        roots: ["one.o"],
        support: ["two.o"],
      }),
    ).toThrow(/duplicate external symbol dup.*one\.o.*two\.o/);
  });

  test("refuses non-AMD64 machines", () => {
    const object = buildCoff([text()], [{ name: "x", section: 1 }]);
    new DataView(object.buffer, object.byteOffset).setUint16(0, 0xaa64, true);
    expect(() => mergeAndLocalizeCoffObjects([object], [], new Set())).toThrow(/machine/);
  });
});
