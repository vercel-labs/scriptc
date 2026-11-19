import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

// A base constructor that returns an existing instance rebinds the derived
// constructor's `this` to it. That compiles when the instance already is an
// instance of the class being constructed (tests/corpus/
// constructor-returns-an-instance-of-the-derived-class.ts). Any other
// instance has no representation as one, and its construction refuses at
// run time with a message that names both classes and what to do.

const sanitize = process.env["SCRIPTC_SAN"] === "1";

test("a base constructor returning an instance of another class refuses at run time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-constructor-rebinding-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `
let pending: object | null = null;
class Base {
  a: number = 1;
  constructor() {
    if (pending !== null) {
      const p = pending;
      pending = null;
      return p as unknown as Base;
    }
  }
}
class Derived extends Base {
  b: number = 2;
}
const made = new Base();
made.a = 10;
console.log("built", new Derived().b);
pending = made;
const upgraded = new Derived();
console.log("unreached", upgraded.b);
`,
    );
    const { coverage } = analyze(entry, {});
    expect(coverage.diagnostics).toEqual([]);
    const refusal = (coverage.runtimeFences ?? []).map((d) => d.message);
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain(
      "constructing 'Derived' when the constructor of 'Base' returns an existing instance that is not a 'Derived'",
    );
    const result = await compile(entry, { sanitize, outDir: dir, outPath: join(dir, "program") });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const child = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(child.stdout).toBe("built 2\n");
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("is not a 'Derived'");
    expect(child.stderr).toContain("create it as that class or a class below it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
