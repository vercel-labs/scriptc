import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

test("`??` in JavaScript tests a scalar optional left on the typed path when the default has its type", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-untyped-nullish-"));
  try {
    const entry = join(dir, "main.mjs");
    writeFileSync(
      entry,
      [
        "const counts = new Map();",
        'for (const w of ["a", "b", "a"]) counts.set(w, (counts.get(w) ?? 0) + 1);',
        'console.log(counts.get("a") ?? 0, counts.get("z") ?? "none");',
      ].join("\n"),
    );
    const output = join(dir, "main.ir.json");
    const lowered = await compile(entry, { outputKind: "ir", outDir: dir, outPath: output });
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const module = deserializeModule(readFileSync(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    const nullish: { type: string; left: string }[] = [];
    const visit = (node: unknown, parent: string | null): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach((child) => visit(child, parent));
      const n = node as { kind?: string; type?: { kind: string }; left?: { kind: string } };
      if (n.kind === "nullish")
        nullish.push({ type: `${parent}>${n.type!.kind}`, left: n.left!.kind });
      for (const [key, value] of Object.entries(node))
        if (key !== "loc") visit(value, n.kind ?? parent);
    };
    visit(module.functions, null);
    // The loop's `?? 0`, whose result is an untyped value, reads the Map's
    // number on the typed path and converts only the result. (The first
    // console.log argument is a number already.) `?? "none"` takes another
    // type, so its left converts first.
    expect(
      nullish.filter((n) => n.type === "dynFrom>f64" && n.left === "mapIntrinsic"),
    ).toHaveLength(1);
    expect(nullish.filter((n) => n.type.endsWith(">dyn") && n.left === "dynFrom")).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
