import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import { emitLlvmModuleSource } from "./emitter.js";

const root = join(import.meta.dirname, "../../../../..");

// Per-node emitter analyses must reach the same conclusions for an in-memory
// module and its serialized IR artifact. The sanitized bootstrap emits the
// next compiler generation from that artifact.
test("sort-heavy programs emit equal LLVM from memory and from serialized IR", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-sort-ir-"));
  try {
    for (const name of [
      "array-sort-runs.ts",
      "uint8array-sort-domains.ts",
      "2703-array-sparse-sort.ts",
    ]) {
      const entry = join(root, "tests/corpus", name);
      const options = {
        outDir: directory,
        backend: "llvm" as const,
        optimization: "release" as const,
      };
      const llvmPath = join(directory, name + ".ll");
      const irPath = join(directory, name + ".ir.json");
      const llvm = await compile(entry, { ...options, outPath: llvmPath, outputKind: "llvm" });
      expect(llvm.ok, name).toBe(true);
      const ir = await compile(entry, { ...options, outPath: irPath, outputKind: "ir" });
      expect(ir.ok, name).toBe(true);
      const emitted = emitLlvmModuleSource(deserializeModule(readFileSync(irPath, "utf8")), {
        targetTriple: process.env["SCRIPTC_TARGET"] ?? "",
        pointerBits: 64,
        wasi: false,
        runtimeAbiMarker: false,
      });
      const text = typeof emitted === "string" ? emitted : emitted.join("");
      expect(text === readFileSync(llvmPath, "utf8"), name).toBe(true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
