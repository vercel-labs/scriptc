import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { everyStmtList } from "../src/ir/traverse.js";

test("util.format %f lowers a boolean argument once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-format-float-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      [
        'import { format } from "node:util";',
        "const xs = [1, 2, 3];",
        'console.log(format("%f %f", xs.some((x) => x > 2), xs.every((x) => x > 0)));',
      ].join("\n"),
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    // One lifted helper call per argument: the evaluated-for-effect
    // statement reuses the lowered value instead of lowering the argument
    // again. Each call runs its callback as a loop (array-pipelines.ts).
    const helpers: string[] = [];
    for (const fn of mod.functions)
      everyStmtList(fn.body, {
        expr: (e) => {
          if (e.kind === "call" && e.callee.startsWith("%arr."))
            helpers.push(e.callee.replace(/\.[0-9a-f]+$/, ""));
          return true;
        },
        stmt: () => true,
      });
    expect(helpers).toEqual(["%arr.loop", "%arr.loop"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
