import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

// A specialized array helper calls its known callback directly after
// checking the closure's entry. A callback that cannot throw skips the
// pending test on that path, and the fallback through the closure's own
// entry keeps it; a callback that can throw keeps it on both paths. The
// callbacks are passed through bindings: a closure literal at the call
// would run as a loop with its body copied in (array-pipelines.ts).
test("known callbacks outside the may-throw set test the pending flag only on the fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-callback-pending-"));
  try {
    const entry = join(dir, "main.ts");
    const output = join(dir, "main.ir.json");
    writeFileSync(
      entry,
      `const values = [1, 2, 3, 4];
const positive = (v: number): boolean => v > 0;
const double = (v: number): number => v * 2;
const stopAtThree = (v: number): boolean => {
  if (v > 2) throw new Error("stop at " + v);
  return true;
};
console.log(values.every(positive));
console.log(values.map(double).join(","));
try {
  console.log(values.every(stopAtThree));
} catch (error) {
  console.log("caught", (error as Error).message);
}
`,
    );
    const lowered = await compile(entry, { outputKind: "ir", outDir: dir, outPath: output });
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const module = deserializeModule(readFileSync(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    const llvm = emitLlvmModule(module, {});
    // The fallback calls the closure's entry, after giving it an undefined
    // receiver when it reads one, so its edge comes from receiver.done then.
    const guards = [
      ...llvm.matchAll(
        /(%t\d+) = phi i1 \[ false, %callback\.direct\d+ \], \[ true, %(?:callback\.indirect|receiver\.done)\d+ \]/g,
      ),
    ];
    // The quiet every and map callbacks; not the throwing one.
    expect(guards.length).toBe(2);
    for (const [, guard] of guards)
      expect(llvm).toMatch(new RegExp(`br i1 ${guard}, label %exc\\.t\\d+`));
    const helpers = llvm.split(/\n(?=define )/).filter((fn) => fn.includes("callback.direct"));
    expect(helpers.filter((fn) => !/phi i1 \[ false, %callback\.direct/.test(fn))).toHaveLength(1);

    const exe = join(dir, "main");
    const built = await compile(entry, { outputKind: "exe", outDir: dir, outPath: exe });
    if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
    expect(execFileSync(exe, { encoding: "utf8" })).toBe("true\n2,4,6,8\ncaught stop at 3\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
