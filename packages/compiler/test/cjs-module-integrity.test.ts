import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("CommonJS retries reset before cleanup and propagate children-array failures", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "scriptc-cjs-integrity-")));
  try {
    const entry = join(dir, "main.cjs");
    const child = join(dir, "child.cjs");
    const output = join(dir, "main.ir.json");
    await writeFile(entry, 'require("./child.cjs"); console.log(module.children.length);');
    await writeFile(child, 'console.log(module.loaded); throw new Error("body error");');
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => item.code + ": " + item.message).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    const init = module.functions.find(
      (fn) => fn.loc.file === child && fn.body.some((stmt) => stmt.kind === "tryCatch"),
    );
    expect(init).toBeDefined();
    const guarded = init!.body.find((stmt) => stmt.kind === "tryCatch");
    expect(guarded?.kind).toBe("tryCatch");
    if (guarded?.kind !== "tryCatch") throw new Error("missing module initializer guard");
    const cleanup = guarded.catchBody!;
    expect(cleanup).toHaveLength(3);
    const reset = cleanup[0]!;
    expect(reset.kind).toBe("assign");
    if (reset.kind !== "assign") throw new Error("missing retry reset");
    expect(reset.value).toMatchObject({ kind: "boolLit", value: false });
    expect(init!.body).toContainEqual(
      expect.objectContaining({
        kind: "assign",
        localId: reset.localId,
        value: expect.objectContaining({ kind: "boolLit", value: true }),
      }),
    );
    expect(cleanup[1]).toMatchObject({
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "module.fail" },
    });
    expect(cleanup[2]).toMatchObject({ kind: "rethrow", localId: guarded.catchLocalId });

    const llvm = emitLlvmModule(module);
    const calls = [...llvm.matchAll(/call void @scr_module_(link|fail)\([^\n]+/g)];
    expect(calls.some((call) => call[1] === "link")).toBe(true);
    expect(calls.some((call) => call[1] === "fail")).toBe(true);
    for (const call of calls) {
      // A failed link cannot reach child init; failed cleanup cannot reach
      // the original error's rethrow. Both unwind at the immediate call edge.
      const after = llvm.slice(call.index! + call[0].length);
      const continuation = after.split(/^[\w.]+:\n/m, 1)[0]!;
      const branch = /br i1 [^,\n]+, label %(exc\.u[\w.]*),/.exec(continuation);
      expect(branch).not.toBeNull();
      if (call[1] === "fail") {
        const label = "\n" + branch![1] + ":\n";
        const start = after.indexOf(label);
        expect(start).toBeGreaterThanOrEqual(0);
        const unwind = after.slice(start + label.length).split(/^[\w.]+:\n/m, 1)[0]!;
        const shared = /br label %(exc\.cleanup[\w.]*)/.exec(unwind);
        expect(shared).not.toBeNull();
        const cleanupLabel = "\n" + shared![1] + ":\n";
        const cleanupStart = after.indexOf(cleanupLabel);
        expect(cleanupStart).toBeGreaterThanOrEqual(0);
        const cleanup = after.slice(cleanupStart + cleanupLabel.length).split(/^[\w.]+:\n/m, 1)[0]!;
        expect(cleanup).toContain("@scr_caught_release");
        expect(cleanup.indexOf("@scr_caught_release")).toBeLessThan(cleanup.indexOf("ret "));
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
