// A JavaScript instance-field initializer's per-evaluation class expression
// that uses private names keeps the named SC1090 refusal, deferred to a
// runtime fence. The class's `classval` stays on the field: the validator
// documents it as inert-but-valid storage for a class the frontend never
// registers, and every class value is the class-independent ScrClassObj *.
// A dynamic member access through such a value used to ask the LLVM emitter
// for the class's metadata and crash with "llvm emitter bug: unknown class";
// an unregistered class has no subtypes, so the checked-dynamic class check
// simply rejects every value into the slot and the program reaches its
// existing runtime fence.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("a dynamic class check of an unregistered class value refuses instead of crashing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-dyn-class-unregistered-"));
  try {
    const entry = join(dir, "main.js");
    writeFileSync(
      entry,
      `
class C {
  /** @param {any} v */
  set #m(v) { this._v = v; }
  method(v) { this.#m = v; }
  B = class { method(o, v) { o.#m = v; } #m; };
}
try {
  const c = new C();
  const inner = new c.B();
  inner.method(inner, "t");
  console.log("ran", inner._v);
} catch (error) {
  console.log(error.name, error.message);
}
console.log("after");
`,
    );
    const result = await compile(entry, {
      backend: "llvm",
      sanitize: process.env["SCRIPTC_SAN"] === "1",
      outDir: dir,
      outPath: join(dir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const child = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(child.stdout).toContain(
      "function-local classes with private brands are not supported yet",
    );
    expect(child.stdout.endsWith("after\n")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
