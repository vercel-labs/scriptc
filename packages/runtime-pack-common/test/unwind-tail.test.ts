import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import {
  UNWIND_TAIL_SECTION,
  archiveMembers,
  describeUnwindTable,
  moveUnwindTailLast,
  unwindTailCompileFlags,
  unwindTailProblems,
  unwindTailProblemsUnder,
} from "../scripts/unwind-tail.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

// The object tests compile for the host with clang, and the executables need
// a linker that drops unreferenced sections and their unwind entries.
const elfHost =
  process.platform === "linux" &&
  (process.arch === "x64" || process.arch === "arm64") &&
  spawnSync("clang", ["--version"]).status === 0;

const scratch = mkdtempSync(join(tmpdir(), "scriptc-unwind-tail-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// lld copies unwind entries into an executable as they are, which is how an
// object's padding reaches executables; scriptc links with it when the
// compiler driver finds it. GNU ld pads every entry again by its own rule.
const lld = (() => {
  if (!elfHost) return false;
  const probe = join(scratch, "probe.c");
  writeFileSync(probe, "int main(void) { return 0; }\n");
  return spawnSync("clang", ["-fuse-ld=lld", probe, "-o", join(scratch, "probe")]).status === 0;
})();

// A unit whose last function in the object is `last` (a static function the
// compiler defers past the source's end, as it does in the runtime's units)
// and whose function `edited` exists in several versions: it saves `saved`
// callee-saved registers and keeps `frame` bytes of locals. Both change the
// call frame instructions of `edited`'s entry, so the versions' unwind
// tables differ in size, by an odd number of words between some of them on
// x86-64 and on AArch64.
type Version = { saved: number; frame: number };
const VERSIONS: Version[] = [
  { saved: 0, frame: 0 },
  { saved: 0, frame: 100 },
  { saved: 2, frame: 0 },
  { saved: 2, frame: 100 },
  { saved: 1, frame: 1000 },
];

function unitSource({ saved, frame }: Version): string {
  const registers =
    process.arch === "x64"
      ? ["rbx", "r12", "r13", "r14", "r15"]
      : ["x19", "x20", "x21", "x22", "x23"];
  const clobbers = registers
    .slice(0, saved)
    .map((name) => `"${name}"`)
    .join(", ");
  return `
extern int unit_value;
extern void unit_sink(void *);
int edited(int x) {
  ${clobbers === "" ? "" : `__asm__ volatile("" : : : ${clobbers});`}
  ${frame === 0 ? "" : `volatile char locals[${frame}]; locals[0] = (char)x; unit_sink((void *)locals);`}
  return x + unit_value;
}
static int last(int x) { return x * 3 + unit_value; }
static int (*const table[])(int) = {last};
int kept(int x) { return table[x & 0](x) + 1; }
`;
}

/** Compile one version to `<scratch>/<name>/unit.o`. Every version has the
 * same file name: an object records it, and an executable's symbol table
 * carries it. */
function compileUnit(
  name: string,
  version: Version,
  tail: boolean,
  defines: string[] = [],
): Buffer {
  mkdirSync(join(scratch, name), { recursive: true });
  const source = join(scratch, name, "unit.c");
  const object = join(scratch, name, "unit.o");
  writeFileSync(source, unitSource(version));
  execFileSync("clang", [
    "-O2",
    "-fno-inline",
    "-ffunction-sections",
    "-fdata-sections",
    ...(tail ? unwindTailCompileFlags("elf") : []),
    ...defines.map((define) => `-D${define}`),
    "-c",
    source,
    "-o",
    object,
  ]);
  return readFileSync(object);
}

/** The bytes of the unwind entry of the function in `section`, with the CIE
 * distance cleared: it is the entry's position, which a linker rewrites. */
function entryBytes(object: Buffer, section: string): Buffer {
  const table = describeUnwindTable(object)!;
  const entry = table.entries.find((candidate) => candidate.target === section)!;
  const start = table.offset + entry.offset;
  const bytes = Buffer.from(object.subarray(start, start + entry.size));
  bytes.writeUInt32LE(0, 4);
  return bytes;
}

test.skipIf(!elfHost)(
  "an edit to one function leaves the unwind entries of the unit's other functions unchanged",
  () => {
    // Without the unwind tail, the padding of the last function's entry
    // follows the size of the edited function's entry: some pair of versions
    // differs. This is the compiler behavior the tail exists for; when no
    // pair differs any more, the compiler stopped padding the last entry and
    // the unwind tail can go.
    const plain = VERSIONS.map((version, index) => compileUnit(`plain${index}`, version, false));
    const plainPadding = plain.map((object) => describeUnwindTable(object)!.entries.at(-1)!);
    expect(plainPadding.every((entry) => entry.target === ".text.last")).toBe(true);
    expect(new Set(plainPadding.map((entry) => entry.nops >= 4)).size).toBe(2);
    for (const object of plain)
      expect(unwindTailProblems(object)).toEqual([
        expect.stringContaining("the last FDE describes .text.last"),
      ]);

    const entries = new Set<string>();
    for (const [index, version] of VERSIONS.entries()) {
      const object = compileUnit(`tail${index}`, version, true);
      const before = describeUnwindTable(object)!;
      // The compiler alone does not put the tail function's entry last.
      expect(before.entries.at(-1)!.target).toBe(".text.last");
      expect(moveUnwindTailLast(object)).toBe(true);
      const after = describeUnwindTable(object)!;
      expect(unwindTailProblems(object)).toEqual([]);
      expect(after.entries.at(-1)!.target).toBe(UNWIND_TAIL_SECTION);
      // The table stays what linkers expect of an object: its size and
      // alignment are unchanged, and the size is a multiple of the alignment.
      expect(after.size).toBe(before.size);
      expect(after.alignment).toBe(before.alignment);
      expect(after.size % after.alignment).toBe(0);
      expect(after.entries.slice(0, -1).every((entry) => entry.nops < 4)).toBe(true);
      // A second pass changes nothing.
      const again = Buffer.from(object);
      expect(moveUnwindTailLast(again)).toBe(false);
      expect(again.equals(object)).toBe(true);
      writeFileSync(join(scratch, "probe.o"), object);
      // binutils reads the rewritten table and its relocations.
      const frames = execFileSync("readelf", ["--debug-dump=frames", join(scratch, "probe.o")], {
        encoding: "utf8",
      });
      expect(frames.match(/ FDE /g)).toHaveLength(after.entries.length - 1);
      entries.add(
        `${entryBytes(object, ".text.last").toString("hex")} ${entryBytes(object, ".text.kept").toString("hex")}`,
      );
    }
    // The entries of `last` and `kept` are the same bytes in every version.
    expect(entries.size).toBe(1);
  },
  120_000,
);

test.skipIf(!elfHost)(
  "an executable that does not link the edited function is byte-identical across the edit",
  () => {
    const main = join(scratch, "main.c");
    writeFileSync(
      main,
      `#include <stdio.h>
int unit_value = 2;
void unit_sink(void *locals) { (void)locals; }
extern int kept(int);
int main(void) { printf("%d\\n", kept(5)); return 0; }
`,
    );
    const link = (unit: string) => {
      const output = join(scratch, unit, "program");
      execFileSync("clang", [
        "-O2",
        "-ffunction-sections",
        main,
        join(scratch, unit, "unit.o"),
        ...(lld ? ["-fuse-ld=lld"] : []),
        "-Wl,--gc-sections",
        "-Wl,--build-id=none",
        "-o",
        output,
      ]);
      expect(execFileSync(output, { encoding: "utf8" })).toBe("18\n");
      return readFileSync(output);
    };
    // `sealed` moves the tail function's entry last, as the pack build does.
    const build = (name: string, version: Version, sealed: boolean) => {
      const object = compileUnit(name, version, true);
      if (sealed) moveUnwindTailLast(object);
      writeFileSync(join(scratch, name, "unit.o"), object);
      const executable = link(name);
      // Section garbage collection drops the edited function, the tail
      // function and their entries.
      const symbols = execFileSync("nm", [join(scratch, name, "program")], { encoding: "utf8" });
      expect(symbols).not.toContain("scr_unwind_tail");
      expect(symbols).not.toContain("edited");
      return executable.toString("base64");
    };
    const sealed = VERSIONS.map((version, index) => build(`sealed${index}`, version, true));
    expect(new Set(sealed).size).toBe(1);
    // The same units as the compiler leaves them, linked with lld: the
    // executables differ, in the padding of `last`'s entry.
    if (lld) {
      const unsealed = VERSIONS.map((version, index) => build(`unsealed${index}`, version, false));
      expect(new Set(unsealed).size).toBe(2);
    }
  },
  120_000,
);

test.skipIf(!elfHost)("a relocatable link of sealed objects keeps every unwind entry", () => {
  // Library builds merge runtime objects with `ld -r`, which concatenates
  // unwind tables: each table must stay a multiple of its alignment, or the
  // linker pads between them with zeros, which end the table.
  const objects = VERSIONS.slice(0, 3).map((version, index) => {
    const object = compileUnit(`merge${index}`, version, true, [
      `edited=edited${index}`,
      `kept=kept${index}`,
    ]);
    moveUnwindTailLast(object);
    const path = join(scratch, `merge${index}`, "unit.o");
    writeFileSync(path, object);
    return path;
  });
  const merged = join(scratch, "merged.o");
  execFileSync("ld", ["-r", ...objects, "-o", merged]);
  const frames = execFileSync("readelf", ["--debug-dump=frames", merged], { encoding: "utf8" });
  expect(frames).not.toContain("ZERO terminator");
  // edited, last, kept and the tail function, three times.
  expect(frames.match(/ FDE /g)).toHaveLength(12);
});

test.skipIf(!elfHost)("an object compiled without the unwind tail is refused", () => {
  const object = compileUnit("refused", VERSIONS[0]!, false);
  expect(() => moveUnwindTailLast(object)).toThrow(
    `expected one FDE for ${UNWIND_TAIL_SECTION}, found 0`,
  );
});

test("objects that are not ELF have no unwind tail to check", () => {
  expect(unwindTailProblems(Buffer.from("strtol\0__isoc99_sscanf\0"))).toEqual([]);
  expect(unwindTailCompileFlags("macho")).toEqual([]);
  expect(unwindTailCompileFlags("coff")).toEqual([]);
  expect(unwindTailCompileFlags("wasm")).toEqual([]);
  expect(unwindTailCompileFlags("elf")[0]).toBe("-include");
});

test.skipIf(!elfHost)("archive members are read by name, long names included", () => {
  const names = ["short.o", "a-member-name-longer-than-sixteen-bytes.o"];
  for (const name of names)
    writeFileSync(join(scratch, name), compileUnit("member", VERSIONS[0]!, false));
  const archive = join(scratch, "members.a");
  execFileSync("ar", ["rcs", archive, ...names.map((name) => join(scratch, name))]);
  const members = archiveMembers(readFileSync(archive));
  expect(members.map((member) => member.name)).toEqual(names);
  for (const member of members) expect(describeUnwindTable(member.data)).not.toBeNull();
});

// The packs the repository holds built: every ELF object and archive member
// they ship ends its unwind table with the tail function's entry. A pack
// built before the unwind tail existed, or by a build that skipped it, fails
// here, and so does a compiler that starts padding other entries.
const elfPacks = readdirSync(join(repoRoot, "packages"))
  .filter((name) => /^runtime-(linux|android)-/.test(name))
  .map((name) => join(repoRoot, "packages", name))
  .filter((root) => existsSync(join(root, "runtime-pack.json")));

test.skipIf(elfPacks.length === 0)(
  "every object of the built ELF runtime packs ends its unwind table with the tail function",
  async () => {
    for (const root of elfPacks) {
      const problems = await unwindTailProblemsUnder(join(root, "artifacts"));
      expect(problems.slice(0, 20), `${root}: ${problems.length} objects`).toEqual([]);
    }
  },
  120_000,
);
