import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// A class family's static-field fences are one branch per (boxed class, held
// class, field) in %dyn.class.defineProperty. Left in one function, LLVM's
// spill slots for those branches make the frame grow with the program's class
// fields — the synthetic class below alone reached 96 KiB with 4,000 fields —
// and module initialization runs on an async fiber with a bounded stack.
// Split into calls, the branches stay in the same order while each function's
// frame is bounded.
test("a class family's static-field fences stay in bounded functions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fence-frame-"));
  try {
    const fields = Array.from(
      { length: 1500 },
      (_, index) => `  static f${index} = ${index};`,
    ).join("\n");
    const entry = join(directory, "main.ts");
    writeFileSync(
      entry,
      `class Base {\n${fields}\n}\n` +
        `class Sub extends Base { static g = 1; }\n` +
        `const boxed: any = Base;\n` +
        `Object.defineProperty(boxed, "notAField", { value: 1, configurable: true });\n` +
        `console.log("ok", typeof boxed);\n`,
    );
    const llvm = join(directory, "main.ll");
    const result = await compile(entry, {
      outDir: directory,
      outPath: llvm,
      outputKind: "llvm",
    });
    expect(result.ok ? [] : result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    const functions = new Map<string, number>();
    const text = readFileSync(llvm, "utf8");
    for (const part of text.split("\ndefine ").slice(1)) {
      const header = part.slice(0, part.indexOf("\n"));
      const name = /@([^(\s]+)\(/.exec(header)?.[1];
      if (name !== undefined) functions.set(name, part.split("\n").length);
    }
    const fence = functions.get("sc_bf__x25_dyn_class_defineProperty");
    expect(fence, "the helper is emitted").toBeDefined();
    expect(fence!, "the helper's own body stays small").toBeLessThan(4000);
    const chunks = [...functions.keys()].filter((name) =>
      name.startsWith("sc_bf__x25_staticFieldFence_"),
    );
    expect(chunks, "the fences are carried by chunk functions").not.toEqual([]);
    for (const name of chunks)
      expect(functions.get(name)!, `${name} stays bounded`).toBeLessThan(4000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

// Object.assign and Object.defineProperties on a class value guard the static
// fields they could write with the same kind of run, but their helpers name a
// source and a value as well as the target and key. A chunk receives the
// helper's own parameters and every read-only local its branches read, so a
// long run still splits (it used to name `target`/`key` and fail to compile).
test("long guard runs in the assign helpers compile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fence-params-"));
  try {
    const fields = Array.from({ length: 300 }, (_, index) => `  static f${index} = ${index};`).join(
      "\n",
    );
    const entry = join(directory, "main.ts");
    writeFileSync(
      entry,
      `class Base {\n${fields}\n}\n` +
        `class Sub extends Base { static g = 1; }\n` +
        `const boxed: any = Base;\n` +
        `Object.assign(boxed, {});\n` +
        `Object.defineProperties(boxed, {});\n` +
        `console.log("ok", typeof boxed);\n`,
    );
    const ir = join(directory, "main.ir");
    const result = await compile(entry, {
      outDir: directory,
      outPath: ir,
      outputKind: "ir",
    });
    expect(result.ok ? [] : result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    const text = readFileSync(ir, "utf8");
    expect(text.includes("%staticFieldFence."), "the guard runs are chunked").toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
