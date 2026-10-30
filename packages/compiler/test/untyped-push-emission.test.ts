import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

// An untyped push in statement position drops the new length, so it calls
// the entry that does not box it; a push whose result is read keeps the
// ordinary entry, as do the other methods.
test("a statement-position untyped push skips boxing its result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-untyped-push-"));
  try {
    const entry = join(dir, "main.mjs");
    const output = join(dir, "main.ir.json");
    writeFileSync(
      entry,
      `function fill(a, n) {
  for (let i = 0; i < n; i++) a.push(i);
  const length = a.push(n);
  a.pop();
  return length;
}
console.log(fill(JSON.parse("[]"), 3));
`,
    );
    const lowered = await compile(entry, { outputKind: "ir", outDir: dir, outPath: output });
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const module = deserializeModule(readFileSync(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    const llvm = emitLlvmModule(module, {});
    const body = llvm.split(/\n(?=define )/).find((fn) => /@sc_[a-z]*f_fill\b/.test(fn))!;
    const discarded = [...body.matchAll(/call void @scr_dyn_invoke_discard_id\(/g)];
    const kept = [...body.matchAll(/= call ptr @scr_dyn_invoke_prepared_id\(/g)];
    expect(discarded).toHaveLength(1);
    // `a.push(n)` for its length, and `a.pop()`, whose result is dropped
    // but which has no unboxed entry.
    expect(kept).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
