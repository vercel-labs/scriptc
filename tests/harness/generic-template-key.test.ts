/* A read keyed by a template of a type parameter, in a generic instance
 * for a call that passes a plain string: the instance's record has no
 * member the key could name, while the object the program passes holds
 * one. Node answers the member; the compiled read would answer undefined,
 * so the build refuses it by name. The literal calls are differential
 * (tests/corpus/9565-generic-template-key-read.ts). */
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/generic-template-key");

test(
  "a template key of a type parameter bound to string is refused by name",
  { timeout: 300_000 },
  async () => {
    const entry = join(repoRoot, "tests/fixtures/generic-template-key/any-string.ts");
    const result = await compile(entry, { outPath: join(outDir, "any-string"), outDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const refusal = result.diagnostics.find((d) => d.code === "SC1090");
    expect(refusal?.message).toContain(
      "a read keyed by a template of a type parameter where no declared member of",
    );
    expect(refusal?.message).toContain("(instantiating 'word' with <string>)");
  },
);
