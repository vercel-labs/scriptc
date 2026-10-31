import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const exec = promisify(execFile);
const corpus = join(import.meta.dirname, "../../../tests/corpus/3068-debug-variables");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test.runIf(process.platform === "darwin")(
  "LLVM dev builds expose source variables and lexical scopes in LLDB",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-debug-variables-"));
    try {
      const source = join(dir, "source space é");
      await cp(corpus, source, { recursive: true });
      const entry = join(source, "main.ts");
      const outPath = join(dir, "program");
      const text = await readFile(entry, "utf8");
      const line = (marker: string): number =>
        text.split("\n").findIndex((l) => l.endsWith(`// debug: ${marker}`)) + 1;
      const oracle = await exec(process.execPath, [entry]);
      for (let build = 0; build < 2; build++) {
        const result = await compile(entry, {
          outDir: dir,
          outPath,
          backend: "llvm",
          optimization: "dev",
          sanitize,
        });
        expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics) : "").toBe(true);
        if (!result.ok) return;
        const native = await exec(outPath);
        expect(native.stdout).toBe(oracle.stdout);
        expect(native.stderr).toBe(oracle.stderr);
        const commands = [
          ...["globals", "locals", "shadow", "capture", "restored", "loop", "item", "hoisted"].map(
            (marker) =>
              `breakpoint set --file main.ts --line ${line(marker)} --move-to-nearest-code false`,
          ),
          "breakpoint set --file other.ts --line 4 --move-to-nearest-code false",
          "run",
          "frame variable moduleValue moduleText",
          "continue",
          "frame variable input enabled fallback value text",
          "frame variable text->len",
          "frame variable text->data",
          "continue",
          "frame variable value",
          "continue",
          "frame variable value",
          "continue",
          "frame variable value",
          "continue",
          "frame variable i",
          "continue",
          "frame variable i",
          "continue",
          "frame variable item->tag item->slot.arm0",
          "continue",
          "frame variable item->tag item->slot.arm0",
          "continue",
          "frame variable item->tag",
          "continue",
          "frame variable hoisted",
          "continue",
          "frame variable moduleValue",
          "continue",
        ];
        const debug = await exec("lldb", [
          "--batch",
          outPath,
          ...commands.flatMap((c) => ["-o", c]),
        ]).catch((error: { stdout: string; stderr: string }) => {
          throw new Error(`${error.stdout}\n${error.stderr}`);
        });
        expect(debug.stderr).toBe("");
        expect(debug.stdout).not.toContain("pending");
        for (const value of [
          "moduleValue = 42",
          "moduleValue = 100",
          "input = 3",
          "enabled = true",
          "fallback = 9",
          "value = 4",
          "value = 99",
          "value = 6",
          "i = 0",
          "i = 1",
          "item->tag = f64",
          "item->slot.arm0 = 6",
          "item->slot.arm0 = 7",
          "item->tag = undefined",
          "hoisted = 13",
        ]) {
          expect(debug.stdout).toContain(value);
        }
        expect(debug.stdout).toContain("text->len = 8");
        expect(debug.stdout).toContain('text->data = "hello é"');
        const shadowValues = [
          ...debug.stdout.matchAll(/\(lldb\) frame variable value\r?\n\(double\) value = (\d+)/g),
        ].map((match) => Number(match[1]));
        expect(shadowValues).toEqual([99, 6, 6]);
        expect(debug.stdout).not.toContain("sc_l_");
        // Exercise the executable cache's restored dSYM, with native objects
        // and the first linked binary already gone.
        await rm(outPath);
        await rm(`${outPath}.dSYM`, { recursive: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("release LLVM output omits dev variable metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-debug-modes-"));
  try {
    for (const mode of ["dev", "release"] as const) {
      const outPath = join(dir, `${mode}.ll`);
      const result = await compile(join(corpus, "main.ts"), {
        outDir: dir,
        outPath,
        outputKind: "llvm",
        optimization: mode,
      });
      expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics) : "").toBe(true);
      const llvm = await readFile(outPath, "utf8");
      if (mode === "dev") {
        expect(llvm).toContain("emissionKind: FullDebug");
        expect(llvm).toContain('!DILocalVariable(name: "input", arg: 1');
        expect(llvm).not.toContain("LineTablesOnly");
      } else {
        expect(llvm).not.toMatch(/!DI|llvm\.dbg\./);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
