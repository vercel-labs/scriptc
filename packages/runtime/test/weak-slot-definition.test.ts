import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const source = readFileSync(join(import.meta.dirname, "../src/scr_symbol.c"), "utf8");

/** One arm of the slot's `#if defined(__APPLE__)` block. */
function slotArm(arm: "darwin" | "elf"): string {
  const at = source.indexOf("#if defined(__APPLE__)");
  expect(at, "the slot's platform branch").toBeGreaterThan(-1);
  const elseAt = source.indexOf("#else", at);
  const endAt = source.indexOf("#endif", elseAt);
  expect(elseAt, "the slot's `#else`").toBeGreaterThan(at);
  expect(endAt, "the slot's `#endif`").toBeGreaterThan(elseAt);
  const armText = source.slice(arm === "darwin" ? at : elseAt, arm === "darwin" ? elseAt : endAt);
  expect(armText, "the arm declares the slot").toContain(
    "ScrDyn *(*scr_dyn_disposable_stack_member)(",
  );
  return armText;
}

/** The slot's declaration, from its type to its `;`, as Darwin spells it. */
function slotDeclaration(): string {
  const start = source.indexOf("ScrDyn *(*scr_dyn_disposable_stack_member)(");
  expect(start, "the slot's declaration").toBeGreaterThan(-1);
  const declaration = source.slice(start, source.indexOf(";", start) + 1);
  expect(declaration, "the slot's declaration names its type").toContain(
    "scr_dyn_disposable_stack_member",
  );
  return declaration;
}

// One build of the invoke unit defines the slot and this unit fills it, so a
// program that links the stack without that build needs a definition from the
// object format that will not bind a weak reference to zero. Darwin refuses
// to link a data symbol that is declared weak and defined nowhere, so the
// unit defines the slot itself there, weakly, and the object-model build's
// definition replaces it when it links.
test("Darwin defines the stack member slot weakly", () => {
  const arm = slotArm("darwin");
  expect(arm).not.toMatch(/^extern\b/m);
  expect(arm).toContain("__attribute__((weak)) = 0;");
});

// ELF binds a weak declaration of a data symbol to zero by itself. A
// definition there would put the pointer, and the code that writes it, into
// every ELF program that links this unit, so ELF keeps the declaration.
test("ELF keeps the stack member slot a weak declaration", () => {
  const arm = slotArm("elf");
  expect(arm).toMatch(/^extern\b/m);
  expect(arm).not.toContain("= 0;");
  expect(arm).toContain("__attribute__((weak));");
});

// The probe carries no system header, so the Darwin target needs no SDK: this
// checks how the object format the macOS and iOS packs are built in reads the
// declaration, not just how the source spells it.
test("the stack member slot is a definition in a Darwin object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-slot-"));
  try {
    const probe = join(dir, "probe.c");
    await writeFile(
      probe,
      [
        "typedef struct ScrDyn ScrDyn;",
        "typedef __SIZE_TYPE__ size_t;",
        slotDeclaration(),
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
    expect(stdout).toContain(".weak_definition\t_scr_dyn_disposable_stack_member");
    expect(stdout).not.toContain(".weak_reference\t_scr_dyn_disposable_stack_member");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Links and runs what the runtime is built in: the slot alone, as a program
// that links the stack unit without the object-model build has it, and the
// slot with the object-model build's definition beside it.
test("the weak slot links alone and gives way to a strong definition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-slot-link-"));
  try {
    const probe = join(dir, "probe.c");
    const main = join(dir, "main.c");
    const strong = join(dir, "strong.c");
    const strongMain = join(dir, "strong-main.c");
    await writeFile(
      probe,
      [
        "typedef struct ScrDyn ScrDyn;",
        "typedef __SIZE_TYPE__ size_t;",
        slotDeclaration(),
        "ScrDyn *(*scr_dyn_slot_value(void))(const char *key, size_t len) {",
        "  return scr_dyn_disposable_stack_member;",
        "}",
        "",
      ].join("\n"),
    );
    const reads = [
      "typedef struct ScrDyn ScrDyn;",
      "typedef __SIZE_TYPE__ size_t;",
      "extern ScrDyn *(*scr_dyn_slot_value(void))(const char *key, size_t len);",
    ];
    await writeFile(
      main,
      [...reads, "int main(void) { return scr_dyn_slot_value() == 0 ? 0 : 1; }", ""].join("\n"),
    );
    await writeFile(
      strong,
      [
        "typedef struct ScrDyn ScrDyn;",
        "typedef __SIZE_TYPE__ size_t;",
        "ScrDyn *scr_strong_member(const char *key, size_t len) {",
        "  (void)key;",
        "  (void)len;",
        "  return 0;",
        "}",
        "ScrDyn *(*scr_dyn_disposable_stack_member)(const char *key, size_t len) = scr_strong_member;",
        "",
      ].join("\n"),
    );
    await writeFile(
      strongMain,
      [
        ...reads,
        "extern ScrDyn *scr_strong_member(const char *key, size_t len);",
        "int main(void) {",
        "  return scr_dyn_slot_value() == scr_strong_member ? 0 : 1;",
        "}",
        "",
      ].join("\n"),
    );

    const link = async (program: string, sources: string[]) => {
      const binary = join(dir, program);
      await execFileAsync("clang", ["-O2", "-o", binary, ...sources]);
      await execFileAsync(binary, []);
    };
    await link("alone", [probe, main]);
    await link("with-strong", [probe, strong, strongMain]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
