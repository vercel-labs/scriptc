import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const source = readFileSync(join(import.meta.dirname, "../src/scr_symbol.c"), "utf8");

/** The guard block that spells the DisposableStack member slot's qualifier. */
function slotQualifier(): string {
  const slot = source.indexOf("extern ScrDyn *(*scr_dyn_disposable_stack_member)");
  expect(slot, "the slot's declaration").toBeGreaterThan(-1);
  const guard = source.lastIndexOf("#if defined(__APPLE__)", slot);
  expect(guard, "a Darwin guard above the slot's declaration").toBeGreaterThan(-1);
  const declaration = source.slice(slot, source.indexOf(";", slot));
  expect(declaration, "the slot's declaration takes its qualifier from the guard").toContain(
    "SCR_DS_MEMBER_SLOT",
  );
  return source.slice(guard, slot);
}

// The slot is defined by one build of the invoke unit and referenced by this
// unit, so a program that links the stack without that build has no definition
// for it and the link must leave it at zero. A plain weak declaration of a
// data symbol says that on ELF; Darwin does not read it that way and refuses
// the link with an undefined symbol, so the unit spells the slot weak_import
// there.
test("the stack member slot is a weak import on Darwin", () => {
  const qualifier = slotQualifier();
  expect(qualifier).toContain("#define SCR_DS_MEMBER_SLOT __attribute__((weak_import))");
  expect(qualifier).toContain("#define SCR_DS_MEMBER_SLOT __attribute__((weak))");
});

// The probe carries no system header, so the Darwin target needs no SDK: this
// checks the qualifier's meaning for the object format the macOS and iOS packs
// are built in, not just its spelling.
test("the stack member slot is a weak reference on Darwin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-weak-import-"));
  try {
    const probe = join(dir, "probe.c");
    await writeFile(
      probe,
      [
        "typedef struct ScrDyn ScrDyn;",
        "typedef __SIZE_TYPE__ size_t;",
        slotQualifier().trimEnd(),
        "extern ScrDyn *(*scr_dyn_disposable_stack_member)(const char *key, size_t len) SCR_DS_MEMBER_SLOT;",
        "void hook(void) {",
        "  if (&scr_dyn_disposable_stack_member)",
        "    scr_dyn_disposable_stack_member = 0;",
        "}",
        "",
      ].join("\n"),
    );
    const { stdout } = await execFileAsync("clang", [
      "-S",
      "-O2",
      "-target",
      "arm64-apple-macosx14.0.0",
      probe,
      "-o",
      "-",
    ]);
    expect(stdout).toContain(".weak_reference _scr_dyn_disposable_stack_member");
    expect(stdout).not.toContain(".globl\t_scr_dyn_disposable_stack_member");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
